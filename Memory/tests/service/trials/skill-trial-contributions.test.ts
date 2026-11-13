import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { skillMetaFromMemory } from "../../../src/algorithm/plugin-algorithms.js";
import { DEFAULT_MEMMY_CONFIG } from "../../../src/config/index.js";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories, type SkillTrialRecord } from "../../../src/storage/repositories.js";
import { SkillTrialResolver } from "../../../src/service/trials/skill-trial-resolver.js";
import { initialSkillEtaContributions } from "../../../src/service/evolution/skill-eta-contributions.js";
import { insertActiveSkillMemoryForTest } from "../../fixtures/evolution-fixture.js";

const AT = "2026-11-13T00:00:00.000Z";
const LATER = "2026-11-13T00:01:00.000Z";
const unexpected = (): never => { throw new Error("unexpected fixture dependency"); };

describe("MEMMY-647 direct skill trial contribution integration", () => {
  let db: MemoryDb, repos: Repositories, resolver: SkillTrialResolver;
  beforeEach(() => {
    db = new MemoryDb({ path: ":memory:" });
    repos = new Repositories(db.db);
    resolver = new SkillTrialResolver({ repos, config: structuredClone(DEFAULT_MEMMY_CONFIG),
      requireRawTurn: unexpected, assertRawTurnInScope: unexpected, requireExistingMemory: unexpected,
      assertMemoryInScope: unexpected, traceMeta: () => null, feedbackTargetFromRawTurn: () => undefined });
    insertActiveSkillMemoryForTest(db, { id: "skill", userId: "trial-user", sessionId: "session", agentId: "codex", profileId: "default" });
    const row = repos.memories.get("skill")!;
    repos.memories.update({ ...row, info: { ...row.info, eta: 0.6 }, properties: { ...row.properties,
      internal_info: { ...row.properties.internal_info, eta: 0.6,
        skill: { ...(row.properties.internal_info.skill as Record<string, unknown>), eta: 0.6,
          trials_attempted: 0, trials_passed: 0, content_revision: 1,
          eta_contributions: initialSkillEtaContributions("direct:1", { eta: 0.6, attempts: 0, passes: 0 }) } } } });
  });
  afterEach(() => db.close());
  function trial(id: string, outcome: SkillTrialRecord["outcome"], at = AT) {
    return repos.runtime.insertSkillTrial({ id, userId: repos.memories.get("skill")!.userId, skillMemoryId: "skill",
      status: outcome === "success" ? "pass" : outcome === "unknown" ? "unknown" : "fail", outcome, createdAt: at, resolvedAt: at });
  }

  it("updates real stored trials once, then replaces a changed result at its original position", () => {
    const a = trial("A", "success");
    resolver.updateSkillTrialStats(a, AT);
    expect(skillMetaFromMemory(repos.memories.get("skill")!)?.eta).toBeCloseTo(0.8);
    const once = repos.memories.get("skill");
    resolver.updateSkillTrialStats(a, AT);
    expect(repos.memories.get("skill")).toEqual(once);
    const b = trial("B", "failure", LATER);
    resolver.updateSkillTrialStats(b, LATER);
    expect(skillMetaFromMemory(repos.memories.get("skill")!)?.eta).toBeCloseTo(1.6 / 3);
    const changed = repos.runtime.updateSkillTrial({ ...a, status: "fail", outcome: "failure", resolvedAt: LATER });
    resolver.updateSkillTrialStats(changed, LATER);
    expect(skillMetaFromMemory(repos.memories.get("skill")!)).toMatchObject({ trialsAttempted: 2, trialsPassed: 0 });
    expect(skillMetaFromMemory(repos.memories.get("skill")!)?.eta).toBeCloseTo(0.2);
    expect(repos.runtime.getSkillTrial("B")?.outcome).toBe("failure");
  });

  it("retains a manual eta checkpoint when an earlier trial is rejudged", () => {
    const a = trial("A", "success");
    resolver.updateSkillTrialStats(a, AT);
    const row = repos.memories.get("skill")!;
    repos.memories.update({ ...row, info: { ...row.info, eta: 0.91 }, properties: { ...row.properties,
      internal_info: { ...row.properties.internal_info, eta: 0.91,
        skill: { ...(row.properties.internal_info.skill as Record<string, unknown>), eta: 0.91 } } } });
    const changed = repos.runtime.updateSkillTrial({ ...a, status: "fail", outcome: "failure" });
    resolver.updateSkillTrialStats(changed, LATER);
    expect(skillMetaFromMemory(repos.memories.get("skill")!)).toMatchObject({ eta: 0.91, trialsAttempted: 1, trialsPassed: 0 });
  });

  it("withdraws an unknown result and restores its original position", () => {
    const a = trial("A", "success");
    resolver.updateSkillTrialStats(a, AT);
    const changed = repos.runtime.updateSkillTrial({ ...a, status: "unknown", outcome: "unknown" });
    resolver.updateSkillTrialStats(changed, LATER);
    expect(skillMetaFromMemory(repos.memories.get("skill")!)).toMatchObject({ eta: 0.6, trialsAttempted: 0, trialsPassed: 0 });
    repos.runtime.updateSkillTrial(a);
    resolver.updateSkillTrialStats(a, LATER);
    expect(skillMetaFromMemory(repos.memories.get("skill")!)?.eta).toBeCloseTo(0.8);
  });

  it("retains historical trial rows without counting them for a new body", () => {
    const a = trial("old", "success");
    resolver.updateSkillTrialStats(a, AT);
    const row = repos.memories.get("skill")!;
    repos.memories.update({ ...row, info: { ...row.info, eta: 0.6 }, properties: { ...row.properties,
      internal_info: { ...row.properties.internal_info, eta: 0.6,
        skill: { ...(row.properties.internal_info.skill as Record<string, unknown>), eta: 0.6,
          trials_attempted: 0, trials_passed: 0, content_revision: 2, content_revised_at: LATER,
          eta_contributions: initialSkillEtaContributions("direct:2", { eta: 0.6, attempts: 0, passes: 0 }) } } } });
    const revised = repos.memories.get("skill");
    resolver.updateSkillTrialStats(a, LATER);
    expect(repos.memories.get("skill")).toEqual(revised);
    const b = trial("new", "failure", "2026-11-13T00:02:00.000Z");
    resolver.updateSkillTrialStats(b, b.createdAt);
    expect(skillMetaFromMemory(repos.memories.get("skill")!)).toMatchObject({ trialsAttempted: 1, trialsPassed: 0 });
    expect(skillMetaFromMemory(repos.memories.get("skill")!)?.eta).toBeCloseTo(0.3);
    expect(repos.runtime.getSkillTrial("old")?.outcome).toBe("success");
  });
});
