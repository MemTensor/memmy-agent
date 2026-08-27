import { describe, expect, it } from "vitest";
import { CONTEXT_SAFETY_BUFFER_TOKENS } from "../../src/token-budget.js";
import {
  MODEL_INPUT_CAPABILITIES,
  MODEL_INPUT_CAPABILITIES_REVIEWED_AT,
} from "../../src/providers/model-input-capabilities.js";
import {
  defineModelTokenDefaults,
  getModelTokenDefaults,
  MODEL_TOKEN_DEFAULTS,
  MODEL_TOKEN_DEFAULTS_REVIEWED_AT,
} from "../../src/providers/model-token-defaults.js";

describe("model token defaults", () => {
  it("covers every active public model with immutable, valid values", () => {
    const inputCapabilityModels = Object.keys(MODEL_INPUT_CAPABILITIES)
      .filter((model) => model !== "agent_chat")
      .sort();
    const tokenDefaultModels = Object.keys(MODEL_TOKEN_DEFAULTS).sort();

    expect(tokenDefaultModels).toHaveLength(241);
    expect(tokenDefaultModels).toEqual(inputCapabilityModels);
    expect(MODEL_TOKEN_DEFAULTS_REVIEWED_AT >= MODEL_INPUT_CAPABILITIES_REVIEWED_AT).toBe(true);
    expect(Object.isFrozen(MODEL_TOKEN_DEFAULTS)).toBe(true);

    for (const [model, defaults] of Object.entries(MODEL_TOKEN_DEFAULTS)) {
      expect(model).toBeTruthy();
      expect(model.trim()).toBe(model);
      expect(Number.isSafeInteger(defaults.contextWindowTokens)).toBe(true);
      expect(Number.isSafeInteger(defaults.maxTokens)).toBe(true);
      expect(defaults.contextWindowTokens).toBeGreaterThan(0);
      expect(defaults.maxTokens).toBeGreaterThan(0);
      expect(
        defaults.contextWindowTokens - defaults.maxTokens - CONTEXT_SAFETY_BUFFER_TOKENS,
      ).toBeGreaterThan(0);
      expect(Object.isFrozen(defaults)).toBe(true);
    }
  });

  it("uses exact model IDs without normalization or family inheritance", () => {
    expect(getModelTokenDefaults("gpt-5.6")).toEqual({
      contextWindowTokens: 1_050_000,
      maxTokens: 128_000,
    });
    expect(getModelTokenDefaults("global.anthropic.claude-sonnet-5")).toEqual({
      contextWindowTokens: 1_000_000,
      maxTokens: 128_000,
    });
    expect(getModelTokenDefaults("gemini-3.7-flash")).toEqual({
      contextWindowTokens: 1_048_576,
      maxTokens: 65_536,
    });
    expect(getModelTokenDefaults("qwen3.8-max")).toEqual({
      contextWindowTokens: 1_000_000,
      maxTokens: 65_536,
    });
    expect(getModelTokenDefaults("xopdeepseekv4pro")).toEqual({
      contextWindowTokens: 1_000_000,
      maxTokens: 384_000,
    });
    expect(getModelTokenDefaults("deepseek-v4-flash-vision-exp")).toEqual({
      contextWindowTokens: 1_000_000,
      maxTokens: 384_000,
    });
    expect(getModelTokenDefaults("MiniMax-M3")).toEqual({
      contextWindowTokens: 1_000_000,
      maxTokens: 131_072,
    });
    expect(getModelTokenDefaults("step-1v-8k")).toEqual({
      contextWindowTokens: 8_192,
      maxTokens: 2_048,
    });
    expect(getModelTokenDefaults("Gpt-5.6")).toBeNull();
    expect(getModelTokenDefaults(" gpt-5.6 ")).toBeNull();
    expect(getModelTokenDefaults("gpt-5.6-unknown-snapshot")).toBeNull();
    expect(getModelTokenDefaults(null)).toBeNull();
  });

  it("rejects invalid groups and freezes group model arrays", () => {
    const group = {
      models: ["valid-model"],
      contextWindowTokens: 100_000,
      maxTokens: 10_000,
    };
    const defaults = defineModelTokenDefaults([group]);

    expect(Object.isFrozen(group.models)).toBe(true);
    expect(Object.isFrozen(defaults["valid-model"])).toBe(true);
    expect(() =>
      defineModelTokenDefaults([
        { models: ["same-model"], contextWindowTokens: 100_000, maxTokens: 10_000 },
        { models: ["same-model"], contextWindowTokens: 200_000, maxTokens: 20_000 },
      ]),
    ).toThrow("Duplicate model token default: same-model");
    expect(() =>
      defineModelTokenDefaults([
        { models: [" padded-model "], contextWindowTokens: 100_000, maxTokens: 10_000 },
      ]),
    ).toThrow("Invalid model token default key");
    expect(() =>
      defineModelTokenDefaults([
        { models: ["invalid-numeric-model"], contextWindowTokens: 0, maxTokens: 10_000 },
      ]),
    ).toThrow("contextWindowTokens must be a positive safe integer");
    expect(() =>
      defineModelTokenDefaults([
        { models: ["no-input-budget"], contextWindowTokens: 10_000, maxTokens: 6_000 },
      ]),
    ).toThrow("model token defaults must leave a positive input budget");
  });
});
