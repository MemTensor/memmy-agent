/**
 * Stage 1 diagnostics, with repaired cases converted to stage 2 regressions.
 *
 * Scheduling diagnostics explicitly select the legacy rollback algorithm.
 * Lease/recovery/backoff cases assert the repaired stage 2 behavior.
 * Cross-entry overlap is a repaired stage 4 regression. Stage 6 keeps the legacy
 * selection diagnostic but asserts safe admission and continuous execution.
 * SQLite, schema, repositories and WorkerRunner are real. Business handlers and
 * model requests are controlled local substitutes so queue timing is repeatable.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories, type EvolutionJobRecord } from "../../../src/storage/repositories.js";
import { WorkerRunner, type WorkerRunnerDeps } from "../../../src/service/worker/worker-runner.js";
import { createCapturingEmbedder } from "../../fixtures/memory-service-fixture.js";

const resources: Array<{ root: string; db: MemoryDb }> = [];
const observations: Array<{ scenario: string; [key: string]: unknown }> = [];
const epoch = Date.parse("2026-10-22T00:00:00.000Z");

function record(scenario: string, values: Record<string, unknown>): void {
  observations.push({ scenario, ...values });
}

async function flushWorker() { for (let i = 0; i < 100; i++) await Promise.resolve(); }

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(processJob: WorkerRunnerDeps["jobHandlers"]["processJob"] = async () => {}) {
  const root = mkdtempSync(join(tmpdir(), "memmy-queue-baseline-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  resources.push({ root, db });
  const repos = new Repositories(db.db);
  const deps: WorkerRunnerDeps = {
    repos,
    scheduling: { algorithm: "legacy" },
    embedder: createCapturingEmbedder([]),
    capture: { embedAfterCapture: true },
    embeddingRetryWorkerId: "baseline-runner",
    memoryAddEnabled: () => true,
    memoryBudgetPaused: () => false,
    memoryBudgetJobConsumes: () => false,
    memoryBudgetModelSources: () => ({ embedding: { mode: "local" } }),
    memoryBudgetNextWakeAtMs: () => Date.now(),
    summaryModelConfigured: () => true,
    nowIso: () => new Date().toISOString(),
    encodeChangeCursor: String,
    namespaceIdFromMemory: () => "baseline",
    runWorkerNoWrite: async () => { throw new Error("unexpected disabled worker"); },
    restartFailedProcessing: () => 0,
    previewPolicyEvidenceReconciliation: () => ({
      orphanPolicyIds: [], affectedWorldModelIds: [], affectedSkillIds: [], restorablePolicyIds: []
    }),
    reconcileOrphanedPolicies: () => 0,
    enqueueJob: () => { throw new Error("unexpected startup enqueue"); },
    enqueueEmbeddingRetry: () => { throw new Error("unexpected replacement retry"); },
    appendJobChange: () => {},
    appendEmbeddingRetryChange: () => {},
    jobHandlers: { processJob },
    embeddingJobs: {
      prepareEmbeddingJob: () => { throw new Error("unexpected main embedding job"); },
      applyEmbeddingVector: () => {},
      // Only the queue-state transition is relevant to these tests.
      persistEmbeddingVector: (input) => {
        const target = repos.memories.get(input.memoryId);
        if (!target) throw new Error("missing synthetic retry target");
        input.finalize?.(target, false, new Date().toISOString());
        return target;
      },
      enqueueEmbeddingRetryAfterFailure: () => false
    }
  };
  const runner = new WorkerRunner(deps);
  const insertMemory = db.db.prepare(`INSERT INTO memories
    (id, timeline, user_id, memory_value, memory_layer, tags_json, created_at, updated_at)
    VALUES (?, ?, 'baseline-user', ?, 'L1', ?, ?, ?)`);
  function memory(id: string, createdAt = new Date(epoch).toISOString(), imported = true): void {
    insertMemory.run(id, createdAt, `synthetic memory ${id}`, imported ? '["agent-source"]' : '[]', createdAt, createdAt);
  }
  function job(id: string, jobType: EvolutionJobRecord["jobType"], options: {
    target?: string; source?: string; createdAt?: string; runAfter?: string;
  } = {}): void {
    const at = options.createdAt ?? new Date(epoch).toISOString();
    const input: Parameters<typeof repos.runtime.enqueueJob>[0] = {
      id, jobType, status: "queued", userId: "baseline-user", targetMemoryId: options.target,
      payload: { ...(options.source ? { source: options.source } : {}),
        ...(options.runAfter ? { runAfter: options.runAfter } : {}) },
      attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at
    };
    // Bulk fixtures already own the transaction; retain the same enqueue logic
    // without opening a savepoint for every synthetic job.
    if (db.db.inTransaction) repos.runtime.enqueueJobInTransaction(input);
    else repos.runtime.enqueueJob(input);
  }
  function retry(id: string, target: string): void {
    repos.runtime.enqueueEmbeddingRetry({
      id, targetKind: "trace", targetId: target, vectorField: "vec_summary",
      sourceText: `synthetic memory ${target}`, now: Date.now()
    });
  }
  return { db, repos, runner, memory, job, retry };
}

afterEach(() => {
  vi.useRealTimers();
  for (const { root, db } of resources.splice(0)) {
    if (db.db.open) db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

afterAll(() => {
  const path = process.env.MEMMY_QUEUE_BASELINE_RESULTS;
  if (path) {
    // The same diagnostics become regression tests as implementation advances.
    // A caller-supplied label must never masquerade as the code actually run.
    let testedCommit = "unavailable";
    let workingTreeDirty: boolean | null = null;
    try {
      testedCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      workingTreeDirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;
    } catch { /* An exported source archive may not include Git metadata. */ }
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({
      testedCommit,
      workingTreeDirty,
      referenceLabel: process.env.MEMMY_QUEUE_BASELINE_REF ?? null,
      schedulingAlgorithm: "legacy",
      method: "real SQLite and WorkerRunner; local substitute business/model handlers",
      observations
    }, null, 2));
  }
});

