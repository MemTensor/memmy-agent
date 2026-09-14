import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { win32 } from "node:path";
import {
  readWindowsStoreLegacyInstallAuthoritySync,
  type WindowsStoreLegacyTransitionIdentity
} from "./windows-store-legacy-transition.js";
import {
  parseWindowsStoreTransitionState,
  readWindowsStoreTransitionState,
  resolveWindowsStoreTransitionStatePath,
  type WindowsStoreTransitionState
} from "./windows-store-transition-state.js";

const STORE_RUNTIME_SELECTION_AUTHORITY = "store-runtime-selection";
const STORE_RUNTIME_SELECTION_DISPOSITION = "shared-authoritative";

interface WindowsStoreRuntimeSelectionRecord {
  schemaVersion: 1;
  authority: typeof STORE_RUNTIME_SELECTION_AUTHORITY;
  runtimeDisposition: typeof STORE_RUNTIME_SELECTION_DISPOSITION;
  edition: "cn" | "intl";
  packageFamilyName: string;
  aumid: string;
  userDataPath: string;
  runtimeHomePath: string;
  sourceInstallDriveRoot: string;
  transactionId: string;
  committedAt: string;
}

export interface ResolveWindowsStoreRuntimeHomeForStartupOptions {
  localAppDataPath: string;
  roamingAppDataPath: string;
  homeDirectory: string;
  storeUserDataPath: string;
  identity: WindowsStoreLegacyTransitionIdentity;
}

export interface CommitWindowsStoreRuntimeSelectionOptions {
  localAppDataPath: string;
  roamingAppDataPath: string;
  homeDirectory: string;
  storeUserDataPath: string;
  runtimeHomePath: string;
  identity: WindowsStoreLegacyTransitionIdentity;
  now?: Date;
}

export type CommitWindowsStoreRuntimeSelectionResult =
  | { status: "none" }
  | { status: "committed"; path: string; transactionId: string };

const runtimeSelectionKeys: ReadonlyArray<keyof WindowsStoreRuntimeSelectionRecord> = [
  "schemaVersion",
  "authority",
  "runtimeDisposition",
  "edition",
  "packageFamilyName",
  "aumid",
  "userDataPath",
  "runtimeHomePath",
  "sourceInstallDriveRoot",
  "transactionId",
  "committedAt"
];

/**
 * Selects the Store runtime before MEMMY_HOME is set. An unfinished transition is authoritative;
 * a current NSIS authority can replace an older Store binding; otherwise the committed Store
 * binding survives package upgrades and reinstalls. A null result means a clean Store install.
 */
export const resolveWindowsStoreRuntimeHomeForStartup = (
  options: ResolveWindowsStoreRuntimeHomeForStartupOptions
): string | null => {
  const paths = normalizeSelectionPaths(options);
  const state = readTransitionStateSync(paths.localAppDataPath);
  if (state && state.phase !== "cleaned") {
    if (state.phase === "authority-recorded") {
      throw new Error("Windows Store runtime transition has not been launched by the authoritative NSIS installation");
    }
    assertTransitionIdentity(state, options.identity);
    return validateTransitionRuntimeHome(state, paths);
  }

  const legacyAuthority = readWindowsStoreLegacyInstallAuthoritySync({
    localAppDataPath: paths.localAppDataPath,
    roamingAppDataPath: paths.roamingAppDataPath,
    homeDirectory: paths.homeDirectory,
    storeUserDataPath: paths.storeUserDataPath,
    identity: options.identity
  });
  if (legacyAuthority) {
    assertPlainRuntimeDirectory(legacyAuthority.runtimeHomePath);
    return legacyAuthority.runtimeHomePath;
  }

  const selection = readRuntimeSelectionSync(paths.localAppDataPath, options.identity);
  if (!selection) return null;
  validateRuntimeSelectionRecord(selection, paths, options.identity);
  assertOptionalStorePointer(paths.storeUserDataPath, selection.runtimeHomePath);
  assertPlainRuntimeDirectory(selection.runtimeHomePath);
  return selection.runtimeHomePath;
};

