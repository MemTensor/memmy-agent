import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { win32 } from "node:path";
import { promisify } from "node:util";
import { resolveExpectedWindowsStoreMigrationIdentity } from "./windows-store-migration-config.js";
import {
  advanceWindowsStoreTransitionState,
  createWindowsStoreTransitionState,
  readWindowsStoreTransitionState,
  resolveWindowsStoreTransitionStatePath,
  writeWindowsStoreTransitionState,
  type WindowsStoreTransitionState
} from "./windows-store-transition-state.js";

const execFileAsync = promisify(execFile);
const EXTERNAL_HELPER_FILE = "MemmyStoreUpdate.exe";

export interface WindowsStoreLegacyInstallAuthority {
  installDirectory: string;
  executablePath: string;
  userDataPath: string;
  runtimeHomePath: string;
  appVersion: string;
  recordedAt: string;
}

export interface WindowsStoreLegacyTransitionIdentity {
  edition: "cn" | "intl";
  packageFamilyName: string;
  aumid: string;
}

export interface WindowsStoreLegacyTransitionOptions {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  isWindowsStore: boolean;
  resourcesPath: string;
  localAppDataPath: string;
  roamingAppDataPath: string;
  homeDirectory: string;
  storeUserDataPath: string;
  desktopPath: string;
  identity: WindowsStoreLegacyTransitionIdentity;
}

export interface ReadWindowsStoreLegacyInstallAuthorityOptions {
  localAppDataPath: string;
  roamingAppDataPath: string;
  homeDirectory: string;
  storeUserDataPath?: string;
  identity?: WindowsStoreLegacyTransitionIdentity;
}

export interface RetireWindowsStoreLegacyInstallAuthorityOptions {
  localAppDataPath: string;
  state: WindowsStoreTransitionState;
}

interface RunLegacyTakeoverOptions {
  helperPath: string;
  legacyInstallDirectory: string;
  legacyExecutablePath: string;
}

export interface RunLegacyCleanupOptions extends RunLegacyTakeoverOptions {
  shortcutPath?: string;
  aumid: string;
  packageFamilyName: string;
  transitionId: string;
  attemptId: string;
}

interface PrepareWindowsStoreLegacyTransitionDependencies {
  readState?: typeof readWindowsStoreTransitionState;
  readLegacyAuthority?: (
    options: ReadWindowsStoreLegacyInstallAuthorityOptions
  ) => Promise<WindowsStoreLegacyInstallAuthority | null>;
  runTakeover?: (options: RunLegacyTakeoverOptions) => Promise<void>;
  writeState?: typeof writeWindowsStoreTransitionState;
}

interface FinalizeWindowsStoreLegacyInstallationOptions {
  resourcesPath: string;
  localAppDataPath: string;
  desktopPath: string;
  state: WindowsStoreTransitionState;
}

export type AcknowledgeWindowsStoreLegacyCleanupOptions =
  FinalizeWindowsStoreLegacyInstallationOptions;

interface FinalizeWindowsStoreLegacyInstallationDependencies {
  runCleanup?: (options: RunLegacyCleanupOptions) => Promise<void>;
  createAttemptId?: () => string;
}

interface AcknowledgeWindowsStoreLegacyCleanupDependencies {
  runAcknowledgement?: (options: RunLegacyCleanupOptions) => Promise<void>;
  createAttemptId?: () => string;
}

export type WindowsStoreLegacyTransitionPrepareResult =
  | { status: "none" }
  | { status: "prepared"; source: "journal" | "manual-install"; state: WindowsStoreTransitionState };

export const readWindowsStoreLegacyInstallAuthority = async (
  options: ReadWindowsStoreLegacyInstallAuthorityOptions
): Promise<WindowsStoreLegacyInstallAuthority | null> => {
  const recordPath = resolveLegacyInstallAuthorityRecordPath(options.localAppDataPath);
  let record: unknown;
  try {
    record = JSON.parse(await readFile(recordPath, "utf8")) as unknown;
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw new Error("Windows legacy installation authority record is unreadable", { cause: error });
  }
  const parsed = parseWindowsStoreLegacyInstallAuthorityRecord(record, options);
  if (parsed.kind === "windows-store") {
    await assertOptionalWindowsStoreAuthorityPointer(parsed.userDataPath, parsed.runtimeHomePath);
    return null;
  }
  const authority = parsed.authority;
  let pointerValue: string;
  try {
    pointerValue = decodeWindowsPointer(
      await readFile(win32.join(authority.userDataPath, "data-root.txt"))
    ).trim();
  } catch (error) {
    throw new Error("Windows legacy installation runtime pointer is unreadable", { cause: error });
  }
  if (!pointerValue || !sameWindowsPath(pointerValue, authority.runtimeHomePath)) {
    throw new Error("Windows legacy installation runtime path does not match its pointer");
  }
  return authority;
};

