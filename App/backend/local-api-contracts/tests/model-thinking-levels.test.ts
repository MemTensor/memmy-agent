import { describe, expect, it } from "vitest";
import { defaultThinkingLevel, isThinkingToggleOnly, resolveThinkingEnabled, resolveThinkingLevel, type ModelThinkingConfig } from "../src/model-thinking-levels.js";
const config: ModelThinkingConfig = { switchable: true, defaultEnabled: true, levels: ["low", "medium", "high"], defaultLevel: "medium" };
describe("thinking configuration resolution", () => {
  it("uses explicit choices and configuration defaults", () => {
    expect(resolveThinkingEnabled(config, undefined)).toBe(true);
    expect(resolveThinkingEnabled(config, false)).toBe(false);
    expect(resolveThinkingEnabled({ ...config, switchable: false }, false)).toBe(true);
    expect(resolveThinkingLevel(config, undefined)).toBe("medium");
    expect(resolveThinkingLevel(config, "high")).toBe("high");
    expect(resolveThinkingLevel(config, "retired")).toBe("medium");
  });
  it("uses the first configured level or no level without inventing medium", () => {
    expect(resolveThinkingLevel({ ...config, defaultLevel: undefined, levels: ["high", "low"] }, "retired")).toBe("high");
    expect(resolveThinkingLevel({ ...config, defaultLevel: undefined, levels: [] }, "high")).toBeNull();
    expect(isThinkingToggleOnly({ ...config, defaultLevel: undefined, levels: [] })).toBe(true);
    expect(isThinkingToggleOnly(null)).toBe(false);
  });
  it("retains the default picker for user-authored custom model forms", () => {
    expect(defaultThinkingLevel(["low", "medium", "high"])).toBe("medium");
    expect(defaultThinkingLevel(["low", "high"])).toBe("low");
    expect(defaultThinkingLevel([])).toBeUndefined();
  });
});
