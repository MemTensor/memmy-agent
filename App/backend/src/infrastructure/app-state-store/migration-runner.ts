import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

/** Contract for migration result. */
export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

const MIGRATION_ALIASES: Record<string, readonly string[]> = {
  "0015-asr-model-config.sql": ["0015-asr-config.sql"]
};

export function runMigrations(
  db: DatabaseSync,
  migrationsDirOrDirs: string | readonly string[] = resolveMigrationDirs()
): MigrationResult {
  ensureMigrationsTable(db);

  const migrationFiles = toMigrationDirs(migrationsDirOrDirs)
    .flatMap((migrationsDir) =>
      readdirSync(migrationsDir)
        .filter((file) => file.endsWith(".sql"))
        .map((fileName) => ({
          fileName,
          filePath: join(migrationsDir, fileName)
        }))
    )
    .sort((left, right) => left.fileName.localeCompare(right.fileName));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const { fileName, filePath } of migrationFiles) {
    if (normalizeMigrationAlias(db, fileName) || hasMigrationRecord(db, fileName)) {
      skipped.push(fileName);
      continue;
    }

    if (isMigrationSchemaAlreadyConverged(db, fileName)) {
      recordMigrationApplied(db, fileName, new Date().toISOString());
      skipped.push(fileName);
      continue;
    }

    const sql = readFileSync(filePath, "utf8");
    const appliedAt = new Date().toISOString();

    db.exec("BEGIN");
    try {
      db.exec(sql);
      recordMigrationApplied(db, fileName, appliedAt);
      db.exec("COMMIT");
      applied.push(fileName);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return { applied, skipped };
}

/** Checks has migration record. */
function hasMigrationRecord(db: DatabaseSync, fileName: string): boolean {
  return Boolean(db
    .prepare("SELECT name FROM _migrations WHERE name = ?")
    .get(fileName));
}

/** Normalizes normalize migration alias. */
function normalizeMigrationAlias(db: DatabaseSync, fileName: string): boolean {
  const aliases = MIGRATION_ALIASES[fileName] ?? [];
  for (const alias of aliases) {
    if (!hasMigrationRecord(db, alias)) {
      continue;
    }

    db.prepare("UPDATE _migrations SET name = ? WHERE name = ?").run(fileName, alias);
    return true;
  }

  return false;
}

/** Checks is migration schema already converged. */
function isMigrationSchemaAlreadyConverged(db: DatabaseSync, fileName: string): boolean {
  if (fileName === "0015-asr-model-config.sql") {
    return hasColumns(db, "account_model_config", [
      "asr_provider",
      "asr_base_url",
      "asr_model_id",
      "asr_api_key_ref"
    ]) && secretStoreAllowsPurpose(db, "asr_api_key");
  }

  if (fileName === "0018-image-gen-model-config.sql") {
    return hasColumns(db, "account_model_config", [
      "image_provider",
      "image_base_url",
      "image_model_id",
      "image_api_key_ref"
    ]) && secretStoreAllowsPurpose(db, "image_gen_api_key");
  }

  if (fileName === "0020-scan-preferences.sql") {
    return hasColumns(db, "app_settings", [
      "auto_scan_known_agents",
      "watch_file_changes",
      "auto_inject_skill"
    ]);
  }

  return false;
}

/** Handles record migration applied. */
function recordMigrationApplied(db: DatabaseSync, fileName: string, appliedAt: string): void {
  db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(fileName, appliedAt);
}

/** Checks has columns. */
function hasColumns(db: DatabaseSync, tableName: string, columns: readonly string[]): boolean {
  try {
    const existingColumns = new Set(
      (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((column) => column.name)
    );
    return columns.every((column) => existingColumns.has(column));
  } catch {
    return false;
  }
}

/**
 * Determines whether the secret_store constraint already allows the target purpose.
 *
 * @param db the app-state SQLite connection.
 * @param purpose the SecretStore purpose.
 * @returns true when the table definition includes that purpose.
 */
function secretStoreAllowsPurpose(db: DatabaseSync, purpose: string): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'secret_store'")
    .get() as { sql?: string } | undefined;
  return Boolean(row?.sql?.includes(`'${purpose}'`));
}

function ensureMigrationsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
}

function toMigrationDirs(migrationsDirOrDirs: string | readonly string[]): readonly string[] {
  return typeof migrationsDirOrDirs === "string" ? [migrationsDirOrDirs] : migrationsDirOrDirs;
}

function resolveMigrationDirs(): readonly string[] {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return [
    join(currentDir, "migrations"),
    resolve(currentDir, "../agent-source-store/migrations"),
    resolve(currentDir, "../idempotency-store/migrations")
  ];
}
