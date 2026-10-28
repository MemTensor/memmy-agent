import { afterEach, expect, it, vi } from "vitest";
import { Repositories } from "../../../src/storage/repositories.js";
import { stableHash } from "../../../src/utils/id.js";
import { createMemoryServiceFixture, createCapturingEmbedder } from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(() => { vi.restoreAllMocks(); cleanup(); });

function seed(repos: Repositories, userMemory: boolean, id = "edited-memory") {
  const at = new Date().toISOString();
  if (userMemory) {
    const content = `old content ${id}`;
    repos.userMemories.insert({
      id, sourceTurnId: id, userId: "local-user", memoryTypes: [], content,
      normalizedUserTextHash: stableHash(content), sourceTurnRefs: [], status: "active", createdAt: at, updatedAt: at
    });
  } else {
    repos.memories.insert({
      id, timeline: at, userId: "local-user", memoryType: "TraceMemory", status: "activated", visibility: "private",
      memoryValue: "old content", tags: [], info: {}, properties: { internal_info: { memory_layer: "L1" } },
      memoryLayer: "L1", version: 1, createdAt: at, updatedAt: at
    });
  }
}

function editContent(repos: Repositories, userMemory: boolean) {
  if (userMemory) {
    repos.userMemories.update({ ...repos.userMemories.get("edited-memory")!, content: "new content" });
  } else {
    // Summary updates may keep the old vector until the new embedding succeeds.
    repos.memories.update({ ...repos.memories.get("edited-memory")!, memoryValue: "new content", contentHash: stableHash("new content") });
  }
}

it.each([false, true])("keeps actual queue occupancy when content changes (user memory: %s)", async userMemory => {
  const { db, service } = createTestService();
  const repos = new Repositories(db.db);
  seed(repos, userMemory);
  await service.rebuildEmbeddings("repair");
  editContent(repos, userMemory);
  expect(await service.embeddingMaintenanceStats()).toMatchObject({ retryQueue: { pending: 1, active: 0, stale: 0 } });
  const now = Date.now();
  if (userMemory) {
    db.db.prepare("UPDATE evolution_jobs SET status='leased', leased_until=? WHERE job_type='user_memory_embedding'")
      .run(new Date(now + 60_000).toISOString());
  } else {
    repos.runtime.claimDueEmbeddingRetries({ now, workerId: "review-worker", leaseUntil: now + 60_000, limit: 10 });
  }
  expect(await service.embeddingMaintenanceStats()).toMatchObject({ retryQueue: { pending: 0, active: 1, stale: 0 } });
  if (userMemory) db.db.prepare("UPDATE evolution_jobs SET leased_until=NULL").run();
  else db.db.prepare("UPDATE embedding_retry_queue SET lease_until=NULL").run();
  expect(await service.embeddingMaintenanceStats()).toMatchObject({ retryQueue: { pending: 0, active: 0, stale: 1 } });
});

it.each([false, true])("repairs failed current content despite a retained old vector (user memory: %s)", async userMemory => {
  const embedder = createCapturingEmbedder([]);
  const { db, service } = createTestService({ embedder });
  const repos = new Repositories(db.db);
  seed(repos, userMemory);
  seed(repos, userMemory, "unchanged-memory");
  await service.rebuildEmbeddings("repair");
  await service.runWorkerOnce(10);
  expect(await service.embeddingMaintenanceStats()).toMatchObject({ ready: 2, needsRepair: 0 });
  editContent(repos, userMemory);
  // Queue work for the changed content without removing its existing vector.
  const at = new Date().toISOString();
  if (userMemory) {
    repos.runtime.enqueueJob({ id: "current-content", jobType: "user_memory_embedding", status: "queued",
      targetMemoryId: "edited-memory", userId: "local-user", payload: { contentHash: stableHash("new content") },
      attempts: 0, maxAttempts: 6, createdAt: at, updatedAt: at });
  } else {
    repos.runtime.enqueueEmbeddingRetry({ targetKind: "trace", targetId: "edited-memory", vectorField: "vec_summary",
      sourceText: "new content", now: Date.now() });
  }
  const batch = vi.spyOn(embedder, "embed").mockRejectedValue(new Error("provider unavailable"));
  const single = vi.spyOn(embedder, "embedOne").mockRejectedValue(new Error("provider unavailable"));
  for (let attempt = 0; attempt < 6; attempt++) {
    db.db.prepare("UPDATE embedding_retry_queue SET next_attempt_at=0").run();
    await service.runWorkerOnce(10);
  }
  expect(await service.embeddingMaintenanceStats()).toMatchObject({ ready: 1, missing: 0, needsRepair: 1, retryQueue: { failed: 1 } });
  batch.mockResolvedValue([[0, 1, 0]]);
  single.mockResolvedValue([0, 1, 0]);
  const repair = await service.rebuildEmbeddings("repair");
  expect(repair).toMatchObject({ enqueued: 1, pending: 1, done: false });
  await service.runWorkerOnce(10);
  expect(service.embeddingMaintenanceProgress(repair.runId)).toMatchObject({
    updated: 1, failed: 0, done: true, statsAfter: { ready: 2, needsRepair: 0, retryQueue: { failed: 0 } }
  });
  expect(await service.embeddingMaintenanceStats()).toMatchObject({ ready: 2, needsRepair: 0, retryQueue: { failed: 0, pending: 0, active: 0 } });
  expect(await service.rebuildEmbeddings("repair")).toMatchObject({ enqueued: 0 });
});
