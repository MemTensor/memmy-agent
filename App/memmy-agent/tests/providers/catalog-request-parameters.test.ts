import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "../../src/providers/anthropic-provider.js";
import { AzureOpenAIProvider } from "../../src/providers/azure-openai-provider.js";
import { BedrockProvider } from "../../src/providers/bedrock-provider.js";
import { GenerationSettings, LLMProvider, LLMResponse } from "../../src/providers/base.js";
import { FallbackProvider } from "../../src/providers/fallback-provider.js";
import { OpenAICompatProvider } from "../../src/providers/openai-compat-provider.js";
import { findByName } from "../../src/providers/registry.js";
import { resolveTurnModelCapabilities } from "../../src/providers/turn-model-capabilities.js";
import type { RuntimeModelCapabilityCatalogState } from "../../src/providers/model-capability-catalog.js";

const messages = [{ role: "user", content: "hello" }];
const fallbackState: RuntimeModelCapabilityCatalogState = { mode: "provider-fallback", catalog: null };
const fallbackCapabilities = resolveTurnModelCapabilities({ state: fallbackState, model: "gpt-6-sol" });
const catalogState: RuntimeModelCapabilityCatalogState = {
  mode: "catalog",
  catalog: { catalogVersion: 21, models: {
    "gpt-6-sol": { inputModalities: ["text", "image"], contextWindowTokens: 128000, maxTokens: 8192 },
    "gpt-4o": { inputModalities: ["text", "image"], contextWindowTokens: 128000, maxTokens: 4096 },
  } },
};

class RecordingProvider extends LLMProvider {
  seen: any[] = [];
  constructor(readonly model: string, readonly fail = false) { super(); }
  getDefaultModel() { return this.model; }
  async chat(args: any) {
    this.seen.push({ ...args });
    return new LLMResponse({ content: this.fail ? "503 unavailable" : "ok", finishReason: this.fail ? "error" : "stop", ...(this.fail ? { errorStatusCode: 503 } : {}) });
  }
  protected override async sleep() {}
}

