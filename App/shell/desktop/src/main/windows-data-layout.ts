import { mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { win32 } from "node:path";

export interface WindowsDataLayout {
  userDataPath: string;
  runtimeHomePath: string;
  updatesPath: string;
  pointerPath: string;
  migrationStatePath: string;
  installationRecordPath: string;
  legacyInstallDataPath: string;
}

export interface WindowsDataMigrationConsistency {
  accountSourceIsAuthoritative: boolean;
  runtimeSourceWasMigrated: boolean;
  categorySourcesShareGeneration: boolean;
}

export interface ResolveWindowsDataLayoutOptions {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  isWindowsStore: boolean;
  executablePath: string;
  appDataPath: string;
  localAppDataPath: string;
  homeDirectory: string;
}

export const resolveWindowsDataLayout = (
  options: ResolveWindowsDataLayoutOptions
): WindowsDataLayout | null => {
  if (options.platform !== "win32" || !options.isPackaged) {
    return null;
  }

  const userDataPath = win32.join(options.appDataPath, "Memmy");
  const legacyRuntimeHomePath = win32.join(options.homeDirectory, ".memmy");
  const installationRoot = win32.parse(options.executablePath).root;
  const useLegacyRuntimeHome = options.isWindowsStore
    || !installationRoot
    || sameWindowsRoot(installationRoot, "C:\\");
  const dataContainerPath = useLegacyRuntimeHome
    ? legacyRuntimeHomePath
    : win32.join(installationRoot, "MemmyData");
  const runtimeHomePath = useLegacyRuntimeHome
    ? legacyRuntimeHomePath
    : win32.join(dataContainerPath, ".memmy");
  const localAppDataPath = options.localAppDataPath
    || win32.join(options.homeDirectory, "AppData", "Local");

  return {
    userDataPath,
    runtimeHomePath,
    updatesPath: win32.join(dataContainerPath, "updates"),
    pointerPath: win32.join(userDataPath, "data-root.txt"),
    migrationStatePath: win32.join(localAppDataPath, "Memmy", "data-migration", "state.json"),
    installationRecordPath: win32.join(localAppDataPath, "Memmy", "data-layout", "last-install.json"),
    legacyInstallDataPath: win32.join(win32.dirname(options.executablePath), "data")
  };
};

interface WindowsDataMigrationState {
  owner?: unknown;
  phase?: unknown;
  sourceDataPath?: unknown;
  sourceAuthority?: unknown;
  sourceInstallDir?: unknown;
  targetUserDataPath?: unknown;
  targetRuntimeHomePath?: unknown;
  backupPaths?: unknown;
  runtimeSourcePath?: unknown;
  runtimeSourcePaths?: unknown;
  accountSourceAuthority?: unknown;
  runtimeSourceAuthority?: unknown;
  categorySourcesShareGeneration?: unknown;
  preparedCopies?: unknown;
  previousPointerExisted?: unknown;
  previousPointerBytesBase64?: unknown;
  deferredCleanupStates?: unknown;
}

const trustedInstallAuthorities = new Set([
  "current-install-authority",
  "selected-install-authority",
  "relay-backup-authority",
  "persisted-install-authority"
]);

export const readWindowsDataMigrationConsistency = async (
  layout: WindowsDataLayout
): Promise<WindowsDataMigrationConsistency | undefined> => {
  let state: WindowsDataMigrationState;
  try {
    state = JSON.parse(await readFile(layout.migrationStatePath, "utf8")) as WindowsDataMigrationState;
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
  validateMigrationTargets(state, layout);
  const phase = String(state.phase);
  if (phase === "prepared" || phase === "recovery-required") {
    throw new Error(`Windows data migration requires startup rollback in phase ${phase}`);
  }
  if (!["prepared-for-retry", "awaiting-app-verification", "app-verified"].includes(phase)) {
    return undefined;
  }
  const accountSourceIsAuthoritative = typeof state.accountSourceAuthority === "string"
    && trustedInstallAuthorities.has(state.accountSourceAuthority);
  const runtimeSourceWasMigrated = typeof state.runtimeSourceAuthority === "string"
    && state.runtimeSourceAuthority !== "target-existing";
  if (!accountSourceIsAuthoritative && !runtimeSourceWasMigrated) return undefined;
  return {
    accountSourceIsAuthoritative,
    runtimeSourceWasMigrated,
    categorySourcesShareGeneration: state.categorySourcesShareGeneration === true
  };
};

export interface WindowsDataMigrationStartupRecoveryResult {
  status: "none" | "rolled-back" | "quarantined";
  reason?: string;
  quarantinePath?: string;
}

/**
 * Fails open when a migrated account/runtime pair cannot safely start. Valid prepared
 * copies are rolled back idempotently; malformed or unsafe state is quarantined without
 * deleting any data or rollback directory.
 */
export const recoverWindowsDataMigrationForStartup = async (
  layout: WindowsDataLayout,
  reason: string
): Promise<WindowsDataMigrationStartupRecoveryResult> => {
  let state: WindowsDataMigrationState;
  try {
    state = JSON.parse(await readFile(layout.migrationStatePath, "utf8")) as WindowsDataMigrationState;
  } catch (error) {
    if (isMissingFileError(error)) return { status: "none" };
    const quarantinePath = await quarantineMigrationState(layout.migrationStatePath);
    return { status: "quarantined", reason: `${reason}: ${String(error)}`, ...(quarantinePath ? { quarantinePath } : {}) };
  }

  try {
    validateMigrationTargets(state, layout);
    const copies = validatePreparedCopiesForRollback(state.preparedCopies, layout).reverse();
    for (const copy of copies) {
      if (copy.stagingPath) {
        await rm(copy.stagingPath, { recursive: true, force: true });
      }
      if (copy.backupPath) {
        try {
          await rename(copy.backupPath, copy.destinationPath);
        } catch (error) {
          if (!isMissingFileError(error)) {
            await rm(copy.destinationPath, { recursive: true, force: true });
            await rename(copy.backupPath, copy.destinationPath);
          }
        }
      } else {
        await rm(copy.destinationPath, { recursive: true, force: true });
      }
    }

    if (state.previousPointerExisted === true) {
      if (typeof state.previousPointerBytesBase64 !== "string") {
        throw new Error("Previous Windows data-root pointer contents are unavailable");
      }
      await mkdir(win32.dirname(layout.pointerPath), { recursive: true });
      const temporaryPointerPath = `${layout.pointerPath}.rollback-${randomUUID()}`;
      await writeFile(temporaryPointerPath, Buffer.from(state.previousPointerBytesBase64, "base64"), { flag: "wx" });
      await rename(temporaryPointerPath, layout.pointerPath);
    } else {
      await rm(layout.pointerPath, { force: true });
    }
    await rm(layout.migrationStatePath, { force: true });
    return { status: "rolled-back", reason };
  } catch (error) {
    const quarantinePath = await quarantineMigrationState(layout.migrationStatePath);
    return { status: "quarantined", reason: `${reason}: ${String(error)}`, ...(quarantinePath ? { quarantinePath } : {}) };
  }
};

export const recordWindowsDataLayoutAfterBoot = async (
  layout: WindowsDataLayout,
  appVersion: string
): Promise<void> => {
  await writeJsonAtomically(layout.installationRecordPath, {
    schemaVersion: 1,
    dataLayoutGeneration: "external-v1",
    installDir: win32.dirname(layout.legacyInstallDataPath),
    userDataPath: layout.userDataPath,
    runtimeHomePath: layout.runtimeHomePath,
    appVersion,
    recordedAt: new Date().toISOString()
  });
};

/**
 * Advances installer-owned migration cleanup only after the new runtime has completed a boot.
 * The first successful boot records verification. A later successful boot removes validated
 * rollback copies, so a just-installed app always has one full-boot rollback window.
 */
export const advanceWindowsDataMigrationAfterBoot = async (
  layout: WindowsDataLayout,
  trustedLegacyRuntimeHomePaths: string[] = []
): Promise<"none" | "verified" | "cleaned"> => {
  let state: WindowsDataMigrationState;
  try {
    state = JSON.parse(await readFile(layout.migrationStatePath, "utf8")) as WindowsDataMigrationState;
  } catch (error) {
    if (isMissingFileError(error)) return "none";
    throw error;
  }

  validateMigrationTargets(state, layout);

  if (
    state.phase === "awaiting-app-verification"
    || state.phase === "prepared-for-retry"
  ) {
    await writeMigrationStateAtomically(layout.migrationStatePath, {
      ...state,
      phase: "app-verified",
      appVerifiedAt: new Date().toISOString()
    });
    return "verified";
  }

  if (state.phase !== "app-verified") return "none";

  const cleanupStates = [
    ...(Array.isArray(state.deferredCleanupStates)
      ? state.deferredCleanupStates.filter((value): value is WindowsDataMigrationState => Boolean(value && typeof value === "object"))
      : []),
    state
  ];
  for (const cleanupState of cleanupStates) {
    const cleanupLayout = resolveValidatedCleanupLayout(cleanupState, layout, trustedLegacyRuntimeHomePaths);
    if (!cleanupLayout) continue;
    const backupPaths = Array.isArray(cleanupState.backupPaths)
      ? cleanupState.backupPaths.filter((value): value is string => typeof value === "string")
      : [];
    for (const backupPath of backupPaths) {
      if (isValidatedTargetBackup(backupPath, cleanupLayout)) {
        await rm(backupPath, { recursive: true, force: true });
      }
    }

    for (const sourcePath of resolveValidatedRuntimeSourcesForCleanup(
      cleanupState,
      cleanupLayout,
      trustedLegacyRuntimeHomePaths
    )) {
      await rm(sourcePath, { recursive: true, force: true });
    }

    await cleanupValidatedInstallSources(cleanupState, cleanupLayout);

    if (typeof cleanupState.sourceDataPath === "string") {
      const relayBackupRoot = resolveValidatedRelayBackupRoot(cleanupState, cleanupLayout);
      if (relayBackupRoot) {
        await rm(relayBackupRoot, { recursive: true, force: true });
        await rmdir(win32.dirname(relayBackupRoot)).catch((error: unknown) => {
          if (!isMissingFileError(error) && !isDirectoryNotEmptyError(error)) throw error;
        });
      }
    }
  }

  await rm(layout.migrationStatePath, { force: true });
  return "cleaned";
};

const sameWindowsRoot = (left: string, right: string): boolean =>
  left.replace(/[\\/]+$/u, "").toLowerCase()
  === right.replace(/[\\/]+$/u, "").toLowerCase();

const sameWindowsPath = (left: string, right: string): boolean =>
  win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();

const isValidatedTargetBackup = (backupPath: string, layout: WindowsDataLayout): boolean => {
  const normalizedBackupPath = win32.normalize(backupPath);
  return [layout.userDataPath, layout.runtimeHomePath].some((targetPath) => {
    const prefix = `${win32.normalize(targetPath)}.migration-backup-`;
    const suffix = normalizedBackupPath.slice(prefix.length);
    return normalizedBackupPath.toLowerCase().startsWith(prefix.toLowerCase())
      && /^[a-f0-9]{32}$/iu.test(suffix);
  });
};

const resolveValidatedRuntimeSourcesForCleanup = (
  state: WindowsDataMigrationState,
  layout: WindowsDataLayout,
  trustedLegacyRuntimeHomePaths: string[]
): string[] => {
  if (!Array.isArray(state.preparedCopies)) return [];

  const explicitlyTrustedSources = new Set(
    trustedLegacyRuntimeHomePaths.map((path) => win32.normalize(path).toLowerCase())
  );
  const copiedRuntimeSources = new Set<string>();
  for (const copy of state.preparedCopies) {
    if (!copy || typeof copy !== "object") continue;
    const sourcePath = "SourcePath" in copy ? copy.SourcePath : undefined;
    const destinationPath = "DestinationPath" in copy ? copy.DestinationPath : undefined;
    if (
      typeof sourcePath === "string"
      && win32.isAbsolute(sourcePath)
      && typeof destinationPath === "string"
      && sameWindowsPath(destinationPath, layout.runtimeHomePath)
    ) {
      copiedRuntimeSources.add(win32.normalize(sourcePath).toLowerCase());
    }
  }

  const candidates = Array.isArray(state.runtimeSourcePaths)
    ? state.runtimeSourcePaths
    : [state.runtimeSourcePath];
  const validated: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !win32.isAbsolute(candidate)) continue;
    const normalizedCandidate = win32.normalize(candidate);
    if (sameWindowsPath(normalizedCandidate, layout.runtimeHomePath)) continue;
    const candidateKey = normalizedCandidate.toLowerCase();
    if (!copiedRuntimeSources.has(candidateKey)) continue;

    const root = win32.parse(normalizedCandidate).root;
    const canonicalDriveRuntimeHome = win32.join(root, "MemmyData", ".memmy");
    if (
      !sameWindowsPath(normalizedCandidate, canonicalDriveRuntimeHome)
      && !explicitlyTrustedSources.has(candidateKey)
    ) {
      continue;
    }
    if (!validated.some((path) => sameWindowsPath(path, normalizedCandidate))) {
      validated.push(normalizedCandidate);
    }
  }
  return validated;
};

