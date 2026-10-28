import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../../src/storage/db.js";
import { rollbackPanelSchema, PANEL_BASE_SCHEMA_VERSION } from "../../src/storage/panel-rollback.js";
import { migrate, SCHEMA_VERSION, SCHEMA_MIGRATION_ID } from "../../src/storage/schema.js";
import { Repositories } from "../../src/storage/repositories.js";

describe("panel index migration", () => {
  it("upgrades and rolls back v13 panel objects without changing queue claims or retry counters", () => {
    const root = mkdtempSync(join(tmpdir(), "panel-queue-v13-"));
    const path = join(root,"memory.sqlite");
    let db: MemoryDb | undefined;
    try {
      db = new MemoryDb({path});
      const repos = new Repositories(db.db), at = "2026-10-28T00:00:00.000Z";
      repos.runtime.enqueueJob({id:"preserved-claim",jobType:"reflection",status:"queued",userId:"synthetic",attempts:0,maxAttempts:3,payload:{},createdAt:at,updatedAt:at});
      repos.runtime.leaseQueuedJobs(1);
      repos.runtime.enqueueEmbeddingRetry({targetKind:"trace",targetId:"retry-source",vectorField:"vec_summary",sourceText:"synthetic",now:Date.parse(at)});
      repos.runtime.claimDueEmbeddingRetries({now:Date.parse(at),workerId:"synthetic-worker",leaseUntil:Date.parse(at)+60_000});
      const capture = () => ({
        jobs: db!.db.prepare("SELECT * FROM evolution_jobs ORDER BY id").all(),
        retries: db!.db.prepare("SELECT * FROM embedding_retry_queue ORDER BY id").all(),
        deadlines: db!.db.prepare("SELECT * FROM worker_deadline_revision ORDER BY singleton").all()
      });
      const before = capture();
      rollbackPanelSchema(db.db);
      expect(db.schemaVersion().version).toBe(13);
      db.close();
      db = new MemoryDb({path});
      expect(db.schemaVersion().version).toBe(14);
      expect(capture()).toEqual(before);
      const backup = new MemoryDb({path:`${path}.pre-v14.bak`,readonly:true});
      try { expect(backup.schemaVersion().version).toBe(13); }
      finally { backup.close(); }
      rollbackPanelSchema(db.db);
      expect(db.schemaVersion().version).toBe(13);
      expect(capture()).toEqual(before);
      migrate(db.db);
      expect(db.schemaVersion().version).toBe(14);
      expect(capture()).toEqual(before);
    } finally {
      if(db?.db.open)db.close();
      rmSync(root,{recursive:true,force:true});
    }
  });

  it("backs up an old file library and can reopen and repeat without changing facts", () => {
    const root = mkdtempSync(join(tmpdir(), "panel-migration-"));
    const path = join(root, "memory.sqlite");
    let db: MemoryDb | undefined;
    try {
      db = new MemoryDb({ path });
      db.db.prepare("DELETE FROM schema_migrations").run();
      db.db.prepare("INSERT INTO schema_migrations VALUES ('009_token_usage_outbox', 9, '2026-10-01', 'old')").run();
      db.db.prepare("DROP INDEX idx_memories_panel_created").run();
      db.db
        .prepare(
          "INSERT INTO runtime_kv (key, value_json, updated_at) VALUES ('panel-test-fact', '\"kept\"', '2026-10-01')"
        )
        .run();
      db.close();
      db = new MemoryDb({ path });
      expect(existsSync(`${path}.pre-v${SCHEMA_VERSION}.bak`)).toBe(true);
      expect(db.schemaVersion()).toEqual({ version: SCHEMA_VERSION, lastMigrationId: SCHEMA_MIGRATION_ID });
      migrate(db.db);
      expect(db.db.prepare("SELECT value_json FROM runtime_kv WHERE key = 'panel-test-fact'").pluck().get()).toBe(
        '"kept"'
      );
      const plan = db.db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT id FROM memories WHERE deleted_at IS NULL AND memory_layer = 'L1' ORDER BY created_at DESC, updated_at DESC, id DESC LIMIT 20"
        )
        .all() as { detail: string }[];
      expect(plan.some((row) => row.detail.includes("idx_memories_panel_created"))).toBe(true);
      expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false);
      const backup = new MemoryDb({ path: `${path}.pre-v${SCHEMA_VERSION}.bak`, readonly: true });
      expect(backup.schemaVersion().version).toBe(9);
      expect(backup.db.prepare("SELECT value_json FROM runtime_kv WHERE key = 'panel-test-fact'").pluck().get()).toBe(
        '"kept"'
      );
      backup.close();
    } finally {
      if (db?.db.open) db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rolls back index creation failures and safely retries", () => {
    const db = new MemoryDb({ path: ":memory:" });
    try {
      db.db.prepare("DROP INDEX idx_memories_panel_created").run();
      db.db.prepare("DELETE FROM schema_migrations").run();
      db.db.prepare("INSERT INTO schema_migrations VALUES ('009_token_usage_outbox', 9, '2026-10-01', 'old')").run();
      const prepare = db.db.prepare.bind(db.db);
      const fail = vi.spyOn(db.db, "prepare").mockImplementation((sql) => {
        if (sql.includes("CREATE INDEX IF NOT EXISTS idx_memories_panel_status_created"))
          throw new Error("database or disk is full");
        return prepare(sql);
      });
      expect(() => migrate(db.db)).toThrow("database or disk is full");
      fail.mockRestore();
      expect(db.schemaVersion().version).toBe(9);
      expect(
        db.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_memories_panel_created'").get()
      ).toBeUndefined();
      migrate(db.db);
      expect(db.schemaVersion().version).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });
  it("rolls back additive objects without losing facts written after upgrade", () => {
    const db = new MemoryDb({ path: ":memory:" });
    try {
      db.db.prepare("INSERT INTO runtime_kv VALUES('new-fact','123','now')").run();
      rollbackPanelSchema(db.db);
      rollbackPanelSchema(db.db);
      expect(db.schemaVersion().version).toBe(PANEL_BASE_SCHEMA_VERSION);
      expect(db.db.prepare("SELECT value_json FROM runtime_kv WHERE key='new-fact'").pluck().get()).toBe("123");
      expect(
        db.db.prepare("SELECT name FROM sqlite_master WHERE name='idx_memories_panel_created'").get()
      ).toBeUndefined();
      migrate(db.db);
      expect(db.schemaVersion().version).toBe(SCHEMA_VERSION);
      expect(db.db.prepare("SELECT value_json FROM runtime_kv WHERE key='new-fact'").pluck().get()).toBe("123");
    } finally {
      db.close();
    }
  });

  it("leaves the old schema usable after a real SQLITE_FULL and retries with space", () => {
    const db = new MemoryDb({ path: ":memory:" });
    try {
      rollbackPanelSchema(db.db);
      const insert = db.db
        .prepare(`INSERT INTO memories(id,timeline,user_id,memory_value,memory_layer,created_at,updated_at)
        VALUES(?, 'now','user',?,'L1','now','now')`);
      db.db.transaction(() => {
        for (let i = 0; i < 1500; i++) insert.run(`id-${i}`, "x".repeat(500));
      })();
      const pages = Number(db.db.pragma("page_count", { simple: true }));
      db.db.pragma(`max_page_count=${pages}`);
      expect(() => migrate(db.db)).toThrow(/full/);
      expect(db.schemaVersion().version).toBe(PANEL_BASE_SCHEMA_VERSION);
      expect(db.db.prepare("SELECT count(*) FROM memories").pluck().get()).toBe(1500);
      db.db.pragma(`max_page_count=${pages + 1000}`);
      migrate(db.db);
      expect(db.schemaVersion().version).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("refuses a partial preexisting backup and retries after it is moved aside", () => {
    const root = mkdtempSync(join(tmpdir(), "panel-backup-"));
    const path = join(root, "memory.sqlite");
    try {
      const db = new MemoryDb({ path });
      rollbackPanelSchema(db.db);
      db.close();
      writeFileSync(`${path}.pre-v${SCHEMA_VERSION}.bak`, "incomplete backup");
      expect(() => new MemoryDb({ path })).toThrow();
      const original = new MemoryDb({ path, readonly: true });
      expect(original.schemaVersion().version).toBe(PANEL_BASE_SCHEMA_VERSION);
      original.close();
      rmSync(`${path}.pre-v${SCHEMA_VERSION}.bak`);
      const retry = new MemoryDb({ path });
      expect(retry.schemaVersion().version).toBe(SCHEMA_VERSION);
      retry.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
