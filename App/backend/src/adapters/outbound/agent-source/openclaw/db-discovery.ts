/** Db discovery module. */
import { statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Type definition for openclaw schema kind. */
export type OpenclawSchemaKind = "conversation" | "memory" | "unknown";

/** Contract for openclaw database candidate. */
export interface OpenclawDatabaseCandidate {
  databasePath: string;
  schemaKind: OpenclawSchemaKind;
  tables: readonly string[];
  mtimeMs?: number;
}

/** Contract for discover openclaw databases options. */
export interface DiscoverOpenclawDatabasesOptions {
  root: string;
  order?: "path_asc" | "recent_first";
  maxDatabases?: number;
}

/** Handles discover openclaw databases. */
export async function discoverOpenclawDatabases(options: DiscoverOpenclawDatabasesOptions): Promise<OpenclawDatabaseCandidate[]> {
  const files = await listSqliteFiles(options.root);
  const databases = files.map(readDatabaseCandidate).filter((database): database is OpenclawDatabaseCandidate => Boolean(database));
  return databases
    .sort((left, right) => options.order === "recent_first"
      ? (right.mtimeMs ?? 0) - (left.mtimeMs ?? 0) || right.databasePath.localeCompare(left.databasePath)
      : left.databasePath.localeCompare(right.databasePath))
    .slice(0, options.maxDatabases ?? databases.length);
}

async function listSqliteFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }

    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSqliteFiles(path)));
      continue;
    }

    if (entry.isFile() && isSqliteFileName(entry.name)) {
      files.push(path);
    }
  }

  return files;
}

function readDatabaseCandidate(databasePath: string): OpenclawDatabaseCandidate | null {
  try {
    const fileStat = statSync(databasePath);
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>
      ).map((row) => row.name);
      return {
        databasePath,
        schemaKind: classifySchema(tables),
        tables,
        mtimeMs: fileStat.mtimeMs
      };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function classifySchema(tables: readonly string[]): OpenclawSchemaKind {
  const tableSet = new Set(tables);
  if (tableSet.has("messages") && (tableSet.has("conversations") || tableSet.has("sessions"))) {
    return "conversation";
  }

  if (
    tableSet.has("chunks") ||
    tableSet.has("memories") ||
    tableSet.has("memory_items") ||
    tableSet.has("memos")
  ) {
    return "memory";
  }

  return "unknown";
}

function isSqliteFileName(fileName: string): boolean {
  return fileName.endsWith(".db") || fileName.endsWith(".sqlite") || fileName.endsWith(".sqlite3");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