/** Persists a shared runtime choice before legacy cleanup is allowed to proceed. */
export const commitWindowsStoreRuntimeSelectionForVerifiedBoot = async (
  options: CommitWindowsStoreRuntimeSelectionOptions
): Promise<CommitWindowsStoreRuntimeSelectionResult> => {
  const paths = normalizeSelectionPaths(options);
  const statePath = resolveWindowsStoreTransitionStatePath(paths.localAppDataPath);
  const state = await readWindowsStoreTransitionState(statePath);
  if (!state || state.phase === "cleaned") return { status: "none" };
  assertTransitionIdentity(state, options.identity);
  if (![
    "awaiting-app-verification",
    "app-verified",
    "legacy-cleanup-complete",
    "legacy-cleanup-attested",
    "cleanup-eligible"
  ].includes(state.phase)) {
    throw new Error(`Windows Store runtime selection cannot be committed from phase ${state.phase}`);
  }
  const runtimeHomePath = validateTransitionRuntimeHome(state, paths);
  if (!sameWindowsPath(runtimeHomePath, options.runtimeHomePath)) {
    throw new Error("Windows Store runtime selection does not match the active data layout");
  }
  await assertRequiredStorePointer(paths.storeUserDataPath, runtimeHomePath);

  const committedAt = normalizeDate(options.now ?? new Date());
  const record: WindowsStoreRuntimeSelectionRecord = {
    schemaVersion: 1,
    authority: STORE_RUNTIME_SELECTION_AUTHORITY,
    runtimeDisposition: STORE_RUNTIME_SELECTION_DISPOSITION,
    edition: state.edition,
    packageFamilyName: state.packageFamilyName,
    aumid: state.aumid,
    userDataPath: paths.storeUserDataPath,
    runtimeHomePath,
    sourceInstallDriveRoot: canonicalDriveRoot(state.sourceInstallDirectory),
    transactionId: state.transactionId,
    committedAt
  };
  const selectionPath = resolveWindowsStoreRuntimeSelectionPath(
    paths.localAppDataPath,
    state.packageFamilyName
  );
  await writeJsonAtomically(selectionPath, record);
  return { status: "committed", path: selectionPath, transactionId: state.transactionId };
};

export const resolveWindowsStoreRuntimeSelectionPath = (
  localAppDataPath: string,
  packageFamilyName: string
): string => {
  const normalizedLocalAppDataPath = normalizeDirectory(localAppDataPath, "LocalAppData");
  if (!/^[A-Za-z0-9.]+_[A-Za-z0-9]+$/u.test(packageFamilyName)) {
    throw new Error("Windows Store runtime selection package family name is invalid");
  }
  return win32.join(
    normalizedLocalAppDataPath,
    "Memmy",
    "store-runtime",
    packageFamilyName,
    "binding.json"
  );
};

