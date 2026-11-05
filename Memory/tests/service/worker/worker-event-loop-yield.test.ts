import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories, type EvolutionJobRecord } from "../../../src/storage/repositories.js";
import { WorkerRunner, type WorkerRunnerDeps } from "../../../src/service/worker/worker-runner.js";
import { WorkerConcurrencyController, type WorkerProviderDescriptor } from "../../../src/service/worker/worker-concurrency.js";
import { WorkerAdmissionWaitSet } from "../../../src/service/worker/worker-admission-wait-set.js";
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
  it("resumes scheduled maintenance inside an open worker entry and preserves its target context", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness(), abort = new AbortController(), backlog = blockedBacklog(h, 1);
    h.db.db.prepare("DELETE FROM evolution_jobs WHERE id='late-database'").run();
    let clock = Date.now(), maintenanceAt: number | undefined = clock + 100;
    h.deps.nowIso = () => new Date(clock).toISOString(); h.deps.nowMs = () => clock;
    h.deps.maintenanceNextRunAtMs = () => maintenanceAt;
    const before = vi.fn(async (request?: { targetMemoryIds?: readonly string[] }) => {
      expect(request).toEqual({});
      if (maintenanceAt !== undefined && maintenanceAt <= clock) {
        maintenanceAt = undefined; h.job("maintenance-ready", "user_memory_embedding");
      }
    });
    h.deps.beforeRun = before;
    const run = h.runner.runWorkerOnce(100, {}, { continuous: true, signal: abort.signal });
    try {
      for (let i = 0; i < 12; i++) await nextTurn();
      expect(before).toHaveBeenCalledTimes(1);
      clock += 100; await vi.advanceTimersByTimeAsync(100);
      for (let i = 0; i < 15; i++) await nextTurn();
      expect(before).toHaveBeenCalledTimes(2);
      expect(h.processed).toEqual(["maintenance-ready"]);
    } finally { abort.abort(); h.runner.notifyWorkAvailable(); await run; backlog.held.release(); }
    h.expectClean();
  });

  describe.each(["available", "runAfter", "mainLease", "retryTime", "retryLease", "failed"] as const)("refreshing an old %s deadline", kind => {
    it.each([0, 1])("retains the deadline when a new insert's snapshot crosses it by %i ms", async crossedBy => {
      const h = harness(), abort = new AbortController();
      let clock = Date.now();
      h.deps.nowIso = () => new Date(clock).toISOString(); h.deps.nowMs = () => clock;
      const due = clock + 3_600_000, future = new Date(due).toISOString();
      const retry = kind === "retryTime" || kind === "retryLease";
      if (retry) {
        h.repos.runtime.enqueueEmbeddingRetry({ id: "old-deadline", targetKind: "trace", targetId: "missing",
          vectorField: "vec_summary", sourceText: "synthetic", now: due });
        if (kind === "retryLease") h.db.db.prepare("UPDATE embedding_retry_queue SET status='in_progress',claimed_by='old-worker',next_attempt_at=?,lease_until=? WHERE id='old-deadline'").run(clock - 1, due);
      } else {
        h.job("old-deadline", "user_memory_embedding");
        if (kind === "available" || kind === "failed") h.db.db.prepare("UPDATE evolution_jobs SET available_at=?,status=?,failure_count=? WHERE id='old-deadline'")
          .run(future, kind === "failed" ? "failed" : "queued", kind === "failed" ? 1 : 0);
        else if (kind === "runAfter") h.db.db.prepare("UPDATE evolution_jobs SET payload_json=? WHERE id='old-deadline'").run(JSON.stringify({ runAfter: future }));
        else h.db.db.prepare("UPDATE evolution_jobs SET status='leased',leased_until=? WHERE id='old-deadline'").run(future);
      }
      const backlog = blockedBacklog(h, 1);
      h.db.db.prepare("DELETE FROM evolution_jobs WHERE id='late-database'").run();
      if (retry) {
        h.repos.runtime.enqueueEmbeddingRetry({ id: "later-blocked-retry", targetKind: "trace", targetId: "other-missing",
          vectorField: "vec_summary", sourceText: "synthetic", now: clock - 1 });
        const prepare = h.deps.prepareExecution!;
        h.deps.prepareExecution = work => work.queue === "embedding_retry" && work.retry.id === "later-blocked-retry"
          ? { providers: [{ key: "blocked-local", limit: 1 }], run: operation => operation() } : prepare(work);
      }
      h.repos.runtime.scheduling.refreshPolicies(100);
      h.db.db.prepare("UPDATE evolution_jobs SET queue_lane='import'").run();
      h.db.db.prepare("UPDATE embedding_retry_queue SET queue_lane='import'").run();
      const claim = vi.spyOn(h.repos.runtime, "claimEmbeddingRetryById");
      const run = h.runner.runWorkerOnce(100, {}, { continuous: true, signal: abort.signal });
      try {
        for (let i = 0; i < 15; i++) await nextTurn();
        expect(h.processed).toEqual([]);
        expect(backlog.prepared()).toBe(1);
        // The insert arrives one millisecond before the old deadline. SQLite
        // crosses that deadline after the expiry check, without changing rows.
        clock = due - 1;
        const read = h.repos.runtime.scheduling.readSnapshot.bind(h.repos.runtime.scheduling);
        const snapshot = vi.spyOn(h.repos.runtime.scheduling, "readSnapshot").mockImplementationOnce(callback => {
          clock = due + crossedBy;
          return read(callback);
        });
        h.job("fresh-live", "user_memory_embedding"); h.runner.notifyWorkAvailable();
        for (let i = 0; i < 30; i++) await nextTurn();
        expect(snapshot).toHaveBeenCalled();
        expect(h.processed).toContain("fresh-live");
        if (retry) expect(claim.mock.calls.some(([id]) => id === "old-deadline")).toBe(true);
        else expect(h.processed).toContain("old-deadline");
      } finally { abort.abort(); h.runner.notifyWorkAvailable(); await run; backlog.held.release(); }
      h.expectClean();
    });
  });

  it("invalidates old cursors when a timing edit arrives between the change probe and its snapshot", async () => {
    const h = harness(), abort = new AbortController();
    h.job("old-delayed", "user_memory_embedding", "old-delayed", true);
    const backlog = blockedBacklog(h, 1);
    h.db.db.prepare("DELETE FROM evolution_jobs WHERE id='late-database'").run();
    const run = h.runner.runWorkerOnce(100, {}, { continuous: true, signal: abort.signal });
    try {
      for (let i = 0; i < 12; i++) await nextTurn();
      expect(h.processed).toEqual([]);
      const read = h.repos.runtime.scheduling.readSnapshot.bind(h.repos.runtime.scheduling);
      const snapshot = vi.spyOn(h.repos.runtime.scheduling, "readSnapshot").mockImplementationOnce(callback => {
        // A new enqueue caused the change probe; a producer then edits an
        // already-scanned older row before the deadline snapshot begins.
        h.db.db.prepare("UPDATE evolution_jobs SET available_at=NULL WHERE id='old-delayed'").run();
        return read(callback);
      });
      h.job("new-task", "user_memory_embedding"); h.runner.notifyWorkAvailable();
      for (let i = 0; i < 20; i++) await nextTurn();
      expect(snapshot).toHaveBeenCalled();
      expect(h.processed).toContain("old-delayed");
      expect(h.processed).toContain("new-task");
    } finally { abort.abort(); h.runner.notifyWorkAvailable(); await run; backlog.held.release(); }
    h.expectClean();
  });

  it.each(["main", "retry"] as const)("discovers an earlier edited %s deadline while idle without another notification", async queue => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness(), abort = new AbortController();
    let clock = Date.now();
    h.deps.nowIso = () => new Date(clock).toISOString(); h.deps.nowMs = () => clock;
    if (queue === "main") {
      h.job("old-delayed", "user_memory_embedding");
      h.db.db.prepare("UPDATE evolution_jobs SET available_at=? WHERE id='old-delayed'").run(new Date(clock + 10_000).toISOString());
    } else h.repos.runtime.enqueueEmbeddingRetry({ id: "old-delayed", targetKind: "trace", targetId: "missing",
      vectorField: "vec_summary", sourceText: "synthetic", now: clock + 10_000 });
    const backlog = blockedBacklog(h, 1);
    h.db.db.prepare("DELETE FROM evolution_jobs WHERE id='late-database'").run();
    const claim = vi.spyOn(h.repos.runtime, "claimEmbeddingRetryById");
    const run = h.runner.runWorkerOnce(100, {}, { continuous: true, signal: abort.signal });
    try {
      for (let i = 0; i < 12; i++) await nextTurn();
      if (queue === "main") h.db.db.prepare("UPDATE evolution_jobs SET available_at=? WHERE id='old-delayed'").run(new Date(clock + 100).toISOString());
      else h.db.db.prepare("UPDATE embedding_retry_queue SET next_attempt_at=? WHERE id='old-delayed'").run(clock + 100);
      h.runner.notifyWorkAvailable();
      for (let i = 0; i < 12; i++) await nextTurn();
      expect(h.processed).toEqual([]); expect(claim).not.toHaveBeenCalled();
      clock += 100;
      await vi.advanceTimersByTimeAsync(100);
      for (let i = 0; i < 12; i++) await nextTurn();
      if (queue === "main") expect(h.processed).toEqual(["old-delayed"]);
      else expect(claim.mock.calls.some(([id]) => id === "old-delayed")).toBe(true);
    } finally { abort.abort(); h.runner.notifyWorkAvailable(); await run; backlog.held.release(); }
    h.expectClean();
  });

  it("discovers a delayed task derived by a successful handler without a producer notification", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness(), abort = new AbortController(), backlog = blockedBacklog(h, 1);
    h.db.db.prepare("DELETE FROM evolution_jobs WHERE id='late-database'").run();
    let clock = Date.now(); h.deps.nowIso = () => new Date(clock).toISOString(); h.deps.nowMs = () => clock;
    h.job("parent", "user_memory_embedding");
    const process = h.deps.jobHandlers.processJob;
    h.deps.jobHandlers.processJob = async job => {
      await process(job);
      if (job.id === "parent") {
        h.job("child", "user_memory_embedding");
        h.db.db.prepare("UPDATE evolution_jobs SET available_at=? WHERE id='child'").run(new Date(clock + 100).toISOString());
      }
    };
    const run = h.runner.runWorkerOnce(100, {}, { continuous: true, signal: abort.signal });
    try {
      for (let i = 0; i < 15; i++) await nextTurn();
      expect(h.processed).toEqual(["parent"]);
      clock += 100; await vi.advanceTimersByTimeAsync(100);
      for (let i = 0; i < 15; i++) await nextTurn();
      expect(h.processed).toEqual(["parent", "child"]);
    } finally { abort.abort(); h.runner.notifyWorkAvailable(); await run; backlog.held.release(); }
    h.expectClean();
  });

  it.each(["available", "runAfter", "mainLease", "retryTime", "retryLease"] as const)("rechecks an old %s row edited during a deep scan", async kind => {
    const h = harness(), abort = new AbortController();
    const clock = Date.now(), future = new Date(clock + 10_000).toISOString(), past = new Date(clock - 1).toISOString();
    h.deps.nowIso = () => new Date(clock).toISOString(); h.deps.nowMs = () => clock;
    const retry = kind === "retryTime" || kind === "retryLease";
    if (retry) {
      h.repos.runtime.enqueueEmbeddingRetry({ id: "old-timed", targetKind: "trace", targetId: "missing",
        vectorField: "vec_summary", sourceText: "synthetic", now: clock + 10_000 });
      if (kind === "retryLease") h.db.db.prepare("UPDATE embedding_retry_queue SET status='in_progress',claimed_by='old-worker',next_attempt_at=?,lease_until=? WHERE id='old-timed'").run(clock - 1, clock + 10_000);
    } else {
      h.job("old-timed", "user_memory_embedding");
      if (kind === "available") h.db.db.prepare("UPDATE evolution_jobs SET available_at=? WHERE id='old-timed'").run(future);
      else if (kind === "runAfter") h.db.db.prepare("UPDATE evolution_jobs SET payload_json=? WHERE id='old-timed'").run(JSON.stringify({ runAfter: future }));
      else h.db.db.prepare("UPDATE evolution_jobs SET status='leased',leased_until=? WHERE id='old-timed'").run(future);
    }
    const backlog = blockedBacklog(h, 2000);
    h.db.db.prepare("DELETE FROM evolution_jobs WHERE id='late-database'").run();
    const claim = vi.spyOn(h.repos.runtime, "claimEmbeddingRetryById");
    const run = h.runner.runWorkerOnce(100, {}, { continuous: true, signal: abort.signal });
    try {
      await nextTurn(); expect(backlog.prepared()).toBeLessThan(2000);
      if (kind === "available") h.db.db.prepare("UPDATE evolution_jobs SET available_at=? WHERE id='old-timed'").run(past);
      else if (kind === "runAfter") h.db.db.prepare("UPDATE evolution_jobs SET payload_json=? WHERE id='old-timed'").run(JSON.stringify({ runAfter: past }));
      else if (kind === "mainLease") h.db.db.prepare("UPDATE evolution_jobs SET leased_until=? WHERE id='old-timed'").run(past);
      else if (kind === "retryTime") h.db.db.prepare("UPDATE embedding_retry_queue SET next_attempt_at=? WHERE id='old-timed'").run(clock - 1);
      else h.db.db.prepare("UPDATE embedding_retry_queue SET lease_until=? WHERE id='old-timed'").run(clock - 1);
      h.runner.notifyWorkAvailable();
      for (let i = 0; i < 60; i++) await nextTurn();
      if (retry) expect(claim.mock.calls.some(([id]) => id === "old-timed")).toBe(true);
      else expect(h.processed).toEqual(["old-timed"]);
    } finally { abort.abort(); h.runner.notifyWorkAvailable(); await run; backlog.held.release(); }
    h.expectClean();
  });

  it("reuses deadline state for ordinary completions and unrelated capacity wakes", async () => {
    const h = harness(); h.jobs();
    const queries = vi.spyOn(h.repos.runtime, "nextWorkerRunAt");
    const process = h.deps.jobHandlers.processJob;
    h.deps.jobHandlers.processJob = async job => {
      const permit = h.concurrency.tryAcquire({ resourceClass: "summary", providers: [{ key: "unrelated", limit: 1 }], scopeKeys: [] });
      permit?.release();
      await process(job);
    };
    const result = await h.runner.runWorkerOnce(total);
    expect(result.succeeded).toBe(total);
    expect(queries.mock.calls.length).toBeLessThanOrEqual(2);
    h.expectClean();
  });

  it.each([1, 10_000, 50_000])("bounds repeated candidate reads with %i blocked rows and ongoing arrivals", async count => {
    const h = harness(), backlog = blockedBacklog(h, count), abort = new AbortController();
    h.db.db.prepare("DELETE FROM evolution_jobs WHERE id='late-database'").run();
    const enqueued = new Map<string, number>(), waits: number[] = [];
    let pageCalls = 0, rowsRead = 0;
    const inspections = vi.spyOn(WorkerAdmissionWaitSet.prototype, "isBlocked");
    const page = h.repos.runtime.scheduling.candidatePage.bind(h.repos.runtime.scheduling);
    vi.spyOn(h.repos.runtime.scheduling, "candidatePage").mockImplementation(input => {
      const rows = page(input); pageCalls++; rowsRead += rows.length; return rows;
    });
    const process = h.deps.jobHandlers.processJob;
    h.deps.jobHandlers.processJob = async job => {
      waits.push(performance.now() - enqueued.get(job.id)!);
      await new Promise(resolve => setTimeout(resolve, 1));
      await process(job);
    };
    const run = h.runner.runWorkerOnce(100, {}, { continuous: true, signal: abort.signal });
    try {
      for (let i = 0; i < 49; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        const id = `live-${i}`; enqueued.set(id, performance.now());
        h.job(id, "user_memory_embedding"); h.runner.notifyWorkAvailable();
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
      const sample = { backlog: count, added: enqueued.size, started: waits.length, notStarted: enqueued.size - waits.length,
        meanWaitMs: waits.reduce((a,b) => a+b, 0) / waits.length, maxWaitMs: Math.max(...waits), pageCalls, rowsRead, candidateChecks: inspections.mock.calls.length };
      console.log("CONTINUOUS_ARRIVALS", JSON.stringify(sample));
      expect(waits).toHaveLength(49);
      expect(Math.max(...waits)).toBeLessThan(1000);
      expect(rowsRead).toBeLessThanOrEqual(count + 49 + 200);
      expect(inspections.mock.calls.length).toBeLessThanOrEqual(count + 49 + 200);
      expect(pageCalls).toBeLessThan(count / 64 * 12 + 2000);
      expect(backlog.prepared()).toBeLessThanOrEqual(count + 49);
      expect(backlog.prepared()).toBeGreaterThan(49);
    } finally { abort.abort(); h.runner.notifyWorkAvailable(); await run; backlog.held.release(); }
    // A later finite request starts from durable FIFO, not the cancelled scan.
    h.deps.jobHandlers.processJob = process;
    const resumed = await h.runner.runWorkerOnce(Math.min(3, count));
    expect(resumed.jobs.map(job => job.jobId)).toEqual(Array.from({ length: Math.min(3, count) }, (_, i) => `blocked-${i}`));
    h.expectClean();
  }, 30_000);

  it.each(["available", "runAfter", "expiredLease"] as const)("discovers a new delayed row behind the retained cursor when %s becomes due", async boundary => {
    const h = harness(), backlog = blockedBacklog(h, 100), abort = new AbortController();
    h.db.db.prepare("DELETE FROM evolution_jobs WHERE id='late-database'").run();
    let clock = Date.now();
    h.deps.nowIso = () => new Date(clock).toISOString(); h.deps.nowMs = () => clock;
    const run = h.runner.runWorkerOnce(100, {}, { continuous: true, signal: abort.signal });
    try {
      for (let i = 0; i < 8; i++) await nextTurn();
      h.job("new-delayed", "user_memory_embedding");
      const future = new Date(clock + 1000).toISOString();
      if (boundary === "available") h.db.db.prepare("UPDATE evolution_jobs SET available_at=? WHERE id='new-delayed'").run(future);
      else if (boundary === "runAfter") h.db.db.prepare("UPDATE evolution_jobs SET payload_json=? WHERE id='new-delayed'").run(JSON.stringify({ runAfter: future }));
      else h.db.db.prepare("UPDATE evolution_jobs SET status='leased', leased_until=? WHERE id='new-delayed'").run(future);
      h.job("new-ready", "user_memory_embedding"); h.runner.notifyWorkAvailable();
      for (let i = 0; i < 12; i++) await nextTurn();
      expect(h.processed).toEqual(["new-ready"]);
      clock += 2000; h.runner.notifyWorkAvailable();
      for (let i = 0; i < 12; i++) await nextTurn();
      expect(h.processed).toEqual(["new-ready", "new-delayed"]);
    } finally { abort.abort(); h.runner.notifyWorkAvailable(); await run; backlog.held.release(); }
    h.expectClean();
  });

  it("finishes a bounded dependency sweep after one wake and then sleeps", async () => {
    const h = harness(), backlog = blockedBacklog(h, 1), abort = new AbortController();
    h.db.db.prepare("DELETE FROM evolution_jobs WHERE id='late-database'").run();
    const at = new Date().toISOString();
    h.repos.transaction(() => {
      for (let i = 0; i < 200; i++) {
        const id = `dependency-${i}`;
        h.db.db.prepare(`INSERT INTO memories(id,timeline,user_id,memory_value,memory_layer,created_at,updated_at)
          VALUES (?,?,'event-loop-user','synthetic','L1',?,?)`).run(id, at, at, at);
        h.db.db.prepare(`INSERT INTO memory_processing_state(memory_id,state,stage,updated_at)
          VALUES (?,'embedding_pending','embedding',?)`).run(id, at);
        h.job(`reward-${i}`, "reward");
        h.db.db.prepare("UPDATE evolution_jobs SET payload_json=? WHERE id=?")
          .run(JSON.stringify({ l1MemoryId: id, polarity: "positive" }), `reward-${i}`);
        h.repos.runtime.scheduling.refreshOne("main", `reward-${i}`);
      }
    });
    const pending = vi.spyOn(h.repos.runtime.scheduling, "isPendingCandidate");
    const eligible = vi.spyOn(h.repos.runtime.scheduling, "isEligibleCandidate");
    const run = h.runner.runWorkerOnce(100, {}, { continuous: true, signal: abort.signal });
    try {
      for (let i = 0; i < 40; i++) await nextTurn();
      expect(h.processed).toEqual([]);
      const idleChecks = pending.mock.calls.length;
      for (let i = 0; i < 10; i++) await nextTurn();
      expect(pending.mock.calls.length).toBe(idleChecks);
      eligible.mockClear(); h.runner.notifyWorkAvailable();
      for (let i = 0; i < 20; i++) await nextTurn();
      const target = eligible.mock.calls.filter(([candidate]) => candidate.id.startsWith("reward-")).at(-1)![0].id;
      h.db.db.prepare("UPDATE memory_processing_state SET state='ready' WHERE memory_id=?")
        .run(target.replace("reward-", "dependency-"));
      h.runner.notifyWorkAvailable();
      for (let i = 0; i < 40; i++) await nextTurn();
      expect(h.processed).toEqual([target]);
      const completedChecks = pending.mock.calls.length;
      for (let i = 0; i < 10; i++) await nextTurn();
      expect(pending.mock.calls.length).toBe(completedChecks);
    } finally { abort.abort(); h.runner.notifyWorkAvailable(); await run; backlog.held.release(); }
    h.expectClean();
  });

  it.each(["available", "runAfter", "expiredLease", "failed"] as const)("retains a %s deadline crossed inside the final discovery page", async boundary => {
    const h = harness(), abort = new AbortController();
    let clock = Date.now();
    h.deps.nowIso = () => new Date(clock).toISOString(); h.deps.nowMs = () => clock;
    h.job("due-during-query", "trace_summary");
    const future = new Date(clock + 10).toISOString();
    if (boundary === "available" || boundary === "failed") {
      h.db.db.prepare("UPDATE evolution_jobs SET available_at=?,status=? WHERE id='due-during-query'")
        .run(future, boundary === "failed" ? "failed" : "queued");
    } else if (boundary === "runAfter") {
      h.db.db.prepare("UPDATE evolution_jobs SET payload_json=? WHERE id='due-during-query'").run(JSON.stringify({ runAfter: future }));
    } else h.db.db.prepare("UPDATE evolution_jobs SET status='leased',leased_until=? WHERE id='due-during-query'").run(future);
    const backlog = blockedBacklog(h, 1);
    h.db.db.prepare("DELETE FROM evolution_jobs WHERE id='late-database'").run();
    h.db.db.prepare("UPDATE evolution_jobs SET queue_lane='interactive'").run();
    const prepare = h.deps.prepareExecution!;
    h.deps.prepareExecution = work => work.queue === "main" && work.job.id === "due-during-query"
      ? { providers: [], run: operation => operation() } : prepare(work);
    const page = h.repos.runtime.scheduling.candidatePage.bind(h.repos.runtime.scheduling);
    let crossed = false;
    vi.spyOn(h.repos.runtime.scheduling, "candidatePage").mockImplementation(input => {
      const rows = page(input);
      if (!crossed && rows.some(row => row.id === "blocked-0")) { clock += 20; crossed = true; }
      return rows;
    });
    const run = h.runner.runWorkerOnce(100, {}, { continuous: true, signal: abort.signal });
    try {
      for (let i = 0; i < 20; i++) await nextTurn();
      expect(crossed).toBe(true);
      expect(h.processed).toEqual(["due-during-query"]);
    } finally { abort.abort(); h.runner.notifyWorkAvailable(); await run; backlog.held.release(); }
    h.expectClean();
  });

  it("does not reread a fully scanned backlog after idle wakeups and a normal refill", async () => {
    const h = harness(), backlog = blockedBacklog(h, 1000), abort = new AbortController();
    h.db.db.prepare("DELETE FROM evolution_jobs WHERE id='late-database'").run();
    const page = h.repos.runtime.scheduling.candidatePage.bind(h.repos.runtime.scheduling);
    let rowsRead = 0;
    vi.spyOn(h.repos.runtime.scheduling, "candidatePage").mockImplementation(input => {
      const rows = page(input); rowsRead += rows.length; return rows;
    });
    let ended = false;
    const run = h.runner.runWorkerOnce(100, {}, { continuous: true, signal: abort.signal }).then(result => { ended = true; return result; });
    try {
      for (let i = 0; i < 50; i++) await nextTurn();
      expect(backlog.prepared()).toBe(1000); expect(rowsRead).toBe(1000);
      for (let i = 0; i < 10; i++) { h.runner.notifyWorkAvailable(); await nextTurn(); }
      h.job("new-live", "user_memory_embedding"); h.runner.notifyWorkAvailable();
      for (let i = 0; i < 10; i++) await nextTurn();
      expect(h.processed).toEqual(["new-live"]); expect(rowsRead).toBe(1001);
      // Old/raw producers classify at the next slice, without rewinding older
      // resource-blocked rows merely because this new sequence had no policy.
      const at = new Date().toISOString();
      h.db.db.prepare(`INSERT INTO evolution_jobs(id,job_type,status,user_id,payload_json,created_at,updated_at)
        VALUES ('raw-live','user_memory_embedding','queued','event-loop-user','{}',?,?)`).run(at, at);
      h.runner.notifyWorkAvailable();
      for (let i = 0; i < 10; i++) await nextTurn();
      expect(h.processed).toEqual(["new-live", "raw-live"]); expect(rowsRead).toBe(1002);
      expect(ended).toBe(false);
    } finally { abort.abort(); h.runner.notifyWorkAvailable(); await run; backlog.held.release(); }
    h.expectClean();
  });

  it("keeps dependency-blocked rows parked through unrelated completions and rediscovers them after an external dependency change", async () => {
    const h = harness(), backlog = blockedBacklog(h, 1), abort = new AbortController();
    h.db.db.prepare("DELETE FROM evolution_jobs WHERE id='late-database'").run();
    const at = new Date().toISOString();
    h.db.db.prepare(`INSERT INTO memories(id,timeline,user_id,memory_value,memory_layer,created_at,updated_at)
      VALUES ('dependency',?,'event-loop-user','synthetic','L1',?,?)`).run(at, at, at);
    h.db.db.prepare(`INSERT INTO memory_processing_state(memory_id,state,stage,updated_at)
      VALUES ('dependency','embedding_pending','embedding',?)`).run(at);
    h.repos.transaction(() => {
      for (let i = 0; i < 500; i++) {
        const job = h.job(`reward-${i}`, "reward");
        h.db.db.prepare("UPDATE evolution_jobs SET payload_json=? WHERE id=?")
          .run(JSON.stringify({ l1MemoryId: "dependency", polarity: "positive" }), job.id);
        h.repos.runtime.scheduling.refreshOne("main", job.id);
      }
    });
    let rowsRead = 0;
    const page = h.repos.runtime.scheduling.candidatePage.bind(h.repos.runtime.scheduling);
    vi.spyOn(h.repos.runtime.scheduling, "candidatePage").mockImplementation(input => {
      const rows = page(input); rowsRead += rows.length; return rows;
    });
    const process = h.deps.jobHandlers.processJob;
    h.deps.jobHandlers.processJob = async job => {
      await process(job);
      if (job.id === "reward-2") { abort.abort(); h.runner.notifyWorkAvailable(); }
    };
    const run = h.runner.runWorkerOnce(100, {}, { continuous: true, signal: abort.signal });
    try {
      for (let i = 0; i < 40; i++) await nextTurn();
      expect(rowsRead).toBe(501); expect(h.processed).toEqual([]);
      for (let i = 0; i < 5; i++) {
        h.job(`independent-${i}`, "user_memory_embedding"); h.runner.notifyWorkAvailable();
        for (let j = 0; j < 5; j++) await nextTurn();
      }
      expect(h.processed).toEqual(Array.from({ length: 5 }, (_, i) => `independent-${i}`));
      expect(rowsRead).toBe(506);
      // This update does not change policy revision or emit a model release.
      h.db.db.prepare("UPDATE memory_processing_state SET state='ready' WHERE memory_id='dependency'").run();
      h.runner.notifyWorkAvailable(); await run;
      expect(h.processed.filter(id => id.startsWith("reward-")).slice(0, 3)).toEqual(["reward-0", "reward-1", "reward-2"]);
      expect(rowsRead).toBe(506);
    } finally { abort.abort(); h.runner.notifyWorkAvailable(); await run; backlog.held.release(); }
    h.expectClean();
  });

  it("reaches an independent evolution Provider behind 20,000 blocked jobs during ongoing interference", async () => {
    const h = harness(), backlog = blockedBacklog(h, 20_000), abort = new AbortController();
    h.deps.scheduling = { algorithm: "wrr", aging: { enabled: true, thresholdMs: 1 } };
    h.db.db.prepare("UPDATE evolution_jobs SET job_type='reflection' WHERE id='late-database'").run();
    h.repos.runtime.scheduling.refreshOne("main", "late-database");
    h.db.db.prepare("UPDATE evolution_jobs SET queue_lane='import', first_queued_at='2000-01-01T00:00:00.000Z'").run();
    const prepare = h.deps.prepareExecution!;
    h.deps.prepareExecution = work => {
      const execution = prepare(work);
      return work.queue === "main" && work.job.id === "late-database"
        ? { ...execution, providers: [{ key: "independent-evolution", limit: 1 }] } : execution;
    };
    let releases = 0;
    const interference = (async () => {
      for (let turn = 0; turn < 400 && !abort.signal.aborted; turn++) {
        await nextTurn();
        await h.concurrency.runRequest({ local: false, providers: [{ key: "noise", limit: 1 }] }, async () => {});
        releases++;
      }
      abort.abort();
    })();
    try {
      const result = await h.runner.runWorkerOnce(1, {}, { signal: abort.signal });
      expect(result.jobs.map(job => job.jobId)).toEqual(["late-database"]);
      expect(releases).toBeGreaterThan(0);
      expect(releases).toBeLessThan(400);
      expect(backlog.prepared()).toBe(20_001);
      expect(h.db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs WHERE status='queued' AND attempts=0 AND lease_token IS NULL").get()).toEqual({ n: 20_000 });
    } finally { abort.abort(); await interference; backlog.held.release(); }
    h.expectClean();
  }, 30_000);

  it("does not re-prepare already blocked rows after a full scan on unrelated wakeups", async () => {
    const h = harness(), backlog = blockedBacklog(h, 100), abort = new AbortController();
    h.db.db.prepare("DELETE FROM evolution_jobs WHERE id='late-database'").run();
    const run = h.runner.runWorkerOnce(2, {}, { signal: abort.signal });
    try {
      for (let i = 0; i < 8; i++) await nextTurn();
      expect(backlog.prepared()).toBe(100);
      for (let i = 0; i < 8; i++) {
        await h.concurrency.runRequest({ local: false, providers: [{ key: "noise", limit: 1 }] }, async () => {});
        await nextTurn();
      }
      expect(backlog.prepared()).toBe(100);
      backlog.held.release();
      expect((await run).jobs.map(job => job.jobId)).toEqual(["blocked-0", "blocked-1"]);
    } finally { abort.abort(); backlog.held.release(); await run; }
    h.expectClean();
  });

  it("rechecks a parked row after its stored execution metadata changes", async () => {
    const h = harness(), backlog = blockedBacklog(h), abort = new AbortController();
    const prepare = h.deps.prepareExecution!;
    h.deps.prepareExecution = work => {
      const execution = prepare(work);
      return work.queue === "main" && work.job.payload.independent === true
        ? { ...execution, providers: [] } : execution;
    };
    const changed = (async () => {
      await nextTurn();
      h.db.db.prepare("UPDATE evolution_jobs SET payload_json=? WHERE id='blocked-0'")
        .run(JSON.stringify({ independent: true }));
      h.repos.runtime.scheduling.refreshOne("main", "blocked-0");
      h.db.db.prepare("UPDATE evolution_jobs SET queue_lane='import' WHERE id='blocked-0'").run();
      h.runner.notifyWorkAvailable();
    })();
    try {
      const result = await h.runner.runWorkerOnce(1, {}, { signal: abort.signal });
      expect(result.jobs.map(job => job.jobId)).toEqual(["blocked-0"]);
      expect(h.repos.runtime.getJob("late-database")).toMatchObject({ status: "queued", attempts: 0 });
    } finally { abort.abort(); await changed; backlog.held.release(); }
    h.expectClean();
  });

  it("does not keep a finite drain waiting on parked records that were deleted", async () => {
    const h = harness(), backlog = blockedBacklog(h, 8), abort = new AbortController();
    h.db.db.prepare("DELETE FROM evolution_jobs WHERE id='late-database'").run();
    let finished = false;
    const run = h.runner.runWorkerOnce(1, {}, { signal: abort.signal }).then(result => { finished = true; return result; });
    try {
      for (let i = 0; i < 4; i++) await nextTurn();
      expect(backlog.prepared()).toBe(8);
      h.db.db.prepare("DELETE FROM evolution_jobs").run();
      h.runner.notifyWorkAvailable();
      for (let i = 0; i < 4; i++) await nextTurn();
      expect(finished).toBe(true);
      expect((await run).leased).toBe(0);
    } finally { abort.abort(); backlog.held.release(); await run; }
    h.expectClean();
  });

  it.each([false, true])("makes progress through unrelated Provider releases (aging=%s)", async aging => {
    const h = harness(), backlog = blockedBacklog(h, 2_000), abort = new AbortController();
    h.deps.scheduling = { algorithm: "wrr", aging: { enabled: aging, thresholdMs: 1 } };
    h.db.db.prepare("UPDATE evolution_jobs SET first_queued_at='2000-01-01T00:00:00.000Z'").run();
    const noise = { local: false, providers: [{ key: "unrelated-foreground", limit: 1 }] };
    let releases = 0;
    const interference = (async () => {
      for (let turn = 0; turn < 80 && !abort.signal.aborted; turn++) {
        await nextTurn();
        await h.concurrency.runRequest(noise, async () => {});
        releases++;
      }
      abort.abort();
    })();
    try {
      const result = await h.runner.runWorkerOnce(1, {}, { signal: abort.signal });
      expect(releases).toBeGreaterThan(0);
      expect(result.jobs.map(job => job.jobId)).toEqual(["late-database"]);
      expect(backlog.prepared()).toBe(backlog.count + 1);
      expect(h.repos.runtime.getJob("blocked-0")).toMatchObject({ status: "queued", attempts: 0, leaseToken: null });
    } finally { abort.abort(); await interference; backlog.held.release(); }
    h.expectClean();
  });

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
