import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryDb } from "../../src/storage/db.js";
import { Repositories } from "../../src/storage/repositories.js";
import { withJobLeaseGuard } from "../../src/storage/job-lease-context.js";
import { compactHistoryChangeJson, compactHistoryChangePayload } from "../../src/storage/history-change-snapshot.js";
import { sha256Hex } from "../../src/contracts/memory-canonical-json.js";
import type { MemoryRow } from "../../src/types.js";

const source = "# 项目约束 😀\n" + "修改前需要检查来源和兼容性。\n".repeat(400);
const at = "2026-10-09T10:00:00.000Z";

function history(state: "pending" | "processed" | "skipped" | undefined = "pending"): MemoryRow {
  return { id: "observation_test", userId: "user", agentId: "memmy", timeline: at,
    memoryType: "LongTermMemory", memoryLayer: "L1", status: "activated", visibility: "private",
    memoryValue: state === "processed" ? "修改应保持接口兼容。" : state === "skipped" ? "" : source,
    version: 7, createdAt: at, updatedAt: at, tags: ["computer_history"], info: { title: "项目约束" },
    properties: { internal_info: { memory_layer: "L1", memory_kind: "observed_activity",
      ...(state ? { observation_memory: { schema_version: 1, status: state, source_hash: "input-hash" } } : {}),
      external_evidence: { source: "computer_history", sourceRecordId: "2026-10-09T10-00-00Z-10min-summary",
        source_content: source, revision: at, namespace: { userId: "user", source: "memmy", profileId: "default" } } } } };
}

