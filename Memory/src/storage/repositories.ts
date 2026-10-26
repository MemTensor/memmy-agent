import { canonicalNamespaceKey, installDeviceScope, canonicalProjectId, refreshProjectAliases } from "./device-scope.js";
import type Database from "better-sqlite3";
import {
  canonicalJson,
  renderL3WorldModelFields,
  sha256Hex,
  type JsonValue,
  type L3WorldModelFieldName,
  type L3WorldModelFields,
  type L3WorldModelTraceHeadResponse,
  type WorkspaceUri
} from "../contracts/index.js";
import { retrievalDocumentForMemory } from "../algorithm/plugin-algorithms.js";
import { displayFieldsForMemory } from "../service/read-model/display-fields.js";
import type {
  ProjectEnvironmentKind,
  ProjectEnvironmentStateRecord
} from "../service/project-environment/types.js";
import type {
  FeedbackRequest,
  JobRef,
  JobStatus,
  JobType,
  MemoryFilter,
  MemoryKind,
  MemoryLayer,
  MemoryListItem,
  MemoryProcessingRecord,
  MemoryProcessingState,
  MemoryRow,
  MemoryStatsRow,
  MemoryStatus,
  RecallHit,
  SourceTurnCompleteResponse,
  UserMemoryRecord,
  UserMemoryStatus,
  UserMemoryType
} from "../types.js";
import { DEFAULT_NAMESPACE_SOURCE } from "../types.js";
import { agentSourceFamilyRoots, normalizeAgentIdKey } from "../utils/agent-source-id.js";
import { newId, stableHash } from "../utils/id.js";
import { asStringArray, parseJson, toJson } from "../utils/json.js";
import { firstSemanticUserLine } from "../utils/text.js";
import { nowIso } from "../utils/time.js";
import {
  attachMemoryVectors,
  dirtyMemoryVectorEntries,
  memoryVectorEntries as attachedMemoryVectorEntries,
  transferMemoryVectors,
  type MemoryVectorField,
  type MemoryVectorValue
} from "./memory-vector-state.js";
import {
  SqliteVecStore,
  VECTOR_SEARCH_WINDOW,
  type VectorSearchCandidate
} from "./sqlite-vec-store.js";
import { compactHistoryChangePayload, compactHistoryChangeRow } from "./history-change-snapshot.js";

type SqlValue = string | number | Buffer | null;
const BUNDLE_TABLES = [
  "memory_project_aliases",
  "memory_namespace_aliases",
  "memory_l3_overrides",
  "memories",
  "memory_capture_claims",
  "source_turn_captures",
  "l3_world_model_scopes",
  "user_memories",
  "sessions",
  "l3_world_model_session_cursors",
  "work_memory_session_cursors",
  "episodes",
  "raw_turns",
  "l3_world_model_input_traces",
  "feedback",
  "l3_world_model_evidence_batches",
  "l3_world_model_batch_targets",
  "decision_repairs",
  "l2_candidate_pool",
  "trace_policy_links",
  "skill_trials",
  "recall_events",
  "api_logs",
  "memory_change_log",
  "l3_world_model_project_environment_state",
  "evolution_jobs",
  "embedding_retry_queue",
  "memory_processing_state",
  "runtime_kv",
  "artifacts",
  "audit_logs"
] as const;
const CLEAR_MEMORY_TABLES = [
  ...BUNDLE_TABLES.filter((table) => table !== "source_turn_captures" && table !== "memory_project_aliases" && table !== "memory_namespace_aliases"),
  "memories_fts",
  "user_memories_fts",
  "memory_vector_entries",
  "idempotency_keys",
  "legacy_migration_ledger"
] as const;
type BundleTableName = typeof BUNDLE_TABLES[number];
const LOG_TABLE_RETENTION_LIMIT = 10_000;
const LOG_TABLE_RETENTION_ORDER = {
  api_logs: "called_at DESC, id DESC",
  memory_change_log: "seq DESC",
  audit_logs: "created_at DESC, id DESC"
} as const;
type LogTableName = keyof typeof LOG_TABLE_RETENTION_ORDER;

interface MemorySqlRow {
  id: string;
  timeline: string;
  user_id: string;
  conversation_id: string | null;
  session_id: string | null;
  agent_id: string | null;
  app_id: string | null;
  memory_type: string;
  status: MemoryStatus;
  visibility: string;
  memory_key: string | null;
  memory_value: string;
  tags_json: string;
  info_json: string;
  properties_json: string;
  memory_layer: MemoryLayer;
  content_hash: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface SessionRecord {
  id: string;
  userId: string | null;
  source: string;
  profileId: string;
  profileLabel?: string;
  projectId?: string;
  workspaceId?: string;
  workspacePath?: string;
  hostSessionKey?: string;
  conversationId?: string;
  status: "open" | "processing" | "closed";
  meta: Record<string, unknown>;
  openedAt: string;
  lastSeenAt?: string | null;
  closedAt?: string | null;
  updatedAt: string;
}

export interface EpisodeRecord {
  id: string;
  sessionId: string;
  userId: string | null;
  projectId?: string;
  conversationId?: string;
  status: "open" | "processing" | "closed";
  title?: string;
  summary?: string;
  l1MemoryIds: string[];
  rawTurnIds: string[];
  feedbackIds: string[];
  decisionRepairIds: string[];
  l2PolicyIds: string[];
  l3WorldModelIds: string[];
  skillMemoryIds: string[];
  turnCount: number;
  rTask?: number;
  rewardDetail: Record<string, unknown>;
  pipelineRunId?: string;
  pipelineStatus: "idle" | "running" | "succeeded" | "failed";
  pipelineError?: string;
  meta: Record<string, unknown>;
  openedAt: string;
  closedAt?: string | null;
  updatedAt: string;
}

export interface SkillClusterRecord {
  id: string;
  userId: string | null;
  projectId?: string;
  tools: string[];
  artifacts: string[];
  toolBigrams: string[];
  centroid: number[] | null;
  skillMemoryId?: string;
  metaSkillMd: string;
  processedEpisodeIds: string[];
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SkillClusterMemberRecord {
  clusterId: string;
  episodeId: string;
  outcome: "success" | "failure" | "unknown";
  rTask?: number;
  assignedAt: string;
}

export interface RawTurnRecord {
  id: string;
  sessionId: string;
  episodeId: string;
  turnId: string;
  userId: string | null;
  conversationId?: string;
  userText?: string;
  assistantText?: string;
  reasoningSummary?: string;
  toolCalls: unknown[];
  toolResults: unknown[];
  sourceMemoryIds: string[];
  usage: Record<string, unknown>;
  messagePayload?: Record<string, unknown>;
  status: string;
  redactedAt?: string | null;
  deletedAt?: string | null;
  createdAt: string;
}

export type MemoryCaptureClaimOrigin = "turn_complete" | "agent_source_scan";

export interface MemoryCaptureClaimRecord {
  userId: string | null;
  source: string;
  qaHash: string;
  primaryMemoryId: string;
  capturedBy: MemoryCaptureClaimOrigin;
  createdAt: string;
}

export interface FeedbackRecord {
  id: string;
  userId: string | null;
  projectId?: string;
  conversationId?: string;
  sessionId?: string;
  episodeId?: string;
  l1MemoryId?: string;
  rawTurnId?: string;
  channel: FeedbackRequest["channel"];
  polarity: FeedbackRequest["polarity"];
  magnitude: number;
  rationale?: string;
  rawPayload: unknown;
  contextHash?: string;
  createdAt: string;
}

export interface RecallEventRecord {
  id: string;
  namespaceId?: string;
  sessionId?: string;
  episodeId?: string;
  turnId?: string;
  userId: string | null;
  query: string;
  queryHash?: string;
  layers: MemoryLayer[];
  candidateMemoryIds?: string[];
  injectedMemoryIds?: string[];
  queryId?: string;
  userMemoryCandidateIds?: string[];
  l1CandidateIds?: string[];
  mergedSourceTurnIds?: string[];
  memberMemoryIdsBySourceTurnId?: Record<string, string[]>;
  hitMemoryIds: string[];
  dropped?: unknown[];
  outcome?: "pending" | "positive" | "negative" | "ignored";
  request: unknown;
  createdAt: string;
}

interface UserMemorySqlRow {
  id: string;
  source_turn_id: string;
  user_id: string;
  memory_types_json: string;
  content: string;
  normalized_user_text_hash: string;
  source_turn_refs_json: string;
  status: UserMemoryStatus;
  replaces_memory_id: string | null;
  replaced_by_memory_id: string | null;
  archived_at: string | null;
  archive_reason: string | null;
  embedding_json: string | null;
  embedding_model: string | null;
  embedding_provider: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ApiLogRecord {
  id: number;
  toolName: "memory_add" | "memory_search" | "skill_generate" | "skill_evolve";
  sourceAgent?: string;
  inputJson: string;
  outputJson: string;
  durationMs: number;
  success: boolean;
  calledAt: string;
}

export interface EvolutionJobRecord {
  id: string;
  jobType: JobType;
  status: JobStatus;
  dedupeKey?: string;
  userId: string | null;
  sessionId?: string;
  episodeId?: string;
  targetMemoryId?: string;
  scopeKey?: string;
  scopeSeq?: number;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  leasedUntil?: string | null;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type L3WorldModelBatchTrigger =
  | "new_task"
  | "token_compaction"
  | "token_compaction_attempt"
  | "session_close"
  | "episode_idle_close";

export type L3WorldModelTargetField = Exclude<L3WorldModelFieldName, "project_environment_profile">;

export interface L3WorldModelScopeRecord {
  scopeKey: string;
  userId: string | null;
  projectId?: string;
  workspaceUri?: WorkspaceUri;
  memoryId?: string;
  nextScopeSeq: number;
  updatedAt: string;
}

export interface L3WorldModelInputTraceRecord {
  sessionId: string;
  traceSeq: number;
  l1MemoryId: string;
  rawTurnId: string;
  episodeId?: string;
  createdAt: string;
}

export interface WorkMemorySessionCursorRecord {
  sessionId: string;
  lastExtractedSeq: number;
  updatedAt: string;
}

export interface L3WorldModelEvidenceBatchRecord {
  id: string;
  scopeKey: string;
  scopeSeq: number;
  userId: string | null;
  projectId?: string;
  sessionId: string;
  trigger: L3WorldModelBatchTrigger;
  startTraceSeq: number;
  endTraceSeq: number;
  l1MemoryIds: string[];
  rawTurnIds: string[];
  feedbackIds: string[];
  payloadHash: string;
  terminalOutcome?: "applied" | "partial_dead_letter" | "dead_letter";
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface L3WorldModelBatchTargetRecord {
  batchId: string;
  targetField: L3WorldModelTargetField;
  fieldScopeKey: string;
  scopeSeq: number;
  status: "queued" | "applied" | "dead_letter";
  noChange: boolean;
  appliedAt?: string;
  updatedAt: string;
}

export interface FreezeL3WorldModelBatchesResult {
  scheduled: boolean;
  throughL1MemoryId?: string;
  throughTraceSeq?: number;
  batchIds: string[];
  targetCount: number;
}

export type L3WorldModelTraceTargetOperation = "noop" | "create" | "update";

export interface ApplyL3WorldModelTraceTargetResult {
  alreadyApplied: boolean;
  noChange: boolean;
  memory?: MemoryRow;
}

export interface DeleteL3WorldModelScopeResult {
  before: MemoryRow;
  deleted: MemoryRow;
  scope: L3WorldModelScopeRecord;
}

export type EmbeddingRetryTargetKind = "trace" | "policy" | "world_model" | "skill";
export type EmbeddingRetryVectorField = MemoryVectorField;
export type EmbeddingRetryStatus = "pending" | "in_progress" | "failed" | "succeeded";

export interface MemorySearchIdHit {
  id: string;
  score: number;
  channel?: MemorySearchChannel;
}

export type MemorySearchChannel = EmbeddingRetryVectorField | "fts" | "pattern" | "structural";

export interface MemoryVectorSearchOptions {
  anyOfTags?: string[];
}

export interface EmbeddingRetryRecord {
  id: string;
  targetKind: EmbeddingRetryTargetKind;
  targetId: string;
  vectorField: EmbeddingRetryVectorField;
  sourceText: string;
  embedRole: "document" | "query";
  status: EmbeddingRetryStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: number;
  claimedBy?: string | null;
  leaseUntil?: number | null;
  lastError?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ChangeLogRecord {
  seq: number;
  memoryId: string;
  namespaceId?: string;
  kind?: string;
  op?: string;
  entityId?: string;
  userId: string | null;
  changeType: string;
  version?: number;
  before?: unknown;
  after?: unknown;
  source: string;
  createdAt: string;
}

export interface SkillTrialRecord {
  id: string;
  userId: string | null;
  projectId?: string;
  skillMemoryId: string;
  sessionId?: string;
  episodeId?: string;
  l1MemoryId?: string;
  rawTurnId?: string;
  turnId?: string;
  toolCallId?: string;
  status: "pending" | "pass" | "fail" | "unknown";
  outcome: "unknown" | "success" | "failure" | "cancelled";
  feedbackId?: string;
  createdAt: string;
  resolvedAt?: string | null;
}

export interface TracePolicyLinkRecord {
  id: string;
  userId: string | null;
  l1MemoryId: string;
  l2MemoryId: string;
  relation: string;
  strength: number;
  createdAt: string;
}

export interface DecisionRepairRecord {
  id: string;
  sessionId?: string;
  episodeId?: string;
  rawTurnId?: string;
  userId: string | null;
  projectId?: string;
  contextHash?: string;
  issue: string;
  suggestion: string;
  preference?: string;
  antiPattern?: string;
  highValueMemoryIds: string[];
  lowValueMemoryIds: string[];
  attachedPolicyMemoryIds: string[];
  feedbackId?: string;
  validated: boolean;
  source: unknown;
  meta: Record<string, unknown>;
  createdAt: string;
}

export interface CandidatePoolRecord {
  id: string;
  userId: string | null;
  sessionId?: string;
  sourceMemoryId: string;
  candidateKey: string;
  candidateValue: string;
  score: number;
  status: "pending" | "promoted" | "rejected";
  evidence: unknown;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string | null;
}

export interface AuditLogRecord {
  id: string;
  userId: string | null;
  sessionId?: string;
  actor: Record<string, unknown>;
  action: string;
  targetKind: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
  meta: Record<string, unknown>;
  createdAt: string;
}

interface SqlApiLogRow {
  id: number;
  tool_name: ApiLogRecord["toolName"];
  source_agent: string | null;
  input_json: string;
  output_json: string;
  duration_ms: number;
  success: number;
  called_at: string;
}

export class MemoryRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly vectors: SqliteVecStore
  ) {}

  insert(memory: MemoryRow): MemoryRow {
    memory = { ...memory, userId: null };
    const prepared = prepareMemoryForStorage(memory);
    this.db
      .prepare(
        `INSERT INTO memories (
          id, timeline, user_id, conversation_id, session_id, agent_id, app_id,
          memory_type, status, visibility, memory_key, memory_value,
          tags_json, info_json, properties_json, memory_layer, content_hash,
          version, created_at, updated_at, deleted_at
        ) VALUES (
          @id, @timeline, @userId, @conversationId, @sessionId, @agentId, @appId,
          @memoryType, @status, @visibility, @memoryKey, @memoryValue,
          @tagsJson, @infoJson, @propertiesJson, @memoryLayer, @contentHash,
          @version, @createdAt, @updatedAt, @deletedAt
        )`
      )
      .run(memoryToSql(prepared.memory));
    this.vectors.replace(prepared.memory.id, prepared.vectors, prepared.memory.updatedAt);
    this.reindexFts(prepared.memory);
    return attachMemoryVectors(prepared.memory, prepared.vectors);
  }

  update(memory: MemoryRow): MemoryRow {
    memory = { ...memory, userId: null };
    return this.updateRow(memory, true);
  }

  updateMaintenance(memory: MemoryRow): MemoryRow {
    return this.updateRow(memory, false);
  }

  private updateRow(memory: MemoryRow, bumpVersion: boolean): MemoryRow {
    const existing = this.get(memory.id);
    if (!existing) {
      throw new Error(`memory not found: ${memory.id}`);
    }
    const prepared = prepareMemoryForStorage(memory);
    const updated = {
      ...prepared.memory,
      version: bumpVersion ? memory.version + 1 : existing.version
    };
    this.db
      .prepare(
        `UPDATE memories
         SET timeline = @timeline,
             conversation_id = @conversationId,
             session_id = @sessionId,
             agent_id = @agentId,
             app_id = @appId,
             memory_type = @memoryType,
             status = @status,
             visibility = @visibility,
             memory_key = @memoryKey,
             memory_value = @memoryValue,
             tags_json = @tagsJson,
             info_json = @infoJson,
             properties_json = @propertiesJson,
             memory_layer = @memoryLayer,
             content_hash = @contentHash,
             version = @version,
             updated_at = @updatedAt,
             deleted_at = @deletedAt
         WHERE id = @id`
      )
      .run(memoryToSql(updated));
    const mergedVectors = mergeMemoryVectors(
      attachedMemoryVectorEntries(existing),
      prepared.vectorUpdates
    );
    if (updated.deletedAt || updated.status === "deleted") {
      this.vectors.deleteMemory(updated.id);
    } else if (prepared.vectorUpdates.length > 0) {
      for (const vector of prepared.vectorUpdates) {
        this.vectors.upsert(updated.id, vector, updated.updatedAt);
      }
    }
    this.reindexFts(updated);
    return attachMemoryVectors(updated, updated.deletedAt || updated.status === "deleted" ? [] : mergedVectors);
  }

  upsertByKey(memory: MemoryRow): {
    memory: MemoryRow;
    created: boolean;
    previous?: MemoryRow;
  } {
    const previous = memory.memoryKey
      ? this.getByKey(memory.memoryLayer, memory.memoryKey)
      : undefined;
    if (!previous) {
      return { memory: this.insert(memory), created: true };
    }

    const merged = {
      ...previous,
      timeline: memory.timeline,
      conversationId: memory.conversationId ?? previous.conversationId,
      sessionId: memory.sessionId ?? previous.sessionId,
      agentId: memory.agentId ?? previous.agentId,
      appId: memory.appId ?? previous.appId,
      status: memory.status,
      memoryValue: memory.memoryValue,
      tags: uniq([...previous.tags, ...memory.tags]),
      info: {
        ...previous.info,
        ...memory.info
      },
      properties: mergeProperties(previous.properties, memory.properties),
      contentHash: memory.contentHash,
      updatedAt: memory.updatedAt
    };
    transferMemoryVectors(memory, merged);

    return {
      memory: this.update(merged),
      created: false,
      previous
    };
  }

  deleteVector(memoryId: string, vectorField: MemoryVectorField): void {
    this.vectors.delete(memoryId, vectorField);
  }

  get(id: string): MemoryRow | undefined {
    const row = this.db
      .prepare(`SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL`)
      .get(id) as MemorySqlRow | undefined;
    return row ? this.hydrate(memoryFromSql(row, this.db)) : undefined;
  }

  getIncludingDeleted(id: string): MemoryRow | undefined {
    const row = this.db
      .prepare(`SELECT * FROM memories WHERE id = ?`)
      .get(id) as MemorySqlRow | undefined;
    return row ? this.hydrate(memoryFromSql(row, this.db)) : undefined;
  }

  listTaskSpanIds(episodeId: string, sourceTraceIds: string[]): string[] {
    // Parent traces may already be soft-deleted, and their span_ids only describe
    // the latest split. Use the spans' own ownership links for task deletion.
    const rows = this.db.prepare(
      `SELECT id FROM memories
       WHERE memory_layer = 'L1'
         AND deleted_at IS NULL AND status != 'deleted'
         AND json_extract(properties_json, '$.internal_info.memory_kind') = 'span'
         AND json_extract(properties_json, '$.internal_info.span.episode_id') = ?
         AND json_extract(properties_json, '$.internal_info.span.source_trace_id')
           IN (SELECT value FROM json_each(?))
       ORDER BY id`
    ).all(episodeId, JSON.stringify(sourceTraceIds)) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  getByKey(memoryLayer: MemoryLayer, key: string): MemoryRow | undefined {
    const row = this.db
      .prepare(
        `SELECT *
         FROM memories
         WHERE memory_layer = ?
           AND memory_key = ?
           AND deleted_at IS NULL
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(memoryLayer, key) as MemorySqlRow | undefined;
    return row ? this.hydrate(memoryFromSql(row, this.db)) : undefined;
  }

  getByKeyIncludingDeleted(memoryLayer: MemoryLayer, key: string): MemoryRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM memories
         WHERE memory_layer = ? AND memory_key = ?
         ORDER BY updated_at DESC, id DESC LIMIT 1`
      )
      .get(memoryLayer, key) as MemorySqlRow | undefined;
    return row ? this.hydrate(memoryFromSql(row, this.db)) : undefined;
  }

  listMemoryTags(ids: readonly string[]): string[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db.prepare(`
      SELECT tags_json, info_json, properties_json
      FROM memories
      WHERE id IN (${placeholders}) AND deleted_at IS NULL AND status != 'deleted'
    `).all(...ids) as Array<{ tags_json: string; info_json: string; properties_json: string }>;
    return uniq(rows.flatMap((row) => {
      const info = parseJson<Record<string, unknown>>(row.info_json, {});
      const properties = parseJson<Record<string, unknown>>(row.properties_json, {});
      return [
        ...asStringArray(parseJson(row.tags_json, [])),
        ...asStringArray(info.tags),
        ...asStringArray(properties.tags)
      ];
    }));
  }

  listUserMemoriesByKeyIncludingDeleted(userId: string | null, memoryKey: string): MemoryRow[] {
    const rows = this.db.prepare(`
      SELECT * FROM memories
      WHERE memory_layer = 'L1' AND memory_key = ?
      ORDER BY updated_at DESC, id DESC
    `).all(memoryKey) as MemorySqlRow[];
    return rows.map((row) => this.hydrate(memoryFromSql(row, this.db)));
  }

  archivePriorReadOnlySkillVersions(input: {
    sourceAgentId: string;
    sourceSkillIdentity: string;
    currentMemoryId: string;
    at: string;
  }): MemoryRow[] {
    const rows = this.db.prepare(
      `SELECT * FROM memories
       WHERE memory_layer = 'Skill'
         AND id != ?
         AND deleted_at IS NULL
         AND status IN ('activated', 'resolving')
         AND json_extract(properties_json, '$.internal_info.read_only') = 1
         AND json_extract(properties_json, '$.internal_info.source_agent_id') = ?
         AND COALESCE(
           json_extract(properties_json, '$.internal_info.source_skill_id'),
           json_extract(properties_json, '$.internal_info.source_skill_path')
         ) = ?`
    ).all(
      input.currentMemoryId,
      input.sourceAgentId,
      input.sourceSkillIdentity
    ) as MemorySqlRow[];
    return rows.map((row) => {
      const memory = this.hydrate(memoryFromSql(row, this.db));
      const internalSkill = isRecordLike(memory.properties.internal_info.skill)
        ? memory.properties.internal_info.skill
        : {};
      return this.update({
        ...memory,
        status: "archived",
        properties: {
          ...memory.properties,
          status: "archived",
          internal_info: {
            ...memory.properties.internal_info,
            superseded_by_skill_id: input.currentMemoryId,
            skill: { ...internalSkill, status: "archived" }
          }
        },
        updatedAt: input.at
      });
    });
  }

  getMany(ids: string[]): MemoryRow[] {
    if (ids.length === 0) {
      return [];
    }
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE id IN (${placeholders}) AND deleted_at IS NULL`)
      .all(...ids) as MemorySqlRow[];
    const vectors = this.vectors.getMany(rows.map((row) => row.id));
    const byId = new Map(rows.map((row) => {
      const memory = memoryFromSql(row, this.db);
      attachMemoryVectors(memory, vectors.get(row.id) ?? []);
      return [row.id, memory];
    }));
    return ids.map((id) => byId.get(id)).filter((row): row is MemoryRow => Boolean(row));
  }

  list(filter: MemoryFilter = {}, limit = 50, offset = 0): MemoryRow[] {
    const built = buildMemoryWhere(filter);
    const rows = this.db
      .prepare(
        `SELECT *
         FROM memories
         WHERE ${built.where}
         ORDER BY created_at DESC, updated_at DESC, id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...built.params, limit, offset) as MemorySqlRow[];
    return this.hydrateMany(rows.map((row) => memoryFromSql(row, this.db)));
  }

  listStats(): MemoryStatsRow[] {
    const rows = this.db
      .prepare(
        `SELECT conversation_id,
                session_id,
                agent_id,
                app_id,
                status,
                memory_layer,
                created_at,
                updated_at,
                ${memoryDisplayedSourceSql("json_extract(info_json, '$.source')")} AS info_source,
                json_extract(properties_json, '$.internal_info.source') AS internal_source
         FROM memories
         WHERE deleted_at IS NULL`
      )
      .all() as Array<{
        conversation_id: string | null;
        session_id: string | null;
        agent_id: string | null;
        app_id: string | null;
        status: MemoryStatus;
        memory_layer: MemoryLayer;
        created_at: string;
        updated_at: string;
        info_source: unknown;
        internal_source: unknown;
      }>;
    return rows.map((row) => ({
      conversationId: row.conversation_id ?? undefined,
      sessionId: row.session_id ?? undefined,
      agentId: row.agent_id ?? undefined,
      appId: row.app_id ?? undefined,
      status: row.status,
      memoryLayer: row.memory_layer,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      infoSource: row.info_source,
      internalSource: row.internal_source
    }));
  }

  listPendingAgentSourceImportSummaries(limit = 10000, targetMemoryIds?: readonly string[]): MemoryRow[] {
    if (targetMemoryIds && targetMemoryIds.length === 0) return [];
    const targetClause = targetMemoryIds
      ? `AND memories.id IN (${targetMemoryIds.map(() => "?").join(", ")})`
      : "";
    const rows = this.db
      .prepare(
        `SELECT *
         FROM memories
         WHERE deleted_at IS NULL
           AND status != 'deleted'
           AND memory_layer = 'L1'
           ${targetClause}
           AND (
             json_extract(properties_json, '$.internal_info.plugin_algorithm') LIKE 'memory.add.import_async.%'
             OR EXISTS (
               SELECT 1 FROM json_each(memories.tags_json)
               WHERE lower(json_each.value) = 'agent-source'
             )
           )
           AND EXISTS (
             SELECT 1 FROM memory_processing_state
             WHERE memory_processing_state.memory_id = memories.id
               AND memory_processing_state.state = 'summary_pending'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM evolution_jobs
             WHERE evolution_jobs.target_memory_id = memories.id
               AND evolution_jobs.job_type = 'import_summary'
               AND evolution_jobs.status IN ('queued', 'leased')
               AND json_extract(evolution_jobs.payload_json, '$.contentHash') = memories.content_hash
           )
         ORDER BY created_at DESC, updated_at DESC, id DESC
         LIMIT ?`
      )
      .all(...(targetMemoryIds ?? []), limit) as MemorySqlRow[];
    return this.hydrateMany(rows.map((row) => memoryFromSql(row, this.db)));
  }

  listUnprocessedAgentSourceImports(limit = 10000): MemoryRow[] {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM memories
         WHERE deleted_at IS NULL
           AND status != 'deleted'
           AND memory_layer = 'L1'
           AND (
             json_extract(properties_json, '$.internal_info.plugin_algorithm') LIKE 'memory.add.import_async.%'
             OR EXISTS (
               SELECT 1 FROM json_each(memories.tags_json)
               WHERE lower(json_each.value) = 'agent-source'
             )
           )
           AND EXISTS (
             SELECT 1 FROM memory_processing_state
             WHERE memory_processing_state.memory_id = memories.id
               AND memory_processing_state.state IN (
                 'summary_pending', 'summarizing', 'embedding_pending', 'embedding'
               )
           )
         ORDER BY created_at DESC, updated_at DESC, id DESC
         LIMIT ?`
      )
      .all(limit) as MemorySqlRow[];
    return this.hydrateMany(rows.map((row) => memoryFromSql(row, this.db)));
  }

  listImportMemoriesNeedingSummary(limit = 10000): MemoryRow[] {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM memories
         WHERE deleted_at IS NULL
           AND status != 'deleted'
           AND memory_layer = 'L1'
           AND (
             json_extract(properties_json, '$.internal_info.plugin_algorithm') LIKE 'memory.add.import_async.%'
             OR EXISTS (
               SELECT 1 FROM json_each(memories.tags_json)
               WHERE lower(json_each.value) = 'agent-source'
             )
           )
           AND LOWER(TRIM(COALESCE(
             json_extract(properties_json, '$.internal_info.trace.summary'),
             json_extract(info_json, '$.summary'),
             json_extract(properties_json, '$.internal_info.summary'),
             ''
           ))) IN ('user', 'assistant', 'system', 'tool', 'developer', '摘要排队中', '摘要整理中', '摘要总结中')
         ORDER BY created_at DESC, updated_at DESC, id DESC
         LIMIT ?`
      )
      .all(limit) as MemorySqlRow[];
    return this.hydrateMany(rows.map((row) => memoryFromSql(row, this.db)));
  }

  /** Bounded, idempotent upgrade pass; deleted observations never re-enter processing. */
  listUnprocessedObservations(limit = 100): MemoryRow[] {
    const rows = this.db.prepare(`SELECT * FROM memories
      WHERE deleted_at IS NULL AND status = 'activated' AND memory_layer = 'L1'
        AND json_extract(properties_json, '$.internal_info.memory_kind') = 'observed_activity'
        AND json_type(properties_json, '$.internal_info.external_evidence') = 'object'
        AND COALESCE(json_extract(properties_json, '$.internal_info.observation_memory.schema_version'), 0) < 1
      ORDER BY created_at DESC, id DESC LIMIT ?`).all(Math.min(Math.max(limit, 0), 1000)) as MemorySqlRow[];
    return this.hydrateMany(rows.map((row) => memoryFromSql(row, this.db)));
  }

  listUnindexedL1Imports(limit = 10000): MemoryRow[] {
    const rows = this.db
      .prepare(
        `SELECT memories.*
         FROM memories
         WHERE memories.deleted_at IS NULL
           AND memories.status != 'deleted'
           AND memories.memory_layer = 'L1'
           AND (
             json_extract(memories.properties_json, '$.internal_info.plugin_algorithm') LIKE 'memory.add.import_async.%'
             OR EXISTS (
               SELECT 1 FROM json_each(memories.tags_json)
               WHERE lower(json_each.value) = 'agent-source'
             )
           )
           AND EXISTS (
             SELECT 1 FROM memory_processing_state
             WHERE memory_processing_state.memory_id = memories.id
               AND memory_processing_state.state = 'embedding_pending'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM memory_vector_entries
             WHERE memory_vector_entries.memory_id = memories.id
               AND memory_vector_entries.vector_field = 'vec_summary'
           )
         ORDER BY memories.updated_at ASC, memories.id ASC
         LIMIT ?`
      )
      .all(limit) as MemorySqlRow[];
    return this.hydrateMany(rows.map((row) => memoryFromSql(row, this.db)));
  }

  count(filter: MemoryFilter = {}): number {
    const built = buildMemoryWhere(filter);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM memories
         WHERE ${built.where}`
      )
      .get(...built.params) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  search(query: string, filter: MemoryFilter = {}, limit = 8, offset = 0): RecallHit[] {
    const built = buildMemoryWhere({
      ...filter,
      status: filter.status ?? ["activated", "resolving"]
    });
    const poolLimit = Math.min(Math.max(limit + offset, limit), 500);
    const rows = this.db
      .prepare(
        `SELECT *
         FROM memories
         WHERE ${built.where}
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(...built.params, poolLimit) as MemorySqlRow[];

    const tagFilter = filter.tags?.map((tag) => tag.toLowerCase()) ?? [];
    const scored = rows
      .map((row) => memoryFromSql(row, this.db))
      .filter((memory) =>
        tagFilter.length === 0
          ? true
          : tagFilter.every((tag) => memory.tags.some((candidate) => candidate.toLowerCase() === tag))
      )
      .map((memory) => ({
        memory,
        score: scoreMemory(query, memory)
      }))
      .filter((item) => query.trim().length === 0 || item.score > 0)
      .sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt));

    return scored.slice(offset, offset + limit).map(({ memory, score }) => ({
      id: memory.id,
      kind: kindFromMemory(memory),
      memoryLayer: memory.memoryLayer,
      status: memory.status,
      title: listTitleForMemory(memory),
      snippet: snippetForQuery(memory.memoryValue, query),
      score,
      tags: memory.tags,
      updatedAt: memory.updatedAt,
      source: memory.memoryLayer === "Skill" ? "skill" : "search"
    }));
  }

