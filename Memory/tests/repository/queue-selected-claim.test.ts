import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryDb } from "../../src/storage/db.js";
import { Repositories, type EvolutionJobRecord } from "../../src/storage/repositories.js";

const at = "2026-10-22T00:00:00.000Z", now = Date.parse(at);
const resources: Array<{ db: MemoryDb; root: string }> = [];
function harness() {
  const root = mkdtempSync(join(tmpdir(), "memmy-selected-claim-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  resources.push({ db, root });
  const repos = new Repositories(db.db), runtime = repos.runtime;
  function job(id: string, jobType: EvolutionJobRecord["jobType"] = "reflection", targetMemoryId?: string) {
    return runtime.enqueueJob({ id, jobType, targetMemoryId, userId: "user", status: "queued", payload: {},
      attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at });
  }
  function retry(id: string) {
    return runtime.enqueueEmbeddingRetry({ id, targetKind: "trace", targetId: id, vectorField: "vec_summary", sourceText: id, now });
  }
  return { db, repos, runtime, job, retry };
}
afterEach(() => {
  for (const { db, root } of resources.splice(0)) {
    if (db.db.open) db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

describe("selected-id claims for joint scheduling", () => {
  it("claims the selected job instead of substituting the legacy highest-priority head", () => {
    const h = harness(); h.job("legacy-first", "trace_summary"); h.job("chosen-reflection");
    const chosen = h.runtime.claimQueuedJob("chosen-reflection", { at, owner: "scheduler", leaseSeconds: 90 });
    expect(chosen).toMatchObject({ id: "chosen-reflection", status: "leased", leaseOwner: "scheduler", attempts: 1,
      leaseCount: 1, failureCount: 0, leasedUntil: new Date(now + 90_000).toISOString() });
    expect(chosen!.leaseToken).toEqual(expect.any(String));
    expect(h.runtime.getJob("legacy-first")).toMatchObject({ status: "queued", attempts: 0 });
    expect(h.runtime.claimQueuedJob("chosen-reflection", { at })).toBeUndefined();
    expect(h.runtime.claimQueuedJob("' OR 1=1 --", { at })).toBeUndefined();
  });

  it("rechecks target, type, deadlines, configuration and failure budget before claiming", () => {
    const h = harness();
    for (const id of ["ready", "future", "runAfter", "config", "exhausted"]) h.job(id, "reflection", "target");
    h.db.db.prepare("UPDATE evolution_jobs SET available_at=? WHERE id='future'").run(new Date(now + 1_000).toISOString());
    h.db.db.prepare("UPDATE evolution_jobs SET payload_json=? WHERE id='runAfter'").run(JSON.stringify({ runAfter: new Date(now + 1_000).toISOString() }));
    h.db.db.prepare("UPDATE evolution_jobs SET blocked_reason='configuration' WHERE id='config'").run();
    h.db.db.prepare("UPDATE evolution_jobs SET failure_count=max_attempts WHERE id='exhausted'").run();
    for (const id of ["future", "runAfter", "config", "exhausted"]) expect(h.runtime.claimQueuedJob(id, { at })).toBeUndefined();
    for (const filters of [{ targetMemoryIds: [] }, { targetMemoryIds: ["other"] }, { allowedJobTypes: [] },
      { allowedJobTypes: ["embedding"] }, { excludedJobTypes: ["reflection"] }]) {
      expect(h.runtime.claimQueuedJob("ready", { at, ...filters })).toBeUndefined();
    }
    expect(h.runtime.claimQueuedJob("ready", { at, targetMemoryIds: ["target"], allowedJobTypes: ["reflection"] })?.id).toBe("ready");
  });

  it("retains dependency and scope ordering checks in the selected-id path", () => {
    const h = harness();
    h.db.db.prepare(`INSERT INTO memories(id,timeline,user_id,memory_value,memory_layer,created_at,updated_at)
      VALUES ('dependency',?,'user','text','L1',?,?)`).run(at, at, at);
    h.db.db.prepare(`INSERT INTO memory_processing_state(memory_id,state,stage,updated_at)
      VALUES ('dependency','embedding_pending','embedding',?)`).run(at);
    h.job("reward", "reward");
    h.db.db.prepare("UPDATE evolution_jobs SET payload_json=? WHERE id='reward'").run('{"l1MemoryId":"dependency","polarity":"positive"}');
    h.job("scope-first", "work_memory_extract"); h.job("scope-second", "work_memory_extract");
    h.db.db.prepare("UPDATE evolution_jobs SET scope_key='scope',scope_seq=1 WHERE id='scope-first'").run();
    h.db.db.prepare("UPDATE evolution_jobs SET scope_key='scope',scope_seq=2 WHERE id='scope-second'").run();
    expect(h.runtime.claimQueuedJob("reward", { at })).toBeUndefined();
    expect(h.runtime.claimQueuedJob("scope-second", { at })).toBeUndefined();
    const first = h.runtime.claimQueuedJob("scope-first", { at })!;
    expect(h.runtime.claimQueuedJob("scope-second", { at })).toBeUndefined();
    h.runtime.completeJob(first.id, at, first);
    expect(h.runtime.claimQueuedJob("scope-second", { at })?.id).toBe("scope-second");
  });

  it("recovers an expired main claim with a new generation without charging a business failure", () => {
    const h = harness(); h.job("recover");
    const a = h.runtime.claimQueuedJob("recover", { at, owner: "same", leaseSeconds: 1 })!;
    const later = new Date(now + 1_000).toISOString();
    const b = h.runtime.claimQueuedJob("recover", { at: later, owner: "same" })!;
    expect(b.leaseToken).not.toBe(a.leaseToken);
    expect(b).toMatchObject({ attempts: 1, leaseCount: 2, leaseRecoveryCount: 1, failureCount: 0 });
    expect(h.runtime.completeJob(a.id, later, a)).toBeUndefined();
    expect(h.runtime.failJob(a.id, "stale", later, false, a)).toBeUndefined();
    expect(h.runtime.completeJob(b.id, later, b)?.status).toBe("succeeded");
  });

  it("claims only the chosen retry and rechecks readiness plus target filters", () => {
    const h = harness(); h.retry("first"); h.retry("chosen");
    const input = { now, workerId: "worker", leaseUntil: now + 60_000 };
    expect(h.runtime.claimEmbeddingRetryById("chosen", { ...input, targetMemoryIds: [] })).toBeUndefined();
    expect(h.runtime.claimEmbeddingRetryById("chosen", { ...input, targetMemoryIds: ["first"] })).toBeUndefined();
    const chosen = h.runtime.claimEmbeddingRetryById("chosen", input)!;
    expect(chosen).toMatchObject({ id: "chosen", status: "in_progress", claimedBy: "worker", attempts: 0 });
    expect(chosen.leaseToken).toEqual(expect.any(String));
    expect(h.runtime.getEmbeddingRetry("first")!.status).toBe("pending");
    expect(h.runtime.claimEmbeddingRetryById("chosen", input)).toBeUndefined();
    h.db.db.prepare("UPDATE embedding_retry_queue SET next_attempt_at=? WHERE id='first'").run(now + 1);
    expect(h.runtime.claimEmbeddingRetryById("first", input)).toBeUndefined();
    expect(h.runtime.claimEmbeddingRetryById("first", { ...input, now: now + 1 })?.id).toBe("first");
  });

  it("returns unstarted retry claims using current fencing credentials, preserving retry history", () => {
    const h = harness(); h.retry("release");
    const input = { now, workerId: "worker", leaseUntil: now + 10_000 };
    const old = h.runtime.claimEmbeddingRetryById("release", input)!;
    const renewed = h.runtime.renewEmbeddingRetryClaim(old.id, { workerId: old.claimedBy!, leaseUntil: old.leaseUntil!, leaseToken: old.leaseToken! }, now + 20_000, now + 1)!;
    expect(h.runtime.releaseClaimedEmbeddingRetries([old], now + 1)).toEqual([]);
    const changes = h.runtime.releaseClaimedEmbeddingRetries([renewed], now + 1);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.after).toMatchObject({ status: "pending", attempts: 0, nextAttemptAt: now, leaseToken: null, claimedBy: null, leaseUntil: null });
    const again = h.runtime.claimEmbeddingRetryById(old.id, input)!;
    expect(again.leaseToken).not.toBe(old.leaseToken);
    expect(h.runtime.releaseClaimedEmbeddingRetries([old], now + 2)).toEqual([]);
  });

  it("participates in an outer transaction so joint claims roll back together", () => {
    const h = harness(); h.job("main"); h.retry("retry");
    expect(() => h.repos.transaction(() => {
      expect(h.runtime.claimQueuedJob("main", { at })).toBeDefined();
      expect(h.runtime.claimEmbeddingRetryById("retry", { now, workerId: "worker", leaseUntil: now + 60_000 })).toBeDefined();
      throw new Error("cancel joint admission");
    })).toThrow("cancel joint admission");
    expect(h.runtime.getJob("main")).toMatchObject({ status: "queued", attempts: 0, leaseToken: null, leaseCount: 0 });
    expect(h.runtime.getEmbeddingRetry("retry")).toMatchObject({ status: "pending", leaseToken: null });
  });
});
