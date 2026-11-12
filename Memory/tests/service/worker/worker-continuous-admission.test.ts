import { mkdtempSync, rmSync } from "node:fs";
import { getEventListeners } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories, type EvolutionJobRecord } from "../../../src/storage/repositories.js";
import { WorkerConcurrencyController, type PreparedWorkerExecution } from "../../../src/service/worker/worker-concurrency.js";
import type { FairClaimedWork } from "../../../src/service/worker/fair-worker-queue.js";
import { WorkerRunner, type WorkerRunnerDeps } from "../../../src/service/worker/worker-runner.js";
import { createCapturingEmbedder } from "../../fixtures/memory-service-fixture.js";

const epoch = Date.parse("2026-10-22T00:00:00.000Z");
const at = new Date(epoch).toISOString();
const resources: Array<{ root: string; db: MemoryDb }> = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
type HarnessOptions = { concurrency?: WorkerConcurrencyController; algorithm?: "wrr" | "legacy"; process?: (job: EvolutionJobRecord) => Promise<void> };

/** Real SQLite and claim transitions; business/model work is a local substitute. */
function harness(options: HarnessOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "memmy-worker-pump-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  resources.push({ root, db });
  const repos = new Repositories(db.db);
  const executed: string[] = [];
  const deps: WorkerRunnerDeps = {
    repos, embedder: createCapturingEmbedder([]), capture: { embedAfterCapture: true },
    embeddingRetryWorkerId: "pump-test", memoryAddEnabled: () => true,
    memoryBudgetPaused: () => false, memoryBudgetJobConsumes: () => false,
    memoryBudgetModelSources: () => ({ embedding: { mode: "local" } }),
    memoryBudgetNextWakeAtMs: () => Date.now(), summaryModelConfigured: () => true,
    schedulingShadow: { enabled: false },
    ...(options.algorithm ? { scheduling: { algorithm: options.algorithm } } : {}),
    nowIso: () => new Date().toISOString(), encodeChangeCursor: String,
    namespaceIdFromMemory: () => "synthetic",
    runWorkerNoWrite: async () => { throw new Error("unexpected disabled worker"); },
    restartFailedProcessing: () => 0,
    previewPolicyEvidenceReconciliation: () => ({ orphanPolicyIds: [], affectedWorldModelIds: [], affectedSkillIds: [], restorablePolicyIds: [] }),
    reconcileOrphanedPolicies: () => 0,
    enqueueJob: () => { throw new Error("unexpected startup enqueue"); },
    enqueueEmbeddingRetry: () => { throw new Error("unexpected replacement retry"); },
    appendJobChange: () => {}, appendEmbeddingRetryChange: () => {},
    jobHandlers: { processJob: async (job) => { executed.push(job.id); await options.process?.(job); } },
    embeddingJobs: {
      prepareEmbeddingJob: () => { throw new Error("unexpected main embedding job"); },
      applyEmbeddingVector: () => {}, enqueueEmbeddingRetryAfterFailure: () => false,
      persistEmbeddingVector: (input) => {
        const memory = repos.memories.get(input.memoryId)!;
        executed.push(`retry:${input.memoryId}`);
        input.finalize?.(memory, false, new Date().toISOString());
        return memory;
      }
    }
  };
  const concurrency = options.concurrency ?? new WorkerConcurrencyController({}, {});
  deps.concurrency = concurrency;
  const runner = new WorkerRunner(deps);
  function memory(id: string, createdAt = at, tags: string[] = ["agent-source"]) {
    db.db.prepare(`INSERT INTO memories(id,timeline,user_id,memory_value,memory_layer,tags_json,created_at,updated_at)
      VALUES (?,?,'user','synthetic','L1',?,?,?)`).run(id, createdAt, JSON.stringify(tags), createdAt, createdAt);
  }
  function job(id: string, jobType: EvolutionJobRecord["jobType"] = "reflection", input: {
    target?: string; source?: string; createdAt?: string; payload?: Record<string, unknown>;
    scopeKey?: string; scopeSeq?: number; episodeId?: string; sessionId?: string;
  } = {}) {
    return repos.runtime.enqueueJob({ id, jobType, userId: "user", targetMemoryId: input.target,
      scopeKey: input.scopeKey, scopeSeq: input.scopeSeq, episodeId: input.episodeId, sessionId: input.sessionId,
      payload: { ...input.payload, ...(input.source ? { source: input.source } : {}) },
      status: "queued", attempts: 0, maxAttempts: 3, createdAt: input.createdAt ?? at, updatedAt: at });
  }
  function retry(id: string, createdAt = at) {
    memory(id, createdAt);
    return repos.runtime.enqueueEmbeddingRetry({ id, targetKind: "trace", targetId: id,
      vectorField: "vec_summary", sourceText: "synthetic", now: epoch });
  }
  return { root, db, repos, deps, runner, job, memory, retry, executed, concurrency };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(epoch);
  vi.stubEnv("MEMMY_WORKER_SCHEDULER_ALGORITHM", "wrr");
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
  for (const { root, db } of resources.splice(0)) {
    if (db.db.open) db.close();
    rmSync(root, { recursive: true, force: true });
  }
});


async function flushPump() {
  for (let i = 0; i < 200; i++) await Promise.resolve();
}
function mainRows(h: ReturnType<typeof harness>) {
  return h.db.db.prepare("SELECT id,status,attempts,lease_token FROM evolution_jobs ORDER BY enqueue_seq").all() as
    Array<{ id: string; status: string; attempts: number; lease_token: string | null }>;
}

