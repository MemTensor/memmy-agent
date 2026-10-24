// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerHistorySnapshot, MemmyAgentClient } from "../../api/memmy-agent-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ComputerHistoryBrowserEnhancement } from "../memory/computer-history-browser-enhancement.js";
import { ComputerHistorySubPage } from "../memory/computer-history-sub-page.js";
import { ComputerUseSettings } from "../computer-use-settings.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  window.localStorage.clear(); window.sessionStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  Reflect.deleteProperty(window, "memmy"); vi.useRealTimers(); vi.restoreAllMocks();
});

function state(recording = false): ComputerHistorySnapshot {
  return { observation: { state: recording ? "running" : "stopped", startedAt: null, segmentId: null,
    segmentStartedAt: null, error: null, narrationError: null }, histories: [], workflows: [],
    wechat: { enabled: false, connection: "disabled", phase: null, error: null },
    privacy: { screenshots: false, audio: false, rawRetentionHours: 48, markdownDirectory: "/tmp/histories", eventStreamDirectory: "/tmp/recordings" } };
}

function fixture(platform: "darwin" | "win32", recording = false) {
  let installed: Array<"chrome" | "edge"> = [], connected: Array<"chrome" | "edge"> = [];
  const directory = platform === "darwin" ? "/Applications/Memmy.app/Contents/Resources/browser-extension" : "C:\\Program Files\\Memmy\\resources\\browser-extension";
  const prepareBrowserExtension = vi.fn(async () => ({ status: "browser-opened" as const, directory }));
  const getBrowserExtensionInstallation = vi.fn(async () => ({
    chrome: { installed: installed.includes("chrome"), enabled: installed.includes("chrome") },
    edge: { installed: installed.includes("edge"), enabled: installed.includes("edge") },
  }));
  const listRunningExternalBrowsers = vi.fn(async () => ["chrome", "edge"]);
  const getBrowserExtensionDirectory = vi.fn(async () => directory);
  Object.defineProperty(window, "memmy", { configurable: true, value: { platform, osRelease: platform === "win32" ? "10.0.22631" : "24.0.0",
    prepareBrowserExtension, getBrowserExtensionInstallation, listRunningExternalBrowsers, getBrowserExtensionDirectory,
    revealBrowserExtension: vi.fn(async () => true) } });
  const initial = state(recording);
  const getExternalBrowserStatus = vi.fn(async () => ({ connected, claims: [] }));
  const client = { getExternalBrowserStatus,
    getComputerUseSetting: vi.fn(async () => ({ enabled: true, available: true, binaryAvailable: true })),
    getComputerHistory: vi.fn(async () => initial),
    getComputerHistorySettings: vi.fn(async () => ({ memory: { syncEnabled: true }, observation: {
      defaultApplicationBehavior: "observe", defaultURLBehavior: "observe", rules: [],
    } })),
    updateComputerHistorySettings: vi.fn(), startComputerHistoryObservation: vi.fn(), stopComputerHistoryObservation: vi.fn(),
    pauseComputerHistoryObservation: vi.fn(), resumeComputerHistoryObservation: vi.fn(), setComputerHistoryWeChatAccess: vi.fn(),
    getApplicationIcon: vi.fn(async () => null),
  } as unknown as MemmyAgentClient;
  return { client, prepareBrowserExtension, getExternalBrowserStatus, getBrowserExtensionInstallation,
    listRunningExternalBrowsers, getBrowserExtensionDirectory, directory,
    connect(browser: "chrome" | "edge") { installed = [browser]; connected = [browser]; } };
}
async function render(element: React.ReactNode) {
  await act(async () => root.render(<I18nProvider language="zh-CN">{element}</I18nProvider>));
}
function browserRow(name: string): HTMLElement {
  return [...host.querySelectorAll("strong")].find(node => node.textContent === name)!.parentElement!.parentElement!.parentElement!;
}

