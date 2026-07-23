import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MEMMY_CONFIG, MemoryDb } from "../../../src/index.js";
import {
  insertActivePolicyMemory,
  makeTraceEligibleForL2,
  queueSkillCrystallizationJobForTest,
  setSkillLifecycleForTest
} from "../../fixtures/evolution-fixture.js";
import {
  createCapturingL2Llm,
  createNoToolSkillLlm
} from "./evolution-llm-stubs.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const {
  cleanup,
  createTestMemoryService,
  createTestRoot,
  createTestService
} = createMemoryServiceFixture();

afterEach(cleanup);

describe("MemoryService / evolution / skill lifecycle", () => {
  it("does not crystallize failure-only policies into skills", async () => {
    const { db, service } = createTestService();
    const at = new Date().toISOString();
    const policy = {
      title: "Policy: avoid repeating failed parser path",
      trigger: "When SEC 13F parsing fails with the same input path.",
      procedure: "Avoid retrying the same parser path without changing the extraction strategy.",
      verification: "Check parser output before continuing.",
      boundary: "Only applies to the same parser failure family.",
      support: 3,
      gain: 0.8,
      raw_gain: 0.8,
      status: "active",
      experience_type: "failure_avoidance",
      evidence_polarity: "negative",
      skill_eligible: false,
      signature: "sec13f|parser|_",
      source_episode_ids: ["episode_failure_a", "episode_failure_b"],
      source_trace_ids: ["trace_failure_a", "trace_failure_b"]
    };
    db.db.prepare(
      `INSERT INTO memories (
        id, timeline, user_id, memory_type, status, visibility, memory_key,
        memory_value, tags_json, info_json, properties_json, memory_layer,
        version, created_at, updated_at
      ) VALUES (?, ?, ?, 'LongTermMemory', 'activated', 'private', ?, ?, ?, '{}', ?, 'L2', 1, ?, ?)`
    ).run(
      "policy_failure_only",
      at,
      "user-skill-guard",
      "policy:failure-only",
      "Avoid repeating a failed parser path.",
      JSON.stringify(["policy", "sec13f"]),
      JSON.stringify({
        internal_info: {
          memory_layer: "L2",
          policy
        }
      }),
      at,
      at
    );
    db.db.prepare(
      `INSERT INTO evolution_jobs (
         id, job_type, status, user_id, target_memory_id, payload_json,
         attempts, max_attempts, created_at, updated_at
       ) VALUES (?, 'skill_crystallization', 'queued', ?, ?, '{}', 0, 3, ?, ?)`
    ).run("job_skill_failure_only", "user-skill-guard", "policy_failure_only", at, at);

    await service.runWorkerOnce(5);

    const skillCount = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM memories
       WHERE user_id = 'user-skill-guard'
         AND memory_layer = 'Skill'`
    ).get() as { count: number };
    expect(skillCount.count).toBe(0);
    db.close();
  });

  it("skips skill crystallization when an existing non-archived skill is fresh", async () => {
    const { db, service } = createTestService({ skillLlm: createNoToolSkillLlm() });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-fresh-skill-skip"
      },
      workspaceId: "workspace-fresh-skill"
    });
    const complete = service.completeTurn("turn-fresh-skill-skip", {
      sessionId: session.sessionId,
      episodeId: "episode-fresh-skill-skip",
      query: "python pytest inspect failure retry after fixing issue",
      answer: "Run pytest, inspect the failure, retry after fixing issue, then verify the result."
    });
    insertActivePolicyMemory(db, {
      id: "policy_fresh_skill_skip",
      userId: "user-fresh-skill-skip",
      sessionId: session.sessionId,
      agentId: "codex",
      appId: "workspace-fresh-skill",
      profileId: "jiang",
      sourceTraceId: complete.l1MemoryId,
      sourceEpisodeId: complete.episodeId
    });
    db.db.prepare(`UPDATE evolution_jobs SET status = 'succeeded'`).run();
    const firstAt = new Date().toISOString();
    db.db.prepare(
      `INSERT INTO evolution_jobs (
         id, job_type, status, user_id, session_id, episode_id, target_memory_id,
         payload_json, attempts, max_attempts, created_at, updated_at
       ) VALUES (?, 'skill_crystallization', 'queued', ?, ?, ?, ?, '{}', 0, 3, ?, ?)`
    ).run(
      "job_fresh_skill_create",
      "user-fresh-skill-skip",
      session.sessionId,
      complete.episodeId,
      "policy_fresh_skill_skip",
      firstAt,
      firstAt
    );
    await service.runWorkerOnce(10);

    const createdSkill = db.db.prepare(
      `SELECT id, updated_at
       FROM memories
       WHERE user_id = 'user-fresh-skill-skip'
         AND memory_layer = 'Skill'
       LIMIT 1`
    ).get() as { id: string; updated_at: string } | undefined;
    expect(createdSkill).toBeTruthy();

    db.db.prepare(`UPDATE evolution_jobs SET status = 'succeeded'`).run();
    const secondAt = new Date().toISOString();
    db.db.prepare(
      `INSERT INTO evolution_jobs (
         id, job_type, status, user_id, session_id, episode_id, target_memory_id,
         payload_json, attempts, max_attempts, created_at, updated_at
       ) VALUES (?, 'skill_crystallization', 'queued', ?, ?, ?, ?, '{}', 0, 3, ?, ?)`
    ).run(
      "job_fresh_skill_skip",
      "user-fresh-skill-skip",
      session.sessionId,
      complete.episodeId,
      "policy_fresh_skill_skip",
      secondAt,
      secondAt
    );
    await service.runWorkerOnce(10);

    const unchangedSkill = db.db.prepare(
      `SELECT updated_at
       FROM memories
       WHERE id = ?`
    ).get(createdSkill!.id) as { updated_at: string };
    expect(unchangedSkill.updated_at).toBe(createdSkill!.updated_at);
    const skipped = db.db.prepare(
      `SELECT after_json
       FROM memory_change_log
       WHERE memory_id = 'policy_fresh_skill_skip'
         AND change_type = 'skill_crystallization_skipped'
       ORDER BY seq DESC
       LIMIT 1`
    ).get() as { after_json: string } | undefined;
    expect(JSON.parse(skipped!.after_json)).toMatchObject({
      policyId: "policy_fresh_skill_skip",
      reason: "llm-failed: skill.crystallize.invalid: missing retrieval_blurb"
    });

    db.close();
  });

  it("debounces repeated skill crystallization for the same policy during cooldown", async () => {
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
          capture: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.capture,
            synthReflection: false,
            embedAfterCapture: false
          },
          l3Abstraction: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.l3Abstraction,
            useLlm: false
          },
          skill: {
            ...DEFAULT_MEMMY_CONFIG.algorithm.skill,
            useLlm: true,
            cooldownMs: 60_000
          }
        }
      }
    });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-skill-cooldown"
      },
      workspaceId: "workspace-skill-cooldown"
    });
    const complete = service.completeTurn("turn-skill-cooldown", {
      sessionId: session.sessionId,
      episodeId: "episode-skill-cooldown",
      query: "python pytest inspect failure retry after fixing issue",
      answer: "Run pytest, inspect the failure, retry after fixing issue, then verify the result."
    });
    insertActivePolicyMemory(db, {
      id: "policy_skill_cooldown",
      userId: "user-skill-cooldown",
      sessionId: session.sessionId,
      agentId: "codex",
      appId: "workspace-skill-cooldown",
      profileId: "jiang",
      sourceTraceId: complete.l1MemoryId,
      sourceEpisodeId: complete.episodeId
    });
    db.db.prepare(`UPDATE evolution_jobs SET status = 'succeeded'`).run();
    const firstAt = new Date().toISOString();
    db.db.prepare(
      `INSERT INTO evolution_jobs (
         id, job_type, status, user_id, session_id, episode_id, target_memory_id,
         payload_json, attempts, max_attempts, created_at, updated_at
       ) VALUES (?, 'skill_crystallization', 'queued', ?, ?, ?, ?, '{}', 0, 3, ?, ?)`
    ).run(
      "job_skill_cooldown_create",
      "user-skill-cooldown",
      session.sessionId,
      complete.episodeId,
      "policy_skill_cooldown",
      firstAt,
      firstAt
    );
    await service.runWorkerOnce(10);

    const createdSkill = db.db.prepare(
      `SELECT id, updated_at
       FROM memories
       WHERE user_id = 'user-skill-cooldown'
         AND memory_layer = 'Skill'
       LIMIT 1`
    ).get() as { id: string; updated_at: string } | undefined;
    expect(createdSkill).toBeTruthy();

    const policyUpdatedAt = new Date(Date.parse(createdSkill!.updated_at) + 1000).toISOString();
    db.db.prepare(
      `UPDATE memories
       SET updated_at = ?
       WHERE id = 'policy_skill_cooldown'`
    ).run(policyUpdatedAt);
    db.db.prepare(`UPDATE evolution_jobs SET status = 'succeeded'`).run();
    const secondAt = new Date().toISOString();
    db.db.prepare(
      `INSERT INTO evolution_jobs (
         id, job_type, status, user_id, session_id, episode_id, target_memory_id,
         payload_json, attempts, max_attempts, created_at, updated_at
       ) VALUES (?, 'skill_crystallization', 'queued', ?, ?, ?, ?, '{}', 0, 3, ?, ?)`
    ).run(
      "job_skill_cooldown_skip",
      "user-skill-cooldown",
      session.sessionId,
      complete.episodeId,
      "policy_skill_cooldown",
      secondAt,
      secondAt
    );
    await service.runWorkerOnce(10);

    const skills = db.db.prepare(
      `SELECT id, updated_at
       FROM memories
       WHERE user_id = 'user-skill-cooldown'
         AND memory_layer = 'Skill'`
    ).all() as Array<{ id: string; updated_at: string }>;
    expect(skills).toEqual([createdSkill]);
    const skipped = db.db.prepare(
      `SELECT after_json
       FROM memory_change_log
       WHERE memory_id = 'policy_skill_cooldown'
         AND change_type = 'skill_crystallization_skipped'
       ORDER BY seq DESC
       LIMIT 1`
    ).get() as { after_json: string } | undefined;
    expect(JSON.parse(skipped!.after_json)).toMatchObject({
      policyId: "policy_skill_cooldown",
      skillId: createdSkill!.id,
      reason: "cooldown"
    });

    db.close();
  });

  it("finds fresh existing skills by source policy ids even with nonstandard keys", async () => {
    const { db, service } = createTestService({ skillLlm: createCapturingL2Llm([]) });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-source-policy-skill-skip"
      },
      workspaceId: "workspace-source-policy-skill"
    });
    const complete = service.completeTurn("turn-source-policy-skill-skip", {
      sessionId: session.sessionId,
      episodeId: "episode-source-policy-skill-skip",
      query: "python pytest inspect failure retry after fixing issue",
      answer: "Run pytest, inspect the failure, retry after fixing issue, then verify the result."
    });
    insertActivePolicyMemory(db, {
      id: "policy_source_policy_skill_skip",
      userId: "user-source-policy-skill-skip",
      sessionId: session.sessionId,
      agentId: "codex",
      appId: "workspace-source-policy-skill",
      profileId: "jiang",
      sourceTraceId: complete.l1MemoryId,
      sourceEpisodeId: complete.episodeId
    });
    const policyRow = db.db.prepare(
      `SELECT updated_at
       FROM memories
       WHERE id = 'policy_source_policy_skill_skip'`
    ).get() as { updated_at: string };
    const skillUpdatedAt = new Date(Date.parse(policyRow.updated_at) + 1000).toISOString();
    const skillProperties = {
      memory_type: "LongTermMemory",
      status: "activated",
      tags: ["skill", "python", "pytest"],
      info: { profile_id: "jiang" },
      internal_info: {
        memory_layer: "Skill",
        memory_kind: "skill",
        schema_version: 1,
        source_memory_ids: ["policy_source_policy_skill_skip"],
        source_policy_ids: ["policy_source_policy_skill_skip"],
        name: "existing_policy_sourced_skill",
        invocation_guide: "# Existing policy sourced skill",
        procedure_json: { summary: "Existing skill for this policy." },
        eta: 0.8,
        support: 2,
        gain: 0.8,
        skill: {
          name: "existing_policy_sourced_skill",
          eta: 0.8,
          status: "active",
          support: 2,
          gain: 0.8,
          source_policy_ids: ["policy_source_policy_skill_skip"],
          source_world_model_ids: [],
          evidence_anchor_ids: [complete.l1MemoryId],
          invocation_guide: "# Existing policy sourced skill",
          procedure_json: { summary: "Existing skill for this policy." },
          trials_attempted: 0,
          trials_passed: 0,
          success_rate: 0,
          beta_posterior: { alpha: 1, beta: 1, mean: 0.5 },
          vec: null
        }
      }
    };
    db.db.prepare(
      `INSERT INTO memories (
        id, timeline, user_id, conversation_id, session_id, agent_id, app_id,
        memory_type, status, visibility, memory_key, memory_value,
        tags_json, info_json, properties_json, memory_layer, content_hash,
        version, created_at, updated_at, deleted_at
      ) VALUES (
        ?, ?, ?, NULL, ?, ?, ?,
        'LongTermMemory', 'activated', 'private', ?, ?,
        ?, ?, ?, 'Skill', ?,
        1, ?, ?, NULL
      )`
    ).run(
      "skill_existing_source_policy_skip",
      skillUpdatedAt,
      "user-source-policy-skill-skip",
      session.sessionId,
      "codex",
      "workspace-source-policy-skill",
      "skill:legacy-existing-policy-sourced",
      "# Existing policy sourced skill",
      JSON.stringify(["skill", "python", "pytest"]),
      JSON.stringify({
        profile_id: "jiang",
        source_memory_ids: ["policy_source_policy_skill_skip"]
      }),
      JSON.stringify(skillProperties),
      "hash_skill_existing_source_policy_skip",
      skillUpdatedAt,
      skillUpdatedAt
    );
    db.db.prepare(`UPDATE evolution_jobs SET status = 'succeeded'`).run();
    const jobAt = new Date().toISOString();
    db.db.prepare(
      `INSERT INTO evolution_jobs (
         id, job_type, status, user_id, session_id, episode_id, target_memory_id,
         payload_json, attempts, max_attempts, created_at, updated_at
       ) VALUES (?, 'skill_crystallization', 'queued', ?, ?, ?, ?, '{}', 0, 3, ?, ?)`
    ).run(
      "job_source_policy_skill_skip",
      "user-source-policy-skill-skip",
      session.sessionId,
      complete.episodeId,
      "policy_source_policy_skill_skip",
      jobAt,
      jobAt
    );
    await service.runWorkerOnce(10);

    const skillRows = db.db.prepare(
      `SELECT id, memory_key
       FROM memories
       WHERE user_id = 'user-source-policy-skill-skip'
         AND memory_layer = 'Skill'`
    ).all() as Array<{ id: string; memory_key: string }>;
    expect(skillRows).toEqual([{
      id: "skill_existing_source_policy_skip",
      memory_key: "skill:legacy-existing-policy-sourced"
    }]);
    const skipped = db.db.prepare(
      `SELECT after_json
       FROM memory_change_log
       WHERE memory_id = 'policy_source_policy_skill_skip'
         AND change_type = 'skill_crystallization_skipped'
       ORDER BY seq DESC
       LIMIT 1`
    ).get() as { after_json: string } | undefined;
    expect(JSON.parse(skipped!.after_json)).toMatchObject({
      policyId: "policy_source_policy_skill_skip",
      reason: "llm-failed: skill.crystallize.invalid: missing retrieval_blurb"
    });

    db.close();
  });

  it("creates a fresh skill instead of reviving an archived skill with the same key", async () => {
    const { db, service } = createTestService({ skillLlm: createNoToolSkillLlm() });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-archived-skill-recreate"
      },
      workspaceId: "workspace-archived-skill-recreate"
    });
    const complete = service.completeTurn("turn-archived-skill-recreate", {
      sessionId: session.sessionId,
      episodeId: "episode-archived-skill-recreate",
      query: "python pytest inspect failure retry after fixing issue",
      answer: "Run pytest, inspect the failure, retry after fixing issue, then verify the result."
    });
    insertActivePolicyMemory(db, {
      id: "policy_archived_skill_recreate",
      userId: "user-archived-skill-recreate",
      sessionId: session.sessionId,
      agentId: "codex",
      appId: "workspace-archived-skill-recreate",
      profileId: "jiang",
      sourceTraceId: complete.l1MemoryId,
      sourceEpisodeId: complete.episodeId
    });
    db.db.prepare(
      `UPDATE memories
       SET timeline = '2024-01-01T00:00:00.000Z',
           updated_at = '2024-01-01T00:00:00.000Z'
       WHERE id = 'policy_archived_skill_recreate'`
    ).run();
    const archivedProperties = {
      memory_type: "SkillMemory",
      status: "archived",
      tags: ["skill", "python", "pytest"],
      info: { profile_id: "jiang" },
      internal_info: {
        memory_layer: "Skill",
        memory_kind: "skill",
        schema_version: 1,
        source_memory_ids: ["policy_archived_skill_recreate"],
        source_policy_ids: ["policy_archived_skill_recreate"],
        name: "archived_pytest_retry_skill",
        invocation_guide: "# Archived pytest retry skill",
        procedure_json: { summary: "Archived skill should stay archived." },
        eta: 0.1,
        support: 2,
        gain: 0.1,
        skill: {
          name: "archived_pytest_retry_skill",
          eta: 0.1,
          status: "archived",
          support: 2,
          gain: 0.1,
          source_policy_ids: ["policy_archived_skill_recreate"],
          source_world_model_ids: [],
          evidence_anchor_ids: [complete.l1MemoryId],
          invocation_guide: "# Archived pytest retry skill",
          procedure_json: { summary: "Archived skill should stay archived." },
          trials_attempted: 0,
          trials_passed: 0,
          success_rate: 0,
          beta_posterior: { alpha: 1, beta: 1, mean: 0.5 },
          vec: null
        }
      }
    };
    db.db.prepare(
      `INSERT INTO memories (
        id, timeline, user_id, conversation_id, session_id, agent_id, app_id,
        memory_type, status, visibility, memory_key, memory_value,
        tags_json, info_json, properties_json, memory_layer, content_hash,
        version, created_at, updated_at, deleted_at
      ) VALUES (
        'skill_archived_recreate_existing', '2024-01-01T00:00:01.000Z', ?, NULL, ?, ?, ?,
        'SkillMemory', 'archived', 'private', 'skill:policy_archived_skill_recreate', ?,
        ?, ?, ?, 'Skill', 'hash_skill_archived_recreate_existing',
        1, '2024-01-01T00:00:01.000Z', '2024-01-01T00:00:01.000Z', NULL
      )`
    ).run(
      "user-archived-skill-recreate",
      session.sessionId,
      "codex",
      "workspace-archived-skill-recreate",
      "# Archived pytest retry skill",
      JSON.stringify(["skill", "python", "pytest"]),
      JSON.stringify({
        profile_id: "jiang",
        source_memory_ids: ["policy_archived_skill_recreate"]
      }),
      JSON.stringify(archivedProperties)
    );

    db.db.prepare(`UPDATE evolution_jobs SET status = 'succeeded'`).run();
    const jobAt = new Date().toISOString();
    db.db.prepare(
      `INSERT INTO evolution_jobs (
         id, job_type, status, user_id, session_id, episode_id, target_memory_id,
         payload_json, attempts, max_attempts, created_at, updated_at
       ) VALUES (?, 'skill_crystallization', 'queued', ?, ?, ?, ?, '{}', 0, 3, ?, ?)`
    ).run(
      "job_archived_skill_recreate",
      "user-archived-skill-recreate",
      session.sessionId,
      complete.episodeId,
      "policy_archived_skill_recreate",
      jobAt,
      jobAt
    );
    await service.runWorkerOnce(10);

    const skillRows = db.db.prepare(
      `SELECT id, status, updated_at, properties_json
       FROM memories
       WHERE user_id = 'user-archived-skill-recreate'
         AND memory_layer = 'Skill'
         AND memory_key = 'skill:policy_archived_skill_recreate'
       ORDER BY created_at ASC`
    ).all() as Array<{ id: string; status: string; updated_at: string; properties_json: string }>;
    expect(skillRows).toHaveLength(2);
    const archived = skillRows.find((row) => row.id === "skill_archived_recreate_existing");
    const fresh = skillRows.find((row) => row.id !== "skill_archived_recreate_existing");
    expect(archived).toMatchObject({
      status: "archived",
      updated_at: "2024-01-01T00:00:01.000Z"
    });
    expect(JSON.parse(archived!.properties_json).internal_info.skill.status).toBe("archived");
    expect(fresh).toBeTruthy();
    expect(fresh!.status).toBe("resolving");
    expect(JSON.parse(fresh!.properties_json).internal_info.skill.status).toBe("candidate");

    const created = db.db.prepare(
      `SELECT memory_id, before_json, after_json
       FROM memory_change_log
       WHERE user_id = 'user-archived-skill-recreate'
         AND kind = 'skill'
         AND change_type = 'create'
       ORDER BY seq DESC
       LIMIT 1`
    ).get() as { memory_id: string; before_json: string | null; after_json: string } | undefined;
    expect(created?.memory_id).toBe(fresh!.id);
    expect(created?.before_json).toBeNull();

    db.close();
  });

  it("applies plugin reward drift to skills when source policy stats change", async () => {
    const { db, service } = createTestService({ skillLlm: createNoToolSkillLlm() });
    const session = service.openSession({
      namespace: {
        source: "codex",
        profileId: "jiang",
        userId: "user-skill-reward-drift"
      },
      workspaceId: "workspace-skill-drift"
    });
    const complete = service.completeTurn("turn-skill-reward-drift", {
      sessionId: session.sessionId,
      episodeId: "episode-skill-reward-drift",
      query: "python pytest inspect failure retry after fixing issue for reward drift",
      answer: "Run pytest, inspect the failure, retry after fixing issue, then verify the result."
    });
    makeTraceEligibleForL2(db, complete.l1MemoryId);
    insertActivePolicyMemory(db, {
      id: "policy_skill_reward_drift",
      userId: "user-skill-reward-drift",
      sessionId: session.sessionId,
      agentId: "codex",
      appId: "workspace-skill-drift",
      profileId: "jiang",
      sourceTraceId: complete.l1MemoryId,
      sourceEpisodeId: complete.episodeId
    });
    db.db.prepare(`UPDATE evolution_jobs SET status = 'succeeded'`).run();
    const at = new Date().toISOString();
    db.db.prepare(
      `INSERT INTO evolution_jobs (
         id, job_type, status, user_id, session_id, episode_id, target_memory_id,
         payload_json, attempts, max_attempts, created_at, updated_at
       ) VALUES (?, 'skill_crystallization', 'queued', ?, ?, ?, ?, '{}', 0, 3, ?, ?)`
    ).run(
      "job_skill_reward_drift_crystallize",
      "user-skill-reward-drift",
      session.sessionId,
      complete.episodeId,
      "policy_skill_reward_drift",
      at,
      at
    );
    await service.runWorkerOnce(10);

    const skillRow = db.db.prepare(
      `SELECT id
       FROM memories
       WHERE user_id = 'user-skill-reward-drift'
         AND memory_layer = 'Skill'
       LIMIT 1`
    ).get() as { id: string } | undefined;
    expect(skillRow).toBeTruthy();
    setSkillLifecycleForTest(db, skillRow!.id, {
      eta: 0.2,
      status: "active",
      trialsAttempted: 0,
      trialsPassed: 0
    });

    db.db.prepare(`UPDATE evolution_jobs SET status = 'succeeded'`).run();
    const associationAt = new Date().toISOString();
    db.db.prepare(
      `INSERT INTO evolution_jobs (
         id, job_type, status, user_id, session_id, episode_id, target_memory_id,
         payload_json, attempts, max_attempts, created_at, updated_at
       ) VALUES (?, 'l2_association', 'queued', ?, ?, ?, ?, '{}', 0, 3, ?, ?)`
    ).run(
      "job_skill_reward_drift_association",
      "user-skill-reward-drift",
      session.sessionId,
      complete.episodeId,
      complete.l1MemoryId,
      associationAt,
      associationAt
    );
    await service.runWorkerOnce(10);

    const policyRow = db.db.prepare(
      `SELECT properties_json
       FROM memories
       WHERE id = 'policy_skill_reward_drift'`
    ).get() as { properties_json: string };
    const policyMeta = JSON.parse(policyRow.properties_json) as {
      internal_info: { policy: { gain: number } };
    };
    const driftedSkillRow = db.db.prepare(
      `SELECT status, properties_json
       FROM memories
       WHERE id = ?`
    ).get(skillRow!.id) as { status: string; properties_json: string };
    const driftedSkill = JSON.parse(driftedSkillRow.properties_json) as {
      internal_info: {
        eta?: number;
        skill: {
          eta?: number;
          status?: string;
          trials_attempted?: number;
          trials_passed?: number;
        };
      };
    };
    const expectedEta = 0.7 * 0.2 + 0.3 * policyMeta.internal_info.policy.gain;
    expect(driftedSkill.internal_info.skill.eta).toBeCloseTo(expectedEta);
    expect(driftedSkill.internal_info.eta).toBe(driftedSkill.internal_info.skill.eta);
    expect(driftedSkill.internal_info.skill.status).toBe("active");
    expect(driftedSkillRow.status).toBe("activated");
    expect(driftedSkill.internal_info.skill.trials_attempted).toBe(0);
    expect(driftedSkill.internal_info.skill.trials_passed).toBe(0);
    const driftChange = db.db.prepare(
      `SELECT change_type, source
       FROM memory_change_log
       WHERE memory_id = ?
         AND change_type = 'skill_reward_drift'
       ORDER BY seq DESC
       LIMIT 1`
    ).get(skillRow!.id) as { change_type: string; source: string } | undefined;
    expect(driftChange).toMatchObject({
      change_type: "skill_reward_drift",
      source: "worker.skill_lifecycle.v7"
    });

    db.close();
  });

  it("defaults a missing skill name like the plugin crystallizer normalizer", async () => {
    const root = createTestRoot("mindock-memory-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const calls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string };
    }> = [];
    const userId = "user-default-skill-name";
    const service = createTestMemoryService({
      db,
      mode: "dev",
      skillLlm: createCapturingL2Llm(calls, {
        retrieval_blurb: "Use for pytest sqlite migration failure requests.",
        trigger_context: "Use when pytest sqlite migration diagnostics are needed.",
        summary: "Use focused pytest checks for sqlite migration regressions.",
        steps: [{
          title: "Run focused pytest",
          body: "Run the focused pytest workflow and inspect migration output before retrying."
        }]
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
            minGain: 0.01,
            evidenceLimit: 5
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
    const first = service.completeTurn("turn-invalid-skill-draft-a", {
      sessionId: session.sessionId,
      episodeId: "episode-invalid-skill-draft-a",
      query: "pytest sqlite migration workflow needs focused diagnostics",
      answer: "Run focused tests, inspect migration output, then retry the exact failure.",
      toolCalls: [{
        name: "shell",
        input: { cmd: "npm test -- migration" },
        output: "ok",
        success: true
      }]
    });
    const second = service.completeTurn("turn-invalid-skill-draft-b", {
      sessionId: session.sessionId,
      episodeId: "episode-invalid-skill-draft-b",
      query: "pytest sqlite schema migration workflow needs focused diagnostics",
      answer: "Run focused tests, inspect migration output, then retry the exact failure.",
      toolCalls: [{
        name: "shell",
        input: { cmd: "npm test -- schema" },
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
    const policyId = "policy_default_skill_name";
    insertActivePolicyMemory(db, {
      id: policyId,
      userId,
      sessionId: session.sessionId,
      agentId: "codex",
      appId: "",
      profileId: "jiang",
      sourceTraceId: first.l1MemoryId,
      sourceEpisodeId: first.episodeId
    });
    db.db.prepare(`UPDATE evolution_jobs SET status = 'succeeded'`).run();
    queueSkillCrystallizationJobForTest(db, {
      id: "job_default_skill_name",
      userId,
      sessionId: session.sessionId,
      episodeId: first.episodeId,
      policyId
    });
    for (let i = 0; i < 40; i += 1) {
      await service.runWorkerOnce(100);
      if (calls.some((call) => call.options.operation === "skill.crystallize")) {
        break;
      }
    }

    expect(calls.some((call) => call.options.operation === "skill.crystallize")).toBe(true);
    const skillRow = db.db.prepare(
      `SELECT memory_key, properties_json
       FROM memories
       WHERE user_id = ? AND memory_layer = 'Skill'
       LIMIT 1`
    ).get(userId) as { memory_key: string; properties_json: string };
    const sourcePolicyId = skillRow.memory_key.replace(/^skill:/, "");
    const policyRow = db.db.prepare(
      `SELECT id, properties_json
       FROM memories
       WHERE id = ? AND user_id = ? AND memory_layer = 'L2'
       LIMIT 1`
    ).get(sourcePolicyId, userId) as { id: string; properties_json: string };
    const policyProperties = JSON.parse(policyRow.properties_json) as {
      internal_info?: {
        title?: string;
        policy?: {
          title?: string;
        };
      };
    };
    const policyTitle = policyProperties.internal_info?.title ??
      policyProperties.internal_info?.policy?.title;
    const expectedName = `skill_${policyRow.id.slice(-6)}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 32);
    const skillProperties = JSON.parse(skillRow.properties_json) as {
      internal_info?: {
        name?: string;
        procedure_json?: {
          preconditions?: unknown[];
          parameters?: unknown[];
          examples?: unknown[];
          tags?: unknown[];
          tools?: unknown[];
          decisionGuidance?: { preference?: unknown[]; antiPattern?: unknown[] };
        };
        skill?: {
          name?: string;
          invocation_guide?: string;
          procedure_json?: {
            preconditions?: unknown[];
            parameters?: unknown[];
            examples?: unknown[];
            tags?: unknown[];
            tools?: unknown[];
            decisionGuidance?: { preference?: unknown[]; antiPattern?: unknown[] };
          };
        };
      };
    };
    expect(skillRow.memory_key).toBe(`skill:${policyRow.id}`);
    expect(skillProperties.internal_info?.name).toBe(expectedName);
    expect(skillProperties.internal_info?.skill?.name).toBe(expectedName);
    expect(policyTitle).toBeTruthy();
    expect(skillProperties.internal_info?.skill?.invocation_guide).toContain(`# ${policyTitle}`);
    expect(skillProperties.internal_info?.procedure_json?.preconditions).toEqual([]);
    expect(skillProperties.internal_info?.procedure_json?.parameters).toEqual([]);
    expect(skillProperties.internal_info?.procedure_json?.examples).toEqual([]);
    expect(skillProperties.internal_info?.procedure_json?.tags).toEqual([]);
    expect(skillProperties.internal_info?.procedure_json?.tools).toEqual([]);
    expect(skillProperties.internal_info?.procedure_json?.decisionGuidance).toEqual({ preference: [], antiPattern: [] });
    expect(skillProperties.internal_info?.skill?.procedure_json?.preconditions).toEqual([]);
    expect(skillProperties.internal_info?.skill?.procedure_json?.tools).toEqual([]);

    db.close();
  });

  it("rejects string skill steps like the plugin crystallizer validator", async () => {
    const root = createTestRoot("mindock-memory-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const calls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string };
    }> = [];
    const userId = "user-invalid-string-skill-steps";
    const service = createTestMemoryService({
      db,
      mode: "dev",
      skillLlm: createCapturingL2Llm(calls, {
        name: "String Steps Skill",
        retrieval_blurb: "Use for pytest sqlite migration failure requests.",
        trigger_context: "Use when pytest sqlite migration diagnostics are needed.",
        summary: "Use focused pytest checks for sqlite migration regressions.",
        steps: ["Run the focused pytest workflow and inspect migration output before retrying."]
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
            minGain: 0.01,
            evidenceLimit: 5
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
    const first = service.completeTurn("turn-invalid-string-skill-steps-a", {
      sessionId: session.sessionId,
      episodeId: "episode-invalid-string-skill-steps-a",
      query: "pytest sqlite migration workflow needs focused diagnostics",
      answer: "Run focused tests, inspect migration output, then retry the exact failure.",
      toolCalls: [{
        name: "shell",
        input: { cmd: "npm test -- migration" },
        output: "ok",
        success: true
      }]
    });
    const second = service.completeTurn("turn-invalid-string-skill-steps-b", {
      sessionId: session.sessionId,
      episodeId: "episode-invalid-string-skill-steps-b",
      query: "pytest sqlite schema migration workflow needs focused diagnostics",
      answer: "Run focused tests, inspect migration output, then retry the exact failure.",
      toolCalls: [{
        name: "shell",
        input: { cmd: "npm test -- schema" },
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
    const policyId = "policy_invalid_string_skill_steps";
    insertActivePolicyMemory(db, {
      id: policyId,
      userId,
      sessionId: session.sessionId,
      agentId: "codex",
      appId: "",
      profileId: "jiang",
      sourceTraceId: first.l1MemoryId,
      sourceEpisodeId: first.episodeId
    });
    db.db.prepare(`UPDATE evolution_jobs SET status = 'succeeded'`).run();
    queueSkillCrystallizationJobForTest(db, {
      id: "job_invalid_string_skill_steps",
      userId,
      sessionId: session.sessionId,
      episodeId: first.episodeId,
      policyId
    });
    for (let i = 0; i < 40; i += 1) {
      await service.runWorkerOnce(100);
      if (calls.some((call) => call.options.operation === "skill.crystallize")) {
        break;
      }
    }

    expect(calls.some((call) => call.options.operation === "skill.crystallize")).toBe(true);
    const skillCount = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM memories
       WHERE user_id = ? AND memory_layer = 'Skill'`
    ).get(userId) as { count: number };
    expect(skillCount.count).toBe(0);
    const skippedRows = db.db.prepare(
      `SELECT after_json
       FROM memory_change_log
       WHERE user_id = ?
         AND kind = 'skill'
         AND op = 'skipped'
         AND change_type = 'skill_crystallization_skipped'
       ORDER BY seq DESC`
    ).all(userId) as Array<{ after_json: string }>;
    const skippedReasons = skippedRows.map((row) => {
      const after = JSON.parse(row.after_json) as { reason?: string };
      return after.reason;
    });
    expect(skippedReasons).toContain("llm-failed: skill.crystallize.invalid: missing steps");

    db.close();
  });

  it("skips skill crystallization when the model returns a refusal", async () => {
    const root = createTestRoot("mindock-memory-");
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    const calls: Array<{
      messages: Array<{ role: string; content: string }>;
      options: { operation: string };
    }> = [];
    const userId = "user-refusal-skill-draft";
    const service = createTestMemoryService({
      db,
      mode: "dev",
      skillLlm: createCapturingL2Llm(calls, {
        name: "Refusal Skill",
        summary: "I'm sorry, I can't help with that request.",
        steps: [{
          title: "Refuse",
          body: "I cannot assist with that request."
        }]
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
            minGain: 0.01,
            evidenceLimit: 5
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
    const first = service.completeTurn("turn-refusal-skill-draft-a", {
      sessionId: session.sessionId,
      episodeId: "episode-refusal-skill-draft-a",
      query: "pytest sqlite migration workflow needs focused diagnostics",
      answer: "Run focused tests, inspect migration output, then retry the exact failure.",
      toolCalls: [{
        name: "shell",
        input: { cmd: "npm test -- migration" },
        output: "ok",
        success: true
      }]
    });
    const second = service.completeTurn("turn-refusal-skill-draft-b", {
      sessionId: session.sessionId,
      episodeId: "episode-refusal-skill-draft-b",
      query: "pytest sqlite schema migration workflow needs focused diagnostics",
      answer: "Run focused tests, inspect migration output, then retry the exact failure.",
      toolCalls: [{
        name: "shell",
        input: { cmd: "npm test -- schema" },
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
    const policyId = "policy_refusal_skill_draft";
    insertActivePolicyMemory(db, {
      id: policyId,
      userId,
      sessionId: session.sessionId,
      agentId: "codex",
      appId: "",
      profileId: "jiang",
      sourceTraceId: first.l1MemoryId,
      sourceEpisodeId: first.episodeId
    });
    db.db.prepare(`UPDATE evolution_jobs SET status = 'succeeded'`).run();
    queueSkillCrystallizationJobForTest(db, {
      id: "job_refusal_skill_draft",
      userId,
      sessionId: session.sessionId,
      episodeId: first.episodeId,
      policyId
    });
    for (let i = 0; i < 40; i += 1) {
      await service.runWorkerOnce(100);
      if (calls.some((call) => call.options.operation === "skill.crystallize")) {
        break;
      }
    }

    expect(calls.some((call) => call.options.operation === "skill.crystallize")).toBe(true);
    const skillCount = db.db.prepare(
      `SELECT COUNT(*) AS count
       FROM memories
       WHERE user_id = ? AND memory_layer = 'Skill'`
    ).get(userId) as { count: number };
    expect(skillCount.count).toBe(0);
    const skippedRows = db.db.prepare(
      `SELECT after_json
       FROM memory_change_log
       WHERE user_id = ?
         AND kind = 'skill'
         AND op = 'skipped'
         AND change_type = 'skill_crystallization_skipped'
       ORDER BY seq DESC`
    ).all(userId) as Array<{ after_json: string }>;
    const skippedReasons = skippedRows.map((row) => {
      const after = JSON.parse(row.after_json) as { reason?: string };
      return after.reason;
    });
    expect(skippedReasons).toContain("llm-refusal");

    db.close();
  });
});