function expectNoPermits(h: ReturnType<typeof harness>) {
  expect(h.concurrency.snapshot()).toEqual({ activeJobs: 0, availableJobs: h.concurrency.limits.maxActiveJobs,
    backgroundActiveJobs: 0, maxBackgroundJobs: h.concurrency.limits.maxBackgroundJobs,
    interactiveReservedSlots: h.concurrency.limits.interactiveReservedSlots, resources: {}, providers: {}, scopeKeys: [], embeddingRequests: 0 });
}
function prepareProviders(h: ReturnType<typeof harness>, prepare: (work: FairClaimedWork) => PreparedWorkerExecution) {
  h.deps.prepareExecution = prepare;
}

describe("continuous worker admission with real SQLite", () => {
  it("rechecks multiple required Providers in turn without losing FIFO or reserving partial capacity", async () => {
    const h = harness();
    const holds = ["A", "B"].map(key => h.concurrency.tryAcquire({ resourceClass: "summary",
      queueLane: "interactive", providers: [{ key, limit: 1 }], scopeKeys: [] })!);
    prepareProviders(h, () => ({ providers: [{ key: "A", limit: 1 }, { key: "B", limit: 1 }], run: operation => operation() }));
    h.job("oldest", "trace_summary"); h.job("next", "trace_summary");
    const positions = mainRows(h).map(row => row.id);
    const run = h.runner.runWorkerOnce(100);
    try {
      await flushPump();
      expect(h.executed).toEqual([]);
      holds[0]!.release(); await flushPump();
      expect(h.executed).toEqual([]);
      expect(h.concurrency.snapshot().providers).toEqual({ B: 1 });
      expect(mainRows(h).every(row => row.status === "queued" && row.attempts === 0 && row.lease_token === null)).toBe(true);
      holds[1]!.release();
      expect((await run).jobs.map(job => job.jobId)).toEqual(positions);
      expect(h.executed).toEqual(["oldest", "next"]);
    } finally { holds.forEach(permit => permit.release()); await run; }
    expectNoPermits(h);
  });

  it("finishes a drained request while an unrelated foreground Provider is still held", async () => {
    const h = harness(), gate = deferred(), entered = deferred(), abort = new AbortController();
    const foreground = h.concurrency.runRequest({ local: false, providers: [{ key: "unrelated", limit: 1 }] }, async () => {
      entered.resolve(); await gate.promise;
    });
    await entered.promise;
    prepareProviders(h, () => ({ providers: [{ key: "shared-worker", limit: 1 }], run: operation => operation() }));
    h.job("first", "trace_summary"); h.job("second", "trace_summary");
    let finished = false;
    const run = h.runner.runWorkerOnce(100, {}, { signal: abort.signal }).then(result => { finished = true; return result; });
    try {
      await flushPump();
      expect(finished).toBe(true);
      expect(h.executed).toEqual(["first", "second"]);
      expect(h.concurrency.snapshot().providers).toEqual({ unrelated: 1 });
    } finally { abort.abort(); gate.resolve(); await foreground; await run; }
    expectNoPermits(h);
  });

  it("reawakens parked embedding retries without changing their FIFO positions or attempts before admission", async () => {
    const h = harness();
    const held = h.concurrency.tryAcquire({ resourceClass: "embedding", embedding: true,
      providers: [{ key: "embedding-provider", limit: 1 }], scopeKeys: [] })!;
    prepareProviders(h, () => ({ providers: [{ key: "embedding-provider", limit: 1 }], embedding: true, run: operation => operation() }));
    h.retry("retry-oldest"); h.retry("retry-next");
    const run = h.runner.runEmbeddingRetryOnce(2);
    try {
      await flushPump();
      expect(h.executed).toEqual([]);
      expect(h.repos.runtime.getEmbeddingRetry("retry-oldest")).toMatchObject({ status: "pending", attempts: 0 });
      held.release();
      const result = await run;
      expect(result.items.map(item => item.id)).toEqual(["retry-oldest", "retry-next"]);
      expect(result).toMatchObject({ leased: 2, succeeded: 2, failed: 0 });
    } finally { held.release(); await run; }
    expectNoPermits(h);
  });

  it("keeps limit=100 as a drain budget rather than leasing waiting tasks ahead of capacity", async () => {
    const gate = deferred();
    const started: string[] = [];
    const h = harness({ process: async job => { started.push(job.id); await gate.promise; } });
    for (let i = 0; i < 12; i++) h.job(`summary-${i}`, "trace_summary");
    const run = h.runner.runWorkerOnce(100);
    try {
      await flushPump();
      expect(started.length).toBeGreaterThan(0);
      expect(started.length).toBeLessThanOrEqual(4);
      const rows = mainRows(h);
      const leased = rows.filter(row => row.status === "leased");
      expect(leased.map(row => row.id).sort()).toEqual([...started].sort());
      expect(leased.length).toBeLessThanOrEqual(4);
      for (const row of rows.filter(row => !started.includes(row.id))) {
        expect(row).toMatchObject({ status: "queued", attempts: 0, lease_token: null });
      }
    } finally { gate.resolve(); await run; }
  });

  it("refills a slot after a fast task completes while an earlier slow task is still running", async () => {
    const slow = deferred();
    let slowFinished = false;
    const h = harness({ process: async job => {
      if (job.id === "summary-0") { await slow.promise; slowFinished = true; }
    } });
    for (let i = 0; i < 12; i++) h.job(`summary-${i}`, "trace_summary");
    const run = h.runner.runWorkerOnce(12);
    try {
      await flushPump();
      expect(slowFinished).toBe(false);
      expect(h.executed).toContain("summary-4");
      expect(h.repos.runtime.getJob("summary-4")!.status).toBe("succeeded");
      expect(h.repos.runtime.getJob("summary-0")!.status).toBe("leased");
    } finally { slow.resolve(); await run; }
  });

  it("shares the global logical cap across task kinds and admits another resource while summaries wait", async () => {
    const gate = deferred();
    const active = new Set<string>();
    const types = new Set<string>();
    let maximum = 0;
    const h = harness({ concurrency: new WorkerConcurrencyController({ resourceLimits: { summary: 2 } }, {}), process: async job => {
      active.add(job.id); types.add(job.jobType); maximum = Math.max(maximum, active.size);
      try { await gate.promise; } finally { active.delete(job.id); }
    } });
    for (let i = 0; i < 8; i++) h.job(`summary-${i}`, "trace_summary");
    for (let i = 0; i < 3; i++) {
      h.job(`reflection-${i}`, "reflection");
      h.job(`database-${i}`, "l2_association");
      h.job(`maintenance-${i}`, "project_environment_profile", { payload: { projectId: `project-${i}` } });
    }
    const run = h.runner.runWorkerOnce(100);
    try {
      await flushPump();
      expect(maximum).toBeLessThanOrEqual(4);
      expect(types.size).toBeGreaterThan(1);
      expect(mainRows(h).filter(row => row.status === "leased")).toHaveLength(active.size);
    } finally { gate.resolve(); await run; }
    expect(active.size).toBe(0);
    expectNoPermits(h);
    expect(mainRows(h).every(row => row.status === "succeeded")).toBe(true);
  });

  it("does not lease a second task for the same target while the target is already executing", async () => {
    const gate = deferred();
    const h = harness({ process: async () => { await gate.promise; } });
    h.memory("shared-target", at, []);
    for (let i = 0; i < 4; i++) h.job(`target-${i}`, "trace_summary", { target: "shared-target" });
    const run = h.runner.runWorkerOnce(4);
    try {
      await flushPump();
      expect(h.executed).toEqual(["target-0"]);
      expect(h.repos.runtime.getJob("target-1")).toMatchObject({ status: "queued", attempts: 0, leaseToken: null });
    } finally { gate.resolve(); await run; }
    expect(h.executed).toEqual(["target-0", "target-1", "target-2", "target-3"]);
  });

  it("keeps same-episode tasks queued while their episode scope is occupied", async () => {
    const gate = deferred();
    const h = harness({ process: async () => { await gate.promise; } });
    h.job("episode-title", "episode_title", { episodeId: "episode-A" });
    h.job("episode-reward", "reward", { episodeId: "episode-A" });
    const run = h.runner.runWorkerOnce(2);
    try {
      await flushPump();
      expect(h.executed).toEqual(["episode-title"]);
      expect(h.repos.runtime.getJob("episode-reward")).toMatchObject({ status: "queued", attempts: 0, leaseToken: null });
    } finally { gate.resolve(); await run; }
    expect(h.executed).toEqual(["episode-title", "episode-reward"]);
  });

  it("preserves L3 user/project serialization without keeping later scope jobs leased", async () => {
    const gate = deferred();
    const h = harness({ process: async () => { await gate.promise; } });
    h.job("L3-A-1", "l3_world_model_update", { scopeKey: "user/project-A", scopeSeq: 1, payload: { projectId: "project-A" } });
    h.job("L3-A-2", "l3_world_model_update", { scopeKey: "user/project-A", scopeSeq: 2, payload: { projectId: "project-A" } });
    h.job("L3-B-1", "l3_world_model_update", { scopeKey: "user/project-B", scopeSeq: 1, payload: { projectId: "project-B" } });
    const run = h.runner.runWorkerOnce(3);
    try {
      await flushPump();
      expect(h.executed).toContain("L3-A-1");
      expect(h.repos.runtime.getJob("L3-A-2")).toMatchObject({ status: "queued", attempts: 0, leaseToken: null });
    } finally { gate.resolve(); await run; }
    expect(h.repos.runtime.getJob("L3-A-2")!.status).toBe("succeeded");
  });

  it("bounds an Embedding microbatch by both batch size and free logical capacity", async () => {
    const gate = deferred();
    const calls: string[][] = [];
    const h = harness();
    h.deps.embeddingJobs.prepareEmbeddingJob = job => ({ job, memory: h.repos.memories.get(job.targetMemoryId!)!,
      text: job.id, role: "document", vectorField: "vec_summary" });
    h.deps.embedder.embed = async texts => { calls.push([...texts]); await gate.promise; return texts.map(() => [1, 0, 0]); };
    for (let i = 0; i < 20; i++) {
      h.memory(`embedding-${i}`, at, []);
      h.job(`embedding-${i}`, "embedding", { target: `embedding-${i}` });
    }
    const run = h.runner.runWorkerOnce(100);
    try {
      await flushPump();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.length).toBeLessThanOrEqual(16);
      expect(calls[0]!.length).toBeLessThanOrEqual(4);
      const rows = mainRows(h);
      expect(rows.filter(row => row.status === "leased")).toHaveLength(calls[0]!.length);
      for (const row of rows.filter(row => row.status === "queued")) {
        expect(row).toMatchObject({ attempts: 0, lease_token: null });
      }
    } finally { gate.resolve(); await run; }
    expect(calls.flat()).toHaveLength(20);
    expect(h.repos.runtime.listJobs("succeeded")).toHaveLength(20);
  });


  it("uses the configured batch limit of sixteen when logical capacity is raised to thirty-two", async () => {
    const gate = deferred();
    const calls: string[][] = [];
    const h = harness({ concurrency: new WorkerConcurrencyController({ maxActiveJobs: 32,
      resourceLimits: { embedding: 32 }, embeddingBatchSize: 16, embeddingRequestConcurrency: 1 }, {}) });
    h.deps.embeddingJobs.prepareEmbeddingJob = job => ({ job, memory: h.repos.memories.get(job.targetMemoryId!)!,
      text: job.id, role: "document", vectorField: "vec_summary" });
    h.deps.embedder.embed = async texts => { calls.push([...texts]); await gate.promise; return texts.map(() => [1, 0, 0]); };
    for (let i = 0; i < 40; i++) {
      h.memory(`embedding-${i}`, at, []); h.job(`embedding-${i}`, "embedding", { target: `embedding-${i}` });
    }
    const run = h.runner.runWorkerOnce(100);
    try {
      await flushPump();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toHaveLength(16);
      expect(mainRows(h).filter(row => row.status === "leased")).toHaveLength(16);
      expect(h.concurrency.snapshot()).toMatchObject({ activeJobs: 16, embeddingRequests: 1 });
      expect(mainRows(h).filter(row => row.status === "queued").every(row => row.attempts === 0 && row.lease_token === null)).toBe(true);
    } finally { gate.resolve(); await run; }
    expect(calls.map(batch => batch.length)).toEqual([16, 16, 8]);
    expectNoPermits(h);
  });

  it.each([1, 2])("admits only the provider cap %s while other ready rows remain unclaimed", async limit => {
    const gate = deferred();
    const h = harness({ process: async () => { await gate.promise; } });
    prepareProviders(h, () => ({ providers: [{ key: "shared-model", limit }], run: operation => operation() }));
    for (let i = 0; i < 8; i++) h.job(`summary-${i}`, "trace_summary");
    const run = h.runner.runWorkerOnce(100);
    try {
      await flushPump();
      expect(h.executed).toHaveLength(limit);
      expect(mainRows(h).filter(row => row.status === "leased")).toHaveLength(limit);
      expect(h.concurrency.snapshot()).toMatchObject({ activeJobs: limit, providers: { "shared-model": limit } });
      expect(mainRows(h).filter(row => row.status === "queued").every(row => row.attempts === 0 && row.lease_token === null)).toBe(true);
    } finally { gate.resolve(); await run; }
    expect(h.executed).toHaveLength(8);
    expectNoPermits(h);
  });

  it("does not reserve any of a blocked task's providers and lets an independent provider progress", async () => {
    const gate = deferred();
    const h = harness({ process: async () => { await gate.promise; } });
    prepareProviders(h, work => {
      const id = work.queue === "main" ? work.job.id : work.retry.id;
      const keys = id === "A+B" ? ["A", "B"] : [id];
      return { providers: keys.map(key => ({ key, limit: 1 })), run: operation => operation() };
    });
    h.job("A", "trace_summary"); h.job("A+B", "trace_summary"); h.job("B", "trace_summary");
    const run = h.runner.runWorkerOnce(3);
    try {
      await flushPump();
      expect(h.executed).toEqual(["A", "B"]);
      expect(h.repos.runtime.getJob("A+B")).toMatchObject({ status: "queued", attempts: 0, leaseToken: null });
      expect(h.concurrency.snapshot()).toMatchObject({ activeJobs: 2, providers: { A: 1, B: 1 } });
    } finally { gate.resolve(); await run; }
    expect(h.repos.runtime.getJob("A+B")!.status).toBe("succeeded");
    expectNoPermits(h);
  });

  it("returns every permit after handler failures and permits later successful work", async () => {
    const h = harness({ process: async job => { if (job.id === "bad") throw new Error("temporary timeout"); } });
    prepareProviders(h, () => ({ providers: [{ key: "shared-model", limit: 1 }], run: operation => operation() }));
    h.job("bad", "trace_summary"); h.job("good", "trace_summary");
    expect(await h.runner.runWorkerOnce(2)).toMatchObject({ leased: 2, succeeded: 1, failed: 1 });
    expect(h.repos.runtime.getJob("good")!.status).toBe("succeeded");
    expectNoPermits(h);
  });

  it("returns reservations when a selected lease CAS fails", async () => {
    const h = harness();
    h.job("missed", "trace_summary"); h.job("good", "trace_summary");
    const original = h.repos.runtime.claimQueuedJob.bind(h.repos.runtime);
    const claim = vi.spyOn(h.repos.runtime, "claimQueuedJob").mockImplementation((id, input) => id === "missed" ? undefined : original(id, input));
    try {
      await h.runner.runWorkerOnce(2);
      expect(h.repos.runtime.getJob("missed")).toMatchObject({ status: "queued", attempts: 0, leaseToken: null });
      expect(h.repos.runtime.getJob("good")!.status).toBe("succeeded");
      expectNoPermits(h);
    } finally { claim.mockRestore(); }
  });

  it("returns reservations on claim exceptions and can run again after the database recovers", async () => {
    const h = harness(); h.job("recover", "trace_summary");
    const claim = vi.spyOn(h.repos.runtime, "claimQueuedJob").mockImplementationOnce(() => { throw new Error("synthetic SQLITE_BUSY"); });
    try {
      await expect(h.runner.runWorkerOnce(1)).rejects.toThrow("SQLITE_BUSY");
      expectNoPermits(h);
    } finally { claim.mockRestore(); }
    expect(await h.runner.runWorkerOnce(1)).toMatchObject({ leased: 1, succeeded: 1, failed: 0 });
    expectNoPermits(h);
  });

  it("keeps automatic, manual target and retry drains behind one execution boundary", async () => {
    const gate = deferred();
    const h = harness({ process: async job => { if (job.id === "slow") await gate.promise; } });
    h.job("slow", "trace_summary", { target: "target-A" });
    h.job("manual", "trace_summary", { target: "target-B" });
    h.retry("retry");
    const first = h.runner.runWorkerOnce(1, { targetMemoryIds: ["target-A"] });
    const manual = h.runner.runWorkerOnce(1, { targetMemoryIds: ["target-B"] });
    const retry = h.runner.runEmbeddingRetryOnce(1);
    try {
      await flushPump();
      expect(h.executed).toEqual(["slow"]);
      expect(h.repos.runtime.getJob("manual")).toMatchObject({ status: "queued", attempts: 0, leaseToken: null });
      expect(h.repos.runtime.getEmbeddingRetry("retry")).toMatchObject({ status: "pending", leaseToken: null });
    } finally { gate.resolve(); await Promise.all([first, manual, retry]); }
    expect(h.repos.runtime.getJob("manual")!.status).toBe("succeeded");
    expect(h.repos.runtime.getEmbeddingRetry("retry")!.status).toBe("succeeded");
    expectNoPermits(h);
  });

  it("cleans permits on shutdown and rejects newly submitted drains", async () => {
    const gate = deferred();
    const h = harness({ process: async () => { await gate.promise; } });
    prepareProviders(h, () => ({ providers: [{ key: "shared-model", limit: 2 }], run: operation => operation() }));
    for (let i = 0; i < 6; i++) h.job(`summary-${i}`, "trace_summary");
    const run = h.runner.runWorkerOnce(100);
    await flushPump();
    const stopped = h.runner.stop();
    const rejected = expect(h.runner.runWorkerOnce(1)).rejects.toThrow(/stopped/i);
    gate.resolve();
    await Promise.all([run, stopped, rejected]);
    expectNoPermits(h);
  });


  it("shares target exclusion between primary jobs and the retry backing table", async () => {
    const gate = deferred();
    const h = harness({ process: async () => { await gate.promise; } });
    h.memory("shared", at, []);
    h.job("summary", "trace_summary", { target: "shared" });
    h.repos.runtime.enqueueEmbeddingRetry({ id: "retry", targetKind: "trace", targetId: "shared",
      vectorField: "vec_summary", sourceText: "synthetic", now: epoch });
    const embed = vi.spyOn(h.deps.embedder, "embed");
    const run = h.runner.runWorkerOnce(2);
    try {
      await flushPump();
      expect(h.executed).toEqual(["summary"]);
      expect(embed).not.toHaveBeenCalled();
      expect(h.repos.runtime.getEmbeddingRetry("retry")).toMatchObject({ status: "pending", attempts: 0,
        claimedBy: null, leaseToken: null });
    } finally { gate.resolve(); await run; }
    expect(h.repos.runtime.getEmbeddingRetry("retry")!.status).toBe("succeeded");
    expectNoPermits(h);
  });

  it("uses the same user/project exclusion for L3 and Work Memory without blocking another project", async () => {
    const gate = deferred();
    const h = harness({ process: async () => { await gate.promise; } });
    h.job("L3-A", "l3_world_model_update", { scopeKey: "user/project-A", scopeSeq: 1, payload: { projectId: "project-A" } });
    h.job("Work-A", "work_memory_extract", { scopeKey: "user/project-A", scopeSeq: 2, payload: { projectId: "project-A" } });
    h.job("L3-B", "l3_world_model_update", { scopeKey: "user/project-B", scopeSeq: 1, payload: { projectId: "project-B" } });
    const run = h.runner.runWorkerOnce(3);
    try {
      await flushPump();
      expect(h.executed).toEqual(["L3-A", "L3-B"]);
      expect(h.repos.runtime.getJob("Work-A")).toMatchObject({ status: "queued", attempts: 0, leaseToken: null });
    } finally { gate.resolve(); await run; }
    expect(h.repos.runtime.getJob("Work-A")!.status).toBe("succeeded");
    expectNoPermits(h);
  });

  it("counts existing running jobs when building an Embedding microbatch", async () => {
    const gate = deferred();
    const h = harness({ process: async () => { await gate.promise; } });
    const calls: string[][] = [];
    h.deps.embeddingJobs.prepareEmbeddingJob = job => ({ job, memory: h.repos.memories.get(job.targetMemoryId!)!,
      text: job.id, role: "document", vectorField: "vec_summary" });
    h.deps.embedder.embed = async texts => { calls.push([...texts]); await gate.promise; return texts.map(() => [1, 0, 0]); };
    h.job("summary-0", "trace_summary"); h.job("summary-1", "trace_summary");
    for (let i = 0; i < 8; i++) {
      h.memory(`embedding-${i}`, at, []); h.job(`embedding-${i}`, "embedding", { target: `embedding-${i}` });
    }
    const run = h.runner.runWorkerOnce(100);
    try {
      await flushPump();
      expect(h.executed).toEqual(["summary-0", "summary-1"]);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toHaveLength(2);
      expect(h.concurrency.snapshot()).toMatchObject({ activeJobs: 4, embeddingRequests: 1 });
      expect(mainRows(h).filter(row => row.status === "leased")).toHaveLength(4);
    } finally { gate.resolve(); await run; }
    expectNoPermits(h);
  });


  it("keeps already running work protected when a later refill claim throws", async () => {
    const gate = deferred();
    const h = harness({ process: async job => { if (job.id === "summary-0") await gate.promise; } });
    for (let i = 0; i < 6; i++) h.job(`summary-${i}`, "trace_summary");
    const original = h.repos.runtime.claimQueuedJob.bind(h.repos.runtime);
    let refillFailed = false;
    const claim = vi.spyOn(h.repos.runtime, "claimQueuedJob").mockImplementation((id, input) => {
      if (id === "summary-4") { refillFailed = true; throw new Error("refill SQLITE_BUSY"); }
      return original(id, input);
    });
    let settled = false;
    const run = h.runner.runWorkerOnce(6);
    void run.then(() => { settled = true; }, () => { settled = true; });
    try {
      await flushPump();
      expect(refillFailed).toBe(true);
      expect(settled).toBe(false);
      expect(h.repos.runtime.getJob("summary-0")!.status).toBe("leased");
      expect(h.concurrency.snapshot().activeJobs).toBe(1);
    } finally {
      gate.resolve();
      await expect(run).rejects.toThrow("refill SQLITE_BUSY");
      claim.mockRestore();
    }
    expectNoPermits(h);
    expect(h.repos.runtime.getJob("summary-0")!.status).toBe("succeeded");
    expect(h.repos.runtime.getJob("summary-4")).toMatchObject({ status: "queued", attempts: 0, leaseToken: null });
  });


  it("keeps individual attempt results when the same task becomes due again during a long drain", async () => {
    const gate = deferred();
    let flakyAttempts = 0;
    const h = harness({ process: async job => {
      if (job.id === "slow") await gate.promise;
      if (job.id === "flaky" && flakyAttempts++ === 0) throw new Error("temporary timeout");
    } });
    h.job("flaky", "trace_summary"); h.job("slow", "trace_summary");
    const run = h.runner.runWorkerOnce(3);
    try {
      await flushPump();
      expect(h.repos.runtime.getJob("flaky")).toMatchObject({ status: "failed", failureCount: 1 });
      vi.setSystemTime(epoch + 10_000);
      h.runner.notifyWorkAvailable();
      await flushPump();
      expect(flakyAttempts).toBe(2);
      expect(h.repos.runtime.getJob("flaky")!.status).toBe("succeeded");
    } finally { gate.resolve(); }
    const result = await run;
    expect(result).toMatchObject({ leased: 3, succeeded: 2, failed: 1 });
    expect(result.jobs).toEqual([
      expect.objectContaining({ jobId: "flaky", status: "failed" }),
      expect.objectContaining({ jobId: "slow", status: "succeeded" }),
      expect.objectContaining({ jobId: "flaky", status: "succeeded" })
    ]);
    expectNoPermits(h);
  });


  it("admits newly queued independent work before an existing slow task completes", async () => {
    const gate = deferred();
    const h = harness({ process: async job => { if (job.id === "slow") await gate.promise; } });
    prepareProviders(h, work => ({ providers: [{ key: work.queue === "main" && work.job.id === "slow" ? "model-A" : "model-B", limit: 1 }],
      run: operation => operation() }));
    h.job("slow", "trace_summary");
    const run = h.runner.runWorkerOnce(2);
    try {
      await flushPump();
      expect(h.executed).toEqual(["slow"]);
      h.job("late-database", "l2_association");
      h.runner.notifyWorkAvailable();
      await flushPump();
      expect(h.executed).toEqual(["slow", "late-database"]);
      expect(h.repos.runtime.getJob("late-database")!.status).toBe("succeeded");
      expect(h.repos.runtime.getJob("slow")!.status).toBe("leased");
    } finally { gate.resolve(); await run; }
    expectNoPermits(h);
  });

  it("wakes a drain when an external foreground request releases its provider", async () => {
    const gate = deferred(), entered = deferred();
    const h = harness();
    const descriptor = { local: false, providers: [{ key: "external-model", limit: 1 }] };
    prepareProviders(h, () => ({ providers: descriptor.providers, run: operation => operation() }));
    const foreground = h.concurrency.runRequest(descriptor, async () => { entered.resolve(); await gate.promise; });
    await entered.promise;
    h.job("waiting-summary", "trace_summary");
    const run = h.runner.runWorkerOnce(1);
    try {
      await flushPump();
      expect(h.executed).toEqual([]);
      expect(h.repos.runtime.getJob("waiting-summary")).toMatchObject({ status: "queued", attempts: 0, leaseToken: null });
      gate.resolve(); await foreground;
      await flushPump();
      expect(h.executed).toEqual(["waiting-summary"]);
    } finally { gate.resolve(); await foreground; h.runner.notifyWorkAvailable(); await run; }
    expectNoPermits(h);
  });

  it("keeps the last valid Embedding share group when a middle row fails its first lease CAS", async () => {
    const h = harness();
    const calls: string[][] = [];
    h.deps.embeddingJobs.prepareEmbeddingJob = job => ({ job, memory: h.repos.memories.get(job.targetMemoryId!)!,
      text: job.id, role: "document", vectorField: "vec_summary" });
    h.deps.embedder.embed = async texts => { calls.push([...texts]); return texts.map(() => [1, 0, 0]); };
    for (let i = 0; i < 3; i++) {
      h.memory(`embedding-${i}`, at, []); h.job(`embedding-${i}`, "embedding", { target: `embedding-${i}` });
    }
    const original = h.repos.runtime.claimQueuedJob.bind(h.repos.runtime);
    let missed = false;
    const claim = vi.spyOn(h.repos.runtime, "claimQueuedJob").mockImplementation((id, input) => {
      if (id === "embedding-1" && !missed) { missed = true; return undefined; }
      return original(id, input);
    });
    try {
      expect(await h.runner.runWorkerOnce(3)).toMatchObject({ leased: 3, succeeded: 3, failed: 0 });
      expect(calls).toEqual([["embedding-0", "embedding-2"], ["embedding-1"]]);
      expect(h.repos.runtime.getJob("embedding-1")).toMatchObject({ status: "succeeded", attempts: 1, failureCount: 0 });
      expectNoPermits(h);
    } finally { claim.mockRestore(); }
  });


  it("uses persisted session and L3 batch projects when production payloads omit projectId", async () => {
    const gate = deferred();
    const h = harness({ process: async () => { await gate.promise; } });
    h.db.db.prepare(`INSERT INTO sessions
      (id,user_id,project_id,source,profile_id,opened_at,last_seen_at,updated_at)
      VALUES ('work-session','user','real-project','codex','test',?,?,?)`).run(at, at, at);
    const scope = h.repos.l3WorldModels.ensureScope("user", "real-project", at);
    h.db.db.prepare(`INSERT INTO l3_world_model_evidence_batches
      (id,scope_key,scope_seq,user_id,project_id,session_id,trigger,start_trace_seq,end_trace_seq,
       l1_memory_ids_json,raw_turn_ids_json,feedback_ids_json,payload_hash,created_at,updated_at)
      VALUES ('real-batch',?,1,'user','real-project','work-session','session_close',1,1,
       '[]','[]','[]','synthetic-hash',?,?)`).run(scope.scopeKey, at, at);
    const l3 = h.job("production-L3", "l3_world_model_update", { scopeKey: "opaque-l3-field-hash", scopeSeq: 1,
      payload: { batchId: "real-batch", targetField: "project_contract" } });
    const work = h.job("production-Work", "work_memory_extract", { scopeKey: "different-opaque-work-hash", scopeSeq: 1,
      sessionId: "work-session", payload: { trajectoryHash: "synthetic-trajectory", qa: [] } });
    expect(l3.payload).not.toHaveProperty("projectId");
    expect(work.payload).not.toHaveProperty("projectId");
    expect(h.repos.runtime.getSession(work.sessionId!)!.projectId).toBe("real-project");
    expect(h.repos.l3WorldModels.getBatch(String(l3.payload.batchId))!.projectId).toBe("real-project");
    const run = h.runner.runWorkerOnce(2);
    try {
      await flushPump();
      expect(h.executed).toEqual(["production-L3"]);
      expect(h.repos.runtime.getJob("production-Work")).toMatchObject({ status: "queued", attempts: 0, leaseToken: null });
    } finally { gate.resolve(); await run; }
    expect(h.executed).toEqual(["production-L3", "production-Work"]);
    expectNoPermits(h);
  });

  it("does not busy-loop on synchronous CAS-release wakes while still waiting for an external provider", async () => {
    const gate = deferred(), entered = deferred();
    const h = harness();
    const descriptor = { local: false, providers: [{ key: "external-model", limit: 1 }] };
    prepareProviders(h, work => ({ providers: work.queue === "main" && work.job.id === "cas-miss" ? [] : descriptor.providers,
      run: operation => operation() }));
    const foreground = h.concurrency.runRequest(descriptor, async () => { entered.resolve(); await gate.promise; });
    await entered.promise;
    h.job("cas-miss", "trace_summary"); h.job("provider-waiting", "trace_summary");
    const original = h.repos.runtime.claimQueuedJob.bind(h.repos.runtime);
    let misses = 0;
    const claim = vi.spyOn(h.repos.runtime, "claimQueuedJob").mockImplementation((id, input) => {
      if (id === "cas-miss") { misses++; return undefined; }
      return original(id, input);
    });
    const run = h.runner.runWorkerOnce(1);
    try {
      await flushPump();
      expect(misses).toBe(1);
      expect(h.executed).toEqual([]);
      gate.resolve(); await foreground;
      await flushPump();
      expect(h.executed).toEqual(["provider-waiting"]);
    } finally { gate.resolve(); await foreground; h.runner.notifyWorkAvailable(); await run; claim.mockRestore(); }
    expectNoPermits(h);
  });


  it("wakes naturally at runAfter while an unrelated slow task still occupies one slot", async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch);
    const gate = deferred();
    const h = harness({ process: async job => { if (job.id === "slow") await gate.promise; } });
    h.job("slow", "trace_summary");
    h.job("scheduled-database", "l2_association", { payload: { runAfter: new Date(epoch + 5_000).toISOString() } });
    const run = h.runner.runWorkerOnce(100);
    try {
      await flushPump();
      expect(h.executed).toEqual(["slow"]);
      await vi.advanceTimersByTimeAsync(5_001);
      expect(h.executed).toEqual(["slow", "scheduled-database"]);
      expect(h.repos.runtime.getJob("scheduled-database")!.status).toBe("succeeded");
      expect(h.repos.runtime.getJob("slow")!.status).toBe("leased");
    } finally { gate.resolve(); await run; }
    expectNoPermits(h);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["wrr", "legacy"] as const)("wakes naturally when a failed main task's backoff expires without an explicit notify (%s)", async algorithm => {
    vi.useFakeTimers(); vi.setSystemTime(epoch);
    const gate = deferred();
    let attempts = 0;
    const h = harness({ algorithm, process: async job => {
      if (job.id === "slow") await gate.promise;
      if (job.id === "retry-after-backoff" && attempts++ === 0) throw new Error("temporary timeout");
    } });
    h.job("retry-after-backoff", "trace_summary"); h.job("slow", "trace_summary");
    const run = h.runner.runWorkerOnce(3, {}, { continuous: true });
    let result;
    try {
      await flushPump();
      const failed = h.repos.runtime.getJob("retry-after-backoff")!;
      expect(failed).toMatchObject({ status: "failed", failureCount: 1 });
      await vi.advanceTimersByTimeAsync(Date.parse(failed.availableAt!) - epoch + 1);
      expect(attempts).toBe(2);
      expect(h.repos.runtime.getJob("retry-after-backoff")!.status).toBe("succeeded");
      expect(h.repos.runtime.getJob("slow")!.status).toBe("leased");
    } finally { gate.resolve(); result = await run; }
    expect(result).toMatchObject({ leased: 3, succeeded: 2, failed: 1 });
    expectNoPermits(h);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("wakes naturally when an Embedding retry reaches nextAttemptAt", async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch);
    const gate = deferred();
    const h = harness({ process: async job => { if (job.id === "slow") await gate.promise; } });
    h.job("slow", "trace_summary"); const retry = h.retry("delayed-retry");
    h.db.db.prepare("UPDATE embedding_retry_queue SET next_attempt_at=? WHERE id=?").run(epoch + 5_000, retry.id);
    const run = h.runner.runWorkerOnce(2);
    try {
      await flushPump();
      expect(h.repos.runtime.getEmbeddingRetry(retry.id)).toMatchObject({ status: "pending", attempts: 0, leaseToken: null });
      await vi.advanceTimersByTimeAsync(5_001);
      expect(h.repos.runtime.getEmbeddingRetry(retry.id)!.status).toBe("succeeded");
      expect(h.repos.runtime.getJob("slow")!.status).toBe("leased");
    } finally { gate.resolve(); await run; }
    expectNoPermits(h);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("wakes at an expired foreign lease without waiting for an unrelated running task", async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch);
    const gate = deferred();
    const h = harness({ process: async job => { if (job.id === "slow") await gate.promise; } });
    h.job("recover-expired", "trace_summary");
    const foreign = h.repos.runtime.leaseQueuedJobs(1, 5)[0]!;
    h.job("slow", "trace_summary");
    const run = h.runner.runWorkerOnce(2);
    try {
      await flushPump();
      expect(h.executed).toEqual(["slow"]);
      await vi.advanceTimersByTimeAsync(5_001);
      expect(h.executed).toEqual(["slow", "recover-expired"]);
      expect(h.repos.runtime.getJob("recover-expired")).toMatchObject({ status: "succeeded", leaseRecoveryCount: 1,
        failureCount: 0, attempts: foreign.attempts });
    } finally { gate.resolve(); await run; }
    expectNoPermits(h);
    expect(vi.getTimerCount()).toBe(0);
  });


  it("reconciles a naturally due budget deadline during continuous execution before the slow task finishes", async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch);
    const gate = deferred();
    let paused = true, reconcileCalls = 0;
    const h = harness({ process: async job => { if (job.id === "slow-database") await gate.promise; } });
    h.deps.memoryBudgetPaused = () => paused;
    h.deps.memoryBudgetJobConsumes = type => type === "trace_summary";
    h.deps.memoryBudgetModelSources = () => ({ memory_summary: { source: "byok" }, memory_evolution: { source: "byok" },
      embedding: { source: "byok", mode: "remote" } });
    h.deps.memoryBudgetNextWakeAtMs = () => epoch + 86_400_000;
    h.deps.memoryBudgetNextReconcileAtMs = () => epoch + 5_000;
    h.deps.beforeRun = async () => {
      reconcileCalls++;
      if (Date.now() >= epoch + 5_000) paused = false;
    };
    h.job("slow-database", "l2_association"); h.job("budget-held-summary", "trace_summary");
    const run = h.runner.runWorkerOnce(100, {}, { continuous: true });
    try {
      await flushPump();
      expect(h.executed).toEqual(["slow-database"]);
      expect(reconcileCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(5_001);
      expect(h.executed).toEqual(["slow-database", "budget-held-summary"]);
      expect(h.repos.runtime.getJob("budget-held-summary")!.status).toBe("succeeded");
      expect(h.repos.runtime.getJob("slow-database")!.status).toBe("leased");
      expect(reconcileCalls).toBe(2);
      // A still-stale callback deadline must not cause a reconcile busy loop.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reconcileCalls).toBe(2);
    } finally { gate.resolve(); await run; }
    expectNoPermits(h);
    expect(vi.getTimerCount()).toBe(0);
  });


  it("does not admit more work when continuous execution is aborted during an awaited budget reconciliation", async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch);
    const slow = deferred(), reconcile = deferred(), reconciling = deferred();
    const abort = new AbortController();
    let paused = true;
    const h = harness({ process: async job => { if (job.id === "slow-database") await slow.promise; } });
    h.deps.memoryBudgetPaused = () => paused;
    h.deps.memoryBudgetJobConsumes = type => type === "trace_summary";
    h.deps.memoryBudgetModelSources = () => ({ memory_summary: { source: "byok" }, memory_evolution: { source: "byok" },
      embedding: { source: "byok", mode: "remote" } });
    h.deps.memoryBudgetNextWakeAtMs = () => epoch + 86_400_000;
    h.deps.memoryBudgetNextReconcileAtMs = () => epoch + 5_000;
    h.deps.beforeRun = async () => {
      if (Date.now() >= epoch + 5_000) {
        reconciling.resolve(); await reconcile.promise; paused = false;
      }
    };
    h.job("slow-database", "l2_association"); h.job("not-admitted-after-abort", "trace_summary");
    const run = h.runner.runWorkerOnce(100, {}, { continuous: true, signal: abort.signal });
    try {
      await flushPump();
      await vi.advanceTimersByTimeAsync(5_001);
      await reconciling.promise;
      abort.abort(); reconcile.resolve();
      await flushPump();
      expect(h.executed).toEqual(["slow-database"]);
      expect(h.repos.runtime.getJob("not-admitted-after-abort")).toMatchObject({ status: "queued", attempts: 0, leaseToken: null });
      expect(h.repos.runtime.getJob("slow-database")!.status).toBe("leased");
    } finally { abort.abort(); reconcile.resolve(); slow.resolve(); await run; }
    expectNoPermits(h);
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

});
