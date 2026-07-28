import { describe, expect, it, vi } from "vitest";
import {
  AgentDefaults,
  Config,
  InlineFallbackConfig,
  ModelPresetConfig,
} from "../../../src/config/schema.js";
import { GenerationSettings, LLMProvider, LLMResponse } from "../../../src/providers/base.js";
import { FallbackProvider } from "../../../src/providers/fallback-provider.js";
import { ProviderSnapshot, buildProviderSnapshot, providerSignature } from "../../../src/providers/factory.js";
import { DEFAULT_MAX_TOKENS } from "../../../src/token-budget.js";

function makeResponse(
  content = "ok",
  finishReason = "stop",
  opts: {
    errorKind?: string | null;
    errorStatusCode?: number | null;
    errorType?: string | null;
    errorCode?: string | null;
    errorShouldRetry?: boolean | null;
  } = {},
): LLMResponse {
  return new LLMResponse({
    content,
    finishReason,
    errorKind: opts.errorKind ?? null,
    errorStatusCode: opts.errorStatusCode ?? null,
    errorType: opts.errorType ?? null,
    errorCode: opts.errorCode ?? null,
    errorShouldRetry: opts.errorShouldRetry ?? null,
  });
}

function errorResponse(content = "api error"): LLMResponse {
  return makeResponse(content, "error", { errorKind: "server_error" });
}

function fallback(
  model: string,
  provider = "custom",
  {
    maxTokens = 8192,
    contextWindowTokens = 200_000,
    temperature = 0.1,
    reasoningEffort = null,
  }: {
    maxTokens?: number;
    contextWindowTokens?: number;
    temperature?: number;
    reasoningEffort?: string | null;
  } = {},
): ModelPresetConfig {
  return new ModelPresetConfig({
    model,
    provider,
    maxTokens,
    contextWindowTokens,
    temperature,
    reasoningEffort,
  });
}

class FakeProvider extends LLMProvider {
  chatCalls: any[] = [];
  chatStreamCalls: any[] = [];

  constructor(public name: string = "fake", public response: LLMResponse = makeResponse()) {
    super();
  }

  getDefaultModel(): string {
    return `${this.name}/model`;
  }

  async chat(args: any): Promise<LLMResponse> {
    this.chatCalls.push({ ...args });
    return this.response;
  }

  override async chatStream(args: any): Promise<LLMResponse> {
    this.chatStreamCalls.push({ ...args });
    const onDelta = args.onContentDelta;
    if (onDelta && this.response.content) await onDelta(this.response.content);
    return this.response;
  }

}

