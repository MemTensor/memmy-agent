import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories, type EvolutionJobRecord } from "../../../src/storage/repositories.js";
import { WorkerConcurrencyController } from "../../../src/service/worker/worker-concurrency.js";
import { WorkerRunner, type WorkerRunnerDeps } from "../../../src/service/worker/worker-runner.js";
import { QUEUE_LANES, type QueueLane } from "../../../src/service/worker/job-policy-registry.js";
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
  const root = mkdtempSync(join(tmpdir(), "memmy-worker-fairness-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  resources.push({ root, db });
  const repos = new Repositories(db.db);
  const executed: string[] = [];
  const deps: WorkerRunnerDeps = {
    repos, embedder: createCapturingEmbedder([]), capture: { embedAfterCapture: true },
    embeddingRetryWorkerId: "fairness-test", memoryAddEnabled: () => true,
    memoryBudgetPaused: () => false, memoryBudgetJobConsumes: () => false,
    memoryBudgetModelSources: () => ({ embedding: { mode: "local" } }),
    memoryBudgetNextWakeAtMs: () => Date.now(), summaryModelConfigured: () => true,
    schedulingShadow: { enabled: false }, concurrency: options.concurrency,
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
  const runner = new WorkerRunner(deps);
  function memory(id: string, createdAt = at, tags: string[] = ["agent-source"]) {
    db.db.prepare(`INSERT INTO memories(id,timeline,user_id,memory_value,memory_layer,tags_json,created_at,updated_at)
      VALUES (?,?,'user','synthetic','L1',?,?,?)`).run(id, createdAt, JSON.stringify(tags), createdAt, createdAt);
  }
  function job(id: string, jobType: EvolutionJobRecord["jobType"] = "reflection", input: {
    target?: string; source?: string; createdAt?: string; payload?: Record<string, unknown>;
    scopeKey?: string; scopeSeq?: number;
  } = {}) {
    return repos.runtime.enqueueJob({ id, jobType, userId: "user", targetMemoryId: input.target,
      scopeKey: input.scopeKey, scopeSeq: input.scopeSeq,
      payload: { ...input.payload, ...(input.source ? { source: input.source } : {}) },
      status: "queued", attempts: 0, maxAttempts: 3, createdAt: input.createdAt ?? at, updatedAt: at });
  }
  function retry(id: string, createdAt = at) {
    memory(id, createdAt);
    return repos.runtime.enqueueEmbeddingRetry({ id, targetKind: "trace", targetId: id,
      vectorField: "vec_summary", sourceText: "synthetic", now: epoch });
  }
  return { root, db, repos, deps, runner, job, memory, retry, executed };
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

describe("production WRR and runnable FIFO", () => {
  it("keeps global lane opportunities when targeted maintenance drains interleave", async () => {
    // Keep all four selected jobs admissible: this case isolates cursor sharing,
    // while the dedicated reservation tests exercise background saturation.
    const h = harness({ concurrency: new WorkerConcurrencyController({ maxActiveJobs: 5 }, {}) });
    for (let i = 0; i < 30; i++) {
      h.job(`native-${i}`, "trace_summary"); h.job(`repair-${i}`, "decision_repair");
      h.job(`import-${i}`, "import_summary"); h.job(`evolution-${i}`);
      h.job(`maintenance-${i}`, "project_environment_profile");
    }
    for (let i = 0; i < 12; i++) h.job(`targeted-${i}`, "import_summary", {
      target: `manual-${i}`, source: "startup.placeholder_summary_repair"
    });
    const counts = Object.fromEntries(QUEUE_LANES.map(lane => [lane, 0])) as Record<QueueLane, number>;
    for (let round = 0; round < 12; round++) {
      const auto = await h.runner.runWorkerOnce(4);
      for (const ref of auto.jobs) counts[h.repos.runtime.getJob(ref.jobId)!.queueLane as QueueLane]++;
      const targeted = await h.runner.runWorkerOnce(1, { targetMemoryIds: [`manual-${round}`] });
      expect(targeted.jobs.map(ref => ref.jobId)).toEqual([`targeted-${round}`]);
    }
    expect(counts).toEqual({ interactive: 16, repair_retry: 12, import: 8, evolution: 8, maintenance: 4 });
  });

  it("preserves a targeted lane round without consuming the global cursor", async () => {
    const h = harness();
    for (let i = 0; i < 8; i++) {
      h.job(`global-${i}`, "trace_summary");
      h.job(`target-native-${i}`, "trace_summary", { target: "target" });
      h.job(`target-evolution-${i}`, "reflection", { target: "target" });
    }
    await h.runner.runWorkerOnce(2);
    const globalCursor = h.repos.runtime.getKv("worker.scheduler.wrr_cursor.v1")!.value;
    const selected: string[] = [];
    for (let i = 0; i < 6; i++) {
      selected.push((await h.runner.runWorkerOnce(1, { targetMemoryIds: ["target"] })).jobs[0]!.jobId);
      expect(h.repos.runtime.getKv("worker.scheduler.wrr_cursor.v1")!.value).toEqual(globalCursor);
    }
    expect(selected.filter(id => id.startsWith("target-native"))).toHaveLength(4);
    expect(selected.filter(id => id.startsWith("target-evolution"))).toHaveLength(2);
  });

  it("does not let a public retry-only drain consume global repair opportunities", async () => {
    const h = harness();
    for (let i = 0; i < 8; i++) h.job(`native-${i}`, "trace_summary");
    h.job("manual-repair", "decision_repair");
    h.retry("retry-first"); h.retry("retry-second");
    await h.runner.runWorkerOnce(4);
    const globalCursor = h.repos.runtime.getKv("worker.scheduler.wrr_cursor.v1")!.value;
    expect((await h.runner.runEmbeddingRetryOnce(1)).leased).toBe(1);
    expect(h.repos.runtime.getKv("worker.scheduler.wrr_cursor.v1")!.value).toEqual(globalCursor);
    expect((await h.runner.runWorkerOnce(1)).jobs[0]?.jobId).toBe("manual-repair");
  });

  it("retries the older due failure before newer failures in the same lane", async () => {
    const h = harness();
    h.memory("older", "2026-10-20T00:00:00.000Z");
    h.memory("newer", "2026-10-21T00:00:00.000Z");
    const older = h.job("older-job", "import_summary", { target: "older" });
    h.job("newer-job", "import_summary", { target: "newer" });
    h.db.db.prepare("UPDATE evolution_jobs SET status='failed',failure_count=1,attempts=1,available_at=?").run(at);
    const result = await h.runner.runWorkerOnce(1);
    expect(result.jobs.map(job => job.jobId)).toEqual(["older-job"]);
    expect(h.repos.runtime.getJob("older-job")).toMatchObject({ status: "succeeded", enqueueSeq: older.enqueueSeq,
      failureCount: 1, attempts: 2 });
    expect(h.repos.runtime.getJob("newer-job")).toMatchObject({ status: "failed", failureCount: 1, attempts: 1 });
  });

  it("gives every lane due-failure opportunities before old-priority recovery can hide them", async () => {
    const h = harness();
    for (let i = 0; i < 16; i++) h.job(`native-${i}`, "trace_summary");
    h.job("repair", "decision_repair"); h.job("import", "import_summary");
    h.job("evolution"); h.job("maintenance", "project_environment_profile");
    h.db.db.prepare("UPDATE evolution_jobs SET status='failed',failure_count=1,attempts=1,available_at=?").run(at);
    for (let i = 0; i < 12; i++) await h.runner.runWorkerOnce(1);
    for (const id of ["repair", "import", "evolution", "maintenance"]) {
      expect(h.repos.runtime.getJob(id)).toMatchObject({ status: "succeeded", failureCount: 1, attempts: 2 });
    }
  });

  it("gives retry, reflection and maintenance real execution under ten thousand imported summaries", async () => {
    const h = harness();
    h.repos.transaction(() => {
      for (let i = 0; i < 10_000; i++) h.job(`import-${i}`, "import_summary");
      h.job("native", "trace_summary"); h.job("reflection");
      h.job("maintenance", "import_summary", { source: "startup.placeholder_summary_repair" });
      h.retry("repair");
    });
    for (let round = 0; round < 3; round++) await h.runner.runWorkerOnce(4, { priorityCohortOnly: true });
    for (const id of ["native", "reflection", "maintenance"]) {
      expect(h.repos.runtime.getJob(id)).toMatchObject({ status: "succeeded", failureCount: 0 });
    }
    expect(h.repos.runtime.getEmbeddingRetry("repair")).toMatchObject({ status: "succeeded" });
    expect(h.executed.some(id => id.startsWith("import-"))).toBe(true);
    expect(h.repos.runtime.getJob("import-9999")).toMatchObject({ status: "queued", attempts: 0 });
  }, 15_000);

  it("preserves a 4/3/2/2/1 complete round across twelve one-item drains", async () => {
    const h = harness(), lanes = new Map<string, QueueLane>();
    for (let i = 0; i < 8; i++) {
      for (const [lane, jobType, source] of [
        ["interactive", "trace_summary", undefined], ["repair_retry", "decision_repair", undefined],
        ["import", "import_summary", undefined], ["evolution", "reflection", undefined],
        ["maintenance", "import_summary", "startup.placeholder_summary_repair"]
      ] as const) {
        const id = `${lane}-${i}`; h.job(id, jobType, { source }); lanes.set(id, lane);
      }
    }
    for (let i = 0; i < 12; i++) await h.runner.runWorkerOnce(1);
    const totals = Object.fromEntries(QUEUE_LANES.map(lane => [lane, 0])) as Record<QueueLane, number>;
    for (const id of h.executed) totals[lanes.get(id)!]++;
    expect(totals).toEqual({ interactive: 4, repair_retry: 3, import: 2, evolution: 2, maintenance: 1 });
    expect(h.executed).toHaveLength(12);
  });

  it("continues the weighted round after the database and runner reopen", async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) h.job(`native-${i}`, "trace_summary");
    h.job("repair", "decision_repair"); h.job("import", "import_summary");
    h.job("evolution"); h.job("maintenance", "project_environment_profile");
    for (let i = 0; i < 4; i++) await h.runner.runWorkerOnce(1);
    expect(h.executed).toEqual(["native-0", "native-1", "native-2", "native-3"]);
    const path = h.db.path;
    h.db.close();
    const reopened = new MemoryDb({ path });
    resources.find(resource => resource.root === h.root)!.db = reopened;
    h.deps.repos = new Repositories(reopened.db);
    const nextRunner = new WorkerRunner(h.deps);
    expect((await nextRunner.runWorkerOnce(1)).jobs[0]?.jobId).toBe("repair");
  });

  it("rolls back claims and weighted position when the claim transaction fails", async () => {
    const h = harness();
    for (let i = 0; i < 4; i++) h.job(`native-${i}`, "trace_summary");
    h.job("repair", "decision_repair");
    const runtime = h.repos.runtime;
    const original = runtime.claimQueuedJob.bind(runtime);
    let claims = 0;
    const failure = vi.spyOn(runtime, "claimQueuedJob").mockImplementation((...args) => {
      if (++claims === 2) throw new Error("controlled claim transaction failure");
      return original(...args);
    });
    await expect(h.runner.runWorkerOnce(4)).rejects.toThrow("controlled claim transaction failure");
    expect(h.repos.runtime.getJob("native-0")).toMatchObject({ status: "queued", attempts: 0, leaseToken: null });
    expect(h.executed).toEqual([]);
    failure.mockRestore();
    expect((await h.runner.runWorkerOnce(4)).jobs.map(job => job.jobId)).toEqual(["native-0", "native-1", "native-2", "native-3"]);
    expect(h.repos.runtime.getJob("repair")!.status).toBe("queued");
  });

  it("uses explicitly configured positive lane weights", async () => {
    vi.stubEnv("MEMMY_WORKER_LANE_WEIGHTS", JSON.stringify({ interactive: 1, repair_retry: 1, import: 1, evolution: 1, maintenance: 1 }));
    const h = harness();
    for (let i = 0; i < 3; i++) {
      h.job(`native-${i}`, "trace_summary"); h.job(`repair-${i}`, "decision_repair");
      h.job(`import-${i}`, "import_summary"); h.job(`evolution-${i}`);
      h.job(`maintenance-${i}`, "project_environment_profile");
    }
    for (let i = 0; i < 5; i++) await h.runner.runWorkerOnce(1);
    expect(h.executed).toEqual(["native-0", "repair-0", "import-0", "evolution-0", "maintenance-0"]);
  });

  it("does not let newer memory creation times overtake an older queued import", async () => {
    const h = harness(); h.memory("old"); h.job("old-job", "import_summary", { target: "old" });
    for (let i = 0; i < 5; i++) {
      h.memory(`new-${i}`, new Date(epoch + (i + 1) * 60_000).toISOString());
      h.job(`new-job-${i}`, "import_summary", { target: `new-${i}` });
    }
    await h.runner.runWorkerOnce(1);
    expect(h.executed).toEqual(["old-job"]);
    expect(h.repos.runtime.getJob("new-job-4")!.status).toBe("queued");
  });

  it("uses retry enqueue order instead of target recency", async () => {
    const h = harness(); h.retry("old-retry"); h.retry("new-retry", new Date(epoch + 60_000).toISOString());
    expect((await h.runner.runWorkerOnce(1)).embeddingRetries).toMatchObject({ leased: 1, succeeded: 1 });
    expect(h.executed).toEqual(["retry:old-retry"]);
    expect(h.repos.runtime.getEmbeddingRetry("new-retry")!.status).toBe("pending");
  });

  it("starts explicit repair jobs and embedding retry requests in the same lane FIFO", async () => {
    const started: string[] = [];
    const h = harness({ process: async job => { started.push(job.id); } });
    h.deps.embedder.embed = async texts => { started.push("retry:older-retry"); return texts.map(() => [1, 0, 0]); };
    h.retry("older-retry"); h.job("manual-summary", "trace_summary", { source: "memory.processing.manual_retry" });
    await h.runner.runWorkerOnce(2);
    expect(started).toEqual(["retry:older-retry", "manual-summary"]);
    expect(h.executed).toEqual(expect.arrayContaining(["retry:older-retry", "manual-summary"]));
  });
  it("fills a request across priority cohorts instead of throwing away three runnable slots", async () => {
    const h = harness(); h.job("summary", "trace_summary");
    for (let i = 0; i < 3; i++) h.job(`reflection-${i}`);
    const result = await h.runner.runWorkerOnce(4, { priorityCohortOnly: true });
    expect(result).toMatchObject({ leased: 4, succeeded: 4 });
    expect(h.executed).toHaveLength(4);
  });

  it("skips delayed and configuration-blocked heads, then restores the original FIFO position", async () => {
    const h = harness();
    const original = h.job("backoff", "import_summary");
    h.job("scheduled", "import_summary", { payload: { runAfter: new Date(epoch + 60_000).toISOString() } });
    h.job("config", "import_summary"); h.job("younger", "import_summary");
    h.db.db.prepare("UPDATE evolution_jobs SET available_at=? WHERE id='backoff'").run(new Date(epoch + 60_000).toISOString());
    h.db.db.exec("UPDATE evolution_jobs SET blocked_reason='configuration' WHERE id='config'");
    await h.runner.runWorkerOnce(1);
    expect(h.executed).toEqual(["younger"]);
    h.job("newest", "import_summary");
    vi.setSystemTime(epoch + 60_000);
    await h.runner.runWorkerOnce(1);
    expect(h.executed).toEqual(["younger", "backoff"]);
    expect(h.repos.runtime.getJob("backoff")!.enqueueSeq).toBe(original.enqueueSeq);
    expect(h.repos.runtime.getJob("config")!.attempts).toBe(0);
  });

  it("skips reward dependencies and blocked scope positions without blocking another scope", async () => {
    const h = harness(); h.memory("parent", at, []);
    h.db.db.prepare(`INSERT INTO memory_processing_state(memory_id,state,stage,updated_at)
      VALUES ('parent','embedding_pending','embedding',?)`).run(at);
    h.job("blocked-reward", "reward", { payload: { l1MemoryId: "parent", polarity: "positive" } });
    h.job("scope-first", "work_memory_extract", { scopeKey: "scope-A", scopeSeq: 1, payload: { runAfter: new Date(epoch + 60_000).toISOString() } });
    h.job("scope-next", "work_memory_extract", { scopeKey: "scope-A", scopeSeq: 2 });
    h.job("other-scope", "work_memory_extract", { scopeKey: "scope-B", scopeSeq: 1 });
    h.job("free-reflection");
    await h.runner.runWorkerOnce(4);
    expect(h.executed).toEqual(["other-scope", "free-reflection"]);
    for (const id of ["blocked-reward", "scope-first", "scope-next"]) expect(h.repos.runtime.getJob(id)!.attempts).toBe(0);
    h.db.db.exec("UPDATE memory_processing_state SET state='ready',stage=NULL WHERE memory_id='parent'");
    await h.runner.runWorkerOnce(1);
    expect(h.executed.at(-1)).toBe("blocked-reward");
  });

  it("keeps first reports in interactive while respecting earlier runnable work in that lane", async () => {
    const h = harness(); h.job("earlier-native", "trace_summary");
    h.memory("first-report", at, ["first-encounter-report"]);
    h.job("first-report-job", "import_summary", { target: "first-report" });
    for (let i = 0; i < 20; i++) h.job(`history-${i}`, "import_summary");
    await h.runner.runWorkerOnce(2);
    expect(h.executed).toEqual(["earlier-native", "first-report-job"]);
    expect(h.repos.runtime.getJob("first-report-job")).toMatchObject({ queueLane: "interactive", status: "succeeded" });
  });

  it("continues weighted opportunities after a temporary failure instead of retrying it immediately", async () => {
    const h = harness({ process: async job => { if (job.id === "failing-native") throw new Error("temporary request timeout"); } });
    h.job("failing-native", "trace_summary");
    for (let i = 0; i < 15; i++) h.job(`native-${i}`, "trace_summary");
    h.job("reflection"); h.retry("retry"); h.job("maintenance", "project_environment_profile");
    for (let i = 0; i < 12; i++) await h.runner.runWorkerOnce(1);
    expect(h.repos.runtime.getJob("failing-native")).toMatchObject({ status: "failed", failureCount: 1, attempts: 1 });
    expect(h.repos.runtime.getJob("reflection")!.status).toBe("succeeded");
    expect(h.repos.runtime.getJob("maintenance")!.status).toBe("succeeded");
    expect(h.repos.runtime.getEmbeddingRetry("retry")!.status).toBe("succeeded");
  });

  it("refreshes a dirty active backlog before an already classified younger task can overtake it", async () => {
    const h = harness();
    h.repos.transaction(() => {
      const insert = h.db.db.prepare(`INSERT INTO evolution_jobs
        (id,job_type,status,user_id,payload_json,attempts,max_attempts,created_at,updated_at)
        VALUES (?,?,'queued','user','{}',0,3,?,?)`);
      for (let i = 0; i < 1_000; i++) insert.run(`dirty-maintenance-${i}`, "project_environment_profile", at, at);
      insert.run("dirty-older-import", "import_summary", at, at);
      h.job("classified-younger-import", "import_summary");
    });
    expect(h.repos.runtime.getJob("dirty-older-import")!.policyVersion).toBeNull();
    expect(h.repos.runtime.getJob("classified-younger-import")!.policyVersion).not.toBeNull();
    await h.runner.runWorkerOnce(1);
    expect(h.executed).toEqual(["dirty-older-import"]);
    expect(h.repos.runtime.getJob("classified-younger-import")).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("quarantines an unknown task without invoking its business handler or hiding valid work", async () => {
    const h = harness();
    h.db.db.prepare(`INSERT INTO evolution_jobs
      (id,job_type,status,user_id,payload_json,attempts,max_attempts,created_at,updated_at)
      VALUES ('unsupported','future_unregistered_job','queued','user','{}',0,3,?,?)`).run(at, at);
    h.job("native", "trace_summary"); h.job("reflection");
    await h.runner.runWorkerOnce(4);
    expect(h.executed).toEqual(["native", "reflection"]);
    expect(h.repos.runtime.getJob("unsupported")).toMatchObject({ status: "dead_letter" });
    expect(h.repos.runtime.getJob("native")!.status).toBe("succeeded");
    expect(h.repos.runtime.getJob("reflection")!.status).toBe("succeeded");
    expect(h.runner.nextWorkerRunAt()).toBeUndefined();
  });

  it("keeps a capacity-blocked retry unclaimed while the active main task renews its lease", async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch);
    const entered = deferred(), gate = deferred();
    const h = harness({ concurrency: new WorkerConcurrencyController({ maxActiveJobs: 1 }, {}),
      process: async () => { entered.resolve(); await gate.promise; } });
    h.job("slow-summary", "trace_summary"); const original = h.retry("waiting-retry");
    const run = h.runner.runWorkerOnce(2);
    await entered.promise;
    const initialMain = h.repos.runtime.getJob("slow-summary")!;
    try {
      expect(h.repos.runtime.getEmbeddingRetry(original.id)).toMatchObject({ status: "pending", leaseToken: null });
      await vi.advanceTimersByTimeAsync(310_000);
      expect(h.repos.runtime.getEmbeddingRetry(original.id)).toMatchObject({ status: "pending", attempts: 0,
        enqueueSeq: original.enqueueSeq, claimedBy: null, leaseToken: null, leaseUntil: null });
      const activeMain = h.repos.runtime.getJob("slow-summary")!;
      expect(activeMain).toMatchObject({ status: "leased", leaseToken: initialMain.leaseToken });
      expect(Date.parse(activeMain.leasedUntil!)).toBeGreaterThan(Date.now());
      expect(h.executed).toEqual(["slow-summary"]);
    } finally { gate.resolve(); }
    expect((await run).embeddingRetries).toMatchObject({ leased: 1, succeeded: 1, failed: 0 });
    expect(h.repos.runtime.getEmbeddingRetry(original.id)!.status).toBe("succeeded");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("leaves a waiting retry unclaimed when an active task pauses the budget, preserving its FIFO position", async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch);
    const entered = deferred(), gate = deferred();
    let paused = false;
    const h = harness({ concurrency: new WorkerConcurrencyController({ maxActiveJobs: 1 }, {}),
      process: async () => { entered.resolve(); await gate.promise; paused = true; } });
    h.deps.memoryBudgetPaused = () => paused;
    h.deps.memoryBudgetJobConsumes = type => type === "embedding";
    h.job("slow-summary", "trace_summary"); const original = h.retry("budget-held-retry");
    const run = h.runner.runWorkerOnce(2);
    await entered.promise;
    try {
      await vi.advanceTimersByTimeAsync(310_000);
      expect(h.repos.runtime.getEmbeddingRetry(original.id)).toMatchObject({ status: "pending", leaseUntil: null });
    } finally { gate.resolve(); }
    expect((await run).embeddingRetries).toMatchObject({ leased: 0, succeeded: 0, failed: 0 });
    expect(h.executed).toEqual(["slow-summary"]);
    expect(h.repos.runtime.getEmbeddingRetry(original.id)).toMatchObject({
      status: "pending", attempts: 0, enqueueSeq: original.enqueueSeq,
      nextAttemptAt: original.nextAttemptAt, leaseToken: null, claimedBy: null, leaseUntil: null
    });
    expect((await h.runner.runWorkerOnce(1)).embeddingRetries.leased).toBe(0);
    paused = false;
    expect((await h.runner.runWorkerOnce(1)).embeddingRetries).toMatchObject({ leased: 1, succeeded: 1, failed: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps target-limited requests from consuming jobs in another target", async () => {
    const h = harness(); h.job("allowed", "import_summary", { target: "A" }); h.job("outside", "trace_summary", { target: "B" });
    h.retry("B");
    const result = await h.runner.runWorkerOnce(4, { targetMemoryIds: ["A"] });
    expect(result).toMatchObject({ leased: 1, succeeded: 1, embeddingRetries: { leased: 0 } });
    expect(h.executed).toEqual(["allowed"]);
    expect(h.repos.runtime.getJob("outside")!.attempts).toBe(0);
    expect(h.repos.runtime.getEmbeddingRetry("B")!.status).toBe("pending");
  });
});

describe("legacy scheduling rollback", () => {
  it("retains legacy SQL priority and spare retry admission while continuous refill uses remaining capacity", async () => {
    vi.stubEnv("MEMMY_WORKER_SCHEDULER_ALGORITHM", "legacy");
    const h = harness(); h.job("one-summary", "trace_summary");
    for (let i = 0; i < 4; i++) h.job(`import-${i}`, "import_summary");
    h.job("reflection"); h.retry("retry");
    expect(h.repos.runtime.previewLegacyJobPage({ at, limit: 10 }).map(row => row.job.id))
      .toEqual(["one-summary", "import-0", "import-1", "import-2", "import-3", "reflection"]);
    const first = await h.runner.runWorkerOnce(4, { priorityCohortOnly: true });
    expect(first).toMatchObject({ leased: 3, succeeded: 3, embeddingRetries: { leased: 1 } });
    expect(first.jobs.map(job => job.jobId)).toEqual(["one-summary", "import-0", "import-1"]);
    expect(h.repos.runtime.getJob("reflection")!.attempts).toBe(0);
    const second = await h.runner.runWorkerOnce(4, { priorityCohortOnly: true });
    expect(second).toMatchObject({ leased: 3, succeeded: 3, embeddingRetries: { leased: 0 } });
    expect(second.jobs.map(job => job.jobId)).toEqual(["import-2", "import-3", "reflection"]);
  });
  it("keeps the old memory-recency order when legacy is explicitly selected", async () => {
    const h = harness({ algorithm: "legacy" });
    h.memory("older"); h.job("older-job", "import_summary", { target: "older" });
    h.memory("newer", new Date(epoch + 60_000).toISOString()); h.job("newer-job", "import_summary", { target: "newer" });
    await h.runner.runWorkerOnce(1);
    expect(h.executed).toEqual(["newer-job"]);
  });
});


describe("scheduler configuration validation", () => {
  it("fails construction explicitly for an unsupported algorithm", () => {
    vi.stubEnv("MEMMY_WORKER_SCHEDULER_ALGORITHM", "unsupported-algorithm");
    expect(() => harness()).toThrow(RangeError);
  });

  it("fails construction explicitly for malformed lane-weight JSON", () => {
    vi.stubEnv("MEMMY_WORKER_LANE_WEIGHTS", "{broken-json");
    expect(() => harness()).toThrow(TypeError);
  });

  it("fails construction explicitly for a missing or non-positive lane weight", () => {
    vi.stubEnv("MEMMY_WORKER_LANE_WEIGHTS", JSON.stringify({ interactive: 4, repair_retry: 3, import: 2, evolution: 2 }));
    expect(() => harness()).toThrow(RangeError);
    vi.stubEnv("MEMMY_WORKER_LANE_WEIGHTS", JSON.stringify({ interactive: 4, repair_retry: 3, import: 2, evolution: 2, maintenance: 0 }));
    expect(() => harness()).toThrow(RangeError);
  });
});

function embeddingRoleHarness(algorithm: "wrr" | "legacy", roles: Array<"document" | "query">) {
  const h = harness({ algorithm });
  const calls: Array<{ role: "document" | "query" | undefined; texts: string[] }> = [];
  const applied: string[] = [];
  h.deps.embeddingJobs.prepareEmbeddingJob = (job) => ({
    job, memory: h.repos.memories.get(job.targetMemoryId!)!, text: job.id,
    role: job.payload.role as "document" | "query", vectorField: "vec_summary"
  });
  h.deps.embeddingJobs.applyEmbeddingVector = (item) => { applied.push(item.job.id); };
  h.deps.embedder.embed = async (texts, role) => {
    calls.push({ role, texts: [...texts] });
    return texts.map(() => [1, 0, 0]);
  };
  roles.forEach((role, index) => {
    const id = `embedding-${index}`;
    h.memory(id, at, []);
    h.job(id, "embedding", { target: id, payload: { role } });
  });
  return { ...h, calls, applied };
}

describe("main Embedding FIFO across role boundaries", () => {
  it("executes query then document then query in the same order as WRR admission", async () => {
    const h = embeddingRoleHarness("wrr", ["query", "document", "query"]);
    const result = await h.runner.runWorkerOnce(3);
    expect(h.calls).toEqual([
      { role: "query", texts: ["embedding-0"] },
      { role: "document", texts: ["embedding-1"] },
      { role: "query", texts: ["embedding-2"] }
    ]);
    expect(h.applied).toEqual(["embedding-0", "embedding-1", "embedding-2"]);
    expect(result).toMatchObject({ leased: 3, succeeded: 3, failed: 0 });
    expect(result.jobs.map(job => job.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
  });

  it("retains a batch for adjacent document jobs without overtaking the older query", async () => {
    const h = embeddingRoleHarness("wrr", ["query", "document", "document", "query"]);
    expect(await h.runner.runWorkerOnce(4)).toMatchObject({ leased: 4, succeeded: 4, failed: 0 });
    expect(h.calls).toEqual([
      { role: "query", texts: ["embedding-0"] },
      { role: "document", texts: ["embedding-1", "embedding-2"] },
      { role: "query", texts: ["embedding-3"] }
    ]);
    expect(h.applied).toEqual(["embedding-0", "embedding-1", "embedding-2", "embedding-3"]);
    expect(h.repos.runtime.listJobs("succeeded")).toHaveLength(4);
  });

  it("retains legacy SQL admission order without restoring a cross-role execution barrier", async () => {
    const h = embeddingRoleHarness("legacy", ["query", "document", "document", "query"]);
    expect(h.repos.runtime.previewLegacyJobPage({ at, limit: 4 }).map(row => row.job.id))
      .toEqual(["embedding-0", "embedding-1", "embedding-2", "embedding-3"]);
    expect(await h.runner.runWorkerOnce(4)).toMatchObject({ leased: 4, succeeded: 4, failed: 0 });
    expect(h.calls).toEqual([
      { role: "query", texts: ["embedding-0"] },
      { role: "document", texts: ["embedding-1", "embedding-2"] },
      { role: "query", texts: ["embedding-3"] }
    ]);
    expect(h.applied).toEqual(["embedding-0", "embedding-1", "embedding-2", "embedding-3"]);
    expect(h.repos.runtime.listJobs("succeeded")).toHaveLength(4);
  });});
