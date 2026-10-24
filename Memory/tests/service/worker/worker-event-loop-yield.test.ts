import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories, type EvolutionJobRecord } from "../../../src/storage/repositories.js";
import { WorkerRunner, type WorkerRunnerDeps } from "../../../src/service/worker/worker-runner.js";
import { WorkerConcurrencyController, type WorkerProviderDescriptor } from "../../../src/service/worker/worker-concurrency.js";
import { createCapturingEmbedder } from "../../fixtures/memory-service-fixture.js";

const resources: Array<{ root: string; db: MemoryDb; runner: WorkerRunner; concurrency: WorkerConcurrencyController }> = [];
const total = 200;
function harness(maxActiveJobs = 4) {
  const root = mkdtempSync(join(tmpdir(), "memmy-worker-event-loop-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const repos = new Repositories(db.db), concurrency = new WorkerConcurrencyController({ maxActiveJobs }, {});
  const processed: string[] = [];
  let peakJobs = 0;
  const unexpected = () => { throw new Error("Unexpected model or startup operation"); };
  const deps: WorkerRunnerDeps = {
    repos, concurrency, scheduling: { algorithm: "wrr" }, schedulingShadow: { enabled: false },
    embedder: createCapturingEmbedder([]), capture: { embedAfterCapture: false }, embeddingRetryWorkerId: "event-loop-test",
    memoryAddEnabled: () => true, memoryBudgetPaused: () => false, memoryBudgetJobConsumes: () => false,
    memoryBudgetModelSources: () => ({ embedding: { mode: "local" } }), memoryBudgetNextWakeAtMs: () => Date.now(),
    summaryModelConfigured: () => true, nowIso: () => new Date().toISOString(), encodeChangeCursor: String,
    namespaceIdFromMemory: () => "event-loop-test", runWorkerNoWrite: async () => unexpected(),
    restartFailedProcessing: () => 0, reconcileOrphanedPolicies: () => 0,
    previewPolicyEvidenceReconciliation: () => ({ orphanPolicyIds: [], affectedWorldModelIds: [], affectedSkillIds: [], restorablePolicyIds: [] }),
    enqueueJob: unexpected, enqueueEmbeddingRetry: unexpected, appendJobChange: () => {}, appendEmbeddingRetryChange: () => {},
    jobHandlers: { processJob: async job => {
      peakJobs = Math.max(peakJobs, concurrency.snapshot().activeJobs);
      processed.push(job.id);
      repos.runtime.setKv("event-loop.database-progress", { id: job.id }, new Date().toISOString());
    } },
    embeddingJobs: { prepareEmbeddingJob: unexpected, applyEmbeddingVector: unexpected,
      persistEmbeddingVector: unexpected, enqueueEmbeddingRetryAfterFailure: () => false }
  };
  const runner = new WorkerRunner(deps);
  resources.push({ root, db, runner, concurrency });
  function job(id: string, type: EvolutionJobRecord["jobType"] = "l2_association", target = id, delayed = false) {
    const at = new Date().toISOString();
    const queued = repos.runtime.enqueueJob({ id, jobType: type, userId: "event-loop-user", targetMemoryId: target,
      payload: {}, status: "queued", attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at });
    if (delayed) db.db.prepare("UPDATE evolution_jobs SET available_at=? WHERE id=?")
      .run("2100-01-01T00:00:00.000Z", id);
    return queued;
  }
  function jobs(type: EvolutionJobRecord["jobType"] = "l2_association") {
    repos.transaction(() => { for (let i = 0; i < total; i++) job(`auto-${i}`, type); });
  }
  function expectClean() {
    expect(concurrency.snapshot()).toEqual({ activeJobs: 0, availableJobs: maxActiveJobs, backgroundActiveJobs: 0,
      maxBackgroundJobs: concurrency.limits.maxBackgroundJobs, interactiveReservedSlots: concurrency.limits.interactiveReservedSlots, resources: {}, providers: {}, scopeKeys: [], embeddingRequests: 0 });
    const queued = db.db.prepare("SELECT attempts,lease_token FROM evolution_jobs WHERE status='queued'").all();
    expect(queued.every(row => (row as { attempts: number; lease_token: string | null }).attempts === 0
      && (row as { lease_token: string | null }).lease_token === null)).toBe(true);
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs WHERE status='leased'").get()).toEqual({ n: 0 });
  }
  return { db, repos, concurrency, runner, deps, processed, job, jobs, expectClean, peakJobs: () => peakJobs };
}
function timerEvent(operation: () => void): Promise<void> {
  return new Promise((resolve, reject) => setTimeout(() => { try { operation(); resolve(); } catch (error) { reject(error); } }, 0));
}
afterEach(async () => {
  for (const { root, db, runner, concurrency } of resources.splice(0)) {
    await runner.stop(); await concurrency.close();
    if (db.db.open) db.close();
    rmSync(root, { recursive: true, force: true });
  }
  vi.useRealTimers(); vi.restoreAllMocks();
});

function blockedBacklog(h: ReturnType<typeof harness>, count = 1000) {
  const provider = [{ key: "blocked-local", limit: 1 }];
  const held = h.concurrency.tryAcquire({ resourceClass: "summary", providers: provider, scopeKeys: [] })!;
  let prepared = 0;
  h.deps.prepareExecution = work => {
    prepared++;
    return { providers: work.queue === "main" && work.job.jobType === "trace_summary" ? provider : [],
      run: operation => operation() };
  };
  h.repos.transaction(() => {
    for (let i = 0; i < count; i++) h.job(`blocked-${i}`, "trace_summary");
    h.job("late-database");
    h.db.db.prepare("UPDATE evolution_jobs SET queue_lane='import'").run();
  });
  return { held, prepared: () => prepared, count };
}

describe("continuous worker event-loop fairness", () => {
  it("yields while projecting an upgraded dirty queue and admits no row before projection completes", async () => {
    const h = harness(), backlog = blockedBacklog(h), abort = new AbortController();
    h.db.db.prepare("UPDATE evolution_jobs SET policy_version=0").run();
    let dirtyAtTimer = -1;
    const timer = timerEvent(() => {
      dirtyAtTimer = Number((h.db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs WHERE policy_version=0").get() as { n: number }).n);
      abort.abort();
    });
    try {
      const result = await h.runner.runWorkerOnce(1, {}, { signal: abort.signal });
      await timer;
      expect(dirtyAtTimer).toBeGreaterThan(0);
      expect(dirtyAtTimer).toBeGreaterThanOrEqual(backlog.count + 1 - 128);
      expect(result.leased).toBe(0);
      expect(backlog.prepared()).toBe(0);
      expect(h.processed).toEqual([]);
    } finally { backlog.held.release(); }
    h.expectClean();
  });

  it("finishes bounded dirty-policy projection before selecting the runnable FIFO tail", async () => {
    const h = harness(), backlog = blockedBacklog(h);
    h.db.db.prepare("UPDATE evolution_jobs SET policy_version=0").run();
    let projectedAtFirstAdmission = -1;
    const prepare = h.deps.prepareExecution!;
    h.deps.prepareExecution = work => {
      if (projectedAtFirstAdmission < 0) projectedAtFirstAdmission = Number((h.db.db.prepare(
        "SELECT COUNT(*) AS n FROM evolution_jobs WHERE policy_version=0").get() as { n: number }).n);
      return prepare(work);
    };
    try {
      const result = await h.runner.runWorkerOnce(1);
      expect(projectedAtFirstAdmission).toBe(0);
      expect(result.jobs.map(job => job.jobId)).toEqual(["late-database"]);
    } finally { backlog.held.release(); }
    h.expectClean();
  });

  it("yields while inspecting blocked candidates so a timer can abort before the runnable tail", async () => {
    const h = harness(), backlog = blockedBacklog(h), abort = new AbortController();
    let atAbort = -1;
    const timer = timerEvent(() => { atAbort = backlog.prepared(); abort.abort(); });
    try {
      const result = await h.runner.runWorkerOnce(1, {}, { signal: abort.signal });
      await timer;
      expect(atAbort).toBeGreaterThan(0);
      expect(atAbort).toBeLessThanOrEqual(128);
      expect(backlog.prepared()).toBe(atAbort);
      expect(result.leased).toBe(0);
      expect(h.processed).toEqual([]);
    } finally { backlog.held.release(); }
    h.expectClean();
  });

  it("continues beyond all blocked slices to a runnable database tail without starving timers", async () => {
    const h = harness(), backlog = blockedBacklog(h);
    let atTimer = -1;
    const timer = timerEvent(() => { atTimer = backlog.prepared(); });
    try {
      const result = await h.runner.runWorkerOnce(1);
      await timer;
      expect(atTimer).toBeGreaterThan(0);
      expect(atTimer).toBeLessThanOrEqual(128);
      expect(backlog.prepared()).toBe(backlog.count + 1);
      expect(result.jobs.map(job => job.jobId)).toEqual(["late-database"]);
      expect(h.processed).toEqual(["late-database"]);
      expect(h.repos.runtime.getJob("blocked-0")).toMatchObject({ status: "queued", attempts: 0, leaseToken: null });
    } finally { backlog.held.release(); }
    h.expectClean();
  });

  it("honors stop between blocked candidate slices without claiming the runnable tail", async () => {
    const h = harness(), backlog = blockedBacklog(h);
    let atStop = -1, stopped: Promise<void> | undefined;
    const timer = timerEvent(() => { atStop = backlog.prepared(); stopped = h.runner.stop(); });
    try {
      const result = await h.runner.runWorkerOnce(1);
      await timer; await stopped;
      expect(atStop).toBeGreaterThan(0);
      expect(atStop).toBeLessThanOrEqual(128);
      expect(backlog.prepared()).toBe(atStop);
      expect(result.leased).toBe(0);
      expect(h.processed).toEqual([]);
    } finally { backlog.held.release(); }
    h.expectClean();
  });

  it.each(["available", "runAfter", "expiredLease"] as const)("rechecks an older FIFO row becoming due by %s between slices", async boundary => {
    const h = harness();
    let clock = Date.now();
    h.deps.nowIso = () => new Date(clock).toISOString();
    h.deps.nowMs = () => clock;
    const future = new Date(clock + 1000).toISOString();
    h.job("older-due");
    if (boundary === "available") h.db.db.prepare("UPDATE evolution_jobs SET available_at=? WHERE id='older-due'").run(future);
    else if (boundary === "runAfter") h.db.db.prepare("UPDATE evolution_jobs SET payload_json=? WHERE id='older-due'").run(JSON.stringify({ runAfter: future }));
    else h.db.db.prepare("UPDATE evolution_jobs SET status='leased', leased_until=? WHERE id='older-due'").run(future);
    h.repos.runtime.scheduling.refreshOne("main", "older-due");
    const backlog = blockedBacklog(h);
    const timer = timerEvent(() => { clock += 2000; });
    try {
      const result = await h.runner.runWorkerOnce(1);
      await timer;
      expect(result.jobs.map(job => job.jobId)).toEqual(["older-due"]);
      expect(h.repos.runtime.getJob("late-database")).toMatchObject({ status: "queued", attempts: 0 });
    } finally { backlog.held.release(); }
    h.expectClean();
  });

  it("admits new interactive work arriving during an import continuation", async () => {
    const h = harness(), backlog = blockedBacklog(h);
    const timer = timerEvent(() => { h.job("new-interactive", "user_memory_embedding"); });
    try {
      const result = await h.runner.runWorkerOnce(1);
      await timer;
      expect(result.jobs.map(job => job.jobId)).toEqual(["new-interactive"]);
      expect(h.repos.runtime.getJob("late-database")).toMatchObject({ status: "queued", attempts: 0 });
    } finally { backlog.held.release(); }
    h.expectClean();
  });

  it("refreshes a changed model snapshot between slices while admitted work keeps its own snapshot", async () => {
    const h = harness(); h.job("first-active", "trace_summary");
    const backlog = blockedBacklog(h);
    let configuration = "old", releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const executions: string[] = [];
    h.deps.configurationFingerprint = () => configuration;
    h.deps.prepareExecutionBatch = () => {
      const snapshot = configuration;
      return work => ({
        providers: work.queue === "main" && work.job.id === "first-active"
          ? [{ key: "first-provider", limit: 1 }]
          : work.queue === "main" && work.job.jobType === "trace_summary"
            ? [{ key: snapshot === "old" ? "blocked-local" : "new-provider", limit: 1 }] : [],
        run: operation => { executions.push(snapshot); return operation(); }
      });
    };
    const process = h.deps.jobHandlers.processJob;
    h.deps.jobHandlers.processJob = async job => {
      if (job.id === "first-active") await firstGate;
      else releaseFirst();
      await process(job);
    };
    const timer = timerEvent(() => { configuration = "new"; h.runner.notifyWorkAvailable(); });
    try {
      const result = await h.runner.runWorkerOnce(2);
      await timer;
      expect(result.jobs.map(job => job.jobId)).toEqual(["first-active", "blocked-0"]);
      expect(executions).toEqual(["old", "new"]);
    } finally { releaseFirst(); backlog.held.release(); }
    h.expectClean();
  });

  it.each([64, 128])("retains blocked admission state after exactly %s candidates and waits for a released permit", async count => {
    const h = harness(), backlog = blockedBacklog(h, count);
    h.db.db.prepare("DELETE FROM evolution_jobs WHERE id='late-database'").run();
    let released = false;
    const release = (async () => {
      for (let turn = 0; turn < 4; turn++) await nextTurn();
      released = true; backlog.held.release();
    })();
    try {
      const result = await h.runner.runWorkerOnce(1);
      expect(released).toBe(true);
      expect(result.jobs.map(job => job.jobId)).toEqual(["blocked-0"]);
    } finally { await release; backlog.held.release(); }
    h.expectClean();
  });

  it("rechecks skipped FIFO heads when a held Provider is released between slices", async () => {
    const h = harness(), backlog = blockedBacklog(h);
    const timer = timerEvent(() => backlog.held.release());
    const result = await h.runner.runWorkerOnce(1);
    await timer;
    expect(result.jobs.map(job => job.jobId)).toEqual(["blocked-0"]);
    expect(h.repos.runtime.getJob("late-database")).toMatchObject({ status: "queued", attempts: 0 });
    h.expectClean();
  });

  it("starts work admitted in a partial slice before yielding to a timer", async () => {
    const h = harness(); h.job("early-database");
    const backlog = blockedBacklog(h), abort = new AbortController();
    let processedAtTimer: string[] = [];
    const timer = timerEvent(() => { processedAtTimer = [...h.processed]; abort.abort(); });
    try {
      const result = await h.runner.runWorkerOnce(4, {}, { signal: abort.signal });
      await timer;
      expect(processedAtTimer).toEqual(["early-database"]);
      expect(result.jobs.map(job => job.jobId)).toEqual(["early-database"]);
      expect(h.processed).toEqual(processedAtTimer);
    } finally { backlog.held.release(); }
    h.expectClean();
  });

  it("hands a blocked automatic scan to a manual request arriving between slices", async () => {
    const h = harness(), backlog = blockedBacklog(h);
    h.job("manual", "l2_association", "manual-target", true);
    let manual: ReturnType<WorkerRunner["runWorkerOnce"]> | undefined;
    const timer = timerEvent(() => {
      h.db.db.prepare("UPDATE evolution_jobs SET available_at=NULL WHERE id='manual'").run();
      manual = h.runner.runWorkerOnce(1, { targetMemoryIds: ["manual-target"] });
    });
    try {
      const automatic = await h.runner.runWorkerOnce(4, {}, { continuous: true });
      await timer;
      const result = await manual!;
      expect(automatic.leased).toBe(0);
      expect(result.jobs.map(job => job.jobId)).toEqual(["manual"]);
      expect(h.processed).toEqual(["manual"]);
    } finally { backlog.held.release(); }
    h.expectClean();
  });

  it("lets an already scheduled zero-delay abort run before synchronous database work is drained", async () => {
    const h = harness(), abort = new AbortController(); h.jobs();
    let atAbort = -1;
    const event = timerEvent(() => { atAbort = h.processed.length; abort.abort(); });
    const run = await h.runner.runWorkerOnce(4, {}, { continuous: true, signal: abort.signal });
    await event;
    expect(atAbort).toBeGreaterThan(0);
    // Allow a timers/check phase turn; do not assert an exact refill boundary.
    expect(atAbort).toBeLessThanOrEqual(64);
    expect(h.processed).toHaveLength(atAbort);
    expect(run.leased).toBe(atAbort);
    expect(run.failed).toBe(0); h.expectClean();
  });

  it("admits a manual request posted from a timer before exhausting the automatic backlog", async () => {
    const h = harness(); h.jobs(); h.job("manual", "l2_association", "manual-target", true);
    let beforeManual = -1, manual: ReturnType<WorkerRunner["runWorkerOnce"]> | undefined;
    const event = timerEvent(() => {
      beforeManual = h.processed.length;
      h.db.db.prepare("UPDATE evolution_jobs SET available_at=NULL WHERE id='manual'").run();
      manual = h.runner.runWorkerOnce(1, { targetMemoryIds: ["manual-target"] });
    });
    const automatic = await h.runner.runWorkerOnce(4, {}, { continuous: true });
    await event; const result = await manual!;
    expect(beforeManual).toBeLessThanOrEqual(64);
    expect(automatic.leased).toBe(beforeManual);
    expect(result.jobs.map(job => job.jobId)).toEqual(["manual"]);
    expect(h.processed.slice(-1)).toEqual(["manual"]);
    expect(h.processed).toHaveLength(beforeManual + 1); h.expectClean();
  });

  it("honors stop issued from a timer and leaves unadmitted records untouched", async () => {
    const h = harness(); h.jobs();
    let atStop = -1, stopped: Promise<void> | undefined;
    const event = timerEvent(() => { atStop = h.processed.length; stopped = h.runner.stop(); });
    const result = await h.runner.runWorkerOnce(4, {}, { continuous: true });
    await event; await stopped;
    expect(atStop).toBeLessThanOrEqual(64);
    expect(h.processed).toHaveLength(atStop);
    expect(result.leased).toBe(atStop);
    await expect(h.runner.runWorkerOnce(1)).rejects.toThrow(/stopped/i);
    h.expectClean();
  });

  it("retains the global and actual Provider request limits across macro-task turns", async () => {
    const h = harness(); h.jobs("trace_summary");
    const descriptors: WorkerProviderDescriptor[] = ["provider-a", "provider-b"].map(key => ({
      local: false, providers: [{ key, limit: 2 }, { key: `${key}:model`, limit: 2 }]
    }));
    const descriptorFor = (id: string) => descriptors[Number(id.split("-")[1]) % 2]!;
    h.deps.prepareExecution = work => ({
      providers: descriptorFor(work.queue === "main" ? work.job.id : work.retry.id).providers,
      run: operation => operation()
    });
    const process = h.deps.jobHandlers.processJob;
    const activeByProvider = [0, 0], peakByProvider = [0, 0];
    let activeRequests = 0, peakRequests = 0, atTimer = -1;
    h.deps.jobHandlers.processJob = async job => {
      const index = Number(job.id.split("-")[1]) % 2;
      await h.concurrency.runRequest(descriptors[index]!, async () => {
        peakRequests = Math.max(peakRequests, ++activeRequests);
        peakByProvider[index] = Math.max(peakByProvider[index]!, ++activeByProvider[index]!);
        try { await Promise.resolve(); await process(job); }
        finally { activeRequests--; activeByProvider[index]!--; }
      });
    };
    const event = timerEvent(() => { atTimer = h.processed.length; });
    const result = await h.runner.runWorkerOnce(4, {}, { continuous: true });
    await event;
    expect(atTimer).toBeGreaterThan(0); expect(atTimer).toBeLessThanOrEqual(64);
    expect(result).toMatchObject({ leased: total, succeeded: total, failed: 0 });
    expect(h.processed).toHaveLength(total);
    // Both Providers can run concurrently, while neither exceeds its own cap.
    expect(peakRequests).toBe(4); expect(peakByProvider).toEqual([2, 2]);
    expect(h.peakJobs()).toBe(4);
    expect(activeRequests).toBe(0); expect(activeByProvider).toEqual([0, 0]); h.expectClean();
  });

  it("clears deadline and heartbeat timers when cancellation arrives during a macro-task turn", async () => {
    // Keep native immediates live: the production yield must not need a test
    // clock advance. Track only the owned deadline/heartbeat timer handles.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const schedule = vi.spyOn(globalThis, "setTimeout");
    const h = harness(1), abort = new AbortController(); h.jobs(); h.job("future", "l2_association", "future", true);
    let atAbort = -1;
    const event = nextTurn().then(() => { atAbort = h.processed.length; abort.abort(); });
    const run = await h.runner.runWorkerOnce(4, {}, { continuous: true, signal: abort.signal });
    await event;
    expect(atAbort).toBeGreaterThan(0); expect(atAbort).toBeLessThanOrEqual(64);
    expect(h.processed).toHaveLength(atAbort); expect(run.leased).toBe(atAbort);
    expect(schedule.mock.calls.some(([, delay]) => Number(delay) > 1000)).toBe(true);
    expect(vi.getTimerCount()).toBe(0); h.expectClean();
  });

  it("clears timer handles and permits if admission throws after the event loop gets a turn", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const schedule = vi.spyOn(globalThis, "setTimeout");
    const h = harness(1); h.jobs(); h.job("future", "l2_association", "future", true);
    let failAdmission = false, completedBeforeFailure = -1;
    h.deps.prepareExecution = () => {
      if (failAdmission) throw new Error("admission failed after macro-task turn");
      return { providers: [], run: operation => operation() };
    };
    const event = nextTurn().then(() => { completedBeforeFailure = h.processed.length; failAdmission = true; });
    const rejected = expect(h.runner.runWorkerOnce(4, {}, { continuous: true }))
      .rejects.toThrow("admission failed after macro-task turn");
    await Promise.all([event, rejected]);
    expect(completedBeforeFailure).toBeGreaterThan(0); expect(completedBeforeFailure).toBeLessThanOrEqual(64);
    expect(h.processed).toHaveLength(completedBeforeFailure);
    expect(schedule.mock.calls.some(([, delay]) => Number(delay) > 1000)).toBe(true);
    expect(vi.getTimerCount()).toBe(0); h.expectClean();
  });
});
