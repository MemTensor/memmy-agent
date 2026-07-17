/** Login mode tests. */
import { describe, expect, it, vi } from "vitest";
import type { ConfigClient } from "../../api/config-client.js";
import { persistLoginModeSelection } from "../login-mode.js";

describe("persistLoginModeSelection", () => {
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
      }
    } satisfies Pick<ConfigClient, "updateSettings" | "updateOnboarding">;

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
      }
    } satisfies Pick<ConfigClient, "updateSettings" | "updateOnboarding">;

    await expect(persistLoginModeSelection({
      configClient,
      dispatch,
      userMode: "byok",
      onboarding: { currentStep: "byok_setup_required" }
    })).rejects.toThrow("settings offline");

    expect(dispatch).not.toHaveBeenCalled();
  });
});
