import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { policyMetaFromMemory, traceMetaFromMemory } from "../../src/algorithm/plugin-algorithms.js";
import { DEFAULT_MEMMY_CONFIG } from "../../src/config/index.js";
import { PolicyInductionEngine, type PolicyInductionDeps } from "../../src/service/evolution/policy-induction.js";
import { MemoryDb } from "../../src/storage/db.js";
import { Repositories, type EvolutionJobRecord, type RawTurnRecord } from "../../src/storage/repositories.js";
import type { MemoryRow } from "../../src/types.js";

const AT = "2026-10-28T00:00:00.000Z";
function memory(id: string, layer: "L1" | "L2", data: Record<string, unknown>): MemoryRow {
  return { id, userId: "u", memoryLayer: layer, memoryType: "LongTermMemory", status: "activated",
    visibility: "private", timeline: AT, memoryValue: "Source-backed check", tags: [], info: {}, version: 1,
    createdAt: AT, updatedAt: AT,
    properties: { internal_info: { memory_layer: layer, [layer === "L1" ? "trace" : "policy"]: data } } };
}

describe("unified L2 evidence lifecycle", () => {
  let db: MemoryDb, repos: Repositories, engine: PolicyInductionEngine;
  beforeEach(() => {
    db = new MemoryDb({ path: ":memory:" }); repos = new Repositories(db.db);
    const config = structuredClone(DEFAULT_MEMMY_CONFIG);
    config.algorithm.l2Induction.minEpisodesForActivation = 2;
    config.algorithm.l2Induction.minGain = -1;
    engine = new PolicyInductionEngine({ repos, config, nowIso: () => AT, skillLlm: { isConfigured: () => false }, traceMeta: (row: MemoryRow | null | undefined) => row ? traceMetaFromMemory(row) : null,
      namespaceIdFromMemory: () => undefined, enqueueChange: vi.fn(), enqueueJob: vi.fn(), onSkillRewardDrift: vi.fn()
    } as unknown as PolicyInductionDeps);
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });

  it("does not reimport old support links when recomputing a revised policy", () => {
    repos.memories.insert(memory("old", "L1", { value: 1, episode_id: "old-e" }));
    repos.memories.insert(memory("new", "L1", { value: -1, episode_id: "new-e" }));
    repos.memories.insert(memory("policy", "L2", { schema_version: 2, content_revision: 2, lesson_type: "principle", status: "candidate",
      source_trace_ids: ["new"], special_source_trace_ids: ["new"], successful_source_trace_ids: [], generation_method: "model",
      experience_type: "repair_instruction", evidence_polarity: "neutral", skill_eligible: false }));
    repos.runtime.insertTracePolicyLink({ userId: "u", l1MemoryId: "old", l2MemoryId: "policy", relation: "supports" });
    repos.runtime.insertTracePolicyLink({ userId: "u", l1MemoryId: "new", l2MemoryId: "policy", relation: "supports:r2" });
    const updated = engine.recomputePolicyStats("policy", AT)!;
    expect(policyMetaFromMemory(updated)?.sourceTraceIds).toEqual(["new"]);
    expect(policyMetaFromMemory(updated)?.skillEligible).toBe(false);
  });

  it("moves all pending ordinary sources of the current Episode into the unified pool", async () => {
    for (const id of ["one", "two", "foreign"]) {
      repos.memories.insert(memory(id, "L1", { value: 1, episode_id: id === "foreign" ? "other" : "e" }));
      repos.runtime.upsertCandidatePoolTrace({ id: `legacy-${id}`, userId: "u", sourceMemoryId: id,
        candidateKey: "old-signature", candidateValue: "source", score: 1, evidence: {}, createdAt: AT, updatedAt: AT });
    }
    await expect(engine.induceL2({ id: "job", userId: "u", episodeId: "e", targetMemoryId: "one", payload: {} } as EvolutionJobRecord)).rejects.toThrow();
    expect(repos.runtime.listUnifiedL2Candidates({ userId: "u", episodeId: "e" }).map((item) => item.sourceMemoryId).sort()).toEqual(["one", "two"]);
    expect(repos.runtime.listUnifiedL2Candidates({ userId: "u", episodeId: "other" })).toHaveLength(0);
  });

  it("retains low-value unlinked special evidence and excludes pending refutations from support", () => {
    repos.memories.insert(memory("source", "L1", { value: -1, episode_id: "e" }));
    repos.memories.insert(memory("conflict", "L1", { value: 1, episode_id: "other" }));
    repos.memories.insert(memory("policy", "L2", { schema_version: 2, lesson_type: "check", status: "candidate",
      source_trace_ids: ["source"], evidence_polarity: "negative", skill_eligible: false, generation_method: "model" }));
    repos.runtime.insertTracePolicyLink({ userId: "u", l1MemoryId: "conflict", l2MemoryId: "policy", relation: "refutes_pending" });
    const saved = engine.recomputePolicyStats("policy", AT)!;
    expect(policyMetaFromMemory(saved)).toMatchObject({ status: "candidate", support: 1, sourceTraceIds: ["source"] });
    expect(saved.info).toMatchObject({ successful_episode_count: 0, pending_conflict_count: 1, gain_status: "not_computed" });
  });

  it("preserves old positive feedback sources without applying ordinary value admission", () => {
    repos.memories.insert(memory("source", "L1", { value: -1, episode_id: "e" }));
    repos.memories.insert(memory("policy", "L2", { status: "active", experience_type: "success_pattern",
      source_trace_ids: ["source"], source_feedback_ids: ["feedback"], gain: 0.1, skill_eligible: true }));
    expect(policyMetaFromMemory(engine.recomputePolicyStats("policy", AT)!)).toMatchObject({ status: "active", sourceTraceIds: ["source"] });
  });

  it("allows a special-origin candidate to advance after independent successful support", () => {
    for (const id of ["one", "two"]) repos.memories.insert(memory(id, "L1", { value: 1, episode_id: id }));
    repos.memories.insert(memory("policy", "L2", { schema_version: 2, lesson_type: "troubleshooting", status: "candidate",
      source_trace_ids: ["one", "two"], successful_source_trace_ids: ["one", "two"],
      generation_method: "model", experience_type: "failure_avoidance", evidence_polarity: "negative", skill_eligible: false }));
    expect(policyMetaFromMemory(engine.recomputePolicyStats("policy", AT)!)).toMatchObject({ status: "active",
      skillEligible: true, experienceType: "repair_validated", evidencePolarity: "mixed" });
  });

  it("withdraws evidence when its raw turn was redacted", () => {
    repos.memories.insert(memory("source", "L1", { value: 1, episode_id: "e", raw_turn_id: "raw" }));
    repos.memories.insert(memory("policy", "L2", { schema_version: 2, status: "candidate", source_trace_ids: ["source"] }));
    vi.spyOn(repos.runtime, "getRawTurn").mockReturnValue({ id: "raw", userId: "u", redactedAt: AT } as RawTurnRecord);
    expect(policyMetaFromMemory(engine.recomputePolicyStats("policy", AT)!)).toMatchObject({ status: "quarantined", support: 0 });
  });
});
