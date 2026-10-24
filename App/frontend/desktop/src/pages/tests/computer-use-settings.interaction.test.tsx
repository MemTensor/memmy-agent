// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExcelControlStatus, MemmyAgentClient } from "../../api/memmy-agent-client.js";
import type { BrowserAllowAllState } from '@memmy/local-api-contracts';
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ComputerUseSettings } from "../computer-use-settings.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function applicationExcelStatus(overrides: Partial<ExcelControlStatus> = {}): ExcelControlStatus {
  return { scope: "application", connectionMode: "native", available: true, enabled: false,
    configured: false, connected: false, connectionCount: 0, setupCompleted: false,
    manifestUrl: null, manualInstallPath: null, workbooks: [], activeWorkbookId: null,
    permissionRequired: false, lockedUse: { supported: false, reason: "nativeLockGuardianUnavailable" },
    ...overrides };
}

describe("computer use settings", () => {
  let container: HTMLDivElement;
  let root: Root;

  function excelRowText(): string {
    const row = container.querySelector('input[aria-label="Microsoft Excel"]')?.parentElement;
    if (!row) throw new Error("Excel setting row is missing");
    return row.textContent ?? "";
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("keeps Memmy browser website rules and download preferences out of computer use", async () => {
    const getBrowserUseSitePolicies = vi.fn().mockResolvedValue([]);
    const getBrowserDownloadSettings = vi.fn().mockResolvedValue({ directory: '/saved/downloads', askBeforeDownload: true });
    Object.defineProperty(window, "memmy", { configurable: true, value: {
      getBrowserUseSitePolicies, getBrowserDownloadSettings,
    } });
    const client = {
      getComputerUseSetting: vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true }),
      getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }),
    } as unknown as MemmyAgentClient;
    try {
      await act(async () => {
        root.render(<I18nProvider language="zh-CN"><ComputerUseSettings client={client} platform="darwin" /></I18nProvider>);
      });
      for (const label of ["Agent 网站规则", "下载位置", "每次下载前询问保存位置"]) {
        expect(container.textContent).not.toContain(label);
      }
      expect(container.querySelector('.memmy-browser-use-policies')).toBeNull();
      expect(getBrowserUseSitePolicies).not.toHaveBeenCalled();
      expect(getBrowserDownloadSettings).not.toHaveBeenCalled();
      expect(container.textContent).toContain("Google Chrome");
      expect(container.textContent).toContain("Microsoft Excel");
    } finally {
      Reflect.deleteProperty(window, "memmy");
    }
  });

  it("highlights the browser extension setup when opened from a chat install link", async () => {
    const client = {
      getComputerUseSetting: vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true }),
      getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }),
    } as unknown as MemmyAgentClient;
    await act(async () => {
      root.render(<I18nProvider language="zh-CN"><ComputerUseSettings client={client} platform="darwin" /></I18nProvider>);
    });
    const section = container.querySelector("#computer-use-browser-extension");
    expect(section?.textContent).toContain("Google Chrome");
    expect(section?.className).not.toMatch(/extensionFocus/);
    await act(async () => {
      root.render(<I18nProvider language="zh-CN"><ComputerUseSettings client={client} platform="darwin"
        browserExtensionFocusNonce={1} /></I18nProvider>);
    });
    expect(section?.className).toMatch(/extensionFocus/);
  });

  it.each(["darwin", "win32"])("locates Excel without enabling it when opened from a chat link on %s", async platform => {
    const setExcelAddinEnabled = vi.fn();
    const client = {
      getComputerUseSetting: vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true }),
      getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }),
      getExcelAddinStatus: vi.fn().mockResolvedValue(applicationExcelStatus()),
      setExcelAddinEnabled,
    } as unknown as MemmyAgentClient;
    const render = (nonce: number) => <I18nProvider language="zh-CN"><ComputerUseSettings
      client={client} platform={platform} excelConnectionFocusNonce={nonce} /></I18nProvider>;
    await act(async () => root.render(render(0)));
    const section = container.querySelector("#computer-use-excel");
    const browser = container.querySelector("#computer-use-browser-extension");
    const toggle = section?.querySelector('input[aria-label="Microsoft Excel"]') as HTMLInputElement;
    expect(section?.textContent).toContain("Microsoft Excel");
    expect(section?.className).not.toMatch(/extensionFocus/);
    await act(async () => root.render(render(1)));
    expect(section?.className).toMatch(/extensionFocus/);
    expect(browser?.className).not.toMatch(/extensionFocus/);
    expect(toggle.checked).toBe(false);
    expect(setExcelAddinEnabled).not.toHaveBeenCalled();
  });

  it("keeps computer use on and uses the top switch only for allowing every app", async () => {
    const getComputerUseSetting = vi.fn().mockResolvedValue({ enabled: false, available: false, binaryAvailable: true });
    const setComputerUseEnabled = vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true });
    const setNativeAppAllowAll = vi.fn().mockResolvedValue(true);
    Object.defineProperty(window, "memmy", { configurable: true, value: {
      getNativeAppAllowAll: vi.fn().mockResolvedValue(false), setNativeAppAllowAll,
    } });
    const client = { getComputerUseSetting, setComputerUseEnabled,
      getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }) } as unknown as MemmyAgentClient;
    try {
      await act(async () => {
        root.render(<I18nProvider language="zh-CN"><ComputerUseSettings client={client} platform="win32" /></I18nProvider>);
      });
      const toggle = container.querySelector('input[role="switch"][aria-label="始终允许任意应用"]') as HTMLInputElement;
      expect(toggle.checked).toBe(false);
      expect(setComputerUseEnabled).toHaveBeenCalledWith(true);
      expect(container.textContent).toContain("勾选后不再询问");
      expect(container.textContent).not.toContain("锁屏操作");
      expect(container.textContent).not.toContain("此平台不支持");
      await act(async () => { toggle.click(); });
      expect(setNativeAppAllowAll).toHaveBeenCalledWith(true);
      expect(setComputerUseEnabled).not.toHaveBeenCalledWith(false);
      expect(toggle.checked).toBe(true);
      expect(container.textContent).toContain("暂时无法读取 Memmy 扩展状态");
    } finally {
      Reflect.deleteProperty(window, "memmy");
    }
  });

  it.each(['darwin', 'win32'])('does not interpret a missing installation bridge as absent extensions on %s', async platform => {
    const listInstalledBrowserExtensions = vi.fn().mockResolvedValue([]);
    const prepareBrowserExtension = vi.fn().mockResolvedValue({ status: "browser-opened", directory: "/app/browser-extension" });
    Object.defineProperty(window, "memmy", { configurable: true, value: {
      listInstalledBrowserExtensions, prepareBrowserExtension,
    } });
    const client = {
      getComputerUseSetting: vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true }),
      getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }),
    } as unknown as MemmyAgentClient;
    try {
      await act(async () => root.render(<I18nProvider language="zh-CN">
        <ComputerUseSettings client={client} platform={platform} />
      </I18nProvider>));
      const browsers = container.querySelector("#computer-use-browser-extension")!;
      expect(browsers.textContent).toContain("暂时无法读取 Memmy 扩展状态");
      expect(browsers.textContent).not.toContain("未安装");
      expect(Array.from(browsers.querySelectorAll("button")).map(button => button.textContent)).toEqual(["管理", "管理"]);
      expect(listInstalledBrowserExtensions).not.toHaveBeenCalled();
      expect(prepareBrowserExtension).not.toHaveBeenCalled();
      await act(async () => { browsers.querySelector("button")!.click(); });
      expect(prepareBrowserExtension).toHaveBeenCalledExactlyOnceWith("chrome", true);
      expect(container.querySelector("#memmy-chrome-extension-guide")).not.toBeNull();
    } finally {
      Reflect.deleteProperty(window, "memmy");
    }
  });

  it.each(['darwin', 'win32'])('syncs the computer switch from inherited browser state without a stale read on %s', async platform => {
    let changed!: (state: BrowserAllowAllState) => void;
    let finishRead!: (state: BrowserAllowAllState) => void;
    const unsubscribe = vi.fn();
    const getBrowserAllowAll = vi.fn().mockReturnValueOnce(new Promise<BrowserAllowAllState>(resolve => { finishRead = resolve; }))
      .mockResolvedValue({ enabled: true, inherited: false, effective: true });
    Object.defineProperty(window, 'memmy', { configurable: true, value: {
      getBrowserAllowAll, setNativeAppAllowAll: vi.fn(),
      onBrowserAllowAllChanged: vi.fn((listener: (state: BrowserAllowAllState) => void) => { changed = listener; return unsubscribe; }),
    } });
    const client = {
      getComputerUseSetting: vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true }),
      getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }),
    } as unknown as MemmyAgentClient;
    try {
      await act(async () => root.render(<I18nProvider language="zh-CN"><ComputerUseSettings client={client} platform={platform} /></I18nProvider>));
      const toggle = container.querySelector('input[role="switch"][aria-label="始终允许任意应用"]') as HTMLInputElement;
      expect(toggle.disabled).toBe(true);
      await act(async () => changed({ enabled: false, inherited: true, effective: true }));
      await act(async () => finishRead({ enabled: false, inherited: false, effective: false }));
      expect(toggle.checked).toBe(true);
      expect(toggle.disabled).toBe(false);
      await act(async () => window.dispatchEvent(new Event('focus')));
      // Independent website permission does not enable all application control.
      expect(toggle.checked).toBe(false);
      expect(getBrowserAllowAll).toHaveBeenCalledTimes(2);
      await act(async () => root.render(<></>));
      expect(unsubscribe).toHaveBeenCalledOnce();
    } finally {
      Reflect.deleteProperty(window, 'memmy');
    }
  });

  it.each(["darwin", "win32"])("offers only manual browser installation on %s", async platform => {
    sessionStorage.setItem("memmy.browser-extension-install.v1", "retired-install");
    const prepareBrowserExtension = vi.fn().mockResolvedValue({ status: "browser-opened", directory: "/app/browser-extension" });
    const getBrowserExtensionInstallation = vi.fn().mockResolvedValue({
      chrome: { installed: true, enabled: true }, edge: { installed: false, enabled: false },
    });
    Object.defineProperty(window, "memmy", { configurable: true, value: {
      prepareBrowserExtension, getBrowserExtensionInstallation,
    } });
    const client = {
      getComputerUseSetting: vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true }),
      getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }),
    } as unknown as MemmyAgentClient;
    try {
      await act(async () => {
        root.render(<I18nProvider language="zh-CN"><ComputerUseSettings client={client} platform={platform} /></I18nProvider>);
      });
      const installButtons = Array.from(container.querySelectorAll("button")).filter(button => button.textContent === "安装");
      expect(installButtons).toHaveLength(1);
      const browserRow = (name: string) => Array.from(container.querySelectorAll("strong"))
        .find(node => node.textContent === name)?.parentElement?.parentElement?.textContent;
      expect(browserRow("Google Chrome")).toContain("已安装，等待浏览器连接");
      expect(browserRow("Google Chrome")).toContain("重新安装");
      expect(browserRow("Google Chrome")).not.toContain("检查连接");
      expect(browserRow("Microsoft Edge")).toContain("未安装");
      expect(browserRow("Microsoft Edge")).not.toContain("检查连接");
      expect(container.textContent).not.toContain("修复连接");
      expect(container.textContent).not.toContain("Memmy帮你安装");
      expect(container.textContent).not.toContain("手动安装");
      expect(container.textContent).not.toContain("暂时无法操作浏览器窗口");
      await act(async () => { installButtons[0]!.click(); });
      expect(prepareBrowserExtension).toHaveBeenCalledExactlyOnceWith("edge", true);
      expect(container.querySelector("#memmy-edge-extension-guide")).not.toBeNull();
      expect(installButtons[0]?.getAttribute("aria-expanded")).toBe("true");
      expect(container.textContent).toContain("在浏览器扩展页开启“开发者模式”");
    } finally {
      Reflect.deleteProperty(window, "memmy");
      sessionStorage.clear();
    }
  });

  it("treats a checked allow-all switch as permission for every app", async () => {
    Object.defineProperty(window, "memmy", { configurable: true, value: {
      getNativeAppAllowAll: vi.fn().mockResolvedValue(true),
    } });
    const client = {
      getComputerUseSetting: vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true }),
      getNativeAppApprovals: vi.fn().mockResolvedValue([]),
      getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }),
    } as unknown as MemmyAgentClient;
    try {
      await act(async () => {
        root.render(<I18nProvider language="zh-CN"><ComputerUseSettings client={client} platform="darwin" /></I18nProvider>);
      });
      const toggle = container.querySelector('input[role="switch"][aria-label="始终允许任意应用"]') as HTMLInputElement;
      expect(toggle.checked).toBe(true);
      expect(container.textContent).toContain("已允许任意应用，操作时不再逐个询问");
      expect(container.textContent).not.toContain("暂无始终允许的应用");
    } finally {
      Reflect.deleteProperty(window, "memmy");
    }
  });

  it("adds an always-allowed app to the list after the next refresh", async () => {
    vi.useFakeTimers();
    const approval = { platform: "darwin" as const, appId: "com.apple.calculator",
      displayName: "Calculator", allowedAt: "2026-01-01T00:00:00.000Z" };
    const getNativeAppApprovals = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([approval]);
    const client = {
      getComputerUseSetting: vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true }),
      getNativeAppApprovals,
      getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }),
    } as unknown as MemmyAgentClient;
    try {
      await act(async () => {
        root.render(<I18nProvider language="zh-CN"><ComputerUseSettings client={client} platform="darwin" /></I18nProvider>);
      });
      expect(container.textContent).toContain("暂无始终允许的应用");
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(container.textContent).toContain("Calculator");
    } finally {
      vi.useRealTimers();
    }
  });

  it("only marks Excel connected after a live add-in heartbeat", async () => {
    vi.useFakeTimers();
    try {
    const getComputerUseSetting = vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true });
    const getExcelAddinStatus = vi.fn()
      .mockResolvedValueOnce({ configured: true, connected: false, connectionCount: 0,
        manifestUrl: "https://localhost:32177/manifest.xml", lockedUse: { supported: false, reason: "nativeLockGuardianUnavailable" } })
      .mockResolvedValueOnce({ configured: true, connected: true, connectionCount: 1,
        manifestUrl: "https://localhost:32177/manifest.xml", lockedUse: { supported: false, reason: "nativeLockGuardianUnavailable" } });
    const client = { getComputerUseSetting, getExcelAddinStatus,
      getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }) } as unknown as MemmyAgentClient;
    await act(async () => {
      root.render(<I18nProvider language="zh-CN"><ComputerUseSettings client={client} platform="darwin" /></I18nProvider>);
    });
    expect(container.textContent).toContain("旧版 Excel 加载项：仅连接已打开 Memmy 窗格的工作簿");
    expect(container.textContent).not.toContain("授权一次即可使用");
    expect(container.textContent).toContain("请重启 Excel，并在需要操作的空白或目标工作簿中打开 Memmy 加载项。");
    expect(excelRowText()).not.toContain("已连接");
    expect(container.querySelector('a[download="Memmy-Excel.xml"]')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(getExcelAddinStatus).toHaveBeenCalledTimes(2);
    expect(excelRowText()).toContain("已连接");
    expect(container.textContent).not.toContain("请重启 Excel");
    } finally {
      vi.useRealTimers();
    }
  });

  it("enables application-wide Excel once and stays enabled while no workbook is open", async () => {
    vi.useFakeTimers();
    const enabledStatus = applicationExcelStatus({ enabled: true, configured: true, setupCompleted: true });
    const setExcelAddinEnabled = vi.fn()
      .mockResolvedValueOnce(enabledStatus)
      .mockResolvedValueOnce(applicationExcelStatus());
    const getExcelAddinStatus = vi.fn().mockResolvedValueOnce(applicationExcelStatus())
      .mockResolvedValueOnce({ ...enabledStatus, connected: true, connectionCount: 2,
        workbooks: [{ id: "budget", name: "Budget.xlsx" }, { id: "book2", name: "Book2" }], activeWorkbookId: "book2" });
    const enableExcelAddin = vi.fn();
    const revealExcelAddin = vi.fn();
    const client = {
      getComputerUseSetting: vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true }),
      getExcelAddinStatus, setExcelAddinEnabled, enableExcelAddin, revealExcelAddin,
      getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }),
    } as unknown as MemmyAgentClient;
    try {
      await act(async () => {
        root.render(<I18nProvider language="zh-CN"><ComputerUseSettings client={client} platform="darwin" /></I18nProvider>);
      });
      expect(container.textContent).toContain("允许 Memmy 操作所有 Excel 工作簿，授权一次即可使用");
      expect(setExcelAddinEnabled).not.toHaveBeenCalled();
      const toggle = container.querySelector('input[role="switch"][aria-label="Microsoft Excel"]') as HTMLInputElement;
      await act(async () => { toggle.click(); });
      expect(setExcelAddinEnabled).toHaveBeenCalledTimes(1);
      expect(setExcelAddinEnabled).toHaveBeenNthCalledWith(1, true);
      expect(toggle.checked).toBe(true);
      expect(container.textContent).toContain("打开 Excel 文件后即可使用");
      expect(container.textContent).not.toContain("请重启 Excel");
      expect(container.textContent).not.toContain("不要关掉 Memmy 窗格");
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(5000); });
      expect(getExcelAddinStatus).toHaveBeenCalledTimes(2);
      expect(setExcelAddinEnabled).toHaveBeenCalledTimes(1);
      expect(excelRowText()).toContain("已连接");
      expect(container.textContent).not.toContain("打开 Excel 文件后即可使用");
      await act(async () => { toggle.click(); });
      expect(setExcelAddinEnabled).toHaveBeenNthCalledWith(2, false);
      expect(toggle.checked).toBe(false);
      expect(enableExcelAddin).not.toHaveBeenCalled();
      expect(revealExcelAddin).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a pending Windows Excel status before allowing the switch to be used", async () => {
    let finishCheck!: (value: ExcelControlStatus) => void;
    const pendingCheck = new Promise<ExcelControlStatus>(resolve => { finishCheck = resolve; });
    const setExcelAddinEnabled = vi.fn();
    const client = {
      getComputerUseSetting: vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true }),
      getExcelAddinStatus: vi.fn().mockReturnValue(pendingCheck), setExcelAddinEnabled,
      getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }),
    } as unknown as MemmyAgentClient;
    const render = (activeClient?: MemmyAgentClient) => <I18nProvider language="zh-CN">
      <ComputerUseSettings client={activeClient} platform="win32" /></I18nProvider>;
    await act(async () => { root.render(render()); });
    const section = container.querySelector("#computer-use-excel");
    const toggle = section?.querySelector('input[role="switch"]') as HTMLInputElement;
    expect(section?.textContent).toContain("正在确认 Excel 连接");
    expect(toggle.disabled).toBe(true);
    await act(async () => { root.render(render(client)); });
    expect(section?.textContent).toContain("正在确认 Excel 连接");
    expect(toggle.disabled).toBe(true);
    await act(async () => { toggle.click(); });
    expect(setExcelAddinEnabled).not.toHaveBeenCalled();
    await act(async () => {
      finishCheck(applicationExcelStatus({ enabled: true, configured: true, connected: true }));
      await pendingCheck;
    });
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(false);
    expect(section?.textContent).toContain("已连接");
    expect(section?.textContent).not.toContain("正在确认 Excel 连接");
  });

  it("confirms a Windows Excel grant before showing connected", async () => {
    const connected = applicationExcelStatus({ enabled: true, configured: true, connected: true,
      connectionCount: 1, workbooks: [{ id: "book1", name: "Book1" }], activeWorkbookId: "book1" });
    const unavailable = applicationExcelStatus({ enabled: true, configured: true,
      error: "The running Excel application is not available for control. HRESULT -2147221021" });
    let finishCheck!: (value: ExcelControlStatus) => void;
    const pendingCheck = new Promise<ExcelControlStatus>(resolve => { finishCheck = resolve; });
    const getExcelAddinStatus = vi.fn().mockResolvedValueOnce(applicationExcelStatus()).mockReturnValueOnce(pendingCheck);
    const client = {
      getComputerUseSetting: vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true }),
      getExcelAddinStatus, setExcelAddinEnabled: vi.fn().mockResolvedValue(connected),
      getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }),
    } as unknown as MemmyAgentClient;
    await act(async () => {
      root.render(<I18nProvider language="zh-CN"><ComputerUseSettings client={client} platform="win32" /></I18nProvider>);
    });
    const toggle = container.querySelector('input[role="switch"][aria-label="Microsoft Excel"]') as HTMLInputElement;
    await act(async () => { toggle.click(); await Promise.resolve(); });
    expect(container.textContent).toContain("正在连接");
    expect(excelRowText()).not.toContain("已连接");
    await act(async () => { finishCheck(unavailable); await pendingCheck; });
    expect(getExcelAddinStatus).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("正在确认 Excel 连接");
    expect(excelRowText()).not.toContain("已连接");
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
  });

  it("requires an explicit retry after native Excel permission is denied and never asks for Full Disk Access", async () => {
    vi.useFakeTimers();
    const openExternal = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "memmy", { configurable: true, value: { openExternal } });
    const denied = applicationExcelStatus({ enabled: true, configured: true, setupCompleted: true,
      permissionRequired: true, error: "Excel automation permission denied.",
      manualInstallPath: "/legacy/Memmy-Excel.xml" });
    const setExcelAddinEnabled = vi.fn().mockResolvedValue(applicationExcelStatus({ enabled: true,
      configured: true, connected: true, setupCompleted: true, connectionCount: 1,
      workbooks: [{ id: "book1", name: "Book1" }], activeWorkbookId: "book1" }));
    const client = {
      getComputerUseSetting: vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true }),
      getExcelAddinStatus: vi.fn().mockResolvedValue(denied), setExcelAddinEnabled,
      getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }),
    } as unknown as MemmyAgentClient;
    try {
      await act(async () => {
        root.render(<I18nProvider language="zh-CN"><ComputerUseSettings client={client} platform="darwin" /></I18nProvider>);
      });
      expect(container.textContent).toContain("macOS 已拒绝 Memmy 控制 Excel");
      expect(container.textContent).not.toContain("Excel automation permission denied.");
      expect(container.textContent).toContain("开启 Memmy 下的 Microsoft Excel，然后重试连接");
      expect(container.textContent).not.toContain("完全磁盘访问权限");
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      const settings = [...container.querySelectorAll("button")].find(item => item.textContent === "打开自动化设置") as HTMLButtonElement;
      await act(async () => { settings.click(); });
      expect(openExternal).toHaveBeenCalledWith("x-apple.systempreferences:com.apple.preference.security?Privacy_Automation");
      await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(10000); });
      expect(setExcelAddinEnabled).not.toHaveBeenCalled();
      const retry = [...container.querySelectorAll("button")].find(item => item.textContent === "重试连接") as HTMLButtonElement;
      await act(async () => { retry.click(); });
      expect(setExcelAddinEnabled).toHaveBeenCalledTimes(1);
      expect(setExcelAddinEnabled).toHaveBeenCalledWith(true);
      expect(excelRowText()).toContain("已连接");
      expect(container.textContent).not.toContain("macOS 已拒绝 Memmy 控制 Excel");
      expect(container.textContent).not.toContain("打开自动化设置");
    } finally {
      Reflect.deleteProperty(window, "memmy");
      vi.useRealTimers();
    }
  });

  it("treats a legacy -1744 status as pending consent rather than denied access", async () => {
    const client = {
      getComputerUseSetting: vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true }),
      getExcelAddinStatus: vi.fn().mockResolvedValue(applicationExcelStatus({ enabled: true,
        configured: true, permissionRequired: true,
        error: "Automation denied (-1744). Allow Memmy to control Microsoft Excel in System Settings > Privacy & Security > Automation, then retry Excel authorization" })),
      getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }),
    } as unknown as MemmyAgentClient;
    await act(async () => {
      root.render(<I18nProvider language="zh-CN"><ComputerUseSettings client={client} platform="darwin" /></I18nProvider>);
    });
    expect(container.textContent).toContain("点击「重试连接」，在系统授权提示中选择「允许」");
    expect(container.textContent).not.toContain("Automation denied");
    expect(container.textContent).not.toContain("macOS 已拒绝");
    expect(container.textContent).not.toContain("打开自动化设置");
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });

  it("lets a remounted settings page retry a cached first-grant error while Excel is still disabled", async () => {
    const setExcelAddinEnabled = vi.fn().mockResolvedValue(applicationExcelStatus({ enabled: true,
      configured: true, setupCompleted: true }));
    const client = {
      getComputerUseSetting: vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true }),
      getExcelAddinStatus: vi.fn().mockResolvedValue(applicationExcelStatus({ permissionRequired: true,
        error: "Automation permission required (-1744). Retry Excel authorization and allow Memmy to control Microsoft Excel." })),
      setExcelAddinEnabled,
      getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }),
    } as unknown as MemmyAgentClient;
    await act(async () => {
      root.render(<I18nProvider language="zh-CN"><ComputerUseSettings client={client} platform="darwin" /></I18nProvider>);
    });
    const toggle = container.querySelector('input[role="switch"][aria-label="Microsoft Excel"]') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(container.textContent).toContain("点击「重试连接」，在系统授权提示中选择「允许」");
    expect(setExcelAddinEnabled).not.toHaveBeenCalled();
    const retry = [...container.querySelectorAll("button")].find(item => item.textContent === "重试连接") as HTMLButtonElement;
    expect(retry).toBeDefined();
    await act(async () => { retry.click(); });
    expect(setExcelAddinEnabled).toHaveBeenCalledWith(true);
    expect(setExcelAddinEnabled).toHaveBeenCalledTimes(1);
    expect(toggle.checked).toBe(true);
    expect(container.textContent).not.toContain("点击「重试连接」，在系统授权提示中选择「允许」");
  });

  it.each([
    { error: "Automation permission required (-1744). Retry Excel authorization and allow Memmy to control Microsoft Excel.",
      message: "点击「重试连接」，在系统授权提示中选择「允许」", denied: false },
    { error: "Automation denied (-1743). Allow Memmy to control Microsoft Excel in System Settings.",
      message: "macOS 已拒绝 Memmy 控制 Excel", denied: true },
  ])("localizes the native authorization failure $error and keeps retry available", async ({ error, message, denied }) => {
    const setExcelAddinEnabled = vi.fn().mockRejectedValueOnce(new Error(`Excel native control failed: ${error}`))
      .mockResolvedValueOnce(applicationExcelStatus({ enabled: true, configured: true, setupCompleted: true }));
    const client = {
      getComputerUseSetting: vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true }),
      getExcelAddinStatus: vi.fn().mockResolvedValue(applicationExcelStatus()), setExcelAddinEnabled,
      getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }),
    } as unknown as MemmyAgentClient;
    await act(async () => {
      root.render(<I18nProvider language="zh-CN"><ComputerUseSettings client={client} platform="darwin" /></I18nProvider>);
    });
    const toggle = container.querySelector('input[role="switch"][aria-label="Microsoft Excel"]') as HTMLInputElement;
    await act(async () => { toggle.click(); });
    expect(container.textContent).toContain(message);
    expect(container.textContent).not.toContain(error);
    expect(container.textContent?.includes("打开自动化设置")).toBe(denied);
    expect(toggle.checked).toBe(false);
    const retry = [...container.querySelectorAll("button")].find(item => item.textContent === "重试连接") as HTMLButtonElement;
    await act(async () => { retry.click(); });
    expect(setExcelAddinEnabled).toHaveBeenCalledTimes(2);
    expect(toggle.checked).toBe(true);
    expect(container.textContent).not.toContain(message);
    expect(container.textContent).not.toContain("打开自动化设置");
  });

  it("shows a native Excel enable failure and lets the user retry", async () => {
    const setExcelAddinEnabled = vi.fn().mockRejectedValueOnce(new Error("Excel native control failed: Permission was denied."))
      .mockResolvedValueOnce(applicationExcelStatus({ enabled: true, configured: true, setupCompleted: true }));
    const client = {
      getComputerUseSetting: vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true }),
      getExcelAddinStatus: vi.fn().mockResolvedValue(applicationExcelStatus()), setExcelAddinEnabled,
      getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }),
    } as unknown as MemmyAgentClient;
    await act(async () => {
      root.render(<I18nProvider language="zh-CN"><ComputerUseSettings client={client} platform="darwin" /></I18nProvider>);
    });
    const toggle = container.querySelector('input[role="switch"][aria-label="Microsoft Excel"]') as HTMLInputElement;
    await act(async () => { toggle.click(); });
    expect(container.textContent).toContain("系统拒绝了 Excel 连接，请检查相关权限后重试。");
    expect(toggle.checked).toBe(false);
    const retry = [...container.querySelectorAll("button")].find(item => item.textContent === "重试连接") as HTMLButtonElement;
    await act(async () => { retry.click(); });
    expect(setExcelAddinEnabled).toHaveBeenCalledTimes(2);
    expect(toggle.checked).toBe(true);
    expect(container.textContent).not.toContain("Excel 连接失败");
  });

  it("shows the actual native connection error, in the user's language, instead of asking to open another workbook", async () => {
    const client = {
      getComputerUseSetting: vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true }),
      getExcelAddinStatus: vi.fn().mockResolvedValue(applicationExcelStatus({ enabled: true,
        configured: true, setupCompleted: true, error: "Excel control requires an unlocked interactive Windows desktop" })),
      getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }),
    } as unknown as MemmyAgentClient;
    await act(async () => {
      root.render(<I18nProvider language="zh-CN"><ComputerUseSettings client={client} platform="win32" /></I18nProvider>);
    });
    expect(container.textContent).toContain("需要在电脑解锁的状态下才能操作 Excel");
    expect(container.textContent).not.toContain("Excel control requires");
    expect(container.textContent).toContain("重试连接");
    expect(container.textContent).not.toContain("打开 Excel 文件后即可使用");
  });

  it.each([
    { name: "a busy Windows Excel", platform: "win32", language: "zh-CN", shown: "Excel 正忙：请先在 Excel 里按回车结束单元格编辑",
      error: "Excel is busy because a cell is being edited or a dialog is open. Ask the user to press Enter or close the dialog in Excel, then try again." },
    { name: "several Windows Excel instances", platform: "win32", language: "zh-CN", shown: "检测到同时运行着多个 Excel 程序",
      error: "Multiple Excel application instances are running. Keep one Excel instance open to select a workbook safely." },
    { name: "a locked Mac", platform: "darwin", language: "zh-CN", shown: "需要在电脑解锁的状态下才能操作 Excel",
      error: "macOS is locked; Excel operation was not executed" },
    { name: "an unresponsive Excel", platform: "darwin", language: "zh-CN", shown: "Excel 长时间没有响应",
      error: "Excel operation timed out; result may be unknown and was not replayed" },
    { name: "several Excel instances in English", platform: "win32", language: "en-US", shown: "Several Excel programs are running",
      error: "Multiple Excel application instances are running. Keep one Excel instance open to select a workbook safely." },
  ] as const)("explains $name without the raw native message", async ({ platform, language, shown, error }) => {
    const client = {
      getComputerUseSetting: vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true }),
      getExcelAddinStatus: vi.fn().mockResolvedValue(applicationExcelStatus({ enabled: true, configured: true, setupCompleted: true, error })),
      getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }),
    } as unknown as MemmyAgentClient;
    await act(async () => {
      root.render(<I18nProvider language={language}><ComputerUseSettings client={client} platform={platform} /></I18nProvider>);
    });
    expect(container.textContent).toContain(shown);
    expect(container.textContent).not.toContain(error);
    expect(container.textContent).toContain(language === "en-US" ? "Retry connection" : "重试连接");
  });

  it("waits through a Windows Excel startup attachment failure and clears it when polling recovers", async () => {
    vi.useFakeTimers();
    try {
      const connected = applicationExcelStatus({ enabled: true, configured: true, connected: true });
      const unavailable = applicationExcelStatus({ enabled: true, configured: true,
        error: "The running Excel application is not available for control. COM HRESULT: 0x800401E3" });
      const getExcelAddinStatus = vi.fn().mockResolvedValueOnce(connected)
        .mockResolvedValueOnce(unavailable).mockResolvedValueOnce(unavailable)
        .mockResolvedValueOnce(unavailable).mockResolvedValueOnce(connected);
      const client = {
        getComputerUseSetting: vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true }),
        getExcelAddinStatus,
        getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }),
      } as unknown as MemmyAgentClient;
      await act(async () => {
        root.render(<I18nProvider language="zh-CN"><ComputerUseSettings client={client} platform="win32" /></I18nProvider>);
      });
      expect(excelRowText()).toContain("已连接");
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(container.textContent).toContain("正在确认 Excel 连接");
      expect(excelRowText()).not.toContain("已连接");
      expect(container.textContent).not.toContain("重试连接");
      expect(container.textContent).not.toContain("0x800401E3");
      expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
      await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
      expect(container.textContent).toContain("请确认 Excel 已完成启动、没有待处理的窗口");
      expect(container.textContent).toContain("重试连接");
      expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(excelRowText()).toContain("已连接");
      expect(container.textContent).not.toContain("重试连接");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not flash a raw Excel status error and clears it when the next check recovers", async () => {
    vi.useFakeTimers();
    try {
      const connected = applicationExcelStatus({ enabled: true, configured: true, connected: true });
      const getExcelAddinStatus = vi.fn().mockResolvedValueOnce(connected)
        .mockResolvedValueOnce(applicationExcelStatus({ enabled: true, configured: true,
          error: "Object reference not set to an instance of an object" }))
        .mockResolvedValueOnce(connected);
      const client = {
        getComputerUseSetting: vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true }),
        getExcelAddinStatus,
        getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }),
      } as unknown as MemmyAgentClient;
      await act(async () => {
        root.render(<I18nProvider language="zh-CN"><ComputerUseSettings client={client} platform="win32" /></I18nProvider>);
      });
      expect(excelRowText()).toContain("已连接");
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(container.textContent).toContain("正在确认 Excel 连接");
      expect(excelRowText()).not.toContain("已连接");
      expect(container.textContent).not.toContain("Object reference");
      expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(excelRowText()).toContain("已连接");
      expect(container.textContent).not.toContain("正在确认 Excel 连接");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a calm retry hint after repeated status failures", async () => {
    vi.useFakeTimers();
    try {
      const getExcelAddinStatus = vi.fn().mockRejectedValue(new Error("transport unavailable"));
      const client = {
        getComputerUseSetting: vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true }),
        getExcelAddinStatus,
        getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }),
      } as unknown as MemmyAgentClient;
      await act(async () => {
        root.render(<I18nProvider language="zh-CN"><ComputerUseSettings client={client} platform="win32" /></I18nProvider>);
      });
      expect(container.textContent).toContain("正在确认 Excel 连接");
      expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
      await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
      expect(container.textContent).toContain("暂时无法确认 Excel 连接，请稍后重试。");
      expect(container.textContent).toContain("重试连接");
      expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a failed connect action once a fresh status confirms Excel is connected", async () => {
    vi.useFakeTimers();
    try {
      const connected = applicationExcelStatus({ enabled: true, configured: true, connected: true });
      const setExcelAddinEnabled = vi.fn().mockRejectedValue(new Error("Object reference not set"));
      const getExcelAddinStatus = vi.fn().mockResolvedValueOnce(applicationExcelStatus())
        .mockResolvedValueOnce(connected);
      const client = {
        getComputerUseSetting: vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true }),
        getExcelAddinStatus, setExcelAddinEnabled,
        getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }),
      } as unknown as MemmyAgentClient;
      await act(async () => {
        root.render(<I18nProvider language="zh-CN"><ComputerUseSettings client={client} platform="win32" /></I18nProvider>);
      });
      const toggle = container.querySelector('input[role="switch"][aria-label="Microsoft Excel"]') as HTMLInputElement;
      await act(async () => { toggle.click(); });
      expect(container.textContent).toContain("暂时没连上 Excel");
      expect(excelRowText()).not.toContain("已连接");
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(excelRowText()).toContain("已连接");
      expect(container.textContent).not.toContain("暂时没连上 Excel");
      expect(setExcelAddinEnabled).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let an earlier Excel status request overwrite a completed enable", async () => {
    let resolveStatus!: (value: ExcelControlStatus) => void;
    const pendingStatus = new Promise<ExcelControlStatus>(resolve => { resolveStatus = resolve; });
    const enabled = applicationExcelStatus({ enabled: true, configured: true, setupCompleted: true });
    const client = {
      getComputerUseSetting: vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true }),
      getExcelAddinStatus: vi.fn().mockReturnValue(pendingStatus),
      setExcelAddinEnabled: vi.fn().mockResolvedValue(enabled),
      getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }),
    } as unknown as MemmyAgentClient;
    await act(async () => {
      root.render(<I18nProvider language="zh-CN"><ComputerUseSettings client={client} platform="darwin" /></I18nProvider>);
    });
    const toggle = container.querySelector('input[role="switch"][aria-label="Microsoft Excel"]') as HTMLInputElement;
    await act(async () => { toggle.click(); });
    expect(toggle.checked).toBe(true);
    await act(async () => { resolveStatus(applicationExcelStatus()); });
    expect(toggle.checked).toBe(true);
    expect(container.textContent).toContain("打开 Excel 文件后即可使用");
  });

  it("retries a failed Excel disable without enabling it again", async () => {
    const enabled = applicationExcelStatus({ enabled: true, configured: true, setupCompleted: true });
    const setExcelAddinEnabled = vi.fn().mockRejectedValueOnce(new Error("Connection was interrupted."))
      .mockResolvedValueOnce(applicationExcelStatus());
    const client = {
      getComputerUseSetting: vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true }),
      getExcelAddinStatus: vi.fn().mockResolvedValue(enabled), setExcelAddinEnabled,
      getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }),
    } as unknown as MemmyAgentClient;
    await act(async () => {
      root.render(<I18nProvider language="zh-CN"><ComputerUseSettings client={client} platform="darwin" /></I18nProvider>);
    });
    const toggle = container.querySelector('input[role="switch"][aria-label="Microsoft Excel"]') as HTMLInputElement;
    await act(async () => { toggle.click(); });
    expect(toggle.checked).toBe(true);
    const retry = [...container.querySelectorAll("button")].find(item => item.textContent === "重试连接") as HTMLButtonElement;
    await act(async () => { retry.click(); });
    expect(setExcelAddinEnabled.mock.calls).toEqual([[false], [false]]);
    expect(toggle.checked).toBe(false);
  });

  it("uses the Excel row as a single live-control switch", async () => {
    const setExcelAddinEnabled = vi.fn().mockResolvedValue({ configured: true, connected: false,
      connectionCount: 0, setupCompleted: true, manifestUrl: "https://localhost:32177/manifest.xml",
      lockedUse: { supported: false, reason: "nativeLockGuardianUnavailable" } });
    const client = { getComputerUseSetting: vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true }),
      getExcelAddinStatus: vi.fn().mockResolvedValue({ configured: false, connected: false, connectionCount: 0,
        setupCompleted: false, manifestUrl: null, lockedUse: { supported: false, reason: "nativeLockGuardianUnavailable" } }),
      setExcelAddinEnabled,
      getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }) } as unknown as MemmyAgentClient;
    await act(async () => {
      root.render(<I18nProvider language="zh-CN"><ComputerUseSettings client={client} platform="darwin" /></I18nProvider>);
    });
    const toggle = container.querySelector('input[role="switch"][aria-label="Microsoft Excel"]') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    await act(async () => { toggle.click(); });
    expect(setExcelAddinEnabled).toHaveBeenCalledWith(true);
  });

  it("shows the Excel setup failure returned by the agent", async () => {
    const setExcelAddinEnabled = vi.fn().mockRejectedValue(new Error("Excel add-in setup failed: The operation was canceled by the user."));
    const client = { getComputerUseSetting: vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true }),
      getExcelAddinStatus: vi.fn().mockResolvedValue({ configured: false, connected: false, connectionCount: 0,
        setupCompleted: false, manifestUrl: null, lockedUse: { supported: false, reason: "nativeLockGuardianUnavailable" } }),
      setExcelAddinEnabled,
      getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }) } as unknown as MemmyAgentClient;
    await act(async () => {
      root.render(<I18nProvider language="zh-CN"><ComputerUseSettings client={client} platform="win32" /></I18nProvider>);
    });
    const toggle = container.querySelector('input[role="switch"][aria-label="Microsoft Excel"]') as HTMLInputElement;
    await act(async () => { toggle.click(); });
    expect(container.textContent).toContain("Excel 加载项安装失败：The operation was canceled by the user.");
    expect(toggle.checked).toBe(false);
  });

  it("asks for Full Disk Access when macOS protects Excel's folder", async () => {
    const setExcelAddinEnabled = vi.fn().mockResolvedValue({ configured: true, connected: false, connectionCount: 0,
      setupCompleted: true, manifestUrl: "https://localhost:32177/manifest.xml", manualInstallPath: null,
      lockedUse: { supported: false, reason: "nativeLockGuardianUnavailable" } });
    const openExternal = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "memmy", { configurable: true, value: { openExternal } });
    const client = { getComputerUseSetting: vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true }),
      getExcelAddinStatus: vi.fn().mockResolvedValue({ configured: true, connected: false, connectionCount: 0,
        setupCompleted: true, manifestUrl: "https://localhost:32177/manifest.xml",
        manualInstallPath: "/Users/test-user/.memmy/computer-use/excel-addin/Memmy-Excel.xml",
        lockedUse: { supported: false, reason: "nativeLockGuardianUnavailable" } }),
      setExcelAddinEnabled,
      getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }) } as unknown as MemmyAgentClient;
    try {
      await act(async () => {
        root.render(<I18nProvider language="zh-CN"><ComputerUseSettings client={client} platform="darwin" /></I18nProvider>);
      });
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain("需要完全磁盘访问权限");
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain("前往打开");
      const openSettings = [...document.querySelectorAll("button")].find(item => item.textContent?.includes("前往打开")) as HTMLButtonElement;
      await act(async () => { openSettings.click(); });
      expect(openExternal).toHaveBeenCalledWith("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles");
      await act(async () => { window.dispatchEvent(new Event("focus")); });
      expect(setExcelAddinEnabled).toHaveBeenCalledWith(true);
    } finally {
      Reflect.deleteProperty(window, "memmy");
    }
  });

  it("shows persisted native app approvals and revokes one from settings", async () => {
    const approval = { platform: 'darwin' as const, appId: 'com.apple.calculator',
      displayName: 'Calculator', allowedAt: '2026-01-01T00:00:00.000Z' };
    const getNativeAppApprovals = vi.fn().mockResolvedValue([approval]);
    const revokeNativeAppApproval = vi.fn().mockResolvedValue([]);
    const client = { getComputerUseSetting: vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true }),
      getNativeAppApprovals, revokeNativeAppApproval, getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }) } as unknown as MemmyAgentClient;
    await act(async () => {
      root.render(<I18nProvider language="zh-CN"><ComputerUseSettings client={client} platform="darwin" /></I18nProvider>);
    });
    expect(getNativeAppApprovals).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('始终允许的应用');
    expect(container.textContent).toContain('Calculator');
    expect(container.textContent).not.toContain('com.apple.calculator');
    const revoke = container.querySelector('button[aria-label="撤销 Calculator"]') as HTMLButtonElement;
    await act(async () => { revoke.click(); });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Calculator');
    expect(revokeNativeAppApproval).not.toHaveBeenCalled();
    const confirm = [...document.querySelectorAll('button')]
      .find(item => item.textContent?.trim() === '移除') as HTMLButtonElement;
    await act(async () => { confirm.click(); });
    expect(revokeNativeAppApproval).toHaveBeenCalledWith('darwin', 'com.apple.calculator');
    expect(container.textContent).toContain('暂无始终允许的应用');
  });

  it.each(["darwin", "win32"])("keeps browser, Excel and app approvals available without locked use on %s", async (platform) => {
    const getNativeAppAllowAll = vi.fn().mockResolvedValue(true);
    const setNativeAppAllowAll = vi.fn().mockResolvedValue(false);
    Object.defineProperty(window, "memmy", { configurable: true, value: {
      getNativeAppAllowAll, setNativeAppAllowAll,
    } });
    const client = {
      getComputerUseSetting: vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true }),
      getExcelAddinStatus: vi.fn().mockResolvedValue(applicationExcelStatus()),
      getNativeAppApprovals: vi.fn().mockResolvedValue([{ platform, appId: "calculator",
        displayName: "Calculator", allowedAt: "2026-01-01T00:00:00.000Z" }]),
      getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }),
    } as unknown as MemmyAgentClient;
    try {
      await act(async () => {
        root.render(<I18nProvider language="zh-CN"><ComputerUseSettings client={client} platform={platform} /></I18nProvider>);
      });
      const text = container.textContent ?? "";
      expect(text).toContain("Google Chrome");
      expect(text).toContain("Microsoft Excel");
      expect(text).not.toContain("锁屏操作");
      expect(text).not.toContain("此 Mac");
      expect(container.querySelector('input[aria-label="锁屏操作"]')).toBeNull();
      expect(text.indexOf("Microsoft Excel")).toBeLessThan(text.indexOf("始终允许的应用"));
      expect(text.indexOf("始终允许的应用")).toBeLessThan(text.indexOf("Calculator"));
      const toggle = container.querySelector('input[role="switch"][aria-label="始终允许任意应用"]') as HTMLInputElement;
      expect(toggle.checked).toBe(true);
      await act(async () => { toggle.click(); });
      expect(setNativeAppAllowAll).toHaveBeenCalledWith(false);
      expect(toggle.checked).toBe(false);
    } finally {
      Reflect.deleteProperty(window, "memmy");
    }
  });
});
