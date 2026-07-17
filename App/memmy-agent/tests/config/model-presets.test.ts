import { describe, expect, it } from "vitest";
import { Config, ModelPresetConfig } from "../../src/config/schema.js";

describe("model presets", () => {
  it("resolves defaults when no preset is active", () => {
    const config = new Config();
    const resolved = config.resolvePreset();

    expect(config.agents.defaults.contextWindowTokens).toBe(200_000);
    expect(resolved.model).toBe(config.agents.defaults.model);
    expect(resolved.provider).toBe(config.agents.defaults.provider);
    expect(resolved.maxTokens).toBe(config.agents.defaults.maxTokens);
    expect(resolved.contextWindowTokens).toBe(config.agents.defaults.contextWindowTokens);
    expect(resolved.temperature).toBe(config.agents.defaults.temperature);
    expect(resolved.reasoningEffort).toBe(config.agents.defaults.reasoningEffort);
  });

  it("uses the default context window for implicit named presets", () => {
    expect(new ModelPresetConfig({ model: "openai/gpt-4.1" }).contextWindowTokens).toBe(200_000);
  });

  it("accepts exact OpenAI apiType values only", () => {
    const config = Config.fromObject({ providers: { openai: { apiKey: "sk-test", apiType: "responses" } } });
    expect(config.providers.openai.apiType).toBe("responses");

    expect(() => Config.fromObject({ providers: { openai: { apiKey: "sk-test", apiType: "response" } } })).toThrow();
  });

  it("accepts chatCompletions apiType values", () => {
    const config = Config.fromObject({ providers: { openai: { apiKey: "sk-test", apiType: "chatCompletions" } } });

    expect(config.providers.openai.apiType).toBe("chatCompletions");
    expect(config.toObject().providers.openai.apiType).toBe("chatCompletions");
  });

  it("normalizes legacy provider config keys and apiType values", () => {
    const config = Config.fromObject({
      providers: {
        openai: {
          api_key: "sk-test",
          api_base: "https://example.test/v1",
          api_type: "chat_completions",
          extra_headers: { "x-test": "yes" },
          extra_body: { seed: 1 },
        },
      },
    });

    expect(config.providers.openai.apiKey).toBe("sk-test");
    expect(config.providers.openai.apiBase).toBe("https://example.test/v1");
    expect(config.providers.openai.apiType).toBe("chatCompletions");
    expect(config.providers.openai.extraHeaders).toEqual({ "x-test": "yes" });
    expect(config.providers.openai.extraBody).toEqual({ seed: 1 });
    expect(config.toObject().providers.openai).toMatchObject({
      apiKey: "sk-test",
      apiBase: "https://example.test/v1",
      apiType: "chatCompletions",
    });
  });

  it("limits non-auto apiType values to OpenAI", () => {
    expect(() =>
      Config.fromObject({ providers: { custom: { apiBase: "https://example.test/v1", apiType: "responses" } } }),
    ).toThrow(/providers\.custom\.apiType is only supported/);
    expect(() =>
      Config.fromObject({ providers: { custom: { apiBase: "https://example.test/v1", apiType: "chatCompletions" } } }),
    ).toThrow(/providers\.custom\.apiType is only supported/);
    expect(() =>
      Config.fromObject({ providers: { deepseek: { apiKey: "sk-test", apiType: "chatCompletions" } } }),
    ).toThrow(/providers\.deepseek\.apiType is only supported/);
  });

  it("resolves configured defaults without presets", () => {
    const config = Config.fromObject({
      agents: {
        defaults: {
          model: "openai/gpt-4.1",
          provider: "openai",
          maxTokens: 4096,
          contextWindowTokens: 128_000,
          temperature: 0.2,
          reasoningEffort: "low",
        },
      },
    });

    const resolved = config.resolvePreset();
    expect(config.agents.defaults.modelPreset).toBeNull();
    expect(config.modelPresets).toEqual({});
    expect(resolved.model).toBe("openai/gpt-4.1");
    expect(resolved.provider).toBe("openai");
    expect(resolved.maxTokens).toBe(4096);
    expect(resolved.contextWindowTokens).toBe(128_000);
    expect(resolved.temperature).toBe(0.2);
    expect(resolved.reasoningEffort).toBe("low");
  });

  it("resolves the active named preset", () => {
    const config = Config.fromObject({
      modelPresets: {
        fast: {
          model: "openai/gpt-4.1",
          provider: "openai",
          maxTokens: 4096,
          contextWindowTokens: 32_768,
          temperature: 0.5,
          reasoningEffort: "low",
        },
      },
      agents: { defaults: { modelPreset: "fast" } },
    });

    const resolved = config.resolvePreset();
    expect(resolved.model).toBe("openai/gpt-4.1");
    expect(resolved.provider).toBe("openai");
    expect(resolved.maxTokens).toBe(4096);
    expect(resolved.contextWindowTokens).toBe(32_768);
    expect(resolved.temperature).toBe(0.5);
    expect(resolved.reasoningEffort).toBe("low");
  });

  it("resolves default from agents.defaults even when a named preset is active", () => {
    const config = Config.fromObject({
      agents: { defaults: { model: "openai/gpt-4.1", provider: "openai", modelPreset: "fast" } },
      modelPresets: { fast: { model: "openai/gpt-4.1-mini", provider: "openai" } },
    });

    expect(config.resolvePreset().model).toBe("openai/gpt-4.1-mini");
    expect(config.resolvePreset("default").model).toBe("openai/gpt-4.1");
  });

  it("accepts camel-case modelPresets root key", () => {
    const config = Config.fromObject({ modelPresets: { fast: { model: "openai/gpt-4.1", provider: "openai" } } });

    expect(config.modelPresets.fast.model).toBe("openai/gpt-4.1");
    expect(config.modelPresets.fast.provider).toBe("openai");
  });

  it("can resolve a named preset without activating it", () => {
    const config = Config.fromObject({
      modelPresets: {
        fast: { model: "openai/gpt-4.1", provider: "openai" },
        deep: { model: "anthropic/claude-opus-4-5", provider: "anthropic" },
      },
      agents: { defaults: { modelPreset: "fast" } },
    });

    const resolved = config.resolvePreset("deep");
    expect(resolved.model).toBe("anthropic/claude-opus-4-5");
    expect(resolved.provider).toBe("anthropic");
  });

  it("rejects unknown active presets", () => {
    expect(() => Config.fromObject({ agents: { defaults: { modelPreset: "unknown" } } })).toThrow(
      /modelPreset 'unknown' not found in modelPresets/,
    );
  });

  it("accepts explicit default modelPreset name", () => {
    const config = Config.fromObject({ agents: { defaults: { model: "openai/gpt-4.1", modelPreset: "default" } } });

    expect(config.resolvePreset().model).toBe("openai/gpt-4.1");
  });

  it("rejects reserved default preset names", () => {
    expect(() => Config.fromObject({ modelPresets: { default: { model: "custom-model" } } })).toThrow(
      /modelPreset name 'default' is reserved/,
    );
  });

  it("rejects unknown named presets", () => {
    expect(() => new Config().resolvePreset("missing")).toThrow(/modelPreset 'missing' not found/);
  });

  it("matches provider using the active preset model", () => {
    const config = Config.fromObject({
      providers: { openai: { apiKey: "sk-test" } },
      modelPresets: { fast: { model: "openai/gpt-4.1", provider: "openai" } },
      agents: { defaults: { modelPreset: "fast" } },
    });

    expect(config.getProviderName()).toBe("openai");
  });

  it("matches provider using a forced preset provider", () => {
    const config = Config.fromObject({
      providers: { anthropic: { apiKey: "sk-test" } },
      modelPresets: { fast: { model: "anthropic/claude-opus-4-5", provider: "anthropic" } },
      agents: { defaults: { modelPreset: "fast" } },
    });

    expect(config.getProviderName()).toBe("anthropic");
  });

  it("routes forced Novita model-api models to Novita defaults", () => {
    const config = Config.fromObject({
      providers: { novita: { apiKey: "sk-test" } },
      agents: { defaults: { model: "deepseek-v4-pro", provider: "novita" } },
    });

    expect(config.getProviderName()).toBe("novita");
    expect(config.getApiBase()).toBe("https://api.novita.ai/openai");
  });
});
