import { spawn, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createWindowsStoreInstallState,
  resolveWindowsStoreInstallStatePath,
  writeWindowsStoreInstallState,
  type WindowsStoreInstallMode,
  type WindowsStoreInstallState
} from "./windows-store-install-state.js";
import {
  stageWindowsStoreUpdateFinalizer,
  type StageWindowsStoreUpdateFinalizerOptions,
  type WindowsStoreFinalizerStagedResult
} from "./windows-store-update.js";

const STORE_UPDATE_INSTALLER_READY_TIMEOUT_MS = 15_000;

interface PrepareWindowsStoreInstallHandoffOptions {
  resourcesPath: string;
  userDataPath: string;
  mode: WindowsStoreInstallMode;
  baselinePackageVersion: string;
  baselinePackageFullName: string;
  oldPid: number;
  aumid: string;
  packageFamilyName: string;
  now?: Date;
}

export interface WindowsStoreInstallHandoff {
  helperPath: string;
  externalHelperPath: string;
  statePath: string;
  resultPath: string;
  logPath: string;
  externalReadyPath: string;
  installerReadyPath: string;
  attemptId: string;
  externalHelperSha256: string;
  state: WindowsStoreInstallState;
}

export interface WindowsStoreInstallerReadyReceipt {
  type: "installer-ready";
  attemptId: string;
  pid: number;
  finalizerPid: number;
  path: string;
  sha256: string;
}

export interface WindowsStoreInstallHandoffChild {
  pid?: number;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "exit" | "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this;
  kill(): boolean;
  unref(): void;
}

interface PrepareWindowsStoreInstallHandoffDependencies {
  createAttemptId?: () => string;
  stageFinalizer?: (
    options: StageWindowsStoreUpdateFinalizerOptions
  ) => Promise<WindowsStoreFinalizerStagedResult>;
}

interface StartWindowsStoreInstallHandoffDependencies {
  spawnDetached?: (
    executable: string,
    args: string[],
    options: SpawnOptions
  ) => WindowsStoreInstallHandoffChild;
  reportChildError?: (error: Error) => void;
  waitForReady?: (
    readyPath: string,
    timeoutMs: number,
    signal: AbortSignal
  ) => Promise<WindowsStoreInstallerReadyReceipt>;
  isProcessAlive?: (pid: number) => boolean;
}

export interface WindowsStoreInstallFlight<Result> {
  baselinePackageFullName: string;
  mode: WindowsStoreInstallMode;
  promise: Promise<Result>;
}

interface WindowsStoreInstallSingleFlightCallbacks<Result> {
  onStart?: (flight: WindowsStoreInstallFlight<Result>) => void;
  onFailure?: (flight: WindowsStoreInstallFlight<Result>) => void;
}

export interface WindowsStoreInstallSingleFlight<Result> {
  current(): WindowsStoreInstallFlight<Result> | null;
  run(
    baselinePackageFullName: string,
    mode: WindowsStoreInstallMode,
    start: (mode: WindowsStoreInstallMode) => Promise<Result>
  ): Promise<Result>;
}

export const createWindowsStoreInstallSingleFlight = <Result>(
  callbacks: WindowsStoreInstallSingleFlightCallbacks<Result> = {}
): WindowsStoreInstallSingleFlight<Result> => {
  let active: WindowsStoreInstallFlight<Result> | null = null;
  return {
    current: () => active,
    run: (baselinePackageFullName, mode, start) => {
      if (active) {
        if (active.baselinePackageFullName !== baselinePackageFullName) {
          throw new Error(
            "A different Microsoft Store package baseline is already being installed"
          );
        }
        return active.promise;
      }

      let resolveFlight!: (result: Result | PromiseLike<Result>) => void;
      let rejectFlight!: (error: unknown) => void;
      const promise = new Promise<Result>((resolve, reject) => {
        resolveFlight = resolve;
        rejectFlight = reject;
      });
      const flight: WindowsStoreInstallFlight<Result> = {
        baselinePackageFullName,
        mode,
        promise
      };
      // Publish the flight before invoking any callback or async install work. Every trigger that
      // arrives from this point onward joins this exact promise and preserves the original mode.
      active = flight;
      try {
        callbacks.onStart?.(flight);
        void start(mode).then(resolveFlight, rejectFlight);
      } catch (error) {
        rejectFlight(error);
      }
      void promise.then(undefined, () => {
        if (active === flight) {
          active = null;
          callbacks.onFailure?.(flight);
        }
      });
      return promise;
    }
  };
};

