import { randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import {
  isRuntimeConfigLockHandle,
  withRuntimeConfigWriteLock,
  withRuntimeConfigWriteLockSync,
  type RuntimeConfigLockHandle,
} from "./runtime-config-lock.js";
import { MigrationError } from "./types.js";

const execFileAsync = promisify(execFile);

export type RuntimeConfigDocument = Record<string, unknown>;

export type RuntimeConfigMutationResult<T> = {
  changed: boolean;
  value: T;
  sourceExists: boolean;
};

export type RuntimeConfigMutationOptions = {
  createIfMissing?: boolean;
  beforeCommit?: (configPath: string) => void | Promise<void>;
};

export type RuntimeConfigMutationSyncOptions = {
  createIfMissing?: boolean;
  beforeCommit?: (configPath: string) => void;
};

type CreatingMutationOptions = RuntimeConfigMutationOptions & { createIfMissing?: true };
type ExistingMutationOptions = RuntimeConfigMutationOptions & { createIfMissing: false };
type CreatingMutationSyncOptions = RuntimeConfigMutationSyncOptions & { createIfMissing?: true };
type ExistingMutationSyncOptions = RuntimeConfigMutationSyncOptions & { createIfMissing: false };

type RuntimeConfigSource = {
  source: string;
  stat: BigIntStats | null;
  document: RuntimeConfigDocument;
};

function isObject(value: unknown): value is RuntimeConfigDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configError(message: string, cause?: unknown): MigrationError {
  return new MigrationError("migration_config_invalid", message, {
    scope: "runtime-config",
    cause,
  });
}

function ioError(configPath: string, cause: unknown): MigrationError {
  return new MigrationError(
    "migration_io_failed",
    `Runtime config I/O failed for ${configPath}`,
    { scope: "runtime-config", cause },
  );
}

function sourceChangedError(configPath: string): MigrationError {
  return new MigrationError(
    "migration_source_changed",
    `Runtime config changed while it was being written: ${configPath}`,
    { scope: "runtime-config" },
  );
}

function parseDocument(configPath: string, source: string): RuntimeConfigDocument {
  if (!source.trim()) return {};
  let parsed: unknown;
  try {
    parsed = YAML.parse(source);
  } catch (error) {
    throw configError(`Runtime config is not valid YAML: ${configPath}`, error);
  }
  if (!isObject(parsed)) throw configError("Runtime config root must be an object");
  return parsed;
}

async function readSource(
  configPath: string,
  createIfMissing: boolean,
): Promise<RuntimeConfigSource | null> {
  try {
    const [source, stat] = await Promise.all([
      fs.readFile(configPath, "utf8"),
      fs.lstat(configPath, { bigint: true }),
    ]);
    if (!stat.isFile()) throw configError(`Runtime config is not a regular file: ${configPath}`);
    return { source, stat, document: parseDocument(configPath, source) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return createIfMissing ? { source: "", stat: null, document: {} } : null;
    }
    if (error instanceof MigrationError) throw error;
    throw ioError(configPath, error);
  }
}

function readSourceSync(
  configPath: string,
  createIfMissing: boolean,
): RuntimeConfigSource | null {
  try {
    const source = fsSync.readFileSync(configPath, "utf8");
    const stat = fsSync.lstatSync(configPath, { bigint: true });
    if (!stat.isFile()) throw configError(`Runtime config is not a regular file: ${configPath}`);
    return { source, stat, document: parseDocument(configPath, source) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return createIfMissing ? { source: "", stat: null, document: {} } : null;
    }
    if (error instanceof MigrationError) throw error;
    throw ioError(configPath, error);
  }
}

function sameFingerprint(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

async function assertSourceUnchanged(configPath: string, initial: RuntimeConfigSource): Promise<void> {
  if (!initial.stat) {
    try {
      await fs.lstat(configPath);
      throw sourceChangedError(configPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
  const [source, stat] = await Promise.all([
    fs.readFile(configPath, "utf8"),
    fs.lstat(configPath, { bigint: true }),
  ]);
  if (source !== initial.source || !sameFingerprint(initial.stat, stat)) {
    throw sourceChangedError(configPath);
  }
}

function assertSourceUnchangedSync(configPath: string, initial: RuntimeConfigSource): void {
  if (!initial.stat) {
    if (fsSync.existsSync(configPath)) throw sourceChangedError(configPath);
    return;
  }
  const source = fsSync.readFileSync(configPath, "utf8");
  const stat = fsSync.lstatSync(configPath, { bigint: true });
  if (source !== initial.source || !sameFingerprint(initial.stat, stat)) {
    throw sourceChangedError(configPath);
  }
}

function currentUserSid(source: string): string {
  const match = /,"([A-Za-z0-9-]+)"\s*$/.exec(source.trim());
  if (!match) throw new Error("Unable to determine current Windows user SID");
  return match[1]!;
}

type WindowsAclExecutable = "whoami.exe" | "icacls.exe";

function windowsSystemExecutable(executable: WindowsAclExecutable): string {
  const systemDirectories = [
    process.env.SystemRoot && path.isAbsolute(process.env.SystemRoot)
      ? path.join(process.env.SystemRoot, "System32")
      : null,
    process.env.WINDIR && path.isAbsolute(process.env.WINDIR)
      ? path.join(process.env.WINDIR, "System32")
      : null,
    process.env.ComSpec && path.isAbsolute(process.env.ComSpec)
      ? path.dirname(process.env.ComSpec)
      : null,
  ];
  for (const directory of new Set(systemDirectories)) {
    if (!directory) continue;
    const candidate = path.join(directory, executable);
    if (fsSync.existsSync(candidate)) return candidate;
  }
  throw new Error(`Unable to find Windows system executable: ${executable}`);
}

async function restrictWindowsAcl(filePath: string): Promise<void> {
  if (process.platform !== "win32") return;
  const { stdout } = await execFileAsync(
    windowsSystemExecutable("whoami.exe"),
    ["/user", "/fo", "csv", "/nh"],
    { windowsHide: true },
  );
  const sid = currentUserSid(stdout);
  await execFileAsync(
    windowsSystemExecutable("icacls.exe"),
    [filePath, "/inheritance:r", "/grant:r", `*${sid}:(F)`, "*S-1-5-18:(F)"],
    { windowsHide: true },
  );
}

function restrictWindowsAclSync(filePath: string): void {
  if (process.platform !== "win32") return;
  const stdout = execFileSync(
    windowsSystemExecutable("whoami.exe"),
    ["/user", "/fo", "csv", "/nh"],
    { encoding: "utf8", windowsHide: true },
  );
  const sid = currentUserSid(stdout);
  execFileSync(
    windowsSystemExecutable("icacls.exe"),
    [filePath, "/inheritance:r", "/grant:r", `*${sid}:(F)`, "*S-1-5-18:(F)"],
    { stdio: "ignore", windowsHide: true },
  );
}

async function fsyncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function fsyncDirectorySync(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = fsSync.openSync(directory, fsConstants.O_RDONLY);
  try {
    fsSync.fsyncSync(descriptor);
  } finally {
    fsSync.closeSync(descriptor);
  }
}

async function commit(
  configPath: string,
  initial: RuntimeConfigSource,
  document: RuntimeConfigDocument,
  options: RuntimeConfigMutationOptions,
): Promise<void> {
  const directory = path.dirname(configPath);
  const tempPath = path.join(
    directory,
    `.${path.basename(configPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle = null;
  try {
    handle = await fs.open(
      tempPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(YAML.stringify(document, { lineWidth: 0 }), "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await restrictWindowsAcl(tempPath);
    await options.beforeCommit?.(configPath);
    await assertSourceUnchanged(configPath, initial);
    await fs.rename(tempPath, configPath);
    if (process.platform !== "win32") await fs.chmod(configPath, 0o600);
    await fsyncDirectory(directory);
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw ioError(configPath, error);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(tempPath).catch(() => undefined);
  }
}

function commitSync(
  configPath: string,
  initial: RuntimeConfigSource,
  document: RuntimeConfigDocument,
  options: RuntimeConfigMutationSyncOptions,
): void {
  const directory = path.dirname(configPath);
  const tempPath = path.join(
    directory,
    `.${path.basename(configPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | null = null;
  try {
    descriptor = fsSync.openSync(
      tempPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    fsSync.writeFileSync(descriptor, YAML.stringify(document, { lineWidth: 0 }), "utf8");
    fsSync.fsyncSync(descriptor);
    fsSync.closeSync(descriptor);
    descriptor = null;
    restrictWindowsAclSync(tempPath);
    options.beforeCommit?.(configPath);
    assertSourceUnchangedSync(configPath, initial);
    fsSync.renameSync(tempPath, configPath);
    if (process.platform !== "win32") fsSync.chmodSync(configPath, 0o600);
    fsyncDirectorySync(directory);
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw ioError(configPath, error);
  } finally {
    if (descriptor !== null) {
      try {
        fsSync.closeSync(descriptor);
      } catch {
        // Preserve the primary write failure.
      }
    }
    try {
      fsSync.unlinkSync(tempPath);
    } catch {
      // The temp file was renamed or never created.
    }
  }
}

export function mutateRuntimeConfigLockHeld<T>(
  lock: RuntimeConfigLockHandle,
  mutator: (config: RuntimeConfigDocument) => T | Promise<T>,
  options?: CreatingMutationOptions,
): Promise<RuntimeConfigMutationResult<T>>;
export function mutateRuntimeConfigLockHeld<T>(
  lock: RuntimeConfigLockHandle,
  mutator: (config: RuntimeConfigDocument) => T | Promise<T>,
  options: ExistingMutationOptions,
): Promise<RuntimeConfigMutationResult<T | undefined>>;
export async function mutateRuntimeConfigLockHeld<T>(
  lock: RuntimeConfigLockHandle,
  mutator: (config: RuntimeConfigDocument) => T | Promise<T>,
  options: RuntimeConfigMutationOptions = {},
): Promise<RuntimeConfigMutationResult<T | undefined>> {
  if (!isRuntimeConfigLockHandle(lock)) throw configError("Runtime config lock handle is invalid");
  const initial = await readSource(lock.configPath, options.createIfMissing ?? true);
  if (!initial) return { changed: false, value: undefined, sourceExists: false };
  const before = structuredClone(initial.document);
  const value = await mutator(initial.document);
  const changed = !isDeepStrictEqual(before, initial.document);
  if (changed) await commit(lock.configPath, initial, initial.document, options);
  return { changed, value, sourceExists: true };
}

export function mutateRuntimeConfigLockHeldSync<T>(
  lock: RuntimeConfigLockHandle,
  mutator: (config: RuntimeConfigDocument) => T,
  options?: CreatingMutationSyncOptions,
): RuntimeConfigMutationResult<T>;
export function mutateRuntimeConfigLockHeldSync<T>(
  lock: RuntimeConfigLockHandle,
  mutator: (config: RuntimeConfigDocument) => T,
  options: ExistingMutationSyncOptions,
): RuntimeConfigMutationResult<T | undefined>;
export function mutateRuntimeConfigLockHeldSync<T>(
  lock: RuntimeConfigLockHandle,
  mutator: (config: RuntimeConfigDocument) => T,
  options: RuntimeConfigMutationSyncOptions = {},
): RuntimeConfigMutationResult<T | undefined> {
  if (!isRuntimeConfigLockHandle(lock)) throw configError("Runtime config lock handle is invalid");
  const initial = readSourceSync(lock.configPath, options.createIfMissing ?? true);
  if (!initial) return { changed: false, value: undefined, sourceExists: false };
  const before = structuredClone(initial.document);
  const value = mutator(initial.document);
  const changed = !isDeepStrictEqual(before, initial.document);
  if (changed) commitSync(lock.configPath, initial, initial.document, options);
  return { changed, value, sourceExists: true };
}

export function mutateRuntimeConfig<T>(
  configPath: string,
  mutator: (config: RuntimeConfigDocument) => T | Promise<T>,
  options?: CreatingMutationOptions,
): Promise<RuntimeConfigMutationResult<T>>;
export function mutateRuntimeConfig<T>(
  configPath: string,
  mutator: (config: RuntimeConfigDocument) => T | Promise<T>,
  options: ExistingMutationOptions,
): Promise<RuntimeConfigMutationResult<T | undefined>>;
export function mutateRuntimeConfig<T>(
  configPath: string,
  mutator: (config: RuntimeConfigDocument) => T | Promise<T>,
  options: RuntimeConfigMutationOptions = {},
): Promise<RuntimeConfigMutationResult<T | undefined>> {
  if (options.createIfMissing === false) {
    return withRuntimeConfigWriteLock(configPath, (lock) =>
      mutateRuntimeConfigLockHeld(lock, mutator, {
        ...options,
        createIfMissing: false,
      }),
    );
  }
  return withRuntimeConfigWriteLock(configPath, (lock) =>
    mutateRuntimeConfigLockHeld(lock, mutator, {
      ...options,
      createIfMissing: true,
    }),
  );
}

export function mutateRuntimeConfigSync<T>(
  configPath: string,
  mutator: (config: RuntimeConfigDocument) => T,
  options?: CreatingMutationSyncOptions,
): RuntimeConfigMutationResult<T>;
export function mutateRuntimeConfigSync<T>(
  configPath: string,
  mutator: (config: RuntimeConfigDocument) => T,
  options: ExistingMutationSyncOptions,
): RuntimeConfigMutationResult<T | undefined>;
export function mutateRuntimeConfigSync<T>(
  configPath: string,
  mutator: (config: RuntimeConfigDocument) => T,
  options: RuntimeConfigMutationSyncOptions = {},
): RuntimeConfigMutationResult<T | undefined> {
  if (options.createIfMissing === false) {
    return withRuntimeConfigWriteLockSync(configPath, (lock) =>
      mutateRuntimeConfigLockHeldSync(lock, mutator, {
        ...options,
        createIfMissing: false,
      }),
    );
  }
  return withRuntimeConfigWriteLockSync(configPath, (lock) =>
    mutateRuntimeConfigLockHeldSync(lock, mutator, {
      ...options,
      createIfMissing: true,
    }),
  );
}
