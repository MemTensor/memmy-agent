import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { WorkerRunner, type WorkerRunnerDeps } from "../../../src/service/worker/worker-runner.js";
import { WorkerConcurrencyController } from "../../../src/service/worker/worker-concurrency.js";
import type { WorkerObservation } from "../../../src/service/worker/worker-observability.js";
import { createCapturingEmbedder } from "../../fixtures/memory-service-fixture.js";

const resources: Array<{ root: string; db: MemoryDb; runner: WorkerRunner }> = [];
function harness() {
  const root = mkdtempSync(join(tmpdir(), "worker-observer-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const repos = new Repositories(db.db), events: WorkerObservation[] = [];
  const concurrency = new WorkerConcurrencyController({}, {});
  const unexpected = () => { throw new Error("Unexpected fixture operation"); };
  const deps: WorkerRunnerDeps = {
    repos, concurrency, observer: { record: event => events.push(event) },
    embedder: createCapturingEmbedder([]), capture: { embedAfterCapture: false }, embeddingRetryWorkerId: "observer",
    memoryAddEnabled: () => true, memoryBudgetPaused: () => false, memoryBudgetJobConsumes: () => false,
    memoryBudgetModelSources: () => ({ embedding: { mode: "local" } }), memoryBudgetNextWakeAtMs: () => Date.now(),
    summaryModelConfigured: () => true, nowIso: () => new Date().toISOString(), encodeChangeCursor: String,
    namespaceIdFromMemory: () => "fixture", runWorkerNoWrite: async () => unexpected(),
    restartFailedProcessing: () => 0, reconcileOrphanedPolicies: () => 0,
    previewPolicyEvidenceReconciliation: () => ({ orphanPolicyIds: [], affectedWorldModelIds: [], affectedSkillIds: [], restorablePolicyIds: [] }),
    enqueueJob: unexpected, enqueueEmbeddingRetry: unexpected, appendJobChange: () => {}, appendEmbeddingRetryChange: () => {},
    schedulingShadow: { enabled: false }, jobHandlers: { processJob: async () => {} },
    embeddingJobs: { prepareEmbeddingJob: unexpected, applyEmbeddingVector: unexpected,
      persistEmbeddingVector: unexpected, enqueueEmbeddingRetryAfterFailure: () => false }
  };
  const runner = new WorkerRunner(deps); resources.push({ root, db, runner });
  function job(id = "private-id") {
    const at = new Date().toISOString();
    return repos.runtime.enqueueJob({ id, jobType: "reflection", userId: "private-user", targetMemoryId: "private-target",
      payload: { body: "private-content" }, status: "queued", attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at });
  }
  return { db, repos, runner, deps, events, concurrency, job };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { root, db, runner } of resources.splice(0)) { await runner.stop(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

describe("real worker lifecycle observations", () => {
  it("reports committed claims, actual starts and successes without body or identity fields", async () => {
    const h = harness(); h.job();
    expect((await h.runner.runWorkerOnce(1)).succeeded).toBe(1);
    expect(h.events.map(event => event.type)).toEqual(["claimed", "started", "finished"]);
    expect(h.events[0]).toMatchObject({ type: "claimed", work: { lane: "evolution", queue: "main", leaseCount: 1, leaseRecoveryCount: 0 } });
    expect(h.events[1]).toMatchObject({ type: "started", work: { firstQueuedAt: expect.any(String) } });
    expect(h.events[2]).toMatchObject({ type: "finished", outcome: "succeeded" });
    const serialized = JSON.stringify(h.events);
    for (const secret of ["private-id", "private-user", "private-target", "private-content"]) expect(serialized).not.toContain(secret);
  });

  it("separates business failure from a fenced old executor", async () => {
    const h = harness(); h.job("failure");
    h.deps.jobHandlers.processJob = async () => { throw new Error("unsupported job type"); };
    expect((await h.runner.runWorkerOnce(1)).failed).toBe(1);
    expect(h.events.filter(event => event.type === "finished")).toMatchObject([{ outcome: "failed" }]);
    h.events.length = 0; h.job("fenced");
    h.deps.jobHandlers.processJob = async job => {
      h.db.db.prepare("UPDATE evolution_jobs SET lease_token='replacement-token' WHERE id=?").run(job.id);
    };
    expect((await h.runner.runWorkerOnce(1)).failed).toBe(0);
    expect(h.events.filter(event => event.type === "finished")).toMatchObject([{ outcome: "fenced" }]);
    expect(h.events.filter(event => event.type === "lease")).toEqual([{ type: "lease", queue: "main", action: "fenced" }]);
    expect(h.repos.runtime.getJob("fenced")).toMatchObject({ status: "leased", leaseToken: "replacement-token" });
  });

  it("records a known scope refusal without guessing a Provider refusal", async () => {
    const h = harness(); h.job();
    const held = h.concurrency.tryAcquire({ resourceClass: "scan", providers: [], scopeKeys: [JSON.stringify(["target", "private-target"])] })!;
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), 10);
    try { expect((await h.runner.runWorkerOnce(1, {}, { signal: controller.signal })).leased).toBe(0); }
    finally { clearTimeout(abort); held.release(); }
    expect(h.events).toContainEqual({ type: "skipped", lane: "evolution", reason: "scope" });
    expect(h.events.some(event => event.type === "claimed")).toBe(false);
    expect(h.events.some(event => event.type === "skipped" && event.reason === "provider")).toBe(false);
    expect(h.repos.runtime.getJob("private-id")).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("does not let a failing metrics sink change a successful durable result", async () => {
    const h = harness(); h.job(); h.deps.observer = { record() { throw new Error("metrics unavailable"); } };
    expect((await h.runner.runWorkerOnce(1)).succeeded).toBe(1);
    expect(h.repos.runtime.getJob("private-id")?.status).toBe("succeeded");
    expect(h.concurrency.availableJobs()).toBe(4);
  });

  it("does not report a claim rolled back by a failed cursor commit", async () => {
    const h = harness(); h.job();
    vi.spyOn(h.repos.runtime, "setKv").mockImplementationOnce(() => { throw new Error("cursor storage failed"); });
    await expect(h.runner.runWorkerOnce(1)).rejects.toThrow("cursor storage failed");
    expect(h.events).toEqual([]);
    expect(h.repos.runtime.getJob("private-id")).toMatchObject({ status: "queued", attempts: 0 });
    expect(h.concurrency.availableJobs()).toBe(4);
  });

  it("reports an expired lease recovery only on its successful replacement claim", async () => {
    const h = harness(); h.job();
    const oldAt = new Date(Date.now() - 120_000).toISOString();
    h.repos.runtime.claimQueuedJob("private-id", { at: oldAt, leaseSeconds: 1 });
    expect((await h.runner.runWorkerOnce(1)).succeeded).toBe(1);
    expect(h.events.filter(event => event.type === "lease")).toEqual([
      { type: "lease", queue: "main", action: "expired", count: 1 },
      { type: "lease", queue: "main", action: "recovered", count: 1 }
    ]);
    expect(h.events.find(event => event.type === "claimed")).toMatchObject({ work: { leaseCount: 2, leaseRecoveryCount: 1 } });
  });

  it("distinguishes a committed claim returned by a budget pause from actual execution", async () => {
    const h = harness(); h.job();
    let paused = false;
    h.deps.memoryBudgetPaused = () => paused;
    h.deps.memoryBudgetJobConsumes = () => true;
    h.deps.prepareExecution = () => { paused = true; return { providers: [], run: operation => operation() }; };
    const result = await h.runner.runWorkerOnce(1);
    expect(result).toMatchObject({ leased: 1, succeeded: 0, failed: 0 });
    expect(h.events.filter(event => event.type === "claimed")).toHaveLength(1);
    expect(h.events.filter(event => event.type === "started")).toHaveLength(0);
    expect(h.events.filter(event => event.type === "finished")).toMatchObject([{ outcome: "released" }]);
    expect(h.events).toContainEqual({ type: "skipped", lane: "evolution", reason: "budget" });
    expect(h.repos.runtime.getJob("private-id")).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("records retry claim/start/failure exactly once when a real retry targets missing data", async () => {
    const h = harness();
    h.repos.runtime.enqueueEmbeddingRetry({ id: "retry-private", targetKind: "trace", targetId: "missing-private",
      vectorField: "vec_summary", sourceText: "secret retry body", now: Date.now() });
    const result = await h.runner.runEmbeddingRetryOnce(1);
    expect(result.failed).toBe(1);
    expect(h.events.filter(event => event.type === "claimed")).toHaveLength(1);
    expect(h.events.filter(event => event.type === "started")).toHaveLength(1);
    expect(h.events.filter(event => event.type === "finished")).toMatchObject([{ outcome: "failed", work: { queue: "embedding_retry", lane: "repair_retry" } }]);
    expect(JSON.stringify(h.events)).not.toContain("secret retry body");
  });
});
