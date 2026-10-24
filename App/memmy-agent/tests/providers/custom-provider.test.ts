import { describe, expect, it } from "vitest";
import { Config } from "../../src/config/schema.js";
import { AnthropicProvider } from "../../src/providers/anthropic-provider.js";
import { BedrockProvider } from "../../src/providers/bedrock-provider.js";
import { makeProvider } from "../../src/providers/factory.js";
import {
  chatCompletionsModelForcesNoneReasoning,
  customModelUsesMaxCompletionTokens,
} from "../../src/providers/custom-provider.js";
import { OpenAICompatProvider } from "../../src/providers/openai-compat-provider.js";
import { findByName } from "../../src/providers/registry.js";

describe("custom provider", () => {
  it("passes OpenAI-compatible custom config through to the provider", () => {
    const provider = makeProvider(
      new Config({
        agents: { defaults: { provider: "custom", model: "gpt-4o-mini" } },
        providers: {
          custom: {
            apiKey: "test-key",
            endpoints: {
              chat: {
                apiBase: "https://example.com/v1",
                protocol: "openai-chat-completions",
              },
            },
            extraHeaders: { "APP-Code": "demo-app" },
            extraBody: { user: "memmy" },
          },
        },
      }),
    ) as OpenAICompatProvider;

    expect(provider).toBeInstanceOf(OpenAICompatProvider);
    expect(provider.apiKey).toBe("test-key");
    expect(provider.apiBase).toBe("https://example.com/v1");
    expect(provider.extraHeaders).toEqual({ "APP-Code": "demo-app" });
    expect(provider.extraBody).toEqual({ user: "memmy" });
  });

  it("derives the compatibility API type from the endpoint protocol", () => {
    const responses = new Config({ providers: { custom: { endpoints: {
      chat: { apiBase: "https://example.test/v1", protocol: "openai-responses" },
    } } } });
    const chatCompletions = new Config({ providers: { custom: { endpoints: {
      chat: { apiBase: "https://example.test/v1", protocol: "openai-chat-completions" },
    } } } });

    expect(responses.providers.custom.apiType).toBe("responses");
    expect(chatCompletions.providers.custom.apiType).toBe("chatCompletions");
    expect(() => new Config({ providers: { custom: { endpoints: {
      chat: { apiBase: "https://example.test/v1", protocol: "response" },
    } } } })).toThrow();
  });

  it("uses max_completion_tokens for newer OpenAI model names", () => {
    expect(customModelUsesMaxCompletionTokens("gpt-6-sol")).toBe(true);
    expect(customModelUsesMaxCompletionTokens("gpt-5.4")).toBe(true);
    expect(customModelUsesMaxCompletionTokens("deepseek-v4")).toBe(false);
    expect(customModelUsesMaxCompletionTokens("qwen-max")).toBe(false);
    expect(customModelUsesMaxCompletionTokens("gpt-4o")).toBe(false);
  });

  it("treats gpt- names and o-series names as chat completions reasoning models", () => {
    expect(chatCompletionsModelForcesNoneReasoning("gpt-4o")).toBe(true);
    expect(chatCompletionsModelForcesNoneReasoning("gpt-6-sol")).toBe(true);
    expect(chatCompletionsModelForcesNoneReasoning("o3-mini")).toBe(true);
    expect(chatCompletionsModelForcesNoneReasoning("qwen-max")).toBe(false);
  });

  it("sends max_completion_tokens only for matching custom chat models", () => {
    const gpt = chatKwargs("gpt-6-sol");
    const qwen = chatKwargs("qwen-max");

    expect(gpt.max_completion_tokens).toBe(1024);
    expect(gpt).not.toHaveProperty("max_tokens");
    expect(qwen.max_tokens).toBe(1024);
    expect(qwen).not.toHaveProperty("max_completion_tokens");
  });

  it("keeps reasoning_effort when custom thinking is on", () => {
    const kwargs = chatKwargs("gpt-6-sol", {
      reasoningEffort: "medium",
      tools: [{ type: "function", function: { name: "read_file" } }],
    });

    expect(kwargs.reasoning_effort).toBe("medium");
  });

  it("sends reasoning_effort none for custom chat completions gpt models when thinking is off", () => {
    const tools = [{ type: "function", function: { name: "read_file" } }];

    expect(chatKwargs("gpt-6-sol", { tools }).reasoning_effort).toBe("none");
    expect(chatKwargs("gpt-6-sol", { reasoningEffort: "none", tools }).reasoning_effort).toBe("none");
    expect(chatKwargs("gpt-4o", { tools }).reasoning_effort).toBe("none");
    expect(chatKwargs("gpt-4o", { tools }).max_tokens).toBe(1024);
    expect(chatKwargs("gpt-4o", { tools })).not.toHaveProperty("max_completion_tokens");
    expect(chatKwargs("qwen-max", { tools })).not.toHaveProperty("reasoning_effort");
  });

  it("does not force reasoning_effort none for custom responses", () => {
    const provider = new OpenAICompatProvider("test-key", "https://example.com/v1", "gpt-6-sol", findByName("custom"));
    provider.apiType = "responses";
    const kwargs = provider.buildKwargs({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "read_file" } }],
      model: "gpt-6-sol",
      maxTokens: 1024,
      temperature: 0.7,
      reasoningEffort: null,
      toolChoice: null,
    });

    expect(kwargs).not.toHaveProperty("reasoning_effort");
  });

  it("selects the client from the custom endpoint protocol", () => {
    const responses = makeProvider(customPresetConfig("openai-responses", "gpt-4o-mini")) as OpenAICompatProvider;
    const anthropic = makeProvider(customPresetConfig("anthropic-messages", "claude-sonnet"));
    const bedrock = makeProvider(customPresetConfig("bedrock-converse", "anthropic.claude-sonnet"));

    expect(responses).toBeInstanceOf(OpenAICompatProvider);
    expect(responses.apiType).toBe("responses");
    expect(anthropic).toBeInstanceOf(AnthropicProvider);
    expect(bedrock).toBeInstanceOf(BedrockProvider);
  });

  it("parses empty choices as an error response", () => {
    const provider = new OpenAICompatProvider();

    const result = provider.parseResponse({ choices: [] });

    expect(result.finishReason).toBe("error");
    expect(result.content).toContain("empty choices");
  });

  it("parses a plain string response", () => {
    const provider = new OpenAICompatProvider();

    const result = provider.parseResponse("hello from backend");

    expect(result.finishReason).toBe("stop");
    expect(result.content).toBe("hello from backend");
  });

  it("parses a object response with usage", () => {
    const provider = new OpenAICompatProvider();

    const result = provider.parseResponse({
      choices: [
        {
          message: { content: "hello from object" },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 2,
        total_tokens: 3,
      },
    });

    expect(result.finishReason).toBe("stop");
    expect(result.content).toBe("hello from object");
    expect(result.usage.total_tokens).toBe(3);
  });

  it("parses plain text streaming chunks", () => {
    const result = OpenAICompatProvider.parseChunks(["hello ", "world"]);

    expect(result.finishReason).toBe("stop");
    expect(result.content).toBe("hello world");
  });

  it("deduplicates parallel streaming tool call ids", () => {
    const result = OpenAICompatProvider.parseChunks([
      {
        choices: [
          {
            finish_reason: "tool_calls",
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_dup",
                  function: { name: "read_file", arguments: '{"path":"a.txt"}' },
                },
                {
                  index: 1,
                  id: "call_dup",
                  function: { name: "read_file", arguments: '{"path":"b.txt"}' },
                },
              ],
            },
          },
        ],
      },
    ]);
    const ids = result.toolCalls.map((toolCall) => toolCall.id);

    expect(ids[0]).toBe("call_dup");
    expect(ids).toHaveLength(2);
    expect(new Set(ids)).toHaveProperty("size", 2);
  });

  it("includes a local endpoint reachability hint for 502 errors", () => {
    const spec = findByName("ollama");

    const result = OpenAICompatProvider.handleError(
      new Error("Error code: 502"),
      spec,
      "http://localhost:11434/v1",
    );

    expect(result.finishReason).toBe("error");
    expect(result.content).toContain("local model endpoint");
    expect(result.content).toContain("http://localhost:11434/v1");
    expect(result.content).toContain("proxy/tunnel");
  });
});

