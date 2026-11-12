import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories, type EvolutionJobRecord } from "../../../src/storage/repositories.js";
import { WorkerRunner, type WorkerRunnerDeps } from "../../../src/service/worker/worker-runner.js";
import { WorkerConcurrencyController } from "../../../src/service/worker/worker-concurrency.js";
import { createCapturingEmbedder } from "../../fixtures/memory-service-fixture.js";
import type { WorkerObservation } from "../../../src/service/worker/worker-observability.js";

const resources: Array<{ root: string; db: MemoryDb; runner: WorkerRunner }> = [];
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function harness(process: WorkerRunnerDeps["jobHandlers"]["processJob"], cap = 1, algorithm: "wrr" | "legacy" = "wrr") {
  const root = mkdtempSync("/private/tmp/worker-interactive-"), db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const repos = new Repositories(db.db), concurrency = new WorkerConcurrencyController({}, {});
  const events: WorkerObservation[] = [];
  const unexpected = () => { throw new Error("Unexpected fixture dependency"); };
  const deps: WorkerRunnerDeps = {
    repos, concurrency, observer: { record: event => events.push(event) },
    scheduling: { algorithm, aging: { enabled: false } }, schedulingShadow: { enabled: false },
    embedder: createCapturingEmbedder([]), capture: { embedAfterCapture: false }, embeddingRetryWorkerId: "interactive",
    memoryAddEnabled: () => true, memoryBudgetPaused: () => false, memoryBudgetJobConsumes: () => false,
    memoryBudgetModelSources: () => ({ embedding: { mode: "local" } }), memoryBudgetNextWakeAtMs: () => Date.now(),
    summaryModelConfigured: () => true, nowIso: () => new Date().toISOString(), encodeChangeCursor: String,
    namespaceIdFromMemory: () => "interactive", runWorkerNoWrite: async () => unexpected(),
    restartFailedProcessing: () => 0, reconcileOrphanedPolicies: () => 0,
    previewPolicyEvidenceReconciliation: () => ({ orphanPolicyIds: [], affectedWorldModelIds: [], affectedSkillIds: [], restorablePolicyIds: [] }),
    enqueueJob: unexpected, enqueueEmbeddingRetry: unexpected, appendJobChange: () => {}, appendEmbeddingRetryChange: () => {},
    prepareExecution: work => ({ providers: work.queue === "main" && work.job.jobType === "episode_idle_close" ? [] : [{ key: "shared-model", limit: cap }],
      run: operation => operation() }),
    jobHandlers: { processJob: process }, embeddingJobs: { prepareEmbeddingJob: unexpected, applyEmbeddingVector: unexpected,
      persistEmbeddingVector: unexpected, enqueueEmbeddingRetryAfterFailure: () => false }
  };
  const runner = new WorkerRunner(deps); resources.push({ root, db, runner });
  function job(id: string, jobType: EvolutionJobRecord["jobType"]) {
    const at = new Date().toISOString(); repos.runtime.enqueueJob({ id, jobType, targetMemoryId: id, userId: "fixture", payload: {},
      status: "queued", attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at });
  }
  return { repos, db, runner, concurrency, job, events, deps };
}
afterEach(async () => { vi.restoreAllMocks(); for (const { root, db, runner } of resources.splice(0)) { await runner.stop(); db.close(); rmSync(root, { recursive: true, force: true }); } });

