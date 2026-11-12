import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG } from "../../../src/config/index.js";
import { policyMetaFromMemory, skillMetaFromMemory, traceMetaFromMemory } from "../../../src/algorithm/plugin-algorithms.js";
import { PolicyInductionEngine, type PolicyInductionDeps } from "../../../src/service/evolution/policy-induction.js";
import { SkillPipeline } from "../../../src/service/evolution/skill-pipeline.js";
import { SkillTrialResolver } from "../../../src/service/trials/skill-trial-resolver.js";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories, type ChangeLogRecord, type TracePolicyLinkRecord, type SkillTrialRecord } from "../../../src/storage/repositories.js";
import type { MemoryRow } from "../../../src/types.js";
import { policyRevisionHistory } from "../../../src/service/evolution/revision-stats.js";

const AT = "2026-11-10T06:00:00.000Z";
const fixture = JSON.parse(readFileSync(new URL("../../fixtures/memmy-647-a4-support-checkpoint.json", import.meta.url), "utf8")) as {
  version: number;
  origin: { commit: string; scenario: string };
  memories: MemoryRow[];
  links: TracePolicyLinkRecord[];
  changes: ChangeLogRecord[];
};
const databases: MemoryDb[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.restoreAllMocks(); });

/** Rows and logs are frozen output of real old induceL2 -> unified support ->
 * recompute -> Skill propagation, generated on a4fc31ba with an offline model. */
function restoredFixture(withAudit = true) {
  const db = new MemoryDb({ path: ":memory:" }); databases.push(db);
  const repos = new Repositories(db.db), config = structuredClone(DEFAULT_MEMMY_CONFIG);
  config.algorithm.l2Induction.mode = "unified";
  for (const memory of fixture.memories) {
    repos.memories.insert(structuredClone(memory));
    // This is a frozen pre-device-owner DB export, not a newly captured row.
    // Preserve its recorded owner so audit before/after snapshots remain genuine.
    db.db.prepare("UPDATE memories SET user_id=? WHERE id=?").run(memory.userId, memory.id);
  }
  for (const link of fixture.links) repos.runtime.insertTracePolicyLink(structuredClone(link));
  if (withAudit) for (const change of fixture.changes) {
    const { seq: _oldSeq, ...record } = structuredClone(change);
    repos.runtime.appendChange(record);
  }
  const skills = new SkillPipeline({ repos, config, namespaceIdFromMemory: () => undefined } as unknown as ConstructorParameters<typeof SkillPipeline>[0]);
  const trials = new SkillTrialResolver({ repos, config } as unknown as ConstructorParameters<typeof SkillTrialResolver>[0]);
  const engine = new PolicyInductionEngine({ repos, config, nowIso: () => AT,
    traceMeta: (row: MemoryRow | null | undefined) => row ? traceMetaFromMemory(row) : null, namespaceIdFromMemory: () => undefined,
    enqueueJob: vi.fn(), enqueueChange: (change: Omit<ChangeLogRecord, "seq">) => { repos.runtime.appendChange(change); },
    onSkillRewardDrift: (policy: NonNullable<ReturnType<typeof policyMetaFromMemory>>, at: string) => skills.applySkillRewardDriftForPolicy(policy, at)
  } as unknown as PolicyInductionDeps);
  const policy = () => repos.memories.get("policy")!;
  const skill = () => repos.memories.get("skill")!;
  const eta = () => skillMetaFromMemory(skill())!.eta;
  function score(value: number) {
    const trace = repos.memories.get("a")!;
    repos.memories.update({ ...trace, properties: { ...trace.properties, internal_info: { ...trace.properties.internal_info,
      trace: { ...(trace.properties.internal_info.trace as object), value } } } });
    engine.recomputePolicyStats("policy", AT, "A");
  }
  function trial() {
    const record: SkillTrialRecord = { id: "independent-trial", userId: "owner", skillMemoryId: "skill",
      episodeId: "trial-episode", status: "pass", outcome: "success", createdAt: AT, resolvedAt: AT };
    repos.runtime.insertSkillTrial(record); trials.updateSkillTrialStats(record, AT);
  }
  return { repos, engine, policy, skill, eta, score, trial };
}

describe("migration from actual pre-fix automatic support audit records", () => {
  it("repairs the persisted old checkpoint and preserves real later trial order during revision", () => {
    expect(fixture.origin.commit).toBe("a4fc31baee412320d5978cd2e5781480e609443b");
    const h = restoredFixture();
    expect(h.eta()).toBeCloseTo(0.6029, 12);
    const eventIds = policyRevisionHistory(h.policy())!.events.map(event => event.id);
    const unrelated = h.repos.memories.get("unrelated-skill");
    h.engine.recomputePolicyStats("policy", AT);
    expect(h.eta()).toBeCloseTo(0.647, 12);
    expect(policyRevisionHistory(h.policy())!.events.map(event => event.id)).toEqual(eventIds);
    const checkpoint = policyRevisionHistory(h.policy())!.events.find(event => event.type === "checkpoint");
    expect(checkpoint).toMatchObject({ automaticSupport: {
      supportChangeSeq: expect.any(Number), statisticsChangeSeq: expect.any(Number)
    } });
    h.trial();
    expect(h.eta()).toBeCloseTo((0.647 + 1) / 2, 12);
    const trialRecords = h.repos.runtime.listSkillTrials({ skillMemoryId: "skill", limit: -1 });
    const skillIds = (h.skill().properties.internal_info.skill_revision_history as { events: Array<{ id: string }> }).events.map(event => event.id);
    h.score(0.4);
    // First A alone has gain .4-.4=0. With B, raw gain=.7-.5=.2;
    // the next independent aggregate has gain=.4*.2=.08.
    expect(policyMetaFromMemory(h.policy())!.gain).toBeCloseTo(0.08, 12);
    expect(h.eta()).toBeCloseTo((0.7 * (0.7 * 0.8) + 0.3 * 0.08 + 1) / 2, 12);
    expect((h.skill().properties.internal_info.skill_revision_history as { events: Array<{ id: string }> }).events.map(event => event.id)).toEqual(skillIds);
    expect(h.repos.runtime.listSkillTrials({ skillMemoryId: "skill", limit: -1 })).toEqual(trialRecords);
    h.score(1);
    expect(h.eta()).toBeCloseTo((0.647 + 1) / 2, 12);
    const savedPolicy = h.policy(), savedSkill = h.skill();
    h.engine.recomputePolicyStats("policy", AT);
    expect(h.policy()).toEqual(savedPolicy); expect(h.skill()).toEqual(savedSkill);
    expect(h.repos.memories.get("unrelated-skill")).toEqual(unrelated);
  });

  it("retains an ambiguous fixed checkpoint when its old audit has been pruned", () => {
    const h = restoredFixture(false);
    h.engine.recomputePolicyStats("policy", AT);
    const checkpoint = policyRevisionHistory(h.policy())!.events.find(event => event.type === "checkpoint");
    expect(checkpoint).toBeDefined();
    expect(checkpoint && "automaticSupport" in checkpoint).toBe(false);
    expect(h.eta()).toBeCloseTo(0.6029, 12);
  });
});
