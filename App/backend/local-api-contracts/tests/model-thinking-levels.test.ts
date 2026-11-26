import { describe, expect, it } from "vitest";
import {
  defaultThinkingLevel,
  getModelThinkingConfig,
  isThinkingToggleOnly,
  resolveThinkingEnabled,
  resolveThinkingLevel,
} from "../src/model-thinking-levels.js";

describe("model thinking levels", () => {
  it("returns table config, toggle-only, and default middle level", () => {
    const gpt = getModelThinkingConfig("gpt-5.4");
    expect(gpt).toMatchObject({
      switchable: true,
      defaultEnabled: true,
      defaultLevel: "medium",
    });
    expect(isThinkingToggleOnly(getModelThinkingConfig("claude-haiku-4-5"))).toBe(true);
    expect(getModelThinkingConfig("unlisted-model")).toBeNull();
    expect(defaultThinkingLevel(["low", "medium", "high"])).toBe("medium");
    expect(defaultThinkingLevel(["low", "high"])).toBe("low");
    expect(defaultThinkingLevel([])).toBeUndefined();
  });

  it("resolves session override against table defaults", () => {
    const gpt = getModelThinkingConfig("gpt-5.4")!;
    expect(resolveThinkingEnabled(gpt, undefined)).toBe(true);
    expect(resolveThinkingEnabled(gpt, false)).toBe(false);
    expect(resolveThinkingLevel(gpt, undefined)).toBe("medium");
    expect(resolveThinkingLevel(gpt, "high")).toBe("high");
    expect(resolveThinkingLevel(gpt, "not-a-level")).toBe("medium");

    const alwaysOn = getModelThinkingConfig("claude-fable-5")!;
    expect(resolveThinkingEnabled(alwaysOn, false)).toBe(true);
  });

  it("matches vendor docs for models added on 2026-09-29", () => {
    expect(getModelThinkingConfig("gpt-6-sol")).toEqual({
      switchable: true,
      defaultEnabled: true,
      levels: ["low", "medium", "high", "xhigh", "max"],
      defaultLevel: "medium"
    });
    expect(getModelThinkingConfig("gpt-6-luna")).toEqual(getModelThinkingConfig("gpt-6-sol"));
    expect(getModelThinkingConfig("gpt-6-astra")).toEqual({
      switchable: false,
      defaultEnabled: true,
      levels: ["low", "medium", "high", "xhigh", "max"],
      defaultLevel: "medium"
    });
    expect(resolveThinkingEnabled(getModelThinkingConfig("gpt-6-astra")!, false)).toBe(true);

    expect(getModelThinkingConfig("claude-opus-5-5")).toEqual(getModelThinkingConfig("gpt-6-astra"));
    expect(getModelThinkingConfig("anthropic.claude-opus-5-5")).toEqual(getModelThinkingConfig("claude-opus-5-5"));

    expect(getModelThinkingConfig("gemini-3.8-flash")).toEqual({
      switchable: false,
      defaultEnabled: true,
      levels: ["low", "medium", "high"],
      defaultLevel: "medium"
    });

    const deepseek = {
      switchable: true,
      defaultEnabled: true,
      levels: ["low", "high", "max"],
      defaultLevel: "high"
    };
    expect(getModelThinkingConfig("deepseek-flash")).toEqual(deepseek);
    expect(getModelThinkingConfig("deepseek-v4.1-flash")).toEqual(deepseek);
  });
});
