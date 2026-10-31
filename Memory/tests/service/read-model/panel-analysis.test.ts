import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Repositories } from "../../../src/storage/repositories.js";
import { createPanelReaderModel } from "../../../src/service/panel/reader-model.js";
import {
  insertActiveSkillMemoryForTest,
  setSkillLifecycleForTest
} from "../../fixtures/evolution-fixture.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const {
  cleanup,
  createTestService
} = createMemoryServiceFixture();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-23T12:00:00.000Z"));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("MemoryService / read model / panel analysis", () => {
  it("counts recent recalls and invocations of activated skills instead of recent skill updates", () => {
    const { db, service } = createTestService();
    const userId = "panel-analysis-user";
    const activeUsedId = "skill_panel_active_used";
    const activeUnusedId = "skill_panel_active_unused";
    const resolvingId = "skill_panel_resolving";

    for (const id of [activeUsedId, activeUnusedId, resolvingId]) {
      insertActiveSkillMemoryForTest(db, {
        id,
        userId,
        sessionId: "panel-analysis-session",
        agentId: "codex",
        profileId: "default"
      });
    }
    setSkillLifecycleForTest(db, resolvingId, {
      eta: 0,
      status: "candidate",
      trialsAttempted: 0,
      trialsPassed: 0
    });

    const repos = new Repositories(db.db);
    repos.runtime.insertRecallEvent({
      id: "recall_recent",
      userId,
      query: "use the active skill",
      layers: ["Skill"],
      hitMemoryIds: [activeUsedId, resolvingId, activeUsedId],
      request: {},
      createdAt: "2026-10-22T09:00:00.000Z"
    });
    repos.runtime.insertRecallEvent({
      id: "recall_outside_window",
      userId,
      query: "old active skill recall",
      layers: ["Skill"],
      hitMemoryIds: [activeUsedId],
      request: {},
      createdAt: "2026-10-15T09:00:00.000Z"
    });
    repos.runtime.insertSkillTrial(skillTrial("trial_recent_active", activeUsedId, userId, "2026-10-21T09:00:00.000Z"));
    repos.runtime.insertSkillTrial(skillTrial("trial_recent_resolving", resolvingId, userId, "2026-10-21T10:00:00.000Z"));
    repos.runtime.insertSkillTrial(skillTrial("trial_outside_window", activeUsedId, userId, "2026-10-15T10:00:00.000Z"));

    const analysis = service.panelAnalysis({ timeZone: "+00:00" });

    expect(analysis.metrics.activeSkills).toBe(2);
    expect(analysis.metrics.recentlyUsedSkills).toBe(2);

    // The combined overview/analysis path receives the cached projection as rows.
    const stats = createPanelReaderModel(db).panelStatistics({ timeZone: "+00:00" });
    expect(stats.analysis.metrics.activeSkills).toBe(2);
    expect(stats.analysis.metrics.recentlyUsedSkills).toBe(2);
  });
});

function skillTrial(id: string, skillMemoryId: string, userId: string, createdAt: string) {
  return {
    id,
    userId,
    skillMemoryId,
    episodeId: `episode_${id}`,
    status: "pending" as const,
    outcome: "unknown" as const,
    createdAt
  };
}
