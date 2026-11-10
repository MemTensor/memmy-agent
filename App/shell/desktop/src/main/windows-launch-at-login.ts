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
      name: string;
      scope: string;
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
    // Electron's Windows login-item writer applies AddQuoteForArg to each argument.
    args: [launcherPath]
  };
};

/** Repairs an enabled login item written by versions that pre-quoted the script path. */
export const repairWindowsLaunchAtLogin = (
  application: WindowsLoginItemApplication,
  environment: WindowsLaunchAtLoginEnvironment,
  appUserModelId: string,
  pathExists: WindowsPathExists = existsSync
): "repaired" | "write-unconfirmed" | undefined => {
  if (environment.platform !== "win32" || !environment.isPackaged) {
    return;
  }
  const command = resolveWindowsLoginItemCommand(environment, pathExists);
  const [launcherPath] = command.args;
  if (!launcherPath) {
    return;
  }
  const legacyArgs = [`"${launcherPath}"`];
  // openAtLogin compares the command against this app's per-user Run value.
  const legacy = application.getLoginItemSettings({ path: command.path, args: legacyArgs });
  if (!legacy.openAtLogin || !legacy.launchItems.some((item) => (
    item.scope === "user" && item.name.toLowerCase() === appUserModelId.toLowerCase() && item.enabled
  ))) {
    return;
  }
  application.setLoginItemSettings({ ...command, openAtLogin: true, enabled: true });
  // Electron's setter returns void even if the registry write did not take effect.
  return application.getLoginItemSettings(command).openAtLogin ? "repaired" : "write-unconfirmed";
};

/** Reads whether the packaged Windows launch command will effectively run at login. */
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

  const matchingItem = settings.launchItems.find((item) => (
    normalizeWindowsCommandPath(item.path) === normalizeWindowsCommandPath(command.path)
    && item.args.length === command.args.length
    && item.args.every((argument, index) => argument === command.args[index])
  ));
  return matchingItem?.enabled ?? settings.executableWillLaunchAtLogin;
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
