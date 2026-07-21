import type Database from "better-sqlite3";
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
  MemoryStatus,
  RecallHit
} from "../types.js";
import { DEFAULT_NAMESPACE_SOURCE } from "../types.js";
import { newId, stableHash } from "../utils/id.js";
import { asStringArray, parseJson, toJson } from "../utils/json.js";
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

type SqlValue = string | number | Buffer | null;
const BUNDLE_TABLES = [
  "memories",
  "sessions",
  "episodes",
  "raw_turns",
  "feedback",
  "decision_repairs",
  "l2_candidate_pool",
  "trace_policy_links",
  "skill_trials",
  "recall_events",
  "api_logs",
  "memory_change_log",
  "evolution_jobs",
  "embedding_retry_queue",
  "memory_processing_state",
  "runtime_kv",
  "artifacts",
  "audit_logs"
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
  userId: string;
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
  userId: string;
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

export interface RawTurnRecord {
  id: string;
  sessionId: string;
  episodeId: string;
  turnId: string;
  userId: string;
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

export interface FeedbackRecord {
  id: string;
  userId: string;
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
  userId: string;
  query: string;
  queryHash?: string;
  layers: MemoryLayer[];
  candidateMemoryIds?: string[];
  injectedMemoryIds?: string[];
  hitMemoryIds: string[];
  dropped?: unknown[];
  outcome?: "pending" | "positive" | "negative" | "ignored";
  request: unknown;
  createdAt: string;
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
  userId: string;
  sessionId?: string;
  episodeId?: string;
  targetMemoryId?: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  leasedUntil?: string | null;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
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
  userId: string;
  changeType: string;
  version?: number;
  before?: unknown;
  after?: unknown;
  source: string;
  createdAt: string;
}

export interface SkillTrialRecord {
  id: string;
  userId: string;
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
  userId: string;
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
  userId: string;
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
  userId: string;
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
  userId: string;
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
    this.indexFts(prepared.memory);
    return attachMemoryVectors(prepared.memory, prepared.vectors);
  }

  update(memory: MemoryRow): MemoryRow {
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
             user_id = @userId,
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
    this.indexFts(updated);
    return attachMemoryVectors(updated, updated.deletedAt || updated.status === "deleted" ? [] : mergedVectors);
  }

  upsertByKey(memory: MemoryRow): {
    memory: MemoryRow;
    created: boolean;
    previous?: MemoryRow;
  } {
    const previous = memory.memoryKey
      ? this.getByKey(memory.userId, memory.memoryLayer, memory.memoryKey)
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
    return row ? this.hydrate(memoryFromSql(row)) : undefined;
  }

  getIncludingDeleted(id: string): MemoryRow | undefined {
    const row = this.db
      .prepare(`SELECT * FROM memories WHERE id = ?`)
      .get(id) as MemorySqlRow | undefined;
    return row ? this.hydrate(memoryFromSql(row)) : undefined;
  }

  getByKey(userId: string, memoryLayer: MemoryLayer, key: string): MemoryRow | undefined {
    void userId;
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
    return row ? this.hydrate(memoryFromSql(row)) : undefined;
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
      const memory = memoryFromSql(row);
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
    return this.hydrateMany(rows.map(memoryFromSql));
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
    return this.hydrateMany(rows.map(memoryFromSql));
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
    return this.hydrateMany(rows.map(memoryFromSql));
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
    return this.hydrateMany(rows.map(memoryFromSql));
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
      .map(memoryFromSql)
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

  countByLayer(userId?: string): Record<MemoryLayer, number> {
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

  countByStatus(userId?: string): Record<MemoryStatus, number> {
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
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
      version: memory.version
    };
  }

  private indexFts(memory: MemoryRow): void {
    try {
      this.db.prepare(`DELETE FROM memories_fts WHERE id = ?`).run(memory.id);
      if (!memory.deletedAt && memory.status !== "deleted") {
        this.db
          .prepare(`INSERT INTO memories_fts (id, identifier, memory_value, tags) VALUES (?, ?, ?, ?)`)
          .run(memory.id, memory.id, memory.memoryValue, memory.tags.join(" "));
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
    const clauses = normalized.map(() => {
      const columns = [
        "lower(memories.id) LIKE ? ESCAPE '\\'",
        "lower(COALESCE(memories.memory_key, '')) LIKE ? ESCAPE '\\'",
        "lower(memories.memory_value) LIKE ? ESCAPE '\\'",
        "lower(memories.properties_json) LIKE ? ESCAPE '\\'",
        "lower(memories.info_json) LIKE ? ESCAPE '\\'"
      ];
      if (includeTags) columns.push("lower(memories.tags_json) LIKE ? ESCAPE '\\'");
      return `(${columns.join(" OR ")})`;
    });
    const params = normalized.flatMap((term) => {
      const pattern = `%${escapeLikePattern(term)}%`;
      return includeTags
        ? [pattern, pattern, pattern, pattern, pattern, pattern]
        : [pattern, pattern, pattern, pattern, pattern];
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

export class MemoryProcessingRepository {
  constructor(private readonly db: Database.Database) {}

  get(memoryId: string): MemoryProcessingRecord | undefined {
    const row = this.db.prepare(
      `SELECT * FROM memory_processing_state WHERE memory_id = ?`
    ).get(memoryId) as SqlMemoryProcessingRow | undefined;
    return row ? memoryProcessingFromSql(row) : undefined;
  }

  getMany(memoryIds: readonly string[]): MemoryProcessingRecord[] {
    if (memoryIds.length === 0) return [];
    const placeholders = memoryIds.map(() => "?").join(", ");
    const rows = this.db.prepare(
      `SELECT * FROM memory_processing_state
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
      `SELECT * FROM memory_processing_state
       WHERE state IN (${placeholders})
       ORDER BY updated_at ASC, memory_id ASC
       LIMIT ?`
    ).all(...states, limit) as SqlMemoryProcessingRow[]).map(memoryProcessingFromSql);
  }

  save(record: MemoryProcessingRecord): MemoryProcessingRecord {
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
      ...record,
      stage: record.stage ?? null,
      activeJobId: record.activeJobId ?? null,
      errorCode: record.errorCode ?? null,
      errorMessage: record.errorMessage ?? null,
      failedAt: record.failedAt ?? null
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
}

export class RuntimeRepository {
  private readonly scheduledLogPrunes = new Set<LogTableName>();

  constructor(private readonly db: Database.Database) {}

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

  createSession(session: SessionRecord): SessionRecord {
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
    return row ? sessionFromSql(row) : undefined;
  }

  findOpenSessionByHostKey(input: {
    userId: string;
    source: string;
    profileId: string;
    hostSessionKey: string;
  }): SessionRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT *
         FROM sessions
         WHERE user_id = ?
           AND source = ?
           AND profile_id = ?
           AND host_session_key = ?
           AND status = 'open'
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(input.userId, input.source, input.profileId, input.hostSessionKey) as SqlSessionRow | undefined;
    return row ? sessionFromSql(row) : undefined;
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
    return rows.map(episodeFromSql);
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
    return rows.map(episodeFromSql);
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
      status: "closed",
      closedAt: episode.closedAt ?? at,
      meta,
      updatedAt: at
    };
  }

  reopenEpisode(episodeId: string, metaPatch: Record<string, unknown> = {}, at = nowIso()): EpisodeRecord | undefined {
    const episode = this.getEpisode(episodeId);
    if (!episode) return undefined;
    const meta = {
      ...episode.meta,
      ...metaPatch
    };
    this.db
      .prepare(
        `UPDATE episodes
         SET status = 'open',
             closed_at = NULL,
             meta_json = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(toJson(meta), at, episodeId);
    return {
      ...episode,
      status: "open",
      closedAt: null,
      meta,
      updatedAt: at
    };
  }

  countEpisodesByStatus(userId?: string): Record<"open" | "processing" | "closed", number> {
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

  countEpisodes(userId?: string, query?: string): number {
    const built = buildEpisodeWhere(userId, query);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM episodes
         WHERE ${built.where}`
      )
      .get(...built.params) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  listEpisodes(userId?: string, limit = 50, offset = 0, query?: string): EpisodeRecord[] {
    const built = buildEpisodeWhere(userId, query);
    const rows = this.db
      .prepare(
        `SELECT *
         FROM episodes
         WHERE ${built.where}
         ORDER BY opened_at DESC, updated_at DESC, id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...built.params, limit, offset) as SqlEpisodeRow[];
    return rows.map(episodeFromSql);
  }

  deleteEpisode(id: string): boolean {
    const result = this.db.prepare("DELETE FROM episodes WHERE id = ?").run(id);
    return result.changes === 1;
  }

  createEpisode(episode: EpisodeRecord): EpisodeRecord {
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
    return row ? episodeFromSql(row) : undefined;
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
    return row ? episodeFromSql(row) : undefined;
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
      rawTurnIds,
      turnCount: rawTurnIds.length,
      updatedAt: at
    };
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
      [field]: values,
      updatedAt: at
    };
  }

  insertRawTurn(rawTurn: RawTurnRecord): RawTurnRecord {
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
    this.db
      .prepare(
        `UPDATE raw_turns
         SET user_text = @userText,
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

  getRawTurnBySessionTurn(sessionId: string, turnId: string): RawTurnRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM raw_turns WHERE session_id = ? AND turn_id = ?`)
      .get(sessionId, turnId) as SqlRawTurnRow | undefined;
    return row ? rawTurnFromSql(row) : undefined;
  }

  listRawTurnsByEpisode(episodeId: string, limit = 100): RawTurnRecord[] {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM raw_turns
         WHERE episode_id = ?
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(episodeId, limit) as SqlRawTurnRow[];
    return rows.map(rawTurnFromSql);
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
    userId?: string;
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
          hit_memory_ids_json, dropped_json, outcome, request_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.id,
        event.namespaceId ?? null,
        event.sessionId ?? null,
        event.episodeId ?? null,
        event.turnId ?? null,
        event.userId,
        event.query,
        event.queryHash ?? stableHash(event.query),
        toJson(event.layers),
        toJson(event.candidateMemoryIds ?? event.hitMemoryIds),
        toJson(event.injectedMemoryIds ?? event.hitMemoryIds),
        toJson(event.hitMemoryIds),
        toJson(event.dropped ?? []),
        event.outcome ?? "pending",
        toJson(event.request),
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
        change.before === undefined ? null : toJson(change.before),
        change.after === undefined ? null : toJson(change.after),
        change.source,
        change.createdAt
    );
    const seq = Number(result.lastInsertRowid);
    this.scheduleLogTablePruneAfterInsert("memory_change_log", seq);
    return seq;
  }

  latestChangeSeq(userId?: string, namespaceId?: string): number {
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

  listChanges(userId?: string, limit = 50, cursor?: number, namespaceId?: string): ChangeLogRecord[] {
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
      userId: row.user_id,
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
    const transaction = this.db.transaction(() => {
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
            payload_json, attempts, max_attempts, leased_until, last_error,
            created_at, updated_at
          ) VALUES (
            @id, @jobType, @status, @dedupeKey, @userId, @sessionId, @episodeId, @targetMemoryId,
            @payloadJson, @attempts, @maxAttempts, @leasedUntil, @lastError,
            @createdAt, @updatedAt
          )`
        )
        .run({
          ...job,
          dedupeKey: job.dedupeKey ?? null,
          sessionId: job.sessionId ?? null,
          episodeId: job.episodeId ?? null,
          targetMemoryId: job.targetMemoryId ?? null,
          payloadJson: toJson(job.payload),
          leasedUntil: job.leasedUntil ?? null,
          lastError: job.lastError ?? null
        });
      return job;
    });
    return transaction();
  }

  listJobs(status?: JobStatus, limit = 50, userId?: string): EvolutionJobRecord[] {
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

  nextWorkerRunAt(): number | undefined {
    const queuedJob = this.db
      .prepare(
        `SELECT CAST(json_extract(payload_json, '$.runAfter') AS TEXT) AS run_after
         FROM evolution_jobs
         WHERE status = 'queued'
           AND attempts < max_attempts
           AND json_type(payload_json, '$.runAfter') = 'text'
         ORDER BY run_after ASC
         LIMIT 1`
      )
      .get() as { run_after: string } | undefined;
    const leasedJob = this.db
      .prepare(
        `SELECT leased_until
         FROM evolution_jobs
         WHERE status = 'leased'
           AND attempts < max_attempts
           AND leased_until IS NOT NULL
         ORDER BY leased_until ASC
         LIMIT 1`
      )
      .get() as { leased_until: string } | undefined;
    const pendingEmbedding = this.db
      .prepare(
        `SELECT next_attempt_at
         FROM embedding_retry_queue
         WHERE status = 'pending'
         ORDER BY next_attempt_at ASC
         LIMIT 1`
      )
      .get() as { next_attempt_at: number } | undefined;
    const inProgressEmbedding = this.db
      .prepare(
        `SELECT MAX(next_attempt_at, lease_until) AS run_at
         FROM embedding_retry_queue
         WHERE status = 'in_progress'
           AND lease_until IS NOT NULL
         ORDER BY run_at ASC
         LIMIT 1`
      )
      .get() as { run_at: number } | undefined;
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

  getPendingJob(
    targetMemoryId: string,
    jobType: JobType,
    contentHash?: string
  ): EvolutionJobRecord | undefined {
    const contentClause = contentHash
      ? "AND json_extract(payload_json, '$.contentHash') = ?"
      : "";
    const row = this.db
      .prepare(
        `SELECT *
         FROM evolution_jobs
         WHERE target_memory_id = ?
           AND job_type = ?
           AND status IN ('queued', 'leased')
           ${contentClause}
         ORDER BY ${evolutionJobOrderSql()}
         LIMIT 1`
      )
      .get(targetMemoryId, jobType, ...(contentHash ? [contentHash] : [])) as SqlJobRow | undefined;
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
    targetMemoryIds?: readonly string[]
  ): EvolutionJobRecord[] {
    if (targetMemoryIds?.length === 0) {
      return [];
    }
    const at = nowIso();
    const leaseUntil = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    const targetFilter = targetMemoryIds
      ? `AND target_memory_id IN (${targetMemoryIds.map(() => "?").join(", ")})`
      : "";
    const transaction = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT *
           FROM evolution_jobs
           WHERE (status = 'queued'
              OR (status = 'leased' AND leased_until IS NOT NULL AND leased_until <= ?))
             AND attempts < max_attempts
             AND (
               json_extract(payload_json, '$.runAfter') IS NULL
               OR CAST(json_extract(payload_json, '$.runAfter') AS TEXT) <= ?
             )
             ${targetFilter}
           ORDER BY ${evolutionJobOrderSql()}
           LIMIT ?`
        )
        .all(at, at, ...(targetMemoryIds ?? []), limit) as SqlJobRow[];

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

  failJob(id: string, error: string, at = nowIso()): EvolutionJobRecord | undefined {
    const row = this.db
      .prepare(`SELECT attempts, max_attempts FROM evolution_jobs WHERE id = ?`)
      .get(id) as { attempts: number; max_attempts: number } | undefined;
    const status: JobStatus =
      row && row.attempts >= row.max_attempts ? "dead_letter" : "failed";
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
    return this.getJob(id);
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
    userId?: string,
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
         ORDER BY q.next_attempt_at ASC, q.created_at ASC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as SqlEmbeddingRetryRow[];
    return rows.map(embeddingRetryFromSql);
  }

  countEmbeddingRetriesByStatus(
    status: EmbeddingRetryStatus,
    userId?: string
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
      ? `AND target_id IN (${input.targetMemoryIds.map(() => "?").join(", ")})`
      : "";
    const transaction = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT *
           FROM embedding_retry_queue
           WHERE (
             status = 'pending'
             OR (status = 'in_progress' AND lease_until IS NOT NULL AND lease_until <= ?)
           )
             AND next_attempt_at <= ?
             ${targetFilter}
           ORDER BY next_attempt_at ASC, created_at ASC
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
        trial.userId,
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
    userId?: string;
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
    userId: string;
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
        input.userId,
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
      userId: input.userId,
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
    userId?: string;
    contextHash?: string;
    since?: string;
    limit?: number;
  } = {}): DecisionRepairRecord[] {
    const clauses = ["1=1"];
    const params: SqlValue[] = [];
    void input.userId;
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

  upsertCandidatePoolTrace(input: {
    id: string;
    userId: string;
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
        input.userId,
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
    userId?: string;
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
    return rows.map(candidatePoolFromSql);
  }

  pruneCandidatePool(now = nowIso()): number {
    const result = this.db
      .prepare(`DELETE FROM l2_candidate_pool WHERE expires_at IS NOT NULL AND expires_at < ?`)
      .run(now);
    return result.changes;
  }

  markCandidatePoolPromoted(input: {
    userId?: string;
    candidateKey: string;
    sourceMemoryIds: string[];
    policyId: string;
    at: string;
  }): void {
    const sourceMemoryIds = uniq(input.sourceMemoryIds);
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
    userId: string;
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
        input.userId,
        input.l1MemoryId,
        input.l2MemoryId,
        input.relation ?? "supports",
        input.strength ?? 1,
        input.createdAt ?? nowIso()
      );
    return id;
  }

  listTracePolicyLinks(input: {
    userId?: string;
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
      userId: input.userId,
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
    userId?: string;
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
    const excludedSourceAgents = Array.from(new Set(
      (input.excludedSourceAgents ?? []).map(normalizeAgentIdKey).filter(Boolean)
    ));
    const excludedPlaceholders = excludedSourceAgents.map(() => "?").join(", ");
    const sourceAgentFilter = sourceAgent
      ? `AND lower(replace(replace(TRIM(source_agent), '-', '_'), ' ', '_')) = ?`
      : excludedSourceAgents.length > 0
        ? `AND (
             NULLIF(TRIM(source_agent), '') IS NULL
             OR lower(replace(replace(TRIM(source_agent), '-', '_'), ' ', '_')) NOT IN (${excludedPlaceholders})
           )`
        : "";
    const parameters = sourceAgent
      ? [...tools, normalizeAgentIdKey(sourceAgent)]
      : excludedSourceAgents.length > 0
        ? [...tools, ...excludedSourceAgents]
        : tools;
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
      tables[table] = rows.map((row) => serializeBundleRow(
        table,
        includeRawText ? row : redactBundleRow(table, row)
      ));
    }
    return tables;
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
      for (const table of BUNDLE_TABLES) {
        const rows = Array.isArray(tables[table]) ? tables[table] as Array<Record<string, unknown>> : [];
        for (const row of rows) {
          const normalized = applyBundleDefaults(table, deserializeBundleRow(row));
          const primaryKey = primaryKeyColumn(table);
          const primaryValue = primaryKey ? normalized[primaryKey] : undefined;
          if (primaryKey && (typeof primaryValue === "string" || typeof primaryValue === "number")) {
            recordMigrationMap(result.migrationMap, table, primaryValue, primaryValue);
          }
          const existed = primaryKey !== undefined &&
            (typeof primaryValue === "string" || typeof primaryValue === "number") &&
            this.rowExists(table, primaryKey, primaryValue);
          if (existed && conflictStrategy === "skip") {
            result.conflicts.push({
              table,
              primaryKey: primaryKey!,
              sourceId: String(primaryValue),
              targetId: String(primaryValue),
              action: "skipped"
            });
            result.skipped[table] = (result.skipped[table] ?? 0) + 1;
            continue;
          }
          if (existed && conflictStrategy === "error") {
            result.conflicts.push({
              table,
              primaryKey: primaryKey!,
              sourceId: String(primaryValue),
              targetId: String(primaryValue),
              action: "error"
            });
            throw new Error(`import conflict for ${table}.${primaryKey}=${String(primaryValue)}`);
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
              primaryKey: primaryKey!,
              sourceId: String(primaryValue),
              targetId: String(primaryValue),
              action: "replaced"
            });
            result.replaced[table] = (result.replaced[table] ?? 0) + 1;
          } else {
            result.inserted[table] = (result.inserted[table] ?? 0) + 1;
          }
        }
      }
    })();
    this.scheduleLogTablesPrune();
    return result;
  }

  private rowExists(table: BundleTableName, column: string, value: string | number): boolean {
    if (!this.tableColumns(table).includes(column)) {
      return false;
    }
    const row = this.db.prepare(`SELECT 1 AS ok FROM ${table} WHERE ${column} = ? LIMIT 1`).get(value) as
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
    userId: string;
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
        input.userId,
        input.kind,
        input.uri ?? null,
        toJson(input.payload),
        input.createdAt ?? nowIso()
      );
    return id;
  }
}

export class Repositories {
  readonly memories: MemoryRepository;
  readonly processing: MemoryProcessingRepository;
  readonly runtime: RuntimeRepository;
  readonly vectors: SqliteVecStore;

  constructor(readonly db: Database.Database) {
    this.vectors = new SqliteVecStore(db);
    this.memories = new MemoryRepository(db, this.vectors);
    this.processing = new MemoryProcessingRepository(db);
    this.runtime = new RuntimeRepository(db);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

export function memoryFromSql(row: MemorySqlRow): MemoryRow {
  const info = parseJson<Record<string, unknown>>(row.info_json, {});
  const properties = parseJson<MemoryRow["properties"]>(row.properties_json, {
    internal_info: {
      memory_layer: row.memory_layer
    }
  });
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
    userId: row.user_id,
    conversationId: row.conversation_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    appId: row.app_id ?? undefined,
    memoryType: row.memory_type,
    status: row.status,
    visibility: row.visibility,
    memoryKey: row.memory_key ?? undefined,
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

export function memoryToSql(memory: MemoryRow): Record<string, SqlValue> {
  return {
    id: memory.id,
    timeline: memory.timeline,
    userId: memory.userId,
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
  const policy = recordValue(internal.policy);
  const world = recordValue(internal.world_model);
  const skill = recordValue(internal.skill);
  const placeholderSummary = firstNonEmptyString(stringLike(memory.info.summary), stringLike(internal.summary));
  const importedUserTitle = isPlaceholderMemorySummary(placeholderSummary)
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
  const policy = recordValue(internal.policy);
  const world = recordValue(internal.world_model);
  const skill = recordValue(internal.skill);
  return firstNonEmptyString(
    stringLike(memory.info.summary),
    stringLike(internal.summary),
    stringLike(policy.trigger),
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
  for (const line of value.split(/\r?\n/)) {
    const role = memoryValueRoleMarker(line);
    if (role) {
      inUserSection = role === "user";
      continue;
    }
    if (!inUserSection) {
      continue;
    }

    const cleaned = cleanMemoryValueLine(line);
    if (cleaned && !isPlaceholderMemorySummary(cleaned) && !isWorldSectionHeading(cleaned) && !isInternalMemoryKey(cleaned)) {
      return cleaned;
    }
  }
  return undefined;
}

function isPlaceholderMemorySummary(value: string | undefined): boolean {
  const first = value
    ?.split(/\r?\n/)
    .map(cleanMemoryValueLine)
    .find(Boolean);
  return Boolean(first && /^(user|assistant|system|tool|developer|摘要排队中|摘要整理中|建立索引中|索引建立中|索引已建立|反思生成中)$/i.test(first));
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

function normalizeAgentIdKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/gu, "_");
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

  addValueClause("user_id", filter.userId);
  addValueClause("session_id", filter.sessionId);
  addValueClause("conversation_id", filter.conversationId);
  addAgentIdClause(filter.agentId, filter.excludedAgentIds);
  addValueClause("app_id", filter.appId);
  addArrayClause("memory_layer", filter.memoryLayer);
  addArrayClause("status", filter.status);
  addArrayClause("id", filter.ids);
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

  function addAgentIdClause(value: string | undefined, excludedValues: string[] | undefined): void {
    if (value?.trim()) {
      clauses.push("lower(replace(replace(trim(agent_id), '-', '_'), ' ', '_')) = ?");
      params.push(normalizeAgentIdKey(value));
      return;
    }
    const excluded = Array.from(new Set((excludedValues ?? []).map(normalizeAgentIdKey).filter(Boolean)));
    if (excluded.length > 0) {
      clauses.push(`(
        NULLIF(TRIM(agent_id), '') IS NULL
        OR lower(replace(replace(trim(agent_id), '-', '_'), ' ', '_')) NOT IN (${excluded.map(() => "?").join(", ")})
      )`);
      params.push(...excluded);
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

function buildEpisodeWhere(userId?: string, query?: string): { where: string; params: SqlValue[] } {
  const clauses = ["1=1"];
  const params: SqlValue[] = [];
  if (userId) {
    clauses.push("episodes.user_id = ?");
    params.push(userId);
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

function sessionFromSql(row: SqlSessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    source: row.source,
    profileId: row.profile_id,
    profileLabel: row.profile_label ?? undefined,
    projectId: row.project_id ?? undefined,
    workspaceId: row.workspace_id ?? undefined,
    workspacePath: row.workspace_path ?? undefined,
    hostSessionKey: row.host_session_key ?? undefined,
    conversationId: row.conversation_id ?? undefined,
    status: row.status,
    meta: parseJson(row.meta_json, {}),
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

function episodeFromSql(row: SqlEpisodeRow): EpisodeRecord {
  const rawTurnIds = asStringArray(parseJson(row.raw_turn_ids_json, []));
  return {
    id: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
    projectId: row.project_id ?? undefined,
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
    userId: row.user_id,
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
    userId: row.user_id,
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
  created_at: string;
}

function recallEventFromSql(row: SqlRecallEventRow): RecallEventRecord {
  return {
    id: row.id,
    namespaceId: row.namespace_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    episodeId: row.episode_id ?? undefined,
    turnId: row.turn_id ?? undefined,
    userId: row.user_id,
    query: row.query,
    queryHash: row.query_hash ?? undefined,
    layers: asStringArray(parseJson(row.layers_json, [])) as MemoryLayer[],
    candidateMemoryIds: asStringArray(parseJson(row.candidate_memory_ids_json, [])),
    injectedMemoryIds: asStringArray(parseJson(row.injected_memory_ids_json, [])),
    hitMemoryIds: asStringArray(parseJson(row.hit_memory_ids_json, [])),
    dropped: parseJson(row.dropped_json, []),
    outcome: row.outcome,
    request: parseJson(row.request_json, {}),
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
    userId: row.user_id,
    sessionId: row.session_id ?? undefined,
    episodeId: row.episode_id ?? undefined,
    targetMemoryId: row.target_memory_id ?? undefined,
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
    userId: row.user_id,
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
    userId: row.user_id,
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
    userId: row.user_id,
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
    userId: row.user_id,
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
    userId: row.user_id,
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

function isSerializedBuffer(value: unknown): value is { __memmy_type: "buffer"; base64: string } {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { __memmy_type?: unknown }).__memmy_type === "buffer" &&
    typeof (value as { base64?: unknown }).base64 === "string";
}

function evolutionJobOrderSql(): string {
  const summaryPlaceholderSql = importSummaryPlaceholderSql();
  const importIndexingSql = importIndexingSqlPredicate();
  return `CASE WHEN status = 'leased' THEN 0 ELSE 1 END ASC,
           CASE
             WHEN json_extract(payload_json, '$.source') = 'memory.processing.manual_retry' THEN 0
             WHEN job_type = 'episode_idle_close' THEN 1
             WHEN job_type = 'embedding' AND EXISTS (
               SELECT 1
               FROM memories
               WHERE memories.id = evolution_jobs.target_memory_id
                 AND ${importIndexingSql}
             ) THEN 4
             WHEN job_type = 'trace_summary' THEN 5
             WHEN job_type = 'import_summary' THEN 6
             WHEN job_type = 'embedding' AND EXISTS (
               SELECT 1
               FROM memories
               WHERE memories.id = evolution_jobs.target_memory_id
                 AND ${summaryPlaceholderSql}
             ) THEN 7
             WHEN job_type = 'embedding' THEN 10
             WHEN job_type = 'reflection' THEN 20
             WHEN job_type = 'reward' THEN 30
             WHEN job_type = 'l2_association' THEN 40
             WHEN job_type = 'l2_induction' THEN 50
             WHEN job_type = 'l3_abstraction' THEN 60
             WHEN job_type = 'skill_crystallization' THEN 70
             WHEN job_type = 'skill_trial_resolve' THEN 80
             ELSE 100
           END ASC,
           CASE
             WHEN job_type IN ('trace_summary', 'import_summary') OR (
               job_type = 'embedding' AND EXISTS (
                 SELECT 1
                 FROM memories
                 WHERE memories.id = evolution_jobs.target_memory_id
                   AND ${summaryPlaceholderSql}
               )
             )
             THEN COALESCE((SELECT updated_at FROM memories WHERE memories.id = evolution_jobs.target_memory_id), updated_at)
             ELSE ''
           END DESC,
           created_at ASC,
           rowid ASC`;
}

function importSummaryPlaceholderSql(): string {
  const summary = "COALESCE(json_extract(memories.info_json, '$.summary'), '')";
  const firstLine = `TRIM(REPLACE(REPLACE(CASE WHEN instr(${summary}, char(10)) > 0 THEN substr(${summary}, 1, instr(${summary}, char(10)) - 1) ELSE ${summary} END, '#', ''), char(13), ''))`;
  return `${firstLine} IN ('user', 'assistant', 'system', 'tool', 'developer', '摘要排队中', '摘要整理中')`;
}

function importIndexingSqlPredicate(): string {
  return `EXISTS (
    SELECT 1
    FROM memory_processing_state
    WHERE memory_processing_state.memory_id = memories.id
      AND memory_processing_state.state IN ('embedding_pending', 'embedding')
  )`;
}

export function jobToRef(job: EvolutionJobRecord): JobRef {
  return {
    jobId: job.id,
    jobType: job.jobType,
    status: job.status,
    targetMemoryId: job.targetMemoryId
  };
}