describe("FallbackProvider configuration", () => {
  it("fallbackModels defaults to an empty list", () => {
    expect(new AgentDefaults().fallbackModels).toEqual([]);
  });

  it("fallbackModels accepts preset references and inline configs", () => {
    const config = Config.fromObject({
      agents: {
        defaults: {
          fallbackModels: [
            "deep",
            { provider: "openai", model: "gpt-4.1", maxTokens: 4096 },
          ],
        },
      },
      modelPresets: {
        deep: { provider: "anthropic", model: "claude-opus-4-7" },
      },
    });

    expect(config.agents.defaults.fallbackModels[0]).toBe("deep");
    expect(config.agents.defaults.fallbackModels[1]).toEqual(
      new InlineFallbackConfig({ provider: "openai", model: "gpt-4.1", maxTokens: 4096 }),
    );
  });

  it("fallback model preset references must exist", () => {
    expect(() =>
      Config.fromObject({
        agents: { defaults: { fallbackModels: ["missing"] } },
        modelPresets: {},
      }),
    ).toThrow(/fallbackModels.*not found/);
  });

  it("provider signatures track fallback presets and provider config", () => {
    const base = {
      agents: { defaults: { modelPreset: "fast", fallbackModels: ["deep"] } },
      modelPresets: {
        fast: { model: "openai/gpt-4.1", provider: "openai" },
        deep: { model: "anthropic/claude-sonnet-4-6", provider: "anthropic" },
      },
      providers: {
        openai: { apiKey: "primary-key" },
        anthropic: { apiKey: "fallback-key" },
      },
    };
    const changedFallback = {
      ...base,
      agents: { defaults: { modelPreset: "fast", fallbackModels: ["backup"] } },
      modelPresets: {
        ...base.modelPresets,
        backup: { model: "deepseek/deepseek-chat", provider: "deepseek" },
      },
      providers: {
        ...base.providers,
        deepseek: { apiKey: "deepseek-key" },
      },
    };
    const changedKey = {
      ...base,
      providers: {
        openai: { apiKey: "primary-key" },
        anthropic: { apiKey: "new-fallback-key" },
      },
    };

    const signature = providerSignature(Config.fromObject(base));

    expect(signature).not.toEqual(providerSignature(Config.fromObject(changedFallback)));
    expect(signature).not.toEqual(providerSignature(Config.fromObject(changedKey)));
  });

  it("provider snapshots use the smallest fallback context window", () => {
    const config = Config.fromObject({
      agents: { defaults: { modelPreset: "fast", fallbackModels: ["deep"] } },
      modelPresets: {
        fast: { model: "openai/gpt-4.1", provider: "openai", contextWindowTokens: 128_000 },
        deep: { model: "deepseek/deepseek-chat", provider: "deepseek", contextWindowTokens: 64_000 },
      },
      providers: {
        openai: { apiKey: "primary-key" },
        deepseek: { apiKey: "fallback-key" },
      },
    });

    expect(buildProviderSnapshot(config).contextWindowTokens).toBe(64_000);
  });

  it("inline fallbacks inherit the primary default maxTokens", () => {
    const config = Config.fromObject({
      agents: {
        defaults: {
          model: "openai/gpt-4.1",
          provider: "openai",
          fallbackModels: [{ model: "deepseek/deepseek-chat", provider: "deepseek" }],
        },
      },
      providers: {
        openai: { apiKey: "primary-key" },
        deepseek: { apiKey: "fallback-key" },
      },
    });

    const provider = buildProviderSnapshot(config).provider as FallbackProvider;

    expect(provider.generation.maxTokens).toBe(DEFAULT_MAX_TOKENS);
    expect(provider.fallbackPresets[0].maxTokens).toBe(DEFAULT_MAX_TOKENS);
  });

  it("named fallback presets preserve an explicit maxTokens value during failover", async () => {
    const config = Config.fromObject({
      agents: {
        defaults: {
          model: "openai/gpt-4.1",
          provider: "openai",
          fallbackModels: ["small"],
        },
      },
      modelPresets: {
        small: { model: "deepseek/deepseek-chat", provider: "deepseek", maxTokens: 4096 },
      },
      providers: {
        openai: { apiKey: "primary-key" },
        deepseek: { apiKey: "fallback-key" },
      },
    });
    const configured = buildProviderSnapshot(config).provider as FallbackProvider;
    const fallbackProvider = new FakeProvider("fallback", makeResponse("fallback ok"));
    const provider = new FallbackProvider({
      primary: new FakeProvider("primary", errorResponse()),
      fallbackPresets: configured.fallbackPresets,
      providerFactory: () => fallbackProvider,
    });

    await provider.chat({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: DEFAULT_MAX_TOKENS,
    });

    expect(fallbackProvider.chatCalls[0].maxTokens).toBe(4096);
  });

  it("provider snapshots default to the configured default context window", () => {
    const snapshot = new ProviderSnapshot({
      provider: new FakeProvider("primary"),
      model: "primary/model",
    });

    expect(snapshot.contextWindowTokens).toBe(200_000);
  });

  it("inline fallback reasoning effort does not inherit the primary setting", () => {
    const config = Config.fromObject({
      agents: { defaults: { modelPreset: "fast", fallbackModels: [{ provider: "openai", model: "gpt-4.1" }] } },
      modelPresets: {
        fast: { model: "anthropic/claude-opus-4-5", provider: "anthropic", reasoningEffort: "high" },
      },
      providers: {
        anthropic: { apiKey: "primary-key" },
        openai: { apiKey: "fallback-key" },
      },
    });

    const fallbackSignatures = providerSignature(config).at(-1);
    expect(fallbackSignatures[0][12]).toBeNull();
  });
});

