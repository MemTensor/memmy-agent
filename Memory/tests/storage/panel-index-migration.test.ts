import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../../src/storage/db.js";
import { rollbackPanelSchema } from "../../src/storage/panel-rollback.js";
import { migrate, SCHEMA_VERSION, SCHEMA_MIGRATION_ID } from "../../src/storage/schema.js";

describe("panel index migration", () => {
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
      expect(db.schemaVersion().version).toBe(9);
      expect(db.db.prepare("SELECT value_json FROM runtime_kv WHERE key='new-fact'").pluck().get()).toBe("123");
      expect(
        db.db.prepare("SELECT name FROM sqlite_master WHERE name='idx_memories_panel_created'").get()
      ).toBeUndefined();
      migrate(db.db);
      expect(db.schemaVersion().version).toBe(10);
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
      expect(db.schemaVersion().version).toBe(9);
      expect(db.db.prepare("SELECT count(*) FROM memories").pluck().get()).toBe(1500);
      db.db.pragma(`max_page_count=${pages + 1000}`);
      migrate(db.db);
      expect(db.schemaVersion().version).toBe(10);
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
      writeFileSync(`${path}.pre-v10.bak`, "incomplete backup");
      expect(() => new MemoryDb({ path })).toThrow();
      const original = new MemoryDb({ path, readonly: true });
      expect(original.schemaVersion().version).toBe(9);
      original.close();
      rmSync(`${path}.pre-v10.bak`);
      const retry = new MemoryDb({ path });
      expect(retry.schemaVersion().version).toBe(10);
      retry.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
