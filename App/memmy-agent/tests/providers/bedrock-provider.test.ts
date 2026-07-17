import { describe, expect, it } from "vitest";
import { Config } from "../../src/config/schema.js";
import { BedrockProvider } from "../../src/providers/bedrock-provider.js";
import { makeProvider } from "../../src/providers/factory.js";
import { findByName } from "../../src/providers/registry.js";

class FakeBedrockError extends Error {
  response = {
    ResponseMetadata: {
      HTTPStatusCode: 429,
      HTTPHeaders: { "retry-after": "3" },
    },
    Error: {
      Code: "ThrottlingException",
      Message: "Rate exceeded",
    },
  };

  constructor() {
    super("too many requests");
  }
}

describe("Bedrock provider", () => {
  it("selects Bedrock for Bedrock model prefixes and preserves region/profile config", () => {
    const provider = makeProvider(
      new Config({
        agents: { defaults: { provider: "bedrock", model: "anthropic.claude-3-5-sonnet" } },
        providers: { bedrock: { region: "us-east-1", profile: "dev" } },
      }),
    ) as BedrockProvider;

    expect(provider).toBeInstanceOf(BedrockProvider);
    expect(provider.region).toBe("us-east-1");
    expect(provider.profile).toBe("dev");
    expect(findByName("bedrock")?.backend).toBe("bedrock");
  });

  it("maps configured AWS profiles to SDK credential providers", async () => {
    const provider = new BedrockProvider({ region: "us-east-1", profile: "dev" });
    const client = await provider.makeClient();

    expect(provider.profile).toBe("dev");
    expect(typeof client.config.credentials).toBe("function");
    expect(client.config.profile).toBeUndefined();
  });

  it("converts chat history, tools, thinking, and tool results to Bedrock Converse kwargs", () => {
    const provider = new BedrockProvider({
      defaultModel: "bedrock/global.anthropic.claude-opus-4-7",
      extraBody: { trace: "ENABLED", thinking: { budget_tokens: 512 } },
    });

    const kwargs = provider.buildKwargs({
      messages: [
        { role: "system", content: "sys" },
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image_url", image_url: { url: "data:image/jpg;base64,aGk=" } },
          ],
        },
        {
          role: "assistant",
          content: "reading",
          thinking_blocks: [{ type: "thinking", thinking: "plan", signature: "sig" }],
          tool_calls: [{ id: "tu_1", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }],
        },
        { role: "tool", tool_call_id: "tu_1", content: { text: "file text" } },
      ],
      tools: [{ type: "function", function: { name: "read_file", description: "read", parameters: { type: "object" }, strict: true } }],
      model: null,
      maxTokens: 128,
      temperature: 0.3,
      reasoningEffort: "high",
      toolChoice: "required",
    });

    expect(kwargs.modelId).toBe("global.anthropic.claude-opus-4-7");
    expect(kwargs.inferenceConfig).toEqual({ maxTokens: 128 });
    expect(kwargs.system).toEqual([{ text: "sys" }]);
    expect(kwargs.additionalModelRequestFields).toEqual({ trace: "ENABLED", thinking: { type: "adaptive", effort: "high", budget_tokens: 512 } });
    expect(kwargs.messages[0].content[1].image.format).toBe("jpeg");
    expect(Buffer.isBuffer(kwargs.messages[0].content[1].image.source.bytes)).toBe(true);
    expect(kwargs.messages[1].content).toEqual([
      { reasoningContent: { reasoningText: { text: "plan", signature: "sig" } } },
      { text: "reading" },
      { toolUse: { toolUseId: "tu_1", name: "read_file", input: { path: "a.txt" } } },
    ]);
    expect(kwargs.messages[2].content).toEqual([
      { toolResult: { toolUseId: "tu_1", content: [{ text: "file text" }], status: "success" } },
    ]);
    expect(kwargs.toolConfig).toMatchObject({
      tools: [{ toolSpec: { name: "read_file", description: "read", strict: true, inputSchema: { json: { type: "object" } } } }],
      toolChoice: { any: {} },
    });
  });

  it("adds a noop tool config when history contains tool blocks but no tools are supplied", () => {
    const provider = new BedrockProvider();
    const kwargs = provider.buildKwargs({
      messages: [
        { role: "user", content: "read" },
        { role: "assistant", content: null, tool_calls: [{ id: "tu_1", function: { name: "read_file", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "tu_1", content: "ok" },
      ],
      tools: null,
      model: "bedrock/model",
      maxTokens: 10,
      temperature: 0.1,
      reasoningEffort: null,
      toolChoice: null,
    });

    expect(kwargs.toolConfig.tools[0].toolSpec.name).toBe("memmy_noop");
  });

  it("keeps temperature and skips Anthropic thinking for generic Bedrock models", () => {
    const provider = new BedrockProvider({ region: "us-east-1" });
    const kwargs = provider.buildKwargs({
      messages: [{ role: "user", content: "hi" }],
      tools: null,
      model: "bedrock/amazon.nova-lite-v1:0",
      maxTokens: 1024,
      temperature: 0.3,
      reasoningEffort: "medium",
      toolChoice: null,
    });

    expect(kwargs.modelId).toBe("amazon.nova-lite-v1:0");
    expect(kwargs.inferenceConfig).toEqual({ maxTokens: 1024, temperature: 0.3 });
    expect(kwargs.additionalModelRequestFields).toBeUndefined();
    expect(kwargs.toolConfig).toBeUndefined();
  });

  it("parses Bedrock responses with text, reasoning, tool calls, and usage", () => {
    const response = BedrockProvider.parseResponse({
      output: {
        message: {
          content: [
            { reasoningContent: { reasoningText: { text: "hidden", signature: "sig" } } },
            { text: "hello" },
            { toolUse: { toolUseId: "tu_1", name: "lookup", input: { q: "x" } } },
          ],
        },
      },
      stopReason: "tool_use",
      usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12, cacheReadInputTokens: 2, cacheWriteInputTokens: 1 },
    });

    expect(response.content).toBe("hello");
    expect(response.reasoningContent).toBe("hidden");
    expect(response.thinkingBlocks).toEqual([{ type: "thinking", thinking: "hidden", signature: "sig" }]);
    expect(response.finishReason).toBe("tool_calls");
    expect(response.toolCalls[0].toOpenAIToolCall()).toMatchObject({
      id: "tu_1",
      function: { name: "lookup", arguments: '{"q":"x"}' },
    });
    expect(response.usage).toMatchObject({
      prompt_tokens: 5,
      completion_tokens: 7,
      total_tokens: 12,
      cached_tokens: 2,
      cache_creation_input_tokens: 1,
    });
  });

  it("calls an injected Bedrock client and parses the converse response", async () => {
    const calls: any[] = [];
    const provider = new BedrockProvider({
      client: {
        converse: async (kwargs: any) => {
          calls.push(kwargs);
          return {
            output: { message: { content: [{ text: "ok" }] } },
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 2 },
          };
        },
      },
    });

    const result = await provider.chat({ messages: [{ role: "user", content: "hi" }], maxTokens: 64 });

    expect(result.content).toBe("ok");
    expect(calls[0]).toMatchObject({ inferenceConfig: { maxTokens: 64 }, messages: [{ role: "user", content: [{ text: "hi" }] }] });
  });

  it("maps Bedrock errors to retry metadata", async () => {
    const provider = new BedrockProvider({
      region: "us-east-1",
      client: {
        converse: async () => {
          throw new FakeBedrockError();
        },
      },
    });

    const result = await provider.chat({ messages: [{ role: "user", content: "hi" }] });

    expect(result.finishReason).toBe("error");
    expect(result.errorStatusCode).toBe(429);
    expect(result.errorShouldRetry).toBe(true);
    expect(result.errorCode).toBe("throttlingexception");
    expect(result.retryAfter).toBe(3);
  });

  it("parses Converse streaming events and emits content deltas", async () => {
    const provider = new BedrockProvider({
      client: {
        converseStream: async () => ({
          stream: [
            { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "he" } } },
            { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "llo" } } },
            { messageStop: { stopReason: "end_turn" } },
            { metadata: { usage: { inputTokens: 1, outputTokens: 1 } } },
          ],
        }),
      },
    });
    const deltas: string[] = [];

    const result = await provider.chatStream({
      messages: [{ role: "user", content: "hi" }],
      onContentDelta: (delta) => {
        deltas.push(delta);
      },
    });

    expect(deltas).toEqual(["he", "llo"]);
    expect(result.content).toBe("hello");
    expect(result.finishReason).toBe("stop");
    expect(result.usage.total_tokens).toBe(2);
  });
});
