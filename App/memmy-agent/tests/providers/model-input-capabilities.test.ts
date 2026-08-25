import { describe, expect, it } from "vitest";
import {
  coversInputModalities,
  defineModelInputCapabilities,
  getModelInputModalities,
  MODEL_INPUT_CAPABILITIES,
  MODEL_INPUT_CAPABILITIES_REVIEWED_AT,
  requiredInputModalities,
  type ModelInputModality,
} from "../../src/providers/model-input-capabilities.js";

describe("model input capabilities", () => {
  it("contains only immutable, valid modality sets with text support", () => {
    const allowed = new Set<ModelInputModality>(["text", "image", "video"]);

    expect(MODEL_INPUT_CAPABILITIES_REVIEWED_AT).toBe("2026-08-24");
    expect(Object.keys(MODEL_INPUT_CAPABILITIES)).toHaveLength(242);
    expect(Object.isFrozen(MODEL_INPUT_CAPABILITIES)).toBe(true);
    for (const [model, modalities] of Object.entries(MODEL_INPUT_CAPABILITIES)) {
      expect(model).toBeTruthy();
      expect(modalities.length).toBeGreaterThan(0);
      expect(modalities).toContain("text");
      expect(modalities.every((modality) => allowed.has(modality))).toBe(true);
      expect(new Set(modalities).size).toBe(modalities.length);
      expect(Object.isFrozen(modalities)).toBe(true);
    }
  });

  it("uses exact full model IDs without normalization or family inheritance", () => {
    expect(getModelInputModalities("gpt-5.6")).toEqual(["text", "image"]);
    expect(getModelInputModalities("gemini-3.7-flash")).toEqual(["text", "image", "video"]);
    expect(getModelInputModalities("qwen3.8-max")).toEqual(["text", "image"]);
    expect(getModelInputModalities("claude-sonnet-5")).toEqual(["text", "image"]);
    expect(getModelInputModalities("global.anthropic.claude-sonnet-5")).toEqual(["text", "image"]);
    expect(getModelInputModalities("qwen/qwen3.6-27b")).toEqual(["text", "image"]);
    expect(getModelInputModalities("deepseek-v4-pro")).toEqual(["text"]);
    expect(getModelInputModalities("deepseek-v4-flash-vision-exp")).toEqual(["text", "image"]);
    expect(getModelInputModalities("kimi-k3")).toEqual(["text", "image", "video"]);
    expect(getModelInputModalities("glm-5v-turbo")).toEqual(["text", "image", "video"]);
    expect(getModelInputModalities("qwen3.7-max-2026-05-20")).toEqual(["text"]);
    expect(getModelInputModalities("qwen3.7-max-2026-06-08")).toEqual(["text", "image", "video"]);
    expect(getModelInputModalities("Gpt-5.6")).toEqual(["text"]);
    expect(getModelInputModalities(" gpt-5.6 ")).toEqual(["text"]);
    expect(getModelInputModalities("gpt-5.6-unknown-snapshot")).toEqual(["text"]);
    expect(getModelInputModalities(null)).toEqual(["text"]);
  });

  it("rejects duplicate model keys instead of overwriting them", () => {
    expect(() => defineModelInputCapabilities([
      ["same-model", ["text"]],
      ["same-model", ["text", "image"]],
    ])).toThrow("Duplicate model input capability: same-model");
  });

  it("scans unified messages and checks required modality coverage", () => {
    const textRequired = requiredInputModalities([{ role: "user", content: "hello" }]);
    const imageRequired = requiredInputModalities([{
      role: "tool",
      content: [
        { type: "text", text: "result" },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
      ],
    }]);

    expect(textRequired).toEqual(["text"]);
    expect(imageRequired).toEqual(["text", "image"]);
    expect(coversInputModalities(["text", "image"], imageRequired)).toBe(true);
    expect(coversInputModalities(["text"], imageRequired)).toBe(false);
  });
});
