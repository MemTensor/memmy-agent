import { describe, expect, it, vi } from "vitest";
import { AzureOpenAIProvider } from "../../src/providers/azure-openai-provider.js";
import { LLMResponse } from "../../src/providers/base.js";

function makeSdkResponse(init: { content?: string | null; toolCalls?: any[]; status?: string; usage?: any } = {}): any {
  return {
    toJSON: () => ({
      output: [
        ...(init.content !== null
          ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: init.content ?? "Hello!" }] }]
          : []),
        ...(init.toolCalls ?? []).map((call) => ({
          type: "function_call",
          call_id: call.call_id,
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        })),
      ],
      status: init.status ?? "completed",
      usage: init.usage ?? { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    }),
  };
}

describe("AzureOpenAIProvider init", () => {
  it("creates an SDK-compatible client with the configured base URL", () => {
    const provider = new AzureOpenAIProvider("test-key", "https://test-resource.openai.azure.com", "gpt-4o-deployment");

    expect(provider.apiKey).toBe("test-key");
    expect(provider.apiBase).toBe("https://test-resource.openai.azure.com/");
    expect(provider.defaultModel).toBe("gpt-4o-deployment");
    expect(String(provider.client.baseUrl).replace(/\/+$/g, "")).toMatch(/\/openai\/v1$/);
  });

  it("normalizes base URLs without trailing slashes", () => {
    const provider = new AzureOpenAIProvider("k", "https://res.openai.azure.com");
    expect(String(provider.client.baseUrl).replace(/\/+$/g, "")).toBe("https://res.openai.azure.com/openai/v1");
  });

  it("normalizes base URLs with trailing slashes", () => {
    const provider = new AzureOpenAIProvider("k", "https://res.openai.azure.com/");
    expect(String(provider.client.baseUrl).replace(/\/+$/g, "")).toBe("https://res.openai.azure.com/openai/v1");
  });

  it("rejects missing API keys", () => {
    expect(() => new AzureOpenAIProvider("", "https://test.com")).toThrow(/Azure OpenAI API key is required/);
  });

  it("rejects missing API bases", () => {
    expect(() => new AzureOpenAIProvider("test", "")).toThrow(/Azure OpenAI API base URL is required/);
  });

  it("does not add api-version to the Responses base URL", () => {
    const provider = new AzureOpenAIProvider("k", "https://res.openai.azure.com");
    expect(String(provider.client.baseUrl)).not.toContain("api-version");
  });
});

describe("AzureOpenAIProvider temperature support", () => {
  it("supports temperature for standard models", () => {
    expect(AzureOpenAIProvider.supportsTemperature("gpt-4o")).toBe(true);
  });

  it("omits temperature for reasoning model deployments", () => {
    expect(AzureOpenAIProvider.supportsTemperature("o3-mini")).toBe(false);
    expect(AzureOpenAIProvider.supportsTemperature("gpt-5-chat")).toBe(false);
    expect(AzureOpenAIProvider.supportsTemperature("o4-mini")).toBe(false);
  });

  it("omits temperature when reasoning effort is enabled", () => {
    expect(AzureOpenAIProvider.supportsTemperature("gpt-4o", "medium")).toBe(false);
  });

  it("keeps temperature when reasoning effort is the none string", () => {
    expect(AzureOpenAIProvider.supportsTemperature("gpt-4o", "none")).toBe(true);
  });
});

