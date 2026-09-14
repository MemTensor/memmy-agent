import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const STORE_UPDATE_INSTALL_STATE_FILE = "store-update-install-state-v2.json";
export const STORE_UPDATE_INSTALL_NAMESPACE_DIRECTORY = "store-update";
export const STORE_UPDATE_INSTALL_STALE_MS = 30 * 60 * 1000;

export type WindowsStoreInstallMode = "manual" | "silent";
export type WindowsStoreInstallStatus = "installing" | "completed" | "failed";

export interface WindowsStoreInstallState {
  schemaVersion: 2;
  mode: WindowsStoreInstallMode;
  status: WindowsStoreInstallStatus;
  baselinePackageVersion: string;
  baselinePackageFullName: string;
  oldPid: number;
  createdAt: string;
  updatedAt: string;
  autoActivateOnSuccess: boolean;
  aumid: string;
  packageFamilyName: string;
  nativeState: string | null;
  hresult: string | null;
  failureReason: string | null;
  failurePending: boolean;
}

interface CreateWindowsStoreInstallStateOptions {
  mode: WindowsStoreInstallMode;
  baselinePackageVersion: string;
  baselinePackageFullName: string;
  oldPid: number;
  aumid: string;
  packageFamilyName: string;
  now?: Date;
}

interface ResolveWindowsStoreStartupDecisionOptions {
  state: WindowsStoreInstallState | null;
  currentPackageVersion: string;
  currentPackageFullName: string;
  now?: Date;
}

export type WindowsStoreStartupDecision = {
  action: "continue" | "block";
  reason: "none" | "installing" | "updated" | "failed" | "expired";
  nextState: WindowsStoreInstallState | null;
};

export const createWindowsStoreInstallState = (
  options: CreateWindowsStoreInstallStateOptions
): WindowsStoreInstallState => {
  const timestamp = (options.now ?? new Date()).toISOString();
  return {
    schemaVersion: 2,
    mode: options.mode,
    status: "installing",
    baselinePackageVersion: normalizeVersion(options.baselinePackageVersion),
    baselinePackageFullName: normalizePackageFullName(options.baselinePackageFullName),
    oldPid: normalizeProcessId(options.oldPid),
    createdAt: timestamp,
    updatedAt: timestamp,
    autoActivateOnSuccess: options.mode === "manual",
    aumid: normalizeAumid(options.aumid),
    packageFamilyName: normalizePackageFamilyName(options.packageFamilyName),
    nativeState: null,
    hresult: null,
    failureReason: null,
    failurePending: false
  };
};

export const resolveWindowsStoreStartupDecision = (
  options: ResolveWindowsStoreStartupDecisionOptions
): WindowsStoreStartupDecision => {
  const { state } = options;
  if (!state) {
    return { action: "continue", reason: "none", nextState: null };
  }
  const currentPackageVersion = normalizeVersion(options.currentPackageVersion);
  const currentPackageFullName = normalizePackageFullName(options.currentPackageFullName);
  const versionComparison = compareWindowsPackageVersions(currentPackageVersion, state.baselinePackageVersion);
  if (versionComparison > 0 ||
      (versionComparison === 0 && currentPackageFullName !== state.baselinePackageFullName)) {
    return { action: "continue", reason: "updated", nextState: null };
  }
  if (state.status === "failed") {
    return { action: "continue", reason: "failed", nextState: state };
  }
  if (state.status === "completed") {
    return { action: "continue", reason: "failed", nextState: markExpiredState(state, options.now ?? new Date()) };
  }

  const now = options.now ?? new Date();
  const updatedAt = Date.parse(state.updatedAt);
  if (!Number.isFinite(updatedAt) || now.getTime() - updatedAt > STORE_UPDATE_INSTALL_STALE_MS) {
    return { action: "continue", reason: "expired", nextState: markExpiredState(state, now) };
  }
  return { action: "block", reason: "installing", nextState: state };
};

export const compareWindowsPackageVersions = (left: string, right: string): number => {
  const leftParts = parseVersionParts(left);
  const rightParts = parseVersionParts(right);
  for (let index = 0; index < 4; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference > 0 ? 1 : -1;
    }
  }
  return 0;
};

export const resolveWindowsStoreInstallNamespaceDirectory = (
  rootPath: string,
  packageFamilyName: string
): string => join(
  rootPath,
  STORE_UPDATE_INSTALL_NAMESPACE_DIRECTORY,
  normalizePackageFamilyName(packageFamilyName)
);

export const resolveWindowsStoreInstallStatePath = (
  userDataPath: string,
  packageFamilyName: string
): string => join(
  resolveWindowsStoreInstallNamespaceDirectory(userDataPath, packageFamilyName),
  STORE_UPDATE_INSTALL_STATE_FILE
);

