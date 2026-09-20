import { afterEach, describe, expect, it } from "vitest";
import { localCalendarDate } from "@memmy/agent-source-core";
import { DEFAULT_MEMMY_CONFIG } from "../../../src/config/index.js";
import { MEMORY_BYOK_BUDGET_KV_KEY } from "../../../src/service/memory-token-budget-ledger.js";
import { evolutionJobDedupeKey } from "../../../src/service/worker/job-handlers.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { accountRuntimeConfig, byokRuntimeConfig, createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const {
  cleanup: cleanupMemoryServiceFixture,
  createTestService
} = createMemoryServiceFixture();

afterEach(() => {
  cleanupMemoryServiceFixture();
});

describe("MemoryService / worker / runtime", () => {
  it.each([
    [{ repairId: "repair-1" }, "episode-1", "decision_repair:repair-1"],
    [{ feedbackId: "feedback-1" }, "episode-1", "decision_repair:feedback-1"],
    [{ repairId: "repair-1", feedbackId: "feedback-1" }, "episode-1", "decision_repair:repair-1"],
    [{ repairId: " ", feedbackId: "feedback-1" }, "episode-1", "decision_repair:feedback-1"],
    [{}, "episode-1", "decision_repair:episode-1"],
    [{}, undefined, undefined]
  ] as const)("deduplicates decision repair payload %j", (payload, episodeId, expected) => {
    expect(evolutionJobDedupeKey({ jobType: "decision_repair", payload, episodeId })).toBe(expected);
  });

  it("leases L3 World Model updates FIFO per field while allowing different fields in parallel", () => {
    const { db } = createTestService();
    const repos = new Repositories(db.db);
    const at = "2026-01-01T00:00:00.000Z";
    const insertFieldJob = (id: string, scopeKey: string, scopeSeq: number): void => {
      repos.l3WorldModels.insertImmutableJob({
        id,
        jobType: "l3_world_model_update",
        status: "queued",
        dedupeKey: `dedupe:${id}`,
        userId: "user-l3-fifo",
        scopeKey,
        scopeSeq,
        payload: { batchId: `batch:${scopeSeq}`, targetField: scopeKey },
        attempts: 0,
        maxAttempts: 3,
        createdAt: at,
        updatedAt: at
      });
    };
    insertFieldJob("contract-1", "project:contract", 1);
    insertFieldJob("contract-2", "project:contract", 2);
    insertFieldJob("knowledge-1", "project:knowledge", 1);

    const firstLease = repos.runtime.leaseQueuedJobs(10, 60);
    expect(firstLease.map((job) => job.id).sort()).toEqual(["contract-1", "knowledge-1"]);
    expect(repos.runtime.leaseQueuedJobs(10, 60)).toEqual([]);

    repos.runtime.completeJob("contract-1");
    expect(repos.runtime.leaseQueuedJobs(10, 60).map((job) => job.id)).toEqual(["contract-2"]);

    db.close();
  });

  it("keeps a later L3 field update blocked by failure and releases it after dead letter", () => {
    const { db } = createTestService();
    const repos = new Repositories(db.db);
    const at = "2026-01-01T00:00:00.000Z";
    for (const [id, scopeSeq, maxAttempts] of [
      ["field-1", 1, 2],
      ["field-2", 2, 3]
    ] as const) {
      repos.l3WorldModels.insertImmutableJob({
        id,
        jobType: "l3_world_model_update",
        status: "queued",
        dedupeKey: `dedupe:${id}`,
        userId: "user-l3-failure-fifo",
        scopeKey: "project:contract",
        scopeSeq,
        payload: { batchId: `batch:${scopeSeq}`, targetField: "project_contract" },
        attempts: 0,
        maxAttempts,
        createdAt: at,
        updatedAt: at
      });
    }

    expect(repos.runtime.leaseQueuedJobs(10, 60).map((job) => job.id)).toEqual(["field-1"]);
    expect(repos.runtime.failJob("field-1", "retry")?.status).toBe("failed");
    expect(repos.runtime.leaseQueuedJobs(10, 60)).toEqual([]);

    repos.runtime.requeueFailedJobs();
    expect(repos.runtime.leaseQueuedJobs(10, 60).map((job) => job.id)).toEqual(["field-1"]);
    expect(repos.runtime.failJob("field-1", "terminal")?.status).toBe("dead_letter");
    expect(repos.runtime.leaseQueuedJobs(10, 60).map((job) => job.id)).toEqual(["field-2"]);

    db.close();
  });

  it("selects the earliest worker wake across evolution and embedding queues", () => {
    const { db, service } = createTestService();
    const repos = new Repositories(db.db);
    const base = Date.now() + 60_000;
    repos.runtime.enqueueJob({
      id: "job-future-worker-wake",
      jobType: "reward",
      status: "queued",
      userId: "worker-wake-user",
      payload: { runAfter: new Date(base + 3_000).toISOString() },
      attempts: 0,
      maxAttempts: 3,
      createdAt: new Date(base).toISOString(),
      updatedAt: new Date(base).toISOString()
    });
    repos.runtime.enqueueEmbeddingRetry({
      id: "retry-pending-worker-wake",
      targetKind: "trace",
      targetId: "trace-pending-worker-wake",
      vectorField: "vec_summary",
      sourceText: "pending embedding wake",
      now: base + 2_000
    });
    const inProgress = repos.runtime.enqueueEmbeddingRetry({
      id: "retry-in-progress-worker-wake",
      targetKind: "trace",
      targetId: "trace-in-progress-worker-wake",
      vectorField: "vec_summary",
      sourceText: "in-progress embedding wake",
      now: base
    });
    db.db.prepare(
      `UPDATE embedding_retry_queue
       SET status = 'in_progress',
           claimed_by = 'previous-worker',
           lease_until = ?
       WHERE id = ?`
    ).run(base + 1_000, inProgress.id);

    expect(service.nextWorkerRunAt()).toBe(base + 1_000);

    db.close();
  });

  it("retries expired leased evolution jobs", async () => {
    const { db, service } = createTestService();
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-expired-job"
      }
    });
    const complete = service.completeTurn("turn-expired-job", {
      sessionId: session.sessionId,
      query: "recover an expired worker lease",
      answer: "the expired lease should be picked up by the next worker run"
    });
    const old = new Date(Date.now() - 120_000).toISOString();
    const jobId = "job_expired_lease";
    db.db.prepare(
      `INSERT INTO evolution_jobs (
        id, job_type, status, user_id, session_id, episode_id, target_memory_id,
        payload_json, attempts, max_attempts, leased_until, last_error, created_at, updated_at
      ) VALUES (?, 'reflection', 'leased', ?, ?, ?, ?, '{}', 1, 3, ?, NULL, ?, ?)`
    ).run(jobId, "user-expired-job", session.sessionId, complete.episodeId, complete.l1MemoryId, old, old, old);

    const run = await service.runWorkerOnce(10);
    expect(run.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        jobId,
        jobType: "reflection",
        status: "succeeded"
      })
    ]));
    const row = db.db.prepare(
      `SELECT status, attempts, leased_until
       FROM evolution_jobs
       WHERE id = ?`
    ).get(jobId) as {
      status: string;
      attempts: number;
      leased_until: string | null;
    };
    expect(row.status).toBe("succeeded");
    expect(row.attempts).toBe(2);
    expect(row.leased_until).toBeNull();

    db.close();
  });

  it("persists retryable worker failures before requeueing them on the next tick", async () => {
    const { db, service } = createTestService();
    const jobId = "job_retryable_failure";
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    db.db.prepare(
      `INSERT INTO evolution_jobs (
        id, job_type, status, user_id, session_id, episode_id, target_memory_id,
        payload_json, attempts, max_attempts, leased_until, last_error, created_at, updated_at
      ) VALUES (?, 'unsupported_job_type', 'queued', 'user-job-state', NULL, NULL, NULL, '{}', 0, 3, NULL, NULL, ?, ?)`
    ).run(jobId, createdAt, createdAt);

    const firstRun = await service.runWorkerOnce(1);
    expect(firstRun.jobs).toEqual([
      expect.objectContaining({
        jobId,
        status: "failed"
      })
    ]);
    const failedRow = db.db.prepare(
      `SELECT status, attempts, leased_until, last_error
       FROM evolution_jobs
       WHERE id = ?`
    ).get(jobId) as {
      status: string;
      attempts: number;
      leased_until: string | null;
      last_error: string | null;
    };
    expect(failedRow.status).toBe("failed");
    expect(failedRow.attempts).toBe(1);
    expect(failedRow.leased_until).toBeNull();
    expect(failedRow.last_error).toContain("unsupported job type");

    const secondRun = await service.runWorkerOnce(1);
    expect(secondRun.jobs).toEqual([
      expect.objectContaining({
        jobId,
        status: "failed"
      })
    ]);
    const retriedRow = db.db.prepare(
      `SELECT status, attempts, leased_until
       FROM evolution_jobs
       WHERE id = ?`
    ).get(jobId) as {
      status: string;
      attempts: number;
      leased_until: string | null;
    };
    expect(retriedRow.status).toBe("failed");
    expect(retriedRow.attempts).toBe(2);
    expect(retriedRow.leased_until).toBeNull();
    const ops = db.db.prepare(
      `SELECT op
       FROM memory_change_log
       WHERE entity_id = ?
       ORDER BY seq ASC`
    ).all(jobId) as Array<{ op: string }>;
    expect(ops.map((row) => row.op)).toEqual(["leased", "failed", "queued", "leased", "failed"]);

    db.close();
  });

  it("moves terminal worker failures to dead letter", async () => {
    const { db, service } = createTestService();
    const jobId = "job_terminal_failure";
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    db.db.prepare(
      `INSERT INTO evolution_jobs (
        id, job_type, status, user_id, session_id, episode_id, target_memory_id,
        payload_json, attempts, max_attempts, leased_until, last_error, created_at, updated_at
      ) VALUES (?, 'unsupported_job_type', 'queued', 'user-job-state', NULL, NULL, NULL, '{}', 0, 1, NULL, NULL, ?, ?)`
    ).run(jobId, createdAt, createdAt);

    const run = await service.runWorkerOnce(1);
    expect(run.jobs).toEqual([
      expect.objectContaining({
        jobId,
        status: "dead_letter"
      })
    ]);
    const row = db.db.prepare(
      `SELECT status, attempts, leased_until, last_error
       FROM evolution_jobs
       WHERE id = ?`
    ).get(jobId) as {
      status: string;
      attempts: number;
      leased_until: string | null;
      last_error: string | null;
    };
    expect(row.status).toBe("dead_letter");
    expect(row.attempts).toBe(1);
    expect(row.leased_until).toBeNull();
    expect(row.last_error).toContain("unsupported job type");

    const ops = db.db.prepare(
      `SELECT op
       FROM memory_change_log
       WHERE entity_id = ?
       ORDER BY seq ASC`
    ).all(jobId) as Array<{ op: string }>;
    expect(ops.map((change) => change.op)).toEqual(["leased", "dead_letter"]);

    db.close();
  });

  it("leases idle close while a memory token budget pause holds budgeted jobs", async () => {
    const { db, service } = createTestService({
      config: byokRuntimeConfig({
        tokenBudget: { dailyLimitM: 1, totalLimitM: 500 }
      })
    });
    const repos = new Repositories(db.db);
    const at = new Date().toISOString();
    repos.runtime.setKv(MEMORY_BYOK_BUDGET_KV_KEY, {
      dailyUsed: 1_000_000,
      lifetimeUsed: 1_000_000,
      dailyDate: localCalendarDate()
    });
    expect(service.memoryTokenBudgetSnapshot()).toMatchObject({ paused: true, trigger: "daily" });
    repos.runtime.enqueueJob({
      id: "job-paused-reflection",
      jobType: "reflection",
      status: "queued",
      userId: "budget-user",
      payload: {},
      attempts: 0,
      maxAttempts: 3,
      createdAt: at,
      updatedAt: at
    });
    repos.runtime.enqueueJob({
      id: "job-paused-idle-close",
      jobType: "episode_idle_close",
      status: "queued",
      userId: "budget-user",
      payload: {},
      attempts: 0,
      maxAttempts: 3,
      createdAt: at,
      updatedAt: at
    });

    const run = await service.runWorkerOnce(10);
    expect(run.jobs.map((job) => job.jobId)).toEqual(["job-paused-idle-close"]);
    expect(repos.runtime.getJob("job-paused-reflection")).toMatchObject({
      status: "queued",
      attempts: 0
    });

    db.close();
  });

  it("does not wake for expired budgeted jobs while paused", () => {
    const { db, service } = createTestService({
      config: byokRuntimeConfig({
        tokenBudget: { dailyLimitM: 1, totalLimitM: 500 }
      })
    });
    const repos = new Repositories(db.db);
    const now = Date.now();
    repos.runtime.setKv(MEMORY_BYOK_BUDGET_KV_KEY, {
      dailyUsed: 1_000_000,
      lifetimeUsed: 1_000_000,
      dailyDate: localCalendarDate()
    });
    repos.runtime.enqueueJob({
      id: "job-expired-reward",
      jobType: "reward",
      status: "queued",
      userId: "budget-user",
      payload: { runAfter: new Date(now - 5_000).toISOString() },
      attempts: 0,
      maxAttempts: 3,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString()
    });
    const idleAt = now + 8_000;
    repos.runtime.enqueueJob({
      id: "job-idle-close-later",
      jobType: "episode_idle_close",
      status: "queued",
      userId: "budget-user",
      payload: { runAfter: new Date(idleAt).toISOString() },
      attempts: 0,
      maxAttempts: 3,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString()
    });

    expect(service.nextWorkerRunAt()).toBe(idleAt);

    db.close();
  });

  it("keeps platform and local embedding jobs runnable after a BYOK pause", async () => {
    const { db, service } = createTestService({
      config: {
        ...accountRuntimeConfig(),
        tokenBudget: { dailyLimitM: 1, totalLimitM: 500 },
        embedding: {
          ...DEFAULT_MEMMY_CONFIG.embedding,
          mode: "local"
        }
      }
    });
    const repos = new Repositories(db.db);
    const at = new Date().toISOString();
    repos.runtime.setKv(MEMORY_BYOK_BUDGET_KV_KEY, {
      dailyUsed: 1_000_000,
      lifetimeUsed: 1_000_000,
      dailyDate: localCalendarDate()
    });
    repos.runtime.enqueueJob({
      id: "job-platform-reflection",
      jobType: "reflection",
      status: "queued",
      userId: "budget-user",
      payload: {},
      attempts: 0,
      maxAttempts: 3,
      createdAt: at,
      updatedAt: at
    });
    repos.runtime.enqueueJob({
      id: "job-local-embedding",
      jobType: "embedding",
      status: "queued",
      userId: "budget-user",
      payload: {},
      attempts: 0,
      maxAttempts: 3,
      createdAt: at,
      updatedAt: at
    });

    const run = await service.runWorkerOnce(10);
    expect(run.jobs.map((job) => job.jobId).sort()).toEqual([
      "job-local-embedding",
      "job-platform-reflection"
    ]);

    db.close();
  });

  it("holds only BYOK roles in a mixed model configuration", async () => {
    const { db, service } = createTestService({
      config: byokRuntimeConfig({
        tokenBudget: { dailyLimitM: 1, totalLimitM: 500 },
        evolution: accountRuntimeConfig().evolution,
        embedding: DEFAULT_MEMMY_CONFIG.embedding
      })
    });
    const repos = new Repositories(db.db);
    const at = new Date().toISOString();
    repos.runtime.setKv(MEMORY_BYOK_BUDGET_KV_KEY, {
      dailyUsed: 1_000_000,
      lifetimeUsed: 1_000_000,
      dailyDate: localCalendarDate()
    });
    repos.runtime.enqueueJob({
      id: "job-mixed-title",
      jobType: "episode_title",
      status: "queued",
      userId: "budget-user",
      payload: {},
      attempts: 0,
      maxAttempts: 3,
      createdAt: at,
      updatedAt: at
    });
    repos.runtime.enqueueJob({
      id: "job-mixed-reflection",
      jobType: "reflection",
      status: "queued",
      userId: "budget-user",
      payload: {},
      attempts: 0,
      maxAttempts: 3,
      createdAt: at,
      updatedAt: at
    });
    repos.runtime.enqueueJob({
      id: "job-mixed-embedding",
      jobType: "embedding",
      status: "queued",
      userId: "budget-user",
      payload: {},
      attempts: 0,
      maxAttempts: 3,
      createdAt: at,
      updatedAt: at
    });
    repos.runtime.enqueueJob({
      id: "job-mixed-work-memory",
      jobType: "work_memory_extract",
      status: "queued",
      userId: "budget-user",
      payload: {},
      attempts: 0,
      maxAttempts: 3,
      createdAt: at,
      updatedAt: at
    });

    const run = await service.runWorkerOnce(10);
    expect(run.jobs.map((job) => job.jobId)).toEqual([
      "job-mixed-embedding"
    ]);
    expect(repos.runtime.getJob("job-mixed-title")).toMatchObject({
      status: "queued",
      attempts: 0
    });
    expect(repos.runtime.getJob("job-mixed-reflection")).toMatchObject({
      status: "queued",
      attempts: 0
    });
    expect(repos.runtime.getJob("job-mixed-work-memory")).toMatchObject({
      status: "queued",
      attempts: 0
    });

    db.close();
  });
});
