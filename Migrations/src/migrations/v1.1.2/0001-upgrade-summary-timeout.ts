import {
  mutateRuntimeConfig,
  mutateRuntimeConfigLockHeld,
  type RuntimeConfigDocument,
} from "../../runtime-config-writer.js";
import {
  MigrationError,
  type AgentWorkspaceMigrationContext,
  type MigrationDefinition,
  type MigrationResult,
} from "../../types.js";

const MIGRATION_ID = "v1.1.2/0001-upgrade-summary-timeout";
const LEGACY_SUMMARY_TIMEOUT_MS = 45_000;
const SUMMARY_TIMEOUT_MS = 180_000;

function isObject(value: unknown): value is RuntimeConfigDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function upgradeSummaryTimeout(config: RuntimeConfigDocument): void {
  const memory = isObject(config.memmyMemory) ? config.memmyMemory : null;
  const summary = memory && isObject(memory.summary) ? memory.summary : null;
  if (summary?.timeoutMs === LEGACY_SUMMARY_TIMEOUT_MS) {
    summary.timeoutMs = SUMMARY_TIMEOUT_MS;
  }
}

function wrapError(error: unknown): never {
  if (error instanceof MigrationError) {
    throw new MigrationError(error.code, error.message, {
      migrationId: MIGRATION_ID,
      scope: "runtime-config",
      cause: error.cause,
    });
  }
  throw new MigrationError("migration_config_invalid", "Unable to upgrade the memory summary timeout", {
    migrationId: MIGRATION_ID,
    scope: "runtime-config",
    cause: error,
  });
}

async function runSummaryTimeoutMigration(
  context: AgentWorkspaceMigrationContext,
): Promise<MigrationResult> {
  try {
    const options = { createIfMissing: false as const };
    const result = context.runtimeConfigLock
      ? await mutateRuntimeConfigLockHeld(context.runtimeConfigLock, upgradeSummaryTimeout, options)
      : await mutateRuntimeConfig(context.runtimeConfigFile, upgradeSummaryTimeout, options);
    if (!result.sourceExists) {
      return { scanned: 0, changed: 0, ignored: 0, deferred: true };
    }
    return result.changed
      ? { scanned: 1, changed: 1, ignored: 0 }
      : { scanned: 1, changed: 0, ignored: 1 };
  } catch (error) {
    wrapError(error);
  }
}

export const upgradeSummaryTimeoutV112: MigrationDefinition = {
  id: MIGRATION_ID,
  introducedIn: "1.1.2",
  scope: "runtime-config",
  description: "Upgrade the legacy 45-second memory summary timeout to 180 seconds",
  up: runSummaryTimeoutMigration,
};