export const readWindowsStoreInstallState = async (
  statePath: string
): Promise<WindowsStoreInstallState | null> => {
  try {
    return parseWindowsStoreInstallState(await readFile(statePath, "utf8"));
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
};

export const writeWindowsStoreInstallState = async (
  statePath: string,
  state: WindowsStoreInstallState
): Promise<void> => {
  const validated = parseWindowsStoreInstallState(JSON.stringify(state));
  await mkdir(dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await rename(temporaryPath, statePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
};

export const updateWindowsStoreInstallState = async (
  statePath: string,
  resolveNext: (current: WindowsStoreInstallState) => WindowsStoreInstallState
): Promise<WindowsStoreInstallState> => {
  const current = await readWindowsStoreInstallState(statePath);
  if (!current) {
    throw new Error("Microsoft Store update install state is missing");
  }
  const next = parseWindowsStoreInstallState(JSON.stringify(resolveNext(current)));
  await writeWindowsStoreInstallState(statePath, next);
  return next;
};

export const clearWindowsStoreInstallState = async (statePath: string): Promise<void> => {
  await rm(statePath, { force: true });
};

const markExpiredState = (
  state: WindowsStoreInstallState,
  now: Date
): WindowsStoreInstallState => ({
  ...state,
  status: "failed",
  updatedAt: now.toISOString(),
  nativeState: "timeout",
  hresult: null,
  failureReason: "The Microsoft Store update handoff expired before the baseline package was replaced",
  failurePending: true
});

const parseWindowsStoreInstallState = (contents: string): WindowsStoreInstallState => {
  const value = JSON.parse(contents) as unknown;
  if (!isRecord(value) ||
      value.schemaVersion !== 2 ||
      (value.mode !== "manual" && value.mode !== "silent") ||
      (value.status !== "installing" && value.status !== "completed" && value.status !== "failed") ||
      typeof value.baselinePackageVersion !== "string" ||
      typeof value.baselinePackageFullName !== "string" ||
      typeof value.oldPid !== "number" ||
      typeof value.createdAt !== "string" ||
      typeof value.updatedAt !== "string" ||
      typeof value.autoActivateOnSuccess !== "boolean" ||
      typeof value.aumid !== "string" ||
      typeof value.packageFamilyName !== "string" ||
      !isNullableString(value.nativeState) ||
      !isNullableString(value.hresult) ||
      !isNullableString(value.failureReason) ||
      typeof value.failurePending !== "boolean") {
    throw new Error("Microsoft Store update install state is invalid");
  }
  return {
    schemaVersion: 2,
    mode: value.mode,
    status: value.status,
    baselinePackageVersion: normalizeVersion(value.baselinePackageVersion),
    baselinePackageFullName: normalizePackageFullName(value.baselinePackageFullName),
    oldPid: normalizeProcessId(value.oldPid),
    createdAt: normalizeTimestamp(value.createdAt),
    updatedAt: normalizeTimestamp(value.updatedAt),
    autoActivateOnSuccess: value.autoActivateOnSuccess,
    aumid: normalizeAumid(value.aumid),
    packageFamilyName: normalizePackageFamilyName(value.packageFamilyName),
    nativeState: value.nativeState,
    hresult: value.hresult,
    failureReason: value.failureReason,
    failurePending: value.failurePending
  };
};

const parseVersionParts = (value: string): [number, number, number, number] => {
  const normalized = normalizeVersion(value);
  const parts = normalized.split(".").map((part) => Number.parseInt(part, 10));
  while (parts.length < 4) {
    parts.push(0);
  }
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 0];
};

const normalizeVersion = (value: string): string => {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d+){0,3}$/u.test(normalized)) {
    throw new Error(`Invalid Windows package version: ${value}`);
  }
  return normalized;
};

const normalizePackageFullName = (value: string): string => {
  const normalized = value.trim();
  if (normalized.length < 3 || normalized.length > 255 || !/^[A-Za-z0-9._-]+$/u.test(normalized)) {
    throw new Error(`Invalid Windows package full name: ${value}`);
  }
  return normalized;
};

const normalizeProcessId = (value: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Microsoft Store update old PID is invalid");
  }
  return value;
};

const normalizeAumid = (value: string): string => {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._-]{1,128}![A-Za-z0-9._-]{1,64}$/u.test(normalized)) {
    throw new Error("Microsoft Store update AUMID is invalid");
  }
  return normalized;
};

const normalizePackageFamilyName = (value: string): string => {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._-]{1,128}_[A-Za-z0-9]{1,32}$/u.test(normalized)) {
    throw new Error("Microsoft Store update package family name is invalid");
  }
  return normalized;
};

const normalizeTimestamp = (value: string): string => {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("Microsoft Store update timestamp is invalid");
  }
  return new Date(timestamp).toISOString();
};

const isNullableString = (value: unknown): value is string | null => {
  return value === null || typeof value === "string";
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const isMissingFileError = (error: unknown): boolean => {
  return isRecord(error) && error.code === "ENOENT";
};
