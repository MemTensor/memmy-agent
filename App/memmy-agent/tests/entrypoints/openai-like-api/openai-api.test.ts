import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import {
  API_CHAT_ID,
  API_SESSION_KEY,
  chatCompletionResponse,
  errorJson,
  createApp,
  handleChatCompletions,
} from "../../../src/entrypoints/openai-like-api/server.js";
import { EMPTY_FINAL_RESPONSE_MESSAGE } from "../../../src/utils/runtime.js";

function request(body: unknown, init: RequestInit = {}): Request {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

const oldDataDir = process.env.MEMMY_AGENT_DATA_DIR;
const roots: string[] = [];

function tempDataDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-api-test-"));
  roots.push(root);
  process.env.MEMMY_AGENT_DATA_DIR = root;
  return root;
}

afterEach(() => {
  if (oldDataDir === undefined) delete process.env.MEMMY_AGENT_DATA_DIR;
  else process.env.MEMMY_AGENT_DATA_DIR = oldDataDir;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("OpenAI-compatible API response helpers", () => {
  it("formats error JSON responses", async () => {
    const response = errorJson(400, "bad request");
    const body = (await response.json()) as any;

    expect(response.status).toBe(400);
    expect(body.error.message).toBe("bad request");
    expect(body.error.code).toBe(400);
  });

  it("formats chat completion responses", () => {
    const result = chatCompletionResponse("hello world", "test-model");

    expect(result.object).toBe("chat.completion");
    expect(result.model).toBe("test-model");
    expect(result.choices[0].message.content).toBe("hello world");
    expect(result.choices[0].finish_reason).toBe("stop");
    expect(result.id).toMatch(/^chatcmpl-/);
  });
});

describe("OpenAI-compatible API request validation", () => {
  it("returns 400 when messages are missing", async () => {
    const app = createApp({ processDirect: async () => "unused" }, "test-model");

    expect((await app.fetch(request({ model: "test-model" }))).status).toBe(400);
  });

  it("returns 400 when there is no user message", async () => {
    const app = createApp({ processDirect: async () => "unused" }, "test-model");

    const response = await app.fetch(request({ messages: [{ role: "system", content: "you are a bot" }] }));

    expect(response.status).toBe(400);
  });

  it("returns SSE when stream is true", async () => {
    const app = createApp({ processDirect: async () => "mock response" }, "test-model");

    const response = await app.fetch(request({ messages: [{ role: "user", content: "hello" }], stream: true }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
  });

  it("rejects model mismatches", async () => {
    const response = await handleChatCompletions(
      request({
        model: "other-model",
        messages: [{ role: "user", content: "hello" }],
      }),
      {
        agentLoop: { processDirect: async () => "unused" },
        modelName: "test-model",
        requestTimeout: 10,
        sessionLocks: new Map(),
      },
    );
    const body = (await response.json()) as any;

    expect(response.status).toBe(400);
    expect(body.error.message).toContain("test-model");
  });

  it("requires exactly one user message", async () => {
    const app = createApp({ processDirect: async () => "unused" }, "test-model");

    const response = await app.fetch(
      request({
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "previous reply" },
        ],
      }),
    );
    const body = (await response.json()) as any;

    expect(response.status).toBe(400);
    expect(body.error.message.toLowerCase()).toContain("single user message");
  });

  it("requires that the single message has the user role", async () => {
    const app = createApp({ processDirect: async () => "unused" }, "test-model");

    const response = await app.fetch(request({ messages: [{ role: "system", content: "you are a bot" }] }));
    const body = (await response.json()) as any;

    expect(response.status).toBe(400);
    expect(body.error.message.toLowerCase()).toContain("single user message");
  });
});

describe("OpenAI-compatible API routing", () => {
  it("uses the fixed API session for successful requests", async () => {
    const calls: any[] = [];
    const app = createApp(
      {
        processDirect: async (args: any) => {
          calls.push(args);
          return "mock response";
        },
      },
      "test-model",
    );

    const response = await app.fetch(request({ messages: [{ role: "user", content: "hello" }] }));
    const body = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(body.choices[0].message.content).toBe("mock response");
    expect(body.model).toBe("test-model");
    expect(calls[0]).toMatchObject({
      content: "hello",
      media: null,
      session_key: API_SESSION_KEY,
      channel: "api",
      chat_id: API_CHAT_ID,
    });
  });

  it("uses the same fixed session key across follow-up requests", async () => {
    const callLog: string[] = [];
    const app = createApp(
      {
        processDirect: async (args: any) => {
          callLog.push(args.session_key);
          return `reply to ${args.content}`;
        },
      },
      "m",
    );

    const first = await app.fetch(request({ messages: [{ role: "user", content: "first" }] }));
    const second = await app.fetch(request({ messages: [{ role: "user", content: "second" }] }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(callLog).toEqual([API_SESSION_KEY, API_SESSION_KEY]);
  });

  it("serializes fixed-session requests", async () => {
    const order: string[] = [];
    const app = createApp(
      {
        processDirect: async (args: any) => {
          order.push(`start:${args.content}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
          order.push(`end:${args.content}`);
          return args.content;
        },
      },
      "m",
    );

    const [first, second] = await Promise.all([
      app.fetch(request({ messages: [{ role: "user", content: "first" }] })),
      app.fetch(request({ messages: [{ role: "user", content: "second" }] })),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    if (order[0] === "start:first") expect(order.indexOf("end:first")).toBeLessThan(order.indexOf("start:second"));
    else expect(order.indexOf("end:second")).toBeLessThan(order.indexOf("start:first"));
  });

  it("serves the models endpoint", async () => {
    const app = createApp({ processDirect: async () => "unused" }, "test-model");

    const response = await app.fetch(new Request("http://localhost/v1/models"));
    const body = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(body.object).toBe("list");
    expect(body.data[0].id).toBe("test-model");
  });

  it("serves the health endpoint", async () => {
    const app = createApp({ processDirect: async () => "unused" }, "test-model");

    const response = await app.fetch(new Request("http://localhost/health"));
    const body = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
  });

  it("extracts text from multimodal content", async () => {
    tempDataDir();
    const calls: any[] = [];
    const app = createApp({ processDirect: async (args: any) => (calls.push(args), "ok") }, "m");
    const dataUrl = `data:image/png;base64,${Buffer.from("abc").toString("base64")}`;

    const response = await app.fetch(
      request({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe this" },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    );

    expect(response.status).toBe(200);
    expect(calls[0].content).toBe("describe this");
    expect(calls[0].session_key).toBe(API_SESSION_KEY);
    expect(calls[0].channel).toBe("api");
    expect(calls[0].chat_id).toBe(API_CHAT_ID);
  });

  it("rejects remote multimodal image URLs", async () => {
    const calls: any[] = [];
    const app = createApp({ processDirect: async (args: any) => (calls.push(args), "ok") }, "m");

    const response = await app.fetch(
      request({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "describe this" },
              { type: "image_url", image_url: { url: "https://example.com/image.png" } },
            ],
          },
        ],
      }),
    );
    const body = (await response.json()) as any;

    expect(response.status).toBe(400);
    expect(body.error.message.toLowerCase()).toContain("remote image urls are not supported");
    expect(calls).toHaveLength(0);
  });

  it("retries empty responses before returning the fallback message", async () => {
    let calls = 0;
    const recovered = createApp(
      {
        processDirect: async () => {
          calls += 1;
          return calls === 1 ? "" : "recovered response";
        },
      },
      "m",
    );

    const recoveredResponse = await recovered.fetch(request({ messages: [{ role: "user", content: "hello" }] }));
    expect(((await recoveredResponse.json()) as any).choices[0].message.content).toBe("recovered response");
    expect(calls).toBe(2);

    let fallbackCalls = 0;
    const fallback = createApp(
      {
        processDirect: async () => {
          fallbackCalls += 1;
          return "";
        },
      },
      "m",
    );

    const fallbackResponse = await fallback.fetch(request({ messages: [{ role: "user", content: "hello" }] }));
    expect(((await fallbackResponse.json()) as any).choices[0].message.content).toBe(EMPTY_FINAL_RESPONSE_MESSAGE);
    expect(fallbackCalls).toBe(2);
  });

  it("forwards media paths through AgentLoop.processDirect", async () => {
    const loop = new AgentLoop({ provider: { model: "m" } });
    let captured: any = null;
    loop.processMessageInternal = async (message: any) => {
      captured = message;
      return null;
    };

    await loop.processDirect("analyze this", {
      media: ["/tmp/image.png", "/tmp/report.pdf"],
      sessionKey: "test:1",
    });

    expect(captured).not.toBeNull();
    expect(captured.media).toEqual(["/tmp/image.png", "/tmp/report.pdf"]);
    expect(captured.content).toBe("analyze this");
  });

  it("adapts real AgentLoop-style processDirect calls from API object arguments", async () => {
    const captured: any[] = [];
    const agent = {
      processMessageInternal: async () => null,
      processDirect: async (content: string, opts: any) => {
        captured.push({ content, opts });
        return "ok";
      },
    };
    const app = createApp(agent, "m");

    const response = await app.fetch(request({ messages: [{ role: "user", content: "hello" }] }));

    expect(response.status).toBe(200);
    expect(captured[0].content).toBe("hello");
    expect(captured[0].opts.sessionKey).toBe(API_SESSION_KEY);
    expect(captured[0].opts.chatId).toBe(API_CHAT_ID);
    expect(captured[0].opts.session_key).toBeUndefined();
    expect(captured[0].opts.chat_id).toBeUndefined();
    expect(captured[0].opts.media).toEqual([]);
  });
});
