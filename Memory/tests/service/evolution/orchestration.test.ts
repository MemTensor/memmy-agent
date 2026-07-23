import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MEMMY_CONFIG, MemoryDb } from "../../../src/index.js";
import {
  addPositiveFeedbackForTurn,
  insertActivePolicyMemory,
  insertTracePolicyLinkForTest,
  makeTraceEligibleForL2,
  setPolicySignatureAndVectorForTest,
  setPolicyStatsForTest,
  traceSignatureForTest
} from "../../fixtures/evolution-fixture.js";
import {
  createCapturingL2Llm,
  createNoToolSkillLlm
} from "./evolution-llm-stubs.js";
import {
  createCapturingEmbedder,
  createMemoryServiceFixture
} from "../../fixtures/memory-service-fixture.js";

const {
  cleanup,
  createTestMemoryService,
  createTestRoot,
  createTestService
} = createMemoryServiceFixture();

afterEach(cleanup);

describe("MemoryService / evolution / orchestration", () => {
  it("adds feedback and evolves L2/L3/Skill memories with the worker", async () => {
    const { db, service } = createTestService({
      skillLlm: createNoToolSkillLlm(),
      embedder: createCapturingEmbedder([])
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-2"
      }
    });
    const completes = [
      service.completeTurn("turn-python-test-a", {
      sessionId: session.sessionId,
      episodeId: "episode-python-test-a",
      query: "python vitest test workflow should keep REST agent loop decoupled",
      answer: "Use prepare, complete, recall, then worker run for memory evolution."
    }),
      service.completeTurn("turn-python-test-b", {
        sessionId: session.sessionId,
        episodeId: "episode-python-test-b",
        query: "python unit test workflow should keep REST agent loop decoupled",
        answer: "Use prepare, complete, recall, then worker run for memory evolution."
      }),
      service.completeTurn("turn-python-error-a", {
        sessionId: session.sessionId,
        episodeId: "episode-python-error-a",
        query: "python error handling workflow should keep REST agent loop decoupled",
        answer: "Capture the error signature and reuse the successful recovery policy."
      }),
      service.completeTurn("turn-python-error-b", {
        sessionId: session.sessionId,
        episodeId: "episode-python-error-b",
        query: "python exception handling workflow should keep REST agent loop decoupled",
        answer: "Capture the error signature and reuse the successful recovery policy."
      })
    ];

    for (const complete of completes) {
      const feedback = await service.feedback({
        sessionId: session.sessionId,
        l1MemoryId: complete.l1MemoryId,
        channel: "explicit",
        polarity: "positive",
        magnitude: 1,
        rationale: "the remembered workflow was useful"
      });
      expect(feedback.feedbackId).toMatch(/^feedback_/);
      makeTraceEligibleForL2(db, complete.l1MemoryId);
    }

    let succeeded = 0;
    for (let i = 0; i < 20; i += 1) {
      succeeded += (await service.runWorkerOnce(100)).succeeded;
    }
    expect(succeeded).toBeGreaterThanOrEqual(8);

    const overview = service.panelOverview({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-2"
      }
    });
    expect(overview.counts.L1).toBe(4);
    expect(overview.counts.L2).toBeGreaterThanOrEqual(1);
    expect(overview.counts.L3).toBeGreaterThanOrEqual(1);
    expect(overview.counts.Skill).toBeGreaterThanOrEqual(1);
    const promotedCandidates = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM l2_candidate_pool
       WHERE status = 'promoted'`
    ).get() as { count: number };
    expect(promotedCandidates.count).toBeGreaterThanOrEqual(1);
    const l3Row = db.db.prepare(
      `SELECT properties_json FROM memories
       WHERE user_id = 'user-2' AND memory_layer = 'L3'
       LIMIT 1`
    ).get() as { properties_json: string };
    const l3Properties = JSON.parse(l3Row.properties_json) as {
      internal_info: {
        title?: string;
        body?: string;
        structure?: {
          environment?: unknown[];
          inference?: unknown[];
          constraints?: unknown[];
        };
        domain_tags?: string[];
        source_policy_ids?: string[];
        world_model_confidence?: number;
        world_model: {
          structure?: {
            environment?: unknown[];
            inference?: unknown[];
            constraints?: unknown[];
          };
        };
      };
    };
    expect(l3Properties.internal_info.world_model.structure?.environment?.length).toBeGreaterThan(0);
    expect(l3Properties.internal_info.world_model.structure?.inference?.length).toBeGreaterThan(0);
    expect(l3Properties.internal_info.world_model.structure?.constraints?.length).toBeGreaterThan(0);
    expect(l3Properties.internal_info.structure?.environment?.length).toBeGreaterThan(0);
    expect(l3Properties.internal_info.source_policy_ids?.length).toBeGreaterThan(0);
    expect(l3Properties.internal_info.world_model_confidence).toBeGreaterThanOrEqual(0.2);
    const l2Row = db.db.prepare(
      `SELECT properties_json FROM memories
       WHERE user_id = 'user-2' AND memory_layer = 'L2'
       LIMIT 1`
    ).get() as { properties_json: string };
    const l2Internal = (JSON.parse(l2Row.properties_json) as {
      internal_info: {
        title?: string;
        trigger?: string;
        procedure?: string;
        verification?: string;
        boundary?: string;
        source_l1_memory_ids?: string[];
        policy_confidence?: number;
      };
    }).internal_info;
    expect(l2Internal.title).toBeTruthy();
    expect(l2Internal.trigger).toBeTruthy();
    expect(l2Internal.procedure).toBeTruthy();
    expect(l2Internal.verification).toBeTruthy();
    expect(l2Internal.boundary).toBeTruthy();
    expect(l2Internal.source_l1_memory_ids?.length).toBeGreaterThan(0);
    expect(l2Internal.policy_confidence).toBeGreaterThan(0);
    const associationStatsUpdates = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM memory_change_log
       WHERE source = 'worker.l2_association.v7'`
    ).get() as { count: number };
    expect(associationStatsUpdates.count).toBeGreaterThan(0);
    const workerMemoryChanges = db.db.prepare(
      `SELECT namespace_id, kind, op, entity_id
       FROM memory_change_log
       WHERE source IN (
         'worker.reward.backprop.v7',
         'worker.l2_association.v7',
         'worker.l2_induction.v7',
         'worker.l3_abstraction.v7',
         'worker.skill_crystallization.v7'
       )
         AND kind IN ('trace', 'policy', 'world_model', 'skill')
         AND op IN ('created', 'updated')`
    ).all() as Array<{ namespace_id: string | null; kind: string | null; op: string | null; entity_id: string | null }>;
    expect(workerMemoryChanges.length).toBeGreaterThan(0);
    for (const change of workerMemoryChanges) {
      expect(change.namespace_id).toContain("user-2");
      expect(change.kind).toMatch(/^(trace|policy|world_model|skill)$/);
      expect(change.op).toMatch(/^(created|updated)$/);
      expect(change.entity_id).toBeTruthy();
    }
    const jobChanges = db.db.prepare(
      `SELECT op, COUNT(*) AS count
       FROM memory_change_log
       WHERE kind = 'job'
       GROUP BY op`
    ).all() as Array<{ op: string; count: number }>;
    expect(jobChanges.map((change) => change.op)).toEqual(expect.arrayContaining([
      "queued",
      "leased",
      "succeeded"
    ]));

    const skills = service.listSkills({
      userId: "user-2"
    });
    expect(skills.items.length).toBeGreaterThanOrEqual(1);
    const searchedSkills = service.listSkills({
      userId: "user-2",
      q: "REST memory workflow"
    });
    expect(searchedSkills.items.length).toBeGreaterThanOrEqual(1);
    const skillId = skills.items[0]!.id;
    const trial = service.useSkill(skillId, {
      adapterId: "test-adapter",
      requestId: "skill-use-1",
      sessionId: session.sessionId,
      episodeId: completes[0]!.episodeId,
      rawTurnId: completes[0]!.rawTurnId,
      turnId: completes[0]!.turnId
    });
    const duplicateTrial = service.useSkill(skillId, {
      adapterId: "test-adapter",
      requestId: "skill-use-1",
      sessionId: session.sessionId,
      episodeId: completes[0]!.episodeId,
      rawTurnId: completes[0]!.rawTurnId,
      turnId: completes[0]!.turnId
    });
    expect(duplicateTrial.trialId).toBe(trial.trialId);
    expect(duplicateTrial.duplicate).toBe(true);
    const duplicateEpisodeTrial = service.useSkill(skillId, {
      adapterId: "test-adapter",
      requestId: "skill-use-2",
      sessionId: session.sessionId,
      episodeId: completes[0]!.episodeId,
      rawTurnId: completes[0]!.rawTurnId,
      turnId: completes[0]!.turnId
    });
    expect(duplicateEpisodeTrial.trialId).toBe(trial.trialId);
    expect(duplicateEpisodeTrial.duplicate).toBe(true);
    const pendingTrialCount = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM skill_trials
       WHERE skill_memory_id = ?
         AND episode_id = ?
         AND outcome = 'unknown'`
    ).get(skillId, completes[0]!.episodeId) as { count: number };
    expect(pendingTrialCount.count).toBe(1);
    const pendingTrial = db.db.prepare(
      `SELECT status, outcome, l1_memory_id
       FROM skill_trials
       WHERE id = ?`
    ).get(trial.trialId) as { status: string; outcome: string; l1_memory_id: string | null };
    expect(pendingTrial.status).toBe("pending");
    expect(pendingTrial.outcome).toBe("unknown");
    expect(pendingTrial.l1_memory_id).toBe(completes[0]!.l1MemoryId);
    const prematureResolveJobs = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM evolution_jobs
       WHERE job_type = 'skill_trial_resolve'
         AND json_extract(payload_json, '$.trialId') = ?`
    ).get(trial.trialId) as { count: number };
    expect(prematureResolveJobs.count).toBe(0);
    const pendingSkillListItem = service.listSkills({ userId: "user-2" }).skills.find((item) => item.id === skillId);
    expect(pendingSkillListItem).toMatchObject({
      usageCount: 1,
      pendingTrials: 1
    });
    expect(pendingSkillListItem?.lastUsedAt).toBeTruthy();
    const pendingSkillDetail = service.getSkill(skillId);
    expect(pendingSkillDetail.reliability).toMatchObject({
      usageCount: 1,
      pendingTrials: 1,
      trialsAttempted: 0,
      trialsPassed: 0
    });
    expect(pendingSkillDetail.reliability.lastUsedAt).toBeTruthy();
    const pendingSkillRow = db.db.prepare(
      `SELECT properties_json
       FROM memories
       WHERE id = ?`
    ).get(skillId) as { properties_json: string };
    const pendingSkillMeta = (JSON.parse(pendingSkillRow.properties_json) as {
      internal_info: { skill: Record<string, unknown> };
    }).internal_info.skill;
    expect(pendingSkillMeta.usage_count).toBeUndefined();
    expect(pendingSkillMeta.last_used_at).toBeUndefined();
    const trialCreatedChange = db.db.prepare(
      `SELECT kind, op, entity_id
       FROM memory_change_log
       WHERE entity_id = ?
       ORDER BY seq DESC
       LIMIT 1`
    ).get(trial.trialId) as { kind: string; op: string; entity_id: string };
    expect(trialCreatedChange).toMatchObject({
      kind: "skill_trial",
      op: "created",
      entity_id: trial.trialId
    });
    const skillFeedback = await service.feedback({
      sessionId: session.sessionId,
      episodeId: completes[0]!.episodeId,
      rawTurnId: completes[0]!.rawTurnId,
      channel: "explicit",
      polarity: "positive",
      magnitude: 1,
      rationale: "skill invocation succeeded"
    });
    const trialResolveJob = skillFeedback.jobs.find((job) => job.jobType === "skill_trial_resolve");
    expect(trialResolveJob?.targetMemoryId).toBeUndefined();
    const trialResolveJobRow = db.db.prepare(
      `SELECT episode_id, target_memory_id, payload_json
       FROM evolution_jobs
       WHERE id = ?`
    ).get(trialResolveJob!.jobId) as {
      episode_id: string | null;
      target_memory_id: string | null;
      payload_json: string;
    };
    expect(trialResolveJobRow.episode_id).toBe(completes[0]!.episodeId);
    expect(trialResolveJobRow.target_memory_id).toBeNull();
    expect(JSON.parse(trialResolveJobRow.payload_json)).toMatchObject({
      trialId: trial.trialId,
      feedbackId: skillFeedback.feedbackId,
      targetKind: "skill_trial"
    });
    await service.runWorkerOnce(100);
    const skillDetail = service.getSkill(skillId);
    const skillProperties = skillDetail.metadata.properties as {
      internal_info: {
        invocation_guide?: string;
        procedure_json?: {
          reliability?: {
            successRate?: number;
          };
        };
        eta?: number;
        support?: number;
        gain?: number;
        source_policy_ids?: string[];
        source_world_model_ids?: string[];
        skill: Record<string, unknown>;
      };
    };
    const skillMeta = skillProperties.internal_info.skill;
    expect(skillMeta.trials_attempted).toBeGreaterThanOrEqual(1);
    expect(skillMeta.trials_passed).toBeGreaterThanOrEqual(1);
    expect(skillMeta.success_rate).toBe(1);
    expect(skillMeta.beta_posterior).toMatchObject({
      alpha: 2,
      beta: 1,
      mean: 2 / 3
    });
    expect(skillMeta.status).toBe("active");
    expect(skillMeta.eta).toBeGreaterThan(0.1);
    expect(skillProperties.internal_info.invocation_guide).toBe(skillMeta.invocation_guide);
    expect(skillProperties.internal_info.eta).toBe(skillMeta.eta);
    expect(skillProperties.internal_info.support).toBe(skillMeta.support);
    expect(skillProperties.internal_info.gain).toBe(skillMeta.gain);
    expect(skillProperties.internal_info.source_policy_ids).toEqual(skillMeta.source_policy_ids);
    expect(skillProperties.internal_info.source_world_model_ids).toEqual(skillMeta.source_world_model_ids);
    expect(skillProperties.internal_info.procedure_json?.reliability?.successRate).toBe(1);
    expect(skillMeta.evidence_anchor_ids).toEqual(expect.any(Array));
    expect((skillMeta.evidence_anchor_ids as string[]).length).toBeGreaterThan(0);
    expect(skillDetail.evidenceAnchorIds.length).toBeGreaterThan(0);
    expect(skillDetail.reliability).toMatchObject({
      usageCount: 1,
      pendingTrials: 0,
      trialsAttempted: 1,
      trialsPassed: 1,
      successRate: 1,
      betaPosterior: {
        alpha: 2,
        beta: 1,
        mean: 2 / 3
      }
    });
    const updatedSkills = service.listSkills({ userId: "user-2" });
    expect(updatedSkills.skills.find((item) => item.id === skillId)).toMatchObject({
      usageCount: 1,
      pendingTrials: 0,
      successRate: 1,
      betaPosterior: {
        alpha: 2,
        beta: 1,
        mean: 2 / 3
      }
    });
    expect(skillDetail.sourceWorldModelIds).toEqual([]);
    const skillProcedure = skillMeta.procedure_json as {
      reliability?: {
        successRate?: number;
        betaPosterior?: {
          mean?: number;
        };
      };
    };
    expect(skillProcedure).not.toHaveProperty("domainModel");
    expect(skillProcedure.reliability).toMatchObject({
      successRate: 1,
      betaPosterior: {
        mean: 2 / 3
      }
    });
    expect(skillMeta.verification).toMatchObject({ ok: true });
    const resolvedTrial = db.db.prepare(
      `SELECT status, outcome FROM skill_trials WHERE id = ?`
    ).get(trial.trialId) as { status: string; outcome: string };
    expect(resolvedTrial.status).toBe("pass");
    expect(resolvedTrial.outcome).toBe("success");
    const memorySkillDetail = service.getMemory(skillId);
    expect(memorySkillDetail.refs.skillTrials).toEqual(expect.arrayContaining([
      {
        trialId: trial.trialId,
        status: "pass",
        episodeId: completes[0]!.episodeId,
        reward: expect.any(Number)
      }
    ]));
    const episodeIndexes = db.db.prepare(
      `SELECT l2_policy_ids_json, l3_world_model_ids_json, skill_memory_ids_json
       FROM episodes
       WHERE id = ?`
    ).get(completes[0]!.episodeId) as {
      l2_policy_ids_json: string;
      l3_world_model_ids_json: string;
      skill_memory_ids_json: string;
    };
    expect(JSON.parse(episodeIndexes.l2_policy_ids_json)).toEqual(expect.arrayContaining([
      expect.any(String)
    ]));
    expect(JSON.parse(episodeIndexes.l3_world_model_ids_json)).toEqual(expect.arrayContaining([
      expect.any(String)
    ]));
    expect(JSON.parse(episodeIndexes.skill_memory_ids_json)).toContain(skillId);
    const traceDetailAfterSkill = service.getMemory(completes[0]!.l1MemoryId);
    expect(traceDetailAfterSkill.refs.episode).toMatchObject({
      id: completes[0]!.episodeId,
      skillStatus: "succeeded",
      skillReason: "已从该任务沉淀出可复用技能。",
      skillMemoryIds: expect.arrayContaining([skillId]),
      linkedSkillId: skillId
    });
    const trialResolvedChange = db.db.prepare(
      `SELECT kind, op, entity_id, source
       FROM memory_change_log
       WHERE entity_id = ?
       ORDER BY seq DESC
       LIMIT 1`
    ).get(trial.trialId) as { kind: string; op: string; entity_id: string; source: string };
    expect(trialResolvedChange).toMatchObject({
      kind: "skill_trial",
      op: "updated",
      entity_id: trial.trialId,
      source: "worker.reward.updated"
    });

    const recall = await service.search({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-2"
      },
      query: "python REST memory workflow",
      includeInjectedContext: true
    });
    expect(recall.hits.some((hit) => hit.memoryLayer === "Skill")).toBe(true);
    const world = await service.worldModelQuery({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-2"
      },
      query: "pytest sqlite migration environment"
    });
    expect(world.hits.some((hit) => hit.memoryLayer === "L3")).toBe(true);
    const l3ChangesBeforeRepeat = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM memory_change_log
       WHERE source = 'worker.l3_abstraction.v7'`
    ).get() as { count: number };
    const policyForRepeat = db.db.prepare(
      `SELECT id
       FROM memories
       WHERE memory_layer = 'L2'
         AND user_id = 'user-2'
       LIMIT 1`
    ).get() as { id: string } | undefined;
    expect(policyForRepeat).toBeTruthy();
    const queuedAt = new Date().toISOString();
    db.db.prepare(
      `INSERT INTO evolution_jobs (
         id, job_type, status, user_id, target_memory_id, payload_json,
         attempts, max_attempts, created_at, updated_at
       ) VALUES (?, 'l3_abstraction', 'queued', 'user-2', ?, '{}', 0, 3, ?, ?)`
    ).run("job_l3_repeat", policyForRepeat!.id, queuedAt, queuedAt);
    await service.runWorkerOnce(10);
    const l3ChangesAfterRepeat = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM memory_change_log
       WHERE source = 'worker.l3_abstraction.v7'`
    ).get() as { count: number };
    expect(l3ChangesAfterRepeat.count).toBeGreaterThan(l3ChangesBeforeRepeat.count);
    db.close();
  });

  it("queues L3 abstraction and skill crystallization when L2 association activates a candidate policy", async () => {
    const { db, service } = createTestService();
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-l2-activation-downstream"
      },
      workspaceId: "workspace-l2-activation"
    });
    const first = service.completeTurn("turn-l2-activation-1", {
      sessionId: session.sessionId,
      episodeId: "episode-l2-activation-1",
      query: "python pytest retry activation evidence one",
      answer: "Run pytest, inspect the failure, retry after fixing issue, then verify the result."
    });
    await addPositiveFeedbackForTurn(service, session.sessionId, first);
    makeTraceEligibleForL2(db, first.l1MemoryId);
    db.db.prepare(`UPDATE evolution_jobs SET status = 'succeeded'`).run();
    insertActivePolicyMemory(db, {
      id: "policy_l2_activation_downstream",
      userId: "user-l2-activation-downstream",
      sessionId: session.sessionId,
      agentId: "codex",
      appId: "workspace-l2-activation",
      profileId: "jiang",
      sourceTraceId: first.l1MemoryId,
      sourceEpisodeId: first.episodeId
    });
    const second = service.completeTurn("turn-l2-activation-2", {
      sessionId: session.sessionId,
      episodeId: "episode-l2-activation-2",
      query: "python pytest retry activation evidence two",
      answer: "Run pytest, inspect the failure, retry after fixing issue, then verify the result."
    });
    await addPositiveFeedbackForTurn(service, session.sessionId, second);
    makeTraceEligibleForL2(db, second.l1MemoryId);
    const signature = traceSignatureForTest(db, second.l1MemoryId);
    setPolicySignatureAndVectorForTest(db, "policy_l2_activation_downstream", signature, [1, 0, 0]);
    setPolicyStatsForTest(db, "policy_l2_activation_downstream", {
      status: "candidate",
      memoryStatus: "resolving",
      support: 1,
      gain: 0,
      rawGain: 0,
      confidence: 0.5
    });
    insertTracePolicyLinkForTest(db, {
      userId: "user-l2-activation-downstream",
      l1MemoryId: first.l1MemoryId,
      l2MemoryId: "policy_l2_activation_downstream"
    });

    service.closeSession(session.sessionId);
    await service.runWorkerOnce(20);
    makeTraceEligibleForL2(db, second.l1MemoryId);
    db.db.prepare(
      `UPDATE evolution_jobs
       SET status = 'succeeded'
       WHERE NOT (target_memory_id = ? AND job_type = 'l2_association')`
    ).run(second.l1MemoryId);
    await service.runWorkerOnce(20);

    const policyRow = db.db.prepare(
      `SELECT status, properties_json
       FROM memories
       WHERE id = 'policy_l2_activation_downstream'`
    ).get() as { status: string; properties_json: string };
    const properties = JSON.parse(policyRow.properties_json) as {
      internal_info?: {
        policy?: {
          status?: string;
        };
      };
    };
    expect(policyRow.status).toBe("activated");
    expect(properties.internal_info?.policy?.status).toBe("active");
    const downstreamJobs = db.db.prepare(
      `SELECT job_type, status, episode_id, target_memory_id, payload_json
       FROM evolution_jobs
       WHERE job_type IN ('l3_abstraction', 'skill_crystallization')
         AND (
           target_memory_id = 'policy_l2_activation_downstream'
           OR json_extract(payload_json, '$.seedPolicyId') = 'policy_l2_activation_downstream'
         )
       ORDER BY job_type`
    ).all() as Array<{
      job_type: string;
      status: string;
      episode_id: string | null;
      target_memory_id: string | null;
      payload_json: string;
    }>;
    expect(downstreamJobs.map((job) => job.job_type)).toEqual(["l3_abstraction", "skill_crystallization"]);
    expect(downstreamJobs.map((job) => job.status)).toEqual(["queued", "queued"]);
    expect(downstreamJobs.map((job) => job.episode_id)).toEqual([
      "episode-l2-activation-2",
      "episode-l2-activation-2"
    ]);
    const l3Job = downstreamJobs.find((job) => job.job_type === "l3_abstraction");
    const skillJob = downstreamJobs.find((job) => job.job_type === "skill_crystallization");
    expect(l3Job?.target_memory_id).toBeNull();
    expect(JSON.parse(l3Job!.payload_json)).toMatchObject({
      reason: "l2.policy.updated",
      targetKind: "policy_cluster",
      seedPolicyId: "policy_l2_activation_downstream",
      policyIds: ["policy_l2_activation_downstream"],
      previousStatus: "candidate",
      status: "active"
    });
    expect(skillJob?.target_memory_id).toBe("policy_l2_activation_downstream");
    expect(JSON.parse(skillJob!.payload_json)).toMatchObject({
      reason: "l2.policy.updated",
      previousStatus: "candidate",
      status: "active"
    });

    db.close();
  });

  it("uses policies across namespaces for L3 abstraction and skill crystallization", async () => {
    const { db, service } = createTestService({ skillLlm: createNoToolSkillLlm() });
    const profileA = service.openSession({
      namespace: {
        source: "codex",
        profileId: "profile-a",
        userId: "shared-downstream-user"
      },
      workspaceId: "workspace-shared"
    });
    const profileB = service.openSession({
      namespace: {
        source: "codex",
        profileId: "profile-b",
        userId: "shared-downstream-user"
      },
      workspaceId: "workspace-shared"
    });
    const completeA = service.completeTurn("turn-downstream-a", {
      sessionId: profileA.sessionId,
      episodeId: "episode-downstream-a",
      query: "python pytest inspect failure retry after fixing issue for profile a",
      answer: "Run pytest, inspect the failure, retry after fixing issue, then verify the result."
    });
    const completeB = service.completeTurn("turn-downstream-b", {
      sessionId: profileB.sessionId,
      episodeId: "episode-downstream-b",
      query: "python pytest inspect failure retry after fixing issue for profile b",
      answer: "Run pytest, inspect the failure, retry after fixing issue, then verify the result."
    });
    const at = new Date().toISOString();
    insertActivePolicyMemory(db, {
      id: "policy_downstream_profile_a",
      userId: "shared-downstream-user",
      sessionId: profileA.sessionId,
      agentId: "codex",
      appId: "workspace-shared",
      profileId: "profile-a",
      sourceTraceId: completeA.l1MemoryId,
      sourceEpisodeId: completeA.episodeId
    });
    insertActivePolicyMemory(db, {
      id: "policy_downstream_profile_b",
      userId: "shared-downstream-user",
      sessionId: profileB.sessionId,
      agentId: "codex",
      appId: "workspace-shared",
      profileId: "profile-b",
      sourceTraceId: completeB.l1MemoryId,
      sourceEpisodeId: completeB.episodeId
    });
    db.db.prepare(`UPDATE evolution_jobs SET status = 'succeeded'`).run();
    db.db.prepare(
      `INSERT INTO evolution_jobs (
         id, job_type, status, user_id, session_id, episode_id, target_memory_id,
         payload_json, attempts, max_attempts, created_at, updated_at
       ) VALUES
         (?, 'l3_abstraction', 'queued', ?, ?, ?, ?, '{}', 0, 3, ?, ?),
         (?, 'skill_crystallization', 'queued', ?, ?, ?, ?, '{}', 0, 3, ?, ?)`
    ).run(
      "job_l3_downstream_profile_a",
      "shared-downstream-user",
      profileA.sessionId,
      completeA.episodeId,
      "policy_downstream_profile_a",
      at,
      at,
      "job_skill_downstream_profile_a",
      "shared-downstream-user",
      profileA.sessionId,
      completeA.episodeId,
      completeA.l1MemoryId,
      at,
      at
    );

    await service.runWorkerOnce(20);

    const worlds = db.db.prepare(
      `SELECT info_json, properties_json
       FROM memories
       WHERE user_id = 'shared-downstream-user'
         AND memory_layer = 'L3'`
    ).all() as Array<{ info_json: string; properties_json: string }>;
    expect(worlds).toHaveLength(1);
    expect(JSON.parse(worlds[0]!.info_json).profile_id).toBe("profile-a");
    const worldMeta = JSON.parse(worlds[0]!.properties_json) as {
      internal_info: {
        world_model: {
          policy_ids?: string[];
        };
      };
    };
    expect(worldMeta.internal_info.world_model.policy_ids?.sort()).toEqual([
      "policy_downstream_profile_a",
      "policy_downstream_profile_b"
    ].sort());

    const skills = db.db.prepare(
      `SELECT info_json, properties_json
       FROM memories
       WHERE user_id = 'shared-downstream-user'
         AND memory_layer = 'Skill'`
    ).all() as Array<{ info_json: string; properties_json: string }>;
    expect(skills).toHaveLength(2);
    const skillPolicyIds = skills.flatMap((skill) => {
      const skillMeta = JSON.parse(skill.properties_json) as {
        internal_info: {
          skill: {
            source_policy_ids?: string[];
          };
        };
      };
      return skillMeta.internal_info.skill.source_policy_ids ?? [];
    });
    expect(skillPolicyIds.sort()).toEqual([
      "policy_downstream_profile_a",
      "policy_downstream_profile_b"
    ].sort());

    db.close();
  });

  it("uses the plugin L3 abstraction and skill crystallization prompt contracts", async () => {
    const root = createTestRoot("mindock-memory-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const calls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string; thinkingMode?: "inherit" | "enabled" | "disabled" };
    }> = [];
    const service = createTestMemoryService({
      db,
      mode: "dev",
      skillLlm: createCapturingL2Llm(calls, undefined, undefined, {
        title: "Pytest sqlite migration environment <script>alert(1)</script>",
        domain_tags: ["Pytest", "SQLITE", "this-tag-name-is-way-too-long", "pytest"],
        environment: [{
          label: "test harness <script>alert(1)</script>",
          description: "The project has [pytest](javascript:alert(1)) checks that exercise sqlite migration behavior.",
          evidenceIds: []
        }],
        inference: [{
          label: "migration failures",
          description: "Focused pytest failures expose sqlite migration regressions before broader runs.",
          evidenceIds: []
        }],
        constraints: [{
          label: "schema state",
          description: "<script>alert(1)</script>SQLite schema state affects whether migration tests produce stable outcomes.",
          evidenceIds: []
        }],
        body: "Pytest [sqlite](javascript:alert(1)) migration environment. <script>alert(1)</script>",
        confidence: 0.82
      }),
      config: {
        ...DEFAULT_MEMMY_CONFIG,
        algorithm: {
          ...DEFAULT_MEMMY_CONFIG.algorithm,
          capture: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.capture,
            synthReflection: false,
            embedAfterCapture: false
          },
          l2Induction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l2Induction,
            traceCharCap: 700
          },
          l3Abstraction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l3Abstraction,
            useLlm: true,
            minPolicies: 1,
            minPolicySupport: 1,
            minPolicyGain: 0.01
          },
          skill: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.skill,
            useLlm: true,
            minSupport: 1,
            minGain: -1,
            evidenceLimit: 5,
            traceCharCap: 80
          }
        }
      }
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-l3-skill-prompt"
      }
    });
    const first = service.completeTurn("turn-l3-skill-prompt-a", {
      sessionId: session.sessionId,
      episodeId: "episode-l3-skill-prompt-a",
      query: `pytest sqlite migration workflow needs focused diagnostics ${"u".repeat(200)}`,
      answer: "Run focused tests, inspect migration output, then retry the exact failure.",
      toolCalls: [{
        name: "shell",
        input: "npm test -- migration",
        output: "ok",
        success: true
      }]
    });
    const second = service.completeTurn("turn-l3-skill-prompt-b", {
      sessionId: session.sessionId,
      episodeId: "episode-l3-skill-prompt-b",
      query: `pytest sqlite schema migration workflow needs focused diagnostics ${"v".repeat(200)}`,
      answer: "Run focused tests, inspect migration output, then retry the exact failure.",
      toolCalls: [{
        name: "shell",
        input: "npm test -- schema",
        output: "ok",
        success: true
      }]
    });
    for (const complete of [first, second]) {
      await service.feedback({
        sessionId: session.sessionId,
        l1MemoryId: complete.l1MemoryId,
        channel: "explicit",
        polarity: "positive",
        magnitude: 1,
        rationale: "the focused pytest migration workflow worked"
      });
      makeTraceEligibleForL2(db, complete.l1MemoryId);
    }
    let policyCreated = false;
    for (let i = 0; i < 20; i += 1) {
      await service.runWorkerOnce(1);
      const l2Count = db.db.prepare(
        `SELECT COUNT(*) AS count
         FROM memories
         WHERE user_id = 'user-l3-skill-prompt' AND memory_layer = 'L2'`
      ).get() as { count: number };
      if (l2Count.count > 0) {
        policyCreated = true;
        break;
      }
    }
    expect(policyCreated).toBe(true);

    const policyRow = db.db.prepare(
      `SELECT id, properties_json
       FROM memories
       WHERE user_id = 'user-l3-skill-prompt' AND memory_layer = 'L2'
       LIMIT 1`
    ).get() as { id: string; properties_json: string };
    const policyProperties = JSON.parse(policyRow.properties_json) as {
      internal_info?: {
        decision_guidance?: { preference?: string[]; anti_pattern?: string[] };
        source_episode_ids?: string[];
        policy?: {
          decision_guidance?: { preference?: string[]; anti_pattern?: string[] };
          source_episode_ids?: string[];
          status?: "candidate" | "active" | "archived";
          vec?: number[];
        };
        vec?: number[];
      };
    };
    policyProperties.internal_info = policyProperties.internal_info ?? {};
    policyProperties.internal_info.decision_guidance = {
      preference: ["Prefer reading migration output before retrying."],
      anti_pattern: ["Avoid blind pytest retries."]
    };
    policyProperties.internal_info.policy = {
      ...(policyProperties.internal_info.policy ?? {}),
      decision_guidance: policyProperties.internal_info.decision_guidance,
      status: "active"
    };
    db.db.prepare(
      `UPDATE memories
       SET status = 'activated',
           properties_json = ?,
           updated_at = ?
       WHERE id = ?`
    ).run(JSON.stringify(policyProperties), new Date().toISOString(), policyRow.id);
    const sourceEpisodeId = (
      policyProperties.internal_info?.source_episode_ids ??
      policyProperties.internal_info?.policy?.source_episode_ids ??
      []
    )[0];
    expect(sourceEpisodeId).toBeTruthy();

    const l1Rows = db.db.prepare(
      `SELECT *
       FROM memories
       WHERE user_id = 'user-l3-skill-prompt' AND memory_layer = 'L1'`
    ).all() as Array<Record<string, unknown> & { id: string; properties_json: string }>;
    const sourceL1Row = l1Rows.find((row) => {
      const properties = JSON.parse(row.properties_json) as {
        internal_info?: { trace?: { episode_id?: string } };
      };
      return properties.internal_info?.trace?.episode_id === sourceEpisodeId;
    });
    expect(sourceL1Row).toBeTruthy();
    const negativeProperties = JSON.parse(sourceL1Row!.properties_json) as {
      internal_info: { trace: Record<string, unknown> };
    };
    const counterId = `mem_counter_${sourceEpisodeId}`;
    negativeProperties.internal_info.trace.value = -0.75;
    negativeProperties.internal_info.trace.priority = 0;
    negativeProperties.internal_info.trace.summary = "Negative counterexample for focused pytest retries";
    const counterRow = {
      ...sourceL1Row!,
      id: counterId,
      memory_key: `trace:counter:${sourceEpisodeId}`,
      memory_value: "Summary: Negative counterexample for focused pytest retries\nValue: -0.75",
      properties_json: JSON.stringify(negativeProperties),
      content_hash: counterId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    db.db.prepare(
      `INSERT INTO memories (
        id, timeline, user_id, conversation_id, session_id, agent_id, app_id,
        memory_type, status, visibility, memory_key, memory_value,
        tags_json, info_json, properties_json, memory_layer, content_hash,
        version, created_at, updated_at, deleted_at
      ) VALUES (
        @id, @timeline, @user_id, @conversation_id, @session_id, @agent_id, @app_id,
        @memory_type, @status, @visibility, @memory_key, @memory_value,
        @tags_json, @info_json, @properties_json, @memory_layer, @content_hash,
        @version, @created_at, @updated_at, @deleted_at
      )`
    ).run(counterRow);

    const downstreamAt = new Date().toISOString();
    db.db.prepare(
      `INSERT INTO evolution_jobs (
         id, job_type, status, user_id, session_id, episode_id, target_memory_id,
         payload_json, attempts, max_attempts, created_at, updated_at
       ) VALUES (?, 'l3_abstraction', 'queued', ?, ?, ?, ?, '{}', 0, 3, ?, ?)`
    ).run(
      "job_l3_prompt_contract_explicit",
      "user-l3-skill-prompt",
      session.sessionId,
      sourceEpisodeId,
      policyRow.id,
      downstreamAt,
      downstreamAt
    );
    db.db.prepare(
      `INSERT INTO evolution_jobs (
         id, job_type, status, user_id, session_id, episode_id, target_memory_id,
         payload_json, attempts, max_attempts, created_at, updated_at
       ) VALUES (?, 'skill_crystallization', 'queued', ?, ?, ?, ?, '{}', 0, 3, ?, ?)`
    ).run(
      "job_skill_prompt_contract_explicit",
      "user-l3-skill-prompt",
      session.sessionId,
      sourceEpisodeId,
      policyRow.id,
      downstreamAt,
      downstreamAt
    );

    for (let i = 0; i < 16; i += 1) {
      await service.runWorkerOnce(100);
      if (
        calls.some((call) => call.options.operation === "l3.abstraction.v2") &&
        calls.some((call) => call.options.operation === "skill.crystallize")
      ) {
        break;
      }
    }

    const l3Call = calls.find((call) => call.options.operation === "l3.abstraction.v2");
    if (l3Call) {
      expect(l3Call.options.thinkingMode).toBe("enabled");
      expect(l3Call.messages[0]!.content).toContain("declarative");
      expect(l3Call.messages[0]!.content).toContain("Do NOT, under any section");
      expect(l3Call.messages[0]!.content).toContain("Do NOT express here (procedural");
      expect(l3Call.messages[1]!.content).toContain("English");
      expect(l3Call.messages[2]!.content).toContain("CLUSTER_KEY");
      expect(l3Call.messages[2]!.content).toContain("ADMISSION");
    }
    const worldRow = db.db.prepare(
      `SELECT properties_json
       FROM memories
       WHERE user_id = 'user-l3-skill-prompt' AND memory_layer = 'L3'
       LIMIT 1`
    ).get() as { properties_json: string } | undefined;
    if (worldRow) {
      const worldProperties = JSON.parse(worldRow.properties_json) as {
        internal_info?: {
          world_model?: {
            title?: string;
            body?: string;
            domain_tags?: string[];
            structure?: {
              environment?: Array<{ label?: string; description?: string }>;
              constraints?: Array<{ label?: string; description?: string }>;
            };
          };
        };
      };
      expect(worldProperties.internal_info?.world_model?.title).toBe("Pytest sqlite migration environment");
      expect(worldProperties.internal_info?.world_model?.body).not.toContain("javascript:");
      expect(worldProperties.internal_info?.world_model?.body).not.toContain("<script>");
      expect(worldProperties.internal_info?.world_model?.domain_tags).toEqual(["pytest", "sqlite"]);
      expect(worldProperties.internal_info?.world_model?.structure?.environment?.[0]?.label).toBe("test harness");
      expect(worldProperties.internal_info?.world_model?.structure?.environment?.[0]?.description).toContain("pytest checks");
      expect(worldProperties.internal_info?.world_model?.structure?.environment?.[0]?.description).not.toContain("javascript:");
      expect(worldProperties.internal_info?.world_model?.structure?.constraints?.[0]?.description).not.toContain("<script>");
    }

    const skillCall = calls.find((call) => call.options.operation === "skill.crystallize");
    expect(skillCall).toBeTruthy();
    expect(skillCall!.options.thinkingMode).toBe("enabled");
    expect(skillCall!.messages[0]!.content).toContain("EVIDENCE_TOOLS");
    expect(skillCall!.messages[0]!.content).toContain("`tools` MUST only contain names from EVIDENCE_TOOLS");
    expect(skillCall!.messages[1]!.content).toContain("English");
    const skillPayload = JSON.parse(skillCall!.messages[2]!.content) as {
      evidence?: Array<{ user?: string; agent?: string }>;
      counter_examples?: Array<{ value?: number }>;
      evidence_tools?: string[];
      naming_space?: string[];
      repair_hints?: unknown;
      policy?: { repair_hints?: unknown };
    };
    expect(skillPayload.evidence?.some((entry) => entry.user?.includes("…"))).toBe(true);
    expect(skillPayload.evidence?.some((entry) => entry.user?.includes("u".repeat(100)))).toBe(false);
    expect(skillPayload.counter_examples?.some((entry) => entry.value === -0.75)).toBe(true);
    expect(skillPayload.evidence_tools).toContain("shell");
    expect(skillPayload.evidence_tools).toContain("npm");
    expect(skillPayload.naming_space).toEqual(expect.any(Array));
    expect(skillPayload.repair_hints).toBeTruthy();
    expect(skillPayload.policy?.repair_hints).toBeUndefined();
    const skillRow = db.db.prepare(
      `SELECT memory_key, properties_json
       FROM memories
       WHERE user_id = 'user-l3-skill-prompt' AND memory_layer = 'Skill'
       LIMIT 1`
    ).get() as { memory_key: string; properties_json: string };
    const skillProperties = JSON.parse(skillRow.properties_json) as {
      internal_info?: {
        name?: string;
        invocation_guide?: string;
        procedure_json?: {
          tags?: string[];
          tools?: string[];
          parameters?: Array<Record<string, unknown>>;
          examples?: Array<Record<string, unknown>>;
        };
        skill?: {
          name?: string;
          procedure_json?: {
            tags?: string[];
            tools?: string[];
          };
        };
      };
    };
    expect(skillProperties.internal_info?.name).toBe("focused_pytest_migration_with_a_");
    expect(skillProperties.internal_info?.skill?.name).toBe("focused_pytest_migration_with_a_");
    expect(skillProperties.internal_info?.invocation_guide).toContain("# Focused pytest migration workflow");
    expect(skillProperties.internal_info?.invocation_guide).toContain("Use a focused pytest check to diagnose sqlite migration regressions.");
    expect(skillProperties.internal_info?.invocation_guide).toContain("**Preconditions**");
    expect(skillProperties.internal_info?.invocation_guide).toContain("- 42");
    expect(skillProperties.internal_info?.invocation_guide).toContain("Avoid blind pytest retries.");
    expect(skillProperties.internal_info?.invocation_guide).toContain("- 404");
    expect(skillProperties.internal_info?.invocation_guide).toContain("- `shell`");
    expect(skillProperties.internal_info?.invocation_guide).not.toContain("javascript:");
    expect(skillProperties.internal_info?.invocation_guide).not.toContain("<script>");
    expect(skillProperties.internal_info?.invocation_guide).not.toContain("untrusted freeform guide");
    expect(skillProperties.internal_info?.invocation_guide).not.toContain("fake_tool");
    expect(skillProperties.internal_info?.invocation_guide).not.toContain("schema-out procedureJson");
    expect(skillProperties.internal_info?.procedure_json?.tools).toEqual(["shell"]);
    expect(skillProperties.internal_info?.procedure_json?.tags).toEqual(["Pytest", "sqlite"]);
    expect(skillProperties.internal_info?.procedure_json?.parameters).toEqual([{
      name: "mode",
      type: "enum",
      required: true,
      description: "Pytest run mode.",
      enumValues: ["focused", "7", "full"]
    }]);
    expect(skillProperties.internal_info?.procedure_json?.examples).toEqual([{
      input: "pytest sqlite migration failure",
      expected: "200"
    }]);

    db.close();
  });
});
