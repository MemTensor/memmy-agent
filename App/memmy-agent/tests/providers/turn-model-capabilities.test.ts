import { describe, expect, it } from "vitest";
import { AgentDefaults, Config, ModelPresetConfig } from "../../src/config/schema.js";
import type { RuntimeModelCapabilityCatalogState } from "../../src/providers/model-capability-catalog.js";
import { resolveTurnModelCapabilities } from "../../src/providers/turn-model-capabilities.js";

const thinking = { switchable: true, defaultEnabled: true, levels: ["low", "medium", "high"] as const, defaultLevel: "medium" as const };
const model = {
  inputModalities: ["text", "image"] as const,
  contextWindowTokens: 1050000,
  maxTokens: 128000,
  thinking,
};
const state: RuntimeModelCapabilityCatalogState = {
  mode: "catalog",
  catalog: { catalogVersion: 21, models: {
    "gpt-6-sol": { ...model, inputModalities: [...model.inputModalities], thinking: { ...thinking, levels: [...thinking.levels] } },
    "gpt-4o": { inputModalities: ["text", "image"], contextWindowTokens: 128000, maxTokens: 16384 },
  } },
};
const fallback: RuntimeModelCapabilityCatalogState = { mode: "provider-fallback", catalog: null };
const presetInput = { endpoint: "chat", model: "gpt-6-sol", provider: "openai", source: "byok", capabilities: ["agent"] };