describe("bounded fresh interactive preference", () => {
  it.each(["new", "old-cursor", "old-turns"] as const)("starts new interactive work at the next free shared model slot from %s state", async state => {
    const entered = gate(), release = gate(), abort = new AbortController(), calls: string[] = [];
    const h = harness(async job => {
      calls.push(job.id);
      if (job.id === "import-0") { entered.resolve(); await release.promise; }
      if (calls.length >= 3) abort.abort();
    });
    h.job("import-0", "import_summary"); h.job("import-1", "import_summary");
    h.job("reflection-0", "reflection"); h.job("reflection-1", "reflection");
    if (state !== "new") h.repos.runtime.setKv("worker.scheduler.wrr_cursor.v1", { weightsKey: "4/3/2/2/1", cursor: 7,
      ...(state === "old-turns" ? { turns: { version: 1, lanes: [
        { lane: "import", remaining: 2 }, { lane: "evolution", remaining: 2 }, { lane: "maintenance", remaining: 1 },
        { lane: "interactive", remaining: 4 }, { lane: "repair_retry", remaining: 3 }
      ] } } : {}) }, new Date().toISOString());
    const run = h.runner.runWorkerOnce(4, {}, { continuous: true, signal: abort.signal });
    await entered.promise;
    h.job("native", "trace_summary"); h.runner.notifyWorkAvailable(); release.resolve();
    await run;
    expect(calls.slice(0, 2)).toEqual(["import-0", "native"]);
    expect(h.events.filter(event => event.type === "claimed").slice(0, 2)).toMatchObject([
      { work: { lane: "import", selectionReason: "wrr" } },
      { work: { lane: "interactive", selectionReason: "interactive" } }
    ]);
    expect(h.concurrency.availableJobs()).toBe(4);
  });

  it.each([1, 2])("continues all model lanes and maintenance under sustained interactive input with shared cap %s", async cap => {
    const abort = new AbortController(), model: string[] = [];
    const types = ["trace_summary", "decision_repair", "import_summary", "reflection", "episode_idle_close"] as const;
    let seq = 0, active = 0, peak = 0, maintained = 0;
    const h = harness(async job => {
      if (job.jobType === "episode_idle_close") maintained++;
      else {
        peak = Math.max(peak, ++active);
        try { await new Promise<void>(resolve => setTimeout(resolve, 2)); model.push(job.jobType); }
        finally { active--; }
        if (model.length >= 90) abort.abort();
      }
      if (!abort.signal.aborted && job.jobType !== "episode_idle_close") {
        h.job(`new-${seq++}`, job.jobType);
        // Keep maintenance arriving throughout every model wave, without
        // turning this concurrency test into an unbounded zero-time DB load.
        h.job(`maintenance-${seq++}`, "episode_idle_close");
      }
    }, cap);
    for (const type of types) for (let i = 0; i < (type === "episode_idle_close" ? 1 : 8); i++) h.job(`${type}-${i}`, type);
    const emergency = setTimeout(() => abort.abort(), 5000);
    try { await h.runner.runWorkerOnce(4, {}, { continuous: true, signal: abort.signal }); }
    finally { clearTimeout(emergency); abort.abort(); }
    expect(model.length).toBeGreaterThanOrEqual(90); expect(peak).toBe(cap); expect(maintained).toBeGreaterThan(0);
    for (let offset = 0; offset < 90; offset += 30) for (const type of types.slice(0, 4)) expect(model.slice(offset, offset + 30)).toContain(type);
    expect(h.concurrency.snapshot()).toMatchObject({ activeJobs: 0, providers: {}, scopeKeys: [] });
  });

  it("retains the fourth ticket on rollback, then persists exhaustion across notifications and a new runner", async () => {
    const calls: string[] = [], h = harness(async job => { calls.push(job.id); });
    for (let i = 0; i < 8; i++) h.job(`interactive-${i}`, "trace_summary");
    h.job("repair", "decision_repair"); h.job("import", "import_summary"); h.job("evolution", "reflection"); h.job("maintenance", "episode_idle_close");
    for (let i = 0; i < 3; i++) await h.runner.runWorkerOnce(1);
    vi.spyOn(h.repos.runtime, "setKv").mockImplementationOnce(() => { throw new Error("quota commit failed"); });
    await expect(h.runner.runWorkerOnce(1)).rejects.toThrow("quota commit failed");
    expect(h.repos.runtime.getJob("interactive-3")).toMatchObject({ status: "queued", attempts: 0 });
    expect(h.repos.runtime.getKv("worker.scheduler.wrr_cursor.v1")?.value).toMatchObject({
      turns: { interactive: { spent: false }, lanes: expect.arrayContaining([{ lane: "interactive", remaining: 1 }]) }
    });
    await h.runner.runWorkerOnce(1);
    expect(h.repos.runtime.getKv("worker.scheduler.wrr_cursor.v1")?.value).toMatchObject({ turns: { interactive: { spent: true } } });
    for (let i = 0; i < 20; i++) h.runner.notifyWorkAvailable();
    await h.runner.stop();
    const restarted = new WorkerRunner(h.deps);
    try { await restarted.runWorkerOnce(1); }
    finally { await restarted.stop(); }
    expect(calls).toEqual(["interactive-0", "interactive-1", "interactive-2", "interactive-3", "repair"]);
    expect(h.repos.runtime.getJob("interactive-4")).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("persists the one-ticket upgrade advance only after a committed lease and does not restore it on restart", async () => {
    const calls: string[] = [], h = harness(async job => { calls.push(job.id); });
    h.job("native-0", "trace_summary"); h.job("native-1", "trace_summary"); h.job("import", "import_summary"); h.job("evolution", "reflection");
    const previous = { weightsKey: "4/3/2/2/1", cursor: 7 };
    h.repos.runtime.setKv("worker.scheduler.wrr_cursor.v1", previous, new Date().toISOString());
    vi.spyOn(h.repos.runtime, "setKv").mockImplementationOnce(() => { throw new Error("upgrade commit failed"); });
    await expect(h.runner.runWorkerOnce(1)).rejects.toThrow("upgrade commit failed");
    expect(h.repos.runtime.getKv("worker.scheduler.wrr_cursor.v1")?.value).toEqual(previous);
    expect(h.repos.runtime.getJob("native-0")).toMatchObject({ status: "queued", attempts: 0 });
    await h.runner.runWorkerOnce(1);
    expect(h.repos.runtime.getKv("worker.scheduler.wrr_cursor.v1")?.value).toMatchObject({ turns: {
      interactive: { spent: true, upgradeAdvance: false }, lanes: expect.arrayContaining([{ lane: "interactive", remaining: 3 }])
    } });
    await h.runner.stop(); const restarted = new WorkerRunner(h.deps);
    try { await restarted.runWorkerOnce(1); } finally { await restarted.stop(); }
    expect(calls).toEqual(["native-0", "import"]);
    expect(h.repos.runtime.getJob("native-1")).toMatchObject({ status: "queued", attempts: 0 });
  });
});