export const prepareWindowsStoreInstallHandoff = async (
  options: PrepareWindowsStoreInstallHandoffOptions,
  dependencies: PrepareWindowsStoreInstallHandoffDependencies = {}
): Promise<WindowsStoreInstallHandoff> => {
  const helperPath = join(options.resourcesPath, "native", "MemmyStoreUpdate.exe");
  await access(helperPath).catch(() => {
    throw new Error(`Microsoft Store update helper is unavailable: ${helperPath}`);
  });

  const requestedAttemptId = (dependencies.createAttemptId ?? randomUUID)();
  const state = createWindowsStoreInstallState({ ...options, attemptId: requestedAttemptId });
  const attemptId = state.attemptId!;
  const packageFamilyName = state.packageFamilyName;
  const statePath = resolveWindowsStoreInstallStatePath(options.userDataPath, packageFamilyName);
  const stageFinalizer = dependencies.stageFinalizer ?? stageWindowsStoreUpdateFinalizer;

  const stagedFinalizer = await stageFinalizer({
    resourcesPath: options.resourcesPath,
    packageFamilyName,
    attemptId
  });
  if (stagedFinalizer.attemptId !== attemptId) {
    throw new Error("Microsoft Store update helper returned a mismatched staging attempt");
  }
  const externalHelperPath = stagedFinalizer.path;
  await writeWindowsStoreInstallState(statePath, state);
  return {
    helperPath,
    externalHelperPath,
    statePath,
    resultPath: stagedFinalizer.resultPath,
    logPath: stagedFinalizer.logPath,
    externalReadyPath: stagedFinalizer.externalReadyPath,
    installerReadyPath: stagedFinalizer.installerReadyPath,
    attemptId,
    externalHelperSha256: stagedFinalizer.sha256,
    state
  };
};

