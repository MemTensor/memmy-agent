import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
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
    const nativeBinding = packagedNativeBindingPath();
    this.db = new Database(this.path, {
      readonly: options.readonly ?? false,
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
      this.configure();
      if (!options.readonly) {
        this.createPreMigrationBackup();
        migrate(this.db);
      }
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

function packagedNativeBindingPath(): string | undefined {
  if (!(process as NodeJS.Process & { pkg?: unknown }).pkg) return undefined;
  const source = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../node_modules/better-sqlite3/build/Release/better_sqlite3.node"
  );
  if (!existsSync(source)) return undefined;
  return packagedNativeAssetPath(source);
}

function packagedNativeAssetPath(source: string): string {
  if (!(process as NodeJS.Process & { pkg?: unknown }).pkg) return source;
  if (!existsSync(source)) return source;
  const contents = readFileSync(source);
  const digest = createHash("sha256").update(contents).digest("hex");
  // Keep upgrades separate from native libraries already loaded by older processes.
  const targetDirectory = join(tmpdir(), "memmy-memory-native", digest);
  const target = join(targetDirectory, basename(source));
  const isComplete = () => existsSync(target) && readFileSync(target).equals(contents);
  if (isComplete()) return target;
  mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, contents, { flag: "wx", mode: 0o600 });
    renameSync(temporaryPath, target);
  } catch (error) {
    // Another extractor may publish and load the same asset before our rename.
    if (!isComplete()) throw error;
  } finally {
    rmSync(temporaryPath, { force: true });
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