describe("AzureOpenAIProvider body construction", () => {
  it("builds a basic Responses API body", () => {
    const provider = new AzureOpenAIProvider("k", "https://res.openai.azure.com", "gpt-4o");
    const body = provider.buildBody(
      [{ role: "system", content: "You are helpful." }, { role: "user", content: "Hi" }],
      null,
      null,
      4096,
      0.7,
      null,
      null,
    );

    expect(body.model).toBe("gpt-4o");
    expect(body.instructions).toBe("You are helpful.");
    expect(body.temperature).toBe(0.7);
    expect(body.max_output_tokens).toBe(4096);
    expect(body.store).toBe(false);
    expect(body.reasoning).toBeUndefined();
    expect(body.input.some((item: any) => item.role === "user")).toBe(true);
  });

  it("never sends max_output_tokens below one", () => {
    const provider = new AzureOpenAIProvider("k", "https://r.com", "gpt-4o");
    expect(provider.buildBody([{ role: "user", content: "x" }], null, null, 0, 0.7, null, null).max_output_tokens).toBe(1);
  });

  it("converts OpenAI-style tools into Responses API tools", () => {
    const provider = new AzureOpenAIProvider("k", "https://r.com", "gpt-4o");
    const body = provider.buildBody(
      [{ role: "user", content: "weather?" }],
      [{ type: "function", function: { name: "get_weather", parameters: {} } }],
      null,
      4096,
      0.7,
      null,
      null,
    );

    expect(body.tools).toEqual([{ type: "function", name: "get_weather", description: "", parameters: {} }]);
    expect(body.tool_choice).toBe("auto");
  });

  it("adds reasoning body and include values for reasoning deployments", () => {
    const provider = new AzureOpenAIProvider("k", "https://r.com", "gpt-5-chat");
    const body = provider.buildBody([{ role: "user", content: "think" }], null, "gpt-5-chat", 4096, 0.7, "medium", null);

    expect(body.reasoning).toEqual({ effort: "medium" });
    expect(body.include).toContain("reasoning.encrypted_content");
    expect(body.temperature).toBeUndefined();
  });

  it("omits reasoning for the none string and keeps temperature", () => {
    const provider = new AzureOpenAIProvider("k", "https://r.com", "gpt-4o");
    const body = provider.buildBody([{ role: "user", content: "hi" }], null, "gpt-4o", 4096, 0.7, "none", null);

    expect(body.reasoning).toBeUndefined();
    expect(body.temperature).toBe(0.7);
  });

  it("converts image_url content blocks to input_image", () => {
    const provider = new AzureOpenAIProvider("k", "https://r.com", "gpt-4o");
    const body = provider.buildBody(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "What's in this image?" },
            { type: "image_url", image_url: { url: "https://example.com/img.png" } },
          ],
        },
      ],
      null,
      null,
      4096,
      0.7,
      null,
      null,
    );

    const contentTypes = body.input[0].content.map((block: any) => block.type);
    expect(contentTypes).toContain("input_text");
    expect(contentTypes).toContain("input_image");
    expect(body.input[0].content.find((block: any) => block.type === "input_image").image_url).toBe("https://example.com/img.png");
  });

  it("sanitizes a single object content block", () => {
    const provider = new AzureOpenAIProvider("k", "https://r.com", "gpt-4o");
    const body = provider.buildBody([{ role: "user", content: { type: "text", text: "Hi from object content" } }], null, null, 4096, 0.7, null, null);

    expect(body.input[0].content).toEqual([{ type: "input_text", text: "Hi from object content" }]);
  });
});