export const startWindowsStoreInstallHandoff = async (
  handoff: WindowsStoreInstallHandoff,
  dependencies: StartWindowsStoreInstallHandoffDependencies = {}
): Promise<number> => {
  const spawnDetached = dependencies.spawnDetached ?? defaultSpawnDetached;
  let child: WindowsStoreInstallHandoffChild;
  try {
    child = spawnDetached(handoff.helperPath, buildHandoffArguments(handoff), {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
  } catch (cause) {
    throw new Error("Microsoft Store update handoff failed to spawn", { cause });
  }

  const reportChildError = dependencies.reportChildError ?? defaultReportChildError;
  let readyConfirmed = false;
  let rejectChildStartup: ((error: Error) => void) | undefined;
  const childStartupFailure = new Promise<never>((_resolve, reject) => {
    rejectChildStartup = reject;
  });
  child.once("error", (error) => {
    reportChildError(error);
    if (!readyConfirmed) {
      rejectChildStartup?.(new Error("Microsoft Store update handoff child failed before installer readiness", {
        cause: error
      }));
    }
  });
  const rejectOnEarlyExit = (event: "exit" | "close") => (
    code: number | null,
    signal: NodeJS.Signals | null
  ): void => {
    if (!readyConfirmed) {
      const eventDescription = event === "exit" ? "exited" : "closed";
      rejectChildStartup?.(new Error(
        `Microsoft Store update handoff child ${eventDescription} before installer readiness ` +
        `(code ${code ?? "unknown"}, signal ${signal ?? "none"})`
      ));
    }
  };
  child.once("exit", rejectOnEarlyExit("exit"));
  child.once("close", rejectOnEarlyExit("close"));
  const pid = child.pid;
  const waitForReady = dependencies.waitForReady ?? waitForInstallerReady;
  const isProcessAlive = dependencies.isProcessAlive ?? defaultIsProcessAlive;
  let readyAbortController: AbortController | undefined;
  try {
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error("Microsoft Store update handoff did not report a process ID");
    }
    readyAbortController = new AbortController();
    const receipt = await Promise.race([
      waitForReady(
        handoff.installerReadyPath,
        STORE_UPDATE_INSTALLER_READY_TIMEOUT_MS,
        readyAbortController.signal
      ),
      childStartupFailure
    ]);
    readyAbortController.abort();
    validateInstallerReadyReceipt(receipt, handoff, pid);
    if (!isProcessAlive(pid) || !isProcessAlive(receipt.finalizerPid)) {
      throw new Error("Microsoft Store update handoff process exited before readiness could be accepted");
    }
    readyConfirmed = true;
  } catch (error) {
    readyConfirmed = true;
    readyAbortController?.abort();
    try { child.kill(); } catch { /* Keep the old application running even if cleanup fails. */ }
    throw error;
  }
  child.unref();
  return pid;
};

const buildHandoffArguments = (handoff: WindowsStoreInstallHandoff): string[] => [
  "handoff-install",
  "--external-helper-path",
  handoff.externalHelperPath,
  "--state-path",
  handoff.statePath,
  "--result-path",
  handoff.resultPath,
  "--log-path",
  handoff.logPath,
  "--external-ready-path",
  handoff.externalReadyPath,
  "--ready-path",
  handoff.installerReadyPath,
  "--old-pid",
  String(handoff.state.oldPid),
  "--baseline-package-version",
  handoff.state.baselinePackageVersion,
  "--baseline-package-full-name",
  handoff.state.baselinePackageFullName,
  "--created-at",
  handoff.state.createdAt,
  "--aumid",
  handoff.state.aumid,
  "--package-family-name",
  handoff.state.packageFamilyName,
  "--attempt-id",
  handoff.attemptId,
  "--external-helper-sha256",
  handoff.externalHelperSha256,
  "--mode",
  handoff.state.mode
];

const defaultSpawnDetached = (
  executable: string,
  args: string[],
  options: SpawnOptions
): WindowsStoreInstallHandoffChild => spawn(executable, args, options);

const defaultReportChildError = (error: Error): void => {
  console.warn("Microsoft Store update handoff child process failed:", error);
};

const waitForInstallerReady = async (
  readyPath: string,
  timeoutMs: number,
  signal: AbortSignal
): Promise<WindowsStoreInstallerReadyReceipt> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal.aborted) {
      throw signal.reason;
    }
    try {
      const value = JSON.parse(await readFile(readyPath, "utf8")) as unknown;
      if (isInstallerReadyReceipt(value)) {
        return value;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
    await delay(50, undefined, { signal });
  }
  throw new Error(`Microsoft Store update installer did not become ready within ${timeoutMs}ms`);
};

const validateInstallerReadyReceipt = (
  receipt: WindowsStoreInstallerReadyReceipt,
  handoff: WindowsStoreInstallHandoff,
  childPid: number
): void => {
  if (receipt.pid !== childPid ||
      receipt.attemptId !== handoff.attemptId ||
      receipt.path !== handoff.externalHelperPath ||
      receipt.sha256.toLowerCase() !== handoff.externalHelperSha256.toLowerCase()) {
    throw new Error("Microsoft Store update installer returned a mismatched readiness receipt");
  }
};

const isInstallerReadyReceipt = (value: unknown): value is WindowsStoreInstallerReadyReceipt => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return candidate.type === "installer-ready" &&
    typeof candidate.attemptId === "string" &&
    typeof candidate.pid === "number" &&
    Number.isSafeInteger(candidate.pid) &&
    candidate.pid > 0 &&
    typeof candidate.finalizerPid === "number" &&
    Number.isSafeInteger(candidate.finalizerPid) &&
    candidate.finalizerPid > 0 &&
    typeof candidate.path === "string" &&
    candidate.path.length > 0 &&
    typeof candidate.sha256 === "string" &&
    /^[0-9a-f]{64}$/iu.test(candidate.sha256);
};

const defaultIsProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
