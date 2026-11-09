import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG } from "../../../src/config/index.js";
import { policyMetaFromMemory, skillMetaFromMemory, traceMetaFromMemory } from "../../../src/algorithm/plugin-algorithms.js";
import { PolicyInductionEngine, type PolicyInductionDeps } from "../../../src/service/evolution/policy-induction.js";
import { SkillPipeline } from "../../../src/service/evolution/skill-pipeline.js";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories } from "../../../src/storage/repositories.js";
import type { MemoryRow } from "../../../src/types.js";
const AT = "2026-11-09T00:00:00.000Z";
function row(id: string, layer: "L1" | "L2" | "Skill", data: Record<string, unknown>): MemoryRow {
  return { id, userId: "u", memoryLayer: layer, memoryType: "LongTermMemory", status: "activated", visibility: "private",
    timeline: AT, memoryValue: "check the certificate", tags: [], info: {}, version: 1, createdAt: AT, updatedAt: AT,
    properties: { internal_info: { memory_layer: layer, generated_by_memory_base: true, [layer === "L1" ? "trace" : layer === "L2" ? "policy" : "skill"]: data } } };
}
describe("policy contribution lifecycle across record formats", () => {
  let db: MemoryDb, repos: Repositories, engine: PolicyInductionEngine;
  let config: typeof DEFAULT_MEMMY_CONFIG;
  let callback: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    db = new MemoryDb({ path: ":memory:" }); repos = new Repositories(db.db); config = structuredClone(DEFAULT_MEMMY_CONFIG);
    const skills = new SkillPipeline({ repos, config, namespaceIdFromMemory: () => "test" } as unknown as ConstructorParameters<typeof SkillPipeline>[0]);
    callback = vi.fn((policy, at) => skills.applySkillRewardDriftForPolicy(policy, at));
    engine = new PolicyInductionEngine({ repos, config, nowIso: () => AT, traceMeta: (row: MemoryRow | null | undefined) => row ? traceMetaFromMemory(row) : null,
      enqueueJob: vi.fn(), enqueueChange: vi.fn(), namespaceIdFromMemory: () => "test", onSkillRewardDrift: callback } as unknown as PolicyInductionDeps);
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });
  function seed(schema = 1, hasVector = true) {
    repos.memories.insert(row("source", "L1", { value: 1, alpha: 1, episode_id: "e", vec_summary: hasVector ? [1, 0] : null }));
    repos.memories.insert(row("policy", "L2", { schema_version: schema, status: "active", gain: 0.8, support: 1,
      source_trace_ids: ["source"], source_episode_ids: ["e"], successful_source_trace_ids: ["source"], successful_episode_count: 1,
      generation_method: "model", experience_type: "success_pattern", skill_eligible: true }));
    repos.memories.insert(row("skill", "Skill", { eta: 0.8, status: "active", source_policy_ids: ["policy"], trials_attempted: 0, trials_passed: 0 }));
    repos.runtime.insertTracePolicyLink({ userId: "u", l1MemoryId: "source", l2MemoryId: "policy", relation: "supports" });
  }
  function score(value: number) {
    const source = repos.memories.get("source")!;
    repos.memories.update({ ...source, properties: { ...source.properties, internal_info: {
      ...source.properties.internal_info, trace: { ...(source.properties.internal_info.trace as object), value } } } });
    engine.recomputePolicyStats("policy", AT, "e");
  }
  const eta = () => skillMetaFromMemory(repos.memories.get("skill")!)!.eta;
  it.each(["legacy", "unified"] as const)("retracts a recorded pre-upgrade drift without inventing a second contribution (%s)", mode => {
    seed(); config.algorithm.l2Induction.mode = mode;
    // Frozen pre-fix unified writer output, not generated through the implementation under test.
    const p = repos.memories.get("policy")!;
    repos.memories.update({ ...p, properties: { ...p.properties, internal_info: { ...p.properties.internal_info,
      policy: { ...(p.properties.internal_info.policy as object), gain: 0.64 } } } });
    const s = repos.memories.get("skill")!;
    repos.memories.update({ ...s, properties: { ...s.properties, internal_info: { ...s.properties.internal_info,
      skill: { ...(s.properties.internal_info.skill as object), eta: 0.752 },
      skill_revision_history: { version: 1, base: { eta: 0.8, status: "active", trialsAttempted: 0, trialsPassed: 0 },
        events: [{ id: "policy:policy:legacy", type: "policy", policyId: "policy", policyEventId: "legacy", gain: 0.64, archiveEta: 0.1 }],
        last: { eta: 0.752, status: "active", trialsAttempted: 0, trialsPassed: 0 } } } } });
    score(-1); expect(eta()).toBeCloseTo(0.8, 12);
    score(1); const gain = policyMetaFromMemory(repos.memories.get("policy")!)!.gain;
    expect(eta()).toBeCloseTo(0.7 * 0.8 + 0.3 * gain, 12);
    const restored = eta(); score(1); expect(eta()).toBe(restored);
  });
  it.each(["legacy", "unified"] as const)("keeps an accepted source when its similarity vector is temporarily unavailable (%s)", mode => {
    seed(1, false); config.algorithm.l2Induction.mode = mode;
    score(1);
    expect(policyMetaFromMemory(repos.memories.get("policy")!)!.support).toBe(1);
    const first = eta(); score(-1); expect(eta()).toBeCloseTo(0.8, 12);
    score(1); expect(eta()).toBe(first);
  });

  it("rolls back both policy statistics and downstream writes if propagation fails", () => {
    seed(); score(1);
    const beforePolicy = repos.memories.get("policy"), beforeSkill = repos.memories.get("skill");
    callback.mockImplementationOnce((policy, at) => {
      new SkillPipeline({ repos, config, namespaceIdFromMemory: () => "test" } as unknown as ConstructorParameters<typeof SkillPipeline>[0]).applySkillRewardDriftForPolicy(policy, at);
      throw new Error("synthetic downstream failure");
    });
    expect(() => score(-1)).toThrow("synthetic downstream failure");
    expect(repos.memories.get("policy")).toEqual(beforePolicy); expect(repos.memories.get("skill")).toEqual(beforeSkill);
    engine.recomputePolicyStats("policy", AT, "e"); expect(eta()).toBeCloseTo(0.8, 12);
  });
  it("keeps another policy's recorded contribution when the first loses all support", () => {
    seed(); score(1);
    const s = repos.memories.get("skill")!;
    const history = structuredClone(s.properties.internal_info.skill_revision_history) as ReturnType<typeof import("../../../src/service/evolution/revision-stats.js").reviseSkillPolicy>["history"];
    history.events.push({ id: "policy:other:B", type: "policy", policyId: "other", policyEventId: "B", gain: 0.6, archiveEta: 0.1 });
    const withOther = 0.7 * eta() + 0.3 * 0.6;
    history.last!.eta = withOther;
    repos.memories.update({ ...s, properties: { ...s.properties, internal_info: { ...s.properties.internal_info,
      skill: { ...(s.properties.internal_info.skill as object), eta: withOther }, skill_revision_history: history } } });
    score(-1); expect(eta()).toBeCloseTo(0.7 * 0.8 + 0.3 * 0.6, 12);
  });
  it("does not repeatedly smooth a schema-v2 lesson with identical evidence", () => {
    seed(2); score(1); const p = policyMetaFromMemory(repos.memories.get("policy")!)!, first = eta();
    score(1); expect(policyMetaFromMemory(repos.memories.get("policy")!)!.gain).toBe(p.gain); expect(eta()).toBe(first);
  });
  it.each([1, 2])("replays repeated verdict changes against a numeric oracle (schema %i)", schema => {
    seed(schema);
    // One successful trace has raw gain 0.5; the seed's 0.8 is smoothed once at alpha 0.4.
    const gain = 0.4 * 0.5 + 0.6 * 0.8;
    for (const value of [1, 1, -1, -1, 1, -1, 1, 1]) {
      score(value);
      expect(eta()).toBeCloseTo(value > 0 ? 0.7 * 0.8 + 0.3 * gain : 0.8, 12);
      const policy = policyMetaFromMemory(repos.memories.get("policy")!)!;
      expect(policy.support).toBe(value > 0 || schema === 2 ? 1 : 0);
      if (schema === 2 && value < 0) expect(policy.skillEligible).toBe(false);
      const before = repos.memories.get("policy")!; score(value);
      expect(repos.memories.get("policy")!.version).toBe(before.version);
    }
  });
  it("keeps explicit feedback evidence valid and stable even when its task score is negative", () => {
    seed(); const p = repos.memories.get("policy")!;
    repos.memories.update({ ...p, properties: { ...p.properties, internal_info: { ...p.properties.internal_info,
      policy: { ...(p.properties.internal_info.policy as object), schema_version: undefined, source_feedback_ids: ["feedback"] } } } });
    score(-1); const before = repos.memories.get("policy")!;
    expect(policyMetaFromMemory(before)).toMatchObject({ support: 1, sourceTraceIds: ["source"] });
    score(-1); expect(repos.memories.get("policy")!.version).toBe(before.version);
  });
  it("keeps a later manual eta checkpoint when an earlier contribution is withdrawn", () => {
    seed(); score(1);
    const s = repos.memories.get("skill")!;
    repos.memories.update({ ...s, properties: { ...s.properties, internal_info: { ...s.properties.internal_info,
      skill: { ...(s.properties.internal_info.skill as object), eta: 0.73 } } } });
    score(-1); expect(eta()).toBe(0.73); score(1); expect(eta()).toBe(0.73);
  });
  it.each(["legacy", "unified"] as const)("accepts old associations without accepting refutations (%s)", mode => {
    seed(); config.algorithm.l2Induction.mode = mode;
    for (const [id, relation] of [["b", "matches_signature"], ["c", "similar_pattern"], ["refutation", "refutes_pending"]]) {
      repos.memories.insert(row(id!, "L1", { value: 1, alpha: 1, episode_id: id, vec_summary: [1, 0] }));
      repos.runtime.insertTracePolicyLink({ userId: "u", l1MemoryId: id!, l2MemoryId: "policy", relation: relation! });
    }
    engine.recomputePolicyStats("policy", AT, "e");
    expect(policyMetaFromMemory(repos.memories.get("policy")!)!.support).toBe(3);
    expect(policyMetaFromMemory(repos.memories.get("policy")!)!.sourceTraceIds.sort()).toEqual(["b", "c", "source"]);
  });

  it("updates every dependent Skill beyond the first page without modifying another owner or read-only Skills", () => {
    seed(); score(1);
    const original = repos.memories.get("skill")!;
    const foreign = { ...original, id: "foreign-skill", userId: "another-user" };
    const readonly = { ...original, id: "readonly-skill", properties: { ...original.properties,
      internal_info: { ...original.properties.internal_info, read_only: true } } };
    repos.memories.insert(foreign); repos.memories.insert(readonly);
    for (let i = 0; i < 1001; i++) repos.memories.insert({ ...original, id: `z-skill-${i}` });
    const beforeForeign = repos.memories.get(foreign.id), beforeReadonly = repos.memories.get(readonly.id);
    score(-1);
    expect(eta()).toBeCloseTo(0.8, 12);
    for (let i = 0; i < 1001; i++) expect(skillMetaFromMemory(repos.memories.get(`z-skill-${i}`)!)!.eta).toBeCloseTo(0.8, 12);
    expect(repos.memories.get(foreign.id)).toEqual(beforeForeign);
    expect(repos.memories.get(readonly.id)).toEqual(beforeReadonly);
  });

  it("preserves manual archive and clears its pin only after explicit reactivation", () => {
    seed(); score(1); repos.memories.archive("skill", AT); score(-1);
    expect(repos.memories.get("skill")!.status).toBe("archived");
    const archived = repos.memories.get("skill")!;
    repos.memories.update({ ...archived, status: "activated", properties: { ...archived.properties, status: "activated",
      internal_info: { ...archived.properties.internal_info, skill: { ...(archived.properties.internal_info.skill as object), status: "active" } } } });
    const restored = repos.memories.get("skill")!;
    expect(restored.properties.internal_info.skill_manually_archived).toBe(false);
    expect(restored.properties.internal_info.skill_revision_history).toMatchObject({ externallyArchived: false });
    score(1); expect(repos.memories.get("skill")!.status).not.toBe("archived");
  });

});