describe("AzureOpenAIProvider chat", () => {
  it("returns a parsed response on success", async () => {
    const provider = new AzureOpenAIProvider("test-key", "https://test.openai.azure.com", "gpt-4o");
    provider.client.responses = { create: vi.fn(async () => makeSdkResponse({ content: "Hello!" })) };

    const result = await provider.chat([{ role: "user", content: "Hi" }]);

    expect(result).toBeInstanceOf(LLMResponse);
    expect(result.content).toBe("Hello!");
    expect(result.finishReason).toBe("stop");
    expect(result.usage.prompt_tokens).toBe(10);
  });

  it("uses the default deployment model", async () => {
    const provider = new AzureOpenAIProvider("k", "https://test.openai.azure.com", "my-deployment");
    provider.client.responses = { create: vi.fn(async () => makeSdkResponse({ content: "ok" })) };

    await provider.chat([{ role: "user", content: "test" }]);

    expect(provider.client.responses.create).toHaveBeenCalledWith(expect.objectContaining({ model: "my-deployment" }));
  });

  it("uses a custom deployment model", async () => {
    const provider = new AzureOpenAIProvider("k", "https://test.openai.azure.com", "gpt-4o");
    provider.client.responses = { create: vi.fn(async () => makeSdkResponse({ content: "ok" })) };

    await provider.chat([{ role: "user", content: "test" }], null, "custom-deploy");

    expect(provider.client.responses.create).toHaveBeenCalledWith(expect.objectContaining({ model: "custom-deploy" }));
  });

  it("parses tool calls from non-streaming responses", async () => {
    const provider = new AzureOpenAIProvider("k", "https://test.openai.azure.com", "gpt-4o");
    provider.client.responses = {
      create: vi.fn(async () =>
        makeSdkResponse({
          content: null,
          toolCalls: [{ call_id: "call_123", id: "fc_1", name: "get_weather", arguments: '{"location": "SF"}' }],
        }),
      ),
    };

    const result = await provider.chat(
      [{ role: "user", content: "Weather?" }],
      [{ type: "function", function: { name: "get_weather", parameters: {} } }],
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("get_weather");
    expect(result.toolCalls[0].arguments).toEqual({ location: "SF" });
  });

  it("returns an error response when the SDK call fails", async () => {
    const provider = new AzureOpenAIProvider("k", "https://test.openai.azure.com", "gpt-4o");
    provider.client.responses = { create: vi.fn(async () => { throw new Error("Connection failed"); }) };

    const result = await provider.chat([{ role: "user", content: "Hi" }]);

    expect(result).toBeInstanceOf(LLMResponse);
    expect(result.content).toContain("Connection failed");
    expect(result.finishReason).toBe("error");
  });

  it("sends reasoning as a nested object rather than a flat parameter", async () => {
    const provider = new AzureOpenAIProvider("k", "https://test.openai.azure.com", "gpt-5-chat");
    provider.client.responses = { create: vi.fn(async () => makeSdkResponse({ content: "thought" })) };

    await provider.chat([{ role: "user", content: "think" }], null, null, 4096, 0.7, "medium");

    expect(provider.client.responses.create).toHaveBeenCalledWith(expect.objectContaining({ reasoning: { effort: "medium" } }));
    expect(provider.client.responses.create.mock.calls[0][0].reasoning_effort).toBeUndefined();
  });
});

describe("AzureOpenAIProvider streaming", () => {
  it("streams content deltas and returns the combined response", async () => {
    const provider = new AzureOpenAIProvider("test-key", "https://test.openai.azure.com", "gpt-4o");
    async function* stream(): AsyncGenerator<any> {
      yield { type: "response.output_text.delta", delta: "Hello" };
      yield { type: "response.output_text.delta", delta: " world" };
      yield { type: "response.completed", response: { status: "completed" } };
    }
    provider.client.responses = { create: vi.fn(async () => stream()) };
    const deltas: string[] = [];

    const result = await provider.chatStream({
      messages: [{ role: "user", content: "Hi" }],
      onContentDelta: (text: string) => {
        deltas.push(text);
      },
    });

    expect(result.content).toBe("Hello world");
    expect(result.finishReason).toBe("stop");
    expect(deltas).toEqual(["Hello", " world"]);
  });

  it("accumulates streaming tool calls", async () => {
    const provider = new AzureOpenAIProvider("k", "https://test.openai.azure.com", "gpt-4o");
    async function* stream(): AsyncGenerator<any> {
      yield { type: "response.output_item.added", item: { type: "function_call", call_id: "call_1", id: "fc_1", name: "get_weather", arguments: "" } };
      yield { type: "response.function_call_arguments.delta", call_id: "call_1", delta: '{"loc' };
      yield { type: "response.function_call_arguments.done", call_id: "call_1", arguments: '{"location":"SF"}' };
      yield { type: "response.output_item.done", item: { type: "function_call", call_id: "call_1", id: "fc_1", name: "get_weather", arguments: '{"location":"SF"}' } };
      yield { type: "response.completed", response: { status: "completed" } };
    }
    provider.client.responses = { create: vi.fn(async () => stream()) };

    const result = await provider.chatStream(
      [{ role: "user", content: "weather?" }],
      [{ type: "function", function: { name: "get_weather", parameters: {} } }],
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("get_weather");
    expect(result.toolCalls[0].arguments).toEqual({ location: "SF" });
  });

  it("returns an error response when streaming fails", async () => {
    const provider = new AzureOpenAIProvider("k", "https://test.openai.azure.com", "gpt-4o");
    provider.client.responses = { create: vi.fn(async () => { throw new Error("Connection failed"); }) };

    const result = await provider.chatStream([{ role: "user", content: "Hi" }]);

    expect(result.content).toContain("Connection failed");
    expect(result.finishReason).toBe("error");
  });
});

describe("AzureOpenAIProvider defaults", () => {
  it("returns the default model", () => {
    expect(new AzureOpenAIProvider("k", "https://r.com", "my-deploy").getDefaultModel()).toBe("my-deploy");
  });
});
