import { Repositories } from "./repositories.js";
import { MemoryDb } from "./db.js";

export type StorageBackendKind = "sqlite" | "openmem-cloud-rest";
export type StorageMode = "local" | "cloud" | "dev";

export interface StorageBackendCapabilities {
  backendId: "sqlite-local" | "openmem-cloud-rest";
  backend: StorageBackendKind;
  schemaVersion: string;
  fullText: "fts5" | "tsvector" | "remote" | "none";
  vector: "sidecar" | "native" | "remote" | "none";
  changeLog: boolean;
  idempotency: boolean;
  jobs: boolean;
  importExport: boolean;
}

export interface StorageBackend {
  readonly id: StorageBackendCapabilities["backendId"];
  readonly kind: StorageBackendKind;
  readonly mode: StorageMode;
  /**
   * Path of the file-backed SQLite database this backend owns, when it has one.
   * Callers that need a second connection (read-only maintenance workers) must
   * use this rather than a constructor option, because production services are
   * wired with a pre-built backend and never see the raw `db` handle.
   */
  readonly sqlitePath?: string;
  capabilities(): StorageBackendCapabilities;
  repositories(): Repositories;
  close(): void;
}

export interface StorageBackendFactoryOptions {
  mode?: StorageMode;
  backend?: StorageBackendKind;
  sqlitePath?: string;
  endpoint?: string;
  token?: string;
  schemaVersion?: string;
  skipMigrations?: boolean;
}

export class SqliteStorageBackend implements StorageBackend {
  readonly id = "sqlite-local" as const;
  readonly kind = "sqlite" as const;

  readonly sqlitePath: string;

  constructor(
    readonly db: MemoryDb,
    readonly mode: StorageMode = "local"
  ) {
    this.sqlitePath = db.path;
  }

  capabilities(): StorageBackendCapabilities {
    return sqliteBackendCapabilities(this.db);
  }

  repositories(): Repositories {
    return new Repositories(this.db.db);
  }

  close(): void {
    this.db.close();
  }
}

export function sqliteBackendCapabilities(db: MemoryDb): StorageBackendCapabilities {
  const schema = db.schemaVersion();
  return {
    backendId: "sqlite-local",
    backend: "sqlite",
    schemaVersion: String(schema.version),
    fullText: "fts5",
    vector: "native",
    changeLog: true,
    idempotency: true,
    jobs: true,
    importExport: true
  };
}

export class RemoteRestStorageBackend implements StorageBackend {
  readonly id = "openmem-cloud-rest" as const;
  readonly kind = "openmem-cloud-rest" as const;
  readonly mode: StorageMode;

  constructor(
    readonly endpoint: string,
    readonly token?: string,
    mode: StorageMode = "cloud",
    private readonly schema = "remote"
  ) {
    this.mode = mode;
  }

  capabilities(): StorageBackendCapabilities {
    return {
      backendId: "openmem-cloud-rest",
      backend: "openmem-cloud-rest",
      schemaVersion: this.schema,
      fullText: "remote",
      vector: "remote",
      changeLog: true,
      idempotency: true,
      jobs: true,
      importExport: true
    };
  }

  repositories(): Repositories {
    throw new Error("openmem-cloud-rest is an agent-side REST backend; use MemoryRestClient instead of local repositories");
  }

  close(): void {
    // Remote REST mode owns no local database handle.
  }
}

export function createStorageBackend(options: StorageBackendFactoryOptions = {}): StorageBackend {
  const backend = options.backend ?? "sqlite";
  const mode = options.mode ?? "local";
  if (backend === "openmem-cloud-rest") {
    return new RemoteRestStorageBackend(
      options.endpoint ?? "https://memos-api.openmem.net",
      options.token,
      mode,
      options.schemaVersion
    );
  }
  return new SqliteStorageBackend(new MemoryDb({ path: options.sqlitePath, skipMigrations: options.skipMigrations }), mode);
}
