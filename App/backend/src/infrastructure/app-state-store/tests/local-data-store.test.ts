/** Local data store tests. */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getLoadablePath as getSqliteVecLoadablePath } from "sqlite-vec";
import { afterEach, describe, expect, it } from "vitest";
import { createAppStateStore } from "../index.js";
import { createFilesystemLocalDataStore } from "../local-data-store.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("filesystem local data store", () => {
  it("exports the memory database as a directory copy", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-local-data-"));
    const databasePath = join(tempDir, "app.sqlite");
    const memoryDatabasePath = join(tempDir, "memory.sqlite");
    writeFileSync(memoryDatabasePath, "memory-db");
    const store = createAppStateStore({ databasePath });
    const localData = createFilesystemLocalDataStore({ databasePath, db: store.db, secretStore: store.secretStore, memoryDatabasePath });

    const result = localData.exportData({ targetPath: join(tempDir, "exports") });
    store.close();

    expect(result.bytes).toBeGreaterThan(0);
    expect(result.exportPath).toContain("memmy-export-");
    expect(existsSync(join(result.exportPath, "memory.sqlite"))).toBe(true);
  });

  it("rejects traversal-like export targets", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-local-data-"));
    const databasePath = join(tempDir, "app.sqlite");
    const store = createAppStateStore({ databasePath });
    const localData = createFilesystemLocalDataStore({
      databasePath,
      db: store.db,
      secretStore: store.secretStore,
      memoryDatabasePath: join(tempDir, "memory.sqlite")
    });

    expect(() => localData.exportData({ targetPath: "../escape" })).toThrow("targetPath must not contain ..");
    store.close();
  });

  it("clears memory database rows without clearing app configuration", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-local-data-"));
    const databasePath = join(tempDir, "app.sqlite");
    const memoryDatabasePath = join(tempDir, "memory.sqlite");
    const store = createAppStateStore({ databasePath });
    createMemoryDatabase(memoryDatabasePath);
    const localData = createFilesystemLocalDataStore({ databasePath, db: store.db, secretStore: store.secretStore, memoryDatabasePath });

    store.repositories.bootstrap.updateAppSettings({ language: "zh-CN", theme: "dark" });
    store.repositories.accountSession.upsert({
      profile: {
        userId: "cloud-account-user-1",
        email: "hello@example.com",
        phoneNumber: null,
        nickname: "hello",
        avatarUrl: null,
        planType: "free",
        hasFinishedGuide: false,
        region: null,
        registeredAt: "2026-06-02T10:00:00.000Z",
        rawProfile: { id: "user-1", email: "hello@example.com" }
      },
      uuid: "cloud-account-user-1",
      cloudUuid: "cloud.login.uuid"
    });
    store.repositories.agentSources.upsertSource({
      sourceId: "cursor",
      displayName: "Cursor",
      dataPath: "/Users/test/Cursor",
      builtin: true
    });
    store.repositories.agentSources.setLastScannedAt("cursor", "2026-06-01T10:00:00.000Z");
    store.repositories.agentSources.upsertScanWatermark({
      sourceId: "cursor",
      mode: "incremental",
      baselineAt: "2026-06-01T09:00:00.000Z",
      latestSeenCreatedAt: "2026-06-01T10:00:00.000Z",
      updatedAt: "2026-06-01T10:00:00.000Z"
    });
    store.repositories.agentSources.markSeen("dedup-key-1", "cursor");

    localData.clearMemoryDatabase("2026-06-02T10:00:00.000Z");
    const settings = store.repositories.bootstrap.getAppSettings();
    const session = store.repositories.accountSession.get();
    const active = store.db.prepare("SELECT active_uuid FROM app_settings WHERE id = 'default'").get() as { active_uuid: string | null };
    const sessionAccountCount = store.db.prepare("SELECT COUNT(*) AS count FROM cloud_accounts WHERE uuid = ?").get("cloud-account-user-1") as {
      count: number;
    };
    const sourceScopeCount = store.db.prepare("SELECT COUNT(*) AS count FROM cloud_accounts WHERE uuid = ?").get("local-agent-sources") as {
      count: number;
    };
    const sourceCount = store.db.prepare("SELECT COUNT(*) AS count FROM account_agent_sources").get() as { count: number };
    const lastScannedCount = store.db.prepare("SELECT COUNT(*) AS count FROM account_agent_sources WHERE last_scanned_at IS NOT NULL").get() as {
      count: number;
    };
    const seenCount = store.db.prepare("SELECT COUNT(*) AS count FROM account_ingestion_seen").get() as { count: number };
    const watermarkCount = store.db.prepare("SELECT COUNT(*) AS count FROM account_agent_source_watermarks").get() as { count: number };
    const memoryDb = new DatabaseSync(memoryDatabasePath, { readOnly: true, allowExtension: true });
    memoryDb.loadExtension(getSqliteVecLoadablePath());
    const memoryCount = memoryDb.prepare("SELECT COUNT(*) AS count FROM memories").get() as { count: number };
    const vectorCount = memoryDb.prepare("SELECT COUNT(*) AS count FROM memory_vec_3").get() as { count: number };
    const apiLogCount = memoryDb.prepare("SELECT COUNT(*) AS count FROM api_logs").get() as { count: number };
    const migrationCount = memoryDb.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number };
    memoryDb.close();
    store.close();

    expect(settings).toMatchObject({
      language: "zh-CN",
      theme: "dark"
    });
    expect(session.authenticated).toBe(true);
    expect(active.active_uuid).toBe("cloud-account-user-1");
    expect(sessionAccountCount.count).toBe(1);
    expect(sourceScopeCount.count).toBe(1);
    expect(sourceCount.count).toBe(1);
    expect(lastScannedCount.count).toBe(0);
    expect(seenCount.count).toBe(0);
    expect(watermarkCount.count).toBe(0);
    expect(memoryCount.count).toBe(0);
    expect(vectorCount.count).toBe(0);
    expect(apiLogCount.count).toBe(0);
    expect(migrationCount.count).toBe(1);
  });
});

function createMemoryDatabase(databasePath: string): void {
  const db = new DatabaseSync(databasePath, { allowExtension: true });
  db.loadExtension(getSqliteVecLoadablePath());
  db.exec(`
    CREATE TABLE schema_migrations (id TEXT PRIMARY KEY);
    CREATE TABLE memories (id TEXT PRIMARY KEY, memory_value TEXT NOT NULL);
    CREATE TABLE memory_vector_entries (
      id INTEGER PRIMARY KEY,
      memory_id TEXT NOT NULL,
      vector_field TEXT NOT NULL,
      embedding_dim INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE memory_vec_3 USING vec0(embedding float[3] distance_metric=cosine);
    CREATE TABLE api_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, tool_name TEXT NOT NULL);
    INSERT INTO schema_migrations (id) VALUES ('001_runtime_schema');
    INSERT INTO memories (id, memory_value) VALUES ('memory-1', 'remember this');
    INSERT INTO memory_vector_entries VALUES (1, 'memory-1', 'vec_summary', 3, '2026-01-01');
    INSERT INTO api_logs (tool_name) VALUES ('memory_add');
  `);
  db.prepare(`INSERT INTO memory_vec_3 (rowid, embedding) VALUES (?, ?)`)
    .run(1n, Buffer.from(new Float32Array([1, 0, 0]).buffer));
  db.close();
}
