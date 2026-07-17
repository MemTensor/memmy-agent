import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "../../src/providers/anthropic-provider.js";
import { extractReasoning } from "../../src/utils/helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Anthropic thinking", () => {
  function build(reasoningEffort: string | null, overrides: Record<string, any> = {}): Record<string, any> {
    const provider = new AnthropicProvider({ apiKey: "key", defaultModel: overrides.defaultModel ?? "claude-sonnet-4-6" });
    return provider.buildKwargs({
      messages: [{ role: "user", content: "hello" }],
      tools: null,
      model: overrides.model ?? null,
      maxTokens: overrides.maxTokens ?? 4096,
      temperature: overrides.temperature ?? 0.7,
      reasoningEffort,
      toolChoice: null,
      supportsCaching: false,
    });
  }

  it("keeps dedicated thinking blocks separate from visible content", () => {
    expect(extractReasoning(null, [{ type: "thinking", thinking: "step 1" }], "hello")).toEqual(["step 1", "hello"]);
  });

  it("marks Anthropic provider prompt-cache tools", () => {
    const [, , tools] = AnthropicProvider.applyCacheControl("system", [], [
      { name: "read_file", input_schema: {} },
      { name: "write_file", input_schema: {} },
    ]);

    expect(tools?.[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("converts OpenAI-style history into Anthropic messages", () => {
    const provider = new AnthropicProvider({ apiKey: "key" });
    const [system, messages] = provider.convertMessages([
      { role: "system", content: "system prompt" },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
        ],
      },
      {
        role: "assistant",
        content: "I'll call a tool",
        thinking_blocks: [{ type: "thinking", thinking: "plan", signature: "sig" }],
        tool_calls: [{ id: "toolu_1", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }],
      },
      { role: "tool", tool_call_id: "toolu_1", content: "file text" },
    ]);

    expect(system).toBe("system prompt");
    expect(messages[0].content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "abc" },
    });
    expect(messages[1].content).toEqual([
      { type: "thinking", thinking: "plan", signature: "sig" },
      { type: "text", text: "I'll call a tool" },
      { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.txt" } },
    ]);
    expect(messages[2].content).toEqual([{ type: "tool_result", tool_use_id: "toolu_1", content: "file text" }]);
  });

  it("builds Anthropic kwargs with cache markers, tools, and thinking budget", () => {
    const provider = new AnthropicProvider({
      apiKey: "key",
      defaultModel: "anthropic/claude-sonnet-test",
      extraHeaders: { "x-test": "1" },
      extraBody: { metadata: { user_id: "u1" } },
    });

    const kwargs = provider.buildKwargs({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
      ],
      tools: [{ type: "function", function: { name: "read_file", description: "read", parameters: { type: "object" } } }],
      model: null,
      maxTokens: 128,
      temperature: 0.4,
      reasoningEffort: "low",
      toolChoice: "required",
    });

    expect(kwargs.model).toBe("claude-sonnet-test");
    expect(kwargs.temperature).toBe(1);
    expect(kwargs.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
    expect(kwargs.max_tokens).toBe(5120);
    expect(kwargs.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(kwargs.messages[1].content.at(-1).cache_control).toEqual({ type: "ephemeral" });
    expect(kwargs.tools[0]).toMatchObject({ name: "read_file", description: "read", input_schema: { type: "object" } });
    expect(kwargs.tool_choice).toEqual({ type: "auto" });
    expect(kwargs.extra_headers).toEqual({ "x-test": "1" });
    expect(kwargs.metadata).toEqual({ user_id: "u1" });
  });

  it("parses Anthropic response text, tool calls, thinking blocks, stop reason, and usage", () => {
    const response = AnthropicProvider.parseResponse({
      content: [
        { type: "thinking", thinking: "hidden", signature: "sig" },
        { type: "text", text: "hello" },
        { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } },
      ],
      stop_reason: "tool_use",
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
        output_tokens: 5,
      },
    });

    expect(response.content).toBe("hello");
    expect(response.finishReason).toBe("tool_calls");
    expect(response.toolCalls[0].toOpenAIToolCall()).toMatchObject({
      id: "toolu_1",
      function: { name: "lookup", arguments: '{"q":"x"}' },
    });
    expect(response.thinkingBlocks).toEqual([{ type: "thinking", thinking: "hidden", signature: "sig" }]);
    expect(response.usage).toMatchObject({
      prompt_tokens: 15,
      completion_tokens: 5,
      total_tokens: 20,
      cached_tokens: 3,
    });
  });

  it("posts to the Anthropic messages API and parses the response", async () => {
    const calls: any[] = [];
    const provider = new AnthropicProvider({ apiKey: "key", apiBase: "https://anthropic.test", defaultModel: "claude-test" });
    provider.client.messages.create = vi.fn(async (body: any) => {
      calls.push(body);
      return {
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 2 },
      };
    });
    const result = await provider.chat({ messages: [{ role: "user", content: "hi" }], maxTokens: 64 });

    expect(result.content).toBe("ok");
    expect(provider.client.apiKey).toBe("key");
    expect(provider.client.baseURL).toBe("https://anthropic.test");
    expect(calls[0]).toMatchObject({ model: "claude-test", max_tokens: 64 });
    expect(calls[0].messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("sets adaptive thinking mode", () => {
    expect(build("adaptive").thinking).toEqual({ type: "adaptive" });
  });

  it("forces temperature to one for adaptive thinking", () => {
    expect(build("adaptive").temperature).toBe(1.0);
  });

  it("does not inflate max_tokens for adaptive thinking", () => {
    expect(build("adaptive", { maxTokens: 2048 }).max_tokens).toBe(2048);
  });

  it("does not include budget_tokens for adaptive thinking", () => {
    expect(build("adaptive").thinking).not.toHaveProperty("budget_tokens");
  });

  it("uses enabled thinking with a high budget", () => {
    const kwargs = build("high", { maxTokens: 4096 });

    expect(kwargs.thinking.type).toBe("enabled");
    expect(kwargs.thinking.budget_tokens).toBe(8192);
    expect(kwargs.max_tokens).toBeGreaterThanOrEqual(kwargs.thinking.budget_tokens + 4096);
  });

  it("does not enable thinking when reasoning effort is unset or none", () => {
    expect(build(null)).not.toHaveProperty("thinking");
    expect(build(null).temperature).toBe(0.7);
    expect(build("none")).not.toHaveProperty("thinking");
    expect(build("none").temperature).toBe(0.7);
  });

  it("omits temperature for opus-4-7 thinking and non-thinking requests", () => {
    expect(build("adaptive", { defaultModel: "claude-opus-4-7" })).not.toHaveProperty("temperature");

    const high = build("high", { defaultModel: "claude-opus-4-7", maxTokens: 4096 });
    expect(high).not.toHaveProperty("temperature");
    expect(high.thinking.type).toBe("enabled");

    const none = build(null, { defaultModel: "claude-opus-4-7" });
    expect(none).not.toHaveProperty("temperature");
    expect(none).not.toHaveProperty("thinking");
  });
});
