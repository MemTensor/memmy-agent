import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  getWindowsLaunchAtLogin,
  repairWindowsLaunchAtLogin,
  resolveWindowsLoginItemCommand,
  setWindowsLaunchAtLogin,
  type WindowsLoginItemApplication
} from "../src/main/windows-launch-at-login.js";

const mainSourcePath = fileURLToPath(new URL("../src/main/main.ts", import.meta.url));
const preloadSourcePath = fileURLToPath(new URL("../src/preload/preload.cts", import.meta.url));
const settingsSourcePath = fileURLToPath(
  new URL("../../../frontend/desktop/src/pages/settings-page.tsx", import.meta.url)
);

const packagedWindowsEnvironment = {
  platform: "win32",
  isPackaged: true,
  executablePath: "D:\\Apps\\Memmy\\Memmy.exe",
  localAppDataPath: "C:\\Example Data\\测试",
  systemRootPath: "C:\\Windows"
} as const;
const launcherPath = "C:\\Example Data\\测试\\Memmy\\launcher\\MemmyLauncher.vbs";
const scriptHostPath = "C:\\Windows\\System32\\wscript.exe";
const appUserModelId = "example.app";

describe("Windows launch at login", () => {
  it("uses the installed launch proxy so login startup follows the normal Windows launch chain", () => {
    expect(resolveWindowsLoginItemCommand(packagedWindowsEnvironment, (path) => path === launcherPath)).toEqual({
      path: scriptHostPath,
      args: [launcherPath]
    });
  });

  it("falls back to the packaged executable when the launch proxy is unavailable", () => {
    expect(resolveWindowsLoginItemCommand(packagedWindowsEnvironment, () => false)).toEqual({
      path: packagedWindowsEnvironment.executablePath,
      args: []
    });
  });

  it("reads the effective Windows startup state for the exact registered command", () => {
    const getLoginItemSettings = vi.fn(() => ({
      openAtLogin: true,
      executableWillLaunchAtLogin: true,
      launchItems: [{
        name: appUserModelId,
        scope: "user",
        path: "d:/apps/memmy/memmy.exe",
        args: [],
        enabled: true
      }]
    }));
    const application: WindowsLoginItemApplication = {
      getLoginItemSettings,
      setLoginItemSettings: vi.fn()
    };

    expect(getWindowsLaunchAtLogin(application, packagedWindowsEnvironment, () => false)).toBe(true);
    expect(getLoginItemSettings).toHaveBeenCalledWith({
      path: packagedWindowsEnvironment.executablePath,
      args: []
    });
  });

  it("does not mistake another wscript startup entry for an enabled Memmy launch item", () => {
    const getLoginItemSettings = vi.fn(() => ({
      openAtLogin: true,
      executableWillLaunchAtLogin: true,
      launchItems: [{
        name: "example.other",
        scope: "user",
        path: scriptHostPath,
        args: ["C:\\Example\\other.vbs"],
        enabled: true
      }, {
        name: appUserModelId,
        scope: "user",
        path: scriptHostPath,
        args: [launcherPath],
        enabled: false
      }]
    }));
    const application: WindowsLoginItemApplication = {
      getLoginItemSettings,
      setLoginItemSettings: vi.fn()
    };

    expect(getWindowsLaunchAtLogin(application, packagedWindowsEnvironment, (path) => path === launcherPath)).toBe(false);
  });

  it.each([true, false])("writes and re-reads the effective Windows startup state: %s", (enabled) => {
    const getLoginItemSettings = vi.fn(() => ({
      openAtLogin: enabled,
      executableWillLaunchAtLogin: enabled,
      launchItems: [{
        name: appUserModelId,
        scope: "user",
        path: packagedWindowsEnvironment.executablePath,
        args: [],
        enabled
      }]
    }));
    const setLoginItemSettings = vi.fn();
    const application: WindowsLoginItemApplication = {
      getLoginItemSettings,
      setLoginItemSettings
    };

    expect(setWindowsLaunchAtLogin(application, packagedWindowsEnvironment, enabled, () => false)).toBe(enabled);
    expect(setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: enabled,
      enabled,
      path: packagedWindowsEnvironment.executablePath,
      args: []
    });
  });

  describe("legacy launch item repair", () => {
    const legacyItem = {
      name: appUserModelId,
      scope: "user",
      path: scriptHostPath,
      args: [`"${launcherPath}"`],
      enabled: true
    };

    it("replaces an enabled legacy command once, using the unquoted script path", () => {
      const getLoginItemSettings = vi.fn(() => ({
        openAtLogin: false,
        executableWillLaunchAtLogin: true,
        launchItems: [{ ...legacyItem, args: [launcherPath] }]
      })).mockReturnValueOnce({
        openAtLogin: true,
        executableWillLaunchAtLogin: true,
        launchItems: [legacyItem]
      }).mockReturnValueOnce({
        openAtLogin: true,
        executableWillLaunchAtLogin: true,
        launchItems: [{ ...legacyItem, args: [launcherPath] }]
      });
      const setLoginItemSettings = vi.fn();
      const application = { getLoginItemSettings, setLoginItemSettings };

      expect(repairWindowsLaunchAtLogin(application, packagedWindowsEnvironment, appUserModelId, () => true))
        .toBe("repaired");
      repairWindowsLaunchAtLogin(application, packagedWindowsEnvironment, appUserModelId, () => true);

      expect(getLoginItemSettings).toHaveBeenCalledWith({ path: scriptHostPath, args: legacyItem.args });
      expect(setLoginItemSettings).toHaveBeenCalledExactlyOnceWith({
        path: scriptHostPath,
        args: [launcherPath],
        openAtLogin: true,
        enabled: true
      });
    });

    it("reports a write that Electron did not persist", () => {
      const application: WindowsLoginItemApplication = {
        getLoginItemSettings: vi.fn(({ args }) => ({
          openAtLogin: args[0] === legacyItem.args[0],
          executableWillLaunchAtLogin: true,
          launchItems: [legacyItem]
        })),
        setLoginItemSettings: vi.fn()
      };

      expect(repairWindowsLaunchAtLogin(application, packagedWindowsEnvironment, appUserModelId, () => true))
        .toBe("write-unconfirmed");
    });

    it.each([
      ["disabled", { ...legacyItem, enabled: false }],
      ["owned by another app", { ...legacyItem, name: "example.other" }],
      ["machine-wide", { ...legacyItem, scope: "machine" }]
    ] as const)("does not rewrite a legacy item that is %s", (_label, launchItem) => {
      const application = {
        getLoginItemSettings: vi.fn(() => ({
          openAtLogin: true,
          executableWillLaunchAtLogin: true,
          launchItems: [launchItem]
        })),
        setLoginItemSettings: vi.fn()
      };

      repairWindowsLaunchAtLogin(application, packagedWindowsEnvironment, appUserModelId, () => true);

      expect(application.setLoginItemSettings).not.toHaveBeenCalled();
    });
  });

  it("does not register a login item outside packaged Windows builds", () => {
    const application: WindowsLoginItemApplication = {
      getLoginItemSettings: vi.fn(),
      setLoginItemSettings: vi.fn()
    };

    expect(getWindowsLaunchAtLogin(application, { ...packagedWindowsEnvironment, platform: "darwin" })).toBe(false);
    expect(setWindowsLaunchAtLogin(application, { ...packagedWindowsEnvironment, isPackaged: false }, true)).toBe(false);
    repairWindowsLaunchAtLogin(application, { ...packagedWindowsEnvironment, isPackaged: false }, appUserModelId);
    expect(application.getLoginItemSettings).not.toHaveBeenCalled();
    expect(application.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it("wires the Windows-only bridge without replacing other platforms' existing renderer behavior", () => {
    const mainSource = readFileSync(mainSourcePath, "utf8");
    const preloadSource = readFileSync(preloadSourcePath, "utf8");
    const settingsSource = readFileSync(settingsSourcePath, "utf8");

    expect(mainSource).toContain('ipcMain.handle("memmy:get-launch-at-login"');
    expect(mainSource).toContain('ipcMain.handle("memmy:set-launch-at-login"');
    expect(mainSource).toContain('ipcMain.removeHandler("memmy:get-launch-at-login")');
    expect(mainSource).toContain('ipcMain.removeHandler("memmy:set-launch-at-login")');
    expect(preloadSource).toContain("getLaunchAtLogin(): Promise<boolean>;");
    expect(preloadSource).toContain("setLaunchAtLogin(enabled: boolean): Promise<boolean>;");
    expect(preloadSource).toContain('ipcRenderer.invoke("memmy:get-launch-at-login")');
    expect(preloadSource).toContain('ipcRenderer.invoke("memmy:set-launch-at-login", enabled)');
    expect(settingsSource).toContain('platform !== "win32"');
    expect(settingsSource).toContain("window.memmy?.getLaunchAtLogin");
    expect(settingsSource).toContain("window.memmy?.setLaunchAtLogin");
    expect(settingsSource).toContain("onChange={handleLaunchAtLoginChange}");
    expect(settingsSource).toContain("setLaunchAtLogin(enabled);");
  });
});
