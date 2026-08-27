import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import * as lockfile from "proper-lockfile";
import { migrations, validateMigrationRegistry } from "./registry.js";
import {
  getMigrationStatePaths,
  isMigrationApplied,
  migrationTargetFor,
  readMigrationState,
  writeMigrationState,
} from "./state-store.js";
import {
  withRuntimeConfigWriteLock,
  type RuntimeConfigLockHandle,
} from "./runtime-config-lock.js";
import {
  MigrationError,
  type MigrationDefinition,
  type MigrationResult,
  type RunMigrationsOptions,
  type RunMigrationsResult,
} from "./types.js";

type RunnerInternals = {
  definitions?: readonly MigrationDefinition[];
  lock?: {
    stale: number;
    update: number;
    retries: number;
    retryDelay: number;
  };
  now?: () => Date;
};

const DEFAULT_LOCK = {
  stale: 120_000,
  update: 10_000,
  retries: 100,
  retryDelay: 100,
} as const;

function targetError(cause: unknown): MigrationError {
  return new MigrationError(
    "migration_target_unavailable",
    "Agent workspace migration target is unavailable",
    { cause },
  );
}

function ioError(
  filePath: string,
  cause: unknown,
  migrationId: string | null = null,
  scope: MigrationDefinition["scope"] = "agent-workspace",
): MigrationError {
  return new MigrationError("migration_io_failed", `Migration I/O failed for ${filePath}`, {
    migrationId,
    scope,
    cause,
  });
}

function lockTimeoutError(cause: unknown): MigrationError {
  return new MigrationError(
    "migration_lock_timeout",
    "Timed out waiting for the agent workspace migration lock",
    { cause },
  );
}

async function resolveTarget(target: string): Promise<string> {
  try {
    const resolved = path.resolve(target);
    const canonical = await fs.realpath(resolved);
    const stat = await fs.stat(canonical);
    if (!stat.isDirectory()) throw new Error("Migration target is not a directory");
    await fs.access(
      canonical,
      fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK,
    );
    return canonical;
  } catch (error) {
    throw targetError(error);
  }
}

function resolveRuntimeConfigTarget(target: string): string {
  if (typeof target !== "string" || !target.trim()) {
    throw new MigrationError(
      "migration_target_unavailable",
      "Runtime config migration target is unavailable",
      { scope: "runtime-config" },
    );
  }
  return path.normalize(path.resolve(target));
}

function resolveSessionDagTarget(target: string): string {
  if (typeof target !== "string" || !target.trim()) {
    throw new MigrationError(
      "migration_target_unavailable",
      "Session DAG migration target is unavailable",
      { scope: "session-dag" },
    );
  }
  return path.normalize(path.resolve(target));
}

function resolveOptionalFileTarget(target: string | undefined): string | undefined {
  if (target === undefined) return undefined;
  if (typeof target !== "string" || !target.trim()) {
    throw new MigrationError(
      "migration_target_unavailable",
      "App database migration target is unavailable",
      { scope: "runtime-config" },
    );
  }
  return path.normalize(path.resolve(target));
}

function hasRequiredTargets(
  definition: MigrationDefinition,
  targets: RunMigrationsOptions["targets"],
): boolean {
  return (definition.requiredTargets ?? []).every((target) => Boolean(targets[target]));
}

function isLockContention(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ELOCKED"
  );
}

function totalResults(
  results: RunMigrationsResult["applied"],
): MigrationResult {
  return results.reduce<MigrationResult>(
    (total, item) => ({
      scanned: total.scanned + item.result.scanned,
      changed: total.changed + item.result.changed,
      ignored: total.ignored + item.result.ignored,
    }),
    { scanned: 0, changed: 0, ignored: 0 },
  );
}

