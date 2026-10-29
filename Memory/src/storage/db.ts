import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { getLoadablePath as getSqliteVecLoadablePath } from "sqlite-vec";
import { getSchemaVersion, migrate, SCHEMA_VERSION } from "./schema.js";
import { SQLITE_VEC_VERSION } from "./sqlite-vec-store.js";
import { protectJobLeaseWrites } from "./job-lease-context.js";
import { createMemoryLogger } from "../logging/logger.js";

const startupLogger = createMemoryLogger("storage");

export interface MemoryDbOptions {
  path?: string;
  readonly?: boolean;
  /** The caller already prepared and verified this database in an isolated startup worker. */
  skipMigrations?: boolean;
  onStartupStage?: (stage: MemoryDbStartupStage) => void;
}

export interface MemoryDbStartupStage {
  phase: string;
  elapsedMs: number;
  currentSchemaVersion?: number;
  targetSchemaVersion: number;
}

export class MemoryDb {
  readonly path: string;
  readonly db: Database.Database;

  constructor(options: MemoryDbOptions = {}) {
    const startedAt = Date.now();
    const stage = (phase: string, currentSchemaVersion?: number): void => {
      const snapshot: MemoryDbStartupStage = {
        phase,
        elapsedMs: Date.now() - startedAt,
        ...(currentSchemaVersion === undefined ? {} : { currentSchemaVersion }),
        targetSchemaVersion: SCHEMA_VERSION
      };
      startupLogger.info("storage.startup_stage", { ...snapshot });
      options.onStartupStage?.(snapshot);
    };
    this.path = options.path ?? defaultDatabasePath();
    mkdirSync(dirname(this.path), { recursive: true });
    stage("database.opening");
    const nativeBinding = packagedNativeBindingPath();
    this.db = new Database(this.path, {
      readonly: options.readonly ?? false,
      ...(nativeBinding ? { nativeBinding } : {})
    });
    stage("database.opened");
    const extensionPath = packagedNativeAssetPath(getSqliteVecLoadablePath());
    const unpackedPath = extensionPath.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
    this.db.loadExtension(existsSync(unpackedPath) ? unpackedPath : extensionPath);
    stage("sqlite_vec.loaded");
    const loadedVersion = (this.db.prepare(`SELECT vec_version() AS version`).get() as { version: string }).version;
    if (loadedVersion !== `v${SQLITE_VEC_VERSION}`) {
      this.db.close();
      throw new Error(`sqlite-vec version mismatch: expected v${SQLITE_VEC_VERSION}, got ${loadedVersion}`);
    }
    try {
      this.configure();
      stage("database.configured");
      if (!options.readonly) {
        const currentSchemaVersion = this.currentSchemaVersion();
        stage("schema.detected", currentSchemaVersion);
        if (options.skipMigrations) {
          if (currentSchemaVersion !== SCHEMA_VERSION) {
            throw new Error(`Memory database preparation did not reach schema ${SCHEMA_VERSION}; received ${currentSchemaVersion}`);
          }
          stage("migration.prepared", currentSchemaVersion);
        } else {
          stage("backup.checking", currentSchemaVersion);
          this.createPreMigrationBackup(currentSchemaVersion);
          stage("backup.completed", currentSchemaVersion);
          stage("migration.starting", currentSchemaVersion);
          migrate(this.db);
          stage("migration.completed", SCHEMA_VERSION);
        }
      }
      protectJobLeaseWrites(this.db);
      stage("database.ready");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  schemaVersion(): {
    version: number;
    lastMigrationId?: string;
  } {
    return getSchemaVersion(this.db);
  }

  private configure(): void {
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
  }

  private currentSchemaVersion(): number {
    try {
      return getSchemaVersion(this.db).version;
    } catch {
      return 0;
    }
  }

  private createPreMigrationBackup(version = this.currentSchemaVersion()): void {
    if (this.path === ":memory:" || !existsSync(this.path)) return;
    if (version <= 0 || version >= SCHEMA_VERSION) return;
    const backupPath = `${this.path}.pre-v${SCHEMA_VERSION}.bak`;
    if (existsSync(backupPath)) return;
    this.db.pragma("wal_checkpoint(FULL)");
    this.db.prepare("VACUUM INTO ?").run(backupPath);
  }
}

function packagedNativeBindingPath(): string | undefined {
  if (!(process as NodeJS.Process & { pkg?: unknown }).pkg) return undefined;
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDir, "../../../node_modules/better-sqlite3/build/Release/better_sqlite3.node"),
    resolve(moduleDir, "node_modules/better-sqlite3/build/Release/better_sqlite3.node")
  ];
  const source = candidates.find((candidate) => existsSync(candidate));
  if (!source) return undefined;
  const targetDirectory = join(tmpdir(), "memmy-memory-native");
  const target = join(targetDirectory, "better_sqlite3.node");
  // Refresh on every start so an upgraded package cannot reuse a stale
  // native addon left by a previous executable with the same temp path.
  mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
  copyFileSync(source, target);
  return target;
}

function packagedNativeAssetPath(source: string): string {
  if (!(process as NodeJS.Process & { pkg?: unknown }).pkg) return source;
  if (!existsSync(source)) return source;
  const targetDirectory = join(tmpdir(), "memmy-memory-native");
  const target = join(targetDirectory, basename(source));
  if (!existsSync(target)) {
    mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
    copyFileSync(source, target);
  }
  return target;
}

export function defaultDatabasePath(): string {
  const baseDir =
    process.env.MEMMY_MEMORY_HOME ??
    process.env.MEMORY_SERVICE_HOME ??
    join(homedir(), ".memmy", "memory-service");
  return join(baseDir, "memory.sqlite");
}
