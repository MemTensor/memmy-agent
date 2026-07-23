/** App state store module. */
import type { DatabaseSync } from "node:sqlite";
import { createAgentSourceRepository, type AgentSourceRepository } from "../agent-source-store/index.js";
import { createIdempotencyStore, type IdempotencyStore } from "../idempotency-store/index.js";
import { getActiveAccountUuid } from "./account-context.js";
import { openDatabase, resolveDefaultDatabasePath } from "./db.js";
import { createFilesystemLocalDataStore, type LocalDataStore } from "./local-data-store.js";
import { captureLegacyAppState } from "./legacy-state-migration.js";
import { runMigrations } from "./migration-runner.js";
import { createAccountSessionRepository, type AccountSessionRepository } from "./repositories/account-session-repo.js";
import { createBootstrapRepository, type BootstrapRepository } from "./repositories/bootstrap-repo.js";
import { createByokTokenUsageRepository, type ByokTokenUsageRepository } from "./repositories/byok-token-usage-repo.js";
import { createComposioMachineTokenRepository, type ComposioMachineTokenRepository } from "./repositories/composio-machine-token-repo.js";
import { createModelConfigRepository, type ModelConfigRepository } from "./repositories/model-config-repo.js";
import { finalizeDatabaseDesign } from "./schema-finalizer.js";
import { createSqliteSecretStore, type SecretStore } from "./secret-store.js";

export { resolveDefaultDatabasePath, runMigrations };
export { createSqliteSecretStore };
export type { SecretStore };

export interface CreateAppStateStoreOptions {
  /** Database path. */
  databasePath?: string;
  /** Migrate on open. */
  migrateOnOpen?: boolean;
}

export interface AppStateStore {
  /** Database path. */
  databasePath: string;
  /** Db. */
  db: DatabaseSync;
  /** Repositories. */
  repositories: {
    /** Bootstrap. */
    bootstrap: BootstrapRepository;
    /** Model config. */
    modelConfig: ModelConfigRepository;
    /** Account session. */
    accountSession: AccountSessionRepository;
    /** Agent sources. */
    agentSources: AgentSourceRepository;
    /** Idempotency. */
    idempotency: IdempotencyStore;
    /** Composio machine token. */
    composioMachineToken: ComposioMachineTokenRepository;
    /** Byok token usage. */
    byokTokenUsage: ByokTokenUsageRepository;
  };
  /** Secret store. */
  secretStore: SecretStore;
  /** Local data store. */
  localDataStore: LocalDataStore;
  /** Closes close. */
  close(): void;
}

/** Creates create app state store. */
export function createAppStateStore(options: CreateAppStateStoreOptions = {}): AppStateStore {
  const databasePath = options.databasePath ?? resolveDefaultDatabasePath();
  const db = openDatabase({ databasePath });
  const legacyState = options.migrateOnOpen !== false ? captureLegacyAppState(db) : null;

  if (options.migrateOnOpen !== false) {
    runMigrations(db);
    ensureDefaultAppStateRows(db);
  }
  const secretStore = createSqliteSecretStore(db);
  finalizeDatabaseDesign(db, legacyState);
  const localDataStore = createFilesystemLocalDataStore({ databasePath, db, secretStore });
  const getActiveUuid = () => getActiveAccountUuid(db);

  return {
    databasePath,
    db,
    repositories: {
      bootstrap: createBootstrapRepository(db),
      modelConfig: createModelConfigRepository(db, secretStore),
      accountSession: createAccountSessionRepository(db, secretStore),
      agentSources: createAgentSourceRepository(db),
      idempotency: createIdempotencyStore(db, { getActiveUuid }),
      composioMachineToken: createComposioMachineTokenRepository(secretStore),
      byokTokenUsage: createByokTokenUsageRepository(db)
    },
    secretStore,
    localDataStore,
    close() {
      db.close();
    }
  };
}

/** Validates ensure default app state rows. */
function ensureDefaultAppStateRows(db: DatabaseSync): void {
  const nowExpression = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

  db.exec(`
    INSERT OR IGNORE INTO app_settings (id, created_at, updated_at)
    VALUES ('default', ${nowExpression}, ${nowExpression});
  `);
}
