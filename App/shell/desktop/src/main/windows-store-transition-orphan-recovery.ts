import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { win32 } from "node:path";
import { resolveWindowsStorePreparedDataTransitionStatePath } from "./windows-store-data-transition.js";
import {
  parseWindowsStoreTransitionState,
  resolveWindowsStoreTransitionStatePath,
  type WindowsStoreTransitionState
} from "./windows-store-transition-state.js";

export interface ArchiveOrphanedWindowsStoreTransitionOptions {
  statePath: string;
  expectedState: WindowsStoreTransitionState;
  now?: Date;
  archiveId?: string;
}

export interface ArchivedOrphanedWindowsStoreTransition {
  archiveDirectory: string;
  archivedStatePath: string;
  archivedPreparedStatePath: string | null;
  recoveryRecordPath: string;
}

export const archiveOrphanedWindowsStoreTransition = async (
  options: ArchiveOrphanedWindowsStoreTransitionOptions
): Promise<ArchivedOrphanedWindowsStoreTransition> => {
  const { statePath, localAppDataPath, transitionDirectory } = normalizeFixedStatePath(options.statePath);
  const expectedState = parseWindowsStoreTransitionState(JSON.stringify(options.expectedState));
  const currentState = parseWindowsStoreTransitionState(await readFile(statePath, "utf8"));
  if (JSON.stringify(currentState) !== JSON.stringify(expectedState)) {
    throw new Error("Windows Store transition changed during orphan recovery");
  }
  await assertRegularFile(statePath, "active journal");

  const recoveredAt = normalizeDate(options.now ?? new Date());
  const archiveId = normalizeArchiveId(options.archiveId ?? randomUUID());
  const archiveRoot = win32.join(transitionDirectory, "archive");
  const archiveDirectory = win32.join(
    archiveRoot,
    `package-unregistered-${recoveredAt.getTime()}-${expectedState.transactionId}-${archiveId}`
  );
  const preparedStatePath = resolveWindowsStorePreparedDataTransitionStatePath(
    localAppDataPath,
    expectedState.transactionId
  );
  const preparedExists = await regularFileExists(preparedStatePath, "prepared journal");
  const archivedStatePath = win32.join(archiveDirectory, "active.json");
  const archivedPreparedStatePath = preparedExists
    ? win32.join(archiveDirectory, "prepared-data.json")
    : null;
  const recoveryRecordPath = win32.join(archiveDirectory, "recovery.json");

  await mkdir(archiveRoot, { recursive: true });
  await mkdir(archiveDirectory);
  let preparedMoved = false;
  try {
    await writeFile(recoveryRecordPath, `${JSON.stringify({
      schemaVersion: 1,
      reason: "package-unregistered",
      packageFamilyName: expectedState.packageFamilyName,
      transactionId: expectedState.transactionId,
      phase: expectedState.phase,
      recoveredAt: recoveredAt.toISOString(),
      preparedJournalArchived: preparedExists
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    if (archivedPreparedStatePath) {
      await rename(preparedStatePath, archivedPreparedStatePath);
      preparedMoved = true;
    }
    // Moving active.json is the commit point. Until this atomic rename succeeds,
    // another launch still sees the blocking transaction and fails closed.
    await rename(statePath, archivedStatePath);
  } catch (cause) {
    if (preparedMoved && archivedPreparedStatePath) {
      try {
        await rename(archivedPreparedStatePath, preparedStatePath);
      } catch (rollbackError) {
        throw new AggregateError(
          [cause, rollbackError],
          "Windows Store orphan recovery failed and prepared-journal rollback was incomplete"
        );
      }
    }
    await rm(archiveDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw cause;
  }

  return {
    archiveDirectory,
    archivedStatePath,
    archivedPreparedStatePath,
    recoveryRecordPath
  };
};

const normalizeFixedStatePath = (value: string): {
  statePath: string;
  localAppDataPath: string;
  transitionDirectory: string;
} => {
  if (!value || value !== value.trim() || !win32.isAbsolute(value)) {
    throw new Error("Windows Store orphan recovery state path must be absolute");
  }
  const statePath = win32.normalize(value);
  const transitionDirectory = win32.dirname(statePath);
  const memmyDirectory = win32.dirname(transitionDirectory);
  const localAppDataPath = win32.dirname(memmyDirectory);
  if (statePath !== value
      || win32.basename(statePath).toLowerCase() !== "active.json"
      || win32.basename(transitionDirectory).toLowerCase() !== "store-transition"
      || win32.basename(memmyDirectory).toLowerCase() !== "memmy"
      || !sameWindowsPath(resolveWindowsStoreTransitionStatePath(localAppDataPath), statePath)) {
    throw new Error("Windows Store orphan recovery state path must be the fixed active journal path");
  }
  return { statePath, localAppDataPath, transitionDirectory };
};

const regularFileExists = async (path: string, label: string): Promise<boolean> => {
  try {
    await assertRegularFile(path, label);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
};

const assertRegularFile = async (path: string, label: string): Promise<void> => {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Windows Store orphan recovery ${label} is not a regular file`);
  }
};

const normalizeDate = (value: Date): Date => {
  if (!Number.isFinite(value.getTime())) {
    throw new Error("Windows Store orphan recovery timestamp is invalid");
  }
  return value;
};

const normalizeArchiveId = (value: string): string => {
  const normalized = value.toLowerCase();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(normalized)) {
    throw new Error("Windows Store orphan recovery archive ID is invalid");
  }
  return normalized;
};

const sameWindowsPath = (left: string, right: string): boolean =>
  win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();

const isMissingFileError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
