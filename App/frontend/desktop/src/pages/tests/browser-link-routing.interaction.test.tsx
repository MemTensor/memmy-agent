// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { AgentMessageContent } from "../agent-message-content.js";
import { MEMMY_BROWSER_OPEN_EVENT } from "../browser-panel.js";
import { SETTINGS_BROWSER_EXTENSION_EVENT, SETTINGS_EXCEL_CONNECTION_EVENT } from "../settings-nav.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("chat links and the built-in browser preference", () => {
  afterEach(() => { Reflect.deleteProperty(window, "memmy"); document.body.replaceChildren(); });

  it("routes a normal chat link into the right sidebar when selected", async () => {
    const values = new Map([["memmy.browser.preferences.v1", JSON.stringify({ webLinks: "memmy", localLinks: "memmy", showFullUrl: false })]]);
    Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null } });
    Object.defineProperty(window, "memmy", { configurable: true, value: {} });
    const events: string[] = [];
    const listener = (event: Event) => events.push((event as CustomEvent<{ url: string }>).detail.url);
    window.addEventListener(MEMMY_BROWSER_OPEN_EVENT, listener);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<I18nProvider language="zh-CN"><AgentMessageContent content="[Example](https://example.com/report)" /></I18nProvider>));
      const link = container.querySelector("a") as HTMLAnchorElement;
      await act(async () => link.click());
      expect(events).toEqual(["https://example.com/report"]);
    } finally {
      act(() => root.unmount());
      window.removeEventListener(MEMMY_BROWSER_OPEN_EVENT, listener);
    }
  });

  it("opens the browser extension setup in Settings from the Agent's install link", async () => {
    const opened = vi.fn();
    const browserOpened = vi.fn();
    window.addEventListener(SETTINGS_BROWSER_EXTENSION_EVENT, opened);
    window.addEventListener(MEMMY_BROWSER_OPEN_EVENT, browserOpened);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<I18nProvider language="zh-CN"><AgentMessageContent
        content="可以[安装浏览器插件](memmy://settings/browser-extension)，也可以先继续。[危险](memmy://settings/other)" /></I18nProvider>));
      const [install, other] = [...container.querySelectorAll("a")] as HTMLAnchorElement[];
      expect(install.getAttribute("href")).toBe("memmy://settings/browser-extension");
      expect(other.getAttribute("href")).toBe("");
      await act(async () => install.click());
      expect(opened).toHaveBeenCalledOnce();
      expect(window.location.hash).toBe("#computer-use-browser-extension");
      expect(browserOpened).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      window.removeEventListener(SETTINGS_BROWSER_EXTENSION_EVENT, opened);
      window.removeEventListener(MEMMY_BROWSER_OPEN_EVENT, browserOpened);
    }
  });

  it("opens the Excel connection from a settings link with the same gear interaction", async () => {
    const opened = vi.fn();
    const extensionOpened = vi.fn();
    const browserOpened = vi.fn();
    window.addEventListener(SETTINGS_EXCEL_CONNECTION_EVENT, opened);
    window.addEventListener(SETTINGS_BROWSER_EXTENSION_EVENT, extensionOpened);
    window.addEventListener(MEMMY_BROWSER_OPEN_EVENT, browserOpened);
    const previousUrl = window.location.href;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<I18nProvider language="zh-CN"><AgentMessageContent
        content="Excel 连接还没开启，点击[开启 Excel 连接](memmy://settings/excel)。[其他入口](memmy://settings/other)" /></I18nProvider>));
      const [excel, other] = [...container.querySelectorAll("a")] as HTMLAnchorElement[];
      expect(excel.getAttribute("href")).toBe("memmy://settings/excel");
      expect(excel.querySelector("svg")).not.toBeNull();
      expect(excel.getAttribute("target")).toBeNull();
      expect(other.getAttribute("href")).toBe("");
      await act(async () => excel.click());
      expect(opened).toHaveBeenCalledOnce();
      expect(window.location.hash).toBe("#computer-use-excel");
      expect(extensionOpened).not.toHaveBeenCalled();
      expect(browserOpened).not.toHaveBeenCalled();
      await act(async () => excel.click());
      expect(opened).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
      window.history.replaceState(null, "", previousUrl);
      window.removeEventListener(SETTINGS_EXCEL_CONNECTION_EVENT, opened);
      window.removeEventListener(SETTINGS_BROWSER_EXTENSION_EVENT, extensionOpened);
      window.removeEventListener(MEMMY_BROWSER_OPEN_EVENT, browserOpened);
    }
  });
});
