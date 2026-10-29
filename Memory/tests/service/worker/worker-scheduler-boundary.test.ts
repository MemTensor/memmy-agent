import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerSchedulerReentryError, WorkerSchedulerStoppedError } from "../../../src/service/worker/worker-scheduler.js";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories, type EvolutionJobRecord } from "../../../src/storage/repositories.js";
import { WorkerRunner, type WorkerRunnerDeps } from "../../../src/service/worker/worker-runner.js";
import { createCapturingEmbedder } from "../../fixtures/memory-service-fixture.js";

const resources: Array<{ root: string; db: MemoryDb }> = [];

async function flushWorker() { for (let i = 0; i < 100; i++) await Promise.resolve(); }

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Real SQLite and worker lifecycle; only model/business work is substituted. */
function harness(processJob: WorkerRunnerDeps["jobHandlers"]["processJob"] = async () => {}) {
  const root = mkdtempSync(join(tmpdir(), "memmy-worker-entry-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  resources.push({ root, db });
  const repos = new Repositories(db.db);
  const deps: WorkerRunnerDeps = {
    repos,
    embedder: createCapturingEmbedder([]),
    capture: { embedAfterCapture: true },
    embeddingRetryWorkerId: "lease-safety-runner",
    memoryAddEnabled: () => true,
    memoryBudgetPaused: () => false,
    memoryBudgetJobConsumes: () => false,
    memoryBudgetModelSources: () => ({ embedding: { mode: "local" } }),
    memoryBudgetNextWakeAtMs: () => Date.now(),
    summaryModelConfigured: () => true,
    nowIso: () => new Date().toISOString(),
    encodeChangeCursor: String,
    namespaceIdFromMemory: () => "lease-safety",
    runWorkerNoWrite: async () => { throw new Error("unexpected disabled worker"); },
    restartFailedProcessing: () => 0,
    previewPolicyEvidenceReconciliation: () => ({
      orphanPolicyIds: [], affectedWorldModelIds: [], affectedSkillIds: [], restorablePolicyIds: []
    }),
    reconcileOrphanedPolicies: () => 0,
    enqueueJob: () => { throw new Error("unexpected startup enqueue"); },
    enqueueEmbeddingRetry: () => { throw new Error("unexpected replacement retry"); },
    appendJobChange: () => {},
    appendEmbeddingRetryChange: () => {},
    jobHandlers: { processJob },
    embeddingJobs: {
      prepareEmbeddingJob: () => { throw new Error("unexpected main embedding"); },
      applyEmbeddingVector: () => {},
      persistEmbeddingVector: (input) => {
        const target = repos.memories.get(input.memoryId);
        if (!target) throw new Error("missing synthetic target");
        input.finalize?.(target, false, new Date().toISOString());
        return target;
      },
      enqueueEmbeddingRetryAfterFailure: () => false
    }
  };
  const runner = new WorkerRunner(deps);
  function job(id: string, jobType: EvolutionJobRecord["jobType"] = "reflection"): void {
    const at = new Date().toISOString();
    repos.runtime.enqueueJob({
      id, jobType, status: "queued", userId: "lease-safety-user", payload: {},
      attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at
    });
  }
  function retry(id: string): void {
    const at = new Date().toISOString();
    db.db.prepare(`INSERT INTO memories
      (id, timeline, user_id, memory_value, memory_layer, created_at, updated_at)
      VALUES (?, ?, 'lease-safety-user', 'retry text', 'L1', ?, ?)`)
      .run(id, at, at, at);
    repos.runtime.enqueueEmbeddingRetry({
      id, targetKind: "trace", targetId: id, vectorField: "vec_summary", sourceText: "retry text", now: Date.now()
    });
  }
  return { db, repos, runner, job, retry, deps };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const { root, db } of resources.splice(0)) {
    if (db.db.open) db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

describe("unified worker execution boundary", () => {
  it("keeps independent target requests queued without preclaiming their jobs", async () => {
    const gate = deferred(); const started: string[] = [];
    const h = harness(async (job) => { started.push(job.id); if (job.id === "A") await gate.promise; });
    for (const id of ["A", "B", "C"]) {
      h.job(id, "trace_summary");
      h.db.db.prepare("UPDATE evolution_jobs SET target_memory_id = ? WHERE id = ?").run(id, id);
    }
    const a = h.runner.runWorkerOnce(1, { targetMemoryIds: ["A"], priorityCohortOnly: true });
    const b = h.runner.runWorkerOnce(1, { targetMemoryIds: ["B"] });
    const c = h.runner.runWorkerOnce(1, { targetMemoryIds: ["C"] });
    try {
      await flushWorker();
      expect(started).toEqual(["A"]);
      for (const id of ["B", "C"]) expect(h.repos.runtime.getJob(id)).toMatchObject({ status: "queued", attempts: 0, leaseToken: null });
    } finally { gate.resolve(); }
    const results = await Promise.all([a, b, c]);
    expect(results.map((r) => r.jobs.map((j) => j.jobId))).toEqual([["A"], ["B"], ["C"]]);
    expect(started).toEqual(["A", "B", "C"]);
  });

  it("shares the boundary with direct retry drains and still runs the internal retry path", async () => {
    const gate = deferred();
    const h = harness(async () => { await gate.promise; });
    h.job("main", "trace_summary"); h.retry("retry");
    const main = h.runner.runWorkerOnce(1);
    const retry = h.runner.runEmbeddingRetryOnce(1);
    try { expect(h.repos.runtime.getEmbeddingRetry("retry")).toMatchObject({ status: "pending", leaseToken: null }); }
    finally { gate.resolve(); }
    expect((await main).leased).toBe(1);
    expect(await retry).toMatchObject({ leased: 1, succeeded: 1 });
    h.retry("internal-retry");
    expect((await h.runner.runWorkerOnce(1)).embeddingRetries).toMatchObject({ leased: 1, succeeded: 1 });
  });

  it("releases the entry boundary after an unexpected leasing error", async () => {
    const h = harness(); h.job("survivor");
    vi.spyOn(h.repos.runtime, "claimQueuedJob").mockImplementationOnce(() => { throw new Error("synthetic database unavailable"); });
    const failed = h.runner.runWorkerOnce(1);
    const next = h.runner.runWorkerOnce(1);
    await expect(failed).rejects.toThrow("synthetic database unavailable");
    expect(await next).toMatchObject({ leased: 1, succeeded: 1 });
  });

  it.each(["main", "retry"] as const)("rejects nested %s execution instead of awaiting the gate it already owns", async (kind) => {
    let rejected: unknown;
    const h = harness(async () => {
      try {
        if (kind === "main") await h.runner.runWorkerOnce(1);
        else await h.runner.runEmbeddingRetryOnce(1);
      } catch (error) { rejected = error; throw error; }
    });
    h.job("nested");
    expect((await h.runner.runWorkerOnce(1)).failed).toBe(1);
    expect(rejected).toBeInstanceOf(WorkerSchedulerReentryError);
  });

  it("rejects pending and new requests on stop, while letting the active guarded job finish", async () => {
    const gate = deferred();
    const h = harness(async () => { await gate.promise; });
    h.job("active"); h.job("waiting");
    const running = h.runner.runWorkerOnce(1);
    const pending = h.runner.runWorkerOnce(1);
    const rejected = expect(pending).rejects.toBeInstanceOf(WorkerSchedulerStoppedError);
    const stopped = h.runner.stop();
    let settled = false; void stopped.then(() => { settled = true; });
    await rejected;
    await expect(h.runner.runWorkerOnce(1)).rejects.toBeInstanceOf(WorkerSchedulerStoppedError);
    expect(settled).toBe(false);
    expect(h.repos.runtime.getJob("waiting")).toMatchObject({ status: "queued", attempts: 0 });
    gate.resolve(); await running; await stopped;
    expect(h.repos.runtime.getJob("active")!.status).toBe("succeeded");
    expect(settled).toBe(true);
  });

  it("keeps the default limit of 100 as work budget inside one admitted drain", async () => {
    const gate = deferred(); let active = 0; let peak = 0;
    const h = harness(async () => { active++; peak = Math.max(peak, active); await gate.promise; active--; });
    for (let i = 0; i < 100; i++) h.job(`summary-${i}`, "trace_summary");
    const run = h.runner.runWorkerOnce();
    try { await flushWorker(); expect(active).toBe(4); expect(peak).toBe(4); }
    finally { gate.resolve(); }
    expect(await run).toMatchObject({ leased: 100, succeeded: 100 });
    expect(peak).toBe(4);
  });
});

it("keeps lifecycle preparation and post-run reconciliation inside the same boundary", async () => {
  const before = deferred(); const entered = deferred(); const events: string[] = [];
  const h = harness(async (job) => { events.push(job.id); });
  let calls = 0;
  h.deps.beforeRun = async () => {
    events.push(`before-${++calls}`);
    if (calls === 1) { entered.resolve(); await before.promise; }
  };
  h.deps.afterRun = () => { events.push(`after-${calls}`); };
  h.job("first"); h.job("second");
  const a = h.runner.runWorkerOnce(1), b = h.runner.runWorkerOnce(1);
  await entered.promise;
  expect(events).toEqual(["before-1"]);
  expect(h.repos.runtime.getJob("first")!.status).toBe("queued");
  before.resolve(); await Promise.all([a, b]); await h.runner.stop();
  expect(events).toEqual(["before-1", "first", "after-1", "before-2", "second", "after-2"]);
});
