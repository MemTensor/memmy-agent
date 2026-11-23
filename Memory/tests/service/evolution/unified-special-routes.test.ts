import { DEVICE_MEMORY_OWNER } from "../../../src/service/namespace/memory-owner.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG } from "../../../src/config/index.js";
import { traceMetaFromMemory } from "../../../src/algorithm/plugin-algorithms.js";
import { Repositories, type EpisodeRecord, type EvolutionJobRecord, type FeedbackRecord } from "../../../src/storage/repositories.js";
import type { MemoryRow } from "../../../src/types.js";
import { FeedbackExperienceService, type FeedbackExperienceServiceDeps } from "../../../src/service/feedback/feedback-experience.js";
import { NegativeExperiencePipeline, type NegativeExperiencePipelineDeps } from "../../../src/service/evolution/negative-experience-pipeline.js";
import { listL2Candidates, markL2CandidatesProcessed } from "../../../src/service/evolution/l2-candidate-service.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(fixture.cleanup);
const at = "2026-10-28T00:00:00.000Z";

function setup() {
  const { db } = fixture.createTestService();
  const repos = new Repositories(db.db);
  repos.runtime.createSession({ id: "session", userId: DEVICE_MEMORY_OWNER, source: "codex", profileId: "default",
    status: "closed", meta: {}, openedAt: at, closedAt: at, updatedAt: at });
  const config = {
    ...DEFAULT_MEMMY_CONFIG,
    algorithm: {
      ...DEFAULT_MEMMY_CONFIG.algorithm,
      l2Induction: { ...DEFAULT_MEMMY_CONFIG.algorithm.l2Induction, mode: "unified" as const }
    }
  };
  const forbidden = vi.fn(() => { throw new Error("special adapters must not invoke model, embedder, or L2 writer"); });
  const jobs: Array<Record<string, unknown>> = [];
  const enqueueJob = vi.fn((input: Record<string, unknown>) => {
    jobs.push(input);
    return { ...input, id: `job-${jobs.length}`, status: "queued", attempts: 0, maxAttempts: 3,
      createdAt: at, updatedAt: at } as EvolutionJobRecord;
  });
  const shared = {
    repos, config, enqueueJob,
    skillLlm: { isConfigured: () => true, completeJson: forbidden },
    embedder: { embedOne: forbidden },
    buildMemory: forbidden,
    upsertEvolutionMemory: forbidden,
    traceMeta: traceMetaFromMemory
  };
  return { repos, forbidden, jobs, enqueueJob,
    feedback: new FeedbackExperienceService(shared as unknown as FeedbackExperienceServiceDeps),
    negative: new NegativeExperiencePipeline(shared as unknown as NegativeExperiencePipelineDeps)
  };
}

function source(repos: Repositories, id: string, episodeId = "episode"): MemoryRow {
  const memory: MemoryRow = {
    id, timeline: at, userId: DEVICE_MEMORY_OWNER, sessionId: "session", memoryType: "LongTermMemory",
    memoryLayer: "L1", status: "activated", visibility: "private", memoryKey: id,
    memoryValue: "TLS configuration failed on the wrong port.", tags: [], info: {},
    properties: { internal_info: { memory_layer: "L1", memory_kind: "trace", trace: {
      episode_id: episodeId, userText: "Configure TLS", agentText: "I used port 80.",
      summary: "Wrong port", value: -1, alpha: 0, priority: 0
    } } },
    version: 1, createdAt: at, updatedAt: at
  };
  return repos.memories.upsertByKey(memory).memory;
}

function episode(repos: Repositories, ids: string[]): EpisodeRecord {
  return repos.runtime.createEpisode({
    id: "episode", sessionId: "session", userId: DEVICE_MEMORY_OWNER, status: "closed",
    l1MemoryIds: ids, rawTurnIds: [], feedbackIds: [], decisionRepairIds: [],
    l2PolicyIds: [], l3WorldModelIds: [], skillMemoryIds: [], turnCount: ids.length,
    rTask: -0.8, rewardDetail: { reason: "The requested secure endpoint was not verified." },
    pipelineStatus: "idle", meta: {}, openedAt: at, closedAt: at, updatedAt: at
  });
}

function feedbackRecord(l1MemoryId?: string): FeedbackRecord {
  return {
    id: "feedback", userId: DEVICE_MEMORY_OWNER, sessionId: "session", episodeId: "episode", l1MemoryId,
    channel: "explicit", polarity: "neutral", magnitude: 1,
    rationale: "You should verify the HTTPS endpoint before reporting completion.", rawPayload: {}, createdAt: at
  };
}

function negativeJob(payload: Record<string, unknown>): EvolutionJobRecord {
  return { id: "negative-job", jobType: "negative_experience", userId: DEVICE_MEMORY_OWNER, sessionId: "session",
    episodeId: "episode", status: "queued", payload, attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at };
}