  searchPanelIds(query: string, filter: MemoryFilter = {}, limit = 20, offset = 0): MemorySearchIdHit[] {
    const built = buildMemoryWhere({
      ...filter,
      status: filter.status ?? ["activated", "resolving"]
    });
    const searchBuilt = buildMemorySearchWhere(query, true);
    if (!searchBuilt.where || limit <= 0) {
      return [];
    }

    const rows = this.db
      .prepare(
        `SELECT memories.id AS id
         FROM memories
         WHERE ${built.where}
           AND (${searchBuilt.where})
         ORDER BY memories.updated_at DESC, memories.id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...built.params, ...searchBuilt.params, limit, offset) as Array<{ id: string }>;
    return rows.map((row, index) => ({ id: row.id, score: 1 / (offset + index + 1) }));
  }

  searchCount(query: string, filter: MemoryFilter = {}): number {
    const built = buildMemoryWhere({
      ...filter,
      status: filter.status ?? ["activated", "resolving"]
    });
    const needles = searchNeedles(query);
    if (needles.length === 0) {
      return this.count(filter);
    }
    const searchBuilt = buildMemorySearchWhere(query, true);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM memories
         WHERE ${built.where}
           AND (${searchBuilt.where})`
      )
      .get(...built.params, ...searchBuilt.params) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  searchVectorIds(
    query: number[],
    vectorField: EmbeddingRetryVectorField,
    filter: MemoryFilter = {},
    limit = 20,
    options: MemoryVectorSearchOptions = {}
  ): MemorySearchIdHit[] {
    if (query.length === 0 || limit <= 0) return [];
    const built = buildMemoryWhere({
      ...filter,
      status: filter.status ?? ["activated", "resolving"]
    });
    const anyTag = buildAnyTagWhere(options.anyOfTags);
    const candidateWindow = VECTOR_SEARCH_WINDOW;
    const rows = this.db
      .prepare(
        `SELECT memories.id AS id,
                memory_vector_entries.id AS vector_id,
                memory_vector_entries.embedding_dim AS embedding_dim
         FROM memory_vector_entries
         JOIN memories ON memories.id = memory_vector_entries.memory_id
         WHERE ${built.where}
           AND memory_vector_entries.vector_field = ?
           ${anyTag.where ? `AND ${anyTag.where}` : ""}
         ORDER BY memory_vector_entries.updated_at DESC, memory_vector_entries.id DESC
         LIMIT ?`
      )
      .all(...built.params, vectorField, ...anyTag.params, candidateWindow) as Array<{
        id: string;
        vector_id: number;
        embedding_dim: number;
      }>;
    const candidates: VectorSearchCandidate[] = rows.map((row) => ({
      id: row.vector_id,
      memoryId: row.id,
      embeddingDim: row.embedding_dim
    }));
    return this.vectors.search(query, candidates, limit).map((hit) => ({
      ...hit,
      channel: vectorField
    }));
  }

  hasVectorRows(filter: MemoryFilter = {}): boolean {
    const built = buildMemoryWhere({
      ...filter,
      status: filter.status ?? ["activated", "resolving"]
    });
    const row = this.db
      .prepare(
        `SELECT 1 AS ok
         FROM memory_vector_entries
         JOIN memories ON memories.id = memory_vector_entries.memory_id
         WHERE ${built.where}
         LIMIT 1`
      )
      .get(...built.params) as { ok: number } | undefined;
    return Boolean(row);
  }

  hasVector(memoryId: string, vectorField: MemoryVectorField = "vec_summary"): boolean {
    const row = this.db.prepare(
      `SELECT 1 AS ok
       FROM memory_vector_entries
       WHERE memory_id = ? AND vector_field = ?
       LIMIT 1`
    ).get(memoryId, vectorField) as { ok: number } | undefined;
    return Boolean(row);
  }

  searchFtsIds(ftsMatch: string | null | undefined, filter: MemoryFilter = {}, limit = 20): MemorySearchIdHit[] {
    if (!ftsMatch || limit <= 0) return [];
    const built = buildMemoryWhere({
      ...filter,
      status: filter.status ?? ["activated", "resolving"]
    });
    try {
      const rows = this.db
        .prepare(
          `SELECT memories.id AS id
           FROM memories_fts
           JOIN memories ON memories.id = memories_fts.id
           WHERE ${built.where}
             AND memories_fts MATCH ?
           ORDER BY rank
           LIMIT ?`
        )
        .all(...built.params, ftsMatch, limit) as Array<{ id: string }>;
      return rows.map((row, index) => ({ id: row.id, score: 1 / (index + 1), channel: "fts" }));
    } catch {
      return [];
    }
  }

  searchPatternIds(terms: string[], filter: MemoryFilter = {}, limit = 20): MemorySearchIdHit[] {
    return this.searchLikeIds(terms, filter, limit, true, "pattern");
  }

  searchStructuralIds(fragments: string[], filter: MemoryFilter = {}, limit = 20): MemorySearchIdHit[] {
    return this.searchLikeIds(fragments, filter, limit, false, "structural");
  }

  archive(id: string, updatedAt = nowIso()): MemoryRow | undefined {
    const memory = this.get(id);
    if (!memory) {
      return undefined;
    }
    return this.update({
      ...memory,
      status: "archived",
      properties: {
        ...memory.properties,
        status: "archived"
      },
      updatedAt
    });
  }

  /** Native source identity, never text alone, defines historical L1 duplicates. */
  nativeDuplicates(memory: MemoryRow): { ids: string[]; deleted: boolean } {
    const fallback = {ids: [memory.id], deleted: Boolean(memory.deletedAt)};
    if (memory.memoryLayer !== "L1" || memory.properties.internal_info.memory_kind === "work_memory" || !memory.sessionId) return fallback;
    const session = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(memory.sessionId) as SqlSessionRow | undefined;
    if (!session?.conversation_id) return fallback;
    const trace = memory.properties.internal_info.trace as Record<string, unknown> | undefined;
    const turn = memory.info.turn_id ?? trace?.turn_id;
    if (typeof turn !== "string" || !turn) return fallback;
    const meta = parseJson<Record<string, unknown>>(session.meta_json, {});
    const tenantId = meta.tenant_id ?? meta.tenantId ?? null;
    const namespaceKey = stableHash({tenantId, projectId:canonicalProjectId(this.db,session.project_id),
      workspaceId:canonicalProjectId(this.db,session.workspace_id)});
    const sourceNamespaceKey = typeof meta.source_namespace_key === "string"
      ? canonicalNamespaceKey(this.db,meta.source_namespace_key) : namespaceKey;
    const rows = this.db.prepare(`SELECT m.id, m.deleted_at, m.status
      FROM memories m JOIN sessions s ON s.id = m.session_id
      WHERE m.memory_layer = 'L1' AND s.source = ? AND s.profile_id = ? AND s.conversation_id = ?
        AND memory_project_id(s.project_id) IS memory_project_id(?)
        AND memory_project_id(s.workspace_id) IS memory_project_id(?)
        AND COALESCE(json_extract(s.meta_json, '$.tenant_id'), json_extract(s.meta_json, '$.tenantId'), '') = ?
        AND COALESCE(memory_namespace_key(json_extract(s.meta_json, '$.source_namespace_key')), ?) = ?
        AND COALESCE(json_extract(m.info_json, '$.turn_id'), json_extract(m.properties_json, '$.internal_info.trace.turn_id')) = ?
        AND (json_extract(m.properties_json, '$.internal_info.trace.step_index') = ?
          OR (? IS NULL AND json_extract(m.properties_json, '$.internal_info.trace.step_index') IS NULL
            AND m.content_hash IS ? AND m.memory_value = ?))
        AND COALESCE(json_extract(m.properties_json, '$.internal_info.memory_kind'), 'trace') = ?
      ORDER BY m.created_at, m.id`).all(session.source, session.profile_id, session.conversation_id,
        session.project_id, session.workspace_id,
        tenantId ?? "", namespaceKey, sourceNamespaceKey,
        turn, typeof trace?.step_index === "number" ? trace.step_index : null,
        typeof trace?.step_index === "number" ? trace.step_index : null, memory.contentHash ?? null, memory.memoryValue,
        memory.properties.internal_info.memory_kind ?? "trace") as Array<{id: string; deleted_at: string | null; status: string}>;
    return {ids: rows.map(row => row.id), deleted: rows.some(row => row.deleted_at || row.status === "deleted")};
  }

  softDelete(id: string, deletedAt = nowIso()): MemoryRow | undefined {
    const memory = this.get(id);
    if (!memory) {
      return undefined;
    }
    return this.update({
      ...memory,
      status: "deleted",
      properties: {
        ...memory.properties,
        status: "deleted"
      },
      deletedAt,
      updatedAt: deletedAt
    });
  }

  countByLayer(userId?: string | null): Record<MemoryLayer, number> {
    void userId;
    const rows = this.db
      .prepare(
        `SELECT memory_layer AS layer, COUNT(*) AS count
         FROM memories
         WHERE deleted_at IS NULL
           AND status != 'deleted'
         GROUP BY memory_layer`
      )
      .all() as Array<{ layer: MemoryLayer; count: number }>;
    return {
      L1: Number(rows.find((row) => row.layer === "L1")?.count ?? 0),
      L2: Number(rows.find((row) => row.layer === "L2")?.count ?? 0),
      L3: Number(rows.find((row) => row.layer === "L3")?.count ?? 0),
      Skill: Number(rows.find((row) => row.layer === "Skill")?.count ?? 0)
    };
  }

  countByStatus(userId?: string | null): Record<MemoryStatus, number> {
    void userId;
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS count
         FROM memories
         WHERE deleted_at IS NULL
         GROUP BY status`
      )
      .all() as Array<{ status: MemoryStatus; count: number }>;
    return {
      activated: Number(rows.find((row) => row.status === "activated")?.count ?? 0),
      resolving: Number(rows.find((row) => row.status === "resolving")?.count ?? 0),
      archived: Number(rows.find((row) => row.status === "archived")?.count ?? 0),
      deleted: Number(rows.find((row) => row.status === "deleted")?.count ?? 0)
    };
  }

  toListItem(memory: MemoryRow): MemoryListItem {
    return {
      id: memory.id,
      kind: kindFromMemory(memory),
      memoryLayer: memory.memoryLayer,
      status: memory.status,
      title: listTitleForMemory(memory),
      summary: listSummaryForMemory(memory),
      tags: memory.tags,
      metrics: listMetricsForMemory(memory),
      ...displayFieldsForMemory(memory),
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
      version: memory.version
    };
  }

  reindexFts(memory: MemoryRow): void {
    try {
      this.db.prepare(`DELETE FROM memories_fts WHERE id = ?`).run(memory.id);
      if (!memory.deletedAt && memory.status !== "deleted") {
        this.db
          .prepare(`INSERT INTO memories_fts (id, identifier, memory_value, tags) VALUES (?, ?, ?, ?)`)
          .run(memory.id, memory.id, retrievalDocumentForMemory(memory), memory.tags.join(" "));
      }
    } catch {
      // The service search path is deterministic JS scoring; FTS is maintained
      // opportunistically for future cloud/local parity and should not block writes.
    }
  }

  private hydrate(memory: MemoryRow): MemoryRow {
    return attachMemoryVectors(memory, this.vectors.getMany([memory.id]).get(memory.id) ?? []);
  }

  private hydrateMany(memories: MemoryRow[]): MemoryRow[] {
    const vectors = this.vectors.getMany(memories.map((memory) => memory.id));
    return memories.map((memory) => attachMemoryVectors(memory, vectors.get(memory.id) ?? []));
  }

  private searchLikeIds(
    terms: string[],
    filter: MemoryFilter,
    limit: number,
    includeTags: boolean,
    channel: "pattern" | "structural"
  ): MemorySearchIdHit[] {
    const normalized = terms
      .map((term) => term.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 16);
    if (normalized.length === 0 || limit <= 0) return [];
    const built = buildMemoryWhere({
      ...filter,
      status: filter.status ?? ["activated", "resolving"]
    });
    const termColumns = normalized.map((term) => likeColumnsForTerm(term, includeTags));
    const clauses = termColumns.map((columns) => `(${columns.join(" OR ")})`);
    const params = normalized.flatMap((term, index) => {
      const pattern = `%${escapeLikePattern(term)}%`;
      return termColumns[index]!.map(() => pattern);
    });
    const rows = this.db
      .prepare(
        `SELECT memories.id AS id
         FROM memories
         WHERE ${built.where}
           AND (${clauses.join(" OR ")})
         ORDER BY memories.updated_at DESC, memories.id DESC
         LIMIT ?`
      )
      .all(...built.params, ...params, limit) as Array<{ id: string }>;
    return rows.map((row, index) => ({ id: row.id, score: 1 / (index + 1), channel }));
  }
}

export class MemoryCaptureClaimRepository {
  constructor(private readonly db: Database.Database) {}

  claim(input: MemoryCaptureClaimRecord): {
    claimed: boolean;
    claim: MemoryCaptureClaimRecord;
  } {
    return this.db.transaction(() => {
      const existing = this.get(null, input.source, input.qaHash);
      if (existing) return { claimed: false, claim: existing };
      this.db.prepare(`INSERT INTO memory_capture_claims (
        user_id, source, qa_hash, primary_memory_id, captured_by, created_at
      ) VALUES (NULL, ?, ?, ?, ?, ?)`)
        .run(input.source, input.qaHash, input.primaryMemoryId, input.capturedBy, input.createdAt);
      return { claimed: true, claim: { ...input, userId: null } };
    })();
  }

  get(userId: string | null, source: string, qaHash: string): MemoryCaptureClaimRecord | undefined {
    const row = this.db.prepare(
      `SELECT user_id, source, qa_hash, primary_memory_id, captured_by, created_at
       FROM memory_capture_claims
       WHERE source = ? AND qa_hash = ? ORDER BY created_at, primary_memory_id LIMIT 1`
    ).get(source, qaHash) as {
      user_id: string;
      source: string;
      qa_hash: string;
      primary_memory_id: string;
      captured_by: MemoryCaptureClaimOrigin;
      created_at: string;
    } | undefined;
    return row ? {
      userId: null,
      source: row.source,
      qaHash: row.qa_hash,
      primaryMemoryId: row.primary_memory_id,
      capturedBy: row.captured_by,
      createdAt: row.created_at
    } : undefined;
  }
}

// Historical equal-text UserMemory rows remain on disk. Corrections/deletions
// suppress older copies; a genuinely new expression after the tombstone may be stored.
const ACTIVE_USER_MEMORY_VIEW_SQL = `
  NOT EXISTS (SELECT 1 FROM user_memories tombstone
    WHERE tombstone.normalized_user_text_hash = user_memories.normalized_user_text_hash
      AND (tombstone.deleted_at IS NOT NULL OR tombstone.replaced_by_memory_id IS NOT NULL)
      AND tombstone.updated_at >= user_memories.created_at)
  AND NOT EXISTS (SELECT 1 FROM user_memories earlier
    WHERE earlier.normalized_user_text_hash = user_memories.normalized_user_text_hash
      AND earlier.status = 'active' AND earlier.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM user_memories tombstone
        WHERE tombstone.normalized_user_text_hash = earlier.normalized_user_text_hash
          AND (tombstone.deleted_at IS NOT NULL OR tombstone.replaced_by_memory_id IS NOT NULL)
          AND tombstone.updated_at >= earlier.created_at)
      AND (earlier.created_at < user_memories.created_at OR
        (earlier.created_at = user_memories.created_at AND earlier.id < user_memories.id)))`;

export class UserMemoryRepository {
  constructor(private readonly db: Database.Database) {}

  upsertExact(memory: UserMemoryRecord): {
    memory: UserMemoryRecord;
    created: boolean;
    previous?: UserMemoryRecord;
  } {
    const previous = this.getActiveByNormalizedText(memory.userId, memory.normalizedUserTextHash);
    if (!previous) return { memory: this.insert(memory), created: true };
    const updated = this.update({
      ...previous,
      memoryTypes: uniq([...previous.memoryTypes, ...memory.memoryTypes]),
      sourceTurnRefs: uniq([...previous.sourceTurnRefs, ...memory.sourceTurnRefs]),
      updatedAt: Date.parse(memory.updatedAt) > Date.parse(previous.updatedAt)
        ? memory.updatedAt
        : previous.updatedAt
    });
    return { memory: updated, created: false, previous };
  }

  confirmExisting(input: {
    id: string;
    userId: string | null;
    sourceTurnId: string;
    memoryTypes: UserMemoryType[];
    updatedAt: string;
  }): { memory: UserMemoryRecord; previous: UserMemoryRecord } | undefined {
    const previous = this.get(input.id);
    if (!previous || previous.status !== "active") return undefined;
    const memory = this.update({
      ...previous,
      memoryTypes: uniq([...previous.memoryTypes, ...input.memoryTypes]),
      sourceTurnRefs: uniq([...previous.sourceTurnRefs, input.sourceTurnId]),
      updatedAt: Date.parse(input.updatedAt) > Date.parse(previous.updatedAt)
        ? input.updatedAt
        : previous.updatedAt
    });
    return { memory, previous };
  }

  insert(memory: UserMemoryRecord): UserMemoryRecord {
    memory = { ...memory, userId: null };
    this.db.prepare(
      `INSERT INTO user_memories (
         id, source_turn_id, user_id, memory_types_json, content,
         normalized_user_text_hash, source_turn_refs_json, status,
         replaces_memory_id, replaced_by_memory_id, archived_at, archive_reason,
         embedding_json, embedding_model, embedding_provider,
         created_at, updated_at, deleted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      memory.id, memory.sourceTurnId, null, toJson(memory.memoryTypes), memory.content,
      memory.normalizedUserTextHash, toJson(memory.sourceTurnRefs), memory.status,
      memory.replacesMemoryId ?? null, memory.replacedByMemoryId ?? null,
      memory.archivedAt ?? null, memory.archiveReason ?? null,
      memory.embedding ? toJson(memory.embedding) : null,
      memory.embeddingModel ?? null, memory.embeddingProvider ?? null,
      memory.createdAt, memory.updatedAt, memory.deletedAt ?? null
    );
    this.reindexFts(memory);
    return memory;
  }

  update(memory: UserMemoryRecord): UserMemoryRecord {
    memory = { ...memory, userId: null };
    this.db.prepare(
      `UPDATE user_memories SET
         source_turn_id = ?, memory_types_json = ?, content = ?,
         normalized_user_text_hash = ?, source_turn_refs_json = ?, status = ?,
         replaces_memory_id = ?, replaced_by_memory_id = ?, archived_at = ?, archive_reason = ?,
         embedding_json = ?, embedding_model = ?, embedding_provider = ?,
         updated_at = ?, deleted_at = ?
       WHERE id = ?`
    ).run(
      memory.sourceTurnId, toJson(memory.memoryTypes), memory.content,
      memory.normalizedUserTextHash, toJson(memory.sourceTurnRefs), memory.status,
      memory.replacesMemoryId ?? null, memory.replacedByMemoryId ?? null,
      memory.archivedAt ?? null, memory.archiveReason ?? null,
      memory.embedding ? toJson(memory.embedding) : null,
      memory.embeddingModel ?? null, memory.embeddingProvider ?? null,
      memory.updatedAt, memory.deletedAt ?? null, memory.id
    );
    this.reindexFts(memory);
    return memory;
  }

  get(id: string): UserMemoryRecord | undefined {
    const row = this.db.prepare(
      `SELECT * FROM user_memories WHERE id = ? AND deleted_at IS NULL`
    ).get(id) as UserMemorySqlRow | undefined;
    return row ? userMemoryFromSql(row) : undefined;
  }

  getIncludingDeleted(id: string): UserMemoryRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM user_memories WHERE id = ?`)
      .get(id) as UserMemorySqlRow | undefined;
    return row ? userMemoryFromSql(row) : undefined;
  }

  getMany(ids: readonly string[]): UserMemoryRecord[] {
    if (ids.length === 0) return [];
    const rows = this.db.prepare(
      `SELECT * FROM user_memories
       WHERE id IN (SELECT CAST(value AS TEXT) FROM json_each(?)) AND deleted_at IS NULL`
    ).all(toJson(ids)) as UserMemorySqlRow[];
    const byId = new Map(rows.map((row) => [row.id, userMemoryFromSql(row)]));
    return ids.map((id) => byId.get(id)).filter((item): item is UserMemoryRecord => Boolean(item));
  }

  listActive(userId: string | null, limit = 2000): UserMemoryRecord[] {
    return (this.db.prepare(
      `SELECT * FROM user_memories
       WHERE status = 'active' AND deleted_at IS NULL AND ${ACTIVE_USER_MEMORY_VIEW_SQL}
       ORDER BY updated_at DESC, id DESC LIMIT ?`
    ).all(limit) as UserMemorySqlRow[]).map(userMemoryFromSql);
  }

  listForPanel(input: {
    userId: string | null;
    status?: UserMemoryStatus;
    query?: string;
    sourceAgent?: string;
    limit: number;
    offset: number;
  }): UserMemoryRecord[] {
    const { where, params } = userMemoryPanelFilter(input);
    return (this.db.prepare(
      `SELECT * FROM user_memories
       WHERE ${where}
       ORDER BY updated_at DESC, id DESC
       LIMIT ? OFFSET ?`
    ).all(...params, input.limit, input.offset) as UserMemorySqlRow[]).map(userMemoryFromSql);
  }

  countForPanel(input: {
    userId: string | null;
    status?: UserMemoryStatus;
    query?: string;
    sourceAgent?: string;
  }): number {
    const { where, params } = userMemoryPanelFilter(input);
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM user_memories WHERE ${where}`)
      .get(...params) as { count: number };
    return row.count;
  }

  embeddingDimensionCounts(userId: string | null): {
    totalSlots: number;
    dimensions: Array<{ dimension: number; count: number }>;
  } {
    const where = `status = 'active' AND deleted_at IS NULL AND ${ACTIVE_USER_MEMORY_VIEW_SQL}`;
    const totalSlots = Number(this.db.prepare(
      `SELECT COUNT(*) FROM user_memories WHERE ${where}`
    ).pluck().get() ?? 0);
    const dimensions = this.db.prepare(
      `SELECT json_array_length(embedding_json) AS dimension, COUNT(*) AS count
       FROM user_memories
       WHERE ${where} AND embedding_json IS NOT NULL
       GROUP BY json_array_length(embedding_json)
       ORDER BY count DESC, dimension DESC`
    ).all() as Array<{ dimension: number; count: number }>;
    return { totalSlots, dimensions };
  }

  getActiveByNormalizedText(userId: string | null, hash: string): UserMemoryRecord | undefined {
    const row = this.db.prepare(
      `SELECT * FROM user_memories
       WHERE normalized_user_text_hash = ?
         AND status = 'active' AND deleted_at IS NULL AND ${ACTIVE_USER_MEMORY_VIEW_SQL}
       ORDER BY updated_at DESC, id DESC LIMIT 1`
    ).get(hash) as UserMemorySqlRow | undefined;
    return row ? userMemoryFromSql(row) : undefined;
  }

  archiveForCorrection(id: string, replacementId: string, at: string): UserMemoryRecord | undefined {
    const memory = this.get(id);
    if (!memory || memory.status !== "active") return undefined;
    return this.update({
      ...memory,
      status: "archived",
      archivedAt: at,
      archiveReason: "user_correction",
      replacedByMemoryId: replacementId,
      updatedAt: at
    });
  }

  softDelete(id: string, at = nowIso()): UserMemoryRecord | undefined {
    const memory = this.get(id);
    return memory
      ? this.update({
          ...memory,
          memoryTypes: [],
          content: "[DELETED]",
          sourceTurnRefs: [],
          status: "deleted",
          embedding: undefined,
          embeddingModel: undefined,
          embeddingProvider: undefined,
          deletedAt: at,
          updatedAt: at
        })
      : undefined;
  }

  updateEmbedding(
    id: string,
    embedding: number[],
    input: { model?: string; provider?: string; updatedAt: string }
  ): UserMemoryRecord | undefined {
    const memory = this.get(id);
    return memory ? this.update({
      ...memory,
      embedding,
      embeddingModel: input.model,
      embeddingProvider: input.provider,
      // updatedAt describes the latest user expression, not background indexing.
      updatedAt: memory.updatedAt
    }) : undefined;
  }

  searchFtsIds(userId: string | null, ftsMatch: string | undefined | null, limit: number): MemorySearchIdHit[] {
    if (!ftsMatch || limit <= 0) return [];
    try {
      const rows = this.db.prepare(
        `SELECT user_memories.id AS id
         FROM user_memories_fts
         JOIN user_memories ON user_memories.id = user_memories_fts.id
         WHERE user_memories.status = 'active'
           AND user_memories.deleted_at IS NULL AND ${ACTIVE_USER_MEMORY_VIEW_SQL}
           AND user_memories_fts MATCH ?
         ORDER BY rank LIMIT ?`
      ).all(ftsMatch, limit) as Array<{ id: string }>;
      return rows.map((row, index) => ({ id: row.id, score: 1 / (index + 1), channel: "fts" }));
    } catch {
      return [];
    }
  }

  searchPatternIds(userId: string | null, terms: readonly string[], limit: number): MemorySearchIdHit[] {
    const normalized = terms.map((term) => term.trim().toLowerCase()).filter(Boolean).slice(0, 16);
    if (normalized.length === 0 || limit <= 0) return [];
    const clauses = normalized.map(() => `lower(content) LIKE ? ESCAPE '\\'`);
    const rows = this.db.prepare(
      `SELECT id FROM user_memories
       WHERE status = 'active' AND deleted_at IS NULL AND ${ACTIVE_USER_MEMORY_VIEW_SQL}
         AND (${clauses.join(" OR ")})
       ORDER BY updated_at DESC, id DESC LIMIT ?`
    ).all(...normalized.map((term) => `%${escapeLikePattern(term)}%`), limit) as Array<{ id: string }>;
    return rows.map((row, index) => ({ id: row.id, score: 1 / (index + 1), channel: "pattern" }));
  }

  searchVectorIds(userId: string | null, query: readonly number[], limit: number): MemorySearchIdHit[] {
    if (query.length === 0 || limit <= 0) return [];
    return this.listActive(userId)
      .flatMap((memory) => memory.embedding?.length === query.length
        ? [{ id: memory.id, score: cosineVectors(query, memory.embedding), channel: "vec" as const }]
        : [])
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, limit);
  }

  private reindexFts(memory: UserMemoryRecord): void {
    this.db.prepare(`DELETE FROM user_memories_fts WHERE id = ?`).run(memory.id);
    if (memory.status === "active" && !memory.deletedAt) {
      this.db.prepare(
        `INSERT INTO user_memories_fts (id, content, memory_types) VALUES (?, ?, ?)`
      ).run(memory.id, memory.content, memory.memoryTypes.join(" "));
    }
  }
}

// A first attempt waiting in the queue has not failed; only a job that already
// recorded an error and still has attempts left is an automatic retry.
const AUTO_RETRY_SCHEDULED_SQL = `EXISTS(
                SELECT 1 FROM evolution_jobs
                WHERE evolution_jobs.id = memory_processing_state.active_job_id
                  AND evolution_jobs.status IN ('failed', 'queued')
                  AND evolution_jobs.last_error IS NOT NULL
                  AND evolution_jobs.attempts < evolution_jobs.max_attempts
              ) AS auto_retry_scheduled`;

export class MemoryProcessingRepository {
  constructor(private readonly db: Database.Database) {}

  get(memoryId: string): MemoryProcessingRecord | undefined {
    const row = this.db.prepare(
      `SELECT memory_processing_state.*,
              ${AUTO_RETRY_SCHEDULED_SQL}
       FROM memory_processing_state
       WHERE memory_id = ?`
    ).get(memoryId) as SqlMemoryProcessingRow | undefined;
    return row ? memoryProcessingFromSql(row) : undefined;
  }

  getMany(memoryIds: readonly string[]): MemoryProcessingRecord[] {
    if (memoryIds.length === 0) return [];
    const placeholders = memoryIds.map(() => "?").join(", ");
    const rows = this.db.prepare(
      `SELECT memory_processing_state.*,
              ${AUTO_RETRY_SCHEDULED_SQL}
       FROM memory_processing_state
       WHERE memory_id IN (${placeholders})`
    ).all(...memoryIds) as SqlMemoryProcessingRow[];
    const byId = new Map(rows.map((row) => [row.memory_id, memoryProcessingFromSql(row)]));
    return memoryIds
      .map((memoryId) => byId.get(memoryId))
      .filter((record): record is MemoryProcessingRecord => Boolean(record));
  }

  listByStates(states: readonly MemoryProcessingState[], limit = 10000): MemoryProcessingRecord[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => "?").join(", ");
    return (this.db.prepare(
      `SELECT memory_processing_state.*,
              ${AUTO_RETRY_SCHEDULED_SQL}
       FROM memory_processing_state
       WHERE state IN (${placeholders})
       ORDER BY updated_at ASC, memory_id ASC
       LIMIT ?`
    ).all(...states, limit) as SqlMemoryProcessingRow[]).map(memoryProcessingFromSql);
  }

  save(record: MemoryProcessingRecord): MemoryProcessingRecord {
    const { autoRetryScheduled: _derived, ...storedRecord } = record;
    this.db.prepare(
      `INSERT INTO memory_processing_state (
         memory_id, state, stage, active_job_id, attempt_count, manual_retry_count,
         retry_action, error_code, error_message, failed_at, updated_at
       ) VALUES (
         @memoryId, @state, @stage, @activeJobId, @attemptCount, @manualRetryCount,
         @retryAction, @errorCode, @errorMessage, @failedAt, @updatedAt
       )
       ON CONFLICT(memory_id) DO UPDATE SET
         state = excluded.state,
         stage = excluded.stage,
         active_job_id = excluded.active_job_id,
         attempt_count = excluded.attempt_count,
         manual_retry_count = excluded.manual_retry_count,
         retry_action = excluded.retry_action,
         error_code = excluded.error_code,
         error_message = excluded.error_message,
         failed_at = excluded.failed_at,
         updated_at = excluded.updated_at`
    ).run({
      ...storedRecord,
      stage: storedRecord.stage ?? null,
      activeJobId: storedRecord.activeJobId ?? null,
      errorCode: storedRecord.errorCode ?? null,
      errorMessage: storedRecord.errorMessage ?? null,
      failedAt: storedRecord.failedAt ?? null
    });
    return this.get(record.memoryId) ?? record;
  }

  update(
    memoryId: string,
    patch: Partial<Omit<MemoryProcessingRecord, "memoryId">>,
    expectedStates?: readonly MemoryProcessingState[]
  ): MemoryProcessingRecord | undefined {
    const current = this.get(memoryId);
    if (!current || (expectedStates && !expectedStates.includes(current.state))) return undefined;
    return this.save({ ...current, ...patch, memoryId });
  }

  delete(memoryId: string): boolean {
    return this.db.prepare(`DELETE FROM memory_processing_state WHERE memory_id = ?`).run(memoryId).changes > 0;
  }
}

export interface SourceTurnCaptureScope {
  userId: string | null;
  source: string;
  profileId: string;
  namespaceKey: string;
  conversationId: string;
}

export interface SourceTurnCaptureRecord extends SourceTurnCaptureScope {
  turnId: string;
  contentHash: string;
  sessionId?: string;
  episodeId?: string;
  rawTurnId?: string;
  response: SourceTurnCompleteResponse;
  startedAt: string;
  completedAt: string;
  sequence?: number;
  createdAt: string;
}

function sourceTurnCaptureFromSql(row: Record<string, unknown>): SourceTurnCaptureRecord {
  return {
    userId: null, source: String(row.source), profileId: String(row.profile_id),
    namespaceKey: String(row.namespace_key), conversationId: String(row.conversation_id), turnId: String(row.turn_id),
    contentHash: String(row.content_hash), sessionId: typeof row.session_id === "string" ? row.session_id : undefined,
    episodeId: typeof row.episode_id === "string" ? row.episode_id : undefined,
    rawTurnId: typeof row.raw_turn_id === "string" ? row.raw_turn_id : undefined,
    response: parseJson(String(row.response_json), { status: "pending", reason: "source_capture_response_missing" }),
    startedAt: String(row.started_at), completedAt: String(row.completed_at),
    sequence: typeof row.source_sequence === "number" ? row.source_sequence : undefined,
    createdAt: String(row.created_at)
  };
}

export class RuntimeRepository {
  private readonly scheduledLogPrunes = new Set<LogTableName>();
  private historyLogCompactionScheduled = false;
  private historyLogCompactionCursor = 0;

  constructor(private readonly db: Database.Database) {
    this.scheduleHistoryLogCompaction();
  }

  /** Update payloads in bounded batches; IDs, versions and sync cursors never move. */
  private scheduleHistoryLogCompaction(reset = false): void {
    if (reset) this.historyLogCompactionCursor = 0;
    if (this.historyLogCompactionScheduled || !this.db.open || this.db.readonly) return;
    this.historyLogCompactionScheduled = true;
    setImmediate(() => {
      this.historyLogCompactionScheduled = false;
      if (!this.db.open || this.db.readonly) return;
      try {
        const rows = this.db.prepare(
          `SELECT seq, before_json, after_json FROM memory_change_log WHERE seq > ? ORDER BY seq LIMIT 200`
        ).all(this.historyLogCompactionCursor) as Array<Record<string, unknown> & { seq: number }>;
        const update = this.db.prepare(`UPDATE memory_change_log SET before_json = ?, after_json = ?
          WHERE seq = ? AND before_json IS ? AND after_json IS ?`);
        this.db.transaction(() => {
          for (const row of rows) {
            const compact = compactHistoryChangeRow(row);
            if (compact !== row) update.run(compact.before_json, compact.after_json, row.seq, row.before_json, row.after_json);
          }
        })();
        if (rows.length) this.historyLogCompactionCursor = rows[rows.length - 1]!.seq;
        if (rows.length === 200) this.scheduleHistoryLogCompaction();
      } catch {
        // Best-effort maintenance must not interfere with capture or worker writes.
        // An interrupted pass is retried on the next service start.
      }
    });
  }

  getKv(key: string): { value: unknown; updatedAt: string } | undefined {
    const row = this.db
      .prepare(`SELECT value_json, updated_at FROM runtime_kv WHERE key = ?`)
      .get(key) as { value_json: string; updated_at: string } | undefined;
    return row
      ? { value: parseJson(row.value_json, undefined), updatedAt: row.updated_at }
      : undefined;
  }

  setKv(key: string, value: unknown, at = nowIso()): void {
    this.db
      .prepare(
        `INSERT INTO runtime_kv (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`
      )
      .run(key, toJson(value), at);
  }

  listKv(prefix: string, limit = 200): Array<{ key: string; value: unknown; updatedAt: string }> {
    const rows = this.db
      .prepare(`SELECT key, value_json, updated_at FROM runtime_kv WHERE key LIKE ? ORDER BY updated_at DESC LIMIT ?`)
      .all(`${prefix}%`, Math.max(1, Math.min(limit, 1_000))) as Array<{
        key: string;
        value_json: string;
        updated_at: string;
      }>;
    return rows.map((row) => ({
      key: row.key,
      value: parseJson(row.value_json, undefined),
      updatedAt: row.updated_at
    }));
  }