describe("turn model capabilities", () => {
  it("uses the exact cloud record and its thinking defaults", () => {
    expect(resolveTurnModelCapabilities({ state, model: "gpt-6-sol" })).toEqual({
      mode: "catalog", catalogVersion: 21, inputModalities: ["text", "image"],
      contextWindowTokens: 1050000, maxTokens: 128000, thinkingEnabled: true, thinkingLevel: "medium", reasoningEffort: "medium",
    });
  });

  it("never fills a missing cloud model from a source table or a related name", () => {
    expect(resolveTurnModelCapabilities({ state, model: "gpt-6-astra" })).toEqual({ mode: "catalog", catalogVersion: 21 });
    expect(resolveTurnModelCapabilities({ state, model: "gpt-6-sol-latest" })).toEqual({ mode: "catalog", catalogVersion: 21 });
  });

  it("keeps an empty custom configuration separate from a same-name builtin", () => {
    expect(resolveTurnModelCapabilities({ state, model: "gpt-6-sol", customConfig: {} }))
      .toEqual({ mode: "catalog", catalogVersion: 21 });
  });

  it("uses custom model values and explicit token settings", () => {
    const result = resolveTurnModelCapabilities({
      state, model: "gpt-6-sol", customConfig: { maxTokens: 8192, contextWindowTokens: 128000, inputModalities: ["text"] },
      explicitGeneration: { maxTokens: 4096 },
    });
    expect(result).toEqual({ mode: "catalog", catalogVersion: 21, maxTokens: 4096, contextWindowTokens: 128000, inputModalities: ["text"] });
  });

  it("lets explicit session choices override switchable model defaults", () => {
    expect(resolveTurnModelCapabilities({ state, model: "gpt-6-sol", sessionThinking: { enabled: false, level: "high" } }))
      .toMatchObject({ thinkingEnabled: false, reasoningEffort: "none" });
    expect(resolveTurnModelCapabilities({ state, model: "gpt-6-sol", sessionThinking: { enabled: true, level: "high" } }))
      .toMatchObject({ thinkingEnabled: true, thinkingLevel: "high", reasoningEffort: "high" });
  });

  it("keeps an always-on custom model enabled and validates its level", () => {
    expect(resolveTurnModelCapabilities({ state, model: "gpt-6-sol", customConfig: {
      thinking: { switchable: false, defaultEnabled: true, levels: ["low", "high"], defaultLevel: "high" },
    }, sessionThinking: { enabled: false, level: "max" } })).toMatchObject({ thinkingEnabled: true, thinkingLevel: "high", reasoningEffort: "high" });
  });

  it.each([
    { levels: ["low", "high"] as const, defaultLevel: "high" as const, expected: "high" },
    { levels: ["low", "high"] as const, expected: "low" },
  ])("resolves an obsolete session level from the current configuration: %j", ({ levels, expected, ...rest }) => {
    const result = resolveTurnModelCapabilities({
      state, model: "gpt-6-sol", customConfig: { thinking: { switchable: true, defaultEnabled: true, levels: [...levels], ...rest } },
      sessionThinking: { level: "max" },
    });
    expect(result.thinkingLevel).toBe(expected);
    expect(result.reasoningEffort).toBe(expected);
  });

  it("expresses thinking enabled with no invented level for a toggle-only configuration", () => {
    const result = resolveTurnModelCapabilities({ state, model: "gpt-6-sol", customConfig: {
      thinking: { switchable: true, defaultEnabled: true, levels: [] },
    }, sessionThinking: { level: "high" }, providerReasoningEffort: "high" });
    expect(result.thinkingEnabled).toBe(true);
    expect(result).not.toHaveProperty("thinkingLevel");
    expect(result).not.toHaveProperty("reasoningEffort");
  });

  it("does not invent thinking parameters for a record that omits thinking", () => {
    const result = resolveTurnModelCapabilities({ state, model: "gpt-4o" });
    expect(result.mode).toBe("catalog");
    expect(result).not.toHaveProperty("thinkingEnabled");
    expect(result).not.toHaveProperty("reasoningEffort");
  });

  it("keeps the explicit reasoning priority chain when there is no thinking configuration", () => {
    const input = { state, model: "gpt-4o", providerReasoningEffort: "low", agentReasoningEffort: "medium" };
    expect(resolveTurnModelCapabilities(input).reasoningEffort).toBe("low");
    expect(resolveTurnModelCapabilities({ ...input, explicitGeneration: { reasoningEffort: "high" } }).reasoningEffort).toBe("high");
    expect(resolveTurnModelCapabilities({ ...input, sessionThinking: { enabled: true, level: "max" } }).reasoningEffort).toBe("max");
    expect(resolveTurnModelCapabilities({ ...input, sessionThinking: { enabled: false } }).reasoningEffort).toBe("none");
  });

  it("adds no optional tokens, context budget or thinking defaults in Provider fallback", () => {
    expect(resolveTurnModelCapabilities({ state: fallback, model: "gpt-6-sol" })).toEqual({ mode: "provider-fallback" });
  });

  it("retains only supplied explicit values during fallback", () => {
    expect(resolveTurnModelCapabilities({ state: fallback, model: "gpt-6-sol",
      explicitGeneration: { maxTokens: 8192, contextWindowTokens: 128000, reasoningEffort: "high" },
      sessionThinking: { enabled: false },
    })).toEqual({ mode: "provider-fallback", maxTokens: 8192, contextWindowTokens: 128000, thinkingEnabled: false, reasoningEffort: "none" });
  });
});

describe("explicit token configuration provenance", () => {
  it("keeps automatically derived preset values out of explicit settings across serialization", () => {
    const preset = new ModelPresetConfig(presetInput);
    expect(preset.maxTokens).toBe(65536);
    expect(preset.explicitTokenSettings).toEqual({});
    expect(preset.toObject()).not.toHaveProperty("maxTokens");
    expect(new ModelPresetConfig(preset.toObject()).explicitTokenSettings).toEqual({});
  });

  it("retains user token limits, including values equal to source defaults", () => {
    const preset = new ModelPresetConfig({ ...presetInput, maxTokens: 128000, contextWindowTokens: 1050000 });
    expect(new ModelPresetConfig(preset.toObject()).explicitTokenSettings).toEqual({ maxTokens: 128000, contextWindowTokens: 1050000 });
  });

  it("preserves absence and explicit Agent defaults across Config cloning", () => {
    const config = new Config();
    expect(config.agents.defaults.explicitTokenSettings).toEqual({});
    expect(new Config(config.toObject()).agents.defaults.explicitTokenSettings).toEqual({});
    const defaults = new AgentDefaults({ maxTokens: 4096, contextWindowTokens: 200000 });
    expect(new AgentDefaults(defaults.toObject()).explicitTokenSettings).toEqual({ maxTokens: 4096, contextWindowTokens: 200000 });
  });
});
