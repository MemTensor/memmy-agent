import { describe, expect, it, vi } from "vitest";
import { SSE_DONE, sseChunk, sseMemmyEvent, createApp } from "../../../src/entrypoints/openai-like-api/server.js";

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

  it("encodes Memmy progress events without changing the OpenAI chunk shape", () => {
    const payload = JSON.parse(sseMemmyEvent("thinking_delta", { text: "先分析" }, "m", "id1").slice(6));

    expect(payload.choices).toEqual([]);
    expect(payload.memmy_event).toEqual({ type: "thinking_delta", text: "先分析" });
    expect(payload.object).toBe("chat.completion.chunk");
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

  it("streams reasoning, tool lifecycle and generated files through Memmy events", async () => {
    const app = createApp({
      processDirect: async (args: any) => {
        await args.onProgress("先分析", { reasoning: true });
        await args.onProgress("", { reasoningEnd: true });
        await args.onProgress("", {
          toolEvents: [{ phase: "start", call_id: "call-1", name: "write_file", arguments: { path: "a.txt" } }],
        });
        await args.onProgress("", {
          toolEvents: [{ phase: "end", call_id: "call-1", name: "write_file", result: [{ type: "resource_link", uri: "/tmp/a.txt", mimeType: "text/plain" }], files: ["/tmp/a.txt"] }],
        });
        await args.onStream("完成");
        return "完成";
      },
    }, "m");

    const payloads = ssePayloads(await (await app.fetch(request({ messages: [{ role: "user", content: "go" }], stream: true }))).text())
      .filter((line) => line !== "[DONE]")
      .map((line) => JSON.parse(line));
    expect(payloads.map((item) => item.memmy_event?.type).filter(Boolean)).toEqual([
      "thinking_delta", "thinking_end", "tool_call", "tool_result", "media",
    ]);
    expect(payloads.filter((item) => item.memmy_event?.type === "media").map((item) => item.memmy_event.media[0])).toEqual([
      { kind: "file", path: "/tmp/a.txt" },
    ]);
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
    expect(JSON.parse(ssePayloads(body)[0]).error.code).toBe("server_error");
    expect(body).not.toContain("backend blew up");
  });

  it("reports an unavailable session model instead of silently closing the stream", async () => {
    const app = createApp({ processDirect: async () => {
      throw new Error("model_selection_unavailable");
    } }, "m");
    const response = await app.fetch(request({ messages: [{ role: "user", content: "hi" }], stream: true }));
    const body = await response.text();
    expect(JSON.parse(ssePayloads(body)[0]).error).toMatchObject({ code: "model_selection_unavailable" });
    expect(body).not.toContain("[DONE]");
  });
});

for (const stream of [true, false]) {
  it(`keeps a silent long-running task alive (stream=${stream})`, async () => {
    vi.useFakeTimers();
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      const app = createApp({ processDirect: async () => {
        started();
        await gate;
        return "long tool finished";
      } }, "m", 600);
      let settled = false;
      const result = app.fetch(request({ messages: [{ role: "user", content: "long tool" }], stream }))
        .then((response) => response.text());
      void result.then(() => { settled = true; });
      await entered;
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
      expect(settled).toBe(false);
      release();
      expect(await result).toContain("long tool finished");
      expect(app.context.sessionLocks.size).toBe(0);
    } finally {
      release?.();
      vi.useRealTimers();
    }
  });
}

function cancelRequest(sessionId: string, requestId: string): Request {
  return new Request("http://localhost/v1/chat/cancel", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, request_id: requestId }),
  });
}

it("only an explicit stop cancels its matching request, including after disconnect", async () => {
  const signals = new Map<string, AbortSignal>();
  const releases = new Map<string, () => void>();
  const app = createApp({
    processMessageInternal() {},
    async processDirect(_content: string, options: any) {
      const signal: AbortSignal = options.abortSignal;
      signals.set(options.sessionKey, signal);
      await new Promise<void>((resolve) => {
        releases.set(options.sessionKey, resolve);
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return "finished";
    },
  }, "m");
  const start = (session_id: string, request_id: string) => app.fetch(request({
    messages: [{ role: "user", content: "long tool" }], stream: true, session_id, request_id,
  }));
  const first = await start("a", "run-a");
  const second = await start("b", "run-b");
  await first.body!.cancel();
  expect(signals.get("api:a")!.aborted).toBe(false);
  expect(app.context.activeRequests.size).toBe(2);
  expect((await start("a", "run-a")).status).toBe(409);
  expect((await app.fetch(cancelRequest("a", "run-b"))).status).toBe(404);
  expect(signals.get("api:b")!.aborted).toBe(false);
  expect((await app.fetch(cancelRequest("a", "run-a"))).status).toBe(200);
  expect(signals.get("api:a")!.aborted).toBe(true);
  expect(signals.get("api:b")!.aborted).toBe(false);
  releases.get("api:b")!();
  expect(await second.text()).toContain("[DONE]");
  expect(app.context.activeRequests.size).toBe(0);
  expect(app.context.sessionLocks.size).toBe(0);
  const next = await start("a", "run-next");
  expect((await app.fetch(cancelRequest("a", "run-a"))).status).toBe(404);
  expect(signals.get("api:a")!.aborted).toBe(false);
  releases.get("api:a")!();
  expect(await next.text()).toContain("[DONE]");
});

it("explicit cancellation ends SSE as cancelled, never as successful completion", async () => {
  const app = createApp({ processDirect: async (args: any) => {
    await new Promise<void>((resolve) => args.abortSignal.addEventListener("abort", () => resolve(), { once: true }));
    return "must not become a successful reply";
  } }, "m");
  const response = await app.fetch(request({ messages: [{ role: "user", content: "go" }], stream: true, session_id: "s", request_id: "r" }));
  const output = response.text();
  await app.fetch(cancelRequest("s", "r"));
  const text = await output;
  expect(text).toContain('"code":"cancelled"');
  expect(text).not.toContain("[DONE]");
  expect(text).not.toContain("successful reply");
});

it("a model or tool error remains a failure, not user cancellation", async () => {
  let signal!: AbortSignal;
  const app = createApp({ processDirect: async (args: any) => {
    signal = args.abortSignal;
    throw new Error("tool timed out");
  } }, "m");
  const response = await app.fetch(request({ messages: [{ role: "user", content: "go" }], stream: true }));
  expect(await response.text()).toContain('"code":"server_error"');
  expect(signal.aborted).toBe(false);
  expect(app.context.activeRequests.size).toBe(0);
});
