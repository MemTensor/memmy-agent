// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import type { UpdateCoordinatorValue } from "../../app/update-coordinator.js";
import { appActions } from "../../state/app-actions.js";
import { appReducer, createInitialAppState } from "../../state/app-reducer.js";
import { SettingsPageView } from "../settings-page.js";
import { mockBootstrap } from "./fixtures/bootstrap.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const update: UpdateCoordinatorValue = {
  appVersion: "1.1.1",
  phase: "idle",
  preparedUpdatePath: null,
  downloadProgress: null,
  feedback: null,
  requestInlineAction: vi.fn(async () => undefined),
  requestPrimaryAction: vi.fn(async () => undefined)
};

const state = appReducer(
  createInitialAppState(),
  appActions.bootstrapLoaded(mockBootstrap, "/settings")
);

describe("SettingsPage Windows launch at login", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    Reflect.deleteProperty(window, "memmy");
  });

  it("loads the effective Windows state and writes changes through the desktop bridge", async () => {
    const getLaunchAtLogin = vi.fn(async () => true);
    const setLaunchAtLogin = vi.fn(async () => false);
    defineMemmyBridge({ getLaunchAtLogin, setLaunchAtLogin });

    await renderSettings("win32");
    expect(getLaunchAtLogin).toHaveBeenCalledOnce();
    expect(launchAtLoginToggle().getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      launchAtLoginToggle().click();
      await Promise.resolve();
    });

    expect(setLaunchAtLogin).toHaveBeenCalledWith(false);
    expect(launchAtLoginToggle().getAttribute("aria-checked")).toBe("false");
  });

  it("keeps the existing local toggle interaction on non-Windows platforms", async () => {
    const getLaunchAtLogin = vi.fn(async () => true);
    const setLaunchAtLogin = vi.fn(async () => true);
    defineMemmyBridge({ getLaunchAtLogin, setLaunchAtLogin });

    await renderSettings("darwin");
    expect(getLaunchAtLogin).not.toHaveBeenCalled();

    act(() => launchAtLoginToggle().click());

    expect(setLaunchAtLogin).not.toHaveBeenCalled();
    expect(launchAtLoginToggle().getAttribute("aria-checked")).toBe("true");
  });

  const renderSettings = async (platform: string): Promise<void> => {
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <SettingsPageView
            state={state}
            dispatch={vi.fn()}
            platform={platform}
            update={update}
          />
        </I18nProvider>
      );
      await Promise.resolve();
    });
  };

  const launchAtLoginToggle = (): HTMLButtonElement => {
    const label = [...container.querySelectorAll("div")].find((element) => element.textContent === "开机自启动");
    const toggle = label?.parentElement?.parentElement?.querySelector<HTMLButtonElement>('button[role="switch"]');
    if (!toggle) {
      throw new Error("Launch-at-login toggle was not rendered");
    }
    return toggle;
  };
});

const defineMemmyBridge = (launchAtLogin: {
  getLaunchAtLogin: () => Promise<boolean>;
  setLaunchAtLogin: (enabled: boolean) => Promise<boolean>;
}): void => {
  Object.defineProperty(window, "memmy", {
    configurable: true,
    value: {
      platform: "win32",
      getLogLevel: vi.fn(async () => "info" as const),
      ...launchAtLogin
    }
  });
};
