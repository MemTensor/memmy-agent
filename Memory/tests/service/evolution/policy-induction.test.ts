import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MEMMY_CONFIG, MemoryDb, type LlmClient } from "../../../src/index.js";
import { l2CandidateIdFor } from "../../../src/algorithm/plugin-algorithms.js";
import { Repositories } from "../../../src/storage/repositories.js";
import {
  addPositiveFeedbackForTurn,
  insertActivePolicyMemory,
  insertTracePolicyLinkForTest,
  makeTraceEligibleForL2,
  setPolicySignatureAndVectorForTest,
  setPolicyStatsForTest,
  setTraceSignatureAndVectorForTest,
  traceSignatureForTest
} from "../../fixtures/evolution-fixture.js";
import {
  createCapturingL2Llm,
  createNoToolSkillLlm
} from "./evolution-llm-stubs.js";
import {
  createCapturingEmbedder,
  createMemoryServiceFixture,
  runWorkerRounds
} from "../../fixtures/memory-service-fixture.js";

const {
  cleanup,
  createTestMemoryService,
  createTestRoot,
  createTestService
} = createMemoryServiceFixture();

afterEach(cleanup);

describe("MemoryService / evolution / policy induction", () => {
  it("[BC-08] keeps task-linked feedback in both branches and activates its candidate Policy only after new successful evidence", async () => {
    const { db, service } = createTestService({
      llm: createBc08SummaryLlm(),
      skillLlm: createCapturingL2Llm([]),
      config: {
        ...DEFAULT_MEMMY_CONFIG,
        algorithm: {
          ...DEFAULT_MEMMY_CONFIG.algorithm,
          l2Induction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l2Induction,
            minEpisodesForActivation: 2,
            minGain: -1
          }
        }
      }
    });
    const namespace = { source: "codex", profileId: "jiang", userId: "bc-08-user" };
    const firstSession = service.openSession({ namespace, workspaceId: "bc-08-workspace" });
    const first = service.completeTurn("bc-08-feedback", {
      sessionId: firstSession.sessionId,
      episodeId: "bc-08-feedback-episode",
      query: "你刚才写了很多兜底代码，我更喜欢简洁的代码，以后不要写不必要的兜底代码",
      answer: "已精简代码并通过测试。",
      toolCalls: [{ id: "bc-08-test-1", name: "run_tests", input: { scope: "changed" } }],
      toolResults: [{ toolCallId: "bc-08-test-1", success: true, output: "passed" }]
    });
    await service.runWorkerOnce(20, { priorityCohortOnly: true });
    makeTraceEligibleForL2(db, first.l1MemoryId);
    setTraceSignatureAndVectorForTest(db, first.l1MemoryId, "code|simplify|pytest|fallback", [1, 0, 0]);
    await addPositiveFeedbackForTurn(service, firstSession.sessionId, first);
    service.closeSession(firstSession.sessionId);
    await runWorkerRounds(service, 8, 50);

    expect(db.db.prepare(
      `SELECT content, memory_types_json FROM user_memories WHERE status = 'active'`
    ).get()).toEqual({
      content: "你刚才写了很多兜底代码，我更喜欢简洁的代码，以后不要写不必要的兜底代码",
      memory_types_json: '["User Preference"]'
    });
    expect(db.db.prepare(`SELECT status FROM memories WHERE id = ?`).get(first.l1MemoryId))
      .toEqual({ status: "activated" });
    const candidate = db.db.prepare(
      `SELECT id, status, properties_json FROM memories WHERE memory_layer = 'L2' LIMIT 1`
    ).get() as { id: string; status: string; properties_json: string };
    expect(candidate.status).toBe("resolving");
    expect(JSON.parse(candidate.properties_json)).toMatchObject({
      internal_info: { policy: { status: "candidate" } }
    });

    const secondSession = service.openSession({ namespace, workspaceId: "bc-08-workspace" });
    const second = service.completeTurn("bc-08-verified-fix", {
      sessionId: secondSession.sessionId,
      episodeId: "bc-08-verified-episode",
      query: "按反馈删除不必要的兜底代码并运行测试",
      answer: "已保持实现简洁，测试验证通过。",
      toolCalls: [{ id: "bc-08-test-2", name: "run_tests", input: { scope: "changed" } }],
      toolResults: [{ toolCallId: "bc-08-test-2", success: true, output: "passed" }]
    });
    await service.runWorkerOnce(20, { priorityCohortOnly: true });
    makeTraceEligibleForL2(db, second.l1MemoryId);
    setTraceSignatureAndVectorForTest(db, second.l1MemoryId, "code|simplify|pytest|fallback", [1, 0, 0]);
    await addPositiveFeedbackForTurn(service, secondSession.sessionId, second);
    service.closeSession(secondSession.sessionId);
    await runWorkerRounds(service, 8, 50);

    const policies = db.db.prepare(
      `SELECT status, properties_json FROM memories WHERE memory_layer = 'L2'`
    ).all() as Array<{ status: string; properties_json: string }>;
    expect(policies).toHaveLength(1);
    expect(policies[0]!.status).toBe("activated");
    expect(JSON.parse(policies[0]!.properties_json)).toMatchObject({
      internal_info: {
        policy: {
          status: "active",
          support: 2,
          source_trace_ids: expect.arrayContaining([first.l1MemoryId, second.l1MemoryId])
        }
      }
    });
    db.close();
  });

  it("promotes only the selected L2 candidate evidence", () => {
    const { db } = createTestService();
    const repos = new Repositories(db.db);
    const at = new Date().toISOString();
    const candidateKey = "python|test|_|_";

    for (const userId of ["candidate-user-a", "candidate-user-b"]) {
      repos.runtime.upsertCandidatePoolTrace({
        id: `cand_${userId}`,
        userId,
        sessionId: `session-${userId}`,
        sourceMemoryId: `mem_${userId}`,
        candidateKey,
        candidateValue: "shared signature candidate",
        score: 1,
        evidence: { traceId: `mem_${userId}` },
        createdAt: at,
        updatedAt: at,
        expiresAt: new Date(Date.parse(at) + 86_400_000).toISOString()
      });
    }
    repos.runtime.upsertCandidatePoolTrace({
      id: "cand_candidate-user-a_other-profile",
      userId: "candidate-user-a",
      sessionId: "session-candidate-user-a-other-profile",
      sourceMemoryId: "mem_candidate-user-a_other-profile",
      candidateKey,
      candidateValue: "same user and signature but outside the current bucket",
      score: 1,
      evidence: { traceId: "mem_candidate-user-a_other-profile" },
      createdAt: at,
      updatedAt: at,
      expiresAt: new Date(Date.parse(at) + 86_400_000).toISOString()
    });

    repos.runtime.markCandidatePoolPromoted({
      userId: "candidate-user-a",
      candidateKey,
      sourceMemoryIds: ["mem_candidate-user-a"],
      policyId: "policy-user-a",
      at
    });

    const rows = db.db.prepare(
      `SELECT source_memory_id, user_id, status, json_extract(evidence_json, '$.policyId') AS policy_id
       FROM l2_candidate_pool
       ORDER BY user_id, source_memory_id`
    ).all() as Array<{ source_memory_id: string; user_id: string; status: string; policy_id: string | null }>;
    expect(rows).toEqual([
      {
        source_memory_id: "mem_candidate-user-a",
        user_id: "candidate-user-a",
        status: "promoted",
        policy_id: "policy-user-a"
      },
      {
        source_memory_id: "mem_candidate-user-a_other-profile",
        user_id: "candidate-user-a",
        status: "pending",
        policy_id: null
      },
      {
        source_memory_id: "mem_candidate-user-b",
        user_id: "candidate-user-b",
        status: "pending",
        policy_id: null
      }
    ]);

    db.close();
  });

  it("associates each L1 trace to only the best L2 policy like the plugin", async () => {
    const { db, service } = createTestService({
      config: {
        ...DEFAULT_MEMMY_CONFIG,
        algorithm: {
          ...DEFAULT_MEMMY_CONFIG.algorithm,
          l2Induction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l2Induction,
            minEpisodesForActivation: 1
          }
        }
      }
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-best-l2-association"
      },
      workspaceId: "workspace-best-l2"
    });
    const complete = service.completeTurn("turn-best-l2-association", {
      sessionId: session.sessionId,
      episodeId: "episode-best-l2-association",
      query: "python pytest retry workflow should choose the closest policy",
      answer: "Run pytest, inspect the failure, and retry after fixing the closest issue."
    });
    await addPositiveFeedbackForTurn(service, session.sessionId, complete);
    makeTraceEligibleForL2(db, complete.l1MemoryId);
    const signature = traceSignatureForTest(db, complete.l1MemoryId);
    insertActivePolicyMemory(db, {
      id: "policy_best_l2_association",
      userId: "user-best-l2-association",
      sessionId: session.sessionId,
      agentId: "codex",
      appId: "workspace-best-l2",
      profileId: "jiang",
      sourceTraceId: complete.l1MemoryId,
      sourceEpisodeId: complete.episodeId
    });
    insertActivePolicyMemory(db, {
      id: "policy_weaker_l2_association",
      userId: "user-best-l2-association",
      sessionId: session.sessionId,
      agentId: "codex",
      appId: "workspace-best-l2",
      profileId: "jiang",
      sourceTraceId: complete.l1MemoryId,
      sourceEpisodeId: complete.episodeId
    });
    setPolicySignatureAndVectorForTest(db, "policy_best_l2_association", signature, [1, 0, 0]);
    setPolicySignatureAndVectorForTest(db, "policy_weaker_l2_association", signature, [0, 1, 0]);

    service.closeSession(session.sessionId);
    await service.runWorkerOnce(20);
    await service.runWorkerOnce(20);
    await service.runWorkerOnce(20);
    await service.runWorkerOnce(20);
    makeTraceEligibleForL2(db, complete.l1MemoryId);
    db.db.prepare(`DELETE FROM trace_policy_links WHERE l1_memory_id = ?`).run(complete.l1MemoryId);
    db.db.prepare(`UPDATE evolution_jobs SET status = 'succeeded'`).run();
    const associationAt = new Date().toISOString();
    db.db.prepare(
      `INSERT INTO evolution_jobs (
         id, job_type, status, user_id, session_id, episode_id, target_memory_id,
         payload_json, attempts, max_attempts, created_at, updated_at
       ) VALUES (?, 'l2_association', 'queued', ?, ?, ?, ?, '{}', 0, 3, ?, ?)`
    ).run(
      "job_best_l2_association",
      "user-best-l2-association",
      session.sessionId,
      complete.episodeId,
      complete.l1MemoryId,
      associationAt,
      associationAt
    );
    await service.runWorkerOnce(20);

    const links = db.db.prepare(
      `SELECT l2_memory_id, relation, strength
       FROM trace_policy_links
       WHERE l1_memory_id = ?
       ORDER BY l2_memory_id`
    ).all(complete.l1MemoryId) as Array<{ l2_memory_id: string; relation: string; strength: number }>;
    expect(links).toEqual([
      {
        l2_memory_id: "policy_best_l2_association",
        relation: "matches_signature",
        strength: 1
      }
    ]);
    const traceDetail = service.getMemory(complete.l1MemoryId);
    expect(traceDetail.refs.policyLinks).toEqual([
      {
        policyMemoryId: "policy_best_l2_association",
        traceMemoryId: complete.l1MemoryId,
        relation: "matches_signature"
      }
    ]);
    const policyDetail = service.getMemory("policy_best_l2_association");
    expect(policyDetail.refs.policyLinks).toEqual([
      {
        policyMemoryId: "policy_best_l2_association",
        traceMemoryId: complete.l1MemoryId,
        relation: "matches_signature"
      }
    ]);

    db.close();
  });

  it("recomputes L2 support from all linked traces, not distinct episodes only", async () => {
    const { db, service } = createTestService();
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-l2-support-traces"
      },
      workspaceId: "workspace-l2-support"
    });
    const completeA = service.completeTurn("turn-l2-support-traces-a", {
      sessionId: session.sessionId,
      episodeId: "episode-l2-support-traces",
      query: "python pytest support should count same episode tool traces",
      answer: "Run pytest for tests/a.py and inspect the failure.",
      toolCalls: [
        { name: "pytest", input: "pytest tests/a.py", output: "failed with EXIT_1", errorCode: "E_EXIT_1", success: false }
      ]
    });
    const completeB = service.completeTurn("turn-l2-support-traces-b", {
      sessionId: session.sessionId,
      query: "also inspect the pytest failure in tests/b.py",
      answer: "Run pytest for tests/b.py and inspect the failure.",
      toolCalls: [
        { name: "pytest", input: "pytest tests/b.py", output: "failed with EXIT_1", errorCode: "E_EXIT_1", success: false }
      ]
    });
    expect(completeB.episodeId).toBe(completeA.episodeId);
    const evidenceIds = [completeA.l1MemoryId, completeB.l1MemoryId];
    expect(evidenceIds).toHaveLength(2);
    for (const id of evidenceIds) {
      makeTraceEligibleForL2(db, id);
    }
    insertActivePolicyMemory(db, {
      id: "policy_l2_support_traces",
      userId: "user-l2-support-traces",
      sessionId: session.sessionId,
      agentId: "codex",
      appId: "workspace-l2-support",
      profileId: "jiang",
      sourceTraceId: evidenceIds[0]!,
      sourceEpisodeId: completeA.episodeId
    });
    setPolicySignatureAndVectorForTest(db, "policy_l2_support_traces", traceSignatureForTest(db, evidenceIds[0]!), [1, 0, 0]);
    setPolicyStatsForTest(db, "policy_l2_support_traces", {
      status: "candidate",
      memoryStatus: "resolving",
      support: 0,
      gain: 0,
      rawGain: 0,
      confidence: 0.5
    });
    for (const id of evidenceIds) {
      insertTracePolicyLinkForTest(db, {
        userId: "user-l2-support-traces",
        l1MemoryId: id,
        l2MemoryId: "policy_l2_support_traces"
      });
    }
    db.db.prepare(`UPDATE evolution_jobs SET status = 'succeeded'`).run();
    const at = new Date().toISOString();
    db.db.prepare(
      `INSERT INTO evolution_jobs (
         id, job_type, status, user_id, session_id, episode_id, target_memory_id,
         payload_json, attempts, max_attempts, created_at, updated_at
       ) VALUES (?, 'l2_association', 'queued', ?, ?, ?, ?, '{}', 0, 3, ?, ?)`
    ).run(
      "job_l2_support_trace_count",
      "user-l2-support-traces",
      session.sessionId,
      completeA.episodeId,
      evidenceIds[0],
      at,
      at
    );

    await service.runWorkerOnce(20);

    const policyRow = db.db.prepare(
      `SELECT properties_json
       FROM memories
       WHERE id = 'policy_l2_support_traces'`
    ).get() as { properties_json: string };
    const properties = JSON.parse(policyRow.properties_json) as {
      internal_info?: {
        policy?: {
          support?: number;
          status?: string;
          source_trace_ids?: string[];
        };
      };
    };
    expect(properties.internal_info?.policy?.support).toBe(1);
    expect(properties.internal_info?.policy?.status).toBe("candidate");
    expect(properties.internal_info?.policy?.source_trace_ids).toEqual(expect.arrayContaining(evidenceIds));

    db.close();
  });

  it("induces one shared L2 policy across profiles and user ids", async () => {
    const root = createTestRoot("mindock-memory-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const service = createTestMemoryService({
      db,
      mode: "dev",
      skillLlm: createNoToolSkillLlm(),
      config: {
        ...DEFAULT_MEMMY_CONFIG,
        algorithm: {
          ...DEFAULT_MEMMY_CONFIG.algorithm,
          l2Induction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l2Induction,
            useLlm: true,
            minEpisodesForInduction: 2
          },
          l3Abstraction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l3Abstraction,
            useLlm: false
          },
          skill: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.skill,
            useLlm: false
          }
        }
      }
    });
    const profileA = service.openSession({
      namespace: {
        source: "codex",
        profileId: "profile-a",
        userId: "shared-user"
      },
      workspaceId: "workspace-shared"
    });
    const profileB = service.openSession({
      namespace: {
        source: "codex",
        profileId: "profile-b",
        userId: "other-shared-user"
      },
      workspaceId: "workspace-shared"
    });
    const firstA = service.completeTurn("turn-cross-profile-a1", {
      sessionId: profileA.sessionId,
      episodeId: "episode-cross-profile-a1",
      query: "python pytest retry workflow should remain profile scoped",
      answer: "Run pytest, inspect the failure, and retry after fixing the profile scoped issue."
    });
    const firstB = service.completeTurn("turn-cross-profile-b1", {
      sessionId: profileB.sessionId,
      episodeId: "episode-cross-profile-b1",
      query: "python pytest retry workflow should remain profile scoped",
      answer: "Run pytest, inspect the failure, and retry after fixing the profile scoped issue."
    });
    await addPositiveFeedbackForTurn(service, profileA.sessionId, firstA);
    await addPositiveFeedbackForTurn(service, profileB.sessionId, firstB);
    makeTraceEligibleForL2(db, firstA.l1MemoryId);
    makeTraceEligibleForL2(db, firstB.l1MemoryId);

    service.closeSession(profileA.sessionId);
    service.closeSession(profileB.sessionId);
    await service.runWorkerOnce(20);
    await service.runWorkerOnce(20);
    await service.runWorkerOnce(20);
    await service.runWorkerOnce(20);
    makeTraceEligibleForL2(db, firstA.l1MemoryId);
    makeTraceEligibleForL2(db, firstB.l1MemoryId);
    db.db.prepare(`UPDATE evolution_jobs SET status = 'succeeded' WHERE job_type <> 'l2_induction'`).run();

    await service.runWorkerOnce(20);
    const crossProfilePolicyCount = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM memories
       WHERE memory_layer = 'L2'`
    ).get() as { count: number };
    expect(crossProfilePolicyCount.count).toBe(1);

    const profileANext = service.openSession({
      namespace: {
        source: "codex",
        profileId: "profile-a",
        userId: "shared-user"
      },
      workspaceId: "workspace-shared"
    });
    const secondA = service.completeTurn("turn-cross-profile-a2", {
      sessionId: profileANext.sessionId,
      episodeId: "episode-cross-profile-a2",
      query: "python pytest retry workflow should induce only inside profile a",
      answer: "Run pytest, inspect the failure, and retry after fixing the profile scoped issue."
    });
    await addPositiveFeedbackForTurn(service, profileANext.sessionId, secondA);
    makeTraceEligibleForL2(db, secondA.l1MemoryId);
    service.closeSession(profileANext.sessionId);
    await service.runWorkerOnce(20);
    await service.runWorkerOnce(20);
    await service.runWorkerOnce(20);
    await service.runWorkerOnce(20);
    makeTraceEligibleForL2(db, secondA.l1MemoryId);
    db.db.prepare(`UPDATE evolution_jobs SET status = 'succeeded' WHERE job_type <> 'l2_induction'`).run();

    await service.runWorkerOnce(20);
    const policies = db.db.prepare(
      `SELECT agent_id, app_id, info_json
       FROM memories
       WHERE memory_layer = 'L2'
       ORDER BY created_at`
    ).all() as Array<{ agent_id: string | null; app_id: string | null; info_json: string }>;
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({
      agent_id: "codex",
      app_id: "workspace-shared"
    });
    expect(["profile-a", "profile-b"]).toContain(JSON.parse(policies[0]!.info_json).profile_id);
    const promotedRows = db.db.prepare(
      `SELECT source_memory_id, status
       FROM l2_candidate_pool
       WHERE status = 'promoted'
       ORDER BY source_memory_id`
    ).all() as Array<{ source_memory_id: string; status: string }>;
    expect(promotedRows.map((row) => row.source_memory_id)).toEqual(expect.arrayContaining([
      firstA.l1MemoryId,
      firstB.l1MemoryId
    ]));

    db.close();
  });

  it("uses shared L2 keys so identical signatures merge across profiles", async () => {
    const root = createTestRoot("mindock-memory-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const service = createTestMemoryService({
      db,
      mode: "dev",
      skillLlm: createCapturingL2Llm([]),
      embedder: createCapturingEmbedder([]),
      config: {
        ...DEFAULT_MEMMY_CONFIG,
        algorithm: {
          ...DEFAULT_MEMMY_CONFIG.algorithm,
          l2Induction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l2Induction,
            useLlm: true,
            minEpisodesForInduction: 2
          },
          l3Abstraction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l3Abstraction,
            useLlm: false
          },
          skill: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.skill,
            useLlm: false
          }
        }
      }
    });
    const profileA = service.openSession({
      namespace: {
        source: "codex",
        profileId: "profile-a",
        userId: "shared-key-user"
      },
      workspaceId: "workspace-key"
    });
    const profileB = service.openSession({
      namespace: {
        source: "codex",
        profileId: "profile-b",
        userId: "shared-key-user"
      },
      workspaceId: "workspace-key"
    });
    const signature = "python|pytest|_|_";
    const turnsA = ["a1", "a2"].map((suffix) => service.completeTurn(`turn-shared-key-${suffix}`, {
      sessionId: profileA.sessionId,
      episodeId: `episode-shared-key-${suffix}`,
      query: "python pytest retry workflow should stay scoped to profile a",
      answer: "Run pytest, inspect the failure, and retry after fixing the issue."
    }));
    for (const turn of turnsA) {
      await addPositiveFeedbackForTurn(service, profileA.sessionId, turn);
    }
    for (const turn of turnsA) {
      setTraceSignatureAndVectorForTest(db, turn.l1MemoryId, signature, [1, 0, 0]);
    }
    service.closeSession(profileA.sessionId);
    await service.runWorkerOnce(20);
    await service.runWorkerOnce(20);
    await service.runWorkerOnce(20);
    await service.runWorkerOnce(20);
    for (const turn of turnsA) {
      setTraceSignatureAndVectorForTest(db, turn.l1MemoryId, signature, [1, 0, 0]);
    }
    db.db.prepare(`UPDATE evolution_jobs SET status = 'succeeded' WHERE job_type <> 'l2_induction'`).run();
    await service.runWorkerOnce(20);

    const turnsB = ["b1", "b2"].map((suffix) => service.completeTurn(`turn-shared-key-${suffix}`, {
      sessionId: profileB.sessionId,
      episodeId: `episode-shared-key-${suffix}`,
      query: "python pytest retry workflow should stay scoped to profile b",
      answer: "Run pytest, inspect the failure, and retry after fixing the issue."
    }));
    for (const turn of turnsB) {
      await addPositiveFeedbackForTurn(service, profileB.sessionId, turn);
    }
    for (const turn of turnsB) {
      setTraceSignatureAndVectorForTest(db, turn.l1MemoryId, signature, [1, 0, 0]);
    }
    service.closeSession(profileB.sessionId);
    await service.runWorkerOnce(20);
    await service.runWorkerOnce(20);
    await service.runWorkerOnce(20);
    await service.runWorkerOnce(20);
    for (const turn of turnsB) {
      setTraceSignatureAndVectorForTest(db, turn.l1MemoryId, signature, [1, 0, 0]);
    }
    db.db.prepare(`UPDATE evolution_jobs SET status = 'succeeded' WHERE job_type <> 'l2_induction'`).run();
    await service.runWorkerOnce(20);

    const policies = db.db.prepare(
      `SELECT memory_key, info_json
       FROM memories
       WHERE user_id = 'shared-key-user'
         AND memory_layer = 'L2'
       ORDER BY memory_key`
    ).all() as Array<{ memory_key: string; info_json: string }>;
    expect(policies).toHaveLength(1);
    expect(policies[0]!.memory_key).toMatch(/^policy:/);
    expect(["profile-a", "profile-b"]).toContain(JSON.parse(policies[0]!.info_json).profile_id);

    db.close();
  });

  it("maps candidate policy lifecycle status to resolving in the memories table", async () => {
    const root = createTestRoot("mindock-memory-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const service = createTestMemoryService({
      db,
      mode: "dev",
      skillLlm: createCapturingL2Llm([]),
      config: {
        ...DEFAULT_MEMMY_CONFIG,
        algorithm: {
          ...DEFAULT_MEMMY_CONFIG.algorithm,
          l2Induction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l2Induction,
            minGain: 0.99
          }
        }
      }
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-candidate-status"
      }
    });
    const complete = service.completeTurn("turn-candidate-policy", {
      sessionId: session.sessionId,
      episodeId: "episode-candidate-policy",
      query: "pytest workflow status candidate policy",
      answer: "run tests and keep the policy as a candidate"
    });
    await service.feedback({
      sessionId: session.sessionId,
      l1MemoryId: complete.l1MemoryId,
      channel: "explicit",
      polarity: "positive",
      magnitude: 1,
      rationale: "positive but minGain is intentionally high"
    });
    service.closeSession(session.sessionId);
    for (let i = 0; i < 4; i += 1) {
      await service.runWorkerOnce(50);
    }

    const row = db.db.prepare(
      `SELECT status, properties_json
       FROM memories
       WHERE memory_layer = 'L2'
       LIMIT 1`
    ).get() as { status: string; properties_json: string } | undefined;
    expect(row).toBeTruthy();
    const properties = JSON.parse(row!.properties_json) as {
      status?: string;
      internal_info?: { policy?: { status?: string } };
    };
    expect(row!.status).toBe("resolving");
    expect(properties.status).toBe("resolving");
    expect(properties.internal_info?.policy?.status).toBe("candidate");
    const candidate = db.db.prepare(
      `SELECT id, source_memory_id, candidate_key, status, expires_at
       FROM l2_candidate_pool
       LIMIT 1`
    ).get() as {
      id: string;
      source_memory_id: string;
      candidate_key: string;
      status: string;
      expires_at: string | null;
    } | undefined;
    expect(candidate?.status).toBe("promoted");
    expect(candidate?.expires_at).toBeTruthy();
    expect(candidate?.id).toBe(l2CandidateIdFor(candidate!.candidate_key, candidate!.source_memory_id));

    db.close();
  });

  it("uses the plugin L2 induction prompt contract and stores policy confidence", async () => {
    const root = createTestRoot("mindock-memory-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const l2Calls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string; thinkingMode?: "inherit" | "enabled" | "disabled" };
    }> = [];
    const service = createTestMemoryService({
      db,
      mode: "dev",
      skillLlm: createCapturingL2Llm(l2Calls, undefined, {
        title: "Use focused pytest migration checks <script>alert(1)</script>",
        trigger: "pytest workflow fails around [sqlite](javascript:alert(1)) migration output",
        action: "Run the focused pytest workflow, inspect [migration output](javascript:alert(1)), then retry the exact failing test.",
        rationale: "The evidence succeeded after narrowing the failing pytest path.",
        caveats: ["Do not retry blindly before reading [migration output](javascript:alert(1))."],
        confidence: 0.77,
        support_trace_ids: []
      }),
      embedder: createCapturingEmbedder([]),
      config: {
        ...DEFAULT_MEMMY_CONFIG,
        algorithm: {
          ...DEFAULT_MEMMY_CONFIG.algorithm,
          l2Induction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l2Induction,
            traceCharCap: 700
          },
          l3Abstraction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l3Abstraction,
            useLlm: false
          },
          skill: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.skill,
            useLlm: false
          }
        }
      }
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-l2-prompt"
      }
    });
    const complete = service.completeTurn("turn-l2-prompt", {
      sessionId: session.sessionId,
      episodeId: "episode-l2-prompt",
      query: `pytest failure workflow ${"x".repeat(1200)}`,
      answer: `run focused tests and inspect migration output ${"y".repeat(1200)}`,
      toolCalls: [{
        name: "shell",
        input: { cmd: "npm test" },
        output: "ok",
        success: true
      }]
    });
    await service.feedback({
      sessionId: session.sessionId,
      l1MemoryId: complete.l1MemoryId,
      channel: "explicit",
      polarity: "positive",
      magnitude: 1,
      rationale: "this focused pytest workflow worked"
    });
    service.closeSession(session.sessionId);
    for (let i = 0; i < 4; i += 1) {
      await service.runWorkerOnce(50);
    }

    const l2Call = l2Calls.find((call) => call.options.operation === "l2.induction.v4");
    expect(l2Call).toBeTruthy();
    expect(l2Calls.filter((call) => call.options.operation === "l2.induction.v4")).toHaveLength(1);
    expect(l2Call!.options.thinkingMode).toBe("enabled");
    expect(l2Call!.messages[0]!.content).toContain("procedural policies");
    expect(l2Call!.messages[0]!.content).toContain("should_generate=false");
    expect(l2Call!.messages[0]!.content).toContain("Same fact, two framings");
    expect(l2Call!.messages[0]!.content).toContain("Do NOT express here (declarative");
    expect(l2Call!.messages[1]!.content).toContain("English");
    expect(l2Call!.messages[2]!.content).toContain("PATTERN_SIGNATURE");
    expect(l2Call!.messages[2]!.content).not.toContain("x".repeat(500));

    const row = db.db.prepare(
      `SELECT properties_json
       FROM memories
       WHERE memory_layer = 'L2'
       LIMIT 1`
    ).get() as { properties_json: string } | undefined;
    expect(row).toBeTruthy();
    const properties = JSON.parse(row!.properties_json) as {
      internal_info?: {
        policy?: {
          title?: string;
          trigger?: string;
          procedure?: string;
          verification?: string;
          boundary?: string;
          policy_confidence?: number;
        };
      };
    };
    expect(properties.internal_info?.policy?.title).toBe("Use focused pytest migration checks");
    expect(properties.internal_info?.policy?.trigger).toBe("pytest workflow fails around sqlite migration output");
    expect(properties.internal_info?.policy?.procedure).toContain("Run the focused pytest workflow");
    expect(properties.internal_info?.policy?.procedure).toContain("inspect migration output");
    expect(properties.internal_info?.policy?.procedure).not.toContain("javascript:");
    expect(properties.internal_info?.policy?.verification).toBeTruthy();
    expect(properties.internal_info?.policy?.boundary).toBeTruthy();
    expect(properties.internal_info?.policy?.policy_confidence).toBeCloseTo(0.77);

    db.close();
  });

  it("keeps full L2 candidate-bucket evidence when the LLM returns a support_trace_ids subset", async () => {
    const root = createTestRoot("mindock-memory-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const l2Calls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string };
    }> = [];
    const l2Response: Record<string, unknown> = {
      title: "Use focused pytest checks",
      trigger: "pytest workflow has repeated tool failures",
      action: "Run focused pytest checks, inspect failures, then retry the exact failing tests.",
      rationale: "The bucket evidence shows repeated pytest tool failures.",
      caveats: ["Do not drop other traces from the bucket evidence."],
      confidence: 0.76,
      support_trace_ids: []
    };
    const service = createTestMemoryService({
      db,
      mode: "dev",
      skillLlm: createCapturingL2Llm(l2Calls, undefined, l2Response),
      config: {
        ...DEFAULT_MEMMY_CONFIG,
        algorithm: {
          ...DEFAULT_MEMMY_CONFIG.algorithm,
          l2Induction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l2Induction,
            useLlm: true,
            minEpisodesForInduction: 1
          },
          l3Abstraction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l3Abstraction,
            useLlm: false
          },
          skill: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.skill,
            useLlm: false
          }
        }
      }
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-l2-support-subset"
      },
      workspaceId: "workspace-l2-support-subset"
    });
    const completeA = service.completeTurn("turn-l2-support-subset-a", {
      sessionId: session.sessionId,
      episodeId: "episode-l2-support-subset",
      query: "pytest repeated failures should keep all bucket evidence",
      answer: "Run the focused pytest check for tests/a.py.",
      toolCalls: [
        { name: "pytest", input: "pytest tests/a.py", output: "failed with EXIT_1", errorCode: "E_EXIT_1", success: false }
      ]
    });
    const completeB = service.completeTurn("turn-l2-support-subset-b", {
      sessionId: session.sessionId,
      query: "also keep the pytest failure evidence from tests/b.py",
      answer: "Run the focused pytest check for tests/b.py.",
      toolCalls: [
        { name: "pytest", input: "pytest tests/b.py", output: "failed with EXIT_1", errorCode: "E_EXIT_1", success: false }
      ]
    });
    expect(completeB.episodeId).toBe(completeA.episodeId);
    const evidenceIds = [completeA.l1MemoryId, completeB.l1MemoryId];
    expect(evidenceIds).toHaveLength(2);
    const signature = "pytest|python|pytest|EXIT_1";
    for (const id of evidenceIds) {
      setTraceSignatureAndVectorForTest(db, id, signature, [1, 0, 0]);
    }
    expect(traceSignatureForTest(db, evidenceIds[0]!)).toBe(signature);
    expect(traceSignatureForTest(db, evidenceIds[1]!)).toBe(signature);
    const repos = new Repositories(db.db);
    const at = new Date().toISOString();
    for (const id of evidenceIds) {
      repos.runtime.upsertCandidatePoolTrace({
        id: l2CandidateIdFor(signature, id),
        userId: "user-l2-support-subset",
        sessionId: session.sessionId,
        sourceMemoryId: id,
        candidateKey: signature,
        candidateValue: "pytest repeated failure bucket",
        score: 1,
        evidence: { traceId: id },
        createdAt: at,
        updatedAt: at,
        expiresAt: new Date(Date.parse(at) + 86_400_000).toISOString()
      });
    }
    l2Response.support_trace_ids = [evidenceIds[0]];
    db.db.prepare(`UPDATE evolution_jobs SET status = 'succeeded'`).run();
    db.db.prepare(
      `INSERT INTO evolution_jobs (
         id, job_type, status, user_id, session_id, episode_id, target_memory_id,
         payload_json, attempts, max_attempts, created_at, updated_at
       ) VALUES (?, 'l2_induction', 'queued', ?, ?, ?, ?, '{}', 0, 3, ?, ?)`
    ).run(
      "job_l2_support_subset",
      "user-l2-support-subset",
      session.sessionId,
      completeA.episodeId,
      evidenceIds[0],
      at,
      at
    );

    await service.runWorkerOnce(20);

    const row = db.db.prepare(
      `SELECT properties_json
       FROM memories
       WHERE user_id = 'user-l2-support-subset'
         AND memory_layer = 'L2'
       LIMIT 1`
    ).get() as { properties_json: string } | undefined;
    expect(row).toBeTruthy();
    const properties = JSON.parse(row!.properties_json) as {
      internal_info?: {
        policy?: {
          source_trace_ids?: string[];
          support?: number;
        };
      };
    };
    expect(properties.internal_info?.policy?.support).toBe(1);
    expect(properties.internal_info?.policy?.source_trace_ids).toEqual(expect.arrayContaining(evidenceIds));
    expect(properties.internal_info?.policy?.source_trace_ids).toHaveLength(2);

    db.close();
  });

  it("retries invalid L2 drafts three times before recording a terminal skip", async () => {
    const root = createTestRoot("mindock-memory-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const calls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string };
    }> = [];
    const userId = "user-invalid-l2-draft";
    const service = createTestMemoryService({
      db,
      mode: "dev",
      skillLlm: createCapturingL2Llm(calls, undefined, [{
        trigger: "pytest workflow fails around sqlite migration output",
        procedure: "Run the focused pytest workflow."
      }, {
        title: "Invalid L2 policy",
        procedure: "Run the focused pytest workflow."
      }, {
        title: "Invalid L2 policy",
        trigger: "pytest workflow fails around sqlite migration output"
      }]),
      config: {
        ...DEFAULT_MEMMY_CONFIG,
        algorithm: {
          ...DEFAULT_MEMMY_CONFIG.algorithm,
          l2Induction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l2Induction,
            traceCharCap: 700
          },
          l3Abstraction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l3Abstraction,
            useLlm: false
          },
          skill: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.skill,
            useLlm: false
          }
        }
      }
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId
      }
    });
    const complete = service.completeTurn("turn-invalid-l2-draft", {
      sessionId: session.sessionId,
      episodeId: "episode-invalid-l2-draft",
      query: "pytest sqlite migration workflow needs focused diagnostics",
      answer: "Run focused tests, inspect migration output, then retry the exact failure.",
      toolCalls: [{
        name: "shell",
        input: { cmd: "npm test -- migration" },
        output: "ok",
        success: true
      }]
    });
    await service.feedback({
      sessionId: session.sessionId,
      l1MemoryId: complete.l1MemoryId,
      channel: "explicit",
      polarity: "positive",
      magnitude: 1,
      rationale: "the focused pytest migration workflow worked"
    });
    service.closeSession(session.sessionId);
    makeTraceEligibleForL2(db, complete.l1MemoryId);
    for (let i = 0; i < 8; i += 1) {
      await service.runWorkerOnce(50);
      if (calls.some((call) => call.options.operation === "l2.induction.v4")) {
        break;
      }
    }

    expect(calls.filter((call) => call.options.operation === "l2.induction.v4")).toHaveLength(3);
    const l2Count = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM memories
       WHERE user_id = ? AND memory_layer = 'L2'`
    ).get(userId) as { count: number };
    expect(l2Count.count).toBe(0);
    const skippedRows = db.db.prepare(
      `SELECT after_json
       FROM memory_change_log
       WHERE user_id = ?
         AND kind = 'policy'
         AND op = 'skipped'
         AND change_type = 'l2_induction_skipped'
       ORDER BY seq DESC`
    ).all(userId) as Array<{ after_json: string }>;
    const skippedReasons = skippedRows.map((row) => {
      const after = JSON.parse(row.after_json) as { reason?: string };
      return after.reason;
    });
    expect(skippedReasons).toContain("llm-failed: l2.induction.invalid: missing procedure");
    expect(skippedReasons).toHaveLength(1);
    const job = db.db.prepare(
      `SELECT status, attempts, last_error
       FROM evolution_jobs
       WHERE user_id = ? AND job_type = 'l2_induction'
       ORDER BY created_at DESC
       LIMIT 1`
    ).get(userId) as { status: string; attempts: number; last_error: string | null };
    expect(job).toMatchObject({
      status: "succeeded",
      attempts: 1,
      last_error: null
    });
    const downstreamCount = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM evolution_jobs
       WHERE user_id = ?
         AND (
           job_type IN ('l3_abstraction', 'skill_crystallization')
           OR (
             job_type = 'embedding'
             AND json_extract(payload_json, '$.reason') = 'l2.upserted'
           )
         )`
    ).get(userId) as { count: number };
    expect(downstreamCount.count).toBe(0);

    db.close();
  });

  it("creates L2 when the third draft attempt supplies all required fields", async () => {
    const root = createTestRoot("mindock-memory-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const calls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string };
    }> = [];
    const userId = "user-l2-third-draft-valid";
    const service = createTestMemoryService({
      db,
      mode: "dev",
      skillLlm: createCapturingL2Llm(calls, undefined, [{
        title: "Focused migration diagnosis",
        trigger: "pytest migration output needs focused diagnosis"
      }, {
        title: "Focused migration diagnosis",
        procedure: "Run the focused pytest workflow and inspect the exact failure."
      }, {
        title: "Focused migration diagnosis",
        trigger: "pytest migration output needs focused diagnosis",
        procedure: "Run the focused pytest workflow and inspect the exact failure.",
        verification: "Rerun the focused test and confirm it passes.",
        exclusions: ["Do not apply when the failure is unrelated to migrations."]
      }]),
      config: {
        ...DEFAULT_MEMMY_CONFIG,
        algorithm: {
          ...DEFAULT_MEMMY_CONFIG.algorithm,
          l2Induction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l2Induction,
            traceCharCap: 700
          },
          l3Abstraction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l3Abstraction,
            useLlm: false
          },
          skill: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.skill,
            useLlm: false
          }
        }
      }
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId
      }
    });
    const complete = service.completeTurn("turn-l2-third-draft-valid", {
      sessionId: session.sessionId,
      episodeId: "episode-l2-third-draft-valid",
      query: "pytest migration output needs focused diagnosis",
      answer: "Run focused tests and inspect the exact failure.",
      toolCalls: [{
        name: "shell",
        input: { cmd: "npm test -- migration" },
        output: "ok",
        success: true
      }]
    });
    await service.feedback({
      sessionId: session.sessionId,
      l1MemoryId: complete.l1MemoryId,
      channel: "explicit",
      polarity: "positive",
      magnitude: 1,
      rationale: "the focused migration diagnosis worked"
    });
    service.closeSession(session.sessionId);
    makeTraceEligibleForL2(db, complete.l1MemoryId);
    for (let i = 0; i < 8; i += 1) {
      await service.runWorkerOnce(50);
      if (calls.some((call) => call.options.operation === "l2.induction.v4")) {
        break;
      }
    }

    expect(calls.filter((call) => call.options.operation === "l2.induction.v4")).toHaveLength(3);
    const l2Rows = db.db.prepare(
      `SELECT id
       FROM memories
       WHERE user_id = ? AND memory_layer = 'L2'`
    ).all(userId) as Array<{ id: string }>;
    expect(l2Rows).toHaveLength(1);
    const skippedCount = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM memory_change_log
       WHERE user_id = ?
         AND change_type = 'l2_induction_skipped'`
    ).get(userId) as { count: number };
    expect(skippedCount.count).toBe(0);
    const job = db.db.prepare(
      `SELECT status, attempts, last_error
       FROM evolution_jobs
       WHERE user_id = ? AND job_type = 'l2_induction'
       ORDER BY created_at DESC
       LIMIT 1`
    ).get(userId) as { status: string; attempts: number; last_error: string | null };
    expect(job).toMatchObject({
      status: "succeeded",
      attempts: 1,
      last_error: null
    });
    const downstreamJobs = db.db.prepare(
      `SELECT job_type
       FROM evolution_jobs
       WHERE user_id = ?
         AND (
           job_type = 'l3_abstraction'
           OR (
             job_type = 'embedding'
             AND target_memory_id = ?
             AND json_extract(payload_json, '$.reason') = 'l2.upserted'
           )
         )
       ORDER BY job_type`
    ).all(userId, l2Rows[0]!.id) as Array<{ job_type: string }>;
    expect(downstreamJobs.map((item) => item.job_type)).toEqual(["embedding"]);

    db.close();
  });
});