const resolveValidatedRelayBackupRoot = (
  state: WindowsDataMigrationState,
  layout: WindowsDataLayout
): string | null => {
  if (
    state.owner !== "relay"
    || typeof state.sourceDataPath !== "string"
    || typeof state.sourceInstallDir !== "string"
    || !win32.isAbsolute(state.sourceInstallDir)
    || !sameWindowsPath(state.sourceInstallDir, win32.dirname(layout.legacyInstallDataPath))
    || !Array.isArray(state.preparedCopies)
  ) return null;
  const normalizedSourcePath = win32.normalize(state.sourceDataPath);
  if (win32.basename(normalizedSourcePath).toLowerCase() !== "data-backup") return null;
  const backupRoot = win32.dirname(normalizedSourcePath);
  const backupParent = win32.dirname(backupRoot);
  const workLeaf = win32.basename(backupRoot);
  const sourceInstallDir = win32.normalize(state.sourceInstallDir);
  const expectedBackupParent = `${sourceInstallDir}.memmy-upgrade-backup`;
  if (!/^\d+$/u.test(workLeaf) || !sameWindowsPath(backupParent, expectedBackupParent)) return null;
  const copiedFromRelayBackup = state.preparedCopies.some((copy) => {
    if (!copy || typeof copy !== "object") return false;
    const sourcePath = "SourcePath" in copy ? copy.SourcePath : undefined;
    const destinationPath = "DestinationPath" in copy ? copy.DestinationPath : undefined;
    return typeof sourcePath === "string"
      && typeof destinationPath === "string"
      && (
        (sameWindowsPath(sourcePath, win32.join(normalizedSourcePath, "Memmy"))
          && sameWindowsPath(destinationPath, layout.userDataPath))
        || (sameWindowsPath(sourcePath, win32.join(normalizedSourcePath, ".memmy"))
          && sameWindowsPath(destinationPath, layout.runtimeHomePath))
      );
  });
  return copiedFromRelayBackup ? backupRoot : null;
};

