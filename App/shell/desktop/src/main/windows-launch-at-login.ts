import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { win32 as windowsPath, join as joinPath } from "node:path";

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

export type WindowsScriptHostProbe = (systemRootPath: string) => boolean;

/**
 * Resolves the command Windows should run after the user signs in.
 *
 * Installed builds normally use the stable launcher created by the NSIS package so custom-drive
 * upgrades follow the same recovery-aware launch chain as Start menu shortcuts. When the
 * user's Windows Script Host / VBScript engine is unavailable (uninstalled Windows Feature,
 * GPO block, or a broken .vbs handler after a Windows update), invoking the launcher through
 * wscript.exe would surface a "There is no script engine for file extension '.vbs'" dialog on
 * every login; falling back to the packaged executable keeps the user's next sign-in silent.
 */
export const resolveWindowsLoginItemCommand = (
  environment: WindowsLaunchAtLoginEnvironment,
  pathExists: WindowsPathExists = existsSync,
  probeWindowsScriptHost: WindowsScriptHostProbe = defaultWindowsScriptHostProbe
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

  if (!probeWindowsScriptHost(systemRootPath)) {
    return { path: environment.executablePath, args: [] };
  }

  return {
    path: windowsPath.join(systemRootPath, "System32", "wscript.exe"),
    args: [`"${launcherPath}"`]
  };
};

/** Reads whether the packaged Windows launch command will effectively run at login. */
export const getWindowsLaunchAtLogin = (
  application: WindowsLoginItemApplication,
  environment: WindowsLaunchAtLoginEnvironment,
  pathExists: WindowsPathExists = existsSync,
  probeWindowsScriptHost: WindowsScriptHostProbe = defaultWindowsScriptHostProbe
): boolean => {
  if (environment.platform !== "win32" || !environment.isPackaged) {
    return false;
  }

  const command = resolveWindowsLoginItemCommand(environment, pathExists, probeWindowsScriptHost);
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
  pathExists: WindowsPathExists = existsSync,
  probeWindowsScriptHost: WindowsScriptHostProbe = defaultWindowsScriptHostProbe
): boolean => {
  if (environment.platform !== "win32" || !environment.isPackaged) {
    return false;
  }

  const command = resolveWindowsLoginItemCommand(environment, pathExists, probeWindowsScriptHost);
  application.setLoginItemSettings({
    openAtLogin: enabled,
    enabled,
    ...command
  });
  return getWindowsLaunchAtLogin(application, environment, pathExists, probeWindowsScriptHost);
};

const normalizeWindowsCommandPath = (path: string): string => path.replaceAll("/", "\\").toLowerCase();

let cachedWindowsScriptHostAvailable: boolean | null = null;

/**
 * Detects whether the system's Windows Script Host / VBScript engine can execute a .vbs file.
 *
 * The result is cached for the lifetime of the process because a Windows session cannot regain
 * a removed script engine without restarting.
 */
const defaultWindowsScriptHostProbe: WindowsScriptHostProbe = (systemRootPath) => {
  if (cachedWindowsScriptHostAvailable !== null) {
    return cachedWindowsScriptHostAvailable;
  }

  cachedWindowsScriptHostAvailable = probeWindowsScriptHostOnce(systemRootPath);
  return cachedWindowsScriptHostAvailable;
};

const probeWindowsScriptHostOnce = (systemRootPath: string): boolean => {
  // Mirror the production launch path (line 72) so the probe fails whenever
  // the user-facing login item would fail. wscript.exe resolves .vbs through
  // the shell file-association that surfaces the "no script engine" dialog;
  // cscript's // switches bypass that association and could pass on systems
  // where wscript still errors.
  const wscriptPath = windowsPath.join(systemRootPath, "System32", "wscript.exe");
  if (!existsSync(wscriptPath)) {
    return false;
  }

  let workingDirectory: string | undefined;
  try {
    workingDirectory = mkdtempSync(joinPath(tmpdir(), "memmy-wsh-probe-"));
    const probeScript = windowsPath.join(workingDirectory, "probe.vbs");
    writeFileSync(probeScript, "WScript.Quit 0\r\n", { encoding: "ascii" });
    // Generous timeout to avoid false negatives on heavily loaded machines;
    // the trivial WScript.Quit script completes in milliseconds under normal
    // conditions.
    const CSCRIPT_PROBE_TIMEOUT_SECONDS = 5;
    const result = spawnSync(
      wscriptPath,
      ["//B", "//Nologo", `//T:${CSCRIPT_PROBE_TIMEOUT_SECONDS}`, probeScript],
      {
        stdio: "ignore",
        windowsHide: true
      }
    );
    // result.status is null when the process is killed by a signal (e.g. the
    // //T:5 timeout); the explicit error guard also covers spawn-time failures
    // where the engine is present but the launch itself was rejected.
    return result.status === 0 && result.error == null;
  } catch {
    return false;
  } finally {
    if (workingDirectory) {
      try {
        rmSync(workingDirectory, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup only; leaving a probe file behind is safe.
      }
    }
  }
};

/** @internal test hook: forget the memoized VBScript availability. */
export const resetWindowsScriptHostProbeCacheForTesting = (): void => {
  cachedWindowsScriptHostAvailable = null;
};
