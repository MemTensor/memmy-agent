/** Local data store module. */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { DatabaseSync as SqliteDatabaseSync } from "node:sqlite";
import type { ExportLocalDataInput, LocalDataExportResponse } from "@memmy/local-api-contracts";
import { getLoadablePath as getSqliteVecLoadablePath } from "sqlite-vec";
import YAML from "yaml";
import type { SecretStore } from "./secret-store.js";

export interface LocalDataStore {
  getDataPath(): string;
  revealDataPath(dataPath: string): void;
  exportData(input: ExportLocalDataInput): LocalDataExportResponse;
  clearMemoryDatabase(clearedAt: string): void;
}

export interface CreateFilesystemLocalDataStoreOptions {
  databasePath: string;
  db: DatabaseSync;
  secretStore: SecretStore;
  memoryDatabasePath?: string;
  memmyConfigPath?: string;
  env?: NodeJS.ProcessEnv;
  revealPath?: (dataPath: string) => void;
}

const DEFAULT_MEMORY_HOME = join(homedir(), ".memmy");
const MEMORY_DATA_TABLES = [
  "memories_fts",
  "memory_vector_entries",
  "trace_policy_links",
  "skill_trials",
  "feedback",
  "decision_repairs",
  "raw_turns",
  "episodes",
  "sessions",
  "recall_events",
  "l2_candidate_pool",
  "evolution_jobs",
  "embedding_retry_queue",
  "artifacts",
  "audit_logs",
  "api_logs",
  "memory_change_log",
  "idempotency_keys",
  "memories"
] as const;

/** Creates create filesystem local data store. */
export function createFilesystemLocalDataStore(options: CreateFilesystemLocalDataStoreOptions): LocalDataStore {
  const memoryDatabasePath = resolveMemoryDatabasePath(options);
  const memoryDataPath = dirname(memoryDatabasePath);

  return {
    getDataPath() {
      return memoryDataPath;
    },

    revealDataPath(dataPath) {
      (options.revealPath ?? revealPathInFileManager)(dataPath);
    },

    exportData(input) {
      const exportRoot = resolveExportRoot(input.targetPath, memoryDataPath);
      const exportPath = join(exportRoot, `memmy-export-${toExportTimestamp(new Date())}`);
      mkdirSync(exportPath, { recursive: true });

      copyIfExists(memoryDatabasePath, join(exportPath, "memory.sqlite"));
      copyIfExists(`${memoryDatabasePath}-wal`, join(exportPath, "memory.sqlite-wal"));
      copyIfExists(`${memoryDatabasePath}-shm`, join(exportPath, "memory.sqlite-shm"));

      return {
        exportPath,
        bytes: countBytes(exportPath)
      };
    },

    clearMemoryDatabase(_clearedAt) {
      clearSqliteMemoryTables(memoryDatabasePath);
      options.db.exec(`
        DELETE FROM account_ingestion_seen;
        DELETE FROM account_agent_source_watermarks;
        UPDATE account_agent_sources SET last_scanned_at = NULL;
      `);
    }
  };
}

function clearSqliteMemoryTables(databasePath: string): void {
  if (!existsSync(databasePath)) {
    return;
  }

  const db = new SqliteDatabaseSync(databasePath, { allowExtension: true });
  try {
    const extensionPath = getSqliteVecLoadablePath();
    const unpackedPath = extensionPath.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
    db.loadExtension(existsSync(unpackedPath) ? unpackedPath : extensionPath);
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of sqliteVectorTables(db)) {
        deleteTableRowsIfExists(db, table);
      }
      for (const table of MEMORY_DATA_TABLES) {
        deleteTableRowsIfExists(db, table);
      }
      deleteSqliteSequenceRows(db);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // The cleanup data has already been committed; a WAL truncation failure should not make the user think the cleanup failed.
    }
  } finally {
    db.close();
  }
}

function sqliteVectorTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
         AND name GLOB 'memory_vec_[0-9]*'
         AND sql LIKE 'CREATE VIRTUAL TABLE%USING vec0%'`
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name).filter((name) => /^memory_vec_\d+$/.test(name));
}

function deleteTableRowsIfExists(db: DatabaseSync, table: string): void {
  if (tableExists(db, table)) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
}

function deleteSqliteSequenceRows(db: DatabaseSync): void {
  if (!tableExists(db, "sqlite_sequence")) {
    return;
  }
  db.prepare("DELETE FROM sqlite_sequence WHERE name IN (?, ?)").run("api_logs", "memory_change_log");
}

function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?").get(table);
  return Boolean(row);
}

function resolveMemoryDatabasePath(options: CreateFilesystemLocalDataStoreOptions): string {
  if (options.memoryDatabasePath) {
    return resolve(expandHome(options.memoryDatabasePath));
  }

  const env = options.env ?? process.env;
  const explicitPath = (env.MEMMY_MEMORY_DB_PATH ?? env.MEMMY_MEMOS_DB_PATH ?? "").trim();
  if (explicitPath) {
    return resolve(expandHome(explicitPath));
  }

  const configPath = resolveMemmyConfigPath(options, env);
  const configuredPath = readMemoryDatabasePathFromConfig(configPath);
  if (configuredPath) {
    return resolve(expandHome(configuredPath));
  }

  return join(resolve(expandHome(env.MEMMY_HOME ?? DEFAULT_MEMORY_HOME)), "memory-service", "memory.sqlite");
}

function resolveMemmyConfigPath(options: CreateFilesystemLocalDataStoreOptions, env: NodeJS.ProcessEnv): string {
  return resolve(expandHome(options.memmyConfigPath ?? env.MEMMY_CONFIG ?? join(DEFAULT_MEMORY_HOME, "config.yaml")));
}

function readMemoryDatabasePathFromConfig(configPath: string): string | null {
  if (!existsSync(configPath)) {
    return null;
  }

  const parsed = YAML.parse(readFileSync(configPath, "utf8"));
  if (!isRecord(parsed)) {
    return null;
  }

  const memmyMemory = parsed.memmyMemory;
  if (!isRecord(memmyMemory)) {
    return null;
  }

  const storage = memmyMemory.storage;
  if (!isRecord(storage)) {
    return null;
  }

  return typeof storage.sqlitePath === "string" && storage.sqlitePath.trim() ? storage.sqlitePath.trim() : null;
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function revealPathInFileManager(dataPath: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
  const child = spawn(command, [dataPath], {
    detached: true,
    stdio: "ignore"
  });
  child.on("error", () => undefined);
  child.unref();
}

/**
 * Resolves the export root directory and rejects path-traversal segments.
 *
 * @param targetPath the target path provided by the user.
 * @param dataPath the default data directory.
 * @returns a writable export root directory.
 */
function resolveExportRoot(targetPath: string | undefined, dataPath: string): string {
  if (targetPath && hasParentTraversal(targetPath)) {
    throw Object.assign(new Error("targetPath must not contain .."), { code: "invalid_argument" as const });
  }

  const exportRoot = resolve(targetPath ?? join(dataPath, "exports"));
  mkdirSync(exportRoot, { recursive: true });
  return exportRoot;
}

/**
 * Checks whether the path contains parent-directory traversal segments.
 *
 * @param targetPath the user-provided path.
 * @returns whether it contains "..".
 */
function hasParentTraversal(targetPath: string): boolean {
  return targetPath.split(/[\\/]+/).includes("..");
}

/**
 * Copies the file if it exists.
 *
 * @param source the source path.
 * @param target the target path.
 */
function copyIfExists(source: string, target: string): void {
  if (existsSync(source)) {
    copyFileSync(source, target);
  }
}

/**
 * Counts the total byte size of files in a directory.
 *
 * @param directory the directory path.
 * @returns the sum of all file sizes.
 */
function countBytes(directory: string): number {
  return readdirSync(directory).reduce((total, entry) => {
    const path = join(directory, entry);
    const stats = statSync(path);
    return total + (stats.isFile() ? stats.size : 0);
  }, 0);
}

/**
 * Generates a filesystem-friendly export timestamp.
 *
 * @param date the current time.
 * @returns a timestamp usable in directory names.
 */
function toExportTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}