export const readWindowsStoreLegacyInstallAuthoritySync = (
  options: ReadWindowsStoreLegacyInstallAuthorityOptions
): WindowsStoreLegacyInstallAuthority | null => {
  const recordPath = resolveLegacyInstallAuthorityRecordPath(options.localAppDataPath);
  let record: unknown;
  try {
    record = JSON.parse(readFileSync(recordPath, "utf8")) as unknown;
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw new Error("Windows legacy installation authority record is unreadable", { cause: error });
  }
  const parsed = parseWindowsStoreLegacyInstallAuthorityRecord(record, options);
  if (parsed.kind === "windows-store") {
    assertOptionalWindowsStoreAuthorityPointerSync(parsed.userDataPath, parsed.runtimeHomePath);
    return null;
  }
  const authority = parsed.authority;
  let pointerValue: string;
  try {
    pointerValue = decodeWindowsPointer(
      readFileSync(win32.join(authority.userDataPath, "data-root.txt"))
    ).trim();
  } catch (error) {
    throw new Error("Windows legacy installation runtime pointer is unreadable", { cause: error });
  }
  if (!pointerValue || !sameWindowsPath(pointerValue, authority.runtimeHomePath)) {
    throw new Error("Windows legacy installation runtime path does not match its pointer");
  }
  return authority;
};

export const prepareWindowsStoreLegacyTransitionBeforeLock = async (
  options: WindowsStoreLegacyTransitionOptions,
  dependencies: PrepareWindowsStoreLegacyTransitionDependencies = {}
): Promise<WindowsStoreLegacyTransitionPrepareResult> => {
  if (options.platform !== "win32" || !options.isPackaged || !options.isWindowsStore) {
    return { status: "none" };
  }
  const statePath = resolveWindowsStoreTransitionStatePath(options.localAppDataPath);
  const readState = dependencies.readState ?? readWindowsStoreTransitionState;
  const writeState = dependencies.writeState ?? writeWindowsStoreTransitionState;
  let state = await readState(statePath);
  let source: "journal" | "manual-install" = "journal";

  if (state) {
    assertCurrentIdentity(options.identity, state);
  }
  if (!state || state.phase === "cleaned") {
    const authority = await (
      dependencies.readLegacyAuthority ?? readWindowsStoreLegacyInstallAuthority
    )({
      localAppDataPath: options.localAppDataPath,
      roamingAppDataPath: options.roamingAppDataPath,
      homeDirectory: options.homeDirectory,
      storeUserDataPath: options.storeUserDataPath,
      identity: options.identity
    });
    if (!authority) return { status: "none" };
    const expectedIdentity = resolveExpectedWindowsStoreMigrationIdentity(options.identity.edition);
    assertCurrentIdentity(options.identity, expectedIdentity);
    state = createWindowsStoreTransitionState({
      transactionId: randomUUID(),
      ...expectedIdentity,
      sourceExecutablePath: authority.executablePath,
      sourceInstallDirectory: authority.installDirectory,
      sourceVersion: authority.appVersion,
      sourceUserDataPath: authority.userDataPath,
      sourceRuntimeHomePath: authority.runtimeHomePath,
      authority: "current-install-authority"
    });
    source = "manual-install";
  }

  const helperPath = win32.join(options.resourcesPath, "native", EXTERNAL_HELPER_FILE);
  await (dependencies.runTakeover ?? runLegacyTakeover)({
    helperPath,
    legacyInstallDirectory: state.sourceInstallDirectory,
    legacyExecutablePath: state.sourceExecutablePath
  });

  if (state.phase === "authority-recorded") {
    state = advanceWindowsStoreTransitionState(state, "store-install-launched");
    await writeState(statePath, state);
  }
  return { status: "prepared", source, state };
};

