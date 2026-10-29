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
    store.db.prepare(`INSERT INTO account_agent_source_conversation_checkpoints (
      uuid, source_id, conversation_id, last_message_id, last_created_at, content_hash, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      "local-agent-sources", "cursor", "conversation-1", "message-1", "2026-06-01T10:00:00.000Z", "hash-1", "2026-06-01T10:00:00.000Z"
    );
    store.db.prepare(`INSERT INTO account_agent_source_scan_jobs (uuid, job_id, source_id, mode, phase)
      VALUES (?, ?, ?, ?, ?)`).run("local-agent-sources", "scan-1", "cursor", "incremental", "add");
    store.db.prepare(`INSERT INTO account_agent_source_scan_source_state (
      uuid, job_id, source_id, scan_mode, conversation_ids_json, errors_json, source_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run("local-agent-sources", "scan-1", "cursor", "incremental", "[\"conversation-1\"]", "[]", 0);
    store.db.prepare(`INSERT INTO account_agent_source_scan_messages (
      uuid, job_id, source_id, message_order, message_id, conversation_id, role, content, created_at, raw_meta_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "local-agent-sources", "scan-1", "cursor", 0, "message-1", "conversation-1", "user", "old staged history", "2026-06-01T10:00:00.000Z", "{}"
    );
    store.db.prepare(`INSERT INTO account_agent_source_scan_results (
      uuid, job_id, source_id, result_order, discovered_conversations, emitted_messages, skipped, errors_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("local-agent-sources", "scan-1", "cursor", 0, 1, 1, 0, "[]");

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
    const checkpointCount = store.db.prepare("SELECT COUNT(*) AS count FROM account_agent_source_conversation_checkpoints").get() as { count: number };
    const scanJournalCounts = [
      "account_agent_source_scan_jobs",
      "account_agent_source_scan_source_state",
      "account_agent_source_scan_messages",
      "account_agent_source_scan_results"
    ].map((table) => (store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
    const source = store.db.prepare("SELECT source_id, display_name, data_path, status, last_scanned_at FROM account_agent_sources").get() as Record<string, unknown>;
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
    expect(checkpointCount.count).toBe(0);
    expect(scanJournalCounts).toEqual([0, 0, 0, 0]);
    expect(source).toMatchObject({ source_id: "cursor", display_name: "Cursor", data_path: "/Users/test/Cursor", status: "not_connected", last_scanned_at: null });
  });
});