describe("shared browser extension entry in Computer History", () => {
  it("starts folded without a switch or any installer/status reads, and stops polling when folded again", async () => {
    vi.useFakeTimers();
    const f = fixture("darwin");
    await render(<ComputerHistoryBrowserEnhancement client={f.client} />);
    const heading = host.querySelector<HTMLButtonElement>(".ch__browser-enhancement-heading")!;
    expect(heading.textContent).toContain("网页历史记录增强");
    expect(heading.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector('[role="switch"]')).toBeNull();
    for (const read of [f.getExternalBrowserStatus, f.getBrowserExtensionInstallation,
      f.listRunningExternalBrowsers, f.getBrowserExtensionDirectory]) expect(read).not.toHaveBeenCalled();
    await act(async () => heading.click());
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    expect(f.getExternalBrowserStatus).toHaveBeenCalledOnce();
    expect(host.querySelector('[role="switch"]')).toBeNull();
    await act(async () => heading.click());
    await act(async () => vi.advanceTimersByTimeAsync(3500));
    expect(f.getExternalBrowserStatus).toHaveBeenCalledOnce();
    expect(f.prepareBrowserExtension).not.toHaveBeenCalled();
    expect(f.client.startComputerHistoryObservation).not.toHaveBeenCalled();
    expect(f.client.updateComputerHistorySettings).not.toHaveBeenCalled();
  });

  it.each(["darwin", "win32"] as const)("uses the same Chrome/Edge installation IPC on %s without changing recording settings", async platform => {
    const f = fixture(platform);
    await render(<ComputerHistoryBrowserEnhancement client={f.client} />);
    await act(async () => host.querySelector<HTMLButtonElement>(".ch__browser-enhancement-heading")!.click());
    for (const [browser, name] of [["chrome", "Google Chrome"], ["edge", "Microsoft Edge"]] as const) {
      const row = browserRow(name);
      expect(row.textContent).toContain("未安装");
      await act(async () => [...row.querySelectorAll("button")].find(button => button.textContent === "安装")!.click());
      expect(f.prepareBrowserExtension).toHaveBeenCalledWith(browser, true);
      expect(row.textContent).toContain(`${browser}://extensions`);
      expect(row.textContent).toContain(f.directory);
    }
    expect(f.prepareBrowserExtension).toHaveBeenCalledTimes(2);
    expect(f.getExternalBrowserStatus).toHaveBeenCalled();
    expect(f.client.startComputerHistoryObservation).not.toHaveBeenCalled();
    expect(f.client.stopComputerHistoryObservation).not.toHaveBeenCalled();
    expect(f.client.setComputerHistoryWeChatAccess).not.toHaveBeenCalled();
    expect(f.client.updateComputerHistorySettings).not.toHaveBeenCalled();
    expect(host.querySelector('[role="switch"]')).toBeNull();
  });

  it.each(["darwin", "win32"] as const)("shows the same installed/live connection when switching from History to Computer Use on %s", async platform => {
    const f = fixture(platform);
    f.connect("chrome");
    await render(<ComputerHistoryBrowserEnhancement client={f.client} />);
    await act(async () => host.querySelector<HTMLButtonElement>(".ch__browser-enhancement-heading")!.click());
    expect(browserRow("Google Chrome").textContent).toContain("已连接，可操作此浏览器中的网页");
    expect(browserRow("Google Chrome").querySelector("button")?.textContent).toBe("管理");
    await render(<ComputerUseSettings client={f.client} platform={platform} />);
    expect(browserRow("Google Chrome").textContent).toContain("已连接，可操作此浏览器中的网页");
    expect(browserRow("Google Chrome").querySelector("button")?.textContent).toBe("管理");
    expect(f.prepareBrowserExtension).not.toHaveBeenCalled();
    expect(f.client.startComputerHistoryObservation).not.toHaveBeenCalled();
  });

  it.each(["darwin", "win32"] as const)("places the folded enhancement immediately below WeChat on an active %s History page", async platform => {
    const f = fixture(platform, true);
    await render(<ComputerHistorySubPage client={f.client} />);
    const wechat = host.querySelector("#computer-history-wechat-label")!.closest(".ch__recording-setting")!;
    const enhancement = host.querySelector(".ch__browser-enhancement")!;
    const permissions = host.querySelector(".ch__sources");
    expect(wechat.nextElementSibling).toBe(enhancement);
    expect(enhancement.nextElementSibling).toBe(permissions);
    const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    const sourcesRule = css.slice(css.indexOf(".ch__settings-card > section[aria-label]"), css.indexOf(".ch__sources-row"));
    expect(sourcesRule).not.toMatch(/border\s*:\s*0/);
    expect(css).toContain(".ch__settings-card > * + * {\n  border-top: 1px solid var(--ch-border);\n}");
    expect(enhancement.querySelector('[role="switch"]')).toBeNull();
    expect(enhancement.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
    expect(f.getExternalBrowserStatus).not.toHaveBeenCalled();
  });

  it.each(["darwin", "win32"] as const)("hides the enhancement on a %s History page before recording starts", async platform => {
    const f = fixture(platform);
    await render(<ComputerHistorySubPage client={f.client} />);
    expect(host.querySelector(".history-launch-card")).not.toBeNull();
    expect(host.querySelector(".ch__browser-enhancement")).toBeNull();
    expect(host.textContent).not.toContain("网页历史记录增强");
    expect(f.getExternalBrowserStatus).not.toHaveBeenCalled();
    expect(f.client.startComputerHistoryObservation).not.toHaveBeenCalled();
    expect(f.client.updateComputerHistorySettings).not.toHaveBeenCalled();
  });
});