describe("unified special L2 admission", () => {
  it("replaces one reward source across queue jobs while preserving independent feedback", async () => {
    const test = setup();
    const memory = source(test.repos, "revision-source");
    episode(test.repos, [memory.id]);
    const feedback = test.repos.runtime.insertFeedback({ ...feedbackRecord(memory.id), polarity: "negative" });
    await test.negative.materialize(negativeJob({ source: "negative_feedback", feedbackId: feedback.id }));
    await test.negative.materialize(negativeJob({ source: "episode_reward", rewardReason: "old assessment" }));
    const before = listL2Candidates(test.repos, { userId: DEVICE_MEMORY_OWNER, episodeId: "episode" })[0]!;
    await test.negative.materialize({ ...negativeJob({ source: "episode_reward", rewardReason: "old assessment" }), id: "retry-job" });
    const repeated = listL2Candidates(test.repos, { userId: DEVICE_MEMORY_OWNER, episodeId: "episode" })[0]!;
    expect(repeated.sourceVersion).toBe(before.sourceVersion);
    await test.negative.materialize({ ...negativeJob({ source: "episode_reward", rewardReason: "revised assessment" }), id: "revised-job" });
    const revised = listL2Candidates(test.repos, { userId: DEVICE_MEMORY_OWNER, episodeId: "episode" })[0]!;
    expect(revised.signals).toHaveLength(2);
    expect(revised.signals.find(signal => signal.feedbackId === feedback.id)).toEqual(before.signals.find(signal => signal.feedbackId === feedback.id));
    expect(revised.signals.find(signal => !signal.feedbackId)?.text).toContain("revised assessment");
    expect(revised.signals.find(signal => !signal.feedbackId)?.text).not.toContain("old assessment");
  });

  it.each(["open", "reclosed"] as const)("does not admit stale reward evidence after %s", async state => {
    const test = setup();
    episode(test.repos, [source(test.repos, "stale-source").id]);
    test.repos.runtime.reopenEpisode("episode");
    if (state === "reclosed") test.repos.runtime.closeEpisode("episode");
    await test.negative.materialize(negativeJob({ source: "episode_reward", episodeGeneration: 0 }));
    expect(listL2Candidates(test.repos, { userId: DEVICE_MEMORY_OWNER, episodeId: "episode" })).toEqual([]);
    expect(test.jobs).toEqual([]);
  });

  it("keeps completed reward evidence completed on a new queue job", async () => {
    const test = setup();
    episode(test.repos, [source(test.repos, "processed-source").id]);
    await test.negative.materialize(negativeJob({ source: "episode_reward", sourceEventId: "episode" }));
    const candidates = listL2Candidates(test.repos, { userId: DEVICE_MEMORY_OWNER, episodeId: "episode" });
    markL2CandidatesProcessed(test.repos, candidates, [], at);
    const saved = test.repos.runtime.getUnifiedL2Candidate(candidates[0]!.id, DEVICE_MEMORY_OWNER);
    const count = test.jobs.length;
    await test.negative.materialize({ ...negativeJob({ source: "episode_reward" }), id: "another-queue-job" });
    expect(test.repos.runtime.getUnifiedL2Candidate(candidates[0]!.id, DEVICE_MEMORY_OWNER)).toEqual(saved);
    expect(test.jobs).toHaveLength(count);
  });

  it("rolls back candidate admission if downstream enqueue fails", async () => {
    const test = setup();
    episode(test.repos, [source(test.repos, "atomic-source").id]);
    test.enqueueJob.mockImplementationOnce(() => { throw new Error("injected queue failure"); });
    await expect(test.negative.materialize(negativeJob({ source: "episode_reward" }))).rejects.toThrow("injected queue failure");
    expect(listL2Candidates(test.repos, { userId: DEVICE_MEMORY_OWNER, episodeId: "episode" })).toEqual([]);
  });

  it("preserves independent corrective feedback when its Episode reopens", async () => {
    const test = setup();
    const memory = source(test.repos, "feedback-reopen");
    episode(test.repos, [memory.id]);
    const feedback = test.repos.runtime.insertFeedback({ ...feedbackRecord(memory.id), polarity: "negative" });
    test.repos.runtime.reopenEpisode("episode");
    await test.negative.materialize(negativeJob({ source: "negative_feedback", feedbackId: feedback.id, episodeGeneration: 0 }));
    expect(listL2Candidates(test.repos, { userId: DEVICE_MEMORY_OWNER, episodeId: "episode" })[0]?.signals)
      .toEqual([expect.objectContaining({ feedbackId: feedback.id })]);
  });

  it.each([false, true])("withdraws reward evidence on success and preserves independent feedback: %s", async independent => {
    const test = setup();
    const memory = source(test.repos, "withdraw-source");
    episode(test.repos, [memory.id]);
    if (independent) {
      const feedback = test.repos.runtime.insertFeedback({ ...feedbackRecord(memory.id), polarity: "negative" });
      await test.negative.materialize(negativeJob({ source: "negative_feedback", feedbackId: feedback.id }));
    }
    await test.negative.materialize(negativeJob({ source: "episode_reward" }));
    const original = listL2Candidates(test.repos, { userId: DEVICE_MEMORY_OWNER, episodeId: "episode" })[0]!;
    markL2CandidatesProcessed(test.repos, [original], [], at);
    test.repos.runtime.updateEpisodeReward("episode", { rTask: 1, rewardDetail: { reason: "corrected" } }, at);
    await test.negative.materialize(negativeJob({ source: "episode_reward" }));
    const remaining = listL2Candidates(test.repos, { userId: DEVICE_MEMORY_OWNER, episodeId: "episode" });
    expect(remaining).toHaveLength(independent ? 1 : 0);
    if (independent) expect(remaining[0]?.signals).toEqual([expect.objectContaining({ feedbackId: "feedback" })]);
    const saved = test.repos.runtime.getUnifiedL2Candidate(original.id, DEVICE_MEMORY_OWNER);
    await test.negative.materialize(negativeJob({ source: "episode_reward" }));
    expect(test.repos.runtime.getUnifiedL2Candidate(original.id, DEVICE_MEMORY_OWNER)).toEqual(saved);
    test.repos.runtime.updateEpisodeReward("episode", { rTask: -0.8, rewardDetail: {} }, at);
    await test.negative.materialize(negativeJob({ source: "episode_reward" }));
    const restored = listL2Candidates(test.repos, { userId: DEVICE_MEMORY_OWNER, episodeId: "episode" });
    expect(restored[0]?.id).toBe(original.id);
    expect(restored[0]?.signals).toHaveLength(independent ? 2 : 1);
  });

  it("keeps low-value feedback L1 and its rule fallback in the shared pool without a direct L2 write", async () => {
    const test = setup();
    const memory = source(test.repos, "low-value");
    episode(test.repos, [memory.id]);
    const feedback = feedbackRecord(memory.id);
    await test.feedback.maybeCreateFeedbackExperience(feedback, feedback, { userId: DEVICE_MEMORY_OWNER, namespace: { source: "codex", profileId: "default" } });
    const candidates = listL2Candidates(test.repos, { userId: DEVICE_MEMORY_OWNER, episodeId: "episode" });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ sourceMemoryId: memory.id, routes: ["feedback"], signals: [
      { feedbackId: feedback.id, fallback: { type: "check" } }
    ] });
    expect(test.jobs).toEqual([expect.objectContaining({ jobType: "l2_induction", targetMemoryId: memory.id })]);
    expect(test.forbidden).not.toHaveBeenCalled();
    expect(test.repos.memories.list({ memoryLayer: "L2" }, 10)).toEqual([]);
  });

  it("does not borrow another Episode L1 for feedback with no attributed L1", async () => {
    const test = setup();
    episode(test.repos, [source(test.repos, "other-turn").id]);
    const feedback = feedbackRecord();
    await test.feedback.maybeCreateFeedbackExperience(feedback, feedback, { userId: DEVICE_MEMORY_OWNER, namespace: { source: "codex", profileId: "default" } });
    test.repos.runtime.insertFeedback({ ...feedback, polarity: "negative" });
    await test.negative.materialize(negativeJob({ source: "negative_feedback", feedbackId: feedback.id }));
    expect(listL2Candidates(test.repos, { userId: DEVICE_MEMORY_OWNER, episodeId: "episode" })).toEqual([]);
    expect(test.jobs).toEqual([]);
    expect(test.forbidden).not.toHaveBeenCalled();
  });

  it("admits negative Episode evidence without ordinary value gates and excludes foreign Episode L1", async () => {
    const test = setup();
    const local = source(test.repos, "local");
    const foreign = source(test.repos, "foreign", "another-episode");
    episode(test.repos, [local.id, foreign.id]);
    await test.negative.materialize(negativeJob({ source: "episode_reward", sourceEventId: "reward-1" }));
    const candidates = listL2Candidates(test.repos, { userId: DEVICE_MEMORY_OWNER, episodeId: "episode" });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ sourceMemoryId: local.id, routes: ["negative"], signals: [
      { sourceBasis: "implicit_failure_analysis", confidenceCap: DEFAULT_MEMMY_CONFIG.algorithm.negativeExperience.implicitConfidenceCap }
    ] });
    expect(test.jobs).toEqual([expect.objectContaining({ jobType: "l2_induction", targetMemoryId: local.id })]);
    expect(test.forbidden).not.toHaveBeenCalled();
  });

  it("limits explicit negative feedback to its attributed L1 within the Episode", async () => {
    const test = setup();
    const failed = source(test.repos, "failed");
    const other = source(test.repos, "other");
    episode(test.repos, [failed.id, other.id]);
    const feedback = test.repos.runtime.insertFeedback({ ...feedbackRecord(failed.id), polarity: "negative" });
    await test.negative.materialize(negativeJob({ source: "negative_feedback", feedbackId: feedback.id }));
    expect(listL2Candidates(test.repos, { userId: DEVICE_MEMORY_OWNER, episodeId: "episode" }).map((candidate) => candidate.sourceMemoryId))
      .toEqual([failed.id]);
    expect(test.forbidden).not.toHaveBeenCalled();
  });
});
