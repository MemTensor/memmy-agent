import { afterEach, describe, expect, it } from "vitest";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { SqliteVecStore } from "../../../src/storage/sqlite-vec-store.js";
import { attachMemoryVector } from "../../../src/storage/memory-vector-state.js";
import { readEmbeddingMaintenanceTargets } from "../../../src/service/embedding/embedding-maintenance-reader-query.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryRow } from "../../../src/types.js";

const roots: string[] = [];
const databases: MemoryDb[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.db.open) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const identity = { provider: "local", model: "m" } as const;
const at = "2026-10-30T00:00:00.000Z";

function memory(id: string): MemoryRow {
  return {
    id, userId: "u", memoryLayer: "L2", timeline: at, memoryType: "LongTermMemory",
    status: "activated", visibility: "private", memoryValue: `value ${id}`, tags: [], info: {},
    version: 1, createdAt: at, updatedAt: at,
    properties: { internal_info: { memory_layer: "L2" } }
  };
}

/** One target plus `unrelated` terminal failures owned by other memories. */
function seed(unrelated: number) {
  const root = mkdtempSync(join(tmpdir(), "reader-scope-"));
  roots.push(root);
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  databases.push(db);
  const repos = new Repositories(db.db);
  repos.memories.insert(attachMemoryVector(memory("target"), {
    vectorField: "vec", vector: [1, 0, 0], embeddingProvider: identity.provider, embeddingModel: identity.model
  }));
  db.db.transaction(() => {
    for (let index = 0; index < unrelated; index += 1) {
      repos.runtime.enqueueEmbeddingRetry({
        targetKind: "policy", targetId: `other-${index}`, vectorField: "vec",
        sourceText: `text ${index}`, now: Date.now() - 60_000
      });
    }
  })();
  db.db.prepare(`UPDATE embedding_retry_queue SET status = 'failed', attempts = max_attempts,
    last_error = 'down' WHERE target_id LIKE 'other-%'`).run();
  return { db, repos };
}

const request = {
  userId: "u", identity, dimension: 3,
  targets: [{ id: "target", kind: "memory" as const, vectorField: "vec" as const }]
};

describe("fixed-target reads stay scoped", () => {
  // The handoff requires target progress and global statistics to be fully
  // separated: cost here must not grow with unrelated retry history.
  it("does not read unrelated queue rows or the whole memories table", () => {
    const { repos } = seed(200);
    const scopedQueue = { calls: 0 };
    const globalQueue = { calls: 0 };
    const globalScan = { calls: 0 };

    const runtime = repos.runtime;
    const scopedQuery = runtime.embeddingMaintenanceTasksForTargets.bind(runtime);
    runtime.embeddingMaintenanceTasksForTargets = input => { scopedQueue.calls += 1; return scopedQuery(input); };
    const globalQuery = runtime.embeddingMaintenanceTasks.bind(runtime);
    runtime.embeddingMaintenanceTasks = now => { globalQueue.calls += 1; return globalQuery(now); };
    const entries = SqliteVecStore.prototype.maintenanceEntries;
    SqliteVecStore.prototype.maintenanceEntries = function (...args) {
      globalScan.calls += 1;
      return entries.apply(this, args as []);
    };

    try {
      const result = readEmbeddingMaintenanceTargets(repos, request);
      expect(result.targets).toHaveLength(1);
      expect(scopedQueue.calls).toBe(1);
      expect(globalQueue.calls).toBe(0);
      expect(globalScan.calls).toBe(0);
    } finally {
      runtime.embeddingMaintenanceTasksForTargets = scopedQuery;
      runtime.embeddingMaintenanceTasks = globalQuery;
      SqliteVecStore.prototype.maintenanceEntries = entries;
    }
  });

  it("keeps per-target read latency flat as unrelated history grows", () => {
    const measure = (unrelated: number): number => {
      const { repos } = seed(unrelated);
      readEmbeddingMaintenanceTargets(repos, request); // warm
      const samples: number[] = [];
      for (let index = 0; index < 5; index += 1) {
        const started = performance.now();
        readEmbeddingMaintenanceTargets(repos, request);
        samples.push(performance.now() - started);
      }
      samples.sort((left, right) => left - right);
      return samples[2]!;
    };

    const small = measure(0);
    const large = measure(5_000);
    // Before the split this grew from ~0.1ms to well over 100ms at this size.
    // Allow generous headroom for slower CI machines while still failing a
    // regression that reintroduces a global scan.
    expect(large).toBeLessThan(Math.max(small * 20 + 5, 50));
  }, 60_000);

  it("filters inactive user-memory sources and keeps job reads target-scoped", () => {
    const { repos } = seed(0);
    for (const [id, userId] of [["owned", "u"], ["foreign", "other"]] as const) {
      repos.userMemories.insert({
        id,
        sourceTurnId: id,
        userId,
        memoryTypes: [],
        content: id,
        normalizedUserTextHash: id,
        sourceTurnRefs: [],
        status: "active",
        createdAt: at,
        updatedAt: at
      });
    }
    repos.userMemories.insert({
      id: "inactive",
      sourceTurnId: "inactive",
      userId: "u",
      memoryTypes: [],
      content: "inactive",
      normalizedUserTextHash: "inactive",
      sourceTurnRefs: [],
      status: "active",
      createdAt: at,
      updatedAt: at
    });
    repos.db.prepare("UPDATE user_memories SET status = 'archived' WHERE id = 'inactive'").run();

    const sources = repos.userMemories.embeddingMaintenanceSourcesByIds(["owned", "foreign", "inactive"]);
    expect(sources).toHaveLength(2);
    expect(sources).toEqual(expect.arrayContaining([
      { id: "owned", content: "owned", status: "active" },
      { id: "foreign", content: "foreign", status: "active" }
    ]));

    for (const [id, userId] of [["owned-job", "u"], ["foreign-job", "other"]] as const) {
      repos.runtime.enqueueJob({
        id,
        jobType: "user_memory_embedding",
        status: "queued",
        targetMemoryId: id === "owned-job" ? "owned" : "foreign",
        userId,
        payload: { contentHash: id },
        attempts: 0,
        maxAttempts: 3,
        createdAt: at,
        updatedAt: at
      });
    }
    expect(repos.runtime.embeddingMaintenanceTasksForTargets({
      memoryIds: [],
      userMemoryIds: ["owned"]
    })).toHaveLength(1);
  });

  it("does not widen provenance upgrades to action vectors outside L1", () => {
    const { repos } = seed(0);
    repos.memories.insert(attachMemoryVector(memory("l2-action"), {
      vectorField: "vec_action",
      vector: [1, 0, 0],
      embeddingProvider: identity.provider,
      embeddingModel: identity.model
    }));
    expect(repos.vectors.provenanceUpgradeEntries()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "l2-action", vectorField: "vec_action" })
    ]));
  });
});
