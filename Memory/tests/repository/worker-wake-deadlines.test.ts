import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryDb } from "../../src/storage/db.js";
import { MAIN_DEADLINE, MAIN_TIMED, MAIN_LEASED, RETRY_DEADLINE, RETRY_LEASED } from "../../src/storage/queue-deadline-schema.js";
import { Repositories } from "../../src/storage/repositories.js";

const at = "2026-10-22T00:00:00.000Z", now = Date.parse(at);
const resources: Array<{ root: string; db: MemoryDb }> = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), "memmy-wake-deadline-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  resources.push({ root, db });
  const runtime = new Repositories(db.db).runtime;
  const iso = (offset: number) => new Date(now + offset).toISOString();
  function job(id: string, delay: number, target = id) {
    runtime.enqueueJob({ id, jobType: "trace_summary", targetMemoryId: target, userId: "user",
      payload: { runAfter: iso(delay) }, status: "queued", attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at });
  }
  function retry(id: string, delay: number, target = id) {
    runtime.enqueueEmbeddingRetry({ id, targetKind: "trace", targetId: target,
      vectorField: "vec_summary", sourceText: "synthetic", now: now + delay });
  }
  return { root, db, runtime, iso, job, retry };
}
afterEach(() => {
  for (const { root, db } of resources.splice(0)) { db.close(); rmSync(root, { recursive: true, force: true }); }
});

