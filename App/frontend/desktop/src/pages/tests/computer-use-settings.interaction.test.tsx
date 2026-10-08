// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemmyAgentClient } from "../../api/memmy-agent-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ComputerUseSettings } from "../computer-use-settings.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("computer use settings", () => {
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
      expect(container.textContent).toContain("安装");
    } finally {
      Reflect.deleteProperty(window, "memmy");
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
    expect(container.textContent).toContain("让 Memmy 使用 Microsoft Excel 加载项以获得更多控制");
    expect(container.textContent).toContain("请重启 Excel，并在需要操作的空白或目标工作簿中打开 Memmy 加载项。");
    expect(container.textContent).not.toContain("已连接");
    expect(container.querySelector('a[download="Memmy-Excel.xml"]')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(getExcelAddinStatus).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("已连接");
    expect(container.textContent).not.toContain("请重启 Excel");
    } finally {
      vi.useRealTimers();
    }
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
        manualInstallPath: "/Users/grace/.memmy/computer-use/excel-addin/Memmy-Excel.xml",
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

  it("keeps locked use directly below Excel and approvals below locked use", async () => {
    const client = { getComputerUseSetting: vi.fn().mockResolvedValue({ enabled: true, available: true, binaryAvailable: true }),
      getExcelAddinStatus: vi.fn().mockResolvedValue({ configured: true, connected: false, connectionCount: 0,
        setupCompleted: true, manifestUrl: "https://localhost:32177/manifest.xml",
        lockedUse: { supported: false, reason: "nativeLockGuardianUnavailable" } }),
      getNativeAppApprovals: vi.fn().mockResolvedValue([{ platform: 'darwin' as const, appId: 'com.apple.calculator',
        displayName: 'Calculator', allowedAt: '2026-01-01T00:00:00.000Z' }]),
      getExternalBrowserStatus: vi.fn().mockResolvedValue({ connected: [], claims: [] }) } as unknown as MemmyAgentClient;
    Object.defineProperty(window, 'memmy', { configurable: true,
      value: { getLockedMacUseStatus: vi.fn().mockResolvedValue({ available: true, installed: true, consented: false }) } });
    try {
      await act(async () => {
        root.render(<I18nProvider language="zh-CN"><ComputerUseSettings client={client} platform="darwin" /></I18nProvider>);
      });
      const text = container.textContent ?? '';
      expect(text.indexOf('Microsoft Excel')).toBeLessThan(text.indexOf('锁屏操作'));
      expect(text.indexOf('锁屏操作')).toBeLessThan(text.indexOf('始终允许的应用'));
      expect(text.indexOf('始终允许的应用')).toBeLessThan(text.indexOf('Calculator'));
    } finally {
      Reflect.deleteProperty(window, 'memmy');
    }
  });

  it("shows macOS lock component state and lets the user remove it", async () => {
    const status = vi.fn().mockResolvedValue({ available: true, installed: true, consented: false });
    const change = vi.fn().mockResolvedValue({ available: true, installed: false, consented: false });
    Object.defineProperty(window, 'memmy', { configurable: true,
      value: { getLockedMacUseStatus: status, changeLockedMacUse: change } });
    const client = { getComputerUseSetting: vi.fn().mockResolvedValue({
      enabled: true, available: true, binaryAvailable: true,
    }) } as unknown as MemmyAgentClient;
    try {
      await act(async () => {
        root.render(<I18nProvider language="zh-CN"><ComputerUseSettings client={client} platform="darwin" /></I18nProvider>);
      });
      const toggle = container.querySelector('input[role="switch"][aria-label="锁屏操作"]') as HTMLInputElement;
      expect(toggle.checked).toBe(false);
      expect(container.textContent).toContain('允许 Memmy 在 Mac 锁定时使用此 Mac');
      expect(container.textContent).not.toContain('已开启');
      const button = [...container.querySelectorAll('button')]
        .find(item => item.textContent?.includes('移除授权组件')) as HTMLButtonElement;
      await act(async () => { button.click(); });
      expect(change).toHaveBeenCalledWith('uninstall');
      expect(toggle.checked).toBe(false);
    } finally {
      Reflect.deleteProperty(window, 'memmy');
    }
  });

  it("keeps locked-use consent separate from installation and supports revocation", async () => {
    const status = vi.fn().mockResolvedValue({ available: true, installed: true, consented: false });
    const setConsent = vi.fn()
      .mockResolvedValueOnce({ available: true, installed: true, consented: true })
      .mockResolvedValueOnce({ available: true, installed: true, consented: false });
    Object.defineProperty(window, 'memmy', { configurable: true,
      value: { getLockedMacUseStatus: status, setLockedMacUseConsent: setConsent } });
    const client = { getComputerUseSetting: vi.fn().mockResolvedValue({
      enabled: true, available: true, binaryAvailable: true,
    }) } as unknown as MemmyAgentClient;
    try {
      await act(async () => {
        root.render(<I18nProvider language="zh-CN"><ComputerUseSettings client={client} platform="darwin" /></I18nProvider>);
      });
      const toggle = container.querySelector('input[role="switch"][aria-label="锁屏操作"]') as HTMLInputElement;
      expect(toggle.checked).toBe(false);
      await act(async () => { toggle.click(); });
      expect(setConsent).toHaveBeenCalledWith(true);
      await act(async () => { toggle.click(); });
      expect(setConsent).toHaveBeenLastCalledWith(false);
    } finally {
      Reflect.deleteProperty(window, 'memmy');
    }
  });

  it("installs the lock component before granting consent the first time", async () => {
    const change = vi.fn().mockResolvedValue({ available: true, installed: true, consented: false });
    const setConsent = vi.fn().mockResolvedValue({ available: true, installed: true, consented: true });
    Object.defineProperty(window, 'memmy', { configurable: true,
      value: { getLockedMacUseStatus: vi.fn().mockResolvedValue({ available: true, installed: false, consented: false }),
        changeLockedMacUse: change, setLockedMacUseConsent: setConsent } });
    const client = { getComputerUseSetting: vi.fn().mockResolvedValue({
      enabled: true, available: true, binaryAvailable: true,
    }) } as unknown as MemmyAgentClient;
    try {
      await act(async () => {
        root.render(<I18nProvider language="zh-CN"><ComputerUseSettings client={client} platform="darwin" /></I18nProvider>);
      });
      const toggle = container.querySelector('input[role="switch"][aria-label="锁屏操作"]') as HTMLInputElement;
      await act(async () => { toggle.click(); });
      expect(change).toHaveBeenCalledWith('install');
      expect(setConsent).toHaveBeenCalledWith(true);
      expect(toggle.checked).toBe(true);
    } finally {
      Reflect.deleteProperty(window, 'memmy');
    }
  });
});
