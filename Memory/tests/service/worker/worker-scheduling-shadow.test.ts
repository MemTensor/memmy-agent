import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jobTypeConsumesMemoryBudget } from "@memmy/agent-source-core";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories, type EvolutionJobRecord } from "../../../src/storage/repositories.js";
import { WorkerRunner, type WorkerRunnerDeps } from "../../../src/service/worker/worker-runner.js";
import { WorkerSchedulingShadow, type WorkerSchedulingComparison } from "../../../src/service/worker/worker-scheduling-shadow.js";
import { createCapturingEmbedder } from "../../fixtures/memory-service-fixture.js";

const at = "2026-10-22T00:00:00.000Z";
const epoch = Date.parse(at);
const resources: Array<{ root: string; db: MemoryDb }> = [];
function harness() {
  const root = mkdtempSync(join(tmpdir(), "memmy-worker-shadow-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  resources.push({ root, db });
  const repos = new Repositories(db.db);
  const executed: string[] = [], comparisons: WorkerSchedulingComparison[] = [];
  const deps: WorkerRunnerDeps = {
    repos, embedder: createCapturingEmbedder([]), capture: { embedAfterCapture: true },
    embeddingRetryWorkerId: "shadow-test", memoryAddEnabled: () => true,
    memoryBudgetPaused: () => false, memoryBudgetJobConsumes: () => false,
    memoryBudgetModelSources: () => ({ embedding: { mode: "local" } }),
    memoryBudgetNextWakeAtMs: () => Date.now(), summaryModelConfigured: () => true,
    schedulingShadow: { enabled: true, onComparison: (value) => { comparisons.push(value); } },
    nowIso: () => new Date().toISOString(), encodeChangeCursor: String,
    namespaceIdFromMemory: () => "synthetic",
    runWorkerNoWrite: async () => { throw new Error("unexpected disabled worker"); },
    restartFailedProcessing: () => 0,
    previewPolicyEvidenceReconciliation: () => ({ orphanPolicyIds: [], affectedWorldModelIds: [], affectedSkillIds: [], restorablePolicyIds: [] }),
    reconcileOrphanedPolicies: () => 0,
    enqueueJob: () => { throw new Error("unexpected startup enqueue"); },
    enqueueEmbeddingRetry: () => { throw new Error("unexpected replacement"); },
    appendJobChange: () => {}, appendEmbeddingRetryChange: () => {},
    jobHandlers: { processJob: async (job) => { executed.push(job.id); } },
    embeddingJobs: {
      prepareEmbeddingJob: () => { throw new Error("unexpected main embedding"); },
      applyEmbeddingVector: () => {}, enqueueEmbeddingRetryAfterFailure: () => false,
      persistEmbeddingVector: (input) => {
        const memory = repos.memories.get(input.memoryId)!;
        input.finalize?.(memory, false, new Date().toISOString());
        return memory;
      }
    }
  };
  const runner = new WorkerRunner(deps);
  const shadow = new WorkerSchedulingShadow(repos.runtime);
  function job(id: string, jobType: EvolutionJobRecord["jobType"] = "reflection", targetMemoryId?: string, payload: Record<string, unknown> = {}) {
    return repos.runtime.enqueueJob({ id, jobType, userId: "user", targetMemoryId,
      payload, status: "queued", attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at });
  }
  function retry(id: string) {
    db.db.prepare(`INSERT INTO memories(id,timeline,user_id,memory_value,memory_layer,created_at,updated_at)
      VALUES (?,?,'user','synthetic','L1',?,?)`).run(id, at, at, at);
    return repos.runtime.enqueueEmbeddingRetry({ id, targetKind: "trace", targetId: id,
      vectorField: "vec_summary", sourceText: "synthetic", now: epoch });
  }
  function state() {
    const metadata = new Set(["queue_lane", "resource_class", "enqueue_seq", "first_queued_at", "base_priority", "policy_version", "policy_promotion"]);
    const rows = (table: string) => (db.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Record<string, unknown>[])
      .map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !metadata.has(key))));
    return { main: rows("evolution_jobs"), retry: rows("embedding_retry_queue"),
      memories: rows("memories"), processing: (db.db.prepare("SELECT * FROM memory_processing_state ORDER BY memory_id").all()),
      changeSeq: repos.runtime.latestChangeSeq() };
  }
  return { db, repos, deps, runner, shadow, job, retry, comparisons, executed, state };
}
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
  for (const { root, db } of resources.splice(0)) {
    if (db.db.open) db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

describe("worker shadow scheduling integration", () => {
  it("previews WRR including retries without mutating task facts or business data", () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(epoch);
    const h = harness();
    for (let i = 0; i < 4; i++) h.job(`import-${i}`, "import_summary");
    h.job("reflection"); h.job("maintenance", "project_environment_profile"); h.retry("retry");
    // Force the same bounded projection refresh used after a schema upgrade.
    h.db.db.exec("UPDATE evolution_jobs SET policy_version = NULL");
    const before = h.state();
    const comparison = h.shadow.sample({ at, limit: 4 })!;
    expect(comparison.legacySelection).toEqual(["main:import-0", "main:import-1", "main:import-2", "main:import-3"]);
    expect(comparison.shadowSelection).toEqual(["embedding_retry:retry", "main:import-0", "main:import-1", "main:reflection"]);
    expect(comparison).toMatchObject({ sameSelection: false, coverageComplete: true, pendingPolicyCount: 0 });
    expect(h.state()).toEqual(before);
  });

  it("executes the legacy selection even when shadow recommends a retry and evolution", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(epoch);
    const h = harness(); h.deps.scheduling = { algorithm: "legacy" };
    for (let i = 0; i < 4; i++) h.job(`import-${i}`, "import_summary");
    h.job("reflection"); h.retry("retry");
    const result = await h.runner.runWorkerOnce(4, { priorityCohortOnly: true });
    expect(result).toMatchObject({ leased: 4, succeeded: 4, failed: 0, embeddingRetries: { leased: 0 } });
    expect(h.executed).toEqual(["import-0", "import-1", "import-2", "import-3"]);
    expect(h.comparisons[0]).toMatchObject({ sameSelection: false });
    expect(h.comparisons[0]!.shadowSelection).toContain("embedding_retry:retry");
    expect(h.repos.runtime.getJob("reflection")!.status).toBe("queued");
    expect(h.repos.runtime.getEmbeddingRetry("retry")!.status).toBe("pending");
  });

  it.each(["preview", "observer"] as const)("isolates %s failures from actual work", async (failure) => {
    const h = harness(); h.job("still-runs");
    if (failure === "preview") vi.spyOn(h.repos.runtime.scheduling, "candidates").mockImplementationOnce(() => { throw new Error("synthetic preview failure"); });
    else h.deps.schedulingShadow!.onComparison = () => { throw new Error("synthetic observer failure"); };
    expect(await h.runner.runWorkerOnce(1)).toMatchObject({ leased: 1, succeeded: 1, failed: 0 });
    expect(h.executed).toEqual(["still-runs"]);
  });

  it.each(["environment", "dependency"] as const)("does not sample when disabled by %s", async (mode) => {
    const h = harness(); h.job("still-runs");
    if (mode === "environment") { h.deps.schedulingShadow = undefined; vi.stubEnv("MEMMY_WORKER_SCHEDULER_SHADOW", "0"); }
    else { h.deps.schedulingShadow!.enabled = false; vi.stubEnv("MEMMY_WORKER_SCHEDULER_SHADOW", "1"); }
    const preview = vi.spyOn(h.repos.runtime.scheduling, "refreshPolicies");
    expect((await h.runner.runWorkerOnce(1)).succeeded).toBe(1);
    expect(preview).not.toHaveBeenCalled(); expect(h.comparisons).toHaveLength(0);
  });

  it("samples no more than once per five seconds and caps comparisons at 32 choices", () => {
    const h = harness();
    for (let i = 0; i < 40; i++) h.job(`reflection-${i.toString().padStart(2, "0")}`);
    const refresh = vi.spyOn(h.repos.runtime.scheduling, "refreshPolicies");
    const first = h.shadow.sample({ at, limit: 100 })!;
    expect(first.sampleLimit).toBe(32); expect(first.shadowSelection).toHaveLength(32); expect(first.legacySelection).toHaveLength(32);
    expect(h.shadow.sample({ at: new Date(epoch + 4_999).toISOString(), limit: 100 })).toBeUndefined();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(h.shadow.sample({ at: new Date(epoch + 5_000).toISOString(), limit: 100 })!.sampleLimit).toBe(32);
    expect(refresh).toHaveBeenCalledTimes(2); expect(refresh).toHaveBeenLastCalledWith(500);
  });

  it("keeps other lanes visible behind ten thousand import candidates", () => {
    const h = harness();
    h.repos.transaction(() => {
      for (let i = 0; i < 10_000; i++) h.job(`import-${i.toString().padStart(5, "0")}`, "import_summary");
      h.job("reflection"); h.job("maintenance", "project_environment_profile"); h.retry("retry");
    });
    const comparison = h.shadow.sample({ at, limit: 8 })!;
    expect(comparison.coverageComplete).toBe(true);
    expect(comparison.legacySelection.every((id) => id.startsWith("main:import-"))).toBe(true);
    expect(comparison.shadowSelection).toEqual(expect.arrayContaining(["main:reflection", "main:maintenance", "embedding_retry:retry"]));
    expect(comparison.candidatePoolSize).toBe(11);
    expect(comparison.shadowSelection).toHaveLength(8);
  });

  it("applies target filters to both preview queues and the legacy execution", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(epoch);
    const h = harness(); h.job("target-job", "import_summary", "target-A"); h.job("other-job", "import_summary", "target-B"); h.retry("target-B");
    expect((await h.runner.runWorkerOnce(4, { targetMemoryIds: ["target-A"] })).leased).toBe(1);
    expect(h.comparisons[0]!.legacySelection).toEqual(["main:target-job"]);
    expect(h.comparisons[0]!.shadowSelection).toEqual(["main:target-job"]);
    expect(h.executed).toEqual(["target-job"]);
    expect(h.repos.runtime.getJob("other-job")!.status).toBe("queued");
    expect(h.repos.runtime.getEmbeddingRetry("target-B")!.status).toBe("pending");
  });

  it("holds summary jobs in both selectors while allowing embedding retries", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(epoch);
    const h = harness(); h.job("held-summary", "import_summary"); h.job("reflection"); h.retry("retry");
    h.deps.summaryModelConfigured = () => false;
    const result = await h.runner.runWorkerOnce(4);
    expect(result).toMatchObject({ leased: 1, succeeded: 1, embeddingRetries: { leased: 1, succeeded: 1 } });
    expect(h.comparisons[0]!.legacySelection).toEqual(["main:reflection", "embedding_retry:retry"]);
    expect(h.comparisons[0]!.shadowSelection).toEqual(["embedding_retry:retry", "main:reflection"]);
    expect(h.repos.runtime.getJob("held-summary")!.status).toBe("queued");
  });

  it("keeps budget-gated models and retries out of previews and execution", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(epoch);
    const h = harness(); h.job("held-summary", "import_summary"); h.job("held-evolution"); h.job("database-only", "l2_association"); h.retry("held-retry");
    const sources = { memory_summary: { source: "byok" }, memory_evolution: { source: "byok" }, embedding: { source: "byok", mode: "remote" } };
    h.deps.memoryBudgetPaused = () => true;
    h.deps.memoryBudgetModelSources = () => sources;
    h.deps.memoryBudgetJobConsumes = (type) => jobTypeConsumesMemoryBudget(type, sources);
    expect(await h.runner.runWorkerOnce(4)).toMatchObject({ leased: 1, succeeded: 1, embeddingRetries: { leased: 0 } });
    expect(h.comparisons[0]!.legacySelection).toEqual(["main:database-only"]);
    expect(h.comparisons[0]!.shadowSelection).toEqual(["main:database-only"]);
    expect(h.executed).toEqual(["database-only"]);
    expect(h.repos.runtime.getEmbeddingRetry("held-retry")!.status).toBe("pending");
  });
});
