import { describe, expect, it } from "vitest";
import { SSE_DONE, sseChunk, createApp } from "../../../src/entrypoints/openai-like-api/server.js";

function request(body: unknown): Request {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ssePayloads(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length));
}

function streamingAgent(tokens: string[]) {
  return {
    processDirect: async (args: any) => {
      for (const token of tokens) await args.onStream(token);
      await args.onStreamEnd();
      return tokens.join(" ");
    },
  };
}

describe("SSE response helpers", () => {
  it("formats chunks with delta content", () => {
    const payload = JSON.parse(sseChunk("hello", "test-model", "chatcmpl-abc123").split("data: ", 2)[1]);

    expect(payload.id).toBe("chatcmpl-abc123");
    expect(payload.object).toBe("chat.completion.chunk");
    expect(payload.model).toBe("test-model");
    expect(payload.choices[0].delta.content).toBe("hello");
    expect(payload.choices[0].finish_reason).toBeNull();
  });

  it("formats finish chunks without a delta", () => {
    const payload = JSON.parse(sseChunk("", "m", "id1", "stop").split("data: ", 2)[1]);

    expect(payload.choices[0].delta).toEqual({});
    expect(payload.choices[0].finish_reason).toBe("stop");
  });

  it("uses the OpenAI [DONE] SSE terminator", () => {
    expect(SSE_DONE).toBe("data: [DONE]\n\n");
  });
});

describe("SSE chat completions", () => {
  it("returns a readable stream before the backend finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = createApp(
      {
        processDirect: async (args: any) => {
          await args.onStream("first");
          await gate;
          await args.onStream(" second");
          return "first second";
        },
      },
      "m",
    );

    const responsePromise = app.fetch(request({ messages: [{ role: "user", content: "hi" }], stream: true }));
    const response = await Promise.race([
      responsePromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ]);
    if (response == null) {
      release();
      await responsePromise.catch(() => undefined);
    }

    expect(response).not.toBeNull();
    if (response == null) return;
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(decoder.decode(first.value)).toContain("first");

    release();
    let rest = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      rest += decoder.decode(next.value, { stream: true });
    }
    rest += decoder.decode();

    expect(rest).toContain(" second");
    expect(rest).toContain("[DONE]");
  });

  it("returns text/event-stream when stream is true", async () => {
    const app = createApp(streamingAgent(["Hello", " world"]), "test-model");

    const response = await app.fetch(request({ messages: [{ role: "user", content: "hi" }], stream: true }));
    const payloads = ssePayloads(await response.text());
    const chunks = payloads.slice(0, -1).map((line) => JSON.parse(line));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(chunks[0].choices[0].delta.content).toBe("Hello");
    expect(chunks[1].choices[0].delta.content).toBe(" world");
    expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
    expect(chunks.at(-1).choices[0].delta).toEqual({});
    expect(payloads.at(-1)).toBe("[DONE]");
  });

  it("returns regular JSON when stream is false", async () => {
    const app = createApp({ processDirect: async () => "normal reply" }, "m");

    const response = await app.fetch(request({ messages: [{ role: "user", content: "hi" }], stream: false }));
    const body = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("normal reply");
  });

  it("defaults to non-streaming JSON responses", async () => {
    const app = createApp({ processDirect: async () => "default reply" }, "m");

    const response = await app.fetch(request({ messages: [{ role: "user", content: "hi" }] }));
    const body = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(body.object).toBe("chat.completion");
  });

  it("keeps chunk IDs consistent within a stream", async () => {
    const app = createApp(streamingAgent(["A", "B", "C"]), "m");

    const response = await app.fetch(request({ messages: [{ role: "user", content: "go" }], stream: true }));
    const chunks = ssePayloads(await response.text())
      .filter((line) => line !== "[DONE]")
      .map((line) => JSON.parse(line));

    const ids = new Set(chunks.map((chunk) => chunk.id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(/^chatcmpl-/);
  });

  it("passes stream callbacks to the agent", async () => {
    const captured: any = {};
    const app = createApp(
      {
        processDirect: async (args: any) => {
          Object.assign(captured, args);
          await args.onStreamEnd();
          return "done";
        },
      },
      "m",
    );

    const response = await app.fetch(request({ messages: [{ role: "user", content: "hi" }], stream: true }));

    expect(response.status).toBe(200);
    expect(captured.onStream).toBeTypeOf("function");
    expect(captured.onStreamEnd).toBeTypeOf("function");
  });

  it("does not close the SSE response on intermediate stream-end callbacks", async () => {
    const app = createApp(
      {
        processDirect: async (args: any) => {
          await args.onStream("planning");
          await args.onStreamEnd({ resuming: true });
          await new Promise((resolve) => setTimeout(resolve, 5));
          await args.onStream(" final");
          await args.onStreamEnd({ resuming: false });
          return "planning final";
        },
      },
      "m",
    );

    const response = await app.fetch(request({ messages: [{ role: "user", content: "use a tool" }], stream: true }));
    const payloads = ssePayloads(await response.text());
    const chunks = payloads.slice(0, -1).map((line) => JSON.parse(line));
    const deltas = chunks.map((chunk) => chunk.choices[0].delta.content ?? "");

    expect(response.status).toBe(200);
    expect(deltas).toContain("planning");
    expect(deltas).toContain(" final");
    expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
    expect(payloads.at(-1)).toBe("[DONE]");
  });

  it("streams the final response when no deltas were emitted", async () => {
    const app = createApp(
      {
        processDirect: async (args: any) => {
          await args.onStreamEnd({ resuming: false });
          return "plain final";
        },
      },
      "m",
    );

    const response = await app.fetch(request({ messages: [{ role: "user", content: "hi" }], stream: true }));
    const payloads = ssePayloads(await response.text());
    const chunks = payloads.slice(0, -1).map((line) => JSON.parse(line));
    const deltas = chunks.map((chunk) => chunk.choices[0].delta.content ?? "");

    expect(deltas).toContain("plain final");
    expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
    expect(payloads.at(-1)).toBe("[DONE]");
  });

  it("uses custom session IDs for streaming requests", async () => {
    let capturedKey = "";
    const app = createApp(
      {
        processDirect: async (args: any) => {
          capturedKey = args.session_key;
          await args.onStream("ok");
          await args.onStreamEnd();
          return "ok";
        },
      },
      "m",
    );

    const response = await app.fetch(
      request({
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        session_id: "my-session",
      }),
    );

    expect(response.status).toBe(200);
    expect(capturedKey).toBe("api:my-session");
  });

  it("does not emit a successful terminator after backend failures", async () => {
    const app = createApp(
      {
        processDirect: async () => {
          throw new Error("backend blew up");
        },
      },
      "m",
    );

    const response = await app.fetch(request({ messages: [{ role: "user", content: "hi" }], stream: true }));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain('"finish_reason":"stop"');
    expect(body).not.toContain("[DONE]");
  });
});
