import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories, type EvolutionJobRecord } from "../../../src/storage/repositories.js";
import { WorkerConcurrencyController } from "../../../src/service/worker/worker-concurrency.js";
import { workerWorkRequirements } from "../../../src/service/worker/worker-work-requirements.js";
import { WorkerRunner, type WorkerRunnerDeps } from "../../../src/service/worker/worker-runner.js";
import { createCapturingEmbedder } from "../../fixtures/memory-service-fixture.js";

const resources: Array<{ root: string; db: MemoryDb; runner?: WorkerRunner }> = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function harness(process: (job: EvolutionJobRecord) => Promise<void> = async () => {}) {
  const root = mkdtempSync(join(tmpdir(), "worker-episode-scope-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const resource: typeof resources[number] = { root, db }; resources.push(resource);
  const repos = new Repositories(db.db), concurrency = new WorkerConcurrencyController({}, {});
  const deps: WorkerRunnerDeps = {
    repos, concurrency, scheduling: { algorithm: "wrr" }, schedulingShadow: { enabled: false },
    embedder: createCapturingEmbedder([]), capture: { embedAfterCapture: true }, embeddingRetryWorkerId: "episode-review",
    memoryAddEnabled: () => true, memoryBudgetPaused: () => false, memoryBudgetJobConsumes: () => false,
    memoryBudgetModelSources: () => ({ embedding: { mode: "local" } }), memoryBudgetNextWakeAtMs: () => Date.now(),
    summaryModelConfigured: () => true, nowIso: () => new Date().toISOString(), encodeChangeCursor: String,
    namespaceIdFromMemory: () => "review", runWorkerNoWrite: async () => { throw new Error("unexpected disabled worker"); },
    restartFailedProcessing: () => 0, reconcileOrphanedPolicies: () => 0,
    previewPolicyEvidenceReconciliation: () => ({ orphanPolicyIds: [], affectedWorldModelIds: [], affectedSkillIds: [], restorablePolicyIds: [] }),
    enqueueJob: () => { throw new Error("unexpected startup enqueue"); }, enqueueEmbeddingRetry: () => { throw new Error("unexpected embedding retry"); },
    appendJobChange: () => {}, appendEmbeddingRetryChange: () => {}, jobHandlers: { processJob: process },
    embeddingJobs: { prepareEmbeddingJob: () => { throw new Error("unexpected embedding"); },
      applyEmbeddingVector: () => {}, persistEmbeddingVector: () => { throw new Error("unexpected embedding vector"); }, enqueueEmbeddingRetryAfterFailure: () => false }
  };
  const runner = new WorkerRunner(deps); resource.runner = runner;
  function job(id: string, jobType: "reflection" | "reward", episodeId: string) {
    return repos.runtime.enqueueJob({ id, jobType, userId: "review-user", episodeId,
      ...(jobType === "reflection" ? { targetMemoryId: `trace-${episodeId}` } : {}),
      payload: jobType === "reward" ? { l1MemoryId: `trace-${episodeId}`, polarity: "positive" } : { targetKind: "episode" },
      status: "queued", attempts: 0, maxAttempts: 3, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }
  return { repos, concurrency, runner, job };
}
afterEach(async () => {
  for (const { db, root, runner } of resources.splice(0)) {
    await runner?.stop(); if (db.db.open) db.close(); rmSync(root, { recursive: true, force: true });
  }
});

describe("reflection and reward episode admission", () => {
  it("shares the episode permit for production reflection/reward metadata, retaining target protection", () => {
    const h = harness();
    const reflection = h.job("reflection-A", "reflection", "episode-A");
    const reward = h.job("reward-A", "reward", "episode-A");
    expect(reward.targetMemoryId).toBeUndefined();
    const reflectionRequirements = workerWorkRequirements({ queue: "main", job: reflection }, h.repos);
    const rewardRequirements = workerWorkRequirements({ queue: "main", job: reward }, h.repos);
    expect(reflectionRequirements.scopeKeys).toContain(JSON.stringify(["target", "trace-episode-A"]));
    const first = h.concurrency.tryAcquire(reflectionRequirements)!;
    const conflicting = h.concurrency.tryAcquire(rewardRequirements);
    conflicting?.release(); first.release();
    expect(conflicting).toBeUndefined();
    const next = h.concurrency.tryAcquire(rewardRequirements);
    expect(next).toBeDefined(); next!.release();
  });

  it("does not claim same-episode reward while reflection runs, but runs another episode in parallel", async () => {
    const gate = deferred(), entered = deferred(); const executed: string[] = [];
    const h = harness(async job => {
      executed.push(job.id);
      if (job.id === "reflection-A") { entered.resolve(); await gate.promise; }
    });
    h.job("reflection-A", "reflection", "episode-A"); h.job("reward-A", "reward", "episode-A"); h.job("reward-B", "reward", "episode-B");
    const run = h.runner.runWorkerOnce(3); await entered.promise;
    for (let i = 0; i < 100; i++) await Promise.resolve();
    const heldReward = h.repos.runtime.getJob("reward-A");
    const otherReward = h.repos.runtime.getJob("reward-B");
    const beforeRelease = [...executed];
    gate.resolve(); const result = await run;
    expect(heldReward).toMatchObject({ status: "queued", attempts: 0, leaseToken: null });
    expect(otherReward?.status).toBe("succeeded");
    expect(beforeRelease).toEqual(["reflection-A", "reward-B"]);
    expect(executed).toEqual(["reflection-A", "reward-B", "reward-A"]);
    expect(result).toMatchObject({ leased: 3, succeeded: 3, failed: 0 });
    expect(h.concurrency.snapshot()).toEqual({ activeJobs: 0, availableJobs: 4, backgroundActiveJobs: 0, maxBackgroundJobs: 3, interactiveReservedSlots: 1, resources: {}, providers: {}, scopeKeys: [], embeddingRequests: 0 });
  });
});
