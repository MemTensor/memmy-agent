import { describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../../src/storage/db.js";
import { Repositories } from "../../src/storage/repositories.js";
import { SqliteVecStore } from "../../src/storage/sqlite-vec-store.js";
import type { MemoryRow } from "../../src/types.js";

const reflected = { reflection: "IRRELEVANT" };
const historical = { source: "openclaw", source_id: "legacy-trace" };
const scored = { value: 0, alpha: 0, reflectionDone: true };
const scenarios: Array<{
  name: string;
  trace?: Record<string, unknown>;
  internal?: Record<string, unknown>;
  info?: Record<string, unknown>;
  expected: { value: number; alpha: number; reflectionDone: boolean };
}> = [
  { name: "recorded trace zero", trace: { ...reflected, r_human: 0 }, expected: scored },
  { name: "recorded top-level zero", internal: { r_human: 0 }, expected: { ...scored, reflectionDone: false } },
  { name: "recorded info zero", info: { r_human: 0 }, expected: { ...scored, reflectionDone: false } },
  { name: "historical reflected zero", trace: reflected, internal: { legacy_import: historical }, expected: scored },
  { name: "explicit missing reward", trace: { ...reflected, r_human: null }, internal: { legacy_import: historical },
    expected: scored },
  { name: "initial pending", trace: { r_human: null }, internal: { legacy_import: historical },
    expected: { ...scored, reflectionDone: false } },
  { name: "historical pending", internal: { legacy_import: historical },
    expected: { ...scored, reflectionDone: false } },
  { name: "scored reflection without prose", trace: { r_human: null, reflection_scored_at: "2026-11-01T00:00:00Z" },
    expected: { ...scored, reflectionDone: false } },
  { name: "nonzero", trace: { ...reflected, value: 0.25, alpha: 0.5, r_human: null },
    expected: { value: 0.25, alpha: 0.5, reflectionDone: true } },
  { name: "unrecognized historical source", trace: reflected, internal: { legacy_import: { source: "unknown", source_id: "legacy-trace" } },
    expected: scored }
];

describe("panel score projection evidence", () => {
  it.each(scenarios)("preserves $name without loading vectors or unrelated metadata", scenario => {
    const db = new MemoryDb({ path: ":memory:" });
    const at = "2026-11-01T00:00:00Z";
    try {
      const repos = new Repositories(db.db);
      const trace: Record<string, unknown> = { value: 0, alpha: 0, ...scenario.trace, unrelated_debug: "unrelated-score-secret" };
      const memory: MemoryRow = {
        id: "trace-projection", timeline: at, userId: "test-owner", memoryType: "LongTermMemory",
        memoryLayer: "L1", memoryValue: "A stored trace", status: "activated", visibility: "private",
        version: 1, createdAt: at, updatedAt: at, tags: [], info: { ...scenario.info },
        properties: { internal_info: { memory_layer: "L1", memory_kind: "trace", trace, ...scenario.internal } }
      };
      repos.memories.insert(memory);
      const full = repos.memories.get(memory.id)!;
      const canonicalMetrics = repos.memories.toListItem(full).metrics;
      expect(canonicalMetrics).toMatchObject(scenario.expected);
      const vectors = vi.spyOn(SqliteVecStore.prototype, "getMany").mockImplementation(() => {
        throw new Error("Panel projection must not hydrate vectors");
      });
      try {
        const projected = repos.memories.getManyForPanel([memory.id])[0]!;
        expect(repos.memories.toListItem(projected).metrics).toEqual(canonicalMetrics);
        const projectedTrace = projected.properties.internal_info.trace as Record<string, unknown>;
        if (Object.hasOwn(trace, "r_human")) expect(projectedTrace.r_human).toEqual(trace.r_human);
        if (scenario.trace?.reflection_scored_at) {
          expect(projectedTrace.reflection_scored_at).toBe(scenario.trace.reflection_scored_at);
        }
        if (scenario.internal?.legacy_import) {
          expect(projected.properties.internal_info.legacy_import).toEqual(scenario.internal.legacy_import);
        }
        if (scenario.internal?.r_human === 0) expect(projected.properties.internal_info.r_human).toBe(0);
        if (scenario.info?.r_human === 0) expect(projected.info.r_human).toBe(0);
        expect(Object.hasOwn(projected.properties.internal_info.trace as object, "r_human"))
          .toBe(Object.hasOwn(trace, "r_human"));
        expect(JSON.stringify(projected)).not.toContain("unrelated-score-secret");
        expect(vectors).not.toHaveBeenCalled();
      } finally { vectors.mockRestore(); }
    } finally { db.close(); }
  });
});
