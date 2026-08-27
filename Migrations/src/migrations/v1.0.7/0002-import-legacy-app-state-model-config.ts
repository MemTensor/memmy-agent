import fs from "node:fs/promises";
import {
  mutateRuntimeConfig,
  mutateRuntimeConfigLockHeld,
  type RuntimeConfigDocument,
} from "../../runtime-config-writer.js";
import { MigrationError, type AgentWorkspaceMigrationContext, type MigrationDefinition, type MigrationResult } from "../../types.js";
import {
  hasAnyValidByokAssignment,
  hasCompleteByokCatalog,
  mergeLegacyByokCatalog,
} from "./0001-normalize-runtime-model-catalog.js";
import { readLegacyAppStateModelConfig } from "./legacy-app-state-model-config-source.js";

const MIGRATION_ID = "v1.0.7/0002-import-legacy-app-state-model-config";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableImportError(error: unknown): MigrationError {
  if (error instanceof MigrationError) return error;
  const code = isObject(error) && error.code === "legacy_byok_secret_unavailable"
    ? "migration_config_invalid" as const
    : "migration_io_failed" as const;
  const message = code === "migration_config_invalid"
    ? "Legacy BYOK credentials could not be imported"
    : "Legacy app-state model config could not be read";
  return new MigrationError(code, message, {
    migrationId: MIGRATION_ID,
    scope: "runtime-config",
    cause: error,
  });
}

async function databaseExists(databaseFile: string): Promise<boolean> {
  try {
    const stat = await fs.stat(databaseFile);
    return stat.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw stableImportError(error);
  }
}

async function migrate(context: AgentWorkspaceMigrationContext): Promise<MigrationResult> {
  const databaseFile = context.appDatabaseFile;
  if (!databaseFile || !(await databaseExists(databaseFile))) {
    return { scanned: 0, changed: 0, ignored: 0, deferred: true };
  }
  try {
    let sourceScanned = false;
    const mutator = (config: RuntimeConfigDocument): void => {
      if (hasAnyValidByokAssignment(config)) return;
      sourceScanned = true;
      const source = readLegacyAppStateModelConfig(databaseFile);
      if (source.status === "found") {
        mergeLegacyByokCatalog(config, source.catalog);
        const app = isObject(config.app) ? config.app : {};
        if (hasCompleteByokCatalog(config)) app.modelCatalogVersion = 1;
        config.app = app;
      }
    };
    const result = context.runtimeConfigLock
      ? await mutateRuntimeConfigLockHeld(context.runtimeConfigLock, mutator)
      : await mutateRuntimeConfig(context.runtimeConfigFile, mutator);
    return result.changed
      ? { scanned: 1, changed: 1, ignored: 0 }
      : { scanned: sourceScanned ? 1 : 0, changed: 0, ignored: 1 };
  } catch (error) {
    throw stableImportError(error);
  }
}

export const importLegacyAppStateModelConfigV107: MigrationDefinition = {
  id: MIGRATION_ID,
  introducedIn: "1.0.7",
  scope: "runtime-config",
  description: "Import the selected legacy local BYOK model config from app state",
  requiredTargets: ["appDatabaseFile"],
  up: migrate,
};

export function importLegacyAppStateModelConfigForTest(
  context: AgentWorkspaceMigrationContext,
): Promise<MigrationResult> {
  return migrate(context);
}
