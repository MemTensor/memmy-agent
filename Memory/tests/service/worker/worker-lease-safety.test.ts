import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelHttpError } from "../../../src/model/http.js";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories, type EvolutionJobRecord } from "../../../src/storage/repositories.js";
import { WorkerConcurrencyController } from "../../../src/service/worker/worker-concurrency.js";
import { WorkerRunner, type WorkerRunnerDeps } from "../../../src/service/worker/worker-runner.js";
import { classifyProcessingError } from "../../../src/service/worker/job-handlers.js";
import { createCapturingEmbedder } from "../../fixtures/memory-service-fixture.js";

const resources: Array<{ root: string; db: MemoryDb }> = [];
const epoch = Date.parse("2026-10-22T00:00:00.000Z");

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Real SQLite and worker lifecycle; only model/business work is substituted. */
function harness(processJob: WorkerRunnerDeps["jobHandlers"]["processJob"] = async () => {}, concurrency?: WorkerConcurrencyController) {
  const root = mkdtempSync(join(tmpdir(), "memmy-lease-safety-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  resources.push({ root, db });
  const repos = new Repositories(db.db);
  const deps: WorkerRunnerDeps = {
    repos, concurrency,
    embedder: createCapturingEmbedder([]),
    capture: { embedAfterCapture: true },
    embeddingRetryWorkerId: "lease-safety-runner",
    memoryAddEnabled: () => true,
    memoryBudgetPaused: () => false,
    memoryBudgetJobConsumes: () => false,
    memoryBudgetModelSources: () => ({ embedding: { mode: "local" } }),
    memoryBudgetNextWakeAtMs: () => Date.now(),
    summaryModelConfigured: () => true,
    nowIso: () => new Date().toISOString(),
    encodeChangeCursor: String,
    namespaceIdFromMemory: () => "lease-safety",
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
      prepareEmbeddingJob: () => { throw new Error("unexpected main embedding"); },
      applyEmbeddingVector: () => {},
      persistEmbeddingVector: (input) => {
        const target = repos.memories.get(input.memoryId);
        if (!target) throw new Error("missing synthetic target");
        input.finalize?.(target, false, new Date().toISOString());
        return target;
      },
      enqueueEmbeddingRetryAfterFailure: () => false
    }
  };
  const runner = new WorkerRunner(deps);
  function job(id: string, jobType: EvolutionJobRecord["jobType"] = "reflection"): void {
    const at = new Date().toISOString();
    repos.runtime.enqueueJob({
      id, jobType, status: "queued", userId: "lease-safety-user", payload: {},
      attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at
    });
  }
  function retry(id: string): void {
    const at = new Date().toISOString();
    db.db.prepare(`INSERT INTO memories
      (id, timeline, user_id, memory_value, memory_layer, created_at, updated_at)
      VALUES (?, ?, 'lease-safety-user', 'retry text', 'L1', ?, ?)`)
      .run(id, at, at, at);
    repos.runtime.enqueueEmbeddingRetry({
      id, targetKind: "trace", targetId: id, vectorField: "vec_summary", sourceText: "retry text", now: Date.now()
    });
  }
  return { db, repos, runner, job, retry, deps };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const { root, db } of resources.splice(0)) {
    if (db.db.open) db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

describe("worker lease ownership and recovery", () => {
  it("rejects old completion and failure after a replacement lease succeeds", () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(epoch);
    const h = harness(); h.job("replacement");
    const [a] = h.repos.runtime.leaseQueuedJobs(1);
    vi.setSystemTime(epoch + 61_000);
    const [b] = h.repos.runtime.leaseQueuedJobs(1);
    expect(a!.leaseToken).toBeTruthy();
    expect(b!.leaseToken).not.toBe(a!.leaseToken);
    const at = new Date().toISOString();
    expect(h.repos.runtime.completeJob(b!.id, at, b)!.status).toBe("succeeded");
    expect(h.repos.runtime.completeJob(a!.id, at, a)).toBeUndefined();
    expect(h.repos.runtime.failJob(a!.id, "late failure", at, false, a)).toBeUndefined();
    expect(h.repos.runtime.getJob(a!.id)).toMatchObject({ status: "succeeded", failureCount: 0 });
  });

  it("rejects writes and renewal from an expired lease even before anyone reclaims it", () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(epoch);
    const h = harness(); h.job("expired");
    const [a] = h.repos.runtime.leaseQueuedJobs(1);
    vi.setSystemTime(epoch + 60_001);
    const at = new Date().toISOString();
    expect(h.repos.runtime.isJobLeaseHeld(a!, at)).toBe(false);
    expect(h.repos.runtime.completeJob(a!.id, at, a)).toBeUndefined();
    expect(h.repos.runtime.failJob(a!.id, "late failure", at, false, a)).toBeUndefined();
    h.repos.runtime.renewJobLease(a!, 60, at);
    expect(h.repos.runtime.isJobLeaseHeld(a!, at)).toBe(false);
    expect(h.repos.runtime.getJob(a!.id)).toMatchObject({ status: "leased", failureCount: 0 });
  });

  it("does not let legacy id-only completion or failure bypass a current lease", () => {
    const h = harness(); h.job("requires-claim");
    const [claim] = h.repos.runtime.leaseQueuedJobs(1);
    expect(h.repos.runtime.completeJob(claim!.id)).toBeUndefined();
    expect(h.repos.runtime.failJob(claim!.id, "without lease credentials")).toBeUndefined();
    expect(h.repos.runtime.getJob(claim!.id)).toMatchObject({ status: "leased", leaseToken: claim!.leaseToken });
  });

  it("renews active work while capacity-blocked tasks remain queued without lease tokens", async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch);
    const gate = deferred(), entered = deferred(); const started: string[] = [];
    const h = harness(async (job) => {
      started.push(job.id);
      if (job.id === "serial-0") { entered.resolve(); await gate.promise; }
    }, new WorkerConcurrencyController({ maxActiveJobs: 1 }, {}));
    for (let i = 0; i < 4; i++) h.job(`serial-${i}`);
    const run = h.runner.runWorkerOnce(4);
    await entered.promise;
    try {
      const initial = h.repos.runtime.getJob("serial-0")!;
      await vi.advanceTimersByTimeAsync(125_000);
      expect(started).toEqual(["serial-0"]);
      const active = h.repos.runtime.getJob("serial-0")!;
      expect(active).toMatchObject({ status: "leased", leaseToken: initial.leaseToken });
      expect(Date.parse(active.leasedUntil!)).toBeGreaterThan(Date.now());
      expect(h.repos.runtime.claimQueuedJob("serial-0", { owner: "competing-worker" })).toBeUndefined();
      for (let i = 1; i < 4; i++) {
        expect(h.repos.runtime.getJob(`serial-${i}`)).toMatchObject({ status: "queued", attempts: 0,
          leaseToken: null, leasedUntil: null, leaseOwner: null });
      }
    } finally { gate.resolve(); await run; }
    expect(started).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.repos.runtime.getJob("serial-0")).toMatchObject({ status: "succeeded", failureCount: 0 });
  });
  it("clears its heartbeat after a handler fails", async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch);
    const gate = deferred();
    const h = harness(async () => { await gate.promise; throw new Error("temporary timeout"); });
    h.job("fails-after-renewal");
    const run = h.runner.runWorkerOnce(1);
    await vi.advanceTimersByTimeAsync(65_000);
    gate.resolve();
    const result = await run;
    expect(result.failed).toBe(1);
    expect(h.repos.runtime.getJob("fails-after-renewal")).toMatchObject({ status: "failed", failureCount: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps concurrent calls isolated when one call finishes before the other", async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch);
    const a = deferred(); const b = deferred(); const started: string[] = [];
    const h = harness(async (j) => { started.push(j.id); await (j.id === "A" ? a.promise : b.promise); });
    h.job("A"); h.job("B");
    const runA = h.runner.runWorkerOnce(1);
    const runB = h.runner.runWorkerOnce(1);
    try {
      await vi.advanceTimersByTimeAsync(45_000);
      a.resolve(); await runA;
      await vi.advanceTimersByTimeAsync(85_000);
      expect(started.sort()).toEqual(["A", "B"]);
      expect(h.repos.runtime.getJob("A")!.status).toBe("succeeded");
      const pending = h.repos.runtime.getJob("B")!;
      expect(pending.status).toBe("leased");
      expect(Date.parse(pending.leasedUntil!)).toBeGreaterThan(Date.now());
      expect(h.repos.runtime.leaseQueuedJobs(1)).toEqual([]);
    } finally { a.resolve(); b.resolve(); await Promise.all([runA, runB]); }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renews an embedding retry during a request lasting beyond its original five minute lease", async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch);
    const gate = deferred();
    const h = harness();
    const at = new Date().toISOString();
    h.db.db.prepare(`INSERT INTO memories
      (id, timeline, user_id, memory_value, memory_layer, created_at, updated_at)
      VALUES ('retry-target', ?, 'lease-safety-user', 'retry text', 'L1', ?, ?)`)
      .run(at, at, at);
    h.repos.runtime.enqueueEmbeddingRetry({
      id: "long-retry", targetKind: "trace", targetId: "retry-target", vectorField: "vec_summary",
      sourceText: "retry text", now: epoch
    });
    h.deps.embedder.embed = async (texts) => { await gate.promise; return texts.map(() => [1, 0, 0]); };
    const run = h.runner.runEmbeddingRetryOnce(1);
    try {
      await vi.advanceTimersByTimeAsync(310_000);
      const retry = h.repos.runtime.getEmbeddingRetry("long-retry")!;
      expect(retry.status).toBe("in_progress");
      expect(retry.leaseUntil).toBeGreaterThan(Date.now());
      expect(h.repos.runtime.claimDueEmbeddingRetries({
        now: Date.now(), workerId: "competing-runner", leaseUntil: Date.now() + 60_000, limit: 1
      })).toEqual([]);
    } finally { gate.resolve(); await run; }
    expect(h.repos.runtime.getEmbeddingRetry("long-retry")!.status).toBe("succeeded");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats lost ownership as recovery, not a successful job or a business failure", async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch);
    const gate = deferred();
    const h = harness(async () => { await gate.promise; }); h.job("lost");
    const renew = vi.spyOn(h.repos.runtime, "renewJobLease");
    const run = h.runner.runWorkerOnce(1);
    await Promise.resolve();
    h.db.db.prepare(`UPDATE evolution_jobs
      SET lease_owner='replacement-owner', lease_token='replacement-token'
      WHERE id='lost'`).run();
    gate.resolve();
    const result = await run;
    expect(result).toMatchObject({ succeeded: 0, failed: 0 });
    expect(h.repos.runtime.getJob("lost")).toMatchObject({
      status: "leased", leaseOwner: "replacement-owner", leaseToken: "replacement-token", failureCount: 0
    });
    const renewalCalls = renew.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(renew).toHaveBeenCalledTimes(renewalCalls);
  });

  it("preserves valid startup leases and recovers only expired main and retry leases", () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(epoch);
    const h = harness(); h.job("valid-main");
    const [valid] = h.repos.runtime.leaseQueuedJobs(1, 600);
    h.job("expired-main");
    h.repos.runtime.leaseQueuedJobs(1, 60);
    for (const id of ["valid-retry", "expired-retry"]) h.repos.runtime.enqueueEmbeddingRetry({
      id, targetKind: "trace", targetId: id, vectorField: "vec_summary", sourceText: id, now: epoch
    });
    h.repos.runtime.claimDueEmbeddingRetries({
      now: epoch, workerId: "valid", leaseUntil: epoch + 600_000, targetMemoryIds: ["valid-retry"]
    });
    h.repos.runtime.claimDueEmbeddingRetries({
      now: epoch, workerId: "expired", leaseUntil: epoch + 60_000, targetMemoryIds: ["expired-retry"]
    });
    vi.setSystemTime(epoch + 61_000);
    const recovered = h.runner.reconcileWorkerStartup(100);
    expect(recovered).toMatchObject({ requeuedJobs: 1, requeuedEmbeddingRetries: 1 });
    expect(h.repos.runtime.getJob("valid-main")).toMatchObject({
      status: "leased", leaseToken: valid!.leaseToken, failureCount: 0
    });
    expect(h.repos.runtime.getJob("expired-main")).toMatchObject({
      status: "queued", failureCount: 0, leaseRecoveryCount: 1
    });
    expect(h.repos.runtime.getEmbeddingRetry("valid-retry")!.status).toBe("in_progress");
    expect(h.repos.runtime.getEmbeddingRetry("expired-retry")!.status).toBe("pending");
    const [again] = h.repos.runtime.leaseQueuedJobs(1);
    expect(again).toMatchObject({ id: "expired-main", failureCount: 0, leaseCount: 2, leaseRecoveryCount: 1 });
  });
});