const resolveValidatedCleanupLayout = (
  state: WindowsDataMigrationState,
  layout: WindowsDataLayout,
  trustedLegacyRuntimeHomePaths: string[]
): WindowsDataLayout | null => {
  if (
    typeof state.targetUserDataPath !== "string"
    || typeof state.targetRuntimeHomePath !== "string"
    || !sameWindowsPath(state.targetUserDataPath, layout.userDataPath)
    || !win32.isAbsolute(state.targetRuntimeHomePath)
  ) return null;
  const runtimePath = win32.normalize(state.targetRuntimeHomePath);
  const canonicalRuntimePath = win32.join(win32.parse(runtimePath).root, "MemmyData", ".memmy");
  const runtimeIsTrusted = sameWindowsPath(runtimePath, layout.runtimeHomePath)
    || sameWindowsPath(runtimePath, canonicalRuntimePath)
    || trustedLegacyRuntimeHomePaths.some((candidate) => sameWindowsPath(candidate, runtimePath));
  return runtimeIsTrusted ? { ...layout, runtimeHomePath: runtimePath } : null;
};

const cleanupValidatedInstallSources = async (
  state: WindowsDataMigrationState,
  layout: WindowsDataLayout
): Promise<void> => {
  if (
    !trustedInstallAuthorities.has(String(state.sourceAuthority))
    || state.sourceAuthority === "relay-backup-authority"
    || typeof state.sourceDataPath !== "string"
    || typeof state.sourceInstallDir !== "string"
    || !win32.isAbsolute(state.sourceDataPath)
    || !win32.isAbsolute(state.sourceInstallDir)
    || !Array.isArray(state.preparedCopies)
  ) return;

  const sourceDataPath = win32.normalize(state.sourceDataPath);
  const sourceInstallDir = win32.normalize(state.sourceInstallDir);
  if (!sameWindowsPath(sourceInstallDir, win32.dirname(layout.legacyInstallDataPath))) return;
  const directDataPath = win32.join(sourceInstallDir, "data");
  const failedBackupRoot = win32.dirname(sourceDataPath);
  const failedBackupParent = win32.dirname(failedBackupRoot);
  const isFailedBackup = win32.basename(sourceDataPath).toLowerCase() === "data-backup"
    && sameWindowsPath(failedBackupParent, `${sourceInstallDir}.memmy-migration-failed`)
    && /^[0-9]{14}-[a-f0-9]{32}$/iu.test(win32.basename(failedBackupRoot));
  if (!sameWindowsPath(sourceDataPath, directDataPath) && !isFailedBackup) return;

  const validatedSources: string[] = [];
  for (const copy of state.preparedCopies) {
    if (!copy || typeof copy !== "object") continue;
    const sourcePath = "SourcePath" in copy ? copy.SourcePath : undefined;
    const destinationPath = "DestinationPath" in copy ? copy.DestinationPath : undefined;
    if (typeof sourcePath !== "string" || typeof destinationPath !== "string") continue;
    const isAccountCopy = sameWindowsPath(sourcePath, win32.join(sourceDataPath, "Memmy"))
      && sameWindowsPath(destinationPath, layout.userDataPath);
    const isRuntimeCopy = sameWindowsPath(sourcePath, win32.join(sourceDataPath, ".memmy"))
      && sameWindowsPath(destinationPath, layout.runtimeHomePath);
    if ((isAccountCopy || isRuntimeCopy) && !validatedSources.some((path) => sameWindowsPath(path, sourcePath))) {
      validatedSources.push(sourcePath);
    }
  }
  for (const sourcePath of validatedSources) {
    await rm(sourcePath, { recursive: true, force: true });
  }
  if (isFailedBackup && validatedSources.length > 0) {
    await rm(failedBackupRoot, { recursive: true, force: true });
    await rmdir(failedBackupParent).catch((error: unknown) => {
      if (!isMissingFileError(error) && !isDirectoryNotEmptyError(error)) throw error;
    });
  }
};