function createBc08SummaryLlm(): LlmClient {
  return {
    config: {
      ...DEFAULT_MEMMY_CONFIG.summary,
      provider: "host",
      endpoint: "http://127.0.0.1/bc-08-summary",
      model: "bc-08-summary"
    },
    isConfigured: () => true,
    complete: async () => "unused",
    async completeJson<T extends Record<string, unknown>>(
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
      options: { operation: string }
    ): Promise<T> {
      if (options.operation !== "capture.summarize") return {} as T;
      const payload = messages.find((message) => message.role === "user")?.content ?? "";
      if (payload.includes("以后不要写不必要的兜底代码")) {
        return {
          l1: {
            summary: "用户要求代码保持简洁、避免不必要的兜底；本轮已精简并通过测试。",
            evidence: [{
              quote: "已精简代码并通过测试",
              role: "assistant",
              kind: "task_outcome"
            }]
          },
          user: {
            action: "create",
            evidence: [{
              quote: "我更喜欢简洁的代码",
              type: "User Preference"
            }, {
              quote: "以后不要写不必要的兜底代码",
              type: "User Preference"
            }],
            target: "",
            replacement: ""
          }
        } as unknown as T;
      }
      return {
        l1: {
          summary: "按既有反馈删除不必要兜底，并通过测试验证。",
          evidence: [{
            quote: "测试验证通过",
            role: "assistant",
            kind: "task_outcome"
          }]
        },
        user: null
      } as unknown as T;
    },
    status: () => ({
      provider: "host",
      model: "bc-08-summary",
      configured: true,
      remote: true
    })
  };
}
