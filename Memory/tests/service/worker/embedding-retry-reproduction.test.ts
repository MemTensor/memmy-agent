import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryHttpServer, type MemoryRow } from "../../../src/index.js";
import { closeMemoryHttpServer } from "../../../src/server/http.js";
import { embeddingTextForMemory, updateMemoryVectorField } from "../../../src/service/embedding/embedding-pipeline.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { createCapturingEmbedder, createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService, createTestRoot } = createMemoryServiceFixture();
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

function traceMemory(id: string): MemoryRow {
  const at = "2026-10-01T00:00:00.000Z";
  return {
    id, timeline: at, userId: "local-user", memoryType: "TraceMemory",
    status: "activated", visibility: "private", memoryKey: id,
    memoryValue: "synthetic regression text", tags: [], info: {},
    properties: { internal_info: { memory_layer: "L1" } }, memoryLayer: "L1",
    version: 1, createdAt: at, updatedAt: at
  };
}

describe("v1.2.6 embedding retry reproduction", () => {
  it("repairs old dimensions even when they outnumber vectors from the current model", async () => {
    const { db, service } = createTestService();
    const repos = new Repositories(db.db);
    for (let index = 0; index < 3; index += 1) {
      const memory = traceMemory(`dimension-${index}`);
      repos.memories.insert(updateMemoryVectorField(memory, "vec_summary", index < 2 ? [1, 0] : [1, 0, 0], {
        provider: "local", model: index < 2 ? "old-model" : "capturing-test-embedding", updatedAt: memory.updatedAt
      }));
    }
    expect(await service.embeddingMaintenanceStats()).toMatchObject({
      dimension: 3, ready: 1, modelMismatch: 2, needsRepair: 2
    });
    expect(await service.rebuildEmbeddings("repair")).toMatchObject({ enqueued: 2 });
    expect(db.db.prepare("SELECT target_id FROM embedding_retry_queue ORDER BY target_id").all())
      .toEqual([{ target_id: "dimension-0" }, { target_id: "dimension-1" }]);
  });

  it("includes user-memory work in progress and failure counts", async () => {
    const { db, service } = createTestService();
    const repos = new Repositories(db.db);
    const at = "2026-10-01T00:00:00.000Z";
    repos.userMemories.insert({
      id: "queue-user-memory", sourceTurnId: "queue-turn", userId: "local-user",
      memoryTypes: [], content: "synthetic user memory", normalizedUserTextHash: "queue-hash",
      sourceTurnRefs: [], status: "active", createdAt: at, updatedAt: at
    });
    expect(await service.rebuildEmbeddings("repair")).toMatchObject({ enqueued: 1 });
    expect(await service.embeddingMaintenanceStats()).toMatchObject({
      retryQueue: { pending: 1, active: 0, stale: 0, failed: 0 }
    });
    db.db.prepare("UPDATE evolution_jobs SET status='leased', leased_until=? WHERE job_type='user_memory_embedding'")
      .run(new Date(Date.now() + 60_000).toISOString());
    expect(await service.embeddingMaintenanceStats()).toMatchObject({
      retryQueue: { pending: 0, active: 1, stale: 0, failed: 0 }
    });
    db.db.prepare("UPDATE evolution_jobs SET leased_until=NULL WHERE job_type='user_memory_embedding'").run();
    expect(await service.embeddingMaintenanceStats()).toMatchObject({
      retryQueue: { pending: 0, active: 0, stale: 1, failed: 0 }
    });
    db.db.prepare("UPDATE evolution_jobs SET status='dead_letter' WHERE job_type='user_memory_embedding'").run();
    expect(await service.embeddingMaintenanceStats()).toMatchObject({
      retryQueue: { pending: 0, active: 0, stale: 0, failed: 1 }
    });
  });

  it("refreshes an in-progress row that has a holder but no lease", () => {
    const { db } = createTestService();
    const runtime = new Repositories(db.db).runtime;
    const input = {
      targetKind: "trace" as const, targetId: "null-lease", vectorField: "vec_summary" as const,
      sourceText: "old text", now: 1_000
    };
    const original = runtime.enqueueEmbeddingRetry(input);
    db.db.prepare("UPDATE embedding_retry_queue SET status='in_progress', claimed_by='old-worker', lease_until=NULL WHERE id=?")
      .run(original.id);
    expect(runtime.enqueueEmbeddingRetry({ ...input, sourceText: "new text", now: 2_000 }))
      .toMatchObject({ status: "pending", sourceText: "new text", claimedBy: null, leaseUntil: null });
  });

  it("finds an orphan while idle without another request or timed job", async () => {
    const { db, service } = createTestService();
    const repos = new Repositories(db.db);
    vi.spyOn(service, "reconcileWorkerStartup").mockImplementation(() => ({} as ReturnType<typeof service.reconcileWorkerStartup>));
    vi.spyOn(service, "nextWorkerRunAt").mockReturnValue(undefined);
    const run = vi.spyOn(service, "runWorkerOnce");
    const server = createMemoryHttpServer({
      configPath: `${createTestRoot()}/config.yaml`,
      service, workerStartupFallbackMs: 0, workerIdlePollMs: 20, startAgentSourceAutomation: false
    });
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      await vi.waitFor(() => expect(run).toHaveBeenCalled(), { timeout: 1_000 });
      const memory = traceMemory("idle-orphan");
      repos.memories.insert(memory);
      const retry = repos.runtime.enqueueEmbeddingRetry({
        targetKind: "trace", targetId: memory.id, vectorField: "vec_summary", sourceText: memory.memoryValue,
        now: Date.now() - 1_000
      });
      db.db.prepare("UPDATE embedding_retry_queue SET status='in_progress', claimed_by=NULL, lease_until=NULL WHERE id=?")
        .run(retry.id);
      await vi.waitFor(() => expect(repos.runtime.getEmbeddingRetry(retry.id)?.status).toBe("succeeded"), { timeout: 1_000 });
    } finally {
      await closeMemoryHttpServer(server);
    }
    const callsAtClose = run.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(run).toHaveBeenCalledTimes(callsAtClose);
  });

  it("does not enqueue repairs if the current model dimension cannot be determined", async () => {
    const embedder = createCapturingEmbedder([]);
    const probe = vi.spyOn(embedder, "embedOne").mockRejectedValue(new Error("model unavailable"));
    const { db, service } = createTestService({ embedder });
    new Repositories(db.db).memories.insert(traceMemory("probe-failure"));
    await expect(Promise.resolve().then(() => service.rebuildEmbeddings("repair"))).rejects.toThrow("model unavailable");
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM embedding_retry_queue").get()).toEqual({ n: 0 });
    expect(await service.embeddingMaintenanceStats()).toMatchObject({
      dimension: 0, dimensionError: "model unavailable",
      retryQueue: { pending: 0, active: 0, stale: 0, failed: 0 }
    });
    probe.mockResolvedValue([1, 0, 0]);
    expect(await service.rebuildEmbeddings("repair")).toMatchObject({ enqueued: 1 });
    expect(await service.embeddingMaintenanceStats()).toMatchObject({ dimension: 3 });
    expect((await service.embeddingMaintenanceStats()).dimensionError).toBeUndefined();
  });

  it("shares dimension probes and invalidates the result when the model changes", async () => {
    const embedder = createCapturingEmbedder([]);
    const probe = vi.spyOn(embedder, "embedOne");
    const { service } = createTestService({ embedder });
    const stats = await Promise.all([service.embeddingMaintenanceStats(), service.embeddingMaintenanceStats()]);
    expect(stats.map(item => item.dimension)).toEqual([3, 3]);
    expect(probe).toHaveBeenCalledTimes(1);
    await service.embeddingMaintenanceStats();
    expect(probe).toHaveBeenCalledTimes(1);
    embedder.config.model = "changed-4d-model";
    probe.mockResolvedValue([1, 0, 0, 0]);
    expect(await service.embeddingMaintenanceStats()).toMatchObject({ dimension: 4 });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("combines both embedding queues across users and excludes unrelated jobs", () => {
    const { db } = createTestService();
    const runtime = new Repositories(db.db).runtime;
    const at = new Date(1_000).toISOString();
    for (const [id, jobType, userId] of [
      ["regular", "embedding", "another-user"],
      ["current-user", "user_memory_embedding", "local-user"],
      ["other-user", "user_memory_embedding", "another-user"],
      ["unrelated", "reflection", "local-user"]
    ] as const) {
      runtime.enqueueJob({ id, jobType, userId, status: "queued", payload: {}, attempts: 0, maxAttempts: 6,
        createdAt: at, updatedAt: at });
    }
    runtime.enqueueEmbeddingRetry({ targetKind: "trace", targetId: "combined", vectorField: "vec_summary", sourceText: "test", now: 1_000 });
    expect(runtime.embeddingMaintenanceQueueStats("local-user", 2_000)).toEqual({ pending: 4, active: 0, stale: 0, failed: 0 });
  });

  it("queues only the three missing vectors from the Viewer repair request", async () => {
    const { db, service } = createTestService();
    const repos = new Repositories(db.db);
    for (let index = 0; index < 63; index += 1) {
      const memory: MemoryRow = {
        id: `repro-skill-${index}`,
        timeline: "2026-10-01T00:00:00.000Z",
        userId: "repro-user",
        memoryType: "SkillMemory",
        status: "activated",
        visibility: "private",
        memoryKey: `repro:skill:${index}`,
        memoryValue: `reproduction item ${index}`,
        tags: ["reproduction"],
        info: {},
        properties: {
          internal_info: {
            memory_layer: "Skill",
            memory_kind: "skill",
            skill: { name: `Reproduction ${index}`, status: "active", invocation_guide: `reproduction item ${index}` }
          }
        },
        memoryLayer: "Skill",
        version: 1,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z"
      };
      const withVector = index < 60
        ? updateMemoryVectorField(memory, "vec", [1, 0, 0], {
          provider: "local", model: "capturing-test-embedding", updatedAt: "2026-10-01T00:00:00.000Z"
        })
        : memory;
      repos.memories.insert(withVector);
      if (index < 60) {
        const retry = repos.runtime.enqueueEmbeddingRetry({
          targetKind: "skill", targetId: memory.id, vectorField: "vec",
          sourceText: memory.memoryValue, now: 1_000
        });
        db.db.prepare("UPDATE embedding_retry_queue SET status = 'succeeded' WHERE id = ?").run(retry.id);
      }
    }

    expect(await service.embeddingMaintenanceStats()).toMatchObject({
      totalSlots: 63, ready: 60, missing: 3, needsRepair: 3
    });
    vi.spyOn(service, "reconcileWorkerStartup").mockImplementation(() => ({} as ReturnType<typeof service.reconcileWorkerStartup>));
    vi.spyOn(service, "runWorkerOnce").mockResolvedValue({
      leased: 0, succeeded: 0, failed: 0, jobs: [],
      embeddingRetries: { leased: 0, succeeded: 0, failed: 0, items: [] },
      changeSeq: 0, syncCursor: "0", serverTime: new Date().toISOString()
    });
    const server = createMemoryHttpServer({
      configPath: `${createTestRoot()}/config.yaml`,
      service,
      workerStartupFallbackMs: 3_600_000,
      workerPostHealthDelayMs: 3_600_000,
      startAgentSourceAutomation: false
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected test TCP port");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/embeddings/rebuild`, {
        method: "POST",
        headers: { "x-memmy-viewer": "1", "content-type": "application/json" },
        body: JSON.stringify({ mode: "repair", offset: 0 })
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ accepted: true, mode: "repair", enqueued: 3 });
    } finally {
      await closeMemoryHttpServer(server);
      vi.restoreAllMocks();
    }
    expect(db.db.prepare(
      "SELECT status, COUNT(*) AS count FROM embedding_retry_queue GROUP BY status"
    ).all()).toEqual([{ status: "pending", count: 3 }, { status: "succeeded", count: 60 }]);
    expect(db.db.prepare(
      "SELECT COUNT(*) AS count FROM memory_vector_entries"
    ).get()).toEqual({ count: 60 });
  });

  it("reopens a succeeded row for an explicit rebuild without changing its identity", () => {
    const { db } = createTestService();
    const runtime = new Repositories(db.db).runtime;
    const input = {
      targetKind: "trace" as const,
      targetId: "repro-already-vectorized",
      vectorField: "vec_summary" as const,
      sourceText: "already vectorized",
      now: 1_000
    };
    const original = runtime.enqueueEmbeddingRetry(input);
    db.db.prepare("UPDATE embedding_retry_queue SET status = 'succeeded', attempts = 1 WHERE id = ?")
      .run(original.id);

    const repeated = runtime.enqueueEmbeddingRetry({ ...input, now: 2_000 });
    const row = db.db.prepare(
      "SELECT id, status, attempts, created_at FROM embedding_retry_queue WHERE id = ?"
    ).get(original.id);
    expect(repeated.id).toBe(original.id);
    expect(row).toEqual({ id: original.id, status: "pending", attempts: 0, created_at: 1_000 });
  });

  it("counts the required summary vector as missing even when an L1 action vector exists", async () => {
    const { db, service } = createTestService();
    const repos = new Repositories(db.db);
    const memory: MemoryRow = {
      id: "repro-l1-action-only", timeline: "2026-10-01T00:00:00.000Z",
      userId: "repro-user", memoryType: "TraceMemory", status: "activated",
      visibility: "private", memoryKey: "repro:l1:action-only",
      memoryValue: "summary text", tags: [], info: {},
      properties: { internal_info: { memory_layer: "L1" } },
      memoryLayer: "L1", version: 1,
      createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z"
    };
    repos.memories.insert(updateMemoryVectorField(memory, "vec_action", [1, 0], {
      provider: "test", model: "test", updatedAt: memory.updatedAt
    }));

    expect(await service.embeddingMaintenanceStats()).toMatchObject({
      totalSlots: 2, ready: 0, missing: 1, modelMismatch: 1, needsRepair: 2
    });
    expect(await service.rebuildEmbeddings("repair")).toMatchObject({ enqueued: 2 });
    expect(repos.runtime.getEmbeddingRetryByTarget("trace", memory.id, "vec_summary"))
      .toMatchObject({ status: "pending" });
  });

  it("keeps an active claim intact during a duplicate enqueue", () => {
    const { db } = createTestService();
    const runtime = new Repositories(db.db).runtime;
    const input = {
      targetKind: "trace" as const,
      targetId: "repro-leased",
      vectorField: "vec_summary" as const,
      sourceText: "leased retry",
      now: 1_000
    };
    const original = runtime.enqueueEmbeddingRetry(input);
    const [claimed] = runtime.claimDueEmbeddingRetries({
      now: 1_000,
      workerId: "worker-a",
      leaseUntil: 10_000,
      limit: 1
    });
    expect(claimed?.id).toBe(original.id);

    runtime.enqueueEmbeddingRetry({ ...input, now: 2_000 });
    const row = db.db.prepare(
      "SELECT status, claimed_by, lease_until, attempts FROM embedding_retry_queue WHERE id = ?"
    ).get(original.id);
    expect(row).toEqual({ status: "in_progress", claimed_by: "worker-a", lease_until: 10_000, attempts: 0 });
    expect(runtime.markEmbeddingRetrySucceededClaimed(original.id, {
      workerId: "worker-a",
      leaseUntil: 10_000,
      leaseToken: claimed!.leaseToken!,
      now: 3_000
    })).toMatchObject({ status: "succeeded" });
    expect(runtime.claimDueEmbeddingRetries({
      now: 20_000,
      workerId: "worker-b",
      leaseUntil: 30_000,
      limit: 1
    })).toEqual([]);
  });

  it("wakes and reclaims an orphaned in-progress retry without restarting", () => {
    const { db } = createTestService();
    const runtime = new Repositories(db.db).runtime;
    const retry = runtime.enqueueEmbeddingRetry({
      targetKind: "trace", targetId: "repro-orphan", vectorField: "vec_summary",
      sourceText: "orphaned retry", now: 1_000
    });
    db.db.prepare(
      "UPDATE embedding_retry_queue SET status = 'in_progress', claimed_by = NULL, lease_until = NULL WHERE id = ?"
    ).run(retry.id);
    expect(runtime.nextWorkerRunAt()).toBe(1_000);
    const claims = runtime.claimDueEmbeddingRetries({
      now: 2_000, workerId: "worker-b", leaseUntil: 10_000, limit: 1
    });
    expect(claims).toMatchObject([{ id: retry.id, claimedBy: "worker-b", leaseUntil: 10_000 }]);
    expect(runtime.markEmbeddingRetrySucceededClaimed(retry.id, {
      workerId: "worker-b", leaseUntil: 10_000, leaseToken: claims[0]!.leaseToken!, now: 3_000
    })).toMatchObject({ status: "succeeded" });
  });

  it("reports valid leases separately from stale work and reclaims expired leases", () => {
    const { db } = createTestService();
    const runtime = new Repositories(db.db).runtime;
    const active = runtime.enqueueEmbeddingRetry({
      targetKind: "trace", targetId: "repro-active", vectorField: "vec_summary",
      sourceText: "active retry", now: 1_000
    });
    const expired = runtime.enqueueEmbeddingRetry({
      targetKind: "trace", targetId: "repro-expired", vectorField: "vec_summary",
      sourceText: "expired retry", now: 1_000
    });
    db.db.prepare(
      "UPDATE embedding_retry_queue SET status = 'in_progress', claimed_by = ?, lease_until = ? WHERE id = ?"
    ).run("worker-a", 10_000, active.id);
    db.db.prepare(
      "UPDATE embedding_retry_queue SET status = 'in_progress', claimed_by = ?, lease_until = ?, lease_token = 'expired-lease' WHERE id = ?"
    ).run("worker-old", 1_500, expired.id);

    expect(runtime.embeddingRetryQueueStats(2_000)).toEqual({
      pending: 0, active: 1, stale: 1, failed: 0
    });
    expect(runtime.claimDueEmbeddingRetries({
      now: 2_000, workerId: "worker-b", leaseUntil: 12_000, limit: 2
    })).toMatchObject([{ id: expired.id, claimedBy: "worker-b" }]);
    expect(runtime.markEmbeddingRetrySucceededClaimed(expired.id, {
      workerId: "worker-old", leaseUntil: 1_500, leaseToken: "expired-lease", now: 3_000
    })).toBeUndefined();
    expect(runtime.embeddingRetryQueueStats(2_000)).toEqual({
      pending: 0, active: 2, stale: 0, failed: 0
    });
  });

  it("lets the worker finish an orphaned row whose target already has a vector", async () => {
    const { db, service } = createTestService();
    const repos = new Repositories(db.db);
    const memory: MemoryRow = {
      id: "repro-orphan-with-vector", timeline: "2026-10-01T00:00:00.000Z",
      userId: "repro-user", memoryType: "SkillMemory", status: "activated",
      visibility: "private", memoryKey: "repro:orphan-with-vector",
      memoryValue: "already vectorized", tags: [], info: {},
      properties: { internal_info: { memory_layer: "Skill" } }, memoryLayer: "Skill",
      version: 1, createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z"
    };
    repos.memories.insert(updateMemoryVectorField(memory, "vec", [1, 0], {
      provider: "test", model: "test", updatedAt: memory.updatedAt
    }));
    const retry = repos.runtime.enqueueEmbeddingRetry({
      targetKind: "skill", targetId: memory.id, vectorField: "vec",
      sourceText: embeddingTextForMemory(memory), now: Date.now() - 1_000
    });
    db.db.prepare(
      "UPDATE embedding_retry_queue SET status = 'in_progress', claimed_by = NULL, lease_until = NULL WHERE id = ?"
    ).run(retry.id);

    await service.runWorkerOnce(10);
    expect(repos.runtime.getEmbeddingRetry(retry.id)).toMatchObject({ status: "succeeded" });
    expect(repos.runtime.embeddingRetryQueueStats()).toMatchObject({
      pending: 0, active: 0, stale: 0
    });
  });
});
