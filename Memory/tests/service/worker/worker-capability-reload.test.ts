import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG } from "../../../src/config/index.js";
import type { LlmClient } from "../../../src/model/types.js";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories, type EvolutionJobRecord } from "../../../src/storage/repositories.js";
import { WorkerConcurrencyController, providerDescriptor } from "../../../src/service/worker/worker-concurrency.js";
import { WorkerRunner, type WorkerRunnerDeps, type WorkerRunSummary } from "../../../src/service/worker/worker-runner.js";
import { addAgentSourceImport, createBatchReflectionLlm, createCapturingEmbedder, createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
const resources: Array<{ db: MemoryDb; root: string; runner: WorkerRunner; controller: WorkerConcurrencyController }> = [];
afterEach(async () => {
  for (const { db, root, runner, controller } of resources.splice(0)) {
    await runner.stop(); await controller.close(); if (db.db.open) db.close(); rmSync(root, { recursive: true, force: true });
  }
  fixture.cleanup();
  vi.restoreAllMocks();
});
function deferred() {
  let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve };
}
function harness(process?: (job: EvolutionJobRecord) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "worker-capability-reload-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") }), repos = new Repositories(db.db);
  const controller = new WorkerConcurrencyController({ maxActiveJobs: 1 }, {}), executed: string[] = [], embedded: string[] = [];
  let enabled = true, reconcileAt: number | undefined;
  const noWrite = (): WorkerRunSummary => ({ leased: 0, succeeded: 0, failed: 0, jobs: [],
    embeddingRetries: { leased: 0, succeeded: 0, failed: 0, items: [] }, changeSeq: 0, syncCursor: "0", serverTime: new Date().toISOString() });
  const deps: WorkerRunnerDeps = { repos, concurrency: controller, scheduling: { algorithm: "wrr" }, schedulingShadow: { enabled: false },
    embedder: createCapturingEmbedder(embedded), capture: { embedAfterCapture: true }, embeddingRetryWorkerId: "capability-review",
    memoryAddEnabled: () => enabled, memoryBudgetPaused: () => false, memoryBudgetJobConsumes: () => false,
    memoryBudgetModelSources: () => ({ embedding: { mode: "local" } }), memoryBudgetNextWakeAtMs: () => Date.now(),
    memoryBudgetNextReconcileAtMs: () => reconcileAt, summaryModelConfigured: () => true,
    nowIso: () => new Date().toISOString(), encodeChangeCursor: String, namespaceIdFromMemory: () => "review",
    runWorkerNoWrite: async () => noWrite(), restartFailedProcessing: () => 0, reconcileOrphanedPolicies: () => 0,
    previewPolicyEvidenceReconciliation: () => ({ orphanPolicyIds: [], affectedWorldModelIds: [], affectedSkillIds: [], restorablePolicyIds: [] }),
    enqueueJob: () => { throw new Error("Unexpected startup enqueue"); }, enqueueEmbeddingRetry: () => { throw new Error("Unexpected retry enqueue"); },
    appendJobChange: () => {}, appendEmbeddingRetryChange: () => {},
    jobHandlers: { processJob: async job => { executed.push(job.id); await process?.(job); } },
    embeddingJobs: { prepareEmbeddingJob: () => { throw new Error("Unexpected embedding job"); }, applyEmbeddingVector: () => {},
      persistEmbeddingVector: input => { const memory = repos.memories.get(input.memoryId)!; input.finalize?.(memory, false, new Date().toISOString()); return memory; },
      enqueueEmbeddingRetryAfterFailure: () => false }
  };
  const runner = new WorkerRunner(deps); resources.push({ db, root, runner, controller });
  function job(id: string) {
    return repos.runtime.enqueueJob({ id, jobType: "l2_association", userId: "review-user", payload: {},
      status: "queued", attempts: 0, maxAttempts: 3, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }
  return { db, repos, runner, deps, controller, executed, embedded, job,
    setEnabled(value: boolean) { enabled = value; }, setReconcile(value: number) { reconcileAt = value; } };
}

describe("worker capability changes during a drain", () => {
  it("wakes an unclaimed automatic run on real reload without releasing the foreground provider", async () => {
    const foregroundEntered = deferred(), finishForeground = deferred(), denied = deferred();
    const calls: Parameters<typeof createBatchReflectionLlm>[0] = [];
    const llm = createBatchReflectionLlm(calls);
    const controller = new WorkerConcurrencyController({ maxActiveJobs: 1 }, {});
    let config = { ...DEFAULT_MEMMY_CONFIG, algorithm: { ...DEFAULT_MEMMY_CONFIG.algorithm,
      capture: { ...DEFAULT_MEMMY_CONFIG.algorithm.capture, embedAfterCapture: false } } };
    const { db, service } = fixture.createTestService({ config, configLoader: () => ({ config }), llm, skillLlm: llm,
      concurrency: controller });
    const repos = new Repositories(db.db), abort = new AbortController();
    addAgentSourceImport(service, { source: "codex", profileId: "review", userId: "review-user" },
      "Remember this provider-blocked setting", "capability-provider-blocked");
    const job = repos.runtime.listJobs("queued", 100).find(row => row.jobType === "import_summary")!;
    const foreground = controller.runRequest(providerDescriptor(llm.config, controller.limits), async () => {
      foregroundEntered.resolve(); await finishForeground.promise;
    });
    await foregroundEntered.promise;
    const acquire = controller.tryAcquire.bind(controller);
    vi.spyOn(controller, "tryAcquire").mockImplementation((...args) => {
      const permit = acquire(...args); if (!permit) denied.resolve(); return permit;
    });
    const run = service.runWorkerOnce(4, {}, { continuous: true, signal: abort.signal });
    let exitedWhileForegroundHeld = false;
    let waiting: EvolutionJobRecord | undefined;
    let result: WorkerRunSummary | undefined;
    try {
      await denied.promise;
      expect(controller.snapshot().activeJobs).toBe(0);
      expect(Object.values(controller.snapshot().providers)).toContain(1);
      config = { ...config, algorithm: { ...config.algorithm, enableMemoryAdd: false } };
      service.reloadConfig({ restartFailedProcessing: false });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        exitedWhileForegroundHeld = await Promise.race([
          run.then(value => { result = value; return true; }),
          new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 100); })
        ]);
      } finally { if (timeout !== undefined) clearTimeout(timeout); }
      waiting = repos.runtime.getJob(job.id);
      expect(controller.snapshot().activeJobs).toBe(0);
      expect(Object.values(controller.snapshot().providers)).toContain(1);
    } finally {
      abort.abort(); finishForeground.resolve(); await foreground; await run; await service.stop();
    }
    expect(exitedWhileForegroundHeld).toBe(true);
    expect(result).toMatchObject({ leased: 0, succeeded: 0, failed: 0 });
    expect(waiting).toMatchObject({ status: "queued", attempts: 0, leaseCount: 0, leaseToken: null });
    expect(calls).toEqual([]);
  });

  it("uses real config reload to finish only the admitted summary and resumes untouched jobs on a new run", async () => {
    const entered = deferred(), finish = deferred(); let first = true;
    const calls: Parameters<typeof createBatchReflectionLlm>[0] = [];
    const llm = createBatchReflectionLlm(calls), originalCompleteJson = llm.completeJson;
    llm.completeJson = async <T extends Record<string, unknown>>(...args: Parameters<LlmClient["completeJson"]>): Promise<T> => {
      if (first) { first = false; entered.resolve(); await finish.promise; }
      return originalCompleteJson<T>(...args);
    };
    let config = { ...DEFAULT_MEMMY_CONFIG, algorithm: { ...DEFAULT_MEMMY_CONFIG.algorithm,
      capture: { ...DEFAULT_MEMMY_CONFIG.algorithm.capture, embedAfterCapture: false } } };
    const { db, service } = fixture.createTestService({ config, configLoader: () => ({ config }), llm, skillLlm: llm,
      concurrency: new WorkerConcurrencyController({ maxActiveJobs: 1 }, {}) });
    const repos = new Repositories(db.db);
    for (let index = 0; index < 8; index++) addAgentSourceImport(service,
      { source: "codex", profileId: "review", userId: "review-user" }, `Remember build setting ${index}`, `capability-${index}`);
    const jobs = repos.runtime.listJobs("queued", 100).filter(job => job.jobType === "import_summary");
    expect(jobs).toHaveLength(8);
    const run = service.runWorkerOnce(4, {}, { continuous: true }); await entered.promise;
    config = { ...config, algorithm: { ...config.algorithm, enableMemoryAdd: false } };
    service.reloadConfig({ restartFailedProcessing: false }); finish.resolve();
    try {
      const stopped = await run;
      expect(stopped).toMatchObject({ leased: 1, succeeded: 1, failed: 0 });
      const waiting = jobs.map(job => repos.runtime.getJob(job.id)!).filter(job => job.status === "queued");
      expect(waiting).toHaveLength(7);
      waiting.forEach(job => expect(job).toMatchObject({ attempts: 0, leaseToken: null, leaseCount: 0 }));
      expect(calls.filter(call => call.options.operation === "capture.summarize")).toHaveLength(1);
      config = { ...config, algorithm: { ...config.algorithm, enableMemoryAdd: true } };
      service.reloadConfig({ restartFailedProcessing: false });
      const resumed = await service.runWorkerOnce(100);
      expect(resumed).toMatchObject({ leased: 7, succeeded: 7, failed: 0 });
      expect(jobs.every(job => repos.runtime.getJob(job.id)?.status === "succeeded")).toBe(true);
    } finally { finish.resolve(); await service.stop(); }
  });

  it("rechecks the capability after awaiting reconciliation inside a continuous run", async () => {
    const entered = deferred(), finish = deferred();
    const h = harness(async job => { if (job.id === "first") h.setReconcile(Date.now() - 1); });
    let beforeCalls = 0;
    h.deps.beforeRun = async () => { if (++beforeCalls === 2) { entered.resolve(); await finish.promise; } };
    h.job("first"); h.job("second");
    const run = h.runner.runWorkerOnce(4, {}, { continuous: true }); await entered.promise;
    h.setEnabled(false); finish.resolve(); const stopped = await run;
    expect(stopped).toMatchObject({ leased: 1, succeeded: 1, failed: 0 });
    expect(h.executed).toEqual(["first"]);
    expect(h.repos.runtime.getJob("second")).toMatchObject({ status: "queued", attempts: 0, leaseToken: null });
  });

  it("honors a timer-driven disable while short tasks yield to the event loop", async () => {
    const h = harness(), count = 128;
    for (let index = 0; index < count; index++) h.job(`short-${index}`);
    const changed = new Promise<void>(resolve => setTimeout(() => { h.setEnabled(false); resolve(); }, 0));
    const stopped = await h.runner.runWorkerOnce(4, {}, { continuous: true }); await changed;
    expect(h.executed.length).toBeGreaterThan(0);
    expect(h.executed.length).toBeLessThan(count);
    expect(stopped.leased).toBe(h.executed.length);
    const waiting = h.repos.runtime.listJobs("queued", count);
    expect(waiting).toHaveLength(count - h.executed.length);
    waiting.forEach(job => expect(job).toMatchObject({ attempts: 0, leaseToken: null, leaseCount: 0 }));
  });

  it("keeps retry-only work pending while disabled and processes it after re-enabling", async () => {
    const h = harness(), at = new Date().toISOString();
    h.db.db.prepare(`INSERT INTO memories(id,timeline,user_id,memory_value,memory_layer,created_at,updated_at)
      VALUES ('retry-target',?,'review-user','synthetic','L1',?,?)`).run(at, at, at);
    h.repos.runtime.enqueueEmbeddingRetry({ id: "retry", targetKind: "trace", targetId: "retry-target",
      vectorField: "vec_summary", sourceText: "synthetic", now: Date.now() });
    h.setEnabled(false);
    const disabled = await h.runner.runEmbeddingRetryOnce(1);
    expect(disabled.leased).toBe(0);
    expect(h.embedded).toEqual([]);
    expect(h.repos.runtime.getEmbeddingRetry("retry")).toMatchObject({ status: "pending", attempts: 0, leaseToken: null, claimedBy: null });
    h.setEnabled(true);
    const resumed = await h.runner.runEmbeddingRetryOnce(1);
    expect(resumed).toMatchObject({ leased: 1, succeeded: 1, failed: 0 });
    expect(h.embedded).toEqual(["synthetic"]);
  });
});
