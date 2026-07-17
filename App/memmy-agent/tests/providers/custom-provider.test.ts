import { describe, expect, it } from "vitest";
import { Config } from "../../src/config/schema.js";
import { makeProvider } from "../../src/providers/factory.js";
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
            apiBase: "https://example.com/v1",
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

  it("allows non-auto API type only for the OpenAI provider", () => {
    expect(() => new Config({ providers: { custom: { apiBase: "https://example.test/v1", apiType: "responses" } } })).toThrow(
      "providers.custom.apiType is only supported for providers.openai",
    );
    expect(() => new Config({ providers: { custom: { apiBase: "https://example.test/v1", apiType: "chatCompletions" } } })).toThrow(
      "providers.custom.apiType is only supported for providers.openai",
    );
    expect(() => new Config({ providers: { openai: { apiType: "response" } } })).toThrow();
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
