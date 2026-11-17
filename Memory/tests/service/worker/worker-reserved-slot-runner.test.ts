import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories, type EvolutionJobRecord } from "../../../src/storage/repositories.js";
import { WorkerConcurrencyController } from "../../../src/service/worker/worker-concurrency.js";
import { WorkerRunner, type WorkerRunnerDeps } from "../../../src/service/worker/worker-runner.js";
import { workerWorkRequirements } from "../../../src/service/worker/worker-work-requirements.js";
import { createCapturingEmbedder } from "../../fixtures/memory-service-fixture.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(condition: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Worker did not reach the expected admission state");
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}
const resources: Array<{ root: string; db: MemoryDb; runner: WorkerRunner }> = [];
function harness(process: WorkerRunnerDeps["jobHandlers"]["processJob"] = async () => {}) {
  const root = mkdtempSync(join(tmpdir(), "memmy-reserved-slot-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const repos = new Repositories(db.db), concurrency = new WorkerConcurrencyController({}, {});
  const unexpected = () => { throw new Error("Unexpected fixture dependency"); };
  const deps: WorkerRunnerDeps = {
    repos, concurrency, scheduling: { algorithm: "wrr", aging: { enabled: false } },
    schedulingShadow: { enabled: false }, embedder: createCapturingEmbedder([]),
    capture: { embedAfterCapture: true }, embeddingRetryWorkerId: "reserved-slot",
    memoryAddEnabled: () => true, memoryBudgetPaused: () => false, memoryBudgetJobConsumes: () => false,
    memoryBudgetModelSources: () => ({ embedding: { mode: "local" } }),
    memoryBudgetNextWakeAtMs: () => Date.now(), summaryModelConfigured: () => true,
    nowIso: () => new Date().toISOString(), encodeChangeCursor: String,
    namespaceIdFromMemory: () => "reserved-slot", runWorkerNoWrite: async () => unexpected(),
    restartFailedProcessing: () => 0, reconcileOrphanedPolicies: () => 0,
    previewPolicyEvidenceReconciliation: () => ({ orphanPolicyIds: [], affectedWorldModelIds: [], affectedSkillIds: [], restorablePolicyIds: [] }),
    enqueueJob: unexpected, enqueueEmbeddingRetry: unexpected,
    appendJobChange: () => {}, appendEmbeddingRetryChange: () => {},
    prepareExecution: work => ({ providers: [], embedding: work.queue === "main" && work.job.jobType === "embedding",
      run: operation => operation() }),
    jobHandlers: { processJob: process },
    embeddingJobs: { prepareEmbeddingJob: unexpected, applyEmbeddingVector: unexpected,
      persistEmbeddingVector: unexpected, enqueueEmbeddingRetryAfterFailure: () => false }
  };
  const runner = new WorkerRunner(deps);
  resources.push({ root, db, runner });
  function memory(id: string, tags: string[] = [], agentId?: string) {
    const at = new Date().toISOString();
    db.db.prepare(`INSERT INTO memories(id,timeline,user_id,memory_value,memory_layer,tags_json,agent_id,created_at,updated_at)
      VALUES (?,?,'fixture','synthetic','L1',?,?,?,?)`).run(id, at, JSON.stringify(tags), agentId ?? null, at, at);
  }
  function job(id: string, jobType: EvolutionJobRecord["jobType"], targetMemoryId?: string, payload: Record<string, unknown> = {}) {
    const at = new Date().toISOString();
    return repos.runtime.enqueueJob({ id, jobType, targetMemoryId, userId: "fixture", payload,
      status: "queued", attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at });
  }
  return { db, repos, concurrency, deps, runner, memory, job };
}
afterEach(async () => {
  for (const { root, db, runner } of resources.splice(0)) {
    await runner.stop(); db.close(); rmSync(root, { recursive: true, force: true });
  }
});

describe("reserved interactive slot through real SQLite worker claims", () => {
  it.each(["native", "onboarding"] as const)("starts %s while three background jobs remain active, without leasing blocked background rows", async kind => {
    const background = gate(), interactive = gate(), abort = new AbortController();
    const entered: string[] = [];
    const h = harness(async job => {
      entered.push(job.id);
      await (job.id === "fresh" ? interactive.promise : background.promise);
    });
    h.job("import-0", "import_summary"); h.job("import-1", "import_summary"); h.job("reflection", "reflection");
    // More than one admission scan page; every row must retain its FIFO lease state.
    for (let i = 0; i < 70; i++) {
      h.memory(`history-${i}`, ["agent-source"]);
      h.job(`history-${i}`, "trace_summary", `history-${i}`, { queueLane: "interactive" });
    }
    h.job("startup", "import_summary", undefined, { source: "startup.placeholder_summary_repair", queueLane: "interactive" });
    const run = h.runner.runWorkerOnce(100, {}, { continuous: true, signal: abort.signal });
    try {
      await until(() => entered.length >= 3);
      // Give the pump a complete extra event-loop turn to try a fourth background row.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(entered).toHaveLength(3);
      expect(h.concurrency.snapshot()).toMatchObject({ activeJobs: 3, backgroundActiveJobs: 3, availableJobs: 1 });
      h.memory("fresh", [], kind === "onboarding" ? "memmy-onboarding" : undefined);
      h.job("fresh", kind === "onboarding" ? "import_summary" : "trace_summary", "fresh",
        kind === "onboarding" ? { source: "startup.placeholder_summary_repair" } : {});
      h.runner.notifyWorkAvailable();
      await until(() => entered.includes("fresh"));
      expect(entered).toHaveLength(4);
      expect(h.concurrency.snapshot()).toMatchObject({ activeJobs: 4, backgroundActiveJobs: 3 });
      expect(h.repos.runtime.getJob("fresh")).toMatchObject({ status: "leased", queueLane: "interactive", attempts: 1 });
      for (let i = 0; i < 70; i++) {
        const row = h.repos.runtime.getJob(`history-${i}`)!;
        expect(row.queueLane).toBe("import");
        if (!entered.includes(row.id)) expect(row).toMatchObject({ status: "queued", attempts: 0, leaseToken: null });
      }
      expect(h.repos.runtime.getJob("startup")).toMatchObject({ status: "queued", queueLane: "maintenance", attempts: 0, leaseToken: null });
    } finally {
      abort.abort(); background.resolve(); interactive.resolve(); await run;
    }
    expect(h.concurrency.snapshot()).toMatchObject({ activeJobs: 0, backgroundActiveJobs: 0, providers: {}, scopeKeys: [] });
  });

  it("uses the persisted lane instead of re-inferring privilege from a job type or payload", () => {
    const h = harness();
    h.memory("imported", ["agent-source"]);
    h.memory("report", [], "memmy-onboarding");
    const records = [
      h.job("historical", "trace_summary", "imported", { queueLane: "interactive" }),
      h.job("startup", "import_summary", undefined, { source: "startup.placeholder_summary_repair", queueLane: "interactive" }),
      h.job("report", "import_summary", "report", { source: "startup.placeholder_summary_repair" })
    ];
    expect(records.map(job => workerWorkRequirements({ queue: "main", job }, h.repos).queueLane))
      .toEqual(["import", "maintenance", "interactive"]);
  });

  it("discovers interactive work inserted at a real scan-slice boundary while three background jobs stay active", async () => {
    const background = gate(), interactive = gate(), abort = new AbortController();
    const entered: string[] = [];
    const h = harness(async job => {
      entered.push(job.id);
      await (job.id === "fresh-during-scan" ? interactive.promise : background.promise);
    });
    const backlog = 300;
    for (let i = 0; i < 3; i++) h.job(`active-${i}`, "import_summary");
    for (let i = 0; i < backlog; i++) h.job(`blocked-${i}`, "import_summary");
    let rejected = 0, rejectedAtInsertion = -1, inserted = false;
    let insertionError: unknown;
    const stopObserving = h.concurrency.observe({ record: event => {
      if (event.type !== "admission_rejected" || event.reason !== "background") return;
      rejected++;
      if (rejected !== 1) return;
      // Admission is synchronous inside SQLite's claim transaction. This callback
      // runs only once the current bounded slice has actually yielded to the loop.
      setImmediate(() => {
        try {
          rejectedAtInsertion = rejected;
          h.memory("fresh-during-scan");
          h.job("fresh-during-scan", "trace_summary", "fresh-during-scan");
          h.runner.notifyWorkAvailable();
        } catch (error) { insertionError = error; }
        inserted = true;
      });
    } });
    const run = h.runner.runWorkerOnce(100, {}, { continuous: true, signal: abort.signal });
    try {
      await until(() => inserted);
      expect(insertionError).toBeUndefined();
      expect(rejectedAtInsertion).toBeGreaterThan(0);
      expect(rejectedAtInsertion).toBeLessThanOrEqual(64);
      expect(rejectedAtInsertion).toBeLessThan(backlog);
      await until(() => entered.includes("fresh-during-scan"));
      expect(entered).toEqual(["active-0", "active-1", "active-2", "fresh-during-scan"]);
      expect(rejected).toBeLessThan(backlog);
      expect(h.concurrency.snapshot()).toMatchObject({ activeJobs: 4, backgroundActiveJobs: 3 });
      for (let i = 0; i < backlog; i++) expect(h.repos.runtime.getJob(`blocked-${i}`))
        .toMatchObject({ status: "queued", attempts: 0, leaseToken: null });
    } finally {
      stopObserving(); abort.abort(); background.resolve(); interactive.resolve(); await run;
    }
    expect(h.concurrency.snapshot()).toMatchObject({ activeJobs: 0, backgroundActiveJobs: 0 });
  });

  it("wakes an exhausted background scan for newly enqueued interactive work without claiming a fourth background job", async () => {
    const background = gate(), interactive = gate(), abort = new AbortController();
    const entered: string[] = [];
    const h = harness(async job => {
      entered.push(job.id);
      await (job.id === "fresh-after-wait" ? interactive.promise : background.promise);
    });
    const backlog = 130;
    for (let i = 0; i < 3; i++) h.job(`active-${i}`, "import_summary");
    for (let i = 0; i < backlog; i++) h.job(`blocked-${i}`, "import_summary");
    let rejected = 0;
    const stopObserving = h.concurrency.observe({ record: event => {
      if (event.type === "admission_rejected" && event.reason === "background") rejected++;
    } });
    const run = h.runner.runWorkerOnce(100, {}, { continuous: true, signal: abort.signal });
    try {
      await until(() => rejected === backlog);
      // The last partial slice exhausts the queue. Several turns with no new
      // rejection demonstrate that the pump is waiting rather than polling it.
      for (let turn = 0; turn < 3; turn++) await new Promise<void>(resolve => setImmediate(resolve));
      expect(rejected).toBe(backlog);
      expect(entered).toEqual(["active-0", "active-1", "active-2"]);
      expect(h.concurrency.snapshot()).toMatchObject({ activeJobs: 3, backgroundActiveJobs: 3, availableJobs: 1 });
      h.memory("fresh-after-wait");
      h.job("fresh-after-wait", "trace_summary", "fresh-after-wait");
      h.runner.notifyWorkAvailable();
      await until(() => entered.includes("fresh-after-wait"));
      expect(entered).toEqual(["active-0", "active-1", "active-2", "fresh-after-wait"]);
      expect(h.concurrency.snapshot()).toMatchObject({ activeJobs: 4, backgroundActiveJobs: 3 });
      expect(h.repos.runtime.getJob("fresh-after-wait")).toMatchObject({ status: "leased", attempts: 1 });
      for (let i = 0; i < backlog; i++) expect(h.repos.runtime.getJob(`blocked-${i}`))
        .toMatchObject({ status: "queued", attempts: 0, leaseToken: null });
    } finally {
      stopObserving(); abort.abort(); background.resolve(); interactive.resolve(); await run;
    }
    expect(h.concurrency.snapshot()).toMatchObject({ activeJobs: 0, backgroundActiveJobs: 0 });
  });

  it("limits a shared background embedding batch to three logical members and leaves other rows unleased", async () => {
    const embedding = gate(), abort = new AbortController(), batches: string[][] = [];
    const h = harness();
    h.deps.embeddingJobs.prepareEmbeddingJob = job => ({ job, memory: h.repos.memories.get(job.targetMemoryId!)!,
      text: job.id, role: "document", vectorField: "vec_summary" });
    h.deps.embeddingJobs.applyEmbeddingVector = () => {};
    h.deps.embedder.embed = async texts => {
      batches.push([...texts]); await embedding.promise; return texts.map(() => [1, 0, 0]);
    };
    for (let i = 0; i < 8; i++) {
      h.memory(`embedding-${i}`, ["agent-source"]);
      h.job(`embedding-${i}`, "embedding", `embedding-${i}`);
    }
    const run = h.runner.runWorkerOnce(100, {}, { continuous: true, signal: abort.signal });
    try {
      await until(() => batches.length > 0);
      expect(batches).toHaveLength(1); expect(batches[0]).toHaveLength(3);
      expect(h.concurrency.snapshot()).toMatchObject({ activeJobs: 3, backgroundActiveJobs: 3, embeddingRequests: 1 });
      for (let i = 3; i < 8; i++) expect(h.repos.runtime.getJob(`embedding-${i}`))
        .toMatchObject({ status: "queued", attempts: 0, leaseToken: null });
    } finally { abort.abort(); embedding.resolve(); await run; }
    expect(h.concurrency.snapshot()).toMatchObject({ activeJobs: 0, backgroundActiveJobs: 0, embeddingRequests: 0 });
  });
});
