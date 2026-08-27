import type { RuntimeConfigLockHandle } from "./runtime-config-lock.js";

export type MigrationScope = "agent-workspace" | "runtime-config" | "session-dag";
export type MigrationTargetName =
  | "agentWorkspace"
  | "runtimeConfigFile"
  | "sessionDagDir"
  | "appDatabaseFile";

export type MigrationLoggerFields = Record<string, string | number>;

export type MigrationLogger = {
  info(event: string, fields?: MigrationLoggerFields): void;
  warn(event: string, fields?: MigrationLoggerFields): void;
  error(event: string, fields?: MigrationLoggerFields): void;
};

export type MigrationResult = {
  scanned: number;
  changed: number;
  ignored: number;
  deferred?: boolean;
};

export type AgentWorkspaceMigrationContext = {
  profileWorkspace: string;
  sessionsDir: string;
  runtimeConfigFile: string;
  sessionDagDir: string;
  appDatabaseFile?: string;
  runtimeConfigLock?: RuntimeConfigLockHandle;
  logger: MigrationLogger;
};

export type MigrationDefinition = {
  id: string;
  introducedIn: string;
  scope: MigrationScope;
  description: string;
  requiredTargets?: readonly MigrationTargetName[];
  up(context: AgentWorkspaceMigrationContext): Promise<MigrationResult>;
};

export type MigrationErrorCode =
  | "migration_definition_invalid"
  | "migration_target_unavailable"
  | "migration_lock_timeout"
  | "migration_lock_reentrant"
  | "migration_state_invalid"
  | "migration_config_invalid"
  | "migration_source_changed"
  | "migration_io_failed";

export class MigrationError extends Error {
  readonly code: MigrationErrorCode;
  readonly migrationId: string | null;
  readonly scope: MigrationScope;
  override readonly cause: unknown;

  constructor(
    code: MigrationErrorCode,
    message: string,
    options: {
      migrationId?: string | null;
      scope?: MigrationScope;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "MigrationError";
    this.code = code;
    this.migrationId = options.migrationId ?? null;
    this.scope = options.scope ?? "agent-workspace";
    this.cause = options.cause;
  }
}

export type RunMigrationTargets = {
  agentWorkspace: string;
  runtimeConfigFile: string;
  sessionDagDir: string;
  appDatabaseFile?: string;
};

export type RunMigrationsOptions = {
  targets: RunMigrationTargets;
  logger: MigrationLogger;
};

export type AppliedMigrationSummary = {
  id: string;
  introducedIn: string;
  result: MigrationResult;
};

export type RunMigrationsResult = {
  applied: AppliedMigrationSummary[];
  skipped: string[];
  deferred: string[];
  results: MigrationResult;
};
