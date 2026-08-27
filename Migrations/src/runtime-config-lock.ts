import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import * as lockfile from "proper-lockfile";
import { MigrationError } from "./types.js";

export type RuntimeConfigLockOptions = {
  stale: number;
  update: number;
  retries: number;
  retryDelay: number;
};

const runtimeConfigLockBrand: unique symbol = Symbol("runtime-config-lock");

export type RuntimeConfigLockHandle = {
  readonly configPath: string;
  readonly [runtimeConfigLockBrand]: true;
};

const asyncLocks = new AsyncLocalStorage<ReadonlySet<string>>();
const syncLocks = new Set<string>();

const DEFAULT_LOCK_OPTIONS: RuntimeConfigLockOptions = {
  stale: 120_000,
  update: 10_000,
  retries: 50,
  retryDelay: 100,
};

function isLockContention(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ELOCKED"
  );
}

function lockTimeoutError(configPath: string, cause: unknown): MigrationError {
  return new MigrationError(
    "migration_lock_timeout",
    `Timed out waiting for the runtime config lock: ${configPath}`,
    { scope: "runtime-config", cause },
  );
}

function lockIoError(configPath: string, cause: unknown): MigrationError {
  return new MigrationError(
    "migration_io_failed",
    `Runtime config lock failed for ${configPath}`,
    { scope: "runtime-config", cause },
  );
}

function reentrantLockError(configPath: string): MigrationError {
  return new MigrationError(
    "migration_lock_reentrant",
    `Runtime config lock is already held: ${configPath}`,
    { scope: "runtime-config" },
  );
}

function lockHandle(configPath: string): RuntimeConfigLockHandle {
  return { configPath, [runtimeConfigLockBrand]: true };
}

export function isRuntimeConfigLockHandle(value: unknown): value is RuntimeConfigLockHandle {
  return Boolean(
    value &&
      typeof value === "object" &&
      runtimeConfigLockBrand in value &&
      (value as RuntimeConfigLockHandle)[runtimeConfigLockBrand] === true,
  );
}

async function withRuntimeConfigWriteLockInternal<T>(
  configPath: string,
  operation: (lock: RuntimeConfigLockHandle) => Promise<T>,
  options: RuntimeConfigLockOptions,
): Promise<T> {
  const normalizedPath = path.normalize(path.resolve(configPath));
  if (asyncLocks.getStore()?.has(normalizedPath) || syncLocks.has(normalizedPath)) {
    throw reentrantLockError(normalizedPath);
  }
  try {
    await fs.mkdir(path.dirname(normalizedPath), { recursive: true });
  } catch (error) {
    throw lockIoError(normalizedPath, error);
  }

  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(normalizedPath, {
      realpath: false,
      stale: options.stale,
      update: options.update,
      retries: {
        retries: options.retries,
        factor: 1,
        minTimeout: options.retryDelay,
        maxTimeout: options.retryDelay,
        randomize: false,
      },
    });
  } catch (error) {
    if (isLockContention(error)) throw lockTimeoutError(normalizedPath, error);
    throw lockIoError(normalizedPath, error);
  }

  let operationError: unknown = null;
  try {
    const held = new Set(asyncLocks.getStore() ?? []);
    held.add(normalizedPath);
    return await asyncLocks.run(held, () => operation(lockHandle(normalizedPath)));
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await release();
    } catch (error) {
      if (operationError === null) throw lockIoError(normalizedPath, error);
    }
  }
}

export function withRuntimeConfigWriteLock<T>(
  configPath: string,
  operation: (lock: RuntimeConfigLockHandle) => Promise<T>,
): Promise<T> {
  return withRuntimeConfigWriteLockInternal(configPath, operation, DEFAULT_LOCK_OPTIONS);
}

export function withRuntimeConfigWriteLockForTest<T>(
  configPath: string,
  operation: (lock: RuntimeConfigLockHandle) => Promise<T>,
  options: Partial<RuntimeConfigLockOptions>,
): Promise<T> {
  return withRuntimeConfigWriteLockInternal(configPath, operation, {
    ...DEFAULT_LOCK_OPTIONS,
    ...options,
  });
}

function withRuntimeConfigWriteLockSyncInternal<T>(
  configPath: string,
  operation: (lock: RuntimeConfigLockHandle) => T,
  options: RuntimeConfigLockOptions,
): T {
  const normalizedPath = path.normalize(path.resolve(configPath));
  if (asyncLocks.getStore()?.has(normalizedPath) || syncLocks.has(normalizedPath)) {
    throw reentrantLockError(normalizedPath);
  }
  try {
    fsSync.mkdirSync(path.dirname(normalizedPath), { recursive: true });
  } catch (error) {
    throw lockIoError(normalizedPath, error);
  }

  let release: (() => void) | null = null;
  try {
    release = lockfile.lockSync(normalizedPath, {
      realpath: false,
      stale: options.stale,
      update: options.update,
    });
  } catch (error) {
    if (isLockContention(error)) throw lockTimeoutError(normalizedPath, error);
    throw lockIoError(normalizedPath, error);
  }

  let operationError: unknown = null;
  syncLocks.add(normalizedPath);
  try {
    return operation(lockHandle(normalizedPath));
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    syncLocks.delete(normalizedPath);
    try {
      release?.();
    } catch (error) {
      if (operationError === null) throw lockIoError(normalizedPath, error);
    }
  }
}

export function withRuntimeConfigWriteLockSync<T>(
  configPath: string,
  operation: (lock: RuntimeConfigLockHandle) => T,
): T {
  return withRuntimeConfigWriteLockSyncInternal(configPath, operation, DEFAULT_LOCK_OPTIONS);
}

export function withRuntimeConfigWriteLockSyncForTest<T>(
  configPath: string,
  operation: (lock: RuntimeConfigLockHandle) => T,
  options: Partial<RuntimeConfigLockOptions>,
): T {
  return withRuntimeConfigWriteLockSyncInternal(configPath, operation, {
    ...DEFAULT_LOCK_OPTIONS,
    ...options,
  });
}
