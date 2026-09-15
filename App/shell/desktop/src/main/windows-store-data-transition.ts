import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, win32 } from "node:path";

export type WindowsStoreDataCategory = "user-data" | "runtime";

export interface PlanWindowsStoreDataTransitionOptions {
  transactionId: string;
  sourceUserDataPath: string;
  sourceRuntimeHomePath: string;
  destinationUserDataPath: string;
  destinationRuntimeHomePath: string;
  migrateRuntime: boolean;
}

export interface WindowsStoreDataCopyPlan {
  category: WindowsStoreDataCategory;
  sourcePath: string;
  destinationPath: string;
  stagingPath: string;
  backupPath: string;
  recoveryPath: string;
}

export interface WindowsStoreDataTransitionPlan extends PlanWindowsStoreDataTransitionOptions {
  copies: WindowsStoreDataCopyPlan[];
}

export interface WindowsStoreDataTreeEntry {
  relativePath: string;
  type: "directory" | "file";
  size: number;
  sha256: string | null;
}

export interface WindowsStoreDataTreeManifest {
  entries: WindowsStoreDataTreeEntry[];
  fileCount: number;
  directoryCount: number;
  totalBytes: number;
}

export interface PreparedWindowsStoreDataCopy extends WindowsStoreDataCopyPlan {
  sourceManifest: WindowsStoreDataTreeManifest;
  destinationPreviouslyExisted: boolean;
  previousDestinationManifest: WindowsStoreDataTreeManifest | null;
}

export interface PreparedWindowsStoreDataTransition {
  schemaVersion: 2;
  plan: WindowsStoreDataTransitionPlan;
  copies: PreparedWindowsStoreDataCopy[];
}

type WindowsStoreDataPathKind = "missing" | "directory" | "file" | "symbolic-link" | "other";

export interface WindowsStoreDataTransitionDependencies {
  copyTree?: (sourcePath: string, destinationPath: string) => Promise<void>;
  ensureDirectory?: (path: string) => Promise<void>;
  pathKind?: (path: string) => Promise<WindowsStoreDataPathKind>;
  readTreeManifest?: (path: string) => Promise<WindowsStoreDataTreeManifest>;
  removePath?: (path: string) => Promise<void>;
  renamePath?: (sourcePath: string, destinationPath: string) => Promise<void>;
}

export interface PrepareWindowsStoreDataTransitionOptions extends WindowsStoreDataTransitionDependencies {
  preparedStatePath: string;
}

export interface CleanupWindowsStoreDataTransitionOptions extends WindowsStoreDataTransitionDependencies {
  cleanupEligible: boolean;
  preserveSources?: boolean;
}

export interface CleanupWindowsStoreDataTransitionResult {
  cleaned: boolean;
  removedSources: string[];
  removedBackups: string[];
}

interface ResolvedWindowsStoreDataTransitionIo {
  copyTree(sourcePath: string, destinationPath: string): Promise<void>;
  ensureDirectory(path: string): Promise<void>;
  pathKind(path: string): Promise<WindowsStoreDataPathKind>;
  readTreeManifest(path: string): Promise<WindowsStoreDataTreeManifest>;
  removePath(path: string): Promise<void>;
  renamePath(sourcePath: string, destinationPath: string): Promise<void>;
}

