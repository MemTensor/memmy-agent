import { existsSync } from "node:fs";
import { win32 as windowsPath } from "node:path";

interface WindowsLoginItemOptions {
  path: string;
  args: string[];
}

interface WindowsLoginItemWriteOptions extends WindowsLoginItemOptions {
  openAtLogin: boolean;
  enabled: boolean;
}

export interface WindowsLoginItemApplication {
  getLoginItemSettings(options: WindowsLoginItemOptions): {
    openAtLogin: boolean;
    executableWillLaunchAtLogin: boolean;
    launchItems: Array<{
      name?: string;
      scope?: string;
      path: string;
      args: string[];
      enabled: boolean;
    }>;
  };
  setLoginItemSettings(options: WindowsLoginItemWriteOptions): void;
}

export interface WindowsLaunchAtLoginEnvironment {
  platform: string;
  isPackaged: boolean;
  executablePath: string;
  localAppDataPath?: string;
  systemRootPath?: string;
}

export type WindowsPathExists = (path: string) => boolean;

/**
 * Resolves the command Windows should run after the user signs in.
 *
 * Installed builds use the PowerShell launcher created by NSIS, including on
 * Windows installations without the optional VBScript host. A direct executable
 * fallback keeps older or partially repaired installations usable.
 */
export const resolveWindowsLoginItemCommand = (
  environment: WindowsLaunchAtLoginEnvironment,
  pathExists: WindowsPathExists = existsSync
): WindowsLoginItemOptions => {
  const localAppDataPath = environment.localAppDataPath?.trim();
  const systemRootPath = environment.systemRootPath?.trim();
  if (!localAppDataPath || !systemRootPath) {
    return { path: environment.executablePath, args: [] };
  }

  const launcherPath = windowsPath.join(localAppDataPath, "Memmy", "launcher", "MemmyLauncher.ps1");
  const powerShellPath = windowsPath.join(systemRootPath, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!pathExists(launcherPath) || !pathExists(powerShellPath)) {
    return { path: environment.executablePath, args: [] };
  }

  return {
    path: powerShellPath,
    // Electron formats each argv element for the Run value; literal quotes would be escaped again.
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", launcherPath]
  };
};

/** Migrates only this app's old launchers, preserving Windows' enabled/disabled state. */
export const repairWindowsLaunchAtLogin = (
  application: WindowsLoginItemApplication,
  environment: WindowsLaunchAtLoginEnvironment,
  pathExists: WindowsPathExists = existsSync
): boolean => {
  if (environment.platform !== "win32" || !environment.isPackaged) {
    return false;
  }
  const command = resolveWindowsLoginItemCommand(environment, pathExists);
  if (command.args.length === 0) {
    return false;
  }

  const legacyPath = windowsPath.join(environment.localAppDataPath!.trim(), "Memmy", "launcher", "MemmyLauncher.vbs");
  const legacyHost = windowsPath.join(environment.systemRootPath!.trim(), "System32", "wscript.exe");
  // Do not require the old .vbs to exist: the new installer already removes it.
  const legacyCommands = [
    { path: legacyHost, args: [legacyPath] },
    { path: legacyHost, args: [`"${legacyPath}"`] },
    { ...command, args: [...command.args.slice(0, -1), `"${command.args.at(-1)}"`] }
  ];
  for (const legacyCommand of legacyCommands) {
    const settings = application.getLoginItemSettings(legacyCommand);
    // This is the exact app ID's Run value, not the host's aggregate startup state.
    if (!settings.openAtLogin) continue;
    const legacyItem = settings.launchItems.find((item) => (
      item.name === "cn.memtensor.memmy"
      && item.scope === "user"
      && normalizeWindowsCommandPath(item.path) === normalizeWindowsCommandPath(legacyCommand.path)
      && matchesElectronLoginArguments(item.args, legacyCommand.args)
    ));
    if (!legacyItem) continue;
    application.setLoginItemSettings({ ...command, openAtLogin: true, enabled: legacyItem.enabled });
    return true;
  }
  return false;
};

/** Reads effective matching entries while retaining the app's own registration as the setting gate. */
export const getWindowsLaunchAtLogin = (
  application: WindowsLoginItemApplication,
  environment: WindowsLaunchAtLoginEnvironment,
  pathExists: WindowsPathExists = existsSync
): boolean => {
  if (environment.platform !== "win32" || !environment.isPackaged) {
    return false;
  }

  const command = resolveWindowsLoginItemCommand(environment, pathExists);
  const settings = application.getLoginItemSettings(command);
  if (!settings.openAtLogin) {
    return false;
  }

  const matchingItems = settings.launchItems.filter((item) => (
    normalizeWindowsCommandPath(item.path) === normalizeWindowsCommandPath(command.path)
    && matchesElectronLoginArguments(item.args, command.args)
  ));
  // Aliases can have their own StartupApproved state. Entry ordering must not
  // hide an enabled command, and PowerShell's aggregate includes unrelated scripts.
  return matchingItems.some((item) => item.enabled);
};

/** Writes the packaged Windows login item and returns the effective system state. */
export const setWindowsLaunchAtLogin = (
  application: WindowsLoginItemApplication,
  environment: WindowsLaunchAtLoginEnvironment,
  enabled: boolean,
  pathExists: WindowsPathExists = existsSync
): boolean => {
  if (environment.platform !== "win32" || !environment.isPackaged) {
    return false;
  }

  const command = resolveWindowsLoginItemCommand(environment, pathExists);
  application.setLoginItemSettings({
    openAtLogin: enabled,
    enabled,
    ...command
  });
  return getWindowsLaunchAtLogin(application, environment, pathExists);
};

const normalizeWindowsCommandPath = (path: string): string => path.replaceAll("/", "\\").toLowerCase();

/** Electron's Chromium parser omits switch tokens from launchItems[].args. */
const matchesElectronLoginArguments = (actual: string[], expected: string[]): boolean => {
  const sameArguments = (argumentsToMatch: string[]) => actual.length === argumentsToMatch.length
    && actual.every((argument, index) => argument === argumentsToMatch[index]);
  // openAtLogin above still gates on this app ID's complete raw Run command.
  // Aliases can only be compared using the argument representation Electron exposes.
  return sameArguments(expected) || sameArguments(expected.filter(argument => !argument.startsWith("-")));
};
