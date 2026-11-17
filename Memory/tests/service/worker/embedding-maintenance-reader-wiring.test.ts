import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryDb } from "../../../src/storage/db.js";
import { SqliteStorageBackend } from "../../../src/storage/backend.js";
import { MemoryService } from "../../../src/service/memory-service.js";
import { DEFAULT_MEMMY_CONFIG } from "../../../src/config/index.js";

const roots: string[] = [];
const services: Array<{ stop(): Promise<void> }> = [];
const databases: MemoryDb[] = [];

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-reader-wiring-"));
  roots.push(root);
  return root;
}

function openDatabase(path: string): MemoryDb {
  const db = new MemoryDb({ path });
  databases.push(db);
  return db;
}

interface ReaderLike {
  readonly sqlitePath?: string;
  readonly workerBacked: boolean;
}

function readerOf(service: MemoryService): ReaderLike {
  return (service as unknown as { embeddingMaintenanceReader: ReaderLike }).embeddingMaintenanceReader;
}

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  for (const db of databases.splice(0)) {
    if (db.db.open) db.close();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe("embedding maintenance reader wiring", () => {
  // Production servers are built with a pre-built backend, never with a raw
  // `db`. A reader that reads only `options.db` silently falls back to inline
  // execution on the main event loop, which is the bug these tests pin down.
  // `EmbeddingMaintenanceReader` only promotes itself to a worker when its own
  // module is emitted as `.js`, which the compiled-reader suite covers; here the
  // observable contract is that the database path reaches the reader at all.
  it("threads the backend's SQLite path into the maintenance reader", () => {
    const root = createRoot();
    const db = openDatabase(join(root, "memory.sqlite"));
    const backend = new SqliteStorageBackend(db);
    expect(backend.sqlitePath).toBe(db.path);

    const service = new MemoryService({ backend, mode: "local", config: DEFAULT_MEMMY_CONFIG });
    services.push(service);
    expect(readerOf(service).sqlitePath).toBe(db.path);
  });

  it("threads the db handle's path into the maintenance reader", () => {
    const root = createRoot();
    const db = openDatabase(join(root, "memory.sqlite"));
    const service = new MemoryService({ db, mode: "local", config: DEFAULT_MEMMY_CONFIG });
    services.push(service);
    expect(readerOf(service).sqlitePath).toBe(db.path);
  });

  it("exposes the path through a backend built without an explicit mode", () => {
    const root = createRoot();
    const db = openDatabase(join(root, "memory.sqlite"));
    expect(new SqliteStorageBackend(db).sqlitePath).toBe(db.path);
    expect(new SqliteStorageBackend(db, "dev").sqlitePath).toBe(db.path);
  });

  it("keeps in-memory databases inline because no worker can share them", () => {
    const db = openDatabase(":memory:");
    const backend = new SqliteStorageBackend(db);
    expect(backend.sqlitePath).toBe(":memory:");

    const service = new MemoryService({ backend, mode: "local", config: DEFAULT_MEMMY_CONFIG });
    services.push(service);
    expect(readerOf(service).workerBacked).toBe(false);
  });
});
