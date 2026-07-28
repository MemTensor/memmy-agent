import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { getLoadablePath as getSqliteVecLoadablePath } from "sqlite-vec";
import { getSchemaVersion, migrate, SCHEMA_VERSION } from "./schema.js";
import { SQLITE_VEC_VERSION } from "./sqlite-vec-store.js";

export interface MemoryDbOptions {
  path?: string;
  readonly?: boolean;
}

export class MemoryDb {
  readonly path: string;
  readonly db: Database.Database;

  constructor(options: MemoryDbOptions = {}) {
    this.path = options.path ?? defaultDatabasePath();
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new Database(this.path, {
      readonly: options.readonly ?? false
    });
    const extensionPath = getSqliteVecLoadablePath();
    const unpackedPath = extensionPath.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
    this.db.loadExtension(existsSync(unpackedPath) ? unpackedPath : extensionPath);
    const loadedVersion = (this.db.prepare(`SELECT vec_version() AS version`).get() as { version: string }).version;
    if (loadedVersion !== `v${SQLITE_VEC_VERSION}`) {
      this.db.close();
      throw new Error(`sqlite-vec version mismatch: expected v${SQLITE_VEC_VERSION}, got ${loadedVersion}`);
    }
    this.configure();
    if (!options.readonly) {
      this.createPreMigrationBackup();
      migrate(this.db);
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
    if (existsSync(backupPath)) return;
    this.db.pragma("wal_checkpoint(FULL)");
    this.db.prepare("VACUUM INTO ?").run(backupPath);
  }
}

export function defaultDatabasePath(): string {
  const baseDir =
    process.env.MEMMY_MEMORY_HOME ??
    process.env.MEMORY_SERVICE_HOME ??
    join(homedir(), ".memmy", "memory-service");
  return join(baseDir, "memory.sqlite");
}