function chatKwargs(
  model: string,
  overrides: { reasoningEffort?: string | null; tools?: Record<string, unknown>[] | null } = {},
): Record<string, unknown> {
  const provider = new OpenAICompatProvider("test-key", "https://example.com/v1", model, findByName("custom"));
  provider.apiType = "chatCompletions";
  return provider.buildKwargs({
    messages: [{ role: "user", content: "hi" }],
    tools: overrides.tools ?? null,
    model,
    maxTokens: 1024,
    temperature: 0.7,
    reasoningEffort: overrides.reasoningEffort ?? null,
    toolChoice: null,
  });
}

function customPresetConfig(protocol: string, model: string): Config {
  return new Config({
    agents: { defaults: { provider: "custom", model, modelPreset: "chosen" } },
    providers: {
      custom: {
        apiKey: "test-key",
        endpoints: {
          chat: {
            apiBase: protocol === "bedrock-converse"
              ? "https://bedrock-runtime.us-west-2.amazonaws.com"
              : "https://example.com/v1",
            protocol,
            ...(protocol === "bedrock-converse" ? { region: "us-west-2" } : {})
          }
        }
      }
    },
    modelPresets: {
      chosen: {
        provider: "custom",
        endpoint: "chat",
        model,
        source: "byok",
        capabilities: ["agent"]
      }
    }
  });
}