const writeJsonAtomically = async (statePath: string, state: object): Promise<void> => {
  await mkdir(win32.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, JSON.stringify(state, null, 2), { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, statePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
};

const writeMigrationStateAtomically = writeJsonAtomically;

const validateMigrationTargets = (
  state: WindowsDataMigrationState,
  layout: WindowsDataLayout
): void => {
  if (
    typeof state.targetUserDataPath !== "string"
    || typeof state.targetRuntimeHomePath !== "string"
    || !sameWindowsPath(state.targetUserDataPath, layout.userDataPath)
    || !sameWindowsPath(state.targetRuntimeHomePath, layout.runtimeHomePath)
  ) {
    throw new Error("Windows data migration state does not match the active data layout");
  }
};

const validatePreparedCopiesForRollback = (
  preparedCopies: unknown,
  layout: WindowsDataLayout
): Array<{ destinationPath: string; backupPath?: string; stagingPath?: string }> => {
  if (!Array.isArray(preparedCopies)) return [];
  const validated: Array<{ destinationPath: string; backupPath?: string; stagingPath?: string }> = [];
  const destinationKeys = new Set<string>();
  for (const value of preparedCopies) {
    if (!value || typeof value !== "object") continue;
    const destinationPath = "DestinationPath" in value ? value.DestinationPath : undefined;
    const backupPath = "BackupPath" in value ? value.BackupPath : undefined;
    const stagingPath = "StagingPath" in value ? value.StagingPath : undefined;
    if (
      typeof destinationPath !== "string"
      || ![layout.userDataPath, layout.runtimeHomePath].some((target) => sameWindowsPath(target, destinationPath))
    ) {
      throw new Error("Prepared Windows migration copy has an unsafe destination");
    }
    const normalizedDestinationPath = win32.normalize(destinationPath);
    const destinationKey = normalizedDestinationPath.toLowerCase();
    if (destinationKeys.has(destinationKey)) {
      throw new Error("Prepared Windows migration state contains a duplicate destination");
    }
    destinationKeys.add(destinationKey);
    let normalizedStagingPath: string | undefined;
    if (stagingPath !== null && stagingPath !== undefined) {
      normalizedStagingPath = typeof stagingPath === "string" ? win32.normalize(stagingPath) : "";
      const expectedStagingPrefix = `${normalizedDestinationPath}.migrating-`;
      const stagingSuffix = normalizedStagingPath.slice(expectedStagingPrefix.length);
      if (
        typeof stagingPath !== "string"
        || !normalizedStagingPath.toLowerCase().startsWith(expectedStagingPrefix.toLowerCase())
        || !/^[a-f0-9]{32}$/iu.test(stagingSuffix)
      ) {
        throw new Error("Prepared Windows migration copy has an unsafe staging path");
      }
    }
    if (backupPath !== null && backupPath !== undefined) {
      const normalizedBackupPath = typeof backupPath === "string" ? win32.normalize(backupPath) : "";
      const expectedPrefix = `${normalizedDestinationPath}.migration-backup-`;
      const suffix = normalizedBackupPath.slice(expectedPrefix.length);
      if (
        typeof backupPath !== "string"
        || !normalizedBackupPath.toLowerCase().startsWith(expectedPrefix.toLowerCase())
        || !/^[a-f0-9]{32}$/iu.test(suffix)
      ) {
        throw new Error("Prepared Windows migration copy has an unsafe backup");
      }
      validated.push({
        destinationPath: normalizedDestinationPath,
        backupPath: normalizedBackupPath,
        ...(normalizedStagingPath ? { stagingPath: normalizedStagingPath } : {})
      });
    } else {
      validated.push({
        destinationPath: normalizedDestinationPath,
        ...(normalizedStagingPath ? { stagingPath: normalizedStagingPath } : {})
      });
    }
  }
  return validated;
};

const quarantineMigrationState = async (statePath: string): Promise<string | undefined> => {
  const quarantinePath = `${statePath}.startup-failed-${Date.now()}-${randomUUID()}`;
  try {
    await rename(statePath, quarantinePath);
    return quarantinePath;
  } catch (error) {
    if (!isMissingFileError(error)) return undefined;
    return undefined;
  }
};

const isMissingFileError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const isDirectoryNotEmptyError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error && error.code === "ENOTEMPTY";
