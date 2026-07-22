import { afterEach, describe, expect, it } from "vitest";
import { Repositories } from "../../../src/storage/repositories.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const {
  cleanup: cleanupMemoryServiceFixture,
  createTestService
} = createMemoryServiceFixture();

afterEach(() => {
  cleanupMemoryServiceFixture();
});

describe("MemoryService / worker / runtime", () => {
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
});