describe("FallbackProvider failover", () => {
  it("does not call fallback providers when the primary succeeds", async () => {
    const primary = new FakeProvider("primary", makeResponse("primary ok"));
    const factory = vi.fn();
    const provider = new FallbackProvider({
      primary,
      fallbackPresets: [fallback("fallback-a")],
      providerFactory: factory,
    });

    const result = await provider.chat({ messages: [{ role: "user", content: "hi" }] });

    expect(result.content).toBe("primary ok");
    expect(result.finishReason).toBe("stop");
    expect(factory).not.toHaveBeenCalled();
  });

  it("uses the first fallback when the primary returns a fallbackable error", async () => {
    const primary = new FakeProvider("primary", errorResponse());
    const fb = new FakeProvider("fallback", makeResponse("fallback ok"));
    const preset = fallback("fallback-a");
    const factory = vi.fn(() => fb);
    const provider = new FallbackProvider({ primary, fallbackPresets: [preset], providerFactory: factory });

    const result = await provider.chat({ messages: [{ role: "user", content: "hi" }], model: "primary-model" });

    expect(result.content).toBe("fallback ok");
    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(preset);
    expect(primary.chatCalls[0].model).toBe("primary-model");
    expect(fb.chatCalls[0].model).toBe("fallback-a");
  });

  it("does not fail over once streaming content has been emitted", async () => {
    const primary = new FakeProvider("primary", errorResponse());
    const factory = vi.fn();
    const provider = new FallbackProvider({
      primary,
      fallbackPresets: [fallback("fallback-a")],
      providerFactory: factory,
    });

    const result = await provider.chatStream({
      messages: [{ role: "user", content: "hi" }],
      onContentDelta: async () => undefined,
    });

    expect(result.finishReason).toBe("error");
    expect(factory).not.toHaveBeenCalled();
  });

  it("fails over on rate-limit style errors", async () => {
    const primary = new FakeProvider("primary", errorResponse("rate limit exceeded"));
    const fb = new FakeProvider("fallback", makeResponse("fallback ok"));
    const factory = vi.fn(() => fb);
    const provider = new FallbackProvider({
      primary,
      fallbackPresets: [fallback("fallback-a")],
      providerFactory: factory,
    });

    const result = await provider.chat({ messages: [{ role: "user", content: "hi" }] });

    expect(result.content).toBe("fallback ok");
    expect(factory).toHaveBeenCalledOnce();
  });

  it("does not fail over on bad request errors", async () => {
    const primary = new FakeProvider(
      "primary",
      makeResponse("invalid request", "error", { errorStatusCode: 400, errorKind: "invalid_request" }),
    );
    const factory = vi.fn();
    const provider = new FallbackProvider({
      primary,
      fallbackPresets: [fallback("fallback-a")],
      providerFactory: factory,
    });

    const result = await provider.chat({ messages: [{ role: "user", content: "hi" }] });

    expect(result.finishReason).toBe("error");
    expect(factory).not.toHaveBeenCalled();
  });

  it("does not fail over on auth errors", async () => {
    const primary = new FakeProvider(
      "primary",
      makeResponse("unauthorized", "error", { errorStatusCode: 401, errorKind: "authentication" }),
    );
    const factory = vi.fn();
    const provider = new FallbackProvider({
      primary,
      fallbackPresets: [fallback("fallback-a")],
      providerFactory: factory,
    });

    const result = await provider.chat({ messages: [{ role: "user", content: "hi" }] });

    expect(result.finishReason).toBe("error");
    expect(factory).not.toHaveBeenCalled();
  });

  it("fails over on timeout errors", async () => {
    const primary = new FakeProvider("primary", makeResponse("timed out", "error", { errorKind: "timeout" }));
    const fb = new FakeProvider("fallback", makeResponse("fallback ok"));
    const factory = vi.fn(() => fb);
    const provider = new FallbackProvider({
      primary,
      fallbackPresets: [fallback("fallback-a")],
      providerFactory: factory,
    });

    const result = await provider.chat({ messages: [{ role: "user", content: "hi" }] });

    expect(result.content).toBe("fallback ok");
    expect(factory).toHaveBeenCalledOnce();
  });

  it("tries fallback models in order", async () => {
    const primary = new FakeProvider("primary", errorResponse("primary fail"));
    const fallbackA = new FakeProvider("a", errorResponse("a fail"));
    const fallbackB = new FakeProvider("b", makeResponse("b ok"));
    const presetA = fallback("fallback-a");
    const presetB = fallback("fallback-b");
    const factory = vi.fn().mockReturnValueOnce(fallbackA).mockReturnValueOnce(fallbackB);
    const provider = new FallbackProvider({ primary, fallbackPresets: [presetA, presetB], providerFactory: factory });

    const result = await provider.chat({ messages: [{ role: "user", content: "hi" }] });

    expect(result.content).toBe("b ok");
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenCalledWith(presetA);
    expect(factory).toHaveBeenCalledWith(presetB);
  });

  it("returns the last fallback error when all fallbacks fail", async () => {
    const primary = new FakeProvider("primary", errorResponse("primary fail"));
    const fb = new FakeProvider("fallback", errorResponse("all fail"));
    const provider = new FallbackProvider({
      primary,
      fallbackPresets: [fallback("fallback-a")],
      providerFactory: vi.fn(() => fb),
    });

    const result = await provider.chat({ messages: [{ role: "user", content: "hi" }] });

    expect(result.finishReason).toBe("error");
    expect(result.content).toContain("all fail");
  });

  it("skips fallback models whose provider factory raises", async () => {
    const primary = new FakeProvider("primary", errorResponse());
    const fallbackB = new FakeProvider("b", makeResponse("b ok"));
    const factory = vi.fn().mockImplementationOnce(() => {
      throw new Error("no key");
    }).mockReturnValueOnce(fallbackB);
    const provider = new FallbackProvider({
      primary,
      fallbackPresets: [fallback("fallback-a"), fallback("fallback-b")],
      providerFactory: factory,
    });

    const result = await provider.chat({ messages: [{ role: "user", content: "hi" }] });

    expect(result.content).toBe("b ok");
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("uses fallback model names for fallback calls", async () => {
    const primary = new FakeProvider("primary", errorResponse());
    const fb = new FakeProvider("fallback", makeResponse("ok"));
    const provider = new FallbackProvider({
      primary,
      fallbackPresets: [fallback("fallback-model")],
      providerFactory: vi.fn(() => fb),
    });

    await provider.chat({ messages: [{ role: "user", content: "hi" }], model: "primary-model" });

    expect(fb.chatCalls[0].model).toBe("fallback-model");
  });

  it("uses fallback generation fields and clears inherited reasoning effort", async () => {
    const primary = new FakeProvider("primary", errorResponse());
    const fb = new FakeProvider("fallback", makeResponse("ok"));
    const provider = new FallbackProvider({
      primary,
      fallbackPresets: [
        fallback("fallback-model", "custom", {
          maxTokens: 1234,
          temperature: 0.4,
          reasoningEffort: null,
        }),
      ],
      providerFactory: vi.fn(() => fb),
    });

    await provider.chat({
      messages: [{ role: "user", content: "hi" }],
      model: "primary-model",
      maxTokens: 8192,
      temperature: 0.1,
      reasoningEffort: "high",
    });

    expect(fb.chatCalls[0].model).toBe("fallback-model");
    expect(fb.chatCalls[0].maxTokens).toBe(1234);
    expect(fb.chatCalls[0].temperature).toBe(0.4);
    expect(fb.chatCalls[0]).not.toHaveProperty("reasoningEffort");
  });

  it("does not use the factory when fallback presets are empty", async () => {
    const primary = new FakeProvider("primary", errorResponse());
    const factory = vi.fn();
    const provider = new FallbackProvider({ primary, fallbackPresets: [], providerFactory: factory });

    const result = await provider.chat({ messages: [{ role: "user", content: "hi" }] });

    expect(result.finishReason).toBe("error");
    expect(factory).not.toHaveBeenCalled();
  });

  it("fails over for chat streams before content has been emitted", async () => {
    const primary = new FakeProvider("primary", errorResponse(""));
    const fb = new FakeProvider("fallback", makeResponse("stream ok"));
    const provider = new FallbackProvider({
      primary,
      fallbackPresets: [fallback("fallback-a")],
      providerFactory: vi.fn(() => fb),
    });

    const result = await provider.chatStream({ messages: [{ role: "user", content: "hi" }] });

    expect(result.content).toBe("stream ok");
    expect(result.finishReason).toBe("stop");
  });

  it("returns the primary default model", () => {
    const primary = new FakeProvider("primary");
    const provider = new FallbackProvider({
      primary,
      fallbackPresets: [fallback("a")],
      providerFactory: vi.fn(),
    });

    expect(provider.getDefaultModel()).toBe("primary/model");
  });

  it("skips the primary after three consecutive fallbackable failures", async () => {
    const primary = new FakeProvider("primary", errorResponse());
    const fb = new FakeProvider("fallback", makeResponse("fallback ok"));
    const provider = new FallbackProvider({
      primary,
      fallbackPresets: [fallback("fallback-a")],
      providerFactory: vi.fn(() => fb),
    });

    for (let i = 0; i < 3; i += 1) {
      const result = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
      expect(result.content).toBe("fallback ok");
    }
    expect(primary.chatCalls).toHaveLength(3);

    primary.chatCalls.length = 0;
    const result = await provider.chat({ messages: [{ role: "user", content: "hi" }] });

    expect(result.content).toBe("fallback ok");
    expect(primary.chatCalls).toHaveLength(0);
  });

  it("resets the primary circuit on success", async () => {
    const primary = new FakeProvider("primary", errorResponse());
    const fb = new FakeProvider("fallback", makeResponse("fallback ok"));
    const provider = new FallbackProvider({
      primary,
      fallbackPresets: [fallback("fallback-a")],
      providerFactory: vi.fn(() => fb),
    });

    await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    await provider.chat({ messages: [{ role: "user", content: "hi" }] });

    primary.response = makeResponse("primary ok");
    const success = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(success.content).toBe("primary ok");

    primary.response = errorResponse();
    primary.chatCalls.length = 0;
    const result = await provider.chat({ messages: [{ role: "user", content: "hi" }] });

    expect(result.content).toBe("fallback ok");
    expect(primary.chatCalls).toHaveLength(1);
  });

  it("forwards primary generation settings", () => {
    const primary = new FakeProvider("primary");
    primary.generation = new GenerationSettings({ temperature: 0.5, maxTokens: 1024 });
    const provider = new FallbackProvider({
      primary,
      fallbackPresets: [fallback("a")],
      providerFactory: vi.fn(),
    });

    expect(provider.generation.temperature).toBe(0.5);
    expect(provider.generation.maxTokens).toBe(1024);
  });
});
