import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryDb } from "../../src/storage/db.js";
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
  return { db, runtime, iso, job, retry };
}
afterEach(() => {
  for (const { root, db } of resources.splice(0)) { db.close(); rmSync(root, { recursive: true, force: true }); }
});

describe("future worker wake deadlines", () => {
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
    h.db.db.prepare("UPDATE embedding_retry_queue SET status='in_progress',lease_until=? WHERE id='in-progress'").run(now + 6_000);
    expect(h.runtime.nextWorkerRunAt({ futureAfterMs: now })).toBe(now + 6_000);
    expect(h.runtime.nextWorkerRunAt({ futureAfterMs: now + 6_000 })).toBeUndefined();
  });
});
