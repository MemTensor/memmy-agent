import { enqueueEpisodeReflection, episodeHasRewardForReflection, type WorkerJobHandlerDeps } from "../../../src/service/worker/job-handlers.js";
import { traceReflectionWasScored, traceSortKey } from "../../../src/service/evolution/span-pipeline.js";
import { episodeRewardInputVersion } from "../../../src/service/evolution/episode-revision.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG } from "../../../src/config/index.js";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories, type EpisodeRecord, type EvolutionJobRecord } from "../../../src/storage/repositories.js";
import { SkillClusterPipeline } from "../../../src/service/evolution/skill-cluster-pipeline.js";

import { RewardPipeline } from "../../../src/service/evolution/reward-pipeline.js";
import { traceMetaFromMemory } from "../../../src/algorithm/plugin-algorithms.js";
import { assignedEpisodeId, settleCaptureAssignments, createBatchReflectionLlm, createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const serviceFixture = createMemoryServiceFixture();
const resources: Array<{ root: string; db: MemoryDb }> = [];
const at = "2026-11-13T10:00:00.000Z";
afterEach(async () => {
  vi.restoreAllMocks();
  await serviceFixture.cleanup();
  for (const { root, db } of resources.splice(0)) {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "memmy-647-redo-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  resources.push({ root, db });
  const repos = new Repositories(db.db);
  repos.runtime.createSession({ id: "session", userId: "fixture", source: "codex", profileId: "647",
    status: "open", meta: {}, openedAt: at, updatedAt: at });
  function episode(id: string, meta: Record<string, unknown> = {}): EpisodeRecord {
    return repos.runtime.createEpisode({ id, sessionId: "session", userId: "fixture", status: "closed",
      l1MemoryIds: [], rawTurnIds: [], feedbackIds: [], decisionRepairIds: [], l2PolicyIds: [],
      l3WorldModelIds: [], skillMemoryIds: [], turnCount: 1, rTask: 1, rewardDetail: {},
      pipelineStatus: "idle", meta, openedAt: at, closedAt: at, updatedAt: at });
  }
  return { repos, episode };
}

function job(episodeId: string): EvolutionJobRecord {
  return { id: `assign-${episodeId}`, jobType: "skill_cluster_assign", status: "queued",
    userId: "fixture", episodeId, payload: {}, attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at };
}

describe("MEMMY-647 source reprocessing", () => {
  it.each(["long_text", "many_tools"] as const)("versions the complete source beyond serializer limits: %s", scenario => {
    const { repos, episode } = fixture();
    const record = episode("A");
    const raw = repos.runtime.insertRawTurn({ id: "long-raw", sessionId: "session", episodeId: record.id,
      turnId: "long-turn", userId: "fixture", userText: scenario === "long_text" ? "x".repeat(25_000) + "A" : "task",
      assistantText: "done", toolCalls: scenario === "many_tools" ? Array.from({ length: 1100 }, (_, i) => ({ name: "tool", input: String(i) })) : [],
      toolResults: [], sourceMemoryIds: [], usage: {}, status: "completed", createdAt: at });
    const before = episodeRewardInputVersion(repos, record);
    repos.runtime.updateRawTurn({ ...raw, ...(scenario === "long_text" ? { userText: "x".repeat(25_000) + "B" }
      : { toolCalls: [...raw.toolCalls.slice(0, -1), { name: "tool", input: "revised" }] }) });
    expect(episodeRewardInputVersion(repos, record)).not.toBe(before);
  });

  it("clears obsolete closure reasons on reopen while preserving unrelated metadata", () => {
    const { repos, episode } = fixture();
    episode("A", { closeReason: "abandoned", abandonReason: "no evidence", reward: { skipped: true },
      custom: { keep: true } });
    const reopened = repos.runtime.reopenEpisode("A")!;
    expect(reopened.status).toBe("open");
    expect(reopened.rTask).toBeUndefined();
    expect(reopened.meta.custom).toEqual({ keep: true });
    expect(reopened.meta).not.toHaveProperty("closeReason");
    expect(reopened.meta).not.toHaveProperty("abandonReason");
    expect(reopened.meta).not.toHaveProperty("reward");
  });

  it("does not reweight an existing member when the same task is assigned again", async () => {
    const { repos, episode } = fixture();
    episode("A"); episode("B");
    for (const id of ["A", "B"]) {
      repos.runtime.insertRawTurn({ id: `raw-${id}`, sessionId: "session", episodeId: id, turnId: id,
        userId: "fixture", userText: `query-${id}`, assistantText: "done", toolCalls: [], toolResults: [],
        sourceMemoryIds: [], usage: {}, status: "completed", createdAt: at });
    }
    repos.runtime.insertSkillCluster({ id: "cluster", userId: "fixture", tools: [], artifacts: [],
      toolBigrams: [], centroid: [0.5, 0.5], metaSkillMd: "", processedEpisodeIds: [], memberCount: 2,
      createdAt: at, updatedAt: at });
    for (const id of ["A", "B"]) repos.runtime.upsertSkillClusterMember({ clusterId: "cluster",
      episodeId: id, outcome: "success", rTask: 1, assignedAt: at });
    const pipeline = new SkillClusterPipeline({ repos, config: DEFAULT_MEMMY_CONFIG,
      skillLlm: createBatchReflectionLlm([]),
      queryVector: async query => query === "query-A" ? [1, 0] : [0, 1],
      buildMemory: () => { throw new Error("assignment must not generate memory"); },
      upsertEvolutionMemory: () => { throw new Error("assignment must not save memory"); },
      namespaceIdFromMemory: () => "fixture", enqueueJob: input => ({ ...job("A"), ...input }) });
    await pipeline.assignCluster(job("A"));
    const cluster = repos.runtime.getSkillCluster("cluster")!;
    expect(cluster.memberCount).toBe(2);
    expect(cluster.centroid).toEqual([0.5, 0.5]);
    expect(repos.runtime.listSkillClusterMembers("cluster")).toHaveLength(2);
    await pipeline.assignCluster(job("A"));
    expect(repos.runtime.getSkillCluster("cluster")?.centroid).toEqual([0.5, 0.5]);
    const oldTurn = repos.runtime.getRawTurn("raw-A")!;
    repos.runtime.updateRawTurn({ ...oldTurn, userText: "revised-query-A" });
    await pipeline.assignCluster(job("A"));
    expect(repos.runtime.getSkillCluster("cluster")?.centroid).toEqual([0, 1]);
    expect(repos.runtime.getSkillCluster("cluster")?.memberCount).toBe(2);
  });
});


describe("MEMMY-647 reward commit race", () => {
  it.each(["legacy", "unified"] as const)("finds old policy consumers after a source loses eligibility in %s mode", async mode => {
    const config = structuredClone(DEFAULT_MEMMY_CONFIG);
    config.algorithm.l2Induction.mode = mode;
    const { db, service } = serviceFixture.createTestService({ llm: createBatchReflectionLlm([]), config });
    const session = service.openSession({ namespace: { source: "codex", profileId: "647", userId: "fixture" } });
    const turn = await service.completeTurn(`647-consumers-${mode}`, { sessionId: session.sessionId,
      query: "Verify sqlite queue durability", answer: "The queue implementation failed durability verification" });
    await settleCaptureAssignments(service);
    const episodeId = assignedEpisodeId(service, turn);
    const repos = new Repositories(db.db);
    repos.runtime.closeEpisode(episodeId);
    const source = repos.memories.get(turn.l1MemoryId)!;
    for (const id of ["linked-policy", "metadata-policy"]) repos.memories.insert({ ...source, id,
      memoryLayer: "L2", memoryKey: id, properties: { internal_info: { memory_layer: "L2",
        policy: { status: "active", source_trace_ids: id === "metadata-policy" ? [source.id] : [] } } } });
    repos.runtime.insertTracePolicyLink({ userId: source.userId, l1MemoryId: source.id,
      l2MemoryId: "linked-policy", relation: "supports", createdAt: at });
    db.db.prepare("DELETE FROM trace_policy_links WHERE l2_memory_id = 'metadata-policy'").run();
    const recompute = vi.fn((_id: string) => undefined);
    const queued: Array<Record<string, unknown>> = [];
    const pipeline = new RewardPipeline({ repos, config, llm: createBatchReflectionLlm([]), nowIso: () => at,
      newId: prefix => `${prefix}-647`, traceMeta: memory => memory ? traceMetaFromMemory(memory) : null,
      namespaceIdFromMemory: () => "fixture", enqueueJob: input => { queued.push({ ...input }); return { ...job(episodeId), ...input }; },
      finalizeClosedEpisode: () => [], resolvePendingSkillTrialsForReward: () => {},
      decisionRepairTraceSources: () => [], synthesizeDecisionRepairDraft: async () => { throw new Error("unexpected repair"); },
      isTraceEligibleForL2: () => false, recordCandidatePoolTrace: () => {}, recomputePolicyStats: recompute,
      repairEvidenceValueDiff: () => 0 });
    vi.spyOn(pipeline, "scoreFeedbackWithLlm").mockResolvedValue({ rHuman: -1, source: "llm",
      axes: { goalAchievement: -1, processQuality: -1, userSatisfaction: -1 }, reason: "verification failed" });
    await pipeline.applyReward({ ...job(episodeId), jobType: "reward", targetMemoryId: source.id, payload: {} });
    expect(recompute.mock.calls.map(call => call[0]).sort()).toEqual(["linked-policy", "metadata-policy"]);
    queued.length = 0;
    vi.spyOn(pipeline, "scoreFeedbackWithLlm").mockResolvedValue({ rHuman: 1, source: "llm",
      axes: { goalAchievement: 1, processQuality: 1, userSatisfaction: 1 }, reason: "verified after revision" });
    await pipeline.applyReward({ ...job(episodeId), id: "positive-revision", jobType: "reward", targetMemoryId: source.id, payload: {} });
    expect(queued).toEqual(expect.arrayContaining([expect.objectContaining({ jobType: "negative_experience",
      payload: expect.objectContaining({ source: "episode_reward" }) })]));
  });

  it.each(["reopen", "reclose", "edit"] as const)("rejects stale reflection scores before reward when %s occurs", async scenario => {
    const base = createBatchReflectionLlm([]);
    let during: (() => void) | undefined;
    const llm = { ...base, async completeJson(...args: Parameters<typeof base.completeJson>) {
      if (args[1].operation === "capture.reflection.batch.v13") during?.();
      return base.completeJson(...args);
    } } as typeof base;
    const { db, service } = serviceFixture.createTestService({ llm, skillLlm: llm });
    const session = service.openSession({ namespace: { source: "codex", profileId: "647", userId: "fixture" } });
    const turn = await service.completeTurn("647-reflection-race", { sessionId: session.sessionId,
      query: "implement and verify a durable sqlite queue", answer: "implemented and verified the sqlite queue" });
    await settleCaptureAssignments(service);
    const repos = new Repositories(db.db);
    const episodeId = assignedEpisodeId(service, turn);
    repos.runtime.closeEpisode(episodeId);
    db.db.prepare("UPDATE evolution_jobs SET status='succeeded'").run();
    const before = repos.memories.get(turn.l1MemoryId);
    let modelEntered = false;
    during = () => {
      modelEntered = true;
      if (scenario === "edit") {
        const raw = repos.runtime.getRawTurn(turn.rawTurnId)!;
        repos.runtime.updateRawTurn({ ...raw, assistantText: "Correction: sqlite verification failed" });
      } else {
        repos.runtime.reopenEpisode(episodeId);
        if (scenario === "reclose") repos.runtime.closeEpisode(episodeId);
      }
    };
    repos.runtime.enqueueJob({ ...job(episodeId), id: "647-reflection-race", jobType: "reflection", targetMemoryId: turn.l1MemoryId,
      payload: { episodeGeneration: 0 } });
    await service.runWorkerOnce(1);
    expect(modelEntered).toBe(true);
    expect(repos.memories.get(turn.l1MemoryId)).toEqual(before);
    expect(repos.runtime.getJob("647-reflection-race")?.status).toBe("failed");
  });

  it.each([false, true])("retracts old derived inputs when a reopened task becomes skipped; write failure=%s", async fail => {
    const { db, service } = serviceFixture.createTestService({ llm: createBatchReflectionLlm([]) });
    const session = service.openSession({ namespace: { source: "codex", profileId: "647", userId: "fixture" } });
    const turn = await service.completeTurn("647-skipped", { sessionId: session.sessionId, query: "hi", answer: "hello" });
    await settleCaptureAssignments(service);
    const episodeId = assignedEpisodeId(service, turn);
    const repos = new Repositories(db.db);
    db.db.prepare("UPDATE episodes SET feedback_ids_json = '[]' WHERE id = ?").run(episodeId);
    repos.runtime.reopenEpisode(episodeId); repos.runtime.closeEpisode(episodeId);
    const before = repos.runtime.getEpisode(episodeId);
    const queued: Array<{ jobType: string }> = [];
    const recompute = vi.fn(() => undefined);
    vi.spyOn(repos.runtime, "listPolicyIdsForTraceSources").mockReturnValue(["old-policy"]);
    const pipeline = new RewardPipeline({ repos, config: DEFAULT_MEMMY_CONFIG,
      llm: createBatchReflectionLlm([]), nowIso: () => at, newId: prefix => `${prefix}-647`,
      traceMeta: memory => memory ? traceMetaFromMemory(memory) : null,
      namespaceIdFromMemory: () => "fixture", enqueueJob: input => {
        if (fail) throw new Error("injected skipped enqueue failure");
        queued.push(input); return { ...job(episodeId), ...input };
      }, finalizeClosedEpisode: () => [], resolvePendingSkillTrialsForReward: () => {},
      decisionRepairTraceSources: () => [], synthesizeDecisionRepairDraft: async () => { throw new Error("unexpected repair"); },
      isTraceEligibleForL2: () => false, recordCandidatePoolTrace: () => {},
      recomputePolicyStats: recompute, repairEvidenceValueDiff: () => 0 });
    const run = pipeline.applyReward({ ...job(episodeId), jobType: "reward", targetMemoryId: turn.l1MemoryId });
    if (fail) {
      await expect(run).rejects.toThrow("injected skipped enqueue failure");
      expect(repos.runtime.getEpisode(episodeId)).toEqual(before);
    } else {
      await run;
      expect(repos.runtime.getEpisode(episodeId)?.rewardDetail.skipped).toBe(true);
      expect(queued.some(item => item.jobType === "negative_experience")).toBe(true);
      expect(recompute).toHaveBeenCalledWith("old-policy", at, episodeId);
    }
  });

  it.each(["reopen", "reclose", "edit", "write_failure"] as const)("keeps reward commits consistent when %s occurs", async scenario => {
    const { db, service } = serviceFixture.createTestService({ llm: createBatchReflectionLlm([]) });
    const session = service.openSession({ namespace: { source: "codex", profileId: "647", userId: "fixture" } });
    const turn = await service.completeTurn("647-race", { sessionId: session.sessionId,
      query: "implement and verify a durable sqlite queue", answer: "implemented and verified the sqlite queue" });
    await settleCaptureAssignments(service);
    const episodeId = assignedEpisodeId(service, turn);
    const repos = new Repositories(db.db);
    repos.runtime.closeEpisode(episodeId);
    const pipeline = new RewardPipeline({ repos, config: DEFAULT_MEMMY_CONFIG,
      llm: createBatchReflectionLlm([]), nowIso: () => at, newId: prefix => `${prefix}-647`,
      traceMeta: memory => memory ? traceMetaFromMemory(memory) : null,
      namespaceIdFromMemory: () => "fixture", enqueueJob: input => ({ ...job(episodeId), ...input }),
      finalizeClosedEpisode: () => [], resolvePendingSkillTrialsForReward: () => {},
      decisionRepairTraceSources: () => [], synthesizeDecisionRepairDraft: async () => { throw new Error("unexpected repair"); },
      isTraceEligibleForL2: () => false, recordCandidatePoolTrace: () => {},
      recomputePolicyStats: () => undefined, repairEvidenceValueDiff: () => 0 });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(pipeline, "scoreFeedbackWithLlm").mockImplementation(async () => {
      entered(); await gate;
      return { rHuman: 1, source: "llm", axes: { goalAchievement: 1, processQuality: 1, userSatisfaction: 1 }, reason: "old result" };
    });
    const task = pipeline.applyReward({ ...job(episodeId), jobType: "reward", targetMemoryId: turn.l1MemoryId,
      payload: { polarity: "positive", magnitude: 1 } });
    await started;
    if (scenario === "reopen" || scenario === "reclose") repos.runtime.reopenEpisode(episodeId);
    if (scenario === "reclose") repos.runtime.closeEpisode(episodeId);
    if (scenario === "edit") {
      const raw = repos.runtime.getRawTurn(turn.rawTurnId)!;
      repos.runtime.updateRawTurn({ ...raw, assistantText: "the queue did not pass verification" });
    }
    const before = repos.memories.get(turn.l1MemoryId)!;
    if (scenario === "write_failure") vi.spyOn(repos.memories, "update").mockImplementation(() => {
      throw new Error("injected trace write failure");
    });
    release();
    if (scenario === "write_failure") await expect(task).rejects.toThrow("injected trace write failure");
    else await task;
    expect(repos.runtime.getEpisode(episodeId)?.rTask).toBeUndefined();
    expect(repos.memories.get(turn.l1MemoryId)).toEqual(before);
  });
});


describe("MEMMY-647 real desktop task with derived spans", () => {
  it.each([false, true])("does not select a derived span for reflection; original scored=%s", async scored => {
    const { db, service } = serviceFixture.createTestService({ llm: createBatchReflectionLlm([]) });
    const session = service.openSession({ namespace: { source: "codex", profileId: "647", userId: "fixture" } });
    const turn = await service.completeTurn("647-span-reflection", {sessionId:session.sessionId,
      query:"Audit twelve files and verify their sum",answer:"Verified all twelve files and sum 78"});
    await settleCaptureAssignments(service);
    const repos = new Repositories(db.db);
    const original = repos.memories.get(turn.l1MemoryId)!;
    const trace = original.properties.internal_info.trace as Record<string, unknown>;
    const saved = repos.memories.update({...original,properties:{...original.properties,
      internal_info:{...original.properties.internal_info,capture_decision:{status:"decided"},
        trace:{...trace,...(scored?{reflection_scored_at:at}:{reflection_scored_at:undefined})}}}});
    const span = repos.memories.insert({...saved,id:"647-derived-span",memoryKey:"647-derived-span",
      properties:{internal_info:{memory_layer:"L1",memory_kind:"span",span:{episode_id:assignedEpisodeId(service,turn),source_trace_id:saved.id}}}});
    const episode = {...repos.runtime.getEpisode(assignedEpisodeId(service,turn))!,status:"closed" as const,
      l1MemoryIds:[span.id,saved.id],rTask:undefined,rewardDetail:{}};
    db.db.prepare("UPDATE evolution_jobs SET status='succeeded'").run();
    const deps = {repos,traceReflectionWasScored,traceSortKey} as unknown as WorkerJobHandlerDeps;
    const queued = enqueueEpisodeReflection(deps,episode,at,"topic_boundary");
    expect(queued.map(job=>job.targetMemoryId)).toEqual(scored?[]:[saved.id]);
    expect(episodeHasRewardForReflection(deps,{...episode,rTask:1,rewardDetail:{phase:"final",traceIds:[saved.id]}})).toBe(true);
  });
});