describe("worker business failure policy", () => {
  it.each([408, 429, 500, 503])("backs off HTTP %s even when its response mentions an API key", async httpStatus => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(epoch);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    let calls = 0;
    const h = harness(async () => {
      if (++calls === 1) throw new ModelHttpError("provider request failed", "test", httpStatus,
        "temporary_provider_error", "Temporary API key service limit; please retry shortly");
    });
    h.deps.configurationFingerprint = () => "unchanged-config";
    h.job("transient-key-response", "trace_summary");
    expect(await h.runner.runWorkerOnce(1)).toMatchObject({ leased: 1, failed: 1 });
    const failed = h.repos.runtime.getJob("transient-key-response")!;
    expect(failed).toMatchObject({ status: "failed", blockedReason: null, failureCount: 1 });
    expect(Date.parse(failed.availableAt!)).toBe(epoch + 5_000);
    expect(h.runner.nextWorkerRunAt()).toBe(epoch + 5_000);
    vi.setSystemTime(epoch + 4_999);
    expect((await h.runner.runWorkerOnce(1)).leased).toBe(0);
    vi.setSystemTime(epoch + 5_000);
    expect(await h.runner.runWorkerOnce(1)).toMatchObject({ leased: 1, succeeded: 1, failed: 0 });
    expect(calls).toBe(2);
  });

  it.each([
    [401, "invalid API key", "model_configuration", "open_settings"],
    [400, "invalid request body", "invalid_model_request", "none"],
    [400, "maximum context length exceeded", "model_input_too_long", "none"]
  ] as const)("preserves the HTTP %s classification for %s", (status, detail, code, retryAction) => {
    expect(classifyProcessingError(new ModelHttpError("provider request failed", "test", status, undefined, detail)))
      .toEqual({ code, retryAction });
  });

  it("keeps an explicit missing-model configuration error waiting for configuration", () => {
    expect(classifyProcessingError(new Error("model is not configured: missing API key")))
      .toEqual({ code: "model_configuration", retryAction: "open_settings" });
  });

  it("preserves the explicit 40309 business error before retryable HTTP status classification", () => {
    expect(classifyProcessingError(new ModelHttpError("provider request failed", "test", 429, "40309", "API key quota exhausted")))
      .toEqual({ code: "40309", retryAction: "open_settings" });
  });

  it("does not apply a transient HTTP failure after the execution loses its lease", async () => {
    const h = harness(async job => {
      h.db.db.prepare("UPDATE evolution_jobs SET lease_owner='replacement', lease_token='replacement-token' WHERE id=?")
        .run(job.id);
      throw new ModelHttpError("provider request failed", "test", 429, undefined, "Temporary API key rate limit");
    });
    h.job("lost-before-http-failure");
    expect(await h.runner.runWorkerOnce(1)).toMatchObject({ leased: 1, succeeded: 0, failed: 0 });
    expect(h.repos.runtime.getJob("lost-before-http-failure")).toMatchObject({ status: "leased",
      leaseOwner: "replacement", leaseToken: "replacement-token", failureCount: 0, availableAt: null, blockedReason: null });
  });

  it("schedules a temporary failure, skips early retries, then runs it when due", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(epoch);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    let calls = 0;
    const h = harness(async () => { if (++calls === 1) throw new Error("temporary timeout"); });
    h.job("retry-later");
    const first = await h.runner.runWorkerOnce(1);
    expect(first.failed).toBe(1);
    const failed = h.repos.runtime.getJob("retry-later")!;
    expect(failed).toMatchObject({ status: "failed", failureCount: 1 });
    const available = Date.parse(failed.availableAt!);
    expect(available - epoch).toBeGreaterThanOrEqual(4_000);
    expect(available - epoch).toBeLessThanOrEqual(6_000);
    expect(h.runner.nextWorkerRunAt()).toBe(available);
    vi.setSystemTime(available - 1);
    expect((await h.runner.runWorkerOnce(1)).leased).toBe(0);
    expect(calls).toBe(1);
    vi.setSystemTime(available);
    expect(await h.runner.runWorkerOnce(1)).toMatchObject({ leased: 1, succeeded: 1, failed: 0 });
    expect(h.repos.runtime.getJob("retry-later")).toMatchObject({ status: "succeeded", failureCount: 1, leaseCount: 2 });
  });

  it("counts temporary business failures separately from lease recoveries", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(epoch);
    const h = harness(async () => { throw new Error("temporary timeout"); });
    h.job("eventual-dead-letter");
    for (let i = 1; i <= 3; i++) {
      await h.runner.runWorkerOnce(1);
      const row = h.repos.runtime.getJob("eventual-dead-letter")!;
      expect(row.failureCount).toBe(i);
      if (i < 3) {
        expect(row.status).toBe("failed");
        vi.setSystemTime(Date.parse(row.availableAt!));
      } else {
        expect(row.status).toBe("dead_letter");
      }
    }
  });

  it("holds configuration failures without burning business failure budget", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(epoch);
    let calls = 0;
    const h = harness(async () => { calls++; throw new Error("model is not configured: missing API key"); });
    h.job("config-blocked", "trace_summary");
    await h.runner.runWorkerOnce(1);
    expect(h.repos.runtime.getJob("config-blocked")).toMatchObject({
      status: "failed", blockedReason: "configuration", failureCount: 0
    });
    vi.setSystemTime(epoch + 3_600_000);
    expect((await h.runner.runWorkerOnce(1)).leased).toBe(0);
    expect(calls).toBe(1);
  });

  it("resumes the original blocked job when the model configuration changes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(epoch);
    let valid = false;
    let fingerprint = "before";
    const h = harness(async () => { if (!valid) throw new Error("unauthorized API key"); });
    h.deps.configurationFingerprint = () => fingerprint;
    h.job("config-restored", "trace_summary");
    await h.runner.runWorkerOnce(1);
    expect(h.repos.runtime.getJob("config-restored")).toMatchObject({ blockedReason: "configuration", failureCount: 0 });
    valid = true; fingerprint = "after";
    expect(await h.runner.runWorkerOnce(1)).toMatchObject({ leased: 1, succeeded: 1, failed: 0 });
    expect(h.repos.runtime.getJob("config-restored")).toMatchObject({
      id: "config-restored", status: "succeeded", failureCount: 0, blockedReason: null
    });
  });

  it("dead-letters permanent invalid input immediately", async () => {
    const h = harness(async () => {
      throw new ModelHttpError("bad input", "test", 400, undefined, "invalid request body");
    });
    h.job("permanent", "trace_summary");
    const result = await h.runner.runWorkerOnce(1);
    expect(result).toMatchObject({ succeeded: 0, failed: 1 });
    expect(h.repos.runtime.getJob("permanent")).toMatchObject({ status: "dead_letter", failureCount: 1 });
    expect((await h.runner.runWorkerOnce(1)).leased).toBe(0);
  });
});

