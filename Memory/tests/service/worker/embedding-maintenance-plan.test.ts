import { afterEach, describe, expect, it } from "vitest";
import { Repositories } from "../../../src/storage/repositories.js";
import { attachMemoryVector } from "../../../src/storage/memory-vector-state.js";
import { stableHash } from "../../../src/utils/id.js";
import { createMemoryServiceFixture, createCapturingEmbedder } from "../../fixtures/memory-service-fixture.js";
import {
  readEmbeddingMaintenanceStats,
  readEmbeddingMaintenanceTargets
} from "../../../src/service/embedding/embedding-maintenance-reader-query.js";
import type { MemoryRow } from "../../../src/types.js";

const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(() => cleanup());

const identity = { provider: "local", model: "capturing-test-embedding" } as const;
const at = "2026-10-30T00:00:00.000Z";
const vector = () => [1, 0, 0];

/** An L2 feedback-derived memory, which the one-time provenance upgrade covers. */
function feedbackMemory(id: string, memoryValue = `Original content ${id}`): MemoryRow {
  return {
    id, userId: "local-user", memoryLayer: "L2", timeline: at, memoryType: "LongTermMemory",
    status: "activated", visibility: "private", memoryValue, tags: [], info: {},
    version: 1, createdAt: at, updatedAt: at,
    properties: {
      internal_info: {
        memory_layer: "L2",
        source: "feedback.experience.v1",
        policy: { title: id, trigger: "Original trigger", procedure: "Original procedure" }
      }
    }
  };
}

function seedWithVector(repos: Repositories, memory: MemoryRow): void {
  repos.memories.insert(attachMemoryVector(memory, {
    vectorField: "vec", vector: vector(), embeddingProvider: identity.provider, embeddingModel: identity.model
  }));
}

/** A terminal failure keeps the queue row observable without the worker retrying it. */
function seedFailedRetry(repos: Repositories, targetId: string, sourceText: string): void {
  repos.runtime.enqueueEmbeddingRetry({
    targetKind: "policy", targetId, vectorField: "vec", sourceText, now: Date.now() - 60_000
  });
  repos.db.prepare(`UPDATE embedding_retry_queue
    SET status = 'failed', attempts = max_attempts, last_error = 'provider unavailable'
    WHERE target_id = ?`).run(targetId);
}

describe("provenance upgrade target health", () => {
  // Health for a plan target must match the global statistics. A stale vector
  // with no successful embedding work behind it is contentMismatch; treating it
  // as ready made the one-time upgrade record completedAt with zero targets
  // while the panel kept reporting needsRepair.
  it("reports the same health for a plan target as the global statistics", async () => {
    const { db } = createTestService({ embedder: createCapturingEmbedder([]) });
    const repos = new Repositories(db.db);
    seedWithVector(repos, feedbackMemory("stale-feedback"));
    seedFailedRetry(repos, "stale-feedback", "Original content stale-feedback");

    // The vector predates the current content: nothing embedded this content.
    repos.db.prepare("UPDATE memories SET content_hash = ? WHERE id = ?")
      .run(stableHash("changed since the vector was written"), "stale-feedback");

    const snapshot = readEmbeddingMaintenanceStats(repos, {
      userId: "local-user", identity, available: true, knownDimension: 3, includePlan: true
    });
    expect(snapshot.stats).toMatchObject({ contentMismatch: 1, needsRepair: 1, retryQueue: { failed: 1 } });

    const targets = readEmbeddingMaintenanceTargets(repos, {
      userId: "local-user", identity, dimension: 3,
      targets: [{ id: "stale-feedback", kind: "memory", vectorField: "vec" }]
    }).targets;

    expect(targets).toHaveLength(1);
    expect(targets[0]!.health).toBe("contentMismatch");
    // The invariant: plan health and the panel counters describe the same state.
    expect(snapshot.health["memory:stale-feedback:vec"]).toBe(targets[0]!.health);
  });

  it("still reports ready for a target whose current content was embedded", async () => {
    const { db } = createTestService({ embedder: createCapturingEmbedder([]) });
    const repos = new Repositories(db.db);
    seedWithVector(repos, feedbackMemory("fresh-feedback"));

    const targets = readEmbeddingMaintenanceTargets(repos, {
      userId: "local-user", identity, dimension: 3,
      targets: [{ id: "fresh-feedback", kind: "memory", vectorField: "vec" }]
    }).targets;

    expect(targets[0]!.health).toBe("ready");
  });
});

describe("maintenance progress with a reused historical retry", () => {
  // A queued retry may carry an older-but-valid rendering of the same content
  // (here the raw memoryValue). The worker embeds it successfully, so the run
  // must report updated, not failed.
  it("reports a successful reused retry as updated", async () => {
    const embedder = createCapturingEmbedder([]);
    const { db, service } = createTestService({ embedder });
    const repos = new Repositories(db.db);
    repos.memories.insert(feedbackMemory("reuse-target", "Reusable content"));

    repos.runtime.enqueueEmbeddingRetry({
      targetKind: "policy", targetId: "reuse-target", vectorField: "vec",
      sourceText: "Reusable content", now: Date.now()
    });

    const repair = await service.rebuildEmbeddings("repair");
    expect(repair.enqueued).toBe(1);
    await service.runWorkerOnce(10);

    expect(await service.embeddingMaintenanceStats()).toMatchObject({ needsRepair: 0 });
    expect(await service.embeddingMaintenanceProgress(repair.runId)).toMatchObject({
      updated: 1, failed: 0, pending: 0, done: true
    });
  });
});
