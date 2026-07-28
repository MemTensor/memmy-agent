import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import * as lockfile from "proper-lockfile";
import { migrations, validateMigrationRegistry } from "./registry.js";
import {
  getMigrationStatePaths,
  readMigrationState,
  writeMigrationState,
} from "./state-store.js";
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

function ioError(filePath: string, cause: unknown, migrationId: string | null = null): MigrationError {
  return new MigrationError("migration_io_failed", `Migration I/O failed for ${filePath}`, {
    migrationId,
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
    const appliedIds = new Set(state.applied.map((item) => item.id));
    const skipped = definitions
      .filter((definition) => appliedIds.has(definition.id))
      .map((definition) => definition.id);
    const applied: RunMigrationsResult["applied"] = [];

    for (const definition of definitions) {
      if (appliedIds.has(definition.id)) continue;
      options.logger.info("migration_started", {
        migrationId: definition.id,
        scope: definition.scope,
      });

      let result: MigrationResult;
      try {
        result = await definition.up({
          profileWorkspace,
          sessionsDir: path.join(profileWorkspace, "sessions"),
          logger: options.logger,
        });
      } catch (error) {
        const migrationError =
          error instanceof MigrationError
            ? error
            : ioError(profileWorkspace, error, definition.id);
        options.logger.error("migration_failed", {
          migrationId: definition.id,
          scope: definition.scope,
          errorCode: migrationError.code,
        });
        throw migrationError;
      }

      state.applied.push({
        id: definition.id,
        introducedIn: definition.introducedIn,
        appliedAt: (internals.now ?? (() => new Date()))().toISOString(),
      });
      await writeMigrationState(statePaths, state, definition.id);
      appliedIds.add(definition.id);
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
