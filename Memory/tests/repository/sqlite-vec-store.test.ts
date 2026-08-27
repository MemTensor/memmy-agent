import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryDb } from "../../src/index.js";
import { Repositories } from "../../src/storage/repositories.js";
import {
  bufferToVector,
  vectorToBuffer,
  type SerializedMemoryVector,
  type VectorSearchCandidate
} from "../../src/storage/sqlite-vec-store.js";
import type { MemoryRow } from "../../src/types.js";

describe("sqlite-vec storage adapter", () => {
  it("returns exact cosine top-k results and ignores incompatible dimensions", () => {
    withDatabase(({ db, repos }) => {
      for (const id of ["exact", "angled", "orthogonal", "three_dimensional"]) {
        repos.memories.insert(bareMemory(id));
      }
      repos.vectors.upsert("exact", vectorValue([1, 0]), timestamp(1));
      repos.vectors.upsert("angled", vectorValue([0.8, 0.6]), timestamp(2));
      repos.vectors.upsert("orthogonal", vectorValue([0, 1]), timestamp(3));
      repos.vectors.upsert("three_dimensional", vectorValue([1, 0, 0]), timestamp(4));

      const candidates = vectorCandidates(db, [
        "exact",
        "angled",
        "orthogonal",
        "three_dimensional"
      ]);
      const hits = repos.vectors.search([1, 0], candidates, 2);

      expect(hits.map((hit) => hit.id)).toEqual(["exact", "angled"]);
      expect(hits[0]!.score).toBeCloseTo(1, 6);
      expect(hits[1]!.score).toBeCloseTo(0.8, 6);
      expect(repos.vectors.search([1, 0, 0], candidates, 2)).toEqual([
        { id: "three_dimensional", score: 1 }
      ]);
    });
  });

  it("replaces vector dimensions without leaving old vec0 rows", () => {
    withDatabase(({ db, repos }) => {
      repos.memories.insert(bareMemory("dimension_change"));
      repos.vectors.upsert("dimension_change", vectorValue([1, 0]), timestamp(1));
      const oldEntry = vectorEntry(db, "dimension_change", "vec");
      expect(rowCount(db, "memory_vec_2")).toBe(1);

      repos.vectors.upsert("dimension_change", vectorValue([1, 0, 0]), timestamp(2));

      const replacement = vectorEntry(db, "dimension_change", "vec");
      expect(replacement.embedding_dim).toBe(3);
      expect(rowCount(db, "memory_vec_2")).toBe(0);
      expect(rowCount(db, "memory_vec_3")).toBe(1);
      expect(db.prepare(`SELECT COUNT(*) AS count FROM memory_vector_entries`).get())
        .toEqual({ count: 1 });
      expect(repos.vectors.search([1, 0], [{
        id: oldEntry.id,
        memoryId: "dimension_change",
        embeddingDim: 2
      }], 1)).toEqual([]);
    });
  });

  it("validates vectors and rolls back an invalid import atomically", () => {
    withDatabase(({ db, repos }) => {
      repos.memories.insert(bareMemory("valid_import"));
      repos.memories.insert(bareMemory("invalid_import"));

      expect(() => repos.vectors.upsert("valid_import", vectorValue([]), timestamp(1)))
        .toThrow("vector must contain finite values");
      expect(() => repos.vectors.upsert("valid_import", vectorValue([1, Number.NaN]), timestamp(1)))
        .toThrow("vector must contain finite values");

      const rows: SerializedMemoryVector[] = [
        serializedVector("valid_import", [1, 0], 2),
        serializedVector("invalid_import", [0, 1], 3)
      ];
      expect(() => repos.vectors.importRows(rows))
        .toThrow("invalid vector dimension for invalid_import:vec");
      expect(db.prepare(`SELECT COUNT(*) AS count FROM memory_vector_entries`).get())
        .toEqual({ count: 0 });
      for (const table of vectorTables(db)) {
        expect(rowCount(db, table)).toBe(0);
      }
    });
  });

  it("round-trips serialized vectors and deletes both mapping and vec0 rows", () => {
    withDatabase(({ db, repos }) => {
      repos.memories.insert(bareMemory("roundtrip"));
      repos.vectors.upsert("roundtrip", {
        vectorField: "vec_summary",
        vector: [0.25, 0.5],
        embeddingModel: "embedding-model",
        embeddingProvider: "embedding-provider"
      }, timestamp(1));
      repos.vectors.upsert("roundtrip", {
        vectorField: "vec_action",
        vector: [0, 1],
        embeddingModel: "embedding-model",
        embeddingProvider: "embedding-provider"
      }, timestamp(2));

      const exported = repos.vectors.exportRows();
      expect(exported).toHaveLength(2);
      expect(bufferToVector(Buffer.from(exported[0]!.embedding, "base64"))).toEqual([0.25, 0.5]);

      repos.vectors.deleteMemory("roundtrip");
      expect(db.prepare(`SELECT COUNT(*) AS count FROM memory_vector_entries`).get())
        .toEqual({ count: 0 });
      expect(rowCount(db, "memory_vec_2")).toBe(0);

      repos.vectors.importRows(exported);
      expect(repos.vectors.getMany(["roundtrip"]).get("roundtrip"))
        .toEqual([
          {
            vectorField: "vec_summary",
            vector: [0.25, 0.5],
            embeddingModel: "embedding-model",
            embeddingProvider: "embedding-provider"
          },
          {
            vectorField: "vec_action",
            vector: [0, 1],
            embeddingModel: "embedding-model",
            embeddingProvider: "embedding-provider"
          }
        ]);

      repos.vectors.delete("roundtrip", "vec_summary");
      expect(repos.vectors.getMany(["roundtrip"]).get("roundtrip"))
        .toEqual([expect.objectContaining({ vectorField: "vec_action", vector: [0, 1] })]);
      repos.vectors.deleteMemory("roundtrip");
      expect(rowCount(db, "memory_vec_2")).toBe(0);
      expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
    });
  });

  it("keeps readers available during WAL vector replacement and deletion", () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-sqlite-vec-concurrency-"));
    const path = join(root, "memory.sqlite");
    const writerDb = new MemoryDb({ path });
    const readerDb = new MemoryDb({ path });
    try {
      const writer = new Repositories(writerDb.db);
      const reader = new Repositories(readerDb.db);
      writer.memories.insert(bareMemory("concurrent"));
      writer.vectors.upsert("concurrent", vectorValue([1, 0]), timestamp(1));
      expect(writerDb.db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(reader.memories.searchVectorIds([1, 0], "vec", { memoryLayer: "L2" }, 1)[0]?.score)
        .toBeCloseTo(1, 6);

      writer.transaction(() => {
        writer.vectors.upsert("concurrent", vectorValue([0, 1]), timestamp(2));
        expect(reader.memories.searchVectorIds([1, 0], "vec", { memoryLayer: "L2" }, 1)[0]?.score)
          .toBeCloseTo(1, 6);
      });
      expect(reader.memories.searchVectorIds([0, 1], "vec", { memoryLayer: "L2" }, 1)[0]?.score)
        .toBeCloseTo(1, 6);

      writer.transaction(() => {
        writer.vectors.deleteMemory("concurrent");
        expect(reader.memories.searchVectorIds([0, 1], "vec", { memoryLayer: "L2" }, 1))
          .toHaveLength(1);
      });
      expect(reader.memories.searchVectorIds([0, 1], "vec", { memoryLayer: "L2" }, 1))
        .toEqual([]);
      expect(writerDb.db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
    } finally {
      readerDb.close();
      writerDb.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function withDatabase(run: (context: {
  db: MemoryDb["db"];
  repos: Repositories;
}) => void): void {
  const root = mkdtempSync(join(tmpdir(), "memmy-sqlite-vec-store-"));
  const memoryDb = new MemoryDb({ path: join(root, "memory.sqlite") });
  try {
    run({ db: memoryDb.db, repos: new Repositories(memoryDb.db) });
  } finally {
    memoryDb.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function bareMemory(id: string): MemoryRow {
  const at = timestamp(0);
  return {
    id,
    timeline: at,
    userId: "vector-user",
    memoryType: "LongTermMemory",
    status: "activated",
    visibility: "private",
    memoryKey: `policy:${id}`,
    memoryValue: id,
    tags: ["vector"],
    info: {},
    properties: {
      internal_info: {
        memory_layer: "L2",
        memory_kind: "policy",
        policy: { status: "active" }
      }
    },
    memoryLayer: "L2",
    contentHash: `${id}-hash`,
    version: 1,
    createdAt: at,
    updatedAt: at,
    deletedAt: null
  };
}

function vectorValue(vector: number[]) {
  return {
    vectorField: "vec" as const,
    vector,
    embeddingModel: "test-model",
    embeddingProvider: "test-provider"
  };
}

function serializedVector(memoryId: string, vector: number[], embeddingDim: number): SerializedMemoryVector {
  return {
    memory_id: memoryId,
    vector_field: "vec",
    embedding: vectorToBuffer(vector).toString("base64"),
    embedding_model: "test-model",
    embedding_provider: "test-provider",
    embedding_dim: embeddingDim,
    updated_at: timestamp(1)
  };
}

function vectorCandidates(db: MemoryDb["db"], memoryIds: string[]): VectorSearchCandidate[] {
  const rows = db.prepare(
    `SELECT id, memory_id, embedding_dim
     FROM memory_vector_entries
     WHERE memory_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`
  ).all(JSON.stringify(memoryIds)) as Array<{
    id: number;
    memory_id: string;
    embedding_dim: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    memoryId: row.memory_id,
    embeddingDim: row.embedding_dim
  }));
}

function vectorEntry(
  db: MemoryDb["db"],
  memoryId: string,
  vectorField: "vec" | "vec_summary" | "vec_action"
): { id: number; embedding_dim: number } {
  return db.prepare(
    `SELECT id, embedding_dim
     FROM memory_vector_entries
     WHERE memory_id = ? AND vector_field = ?`
  ).get(memoryId, vectorField) as { id: number; embedding_dim: number };
}

function vectorTables(db: MemoryDb["db"]): string[] {
  return (db.prepare(
    `SELECT name
     FROM sqlite_master
     WHERE type = 'table'
       AND name GLOB 'memory_vec_[0-9]*'
       AND sql LIKE 'CREATE VIRTUAL TABLE%USING vec0%'`
  ).all() as Array<{ name: string }>).map((row) => row.name);
}

function rowCount(db: MemoryDb["db"], table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function timestamp(offset: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, offset)).toISOString();
}
