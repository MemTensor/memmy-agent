import { describe, expect, it, vi } from "vitest";
import { Config } from "../../src/config/schema.js";
import { makeProvider } from "../../src/providers/factory.js";
import { OpenAICompatProvider } from "../../src/providers/openai-compat-provider.js";
import { findByName } from "../../src/providers/registry.js";

function providerFor(name: string, model: string, extra: Record<string, any> = {}): OpenAICompatProvider {
  return new OpenAICompatProvider({ apiKey: "sk-test", defaultModel: model, spec: findByName(name), ...extra });
}

function buildKwargsFor(providerName: string, model: string, reasoningEffort: string | null = null): Record<string, any> {
  return providerFor(providerName, model).buildKwargs({
    messages: [{ role: "user", content: "hi" }],
    tools: null,
    model,
    maxTokens: 1024,
    temperature: 0.7,
    reasoningEffort,
    toolChoice: null,
  });
}

function toolCall(id: string): Record<string, any> {
  return { id, type: "function", function: { name: "my", arguments: "{}" } };
}

describe("OpenAI-compatible request kwargs", () => {
  it("keeps gateway and Gemini registry specs aligned with memmy", () => {
    expect(findByName("openrouter")).toMatchObject({
      isGateway: true,
      defaultApiBase: "https://openrouter.ai/api/v1",
    });
    expect(findByName("novita")).toMatchObject({
      isGateway: true,
      backend: "openai_compat",
      envKey: "NOVITA_API_KEY",
      defaultApiBase: "https://api.novita.ai/openai",
    });
    expect(findByName("gemini")?.keywords).toContain("gemma");
    expect(findByName("gemini")?.defaultApiBase).toBe("https://generativelanguage.googleapis.com/v1beta/openai/");
  });

  it("applies OpenRouter attribution headers and lets user headers override them", () => {
    const defaultProvider = providerFor("openrouter", "anthropic/claude-sonnet-4-5", {
      apiBase: "https://openrouter.ai/api/v1",
    });
    expect(defaultProvider.defaultHeaders).toMatchObject({
      "HTTP-Referer": "https://github.com/MemTensor/memmy-agent",
      "X-OpenRouter-Title": "Memmy Agent",
      "X-OpenRouter-Categories": "personal-agent,cli-agent",
    });
    expect(defaultProvider.defaultHeaders["x-session-affinity"]).toBeTruthy();

    const customProvider = providerFor("openrouter", "anthropic/claude-sonnet-4-5", {
      apiBase: "https://openrouter.ai/api/v1",
      extraHeaders: {
        "HTTP-Referer": "https://memmy-agent.local",
        "X-OpenRouter-Title": "Memmy Pro",
        "X-Custom-App": "enabled",
      },
    });
    expect(customProvider.defaultHeaders).toMatchObject({
      "HTTP-Referer": "https://memmy-agent.local",
      "X-OpenRouter-Title": "Memmy Pro",
      "X-OpenRouter-Categories": "personal-agent,cli-agent",
      "X-Custom-App": "enabled",
    });
  });

  it("normalizes provider model names according to spec", () => {
    expect(providerFor("openrouter", "anthropic/claude-sonnet-4-5").buildKwargs({
      messages: [{ role: "user", content: "hello" }],
      model: "anthropic/claude-sonnet-4-5",
    }).model).toBe("anthropic/claude-sonnet-4-5");
    expect(providerFor("aihubmix", "claude-sonnet-4-5").buildKwargs({
      messages: [{ role: "user", content: "hello" }],
      model: "anthropic/claude-sonnet-4-5",
    }).model).toBe("claude-sonnet-4-5");
    expect(providerFor("deepseek", "deepseek-chat").buildKwargs({
      messages: [{ role: "user", content: "hello" }],
      model: "deepseek-chat",
    }).model).toBe("deepseek-chat");
    expect(providerFor("openai", "gpt-4o").getDefaultModel()).toBe("gpt-4o");
  });

  it("sends model, messages, tool kwargs, and extra body fields to chat completions", async () => {
    const calls: any[] = [];
    const fetchMock = async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
        text: async () => "",
      } as any;
    };
    globalThis.fetch = fetchMock as any;
    const provider = makeProvider(
      new Config({
        agents: { defaults: { provider: "custom", model: "custom/my-model" } },
        providers: { custom: { apiKey: "key", apiBase: "https://llm.example/v1", extraBody: { user: "u1" } } },
      }),
    ) as OpenAICompatProvider;

    await provider.chat({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "noop", parameters: {} } }],
      maxTokens: 123,
      temperature: 0.1,
    });

    expect(calls[0].url).toBe("https://llm.example/v1/chat/completions");
    expect(calls[0].body).toMatchObject({
      user: "u1",
      model: "custom/my-model",
      max_tokens: 123,
      temperature: 0.1,
    });
    expect(calls[0].body.tools[0].function.name).toBe("noop");
  });

  it("normalizes nullable tool parameter types for Qianfan chat completions", () => {
    const provider = providerFor("qianfan", "ernie-x1.1");
    const tool = {
      type: "function",
      function: {
        name: "complete_goal",
        description: "End bookkeeping for the active sustained goal.",
        parameters: {
          type: "object",
          properties: {
            recap: { type: ["string", "null"], maxLength: 8000 },
            ids: { type: "array", items: { type: ["string", "null"] } },
          },
        },
      },
    };

    const kwargs = provider.buildKwargs({
      messages: [{ role: "user", content: "hi" }],
      tools: [tool],
      model: "ernie-x1.1",
    });

    const parameters = kwargs.tools[0].function.parameters;
    expect(parameters.properties.recap).toEqual({ type: "string", nullable: true, maxLength: 8000 });
    expect(parameters.properties.ids.items).toEqual({ type: "string", nullable: true });
    expect(tool.function.parameters.properties.recap.type).toEqual(["string", "null"]);
  });

  it("uses Responses API for direct OpenAI GPT-5 and falls back on compatibility errors", async () => {
    const provider = new OpenAICompatProvider({ apiKey: "sk-test", defaultModel: "gpt-5-chat", spec: findByName("openai") });
    const responsesCreate = vi.fn(async () => ({
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "from responses" }] }],
      status: "completed",
    }));
    const chatCreate = vi.fn(async () => ({ choices: [{ message: { content: "from chat" }, finish_reason: "stop" }] }));
    provider.client = { responses: { create: responsesCreate }, chat: { completions: { create: chatCreate } } };

    const response = await provider.chat({ messages: [{ role: "user", content: "hello" }], model: "gpt-5-chat" });

    expect(response.content).toBe("from responses");
    expect(responsesCreate).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-5-chat", max_output_tokens: 4096 }));
    expect(chatCreate).not.toHaveBeenCalled();

    const fallback = new OpenAICompatProvider({ apiKey: "sk-test", defaultModel: "gpt-5-chat", spec: findByName("openai") });
    const err: any = new Error("Responses endpoint not supported");
    err.statusCode = 404;
    err.response = { statusCode: 404, text: "Responses endpoint not supported", headers: {} };
    const fallbackResponses = vi.fn(async () => {
      throw err;
    });
    const fallbackChat = vi.fn(async () => ({ choices: [{ message: { content: "from chat" }, finish_reason: "stop" }] }));
    fallback.client = { responses: { create: fallbackResponses }, chat: { completions: { create: fallbackChat } } };

    const fallbackResult = await fallback.chat({ messages: [{ role: "user", content: "hello" }], model: "gpt-5-chat" });

    expect(fallbackResult.content).toBe("from chat");
    expect(fallbackResponses).toHaveBeenCalledOnce();
    expect(fallbackChat).toHaveBeenCalledOnce();
  });

  it("prefers Responses API for direct OpenAI reasoning requests", async () => {
    const provider = providerFor("openai", "gpt-4o");
    const responsesCreate = vi.fn(async () => ({
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "reasoned" }] }],
      status: "completed",
    }));
    const chatCreate = vi.fn(async () => ({ choices: [{ message: { content: "from chat" }, finish_reason: "stop" }] }));
    provider.client = { responses: { create: responsesCreate }, chat: { completions: { create: chatCreate } } };

    await provider.chat({ messages: [{ role: "user", content: "hello" }], model: "gpt-4o", reasoningEffort: "medium" });

    expect(responsesCreate).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-4o",
      reasoning: { effort: "medium" },
      include: ["reasoning.encrypted_content"],
    }));
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it("keeps direct OpenAI GPT-4o and OpenRouter GPT-5 on chat completions", async () => {
    for (const [providerName, model] of [["openai", "gpt-4o"], ["openrouter", "openai/gpt-5"]] as const) {
      const provider = providerFor(providerName, model);
      const responsesCreate = vi.fn(async () => ({ output: [] }));
      const chatCreate = vi.fn(async () => ({ choices: [{ message: { content: "from chat" }, finish_reason: "stop" }] }));
      provider.client = { responses: { create: responsesCreate }, chat: { completions: { create: chatCreate } } };

      await provider.chat({ messages: [{ role: "user", content: "hello" }], model });

      expect(chatCreate).toHaveBeenCalledOnce();
      expect(responsesCreate).not.toHaveBeenCalled();
    }
  });

  it("skips Responses API while the compatibility circuit is open", async () => {
    const provider = new OpenAICompatProvider({ apiKey: "sk-test", defaultModel: "gpt-5-chat", spec: findByName("openai") });
    const responsesCreate = vi.fn(async () => ({
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "from responses" }] }],
      status: "completed",
    }));
    const chatCreate = vi.fn(async () => ({ choices: [{ message: { content: "from chat" }, finish_reason: "stop" }] }));
    provider.client = { responses: { create: responsesCreate }, chat: { completions: { create: chatCreate } } };
    for (let i = 0; i < 3; i += 1) provider.recordResponsesFailure("gpt-5-chat", null);

    const result = await provider.chat({ messages: [{ role: "user", content: "hello" }], model: "gpt-5-chat" });

    expect(result.content).toBe("from chat");
    expect(responsesCreate).not.toHaveBeenCalled();
    expect(chatCreate).toHaveBeenCalledOnce();
  });

  it("does not fall back from Responses API rate limits", async () => {
    const provider = providerFor("openai", "gpt-5-chat");
    const err: any = new Error("rate limit");
    err.statusCode = 429;
    err.response = { statusCode: 429, text: "rate limit", headers: {} };
    const responsesCreate = vi.fn(async () => {
      throw err;
    });
    const chatCreate = vi.fn(async () => ({ choices: [{ message: { content: "from chat" }, finish_reason: "stop" }] }));
    provider.client = { responses: { create: responsesCreate }, chat: { completions: { create: chatCreate } } };

    const result = await provider.chat({ messages: [{ role: "user", content: "hello" }], model: "gpt-5-chat" });

    expect(result.finishReason).toBe("error");
    expect(responsesCreate).toHaveBeenCalledOnce();
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it("marks OpenRouter spec as a gateway", () => {
    expect(findByName("openrouter")).toMatchObject({ isGateway: true, defaultApiBase: "https://openrouter.ai/api/v1" });
  });

  it("marks Novita spec as an OpenAI-compatible gateway", () => {
    expect(findByName("novita")).toMatchObject({
      isGateway: true,
      backend: "openai_compat",
      envKey: "NOVITA_API_KEY",
      defaultApiBase: "https://api.novita.ai/openai",
    });
  });

  it("routes Gemma models to the Gemini provider spec", () => {
    expect(findByName("gemini")?.keywords).toContain("gemma");
  });

  it("keeps Gemini OpenAI-compatible base URL", () => {
    expect(findByName("gemini")?.defaultApiBase).toBe("https://generativelanguage.googleapis.com/v1beta/openai/");
  });

  it("sets default OpenRouter attribution headers", () => {
    const provider = providerFor("openrouter", "anthropic/claude-sonnet-4-5", { apiBase: "https://openrouter.ai/api/v1" });

    expect(provider.defaultHeaders["HTTP-Referer"]).toBe("https://github.com/MemTensor/memmy-agent");
    expect(provider.defaultHeaders["X-OpenRouter-Title"]).toBe("Memmy Agent");
    expect(provider.defaultHeaders["X-OpenRouter-Categories"]).toBe("personal-agent,cli-agent");
    expect(provider.defaultHeaders["x-session-affinity"]).toBeTruthy();
  });

  it("lets user OpenRouter headers override default attribution", () => {
    const provider = providerFor("openrouter", "anthropic/claude-sonnet-4-5", {
      apiBase: "https://openrouter.ai/api/v1",
      extraHeaders: {
        "HTTP-Referer": "https://memmy-agent.local",
        "X-OpenRouter-Title": "Memmy Pro",
        "X-Custom-App": "enabled",
      },
    });

    expect(provider.defaultHeaders["HTTP-Referer"]).toBe("https://memmy-agent.local");
    expect(provider.defaultHeaders["X-OpenRouter-Title"]).toBe("Memmy Pro");
    expect(provider.defaultHeaders["X-OpenRouter-Categories"]).toBe("personal-agent,cli-agent");
    expect(provider.defaultHeaders["X-Custom-App"]).toBe("enabled");
  });

  it("keeps OpenRouter model names intact", () => {
    expect(providerFor("openrouter", "anthropic/claude-sonnet-4-5").buildKwargs({
      messages: [{ role: "user", content: "hello" }],
      model: "anthropic/claude-sonnet-4-5",
    }).model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("strips AiHubMix provider prefixes from model names", () => {
    expect(providerFor("aihubmix", "claude-sonnet-4-5").buildKwargs({
      messages: [{ role: "user", content: "hello" }],
      model: "anthropic/claude-sonnet-4-5",
    }).model).toBe("claude-sonnet-4-5");
  });

  it("passes standard provider model names through unchanged", () => {
    expect(providerFor("deepseek", "deepseek-chat").buildKwargs({
      messages: [{ role: "user", content: "hello" }],
      model: "deepseek-chat",
    }).model).toBe("deepseek-chat");
  });

  it("passes OpenAI default model through unchanged", () => {
    expect(providerFor("openai", "gpt-4o").getDefaultModel()).toBe("gpt-4o");
  });

  it("uses Responses API for direct OpenAI GPT-5", async () => {
    const provider = providerFor("openai", "gpt-5-chat");
    const responsesCreate = vi.fn(async () => ({
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "from responses" }] }],
      status: "completed",
    }));
    const chatCreate = vi.fn(async () => ({ choices: [{ message: { content: "from chat" }, finish_reason: "stop" }] }));
    provider.client = { responses: { create: responsesCreate }, chat: { completions: { create: chatCreate } } };

    const response = await provider.chat({ messages: [{ role: "user", content: "hello" }], model: "gpt-5-chat" });

    expect(response.content).toBe("from responses");
    expect(responsesCreate).toHaveBeenCalledOnce();
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it("falls back from direct OpenAI Responses 404 to chat completions", async () => {
    const provider = providerFor("openai", "gpt-5-chat");
    const err: any = new Error("Responses endpoint not supported");
    err.statusCode = 404;
    err.response = { statusCode: 404, text: "Responses endpoint not supported", headers: {} };
    const responsesCreate = vi.fn(async () => {
      throw err;
    });
    const chatCreate = vi.fn(async () => ({ choices: [{ message: { content: "from chat" }, finish_reason: "stop" }] }));
    provider.client = { responses: { create: responsesCreate }, chat: { completions: { create: chatCreate } } };

    const response = await provider.chat({ messages: [{ role: "user", content: "hello" }], model: "gpt-5-chat" });

    expect(response.content).toBe("from chat");
    expect(responsesCreate).toHaveBeenCalledOnce();
    expect(chatCreate).toHaveBeenCalledOnce();
  });

  it("keeps direct OpenAI GPT-4o on chat completions", async () => {
    const provider = providerFor("openai", "gpt-4o");
    const responsesCreate = vi.fn(async () => ({ output: [] }));
    const chatCreate = vi.fn(async () => ({ choices: [{ message: { content: "from chat" }, finish_reason: "stop" }] }));
    provider.client = { responses: { create: responsesCreate }, chat: { completions: { create: chatCreate } } };

    await provider.chat({ messages: [{ role: "user", content: "hello" }], model: "gpt-4o" });

    expect(chatCreate).toHaveBeenCalledOnce();
    expect(responsesCreate).not.toHaveBeenCalled();
  });

  it("keeps OpenRouter GPT-5 on chat completions", async () => {
    const provider = providerFor("openrouter", "openai/gpt-5");
    const responsesCreate = vi.fn(async () => ({ output: [] }));
    const chatCreate = vi.fn(async () => ({ choices: [{ message: { content: "from chat" }, finish_reason: "stop" }] }));
    provider.client = { responses: { create: responsesCreate }, chat: { completions: { create: chatCreate } } };

    await provider.chat({ messages: [{ role: "user", content: "hello" }], model: "openai/gpt-5" });

    expect(chatCreate).toHaveBeenCalledOnce();
    expect(responsesCreate).not.toHaveBeenCalled();
  });

  it("builds provider-specific thinking kwargs and GPT-5 safe token parameters", () => {
    const openai = new OpenAICompatProvider({ apiKey: "sk", defaultModel: "gpt-5-chat", spec: findByName("openai") });
    expect(
      openai.buildKwargs({
        messages: [{ role: "user", content: "hi" }],
        model: "gpt-5-chat",
        maxTokens: 1024,
        temperature: 0.7,
      }),
    ).toMatchObject({ model: "gpt-5-chat", max_completion_tokens: 1024 });
    expect(openai.buildKwargs({ messages: [{ role: "user", content: "hi" }], model: "gpt-5-chat" })).not.toHaveProperty("temperature");

    const dashscope = new OpenAICompatProvider({ apiKey: "sk", defaultModel: "qwen3-plus", spec: findByName("dashscope") });
    expect(
      dashscope.buildKwargs({
        messages: [{ role: "user", content: "hi" }],
        model: "qwen3-plus",
        reasoningEffort: "minimal",
      }),
    ).toMatchObject({ reasoning_effort: "minimum", extra_body: { enable_thinking: false } });

    const openrouter = new OpenAICompatProvider({ apiKey: "sk", defaultModel: "moonshotai/kimi-k2.6", spec: findByName("openrouter") });
    expect(
      openrouter.buildKwargs({
        messages: [{ role: "user", content: "hi" }],
        model: "moonshotai/kimi-k2.6",
        reasoningEffort: "medium",
      }).extra_body,
    ).toEqual({ thinking: { type: "enabled" }, reasoning: { effort: "medium" } });
  });

  it("keeps image tool results out of OpenAI-compatible tool message content", () => {
    const dashscope = providerFor("dashscope", "qwen3-plus");

    const kwargs = dashscope.buildKwargs({
      messages: [
        { role: "user", content: "describe image" },
        { role: "assistant", content: null, tool_calls: [toolCall("tc_img"), toolCall("tc_img_2")] },
        {
          role: "tool",
          tool_call_id: "tc_img",
          name: "read_file",
          content: [
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,abc" },
              meta: { path: "/tmp/photo.png" },
            },
            { type: "text", text: "(Image file: /tmp/photo.png)" },
          ],
        },
        {
          role: "tool",
          tool_call_id: "tc_img_2",
          name: "read_file",
          content: [
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,def" },
              meta: { path: "/tmp/second.png" },
            },
            { type: "text", text: "(Image file: /tmp/second.png)" },
          ],
        },
      ],
      model: "qwen3-plus",
    });

    const toolMessages = kwargs.messages.filter((message: any) => message.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0].content).toContain("(Image file: /tmp/photo.png)");
    expect(toolMessages[1].content).toContain("(Image file: /tmp/second.png)");
    expect(toolMessages[0].content).toContain("image attachment");
    expect(toolMessages[1].content).toContain("image attachment");
    expect(toolMessages.map((message: any) => message.content).join("\n")).not.toContain("[object Object]");

    const imageUserMessage = kwargs.messages.find((message: any) =>
      message.role === "user" &&
      Array.isArray(message.content) &&
      message.content.some((block: any) => block.type === "image_url"),
    );
    expect(imageUserMessage).toBeTruthy();
    expect(imageUserMessage.content.filter((block: any) => block.type === "image_url")).toEqual([
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,abc" },
      },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,def" },
      },
    ]);
  });

  it("matches OpenAI temperature and token parameter rules", () => {
    expect(OpenAICompatProvider.supportsTemperature("gpt-4o")).toBe(true);
    expect(OpenAICompatProvider.supportsTemperature("gpt-5-chat")).toBe(false);
    expect(OpenAICompatProvider.supportsTemperature("o3-mini")).toBe(false);
    expect(OpenAICompatProvider.supportsTemperature("gpt-4o", "medium")).toBe(false);
    expect(OpenAICompatProvider.supportsTemperature("kimi-k2.5")).toBe(false);
    expect(OpenAICompatProvider.supportsTemperature("moonshotai/kimi-k2.6")).toBe(false);

    const kwargs = providerFor("openai", "gpt-5-chat").buildKwargs({
      messages: [{ role: "user", content: "hello" }],
      model: "gpt-5-chat",
      maxTokens: 4096,
      temperature: 0.7,
    });
    expect(kwargs.max_completion_tokens).toBe(4096);
    expect(kwargs).not.toHaveProperty("max_tokens");
    expect(kwargs).not.toHaveProperty("temperature");
  });

  it("sanitizes OpenAI-compatible tool history for strict providers", () => {
    const mistral = new OpenAICompatProvider({ spec: findByName("mistral") });
    const sanitized = mistral.sanitizeMessages([
      { role: "user", content: "check both files" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_function_akxp3wqzn7ph_1", type: "function", function: { name: "read_file", arguments: "{'path': 'a.txt'}" } },
          { id: "call_function_akxp3wqzn7ph_1", type: "function", function: { name: "read_file", arguments: { path: "b.txt" } } },
        ],
      },
      { role: "tool", tool_call_id: "call_function_akxp3wqzn7ph_1", name: "read_file", content: "a" },
      { role: "tool", tool_call_id: "call_function_akxp3wqzn7ph_1", name: "read_file", content: "b" },
      { role: "user", content: "continue" },
    ]);

    expect(sanitized[1].tool_calls[0].id).toBe("3ec83c30d");
    expect(sanitized[1].tool_calls[1].id).not.toBe("3ec83c30d");
    expect(sanitized[1].tool_calls[0].function.arguments).toBe('{"path":"a.txt"}');
    expect(sanitized[1].tool_calls[1].function.arguments).toBe('{"path":"b.txt"}');
    expect([sanitized[2].tool_call_id, sanitized[3].tool_call_id]).toEqual([
      sanitized[1].tool_calls[0].id,
      sanitized[1].tool_calls[1].id,
    ]);
  });

  it("preserves visible content and tool-call reasoning extras", () => {
    const provider = new OpenAICompatProvider();
    const sanitized = provider.sanitizeMessages([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "done",
        reasoning_content: "hidden",
        extra_content: { debug: true },
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "fn", arguments: "{}" },
            extra_content: { google: { thought_signature: "sig" } },
          },
        ],
      },
      { role: "user", content: "thanks" },
    ]);

    expect(sanitized[1].content).toBe("done");
    expect(sanitized[1].reasoning_content).toBe("hidden");
    expect(sanitized[1].extra_content).toEqual({ debug: true });
    expect(sanitized[1].tool_calls[0].extra_content).toEqual({ google: { thought_signature: "sig" } });
  });

  it("preserves Gemini extra_content on parsed tool calls", () => {
    const provider = providerFor("gemini", "google/gemini-3.1-pro-preview");
    const result = provider.parseResponse({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_123",
                index: 0,
                type: "function",
                function: {
                  name: "exec",
                  arguments: '{"cmd":"ls"}',
                  provider_specific_fields: { inner: "value" },
                },
                extra_content: { google: { thought_signature: "signed-token" } },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    expect(result.toolCalls[0].extraContent).toEqual({ google: { thought_signature: "signed-token" } });
    expect(result.toolCalls[0].functionProviderSpecificFields).toEqual({ inner: "value" });
    expect(result.toolCalls[0].toOpenAIToolCall()).toMatchObject({
      extra_content: { google: { thought_signature: "signed-token" } },
      function: { provider_specific_fields: { inner: "value" } },
    });
  });

  it("coerces DeepSeek content and backfills thinking history when required", () => {
    const provider = new OpenAICompatProvider({ apiKey: "sk", defaultModel: "deepseek-v4-pro", spec: findByName("deepseek") });
    const kwargs = provider.buildKwargs({
      messages: [
        { role: "user", content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] },
        { role: "assistant", content: "", tool_calls: [{ id: "tc1", type: "function", function: { name: "web_search", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "tc1", content: "result" },
        { role: "user", content: "continue" },
      ],
      model: "deepseek-v4-pro",
      reasoningEffort: "high",
    });

    expect(kwargs.messages[0].content).toBe("hello world");
    expect(kwargs.messages[1].reasoning_content).toBe("");
    expect(kwargs.extra_body).toEqual({ thinking: { type: "enabled" } });
  });

  it("preserves and backfills DeepSeek reasoning history according to thinking mode", () => {
    const withMissing = providerFor("deepseek", "deepseek-v4-pro").buildKwargs({
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "can we use wechat?" },
        { role: "assistant", content: "", tool_calls: [toolCall("call_bad")] },
        { role: "tool", tool_call_id: "call_bad", name: "my", content: "channels" },
        { role: "user", content: "continue" },
      ],
      model: "deepseek-v4-pro",
      maxTokens: 1024,
      temperature: 0.7,
      reasoningEffort: "high",
    });
    expect(withMissing.messages.map((message: any) => message.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
    expect(withMissing.messages[2].reasoning_content).toBe("");

    const withExisting = providerFor("deepseek", "deepseek-v4-pro").buildKwargs({
      messages: [
        { role: "user", content: "can we use wechat?" },
        { role: "assistant", content: "", reasoning_content: "I should inspect channels.", tool_calls: [toolCall("call_good")] },
        { role: "tool", tool_call_id: "call_good", name: "my", content: "channels" },
        { role: "user", content: "continue" },
      ],
      model: "deepseek-v4-pro",
      maxTokens: 1024,
      temperature: 0.7,
      reasoningEffort: "high",
    });
    expect(withExisting.messages[1].reasoning_content).toBe("I should inspect channels.");

    const thinkingOff = providerFor("deepseek", "deepseek-v4-pro").buildKwargs({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", tool_calls: [toolCall("tc1")] },
        { role: "tool", tool_call_id: "tc1", content: "result" },
        { role: "user", content: "thanks" },
      ],
      model: "deepseek-v4-pro",
      maxTokens: 1024,
      temperature: 0.7,
      reasoningEffort: "minimal",
    });
    expect(thinkingOff.messages[1]).not.toHaveProperty("reasoning_content");
  });

  it("keeps DeepSeek and non-DeepSeek content coercion rules separate", () => {
    const content = [{ type: "text", text: "hello " }, { type: "text", text: "world" }];
    const deepseek = providerFor("deepseek", "deepseek-chat").buildKwargs({
      messages: [{ role: "user", content }],
      model: "deepseek-chat",
      maxTokens: 1024,
      temperature: 0.7,
      reasoningEffort: null,
    });
    const openai = providerFor("openai", "gpt-4o").buildKwargs({
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      model: "gpt-4o",
      maxTokens: 1024,
      temperature: 0.7,
      reasoningEffort: null,
    });

    expect(deepseek.messages[0].content).toBe("hello world");
    expect(Array.isArray(openai.messages[0].content)).toBe(true);
  });

  it("normalizes tool-call ids and arguments in sanitized history", () => {
    const defaultProvider = new OpenAICompatProvider();
    const duplicate = defaultProvider.sanitizeMessages([
      { role: "user", content: "check both files" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "ab1b45c2a", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
          { id: "ab1b45c2a", type: "function", function: { name: "read_file", arguments: '{"path":"b.txt"}' } },
        ],
      },
      { role: "tool", tool_call_id: "ab1b45c2a", name: "read_file", content: "a" },
      { role: "tool", tool_call_id: "ab1b45c2a", name: "read_file", content: "b" },
      { role: "user", content: "continue" },
    ]);
    expect(duplicate[1].tool_calls.map((tc: any) => tc.id)).toHaveLength(new Set(duplicate[1].tool_calls.map((tc: any) => tc.id)).size);
    expect([duplicate[2].tool_call_id, duplicate[3].tool_call_id]).toEqual(duplicate[1].tool_calls.map((tc: any) => tc.id));

    const repairedArgs = defaultProvider.sanitizeMessages([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "exec", arguments: "{'cmd': 'pwd'}" } },
          { id: "call_2", type: "function", function: { name: "exec" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", name: "exec", content: "ok" },
      { role: "tool", tool_call_id: "call_2", name: "exec", content: "ok" },
      { role: "user", content: "done" },
    ]);
    expect(repairedArgs[1].tool_calls[0].function.arguments).toBe('{"cmd":"pwd"}');
    expect(repairedArgs[1].tool_calls[1].function.arguments).toBe("{}");
  });

  it("applies provider-specific thinking extra bodies", () => {
    expect(buildKwargsFor("dashscope", "qwen3-plus", "medium").extra_body).toEqual({ enable_thinking: true });
    expect(buildKwargsFor("dashscope", "qwen3-plus", "minimal")).toMatchObject({
      reasoning_effort: "minimum",
      extra_body: { enable_thinking: false },
    });
    expect(buildKwargsFor("dashscope", "qwen3-plus", "minimum")).toMatchObject({
      reasoning_effort: "minimum",
      extra_body: { enable_thinking: false },
    });
    expect(buildKwargsFor("dashscope", "qwen-turbo", null)).not.toHaveProperty("extra_body");
    expect(buildKwargsFor("minimax", "MiniMax-M2.7", "medium").extra_body).toEqual({ reasoning_split: true });
    expect(buildKwargsFor("minimax", "MiniMax-M2.7", "minimal").extra_body).toEqual({ reasoning_split: false });
    expect(buildKwargsFor("minimax", "MiniMax-M2.7", null)).not.toHaveProperty("extra_body");
    expect(buildKwargsFor("volcengine", "doubao-seed-2-0-pro", "high").extra_body).toEqual({ thinking: { type: "enabled" } });
    expect(buildKwargsFor("volcengine", "doubao-seed-2-0-pro").max_completion_tokens).toBe(1024);
    expect(buildKwargsFor("volcengine_coding_plan", "doubao-seed-2-0-pro").max_completion_tokens).toBe(1024);
    expect(buildKwargsFor("byteplus", "doubao-seed-2-0-pro", "minimal").extra_body).toEqual({ thinking: { type: "disabled" } });
    expect(buildKwargsFor("byteplus", "doubao-seed-2-0-pro", null)).not.toHaveProperty("extra_body");
    expect(buildKwargsFor("deepseek", "deepseek-v4-pro", "high").extra_body).toEqual({ thinking: { type: "enabled" } });
    expect(buildKwargsFor("deepseek", "deepseek-v4-pro", "minimal").extra_body).toEqual({ thinking: { type: "disabled" } });
    expect(buildKwargsFor("deepseek", "deepseek-chat", null)).not.toHaveProperty("extra_body");
    expect(buildKwargsFor("openai", "gpt-4o", "medium")).not.toHaveProperty("extra_body");
  });

  it("applies Kimi thinking and reasoning-effort rules", () => {
    expect(buildKwargsFor("moonshot", "kimi-k2.5", "medium")).toMatchObject({ extra_body: { thinking: { type: "enabled" } } });
    expect(buildKwargsFor("moonshot", "kimi-k2.5", "medium")).not.toHaveProperty("reasoning_effort");
    expect(buildKwargsFor("moonshot", "kimi-k2.5", "minimal")).toMatchObject({ extra_body: { thinking: { type: "disabled" } } });
    expect(buildKwargsFor("moonshot", "kimi-k2.5", null)).not.toHaveProperty("extra_body");
    expect(buildKwargsFor("openrouter", "moonshotai/kimi-k2.5", "medium").extra_body).toEqual({
      thinking: { type: "enabled" },
      reasoning: { effort: "medium" },
    });
    expect(buildKwargsFor("moonshot", "kimi-k2.6", "medium").extra_body).toEqual({ thinking: { type: "enabled" } });
    expect(buildKwargsFor("openrouter", "moonshotai/kimi-k2.6", "medium").extra_body).toEqual({
      thinking: { type: "enabled" },
      reasoning: { effort: "medium" },
    });
    expect(buildKwargsFor("moonshot", "kimi-k2.6", null)).not.toHaveProperty("temperature");
    expect(buildKwargsFor("openrouter", "moonshotai/kimi-k2.5", null)).not.toHaveProperty("extra_body");
    expect(buildKwargsFor("moonshot", "k2.6-code-preview", "high").extra_body).toEqual({ thinking: { type: "enabled" } });
    expect(buildKwargsFor("moonshot", "k2.6-code-preview", null)).not.toHaveProperty("temperature");
    expect(buildKwargsFor("moonshot", "kimi-k2", "high")).not.toHaveProperty("extra_body");
    expect(buildKwargsFor("moonshot", "kimi-k2-thinking", "high")).not.toHaveProperty("extra_body");
  });

  it("treats reasoning_effort none as thinking disabled", () => {
    const deepseek = buildKwargsFor("deepseek", "deepseek-v4-pro", "none");
    expect(deepseek.extra_body).toEqual({ thinking: { type: "disabled" } });
    expect(deepseek).not.toHaveProperty("reasoning_effort");

    const kimi = buildKwargsFor("moonshot", "kimi-k2.5", "none");
    expect(kimi.extra_body).toEqual({ thinking: { type: "disabled" } });
    expect(kimi).not.toHaveProperty("reasoning_effort");

    const dashscope = buildKwargsFor("dashscope", "qwen3.6-plus", "none");
    expect(dashscope.extra_body).toEqual({ enable_thinking: false });
    expect(dashscope).not.toHaveProperty("reasoning_effort");

    const kw = providerFor("deepseek", "deepseek-v4-pro").buildKwargs({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "continue" },
      ],
      model: "deepseek-v4-pro",
      maxTokens: 1024,
      temperature: 0.7,
      reasoningEffort: "none",
    });
    expect(kw.messages[1]).not.toHaveProperty("reasoning_content");
  });

  it("applies memmy account reasoning none thinking controls by model family", () => {
    const agentChat = buildKwargsFor("memmy_account", "agent_chat", "none");
    expect(agentChat.extra_body).toEqual({ enable_thinking: false });
    expect(agentChat.max_tokens).toBe(1024);
    expect(agentChat).not.toHaveProperty("max_completion_tokens");
    expect(agentChat).not.toHaveProperty("reasoning_effort");

    expect(buildKwargsFor("memmy_account", "qwen3-plus", "none").extra_body).toEqual({ enable_thinking: false });
    expect(buildKwargsFor("memmy_account", "deepseek-v4-pro", "none").extra_body).toEqual({ thinking: { type: "disabled" } });
    expect(buildKwargsFor("memmy_account", "glm-4.7", "none").extra_body).toEqual({ thinking: { type: "disabled" } });
    expect(buildKwargsFor("memmy_account", "kimi-k2.6", "none").extra_body).toEqual({ thinking: { type: "disabled" } });
    expect(buildKwargsFor("memmy_account", "minimax-m3", "none").extra_body).toEqual({ thinking: { type: "disabled" } });
    expect(buildKwargsFor("memmy_account", "mimo-v2.5-pro", "none").extra_body).toEqual({ thinking: { type: "disabled" } });

    expect(buildKwargsFor("memmy_account", "generic-chat-model", "none")).not.toHaveProperty("extra_body");
    expect(buildKwargsFor("memmy_account", "agent_chat", null)).not.toHaveProperty("extra_body");
    expect(buildKwargsFor("openai", "agent_chat", "none")).not.toHaveProperty("extra_body");
  });

  it("enables DashScope thinking with reasoning effort", () => {
    expect(buildKwargsFor("dashscope", "qwen3-plus", "medium").extra_body).toEqual({ enable_thinking: true });
  });

  it("disables DashScope thinking for minimal", () => {
    expect(buildKwargsFor("dashscope", "qwen3-plus", "minimal")).toMatchObject({
      reasoning_effort: "minimum",
      extra_body: { enable_thinking: false },
    });
  });

  it("disables DashScope thinking for minimum alias", () => {
    expect(buildKwargsFor("dashscope", "qwen3-plus", "minimum")).toMatchObject({
      reasoning_effort: "minimum",
      extra_body: { enable_thinking: false },
    });
  });

  it("keeps minimal reasoning spelling for non-DashScope providers", () => {
    expect(buildKwargsFor("openai", "gpt-5", "minimal").reasoning_effort).toBe("minimal");
  });

  it("omits DashScope extra body when reasoning effort is absent", () => {
    expect(buildKwargsFor("dashscope", "qwen-turbo", null)).not.toHaveProperty("extra_body");
  });

  it("enables MiniMax reasoning split with reasoning effort", () => {
    expect(buildKwargsFor("minimax", "MiniMax-M2.7", "medium").extra_body).toEqual({ reasoning_split: true });
  });

  it("disables MiniMax reasoning split for minimal", () => {
    expect(buildKwargsFor("minimax", "MiniMax-M2.7", "minimal").extra_body).toEqual({ reasoning_split: false });
  });

  it("omits MiniMax extra body when reasoning effort is absent", () => {
    expect(buildKwargsFor("minimax", "MiniMax-M2.7", null)).not.toHaveProperty("extra_body");
  });

  it("enables VolcEngine thinking and max_completion_tokens", () => {
    const kwargs = buildKwargsFor("volcengine", "doubao-seed-2-0-pro", "high");
    expect(kwargs.extra_body).toEqual({ thinking: { type: "enabled" } });
    expect(buildKwargsFor("volcengine", "doubao-seed-2-0-pro").max_completion_tokens).toBe(1024);
  });

  it("uses max_completion_tokens for VolcEngine coding plan", () => {
    const kwargs = buildKwargsFor("volcengine_coding_plan", "doubao-seed-2-0-pro");
    expect(kwargs.max_completion_tokens).toBe(1024);
    expect(kwargs).not.toHaveProperty("max_tokens");
  });

  it("disables BytePlus thinking for minimal", () => {
    expect(buildKwargsFor("byteplus", "doubao-seed-2-0-pro", "minimal").extra_body).toEqual({ thinking: { type: "disabled" } });
  });

  it("omits BytePlus extra body when reasoning effort is absent", () => {
    expect(buildKwargsFor("byteplus", "doubao-seed-2-0-pro", null)).not.toHaveProperty("extra_body");
  });

  it("enables DeepSeek thinking with reasoning effort", () => {
    expect(buildKwargsFor("deepseek", "deepseek-v4-pro", "high").extra_body).toEqual({ thinking: { type: "enabled" } });
  });

  it("disables DeepSeek thinking for minimal", () => {
    expect(buildKwargsFor("deepseek", "deepseek-v4-pro", "minimal").extra_body).toEqual({ thinking: { type: "disabled" } });
  });

  it("omits DeepSeek extra body when reasoning effort is absent", () => {
    expect(buildKwargsFor("deepseek", "deepseek-chat", null)).not.toHaveProperty("extra_body");
  });

  it("does not inject OpenAI thinking extra body", () => {
    expect(buildKwargsFor("openai", "gpt-4o", "medium")).not.toHaveProperty("extra_body");
  });

  it("enables Kimi k2.5 thinking and drops reasoning_effort", () => {
    const kwargs = buildKwargsFor("moonshot", "kimi-k2.5", "medium");
    expect(kwargs.extra_body).toEqual({ thinking: { type: "enabled" } });
    expect(kwargs).not.toHaveProperty("reasoning_effort");
  });

  it("disables Kimi k2.5 thinking for minimal", () => {
    const kwargs = buildKwargsFor("moonshot", "kimi-k2.5", "minimal");
    expect(kwargs.extra_body).toEqual({ thinking: { type: "disabled" } });
    expect(kwargs).not.toHaveProperty("reasoning_effort");
  });

  it("omits Kimi k2.5 extra body when reasoning effort is absent", () => {
    expect(buildKwargsFor("moonshot", "kimi-k2.5", null)).not.toHaveProperty("extra_body");
  });

  it("enables Kimi k2.5 thinking through OpenRouter prefix", () => {
    const kwargs = buildKwargsFor("openrouter", "moonshotai/kimi-k2.5", "medium");
    expect(kwargs.extra_body).toEqual({ thinking: { type: "enabled" }, reasoning: { effort: "medium" } });
    expect(kwargs).not.toHaveProperty("reasoning_effort");
  });

  it("enables Kimi k2.6 thinking and omits immutable temperature", () => {
    expect(buildKwargsFor("moonshot", "kimi-k2.6", "medium").extra_body).toEqual({ thinking: { type: "enabled" } });
    expect(buildKwargsFor("moonshot", "kimi-k2.6", null)).not.toHaveProperty("temperature");
  });

  it("enables Kimi k2.6 thinking through OpenRouter prefix", () => {
    const kwargs = buildKwargsFor("openrouter", "moonshotai/kimi-k2.6", "medium");
    expect(kwargs.extra_body).toEqual({ thinking: { type: "enabled" }, reasoning: { effort: "medium" } });
    expect(kwargs).not.toHaveProperty("reasoning_effort");
  });

  it("does not enable OpenRouter Kimi thinking without reasoning effort", () => {
    expect(buildKwargsFor("openrouter", "moonshotai/kimi-k2.5", null)).not.toHaveProperty("extra_body");
  });

  it("enables Kimi k2.6 code preview thinking", () => {
    const kwargs = buildKwargsFor("moonshot", "k2.6-code-preview", "high");
    expect(kwargs.extra_body).toEqual({ thinking: { type: "enabled" } });
    expect(kwargs).not.toHaveProperty("reasoning_effort");
  });

  it("does not inject thinking for non-thinking Kimi k2 series", () => {
    expect(buildKwargsFor("moonshot", "kimi-k2", "high")).not.toHaveProperty("extra_body");
  });

  it("does not inject thinking for Kimi k2-thinking series", () => {
    expect(buildKwargsFor("moonshot", "kimi-k2-thinking", "high")).not.toHaveProperty("extra_body");
  });

  it("disables DeepSeek thinking for none string", () => {
    const kwargs = buildKwargsFor("deepseek", "deepseek-v4-pro", "none");
    expect(kwargs.extra_body).toEqual({ thinking: { type: "disabled" } });
    expect(kwargs).not.toHaveProperty("reasoning_effort");
  });

  it("disables Kimi k2.5 thinking for none string", () => {
    const kwargs = buildKwargsFor("moonshot", "kimi-k2.5", "none");
    expect(kwargs.extra_body).toEqual({ thinking: { type: "disabled" } });
    expect(kwargs).not.toHaveProperty("reasoning_effort");
  });

  it("disables DashScope thinking for none string", () => {
    const kwargs = buildKwargsFor("dashscope", "qwen3.6-plus", "none");
    expect(kwargs.extra_body).toEqual({ enable_thinking: false });
    expect(kwargs).not.toHaveProperty("reasoning_effort");
  });

  it("does not backfill DeepSeek reasoning when effort is none string", () => {
    const kwargs = providerFor("deepseek", "deepseek-v4-pro").buildKwargs({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "continue" },
      ],
      model: "deepseek-v4-pro",
      maxTokens: 1024,
      temperature: 0.7,
      reasoningEffort: "none",
    });
    expect(kwargs.messages[1]).not.toHaveProperty("reasoning_content");
  });

  it("backfills DeepSeek V4 reasoning history when effort is implicit", () => {
    const kwargs = providerFor("deepseek", "deepseek-v4-pro").buildKwargs({
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "", tool_calls: [toolCall("tc1")] },
        { role: "tool", tool_call_id: "tc1", content: "result" },
        { role: "user", content: "thanks" },
      ],
      model: "deepseek-v4-pro",
      maxTokens: 1024,
      temperature: 0.7,
      reasoningEffort: null,
    });

    expect(kwargs.messages.map((message: any) => message.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
    expect(kwargs.messages[2].reasoning_content).toBe("");
    expect(kwargs.messages.at(-1).content).toBe("thanks");
  });

  it("keeps DeepSeek chat tool history untouched when effort is implicit", () => {
    const kwargs = providerFor("deepseek", "deepseek-chat").buildKwargs({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", tool_calls: [toolCall("tc1")] },
        { role: "tool", tool_call_id: "tc1", content: "result" },
        { role: "user", content: "thanks" },
      ],
      model: "deepseek-chat",
      maxTokens: 1024,
      temperature: 0.7,
      reasoningEffort: null,
    });

    expect(kwargs.messages.map((message: any) => message.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(kwargs.messages[1].tool_calls).toHaveLength(1);
    expect(kwargs.messages[1]).not.toHaveProperty("reasoning_content");
  });

  it("does not replay hidden reasoning in OpenAI-compatible tool-call history", () => {
    const sanitized = new OpenAICompatProvider().sanitizeMessages([
      { role: "user", content: "不错" },
      { role: "assistant", content: "对，破 4 万指日可待" },
      {
        role: "assistant",
        content: "<think>我再查一下</think>",
        tool_calls: [{ id: "call_function_akxp3wqzn7ph_1", type: "function", function: { name: "exec", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_function_akxp3wqzn7ph_1", name: "exec", content: "ok" },
      { role: "user", content: "多少star了呢" },
    ]);

    expect(sanitized[1]).toMatchObject({ role: "assistant", content: null });
    expect(sanitized[1].tool_calls[0].id).toBe("call_function_akxp3wqzn7ph_1");
    expect(sanitized[2].tool_call_id).toBe("call_function_akxp3wqzn7ph_1");
  });

  it("preserves visible tool-call content and paired tool results for Chat Completions", () => {
    const kwargs = providerFor("openai", "gpt-4o").buildKwargs({
      messages: [
        { role: "user", content: "读取配置" },
        { role: "assistant", content: "我先读取配置。", tool_calls: [toolCall("call_read")] },
        { role: "tool", tool_call_id: "call_read", name: "my", content: "配置内容" },
        { role: "user", content: "继续" },
      ],
      model: "gpt-4o",
      maxTokens: 1024,
      temperature: 0.7,
      reasoningEffort: null,
    });

    expect(kwargs.messages[1]).toMatchObject({
      role: "assistant",
      content: "我先读取配置。",
      tool_calls: [{ id: "call_read" }],
    });
    expect(kwargs.messages[2]).toMatchObject({
      role: "tool",
      tool_call_id: "call_read",
      content: "配置内容",
    });
  });

  it("normalizes tool-call ids after consecutive assistant messages for Mistral", () => {
    const sanitized = providerFor("mistral", "mistral-large").sanitizeMessages([
      { role: "user", content: "不错" },
      { role: "assistant", content: "对，破 4 万指日可待" },
      {
        role: "assistant",
        content: "我先读取配置。",
        tool_calls: [{ id: "call_function_akxp3wqzn7ph_1", type: "function", function: { name: "exec", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_function_akxp3wqzn7ph_1", name: "exec", content: "ok" },
      { role: "user", content: "多少star了呢" },
    ]);

    expect(sanitized[1]).toMatchObject({ role: "assistant", content: "我先读取配置。" });
    expect(sanitized[1].tool_calls[0].id).toBe("3ec83c30d");
    expect(sanitized[2].tool_call_id).toBe("3ec83c30d");
  });

  it("keeps empty tool-call content null", () => {
    const sanitized = new OpenAICompatProvider().sanitizeMessages([
      { role: "user", content: "读取配置" },
      { role: "assistant", content: "", tool_calls: [toolCall("call_read")] },
      { role: "tool", tool_call_id: "call_read", name: "my", content: "配置内容" },
      { role: "user", content: "继续" },
    ]);

    expect(sanitized[1].content).toBeNull();
  });

  it("stringifies object tool-call arguments", () => {
    const sanitized = new OpenAICompatProvider().sanitizeMessages([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "exec", arguments: { cmd: "ls -la" } } }],
      },
      { role: "tool", tool_call_id: "call_1", name: "exec", content: "ok" },
      { role: "user", content: "done" },
    ]);

    expect(JSON.parse(sanitized[1].tool_calls[0].function.arguments)).toEqual({ cmd: "ls -la" });
  });

  it("streams legacy function_call argument deltas", async () => {
    async function* stream() {
      yield { choices: [{ delta: { function_call: { name: "write_file", arguments: '{"path":"notes.md","content":"' } }, finish_reason: null }] };
      yield { choices: [{ delta: { function_call: { arguments: 'line\\n"}' } }, finish_reason: "tool_calls" }] };
    }
    const provider = providerFor("deepseek", "deepseek-chat");
    provider.client = { chat: { completions: { create: vi.fn(async () => stream()) } }, responses: { create: vi.fn() } };
    const toolDeltas: any[] = [];

    const result = await provider.chatStream({
      messages: [{ role: "user", content: "write" }],
      model: "deepseek-chat",
      onToolCallDelta: (delta) => {
        toolDeltas.push(delta);
      },
    });

    expect(toolDeltas.map((delta) => delta.arguments_delta)).toEqual(['{"path":"notes.md","content":"', 'line\\n"}']);
    expect(result.toolCalls[0]).toMatchObject({ name: "write_file", arguments: { path: "notes.md", content: "line\n" } });
  });

  it("streams direct OpenAI GPT-5 through Responses API", async () => {
    async function* responsesStream() {
      yield { type: "response.output_text.delta", delta: "hi" };
      yield { type: "response.completed", response: { status: "completed", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, output: [] } };
    }
    const provider = providerFor("openai", "gpt-5-chat");
    const responsesCreate = vi.fn(async () => responsesStream());
    const chatCreate = vi.fn(async function* () {
      yield { choices: [{ delta: { content: "chat" }, finish_reason: "stop" }] };
    });
    provider.client = { responses: { create: responsesCreate }, chat: { completions: { create: chatCreate } } };

    const result = await provider.chatStream({ messages: [{ role: "user", content: "hello" }], model: "gpt-5-chat" });

    expect(result.content).toBe("hi");
    expect(result.finishReason).toBe("stop");
    expect(responsesCreate).toHaveBeenCalledOnce();
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it("falls back from unsupported streaming Responses API parameters", async () => {
    async function* fallbackStream() {
      yield { choices: [{ delta: { content: "fallback stream" }, finish_reason: "stop" }] };
    }
    const provider = providerFor("openai", "gpt-5-chat");
    const err: any = new Error("Unknown parameter: max_output_tokens for Responses API");
    err.statusCode = 400;
    err.response = { statusCode: 400, text: "Unknown parameter: max_output_tokens for Responses API", headers: {} };
    const responsesCreate = vi.fn(async () => {
      throw err;
    });
    const chatCreate = vi.fn(async () => fallbackStream());
    provider.client = { responses: { create: responsesCreate }, chat: { completions: { create: chatCreate } } };

    const result = await provider.chatStream({ messages: [{ role: "user", content: "hello" }], model: "gpt-5-chat" });

    expect(result.content).toBe("fallback stream");
    expect(responsesCreate).toHaveBeenCalledOnce();
    expect(chatCreate).toHaveBeenCalledOnce();
  });

  it("returns an error when a chat stream stalls", async () => {
    const previous = process.env.MEMMY_AGENT_STREAM_IDLE_TIMEOUT_S;
    process.env.MEMMY_AGENT_STREAM_IDLE_TIMEOUT_S = "0";
    const stalledStream = {
      [Symbol.asyncIterator](): AsyncIterator<any> {
        return {
          next: () => new Promise(() => undefined),
        };
      },
    };
    const provider = providerFor("openai", "gpt-4o");
    provider.client = { chat: { completions: { create: vi.fn(async () => stalledStream) } }, responses: { create: vi.fn() } };

    try {
      const result = await provider.chatStream({ messages: [{ role: "user", content: "hello" }], model: "gpt-4o" });
      expect(result.finishReason).toBe("error");
      expect(result.content).toContain("stream stalled");
    } finally {
      if (previous == null) delete process.env.MEMMY_AGENT_STREAM_IDLE_TIMEOUT_S;
      else process.env.MEMMY_AGENT_STREAM_IDLE_TIMEOUT_S = previous;
    }
  });

  it("streams reasoning and tool-call deltas from chat completions", async () => {
    async function* stream() {
      yield { choices: [{ delta: { reasoning_content: "step1" }, finish_reason: null }] };
      yield {
        choices: [
          {
            delta: {
              content: "answer",
              tool_calls: [{ index: 0, id: "call_write", function: { name: "write_file", arguments: '{"path":"notes.md","content":"' } }],
            },
            finish_reason: null,
          },
        ],
      };
      yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'line\\n"}' } }] }, finish_reason: "tool_calls" }] };
    }
    const provider = new OpenAICompatProvider({ apiKey: "sk", defaultModel: "deepseek-chat", spec: findByName("deepseek") });
    provider.client = { chat: { completions: { create: vi.fn(async () => stream()) } }, responses: { create: vi.fn() } };
    const thinking: string[] = [];
    const content: string[] = [];
    const toolDeltas: any[] = [];

    const result = await provider.chatStream({
      messages: [{ role: "user", content: "write" }],
      tools: [{ type: "function", function: { name: "write_file" } }],
      model: "deepseek-chat",
      onThinkingDelta: (delta) => {
        thinking.push(delta);
      },
      onContentDelta: (delta) => {
        content.push(delta);
      },
      onToolCallDelta: (delta) => {
        toolDeltas.push(delta);
      },
    });

    expect(thinking).toEqual(["step1"]);
    expect(content).toEqual(["answer"]);
    expect(toolDeltas.map((delta) => delta.arguments_delta)).toEqual(['{"path":"notes.md","content":"', 'line\\n"}']);
    expect(result.reasoningContent).toBe("step1");
    expect(result.toolCalls[0].arguments).toEqual({ path: "notes.md", content: "line\n" });
  });
});