/** Removes the consumed NSIS-only authority after the Store binding is durable. */
export const retireWindowsStoreLegacyInstallAuthority = async (
  options: RetireWindowsStoreLegacyInstallAuthorityOptions
): Promise<void> => {
  if (options.state.phase !== "cleanup-eligible") {
    throw new Error("Windows legacy installation authority can only be retired after legacy cleanup");
  }
  const recordPath = resolveLegacyInstallAuthorityRecordPath(options.localAppDataPath);
  let record: unknown;
  try {
    record = JSON.parse(await readFile(recordPath, "utf8")) as unknown;
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw new Error("Windows legacy installation authority record cannot be retired", { cause: error });
  }
  const authorityRecordedAt = isRecord(record) && typeof record.recordedAt === "string"
    ? new Date(record.recordedAt)
    : null;
  if (!isRecord(record)
      || record.schemaVersion !== 1
      || record.dataLayoutGeneration !== "external-v1"
      || (record.installationOwner !== undefined && record.installationOwner !== "nsis")
      || typeof record.installDir !== "string"
      || typeof record.userDataPath !== "string"
      || typeof record.runtimeHomePath !== "string"
      || typeof record.appVersion !== "string"
      || !authorityRecordedAt
      || !Number.isFinite(authorityRecordedAt.getTime())
      || authorityRecordedAt.toISOString() !== record.recordedAt
      || !sameWindowsPath(record.installDir, options.state.sourceInstallDirectory)
      || !sameWindowsPath(record.userDataPath, options.state.sourceUserDataPath)
      || !sameWindowsPath(record.runtimeHomePath, options.state.sourceRuntimeHomePath)
      || record.appVersion !== options.state.sourceVersion) {
    throw new Error("Windows legacy installation authority changed before retirement");
  }
  await rm(recordPath, { force: true });
};

export const finalizeWindowsStoreLegacyInstallation = async (
  options: FinalizeWindowsStoreLegacyInstallationOptions,
  dependencies: FinalizeWindowsStoreLegacyInstallationDependencies = {}
): Promise<void> => {
  const helperPath = win32.join(options.resourcesPath, "native", EXTERNAL_HELPER_FILE);
  normalizeDirectory(options.localAppDataPath, "LocalAppData");
  const desktopShortcutPath = win32.join(
    normalizeDirectory(options.desktopPath, "desktop"),
    "Memmy.lnk"
  );
  await (dependencies.runCleanup ?? runLegacyCleanup)({
    helperPath,
    legacyInstallDirectory: options.state.sourceInstallDirectory,
    legacyExecutablePath: options.state.sourceExecutablePath,
    // Always bind cleanup and crash recovery to the same fixed Desktop target.
    // Deriving this field from whether the old link currently exists makes a
    // retry diverge after a failure between link removal and recreation.
    shortcutPath: desktopShortcutPath,
    aumid: options.state.aumid,
    packageFamilyName: options.state.packageFamilyName,
    transitionId: options.state.transactionId,
    attemptId: (dependencies.createAttemptId ?? randomUUID)()
  });
};

/**
 * Confirms that the Store journal durably records the broker-attested cleanup.
 * The unpackaged broker retains its recovery entry until this acknowledgement
 * succeeds, so a crash between cleanup and state persistence remains retryable.
 */
export const acknowledgeWindowsStoreLegacyCleanup = async (
  options: AcknowledgeWindowsStoreLegacyCleanupOptions,
  dependencies: AcknowledgeWindowsStoreLegacyCleanupDependencies = {}
): Promise<void> => {
  if (options.state.phase !== "legacy-cleanup-attested") {
    throw new Error("Windows legacy cleanup can only be acknowledged after attestation is durable");
  }
  const helperPath = win32.join(options.resourcesPath, "native", EXTERNAL_HELPER_FILE);
  normalizeDirectory(options.localAppDataPath, "LocalAppData");
  const desktopShortcutPath = win32.join(
    normalizeDirectory(options.desktopPath, "desktop"),
    "Memmy.lnk"
  );
  await (dependencies.runAcknowledgement ?? runLegacyCleanupAcknowledgement)({
    helperPath,
    legacyInstallDirectory: options.state.sourceInstallDirectory,
    legacyExecutablePath: options.state.sourceExecutablePath,
    shortcutPath: desktopShortcutPath,
    aumid: options.state.aumid,
    packageFamilyName: options.state.packageFamilyName,
    transitionId: options.state.transactionId,
    attemptId: (dependencies.createAttemptId ?? randomUUID)()
  });
};

