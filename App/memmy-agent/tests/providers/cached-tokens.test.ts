import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../../src/providers/anthropic-provider.js";
import { OpenAICompatProvider } from "../../src/providers/openai-compat-provider.js";
import { parseResponseOutput } from "../../src/providers/openai-responses/index.js";

class FakeUsage {
  [key: string]: any;

  constructor(values: Record<string, any>) {
    Object.assign(this, values);
  }
}

class FakePromptDetails {
  cached_tokens: number;

  constructor(cachedTokens = 0) {
    this.cached_tokens = cachedTokens;
  }
}

const dictChoice = { message: { content: "Hello" }, finish_reason: "stop" };

describe("cached token accounting", () => {
  it("preserves chat completion usage details from OpenAI-compatible responses", () => {
    const provider = new OpenAICompatProvider();
    const result = provider.parseResponse({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 3,
        total_tokens: 13,
        prompt_tokens_details: { cached_tokens: 7 },
      },
    });

    expect(result.usage.prompt_tokens_details.cached_tokens).toBe(7);
    expect(result.usage.cached_tokens).toBe(7);
  });

  it("extracts OpenAI cached tokens from object usage", () => {
    const result = new OpenAICompatProvider().parseResponse({
      choices: [dictChoice],
      usage: {
        prompt_tokens: 2000,
        completion_tokens: 300,
        total_tokens: 2300,
        prompt_tokens_details: { cached_tokens: 1200 },
      },
    });

    expect(result.usage.cached_tokens).toBe(1200);
    expect(result.usage.prompt_tokens).toBe(2000);
  });

  it("normalizes top-level and DeepSeek cached token fields", () => {
    const provider = new OpenAICompatProvider();

    expect(
      provider.parseResponse({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, cached_tokens: 5 },
      }).usage.cached_tokens,
    ).toBe(5);
    expect(
      provider.parseResponse({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, prompt_cache_hit_tokens: 4 },
      }).usage.cached_tokens,
    ).toBe(4);
  });

  it("omits cached_tokens when no cache fields are present", () => {
    const result = new OpenAICompatProvider().parseResponse({
      choices: [dictChoice],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 200,
        total_tokens: 1200,
      },
    });

    expect(result.usage).not.toHaveProperty("cached_tokens");
  });

  it("omits cached_tokens when OpenAI reports zero cached tokens", () => {
    const result = new OpenAICompatProvider().parseResponse({
      choices: [dictChoice],
      usage: {
        prompt_tokens: 2000,
        completion_tokens: 300,
        total_tokens: 2300,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    });

    expect(result.usage).not.toHaveProperty("cached_tokens");
  });

  it("extracts OpenAI cached tokens from SDK-style usage objects", () => {
    const usage = new FakeUsage({
      prompt_tokens: 2000,
      completion_tokens: 300,
      total_tokens: 2300,
      prompt_tokens_details: new FakePromptDetails(1200),
    });
    const response = new FakeUsage({ choices: [dictChoice], usage });

    expect(new OpenAICompatProvider().parseResponse(response).usage.cached_tokens).toBe(1200);
  });

  it("extracts DeepSeek cached tokens from SDK-style usage objects", () => {
    const usage = new FakeUsage({
      prompt_tokens: 1500,
      completion_tokens: 200,
      total_tokens: 1700,
      prompt_cache_hit_tokens: 1200,
    });
    const response = new FakeUsage({ choices: [dictChoice], usage });

    expect(new OpenAICompatProvider().parseResponse(response).usage.cached_tokens).toBe(1200);
  });

  it("extracts StepFun or Moonshot top-level cached tokens from SDK-style usage objects", () => {
    const usage = new FakeUsage({
      prompt_tokens: 591,
      completion_tokens: 120,
      total_tokens: 711,
      cached_tokens: 512,
    });
    const response = new FakeUsage({ choices: [dictChoice], usage });

    expect(new OpenAICompatProvider().parseResponse(response).usage.cached_tokens).toBe(512);
  });

  it("prefers nested OpenAI cached tokens over top-level cached tokens", () => {
    const result = new OpenAICompatProvider().parseResponse({
      choices: [dictChoice],
      usage: {
        prompt_tokens: 2000,
        completion_tokens: 300,
        total_tokens: 2300,
        prompt_tokens_details: { cached_tokens: 100 },
        cached_tokens: 500,
      },
    });

    expect(result.usage.cached_tokens).toBe(100);
  });

  it("maps Anthropic cache_read_input_tokens to cached_tokens", () => {
    const result = AnthropicProvider.parseResponse(
      new FakeUsage({
        id: "msg_1",
        type: "message",
        stop_reason: "end_turn",
        content: [new FakeUsage({ type: "text", text: "hello" })],
        usage: new FakeUsage({
          input_tokens: 800,
          output_tokens: 200,
          cache_creation_input_tokens: 300,
          cache_read_input_tokens: 1200,
        }),
      }),
    );

    expect(result.usage.cached_tokens).toBe(1200);
    expect(result.usage.prompt_tokens).toBe(2300);
    expect(result.usage.total_tokens).toBe(2500);
    expect(result.usage.cache_creation_input_tokens).toBe(300);
  });

  it("omits Anthropic cached_tokens when cache fields are absent", () => {
    const result = AnthropicProvider.parseResponse(
      new FakeUsage({
        id: "msg_1",
        type: "message",
        stop_reason: "end_turn",
        content: [new FakeUsage({ type: "text", text: "hello" })],
        usage: new FakeUsage({ input_tokens: 800, output_tokens: 200 }),
      }),
    );

    expect(result.usage).not.toHaveProperty("cached_tokens");
  });

  it("normalizes Responses API token usage", () => {
    const result = parseResponseOutput({
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 6 } },
      status: "completed",
    });

    expect(result.usage.prompt_tokens).toBe(10);
    expect(result.usage.completion_tokens).toBe(2);
    expect(result.usage.input_tokens_details.cached_tokens).toBe(6);
  });
});