describe("History change log storage", () => {
  it("lets independently scheduled History compaction finish after its originating task completes", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-history-compaction-lease-"));
    const db = new MemoryDb({ path: join(root, "memory.sqlite") });
    try {
      const repos = new Repositories(db.db);
      // Complete the initial empty startup pass so it cannot mask the pass
      // deliberately scheduled from an active task context below.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const current = new Date().toISOString();
      repos.runtime.enqueueJob({ id: "history-maintenance-origin", jobType: "reflection", status: "queued",
        userId: "user", payload: {}, attempts: 0, maxAttempts: 3, createdAt: current, updatedAt: current });
      const [claim] = repos.runtime.leaseQueuedJobs(1);
      const raw = JSON.stringify(history());
      db.db.prepare(`INSERT INTO memory_change_log
        (memory_id, user_id, change_type, after_json, source, created_at)
        VALUES ('observation_test', 'user', 'updated', ?, 'legacy', ?)`).run(raw, at);
      withJobLeaseGuard(claim!, () => repos.runtime.isJobLeaseHeld(claim!), () => new Repositories(db.db));
      expect(repos.runtime.completeJob(claim!.id, undefined, claim)?.status).toBe("succeeded");
      await waitUntil(() => !(db.db.prepare("SELECT after_json FROM memory_change_log").get() as { after_json: string })
        .after_json.includes('"source_content":'));
      expect((db.db.prepare("SELECT after_json FROM memory_change_log").get() as { after_json: string })
        .after_json).toBe(JSON.stringify(compactHistoryChangePayload(history())));
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("omits input copies without mutating the current snapshot and records exact UTF-8 evidence", () => {
    const original = history();
    const before = JSON.stringify(original);
    const compact = compactHistoryChangePayload(original) as MemoryRow;
    expect(JSON.stringify(original)).toBe(before);
    expect(compact.memoryValue).toBe("");
    expect(compact.properties.internal_info.external_evidence).not.toHaveProperty("source_content");
    expect(compact.properties.internal_info.change_log_projection).toEqual({ schema_version: 1,
      source_content_omitted: true, source_content_sha256: sha256Hex(source), source_content_bytes: Buffer.byteLength(source),
      memory_value_omitted: true, memory_value_sha256: sha256Hex(source), memory_value_bytes: Buffer.byteLength(source) });
    expect(compactHistoryChangePayload(compact)).toBe(compact);
    const text = JSON.stringify(compact);
    expect(compactHistoryChangeJson(text)).toBe(text);
    expect(Buffer.byteLength(text)).toBeLessThan(Buffer.byteLength(before) / 10);
  });

  it("keeps processed memory and skipped state while handling old snapshots without extraction metadata", () => {
    const processed = history("processed");
    const compact = compactHistoryChangePayload(processed) as MemoryRow;
    expect(compact.memoryValue).toBe(processed.memoryValue);
    expect(compact.properties.internal_info.change_log_projection).not.toHaveProperty("memory_value_omitted");
    processed.memoryValue = source;
    expect((compactHistoryChangePayload(processed) as MemoryRow).memoryValue).toBe(source);
    (processed.properties.internal_info.observation_memory as Record<string, unknown>).source_revision = at;
    expect((compactHistoryChangePayload(processed) as MemoryRow).memoryValue).toBe(source);
    (processed.properties.internal_info.external_evidence as Record<string, unknown>).revision = "2026-10-09T10:10:00.000Z";
    expect((compactHistoryChangePayload(processed) as MemoryRow).memoryValue).toBe("");
    const skipped = compactHistoryChangePayload(history("skipped")) as MemoryRow;
    expect(skipped.properties.internal_info.observation_memory).toEqual(history("skipped").properties.internal_info.observation_memory);
    const legacy = history(undefined);
    delete legacy.properties.internal_info.observation_memory;
    delete (legacy.properties.internal_info.external_evidence as Record<string, unknown>).source_content;
    const old = compactHistoryChangePayload(legacy) as MemoryRow;
    expect(old.memoryValue).toBe("");
    expect(old.properties.internal_info.change_log_projection).toMatchObject({ memory_value_omitted: true,
      memory_value_bytes: Buffer.byteLength(source), memory_value_sha256: sha256Hex(source) });
  });

  it("only recognizes canonical History or the narrow legacy aliases", () => {
    const legacy = history();
    const origin = legacy.properties.internal_info.external_evidence as Record<string, unknown>;
    origin.source = "memmy";
    expect(compactHistoryChangePayload(legacy)).not.toBe(legacy);
    origin.sourceRecordId = "custom-history-id";
    expect(compactHistoryChangePayload(legacy)).toBe(legacy);
    origin.provenance = { historyId: origin.sourceRecordId };
    expect(compactHistoryChangePayload(legacy)).not.toBe(legacy);
    legacy.agentId = "other";
    expect(compactHistoryChangePayload(legacy)).toBe(legacy);
    const trace = history();
    trace.properties.internal_info.memory_kind = "trace";
    expect(compactHistoryChangePayload(trace)).toBe(trace);
    const other = history();
    (other.properties.internal_info.external_evidence as Record<string, unknown>).source = "other";
    expect(compactHistoryChangePayload(other)).toBe(other);
  });

  it("preserves malformed, absent and unrelated log payloads exactly", () => {
    for (const value of [null, undefined, 17, [], "{broken observed_activity", '{"x": "observed_activity"}', '{ "memoryValue" : "text" }']) {
      expect(compactHistoryChangeJson(value)).toBe(value);
      expect(compactHistoryChangePayload(value)).toBe(value);
    }
    const escaped = JSON.stringify(history()).replace('"observed_activity"', '"observed\\u005factivity"');
    expect(JSON.parse(compactHistoryChangeJson(escaped) as string).memoryValue).toBe("");
  });

  it("compacts more than one startup batch without changing sequences, current memories or other logs", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-history-log-"));
    const db = new MemoryDb({ path: join(root, "memory.sqlite") });
    try {
      const snapshot = history();
      const raw = JSON.stringify(snapshot);
      const insert = db.db.prepare(`INSERT INTO memory_change_log
        (seq, memory_id, namespace_id, kind, op, user_id, change_type, version, before_json, after_json, source, created_at)
        VALUES (?, ?, 'namespace', 'observed_activity', 'updated', 'user', 'update', 7, ?, ?, 'test', ?)`);
      db.db.transaction(() => {
        for (let i = 1; i <= 430; i++) insert.run(i * 3, snapshot.id, raw, raw, at);
        insert.run(1500, "trace", null, '{ "memoryValue": "ordinary text" }', at);
        insert.run(1600, "bad", null, '{"kind":"observed_activity",broken', at);
      })();
      const metadataSql = `SELECT seq, memory_id, namespace_id, kind, op, user_id, change_type, version, source, created_at FROM memory_change_log ORDER BY seq`;
      const metadata = db.db.prepare(metadataSql).all();
      const bytes = () => (db.db.prepare(`SELECT SUM(length(CAST(COALESCE(before_json, '') AS BLOB)) + length(CAST(COALESCE(after_json, '') AS BLOB))) AS bytes FROM memory_change_log`).get() as { bytes: number }).bytes;
      const oldBytes = bytes();
      const repos = new Repositories(db.db);
      repos.memories.insert(snapshot);
      const memorySql = `SELECT memory_value, properties_json FROM memories WHERE id = ?`;
      const current = db.db.prepare(memorySql).get(snapshot.id);
      await waitUntil(() => !(db.db.prepare(`SELECT after_json FROM memory_change_log WHERE seq = 1290`).get() as { after_json: string }).after_json.includes('"source_content":'));
      expect(db.db.prepare(metadataSql).all()).toEqual(metadata);
      expect(bytes()).toBeLessThan(oldBytes / 10);
      expect(db.db.prepare(memorySql).get(snapshot.id)).toEqual(current);
      expect(repos.runtime.listChanges(undefined, 3, 1287).map(row => row.seq)).toEqual([1600, 1500, 1290]);
      const compactBefore = db.db.prepare(`SELECT before_json, after_json FROM memory_change_log ORDER BY seq`).all();
      new Repositories(db.db);
      await new Promise<void>(resolve => setImmediate(resolve));
      await new Promise<void>(resolve => setImmediate(resolve));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(db.db.prepare(`SELECT before_json, after_json FROM memory_change_log ORDER BY seq`).all()).toEqual(compactBefore);
      expect(db.db.prepare(`SELECT after_json FROM memory_change_log WHERE seq = 1500`).get()).toEqual({ after_json: '{ "memoryValue": "ordinary text" }' });
      expect(db.db.prepare(`SELECT after_json FROM memory_change_log WHERE seq = 1600`).get()).toEqual({ after_json: '{"kind":"observed_activity",broken' });
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("does not write through a read-only database or after the database closes", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-history-log-readonly-"));
    const file = join(root, "memory.sqlite");
    try {
      const db = new MemoryDb({ path: file });
      const text = JSON.stringify(history());
      db.db.prepare(`INSERT INTO memory_change_log (memory_id, user_id, change_type, after_json, source, created_at)
        VALUES ('observation', 'user', 'test', ?, 'test', ?)`).run(text, at);
      db.close();
      const readOnly = new MemoryDb({ path: file, readonly: true });
      new Repositories(readOnly.db);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(readOnly.db.prepare(`SELECT after_json FROM memory_change_log`).get()).toEqual({ after_json: text });
      readOnly.close();
      const reopened = new MemoryDb({ path: file });
      new Repositories(reopened.db);
      reopened.close();
      await new Promise<void>(resolve => setImmediate(resolve));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("does not overwrite a log snapshot replaced by another database connection during compaction", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-history-log-race-"));
    const file = join(root, "memory.sqlite");
    const first = new MemoryDb({ path: file });
    const second = new MemoryDb({ path: file });
    try {
      const raw = JSON.stringify(history());
      const replacement = JSON.stringify({ ...history("processed"), version: 8, memoryValue: "另一个连接保存的新版本。" });
      first.db.prepare(`INSERT INTO memory_change_log (memory_id, user_id, change_type, after_json, source, created_at)
        VALUES ('observation', 'user', 'test', ?, 'test', ?)`).run(raw, at);
      const prepare = first.db.prepare.bind(first.db);
      let replaced = false;
      first.db.prepare = ((sql: string) => {
        const statement = prepare(sql);
        if (sql.includes("SELECT seq, before_json, after_json FROM memory_change_log")) {
          const all = statement.all.bind(statement);
          statement.all = ((...params: unknown[]) => {
            const rows = all(...params);
            if (!replaced) {
              second.db.prepare(`UPDATE memory_change_log SET after_json = ? WHERE seq = 1`).run(replacement);
              replaced = true;
            }
            return rows;
          }) as typeof statement.all;
        }
        return statement;
      }) as typeof first.db.prepare;
      new Repositories(first.db);
      await waitUntil(() => replaced);
      expect(first.db.prepare(`SELECT after_json FROM memory_change_log WHERE seq = 1`).get()).toEqual({ after_json: replacement });
    } finally { first.close(); second.close(); rmSync(root, { recursive: true, force: true }); }
  });
});

async function waitUntil(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!ready() && Date.now() < deadline) await new Promise<void>(resolve => setImmediate(resolve));
  expect(ready()).toBe(true);
}
