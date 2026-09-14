import { randomUUID } from "node:crypto";
import { readFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, win32 } from "node:path";
import {
  resolveWindowsStoreMigrationIdentity,
  type WindowsStoreMigrationIdentity
} from "./windows-store-migration-config.js";

export const WINDOWS_STORE_TRANSITION_PHASES = [
  "authority-recorded",
  "store-install-launched",
  "package-registered",
  "data-prepared",
  "awaiting-app-verification",
  "app-verified",
  // Historical phase written by the pre-broker cleanup path. It is accepted
  // for recovery, but is not native-HKCU cleanup proof.
  "legacy-cleanup-complete",
  "legacy-cleanup-attested",
  "cleanup-eligible",
  "cleaned"
] as const;

export type WindowsStoreTransitionPhase = typeof WINDOWS_STORE_TRANSITION_PHASES[number];
export type WindowsStoreTransitionAuthority = "current-install-authority";

export interface WindowsStoreTransitionBinding extends WindowsStoreMigrationIdentity {
  transactionId: string;
  sourceExecutablePath: string;
  sourceInstallDirectory: string;
  sourceVersion: string;
  sourceUserDataPath: string;
  sourceRuntimeHomePath: string;
  authority: WindowsStoreTransitionAuthority;
}

export interface WindowsStoreTransitionState extends WindowsStoreTransitionBinding {
  schemaVersion: 1;
  phase: WindowsStoreTransitionPhase;
  createdAt: string;
  updatedAt: string;
}

export type CreateWindowsStoreTransitionStateOptions = Omit<
  WindowsStoreTransitionBinding,
  "transactionId"
> & {
  transactionId?: string;
  now?: Date;
};

export interface UpdateWindowsStoreTransitionStateOptions {
  expectedBinding: WindowsStoreTransitionBinding;
  nextPhase: WindowsStoreTransitionPhase;
  now?: Date;
}

export const resolveWindowsStoreTransitionStatePath = (localAppDataPath: string): string => {
  if (!localAppDataPath || localAppDataPath !== localAppDataPath.trim() || !win32.isAbsolute(localAppDataPath)) {
    throw new Error("Windows Store transition LocalAppData path must be absolute");
  }
  const normalizedLocalAppDataPath = win32.normalize(localAppDataPath);
  if (normalizedLocalAppDataPath === win32.parse(normalizedLocalAppDataPath).root) {
    throw new Error("Windows Store transition LocalAppData path must not be a drive root");
  }
  return win32.join(normalizedLocalAppDataPath, "Memmy", "store-transition", "active.json");
};

const stateKeys = [
  "schemaVersion",
  "phase",
  "transactionId",
  "edition",
  "storeId",
  "packageFamilyName",
  "aumid",
  "sourceExecutablePath",
  "sourceInstallDirectory",
  "sourceVersion",
  "sourceUserDataPath",
  "sourceRuntimeHomePath",
  "authority",
  "createdAt",
  "updatedAt"
] as const;

const bindingKeys: ReadonlyArray<keyof WindowsStoreTransitionBinding> = [
  "transactionId",
  "edition",
  "storeId",
  "packageFamilyName",
  "aumid",
  "sourceExecutablePath",
  "sourceInstallDirectory",
  "sourceVersion",
  "sourceUserDataPath",
  "sourceRuntimeHomePath",
  "authority"
];

const phaseSet = new Set<string>(WINDOWS_STORE_TRANSITION_PHASES);

export const createWindowsStoreTransitionState = (
  options: CreateWindowsStoreTransitionStateOptions
): WindowsStoreTransitionState => {
  const timestamp = normalizeDate(options.now ?? new Date());
  const binding = normalizeBinding({
    ...options,
    transactionId: options.transactionId ?? randomUUID()
  });
  return {
    schemaVersion: 1,
    phase: "authority-recorded",
    ...binding,
    createdAt: timestamp,
    updatedAt: timestamp
  };
};