  // userId is capture provenance. It must not partition the same local native turn
  // when an installed Hook and the desktop scanner submit under different accounts.
  getSourceTurnCapture(scope: SourceTurnCaptureScope, turnId: string): SourceTurnCaptureRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM source_turn_captures
      WHERE source = @source AND profile_id = @profileId
        AND memory_namespace_key(namespace_key) = memory_namespace_key(@namespaceKey) AND conversation_id = @conversationId AND turn_id = @turnId
      ORDER BY created_at ASC, raw_turn_id ASC LIMIT 1`
    ).get({ ...scope, turnId }) as Record<string, unknown> | undefined;
    return row ? sourceTurnCaptureFromSql(row) : undefined;
  }

  latestSourceTurnCapture(scope: SourceTurnCaptureScope): SourceTurnCaptureRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM source_turn_captures
      WHERE source = @source AND profile_id = @profileId
        AND memory_namespace_key(namespace_key) = memory_namespace_key(@namespaceKey) AND conversation_id = @conversationId AND session_id IS NOT NULL
      ORDER BY completed_at DESC, source_sequence DESC LIMIT 1`
    ).get(scope) as Record<string, unknown> | undefined;
    return row ? sourceTurnCaptureFromSql(row) : undefined;
  }

  sourceTurnCaptureNeighbors(scope: SourceTurnCaptureScope, startedAt: string): {
    before?: SourceTurnCaptureRecord;
    after?: SourceTurnCaptureRecord;
  } {
    const prefix = `SELECT * FROM source_turn_captures
      WHERE source = @source AND profile_id = @profileId
        AND memory_namespace_key(namespace_key) = memory_namespace_key(@namespaceKey) AND conversation_id = @conversationId AND session_id IS NOT NULL`;
    const before = this.db.prepare(`${prefix} AND started_at < @startedAt ORDER BY started_at DESC LIMIT 1`)
      .get({ ...scope, startedAt }) as Record<string, unknown> | undefined;
    const after = this.db.prepare(`${prefix} AND started_at > @startedAt ORDER BY started_at ASC LIMIT 1`)
      .get({ ...scope, startedAt }) as Record<string, unknown> | undefined;
    return { before: before ? sourceTurnCaptureFromSql(before) : undefined,
      after: after ? sourceTurnCaptureFromSql(after) : undefined };
  }

  insertSourceTurnCapture(capture: SourceTurnCaptureRecord): void {
    this.db.prepare(`INSERT INTO source_turn_captures (
      user_id, source, profile_id, namespace_key, conversation_id, turn_id, content_hash,
      session_id, episode_id, raw_turn_id, response_json, started_at, completed_at, source_sequence, created_at
    ) VALUES (@userId, @source, @profileId, @namespaceKey, @conversationId, @turnId, @contentHash,
      @sessionId, @episodeId, @rawTurnId, @responseJson, @startedAt, @completedAt, @sequence, @createdAt)`
    ).run({ ...capture, userId: null, sessionId: capture.sessionId ?? null, episodeId: capture.episodeId ?? null,
      rawTurnId: capture.rawTurnId ?? null, responseJson: toJson(capture.response), sequence: capture.sequence ?? null });
  }

  orderEpisodeTurnsBySourceTime(episodeId: string): void {
    const episode = this.getEpisode(episodeId);
    if (!episode) throw new Error(`episode not found: ${episodeId}`);
    const rawTimes = new Map(episode.rawTurnIds.map((id) => [id, this.getRawTurn(id)?.createdAt ?? ""]));
    const rawTurnIds = [...episode.rawTurnIds].sort((a, b) => rawTimes.get(a)!.localeCompare(rawTimes.get(b)!));
    const memoryTime = this.db.prepare(`SELECT created_at,
      COALESCE(json_extract(info_json, '$.raw_turn_id'), json_extract(properties_json, '$.internal_info.raw_turn_id')) AS raw_turn_id
      FROM memories WHERE id = ?`);
    const memoryTimes = new Map(episode.l1MemoryIds.map((id) => {
      const row = memoryTime.get(id) as { created_at: string; raw_turn_id: string | null } | undefined;
      return [id, rawTimes.get(row?.raw_turn_id ?? "") ?? row?.created_at ?? ""];
    }));
    const l1MemoryIds = [...episode.l1MemoryIds].sort((a, b) => memoryTimes.get(a)!.localeCompare(memoryTimes.get(b)!));
    this.db.prepare(`UPDATE episodes SET raw_turn_ids_json = ?, l1_memory_ids_json = ? WHERE id = ?`)
      .run(toJson(rawTurnIds), toJson(l1MemoryIds), episodeId);
  }

  sourceConversationSessions(input: { userId?: string | null; source: string; profileId: string; conversationId: string }): SessionRecord[] {
    return (this.db.prepare(`SELECT * FROM sessions WHERE source = @source
      AND profile_id = @profileId AND (host_session_key = @conversationId OR conversation_id = @conversationId
        OR host_session_key = @source || '-memory-' || @conversationId)
      ORDER BY opened_at DESC`).all(input) as SqlSessionRow[]).map((row) => sessionFromSql(row, this.db));
  }

  bindSessionSourceConversation(id: string, conversationId: string): boolean {
    const result = this.db.prepare(`UPDATE sessions SET conversation_id = @conversationId
      WHERE id = @id AND status = 'open' AND (conversation_id IS NULL OR conversation_id = '')`)
      .run({ id, conversationId });
    return result.changes === 1;
  }

  bindRawTurnSourceConversation(
    scope: Pick<RawTurnRecord, "id" | "sessionId" | "userId" | "turnId">,
    conversationId: string
  ): boolean {
    const result = this.db.prepare(`UPDATE raw_turns SET conversation_id = @conversationId
      WHERE id = @id AND session_id = @sessionId AND turn_id = @turnId
        AND (conversation_id IS NULL OR conversation_id = '' OR conversation_id = @conversationId)`)
      .run({ ...scope, conversationId });
    return result.changes === 1;
  }

  createSession(session: SessionRecord): SessionRecord {
    session = { ...session, userId: null };
    this.db
      .prepare(
        `INSERT INTO sessions (
          id, user_id, project_id, source, profile_id, profile_label, workspace_id,
          workspace_path, host_session_key, conversation_id, status, meta_json,
          opened_at, last_seen_at, closed_at, updated_at
        ) VALUES (
          @id, @userId, @projectId, @source, @profileId, @profileLabel, @workspaceId,
          @workspacePath, @hostSessionKey, @conversationId, @status, @metaJson,
          @openedAt, @lastSeenAt, @closedAt, @updatedAt
        )`
      )
      .run({
        ...session,
        userId: null,
        profileLabel: session.profileLabel ?? null,
        projectId: session.projectId ?? null,
        workspaceId: session.workspaceId ?? null,
        workspacePath: session.workspacePath ?? null,
        hostSessionKey: session.hostSessionKey ?? null,
        conversationId: session.conversationId ?? null,
        metaJson: toJson(session.meta),
        lastSeenAt: session.lastSeenAt ?? session.updatedAt,
        closedAt: session.closedAt ?? null
      });
    return session;
  }

  getSession(id: string): SessionRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE id = ?`)
      .get(id) as SqlSessionRow | undefined;
    return row ? sessionFromSql(row, this.db) : undefined;
  }

  findOpenSessionByHostKey(input: {
    userId: string | null;
    source: string;
    profileId: string;
    hostSessionKey: string;
    projectId?: string | null;
  }): SessionRecord | undefined {
    const rows = this.db.prepare(`SELECT * FROM sessions
      WHERE source = ? AND profile_id = ? AND host_session_key = ? AND status = 'open'
      ORDER BY opened_at ASC, id ASC`)
      .all(input.source,input.profileId,input.hostSessionKey) as SqlSessionRow[];
    const candidates = rows.map(row => sessionFromSql(row,this.db)).filter(session =>
      input.projectId === undefined || (session.projectId ?? null) === canonicalProjectId(this.db,input.projectId));
    if (new Set(candidates.map(session=>session.projectId ?? "")).size > 1) return undefined;
    return candidates[0];
  }

  updateSessionScope(
    id: string,
    scope: Partial<Pick<SessionRecord, "source" | "profileId" | "projectId" | "workspaceId" | "workspacePath">>,
    at = nowIso()
  ): SessionRecord | undefined {
    const existing = this.getSession(id);
    if (!existing) {
      return undefined;
    }
    const updated: SessionRecord = {
      ...existing,
      source: scope.source ?? existing.source,
      profileId: scope.profileId ?? existing.profileId,
      projectId: scope.projectId ?? existing.projectId,
      workspaceId: scope.workspaceId ?? existing.workspaceId,
      workspacePath: scope.workspacePath ?? existing.workspacePath,
      lastSeenAt: at,
      updatedAt: at
    };
    this.db
      .prepare(
        `UPDATE sessions
         SET source = @source,
             profile_id = @profileId,
             project_id = @projectId,
             workspace_id = @workspaceId,
             workspace_path = @workspacePath,
             last_seen_at = @lastSeenAt,
             updated_at = @updatedAt
         WHERE id = @id`
      )
      .run({
        id: updated.id,
        source: updated.source,
        profileId: updated.profileId,
        projectId: updated.projectId ?? null,
        workspaceId: updated.workspaceId ?? null,
        workspacePath: updated.workspacePath ?? null,
        lastSeenAt: updated.lastSeenAt ?? at,
        updatedAt: updated.updatedAt
      });
    return this.getSession(id);
  }

  updateSessionMeta(
    id: string,
    patch: Record<string, unknown>,
    at = nowIso()
  ): SessionRecord | undefined {
    const existing = this.getSession(id);
    if (!existing) return undefined;
    this.db.prepare(
      `UPDATE sessions SET meta_json = ?, updated_at = ? WHERE id = ?`
    ).run(toJson({ ...existing.meta, ...patch }), at, id);
    return this.getSession(id);
  }

  closeSession(id: string, at = nowIso()): SessionRecord | undefined {
    this.db
      .prepare(
        `UPDATE sessions
         SET status = 'closed', closed_at = ?, last_seen_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(at, at, at, id);
    return this.getSession(id);
  }

  touchSession(id: string, at = nowIso()): SessionRecord | undefined {
    this.db
      .prepare(
        `UPDATE sessions
         SET last_seen_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(at, at, id);
    return this.getSession(id);
  }

  listEpisodesForSession(sessionId: string): EpisodeRecord[] {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM episodes
         WHERE session_id = ?
         ORDER BY updated_at DESC`
      )
      .all(sessionId) as SqlEpisodeRow[];
    return rows.map((row) => episodeFromSql(row, this.db));
  }

  listIdleEpisodes(
    excludeEpisodeId: string | undefined,
    inactiveBefore: string
  ): EpisodeRecord[] {
    const clauses = [
      "episodes.status != 'closed'",
      `MAX(
        episodes.updated_at,
        COALESCE(
          (SELECT MAX(MAX(
             raw_turns.created_at,
             COALESCE(
               json_extract(raw_turns.message_payload_json, '$.turn_complete.completed_at'),
               raw_turns.created_at
             ),
             COALESCE(
               json_extract(raw_turns.message_payload_json, '$.last_observation.observed_at'),
               raw_turns.created_at
             )
           ))
           FROM raw_turns
           WHERE raw_turns.episode_id = episodes.id),
          episodes.opened_at
        )
      ) < ?`
    ];
    const params: SqlValue[] = [inactiveBefore];
    if (excludeEpisodeId) {
      clauses.push("episodes.id != ?");
      params.push(excludeEpisodeId);
    }
    const rows = this.db
      .prepare(
        `SELECT episodes.*
         FROM episodes
         WHERE ${clauses.join("\n           AND ")}
         ORDER BY episodes.opened_at ASC, episodes.id ASC`
      )
      .all(...params) as SqlEpisodeRow[];
    return rows.map((row) => episodeFromSql(row, this.db));
  }

  closeOpenEpisodesForSession(sessionId: string, at = nowIso()): EpisodeRecord[] {
    const rows = this.listEpisodesForSession(sessionId)
      .filter((episode) => episode.status !== "closed");
    this.db
      .prepare(
        `UPDATE episodes
         SET status = 'closed',
             closed_at = COALESCE(closed_at, ?),
             updated_at = ?
         WHERE session_id = ?
           AND status != 'closed'`
      )
      .run(at, at, sessionId);
    return rows.map((episode) => ({
      ...episode,
        userId: null,
      status: "closed" as const,
      closedAt: episode.closedAt ?? at,
      updatedAt: at
    }));
  }

  closeEpisode(episodeId: string, metaPatch: Record<string, unknown> = {}, at = nowIso()): EpisodeRecord | undefined {
    const episode = this.getEpisode(episodeId);
    if (!episode) return undefined;
    const meta = {
      ...episode.meta,
      ...metaPatch
    };
    const result = this.db
      .prepare(
        `UPDATE episodes
         SET status = 'closed',
             closed_at = COALESCE(closed_at, ?),
             meta_json = ?,
             updated_at = ?
         WHERE id = ?
           AND status != 'closed'`
      )
      .run(at, toJson(meta), at, episodeId);
    if (result.changes === 0) return undefined;
    return {
      ...episode,
        userId: null,
      status: "closed",
      closedAt: episode.closedAt ?? at,
      meta,
      updatedAt: at
    };
  }

  reopenEpisode(episodeId: string, metaPatch: Record<string, unknown> = {}, at = nowIso()): EpisodeRecord | undefined {
    const episode = this.getEpisode(episodeId);
    if (!episode) return undefined;
    const { reward: _staleReward, ...baseMeta } = episode.meta;
    const meta = {
      ...baseMeta,
      ...metaPatch
    };
    this.db
      .prepare(
        `UPDATE episodes
         SET status = 'open',
             closed_at = NULL,
             r_task = NULL,
             reward_detail_json = '{}',
             meta_json = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(toJson(meta), at, episodeId);
    return {
      ...episode,
        userId: null,
      status: "open",
      closedAt: null,
      rTask: undefined,
      rewardDetail: {},
      meta,
      updatedAt: at
    };
  }

  countEpisodesByStatus(userId?: string | null): Record<"open" | "processing" | "closed", number> {
    void userId;
    const clauses = ["1=1"];
    const params: SqlValue[] = [];
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS count
         FROM episodes
         WHERE ${clauses.join(" AND ")}
         GROUP BY status`
      )
      .all(...params) as Array<{ status: string; count: number }>;
    const counts = { open: 0, processing: 0, closed: 0 };
    for (const row of rows) {
      if (row.status === "open" || row.status === "processing" || row.status === "closed") {
        counts[row.status] = row.count;
      }
    }
    return counts;
  }

  countEpisodes(userId?: string | null, query?: string, sourceAgent?: string): number {
    const built = buildEpisodeWhere(userId, query, sourceAgent);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM episodes
         WHERE ${built.where}`
      )
      .get(...built.params) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  listEpisodes(userId?: string | null, limit = 50, offset = 0, query?: string, sourceAgent?: string): EpisodeRecord[] {
    const built = buildEpisodeWhere(userId, query, sourceAgent);
    const rows = this.db
      .prepare(
        `SELECT *
         FROM episodes
         WHERE ${built.where}
         ORDER BY opened_at DESC, updated_at DESC, id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...built.params, limit, offset) as SqlEpisodeRow[];
    return rows.map((row) => episodeFromSql(row, this.db));
  }

  deleteEpisode(id: string): boolean {
    const result = this.db.prepare("DELETE FROM episodes WHERE id = ?").run(id);
    return result.changes === 1;
  }

  createEpisode(episode: EpisodeRecord): EpisodeRecord {
    episode = { ...episode, userId: null };
    this.db
      .prepare(
        `INSERT INTO episodes (
          id, session_id, user_id, project_id, conversation_id, status, title, summary,
          l1_memory_ids_json, raw_turn_ids_json, feedback_ids_json,
          decision_repair_ids_json, l2_policy_ids_json, l3_world_model_ids_json,
          skill_memory_ids_json, turn_count, r_task, reward_detail_json,
          pipeline_run_id, pipeline_status, pipeline_error, meta_json,
          opened_at, closed_at, updated_at
        ) VALUES (
          @id, @sessionId, @userId, @projectId, @conversationId, @status, @title, @summary,
          @l1MemoryIdsJson, @rawTurnIdsJson, @feedbackIdsJson,
          @decisionRepairIdsJson, @l2PolicyIdsJson, @l3WorldModelIdsJson,
          @skillMemoryIdsJson, @turnCount, @rTask, @rewardDetailJson,
          @pipelineRunId, @pipelineStatus, @pipelineError, @metaJson,
          @openedAt, @closedAt, @updatedAt
        )`
      )
      .run({
        ...episode,
        userId: null,
        projectId: episode.projectId ?? null,
        conversationId: episode.conversationId ?? null,
        title: episode.title ?? null,
        summary: episode.summary ?? null,
        l1MemoryIdsJson: toJson(episode.l1MemoryIds),
        rawTurnIdsJson: toJson(episode.rawTurnIds),
        feedbackIdsJson: toJson(episode.feedbackIds),
        decisionRepairIdsJson: toJson(episode.decisionRepairIds),
        l2PolicyIdsJson: toJson(episode.l2PolicyIds),
        l3WorldModelIdsJson: toJson(episode.l3WorldModelIds),
        skillMemoryIdsJson: toJson(episode.skillMemoryIds),
        turnCount: episode.turnCount,
        rTask: episode.rTask ?? null,
        rewardDetailJson: toJson(episode.rewardDetail),
        pipelineRunId: episode.pipelineRunId ?? null,
        pipelineStatus: episode.pipelineStatus,
        pipelineError: episode.pipelineError ?? null,
        metaJson: toJson(episode.meta),
        closedAt: episode.closedAt ?? null
      });
    return episode;
  }

  getEpisode(id: string): EpisodeRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM episodes WHERE id = ?`)
      .get(id) as SqlEpisodeRow | undefined;
    return row ? episodeFromSql(row, this.db) : undefined;
  }

  updateEpisodeMeta(episodeId: string, patch: Record<string, unknown>, at = nowIso()): EpisodeRecord | undefined {
    const episode = this.getEpisode(episodeId);
    if (!episode) return undefined;
    const meta = {
      ...episode.meta,
      ...patch
    };
    this.db
      .prepare(
        `UPDATE episodes
         SET meta_json = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(toJson(meta), at, episodeId);
    return {
      ...episode,
        userId: null,
      meta,
      updatedAt: at
    };
  }

  updateEpisodeTitle(
    episodeId: string,
    input: { title: string; summary: string; meta?: Record<string, unknown> },
    at = nowIso()
  ): EpisodeRecord | undefined {
    const episode = this.getEpisode(episodeId);
    if (!episode) return undefined;
    const meta = input.meta ? { ...episode.meta, ...input.meta } : episode.meta;
    this.db
      .prepare(
        `UPDATE episodes
         SET title = ?,
             summary = ?,
             meta_json = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(input.title, input.summary, toJson(meta), at, episodeId);
    return {
      ...episode,
        userId: null,
      title: input.title,
      summary: input.summary,
      meta,
      updatedAt: at
    };
  }

  latestEpisodeForSession(sessionId: string): EpisodeRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT *
         FROM episodes
         WHERE session_id = ?
         ORDER BY
           CASE status
             WHEN 'open' THEN 0
             WHEN 'processing' THEN 1
             ELSE 2
           END,
           updated_at DESC,
           opened_at DESC,
           rowid DESC
         LIMIT 1`
      )
      .get(sessionId) as SqlEpisodeRow | undefined;
    return row ? episodeFromSql(row, this.db) : undefined;
  }

  appendEpisodeTurn(episodeId: string, rawTurnId: string, l1MemoryId: string, at = nowIso()): EpisodeRecord {
    const episode = this.getEpisode(episodeId);
    if (!episode) {
      throw new Error(`episode not found: ${episodeId}`);
    }
    const rawTurnIds = uniq([...episode.rawTurnIds, rawTurnId]);
    const l1MemoryIds = uniq([...episode.l1MemoryIds, l1MemoryId]);
    this.db
      .prepare(
        `UPDATE episodes
         SET raw_turn_ids_json = ?,
             l1_memory_ids_json = ?,
             turn_count = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(toJson(rawTurnIds), toJson(l1MemoryIds), rawTurnIds.length, at, episodeId);
    return {
      ...episode,
        userId: null,
      rawTurnIds,
      l1MemoryIds,
      turnCount: rawTurnIds.length,
      updatedAt: at
    };
  }

  appendEpisodeRawTurn(episodeId: string, rawTurnId: string, at = nowIso()): EpisodeRecord {
    const episode = this.getEpisode(episodeId);
    if (!episode) {
      throw new Error(`episode not found: ${episodeId}`);
    }
    const rawTurnIds = uniq([...episode.rawTurnIds, rawTurnId]);
    this.db
      .prepare(
        `UPDATE episodes
         SET raw_turn_ids_json = ?,
             turn_count = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(toJson(rawTurnIds), rawTurnIds.length, at, episodeId);
    return {
      ...episode,
        userId: null,
      rawTurnIds,
      turnCount: rawTurnIds.length,
      updatedAt: at
    };
  }

  rebindRawTurnEpisode(
    rawTurnId: string,
    fromEpisodeId: string,
    toEpisodeId: string,
    at = nowIso()
  ): void {
    if (fromEpisodeId === toEpisodeId) return;
    const fromEpisode = this.getEpisode(fromEpisodeId);
    if (!fromEpisode || !this.getEpisode(toEpisodeId)) {
      throw new Error("cannot rebind a raw turn to a missing episode");
    }
    const remainingRawTurnIds = fromEpisode.rawTurnIds.filter((id) => id !== rawTurnId);
    this.db
      .prepare(
        `UPDATE episodes
         SET raw_turn_ids_json = ?,
             turn_count = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(toJson(remainingRawTurnIds), remainingRawTurnIds.length, at, fromEpisodeId);
    this.db.prepare("UPDATE raw_turns SET episode_id = ? WHERE id = ?").run(toEpisodeId, rawTurnId);
    this.db.prepare("UPDATE artifacts SET episode_id = ? WHERE raw_turn_id = ?").run(toEpisodeId, rawTurnId);
    this.appendEpisodeRawTurn(toEpisodeId, rawTurnId, at);
  }

  appendEpisodeFeedback(episodeId: string, feedbackId: string, at = nowIso()): EpisodeRecord | undefined {
    return this.appendEpisodeArrayValue(episodeId, "feedbackIds", "feedback_ids_json", feedbackId, at);
  }

  appendEpisodeDecisionRepair(episodeId: string, repairId: string, at = nowIso()): EpisodeRecord | undefined {
    return this.appendEpisodeArrayValue(episodeId, "decisionRepairIds", "decision_repair_ids_json", repairId, at);
  }

  appendEpisodeDerivedMemory(
    episodeId: string,
    layer: "L2" | "L3" | "Skill",
    memoryId: string,
    at = nowIso()
  ): EpisodeRecord | undefined {
    if (layer === "L2") {
      return this.appendEpisodeArrayValue(episodeId, "l2PolicyIds", "l2_policy_ids_json", memoryId, at);
    }
    if (layer === "L3") {
      return this.appendEpisodeArrayValue(episodeId, "l3WorldModelIds", "l3_world_model_ids_json", memoryId, at);
    }
    return this.appendEpisodeArrayValue(episodeId, "skillMemoryIds", "skill_memory_ids_json", memoryId, at);
  }

  updateEpisodeReward(
    episodeId: string,
    input: {
      rTask: number;
      rewardDetail: Record<string, unknown>;
      metaPatch?: Record<string, unknown>;
    },
    at = nowIso()
  ): EpisodeRecord | undefined {
    const episode = this.getEpisode(episodeId);
    if (!episode) return undefined;
    const meta = {
      ...episode.meta,
      ...(input.metaPatch ?? {})
    };
    this.db
      .prepare(
        `UPDATE episodes
         SET r_task = ?,
             reward_detail_json = ?,
             meta_json = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(input.rTask, toJson(input.rewardDetail), toJson(meta), at, episodeId);
    return {
      ...episode,
        userId: null,
      rTask: input.rTask,
      rewardDetail: input.rewardDetail,
      meta,
      updatedAt: at
    };
  }

  private appendEpisodeArrayValue<K extends keyof Pick<
    EpisodeRecord,
    "feedbackIds" | "decisionRepairIds" | "l2PolicyIds" | "l3WorldModelIds" | "skillMemoryIds"
  >>(
    episodeId: string,
    field: K,
    column: string,
    value: string,
    at = nowIso()
  ): EpisodeRecord | undefined {
    const episode = this.getEpisode(episodeId);
    if (!episode) return undefined;
    const values = uniq([...(episode[field] as string[]), value]);
    this.db
      .prepare(
        `UPDATE episodes
         SET ${column} = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(toJson(values), at, episodeId);
    return {
      ...episode,
        userId: null,
      [field]: values,
      updatedAt: at
    };
  }

  insertRawTurn(rawTurn: RawTurnRecord): RawTurnRecord {
    rawTurn = { ...rawTurn, userId: null };
    this.db
      .prepare(
        `INSERT INTO raw_turns (
          id, session_id, episode_id, turn_id, user_id, conversation_id,
          user_text, assistant_text, reasoning_summary, tool_calls_json,
          tool_results_json, source_memory_ids_json, usage_json, message_payload_json,
          status, redacted_at, deleted_at, created_at
        ) VALUES (
          @id, @sessionId, @episodeId, @turnId, @userId, @conversationId,
          @userText, @assistantText, @reasoningSummary, @toolCallsJson,
          @toolResultsJson, @sourceMemoryIdsJson, @usageJson, @messagePayloadJson,
          @status, @redactedAt, @deletedAt, @createdAt
        )`
      )
      .run({
        ...rawTurn,
        userId: null,
        conversationId: rawTurn.conversationId ?? null,
        userText: rawTurn.userText ?? null,
        assistantText: rawTurn.assistantText ?? null,
        reasoningSummary: rawTurn.reasoningSummary ?? null,
        toolCallsJson: toJson(rawTurn.toolCalls),
        toolResultsJson: toJson(rawTurn.toolResults),
        sourceMemoryIdsJson: toJson(rawTurn.sourceMemoryIds),
        usageJson: toJson(rawTurn.usage),
        messagePayloadJson: toJson(rawTurn.messagePayload ?? {}),
        redactedAt: rawTurn.redactedAt ?? null,
        deletedAt: rawTurn.deletedAt ?? null
      });
    return rawTurn;
  }

  updateRawTurn(rawTurn: RawTurnRecord): RawTurnRecord {
    rawTurn = { ...rawTurn, userId: null };
    this.db
      .prepare(
        `UPDATE raw_turns
         SET episode_id = @episodeId,
             user_text = @userText,
             assistant_text = @assistantText,
             reasoning_summary = @reasoningSummary,
             tool_calls_json = @toolCallsJson,
             tool_results_json = @toolResultsJson,
             source_memory_ids_json = @sourceMemoryIdsJson,
             usage_json = @usageJson,
             message_payload_json = @messagePayloadJson,
             status = @status,
             redacted_at = @redactedAt,
             deleted_at = @deletedAt
         WHERE id = @id`
      )
      .run({
        id: rawTurn.id,
        episodeId: rawTurn.episodeId,
        userText: rawTurn.userText ?? null,
        assistantText: rawTurn.assistantText ?? null,
        reasoningSummary: rawTurn.reasoningSummary ?? null,
        toolCallsJson: toJson(rawTurn.toolCalls),
        toolResultsJson: toJson(rawTurn.toolResults),
        sourceMemoryIdsJson: toJson(rawTurn.sourceMemoryIds),
        usageJson: toJson(rawTurn.usage),
        messagePayloadJson: toJson(rawTurn.messagePayload ?? {}),
        status: rawTurn.status,
        redactedAt: rawTurn.redactedAt ?? null,
        deletedAt: rawTurn.deletedAt ?? null
      });
    return rawTurn;
  }

  getRawTurn(id: string): RawTurnRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM raw_turns WHERE id = ?`)
      .get(id) as SqlRawTurnRow | undefined;
    return row ? rawTurnFromSql(row) : undefined;
  }

  episodeHasLaterRawTurn(episodeId: string, turnId: string, startedAt: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 AS found
      FROM raw_turns
      WHERE episode_id = ?
        AND turn_id != ?
        AND created_at > ?
      LIMIT 1
    `).get(episodeId, turnId, startedAt) as { found: number } | undefined;
    return row?.found === 1;
  }

  episodeRelationTexts(episodeId: string, rawTurnIds: readonly string[] = []): {
    firstUser: string;
    lastUser: string;
    lastAssistant: string;
    lastCompletedAt?: string;
  } {
    const completed = `json_type(message_payload_json, '$.turn_complete') = 'object'`;
    const boundary = (column: "user_text" | "assistant_text" | "created_at", edge: "first" | "last") => {
      const nonempty = column === "created_at" ? "1 = 1" : `trim(COALESCE(${column}, '')) != ''`;
      const time = this.db.prepare(`
        SELECT ${edge === "first" ? "MIN" : "MAX"}(created_at) AS boundary
        FROM raw_turns
        WHERE episode_id = ? AND ${completed} AND ${nonempty}
      `).get(episodeId) as { boundary: string | null } | undefined;
      if (!time?.boundary) return [];
      return this.db.prepare(`
        SELECT id, created_at AS createdAt, user_text AS userText, assistant_text AS assistantText
        FROM raw_turns
        WHERE episode_id = ? AND ${completed} AND ${nonempty} AND created_at = ?
      `).all(episodeId, time.boundary) as Array<{ id: string; createdAt: string; userText: string | null; assistantText: string | null }>;
    };
    const pick = (
      rows: Array<{ id: string; createdAt: string; userText: string | null; assistantText: string | null }>,
      field: "userText" | "assistantText" | "createdAt",
      edge: "first" | "last"
    ) => {
      const rank = new Map(rawTurnIds.map((id, index) => [id, index]));
      const ordered = [...rows].sort((left, right) =>
        (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER)
      );
      const chosen = edge === "first" ? ordered[0] : ordered[ordered.length - 1];
      const value = chosen?.[field];
      return typeof value === "string" ? value.trim() : "";
    };
    const firstUsers = boundary("user_text", "first");
    const lastUsers = boundary("user_text", "last");
    const lastAssistants = boundary("assistant_text", "last");
    const lastCompleted = boundary("created_at", "last");
    const lastCompletedAt = pick(lastCompleted, "createdAt", "last");
    return {
      firstUser: pick(firstUsers, "userText", "first"),
      lastUser: pick(lastUsers, "userText", "last"),
      lastAssistant: pick(lastAssistants, "assistantText", "last"),
      ...(lastCompletedAt ? { lastCompletedAt } : {})
    };
  }

  getRawTurnBySessionTurn(sessionId: string, turnId: string): RawTurnRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM raw_turns WHERE session_id = ? AND turn_id = ?`)
      .get(sessionId, turnId) as SqlRawTurnRow | undefined;
    return row ? rawTurnFromSql(row) : undefined;
  }

  hasCompletedSourceTurnInScope(input: {
    userId: string | null;
    source: string;
    profileId: string;
    conversationId: string;
    turnId: string;
    namespaceKey: string;
    defaultNamespaceKey: string;
    tenantId: string | null;
    storedProjectId: string | null;
    workspaceId: string | null;
  }): boolean {
    const row = this.db.prepare(`
      SELECT 1 AS found
      FROM raw_turns
      WHERE raw_turns.turn_id = @turnId
        AND json_type(raw_turns.message_payload_json, '$.turn_complete') = 'object'
        AND EXISTS (
          SELECT 1
          FROM sessions
          WHERE sessions.id = raw_turns.session_id
            AND sessions.source = @source
            AND sessions.profile_id = @profileId
            AND (
              sessions.host_session_key = @conversationId
              OR sessions.conversation_id = @conversationId
              OR sessions.host_session_key = @source || '-memory-' || @conversationId
            )
            AND (
              memory_namespace_key(json_extract(sessions.meta_json, '$.source_namespace_key')) = memory_namespace_key(@namespaceKey)
              OR (
                json_extract(sessions.meta_json, '$.source_namespace_key') IS NULL
                AND @tenantId IS NULL
                AND (
                  @namespaceKey = @defaultNamespaceKey
                  OR (
                    memory_project_id(sessions.project_id) IS memory_project_id(@storedProjectId)
                    AND memory_project_id(sessions.workspace_id) IS memory_project_id(@workspaceId)
                  )
                )
              )
            )
        )
      LIMIT 1
    `).get(input) as { found: number } | undefined;
    return row?.found === 1;
  }

  listRecentRawTurnsBySession(sessionId: string, limit = 8): RawTurnRecord[] {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM raw_turns
         WHERE session_id = ?
           AND deleted_at IS NULL
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`
      )
      .all(sessionId, limit) as SqlRawTurnRow[];
    return rows.map(rawTurnFromSql);
  }

  listRawTurnsByEpisode(episodeId: string, limit = 100): RawTurnRecord[] {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM raw_turns
         WHERE episode_id = ?
         ORDER BY created_at ASC, id ASC
         LIMIT ?`
      )
      .all(episodeId, limit) as SqlRawTurnRow[];
    return rows.map(rawTurnFromSql);
  }

  countRawTurnsByEpisode(episodeId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM raw_turns WHERE episode_id = ?`)
      .get(episodeId) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  /**
   * Newest-first turns, so callers can read an episode's tail without paging the
   * head.  The ordering mirrors listRawTurnsByEpisode exactly, which keeps a
   * head window and a tail window from overlapping or skipping a turn.
   */
  listLatestRawTurnsByEpisode(episodeId: string, limit = 100): RawTurnRecord[] {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM raw_turns
         WHERE episode_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`
      )
      .all(episodeId, limit) as SqlRawTurnRow[];
    return rows.map(rawTurnFromSql);
  }

  insertSkillCluster(cluster: SkillClusterRecord): SkillClusterRecord {
    this.db
      .prepare(
        `INSERT INTO skill_clusters (
          id, user_id, project_id, tools_json, artifacts_json, tool_bigrams_json,
          centroid_json, skill_memory_id, meta_skill_md, processed_episode_ids_json,
          member_count, created_at, updated_at
        ) VALUES (
          @id, @userId, @projectId, @toolsJson, @artifactsJson, @toolBigramsJson,
          @centroidJson, @skillMemoryId, @metaSkillMd, @processedEpisodeIdsJson,
          @memberCount, @createdAt, @updatedAt
        )`
      )
      .run({
        id: cluster.id,
        userId: null,
        projectId: cluster.projectId ?? null,
        toolsJson: toJson(cluster.tools),
        artifactsJson: toJson(cluster.artifacts),
        toolBigramsJson: toJson(cluster.toolBigrams),
        centroidJson: cluster.centroid ? toJson(cluster.centroid) : null,
        skillMemoryId: cluster.skillMemoryId ?? null,
        metaSkillMd: cluster.metaSkillMd,
        processedEpisodeIdsJson: toJson(cluster.processedEpisodeIds),
        memberCount: cluster.memberCount,
        createdAt: cluster.createdAt,
        updatedAt: cluster.updatedAt
      });
    return cluster;
  }

  updateSkillCluster(cluster: SkillClusterRecord): SkillClusterRecord {
    this.db
      .prepare(
        `UPDATE skill_clusters
         SET project_id = @projectId,
             tools_json = @toolsJson,
             artifacts_json = @artifactsJson,
             tool_bigrams_json = @toolBigramsJson,
             centroid_json = @centroidJson,
             skill_memory_id = @skillMemoryId,
             meta_skill_md = @metaSkillMd,
             processed_episode_ids_json = @processedEpisodeIdsJson,
             member_count = @memberCount,
             updated_at = @updatedAt
         WHERE id = @id`
      )
      .run({
        id: cluster.id,
        projectId: cluster.projectId ?? null,
        toolsJson: toJson(cluster.tools),
        artifactsJson: toJson(cluster.artifacts),
        toolBigramsJson: toJson(cluster.toolBigrams),
        centroidJson: cluster.centroid ? toJson(cluster.centroid) : null,
        skillMemoryId: cluster.skillMemoryId ?? null,
        metaSkillMd: cluster.metaSkillMd,
        processedEpisodeIdsJson: toJson(cluster.processedEpisodeIds),
        memberCount: cluster.memberCount,
        updatedAt: cluster.updatedAt
      });
    return cluster;
  }

  getSkillCluster(id: string): SkillClusterRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM skill_clusters WHERE id = ?`)
      .get(id) as SqlSkillClusterRow | undefined;
    return row ? skillClusterFromSql(row, this.db) : undefined;
  }

  getSkillClusterForEpisode(episodeId: string): SkillClusterRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT c.*
         FROM skill_cluster_members m
         JOIN skill_clusters c ON c.id = m.cluster_id
         WHERE m.episode_id = ?
         ORDER BY m.assigned_at DESC
         LIMIT 1`
      )
      .get(episodeId) as SqlSkillClusterRow | undefined;
    return row ? skillClusterFromSql(row, this.db) : undefined;
  }

  listSkillClustersByScope(input: {
    userId: string | null;
    projectId?: string;
    limit?: number;
  }): SkillClusterRecord[] {
    const rows = input.projectId
      ? this.db
          .prepare(
            `SELECT *
             FROM skill_clusters
             WHERE (memory_project_id(project_id) = memory_project_id(?) OR project_id IS NULL)
             ORDER BY updated_at DESC
             LIMIT ?`
          )
          .all(input.projectId, input.limit ?? 200) as SqlSkillClusterRow[]
      : this.db
          .prepare(
            `SELECT *
             FROM skill_clusters
             WHERE 1=1
             ORDER BY updated_at DESC
             LIMIT ?`
          )
          .all(input.limit ?? 200) as SqlSkillClusterRow[];
    return rows.map((row) => skillClusterFromSql(row, this.db));
  }

  upsertSkillClusterMember(member: SkillClusterMemberRecord): SkillClusterMemberRecord {
    this.db
      .prepare(
        `INSERT INTO skill_cluster_members (
          cluster_id, episode_id, outcome, r_task, assigned_at
        ) VALUES (
          @clusterId, @episodeId, @outcome, @rTask, @assignedAt
        )
        ON CONFLICT(cluster_id, episode_id) DO UPDATE SET
          outcome = excluded.outcome,
          r_task = excluded.r_task,
          assigned_at = excluded.assigned_at`
      )
      .run({
        clusterId: member.clusterId,
        episodeId: member.episodeId,
        outcome: member.outcome,
        rTask: member.rTask ?? null,
        assignedAt: member.assignedAt
      });
    return member;
  }

  listSkillClusterMembers(clusterId: string): SkillClusterMemberRecord[] {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM skill_cluster_members
         WHERE cluster_id = ?
         ORDER BY assigned_at DESC`
      )
      .all(clusterId) as SqlSkillClusterMemberRow[];
    return rows.map(skillClusterMemberFromSql);
  }

  insertFeedback(feedback: FeedbackRecord): FeedbackRecord {
    this.db
      .prepare(
        `INSERT INTO feedback (
          id, user_id, project_id, conversation_id, session_id, episode_id, l1_memory_id,
          raw_turn_id, channel, polarity, magnitude, rationale,
          raw_payload_json, context_hash, created_at
        ) VALUES (
          @id, @userId, @projectId, @conversationId, @sessionId, @episodeId, @l1MemoryId,
          @rawTurnId, @channel, @polarity, @magnitude, @rationale,
          @rawPayloadJson, @contextHash, @createdAt
        )`
      )
      .run({
        ...feedback,
        projectId: feedback.projectId ?? null,
        conversationId: feedback.conversationId ?? null,
        sessionId: feedback.sessionId ?? null,
        episodeId: feedback.episodeId ?? null,
        l1MemoryId: feedback.l1MemoryId ?? null,
        rawTurnId: feedback.rawTurnId ?? null,
        rationale: feedback.rationale ?? null,
        rawPayloadJson: toJson(feedback.rawPayload ?? {}),
        contextHash: feedback.contextHash ?? null
      });
    return feedback;
  }

  getFeedback(id: string): FeedbackRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM feedback WHERE id = ?`)
      .get(id) as SqlFeedbackRow | undefined;
    return row ? feedbackFromSql(row) : undefined;
  }

  listFeedback(input: {
    userId?: string | null;
    sessionId?: string;
    episodeId?: string;
    rawTurnId?: string;
    l1MemoryId?: string;
    limit?: number;
  }): FeedbackRecord[] {
    const clauses = ["1=1"];
    const params: SqlValue[] = [];
    void input.userId;
    addOptional("session_id", input.sessionId);
    addOptional("episode_id", input.episodeId);
    addOptional("raw_turn_id", input.rawTurnId);
    addOptional("l1_memory_id", input.l1MemoryId);
    const rows = this.db
      .prepare(
        `SELECT *
         FROM feedback
         WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(...params, input.limit ?? 20) as SqlFeedbackRow[];
    return rows.map(feedbackFromSql);

    function addOptional(column: string, value: string | undefined): void {
      if (value === undefined) return;
      clauses.push(`${column} = ?`);
      params.push(value);
    }
  }

  insertRecallEvent(event: RecallEventRecord): RecallEventRecord {
    this.db
      .prepare(
        `INSERT INTO recall_events (
          id, namespace_id, session_id, episode_id, turn_id, user_id, query,
          query_hash, layers_json, candidate_memory_ids_json, injected_memory_ids_json,
          hit_memory_ids_json, dropped_json, outcome, request_json,
          query_id, user_memory_candidate_ids_json, l1_candidate_ids_json,
          merged_source_turn_ids_json, member_memory_ids_by_source_turn_id_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.id,
        event.namespaceId ?? null,
        event.sessionId ?? null,
        event.episodeId ?? null,
        event.turnId ?? null,
        null,
        event.query,
        event.queryHash ?? stableHash(event.query),
        toJson(event.layers),
        toJson(event.candidateMemoryIds ?? event.hitMemoryIds),
        toJson(event.injectedMemoryIds ?? event.hitMemoryIds),
        toJson(event.hitMemoryIds),
        toJson(event.dropped ?? []),
        event.outcome ?? "pending",
        toJson(event.request),
        event.queryId ?? event.turnId ?? null,
        toJson(event.userMemoryCandidateIds ?? []),
        toJson(event.l1CandidateIds ?? []),
        toJson(event.mergedSourceTurnIds ?? []),
        toJson(event.memberMemoryIdsBySourceTurnId ?? {}),
        event.createdAt
      );
    return event;
  }

  getRecallEvent(id: string): RecallEventRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM recall_events WHERE id = ?`)
      .get(id) as SqlRecallEventRow | undefined;
    return row ? recallEventFromSql(row) : undefined;
  }

  getRecallEventByQueryId(queryId: string): RecallEventRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM recall_events
         WHERE query_id = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(queryId) as SqlRecallEventRow | undefined;
    return row ? recallEventFromSql(row) : undefined;
  }

  getTurnStartRecallEvent(sessionId: string, turnId: string): RecallEventRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT *
         FROM recall_events
         WHERE session_id = ?
           AND turn_id = ?
           AND json_extract(request_json, '$.retrievalMode') = 'turn_start'
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(sessionId, turnId) as SqlRecallEventRow | undefined;
    return row ? recallEventFromSql(row) : undefined;
  }

  updateRecallEventRequest(id: string, request: unknown): RecallEventRecord | undefined {
    this.db
      .prepare(`UPDATE recall_events SET request_json = ? WHERE id = ?`)
      .run(toJson(request), id);
    return this.getRecallEvent(id);
  }

  updateRecallEventOutcome(
    id: string,
    outcome: NonNullable<RecallEventRecord["outcome"]>
  ): RecallEventRecord | undefined {
    this.db
      .prepare(`UPDATE recall_events SET outcome = ? WHERE id = ?`)
      .run(outcome, id);
    return this.getRecallEvent(id);
  }

  appendChange(change: Omit<ChangeLogRecord, "seq">): number {
    const kind = change.kind ?? inferChangeKind(change);
    const op = change.op ?? inferChangeOp(change.changeType);
    const result = this.db
      .prepare(
        `INSERT INTO memory_change_log (
          memory_id, namespace_id, kind, op, entity_id, user_id, change_type,
          version, before_json, after_json, source, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        change.memoryId,
        change.namespaceId ?? inferNamespaceId(change),
        kind,
        op,
        change.entityId ?? change.memoryId,
        change.userId,
        change.changeType,
        change.version ?? versionFromChangePayload(change.after),
        change.before === undefined ? null : toJson(compactHistoryChangePayload(change.before)),
        change.after === undefined ? null : toJson(compactHistoryChangePayload(change.after)),
        change.source,
        change.createdAt
    );
    const seq = Number(result.lastInsertRowid);
    this.scheduleLogTablePruneAfterInsert("memory_change_log", seq);
    return seq;
  }

  latestChangeSeq(userId?: string | null, namespaceId?: string): number {
    void userId;
    void namespaceId;
    const clauses = ["1=1"];
    const params: SqlValue[] = [];
    const row = this.db
      .prepare(`SELECT MAX(seq) AS seq FROM memory_change_log WHERE ${clauses.join(" AND ")}`)
      .get(...params) as
      | { seq: number | null }
      | undefined;
    return Number(row?.seq ?? 0);
  }

  listChanges(userId?: string | null, limit = 50, cursor?: number, namespaceId?: string): ChangeLogRecord[] {
    void userId;
    void namespaceId;
    const clauses = ["1=1"];
    const params: SqlValue[] = [];
    if (cursor) {
      clauses.push("seq > ?");
      params.push(cursor);
    }
    const rows = this.db
      .prepare(
        `SELECT *
         FROM memory_change_log
         WHERE ${clauses.join(" AND ")}
         ORDER BY seq DESC
         LIMIT ?`
      )
      .all(...params, limit) as SqlChangeRow[];
    return rows.map((row) => ({
      seq: row.seq,
      memoryId: row.memory_id,
      namespaceId: row.namespace_id ?? undefined,
      kind: row.kind ?? undefined,
      op: row.op ?? undefined,
      entityId: row.entity_id ?? undefined,
      userId: null,
      changeType: row.change_type,
      version: row.version ?? undefined,
      before: row.before_json ? parseJson(row.before_json, undefined) : undefined,
      after: row.after_json ? parseJson(row.after_json, undefined) : undefined,
      source: row.source,
      createdAt: row.created_at
    }));
  }

  saveIdempotency(key: string, requestHash: string, response: unknown, createdAt = nowIso()): void {
    this.db
      .prepare(
        `INSERT INTO idempotency_keys (key, request_hash, response_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT(key) DO UPDATE SET
           request_hash = excluded.request_hash,
           response_json = excluded.response_json`
      )
      .run(key, requestHash, toJson(response), createdAt);
  }

  getIdempotency(key: string): { requestHash: string; response: unknown } | undefined {
    const row = this.db
      .prepare(`SELECT request_hash, response_json FROM idempotency_keys WHERE key = ?`)
      .get(key) as { request_hash: string; response_json: string } | undefined;
    if (!row) {
      return undefined;
    }
    return {
      requestHash: row.request_hash,
      response: parseJson(row.response_json, undefined)
    };
  }

  enqueueJob(job: EvolutionJobRecord): EvolutionJobRecord {
    return this.db.transaction(() => this.enqueueJobInTransaction(job))();
  }

  enqueueJobInTransaction(job: EvolutionJobRecord): EvolutionJobRecord {
    job = { ...job, userId: null };
    const existing = job.dedupeKey ? this.getActiveJobByDedupeKey(job.dedupeKey) : undefined;
    if (existing) {
      const updatedAt = job.updatedAt ?? nowIso();
      const payload = mergeJobPayload(existing.payload, job.payload);
      this.db
        .prepare(
          `UPDATE evolution_jobs
           SET status = CASE WHEN status = 'failed' THEN 'queued' ELSE status END,
               session_id = COALESCE(@sessionId, session_id),
               episode_id = COALESCE(@episodeId, episode_id),
               target_memory_id = COALESCE(@targetMemoryId, target_memory_id),
               payload_json = @payloadJson,
               max_attempts = MAX(max_attempts, @maxAttempts),
               leased_until = CASE WHEN status = 'failed' THEN NULL ELSE leased_until END,
               last_error = CASE WHEN status = 'failed' THEN NULL ELSE last_error END,
               updated_at = @updatedAt
           WHERE id = @id`
        )
        .run({
          id: existing.id,
          sessionId: job.sessionId ?? null,
          episodeId: job.episodeId ?? null,
          targetMemoryId: job.targetMemoryId ?? null,
          payloadJson: toJson(payload),
          maxAttempts: job.maxAttempts,
          updatedAt
        });
      return this.getJob(existing.id) ?? {
        ...existing,
        payload,
        updatedAt,
        status: existing.status === "failed" ? "queued" : existing.status,
        leasedUntil: existing.status === "failed" ? null : existing.leasedUntil,
        lastError: existing.status === "failed" ? null : existing.lastError
      };
    }
    this.db
      .prepare(
        `INSERT INTO evolution_jobs (
          id, job_type, status, dedupe_key, user_id, session_id, episode_id, target_memory_id,
          scope_key, scope_seq, payload_json, attempts, max_attempts, leased_until, last_error,
          created_at, updated_at
        ) VALUES (
          @id, @jobType, @status, @dedupeKey, @userId, @sessionId, @episodeId, @targetMemoryId,
          @scopeKey, @scopeSeq, @payloadJson, @attempts, @maxAttempts, @leasedUntil, @lastError,
          @createdAt, @updatedAt
        )`
      )
      .run({
        ...job,
        dedupeKey: job.dedupeKey ?? null,
        sessionId: job.sessionId ?? null,
        episodeId: job.episodeId ?? null,
        targetMemoryId: job.targetMemoryId ?? null,
        scopeKey: job.scopeKey ?? null,
        scopeSeq: job.scopeSeq ?? null,
        payloadJson: toJson(job.payload),
        leasedUntil: job.leasedUntil ?? null,
        lastError: job.lastError ?? null
      });
    return job;
  }

  /** Allocate the next FIFO sequence for Work Memory jobs in a merge scope. */
  nextWorkMemoryScopeSeq(scopeKey: string): number {
    const row = this.db.prepare(
      `SELECT COALESCE(MAX(scope_seq), 0) + 1 AS next_seq
       FROM evolution_jobs
       WHERE job_type = 'work_memory_extract' AND scope_key = ?`
    ).get(scopeKey) as { next_seq: number };
    return Number(row.next_seq);
  }

  /**
   * Read the Work Memory extraction cursor for a Session.
   *
   * A missing row is seeded from the L3 cursor so Sessions that predate this
   * table do not re-extract windows the L3 boundary already covered.
   */
  getWorkMemoryCursor(sessionId: string, at = nowIso()): WorkMemorySessionCursorRecord {
    const seed = this.db.prepare(
      `SELECT COALESCE(
         (SELECT last_scheduled_seq FROM l3_world_model_session_cursors WHERE session_id = ?),
         0
       ) AS last_seq`
    ).get(sessionId) as { last_seq: number };
    return this.ensureWorkMemoryCursor(sessionId, Number(seed.last_seq), at);
  }

  /** Create the Work Memory cursor row for a Session when it is still missing. */
  ensureWorkMemoryCursor(
    sessionId: string,
    lastExtractedSeq: number,
    at = nowIso()
  ): WorkMemorySessionCursorRecord {
    this.db.prepare(
      `INSERT INTO work_memory_session_cursors (session_id, last_extracted_seq, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO NOTHING`
    ).run(sessionId, lastExtractedSeq, at);
    const row = this.db.prepare(
      `SELECT session_id, last_extracted_seq, updated_at
       FROM work_memory_session_cursors WHERE session_id = ?`
    ).get(sessionId) as { session_id: string; last_extracted_seq: number; updated_at: string };
    return {
      sessionId: row.session_id,
      lastExtractedSeq: Number(row.last_extracted_seq),
      updatedAt: row.updated_at
    };
  }

  /** Advance the Work Memory extraction cursor. */
  setWorkMemoryCursor(sessionId: string, lastExtractedSeq: number, at = nowIso()): void {
    this.db.prepare(
      `UPDATE work_memory_session_cursors
       SET last_extracted_seq = ?, updated_at = ?
       WHERE session_id = ?`
    ).run(lastExtractedSeq, at, sessionId);
  }

  /**
   * Arm the Work Memory idle flush for a Session, pushing `runAfter` forward.
   *
   * The generic enqueue path merges `runAfter` by keeping the earlier value,
   * which is the opposite of re-arming. This upsert therefore reuses terminal
   * rows as well and clears the retry bookkeeping, so the auto worker keeps
   * scheduling the job.
   */
  armWorkMemoryIdleFlush(input: {
    sessionId: string;
    userId: string | null;
    lastActivityAt: string;
    runAfter: string;
    at?: string;
  }): EvolutionJobRecord {
    const at = input.at ?? nowIso();
    const dedupeKey = `work_memory_idle_flush:${input.sessionId}`;
    const payload = toJson({ lastActivityAt: input.lastActivityAt, runAfter: input.runAfter });
    const existing = this.getJobByDedupeKey(dedupeKey);
    if (existing) {
      this.db.prepare(
        `UPDATE evolution_jobs
         SET status = 'queued',
             payload_json = ?,
             attempts = 0,
             leased_until = NULL,
             last_error = NULL,
             updated_at = ?
         WHERE id = ?`
      ).run(payload, at, existing.id);
    } else {
      this.db.prepare(
        `INSERT INTO evolution_jobs (
           id, job_type, status, dedupe_key, user_id, session_id, episode_id,
           target_memory_id, scope_key, scope_seq, payload_json, attempts,
           max_attempts, leased_until, last_error, created_at, updated_at
         ) VALUES (?, 'work_memory_idle_flush', 'queued', ?, ?, ?, NULL, NULL, NULL, NULL, ?, 0, 3, NULL, NULL, ?, ?)`
      ).run(newId("job"), dedupeKey, null, input.sessionId, payload, at, at);
    }
    const job = this.getJobByDedupeKey(dedupeKey);
    if (!job) throw new Error(`failed to arm work memory idle flush: ${input.sessionId}`);
    return job;
  }

  listJobs(status?: JobStatus, limit = 50, userId?: string | null): EvolutionJobRecord[] {
    void userId;
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    if (status) {
      clauses.push("status = ?");
      params.push(status);
    }
    const rows = this.db
      .prepare(
        `SELECT *
         FROM evolution_jobs
         ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY ${evolutionJobOrderSql()}
         LIMIT ?`
      )
      .all(...params, limit) as SqlJobRow[];
    return rows.map(jobFromSql);
  }

  countJobsByStatus(): Record<JobStatus, number> {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS count FROM evolution_jobs GROUP BY status`)
      .all() as Array<{ status: JobStatus; count: number }>;
    const counts: Record<JobStatus, number> = {
      queued: 0,
      leased: 0,
      succeeded: 0,
      failed: 0,
      dead_letter: 0
    };
    for (const row of rows) counts[row.status] = Number(row.count);
    return counts;
  }

  nextWorkerRunAt(options?: {
    jobType?: string;
    jobTypes?: readonly string[];
    excludedJobTypes?: readonly string[];
    includeEmbeddingRetries?: boolean;
  }): number | undefined {
    const jobTypes = options?.jobTypes ?? (options?.jobType ? [options.jobType] : undefined);
    const jobTypeFilter = jobTypes
      ? jobTypes.length === 0
        ? "AND 1=0"
        : `AND job_type IN (${jobTypes.map(() => "?").join(", ")})`
      : "";
    const excluded = options?.excludedJobTypes?.length ? options.excludedJobTypes : undefined;
    const excludeFilter = excluded
      ? `AND job_type NOT IN (${excluded.map(() => "?").join(", ")})`
      : "";
    const jobTypeParams = [
      ...(jobTypes && jobTypes.length > 0 ? jobTypes : []),
      ...(excluded ?? [])
    ];
    const queuedJob = this.db
      .prepare(
        `SELECT CAST(json_extract(payload_json, '$.runAfter') AS TEXT) AS run_after
         FROM evolution_jobs
         WHERE status = 'queued'
           AND attempts < max_attempts
           AND json_type(payload_json, '$.runAfter') = 'text'
           ${jobTypeFilter}
           ${excludeFilter}
         ORDER BY run_after ASC
         LIMIT 1`
      )
      .get(...jobTypeParams) as { run_after: string } | undefined;
    const leasedJob = this.db
      .prepare(
        `SELECT leased_until
         FROM evolution_jobs
         WHERE status = 'leased'
           AND attempts < max_attempts
           AND leased_until IS NOT NULL
           ${jobTypeFilter}
           ${excludeFilter}
         ORDER BY leased_until ASC
         LIMIT 1`
      )
      .get(...jobTypeParams) as { leased_until: string } | undefined;
    const includeEmbeddingRetries = options?.includeEmbeddingRetries !== false;
    const pendingEmbedding = includeEmbeddingRetries
      ? this.db
        .prepare(
          `SELECT next_attempt_at
           FROM embedding_retry_queue
           WHERE status = 'pending'
           ORDER BY next_attempt_at ASC
           LIMIT 1`
        )
        .get() as { next_attempt_at: number } | undefined
      : undefined;
    const inProgressEmbedding = includeEmbeddingRetries
      ? this.db
        .prepare(
          `SELECT MAX(next_attempt_at, lease_until) AS run_at
           FROM embedding_retry_queue
           WHERE status = 'in_progress'
             AND lease_until IS NOT NULL
           ORDER BY run_at ASC
           LIMIT 1`
        )
        .get() as { run_at: number } | undefined
      : undefined;
    const times = [
      queuedJob ? Date.parse(queuedJob.run_after) : Number.NaN,
      leasedJob ? Date.parse(leasedJob.leased_until) : Number.NaN,
      pendingEmbedding?.next_attempt_at ?? Number.NaN,
      inProgressEmbedding?.run_at ?? Number.NaN
    ].filter((time) => Number.isFinite(time));
    return times.length > 0 ? Math.min(...times) : undefined;
  }

  getJob(id: string): EvolutionJobRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM evolution_jobs WHERE id = ?`)
      .get(id) as SqlJobRow | undefined;
    return row ? jobFromSql(row) : undefined;
  }

  getActiveJobByDedupeKey(dedupeKey: string): EvolutionJobRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT *
         FROM evolution_jobs
         WHERE dedupe_key = ?
           AND status IN ('queued', 'leased', 'failed')
         ORDER BY ${evolutionJobOrderSql()}
         LIMIT 1`
      )
      .get(dedupeKey) as SqlJobRow | undefined;
    return row ? jobFromSql(row) : undefined;
  }

  getJobByDedupeKey(dedupeKey: string): EvolutionJobRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM evolution_jobs
         WHERE dedupe_key = ?
         ORDER BY created_at ASC, id ASC
         LIMIT 1`
      )
      .get(dedupeKey) as SqlJobRow | undefined;
    return row ? jobFromSql(row) : undefined;
  }

  getPendingJob(
    targetMemoryId: string,
    jobType: JobType,
    contentHash?: string,
    observationGeneration?: string,
    externalSkillGeneration?: string
  ): EvolutionJobRecord | undefined {
    const contentClause = contentHash
      ? "AND json_extract(payload_json, '$.contentHash') = ?"
      : "";
    const generationClause = observationGeneration ? "AND json_extract(payload_json, '$.observationGeneration') = ?" : "";
    const skillGenerationClause = externalSkillGeneration ? "AND json_extract(payload_json, '$.externalSkillGeneration') = ?" : "";
    const row = this.db
      .prepare(
        `SELECT *
         FROM evolution_jobs
         WHERE target_memory_id = ?
           AND job_type = ?
           AND status IN ('queued', 'leased')
           ${contentClause}
           ${generationClause}
           ${skillGenerationClause}
         ORDER BY ${evolutionJobOrderSql()}
         LIMIT 1`
      )
      .get(targetMemoryId, jobType, ...(contentHash ? [contentHash] : []), ...(observationGeneration ? [observationGeneration] : []),
        ...(externalSkillGeneration ? [externalSkillGeneration] : [])) as SqlJobRow | undefined;
    return row ? jobFromSql(row) : undefined;
  }

  hasPendingJob(targetMemoryId: string, jobType: JobType, contentHash?: string): boolean {
    return Boolean(this.getPendingJob(targetMemoryId, jobType, contentHash));
  }

  hasEpisodeJob(episodeId: string, jobType: JobType, statuses: JobStatus[]): boolean {
    if (statuses.length === 0) return false;
    const placeholders = statuses.map(() => "?").join(", ");
    const row = this.db
      .prepare(
        `SELECT 1 AS found
         FROM evolution_jobs
         WHERE episode_id = ?
           AND job_type = ?
           AND status IN (${placeholders})
         LIMIT 1`
      )
      .get(episodeId, jobType, ...statuses) as { found: number } | undefined;
    return Boolean(row);
  }

  leaseQueuedJobs(
    limit = 10,
    leaseSeconds = 60,
    targetMemoryIds?: readonly string[],
    priorityCohortOnly = false,
    allowedJobTypes?: readonly string[],
    excludedJobTypes?: readonly string[]
  ): EvolutionJobRecord[] {
    if (targetMemoryIds?.length === 0 || allowedJobTypes?.length === 0) {
      return [];
    }
    const at = nowIso();
    const leaseUntil = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    const targetFilter = targetMemoryIds
      ? `AND target_memory_id IN (${targetMemoryIds.map(() => "?").join(", ")})`
      : "";
    const transaction = this.db.transaction(() => {
      const candidates = this.db
        .prepare(
          `SELECT *, ${evolutionJobPrioritySql()} AS queue_priority
           FROM evolution_jobs
           WHERE (status = 'queued'
              OR (status = 'leased' AND leased_until IS NOT NULL AND leased_until <= ?))
             AND attempts < max_attempts
             AND NOT (
               job_type = 'reward'
               AND json_extract(payload_json, '$.l1MemoryId') IS NOT NULL
               AND (
                 json_extract(payload_json, '$.polarity') IS NULL
                 OR json_extract(payload_json, '$.polarity') = 'positive'
               )
               AND EXISTS (
                 SELECT 1
                 FROM memory_processing_state
                 JOIN memories ON memories.id = memory_processing_state.memory_id
                 WHERE memory_processing_state.memory_id =
                   CAST(json_extract(evolution_jobs.payload_json, '$.l1MemoryId') AS TEXT)
                   AND NOT EXISTS (
                     SELECT 1
                     FROM memory_vector_entries
                     WHERE memory_vector_entries.memory_id = memory_processing_state.memory_id
                       AND memory_vector_entries.vector_field = 'vec_summary'
                   )
                   AND (
                     memory_processing_state.state IN ('embedding_pending', 'embedding')
                   OR memory_processing_state.state IN ('summary_pending', 'summarizing')
                   )
               )
             )
             AND (
               json_extract(payload_json, '$.runAfter') IS NULL
               OR CAST(json_extract(payload_json, '$.runAfter') AS TEXT) <= ?
             )
             AND (
               job_type NOT IN ('l3_world_model_update', 'work_memory_extract')
               OR (
                 scope_key IS NOT NULL
                 AND scope_seq IS NOT NULL
                 AND NOT EXISTS (
                   SELECT 1
                   FROM evolution_jobs AS leased_l3_job
                   WHERE leased_l3_job.job_type = evolution_jobs.job_type
                     AND leased_l3_job.scope_key = evolution_jobs.scope_key
                     AND leased_l3_job.status = 'leased'
                     AND leased_l3_job.id <> evolution_jobs.id
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM evolution_jobs AS shared_job
                   LEFT JOIN sessions AS shared_session ON shared_session.id = shared_job.session_id
                   WHERE shared_job.job_type = evolution_jobs.job_type
                     AND shared_job.id <> evolution_jobs.id
                     AND shared_job.scope_key <> evolution_jobs.scope_key
                     AND memory_project_id(shared_session.project_id) IS
                       (SELECT memory_project_id(project_id) FROM sessions WHERE id = evolution_jobs.session_id)
                     AND json_extract(shared_job.payload_json, '$.targetField') IS json_extract(evolution_jobs.payload_json, '$.targetField')
                     AND (shared_job.status = 'leased' OR (
                       shared_job.status IN ('queued', 'failed') AND
                       (shared_job.created_at < evolution_jobs.created_at OR
                         (shared_job.created_at = evolution_jobs.created_at AND shared_job.id < evolution_jobs.id))
                     ))
                 )
                 AND NOT EXISTS (
                   SELECT 1
                   FROM evolution_jobs AS earlier_l3_job
                   WHERE earlier_l3_job.job_type = evolution_jobs.job_type
                     AND earlier_l3_job.scope_key = evolution_jobs.scope_key
                     AND earlier_l3_job.scope_seq < evolution_jobs.scope_seq
                     AND earlier_l3_job.status IN ('queued', 'leased', 'failed')
                 )
               )
             )
             ${allowedJobTypes ? `AND job_type IN (${allowedJobTypes.map(() => "?").join(", ")})` : ""}
             ${excludedJobTypes?.length ? `AND job_type NOT IN (${excludedJobTypes.map(() => "?").join(", ")})` : ""}
             ${targetFilter}
           ORDER BY ${evolutionJobOrderSql()}
           LIMIT ?`
        )
        .all(at, at, ...(allowedJobTypes ?? []), ...(excludedJobTypes ?? []), ...(targetMemoryIds ?? []), limit) as Array<SqlJobRow & {
          queue_priority: number;
        }>;
      const queuePriority = candidates[0]?.queue_priority;
      const rows = priorityCohortOnly && queuePriority !== undefined
        ? candidates.filter((row) => row.queue_priority === queuePriority)
        : candidates;

      for (const row of rows) {
        this.db
          .prepare(
            `UPDATE evolution_jobs
             SET status = 'leased',
                 attempts = attempts + 1,
                 leased_until = ?,
                 updated_at = ?
             WHERE id = ?`
          )
          .run(leaseUntil, at, row.id);
      }
      return rows.map((row) =>
        jobFromSql({
          ...row,
          status: "leased",
          attempts: row.attempts + 1,
          leased_until: leaseUntil,
          updated_at: at
        })
      );
    });
    return transaction();
  }

  completeJob(id: string, at = nowIso()): EvolutionJobRecord | undefined {
    this.db
      .prepare(
        `UPDATE evolution_jobs
         SET status = 'succeeded',
             leased_until = NULL,
             updated_at = ?
         WHERE id = ?`
      )
      .run(at, id);
    return this.getJob(id);
  }

  /** Waiting for a dependency is not a model failure and does not consume an attempt. */
  deferProcessingJob(id: string, runAfter: string, at = nowIso()): EvolutionJobRecord | undefined {
    this.db.prepare(`UPDATE evolution_jobs SET status = 'queued', leased_until = NULL,
      attempts = MAX(0, attempts - 1), updated_at = ?,
      payload_json = json_set(payload_json, '$.runAfter', ?)
      WHERE id = ? AND status = 'leased'`).run(at, runAfter, id);
    return this.getJob(id);
  }

  requeueFailedJobs(
    limit = 100,
    at = nowIso(),
    targetMemoryIds?: readonly string[]
  ): Array<{ before: EvolutionJobRecord; after: EvolutionJobRecord }> {
    if (targetMemoryIds?.length === 0) {
      return [];
    }
    const targetFilter = targetMemoryIds
      ? `AND target_memory_id IN (${targetMemoryIds.map(() => "?").join(", ")})`
      : "";
    const transaction = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT *
           FROM evolution_jobs
           WHERE status = 'failed'
             AND attempts < max_attempts
             ${targetFilter}
           ORDER BY ${evolutionJobOrderSql()}
           LIMIT ?`
        )
        .all(...(targetMemoryIds ?? []), limit) as SqlJobRow[];

      for (const row of rows) {
        this.db
          .prepare(
            `UPDATE evolution_jobs
             SET status = 'queued',
                 leased_until = NULL,
                 updated_at = ?
             WHERE id = ?`
          )
          .run(at, row.id);
      }

      return rows.map((row) => ({
        before: jobFromSql(row),
        after: jobFromSql({
          ...row,
          status: "queued",
          leased_until: null,
          updated_at: at
        })
      }));
    });
    return transaction();
  }

  requeueLeasedJobsAfterRestart(
    at = nowIso()
  ): Array<{ before: EvolutionJobRecord; after: EvolutionJobRecord }> {
    const transaction = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT *
           FROM evolution_jobs
           WHERE status = 'leased'
           ORDER BY ${evolutionJobOrderSql()}`
        )
        .all() as SqlJobRow[];

      for (const row of rows) {
        this.db
          .prepare(
            `UPDATE evolution_jobs
             SET status = 'queued',
                 attempts = MAX(0, attempts - 1),
                 leased_until = NULL,
                 updated_at = ?
             WHERE id = ?`
          )
          .run(at, row.id);
      }

      return rows.map((row) => ({
        before: jobFromSql(row),
        after: jobFromSql({
          ...row,
          status: "queued",
          attempts: Math.max(0, row.attempts - 1),
          leased_until: null,
          updated_at: at
        })
      }));
    });
    return transaction();
  }

  requeueUnstartedLeasedJobs(
    ids: readonly string[],
    at = nowIso()
  ): Array<{ before: EvolutionJobRecord; after: EvolutionJobRecord }> {
    if (ids.length === 0) {
      return [];
    }
    return this.requeueLeasedJobsWhere(
      `status = 'leased' AND id IN (${ids.map(() => "?").join(", ")})`,
      [...ids],
      at
    );
  }

  requeueExpiredLeasedJobsExcept(
    excludedJobTypes: readonly string[],
    at = nowIso()
  ): Array<{ before: EvolutionJobRecord; after: EvolutionJobRecord }> {
    const excludeFilter = excludedJobTypes.length > 0
      ? `AND job_type NOT IN (${excludedJobTypes.map(() => "?").join(", ")})`
      : "";
    return this.requeueLeasedJobsWhere(
      `status = 'leased'
         AND leased_until IS NOT NULL
         AND leased_until <= ?
         ${excludeFilter}`,
      [at, ...excludedJobTypes],
      at
    );
  }

  private requeueLeasedJobsWhere(
    whereSql: string,
    params: readonly unknown[],
    at: string
  ): Array<{ before: EvolutionJobRecord; after: EvolutionJobRecord }> {
    const transaction = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT *
           FROM evolution_jobs
           WHERE ${whereSql}
           ORDER BY ${evolutionJobOrderSql()}`
        )
        .all(...params) as SqlJobRow[];

      for (const row of rows) {
        this.db
          .prepare(
            `UPDATE evolution_jobs
             SET status = 'queued',
                 attempts = MAX(0, attempts - 1),
                 leased_until = NULL,
                 updated_at = ?
             WHERE id = ?`
          )
          .run(at, row.id);
      }

      return rows.map((row) => ({
        before: jobFromSql(row),
        after: jobFromSql({
          ...row,
          status: "queued",
          attempts: Math.max(0, row.attempts - 1),
          leased_until: null,
          updated_at: at
        })
      }));
    });
    return transaction();
  }

  failJob(
    id: string,
    error: string,
    at = nowIso(),
    forceDeadLetter = false
  ): EvolutionJobRecord | undefined {
    return this.db.transaction(() => {
      const row = this.db
        .prepare(`SELECT * FROM evolution_jobs WHERE id = ?`)
        .get(id) as SqlJobRow | undefined;
      if (!row) return undefined;
      if (row.status === "dead_letter") return jobFromSql(row);
      const status: JobStatus = forceDeadLetter || row.attempts >= row.max_attempts
        ? "dead_letter"
        : "failed";
      this.db
        .prepare(
          `UPDATE evolution_jobs
           SET status = ?,
               leased_until = NULL,
               last_error = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(status, error, at, id);
      if (status === "dead_letter" && row.job_type === "l3_world_model_update") {
        const payload = parseJson<Record<string, unknown>>(row.payload_json, {});
        const batchId = typeof payload.batchId === "string" ? payload.batchId : undefined;
        const targetField = typeof payload.targetField === "string" ? payload.targetField : undefined;
        if (batchId && isL3WorldModelTargetField(targetField)) {
          this.db.prepare(
            `UPDATE l3_world_model_batch_targets
             SET status = 'dead_letter', no_change = 0, applied_at = NULL, updated_at = ?
             WHERE batch_id = ? AND target_field = ? AND status = 'queued'`
          ).run(at, batchId, targetField);
          updateL3WorldModelBatchTerminalOutcome(this.db, batchId, at);
        }
      }
      if (status === "dead_letter" && row.job_type === "project_environment_profile") {
        const payload = parseJson<Record<string, unknown>>(row.payload_json, {});
        const projectId = typeof payload.projectId === "string" ? payload.projectId : undefined;
        const scanId = typeof payload.scanId === "string" ? payload.scanId : undefined;
        if (projectId && scanId) {
          this.db.prepare(
            `UPDATE l3_world_model_project_environment_state
             SET status = 'failed', last_error = ?, updated_at = ?
            WHERE memory_project_id(project_id) = memory_project_id(?) AND current_scan_id = ?`
          ).run(error, at, projectId, scanId);
        }
      }
      return this.getJob(id);
    })();
  }

  enqueueEmbeddingRetry(input: {
    id?: string;
    targetKind: EmbeddingRetryTargetKind;
    targetId: string;
    vectorField: EmbeddingRetryVectorField;
    sourceText: string;
    embedRole?: "document" | "query";
    maxAttempts?: number;
    now?: number;
  }): EmbeddingRetryRecord {
    const now = input.now ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO embedding_retry_queue (
          id, target_kind, target_id, vector_field, source_text, embed_role,
          status, attempts, max_attempts, next_attempt_at, claimed_by, lease_until,
          last_error, created_at, updated_at
        ) VALUES (
          @id, @targetKind, @targetId, @vectorField, @sourceText, @embedRole,
          'pending', 0, @maxAttempts, @now, NULL, NULL,
          NULL, @now, @now
        )
        ON CONFLICT(target_kind, target_id, vector_field) DO UPDATE SET
          source_text = excluded.source_text,
          embed_role = excluded.embed_role,
          status = CASE
            WHEN embedding_retry_queue.status IN ('failed', 'succeeded') THEN 'pending'
            ELSE embedding_retry_queue.status
          END,
          attempts = CASE
            WHEN embedding_retry_queue.status IN ('failed', 'succeeded') THEN 0
            ELSE embedding_retry_queue.attempts
          END,
          max_attempts = excluded.max_attempts,
          next_attempt_at = MIN(embedding_retry_queue.next_attempt_at, excluded.next_attempt_at),
          claimed_by = NULL,
          lease_until = NULL,
          last_error = CASE
            WHEN embedding_retry_queue.status IN ('failed', 'succeeded') THEN NULL
            ELSE embedding_retry_queue.last_error
          END,
          updated_at = excluded.updated_at`
      )
      .run({
        id: input.id ?? newId("embed_retry"),
        targetKind: input.targetKind,
        targetId: input.targetId,
        vectorField: input.vectorField,
        sourceText: input.sourceText || "(empty)",
        embedRole: input.embedRole ?? "document",
        maxAttempts: input.maxAttempts ?? 6,
        now
      });
    const record = this.getEmbeddingRetryByTarget(input.targetKind, input.targetId, input.vectorField);
    if (!record) {
      throw new Error(`embedding retry was not persisted: ${input.targetKind}:${input.targetId}`);
    }
    return record;
  }

  getEmbeddingRetry(id: string): EmbeddingRetryRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM embedding_retry_queue WHERE id = ?`)
      .get(id) as SqlEmbeddingRetryRow | undefined;
    return row ? embeddingRetryFromSql(row) : undefined;
  }

  getEmbeddingRetryByTarget(
    targetKind: EmbeddingRetryTargetKind,
    targetId: string,
    vectorField: EmbeddingRetryVectorField
  ): EmbeddingRetryRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT *
         FROM embedding_retry_queue
         WHERE target_kind = ?
           AND target_id = ?
           AND vector_field = ?`
      )
      .get(targetKind, targetId, vectorField) as SqlEmbeddingRetryRow | undefined;
    return row ? embeddingRetryFromSql(row) : undefined;
  }

  listEmbeddingRetries(
    status?: EmbeddingRetryStatus,
    limit = 50,
    userId?: string | null,
    offset = 0
  ): EmbeddingRetryRecord[] {
    void userId;
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    if (status) {
      clauses.push("q.status = ?");
      params.push(status);
    }
    const rows = this.db
      .prepare(
        `SELECT q.*
         FROM embedding_retry_queue q
         LEFT JOIN memories m ON m.id = q.target_id
         ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY ${embeddingRetryOrderSql()}
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as SqlEmbeddingRetryRow[];
    return rows.map(embeddingRetryFromSql);
  }

  countEmbeddingRetriesByStatus(
    status: EmbeddingRetryStatus,
    userId?: string | null
  ): number {
    void userId;
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM embedding_retry_queue WHERE status = ?`)
      .get(status) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  requeueEmbeddingRetriesAfterRestart(
    now = Date.now()
  ): Array<{ before: EmbeddingRetryRecord; after: EmbeddingRetryRecord }> {
    const transaction = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT *
           FROM embedding_retry_queue
           WHERE status IN ('in_progress', 'failed')
           ORDER BY updated_at ASC, id ASC`
        )
        .all() as SqlEmbeddingRetryRow[];

      for (const row of rows) {
        this.db
          .prepare(
            `UPDATE embedding_retry_queue
             SET status = 'pending',
                 attempts = CASE WHEN status = 'failed' THEN 0 ELSE attempts END,
                 next_attempt_at = ?,
                 claimed_by = NULL,
                 lease_until = NULL,
                 updated_at = ?
             WHERE id = ?`
          )
          .run(now, now, row.id);
      }

      return rows.map((row) => ({
        before: embeddingRetryFromSql(row),
        after: embeddingRetryFromSql({
          ...row,
          status: "pending",
          attempts: row.status === "failed" ? 0 : row.attempts,
          next_attempt_at: now,
          claimed_by: null,
          lease_until: null,
          updated_at: now
        })
      }));
    });
    return transaction();
  }

  claimDueEmbeddingRetries(input: {
    now: number;
    workerId: string;
    leaseUntil: number;
    limit?: number;
    targetMemoryIds?: readonly string[];
  }): EmbeddingRetryRecord[] {
    if (input.targetMemoryIds?.length === 0) {
      return [];
    }
    const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 25)));
    const targetFilter = input.targetMemoryIds
      ? `AND q.target_id IN (${input.targetMemoryIds.map(() => "?").join(", ")})`
      : "";
    const transaction = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT q.*
           FROM embedding_retry_queue q
           LEFT JOIN memories m ON m.id = q.target_id
           WHERE (
             q.status = 'pending'
             OR (q.status = 'in_progress' AND q.lease_until IS NOT NULL AND q.lease_until <= ?)
           )
             AND q.next_attempt_at <= ?
             ${targetFilter}
           ORDER BY ${embeddingRetryOrderSql()}
           LIMIT ?`
        )
        .all(input.now, input.now, ...(input.targetMemoryIds ?? []), limit) as SqlEmbeddingRetryRow[];
      const claimed: EmbeddingRetryRecord[] = [];
      for (const row of rows) {
        const result = this.db
          .prepare(
            `UPDATE embedding_retry_queue
             SET status = 'in_progress',
                 claimed_by = ?,
                 lease_until = ?,
                 updated_at = ?
             WHERE id = ?
               AND (
                 status = 'pending'
                 OR (status = 'in_progress' AND lease_until IS NOT NULL AND lease_until <= ?)
               )
               AND next_attempt_at <= ?`
          )
          .run(input.workerId, input.leaseUntil, input.now, row.id, input.now, input.now);
        if (result.changes > 0) {
          claimed.push(embeddingRetryFromSql({
            ...row,
            status: "in_progress",
            claimed_by: input.workerId,
            lease_until: input.leaseUntil,
            updated_at: input.now
          }));
        }
      }
      return claimed;
    });
    return transaction();
  }

  isEmbeddingRetryClaimHeld(id: string, input: {
    workerId: string;
    leaseUntil: number;
  }): boolean {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM embedding_retry_queue
         WHERE id = ?
           AND status = 'in_progress'
           AND claimed_by = ?
           AND lease_until = ?`
      )
      .get(id, input.workerId, input.leaseUntil) as { count: number } | undefined;
    return (row?.count ?? 0) > 0;
  }

  markEmbeddingRetryRetryClaimed(id: string, input: {
    workerId: string;
    leaseUntil: number;
    attempts: number;
    nextAttemptAt: number;
    error: string;
    now: number;
  }): EmbeddingRetryRecord | undefined {
    const result = this.db
      .prepare(
        `UPDATE embedding_retry_queue
         SET status = 'pending',
             attempts = ?,
             next_attempt_at = ?,
             claimed_by = NULL,
             lease_until = NULL,
             last_error = ?,
             updated_at = ?
         WHERE id = ?
           AND status = 'in_progress'
           AND claimed_by = ?
           AND lease_until = ?`
      )
      .run(
        input.attempts,
        input.nextAttemptAt,
        input.error,
        input.now,
        id,
        input.workerId,
        input.leaseUntil
      );
    return result.changes > 0 ? this.getEmbeddingRetry(id) : undefined;
  }

  markEmbeddingRetryFailedClaimed(id: string, input: {
    workerId: string;
    leaseUntil: number;
    attempts: number;
    error: string;
    now: number;
  }): EmbeddingRetryRecord | undefined {
    const result = this.db
      .prepare(
        `UPDATE embedding_retry_queue
         SET status = 'failed',
             attempts = ?,
             claimed_by = NULL,
             lease_until = NULL,
             last_error = ?,
             updated_at = ?
         WHERE id = ?
           AND status = 'in_progress'
           AND claimed_by = ?
           AND lease_until = ?`
      )
      .run(input.attempts, input.error, input.now, id, input.workerId, input.leaseUntil);
    return result.changes > 0 ? this.getEmbeddingRetry(id) : undefined;
  }

  markEmbeddingRetrySucceededClaimed(id: string, input: {
    workerId: string;
    leaseUntil: number;
    now: number;
  }): EmbeddingRetryRecord | undefined {
    const result = this.db
      .prepare(
        `UPDATE embedding_retry_queue
         SET status = 'succeeded',
             next_attempt_at = ?,
             claimed_by = NULL,
             lease_until = NULL,
             updated_at = ?
         WHERE id = ?
           AND status = 'in_progress'
           AND claimed_by = ?
           AND lease_until = ?`
      )
      .run(input.now, input.now, id, input.workerId, input.leaseUntil);
    return result.changes > 0 ? this.getEmbeddingRetry(id) : undefined;
  }

  insertSkillTrial(trial: SkillTrialRecord): SkillTrialRecord {
    this.db
      .prepare(
        `INSERT INTO skill_trials (
          id, user_id, project_id, skill_memory_id, session_id, episode_id, l1_memory_id,
          raw_turn_id, turn_id, tool_call_id, status, outcome, feedback_id, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        trial.id,
        null,
        trial.projectId ?? null,
        trial.skillMemoryId,
        trial.sessionId ?? null,
        trial.episodeId ?? null,
        trial.l1MemoryId ?? null,
        trial.rawTurnId ?? null,
        trial.turnId ?? null,
        trial.toolCallId ?? null,
        trial.status,
        trial.outcome,
        trial.feedbackId ?? null,
        trial.createdAt,
        trial.resolvedAt ?? null
      );
    return trial;
  }

  getSkillTrial(id: string): SkillTrialRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM skill_trials WHERE id = ?`)
      .get(id) as SqlSkillTrialRow | undefined;
    return row ? skillTrialFromSql(row) : undefined;
  }

  listSkillTrials(input: {
    userId?: string | null;
    skillMemoryId?: string;
    sessionId?: string;
    episodeId?: string;
    l1MemoryId?: string;
    rawTurnId?: string;
    status?: SkillTrialRecord["status"];
    outcome?: SkillTrialRecord["outcome"];
    limit?: number;
  } = {}): SkillTrialRecord[] {
    const clauses = ["1=1"];
    const params: SqlValue[] = [];
    void input.userId;
    addOptional("skill_memory_id", input.skillMemoryId);
    addOptional("session_id", input.sessionId);
    addOptional("episode_id", input.episodeId);
    addOptional("l1_memory_id", input.l1MemoryId);
    addOptional("raw_turn_id", input.rawTurnId);
    addOptional("status", input.status);
    addOptional("outcome", input.outcome);
    const rows = this.db
      .prepare(
        `SELECT *
         FROM skill_trials
         WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(...params, input.limit ?? 50) as SqlSkillTrialRow[];
    return rows.map(skillTrialFromSql);

    function addOptional(column: string, value: string | undefined): void {
      if (value === undefined) return;
      clauses.push(`${column} = ?`);
      params.push(value);
    }
  }

  updateSkillTrial(trial: SkillTrialRecord): SkillTrialRecord {
    this.db
      .prepare(
        `UPDATE skill_trials
         SET status = ?,
             outcome = ?,
             feedback_id = ?,
             resolved_at = ?
         WHERE id = ?`
      )
      .run(
        trial.status,
        trial.outcome,
        trial.feedbackId ?? null,
        trial.resolvedAt ?? null,
        trial.id
      );
    return trial;
  }

  insertDecisionRepair(input: {
    id: string;
    sessionId?: string;
    episodeId?: string;
    rawTurnId?: string;
    userId: string | null;
    projectId?: string;
    contextHash?: string;
    issue: string;
    suggestion: string;
    preference?: string;
    antiPattern?: string;
    highValueMemoryIds?: string[];
    lowValueMemoryIds?: string[];
    attachedPolicyMemoryIds?: string[];
    feedbackId?: string;
    validated?: boolean;
    source?: unknown;
    meta?: Record<string, unknown>;
    createdAt: string;
  }): DecisionRepairRecord {
    const highValueMemoryIds = input.highValueMemoryIds ?? [];
    const lowValueMemoryIds = input.lowValueMemoryIds ?? [];
    const attachedPolicyMemoryIds = input.attachedPolicyMemoryIds ?? [];
    this.db
      .prepare(
        `INSERT INTO decision_repairs (
          id, session_id, episode_id, raw_turn_id, user_id, project_id, context_hash,
          issue, suggestion, preference, anti_pattern,
          high_value_memory_ids_json, low_value_memory_ids_json, attached_policy_memory_ids_json,
          feedback_id, validated, source_json, meta_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.sessionId ?? null,
        input.episodeId ?? null,
        input.rawTurnId ?? null,
        null,
        input.projectId ?? null,
        input.contextHash ?? null,
        input.issue,
        input.suggestion,
        input.preference ?? null,
        input.antiPattern ?? null,
        toJson(highValueMemoryIds),
        toJson(lowValueMemoryIds),
        toJson(attachedPolicyMemoryIds),
        input.feedbackId ?? null,
        input.validated ? 1 : 0,
        toJson(input.source ?? {}),
        toJson(input.meta ?? {}),
        input.createdAt
      );
    return {
      id: input.id,
      sessionId: input.sessionId,
      episodeId: input.episodeId,
      rawTurnId: input.rawTurnId,
      userId: null,
      projectId: input.projectId,
      contextHash: input.contextHash,
      issue: input.issue,
      suggestion: input.suggestion,
      preference: input.preference,
      antiPattern: input.antiPattern,
      highValueMemoryIds,
      lowValueMemoryIds,
      attachedPolicyMemoryIds,
      feedbackId: input.feedbackId,
      validated: input.validated ?? false,
      source: input.source ?? {},
      meta: input.meta ?? {},
      createdAt: input.createdAt
    };
  }

  listDecisionRepairs(input: {
    userId?: string | null;
    contextHash?: string;
    since?: string;
    limit?: number;
  } = {}): DecisionRepairRecord[] {
    const clauses = ["1=1"];
    const params: SqlValue[] = [];
    if (input.contextHash) {
      clauses.push("context_hash = ?");
      params.push(input.contextHash);
    }
    if (input.since) {
      clauses.push("created_at >= ?");
      params.push(input.since);
    }
    const rows = this.db
      .prepare(
        `SELECT *
         FROM decision_repairs
         WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(...params, input.limit ?? 50) as SqlDecisionRepairRow[];
    return rows.map(decisionRepairFromSql);
  }

  getDecisionRepair(id: string): DecisionRepairRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM decision_repairs WHERE id = ?`)
      .get(id) as SqlDecisionRepairRow | undefined;
    return row ? decisionRepairFromSql(row) : undefined;
  }

  updateDecisionRepair(id: string, patch: {
    suggestion?: string;
    preference?: string;
    antiPattern?: string;
    source?: unknown;
    meta?: Record<string, unknown>;
  }): DecisionRepairRecord | undefined {
    const current = this.getDecisionRepair(id);
    if (!current) {
      return undefined;
    }
    this.db
      .prepare(
        `UPDATE decision_repairs
         SET suggestion = ?,
             preference = ?,
             anti_pattern = ?,
             source_json = ?,
             meta_json = ?
         WHERE id = ?`
      )
      .run(
        patch.suggestion ?? current.suggestion,
        patch.preference ?? current.preference ?? null,
        patch.antiPattern ?? current.antiPattern ?? null,
        toJson(patch.source ?? current.source ?? {}),
        toJson(patch.meta ?? current.meta ?? {}),
        id
      );
    return this.getDecisionRepair(id);
  }

  upsertCandidatePoolTrace(input: {
    id: string;
    userId: string | null;
    sessionId?: string;
    sourceMemoryId: string;
    candidateKey: string;
    candidateValue: string;
    score: number;
    evidence: unknown;
    createdAt: string;
    updatedAt: string;
    expiresAt?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO l2_candidate_pool (
          id, user_id, session_id, source_memory_id, candidate_key,
          candidate_value, score, status, evidence_json, created_at, updated_at,
          expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          candidate_value = excluded.candidate_value,
          score = excluded.score,
          evidence_json = excluded.evidence_json,
          updated_at = excluded.updated_at,
          expires_at = excluded.expires_at`
      )
      .run(
        input.id,
        null,
        input.sessionId ?? null,
        input.sourceMemoryId,
        input.candidateKey,
        input.candidateValue,
        input.score,
        toJson(input.evidence),
        input.createdAt,
        input.updatedAt,
        input.expiresAt ?? null
      );
  }

  listPendingCandidatePool(input: {
    userId?: string | null;
    candidateKey?: string;
    now?: string;
    limit?: number;
  }): CandidatePoolRecord[] {
    const clauses = ["status = 'pending'", "(expires_at IS NULL OR expires_at >= ?)"];
    const params: SqlValue[] = [input.now ?? nowIso()];
    if (input.candidateKey) {
      clauses.push("candidate_key = ?");
      params.push(input.candidateKey);
    }
    const rows = this.db
      .prepare(
        `SELECT *
         FROM l2_candidate_pool
         WHERE ${clauses.join(" AND ")}
         ORDER BY score DESC, updated_at DESC
         LIMIT ?`
      )
      .all(...params, input.limit ?? 1000) as SqlCandidatePoolRow[];
    const memories = new MemoryRepository(this.db, new SqliteVecStore(this.db));
    const seen = new Set<string>();
    return rows.filter(row => {
      const memory = memories.get(row.source_memory_id);
      if (!memory) return false;
      const group = memories.nativeDuplicates(memory);
      const key = `${row.candidate_key}:${group.ids[0] ?? memory.id}`;
      if (group.deleted || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map(candidatePoolFromSql);
  }

  pruneCandidatePool(now = nowIso()): number {
    const result = this.db
      .prepare(`DELETE FROM l2_candidate_pool WHERE expires_at IS NOT NULL AND expires_at < ?`)
      .run(now);
    return result.changes;
  }

  markCandidatePoolPromoted(input: {
    userId?: string | null;
    candidateKey: string;
    sourceMemoryIds: string[];
    policyId: string;
    at: string;
  }): void {
    const memories = new MemoryRepository(this.db, new SqliteVecStore(this.db));
    const sourceMemoryIds = uniq(input.sourceMemoryIds.flatMap(id => {
      const memory = memories.get(id);
      return memory ? memories.nativeDuplicates(memory).ids : [id];
    }));
    if (sourceMemoryIds.length === 0) return;
    const placeholders = sourceMemoryIds.map(() => "?").join(", ");
    this.db
      .prepare(
        `UPDATE l2_candidate_pool
         SET status = 'promoted',
             evidence_json = json_set(evidence_json, '$.policyId', ?),
             updated_at = ?
         WHERE candidate_key = ?
           AND source_memory_id IN (${placeholders})`
      )
      .run(input.policyId, input.at, input.candidateKey, ...sourceMemoryIds);
  }

  insertTracePolicyLink(input: {
    id?: string;
    userId: string | null;
    l1MemoryId: string;
    l2MemoryId: string;
    relation?: string;
    strength?: number;
    createdAt?: string;
  }): string {
    const id = input.id ?? newId("link");
    this.db
      .prepare(
        `INSERT OR IGNORE INTO trace_policy_links (
          id, user_id, l1_memory_id, l2_memory_id, relation, strength, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        null,
        input.l1MemoryId,
        input.l2MemoryId,
        input.relation ?? "supports",
        input.strength ?? 1,
        input.createdAt ?? nowIso()
      );
    return id;
  }

  listTracePolicyLinks(input: {
    userId?: string | null;
    l1MemoryId?: string;
    l2MemoryId?: string;
    limit?: number;
  } = {}): TracePolicyLinkRecord[] {
    const clauses = ["1=1"];
    const params: SqlValue[] = [];
    void input.userId;
    addOptional("l1_memory_id", input.l1MemoryId);
    addOptional("l2_memory_id", input.l2MemoryId);
    const rows = this.db
      .prepare(
        `SELECT *
         FROM trace_policy_links
         WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(...params, input.limit ?? 100) as SqlTracePolicyLinkRow[];
    return rows.map(tracePolicyLinkFromSql);

    function addOptional(column: string, value: string | undefined): void {
      if (value === undefined) return;
      clauses.push(`${column} = ?`);
      params.push(value);
    }
  }

  insertAudit(input: Omit<AuditLogRecord, "id" | "createdAt"> & {
    id?: string;
    createdAt?: string;
  }): AuditLogRecord {
    const row: AuditLogRecord = {
      id: input.id ?? newId("audit"),
      userId: null,
      sessionId: input.sessionId,
      actor: input.actor,
      action: input.action,
      targetKind: input.targetKind,
      targetId: input.targetId,
      before: input.before,
      after: input.after,
      meta: input.meta,
      createdAt: input.createdAt ?? nowIso()
    };
    const result = this.db
      .prepare(
        `INSERT INTO audit_logs (
          id, user_id, session_id, actor_json, action, target_kind, target_id,
          before_json, after_json, meta_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        row.userId,
        row.sessionId ?? null,
        toJson(row.actor),
        row.action,
        row.targetKind,
        row.targetId,
        row.before === undefined ? null : toJson(row.before),
        row.after === undefined ? null : toJson(row.after),
        toJson(row.meta),
        row.createdAt
      );
    this.scheduleLogTablePruneAfterInsert("audit_logs", Number(result.lastInsertRowid));
    return row;
  }

  listAudit(input: {
    userId?: string | null;
    targetKind?: string;
    targetId?: string;
    limit?: number;
  } = {}): AuditLogRecord[] {
    const clauses = ["1=1"];
    const params: SqlValue[] = [];
    void input.userId;
    addOptional("target_kind", input.targetKind);
    addOptional("target_id", input.targetId);
    const rows = this.db
      .prepare(
        `SELECT *
         FROM audit_logs
         WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(...params, input.limit ?? 50) as SqlAuditLogRow[];
    return rows.map(auditLogFromSql);

    function addOptional(column: string, value: string | undefined): void {
      if (value === undefined) return;
      clauses.push(`${column} = ?`);
      params.push(value);
    }
  }

  insertApiLog(input: Omit<ApiLogRecord, "id">): ApiLogRecord {
    const result = this.db
      .prepare(
        `INSERT INTO api_logs (
          tool_name, source_agent, input_json, output_json, duration_ms, success, called_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.toolName,
        input.sourceAgent ?? null,
        input.inputJson,
        input.outputJson,
        input.durationMs,
        input.success ? 1 : 0,
        input.calledAt
      );
    this.scheduleLogTablePruneAfterInsert("api_logs", Number(result.lastInsertRowid));
    return {
      ...input,
      id: Number(result.lastInsertRowid)
    };
  }

  listApiLogs(input: {
    toolNames?: Array<ApiLogRecord["toolName"]>;
    sourceAgent?: string;
    excludedSourceAgents?: string[];
    limit?: number;
    offset?: number;
  } = {}): {
    logs: ApiLogRecord[];
    total: number;
  } {
    const tools = input.toolNames?.length ? input.toolNames : ["memory_add", "memory_search"] satisfies Array<ApiLogRecord["toolName"]>;
    const placeholders = tools.map(() => "?").join(", ");
    const sourceAgent = input.sourceAgent?.trim();
    const agentFilter = sourceAgent
      ? agentIdMatchClause("source_agent", sourceAgent)
      : agentIdExclusionClause("source_agent", input.excludedSourceAgents ?? []);
    const sourceAgentFilter = agentFilter ? `AND ${agentFilter.sql}` : "";
    const parameters = agentFilter ? [...tools, ...agentFilter.params] : tools;
    const total = this.db
      .prepare(`SELECT COUNT(*) AS n FROM api_logs WHERE tool_name IN (${placeholders}) ${sourceAgentFilter}`)
      .get(...parameters) as { n: number };
    const rows = this.db
      .prepare(
        `SELECT api_logs.*
         FROM api_logs
         WHERE tool_name IN (${placeholders})
         ${sourceAgentFilter}
         ORDER BY called_at DESC, id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...parameters, input.limit ?? 50, input.offset ?? 0) as SqlApiLogRow[];
    return {
      logs: rows.map(apiLogFromSql),
      total: total.n
    };
  }

  exportBundleTables(includeRawText = false): Record<string, Array<Record<string, unknown>>> {
    const tables: Record<string, Array<Record<string, unknown>>> = {};
    for (const table of BUNDLE_TABLES) {
      const rows = this.db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
      tables[table] = rows.map((row) => {
        const projected = table === "memory_change_log" ? compactHistoryChangeRow(row) : row;
        return serializeBundleRow(table, includeRawText ? projected : redactBundleRow(table, projected));
      });
    }
    return includeRawText ? tables : normalizeRedactedL3WorldModelBundle(tables);
  }

  importBundleTables(
    tables: Record<string, unknown>,
    options: {
      conflictStrategy?: "skip" | "replace" | "error";
    } = {}
  ): {
    inserted: Record<string, number>;
    skipped: Record<string, number>;
    replaced: Record<string, number>;
    migrationMap: Record<string, Record<string, string>>;
    conflicts: Array<{
      table: string;
      primaryKey: string;
      sourceId: string;
      targetId: string;
      action: "skipped" | "replaced" | "error";
    }>;
  } {
    const conflictStrategy = options.conflictStrategy ?? "skip";
    const result = {
      inserted: {} as Record<string, number>,
      skipped: {} as Record<string, number>,
      replaced: {} as Record<string, number>,
      migrationMap: {} as Record<string, Record<string, string>>,
      conflicts: [] as Array<{
        table: string;
        primaryKey: string;
        sourceId: string;
        targetId: string;
        action: "skipped" | "replaced" | "error";
      }>
    };
    this.db.transaction(() => {
      const hadRuntimeData = Boolean(this.db.prepare(`SELECT EXISTS(
        SELECT 1 FROM memories UNION ALL SELECT 1 FROM sessions UNION ALL
        SELECT 1 FROM raw_turns UNION ALL SELECT 1 FROM source_turn_captures
      )`).pluck().get());
      for (const table of BUNDLE_TABLES) {
        const rows = Array.isArray(tables[table]) ? tables[table] as Array<Record<string, unknown>> : [];
        for (const row of rows) {
          const defaults = applyBundleDefaults(table, deserializeBundleRow(row));
          const normalized = table === "memory_change_log" ? compactHistoryChangeRow(defaults) : defaults;
          const identity = bundleIdentity(table, normalized);
          if (identity) {
            recordMigrationMap(result.migrationMap, table, identity.sourceId, identity.sourceId);
          }
          const existed = identity !== undefined && this.rowExists(table, identity.columns, identity.values);
          if (table === "runtime_kv" && normalized.key === "source_turn_capture_activated_at") {
            const outcome = this.mergeSourceTurnActivation(normalized, hadRuntimeData);
            const counts = result[outcome];
            counts[table] = (counts[table] ?? 0) + 1;
            continue;
          }
          if (existed && conflictStrategy === "skip") {
            result.conflicts.push({
              table,
              primaryKey: identity!.primaryKey,
              sourceId: identity!.sourceId,
              targetId: identity!.sourceId,
              action: "skipped"
            });
            result.skipped[table] = (result.skipped[table] ?? 0) + 1;
            continue;
          }
          if (existed && conflictStrategy === "error") {
            result.conflicts.push({
              table,
              primaryKey: identity!.primaryKey,
              sourceId: identity!.sourceId,
              targetId: identity!.sourceId,
              action: "error"
            });
            throw new Error(`import conflict for ${table}.${identity!.primaryKey}=${identity!.sourceId}`);
          }
          const columns = Object.keys(normalized)
            .filter((column) => this.tableColumns(table).includes(column));
          if (columns.length === 0) {
            continue;
          }
          const placeholders = columns.map(() => "?").join(", ");
          const values = columns.map((column) => normalizeBundleSqlValue(normalized[column]));
          const verb = conflictStrategy === "replace" ? "INSERT OR REPLACE" : "INSERT";
          this.db
            .prepare(`${verb} INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`)
            .run(...values);
          if (existed) {
            result.conflicts.push({
              table,
              primaryKey: identity!.primaryKey,
              sourceId: identity!.sourceId,
              targetId: identity!.sourceId,
              action: "replaced"
            });
            result.replaced[table] = (result.replaced[table] ?? 0) + 1;
          } else {
            result.inserted[table] = (result.inserted[table] ?? 0) + 1;
          }
        }
      }
    })();
    refreshProjectAliases(this.db);
    this.scheduleLogTablesPrune();
    this.scheduleHistoryLogCompaction(true);
    return result;
  }

  private mergeSourceTurnActivation(
    row: Record<string, unknown>,
    hadRuntimeData: boolean
  ): "inserted" | "replaced" | "skipped" {
    const imported = typeof row.value_json === "string" ? parseJson<unknown>(row.value_json, undefined) : undefined;
    if (typeof imported !== "string" || !Number.isFinite(Date.parse(imported))) {
      throw new Error("invalid source turn activation boundary in bundle");
    }
    const key = "source_turn_capture_activated_at";
    const existing = this.getKv(key);
    if (existing && (typeof existing.value !== "string" || !Number.isFinite(Date.parse(existing.value)))) {
      throw new Error("invalid source turn activation boundary in target database");
    }
    // A new database contains only the automatically initialized boundary. A full restore
    // inherits the backup's original start. Merging into existing data must never widen
    // the historical capture window of either database; known identities remain reusable.
    if (existing && (existing.value === imported ||
        (hadRuntimeData && Date.parse(existing.value as string) >= Date.parse(imported)))) {
      return "skipped";
    }
    this.setKv(key, imported, typeof row.updated_at === "string" ? row.updated_at : nowIso());
    return existing ? "replaced" : "inserted";
  }

  private rowExists(table: BundleTableName, columns: string[], values: Array<string | number | null>): boolean {
    const tableColumns = this.tableColumns(table);
    if (columns.length === 0 || columns.some((column) => !tableColumns.includes(column))) {
      return false;
    }
    const where = columns.map((column) => `${column} IS ?`).join(" AND ");
    const row = this.db.prepare(`SELECT 1 AS ok FROM ${table} WHERE ${where} LIMIT 1`).get(...values) as
      | { ok: number }
      | undefined;
    return Boolean(row);
  }

  private tableColumns(table: BundleTableName): string[] {
    return (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((column) => column.name);
  }

  private scheduleLogTablesPrune(): void {
    this.scheduleLogTablePrune("api_logs");
    this.scheduleLogTablePrune("memory_change_log");
    this.scheduleLogTablePrune("audit_logs");
  }

  private scheduleLogTablePruneAfterInsert(table: LogTableName, insertedRowid: number): void {
    if (insertedRowid <= LOG_TABLE_RETENTION_LIMIT) {
      return;
    }
    this.scheduleLogTablePrune(table);
  }

  private scheduleLogTablePrune(table: LogTableName): void {
    if (this.scheduledLogPrunes.has(table)) {
      return;
    }
    this.scheduledLogPrunes.add(table);
    setImmediate(() => {
      this.scheduledLogPrunes.delete(table);
      try {
        this.pruneLogTable(table);
      } catch {
        // Log retention is best-effort and must not affect memory write paths.
      }
    });
  }

  private pruneLogTable(table: LogTableName): number {
    const result = this.db
      .prepare(
        `DELETE FROM ${table}
         WHERE rowid IN (
           SELECT rowid
           FROM ${table}
           ORDER BY ${LOG_TABLE_RETENTION_ORDER[table]}
           LIMIT -1 OFFSET ?
         )`
      )
      .run(LOG_TABLE_RETENTION_LIMIT);
    return result.changes;
  }

  insertArtifact(input: {
    id?: string;
    sessionId?: string;
    episodeId?: string;
    rawTurnId?: string;
    userId: string | null;
    kind: string;
    uri?: string;
    payload: unknown;
    createdAt?: string;
  }): string {
    const id = input.id ?? newId("artifact");
    this.db
      .prepare(
        `INSERT INTO artifacts (
          id, session_id, episode_id, raw_turn_id, user_id, kind, uri,
          payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.sessionId ?? null,
        input.episodeId ?? null,
        input.rawTurnId ?? null,
        null,
        input.kind,
        input.uri ?? null,
        toJson(input.payload),
        input.createdAt ?? nowIso()
      );
    return id;
  }
}

export class L3WorldModelScopeWorkspaceConflictError extends Error {
  constructor() {
    super("l3_world_model_scope_workspace_conflict");
    this.name = "L3WorldModelScopeWorkspaceConflictError";
  }
}

export class L3WorldModelRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly memories: MemoryRepository
  ) {}

  getScope(_userId: string | null, projectId?: string | null): L3WorldModelScopeRecord | undefined {
    const row = this.db.prepare(
      `SELECT * FROM l3_world_model_scopes
       WHERE user_id IS NULL AND project_id IS ?`
    ).get(canonicalProjectId(this.db, projectId)) as SqlL3WorldModelScopeRow | undefined;
    return row ? l3WorldModelScopeFromSql(row, this.db) : undefined;
  }

  ensureScope(_userId: string | null, projectId?: string | null, at = nowIso()): L3WorldModelScopeRecord {
    projectId = canonicalProjectId(this.db, projectId);
    const scopeKey = l3WorldModelScopeKey(null, projectId);
    const uris = this.db.prepare(`SELECT DISTINCT workspace_uri FROM l3_world_model_scopes
      WHERE memory_project_id(project_id) IS ? AND workspace_uri IS NOT NULL`).all(projectId) as Array<{workspace_uri: string}>;
    const workspaceUri = uris.length === 1 ? uris[0]!.workspace_uri : null;
    this.db.prepare(
      `INSERT INTO l3_world_model_scopes (
         scope_key, user_id, project_id, workspace_uri, memory_id, next_scope_seq, updated_at
       ) VALUES (?, NULL, ?, ?, NULL, 1, ?)
       ON CONFLICT(scope_key) DO NOTHING`
    ).run(scopeKey, projectId, workspaceUri, at);
    return this.getScope(null, projectId)!;
  }

  bindWorkspaceUri(
    userId: string | null,
    projectId: string,
    workspaceUri: WorkspaceUri,
    at = nowIso()
  ): L3WorldModelScopeRecord {
    const scope = this.ensureScope(userId, projectId, at);
    if (scope.workspaceUri && scope.workspaceUri !== workspaceUri) {
      throw new L3WorldModelScopeWorkspaceConflictError();
    }
    if (!scope.workspaceUri) {
      this.db.prepare(
        `UPDATE l3_world_model_scopes
         SET workspace_uri = ?, updated_at = ?
         WHERE scope_key = ? AND workspace_uri IS NULL`
      ).run(workspaceUri, at, scope.scopeKey);
    }
    const bound = this.getScope(userId, projectId);
    if (!bound || bound.workspaceUri !== workspaceUri) {
      throw new L3WorldModelScopeWorkspaceConflictError();
    }
    return bound;
  }

  getScopesByMemoryIds(memoryIds: readonly string[]): L3WorldModelScopeRecord[] {
    const ids = uniq(memoryIds.filter(Boolean));
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    return (this.db.prepare(
      `SELECT * FROM l3_world_model_scopes WHERE memory_id IN (${placeholders})`
    ).all(...ids) as SqlL3WorldModelScopeRow[]).map((row) => l3WorldModelScopeFromSql(row, this.db));
  }

  registerInputTrace(input: {
    sessionId: string;
    l1MemoryId: string;
    rawTurnId: string;
    episodeId?: string | null;
    createdAt?: string;
  }): L3WorldModelInputTraceRecord {
    const session = this.requireV2Session(input.sessionId);
    const existing = this.db.prepare(
      `SELECT * FROM l3_world_model_input_traces
       WHERE session_id = ? AND l1_memory_id = ?`
    ).get(input.sessionId, input.l1MemoryId) as SqlL3WorldModelInputTraceRow | undefined;
    if (existing) return l3WorldModelInputTraceFromSql(existing);
    const next = this.db.prepare(
      `SELECT COALESCE(MAX(trace_seq), 0) + 1 AS trace_seq
       FROM l3_world_model_input_traces WHERE session_id = ?`
    ).get(session.id) as { trace_seq: number };
    const createdAt = input.createdAt ?? nowIso();
    this.db.prepare(
      `INSERT INTO l3_world_model_input_traces (
         session_id, trace_seq, l1_memory_id, raw_turn_id, episode_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(session.id, next.trace_seq, input.l1MemoryId, input.rawTurnId, input.episodeId ?? null, createdAt);
    return {
      sessionId: session.id,
      traceSeq: next.trace_seq,
      l1MemoryId: input.l1MemoryId,
      rawTurnId: input.rawTurnId,
      episodeId: input.episodeId ?? undefined,
      createdAt
    };
  }

  traceHead(sessionId: string): L3WorldModelTraceHeadResponse {
    this.requireV2Session(sessionId);
    const row = this.db.prepare(
      `SELECT l1_memory_id, trace_seq
       FROM l3_world_model_input_traces
       WHERE session_id = ?
       ORDER BY trace_seq DESC LIMIT 1`
    ).get(sessionId) as { l1_memory_id: string; trace_seq: number } | undefined;
    return row
      ? { throughL1MemoryId: row.l1_memory_id, traceSeq: row.trace_seq }
      : { throughL1MemoryId: null, traceSeq: null };
  }

  inputTraceByL1MemoryId(
    sessionId: string,
    l1MemoryId: string
  ): L3WorldModelInputTraceRecord | undefined {
    this.requireV2Session(sessionId);
    const row = this.db.prepare(
      `SELECT * FROM l3_world_model_input_traces
       WHERE session_id = ? AND l1_memory_id = ?`
    ).get(sessionId, l1MemoryId) as SqlL3WorldModelInputTraceRow | undefined;
    return row ? l3WorldModelInputTraceFromSql(row) : undefined;
  }

  /** Highest trace sequence registered for a Session, or 0 when it has none. */
  maxInputTraceSeq(sessionId: string): number {
    const row = this.db.prepare(
      `SELECT COALESCE(MAX(trace_seq), 0) AS trace_seq
       FROM l3_world_model_input_traces WHERE session_id = ?`
    ).get(sessionId) as { trace_seq: number };
    return Number(row.trace_seq);
  }

  /** Input traces for a Session in an inclusive trace sequence range, ascending. */
  listInputTracesInRange(
    sessionId: string,
    afterTraceSeq: number,
    throughTraceSeq: number
  ): L3WorldModelInputTraceRecord[] {
    return (this.db.prepare(
      `SELECT * FROM l3_world_model_input_traces
       WHERE session_id = ? AND trace_seq > ? AND trace_seq <= ?
       ORDER BY trace_seq ASC`
    ).all(sessionId, afterTraceSeq, throughTraceSeq) as SqlL3WorldModelInputTraceRow[])
      .map(l3WorldModelInputTraceFromSql);
  }

  /** Most recent input trace timestamp, used as the real last activity of a Session. */
  latestInputTraceCreatedAt(sessionId: string): string | undefined {
    const row = this.db.prepare(
      `SELECT created_at FROM l3_world_model_input_traces
       WHERE session_id = ?
       ORDER BY trace_seq DESC LIMIT 1`
    ).get(sessionId) as { created_at: string } | undefined;
    return row?.created_at;
  }

  freezeBatches(input: {
    sessionId: string;
    trigger: L3WorldModelBatchTrigger;
    throughL1MemoryId?: string;
    episodeId?: string;
    at?: string;
  }): FreezeL3WorldModelBatchesResult {
    return this.db.transaction(() => this.freezeBatchesInTransaction(input))();
  }

  /** Freeze L3 batches and run boundary-owned work in the same transaction. */
  freezeBatchesWithCallback(
    input: {
      sessionId: string;
      trigger: L3WorldModelBatchTrigger;
      throughL1MemoryId?: string;
      episodeId?: string;
      at?: string;
    },
    callback: (result: FreezeL3WorldModelBatchesResult) => void
  ): FreezeL3WorldModelBatchesResult {
    return this.db.transaction(() => {
      const result = this.freezeBatchesInTransaction(input);
      callback(result);
      return result;
    })();
  }

  getBatch(batchId: string): L3WorldModelEvidenceBatchRecord | undefined {
    const row = this.db.prepare(
      `SELECT * FROM l3_world_model_evidence_batches WHERE id = ?`
    ).get(batchId) as SqlL3WorldModelEvidenceBatchRow | undefined;
    return row ? l3WorldModelEvidenceBatchFromSql(row, this.db) : undefined;
  }

  /** Integrity checks must hash the immutable stored identity, before alias projection. */
  getStoredBatch(batchId: string): L3WorldModelEvidenceBatchRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM l3_world_model_evidence_batches WHERE id = ?`)
      .get(batchId) as SqlL3WorldModelEvidenceBatchRow | undefined;
    return row ? { ...l3WorldModelEvidenceBatchFromSql(row), userId: row.user_id } : undefined;
  }

  getTarget(batchId: string, targetField: L3WorldModelTargetField): L3WorldModelBatchTargetRecord | undefined {
    const row = this.db.prepare(
      `SELECT * FROM l3_world_model_batch_targets
       WHERE batch_id = ? AND target_field = ?`
    ).get(batchId, targetField) as SqlL3WorldModelBatchTargetRow | undefined;
    return row ? l3WorldModelBatchTargetFromSql(row) : undefined;
  }

  listBatchTraces(batchId: string): L3WorldModelInputTraceRecord[] {
    const batch = this.getBatch(batchId);
    if (!batch) return [];
    return (this.db.prepare(
      `SELECT *
       FROM l3_world_model_input_traces
       WHERE session_id = ? AND trace_seq >= ? AND trace_seq <= ?
       ORDER BY trace_seq ASC`
    ).all(batch.sessionId, batch.startTraceSeq, batch.endTraceSeq) as SqlL3WorldModelInputTraceRow[])
      .map(l3WorldModelInputTraceFromSql);
  }

  latestDeletion(projectId?: string | null): string | undefined {
    const row = this.db.prepare(`SELECT MAX(COALESCE(deleted_at, updated_at)) AS deleted_at
      FROM memories WHERE memory_layer = 'L3' AND (deleted_at IS NOT NULL OR status = 'deleted')
        AND json_extract(properties_json, '$.internal_info.schema_version') = 2
        AND memory_project_id(json_extract(info_json, '$.project_id')) IS ?`)
      .get(canonicalProjectId(this.db, projectId)) as {deleted_at: string | null};
    return row.deleted_at ?? undefined;
  }

  getMemory(_userId: string | null, projectId?: string | null): MemoryRow | undefined {
    projectId = canonicalProjectId(this.db, projectId);
    const scopes = this.db.prepare(`SELECT * FROM l3_world_model_scopes
      WHERE memory_project_id(project_id) IS ? AND memory_id IS NOT NULL
      ORDER BY (user_id IS NULL) DESC, updated_at DESC, scope_key ASC`)
      .all(projectId) as SqlL3WorldModelScopeRow[];
    const candidates = scopes.flatMap(scope => {
      const memory = this.memories.get(scope.memory_id!);
      if (!memory || memory.deletedAt) return [];
      validateL3WorldModelMemory(memory, null, projectId);
      return [{ memory, canonical: scope.user_id === null }];
    });
    if (!candidates.length) return undefined;
    const overrides = this.db.prepare(`SELECT field, deleted FROM memory_l3_overrides WHERE project_key = ?`)
      .all(projectId ?? '') as Array<{field: keyof L3WorldModelFields; deleted: number}>;
    const fields = emptyL3WorldModelFields();
    const deletedAt = this.latestDeletion(projectId);
    let profileScanId: unknown;
    for (const property of Object.keys(fields) as Array<keyof L3WorldModelFields>) {
      const override = overrides.find(row => row.field === property);
      if (override?.deleted) continue;
      for (const candidate of candidates) {
        if (override && !candidate.canonical) continue;
        if (deletedAt && (candidate.memory.updatedAt < deletedAt ||
          (!candidate.canonical && candidate.memory.updatedAt === deletedAt))) continue;
        const value = fieldsFromL3WorldModelMemory(candidate.memory)[property];
        if (value !== null) {
          fields[property] = value;
          if (property === "projectEnvironmentProfile") profileScanId = candidate.memory.info.project_environment_applied_scan_id;
          break;
        }
      }
    }
    const base = candidates[0]!.memory;
    const memoryValue = renderL3WorldModelFields(fields);
    return {
      ...base, memoryValue, contentHash: sha256Hex(memoryValue),
      info: {...base.info, project_environment_applied_scan_id: profileScanId},
      status: memoryValue ? "activated" : "archived",
      version: candidates.length > 1 || deletedAt ? Number.parseInt(sha256Hex(canonicalJson(fields)).slice(0, 12), 16) : base.version,
      properties: { ...base.properties, internal_info: {
        ...base.properties.internal_info, body: memoryValue,
        world_model: {
          general_rules_and_safety_constraints: fields.generalRulesAndSafetyConstraints,
          project_environment_profile: fields.projectEnvironmentProfile,
          project_contract: fields.projectContract,
          domain_knowledge: fields.domainKnowledge
        }
      }}
    };
  }

  fields(userId: string | null, projectId?: string | null): L3WorldModelFields {
    const memory = this.getMemory(userId, projectId);
    return memory ? fieldsFromL3WorldModelMemory(memory) : emptyL3WorldModelFields();
  }

  upsertField(input: {
    userId: string | null;
    projectId?: string | null;
    targetField: L3WorldModelFieldName;
    value: string | null;
    eligibleL1MemoryIds?: string[];
    projectEnvironmentAppliedScanId?: string | null;
    at?: string;
    source?: string;
  }): MemoryRow | undefined {
    return this.db.transaction(() => this.upsertFieldInTransaction(input))();
  }

  applyTraceTarget(input: {
    batchId: string;
    targetField: L3WorldModelTargetField;
    operation: L3WorldModelTraceTargetOperation;
    value: string;
    expectedFieldHash: string;
    expectedProfileHash?: string;
    eligibleL1MemoryIds: string[];
    at?: string;
  }): ApplyL3WorldModelTraceTargetResult {
    return this.db.transaction(() => {
      const at = input.at ?? nowIso();
      const batch = this.getBatch(input.batchId);
      if (!batch) throw new Error(`L3 World Model batch not found: ${input.batchId}`);
      const target = this.getTarget(input.batchId, input.targetField);
      if (!target) throw new Error(`L3 World Model target not found: ${input.batchId}:${input.targetField}`);
      if (target.status === "applied") {
        return {
          alreadyApplied: true,
          noChange: target.noChange,
          memory: this.getMemory(batch.userId, batch.projectId)
        };
      }
      if (target.status === "dead_letter") {
        throw new Error(`L3 World Model target is terminal: ${input.batchId}:${input.targetField}`);
      }
      const expectedScopeKey = l3WorldModelFieldScopeKey(
        batch.scopeKey,
        input.targetField
      );
      if (target.fieldScopeKey !== expectedScopeKey || target.scopeSeq !== batch.scopeSeq) {
        throw new Error("corrupt L3 World Model target ownership");
      }
      assertL3WorldModelFieldOwnership(batch.projectId ?? null, input.targetField);

      const fields = this.fields(batch.userId, batch.projectId);
      const currentField = fields[l3WorldModelFieldProperty(input.targetField)];
      if (sha256Hex(currentField ?? "") !== input.expectedFieldHash) {
        throw new Error("stale_l3_base");
      }
      if (input.targetField !== "general_rules_and_safety_constraints") {
        if (!input.expectedProfileHash) throw new TypeError("project target requires expectedProfileHash");
        if (sha256Hex(fields.projectEnvironmentProfile ?? "") !== input.expectedProfileHash) {
          throw new Error("stale_l3_base");
        }
      }

      let noChange = false;
      let memory = this.getMemory(batch.userId, batch.projectId);
      const deletedAt = this.latestDeletion(batch.projectId);
      if (deletedAt && batch.createdAt <= deletedAt) {
        // An immutable pre-upgrade batch must not recreate a subsequently deleted scope.
        noChange = true;
      } else if (input.operation === "noop") {
        if (input.value !== "") throw new TypeError("noop L3 World Model output must be empty");
        noChange = true;
      } else if (input.operation === "create") {
        if (currentField !== null || !input.value.trim()) {
          throw new TypeError("create L3 World Model output requires an empty base and non-empty value");
        }
        memory = this.upsertFieldInTransaction({
          userId: batch.userId,
          projectId: batch.projectId,
          targetField: input.targetField,
          value: input.value,
          eligibleL1MemoryIds: input.eligibleL1MemoryIds,
          at
        });
      } else {
        if (currentField === null || input.value === currentField) {
          throw new TypeError("update L3 World Model output requires a non-empty changed base");
        }
        memory = this.upsertFieldInTransaction({
          userId: batch.userId,
          projectId: batch.projectId,
          targetField: input.targetField,
          value: input.value || null,
          eligibleL1MemoryIds: input.eligibleL1MemoryIds,
          at
        });
      }
      this.db.prepare(
        `UPDATE l3_world_model_batch_targets
         SET status = 'applied', no_change = ?, applied_at = ?, updated_at = ?
         WHERE batch_id = ? AND target_field = ? AND status = 'queued'`
      ).run(noChange ? 1 : 0, at, at, input.batchId, input.targetField);
      updateL3WorldModelBatchTerminalOutcome(this.db, input.batchId, at);
      return { alreadyApplied: false, noChange, memory };
    })();
  }

  deleteScopeMemory(memoryId: string, at = nowIso()): DeleteL3WorldModelScopeResult | undefined {
    return this.db.transaction(() => {
      const scopeRow = this.db.prepare(
        `SELECT * FROM l3_world_model_scopes WHERE memory_id = ?`
      ).get(memoryId) as SqlL3WorldModelScopeRow | undefined;
      if (!scopeRow) return undefined;
      const scope = l3WorldModelScopeFromSql(scopeRow, this.db);
      for (const field of Object.keys(emptyL3WorldModelFields())) {
        this.db.prepare(`INSERT INTO memory_l3_overrides(project_key, field, deleted) VALUES (?, ?, 1)
          ON CONFLICT(project_key, field) DO UPDATE SET deleted = 1`).run(scope.projectId ?? "", field);
      }
      const before = this.memories.get(memoryId);
      if (!before) throw new Error(`corrupt L3 World Model scope memory: ${memoryId}`);
      validateL3WorldModelMemory(before, scope.userId, scope.projectId);
      const deleted = this.memories.softDelete(memoryId, at);
      if (!deleted) throw new Error(`failed to delete L3 World Model memory: ${memoryId}`);
      this.db.prepare(
        `UPDATE l3_world_model_scopes SET memory_id = NULL, updated_at = ? WHERE scope_key = ?`
      ).run(at, scope.scopeKey);

      const pendingTargets = this.db.prepare(
        `SELECT target.batch_id, target.target_field
         FROM l3_world_model_batch_targets AS target
         JOIN l3_world_model_evidence_batches AS batch ON batch.id = target.batch_id
         WHERE memory_project_id(batch.project_id) IS ? AND target.status = 'queued'`
      ).all(scope.projectId ?? null) as Array<{ batch_id: string; target_field: L3WorldModelTargetField }>;
      const affectedBatchIds = new Set<string>();
      for (const target of pendingTargets) {
        const job = this.db.prepare(
          `SELECT id FROM evolution_jobs
           WHERE job_type = 'l3_world_model_update'
             AND json_extract(payload_json, '$.batchId') = ?
             AND json_extract(payload_json, '$.targetField') = ?
             AND status IN ('queued', 'leased', 'failed')`
        ).get(target.batch_id, target.target_field) as { id: string } | undefined;
        if (!job) continue;
        this.db.prepare(
          `UPDATE l3_world_model_batch_targets
           SET status = 'applied', no_change = 1, applied_at = ?, updated_at = ?
           WHERE batch_id = ? AND target_field = ? AND status = 'queued'`
        ).run(at, at, target.batch_id, target.target_field);
        this.db.prepare(
          `UPDATE evolution_jobs
           SET status = 'succeeded', leased_until = NULL, updated_at = ? WHERE id = ?`
        ).run(at, job.id);
        affectedBatchIds.add(target.batch_id);
      }
      for (const batchId of affectedBatchIds) {
        updateL3WorldModelBatchTerminalOutcome(this.db, batchId, at);
      }

      if (scope.projectId) {
        this.db.prepare(
          `UPDATE evolution_jobs
           SET status = 'succeeded', leased_until = NULL, last_error = NULL, updated_at = ?
           WHERE job_type = 'project_environment_profile'
             AND memory_project_id(json_extract(payload_json, '$.projectId')) = ?
             AND status IN ('queued', 'failed')`
        ).run(at, scope.projectId);
        this.db.prepare(
          `UPDATE l3_world_model_project_environment_state
           SET project_kind = 'unknown', status = 'uninitialized', current_scan_id = NULL,
               applied_scan_id = NULL, fingerprint = NULL, last_error = NULL, updated_at = ?
           WHERE memory_project_id(project_id) = ?`
        ).run(at, scope.projectId);
      }
      return { before, deleted, scope };
    })();
  }

  insertImmutableJob(job: EvolutionJobRecord): EvolutionJobRecord {
    job = { ...job, userId: null };
    if (job.jobType !== "l3_world_model_update" && job.jobType !== "project_environment_profile") {
      throw new TypeError("immutable L3 job must use an L3 World Model job type");
    }
    if (!job.dedupeKey) {
      throw new TypeError("immutable L3 job requires dedupeKey");
    }
    if (job.jobType === "l3_world_model_update" && (!job.scopeKey || job.scopeSeq === undefined)) {
      throw new TypeError("L3 field update job requires scopeKey and scopeSeq");
    }
    if (job.jobType === "project_environment_profile" && (job.scopeKey || job.scopeSeq !== undefined)) {
      throw new TypeError("project environment job must not enter Trace field FIFO");
    }
    if (job.status !== "queued" || job.attempts !== 0) {
      throw new TypeError("immutable L3 job must start queued with zero attempts");
    }
    this.db.prepare(
      `INSERT INTO evolution_jobs (
         id, job_type, status, dedupe_key, user_id, session_id, episode_id,
         target_memory_id, scope_key, scope_seq, payload_json, attempts,
         max_attempts, leased_until, last_error, created_at, updated_at
       ) VALUES (
         @id, @jobType, @status, @dedupeKey, @userId, @sessionId, @episodeId,
         @targetMemoryId, @scopeKey, @scopeSeq, @payloadJson, @attempts,
         @maxAttempts, @leasedUntil, @lastError, @createdAt, @updatedAt
       )`
    ).run({
      ...job,
      sessionId: job.sessionId ?? null,
      episodeId: job.episodeId ?? null,
      targetMemoryId: job.targetMemoryId ?? null,
      scopeKey: job.scopeKey ?? null,
      scopeSeq: job.scopeSeq ?? null,
      payloadJson: toJson(job.payload),
      leasedUntil: job.leasedUntil ?? null,
      lastError: job.lastError ?? null
    });
    return job;
  }

  private freezeBatchesInTransaction(input: {
    sessionId: string;
    trigger: L3WorldModelBatchTrigger;
    throughL1MemoryId?: string;
    episodeId?: string;
    at?: string;
  }): FreezeL3WorldModelBatchesResult {
    const session = this.requireV2Session(input.sessionId);
    const at = input.at ?? nowIso();
    this.db.prepare(
      `INSERT INTO l3_world_model_session_cursors (session_id, last_scheduled_seq, updated_at)
       VALUES (?, 0, ?)
       ON CONFLICT(session_id) DO NOTHING`
    ).run(session.id, at);
    const cursor = this.db.prepare(
      `SELECT last_scheduled_seq FROM l3_world_model_session_cursors WHERE session_id = ?`
    ).get(session.id) as { last_scheduled_seq: number };

    let endTraceSeq: number;
    if (input.throughL1MemoryId) {
      const through = this.db.prepare(
        `SELECT trace_seq FROM l3_world_model_input_traces
         WHERE session_id = ? AND l1_memory_id = ?`
      ).get(session.id, input.throughL1MemoryId) as { trace_seq: number } | undefined;
      if (!through) throw new Error("through L1 memory does not belong to the L3 World Model session trace");
      endTraceSeq = through.trace_seq;
    } else if (input.trigger === "episode_idle_close") {
      if (!input.episodeId) throw new TypeError("episode_idle_close requires episodeId");
      const end = this.db.prepare(
        `SELECT COALESCE(MAX(trace_seq), 0) AS trace_seq
         FROM l3_world_model_input_traces
         WHERE session_id = ? AND episode_id = ?`
      ).get(session.id, input.episodeId) as { trace_seq: number };
      endTraceSeq = end.trace_seq;
    } else {
      const end = this.db.prepare(
        `SELECT COALESCE(MAX(trace_seq), 0) AS trace_seq
         FROM l3_world_model_input_traces WHERE session_id = ?`
      ).get(session.id) as { trace_seq: number };
      endTraceSeq = end.trace_seq;
    }

    if (endTraceSeq <= cursor.last_scheduled_seq) {
      return {
        scheduled: false,
        throughL1MemoryId: input.throughL1MemoryId,
        throughTraceSeq: endTraceSeq || undefined,
        batchIds: [],
        targetCount: 0
      };
    }
    const traces = (this.db.prepare(
      `SELECT * FROM l3_world_model_input_traces
       WHERE session_id = ? AND trace_seq > ? AND trace_seq <= ?
       ORDER BY trace_seq ASC`
    ).all(session.id, cursor.last_scheduled_seq, endTraceSeq) as SqlL3WorldModelInputTraceRow[])
      .map(l3WorldModelInputTraceFromSql);
    if (traces.length === 0) {
      return { scheduled: false, batchIds: [], targetCount: 0 };
    }

    const chunks = splitL3TracesByRawTurn(traces, 20);
    const scope = this.ensureScope(session.userId, session.projectId, at);
    const batchIds: string[] = [];
    let targetCount = 0;
    for (const chunk of chunks) {
      const claimed = this.db.prepare(
        `UPDATE l3_world_model_scopes
         SET next_scope_seq = next_scope_seq + 1, updated_at = ?
         WHERE scope_key = ?
         RETURNING next_scope_seq - 1 AS scope_seq`
      ).get(at, scope.scopeKey) as { scope_seq: number } | undefined;
      if (!claimed) throw new Error("failed to claim L3 World Model scope sequence");
      const l1MemoryIds = chunk.map((trace) => trace.l1MemoryId);
      const rawTurnIds = [...new Set(chunk.map((trace) => trace.rawTurnId))];
      const feedbackIds = this.feedbackIdsForBatch(l1MemoryIds, rawTurnIds);
      const payload = {
        scopeKey: scope.scopeKey,
        scopeSeq: claimed.scope_seq,
        userId: null,
        projectId: session.projectId ?? null,
        sessionId: session.id,
        trigger: input.trigger,
        startTraceSeq: chunk[0]!.traceSeq,
        endTraceSeq: chunk.at(-1)!.traceSeq,
        l1MemoryIds,
        rawTurnIds,
        feedbackIds
      };
      const batchId = newId("l3wm_batch");
      const payloadHash = sha256Hex(canonicalJson(payload));
      this.db.prepare(
        `INSERT INTO l3_world_model_evidence_batches (
           id, scope_key, scope_seq, user_id, project_id, session_id, trigger,
           start_trace_seq, end_trace_seq, l1_memory_ids_json, raw_turn_ids_json,
           feedback_ids_json, payload_hash, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        batchId,
        scope.scopeKey,
        claimed.scope_seq,
        null,
        session.projectId ?? null,
        session.id,
        input.trigger,
        payload.startTraceSeq,
        payload.endTraceSeq,
        toJson(l1MemoryIds),
        toJson(rawTurnIds),
        toJson(feedbackIds),
        payloadHash,
        at,
        at
      );
      const targetFields: L3WorldModelTargetField[] = session.projectId
        ? ["project_contract", "domain_knowledge"]
        : ["general_rules_and_safety_constraints"];
      for (const targetField of targetFields) {
        const fieldScopeKey = l3WorldModelFieldScopeKey(scope.scopeKey, targetField);
        this.db.prepare(
          `INSERT INTO l3_world_model_batch_targets (
             batch_id, target_field, field_scope_key, scope_seq, status, no_change, updated_at
           ) VALUES (?, ?, ?, ?, 'queued', 0, ?)`
        ).run(batchId, targetField, fieldScopeKey, claimed.scope_seq, at);
        this.insertImmutableJob({
          id: newId("job"),
          jobType: "l3_world_model_update",
          status: "queued",
          dedupeKey: `l3_world_model:${batchId}:${targetField}`,
          userId: null,
          sessionId: session.id,
          scopeKey: fieldScopeKey,
          scopeSeq: claimed.scope_seq,
          payload: { batchId, targetField },
          attempts: 0,
          maxAttempts: 3,
          createdAt: at,
          updatedAt: at
        });
        targetCount += 1;
      }
      batchIds.push(batchId);
    }
    this.db.prepare(
      `UPDATE l3_world_model_session_cursors
       SET last_scheduled_seq = ?, updated_at = ? WHERE session_id = ?`
    ).run(endTraceSeq, at, session.id);
    return {
      scheduled: true,
      throughL1MemoryId: traces.at(-1)?.l1MemoryId,
      throughTraceSeq: endTraceSeq,
      batchIds,
      targetCount
    };
  }

  private upsertFieldInTransaction(input: {
    userId: string | null;
    projectId?: string | null;
    targetField: L3WorldModelFieldName;
    value: string | null;
    eligibleL1MemoryIds?: string[];
    projectEnvironmentAppliedScanId?: string | null;
    at?: string;
    source?: string;
  }): MemoryRow | undefined {
    const projectId = canonicalProjectId(this.db, input.projectId);
    assertL3WorldModelFieldOwnership(projectId, input.targetField);
    const at = input.at ?? nowIso();
    const scope = this.ensureScope(input.userId, projectId, at);
    const existing = scope.memoryId ? this.memories.get(scope.memoryId) : undefined;
    if (scope.memoryId && !existing) throw new Error(`corrupt L3 World Model scope memory: ${scope.memoryId}`);
    if (existing) validateL3WorldModelMemory(existing, input.userId, projectId);
    const fields = this.fields(null, projectId);
    const property = l3WorldModelFieldProperty(input.targetField);
    fields[property] = normalizeL3WorldModelFieldValue(input.value);
    this.db.prepare(`INSERT INTO memory_l3_overrides(project_key, field, deleted) VALUES (?, ?, ?)
      ON CONFLICT(project_key, field) DO UPDATE SET deleted = excluded.deleted`)
      .run(projectId ?? "", property, fields[property] === null ? 1 : 0);
    const memoryValue = renderL3WorldModelFields(fields);
    if (!existing && !memoryValue) return undefined;

    const existingSourceMemoryIds = l3WorldModelSourceMemoryIds(existing);
    const sourceMemoryIds = input.eligibleL1MemoryIds === undefined
      ? existingSourceMemoryIds
      : this.orderedRecentSourceMemoryIds(
          scope.scopeKey,
          existingSourceMemoryIds,
          input.eligibleL1MemoryIds,
          256
        );
    const title = projectId ? "项目场域认知" : "通用规则与安全约束";
    const summary = [...memoryValue.replace(/\s+/gu, " ").trim()].slice(0, 240).join("");
    const tags = ["world_model", "l3_world_model", projectId ? "scope:project" : "scope:no_project"];
    const info: Record<string, unknown> = {
      ...(projectId ? { project_id: projectId } : {}),
      source_memory_ids: sourceMemoryIds
    };
    const existingScanId = existing?.info.project_environment_applied_scan_id;
    const scanId = input.projectEnvironmentAppliedScanId === undefined
      ? existingScanId
      : input.projectEnvironmentAppliedScanId;
    if (projectId && typeof scanId === "string" && scanId) {
      info.project_environment_applied_scan_id = scanId;
    }
    const status = memoryValue ? "activated" as const : "archived" as const;
    const memory: MemoryRow = {
      id: existing?.id ?? newId("memory"),
      timeline: existing?.timeline ?? at,
      userId: null,
      memoryType: "LongTermMemory",
      status,
      visibility: "private",
      memoryKey: l3WorldModelMemoryKey(input.userId, projectId),
      memoryValue,
      tags,
      info,
      properties: {
        memory_type: "LongTermMemory",
        status,
        tags,
        info: { ...info },
        internal_info: {
          memory_layer: "L3",
          memory_kind: "world_model",
          schema_version: 2,
          source: "worker.l3_world_model.v1",
          plugin_algorithm: "l3_world_model.v1",
          source_memory_ids: sourceMemoryIds,
          title,
          summary,
          body: memoryValue,
          world_model: {
            general_rules_and_safety_constraints: fields.generalRulesAndSafetyConstraints,
            project_environment_profile: fields.projectEnvironmentProfile,
            project_contract: fields.projectContract,
            domain_knowledge: fields.domainKnowledge
          }
        }
      },
      memoryLayer: "L3",
      contentHash: sha256Hex(memoryValue),
      version: existing?.version ?? 1,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
      deletedAt: null
    };
    const saved = existing ? this.memories.update(memory) : this.memories.insert(memory);
    this.db.prepare(
      `UPDATE l3_world_model_scopes SET memory_id = ?, updated_at = ? WHERE scope_key = ?`
    ).run(saved.id, at, scope.scopeKey);
    this.db.prepare(
      `INSERT INTO memory_change_log (
         memory_id, namespace_id, kind, op, entity_id, user_id,
         change_type, version, before_json, after_json, source, created_at
       ) VALUES (?, ?, 'world_model', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      saved.id,
      scope.scopeKey,
      existing ? (status === "archived" ? "archived" : "updated") : "created",
      saved.id,
      null,
      existing ? "l3_world_model_update" : "l3_world_model_create",
      saved.version,
      existing ? toJson(existing) : null,
      toJson(saved),
      input.source ?? "worker.l3_world_model.v1",
      at
    );
    return saved;
  }

  private feedbackIdsForBatch(l1MemoryIds: string[], rawTurnIds: string[]): string[] {
    const l1Placeholders = l1MemoryIds.map(() => "?").join(", ");
    const rawPlaceholders = rawTurnIds.map(() => "?").join(", ");
    const rows = this.db.prepare(
      `SELECT id FROM feedback
       WHERE raw_turn_id IN (${rawPlaceholders})
          OR l1_memory_id IN (${l1Placeholders})
       ORDER BY created_at ASC, id ASC`
    ).all(...rawTurnIds, ...l1MemoryIds) as Array<{ id: string }>;
    return [...new Set(rows.map((row) => row.id))];
  }

  private orderedRecentSourceMemoryIds(
    scopeKey: string,
    existing: string[],
    incoming: string[],
    limit: number
  ): string[] {
    const candidates = new Set([...existing, ...incoming.filter(Boolean)]);
    if (candidates.size === 0) return [];
    const rows = this.db.prepare(
      `SELECT batch.scope_seq, trace.trace_seq, trace.l1_memory_id
       FROM l3_world_model_evidence_batches AS batch
       JOIN l3_world_model_input_traces AS trace
         ON trace.session_id = batch.session_id
        AND trace.trace_seq BETWEEN batch.start_trace_seq AND batch.end_trace_seq
       WHERE batch.scope_key = ?
       ORDER BY batch.scope_seq ASC, trace.trace_seq ASC, trace.l1_memory_id ASC`
    ).all(scopeKey) as Array<{ scope_seq: number; trace_seq: number; l1_memory_id: string }>;
    const ordered: string[] = [];
    const ranked = new Set<string>();
    for (const row of rows) {
      if (!candidates.has(row.l1_memory_id) || ranked.has(row.l1_memory_id)) continue;
      ranked.add(row.l1_memory_id);
      ordered.push(row.l1_memory_id);
    }
    const unranked = [...candidates].filter((id) => !ranked.has(id));
    const merged = [...unranked, ...ordered];
    return merged.slice(Math.max(0, merged.length - limit));
  }

  private requireV2Session(sessionId: string): SessionRecord {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId) as SqlSessionRow | undefined;
    if (!row) throw new Error(`session not found: ${sessionId}`);
    const session = sessionFromSql(row, this.db);
    if (session.meta.l3_world_model_protocol_version !== 2) {
      throw new Error("l3_world_model_protocol_v2_required");
    }
    return session;
  }
}

interface SqlProjectEnvironmentStateRow {
  user_id: string;
  project_id: string;
  project_kind: ProjectEnvironmentKind;
  status: ProjectEnvironmentStateRecord["status"];
  current_scan_id: string | null;
  applied_scan_id: string | null;
  fingerprint: string | null;
  last_error: string | null;
  updated_at: string;
}

export class ProjectEnvironmentRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly l3WorldModels: L3WorldModelRepository,
    private readonly runtime: RuntimeRepository
  ) {}

  getState(userId: string | null, projectId: string): ProjectEnvironmentStateRecord | undefined {
    const row = this.db.prepare(
      `SELECT * FROM l3_world_model_project_environment_state
       WHERE memory_project_id(project_id) = ?
       ORDER BY (user_id IS NULL) DESC, updated_at DESC, project_id ASC LIMIT 1`
    ).get(canonicalProjectId(this.db, projectId)) as SqlProjectEnvironmentStateRow | undefined;
    return row ? projectEnvironmentStateFromSql(row, this.db) : undefined;
  }

  requestScan(input: {
    userId: string | null;
    projectId: string;
    sessionId: string;
    trigger: "session_start" | "token_compaction";
    dedupeKey: string;
    at?: string;
  }): { job: EvolutionJobRecord; enqueued: boolean } {
    return this.db.transaction(() => {
      const existing = this.runtime.getJobByDedupeKey(input.dedupeKey);
      if (existing) return { job: existing, enqueued: false };
      const at = input.at ?? nowIso();
      const scanId = newId("l3wm_scan");
      this.l3WorldModels.ensureScope(input.userId, input.projectId, at);
      this.db.prepare(
        `INSERT INTO l3_world_model_project_environment_state (
           user_id, project_id, project_kind, status, current_scan_id,
           applied_scan_id, fingerprint, last_error, updated_at
         ) VALUES (?, ?, 'unknown', 'queued', ?, NULL, NULL, NULL, ?)
         ON CONFLICT(project_id) WHERE user_id IS NULL DO UPDATE SET
           status = 'queued', current_scan_id = excluded.current_scan_id,
           last_error = NULL, updated_at = excluded.updated_at`
      ).run(null, canonicalProjectId(this.db, input.projectId), scanId, at);
      const job: EvolutionJobRecord = {
        id: newId("job"),
        jobType: "project_environment_profile",
        status: "queued",
        dedupeKey: input.dedupeKey,
        userId: null,
        sessionId: input.sessionId,
        payload: {
          userId: null,
          projectId: input.projectId,
          scanId,
          trigger: input.trigger
        },
        attempts: 0,
        maxAttempts: 3,
        createdAt: at,
        updatedAt: at
      };
      this.l3WorldModels.insertImmutableJob(job);
      return { job, enqueued: true };
    })();
  }

  beginScan(userId: string | null, projectId: string, scanId: string, at = nowIso()): boolean {
    const result = this.db.prepare(
      `UPDATE l3_world_model_project_environment_state
       SET status = 'scanning', last_error = NULL, updated_at = ?
       WHERE memory_project_id(project_id) = memory_project_id(?) AND current_scan_id = ?`
    ).run(at, projectId, scanId);
    return result.changes === 1;
  }

  markSummarizing(userId: string | null, projectId: string, scanId: string, at = nowIso()): boolean {
    const result = this.db.prepare(
      `UPDATE l3_world_model_project_environment_state
       SET status = 'summarizing', updated_at = ?
       WHERE memory_project_id(project_id) = memory_project_id(?) AND current_scan_id = ?`
    ).run(at, projectId, scanId);
    return result.changes === 1;
  }

  markCleanWithoutModel(input: {
    userId: string | null;
    projectId: string;
    scanId: string;
    projectKind: Exclude<ProjectEnvironmentKind, "unknown">;
    at?: string;
  }): boolean {
    const at = input.at ?? nowIso();
    const result = this.db.prepare(
      `UPDATE l3_world_model_project_environment_state
       SET project_kind = ?, status = 'clean', last_error = NULL, updated_at = ?
       WHERE memory_project_id(project_id) = memory_project_id(?) AND current_scan_id = ?`
    ).run(
      input.projectKind,
      at,
      input.projectId,
      input.scanId
    );
    return result.changes === 1;
  }

  applyProfile(input: {
    userId: string | null;
    projectId: string;
    scanId: string;
    projectKind: Exclude<ProjectEnvironmentKind, "unknown">;
    fingerprint: string;
    expectedCurrentProfile: string | null;
    operation: "noop" | "create" | "update";
    profile: string;
    at?: string;
  }): { stale: boolean } {
    return this.db.transaction(() => {
      const at = input.at ?? nowIso();
      const state = this.getState(input.userId, input.projectId);
      if (!state || state.currentScanId !== input.scanId) return { stale: true };
      const currentProfile = this.l3WorldModels.fields(input.userId, input.projectId).projectEnvironmentProfile;
      if (currentProfile !== input.expectedCurrentProfile) {
        throw new Error("project_environment_profile_concurrent_update");
      }
      const typeChanged = state.projectKind !== "unknown" && state.projectKind !== input.projectKind;
      if (typeChanged && currentProfile !== null && input.operation === "noop") {
        throw new Error("project_environment_profile_type_change_requires_update");
      }

      let nextProfile = currentProfile;
      if (input.operation === "noop") {
        if (input.profile !== "") throw new TypeError("noop project profile must be empty");
      } else if (input.operation === "create") {
        if (currentProfile !== null || !input.profile.trim()) throw new TypeError("invalid project profile create");
        nextProfile = input.profile;
      } else {
        if (
          currentProfile === null ||
          input.profile === currentProfile ||
          (input.profile !== "" && !input.profile.trim())
        ) throw new TypeError("invalid project profile update");
        nextProfile = input.profile || null;
      }

      const emptyNoop = input.operation === "noop" && nextProfile === null;
      const existingMemory = this.l3WorldModels.getMemory(input.userId, input.projectId);
      if (!emptyNoop && (nextProfile !== null || existingMemory)) {
        this.l3WorldModels.upsertField({
          userId: null,
          projectId: input.projectId,
          targetField: "project_environment_profile",
          value: nextProfile,
          projectEnvironmentAppliedScanId: input.scanId,
          at,
          source: "project_environment"
        });
      }
      const result = this.db.prepare(
        `UPDATE l3_world_model_project_environment_state
         SET project_kind = ?, status = 'clean', applied_scan_id = ?, fingerprint = ?,
             last_error = NULL, updated_at = ?
         WHERE memory_project_id(project_id) = memory_project_id(?) AND current_scan_id = ?`
      ).run(
        input.projectKind,
        emptyNoop ? null : input.scanId,
        emptyNoop ? null : input.fingerprint,
        at,
        input.projectId,
        input.scanId
      );
      return { stale: result.changes !== 1 };
    })();
  }

  failCurrentScan(userId: string | null, projectId: string, scanId: string, error: string, at = nowIso()): void {
    this.db.prepare(
      `UPDATE l3_world_model_project_environment_state
       SET status = 'failed', last_error = ?, updated_at = ?
       WHERE memory_project_id(project_id) = memory_project_id(?) AND current_scan_id = ?`
    ).run(error, at, projectId, scanId);
  }
}

function projectEnvironmentStateFromSql(row: SqlProjectEnvironmentStateRow, db?: Database.Database): ProjectEnvironmentStateRecord {
  return {
    userId: null,
    projectId: row.project_id,
    projectKind: row.project_kind,
    status: row.status,
    currentScanId: row.current_scan_id ?? undefined,
    appliedScanId: row.applied_scan_id ?? undefined,
    fingerprint: row.fingerprint ?? undefined,
    lastError: row.last_error ?? undefined,
    updatedAt: row.updated_at
  };
}

export class Repositories {
  readonly memories: MemoryRepository;
  readonly captureClaims: MemoryCaptureClaimRepository;
  readonly userMemories: UserMemoryRepository;
  readonly processing: MemoryProcessingRepository;
  readonly runtime: RuntimeRepository;
  readonly l3WorldModels: L3WorldModelRepository;
  readonly projectEnvironments: ProjectEnvironmentRepository;
  readonly vectors: SqliteVecStore;

  constructor(readonly db: Database.Database) {
    installDeviceScope(db);
    this.vectors = new SqliteVecStore(db);
    this.memories = new MemoryRepository(db, this.vectors);
    this.captureClaims = new MemoryCaptureClaimRepository(db);
    this.userMemories = new UserMemoryRepository(db);
    this.processing = new MemoryProcessingRepository(db);
    this.runtime = new RuntimeRepository(db);
    this.l3WorldModels = new L3WorldModelRepository(db, this.memories);
    this.projectEnvironments = new ProjectEnvironmentRepository(db, this.l3WorldModels, this.runtime);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  clearAllMemoryData(): Record<string, number> {
    const existing = new Set(
      (this.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").pluck().all() as unknown[])
        .map(String)
    );
    const vectorTables = [...existing].filter((name) => /^memory_vec_\d+$/.test(name));
    const tables = [...new Set([...vectorTables, ...CLEAR_MEMORY_TABLES])].filter((name) => existing.has(name));
    const foreignKeysEnabled = this.db.pragma("foreign_keys", { simple: true }) === 1;
    this.db.pragma("foreign_keys = OFF");
    try {
      return this.db.transaction(() => {
        const cleared: Record<string, number> = {};
        for (const table of tables) {
          if (table === "runtime_kv") {
            cleared[table] = this.db.prepare(`DELETE FROM runtime_kv WHERE key != 'source_turn_capture_activated_at'`).run().changes;
          } else {
            cleared[table] = this.db.prepare(`DELETE FROM "${table}"`).run().changes;
          }
        }
        // A full clear resets capture identities so explicitly rescanning the same
        // source history can import it again. Individual deletions keep tombstones.
        if (existing.has("sqlite_sequence")) {
          const sequenceTables = tables.filter((table) => !table.startsWith("memory_vec_"));
          if (sequenceTables.length) {
            this.db.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${sequenceTables.map(() => "?").join(", ")})`)
              .run(...sequenceTables);
          }
        }
        return cleared;
      })();
    } finally {
      if (foreignKeysEnabled) this.db.pragma("foreign_keys = ON");
    }
  }
}

interface SqlL3WorldModelScopeRow {
  scope_key: string;
  user_id: string;
  project_id: string | null;
  workspace_uri: string | null;
  memory_id: string | null;
  next_scope_seq: number;
  updated_at: string;
}

interface SqlL3WorldModelInputTraceRow {
  session_id: string;
  trace_seq: number;
  l1_memory_id: string;
  raw_turn_id: string;
  episode_id: string | null;
  created_at: string;
}

interface SqlL3WorldModelEvidenceBatchRow {
  id: string;
  scope_key: string;
  scope_seq: number;
  user_id: string;
  project_id: string | null;
  session_id: string;
  trigger: L3WorldModelBatchTrigger;
  start_trace_seq: number;
  end_trace_seq: number;
  l1_memory_ids_json: string;
  raw_turn_ids_json: string;
  feedback_ids_json: string;
  payload_hash: string;
  terminal_outcome: L3WorldModelEvidenceBatchRecord["terminalOutcome"] | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SqlL3WorldModelBatchTargetRow {
  batch_id: string;
  target_field: L3WorldModelTargetField;
  field_scope_key: string;
  scope_seq: number;
  status: L3WorldModelBatchTargetRecord["status"];
  no_change: number;
  applied_at: string | null;
  updated_at: string;
}

export function l3WorldModelScopeKey(userId: string | null, projectId?: string | null): string {
  return `l3wm:${sha256Hex(canonicalJson({ scope: "device", projectId: projectId ?? null }))}`;
}

export function l3WorldModelFieldScopeKey(
  scopeKey: string,
  targetField: L3WorldModelTargetField
): string {
  return `${scopeKey}:${targetField}`;
}

export function l3WorldModelMemoryKey(userId: string | null, projectId?: string | null): string {
  return projectId
    ? `world_model:device:project:${projectId}`
    : `world_model:device:general_rules`;
}

export function isL3WorldModelV2Memory(memory: MemoryRow): boolean {
  try {
    validateL3WorldModelMemory(
      memory,
      null,
      projectIdFromL3WorldModelMemory(memory)
    );
    return true;
  } catch {
    return false;
  }
}

export function fieldsFromL3WorldModelMemory(memory: MemoryRow): L3WorldModelFields {
  const world = memory.properties.internal_info.world_model;
  if (!isRecordLike(world)) throw new Error(`invalid L3 World Model v2 fields: ${memory.id}`);
  return {
    generalRulesAndSafetyConstraints: nullableString(world.general_rules_and_safety_constraints, memory.id),
    projectEnvironmentProfile: nullableString(world.project_environment_profile, memory.id),
    projectContract: nullableString(world.project_contract, memory.id),
    domainKnowledge: nullableString(world.domain_knowledge, memory.id)
  };
}

function validateL3WorldModelMemory(
  memory: MemoryRow,
  expectedUserId: string | null,
  expectedProjectId?: string | null
): void {
  const internal = memory.properties.internal_info;
  const world = internal.world_model;
  const expectedFields = [
    "general_rules_and_safety_constraints",
    "project_environment_profile",
    "project_contract",
    "domain_knowledge"
  ];
  if (internal.schema_version !== 2 || !isRecordLike(world)) {
    throw new Error(`memory is not an L3 World Model v2 record: ${memory.id}`);
  }
  const actualKeys = Object.keys(world).sort();
  if (actualKeys.length !== expectedFields.length || expectedFields.some((field) => !actualKeys.includes(field))) {
    throw new Error(`invalid L3 World Model v2 field set: ${memory.id}`);
  }
  const fields = fieldsFromL3WorldModelMemory(memory);
  const projectId = expectedProjectId ?? null;
  if (memory.memoryLayer !== "L3" || internal.memory_kind !== "world_model") {
    throw new Error(`invalid L3 World Model layer or kind: ${memory.id}`);
  }
  if (projectIdFromL3WorldModelMemory(memory) !== projectId) {
    throw new Error(`invalid L3 World Model owner: ${memory.id}`);
  }
  const legacyKey = projectId ? `world_model:project:${memory.userId}:${projectId}` : `world_model:general_rules:${memory.userId}:no_project`;
  if (memory.memoryKey !== l3WorldModelMemoryKey(null, projectId) && memory.memoryKey !== legacyKey) {
    throw new Error(`invalid L3 World Model key: ${memory.id}`);
  }
  if (projectId && fields.generalRulesAndSafetyConstraints !== null) {
    throw new Error(`project L3 World Model contains general rules: ${memory.id}`);
  }
  if (!projectId && (
    fields.projectEnvironmentProfile !== null || fields.projectContract !== null || fields.domainKnowledge !== null
  )) {
    throw new Error(`general L3 World Model contains project fields: ${memory.id}`);
  }
}

export function isStrictL3WorldModelV2Memory(memory: MemoryRow): boolean {
  if (memory.properties.internal_info.schema_version !== 2) return false;
  try {
    validateL3WorldModelMemory(memory, memory.userId, projectIdFromL3WorldModelMemory(memory));
    return true;
  } catch {
    return false;
  }
}

function projectIdFromL3WorldModelMemory(memory: MemoryRow): string | null {
  const value = memory.info.project_id;
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value) throw new Error(`invalid L3 World Model project ID: ${memory.id}`);
  return value;
}

function nullableString(value: unknown, memoryId: string): string | null {
  if (value === null || typeof value === "string") return value;
  throw new Error(`invalid L3 World Model field value: ${memoryId}`);
}

function emptyL3WorldModelFields(): L3WorldModelFields {
  return {
    generalRulesAndSafetyConstraints: null,
    projectEnvironmentProfile: null,
    projectContract: null,
    domainKnowledge: null
  };
}

function l3WorldModelFieldProperty(field: L3WorldModelFieldName): keyof L3WorldModelFields {
  if (field === "general_rules_and_safety_constraints") return "generalRulesAndSafetyConstraints";
  if (field === "project_environment_profile") return "projectEnvironmentProfile";
  if (field === "project_contract") return "projectContract";
  return "domainKnowledge";
}

function assertL3WorldModelFieldOwnership(projectId: string | null, field: L3WorldModelFieldName): void {
  if (projectId === null && field !== "general_rules_and_safety_constraints") {
    throw new TypeError("a no-project L3 World Model can only own general rules");
  }
  if (projectId !== null && field === "general_rules_and_safety_constraints") {
    throw new TypeError("a project L3 World Model cannot own general rules");
  }
}

function normalizeL3WorldModelFieldValue(value: string | null): string | null {
  if (value === null) return null;
  return value.trim() ? value : null;
}

function l3WorldModelSourceMemoryIds(memory?: MemoryRow): string[] {
  if (!memory) return [];
  const value = memory.properties.internal_info.source_memory_ids;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item)) : [];
}

export function splitL3TracesByRawTurn(
  traces: L3WorldModelInputTraceRecord[],
  maxRawTurns: number
): L3WorldModelInputTraceRecord[][] {
  const groups: L3WorldModelInputTraceRecord[][] = [];
  for (const trace of traces) {
    const last = groups.at(-1);
    if (last?.[0]?.rawTurnId === trace.rawTurnId) {
      last.push(trace);
    } else {
      groups.push([trace]);
    }
  }
  const chunks: L3WorldModelInputTraceRecord[][] = [];
  for (let index = 0; index < groups.length; index += maxRawTurns) {
    chunks.push(groups.slice(index, index + maxRawTurns).flat());
  }
  return chunks;
}

function l3WorldModelScopeFromSql(row: SqlL3WorldModelScopeRow, db?: Database.Database): L3WorldModelScopeRecord {
  return {
    scopeKey: row.scope_key,
    userId: null,
    projectId: (db ? canonicalProjectId(db, row.project_id) : row.project_id) ?? undefined,
    workspaceUri: row.workspace_uri ? row.workspace_uri as WorkspaceUri : undefined,
    memoryId: row.memory_id ?? undefined,
    nextScopeSeq: row.next_scope_seq,
    updatedAt: row.updated_at
  };
}

function l3WorldModelInputTraceFromSql(row: SqlL3WorldModelInputTraceRow): L3WorldModelInputTraceRecord {
  return {
    sessionId: row.session_id,
    traceSeq: row.trace_seq,
    l1MemoryId: row.l1_memory_id,
    rawTurnId: row.raw_turn_id,
    episodeId: row.episode_id ?? undefined,
    createdAt: row.created_at
  };
}

function l3WorldModelEvidenceBatchFromSql(
  row: SqlL3WorldModelEvidenceBatchRow
, db?: Database.Database): L3WorldModelEvidenceBatchRecord {
  return {
    id: row.id,
    scopeKey: row.scope_key,
    scopeSeq: row.scope_seq,
    userId: null,
    projectId: (db ? canonicalProjectId(db, row.project_id) : row.project_id) ?? undefined,
    sessionId: row.session_id,
    trigger: row.trigger,
    startTraceSeq: row.start_trace_seq,
    endTraceSeq: row.end_trace_seq,
    l1MemoryIds: asStringArray(parseJson(row.l1_memory_ids_json, [])),
    rawTurnIds: asStringArray(parseJson(row.raw_turn_ids_json, [])),
    feedbackIds: asStringArray(parseJson(row.feedback_ids_json, [])),
    payloadHash: row.payload_hash,
    terminalOutcome: row.terminal_outcome ?? undefined,
    completedAt: row.completed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function l3WorldModelBatchTargetFromSql(
  row: SqlL3WorldModelBatchTargetRow
): L3WorldModelBatchTargetRecord {
  return {
    batchId: row.batch_id,
    targetField: row.target_field,
    fieldScopeKey: row.field_scope_key,
    scopeSeq: row.scope_seq,
    status: row.status,
    noChange: row.no_change === 1,
    appliedAt: row.applied_at ?? undefined,
    updatedAt: row.updated_at
  };
}

export function memoryFromSql(row: MemorySqlRow, db?: Database.Database): MemoryRow {
  const info = parseJson<Record<string, unknown>>(row.info_json, {});
  const properties = parseJson<MemoryRow["properties"]>(row.properties_json, {
    internal_info: {
      memory_layer: row.memory_layer
    }
  });
  const storedProject = typeof info.project_id === "string" ? info.project_id : null;
  const legacyKey = storedProject ? `world_model:project:${row.user_id}:${storedProject}` : `world_model:general_rules:${row.user_id}:no_project`;
  const projectedKey = row.memory_layer === "L3" && properties.internal_info?.schema_version === 2 && row.memory_key === legacyKey
    ? l3WorldModelMemoryKey(null, db ? canonicalProjectId(db, storedProject) : storedProject) : row.memory_key;
  if (db && typeof info.project_id === "string") info.project_id = canonicalProjectId(db, info.project_id);
  if (db && typeof properties.info?.project_id === "string") properties.info.project_id = canonicalProjectId(db, properties.info.project_id);
  const tags = uniq([
    ...asStringArray(parseJson(row.tags_json, [])),
    ...asStringArray(info.tags),
    ...asStringArray(properties.tags)
  ]);
  const internalInfo = {
    ...(properties.internal_info ?? {}),
    memory_layer: row.memory_layer
  };

  return {
    id: row.id,
    timeline: row.timeline,
    userId: null,
    conversationId: row.conversation_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    appId: (db ? canonicalProjectId(db, row.app_id) : row.app_id) ?? undefined,
    memoryType: row.memory_type,
    status: row.status,
    visibility: row.visibility,
    memoryKey: projectedKey ?? undefined,
    memoryValue: row.memory_value,
    tags,
    info,
    properties: {
      ...properties,
      internal_info: internalInfo
    },
    memoryLayer: row.memory_layer,
    contentHash: row.content_hash,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at
  };
}

function userMemoryFromSql(row: UserMemorySqlRow): UserMemoryRecord {
  return {
    id: row.id,
    sourceTurnId: row.source_turn_id,
    userId: null,
    memoryTypes: asStringArray(parseJson(row.memory_types_json, [])) as UserMemoryType[],
    content: row.content,
    normalizedUserTextHash: row.normalized_user_text_hash,
    sourceTurnRefs: asStringArray(parseJson(row.source_turn_refs_json, [])),
    status: row.status,
    replacesMemoryId: row.replaces_memory_id ?? undefined,
    replacedByMemoryId: row.replaced_by_memory_id ?? undefined,
    archivedAt: row.archived_at,
    archiveReason: row.archive_reason ?? undefined,
    embedding: row.embedding_json ? finiteVector(parseJson(row.embedding_json, [])) : undefined,
    embeddingModel: row.embedding_model ?? undefined,
    embeddingProvider: row.embedding_provider ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at
  };
}

function userMemoryPanelFilter(input: {
  userId: string | null;
  status?: UserMemoryStatus;
  query?: string;
  sourceAgent?: string;
}): { where: string; params: Array<string> } {
  const clauses = [`(status != 'active' OR (${ACTIVE_USER_MEMORY_VIEW_SQL}))`];
  const params: string[] = [];
  if (input.status) {
    clauses.push("status = ?");
    params.push(input.status);
  } else {
    clauses.push("deleted_at IS NULL", "status != 'deleted'");
  }
  const query = input.query?.trim().toLowerCase();
  if (query) {
    clauses.push("lower(content) LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLikePattern(query)}%`);
  }
  const sourceAgent = input.sourceAgent?.trim();
  if (sourceAgent) {
    const match = agentIdMatchClause("sessions.source", sourceAgent);
    clauses.push(`EXISTS (
      SELECT 1
      FROM raw_turns
      INNER JOIN sessions ON sessions.id = raw_turns.session_id
      WHERE (
        raw_turns.id = user_memories.source_turn_id
        OR raw_turns.id IN (
          SELECT CAST(value AS TEXT) FROM json_each(user_memories.source_turn_refs_json)
        )
      )
      AND ${match.sql}
    )`);
    params.push(...match.params);
  }
  return { where: clauses.join(" AND "), params };
}

function cosineVectors(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  return leftNorm > 0 && rightNorm > 0 ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

export function memoryToSql(memory: MemoryRow): Record<string, SqlValue> {
  return {
    id: memory.id,
    timeline: memory.timeline,
    userId: null,
    conversationId: memory.conversationId ?? null,
    sessionId: memory.sessionId ?? null,
    agentId: memory.agentId ?? null,
    appId: memory.appId ?? null,
    memoryType: memory.memoryType,
    status: memory.status,
    visibility: memory.visibility,
    memoryKey: memory.memoryKey ?? null,
    memoryValue: memory.memoryValue,
    tagsJson: toJson(memory.tags),
    infoJson: toJson(memory.info),
    propertiesJson: toJson(memory.properties),
    memoryLayer: memory.memoryLayer,
    contentHash: memory.contentHash ?? stableHash(memory.memoryValue),
    version: memory.version,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    deletedAt: memory.deletedAt ?? null
  };
}

export function kindFromMemory(memory: MemoryRow): MemoryKind {
  const kind = memory.properties.internal_info.memory_kind;
  if (kind) {
    return kind;
  }
  if (memory.memoryLayer === "Skill") {
    return "skill";
  }
  if (memory.memoryLayer === "L3") {
    return "world_model";
  }
  if (memory.memoryLayer === "L2") {
    return "policy";
  }
  return "trace";
}

export function titleFromValue(value: string): string {
  const line = firstLine(value);
  if (line.length <= 80) {
    return line || "Untitled memory";
  }
  return `${line.slice(0, 77)}...`;
}

function listTitleForMemory(memory: MemoryRow): string {
  const internal = memory.properties.internal_info;
  if (internal.memory_kind === "work_memory" && typeof internal.work_topic === "string" && internal.work_topic.trim()) {
    return internal.work_topic.trim();
  }
  const policy = recordValue(internal.policy);
  const world = recordValue(internal.world_model);
  const skill = recordValue(internal.skill);
  const placeholderSummary = firstNonEmptyString(stringLike(memory.info.summary), stringLike(internal.summary));
  const importedUserTitle = isPlaceholderMemorySummary(placeholderSummary)
    ? firstUserMemoryValueLine(memory.memoryValue)
    : undefined;
  const pendingTraceUserTitle = memory.memoryLayer === "L1" && !placeholderSummary
    ? firstUserMemoryValueLine(memory.memoryValue)
    : undefined;
  const skillTitleCandidates = memory.memoryLayer === "Skill"
    ? [
        stringLike(internal.title),
        stringLike(skill.title),
        markdownHeadingTitle(memory.memoryValue),
        firstReadableMemoryValueLine(memory.memoryValue),
        humanizeIdentifier(stringLike(skill.name))
      ]
    : [];
  const title = firstNonEmptyString(
    importedUserTitle,
    stringLike(memory.info.title),
    stringLike(internal.title),
    pendingTraceUserTitle,
    stringLike(policy.title),
    stringLike(world.title),
    ...skillTitleCandidates,
    memory.memoryLayer === "Skill" ? undefined : stringLike(skill.name),
    firstReadableMemoryValueLine(memory.memoryValue),
    isInternalMemoryKey(memory.memoryKey) ? undefined : memory.memoryKey,
    memory.id
  );

  return truncateTitle(title ?? "Untitled memory");
}

function listSummaryForMemory(memory: MemoryRow): string {
  const internal = memory.properties.internal_info;
  if (internal.memory_kind === "work_memory" && typeof internal.requirement === "string") {
    return internal.requirement.trim();
  }
  const policy = recordValue(internal.policy);
  const world = recordValue(internal.world_model);
  const skill = recordValue(internal.skill);
  return firstNonEmptyString(
    stringLike(memory.info.summary),
    stringLike(internal.summary),
    stringLike(policy.procedure),
    stringLike(world.summary),
    stringLike(world.body),
    stringLike(skill.invocation_guide),
    stringLike(skill.invocationGuide),
    firstReadableMemoryValueLine(memory.memoryValue),
    firstLine(memory.memoryValue)
  ) ?? "";
}

function listMetricsForMemory(memory: MemoryRow): MemoryListItem["metrics"] | undefined {
  const internal = memory.properties.internal_info;
  const trace = recordValue(internal.trace);
  const value = numberMetric(internal.value) ?? numberMetric(trace.value);
  const alpha = numberMetric(internal.alpha) ?? numberMetric(trace.alpha);
  const reflection = firstNonEmptyString(
    stringLike(internal.reflection),
    stringLike(trace.reflection)
  );

  if (value === undefined && alpha === undefined && !reflection) {
    return undefined;
  }

  return {
    ...(value === undefined ? {} : { value }),
    ...(alpha === undefined ? {} : { alpha }),
    reflectionDone: Boolean(reflection)
  };
}

function numberMetric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstNonEmptyString(...values: Array<string | undefined>): string | undefined {
  return values
    .map((value) => value?.trim())
    .find((value): value is string => Boolean(value && !isWorldSectionHeading(value) && !isInternalMemoryKey(value)));
}

function truncateTitle(value: string): string {
  return value.length <= 80 ? value : `${value.slice(0, 77)}...`;
}

function firstReadableMemoryValueLine(value: string): string | undefined {
  return value
    .split(/\r?\n/)
    .map(cleanMemoryValueLine)
    .find((line) => line && !isWorldSectionHeading(line) && !isInternalMemoryKey(line));
}

function firstUserMemoryValueLine(value: string): string | undefined {
  let inUserSection = false;
  const userLines: string[] = [];
  for (const line of value.split(/\r?\n/)) {
    const role = memoryValueRoleMarker(line);
    if (role) {
      if (inUserSection && role !== "user") {
        break;
      }
      inUserSection = role === "user";
      continue;
    }
    if (!inUserSection) {
      continue;
    }
    userLines.push(line);
  }
  const title = firstSemanticUserLine(userLines.join("\n"));
  return title && !isPlaceholderMemorySummary(title) && !isWorldSectionHeading(title) && !isInternalMemoryKey(title)
    ? title
    : undefined;
}

function isPlaceholderMemorySummary(value: string | undefined): boolean {
  const first = value
    ?.split(/\r?\n/)
    .map(cleanMemoryValueLine)
    .find(Boolean);
  return Boolean(first && /^(user|assistant|system|tool|developer|摘要排队中|摘要整理中|摘要总结中|建立索引中|索引建立中|索引已建立|反思生成中)$/i.test(first));
}

function memoryValueRoleMarker(value: string): string | undefined {
  const trimmed = value.trim();
  const markdown = trimmed.match(/^#{1,6}\s+(user|assistant|system|tool|developer)\b/i);
  if (markdown) {
    return markdown[1]?.toLowerCase();
  }
  const label = trimmed.match(/^(User|Assistant|Agent|System|Tool|Developer):$/i);
  if (!label) {
    return undefined;
  }
  const role = label[1]?.toLowerCase();
  return role === "agent" ? "assistant" : role;
}

function cleanMemoryValueLine(value: string): string {
  return value
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/^\s*[-*]\s+/, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .trim();
}

function markdownHeadingTitle(value: string): string | undefined {
  const line = value.split(/\r?\n/).find((candidate) => /^\s*#{1,6}\s+/.test(candidate));
  return line?.replace(/^\s*#{1,6}\s+/, "").trim() || undefined;
}

function humanizeIdentifier(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim();
  if (!/^[a-z0-9_:-]+$/i.test(cleaned)) return cleaned;
  return cleaned
    .replace(/^(skill|policy|trace|world)[:_]/i, "")
    .split(/[_:-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ") || undefined;
}

function isWorldSectionHeading(value: string): boolean {
  return /^(Environment|Inference|Constraints|Environment Knowledge|环境|环境拓扑|行为规律|约束禁忌|结构化认知)$/i.test(value.trim());
}

function isInternalMemoryKey(value: string | undefined): boolean {
  return Boolean(value && /^(trace|policy|world|world_model|skill)[:_]/i.test(value.trim()));
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecordLike(value) ? value : {};
}

function firstLine(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
}

function snippetForQuery(value: string, query: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 240) {
    return normalized;
  }
  const lower = normalized.toLowerCase();
  const needle = query.trim().toLowerCase();
  const index = needle ? lower.indexOf(needle) : -1;
  if (index < 0) {
    return `${normalized.slice(0, 237)}...`;
  }
  const start = Math.max(0, index - 80);
  const end = Math.min(normalized.length, index + needle.length + 160);
  return `${start > 0 ? "..." : ""}${normalized.slice(start, end)}${end < normalized.length ? "..." : ""}`;
}

function scoreMemory(query: string, memory: MemoryRow): number {
  const cleaned = query.trim().toLowerCase();
  const body = `${memory.id}\n${memory.memoryKey ?? ""}\n${memory.memoryValue}\n${memory.tags.join(" ")}`.toLowerCase();
  if (!cleaned) {
    return layerWeight(memory.memoryLayer);
  }

  let score = 0;
  if (body.includes(cleaned)) {
    score += 5;
  }
  for (const term of queryTerms(cleaned)) {
    if (term.length < 2) {
      continue;
    }
    if (body.includes(term)) {
      score += 2;
    }
    if (memory.id.toLowerCase().includes(term)) {
      score += 2;
    }
    if ((memory.memoryKey ?? "").toLowerCase().includes(term)) {
      score += 1.5;
    }
    if (memory.tags.some((tag) => tag.toLowerCase().includes(term))) {
      score += 1;
    }
  }
  if (score === 0) {
    return 0;
  }
  return Number((score * layerWeight(memory.memoryLayer)).toFixed(3));
}

function queryTerms(query: string): string[] {
  const terms = query
    .split(/[\s,.;:!?()[\]{}"'`|/\\]+/)
    .map((term) => term.trim())
    .filter(Boolean);
  return terms.length > 0 ? terms : [query];
}

function searchNeedles(query: string): string[] {
  const cleaned = query.trim().toLowerCase();
  if (!cleaned) {
    return [];
  }
  return uniq([cleaned, ...queryTerms(cleaned).filter((term) => term.length >= 2)]);
}

function buildMemorySearchWhere(query: string, includeTags: boolean): { where: string; params: SqlValue[] } {
  const needles = searchNeedles(query);
  if (needles.length === 0) {
    return { where: "", params: [] };
  }

  const clauses = needles.map(() => {
    const columns = [
      "lower(memories.id) LIKE ? ESCAPE '\\'",
      "lower(COALESCE(memories.memory_key, '')) LIKE ? ESCAPE '\\'",
      "lower(memories.memory_value) LIKE ? ESCAPE '\\'"
    ];
    if (includeTags) {
      columns.push("lower(memories.tags_json) LIKE ? ESCAPE '\\'");
    }
    return `(${columns.join(" OR ")})`;
  });
  const params = needles.flatMap((needle) => {
    const pattern = `%${escapeLikePattern(needle)}%`;
    return includeTags
      ? [pattern, pattern, pattern, pattern]
      : [pattern, pattern, pattern];
  });

  return {
    where: clauses.join(" OR "),
    params
  };
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function likeColumnsForTerm(term: string, includeTags: boolean): string[] {
  const columns = [
    "lower(memories.id) LIKE ? ESCAPE '\\'",
    "lower(COALESCE(memories.memory_key, '')) LIKE ? ESCAPE '\\'",
    "lower(memories.memory_value) LIKE ? ESCAPE '\\'"
  ];
  // Short ASCII terms ("ts", "id", ...) are substrings of JSON keys present in
  // every row's metadata blobs, so matching them there ranks unrelated recent
  // memories above real hits. Longer terms and CJK bigrams cannot collide with
  // JSON structure and keep their reach into metadata values.
  if (!isShortAsciiTerm(term)) {
    // Raw History is retained for provenance, not as another retrieval corpus
    // after the worker has distilled the useful memory from it.
    columns.push(
      `lower(CASE WHEN json_extract(memories.properties_json, '$.internal_info.memory_kind') = 'observed_activity'
        THEN json_object('title', json_extract(memories.properties_json, '$.internal_info.title'),
          'summary', json_extract(memories.properties_json, '$.internal_info.summary'))
        ELSE memories.properties_json END) LIKE ? ESCAPE '\\'`,
      `lower(CASE WHEN json_extract(memories.properties_json, '$.internal_info.memory_kind') = 'observed_activity'
        THEN json_object('title', json_extract(memories.info_json, '$.title'),
          'summary', json_extract(memories.info_json, '$.summary'))
        ELSE memories.info_json END) LIKE ? ESCAPE '\\'`
    );
  }
  if (includeTags) columns.push("lower(memories.tags_json) LIKE ? ESCAPE '\\'");
  return columns;
}

function isShortAsciiTerm(term: string): boolean {
  return /^[\x20-\x7e]{1,2}$/.test(term);
}

function normalizedAgentIdSql(column: string): string {
  return `lower(replace(replace(TRIM(${column}), '-', '_'), ' ', '_'))`;
}

/** Keep the narrow stats projection and panel filters aligned with panelSourceForMemory. */
function memoryDisplayedSourceSql(fallback: string): string {
  const candidate = "$.internal_info.external_evidence_candidate";
  // SQLite GLOB is case-sensitive and anchored unless a wildcard is present,
  // matching the canonical History ID shape used by the legacy source helper.
  const historyPrefix = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]-[0-9][0-9]-[0-9][0-9]";
  const historyId = ["10min", "6h"].flatMap((window) => ["", "Z"].map((zone) =>
    `history_source.value GLOB '${historyPrefix}${zone}-${window}-summary'`)).join(" OR ");
  return `CASE
    WHEN (json_extract(properties_json, '$.internal_info.memory_kind') = 'observed_activity'
      AND (json_extract(properties_json, '$.internal_info.external_evidence.source') = 'computer_history'
        OR json_type(properties_json, '$.internal_info.external_evidence.provenance.historyId') = 'text'))
      OR (memory_layer = 'Skill' AND (
        json_extract(properties_json, '${candidate}.source') = 'computer_history'
        OR (agent_id = 'memmy' AND json_extract(properties_json, '${candidate}.source') = 'memmy'
          AND json_type(properties_json, '${candidate}.sourceRecordIds') = 'array'
          AND (SELECT COUNT(DISTINCT value) FROM json_each(properties_json, '${candidate}.sourceRecordIds')) >= 2
          AND NOT EXISTS (SELECT 1 FROM json_each(properties_json, '${candidate}.sourceRecordIds') AS history_source
            WHERE history_source.type <> 'text' OR NOT (${historyId})))
      ))
    THEN 'computer_history' ELSE ${fallback} END`;
}

/**
 * Matches one Agent filter value against a source column. Known Agents also match the
 * ids derived from them ("memmy-onboarding" under "memmy-agent"), because the panel
 * shows all of them as the same Agent.
 */
function agentIdMatchClause(column: string, value: string): { sql: string; params: string[] } {
  const normalizedColumn = normalizedAgentIdSql(column);
  const roots = agentSourceFamilyRoots(value);
  if (roots.length === 0) {
    return { sql: `${normalizedColumn} = ?`, params: [normalizeAgentIdKey(value)] };
  }
  return {
    sql: `(${roots.map(() => `${normalizedColumn} = ? OR ${normalizedColumn} LIKE ? ESCAPE '\\'`).join(" OR ")})`,
    params: roots.flatMap((root) => [root, `${escapeLikePattern(root)}\\_%`])
  };
}

/** True when the column matches none of the excluded Agents (the "other Agents" filter). */
function agentIdExclusionClause(column: string, values: readonly string[]): { sql: string; params: string[] } | undefined {
  const matches = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
    .map((value) => agentIdMatchClause(column, value));
  if (matches.length === 0) {
    return undefined;
  }
  return {
    sql: `(
      NULLIF(TRIM(${column}), '') IS NULL
      OR NOT (${matches.map((match) => match.sql).join(" OR ")})
    )`,
    params: matches.flatMap((match) => match.params)
  };
}

function layerWeight(layer: MemoryLayer): number {
  switch (layer) {
    case "Skill":
      return 1.25;
    case "L2":
      return 1.15;
    case "L3":
      return 1.05;
    case "L1":
    default:
      return 1;
  }
}

function buildMemoryWhere(filter: MemoryFilter): { where: string; params: SqlValue[] } {
  const clauses = ["deleted_at IS NULL"];
  const params: SqlValue[] = [];

  // Legacy account provenance is not a memory filter.
  addValueClause("session_id", filter.sessionId);
  addValueClause("conversation_id", filter.conversationId);
  addAgentIdClause(filter.agentId, filter.excludedAgentIds);
  addValueClause("app_id", filter.appId);
  addRangeClause("created_at", ">=", filter.createdAtGte);
  addRangeClause("created_at", "<", filter.createdAtLt);
  addArrayClause("memory_layer", filter.memoryLayer);
  addArrayClause("status", filter.status);
  addArrayClause("id", filter.ids);
  addMemoryKindClause(filter.memoryKind);
  addWorkMemoryScopeClause(filter.workMemoryUserId, filter.workMemoryProjectId);
  addTagClauses(filter.tags);

  return {
    where: clauses.join(" AND "),
    params
  };

  function addValueClause(column: string, value: string | undefined): void {
    if (value === undefined) {
      return;
    }
    clauses.push(`${column} = ?`);
    params.push(value);
  }

  function addRangeClause(column: string, operator: ">=" | "<", value: string | undefined): void {
    if (value === undefined) return;
    clauses.push(`${column} ${operator} ?`);
    params.push(value);
  }

  function addAgentIdClause(value: string | undefined, excludedValues: string[] | undefined): void {
    // The namespace owner remains Memmy; the panel filters by the producer it
    // displays, including History records written by the old HTTP envelope.
    const displayedSource = memoryDisplayedSourceSql("agent_id");
    if (value?.trim()) {
      const match = agentIdMatchClause(displayedSource, value);
      clauses.push(match.sql);
      params.push(...match.params);
      return;
    }
    const exclusion = agentIdExclusionClause(displayedSource, excludedValues ?? []);
    if (exclusion) {
      clauses.push(exclusion.sql);
      params.push(...exclusion.params);
    }
  }

  function addArrayClause(column: string, value: string | string[] | undefined): void {
    if (value === undefined) {
      return;
    }
    const values = Array.isArray(value) ? value : [value];
    if (values.length === 0) {
      return;
    }
    clauses.push(`${column} IN (${values.map(() => "?").join(", ")})`);
    params.push(...values);
  }

  function addMemoryKindClause(value: MemoryKind | MemoryKind[] | undefined): void {
    if (value === undefined) return;
    const values = Array.isArray(value) ? value : [value];
    if (values.length === 0) return;
    const expression = `COALESCE(
      json_extract(properties_json, '$.internal_info.memory_kind'),
      CASE memory_layer
        WHEN 'L1' THEN 'trace'
        WHEN 'L2' THEN 'policy'
        WHEN 'L3' THEN 'world_model'
        WHEN 'Skill' THEN 'skill'
        ELSE 'trace'
      END
    )`;
    clauses.push(`${expression} IN (${values.map(() => "?").join(", ")})`);
    params.push(...values);
  }

  function addWorkMemoryScopeClause(_userId: string | null | undefined, projectId: string | null | undefined): void {
    if (projectId === undefined) return;
    const normalizedProjectExpression = "memory_project_id(NULLIF(TRIM(CAST(json_extract(info_json, '$.project_id') AS TEXT)), ''))";
    clauses.push(`(
      COALESCE(json_extract(properties_json, '$.internal_info.memory_kind'), 'trace') != 'work_memory'
      OR (${projectId === null ? `${normalizedProjectExpression} IS NULL` : `${normalizedProjectExpression} = ?`})
    )`);
    if (projectId !== null) params.push(projectId);
  }

  function addTagClauses(tags: string[] | undefined): void {
    for (const tag of tags ?? []) {
      const normalized = tag.trim().toLowerCase();
      if (!normalized) {
        continue;
      }
      clauses.push(`(
        EXISTS (
          SELECT 1 FROM json_each(memories.tags_json) AS memory_tag
          WHERE lower(CAST(memory_tag.value AS TEXT)) = ?
        )
        OR EXISTS (
          SELECT 1 FROM json_each(memories.info_json, '$.tags') AS info_tag
          WHERE lower(CAST(info_tag.value AS TEXT)) = ?
        )
        OR EXISTS (
          SELECT 1 FROM json_each(memories.properties_json, '$.tags') AS property_tag
          WHERE lower(CAST(property_tag.value AS TEXT)) = ?
        )
      )`);
      params.push(normalized, normalized, normalized);
    }
  }
}

function buildEpisodeWhere(userId?: string | null, query?: string, sourceAgent?: string): { where: string; params: SqlValue[] } {
  const clauses = ["1=1"];
  const params: SqlValue[] = [];

  const normalizedSourceAgent = sourceAgent?.trim();
  if (normalizedSourceAgent) {
    const match = agentIdMatchClause("sessions.source", normalizedSourceAgent);
    clauses.push(`EXISTS (
      SELECT 1
      FROM sessions
      WHERE sessions.id = episodes.session_id
        AND ${match.sql}
    )`);
    params.push(...match.params);
  }

  const normalizedQuery = query?.trim();
  if (normalizedQuery) {
    const pattern = `%${escapeLikePattern(normalizedQuery)}%`;
    clauses.push(`(
      episodes.id LIKE ? ESCAPE '\\'
      OR COALESCE(episodes.title, '') LIKE ? ESCAPE '\\'
      OR COALESCE(episodes.summary, '') LIKE ? ESCAPE '\\'
      OR EXISTS (
        SELECT 1
        FROM raw_turns
        WHERE raw_turns.episode_id = episodes.id
          AND raw_turns.redacted_at IS NULL
          AND raw_turns.deleted_at IS NULL
          AND (
            COALESCE(raw_turns.user_text, '') LIKE ? ESCAPE '\\'
            OR COALESCE(raw_turns.assistant_text, '') LIKE ? ESCAPE '\\'
            OR COALESCE(raw_turns.reasoning_summary, '') LIKE ? ESCAPE '\\'
          )
      )
    )`);
    params.push(pattern, pattern, pattern, pattern, pattern, pattern);
  }

  return { where: clauses.join(" AND "), params };
}

function buildAnyTagWhere(tags: string[] | undefined): { where: string; params: SqlValue[] } {
  const normalized = (tags ?? [])
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
  if (normalized.length === 0) return { where: "", params: [] };
  const clauses = normalized.map(() => `(
    EXISTS (
      SELECT 1 FROM json_each(memories.tags_json) AS memory_tag
      WHERE lower(CAST(memory_tag.value AS TEXT)) = ?
    )
    OR EXISTS (
      SELECT 1 FROM json_each(memories.info_json, '$.tags') AS info_tag
      WHERE lower(CAST(info_tag.value AS TEXT)) = ?
    )
    OR EXISTS (
      SELECT 1 FROM json_each(memories.properties_json, '$.tags') AS property_tag
      WHERE lower(CAST(property_tag.value AS TEXT)) = ?
    )
  )`);
  return {
    where: `(${clauses.join(" OR ")})`,
    params: normalized.flatMap((tag) => [tag, tag, tag])
  };
}

function prepareMemoryForStorage(memory: MemoryRow): {
  memory: MemoryRow;
  vectors: MemoryVectorValue[];
  vectorUpdates: MemoryVectorValue[];
} {
  const vectors = new Map(
    attachedMemoryVectorEntries(memory).map((entry) => [entry.vectorField, entry])
  );
  const vectorUpdates = new Map(
    dirtyMemoryVectorEntries(memory).map((entry) => [entry.vectorField, entry])
  );
  const internal = { ...memory.properties.internal_info };
  const ownerKey = memory.memoryLayer === "L1"
    ? "trace"
    : memory.memoryLayer === "L2"
      ? "policy"
      : memory.memoryLayer === "L3"
        ? "world_model"
        : "skill";
  const ownerValue = internal[ownerKey];
  if (ownerValue && typeof ownerValue === "object" && !Array.isArray(ownerValue)) {
    const owner = { ...ownerValue as Record<string, unknown> };
    const fields: EmbeddingRetryVectorField[] = memory.memoryLayer === "L1"
      ? ["vec_summary", "vec_action"]
      : ["vec"];
    for (const vectorField of fields) {
      const vector = finiteVector(owner[vectorField]);
      if (vector.length > 0) {
        const entry = {
          vectorField,
          vector,
          embeddingModel: stringLike(owner.embedding_model) ?? stringLike(internal.embedding_model),
          embeddingProvider: stringLike(owner.embedding_provider) ?? stringLike(internal.embedding_provider)
        };
        vectors.set(vectorField, entry);
        vectorUpdates.set(vectorField, entry);
      }
      delete owner[vectorField];
    }
    delete owner.embedding_model;
    delete owner.embedding_provider;
    delete owner.embedding_dim;
    internal[ownerKey] = owner;
  }
  delete internal.embedding_model;
  delete internal.embedding_provider;
  delete internal.embedding_dim;

  const clean = { ...memory };
  clean.properties = {
    ...memory.properties,
    internal_info: internal
  };
  return {
    memory: clean,
    vectors: [...vectors.values()],
    vectorUpdates: [...vectorUpdates.values()]
  };
}

function mergeMemoryVectors(
  current: MemoryVectorValue[],
  updates: MemoryVectorValue[]
): MemoryVectorValue[] {
  const merged = new Map(current.map((entry) => [entry.vectorField, entry]));
  for (const update of updates) {
    merged.set(update.vectorField, update);
  }
  return [...merged.values()];
}

function finiteVector(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function mergeProperties(
  previous: MemoryRow["properties"],
  next: MemoryRow["properties"]
): MemoryRow["properties"] {
  return {
    ...previous,
    ...next,
    internal_info: {
      ...(previous.internal_info ?? {}),
      ...(next.internal_info ?? {})
    }
  };
}

function uniq<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

interface SqlSessionRow {
  id: string;
  user_id: string;
  project_id: string | null;
  source: string;
  profile_id: string;
  profile_label: string | null;
  workspace_id: string | null;
  workspace_path: string | null;
  host_session_key: string | null;
  conversation_id: string | null;
  status: "open" | "processing" | "closed";
  meta_json: string;
  opened_at: string;
  last_seen_at: string | null;
  closed_at: string | null;
  updated_at: string;
}

function sessionFromSql(row: SqlSessionRow, db?: Database.Database): SessionRecord {
  const meta = parseJson<Record<string, unknown>>(row.meta_json, {});
  if (db && typeof meta.source_namespace_key === "string") meta.source_namespace_key = canonicalNamespaceKey(db, meta.source_namespace_key);
  return {
    id: row.id,
    userId: null,
    source: row.source,
    profileId: row.profile_id,
    profileLabel: row.profile_label ?? undefined,
    projectId: (db ? canonicalProjectId(db, row.project_id) : row.project_id) ?? undefined,
    workspaceId: (db ? canonicalProjectId(db, row.workspace_id) : row.workspace_id) ?? undefined,
    workspacePath: row.workspace_path ?? undefined,
    hostSessionKey: row.host_session_key ?? undefined,
    conversationId: row.conversation_id ?? undefined,
    status: row.status,
    meta,
    openedAt: row.opened_at,
    lastSeenAt: row.last_seen_at ?? row.updated_at,
    closedAt: row.closed_at,
    updatedAt: row.updated_at
  };
}

interface SqlEpisodeRow {
  id: string;
  session_id: string;
  user_id: string;
  project_id: string | null;
  conversation_id: string | null;
  status: "open" | "processing" | "closed";
  title: string | null;
  summary: string | null;
  l1_memory_ids_json: string;
  raw_turn_ids_json: string;
  feedback_ids_json: string;
  decision_repair_ids_json: string;
  l2_policy_ids_json: string;
  l3_world_model_ids_json: string;
  skill_memory_ids_json: string;
  turn_count: number | null;
  r_task: number | null;
  reward_detail_json: string;
  pipeline_run_id: string | null;
  pipeline_status: "idle" | "running" | "succeeded" | "failed" | null;
  pipeline_error: string | null;
  meta_json: string;
  opened_at: string;
  closed_at: string | null;
  updated_at: string;
}

function episodeFromSql(row: SqlEpisodeRow, db?: Database.Database): EpisodeRecord {
  const rawTurnIds = asStringArray(parseJson(row.raw_turn_ids_json, []));
  return {
    id: row.id,
    sessionId: row.session_id,
    userId: null,
    projectId: (db ? canonicalProjectId(db, row.project_id) : row.project_id) ?? undefined,
    conversationId: row.conversation_id ?? undefined,
    status: row.status,
    title: row.title ?? undefined,
    summary: row.summary ?? undefined,
    l1MemoryIds: asStringArray(parseJson(row.l1_memory_ids_json, [])),
    rawTurnIds,
    feedbackIds: asStringArray(parseJson(row.feedback_ids_json, [])),
    decisionRepairIds: asStringArray(parseJson(row.decision_repair_ids_json, [])),
    l2PolicyIds: asStringArray(parseJson(row.l2_policy_ids_json, [])),
    l3WorldModelIds: asStringArray(parseJson(row.l3_world_model_ids_json, [])),
    skillMemoryIds: asStringArray(parseJson(row.skill_memory_ids_json, [])),
    turnCount: row.turn_count ?? rawTurnIds.length,
    rTask: row.r_task ?? undefined,
    rewardDetail: parseJson(row.reward_detail_json, {}),
    pipelineRunId: row.pipeline_run_id ?? undefined,
    pipelineStatus: row.pipeline_status ?? "idle",
    pipelineError: row.pipeline_error ?? undefined,
    meta: parseJson(row.meta_json, {}),
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    updatedAt: row.updated_at
  };
}

interface SqlSkillClusterRow {
  id: string;
  user_id: string;
  project_id: string | null;
  tools_json: string;
  artifacts_json: string;
  tool_bigrams_json: string;
  centroid_json: string | null;
  skill_memory_id: string | null;
  meta_skill_md: string;
  processed_episode_ids_json: string;
  member_count: number;
  created_at: string;
  updated_at: string;
}

function skillClusterFromSql(row: SqlSkillClusterRow, db?: Database.Database): SkillClusterRecord {
  const centroid = parseJson<number[] | null>(row.centroid_json, null);
  return {
    id: row.id,
    userId: null,
    projectId: (db ? canonicalProjectId(db, row.project_id) : row.project_id) ?? undefined,
    tools: asStringArray(parseJson(row.tools_json, [])),
    artifacts: asStringArray(parseJson(row.artifacts_json, [])),
    toolBigrams: asStringArray(parseJson(row.tool_bigrams_json, [])),
    centroid: Array.isArray(centroid) ? centroid.filter((item): item is number => typeof item === "number") : null,
    skillMemoryId: row.skill_memory_id ?? undefined,
    metaSkillMd: row.meta_skill_md ?? "",
    processedEpisodeIds: asStringArray(parseJson(row.processed_episode_ids_json, [])),
    memberCount: row.member_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

interface SqlSkillClusterMemberRow {
  cluster_id: string;
  episode_id: string;
  outcome: "success" | "failure" | "unknown";
  r_task: number | null;
  assigned_at: string;
}

function skillClusterMemberFromSql(row: SqlSkillClusterMemberRow): SkillClusterMemberRecord {
  return {
    clusterId: row.cluster_id,
    episodeId: row.episode_id,
    outcome: row.outcome,
    rTask: typeof row.r_task === "number" ? row.r_task : undefined,
    assignedAt: row.assigned_at
  };
}

interface SqlRawTurnRow {
  id: string;
  session_id: string;
  episode_id: string;
  turn_id: string;
  user_id: string;
  conversation_id: string | null;
  user_text: string | null;
  assistant_text: string | null;
  reasoning_summary: string | null;
  tool_calls_json: string;
  tool_results_json: string;
  source_memory_ids_json: string;
  usage_json: string;
  message_payload_json: string;
  status: string;
  redacted_at: string | null;
  deleted_at: string | null;
  created_at: string;
}

interface SqlFeedbackRow {
  id: string;
  user_id: string;
  project_id: string | null;
  conversation_id: string | null;
  session_id: string | null;
  episode_id: string | null;
  l1_memory_id: string | null;
  raw_turn_id: string | null;
  channel: FeedbackRequest["channel"];
  polarity: FeedbackRequest["polarity"];
  magnitude: number;
  rationale: string | null;
  raw_payload_json: string;
  context_hash: string | null;
  created_at: string;
}

function rawTurnFromSql(row: SqlRawTurnRow): RawTurnRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    episodeId: row.episode_id,
    turnId: row.turn_id,
    userId: null,
    conversationId: row.conversation_id ?? undefined,
    userText: row.user_text ?? undefined,
    assistantText: row.assistant_text ?? undefined,
    reasoningSummary: row.reasoning_summary ?? undefined,
    toolCalls: parseJson(row.tool_calls_json, []),
    toolResults: parseJson(row.tool_results_json, []),
    sourceMemoryIds: asStringArray(parseJson(row.source_memory_ids_json, [])),
    usage: parseJson(row.usage_json, {}),
    messagePayload: parseJson(row.message_payload_json, {}),
    status: row.status,
    redactedAt: row.redacted_at,
    deletedAt: row.deleted_at,
    createdAt: row.created_at
  };
}

function feedbackFromSql(row: SqlFeedbackRow): FeedbackRecord {
  return {
    id: row.id,
    userId: null,
    projectId: row.project_id ?? undefined,
    conversationId: row.conversation_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    episodeId: row.episode_id ?? undefined,
    l1MemoryId: row.l1_memory_id ?? undefined,
    rawTurnId: row.raw_turn_id ?? undefined,
    channel: row.channel,
    polarity: row.polarity,
    magnitude: row.magnitude,
    rationale: row.rationale ?? undefined,
    rawPayload: parseJson(row.raw_payload_json, {}),
    contextHash: row.context_hash ?? undefined,
    createdAt: row.created_at
  };
}

interface SqlRecallEventRow {
  id: string;
  namespace_id: string | null;
  session_id: string | null;
  episode_id: string | null;
  turn_id: string | null;
  user_id: string;
  query: string;
  query_hash: string | null;
  layers_json: string;
  candidate_memory_ids_json: string;
  injected_memory_ids_json: string;
  hit_memory_ids_json: string;
  dropped_json: string;
  outcome: NonNullable<RecallEventRecord["outcome"]>;
  request_json: string;
  query_id: string | null;
  user_memory_candidate_ids_json: string;
  l1_candidate_ids_json: string;
  merged_source_turn_ids_json: string;
  member_memory_ids_by_source_turn_id_json: string;
  created_at: string;
}

function recallEventFromSql(row: SqlRecallEventRow): RecallEventRecord {
  return {
    id: row.id,
    namespaceId: row.namespace_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    episodeId: row.episode_id ?? undefined,
    turnId: row.turn_id ?? undefined,
    userId: null,
    query: row.query,
    queryHash: row.query_hash ?? undefined,
    layers: asStringArray(parseJson(row.layers_json, [])) as MemoryLayer[],
    candidateMemoryIds: asStringArray(parseJson(row.candidate_memory_ids_json, [])),
    injectedMemoryIds: asStringArray(parseJson(row.injected_memory_ids_json, [])),
    hitMemoryIds: asStringArray(parseJson(row.hit_memory_ids_json, [])),
    dropped: parseJson(row.dropped_json, []),
    outcome: row.outcome,
    request: parseJson(row.request_json, {}),
    queryId: row.query_id ?? undefined,
    userMemoryCandidateIds: asStringArray(parseJson(row.user_memory_candidate_ids_json, [])),
    l1CandidateIds: asStringArray(parseJson(row.l1_candidate_ids_json, [])),
    mergedSourceTurnIds: asStringArray(parseJson(row.merged_source_turn_ids_json, [])),
    memberMemoryIdsBySourceTurnId: parseJson(row.member_memory_ids_by_source_turn_id_json, {}),
    createdAt: row.created_at
  };
}

interface SqlJobRow {
  id: string;
  job_type: JobType;
  status: JobStatus;
  dedupe_key: string | null;
  user_id: string;
  session_id: string | null;
  episode_id: string | null;
  target_memory_id: string | null;
  scope_key: string | null;
  scope_seq: number | null;
  payload_json: string;
  attempts: number;
  max_attempts: number;
  leased_until: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface SqlMemoryProcessingRow {
  memory_id: string;
  state: MemoryProcessingRecord["state"];
  stage: MemoryProcessingRecord["stage"] | null;
  active_job_id: string | null;
  attempt_count: number;
  manual_retry_count: number;
  retry_action: MemoryProcessingRecord["retryAction"];
  error_code: string | null;
  error_message: string | null;
  failed_at: string | null;
  auto_retry_scheduled?: number;
  updated_at: string;
}

interface SqlEmbeddingRetryRow {
  id: string;
  target_kind: EmbeddingRetryTargetKind;
  target_id: string;
  vector_field: EmbeddingRetryVectorField;
  source_text: string;
  embed_role: "document" | "query";
  status: EmbeddingRetryStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: number;
  claimed_by: string | null;
  lease_until: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

interface SqlSkillTrialRow {
  id: string;
  user_id: string;
  project_id: string | null;
  skill_memory_id: string;
  session_id: string | null;
  episode_id: string | null;
  l1_memory_id: string | null;
  raw_turn_id: string | null;
  turn_id: string | null;
  tool_call_id: string | null;
  status?: SkillTrialRecord["status"];
  outcome: SkillTrialRecord["outcome"];
  feedback_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

interface SqlTracePolicyLinkRow {
  id: string;
  user_id: string;
  l1_memory_id: string;
  l2_memory_id: string;
  relation: string;
  strength: number;
  created_at: string;
}

interface SqlDecisionRepairRow {
  id: string;
  session_id: string | null;
  episode_id: string | null;
  raw_turn_id: string | null;
  user_id: string;
  project_id: string | null;
  context_hash: string | null;
  issue: string;
  suggestion: string;
  preference: string | null;
  anti_pattern: string | null;
  high_value_memory_ids_json: string;
  low_value_memory_ids_json: string;
  attached_policy_memory_ids_json: string;
  feedback_id: string | null;
  validated: number;
  source_json: string;
  meta_json: string;
  created_at: string;
}

interface SqlCandidatePoolRow {
  id: string;
  user_id: string;
  session_id: string | null;
  source_memory_id: string;
  candidate_key: string;
  candidate_value: string;
  score: number;
  status: CandidatePoolRecord["status"];
  evidence_json: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

interface SqlAuditLogRow {
  id: string;
  user_id: string;
  session_id: string | null;
  actor_json: string;
  action: string;
  target_kind: string;
  target_id: string;
  before_json: string | null;
  after_json: string | null;
  meta_json: string;
  created_at: string;
}

function jobFromSql(row: SqlJobRow): EvolutionJobRecord {
  return {
    id: row.id,
    jobType: row.job_type,
    status: row.status,
    dedupeKey: row.dedupe_key ?? undefined,
    userId: null,
    sessionId: row.session_id ?? undefined,
    episodeId: row.episode_id ?? undefined,
    targetMemoryId: row.target_memory_id ?? undefined,
    scopeKey: row.scope_key ?? undefined,
    scopeSeq: row.scope_seq ?? undefined,
    payload: parseJson(row.payload_json, {}),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    leasedUntil: row.leased_until,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function memoryProcessingFromSql(row: SqlMemoryProcessingRow): MemoryProcessingRecord {
  return {
    memoryId: row.memory_id,
    state: row.state,
    stage: row.stage,
    activeJobId: row.active_job_id,
    attemptCount: row.attempt_count,
    manualRetryCount: row.manual_retry_count,
    retryAction: row.retry_action,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    failedAt: row.failed_at,
    autoRetryScheduled: row.auto_retry_scheduled === 1,
    updatedAt: row.updated_at
  };
}

function mergeJobPayload(existing: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const merged = {
    ...existing,
    ...next
  };
  const existingRunAfter = typeof existing.runAfter === "string" ? Date.parse(existing.runAfter) : Number.NaN;
  const nextRunAfter = typeof next.runAfter === "string" ? Date.parse(next.runAfter) : Number.NaN;
  if (Number.isFinite(existingRunAfter) && Number.isFinite(nextRunAfter)) {
    merged.runAfter = existingRunAfter <= nextRunAfter ? existing.runAfter : next.runAfter;
  }
  return merged;
}

function embeddingRetryFromSql(row: SqlEmbeddingRetryRow): EmbeddingRetryRecord {
  return {
    id: row.id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    vectorField: row.vector_field,
    sourceText: row.source_text,
    embedRole: row.embed_role,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    claimedBy: row.claimed_by,
    leaseUntil: row.lease_until,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function skillTrialFromSql(row: SqlSkillTrialRow): SkillTrialRecord {
  return {
    id: row.id,
    userId: null,
    projectId: row.project_id ?? undefined,
    skillMemoryId: row.skill_memory_id,
    sessionId: row.session_id ?? undefined,
    episodeId: row.episode_id ?? undefined,
    l1MemoryId: row.l1_memory_id ?? undefined,
    rawTurnId: row.raw_turn_id ?? undefined,
    turnId: row.turn_id ?? undefined,
    toolCallId: row.tool_call_id ?? undefined,
    status: row.status ?? statusFromOutcome(row.outcome),
    outcome: row.outcome,
    feedbackId: row.feedback_id ?? undefined,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at
  };
}

function statusFromOutcome(outcome: SkillTrialRecord["outcome"]): SkillTrialRecord["status"] {
  if (outcome === "success") return "pass";
  if (outcome === "failure" || outcome === "cancelled") return "fail";
  return "pending";
}

function tracePolicyLinkFromSql(row: SqlTracePolicyLinkRow): TracePolicyLinkRecord {
  return {
    id: row.id,
    userId: null,
    l1MemoryId: row.l1_memory_id,
    l2MemoryId: row.l2_memory_id,
    relation: row.relation,
    strength: row.strength,
    createdAt: row.created_at
  };
}

function decisionRepairFromSql(row: SqlDecisionRepairRow): DecisionRepairRecord {
  return {
    id: row.id,
    sessionId: row.session_id ?? undefined,
    episodeId: row.episode_id ?? undefined,
    rawTurnId: row.raw_turn_id ?? undefined,
    userId: null,
    projectId: row.project_id ?? undefined,
    contextHash: row.context_hash ?? undefined,
    issue: row.issue,
    suggestion: row.suggestion,
    preference: row.preference ?? undefined,
    antiPattern: row.anti_pattern ?? undefined,
    highValueMemoryIds: asStringArray(parseJson(row.high_value_memory_ids_json, [])),
    lowValueMemoryIds: asStringArray(parseJson(row.low_value_memory_ids_json, [])),
    attachedPolicyMemoryIds: asStringArray(parseJson(row.attached_policy_memory_ids_json, [])),
    feedbackId: row.feedback_id ?? undefined,
    validated: row.validated !== 0,
    source: parseJson(row.source_json, {}),
    meta: parseJson(row.meta_json, {}),
    createdAt: row.created_at
  };
}

function candidatePoolFromSql(row: SqlCandidatePoolRow): CandidatePoolRecord {
  return {
    id: row.id,
    userId: null,
    sessionId: row.session_id ?? undefined,
    sourceMemoryId: row.source_memory_id,
    candidateKey: row.candidate_key,
    candidateValue: row.candidate_value,
    score: row.score,
    status: row.status,
    evidence: parseJson(row.evidence_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at
  };
}

function auditLogFromSql(row: SqlAuditLogRow): AuditLogRecord {
  return {
    id: row.id,
    userId: null,
    sessionId: row.session_id ?? undefined,
    actor: parseJson(row.actor_json, {}),
    action: row.action,
    targetKind: row.target_kind,
    targetId: row.target_id,
    before: row.before_json ? parseJson(row.before_json, undefined) : undefined,
    after: row.after_json ? parseJson(row.after_json, undefined) : undefined,
    meta: parseJson(row.meta_json, {}),
    createdAt: row.created_at
  };
}

function apiLogFromSql(row: SqlApiLogRow): ApiLogRecord {
  return {
    id: row.id,
    toolName: row.tool_name,
    ...(row.source_agent ? { sourceAgent: row.source_agent } : {}),
    inputJson: row.input_json,
    outputJson: row.output_json,
    durationMs: row.duration_ms,
    success: row.success !== 0,
    calledAt: row.called_at
  };
}

interface SqlChangeRow {
  seq: number;
  memory_id: string;
  namespace_id: string | null;
  kind: string | null;
  op: string | null;
  entity_id: string | null;
  user_id: string;
  change_type: string;
  version: number | null;
  before_json: string | null;
  after_json: string | null;
  source: string;
  created_at: string;
}

function versionFromChangePayload(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const version = (payload as { version?: unknown }).version;
  return typeof version === "number" && Number.isFinite(version) ? version : null;
}

function inferChangeKind(change: Omit<ChangeLogRecord, "seq">): string | null {
  if (change.changeType.includes("skill_trial")) return "skill_trial";
  if (change.changeType.includes("recall")) return "recall";
  if (change.changeType.includes("feedback")) return "feedback";
  if (change.changeType.includes("raw_turn") || change.memoryId.startsWith("raw_")) return "raw_turn";
  if (change.changeType.includes("session") || change.memoryId.startsWith("session_")) return "session";
  if (change.changeType.includes("episode") || change.memoryId.startsWith("episode_")) return "episode";
  if (change.changeType.includes("job") || change.memoryId.startsWith("job_")) return "job";
  const payload = isRecordLike(change.after) ? change.after : isRecordLike(change.before) ? change.before : undefined;
  const layer = payload?.memoryLayer ?? payload?.memory_layer;
  if (layer === "L1") return "trace";
  if (layer === "L2") return "policy";
  if (layer === "L3") return "world_model";
  if (layer === "Skill") return "skill";
  return null;
}

function inferChangeOp(changeType: string): string {
  if (changeType.includes("delete")) return "deleted";
  if (changeType.includes("archive")) return "archived";
  if (changeType.includes("create") || changeType.includes("insert") || changeType === "upsert") return "created";
  return "updated";
}

function inferNamespaceId(change: Omit<ChangeLogRecord, "seq">): string | null {
  const payload = isRecordLike(change.after) ? change.after : isRecordLike(change.before) ? change.before : undefined;
  const userId = stringLike(payload?.userId ?? payload?.user_id) ?? change.userId;
  const tenantId = stringLike(payload?.tenantId ?? payload?.tenant_id);
  const projectOrWorkspace = stringLike(
    payload?.projectId ??
    payload?.project_id ??
    payload?.workspaceId ??
    payload?.workspace_id ??
    payload?.appId ??
    payload?.app_id
  );
  const source = stringLike(payload?.source ?? payload?.agentId ?? payload?.agent_id) ?? DEFAULT_NAMESPACE_SOURCE;
  const profileId = stringLike(
    payload?.profileId ??
    payload?.profile_id ??
    (payload ? nestedString(payload, "info", "profile_id") : undefined) ??
    (payload ? nestedString(payload, "properties", "info", "profile_id") : undefined)
  ) ?? "default";
  const parts = [
    tenantId,
    userId,
    projectOrWorkspace,
    source,
    profileId
  ].filter(Boolean);
  return parts.length ? parts.join(":") : null;
}

function primaryKeyColumn(table: BundleTableName): string | undefined {
  if (table === "memory_change_log") return "seq";
  if (table === "memory_processing_state") return "memory_id";
  if (table === "runtime_kv") return "key";
  return "id";
}

interface BundleIdentity {
  primaryKey: string;
  sourceId: string;
  columns: string[];
  values: Array<string | number | null>;
}

function bundleIdentity(
  table: BundleTableName,
  row: Record<string, unknown>
): BundleIdentity | undefined {
  const newTableIdentityColumns: Partial<Record<BundleTableName, string[]>> = {
    memory_project_aliases: ["legacy_id"],
    memory_namespace_aliases: ["legacy_key"],
    memory_l3_overrides: ["project_key", "field"],
    memory_capture_claims: ["user_id", "source", "qa_hash"],
    source_turn_captures: ["user_id", "source", "profile_id", "namespace_key", "conversation_id", "turn_id"],
    l3_world_model_scopes: ["scope_key"],
    l3_world_model_session_cursors: ["session_id"],
    work_memory_session_cursors: ["session_id"],
    l3_world_model_input_traces: ["session_id", "trace_seq"],
    l3_world_model_evidence_batches: ["id"],
    l3_world_model_batch_targets: ["batch_id", "target_field"],
    l3_world_model_project_environment_state: ["user_id", "project_id"]
  };
  const newColumns = newTableIdentityColumns[table];
  if (newColumns) {
    const values = newColumns.map((column) => row[column]);
    if (values.some((value) => value !== null && typeof value !== "string" && typeof value !== "number")) {
      return undefined;
    }
    const identity: Record<string, string | number | null> = {};
    for (const [index, column] of newColumns.entries()) {
      identity[column] = values[index] as string | number | null;
    }
    return {
      primaryKey: newColumns.join("+"),
      sourceId: canonicalJson(identity),
      columns: newColumns,
      values: values as Array<string | number | null>
    };
  }

  const primaryKey = primaryKeyColumn(table);
  const value = primaryKey ? row[primaryKey] : undefined;
  if (!primaryKey || (typeof value !== "string" && typeof value !== "number")) {
    return undefined;
  }
  return {
    primaryKey,
    sourceId: String(value),
    columns: [primaryKey],
    values: [value]
  };
}

function recordMigrationMap(
  migrationMap: Record<string, Record<string, string>>,
  table: string,
  sourceId: string | number,
  targetId: string | number
): void {
  const tableMap = migrationMap[table] ?? {};
  tableMap[String(sourceId)] = String(targetId);
  migrationMap[table] = tableMap;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringLike(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function nestedString(record: Record<string, unknown>, ...path: string[]): string | undefined {
  let value: unknown = record;
  for (const key of path) {
    if (!isRecordLike(value)) return undefined;
    value = value[key];
  }
  return stringLike(value);
}

function redactBundleRow(table: BundleTableName, row: Record<string, unknown>): Record<string, unknown> {
  if (table !== "raw_turns") {
    return row;
  }
  return {
    ...row,
    user_text: null,
    assistant_text: null,
    reasoning_summary: null,
    tool_calls_json: "[]",
    tool_results_json: "[]",
    redacted_at: row.redacted_at ?? nowIso()
  };
}

function normalizeRedactedL3WorldModelBundle(
  tables: Record<string, Array<Record<string, unknown>>>
): Record<string, Array<Record<string, unknown>>> {
  const batches = tables.l3_world_model_evidence_batches ?? [];
  const terminalBatchIds = new Set(
    batches
      .filter((row) => typeof row.terminal_outcome === "string" && row.terminal_outcome)
      .map((row) => String(row.id))
  );
  tables.l3_world_model_evidence_batches = batches.filter((row) => terminalBatchIds.has(String(row.id)));
  tables.l3_world_model_batch_targets = (tables.l3_world_model_batch_targets ?? [])
    .filter((row) => terminalBatchIds.has(String(row.batch_id)));
  tables.evolution_jobs = (tables.evolution_jobs ?? []).filter((row) => {
    const jobType = row.job_type;
    if (jobType !== "l3_world_model_update" && jobType !== "project_environment_profile") return true;
    return row.status === "succeeded" || row.status === "dead_letter";
  });
  tables.l3_world_model_project_environment_state = (
    tables.l3_world_model_project_environment_state ?? []
  ).map((row) => ({
    ...row,
    status: "uninitialized",
    current_scan_id: null,
    last_error: null
  }));

  const exportedAt = nowIso();
  const cursors = new Map<string, Record<string, unknown>>();
  for (const row of tables.l3_world_model_session_cursors ?? []) {
    if (typeof row.session_id === "string") cursors.set(row.session_id, row);
  }
  for (const trace of tables.l3_world_model_input_traces ?? []) {
    if (typeof trace.session_id !== "string" || typeof trace.trace_seq !== "number") continue;
    const current = cursors.get(trace.session_id);
    const lastScheduledSeq = typeof current?.last_scheduled_seq === "number"
      ? current.last_scheduled_seq
      : 0;
    if (trace.trace_seq <= lastScheduledSeq) continue;
    cursors.set(trace.session_id, {
      ...(current ?? { __table: "l3_world_model_session_cursors" }),
      session_id: trace.session_id,
      last_scheduled_seq: trace.trace_seq,
      updated_at: exportedAt
    });
  }
  tables.l3_world_model_session_cursors = [...cursors.values()];
  return tables;
}

function serializeBundleRow(table: BundleTableName, row: Record<string, unknown>): Record<string, unknown> {
  const serialized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    serialized[key] = Buffer.isBuffer(value)
      ? { __memmy_type: "buffer", base64: value.toString("base64") }
      : value;
  }
  serialized.__table = table;
  return serialized;
}

function deserializeBundleRow(row: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "__table") {
      continue;
    }
    normalized[key] = isSerializedBuffer(value)
      ? Buffer.from(value.base64, "base64")
      : value;
  }
  return normalized;
}

function applyBundleDefaults(table: BundleTableName, row: Record<string, unknown>): Record<string, unknown> {
  if (table === "sessions" && row.last_seen_at === undefined) {
    return {
      ...row,
      last_seen_at: row.updated_at ?? row.opened_at ?? nowIso()
    };
  }
  if (table === "episodes") {
    const rawTurnIds = typeof row.raw_turn_ids_json === "string"
      ? asStringArray(parseJson(row.raw_turn_ids_json, []))
      : [];
    return {
      ...row,
      project_id: row.project_id ?? null,
      feedback_ids_json: row.feedback_ids_json ?? "[]",
      decision_repair_ids_json: row.decision_repair_ids_json ?? "[]",
      l2_policy_ids_json: row.l2_policy_ids_json ?? "[]",
      l3_world_model_ids_json: row.l3_world_model_ids_json ?? "[]",
      skill_memory_ids_json: row.skill_memory_ids_json ?? "[]",
      turn_count: row.turn_count ?? rawTurnIds.length,
      r_task: row.r_task ?? null,
      reward_detail_json: row.reward_detail_json ?? "{}",
      pipeline_run_id: row.pipeline_run_id ?? null,
      pipeline_status: row.pipeline_status ?? "idle",
      pipeline_error: row.pipeline_error ?? null
    };
  }
  return row;
}

function normalizeBundleSqlValue(value: unknown): SqlValue {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }
  if (value === null || value === undefined) {
    return null;
  }
  return toJson(value);
}

function isL3WorldModelTargetField(value: unknown): value is L3WorldModelTargetField {
  return value === "general_rules_and_safety_constraints" ||
    value === "project_contract" ||
    value === "domain_knowledge";
}

function updateL3WorldModelBatchTerminalOutcome(
  db: Database.Database,
  batchId: string,
  at: string
): void {
  const rows = db.prepare(
    `SELECT status FROM l3_world_model_batch_targets WHERE batch_id = ?`
  ).all(batchId) as Array<{ status: L3WorldModelBatchTargetRecord["status"] }>;
  if (rows.length === 0 || rows.some((row) => row.status === "queued")) return;
  const applied = rows.filter((row) => row.status === "applied").length;
  const terminalOutcome: NonNullable<L3WorldModelEvidenceBatchRecord["terminalOutcome"]> = applied === rows.length
    ? "applied"
    : applied === 0
      ? "dead_letter"
      : "partial_dead_letter";
  db.prepare(
    `UPDATE l3_world_model_evidence_batches
     SET terminal_outcome = ?, completed_at = ?, updated_at = ?
     WHERE id = ?`
  ).run(terminalOutcome, at, at, batchId);
}

function isSerializedBuffer(value: unknown): value is { __memmy_type: "buffer"; base64: string } {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { __memmy_type?: unknown }).__memmy_type === "buffer" &&
    typeof (value as { base64?: unknown }).base64 === "string";
}

function evolutionJobOrderSql(): string {
  const memoryProcessingJob = `job_type IN ('trace_summary', 'import_summary', 'observation_extract', 'embedding')
    AND target_memory_id IS NOT NULL`;
  return `${evolutionJobPrioritySql()} ASC,
           CASE WHEN ${memoryProcessingJob}
             THEN COALESCE(
               (SELECT created_at FROM memories WHERE memories.id = evolution_jobs.target_memory_id),
               created_at
             )
             ELSE ''
           END DESC,
           CASE
             WHEN job_type IN ('trace_summary', 'import_summary', 'observation_extract') THEN 0
             WHEN job_type = 'embedding' THEN 1
             ELSE 2
           END ASC,
           CASE WHEN status = 'leased' THEN 0 ELSE 1 END ASC,
           created_at ASC,
           rowid ASC`;
}

function evolutionJobPrioritySql(): string {
  const onboardingFirstReportTarget = targetMemoryMatchesSql(onboardingFirstReportMemorySql("memories"));
  const importedTarget = targetMemoryMatchesSql(agentSourceMemorySql("memories"));
  const interactiveL1Target = targetMemoryMatchesSql(
    `memories.memory_layer = 'L1' AND NOT (${agentSourceMemorySql("memories")})`
  );
  // The background drain leases only the highest tier present. Computer History
  // shares the trace tier so recency, not a backfill of old Agent turns, decides
  // when a fresh History window becomes memory.
  return `CASE
             WHEN job_type IN ('trace_summary', 'import_summary', 'observation_extract', 'embedding')
               AND ${onboardingFirstReportTarget} THEN -100
             WHEN json_extract(payload_json, '$.source') = 'memory.processing.manual_retry' THEN 0
             WHEN job_type IN ('trace_summary', 'import_summary')
               AND json_extract(payload_json, '$.source') IN (
                 'startup.processing_repair',
                 'startup.placeholder_summary_repair'
               ) THEN 90
             WHEN job_type IN ('trace_summary', 'observation_extract')
               OR (job_type = 'embedding' AND ${interactiveL1Target}) THEN 1
             WHEN job_type = 'import_summary'
               OR (job_type = 'embedding' AND ${importedTarget}) THEN 2
             WHEN job_type = 'embedding' THEN 3
             WHEN job_type = 'episode_idle_close' THEN 10
             WHEN job_type = 'episode_title' THEN 15
             WHEN job_type = 'reflection' THEN 20
             WHEN job_type = 'decision_repair' THEN 25
             WHEN job_type = 'reward' THEN 30
             WHEN job_type = 'span_big_turn' THEN 35
             WHEN job_type = 'l2_association' THEN 40
             WHEN job_type = 'l2_induction' THEN 50
             WHEN job_type = 'project_environment_profile' THEN 55
             WHEN job_type IN ('l3_abstraction', 'l3_world_model_update') THEN 60
             WHEN job_type = 'skill_crystallization' THEN 70
             WHEN job_type = 'skill_cluster_assign' THEN 72
             WHEN job_type = 'skill_batch_evolve' THEN 73
             WHEN job_type = 'skill_trial_resolve' THEN 80
             ELSE 100
           END`;
}

function targetMemoryMatchesSql(predicate: string): string {
  return `EXISTS (
    SELECT 1
    FROM memories
    WHERE memories.id = evolution_jobs.target_memory_id
      AND ${predicate}
  )`;
}

function agentSourceMemorySql(alias: string): string {
  return `(
    json_extract(${alias}.properties_json, '$.internal_info.plugin_algorithm') LIKE 'memory.add.import_async.%'
    OR EXISTS (
      SELECT 1
      FROM json_each(${alias}.tags_json)
      WHERE lower(json_each.value) = 'agent-source'
    )
  )`;
}

function onboardingFirstReportMemorySql(alias: string): string {
  return `(
    lower(COALESCE(${alias}.agent_id, '')) = 'memmy-onboarding'
    OR EXISTS (
      SELECT 1
      FROM json_each(${alias}.tags_json)
      WHERE lower(json_each.value) IN ('first-encounter-report', 'onboarding-report')
    )
  )`;
}

function embeddingRetryOrderSql(): string {
  const onboardingFirstReport = onboardingFirstReportMemorySql("m");
  const importedMemory = agentSourceMemorySql("m");
  return `CASE
             WHEN ${onboardingFirstReport} THEN -100
             WHEN q.target_kind = 'trace' AND m.memory_layer = 'L1' AND NOT (${importedMemory}) THEN 0
             WHEN q.target_kind = 'trace' AND m.memory_layer = 'L1' AND ${importedMemory} THEN 1
             ELSE 2
           END ASC,
           m.created_at DESC,
           q.next_attempt_at ASC,
           q.created_at ASC`;
}

export function jobToRef(job: EvolutionJobRecord): JobRef {
  return {
    jobId: job.id,
    jobType: job.jobType,
    status: job.status,
    targetMemoryId: job.targetMemoryId
  };
}