const readTransitionStateSync = (localAppDataPath: string): WindowsStoreTransitionState | null => {
  const statePath = resolveWindowsStoreTransitionStatePath(localAppDataPath);
  try {
    return parseWindowsStoreTransitionState(readFileSync(statePath, "utf8"));
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
};

const readRuntimeSelectionSync = (
  localAppDataPath: string,
  identity: WindowsStoreLegacyTransitionIdentity
): WindowsStoreRuntimeSelectionRecord | null => {
  const selectionPath = resolveWindowsStoreRuntimeSelectionPath(
    localAppDataPath,
    identity.packageFamilyName
  );
  try {
    return parseRuntimeSelectionRecord(readFileSync(selectionPath, "utf8"));
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
};

const parseRuntimeSelectionRecord = (contents: string): WindowsStoreRuntimeSelectionRecord => {
  try {
    const value = JSON.parse(contents) as unknown;
    if (!isRecord(value)
        || !hasExactKeys(value, runtimeSelectionKeys)
        || value.schemaVersion !== 1
        || value.authority !== STORE_RUNTIME_SELECTION_AUTHORITY
        || value.runtimeDisposition !== STORE_RUNTIME_SELECTION_DISPOSITION
        || (value.edition !== "cn" && value.edition !== "intl")
        || typeof value.packageFamilyName !== "string"
        || typeof value.aumid !== "string"
        || typeof value.userDataPath !== "string"
        || typeof value.runtimeHomePath !== "string"
        || typeof value.sourceInstallDriveRoot !== "string"
        || typeof value.transactionId !== "string"
        || typeof value.committedAt !== "string") {
      throw new Error("invalid shape");
    }
    return value as unknown as WindowsStoreRuntimeSelectionRecord;
  } catch (cause) {
    throw new Error("Windows Store runtime selection is invalid", { cause });
  }
};

const validateRuntimeSelectionRecord = (
  record: WindowsStoreRuntimeSelectionRecord,
  paths: NormalizedSelectionPaths,
  identity: WindowsStoreLegacyTransitionIdentity
): void => {
  if (record.edition !== identity.edition
      || record.packageFamilyName !== identity.packageFamilyName
      || record.aumid !== identity.aumid) {
    throw new Error("Windows Store runtime selection does not match the running package identity");
  }
  const userDataPath = normalizeCanonicalDirectory(record.userDataPath, "selection userData");
  const runtimeHomePath = normalizeCanonicalDirectory(record.runtimeHomePath, "selection runtime home");
  if (!sameWindowsPath(userDataPath, paths.storeUserDataPath)) {
    throw new Error("Windows Store runtime selection does not match the package LocalState profile");
  }
  if (!/^[A-Z]:\\$/u.test(record.sourceInstallDriveRoot)) {
    throw new Error("Windows Store runtime selection source drive is invalid");
  }
  const driveRoot = record.sourceInstallDriveRoot;
  const expectedRuntimeHomePath = expectedRuntimeHomeForDrive(driveRoot, paths.homeDirectory);
  if (!sameWindowsPath(runtimeHomePath, expectedRuntimeHomePath)) {
    throw new Error("Windows Store runtime selection does not match its authoritative drive");
  }
  normalizeTransactionId(record.transactionId);
  normalizeTimestamp(record.committedAt);
};

const validateTransitionRuntimeHome = (
  state: WindowsStoreTransitionState,
  paths: NormalizedSelectionPaths
): string => {
  const expectedUserDataPath = win32.join(paths.roamingAppDataPath, "Memmy");
  if (!sameWindowsPath(state.sourceUserDataPath, expectedUserDataPath)
      || !sameWindowsPath(state.sourceExecutablePath, win32.join(state.sourceInstallDirectory, "Memmy.exe"))) {
    throw new Error("Windows Store transition runtime authority does not match the NSIS installation");
  }
  const driveRoot = canonicalDriveRoot(state.sourceInstallDirectory);
  const expectedRuntimeHomePath = expectedRuntimeHomeForDrive(driveRoot, paths.homeDirectory);
  if (!sameWindowsPath(state.sourceRuntimeHomePath, expectedRuntimeHomePath)) {
    throw new Error("Windows Store transition runtime path does not match the NSIS install drive");
  }
  assertPlainRuntimeDirectory(state.sourceRuntimeHomePath);
  return state.sourceRuntimeHomePath;
};

const assertTransitionIdentity = (
  state: WindowsStoreTransitionState,
  identity: WindowsStoreLegacyTransitionIdentity
): void => {
  if (state.edition !== identity.edition
      || state.packageFamilyName !== identity.packageFamilyName
      || state.aumid !== identity.aumid) {
    throw new Error("Windows Store runtime transition does not match the running package identity");
  }
};

const assertOptionalStorePointer = (storeUserDataPath: string, runtimeHomePath: string): void => {
  const pointerPath = win32.join(storeUserDataPath, "data-root.txt");
  let contents: Buffer;
  try {
    contents = readFileSync(pointerPath);
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw new Error("Windows Store runtime pointer is unreadable", { cause: error });
  }
  if (!sameWindowsPath(decodeWindowsPointer(contents).trim(), runtimeHomePath)) {
    throw new Error("Windows Store runtime pointer does not match the committed selection");
  }
};

const assertRequiredStorePointer = async (
  storeUserDataPath: string,
  runtimeHomePath: string
): Promise<void> => {
  let contents: Buffer;
  try {
    contents = await readFile(win32.join(storeUserDataPath, "data-root.txt"));
  } catch (cause) {
    throw new Error("Windows Store runtime pointer is unavailable for selection commit", { cause });
  }
  if (!sameWindowsPath(decodeWindowsPointer(contents).trim(), runtimeHomePath)) {
    throw new Error("Windows Store runtime pointer does not match the active data layout");
  }
};

const assertPlainRuntimeDirectory = (runtimeHomePath: string): void => {
  const normalizedRuntimeHomePath = normalizeDirectory(runtimeHomePath, "runtime home");
  if (containsWindowsAppsSegment(normalizedRuntimeHomePath)) {
    throw new Error("Windows Store runtime home must not be inside WindowsApps");
  }
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(normalizedRuntimeHomePath);
  } catch (cause) {
    throw new Error(`Windows Store runtime home is unavailable: ${normalizedRuntimeHomePath}`, { cause });
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Windows Store runtime home is not a plain directory: ${normalizedRuntimeHomePath}`);
  }
};

interface NormalizedSelectionPaths {
  localAppDataPath: string;
  roamingAppDataPath: string;
  homeDirectory: string;
  storeUserDataPath: string;
}

const normalizeSelectionPaths = (
  options: Pick<
    ResolveWindowsStoreRuntimeHomeForStartupOptions,
    "localAppDataPath" | "roamingAppDataPath" | "homeDirectory" | "storeUserDataPath"
  >
): NormalizedSelectionPaths => ({
  localAppDataPath: normalizeDirectory(options.localAppDataPath, "LocalAppData"),
  roamingAppDataPath: normalizeDirectory(options.roamingAppDataPath, "RoamingAppData"),
  homeDirectory: normalizeDirectory(options.homeDirectory, "home"),
  storeUserDataPath: normalizeDirectory(options.storeUserDataPath, "Store userData")
});

const expectedRuntimeHomeForDrive = (driveRoot: string, homeDirectory: string): string =>
  sameWindowsPath(driveRoot, "C:\\")
    ? win32.join(homeDirectory, ".memmy")
    : win32.join(driveRoot, "MemmyData", ".memmy");

const canonicalDriveRoot = (value: string): string => {
  const normalized = win32.normalize(value);
  const root = win32.parse(normalized).root;
  if (!/^[A-Za-z]:\\$/u.test(root)) {
    throw new Error("Windows Store runtime authority must use a local drive");
  }
  return root.toUpperCase();
};

const normalizeDirectory = (value: string, label: string): string => {
  if (!value || value !== value.trim() || !win32.isAbsolute(value)) {
    throw new Error(`Windows Store ${label} path is invalid`);
  }
  const normalized = win32.normalize(value);
  if (normalized === win32.parse(normalized).root) {
    throw new Error(`Windows Store ${label} path must not be a drive root`);
  }
  return normalized;
};

const normalizeCanonicalDirectory = (value: string, label: string): string => {
  const normalized = normalizeDirectory(value, label);
  if (normalized !== value) {
    throw new Error(`Windows Store ${label} path must be canonical`);
  }
  return normalized;
};

const writeJsonAtomically = async (path: string, value: unknown): Promise<void> => {
  await mkdir(win32.dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx"
    });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
};

const normalizeTransactionId = (value: string): string => {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error("Windows Store runtime selection transaction ID is invalid");
  }
  return value.toLowerCase();
};

const normalizeTimestamp = (value: string): string => {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new Error("Windows Store runtime selection timestamp is invalid");
  }
  return value;
};

const normalizeDate = (value: Date): string => {
  if (!Number.isFinite(value.getTime())) {
    throw new Error("Windows Store runtime selection timestamp is invalid");
  }
  return value.toISOString();
};

const decodeWindowsPointer = (contents: Buffer): string =>
  contents.length >= 2 && contents[0] === 0xff && contents[1] === 0xfe
    ? contents.subarray(2).toString("utf16le")
    : contents.toString("utf8").replace(/^\uFEFF/u, "");

const containsWindowsAppsSegment = (value: string): boolean =>
  win32.normalize(value).split(win32.sep).some((segment) => segment.toLowerCase() === "windowsapps");

const sameWindowsPath = (left: string, right: string): boolean =>
  win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isMissingFileError = (error: unknown): boolean =>
  isRecord(error) && "code" in error && error.code === "ENOENT";
