import {
  MemoryDb,
  MemoryService
} from "../../src/index.js";
import { Repositories } from "../../src/storage/repositories.js";

export function upsertMemoryVectorForTest(
  db: MemoryDb,
  memoryId: string,
  vectorField: "vec_summary" | "vec_action" | "vec",
  vector: number[]
): void {
  const now = new Date().toISOString();
  new Repositories(db.db).vectors.upsert(memoryId, {
    vectorField,
    vector,
    embeddingModel: "test"
  }, now);
}

export function makeTraceEligibleForL2(db: MemoryDb, memoryId: string): void {
  const row = db.db.prepare(
    `SELECT properties_json
     FROM memories
     WHERE id = ?`
  ).get(memoryId) as { properties_json: string } | undefined;
  if (!row) {
    throw new Error(`memory not found: ${memoryId}`);
  }
  const properties = JSON.parse(row.properties_json) as {
    internal_info?: {
      trace?: Record<string, unknown>;
    };
  };
  if (!properties.internal_info?.trace) {
    throw new Error(`trace metadata not found: ${memoryId}`);
  }
  properties.internal_info.trace.value = 1;
  properties.internal_info.trace.priority = 1;
  db.db.prepare(
    `UPDATE memories
     SET properties_json = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(JSON.stringify(properties), new Date().toISOString(), memoryId);
  upsertMemoryVectorForTest(db, memoryId, "vec_summary", [1, 0, 0]);
  upsertMemoryVectorForTest(db, memoryId, "vec_action", [1, 0, 0]);
}

export function insertActivePolicyMemory(db: MemoryDb, input: {
  id: string;
  userId: string;
  sessionId: string;
  agentId: string;
  appId: string;
  profileId: string;
  sourceTraceId: string;
  sourceEpisodeId: string;
  decisionGuidance?: {
    preference?: string[];
    anti_pattern?: string[];
  };
}): void {
  const at = new Date().toISOString();
  const policy = {
    title: "Policy: run pytest after fixing issue",
    trigger: "python pytest failure requires inspection and retry",
    procedure: "Run pytest, inspect the failure, retry after fixing issue, then verify the result.",
    verification: "The pytest result passes after the retry.",
    boundary: "Use only for python pytest retry workflows.",
    support: 2,
    gain: 0.8,
    raw_gain: 0.8,
    policy_confidence: 0.8,
    status: "active",
    experience_type: "success_pattern",
    evidence_polarity: "positive",
    skill_eligible: true,
    signature: "python|pytest|_|_",
    source_episode_ids: [input.sourceEpisodeId],
    source_trace_ids: [input.sourceTraceId],
    decision_guidance: input.decisionGuidance ?? {
      preference: ["inspect pytest failures before retrying"],
      anti_pattern: []
    }
  };
  db.db.prepare(
    `INSERT INTO memories (
      id, timeline, user_id, conversation_id, session_id, agent_id, app_id,
      memory_type, status, visibility, memory_key, memory_value,
      tags_json, info_json, properties_json, memory_layer, content_hash,
      version, created_at, updated_at, deleted_at
    ) VALUES (
      @id, @timeline, @userId, NULL, @sessionId, @agentId, @appId,
      'LongTermMemory', 'activated', 'private', @memoryKey, @memoryValue,
      @tagsJson, @infoJson, @propertiesJson, 'L2', @contentHash,
      1, @createdAt, @updatedAt, NULL
    )`
  ).run({
    id: input.id,
    timeline: at,
    userId: input.userId,
    sessionId: input.sessionId,
    agentId: input.agentId,
    appId: input.appId,
    memoryKey: `policy:${input.id}`,
    memoryValue: policy.procedure,
    tagsJson: JSON.stringify(["policy", "python", "pytest"]),
    infoJson: JSON.stringify({
      profile_id: input.profileId,
      signature: policy.signature,
      support: policy.support,
      gain: policy.gain,
      policy_confidence: policy.policy_confidence,
      status: policy.status,
      source_memory_ids: policy.source_trace_ids
    }),
    propertiesJson: JSON.stringify({
      memory_type: "LongTermMemory",
      status: "activated",
      tags: ["policy", "python", "pytest"],
      info: { profile_id: input.profileId },
      internal_info: {
        memory_layer: "L2",
        memory_kind: "policy",
        schema_version: 1,
        source_memory_ids: policy.source_trace_ids,
        policy
      }
    }),
    contentHash: `hash_${input.id}`,
    createdAt: at,
    updatedAt: at
  });
  upsertMemoryVectorForTest(db, input.id, "vec", [1, 0, 0]);
}

export function insertActiveSkillMemoryForTest(db: MemoryDb, input: {
  id: string;
  userId: string;
  sessionId: string;
  agentId: string;
  appId?: string;
  profileId: string;
  sourcePolicyIds?: string[];
  sourceWorldModelIds?: string[];
  evidenceAnchorIds?: string[];
  tags?: string[];
  name?: string;
  invocationGuide?: string;
}): void {
  const at = new Date().toISOString();
  const tags = input.tags ?? ["skill", "neutral_reward"];
  const skill = {
    name: input.name ?? "neutral_reward_skill",
    eta: 0.8,
    status: "active",
    support: 1,
    gain: 0.5,
    source_policy_ids: input.sourcePolicyIds ?? [],
    source_world_model_ids: input.sourceWorldModelIds ?? [],
    evidence_anchor_ids: input.evidenceAnchorIds ?? [],
    invocation_guide: input.invocationGuide ?? "Use the neutral reward skill checklist when sqlite migration work needs a cautious next step.",
    procedure_json: {
      summary: "Apply the checklist and wait for outcome evidence before updating reliability."
    },
    trials_attempted: 0,
    trials_passed: 0,
    success_rate: 0,
    beta_posterior: {
      alpha: 1,
      beta: 1,
      mean: 0.5
    }
  };
  db.db.prepare(
    `INSERT INTO memories (
      id, timeline, user_id, conversation_id, session_id, agent_id, app_id,
      memory_type, status, visibility, memory_key, memory_value,
      tags_json, info_json, properties_json, memory_layer, content_hash,
      version, created_at, updated_at, deleted_at
    ) VALUES (
      @id, @timeline, @userId, NULL, @sessionId, @agentId, @appId,
      'SkillMemory', 'activated', 'private', @memoryKey, @memoryValue,
      @tagsJson, @infoJson, @propertiesJson, 'Skill', @contentHash,
      1, @createdAt, @updatedAt, NULL
    )`
  ).run({
    id: input.id,
    timeline: at,
    userId: input.userId,
    sessionId: input.sessionId,
    agentId: input.agentId,
    appId: input.appId ?? null,
    memoryKey: `skill:${input.id}`,
    memoryValue: skill.invocation_guide,
    tagsJson: JSON.stringify(tags),
    infoJson: JSON.stringify({
      tags,
      profile_id: input.profileId,
      eta: skill.eta,
      support: skill.support,
      gain: skill.gain,
      skill_status: skill.status,
      source_memory_ids: [...skill.source_policy_ids, ...skill.source_world_model_ids]
    }),
    propertiesJson: JSON.stringify({
      memory_type: "SkillMemory",
      status: "activated",
      tags,
      info: { tags, profile_id: input.profileId },
      internal_info: {
        memory_layer: "Skill",
        memory_kind: "skill",
        schema_version: 1,
        source_memory_ids: [...skill.source_policy_ids, ...skill.source_world_model_ids],
        source_policy_ids: skill.source_policy_ids,
        source_world_model_ids: skill.source_world_model_ids,
        evidence_anchor_ids: skill.evidence_anchor_ids,
        name: skill.name,
        invocation_guide: skill.invocation_guide,
        procedure_json: skill.procedure_json,
        eta: skill.eta,
        support: skill.support,
        gain: skill.gain,
        skill
      }
    }),
    contentHash: `hash_${input.id}`,
    createdAt: at,
    updatedAt: at
  });
  upsertMemoryVectorForTest(db, input.id, "vec", [1, 0, 0]);
}

export function insertWorldModelMemoryForTest(db: MemoryDb, input: {
  id: string;
  userId: string;
  sessionId: string;
  agentId: string;
  appId: string;
  profileId: string;
  memoryKey: string;
  domainKey: string;
  domainTags: string[];
  policyIds: string[];
}): void {
  const at = new Date().toISOString();
  const structure = {
    environment: [{
      label: input.domainTags.join(", ") || input.domainKey,
      description: "Existing world model for merge tests.",
      evidenceIds: input.policyIds
    }],
    inference: [{
      label: "existing pattern",
      description: "Existing policy overlap should choose this world model as merge target.",
      evidenceIds: input.policyIds
    }],
    constraints: [{
      label: "scope",
      description: "Use only for matching policies.",
      evidenceIds: input.policyIds
    }]
  };
  db.db.prepare(
    `INSERT INTO memories (
      id, timeline, user_id, conversation_id, session_id, agent_id, app_id,
      memory_type, status, visibility, memory_key, memory_value,
      tags_json, info_json, properties_json, memory_layer, content_hash,
      version, created_at, updated_at, deleted_at
    ) VALUES (
      @id, @timeline, @userId, NULL, @sessionId, @agentId, @appId,
      'LongTermMemory', 'activated', 'private', @memoryKey, @memoryValue,
      @tagsJson, @infoJson, @propertiesJson, 'L3', @contentHash,
      1, @createdAt, @updatedAt, NULL
    )`
  ).run({
    id: input.id,
    timeline: at,
    userId: input.userId,
    sessionId: input.sessionId,
    agentId: input.agentId,
    appId: input.appId,
    memoryKey: input.memoryKey,
    memoryValue: `World model: ${input.domainKey}`,
    tagsJson: JSON.stringify(["world_model", ...input.domainTags]),
    infoJson: JSON.stringify({
      profile_id: input.profileId,
      domain_key: input.domainKey,
      confidence: 0.6,
      source_memory_ids: input.policyIds
    }),
    propertiesJson: JSON.stringify({
      memory_type: "LongTermMemory",
      status: "activated",
      tags: ["world_model", ...input.domainTags],
      info: { profile_id: input.profileId },
      internal_info: {
        memory_layer: "L3",
        memory_kind: "world_model",
        schema_version: 1,
        source_memory_ids: input.policyIds,
        title: `World model: ${input.domainKey}`,
        body: `Existing world model for ${input.domainKey}`,
        structure,
        domain_tags: input.domainTags,
        source_policy_ids: input.policyIds,
        world_model_confidence: 0.6,
        world_model: {
          title: `World model: ${input.domainKey}`,
          domain_key: input.domainKey,
          domain_tags: input.domainTags,
          policy_ids: input.policyIds,
          confidence: 0.6,
          cohesion: 1,
          admission: "strict",
          structure,
          body: `Existing world model for ${input.domainKey}`
        }
      }
    }),
    contentHash: `hash_${input.id}`,
    createdAt: at,
    updatedAt: at
  });
  upsertMemoryVectorForTest(db, input.id, "vec", [1, 0, 0]);
}

export async function addPositiveFeedbackForTurn(
  service: MemoryService,
  sessionId: string,
  turn: { episodeId: string; l1MemoryId: string }
): Promise<void> {
  await service.feedback({
    sessionId,
    episodeId: turn.episodeId,
    l1MemoryId: turn.l1MemoryId,
    channel: "explicit",
    polarity: "positive",
    magnitude: 1,
    rationale: "accepted"
  });
}

export function setTraceSignatureAndVectorForTest(
  db: MemoryDb,
  memoryId: string,
  signature: string,
  vec: number[]
): void {
  const row = db.db.prepare(
    `SELECT properties_json
     FROM memories
     WHERE id = ?`
  ).get(memoryId) as { properties_json: string } | undefined;
  if (!row) {
    throw new Error(`memory not found: ${memoryId}`);
  }
  const properties = JSON.parse(row.properties_json) as {
    internal_info?: {
      trace?: Record<string, unknown>;
    };
  };
  if (!properties.internal_info?.trace) {
    throw new Error(`trace metadata not found: ${memoryId}`);
  }
  properties.internal_info.trace.signature = signature;
  properties.internal_info.trace.value = 1;
  properties.internal_info.trace.priority = 1;
  db.db.prepare(
    `UPDATE memories
     SET properties_json = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(JSON.stringify(properties), new Date().toISOString(), memoryId);
  upsertMemoryVectorForTest(db, memoryId, "vec_summary", vec);
  upsertMemoryVectorForTest(db, memoryId, "vec_action", vec);
}

export function traceSignatureForTest(db: MemoryDb, memoryId: string): string {
  const row = db.db.prepare(
    `SELECT properties_json
     FROM memories
     WHERE id = ?`
  ).get(memoryId) as { properties_json: string } | undefined;
  const properties = row ? JSON.parse(row.properties_json) as {
    internal_info?: {
      trace?: {
        signature?: unknown;
      };
    };
  } : undefined;
  const signature = properties?.internal_info?.trace?.signature;
  if (typeof signature !== "string" || !signature) {
    throw new Error(`trace signature not found: ${memoryId}`);
  }
  return signature;
}

export function queueSkillCrystallizationJobForTest(db: MemoryDb, input: {
  id: string;
  userId: string;
  sessionId: string;
  episodeId: string;
  policyId: string;
}): void {
  const at = new Date().toISOString();
  db.db.prepare(
    `INSERT INTO evolution_jobs (
       id, job_type, status, user_id, session_id, episode_id, target_memory_id,
       payload_json, attempts, max_attempts, created_at, updated_at
     ) VALUES (?, 'skill_crystallization', 'queued', ?, ?, ?, ?, '{}', 0, 3, ?, ?)`
  ).run(
    input.id,
    input.userId,
    input.sessionId,
    input.episodeId,
    input.policyId,
    at,
    at
  );
}

export function setPolicySignatureAndVectorForTest(
  db: MemoryDb,
  policyId: string,
  signature: string,
  vec: number[] | null
): void {
  const row = db.db.prepare(
    `SELECT info_json, properties_json
     FROM memories
     WHERE id = ?`
  ).get(policyId) as { info_json: string; properties_json: string } | undefined;
  if (!row) {
    throw new Error(`policy not found: ${policyId}`);
  }
  const info = JSON.parse(row.info_json) as Record<string, unknown>;
  const properties = JSON.parse(row.properties_json) as {
    internal_info?: {
      policy?: Record<string, unknown>;
    };
  };
  if (!properties.internal_info?.policy) {
    throw new Error(`policy metadata not found: ${policyId}`);
  }
  info.signature = signature;
  properties.internal_info.policy.signature = signature;
  db.db.prepare(
    `UPDATE memories
     SET info_json = ?,
         properties_json = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(JSON.stringify(info), JSON.stringify(properties), new Date().toISOString(), policyId);
  if (vec) {
    upsertMemoryVectorForTest(db, policyId, "vec", vec);
  } else {
    new Repositories(db.db).vectors.delete(policyId, "vec");
  }
}

export function setPolicyStatsForTest(db: MemoryDb, policyId: string, input: {
  status: "candidate" | "active" | "archived";
  memoryStatus: "activated" | "resolving" | "archived";
  support: number;
  gain: number;
  rawGain: number;
  confidence: number;
}): void {
  const row = db.db.prepare(
    `SELECT info_json, properties_json
     FROM memories
     WHERE id = ?`
  ).get(policyId) as { info_json: string; properties_json: string } | undefined;
  if (!row) {
    throw new Error(`policy not found: ${policyId}`);
  }
  const info = JSON.parse(row.info_json) as Record<string, unknown>;
  const properties = JSON.parse(row.properties_json) as {
    internal_info?: {
      policy?: Record<string, unknown>;
    };
  } & Record<string, unknown>;
  if (!properties.internal_info?.policy) {
    throw new Error(`policy metadata not found: ${policyId}`);
  }
  info.status = input.status;
  info.support = input.support;
  info.gain = input.gain;
  info.raw_gain = input.rawGain;
  info.policy_confidence = input.confidence;
  properties.status = input.memoryStatus;
  properties.internal_info.policy.status = input.status;
  properties.internal_info.policy.support = input.support;
  properties.internal_info.policy.gain = input.gain;
  properties.internal_info.policy.raw_gain = input.rawGain;
  properties.internal_info.policy.policy_confidence = input.confidence;
  db.db.prepare(
    `UPDATE memories
     SET status = ?,
         info_json = ?,
         properties_json = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(input.memoryStatus, JSON.stringify(info), JSON.stringify(properties), new Date().toISOString(), policyId);
}

export function insertTracePolicyLinkForTest(db: MemoryDb, input: {
  userId: string;
  l1MemoryId: string;
  l2MemoryId: string;
}): void {
  db.db.prepare(
    `INSERT INTO trace_policy_links (
       id, user_id, l1_memory_id, l2_memory_id, relation, strength, created_at
     ) VALUES (?, ?, ?, ?, 'supports', 1, ?)`
  ).run(
    `link_${input.l1MemoryId}_${input.l2MemoryId}`,
    input.userId,
    input.l1MemoryId,
    input.l2MemoryId,
    new Date().toISOString()
  );
}

export function setSkillLifecycleForTest(db: MemoryDb, skillId: string, input: {
  eta: number;
  status: "candidate" | "active" | "archived";
  trialsAttempted: number;
  trialsPassed: number;
}): void {
  const row = db.db.prepare(
    `SELECT info_json, properties_json
     FROM memories
     WHERE id = ?`
  ).get(skillId) as { info_json: string; properties_json: string } | undefined;
  if (!row) {
    throw new Error(`skill not found: ${skillId}`);
  }
  const info = JSON.parse(row.info_json) as Record<string, unknown>;
  const properties = JSON.parse(row.properties_json) as {
    internal_info?: {
      skill?: Record<string, unknown>;
      procedure_json?: Record<string, unknown>;
    } & Record<string, unknown>;
  } & Record<string, unknown>;
  const memoryStatus = input.status === "archived"
    ? "archived"
    : input.status === "candidate"
    ? "resolving"
    : "activated";
  info.eta = input.eta;
  info.trials_attempted = input.trialsAttempted;
  info.trials_passed = input.trialsPassed;
  info.skill_status = input.status;
  properties.status = memoryStatus;
  properties.internal_info = properties.internal_info ?? {};
  properties.internal_info.status = input.status;
  properties.internal_info.eta = input.eta;
  properties.internal_info.trials_attempted = input.trialsAttempted;
  properties.internal_info.trials_passed = input.trialsPassed;
  properties.internal_info.skill = {
    ...(properties.internal_info.skill ?? {}),
    status: input.status,
    eta: input.eta,
    trials_attempted: input.trialsAttempted,
    trials_passed: input.trialsPassed
  };
  db.db.prepare(
    `UPDATE memories
     SET status = ?,
         info_json = ?,
         properties_json = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(memoryStatus, JSON.stringify(info), JSON.stringify(properties), new Date().toISOString(), skillId);
}
