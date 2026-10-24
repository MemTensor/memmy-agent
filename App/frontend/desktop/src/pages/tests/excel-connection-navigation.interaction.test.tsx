// @vitest-environment happy-dom
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { MemmyAgentClient } from "../../api/memmy-agent-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { TaskBusProvider } from "../../lib/task-bus.js";
import { appActions } from "../../state/app-actions.js";
import { AppStateProvider, useAppState } from "../../state/app-state.js";
import { AgentMessageContent } from "../agent-message-content.js";
import { AppFrame } from "../app-frame.js";
import { SettingsPageView } from "../settings-page.js";
import { readInitialSettingsTab, writeSettingsTabHash, writeSettingsBrowserExtensionFocus, writeSettingsExcelConnectionFocus, type SettingsTabId } from "../settings-nav.js";
import { mockBootstrap } from "./fixtures/bootstrap.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Excel connection settings navigation", () => {
  it.each(["darwin", "win32"])("navigates from chat and locates Excel without authorizing it on %s", async platform => {
    const originalUrl = window.location.href;
    const originalStorage = Object.getOwnPropertyDescriptor(window, "localStorage");
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    } });
    const setExcelAddinEnabled = vi.fn();
    const client = {
      getComputerUseSetting: vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true }),
      getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }),
      getExcelAddinStatus: vi.fn().mockResolvedValue({ scope: "application", enabled: false, configured: false,
        connected: false, setupCompleted: false, connectionCount: 0, workbooks: [], permissionRequired: false }),
      setExcelAddinEnabled,
    } as unknown as MemmyAgentClient;
    function SettingsShell() {
      const { state, dispatch } = useAppState();
      const [activeTab, setActiveTab] = useState(() => readInitialSettingsTab(window.location.hash));
      const selectTab = (tab: SettingsTabId) => { setActiveTab(tab); writeSettingsTabHash(tab); };
      return <AppFrame title="Test" settingsNav={{ activeTab, onSelectTab: selectTab }}>
        <SettingsPageView state={state} dispatch={dispatch} platform={platform} computerUseClient={client}
          activeTab={activeTab} onActiveTabChange={selectTab}
          update={{ appVersion: "test", phase: "idle", preparedUpdatePath: null, downloadProgress: null,
            feedback: null, requestInlineAction: vi.fn(), requestPrimaryAction: vi.fn() }} />
      </AppFrame>;
    }
    function Shell() {
      const { state, dispatch } = useAppState();
      useEffect(() => { dispatch(appActions.bootstrapLoaded(mockBootstrap, "/main")); }, []);
      if (state.navigation.currentPath === "/settings") return <SettingsShell />;
      return <AppFrame title="Test">
        <AgentMessageContent content="点击[开启 Excel 连接](memmy://settings/excel)完成设置。" />
      </AppFrame>;
    }
    Object.defineProperty(window, "memmy", { configurable: true, value: { platform,
      getLogLevel: vi.fn().mockResolvedValue("info"),
    } });
    window.history.replaceState(null, "", "/main#about");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<AppStateProvider><TaskBusProvider><I18nProvider language="zh-CN">
        <Shell />
      </I18nProvider></TaskBusProvider></AppStateProvider>));
      const link = container.querySelector('a[href="memmy://settings/excel"]') as HTMLAnchorElement;
      expect(link).not.toBeNull();
      await act(async () => link.click());
      const panel = container.querySelector("#settings-panel-computer-use") as HTMLElement;
      const excel = container.querySelector("#computer-use-excel") as HTMLElement;
      expect(panel.hidden).toBe(false);
      expect(excel.className).toMatch(/extensionFocus/);
      expect(container.querySelector("#computer-use-browser-extension")?.className).not.toMatch(/extensionFocus/);
      expect((excel.querySelector('input[aria-label="Microsoft Excel"]') as HTMLInputElement).checked).toBe(false);
      expect(setExcelAddinEnabled).not.toHaveBeenCalled();
      // A link can also arrive while Settings is mounted on another tab.
      const preferences = container.querySelector("#settings-tab-preferences") as HTMLButtonElement;
      await act(async () => preferences.click());
      expect(panel.hidden).toBe(true);
      await act(async () => writeSettingsExcelConnectionFocus());
      expect(panel.hidden).toBe(false);
      expect(container.querySelector("#computer-use-excel")?.className).toMatch(/extensionFocus/);
      expect(setExcelAddinEnabled).not.toHaveBeenCalled();
      // Switching to the other connection must not replay the previous focus.
      await act(async () => preferences.click());
      await act(async () => writeSettingsBrowserExtensionFocus());
      expect(container.querySelector("#computer-use-browser-extension")?.className).toMatch(/extensionFocus/);
      expect(container.querySelector("#computer-use-excel")?.className).not.toMatch(/extensionFocus/);
      await act(async () => preferences.click());
      await act(async () => writeSettingsExcelConnectionFocus());
      expect(container.querySelector("#computer-use-excel")?.className).toMatch(/extensionFocus/);
      expect(container.querySelector("#computer-use-browser-extension")?.className).not.toMatch(/extensionFocus/);
    } finally {
      act(() => root.unmount());
      container.remove();
      window.history.replaceState(null, "", originalUrl);
      Reflect.deleteProperty(window, "memmy");
      if (originalStorage) Object.defineProperty(window, "localStorage", originalStorage);
      else Reflect.deleteProperty(window, "localStorage");
    }
  });
});
