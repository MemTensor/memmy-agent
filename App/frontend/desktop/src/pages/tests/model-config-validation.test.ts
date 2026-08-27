/** Model config validation tests. */
import { describe, expect, it } from "vitest";
import {
  canSaveOptionalModelConfig,
  canSaveModelConfig,
  createModelConfigValidationKey,
  type ModelConfigValidationState
} from "../model-config-validation.js";

describe("model config validation", () => {
  const form = {
    provider: "openai",
    endpoint: "https://api.openai.com/v1",
    model: "gpt-5.5",
    apiKey: "sk-test"
  };

  it("allows saving only when current form values have a successful test or saved signature", () => {
    const state: ModelConfigValidationState = {
      status: "success",
      message: "连接成功",
      testedKey: createModelConfigValidationKey(form)
    };
    const savedState: ModelConfigValidationState = {
      status: "idle",
      message: null,
      testedKey: createModelConfigValidationKey(form)
    };

    expect(canSaveModelConfig(form, state)).toBe(true);
    expect(canSaveModelConfig(form, savedState)).toBe(true);
    expect(canSaveModelConfig({ ...form, model: "gpt-4o" }, state)).toBe(false);
    expect(canSaveModelConfig({ ...form, model: "gpt-4o" }, savedState)).toBe(false);
  });

  it("blocks saving while unverified idle, testing, or failed", () => {
    expect(canSaveModelConfig(form, { status: "idle", message: null, testedKey: null })).toBe(false);
    expect(canSaveModelConfig(form, { status: "testing", message: null, testedKey: null })).toBe(false);
    expect(canSaveModelConfig(form, { status: "error", message: "invalid api key", testedKey: createModelConfigValidationKey(form) })).toBe(false);
  });

  it("allows disabled optional model slots and gates enabled optional slots", () => {
    const state: ModelConfigValidationState = {
      status: "success",
      message: "连接成功",
      testedKey: createModelConfigValidationKey(form)
    };

    expect(canSaveOptionalModelConfig(false, form, { status: "idle", message: null, testedKey: null })).toBe(true);
    expect(canSaveOptionalModelConfig(true, form, state)).toBe(true);
    expect(canSaveOptionalModelConfig(true, { ...form, apiKey: "sk-next" }, state)).toBe(false);
  });
});