export const planWindowsStoreDataTransition = (
  options: PlanWindowsStoreDataTransitionOptions
): WindowsStoreDataTransitionPlan => {
  const transactionId = normalizeTransactionId(options.transactionId);
  const sourceUserDataPath = normalizeDirectoryPath(options.sourceUserDataPath, "source userData");
  const sourceRuntimeHomePath = normalizeDirectoryPath(options.sourceRuntimeHomePath, "source runtime");
  const destinationUserDataPath = normalizeDirectoryPath(options.destinationUserDataPath, "destination userData");
  const destinationRuntimeHomePath = normalizeDirectoryPath(options.destinationRuntimeHomePath, "destination runtime");
  if (typeof options.migrateRuntime !== "boolean") {
    throw new Error("Windows Store data transition migrateRuntime must be boolean");
  }

  const runtimePathsMatch = sameWindowsPath(sourceRuntimeHomePath, destinationRuntimeHomePath);
  if (!options.migrateRuntime && !runtimePathsMatch) {
    throw new Error("Windows Store data transition migrateRuntime=false requires the same source and destination runtime");
  }
  if (options.migrateRuntime && runtimePathsMatch) {
    throw new Error("Windows Store data transition migrateRuntime=true requires different source and destination runtime paths");
  }

  const copies = [createCopyPlan(
    "user-data",
    sourceUserDataPath,
    destinationUserDataPath,
    transactionId
  )];
  if (options.migrateRuntime) {
    copies.push(createCopyPlan(
      "runtime",
      sourceRuntimeHomePath,
      destinationRuntimeHomePath,
      transactionId
    ));
  }
  assertCopyRootsDoNotOverlap(copies);
  if (!options.migrateRuntime) {
    assertSharedRuntimeDoesNotOverlapCopyRoots(sourceRuntimeHomePath, copies);
  }
  return {
    transactionId,
    sourceUserDataPath,
    sourceRuntimeHomePath,
    destinationUserDataPath,
    destinationRuntimeHomePath,
    migrateRuntime: options.migrateRuntime,
    copies
  };
};

export const resolveWindowsStorePreparedDataTransitionStatePath = (
  localAppDataPath: string,
  transactionId: string
): string => win32.join(
  normalizeDirectoryPath(localAppDataPath, "LocalAppData"),
  "Memmy",
  "store-transition",
  `prepared-data-${normalizeTransactionId(transactionId)}.json`
);

export const parseWindowsStorePreparedDataTransition = (
  contents: string
): PreparedWindowsStoreDataTransition => {
  try {
    return validatePreparedTransition(JSON.parse(contents) as unknown);
  } catch (cause) {
    throw new Error("Windows Store prepared data transition state is invalid", { cause });
  }
};