export const advanceWindowsStoreTransitionState = (
  state: WindowsStoreTransitionState,
  nextPhase: WindowsStoreTransitionPhase,
  now: Date = new Date()
): WindowsStoreTransitionState => {
  const current = parseWindowsStoreTransitionState(JSON.stringify(state));
  if (nextPhase === current.phase) return current;
  const allowedNextPhase: Partial<Record<WindowsStoreTransitionPhase, WindowsStoreTransitionPhase>> = {
    "authority-recorded": "store-install-launched",
    "store-install-launched": "package-registered",
    "package-registered": "data-prepared",
    "data-prepared": "awaiting-app-verification",
    "awaiting-app-verification": "app-verified",
    "app-verified": "legacy-cleanup-attested",
    // Old packages could write this after deleting only the MSIX-private HKCU
    // view. A new native-broker pass is mandatory before cleanup is eligible.
    "legacy-cleanup-complete": "legacy-cleanup-attested",
    "legacy-cleanup-attested": "cleanup-eligible",
    "cleanup-eligible": "cleaned"
  };
  if (allowedNextPhase[current.phase] !== nextPhase) {
    throw new Error(`Invalid Windows Store transition: ${current.phase} -> ${nextPhase}`);
  }

  const updatedAt = normalizeDate(now);
  if (Date.parse(updatedAt) < Date.parse(current.updatedAt)) {
    throw new Error("Windows Store transition timestamp cannot move backwards");
  }
  return { ...current, phase: nextPhase, updatedAt };
};

export const advanceWindowsStoreTransitionAfterSuccessfulBoot = (
  state: WindowsStoreTransitionState,
  now: Date = new Date()
): WindowsStoreTransitionState => {
  const current = parseWindowsStoreTransitionState(JSON.stringify(state));
  if (current.phase === "awaiting-app-verification") {
    return advanceWindowsStoreTransitionState(current, "app-verified", now);
  }
  if (current.phase === "app-verified") {
    return advanceWindowsStoreTransitionState(current, "legacy-cleanup-attested", now);
  }
  if (current.phase === "legacy-cleanup-complete") {
    return advanceWindowsStoreTransitionState(current, "legacy-cleanup-attested", now);
  }
  if (current.phase === "legacy-cleanup-attested") {
    return advanceWindowsStoreTransitionState(current, "cleanup-eligible", now);
  }
  if (current.phase === "cleanup-eligible" || current.phase === "cleaned") return current;
  throw new Error(`Invalid Windows Store successful-boot transition from ${current.phase}`);
};

export const assertWindowsStoreTransitionBinding = (
  state: WindowsStoreTransitionState,
  expectedBinding: WindowsStoreTransitionBinding
): void => {
  const current = parseWindowsStoreTransitionState(JSON.stringify(state));
  const expected = normalizeBinding({ ...expectedBinding });
  if (bindingKeys.some((key) => current[key] !== expected[key])) {
    throw new Error("Windows Store transition binding does not match the active transaction");
  }
};

export const parseWindowsStoreTransitionState = (contents: string): WindowsStoreTransitionState => {
  try {
    const value = JSON.parse(contents) as unknown;
    if (!isRecord(value) || !hasExactKeys(value, stateKeys) || value.schemaVersion !== 1) {
      throw new Error("invalid shape");
    }
    if (typeof value.phase !== "string" || !phaseSet.has(value.phase)) {
      throw new Error("invalid phase");
    }
    const binding = normalizeBinding(value);
    const createdAt = normalizeTimestamp(value.createdAt);
    const updatedAt = normalizeTimestamp(value.updatedAt);
    if (Date.parse(updatedAt) < Date.parse(createdAt)) {
      throw new Error("timestamps out of order");
    }
    return {
      schemaVersion: 1,
      phase: value.phase as WindowsStoreTransitionPhase,
      ...binding,
      createdAt,
      updatedAt
    };
  } catch (cause) {
    throw new Error("Windows Store transition journal is invalid", { cause });
  }
};

