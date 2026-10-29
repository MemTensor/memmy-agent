import { describe, expect, it } from "vitest";
import type { RecallEventRecord, SkillTrialRecord } from "../../../src/storage/repositories.js";
import { panelActivatedSkillUseCount } from "../../../src/service/read-model/panel-read.js";

describe("panelActivatedSkillUseCount", () => {
  it("counts activated skill recall and invocation events inside the seven-day window", () => {
    const activeSkillIds = new Set(["skill_active", "skill_active_unused"]);
    const recallEvents: RecallEventRecord[] = [
      recall("recall_recent", ["skill_active", "skill_resolving", "skill_active"], "2026-10-22T09:00:00.000Z"),
      recall("recall_old", ["skill_active"], "2026-10-15T09:00:00.000Z")
    ];
    const skillTrials: SkillTrialRecord[] = [
      trial("trial_recent_active", "skill_active", "2026-10-21T09:00:00.000Z"),
      trial("trial_recent_resolving", "skill_resolving", "2026-10-21T10:00:00.000Z"),
      trial("trial_old_active", "skill_active", "2026-10-15T10:00:00.000Z")
    ];

    expect(panelActivatedSkillUseCount({
      activeSkillIds,
      recallEvents,
      skillTrials,
      dates: ["2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"],
      timeZone: "+00:00"
    })).toBe(2);
  });
});

function recall(id: string, hitMemoryIds: string[], createdAt: string): RecallEventRecord {
  return {
    id,
    userId: "panel-analysis-user",
    query: id,
    layers: ["Skill"],
    hitMemoryIds,
    request: {},
    createdAt
  };
}

function trial(id: string, skillMemoryId: string, createdAt: string): SkillTrialRecord {
  return {
    id,
    userId: "panel-analysis-user",
    skillMemoryId,
    episodeId: `episode_${id}`,
    status: "pending",
    outcome: "unknown",
    createdAt
  };
}
