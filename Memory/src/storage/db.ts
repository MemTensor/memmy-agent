import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { getLoadablePath as getSqliteVecLoadablePath } from "sqlite-vec";
import { getSchemaVersion, migrate, SCHEMA_VERSION } from "./schema.js";
import { SQLITE_VEC_VERSION } from "./sqlite-vec-store.js";
import { protectJobLeaseWrites } from "./job-lease-context.js";

export interface MemoryDbOptions {
  path?: string;
  readonly?: boolean;
}

export class MemoryDb {
  readonly path: string;
  readonly db: Database.Database;

  constructor(options: MemoryDbOptions = {}) {
    this.path = options.path ?? defaultDatabasePath();
    if (!options.readonly) mkdirSync(dirname(this.path), { recursive: true });
    const nativeBinding = packagedNativeBindingPath();
    this.db = new Database(this.path, {
      readonly: options.readonly ?? false,
      fileMustExist: options.readonly ?? false,
      ...(nativeBinding ? { nativeBinding } : {})
    });
    const extensionPath = packagedNativeAssetPath(getSqliteVecLoadablePath());
    const unpackedPath = extensionPath.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
    this.db.loadExtension(existsSync(unpackedPath) ? unpackedPath : extensionPath);
    const loadedVersion = (this.db.prepare(`SELECT vec_version() AS version`).get() as { version: string }).version;
    if (loadedVersion !== `v${SQLITE_VEC_VERSION}`) {
      this.db.close();
      throw new Error(`sqlite-vec version mismatch: expected v${SQLITE_VEC_VERSION}, got ${loadedVersion}`);
    }
    try {
      this.configure(options.readonly ?? false);
      if (!options.readonly) {
        this.createPreMigrationBackup();
        migrate(this.db);
      }
      protectJobLeaseWrites(this.db);
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

  private configure(readonly: boolean): void {
    this.db.pragma("foreign_keys = ON");
    if (!readonly) {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
    } else {
      this.db.pragma("query_only = ON");
    }
    this.db.pragma("busy_timeout = 5000");
  }

  private createPreMigrationBackup(): void {
    if (this.path === ":memory:" || !existsSync(this.path)) return;
    let version = 0;
    try {
      version = getSchemaVersion(this.db).version;
    } catch {
      return;
    }
    if (version <= 0 || version >= SCHEMA_VERSION) return;
    const backupPath = `${this.path}.pre-v${SCHEMA_VERSION}.bak`;
    if (existsSync(backupPath)) {
      const backup = new Database(backupPath, {readonly:true,fileMustExist:true});
      try {
        if (backup.pragma("quick_check", {simple:true}) !== "ok" || getSchemaVersion(backup).version !== version) {
          throw new Error(`Invalid migration backup: ${backupPath}; preserve it and choose a new backup location`);
        }
      } finally { backup.close(); }
      return;
    }
    const partial = `${backupPath}.${process.pid}.partial`;
    try {
      this.db.pragma("wal_checkpoint(FULL)");
      this.db.prepare("VACUUM INTO ?").run(partial);
      renameSync(partial, backupPath);
    } catch (error) {
      rmSync(partial, {force:true});
      throw error;
    }
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
