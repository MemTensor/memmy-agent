import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryDb } from "../../src/index.js";
import {
  attachMemoryVector,
  memoryVectorEntries
} from "../../src/storage/memory-vector-state.js";
import { Repositories } from "../../src/storage/repositories.js";
import type { MemoryLayer, MemoryRow } from "../../src/types.js";

describe("memory retrieval indexes", () => {
  it("stores trace vectors only in vec0 and searches vector, fts, and pattern routes", () => {
    const root = mkdtempSync(join(tmpdir(), "mindock-memory-retrieval-index-"));
    try {
      const db = new MemoryDb({ path: join(root, "memory.sqlite") });
      const repos = new Repositories(db.db);
      repos.memories.insert(traceMemory());

      expect(repos.memories.searchVectorIds([1, 0], "vec_summary", { memoryLayer: "L1" }, 5)[0])
        .toMatchObject({ id: "trace_indexed", score: 1, channel: "vec_summary" });
      const stored = db.db
        .prepare(`SELECT properties_json FROM memories WHERE id = ?`)
        .get("trace_indexed") as { properties_json: string };
      expect(stored.properties_json).not.toContain("vec_summary");
      expect(stored.properties_json).not.toContain("embedding_model");
      expect(db.db.prepare(`SELECT COUNT(*) AS count FROM memory_vector_entries`).get())
        .toEqual({ count: 2 });
      expect(repos.memories.searchVectorIds([1, 0], "vec_summary", { memoryLayer: "L1" }, 5, {
        anyOfTags: ["python"]
      }).map((hit) => hit.id)).toContain("trace_indexed");
      expect(repos.memories.searchVectorIds([1, 0], "vec_summary", { memoryLayer: "L1" }, 5, {
        anyOfTags: ["ruby"]
      }).map((hit) => hit.id)).not.toContain("trace_indexed");
      expect(repos.memories.searchFtsIds("\"specialterm\"", { memoryLayer: "L1" }, 5)
        .map((hit) => hit.id)).toContain("trace_indexed");
      expect(repos.memories.searchFtsIds("\"trace_indexed\"", { memoryLayer: "L1" }, 5)
        .map((hit) => hit.id)).toContain("trace_indexed");
      expect(repos.memories.search("trace_indexed", { memoryLayer: "L1" }, 5)
        .map((hit) => hit.id)).toEqual(["trace_indexed"]);
      expect(repos.memories.searchPanelIds("trace_indexed", { memoryLayer: "L1" }, 5)
        .map((hit) => hit.id)).toEqual(["trace_indexed"]);
      expect(repos.memories.searchCount("trace_indexed", { memoryLayer: "L1" })).toBe(1);
      expect(repos.memories.searchPatternIds(["科幻"], { memoryLayer: "L1" }, 5)
        .map((hit) => hit.id)).toContain("trace_indexed");

      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { layer: "L1", owner: "trace", fields: ["vec_summary", "vec_action"] },
    { layer: "L2", owner: "policy", fields: ["vec"] },
    { layer: "L3", owner: "world_model", fields: ["vec"] },
    { layer: "Skill", owner: "skill", fields: ["vec"] }
  ] as const)("uses vec0 as the only live vector authority for $layer", ({ layer, owner, fields }) => {
    const root = mkdtempSync(join(tmpdir(), "mindock-memory-vector-authority-"));
    try {
      const db = new MemoryDb({ path: join(root, "memory.sqlite") });
      const repos = new Repositories(db.db);
      const id = `authority_${layer.toLowerCase()}`;
      repos.memories.insert(authorityMemory(id, layer));

      const stored = db.db.prepare(
        `SELECT properties_json FROM memories WHERE id = ?`
      ).get(id) as { properties_json: string };
      const properties = JSON.parse(stored.properties_json) as {
        internal_info: Record<string, unknown>;
      };
      const storedOwner = properties.internal_info[owner] as Record<string, unknown>;
      for (const field of fields) {
        expect(storedOwner).not.toHaveProperty(field);
      }
      expect(storedOwner).not.toHaveProperty("embedding_model");
      expect(storedOwner).not.toHaveProperty("embedding_provider");
      expect(storedOwner).not.toHaveProperty("embedding_dim");
      expect(properties.internal_info).not.toHaveProperty("embedding_model");
      expect(properties.internal_info).not.toHaveProperty("embedding_provider");
      expect(properties.internal_info).not.toHaveProperty("embedding_dim");

      const vectorRows = db.db.prepare(
        `SELECT vector_field, embedding_model, embedding_provider, embedding_dim
         FROM memory_vector_entries
         WHERE memory_id = ?
         ORDER BY vector_field`
      ).all(id) as Array<{
        vector_field: string;
        embedding_model: string;
        embedding_provider: string;
        embedding_dim: number;
      }>;
      expect(vectorRows.map((row) => row.vector_field).sort()).toEqual([...fields].sort());
      expect(vectorRows.every((row) =>
        row.embedding_model === "authority-model" &&
        row.embedding_provider === "authority-provider" &&
        row.embedding_dim === 2
      )).toBe(true);

      const hydrated = repos.memories.get(id)!;
      const vectors = memoryVectorEntries(hydrated);
      expect(vectors.map((entry) => entry.vectorField).sort()).toEqual([...fields].sort());
      expect(JSON.stringify(hydrated)).not.toContain("authority-model");
      expect(JSON.stringify(hydrated)).not.toContain("vec_summary");
      expect(JSON.stringify(hydrated)).not.toContain("vec_action");
      vectors[0]!.vector[0] = 999;
      expect(memoryVectorEntries(hydrated)[0]!.vector[0]).not.toBe(999);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not promote stale vectors when only memory content changes", () => {
    const root = mkdtempSync(join(tmpdir(), "mindock-memory-vector-freshness-"));
    try {
      const db = new MemoryDb({ path: join(root, "memory.sqlite") });
      const repos = new Repositories(db.db);
      const originalAt = "2020-01-01T00:00:00.000Z";
      const contentAt = "2026-01-01T00:00:00.000Z";
      const vectorAt = "2026-02-01T00:00:00.000Z";
      repos.memories.insert(traceMemory("trace_freshness", originalAt, [1, 0]));

      const current = repos.memories.get("trace_freshness")!;
      const trace = current.properties.internal_info.trace as Record<string, unknown>;
      const contentOnly = repos.memories.update({
        ...current,
        memoryValue: "Summary: updated without re-embedding",
        properties: {
          ...current.properties,
          internal_info: {
            ...current.properties.internal_info,
            trace: { ...trace, summary: "updated without re-embedding" }
          }
        },
        updatedAt: contentAt
      });

      expect(vectorTimestamps(db, "trace_freshness")).toEqual({
        vec_action: originalAt,
        vec_summary: originalAt
      });
      expect(memoryVectorEntries(contentOnly)).toEqual(expect.arrayContaining([
        expect.objectContaining({ vectorField: "vec_summary", vector: [1, 0] }),
        expect.objectContaining({ vectorField: "vec_action", vector: [0, 1] })
      ]));

      repos.memories.update(attachMemoryVector({
        ...contentOnly,
        updatedAt: vectorAt
      }, {
        vectorField: "vec_summary",
        vector: [0.6, 0.8],
        embeddingModel: "replacement-model",
        embeddingProvider: "replacement-provider"
      }));

      expect(vectorTimestamps(db, "trace_freshness")).toEqual({
        vec_action: originalAt,
        vec_summary: vectorAt
      });
      const storedVectors = memoryVectorEntries(repos.memories.get("trace_freshness")!);
      const storedSummary = storedVectors.find((entry) => entry.vectorField === "vec_summary");
      expect(storedSummary?.vector[0]).toBeCloseTo(0.6, 6);
      expect(storedSummary?.vector[1]).toBeCloseTo(0.8, 6);
      expect(storedVectors).toEqual(expect.arrayContaining([
        expect.objectContaining({ vectorField: "vec_action", vector: [0, 1] })
      ]));
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("limits exact vec0 search to the 2,000 most recently updated vectors", () => {
    const root = mkdtempSync(join(tmpdir(), "mindock-memory-vector-window-"));
    try {
      const db = new MemoryDb({ path: join(root, "memory.sqlite") });
      const repos = new Repositories(db.db);
      repos.transaction(() => {
        repos.memories.insert(traceMemory("trace_old_best", "2020-01-01T00:00:00.000Z", [1, 0]));
        for (let index = 0; index < 2_000; index += 1) {
          repos.memories.insert(traceMemory(
            `trace_recent_${index}`,
            new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
            [0, 1]
          ));
        }
      });

      const hits = repos.memories.searchVectorIds([1, 0], "vec_summary", { memoryLayer: "L1" }, 5);
      expect(hits.map((hit) => hit.id)).not.toContain("trace_old_best");
      expect(hits).toHaveLength(5);
      const queryPlan = db.db.prepare(
        `EXPLAIN QUERY PLAN
         SELECT memories.id
         FROM memory_vector_entries
         JOIN memories ON memories.id = memory_vector_entries.memory_id
         WHERE memories.deleted_at IS NULL
           AND memories.status IN ('activated', 'resolving')
           AND memories.memory_layer = 'L1'
           AND memory_vector_entries.vector_field = 'vec_summary'
         ORDER BY memory_vector_entries.updated_at DESC, memory_vector_entries.id DESC
         LIMIT 2000`
      ).all() as Array<{ detail: string }>;
      expect(queryPlan.some((step) =>
        step.detail.includes("idx_memory_vector_entries_field_updated")
      )).toBe(true);
      expect(queryPlan.some((step) => step.detail.includes("TEMP B-TREE FOR ORDER BY"))).toBe(false);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function traceMemory(
  id = "trace_indexed",
  at = "2026-06-18T00:00:00.000Z",
  vector = [1, 0]
): MemoryRow {
  return {
    id,
    timeline: at,
    userId: "user_test",
    sessionId: "session_test",
    agentId: "openclaw",
    appId: "workspace_test",
    memoryType: "LongTermMemory",
    status: "activated",
    visibility: "private",
    memoryKey: `trace:${id}`,
    memoryValue: [
      "Summary: python specialterm 科幻电影",
      "User:",
      "给我推荐一部科幻电影 specialterm",
      "Agent:",
      "可以看银翼杀手。"
    ].join("\n"),
    tags: ["trace", "turn", "python"],
    info: {
      summary: "python specialterm 科幻电影"
    },
    properties: {
      internal_info: {
        memory_layer: "L1",
        memory_kind: "trace",
        trace: {
          key: `trace:${id}`,
          ts: Date.parse(at),
          episode_id: "episode_indexed",
          step_index: 0,
          sub_step_total: 1,
          userText: "给我推荐一部科幻电影 specialterm",
          agentText: "可以看银翼杀手。",
          tool_calls: [],
          reflection: null,
          alpha: 0.5,
          summary: "python specialterm 科幻电影",
          tags: ["trace", "turn", "python"],
          value: 0.8,
          priority: 0.8,
          error_signatures: [],
          vec_summary: vector,
          vec_action: [0, 1],
          embedding_model: "test"
        }
      }
    },
    memoryLayer: "L1",
    contentHash: `${id}_hash`,
    version: 1,
    createdAt: at,
    updatedAt: at,
    deletedAt: null
  };
}

function authorityMemory(id: string, layer: MemoryLayer): MemoryRow {
  const at = "2026-06-18T00:00:00.000Z";
  const owner = layer === "L1"
    ? "trace"
    : layer === "L2"
      ? "policy"
      : layer === "L3"
        ? "world_model"
        : "skill";
  const memoryKind = layer === "L1"
    ? "trace"
    : layer === "L2"
      ? "policy"
      : layer === "L3"
        ? "world_model"
        : "skill";
  const vectors = layer === "L1"
    ? { vec_summary: [1, 0], vec_action: [0, 1] }
    : { vec: [1, 0] };
  return {
    id,
    timeline: at,
    userId: "authority-user",
    memoryType: layer === "Skill" ? "SkillMemory" : "LongTermMemory",
    status: "activated",
    visibility: "private",
    memoryKey: `${owner}:${id}`,
    memoryValue: `${layer} authoritative vector memory`,
    tags: ["authority"],
    info: {},
    properties: {
      internal_info: {
        memory_layer: layer,
        memory_kind: memoryKind,
        embedding_model: "authority-model",
        embedding_provider: "authority-provider",
        embedding_dim: 2,
        [owner]: {
          ...vectors,
          embedding_model: "authority-model",
          embedding_provider: "authority-provider",
          embedding_dim: 2,
          status: "active"
        }
      }
    },
    memoryLayer: layer,
    contentHash: `${id}-hash`,
    version: 1,
    createdAt: at,
    updatedAt: at,
    deletedAt: null
  };
}

function vectorTimestamps(db: MemoryDb, memoryId: string): Record<string, string> {
  const rows = db.db.prepare(
    `SELECT vector_field, updated_at
     FROM memory_vector_entries
     WHERE memory_id = ?`
  ).all(memoryId) as Array<{ vector_field: string; updated_at: string }>;
  return Object.fromEntries(rows.map((row) => [row.vector_field, row.updated_at]));
}
