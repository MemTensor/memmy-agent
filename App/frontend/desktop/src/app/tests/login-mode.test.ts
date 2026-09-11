/** Login mode tests. */
import { describe, expect, it, vi } from "vitest";
import type { ConfigClient } from "../../api/config-client.js";
import { persistLoginModeSelection } from "../login-mode.js";

describe("persistLoginModeSelection", () => {
  it("登录账号后先刷新 canonical 模型配置，再完成 onboarding", async () => {
    const calls: string[] = [];
    const dispatch = vi.fn();
    const modelConfig = {
      provider: "memmy_account",
      endpoint: "https://cloud.example.test/v1",
      model: "platform-model",
      apiKey: "",
      apiKeyMasked: "",
      configured: true
    } as Awaited<ReturnType<ConfigClient["getModelConfig"]>>;
    const configClient = {
      async updateSettings(settings) {
        calls.push(`settings:${settings.userMode}`);
        return settings;
      },
      async updateOnboarding(onboarding) {
        calls.push(`onboarding:${onboarding.currentStep}`);
        return onboarding;
      },
      async getModelConfig() {
        calls.push("model-config");
        return modelConfig;
      }
    } satisfies Pick<ConfigClient, "updateSettings" | "updateOnboarding" | "getModelConfig">;

    await persistLoginModeSelection({
      configClient,
      dispatch,
      userMode: "account",
      onboarding: { currentStep: "permissions_required" }
    });

    expect(calls).toEqual(["settings:account", "model-config", "onboarding:permissions_required"]);
    expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual([
      "settings/updated",
      "modelConfig/updated",
      "onboarding/updated"
    ]);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: "modelConfig/updated",
      config: modelConfig
    }));
  });

  it("账号模式 canonical 模型配置刷新失败时不渲染旧账号候选", async () => {
    const dispatch = vi.fn();
    const configClient = {
      async updateSettings(settings) {
        return settings;
      },
      async updateOnboarding(onboarding) {
        return onboarding;
      },
      async getModelConfig() {
        throw new Error("model config offline");
      }
    } satisfies Pick<ConfigClient, "updateSettings" | "updateOnboarding" | "getModelConfig">;

    await expect(persistLoginModeSelection({
      configClient,
      dispatch,
      userMode: "account",
      onboarding: { currentStep: "permissions_required" }
    })).rejects.toThrow("model config offline");

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("persists BYOK mode and onboarding step through config client", async () => {
    const calls: string[] = [];
    const dispatch = vi.fn();
    const configClient = {
      async updateSettings(settings) {
        calls.push(`settings:${settings.userMode}`);
        return settings;
      },
      async updateOnboarding(onboarding) {
        calls.push(`onboarding:${onboarding.currentStep}`);
        return onboarding;
      },
      async getModelConfig() {
        throw new Error("BYOK mode must not load account model config");
      }
    } satisfies Pick<ConfigClient, "updateSettings" | "updateOnboarding" | "getModelConfig">;

    await persistLoginModeSelection({
      configClient,
      dispatch,
      userMode: "byok",
      onboarding: { currentStep: "byok_setup_required" }
    });

    expect(calls).toEqual(["settings:byok", "onboarding:byok_setup_required"]);
    expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual(["settings/updated", "onboarding/updated"]);
  });

  it("配置接口失败时抛出错误，避免把未持久化模式伪装成成功", async () => {
    const dispatch = vi.fn();
    const configClient = {
      async updateSettings() {
        throw new Error("settings offline");
      },
      async updateOnboarding() {
        throw new Error("onboarding offline");
      },
      async getModelConfig() {
        throw new Error("BYOK mode must not load account model config");
      }
    } satisfies Pick<ConfigClient, "updateSettings" | "updateOnboarding" | "getModelConfig">;

    await expect(persistLoginModeSelection({
      configClient,
      dispatch,
      userMode: "byok",
      onboarding: { currentStep: "byok_setup_required" }
    })).rejects.toThrow("settings offline");

    expect(dispatch).not.toHaveBeenCalled();
  });
});
