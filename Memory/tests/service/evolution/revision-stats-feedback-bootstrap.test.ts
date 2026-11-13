import { describe, expect, it } from "vitest";
import { DEFAULT_MEMMY_CONFIG } from "../../../src/config/index.js";
import { policyMetaFromMemory, skillMetaFromMemory } from "../../../src/algorithm/plugin-algorithms.js";
import { policyUsesSpecialEvidence } from "../../../src/service/evolution/policy-evidence.js";
import { policyRevisionHistory, revisePolicyFeedback, revisePolicyStatistics, reviseSkillPolicy,
  withRevisionHistory, type PolicyInput } from "../../../src/service/evolution/revision-stats.js";
import type { MemoryRow } from "../../../src/types.js";

function legacyFeedbackExperience(): MemoryRow {
  // This is the supported shape written by feedback-experience.ts insertFeedbackExperiencePolicy:
  // source_feedback_ids and supporting provenance exist, but schema_version and
  // successful_episode_count are not written until the statistics pipeline runs.
  return { id: "legacy-feedback-policy", userId: "u", memoryLayer: "L2", memoryType: "LongTermMemory",
    memoryValue: "Follow the user's explicit preference", status: "resolving", visibility: "private",
    tags: [], info: {}, version: 1, createdAt: "2026-11-10", updatedAt: "2026-11-10", timeline: "2026-11-10",
    properties: { internal_info: { memory_layer: "L2", source: "feedback.experience.v1",
      policy: { status: "candidate", gain: 0.8, raw_gain: 0.8, support: 1,
        experience_type: "preference", evidence_polarity: "positive", source_feedback_ids: ["feedback-origin"],
        source_episode_ids: ["A"], source_trace_ids: ["trace-A"], induced_by: "feedback.experience.v1", skill_eligible: true } } } };
}
function skill(): MemoryRow {
  return { ...legacyFeedbackExperience(), id: "skill", memoryLayer: "Skill", status: "activated",
    properties: { internal_info: { memory_layer: "Skill", skill: { status: "active", eta: 0.8,
      source_policy_ids: ["legacy-feedback-policy"], trials_attempted: 0, trials_passed: 0 } } } };
}
function savePolicy(memory: MemoryRow, result: NonNullable<ReturnType<typeof revisePolicyStatistics>>) {
  const next = structuredClone(memory);
  Object.assign(next.properties.internal_info.policy as object, { gain: result.gain, raw_gain: result.rawGain,
    support: result.support, status: result.status,
    ...(result.successfulSupport !== undefined ? { successful_episode_count: result.successfulSupport } : {}) });
  return withRevisionHistory(next, "policy_revision_history", result.history);
}
function drift(memory: MemoryRow, policy: MemoryRow) {
  const result = reviseSkillPolicy(memory, policy, DEFAULT_MEMMY_CONFIG.algorithm.skill.archiveEta);
  const next = structuredClone(memory);
  Object.assign(next.properties.internal_info.skill as object, { eta: result.eta, status: result.status,
    trials_attempted: result.trialsAttempted, trials_passed: result.trialsPassed });
  return withRevisionHistory(next, "skill_revision_history", result.history);
}

describe("recall feedback before a legacy special experience's first statistical update", () => {
  it("does not interpret an absent successful count's default zero as an external intervention", () => {
    let p = legacyFeedbackExperience();
    expect(policyUsesSpecialEvidence(policyMetaFromMemory(p)!)).toBe(true);
    expect((p.properties.internal_info.policy as Record<string, unknown>).successful_episode_count).toBeUndefined();
    expect(policyRevisionHistory(p)).toBeUndefined();
    p = savePolicy(p, revisePolicyFeedback(p, { id: "recall:first-feedback", delta: 0.02,
      minSupport: 1, minGain: 0.02, archiveGain: -0.05 }));
    let s = drift(skill(), p);
    expect(skillMetaFromMemory(s)!.eta).toBeCloseTo(0.7 * 0.8 + 0.3 * 0.82, 12);
    const rows = [{ id: "trace-A", episodeId: "A", value: 1 }];
    const input: PolicyInput = { evidence: rows, reference: rows, supportingEvidence: rows, sourceGroups: ["A"], ruleFallback: false,
      parameters: { minSupport: 1, minGain: 0.02, archiveGain: -0.05, gainEmaAlpha: 0.4, tauSoftmax: 0.5 } };
    p = savePolicy(p, revisePolicyStatistics(p, input, "A")!); s = drift(s, p);
    expect.soft(policyRevisionHistory(p)!.events.some(event => event.type === "checkpoint")).toBe(false);
    expect.soft(policyRevisionHistory(p)!.events.map(event => event.type ?? "update")).toEqual(["feedback", "update"]);
    expect(policyMetaFromMemory(p)!.gain).toBeCloseTo(0.5, 12);
    expect.soft(skillMetaFromMemory(s)!.eta).toBeCloseTo(0.7 * (0.7 * 0.8 + 0.3 * 0.82) + 0.3 * 0.5, 12);
    expect(revisePolicyStatistics(p, input, "A")).toBeUndefined();
  });
  it.each([
    { field: "successful_episode_count", value: 1, expected: { successfulSupport: 1 } },
    { field: "gain", value: 0.73, expected: { gain: 0.73 } }
  ])("still checkpoints a real external $field change after the feedback bootstrap", ({ field, value, expected }) => {
    let p = legacyFeedbackExperience();
    p = savePolicy(p, revisePolicyFeedback(p, { id: "recall:first-feedback", delta: 0.02,
      minSupport: 1, minGain: 0.02, archiveGain: -0.05 }));
    // A nonzero explicit count is not the absent field's default zero. Likewise,
    // default normalization cannot hide an independently edited numerical gain.
    Object.assign(p.properties.internal_info.policy as object, { [field]: value });
    const rows = [{ id: "trace-A", episodeId: "A", value: 1 }];
    const input: PolicyInput = { evidence: rows, reference: rows, supportingEvidence: rows, sourceGroups: ["A"], ruleFallback: false,
      parameters: { minSupport: 1, minGain: 0.02, archiveGain: -0.05, gainEmaAlpha: 0.4, tauSoftmax: 0.5 } };
    p = savePolicy(p, revisePolicyStatistics(p, input, "A")!);
    const checkpoints = policyRevisionHistory(p)!.events.filter(event => event.type === "checkpoint");
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({ type: "checkpoint", state: expected });
  });

});
