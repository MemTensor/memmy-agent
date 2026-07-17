import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "../../src/providers/anthropic-provider.js";
import { LLMResponse } from "../../src/providers/base.js";

const LONG_REQUEST_MESSAGE =
  "Streaming is required for operations that may take longer than 10 minutes. See https://github.com/anthropics/anthropic-sdk-typescript#long-requests for more details";

class ValueError extends Error {
  override name = "ValueError";
}

describe("Anthropic long request fallback", () => {
  it("matches streaming-required ValueError instances", () => {
    expect(AnthropicProvider.isStreamingRequiredError(new ValueError(LONG_REQUEST_MESSAGE))).toBe(true);
  });

  it("ignores unrelated ValueError instances", () => {
    expect(AnthropicProvider.isStreamingRequiredError(new ValueError("something else went wrong"))).toBe(false);
  });

  it("ignores other exception types", () => {
    const error = new Error(LONG_REQUEST_MESSAGE);
    error.name = "RuntimeError";

    expect(AnthropicProvider.isStreamingRequiredError(error)).toBe(false);
  });

  it("falls back to chatStream on long-request errors", async () => {
    const provider = new AnthropicProvider({ apiKey: "test-key" });
    provider.client.messages.create = vi.fn(async () => {
      throw new ValueError(LONG_REQUEST_MESSAGE);
    });
    const expected = new LLMResponse({ content: "streamed result", finishReason: "stop" });
    const captured: Record<string, any> = {};
    provider.chatStream = async (args: any) => {
      Object.assign(captured, args);
      return expected;
    };

    const result = await provider.chat({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 64_000,
      temperature: 0.5,
      reasoningEffort: "high",
      toolChoice: "auto",
    });

    expect(result).toBe(expected);
    expect(captured.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(captured.maxTokens).toBe(64_000);
    expect(captured.temperature).toBe(0.5);
    expect(captured.reasoningEffort).toBe("high");
    expect(captured.toolChoice).toBe("auto");
    expect(captured).not.toHaveProperty("onContentDelta");
  });

  it("does not fall back on unrelated ValueError instances", async () => {
    const provider = new AnthropicProvider({ apiKey: "test-key" });
    provider.client.messages.create = vi.fn(async () => {
      throw new ValueError("some other validation failure");
    });
    let called = false;
    provider.chatStream = async () => {
      called = true;
      return new LLMResponse({ content: "x", finishReason: "stop" });
    };

    const result = await provider.chat({ messages: [{ role: "user", content: "hi" }] });

    expect(called).toBe(false);
    expect(result.finishReason === "error" || (result.content ?? "").includes("Error")).toBe(true);
  });
});
