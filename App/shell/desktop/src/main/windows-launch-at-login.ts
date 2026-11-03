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
 * Installed builds use the stable launcher created by the NSIS package so custom-drive
 * upgrades follow the same recovery-aware launch chain as Start menu shortcuts. A direct
 * executable fallback keeps older or partially repaired installations usable.
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

  const launcherPath = windowsPath.join(localAppDataPath, "Memmy", "launcher", "MemmyLauncher.vbs");
  if (!pathExists(launcherPath)) {
    return { path: environment.executablePath, args: [] };
  }

  return {
    path: windowsPath.join(systemRootPath, "System32", "wscript.exe"),
    // Electron formats each argv element for the Run value; literal quotes would be escaped again.
    args: [launcherPath]
  };
};

/** Repairs the old double-quoted launcher entry without enabling disabled startup. */
export const repairWindowsLaunchAtLogin = (
  application: WindowsLoginItemApplication,
  environment: WindowsLaunchAtLoginEnvironment,
  pathExists: WindowsPathExists = existsSync
): boolean => {
  if (environment.platform !== "win32" || !environment.isPackaged) {
    return false;
  }
  const command = resolveWindowsLoginItemCommand(environment, pathExists);
  if (command.args.length !== 1) {
    return false;
  }

  const legacyCommand = { ...command, args: [`"${command.args[0]}"`] };
  const settings = application.getLoginItemSettings(legacyCommand);
  // openAtLogin compares the exact current app ID's HKCU Run value. The aggregate
  // executableWillLaunchAtLogin also includes unrelated entries using wscript.exe.
  if (!settings.openAtLogin) {
    return false;
  }
  const legacyItem = settings.launchItems.find((item) => (
    item.name === "cn.memtensor.memmy"
    && item.scope === "user"
    && normalizeWindowsCommandPath(item.path) === normalizeWindowsCommandPath(legacyCommand.path)
    && item.args.length === 1
    && item.args[0] === legacyCommand.args[0]
  ));
  if (!legacyItem) {
    return false;
  }
  application.setLoginItemSettings({ ...command, openAtLogin: true, enabled: legacyItem.enabled });
  return true;
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
    && item.args.length === command.args.length
    && item.args.every((argument, index) => argument === command.args[index])
  ));
  // Aliases can have their own StartupApproved state. Entry ordering must not
  // hide an enabled command, and wscript's aggregate includes unrelated scripts.
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