const runLegacyTakeover = async (options: RunLegacyTakeoverOptions): Promise<void> => {
  await execFileAsync(options.helperPath, [
    "prepare-legacy-takeover",
    "--legacy-install-directory",
    options.legacyInstallDirectory,
    "--legacy-executable-path",
    options.legacyExecutablePath
  ], {
    timeout: 30_000,
    windowsHide: true
  });
};

export const buildLegacyCleanupArguments = (
  options: RunLegacyCleanupOptions
): string[] => {
  const args = [
    "finalize-legacy-cleanup",
    "--legacy-install-directory",
    options.legacyInstallDirectory,
    "--legacy-executable-path",
    options.legacyExecutablePath,
    "--aumid",
    options.aumid,
    "--package-family-name",
    options.packageFamilyName,
    "--transition-id",
    options.transitionId,
    "--attempt-id",
    options.attemptId
  ];
  if (options.shortcutPath) args.push("--shortcut", options.shortcutPath);
  return args;
};

export const buildLegacyCleanupAcknowledgementArguments = (
  options: RunLegacyCleanupOptions
): string[] => [
  "ack-legacy-cleanup",
  ...buildLegacyCleanupArguments(options).slice(1)
];

const runLegacyCleanup = async (options: RunLegacyCleanupOptions): Promise<void> => {
  const args = buildLegacyCleanupArguments(options);
  await execFileAsync(options.helperPath, args, {
    timeout: 180_000,
    windowsHide: true
  });
};

const runLegacyCleanupAcknowledgement = async (
  options: RunLegacyCleanupOptions
): Promise<void> => {
  await execFileAsync(options.helperPath, buildLegacyCleanupAcknowledgementArguments(options), {
    timeout: 30_000,
    windowsHide: true
  });
};

const assertCurrentIdentity = (
  actual: WindowsStoreLegacyTransitionIdentity,
  expected: WindowsStoreLegacyTransitionIdentity
): void => {
  if (actual.edition !== expected.edition
      || actual.packageFamilyName !== expected.packageFamilyName
      || actual.aumid !== expected.aumid) {
    throw new Error("Windows legacy transition does not match the running Store package identity");
  }
};

const resolveLegacyInstallAuthorityRecordPath = (localAppDataPath: string): string =>
  win32.join(
    normalizeDirectory(localAppDataPath, "LocalAppData"),
    "Memmy",
    "data-layout",
    "last-install.json"
  );

type ParsedWindowsStoreInstallAuthority =
  | { kind: "legacy"; authority: WindowsStoreLegacyInstallAuthority }
  | { kind: "windows-store"; userDataPath: string; runtimeHomePath: string };