export const readWindowsStorePreparedDataTransition = async (
  statePath: string
): Promise<PreparedWindowsStoreDataTransition | null> => {
  const validatedPath = normalizePreparedStatePath(statePath);
  try {
    return parseWindowsStorePreparedDataTransition(await readFile(validatedPath, "utf8"));
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
};

export const writeWindowsStorePreparedDataTransition = async (
  statePath: string,
  input: PreparedWindowsStoreDataTransition
): Promise<void> => {
  const validatedPath = normalizePreparedStatePath(statePath);
  const prepared = validatePreparedTransition(input);
  const existing = await readWindowsStorePreparedDataTransition(validatedPath);
  if (existing) {
    if (JSON.stringify(existing) === JSON.stringify(prepared)) return;
    throw new Error("Windows Store prepared data transition state belongs to another transaction");
  }
  await mkdir(dirname(validatedPath), { recursive: true });
  const temporaryPath = `${validatedPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(prepared, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx"
    });
    await rename(temporaryPath, validatedPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
};

export const prepareWindowsStoreDataTransition = async (
  inputPlan: WindowsStoreDataTransitionPlan,
  options: PrepareWindowsStoreDataTransitionOptions
): Promise<PreparedWindowsStoreDataTransition> => {
  const plan = validatePlan(inputPlan);
  const preparedStatePath = normalizePreparedStatePath(options.preparedStatePath);
  const io = resolveIo(options);
  await preflightPlan(plan, io);
  const stagedCopies: Array<WindowsStoreDataCopyPlan & { sourceManifest: WindowsStoreDataTreeManifest }> = [];

  try {
    for (const copy of plan.copies) {
      const sourceManifest = await io.readTreeManifest(copy.sourcePath);
      await io.ensureDirectory(win32.dirname(copy.stagingPath));
      await io.copyTree(copy.sourcePath, copy.stagingPath);
      const sourceManifestAfterStaging = await io.readTreeManifest(copy.sourcePath);
      if (!sameTreeManifest(sourceManifest, sourceManifestAfterStaging)) {
        throw new Error(`Windows Store data transition source changed while staging ${copy.category}`);
      }
      const stagingManifest = await io.readTreeManifest(copy.stagingPath);
      if (!sameTreeManifest(sourceManifest, stagingManifest)) {
        throw new Error(`Windows Store data transition tree manifest mismatch for ${copy.category}`);
      }
      stagedCopies.push({
        ...copy,
        sourceManifest
      });
    }
  } catch (cause) {
    await removeStagingPaths(plan, io, cause);
    throw cause;
  }

  const preparedCopies: PreparedWindowsStoreDataCopy[] = [];
  try {
    for (const copy of stagedCopies) {
      const destinationKind = await io.pathKind(copy.destinationPath);
      if (destinationKind !== "missing" && destinationKind !== "directory") {
        throw new Error(`Windows Store data transition destination is not a directory: ${copy.destinationPath}`);
      }
      const previousDestinationManifest = destinationKind === "directory"
        ? await io.readTreeManifest(copy.destinationPath)
        : null;
      preparedCopies.push({
        ...copy,
        destinationPreviouslyExisted: previousDestinationManifest !== null,
        previousDestinationManifest
      });
    }
  } catch (cause) {
    await removeStagingPaths(plan, io, cause);
    throw cause;
  }
  const prepared: PreparedWindowsStoreDataTransition = {
    schemaVersion: 2,
    plan,
    copies: preparedCopies
  };
  try {
    await writeWindowsStorePreparedDataTransition(preparedStatePath, prepared);
  } catch (cause) {
    await removeStagingPaths(plan, io, cause);
    throw cause;
  }
  try {
    for (const copy of prepared.copies) {
      await assertDestinationMatchesPreviousState(copy, io);
      if (copy.destinationPreviouslyExisted) {
        await io.renamePath(copy.destinationPath, copy.backupPath);
        await assertBackupMatchesPreviousState(copy, io);
      }
      await io.renamePath(copy.stagingPath, copy.destinationPath);
    }
    return prepared;
  } catch (cause) {
    try {
      await rollbackWindowsStoreDataTransition(prepared, options);
    } catch (rollbackError) {
      throw new AggregateError(
        [cause, rollbackError],
        "Windows Store data transition failed and rollback was incomplete"
      );
    }
    throw cause;
  }
};

export const rollbackWindowsStoreDataTransition = async (
  input: PreparedWindowsStoreDataTransition,
  dependencies: WindowsStoreDataTransitionDependencies = {}
): Promise<void> => {
  const prepared = validatePreparedTransition(input);
  const io = resolveIo(dependencies);
  const errors: unknown[] = [];
  for (const copy of [...prepared.copies].reverse()) {
    try {
      await rollbackCopy(copy, io);
    } catch (error) {
      errors.push(error);
    }
    try {
      await io.removePath(copy.stagingPath);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Windows Store data transition rollback was incomplete");
  }
};

export const assertWindowsStorePreparedDataTransitionSourcesUnchanged = async (
  input: PreparedWindowsStoreDataTransition,
  dependencies: WindowsStoreDataTransitionDependencies = {}
): Promise<void> => {
  const prepared = validatePreparedTransition(input);
  const io = resolveIo(dependencies);
  for (const copy of prepared.copies) {
    await assertDirectoryMatchesManifest(
      copy.sourcePath,
      await io.pathKind(copy.sourcePath),
      copy.sourceManifest,
      io
    );
  }
};

export const cleanupWindowsStoreDataTransition = async (
  input: PreparedWindowsStoreDataTransition,
  options: CleanupWindowsStoreDataTransitionOptions
): Promise<CleanupWindowsStoreDataTransitionResult> => {
  if (options.cleanupEligible !== true) {
    return { cleaned: false, removedSources: [], removedBackups: [] };
  }

  const prepared = validatePreparedTransition(input);
  const io = resolveIo(options);
  const currentKinds = await validateCleanupTrees(
    prepared,
    io,
    options.preserveSources === true
  );
  const removedSources: string[] = [];
  const removedBackups: string[] = [];
  for (const [index, copy] of prepared.copies.entries()) {
    const kinds = currentKinds[index];
    if (kinds?.source === "directory" && options.preserveSources !== true) {
      await io.removePath(copy.sourcePath);
      removedSources.push(copy.sourcePath);
    }
    if (kinds?.backup === "directory") {
      await io.removePath(copy.backupPath);
      removedBackups.push(copy.backupPath);
    }
  }
  return { cleaned: true, removedSources, removedBackups };
};

export const readWindowsStoreDataTreeManifest = async (
  rootPath: string
): Promise<WindowsStoreDataTreeManifest> => {
  const rootKind = await defaultPathKind(rootPath);
  if (rootKind !== "directory") {
    throw new Error(`Windows Store data transition source is not a directory: ${rootPath}`);
  }

  const entries: WindowsStoreDataTreeEntry[] = [];
  const walk = async (directoryPath: string, relativeParts: string[]): Promise<void> => {
    const children = await readdir(directoryPath, { withFileTypes: true });
    children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const child of children) {
      const childPath = win32.join(directoryPath, child.name);
      const childRelativeParts = [...relativeParts, child.name];
      const relativePath = childRelativeParts.join("/");
      const stats = await lstat(childPath);
      if (stats.isSymbolicLink()) {
        throw new Error(`Windows Store data transition does not accept symbolic links: ${childPath}`);
      }
      if (stats.isDirectory()) {
        entries.push({ relativePath, type: "directory", size: 0, sha256: null });
        await walk(childPath, childRelativeParts);
        continue;
      }
      if (!stats.isFile()) {
        throw new Error(`Windows Store data transition found an unsupported tree entry: ${childPath}`);
      }
      entries.push({
        relativePath,
        type: "file",
        size: stats.size,
        sha256: await readFileSha256(childPath)
      });
    }
  };
  await walk(rootPath, []);
  return createTreeManifest(entries);
};

const createCopyPlan = (
  category: WindowsStoreDataCategory,
  sourcePath: string,
  destinationPath: string,
  transactionId: string
): WindowsStoreDataCopyPlan => ({
  category,
  sourcePath,
  destinationPath,
  stagingPath: `${destinationPath}.store-staging-${transactionId}`,
  backupPath: `${destinationPath}.store-backup-${transactionId}`,
  recoveryPath: `${destinationPath}.store-recovery-${transactionId}`
});

const planKeys = [
  "transactionId",
  "sourceUserDataPath",
  "sourceRuntimeHomePath",
  "destinationUserDataPath",
  "destinationRuntimeHomePath",
  "migrateRuntime",
  "copies"
] as const;

const copyPlanKeys = [
  "category",
  "sourcePath",
  "destinationPath",
  "stagingPath",
  "backupPath",
  "recoveryPath"
] as const;

const preparedKeys = ["schemaVersion", "plan", "copies"] as const;
const preparedCopyKeys = [
  ...copyPlanKeys,
  "sourceManifest",
  "destinationPreviouslyExisted",
  "previousDestinationManifest"
] as const;
const manifestKeys = ["entries", "fileCount", "directoryCount", "totalBytes"] as const;
const manifestEntryKeys = ["relativePath", "type", "size", "sha256"] as const;

const validatePlan = (value: unknown): WindowsStoreDataTransitionPlan => {
  if (!isRecord(value) || !hasExactKeys(value, planKeys) || !Array.isArray(value.copies)) {
    throw new Error("Windows Store data transition plan is invalid");
  }
  if (value.copies.some((copy) => !isRecord(copy) || !hasExactKeys(copy, copyPlanKeys))) {
    throw new Error("Windows Store data transition plan copies are invalid");
  }
  const normalized = planWindowsStoreDataTransition({
    transactionId: value.transactionId as string,
    sourceUserDataPath: value.sourceUserDataPath as string,
    sourceRuntimeHomePath: value.sourceRuntimeHomePath as string,
    destinationUserDataPath: value.destinationUserDataPath as string,
    destinationRuntimeHomePath: value.destinationRuntimeHomePath as string,
    migrateRuntime: value.migrateRuntime as boolean
  });
  if (JSON.stringify(normalized.copies) !== JSON.stringify(value.copies)) {
    throw new Error("Windows Store data transition plan was modified after validation");
  }
  return normalized;
};

const validatePreparedTransition = (
  value: unknown
): PreparedWindowsStoreDataTransition => {
  if (!isRecord(value) || !hasExactKeys(value, preparedKeys) || value.schemaVersion !== 2) {
    throw new Error("Windows Store prepared data transition schema is invalid");
  }
  const plan = validatePlan(value.plan);
  if (!Array.isArray(value.copies) || value.copies.length !== plan.copies.length) {
    throw new Error("Windows Store prepared data transition copies are invalid");
  }
  const copies = value.copies.map((copy, index) => {
    if (!isRecord(copy) || !hasExactKeys(copy, preparedCopyKeys)) {
      throw new Error("Windows Store prepared data transition copy is invalid");
    }
    const expected = plan.copies[index];
    if (
      !expected
      || copy.category !== expected.category
      || copy.sourcePath !== expected.sourcePath
      || copy.destinationPath !== expected.destinationPath
      || copy.stagingPath !== expected.stagingPath
      || copy.backupPath !== expected.backupPath
      || copy.recoveryPath !== expected.recoveryPath
      || typeof copy.destinationPreviouslyExisted !== "boolean"
    ) {
      throw new Error("Windows Store prepared data transition binding is invalid");
    }
    const previousDestinationManifest = copy.previousDestinationManifest === null
      ? null
      : validateTreeManifest(copy.previousDestinationManifest);
    if (copy.destinationPreviouslyExisted !== (previousDestinationManifest !== null)) {
      throw new Error("Windows Store prepared data transition destination snapshot is invalid");
    }
    return {
      ...expected,
      sourceManifest: validateTreeManifest(copy.sourceManifest),
      destinationPreviouslyExisted: copy.destinationPreviouslyExisted,
      previousDestinationManifest
    };
  });
  return { schemaVersion: 2, plan, copies };
};

const preflightPlan = async (
  plan: WindowsStoreDataTransitionPlan,
  io: ResolvedWindowsStoreDataTransitionIo
): Promise<void> => {
  for (const copy of plan.copies) {
    const [sourceKind, destinationKind, stagingKind, backupKind, recoveryKind] = await Promise.all([
      io.pathKind(copy.sourcePath),
      io.pathKind(copy.destinationPath),
      io.pathKind(copy.stagingPath),
      io.pathKind(copy.backupPath),
      io.pathKind(copy.recoveryPath)
    ]);
    if (sourceKind !== "directory") {
      throw new Error(`Windows Store data transition source is not a directory: ${copy.sourcePath}`);
    }
    if (destinationKind !== "missing" && destinationKind !== "directory") {
      throw new Error(`Windows Store data transition destination is not a directory: ${copy.destinationPath}`);
    }
    if (stagingKind !== "missing" || backupKind !== "missing" || recoveryKind !== "missing") {
      throw new Error(`Windows Store data transition artifacts already exist for ${copy.category}`);
    }
  }
};

const rollbackCopy = async (
  copy: PreparedWindowsStoreDataCopy,
  io: ResolvedWindowsStoreDataTransitionIo
): Promise<void> => {
  const [destinationKind, backupKind, recoveryKind] = await Promise.all([
    io.pathKind(copy.destinationPath),
    io.pathKind(copy.backupPath),
    io.pathKind(copy.recoveryPath)
  ]);
  if (backupKind !== "missing" && backupKind !== "directory") {
    throw new Error(`Windows Store data transition backup is unsafe: ${copy.backupPath}`);
  }
  if (recoveryKind !== "missing" && recoveryKind !== "directory") {
    throw new Error(`Windows Store data transition recovery path is unsafe: ${copy.recoveryPath}`);
  }
  if (!copy.destinationPreviouslyExisted && backupKind !== "missing") {
    throw new Error(`Windows Store data transition found an unowned backup: ${copy.backupPath}`);
  }
  if (backupKind === "directory") {
    await assertBackupMatchesPreviousState(copy, io);
    if (destinationKind !== "missing") {
      if (recoveryKind !== "missing") {
        throw new Error(`Windows Store data transition recovery path is already occupied: ${copy.recoveryPath}`);
      }
      if (await directoryMatchesManifest(copy.destinationPath, destinationKind, copy.sourceManifest, io)) {
        await io.removePath(copy.destinationPath);
      } else {
        await io.renamePath(copy.destinationPath, copy.recoveryPath);
      }
    }
    await io.renamePath(copy.backupPath, copy.destinationPath);
    return;
  }
  if (copy.destinationPreviouslyExisted) {
    if (!copy.previousDestinationManifest) {
      throw new Error(`Windows Store data transition previous destination snapshot is missing: ${copy.destinationPath}`);
    }
    if (!await directoryMatchesManifest(
      copy.destinationPath,
      destinationKind,
      copy.previousDestinationManifest,
      io
    )) {
      throw new Error(`Windows Store data transition owned backup is missing: ${copy.backupPath}`);
    }
    return;
  }
  if (!copy.destinationPreviouslyExisted && destinationKind !== "missing") {
    if (recoveryKind !== "missing") {
      throw new Error(`Windows Store data transition recovery path is already occupied: ${copy.recoveryPath}`);
    }
    if (await directoryMatchesManifest(copy.destinationPath, destinationKind, copy.sourceManifest, io)) {
      await io.removePath(copy.destinationPath);
    } else {
      await io.renamePath(copy.destinationPath, copy.recoveryPath);
    }
  }
};

const validateCleanupTrees = async (
  prepared: PreparedWindowsStoreDataTransition,
  io: ResolvedWindowsStoreDataTransitionIo,
  preserveSources: boolean
): Promise<Array<{ source: WindowsStoreDataPathKind; backup: WindowsStoreDataPathKind }>> => {
  const result: Array<{ source: WindowsStoreDataPathKind; backup: WindowsStoreDataPathKind }> = [];
  for (const copy of prepared.copies) {
    const [source, destination, backup, staging, recovery] = await Promise.all([
      io.pathKind(copy.sourcePath),
      io.pathKind(copy.destinationPath),
      io.pathKind(copy.backupPath),
      io.pathKind(copy.stagingPath),
      io.pathKind(copy.recoveryPath)
    ]);
    if (destination !== "directory") {
      throw new Error(`Windows Store data transition destination is unsafe for cleanup: ${copy.destinationPath}`);
    }
    if (preserveSources && source === "missing") {
      throw new Error(`Windows Store data transition preserved source is missing: ${copy.sourcePath}`);
    }
    if (source !== "missing") {
      await assertDirectoryMatchesManifest(copy.sourcePath, source, copy.sourceManifest, io);
    }
    if (copy.destinationPreviouslyExisted) {
      if (backup !== "missing") {
        await assertBackupMatchesPreviousState(copy, io);
      } else if (source !== "missing" && !preserveSources) {
        throw new Error(`Windows Store data transition owned backup is missing: ${copy.backupPath}`);
      }
    } else if (backup !== "missing") {
      throw new Error(`Windows Store data transition found an unowned backup: ${copy.backupPath}`);
    }
    if (staging !== "missing" || recovery !== "missing") {
      throw new Error(`Windows Store data transition cannot clean a pending or rolled-back copy: ${copy.category}`);
    }
    result.push({ source, backup });
  }
  return result;
};

const assertDirectoryMatchesManifest = async (
  path: string,
  kind: WindowsStoreDataPathKind,
  expectedManifest: WindowsStoreDataTreeManifest,
  io: ResolvedWindowsStoreDataTransitionIo
): Promise<void> => {
  if (kind !== "directory") {
    throw new Error(`Windows Store data transition expected a verified directory: ${path}`);
  }
  if (!sameTreeManifest(await io.readTreeManifest(path), expectedManifest)) {
    throw new Error(`Windows Store data transition tree manifest changed: ${path}`);
  }
};

const directoryMatchesManifest = async (
  path: string,
  kind: WindowsStoreDataPathKind,
  expectedManifest: WindowsStoreDataTreeManifest,
  io: ResolvedWindowsStoreDataTransitionIo
): Promise<boolean> => {
  if (kind !== "directory") {
    throw new Error(`Windows Store data transition expected a verified directory: ${path}`);
  }
  return sameTreeManifest(await io.readTreeManifest(path), expectedManifest);
};

const assertDestinationMatchesPreviousState = async (
  copy: PreparedWindowsStoreDataCopy,
  io: ResolvedWindowsStoreDataTransitionIo
): Promise<void> => {
  const destinationKind = await io.pathKind(copy.destinationPath);
  if (!copy.previousDestinationManifest) {
    if (destinationKind !== "missing") {
      throw new Error(`Windows Store data transition destination changed before commit: ${copy.destinationPath}`);
    }
    return;
  }
  await assertDirectoryMatchesManifest(
    copy.destinationPath,
    destinationKind,
    copy.previousDestinationManifest,
    io
  );
};

const assertBackupMatchesPreviousState = async (
  copy: PreparedWindowsStoreDataCopy,
  io: ResolvedWindowsStoreDataTransitionIo
): Promise<void> => {
  if (!copy.previousDestinationManifest) {
    throw new Error(`Windows Store data transition found an unowned backup: ${copy.backupPath}`);
  }
  await assertDirectoryMatchesManifest(
    copy.backupPath,
    await io.pathKind(copy.backupPath),
    copy.previousDestinationManifest,
    io
  );
};

const removeStagingPaths = async (
  plan: WindowsStoreDataTransitionPlan,
  io: ResolvedWindowsStoreDataTransitionIo,
  originalError: unknown
): Promise<void> => {
  const cleanupErrors: unknown[] = [];
  for (const copy of plan.copies) {
    try {
      await io.removePath(copy.stagingPath);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [originalError, ...cleanupErrors],
      "Windows Store data transition staging cleanup was incomplete"
    );
  }
};

const resolveIo = (
  dependencies: WindowsStoreDataTransitionDependencies
): ResolvedWindowsStoreDataTransitionIo => ({
  copyTree: dependencies.copyTree ?? (async (sourcePath, destinationPath) => {
    await cp(sourcePath, destinationPath, { recursive: true, errorOnExist: true, force: false });
  }),
  ensureDirectory: dependencies.ensureDirectory ?? (async (path) => {
    await mkdir(path, { recursive: true });
  }),
  pathKind: dependencies.pathKind ?? defaultPathKind,
  readTreeManifest: dependencies.readTreeManifest ?? readWindowsStoreDataTreeManifest,
  removePath: dependencies.removePath ?? (async (path) => {
    await rm(path, { recursive: true, force: true });
  }),
  renamePath: dependencies.renamePath ?? (async (sourcePath, destinationPath) => {
    await rename(sourcePath, destinationPath);
  })
});

const defaultPathKind = async (path: string): Promise<WindowsStoreDataPathKind> => {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) return "symbolic-link";
    if (stats.isDirectory()) return "directory";
    if (stats.isFile()) return "file";
    return "other";
  } catch (error) {
    if (isMissingFileError(error)) return "missing";
    throw error;
  }
};

const createTreeManifest = (entries: WindowsStoreDataTreeEntry[]): WindowsStoreDataTreeManifest => ({
  entries,
  fileCount: entries.filter((entry) => entry.type === "file").length,
  directoryCount: entries.filter((entry) => entry.type === "directory").length,
  totalBytes: entries.reduce((total, entry) => total + entry.size, 0)
});

const validateTreeManifest = (value: unknown): WindowsStoreDataTreeManifest => {
  if (!isRecord(value) || !hasExactKeys(value, manifestKeys) || !Array.isArray(value.entries)) {
    throw new Error("Windows Store data transition tree manifest is invalid");
  }
  const entries = value.entries.map((entry) => {
    if (
      !isRecord(entry)
      || !hasExactKeys(entry, manifestEntryKeys)
      || typeof entry.relativePath !== "string"
      || !entry.relativePath
      || entry.relativePath.startsWith("/")
      || entry.relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..")
      || (entry.type !== "directory" && entry.type !== "file")
      || typeof entry.size !== "number"
      || !Number.isSafeInteger(entry.size)
      || entry.size < 0
      || (entry.type === "directory" && (entry.size !== 0 || entry.sha256 !== null))
      || (entry.type === "file" && (
        typeof entry.sha256 !== "string"
        || !/^[0-9a-f]{64}$/u.test(entry.sha256)
      ))
    ) {
      throw new Error("Windows Store data transition tree manifest entry is invalid");
    }
    return {
      relativePath: entry.relativePath,
      type: entry.type as WindowsStoreDataTreeEntry["type"],
      size: entry.size,
      sha256: entry.sha256 as string | null
    };
  });
  const expected = createTreeManifest(entries);
  if (
    value.fileCount !== expected.fileCount
    || value.directoryCount !== expected.directoryCount
    || value.totalBytes !== expected.totalBytes
    || new Set(entries.map((entry) => entry.relativePath.toLowerCase())).size !== entries.length
  ) {
    throw new Error("Windows Store data transition tree manifest totals are invalid");
  }
  return expected;
};

const sameTreeManifest = (
  left: WindowsStoreDataTreeManifest,
  right: WindowsStoreDataTreeManifest
): boolean => JSON.stringify(left) === JSON.stringify(right);

const readFileSha256 = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
};

const assertCopyRootsDoNotOverlap = (copies: WindowsStoreDataCopyPlan[]): void => {
  const roots = copies.flatMap((copy) => [
    copy.sourcePath,
    copy.destinationPath,
    copy.stagingPath,
    copy.backupPath,
    copy.recoveryPath
  ]);
  for (let leftIndex = 0; leftIndex < roots.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < roots.length; rightIndex += 1) {
      const left = roots[leftIndex];
      const right = roots[rightIndex];
      if (left && right && pathsOverlap(left, right)) {
        throw new Error(`Windows Store data transition paths overlap: ${left} and ${right}`);
      }
    }
  }
};

const assertSharedRuntimeDoesNotOverlapCopyRoots = (
  sharedRuntimeHomePath: string,
  copies: WindowsStoreDataCopyPlan[]
): void => {
  for (const root of copies.flatMap((copy) => [
    copy.sourcePath,
    copy.destinationPath,
    copy.stagingPath,
    copy.backupPath,
    copy.recoveryPath
  ])) {
    if (pathsOverlap(sharedRuntimeHomePath, root)) {
      throw new Error(
        `Windows Store data transition shared runtime overlaps a copied or cleaned path: ${sharedRuntimeHomePath} and ${root}`
      );
    }
  }
};

const pathsOverlap = (left: string, right: string): boolean => {
  const leftToRight = win32.relative(left, right);
  const rightToLeft = win32.relative(right, left);
  return !leftToRight
    || (!leftToRight.startsWith(`..${win32.sep}`) && leftToRight !== ".." && !win32.isAbsolute(leftToRight))
    || (!rightToLeft.startsWith(`..${win32.sep}`) && rightToLeft !== ".." && !win32.isAbsolute(rightToLeft));
};

const normalizeTransactionId = (value: string): string => {
  if (typeof value !== "string") {
    throw new Error("Windows Store data transition transaction ID is invalid");
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(normalized)) {
    throw new Error("Windows Store data transition transaction ID is invalid");
  }
  return normalized;
};

const normalizeDirectoryPath = (value: string, label: string): string => {
  if (typeof value !== "string" || value !== value.trim() || !win32.isAbsolute(value)) {
    throw new Error(`Windows Store data transition ${label} path must be absolute`);
  }
  const normalized = win32.normalize(value);
  if (normalized !== value || normalized === win32.parse(normalized).root) {
    throw new Error(`Windows Store data transition ${label} path must be canonical and not a drive root`);
  }
  return normalized;
};

const sameWindowsPath = (left: string, right: string): boolean =>
  win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();

const normalizePreparedStatePath = (value: string): string => {
  if (typeof value !== "string" || value !== value.trim() || !isAbsolute(value)) {
    throw new Error("Windows Store prepared data transition state path must be absolute");
  }
  return value;
};

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
