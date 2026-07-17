import { describe, expect, it } from "vitest";
import { GenerationSettings, LLMProvider, LLMResponse } from "../../src/providers/base.js";

class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

class ScriptedProvider extends LLMProvider {
  responses: Array<LLMResponse | Error>;
  calls = 0;
  delays: number[] = [];
  lastArgs: any = null;

  constructor(responses: Array<LLMResponse | Error>) {
    super();
    this.responses = [...responses];
  }

  async chat(args: any): Promise<LLMResponse> {
    this.calls += 1;
    this.lastArgs = args;
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return response ?? new LLMResponse({ content: "ok" });
  }

  protected override async sleep(seconds: number): Promise<void> {
    this.delays.push(seconds);
  }

  getDefaultModel(): string {
    return "test-model";
  }
}

function userMessages() {
  return [{ role: "user", content: "hello" }];
}

function imageMessage() {
  return [
    {
      role: "user",
      content: [
        { type: "text", text: "describe this" },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc" }, meta: { path: "/media/test.png" } },
      ],
    },
  ];
}

function imageMessageNoMeta() {
  return [
    {
      role: "user",
      content: [
        { type: "text", text: "describe this" },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
      ],
    },
  ];
}

describe("chatWithRetry", () => {
  it("retries a transient error and then succeeds", async () => {
    const provider = new ScriptedProvider([
      new LLMResponse({ content: "429 rate limit", finishReason: "error" }),
      new LLMResponse({ content: "ok" }),
    ]);
    const response = await provider.chatWithRetry({ messages: userMessages() });
    expect(response.finishReason).toBe("stop");
    expect(response.content).toBe("ok");
    expect(provider.calls).toBe(2);
    expect(provider.delays).toEqual([1]);
  });

  it("does not retry non-transient errors", async () => {
    const provider = new ScriptedProvider([new LLMResponse({ content: "401 unauthorized", finishReason: "error" })]);
    const response = await provider.chatWithRetry({ messages: userMessages() });
    expect(response.content).toBe("401 unauthorized");
    expect(provider.calls).toBe(1);
    expect(provider.delays).toEqual([]);
  });

  it("returns the final error after standard retries are exhausted", async () => {
    const provider = new ScriptedProvider([
      new LLMResponse({ content: "429 rate limit a", finishReason: "error" }),
      new LLMResponse({ content: "429 rate limit b", finishReason: "error" }),
      new LLMResponse({ content: "429 rate limit c", finishReason: "error" }),
      new LLMResponse({ content: "503 final server error", finishReason: "error" }),
    ]);
    const response = await provider.chatWithRetry({ messages: userMessages() });
    expect(response.content).toBe("503 final server error");
    expect(provider.calls).toBe(4);
    expect(provider.delays).toEqual([1, 2, 4]);
  });

  it("emits terminal progress when standard retries are exhausted", async () => {
    const provider = new ScriptedProvider([
      new LLMResponse({ content: "429 rate limit a", finishReason: "error" }),
      new LLMResponse({ content: "429 rate limit b", finishReason: "error" }),
      new LLMResponse({ content: "429 rate limit c", finishReason: "error" }),
      new LLMResponse({ content: "503 final server error", finishReason: "error" }),
    ]);
    const progress: string[] = [];
    const response = await provider.chatWithRetry({
      messages: userMessages(),
      onRetryWait: (message) => {
        progress.push(message);
      },
    });
    expect(response.content).toBe("503 final server error");
    expect(progress.at(-1)).toBe("Model request failed after 4 retries, giving up.");
  });

  it("preserves CancelledError exceptions", async () => {
    const provider = new ScriptedProvider([new CancelledError()]);
    await expect(provider.chatWithRetry({ messages: userMessages() })).rejects.toBeInstanceOf(CancelledError);
  });

  it("uses provider generation defaults when values are omitted", async () => {
    const provider = new ScriptedProvider([new LLMResponse({ content: "ok" })]);
    provider.generation = new GenerationSettings({ temperature: 0.2, maxTokens: 321, reasoningEffort: "high" });
    await provider.chatWithRetry({ messages: userMessages() });
    expect(provider.lastArgs.temperature).toBe(0.2);
    expect(provider.lastArgs.maxTokens).toBe(321);
    expect(provider.lastArgs.reasoningEffort).toBe("high");
  });

  it("lets explicit generation kwargs override provider defaults", async () => {
    const provider = new ScriptedProvider([new LLMResponse({ content: "ok" })]);
    provider.generation = new GenerationSettings({ temperature: 0.2, maxTokens: 321, reasoningEffort: "high" });
    await provider.chatWithRetry({
      messages: userMessages(),
      temperature: 0.9,
      maxTokens: 9999,
      reasoningEffort: "low",
    });
    expect(provider.lastArgs.temperature).toBe(0.9);
    expect(provider.lastArgs.maxTokens).toBe(9999);
    expect(provider.lastArgs.reasoningEffort).toBe("low");
  });

  it("retries non-transient image errors once with images stripped", async () => {
    const provider = new ScriptedProvider([
      new LLMResponse({ content: "API call arguments are invalid", finishReason: "error" }),
      new LLMResponse({ content: "ok, no image" }),
    ]);
    const response = await provider.chatWithRetry({ messages: imageMessage() });
    expect(response.content).toBe("ok, no image");
    expect(provider.calls).toBe(2);
    const content = provider.lastArgs.messages[0].content;
    expect(content.every((block: any) => block.type !== "image_url")).toBe(true);
    expect(content.some((block: any) => String(block.text ?? "").includes("[image: /media/test.png]"))).toBe(true);
  });

  it("mutates original messages after a successful image fallback", async () => {
    const messages = imageMessage();
    const provider = new ScriptedProvider([
      new LLMResponse({ content: "model does not support images", finishReason: "error" }),
      new LLMResponse({ content: "ok, no image" }),
    ]);
    const response = await provider.chatWithRetry({ messages });
    expect(response.content).toBe("ok, no image");
    expect(messages[0].content.every((block: any) => block.type !== "image_url")).toBe(true);
    expect(messages[0].content.some((block: any) => String(block.text ?? "").includes("[image: /media/test.png]"))).toBe(true);
  });

  it("does not retry non-transient errors without images", async () => {
    const provider = new ScriptedProvider([new LLMResponse({ content: "401 unauthorized", finishReason: "error" })]);
    const response = await provider.chatWithRetry({ messages: userMessages() });
    expect(provider.calls).toBe(1);
    expect(response.finishReason).toBe("error");
  });

  it("returns the second image-fallback error when retry also fails", async () => {
    const provider = new ScriptedProvider([
      new LLMResponse({ content: "some model error", finishReason: "error" }),
      new LLMResponse({ content: "still failing", finishReason: "error" }),
    ]);
    const response = await provider.chatWithRetry({ messages: imageMessage() });
    expect(provider.calls).toBe(2);
    expect(response.content).toBe("still failing");
    expect(response.finishReason).toBe("error");
  });

  it("uses default placeholders for image fallback without metadata", async () => {
    const provider = new ScriptedProvider([
      new LLMResponse({ content: "error", finishReason: "error" }),
      new LLMResponse({ content: "ok" }),
    ]);
    const response = await provider.chatWithRetry({ messages: imageMessageNoMeta() });
    expect(response.content).toBe("ok");
    expect(provider.calls).toBe(2);
    expect(provider.lastArgs.messages[0].content.some((block: any) => String(block.text ?? "").includes("[image omitted]"))).toBe(true);
  });

  it("uses retry-after text and emits wait progress", async () => {
    const provider = new ScriptedProvider([
      new LLMResponse({ content: "429 rate limit, retry after 7s", finishReason: "error" }),
      new LLMResponse({ content: "ok" }),
    ]);
    const progress: string[] = [];
    const response = await provider.chatWithRetry({
      messages: userMessages(),
      onRetryWait: (message) => {
        progress.push(message);
      },
    });
    expect(response.content).toBe("ok");
    expect(provider.delays).toEqual([7]);
    expect(progress[0]).toBe("Model request failed, retrying attempt 1 in 7s...");
  });

  it("includes retry attempt numbers in standard retry progress", async () => {
    const provider = new ScriptedProvider([
      new LLMResponse({ content: "429 rate limit a", finishReason: "error" }),
      new LLMResponse({ content: "429 rate limit b", finishReason: "error" }),
      new LLMResponse({ content: "ok" }),
    ]);
    const progress: string[] = [];

    const response = await provider.chatWithRetry({
      messages: userMessages(),
      onRetryWait: (message) => {
        progress.push(message);
      },
    });

    expect(response.content).toBe("ok");
    expect(provider.delays).toEqual([1, 2]);
    expect(progress).toEqual([
      "Model request failed, retrying attempt 1 in 1s...",
      "Model request failed, retrying attempt 2 in 2s...",
    ]);
  });

  it("extracts retry-after from common provider text formats", () => {
    expect(LLMProvider.extractRetryAfter('{"error":{"retry_after":20}}')).toBe(20);
    expect(LLMProvider.extractRetryAfter("Rate limit reached, please try again in 20s")).toBe(20);
    expect(LLMProvider.extractRetryAfter("retry-after: 20")).toBe(20);
  });

  it("extracts retry-after from numeric and HTTP-date headers", () => {
    expect(LLMProvider.extractRetryAfterFromHeaders({ "Retry-After": "20" })).toBe(20);
    expect(LLMProvider.extractRetryAfterFromHeaders({ "retry-after": "20" })).toBe(20);
    expect(LLMProvider.extractRetryAfterFromHeaders({ "Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT" })).toBe(0.1);
  });

  it("prefers retry-after-ms over retry-after headers", () => {
    expect(LLMProvider.extractRetryAfterFromHeaders({ "retry-after-ms": "250" })).toBe(0.25);
    expect(LLMProvider.extractRetryAfterFromHeaders({ "Retry-After-Ms": "1000" })).toBe(1);
    expect(LLMProvider.extractRetryAfterFromHeaders({ "retry-after-ms": "500", "retry-after": "10" })).toBe(0.5);
  });

  it("prefers structured retry_after when present", async () => {
    const provider = new ScriptedProvider([
      new LLMResponse({ content: "429 rate limit", finishReason: "error", retryAfter: 9 }),
      new LLMResponse({ content: "ok" }),
    ]);
    const response = await provider.chatWithRetry({ messages: userMessages() });
    expect(response.content).toBe("ok");
    expect(provider.delays).toEqual([9]);
  });

  it("retries structured status codes without keyword text", async () => {
    const provider = new ScriptedProvider([
      new LLMResponse({ content: "request failed", finishReason: "error", errorStatusCode: 409 }),
      new LLMResponse({ content: "ok" }),
    ]);
    const response = await provider.chatWithRetry({ messages: userMessages() });
    expect(response.content).toBe("ok");
    expect(provider.calls).toBe(2);
    expect(provider.delays).toEqual([1]);
  });

  it("stops on non-retryable 429 quota errors", async () => {
    const provider = new ScriptedProvider([
      new LLMResponse({
        content: '{"error":{"type":"insufficient_quota","code":"insufficient_quota"}}',
        finishReason: "error",
        errorStatusCode: 429,
        errorType: "insufficient_quota",
        errorCode: "insufficient_quota",
      }),
      new LLMResponse({ content: "ok" }),
    ]);
    const response = await provider.chatWithRetry({ messages: userMessages() });
    expect(response.finishReason).toBe("error");
    expect(provider.calls).toBe(1);
    expect(provider.delays).toEqual([]);
  });

  it("retries transient structured 429 rate-limit errors", async () => {
    const provider = new ScriptedProvider([
      new LLMResponse({
        content: '{"error":{"type":"rate_limit_exceeded","code":"rate_limit_exceeded"}}',
        finishReason: "error",
        errorStatusCode: 429,
        errorType: "rate_limit_exceeded",
        errorCode: "rate_limit_exceeded",
        errorRetryAfterS: 0.2,
      }),
      new LLMResponse({ content: "ok" }),
    ]);
    const response = await provider.chatWithRetry({ messages: userMessages() });
    expect(response.content).toBe("ok");
    expect(provider.calls).toBe(2);
    expect(provider.delays).toEqual([0.2]);
  });

  it("retries structured timeout errors", async () => {
    const provider = new ScriptedProvider([
      new LLMResponse({ content: "request failed", finishReason: "error", errorKind: "timeout" }),
      new LLMResponse({ content: "ok" }),
    ]);
    const response = await provider.chatWithRetry({ messages: userMessages() });
    expect(response.content).toBe("ok");
    expect(provider.calls).toBe(2);
    expect(provider.delays).toEqual([1]);
  });

  it("honors structured should_retry false", async () => {
    const provider = new ScriptedProvider([
      new LLMResponse({ content: "429 rate limit", finishReason: "error", errorShouldRetry: false }),
    ]);
    const response = await provider.chatWithRetry({ messages: userMessages() });
    expect(response.finishReason).toBe("error");
    expect(provider.calls).toBe(1);
    expect(provider.delays).toEqual([]);
  });

  it("prefers structured retry_after over text retry-after", async () => {
    const provider = new ScriptedProvider([
      new LLMResponse({ content: "429 rate limit, retry after 99s", finishReason: "error", errorRetryAfterS: 0.2 }),
      new LLMResponse({ content: "ok" }),
    ]);
    const response = await provider.chatWithRetry({ messages: userMessages() });
    expect(response.content).toBe("ok");
    expect(provider.delays).toEqual([0.2]);
  });

  it("aborts persistent retry after ten identical transient errors", async () => {
    const provider = new ScriptedProvider([
      ...Array.from({ length: 10 }, () => new LLMResponse({ content: "429 rate limit", finishReason: "error" })),
      new LLMResponse({ content: "ok" }),
    ]);
    const response = await provider.chatWithRetry({ messages: userMessages(), retryMode: "persistent" });
    expect(response.finishReason).toBe("error");
    expect(response.content).toBe("429 rate limit");
    expect(provider.calls).toBe(10);
    expect(provider.delays).toEqual([1, 2, 4, 4, 4, 4, 4, 4, 4]);
  });

  it("emits terminal progress when persistent identical error limit is reached", async () => {
    const provider = new ScriptedProvider(Array.from({ length: 10 }, () => new LLMResponse({ content: "429 rate limit", finishReason: "error" })));
    const progress: string[] = [];
    const response = await provider.chatWithRetry({
      messages: userMessages(),
      retryMode: "persistent",
      onRetryWait: (message) => {
        progress.push(message);
      },
    });
    expect(response.finishReason).toBe("error");
    expect(progress.at(-1)).toBe("Persistent retry stopped after 10 identical errors.");
  });

  it("normalizes explicit null maxTokens and temperature", async () => {
    const provider = new ScriptedProvider([new LLMResponse({ content: "ok" })]);
    const response = await provider.chatWithRetry({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: null as any,
      temperature: null as any,
    });
    expect(response.content).toBe("ok");
    expect(provider.lastArgs.maxTokens).toBe(4096);
    expect(provider.lastArgs.temperature).toBe(0.7);
  });

  it("retries ZhiPu 1302 rate-limit text", async () => {
    const provider = new ScriptedProvider([
      new LLMResponse({ content: "Error: {'code': '1302', 'message': 'your account reached \u901f\u7387\u9650\u5236'}", finishReason: "error" }),
      new LLMResponse({ content: "ok" }),
    ]);
    const response = await provider.chatWithRetry({ messages: userMessages() });
    expect(response.content).toBe("ok");
    expect(provider.calls).toBe(2);
    expect(provider.delays).toEqual([1]);
  });

  it("retries ZhiPu 1302 rate-limit text with 429 status", async () => {
    const provider = new ScriptedProvider([
      new LLMResponse({
        content: "Error: {'code': '1302', 'message': 'your account reached \u901f\u7387\u9650\u5236'}",
        finishReason: "error",
        errorStatusCode: 429,
        errorCode: "1302",
      }),
      new LLMResponse({ content: "ok" }),
    ]);
    const response = await provider.chatWithRetry({ messages: userMessages() });
    expect(response.content).toBe("ok");
    expect(provider.calls).toBe(2);
    expect(provider.delays).toEqual([1]);
  });

  it("normalizes explicit null maxTokens and temperature for chat streams", async () => {
    const provider = new ScriptedProvider([new LLMResponse({ content: "ok" })]);
    const response = await provider.chatStreamWithRetry({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: null as any,
      temperature: null as any,
    });
    expect(response.content).toBe("ok");
    expect(provider.lastArgs.maxTokens).toBe(4096);
    expect(provider.lastArgs.temperature).toBe(0.7);
  });
});
