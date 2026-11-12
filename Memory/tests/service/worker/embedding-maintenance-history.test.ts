import { afterEach, describe, expect, it, vi } from "vitest";
import { Repositories } from "../../../src/storage/repositories.js";
import { stableHash } from "../../../src/utils/id.js";
import { createMemoryHttpServer } from "../../../src/server/http.js";
import { closeMemoryHttpServer } from "../../../src/server/http.js";
import { createCapturingEmbedder, createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(() => { vi.restoreAllMocks(); cleanup(); });

describe("embedding maintenance current failures", () => {
  it("drops only repaired targets from current failures after six real failures, preserving history", async () => {
    const embedder = createCapturingEmbedder([]);
    const call = vi.spyOn(embedder, "embedOne");
    const { db, service, root } = createTestService({ embedder });
    const repos = new Repositories(db.db);
    const at = new Date().toISOString();
    for (const id of ["repaired-user", "still-failed-user"]) {
      repos.userMemories.insert({
        id, sourceTurnId: id, userId: "local-user", memoryTypes: [], content: id,
        normalizedUserTextHash: stableHash(id), sourceTurnRefs: [], status: "active", createdAt: at, updatedAt: at
      });
    }
    await service.rebuildEmbeddings("repair");
    call.mockRejectedValue(new Error("embedding provider unavailable"));
    // Make retries due explicitly; consecutive immediate drains preserve backoff.
    for (let attempt = 0; attempt < 6; attempt++) {
      db.db.prepare("UPDATE evolution_jobs SET available_at=NULL WHERE status='failed'").run();
      await service.runWorkerOnce(10);
    }
    expect(db.db.prepare("SELECT attempts,status FROM evolution_jobs WHERE job_type='user_memory_embedding'").all())
      .toEqual([{ attempts: 6, status: "dead_letter" }, { attempts: 6, status: "dead_letter" }]);
    call.mockResolvedValue([1, 0, 0]);
    expect(await service.embeddingMaintenanceStats()).toMatchObject({ retryQueue: { failed: 2 } });
    await service.rebuildEmbeddings("repair");
    await service.runWorkerOnce(10, { targetMemoryIds: ["repaired-user"] });
    expect(await service.embeddingMaintenanceStats()).toMatchObject({ ready: 1, needsRepair: 1, retryQueue: { failed: 1, pending: 1 } });
    await service.runWorkerOnce(10, { targetMemoryIds: ["still-failed-user"] });
    expect(await service.embeddingMaintenanceStats()).toMatchObject({ ready: 2, needsRepair: 0, retryQueue: { failed: 0, pending: 0 } });
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs WHERE status='dead_letter'").get()).toEqual({ n: 2 });
    const server = createMemoryHttpServer({ configPath: `${root}/config.yaml`, service, workerStartupFallbackMs: 3_600_000, startAgentSourceAutomation: false });
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/embeddings/maintenance`, { headers: { "x-memmy-viewer": "1" } });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ready: 2, needsRepair: 0, retryQueue: { failed: 0 } });
    } finally { await closeMemoryHttpServer(server); }

    // A same-dimensional vector from another model cannot hide unresolved work.
    embedder.config.model = "changed-model";
    expect(await service.embeddingMaintenanceStats()).toMatchObject({ ready: 0, needsRepair: 2, retryQueue: { failed: 2 } });
    expect(await service.rebuildEmbeddings("repair")).toMatchObject({ enqueued: 2 });
    await service.runWorkerOnce(10);
    expect(await service.embeddingMaintenanceStats()).toMatchObject({ retryQueue: { failed: 0 } });

    const before = repos.userMemories.get("repaired-user")!;
    repos.userMemories.update({ ...before, content: "changed content", embedding: undefined, updatedAt: new Date().toISOString() });
    const changed = await service.embeddingMaintenanceStats();
    expect(changed).toMatchObject({ missing: 1, retryQueue: { failed: 0 } });
    await service.rebuildEmbeddings("repair");
    call.mockRejectedValue(new Error("new content still fails"));
    // Make retries due explicitly; consecutive immediate drains preserve backoff.
    for (let attempt = 0; attempt < 6; attempt++) {
      db.db.prepare("UPDATE evolution_jobs SET available_at=NULL WHERE status='failed'").run();
      await service.runWorkerOnce(10);
    }
    expect(await service.embeddingMaintenanceStats()).toMatchObject({ missing: 1, retryQueue: { failed: 1 } });
  });

  it("applies the same completion rule across ordinary jobs and the retry queue", async () => {
    const embedder = createCapturingEmbedder([]);
    const fail = vi.spyOn(embedder, "embed").mockRejectedValue(new Error("unavailable"));
    const { db, service } = createTestService({ embedder });
    const repos = new Repositories(db.db);
    const at = new Date().toISOString();
    for (const id of ["normal-repaired", "normal-unresolved"]) {
      const memory = repos.memories.insert({
        id, timeline: at, userId: "local-user", memoryType: "TraceMemory", status: "activated", visibility: "private",
        memoryValue: "ordinary synthetic text", tags: [], info: {}, properties: { internal_info: { memory_layer: "L1" } },
        memoryLayer: "L1", version: 1, createdAt: at, updatedAt: at
      });
      repos.runtime.enqueueJob({ id: `old-${id}`, jobType: "embedding", status: "dead_letter", targetMemoryId: id,
        payload: { contentHash: memory.contentHash }, userId: "local-user", attempts: 6, maxAttempts: 6,
        createdAt: at, updatedAt: at });
    }
    await service.rebuildEmbeddings("repair");
    for (let attempt = 0; attempt < 6; attempt++) {
      db.db.prepare("UPDATE embedding_retry_queue SET next_attempt_at=0").run();
      await service.runWorkerOnce(10);
    }
    // A target failed in both tables is one unresolved target.
    expect(await service.embeddingMaintenanceStats()).toMatchObject({ retryQueue: { failed: 2 } });
    fail.mockResolvedValue([[1, 0, 0], [1, 0, 0]]);
    await service.rebuildEmbeddings("repair");
    await service.runWorkerOnce(10, { targetMemoryIds: ["normal-repaired"] });
    expect(await service.embeddingMaintenanceStats()).toMatchObject({ ready: 1, needsRepair: 1, retryQueue: { failed: 1 } });
    await service.runWorkerOnce(10, { targetMemoryIds: ["normal-unresolved"] });
    expect(await service.embeddingMaintenanceStats()).toMatchObject({ ready: 2, needsRepair: 0, retryQueue: { failed: 0 } });
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM evolution_jobs WHERE status='dead_letter'").get()).toEqual({ n: 2 });
    db.db.prepare("UPDATE memory_vector_entries SET embedding_model='old-model' WHERE memory_id='normal-repaired'").run();
    expect(await service.embeddingMaintenanceStats()).toMatchObject({ retryQueue: { failed: 1 } });
    db.db.prepare("UPDATE memory_vector_entries SET embedding_model='capturing-test-embedding' WHERE memory_id='normal-repaired'").run();
    repos.vectors.delete("normal-repaired", "vec_summary");
    expect(await service.embeddingMaintenanceStats()).toMatchObject({ missing: 1, retryQueue: { failed: 1 } });
  });
});
