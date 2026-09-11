/** Local data store module. */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ExportLocalDataInput, LocalDataExportResponse } from "@memmy/local-api-contracts";
import YAML from "yaml";
import type { SecretStore } from "./secret-store.js";

export interface LocalDataStore {
  getDataPath(): string;
  revealDataPath(dataPath: string): void;
  exportData(input: ExportLocalDataInput, bundle: Record<string, unknown>): LocalDataExportResponse;
  clearImportState(): void;
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

    exportData(input, bundle) {
      const exportRoot = resolveExportRoot(input.targetPath, memoryDataPath);
      const exportPath = join(exportRoot, `memmy-export-${toExportTimestamp(new Date())}`);
      mkdirSync(exportPath, { recursive: true });
      writeFileSync(join(exportPath, "memory.json"), `${JSON.stringify(bundle, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

      return {
        exportPath,
        bytes: countBytes(exportPath)
      };
    },

    clearImportState() {
      options.db.exec(`
        DELETE FROM account_ingestion_seen;
        DELETE FROM account_agent_source_watermarks;
        UPDATE account_agent_sources SET last_scanned_at = NULL;
      `);
    }
  };
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
