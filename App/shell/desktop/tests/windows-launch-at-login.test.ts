import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  getWindowsLaunchAtLogin,
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
  localAppDataPath: "C:\\Users\\Lee User\\AppData\\Local",
  systemRootPath: "C:\\Windows"
} as const;

describe("Windows launch at login", () => {
  it("uses the installed launch proxy so login startup follows the normal Windows launch chain", () => {
    const launcherPath = "C:\\Users\\Lee User\\AppData\\Local\\Memmy\\launcher\\MemmyLauncher.vbs";

    expect(resolveWindowsLoginItemCommand(packagedWindowsEnvironment, (path) => path === launcherPath)).toEqual({
      path: "C:\\Windows\\System32\\wscript.exe",
      args: [`"${launcherPath}"`]
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
    const launcherPath = "C:\\Users\\Lee User\\AppData\\Local\\Memmy\\launcher\\MemmyLauncher.vbs";
    const getLoginItemSettings = vi.fn(() => ({
      openAtLogin: true,
      executableWillLaunchAtLogin: true,
      launchItems: [{
        path: "C:\\Windows\\System32\\wscript.exe",
        args: ["\"C:\\Other\\startup.vbs\""],
        enabled: true
      }, {
        path: "C:\\Windows\\System32\\wscript.exe",
        args: [`"${launcherPath}"`],
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

  it("does not register a login item outside packaged Windows builds", () => {
    const application: WindowsLoginItemApplication = {
      getLoginItemSettings: vi.fn(),
      setLoginItemSettings: vi.fn()
    };

    expect(getWindowsLaunchAtLogin(application, { ...packagedWindowsEnvironment, platform: "darwin" })).toBe(false);
    expect(setWindowsLaunchAtLogin(application, { ...packagedWindowsEnvironment, isPackaged: false }, true)).toBe(false);
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
