import { existsSync } from "node:fs";
import { win32 as windowsPath } from "node:path";

interface WindowsLoginItemOptions {
  path: string;
  args: string[];
}

interface WindowsLoginItemWriteOptions extends WindowsLoginItemOptions {
  name: string;
  openAtLogin: boolean;
  enabled: boolean;
}

export interface WindowsLoginItemApplication {
  getLoginItemSettings(options: WindowsLoginItemOptions): {
    openAtLogin: boolean;
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
  appUserModelId: string;
  executablePath: string;
  localAppDataPath?: string;
  systemRootPath?: string;
}

export type WindowsPathExists = (path: string) => boolean;

function findWindowsLoginItem(
  application: WindowsLoginItemApplication,
  appUserModelId: string,
  command: WindowsLoginItemOptions,
  allowExactCommandFallback = false
) {
  // Electron parses the lookup path as a command line when it enumerates Run entries.
  const path = /[ \t]/.test(command.path) ? `"${command.path}"` : command.path;
  const { launchItems, openAtLogin } = application.getLoginItemSettings({ ...command, path });
  const expectedName = appUserModelId.toLowerCase();
  const expectedPath = normalizeWindowsCommandPath(command.path);
  const item = launchItems.find((item) => (
    item.scope === "user" && item.name.toLowerCase() === expectedName
    && normalizeWindowsCommandPath(item.path) === expectedPath
  ));
  if (!item) return;

  // The only argument we use is a script path. Keep literal quotes significant
  // so the broken legacy command cannot be confused with its corrected form.
  const argsMatch = item.args.length === command.args.length && command.args.every((argument, index) => (
    normalizeWindowsCommandPath(item.args[index]!) === normalizeWindowsCommandPath(argument)
  ));
  // Electron compares the exact Run value for this app in openAtLogin. For
  // readback, it can confirm the command even if parsing its args differs.
  // The enabled flag still has to come from our own entry: a shared executable
  // can have unrelated enabled entries.
  return argsMatch || (allowExactCommandFallback && openAtLogin) ? item : undefined;
}

function writeWindowsLoginItem(
  application: WindowsLoginItemApplication,
  appUserModelId: string,
  command: WindowsLoginItemOptions,
  enabled: boolean
): void {
  application.setLoginItemSettings({ ...command, name: appUserModelId, openAtLogin: enabled, enabled });
}

function resolveWindowsLoginLauncher(environment: WindowsLaunchAtLoginEnvironment) {
  const localAppDataPath = environment.localAppDataPath?.trim();
  const systemRootPath = environment.systemRootPath?.trim();
  if (!localAppDataPath || !systemRootPath) {
    return undefined;
  }
  return {
    scriptHostPath: windowsPath.join(systemRootPath, "System32", "wscript.exe"),
    launcherPath: windowsPath.join(localAppDataPath, "Memmy", "launcher", "MemmyLauncher.vbs")
  };
}

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
  const launcher = resolveWindowsLoginLauncher(environment);
  if (!launcher || !pathExists(launcher.launcherPath)) {
    return { path: environment.executablePath, args: [] };
  }

  return {
    path: launcher.scriptHostPath,
    // Electron's Windows login-item writer applies AddQuoteForArg to each argument.
    args: [launcher.launcherPath]
  };
};

/** Repairs an enabled login item written by versions that pre-quoted the script path. */
export const repairWindowsLaunchAtLogin = (
  application: WindowsLoginItemApplication,
  environment: WindowsLaunchAtLoginEnvironment,
  pathExists: WindowsPathExists = existsSync
): "repaired" | "repaired-fallback" | "write-unconfirmed" | undefined => {
  if (environment.platform !== "win32" || !environment.isPackaged) {
    return;
  }
  const launcher = resolveWindowsLoginLauncher(environment);
  if (!launcher) {
    return;
  }
  // Older versions used Electron's default Run value name, the AppUserModelID.
  const legacy = findWindowsLoginItem(application, environment.appUserModelId, {
    path: launcher.scriptHostPath,
    args: [`"${launcher.launcherPath}"`]
  });
  if (!legacy?.enabled) {
    return;
  }
  const command = resolveWindowsLoginItemCommand(environment, pathExists);
  writeWindowsLoginItem(application, environment.appUserModelId, command, true);
  // Electron's setter returns void even if the registry write did not take effect.
  if (!findWindowsLoginItem(application, environment.appUserModelId, command, true)?.enabled) {
    return "write-unconfirmed";
  }
  return command.path === launcher.scriptHostPath ? "repaired" : "repaired-fallback";
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
  // A direct executable entry can still be active after the launcher is restored.
  const fallback = { path: environment.executablePath, args: [] };
  if (command.path !== fallback.path) {
    const launcherItem = findWindowsLoginItem(application, environment.appUserModelId, command, true);
    if (launcherItem) return launcherItem.enabled;
  }
  return findWindowsLoginItem(application, environment.appUserModelId, fallback, true)?.enabled ?? false;
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
  writeWindowsLoginItem(application, environment.appUserModelId, command, enabled);
  return getWindowsLaunchAtLogin(application, environment, pathExists);
};

const normalizeWindowsCommandPath = (path: string): string => path.replaceAll("/", "\\").toLowerCase();