describe("embedding retry configuration recovery", () => {
  it.each([429, 503])("retries HTTP %s embedding failures mentioning API keys without waiting for configuration", async httpStatus => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(epoch);
    const h = harness(); h.retry("transient-key-retry");
    let calls = 0;
    h.deps.embedder.embed = async texts => {
      if (++calls === 1) throw new ModelHttpError("provider request failed", "test", httpStatus, undefined,
        "Temporary API key service limit; please retry shortly");
      return texts.map(() => [1, 0, 0]);
    };
    h.deps.configurationFingerprint = () => "unchanged-config";
    expect((await h.runner.runWorkerOnce(1)).embeddingRetries).toMatchObject({ leased: 1, failed: 1 });
    const retry = h.repos.runtime.getEmbeddingRetry("transient-key-retry")!;
    expect(retry).toMatchObject({ status: "pending", attempts: 1, blockedReason: null });
    expect(retry.nextAttemptAt).toBeGreaterThan(epoch);
    vi.setSystemTime(retry.nextAttemptAt);
    expect((await h.runner.runWorkerOnce(1)).embeddingRetries).toMatchObject({ leased: 1, succeeded: 1, failed: 0 });
    expect(calls).toBe(2);
  });

  it("holds unauthorized embedding retries without consuming their failure budget", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(epoch);
    const h = harness(); h.retry("unauthorized-retry");
    let requests = 0;
    h.deps.embedder.embed = async () => {
      requests++;
      throw new ModelHttpError("unauthorized", "test", 401, undefined, "invalid API key");
    };
    h.deps.configurationFingerprint = () => "same-config";
    await h.runner.runWorkerOnce(4);
    expect(h.repos.runtime.getEmbeddingRetry("unauthorized-retry")).toMatchObject({
      status: "failed", blockedReason: "configuration", attempts: 0
    });
    vi.setSystemTime(epoch + 3_600_000);
    const held = await h.runner.runWorkerOnce(4);
    expect(held.embeddingRetries.leased).toBe(0);
    expect(requests).toBe(1);
  });

  it("resumes the same embedding retry only after the configuration fingerprint changes", async () => {
    const h = harness(); h.retry("configuration-restored-retry");
    let valid = false; let fingerprint = "invalid";
    h.deps.configurationFingerprint = () => fingerprint;
    h.deps.embedder.embed = async (texts) => {
      if (!valid) throw new ModelHttpError("unauthorized", "test", 401, undefined, "invalid API key");
      return texts.map(() => [1, 0, 0]);
    };
    await h.runner.runWorkerOnce(4);
    expect(h.repos.runtime.getEmbeddingRetry("configuration-restored-retry")).toMatchObject({
      blockedReason: "configuration", attempts: 0
    });
    valid = true;
    expect((await h.runner.runWorkerOnce(4)).embeddingRetries.leased).toBe(0);
    fingerprint = "valid";
    const resumed = await h.runner.runWorkerOnce(4);
    expect(resumed.embeddingRetries).toMatchObject({ leased: 1, succeeded: 1, failed: 0 });
    expect(h.repos.runtime.getEmbeddingRetry("configuration-restored-retry")).toMatchObject({
      id: "configuration-restored-retry", status: "succeeded", blockedReason: null, attempts: 0
    });
  });

  it("does not revive permanently invalid embedding input on configuration changes or restart", async () => {
    const h = harness(); h.retry("invalid-input-retry");
    let fingerprint = "before";
    h.deps.configurationFingerprint = () => fingerprint;
    h.deps.embedder.embed = async () => {
      throw new ModelHttpError("invalid input", "test", 400, undefined, "invalid request body");
    };
    await h.runner.runWorkerOnce(4);
    expect(h.repos.runtime.getEmbeddingRetry("invalid-input-retry")).toMatchObject({
      status: "failed", attempts: 1
    });
    fingerprint = "after";
    expect((await h.runner.runWorkerOnce(4)).embeddingRetries.leased).toBe(0);
    expect(h.runner.reconcileWorkerStartup(100).requeuedEmbeddingRetries).toBe(0);
    expect(h.repos.runtime.getEmbeddingRetry("invalid-input-retry")).toMatchObject({ status: "failed", attempts: 1 });
  });
});

