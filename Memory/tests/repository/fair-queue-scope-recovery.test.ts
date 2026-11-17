import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryDb } from "../../src/storage/db.js";
import { Repositories, type EvolutionJobRecord } from "../../src/storage/repositories.js";
import { claimFairWorkerBatch, type FairClaimedWork } from "../../src/service/worker/fair-worker-queue.js";
import { JOB_POLICY_VERSION } from "../../src/service/worker/job-policy-registry.js";
import { resolveWorkerSchedulingOptions } from "../../src/service/worker/worker-scheduling-options.js";
import type { QueueEligibilityOptions } from "../../src/storage/queue-eligibility.js";

const at = "2026-10-22T00:00:00.000Z", now = Date.parse(at);
const cursorKey = "worker.scheduler.wrr_cursor.v1";
const resources: Array<{ db: MemoryDb; root: string }> = [];
function harness() {
  const root = mkdtempSync(join(tmpdir(), "memmy-fair-scope-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  resources.push({ db, root });
  const repos = new Repositories(db.db), runtime = repos.runtime;
  function job(id: string, jobType: EvolutionJobRecord["jobType"] = "trace_summary", targetMemoryId = id) {
    return runtime.enqueueJob({ id, jobType, targetMemoryId, userId: "user", status: "queued", payload: {},
      attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at });
  }
  function failed(id: string, jobType: EvolutionJobRecord["jobType"] = "import_summary") {
    job(id, jobType);
    const claim = runtime.claimQueuedJob(id, { at })!;
    runtime.failJob(id, "transient", at, false, claim, { availableAt: at });
    // Simulate an active failed row imported from before policy projections.
    db.db.prepare("UPDATE evolution_jobs SET policy_version=NULL WHERE id=?").run(id);
    return runtime.getJob(id)!;
  }
  function claim(limit: number, filters: QueueEligibilityOptions & { includeRetries?: boolean } = {}) {
    return claimFairWorkerBatch(repos, { at, limit, includeRetries: true, owner: "main", retryOwner: "retry",
      leaseSeconds: 60, retryLeaseMs: 60_000, options: resolveWorkerSchedulingOptions({}, {}), ...filters });
  }
  function finish(work: FairClaimedWork[]) {
    for (const item of work) if (item.queue === "main") runtime.completeJob(item.job.id, at, item.job);
  }
  return { db, repos, runtime, job, failed, claim, finish };
}
afterEach(() => {
  for (const { db, root } of resources.splice(0)) {
    if (db.db.open) db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

describe("fair queue scope cursors and failed recovery", () => {
  it("keeps a filtered call from consuming the global round while retaining its own round", () => {
    const h = harness();
    for (const prefix of ["local", "global"]) for (let i = 0; i < 8; i++) {
      h.job(`${prefix}-i-${i}`, "trace_summary", prefix);
      h.job(`${prefix}-r-${i}`, "decision_repair", prefix);
    }
    h.finish(h.claim(4));
    const global = h.runtime.getKv(cursorKey);
    const local: string[] = [];
    for (let i = 0; i < 5; i++) {
      const work = h.claim(1, { targetMemoryIds: ["local"] });
      local.push(work[0]!.queue === "main" ? work[0]!.job.jobType : "retry"); h.finish(work);
    }
    expect(local).toEqual(["trace_summary", "trace_summary", "trace_summary", "trace_summary", "decision_repair"]);
    expect(h.runtime.getKv(cursorKey)).toEqual(global);
  });

  it("normalizes target and type filter sets but preserves distinct scopes", () => {
    const h = harness();
    for (let i = 0; i < 8; i++) {
      h.job(`i-${i}`, "trace_summary", "a"); h.job(`r-${i}`, "decision_repair", "b");
    }
    const types = ["trace_summary", "decision_repair"];
    for (let i = 0; i < 5; i++) {
      const work = h.claim(1, { targetMemoryIds: i % 2 ? ["b", "a", "a"] : ["a", "b"],
        allowedJobTypes: i % 2 ? [...types].reverse() : types,
        excludedJobTypes: i % 2 ? ["reward", "reward"] : ["reward"] });
      expect(work[0]!.queue === "main" && work[0]!.job.jobType).toBe(i < 4 ? "trace_summary" : "decision_repair");
      h.finish(work);
    }
    expect(h.runtime.listKv(cursorKey)).toHaveLength(1);
    h.finish(h.claim(1, { targetMemoryIds: ["a", "b"], allowedJobTypes: types, excludedJobTypes: ["reward"], includeRetries: false }));
    h.finish(h.claim(1, { targetMemoryIds: ["a", "b"], allowedJobTypes: ["trace_summary"], excludedJobTypes: ["reward"] }));
    expect(h.runtime.listKv(cursorKey)).toHaveLength(3);
    expect(h.runtime.getKv(cursorKey)).toBeUndefined();
  });

  it("hashes the entire target set including entries beyond one thousand", () => {
    const h = harness(); h.job("one", "trace_summary", "selected"); h.job("two", "trace_summary", "selected");
    const targets = ["selected", ...Array.from({ length: 1_001 }, (_, i) => `unused-${String(i).padStart(4, "0")}`)];
    h.finish(h.claim(1, { targetMemoryIds: [...targets, "z-tail-one"] }));
    h.finish(h.claim(1, { targetMemoryIds: [...targets, "z-tail-two"] }));
    expect(h.runtime.listKv(cursorKey)).toHaveLength(2);
    expect(h.runtime.getKv(cursorKey)).toBeUndefined();
  });

  it("puts due failed work directly into lane FIFO before newer queued work", () => {
    const h = harness(); const previous = h.failed("old-failed"); h.job("new-queued", "import_summary");
    const work = h.claim(1);
    expect(work).toHaveLength(1);
    expect(work[0]!.queue === "main" && work[0]!.job).toMatchObject({ id: "old-failed", status: "leased",
      attempts: previous.attempts + 1, failureCount: 1, leaseCount: 2 });
    expect(h.runtime.getJob("new-queued")?.status).toBe("queued");
    expect(h.db.db.prepare("SELECT policy_version FROM evolution_jobs WHERE id='old-failed'").get()).toMatchObject({ policy_version: JOB_POLICY_VERSION });
  });

  it("rechecks all failed eligibility fences and keeps legacy claims opt-in", () => {
    const h = harness();
    for (const id of ["ready", "future", "config", "exhausted", "runAfter", "wrong-target", "wrong-type"]) h.failed(id);
    h.db.db.prepare("UPDATE evolution_jobs SET available_at=? WHERE id='future'").run(new Date(now + 1).toISOString());
    h.db.db.prepare("UPDATE evolution_jobs SET blocked_reason='configuration' WHERE id='config'").run();
    h.db.db.prepare("UPDATE evolution_jobs SET failure_count=max_attempts WHERE id='exhausted'").run();
    h.db.db.prepare("UPDATE evolution_jobs SET payload_json=? WHERE id='runAfter'").run(JSON.stringify({ runAfter: new Date(now + 1).toISOString() }));
    h.db.db.prepare("UPDATE evolution_jobs SET job_type='reflection' WHERE id='wrong-type'").run();
    expect(h.runtime.claimQueuedJob("ready", { at })).toBeUndefined();
    expect(h.runtime.leaseQueuedJobs(20)).toEqual([]);
    const before = new Map(["future", "config", "exhausted", "runAfter", "wrong-target", "wrong-type"].map(id => [id, h.runtime.getJob(id)!]));
    const work = h.claim(20, { targetMemoryIds: ["ready", "future", "config", "exhausted", "runAfter", "wrong-type"], allowedJobTypes: ["import_summary"] });
    expect(work.map(item => item.queue === "main" && item.job.id)).toEqual(["ready"]);
    for (const id of ["future", "config", "exhausted", "runAfter", "wrong-target", "wrong-type"]) {
      const prior = before.get(id)!;
      // Metadata backfill includes delayed work, but never bypasses claim eligibility.
      expect(h.runtime.getJob(id)).toMatchObject({ status: "failed", attempts: prior.attempts,
        failureCount: prior.failureCount, leaseToken: prior.leaseToken, availableAt: prior.availableAt,
        blockedReason: prior.blockedReason, payload: prior.payload });
      expect(h.db.db.prepare("SELECT policy_version FROM evolution_jobs WHERE id=?").get(id)).toMatchObject({ policy_version: JOB_POLICY_VERSION });
    }
    expect(h.runtime.claimQueuedJob("wrong-target", { at, includeDueFailed: true, excludedJobTypes: ["import_summary"] })).toBeUndefined();
  });

  it("fences the previous failed executor and preserves failure history when returning an unstarted claim", () => {
    const h = harness(); h.job("retry");
    const old = h.runtime.claimQueuedJob("retry", { at, owner: "executor-a" })!;
    h.runtime.failJob(old.id, "transient", at, false, old, { availableAt: at });
    const next = h.runtime.claimQueuedJob(old.id, { at, owner: "executor-b", includeDueFailed: true })!;
    expect(next).toMatchObject({ attempts: 2, failureCount: 1, leaseCount: 2, leaseRecoveryCount: 0 });
    expect(next.leaseToken).not.toBe(old.leaseToken);
    expect(h.runtime.completeJob(old.id, at, old)).toBeUndefined();
    expect(h.runtime.failJob(old.id, "stale error", at, true, old)).toBeUndefined();
    expect(h.runtime.releaseClaimedJobs([old], at)).toEqual([]);
    expect(h.runtime.releaseClaimedJobs([next], at)[0]?.after).toMatchObject({ status: "queued", attempts: 1,
      failureCount: 1, leaseCount: 2, leaseOwner: null, leaseToken: null });
  });

  it("preserves failed dependency and business scope ordering", () => {
    const h = harness();
    h.db.db.prepare(`INSERT INTO memories(id,timeline,user_id,memory_value,memory_layer,created_at,updated_at)
      VALUES ('dependency',?,'user','text','L1',?,?)`).run(at, at, at);
    h.db.db.prepare("INSERT INTO memory_processing_state(memory_id,state,stage,updated_at) VALUES ('dependency','embedding_pending','embedding',?)").run(at);
    h.failed("reward", "reward");
    h.db.db.prepare("UPDATE evolution_jobs SET payload_json=? WHERE id='reward'").run('{"l1MemoryId":"dependency","polarity":"positive"}');
    for (const [index, id] of ["scope-first", "scope-second"].entries()) {
      h.job(id, "work_memory_extract");
      h.db.db.prepare("UPDATE evolution_jobs SET scope_key='scope',scope_seq=?,status='failed',failure_count=1,available_at=? WHERE id=?").run(index + 1, at, id);
    }
    const work = h.claim(10);
    expect(work.map(item => item.queue === "main" && item.job.id)).toEqual(["scope-first"]);
    expect(h.runtime.getJob("reward")?.status).toBe("failed");
    expect(h.runtime.getJob("scope-second")?.status).toBe("failed");
    h.finish(work);
    expect(h.claim(1).map(item => item.queue === "main" && item.job.id)).toEqual(["scope-second"]);
  });

  it("rolls failed claim, lazy projection and scoped cursor back atomically", () => {
    const h = harness(); const previous = h.failed("rollback");
    expect(() => h.repos.transaction(() => {
      expect(h.claim(1, { targetMemoryIds: ["rollback"] })).toHaveLength(1);
      throw new Error("rollback admission");
    })).toThrow("rollback admission");
    expect(h.runtime.getJob("rollback")).toEqual(previous);
    expect(h.runtime.listKv(cursorKey)).toEqual([]);
    expect(h.db.db.prepare("SELECT policy_version FROM evolution_jobs WHERE id='rollback'").get()).toMatchObject({ policy_version: null });
  });
});