describe("future worker wake deadlines", () => {
  it.each(["owner", "lease"])("uses retry backoff when an in-progress row has no %s", missing => {
    const h = setup(); h.retry("orphan", 2000);
    h.db.db.prepare("UPDATE embedding_retry_queue SET status='in_progress',claimed_by=?,lease_until=? WHERE id='orphan'")
      .run(missing === "owner" ? null : "old-worker", missing === "lease" ? null : now + 10000);
    expect(h.runtime.nextWorkerRunAt({ futureAfterMs: now })).toBe(now + 2000);
    expect(h.runtime.nextWorkerRunAt({ futureAfterMs: now + 2000 })).toBeUndefined();
    expect(h.runtime.claimEmbeddingRetryById("orphan", { now: now + 2000, workerId: "new", leaseUntil: now + 30000 }))
      .toMatchObject({ claimedBy: "new", leaseToken: expect.any(String) });
  });

  it("upgrades the earlier lease-only index when reopening an existing database", () => {
    const h = setup(); h.retry("orphan", 2000);
    h.db.db.exec("DROP INDEX worker_retry_lease_deadline; CREATE INDEX worker_retry_lease_deadline ON embedding_retry_queue(MAX(next_attempt_at, lease_until)) WHERE status='in_progress' AND lease_until IS NOT NULL");
    h.db.db.prepare("UPDATE embedding_retry_queue SET status='in_progress',claimed_by=NULL,lease_until=NULL WHERE id='orphan'").run();
    h.db.close();
    const reopened = new MemoryDb({ path: join(h.root, "memory.sqlite") });
    try {
      expect(new Repositories(reopened.db).runtime.nextWorkerRunAt({ futureAfterMs: now })).toBe(now + 2000);
      expect((reopened.db.prepare("SELECT sql FROM sqlite_master WHERE name='worker_retry_lease_deadline'").get() as { sql: string }).sql)
        .toContain(RETRY_DEADLINE);
    } finally { reopened.close(); }
  });

  it("preserves tokens on reopen and observes writes from another connection", () => {
    const h = setup(); h.job("timed", 5000);
    const before = h.runtime.scheduling.getDeadlineRevision();
    const other = new Database(join(h.root, "memory.sqlite"));
    try {
      other.prepare("UPDATE evolution_jobs SET available_at=? WHERE id='timed'").run(h.iso(8000));
    } finally { other.close(); }
    const changed = h.runtime.scheduling.getDeadlineRevision();
    expect(changed.rescanRevision).toBe(before.rescanRevision + 1);
    h.db.close();
    const reopened = new MemoryDb({ path: join(h.root, "memory.sqlite") });
    try {
      const runtime = new Repositories(reopened.db).runtime;
      expect(runtime.scheduling.getDeadlineRevision()).toEqual(changed);
      expect(runtime.nextWorkerRunAt({ futureAfterMs: now })).toBe(now + 8000);
    } finally { reopened.close(); }
  });
  it("uses ordered partial indexes rather than scanning ordinary queued rows", () => {
    const h = setup(); h.job("timed", 5000);
    const queries = [
      [`SELECT ${MAIN_DEADLINE} FROM evolution_jobs INDEXED BY worker_main_deadline WHERE ${MAIN_TIMED} AND ${MAIN_DEADLINE} > ? ORDER BY ${MAIN_DEADLINE} LIMIT 1`, at, "worker_main_deadline"],
      [`SELECT leased_until FROM evolution_jobs INDEXED BY worker_main_lease_deadline WHERE ${MAIN_LEASED} AND leased_until > ? ORDER BY leased_until LIMIT 1`, at, "worker_main_lease_deadline"],
      [`SELECT ${RETRY_DEADLINE} FROM embedding_retry_queue INDEXED BY worker_retry_lease_deadline WHERE ${RETRY_LEASED} AND ${RETRY_DEADLINE} > ? ORDER BY ${RETRY_DEADLINE} LIMIT 1`, now, "worker_retry_lease_deadline"]
    ] as const;
    for (const [sql, param, index] of queries) {
      const plan = h.db.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(param) as Array<{ detail: string }>;
      expect(plan.some(row => row.detail.includes(index) && row.detail.includes("SEARCH"))).toBe(true);
      expect(plan.some(row => row.detail.includes("TEMP B-TREE"))).toBe(false);
    }
  });

  it("tracks raw timing/filter edits transactionally but ignores ordinary completion", () => {
    const h = setup(), revision = () => h.runtime.scheduling.getDeadlineRevision();
    const initial = revision(); h.job("timed", 5000);
    const inserted = revision();
    expect(inserted.revision).toBeGreaterThan(initial.revision);
    expect(inserted.rescanRevision).toBe(initial.rescanRevision);
    h.db.db.prepare("UPDATE evolution_jobs SET available_at=? WHERE id='timed'").run(h.iso(8000));
    const changed = revision(); expect(changed.rescanRevision).toBeGreaterThan(inserted.rescanRevision);
    expect(() => h.db.db.transaction(() => {
      h.db.db.prepare("UPDATE evolution_jobs SET available_at=? WHERE id='timed'").run(at);
      throw new Error("rollback");
    })()).toThrow("rollback");
    expect(revision()).toEqual(changed);
    h.db.db.prepare("UPDATE evolution_jobs SET status='succeeded',available_at=NULL WHERE id='timed'").run();
    expect(revision()).toEqual(changed);
    h.retry("retry", 5000); const retryBefore = revision();
    h.db.db.prepare("UPDATE embedding_retry_queue SET next_attempt_at=? WHERE id='retry'").run(now + 2000);
    expect(revision().rescanRevision).toBeGreaterThan(retryBefore.rescanRevision);
  });

  it("ignores due blocked heads without hiding a later scheduled job", () => {
    const h = setup(); h.job("already-due", -1); h.job("later", 5_000);
    expect(h.runtime.nextWorkerRunAt({ futureAfterMs: now })).toBe(now + 5_000);
    expect(h.runtime.nextWorkerRunAt({ futureAfterMs: now + 5_000 })).toBeUndefined();
  });
  it("uses the later of failure backoff and producer runAfter", () => {
    const h = setup(); h.job("delayed", 5_000);
    h.db.db.prepare("UPDATE evolution_jobs SET status='failed',available_at=? WHERE id='delayed'").run(h.iso(10_000));
    expect(h.runtime.nextWorkerRunAt({ futureAfterMs: now })).toBe(now + 10_000);
    expect(h.runtime.nextWorkerRunAt({ futureAfterMs: now + 6_000 })).toBe(now + 10_000);
  });
  it("honors target, type and configuration filters", () => {
    const h = setup(); h.job("other-target", 1_000, "other"); h.job("wanted", 5_000, "wanted");
    h.job("configuration", 500, "wanted");
    h.db.db.prepare("UPDATE evolution_jobs SET blocked_reason='configuration' WHERE id='configuration'").run();
    expect(h.runtime.nextWorkerRunAt({ futureAfterMs: now, targetMemoryIds: ["wanted"] })).toBe(now + 5_000);
    expect(h.runtime.nextWorkerRunAt({ futureAfterMs: now, targetMemoryIds: [] })).toBeUndefined();
    expect(h.runtime.nextWorkerRunAt({ futureAfterMs: now, jobTypes: [], includeEmbeddingRetries: false })).toBeUndefined();
    expect(h.runtime.nextWorkerRunAt({ futureAfterMs: now, excludedJobTypes: ["trace_summary"] })).toBeUndefined();
  });
  it("includes a future expired-lease opportunity rather than an already expired lease", () => {
    const h = setup(); h.job("expired", -2_000); h.job("leased", -2_000);
    h.db.db.prepare("UPDATE evolution_jobs SET status='leased',leased_until=? WHERE id='expired'").run(h.iso(-1_000));
    h.db.db.prepare("UPDATE evolution_jobs SET status='leased',leased_until=? WHERE id='leased'").run(h.iso(4_000));
    expect(h.runtime.nextWorkerRunAt({ futureAfterMs: now })).toBe(now + 4_000);
  });
  it("merges future retry deadlines with main jobs and preserves target filtering", () => {
    const h = setup(); h.retry("due-retry", -1); h.retry("later-retry", 3_000, "wanted");
    h.retry("other-retry", 1_000); h.job("main", 5_000, "wanted");
    expect(h.runtime.nextWorkerRunAt({ futureAfterMs: now, targetMemoryIds: ["wanted"] })).toBe(now + 3_000);
    expect(h.runtime.nextWorkerRunAt({ futureAfterMs: now, targetMemoryIds: ["wanted"], includeEmbeddingRetries: false })).toBe(now + 5_000);
  });
  it("waits for both retry backoff and an in-progress lease to expire", () => {
    const h = setup(); h.retry("in-progress", 2_000);
    h.db.db.prepare("UPDATE embedding_retry_queue SET status='in_progress',claimed_by='worker-A',lease_until=? WHERE id='in-progress'").run(now + 6_000);
    expect(h.runtime.nextWorkerRunAt({ futureAfterMs: now })).toBe(now + 6_000);
    expect(h.runtime.nextWorkerRunAt({ futureAfterMs: now + 6_000 })).toBeUndefined();
  });
});