describe("in-flight main-job configuration changes", () => {
  it("does not resume another job that failed under the current configuration", async () => {
    const gate = deferred();
    let fingerprint = "config-A";
    const h = harness(async (job) => {
      if (job.id === "old-config-job") {
        // Requests may still overlap inside one admitted parallel batch. The
        // second item starts after the configuration change, under config B.
        fingerprint = "config-B";
        h.runner.resumeJobsAfterConfigurationChange();
        await gate.promise;
      }
      throw new Error("unauthorized API key");
    });
    h.deps.configurationFingerprint = () => fingerprint;
    h.job("old-config-job", "trace_summary");
    h.job("current-config-job", "trace_summary");
    const run = h.runner.runWorkerOnce(2);
    try {
      await vi.waitFor(() => expect(h.repos.runtime.getJob("current-config-job"))
        .toMatchObject({ status: "failed", blockedReason: "configuration" }));
    } finally { gate.resolve(); await run; }
    expect(h.repos.runtime.getJob("old-config-job")).toMatchObject({ status: "queued", blockedReason: null });
    expect(h.repos.runtime.getJob("current-config-job")).toMatchObject({ status: "failed", blockedReason: "configuration" });
  });
});

describe("in-flight embedding configuration changes", () => {
  it("requeues a late old-config failure once and holds failures from the current config", async () => {
    const h = harness(); h.retry("old-config-retry");
    let fingerprint = "config-A";
    h.deps.configurationFingerprint = () => fingerprint;
    const gate = deferred(); const entered = deferred(); let calls = 0;
    h.deps.embedder.embed = async () => {
      calls++;
      if (calls === 1) { entered.resolve(); await gate.promise; }
      throw new ModelHttpError("unauthorized", "test", 401, undefined, "invalid API key");
    };
    const oldRun = h.runner.runWorkerOnce(1);
    await entered.promise;
    fingerprint = "config-B";
    h.runner.resumeJobsAfterConfigurationChange();
    gate.resolve(); await oldRun;
    expect(h.repos.runtime.getEmbeddingRetry("old-config-retry")).toMatchObject({ status: "pending", blockedReason: null, attempts: 0 });
    expect((await h.runner.runWorkerOnce(4)).embeddingRetries.leased).toBe(1);
    expect(h.repos.runtime.getEmbeddingRetry("old-config-retry")).toMatchObject({ status: "failed", blockedReason: "configuration", attempts: 0 });
    expect((await h.runner.runWorkerOnce(4)).embeddingRetries.leased).toBe(0);
    expect(calls).toBe(2);
  });
});
