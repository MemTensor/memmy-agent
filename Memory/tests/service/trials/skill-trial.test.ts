import { afterEach, describe, expect, it } from "vitest";
import { insertActiveSkillMemoryForTest } from "../../fixtures/evolution-fixture.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const {
  cleanup,
  createTestService
} = createMemoryServiceFixture();

afterEach(cleanup);

describe("MemoryService / trials / skill trial", () => {
  it("resolves neutral reward skill trials as unknown instead of pending", async () => {
    const { db, service } = createTestService();
    const namespace = {
      source: "codex",
      profileId: "jiang",
      userId: "user-skill-neutral-reward"
    };
    const session = service.openSession({ namespace });
    const complete = service.completeTurn("turn-skill-neutral-reward", {
      sessionId: session.sessionId,
      episodeId: "episode-skill-neutral-reward",
      query: "use a reusable sqlite migration checklist for the next step",
      answer: "applied the sqlite migration checklist and reported the neutral result"
    });
    await service.runWorkerOnce(100);

    const skillId = "skill_neutral_reward";
    insertActiveSkillMemoryForTest(db, {
      id: skillId,
      userId: namespace.userId,
      sessionId: session.sessionId,
      agentId: namespace.source,
      profileId: namespace.profileId,
      evidenceAnchorIds: [complete.l1MemoryId]
    });

    const trial = service.useSkill(skillId, {
      adapterId: "test-adapter",
      requestId: "skill-neutral-reward-1",
      sessionId: session.sessionId,
      episodeId: complete.episodeId,
      rawTurnId: complete.rawTurnId,
      turnId: complete.turnId
    });
    const feedback = await service.feedback({
      sessionId: session.sessionId,
      episodeId: complete.episodeId,
      rawTurnId: complete.rawTurnId,
      channel: "explicit",
      polarity: "neutral",
      magnitude: 1,
      rationale: "skill result was inconclusive"
    });
    expect(feedback.jobs.map((job) => job.jobType)).toEqual(expect.arrayContaining([
      "reward",
      "skill_trial_resolve"
    ]));

    await service.runWorkerOnce(100);

    const resolvedTrial = db.db.prepare(
      `SELECT status, outcome, feedback_id
       FROM skill_trials
       WHERE id = ?`
    ).get(trial.trialId) as { status: string; outcome: string; feedback_id: string | null };
    expect(resolvedTrial).toMatchObject({
      status: "unknown",
      outcome: "unknown",
      feedback_id: feedback.id
    });
    expect(service.getSkill(skillId).reliability).toMatchObject({
      usageCount: 1,
      pendingTrials: 0,
      trialsAttempted: 0,
      trialsPassed: 0,
      betaPosterior: {
        alpha: 1,
        beta: 1,
        mean: 0.5
      }
    });
    const trialResolvedChange = db.db.prepare(
      `SELECT source
       FROM memory_change_log
       WHERE entity_id = ?
       ORDER BY seq DESC
       LIMIT 1`
    ).get(trial.trialId) as { source: string };
    expect(trialResolvedChange.source).toBe("worker.reward.updated");

    const retryTrial = service.useSkill(skillId, {
      adapterId: "test-adapter",
      requestId: "skill-neutral-reward-2",
      sessionId: session.sessionId,
      episodeId: complete.episodeId,
      rawTurnId: complete.rawTurnId,
      turnId: complete.turnId
    });
    expect(retryTrial.trialId).not.toBe(trial.trialId);
    expect(retryTrial.duplicate).toBeUndefined();
    const trialCounts = db.db.prepare(
      `SELECT
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
         COUNT(*) AS total
       FROM skill_trials
       WHERE skill_memory_id = ?
         AND episode_id = ?`
    ).get(skillId, complete.episodeId) as { pending: number; total: number };
    expect(trialCounts).toMatchObject({
      pending: 1,
      total: 2
    });
    db.close();
  });
});
