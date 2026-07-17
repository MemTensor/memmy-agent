/** Repository tests. */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAppStateStore, type AppStateStore } from "../../app-state-store/index.js";
import {
  createAgentSourceRepository,
  type AgentSourceRepository
} from "../repository.js";

let db: DatabaseSync | undefined;
let tempDir: string | undefined;
let store: AppStateStore | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  store?.close();
  store = undefined;
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("agent source repository", () => {
  it("lists, upserts, updates, and removes agent sources", () => {
    const repository = createRepository();
    const scannedAt = "2026-05-28T10:00:00.000Z";

    repository.upsertSource({
      sourceId: "cursor",
      displayName: "Cursor",
      dataPath: "/Users/test/Library/Application Support/Cursor",
      builtin: true
    });
    repository.setStatus("cursor", "skill_installed");
    repository.setLastScannedAt("cursor", scannedAt);

    expect(repository.listSources()).toEqual([
      {
        sourceId: "cursor",
        displayName: "Cursor",
        dataPath: "/Users/test/Library/Application Support/Cursor",
        builtin: true,
        status: "skill_installed",
        messageCount: 0,
        lastScannedAt: scannedAt
      }
    ]);

    repository.upsertSource({
      sourceId: "cursor",
      displayName: "Cursor Stable",
      dataPath: "/Users/test/Cursor",
      builtin: true
    });

    expect(repository.listSources()[0]).toMatchObject({
      sourceId: "cursor",
      displayName: "Cursor Stable",
      dataPath: "/Users/test/Cursor",
      status: "skill_installed",
      lastScannedAt: scannedAt
    });

    repository.removeSource("cursor");

    expect(repository.listSources()).toEqual([]);
  });

  it("tracks ingestion dedupe keys without double-counting repeated marks", () => {
    const repository = createRepository();
    repository.upsertSource({
      sourceId: "cursor",
      displayName: "Cursor",
      dataPath: "/Users/test/Library/Application Support/Cursor",
      builtin: true
    });

    expect(repository.hasSeen("dedup-key-1")).toBe(false);
    expect(repository.markSeen("dedup-key-1", "cursor")).toBe(true);
    expect(repository.hasSeen("dedup-key-1")).toBe(true);
    expect(repository.markSeen("dedup-key-1", "cursor")).toBe(false);
  });

  it("persists scan watermarks per agent source", () => {
    const repository = createRepository();
    repository.upsertSource({
      sourceId: "cursor",
      displayName: "Cursor",
      dataPath: "/Users/test/Library/Application Support/Cursor",
      builtin: true
    });

    expect(repository.getScanWatermark("cursor")).toBeNull();

    repository.upsertScanWatermark({
      sourceId: "cursor",
      mode: "initial_subset",
      baselineAt: "2026-06-01T00:00:00.000Z",
      latestSeenCreatedAt: "2026-06-01T01:00:00.000Z",
      updatedAt: "2026-06-01T02:00:00.000Z"
    });

    expect(repository.getScanWatermark("cursor")).toEqual({
      sourceId: "cursor",
      mode: "initial_subset",
      baselineAt: "2026-06-01T00:00:00.000Z",
      latestSeenCreatedAt: "2026-06-01T01:00:00.000Z",
      updatedAt: "2026-06-01T02:00:00.000Z"
    });
  });


  it("keeps sources and ingestion dedupe machine-wide across account switches", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-agent-source-"));
    store = createAppStateStore({ databasePath: join(tempDir, "app.sqlite") });

    store.repositories.accountSession.upsert({
      profile: accountProfile("user-a", "a@example.com", "Account A"),
      uuid: "cloud-account-a"
    });
    store.repositories.agentSources.upsertSource({
      sourceId: "cursor",
      displayName: "Cursor A",
      dataPath: "/Users/test/a/Cursor",
      builtin: true
    });
    expect(store.repositories.agentSources.markSeen("dedup-shared", "cursor")).toBe(true);

    store.repositories.accountSession.upsert({
      profile: accountProfile("user-b", "b@example.com", "Account B"),
      uuid: "cloud-account-b"
    });
    expect(store.repositories.agentSources.listSources()).toEqual([
      {
        sourceId: "cursor",
        displayName: "Cursor A",
        dataPath: "/Users/test/a/Cursor",
        builtin: true,
        status: "not_connected",
        messageCount: 1,
        lastScannedAt: null
      }
    ]);
    expect(store.repositories.agentSources.hasSeen("dedup-shared")).toBe(true);
  });
});

function createRepository(): AgentSourceRepository {
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE cloud_accounts (
      uuid TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE account_agent_sources (
      uuid            TEXT NOT NULL REFERENCES cloud_accounts(uuid) ON DELETE CASCADE,
      source_id       TEXT NOT NULL,
      display_name    TEXT NOT NULL,
      data_path       TEXT NOT NULL,
      builtin         INTEGER NOT NULL CHECK(builtin IN (0,1)),
      status          TEXT NOT NULL DEFAULT 'not_connected',
      last_scanned_at TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (uuid, source_id)
    );
    CREATE TABLE account_ingestion_seen (
      uuid       TEXT NOT NULL REFERENCES cloud_accounts(uuid) ON DELETE CASCADE,
      dedup_key  TEXT PRIMARY KEY,
      source_id  TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (uuid, source_id) REFERENCES account_agent_sources(uuid, source_id) ON DELETE CASCADE
    );
    CREATE TABLE account_agent_source_watermarks (
      uuid                   TEXT NOT NULL REFERENCES cloud_accounts(uuid) ON DELETE CASCADE,
      source_id              TEXT NOT NULL,
      mode                   TEXT NOT NULL CHECK(mode IN ('initial_subset','incremental','full')),
      baseline_at            TEXT,
      latest_seen_created_at TEXT,
      created_at             TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (uuid, source_id),
      FOREIGN KEY (uuid, source_id) REFERENCES account_agent_sources(uuid, source_id) ON DELETE CASCADE
    );
    INSERT INTO cloud_accounts (uuid) VALUES ('cloud-account-a');
  `);

  return createAgentSourceRepository(db);
}

function accountProfile(userId: string, email: string, nickname: string) {
  return {
    userId,
    email,
    phoneNumber: null,
    nickname,
    avatarUrl: null,
    planType: "free",
    hasFinishedGuide: false,
    region: null,
    registeredAt: "2026-06-08T10:00:00.000Z",
    rawProfile: { id: userId, email, userName: nickname }
  };
}
