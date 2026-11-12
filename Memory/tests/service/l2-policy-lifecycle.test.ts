import { DEVICE_MEMORY_OWNER } from "../../src/service/namespace/memory-owner.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { policyMetaFromMemory, traceMetaFromMemory } from "../../src/algorithm/plugin-algorithms.js";
import { DEFAULT_MEMMY_CONFIG } from "../../src/config/index.js";
import { PolicyInductionEngine, type PolicyInductionDeps } from "../../src/service/evolution/policy-induction.js";
import { MemoryDb } from "../../src/storage/db.js";
import { Repositories, type EvolutionJobRecord, type RawTurnRecord } from "../../src/storage/repositories.js";
import type { MemoryRow } from "../../src/types.js";

const AT = "2026-10-28T00:00:00.000Z";
function memory(id: string, layer: "L1" | "L2", data: Record<string, unknown>): MemoryRow {
  return { id, userId: DEVICE_MEMORY_OWNER, memoryLayer: layer, memoryType: "LongTermMemory", status: "activated",
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

  function linkedEvidence(options: {
    sourceOwner: string; policyOwner: string; link?: boolean; linkOwner?: string; relation?: string;
    revision?: number; sourceProject?: string; policyProject?: string; sourceProfile?: string; policyProfile?: string;
    linkedSource?: string; linkedPolicy?: string; sourceTraceIds?: string[];
  }) {
    repos.runtime.createSession({ id: "source-session", userId: options.sourceOwner, source: "codex", profileId: "default",
      status: "open", meta: {}, openedAt: AT, updatedAt: AT });
    repos.runtime.insertRawTurn({ id: "raw", sessionId: "source-session", turnId: "turn", userId: options.sourceOwner,
      toolCalls: [], toolResults: [], sourceMemoryIds: [], usage: {}, status: "succeeded", createdAt: AT });
    const source = memory("source", "L1", { value: -1, raw_turn_id: "raw" });
    source.userId = options.sourceOwner;
    source.sessionId = "source-session";
    source.info = { project_id: options.sourceProject ?? "project", profile_id: options.sourceProfile ?? "default" };
    const policy = memory("policy", "L2", { schema_version: 2, content_revision: options.revision ?? 2, lesson_type: "check",
      status: "candidate", support: 1, source_trace_ids: options.sourceTraceIds ?? ["source"],
      successful_source_trace_ids: [], gain: 0, generation_method: "model" });
    policy.userId = options.policyOwner;
    policy.info = { project_id: options.policyProject ?? "project", profile_id: options.policyProfile ?? "default" };
    repos.memories.insert(source);
    repos.memories.insert(policy);
    // Current inserts always use the device owner. Restore only these fixtures to model retained pre-upgrade rows.
    db.db.prepare(`UPDATE memories SET user_id = ? WHERE id = ?`).run(options.sourceOwner, source.id);
    db.db.prepare(`UPDATE memories SET user_id = ? WHERE id = ?`).run(options.policyOwner, policy.id);
    if (options.link !== false) {
      if (options.linkedSource) {
        const other = memory(options.linkedSource, "L1", { value: -1 });
        other.userId = "unrelated-owner";
        other.info = source.info;
        repos.memories.insert(other);
        db.db.prepare(`UPDATE memories SET user_id = ? WHERE id = ?`).run(other.userId, other.id);
      }
      if (options.linkedPolicy) repos.memories.insert(memory(options.linkedPolicy, "L2", { schema_version: 2 }));
      repos.runtime.insertTracePolicyLink({ userId: options.linkOwner ?? options.sourceOwner,
        l1MemoryId: options.linkedSource ?? source.id, l2MemoryId: options.linkedPolicy ?? policy.id,
        relation: options.relation ?? "supports:r2" });
    }
    return { source, policy };
  }

  it.each([DEVICE_MEMORY_OWNER, "historical-owner"])("preserves same-owner source metadata without a support link: %s", (owner) => {
    linkedEvidence({ sourceOwner: owner, policyOwner: owner, link: false });
    expect(policyMetaFromMemory(engine.recomputePolicyStats("policy", AT)!)).toMatchObject({
      status: "candidate", support: 1, sourceTraceIds: ["source"], skillEligible: false
    });
  });

  it.each([
    { sourceOwner: "historical-owner", policyOwner: DEVICE_MEMORY_OWNER, revision: 1, relation: "supports" },
    { sourceOwner: DEVICE_MEMORY_OWNER, policyOwner: "historical-owner", revision: 2, relation: "supports:r2" }
  ])("keeps linked evidence from $sourceOwner on $policyOwner", (options) => {
    const { source, policy } = linkedEvidence({ ...options, sourceTraceIds: [] });
    const before = repos.runtime.listTracePolicyLinks({ l2MemoryId: policy.id });
    expect(policyMetaFromMemory(engine.recomputePolicyStats(policy.id, AT)!)).toMatchObject({
      status: "candidate", support: 1, sourceTraceIds: [source.id], skillEligible: false
    });
    expect(repos.memories.get(source.id)!.userId).toBe(options.sourceOwner);
    expect(repos.memories.get(policy.id)!.userId).toBe(options.policyOwner);
    expect(repos.runtime.getRawTurn("raw")!.userId).toBe(options.sourceOwner);
    expect(repos.runtime.listTracePolicyLinks({ l2MemoryId: policy.id })).toEqual(before);
  });

  const invalidBridgeCases = ["no-link", "wrong-link-owner", "wrong-revision", "wrong-relation", "wrong-source-id", "wrong-policy-id",
    "other-project", "other-profile", "legacy-foreign", "redacted-raw", "deleted-raw", "foreign-raw-owner", "deleted-source", "disputed-source"] as const;
  for (const direction of ["historical-to-device", "device-to-historical"] as const) {
    it.each(invalidBridgeCases)(`rejects ${direction} evidence without exact current support: %s`, (failure) => {
      const sourceOwner = direction === "historical-to-device" ? "historical-owner" : DEVICE_MEMORY_OWNER;
      const policyOwner = direction === "historical-to-device" ? DEVICE_MEMORY_OWNER : "historical-owner";
      const { source } = linkedEvidence({ sourceOwner, policyOwner,
        ...(failure === "no-link" ? { link: false } : {}),
        ...(failure === "wrong-link-owner" ? { linkOwner: policyOwner } : {}),
        ...(failure === "wrong-revision" ? { revision: 3 } : {}),
        ...(failure === "wrong-relation" ? { relation: "refutes_pending" } : {}),
        ...(failure === "wrong-source-id" ? { linkedSource: "other-source" } : {}),
        ...(failure === "wrong-policy-id" ? { linkedPolicy: "other-policy" } : {}),
        ...(failure === "other-project" ? { policyProject: "other-project" } : {}),
        ...(failure === "other-profile" ? { policyProfile: "other-profile" } : {}),
        ...(failure === "legacy-foreign" ? { sourceOwner: "historical-a", policyOwner: "historical-b" } : {})
      });
      if (failure === "redacted-raw") db.db.prepare(`UPDATE raw_turns SET redacted_at = ? WHERE id = 'raw'`).run(AT);
      if (failure === "deleted-raw") db.db.prepare(`UPDATE raw_turns SET deleted_at = ? WHERE id = 'raw'`).run(AT);
      if (failure === "foreign-raw-owner") db.db.prepare(`UPDATE raw_turns SET user_id = 'unrelated-owner' WHERE id = 'raw'`).run();
      if (failure === "deleted-source") repos.memories.update({ ...source, status: "deleted", deletedAt: AT });
      if (failure === "disputed-source") repos.memories.update({ ...source,
        properties: { ...source.properties, internal_info: { ...source.properties.internal_info, evidence_status: "disputed" } } });
      expect(policyMetaFromMemory(engine.recomputePolicyStats("policy", AT)!)).toMatchObject({
        status: "quarantined", support: 0, sourceTraceIds: []
      });
    });
  }

  it("does not reimport old support links when recomputing a revised policy", () => {
    repos.memories.insert(memory("old", "L1", { value: 1, episode_id: "old-e" }));
    repos.memories.insert(memory("new", "L1", { value: -1, episode_id: "new-e" }));
    repos.memories.insert(memory("policy", "L2", { schema_version: 2, content_revision: 2, lesson_type: "principle", status: "candidate",
      source_trace_ids: ["new"], special_source_trace_ids: ["new"], successful_source_trace_ids: [], generation_method: "model",
      experience_type: "repair_instruction", evidence_polarity: "neutral", skill_eligible: false }));
    repos.runtime.insertTracePolicyLink({ userId: DEVICE_MEMORY_OWNER, l1MemoryId: "old", l2MemoryId: "policy", relation: "supports" });
    repos.runtime.insertTracePolicyLink({ userId: DEVICE_MEMORY_OWNER, l1MemoryId: "new", l2MemoryId: "policy", relation: "supports:r2" });
    const updated = engine.recomputePolicyStats("policy", AT)!;
    expect(policyMetaFromMemory(updated)?.sourceTraceIds).toEqual(["new"]);
    expect(policyMetaFromMemory(updated)?.skillEligible).toBe(false);
  });

  it("moves all pending ordinary sources of the current Episode into the unified pool", async () => {
    for (const id of ["one", "two", "foreign"]) {
      repos.memories.insert(memory(id, "L1", { value: 1, episode_id: id === "foreign" ? "other" : "e" }));
      repos.runtime.upsertCandidatePoolTrace({ id: `legacy-${id}`, userId: DEVICE_MEMORY_OWNER, sourceMemoryId: id,
        candidateKey: "old-signature", candidateValue: "source", score: 1, evidence: {}, createdAt: AT, updatedAt: AT });
    }
    await expect(engine.induceL2({ id: "job", userId: DEVICE_MEMORY_OWNER, episodeId: "e", targetMemoryId: "one", payload: {} } as EvolutionJobRecord)).rejects.toThrow();
    expect(repos.runtime.listUnifiedL2Candidates({ userId: DEVICE_MEMORY_OWNER, episodeId: "e" }).map((item) => item.sourceMemoryId).sort()).toEqual(["one", "two"]);
    expect(repos.runtime.listUnifiedL2Candidates({ userId: DEVICE_MEMORY_OWNER, episodeId: "other" })).toHaveLength(0);
  });

  it("retains low-value unlinked special evidence and excludes pending refutations from support", () => {
    repos.memories.insert(memory("source", "L1", { value: -1, episode_id: "e" }));
    repos.memories.insert(memory("conflict", "L1", { value: 1, episode_id: "other" }));
    repos.memories.insert(memory("policy", "L2", { schema_version: 2, lesson_type: "check", status: "candidate",
      source_trace_ids: ["source"], evidence_polarity: "negative", skill_eligible: false, generation_method: "model" }));
    repos.runtime.insertTracePolicyLink({ userId: DEVICE_MEMORY_OWNER, l1MemoryId: "conflict", l2MemoryId: "policy", relation: "refutes_pending" });
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
    vi.spyOn(repos.runtime, "getRawTurn").mockReturnValue({ id: "raw", userId: DEVICE_MEMORY_OWNER, redactedAt: AT } as RawTurnRecord);
    expect(policyMetaFromMemory(engine.recomputePolicyStats("policy", AT)!)).toMatchObject({ status: "quarantined", support: 0 });
  });
});
