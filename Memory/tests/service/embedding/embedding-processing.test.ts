import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MEMMY_CONFIG,
  MemoryDb,
  type Embedder,
  type MemoryRow
} from "../../../src/index.js";
import { embeddingTextForMemory } from "../../../src/service/embedding/embedding-pipeline.js";
import { Repositories } from "../../../src/storage/repositories.js";
import {
  createBatchReflectionLlm,
  createCapturingEmbedder,
  createMemoryServiceFixture,
  stableTestVector
} from "../../fixtures/memory-service-fixture.js";

const {
  cleanup,
  createTestMemoryService,
  createTestRoot,
  createTestService
} = createMemoryServiceFixture();

afterEach(cleanup);

describe("MemoryService / embedding / processing", () => {
  it("falls back to title when negative L2 title and trigger exceed 2048 mixed-language tokens", () => {
    const title = "Avoid";
    const triggerAtLimit = [
      "错".repeat(1_024),
      Array.from({ length: 1_023 }, () => "word").join(" ")
    ].join(" ");

    expect(embeddingTextForMemory(negativePolicyMemory(title, triggerAtLimit))).toBe(
      [title, triggerAtLimit].join("\n")
    );
    expect(embeddingTextForMemory(negativePolicyMemory(title, `${triggerAtLimit} 超`))).toBe(title);
  });

  it("retries trace embedding jobs without leaving the processing state stuck", async () => {
    const root = createTestRoot("mindock-memory-embedding-retry-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const embedder = createFlakyEmbedder();
    const service = createTestMemoryService({ db, mode: "dev", embedder });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-retry"
      }
    });
    const complete = service.completeTurn("turn-retry-1", {
      sessionId: session.sessionId,
      query: "Remember that transient embedding failures should be retried.",
      answer: "I will keep the retry queue durable."
    });
    const initialMemory = db.db
      .prepare(`SELECT version FROM memories WHERE id = ?`)
      .get(complete.l1MemoryId) as { version: number };

    service.closeSession(session.sessionId);
    const reflectionRun = await service.runWorkerOnce(20);
    expect(reflectionRun.jobs.some((job) => job.jobType === "reflection" && job.status === "succeeded")).toBe(true);
    const reflectedMemory = db.db
      .prepare(`SELECT version FROM memories WHERE id = ?`)
      .get(complete.l1MemoryId) as { version: number };

    const firstRun = await service.runWorkerOnce(20);
    expect(firstRun.jobs.some((job) => job.jobType === "embedding" && job.status === "failed")).toBe(true);
    const queued = db.db
      .prepare(
        `SELECT target_kind, target_id, vector_field, status, attempts
         FROM embedding_retry_queue
         WHERE target_id = ?`
      )
      .all(complete.l1MemoryId) as Array<{
        target_kind: string;
        target_id: string;
        vector_field: string;
        status: string;
        attempts: number;
      }>;
    expect(queued).toEqual([]);
    expect(new Repositories(db.db).processing.get(complete.l1MemoryId)).toMatchObject({
      state: "embedding_pending",
      stage: "embedding",
      attemptCount: 1
    });

    const secondRun = await service.runWorkerOnce(20);
    expect(secondRun.jobs.some((job) => job.jobType === "embedding" && job.status === "succeeded")).toBe(true);
    expect(secondRun.embeddingRetries.succeeded).toBe(0);
    const drained = db.db
      .prepare(
        `SELECT vector_field, status, attempts
         FROM embedding_retry_queue
         WHERE target_id = ?`
      )
      .all(complete.l1MemoryId) as Array<{ vector_field: string; status: string; attempts: number }>;
    expect(drained).toEqual([]);
    expect(new Repositories(db.db).processing.get(complete.l1MemoryId)?.state).toBe("ready");
    const memory = db.db
      .prepare(
        `SELECT memory_vector_entries.embedding_model,
                memory_vector_entries.embedding_dim,
                memories.version
         FROM memory_vector_entries
         JOIN memories ON memories.id = memory_vector_entries.memory_id
         WHERE memory_vector_entries.memory_id = ?
           AND memory_vector_entries.vector_field = 'vec_summary'`
      )
      .get(complete.l1MemoryId) as { embedding_model: string | null; embedding_dim: number; version: number };
    expect(memory.embedding_model).toBe("flaky-test-embedding");
    expect(memory.embedding_dim).toBe(3);
    expect(reflectedMemory.version).toBeGreaterThan(initialMemory.version);
    expect(memory.version).toBe(reflectedMemory.version);

    db.close();
  });

  it("embeds L1 summary together with bounded user and assistant text", async () => {
    const root = createTestRoot("mindock-memory-dual-embedding-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const seenTexts: string[] = [];
    const embedder = createCapturingEmbedder(seenTexts);
    const service = createTestMemoryService({ db, mode: "dev", embedder });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-dual-embedding"
      }
    });
    const complete = service.completeTurn("turn-dual-embedding", {
      sessionId: session.sessionId,
      query: "Remember the SQLite migration rule.",
      answer: "I will run the focused migration test before broad checks."
    });

    service.closeSession(session.sessionId);
    await service.runWorkerOnce(10);
    await service.runWorkerOnce(10);

    expect(seenTexts).toHaveLength(1);
    expect(seenTexts[0]).toContain("Summary: Remember the SQLite migration rule");
    expect(seenTexts[0]).toContain("Original exchange:");
    expect(seenTexts[0]).toContain("focused migration test");
    const row = db.db.prepare(
      `SELECT properties_json
       FROM memories
       WHERE id = ?`
    ).get(complete.l1MemoryId) as { properties_json: string };
    const properties = JSON.parse(row.properties_json) as {
      internal_info: {
        trace: {
          vec_summary: number[];
          vec_action: number[] | null;
        };
      };
    };
    expect(properties.internal_info.trace.vec_summary).toBeUndefined();
    expect(properties.internal_info.trace.vec_action).toBeUndefined();
    expect(db.db.prepare(
      `SELECT embedding_dim FROM memory_vector_entries
       WHERE memory_id = ? AND vector_field = 'vec_summary'`
    ).get(complete.l1MemoryId)).toEqual({ embedding_dim: 3 });
    db.close();
  });

  it("defers captured L1 summary and embedding until episode reflection", async () => {
    const llmCalls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string };
    }> = [];
    const embeddingTexts: string[] = [];
    const { db, service } = createTestService({
      llm: createBatchReflectionLlm(llmCalls, "SQLite migrations should run focused checks before broad checks."),
      embedder: createCapturingEmbedder(embeddingTexts)
    });
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "user-live-trace-summary"
    };
    const session = service.openSession({ namespace });

    await service.startTurn({
      sessionId: session.sessionId,
      turnId: "turn-live-trace-summary",
      query: "Remember the SQLite migration workflow."
    });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM evolution_jobs").get()).toEqual({ count: 0 });
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM memory_processing_state").get()).toEqual({ count: 0 });

    const complete = service.completeTurn("turn-live-trace-summary", {
      sessionId: session.sessionId,
      query: "Remember the SQLite migration workflow.",
      answer: "Use focused checks first, then broaden only after the migration path is verified."
    });

    expect(complete.jobs.map((job) => job.jobType)).toEqual(["episode_idle_close"]);
    expect(new Repositories(db.db).processing.get(complete.l1MemoryId)).toMatchObject({
      state: "summary_pending",
      stage: "summary",
      activeJobId: null
    });
    const recall = await service.search({
      namespace,
      query: "SQLite migration workflow",
      layers: ["L1"]
    });
    expect(recall.hits.some((hit) => hit.id === complete.l1MemoryId)).toBe(true);
    const openEpisodeRun = await service.runWorkerOnce(10);
    expect(openEpisodeRun.jobs.map((job) => job.jobType)).toEqual(["episode_idle_close"]);
    expect(llmCalls.some((call) => call.options.operation.includes("summar"))).toBe(false);
    expect(embeddingTexts).toHaveLength(0);
    service.reconcileWorkerStartup();
    expect(db.db.prepare(
      `SELECT COUNT(*) AS count FROM evolution_jobs
       WHERE target_memory_id = ? AND job_type IN ('trace_summary', 'embedding')`
    ).get(complete.l1MemoryId)).toEqual({ count: 0 });
    const row = db.db.prepare(
      `SELECT info_json, properties_json
       FROM memories
       WHERE id = ?`
    ).get(complete.l1MemoryId) as { info_json: string; properties_json: string };
    const info = JSON.parse(row.info_json) as { summary?: string };
    const properties = JSON.parse(row.properties_json) as {
      internal_info: {
        summary?: string;
        trace: {
          summary?: string;
          summary_deferred_until_reflection?: boolean;
          vec_summary?: number[];
        };
      };
    };
    expect(info.summary).toBe("");
    expect(properties.internal_info.summary).toBe("");
    expect(properties.internal_info.trace.summary).toBe("");
    expect(properties.internal_info.trace.summary_deferred_until_reflection).toBe(true);
    expect(properties.internal_info.trace.vec_summary).toBeUndefined();
    expect(db.db.prepare(
      `SELECT embedding_dim FROM memory_vector_entries
       WHERE memory_id = ? AND vector_field = 'vec_summary'`
    ).get(complete.l1MemoryId)).toBeUndefined();
    db.close();
  });
});

