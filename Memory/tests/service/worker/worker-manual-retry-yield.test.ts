import { afterEach, describe, expect, it } from "vitest";
import { Repositories } from "../../../src/storage/repositories.js";
import { WorkerConcurrencyController } from "../../../src/service/worker/worker-concurrency.js";
import { WorkerRunner, type WorkerRunnerDeps } from "../../../src/service/worker/worker-runner.js";
import { createMemoryServiceFixture, createCapturingEmbedder } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(fixture.cleanup);
function deferred() {
  let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve };
}

describe("manual retry yields a waiting continuous drain", () => {
  it("wakes an idle automatic drain without waiting for an unrelated foreground provider request", async () => {
    const { db } = fixture.createTestService();
    const repos = new Repositories(db.db), controller = new WorkerConcurrencyController({}, {});
    const foregroundGate = deferred(), denied = deferred(), abort = new AbortController();
    const providers = [{ key: "review-provider", limit: 1 }];
    const foreground = controller.runRequest({ providers, local: false }, () => foregroundGate.promise);
    const deps: WorkerRunnerDeps = { repos, concurrency: controller,
      prepareExecution: () => { denied.resolve(); return { providers, run: operation => operation() }; },
      scheduling: { algorithm: "wrr" }, schedulingShadow: { enabled: false }, embedder: createCapturingEmbedder([]),
      capture: { embedAfterCapture: true }, embeddingRetryWorkerId: "manual-retry-review",
      memoryAddEnabled: () => true, memoryBudgetPaused: () => false, memoryBudgetJobConsumes: () => false,
      memoryBudgetModelSources: () => ({ embedding: { mode: "local" } }), memoryBudgetNextWakeAtMs: () => Date.now(),
      summaryModelConfigured: () => true, nowIso: () => new Date().toISOString(), encodeChangeCursor: String,
      namespaceIdFromMemory: () => "review", runWorkerNoWrite: async () => { throw new Error("Unexpected disabled worker"); },
      restartFailedProcessing: () => 0, reconcileOrphanedPolicies: () => 0,
      previewPolicyEvidenceReconciliation: () => ({ orphanPolicyIds: [], affectedWorldModelIds: [], affectedSkillIds: [], restorablePolicyIds: [] }),
      enqueueJob: () => { throw new Error("Unexpected startup enqueue"); }, enqueueEmbeddingRetry: () => { throw new Error("Unexpected retry enqueue"); },
      appendJobChange: () => {}, appendEmbeddingRetryChange: () => {}, jobHandlers: { processJob: async () => {} },
      embeddingJobs: { prepareEmbeddingJob: () => { throw new Error("Unexpected embedding job"); }, applyEmbeddingVector: () => {},
        persistEmbeddingVector: () => { throw new Error("Unexpected vector write"); }, enqueueEmbeddingRetryAfterFailure: () => false }
    };
    const runner = new WorkerRunner(deps);
    repos.runtime.enqueueJob({ id: "provider-blocked", jobType: "trace_summary", userId: "review-user", payload: {},
      status: "queued", attempts: 0, maxAttempts: 3, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const automatic = runner.runWorkerOnce(4, {}, { continuous: true, signal: abort.signal });
    await denied.promise;
    let manualFinished = false;
    const manual = runner.runEmbeddingRetryOnce(1).then(result => { manualFinished = true; return result; });
    for (let i = 0; i < 200; i++) await Promise.resolve();
    const beforeForegroundRelease = manualFinished;
    try {
      abort.abort();
      const [, result] = await Promise.all([automatic, manual]);
      expect(beforeForegroundRelease).toBe(true);
      expect(result.leased).toBe(0);
      expect(repos.runtime.getJob("provider-blocked")).toMatchObject({ status: "queued", attempts: 0, leaseToken: null });
    } finally {
      abort.abort(); foregroundGate.resolve(); await foreground; await runner.stop(); await controller.close();
    }
  });
});
