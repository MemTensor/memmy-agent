import { readSkillEtaContributions } from "../../../src/service/evolution/skill-eta-contributions.js";
import { createNoToolSkillLlm } from "./evolution-llm-stubs.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { policyMetaFromMemory, skillMetaFromMemory } from "../../../src/algorithm/plugin-algorithms.js";
import { DEFAULT_MEMMY_CONFIG } from "../../../src/config/index.js";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { stableHash } from "../../../src/utils/id.js";
import { SkillPipeline } from "../../../src/service/evolution/skill-pipeline.js";
import { SkillTrialResolver } from "../../../src/service/trials/skill-trial-resolver.js";
import { initialPolicyContributions, revisePolicySources, type PolicyGainContributions } from "../../../src/service/evolution/episode-contributions.js";
import { seedPolicySkillEta } from "../../../src/service/evolution/skill-policy-contributions.js";
import { insertActivePolicyMemory, insertActiveSkillMemoryForTest } from "../../fixtures/evolution-fixture.js";
const AT = "2026-11-13T00:00:00.000Z";
const unexpected = (): never => { throw new Error("unexpected dependency"); };
const source = (id: string, value: number) => ({ id, supportValues: [value], referenceValues: [] });

describe("MEMMY-647 recorded Policy crystallization eta", () => {
  let db: MemoryDb, repos: Repositories, pipeline: SkillPipeline, resolver: SkillTrialResolver, a: PolicyGainContributions;
  beforeEach(() => {
    db = new MemoryDb({ path: ":memory:" }); repos = new Repositories(db.db);
    const config = structuredClone(DEFAULT_MEMMY_CONFIG);
    config.algorithm.skill.minSupport = 1;
    pipeline = new SkillPipeline({ repos, config, skillLlm: createNoToolSkillLlm(),
      traceMeta: () => null, buildMemory: unexpected, upsertEvolutionMemory: unexpected,
      isArchivedEvolutionMemory: () => false, enqueueJob: unexpected, namespaceIdFromMemory: () => "test" });
    resolver = new SkillTrialResolver({ repos, config, requireRawTurn: unexpected, assertRawTurnInScope: unexpected,
      requireExistingMemory: unexpected, assertMemoryInScope: unexpected, traceMeta: () => null, feedbackTargetFromRawTurn: () => undefined });
    insertActivePolicyMemory(db, { id: "policy", userId: "user", sessionId: "session", agentId: "codex", appId: "app", profileId: "default",
      sourceTraceId: "trace", sourceEpisodeId: "A" });
    a = revisePolicySources(initialPolicyContributions(0.2, 1, 0.4, 0.5), [source("A", 1)], 0.2);
    savePolicy(a);
    insertActiveSkillMemoryForTest(db, { id: "skill", userId: "user", sessionId: "session", agentId: "codex", profileId: "default", sourcePolicyIds: ["policy"] });
    const row = repos.memories.get("skill")!;
    const seeded = seedPolicySkillEta({ bodyRevision: `policy:${stableHash(row.memoryValue)}`, policyId: "policy", policyRevision: 1,
      policy: a, gain: a.lastGain, support: 1, eta: 0.66, minEta: 0.1, minSupport: 1 })!;
    expect(seeded).toBeTruthy();
    repos.memories.update({ ...row, info: { ...row.info, eta: 0.66 }, properties: { ...row.properties,
      internal_info: { ...row.properties.internal_info, eta: 0.66, skill: { ...(row.properties.internal_info.skill as Record<string, unknown>),
        eta: 0.66, trials_attempted: 0, trials_passed: 0, eta_contributions: seeded.contributions, eta_policy_baseline: seeded.baseline } } } });
  });
  afterEach(() => db.close());
  function savePolicy(state: PolicyGainContributions) {
    const row = repos.memories.get("policy")!;
    repos.memories.update({ ...row, properties: { ...row.properties, internal_info: { ...row.properties.internal_info,
      policy: { ...(row.properties.internal_info.policy as Record<string, unknown>), gain: state.lastGain,
        support: Object.values(state.sources).filter(s => s.supportValues.length).length, gain_contributions: state } } } });
  }
  function drift(state = a) {
    savePolicy(state);
    pipeline.applySkillRewardDriftForPolicy(policyMetaFromMemory(repos.memories.get("policy")!)!, AT);
  }
  it("starts a conservative future boundary for an old skill without replaying unknown history", () => {
    const row = repos.memories.get("skill")!;
    const { eta_contributions, eta_policy_baseline, eta_policy_observations, ...old } = row.properties.internal_info.skill as Record<string, unknown>;
    repos.memories.update({ ...row, properties: { ...row.properties, internal_info: { ...row.properties.internal_info, skill: old } } });
    drift();
    expect(skillMetaFromMemory(repos.memories.get("skill")!)?.eta).toBeCloseTo(0.558);
    const once = repos.memories.get("skill");
    drift();
    expect(repos.memories.get("skill")).toEqual(once);
    const revised = revisePolicySources(a, [source("A", 0.4)], a.lastGain);
    drift(revised);
    expect(skillMetaFromMemory(repos.memories.get("skill")!)?.eta).toBeCloseTo(0.498);
  });
  it("does not apply the contribution already absorbed by crystallization again", () => {
    const before = repos.memories.get("skill");
    drift(); drift();
    expect(repos.memories.get("skill")).toEqual(before);
  });
  it("revises the absorbed A before a real trial and later B", () => {
    const trial = repos.runtime.insertSkillTrial({ id: "trial", userId: repos.memories.get("skill")!.userId,
      skillMemoryId: "skill", status: "pass", outcome: "success", createdAt: AT, resolvedAt: AT });
    resolver.updateSkillTrialStats(trial, AT);
    expect(skillMetaFromMemory(repos.memories.get("skill")!)?.eta).toBeCloseTo(0.83);
    const ab = revisePolicySources(a, [source("A", 1), source("B", 0.8)], a.lastGain);
    drift(ab);
    expect(skillMetaFromMemory(repos.memories.get("skill")!)?.eta).toBeCloseTo(0.6866);
    const revised = revisePolicySources(ab, [source("A", 0.4), source("B", 0.8)], ab.lastGain);
    drift(revised);
    expect(skillMetaFromMemory(repos.memories.get("skill")!)).toMatchObject({ trialsAttempted: 1, trialsPassed: 1 });
    expect(readSkillEtaContributions((repos.memories.get("skill")!.properties.internal_info.skill as Record<string, unknown>).eta_contributions)?.baseline.eta).toBeCloseTo(0.56);
    expect(skillMetaFromMemory(repos.memories.get("skill")!)?.eta).toBeCloseTo(0.5796);
    const before = repos.memories.get("skill");
    drift(revised); resolver.updateSkillTrialStats(trial, AT);
    expect(repos.memories.get("skill")).toEqual(before);
  });
  it("preserves a manual eta while still revising the recorded underlying source", () => {
    const row = repos.memories.get("skill")!;
    repos.memories.update({ ...row, properties: { ...row.properties, internal_info: { ...row.properties.internal_info,
      skill: { ...(row.properties.internal_info.skill as Record<string, unknown>), eta: 0.91 } } } });
    drift(revisePolicySources(a, [source("A", 0.4)], a.lastGain));
    expect(skillMetaFromMemory(repos.memories.get("skill")!)?.eta).toBe(0.91);
  });
  it("withdraws and restores the absorbed source without deleting a successful trial", () => {
    const trial = repos.runtime.insertSkillTrial({ id: "trial", userId: repos.memories.get("skill")!.userId,
      skillMemoryId: "skill", status: "pass", outcome: "success", createdAt: AT, resolvedAt: AT });
    resolver.updateSkillTrialStats(trial, AT);
    const withdrawn = revisePolicySources(a, [], a.lastGain);
    drift(withdrawn);
    expect(skillMetaFromMemory(repos.memories.get("skill")!)?.eta).toBeCloseTo(0.55);
    drift(revisePolicySources(withdrawn, [source("A", 1)], withdrawn.lastGain));
    expect(skillMetaFromMemory(repos.memories.get("skill")!)).toMatchObject({ trialsAttempted: 1, trialsPassed: 1 });
    expect(skillMetaFromMemory(repos.memories.get("skill")!)?.eta).toBeCloseTo(0.83);
    expect(repos.runtime.getSkillTrial("trial")?.outcome).toBe("success");
  });
  it("refuses to apply old-body contributions after an untracked guide edit", () => {
    const row = repos.memories.get("skill")!;
    repos.memories.update({ ...row, memoryValue: "A manually rewritten procedure." });
    const before = repos.memories.get("skill");
    expect(() => drift()).toThrow("content changed");
    expect(repos.memories.get("skill")).toEqual(before);
  });
  it("does not reactivate a manually archived skill on a source revision", () => {
    const row = repos.memories.get("skill")!;
    repos.memories.update({ ...row, status: "archived" });
    const before = repos.memories.get("skill");
    drift(revisePolicySources(a, [source("A", 0.4)], a.lastGain));
    expect(repos.memories.get("skill")).toEqual(before);
  });
  it.each(["policy_revision", "unknown_baseline"] as const)("preserves data when its recorded boundary is incompatible: %s", kind => {
    if (kind === "policy_revision") {
      const row = repos.memories.get("policy")!;
      repos.memories.update({ ...row, properties: { ...row.properties, internal_info: { ...row.properties.internal_info,
        policy: { ...(row.properties.internal_info.policy as Record<string, unknown>), content_revision: 2 } } } });
    } else {
      const row = repos.memories.get("skill")!;
      repos.memories.update({ ...row, properties: { ...row.properties, internal_info: { ...row.properties.internal_info,
        skill: { ...(row.properties.internal_info.skill as Record<string, unknown>), eta_policy_baseline: { schemaVersion: 815 } } } } });
    }
    const before = repos.memories.get("skill");
    expect(() => drift()).toThrow("preserve for review");
    expect(repos.memories.get("skill")).toEqual(before);
  });
  it("revises two distinct Policies around a real trial without turning either into a manual checkpoint", () => {
    const original = repos.memories.get("policy")!;
    repos.memories.insert({ ...original, id: "other-policy", memoryKey: "other-policy" });
    const row = repos.memories.get("skill")!;
    repos.memories.update({ ...row, properties: { ...row.properties, internal_info: { ...row.properties.internal_info,
      skill: { ...(row.properties.internal_info.skill as Record<string, unknown>), source_policy_ids: ["policy", "other-policy"] } } } });
    const otherDrift = (state: PolicyGainContributions) => {
      const other = repos.memories.get("other-policy")!;
      repos.memories.update({ ...other, properties: { ...other.properties, internal_info: { ...other.properties.internal_info,
        policy: { ...(other.properties.internal_info.policy as Record<string, unknown>), gain: state.lastGain, gain_contributions: state } } } });
      pipeline.applySkillRewardDriftForPolicy(policyMetaFromMemory(repos.memories.get("other-policy")!)!, AT);
    };
    otherDrift(a);
    expect(skillMetaFromMemory(repos.memories.get("skill")!)?.eta).toBeCloseTo(0.558);
    const beforeRepeat = repos.memories.get("skill");
    otherDrift(a);
    expect(repos.memories.get("skill")).toEqual(beforeRepeat);
    const trial = repos.runtime.insertSkillTrial({ id: "multi-trial", userId: row.userId, skillMemoryId: row.id,
      status: "pass", outcome: "success", createdAt: AT, resolvedAt: AT });
    resolver.updateSkillTrialStats(trial, AT);
    expect(skillMetaFromMemory(repos.memories.get("skill")!)?.eta).toBeCloseTo(0.779);
    const revised = revisePolicySources(a, [source("A", 0.4)], a.lastGain);
    drift(revised);
    expect(skillMetaFromMemory(repos.memories.get("skill")!)?.eta).toBeCloseTo(0.744);
    otherDrift(revised);
    expect(skillMetaFromMemory(repos.memories.get("skill")!)?.eta).toBeCloseTo(0.714);
    const both = revisePolicySources(revised, [source("A", 0.4), source("B", 0.8)], revised.lastGain);
    otherDrift(both);
    expect(skillMetaFromMemory(repos.memories.get("skill")!)?.eta).toBeCloseTo(0.5334);
    const restoredA = revisePolicySources(both, [source("A", 1), source("B", 0.8)], both.lastGain);
    otherDrift(restoredA);
    expect(skillMetaFromMemory(repos.memories.get("skill")!)?.eta).toBeCloseTo(0.6264);
    const withdrawn = revisePolicySources(restoredA, [], restoredA.lastGain);
    otherDrift(withdrawn);
    expect(skillMetaFromMemory(repos.memories.get("skill")!)?.eta).toBeCloseTo(0.78);
    otherDrift(revisePolicySources(withdrawn, [source("A", 1), source("B", 0.8)], withdrawn.lastGain));
    expect(skillMetaFromMemory(repos.memories.get("skill")!)?.eta).toBeCloseTo(0.6264);
    const ledger = readSkillEtaContributions((repos.memories.get("skill")!.properties.internal_info.skill as Record<string, unknown>).eta_contributions)!;
    expect(ledger.order.map(event => event.kind)).toEqual(["source", "trial", "source"]);
    expect(ledger.last).toMatchObject({ attempts: 1, passes: 1 });
  });
  it("does not infer a baseline when recorded sources cannot account for the original support", () => {
    expect(seedPolicySkillEta({ bodyRevision: "policy:test", policyId: "policy", policyRevision: 1,
      policy: a, gain: a.lastGain, support: 9, eta: 0.66, minEta: 0.1, minSupport: 1 })).toBeUndefined();
  });
});