function negativePolicyMemory(title: string, trigger: string): MemoryRow {
  const now = "2026-07-24T00:00:00.000Z";
  return {
    id: "policy_negative_embedding_limit",
    timeline: now,
    userId: "negative-embedding-user",
    memoryType: "LongTermMemory",
    status: "activated",
    visibility: "private",
    memoryKey: "policy:negative-embedding-limit",
    memoryValue: "Avoid the failed approach.",
    tags: ["policy", "negative"],
    info: {},
    properties: {
      internal_info: {
        memory_layer: "L2",
        memory_kind: "policy",
        policy: {
          title,
          trigger,
          procedure: "Avoid the failed approach.",
          verification: "Verify the failure cannot recur.",
          boundary: "Apply only to the matching task.",
          experience_type: "failure_avoidance",
          evidence_polarity: "negative"
        }
      }
    },
    memoryLayer: "L2",
    version: 1,
    createdAt: now,
    updatedAt: now
  };
}

function createFlakyEmbedder(): Embedder {
  let batchCalls = 0;
  return {
    config: {
      ...DEFAULT_MEMMY_CONFIG.embedding,
      provider: "local",
      model: "flaky-test-embedding"
    },
    isRemote() {
      return false;
    },
    async embed(texts: string[]) {
      batchCalls += 1;
      if (batchCalls === 1) {
        throw new Error("temporary embedding outage");
      }
      return texts.map((text) => stableTestVector(text));
    },
    async embedOne(text: string) {
      return stableTestVector(text);
    },
    status() {
      return {
        provider: "local",
        model: "flaky-test-embedding",
        configured: true,
        remote: false
      };
    }
  };
}
