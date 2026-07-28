export type MigrationScope = "agent-workspace";

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
};

export type AgentWorkspaceMigrationContext = {
  profileWorkspace: string;
  sessionsDir: string;
  logger: MigrationLogger;
};

export type MigrationDefinition = {
  id: string;
  introducedIn: string;
  scope: MigrationScope;
  description: string;
  up(context: AgentWorkspaceMigrationContext): Promise<MigrationResult>;
};

export type MigrationErrorCode =
  | "migration_definition_invalid"
  | "migration_target_unavailable"
  | "migration_lock_timeout"
  | "migration_state_invalid"
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

export type RunMigrationsOptions = {
  targets: {
    agentWorkspace: string;
  };
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
  results: MigrationResult;
};
