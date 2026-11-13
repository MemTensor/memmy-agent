import { FeedbackExperienceService } from "../../src/service/feedback/feedback-experience.js";
import { createBatchReflectionLlm, createCapturingEmbedder } from "../fixtures/memory-service-fixture.js";
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

  it("withdraws only inferred failed Episode support and restores it after a later failure", () => {
    repos.runtime.createSession({ id: "negative-session", userId: DEVICE_MEMORY_OWNER, source: "codex", profileId: "default",
      status: "closed", meta: {}, openedAt: AT, closedAt: AT, updatedAt: AT });
    for (const id of ["A", "B"]) {
      repos.runtime.createEpisode({ id, userId: DEVICE_MEMORY_OWNER, sessionId: "negative-session", status: "closed",
        l1MemoryIds: [id], rawTurnIds: [], feedbackIds: [], decisionRepairIds: [], l2PolicyIds: [], l3WorldModelIds: [],
        skillMemoryIds: [], turnCount: 1, rTask: -1, rewardDetail: {}, pipelineStatus: "idle", meta: {}, openedAt: AT, closedAt: AT, updatedAt: AT });
      repos.memories.insert(memory(id, "L1", { episode_id: id, value: -1 }));
    }
    repos.memories.insert(memory("negative-policy", "L2", { schema_version: 2, content_revision: 1,
      status: "candidate", support: 2, gain: 0, raw_gain: 0, source_trace_ids: ["A", "B"],
      experience_type: "failure_avoidance", special_source_trace_ids: ["A", "B"],
      source_admissions: Object.fromEntries(["A", "B"].map(id => [id, { routes: ["negative"],
        signals: [{ eventId: id, sourceBasis: "implicit_failure_analysis" }] }])) }));
    for (const id of ["A", "B"]) repos.runtime.insertTracePolicyLink({ userId: DEVICE_MEMORY_OWNER,
      l1MemoryId: id, l2MemoryId: "negative-policy", relation: "supports", createdAt: AT });
    repos.runtime.updateEpisodeReward("A", { rTask: 1, rewardDetail: {} }, AT);
    expect(policyMetaFromMemory(engine.recomputePolicyStats("negative-policy", AT)!)).toMatchObject({ support: 1, sourceTraceIds: ["B"] });
    repos.runtime.updateEpisodeReward("B", { rTask: 1, rewardDetail: {} }, AT);
    expect(policyMetaFromMemory(engine.recomputePolicyStats("negative-policy", AT)!)).toMatchObject({ support: 0, status: "quarantined" });
    repos.runtime.updateEpisodeReward("A", { rTask: -1, rewardDetail: {} }, AT);
    expect(policyMetaFromMemory(engine.recomputePolicyStats("negative-policy", AT)!)).toMatchObject({ support: 1, sourceTraceIds: ["A"] });
  });

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

  it("MEMMY-647 does not smooth identical policy evidence twice", () => {
    const { source, policy } = linkedEvidence({ sourceOwner: DEVICE_MEMORY_OWNER, policyOwner: DEVICE_MEMORY_OWNER });
    repos.memories.update({ ...repos.memories.get(source.id)!, properties: { internal_info: { memory_layer: "L1", trace: {
      value: 1, raw_turn_id: "raw", episode_id: "episode-647", reflection: "PIVOTAL", alpha: 1
    } } } });
    const saved = repos.memories.get(policy.id)!;
    repos.memories.update({ ...saved, properties: { ...saved.properties, internal_info: { ...saved.properties.internal_info,
      policy: { ...saved.properties.internal_info.policy as Record<string, unknown>, gain: 0.2,
        successful_episode_count: 1, successful_source_trace_ids: [source.id] }
    } } });
    const once = policyMetaFromMemory(engine.recomputePolicyStats(policy.id, AT)!)!;
    const twice = policyMetaFromMemory(engine.recomputePolicyStats(policy.id, AT)!)!;
    expect(twice.support).toBe(once.support);
    expect(twice.gain).toBe(once.gain);
    const currentSource = repos.memories.get(source.id)!;
    repos.memories.update({ ...currentSource, status: "archived" });
    const withdrawn = policyMetaFromMemory(engine.recomputePolicyStats(policy.id, AT)!)!;
    expect(withdrawn.support).toBe(0);
    expect(withdrawn.gain).toBeCloseTo(0.2);
  });

  it.each(["none", "feedback", "manual"] as const)("MEMMY-647 revises A in its original position while retaining B and %s", kind => {
    const { source, policy } = linkedEvidence({ sourceOwner: DEVICE_MEMORY_OWNER, policyOwner: DEVICE_MEMORY_OWNER });
    function setA(value: number) {
      const row = repos.memories.get(source.id)!;
      repos.memories.update({ ...row, properties: { ...row.properties, internal_info: { ...row.properties.internal_info,
        trace: { value, raw_turn_id: "raw", episode_id: "episode-A", reflection: "PIVOTAL", alpha: 1 } } } });
    }
    const row = repos.memories.get(policy.id)!;
    repos.memories.update({ ...row, properties: { ...row.properties, internal_info: { ...row.properties.internal_info,
      policy: { ...row.properties.internal_info.policy as Record<string, unknown>, gain: 0.2,
        successful_episode_count: 1, successful_source_trace_ids: [source.id] } } } });
    setA(1);
    expect(policyMetaFromMemory(engine.recomputePolicyStats(policy.id, AT)!)!.gain).toBeCloseTo(0.32);
    repos.memories.insert(memory("B", "L1", { value: 0.8, episode_id: "episode-B", reflection: "PIVOTAL", alpha: 1 }));
    const withA = repos.memories.get(policy.id)!;
    repos.memories.update({ ...withA, properties: { ...withA.properties, internal_info: { ...withA.properties.internal_info,
      policy: { ...withA.properties.internal_info.policy as Record<string, unknown>,
        source_trace_ids: [source.id, "B"], successful_source_trace_ids: [source.id, "B"] } } } });
    expect(policyMetaFromMemory(engine.recomputePolicyStats(policy.id, AT)!)!.gain).toBeCloseTo(0.352);
    if (kind === "feedback") {
      const unexpected = (): never => { throw new Error("unexpected dependency in recall outcome"); };
      const feedbackService = new FeedbackExperienceService({ repos, config: DEFAULT_MEMMY_CONFIG,
        skillLlm: createBatchReflectionLlm([]), embedder: createCapturingEmbedder([], []),
        memoryAddEnabled: () => true, resolveContext: unexpected, assertSessionInScope: unexpected,
        assertEpisodeInScope: unexpected, assertRawTurnInScope: unexpected, assertMemoryInScope: unexpected,
        requireEpisode: unexpected, requireRawTurn: unexpected, requireExistingMemory: unexpected,
        traceMeta: traceMetaFromMemory, buildMemory: unexpected, enqueueJob: unexpected, encodeChangeCursor: unexpected,
        readOnlyCursor: unexpected, findExistingSkillForPolicy: unexpected, upsertEvolutionMemory: unexpected,
        pendingTrialsForFeedback: unexpected, shouldDeferBudgetedEvolutionLlm: () => false });
      const event = { id: "recall-647", userId: DEVICE_MEMORY_OWNER, query: "check", layers: ["L2" as const],
        hitMemoryIds: [policy.id], outcome: "positive" as const, request: {}, createdAt: AT };
      const feedback = { id: "feedback-647", userId: DEVICE_MEMORY_OWNER, channel: "explicit" as const,
        polarity: "positive" as const, magnitude: 1, rawPayload: {}, createdAt: AT };
      feedbackService.applyRecallOutcome(event, feedback, AT);
      feedbackService.applyRecallOutcome(event, feedback, AT);
      expect(policyMetaFromMemory(repos.memories.get(policy.id)!)!.gain).toBeCloseTo(0.372);
    }
    if (kind === "manual") {
      const saved = repos.memories.get(policy.id)!;
      repos.memories.update({ ...saved, properties: { ...saved.properties, internal_info: { ...saved.properties.internal_info,
        policy: { ...saved.properties.internal_info.policy as Record<string, unknown>, gain: 0.372 } } } });
    }
    setA(0.4);
    const revised = policyMetaFromMemory(engine.recomputePolicyStats(policy.id, AT)!)!;
    // Original baseline .2 -> revised A raw 0: .12 -> A+B raw .1: .112.
    expect(revised.gain).toBeCloseTo(kind === "none" ? 0.112 : kind === "feedback" ? 0.132 : 0.372);
    expect(revised.sourceTraceIds).toEqual([source.id, "B"]);
    expect(revised.support).toBe(2);
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
