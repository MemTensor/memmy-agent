/** Local data store tests. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  it("writes the service export bundle without reading the Memory database", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-local-data-"));
    const databasePath = join(tempDir, "app.sqlite");
    const memoryDatabasePath = join(tempDir, "memory.sqlite");
    const store = createAppStateStore({ databasePath });
    const localData = createFilesystemLocalDataStore({ databasePath, db: store.db, secretStore: store.secretStore, memoryDatabasePath });

    const result = localData.exportData(
      { targetPath: join(tempDir, "exports") },
      { manifest: { service: "memmy-memory-service" }, tables: { memories: [] } }
    );
    store.close();

    expect(result.bytes).toBeGreaterThan(0);
    expect(result.exportPath).toContain("memmy-export-");
    expect(existsSync(join(result.exportPath, "memory.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(result.exportPath, "memory.json"), "utf8"))).toMatchObject({
      manifest: { service: "memmy-memory-service" }
    });
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

    expect(() => localData.exportData({ targetPath: "../escape" }, {})).toThrow("targetPath must not contain ..");
    store.close();
  });

  it("clears Desktop import state without opening the Memory database", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-local-data-"));
    const databasePath = join(tempDir, "app.sqlite");
    const memoryDatabasePath = join(tempDir, "memory.sqlite");
    const store = createAppStateStore({ databasePath });
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

    localData.clearImportState();
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
  });
});
