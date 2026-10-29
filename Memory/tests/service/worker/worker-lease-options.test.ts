import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { WorkerRunner, type WorkerRunnerDeps } from "../../../src/service/worker/worker-runner.js";
import { resolveWorkerLeaseOptions, type WorkerLeaseOptions } from "../../../src/service/worker/worker-lease-options.js";
import { createCapturingEmbedder } from "../../fixtures/memory-service-fixture.js";

const resources: Array<{ db: MemoryDb; root: string; runner: WorkerRunner }> = [];
afterEach(async () => {
  for (const { db, root, runner } of resources.splice(0)) {
    await runner.stop(); db.close(); rmSync(root, { recursive: true, force: true });
  }
  vi.useRealTimers(); vi.unstubAllEnvs();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function harness(leases: WorkerLeaseOptions, processJob: WorkerRunnerDeps["jobHandlers"]["processJob"], algorithm: "legacy" | "wrr" = "wrr") {
  const root = mkdtempSync("/private/tmp/memmy-lease-options-"), db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const repos = new Repositories(db.db), bad = () => { throw new Error("Unexpected dependency"); };
  const deps: WorkerRunnerDeps = { repos, leases, scheduling: { algorithm },
    embedder: createCapturingEmbedder([]), capture: { embedAfterCapture: true }, embeddingRetryWorkerId: "lease-options",
    memoryAddEnabled: () => true, memoryBudgetPaused: () => false, memoryBudgetJobConsumes: () => false,
    memoryBudgetModelSources: () => ({ embedding: { mode: "local" } }), memoryBudgetNextWakeAtMs: () => Date.now(),
    summaryModelConfigured: () => true, nowIso: () => new Date().toISOString(), encodeChangeCursor: String,
    namespaceIdFromMemory: () => "test", runWorkerNoWrite: async () => bad(), restartFailedProcessing: () => 0,
    previewPolicyEvidenceReconciliation: () => ({ orphanPolicyIds: [], affectedWorldModelIds: [], affectedSkillIds: [], restorablePolicyIds: [] }),
    reconcileOrphanedPolicies: () => 0, enqueueJob: bad, enqueueEmbeddingRetry: bad, appendJobChange: () => {},
    appendEmbeddingRetryChange: () => {}, jobHandlers: { processJob }, embeddingJobs: {
      prepareEmbeddingJob: bad, applyEmbeddingVector: () => {}, enqueueEmbeddingRetryAfterFailure: () => false,
      persistEmbeddingVector: input => { const memory = repos.memories.get(input.memoryId)!; input.finalize?.(memory, false, new Date().toISOString()); return memory; }
    }
  };
  const runner = new WorkerRunner(deps); resources.push({ db, root, runner });
  return { db, repos, deps, runner, job(type: "trace_summary" | "reflection") {
    const at = new Date().toISOString();
    repos.runtime.enqueueJob({ id: "job", jobType: type, status: "queued", userId: "test", payload: {}, attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at });
  } };
}
async function flushUntil(check: () => boolean) {
  for (let turn = 0; turn < 30 && !check(); turn++) await new Promise<void>(resolve => setImmediate(resolve));
  expect(check()).toBe(true);
}

describe("resource-specific worker lease settings", () => {
  it("retains defaults and resolves dependency overrides field by field", () => {
    const options = resolveWorkerLeaseOptions({ resources: { summary: { durationSec: 90 } } }, {
      MEMMY_WORKER_LEASE_OPTIONS: JSON.stringify({ resources: { summary: { durationSec: 120, heartbeatMs: 25_000 } }, embeddingRetry: { durationSec: 400 } })
    });
    expect(options.resources.summary).toEqual({ durationSec: 90, heartbeatMs: 25_000 });
    expect(options.resources.database).toEqual({ durationSec: 60, heartbeatMs: 20_000 });
    expect(options.embeddingRetry).toEqual({ durationSec: 400, heartbeatMs: 20_000 });
  });
  it.each(["null", "[]", "true", "{", '{"resources":{"typo":{}}}', '{"embeddingRetry":{"durationSec":0}}',
    '{"resources":{"summary":{"durationSec":10,"heartbeatMs":6000}}}'])
  ("rejects unsafe environment settings before claiming: %s", value => {
    expect(() => resolveWorkerLeaseOptions({}, { MEMMY_WORKER_LEASE_OPTIONS: value })).toThrow();
  });
  it.each(["wrr", "legacy"] as const)("uses custom resource duration and heartbeat in %s mode", async algorithm => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(Date.parse("2026-10-23T00:00:00Z"));
    const gate = deferred(), h = harness({ resources: { summary: { durationSec: 6, heartbeatMs: 2000 } } }, () => gate.promise, algorithm);
    h.job("trace_summary"); const run = h.runner.runWorkerOnce(1);
    try {
      await flushUntil(() => h.repos.runtime.getJob("job")?.status === "leased");
      const before = h.repos.runtime.getJob("job")!;
      expect(Date.parse(before.leasedUntil!) - Date.now()).toBe(6000);
      await vi.advanceTimersByTimeAsync(2000);
      const after = h.repos.runtime.getJob("job")!;
      expect(after.leaseToken).toBe(before.leaseToken);
      expect(Date.parse(after.leasedUntil!) - Date.now()).toBe(6000);
    } finally { gate.resolve(); }
    expect(await run).toMatchObject({ leased: 1, succeeded: 1, failed: 0 });
  });
  it("uses the evolution resource policy independently of summary", async () => {
    const h = harness({ resources: { evolution_llm: { durationSec: 12, heartbeatMs: 4000 } } }, async job => {
      expect(Date.parse(job.leasedUntil!) - Date.now()).toBeGreaterThan(11_000);
      expect(Date.parse(job.leasedUntil!) - Date.now()).toBeLessThanOrEqual(12_000);
    });
    h.job("reflection"); expect(await h.runner.runWorkerOnce(1)).toMatchObject({ succeeded: 1, failed: 0 });
  });
  it("applies retry duration and heartbeat to the same fenced claim", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(Date.parse("2026-10-23T00:00:00Z"));
    const gate = deferred(), h = harness({ embeddingRetry: { durationSec: 8, heartbeatMs: 2000 } }, async () => {});
    const at = new Date().toISOString();
    h.db.db.prepare("INSERT INTO memories(id,timeline,user_id,memory_value,memory_layer,tags_json,created_at,updated_at) VALUES('target',?,'test','synthetic','L1','[]',?,?)").run(at, at, at);
    h.repos.runtime.enqueueEmbeddingRetry({ id: "retry", targetKind: "trace", targetId: "target", vectorField: "vec_summary", sourceText: "synthetic", now: Date.now() });
    h.deps.embedder.embed = async texts => { await gate.promise; return texts.map(() => [1, 0, 0]); };
    const run = h.runner.runWorkerOnce(1);
    try {
      await flushUntil(() => h.repos.runtime.getEmbeddingRetry("retry")?.status === "in_progress");
      const before = h.repos.runtime.getEmbeddingRetry("retry")!;
      expect(before.leaseUntil! - Date.now()).toBe(8000);
      await vi.advanceTimersByTimeAsync(2000);
      const after = h.repos.runtime.getEmbeddingRetry("retry")!;
      expect(after.leaseToken).toBe(before.leaseToken);
      expect(after.leaseUntil! - Date.now()).toBe(8000);
    } finally { gate.resolve(); }
    expect((await run).embeddingRetries).toMatchObject({ leased: 1, succeeded: 1, failed: 0 });
  });
});