export const readWindowsStoreTransitionState = async (
  statePath: string
): Promise<WindowsStoreTransitionState | null> => {
  const validatedPath = normalizeStatePath(statePath);
  try {
    return parseWindowsStoreTransitionState(await readFile(validatedPath, "utf8"));
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
};

export const writeWindowsStoreTransitionState = async (
  statePath: string,
  state: WindowsStoreTransitionState
): Promise<void> => {
  const validatedPath = normalizeStatePath(statePath);
  const validatedState = parseWindowsStoreTransitionState(JSON.stringify(state));
  await mkdir(dirname(validatedPath), { recursive: true });
  const temporaryPath = `${validatedPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(validatedState, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx"
    });
    await rename(temporaryPath, validatedPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
};

export const updateWindowsStoreTransitionState = async (
  statePath: string,
  options: UpdateWindowsStoreTransitionStateOptions
): Promise<WindowsStoreTransitionState> => {
  const current = await readWindowsStoreTransitionState(statePath);
  if (!current) throw new Error("Windows Store transition journal is missing");
  assertWindowsStoreTransitionBinding(current, options.expectedBinding);
  const next = advanceWindowsStoreTransitionState(current, options.nextPhase, options.now);
  await writeWindowsStoreTransitionState(statePath, next);
  return next;
};

const normalizeBinding = (value: Record<string, unknown>): WindowsStoreTransitionBinding => {
  const identity = resolveWindowsStoreMigrationIdentity(value);
  if (!identity) throw new Error("Windows Store transition identity is invalid");
  const transactionId = normalizeTransactionId(value.transactionId);
  const sourceExecutablePath = normalizeWindowsPath(value.sourceExecutablePath, "source executable");
  const sourceInstallDirectory = normalizeWindowsDirectory(value.sourceInstallDirectory, "source install directory");
  const sourceUserDataPath = normalizeWindowsDirectory(value.sourceUserDataPath, "source userData");
  const sourceRuntimeHomePath = normalizeWindowsDirectory(value.sourceRuntimeHomePath, "source runtime");
  const executableRelativePath = win32.relative(sourceInstallDirectory, sourceExecutablePath);
  if (
    !executableRelativePath
    || executableRelativePath === ".."
    || executableRelativePath.startsWith(`..${win32.sep}`)
    || win32.isAbsolute(executableRelativePath)
    || !sameWindowsPath(win32.dirname(sourceExecutablePath), sourceInstallDirectory)
    || win32.extname(sourceExecutablePath).toLowerCase() !== ".exe"
    || containsWindowsAppsSegment(sourceExecutablePath)
    || containsWindowsAppsSegment(sourceInstallDirectory)
  ) {
    throw new Error("Windows Store transition source executable is outside its authoritative install directory");
  }
  if (typeof value.sourceVersion !== "string" || !/^\d+(?:\.\d+){2,3}$/u.test(value.sourceVersion)) {
    throw new Error("Windows Store transition source version is invalid");
  }
  if (value.authority !== "current-install-authority") {
    throw new Error("Windows Store transition authority is invalid");
  }
  return {
    transactionId,
    ...identity,
    sourceExecutablePath,
    sourceInstallDirectory,
    sourceVersion: value.sourceVersion,
    sourceUserDataPath,
    sourceRuntimeHomePath,
    authority: value.authority
  };
};

const normalizeTransactionId = (value: unknown): string => {
  if (typeof value !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error("Windows Store transition transaction ID is invalid");
  }
  return value.toLowerCase();
};

const normalizeWindowsPath = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value !== value.trim() || !win32.isAbsolute(value)) {
    throw new Error(`Windows Store transition ${label} path is invalid`);
  }
  const normalized = win32.normalize(value);
  if (normalized !== value) {
    throw new Error(`Windows Store transition ${label} path must be canonical`);
  }
  return normalized;
};

const normalizeWindowsDirectory = (value: unknown, label: string): string => {
  const normalized = normalizeWindowsPath(value, label);
  if (normalized === win32.parse(normalized).root) {
    throw new Error(`Windows Store transition ${label} must not be a drive root`);
  }
  return normalized;
};

const normalizeTimestamp = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("Windows Store transition timestamp is invalid");
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new Error("Windows Store transition timestamp is invalid");
  }
  return value;
};

const normalizeDate = (value: Date): string => {
  if (!Number.isFinite(value.getTime())) {
    throw new Error("Windows Store transition timestamp is invalid");
  }
  return value.toISOString();
};

const normalizeStatePath = (value: string): string => {
  if (!value || value !== value.trim() || !isAbsolute(value)) {
    throw new Error("Windows Store transition journal path must be absolute");
  }
  return value;
};

const containsWindowsAppsSegment = (value: string): boolean =>
  win32.normalize(value).split(win32.sep).some((segment) => segment.toLowerCase() === "windowsapps");

const sameWindowsPath = (left: string, right: string): boolean =>
  win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();

const hasExactKeys = (
  value: Record<string, unknown>,
  expectedKeys: readonly string[]
): boolean => {
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length && keys.every((key) => expectedKeys.includes(key));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isMissingFileError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