async function runMigrationsInternal(
  options: RunMigrationsOptions,
  internals: RunnerInternals = {},
): Promise<RunMigrationsResult> {
  const definitions = internals.definitions ?? migrations;
  validateMigrationRegistry(definitions);

  const profileWorkspace = await resolveTarget(options.targets.agentWorkspace);
  const runtimeConfigFile = resolveRuntimeConfigTarget(options.targets.runtimeConfigFile);
  const sessionDagDir = resolveSessionDagTarget(options.targets.sessionDagDir);
  const appDatabaseFile = resolveOptionalFileTarget(options.targets.appDatabaseFile);
  const resolvedTargets = {
    agentWorkspace: profileWorkspace,
    runtimeConfigFile,
    sessionDagDir,
    ...(appDatabaseFile ? { appDatabaseFile } : {}),
  };
  const statePaths = getMigrationStatePaths(profileWorkspace);
  try {
    await fs.mkdir(statePaths.directory, { recursive: true });
  } catch (error) {
    throw ioError(statePaths.directory, error);
  }

  const lockOptions = internals.lock ?? DEFAULT_LOCK;
  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(statePaths.directory, {
      realpath: false,
      stale: lockOptions.stale,
      update: lockOptions.update,
      retries: {
        retries: lockOptions.retries,
        factor: 1,
        minTimeout: lockOptions.retryDelay,
        maxTimeout: lockOptions.retryDelay,
        randomize: false,
      },
    });
  } catch (error) {
    if (isLockContention(error)) throw lockTimeoutError(error);
    throw ioError(statePaths.directory, error);
  }

  let executionError: unknown = null;
  try {
    const state = await readMigrationState(statePaths.file, definitions);
    const skipped = definitions
      .filter((definition) =>
        isMigrationApplied(state, definition, runtimeConfigFile, sessionDagDir, appDatabaseFile),
      )
      .map((definition) => definition.id);
    const applied: RunMigrationsResult["applied"] = [];
    const deferred: string[] = [];

    for (const definition of definitions) {
      if (
        isMigrationApplied(state, definition, runtimeConfigFile, sessionDagDir, appDatabaseFile)
      ) continue;
      if (!hasRequiredTargets(definition, resolvedTargets)) {
        deferred.push(definition.id);
        options.logger.info("migration_deferred", {
          migrationId: definition.id,
          scope: definition.scope,
        });
        continue;
      }
      options.logger.info("migration_started", {
        migrationId: definition.id,
        scope: definition.scope,
      });

      let result: MigrationResult;
      try {
        const run = (runtimeConfigLock?: RuntimeConfigLockHandle) => definition.up({
          profileWorkspace,
          sessionsDir: path.join(profileWorkspace, "sessions"),
          runtimeConfigFile,
          sessionDagDir,
          ...(appDatabaseFile ? { appDatabaseFile } : {}),
          ...(runtimeConfigLock ? { runtimeConfigLock } : {}),
          logger: options.logger,
        });
        result = definition.scope === "runtime-config"
          ? await withRuntimeConfigWriteLock(runtimeConfigFile, (lock) => run(lock))
          : await run();
      } catch (error) {
        const migrationError =
          error instanceof MigrationError
            ? error
            : ioError(
                definition.scope === "runtime-config"
                  ? runtimeConfigFile
                  : definition.scope === "session-dag"
                    ? sessionDagDir
                    : profileWorkspace,
                error,
                definition.id,
                definition.scope,
              );
        options.logger.error("migration_failed", {
          migrationId: definition.id,
          scope: definition.scope,
          errorCode: migrationError.code,
        });
        throw migrationError;
      }

      if (result.deferred) {
        deferred.push(definition.id);
        options.logger.info("migration_deferred", {
          migrationId: definition.id,
          scope: definition.scope,
        });
        continue;
      }

      state.applied.push({
        id: definition.id,
        introducedIn: definition.introducedIn,
        appliedAt: (internals.now ?? (() => new Date()))().toISOString(),
        target: migrationTargetFor(
          definition,
          runtimeConfigFile,
          sessionDagDir,
          appDatabaseFile,
        ),
      });
      await writeMigrationState(statePaths, state, definition.id);
      applied.push({
        id: definition.id,
        introducedIn: definition.introducedIn,
        result,
      });
      options.logger.info("migration_completed", {
        migrationId: definition.id,
        scope: definition.scope,
        scanned: result.scanned,
        changed: result.changed,
        ignored: result.ignored,
      });
    }

    return {
      applied,
      skipped,
      deferred,
      results: totalResults(applied),
    };
  } catch (error) {
    executionError = error;
    throw error;
  } finally {
    try {
      await release?.();
    } catch (error) {
      if (executionError === null) throw ioError(statePaths.directory, error);
    }
  }
}

export async function runMigrations(
  options: RunMigrationsOptions,
): Promise<RunMigrationsResult> {
  return runMigrationsInternal(options);
}

export async function runMigrationsForTest(
  options: RunMigrationsOptions,
  internals: RunnerInternals,
): Promise<RunMigrationsResult> {
  return runMigrationsInternal(options, internals);
}
