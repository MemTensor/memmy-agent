import { spawn, type SpawnOptions } from "node:child_process";
import { access, copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createWindowsStoreInstallState,
  resolveWindowsStoreInstallNamespaceDirectory,
  resolveWindowsStoreInstallStatePath,
  writeWindowsStoreInstallState,
  type WindowsStoreInstallMode,
  type WindowsStoreInstallState
} from "./windows-store-install-state.js";

const STORE_UPDATE_HANDOFF_DIRECTORY = "handoff";
const STORE_UPDATE_EXTERNAL_DIRECTORY = join("Memmy", "store-update");
const STORE_UPDATE_EXTERNAL_HELPER_FILE = "MemmyStoreUpdate.exe";
const STORE_UPDATE_RESULT_FILE = "store-update-result-v1.txt";
const STORE_UPDATE_LOG_FILE = "store-update-handoff.jsonl";

interface PrepareWindowsStoreInstallHandoffOptions {
  resourcesPath: string;
  userDataPath: string;
  localAppDataPath: string;
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
  state: WindowsStoreInstallState;
}

export interface WindowsStoreInstallHandoffChild {
  pid?: number;
  once(event: "error", listener: (error: Error) => void): this;
  unref(): void;
}

interface StartWindowsStoreInstallHandoffDependencies {
  spawnDetached?: (
    executable: string,
    args: string[],
    options: SpawnOptions
  ) => WindowsStoreInstallHandoffChild;
  reportChildError?: (error: Error) => void;
}

export const prepareWindowsStoreInstallHandoff = async (
  options: PrepareWindowsStoreInstallHandoffOptions
): Promise<WindowsStoreInstallHandoff> => {
  const helperPath = join(options.resourcesPath, "native", "MemmyStoreUpdate.exe");
  await access(helperPath).catch(() => {
    throw new Error(`Microsoft Store update helper is unavailable: ${helperPath}`);
  });

  const state = createWindowsStoreInstallState(options);
  const packageFamilyName = state.packageFamilyName;
  const handoffDirectory = join(
    resolveWindowsStoreInstallNamespaceDirectory(options.userDataPath, packageFamilyName),
    STORE_UPDATE_HANDOFF_DIRECTORY
  );
  const externalDirectory = join(
    options.localAppDataPath,
    STORE_UPDATE_EXTERNAL_DIRECTORY,
    packageFamilyName
  );
  const externalHelperPath = join(externalDirectory, STORE_UPDATE_EXTERNAL_HELPER_FILE);
  const resultPath = join(handoffDirectory, STORE_UPDATE_RESULT_FILE);
  const logPath = join(handoffDirectory, STORE_UPDATE_LOG_FILE);
  const statePath = resolveWindowsStoreInstallStatePath(options.userDataPath, packageFamilyName);

  await mkdir(handoffDirectory, { recursive: true });
  await mkdir(externalDirectory, { recursive: true });
  await rm(resultPath, { force: true });
  await copyFile(helperPath, externalHelperPath);
  await writeWindowsStoreInstallState(statePath, state);
  return { helperPath, externalHelperPath, statePath, resultPath, logPath, state };
};

export const startWindowsStoreInstallHandoff = (
  handoff: WindowsStoreInstallHandoff,
  dependencies: StartWindowsStoreInstallHandoffDependencies = {}
): number => {
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
  child.once("error", (error) => reportChildError(error));
  const pid = child.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("Microsoft Store update handoff did not report a process ID");
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
