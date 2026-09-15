import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { win32 } from "node:path";
import { promisify } from "node:util";
import type { WindowsStoreLegacyTransitionOptions } from "./windows-store-legacy-transition.js";
import { importWindowsStoreDataOnce } from "./windows-store-first-run-import.js";
import { writeWindowsStoreFirstRunRecord, type WindowsStoreFirstRunRecord } from "./windows-store-first-run-state.js";

const PRE_READY_WORKER_TIMEOUT_MS = 10 * 60 * 1_000;

export interface WindowsStoreTransitionPreReadyInput {
  legacy: WindowsStoreLegacyTransitionOptions;
  recoveryOnlyError?: string;
}

export interface RunWindowsStoreTransitionPreReadyWorkerOptions {
  executablePath: string;
  workerPath: string;
  input: WindowsStoreTransitionPreReadyInput;
}

export interface RunWindowsStoreTransitionPreReadyWorkerDependencies {
  execWorker?: typeof execFileSync;
}

export interface ExecuteWindowsStoreTransitionPreReadyDependencies {
  importData?: typeof importWindowsStoreDataOnce;
  stopLegacy?: (options: WindowsStoreLegacyTransitionOptions) => Promise<boolean>;
  writeRecord?: typeof writeWindowsStoreFirstRunRecord;
}

export type WindowsStoreTransitionPreReadyResult =
  | { status: "blocked" }
  | { status: "ready"; record: WindowsStoreFirstRunRecord };

/** The worker imports data once, independently of the old installer's compatibility protocol. */
export const executeWindowsStoreTransitionPreReady = async (
  input: WindowsStoreTransitionPreReadyInput,
  dependencies: ExecuteWindowsStoreTransitionPreReadyDependencies = {}
): Promise<WindowsStoreTransitionPreReadyResult> => {
  // Only process ownership is checked again. The importer itself has a durable one-time marker.
  try {
    if (!await (dependencies.stopLegacy ?? stopLegacyForStoreStartup)(input.legacy)) return { status: "blocked" };
  } catch {
    return { status: "blocked" };
  }
  const record = await (dependencies.importData ?? importWindowsStoreDataOnce)(input.legacy, {
    recoveryOnlyError: input.recoveryOnlyError
  });
  if (record.status === "failed") {
    // A legacy process can relaunch during copying. Only this confirmed occupancy
    // defers startup and leaves the import retryable after the user closes it.
    let clear = false;
    try { clear = await (dependencies.stopLegacy ?? stopLegacyForStoreStartup)(input.legacy); } catch { /* unknown ownership */ }
    if (!clear) {
      await (dependencies.writeRecord ?? writeWindowsStoreFirstRunRecord)(input.legacy.storeUserDataPath,
        { ...record, retryAfterLegacyExit: true }).catch(() => undefined);
      return { status: "blocked" };
    }
  }
  return { status: "ready", record };
};

/** Independent last resort when the JS worker itself is missing or has crashed. */
export const stopLegacyForStoreStartupSync = (options: WindowsStoreLegacyTransitionOptions): boolean => {
  try {
    const output = execFileSync(win32.join(options.resourcesPath, "native", "MemmyStoreUpdate.exe"),
      ["stop-legacy-for-data-import"], { timeout: 30_000, windowsHide: true, encoding: "utf8" });
    recordLegacyStopResult(options, String(output));
    return JSON.parse(output).status === "clear";
  } catch (error) {
    recordLegacyStopResult(options, describeLegacyStopError(error));
    return false;
  }
};

const stopLegacyForStoreStartup = async (options: WindowsStoreLegacyTransitionOptions): Promise<boolean> => {
  try {
    const result = await promisify(execFile)(win32.join(options.resourcesPath, "native", "MemmyStoreUpdate.exe"), [
      "stop-legacy-for-data-import"
    ], { timeout: 30_000, windowsHide: true });
    recordLegacyStopResult(options, `${result.stderr}\n${result.stdout}`);
    return (JSON.parse(result.stdout) as { status?: string }).status === "clear";
  } catch (error) {
    recordLegacyStopResult(options, describeLegacyStopError(error));
    throw error;
  }
};

const describeLegacyStopError = (error: unknown): string => {
  const processError = error as { stdout?: unknown; stderr?: unknown } | null;
  return `${String(error)}\n${String(processError?.stderr ?? "")}\n${String(processError?.stdout ?? "")}`;
};

const recordLegacyStopResult = (options: WindowsStoreLegacyTransitionOptions, details: string): void => {
  try {
    const directory = win32.dirname(options.storeUserDataPath);
    mkdirSync(directory, { recursive: true });
    appendFileSync(win32.join(directory, "store-legacy-stop.log"), `[${new Date().toISOString()}]\n${details.trim()}\n`, "utf8");
  } catch { /* Diagnostic file permissions must not change the process-exit decision. */ }
};

/**
 * Blocks the Electron main thread on a short-lived Node child while the destination profile is
 * still unlocked. The child reuses the normal transactional migration implementation instead of
 * maintaining a second synchronous copy algorithm.
 */
export const runWindowsStoreTransitionPreReadyWorker = (
  options: RunWindowsStoreTransitionPreReadyWorkerOptions,
  dependencies: RunWindowsStoreTransitionPreReadyWorkerDependencies = {}
): WindowsStoreTransitionPreReadyResult => {
  const executablePath = normalizeExecutablePath(options.executablePath);
  const workerPath = normalizeWorkerPath(options.workerPath);
  const payload = Buffer.from(JSON.stringify(options.input), "utf8").toString("base64url");
  const output = (dependencies.execWorker ?? execFileSync)(executablePath, [workerPath, payload], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1"
    },
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: PRE_READY_WORKER_TIMEOUT_MS,
    windowsHide: true
  });
  const result = JSON.parse(String(output)) as WindowsStoreTransitionPreReadyResult;
  if (result.status !== "ready" && result.status !== "blocked") throw new Error("Invalid Store startup worker result");
  return result;
};

const normalizeExecutablePath = (value: string): string => {
  if (!value || value !== value.trim() || !win32.isAbsolute(value) || win32.extname(value).toLowerCase() !== ".exe") {
    throw new Error("Windows Store pre-ready worker executable path is invalid");
  }
  return win32.normalize(value);
};

const normalizeWorkerPath = (value: string): string => {
  if (!value || value !== value.trim() || !win32.isAbsolute(value) || win32.extname(value).toLowerCase() !== ".js") {
    throw new Error("Windows Store pre-ready worker script path is invalid");
  }
  return win32.normalize(value);
};