describe("catalog parameters at the Provider boundary", () => {
  it.each(["catalog", "provider-fallback"] as const)("preserves explicit Chat Completions tool compatibility in %s mode", (mode) => {
    const provider = new OpenAICompatProvider({ apiKey: "test", apiBase: "https://example.test/v1", defaultModel: "gpt-6-sol", spec: findByName("openai"), apiType: "chatCompletions" });
    const tools = [{ type: "function", function: { name: "inspect", parameters: { type: "object", properties: {} } } }];
    const body = provider.buildKwargs({ messages, tools, modelCapabilities: { mode, reasoningEffort: "high" } });
    expect(body.reasoning_effort).toBe("none");
    expect(provider.buildKwargs({ messages, modelCapabilities: { mode, reasoningEffort: "high" } }).reasoning_effort).toBe("high");
  });

  it.each([96, 256])("keeps Anthropic task output %i separate from thinking inside the configured limit", (taskMaxTokens) => {
    const provider = new AnthropicProvider({ apiKey: "test", defaultModel: "claude-opus-4-7" });
    const modelCapabilities = { mode: "catalog" as const, maxTokens: 16384, taskMaxTokens, thinkingEnabled: true, reasoningEffort: "high" };
    const body = provider.buildKwargs({ messages, modelCapabilities });
    expect(body.max_tokens).toBe(8192 + taskMaxTokens);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
    expect(body.max_tokens).toBeLessThanOrEqual(modelCapabilities.maxTokens);
    const constrained = provider.buildKwargs({ messages, modelCapabilities: { ...modelCapabilities, maxTokens: 2048 } });
    expect(constrained.max_tokens).toBe(2048);
    expect(constrained.thinking.budget_tokens).toBe(2048 - taskMaxTokens);
    expect(() => provider.buildKwargs({ messages, modelCapabilities: { ...modelCapabilities, maxTokens: 1024 } })).toThrow(/minimum thinking budget/);
    expect(provider.buildKwargs({ messages, modelCapabilities: { ...modelCapabilities, thinkingEnabled: false, reasoningEffort: "none" } }).max_tokens).toBe(taskMaxTokens);
  });

  it.each([
    { thinkingEnabled: true, expected: { type: "adaptive" } },
    { thinkingEnabled: true, reasoningEffort: "high", expected: { type: "adaptive", effort: "high" } },
    { thinkingEnabled: false, reasoningEffort: "none", expected: undefined },
    { expected: undefined },
  ])("translates Bedrock thinking intent without inventing a level: %j", ({ expected, ...thinking }) => {
    const provider = new BedrockProvider({ defaultModel: "anthropic.claude-opus-4-7" });
    const body = provider.buildKwargs({ messages, modelCapabilities: { mode: "catalog", maxTokens: 8192, ...thinking } });
    expect(body.additionalModelRequestFields?.thinking).toEqual(expected);
  });

  it("respects an explicit Anthropic extra-body limit without overwriting the task budget", () => {
    const provider = new AnthropicProvider({ apiKey: "test", defaultModel: "claude-opus-4-7", extraBody: { max_tokens: 2048 } });
    const modelCapabilities = { mode: "catalog" as const, maxTokens: 8192, taskMaxTokens: 96, thinkingEnabled: true, reasoningEffort: "high" };
    const body = provider.buildKwargs({ messages, modelCapabilities });
    expect(body.max_tokens).toBe(2048);
    expect(body.thinking.budget_tokens).toBe(2048 - 96);
    provider.extraBody = { max_tokens: 16384 };
    expect(provider.buildKwargs({ messages, modelCapabilities }).max_tokens).toBe(8192);
  });

  it("keeps task output limits for OpenAI, Azure and Bedrock without changing the model limit", async () => {
    const modelCapabilities = { mode: "catalog" as const, maxTokens: 8192, taskMaxTokens: 96 };
    const provider = new OpenAICompatProvider("test", "https://api.openai.com/v1", "gpt-6-sol", findByName("openai"));
    const body = provider.buildKwargs({ messages, modelCapabilities });
    expect(body.max_completion_tokens ?? body.max_tokens).toBe(96);
    expect(provider.buildResponsesBody({ messages, modelCapabilities }).max_output_tokens).toBe(96);
    expect(new BedrockProvider().buildKwargs({ messages, modelCapabilities }).inferenceConfig.maxTokens).toBe(96);
    const azure = new AzureOpenAIProvider("test", "https://test.openai.azure.com", "gpt-6-sol");
    const create = vi.fn(async (_body: unknown) => ({ toJSON: () => ({ output: [], status: "completed" }) }));
    azure.client.responses.create = create;
    await azure.chat({ messages, modelCapabilities });
    expect(create.mock.calls[0][0]).toMatchObject({ max_output_tokens: 96 });
    expect(modelCapabilities.maxTokens).toBe(8192);
  });

  it("uses snapshot reasoning even when a direct caller supplies stale reasoning arguments", () => {
    const provider = new OpenAICompatProvider("test", "https://api.openai.com/v1", "gpt-6-sol", findByName("openai"));
    const args = { messages, reasoningEffort: "none", modelCapabilities: { ...fallbackCapabilities, reasoningEffort: "high" } };
    expect(provider.buildKwargs(args).reasoning_effort).toBe("high");
    expect(provider.buildResponsesBody(args).reasoning).toEqual({ effort: "high" });
  });
  it.each(["chat", "responses"])("does not restore OpenAI %s generation defaults in fallback", (api) => {
    const provider = new OpenAICompatProvider("test", "https://api.openai.com/v1", "gpt-6-sol", findByName("openai"));
    provider.generation = new GenerationSettings({ maxTokens: 4096, reasoningEffort: "high" });
    const args = { messages, modelCapabilities: fallbackCapabilities };
    const body = api === "chat" ? provider.buildKwargs(args) : provider.buildResponsesBody(args);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("max_completion_tokens");
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("reasoning");
  });

  it("uses catalog limits instead of old OpenAI generation defaults", () => {
    const provider = new OpenAICompatProvider("test", "https://api.openai.com/v1", "gpt-6-sol", findByName("openai"));
    const args = { messages, maxTokens: 1, modelCapabilities: resolveTurnModelCapabilities({ state: catalogState, model: "gpt-6-sol" }) };
    const chat = provider.buildKwargs(args);
    expect(chat.max_completion_tokens ?? chat.max_tokens).toBe(8192);
    expect(provider.buildResponsesBody(args).max_output_tokens).toBe(8192);
  });

  it("does not restore maxTokens or reasoningEffort during retries", async () => {
    const provider = new RecordingProvider("gpt-6-sol", true);
    provider.generation = new GenerationSettings({ maxTokens: 4096, reasoningEffort: "high" });
    await provider.chatWithRetry({ messages, modelCapabilities: fallbackCapabilities });
    expect(provider.seen.length).toBeGreaterThan(1);
    for (const args of provider.seen) {
      expect(args.maxTokens).toBeUndefined();
      expect(args.reasoningEffort).toBeUndefined();
      expect(args.modelCapabilities).toBe(fallbackCapabilities);
    }
  });

  it("keeps DeepSeek images for Provider validation when modalities are unknown", () => {
    const provider = new OpenAICompatProvider("test", "https://api.deepseek.com/v1", "deepseek-chat", findByName("deepseek"));
    const content = [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } }];
    const body = provider.buildKwargs({ messages: [{ role: "user", content }], modelCapabilities: fallbackCapabilities });
    expect(body.messages[0].content).toEqual(content);
  });

  it("rejects missing Anthropic mandatory limits instead of inventing them", () => {
    const provider = new AnthropicProvider({ apiKey: "test" });
    expect(() => provider.buildKwargs({ messages, modelCapabilities: fallbackCapabilities })).toThrow(/explicitly configured maxTokens/);
  });

  it("converts toggle-only Anthropic thinking without exceeding the catalog limit", () => {
    const provider = new AnthropicProvider({ apiKey: "test", defaultModel: "claude-sonnet-4-6" });
    const modelCapabilities = { ...fallbackCapabilities, maxTokens: 2048, thinkingEnabled: true };
    const body = provider.buildKwargs({ messages, modelCapabilities });
    expect(body.max_tokens).toBe(2048);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 2047 });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(() => provider.buildKwargs({ messages, modelCapabilities: { ...modelCapabilities, maxTokens: 1024 } })).toThrow(/minimum thinking budget/);
  });

  it("omits optional Bedrock token limits in fallback", () => {
    const body = new BedrockProvider({ defaultModel: "anthropic.claude-3-5-sonnet" }).buildKwargs({ messages, modelCapabilities: fallbackCapabilities });
    expect(body.inferenceConfig).not.toHaveProperty("maxTokens");
  });

  it("omits Azure token and reasoning defaults in the actual SDK request", async () => {
    const provider = new AzureOpenAIProvider("test", "https://test.openai.azure.com", "gpt-6-sol");
    const create = vi.fn(async (_body: unknown) => ({ toJSON: () => ({ output: [], status: "completed" }) }));
    provider.client.responses.create = create as any;
    await provider.chat({ messages, modelCapabilities: fallbackCapabilities });
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("max_output_tokens");
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("reasoning");
  });

  it("keeps directory fallback on the selected primary model", async () => {
    const primary = new RecordingProvider("gpt-6-sol", true);
    const backup = new RecordingProvider("gpt-4o");
    await new FallbackProvider([primary, backup]).chat({ messages, modelCapabilities: fallbackCapabilities, capabilityCatalogState: fallbackState });
    expect(primary.seen).toHaveLength(1);
    expect(backup.seen).toHaveLength(0);
  });

  it("resolves a normal backup from the same catalog snapshot and restores arguments", async () => {
    const primary = new RecordingProvider("gpt-6-sol", true);
    const backup = new RecordingProvider("gpt-4o");
    const args = { messages, model: "gpt-6-sol", modelCapabilities: { ...resolveTurnModelCapabilities({ state: catalogState, model: "gpt-6-sol" }), taskMaxTokens: 96 }, capabilityCatalogState: catalogState };
    const original = { ...args };
    await new FallbackProvider([primary, backup]).chat(args);
    expect(backup.seen[0].modelCapabilities).toMatchObject({ catalogVersion: 21, maxTokens: 4096, taskMaxTokens: 96 });
    expect(args).toEqual(original);
  });
});
