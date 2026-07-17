import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryDb } from "../../src/index.js";
import { Repositories } from "../../src/storage/repositories.js";

const LOG_RETENTION_LIMIT = 10_000;

describe("runtime log retention", () => {
  it("keeps only the latest 10000 rows in log tables and leaves other tables untouched", async () => {
    const root = mkdtempSync(join(tmpdir(), "mindock-log-retention-"));
    try {
      const db = new MemoryDb({ path: join(root, "memory.sqlite") });
      const repos = new Repositories(db.db);

      seedApiLogs(db, LOG_RETENTION_LIMIT);
      repos.runtime.insertApiLog({
        toolName: "memory_add",
        inputJson: "{}",
        outputJson: "{}",
        durationMs: 1,
        success: true,
        calledAt: isoAt(LOG_RETENTION_LIMIT)
      });
      expect(countRows(db, "api_logs")).toBe(LOG_RETENTION_LIMIT + 1);
      await waitForRowCount(db, "api_logs", LOG_RETENTION_LIMIT);
      expect(countRows(db, "api_logs")).toBe(LOG_RETENTION_LIMIT);
      expect(db.db.prepare(`SELECT id FROM api_logs WHERE id = 1`).get()).toBeUndefined();
      expect(db.db.prepare(`SELECT id FROM api_logs WHERE id = ?`).get(LOG_RETENTION_LIMIT + 1)).toBeTruthy();

      seedChangeLogs(db, LOG_RETENTION_LIMIT);
      repos.runtime.appendChange({
        memoryId: "mem-new",
        userId: "user",
        changeType: "test",
        source: "test",
        createdAt: isoAt(LOG_RETENTION_LIMIT)
      });
      expect(countRows(db, "memory_change_log")).toBe(LOG_RETENTION_LIMIT + 1);
      await waitForRowCount(db, "memory_change_log", LOG_RETENTION_LIMIT);
      expect(countRows(db, "memory_change_log")).toBe(LOG_RETENTION_LIMIT);
      expect(db.db.prepare(`SELECT seq FROM memory_change_log WHERE seq = 1`).get()).toBeUndefined();
      expect(db.db.prepare(`SELECT seq FROM memory_change_log WHERE seq = ?`).get(LOG_RETENTION_LIMIT + 1)).toBeTruthy();

      seedAuditLogs(db, LOG_RETENTION_LIMIT);
      repos.runtime.insertAudit({
        id: "audit-new",
        userId: "user",
        actor: {},
        action: "test",
        targetKind: "memory",
        targetId: "mem-new",
        meta: {},
        createdAt: isoAt(LOG_RETENTION_LIMIT)
      });
      expect(countRows(db, "audit_logs")).toBe(LOG_RETENTION_LIMIT + 1);
      await waitForRowCount(db, "audit_logs", LOG_RETENTION_LIMIT);
      expect(countRows(db, "audit_logs")).toBe(LOG_RETENTION_LIMIT);
      expect(db.db.prepare(`SELECT id FROM audit_logs WHERE id = 'audit-0'`).get()).toBeUndefined();
      expect(db.db.prepare(`SELECT id FROM audit_logs WHERE id = 'audit-new'`).get()).toBeTruthy();

      seedRecallEvents(db, LOG_RETENTION_LIMIT);
      repos.runtime.insertRecallEvent({
        id: "recall-new",
        userId: "user",
        query: "latest",
        layers: [],
        hitMemoryIds: [],
        request: {},
        createdAt: isoAt(LOG_RETENTION_LIMIT)
      });
      expect(countRows(db, "recall_events")).toBe(LOG_RETENTION_LIMIT + 1);

      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function seedApiLogs(db: MemoryDb, count: number): void {
  const insert = db.db.prepare(
    `INSERT INTO api_logs (
      tool_name, input_json, output_json, duration_ms, success, called_at
    ) VALUES (?, '{}', '{}', 1, 1, ?)`
  );
  db.db.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      insert.run(i % 2 === 0 ? "memory_add" : "memory_search", isoAt(i));
    }
  })();
}

function seedChangeLogs(db: MemoryDb, count: number): void {
  const insert = db.db.prepare(
    `INSERT INTO memory_change_log (
      memory_id, user_id, change_type, source, created_at
    ) VALUES (?, 'user', 'test', 'seed', ?)`
  );
  db.db.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      insert.run(`mem-${i}`, isoAt(i));
    }
  })();
}

function seedAuditLogs(db: MemoryDb, count: number): void {
  const insert = db.db.prepare(
    `INSERT INTO audit_logs (
      id, user_id, actor_json, action, target_kind, target_id, meta_json, created_at
    ) VALUES (?, 'user', '{}', 'seed', 'memory', ?, '{}', ?)`
  );
  db.db.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      insert.run(`audit-${i}`, `mem-${i}`, isoAt(i));
    }
  })();
}

function seedRecallEvents(db: MemoryDb, count: number): void {
  const insert = db.db.prepare(
    `INSERT INTO recall_events (
      id, user_id, query, layers_json, candidate_memory_ids_json,
      injected_memory_ids_json, hit_memory_ids_json, dropped_json,
      outcome, request_json, created_at
    ) VALUES (?, 'user', ?, '[]', '[]', '[]', '[]', '[]', 'pending', '{}', ?)`
  );
  db.db.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      insert.run(`recall-${i}`, `query-${i}`, isoAt(i));
    }
  })();
}

function countRows(db: MemoryDb, table: string): number {
  const row = db.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

async function waitForRowCount(db: MemoryDb, table: string, expected: number): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (countRows(db, table) === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(countRows(db, table)).toBe(expected);
}

function isoAt(offsetMs: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, offsetMs)).toISOString();
}
