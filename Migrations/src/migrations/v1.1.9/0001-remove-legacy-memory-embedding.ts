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

const MIGRATION_ID = "v1.1.9/0001-remove-legacy-memory-embedding";

function isObject(value: unknown): value is RuntimeConfigDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function removeLegacyEmbedding(config: RuntimeConfigDocument): void {
  // Memory setup used to write this field after the model-catalog migration
  // had already recorded its completion, so it needs a follow-up cleanup.
  const memory = isObject(config.memmyMemory) ? config.memmyMemory : null;
  if (memory) delete memory.embedding;
}

function wrapError(error: unknown): never {
  if (error instanceof MigrationError) {
    throw new MigrationError(error.code, error.message, {
      migrationId: MIGRATION_ID,
      scope: "runtime-config",
      cause: error.cause,
    });
  }
  throw new MigrationError(
    "migration_config_invalid",
    "Unable to remove the legacy memory embedding configuration",
    {
      migrationId: MIGRATION_ID,
      scope: "runtime-config",
      cause: error,
    },
  );
}

async function runMigration(
  context: AgentWorkspaceMigrationContext,
): Promise<MigrationResult> {
  try {
    const options = { createIfMissing: false as const };
    const result = context.runtimeConfigLock
      ? await mutateRuntimeConfigLockHeld(context.runtimeConfigLock, removeLegacyEmbedding, options)
      : await mutateRuntimeConfig(context.runtimeConfigFile, removeLegacyEmbedding, options);
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

export const removeLegacyMemoryEmbeddingV119: MigrationDefinition = {
  id: MIGRATION_ID,
  introducedIn: "1.1.9",
  scope: "runtime-config",
  description: "Remove the legacy memmyMemory.embedding runtime configuration",
  up: runMigration,
};

export function removeLegacyMemoryEmbeddingForTest(
  context: AgentWorkspaceMigrationContext,
): Promise<MigrationResult> {
  return runMigration(context);
}