const parseWindowsStoreLegacyInstallAuthorityRecord = (
  record: unknown,
  options: ReadWindowsStoreLegacyInstallAuthorityOptions
): ParsedWindowsStoreInstallAuthority => {
  if (!isRecord(record)
      || record.schemaVersion !== 1
      || record.dataLayoutGeneration !== "external-v1"
      || typeof record.installDir !== "string"
      || typeof record.userDataPath !== "string"
      || typeof record.runtimeHomePath !== "string"
      || typeof record.appVersion !== "string"
      || typeof record.recordedAt !== "string") {
    throw new Error("Windows legacy installation authority record is invalid");
  }

  const roamingAppDataPath = normalizeDirectory(options.roamingAppDataPath, "RoamingAppData");
  const homeDirectory = normalizeDirectory(options.homeDirectory, "home");
  const installDirectory = normalizeDirectory(record.installDir, "installation authority");
  const userDataPath = normalizeDirectory(record.userDataPath, "installation userData");
  const runtimeHomePath = normalizeDirectory(record.runtimeHomePath, "installation runtime");
  const recordedAt = new Date(record.recordedAt);
  if (!/^\d+(?:\.\d+){2,3}$/u.test(record.appVersion)
      || !Number.isFinite(recordedAt.getTime())
      || recordedAt.toISOString() !== record.recordedAt) {
    throw new Error("Windows legacy installation authority paths or version are invalid");
  }

  if (containsWindowsAppsSegment(installDirectory) || record.installationOwner === "windows-store") {
    validateWindowsStoreOwnedInstallAuthorityRecord({
      record,
      installDirectory,
      userDataPath,
      runtimeHomePath,
      homeDirectory,
      options
    });
    return { kind: "windows-store", userDataPath, runtimeHomePath };
  }
  if (record.installationOwner !== undefined && record.installationOwner !== "nsis") {
    throw new Error("Windows legacy installation authority owner is invalid");
  }

  const executablePath = win32.join(installDirectory, "Memmy.exe");
  const expectedUserDataPath = win32.join(roamingAppDataPath, "Memmy");
  const installRoot = win32.parse(installDirectory).root;
  const expectedRuntimeHomePath = sameWindowsRoot(installRoot, "C:\\")
    ? win32.join(homeDirectory, ".memmy")
    : win32.join(installRoot, "MemmyData", ".memmy");
  if (!sameWindowsPath(userDataPath, expectedUserDataPath)
      || containsWindowsAppsSegment(userDataPath)
      || containsWindowsAppsSegment(runtimeHomePath)) {
    throw new Error("Windows legacy installation authority paths or version are invalid");
  }
  if (!sameWindowsPath(runtimeHomePath, expectedRuntimeHomePath)) {
    throw new Error("Windows legacy installation runtime path does not match the recorded install drive");
  }

  return {
    kind: "legacy",
    authority: {
      installDirectory,
      executablePath,
      userDataPath,
      runtimeHomePath,
      appVersion: record.appVersion,
      recordedAt: record.recordedAt
    }
  };
};

interface ValidateWindowsStoreOwnedInstallAuthorityRecordOptions {
  record: Record<string, unknown>;
  installDirectory: string;
  userDataPath: string;
  runtimeHomePath: string;
  homeDirectory: string;
  options: ReadWindowsStoreLegacyInstallAuthorityOptions;
}

const validateWindowsStoreOwnedInstallAuthorityRecord = (
  input: ValidateWindowsStoreOwnedInstallAuthorityRecordOptions
): void => {
  const identity = input.options.identity;
  const storeUserDataPath = input.options.storeUserDataPath;
  if (!identity || !storeUserDataPath) {
    throw new Error("Windows Store installation authority cannot be classified without package identity");
  }
  const normalizedStoreUserDataPath = normalizeDirectory(storeUserDataPath, "Store userData");
  if (!sameWindowsPath(input.userDataPath, normalizedStoreUserDataPath)
      || !isCurrentWindowsStoreUserDataPath(normalizedStoreUserDataPath, identity.packageFamilyName)
      || !isCurrentWindowsStoreInstallDirectory(input.installDirectory, identity.packageFamilyName)
      || containsWindowsAppsSegment(input.runtimeHomePath)
      || !isAllowedWindowsStoreRuntimeHome(input.runtimeHomePath, input.homeDirectory)) {
    throw new Error("Windows Store installation authority does not match the running package");
  }
  if (input.record.installationOwner === "windows-store") {
    if (input.record.packageFamilyName !== identity.packageFamilyName
        || input.record.aumid !== identity.aumid) {
      throw new Error("Windows Store installation authority identity is invalid");
    }
  } else if (input.record.installationOwner !== undefined
      || input.record.packageFamilyName !== undefined
      || input.record.aumid !== undefined) {
    throw new Error("Windows Store installation authority owner is invalid");
  }
};

const isCurrentWindowsStoreUserDataPath = (
  userDataPath: string,
  packageFamilyName: string
): boolean => {
  const segments = win32.normalize(userDataPath).split(win32.sep);
  if (segments.length < 5) return false;
  const suffix = segments.slice(-4);
  return suffix[0]?.toLowerCase() === "packages"
    && suffix[1]?.toLowerCase() === packageFamilyName.toLowerCase()
    && suffix[2]?.toLowerCase() === "localstate"
    && suffix[3]?.toLowerCase() === "memmy";
};

