import { describe, expect, it } from "vitest";
import { Config, ProviderConfig } from "../../src/config/schema.js";
import { makeProvider, providerSignature } from "../../src/providers/factory.js";
import { deepMerge, OpenAICompatProvider } from "../../src/providers/openai-compat-provider.js";
import { findByName, ProviderSpec } from "../../src/providers/registry.js";

function makeProviderWithExtra(extraBody: Record<string, any> | null = null): OpenAICompatProvider {
  return new OpenAICompatProvider({
    apiKey: "test-key",
    defaultModel: "test-model",
    extraBody,
  });
}

function simpleMessages(): Record<string, any>[] {
  return [{ role: "user", content: "hello" }];
}

function buildArgs(overrides: Record<string, any> = {}): any {
  return {
    messages: simpleMessages(),
    tools: null,
    model: null,
    max_tokens: 100,
    temperature: 0.1,
    reasoning_effort: null,
    tool_choice: null,
    ...overrides,
  };
}

describe("deepMerge", () => {
  it("merges flat dictionaries", () => {
    expect(deepMerge({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it("overrides scalar values", () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it("merges nested dictionaries", () => {
    const base = { outer: { a: 1, b: 2 } };
    const override = { outer: { b: 3, c: 4 } };
    expect(deepMerge(base, override)).toEqual({ outer: { a: 1, b: 3, c: 4 } });
  });

  it("merges deeply nested dictionaries", () => {
    const base = { l1: { l2: { a: 1 } } };
    const override = { l1: { l2: { b: 2 } } };
    expect(deepMerge(base, override)).toEqual({ l1: { l2: { a: 1, b: 2 } } });
  });

  it("lets dictionaries replace scalars", () => {
    expect(deepMerge({ a: 1 }, { a: { nested: true } })).toEqual({
      a: { nested: true },
    });
  });

  it("lets scalars replace dictionaries", () => {
    expect(deepMerge({ a: { nested: true } }, { a: "flat" })).toEqual({ a: "flat" });
  });

  it("handles an empty base", () => {
    expect(deepMerge({}, { a: 1 })).toEqual({ a: 1 });
  });

  it("handles an empty override", () => {
    expect(deepMerge({ a: 1 }, {})).toEqual({ a: 1 });
  });

  it("does not mutate inputs", () => {
    const base = { a: { x: 1 } };
    const override = { a: { y: 2 } };
    deepMerge(base, override);
    expect(base).toEqual({ a: { x: 1 } });
    expect(override).toEqual({ a: { y: 2 } });
  });
});

describe("OpenAICompatProvider extra body initialization", () => {
  it("defaults to an empty extra body", () => {
    const provider = new OpenAICompatProvider({ apiKey: "test" });
    expect(provider.extraBody).toEqual({});
  });

  it("treats null as an empty extra body", () => {
    const provider = new OpenAICompatProvider({ apiKey: "test", extraBody: null });
    expect(provider.extraBody).toEqual({});
  });

  it("stores object extra body values", () => {
    const body = { chat_template_kwargs: { enable_thinking: false } };
    const provider = new OpenAICompatProvider({ apiKey: "test", extraBody: body });
    expect(provider.extraBody).toEqual(body);
  });
});

describe("buildKwargs extra body integration", () => {
  it("omits extra_body when none is configured", () => {
    const provider = makeProviderWithExtra();
    const kwargs = provider.buildKwargs(buildArgs());
    expect(kwargs).not.toHaveProperty("extra_body");
  });

  it("injects configured extra_body", () => {
    const provider = makeProviderWithExtra({
      chat_template_kwargs: { enable_thinking: false },
    });
    const kwargs = provider.buildKwargs(buildArgs());
    expect(kwargs.extra_body).toEqual({
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it("merges configured extra_body with thinking params and lets config override", () => {
    const spec = new ProviderSpec({
      name: "custom",
      thinkingStyle: "thinking_type",
      isLocal: true,
    });
    const provider = new OpenAICompatProvider({
      apiKey: "test",
      defaultModel: "deepseek-v3",
      spec,
      extraBody: { custom_param: "value", thinking: { type: "disabled" } },
    });

    const kwargs = provider.buildKwargs(buildArgs({ reasoning_effort: "high" }));

    expect(kwargs.extra_body).toEqual({
      thinking: { type: "disabled" },
      custom_param: "value",
    });
  });

  it("preserves nested extra_body values", () => {
    const provider = makeProviderWithExtra({
      chat_template_kwargs: { enable_thinking: false },
    });
    const kwargs = provider.buildKwargs(buildArgs());
    expect(kwargs.extra_body.chat_template_kwargs.enable_thinking).toBe(false);
  });

  it("injects guided_json for guided decoding", () => {
    const schema = { type: "object", properties: { name: { type: "string" } } };
    const provider = makeProviderWithExtra({ guided_json: schema });
    const kwargs = provider.buildKwargs(buildArgs());
    expect(kwargs.extra_body.guided_json).toEqual(schema);
  });

  it("injects repetition_penalty for local sampling", () => {
    const provider = makeProviderWithExtra({ repetition_penalty: 1.15 });
    const kwargs = provider.buildKwargs(buildArgs());
    expect(kwargs.extra_body.repetition_penalty).toBe(1.15);
  });
});

describe("buildResponsesBody extra body integration", () => {
  it("preserves visible tool-call content in Responses history", () => {
    const body = makeProviderWithExtra().buildResponsesBody(
      buildArgs({
        messages: [
          { role: "user", content: "读取配置" },
          {
            role: "assistant",
            content: "我先读取配置。",
            tool_calls: [
              {
                id: "call_read",
                type: "function",
                function: { name: "read_file", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_read", name: "read_file", content: "配置内容" },
        ],
      }),
    );

    expect(body.input.map((item: any) => item.type ?? item.role)).toEqual([
      "user",
      "message",
      "function_call",
      "function_call_output",
    ]);
    expect(body.input[1]).toMatchObject({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "我先读取配置。" }],
    });
    expect(body.input[2]).toMatchObject({
      type: "function_call",
      call_id: "call_read",
      name: "read_file",
      arguments: "{}",
    });
    expect(body.input[3]).toEqual({
      type: "function_call_output",
      call_id: "call_read",
      output: "配置内容",
    });
  });

  it("merges top-level Responses API fields", () => {
    const provider = new OpenAICompatProvider({
      apiKey: "test-key",
      defaultModel: "gpt-5",
      spec: findByName("openai"),
      extraBody: {
        metadata: { source: "test" },
        parallel_tool_calls: false,
      },
    });

    const body = provider.buildResponsesBody(buildArgs());

    expect(body.metadata).toEqual({ source: "test" });
    expect(body.parallel_tool_calls).toBe(false);
  });

  it("appends configured Responses API tools", () => {
    const provider = new OpenAICompatProvider({
      apiKey: "test-key",
      defaultModel: "gpt-5",
      spec: findByName("openai"),
      extraBody: { tools: [{ type: "web_search" }] },
    });

    const body = provider.buildResponsesBody(
      buildArgs({
        tools: [
          {
            type: "function",
            function: {
              name: "read_file",
              description: "Read a file",
              parameters: { type: "object" },
            },
          },
        ],
      }),
    );

    expect(body.tools).toEqual([
      {
        type: "function",
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object" },
      },
      { type: "web_search" },
    ]);
  });

  it("merges Responses API include values without duplicates", () => {
    const provider = new OpenAICompatProvider({
      apiKey: "test-key",
      defaultModel: "gpt-5",
      spec: findByName("openai"),
      extraBody: {
        include: ["reasoning.encrypted_content", "web_search_call.action.sources"],
      },
    });

    const body = provider.buildResponsesBody(buildArgs({ reasoning_effort: "high" }));

    expect(body.include).toEqual([
      "reasoning.encrypted_content",
      "web_search_call.action.sources",
    ]);
  });
});

describe("ProviderConfig extra body schema", () => {
  it("defaults extra body to null", () => {
    const config = new ProviderConfig();
    expect(config.extraBody).toBeNull();
  });

  it("accepts extra body dictionaries", () => {
    const config = new ProviderConfig({ extraBody: { guided_json: { type: "object" } } });
    expect(config.extraBody).toEqual({ guided_json: { type: "object" } });
  });

  it("accepts nested extra body dictionaries", () => {
    const config = new ProviderConfig({
      extraBody: { chat_template_kwargs: { enable_thinking: false } },
    });
    expect(config.extraBody?.chat_template_kwargs.enable_thinking).toBe(false);
  });
});

describe("provider factory extra body config", () => {
  it("passes extra body and headers to OpenAI-compatible providers", () => {
    const config = new Config({
      agents: { defaults: { provider: "openai", model: "openai/gpt-4o-mini" } },
      providers: {
        openai: {
          apiKey: "sk-test",
          extraHeaders: { "X-Test": "1" },
          extraBody: { user: "memmy", parallel_tool_calls: false },
        },
      },
    });
    const provider = makeProvider(config) as OpenAICompatProvider;

    expect(provider.extraHeaders).toEqual({ "X-Test": "1" });
    expect(provider.extraBody).toEqual({ user: "memmy", parallel_tool_calls: false });
    expect(providerSignature(config)).toContainEqual({ user: "memmy", parallel_tool_calls: false });
  });
});
