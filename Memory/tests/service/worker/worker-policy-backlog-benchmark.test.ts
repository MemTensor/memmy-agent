import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { WorkerRunner, type WorkerRunnerDeps } from "../../../src/service/worker/worker-runner.js";
import { WorkerConcurrencyController } from "../../../src/service/worker/worker-concurrency.js";
import { createCapturingEmbedder } from "../../fixtures/memory-service-fixture.js";

// Opt-in comparison: fixed work budget, varying backlog, real SQLite and scheduler.
// Handlers deliberately do no model/network work. These are NOT model throughput figures.
it.skipIf(process.env.MEMMY_QUEUE_POLICY_BENCHMARK !== "1")("benchmarks 1,000 completions against classified backlogs", async () => {
  for (const backlog of [1_000, 10_000, 50_000]) {
    const root = mkdtempSync(join(tmpdir(), "memmy-policy-benchmark-"));
    const db = new MemoryDb({ path: join(root, "memory.sqlite") });
    const repos = new Repositories(db.db);
    const concurrency = new WorkerConcurrencyController({ maxActiveJobs: 4 }, {});
    const processed: string[] = [];
    const unexpected = () => { throw new Error("Unexpected model or startup operation"); };
    const deps: WorkerRunnerDeps = {
      repos, concurrency, scheduling: { algorithm: "wrr", aging: { enabled: false } }, schedulingShadow: { enabled: false },
      embedder: createCapturingEmbedder([]), capture: { embedAfterCapture: false }, embeddingRetryWorkerId: "benchmark",
      memoryAddEnabled: () => true, memoryBudgetPaused: () => false, memoryBudgetJobConsumes: () => false,
      memoryBudgetModelSources: () => ({ embedding: { mode: "local" } }), memoryBudgetNextWakeAtMs: () => Date.now(),
      summaryModelConfigured: () => true, nowIso: () => new Date().toISOString(), encodeChangeCursor: String,
      namespaceIdFromMemory: () => "benchmark", runWorkerNoWrite: async () => unexpected(),
      restartFailedProcessing: () => 0, reconcileOrphanedPolicies: () => 0,
      previewPolicyEvidenceReconciliation: () => ({ orphanPolicyIds: [], affectedWorldModelIds: [], affectedSkillIds: [], restorablePolicyIds: [] }),
      enqueueJob: unexpected, enqueueEmbeddingRetry: unexpected, appendJobChange: () => {}, appendEmbeddingRetryChange: () => {},
      jobHandlers: { processJob: async job => { processed.push(job.id); } },
      embeddingJobs: { prepareEmbeddingJob: unexpected, applyEmbeddingVector: unexpected,
        persistEmbeddingVector: unexpected, enqueueEmbeddingRetryAfterFailure: () => false }
    };
    const runner = new WorkerRunner(deps);
    const delay = monitorEventLoopDelay({ resolution: 10 });
    let policyMs = 0, policyCalls = 0;
    const original = repos.runtime.scheduling.refreshActivePolicies.bind(repos.runtime.scheduling);
    const spy = vi.spyOn(repos.runtime.scheduling, "refreshActivePolicies").mockImplementation(input => {
      const start = performance.now();
      try { return original(input); } finally { policyMs += performance.now() - start; policyCalls++; }
    });
    try {
      const at = new Date().toISOString();
      const insert = db.db.prepare(`INSERT INTO evolution_jobs(id,job_type,status,user_id,payload_json,created_at,updated_at)
        VALUES (?,'l2_association','queued','benchmark','{}',?,?)`);
      repos.transaction(() => {
        for (let i = 0; i < backlog; i++) insert.run(`job-${i}`, at, at);
        while (repos.runtime.scheduling.refreshPolicies(500).refreshed > 0) { /* setup excluded from timing */ }
      });
      expect(repos.runtime.scheduling.pendingPolicyCount()).toBe(0);
      delay.enable();
      const start = performance.now();
      const result = await runner.runWorkerOnce(1_000);
      const elapsedMs = performance.now() - start;
      delay.disable();
      expect(result.jobs).toHaveLength(1_000);
      expect(processed).toEqual(Array.from({ length: 1_000 }, (_, i) => `job-${i}`));
      expect(result.jobs.every(job => job.status === "succeeded")).toBe(true);
      const sample = JSON.stringify({ backlog, completed: processed.length,
        elapsedMs: Math.round(elapsedMs), policyCalls, policyMs: Math.round(policyMs),
        eventLoopP99Ms: Math.round(delay.percentile(99) / 1e6) });
      if (process.env.MEMMY_QUEUE_POLICY_BENCHMARK_OUTPUT) appendFileSync(process.env.MEMMY_QUEUE_POLICY_BENCHMARK_OUTPUT, `${sample}\n`);
      console.log("POLICY_BENCHMARK", sample);
    } finally {
      delay.disable(); spy.mockRestore(); await runner.stop(); await concurrency.close(); db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 120_000);
