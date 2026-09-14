import { execFile, type ChildProcess } from "node:child_process";
import { lstat } from "node:fs/promises";
import { win32 } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HELPER_FILE = "MemmyStoreUpdate.exe";
const JOURNAL_RECOVERY_TIMEOUT_MS = 15_000;

export interface EnsureWindowsStoreLegacyCleanupBrokerOptions {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  isWindowsStore: boolean;
  resourcesPath: string;
  packageFamilyName: string;
}

export interface EnsureWindowsStoreLegacyCleanupBrokerDependencies {
  runHelper?: (helperPath: string, args: string[]) => Promise<void>;
}

export type EnsureWindowsStoreLegacyCleanupBrokerResult =
  | { status: "not-applicable" }
  | { status: "ready" };

export interface RecoverWindowsStoreLegacyCleanupJournalOptions {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  isWindowsStore: boolean;
  resourcesPath: string;
  localAppDataPath: string;
}

export interface RecoverWindowsStoreLegacyCleanupJournalDependencies {
  journalExists?: (journalPath: string) => Promise<boolean>;
  runHelper?: (helperPath: string, args: string[]) => Promise<string>;
}

export type RecoverWindowsStoreLegacyCleanupJournalResult =
  | { status: "not-applicable" }
  | { status: "no-journal" }
  | { status: "recovered" };

/**
 * Retires an orphaned native journal before the NSIS startup lifetime is held.
 * This one-shot command never starts or registers the resident cleanup broker.
 * Callers must preserve the normal source barrier if recovery fails.
 */
export const recoverWindowsStoreLegacyCleanupJournal = async (
  options: RecoverWindowsStoreLegacyCleanupJournalOptions,
  dependencies: RecoverWindowsStoreLegacyCleanupJournalDependencies = {}
): Promise<RecoverWindowsStoreLegacyCleanupJournalResult> => {
  if (options.platform !== "win32" || !options.isPackaged || options.isWindowsStore) {
    return { status: "not-applicable" };
  }
  for (const [label, path] of [
    ["resources", options.resourcesPath],
    ["local app data", options.localAppDataPath]
  ]) {
    if (!path || path !== path.trim() || !win32.isAbsolute(path)) {
      throw new Error(`Windows orphan cleanup journal ${label} path must be absolute`);
    }
  }
  const journalPath = win32.join(
    options.localAppDataPath, "Memmy", "store-transition", "broker", "cleanup-journal-v1.bin"
  );
  if (!await (dependencies.journalExists ?? fixedJournalExists)(journalPath)) {
    return { status: "no-journal" };
  }
  const output = await (dependencies.runHelper ?? runJournalRecoveryHelper)(
    win32.join(options.resourcesPath, "native", HELPER_FILE),
    ["recover-legacy-cleanup-journal"]
  );
  const result: unknown = JSON.parse(output);
  if (typeof result !== "object" || result === null || !("status" in result)
      || (result.status !== "no-journal" && result.status !== "recovered")) {
    throw new Error("Windows orphan cleanup journal helper returned an invalid result");
  }
  return { status: result.status };
};

const fixedJournalExists = async (journalPath: string): Promise<boolean> => {
  try {
    const entry = await lstat(journalPath);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("Windows orphan cleanup journal must be a regular file");
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const runJournalRecoveryHelper = (helperPath: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    let settled = false;
    let child: ChildProcess | undefined;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Windows orphan cleanup journal helper timed out after ${JOURNAL_RECOVERY_TIMEOUT_MS}ms`));
      // Rejection must not depend on a wedged helper closing its inherited pipes.
      try { child?.kill(); } catch { /* The caller already received the timeout. */ }
      child?.stdout?.destroy();
      child?.stderr?.destroy();
    }, JOURNAL_RECOVERY_TIMEOUT_MS);
    timer.unref?.();
    try {
      child = execFile(helperPath, args, {
        timeout: JOURNAL_RECOVERY_TIMEOUT_MS,
        windowsHide: true,
        encoding: "utf8"
      }, (error, stdout) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(stdout);
      });
    } catch (error) {
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
  });

/**
 * Starts the cleanup broker while the caller is still the unpackaged NSIS app.
 * A Store process must never start this broker because its registry context may
 * remain virtualized even after a child loses package identity.
 */
export const ensureWindowsStoreLegacyCleanupBroker = async (
  options: EnsureWindowsStoreLegacyCleanupBrokerOptions,
  dependencies: EnsureWindowsStoreLegacyCleanupBrokerDependencies = {}
): Promise<EnsureWindowsStoreLegacyCleanupBrokerResult> => {
  if (options.platform !== "win32" || !options.isPackaged || options.isWindowsStore) {
    return { status: "not-applicable" };
  }
  if (!options.resourcesPath || options.resourcesPath !== options.resourcesPath.trim()) {
    throw new Error("Windows legacy cleanup broker resources path is unavailable");
  }
  if (!/^[A-Za-z0-9.-]+_[A-Za-z0-9.-]+$/u.test(options.packageFamilyName)) {
    throw new Error("Windows legacy cleanup broker package family is invalid");
  }
  const helperPath = win32.join(options.resourcesPath, "native", HELPER_FILE);
  await (dependencies.runHelper ?? runBrokerHelper)(helperPath, [
    "ensure-legacy-cleanup-broker",
    "--package-family-name",
    options.packageFamilyName
  ]);
  return { status: "ready" };
};

const runBrokerHelper = async (helperPath: string, args: string[]): Promise<void> => {
  await execFileAsync(helperPath, args, {
    timeout: 15_000,
    windowsHide: true
  });
};
