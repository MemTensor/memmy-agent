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
  localAppDataPath: "C:\\Users\\Lee User\\AppData\\Local",
  systemRootPath: "C:\\Windows"
} as const;

describe("Windows launch at login", () => {
  it("uses the installed launch proxy so login startup follows the normal Windows launch chain", () => {
    const launcherPath = "C:\\Users\\Lee User\\AppData\\Local\\Memmy\\launcher\\MemmyLauncher.vbs";

    expect(resolveWindowsLoginItemCommand(packagedWindowsEnvironment, (path) => path === launcherPath)).toEqual({
      path: "C:\\Windows\\System32\\wscript.exe",
      args: [launcherPath]
    });
  });

  it("falls back to the packaged executable when the launch proxy is unavailable", () => {
    expect(resolveWindowsLoginItemCommand(packagedWindowsEnvironment, () => false)).toEqual({
      path: packagedWindowsEnvironment.executablePath,
      args: []
    });
  });

  it.each(["Lee", "Lee User", "中文 用户"])("passes an unquoted launcher path for user %s", (user) => {
    const environment = { ...packagedWindowsEnvironment, localAppDataPath: `C:\\Users\\${user}\\AppData\\Local` };
    const launcherPath = `${environment.localAppDataPath}\\Memmy\\launcher\\MemmyLauncher.vbs`;
    expect(resolveWindowsLoginItemCommand(environment, () => true).args).toEqual([launcherPath]);
  });

  it.each([true, false])("repairs only the legacy Memmy command and preserves enabled=%s", (enabled) => {
    const launcherPath = `${packagedWindowsEnvironment.localAppDataPath}\\Memmy\\launcher\\MemmyLauncher.vbs`;
    let legacy = true;
    const getLoginItemSettings = vi.fn((command: { args: string[] }) => ({
      openAtLogin: legacy && command.args[0] === `"${launcherPath}"`,
      executableWillLaunchAtLogin: true,
      launchItems: [{ name: "other", scope: "user", path: "C:\\Windows\\System32\\wscript.exe", args: ["other.vbs"], enabled: true },
        { name: "cn.memtensor.memmy", scope: "user", path: "c:/windows/system32/wscript.exe", args: [legacy ? `"${launcherPath}"` : launcherPath], enabled }]
    }));
    const setLoginItemSettings = vi.fn(() => { legacy = false; });
    const application = { getLoginItemSettings, setLoginItemSettings };
    expect(repairWindowsLaunchAtLogin(application, packagedWindowsEnvironment, () => true)).toBe(true);
    expect(setLoginItemSettings).toHaveBeenCalledExactlyOnceWith({
      openAtLogin: true, enabled, path: "C:\\Windows\\System32\\wscript.exe", args: [launcherPath]
    });
    expect(repairWindowsLaunchAtLogin(application, packagedWindowsEnvironment, () => true)).toBe(false);
    expect(setLoginItemSettings).toHaveBeenCalledTimes(1);
  });

  it.each([
    { openAtLogin: false, name: "cn.memtensor.memmy", scope: "user" },
    { openAtLogin: true, name: "another-app", scope: "user" },
    { openAtLogin: true, name: "cn.memtensor.memmy", scope: "machine" }
  ])("does not repair absent or unrelated startup: %j", ({ openAtLogin, name, scope }) => {
    const launcherPath = `${packagedWindowsEnvironment.localAppDataPath}\\Memmy\\launcher\\MemmyLauncher.vbs`;
    const application = {
      getLoginItemSettings: vi.fn(() => ({ openAtLogin, executableWillLaunchAtLogin: true,
        launchItems: [{ name, scope, path: "C:\\Windows\\System32\\wscript.exe", args: [`"${launcherPath}"`], enabled: true }] })),
      setLoginItemSettings: vi.fn()
    };
    expect(repairWindowsLaunchAtLogin(application, packagedWindowsEnvironment, () => true)).toBe(false);
    expect(application.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it("leaves startup untouched when the launcher is missing or Windows is not packaged", () => {
    const application = { getLoginItemSettings: vi.fn(), setLoginItemSettings: vi.fn() };
    expect(repairWindowsLaunchAtLogin(application, packagedWindowsEnvironment, () => false)).toBe(false);
    expect(repairWindowsLaunchAtLogin(application, { ...packagedWindowsEnvironment, platform: "darwin" })).toBe(false);
    expect(repairWindowsLaunchAtLogin(application, { ...packagedWindowsEnvironment, isPackaged: false })).toBe(false);
    expect(application.getLoginItemSettings).not.toHaveBeenCalled();
    expect(application.setLoginItemSettings).not.toHaveBeenCalled();
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
    const startup = mainSource.slice(mainSource.indexOf("app.whenReady().then(async () => {"));
    expect(startup.indexOf("repairWindowsLaunchAtLogin(app,")).toBeGreaterThan(startup.indexOf("const windowsUpgradeLockPath"));
    expect(startup.indexOf("repairWindowsLaunchAtLogin(app,")).toBeLessThan(startup.indexOf("await boot();"));
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