const isCurrentWindowsStoreInstallDirectory = (
  installDirectory: string,
  packageFamilyName: string
): boolean => {
  const separatorIndex = packageFamilyName.lastIndexOf("_");
  if (separatorIndex <= 0 || separatorIndex === packageFamilyName.length - 1) return false;
  const packageName = packageFamilyName.slice(0, separatorIndex);
  const publisherId = packageFamilyName.slice(separatorIndex + 1);
  const segments = win32.normalize(installDirectory).split(win32.sep);
  const windowsAppsIndex = segments.findIndex((segment) => segment.toLowerCase() === "windowsapps");
  if (windowsAppsIndex < 1 || segments.length !== windowsAppsIndex + 3) return false;
  const hasTrustedWindowsAppsParent = windowsAppsIndex === 1
    || (windowsAppsIndex === 2 && segments[1]?.toLowerCase() === "program files");
  if (!hasTrustedWindowsAppsParent) return false;
  if (segments[windowsAppsIndex + 2]?.toLowerCase() !== "app") return false;
  const packageDirectoryPattern = new RegExp(
    `^${escapeRegExp(packageName)}_\\d+(?:\\.\\d+){3}_(?:x64|x86|arm64|neutral)_[A-Za-z0-9.-]*_${escapeRegExp(publisherId)}$`,
    "iu"
  );
  return packageDirectoryPattern.test(segments[windowsAppsIndex + 1] ?? "");
};

const isAllowedWindowsStoreRuntimeHome = (runtimeHomePath: string, homeDirectory: string): boolean => {
  if (sameWindowsPath(runtimeHomePath, win32.join(homeDirectory, ".memmy"))) return true;
  const runtimeRoot = win32.parse(runtimeHomePath).root;
  return !sameWindowsRoot(runtimeRoot, "C:\\")
    && sameWindowsPath(runtimeHomePath, win32.join(runtimeRoot, "MemmyData", ".memmy"));
};

const assertOptionalWindowsStoreAuthorityPointer = async (
  userDataPath: string,
  runtimeHomePath: string
): Promise<void> => {
  let pointer: Buffer;
  try {
    pointer = await readFile(win32.join(userDataPath, "data-root.txt"));
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw new Error("Windows Store installation authority pointer is unreadable", { cause: error });
  }
  if (!sameWindowsPath(decodeWindowsPointer(pointer).trim(), runtimeHomePath)) {
    throw new Error("Windows Store installation authority runtime path does not match its pointer");
  }
};

const assertOptionalWindowsStoreAuthorityPointerSync = (
  userDataPath: string,
  runtimeHomePath: string
): void => {
  let pointer: Buffer;
  try {
    pointer = readFileSync(win32.join(userDataPath, "data-root.txt"));
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw new Error("Windows Store installation authority pointer is unreadable", { cause: error });
  }
  if (!sameWindowsPath(decodeWindowsPointer(pointer).trim(), runtimeHomePath)) {
    throw new Error("Windows Store installation authority runtime path does not match its pointer");
  }
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const normalizeDirectory = (value: string, label: string): string => {
  if (!value || value !== value.trim() || !win32.isAbsolute(value)) {
    throw new Error(`Windows ${label} path must be absolute`);
  }
  const normalized = win32.normalize(value);
  if (normalized === win32.parse(normalized).root) {
    throw new Error(`Windows ${label} path is unsafe`);
  }
  return normalized;
};

const decodeWindowsPointer = (contents: Buffer): string =>
  contents.length >= 2 && contents[0] === 0xff && contents[1] === 0xfe
    ? contents.subarray(2).toString("utf16le")
    : contents.toString("utf8").replace(/^\uFEFF/u, "");

const containsWindowsAppsSegment = (value: string): boolean =>
  win32.normalize(value).toLowerCase().split(win32.sep).includes("windowsapps");

const sameWindowsPath = (left: string, right: string): boolean =>
  win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();

const sameWindowsRoot = (left: string, right: string): boolean =>
  win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isMissingFileError = (error: unknown): boolean =>
  isRecord(error) && "code" in error && error.code === "ENOENT";