describe("legacy selection diagnostics and current execution safety", () => {
  // The legacy diagnostic includes a 10,000-row fixture and 50 complete worker
  // rounds. Its watchdog is separate from the scheduling assertions below.
  it("leaves runnable reflection and embedding retry untouched across 50 full import rounds", async () => {
    const h = harness();
    h.db.db.transaction(() => {
      for (let i = 0; i < 10_000; i++) {
        h.memory(`import-${i}`);
        h.job(`job-import-${i}`, "import_summary", { target: `import-${i}` });
      }
    })();
    h.memory("retry-target");
    h.retry("retry-waiting", "retry-target");
    h.job("reflection-waiting", "reflection");
    h.job("maintenance-waiting", "import_summary", {
      source: "startup.placeholder_summary_repair"
    });
    const start = performance.now();
    const rounds = [];
    for (let i = 0; i < 50; i++) rounds.push(await h.runner.runWorkerOnce(4, { priorityCohortOnly: true }));
    expect(rounds.every((r) => r.leased === 4 && r.succeeded === 4 && r.embeddingRetries.leased === 0)).toBe(true);
    expect(h.repos.runtime.getJob("reflection-waiting")).toMatchObject({ status: "queued", attempts: 0 });
    expect(h.repos.runtime.getJob("maintenance-waiting")).toMatchObject({ status: "queued", attempts: 0 });
    expect(h.repos.runtime.getEmbeddingRetry("retry-waiting")).toMatchObject({ status: "pending", attempts: 0 });
    const runnable = h.repos.runtime.claimDueEmbeddingRetries({
      now: Date.now(), workerId: "runnable-probe", leaseUntil: Date.now() + 60_000, limit: 1
    });
    expect(runnable.map((r) => r.id)).toEqual(["retry-waiting"]);
    const reflectionProbe = h.repos.runtime.leaseQueuedJobs(1, 60, undefined, false, ["reflection"]);
    expect(reflectionProbe.map((j) => j.id)).toEqual(["reflection-waiting"]);
    // Control: a new native task still outranks the import backlog.
    h.memory("native-target", undefined, false);
    h.job("interactive-probe", "trace_summary", { target: "native-target" });
    const interactive = await h.runner.runWorkerOnce(4, { priorityCohortOnly: true });
    expect(interactive.jobs[0]?.jobId).toBe("interactive-probe");
    expect(interactive.leased).toBe(4);
    record("10000_import_backlog", {
      seededImports: 10_000, rounds: 50, completedImports: 200, remainingImports: 9_800,
      retryLeased: 0, reflectionStarted: 0, maintenanceStarted: 0, retryDirectClaimControl: true,
      reflectionDirectClaimControl: true,
      nativeTaskControl: "starts first, then fills remaining execution opportunities", elapsedMs: Math.round(performance.now() - start)
    });
  }, 30_000);

  it("runs a due embedding retry with free capacity (control)", async () => {
    const h = harness();
    h.memory("free-target");
    h.retry("free-retry", "free-target");
    const result = await h.runner.runWorkerOnce(4);
    expect(result).toMatchObject({ leased: 0, embeddingRetries: { leased: 1, succeeded: 1, failed: 0 } });
    record("retry_free_capacity_control", { leased: 1, succeeded: 1 });
  });

  it("already places startup repair after reflection in the current target branch (control)", () => {
    const h = harness();
    h.repos.transaction(() => {
      for (let i = 0; i < 10_000; i++) h.job(`startup-${i}`, "import_summary", {
        source: "startup.placeholder_summary_repair"
      });
      h.job("normal-reflection", "reflection");
    });
    const leased = h.repos.runtime.leaseQueuedJobs(4, 60, undefined, true);
    expect(leased.map((j) => j.id)).toEqual(["normal-reflection"]);
    record("startup_repair_priority_control", { startupBacklog: 10_000, firstClaim: "reflection", leased: 1 });
  });

  it("keeps an onboarding first report ahead of native and imported summaries (control)", () => {
    const h = harness();
    h.memory("onboarding"); h.memory("native", undefined, false); h.memory("imported");
    h.db.db.prepare("UPDATE memories SET tags_json = '[\"first-encounter-report\"]' WHERE id = 'onboarding'").run();
    h.job("onboarding-report", "import_summary", { target: "onboarding" });
    h.job("native-summary", "trace_summary", { target: "native" });
    h.job("import-summary", "import_summary", { target: "imported" });
    const leased = h.repos.runtime.leaseQueuedJobs(4, 60, undefined, true);
    expect(leased.map((j) => j.id)).toEqual(["onboarding-report"]);
    record("onboarding_priority_control", { firstClaim: "onboarding-first-report" });
  });

  it("lets continuously newer imports overtake an older queued import", () => {
    const h = harness();
    h.memory("old-memory");
    h.job("old-job", "import_summary", { target: "old-memory" });
    const selected = [];
    for (let i = 1; i <= 25; i++) {
      const at = new Date(epoch + i * 1_000).toISOString();
      h.memory(`new-memory-${i}`, at);
      h.job(`new-job-${i}`, "import_summary", { target: `new-memory-${i}`, createdAt: at });
      const [claimed] = h.repos.runtime.leaseQueuedJobs(1);
      selected.push(claimed!.id);
      h.repos.runtime.completeJob(claimed!.id, undefined, claimed);
    }
    expect(selected.every((id) => id !== "old-job")).toBe(true);
    expect(h.repos.runtime.getJob("old-job")).toMatchObject({ status: "queued", attempts: 0 });
    record("new_imports_overtake_old", { rounds: 25, newerCompleted: 25, oldestAttempts: 0 });
  });

  it("also prefers a newer memory over an older due embedding retry", () => {
    const h = harness();
    h.memory("retry-old"); h.retry("old-retry", "retry-old");
    h.memory("retry-new", new Date(epoch + 60_000).toISOString()); h.retry("new-retry", "retry-new");
    const [claimed] = h.repos.runtime.claimDueEmbeddingRetries({
      now: Date.now(), workerId: "probe", leaseUntil: Date.now() + 60_000, limit: 1
    });
    expect(claimed!.id).toBe("new-retry");
    expect(h.repos.runtime.getEmbeddingRetry("old-retry")!.status).toBe("pending");
    record("retry_order_control", { firstClaim: "newer-memory", olderRetry: "pending" });
  });

  it("fills lower-tier work after the first legacy priority cohort finishes", async () => {
    const h = harness();
    h.job("one-summary", "trace_summary");
    for (let i = 0; i < 3; i++) h.job(`waiting-reflection-${i}`, "reflection");
    const result = await h.runner.runWorkerOnce(4, { priorityCohortOnly: true });
    expect(result).toMatchObject({ leased: 4, succeeded: 4 });
    expect(h.repos.runtime.getJob("waiting-reflection-0")!.status).toBe("succeeded");
    record("priority_cohort_refill", { limit: 4, leased: 4, otherRunnableInitially: 3 });
  });

  it("shares one execution boundary across two concurrent worker entry calls", async () => {
    const gate = deferred();
    let active = 0; let peak = 0;
    const h = harness(async () => { active++; peak = Math.max(peak, active); await gate.promise; active--; });
    for (let i = 0; i < 8; i++) h.job(`parallel-${i}`, "trace_summary");
    const a = h.runner.runWorkerOnce(4);
    const b = h.runner.runWorkerOnce(4);
    try {
      await flushWorker();
      expect(active).toBe(4); expect(peak).toBe(4);
      expect(h.repos.runtime.getJob("parallel-4")).toMatchObject({ status: "queued", attempts: 0, leaseToken: null });
    } finally { gate.resolve(); await Promise.all([a, b]); }
    expect(peak).toBe(4);
    record("multiple_entries_concurrency", { calls: 2, perCallLimit: 4, peakHandlers: peak });
  });

  it("starts the fifth summary while the first slow one is still running", async () => {
    const fast = deferred(); const slow = deferred();
    const started: string[] = [];
    let active = 0;
    const h = harness(async (j) => {
      started.push(j.id); active++;
      await (j.id === "summary-0" ? slow.promise : fast.promise);
      active--;
    });
    for (let i = 0; i < 8; i++) h.job(`summary-${i}`, "trace_summary");
    const run = h.runner.runWorkerOnce(8);
    try {
      await flushWorker();
      expect(started).toHaveLength(4);
      expect(h.repos.runtime.getJob("summary-4")!.status).toBe("queued");
      fast.resolve();
      await flushWorker();
      expect(active).toBe(1);
      expect(started).toHaveLength(8);
      expect(h.repos.runtime.getJob("summary-4")!.status).toBe("succeeded");
      record("summary_continuous_refill", { limit: 8, finished: 7, active: 1, unstartedButLeased: 0, fifthStarted: true });
    } finally { fast.resolve(); slow.resolve(); await run; }
    expect(started).toHaveLength(8);
  });

  it("renews only the active serial-scope job while waiting jobs stay unclaimed", async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch);
    const gate = deferred(); const started: string[] = [];
    const h = harness(async (j) => { started.push(j.id); if (j.id === "serial-0") await gate.promise; });
    for (let i = 0; i < 4; i++) h.job(`serial-${i}`, "reflection", { target: "shared-target" });
    const run = h.runner.runWorkerOnce(4);
    try {
      await flushWorker();
      expect(started).toEqual(["serial-0"]);
      expect(h.repos.runtime.getJob("serial-3")).toMatchObject({ status: "queued", attempts: 0, leaseToken: null });
      await vi.advanceTimersByTimeAsync(61_000);
      expect(h.repos.runtime.claimQueuedJob("serial-0")).toBeUndefined();
      expect(h.repos.runtime.getJob("serial-0")!.failureCount).toBe(0);
      record("serial_admission_renewal", { actualStarted: 1, leased: 1, waitingQueued: 3, elapsedClockSeconds: 61, reclaimableActive: 0 });
    } finally { gate.resolve(); await run; }
  });

  it("rejects an old failure after a newer lease has succeeded", () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(epoch);
    const h = harness(); h.job("stale-result", "reflection");
    const [a] = h.repos.runtime.leaseQueuedJobs(1);
    vi.setSystemTime(epoch + 61_000);
    const [b] = h.repos.runtime.leaseQueuedJobs(1);
    expect(a!.id).toBe(b!.id); expect(b!.leaseToken).not.toBe(a!.leaseToken);
    h.runner.completeLeasedWorkerJob(b!);
    expect(h.repos.runtime.getJob(b!.id)!.status).toBe("succeeded");
    h.runner.failLeasedWorkerJob(a!, new Error("late error from old execution"));
    expect(h.repos.runtime.getJob(b!.id)!.status).toBe("succeeded");
    record("stale_execution_overwrite", { newExecution: "succeeded", afterOldFailure: "succeeded", leaseGenerationGuard: true });
  });

  it("does not retry temporary failures before their backoff expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(epoch);
    const h = harness(async () => { throw new Error("temporary timeout"); });
    h.job("temporary-failure", "reflection");
    const attempts = [];
    for (let i = 0; i < 3; i++) {
      await h.runner.runWorkerOnce(1);
      attempts.push(h.repos.runtime.getJob("temporary-failure")!.attempts);
    }
    expect(attempts).toEqual([1, 1, 1]);
    expect(h.repos.runtime.getJob("temporary-failure")).toMatchObject({ status: "failed", failureCount: 1 });
    record("generic_failure_backoff", { attempts, clockAdvancedMs: 0, terminal: "failed" });
  });

  it("startup recovery preserves valid main and embedding retry leases", () => {
    const h = harness(); h.job("valid-main", "reflection");
    h.memory("valid-retry-target"); h.retry("valid-retry", "valid-retry-target");
    h.repos.runtime.leaseQueuedJobs(1, 600);
    h.repos.runtime.claimDueEmbeddingRetries({ now: Date.now(), workerId: "active-owner", leaseUntil: Date.now() + 600_000 });
    const result = h.runner.reconcileWorkerStartup(100);
    expect(result).toMatchObject({ requeuedJobs: 0, requeuedEmbeddingRetries: 0 });
    expect(h.repos.runtime.getJob("valid-main")!.status).toBe("leased");
    expect(h.repos.runtime.getEmbeddingRetry("valid-retry")!.status).toBe("in_progress");
    record("restart_valid_leases", { validMainLease: "leased", validRetryLease: "in_progress", remainingSecondsBeforeRecovery: 600 });
  });

  it("already rejects an obsolete embedding retry owner after a replacement claim (control)", () => {
    const h = harness(); h.memory("fenced-target"); h.retry("fenced-retry", "fenced-target");
    const now = Date.now();
    const [oldClaim] = h.repos.runtime.claimDueEmbeddingRetries({ now, workerId: "A", leaseUntil: now + 1_000 });
    h.repos.runtime.claimDueEmbeddingRetries({ now: now + 1_001, workerId: "B", leaseUntil: now + 60_000 });
    const oldCompletion = h.repos.runtime.markEmbeddingRetrySucceededClaimed("fenced-retry", {
      workerId: "A", leaseUntil: now + 1_000, leaseToken: oldClaim!.leaseToken!, now: now + 1_002
    });
    expect(oldCompletion).toBeUndefined();
    expect(h.repos.runtime.getEmbeddingRetry("fenced-retry")).toMatchObject({ status: "in_progress", claimedBy: "B" });
    record("embedding_existing_claim_guard", { staleCompletionRejected: true, currentOwner: "B" });
  });
});
