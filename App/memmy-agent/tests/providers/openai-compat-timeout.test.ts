import { afterEach, describe, expect, it } from "vitest";
import { OpenAICompatProvider } from "../../src/providers/openai-compat-provider.js";

const oldTimeout = process.env.MEMMY_AGENT_OPENAI_COMPAT_TIMEOUT_S;

function spec(isLocal = false): any {
  return { isLocal: isLocal, defaultApiBase: "http://localhost:11434/v1", envKey: "" };
}

afterEach(() => {
  if (oldTimeout === undefined) delete process.env.MEMMY_AGENT_OPENAI_COMPAT_TIMEOUT_S;
  else process.env.MEMMY_AGENT_OPENAI_COMPAT_TIMEOUT_S = oldTimeout;
});

describe("OpenAI-compatible local timeout hints", () => {
  it("adds local endpoint hints to 502 errors", () => {
    const response = OpenAICompatProvider.handleError(new Error("Error code: 502"), spec(true), "http://localhost:11434/v1");

    expect(response.finishReason).toBe("error");
    expect(response.content).toContain("local model endpoint");
    expect(response.content).toContain("http://localhost:11434/v1");
    expect(response.content).toContain("proxy/tunnel");
  });

  it("defers client creation until first use and applies the default timeout", async () => {
    const provider = new OpenAICompatProvider({ apiKey: "test-key", apiBase: "https://example.com/v1" });

    expect((provider as any).client).toBeNull();
    const client = await provider.ensureClient();

    expect(client.timeout).toBe(120_000);
    expect(client.fetchOptions).toBeUndefined();
  });

  it("sets timeout and disables keepalive for local endpoints", async () => {
    const provider = new OpenAICompatProvider({ spec: spec(true) });

    const client = await provider.ensureClient();

    expect(client.timeout).toBe(120_000);
    expect(client.fetchOptions.keepalive).toBe(false);
  });

  it("allows overriding the compatibility request timeout with env", async () => {
    process.env.MEMMY_AGENT_OPENAI_COMPAT_TIMEOUT_S = "45";
    const provider = new OpenAICompatProvider({ apiKey: "test-key", apiBase: "https://example.com/v1" });

    const client = await provider.ensureClient();

    expect(client.timeout).toBe(45_000);
  });

  it("applies the compatibility request timeout to fetch calls", async () => {
    const oldFetch = globalThis.fetch;
    process.env.MEMMY_AGENT_OPENAI_COMPAT_TIMEOUT_S = "0.01";
    globalThis.fetch = (async (url: any, init: any = {}) => {
      const signal = init.signal as AbortSignal | undefined;
      return await new Promise((resolve, reject) => {
        if (!signal) reject(new Error("missing abort signal"));
        signal?.addEventListener("abort", () => {
          const error: any = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }) as any;

    try {
      const provider = new OpenAICompatProvider({
        apiKey: "test-key",
        apiBase: "https://example.com/v1",
        apiType: "chatCompletions",
      });

      const response = await provider.chat({
        messages: [{ role: "user", content: "hello" }],
        model: "test-model",
      });

      expect(response.finishReason).toBe("error");
      expect(response.errorKind).toBe("timeout");
      expect(response.content).toContain("Error:");
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("configures SDK timeout for non-stream response reads", async () => {
    process.env.MEMMY_AGENT_OPENAI_COMPAT_TIMEOUT_S = "0.01";
    const provider = new OpenAICompatProvider({
      apiKey: "test-key",
      apiBase: "https://example.com/v1",
      apiType: "chatCompletions",
    });

    const client = await provider.ensureClient();

    expect(client.timeout).toBe(10);
  });
});
