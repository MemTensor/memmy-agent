import type {
  FeedbackRequest,
  HealthResponse,
  InjectedContext,
  JobRef,
  JobType,
  MemoryDetailItem,
  MemoryAddRequest,
  MemoryExportRequest,
  MemoryFilter,
  MemoryGovernanceRequest,
  MemoryKind,
  MemoryLayer,
  MemoryListItem,
  MemoryProcessingRecord,
  MemoryProcessingState,
  MemoryImportRequest,
  MemoryReloadConfigRequest,
  MemoryReloadConfigResponse,
  MemorySearchRequest,
  MemoryRow,
  RawTurnSummary,
  RawTurnRedactRequest,
  RecallHit,
  RepairSuggestionRequest,
  RequestEnvelope,
  RetrievalMode,
  RuntimeNamespace,
  SessionCompactRequest,
  SessionOpenRequest,
  SkillUseRequest,
  SubagentCompleteRequest,
  SubagentStartRequest,
  ToolCallPayload,
  ToolObserveRequest,
  TurnCompleteRequest,
  TurnStartRequest
} from "../types.js";
import { PROJECT_VERSION } from "../cli/project-version.js";
import { DEFAULT_NAMESPACE_SOURCE } from "../types.js";
import { MemoryServiceError } from "../utils/error.js";
import { newId, stableHash, stableStringify } from "../utils/id.js";
import {
  isMemmyRecallToolName,
  memmyRecallToolPlaceholder,
  sanitizeMemmyProtocolText,
  sanitizeMemmyProtocolValue,
} from "../utils/memmy-context-tags.js";
import { nowIso } from "../utils/time.js";
import type { MemoryDb } from "../storage/db.js";
import { attachMemoryVector } from "../storage/memory-vector-state.js";
import type { SerializedMemoryVector } from "../storage/sqlite-vec-store.js";
import {
  sqliteBackendCapabilities,
  type StorageBackend,
  type StorageBackendCapabilities
} from "../storage/backend.js";
import {
  DEFAULT_MEMMY_CONFIG,
  loadMemmyConfig,
  MEMORY_SUMMARY_MAX_TOKENS,
  resolveEvolutionConfig,
  type MemmyConfig
} from "../config/index.js";
import { createEmbedder } from "../model/embedder.js";
import { createLlmClient } from "../model/llm.js";
import type { Embedder, LlmClient } from "../model/types.js";
import { createMemoryLogger, memoryErrorFields } from "../logging/logger.js";
import {
  type EpisodeRecord,
  type ApiLogRecord,
  type EmbeddingRetryRecord,
  type EmbeddingRetryStatus,
  type EmbeddingRetryTargetKind,
  type EmbeddingRetryVectorField,
  type EvolutionJobRecord,
  type MemorySearchIdHit,
  type RawTurnRecord,
  type SessionRecord,
  type ChangeLogRecord,
  type FeedbackRecord,
  type RecallEventRecord,
  type SkillTrialRecord,
  type TracePolicyLinkRecord,
  Repositories,
  jobToRef,
  kindFromMemory,
  titleFromValue
} from "../storage/repositories.js";
import {
  backpropagateTraces,
  buildPluginRetrievalQuery,
  buildPolicyDraft,
  buildSkillDraft,
  buildWorldModelDraft,
  classifyFeedbackText,
  classifyTurnFeedback,
  classifyIntent,
  classifyTurnRelation,
  classifyTurnRelationWithLlm,
  compileRetrievalQuery,
  combineRewardAxes,
  cosine,
  captureTurnSteps,
  BATCH_REFLECTION_PROMPT,
  DECISION_REPAIR_PROMPT,
  detectDominantLanguage,
  displayReflectionText,
  extractToolNamesFromTraces,
  focusResearchRetrievalQuery,
  hasMemoryRetrievalIndex,
  heuristicHumanScore,
  isMemoryReadyForRetrieval,
  isResearchDomain,
  isRepositoryRepairPrompt,
  isStandaloneMathFinalAnswerTask,
  L3_ABSTRACTION_PROMPT,
  languageSteeringLine,
  L2_INDUCTION_PROMPT,
  l2CandidateIdFor,
  packL2InductionTraces,
  policyMetaFromMemory,
  REFLECTION_SCORE_PROMPT,
  REWARD_R_HUMAN_PROMPT,
  policyStatusAfterGain,
  retrievePluginMemories,
  RETRIEVAL_QUERY_EXTRACT_PROMPT,
  RETRIEVAL_FILTER_PROMPT,
  retrievalForIntent,
  retrievalLayersForMode,
  retrievalLayersForProfile,
  renderRepositoryRepairProtocol,
  renderMathFinalAnswerProtocol,
  SKILL_CRYSTALLIZE_PROMPT,
  SKILL_REBUILD_PROMPT,
  STANDALONE_MATH_FINAL_ANSWER_TASK_KIND,
  shapeWorldModelConfidence,
  tracePolicySimilarity,
  signatureFromTrace,
  signatureFromTraceParts,
  skillEtaAfterRewardDrift,
  skillEtaAfterTrial,
  skillMetaFromMemory,
  skillStatusAfterRewardDrift,
  skillStatusAfterTrial,
  traceMetaFromMemory,
  verifySkillDraft,
  worldModelMetaFromMemory
} from "../algorithm/plugin-algorithms.js";
import type {
  CompiledRetrievalQuery,
  FeedbackTextClassification,
  FeedbackTextShape,
  RetrievalQueryExtract,
  RetrievalResult,
  SeededChannelScores
} from "../algorithm/plugin-algorithms.js";
import type { TurnFeedbackClassification } from "../algorithm/plugin-algorithms.js";

const workerLogger = createMemoryLogger("worker");
const evolutionLogger = createMemoryLogger("evolution");
const pipelineLogger = createMemoryLogger("pipeline");
const serviceLogger = createMemoryLogger("memory-service");

const RETRIEVAL_QUERY_EXTRACT_TIMEOUT_MS = 60_000;
const RETRIEVAL_FILTER_TIMEOUT_MS = 30_000;
const QUERY_REWRITE_TIMEOUT_MS = 30_000;
const QUERY_REWRITE_MAX_RETRIES = 1;
const QUERY_VECTOR_TIMEOUT_MS = 3_000;
const QUERY_REWRITE_COUNT = 3;
const QUERY_REWRITE_RRF_CONSTANT = 8;
const QUERY_REWRITE_PER_QUERY_MIN_KEEP = 3;
const EPISODE_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

const BATCH_REFLECTION_OPERATION = `capture.${BATCH_REFLECTION_PROMPT.id}.v${BATCH_REFLECTION_PROMPT.version}`;

const QUERY_REWRITE_SYSTEM_PROMPT = `You rewrite a user's memory search request into exactly 3 complementary retrieval queries.

Goal:
- Maximize recall from a personal memory store while staying faithful to the user's request.
- Preserve concrete entities, people, dates, places, relationship words, numbers, and domain keywords.
- Keep useful aliases or likely paraphrases when they help retrieval.
- Retrieve distinct evidence needed for multi-fact, temporal, comparison, counting, and inference questions.

Rules:
1. Produce 3 short standalone retrieval queries.
2. Do not answer the question.
3. Do not add facts that are not grounded in the original request.
4. Keep the original language when it carries names or exact wording; use bilingual paraphrases only when the request itself mixes languages.
5. Query 1 must preserve the original request and its concrete anchors.
6. Query 2 must target the main entity, event, relationship, or time expression with useful aliases.
7. Query 3 must target one complementary evidence facet needed to resolve the request. For indirect questions, retrieve stated preferences, plans, goals, prior events, or constraints instead of guessing the conclusion. For references such as "that book" or "it", target the earlier source fact alone and intentionally omit downstream entities that may not occur in the source memory.
8. Keep each query to one evidence facet and roughly 2-12 content words. Do not join stages with "and", "follow-up", parentheses, or lists of synonyms.
9. Do not produce three near-duplicate paraphrases.

Return JSON only:
{
  "queries": ["query 1", "query 2", "query 3"]
}`;

function evolutionUsesSharedLlm(config: MemmyConfig): boolean {
  const evolution = config.evolution;
  return !evolution.provider && !evolution.model && !evolution.endpoint && !evolution.apiKey;
}

export interface MemoryServiceOptions {
  db?: MemoryDb;
  backend?: StorageBackend;
  mode?: "local" | "cloud" | "dev";
  configPath?: string;
  configLoader?: (configPath?: string) => {
    config: MemmyConfig;
    path?: string;
  };
  config?: MemmyConfig;
  llm?: LlmClient;
  skillLlm?: LlmClient;
  embedder?: Embedder;
}

export interface CompleteTurnResponse {
  turnId: string;
  sessionId: string;
  episodeId: string;
  rawTurnId: string;
  l1MemoryId: string;
  l1MemoryIds: string[];
  closedEpisodeIds: string[];
  scheduledEvolution: boolean;
  jobs: JobRef[];
  changeSeq: number;
  syncCursor: string;
  etag: string;
  serverTime: string;
  duplicate?: boolean;
}

export interface FeedbackResponse {
  id: string;
  ts: string;
  channel: FeedbackRequest["channel"];
  polarity: FeedbackRequest["polarity"];
  magnitude: number;
  scheduledEvolution: boolean;
  changeSeq: number;
  syncCursor: string;
  feedbackId: string;
  recallEventId?: string;
  recallOutcome?: NonNullable<RecallEventRecord["outcome"]>;
  repair?: {
    repairId?: string;
    contextHash?: string;
    skipped?: boolean;
    reason?: string;
    attachedPolicyIds?: string[];
  };
  jobs: JobRef[];
  serverTime: string;
  duplicate?: boolean;
}

type PolicyDraft = ReturnType<typeof buildPolicyDraft>;
type PolicyEnhancementResult =
  | { ok: true; draft: PolicyDraft }
  | { ok: false; reason: string };
type WorldModelDraft = ReturnType<typeof buildWorldModelDraft>[number];
type WorldModelEnhancementResult =
  | { ok: true; draft: WorldModelDraft }
  | { ok: false; fallback: WorldModelDraft; reason: string };
type SkillDraft = NonNullable<ReturnType<typeof buildSkillDraft>>;
type SkillEnhancementResult =
  | { ok: true; draft: SkillDraft }
  | { ok: false; reason: string };
type TraceMeta = NonNullable<ReturnType<typeof traceMetaFromMemory>>;
const IMPORT_SUMMARY_QUEUED_TAG = "摘要排队中";
const IMPORT_SUMMARY_PROCESSING_TAG = "摘要总结中";
const IMPORT_INDEXING_TAG = "索引建立中";
const IMPORT_FAILED_TAG = "处理失败";
const IMPORT_STATUS_TAGS = [
  IMPORT_SUMMARY_QUEUED_TAG,
  "摘要整理中",
  IMPORT_SUMMARY_PROCESSING_TAG,
  "建立索引中",
  IMPORT_INDEXING_TAG,
  "索引已建立",
  IMPORT_FAILED_TAG
];
const IMPORT_DEFAULT_ALPHA = 0;
const IMPORT_DEFAULT_VALUE = 0;
const IMPORT_DEFAULT_PRIORITY = 0.5;
const IMPORT_TOOL_PAYLOAD_MAX_CHARS = 20_000;
const SUMMARY_WORKER_CONCURRENCY = 4;
type PolicyMeta = NonNullable<ReturnType<typeof policyMetaFromMemory>>;
type WorldModelMeta = NonNullable<ReturnType<typeof worldModelMetaFromMemory>>;
type HumanScoreResult = ReturnType<typeof heuristicHumanScore>;

interface WorkerJobRunResult {
  succeeded: number;
  failed: number;
  ref: JobRef;
}
interface PreparedEmbeddingJob {
  job: EvolutionJobRecord;
  memory: MemoryRow;
  text: string;
  role: "document" | "query";
  vectorField: EmbeddingRetryVectorField;
}

interface DecisionRepairTraceSource {
  memory: MemoryRow;
  rawTurn?: RawTurnRecord;
}

interface ToolFailureRecord {
  toolId: string;
  context: string;
  step: number;
  reason: string;
  ts: number;
  rawTurnId?: string;
  sessionId?: string;
  episodeId?: string;
}

interface ToolFailureState {
  toolId: string;
  context: string;
  firstSeen: number;
  lastSeen: number;
  windowStart: number;
  occurrences: ToolFailureRecord[];
}

interface ToolFailureBurst extends ToolFailureState {
  contextHash: string;
  failureCount: number;
}

interface DecisionRepairSummary {
  repairId?: string;
  contextHash?: string;
  skipped?: boolean;
  reason?: string;
  attachedPolicyIds?: string[];
}

type InternalMemorySearchRequest = MemorySearchRequest & {
  episodeId?: string;
  turnId?: string;
  tags?: string[];
  limit?: number;
  contextBudget?: number;
  includeInjectedContext?: boolean;
  retrievalMode?: RetrievalMode;
  targetSkillId?: string;
  contextHints?: Record<string, unknown>;
  injectedContextQuery?: string;
};

type MemoryDetailResponse = MemoryDetailItem & {
  item: MemoryDetailItem;
  refs: Record<string, unknown>;
  version: number;
  etag: string;
};

interface EpisodeTimelineDetail {
  sessionId?: string;
  episodeId?: string;
  traces: MemoryListItem[];
  rawTurns?: RawTurnSummary[];
  items: MemoryListItem[];
  nextCursor?: string;
  serverTime: string;
}

interface EpisodeDetailItem {
  id: string;
  kind: "episode";
  memoryLayer: "Episode";
  status: EpisodeRecord["status"];
  title: string;
  summary: string;
  tags: string[];
  updatedAt: string;
  version: number;
  body: string;
  createdAt: string;
  sourceMemoryIds: string[];
  metadata: Record<string, unknown>;
  timeline: EpisodeTimelineDetail;
}

type MemoryGetResponse = MemoryDetailResponse | (EpisodeDetailItem & {
  item: EpisodeDetailItem;
  refs: Record<string, unknown>;
  etag: string;
});

interface DecisionRepairLlmDraft {
  preference: string;
  antiPattern: string;
  severity: "info" | "warn";
  confidence: number;
}

interface FeedbackAttribution {
  l1MemoryId?: string;
  rawTurnId?: string;
  episodeId?: string;
  sessionId?: string;
}

type FeedbackExperienceType =
  | "success_pattern"
  | "repair_validated"
  | "failure_avoidance"
  | "repair_instruction"
  | "preference"
  | "verifier_feedback";

type FeedbackEvidencePolarity = "positive" | "negative" | "mixed" | "neutral";

interface FeedbackExperienceDraft {
  type: FeedbackExperienceType;
  polarity: FeedbackEvidencePolarity;
  title: string;
  trigger: string;
  procedure: string;
  verification: string;
  boundary: string;
  decisionGuidance: {
    preference: string[];
    antiPattern: string[];
  };
  salience: number;
  confidence: number;
  skillEligible: boolean;
  verifierMeta: Record<string, unknown> | null;
  sourceEpisodeIds: string[];
  sourceTraceIds: string[];
  sourceFeedbackIds: string[];
  vectorText: string;
  tags: string[];
}

interface EmbeddingRetryRunSummary {
  leased: number;
  succeeded: number;
  failed: number;
  items: Array<{
    id: string;
    status: EmbeddingRetryRecord["status"];
    targetKind: EmbeddingRetryTargetKind;
    targetMemoryId: string;
    vectorField: EmbeddingRetryVectorField;
    attempts: number;
    lastError?: string | null;
  }>;
}

const EMBEDDING_RETRY_BASE_BACKOFF_MS = 60_000;
const EMBEDDING_RETRY_MAX_BACKOFF_MS = 60 * 60_000;
const EMBEDDING_RETRY_LEASE_MS = 5 * 60_000;
const PANEL_ITEMS_PAGE_SIZE = 20;
const PANEL_DAILY_ACTIVITY_DAYS = 371;

function requireMemoryDb(options: MemoryServiceOptions): MemoryDb {
  if (!options.db) {
    throw new Error("MemoryService requires either db or backend");
  }
  return options.db;
}

export class MemoryService {
  private readonly repos: Repositories;
  private readonly startedAt = Date.now();
  private readonly mode: "local" | "cloud" | "dev";
  private config: MemmyConfig;
  private llm: LlmClient;
  private skillLlm: LlmClient;
  private embedder: Embedder;
  private readonly embeddingRetryWorkerId = `embedding-retry-${newId("worker")}`;
  private readonly toolFailureStates = new Map<string, ToolFailureState>();
  private readonly toolSuccessSteps = new Map<string, number>();
  private readonly toolStepCounters = new Map<string, number>();
  private readonly skillCrystallizationRuns = new Map<string, number>();

  constructor(private readonly options: MemoryServiceOptions) {
    this.repos = options.backend?.repositories() ?? new Repositories(requireMemoryDb(options).db);
    this.mode = options.mode ?? "local";
    this.config = cloneMemmyConfig(options.config ?? DEFAULT_MEMMY_CONFIG);
    this.llm = options.llm ?? createLlmClient(this.config.summary, { modelRole: "memory_summary" });
    this.skillLlm = options.skillLlm ??
      (options.llm && evolutionUsesSharedLlm(this.config)
        ? options.llm
        : createLlmClient(resolveEvolutionConfig(this.config), { modelRole: "memory_evolution" }));
    this.embedder = options.embedder ?? createEmbedder(this.config.embedding);
    serviceLogger.info("initialized", memoryConfigLogFields(this.config));
  }

  private memoryAddEnabled(): boolean {
    return this.config.algorithm.enableMemoryAdd;
  }

  private memorySearchEnabled(): boolean {
    return this.config.algorithm.enableMemorySearch;
  }

  private queryRewriteEnabled(): boolean {
    return this.config.algorithm.enableQueryRewrite;
  }

  private turnStartRetrievalLimit(): number {
    const retrieval = this.config.algorithm.retrieval;
    return Math.max(1, retrieval.tier1TopK + retrieval.tier2TopK + retrieval.tier3TopK);
  }

  health(routes: string[] = []): HealthResponse {
    const schema = this.schemaVersion();
    const backend = this.storageCapabilities();
    return {
      ok: true,
      version: PROJECT_VERSION,
      uptimeMs: Date.now() - this.startedAt,
      mode: this.mode,
      activeProfile: this.config.activeProfile,
      storage: {
        ...backend,
        schemaVersion: String(schema.version),
        ready: schema.version > 0,
        lastMigrationId: schema.lastMigrationId
      },
      models: {
        summary: this.llm.status(),
        evolution: this.skillLlm.status(),
        embedding: this.embedder.status()
      },
      capabilities: {
        routes,
        tools: [
          "session.open",
          "session.close",
          "turn.start",
          "turn.complete",
          ...(this.memorySearchEnabled() ? ["memory.search"] : []),
          ...(this.memoryAddEnabled() ? ["memory.add"] : []),
          ...(this.memorySearchEnabled() ? ["memory.get"] : []),
          ...(this.memoryAddEnabled() ? ["memory.delete"] : []),
          "panel.overview",
          "panel.analysis",
          "panel.items"
        ],
        memoryLayers: ["L1", "L2", "L3", "Skill"],
        supportsCli: true
      },
      serverTime: nowIso()
    };
  }

  reloadConfig(request: MemoryReloadConfigRequest = {}): MemoryReloadConfigResponse {
    const previousConfig = this.config;
    const loader = this.options.configLoader ?? loadMemmyConfig;
    const nextConfig = cloneMemmyConfig(loader(this.options.configPath).config);
    const changed = stableStringify(previousConfig) !== stableStringify(nextConfig);
    const requiresRestart = stableStringify(previousConfig.storage) !== stableStringify(nextConfig.storage);
    const reloadedAt = nowIso();

    this.config = nextConfig;
    this.llm = createLlmClient(nextConfig.summary, { modelRole: "memory_summary" });
    this.skillLlm = createLlmClient(resolveEvolutionConfig(nextConfig), { modelRole: "memory_evolution" });
    this.embedder = createEmbedder(nextConfig.embedding);
    if (!requiresRestart && request.restartFailedProcessing !== false) {
      this.restartFailedProcessing(reloadedAt);
    }
    serviceLogger.info("config.reloaded", {
      changed,
      requiresRestart,
      restartFailedProcessing: !requiresRestart && request.restartFailedProcessing !== false,
      ...memoryConfigLogFields(this.config)
    });

    return {
      activeProfile: this.config.activeProfile,
      changed,
      requiresRestart,
      models: {
        summary: this.llm.status(),
        evolution: this.skillLlm.status(),
        embedding: this.embedder.status()
      },
      reloadedAt
    };
  }

  private storageCapabilities(): StorageBackendCapabilities {
    return this.options.backend?.capabilities() ?? sqliteBackendCapabilities(requireMemoryDb(this.options));
  }

  private schemaVersion(): { version: number; lastMigrationId?: string } {
    if (this.options.db) {
      return this.options.db.schemaVersion();
    }
    const capabilities = this.storageCapabilities();
    const version = Number(capabilities.schemaVersion);
    return {
      version: Number.isFinite(version) ? version : 0
    };
  }

  async idempotent<T>(
    operation: string,
    request: RequestEnvelope,
    fingerprint: unknown,
    run: () => T | Promise<T>
  ): Promise<T> {
    if (!this.memoryAddEnabled()) {
      return run();
    }
    const idempotencyKey = request.adapterId && request.requestId
      ? `${operation}:${request.adapterId}:${request.requestId}`
      : undefined;
    if (!idempotencyKey) {
      return run();
    }
    const requestHash = stableHash({ operation, fingerprint });
    const existing = this.repos.runtime.getIdempotency(idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new MemoryServiceError("conflict", "idempotency key reused with different request body");
      }
      return withDuplicateFlag(existing.response) as T;
    }
    const response = await run();
    this.repos.runtime.saveIdempotency(idempotencyKey, requestHash, response);
    return response;
  }

  adapterActivate(request: RequestEnvelope & {
    capabilities?: {
      lifecycle?: boolean;
      tools?: boolean;
      observations?: boolean;
      panel?: boolean;
    };
  } = {}): {
    adapterId: string;
    serviceVersion: string;
    acceptedCapabilities: {
      lifecycle: boolean;
      tools: boolean;
      observations: boolean;
      panel: boolean;
    };
    effectiveNamespace: {
      userId: string;
      projectId?: string;
      workspaceId?: string;
      profileId?: string;
    };
    expiresAt?: string;
    serverTime: string;
  } {
    const namespace = normalizeNamespace(request.namespace);
    return {
      adapterId: request.adapterId ?? "anonymous",
      serviceVersion: PROJECT_VERSION,
      acceptedCapabilities: {
        lifecycle: request.capabilities?.lifecycle ?? true,
        tools: request.capabilities?.tools ?? true,
        observations: request.capabilities?.observations ?? true,
        panel: request.capabilities?.panel ?? true
      },
      effectiveNamespace: {
        userId: namespace.userId,
        projectId: namespace.projectId ?? namespace.workspaceId,
        workspaceId: namespace.workspaceId,
        profileId: namespace.profileId
      },
      serverTime: nowIso()
    };
  }

  openSession(request: SessionOpenRequest): {
    sessionId: string;
    userId: string;
    source: string;
    profileId: string;
    projectId?: string;
    workspaceId?: string;
    conversationId?: string;
    status: "open";
    resumed: boolean;
    changeSeq?: number;
    syncCursor?: string;
    duplicate?: boolean;
    openedAt: string;
    serverTime: string;
  } {
    if (!this.memoryAddEnabled()) {
      return this.openSessionNoWrite(request);
    }
    const idempotencyKey = request.adapterId && request.requestId
      ? `session.open:${request.adapterId}:${request.requestId}`
      : undefined;
    const requestHash = stableHash({ operation: "session.open", request });
    if (idempotencyKey) {
      const existing = this.repos.runtime.getIdempotency(idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new MemoryServiceError("conflict", "idempotency key reused with different session.open request body");
        }
        return withDuplicateFlag(existing.response) as ReturnType<MemoryService["openSession"]>;
      }
    }
    const namespace = normalizeNamespace(request.namespace);
    const at = nowIso();
    if (request.sessionId) {
      const existingSession = this.repos.runtime.getSession(request.sessionId);
      if (existingSession) {
        this.assertSessionInScope(existingSession, request.namespace);
        if (existingSession.status !== "open") {
          throw new MemoryServiceError("conflict", `session is not open: ${request.sessionId}`);
        }
        const refreshed = this.repos.runtime.updateSessionScope(
          existingSession.id,
          sessionScopeForOpenRequest(request, namespace),
          at
        ) ?? existingSession;
        const body = {
          sessionId: refreshed.id,
          userId: refreshed.userId,
          source: refreshed.source,
          profileId: refreshed.profileId,
          projectId: refreshed.projectId,
          workspaceId: refreshed.workspaceId,
          conversationId: refreshed.conversationId,
          status: "open" as const,
          resumed: true,
          openedAt: refreshed.openedAt,
          serverTime: nowIso()
        };
        if (idempotencyKey) {
          this.repos.runtime.saveIdempotency(idempotencyKey, requestHash, body, at);
        }
        return body;
      }
    }
    const hostSessionKey = namespace.sessionKey;
    if (hostSessionKey) {
      const existingSession = this.repos.runtime.findOpenSessionByHostKey({
        userId: namespace.userId,
        source: request.source ?? namespace.source,
        profileId: request.profileId ?? namespace.profileId,
        hostSessionKey
      });
      if (existingSession) {
        this.assertSessionInScope(existingSession, request.namespace);
        const touched = this.repos.runtime.updateSessionScope(
          existingSession.id,
          sessionScopeForOpenRequest(request, namespace),
          at
        ) ?? existingSession;
        const body = {
          sessionId: touched.id,
          userId: touched.userId,
          source: touched.source,
          profileId: touched.profileId,
          projectId: touched.projectId,
          workspaceId: touched.workspaceId,
          conversationId: touched.conversationId,
          status: "open" as const,
          resumed: true,
          openedAt: touched.openedAt,
          serverTime: nowIso()
        };
        if (idempotencyKey) {
          this.repos.runtime.saveIdempotency(idempotencyKey, requestHash, body, at);
        }
        return body;
      }
    }
    const session: SessionRecord = {
      id: request.sessionId ?? newId("session"),
      userId: namespace.userId,
      source: request.source ?? namespace.source,
      profileId: request.profileId ?? namespace.profileId,
      profileLabel: namespace.profileLabel,
      projectId: request.projectId ?? namespace.projectId ?? namespace.workspaceId,
      workspaceId: request.workspaceId ?? namespace.workspaceId,
      workspacePath: request.workspacePath ?? namespace.workspacePath,
      hostSessionKey,
      conversationId: stringFromMeta(request.meta, "conversationId"),
      status: "open" as const,
      meta: request.meta ?? {},
      openedAt: at,
      lastSeenAt: at,
      updatedAt: at
    };

    this.repos.runtime.createSession(session);
    const changeSeq = this.repos.runtime.appendChange({
      memoryId: session.id,
      namespaceId: namespaceIdFromContext(namespace),
      kind: "session",
      op: "created",
      entityId: session.id,
      userId: session.userId,
      changeType: "session_opened",
      after: session,
      source: "session.open",
      createdAt: at
    });
    const body = {
      sessionId: session.id,
      userId: session.userId,
      source: session.source,
      profileId: session.profileId,
      projectId: session.projectId,
      workspaceId: session.workspaceId,
      conversationId: session.conversationId,
      status: "open" as const,
      resumed: false,
      changeSeq,
      syncCursor: this.encodeChangeCursor(changeSeq, namespace),
      openedAt: at,
      serverTime: nowIso()
    };
    if (idempotencyKey) {
      this.repos.runtime.saveIdempotency(idempotencyKey, requestHash, body, at);
    }
    return body;
  }

  closeSession(sessionId: string, request: RequestEnvelope = {}): {
    ok: true;
    sessionId: string;
    status: "closed";
    closedEpisodeIds: string[];
    changeSeq: number;
    syncCursor: string;
    closedAt: string;
    serverTime: string;
  } {
    if (!this.memoryAddEnabled()) {
      return this.closeSessionNoWrite(sessionId, request);
    }
    const existing = this.repos.runtime.getSession(sessionId);
    if (!existing) {
      throw new MemoryServiceError("not_found", `session not found: ${sessionId}`);
    }
    this.assertSessionInScope(existing, request.namespace);
    const at = nowIso();
    const closedEpisodes = this.repos.runtime.closeOpenEpisodesForSession(sessionId, at);
    const session = this.repos.runtime.closeSession(sessionId, at);
    if (!session) {
      throw new MemoryServiceError("not_found", `session not found: ${sessionId}`);
    }
    for (const episode of closedEpisodes) {
      this.repos.runtime.appendChange({
        memoryId: episode.id,
        namespaceId: namespaceIdFromSession(session),
        kind: "episode",
        op: "updated",
        entityId: episode.id,
        userId: episode.userId,
        changeType: "episode_closed",
        after: episode,
        source: "session.close",
        createdAt: at
      });
      this.finalizeClosedEpisode(episode, at, "session_closed");
    }
    const changeSeq = this.repos.runtime.appendChange({
      memoryId: sessionId,
      namespaceId: namespaceIdFromSession(session),
      kind: "session",
      op: "updated",
      entityId: sessionId,
      userId: session.userId,
      changeType: "session_closed",
      before: existing,
      after: session,
      source: "session.close",
      createdAt: at
    });
    return {
      ok: true,
      sessionId,
      status: "closed",
      closedEpisodeIds: closedEpisodes.map((episode) => episode.id),
      changeSeq,
      syncCursor: this.encodeChangeCursor(changeSeq, namespaceForSession(session)),
      closedAt: session.closedAt ?? nowIso(),
      serverTime: nowIso()
    };
  }

  compactSession(sessionId: string, request: SessionCompactRequest = {}): {
    memorySnapshot: {
      summary: string;
      sourceTurnIds: string[];
      sourceMemoryIds: string[];
      tokenEstimate?: number;
    };
    contextPacketId: string;
    rawTurnId?: string;
    l1MemoryId?: string;
    changeSeq?: number;
    syncCursor?: string;
    jobs: JobRef[];
    serverTime: string;
  } {
    this.assertMemoryAddEnabled();
    const session = this.requireSession(sessionId);
    this.assertSessionInScope(session, request.namespace);
    const episode = this.ensureEpisode(session, request.episodeId);
    const at = nowIso();
    const sourceMemoryIds = request.sourceMemoryIds?.length
      ? request.sourceMemoryIds
      : episode.l1MemoryIds.slice(-12);
    const sourceMemories = this.repos.memories.getMany(sourceMemoryIds);
    const sourceTurnIds = request.sourceTurnIds?.length
      ? request.sourceTurnIds
      : sourceMemories
          .map((memory) => stringFromMaybeRecord(memory.info, "turn_id"))
          .filter((value): value is string => Boolean(value));
    const summary = request.summary?.trim() ||
      sourceMemories.map((memory) => firstLine(memory.memoryValue)).filter(Boolean).slice(0, 8).join("\n") ||
      `Compact snapshot for session ${sessionId}`;
    const rawTurnId = newId("raw");
    const contextPacketId = `ctx_${stableHash(`${sessionId}:${episode.id}:${summary}:${rawTurnId}`).slice(0, 20)}`;
    const turnId = `compact:${contextPacketId}`;
    const rawTurn = this.repos.runtime.insertRawTurn({
      id: rawTurnId,
      sessionId: session.id,
      episodeId: episode.id,
      turnId,
      userId: session.userId,
      conversationId: session.conversationId,
      assistantText: summary,
      toolCalls: [],
      toolResults: [],
      sourceMemoryIds,
      usage: {},
      messagePayload: {
        compact: {
          contextPacketId,
          sourceTurnIds,
          sourceMemoryIds,
          tokenEstimate: request.tokenEstimate
        }
      },
      status: "succeeded",
      createdAt: at
    });
    this.repos.runtime.appendEpisodeRawTurn(episode.id, rawTurn.id, at);
    this.repos.runtime.appendChange({
      memoryId: rawTurn.id,
      namespaceId: namespaceIdFromSession(session),
      kind: "raw_turn",
      op: "created",
      entityId: rawTurn.id,
      userId: session.userId,
      changeType: "raw_turn_created",
      after: rawTurn,
      source: "session.compact",
      createdAt: at
    });

    let l1MemoryId: string | undefined;
    const jobs: EvolutionJobRecord[] = [];
    if (request.createL1 !== false) {
      const l1 = this.buildMemory({
        id: `trace_${stableHash(`compact:L1:${rawTurn.id}`).slice(0, 20)}`,
        userId: session.userId,
        conversationId: session.conversationId,
        sessionId: session.id,
        agentId: session.source,
        appId: session.workspaceId,
        projectId: session.projectId,
        profileId: session.profileId,
        layer: "L1",
        kind: "trace",
        memoryType: "LongTermMemory",
        key: `trace:${session.id}:${turnId}:compact`,
        value: [
          `Summary: ${summary}`,
          `RawTurn: ${rawTurn.id}`,
          "TraceStep: compact",
          "Alpha: 0.5",
          "Value: 0",
          "Priority: 0.5"
        ].join("\n"),
        tags: ["trace", "compact", "summary"],
        info: {
          turn_id: turnId,
          raw_turn_id: rawTurn.id,
          episode_id: episode.id,
          summary,
          source_memory_ids: sourceMemoryIds
        },
        internal: {
          source: "session.compact",
          plugin_algorithm: "capture.compact.v1",
          source_raw_turn_id: rawTurn.id,
          source_memory_ids: sourceMemoryIds,
          summary,
          reflection: null,
          alpha: 0.5,
          value: 0,
          priority: 0.5,
          raw_turn_id: rawTurn.id,
          raw_span: { compact: true },
          error_signatures: [],
          trace: {
            key: `${episode.id}:${Date.parse(at)}:compact`,
            ts: Date.parse(at),
            turn_id: turnId,
            raw_turn_id: rawTurn.id,
            raw_span: { compact: true },
            episode_id: episode.id,
            step_index: 0,
            sub_step_total: 1,
            tool_calls: [],
            reflection: null,
            alpha: 0.5,
            usable: true,
            reflection_source: "synth",
            summary,
            tags: ["compact", "summary"],
            value: 0,
            priority: 0.5,
            signature: "compact|summary|_|_",
            error_signatures: []
          }
        },
        createdAt: at
      });
      const upsert = this.repos.memories.upsertByKey(l1);
      l1MemoryId = upsert.memory.id;
      this.repos.runtime.appendChange({
        memoryId: upsert.memory.id,
        namespaceId: namespaceIdFromMemory(upsert.memory),
        kind: "trace",
        op: upsert.created ? "created" : "updated",
        entityId: upsert.memory.id,
        userId: session.userId,
        changeType: upsert.created ? "create" : "update",
        before: upsert.previous,
        after: upsert.memory,
        source: "session.compact",
        createdAt: at
      });
      this.repos.runtime.appendEpisodeTurn(episode.id, rawTurn.id, upsert.memory.id, at);
      jobs.push(this.enqueueJob({
        jobType: "embedding",
        userId: session.userId,
        sessionId: session.id,
        episodeId: episode.id,
        targetMemoryId: upsert.memory.id,
        payload: { reason: "compact.snapshot" },
        createdAt: at
      }));
    }
    jobs.push(this.enqueueJob({
      jobType: "l3_abstraction",
      userId: session.userId,
      sessionId,
      episodeId: episode.id,
      payload: {
        reason: "manual_compaction",
        targetKind: "policy_cluster",
        sourceMemoryId: l1MemoryId,
        episodeId: episode.id,
        rawTurnId: rawTurn.id
      },
      createdAt: at
    }));
    this.repos.runtime.insertAudit({
      userId: session.userId,
      sessionId: session.id,
      actor: request.namespace ? { ...request.namespace } : {},
      action: "compact",
      targetKind: "session",
      targetId: session.id,
      meta: { rawTurnId: rawTurn.id, l1MemoryId, contextPacketId },
      createdAt: at
    });
    const changeSeq = this.repos.runtime.latestChangeSeq(session.userId, namespaceIdFromSession(session));
    return {
      memorySnapshot: {
        summary,
        sourceTurnIds,
        sourceMemoryIds,
        tokenEstimate: request.tokenEstimate
      },
      contextPacketId,
      rawTurnId: rawTurn.id,
      l1MemoryId,
      changeSeq,
      syncCursor: changeSeq === undefined ? undefined : this.encodeChangeCursor(changeSeq, namespaceForSession(session)),
      jobs: jobs.map(jobToRef),
      serverTime: nowIso()
    };
  }

  async startTurn(request: TurnStartRequest & Record<string, unknown>): Promise<{
    contextPacketId: string;
    turnId: string;
    sessionId: string;
    episodeId: string;
    closedEpisodeIds: string[];
    searchEventId: string;
    hits: RecallHit[];
    injectedContext: InjectedContext;
    sourceMemoryIds: string[];
    droppedDueToBudget: Array<{
      id: string;
      kind: MemoryKind;
      memoryLayer: MemoryLayer;
      reason: "token_budget";
      tokenEstimate?: number;
    }>;
    status: string[];
    serverTime: string;
  }> {
    request = sanitizeTurnStartRequest(request);
    if (!this.memoryAddEnabled()) {
      return this.startTurnNoWrite(request);
    }
    const session = this.requireOpenSession(request.sessionId);
    this.assertSessionInScope(session, request.namespace);
    const turnId = request.turnId ?? newId("turn");
    const existingRawTurn = this.repos.runtime.getRawTurnBySessionTurn(session.id, turnId);
    if (existingRawTurn) {
      this.assertRawTurnInScope(existingRawTurn, request.namespace);
    }
    const latestEpisodeBefore = existingRawTurn
      ? undefined
      : this.repos.runtime.latestEpisodeForSession(session.id);
    const episode = existingRawTurn
      ? this.requireEpisode(existingRawTurn.episodeId)
      : await this.ensureEpisodeForTurnWithLlm(session, undefined, request.query, "turn.start");
    const closedEpisodeIds = closedEpisodeIdsFromBoundary(
      latestEpisodeBefore,
      episode,
      latestEpisodeBefore ? this.repos.runtime.getEpisode(latestEpisodeBefore.id) : undefined
    );
    const intentDecision = episode.rawTurnIds.length === 0
      ? classifyIntent(request.query)
      : undefined;
    if (intentDecision) {
      this.repos.runtime.updateEpisodeMeta(episode.id, {
        intentDecision
      });
    }
    const contextHints = turnStartContextHints(request);
    const search = await this.search({
      requestId: request.requestId,
      adapterId: request.adapterId,
      namespace: namespaceForSession(session),
      sessionId: session.id,
      episodeId: episode.id,
      turnId,
      query: buildSearchQuery({ ...request, contextHints }, this.config.domain),
      layers: intentDecision ? memoryLayersForIntent(intentDecision.kind) : ["Skill", "L2", "L1", "L3"],
      limit: this.turnStartRetrievalLimit(),
      contextBudget: typeof request.contextBudget === "number" ? request.contextBudget : undefined,
      includeInjectedContext: true,
      retrievalMode: "turn_start",
      contextHints,
      injectedContextQuery: request.query
    });
    const contextPacketId = `ctx_${stableHash(`${session.id}:${episode.id}:${turnId}:${search.searchEventId}`).slice(0, 20)}`;
    if (!existingRawTurn) {
      const at = nowIso();
      this.repos.runtime.touchSession(session.id, at);
      const rawTurn = this.repos.runtime.insertRawTurn({
        id: rawTurnIdForSessionTurn(session.id, turnId),
        sessionId: session.id,
        episodeId: episode.id,
        turnId,
        userId: session.userId,
        conversationId: session.conversationId,
        userText: request.query,
        toolCalls: [],
        toolResults: [],
        sourceMemoryIds: search.sourceMemoryIds,
        usage: {},
        messagePayload: {
          turn_start: {
            contextPacketId,
            searchEventId: search.searchEventId
          }
        },
        status: "started",
        createdAt: at
      });
      this.repos.runtime.appendEpisodeRawTurn(episode.id, rawTurn.id, at);
      this.repos.runtime.appendChange({
        memoryId: rawTurn.id,
        namespaceId: namespaceIdFromSession(session),
        kind: "raw_turn",
        op: "created",
        entityId: rawTurn.id,
        userId: session.userId,
        changeType: "raw_turn_created",
        after: rawTurn,
        source: "turn.start",
        createdAt: at
      });
    }

    return {
      contextPacketId,
      turnId,
      sessionId: session.id,
      episodeId: episode.id,
      closedEpisodeIds,
      searchEventId: search.searchEventId,
      hits: search.hits,
      injectedContext: search.injectedContext,
      sourceMemoryIds: search.sourceMemoryIds,
      droppedDueToBudget: search.droppedDueToBudget,
      status: [
        ...search.status,
        ...(intentDecision && (intentDecision.kind === "chitchat" || intentDecision.kind === "meta")
          ? [`intent:${intentDecision.kind}:retrieval_skipped`]
          : [])
      ],
      serverTime: nowIso()
    };
  }

  completeTurn(turnId: string, request: TurnCompleteRequest & Record<string, unknown>): CompleteTurnResponse {
    request = sanitizeTurnCompleteRequest(request);
    if (!this.memoryAddEnabled()) {
      return this.completeTurnNoWrite(turnId, request);
    }
    const startedAt = Date.now();
    const idempotencyKey = request.adapterId && request.requestId
      ? `turn.complete:${request.adapterId}:${request.requestId}`
      : undefined;
    const requestHash = stableHash({
      turnId,
      request
    });

    if (idempotencyKey) {
      const existing = this.repos.runtime.getIdempotency(idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new MemoryServiceError("conflict", "idempotency key reused with different request body");
        }
        return {
          ...(existing.response as CompleteTurnResponse),
          duplicate: true
        };
      }
    }

    const response = this.repos.transaction(() => {
      const session = this.requireOpenSession(request.sessionId);
      this.assertSessionInScope(session, request.namespace);
      const existingRawTurn = this.repos.runtime.getRawTurnBySessionTurn(session.id, turnId);
      if (existingRawTurn) {
        this.assertRawTurnInScope(existingRawTurn, request.namespace);
      }
      const latestEpisodeBefore = existingRawTurn
        ? undefined
        : this.repos.runtime.latestEpisodeForSession(session.id);
      const episode = existingRawTurn
        ? this.requireEpisode(existingRawTurn.episodeId)
        : this.ensureEpisodeForTurn(session, request.episodeId, request.query, "turn.complete");
      const closedEpisodeIds = closedEpisodeIdsFromBoundary(
        latestEpisodeBefore,
        episode,
        latestEpisodeBefore ? this.repos.runtime.getEpisode(latestEpisodeBefore.id) : undefined
      );
      this.assertEpisodeInScope(episode, request.namespace);
      const at = nowIso();
      this.repos.runtime.touchSession(session.id, at);
      const rawTurnId = rawTurnIdForSessionTurn(session.id, turnId);
      const requestToolCalls = normalizeCompleteTurnToolCalls(request);
      const requestToolResults = normalizeCompleteTurnToolResults(request);
      const requestArtifacts = normalizeCompleteTurnArtifacts(request);

      const insertedRawTurn: RawTurnRecord =
        existingRawTurn ??
        this.repos.runtime.insertRawTurn({
          id: rawTurnId,
          sessionId: session.id,
          episodeId: episode.id,
          turnId,
          userId: session.userId,
          conversationId: session.conversationId,
          userText: request.query,
          assistantText: request.answer,
          reasoningSummary: stringFromMaybeRecord(request, "reasoningSummary"),
          toolCalls: requestToolCalls,
          toolResults: requestToolResults,
          sourceMemoryIds: normalizeCompleteTurnSourceMemoryIds(request),
          usage: isRecord(request.usage) ? request.usage : {},
          messagePayload: {
            turn_complete: {
              completed_at: at,
              source_memory_ids: normalizeCompleteTurnSourceMemoryIds(request)
            }
          },
          status: request.status ?? "succeeded",
          createdAt: at
        });
      const rawTurnCreated = !existingRawTurn;
      const rawTurnFirstCompleted = rawTurnCreated
        || !isRecord(existingRawTurn.messagePayload?.turn_complete);
      const rawTurn = existingRawTurn
        ? this.repos.runtime.updateRawTurn(completeObservedRawTurn(existingRawTurn, request, at))
        : insertedRawTurn;
      if (rawTurnCreated) {
        this.repos.runtime.appendChange({
          memoryId: rawTurn.id,
          namespaceId: namespaceIdFromSession(session),
          kind: "raw_turn",
          op: "created",
          entityId: rawTurn.id,
          userId: session.userId,
          changeType: "raw_turn_created",
          after: rawTurn,
          source: "turn.complete",
          createdAt: at
        });
      } else if (stableHash(existingRawTurn) !== stableHash(rawTurn)) {
        this.repos.runtime.appendChange({
          memoryId: rawTurn.id,
          namespaceId: namespaceIdFromSession(session),
          kind: "raw_turn",
          op: "updated",
          entityId: rawTurn.id,
          userId: session.userId,
          changeType: "raw_turn_update",
          before: existingRawTurn,
          after: rawTurn,
          source: "turn.complete",
          createdAt: at
        });
      }

      const requestTags = normalizeRequestTags(request.tags);
      const capturedSteps = this.captureEpisodeIncrementalSteps(episode, rawTurn, at)
        .map((step) => {
          const stepRawTurnId = step.rawTurnId ?? rawTurn.id;
          return stepRawTurnId === rawTurn.id && requestTags.length > 0
            ? { ...step, tags: uniq([...step.tags, ...requestTags]) }
            : step;
        });

      const l1MemoryIds: string[] = [];
      let changeSeq = 0;
      const jobs: EvolutionJobRecord[] = [];

      for (const step of capturedSteps) {
        const stepRawTurnId = step.rawTurnId ?? rawTurn.id;
        const signature = signatureFromTraceParts(step.tags, step.toolCalls, step.reflection.text ?? "");
        const l1Memory = this.buildMemory({
          id: `trace_${stableHash(`L1:${session.id}:${step.turnId}:${step.stepIndex}`).slice(0, 20)}`,
          userId: session.userId,
          conversationId: session.conversationId,
          sessionId: session.id,
          agentId: session.source,
          appId: session.workspaceId,
          projectId: session.projectId,
          profileId: session.profileId,
          layer: "L1",
          kind: "trace",
          memoryType: "LongTermMemory",
          key: `trace:${session.id}:${step.turnId}:${step.stepIndex}`,
          value: renderTraceMemoryValue({
            ...step,
            rawTurnId: stepRawTurnId
          }),
          tags: step.tags,
          info: {
            turn_id: step.turnId,
            raw_turn_id: stepRawTurnId,
            episode_id: episode.id,
            status: rawTurn.status,
            summary: step.summary
          },
          internal: {
            source: "turn.complete",
            plugin_algorithm: "capture.v7",
            source_raw_turn_id: stepRawTurnId,
            source_memory_ids: rawTurn.sourceMemoryIds,
            summary: step.summary,
            reflection: step.reflection.text,
            alpha: step.reflection.alpha,
            value: step.value,
            priority: step.priority,
            raw_turn_id: stepRawTurnId,
            raw_span: {
              user_text: Boolean(step.userText),
              agent_text: Boolean(step.agentText),
              tool_call_count: step.toolCalls.length
            },
            error_signatures: step.errorSignatures,
            trace: {
              key: step.key,
              ts: step.ts,
              turn_id: step.turnId,
              raw_turn_id: stepRawTurnId,
              raw_span: {
                user_text: Boolean(step.userText),
                agent_text: Boolean(step.agentText),
                tool_call_count: step.toolCalls.length
              },
              episode_id: episode.id,
              step_index: step.stepIndex,
              sub_step_total: step.subStepTotal,
              agent_thinking: step.agentThinking,
              userText: step.userText,
              agentText: step.agentText,
              tool_calls: sanitizeTraceToolCalls(step.toolCalls),
              reflection: step.reflection.text,
              alpha: step.reflection.alpha,
              usable: step.reflection.usable,
              reflection_source: step.reflection.source,
              summary: step.summary,
              tags: step.tags,
              value: step.value,
              priority: step.priority,
              signature,
              error_signatures: step.errorSignatures,
              vec_summary: step.vecSummary,
              vec_action: step.vecAction
            }
          },
          createdAt: at
        });

        const upsert = this.repos.memories.upsertByKey(l1Memory);
        l1MemoryIds.push(upsert.memory.id);
        changeSeq = this.repos.runtime.appendChange({
          memoryId: upsert.memory.id,
          namespaceId: namespaceIdFromMemory(upsert.memory),
          kind: "trace",
          op: upsert.created ? "created" : "updated",
          entityId: upsert.memory.id,
          userId: session.userId,
          changeType: upsert.created ? "create" : "update",
          before: upsert.previous,
          after: upsert.memory,
          source: "turn.complete.capture.v7",
          createdAt: at
        });
        this.repos.runtime.appendEpisodeTurn(episode.id, stepRawTurnId, upsert.memory.id, at);
        if (!this.repos.processing.get(upsert.memory.id)) {
          const summaryRequired = this.llm.isConfigured();
          const embeddingRequired = this.config.algorithm.capture.embedAfterCapture;
          const job = summaryRequired
            ? this.enqueueJob({
              jobType: "trace_summary",
              userId: session.userId,
              sessionId: session.id,
              episodeId: episode.id,
              targetMemoryId: upsert.memory.id,
              payload: {
                turnId: step.turnId,
                rawTurnId: stepRawTurnId,
                source: "turn.complete.capture.v7",
                contentHash: upsert.memory.contentHash
              },
              maxAttempts: 3,
              createdAt: at
            })
            : embeddingRequired
              ? this.enqueueJob({
                jobType: "embedding",
                userId: session.userId,
                sessionId: session.id,
                episodeId: episode.id,
                targetMemoryId: upsert.memory.id,
                payload: {
                  turnId: step.turnId,
                  rawTurnId: stepRawTurnId,
                  source: "turn.complete.capture.v7",
                  contentHash: upsert.memory.contentHash
                },
                maxAttempts: 6,
                createdAt: at
              })
              : undefined;
          if (job) jobs.push(job);
          this.repos.processing.save({
            memoryId: upsert.memory.id,
            state: summaryRequired
              ? "summary_pending"
              : embeddingRequired
                ? "embedding_pending"
                : "ready_text_only",
            stage: summaryRequired ? "summary" : embeddingRequired ? "embedding" : null,
            activeJobId: job?.id ?? null,
            attemptCount: 0,
            manualRetryCount: 0,
            retryAction: "retry",
            errorCode: null,
            errorMessage: null,
            failedAt: null,
            updatedAt: at
          });
        }
      }
      for (const artifact of requestArtifacts) {
        const artifactId = this.repos.runtime.insertArtifact({
          sessionId: session.id,
          episodeId: episode.id,
          rawTurnId: rawTurn.id,
          userId: session.userId,
          kind: artifact.kind,
          uri: artifact.uri,
          payload: artifact.payload,
          createdAt: at
        });
        this.repos.runtime.appendChange({
          memoryId: artifactId,
          namespaceId: namespaceIdFromSession(session),
          kind: "artifact",
          op: "created",
          entityId: artifactId,
          userId: session.userId,
          changeType: "artifact_created",
          after: {
            id: artifactId,
            sessionId: session.id,
            episodeId: episode.id,
            rawTurnId: rawTurn.id,
            userId: session.userId,
            kind: artifact.kind,
            uri: artifact.uri,
            payload: artifact.payload,
            createdAt: at
          },
          source: "turn.complete.artifact",
          createdAt: at
        });
      }
      if (rawTurnFirstCompleted) {
        jobs.push(this.enqueueJob({
          jobType: "episode_idle_close",
          userId: session.userId,
          sessionId: session.id,
          episodeId: episode.id,
          dedupeKey: `episode_idle_close:${rawTurn.id}`,
          payload: {
            triggerRawTurnId: rawTurn.id,
            triggerEpisodeId: episode.id,
            triggeredAt: at
          },
          createdAt: at
        }));
      }
      const responseChangeSeq = this.repos.runtime.latestChangeSeq(session.userId, namespaceIdFromSession(session));
      const body: CompleteTurnResponse = {
        turnId,
        sessionId: session.id,
        episodeId: episode.id,
        rawTurnId: rawTurn.id,
        l1MemoryId: l1MemoryIds[0] ?? "",
        l1MemoryIds,
        closedEpisodeIds,
        scheduledEvolution: true,
        jobs: jobs.map(jobToRef),
        changeSeq: responseChangeSeq,
        syncCursor: this.encodeChangeCursor(responseChangeSeq, namespaceForSession(session)),
        etag: stableHash({
          changeSeq: responseChangeSeq,
          l1MemoryIds,
          rawTurnId: rawTurn.id
        }),
        serverTime: nowIso()
      };

      if (idempotencyKey) {
        this.repos.runtime.saveIdempotency(idempotencyKey, requestHash, body, at);
      }
      return body;
    });

    for (const memoryId of response.l1MemoryIds) {
      const memory = this.repos.memories.get(memoryId);
      this.recordApiLog("memory_add", {
        sessionId: response.sessionId,
        turnId,
        episodeId: response.episodeId,
        source: "turn.complete",
        sourceAgent: memory?.agentId,
        query: request.query,
        toolCallCount: normalizeCompleteTurnToolCalls(request).length
      }, {
        stored: 1,
        details: [{
          role: "trace",
          action: "stored",
          sourceAgent: memory?.agentId,
          traceId: memoryId,
          episodeId: response.episodeId,
          query: request.query,
          agent: request.answer,
          summary: memory ? detailSummaryForMemory(memory) || detailTitleForMemory(memory) : undefined
        }]
      }, Date.now() - startedAt, true, response.serverTime, memory?.agentId);
    }

    return response;
  }

  async observeTool(input: ToolObserveRequest): Promise<{
    ok: true;
    eventId: string;
    rawTurnId?: string;
    repair?: DecisionRepairSummary;
    changeSeq?: number;
    syncCursor?: string;
    serverTime: string;
  }> {
    if (!this.memoryAddEnabled()) {
      return this.observeToolNoWrite(input);
    }
    const session = this.requireOpenSession(input.sessionId);
    this.assertSessionInScope(session, input.namespace);
    const episode = this.ensureEpisode(session, input.episodeId);
    const at = nowIso();
    const observation = toolObservationEvent(input);
    const turnId = input.turnId ?? `observe:${stableHash(`${session.id}:${at}:${stableStringify(observation.event)}`).slice(0, 16)}`;
    const existing = this.repos.runtime.getRawTurnBySessionTurn(session.id, turnId);
    if (existing) {
      this.assertRawTurnInScope(existing, input.namespace);
      if (existing.sessionId !== session.id) {
        throw new MemoryServiceError("conflict", "observed raw turn belongs to a different session");
      }
      if (input.episodeId && existing.episodeId !== input.episodeId) {
        throw new MemoryServiceError("conflict", "observed raw turn belongs to a different episode");
      }
    }
    const createdRawTurn = !existing;
    const rawTurn = existing ?? this.repos.runtime.insertRawTurn({
      id: `raw_${stableHash(`${session.id}:${turnId}`).slice(0, 20)}`,
      sessionId: session.id,
      episodeId: episode.id,
      turnId,
      userId: session.userId,
      conversationId: session.conversationId,
      toolCalls: [],
      toolResults: [],
      sourceMemoryIds: [],
      usage: {},
      messagePayload: {
        observe: {
          requestId: input.requestId,
          adapterId: input.adapterId
        }
      },
      status: "observed",
      createdAt: at
    });
    const nextToolCalls = rawTurn.toolCalls.some((call) =>
      isToolCallPayload(call) &&
      ((input.toolCallId && call.id === input.toolCallId) || call.name === input.toolName)
    )
      ? rawTurn.toolCalls
      : [...rawTurn.toolCalls, observation.toolCall];
    const updatedRawTurn: RawTurnRecord = {
      ...rawTurn,
      toolCalls: nextToolCalls,
      toolResults: observation.toolResult === undefined ? rawTurn.toolResults : [...rawTurn.toolResults, observation.toolResult],
      messagePayload: {
        ...(rawTurn.messagePayload ?? {}),
        last_observation: {
          phase: observation.phase,
          observed_at: at
        }
      }
    };
    this.repos.runtime.updateRawTurn(updatedRawTurn);
    this.repos.runtime.appendEpisodeRawTurn(episode.id, rawTurn.id, at);
    const eventId = this.repos.runtime.insertArtifact({
      sessionId: session.id,
      episodeId: episode.id,
      rawTurnId: rawTurn.id,
      userId: session.userId,
      kind: "tool_call",
      payload: {
        phase: observation.phase,
        value: observation.event
      },
      createdAt: at
    });
    this.repos.runtime.appendChange({
      memoryId: rawTurn.id,
      namespaceId: namespaceIdFromSession(session),
      kind: "raw_turn",
      op: createdRawTurn ? "created" : "updated",
      entityId: rawTurn.id,
      userId: session.userId,
      changeType: createdRawTurn ? "raw_turn_created" : "raw_turn_update",
      before: createdRawTurn ? undefined : rawTurn,
      after: updatedRawTurn,
      source: "tools.observe",
      createdAt: at
    });
    const repair = await this.recordToolOutcomeForRepair(input, session, episode, rawTurn, updatedRawTurn, at);
    const responseChangeSeq = this.repos.runtime.latestChangeSeq(session.userId, namespaceIdFromSession(session));
    return {
      ok: true,
      eventId,
      rawTurnId: rawTurn.id,
      repair,
      changeSeq: responseChangeSeq,
      syncCursor: this.encodeChangeCursor(responseChangeSeq, namespaceForSession(session)),
      serverTime: nowIso()
    };
  }

  private async recordToolOutcomeForRepair(
    input: ToolObserveRequest,
    session: SessionRecord,
    episode: EpisodeRecord,
    rawTurn: RawTurnRecord,
    updatedRawTurn: RawTurnRecord,
    at: string
  ): Promise<DecisionRepairSummary | undefined> {
    const outcome = toolOutcomeFromObservation(input, rawTurn, updatedRawTurn);
    if (!outcome || outcome.success === undefined) return undefined;
    const context = toolRepairContext(session, episode);
    const step = this.nextToolObservationStep(outcome.toolId, context);
    if (outcome.success) {
      this.recordToolSuccess(outcome.toolId, context, step);
      return undefined;
    }
    const burst = this.recordToolFailure({
      toolId: outcome.toolId,
      context,
      step,
      reason: outcome.reason ?? "tool failed",
      ts: Date.parse(at),
      rawTurnId: rawTurn.id,
      sessionId: session.id,
      episodeId: episode.id
    });
    if (!burst) return undefined;
    return this.maybeCreateFailureBurstRepair({
      burst,
      session,
      episode,
      rawTurn,
      reason: outcome.reason ?? "tool failed",
      at
    });
  }

  private nextToolObservationStep(toolId: string, context: string): number {
    const key = toolSignalKey(toolId, context);
    const next = (this.toolStepCounters.get(key) ?? 0) + 1;
    this.toolStepCounters.set(key, next);
    return next;
  }

  private recordToolFailure(record: ToolFailureRecord): ToolFailureBurst | undefined {
    const key = toolSignalKey(record.toolId, record.context);
    const existing = this.toolFailureStates.get(key);
    const state: ToolFailureState = existing ?? {
      toolId: record.toolId,
      context: record.context,
      firstSeen: record.ts,
      lastSeen: record.ts,
      windowStart: record.step,
      occurrences: []
    };
    const minStep = record.step - this.config.algorithm.feedback.failureWindow + 1;
    state.occurrences = state.occurrences.filter((item) => item.step >= minStep);
    state.occurrences.push(record);
    state.lastSeen = record.ts;
    state.windowStart = minStep;
    if (!existing) state.firstSeen = record.ts;
    this.toolFailureStates.set(key, state);

    const successAt = this.toolSuccessSteps.get(key);
    const successInWindow = successAt !== undefined && successAt >= state.windowStart;
    if (state.occurrences.length >= this.config.algorithm.feedback.failureThreshold && !successInWindow) {
      return {
        ...state,
        contextHash: toolRepairContextHash(record.toolId, record.context),
        failureCount: state.occurrences.length
      };
    }
    return undefined;
  }

  private recordToolSuccess(toolId: string, context: string, step: number): void {
    const key = toolSignalKey(toolId, context);
    this.toolSuccessSteps.set(key, step);
    const state = this.toolFailureStates.get(key);
    if (!state) return;
    state.occurrences = state.occurrences.filter((item) => item.step >= step);
  }

  private async maybeCreateFailureBurstRepair(input: {
    burst: ToolFailureBurst;
    session: SessionRecord;
    episode: EpisodeRecord;
    rawTurn: RawTurnRecord;
    reason: string;
    at: string;
  }): Promise<DecisionRepairSummary> {
    const { burst, session, episode, rawTurn, reason, at } = input;
    const cooldownMs = this.config.algorithm.feedback.cooldownMs;
    if (cooldownMs > 0) {
      const since = new Date(Date.parse(at) - cooldownMs).toISOString();
      const recent = this.repos.runtime.listDecisionRepairs({
        userId: session.userId,
        contextHash: burst.contextHash,
        since,
        limit: 1
      });
      if (recent.length > 0) {
        return {
          contextHash: burst.contextHash,
          skipped: true,
          reason: "cooldown"
        };
      }
    }

    const evidence = this.failureBurstRepairEvidence({
      session,
      toolId: burst.toolId,
      reason,
      limit: this.config.algorithm.feedback.evidenceLimit
    });
    const valueDiff = repairEvidenceValueDiff(evidence.highValueMemories, evidence.lowValueMemories);
    if (valueDiff < this.config.algorithm.feedback.valueDelta) {
      return {
        contextHash: burst.contextHash,
        skipped: true,
        reason: "value-delta-low"
      };
    }

    const llmDraft = await this.maybeSynthesizeFailureBurstDecisionRepair(burst, reason, evidence);
    const preference = llmDraft?.preference ?? failureBurstPreference(burst, reason, evidence.highValueMemories[0]);
    const antiPattern = llmDraft?.antiPattern ?? failureBurstAntiPattern(burst, reason);
    const repair = this.repos.runtime.insertDecisionRepair({
      id: newId("repair"),
      sessionId: session.id,
      episodeId: episode.id,
      rawTurnId: rawTurn.id,
      userId: session.userId,
      projectId: session.projectId ?? session.workspaceId,
      contextHash: burst.contextHash,
      issue: `Repeated ${burst.toolId} failure: ${clip(reason, 180)}`,
      suggestion: preference,
      preference,
      antiPattern,
      highValueMemoryIds: evidence.highValueMemories.map((memory) => memory.id),
      lowValueMemoryIds: evidence.lowValueMemories.map((memory) => memory.id),
      attachedPolicyMemoryIds: evidence.policyIds,
      validated: false,
      source: {
        source: "tools.observe.decision_repair.v7",
        trigger: "failure-burst",
        ...(llmDraft ? { synthesis: "llm" } : {}),
        burst: {
          toolId: burst.toolId,
          context: burst.context,
          contextHash: burst.contextHash,
          failureCount: burst.failureCount,
          failures: burst.occurrences.map((failure) => ({
            step: failure.step,
            reason: failure.reason,
            rawTurnId: failure.rawTurnId
          }))
        }
      },
      meta: {
        trigger: "failure-burst",
        severity: llmDraft?.severity ?? "warn",
        confidence: llmDraft?.confidence ??
          (evidence.highValueMemories.length > 0 && evidence.lowValueMemories.length > 0 ? 0.6 : 0.4),
        valueDiff
      },
      createdAt: at
    });
    this.repos.runtime.appendEpisodeDecisionRepair(episode.id, repair.id, at);
    const attachedPolicyIds = evidence.policyIds.length > 0
      ? this.attachRepairToPolicies(repair.id, evidence.policyIds, repair.preference, repair.antiPattern, at)
      : [];
    this.repos.runtime.appendChange({
      memoryId: repair.id,
      namespaceId: namespaceIdFromSession(session),
      userId: session.userId,
      kind: "repair",
      op: "created",
      entityId: repair.id,
      changeType: "decision_repair_created",
      after: repair,
      source: "tools.observe.decision_repair.v7",
      createdAt: at
    });
    return {
      repairId: repair.id,
      contextHash: burst.contextHash,
      skipped: false,
      attachedPolicyIds
    };
  }

  private failureBurstRepairEvidence(input: {
    session: SessionRecord;
    toolId: string;
    reason: string;
    limit: number;
  }): {
    highValueMemories: MemoryRow[];
    lowValueMemories: MemoryRow[];
    policyIds: string[];
  } {
    const query = `${input.toolId}\n${input.reason}`;
    const policies = this.repos.memories.search(
      query,
      {
        memoryLayer: "L2",
        status: "activated"
      },
      input.limit
    );
    const policyIds = policies.map((policy) => policy.id);
    const l1Hits = this.repos.memories.search(
      query,
      {
        memoryLayer: "L1",
        status: "activated"
      },
      input.limit * 4
    );
    const highValueMemories: MemoryRow[] = [];
    const lowValueMemories: MemoryRow[] = [];
    for (const hit of l1Hits) {
      const memory = this.repos.memories.get(hit.id);
      if (!memory) continue;
      const trace = this.traceMeta(memory);
      if (!trace) continue;
      if (trace.value > 0 && highValueMemories.length < input.limit) {
        highValueMemories.push(memory);
      }
      if (
        trace.value < -this.config.algorithm.feedback.minLowValueThreshold &&
        lowValueMemories.length < input.limit
      ) {
        lowValueMemories.push(memory);
      }
    }
    for (const policy of this.repos.memories.getMany(policyIds)) {
      const meta = policyMetaFromMemory(policy);
      if (!meta) continue;
      for (const memory of this.repos.memories.getMany(meta.sourceTraceIds)) {
        const trace = this.traceMeta(memory);
        if (!trace) continue;
        if (trace.value > 0 && highValueMemories.length < input.limit && !highValueMemories.some((item) => item.id === memory.id)) {
          highValueMemories.push(memory);
        }
        if (
          trace.value < -this.config.algorithm.feedback.minLowValueThreshold &&
          lowValueMemories.length < input.limit &&
          !lowValueMemories.some((item) => item.id === memory.id)
        ) {
          lowValueMemories.push(memory);
        }
      }
    }
    return {
      highValueMemories,
      lowValueMemories,
      policyIds
    };
  }

  private async maybeSynthesizeFailureBurstDecisionRepair(
    burst: ToolFailureBurst,
    reason: string,
    evidence: {
      highValueMemories: MemoryRow[];
      lowValueMemories: MemoryRow[];
      policyIds: string[];
    }
  ): Promise<DecisionRepairLlmDraft | undefined> {
    if (!this.config.algorithm.feedback.useLlm || !this.skillLlm.isConfigured()) {
      return undefined;
    }
    const messages = decisionRepairPromptMessages({
      trigger: "failure-burst",
      contextHash: burst.contextHash,
      feedbackText: `${burst.toolId}: ${reason}`,
      classification: {
        shape: "negative",
        confidence: 0.6,
        avoid: reason,
        text: reason
      },
      highValue: this.decisionRepairTraceSources(evidence.highValueMemories),
      lowValue: this.decisionRepairTraceSources(evidence.lowValueMemories),
      traceCharCap: this.config.algorithm.feedback.traceCharCap
    });
    try {
      const result = await this.skillLlm.completeJson<{
        preference?: unknown;
        anti_pattern?: unknown;
        severity?: unknown;
        confidence?: unknown;
      }>(messages, {
        operation: DECISION_REPAIR_OPERATION,
        thinkingMode: "enabled",
        temperature: this.skillLlm.config.temperature,
        maxTokens: 800
      });
      return normalizeDecisionRepairLlmDraft(result);
    } catch (error) {
      pipelineLogger.warn("fallback.used", {
        operation: DECISION_REPAIR_OPERATION,
        pipeline: "decision_repair.failure_burst",
        fallback: "no_llm_draft",
        ...memoryErrorFields(error)
      });
      return undefined;
    }
  }

  subagentStart(input: SubagentStartRequest): {
    ok: true;
    eventId: string;
    childSessionId?: string;
    rawTurnId: string;
    changeSeq: number;
    syncCursor: string;
    serverTime: string;
  } {
    if (!this.memoryAddEnabled()) {
      return this.subagentStartNoWrite(input);
    }
    const session = this.requireOpenSession(input.sessionId);
    this.assertSessionInScope(session, input.namespace);
    const episode = this.ensureEpisode(session, input.episodeId);
    const at = nowIso();
    const metadata = input.metadata ?? {};
    const subagentId = input.subagentId ?? newId("subagent");
    const rawTurnId = newId("raw");
    const turnId = `subagent:start:${subagentId}:${rawTurnId.slice("raw_".length, "raw_".length + 12)}`;
    const rawTurn = this.repos.runtime.insertRawTurn({
      id: rawTurnId,
      sessionId: session.id,
      episodeId: episode.id,
      turnId,
      userId: session.userId,
      conversationId: session.conversationId,
      userText: input.task,
      toolCalls: [],
      toolResults: [],
      sourceMemoryIds: [],
      usage: {},
      messagePayload: {
        subagentStart: {
          subagentId,
          task: input.task,
          metadata
        }
      },
      status: "started",
      createdAt: at
    });
    this.repos.runtime.appendEpisodeRawTurn(episode.id, rawTurn.id, at);
    const changeSeq = this.repos.runtime.appendChange({
      memoryId: rawTurn.id,
      namespaceId: namespaceIdFromSession(session),
      kind: "raw_turn",
      op: "created",
      entityId: rawTurn.id,
      userId: session.userId,
      changeType: "raw_turn_created",
      after: rawTurn,
      source: "subagent.start",
      createdAt: at
    });
    const eventId = this.repos.runtime.insertArtifact({
      sessionId: session.id,
      episodeId: episode.id,
      rawTurnId: rawTurn.id,
      userId: session.userId,
      kind: "subagent_start",
      payload: {
        subagentId,
        task: input.task,
        metadata
      },
      createdAt: at
    });
    this.repos.runtime.insertAudit({
      userId: session.userId,
      sessionId: session.id,
      actor: input.namespace ? { ...input.namespace } : {},
      action: "subagent_start",
      targetKind: "raw_turn",
      targetId: rawTurn.id,
      meta: { subagentId },
      createdAt: at
    });
    return {
      ok: true,
      eventId,
      rawTurnId: rawTurn.id,
      changeSeq,
      syncCursor: this.encodeChangeCursor(changeSeq, namespaceForSession(session)),
      serverTime: nowIso()
    };
  }

  subagentComplete(input: SubagentCompleteRequest): CompleteTurnResponse {
    const metadata = input.metadata ?? {};
    const subagentId = input.subagentId ?? "subagent";
    const turnId = `subagent:complete:${subagentId}:${stableHash(stableStringify(input.result ?? input.summary ?? "")).slice(0, 12)}`;
    const result = this.completeTurn(turnId, {
      adapterId: input.adapterId,
      requestId: input.requestId,
      namespace: input.namespace,
      sessionId: input.sessionId,
      query: `Subagent ${subagentId} completed.`,
      answer: input.result ?? input.summary ?? "Subagent completed.",
      status: input.status ?? "succeeded",
    });
    const rawTurn = this.repos.runtime.getRawTurn(result.rawTurnId);
    if (rawTurn) {
      const at = nowIso();
      const nextRawTurn = {
        ...rawTurn,
        messagePayload: {
          ...(rawTurn.messagePayload ?? {}),
          subagentComplete: {
            subagentId,
            summary: input.summary,
            metadata
          }
        }
      };
      const updatedRawTurn = this.repos.runtime.updateRawTurn(nextRawTurn);
      if (stableHash(rawTurn) !== stableHash(updatedRawTurn)) {
        const session = this.repos.runtime.getSession(updatedRawTurn.sessionId);
        const cursorNamespace = session ? namespaceForSession(session) : namespaceForRawTurn(updatedRawTurn);
        const changeSeq = this.repos.runtime.appendChange({
          memoryId: updatedRawTurn.id,
          namespaceId: namespaceIdFromContext(cursorNamespace),
          kind: "raw_turn",
          op: "updated",
          entityId: updatedRawTurn.id,
          userId: updatedRawTurn.userId,
          changeType: "raw_turn_update",
          before: rawTurn,
          after: updatedRawTurn,
          source: "subagent.complete",
          createdAt: at
        });
        return {
          ...result,
          changeSeq,
          syncCursor: this.encodeChangeCursor(changeSeq, cursorNamespace),
          etag: stableHash({
            etag: result.etag,
            rawTurnId: updatedRawTurn.id,
            changeSeq
          }),
          serverTime: nowIso()
        };
      }
    }
    return result;
  }

  async repairSuggestion(input: RepairSuggestionRequest): Promise<{
    suggestedAction: "none" | "append_hint" | "replacement_suggestion";
    appendHint?: {
      content: string;
      sourceMemoryIds: string[];
    };
    replacementSuggestion?: {
      content: string;
      sourceMemoryIds: string[];
    };
    reason?: string;
    sourceMemoryIds: string[];
  }> {
    if (!this.memorySearchEnabled()) {
      return {
        suggestedAction: "none",
        reason: "memory_search:disabled",
        sourceMemoryIds: []
      };
    }
    const session = this.requireOpenSession(input.sessionId);
    this.assertSessionInScope(session, input.namespace);
    const episode = this.repos.runtime.latestEpisodeForSession(input.sessionId);
    const contextHash = input.toolName && episode
      ? toolRepairContextHash(input.toolName, toolRepairContext(session, episode))
      : undefined;
    const query = buildRepairSuggestionQuery(input);
    const repairLayers = retrievalLayersForMode("decision_repair");
    const candidates = this.repos.memories.list(
      {
        memoryLayer: repairLayers,
        status: ["activated", "resolving"]
      },
      500
    ).filter((memory) => this.isMemoryReadyForRetrieval(memory));
    const retrieval = retrievePluginMemories({
      query,
      queryVector: await this.queryVector(query),
      memories: candidates,
      mode: "decision_repair",
      layers: repairLayers,
      limit: 5,
      config: this.retrievalTuningConfig()
    });
    const retrievedMemories = this.repos.memories.getMany(retrieval.hits.map((hit) => hit.id));
    const policyMemories = retrievedMemories.filter((memory) => memory.memoryLayer === "L2");
    const retrievedMemoryById = new Map(retrievedMemories.map((memory) => [memory.id, memory]));
    const policyGuidance = policyMemories.flatMap((memory) => {
      const policy = policyMetaFromMemory(memory);
      if (!policy) return [];
      return [
        ...policy.decisionGuidance.preference,
        ...policy.decisionGuidance.antiPattern,
        policy.procedure ? `Related policy: ${clip(policy.procedure, 220)}` : undefined
      ].filter((item): item is string => Boolean(item));
    });
    const retrievalGuidance = retrieval.hits
      .filter((hit) => !policyMemories.some((memory) => memory.id === hit.id))
      .map((hit) => {
        const memory = retrievedMemoryById.get(hit.id);
        const trace = memory ? traceMetaFromMemory(memory) : null;
        const toolText = trace?.toolCalls
          .map((call) => [
            call.name,
            stringifyForMemory(call.input),
            stringifyForMemory(call.output),
            call.error
          ].filter(Boolean).join(" "))
          .join("\n");
        const snippet = memory
          ? firstDetailDisplayString(toolText, memory.memoryValue, detailSummaryForMemory(memory), hit.snippet)
          : hit.snippet;
        return `Relevant ${hit.kind}: ${clip(snippet ?? "", 500)}`;
      });
    const repairs = contextHash
      ? this.repos.runtime.listDecisionRepairs({
          userId: session.userId,
          contextHash,
          limit: 5
        })
      : [];
    const repairGuidance = repairs.flatMap((repair) => [
      repair.preference,
      repair.antiPattern
    ].filter((item): item is string => Boolean(item)));
    const hint = uniq([
      ...repairGuidance,
      ...policyGuidance,
      ...retrievalGuidance
    ]).join("\n");
    const retrievedRawTurnIds = new Set(
      retrievedMemories
        .map((memory) => rawTurnIdFromMemory(memory))
        .filter((id): id is string => Boolean(id))
    );
    const retrievedSiblingTraceIds = retrievedRawTurnIds.size > 0
      ? candidates
          .filter((memory) => memory.memoryLayer === "L1" && retrievedRawTurnIds.has(rawTurnIdFromMemory(memory) ?? ""))
          .map((memory) => memory.id)
      : [];
    const sourceMemoryIds = uniq([
      ...retrievedMemories.flatMap((memory) => retrievedMemorySourceIds(memory)),
      ...retrievedSiblingTraceIds,
      ...repairs.flatMap((repair) => repair.attachedPolicyMemoryIds),
      ...repairs.flatMap((repair) => repair.highValueMemoryIds)
    ]);
    return {
      suggestedAction: hint ? "append_hint" : "none",
      appendHint: hint ? {
        content: hint,
        sourceMemoryIds
      } : undefined,
      reason: repairGuidance.length > 0
        ? "matched decision repair guidance"
        : policyGuidance.length > 0
          ? "matched L2 repair policies"
            : retrievalGuidance.length > 0
              ? "matched decision repair retrieval"
              : "no repair guidance found",
      sourceMemoryIds
    };
  }

  async search(request: InternalMemorySearchRequest): Promise<{
    searchEventId: string;
    hits: RecallHit[];
    injectedContext: InjectedContext;
    candidateMemoryIds: string[];
    sourceMemoryIds: string[];
    droppedDueToBudget: Array<{
      id: string;
      kind: MemoryKind;
      memoryLayer: MemoryLayer;
      reason: "token_budget";
      tokenEstimate?: number;
    }>;
    tierLatencyMs: {
      search: number;
      rerank: number;
      budget: number;
      total: number;
    };
    status: string[];
    verbose: boolean;
    serverTime: string;
  }> {
    const startedAt = Date.now();
    if (!this.memorySearchEnabled()) {
      return this.searchNoRead(request, startedAt);
    }
    const context = this.resolveContext(request);
    const retrievalMode = request.retrievalMode ?? "search";
    const episode = request.episodeId
      ? this.requireEpisode(request.episodeId)
      : request.sessionId
        ? this.repos.runtime.latestEpisodeForSession(request.sessionId)
        : undefined;
    if (episode) {
      this.assertEpisodeInScope(episode, request.namespace);
    }
    const recentRawTurnIds = retrievalMode === "turn_start" && request.sessionId
      ? new Set(
          this.repos.runtime
            .listRecentRawTurnsBySession(request.sessionId, 8)
            .map((turn) => turn.id)
        )
      : undefined;
    const tuning = this.retrievalTuningConfig();
    const allowedLayers = retrievalLayersForProfile(retrievalLayersForMode(retrievalMode), tuning);
    const layers = request.layers === undefined
      ? allowedLayers
      : request.layers.filter((layer) => allowedLayers.includes(layer));
    const searchAt = Date.now();
    const candidateCount = layers.length === 0
      ? 0
      : this.retrievalCandidateCount({ layers, tags: request.tags });
    const retrievalQuery = focusResearchRetrievalQuery(request.query, tuning.domain).text;
    const queryExtract = candidateCount > 0 ? await this.extractRetrievalQuery(retrievalQuery) : null;
    const queryVectorText = queryExtract?.queryVecText?.trim() || retrievalQuery;
    const retrievalLimit = request.limit ?? this.turnStartRetrievalLimit();
    const retrievalOutput = await this.retrieveSearchMemories({
      query: retrievalQuery,
      queryVectorText,
      queryExtract,
      layers,
      tags: request.tags,
      limit: retrievalLimit,
      mode: retrievalMode,
      excludeTraceRawTurnIds: recentRawTurnIds,
      targetSkillId: request.targetSkillId
    });
    const retrieval = retrievalOutput.retrieval;
    const memories = retrievalOutput.memories;
    const rerankAt = Date.now();
    const filteredHits = await this.filterRecallHits(queryVectorText, retrieval.hits);
    const hits = filteredHits.hits;
    const contextPacket = buildInjectedContext(
      hits,
      request.contextBudget ?? 1800,
      contextMemoriesForRecallHits(hits, memories),
      retrievalMode,
      request.contextHints,
      request.injectedContextQuery ?? request.query,
      tuning
    );
    const injectedContext = contextPacket.injectedContext;
    const budgetAt = Date.now();
    const recallEventId = newId("recall");
    const candidateMemoryIds = memories.map((memory) => memory.id);
    const sourceMemoryIds = contextPacket.sourceMemoryIds;
    const hitIds = new Set(hits.map((hit) => hit.id));
    const dropped = [
      ...contextPacket.droppedDueToBudget,
      ...memories
        .filter((memory) => !hitIds.has(memory.id))
        .slice(0, 50)
        .map((memory) => ({
          id: memory.id,
          kind: kindFromMemory(memory),
          memoryLayer: memory.memoryLayer,
          reason: "rank_threshold" as const
        }))
    ];
    if (this.memoryAddEnabled()) {
      this.repos.runtime.insertRecallEvent({
        id: recallEventId,
        namespaceId: namespaceIdFromContext(context.namespace),
        sessionId: request.sessionId,
        episodeId: episode?.id,
        turnId: request.turnId,
        userId: context.userId,
        query: request.query,
        queryHash: stableHash(request.query),
        layers,
        candidateMemoryIds,
        injectedMemoryIds: sourceMemoryIds,
        hitMemoryIds: hits.map((hit) => hit.id),
        dropped,
        outcome: "pending",
        request,
        createdAt: nowIso()
      });
    }

    const response = {
      searchEventId: recallEventId,
      hits,
      injectedContext: request.includeInjectedContext === false ? emptyInjectedContext() : injectedContext,
      candidateMemoryIds,
      sourceMemoryIds,
      droppedDueToBudget: contextPacket.droppedDueToBudget,
      tierLatencyMs: {
        search: searchAt - startedAt,
        rerank: rerankAt - searchAt,
        budget: budgetAt - rerankAt,
        total: Date.now() - startedAt
      },
      status: uniq([
        ...filteredHits.status,
        ...(!this.memoryAddEnabled() ? ["memory_add:disabled:no_recall_log"] : [])
      ]),
      verbose: request.verbose === true,
      serverTime: nowIso()
    };
    if (this.memoryAddEnabled()) {
      const keptIds = new Set(hits.map((hit) => hit.id));
      const logMemoryById = new Map(memories.map((memory) => [memory.id, memory]));
      const toSearchCandidateLog = (hit: RecallHit): Record<string, unknown> =>
        searchCandidateFromHit(hit, logMemoryById.get(hit.id));
      const sourceAgent = request.source?.trim() || context.namespace.source;
      this.recordApiLog("memory_search", {
        query: request.query,
        sessionId: request.sessionId,
        episodeId: episode?.id,
        layers,
        retrievalMode
      }, {
        candidates: retrieval.hits.map(toSearchCandidateLog),
        filtered: hits.map(toSearchCandidateLog),
        droppedByLlm: retrieval.hits.filter((hit) => !keptIds.has(hit.id)).map(toSearchCandidateLog),
        stats: {
          raw: memories.length,
          ranked: retrieval.hits.length,
          droppedByThreshold: retrieval.debug.droppedByThreshold,
          topRelevance: retrieval.debug.topRelevance,
          llmFilter: {
            outcome: filteredHits.status.length > 0 ? filteredHits.status.join(",") : "kept",
            kept: hits.length,
            dropped: Math.max(0, retrieval.hits.length - hits.length)
          },
          finalReturned: hits.length
        },
        status: filteredHits.status
      }, Date.now() - startedAt, true, response.serverTime, sourceAgent);
    }
    return response;
  }

  private async retrieveSearchMemories(input: {
    query: string;
    queryVectorText: string;
    queryExtract: RetrievalQueryExtract | null;
    layers: MemoryLayer[];
    tags?: string[];
    limit: number;
    mode: RetrievalMode;
    excludeTraceRawTurnIds?: ReadonlySet<string>;
    targetSkillId?: string;
  }): Promise<{ retrieval: RetrievalResult; memories: MemoryRow[] }> {
    if (input.limit <= 0 || input.layers.length === 0) {
      return { retrieval: emptyRetrievalResult(), memories: [] };
    }
    const runQuery = async (
      query: string,
      queryVectorText: string,
      queryExtract: RetrievalQueryExtract | null
    ): Promise<{ retrieval: RetrievalResult; memories: MemoryRow[] }> => {
      const config = this.retrievalTuningConfig();
      const compiledQuery = compileRetrievalQuery(query, queryExtract, {
        domain: config.domain
      });
      const hasVectorCandidates = this.hasRetrievalVectorCandidates({
        layers: input.layers,
        tags: input.tags
      });
      const queryVector = hasVectorCandidates ? await this.queryVector(queryVectorText) : undefined;
      const candidatePool = await this.indexedRetrievalCandidatePool({
        compiledQuery,
        queryVector,
        layers: input.layers,
        tags: input.tags,
        targetSkillId: input.targetSkillId,
        config
      });
      const memories = candidatePool.memories;
      if (memories.length === 0) {
        return { retrieval: emptyRetrievalResult(), memories };
      }
      return {
        memories,
        retrieval: retrievePluginMemories({
          query,
          queryVector,
          queryExtract,
          memories,
          layers: input.layers,
          limit: input.limit,
          mode: input.mode,
          excludeTraceRawTurnIds: input.excludeTraceRawTurnIds,
          targetSkillId: input.targetSkillId,
          channelScoresByMemory: candidatePool.channelScoresByMemory,
          config
        })
      };
    };

    if (!this.queryRewriteEnabled()) {
      return runQuery(input.query, input.queryVectorText, input.queryExtract);
    }

    const queries = await this.planQueryRewrite(input.query);
    if (queries.length <= 1) {
      const query = queries[0] ?? input.query;
      return runQuery(
        query,
        query === input.query ? input.queryVectorText : query,
        query === input.query ? input.queryExtract : null
      );
    }

    const outputs = await Promise.all(queries.map((query) =>
      runQuery(
        query,
        query === input.query ? input.queryVectorText : query,
        query === input.query ? input.queryExtract : null
      )
    ));
    return {
      retrieval: mergeRetrievalResults(outputs.map((output) => output.retrieval), input.limit),
      memories: uniqMemories(outputs.flatMap((output) => output.memories))
    };
  }

  private retrievalCandidateCount(input: {
    layers: MemoryLayer[];
    tags?: string[];
  }): number {
    const baseFilter: MemoryFilter = {
      memoryLayer: input.layers,
      status: ["activated", "resolving"]
    };
    return this.repos.memories.count(input.tags?.length ? { ...baseFilter, tags: input.tags } : baseFilter);
  }

  private hasRetrievalVectorCandidates(input: {
    layers: MemoryLayer[];
    tags?: string[];
  }): boolean {
    if (input.layers.length === 0) return false;
    const baseFilter: MemoryFilter = {
      memoryLayer: input.layers,
      status: ["activated", "resolving"]
    };
    return this.repos.memories.hasVectorRows(input.tags?.length ? { ...baseFilter, tags: input.tags } : baseFilter);
  }

  private async indexedRetrievalCandidatePool(input: {
    compiledQuery: CompiledRetrievalQuery;
    queryVector?: number[];
    layers: MemoryLayer[];
    tags?: string[];
    targetSkillId?: string;
    config: {
      tier1TopK: number;
      tier2TopK: number;
      tier3TopK: number;
      candidatePoolFactor: number;
      keywordTopK: number;
      tagFilter: "auto" | "on" | "off";
    };
  }): Promise<{
    memories: MemoryRow[];
    channelScoresByMemory: ReadonlyMap<string, SeededChannelScores>;
  }> {
    const routeTasks: Array<Promise<MemorySearchIdHit[]>> = [];
    const queryVector = input.queryVector && input.queryVector.length > 0 ? input.queryVector : undefined;
    const layers = input.layers;
    const addRoute = (run: () => MemorySearchIdHit[]): void => {
      routeTasks.push(Promise.resolve().then(run));
    };

    for (const layer of layers) {
      const filter: MemoryFilter = {
        memoryLayer: layer,
        status: ["activated", "resolving"],
        ...(input.tags?.length ? { tags: input.tags } : {})
      };
      const vectorPool = this.retrievalVectorPoolSize(layer, input.config);
      const keywordPool = this.retrievalKeywordPoolSize(layer, input.config);

      if (queryVector) {
        if (layer === "L1") {
          addRoute(() => this.searchTraceVectorRoutes(queryVector, filter, vectorPool, input.compiledQuery, input.config));
        } else {
          addRoute(() => this.repos.memories.searchVectorIds(queryVector, "vec", filter, vectorPool));
        }
      }

      if (input.compiledQuery.ftsMatch) {
        addRoute(() => this.repos.memories.searchFtsIds(input.compiledQuery.ftsMatch, filter, keywordPool));
      }
      if (input.compiledQuery.patternTerms.length > 0) {
        addRoute(() => this.repos.memories.searchPatternIds(input.compiledQuery.patternTerms, filter, keywordPool));
      }
      if (layer === "L1" && input.compiledQuery.structuralFragments.length > 0) {
        addRoute(() => this.repos.memories.searchStructuralIds(
          input.compiledQuery.structuralFragments,
          filter,
          Math.max(input.config.tier2TopK, 10)
        ));
      }
    }

    if (input.targetSkillId && layers.includes("Skill")) {
      routeTasks.push(Promise.resolve([{ id: input.targetSkillId, score: 1, channel: "vec" }]));
    }
    if (routeTasks.length === 0) {
      return { memories: [], channelScoresByMemory: new Map() };
    }

    const routeHits = await Promise.all(routeTasks);
    const flattenedHits = routeHits.flat();
    const candidateIds = dedupeStrings(flattenedHits.map((hit) => hit.id));
    const channelScoresByMemory = new Map<string, SeededChannelScores>();
    for (const hit of flattenedHits) {
      if (!hit.channel) continue;
      const scores = channelScoresByMemory.get(hit.id) ?? {};
      scores[hit.channel] = Math.max(scores[hit.channel] ?? -Infinity, hit.score);
      channelScoresByMemory.set(hit.id, scores);
    }
    return {
      memories: this.repos.memories.getMany(candidateIds).filter((memory) => this.isMemoryReadyForRetrieval(memory)),
      channelScoresByMemory
    };
  }

  private searchTraceVectorRoutes(
    queryVector: number[],
    filter: MemoryFilter,
    vectorPool: number,
    compiledQuery: CompiledRetrievalQuery,
    config: {
      tagFilter: "auto" | "on" | "off";
    }
  ): MemorySearchIdHit[] {
    const tags = config.tagFilter === "off" ? [] : compiledQuery.tags;
    const search = (anyOfTags?: string[]): MemorySearchIdHit[] => {
      const summary = this.repos.memories.searchVectorIds(queryVector, "vec_summary", filter, vectorPool, {
        anyOfTags
      });
      const action = this.repos.memories.searchVectorIds(queryVector, "vec_action", filter, vectorPool, {
        anyOfTags
      });
      return [...summary, ...action];
    };
    if (tags.length === 0) return search();
    const tagged = search(tags);
    if (tagged.length > 0 || config.tagFilter === "on") return tagged;
    return this.repos.memories.searchVectorIds(queryVector, "vec_summary", filter, vectorPool);
  }

  private isMemoryReadyForRetrieval(memory: MemoryRow): boolean {
    const processing = this.repos.processing.get(memory.id);
    if (!processing || !memoryHasImportPipeline(memory)) return isMemoryReadyForRetrieval(memory);
    if (processing.state === "ready" || processing.state === "ready_text_only") return true;
    if (
      processing.state === "embedding_pending" ||
      processing.state === "embedding" ||
      (processing.state === "failed" && processing.stage === "embedding")
    ) {
      return isMemoryReadyForRetrieval(memory);
    }
    return false;
  }

  private retrievalVectorPoolSize(
    layer: MemoryLayer,
    config: {
      tier1TopK: number;
      tier2TopK: number;
      tier3TopK: number;
      candidatePoolFactor: number;
    }
  ): number {
    const topK = layer === "Skill"
      ? config.tier1TopK
      : layer === "L3"
        ? config.tier3TopK
        : config.tier2TopK;
    return Math.max(1, Math.ceil(topK * config.candidatePoolFactor));
  }

  private retrievalKeywordPoolSize(
    layer: MemoryLayer,
    config: {
      tier1TopK: number;
      tier2TopK: number;
      tier3TopK: number;
      keywordTopK: number;
    }
  ): number {
    const topK = layer === "Skill"
      ? config.tier1TopK
      : layer === "L3"
        ? config.tier3TopK
        : config.tier2TopK;
    return Math.max(topK, config.keywordTopK);
  }

  private listAllMemories(filter: MemoryFilter): MemoryRow[] {
    const total = this.repos.memories.count(filter);
    return total <= 0 ? [] : this.repos.memories.list(filter, total);
  }

  private async filterRecallHits(query: string, hits: RecallHit[]): Promise<{
    hits: RecallHit[];
    status: string[];
  }> {
    const config = this.config.algorithm.retrieval;
    const usesEvolutionLlm = this.skillLlm.isConfigured();
    const filterLlm = usesEvolutionLlm ? this.skillLlm : this.llm;
    if (!config.llmFilterEnabled) {
      return {
        hits,
        status: ["llm_filter:disabled"]
      };
    }
    if (hits.length < config.llmFilterMinCandidates) {
      return { hits, status: [] };
    }
    if (!query.trim()) {
      return { hits, status: [] };
    }
    if (!filterLlm.isConfigured()) {
      return {
        hits: llmFilterFallbackCap(hits, config.llmFilterFallbackMaxKeep),
        status: ["llm_filter:no_llm"]
      };
    }

    try {
      const bodyChars = Math.max(120, config.llmFilterCandidateBodyChars);
      const candidates = hits.map((hit, index) =>
        `${index + 1}. ${describeRetrievalFilterCandidate(hit, bodyChars)}`
      ).join("\n");
      const result = await filterLlm.completeJson<{
        selected?: unknown;
        ranked?: unknown;
        sufficient?: unknown;
      }>(
        [
          {
            role: "system",
            content: RETRIEVAL_FILTER_PROMPT.system
          },
          {
            role: "user",
            content: `QUERY: ${clip(query, 500)}\n\nCANDIDATES:\n${candidates}`
          }
        ],
        {
          operation: `retrieval.${RETRIEVAL_FILTER_PROMPT.id}.v${RETRIEVAL_FILTER_PROMPT.version}`,
          thinkingMode: "disabled",
          temperature: 0,
          timeoutMs: RETRIEVAL_FILTER_TIMEOUT_MS,
          maxRetries: 0,
          maxTokens: usesEvolutionLlm
            ? Math.min(2048, Math.max(160, hits.length * 8 + 80))
            : MEMORY_SUMMARY_MAX_TOKENS,
          jsonMode: true
        }
      );
      const selectedRaw = Array.isArray(result.selected)
        ? result.selected
        : Array.isArray(result.ranked)
          ? result.ranked
          : null;
      if (!selectedRaw) {
        pipelineLogger.warn("fallback.used", {
          operation: `${RETRIEVAL_FILTER_PROMPT.id}.v${RETRIEVAL_FILTER_PROMPT.version}`,
          pipeline: "retrieval.filter",
          fallback: "candidate_cap",
          reason: "invalid_selection_shape",
          candidateCount: hits.length
        });
        return {
          hits: llmFilterFallbackCap(hits, config.llmFilterFallbackMaxKeep),
          status: ["llm_filter:llm_failed_fallback_cap"]
        };
      }
      const selected = selectedRaw
        .map((value) => typeof value === "number" ? value : Number(value))
        .filter((value) => Number.isFinite(value))
        .map((value) => Math.floor(value) - 1)
        .filter((value, index, values) => value >= 0 && value < hits.length && values.indexOf(value) === index)
        .slice(0, Math.max(0, config.llmFilterMaxKeep));
      if (selected.length === 0) {
        if (selectedRaw.length === 0) {
          return {
            hits: [],
            status: ["llm_filter:llm_dropped_all"]
          };
        }
        pipelineLogger.warn("fallback.used", {
          operation: `${RETRIEVAL_FILTER_PROMPT.id}.v${RETRIEVAL_FILTER_PROMPT.version}`,
          pipeline: "retrieval.filter",
          fallback: "candidate_cap",
          reason: "invalid_selection_indices",
          candidateCount: hits.length,
          selectedCount: selectedRaw.length
        });
        return {
          hits: llmFilterFallbackCap(hits, config.llmFilterFallbackMaxKeep),
          status: ["llm_filter:llm_failed_fallback_cap"]
        };
      }
      const kept = selected.map((index) => hits[index]!).filter(Boolean);
      return {
        hits: kept,
        status: kept.length === hits.length ? ["llm_filter:llm_kept_all"] : ["llm_filter:llm_filtered"]
      };
    } catch (error) {
      pipelineLogger.warn("fallback.used", {
        operation: `${RETRIEVAL_FILTER_PROMPT.id}.v${RETRIEVAL_FILTER_PROMPT.version}`,
        pipeline: "retrieval.filter",
        fallback: "candidate_cap",
        candidateCount: hits.length,
        ...memoryErrorFields(error)
      });
      return {
        hits: llmFilterFallbackCap(hits, config.llmFilterFallbackMaxKeep),
        status: ["llm_filter:llm_failed_fallback_cap"]
      };
    }
  }

  private async planQueryRewrite(rawQuery: string): Promise<string[]> {
    const raw = rawQuery.trim();
    if (!raw || !this.skillLlm.isConfigured()) return [rawQuery];
    try {
      const result = await this.skillLlm.completeJson<{
        queries?: unknown;
      }>(
        [
          {
            role: "system",
            content: QUERY_REWRITE_SYSTEM_PROMPT
          },
          {
            role: "user",
            content: `USER MEMORY SEARCH REQUEST:\n${raw.slice(0, 4000)}`
          }
        ],
        {
          operation: "retrieval.query_rewrite.v1",
          thinkingMode: "disabled",
          temperature: 0,
          timeoutMs: QUERY_REWRITE_TIMEOUT_MS,
          maxRetries: QUERY_REWRITE_MAX_RETRIES,
          maxTokens: 360,
          jsonMode: true
        }
      );
      const queries = normalizeQueryRewriteQueries(result.queries);
      if (queries.length > 0) return queries;
      pipelineLogger.warn("fallback.used", {
        operation: "retrieval.query_rewrite.v1",
        pipeline: "retrieval.query_rewrite",
        fallback: "original_query",
        reason: "empty_rewrite"
      });
      return [raw];
    } catch (error) {
      pipelineLogger.warn("fallback.used", {
        operation: "retrieval.query_rewrite.v1",
        pipeline: "retrieval.query_rewrite",
        fallback: "original_query",
        ...memoryErrorFields(error)
      });
      return [raw];
    }
  }

  private async extractRetrievalQuery(rawQuery: string): Promise<RetrievalQueryExtract | null> {
    const raw = rawQuery.trim();
    if (!raw || !this.skillLlm.isConfigured()) return null;
    try {
      const result = await this.skillLlm.completeJson<{
        queryVecText?: unknown;
        keywords?: unknown;
      }>(
        [
          {
            role: "system",
            content: RETRIEVAL_QUERY_EXTRACT_PROMPT.system
          },
          {
            role: "user",
            content: `COMPLETE USER INPUT:\n${raw.slice(0, 4000)}`
          }
        ],
        {
          operation: `retrieval.${RETRIEVAL_QUERY_EXTRACT_PROMPT.id}.v${RETRIEVAL_QUERY_EXTRACT_PROMPT.version}`,
          thinkingMode: "disabled",
          temperature: 0,
          timeoutMs: RETRIEVAL_QUERY_EXTRACT_TIMEOUT_MS,
          maxRetries: 0,
          maxTokens: 320,
          jsonMode: true
        }
      );
      const queryVecText = typeof result.queryVecText === "string" ? result.queryVecText.trim() : "";
      const keywords = normalizeRetrievalExtractKeywords(result.keywords);
      if (!queryVecText && keywords.length === 0) {
        pipelineLogger.warn("fallback.used", {
          operation: `${RETRIEVAL_QUERY_EXTRACT_PROMPT.id}.v${RETRIEVAL_QUERY_EXTRACT_PROMPT.version}`,
          pipeline: "retrieval.query_extract",
          fallback: "raw_query",
          reason: "empty_extract"
        });
        return null;
      }
      return { queryVecText, keywords };
    } catch (error) {
      pipelineLogger.warn("fallback.used", {
        operation: `${RETRIEVAL_QUERY_EXTRACT_PROMPT.id}.v${RETRIEVAL_QUERY_EXTRACT_PROMPT.version}`,
        pipeline: "retrieval.query_extract",
        fallback: "raw_query",
        ...memoryErrorFields(error)
      });
      return null;
    }
  }

  private retrievalTuningConfig(): {
    tier1TopK: number;
    tier2TopK: number;
    tier3TopK: number;
    candidatePoolFactor: number;
    weightCosine: number;
    weightPriority: number;
    mmrLambda: number;
    rrfConstant: number;
    relativeThresholdFloor: number;
    minSkillEta: number;
    minTraceSim: number;
    episodeGoalMinSim: number;
    minWorldModelConfidence: number;
    includeLowValue: boolean;
    tagFilter: "auto" | "on" | "off";
    keywordTopK: number;
    skillEtaBlend: number;
    smartSeed: boolean;
    smartSeedRatio: number;
    multiChannelBypass: boolean;
    skillInjectionMode: "summary" | "full";
    skillSummaryChars: number;
    decayHalfLifeDays: number;
    domain: "" | "research";
    readOnlyInjectionProfile: "all" | "experience" | "skill" | "skill_experience";
  } {
    const retrieval = this.config.algorithm.retrieval;
    return {
      tier1TopK: retrieval.tier1TopK,
      tier2TopK: retrieval.tier2TopK,
      tier3TopK: retrieval.tier3TopK,
      candidatePoolFactor: retrieval.candidatePoolFactor,
      weightCosine: retrieval.weightCosine,
      weightPriority: retrieval.weightPriority,
      mmrLambda: retrieval.mmrLambda,
      rrfConstant: retrieval.rrfConstant,
      relativeThresholdFloor: retrieval.relativeThresholdFloor,
      minSkillEta: retrieval.minSkillEta,
      minTraceSim: retrieval.minTraceSim,
      episodeGoalMinSim: retrieval.episodeGoalMinSim,
      minWorldModelConfidence: this.config.algorithm.l3Abstraction.minConfidenceForRetrieval,
      includeLowValue: retrieval.includeLowValue,
      tagFilter: retrieval.tagFilter,
      keywordTopK: retrieval.keywordTopK,
      skillEtaBlend: retrieval.skillEtaBlend,
      smartSeed: retrieval.smartSeed,
      smartSeedRatio: retrieval.smartSeedRatio,
      multiChannelBypass: retrieval.multiChannelBypass,
      skillInjectionMode: retrieval.skillInjectionMode,
      skillSummaryChars: retrieval.skillSummaryChars,
      decayHalfLifeDays: this.config.algorithm.reward.decayHalfLifeDays,
      domain: this.config.domain,
      readOnlyInjectionProfile: retrieval.readOnlyInjectionProfile
    };
  }

  addMemory(request: MemoryAddRequest): {
    id: string;
    kind: MemoryKind;
    memoryLayer: MemoryLayer;
    status: "activated" | "resolving" | "archived" | "deleted";
    title: string;
    summary: string;
    tags: string[];
    createdAt: string;
    serverTime: string;
  } {
    this.assertMemoryAddEnabled();
    request = sanitizeMemoryAddRequest(request);
    const startedAt = Date.now();
    const receivedAt = nowIso();
    if (!request.content?.trim()) {
      throw new MemoryServiceError("invalid_argument", "memory.add requires content");
    }

    const context = this.resolveContext(request);
    const session = request.sessionId ? this.requireSession(request.sessionId) : undefined;
    if (session) {
      this.assertSessionInScope(session, request.namespace);
    }

    const layer = request.layer ?? "L1";
    const kind = kindForLayer(layer);
    const at = normalizeMemoryAddCreatedAt(request.createdAt) ?? receivedAt;
    const importTrace = layer === "L1" ? memoryAddImportTrace(request, at) : null;
    const importTitle = importTrace && isAgentSourceImportMemoryAdd(request) ? titleFromImportTrace(importTrace) : undefined;
    const title = importTitle ?? (request.title?.trim() || firstLine(request.content).slice(0, 120) || "Untitled memory");
    const importSummary = importTrace ? stringFromRecord(importTrace, "summary") || IMPORT_SUMMARY_QUEUED_TAG : undefined;
    const tags = memoryAddTags(request, importTrace !== null, importTrace ? stringArray(importTrace["tags"]) : []);
    const memory = this.buildMemory({
      userId: session?.userId ?? context.userId,
      conversationId: session?.conversationId,
      sessionId: session?.id ?? request.sessionId,
      agentId: session?.source ?? request.source?.trim() ?? context.namespace.source,
      appId: session?.workspaceId,
      projectId: session?.projectId ?? context.namespace.projectId,
      profileId: session?.profileId ?? context.namespace.profileId,
      layer,
      kind,
      memoryType: layer === "Skill" ? "SkillMemory" : "LongTermMemory",
      key: memoryAddKey(request, layer, title),
      value: importTrace
        ? renderTraceMemoryValue({
          summary: importSummary ?? IMPORT_SUMMARY_QUEUED_TAG,
          userText: stringFromRecord(importTrace, "user_text"),
          agentText: stringFromRecord(importTrace, "agent_text"),
          toolCalls: toolCallsFromUnknown(importTrace["tool_calls"]),
          reflection: { text: null, alpha: IMPORT_DEFAULT_ALPHA },
          value: IMPORT_DEFAULT_VALUE,
          priority: IMPORT_DEFAULT_PRIORITY
        })
        : request.content,
      tags,
      info: {
        title,
        summary: importSummary ?? firstLine(request.content),
        source: request.source ?? "manual",
        turn_id: request.turnId
      },
      internal: {
        source: request.source ?? "manual",
        title,
        summary: importSummary ?? firstLine(request.content),
        turn_id: request.turnId,
        ...(importTrace
          ? {
            plugin_algorithm: "memory.add.import_async.v2",
            trace: importTrace
          }
          : {})
      },
      createdAt: at
    });

    const persisted = this.repos.transaction(() => {
      const upsert = this.repos.memories.upsertByKey(memory);
      const inserted = upsert.memory;
      const changeSeq = this.repos.runtime.appendChange({
        memoryId: inserted.id,
        namespaceId: namespaceIdFromMemory(inserted),
        kind: kindFromMemory(inserted),
        op: upsert.created ? "created" : "updated",
        entityId: inserted.id,
        userId: inserted.userId,
        changeType: upsert.created ? "create" : "update",
        before: upsert.previous,
        after: inserted,
        source: "memory.add",
        createdAt: at
      });

      if (importTrace) {
        const existing = this.repos.processing.get(inserted.id);
        const contentChanged = Boolean(
          !upsert.created &&
          upsert.previous?.contentHash &&
          upsert.previous.contentHash !== inserted.contentHash
        );
        if (contentChanged) {
          this.repos.memories.deleteVector(inserted.id, "vec_summary");
        }
        const processing = !existing || contentChanged
          ? this.repos.processing.save({
            memoryId: inserted.id,
            state: "summary_pending",
            stage: "summary",
            activeJobId: null,
            attemptCount: 0,
            manualRetryCount: existing?.manualRetryCount ?? 0,
            retryAction: "retry",
            errorCode: null,
            errorMessage: null,
            failedAt: null,
            updatedAt: at
          })
          : existing;
        if (!request.deferProcessing && processing.state === "summary_pending" && !processing.activeJobId) {
          const job = this.enqueueJob({
            jobType: "import_summary",
            userId: inserted.userId,
            sessionId: inserted.sessionId,
            targetMemoryId: inserted.id,
            payload: {
              source: "memory.add",
              changeSeq,
              contentHash: inserted.contentHash
            },
            maxAttempts: 3,
            createdAt: at
          });
          this.repos.processing.update(inserted.id, {
            activeJobId: job.id,
            updatedAt: at
          }, ["summary_pending"]);
        }
      }

      return { upsert, changeSeq };
    });
    const { upsert, changeSeq } = persisted;
    const inserted = upsert.memory;

    if (upsert.created && !isAgentSourceImportMemoryAdd(request)) {
      this.enqueueJob({
        jobType: "episode_idle_close",
        userId: inserted.userId,
        sessionId: inserted.sessionId,
        dedupeKey: `episode_idle_close:memory.add:${inserted.id}`,
        payload: {
          triggerMemoryId: inserted.id,
          triggerSource: "memory.add",
          triggeredAt: receivedAt
        },
        createdAt: receivedAt
      });
    }

    if (!importTrace && this.config.algorithm.capture.embedAfterCapture) {
      this.enqueueJob({
        jobType: "embedding",
        userId: inserted.userId,
        sessionId: inserted.sessionId,
        targetMemoryId: inserted.id,
        payload: {
          source: "memory.add",
          changeSeq
        },
        createdAt: at
      });
    }

    const item = this.repos.memories.toListItem(inserted);
    const response = {
      id: item.id,
      kind: item.kind,
      memoryLayer: item.memoryLayer,
      status: item.status,
      title: item.title,
      summary: item.summary,
      tags: item.tags,
      createdAt: inserted.createdAt,
      serverTime: nowIso()
    };
    if (!isAgentSourceImportMemoryAdd(request)) {
      this.recordApiLog("memory_add", {
        sessionId: request.sessionId,
        turnId: request.turnId,
        layer,
        source: request.source,
        tags: request.tags,
        content: request.content
      }, {
        stored: 1,
        details: [
          {
            role: item.kind,
            action: "stored",
            summary: item.summary,
            content: request.content,
            traceId: item.id
          }
        ]
      }, Date.now() - startedAt, true, response.serverTime, inserted.agentId);
    }
    return response;
  }

  timeline(input: RequestEnvelope & {
    userId?: string;
    sessionId?: string;
    episodeId?: string;
    layers?: MemoryLayer[];
    tags?: string[];
    limit?: number;
    cursor?: number;
  }): {
    sessionId?: string;
    episodeId?: string;
    traces: MemoryListItem[];
    rawTurns?: ReturnType<typeof rawTurnSummary>[];
    items: MemoryListItem[];
    nextCursor?: string;
    serverTime: string;
  } {
    this.assertMemorySearchEnabled();
    const context = this.resolveContext(input);
    const limit = input.limit ?? 50;
    const cursor = input.cursor ?? 0;
    const layers = input.layers && input.layers.length > 0 ? input.layers : (["L1"] as MemoryLayer[]);
    let scopedEpisode: EpisodeRecord | undefined;
    let scopedSession: SessionRecord | undefined;
    if (input.sessionId) {
      scopedSession = this.requireSession(input.sessionId);
      this.assertSessionInScope(scopedSession, input.namespace);
    }
    if (input.episodeId) {
      scopedEpisode = this.requireEpisode(input.episodeId);
      this.assertEpisodeInScope(scopedEpisode, input.namespace);
      if (input.sessionId && scopedEpisode.sessionId !== input.sessionId) {
        throw new MemoryServiceError("invalid_argument", "episode does not belong to session");
      }
    }
    const timelineEpisodes = scopedEpisode
      ? [scopedEpisode]
      : scopedSession
        ? this.repos.runtime.listEpisodesForSession(scopedSession.id)
            .sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt) || a.id.localeCompare(b.id))
        : undefined;
    const items = timelineEpisodes
      ? this.timelineItemsFromEpisodes(timelineEpisodes, layers, input.tags, limit, cursor)
      : this.repos.memories
          .list(
            {
              memoryLayer: layers,
              tags: input.tags
            },
            limit,
            cursor
          )
          .map((memory) => this.repos.memories.toListItem(memory));
    const rawTurns = timelineEpisodes
      ? timelineEpisodes
          .flatMap((episode) => this.repos.runtime.listRawTurnsByEpisode(episode.id, limit))
          .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))
          .slice(0, limit)
          .map(rawTurnSummary)
      : undefined;
    const nextCursor = items.length === limit
      ? String(cursor + items.length)
      : undefined;
    return {
      sessionId: input.sessionId ?? scopedEpisode?.sessionId,
      episodeId: input.episodeId,
      traces: items,
      rawTurns,
      items,
      nextCursor,
      serverTime: nowIso()
    };
  }

  private timelineItemsFromEpisodes(
    episodes: EpisodeRecord[],
    layers: MemoryLayer[],
    tags: string[] | undefined,
    limit: number,
    cursor: number
  ): MemoryListItem[] {
    const layerSet = new Set(layers);
    const memoryIds = dedupeStrings(episodes.flatMap((episode) => timelineMemoryIdsForEpisode(episode, layerSet)));
    const layerFilter = new Set(layers);
    return this.repos.memories
      .getMany(memoryIds)
      .filter((memory) => layerFilter.has(memory.memoryLayer))
      .filter((memory) => memoryMatchesTags(memory, tags))
      .sort((a, b) => traceSortKey(a) - traceSortKey(b) || a.id.localeCompare(b.id))
      .slice(cursor, cursor + limit)
      .map((memory) => this.repos.memories.toListItem(memory));
  }

  getMemory(id: string, request: RequestEnvelope = {}): MemoryGetResponse {
    this.assertMemorySearchEnabled();
    const idKind = readableMemoryIdKind(id);
    if (idKind === "episode") {
      return this.getEpisodeMemory(id, request);
    }
    if (idKind === "raw") {
      throw new MemoryServiceError("invalid_argument", "raw turn ids are internal; use the containing trace_ or episode_ id");
    }
    const memory = this.repos.memories.get(id);
    if (!memory) {
      throw new MemoryServiceError("not_found", `memory not found: ${id}`);
    }
    this.assertMemoryInScope(memory, request.namespace);
    const processing = this.repos.processing.get(memory.id);
    const detail = detailFromMemory(memory, processing);
    const refs = this.refsForMemory(memory);
    const item = memoryDetailWithLayerPayload(detail, memory);
    return {
      ...item,
      item,
      refs,
      version: memory.version,
      etag: memoryEtag(memory),
      metadata: {
        ...item.metadata,
        refs
      }
    };
  }

  private getEpisodeMemory(id: string, request: RequestEnvelope = {}): EpisodeDetailItem & {
    item: EpisodeDetailItem;
    refs: Record<string, unknown>;
    etag: string;
  } {
    const episode = this.requireEpisode(id);
    this.assertEpisodeInScope(episode, request.namespace);
    const session = this.requireSession(episode.sessionId);
    const namespace = request.namespace ?? namespaceForSession(session);
    const timeline = this.timeline({
      ...request,
      namespace,
      episodeId: id,
      layers: ["L1", "L2", "L3", "Skill"],
      limit: 100
    });
    const sourceMemoryIds = uniq([
      ...episode.l1MemoryIds,
      ...episode.l2PolicyIds,
      ...episode.l3WorldModelIds,
      ...episode.skillMemoryIds
    ]);
    const refs = {
      episode,
      rawTurns: timeline.rawTurns ?? [],
      timeline: timeline.items,
      traceMemoryIds: episode.l1MemoryIds,
      policyMemoryIds: episode.l2PolicyIds,
      worldModelMemoryIds: episode.l3WorldModelIds,
      skillMemoryIds: episode.skillMemoryIds,
      feedbackIds: episode.feedbackIds,
      decisionRepairIds: episode.decisionRepairIds
    };
    const item = episodeDetailItem(episode, timeline, sourceMemoryIds, refs);
    return {
      ...item,
      item,
      refs,
      etag: `episode:${episode.id}:v${item.version}:${stableHash({
        updatedAt: episode.updatedAt,
        sourceMemoryIds
      }).slice(0, 12)}`,
      metadata: {
        ...item.metadata,
        refs
      }
    };
  }

  async worldModelQuery(input: InternalMemorySearchRequest): Promise<{
    hits: RecallHit[];
    queried: {
      query: string;
      tags: string[];
      limit: number;
    };
    worldModels: Array<RecallHit & {
      body: string;
      sourceMemoryIds: string[];
    }>;
    injectedContext: InjectedContext;
    status: string[];
    serverTime: string;
  }> {
    this.assertMemorySearchEnabled();
    const result = await this.search({
      ...input,
      layers: ["L3"],
      includeInjectedContext: true,
      retrievalMode: "world_model"
    });
    const memories = this.repos.memories.getMany(result.hits.map((hit) => hit.id));
    const byId = new Map(memories.map((memory) => [memory.id, memory]));
    return {
      hits: result.hits,
      queried: {
        query: input.query,
        tags: input.tags ?? [],
        limit: input.limit ?? 8
      },
      worldModels: result.hits.map((hit) => {
        const memory = byId.get(hit.id);
        return {
          ...hit,
          body: memory?.memoryValue ?? hit.snippet,
          sourceMemoryIds: memory ? sourceMemoryIdsFromMemory(memory) : []
        };
      }),
      injectedContext: result.injectedContext,
      status: result.status,
      serverTime: nowIso()
    };
  }

  listSkills(input: RequestEnvelope & {
    userId?: string;
    q?: string;
    tags?: string[];
    limit?: number;
    cursor?: number;
  } = {}): {
    skills: Array<MemoryListItem & {
      name: string;
      invocationGuide?: string;
      reliabilityScore?: number;
      successRate?: number;
      betaPosterior?: {
        alpha: number;
        beta: number;
        mean: number;
      };
      utilityScore?: number;
      evidenceCount?: number;
      lastUsedAt?: string;
    }>;
    items: MemoryListItem[];
    nextCursor?: string;
    serverTime: string;
  } {
    this.assertMemorySearchEnabled();
    const limit = input.limit ?? 50;
    const cursor = input.cursor ?? 0;
    const filter: MemoryFilter = {
      memoryLayer: "Skill",
      status: ["activated", "resolving"],
      tags: input.tags
    };
    const poolLimit = Math.max(limit + cursor + 1, limit, 50);
    const memories = input.q?.trim()
      ? this.repos.memories.getMany(
          this.repos.memories.search(input.q, filter, poolLimit).map((hit) => hit.id)
        )
      : this.repos.memories.list(filter, poolLimit);
    const page = memories.slice(cursor, cursor + limit);
    const nextCursor = memories.length > cursor + limit ? String(cursor + limit) : undefined;
    const items = page.map((memory) => this.repos.memories.toListItem(memory));
    return {
      skills: page.map((memory) =>
        skillListItem(this.repos.memories.toListItem(memory), memory, this.skillUsageStats(memory.id))
      ),
      items,
      nextCursor,
      serverTime: nowIso()
    };
  }

  getSkill(skillId: string, request: RequestEnvelope = {}): MemoryDetailItem & {
    name: string;
    invocationGuide: string;
    procedure?: string[];
    sourcePolicyIds: string[];
    sourceWorldModelIds: string[];
    evidenceAnchorIds: string[];
    reliability: {
      eta: number;
      supportCount: number;
      usageCount: number;
      lastUsedAt?: string;
      pendingTrials: number;
      successRate: number;
      betaPosterior: {
        alpha: number;
        beta: number;
        mean: number;
      };
      trialsAttempted: number;
      trialsPassed: number;
    };
  } {
    this.assertMemorySearchEnabled();
    const memory = this.repos.memories.get(skillId);
    if (!memory || memory.memoryLayer !== "Skill") {
      throw new MemoryServiceError("not_found", `skill not found: ${skillId}`);
    }
    this.assertMemoryInScope(memory, request.namespace);
    const detail = detailFromMemory(memory);
    const skill = skillMetaFromMemory(memory);
    const usageStats = this.skillUsageStats(skillId);
    const trialsAttempted = usageStats.trialsAttempted || skill?.trialsAttempted || 0;
    const trialsPassed = usageStats.trialsAttempted ? usageStats.trialsPassed : skill?.trialsPassed ?? 0;
    return {
      ...detail,
      name: skill?.name ?? detail.title,
      invocationGuide: skill?.invocationGuide ?? detail.body,
      procedure: procedureFromSkillMemory(memory),
      sourcePolicyIds: skill?.sourcePolicyIds ?? [],
      sourceWorldModelIds: skill?.sourceWorldModelIds ?? [],
      evidenceAnchorIds: skill?.evidenceAnchorIds ?? [],
      reliability: {
        eta: skill?.eta ?? 0,
        supportCount: skill?.support ?? 0,
        usageCount: usageStats.usageCount,
        lastUsedAt: usageStats.lastUsedAt,
        pendingTrials: usageStats.pendingTrials,
        successRate: usageStats.trialsAttempted ? usageStats.successRate : skill?.successRate ?? 0,
        betaPosterior: usageStats.trialsAttempted
          ? usageStats.betaPosterior
          : skill?.betaPosterior ?? skillBetaPosterior(0, 0),
        trialsAttempted,
        trialsPassed
      }
    };
  }

  private skillUsageStats(skillId: string): SkillUsageStats {
    const trials = this.repos.runtime.listSkillTrials({ skillMemoryId: skillId, limit: 1000 });
    const resolved = trials.filter((trial) => trial.outcome !== "unknown");
    const passed = resolved.filter((trial) => trial.outcome === "success").length;
    return {
      usageCount: trials.length,
      lastUsedAt: trials[0]?.createdAt,
      pendingTrials: trials.filter((trial) => trial.status === "pending").length,
      trialsAttempted: resolved.length,
      trialsPassed: passed,
      successRate: skillSuccessRate(resolved.length, passed),
      betaPosterior: skillBetaPosterior(resolved.length, passed)
    };
  }

  useSkill(skillId: string, request: SkillUseRequest): {
    skillId: string;
    trialId: string;
    status: "pending";
    changeSeq: number;
    syncCursor: string;
    serverTime: string;
    duplicate?: boolean;
  } {
    this.assertMemoryAddEnabled();
    const idempotencyKey = request.adapterId && request.requestId
      ? `skill.use:${request.adapterId}:${request.requestId}`
      : undefined;
    const requestHash = stableHash({ skillId, request });
    if (idempotencyKey) {
      const existing = this.repos.runtime.getIdempotency(idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new MemoryServiceError("conflict", "idempotency key reused with different skill.use request body");
        }
        const body = existing.response as {
          skillId: string;
          trialId: string;
          status: "pending";
          changeSeq: number;
          syncCursor: string;
          serverTime: string;
          duplicate?: boolean;
        };
        return {
          ...body,
          duplicate: true
        };
      }
    }
    const skill = this.repos.memories.get(skillId);
    if (!skill || skill.memoryLayer !== "Skill") {
      throw new MemoryServiceError("not_found", `skill not found: ${skillId}`);
    }
    if (skill.status !== "activated" && skill.status !== "resolving") {
      throw new MemoryServiceError("conflict", `skill is not invokable in status ${skill.status}`);
    }
    const session = this.requireOpenSession(request.sessionId);
    this.assertSessionInScope(session, request.namespace);
    this.assertMemoryInScope(skill, request.namespace);
    const episode = this.ensureEpisode(session, request.episodeId);
    const trialEvidence = this.resolveSkillTrialEvidence(request, session, episode);
    const existingPendingTrial = this.repos.runtime.listSkillTrials({
      userId: session.userId,
      skillMemoryId: skill.id,
      episodeId: episode.id,
      status: "pending",
      limit: 1
    })[0];
    if (existingPendingTrial) {
      const changeSeq = this.repos.runtime.latestChangeSeq(session.userId, namespaceIdFromMemory(skill));
      const body = {
        skillId,
        trialId: existingPendingTrial.id,
        status: "pending" as const,
        changeSeq,
        syncCursor: this.encodeChangeCursor(changeSeq, namespaceForSession(session)),
        serverTime: nowIso(),
        duplicate: true
      };
      if (idempotencyKey) {
        this.repos.runtime.saveIdempotency(idempotencyKey, requestHash, body);
      }
      return body;
    }
    const trialId = newId("trial");
    const trial = this.repos.runtime.insertSkillTrial({
      id: trialId,
      userId: session.userId,
      projectId: session.projectId,
      skillMemoryId: skill.id,
      sessionId: session.id,
      episodeId: episode.id,
      l1MemoryId: trialEvidence.l1MemoryId,
      rawTurnId: request.rawTurnId ?? trialEvidence.rawTurnId,
      turnId: request.turnId,
      toolCallId: request.toolCallId,
      status: "pending",
      outcome: "unknown",
      createdAt: nowIso()
    });
    this.repos.runtime.appendEpisodeDerivedMemory(episode.id, "Skill", skill.id, trial.createdAt);
    const changeSeq = this.repos.runtime.appendChange({
      memoryId: skill.id,
      namespaceId: namespaceIdFromMemory(skill),
      kind: "skill_trial",
      op: "created",
      entityId: trial.id,
      userId: session.userId,
      changeType: "skill_trial",
      after: trial,
      source: "skill.use",
      createdAt: trial.createdAt
    });
    const body = {
      skillId,
      trialId,
      status: "pending" as const,
      changeSeq,
      syncCursor: this.encodeChangeCursor(changeSeq, namespaceForSession(session)),
      serverTime: nowIso()
    };
    if (idempotencyKey) {
      this.repos.runtime.saveIdempotency(idempotencyKey, requestHash, body);
    }
    return body;
  }

  async feedback(request: FeedbackRequest): Promise<FeedbackResponse> {
    if (!this.memoryAddEnabled()) {
      return this.feedbackNoWrite(request);
    }
    const idempotencyKey = request.adapterId && request.requestId
      ? `feedback.add:${request.adapterId}:${request.requestId}`
      : undefined;
    const requestHash = stableHash({ request });
    if (idempotencyKey) {
      const existing = this.repos.runtime.getIdempotency(idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new MemoryServiceError("conflict", "idempotency key reused with different feedback request body");
        }
        const body = existing.response as FeedbackResponse;
        return {
          ...body,
          duplicate: true
        };
      }
    }
    const context = this.resolveFeedbackContext(request);
    const attribution = this.resolveFeedbackAttribution(request, context);
    const attributedRequest: FeedbackRequest = {
      ...request,
      l1MemoryId: request.l1MemoryId ?? attribution.l1MemoryId,
      rawTurnId: request.rawTurnId ?? attribution.rawTurnId,
      episodeId: request.episodeId ?? attribution.episodeId,
      sessionId: request.sessionId ?? attribution.sessionId
    };
    const recallOutcome = recallOutcomeFromFeedback(request);
    let recallEvent: RecallEventRecord | undefined;
    if (request.recallEventId) {
      recallEvent = this.repos.runtime.getRecallEvent(request.recallEventId);
      if (!recallEvent) {
        throw new MemoryServiceError("not_found", `recall event not found: ${request.recallEventId}`);
      }
    }
    const feedbackId = newId("feedback");
    const feedbackContextHash = this.feedbackContextHash(attributedRequest, context);
    const feedback = this.repos.runtime.insertFeedback({
      id: feedbackId,
      userId: context.userId,
      projectId: context.namespace.projectId ?? context.namespace.workspaceId,
      conversationId: context.conversationId,
      sessionId: attributedRequest.sessionId,
      episodeId: attributedRequest.episodeId,
      l1MemoryId: attributedRequest.l1MemoryId,
      rawTurnId: attributedRequest.rawTurnId,
      channel: request.channel,
      polarity: request.polarity,
      magnitude: request.magnitude ?? 1,
      rationale: request.rationale,
      rawPayload: request.rawPayload ?? {},
      contextHash: feedbackContextHash,
      createdAt: nowIso()
    });
    if (feedback.episodeId) {
      this.repos.runtime.appendEpisodeFeedback(feedback.episodeId, feedback.id, feedback.createdAt);
    }
    const repairDraft = await this.maybeSynthesizeFeedbackDecisionRepair(
      attributedRequest,
      feedback,
      feedbackContextHash
    );
    const repair = this.maybeCreateDecisionRepair(
      attributedRequest,
      feedback,
      feedbackContextHash,
      namespaceIdFromContext(context.namespace),
      repairDraft
    );
    const updatedRecallEvent = recallEvent && recallOutcome
      ? this.repos.runtime.updateRecallEventOutcome(recallEvent.id, recallOutcome)
      : undefined;
    if (updatedRecallEvent) {
      this.applyRecallOutcome(updatedRecallEvent, feedback, feedback.createdAt);
    }
    const jobs: EvolutionJobRecord[] = [];
    jobs.push(...await this.maybeCreateFeedbackExperience(attributedRequest, feedback, context));
    if (attributedRequest.l1MemoryId || attributedRequest.episodeId) {
      jobs.push(
        this.enqueueJob({
          jobType: "reward",
          userId: context.userId,
          sessionId: attributedRequest.sessionId,
          episodeId: attributedRequest.episodeId,
          payload: {
            feedbackId: feedback.id,
            ...(attributedRequest.l1MemoryId ? { l1MemoryId: attributedRequest.l1MemoryId } : {}),
            channel: feedback.channel,
            polarity: feedback.polarity,
            magnitude: feedback.magnitude,
            rationale: feedback.rationale,
            trigger: feedback.channel === "implicit" ? "implicit_feedback" : "explicit_feedback"
          }
        })
      );
    }
    for (const trial of this.pendingTrialsForFeedback(feedback)) {
      jobs.push(this.enqueueJob({
        jobType: "skill_trial_resolve",
        userId: context.userId,
        sessionId: trial.sessionId,
        episodeId: trial.episodeId,
        payload: {
          trialId: trial.id,
          feedbackId: feedback.id,
          targetKind: "skill_trial",
          rawTurnId: trial.rawTurnId,
          turnId: trial.turnId
        }
      }));
    }
    const changeSeq = this.repos.runtime.appendChange({
      memoryId: attributedRequest.l1MemoryId ?? attributedRequest.rawTurnId ?? feedback.id,
      namespaceId: namespaceIdFromContext(context.namespace),
      kind: "feedback",
      op: "created",
      entityId: feedback.id,
      userId: context.userId,
      changeType: "feedback",
      after: feedback,
      source: "feedback.add",
      createdAt: feedback.createdAt
    });
    const body = {
      id: feedbackId,
      ts: feedback.createdAt,
      channel: feedback.channel,
      polarity: feedback.polarity,
      magnitude: feedback.magnitude,
      scheduledEvolution: jobs.length > 0,
      changeSeq,
      syncCursor: this.encodeChangeCursor(changeSeq, context.namespace),
      feedbackId,
      recallEventId: updatedRecallEvent?.id,
      recallOutcome: updatedRecallEvent?.outcome,
      repair,
      jobs: jobs.map(jobToRef),
      serverTime: nowIso()
    };
    if (idempotencyKey) {
      this.repos.runtime.saveIdempotency(idempotencyKey, requestHash, body);
    }
    return body;
  }

  exportBundle(request: MemoryExportRequest = {}): {
    schemaVersion: number;
    exportedAt: string;
    manifest: {
      service: string;
      includeRawText: boolean;
      includeAudit: boolean;
      backend: StorageBackendCapabilities["backend"];
      tables: string[];
    };
    tables: Record<string, Array<Record<string, unknown>>>;
    serverTime: string;
  } {
    this.assertMemorySearchEnabled();
    const context = this.resolveContext(request);
    const tables = scopeBundleTables(
      this.repos.runtime.exportBundleTables(request.includeRawText === true),
      context.namespace
    );
    tables.memory_vectors = this.repos.vectors.exportRows().map((row) => ({ ...row }));
    if (request.includeAudit === false) {
      delete tables.audit_logs;
    }
    if (this.memoryAddEnabled()) {
      this.repos.runtime.insertAudit({
        userId: context.userId,
        actor: request.namespace ? { ...request.namespace } : {},
        action: "export",
        targetKind: "bundle",
        targetId: `export_${stableHash(nowIso()).slice(0, 16)}`,
        meta: {
          includeRawText: request.includeRawText === true,
          includeAudit: request.includeAudit !== false,
          tables: Object.keys(tables)
        },
        createdAt: nowIso()
      });
    }
    return {
      schemaVersion: this.schemaVersion().version,
      exportedAt: nowIso(),
      manifest: {
        service: "memmy-memory-service",
        includeRawText: request.includeRawText === true,
        includeAudit: request.includeAudit !== false,
        backend: this.storageCapabilities().backend,
        tables: Object.keys(tables)
      },
      tables,
      serverTime: nowIso()
    };
  }

  importBundle(request: MemoryImportRequest): {
    ok: true;
    importedAt: string;
    conflictStrategy: "skip" | "replace" | "error";
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
    reembedMemoryIds: string[];
    auditId: string;
    serverTime: string;
  } {
    this.assertMemoryAddEnabled();
    if (!request.bundle || !request.bundle.tables || typeof request.bundle.tables !== "object") {
      throw new MemoryServiceError("invalid_argument", "import bundle must contain tables");
    }
    const context = this.resolveContext(request);
    const importedAt = nowIso();
    const result = this.repos.runtime.importBundleTables(request.bundle.tables, {
      conflictStrategy: request.conflictStrategy ?? "skip"
    });
    const importedVectors = importedMemoryVectors(request.bundle.tables.memory_vectors);
    this.repos.vectors.importRows(importedVectors);
    result.inserted.memory_vectors = importedVectors.length;
    const reembedMemoryIds = importedReembedMemoryIds(
      request.bundle.tables,
      this.embedder.config.model ?? this.embedder.config.provider
    );
    const audit = this.repos.runtime.insertAudit({
      userId: context.userId,
      actor: request.namespace ? { ...request.namespace } : {},
      action: "import",
      targetKind: "bundle",
      targetId: `import_${stableHash(importedAt).slice(0, 16)}`,
      meta: {
        sourceSchemaVersion: request.bundle.schemaVersion,
        sourceExportedAt: request.bundle.exportedAt,
        conflictStrategy: request.conflictStrategy ?? "skip",
        inserted: result.inserted,
        skipped: result.skipped,
        replaced: result.replaced,
        migrationMap: result.migrationMap,
        conflicts: result.conflicts,
        reembedMemoryIds
      },
      createdAt: importedAt
    });
    return {
      ok: true,
      importedAt,
      conflictStrategy: request.conflictStrategy ?? "skip",
      inserted: result.inserted,
      skipped: result.skipped,
      replaced: result.replaced,
      migrationMap: result.migrationMap,
      conflicts: result.conflicts,
      reembedMemoryIds,
      auditId: audit.id,
      serverTime: nowIso()
    };
  }

  archiveMemory(id: string, request: MemoryGovernanceRequest = {}): {
    ok: true;
    id: string;
    kind: MemoryKind;
    status: "archived";
    changeSeq: number;
    syncCursor: string;
    auditId: string;
    serverTime: string;
  } {
    this.assertMemoryAddEnabled();
    const memory = this.requireExistingMemory(id);
    this.assertMemoryInScope(memory, request.namespace);
    const kind = kindFromMemory(memory);
    const archived = this.repos.memories.archive(memory.id, nowIso());
    if (!archived) {
      throw new MemoryServiceError("not_found", `memory not found: ${id}`);
    }
    const changeSeq = this.repos.runtime.appendChange({
      memoryId: archived.id,
      namespaceId: namespaceIdFromMemory(archived),
      kind: kindFromMemory(archived),
      op: "archived",
      entityId: archived.id,
      userId: archived.userId,
      changeType: "archive",
      version: archived.version,
      before: memory,
      after: archived,
      source: "panel.archive",
      createdAt: archived.updatedAt
    });
    const audit = this.repos.runtime.insertAudit({
      userId: archived.userId,
      sessionId: archived.sessionId,
      actor: request.namespace ? { ...request.namespace } : {},
      action: "archive",
      targetKind: kindFromMemory(archived),
      targetId: archived.id,
      before: memory,
      after: archived,
      meta: { reason: request.reason },
      createdAt: archived.updatedAt
    });
    return {
      ok: true,
      id: archived.id,
      kind: kindFromMemory(archived),
      status: "archived",
      changeSeq,
      syncCursor: this.encodeChangeCursor(changeSeq, request.namespace ?? namespaceForMemory(archived)),
      auditId: audit.id,
      serverTime: nowIso()
    };
  }

  deleteMemory(id: string, request: MemoryGovernanceRequest = {}): {
    ok: true;
    id: string;
    kind: MemoryKind;
    status: "deleted";
    changeSeq: number;
    syncCursor: string;
    auditId: string;
    serverTime: string;
  } {
    this.assertMemoryAddEnabled();
    const memory = this.requireExistingMemory(id);
    this.assertMemoryInScope(memory, request.namespace);
    const kind = kindFromMemory(memory);
    const deleted = this.repos.memories.softDelete(memory.id, nowIso());
    if (!deleted) {
      throw new MemoryServiceError("not_found", `memory not found: ${id}`);
    }
    const changeSeq = this.repos.runtime.appendChange({
      memoryId: deleted.id,
      namespaceId: namespaceIdFromMemory(deleted),
      kind: kindFromMemory(deleted),
      op: "deleted",
      entityId: deleted.id,
      userId: deleted.userId,
      changeType: "delete",
      version: deleted.version,
      before: memory,
      after: deleted,
      source: "panel.delete",
      createdAt: deleted.updatedAt
    });
    const audit = this.repos.runtime.insertAudit({
      userId: deleted.userId,
      sessionId: deleted.sessionId,
      actor: request.namespace ? { ...request.namespace } : {},
      action: "delete",
      targetKind: kindFromMemory(deleted),
      targetId: deleted.id,
      before: memory,
      after: deleted,
      meta: { reason: request.reason },
      createdAt: deleted.updatedAt
    });
    return {
      ok: true,
      id: deleted.id,
      kind: kindFromMemory(deleted),
      status: "deleted",
      changeSeq,
      syncCursor: this.encodeChangeCursor(changeSeq, request.namespace ?? namespaceForMemory(deleted)),
      auditId: audit.id,
      serverTime: nowIso()
    };
  }

  deletePanelTask(id: string, request: MemoryGovernanceRequest = {}): {
    ok: true;
    id: string;
    deletedMemoryIds: string[];
    serverTime: string;
  } {
    this.assertMemoryAddEnabled();
    const episode = this.requireEpisode(id);
    this.assertEpisodeInScope(episode, request.namespace);
    const deletedMemoryIds: string[] = [];

    this.repos.transaction(() => {
      for (const memoryId of episode.l1MemoryIds) {
        if (!this.repos.memories.get(memoryId)) continue;
        this.deleteMemory(memoryId, request);
        deletedMemoryIds.push(memoryId);
      }
      if (!this.repos.runtime.deleteEpisode(id)) {
        throw new MemoryServiceError("not_found", `episode not found: ${id}`);
      }
    });

    return {
      ok: true,
      id,
      deletedMemoryIds,
      serverTime: nowIso()
    };
  }

  redactRawTurn(rawTurnId: string, request: RawTurnRedactRequest = {}): {
    ok: true;
    rawTurnId: string;
    mode: "redact" | "delete";
    changeSeq: number;
    syncCursor: string;
    auditId: string;
    serverTime: string;
  } {
    this.assertMemoryAddEnabled();
    const rawTurn = this.repos.runtime.getRawTurn(rawTurnId);
    if (!rawTurn) {
      throw new MemoryServiceError("not_found", `raw turn not found: ${rawTurnId}`);
    }
    this.assertRawTurnInScope(rawTurn, request.namespace);
    const session = this.repos.runtime.getSession(rawTurn.sessionId);
    const rawTurnNamespace = session ? namespaceForSession(session) : namespaceForRawTurn(rawTurn);
    const at = nowIso();
    const mode = request.mode ?? "redact";
    const redacted: RawTurnRecord = {
      ...rawTurn,
      userText: undefined,
      assistantText: undefined,
      reasoningSummary: undefined,
      toolCalls: [],
      toolResults: [],
      messagePayload: {
        ...(rawTurn.messagePayload ?? {}),
        governance: {
          redacted: true,
          mode,
          reason: request.reason,
          at
        }
      },
      status: mode === "delete" ? "deleted" : rawTurn.status,
      redactedAt: at,
      deletedAt: mode === "delete" ? at : rawTurn.deletedAt
    };
    this.repos.runtime.updateRawTurn(redacted);
    const changeSeq = this.repos.runtime.appendChange({
      memoryId: rawTurn.id,
      namespaceId: namespaceIdFromContext(rawTurnNamespace),
      kind: "raw_turn",
      op: mode === "delete" ? "deleted" : "updated",
      entityId: rawTurn.id,
      userId: rawTurn.userId,
      changeType: mode === "delete" ? "raw_turn_delete" : "raw_turn_redact",
      before: rawTurn,
      after: redacted,
      source: "panel.raw_redact",
      createdAt: at
    });
    const audit = this.repos.runtime.insertAudit({
      userId: rawTurn.userId,
      sessionId: rawTurn.sessionId,
      actor: request.namespace ? { ...request.namespace } : {},
      action: mode === "delete" ? "raw_delete" : "raw_redact",
      targetKind: "raw_turn",
      targetId: rawTurn.id,
      before: rawTurnSummary(rawTurn),
      after: rawTurnSummary(redacted),
      meta: { reason: request.reason },
      createdAt: at
    });
    return {
      ok: true,
      rawTurnId: rawTurn.id,
      mode,
      changeSeq,
      syncCursor: this.encodeChangeCursor(changeSeq, request.namespace ?? rawTurnNamespace),
      auditId: audit.id,
      serverTime: nowIso()
    };
  }

  auditLogs(input: RequestEnvelope & {
    userId?: string;
    targetKind?: string;
    targetId?: string;
    limit?: number;
  } = {}): {
    items: ReturnType<Repositories["runtime"]["listAudit"]>;
    serverTime: string;
  } {
    const userId = input.userId ?? this.resolveContext(input).userId;
    return {
      items: this.repos.runtime.listAudit({
        userId,
        targetKind: input.targetKind,
        targetId: input.targetId,
        limit: input.limit
      }),
      serverTime: nowIso()
    };
  }

  serviceLogs(input: RequestEnvelope & {
    userId?: string;
    limit?: number;
    cursor?: string;
  } = {}): {
    cursor: string;
    entries: Array<{
      type: "change" | "audit" | "job";
      id: string;
      at: string;
      userId?: string;
      action: string;
      targetKind?: string;
      targetId?: string;
      source?: string;
      payload?: unknown;
    }>;
    changes: ReturnType<MemoryService["panelChanges"]>["changes"];
    audits: ReturnType<Repositories["runtime"]["listAudit"]>;
    jobs: EvolutionJobRecord[];
    serverTime: string;
  } {
    const limit = input.limit ?? 50;
    const changes = this.panelChanges({
      namespace: input.namespace,
      limit,
      cursor: input.cursor
    });
    const audits = this.repos.runtime.listAudit({
      limit
    });
    const jobs = [
      ...this.repos.runtime.listJobs("failed", limit),
      ...this.repos.runtime.listJobs("dead_letter", limit)
    ].slice(0, limit);
    const entries = [
      ...changes.items.map((change) => ({
        type: "change" as const,
        id: String(change.seq),
        at: change.createdAt,
        userId: change.userId,
        action: `${change.kind}.${change.op}`,
        targetKind: change.kind,
        targetId: change.entityId,
        source: change.source,
        payload: changeLogToPanelChange(change)
      })),
      ...audits.map((audit) => ({
        type: "audit" as const,
        id: audit.id,
        at: audit.createdAt,
        userId: audit.userId,
        action: audit.action,
        targetKind: audit.targetKind,
        targetId: audit.targetId,
        source: "audit",
        payload: audit
      })),
      ...jobs.map((job) => ({
        type: "job" as const,
        id: job.id,
        at: job.updatedAt,
        userId: job.userId,
        action: `job.${job.status}`,
        targetKind: job.jobType,
        targetId: job.targetMemoryId,
        source: "worker",
        payload: job
      }))
    ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
    return {
      cursor: changes.cursor,
      entries,
      changes: changes.changes,
      audits,
      jobs,
      serverTime: nowIso()
    };
  }

  apiLogs(input: {
    tools?: Array<"memory_add" | "memory_search" | "skill_generate" | "skill_evolve">;
    sourceAgent?: string;
    excludedSourceAgents?: string[];
    limit?: number;
    offset?: number;
  } = {}): {
    logs: ReturnType<Repositories["runtime"]["listApiLogs"]>["logs"];
    total: number;
    limit: number;
    offset: number;
    nextOffset?: number;
    serverTime: string;
  } {
    const limit = Math.max(1, Math.min(input.limit ?? 50, 500));
    const offset = Math.max(0, input.offset ?? 0);
    const result = this.repos.runtime.listApiLogs({
      toolNames: input.tools,
      sourceAgent: input.sourceAgent,
      excludedSourceAgents: input.excludedSourceAgents,
      limit,
      offset
    });
    return {
      logs: result.logs,
      total: result.total,
      limit,
      offset,
      nextOffset: offset + result.logs.length < result.total ? offset + result.logs.length : undefined,
      serverTime: nowIso()
    };
  }

  private recordApiLog(
    toolName: ApiLogRecord["toolName"],
    input: unknown,
    output: unknown,
    durationMs: number,
    success: boolean,
    calledAt = nowIso(),
    sourceAgent?: string
  ): void {
    this.repos.runtime.insertApiLog({
      toolName,
      sourceAgent: sourceAgent?.trim() || undefined,
      inputJson: JSON.stringify(input ?? {}),
      outputJson: JSON.stringify(output ?? {}),
      durationMs: Math.max(0, Math.round(durationMs)),
      success,
      calledAt
    });
  }

  serviceMetrics(input: RequestEnvelope & { userId?: string } = {}): {
    storage: StorageBackendCapabilities;
    schema: { version: number; lastMigrationId?: string };
    memory: ReturnType<MemoryService["panelOverview"]>["stats"];
    changeSeq: number;
    feedback: {
      recent: number;
    };
    jobs: Record<"queued" | "leased" | "succeeded" | "failed" | "dead_letter", number>;
    embeddingRetries: Record<"pending" | "in_progress" | "succeeded" | "failed", number>;
    models: HealthResponse["models"];
    serverTime: string;
  } {
    const overview = this.panelOverview(input);
    return {
      storage: this.storageCapabilities(),
      schema: this.schemaVersion(),
      memory: overview.stats,
      changeSeq: overview.latestChangeSeq,
      feedback: {
        recent: this.repos.runtime.listFeedback({ limit: 1000 }).length
      },
      jobs: overview.stats.jobs,
      embeddingRetries: overview.stats.embeddingRetries,
      models: {
        summary: this.llm.status(),
        evolution: this.skillLlm.status(),
        embedding: this.embedder.status()
      },
      serverTime: nowIso()
    };
  }

  adminStatus(input: RequestEnvelope & { userId?: string } = {}, routes: string[] = []): {
    health: HealthResponse;
    overview: ReturnType<MemoryService["panelOverview"]>;
    failedJobs: EvolutionJobRecord[];
    deadLetterJobs: EvolutionJobRecord[];
    serverTime: string;
  } {
    return {
      health: this.health(routes),
      overview: this.panelOverview(input),
      failedJobs: this.repos.runtime.listJobs("failed", 20),
      deadLetterJobs: this.repos.runtime.listJobs("dead_letter", 20),
      serverTime: nowIso()
    };
  }

  configStatus(_input: RequestEnvelope = {}): {
    version: number;
    config: MemmyConfig;
    redacted: boolean;
    serverTime: string;
  } {
    return {
      version: this.config.version,
      config: redactConfig(this.config) as MemmyConfig,
      redacted: true,
      serverTime: nowIso()
    };
  }

  panelOverview(input: RequestEnvelope & { userId?: string } = {}): {
    stats: {
      byLayer: Record<MemoryLayer, number>;
      byStatus: Record<"activated" | "resolving" | "archived" | "deleted", number>;
      episodes: Record<"open" | "processing" | "closed", number>;
      jobs: Record<"queued" | "leased" | "succeeded" | "failed" | "dead_letter", number>;
      embeddingRetries: Record<"pending" | "in_progress" | "succeeded" | "failed", number>;
      lastChangeSeq?: number;
    };
    counts: Record<MemoryLayer, number>;
    queuedJobs: number;
    latestChangeSeq: number;
    cursor: string;
    etag: string;
    serverTime: string;
  } {
    const byLayer = this.memoryLayerCounts();
    const byStatus = this.memoryStatusCounts();
    const latestChangeSeq = this.repos.runtime.latestChangeSeq();
    const jobs = this.jobStatusCounts();
    const embeddingRetries = this.embeddingRetryStatusCounts();
    return {
      stats: {
        byLayer,
        byStatus,
        episodes: this.episodeStatusCounts(),
        jobs,
        embeddingRetries,
        lastChangeSeq: latestChangeSeq || undefined
      },
      counts: byLayer,
      queuedJobs: jobs.queued,
      latestChangeSeq,
      cursor: this.encodeChangeCursor(latestChangeSeq),
      etag: `panel-overview-v${latestChangeSeq}`,
      serverTime: nowIso()
    };
  }

  panelOverviewSummary(input: RequestEnvelope & { userId?: string } = {}): {
    counts: {
      memories: number;
      skills: number;
      experiences: number;
      worldModels: number;
    };
    sourceDistribution: Array<{
      source: string;
      count: number;
      percentage: number;
    }>;
    dailyActivity: Array<{ date: string; count: number }>;
  } {
    const memories = this.listAllMemoriesForStats();
    const dates = panelDateKeys(nowIso(), PANEL_DAILY_ACTIVITY_DAYS);

    return {
      counts: {
        memories: memories.filter((memory) => memory.memoryLayer === "L1").length,
        skills: memories.filter((memory) => memory.memoryLayer === "Skill").length,
        experiences: memories.filter((memory) => memory.memoryLayer === "L2").length,
        worldModels: memories.filter((memory) => memory.memoryLayer === "L3").length
      },
      dailyActivity: panelCountByDate(memories, dates, (memory) => memory.createdAt),
      sourceDistribution: panelSourceDistribution(memories)
    };
  }

  panelAnalysis(input: RequestEnvelope & { userId?: string } = {}): {
    metrics: {
      avgRecallScore: number;
      recallEvents: number;
      activeSkills: number;
      recentlyUsedSkills: number;
      avgToolLatencyMs: number;
      p95ToolLatencyMs: number;
    };
    dailyMemoryWrites: Array<{ date: string; count: number }>;
    dailySkillEvolutions: Array<{ date: string; count: number }>;
    toolLatency: {
      tools: Array<{ name: string; calls: number; avgMs: number; p95Ms: number }>;
      series: Array<{ name: string; points: Array<{ date: string; avgMs: number }> }>;
    };
  } {
    const dates = panelLastSevenDateKeys(nowIso());
    const memories = this.listAllMemoriesForStats();
    const skillMemories = memories.filter((memory) => memory.memoryLayer === "Skill");
    const logs = this.repos.runtime.listApiLogs({ limit: 10_000, offset: 0 }).logs
      .filter((log) => dates.includes(panelDateKey(log.calledAt)));
    const recallScores = logs
      .filter((log) => log.toolName === "memory_search")
      .map((log) => panelRecallScore(log.outputJson))
      .filter((score): score is number => score !== undefined);
    const durations = logs.map((log) => Math.max(0, Math.round(log.durationMs)));

    return {
      metrics: {
        avgRecallScore: panelRoundDecimal(panelAverage(recallScores), 2),
        recallEvents: logs.filter((log) => log.toolName === "memory_search").length,
        activeSkills: skillMemories.filter((memory) => memory.status === "activated").length,
        recentlyUsedSkills: skillMemories.filter((memory) => dates.includes(panelDateKey(memory.updatedAt))).length,
        avgToolLatencyMs: panelRoundInt(panelAverage(durations)),
        p95ToolLatencyMs: panelPercentile95(durations)
      },
      dailyMemoryWrites: panelCountByDate(memories, dates, (memory) => memory.createdAt),
      dailySkillEvolutions: panelCountByDate(skillMemories, dates, (memory) => memory.updatedAt),
      toolLatency: panelToolLatency(logs, dates)
    };
  }

  panelItems(input: RequestEnvelope & {
    userId?: string;
    layer?: MemoryLayer;
    status?: "activated" | "resolving" | "archived" | "deleted";
    q?: string;
    tags?: string[];
    sourceAgent?: string;
    excludedSourceAgents?: string[];
    page?: number;
    limit?: number;
    cursor?: string | number;
  }): {
    items: MemoryListItem[];
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
    etag: string;
    nextCursor?: string;
    serverTime: string;
  } {
    const pageSize = normalizePanelItemsLimit(input.limit);
    const filter: MemoryFilter = {
      memoryLayer: input.layer,
      status: input.status,
      tags: input.tags,
      agentId: input.sourceAgent,
      excludedAgentIds: input.excludedSourceAgents
    };
    const total = input.q?.trim()
      ? this.repos.memories.searchCount(input.q, {
          ...filter,
          status: filter.status ?? ["activated", "resolving"]
        })
      : this.repos.memories.count(filter);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const requestedPage = normalizePageNumber(input.page);
    const page = Math.min(requestedPage, totalPages);
    const offset = normalizeOffsetCursor(input.cursor) ?? ((page - 1) * pageSize);
    if (input.q?.trim()) {
      const hits = this.repos.memories.searchPanelIds(input.q, {
        ...filter,
        status: filter.status ?? ["activated", "resolving"]
      }, pageSize, offset);
      const memories = this.repos.memories
        .getMany(hits.map((hit) => hit.id));
      return {
        items: memories.map((memory) => panelListItemFromMemory(
          this.repos.memories.toListItem(memory),
          memory,
          this.repos.processing.get(memory.id)
        )),
        page,
        pageSize,
        total,
        totalPages,
        hasNext: offset + memories.length < total,
        hasPrev: offset > 0,
        etag: `panel-items-v${this.repos.runtime.latestChangeSeq()}`,
        nextCursor: offset + memories.length < total ? String(offset + memories.length) : undefined,
        serverTime: nowIso()
      };
    }
    const memories = this.repos.memories
      .list(filter, pageSize, offset);
    return {
      items: memories.map((memory) => panelListItemFromMemory(
        this.repos.memories.toListItem(memory),
        memory,
        this.repos.processing.get(memory.id)
      )),
      page,
      pageSize,
      total,
      totalPages,
      hasNext: offset + memories.length < total,
      hasPrev: offset > 0,
      etag: `panel-items-v${this.repos.runtime.latestChangeSeq()}`,
      nextCursor: offset + memories.length < total ? String(offset + memories.length) : undefined,
      serverTime: nowIso()
    };
  }

  panelTasks(input: RequestEnvelope & { q?: string; page?: number }): {
    tasks: Array<{
      id: string;
      episode: Record<string, unknown>;
      memoryIds: string[];
      turns: ReturnType<typeof rawTurnSummary>[];
      updatedAt: string;
    }>;
    page: number;
    pageSize: 20;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
    serverTime: string;
  } {
    const pageSize = 20 as const;
    const query = input.q?.trim() || undefined;
    const userId = input.namespace?.userId;
    const total = this.repos.runtime.countEpisodes(userId, query);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(normalizePageNumber(input.page), totalPages);
    const episodes = this.repos.runtime.listEpisodes(userId, pageSize, (page - 1) * pageSize, query);

    return {
      tasks: episodes.map((episode) => ({
        id: episode.id,
        episode: episodeRef(episode),
        memoryIds: episode.l1MemoryIds.filter((memoryId) => Boolean(this.repos.memories.get(memoryId))),
        turns: this.repos.runtime.listRawTurnsByEpisode(episode.id, 1000).map(rawTurnSummary),
        updatedAt: episode.updatedAt
      })),
      page,
      pageSize,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
      serverTime: nowIso()
    };
  }

  panelChanges(input: RequestEnvelope & {
    userId?: string;
    limit?: number;
    cursor?: string;
  } = {}): {
    cursor: string;
    changes: Array<{
      seq: number;
      op: "created" | "updated" | "archived" | "deleted";
      kind: MemoryKind | "session" | "episode" | "job" | "feedback" | "raw_turn" | "repair" | "skill_trial" | "recall" | "artifact";
      id: string;
      version?: number;
      source: "turn_complete" | "feedback" | "worker" | "panel" | "system";
      updatedAt: string;
    }>;
    hasMore: boolean;
    items: ChangeLogRecord[];
    serverTime: string;
  } {
    const limit = input.limit ?? 50;
    const cursorSeq = this.decodeChangeCursor(input.cursor);
    const items = this.repos.runtime.listChanges(
      undefined,
      limit,
      cursorSeq
    );
    const lastSeq = items.reduce((max, item) => Math.max(max, item.seq), cursorSeq);
    return {
      cursor: this.encodeChangeCursor(lastSeq),
      changes: items.map(changeLogToPanelChange),
      hasMore: items.length === limit,
      items,
      serverTime: nowIso()
    };
  }

  panelJobs(input: RequestEnvelope & {
    userId?: string;
    status?: "queued" | "leased" | "succeeded" | "failed" | "dead_letter";
    limit?: number;
  } = {}): {
    jobs: Array<EvolutionJobRecord & {
      error?: {
        code: string;
        message: string;
      };
    }>;
    items: EvolutionJobRecord[];
    nextCursor?: string;
    serverTime: string;
  } {
    const items = this.repos.runtime.listJobs(input.status, input.limit ?? 50);
    return {
      jobs: items.map((job) => ({
        ...job,
        error: job.lastError ? { code: "worker_error", message: job.lastError } : undefined
      })),
      items,
      serverTime: nowIso()
    };
  }

  memoryProcessingStatus(memoryIds: readonly string[], request: RequestEnvelope = {}): {
    items: MemoryProcessingRecord[];
    serverTime: string;
  } {
    const ids = dedupeStrings(memoryIds).slice(0, 10_000);
    const memories = this.repos.memories.getMany(ids);
    for (const memory of memories) {
      this.assertMemoryInScope(memory, request.namespace);
    }
    return {
      items: this.repos.processing.getMany(ids),
      serverTime: nowIso()
    };
  }

  retryMemoryProcessing(memoryId: string, request: RequestEnvelope = {}): {
    accepted: boolean;
    processing: MemoryProcessingRecord;
    job?: JobRef;
    serverTime: string;
  } {
    this.assertMemoryAddEnabled();
    const memory = this.repos.memories.get(memoryId);
    if (!memory) {
      throw new MemoryServiceError("not_found", `memory not found: ${memoryId}`);
    }
    this.assertMemoryInScope(memory, request.namespace);
    const current = this.repos.processing.get(memoryId);
    if (!current) {
      throw new MemoryServiceError("invalid_argument", `memory has no asynchronous processing state: ${memoryId}`);
    }
    if (current.state !== "failed") {
      return {
        accepted: false,
        processing: current,
        serverTime: nowIso()
      };
    }
    if (current.retryAction === "none" || !current.stage) {
      throw new MemoryServiceError("conflict", current.errorMessage ?? "memory processing cannot be retried");
    }

    const at = nowIso();
    const result = this.repos.transaction(() => {
      const latest = this.repos.processing.get(memoryId);
      if (!latest || latest.state !== "failed" || !latest.stage) {
        return latest ? { accepted: false, processing: latest } : undefined;
      }
      const summaryJobType = memoryHasImportPipeline(memory) ? "import_summary" : "trace_summary";
      const job = this.enqueueJob({
        jobType: latest.stage === "summary" ? summaryJobType : "embedding",
        userId: memory.userId,
        sessionId: memory.sessionId,
        targetMemoryId: memory.id,
        payload: {
          source: "memory.processing.manual_retry",
          previousErrorCode: latest.errorCode ?? undefined,
          contentHash: memory.contentHash
        },
        maxAttempts: latest.stage === "summary" ? 3 : 6,
        createdAt: at
      });
      const processing = this.repos.processing.save({
        ...latest,
        state: latest.stage === "summary" ? "summary_pending" : "embedding_pending",
        activeJobId: job.id,
        attemptCount: 0,
        manualRetryCount: latest.manualRetryCount + 1,
        retryAction: "retry",
        errorCode: null,
        errorMessage: null,
        failedAt: null,
        updatedAt: at
      });
      return { accepted: true, processing, job: jobToRef(job) };
    });
    if (!result) {
      throw new MemoryServiceError("not_found", `processing state not found: ${memoryId}`);
    }
    return {
      ...result,
      serverTime: at
    };
  }

  private restartFailedProcessing(at: string, limit = 10000): number {
    if (!this.memoryAddEnabled()) return 0;
    let restarted = 0;
    const failedItems = this.repos.processing.listByStates(["failed"], limit);

    for (const failed of failedItems) {
      if (!failed.stage || failed.retryAction === "none") continue;
      const memory = this.repos.memories.get(failed.memoryId);
      if (!memory) continue;

      if (this.repos.memories.hasVector(memory.id, "vec_summary")) {
        this.repos.processing.update(memory.id, {
          state: "ready",
          stage: null,
          activeJobId: null,
          errorCode: null,
          errorMessage: null,
          failedAt: null,
          updatedAt: at
        }, ["failed"]);
        continue;
      }

      if (failed.stage === "embedding" && !this.config.algorithm.capture.embedAfterCapture) {
        this.repos.processing.update(memory.id, {
          state: "ready_text_only",
          stage: null,
          activeJobId: null,
          attemptCount: 0,
          retryAction: "retry",
          errorCode: null,
          errorMessage: null,
          failedAt: null,
          updatedAt: at
        }, ["failed"]);
        continue;
      }

      const result = this.repos.transaction(() => {
        const current = this.repos.processing.get(memory.id);
        if (!current || current.state !== "failed" || !current.stage || current.retryAction === "none") {
          return undefined;
        }
        const jobType = current.stage === "summary"
          ? memoryHasImportPipeline(memory) ? "import_summary" : "trace_summary"
          : "embedding";
        const job = this.enqueueJob({
          jobType,
          userId: memory.userId,
          sessionId: memory.sessionId,
          targetMemoryId: memory.id,
          payload: {
            source: "memory.processing.lifecycle_retry",
            previousErrorCode: current.errorCode ?? undefined,
            contentHash: memory.contentHash
          },
          maxAttempts: current.stage === "summary" ? 3 : 6,
          createdAt: at
        });
        const processing = this.repos.processing.save({
          ...current,
          state: current.stage === "summary" ? "summary_pending" : "embedding_pending",
          activeJobId: job.id,
          attemptCount: 0,
          retryAction: "retry",
          errorCode: null,
          errorMessage: null,
          failedAt: null,
          updatedAt: at
        });
        return { job, processing };
      });
      if (result) restarted += 1;
    }

    return restarted;
  }

  enqueuePendingImportSummaries(limit = 10000, targetMemoryIds?: readonly string[]): {
    enqueued: number;
    memoryIds: string[];
    serverTime: string;
  } {
    const targets = targetMemoryIds ? dedupeStrings(targetMemoryIds) : undefined;
    const memories = this.repos.memories.listPendingAgentSourceImportSummaries(limit, targets);
    for (const memory of memories) {
      this.repos.transaction(() => {
        const job = this.enqueueJob({
          jobType: "import_summary",
          userId: memory.userId,
          sessionId: memory.sessionId,
          targetMemoryId: memory.id,
          payload: {
            source: "agent_source.scan.summary_stage",
            contentHash: memory.contentHash
          },
          maxAttempts: 3,
          createdAt: memory.createdAt
        });
        this.repos.processing.update(memory.id, {
          activeJobId: job.id,
          updatedAt: nowIso()
        }, ["summary_pending"]);
      });
    }

    return {
      enqueued: memories.length,
      memoryIds: targets ?? this.repos.memories.listUnprocessedAgentSourceImports(limit).map((memory) => memory.id),
      serverTime: nowIso()
    };
  }

  nextWorkerRunAt(): number | undefined {
    return this.memoryAddEnabled() ? this.repos.runtime.nextWorkerRunAt() : undefined;
  }

  reconcileWorkerStartup(limit = 10000): {
    requeuedJobs: number;
    requeuedEmbeddingRetries: number;
    restartedFailedProcessing: number;
    enqueuedImportSummaries: number;
    enqueuedEmbeddingRepairs: number;
  } {
    if (!this.memoryAddEnabled()) {
      return {
        requeuedJobs: 0,
        requeuedEmbeddingRetries: 0,
        restartedFailedProcessing: 0,
        enqueuedImportSummaries: 0,
        enqueuedEmbeddingRepairs: 0
      };
    }

    const at = nowIso();
    const interruptedJobs = this.repos.runtime.requeueLeasedJobsAfterRestart(at);
    const failedJobs = this.repos.runtime.requeueFailedJobs(limit, at);
    for (const { before, after } of [...interruptedJobs, ...failedJobs]) {
      this.appendJobChange(after, "queued", before);
    }

    const embeddingRetries = this.repos.runtime.requeueEmbeddingRetriesAfterRestart(Date.parse(at));
    for (const { before, after } of embeddingRetries) {
      this.appendEmbeddingRetryChange(after, "queued", before);
    }
    const restartedFailedProcessing = this.restartFailedProcessing(at, limit);

    let enqueuedImportSummaries = 0;
    let enqueuedEmbeddingRepairs = 0;
    const activeProcessing = this.repos.processing.listByStates([
      "summary_pending",
      "summarizing",
      "embedding_pending",
      "embedding"
    ], limit);
    for (const processing of activeProcessing) {
      const memory = this.repos.memories.get(processing.memoryId);
      if (!memory) continue;
      if (this.repos.memories.hasVector(memory.id, "vec_summary")) {
        this.repos.processing.update(memory.id, {
          state: "ready",
          stage: null,
          activeJobId: null,
          errorCode: null,
          errorMessage: null,
          failedAt: null,
          updatedAt: at
        });
        continue;
      }

      if (processing.state === "summary_pending" || processing.state === "summarizing") {
        const jobType = memoryHasImportPipeline(memory) ? "import_summary" : "trace_summary";
        let job = this.repos.runtime.getPendingJob(memory.id, jobType, memory.contentHash ?? undefined);
        if (!job) {
          job = this.enqueueJob({
            jobType,
            userId: memory.userId,
            sessionId: memory.sessionId,
            targetMemoryId: memory.id,
            payload: {
              source: "startup.processing_repair",
              contentHash: memory.contentHash
            },
            maxAttempts: 3,
            createdAt: at
          });
          if (jobType === "import_summary") enqueuedImportSummaries += 1;
        }
        this.repos.processing.update(memory.id, {
          state: "summary_pending",
          stage: "summary",
          activeJobId: job.id,
          updatedAt: at
        }, ["summary_pending", "summarizing"]);
        continue;
      }

      if (!this.config.algorithm.capture.embedAfterCapture) {
        this.repos.processing.update(memory.id, {
          state: "ready_text_only",
          stage: null,
          activeJobId: null,
          attemptCount: 0,
          retryAction: "retry",
          errorCode: null,
          errorMessage: null,
          failedAt: null,
          updatedAt: at
        }, ["embedding_pending", "embedding"]);
        continue;
      }
      let job = this.repos.runtime.getPendingJob(memory.id, "embedding", memory.contentHash ?? undefined);
      if (!job) {
        job = this.enqueueJob({
          jobType: "embedding",
          userId: memory.userId,
          sessionId: memory.sessionId,
          targetMemoryId: memory.id,
          payload: {
            reason: "startup.processing_repair",
            contentHash: memory.contentHash
          },
          maxAttempts: 6,
          createdAt: at
        });
        enqueuedEmbeddingRepairs += 1;
      }
      this.repos.processing.update(memory.id, {
        state: "embedding_pending",
        stage: "embedding",
        activeJobId: job.id,
        updatedAt: at
      }, ["embedding_pending", "embedding"]);
    }

    return {
      requeuedJobs: interruptedJobs.length + failedJobs.length,
      requeuedEmbeddingRetries: embeddingRetries.length,
      restartedFailedProcessing,
      enqueuedImportSummaries,
      enqueuedEmbeddingRepairs
    };
  }

  async runWorkerOnce(limit = 100, request: RequestEnvelope & { targetMemoryIds?: string[] } = {}): Promise<{
    leased: number;
    succeeded: number;
    failed: number;
    jobs: JobRef[];
    embeddingRetries: EmbeddingRetryRunSummary;
    changeSeq: number;
    syncCursor: string;
    serverTime: string;
  }> {
    if (!this.memoryAddEnabled()) {
      return this.runWorkerNoWrite(request);
    }
    const normalizedLimit = Math.max(1, Math.floor(limit));
    const targetMemoryIds = request.targetMemoryIds;
    const requeuedJobs = this.repos.runtime.requeueFailedJobs(
      normalizedLimit,
      nowIso(),
      targetMemoryIds
    );
    for (const { before, after } of requeuedJobs) {
      this.appendJobChange(after, "queued", before);
    }
    const jobs = this.repos.runtime.leaseQueuedJobs(
      normalizedLimit,
      60,
      targetMemoryIds
    );
    const retryCapacity = Math.max(0, normalizedLimit - jobs.length);
    const embeddingRetries = retryCapacity > 0
      ? await this.runEmbeddingRetryOnce(retryCapacity, targetMemoryIds)
      : { leased: 0, succeeded: 0, failed: 0, items: [] };
    const results: WorkerJobRunResult[] = [];
    for (let index = 0; index < jobs.length;) {
      const job = jobs[index]!;
      if (workerJobCanRunInParallel(job)) {
        const batchType = job.jobType;
        const batch: EvolutionJobRecord[] = [];
        while (index < jobs.length && jobs[index]?.jobType === batchType) {
          batch.push(jobs[index]!);
          index += 1;
        }
        if (batchType === "embedding") {
          results.push(...await this.runLeasedEmbeddingJobs(batch));
        } else {
          for (let offset = 0; offset < batch.length; offset += SUMMARY_WORKER_CONCURRENCY) {
            results.push(...await Promise.all(
              batch.slice(offset, offset + SUMMARY_WORKER_CONCURRENCY)
                .map((item) => this.runLeasedWorkerJob(item))
            ));
          }
        }
        continue;
      }
      results.push(await this.runLeasedWorkerJob(job));
      index += 1;
    }

    const succeeded = results.reduce((sum, result) => sum + result.succeeded, 0);
    const failed = results.reduce((sum, result) => sum + result.failed, 0);
    const refs = results.map((result) => result.ref);

    if (jobs.length > 0 || embeddingRetries.leased > 0) {
      workerLogger.info("drain.completed", {
        leased: jobs.length,
        succeeded,
        failed,
        embeddingRetriesLeased: embeddingRetries.leased,
        embeddingRetriesSucceeded: embeddingRetries.succeeded,
        embeddingRetriesFailed: embeddingRetries.failed
      });
    }

    const changeSeq = this.repos.runtime.latestChangeSeq();
    return {
      leased: jobs.length,
      succeeded,
      failed,
      jobs: refs,
      embeddingRetries,
      changeSeq,
      syncCursor: this.encodeChangeCursor(changeSeq),
      serverTime: nowIso()
    };
  }

  private async runLeasedWorkerJob(job: EvolutionJobRecord): Promise<WorkerJobRunResult> {
    this.appendJobChange(job, "leased");
    this.markProcessingJobLeased(job);
    workerLogger.info("job.started", workerJobLogFields(job));
    try {
      await this.processJob(job);
      return this.completeLeasedWorkerJob(job);
    } catch (error) {
      return this.failLeasedWorkerJob(job, error);
    }
  }

  private async runLeasedEmbeddingJobs(jobs: EvolutionJobRecord[]): Promise<WorkerJobRunResult[]> {
    const results: WorkerJobRunResult[] = [];
    const prepared: PreparedEmbeddingJob[] = [];

    for (const job of jobs) {
      this.appendJobChange(job, "leased");
      this.markProcessingJobLeased(job);
      workerLogger.info("job.started", workerJobLogFields(job));
      try {
        const item = this.prepareEmbeddingJob(job);
        if (item) {
          prepared.push(item);
        } else {
          results.push(this.completeLeasedWorkerJob(job));
        }
      } catch (error) {
        results.push(this.failLeasedWorkerJob(job, error));
      }
    }

    for (const role of ["document", "query"] as const) {
      const batch = prepared.filter((item) => item.role === role);
      if (batch.length === 0) {
        continue;
      }

      try {
        const vectors = await this.embedder.embed(batch.map((item) => item.text || "(empty)"), role);
        for (const [index, item] of batch.entries()) {
          try {
            this.applyEmbeddingVector(item, vectors[index] ?? []);
            results.push(this.completeLeasedWorkerJob(item.job));
          } catch (error) {
            results.push(this.failLeasedWorkerJob(item.job, error));
          }
        }
      } catch (error) {
        const at = nowIso();
        for (const item of batch) {
          if (this.repos.processing.get(item.memory.id)) {
            results.push(this.failLeasedWorkerJob(item.job, error));
          } else {
            const retry = this.enqueueEmbeddingRetry(item.memory, item.text, at, item.vectorField);
            this.appendEmbeddingRetryChange(retry, "queued", undefined, {
              code: "embedding_error",
              message: error instanceof Error ? error.message : String(error)
            });
            results.push(this.completeLeasedWorkerJob(item.job));
          }
        }
      }
    }

    return results;
  }

  private completeLeasedWorkerJob(job: EvolutionJobRecord): WorkerJobRunResult {
    const completed = this.repos.runtime.completeJob(job.id) ?? {
      ...job,
      status: "succeeded" as const,
      leasedUntil: null,
      updatedAt: nowIso()
    };
    this.appendJobChange(completed, "succeeded", job);
    workerLogger.info("job.succeeded", workerJobLogFields(completed));
    return {
      succeeded: 1,
      failed: 0,
      ref: {
        ...jobToRef(job),
        status: "succeeded" as const
      }
    };
  }

  private failLeasedWorkerJob(job: EvolutionJobRecord, error: unknown): WorkerJobRunResult {
    const errorMessage = processingStageForJob(job.jobType)
      ? sanitizeProcessingError(error)
      : error instanceof Error ? error.message : String(error);
    const failedJob = this.repos.runtime.failJob(
      job.id,
      errorMessage
    ) ?? {
      ...job,
      status: "failed" as const,
      leasedUntil: null,
      lastError: errorMessage,
      updatedAt: nowIso()
    };
    const failOp = failedJob.status === "dead_letter" ? "dead_letter" : "failed";
    this.appendJobChange(failedJob, failOp, job);
    this.updateProcessingAfterJobFailure(failedJob, errorMessage);
    workerLogger.error("job.failed", {
      ...workerJobLogFields(failedJob),
      terminal: failedJob.status === "dead_letter",
      ...memoryErrorFields(error)
    });
    return {
      succeeded: 0,
      failed: 1,
      ref: {
        ...jobToRef(job),
        status: failedJob.status === "dead_letter" ? "dead_letter" as const : "failed" as const
      }
    };
  }

  private markProcessingJobLeased(job: EvolutionJobRecord): void {
    if (!job.targetMemoryId) return;
    const stage = processingStageForJob(job.jobType);
    if (!stage) return;
    const memory = this.repos.memories.get(job.targetMemoryId);
    if (!memory || !processingJobMatchesMemory(job, memory)) return;
    const state = stage === "summary" ? "summarizing" : "embedding";
    this.repos.processing.update(job.targetMemoryId, {
      state,
      stage,
      activeJobId: job.id,
      attemptCount: job.attempts,
      errorCode: null,
      errorMessage: null,
      failedAt: null,
      updatedAt: nowIso()
    }, stage === "summary"
      ? ["summary_pending", "summarizing"]
      : ["embedding_pending", "embedding"]);
  }

  private updateProcessingAfterJobFailure(job: EvolutionJobRecord, error: unknown): void {
    if (!job.targetMemoryId) return;
    const stage = processingStageForJob(job.jobType);
    if (!stage || !this.repos.processing.get(job.targetMemoryId)) return;
    const memory = this.repos.memories.get(job.targetMemoryId);
    if (!memory || !processingJobMatchesMemory(job, memory)) return;
    const message = sanitizeProcessingError(error);
    const terminal = job.status === "dead_letter";
    const classification = classifyProcessingError(message);
    this.repos.processing.update(job.targetMemoryId, {
      state: terminal ? "failed" : stage === "summary" ? "summary_pending" : "embedding_pending",
      stage,
      activeJobId: terminal ? null : job.id,
      attemptCount: job.attempts,
      retryAction: terminal ? classification.retryAction : "retry",
      errorCode: terminal ? classification.code : null,
      errorMessage: terminal ? message : null,
      failedAt: terminal ? nowIso() : null,
      updatedAt: nowIso()
    }, stage === "summary"
      ? ["summary_pending", "summarizing", "failed"]
      : ["embedding_pending", "embedding", "failed"]);
  }

  private async runEmbeddingRetryOnce(
    limit: number,
    targetMemoryIds?: readonly string[]
  ): Promise<EmbeddingRetryRunSummary> {
    const now = Date.now();
    const retries = this.repos.runtime.claimDueEmbeddingRetries({
      now,
      workerId: this.embeddingRetryWorkerId,
      leaseUntil: now + EMBEDDING_RETRY_LEASE_MS,
      limit,
      targetMemoryIds
    });
    const results: Array<{ succeeded: number; failed: number; item: EmbeddingRetryRunSummary["items"][number] | null }> = [];
    const claimed: Array<{
      retry: EmbeddingRetryRecord;
      claim: { workerId: string; leaseUntil: number };
      attemptNo: number;
    }> = [];

    for (const retry of retries) {
      const claim = {
        workerId: this.embeddingRetryWorkerId,
        leaseUntil: retry.leaseUntil ?? now + EMBEDDING_RETRY_LEASE_MS
      };
      if (!this.repos.runtime.isEmbeddingRetryClaimHeld(retry.id, claim)) {
        results.push({ succeeded: 0, failed: 0, item: null });
        continue;
      }
      claimed.push({ retry, claim, attemptNo: retry.attempts + 1 });
    }

    for (const role of ["document", "query"] as const) {
      const batch = claimed.filter((item) => item.retry.embedRole === role);
      if (batch.length === 0) {
        continue;
      }

      try {
        const vectors = await this.embedder.embed(batch.map((item) => item.retry.sourceText || "(empty)"), role);
        for (const [index, item] of batch.entries()) {
          try {
            const result = this.applyEmbeddingRetryVector(item.retry, item.claim, vectors[index] ?? []);
            results.push(result);
          } catch (error) {
            results.push(this.failClaimedEmbeddingRetry(item.retry, item.claim, item.attemptNo, error));
          }
        }
      } catch (error) {
        for (const item of batch) {
          results.push(this.failClaimedEmbeddingRetry(item.retry, item.claim, item.attemptNo, error));
        }
      }
    }

    return {
      leased: retries.length,
      succeeded: results.reduce((sum, result) => sum + result.succeeded, 0),
      failed: results.reduce((sum, result) => sum + result.failed, 0),
      items: results.map((result) => result.item).filter((item): item is EmbeddingRetryRunSummary["items"][number] => Boolean(item))
    };
  }

  private applyEmbeddingRetryVector(
    retry: EmbeddingRetryRecord,
    claim: { workerId: string; leaseUntil: number },
    vector: number[]
  ): { succeeded: number; failed: number; item: EmbeddingRetryRunSummary["items"][number] | null } {
    const memory = this.repos.memories.get(retry.targetId);
    if (!memory) {
      throw new Error(`embedding retry target not found: ${retry.targetKind}:${retry.targetId}`);
    }
    const at = nowIso();
    let completed: EmbeddingRetryRecord | undefined;
    this.repos.transaction(() => {
      const previous = memory;
      const vectorized = updateMemoryVectorField(memory, retry.vectorField, vector, {
        model: this.embedder.config.model ?? this.embedder.config.provider,
        provider: this.embedder.config.provider,
        updatedAt: at
      });
      const next = memory.memoryLayer === "L1"
        ? updateImportPipelineStatus(vectorized, "indexed", at)
        : vectorized;
      const saved = this.repos.memories.updateMaintenance(next);
      if (this.repos.processing.get(saved.id)) {
        this.repos.processing.update(saved.id, {
          state: "ready",
          stage: null,
          activeJobId: null,
          attemptCount: retry.attempts + 1,
          retryAction: "retry",
          errorCode: null,
          errorMessage: null,
          failedAt: null,
          updatedAt: at
        }, ["embedding_pending", "embedding"]);
      }
      this.repos.runtime.appendChange({
        memoryId: saved.id,
        namespaceId: namespaceIdFromMemory(saved),
        kind: kindFromMemory(saved),
        op: "updated",
        entityId: saved.id,
        userId: saved.userId,
        changeType: "update",
        before: previous,
        after: saved,
        source: "worker.embedding_retry",
        createdAt: at
      });
      completed = this.repos.runtime.markEmbeddingRetrySucceededClaimed(retry.id, {
        ...claim,
        now: Date.now()
      });
    });
    if (completed) {
      this.appendEmbeddingRetryChange(completed, "succeeded", retry);
      workerLogger.info("embedding_retry.succeeded", embeddingRetryLogFields(completed));
      return { succeeded: 1, failed: 0, item: embeddingRetryToRunItem(completed) };
    }
    return { succeeded: 0, failed: 0, item: null };
  }

  private failClaimedEmbeddingRetry(
    retry: EmbeddingRetryRecord,
    claim: { workerId: string; leaseUntil: number },
    attemptNo: number,
    error: unknown
  ): { succeeded: number; failed: number; item: EmbeddingRetryRunSummary["items"][number] | null } {
    const message = error instanceof Error ? error.message : String(error);
    const terminal = attemptNo >= retry.maxAttempts;
    const updated = terminal
      ? this.repos.runtime.markEmbeddingRetryFailedClaimed(retry.id, {
        ...claim,
        attempts: attemptNo,
        error: message,
        now: Date.now()
      })
      : this.repos.runtime.markEmbeddingRetryRetryClaimed(retry.id, {
        ...claim,
        attempts: attemptNo,
        nextAttemptAt: Date.now() + embeddingRetryBackoffMs(attemptNo),
        error: message,
        now: Date.now()
      });
    if (updated) {
      this.appendEmbeddingRetryChange(updated, terminal ? "failed" : "retry", retry);
      const fields = {
        ...embeddingRetryLogFields(updated),
        terminal,
        ...memoryErrorFields(error)
      };
      if (terminal) {
        workerLogger.error("embedding_retry.failed", fields);
      } else {
        workerLogger.warn("embedding_retry.retry_scheduled", fields);
      }
      return { succeeded: 0, failed: 1, item: embeddingRetryToRunItem(updated) };
    }
    return { succeeded: 0, failed: 1, item: null };
  }

  private async processJob(job: EvolutionJobRecord): Promise<void> {
    switch (job.jobType) {
      case "episode_idle_close":
        this.closeIdleEpisodesForMemoryWrite(job);
        return;
      case "trace_summary":
        await this.summarizeCapturedTrace(job);
        return;
      case "import_summary":
        await this.summarizeImportedTrace(job);
        return;
      case "l2_induction":
        await this.induceL2(job);
        return;
      case "l3_abstraction":
        await this.abstractL3(job);
        return;
      case "skill_crystallization":
        await this.crystallizeSkill(job);
        return;
      case "reward":
        await this.applyReward(job);
        return;
      case "embedding":
        await this.embedMemory(job);
        return;
      case "reflection":
        await this.reflectTrace(job);
        return;
      case "skill_trial_resolve":
        this.resolveSkillTrial(job);
        return;
      case "l2_association":
        this.associateL2(job);
        return;
      default:
        throw new Error(`unsupported job type: ${job.jobType}`);
    }
  }

  private closeIdleEpisodesForMemoryWrite(job: EvolutionJobRecord): void {
    const triggerEpisodeId = typeof job.payload.triggerEpisodeId === "string"
      ? job.payload.triggerEpisodeId
      : job.episodeId;
    const triggerMemoryId = typeof job.payload.triggerMemoryId === "string"
      ? job.payload.triggerMemoryId
      : undefined;
    const triggerSource = typeof job.payload.triggerSource === "string"
      ? job.payload.triggerSource
      : "turn.complete";
    const triggeredAt = typeof job.payload.triggeredAt === "string"
      ? job.payload.triggeredAt
      : job.createdAt;
    const triggeredAtMs = Date.parse(triggeredAt);
    if ((!triggerEpisodeId && !triggerMemoryId) || !Number.isFinite(triggeredAtMs)) {
      throw new Error(`invalid episode idle close job: ${job.id}`);
    }

    const inactiveBefore = new Date(triggeredAtMs - EPISODE_IDLE_TIMEOUT_MS).toISOString();
    const closedAt = nowIso();
    this.repos.transaction(() => {
      const episodes = this.repos.runtime.listIdleEpisodes(
        triggerEpisodeId,
        inactiveBefore
      );
      for (const episode of episodes) {
        const session = this.requireSession(episode.sessionId);
        const closed = this.repos.runtime.closeEpisode(episode.id, {
          closeReason: "idle_timeout",
          closedBy: "worker.episode_idle_close",
          idleTimeoutMs: EPISODE_IDLE_TIMEOUT_MS,
          triggeredAt,
          triggerSource,
          ...(triggerEpisodeId ? { triggerEpisodeId } : {}),
          ...(triggerMemoryId ? { triggerMemoryId } : {})
        }, closedAt);
        if (!closed) {
          continue;
        }
        this.repos.runtime.appendChange({
          memoryId: closed.id,
          namespaceId: namespaceIdFromSession(session),
          kind: "episode",
          op: "updated",
          entityId: closed.id,
          userId: closed.userId,
          changeType: "episode_closed",
          before: episode,
          after: closed,
          source: "worker.episode_idle_close",
          createdAt: closedAt
        });
        this.finalizeClosedEpisode(closed, closedAt, "idle_timeout");
      }
    });
  }

  private async induceL2(job: EvolutionJobRecord): Promise<void> {
    const source = this.l2InductionSourceForJob(job);
    if (!source) {
      const sourceMemoryId = typeof job.payload.sourceMemoryId === "string"
        ? job.payload.sourceMemoryId
        : typeof job.payload.l1MemoryId === "string"
        ? job.payload.l1MemoryId
        : job.targetMemoryId;
      throw new Error(`source memory not found for l2 induction: ${sourceMemoryId ?? job.id}`);
    }
    const sourceTrace = this.traceMeta(source);
    if (!sourceTrace) {
      return;
    }
    const at = nowIso();
    const sourceSignature = signatureFromTrace(sourceTrace);
    const sourceNamespaceId = namespaceIdFromMemory(source);
    this.repos.runtime.pruneCandidatePool(at);
    if (this.isTraceEligibleForL2(sourceTrace)) {
      this.recordCandidatePoolTrace(sourceTrace, sourceSignature, at);
    }

    const pendingCandidates = this.repos.runtime.listPendingCandidatePool({
      userId: source.userId,
      now: at,
      limit: 2000
    });
    const pendingTraceIds = uniq(pendingCandidates.map((candidate) => candidate.sourceMemoryId));
    const eligibleTraces = this.repos.memories
      .getMany(pendingTraceIds)
      .map((memory) => this.traceMeta(memory))
      .filter((trace): trace is TraceMeta =>
        Boolean(trace &&
          this.isTraceEligibleForL2(trace))
      );
    const eligibleById = new Map(eligibleTraces.map((trace) => [trace.id, trace]));
    const signatures = uniq(
      pendingCandidates
        .filter((candidate) => eligibleById.has(candidate.sourceMemoryId))
        .map((candidate) => candidate.candidateKey)
    );

    for (const signature of signatures) {
      const bucket = uniq(
        pendingCandidates
          .filter((candidate) => candidate.candidateKey === signature)
          .map((candidate) => candidate.sourceMemoryId)
      )
        .map((traceId) => eligibleById.get(traceId))
        .filter((trace): trace is NonNullable<ReturnType<typeof traceMetaFromMemory>> => Boolean(trace));
      const distinctEpisodeCount = uniq(bucket.map((trace) => trace.episodeId).filter((id): id is string => Boolean(id))).length;
      if (distinctEpisodeCount < this.config.algorithm.l2Induction.minEpisodesForInduction) {
        logEvolutionDecision(job, "l2_induction", "gate_not_met", {
          sourceMemoryId: source.id,
          evidenceCount: bucket.length,
          distinctEpisodeCount,
          requiredEpisodes: this.config.algorithm.l2Induction.minEpisodesForInduction
        });
        continue;
      }
      const bucketTraceIds = bucket.map((trace) => trace.id);
      const byEpisode = new Map<string, typeof bucket[number]>();
      for (const trace of bucket) {
        if (!trace.episodeId) continue;
        const previous = byEpisode.get(trace.episodeId);
        if (!previous || trace.value > previous.value || trace.priority > previous.priority) {
          byEpisode.set(trace.episodeId, trace);
        }
      }
      const promptEvidenceTraces = [...byEpisode.values()];
      const matchingPolicy = this.findExistingPolicyForL2Bucket(signature, bucket, source.userId);
      if (matchingPolicy) {
        for (const trace of bucket) {
          const similarity = tracePolicySimilarity(trace, matchingPolicy);
          this.repos.runtime.insertTracePolicyLink({
            userId: source.userId,
            l1MemoryId: trace.id,
            l2MemoryId: matchingPolicy.id,
            relation: matchingPolicy.signature === signature ? "matches_signature" : "similar_pattern",
            strength: matchingPolicy.signature === signature ? 1 : similarity.score,
            createdAt: at
          });
        }
        this.markCandidatePoolPromoted(source.userId, signature, bucketTraceIds, matchingPolicy.id, at);
        this.recomputePolicyStats(matchingPolicy.id, source.userId, at, sourceTrace.episodeId);
        for (const episodeId of uniq(bucket.map((trace) => trace.episodeId).filter((id): id is string => Boolean(id)))) {
          this.repos.runtime.appendEpisodeDerivedMemory(episodeId, "L2", matchingPolicy.id, at);
        }
        continue;
      }
      const policyKey = `policy:${stableHash(signature).slice(0, 16)}`;
      const existingPolicyMemory = this.repos.memories.getByKey(source.userId, "L2", policyKey);
      const existingPolicy = existingPolicyMemory && !this.isArchivedEvolutionMemory(existingPolicyMemory)
        ? policyMetaFromMemory(existingPolicyMemory)
        : null;
      const fallbackDraft = buildPolicyDraft({
        signature,
        evidenceTraces: bucket,
        allTraces: this.l2GainReferenceTraces(bucket, sourceTrace.episodeId),
        minSupport: this.config.algorithm.l2Induction.minEpisodesForInduction,
        minGain: this.config.algorithm.l2Induction.minGain,
        archiveGain: this.config.algorithm.l2Induction.archiveGain,
        tauSoftmax: this.config.algorithm.l2Induction.tauSoftmax,
        gainEmaAlpha: this.config.algorithm.l2Induction.gainEmaAlpha,
        currentStatus: existingPolicy?.status,
        currentGain: existingPolicy?.gain,
        currentSupport: existingPolicy?.support
      });
      const enhancement = await this.enhancePolicyDraft(signature, promptEvidenceTraces, fallbackDraft);
      if (!enhancement.ok) {
        logEvolutionDecision(job, "l2_induction", enhancement.reason, {
          sourceMemoryId: source.id,
          evidenceCount: bucket.length,
          distinctEpisodeCount
        });
        this.repos.runtime.appendChange({
          memoryId: source.id,
          namespaceId: sourceNamespaceId,
          kind: "policy",
          op: "skipped",
          entityId: source.id,
          userId: source.userId,
          changeType: "l2_induction_skipped",
          after: { signature, reason: enhancement.reason, traceIds: bucketTraceIds },
          source: "worker.l2_induction.v7",
          createdAt: at
        });
        continue;
      }
      const draft = {
        ...enhancement.draft,
        key: policyKey
      };
      const l2 = this.buildMemory({
        userId: source.userId,
        conversationId: source.conversationId,
        sessionId: source.sessionId,
        agentId: source.agentId,
        appId: source.appId,
        projectId: projectIdFromMemory(source),
        profileId: profileIdFromMemory(source),
        layer: "L2",
        kind: "policy",
        lifecycleStatus: draft.status,
        memoryType: "LongTermMemory",
        key: draft.key,
        value: draft.body,
        tags: draft.tags,
        info: {
          signature,
          support: draft.support,
          gain: draft.gain,
          raw_gain: draft.rawGain,
          policy_confidence: draft.confidence,
          status: draft.status,
          source_memory_ids: draft.sourceTraceIds
        },
        internal: {
          source: "worker.l2_induction.v7",
          plugin_algorithm: "l2.induction.v7",
          source_memory_ids: draft.sourceTraceIds,
          source_l1_memory_ids: draft.sourceTraceIds,
          title: draft.title,
          trigger: draft.trigger,
          procedure: draft.procedure,
          verification: draft.verification,
          boundary: draft.boundary,
          support: draft.support,
          gain: draft.gain,
          raw_gain: draft.rawGain,
          policy_confidence: draft.confidence,
          status: draft.status,
          source_episode_ids: draft.sourceEpisodeIds,
          source_trace_ids: draft.sourceTraceIds,
          policy: {
            title: draft.title,
            trigger: draft.trigger,
            procedure: draft.procedure,
            verification: draft.verification,
            boundary: draft.boundary,
            support: draft.support,
            gain: draft.gain,
            raw_gain: draft.rawGain,
            policy_confidence: draft.confidence,
            status: draft.status,
            experience_type: "success_pattern",
            evidence_polarity: "positive",
            skill_eligible: true,
            signature,
            source_episode_ids: draft.sourceEpisodeIds,
            source_trace_ids: draft.sourceTraceIds,
            vec: draft.vec
          }
        },
        createdAt: at
      });
      const upsert = this.upsertEvolutionMemory(l2);
      for (const episodeId of draft.sourceEpisodeIds) {
        this.repos.runtime.appendEpisodeDerivedMemory(episodeId, "L2", upsert.memory.id, at);
      }
      for (const trace of bucket) {
        this.repos.runtime.insertTracePolicyLink({
          userId: source.userId,
          l1MemoryId: trace.id,
          l2MemoryId: upsert.memory.id,
          relation: "supports",
          strength: Math.max(0, trace.value),
          createdAt: at
        });
      }
      this.markCandidatePoolPromoted(source.userId, signature, bucketTraceIds, upsert.memory.id, at);
      this.repos.runtime.appendChange({
        memoryId: upsert.memory.id,
        namespaceId: namespaceIdFromMemory(upsert.memory),
        kind: kindFromMemory(upsert.memory),
        op: upsert.created ? "created" : "updated",
        entityId: upsert.memory.id,
        userId: source.userId,
        changeType: upsert.created ? "create" : "update",
        before: upsert.previous,
        after: upsert.memory,
        source: "worker.l2_induction.v7",
        createdAt: at
      });
      if (this.config.algorithm.capture.embedAfterCapture) {
        this.enqueueJob({
          jobType: "embedding",
          userId: source.userId,
          sessionId: source.sessionId,
          episodeId: sourceTrace.episodeId,
          targetMemoryId: upsert.memory.id,
          payload: { reason: "l2.upserted" },
          createdAt: at
        });
      }
      this.enqueueJob({
        jobType: "l3_abstraction",
        userId: source.userId,
        sessionId: source.sessionId,
        episodeId: sourceTrace.episodeId,
        payload: {
          targetKind: "policy_cluster",
          seedPolicyId: upsert.memory.id,
          policyIds: [upsert.memory.id],
          signature
        },
        createdAt: at
      });
      this.enqueueJob({
        jobType: "skill_crystallization",
        userId: source.userId,
        sessionId: source.sessionId,
        episodeId: sourceTrace.episodeId,
        targetMemoryId: upsert.memory.id,
        payload: { signature },
        createdAt: at
      });
    }
  }

  private l2InductionSourceForJob(job: EvolutionJobRecord): MemoryRow | undefined {
    const payloadSourceMemoryId = typeof job.payload.sourceMemoryId === "string"
      ? job.payload.sourceMemoryId
      : typeof job.payload.l1MemoryId === "string"
      ? job.payload.l1MemoryId
      : undefined;
    const payloadSource = payloadSourceMemoryId ? this.repos.memories.get(payloadSourceMemoryId) : undefined;
    if (payloadSource && this.traceMeta(payloadSource)) {
      return payloadSource;
    }
    const legacyTarget = job.targetMemoryId ? this.repos.memories.get(job.targetMemoryId) : undefined;
    if (legacyTarget && this.traceMeta(legacyTarget)) {
      return legacyTarget;
    }
    return payloadSource ?? legacyTarget;
  }

  private async abstractL3(job: EvolutionJobRecord): Promise<void> {
    const source = this.l3AbstractionSourceForJob(job);
    const userId = source?.userId ?? job.userId;
    const at = nowIso();
    const policies = this.repos.memories
      .list({ memoryLayer: "L2", status: "activated" }, 1000)
      .map(policyMetaFromMemory)
      .filter((policy): policy is NonNullable<ReturnType<typeof policyMetaFromMemory>> =>
        Boolean(policy)
      );
    const domainTagsFilter = stringArray(job.payload.domainTagsFilter);
    const filteredPolicies = domainTagsFilter.length > 0
      ? policies.filter((policy) =>
          policy.memory.tags.some((tag) => domainTagsFilter.includes(tag.toLowerCase()))
        )
      : policies;
    const fallbackDrafts = buildWorldModelDraft({
      policies: filteredPolicies,
      minPolicies: this.config.algorithm.l3Abstraction.minPolicies,
      minPolicyGain: this.config.algorithm.l3Abstraction.minPolicyGain,
      minPolicySupport: this.config.algorithm.l3Abstraction.minPolicySupport,
      clusterMinSimilarity: this.config.algorithm.l3Abstraction.clusterMinSimilarity
    });
    if (fallbackDrafts.length === 0) {
      logEvolutionDecision(job, "l3_abstraction", "no_eligible_cluster", {
        policyCount: policies.length,
        filteredPolicyCount: filteredPolicies.length,
        minPolicies: this.config.algorithm.l3Abstraction.minPolicies,
        minPolicyGain: this.config.algorithm.l3Abstraction.minPolicyGain,
        minPolicySupport: this.config.algorithm.l3Abstraction.minPolicySupport,
        clusterMinSimilarity: this.config.algorithm.l3Abstraction.clusterMinSimilarity
      });
    }
    const policyById = new Map(policies.map((policy) => [policy.id, policy]));
    const readyDrafts: WorldModelDraft[] = [];
    for (const draft of fallbackDrafts) {
      if (this.l3DomainInCooldown(userId, draft.domainKey, at)) {
        logEvolutionDecision(job, "l3_abstraction", "cooldown", {
          policyCount: draft.policyIds.length
        });
        this.repos.runtime.appendChange({
          memoryId: source?.id ?? draft.key,
          namespaceId: source ? namespaceIdFromMemory(source) : undefined,
          kind: "world_model",
          op: "skipped",
          entityId: draft.key,
          userId,
          changeType: "l3_abstraction_skipped",
          after: {
            domainKey: draft.domainKey,
            policyIds: draft.policyIds,
            reason: "cooldown"
          },
          source: "worker.l3_abstraction.v7",
          createdAt: at
        });
        continue;
      }
      readyDrafts.push(draft);
    }
    const enhancements = await this.enhanceWorldModelDrafts(readyDrafts, policies, userId);
    for (const enhancement of enhancements) {
      if (!enhancement.ok) {
        const anchorPolicy = enhancement.fallback.policyIds
          .map((policyId) => policyById.get(policyId))
          .find((policy): policy is PolicyMeta => Boolean(policy));
        const anchorMemory = source ?? anchorPolicy?.memory;
        logEvolutionDecision(job, "l3_abstraction", enhancement.reason, {
          sourceMemoryId: anchorMemory?.id,
          policyCount: enhancement.fallback.policyIds.length
        });
        this.repos.runtime.appendChange({
          memoryId: anchorMemory?.id ?? enhancement.fallback.key,
          namespaceId: anchorMemory ? namespaceIdFromMemory(anchorMemory) : undefined,
          kind: "world_model",
          op: "skipped",
          entityId: enhancement.fallback.key,
          userId,
          changeType: "l3_abstraction_skipped",
          after: {
            domainKey: enhancement.fallback.domainKey,
            policyIds: enhancement.fallback.policyIds,
            reason: enhancement.reason
          },
          source: "worker.l3_abstraction.v7",
          createdAt: at
        });
        continue;
      }
      const rawDraft = enhancement.draft;
      const existing = this.findWorldModelMergeTarget(rawDraft, userId);
      const draft = existing
        ? mergeWorldModelDraftForUpdate(rawDraft, existing, this.config.algorithm.l3Abstraction.confidenceDelta)
        : rawDraft;
      const l3 = this.buildMemory({
        userId,
        conversationId: source?.conversationId,
        sessionId: source?.sessionId ?? job.sessionId,
        agentId: source?.agentId,
        appId: source?.appId,
        projectId: source ? projectIdFromMemory(source) : undefined,
        profileId: source ? profileIdFromMemory(source) : undefined,
        layer: "L3",
        kind: "world_model",
        memoryType: "LongTermMemory",
        key: draft.key,
        value: draft.body,
        tags: draft.tags,
        info: {
          domain_key: draft.domainKey,
          confidence: draft.confidence,
          cohesion: draft.cohesion,
          admission: draft.admission,
          source_memory_ids: draft.policyIds
        },
        internal: {
          source: "worker.l3_abstraction.v7",
          plugin_algorithm: "l3.abstraction.v7",
          source_memory_ids: draft.policyIds,
          title: draft.title,
          body: draft.body,
          structure: draft.structure,
          domain_tags: draft.domainTags,
          source_policy_ids: draft.policyIds,
          world_model_confidence: draft.confidence,
          world_model: {
            title: draft.title,
            domain_key: draft.domainKey,
            domain_tags: draft.domainTags,
            policy_ids: draft.policyIds,
            confidence: draft.confidence,
            cohesion: draft.cohesion,
            admission: draft.admission,
            structure: draft.structure,
            body: draft.body,
            vec: draft.vec
          }
        },
        createdAt: at
      });
      const upsert = this.upsertEvolutionMemory(l3);
      this.markL3DomainRun(userId, draft.domainKey, at);
      const sourceEpisodeIds = uniq(
        policies
          .filter((policy) => draft.policyIds.includes(policy.id))
          .flatMap((policy) => policy.sourceEpisodeIds)
      );
      for (const episodeId of sourceEpisodeIds) {
        this.repos.runtime.appendEpisodeDerivedMemory(episodeId, "L3", upsert.memory.id, at);
      }
      this.repos.runtime.appendChange({
        memoryId: upsert.memory.id,
        namespaceId: namespaceIdFromMemory(upsert.memory),
        kind: kindFromMemory(upsert.memory),
        op: upsert.created ? "created" : "updated",
        entityId: upsert.memory.id,
        userId,
        changeType: upsert.created ? "create" : "l3_merge",
        before: upsert.previous,
        after: upsert.memory,
        source: "worker.l3_abstraction.v7",
        createdAt: at
      });
      if (this.config.algorithm.capture.embedAfterCapture) {
        this.enqueueJob({
          jobType: "embedding",
          userId,
          sessionId: source?.sessionId ?? job.sessionId,
          episodeId: job.episodeId,
          targetMemoryId: upsert.memory.id,
          payload: { reason: "l3.upserted" },
          createdAt: at
        });
      }
    }
  }

  private l3DomainInCooldown(userId: string, domainKey: string, at: string): boolean {
    const cooldownDays = this.config.algorithm.l3Abstraction.cooldownDays;
    if (cooldownDays <= 0) return false;
    const item = this.repos.runtime.getKv(l3CooldownKey(userId, domainKey));
    const lastRunAt = isRecord(item?.value) && typeof item.value.at === "string"
      ? Date.parse(item.value.at)
      : item?.updatedAt
      ? Date.parse(item.updatedAt)
      : NaN;
    const now = Date.parse(at);
    if (!Number.isFinite(lastRunAt) || !Number.isFinite(now)) return false;
    return now - lastRunAt < cooldownDays * 24 * 60 * 60 * 1000;
  }

  private markL3DomainRun(userId: string, domainKey: string, at: string): void {
    this.repos.runtime.setKv(l3CooldownKey(userId, domainKey), { at, domainKey }, at);
  }

  private l3AbstractionSourceForJob(job: EvolutionJobRecord): MemoryRow | undefined {
    const seedPolicyId = typeof job.payload.seedPolicyId === "string"
      ? job.payload.seedPolicyId
      : typeof job.payload.l2MemoryId === "string"
      ? job.payload.l2MemoryId
      : typeof job.payload.policyId === "string"
      ? job.payload.policyId
      : undefined;
    const seedPolicy = seedPolicyId ? this.repos.memories.get(seedPolicyId) : undefined;
    if (seedPolicy && seedPolicy.memoryLayer === "L2") {
      return seedPolicy;
    }
    const payloadSourceMemoryId = typeof job.payload.sourceMemoryId === "string"
      ? job.payload.sourceMemoryId
      : typeof job.payload.l1MemoryId === "string"
      ? job.payload.l1MemoryId
      : undefined;
    const payloadSource = payloadSourceMemoryId ? this.repos.memories.get(payloadSourceMemoryId) : undefined;
    if (payloadSource) {
      return payloadSource;
    }
    return job.targetMemoryId ? this.repos.memories.get(job.targetMemoryId) : undefined;
  }

  private findWorldModelMergeTarget(
    draft: WorldModelDraft,
    userId: string
  ): MemoryRow | undefined {
    const exact = this.repos.memories.getByKey(userId, "L3", draft.key);
    if (
      exact &&
      !this.isArchivedEvolutionMemory(exact)
    ) {
      return exact;
    }
    const draftPolicyIds = new Set(draft.policyIds);
    let bestOverlap: { memory: MemoryRow; score: number; shared: number; confidence: number } | undefined;
    let bestVector: { memory: MemoryRow; score: number } | undefined;
    const candidates = this.repos.memories
      .list({ memoryLayer: "L3", status: ["activated", "resolving"] }, 1000)
      .map((memory) => ({ memory, world: worldModelMetaFromMemory(memory) }))
      .filter((entry): entry is { memory: MemoryRow; world: WorldModelMeta } => Boolean(entry.world));

    for (const { memory, world } of candidates) {
      const overlap = l3PolicyOverlapScore([...draftPolicyIds], world.policyIds);
      if (overlap.score >= 0.6) {
        if (
          !bestOverlap ||
          overlap.score > bestOverlap.score ||
          (overlap.score === bestOverlap.score && overlap.shared > bestOverlap.shared) ||
          (
            overlap.score === bestOverlap.score &&
            overlap.shared === bestOverlap.shared &&
            world.confidence > bestOverlap.confidence
          )
        ) {
          bestOverlap = { memory, score: overlap.score, shared: overlap.shared, confidence: world.confidence };
        }
      }
      const sharesDomainTag = draft.domainTags.some((tag) => world.domainTags.includes(tag));
      if (!sharesDomainTag || !draft.vec || !world.vec) continue;
      const score = cosine(draft.vec, world.vec);
      if (
        score >= this.config.algorithm.l3Abstraction.clusterMinSimilarity &&
        (!bestVector || score > bestVector.score)
      ) {
        bestVector = { memory, score };
      }
    }
    return bestOverlap?.memory ?? bestVector?.memory;
  }

  private async crystallizeSkill(job: EvolutionJobRecord): Promise<void> {
    const source = job.targetMemoryId ? this.repos.memories.get(job.targetMemoryId) : undefined;
    const userId = source?.userId ?? job.userId;
    const at = nowIso();
    const policyMemories = source?.memoryLayer === "L2"
      ? [source]
      : this.repos.memories
          .list({ memoryLayer: "L2", status: "activated" }, 1000);

    for (const policyMemory of policyMemories) {
      const policy = policyMetaFromMemory(policyMemory);
      if (!policy) continue;
      const evidenceTraces = this.gatherSkillEvidence(policy, userId);
      const counterExamples = this.gatherSkillCounterExamples(policy, userId);
      if (evidenceTraces.length === 0) {
        logEvolutionDecision(job, "skill_crystallization", "no_evidence", {
          policyId: policy.id
        });
        this.repos.runtime.appendChange({
          memoryId: policyMemory.id,
          namespaceId: namespaceIdFromMemory(policyMemory),
          kind: "skill",
          op: "skipped",
          entityId: policyMemory.id,
          userId,
          changeType: "skill_crystallization_skipped",
          after: { policyId: policy.id, reason: "no-evidence" },
          source: "worker.skill_crystallization.v7",
          createdAt: at
        });
        continue;
      }
      const existingSkill = this.findExistingSkillForPolicy(policy, userId);
      if (this.isSkillCrystallizationInCooldown(policy, at)) {
        logEvolutionDecision(job, "skill_crystallization", "cooldown", {
          policyId: policy.id,
          existingSkillId: existingSkill?.id
        });
        this.repos.runtime.appendChange({
          memoryId: policyMemory.id,
          namespaceId: namespaceIdFromMemory(policyMemory),
          kind: "skill",
          op: "skipped",
          entityId: existingSkill?.id ?? policyMemory.id,
          userId,
          changeType: "skill_crystallization_skipped",
          after: {
            policyId: policy.id,
            ...(existingSkill ? { skillId: existingSkill.id } : {}),
            reason: "cooldown"
          },
          source: "worker.skill_crystallization.v7",
          createdAt: at
        });
        continue;
      }
      this.markSkillCrystallizationRun(policy, at);
      const fallbackDraft = buildSkillDraft({
        policy,
        existing: existingSkill,
        minEtaForRetrieval: this.config.algorithm.skill.minEtaForRetrieval,
        minSupport: this.config.algorithm.skill.minSupport,
        minGain: this.config.algorithm.skill.minGain
      });
      const enhancement = fallbackDraft
        ? await this.enhanceSkillDraft(policy, fallbackDraft, evidenceTraces, counterExamples, existingSkill)
        : { ok: false, reason: "not-eligible" } as const;
      if (!enhancement.ok) {
        logEvolutionDecision(job, "skill_crystallization", enhancement.reason, {
          policyId: policy.id,
          evidenceCount: evidenceTraces.length,
          counterExampleCount: counterExamples.length
        });
        this.repos.runtime.appendChange({
          memoryId: policyMemory.id,
          namespaceId: namespaceIdFromMemory(policyMemory),
          kind: "skill",
          op: "skipped",
          entityId: policyMemory.id,
          userId,
          changeType: "skill_crystallization_skipped",
          after: { policyId: policy.id, reason: enhancement.reason },
          source: "worker.skill_crystallization.v7",
          createdAt: at
        });
        continue;
      }
      const draft = enhancement.draft;
      const verdict = verifySkillDraft({ draft, evidenceTraces });
      if (!verdict.ok) {
        logEvolutionDecision(job, "skill_crystallization", "verification_failed", {
          policyId: policy.id,
          verdict
        });
        this.repos.runtime.appendChange({
          memoryId: policyMemory.id,
          namespaceId: namespaceIdFromMemory(policyMemory),
          kind: "skill",
          op: "skipped",
          entityId: policyMemory.id,
          userId,
          changeType: "skill_verification_failed",
          after: { policyId: policy.id, verdict },
          source: "worker.skill_crystallization.v7",
          createdAt: at
        });
        continue;
      }
      const evidenceAnchorIds = evidenceTraces.map((trace) => trace.id).slice(0, 10);
      const verifiedDraft: SkillDraft = {
        ...draft,
        sourceTraceIds: evidenceAnchorIds,
        evidenceAnchorIds: uniq([...evidenceAnchorIds, ...draft.evidenceAnchorIds]).slice(0, 10)
      };
      const skill = this.buildMemory({
        userId,
        conversationId: policyMemory.conversationId,
        sessionId: policyMemory.sessionId ?? job.sessionId,
        agentId: policyMemory.agentId,
        appId: policyMemory.appId,
        projectId: projectIdFromMemory(policyMemory),
        profileId: profileIdFromMemory(policyMemory),
        layer: "Skill",
        kind: "skill",
        lifecycleStatus: verifiedDraft.status,
        memoryType: "SkillMemory",
        key: verifiedDraft.key,
        value: verifiedDraft.invocationGuide,
        tags: verifiedDraft.tags,
        info: {
          name: verifiedDraft.name,
          eta: verifiedDraft.eta,
          status: verifiedDraft.status,
          source_memory_ids: verifiedDraft.sourcePolicyIds
        },
        internal: {
          source: "worker.skill_crystallization.v7",
          plugin_algorithm: "skill.crystallization.v7",
          source_memory_ids: verifiedDraft.sourcePolicyIds,
          source_policy_ids: verifiedDraft.sourcePolicyIds,
          source_world_model_ids: verifiedDraft.sourceWorldModelIds,
          evidence_anchor_ids: verifiedDraft.evidenceAnchorIds,
          name: verifiedDraft.name,
          invocation_guide: verifiedDraft.invocationGuide,
          procedure_json: verifiedDraft.procedureJson,
          eta: verifiedDraft.eta,
          support: verifiedDraft.support,
          gain: verifiedDraft.gain,
          policy_content_hash: skillPolicyContentHash(policy),
          skill: {
            name: verifiedDraft.name,
            eta: verifiedDraft.eta,
            status: verifiedDraft.status,
            support: verifiedDraft.support,
            gain: verifiedDraft.gain,
            policy_content_hash: skillPolicyContentHash(policy),
            source_policy_ids: verifiedDraft.sourcePolicyIds,
            source_world_model_ids: verifiedDraft.sourceWorldModelIds,
            evidence_anchor_ids: verifiedDraft.evidenceAnchorIds,
            invocation_guide: verifiedDraft.invocationGuide,
            procedure_json: verifiedDraft.procedureJson,
            trials_attempted: verifiedDraft.trialsAttempted,
            trials_passed: verifiedDraft.trialsPassed,
            success_rate: verifiedDraft.successRate,
            beta_posterior: verifiedDraft.betaPosterior,
            vec: verifiedDraft.vec,
            verification: verdict
          }
        },
        createdAt: at
      });
      const upsert = this.upsertEvolutionMemory(skill);
      for (const episodeId of uniq(evidenceTraces.map((trace) => trace.episodeId).filter((id): id is string => Boolean(id)))) {
        this.repos.runtime.appendEpisodeDerivedMemory(episodeId, "Skill", upsert.memory.id, at);
      }
      this.repos.runtime.appendChange({
        memoryId: upsert.memory.id,
        namespaceId: namespaceIdFromMemory(upsert.memory),
        kind: kindFromMemory(upsert.memory),
        op: upsert.created ? "created" : "updated",
        entityId: upsert.memory.id,
        userId,
        changeType: upsert.created ? "create" : "update",
        before: upsert.previous,
        after: upsert.memory,
        source: "worker.skill_crystallization.v7",
        createdAt: at
      });
      this.recordApiLog(
        upsert.created ? "skill_generate" : "skill_evolve",
        { phase: "done", skillId: upsert.memory.id, policyId: policy.id },
        {
          skillId: upsert.memory.id,
          kind: upsert.created ? "skill.crystallized" : "skill.rebuilt",
          name: verifiedDraft.name,
          status: verifiedDraft.status,
          eta: verifiedDraft.eta,
          sourcePolicyIds: verifiedDraft.sourcePolicyIds
        },
        0,
        true,
        at
      );
      if (this.config.algorithm.capture.embedAfterCapture) {
        this.enqueueJob({
          jobType: "embedding",
          userId,
          sessionId: policyMemory.sessionId ?? job.sessionId,
          episodeId: job.episodeId,
          targetMemoryId: upsert.memory.id,
          payload: { reason: "skill.upserted" },
          createdAt: at
        });
      }
    }
  }

  private findExistingSkillForPolicy(
    policy: PolicyMeta,
    userId: string
  ): NonNullable<ReturnType<typeof skillMetaFromMemory>> | null {
    const candidates = this.repos.memories
      .list({ memoryLayer: "Skill" }, 1000)
      .map(skillMetaFromMemory)
      .filter((skill): skill is NonNullable<ReturnType<typeof skillMetaFromMemory>> =>
        Boolean(skill &&
          skill.status !== "archived" &&
          skill.sourcePolicyIds.includes(policy.id))
      )
      .sort((a, b) => Date.parse(b.memory.updatedAt) - Date.parse(a.memory.updatedAt));
    return candidates[0] ?? null;
  }

  private isSkillCrystallizationInCooldown(policy: PolicyMeta, at: string): boolean {
    const cooldownMs = this.config.algorithm.skill.cooldownMs;
    if (cooldownMs <= 0) return false;
    const lastRunAt = this.skillCrystallizationRuns.get(this.skillCrystallizationCooldownKey(policy));
    if (!lastRunAt) return false;
    const now = Date.parse(at);
    if (!Number.isFinite(now)) return false;
    return now - lastRunAt < cooldownMs;
  }

  private markSkillCrystallizationRun(policy: PolicyMeta, at: string): void {
    if (this.config.algorithm.skill.cooldownMs <= 0) return;
    const now = Date.parse(at);
    if (!Number.isFinite(now)) return;
    this.skillCrystallizationRuns.set(this.skillCrystallizationCooldownKey(policy), now);
  }

  private skillCrystallizationCooldownKey(policy: PolicyMeta): string {
    return policy.id;
  }

  private upsertEvolutionMemory(memory: MemoryRow): {
    memory: MemoryRow;
    created: boolean;
    previous?: MemoryRow;
  } {
    const previous = memory.memoryKey
      ? this.repos.memories.getByKey(memory.userId, memory.memoryLayer, memory.memoryKey)
      : undefined;
    if (previous && this.isArchivedEvolutionMemory(previous)) {
      return {
        memory: this.repos.memories.insert(memory),
        created: true
      };
    }
    return this.repos.memories.upsertByKey(memory);
  }

  private isArchivedEvolutionMemory(memory: MemoryRow): boolean {
    if (memory.status === "archived") return true;
    if (memory.memoryLayer === "L2") {
      return policyMetaFromMemory(memory)?.status === "archived";
    }
    if (memory.memoryLayer === "Skill") {
      return skillMetaFromMemory(memory)?.status === "archived";
    }
    return false;
  }

  private gatherSkillEvidence(policy: PolicyMeta, userId: string): TraceMeta[] {
    const byId = new Map<string, TraceMeta>();
    const episodeIds = new Set(policy.sourceEpisodeIds);
    const failureEpisodeIds = new Set(
      policy.sourceEpisodeIds.filter((episodeId) => this.isFailureEpisodeForSkillEvidence(episodeId))
    );
    if (episodeIds.size > 0) {
      const candidates = this.repos.memories
        .list({ memoryLayer: "L1", status: "activated" }, 1000)
        .map((memory) => this.traceMeta(memory))
        .filter((trace): trace is TraceMeta =>
          Boolean(trace?.episodeId &&
            episodeIds.has(trace.episodeId) &&
            !failureEpisodeIds.has(trace.episodeId))
        );
      for (const trace of candidates) byId.set(trace.id, trace);
    }
    for (const memory of this.repos.memories.getMany(policy.sourceTraceIds)) {
      const trace = this.traceMeta(memory);
      if (trace && (!trace.episodeId || !failureEpisodeIds.has(trace.episodeId))) byId.set(trace.id, trace);
    }
    const traces = Array.from(byId.values())
      .filter((trace) =>
        trace.userText !== "[REDACTED]" &&
        trace.agentText !== "[REDACTED]" &&
        trace.value > this.config.algorithm.skill.outcomeRTaskFailureThreshold
      )
      .sort((a, b) => {
        const scoreA = this.skillEvidenceScore(a, policy);
        const scoreB = this.skillEvidenceScore(b, policy);
        if (scoreB !== scoreA) return scoreB - scoreA;
        return b.ts - a.ts;
      })
      .slice(0, Math.max(1, this.config.algorithm.skill.evidenceLimit));
    return traces.map((trace) => this.capSkillEvidenceTrace(trace));
  }

  private isFailureEpisodeForSkillEvidence(episodeId: string): boolean {
    const episode = this.repos.runtime.getEpisode(episodeId);
    if (!episode) return false;
    if (typeof episode.rTask === "number") {
      return episode.rTask <= this.config.algorithm.skill.outcomeRTaskFailureThreshold;
    }
    return episode.rewardDetail.skipped === true;
  }

  private gatherSkillCounterExamples(policy: PolicyMeta, userId: string): TraceMeta[] {
    if (policy.sourceEpisodeIds.length === 0) return [];
    const episodeIds = new Set(policy.sourceEpisodeIds);
    return this.repos.memories
      .list({ memoryLayer: "L1", status: "activated" }, 1000)
      .map((memory) => this.traceMeta(memory))
      .filter((trace): trace is TraceMeta =>
        Boolean(trace?.episodeId &&
          episodeIds.has(trace.episodeId) &&
          Number.isFinite(trace.value) &&
          trace.value < 0 &&
          trace.userText !== "[REDACTED]" &&
          trace.agentText !== "[REDACTED]")
      )
      .sort((a, b) => a.value - b.value || b.ts - a.ts)
      .slice(0, 5)
      .map((trace) => this.capSkillEvidenceTrace(trace));
  }

  private gatherWorldModelEvidence(policy: PolicyMeta, userId: string): TraceMeta[] {
    const byId = new Map<string, TraceMeta>();
    for (const memory of this.repos.memories.getMany(policy.sourceTraceIds)) {
      const trace = this.traceMeta(memory);
      if (trace) byId.set(trace.id, trace);
    }
    if (byId.size === 0 && policy.sourceEpisodeIds.length > 0) {
      const episodeIds = new Set(policy.sourceEpisodeIds);
      const traces = this.repos.memories
        .list({ memoryLayer: "L1", status: "activated" }, 1000)
        .map((memory) => this.traceMeta(memory))
        .filter((trace): trace is TraceMeta =>
          Boolean(trace?.episodeId &&
            episodeIds.has(trace.episodeId))
        );
      for (const trace of traces) byId.set(trace.id, trace);
    }
    const cap = Math.max(1, this.config.algorithm.l3Abstraction.traceCharCap);
    return Array.from(byId.values())
      .filter((trace) => trace.userText !== "[REDACTED]" && trace.agentText !== "[REDACTED]")
      .sort((a, b) => b.value - a.value || b.ts - a.ts)
      .slice(0, Math.max(0, this.config.algorithm.l3Abstraction.traceEvidencePerPolicy))
      .map((trace) => ({
        ...trace,
        userText: capText(trace.userText, cap),
        agentText: capText(trace.agentText, cap)
      }));
  }

  private skillEvidenceScore(trace: TraceMeta, policy: PolicyMeta): number {
    const value = Number.isFinite(trace.value) ? trace.value : 0;
    return value + 0.2 * cosine(trace.vecSummary, policy.vec);
  }

  private capSkillEvidenceTrace(trace: TraceMeta): TraceMeta {
    const cap = Math.max(1, this.config.algorithm.skill.traceCharCap);
    const userText = capSkillPromptText(trace.userText, cap);
    const agentText = capSkillPromptText(trace.agentText, cap);
    if (userText === trace.userText && agentText === trace.agentText) {
      return trace;
    }
    return { ...trace, userText, agentText };
  }

  private async queryVector(query: string): Promise<number[] | undefined> {
    try {
      return await withTimeout(this.embedder.embedOne(query, "query"), QUERY_VECTOR_TIMEOUT_MS);
    } catch (error) {
      pipelineLogger.warn("fallback.used", {
        operation: "retrieval.query_embedding",
        pipeline: "retrieval.query_vector",
        fallback: "text_only_retrieval",
        ...memoryErrorFields(error)
      });
      return undefined;
    }
  }

  private refsForMemory(memory: MemoryRow): Record<string, unknown> {
    if (memory.memoryLayer === "L1") {
      const rawTurnId = rawTurnIdFromMemory(memory);
      const rawTurn = rawTurnId ? this.repos.runtime.getRawTurn(rawTurnId) : undefined;
      const trace = traceMetaFromMemory(memory);
      const episode = rawTurn
        ? this.repos.runtime.getEpisode(rawTurn.episodeId)
        : trace?.episodeId
          ? this.repos.runtime.getEpisode(trace.episodeId)
          : undefined;
      return {
        rawTurn: rawTurn ? rawTurnSummary(rawTurn) : undefined,
        episode: episode ? episodeRef(episode) : undefined,
        policyLinks: this.repos.runtime.listTracePolicyLinks({
          userId: memory.userId,
          l1MemoryId: memory.id,
          limit: 50
        }).map(policyLinkRef)
      };
    }
    if (memory.memoryLayer === "L2") {
      return {
        policyLinks: this.repos.runtime.listTracePolicyLinks({
          userId: memory.userId,
          l2MemoryId: memory.id,
          limit: 100
        }).map(policyLinkRef)
      };
    }
    if (memory.memoryLayer === "Skill") {
      return {
        skillTrials: this.repos.runtime.listSkillTrials({
          userId: memory.userId,
          skillMemoryId: memory.id,
          limit: 100
        }).map((trial) => skillTrialRef(trial, trial.episodeId ? this.repos.runtime.getEpisode(trial.episodeId) : undefined))
      };
    }
    return {};
  }

  private async embedMemory(job: EvolutionJobRecord): Promise<void> {
    const item = this.prepareEmbeddingJob(job);
    if (!item) {
      return;
    }
    try {
      const [vector] = await this.embedder.embed([item.text], item.role);
      this.applyEmbeddingVector(item, vector ?? []);
    } catch (error) {
      if (this.repos.processing.get(item.memory.id)) {
        throw error;
      }
      const at = nowIso();
      const retry = this.enqueueEmbeddingRetry(item.memory, item.text, at, item.vectorField);
      this.appendEmbeddingRetryChange(retry, "queued", undefined, {
        code: "embedding_error",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private prepareEmbeddingJob(job: EvolutionJobRecord): PreparedEmbeddingJob | null {
    const memory = job.targetMemoryId ? this.repos.memories.get(job.targetMemoryId) : undefined;
    if (!memory) {
      throw new Error(`embedding target not found: ${job.targetMemoryId ?? "unknown"}`);
    }
    if (!processingJobMatchesMemory(job, memory)) {
      return null;
    }

    if (memory.memoryLayer === "L1") {
      if (memoryNeedsImportSummary(memory)) {
        this.enqueueImportSummaryIfMissing(memory, nowIso());
        return null;
      }
      const text = traceSummaryEmbeddingText(memory);
      if (!text) {
        this.enqueueImportSummaryIfMissing(memory, nowIso());
        return null;
      }
      return {
        job,
        memory,
        text,
        role: "document",
        vectorField: "vec_summary"
      };
    }

    const text = embeddingTextForMemory(memory);
    return {
      job,
      memory,
      text,
      role: "query",
      vectorField: "vec"
    };
  }

  private applyEmbeddingVector(item: PreparedEmbeddingJob, vector: number[]): void {
    const at = nowIso();
    const current = this.repos.memories.get(item.memory.id);
    if (!current) {
      throw new Error(`embedding target not found: ${item.memory.id}`);
    }
    if (!processingJobMatchesMemory(item.job, current)) {
      return;
    }
    this.repos.transaction(() => {
      const previous = current;
      const next = updateMemoryVectorField(current, item.vectorField, vector, {
          model: this.embedder.config.model ?? this.embedder.config.provider,
          provider: this.embedder.config.provider,
          updatedAt: at
        });
      const saved = this.repos.memories.updateMaintenance(current.memoryLayer === "L1"
        ? updateImportPipelineStatus(next, "indexed", at)
        : next);
      if (this.repos.processing.get(saved.id)) {
        this.repos.processing.update(saved.id, {
          state: "ready",
          stage: null,
          activeJobId: null,
          attemptCount: item.job.attempts,
          retryAction: "retry",
          errorCode: null,
          errorMessage: null,
          failedAt: null,
          updatedAt: at
        }, ["embedding_pending", "embedding"]);
        this.repos.runtime.completeJob(item.job.id, at);
      }
      this.repos.runtime.appendChange({
        memoryId: saved.id,
        namespaceId: namespaceIdFromMemory(saved),
        kind: kindFromMemory(saved),
        op: "updated",
        entityId: saved.id,
        userId: saved.userId,
        changeType: "update",
        before: previous,
        after: saved,
        source: "worker.embedding",
        createdAt: at
      });
    });
  }

  private async summarizeImportedTrace(job: EvolutionJobRecord): Promise<void> {
    const memory = job.targetMemoryId ? this.repos.memories.get(job.targetMemoryId) : undefined;
    if (!memory || memory.memoryLayer !== "L1") {
      throw new Error(`import summary target not found: ${job.targetMemoryId ?? "unknown"}`);
    }
    if (!processingJobMatchesMemory(job, memory)) {
      return;
    }
    const trace = this.traceMeta(memory);
    if (!trace) {
      throw new Error(`import trace payload is missing: ${memory.id}`);
    }

    const generatedSummary = this.llm.isConfigured()
      ? await this.summarizeTraceForCapture({
        trace,
        userText: trace.userText,
        agentText: trace.agentText,
        toolCalls: trace.toolCalls,
        reflectionText: ""
      }, { strict: true })
      : fallbackImportSummary(trace, memory);
    const summary = firstRealSummary(generatedSummary) ?? fallbackImportSummary(trace, memory);
    const at = nowIso();
    const current = this.repos.memories.get(memory.id);
    if (!current || !processingJobMatchesMemory(job, current)) {
      return;
    }
    this.repos.transaction(() => {
      const previous = current;
      const next = updateImportPipelineStatus(updateTraceImportSummary(current, {
        summary,
        alpha: IMPORT_DEFAULT_ALPHA,
        value: IMPORT_DEFAULT_VALUE,
        priority: IMPORT_DEFAULT_PRIORITY,
        tags: importStatusTags(memory.tags, "indexing"),
        updatedAt: at
      }), "indexing", at);
      const saved = this.repos.memories.update(next);
      this.repos.runtime.appendChange({
        memoryId: saved.id,
        namespaceId: namespaceIdFromMemory(saved),
        kind: kindFromMemory(saved),
        op: "updated",
        entityId: saved.id,
        userId: saved.userId,
        changeType: "update",
        before: previous,
        after: saved,
        source: "worker.import_summary",
        createdAt: at
      });
      this.enqueuePostImportEmbedding(saved, job, at);
    });
  }

  private async summarizeCapturedTrace(job: EvolutionJobRecord): Promise<void> {
    const memory = job.targetMemoryId ? this.repos.memories.get(job.targetMemoryId) : undefined;
    if (!memory || memory.memoryLayer !== "L1" || memoryHasImportPipeline(memory)) {
      throw new Error(`trace summary target is invalid: ${job.targetMemoryId ?? "unknown"}`);
    }
    if (!processingJobMatchesMemory(job, memory)) {
      return;
    }
    const trace = this.traceMeta(memory);
    if (!trace) {
      throw new Error(`trace payload is missing: ${memory.id}`);
    }

    const summary = this.llm.isConfigured()
      ? await this.summarizeTraceForCapture({
        trace,
        userText: trace.userText,
        agentText: trace.agentText,
        toolCalls: trace.toolCalls,
        reflectionText: trace.reflection ?? ""
      }, { strict: true })
      : trace.summary || fallbackTraceSummary(trace);
    const at = nowIso();
    const current = this.repos.memories.get(memory.id);
    if (!current || !processingJobMatchesMemory(job, current)) {
      return;
    }
    const currentTrace = this.traceMeta(current);
    if (!currentTrace) {
      throw new Error(`trace payload is missing: ${current.id}`);
    }
    this.repos.transaction(() => {
      const previous = current;
      const saved = summary.trim() && summary.trim() !== currentTrace.summary.trim()
        ? this.repos.memories.update(updateTraceSummary(current, {
          summary: summary.trim(),
          updatedAt: at
        }))
        : previous;
      if (saved !== previous) {
        this.repos.runtime.appendChange({
          memoryId: saved.id,
          namespaceId: namespaceIdFromMemory(saved),
          kind: kindFromMemory(saved),
          op: "updated",
          entityId: saved.id,
          userId: saved.userId,
          changeType: "update",
          before: previous,
          after: saved,
          source: "worker.trace_summary",
          createdAt: at
        });
      }
      this.enqueuePostTraceSummaryEmbedding(saved, job, at);
    });
  }

  private async reflectTrace(job: EvolutionJobRecord): Promise<void> {
    const memory = job.targetMemoryId ? this.repos.memories.get(job.targetMemoryId) : undefined;
    if (!memory || memory.memoryLayer !== "L1") {
      return;
    }
    const trace = this.traceMeta(memory);
    if (!trace || traceReflectionWasScored(memory)) {
      return;
    }
    const episodeId = job.episodeId ?? trace.episodeId;
    const episode = episodeId ? this.repos.runtime.getEpisode(episodeId) : undefined;
    if (episodeId && (!episode || episode.status !== "closed")) {
      return;
    }
    if (!this.skillLlm.isConfigured()) {
      if (this.applyUnconfiguredEpisodeDefault(job)) {
        if (episode) {
          this.enqueueEpisodeRewardAfterReflection(episode, nowIso(), "implicit_fallback");
        }
        return;
      }
      this.applyUnconfiguredTraceDefault(job, memory, trace);
      if (episode) {
        this.enqueueEpisodeRewardAfterReflection(episode, nowIso(), "implicit_fallback");
      }
      return;
    }
    if (await this.reflectEpisodeBatch(job)) {
      if (episode) {
        this.enqueueEpisodeRewardAfterReflection(episode, nowIso(), "implicit_fallback");
      }
      return;
    }
    this.applyUnconfiguredTraceDefault(job, memory, trace);
    if (episode) {
      this.enqueueEpisodeRewardAfterReflection(episode, nowIso(), "implicit_fallback");
    }
  }

  private async reflectSingleTrace(
    job: EvolutionJobRecord,
    memory: MemoryRow,
    trace: NonNullable<ReturnType<typeof traceMetaFromMemory>>
  ): Promise<void> {
    const rawTurnId = rawTurnIdFromMemory(memory);
    const rawTurn = rawTurnId ? this.repos.runtime.getRawTurn(rawTurnId) : undefined;
    const userText = rawTurn?.userText ?? trace.userText;
    const agentText = rawTurn?.assistantText ?? trace.agentText;
    const toolCalls = rawTurn?.toolCalls.filter(isToolCallPayload) ?? trace.toolCalls;
    const agentThinking = traceAgentThinking(memory);
    const taskSummary = this.reflectionTaskSummary(job, trace.summary);
    const downstreamPreview = this.reflectionDownstreamPreview(job, memory);
    const synthesized = trace.reflection
      ? null
      : await this.synthesizeTraceReflection({
        trace,
        taskSummary,
        userText,
        agentThinking,
        agentText,
        toolCalls,
        downstreamPreview
      });
    const reflectionText = trace.reflection ?? synthesized ?? "";
    const reflectionLang = detectDominantLanguage([
      userText,
      agentText,
      agentThinking,
      reflectionText
    ]);
    const summarized = await this.summarizeTraceForCapture({
      trace,
      userText,
      agentText,
      toolCalls,
      reflectionText
    });

    if (!this.config.algorithm.capture.alphaScoring) {
      const reflection = reflectionText || "RELATED_DEFAULT";
      const usable = true;
      const at = nowIso();
      const previous = memory;
      const saved = this.repos.memories.update(updateImportPipelineStatus(updateTraceReflection(memory, {
        summary: summarized,
        reflection,
        alpha: 0.5,
        usable,
        source: trace.reflection ? traceReflectionSource(memory) : "synth",
        tags: memoryHasImportPipeline(memory) ? importStatusTags(memory.tags, "indexing") : memory.tags,
        updatedAt: at
      }), "indexing", at));
      this.repos.runtime.appendChange({
        memoryId: saved.id,
        namespaceId: namespaceIdFromMemory(saved),
        kind: kindFromMemory(saved),
        op: "updated",
        entityId: saved.id,
        userId: saved.userId,
        changeType: "update",
        before: previous,
        after: saved,
        source: "worker.reflection.neutral_alpha",
        createdAt: at
      });
      this.enqueuePostReflectionEmbedding(saved, job, at);
      return;
    }

    const result = await this.skillLlm.completeJson<{
      summary?: unknown;
      reflection?: unknown;
      alpha?: unknown;
      usable?: unknown;
      tags?: unknown;
      reason?: unknown;
    }>([
      {
        role: "system",
        content: REFLECTION_SCORE_PROMPT.system
      },
      {
        role: "system",
        content: languageSteeringLine(reflectionLang)
      },
      {
        role: "user",
        content: traceReflectionScorePayload({
          taskSummary,
          userText,
          agentThinking,
          agentText,
          toolCalls,
          downstreamPreview,
          reflectionText
        })
      }
    ], {
      operation: `capture.alpha.${REFLECTION_SCORE_PROMPT.id}.v${REFLECTION_SCORE_PROMPT.version}`,
      thinkingMode: "disabled",
      temperature: 0,
      maxTokens: 700
    });

    const summary = stringOr(result.summary, summarized);
    const reflection = stringOr(result.reflection, reflectionText);
    const usable = typeof result.usable === "boolean" ? result.usable : Boolean(reflection);
    const rawAlpha = clampNumber(numberOr(result.alpha, trace.alpha || 0.5), 0, 1);
    const alpha = usable ? rawAlpha : 0;
    const modelTags = stringArray(result.tags).slice(0, 8);
    const reflectionTags = uniq([...memory.tags, ...modelTags]);
    const tags = memoryHasImportPipeline(memory)
      ? importStatusTags(reflectionTags, "indexing")
      : reflectionTags;
    const at = nowIso();
    const previous = memory;
    const next = updateImportPipelineStatus(updateTraceReflection(memory, {
      summary,
      reflection,
      alpha,
      usable,
      source: trace.reflection ? traceReflectionSource(memory) : reflection ? "synth" : "none",
      tags,
      updatedAt: at
    }), "indexing", at);
    const saved = this.repos.memories.update(next);
    this.repos.runtime.appendChange({
      memoryId: saved.id,
      namespaceId: namespaceIdFromMemory(saved),
      kind: kindFromMemory(saved),
      op: "updated",
      entityId: saved.id,
      userId: saved.userId,
      changeType: "update",
      before: previous,
      after: saved,
      source: "worker.reflection.v7",
      createdAt: at
    });
    this.enqueuePostReflectionEmbedding(saved, job, at);
  }

  private async reflectEpisodeBatch(job: EvolutionJobRecord): Promise<boolean> {
    const cfg = this.config.algorithm.capture;
    if (!cfg.alphaScoring || !job.episodeId) {
      return false;
    }
    const episode = this.repos.runtime.getEpisode(job.episodeId);
    if (!episode || episode.status !== "closed" || episode.l1MemoryIds.length === 0) {
      return false;
    }
    const memories = this.repos.memories.getMany(episode.l1MemoryIds)
      .filter((memory) => memory.memoryLayer === "L1")
      .sort((a, b) => traceSortKey(a) - traceSortKey(b));
    if (memories.length === 0) {
      return false;
    }
    const unscored = memories.filter((memory) => !traceReflectionWasScored(memory));
    if (unscored.length === 0) {
      return true;
    }

    const primary = await this.runBatchReflectionWindowPass(
      episode,
      memories,
      cfg.reflectionBatchWindowSize,
      cfg.reflectionBatchOverlap,
      cfg.reflectionBatchPrimaryMaxRetries
    );
    if (primary.success) {
      await this.applyBatchReflectionScores(job, memories, mergeBatchWindowScores(memories.length, primary.results));
      return true;
    }

    const degraded = await this.runBatchReflectionWindowPass(
      episode,
      memories,
      cfg.reflectionBatchDegradedWindowSize,
      cfg.reflectionBatchDegradedOverlap,
      cfg.reflectionBatchDegradedMaxRetries
    );
    if (degraded.success) {
      await this.applyBatchReflectionScores(job, memories, mergeBatchWindowScores(memories.length, degraded.results));
      return true;
    }

    const payload = this.batchReflectionPayload(episode, memories);
    await this.applyBatchReflectionScores(job, memories, batchRelatedDefaultScores(
      memories.length,
      Array.isArray(payload.steps) ? payload.steps : undefined
    ));
    return true;
  }

  private async runBatchReflectionWindowPass(
    episode: EpisodeRecord,
    memories: MemoryRow[],
    windowSize: number,
    overlap: number,
    maxRetries: number
  ): Promise<{ success: boolean; results: Map<number, BatchReflectionScore[]>; failedWindows: number }> {
    const windows = buildBatchWindows(memories.length, windowSize, overlap);
    const results = new Map<number, BatchReflectionScore[]>();
    let failedWindows = 0;
    for (const win of windows) {
      let ok = false;
      const windowMemories = memories.slice(win.start, win.end);
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
          const scores = await this.scoreBatchReflectionWindow(episode, windowMemories);
          results.set(win.start, scores);
          ok = true;
          break;
        } catch (error) {
          pipelineLogger.warn("batch_window.failed", {
            operation: BATCH_REFLECTION_OPERATION,
            pipeline: "reflection.batch_score",
            episodeId: episode.id,
            windowStart: win.start,
            windowEnd: win.end,
            attempt: attempt + 1,
            maxAttempts: maxRetries + 1,
            ...memoryErrorFields(error)
          });
          if (attempt === maxRetries) {
            failedWindows += 1;
          }
        }
      }
      if (!ok && failedWindows === 0) failedWindows += 1;
    }
    return { success: failedWindows === 0, results, failedWindows };
  }

  private async scoreBatchReflectionWindow(
    episode: EpisodeRecord,
    memories: MemoryRow[]
  ): Promise<BatchReflectionScore[]> {
    const payload = this.batchReflectionPayload(episode, memories);
    const steps = Array.isArray(payload.steps) ? payload.steps : [];
    if (steps.length !== memories.length) {
      throw new Error(`batch reflection payload length mismatch: expected ${memories.length}`);
    }
    const directScores = new Map<number, BatchReflectionScore>();
    const modelStepIndices: number[] = [];
    steps.forEach((value, idx) => {
      const step = isRecord(value) ? value : undefined;
      if (isSocialOnlyBatchReflectionStep(step)) {
        directScores.set(idx, socialOnlyBatchReflectionScore(idx));
      } else {
        modelStepIndices.push(idx);
      }
    });
    if (modelStepIndices.length === 0) {
      return Array.from({ length: steps.length }, (_, idx) => directScores.get(idx)!);
    }
    const modelPayload = {
      ...payload,
      steps: modelStepIndices.map((sourceIdx, idx) => ({
        ...(isRecord(steps[sourceIdx]) ? steps[sourceIdx] : {}),
        idx
      }))
    };
    const lang = detectDominantLanguage(memories.flatMap((memory) => {
      const trace = traceMetaFromMemory(memory);
      return trace
        ? [trace.userText, trace.agentText, traceAgentThinking(memory), trace.reflection]
        : [];
    }));
    const result = await this.skillLlm.completeJson<{
      scores?: unknown;
    }>([
      {
        role: "system",
        content: BATCH_REFLECTION_PROMPT.system
      },
      {
        role: "system",
        content: languageSteeringLine(lang)
      },
      {
        role: "user",
        content: stableStringify(modelPayload)
      }
    ], {
      operation: BATCH_REFLECTION_OPERATION,
      thinkingMode: "disabled",
      temperature: 0,
      maxTokens: Math.max(1200, modelStepIndices.length * 220)
    });
    const modelScores = parseBatchReflectionScores(result.scores, modelStepIndices.length);
    for (const score of modelScores) {
      const sourceIdx = modelStepIndices[score.idx];
      if (sourceIdx === undefined) {
        throw new Error(`batch reflection model score idx out of range: ${score.idx}`);
      }
      directScores.set(sourceIdx, { ...score, idx: sourceIdx });
    }
    return Array.from({ length: steps.length }, (_, idx) => {
      const score = directScores.get(idx);
      if (!score) throw new Error(`batch reflection score missing idx: ${idx}`);
      return score;
    });
  }

  private async applyBatchReflectionScores(
    job: EvolutionJobRecord,
    memories: MemoryRow[],
    scores: BatchReflectionScore[]
  ): Promise<void> {
    const at = nowIso();
    for (const [index, score] of scores.entries()) {
      const memory = memories[index];
      if (!memory || traceReflectionWasScored(memory)) {
        continue;
      }
      const trace = this.traceMeta(memory);
      if (!trace) {
        continue;
      }
      const incoming = trace.reflection?.trim() ?? "";
      const reflection = incoming || score.reflectionText;
      const usable = score.usable;
      const alpha = clampNumber(score.alpha, 0, 1);
      const summary = await this.summarizeTraceForCapture({
        trace,
        userText: trace.userText,
        agentText: trace.agentText,
        toolCalls: trace.toolCalls,
        reflectionText: reflection
      });
      const previous = memory;
      const saved = this.repos.memories.update(updateImportPipelineStatus(updateTraceReflection(memory, {
        summary,
        reflection,
        alpha,
        usable,
        reason: score.reason,
        source: incoming ? traceReflectionSource(memory) : score.reflectionText === "RELATED_DEFAULT" ? "none" : "synth",
        tags: memoryHasImportPipeline(memory) ? importStatusTags(memory.tags, "indexing") : memory.tags,
        updatedAt: at
      }), "indexing", at));
      this.repos.runtime.appendChange({
        memoryId: saved.id,
        namespaceId: namespaceIdFromMemory(saved),
        kind: kindFromMemory(saved),
        op: "updated",
        entityId: saved.id,
        userId: saved.userId,
        changeType: "update",
        before: previous,
        after: saved,
        source: "worker.reflection.batch.v13",
        createdAt: at
      });
      this.enqueuePostReflectionEmbedding(saved, job, at);
    }
  }

  private applyUnconfiguredEpisodeDefault(job: EvolutionJobRecord): boolean {
    if (!job.episodeId) return false;
    const episode = this.repos.runtime.getEpisode(job.episodeId);
    if (!episode || episode.status !== "closed" || episode.l1MemoryIds.length === 0) return false;
    const memories = this.repos.memories.getMany(episode.l1MemoryIds)
      .filter((memory) => memory.memoryLayer === "L1")
      .sort((a, b) => traceSortKey(a) - traceSortKey(b));
    if (memories.length === 0) return false;
    const at = nowIso();
    for (const candidate of memories) {
      if (traceReflectionWasScored(candidate)) continue;
      const candidateTrace = this.traceMeta(candidate);
      if (!candidateTrace) continue;
      this.applyUnconfiguredTraceDefault(job, candidate, candidateTrace, at);
    }
    return true;
  }

  private applyUnconfiguredTraceDefault(
    job: EvolutionJobRecord,
    memory: MemoryRow,
    trace: NonNullable<ReturnType<typeof traceMetaFromMemory>>,
    at = nowIso()
  ): void {
    const next = updateImportPipelineStatus(updateTraceReflection(memory, {
      summary: trace.summary || fallbackTraceSummary(trace),
      reflection: "RELATED_DEFAULT",
      alpha: 0.5,
      usable: true,
      reason: "llm unavailable; default related path relevance",
      source: "none",
      tags: memoryHasImportPipeline(memory) ? importStatusTags(memory.tags, "indexing") : memory.tags,
      updatedAt: at
    }), "indexing", at);
    const saved = next === memory ? memory : this.repos.memories.update(next);
    if (saved !== memory) {
      this.repos.runtime.appendChange({
        memoryId: saved.id,
        namespaceId: namespaceIdFromMemory(saved),
        kind: kindFromMemory(saved),
        op: "updated",
        entityId: saved.id,
        userId: saved.userId,
        changeType: "update",
        before: memory,
        after: saved,
        source: "worker.reflection.unconfigured",
        createdAt: at
      });
    }
    this.enqueuePostReflectionEmbedding(saved, job, at);
  }

  private batchReflectionPayload(episode: EpisodeRecord, memories: MemoryRow[]): Record<string, unknown> {
    const cfg = this.config.algorithm.capture;
    const rawTurns = this.repos.runtime.listRawTurnsByEpisode(episode.id, 100);
    return {
      host_context: {
        reflectionProvider: this.skillLlm.config.provider,
        reflectionModel: this.skillLlm.config.model,
        sessionId: episode.sessionId
      },
      task_context: reflectionContextIncludesTask(this.config.algorithm.capture.reflectionContextMode)
        ? batchTaskContext(episode, rawTurns, this.config.algorithm.capture.taskContextMaxChars)
        : null,
      steps: memories.map((memory, index) => {
        const trace = traceMetaFromMemory(memory);
        const userText = trace?.userText ?? "";
        const agentText = trace?.agentText ?? "";
        const toolCalls = trace?.toolCalls ?? [];
        return {
          idx: index,
          state: clip(userText, cfg.reflectionBatchStepStateChars),
          thinking: clip(traceAgentThinking(memory) ?? "", cfg.reflectionBatchStepThinkingChars),
          action: clip(agentText, cfg.reflectionBatchStepActionChars) || "(none)",
          tool_calls: toolCalls.map((call) => ({
            name: call.name,
            input: clip(stringifyForMemory(call.input), cfg.reflectionBatchToolInputChars),
            output: clip(stringifyForMemory(call.output), cfg.reflectionBatchToolOutputChars),
            errorCode: call.error ? clip(call.error, cfg.reflectionBatchToolErrorChars) : null
          })),
          outcome: lastReflectionToolOutcome(toolCalls, cfg.reflectionBatchOutcomeChars),
          reflection: clip(trace?.reflection ?? "", cfg.reflectionBatchReflectionChars),
          synth_allowed: this.config.algorithm.capture.synthReflection
        };
      })
    };
  }

  private async synthesizeTraceReflection(input: {
    trace: NonNullable<ReturnType<typeof traceMetaFromMemory>>;
    taskSummary: string;
    userText: string;
    agentThinking?: string;
    agentText: string;
    toolCalls: ToolCallPayload[];
    downstreamPreview: string;
  }): Promise<string | null> {
    if (!this.config.algorithm.capture.synthReflection) {
      return null;
    }
    try {
      const text = await this.skillLlm.complete([
        {
          role: "system",
          content: TRACE_REFLECTION_SYNTH_SYSTEM_PROMPT
        },
        {
          role: "user",
          content: traceReflectionSynthPayload({
            taskSummary: input.taskSummary,
            userText: input.userText,
            agentThinking: input.agentThinking,
            agentText: input.agentText,
            toolCalls: input.toolCalls,
            downstreamPreview: input.downstreamPreview
          })
        }
      ], {
        operation: "capture.reflection.synth",
        thinkingMode: "disabled",
        temperature: 0.1,
        maxTokens: 500
      });
      const cleaned = sanitizeReflectionText(text);
      return cleaned && cleaned !== "NO_REFLECTION" ? clip(cleaned, 1500) : null;
    } catch (error) {
      pipelineLogger.warn("fallback.used", {
        operation: "capture.reflection.synth",
        pipeline: "reflection.synthesis",
        fallback: "no_synthetic_reflection",
        ...memoryErrorFields(error)
      });
      return null;
    }
  }

  private reflectionTaskSummary(job: EvolutionJobRecord, fallback: string): string {
    if (!reflectionContextIncludesTask(this.config.algorithm.capture.reflectionContextMode)) {
      return "";
    }
    if (!job.episodeId) {
      return fallback;
    }
    const episode = this.repos.runtime.getEpisode(job.episodeId);
    if (!episode) {
      return fallback;
    }
    const rawTurns = this.repos.runtime.listRawTurnsByEpisode(episode.id, 100);
    return batchTaskContext(episode, rawTurns, this.config.algorithm.capture.taskContextMaxChars) ?? fallback;
  }

  private reflectionDownstreamPreview(job: EvolutionJobRecord, memory: MemoryRow): string {
    const cfg = this.config.algorithm.capture;
    if (
      !job.episodeId ||
      cfg.longEpisodeReflectMode !== "per_step_downstream" ||
      !reflectionContextIncludesDownstream(cfg.reflectionContextMode) ||
      cfg.downstreamStepCount <= 0 ||
      cfg.downstreamContextMaxChars <= 0
    ) {
      return "(none)";
    }
    const episode = this.repos.runtime.getEpisode(job.episodeId);
    if (!episode || episode.l1MemoryIds.length <= cfg.batchThreshold) {
      return "(none)";
    }
    const memories = this.repos.memories.getMany(episode.l1MemoryIds)
      .filter((item) => item.memoryLayer === "L1")
      .sort((a, b) => traceSortKey(a) - traceSortKey(b));
    const index = memories.findIndex((item) => item.id === memory.id);
    if (index < 0) {
      return "(none)";
    }
    const lines: string[] = [];
    let usedChars = 0;
    const count = Math.max(0, Math.min(3, Math.floor(cfg.downstreamStepCount)));
    for (let offset = 1; offset <= count; offset += 1) {
      const next = memories[index + offset];
      if (!next) break;
      const remaining = cfg.downstreamContextMaxChars - usedChars;
      if (remaining <= 0) break;
      const block = traceDownstreamPreviewBlock(next, offset, Math.min(cfg.downstreamPerStepMaxChars, remaining));
      if (!block) continue;
      usedChars += block.length;
      lines.push(block);
    }
    return lines.length ? lines.join("\n\n") : "(none)";
  }

  private async summarizeTraceForCapture(input: {
    trace: NonNullable<ReturnType<typeof traceMetaFromMemory>>;
    userText: string;
    agentText: string;
    toolCalls: ToolCallPayload[];
    reflectionText: string;
  }, options: { strict?: boolean } = {}): Promise<string> {
    const messages = [
      {
        role: "system" as const,
        content: CAPTURE_SUMMARY_SYSTEM_PROMPT
      },
      {
        role: "user" as const,
        content: traceSummaryPayload(input)
      }
    ];
    const summarizeWith = async (
      llm: LlmClient,
      thinkingMode?: "disabled"
    ): Promise<string> => {
      const result = await llm.completeJson<{
        summary?: unknown;
      }>(messages, {
        operation: "capture.summarize",
        thinkingMode,
        temperature: 0,
        maxTokens: MEMORY_SUMMARY_MAX_TOKENS
      });
      const summary = sanitizeSummaryText(stringOr(result.summary, ""));
      return summary || input.trace.summary;
    };

    try {
      return await summarizeWith(this.llm);
    } catch (primaryError) {
      const logContext = {
        operation: "capture.summarize",
        pipeline: "trace.summary",
        sourceMemoryId: input.trace.id,
        episodeId: input.trace.episodeId,
        primaryModel: this.llm.config.model,
        fallbackModel: this.skillLlm.config.model
      };
      if (this.llm.isConfigured() && this.skillLlm.isConfigured() && this.skillLlm !== this.llm) {
        pipelineLogger.warn("summary.fallback_started", {
          ...logContext,
          ...memoryErrorFields(primaryError)
        });
        try {
          const summary = await summarizeWith(this.skillLlm, "disabled");
          pipelineLogger.info("summary.fallback_succeeded", logContext);
          return summary;
        } catch (fallbackError) {
          pipelineLogger.error("summary.fallback_failed", {
            ...logContext,
            primaryErrorMessage: primaryError instanceof Error ? primaryError.message : String(primaryError),
            fallbackErrorMessage: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
          });
          if (options.strict) throw fallbackError;
        }
      } else if (options.strict) {
        throw primaryError;
      }
      pipelineLogger.warn("fallback.used", {
        ...logContext,
        fallback: "existing_summary",
        ...memoryErrorFields(primaryError)
      });
      return input.trace.summary;
    }
  }

  private enqueuePostReflectionEmbedding(memory: MemoryRow, job: EvolutionJobRecord, at: string): void {
    if (this.repos.processing.get(memory.id)) {
      this.repos.memories.deleteVector(memory.id, "vec_summary");
    }
    if (!this.config.algorithm.capture.embedAfterCapture) {
      this.repos.processing.update(memory.id, {
        state: "ready_text_only",
        stage: null,
        activeJobId: null,
        attemptCount: 0,
        retryAction: "retry",
        errorCode: null,
        errorMessage: null,
        failedAt: null,
        updatedAt: at
      });
      return;
    }
    const embeddingJob = this.enqueueJob({
      jobType: "embedding",
      userId: memory.userId,
      sessionId: memory.sessionId,
      episodeId: job.episodeId,
      targetMemoryId: memory.id,
      payload: {
        reason: "reflection.updated",
        sourceJobId: job.id,
        contentHash: memory.contentHash
      },
      maxAttempts: 6,
      createdAt: at
    });
    this.repos.processing.update(memory.id, {
      state: "embedding_pending",
      stage: "embedding",
      activeJobId: embeddingJob.id,
      attemptCount: 0,
      retryAction: "retry",
      errorCode: null,
      errorMessage: null,
      failedAt: null,
      updatedAt: at
    });
  }

  private enqueuePostTraceSummaryEmbedding(memory: MemoryRow, job: EvolutionJobRecord, at: string): void {
    if (!this.config.algorithm.capture.embedAfterCapture) {
      this.repos.processing.update(memory.id, {
        state: "ready_text_only",
        stage: null,
        activeJobId: null,
        attemptCount: job.attempts,
        retryAction: "retry",
        errorCode: null,
        errorMessage: null,
        failedAt: null,
        updatedAt: at
      }, ["summary_pending", "summarizing"]);
      return;
    }
    const embeddingJob = this.enqueueJob({
      jobType: "embedding",
      userId: memory.userId,
      sessionId: memory.sessionId,
      episodeId: job.episodeId,
      targetMemoryId: memory.id,
      payload: {
        reason: "trace.summary.updated",
        sourceJobId: job.id,
        contentHash: memory.contentHash
      },
      maxAttempts: 6,
      createdAt: at
    });
    this.repos.processing.update(memory.id, {
      state: "embedding_pending",
      stage: "embedding",
      activeJobId: embeddingJob.id,
      attemptCount: 0,
      retryAction: "retry",
      errorCode: null,
      errorMessage: null,
      failedAt: null,
      updatedAt: at
    }, ["summary_pending", "summarizing"]);
  }

  private enqueuePostImportEmbedding(memory: MemoryRow, job: EvolutionJobRecord, at: string): void {
    if (!this.config.algorithm.capture.embedAfterCapture) {
      this.repos.processing.update(memory.id, {
        state: "ready_text_only",
        stage: null,
        activeJobId: null,
        attemptCount: 0,
        retryAction: "retry",
        errorCode: null,
        errorMessage: null,
        failedAt: null,
        updatedAt: at
      }, ["summary_pending", "summarizing"]);
      return;
    }
    const embeddingJob = this.enqueueJob({
      jobType: "embedding",
      userId: memory.userId,
      sessionId: memory.sessionId,
      episodeId: job.episodeId,
      targetMemoryId: memory.id,
      payload: {
        reason: "import.summary.updated",
        sourceJobId: job.id,
        contentHash: memory.contentHash
      },
      maxAttempts: 6,
      createdAt: at
    });
    this.repos.processing.update(memory.id, {
      state: "embedding_pending",
      stage: "embedding",
      activeJobId: embeddingJob.id,
      attemptCount: 0,
      retryAction: "retry",
      errorCode: null,
      errorMessage: null,
      failedAt: null,
      updatedAt: at
    }, ["summary_pending", "summarizing"]);
  }

  private associateL2(job: EvolutionJobRecord): void {
    const source = job.targetMemoryId ? this.repos.memories.get(job.targetMemoryId) : undefined;
    if (!source) return;
    const trace = this.traceMeta(source);
    if (!trace || !this.isTraceEligibleForL2(trace)) return;
    const signature = signatureFromTrace(trace);
    const policies = this.repos.memories
      .list({ memoryLayer: "L2", status: ["activated", "resolving"] }, 1000)
      .map(policyMetaFromMemory)
      .filter((policy): policy is PolicyMeta =>
        Boolean(policy)
      );
    const at = nowIso();
    let best: { policy: PolicyMeta; similarity: ReturnType<typeof tracePolicySimilarity> } | null = null;
    for (const policy of policies) {
      const similarity = tracePolicySimilarity(trace, policy);
      if (!best || similarity.score > best.similarity.score) {
        best = { policy, similarity };
      }
    }
    if (!best || best.similarity.score < this.config.algorithm.l2Induction.minSimilarity) {
      return;
    }
    const matchedPolicy = best.policy;
    this.repos.runtime.insertTracePolicyLink({
      userId: source.userId,
      l1MemoryId: source.id,
      l2MemoryId: matchedPolicy.id,
      relation: matchedPolicy.signature === signature ? "matches_signature" : "similar_pattern",
      strength: best.similarity.cosine,
      createdAt: at
    });
    if (trace.episodeId) {
      this.repos.runtime.appendEpisodeDerivedMemory(trace.episodeId, "L2", matchedPolicy.id, at);
    }
    this.recomputePolicyStats(matchedPolicy.id, source.userId, at, trace.episodeId);
  }

  private findExistingPolicyForL2Bucket(
    signature: string,
    evidenceTraces: TraceMeta[],
    userId: string
  ): PolicyMeta | null {
    if (evidenceTraces.length === 0) return null;
    const policies = this.repos.memories
      .list({ memoryLayer: "L2", status: ["activated", "resolving"] }, 1000)
      .map(policyMetaFromMemory)
      .filter((policy): policy is PolicyMeta =>
        Boolean(policy)
      );
    let best: { policy: PolicyMeta; score: number } | null = null;
    for (const policy of policies) {
      const scores = evidenceTraces
        .map((trace) => {
          if (policy.signature === signature) return 1;
          const similarity = tracePolicySimilarity(trace, policy);
          return similarity.score >= this.config.algorithm.l2Induction.minSimilarity ? similarity.score : 0;
        })
        .filter((score) => score > 0);
      if (scores.length === 0) continue;
      const avgScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;
      if (!best || avgScore > best.score) {
        best = { policy, score: avgScore };
      }
    }
    return best?.policy ?? null;
  }

  private recomputePolicyStats(policyId: string, userId: string, at: string, triggerEpisodeId?: string): void {
    const memory = this.repos.memories.get(policyId);
    if (!memory || memory.memoryLayer !== "L2") return;
    const policy = policyMetaFromMemory(memory);
    if (!policy) return;
    const linkedTraceIds = new Set(
      this.repos.runtime
        .listTracePolicyLinks({ userId, l2MemoryId: policy.id, limit: 1000 })
        .map((link) => link.l1MemoryId)
    );
    const allTraces = this.repos.memories
      .list({ memoryLayer: "L1", status: "activated" }, 1000)
      .map((memory) => this.traceMeta(memory))
      .filter((trace): trace is TraceMeta =>
        Boolean(trace &&
          this.isTraceEligibleForL2(trace))
      );
    const linkedTraces = allTraces.filter((trace) => linkedTraceIds.has(trace.id));
    const evidenceTraces = linkedTraces;
    if (evidenceTraces.length === 0) return;
    const gainReferenceTraces = this.l2GainReferenceTraces(evidenceTraces, triggerEpisodeId);
    const stats = buildPolicyDraft({
      signature: policy.signature,
      evidenceTraces,
      allTraces: gainReferenceTraces,
      minSupport: this.config.algorithm.l2Induction.minEpisodesForInduction,
      minGain: this.config.algorithm.l2Induction.minGain,
      archiveGain: this.config.algorithm.l2Induction.archiveGain,
      tauSoftmax: this.config.algorithm.l2Induction.tauSoftmax,
      gainEmaAlpha: this.config.algorithm.l2Induction.gainEmaAlpha,
      currentStatus: policy.status,
      currentGain: policy.gain,
      currentSupport: policy.support
    });
    const previous = memory;
    const next = updatePolicyStats(memory, {
      support: stats.support,
      gain: stats.gain,
      rawGain: stats.rawGain,
      status: stats.status,
      sourceEpisodeIds: stats.sourceEpisodeIds,
      sourceTraceIds: stats.sourceTraceIds,
      updatedAt: at
    });
    const saved = this.repos.memories.update(next);
    for (const episodeId of stats.sourceEpisodeIds) {
      this.repos.runtime.appendEpisodeDerivedMemory(episodeId, "L2", saved.id, at);
    }
    this.repos.runtime.appendChange({
      memoryId: saved.id,
      namespaceId: namespaceIdFromMemory(saved),
      kind: kindFromMemory(saved),
      op: "updated",
      entityId: saved.id,
      userId: saved.userId,
      changeType: "policy_stats_update",
      before: previous,
      after: saved,
      source: "worker.l2_association.v7",
      createdAt: at
    });
    const savedPolicy = policyMetaFromMemory(saved);
    if (savedPolicy) {
      if (savedPolicy.status === "active") {
        this.enqueueJob({
          jobType: "l3_abstraction",
          userId: saved.userId,
          sessionId: saved.sessionId,
          episodeId: triggerEpisodeId,
          payload: {
            reason: "l2.policy.updated",
            targetKind: "policy_cluster",
            seedPolicyId: saved.id,
            policyIds: [saved.id],
            previousStatus: policy.status,
            status: savedPolicy.status
          },
          createdAt: at
        });
        this.enqueueJob({
          jobType: "skill_crystallization",
          userId: saved.userId,
          sessionId: saved.sessionId,
          episodeId: triggerEpisodeId,
          targetMemoryId: saved.id,
          payload: { reason: "l2.policy.updated", previousStatus: policy.status, status: savedPolicy.status },
          createdAt: at
        });
      }
      this.applySkillRewardDriftForPolicy(savedPolicy, at);
    }
  }

  private l2GainReferenceTraces(evidenceTraces: TraceMeta[], triggerEpisodeId?: string): TraceMeta[] {
    const episodeIds = new Set(
      evidenceTraces
        .map((trace) => trace.episodeId)
        .filter((episodeId): episodeId is string => Boolean(episodeId))
    );
    if (triggerEpisodeId) {
      episodeIds.add(triggerEpisodeId);
    }
    const byId = new Map<string, TraceMeta>();
    for (const trace of evidenceTraces) {
      byId.set(trace.id, trace);
    }
    if (episodeIds.size === 0) {
      return [...byId.values()];
    }
    for (const trace of this.repos.memories
      .list({ memoryLayer: "L1", status: "activated" }, 2000)
      .map((memory) => this.traceMeta(memory))
      .filter((trace): trace is TraceMeta =>
        Boolean(trace && trace.episodeId && episodeIds.has(trace.episodeId) && Number.isFinite(trace.value))
      )) {
      byId.set(trace.id, trace);
    }
    return [...byId.values()].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  }

  private applySkillRewardDriftForPolicy(policy: PolicyMeta, at: string): void {
    const skills = this.repos.memories
      .list({ memoryLayer: "Skill" }, 1000)
      .map(skillMetaFromMemory)
      .filter((skill): skill is NonNullable<ReturnType<typeof skillMetaFromMemory>> =>
        Boolean(skill &&
          skill.sourcePolicyIds.includes(policy.id))
      );
    for (const skill of skills) {
      const eta = skillEtaAfterRewardDrift({
        currentEta: skill.eta,
        magnitude: policy.gain
      });
      const status = skillStatusAfterRewardDrift({
        currentStatus: skill.status,
        eta,
        archiveEta: this.config.algorithm.skill.archiveEta
      });
      if (eta === skill.eta && status === skill.status) continue;
      const previous = skill.memory;
      const next = updateSkillStats(skill.memory, {
        trialsAttempted: skill.trialsAttempted,
        trialsPassed: skill.trialsPassed,
        eta,
        status,
        updatedAt: at
      });
      const saved = this.repos.memories.update(next);
      this.repos.runtime.appendChange({
        memoryId: saved.id,
        namespaceId: namespaceIdFromMemory(saved),
        kind: "skill",
        op: "updated",
        entityId: saved.id,
        userId: saved.userId,
        changeType: "skill_reward_drift",
        before: previous,
        after: saved,
        source: "worker.skill_lifecycle.v7",
        createdAt: at
      });
      this.recordApiLog(
        "skill_evolve",
        { phase: "done", skillId: saved.id, policyId: policy.id, reason: "reward_drift" },
        {
          skillId: saved.id,
          kind: status !== skill.status ? "skill.status.changed" : "skill.eta.updated",
          name: saved.memoryKey ?? saved.id,
          status,
          eta,
          reason: "reward drift"
        },
        0,
        true,
        at
      );
    }
  }

  private feedbackContextHash(
    request: FeedbackRequest,
    context: ReturnType<MemoryService["resolveContext"]>
  ): string {
    const rawContextHash = isRecord(request.rawPayload) && typeof request.rawPayload.contextHash === "string"
      ? request.rawPayload.contextHash
      : undefined;
    if (rawContextHash) return rawContextHash;
    return stableHash({
      sessionId: request.sessionId,
      episodeId: request.episodeId,
      rawTurnId: request.rawTurnId,
      l1MemoryId: request.l1MemoryId,
      recallEventId: request.recallEventId,
      rationale: request.rationale
    }).slice(0, 32);
  }

  private async maybeSynthesizeFeedbackDecisionRepair(
    request: FeedbackRequest,
    feedback: FeedbackRecord,
    contextHash: string
  ): Promise<DecisionRepairLlmDraft | undefined> {
    if (!this.config.algorithm.feedback.useLlm || !this.skillLlm.isConfigured()) {
      return undefined;
    }
    const classification = classifyFeedbackText(request.rationale ?? feedback.rationale ?? "");
    const shouldRepair = request.polarity === "negative" ||
      classification.shape === "negative" ||
      classification.shape === "preference" ||
      classification.shape === "correction" ||
      classification.shape === "constraint";
    if (!shouldRepair) return undefined;
    const cooldownMs = this.config.algorithm.feedback.cooldownMs;
    if (cooldownMs > 0) {
      const since = new Date(Date.parse(feedback.createdAt) - cooldownMs).toISOString();
      const recent = this.repos.runtime.listDecisionRepairs({
        userId: feedback.userId,
        contextHash,
        since,
        limit: 1
      });
      if (recent.length > 0) return undefined;
    }

    const attachedPolicyIds = this.config.algorithm.feedback.attachToPolicy
      ? this.feedbackCandidatePolicyIds(request, feedback)
      : [];
    const evidence = this.feedbackRepairEvidence(request, feedback, attachedPolicyIds);
    const highValue = this.decisionRepairTraceSources(
      this.repos.memories.getMany(evidence.highValueMemoryIds)
    );
    const lowValue = this.decisionRepairTraceSources(
      this.repos.memories.getMany(evidence.lowValueMemoryIds)
    );
    const messages = decisionRepairPromptMessages({
      trigger: "user.feedback",
      contextHash,
      feedbackText: request.rationale ?? feedback.rationale ?? "",
      classification,
      highValue,
      lowValue,
      traceCharCap: this.config.algorithm.feedback.traceCharCap
    });
    try {
      const result = await this.skillLlm.completeJson<{
        preference?: unknown;
        anti_pattern?: unknown;
        severity?: unknown;
        confidence?: unknown;
      }>(messages, {
        operation: DECISION_REPAIR_OPERATION,
        thinkingMode: "enabled",
        temperature: this.skillLlm.config.temperature,
        maxTokens: 800
      });
      return normalizeDecisionRepairLlmDraft(result);
    } catch (error) {
      pipelineLogger.warn("fallback.used", {
        operation: DECISION_REPAIR_OPERATION,
        pipeline: "decision_repair.feedback",
        fallback: "no_llm_draft",
        feedbackId: feedback.id,
        ...memoryErrorFields(error)
      });
      return undefined;
    }
  }

  private maybeCreateDecisionRepair(
    request: FeedbackRequest,
    feedback: FeedbackRecord,
    contextHash: string,
    namespaceId: string,
    llmDraft?: DecisionRepairLlmDraft
  ): {
    repairId?: string;
    contextHash?: string;
    skipped?: boolean;
    reason?: string;
    attachedPolicyIds?: string[];
  } | undefined {
    const classification = classifyFeedbackText(request.rationale ?? "");
    const shouldRepair = request.polarity === "negative" ||
      classification.shape === "negative" ||
      classification.shape === "preference" ||
      classification.shape === "correction" ||
      classification.shape === "constraint";
    if (!shouldRepair) return undefined;

    const cooldownMs = this.config.algorithm.feedback.cooldownMs;
    if (cooldownMs > 0) {
      const since = new Date(Date.parse(feedback.createdAt) - cooldownMs).toISOString();
      const recent = this.repos.runtime.listDecisionRepairs({
        userId: feedback.userId,
        contextHash,
        since,
        limit: 1
      });
      if (recent.length > 0) {
        return {
          contextHash,
          skipped: true,
          reason: "cooldown"
        };
      }
    }

    const attachedPolicyIds = this.config.algorithm.feedback.attachToPolicy
      ? this.feedbackCandidatePolicyIds(request, feedback)
      : [];
    const evidence = this.feedbackRepairEvidence(request, feedback, attachedPolicyIds);
    const repair = this.repos.runtime.insertDecisionRepair({
      id: newId("repair"),
      sessionId: feedback.sessionId,
      episodeId: feedback.episodeId,
      rawTurnId: feedback.rawTurnId,
      userId: feedback.userId,
      projectId: feedback.projectId,
      contextHash,
      issue: repairIssueFromFeedback(request, classification),
      suggestion: llmDraft?.preference ?? repairSuggestionFromFeedback(request, classification),
      preference: llmDraft?.preference ?? repairPreferenceFromFeedback(request, classification),
      antiPattern: llmDraft?.antiPattern ?? repairAntiPatternFromFeedback(request, classification),
      highValueMemoryIds: evidence.highValueMemoryIds,
      lowValueMemoryIds: evidence.lowValueMemoryIds,
      attachedPolicyMemoryIds: attachedPolicyIds,
      feedbackId: feedback.id,
      validated: false,
      source: {
        source: "feedback.decision_repair.v7",
        classification,
        attachedPolicyIds,
        ...(llmDraft ? { synthesis: "llm" } : {})
      },
      meta: {
        trigger: "user_feedback",
        polarity: feedback.polarity,
        severity: llmDraft?.severity,
        confidence: llmDraft?.confidence ?? classification.confidence
      },
      createdAt: feedback.createdAt
    });
    if (feedback.episodeId) {
      this.repos.runtime.appendEpisodeDecisionRepair(feedback.episodeId, repair.id, feedback.createdAt);
    }
    const actuallyAttached = attachedPolicyIds.length > 0
      ? this.attachRepairToPolicies(repair.id, attachedPolicyIds, repair.preference, repair.antiPattern, feedback.createdAt)
      : [];
    this.repos.runtime.appendChange({
      memoryId: repair.id,
      namespaceId,
      userId: feedback.userId,
      kind: "repair",
      op: "created",
      entityId: repair.id,
      changeType: "decision_repair_created",
      after: repair,
      source: "feedback.decision_repair.v7",
      createdAt: feedback.createdAt
    });
    return {
      repairId: repair.id,
      contextHash,
      skipped: false,
      attachedPolicyIds: actuallyAttached
    };
  }

  private async maybeCreateFeedbackExperience(
    request: FeedbackRequest,
    feedback: FeedbackRecord,
    context: ReturnType<MemoryService["resolveContext"]>
  ): Promise<EvolutionJobRecord[]> {
    const text = feedbackExperienceText(feedback);
    if (!text) return [];
    const classification = classifyFeedbackText(text);
    const episode = feedback.episodeId ? this.repos.runtime.getEpisode(feedback.episodeId) : undefined;
    const traceMemory = feedback.l1MemoryId ? this.repos.memories.get(feedback.l1MemoryId) : undefined;
    const trace = traceMemory ? this.traceMeta(traceMemory) : null;
    const significance = feedbackExperienceSignificance(feedback, classification, episode);
    if (significance < 0.5 || !isActionableFeedbackExperience(text, classification.shape)) {
      return [];
    }
    const fallbackDraft = buildFeedbackExperienceDraft({
      feedback,
      text,
      classification,
      significance,
      episode,
      trace,
      traceMemory
    });
    const draft = await this.enhanceFeedbackExperienceDraft(fallbackDraft, {
      text,
      feedback,
      episode,
      trace
    });
    const vector = await this.embedder.embedOne(draft.vectorText, "document");
    const existing = this.findSimilarFeedbackExperience(draft, vector, feedback.userId);
    const at = feedback.createdAt;
    const saved = existing
      ? this.mergeFeedbackExperiencePolicy(existing, draft, vector, at)
      : this.insertFeedbackExperiencePolicy(request, feedback, context, draft, vector, at);
    for (const episodeId of draft.sourceEpisodeIds) {
      this.repos.runtime.appendEpisodeDerivedMemory(episodeId, "L2", saved.id, at);
    }
    const repairCandidate = this.maybeMintRepairCandidateSkill(saved, context, at);
    if (repairCandidate) {
      for (const episodeId of draft.sourceEpisodeIds) {
        this.repos.runtime.appendEpisodeDerivedMemory(episodeId, "Skill", repairCandidate.id, at);
      }
    }
    const jobs: EvolutionJobRecord[] = [];
    if (this.config.algorithm.capture.embedAfterCapture) {
      jobs.push(this.enqueueJob({
        jobType: "embedding",
        userId: saved.userId,
        sessionId: saved.sessionId,
        episodeId: feedback.episodeId,
        targetMemoryId: saved.id,
        payload: { reason: "feedback.experience" },
        createdAt: at
      }));
      if (repairCandidate) {
        jobs.push(this.enqueueJob({
          jobType: "embedding",
          userId: repairCandidate.userId,
          sessionId: repairCandidate.sessionId,
          episodeId: feedback.episodeId,
          targetMemoryId: repairCandidate.id,
          payload: { reason: "repair.candidate" },
          createdAt: at
        }));
      }
    }
    jobs.push(
      this.enqueueJob({
        jobType: "skill_crystallization",
        userId: saved.userId,
        sessionId: saved.sessionId,
        episodeId: feedback.episodeId,
        targetMemoryId: saved.id,
        payload: { reason: "feedback.experience", feedbackId: feedback.id },
        createdAt: at
      }),
      this.enqueueJob({
        jobType: "l3_abstraction",
        userId: saved.userId,
        sessionId: saved.sessionId,
        episodeId: feedback.episodeId,
        payload: {
          reason: "feedback.experience",
          targetKind: "policy_cluster",
          seedPolicyId: saved.id,
          policyIds: [saved.id],
          feedbackId: feedback.id
        },
        createdAt: at
      })
    );
    return jobs;
  }

  private maybeMintRepairCandidateSkill(
    policyMemory: MemoryRow,
    context: ReturnType<MemoryService["resolveContext"]>,
    at: string
  ): MemoryRow | undefined {
    const policy = policyMetaFromMemory(policyMemory);
    if (!policy || !isRepairCandidatePolicyForSkill(policy)) return undefined;
    if (this.findExistingSkillForPolicy(policy, policyMemory.userId)) return undefined;

    const fix = policy.decisionGuidance.preference.find((item) => item.trim().length > 0);
    if (!fix) return undefined;
    const name = repairCandidateSkillName(policy, fix);
    const invocationGuide = renderRepairCandidateGuide(policy, fix);
    const eta = Math.max(0.1, this.config.algorithm.skill.minEtaForRetrieval);
    const betaPosterior = skillBetaPosterior(0, 0);
    const procedureJson = {
      summary: policy.procedure || fix,
      preconditions: [policy.trigger].filter(Boolean),
      parameters: [],
      steps: [
        {
          title: "Apply candidate repair",
          body: fix
        },
        {
          title: "Verify closure",
          body: policy.verification || "Check the current task outcome before treating the repair as validated."
        }
      ],
      decisionGuidance: {
        preference: policy.decisionGuidance.preference,
        antiPattern: policy.decisionGuidance.antiPattern
      },
      reliability: {
        supportCount: 1,
        successRate: 0,
        betaPosterior
      },
      repairOrigin: true,
      strictTrial: repairCandidateStrictTrial(policy)
    };
    const skill = this.buildMemory({
      userId: policyMemory.userId,
      conversationId: policyMemory.conversationId,
      sessionId: policyMemory.sessionId,
      agentId: policyMemory.agentId ?? context.namespace.source,
      appId: policyMemory.appId ?? context.namespace.workspaceId,
      projectId: projectIdFromMemory(policyMemory) ?? context.namespace.projectId,
      profileId: profileIdFromMemory(policyMemory) ?? context.namespace.profileId,
      layer: "Skill",
      kind: "skill",
      lifecycleStatus: "candidate",
      memoryType: "SkillMemory",
      key: `skill:${policy.id}`,
      value: invocationGuide,
      tags: uniq(["skill", "repair_candidate", ...policyMemory.tags.filter((tag) => tag !== "policy")]).slice(0, 12),
      info: {
        name,
        eta,
        status: "candidate",
        source_memory_ids: [policy.id],
        repair_origin: true,
        strict_trial: repairCandidateStrictTrial(policy)
      },
      internal: {
        source: "feedback.repair_candidate.v1",
        plugin_algorithm: "skill.repair_candidate.v1",
        source_memory_ids: [policy.id],
        source_policy_ids: [policy.id],
        source_world_model_ids: [],
        evidence_anchor_ids: policy.sourceTraceIds.slice(0, this.config.algorithm.skill.evidenceLimit),
        name,
        invocation_guide: invocationGuide,
        procedure_json: procedureJson,
        eta,
        support: 1,
        gain: policy.gain,
        repair_origin: true,
        repairOrigin: true,
        strict_trial: repairCandidateStrictTrial(policy),
        strictTrial: repairCandidateStrictTrial(policy),
        skill: {
          name,
          eta,
          status: "candidate",
          support: 1,
          gain: policy.gain,
          source_policy_ids: [policy.id],
          source_world_model_ids: [],
          evidence_anchor_ids: policy.sourceTraceIds.slice(0, this.config.algorithm.skill.evidenceLimit),
          invocation_guide: invocationGuide,
          procedure_json: procedureJson,
          trials_attempted: 0,
          trials_passed: 0,
          success_rate: 0,
          beta_posterior: betaPosterior,
          repair_origin: true,
          repairOrigin: true,
          strict_trial: repairCandidateStrictTrial(policy),
          strictTrial: repairCandidateStrictTrial(policy),
          vec: null
        }
      },
      createdAt: at
    });
    const upsert = this.upsertEvolutionMemory(skill);
    this.repos.runtime.appendChange({
      memoryId: upsert.memory.id,
      namespaceId: namespaceIdFromMemory(upsert.memory),
      kind: "skill",
      op: upsert.created ? "created" : "updated",
      entityId: upsert.memory.id,
      userId: upsert.memory.userId,
      changeType: upsert.created ? "repair_candidate_skill_create" : "repair_candidate_skill_update",
      before: upsert.previous,
      after: upsert.memory,
      source: "feedback.repair_candidate.v1",
      createdAt: at
    });
    return upsert.memory;
  }

  private async enhanceFeedbackExperienceDraft(
    fallback: FeedbackExperienceDraft,
    input: {
      text: string;
      feedback: FeedbackRecord;
      episode?: EpisodeRecord;
      trace: TraceMeta | null;
    }
  ): Promise<FeedbackExperienceDraft> {
    if (!this.config.algorithm.feedback.useLlm || !this.skillLlm.isConfigured()) {
      return fallback;
    }
    const context = this.feedbackExperienceEpisodeContext(input.episode, input.trace);
    const polarity = feedbackPolarityForRefinement(input.feedback, fallback);
    try {
      if (polarity === "negative") {
        const result = await this.skillLlm.completeJson<{
          title?: unknown;
          trigger?: unknown;
          procedure?: unknown;
          verification?: unknown;
          boundary?: unknown;
          experience_type?: unknown;
          decision_guidance?: unknown;
          support_trace_ids?: unknown;
        }>([
          {
            role: "system",
            content: FAILURE_EXPERIENCE_SINK_PROMPT.system
          },
          {
            role: "user",
            content: failureExperienceSinkUserPrompt({
              feedbackText: input.text,
              userRequest: context.userRequest,
              agentResponse: context.agentResponse,
              episodeContext: context.fullContext
            })
          }
        ], {
          operation: `${FAILURE_EXPERIENCE_SINK_PROMPT.id}.v${FAILURE_EXPERIENCE_SINK_PROMPT.version}`,
          thinkingMode: "enabled",
          temperature: 0.2,
          maxTokens: 900
        });
        return applyFailureExperienceSink(fallback, result);
      }
      const result = await this.skillLlm.completeJson<{
        title?: unknown;
        trigger?: unknown;
        procedure?: unknown;
        caveats?: unknown;
        verification?: unknown;
        confidence?: unknown;
      }>([
        {
          role: "system",
          content: FEEDBACK_REFINEMENT_SYSTEM_PROMPT
        },
        {
          role: "user",
          content: feedbackRefinementUserPrompt({
            feedbackText: input.text,
            polarity,
            userRequest: context.userRequest,
            agentResponse: context.agentResponse,
            episodeContext: context.fullContext
          })
        }
      ], {
        operation: "feedback.refine.v1",
        thinkingMode: "enabled",
        temperature: 0.2,
        maxTokens: 700
      });
      return applyFeedbackRefinement(fallback, {
        title: stringOr(result.title, ""),
        trigger: stringOr(result.trigger, ""),
        procedure: stringOr(result.procedure, ""),
        verification: stringOr(result.verification, ""),
        caveats: stringArray(result.caveats),
        confidence: numberOr(result.confidence, fallback.confidence),
        method: "llm"
      });
    } catch (error) {
      pipelineLogger.warn("fallback.used", {
        operation: polarity === "negative"
          ? `${FAILURE_EXPERIENCE_SINK_PROMPT.id}.v${FAILURE_EXPERIENCE_SINK_PROMPT.version}`
          : "feedback.refine.v1",
        pipeline: "feedback.refinement",
        fallback: "rule_based_refinement",
        feedbackId: input.feedback.id,
        ...memoryErrorFields(error)
      });
      return applyFeedbackRefinement(
        fallback,
        refineFeedbackExperienceByRules({
          feedbackText: input.text,
          polarity,
          userRequest: context.userRequest,
          episodeContext: context.fullContext
        })
      );
    }
  }

  private feedbackExperienceEpisodeContext(
    episode: EpisodeRecord | undefined,
    currentTrace: TraceMeta | null
  ): {
    userRequest: string;
    agentResponse: string;
    fullContext: string;
  } {
    const traces: TraceMeta[] = [];
    for (const id of episode?.l1MemoryIds ?? []) {
      const memory = this.repos.memories.get(id);
      const trace = memory ? this.traceMeta(memory) : null;
      if (trace) traces.push(trace);
    }
    if (currentTrace && !traces.some((trace) => trace.id === currentTrace.id)) {
      traces.push(currentTrace);
    }
    traces.sort((a, b) => a.ts - b.ts);
    if (traces.length === 0) {
      return { userRequest: "", agentResponse: "", fullContext: "" };
    }
    const selected = feedbackRefinementSelectedTraces(traces);
    const last = selected[selected.length - 1] ?? traces[traces.length - 1]!;
    return {
      userRequest: last.userText,
      agentResponse: last.agentText,
      fullContext: selected.map((trace) =>
        feedbackRefinementTurnBlock(traces.indexOf(trace) + 1, trace)
      ).join("\n\n")
    };
  }

  private findSimilarFeedbackExperience(
    draft: FeedbackExperienceDraft,
    vector: number[],
    userId: string
  ): MemoryRow | null {
    let best: { memory: MemoryRow; score: number; policy: PolicyMeta } | null = null;
    for (const memory of this.repos.memories.list({ memoryLayer: "L2", status: ["activated", "resolving"] }, 1000)) {
      const policy = policyMetaFromMemory(memory);
      if (!policy) continue;
      const sourceFeedbackIds = stringArray(memory.properties.internal_info.source_feedback_ids)
        .concat(stringArray(isRecord(memory.properties.internal_info.policy)
          ? memory.properties.internal_info.policy.source_feedback_ids
          : undefined));
      const sourceOverlap = draft.sourceTraceIds.some((id) => policy.sourceTraceIds.includes(id));
      const vectorScore = policy.vec ? cosine(vector, policy.vec) : 0;
      const score = Math.max(vectorScore, sourceOverlap && sourceFeedbackIds.length > 0 ? 0.83 : 0);
      if (score < 0.72) continue;
      if (policy.experienceType !== draft.type && score < 0.82) continue;
      if (!best || score > best.score) best = { memory, score, policy };
    }
    return best?.memory ?? null;
  }

  private insertFeedbackExperiencePolicy(
    request: FeedbackRequest,
    feedback: FeedbackRecord,
    context: ReturnType<MemoryService["resolveContext"]>,
    draft: FeedbackExperienceDraft,
    vector: number[],
    at: string
  ): MemoryRow {
    const key = `feedback:${stableHash(`${draft.type}:${draft.title}:${draft.trigger}`).slice(0, 16)}`;
    const l2 = this.buildMemory({
      userId: feedback.userId,
      conversationId: feedback.conversationId ?? context.conversationId,
      sessionId: feedback.sessionId ?? request.sessionId,
      agentId: context.namespace.source,
      appId: context.namespace.workspaceId,
      projectId: context.namespace.projectId,
      profileId: context.namespace.profileId,
      layer: "L2",
      kind: "policy",
      lifecycleStatus: draft.salience >= 0.5 ? "active" : "candidate",
      memoryType: "LongTermMemory",
      key,
      value: renderFeedbackExperienceBody(draft),
      tags: draft.tags,
      info: {
        support: 1,
        gain: Math.max(0.02, draft.salience),
        policy_confidence: draft.confidence,
        status: draft.salience >= 0.5 ? "active" : "candidate",
        source_memory_ids: draft.sourceTraceIds,
        source_feedback_ids: draft.sourceFeedbackIds,
        experience_type: draft.type,
        evidence_polarity: draft.polarity
      },
      internal: {
        source: "feedback.experience.v1",
        plugin_algorithm: "feedback.experience.v1",
        source_memory_ids: draft.sourceTraceIds,
        source_l1_memory_ids: draft.sourceTraceIds,
        source_feedback_ids: draft.sourceFeedbackIds,
        title: draft.title,
        trigger: draft.trigger,
        procedure: draft.procedure,
        verification: draft.verification,
        boundary: draft.boundary,
        support: 1,
        gain: Math.max(0.02, draft.salience),
        raw_gain: draft.salience,
        policy_confidence: draft.confidence,
        status: draft.salience >= 0.5 ? "active" : "candidate",
        source_episode_ids: draft.sourceEpisodeIds,
        source_trace_ids: draft.sourceTraceIds,
        policy: {
          title: draft.title,
          trigger: draft.trigger,
          procedure: draft.procedure,
          verification: draft.verification,
          boundary: draft.boundary,
          support: 1,
          gain: Math.max(0.02, draft.salience),
          raw_gain: draft.salience,
          policy_confidence: draft.confidence,
          status: draft.salience >= 0.5 ? "active" : "candidate",
          experience_type: draft.type,
          evidence_polarity: draft.polarity,
          salience: draft.salience,
          confidence: draft.confidence,
          source_episode_ids: draft.sourceEpisodeIds,
          source_trace_ids: draft.sourceTraceIds,
          source_feedback_ids: draft.sourceFeedbackIds,
          induced_by: "feedback.experience.v1",
          decision_guidance: policyDecisionGuidanceForStorage(draft.decisionGuidance),
          verifier_meta: draft.verifierMeta,
          skill_eligible: draft.skillEligible,
          signature: `feedback|${draft.type}|${draft.polarity}`,
          vec: vector
        }
      },
      createdAt: at
    });
    const upsert = this.repos.memories.upsertByKey(l2);
    this.repos.runtime.appendChange({
      memoryId: upsert.memory.id,
      namespaceId: namespaceIdFromMemory(upsert.memory),
      kind: "policy",
      op: upsert.created ? "created" : "updated",
      entityId: upsert.memory.id,
      userId: upsert.memory.userId,
      changeType: upsert.created ? "feedback_experience_create" : "feedback_experience_update",
      before: upsert.previous,
      after: upsert.memory,
      source: "feedback.experience.v1",
      createdAt: at
    });
    return upsert.memory;
  }

  private mergeFeedbackExperiencePolicy(
    memory: MemoryRow,
    draft: FeedbackExperienceDraft,
    vector: number[],
    at: string
  ): MemoryRow {
    const previous = memory;
    const policy = policyMetaFromMemory(memory);
    const internalPolicy = isRecord(memory.properties.internal_info.policy)
      ? memory.properties.internal_info.policy
      : {};
    const existingPolarity = policy?.evidencePolarity ?? "positive";
    const polarity = mergeFeedbackPolarity(existingPolarity, draft.polarity);
    const skillEligible = Boolean((policy?.skillEligible ?? true) || draft.skillEligible);
    const support = Math.max(1, policy?.support ?? 0) + 1;
    const gain = Math.max(policy?.gain ?? 0, draft.salience, 0.02);
    const status = memoryStatusForLifecycleStatus(memory.status === "archived" ? "archived" : "active");
    const experienceType: FeedbackExperienceType = skillEligible && polarity === "mixed"
      ? "repair_validated"
      : (policy?.experienceType ?? draft.type);
    const sourceEpisodeIds = uniq([...(policy?.sourceEpisodeIds ?? []), ...draft.sourceEpisodeIds]);
    const sourceTraceIds = uniq([...(policy?.sourceTraceIds ?? []), ...draft.sourceTraceIds]);
    const sourceFeedbackIds = uniq([
      ...stringArray(internalPolicy.source_feedback_ids),
      ...draft.sourceFeedbackIds
    ]);
    const decisionGuidance = {
      preference: uniq([...(policy?.decisionGuidance.preference ?? []), ...draft.decisionGuidance.preference]),
      antiPattern: uniq([...(policy?.decisionGuidance.antiPattern ?? []), ...draft.decisionGuidance.antiPattern])
    };
    const nextPolicy = {
      ...internalPolicy,
      title: draft.title,
      trigger: draft.trigger,
      procedure: draft.procedure,
      verification: draft.verification,
      boundary: draft.boundary,
      support,
      gain,
      raw_gain: Math.max(numberOr(internalPolicy.raw_gain, 0), draft.salience),
      status: memory.status === "archived" ? "archived" : "active",
      experience_type: experienceType,
      evidence_polarity: polarity,
      salience: Math.max(numberOr(internalPolicy.salience, 0), draft.salience),
      policy_confidence: Math.max(policy?.confidence ?? 0.5, draft.confidence),
      confidence: Math.max(policy?.confidence ?? 0.5, draft.confidence),
      source_episode_ids: sourceEpisodeIds,
      source_trace_ids: sourceTraceIds,
      source_feedback_ids: sourceFeedbackIds,
      decision_guidance: policyDecisionGuidanceForStorage(decisionGuidance),
      verifier_meta: internalPolicy.verifier_meta ?? draft.verifierMeta,
      skill_eligible: skillEligible,
      vec: vector
    };
    const mergedDraft = {
      ...draft,
      type: experienceType,
      polarity,
      support,
      gain,
      sourceEpisodeIds,
      sourceTraceIds,
      sourceFeedbackIds,
      decisionGuidance
    };
    const next: MemoryRow = {
      ...memory,
      status,
      memoryValue: renderFeedbackExperienceBody(mergedDraft),
      info: {
        ...memory.info,
        support,
        gain,
        policy_confidence: nextPolicy.policy_confidence,
        status: nextPolicy.status,
        source_memory_ids: sourceTraceIds,
        source_feedback_ids: sourceFeedbackIds,
        experience_type: experienceType,
        evidence_polarity: polarity
      },
      properties: {
        ...memory.properties,
        status,
        info: {
          ...(memory.properties.info ?? {}),
          support,
          gain,
          policy_confidence: nextPolicy.policy_confidence,
          status: nextPolicy.status,
          source_memory_ids: sourceTraceIds,
          source_feedback_ids: sourceFeedbackIds,
          experience_type: experienceType,
          evidence_polarity: polarity
        },
        internal_info: {
          ...memory.properties.internal_info,
          source_memory_ids: sourceTraceIds,
          source_l1_memory_ids: sourceTraceIds,
          source_feedback_ids: sourceFeedbackIds,
          title: nextPolicy.title,
          trigger: nextPolicy.trigger,
          procedure: nextPolicy.procedure,
          verification: nextPolicy.verification,
          boundary: nextPolicy.boundary,
          support,
          gain,
          raw_gain: nextPolicy.raw_gain,
          policy_confidence: nextPolicy.policy_confidence,
          status: nextPolicy.status,
          source_episode_ids: sourceEpisodeIds,
          source_trace_ids: sourceTraceIds,
          decision_guidance: nextPolicy.decision_guidance,
          policy: nextPolicy
        }
      },
      updatedAt: at,
      contentHash: stableHash(renderFeedbackExperienceBody(mergedDraft))
    };
    const saved = this.repos.memories.update(next);
    this.repos.runtime.appendChange({
      memoryId: saved.id,
      namespaceId: namespaceIdFromMemory(saved),
      kind: "policy",
      op: "updated",
      entityId: saved.id,
      userId: saved.userId,
      changeType: "feedback_experience_merge",
      before: previous,
      after: saved,
      source: "feedback.experience.v1",
      createdAt: at
    });
    return saved;
  }

  private feedbackCandidatePolicyIds(request: FeedbackRequest, feedback: FeedbackRecord): string[] {
    const ids = new Set<string>();
    if (request.recallEventId) {
      const recall = this.repos.runtime.getRecallEvent(request.recallEventId);
      for (const id of recall?.injectedMemoryIds ?? []) {
        const memory = this.repos.memories.get(id);
        if (memory?.memoryLayer === "L2") ids.add(memory.id);
      }
    }
    if (feedback.l1MemoryId) {
      for (const link of this.repos.runtime.listTracePolicyLinks({
        userId: feedback.userId,
        l1MemoryId: feedback.l1MemoryId,
        limit: 20
      })) {
        ids.add(link.l2MemoryId);
      }
    }
    if (ids.size === 0 && feedback.rationale) {
      for (const hit of this.repos.memories.search(
        feedback.rationale,
        {
          memoryLayer: "L2",
          status: "activated"
        },
        3
      )) {
        ids.add(hit.id);
      }
    }
    return [...ids].slice(0, this.config.algorithm.feedback.evidenceLimit);
  }

  private feedbackRepairEvidence(
    request: FeedbackRequest,
    feedback: FeedbackRecord,
    policyIds: string[]
  ): {
    highValueMemoryIds: string[];
    lowValueMemoryIds: string[];
  } {
    const limit = this.config.algorithm.feedback.evidenceLimit;
    const low = new Set<string>();
    const high = new Set<string>();
    if (feedback.l1MemoryId) {
      if (feedback.polarity === "negative") {
        low.add(feedback.l1MemoryId);
      } else if (feedback.polarity === "positive") {
        high.add(feedback.l1MemoryId);
      }
    }
    if (request.recallEventId) {
      const recall = this.repos.runtime.getRecallEvent(request.recallEventId);
      for (const id of recall?.injectedMemoryIds ?? []) {
        if (feedback.polarity === "negative") {
          low.add(id);
        } else if (feedback.polarity === "positive") {
          high.add(id);
        }
      }
    }
    for (const policy of this.repos.memories.getMany(policyIds)) {
      const meta = policyMetaFromMemory(policy);
      if (!meta) continue;
      for (const id of meta.sourceTraceIds) {
        if (feedback.polarity === "negative") low.add(id);
        if (feedback.polarity === "positive") high.add(id);
      }
    }
    const searchText = request.rationale ?? feedback.rationale;
    if (request.sessionId && (high.size < limit || low.size < limit)) {
      const evidence = this.sessionRepairEvidence(
        feedback.userId,
        request.sessionId,
        searchText,
        limit
      );
      for (const memory of evidence.highValue) {
        if (!low.has(memory.id) && high.size < limit) high.add(memory.id);
      }
      for (const memory of evidence.lowValue) {
        if (!high.has(memory.id) && low.size < limit) low.add(memory.id);
      }
    }
    if (searchText && high.size < limit) {
      for (const memory of this.repos.memories.search(
        searchText,
        {
          memoryLayer: "L1",
          status: "activated"
        },
        limit * 2
      )) {
        const fullMemory = this.repos.memories.get(memory.id);
        const trace = fullMemory ? this.traceMeta(fullMemory) : null;
        if (trace && trace.value > 0 && !low.has(memory.id)) high.add(memory.id);
        if (high.size >= limit) break;
      }
    }
    if (searchText && low.size < limit) {
      for (const memory of this.repos.memories.search(
        searchText,
        {
          memoryLayer: "L1",
          status: "activated"
        },
        limit * 2
      )) {
        const fullMemory = this.repos.memories.get(memory.id);
        const trace = fullMemory ? this.traceMeta(fullMemory) : null;
        if (
          trace &&
          !high.has(memory.id) &&
          (
            trace.value < -this.config.algorithm.feedback.minLowValueThreshold ||
            isRepairFailureLikeTrace(trace)
          )
        ) {
          low.add(memory.id);
        }
        if (low.size >= limit) break;
      }
    }
    return {
      highValueMemoryIds: [...high].slice(0, limit),
      lowValueMemoryIds: [...low].slice(0, limit)
    };
  }

  private sessionRepairEvidence(
    userId: string,
    sessionId: string,
    keyword: string | undefined,
    limit: number
  ): {
    highValue: MemoryRow[];
    lowValue: MemoryRow[];
  } {
    const recent = this.repos.memories
      .list(
        {
          sessionId,
          memoryLayer: "L1",
          status: "activated"
        },
        Math.max(limit * 6, 24)
      )
      .map((memory) => ({ memory, trace: this.traceMeta(memory) }))
      .filter((item): item is { memory: MemoryRow; trace: TraceMeta } => Boolean(item.trace));
    if (recent.length === 0) {
      return { highValue: [], lowValue: [] };
    }

    const needle = keyword?.toLowerCase().trim() ?? "";
    const firstPass = this.partitionSessionRepairEvidence(recent, needle, limit);
    const emptyFirstPass = firstPass.highValue.length === 0 && firstPass.lowValue.length === 0;
    if (!needle || !emptyFirstPass) {
      return firstPass;
    }
    return this.partitionSessionRepairEvidence(recent, "", limit);
  }

  private partitionSessionRepairEvidence(
    rows: Array<{ memory: MemoryRow; trace: TraceMeta }>,
    needle: string,
    limit: number
  ): {
    highValue: MemoryRow[];
    lowValue: MemoryRow[];
  } {
    const highValue: MemoryRow[] = [];
    const lowValue: MemoryRow[] = [];
    for (const row of rows) {
      if (needle && !repairTraceContains(row.trace, needle)) continue;
      if (row.trace.value > 0) {
        if (highValue.length < limit) highValue.push(row.memory);
      } else if (
        row.trace.value < -this.config.algorithm.feedback.minLowValueThreshold ||
        isRepairFailureLikeTrace(row.trace)
      ) {
        if (lowValue.length < limit) lowValue.push(row.memory);
      }
      if (highValue.length >= limit && lowValue.length >= limit) break;
    }
    return { highValue, lowValue };
  }

  private decisionRepairTraceSources(memories: MemoryRow[]): DecisionRepairTraceSource[] {
    return memories.map((memory) => {
      const rawTurnId = rawTurnIdFromMemory(memory);
      return {
        memory,
        rawTurn: rawTurnId ? this.repos.runtime.getRawTurn(rawTurnId) : undefined
      };
    });
  }

  private attachRepairToPolicies(
    repairId: string,
    policyIds: string[],
    preference: string | undefined,
    antiPattern: string | undefined,
    at: string
  ): string[] {
    const attached: string[] = [];
    for (const policyId of policyIds) {
      const memory = this.repos.memories.get(policyId);
      if (!memory || memory.memoryLayer !== "L2") continue;
      const previous = memory;
      const next = updatePolicyDecisionGuidance(memory, {
        preference,
        antiPattern,
        repairId,
        updatedAt: at
      });
      if (next === memory) continue;
      const saved = this.repos.memories.update(next);
      attached.push(saved.id);
      this.repos.runtime.appendChange({
        memoryId: saved.id,
        namespaceId: namespaceIdFromMemory(saved),
        kind: kindFromMemory(saved),
        op: "updated",
        entityId: saved.id,
        userId: saved.userId,
        changeType: "policy_repair_attached",
        before: previous,
        after: saved,
        source: "feedback.decision_repair.v7",
        createdAt: at
      });
    }
    return attached;
  }

  private applyRecallOutcome(
    event: RecallEventRecord,
    feedback: FeedbackRecord,
    at: string
  ): void {
    const outcome = event.outcome;
    if (!outcome || outcome === "pending") return;
    const memoryIds = uniq(event.injectedMemoryIds ?? event.hitMemoryIds);
    for (const memory of this.repos.memories.getMany(memoryIds)) {
      if (memory.userId !== event.userId) continue;
      const previous = memory;
      let next = updateRecallStats(memory, {
        outcome,
        feedbackId: feedback.id,
        recallEventId: event.id,
        updatedAt: at
      });
      if (outcome !== "ignored" && memory.memoryLayer === "L2") {
        const policy = policyMetaFromMemory(next);
        if (policy) {
          const direction = outcome === "positive" ? 1 : -1;
          const nextGain = clampNumber(
            policy.gain + direction * 0.02 * clampNumber(feedback.magnitude, 0, 1),
            -1,
            1
          );
          const status = policyStatusAfterGain({
            currentStatus: policy.status,
            support: policy.support,
            gain: nextGain,
            minSupport: this.config.algorithm.l2Induction.minEpisodesForInduction,
            minGain: this.config.algorithm.l2Induction.minGain,
            archiveGain: this.config.algorithm.l2Induction.archiveGain
          });
          next = updatePolicyStats(next, {
            support: policy.support,
            gain: nextGain,
            rawGain: nextGain,
            status,
            sourceEpisodeIds: policy.sourceEpisodeIds,
            sourceTraceIds: policy.sourceTraceIds,
            updatedAt: at
          });
        }
      }
      const saved = this.repos.memories.update(next);
      this.repos.runtime.appendChange({
        memoryId: saved.id,
        namespaceId: namespaceIdFromMemory(saved),
        kind: kindFromMemory(saved),
        op: "updated",
        entityId: saved.id,
        userId: saved.userId,
        changeType: "recall_outcome_update",
        before: previous,
        after: saved,
        source: "worker.recall_outcome.v7",
        createdAt: at
      });
    }
    this.repos.runtime.appendChange({
      memoryId: event.id,
      namespaceId: event.namespaceId,
      userId: event.userId,
      kind: "recall",
      op: "updated",
      entityId: event.id,
      changeType: "recall_outcome",
      after: event,
      source: "feedback.recall_outcome",
      createdAt: at
    });
  }

  private resolveSkillTrial(job: EvolutionJobRecord): void {
    const trialId = typeof job.payload.trialId === "string" ? job.payload.trialId : undefined;
    const trial = trialId ? this.repos.runtime.getSkillTrial(trialId) : undefined;
    if (!trial || trial.status !== "pending") {
      return;
    }
    const feedback = this.feedbackForTrial(trial, job.payload);
    const outcome = this.outcomeForSkillTrial(trial, job.payload, feedback);
    if (!outcome) {
      return;
    }
    const at = nowIso();
    const updatedTrial = this.repos.runtime.updateSkillTrial({
      ...trial,
      status: skillTrialStatusFromOutcome(outcome),
      outcome,
      feedbackId: feedback?.id,
      resolvedAt: at
    });
    const skillMemoryForTrial = this.repos.memories.get(updatedTrial.skillMemoryId);
    this.repos.runtime.appendChange({
      memoryId: updatedTrial.skillMemoryId,
      namespaceId: skillMemoryForTrial
        ? namespaceIdFromMemory(skillMemoryForTrial)
        : namespaceIdFromContext({ source: DEFAULT_NAMESPACE_SOURCE, profileId: "default", userId: updatedTrial.userId }),
      kind: "skill_trial",
      op: "updated",
      entityId: updatedTrial.id,
      userId: updatedTrial.userId,
      changeType: "skill_trial_resolved",
      before: trial,
      after: updatedTrial,
      source: "worker.skill_trial_resolve",
      createdAt: at
    });
    if (outcome !== "unknown") {
      this.updateSkillTrialStats(updatedTrial, at);
    }
  }

  private feedbackForTrial(
    trial: SkillTrialRecord,
    payload: Record<string, unknown>
  ): FeedbackRecord | undefined {
    const feedbackId = typeof payload.feedbackId === "string" ? payload.feedbackId : undefined;
    if (feedbackId) {
      return this.repos.runtime.getFeedback(feedbackId);
    }
    if (trial.rawTurnId) {
      const direct = this.repos.runtime.listFeedback({
        userId: trial.userId,
        rawTurnId: trial.rawTurnId,
        limit: 1
      })[0];
      if (direct) return direct;
    }
    if (trial.episodeId) {
      return this.repos.runtime.listFeedback({
        userId: trial.userId,
        sessionId: trial.sessionId,
        episodeId: trial.episodeId,
        limit: 1
      })[0];
    }
    return undefined;
  }

  private pendingTrialsForFeedback(feedback: FeedbackRecord): SkillTrialRecord[] {
    if (feedback.rawTurnId) {
      return this.repos.runtime.listSkillTrials({
        userId: feedback.userId,
        rawTurnId: feedback.rawTurnId,
        status: "pending",
        limit: 20
      });
    }
    if (feedback.episodeId) {
      return this.repos.runtime.listSkillTrials({
        userId: feedback.userId,
        sessionId: feedback.sessionId,
        episodeId: feedback.episodeId,
        status: "pending",
        limit: 20
      });
    }
    return [];
  }

  private updateSkillTrialStats(trial: SkillTrialRecord, at: string): void {
    const memory = this.repos.memories.get(trial.skillMemoryId);
    if (!memory || memory.memoryLayer !== "Skill") {
      return;
    }
    const trials = this.repos.runtime
      .listSkillTrials({ skillMemoryId: trial.skillMemoryId, limit: 1000 })
      .filter((item) => item.outcome !== "unknown");
    const attempted = trials.length;
    const passed = trials.filter((item) => item.outcome === "success").length;
    const currentSkill = skillMetaFromMemory(memory);
    const eta = attempted > 0
      ? skillEtaAfterTrial({
          currentEta: currentSkill?.eta ?? 0,
          previousAttempts: currentSkill?.trialsAttempted ?? 0,
          previousPasses: currentSkill?.trialsPassed ?? 0,
          nextAttempts: attempted,
          nextPasses: passed
        })
      : currentSkill?.eta ?? 0;
    const status = skillStatusAfterTrial({
      currentStatus: currentSkill?.status ?? "candidate",
      eta,
      trialsAttempted: attempted,
      candidateTrials: this.config.algorithm.skill.candidateTrials,
      minEtaForRetrieval: this.config.algorithm.skill.minEtaForRetrieval,
      repairCandidateMinEta: this.config.algorithm.skill.repairCandidateMinEta,
      repairOrigin: currentSkill?.repairOrigin ?? false,
      archiveEta: this.config.algorithm.skill.archiveEta
    });
    const previous = memory;
    const next = updateSkillStats(memory, {
      trialsAttempted: attempted,
      trialsPassed: passed,
      eta,
      status,
      updatedAt: at
    });
    const saved = this.repos.memories.update(next);
    this.repos.runtime.appendChange({
      memoryId: saved.id,
      namespaceId: namespaceIdFromMemory(saved),
      kind: "skill",
      op: "updated",
      entityId: saved.id,
      userId: saved.userId,
      changeType: "skill_trial_update",
      before: previous,
      after: saved,
      source: "worker.skill_trial_resolve",
      createdAt: at
    });
    this.recordApiLog(
      "skill_evolve",
      { phase: "done", skillId: saved.id, trialId: trial.id, reason: "skill_trial_update" },
      {
        skillId: saved.id,
        kind: status !== currentSkill?.status ? "skill.status.changed" : "skill.eta.updated",
        name: saved.memoryKey ?? saved.id,
        status,
        eta,
        reason: "skill trial update"
      },
      0,
      true,
      at
    );
  }

  private resolvePendingSkillTrialsForReward(input: {
    userId: string;
    episodeId: string;
    rHuman: number;
    feedbackId?: string;
    at: string;
  }): void {
    const trials = this.repos.runtime.listSkillTrials({
      userId: input.userId,
      episodeId: input.episodeId,
      status: "pending",
      limit: 100
    });
    for (const trial of trials) {
      const outcome = this.outcomeForSkillTrial(trial, {
        rHuman: input.rHuman,
        feedbackId: input.feedbackId
      });
      if (!outcome) {
        continue;
      }
      const before = trial;
      const updatedTrial = this.repos.runtime.updateSkillTrial({
        ...trial,
        status: skillTrialStatusFromOutcome(outcome),
        outcome,
        feedbackId: input.feedbackId,
        resolvedAt: input.at
      });
      const skillMemoryForTrial = this.repos.memories.get(updatedTrial.skillMemoryId);
      this.repos.runtime.appendChange({
        memoryId: updatedTrial.skillMemoryId,
        namespaceId: skillMemoryForTrial
          ? namespaceIdFromMemory(skillMemoryForTrial)
          : namespaceIdFromContext({ source: DEFAULT_NAMESPACE_SOURCE, profileId: "default", userId: updatedTrial.userId }),
        kind: "skill_trial",
        op: "updated",
        entityId: updatedTrial.id,
        userId: updatedTrial.userId,
        changeType: "skill_trial_resolved",
        before,
        after: updatedTrial,
        source: "worker.reward.updated",
        createdAt: input.at
      });
      if (outcome !== "unknown") {
        this.updateSkillTrialStats(updatedTrial, input.at);
      }
    }
  }

  private outcomeForSkillTrial(
    trial: SkillTrialRecord,
    payload: Record<string, unknown>,
    feedback?: FeedbackRecord
  ): SkillTrialRecord["outcome"] | undefined {
    const baseOutcome = typeof payload.rHuman === "number"
      ? outcomeFromReward(payload.rHuman, this.config.algorithm.skill)
      : feedback
      ? outcomeFromFeedback(feedback)
      : undefined;
    if (baseOutcome !== "success") {
      return baseOutcome;
    }
    const skill = this.repos.memories.get(trial.skillMemoryId);
    const skillMeta = skill ? skillMetaFromMemory(skill) : null;
    if (!skillMeta?.strictTrial) {
      return baseOutcome;
    }
    const explicitVerifier = firstBoolean(
      payload.verifierPassed,
      payload.fullPass,
      payload.passed,
      payload.verifier_passed,
      payload.full_pass
    );
    if (explicitVerifier === true) return "success";
    if (explicitVerifier === false) return "failure";
    const rawTurn = trial.rawTurnId ? this.repos.runtime.getRawTurn(trial.rawTurnId) : undefined;
    return rawTurn?.status === "succeeded" ? "success" : "unknown";
  }

  private async enhancePolicyDraft(
    signature: string,
    evidenceTraces: TraceMeta[],
    fallback: PolicyDraft
  ): Promise<PolicyEnhancementResult> {
    if (!this.config.algorithm.l2Induction.useLlm || !this.skillLlm.isConfigured()) {
      return { ok: false, reason: "llm_disabled" };
    }
    try {
      const result = await this.skillLlm.completeJson<{
        title?: unknown;
        trigger?: unknown;
        action?: unknown;
        procedure?: unknown;
        verification?: unknown;
        boundary?: unknown;
        rationale?: unknown;
        caveats?: unknown;
        confidence?: unknown;
        support_trace_ids?: unknown;
        tags?: unknown;
      }>([
        {
          role: "system",
          content: L2_INDUCTION_PROMPT.system
        },
        {
          role: "system",
          content: languageSteeringLine(detectDominantLanguage(
            evidenceTraces.flatMap((trace) => [trace.userText, trace.agentText, trace.reflection])
          ))
        },
        {
          role: "user",
          content: packL2InductionTraces(
            evidenceTraces,
            this.config.algorithm.l2Induction.traceCharCap,
            signature
          )
        }
      ], {
        operation: `${L2_INDUCTION_PROMPT.id}.v${L2_INDUCTION_PROMPT.version}`,
        thinkingMode: "enabled",
        temperature: 0.1,
        maxTokens: 1200
      });
      const invalidReason = l2InductionInvalidReason(result);
      if (invalidReason) {
        return { ok: false, reason: invalidReason };
      }
      const boundary = typeof result.boundary === "string" ? skillMarkdown(result.boundary) : "";
      const procedure = skillMarkdown(firstString(result.procedure, result.action));
      const verification = typeof result.verification === "string" ? skillMarkdown(result.verification) : "";
      const next = {
        ...fallback,
        title: skillText(result.title),
        trigger: skillMarkdown(result.trigger),
        procedure,
        verification,
        boundary,
        confidence: clampNumber(numberOr(result.confidence, fallback.confidence), 0, 1)
      };
      return {
        ok: true,
        draft: {
          ...next,
          body: renderPolicyBody(next)
        }
      };
    } catch (error) {
      return { ok: false, reason: `llm-failed: ${errorMessageFromUnknown(error) ?? "unknown"}` };
    }
  }

  private async enhanceWorldModelDrafts(
    fallbacks: WorldModelDraft[],
    policies: PolicyMeta[],
    userId: string
  ): Promise<WorldModelEnhancementResult[]> {
    const out: WorldModelEnhancementResult[] = [];
    for (const fallback of fallbacks) {
      if (!fallback.vec) {
        out.push({ ok: false, fallback, reason: "no_centroid" });
        continue;
      }
      if (!this.config.algorithm.l3Abstraction.useLlm || !this.skillLlm.isConfigured()) {
        out.push({ ok: false, fallback, reason: "llm_disabled" });
        continue;
      }
      try {
        const selectedPolicies = policies
          .filter((policy) => fallback.policyIds.includes(policy.id))
          .slice(0, 8);
        const languageSamples: Array<string | null | undefined> = [];
        const policySummaries = selectedPolicies
          .map((policy) => {
            const traces = this.gatherWorldModelEvidence(policy, userId);
            languageSamples.push(
              policy.title,
              policy.trigger,
              policy.procedure,
              policy.verification,
              policy.boundary
            );
            for (const trace of traces) {
              languageSamples.push(trace.userText, trace.agentText, trace.reflection);
            }
            const traceBlocks = traces
              .map((trace) => [
                `  trace ${trace.id} (V=${roundNumber(trace.value)}):`,
                `  tags: ${trace.tags.join(",") || "-"}`,
                `  user: ${capText(trace.userText, 160)}`,
                `  agent: ${capText(trace.agentText, 240)}`,
                `  reflection: ${capText(trace.reflection ?? "-", 200)}`
              ].join("\n"))
              .join("\n");
            return capText([
              `- ${policy.title}`,
              `  trigger=${policy.trigger}`,
              `  procedure=${policy.procedure}`,
              `  verification=${policy.verification}`,
              `  boundary=${policy.boundary}`,
              `  support=${policy.support}; gain=${roundNumber(policy.gain)}`,
              traceBlocks ? `  evidence:\n${traceBlocks}` : undefined
            ].filter(Boolean).join("\n"), this.config.algorithm.l3Abstraction.policyCharCap);
          })
          .join("\n");
        const result = await this.skillLlm.completeJson<{
          title?: unknown;
          body?: unknown;
          structure?: unknown;
          environment?: unknown;
          inference?: unknown;
          constraints?: unknown;
          confidence?: unknown;
          domain_tags?: unknown;
          tags?: unknown;
        }>([
          {
            role: "system",
            content: L3_ABSTRACTION_PROMPT.system
          },
          {
            role: "system",
            content: languageSteeringLine(detectDominantLanguage(languageSamples))
          },
          {
            role: "user",
            content: [
              `CLUSTER_KEY: ${fallback.domainKey}`,
              `ADMISSION: ${fallback.admission} (cohesion=${roundNumber(fallback.cohesion)})`,
              `DOMAIN_TAGS: ${fallback.domainTags.join(", ") || "-"}`,
              `POLICIES (${selectedPolicies.length}):`,
              policySummaries
            ].join("\n")
          }
        ], {
          operation: `${L3_ABSTRACTION_PROMPT.id}.v${L3_ABSTRACTION_PROMPT.version}`,
          thinkingMode: "enabled",
          temperature: 0.15
        });
        const invalidReason = l3AbstractionInvalidReason(result);
        if (invalidReason) {
          out.push({ ok: false, fallback, reason: invalidReason });
          continue;
        }
        const title = skillText(result.title);
        const structure = coerceWorldModelStructure(result, fallback.structure);
        const body = typeof result.body === "string" && skillMarkdown(result.body)
          ? skillMarkdown(result.body)
          : renderWorldModelBody(title, structure);
        const domainTags = normaliseWorldModelTags(result.domain_tags);
        const effectiveDomainTags = domainTags.length > 0 ? domainTags : fallback.domainTags;
        out.push({
          ok: true,
          draft: {
            ...fallback,
            title,
            body,
            structure,
            confidence: shapeWorldModelConfidence(
              numberOr(result.confidence, fallback.confidence),
              fallback.admission,
              fallback.cohesion
            ),
            domainTags: effectiveDomainTags,
            tags: uniq([...fallback.tags, ...effectiveDomainTags, ...normaliseWorldModelTags(result.tags)])
          }
        });
      } catch (error) {
        out.push({ ok: false, fallback, reason: `llm-failed: ${errorMessageFromUnknown(error) ?? "unknown"}` });
      }
    }
    return out;
  }

  private async enhanceSkillDraft(
    policy: PolicyMeta,
    fallback: SkillDraft,
    evidenceTraces: TraceMeta[],
    counterExamples: TraceMeta[],
    existingSkill?: NonNullable<ReturnType<typeof skillMetaFromMemory>> | null
  ): Promise<SkillEnhancementResult> {
    if (!this.config.algorithm.skill.useLlm || !this.skillLlm.isConfigured()) {
      return { ok: false, reason: "llm_disabled" };
    }
    try {
      const evidenceTools = Array.from(extractToolNamesFromTraces(evidenceTraces));
      const existingSkillNames = this.repos.memories
        .list({ memoryLayer: "Skill", status: ["activated", "resolving"] }, 1000)
        .map(skillMetaFromMemory)
        .filter((skill): skill is NonNullable<ReturnType<typeof skillMetaFromMemory>> => Boolean(skill))
        .map((skill) => skill.name);
      const languageSamples = [
        policy.title,
        policy.trigger,
        policy.procedure,
        ...evidenceTraces.flatMap((trace) => [trace.userText, trace.agentText, trace.reflection])
      ];
      const outputLanguage = skillOutputLanguageFor(
        this.config.algorithm.skill.outputLanguageMode,
        detectDominantLanguage(languageSamples)
      );
      const rebuild = existingSkill ? skillRebuildPlan(policy, existingSkill, evidenceTraces) : null;
      const prompt = rebuild ? SKILL_REBUILD_PROMPT : SKILL_CRYSTALLIZE_PROMPT;
      const result = await this.skillLlm.completeJson<{
        name?: unknown;
        retrieval_blurb?: unknown;
        retrievalBlurb?: unknown;
        trigger_context?: unknown;
        triggerContext?: unknown;
        displayTitle?: unknown;
        display_title?: unknown;
        summary?: unknown;
        parameters?: unknown;
        preconditions?: unknown;
        steps?: unknown;
        examples?: unknown;
        decisionGuidance?: unknown;
        decision_guidance?: unknown;
        tools?: unknown;
        procedureJson?: unknown;
        tags?: unknown;
        changed_sections?: unknown;
        changedSections?: unknown;
      }>([
        {
          role: "system",
          content: prompt.system
        },
        {
          role: "system",
          content: languageSteeringLine(detectDominantLanguage(languageSamples))
        },
        {
          role: "user",
          content: JSON.stringify({
            policy: {
              id: policy.id,
              title: policy.title,
              trigger: policy.trigger,
              procedure: policy.procedure,
              verification: policy.verification,
              boundary: policy.boundary,
              support: policy.support,
              gain: policy.gain
            },
            evidence: evidenceTraces.slice(0, this.config.algorithm.skill.evidenceLimit).map((trace) => ({
              id: trace.id,
              episodeId: trace.episodeId,
              episode_outcome: skillEvidenceEpisodeOutcome(skillEvidenceEpisode(this.repos.runtime, trace.episodeId)),
              episode_r_task: skillEvidenceEpisode(this.repos.runtime, trace.episodeId)?.rTask ?? null,
              reflection: trace.reflection,
              user: trace.userText,
              agent: trace.agentText,
              value: trace.value,
              alpha: trace.alpha,
              tags: trace.tags
            })),
            ...(counterExamples.length > 0
              ? {
                  counter_examples: counterExamples.slice(0, 5).map((trace) => ({
                    id: trace.id,
                    episodeId: trace.episodeId,
                    reflection: trace.reflection,
                    user: trace.userText,
                    agent: trace.agentText,
                    value: trace.value,
                    tags: trace.tags
                  }))
                }
              : {}),
            ...(policy.decisionGuidance.preference.length > 0 || policy.decisionGuidance.antiPattern.length > 0
              ? {
                  repair_hints: {
                    preference: policy.decisionGuidance.preference,
                    antiPattern: policy.decisionGuidance.antiPattern
                  }
                }
              : {}),
            evidence_tools: evidenceTools,
            naming_space: existingSkillNames,
            output_language: outputLanguage,
            ...(rebuild
              ? {
                  existing_skill_snapshot: rebuild.snapshot,
                  incremental_evidence: rebuild.incrementalEvidence.map((trace) => ({
                    id: trace.id,
                    episodeId: trace.episodeId,
                    user: trace.userText,
                    agent: trace.agentText,
                    reflection: trace.reflection,
                    value: trace.value,
                    tags: trace.tags
                  })),
                  rebuild_level: rebuild.level,
                  repair_rename_allowed: false
                }
              : {}),
            fallback: {
              name: fallback.name,
              invocationGuide: fallback.invocationGuide,
              procedureJson: fallback.procedureJson,
              tags: fallback.tags
            }
          })
        }
      ], {
        operation: rebuild ? `${prompt.id}.v${prompt.version}` : prompt.id,
        thinkingMode: "enabled",
        temperature: 0.2
      });
      if (detectSkillModelRefusal(result)) {
        return { ok: false, reason: "llm-refusal" };
      }
      const invalidReason = skillCrystallizerInvalidReason(result);
      if (invalidReason) {
        return { ok: false, reason: invalidReason };
      }
      const llmProcedureJson = coerceSkillProcedureJson(result);
      const procedureJson = rebuild
        ? mergeSkillRebuildProcedureJson(
            skillProcedureJsonFromMemory(existingSkill?.memory),
            llmProcedureJson,
            rebuild.level,
            stringArray(result.changed_sections ?? result.changedSections)
          )
        : llmProcedureJson;
      const skillName = rebuild
        ? existingSkill?.name ?? fallback.name
        : coerceSkillName(result.name, `skill_${policy.id.slice(-6)}`);
      const displayTitle = skillText(result.display_title ?? result.displayTitle ?? policy.title ?? skillName) || skillName;
      const invocationGuide = renderSkillInvocationGuide({
        name: skillName,
        displayTitle,
        procedureJson,
        policy
      });
      return {
        ok: true,
        draft: {
          ...fallback,
          name: skillName,
          invocationGuide,
          procedureJson,
          tags: dedupeCaseInsensitiveStrings([...fallback.tags, ...stringArray(result.tags)])
        }
      };
    } catch (error) {
      return { ok: false, reason: `llm-failed: ${errorMessageFromUnknown(error) ?? "unknown"}` };
    }
  }

  private async scoreFeedbackWithLlm(input: {
    source: MemoryRow;
    trace: TraceMeta;
    episodeTraces: TraceMeta[];
    fallback: HumanScoreResult;
    payload: Record<string, unknown>;
  }): Promise<HumanScoreResult> {
    if (!this.config.algorithm.reward.llmScoring || !this.skillLlm.isConfigured()) {
      return input.fallback;
    }
    try {
      const rawTurnId = rawTurnIdFromMemory(input.source);
      const rawTurn = rawTurnId ? this.repos.runtime.getRawTurn(rawTurnId) : undefined;
      const episode = input.trace.episodeId ? this.repos.runtime.getEpisode(input.trace.episodeId) : undefined;
      const rawTurns = episode ? this.repos.runtime.listRawTurnsByEpisode(episode.id, 100) : (rawTurn ? [rawTurn] : []);
      const hostAgentContext = {
        hostAgentKind: input.source.agentId ?? undefined,
        hostAppId: input.source.appId ?? undefined,
        hostSessionId: input.source.sessionId ?? rawTurn?.sessionId,
        hostConversationId: input.source.conversationId ?? rawTurn?.conversationId
      };
      const result = await this.skillLlm.completeJson<{
        goal_achievement?: unknown;
        process_quality?: unknown;
        user_satisfaction?: unknown;
        goalAchievement?: unknown;
        processQuality?: unknown;
        userSatisfaction?: unknown;
        label?: unknown;
        reason?: unknown;
      }>([
        {
          role: "system",
          content: REWARD_R_HUMAN_PROMPT.system
        },
        {
          role: "user",
          content: [
            "HOST_AGENT_CONTEXT:",
            stableStringify(hostAgentContext),
            "",
            "TASK_SUMMARY:",
            buildRewardTaskSummary({
              source: input.source,
              trace: input.trace,
              episode,
              rawTurns,
              episodeTraces: input.episodeTraces,
              maxChars: this.config.algorithm.reward.summaryMaxChars,
              evaluator: {
                scorerProvider: this.skillLlm.config.provider,
                scorerModel: this.skillLlm.config.model
              }
            }),
            "",
            "FEEDBACK:",
            stableStringify(input.payload)
          ].join("\n\n")
        }
      ], {
        operation: `reward.${REWARD_R_HUMAN_PROMPT.id}.v${REWARD_R_HUMAN_PROMPT.version}`,
        thinkingMode: "disabled",
        temperature: 0,
        maxTokens: 700
      });
      const rawGoalAchievement = result.goal_achievement ?? result.goalAchievement;
      const rawProcessQuality = result.process_quality ?? result.processQuality;
      const rawUserSatisfaction = result.user_satisfaction ?? result.userSatisfaction;
      if (
        typeof rawGoalAchievement !== "number" || !Number.isFinite(rawGoalAchievement) ||
        typeof rawProcessQuality !== "number" || !Number.isFinite(rawProcessQuality) ||
        typeof rawUserSatisfaction !== "number" || !Number.isFinite(rawUserSatisfaction)
      ) {
        throw new Error("reward response missing valid scoring axes");
      }
      const goalAchievement = clampNumber(rawGoalAchievement, -1, 1);
      const processQuality = clampNumber(rawProcessQuality, -1, 1);
      const userSatisfaction = clampNumber(rawUserSatisfaction, -1, 1);
      return {
        rHuman: combineRewardAxes({
          goalAchievement,
          processQuality,
          userSatisfaction
        }),
        axes: {
          goalAchievement,
          processQuality,
          userSatisfaction
        },
        reason: stringOr(result.reason, input.fallback.reason),
        source: "llm"
      };
    } catch (error) {
      pipelineLogger.warn("fallback.used", {
        operation: `reward.${REWARD_R_HUMAN_PROMPT.id}.v${REWARD_R_HUMAN_PROMPT.version}`,
        pipeline: "reward.scoring",
        fallback: "heuristic_score",
        sourceMemoryId: input.source.id,
        ...memoryErrorFields(error)
      });
      return input.fallback;
    }
  }

  private async applyReward(job: EvolutionJobRecord): Promise<void> {
    const rewardSource = this.rewardSourceForJob(job);
    if (!rewardSource) {
      return;
    }
    const { source, trace } = rewardSource;
    const hasFeedbackSignal =
      typeof job.payload.polarity === "string" ||
      typeof job.payload.magnitude === "number" ||
      typeof job.payload.rationale === "string";
    const fallbackFeedback = heuristicHumanScore(hasFeedbackSignal
      ? [
          {
            channel: job.payload.channel === "implicit" ? "implicit" : "explicit",
            polarity: job.payload.polarity === "negative"
              ? "negative"
              : job.payload.polarity === "neutral"
              ? "neutral"
              : "positive",
            magnitude: typeof job.payload.magnitude === "number" ? job.payload.magnitude : 1,
            rationale: typeof job.payload.rationale === "string" ? job.payload.rationale : undefined
          }
        ]
      : []);
    const episodeTraces = this.repos.memories
      .list({ memoryLayer: "L1", status: "activated" }, 1000)
      .map((memory) => this.traceMeta(memory))
      .filter((item): item is TraceMeta =>
        Boolean(item && item.episodeId === trace.episodeId)
      )
      .sort((a, b) => a.ts - b.ts);
    const skipReason = hasFeedbackSignal
      ? null
      : rewardSkipReason(episodeTraces, this.config.algorithm.reward);
    if (skipReason && trace.episodeId) {
      const previousEpisode = this.repos.runtime.getEpisode(trace.episodeId);
      const scoredAt = nowIso();
      const rewardDetail = {
        rHuman: 0,
        source: "heuristic",
        axes: {
          goalAchievement: 0,
          processQuality: 0,
          userSatisfaction: 0
        },
        reason: skipReason,
        scoredAt,
        trigger: typeof job.payload.trigger === "string" ? job.payload.trigger : job.jobType,
        skipped: true,
        traceCount: 0,
        traceIds: []
      };
      const savedEpisode = this.repos.runtime.updateEpisodeReward(trace.episodeId, {
        rTask: 0,
        rewardDetail,
        metaPatch: {
          ...(previousEpisode?.meta.closeReason === "finalized"
            ? {}
            : {
                closeReason: "abandoned",
                abandonReason: skipReason
              }),
          reward: rewardDetail
        }
      });
      if (savedEpisode) {
        this.repos.runtime.appendChange({
          memoryId: savedEpisode.id,
          namespaceId: namespaceIdFromMemory(source),
          kind: "episode",
          op: "updated",
          entityId: savedEpisode.id,
          userId: savedEpisode.userId,
          changeType: "episode_reward_skipped",
          before: previousEpisode,
          after: savedEpisode,
          source: "worker.reward.skip.v7",
          createdAt: savedEpisode.updatedAt
        });
      }
      return;
    }
    const feedback = await this.scoreFeedbackWithLlm({
      source,
      trace,
      episodeTraces,
      fallback: fallbackFeedback,
      payload: job.payload
    });
    let rewardedEpisode: EpisodeRecord | undefined;
    if (trace.episodeId) {
      const previousEpisode = this.repos.runtime.getEpisode(trace.episodeId);
      const rewardDetail = {
        rHuman: feedback.rHuman,
        source: feedback.source,
        axes: feedback.axes,
        reason: feedback.reason,
        scoredAt: nowIso(),
        trigger: typeof job.payload.trigger === "string"
          ? job.payload.trigger
          : typeof job.payload.reason === "string"
          ? job.payload.reason
          : job.jobType,
        traceCount: episodeTraces.length,
        traceIds: episodeTraces.map((item) => item.id)
      };
      const savedEpisode = this.repos.runtime.updateEpisodeReward(trace.episodeId, {
        rTask: feedback.rHuman,
        rewardDetail,
        metaPatch: {
          reward: rewardDetail
        }
      });
      rewardedEpisode = savedEpisode;
      if (savedEpisode) {
        this.repos.runtime.appendChange({
          memoryId: savedEpisode.id,
          namespaceId: namespaceIdFromMemory(source),
          kind: "episode",
          op: "updated",
          entityId: savedEpisode.id,
          userId: savedEpisode.userId,
          changeType: "episode_reward_update",
          before: previousEpisode,
          after: savedEpisode,
          source: "worker.reward.backprop.v7",
          createdAt: savedEpisode.updatedAt
        });
      }
      this.resolvePendingSkillTrialsForReward({
        userId: source.userId,
        episodeId: trace.episodeId,
        rHuman: feedback.rHuman,
        feedbackId: typeof job.payload.feedbackId === "string" ? job.payload.feedbackId : undefined,
        at: savedEpisode?.updatedAt ?? nowIso()
      });
    }
    const updates = backpropagateTraces({
      traces: episodeTraces,
      rHuman: feedback.rHuman,
      gamma: this.config.algorithm.reward.gamma,
      lambda: this.config.algorithm.reward.lambda,
      delta: this.config.algorithm.reward.delta,
      decayHalfLifeDays: this.config.algorithm.reward.decayHalfLifeDays
    });
    const at = nowIso();
    const l2Eligible: Array<{ memory: MemoryRow; trace: TraceMeta }> = [];
    for (const update of updates) {
      const current = this.repos.memories.get(update.traceId);
      if (!current) continue;
      const previous = current;
      const next = updateTraceScore(current, {
        value: update.value,
        alpha: update.alpha,
        priority: update.priority,
        rHuman: feedback.rHuman,
        rewardReason: feedback.reason,
        sourceFeedbackId: typeof job.payload.feedbackId === "string" ? job.payload.feedbackId : undefined,
        updatedAt: at
      });
      const saved = this.repos.memories.update(next);
      this.repos.runtime.appendChange({
        memoryId: saved.id,
        namespaceId: namespaceIdFromMemory(saved),
        kind: kindFromMemory(saved),
        op: "updated",
        entityId: saved.id,
        userId: saved.userId,
        changeType: "reward_update",
        before: previous,
        after: saved,
        source: "worker.reward.backprop.v7",
        createdAt: at
      });
      const savedTrace = this.traceMeta(saved);
      if (job.payload.downstreamScheduled !== true && savedTrace && this.isTraceEligibleForL2(savedTrace)) {
        this.recordCandidatePoolTrace(savedTrace, signatureFromTrace(savedTrace), at);
        l2Eligible.push({ memory: saved, trace: savedTrace });
        this.enqueueJob({
          jobType: "l2_association",
          userId: saved.userId,
          sessionId: saved.sessionId,
          episodeId: trace.episodeId,
          targetMemoryId: saved.id,
          payload: {
            reason: "reward.updated"
          },
            createdAt: at
        });
      }
      await this.maybeCreateValueDistributionRepair(saved, at);
    }
    const inductionSeed = l2Eligible[0];
    if (job.payload.downstreamScheduled !== true && inductionSeed) {
      this.enqueueJob({
        jobType: "l2_induction",
        userId: inductionSeed.memory.userId,
        sessionId: inductionSeed.memory.sessionId,
        episodeId: trace.episodeId,
        targetMemoryId: inductionSeed.memory.id,
        payload: {
          reason: "reward.updated",
          targetKind: "episode_candidate_pool",
          sourceMemoryId: inductionSeed.memory.id,
          episodeTraceIds: l2Eligible.map((item) => item.memory.id)
        },
        createdAt: at
      });
    }
    if (rewardedEpisode) {
      this.finalizeClosedEpisode(rewardedEpisode, at, "episode_rewarded");
    }
  }

  private rewardSourceForJob(job: EvolutionJobRecord): { source: MemoryRow; trace: TraceMeta } | undefined {
    const direct = job.targetMemoryId ? this.repos.memories.get(job.targetMemoryId) : undefined;
    const directTrace = direct ? this.traceMeta(direct) : null;
    if (direct && directTrace) {
      return { source: direct, trace: directTrace };
    }

    const payloadL1MemoryId = typeof job.payload.l1MemoryId === "string" ? job.payload.l1MemoryId : undefined;
    const payloadMemory = payloadL1MemoryId ? this.repos.memories.get(payloadL1MemoryId) : undefined;
    const payloadTrace = payloadMemory ? this.traceMeta(payloadMemory) : null;
    if (payloadMemory && payloadTrace) {
      return { source: payloadMemory, trace: payloadTrace };
    }

    if (!job.episodeId) {
      return undefined;
    }
    const episode = this.repos.runtime.getEpisode(job.episodeId);
    const episodeMemories = episode?.l1MemoryIds.length
      ? this.repos.memories.getMany(episode.l1MemoryIds)
      : this.repos.memories.list({ memoryLayer: "L1", status: "activated" }, 1000);
    const traces = episodeMemories
      .map((memory) => ({ source: memory, trace: this.traceMeta(memory) }))
      .filter((item): item is { source: MemoryRow; trace: TraceMeta } =>
        Boolean(item.trace && item.trace.episodeId === job.episodeId)
      )
      .sort((a, b) => a.trace.ts - b.trace.ts);
    return traces[0];
  }

  private async maybeCreateValueDistributionRepair(triggerMemory: MemoryRow, at: string): Promise<DecisionRepairSummary | undefined> {
    const triggerTrace = this.traceMeta(triggerMemory);
    if (!triggerTrace?.signature) return undefined;
    const evidence = this.valueDistributionRepairEvidence(triggerTrace, this.config.algorithm.feedback.evidenceLimit);
    if (evidence.highValueMemories.length === 0 || evidence.lowValueMemories.length === 0) return undefined;
    const valueDiff = repairEvidenceValueDiff(evidence.highValueMemories, evidence.lowValueMemories);
    if (valueDiff < this.config.algorithm.feedback.valueDelta) return undefined;
    const contextHash = stableHash(`value-distribution:${triggerTrace.userId}:${triggerTrace.signature}`).slice(0, 16);
    const cooldownMs = this.config.algorithm.feedback.cooldownMs;
    if (cooldownMs > 0) {
      const since = new Date(Date.parse(at) - cooldownMs).toISOString();
      const recent = this.repos.runtime.listDecisionRepairs({
        userId: triggerTrace.userId,
        contextHash,
        since,
        limit: 1
      });
      if (recent.length > 0) {
        return {
          contextHash,
          skipped: true,
          reason: "cooldown"
        };
      }
    }

    const llmDraft = await this.maybeSynthesizeValueDistributionDecisionRepair(contextHash, triggerTrace, evidence);
    const preference = llmDraft?.preference ?? valueDistributionPreference(evidence.highValueMemories[0]);
    const antiPattern = llmDraft?.antiPattern ?? valueDistributionAntiPattern(evidence.lowValueMemories[0]);
    const session = triggerTrace.sessionId ? this.repos.runtime.getSession(triggerTrace.sessionId) : undefined;
    const repair = this.repos.runtime.insertDecisionRepair({
      id: newId("repair"),
      sessionId: triggerTrace.sessionId,
      episodeId: triggerTrace.episodeId,
      rawTurnId: rawTurnIdFromMemory(triggerMemory),
      userId: triggerTrace.userId,
      projectId: session?.projectId ?? session?.workspaceId,
      contextHash,
      issue: `Divergent outcomes for context signature ${clip(triggerTrace.signature, 160)}`,
      suggestion: preference,
      preference,
      antiPattern,
      highValueMemoryIds: evidence.highValueMemories.map((memory) => memory.id),
      lowValueMemoryIds: evidence.lowValueMemories.map((memory) => memory.id),
      attachedPolicyMemoryIds: evidence.policyIds,
      validated: false,
      source: {
        source: "worker.reward.value_distribution_repair.v7",
        trigger: "value-distribution",
        ...(llmDraft ? { synthesis: "llm" } : {}),
        signature: triggerTrace.signature,
        valueDiff,
        triggerTraceId: triggerTrace.id
      },
      meta: {
        trigger: "value-distribution",
        severity: llmDraft?.severity ?? "warn",
        confidence: llmDraft?.confidence ??
          (evidence.highValueMemories.length > 0 && evidence.lowValueMemories.length > 0 ? 0.6 : 0.4),
        valueDiff
      },
      createdAt: at
    });
    if (triggerTrace.episodeId) {
      this.repos.runtime.appendEpisodeDecisionRepair(triggerTrace.episodeId, repair.id, at);
    }
    const attachedPolicyIds = evidence.policyIds.length > 0
      ? this.attachRepairToPolicies(repair.id, evidence.policyIds, repair.preference, repair.antiPattern, at)
      : [];
    this.repos.runtime.appendChange({
      memoryId: repair.id,
      namespaceId: namespaceIdFromMemory(triggerMemory),
      userId: triggerTrace.userId,
      kind: "repair",
      op: "created",
      entityId: repair.id,
      changeType: "decision_repair_created",
      after: repair,
      source: "worker.reward.value_distribution_repair.v7",
      createdAt: at
    });
    return {
      repairId: repair.id,
      contextHash,
      skipped: false,
      attachedPolicyIds
    };
  }

  private valueDistributionRepairEvidence(trace: TraceMeta, limit: number): {
    highValueMemories: MemoryRow[];
    lowValueMemories: MemoryRow[];
    policyIds: string[];
  } {
    const highValueMemories: MemoryRow[] = [];
    const lowValueMemories: MemoryRow[] = [];
    const policyIds = new Set<string>();
    const memories = this.repos.memories.list({
      userId: trace.userId,
      memoryLayer: "L1",
      status: "activated"
    }, 1000);
    for (const memory of memories) {
      const candidate = this.traceMeta(memory);
      if (!candidate || candidate.signature !== trace.signature) continue;
      if (candidate.value > 0 && highValueMemories.length < limit) {
        highValueMemories.push(memory);
      }
      if (
        candidate.value < -this.config.algorithm.feedback.minLowValueThreshold &&
        lowValueMemories.length < limit
      ) {
        lowValueMemories.push(memory);
      }
      if (highValueMemories.includes(memory) || lowValueMemories.includes(memory)) {
        for (const link of this.repos.runtime.listTracePolicyLinks({
          userId: trace.userId,
          l1MemoryId: memory.id,
          limit: 20
        })) {
          policyIds.add(link.l2MemoryId);
        }
      }
    }
    highValueMemories.sort((a, b) => (this.traceMeta(b)?.value ?? 0) - (this.traceMeta(a)?.value ?? 0));
    lowValueMemories.sort((a, b) => (this.traceMeta(a)?.value ?? 0) - (this.traceMeta(b)?.value ?? 0));
    return {
      highValueMemories: highValueMemories.slice(0, limit),
      lowValueMemories: lowValueMemories.slice(0, limit),
      policyIds: [...policyIds].slice(0, limit)
    };
  }

  private async maybeSynthesizeValueDistributionDecisionRepair(
    contextHash: string,
    trace: TraceMeta,
    evidence: {
      highValueMemories: MemoryRow[];
      lowValueMemories: MemoryRow[];
      policyIds: string[];
    }
  ): Promise<DecisionRepairLlmDraft | undefined> {
    if (!this.config.algorithm.feedback.useLlm || !this.skillLlm.isConfigured()) {
      return undefined;
    }
    const messages = decisionRepairPromptMessages({
      trigger: "value-distribution",
      contextHash,
      feedbackText: `Same context signature has divergent outcomes: ${trace.signature}`,
      classification: {
        shape: "negative",
        confidence: 0.6,
        avoid: trace.summary,
        text: trace.summary
      },
      highValue: this.decisionRepairTraceSources(evidence.highValueMemories),
      lowValue: this.decisionRepairTraceSources(evidence.lowValueMemories),
      traceCharCap: this.config.algorithm.feedback.traceCharCap
    });
    try {
      const result = await this.skillLlm.completeJson<{
        preference?: unknown;
        anti_pattern?: unknown;
        severity?: unknown;
        confidence?: unknown;
      }>(messages, {
        operation: DECISION_REPAIR_OPERATION,
        thinkingMode: "enabled",
        temperature: this.skillLlm.config.temperature,
        maxTokens: 800
      });
      return normalizeDecisionRepairLlmDraft(result);
    } catch (error) {
      pipelineLogger.warn("fallback.used", {
        operation: DECISION_REPAIR_OPERATION,
        pipeline: "decision_repair.value_distribution",
        fallback: "no_llm_draft",
        sourceMemoryId: trace.id,
        ...memoryErrorFields(error)
      });
      return undefined;
    }
  }

  private recordCandidatePoolTrace(
    trace: NonNullable<ReturnType<typeof traceMetaFromMemory>>,
    signature: string,
    at: string
  ): void {
    const id = l2CandidateIdFor(signature, trace.id);
    this.repos.runtime.upsertCandidatePoolTrace({
      id,
      userId: trace.userId,
      sessionId: trace.sessionId,
      sourceMemoryId: trace.id,
      candidateKey: signature,
      candidateValue: trace.summary,
      score: trace.priority,
      evidence: {
        traceId: trace.id,
        episodeId: trace.episodeId,
        value: trace.value,
        priority: trace.priority,
        tags: trace.tags
      },
      createdAt: at,
      updatedAt: at,
      expiresAt: this.candidateExpiresAt(at)
    });
  }

  private isTraceEligibleForL2(trace: NonNullable<ReturnType<typeof traceMetaFromMemory>>): boolean {
    return trace.value >= this.config.algorithm.l2Induction.minTraceValue &&
      Boolean(trace.vecSummary ?? trace.vecAction);
  }

  private markCandidatePoolPromoted(
    userId: string,
    signature: string,
    sourceMemoryIds: string[],
    policyId: string,
    at: string
  ): void {
    this.repos.runtime.markCandidatePoolPromoted({
      userId,
      candidateKey: signature,
      sourceMemoryIds,
      policyId,
      at
    });
  }

  private candidateExpiresAt(at: string): string {
    const ttlMs = this.config.algorithm.l2Induction.candidateTtlDays * 24 * 60 * 60 * 1000;
    return new Date(Date.parse(at) + ttlMs).toISOString();
  }

  private appendJobChange(
    job: EvolutionJobRecord,
    op: "queued" | "leased" | "succeeded" | "failed" | "dead_letter",
    before?: EvolutionJobRecord
  ): void {
    const session = job.sessionId ? this.repos.runtime.getSession(job.sessionId) : undefined;
    this.repos.runtime.appendChange({
      memoryId: job.id,
      namespaceId: session ? namespaceIdFromSession(session) : undefined,
      userId: job.userId,
      kind: "job",
      op,
      entityId: job.id,
      changeType: `job_${op}`,
      before,
      after: job,
      source: "worker.evolution_jobs",
      createdAt: job.updatedAt
    });
  }

  private appendEmbeddingRetryChange(
    retry: EmbeddingRetryRecord,
    op: "queued" | "retry" | "succeeded" | "failed",
    before?: EmbeddingRetryRecord,
    error?: { code: string; message: string }
  ): void {
    const memory = this.repos.memories.get(retry.targetId);
    this.repos.runtime.appendChange({
      memoryId: retry.id,
      namespaceId: memory ? namespaceIdFromMemory(memory) : undefined,
      userId: memory?.userId ?? "system",
      kind: "job",
      op: `embedding_${op}`,
      entityId: retry.id,
      changeType: `embedding_retry_${op}`,
      before,
      after: error ? { ...retry, error } : retry,
      source: "worker.embedding_retry",
      createdAt: new Date(retry.updatedAt).toISOString()
    });
  }

  private enqueueEmbeddingRetry(
    memory: MemoryRow,
    sourceText: string,
    at: string,
    vectorField = embeddingRetryVectorFieldForMemory(memory)
  ): EmbeddingRetryRecord {
    return this.repos.runtime.enqueueEmbeddingRetry({
      targetKind: embeddingRetryTargetKindForMemory(memory),
      targetId: memory.id,
      vectorField,
      sourceText,
      embedRole: memory.memoryLayer === "L1" ? "document" : "query",
      now: Date.parse(at)
    });
  }

  private enqueueJob(input: {
    jobType: JobType;
    userId: string;
    sessionId?: string;
    episodeId?: string;
    targetMemoryId?: string;
    dedupeKey?: string;
    payload?: Record<string, unknown>;
    maxAttempts?: number;
    createdAt?: string;
  }): EvolutionJobRecord {
    const at = input.createdAt ?? nowIso();
    const dedupeKey = input.dedupeKey ?? evolutionJobDedupeKey(input);
    const job = this.repos.runtime.enqueueJob({
      id: newId("job"),
      jobType: input.jobType,
      status: "queued",
      dedupeKey,
      userId: input.userId,
      sessionId: input.sessionId,
      episodeId: input.episodeId,
      targetMemoryId: input.targetMemoryId,
      payload: input.payload ?? {},
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 3,
      createdAt: at,
      updatedAt: at
    });
    this.appendJobChange(job, "queued");
    return job;
  }

  private finalizeClosedEpisode(
    episode: EpisodeRecord,
    at: string,
    trigger: "topic_boundary" | "session_closed" | "episode_rewarded" | "idle_timeout"
  ): EvolutionJobRecord[] {
    const current = this.repos.runtime.getEpisode(episode.id) ?? episode;
    if (current.status !== "closed" || current.l1MemoryIds.length === 0) {
      return [];
    }
    if (this.episodeRewardWasSkipped(current)) {
      return [];
    }
    const reflectionJobs = this.enqueueEpisodeReflection(current, at, trigger);
    if (reflectionJobs.length > 0) {
      return reflectionJobs;
    }
    if (this.episodeHasRewardForReflection(current)) {
      return [];
    }
    return this.enqueueEpisodeRewardAfterReflection(current, at, trigger);
  }

  private enqueueEpisodeRewardAfterReflection(
    episode: EpisodeRecord,
    at: string,
    trigger: string
  ): EvolutionJobRecord[] {
    if (
      episode.status !== "closed" ||
      this.episodeHasRewardForReflection(episode) ||
      this.episodeRewardWasSkipped(episode) ||
      this.repos.runtime.hasEpisodeJob(episode.id, "reward", ["queued", "leased", "failed"])
    ) {
      return [];
    }
    const target = this.feedbackTargetFromEpisode(episode);
    if (!target) {
      return [];
    }
    const feedbackWindowSec = Math.max(1, this.config.algorithm.reward.feedbackWindowSec);
    const runAfter = new Date(Date.parse(at) + feedbackWindowSec * 1000).toISOString();
    return [this.enqueueJob({
      jobType: "reward",
      userId: episode.userId,
      sessionId: episode.sessionId,
      episodeId: episode.id,
      payload: {
        l1MemoryId: target.id,
        trigger,
        targetKind: "episode",
        runAfter
      },
      createdAt: at
    })];
  }

  private episodeHasRewardForReflection(episode: EpisodeRecord): boolean {
    return typeof episode.rTask === "number" && !this.episodeRewardWasSkipped(episode);
  }

  private episodeRewardWasSkipped(episode: EpisodeRecord): boolean {
    return episode.rewardDetail.skipped === true;
  }

  private enqueueEpisodeReflection(
    episode: EpisodeRecord,
    at: string,
    trigger: string
  ): EvolutionJobRecord[] {
    if (
      !this.config.algorithm.capture.synthReflection ||
      episode.status !== "closed" ||
      this.repos.runtime.hasEpisodeJob(episode.id, "reflection", ["queued", "leased", "failed"])
    ) {
      return [];
    }
    const target = this.repos.memories.getMany(episode.l1MemoryIds)
      .filter((memory) => memory.memoryLayer === "L1" && !traceReflectionWasScored(memory))
      .sort((a, b) => traceSortKey(a) - traceSortKey(b))[0];
    if (!target) {
      return [];
    }
    return [this.enqueueJob({
      jobType: "reflection",
      userId: episode.userId,
      sessionId: episode.sessionId,
      episodeId: episode.id,
      targetMemoryId: target.id,
      payload: {
        trigger,
        targetKind: "episode"
      },
      createdAt: at
    })];
  }

  private enqueueImportSummaryIfMissing(memory: MemoryRow, at: string): void {
    const jobType = memoryHasImportPipeline(memory) ? "import_summary" : "trace_summary";
    if (this.repos.runtime.hasPendingJob(memory.id, jobType, memory.contentHash ?? undefined)) {
      return;
    }
    this.repos.transaction(() => {
      const job = this.enqueueJob({
        jobType,
        userId: memory.userId,
        sessionId: memory.sessionId,
        targetMemoryId: memory.id,
        payload: {
          source: "worker.embedding.summary_guard",
          contentHash: memory.contentHash
        },
        maxAttempts: 3,
        createdAt: at
      });
      this.repos.processing.update(memory.id, {
        state: "summary_pending",
        stage: "summary",
        activeJobId: job.id,
        attemptCount: 0,
        retryAction: "retry",
        errorCode: null,
        errorMessage: null,
        failedAt: null,
        updatedAt: at
      }, ["embedding_pending", "embedding", "summary_pending", "summarizing"]);
    });
  }

  private buildMemory(input: {
    id?: string;
    userId: string;
    conversationId?: string;
    sessionId?: string;
    agentId?: string;
    appId?: string;
    projectId?: string;
    profileId?: string;
    layer: MemoryLayer;
    kind: MemoryKind;
    lifecycleStatus?: "candidate" | "active" | "archived";
    memoryType: string;
    key?: string;
    value: string;
    tags: string[];
    info?: Record<string, unknown>;
    internal?: Record<string, unknown>;
    createdAt?: string;
  }): MemoryRow {
    const at = input.createdAt ?? nowIso();
    const tags = uniq(input.tags.filter(Boolean));
    const memoryStatus = memoryStatusForLifecycleStatus(input.lifecycleStatus ?? "active");
    const inputInfo = input.info ?? {};
    const info = {
      ...inputInfo,
      tags: uniq([...tags, ...stringArray(inputInfo.tags)]),
      ...(input.projectId ? { project_id: input.projectId } : {}),
      ...(input.profileId ? { profile_id: input.profileId } : {})
    };
    return {
      id: input.id ?? newId(memoryIdPrefix(input.layer, input.kind)),
      timeline: at,
      userId: input.userId,
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      agentId: input.agentId,
      appId: input.appId,
      memoryType: input.memoryType,
      status: memoryStatus,
      visibility: "private",
      memoryKey: input.key,
      memoryValue: input.value,
      tags,
      info,
      properties: {
        memory_type: input.memoryType,
        status: memoryStatus,
        tags,
        info,
        internal_info: {
          memory_layer: input.layer,
          memory_kind: input.kind,
          schema_version: 1,
          ...(input.internal ?? {})
        }
      },
      memoryLayer: input.layer,
      contentHash: stableHash(input.value),
      version: 1,
      createdAt: at,
      updatedAt: at,
      deletedAt: null
    };
  }

  private assertMemoryAddEnabled(): void {
    if (!this.memoryAddEnabled()) {
      throw new MemoryServiceError("forbidden", "memory add is disabled by config");
    }
  }

  private assertMemorySearchEnabled(): void {
    if (!this.memorySearchEnabled()) {
      throw new MemoryServiceError("forbidden", "memory search is disabled by config");
    }
  }

  private readOnlyCursor(namespace?: RuntimeNamespace): { changeSeq: number; syncCursor: string } {
    const scoped = namespace ? normalizeNamespace(namespace) : undefined;
    const changeSeq = this.repos.runtime.latestChangeSeq(
      scoped?.userId,
      scoped ? namespaceIdFromContext(scoped) : undefined
    );
    return {
      changeSeq,
      syncCursor: this.encodeChangeCursor(changeSeq, scoped)
    };
  }

  private openSessionNoWrite(request: SessionOpenRequest): ReturnType<MemoryService["openSession"]> {
    const namespace = normalizeNamespace(request.namespace);
    const existing = request.sessionId
      ? this.repos.runtime.getSession(request.sessionId)
      : namespace.sessionKey
        ? this.repos.runtime.findOpenSessionByHostKey({
            userId: namespace.userId,
            source: request.source ?? namespace.source,
            profileId: request.profileId ?? namespace.profileId,
            hostSessionKey: namespace.sessionKey
          })
        : undefined;
    if (existing) {
      this.assertSessionInScope(existing, request.namespace);
      return {
        sessionId: existing.id,
        userId: existing.userId,
        source: existing.source,
        profileId: existing.profileId,
        projectId: existing.projectId,
        workspaceId: existing.workspaceId,
        conversationId: existing.conversationId,
        status: "open",
        resumed: true,
        openedAt: existing.openedAt,
        serverTime: nowIso()
      };
    }
    const sessionId = request.sessionId ?? `session_${stableHash({
      userId: namespace.userId,
      source: request.source ?? namespace.source,
      profileId: request.profileId ?? namespace.profileId,
      sessionKey: namespace.sessionKey ?? "readonly"
    }).slice(0, 20)}`;
    return {
      sessionId,
      userId: namespace.userId,
      source: request.source ?? namespace.source,
      profileId: request.profileId ?? namespace.profileId,
      projectId: request.projectId ?? namespace.projectId ?? namespace.workspaceId,
      workspaceId: request.workspaceId ?? namespace.workspaceId,
      conversationId: stringFromMeta(request.meta, "conversationId"),
      status: "open",
      resumed: false,
      openedAt: nowIso(),
      serverTime: nowIso()
    };
  }

  private closeSessionNoWrite(sessionId: string, request: RequestEnvelope): ReturnType<MemoryService["closeSession"]> {
    const existing = this.repos.runtime.getSession(sessionId);
    if (existing) {
      this.assertSessionInScope(existing, request.namespace);
    }
    const cursor = this.readOnlyCursor(request.namespace ?? (existing ? namespaceForSession(existing) : undefined));
    return {
      ok: true,
      sessionId,
      status: "closed",
      closedEpisodeIds: [],
      changeSeq: cursor.changeSeq,
      syncCursor: cursor.syncCursor,
      closedAt: nowIso(),
      serverTime: nowIso()
    };
  }

  private async startTurnNoWrite(
    request: TurnStartRequest & Record<string, unknown>
  ): ReturnType<MemoryService["startTurn"]> {
    const turnId = request.turnId ?? newId("turn");
    const contextHints = turnStartContextHints(request);
    const search = await this.search({
      requestId: request.requestId,
      adapterId: request.adapterId,
      namespace: request.namespace,
      sessionId: request.sessionId,
      turnId,
      query: buildSearchQuery({ ...request, contextHints }, this.config.domain),
      layers: ["Skill", "L2", "L1", "L3"],
      limit: this.turnStartRetrievalLimit(),
      contextBudget: typeof request.contextBudget === "number" ? request.contextBudget : undefined,
      includeInjectedContext: true,
      retrievalMode: "turn_start",
      contextHints,
      injectedContextQuery: request.query
    });
    const episodeId = `episode_${stableHash(`readonly:${request.sessionId}:${turnId}`).slice(0, 20)}`;
    return {
      contextPacketId: `ctx_${stableHash(`${request.sessionId}:${episodeId}:${turnId}:${search.searchEventId}`).slice(0, 20)}`,
      turnId,
      sessionId: request.sessionId,
      episodeId,
      closedEpisodeIds: [],
      searchEventId: search.searchEventId,
      hits: search.hits,
      injectedContext: search.injectedContext,
      sourceMemoryIds: search.sourceMemoryIds,
      droppedDueToBudget: search.droppedDueToBudget,
      status: uniq([...search.status, "memory_add:disabled:no_turn_write"]),
      serverTime: nowIso()
    };
  }

  private completeTurnNoWrite(
    turnId: string,
    request: TurnCompleteRequest & Record<string, unknown>
  ): CompleteTurnResponse {
    const cursor = this.readOnlyCursor(request.namespace);
    const rawTurnId = `raw_${stableHash(`readonly:${request.sessionId}:${turnId}`).slice(0, 20)}`;
    const episodeId = request.episodeId ?? `episode_${stableHash(`readonly:${request.sessionId}:${turnId}`).slice(0, 20)}`;
    return {
      turnId,
      sessionId: request.sessionId,
      episodeId,
      rawTurnId,
      l1MemoryId: "",
      l1MemoryIds: [],
      closedEpisodeIds: [],
      scheduledEvolution: false,
      jobs: [],
      changeSeq: cursor.changeSeq,
      syncCursor: cursor.syncCursor,
      etag: stableHash({ memoryAdd: false, sessionId: request.sessionId, turnId }),
      serverTime: nowIso()
    };
  }

  private observeToolNoWrite(input: ToolObserveRequest): Promise<{
    ok: true;
    eventId: string;
    rawTurnId?: string;
    repair?: DecisionRepairSummary;
    changeSeq?: number;
    syncCursor?: string;
    serverTime: string;
  }> {
    const cursor = this.readOnlyCursor(input.namespace);
    return Promise.resolve({
      ok: true,
      eventId: `event_${stableHash({ toolName: input.toolName, sessionId: input.sessionId, turnId: input.turnId }).slice(0, 20)}`,
      changeSeq: cursor.changeSeq,
      syncCursor: cursor.syncCursor,
      serverTime: nowIso()
    });
  }

  private subagentStartNoWrite(input: SubagentStartRequest): ReturnType<MemoryService["subagentStart"]> {
    const cursor = this.readOnlyCursor(input.namespace);
    const rawTurnId = `raw_${stableHash(`readonly:subagent:${input.sessionId}:${input.subagentId ?? input.task}`).slice(0, 20)}`;
    return {
      ok: true,
      eventId: `event_${stableHash(rawTurnId).slice(0, 20)}`,
      rawTurnId,
      changeSeq: cursor.changeSeq,
      syncCursor: cursor.syncCursor,
      serverTime: nowIso()
    };
  }

  private feedbackNoWrite(request: FeedbackRequest): FeedbackResponse {
    const cursor = this.readOnlyCursor(request.namespace);
    const feedbackId = `feedback_${stableHash({
      sessionId: request.sessionId,
      target: request.target,
      polarity: request.polarity,
      rationale: request.rationale
    }).slice(0, 20)}`;
    return {
      id: feedbackId,
      ts: nowIso(),
      channel: request.channel,
      polarity: request.polarity,
      magnitude: request.magnitude ?? 1,
      scheduledEvolution: false,
      changeSeq: cursor.changeSeq,
      syncCursor: cursor.syncCursor,
      feedbackId,
      jobs: [],
      serverTime: nowIso()
    };
  }

  private runWorkerNoWrite(request: RequestEnvelope): ReturnType<MemoryService["runWorkerOnce"]> {
    const cursor = this.readOnlyCursor(request.namespace);
    return Promise.resolve({
      leased: 0,
      succeeded: 0,
      failed: 0,
      jobs: [],
      embeddingRetries: {
        leased: 0,
        succeeded: 0,
        failed: 0,
        items: []
      },
      changeSeq: cursor.changeSeq,
      syncCursor: cursor.syncCursor,
      serverTime: nowIso()
    });
  }

  private searchNoRead(
    request: InternalMemorySearchRequest,
    startedAt: number
  ): ReturnType<MemoryService["search"]> {
    const total = Date.now() - startedAt;
    const tuning = this.retrievalTuningConfig();
    const contextPacket = request.includeInjectedContext === false
      ? {
          injectedContext: emptyInjectedContext(),
          sourceMemoryIds: [],
          droppedDueToBudget: []
        }
      : buildInjectedContext(
          [],
          request.contextBudget ?? 1800,
          [],
          request.retrievalMode ?? "search",
          request.contextHints,
          request.injectedContextQuery ?? request.query,
          tuning
        );
    return Promise.resolve({
      searchEventId: `recall_${stableHash({
        disabled: "memory_search",
        query: request.query,
        sessionId: request.sessionId,
        turnId: request.turnId
      }).slice(0, 20)}`,
      hits: [],
      injectedContext: contextPacket.injectedContext,
      candidateMemoryIds: [],
      sourceMemoryIds: contextPacket.sourceMemoryIds,
      droppedDueToBudget: contextPacket.droppedDueToBudget,
      tierLatencyMs: {
        search: total,
        rerank: 0,
        budget: 0,
        total
      },
      status: ["memory_search:disabled"],
      verbose: request.verbose === true,
      serverTime: nowIso()
    });
  }

  private requireSession(sessionId: string): SessionRecord {
    const session = this.repos.runtime.getSession(sessionId);
    if (!session) {
      throw new MemoryServiceError("not_found", `session not found: ${sessionId}`);
    }
    return session;
  }

  private requireOpenSession(sessionId: string): SessionRecord {
    const session = this.requireSession(sessionId);
    if (session.status !== "open") {
      throw new MemoryServiceError("conflict", `session is closed: ${sessionId}`);
    }
    return session;
  }

  private requireExistingMemory(id: string): MemoryRow {
    const memory = this.repos.memories.get(id);
    if (!memory) {
      throw new MemoryServiceError("not_found", `memory not found: ${id}`);
    }
    return memory;
  }

  private requireRawTurn(rawTurnId: string): RawTurnRecord {
    const rawTurn = this.repos.runtime.getRawTurn(rawTurnId);
    if (!rawTurn) {
      throw new MemoryServiceError("not_found", `raw turn not found: ${rawTurnId}`);
    }
    return rawTurn;
  }

  private traceMeta(memory: MemoryRow | undefined | null): TraceMeta | null {
    if (!memory) return null;
    const rawTurnId = rawTurnIdFromMemory(memory);
    const rawTurn = rawTurnId ? this.repos.runtime.getRawTurn(rawTurnId) : undefined;
    return traceMetaFromMemoryWithRaw(memory, rawTurn);
  }

  private requireEpisode(episodeId: string): EpisodeRecord {
    const episode = this.repos.runtime.getEpisode(episodeId);
    if (!episode) {
      throw new MemoryServiceError("not_found", `episode not found: ${episodeId}`);
    }
    return episode;
  }

  private assertSessionInScope(session: SessionRecord, namespace?: RuntimeNamespace): void {
    void session;
    void namespace;
  }

  private assertMemoryInScope(memory: MemoryRow, namespace?: RuntimeNamespace): void {
    void memory;
    void namespace;
  }

  private assertEpisodeInScope(episode: EpisodeRecord, namespace?: RuntimeNamespace): void {
    void episode;
    void namespace;
  }

  private assertRawTurnInScope(rawTurn: RawTurnRecord, namespace?: RuntimeNamespace): void {
    void rawTurn;
    void namespace;
  }

  private jobStatusCounts(): Record<"queued" | "leased" | "succeeded" | "failed" | "dead_letter", number> {
    return {
      queued: this.repos.runtime.listJobs("queued", 1000).length,
      leased: this.repos.runtime.listJobs("leased", 1000).length,
      succeeded: this.repos.runtime.listJobs("succeeded", 1000).length,
      failed: this.repos.runtime.listJobs("failed", 1000).length,
      dead_letter: this.repos.runtime.listJobs("dead_letter", 1000).length
    };
  }

  private memoryLayerCounts(): Record<MemoryLayer, number> {
    return this.repos.memories.countByLayer();
  }

  private memoryStatusCounts(): Record<"activated" | "resolving" | "archived" | "deleted", number> {
    return this.repos.memories.countByStatus();
  }

  private episodeStatusCounts(): Record<"open" | "processing" | "closed", number> {
    return this.repos.runtime.countEpisodesByStatus();
  }

  private embeddingRetryStatusCounts(): Record<"pending" | "in_progress" | "succeeded" | "failed", number> {
    const statuses: EmbeddingRetryStatus[] = ["pending", "in_progress", "succeeded", "failed"];
    const counts = { pending: 0, in_progress: 0, succeeded: 0, failed: 0 };
    for (const status of statuses) {
      counts[status] = this.repos.runtime.countEmbeddingRetriesByStatus(status);
    }
    return counts;
  }

  private listAllMemoriesForStats(): MemoryRow[] {
    const rows: MemoryRow[] = [];
    const pageSize = 1000;
    for (let offset = 0;; offset += pageSize) {
      const batch = this.repos.memories.list({}, pageSize, offset);
      rows.push(...batch);
      if (batch.length < pageSize) break;
    }
    return rows;
  }

  private resolveSkillTrialEvidence(
    request: SkillUseRequest,
    session: SessionRecord,
    episode: EpisodeRecord
  ): {
    l1MemoryId?: string;
    rawTurnId?: string;
  } {
    let rawTurn = request.rawTurnId ? this.requireRawTurn(request.rawTurnId) : undefined;
    if (rawTurn) {
      this.assertRawTurnInScope(rawTurn, request.namespace);
      if (rawTurn.sessionId !== session.id) {
        throw new MemoryServiceError("conflict", "skill trial raw turn does not belong to the requested session");
      }
      if (rawTurn.episodeId !== episode.id) {
        throw new MemoryServiceError("conflict", "skill trial raw turn does not belong to the requested episode");
      }
    }

    if (request.l1MemoryId) {
      const memory = this.requireExistingMemory(request.l1MemoryId);
      this.assertMemoryInScope(memory, request.namespace);
      const trace = this.traceMeta(memory);
      if (!trace) {
        throw new MemoryServiceError("invalid_argument", "skill trial l1MemoryId must reference an L1 trace memory");
      }
      if (memory.sessionId && memory.sessionId !== session.id) {
        throw new MemoryServiceError("conflict", "skill trial memory does not belong to the requested session");
      }
      if (trace.episodeId && trace.episodeId !== episode.id) {
        throw new MemoryServiceError("conflict", "skill trial memory does not belong to the requested episode");
      }
      const traceRawTurnId = rawTurnIdFromMemory(memory);
      if (rawTurn && traceRawTurnId && traceRawTurnId !== rawTurn.id) {
        throw new MemoryServiceError("conflict", "skill trial memory does not belong to the requested raw turn");
      }
      return {
        l1MemoryId: memory.id,
        rawTurnId: rawTurn?.id ?? traceRawTurnId
      };
    }

    const rawTurnTarget = rawTurn ? this.feedbackTargetFromRawTurn(rawTurn) : undefined;
    if (rawTurn && rawTurnTarget) {
      return {
        l1MemoryId: rawTurnTarget.id,
        rawTurnId: rawTurn.id
      };
    }

    return {};
  }

  private resolveFeedbackContext(request: FeedbackRequest): ReturnType<MemoryService["resolveContext"]> {
    if (request.sessionId) {
      const session = this.repos.runtime.getSession(request.sessionId);
      if (session) {
        this.assertSessionInScope(session, request.namespace);
        return {
          userId: session.userId,
          conversationId: session.conversationId,
          namespace: namespaceForSession(session)
        };
      }
    }
    if (request.episodeId) {
      const episode = this.repos.runtime.getEpisode(request.episodeId);
      if (episode) {
        this.assertEpisodeInScope(episode, request.namespace);
        const session = this.repos.runtime.getSession(episode.sessionId);
        if (session) {
          return {
            userId: session.userId,
            conversationId: session.conversationId,
            namespace: namespaceForSession(session)
          };
        }
        return {
          userId: episode.userId,
          conversationId: episode.conversationId,
          namespace: {
            ...normalizeNamespace(request.namespace),
            userId: episode.userId
          }
        };
      }
    }
    if (request.rawTurnId) {
      const rawTurn = this.repos.runtime.getRawTurn(request.rawTurnId);
      if (rawTurn) {
        this.assertRawTurnInScope(rawTurn, request.namespace);
        const session = this.repos.runtime.getSession(rawTurn.sessionId);
        if (session) {
          return {
            userId: session.userId,
            conversationId: session.conversationId,
            namespace: namespaceForSession(session)
          };
        }
        return {
          userId: rawTurn.userId,
          conversationId: rawTurn.conversationId,
          namespace: {
            ...normalizeNamespace(request.namespace),
            userId: rawTurn.userId
          }
        };
      }
    }
    if (request.l1MemoryId) {
      const memory = this.repos.memories.get(request.l1MemoryId);
      if (memory) {
        this.assertMemoryInScope(memory, request.namespace);
        const session = memory.sessionId ? this.repos.runtime.getSession(memory.sessionId) : undefined;
        if (session) {
          return {
            userId: session.userId,
            conversationId: session.conversationId,
            namespace: namespaceForSession(session)
          };
        }
        return {
          userId: memory.userId,
          conversationId: memory.conversationId,
          namespace: namespaceForMemory(memory)
        };
      }
    }
    return this.resolveContext(request);
  }

  private resolveFeedbackAttribution(
    request: FeedbackRequest,
    context: ReturnType<MemoryService["resolveContext"]>
  ): FeedbackAttribution {
    let episode = request.episodeId ? this.requireEpisode(request.episodeId) : undefined;
    if (episode) {
      this.assertEpisodeInScope(episode, request.namespace);
      if (request.sessionId && episode.sessionId !== request.sessionId) {
        throw new MemoryServiceError("conflict", "feedback episode does not belong to the requested session");
      }
    }

    let rawTurn = request.rawTurnId ? this.requireRawTurn(request.rawTurnId) : undefined;
    if (rawTurn) {
      this.assertRawTurnInScope(rawTurn, request.namespace);
      if (request.sessionId && rawTurn.sessionId !== request.sessionId) {
        throw new MemoryServiceError("conflict", "feedback raw turn does not belong to the requested session");
      }
      if (episode && rawTurn.episodeId !== episode.id) {
        throw new MemoryServiceError("conflict", "feedback raw turn does not belong to the requested episode");
      }
      episode = episode ?? this.repos.runtime.getEpisode(rawTurn.episodeId);
    }

    if (request.l1MemoryId) {
      const memory = this.requireExistingMemory(request.l1MemoryId);
      this.assertMemoryInScope(memory, request.namespace);
      const trace = this.traceMeta(memory);
      if (!trace) {
        throw new MemoryServiceError("invalid_argument", "feedback l1MemoryId must reference an L1 trace memory");
      }
      const traceRawTurnId = rawTurnIdFromMemory(memory);
      if (request.sessionId && memory.sessionId && memory.sessionId !== request.sessionId) {
        throw new MemoryServiceError("conflict", "feedback memory does not belong to the requested session");
      }
      if (episode && trace.episodeId && trace.episodeId !== episode.id) {
        throw new MemoryServiceError("conflict", "feedback memory does not belong to the requested episode");
      }
      if (rawTurn && traceRawTurnId && traceRawTurnId !== rawTurn.id) {
        throw new MemoryServiceError("conflict", "feedback memory does not belong to the requested raw turn");
      }
      return {
        l1MemoryId: memory.id,
        rawTurnId: rawTurn?.id ?? traceRawTurnId,
        episodeId: episode?.id ?? trace.episodeId,
        sessionId: request.sessionId ?? memory.sessionId ?? rawTurn?.sessionId ?? episode?.sessionId
      };
    }

    const rawTurnTarget = rawTurn ? this.feedbackTargetFromRawTurn(rawTurn) : undefined;
    if (rawTurnTarget) {
      const trace = this.traceMeta(rawTurnTarget);
      return {
        l1MemoryId: rawTurnTarget.id,
        rawTurnId: rawTurn?.id ?? rawTurnIdFromMemory(rawTurnTarget),
        episodeId: episode?.id ?? trace?.episodeId,
        sessionId: request.sessionId ?? rawTurnTarget.sessionId ?? rawTurn?.sessionId ?? episode?.sessionId
      };
    }

    const episodeTarget = episode ? this.feedbackTargetFromEpisode(episode) : undefined;
    if (episode && episodeTarget) {
      const trace = this.traceMeta(episodeTarget);
      return {
        l1MemoryId: episodeTarget.id,
        rawTurnId: rawTurnIdFromMemory(episodeTarget),
        episodeId: episode.id ?? trace?.episodeId,
        sessionId: request.sessionId ?? episodeTarget.sessionId ?? episode.sessionId
      };
    }

    return {
      rawTurnId: rawTurn?.id,
      episodeId: episode?.id,
      sessionId: request.sessionId ?? rawTurn?.sessionId ?? episode?.sessionId
    };
  }

  private feedbackTargetFromRawTurn(rawTurn: RawTurnRecord): MemoryRow | undefined {
    const episode = this.repos.runtime.getEpisode(rawTurn.episodeId);
    for (const id of [...(episode?.l1MemoryIds ?? [])].reverse()) {
      const memory = this.repos.memories.get(id);
      if (memory && rawTurnIdFromMemory(memory) === rawTurn.id && this.traceMeta(memory)) {
        return memory;
      }
    }
    return this.repos.memories
      .list({ memoryLayer: "L1", status: "activated" }, 1000)
      .find((memory) => rawTurnIdFromMemory(memory) === rawTurn.id && Boolean(this.traceMeta(memory)));
  }

  private feedbackTargetFromEpisode(episode: EpisodeRecord): MemoryRow | undefined {
    for (const id of [...episode.l1MemoryIds].reverse()) {
      const memory = this.repos.memories.get(id);
      if (memory && this.traceMeta(memory)) {
        return memory;
      }
    }
    return undefined;
  }

  private captureEpisodeIncrementalSteps(
    episode: EpisodeRecord,
    currentRawTurn: RawTurnRecord,
    at: string
  ): ReturnType<typeof captureTurnSteps> {
    const seenRawTurnIds = new Set(
      episode.l1MemoryIds
        .map((id) => this.repos.memories.get(id))
        .filter((memory): memory is MemoryRow => Boolean(memory))
        .map((memory) => rawTurnIdFromMemory(memory))
        .filter((id): id is string => Boolean(id))
    );
    const rawTurns = uniq([...episode.rawTurnIds, currentRawTurn.id])
      .map((id) => id === currentRawTurn.id ? currentRawTurn : this.repos.runtime.getRawTurn(id))
      .filter((rawTurn): rawTurn is RawTurnRecord =>
        Boolean(rawTurn && (rawTurn.id === currentRawTurn.id || !seenRawTurnIds.has(rawTurn.id)))
      )
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    return rawTurns.flatMap((rawTurn) =>
      captureTurnSteps({
        episodeId: episode.id,
        sessionId: rawTurn.sessionId,
        turnId: rawTurn.turnId,
        userText: rawTurn.userText ?? "",
        assistantText: rawTurn.assistantText ?? "",
        reasoningSummary: rawTurn.reasoningSummary,
        toolCalls: rawTurn.toolCalls.filter(isToolCallPayload),
        toolResults: rawTurn.toolResults,
        createdAtIso: rawTurn.createdAt || at,
        maxTextChars: this.config.algorithm.capture.maxTextChars,
        maxToolOutputChars: this.config.algorithm.capture.maxToolOutputChars
      }).map((step) => ({ ...step, rawTurnId: rawTurn.id }))
    );
  }

  private encodeChangeCursor(seq: number, namespace?: RuntimeNamespace): string {
    const capabilities = this.storageCapabilities();
    const payload = {
      v: 1,
      backendId: capabilities.backendId,
      schemaVersion: capabilities.schemaVersion,
      namespaceId: namespace ? namespaceIdFromContext(normalizeNamespace(namespace)) : "",
      seq
    };
    return `cur_${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  }

  private decodeChangeCursor(cursor: string | undefined, namespace?: RuntimeNamespace): number {
    if (!cursor) return 0;
    if (/^\d+$/.test(cursor)) return Number(cursor);
    if (!cursor.startsWith("cur_")) {
      throw new MemoryServiceError("invalid_argument", "change cursor is not valid");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(cursor.slice(4), "base64url").toString("utf8")) as unknown;
    } catch {
      throw new MemoryServiceError("invalid_argument", "change cursor is not valid");
    }
    if (!isRecord(payload) || payload.v !== 1 || typeof payload.seq !== "number") {
      throw new MemoryServiceError("invalid_argument", "change cursor is not valid");
    }
    const capabilities = this.storageCapabilities();
    if (
      payload.backendId !== capabilities.backendId ||
      payload.schemaVersion !== capabilities.schemaVersion
    ) {
      throw new MemoryServiceError("conflict", "change cursor belongs to a different backend or schema");
    }
    return Math.max(0, Math.floor(payload.seq));
  }

  private async ensureEpisodeForTurnWithLlm(
    session: SessionRecord,
    episodeId: string | undefined,
    userText: string | undefined,
    source: string
  ): Promise<EpisodeRecord> {
    if (episodeId || !userText?.trim()) {
      return this.ensureEpisode(session, episodeId);
    }
    const latest = this.repos.runtime.latestEpisodeForSession(session.id);
    if (!latest) {
      return this.ensureEpisode(session);
    }
    const relationContext = this.episodeRelationContext(latest);
    if (!relationContext.prevUserText) {
      return this.ensureEpisode(session);
    }
    const decision = await classifyTurnRelationWithLlm({
      prevUserText: relationContext.prevUserText,
      prevAssistantText: relationContext.prevAssistantText,
      newUserText: userText,
      gapMs: relationContext.lastTurnAtMs
        ? Math.max(0, Date.now() - relationContext.lastTurnAtMs)
        : undefined,
      prevTags: relationContext.tags
    }, {
      llm: this.llm
    });
    return this.applyEpisodeRelationDecision(session, latest, decision, userText, source, relationContext.lastTurnAtMs);
  }

  private ensureEpisodeForTurn(
    session: SessionRecord,
    episodeId: string | undefined,
    userText: string | undefined,
    source: string
  ): EpisodeRecord {
    if (episodeId || !userText?.trim()) {
      return this.ensureEpisode(session, episodeId);
    }
    const latest = this.repos.runtime.latestEpisodeForSession(session.id);
    if (!latest) {
      return this.ensureEpisode(session);
    }
    const relationContext = this.episodeRelationContext(latest);
    if (!relationContext.prevUserText) {
      return this.ensureEpisode(session);
    }
    const decision = classifyTurnRelation({
      prevUserText: relationContext.prevUserText,
      prevAssistantText: relationContext.prevAssistantText,
      newUserText: userText,
      gapMs: relationContext.lastTurnAtMs
        ? Math.max(0, Date.now() - relationContext.lastTurnAtMs)
        : undefined,
      prevTags: relationContext.tags
    });
    return this.applyEpisodeRelationDecision(session, latest, decision, userText, source, relationContext.lastTurnAtMs);
  }

  private applyEpisodeRelationDecision(
    session: SessionRecord,
    latest: EpisodeRecord,
    decision: ReturnType<typeof classifyTurnRelation>,
    userText: string,
    source: string,
    lastTurnAtMs?: number
  ): EpisodeRecord {
    const mergeMode = this.config.algorithm.session.followUpMode === "merge_follow_ups";
    const gapMs = lastTurnAtMs ? Math.max(0, Date.now() - lastTurnAtMs) : 0;
    const withinMergeWindow =
      this.config.algorithm.session.mergeMaxGapMs === 0 ||
      gapMs <= this.config.algorithm.session.mergeMaxGapMs;
    const shouldAppendOpen =
      mergeMode &&
      withinMergeWindow &&
      (decision.relation === "revision" ||
        decision.relation === "follow_up" ||
        decision.relation === "unknown");
    if (latest.status === "open") {
      if (shouldAppendOpen) {
        if (decision.relation === "revision") {
          this.recordRevisionFeedback(session, latest, userText, source);
        }
        return this.repos.runtime.updateEpisodeMeta(latest.id, {
          relation: decision.relation,
          relationDecision: decision,
          relationRouting: {
            action: "append_to_open_episode",
            mergeMode,
            withinMergeWindow,
            gapMs
          }
        }) ?? latest;
      }
      if (decision.relation === "new_task" || !shouldAppendOpen) {
        this.recordImplicitTurnFeedback(session, latest, userText);
        const at = nowIso();
        const closed = this.repos.runtime.closeEpisode(latest.id, {
          closeReason: "topic_boundary",
          relation: decision.relation,
          relationDecision: decision,
          relationRouting: {
            action: decision.relation === "new_task"
              ? "close_open_and_start_new_task"
              : "close_open_and_start_new_episode",
            mergeMode,
            withinMergeWindow,
            gapMs
          },
          closedBy: source
        }, at);
        if (closed) {
          this.repos.runtime.appendChange({
            memoryId: closed.id,
            namespaceId: namespaceIdFromSession(session),
            kind: "episode",
            op: "updated",
            entityId: closed.id,
            userId: closed.userId,
            changeType: "episode_closed",
            before: latest,
            after: closed,
            source,
            createdAt: at
          });
          this.finalizeClosedEpisode(closed, at, "topic_boundary");
        }
        const next = this.ensureEpisode(session);
        return this.repos.runtime.updateEpisodeMeta(next.id, {
          relation: decision.relation,
          relationDecision: decision,
          previousEpisodeId: latest.id,
          relationRouting: {
            action: decision.relation === "new_task"
              ? "start_new_task_episode"
              : "start_new_episode",
            mergeMode,
            withinMergeWindow,
            gapMs
          }
        }, at) ?? next;
      }
      return this.repos.runtime.updateEpisodeMeta(latest.id, {
        relation: decision.relation,
        relationDecision: decision
      }) ?? latest;
    }

    const shouldReopenClosed =
      decision.relation === "revision" ||
      (mergeMode &&
        withinMergeWindow &&
        (decision.relation === "follow_up" || decision.relation === "unknown"));
    if (shouldReopenClosed) {
      const at = nowIso();
      const reopened = this.repos.runtime.reopenEpisode(latest.id, {
        relation: decision.relation,
        relationDecision: decision,
        reopenedAt: at,
        reopenReason: decision.relation === "revision" ? "revision" : "follow_up",
        relationRouting: {
          action: "reopen_previous_episode",
          mergeMode,
          withinMergeWindow,
          gapMs
        },
        rewardDirty: {
          reason: "episode_reopened",
          reopenedFor: decision.relation,
          at
        }
      }, at);
      if (reopened) {
        this.repos.runtime.appendChange({
          memoryId: reopened.id,
          namespaceId: namespaceIdFromSession(session),
          kind: "episode",
          op: "updated",
          entityId: reopened.id,
          userId: reopened.userId,
          changeType: "episode_reopened",
          before: latest,
          after: reopened,
          source,
          createdAt: at
        });
        if (decision.relation === "revision") {
          this.recordRevisionFeedback(session, reopened, userText, source);
        }
        return reopened;
      }
    }

    this.recordImplicitTurnFeedback(session, latest, userText);
    this.finalizeClosedEpisode(latest, nowIso(), "topic_boundary");
    const next = this.ensureEpisode(session);
    return this.repos.runtime.updateEpisodeMeta(next.id, {
      relation: decision.relation,
      relationDecision: decision,
      previousEpisodeId: latest.id,
      relationRouting: {
        action: decision.relation === "new_task" ? "start_new_task_episode" : "start_new_episode",
        mergeMode,
        withinMergeWindow,
        gapMs
      }
    }) ?? next;
  }

  private episodeRelationContext(episode: EpisodeRecord): {
    prevUserText: string;
    prevAssistantText: string;
    lastTurnAtMs?: number;
    tags: string[];
  } {
    const rawTurns = episode.rawTurnIds
      .map((id) => this.repos.runtime.getRawTurn(id))
      .filter((rawTurn): rawTurn is RawTurnRecord => Boolean(rawTurn))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const userTurns = rawTurns
      .map((rawTurn) => rawTurn.userText?.trim())
      .filter((text): text is string => Boolean(text));
    const assistantTurns = rawTurns
      .map((rawTurn) => rawTurn.assistantText?.trim())
      .filter((text): text is string => Boolean(text));
    const firstUser = userTurns[0] ?? "";
    const lastUser = userTurns[userTurns.length - 1] ?? "";
    const lastAssistant = assistantTurns[assistantTurns.length - 1] ?? "";
    const prevUserText = firstUser && lastUser && firstUser !== lastUser
      ? [
          `[Task topic]: ${firstUser.slice(0, 300)}`,
          `[Latest user message]: ${lastUser.slice(0, 700)}`
        ].join("\n\n")
      : (lastUser || firstUser).slice(0, 1000);
    const tags = uniq(
      episode.l1MemoryIds.flatMap((id) => this.repos.memories.get(id)?.tags ?? [])
    );
    const lastTurnAtMs = rawTurns.length > 0
      ? Date.parse(rawTurns[rawTurns.length - 1]!.createdAt)
      : undefined;
    return {
      prevUserText,
      prevAssistantText: lastAssistant.slice(0, 2000),
      lastTurnAtMs: Number.isFinite(lastTurnAtMs) ? lastTurnAtMs : undefined,
      tags
    };
  }

  private recordImplicitTurnFeedback(
    session: SessionRecord,
    episode: EpisodeRecord,
    userText: string
  ): void {
    const target = this.feedbackTargetFromEpisode(episode);
    if (!target) return;
    const rawTurnId = rawTurnIdFromMemory(target);
    const rawTurn = rawTurnId ? this.repos.runtime.getRawTurn(rawTurnId) : undefined;
    const trace = this.traceMeta(target);
    const classification = classifyTurnFeedback({
      userText,
      agentText: rawTurn?.assistantText ?? trace?.agentText
    });
    if (!classification.isFeedback || classification.confidence < 0.6) return;
    const polarity = polarityFromTurnFeedback(classification);
    if (polarity === "neutral" && classification.magnitude <= 0) return;

    const contextHash = stableHash({
      source: "turn.feedback_classifier",
      sessionId: session.id,
      episodeId: episode.id,
      l1MemoryId: target.id,
      userText,
      polarity,
      method: classification.method
    }).slice(0, 32);
    const duplicate = this.repos.runtime.listFeedback({
      userId: session.userId,
      sessionId: session.id,
      episodeId: episode.id,
      l1MemoryId: target.id,
      limit: 20
    }).some((feedback) => feedback.contextHash === contextHash);
    if (duplicate) return;

    const at = nowIso();
    const rawPayload = {
      source: "turn_feedback_classifier",
      method: classification.method,
      confidence: classification.confidence,
      classifierPolarity: classification.polarity
    };
    const feedbackRequest: FeedbackRequest = {
      sessionId: session.id,
      episodeId: episode.id,
      l1MemoryId: target.id,
      rawTurnId,
      channel: "implicit",
      polarity,
      magnitude: classification.magnitude,
      rationale: classification.rationale,
      rawPayload,
      namespace: namespaceForSession(session)
    };
    const feedback = this.repos.runtime.insertFeedback({
      id: newId("feedback"),
      userId: session.userId,
      projectId: session.projectId,
      conversationId: session.conversationId,
      sessionId: session.id,
      episodeId: episode.id,
      l1MemoryId: target.id,
      rawTurnId,
      channel: "implicit",
      polarity,
      magnitude: classification.magnitude,
      rationale: classification.rationale,
      rawPayload,
      contextHash,
      createdAt: at
    });
    this.repos.runtime.appendEpisodeFeedback(episode.id, feedback.id, at);
    this.maybeCreateDecisionRepair(feedbackRequest, feedback, contextHash, namespaceIdFromSession(session));
    this.enqueueJob({
      jobType: "reward",
      userId: session.userId,
      sessionId: session.id,
      episodeId: episode.id,
      payload: {
        feedbackId: feedback.id,
        l1MemoryId: target.id,
        channel: feedback.channel,
        polarity: feedback.polarity,
        magnitude: feedback.magnitude,
        rationale: feedback.rationale,
        trigger: "implicit_turn_feedback"
      },
      createdAt: at
    });
    for (const trial of this.pendingTrialsForFeedback(feedback)) {
      this.enqueueJob({
        jobType: "skill_trial_resolve",
        userId: session.userId,
        sessionId: trial.sessionId,
        episodeId: trial.episodeId,
        payload: {
          trialId: trial.id,
          feedbackId: feedback.id,
          targetKind: "skill_trial",
          trigger: "implicit_turn_feedback"
        },
        createdAt: at
      });
    }
    this.repos.runtime.appendChange({
      memoryId: target.id,
      namespaceId: namespaceIdFromSession(session),
      kind: "feedback",
      op: "created",
      entityId: feedback.id,
      userId: session.userId,
      changeType: "feedback",
      after: feedback,
      source: "turn.feedback_classifier",
      createdAt: at
    });
  }

  private recordRevisionFeedback(
    session: SessionRecord,
    episode: EpisodeRecord,
    userText: string,
    source: string
  ): void {
    const target = this.feedbackTargetFromEpisode(episode);
    if (!target) return;
    const contextHash = stableHash({
      source: "relation.revision",
      sessionId: session.id,
      episodeId: episode.id,
      l1MemoryId: target.id,
      userText
    }).slice(0, 32);
    const duplicate = this.repos.runtime.listFeedback({
      userId: session.userId,
      sessionId: session.id,
      episodeId: episode.id,
      l1MemoryId: target.id,
      limit: 20
    }).some((feedback) => feedback.contextHash === contextHash);
    if (duplicate) return;

    const at = nowIso();
    const rawTurnId = rawTurnIdFromMemory(target);
    const rawPayload = {
      source: "relation_classifier",
      relation: "revision"
    };
    const feedbackRequest: FeedbackRequest = {
      sessionId: session.id,
      episodeId: episode.id,
      l1MemoryId: target.id,
      rawTurnId,
      channel: "explicit",
      polarity: "negative",
      magnitude: 1,
      rationale: userText,
      rawPayload,
      namespace: namespaceForSession(session)
    };
    const feedback = this.repos.runtime.insertFeedback({
      id: newId("feedback"),
      userId: session.userId,
      projectId: session.projectId,
      conversationId: session.conversationId,
      sessionId: session.id,
      episodeId: episode.id,
      l1MemoryId: target.id,
      rawTurnId,
      channel: "explicit",
      polarity: "negative",
      magnitude: 1,
      rationale: userText,
      rawPayload,
      contextHash,
      createdAt: at
    });
    this.repos.runtime.appendEpisodeFeedback(episode.id, feedback.id, at);
    this.maybeCreateDecisionRepair(feedbackRequest, feedback, contextHash, namespaceIdFromSession(session));
    this.enqueueJob({
      jobType: "reward",
      userId: session.userId,
      sessionId: session.id,
      episodeId: episode.id,
      payload: {
        feedbackId: feedback.id,
        l1MemoryId: target.id,
        channel: feedback.channel,
        polarity: feedback.polarity,
        magnitude: feedback.magnitude,
        rationale: feedback.rationale,
        trigger: "revision_feedback"
      },
      createdAt: at
    });
    for (const trial of this.pendingTrialsForFeedback(feedback)) {
      this.enqueueJob({
        jobType: "skill_trial_resolve",
        userId: session.userId,
        sessionId: trial.sessionId,
        episodeId: trial.episodeId,
        payload: {
          trialId: trial.id,
          feedbackId: feedback.id,
          targetKind: "skill_trial",
          trigger: "revision_feedback"
        },
        createdAt: at
      });
    }
    this.repos.runtime.appendChange({
      memoryId: target.id,
      namespaceId: namespaceIdFromSession(session),
      kind: "feedback",
      op: "created",
      entityId: feedback.id,
      userId: session.userId,
      changeType: "feedback",
      after: feedback,
      source,
      createdAt: at
    });
  }

  private ensureEpisode(session: SessionRecord, episodeId?: string): EpisodeRecord {
    if (episodeId) {
      const existing = this.repos.runtime.getEpisode(episodeId);
      if (existing) {
        return existing;
      }
    }

    const latest = episodeId ? undefined : this.repos.runtime.latestEpisodeForSession(session.id);
    if (latest && latest.status === "open") {
      return latest;
    }

    const at = nowIso();
    const episode = this.repos.runtime.createEpisode({
      id: episodeId ?? newId("episode"),
      sessionId: session.id,
      userId: session.userId,
      projectId: session.projectId ?? session.workspaceId,
      conversationId: session.conversationId,
      status: "open",
      l1MemoryIds: [],
      rawTurnIds: [],
      feedbackIds: [],
      decisionRepairIds: [],
      l2PolicyIds: [],
      l3WorldModelIds: [],
      skillMemoryIds: [],
      turnCount: 0,
      rewardDetail: {},
      pipelineStatus: "idle",
      meta: {},
      openedAt: at,
      updatedAt: at
    });
    this.repos.runtime.appendChange({
      memoryId: episode.id,
      namespaceId: namespaceIdFromSession(session),
      kind: "episode",
      op: "created",
      entityId: episode.id,
      userId: episode.userId,
      changeType: "episode_opened",
      after: episode,
      source: "session.episode",
      createdAt: at
    });
    return episode;
  }

  private resolveContext(request: RequestEnvelope & { sessionId?: string; userId?: string }): {
    userId: string;
    conversationId?: string;
    namespace: RuntimeNamespace;
  } {
    if (request.sessionId) {
      const session = this.repos.runtime.getSession(request.sessionId);
      if (session) {
        this.assertSessionInScope(session, request.namespace);
        return {
          userId: session.userId,
          conversationId: session.conversationId,
          namespace: namespaceForSession(session)
        };
      }
    }
    const namespace = normalizeNamespace(request.namespace);
    const userId = request.userId ?? namespace.userId;
    return {
      userId,
      namespace: {
        ...namespace,
        userId
      }
    };
  }
}

function normalizeNamespace(namespace?: RuntimeNamespace): RuntimeNamespace & {
  userId: string;
  source: string;
  profileId: string;
} {
  return {
    source: namespace?.source ?? DEFAULT_NAMESPACE_SOURCE,
    profileId: namespace?.profileId ?? "default",
    profileLabel: namespace?.profileLabel,
    projectId: namespace?.projectId,
    workspaceId: namespace?.workspaceId,
    workspacePath: namespace?.workspacePath,
    sessionKey: namespace?.sessionKey,
    userId: namespace?.userId ?? "local-user",
    tenantId: namespace?.tenantId
  };
}

function sessionScopeForOpenRequest(
  request: SessionOpenRequest,
  namespace: RuntimeNamespace
): Partial<Pick<SessionRecord, "source" | "profileId" | "projectId" | "workspaceId" | "workspacePath">> {
  return {
    source: request.source ?? request.namespace?.source,
    profileId: request.profileId ?? request.namespace?.profileId,
    projectId: request.projectId ?? request.namespace?.projectId ?? request.namespace?.workspaceId,
    workspaceId: request.workspaceId ?? request.namespace?.workspaceId,
    workspacePath: request.workspacePath ?? request.namespace?.workspacePath ?? namespace.workspacePath
  };
}

function namespaceForSession(session: SessionRecord): RuntimeNamespace {
  return {
    source: session.source,
    profileId: session.profileId,
    profileLabel: session.profileLabel,
    projectId: session.projectId,
    workspaceId: session.workspaceId,
    workspacePath: session.workspacePath,
    sessionKey: session.hostSessionKey,
    userId: session.userId
  };
}

function namespaceForMemory(memory: MemoryRow): RuntimeNamespace {
  return {
    source: memory.agentId ?? DEFAULT_NAMESPACE_SOURCE,
    profileId: profileIdFromMemory(memory) ?? "default",
    projectId: projectIdFromMemory(memory),
    workspaceId: memory.appId,
    userId: memory.userId
  };
}

function projectIdFromMemory(memory: MemoryRow): string | undefined {
  const direct = memory.info.project_id;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const camel = memory.info.projectId;
  if (typeof camel === "string" && camel.trim()) return camel.trim();
  const propertiesInfo = memory.properties.info?.project_id ?? memory.properties.info?.projectId;
  if (typeof propertiesInfo === "string" && propertiesInfo.trim()) return propertiesInfo.trim();
  return undefined;
}

function profileIdFromMemory(memory: MemoryRow): string | undefined {
  const direct = memory.info.profile_id;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const propertiesInfo = memory.properties.info?.profile_id;
  if (typeof propertiesInfo === "string" && propertiesInfo.trim()) return propertiesInfo.trim();
  return undefined;
}

function namespaceForRawTurn(rawTurn: RawTurnRecord): RuntimeNamespace {
  return {
    source: DEFAULT_NAMESPACE_SOURCE,
    profileId: "default",
    sessionKey: rawTurn.sessionId,
    userId: rawTurn.userId
  };
}

function withDuplicateFlag(value: unknown): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>), duplicate: true }
    : value;
}

function stringFromMeta(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = meta?.[key];
  return typeof value === "string" ? value : undefined;
}

function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfig);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, next] of Object.entries(value)) {
    if (/token|apiKey|secret|password/i.test(key)) {
      out[key] = typeof next === "string" && next ? "[redacted]" : next;
    } else {
      out[key] = redactConfig(next);
    }
  }
  return out;
}

function objectField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function positiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : undefined;
}

function buildSearchQuery(request: TurnStartRequest, domain?: string): string {
  return buildPluginRetrievalQuery({
    reason: "turn_start",
    userText: request.query,
    contextHints: request.contextHints,
    domain
  }).text;
}

function turnStartContextHints(request: TurnStartRequest): Record<string, unknown> {
  const hints: Record<string, unknown> = {
    ...(isRecord(request.contextHints) ? request.contextHints : {})
  };
  if (!hints.taskKind && isStandaloneMathFinalAnswerTask(request.query)) {
    hints.taskKind = STANDALONE_MATH_FINAL_ANSWER_TASK_KIND;
  }
  return hints;
}

function normalizeRetrievalExtractKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const keyword = String(item ?? "").trim();
    if (!keyword) continue;
    const normalized = keyword.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(keyword);
    if (out.length >= 5) break;
  }
  return out;
}

function buildRepairSuggestionQuery(request: RepairSuggestionRequest): string {
  const error = errorMessageFromUnknown(request.error);
  const pluginRepairQuery =
    request.toolName
      ? buildPluginRetrievalQuery({
          reason: "decision_repair",
          failingTool: request.toolName,
          failureCount: 1,
          lastErrorCode: error
        }).text
      : "";
  return [
    pluginRepairQuery,
    request.issue,
    error,
    request.context
  ]
    .filter(Boolean)
    .join("\n");
}

function sanitizeTurnStartRequest<T extends TurnStartRequest & Record<string, unknown>>(request: T): T {
  return {
    ...request,
    query: sanitizeMemmyProtocolText(String(request.query ?? ""))
  };
}

function sanitizeTurnCompleteRequest<T extends TurnCompleteRequest & Record<string, unknown>>(request: T): T {
  const toolCalls = Array.isArray(request.toolCalls) ? request.toolCalls : [];
  return {
    ...request,
    query: sanitizeMemmyProtocolText(String(request.query ?? "")),
    answer: sanitizeMemmyProtocolText(String(request.answer ?? "")),
    toolCalls: Array.isArray(request.toolCalls)
      ? request.toolCalls.map((call) => sanitizeMemmyProtocolValue(call))
      : request.toolCalls,
    toolResults: Array.isArray(request.toolResults)
      ? request.toolResults.map((result, index) => sanitizeCompleteTurnToolResult(result, toolNameFromToolCall(toolCalls[index])))
      : request.toolResults
  };
}

function sanitizeMemoryAddRequest<T extends MemoryAddRequest>(request: T): T {
  return {
    ...request,
    content: sanitizeMemmyProtocolText(request.content ?? ""),
    title: typeof request.title === "string" ? sanitizeMemmyProtocolText(request.title) : request.title,
  };
}

function sanitizeCompleteTurnToolResult(value: unknown, pairedToolName: string | undefined): unknown {
  const toolName = toolNameFromToolResult(value) ?? pairedToolName;
  if (isMemmyRecallToolName(toolName)) {
    const output: Record<string, unknown> = {
      name: toolName,
      output: memmyRecallToolPlaceholder(toolName)
    };
    if (isRecord(value)) {
      const toolCallId = stringFromRecord(value, "toolCallId")
        ?? stringFromRecord(value, "tool_call_id")
        ?? stringFromRecord(value, "id");
      if (toolCallId) output.toolCallId = toolCallId;
    }
    return output;
  }
  return sanitizeMemmyProtocolValue(value);
}

function toolNameFromToolCall(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const fn = isRecord(value.function) ? value.function : {};
  return stringFromRecord(value, "name")
    ?? stringFromRecord(value, "toolName")
    ?? stringFromRecord(fn, "name");
}

function toolNameFromToolResult(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return stringFromRecord(value, "name")
    ?? stringFromRecord(value, "toolName")
    ?? stringFromRecord(value, "tool_name");
}

function completeObservedRawTurn(
  existing: RawTurnRecord,
  request: TurnCompleteRequest & Record<string, unknown>,
  completedAt: string
): RawTurnRecord {
  const toolCalls = normalizeCompleteTurnToolCalls(request);
  const toolResults = normalizeCompleteTurnToolResults(request);

  return {
    ...existing,
    userText: request.query ?? existing.userText,
    assistantText: request.answer,
    reasoningSummary: stringFromMaybeRecord(request, "reasoningSummary") ?? existing.reasoningSummary,
    toolCalls: toolCalls.length > 0 ? toolCalls : existing.toolCalls,
    toolResults: toolResults.length > 0 ? toolResults : existing.toolResults,
    sourceMemoryIds: normalizeCompleteTurnSourceMemoryIds(request, existing.sourceMemoryIds),
    usage: isRecord(request.usage) ? request.usage : existing.usage,
    messagePayload: {
      ...(existing.messagePayload ?? {}),
      turn_complete: {
        completed_at: completedAt,
        source_memory_ids: normalizeCompleteTurnSourceMemoryIds(request, existing.sourceMemoryIds)
      }
    },
    status: request.status ?? "succeeded"
  };
}

function normalizeCompleteTurnSourceMemoryIds(
  request: TurnCompleteRequest & Record<string, unknown>,
  fallback: string[] = []
): string[] {
  return Array.isArray(request.sourceMemoryIds)
    ? request.sourceMemoryIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : fallback;
}

interface NormalizedCompleteTurnArtifact {
  kind: string;
  uri?: string;
  payload: Record<string, unknown>;
}

function normalizeCompleteTurnArtifacts(request: TurnCompleteRequest): NormalizedCompleteTurnArtifact[] {
  if (!Array.isArray(request.artifacts)) return [];
  return request.artifacts
    .map((artifact) => {
      if (!isRecord(artifact)) return null;
      const kind = stringFromRecord(artifact, "kind") ?? "artifact";
      const uri = stringFromRecord(artifact, "uri");
      const normalized: NormalizedCompleteTurnArtifact = {
        kind,
        payload: artifact
      };
      if (uri) normalized.uri = uri;
      return normalized;
    })
    .filter((artifact): artifact is NormalizedCompleteTurnArtifact => Boolean(artifact));
}

function normalizeCompleteTurnToolCalls(request: TurnCompleteRequest): ToolCallPayload[] {
  const results = normalizeCompleteTurnToolResults(request);
  return (Array.isArray(request.toolCalls) ? request.toolCalls : [])
    .map((call, index) => normalizeCompleteTurnToolCall(call, results[index]))
    .filter((call): call is ToolCallPayload => Boolean(call));
}

function normalizeCompleteTurnToolResults(request: TurnCompleteRequest): unknown[] {
  return Array.isArray(request.toolResults) ? request.toolResults : [];
}

function normalizeCompleteTurnToolCall(value: unknown, pairedResult: unknown): ToolCallPayload | null {
  if (!isRecord(value)) return null;
  const fn = isRecord(value.function) ? value.function : {};
  const name = stringFromRecord(value, "name") ?? stringFromRecord(fn, "name");
  if (!name) return null;

  const resultRecord = isRecord(pairedResult) ? pairedResult : {};
  const error = errorMessageFromUnknown(value.error)
    ?? errorMessageFromUnknown(resultRecord.error)
    ?? errorMessageFromUnknown(resultRecord.message);
  const output = firstDefined(value.output, value.result, resultRecord.output, resultRecord.result, resultRecord.content, pairedResult);

  return {
    id: stringFromRecord(value, "id") ?? stringFromRecord(value, "call_id") ?? stringFromRecord(value, "tool_call_id"),
    name,
    input: firstDefined(value.input, value.args, value.arguments, fn.arguments),
    output,
    error,
    success: typeof value.success === "boolean" ? value.success : error ? false : undefined,
    startedAt: timeFromRecord(value, "startedAt") ?? timeFromRecord(value, "started_at"),
    endedAt: timeFromRecord(value, "endedAt") ?? timeFromRecord(value, "ended_at"),
    thinkingBefore: stringFromRecord(value, "thinkingBefore") ?? stringFromRecord(value, "thinking_before"),
    assistantTextBefore: stringFromRecord(value, "assistantTextBefore") ?? stringFromRecord(value, "assistant_text_before")
  };
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function timeFromRecord(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function rawTurnIdForSessionTurn(sessionId: string, turnId: string): string {
  return `raw_${stableHash(`${sessionId}:${turnId}`).slice(0, 20)}`;
}

function memoryAddKey(request: MemoryAddRequest, layer: MemoryLayer, title: string): string {
  if (isAgentSourceImportMemoryAdd(request) && request.adapterId && request.turnId) {
    return `memory.add:${request.adapterId}:turn:${request.turnId}`;
  }
  if (request.adapterId && request.requestId) {
    return `memory.add:${request.adapterId}:${request.requestId}`;
  }
  return `manual:${stableHash(`${layer}:${title}:${request.content}`).slice(0, 20)}`;
}

function memoryAddTags(request: MemoryAddRequest, importTrace: boolean, traceTags: string[] = []): string[] {
  if (importTrace) {
    return uniq([
      ...(request.tags ?? []),
      ...(request.source ? [request.source] : []),
      ...traceTags
    ]);
  }
  return uniq([
    "manual",
    ...(request.source ? [request.source] : []),
    ...(request.tags ?? [])
  ]);
}

function isAgentSourceImportMemoryAdd(request: MemoryAddRequest): boolean {
  return request.adapterId?.startsWith("agent-source:") === true ||
    request.tags?.some((tag) => tag.trim().toLowerCase() === "agent-source") === true;
}

function normalizeMemoryAddCreatedAt(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new MemoryServiceError("invalid_argument", "memory.add createdAt must be an ISO timestamp");
  }

  return date.toISOString();
}

function memoryAddImportTrace(request: MemoryAddRequest, at: string): Record<string, unknown> {
  const sections = parseMemoryAddSections(request.content);
  const toolCalls = toolCallsFromImportSections(sections, {
    parseJsonPayload: !isCodexAgentSourceImport(request)
  });
  const userText = sections.length
    ? sections
        .filter((section) => section.role === "user" || section.role === "system")
        .map((section) => section.role === "system" ? `[system]\n${section.text}` : section.text)
        .join("\n\n")
    : request.content;
  const agentText = sections.length
    ? sections
        .filter((section) => section.role === "assistant")
        .map((section) => section.text)
        .join("\n\n")
    : "";
  const turnId = request.turnId ?? `import:${stableHash(request.content).slice(0, 16)}`;
  const tags = captureImportTraceTags({
    at,
    turnId,
    sessionId: request.sessionId ?? request.adapterId ?? "memory.add",
    userText,
    agentText,
    toolCalls
  });

  return {
    key: `memory.add:${stableHash(`${request.source ?? "manual"}:${turnId}:${request.content}`).slice(0, 20)}`,
    ts: Date.parse(at),
    turn_id: turnId,
    step_index: 0,
    sub_step_total: 1,
    user_text: userText,
    agent_text: agentText,
    userText,
    agentText,
    raw_span: {
      user_text: Boolean(userText),
      agent_text: Boolean(agentText),
      tool_call_count: toolCalls.length
    },
    tool_calls: toolCalls,
    reflection: null,
    alpha: IMPORT_DEFAULT_ALPHA,
    usable: false,
    reflection_source: "none",
    summary: IMPORT_SUMMARY_QUEUED_TAG,
    tags,
    value: IMPORT_DEFAULT_VALUE,
    priority: IMPORT_DEFAULT_PRIORITY,
    signature: signatureFromTraceParts(tags, toolCalls, ""),
    error_signatures: []
  };
}

function captureImportTraceTags(input: {
  at: string;
  turnId: string;
  sessionId: string;
  userText: string;
  agentText: string;
  toolCalls: ToolCallPayload[];
}): string[] {
  return captureTurnSteps({
    episodeId: `import:${input.turnId}`,
    sessionId: input.sessionId,
    turnId: input.turnId,
    userText: input.userText,
    assistantText: input.agentText,
    toolCalls: input.toolCalls,
    createdAtIso: input.at
  })[0]?.tags ?? [];
}

function titleFromImportTrace(trace: Record<string, unknown>): string | undefined {
  const userText = stringFromRecord(trace, "user_text");
  const title = userText ? firstLine(userText) : "";
  return title ? clip(title, 120) : undefined;
}

function parseMemoryAddSections(content: string): Array<{ role: "user" | "assistant" | "tool" | "system"; text: string }> {
  const headingPattern = /^## (user|assistant|tool|system)\s*$/gm;
  const headings = [...content.matchAll(headingPattern)];
  return headings
    .map((heading, index) => {
      const nextHeading = headings[index + 1];
      const start = (heading.index ?? 0) + heading[0].length;
      const end = nextHeading?.index ?? content.length;
      return {
        role: heading[1] as "user" | "assistant" | "tool" | "system",
        text: content.slice(start, end).trim()
      };
    })
    .filter((section) => section.text.length > 0);
}

type MemoryAddSection = ReturnType<typeof parseMemoryAddSections>[number];

function toolCallsFromImportSections(
  sections: readonly MemoryAddSection[],
  options: { parseJsonPayload: boolean } = { parseJsonPayload: true }
): ToolCallPayload[] {
  const calls: ToolCallPayload[] = [];
  const indexByCallId = new Map<string, number>();

  for (const [index, section] of sections.filter((item) => item.role === "tool").entries()) {
    const parsed = parseImportedToolSection(section.text, index, options);
    const existingIndex = parsed.id ? indexByCallId.get(parsed.id) : undefined;
    if (existingIndex !== undefined) {
      calls[existingIndex] = mergeImportedToolCall(calls[existingIndex]!, parsed);
      continue;
    }

    if (parsed.id) {
      indexByCallId.set(parsed.id, calls.length);
    }
    calls.push(parsed);
  }

  return calls;
}

function parseImportedToolSection(
  text: string,
  index: number,
  options: { parseJsonPayload: boolean }
): ToolCallPayload {
  const fields = parseToolSectionFields(text, options);
  const fallbackOutput = fields.input === undefined && fields.output === undefined
    ? limitImportedToolPayload(stripToolHeaderLines(text).trim())
    : "";
  return {
    id: fields.callId,
    name: fields.name || `tool_${index + 1}`,
    input: fields.input,
    output: fields.output ?? (fallbackOutput.length > 0 ? fallbackOutput : undefined),
    error: fields.error,
    success: fields.error ? false : undefined
  };
}

function parseToolSectionFields(
  text: string,
  options: { parseJsonPayload: boolean }
): {
  name?: string;
  callId?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
} {
  return {
    name: firstToolLineValue(text, "Tool"),
    callId: firstToolLineValue(text, "Call ID"),
    input: toolBlockValue(text, "Input", options),
    output: toolBlockValue(text, "Output", options),
    error: firstToolLineValue(text, "Error")
  };
}

function firstToolLineValue(text: string, label: string): string | undefined {
  const match = text.match(new RegExp(`^${escapeToolLabelRegExp(label)}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() || undefined;
}

function toolBlockValue(
  text: string,
  label: string,
  options: { parseJsonPayload: boolean }
): unknown {
  const lines = text.split(/\r?\n/);
  const labelPattern = new RegExp(`^${escapeToolLabelRegExp(label)}:[\\t ]*$`, "i");
  const start = lines.findIndex((line) => labelPattern.test(line));
  if (start < 0) {
    return undefined;
  }

  const nextFieldOffset = lines.slice(start + 1).findIndex((line, offset) =>
    lines[start + offset]?.trim() === "" &&
    /^(?:Tool|Call ID|Status|Input|Output|Error):(?:[\t ]*$|[\t ]+.*$)/i.test(line)
  );
  const end = nextFieldOffset < 0 ? lines.length : start + 1 + nextFieldOffset;
  const value = limitImportedToolPayload(lines.slice(start + 1, end).join("\n").trim());
  if (!value) {
    return undefined;
  }

  if (!options.parseJsonPayload) {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stripToolHeaderLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^(Tool|Call ID|Status|Error):\s*/i.test(line.trim()))
    .join("\n");
}

function mergeImportedToolCall(left: ToolCallPayload, right: ToolCallPayload): ToolCallPayload {
  return {
    ...left,
    name: left.name || right.name,
    input: left.input ?? right.input,
    output: left.output ?? right.output,
    error: left.error ?? right.error,
    success: left.success ?? right.success
  };
}

function isCodexAgentSourceImport(request: MemoryAddRequest): boolean {
  const source = request.source?.trim().toLowerCase();
  const adapterId = request.adapterId?.trim().toLowerCase();
  return source === "codex" || adapterId === "agent-source:codex";
}

function limitImportedToolPayload(value: string): string {
  if (value.length <= IMPORT_TOOL_PAYLOAD_MAX_CHARS) {
    return value;
  }

  return `${value.slice(0, IMPORT_TOOL_PAYLOAD_MAX_CHARS)}\n[truncated:${value.length - IMPORT_TOOL_PAYLOAD_MAX_CHARS} chars]`;
}

function toolCallsFromUnknown(value: unknown): ToolCallPayload[] {
  return Array.isArray(value) ? value.filter(isToolCallPayload) : [];
}

function escapeToolLabelRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function closedEpisodeIdsFromBoundary(
  before: EpisodeRecord | undefined,
  selected: EpisodeRecord,
  after: EpisodeRecord | undefined
): string[] {
  if (!before || before.id === selected.id || before.status !== "open" || after?.status !== "closed") {
    return [];
  }
  return [before.id];
}

function mergeUnknownList<T>(existing: T[], incoming: T[]): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const item of [...existing, ...incoming]) {
    const key = stableHash(stableStringify(item));
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function memoryLayersForIntent(kind: Parameters<typeof retrievalForIntent>[0]): MemoryLayer[] {
  const plan = retrievalForIntent(kind);
  const layers: MemoryLayer[] = [];
  if (plan.tier1) layers.push("Skill");
  if (plan.tier2) layers.push("L2", "L1");
  if (plan.tier3) layers.push("L3");
  return layers;
}

function workerJobCanRunInParallel(job: EvolutionJobRecord): boolean {
  return job.jobType === "trace_summary" || job.jobType === "import_summary" || job.jobType === "embedding";
}

function processingStageForJob(jobType: JobType): "summary" | "embedding" | undefined {
  if (jobType === "trace_summary" || jobType === "import_summary") return "summary";
  if (jobType === "embedding") return "embedding";
  return undefined;
}

function processingJobMatchesMemory(job: EvolutionJobRecord, memory: MemoryRow): boolean {
  const contentHash = typeof job.payload.contentHash === "string" ? job.payload.contentHash : undefined;
  return !contentHash || contentHash === memory.contentHash;
}

function sanitizeProcessingError(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\b(api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .trim();
  return clip(message || "Unknown processing error", 1000);
}

function workerJobLogFields(job: EvolutionJobRecord): Record<string, unknown> {
  return {
    jobId: job.id,
    jobType: job.jobType,
    status: job.status,
    attempt: job.attempts,
    maxAttempts: job.maxAttempts,
    sessionId: job.sessionId,
    episodeId: job.episodeId,
    targetMemoryId: job.targetMemoryId
  };
}

function memoryConfigLogFields(config: MemmyConfig): Record<string, unknown> {
  const evolution = resolveEvolutionConfig(config);
  return {
    activeProfile: config.activeProfile,
    memoryAddEnabled: config.algorithm.enableMemoryAdd,
    memorySearchEnabled: config.algorithm.enableMemorySearch,
    summaryModel: {
      provider: config.summary.provider,
      vendor: config.summary.vendor,
      model: config.summary.model,
      maxTokens: config.summary.maxTokens,
      timeoutMs: config.summary.timeoutMs,
      maxRetries: config.summary.maxRetries,
      malformedRetries: config.summary.malformedRetries
    },
    evolutionModel: {
      provider: evolution.provider,
      vendor: evolution.vendor,
      model: evolution.model,
      maxTokens: evolution.maxTokens,
      timeoutMs: evolution.timeoutMs,
      maxRetries: evolution.maxRetries,
      malformedRetries: evolution.malformedRetries
    },
    embeddingModel: {
      provider: config.embedding.provider,
      model: config.embedding.model,
      timeoutMs: config.embedding.timeoutMs,
      maxRetries: config.embedding.maxRetries
    },
    evolutionGates: {
      l2UseLlm: config.algorithm.l2Induction.useLlm,
      l2MinEpisodes: config.algorithm.l2Induction.minEpisodesForInduction,
      l2MinGain: config.algorithm.l2Induction.minGain,
      l3UseLlm: config.algorithm.l3Abstraction.useLlm,
      l3MinPolicies: config.algorithm.l3Abstraction.minPolicies,
      l3MinPolicyGain: config.algorithm.l3Abstraction.minPolicyGain,
      l3MinPolicySupport: config.algorithm.l3Abstraction.minPolicySupport,
      l3ClusterMinSimilarity: config.algorithm.l3Abstraction.clusterMinSimilarity,
      skillUseLlm: config.algorithm.skill.useLlm,
      skillMinSupport: config.algorithm.skill.minSupport,
      skillMinGain: config.algorithm.skill.minGain
    }
  };
}

function embeddingRetryLogFields(retry: EmbeddingRetryRecord): Record<string, unknown> {
  return {
    retryId: retry.id,
    targetKind: retry.targetKind,
    targetMemoryId: retry.targetId,
    vectorField: retry.vectorField,
    role: retry.embedRole,
    status: retry.status,
    attempt: retry.attempts,
    maxAttempts: retry.maxAttempts,
    nextAttemptAt: retry.nextAttemptAt
  };
}

function logEvolutionDecision(
  job: EvolutionJobRecord,
  stage: "l2_induction" | "l3_abstraction" | "skill_crystallization",
  reason: string,
  fields: Record<string, unknown> = {}
): void {
  const context = {
    ...workerJobLogFields(job),
    stage,
    reason,
    ...fields
  };
  if (/llm-failed|llm-refusal|invalid|verification_failed|malformed|truncat/i.test(reason)) {
    evolutionLogger.warn("generation.skipped", context);
  } else {
    evolutionLogger.info("gate.skipped", context);
  }
}

function classifyProcessingError(message: string): {
  code: string;
  retryAction: "retry" | "open_settings" | "none";
} {
  const normalized = message.toLowerCase();
  if (/api.?key|unauthorized|forbidden|\b401\b|\b403\b|\b404\b|model.+not configured|missing.+model|expected json|html instead of json|configured model endpoint/.test(normalized)) {
    return { code: "model_configuration", retryAction: "open_settings" };
  }
  if (/trace payload is missing|memory content is missing|corrupt|malformed memory/.test(normalized)) {
    return { code: "memory_corrupt", retryAction: "none" };
  }
  if (/timeout|timed out|network|connect|temporar|rate.?limit|\b429\b|\b5\d\d\b/.test(normalized)) {
    return { code: "transient_provider_error", retryAction: "retry" };
  }
  if (/vector|embedding|dimension|finite values/.test(normalized)) {
    return { code: "embedding_failed", retryAction: "retry" };
  }
  return { code: "processing_failed", retryAction: "retry" };
}

function evolutionJobDedupeKey(input: {
  jobType: JobType;
  episodeId?: string;
  targetMemoryId?: string;
  payload?: Record<string, unknown>;
}): string | undefined {
  const payload = input.payload ?? {};
  const payloadString = (key: string): string | undefined => {
    const value = payload[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const payloadStringArray = (key: string): string[] => {
    const value = payload[key];
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
  };
  const target = input.targetMemoryId;
  switch (input.jobType) {
    case "episode_idle_close":
      return input.episodeId
        ? `episode_idle_close:${input.episodeId}:${payloadString("triggerRawTurnId") ?? "turn"}`
        : undefined;
    case "embedding":
      return target ? `embedding:${target}:${payloadString("contentHash") ?? "current"}` : undefined;
    case "trace_summary":
      return target ? `trace_summary:${target}:${payloadString("contentHash") ?? "current"}` : undefined;
    case "import_summary":
      return target ? `import_summary:${target}:${payloadString("contentHash") ?? "current"}` : undefined;
    case "reflection":
      return input.episodeId ? `reflection:${input.episodeId}` : target ? `reflection:${target}` : undefined;
    case "reward":
      return input.episodeId ? `reward:${input.episodeId}` : target ? `reward:${target}` : undefined;
    case "l2_association":
      return target ? `l2_association:${target}` : undefined;
    case "l2_induction": {
      const seed = target ?? payloadString("sourceMemoryId") ?? payloadString("seedMemoryId");
      return seed
        ? `l2_induction:${seed}`
        : input.episodeId
          ? `l2_induction:${input.episodeId}`
          : undefined;
    }
    case "l3_abstraction": {
      const signature = payloadString("signature");
      const seed = payloadString("seedPolicyId") ?? target;
      const policyIds = payloadStringArray("policyIds").sort();
      const basis = signature ?? seed ?? (policyIds.length ? stableHash(policyIds).slice(0, 24) : undefined);
      return basis ? `l3_abstraction:${basis}` : input.episodeId ? `l3_abstraction:${input.episodeId}` : undefined;
    }
    case "skill_crystallization": {
      const seed = target ?? payloadString("policyId") ?? payloadString("skillId");
      return seed ? `skill_crystallization:${seed}` : input.episodeId ? `skill_crystallization:${input.episodeId}` : undefined;
    }
    case "skill_trial_resolve": {
      const trial = payloadString("trialId") ?? target;
      return trial ? `skill_trial_resolve:${trial}` : input.episodeId ? `skill_trial_resolve:${input.episodeId}` : undefined;
    }
  }
}

function kindForLayer(layer: MemoryLayer): MemoryKind {
  if (layer === "L2") return "policy";
  if (layer === "L3") return "world_model";
  if (layer === "Skill") return "skill";
  return "trace";
}

function memoryIdPrefix(layer: MemoryLayer, kind: MemoryKind): string {
  if (layer === "L1" || kind === "trace") return "trace";
  if (layer === "L2" || kind === "policy") return "policy";
  if (layer === "L3" || kind === "world_model") return "world";
  return "skill";
}

type ReadableMemoryIdKind = "trace" | "policy" | "world" | "skill" | "episode" | "raw" | "unknown";

function readableMemoryIdKind(id: string): ReadableMemoryIdKind {
  if (id.startsWith("trace_")) return "trace";
  if (id.startsWith("policy_")) return "policy";
  if (id.startsWith("world_")) return "world";
  if (id.startsWith("skill_")) return "skill";
  if (id.startsWith("episode_")) return "episode";
  if (id.startsWith("raw_")) return "raw";
  return "unknown";
}

function describeRetrievalFilterCandidate(hit: RecallHit, bodyChars: number): string {
  const body = clip(hit.snippet, bodyChars);
  const title = clip(hit.title ?? hit.id, 120);
  switch (hit.memoryLayer) {
    case "Skill":
      return `[SKILL] ${title}${body ? `\n   ${body}` : ""}`;
    case "L1":
      return `[TRACE] ${body || title}`;
    case "L2":
      return `[EXPERIENCE] ${title}${body ? `\n   ${body}` : ""}`;
    case "L3":
      return `[WORLD-MODEL] ${title}${body ? `\n   ${body}` : ""}`;
  }
}

function summarizeTurn(rawTurn: RawTurnRecord): string {
  const parts = [
    `Turn: ${rawTurn.turnId}`,
    rawTurn.userText ? `User: ${clip(rawTurn.userText, 1200)}` : undefined,
    rawTurn.assistantText ? `Assistant: ${clip(rawTurn.assistantText, 1600)}` : undefined,
    rawTurn.reasoningSummary ? `Reasoning summary: ${clip(rawTurn.reasoningSummary, 800)}` : undefined,
    rawTurn.toolCalls.length
      ? `Tool calls: ${rawTurn.toolCalls.map((call) => objectField(call, "name") ?? "tool").join(", ")}`
      : undefined,
    rawTurn.toolResults.length ? `Tool results: ${rawTurn.toolResults.length}` : undefined
  ].filter(Boolean);
  return parts.join("\n");
}

function buildRewardTaskSummary(input: {
  source: MemoryRow;
  trace: TraceMeta;
  episode?: EpisodeRecord;
  rawTurns: readonly RawTurnRecord[];
  episodeTraces: readonly TraceMeta[];
  maxChars: number;
  evaluator?: {
    scorerProvider?: string;
    scorerModel?: string;
  };
}): string {
  const pairs = input.rawTurns.length
    ? input.rawTurns.map(rewardPairFromRawTurn).filter((pair): pair is RewardExchangePair => Boolean(pair))
    : input.episodeTraces.map(rewardPairFromTrace).filter((pair): pair is RewardExchangePair => Boolean(pair));
  const userQuery = pairs[0]?.userText || input.trace.userText || "(no user text)";
  const outcome = pairs[pairs.length - 1]?.agentText || input.trace.agentText || "(no agent text)";
  const hostContext = rewardHostAgentContext(input);
  const pairText = pairs.length
    ? pairs.map((pair, index) => rewardFormatPair(pair, index, index === pairs.length - 1)).join("\n\n")
    : "(no recorded exchanges)";
  const agentActions = input.episodeTraces
    .map((trace, index) => rewardTraceOneLiner(trace, index))
    .filter(Boolean)
    .join("\n");
  const mission = rewardEpisodeMission(input.episode, userQuery);
  const body = [
    hostContext ? "HOST_AGENT_CONTEXT:" : "",
    hostContext,
    hostContext ? "" : "",
    "EPISODE_MISSION:",
    rewardOneLine(mission, 800),
    "",
    `USER_ASKS_AND_AGENT_REPLIES (${pairs.length}, in order):`,
    pairText,
    "",
    `AGENT_STEPS (${input.episodeTraces.length}):`,
    agentActions || "(no recorded steps)",
    "",
    "MOST_RECENT_USER_ASK:",
    rewardOneLine(pairs[pairs.length - 1]?.userText || userQuery, 500),
    "",
    "MOST_RECENT_AGENT_REPLY:",
    rewardClampAgentText(pairs[pairs.length - 1]?.agentText || outcome),
    "",
    rewardExecutionOutcome(input.episodeTraces)
  ].join("\n");
  return rewardClampHeadTail(body, input.maxChars);
}

function rewardEpisodeMission(episode: EpisodeRecord | undefined, fallback: string): string {
  const meta = episode?.meta ?? {};
  const canonicalGoal = typeof meta.canonicalGoal === "string" ? meta.canonicalGoal.trim() : "";
  if (canonicalGoal) return canonicalGoal;
  const initialUserText = typeof meta.initialUserText === "string" ? meta.initialUserText.trim() : "";
  return initialUserText || fallback;
}

interface RewardExchangePair {
  userText: string;
  agentText: string;
  toolHint?: string;
}

function rewardPairFromRawTurn(rawTurn: RawTurnRecord): RewardExchangePair | null {
  const userText = rawTurn.userText?.trim() ?? "";
  const agentText = rawTurn.assistantText?.trim() ?? "";
  if (!userText && !agentText) return null;
  const toolHint = rawTurn.toolCalls.length
    ? rawTurn.toolCalls.map((call) => objectField(call, "name") ?? "tool").join(", ")
    : undefined;
  return { userText, agentText, toolHint };
}

function rewardPairFromTrace(trace: TraceMeta): RewardExchangePair | null {
  const userText = trace.userText.trim();
  const agentText = trace.agentText.trim();
  if (!userText && !agentText) return null;
  const toolHint = trace.toolCalls.length
    ? trace.toolCalls.map((call) => call.error ? `${call.name}[ERR:${call.error}]` : call.name).join(", ")
    : undefined;
  return { userText, agentText, toolHint };
}

function rewardFormatPair(pair: RewardExchangePair, index: number, isLast: boolean): string {
  const lines = [`[${index + 1}] USER: ${rewardOneLine(pair.userText, 300)}`];
  if (pair.toolHint) {
    lines.push(`    TOOLS: ${pair.toolHint}`);
  }
  lines.push(`    AGENT: ${isLast ? rewardClampAgentText(pair.agentText) : rewardOneLine(pair.agentText, 400)}`);
  return lines.join("\n");
}

function rewardTraceOneLiner(trace: TraceMeta, index: number): string {
  const toolNames = trace.toolCalls
    .map((call) => call.error ? `${call.name}[ERR:${call.error}]` : call.name)
    .filter(Boolean)
    .join(", ");
  const action = toolNames || rewardOneLine(trace.agentText, 120) || "(text only)";
  return `  ${index + 1}. ${action}`;
}

function rewardExecutionOutcome(traces: readonly TraceMeta[]): string {
  let totalToolCalls = 0;
  let successCount = 0;
  let errorCount = 0;
  let lastToolCall: ToolCallPayload | undefined;
  for (const trace of [...traces].sort((a, b) => a.ts - b.ts)) {
    for (const call of trace.toolCalls) {
      totalToolCalls += 1;
      if (call.error || call.errorCode || call.success === false) {
        errorCount += 1;
      } else {
        successCount += 1;
      }
      lastToolCall = call;
    }
  }
  const lines = ["EXECUTION_OUTCOME:"];
  if (!lastToolCall) {
    lines.push("  total_tool_calls: 0");
    lines.push("  last_tool_result: NONE");
    lines.push("  task_completed_by_tool: unknown");
    return lines.join("\n");
  }
  const failed = Boolean(lastToolCall.error || lastToolCall.errorCode || lastToolCall.success === false);
  lines.push(`  total_tool_calls: ${totalToolCalls}  (success: ${successCount}, error: ${errorCount})`);
  lines.push(`  last_tool_result: ${failed ? "ERROR" : "SUCCESS"}  [tool: ${lastToolCall.name}]${lastToolCall.errorCode ? `, code: ${lastToolCall.errorCode}` : ""}`);
  lines.push(`  task_completed_by_tool: ${failed ? "no" : "yes"}`);
  return lines.join("\n");
}

function rewardHostAgentContext(input: {
  source: MemoryRow;
  episode?: EpisodeRecord;
  evaluator?: {
    scorerProvider?: string;
    scorerModel?: string;
  };
}): string {
  const meta = input.episode?.meta ?? {};
  const hints = isRecord(meta.contextHints) ? meta.contextHints : {};
  const fields: Array<[string, unknown]> = [
    ["agent", input.source.agentId],
    ["agentIdentity", hints.agentIdentity ?? meta.agentIdentity],
    ["hostProvider", hints.hostProvider ?? meta.hostProvider],
    ["hostModel", hints.hostModel ?? meta.hostModel],
    ["hostApiMode", hints.hostApiMode ?? meta.hostApiMode],
    ["scorerProvider", input.evaluator?.scorerProvider],
    ["scorerModel", input.evaluator?.scorerModel]
  ];
  const lines = fields
    .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
    .map(([key, value]) => `${key}: ${rewardOneLine(String(value), 240)}`);
  if (lines.length === 0) return "";
  lines.push("gradingInstruction: Evaluate the host agent's answer in this host context; do not project the evaluator model's own identity, provider, or capabilities onto the host agent.");
  return lines.join("\n");
}

function rewardClampHeadTail(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = "\n...[truncated]...\n";
  if (maxChars <= marker.length + 20) {
    return value.slice(0, Math.max(0, maxChars - 3)) + "...";
  }
  const headChars = Math.floor((maxChars - marker.length) * 0.55);
  const tailChars = Math.max(0, maxChars - marker.length - headChars);
  return `${value.slice(0, headChars).trimEnd()}${marker}${value.slice(value.length - tailChars).trimStart()}`;
}

function rewardOneLine(value: string, maxChars: number): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length <= maxChars ? line : `${line.slice(0, maxChars - 3).trimEnd()}...`;
}

function rewardClampAgentText(value: string): string {
  return rewardOneLine(value || "(no agent text)", 800);
}

const REWARD_TRIVIAL_PATTERNS = [
  /^(test|testing|hello|hi|hey|ok|okay|yes|no|yeah|nope|sure|thanks|thank you|thx|ping|pong|哈哈|好的|嗯|是的|不是|谢谢|你好|测试)\s*[.!?。！？]*$/i,
  /^(aaa+|bbb+|xxx+|zzz+|123+|asdf+|qwer+|haha+|lol+|hmm+)\s*$/i,
  /^[\s\p{P}\p{S}]*$/u
];

const MIN_REWARD_NON_TRIVIAL_CHARS = 30;

function rewardLooksLikeTrivialContent(text: string): boolean {
  const lines = text
    .toLowerCase()
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return true;

  let trivialChars = 0;
  let nonTrivialChars = 0;
  for (const line of lines) {
    if (REWARD_TRIVIAL_PATTERNS.some((pattern) => pattern.test(line))) {
      trivialChars += line.length;
    } else {
      nonTrivialChars += line.length;
    }
  }
  if (nonTrivialChars >= MIN_REWARD_NON_TRIVIAL_CHARS) return false;
  const total = trivialChars + nonTrivialChars;
  return total === 0 || trivialChars / total > 0.7;
}

function rewardSkipReason(
  traces: readonly TraceMeta[],
  cfg: MemmyConfig["algorithm"]["reward"]
): string | null {
  let userTurns = 0;
  let assistantTurns = 0;
  let toolTurns = 0;
  let contentChars = 0;
  const userContents: string[] = [];
  const assistantContents: string[] = [];

  for (const trace of traces) {
    const userText = trace.userText ?? "";
    const agentText = trace.agentText ?? "";
    if (userText.length > 0) {
      userTurns += 1;
      contentChars += userText.length;
      userContents.push(userText);
    }
    if (agentText.length > 0) {
      assistantTurns += 1;
      contentChars += agentText.length;
      assistantContents.push(agentText);
    }
    if (trace.toolCalls.length > 0) {
      toolTurns += trace.toolCalls.length;
    }
  }

  const exchanges = Math.min(userTurns, assistantTurns);
  if (exchanges < cfg.minExchangesForCompletion) {
    return `对话轮次不足（${exchanges} 轮），需要至少 ${cfg.minExchangesForCompletion} 轮完整的问答交互才能生成摘要。`;
  }
  if (userTurns === 0) {
    return "该任务没有用户消息，仅包含系统或工具自动生成的内容。";
  }

  const allText = (userContents.join("") + assistantContents.join("")).slice(0, 4000);
  const hasCjk = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(allText);
  const minContentLen = hasCjk
    ? cfg.minContentCharsForCompletion
    : cfg.minContentCharsForCompletion * 2;
  if (contentChars < minContentLen) {
    return `对话内容过短（${contentChars} 字符），信息量不足以生成有意义的摘要。`;
  }

  const allUserText = userContents.join("\n");
  if (rewardLooksLikeTrivialContent(allUserText)) {
    return "对话内容为简单问候或测试数据（如 hello、test、ok），无需生成摘要。";
  }

  const allAssistantText = assistantContents.join("\n");
  if (rewardLooksLikeTrivialContent(`${allUserText}\n${allAssistantText}`)) {
    return "对话内容（用户和助手双方）为简单问候或测试数据，无需生成摘要。";
  }

  const totalTurns = userTurns + assistantTurns + toolTurns;
  const assistantContentChars = assistantContents.reduce((sum, value) => sum + value.length, 0);
  if (
    toolTurns > 0 &&
    totalTurns > 0 &&
    toolTurns >= totalTurns * cfg.toolHeavyRatio &&
    userTurns <= 1 &&
    assistantContentChars < cfg.minAssistantCharsForToolHeavy
  ) {
    return `该任务主要由工具执行结果组成（${toolTurns}/${totalTurns} 条），缺少足够的用户交互内容。`;
  }

  if (userContents.length >= 3) {
    const uniqueUserMessages = new Set(userContents.map((value) => value.trim().toLowerCase()));
    if (uniqueUserMessages.size / userContents.length < 0.4) {
      return `对话中存在大量重复内容（${uniqueUserMessages.size} 条独立消息 / ${userContents.length} 条用户消息），无法提取有效信息。`;
    }
  }

  return null;
}

function rawTurnSummary(rawTurn: RawTurnRecord): {
  rawTurnId: string;
  episodeId: string;
  turnId: string;
  userText?: string;
  assistantText?: string;
  reasoningSummary?: string;
  toolCalls?: unknown[];
  toolResults?: unknown[];
  createdAt: string;
} {
  const redacted = Boolean(rawTurn.redactedAt || rawTurn.deletedAt);
  return {
    rawTurnId: rawTurn.id,
    episodeId: rawTurn.episodeId,
    turnId: rawTurn.turnId,
    userText: redacted ? undefined : rawTurn.userText,
    assistantText: redacted ? undefined : rawTurn.assistantText,
    reasoningSummary: redacted ? undefined : rawTurn.reasoningSummary,
    toolCalls: redacted ? undefined : rawTurn.toolCalls,
    toolResults: redacted ? undefined : rawTurn.toolResults,
    createdAt: rawTurn.createdAt
  };
}

function episodeRef(episode: EpisodeRecord): Record<string, unknown> {
  const skillStatus = episodeSkillStatus(episode);
  const skillReason = episodeSkillReason(episode);
  return {
    id: episode.id,
    sessionId: episode.sessionId,
    title: episode.title,
    summary: episode.summary,
    status: episode.status,
    startedAt: episode.openedAt,
    endedAt: episode.closedAt ?? undefined,
    turnCount: episode.turnCount,
    rTask: episode.rTask,
    rewardSkipped: episode.rewardDetail.skipped === true,
    rewardReason: typeof episode.rewardDetail.reason === "string" ? episode.rewardDetail.reason : undefined,
    closeReason: typeof episode.meta.closeReason === "string" ? episode.meta.closeReason : undefined,
    topicState: typeof episode.meta.topicState === "string" ? episode.meta.topicState : undefined,
    abandonReason: typeof episode.meta.abandonReason === "string" ? episode.meta.abandonReason : undefined,
    pipelineStatus: episode.pipelineStatus,
    pipelineError: episode.pipelineError,
    skillMemoryIds: episode.skillMemoryIds,
    linkedSkillId: episode.skillMemoryIds[0],
    skillStatus,
    skillReason
  };
}

function episodeSkillStatus(episode: EpisodeRecord): string {
  if (episode.skillMemoryIds.length > 0) return "succeeded";
  if (episode.pipelineStatus === "running") return "running";
  if (episode.pipelineStatus === "failed") return "failed";
  if (typeof episode.rTask === "number" && episode.rTask <= -0.5) return "skipped";
  if (
    episode.rewardDetail.skipped === true ||
    episode.meta.closeReason === "abandoned" ||
    (typeof episode.rTask === "number" && episode.rTask < 0.3)
  ) {
    return "skipped";
  }
  return "queued";
}

function episodeSkillReason(episode: EpisodeRecord): string | undefined {
  if (episode.skillMemoryIds.length > 0) return "已从该任务沉淀出可复用技能。";
  if (episode.pipelineError?.trim()) return `技能沉淀失败：${episode.pipelineError.trim()}`;
  if (typeof episode.rTask === "number" && episode.rTask <= -0.5) {
    return `任务评分 ${episode.rTask.toFixed(2)}，被视为反例；不会沉淀出新的经验或技能。`;
  }
  if (episode.rewardDetail.skipped === true) {
    if (episode.turnCount < 2) return "对话轮次不足，需要至少 2 轮完整问答才能生成摘要或技能。";
    return "Reward 评分被跳过，暂不生成技能。";
  }
  if (episode.meta.closeReason === "abandoned") return "任务在完成打分前结束，暂不生成技能。";
  if (typeof episode.rTask === "number" && episode.rTask < 0.3) {
    return `任务评分 ${episode.rTask.toFixed(2)} 未达到沉淀阈值，暂不生成技能。`;
  }
  if (episode.pipelineStatus === "running") return "正在沉淀技能。";
  if (episode.pipelineStatus === "succeeded") return "本任务未产出可复用技能。";
  if (episode.status === "open") return "任务仍在进行中，暂未启动技能沉淀。";
  return typeof episode.meta.skillReason === "string" ? episode.meta.skillReason : "等待评分完成后判断是否沉淀技能。";
}

function policyLinkRef(link: TracePolicyLinkRecord): {
  policyMemoryId: string;
  traceMemoryId: string;
  relation: string;
} {
  return {
    policyMemoryId: link.l2MemoryId,
    traceMemoryId: link.l1MemoryId,
    relation: link.relation
  };
}

function skillTrialRef(trial: SkillTrialRecord, episode?: EpisodeRecord): {
  trialId: string;
  status: SkillTrialRecord["status"];
  episodeId?: string;
  reward?: number;
} {
  return {
    trialId: trial.id,
    status: trial.status,
    episodeId: trial.episodeId,
    reward: typeof episode?.rTask === "number" ? episode.rTask : undefined
  };
}

function timelineMemoryIdsForEpisode(episode: EpisodeRecord, layers: ReadonlySet<MemoryLayer>): string[] {
  return [
    ...(layers.has("L1") ? episode.l1MemoryIds : []),
    ...(layers.has("L2") ? episode.l2PolicyIds : []),
    ...(layers.has("L3") ? episode.l3WorldModelIds : []),
    ...(layers.has("Skill") ? episode.skillMemoryIds : [])
  ];
}

function dedupeStrings(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function normalizeRequestTags(tags: readonly string[] | undefined): string[] {
  const reserved = new Set(["trace", "turn", "memmy", "openclaw"]);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags ?? []) {
    const trimmed = tag.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (reserved.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function uniqMemories(memories: readonly MemoryRow[]): MemoryRow[] {
  const out: MemoryRow[] = [];
  const seen = new Set<string>();
  for (const memory of memories) {
    if (seen.has(memory.id)) continue;
    seen.add(memory.id);
    out.push(memory);
  }
  return out;
}

function renderTraceMemoryValue(step: {
  summary: string;
  rawTurnId?: string;
  stepIndex?: number;
  userText?: string;
  agentText?: string;
  toolCalls: Array<{ name: string; input?: unknown; output?: unknown; error?: string }>;
  reflection: { text: string | null; alpha: number };
  value: number;
  priority: number;
}): string {
  const parts = [
    `Summary: ${step.summary}`,
    step.rawTurnId ? `RawTurn: ${step.rawTurnId}` : undefined,
    typeof step.stepIndex === "number" ? `TraceStep: ${step.stepIndex}` : undefined,
    step.userText ? `User:\n${step.userText}` : undefined,
    step.toolCalls.length
      ? [
          "Tool calls:",
          ...step.toolCalls.map((call) =>
            `- ${call.name}${call.error ? ` error=${clip(call.error, 160)}` : ""}`
          )
        ].join("\n")
      : undefined,
    step.agentText ? `Agent:\n${step.agentText}` : undefined,
    step.reflection.text ? `Reflection: ${clip(step.reflection.text, 800)}` : undefined,
    `Alpha: ${step.reflection.alpha}`,
    `Value: ${step.value}`,
    `Priority: ${step.priority}`
  ].filter(Boolean);
  return parts.join("\n");
}

function sanitizeTraceToolCalls(toolCalls: ToolCallPayload[]): ToolCallPayload[] {
  return toolCalls.map((call) => ({
    id: call.id,
    name: call.name,
    success: call.success,
    errorCode: call.errorCode,
    error: call.error ?? errorMessageFromUnknown(call.output),
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    thinkingBefore: call.thinkingBefore,
    assistantTextBefore: call.assistantTextBefore
  }));
}

function updateTraceScore(memory: MemoryRow, input: {
  value: number;
  alpha: number;
  priority: number;
  rHuman: number;
  rewardReason: string;
  sourceFeedbackId?: string;
  updatedAt: string;
}): MemoryRow {
  const trace = memory.properties.internal_info.trace;
  const sourceFeedbackIds = uniq([
    ...stringArray(memory.properties.internal_info.source_feedback_ids),
    ...(trace && typeof trace === "object"
      ? stringArray((trace as Record<string, unknown>).source_feedback_ids)
      : []),
    ...(input.sourceFeedbackId ? [input.sourceFeedbackId] : [])
  ]);
  const nextTrace = trace && typeof trace === "object"
    ? {
        ...(trace as Record<string, unknown>),
        value: input.value,
        alpha: input.alpha,
        priority: input.priority,
        r_human: input.rHuman,
        reward_reason: input.rewardReason,
        ...(sourceFeedbackIds.length > 0 ? { source_feedback_ids: sourceFeedbackIds } : {})
      }
    : {
        value: input.value,
        alpha: input.alpha,
        priority: input.priority,
        r_human: input.rHuman,
        reward_reason: input.rewardReason,
        ...(sourceFeedbackIds.length > 0 ? { source_feedback_ids: sourceFeedbackIds } : {})
      };
  return {
    ...memory,
    memoryValue: memory.memoryValue.replace(
      /Alpha: [^\n]+\nValue: [^\n]+\nPriority: [^\n]+$/,
      `Alpha: ${input.alpha}\nValue: ${input.value}\nPriority: ${input.priority}`
    ),
    info: {
      ...memory.info,
      value: input.value,
      priority: input.priority,
      r_human: input.rHuman,
      ...(sourceFeedbackIds.length > 0 ? { source_feedback_ids: sourceFeedbackIds } : {})
    },
    properties: {
      ...memory.properties,
      internal_info: {
        ...memory.properties.internal_info,
        ...(sourceFeedbackIds.length > 0 ? { source_feedback_ids: sourceFeedbackIds } : {}),
        value: input.value,
        alpha: input.alpha,
        priority: input.priority,
        r_human: input.rHuman,
        trace: nextTrace
      }
    },
    updatedAt: input.updatedAt
  };
}

function updatePolicyStats(memory: MemoryRow, input: {
  support: number;
  gain: number;
  rawGain: number;
  status: "candidate" | "active" | "archived";
  sourceEpisodeIds: string[];
  sourceTraceIds: string[];
  updatedAt: string;
}): MemoryRow {
  const currentPolicy = policyMetaFromMemory(memory);
  const internalPolicy = isRecord(memory.properties.internal_info.policy)
    ? memory.properties.internal_info.policy
    : {};
  const status = memoryStatusForLifecycleStatus(input.status);
  const nextPolicy = {
    ...internalPolicy,
    support: input.support,
    gain: input.gain,
    raw_gain: input.rawGain,
    status: input.status,
    source_episode_ids: input.sourceEpisodeIds,
    source_trace_ids: input.sourceTraceIds
  };
  const body = currentPolicy
    ? renderPolicyBody({
        title: currentPolicy.title,
        trigger: currentPolicy.trigger,
        procedure: currentPolicy.procedure,
        verification: currentPolicy.verification,
        boundary: currentPolicy.boundary,
        support: input.support,
        gain: input.gain,
        rawGain: input.rawGain,
        confidence: currentPolicy.confidence,
        sourceTraceIds: input.sourceTraceIds
      })
    : memory.memoryValue;
  return {
    ...memory,
    status,
    memoryValue: body,
    info: {
      ...memory.info,
      support: input.support,
      gain: input.gain,
      raw_gain: input.rawGain,
      policy_confidence: currentPolicy?.confidence,
      status: input.status,
      source_memory_ids: input.sourceTraceIds
    },
    properties: {
      ...memory.properties,
      status,
      info: {
        ...(memory.properties.info ?? {}),
        support: input.support,
        gain: input.gain,
        raw_gain: input.rawGain,
        policy_confidence: currentPolicy?.confidence,
        status: input.status,
        source_memory_ids: input.sourceTraceIds
      },
      internal_info: {
        ...memory.properties.internal_info,
        source_memory_ids: input.sourceTraceIds,
        source_l1_memory_ids: input.sourceTraceIds,
        support: input.support,
        gain: input.gain,
        raw_gain: input.rawGain,
        policy_confidence: currentPolicy?.confidence,
        status: input.status,
        source_episode_ids: input.sourceEpisodeIds,
        source_trace_ids: input.sourceTraceIds,
        policy: nextPolicy
      }
    },
    updatedAt: input.updatedAt
  };
}

function updatePolicyDecisionGuidance(memory: MemoryRow, input: {
  preference?: string;
  antiPattern?: string;
  repairId: string;
  updatedAt: string;
}): MemoryRow {
  const internalPolicy = isRecord(memory.properties.internal_info.policy)
    ? memory.properties.internal_info.policy
    : {};
  const currentGuidance = isRecord(internalPolicy.decision_guidance)
    ? internalPolicy.decision_guidance
    : {};
  const preference = uniq([
    ...stringArray(currentGuidance.preference),
    ...(input.preference ? [input.preference] : [])
  ]);
  const antiPattern = uniq([
    ...stringArray(currentGuidance.anti_pattern),
    ...(input.antiPattern ? [input.antiPattern] : [])
  ]);
  const repairIds = uniq([
    ...stringArray(currentGuidance.repair_ids),
    input.repairId
  ]);
  const changed = preference.length !== stringArray(currentGuidance.preference).length ||
    antiPattern.length !== stringArray(currentGuidance.anti_pattern).length ||
    repairIds.length !== stringArray(currentGuidance.repair_ids).length;
  if (!changed) return memory;
  return {
    ...memory,
    properties: {
      ...memory.properties,
      internal_info: {
        ...memory.properties.internal_info,
        decision_guidance: {
          preference,
          anti_pattern: antiPattern,
          repair_ids: repairIds
        },
        policy: {
          ...internalPolicy,
          decision_guidance: {
            preference,
            anti_pattern: antiPattern,
            repair_ids: repairIds
          }
        }
      }
    },
    updatedAt: input.updatedAt
  };
}

function updateRecallStats(memory: MemoryRow, input: {
  outcome: NonNullable<RecallEventRecord["outcome"]>;
  feedbackId: string;
  recallEventId: string;
  updatedAt: string;
}): MemoryRow {
  const current = isRecord(memory.properties.internal_info.recall)
    ? memory.properties.internal_info.recall
    : {};
  const positive = numberOr(current.positive, 0) + (input.outcome === "positive" ? 1 : 0);
  const negative = numberOr(current.negative, 0) + (input.outcome === "negative" ? 1 : 0);
  const ignored = numberOr(current.ignored, 0) + (input.outcome === "ignored" ? 1 : 0);
  const total = positive + negative + ignored;
  const effectiveness = total > 0 ? (positive - negative) / total : 0;
  return {
    ...memory,
    properties: {
      ...memory.properties,
      internal_info: {
        ...memory.properties.internal_info,
        recall: {
          ...current,
          positive,
          negative,
          ignored,
          total,
          effectiveness,
          last_outcome: input.outcome,
          last_feedback_id: input.feedbackId,
          last_recall_event_id: input.recallEventId,
          updated_at: input.updatedAt
        }
      }
    },
    updatedAt: input.updatedAt
  };
}

function embeddingTextForMemory(memory: MemoryRow): string {
  const trace = traceMetaFromMemory(memory);
  if (trace) {
    return [trace.summary, trace.reflection ?? ""]
      .filter(Boolean)
      .join("\n");
  }
  const policy = policyMetaFromMemory(memory);
  if (policy) {
    return [policy.title, policy.trigger, policy.procedure, policy.verification, policy.boundary]
      .filter(Boolean)
      .join("\n");
  }
  const skill = skillMetaFromMemory(memory);
  if (skill) {
    return [skill.name, skill.invocationGuide].filter(Boolean).join("\n");
  }
  const world = worldModelMetaFromMemory(memory);
  if (world) {
    return [world.title, world.body, world.domainTags.join(" ")].filter(Boolean).join("\n");
  }
  return memory.memoryValue;
}

function traceSummaryEmbeddingText(memory: MemoryRow): string | undefined {
  const trace = traceMetaFromMemory(memory);
  const summary = firstRealSummary(
    trace?.summary,
    stringFromRecord(memory.info, "summary"),
    stringFromRecord(memory.properties.internal_info, "summary")
  );
  if (!summary) return undefined;
  const originalExchange = trace
    ? clip([trace.userText, trace.agentText].filter(Boolean).join("\n"), 3_000)
    : "";
  return [
    `Summary: ${summary}`,
    ...(originalExchange ? [`Original exchange:\n${originalExchange}`] : [])
  ].join("\n\n");
}

function embeddingRetryTargetKindForMemory(memory: MemoryRow): EmbeddingRetryTargetKind {
  if (memory.memoryLayer === "L1") {
    return "trace";
  }
  if (memory.memoryLayer === "L2") {
    return "policy";
  }
  if (memory.memoryLayer === "L3") {
    return "world_model";
  }
  return "skill";
}

function embeddingRetryVectorFieldForMemory(memory: MemoryRow): EmbeddingRetryVectorField {
  return memory.memoryLayer === "L1" ? "vec_summary" : "vec";
}

function embeddingRetryBackoffMs(attemptNo: number): number {
  return Math.min(
    EMBEDDING_RETRY_MAX_BACKOFF_MS,
    EMBEDDING_RETRY_BASE_BACKOFF_MS * 2 ** Math.max(0, attemptNo - 1)
  );
}

function embeddingRetryToRunItem(retry: EmbeddingRetryRecord): EmbeddingRetryRunSummary["items"][number] {
  return {
    id: retry.id,
    status: retry.status,
    targetKind: retry.targetKind,
    targetMemoryId: retry.targetId,
    vectorField: retry.vectorField,
    attempts: retry.attempts,
    lastError: retry.lastError
  };
}

function updateMemoryVectorField(memory: MemoryRow, vectorField: EmbeddingRetryVectorField, vector: number[], input: {
  provider: string;
  model: string;
  updatedAt: string;
}): MemoryRow {
  const internal = memory.properties.internal_info;
  const nextInternal: Record<string, unknown> = { ...internal };
  if (memory.memoryLayer === "L1" && isRecord(internal.trace)) {
    nextInternal.trace = {
      ...internal.trace,
    };
  } else if (memory.memoryLayer === "L2" && isRecord(internal.policy)) {
    nextInternal.policy = {
      ...internal.policy,
    };
  } else if (memory.memoryLayer === "L3" && isRecord(internal.world_model)) {
    nextInternal.world_model = {
      ...internal.world_model,
    };
  } else if (memory.memoryLayer === "Skill" && isRecord(internal.skill)) {
    nextInternal.skill = {
      ...internal.skill,
    };
  }

  const updated = {
    ...memory,
    properties: {
      ...memory.properties,
      internal_info: {
        ...memory.properties.internal_info,
        ...nextInternal
      }
    },
    updatedAt: input.updatedAt
  };
  return attachMemoryVector(updated, {
    vectorField,
    vector,
    embeddingProvider: input.provider,
    embeddingModel: input.model
  });
}

function updateImportPipelineStatus(memory: MemoryRow, _status: "indexing" | "indexed", at: string): MemoryRow {
  if (memory.memoryLayer !== "L1" || !memoryHasImportPipeline(memory)) return memory;
  const tags = importStatusTags(memory.tags, _status);
  return {
    ...memory,
    tags,
    info: {
      ...memory.info,
      tags
    },
    properties: {
      ...memory.properties,
      tags,
      info: {
        ...(memory.properties.info ?? {}),
        tags
      }
    },
    updatedAt: at
  };
}

function memoryHasImportPipeline(memory: MemoryRow): boolean {
  const algorithm = stringFromRecord(memory.properties.internal_info, "plugin_algorithm");
  return algorithm?.startsWith("memory.add.import_async.") === true ||
    memory.tags.some((tag) => tag.trim().toLowerCase() === "agent-source");
}

function memoryNeedsImportSummary(memory: MemoryRow): boolean {
  if (memory.memoryLayer !== "L1" || !memoryHasImportPipeline(memory)) {
    return false;
  }
  const summary = firstSummary(
    stringFromRecord(memory.info, "summary") ??
    stringFromRecord(memory.properties.internal_info, "summary") ??
    traceMetaFromMemory(memory)?.summary
  );
  return isImportSummaryPlaceholder(summary);
}

function isImportSummaryPlaceholder(value: string | undefined): boolean {
  const first = value
    ?.split(/\r?\n/)
    .map((line) => line.replace(/^\s*#{1,6}\s+/, "").trim())
    .find(Boolean);
  return Boolean(first && /^(user|assistant|system|tool|developer|摘要排队中|摘要整理中)$/i.test(first));
}

function firstSummary(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value));
}

function firstRealSummary(...values: Array<string | undefined>): string | undefined {
  return values
    .map((value) => value?.trim())
    .find((value): value is string => Boolean(value && !isImportSummaryPlaceholder(value)));
}

function importStatusTags(tags: string[], status: "indexing" | "indexed"): string[] {
  void status;
  return uniq(tags.filter((tag) => !IMPORT_STATUS_TAGS.includes(tag)));
}

function updateTraceImportSummary(memory: MemoryRow, input: {
  summary: string;
  alpha: number;
  value: number;
  priority: number;
  tags: string[];
  updatedAt: string;
}): MemoryRow {
  const trace = traceMetaFromMemory(memory);
  if (!trace) {
    return memory;
  }
  const internalTrace = isRecord(memory.properties.internal_info.trace)
    ? memory.properties.internal_info.trace
    : {};
  const nextTrace = {
    ...internalTrace,
    summary: input.summary,
    reflection: null,
    alpha: input.alpha,
    usable: false,
    reflection_source: "none",
    value: input.value,
    priority: input.priority,
    import_summary_at: input.updatedAt
  };
  return {
    ...memory,
    memoryValue: renderTraceMemoryValue({
      summary: input.summary,
      rawTurnId: stringFromRecord(internalTrace, "raw_turn_id"),
      stepIndex: numberFromRecord(internalTrace, "step_index"),
      userText: trace.userText,
      agentText: trace.agentText,
      toolCalls: trace.toolCalls,
      reflection: {
        text: null,
        alpha: input.alpha
      },
      value: input.value,
      priority: input.priority
    }),
    tags: input.tags,
    info: {
      ...memory.info,
      summary: input.summary,
      value: input.value,
      priority: input.priority,
      tags: input.tags
    },
    properties: {
      ...memory.properties,
      tags: input.tags,
      info: {
        ...(memory.properties.info ?? {}),
        summary: input.summary,
        value: input.value,
        priority: input.priority,
        tags: input.tags
      },
      internal_info: {
        ...memory.properties.internal_info,
        summary: input.summary,
        alpha: input.alpha,
        value: input.value,
        priority: input.priority,
        trace: nextTrace
      }
    },
    updatedAt: input.updatedAt
  };
}

function updateTraceSummary(memory: MemoryRow, input: {
  summary: string;
  updatedAt: string;
}): MemoryRow {
  const trace = traceMetaFromMemory(memory);
  if (!trace) {
    return memory;
  }
  const internalTrace = isRecord(memory.properties.internal_info.trace)
    ? memory.properties.internal_info.trace
    : {};
  const nextTrace = {
    ...internalTrace,
    summary: input.summary,
    summary_at: input.updatedAt
  };
  return {
    ...memory,
    memoryValue: renderTraceMemoryValue({
      summary: input.summary,
      rawTurnId: stringFromRecord(internalTrace, "raw_turn_id"),
      stepIndex: numberFromRecord(internalTrace, "step_index"),
      userText: trace.userText,
      agentText: trace.agentText,
      toolCalls: trace.toolCalls,
      reflection: {
        text: trace.reflection,
        alpha: trace.alpha
      },
      value: trace.value,
      priority: trace.priority
    }),
    info: {
      ...memory.info,
      summary: input.summary
    },
    properties: {
      ...memory.properties,
      info: {
        ...(memory.properties.info ?? {}),
        summary: input.summary
      },
      internal_info: {
        ...memory.properties.internal_info,
        summary: input.summary,
        trace: nextTrace
      }
    },
    updatedAt: input.updatedAt
  };
}

function updateTraceReflection(memory: MemoryRow, input: {
  summary: string;
  reflection: string;
  alpha: number;
  usable: boolean;
  reason?: string;
  source?: "adapter" | "extracted" | "synth" | "none";
  tags: string[];
  updatedAt: string;
}): MemoryRow {
  const trace = traceMetaFromMemory(memory);
  if (!trace) {
    return memory;
  }
  const internalTrace = isRecord(memory.properties.internal_info.trace)
    ? memory.properties.internal_info.trace
    : {};
  const nextTrace = {
    ...internalTrace,
    summary: input.summary,
    reflection: input.reflection,
    alpha: input.alpha,
    usable: input.usable,
    reflection_reason: input.reason,
    reflection_source: input.source ?? "synth",
    reflection_scored_at: input.updatedAt
  };
  return {
    ...memory,
    memoryValue: renderTraceMemoryValue({
      summary: input.summary,
      rawTurnId: stringFromRecord(internalTrace, "raw_turn_id"),
      stepIndex: numberFromRecord(internalTrace, "step_index"),
      toolCalls: trace.toolCalls,
      userText: trace.userText,
      agentText: trace.agentText,
      reflection: {
        text: input.reflection || null,
        alpha: input.alpha
      },
      value: trace.value,
      priority: trace.priority
    }),
    tags: input.tags,
    info: {
      ...memory.info,
      summary: input.summary,
      tags: input.tags
    },
    properties: {
      ...memory.properties,
      tags: input.tags,
      info: {
        ...(memory.properties.info ?? {}),
        summary: input.summary,
        tags: input.tags
      },
      internal_info: {
        ...memory.properties.internal_info,
        summary: input.summary,
        reflection: input.reflection,
        alpha: input.alpha,
        trace: nextTrace
      }
    },
    updatedAt: input.updatedAt
  };
}

function traceReflectionWasScored(memory: MemoryRow): boolean {
  const internalTrace = isRecord(memory.properties.internal_info.trace)
    ? memory.properties.internal_info.trace
    : {};
  return typeof internalTrace.reflection_scored_at === "string";
}

function updateSkillStats(memory: MemoryRow, input: {
  trialsAttempted: number;
  trialsPassed: number;
  eta: number;
  status: "candidate" | "active" | "archived";
  updatedAt: string;
}): MemoryRow {
  const internalSkill = isRecord(memory.properties.internal_info.skill)
    ? memory.properties.internal_info.skill
    : {};
  const currentProcedure = isRecord(internalSkill.procedure_json)
    ? internalSkill.procedure_json
    : {};
  const successRate = skillSuccessRate(input.trialsAttempted, input.trialsPassed);
  const betaPosterior = skillBetaPosterior(input.trialsAttempted, input.trialsPassed);
  return {
    ...memory,
    info: {
      ...memory.info,
      eta: input.eta,
      trials_attempted: input.trialsAttempted,
      trials_passed: input.trialsPassed,
      skill_status: input.status
    },
    status: memoryStatusForSkillStatus(input.status),
    properties: {
      ...memory.properties,
      status: memoryStatusForSkillStatus(input.status),
      internal_info: {
        ...memory.properties.internal_info,
        status: input.status,
        eta: input.eta,
        trials_attempted: input.trialsAttempted,
        trials_passed: input.trialsPassed,
        success_rate: successRate,
        beta_posterior: betaPosterior,
        procedure_json: {
          ...currentProcedure,
          reliability: {
            ...(isRecord(currentProcedure.reliability) ? currentProcedure.reliability : {}),
            supportCount: numberOr(internalSkill.support, 0),
            successRate,
            betaPosterior
          }
        },
        skill: {
          ...internalSkill,
          status: input.status,
          eta: input.eta,
          trials_attempted: input.trialsAttempted,
          trials_passed: input.trialsPassed,
          success_rate: successRate,
          beta_posterior: betaPosterior,
          procedure_json: {
            ...currentProcedure,
            reliability: {
              ...(isRecord(currentProcedure.reliability) ? currentProcedure.reliability : {}),
              supportCount: numberOr(internalSkill.support, 0),
              successRate,
              betaPosterior
            }
          }
        }
      }
    },
    updatedAt: input.updatedAt
  };
}

function isRepairCandidatePolicyForSkill(policy: PolicyMeta): boolean {
  return policy.evidencePolarity === "negative" &&
    policy.skillEligible === false &&
    policy.decisionGuidance.preference.some((item) => item.trim().length > 0);
}

function repairCandidateStrictTrial(policy: PolicyMeta): boolean {
  const internalPolicy = isRecord(policy.memory.properties.internal_info.policy)
    ? policy.memory.properties.internal_info.policy
    : {};
  const verifierMeta = isRecord(internalPolicy.verifier_meta)
    ? internalPolicy.verifier_meta
    : null;
  return Boolean(verifierMeta && (
    verifierMeta.passed !== undefined ||
    verifierMeta.total !== undefined ||
    verifierMeta.reward !== undefined ||
    verifierMeta.score !== undefined
  ));
}

function repairCandidateSkillName(policy: PolicyMeta, fix: string): string {
  const words = `${policy.title} ${fix}`
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length >= 3 && word !== "repair" && word !== "avoid")
    .slice(0, 5);
  const raw = ["repair", ...words].join("_").slice(0, 48).replace(/_+$/g, "");
  return raw && raw !== "repair" ? raw : `repair_${stableHash(policy.id).slice(0, 10)}`;
}

function renderRepairCandidateGuide(policy: PolicyMeta, fix: string): string {
  return [
    `# ${policy.title || "Repair candidate"}`,
    "Candidate fix distilled from a past failure on a similar task. Applying it here both solves the task and validates the fix.",
    "",
    policy.trigger ? "**When to use**" : "",
    policy.trigger,
    policy.trigger ? "" : "",
    "**Suggested fix**",
    fix,
    "",
    policy.decisionGuidance.antiPattern.length > 0 ? "**Avoid**" : "",
    ...policy.decisionGuidance.antiPattern.map((item) => `- ${item}`),
    policy.verification ? "" : "",
    policy.verification ? "**Verify**" : "",
    policy.verification
  ].filter((line) => typeof line === "string" && line.length > 0).join("\n");
}

function skillSuccessRate(attempted: number, passed: number): number {
  if (attempted <= 0) return 0;
  return clampNumber(passed / attempted, 0, 1);
}

function skillBetaPosterior(attempted: number, passed: number): {
  alpha: number;
  beta: number;
  mean: number;
} {
  const safeAttempted = Math.max(0, Math.floor(attempted));
  const safePassed = Math.min(safeAttempted, Math.max(0, Math.floor(passed)));
  const alpha = safePassed + 1;
  const beta = safeAttempted - safePassed + 1;
  return {
    alpha,
    beta,
    mean: clampNumber(alpha / (alpha + beta), 0, 1)
  };
}

function memoryStatusForSkillStatus(status: "candidate" | "active" | "archived"): "activated" | "resolving" | "archived" {
  return memoryStatusForLifecycleStatus(status);
}

function memoryStatusForLifecycleStatus(status: "candidate" | "active" | "archived"): "activated" | "resolving" | "archived" {
  if (status === "archived") return "archived";
  return status === "candidate" ? "resolving" : "activated";
}

function outcomeFromFeedback(feedback: FeedbackRecord): SkillTrialRecord["outcome"] | undefined {
  if (feedback.polarity === "positive" && feedback.magnitude > 0) {
    return "success";
  }
  if (feedback.polarity === "negative" && feedback.magnitude > 0) {
    return "failure";
  }
  return undefined;
}

function polarityFromTurnFeedback(
  feedback: TurnFeedbackClassification
): FeedbackRequest["polarity"] {
  if (feedback.polarity === "positive") return "positive";
  if (feedback.polarity === "negative") return "negative";
  return "neutral";
}

function outcomeFromReward(
  rHuman: number,
  config: { outcomeRTaskSuccessThreshold: number; outcomeRTaskFailureThreshold: number }
): SkillTrialRecord["outcome"] {
  if (rHuman >= config.outcomeRTaskSuccessThreshold) return "success";
  if (rHuman <= config.outcomeRTaskFailureThreshold) return "failure";
  return "unknown";
}

function skillTrialStatusFromOutcome(outcome: SkillTrialRecord["outcome"]): SkillTrialRecord["status"] {
  if (outcome === "success") return "pass";
  if (outcome === "failure" || outcome === "cancelled") return "fail";
  return "unknown";
}

function recallOutcomeFromFeedback(feedback: FeedbackRequest): NonNullable<RecallEventRecord["outcome"]> {
  if (feedback.polarity === "positive") return "positive";
  if (feedback.polarity === "negative") return "negative";
  return "ignored";
}

function renderPolicyBody(draft: Pick<PolicyDraft, "title" | "trigger" | "procedure" | "verification" | "boundary" | "support" | "gain" | "rawGain" | "confidence" | "sourceTraceIds">): string {
  return [
    draft.title,
    `Trigger: ${draft.trigger}`,
    `Procedure: ${draft.procedure}`,
    `Verification: ${draft.verification}`,
    `Boundary: ${draft.boundary}`,
    `Support: ${draft.support}`,
    `Gain: ${roundNumber(draft.gain)}`,
    `Raw gain: ${roundNumber(draft.rawGain)}`,
    `Confidence: ${roundNumber(draft.confidence)}`,
    `Evidence: ${draft.sourceTraceIds.join(", ")}`
  ].join("\n");
}

function stringifyForMemory(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

type InjectedSnippetRefKind = "skill" | "episode" | "trace" | "experience" | "world-model";

interface RenderedInjectedSection {
  refKind: InjectedSnippetRefKind;
  hitId: string;
  section: InjectedContext["sections"][number];
}

const MEMORY_PACKET_MAX_SNIPPET_BODY_CHARS = 640;
const MEMORY_PACKET_SKILL_SUMMARY_CHARS = 200;

interface InjectedRenderOptions {
  contextHints?: Record<string, unknown>;
  query?: string;
  skillInjectionMode?: "summary" | "full";
  skillSummaryChars?: number;
  domain?: "" | "research";
}

function buildInjectedContext(
  hits: RecallHit[],
  budget: number,
  contextMemories: MemoryRow[] = [],
  retrievalMode: RetrievalMode = "search",
  contextHints?: Record<string, unknown>,
  query?: string,
  tuning?: {
    skillInjectionMode?: "summary" | "full";
    skillSummaryChars?: number;
    domain?: "" | "research";
  }
): {
  injectedContext: InjectedContext;
  sourceMemoryIds: string[];
  droppedDueToBudget: Array<{
    id: string;
    kind: MemoryKind;
    memoryLayer: MemoryLayer;
    reason: "token_budget";
    tokenEstimate?: number;
  }>;
} {
  const options: InjectedRenderOptions = {
    contextHints,
    query,
    skillInjectionMode: tuning?.skillInjectionMode ?? "summary",
    skillSummaryChars: tuning?.skillSummaryChars ?? MEMORY_PACKET_SKILL_SUMMARY_CHARS,
    domain: tuning?.domain
  };
  const memoryById = new Map(contextMemories.map((memory) => [memory.id, memory]));
  const rendered = hits.flatMap((hit) => {
    const section = renderInjectedSection(hit, memoryById.get(hit.id), options);
    return section ? [section] : [];
  });
  const memories = isStandaloneMathInjected(options)
    ? suppressLowSpecificityStandaloneMathSections(
        suppressIsolatedMathSkillSections(rendered),
        options.query
      )
    : rendered;

  void budget;
  const sections: InjectedContext["sections"] = memories.map((section) => section.section);
  const renderedSections: RenderedInjectedSection[] = [...memories];
  const sourceMemoryIds: string[] = memories.map((section) => section.hitId);
  const droppedDueToBudget: Array<{
    id: string;
    kind: MemoryKind;
    memoryLayer: MemoryLayer;
    reason: "token_budget";
    tokenEstimate?: number;
  }> = [];
  let used = sections.reduce((sum, section) => sum + (section.tokenEstimate ?? 0), 0);
  const guidance = decisionGuidanceSection(
    contextMemoriesForInjectedSources(contextMemories, sourceMemoryIds)
  );
  if (guidance) {
    const estimate = guidance.tokenEstimate ?? 0;
    sections.push(guidance);
    sourceMemoryIds.push(...guidance.memoryIds);
    used += estimate;
  }

  const markdown = renderInjectedMarkdown(renderedSections, guidance, retrievalMode, options);

  return {
    injectedContext: {
      markdown,
      sections,
      tokenEstimate: used
    },
    sourceMemoryIds: uniq(sourceMemoryIds),
    droppedDueToBudget
  };
}

function renderInjectedSection(
  hit: RecallHit,
  memory: MemoryRow | undefined,
  options: InjectedRenderOptions
): RenderedInjectedSection | null {
  const rendered = renderInjectedSnippet(hit, memory, options);
  if (!rendered) return null;
  const content = rendered.body;
  return {
    refKind: rendered.refKind,
    hitId: hit.id,
    section: {
      id: `memory-${hit.id}`,
      title: rendered.title,
      kind: hit.kind,
      memoryLayer: hit.memoryLayer,
      memoryIds: [hit.id],
      content,
      tokenEstimate: estimateTokens(`${rendered.title}\n${content}`)
    }
  };
}

function renderInjectedSnippet(
  hit: RecallHit,
  memory: MemoryRow | undefined,
  options: InjectedRenderOptions
): { refKind: InjectedSnippetRefKind; title: string; body: string } | null {
  if (hit.kind === "skill" || hit.memoryLayer === "Skill") {
    const skill = memory ? skillMetaFromMemory(memory) : null;
    const name = skill?.name || hit.title || "Skill";
    const guide = skill?.invocationGuide || hit.snippet;
    const summaryChars = options.skillSummaryChars ?? MEMORY_PACKET_SKILL_SUMMARY_CHARS;
    if (options.skillInjectionMode === "full") {
      return {
        refKind: "skill",
        title: "Skill",
        body: truncateInjectedSnippet([
          `id: ${hit.id}`,
          "",
          ...labeledInjectedBlock("Name", name),
          "",
          ...labeledInjectedBlock("Guide", guide.trim() || "(not provided)")
        ].join("\n"))
      };
    }
    const lines = [
      `id: ${hit.id}`,
      "",
      ...labeledInjectedBlock("Name", name),
      "",
      ...labeledInjectedBlock("Description", firstLineSummary(guide, summaryChars) || "(not provided)")
    ];
    return {
      refKind: "skill",
      title: "Skill",
      body: lines.join("\n")
    };
  }

  if (hit.source === "episode") {
    return {
      refKind: "episode",
      title: "Episode",
      body: truncateInjectedSnippet(renderInjectedEpisodeBody(hit))
    };
  }

  if (hit.kind === "trace" || hit.memoryLayer === "L1") {
    const trace = memory ? traceMetaFromMemory(memory) : null;
    if (!trace) return null;
    return {
      refKind: "trace",
      title: "Trace",
      body: truncateInjectedSnippet(renderInjectedTraceBody(hit, trace))
    };
  }

  if (hit.kind === "world_model" || hit.memoryLayer === "L3") {
    const world = memory ? worldModelMetaFromMemory(memory) : null;
    const title = world?.title || hit.title || "World model";
    const body = world?.body || hit.snippet;
    return {
      refKind: "world-model",
      title: "Environment Knowledge",
      body: truncateInjectedSnippet([
        `id: ${hit.id}`,
        "",
        ...labeledInjectedBlock("Title", title),
        "",
        ...labeledInjectedBlock("Content", body)
      ].join("\n"))
    };
  }

  const policy = memory ? policyMetaFromMemory(memory) : null;
  const parts = policy ? [
    `id: ${hit.id}`,
    "",
    ...labeledInjectedBlock("Use", renderInjectedExperienceUseHint(policy)),
    "",
    ...labeledInjectedBlock("Trigger", policy.trigger || "(not provided)"),
    "",
    ...labeledInjectedBlock("Guidance", policy.procedure || hit.snippet),
    ...(policy.decisionGuidance.antiPattern.length > 0
      ? ["", ...labeledInjectedBlock("Avoid", policy.decisionGuidance.antiPattern.join("; "))]
      : []),
    ...(policy.boundary ? ["", ...labeledInjectedBlock("Scope", policy.boundary)] : []),
    ...(policy.verification ? ["", ...labeledInjectedBlock("Check", policy.verification)] : [])
  ] : [
    `id: ${hit.id}`,
    "",
    ...labeledInjectedBlock("Guidance", hit.snippet)
  ];
  return {
    refKind: "experience",
    title: "Experience",
    body: truncateInjectedSnippet(parts.join("\n") || hit.snippet)
  };
}

function renderInjectedExperienceUseHint(policy: NonNullable<ReturnType<typeof policyMetaFromMemory>>): string {
  if (policy.experienceType === "failure_avoidance" || policy.evidencePolarity === "negative") {
    return "Use as a guardrail before planning.";
  }
  if (policy.experienceType === "repair_instruction") {
    return "Use as repair guidance before choosing the next action.";
  }
  if (policy.experienceType === "verifier_feedback") {
    return "Use as a verification checklist before finalizing.";
  }
  if (policy.experienceType === "preference") {
    return "Use as a user preference when applicable.";
  }
  return "Use as prior successful guidance when the current task matches.";
}

function renderInjectedTraceBody(hit: RecallHit, trace: TraceMeta): string {
  return [
    `id: ${hit.id}`,
    `timestamp: ${formatInjectedTimestamp(trace.ts, hit.updatedAt)}`,
    "",
    ...labeledInjectedBlock("Historical user statement", trace.userText || "(empty)"),
    "",
    ...labeledInjectedBlock("Historical assistant response", trace.agentText || "(empty)")
  ].join("\n");
}

function renderInjectedEpisodeBody(hit: RecallHit): string {
  return [
    `id: ${hit.id}`,
    `timestamp: ${formatInjectedTimestamp(undefined, hit.updatedAt)}`,
    "",
    stripInternalReflectionLines(stripEpisodePromptMetrics(hit.snippet))
  ].filter(Boolean).join("\n");
}

function labeledInjectedBlock(label: string, value: string): string[] {
  const body = value.trim();
  return [`${label}:`, body || "(empty)"];
}

function renderInjectedMarkdown(
  sections: RenderedInjectedSection[],
  guidance: InjectedContext["sections"][number] | undefined,
  retrievalMode: RetrievalMode,
  options: InjectedRenderOptions
): string {
  const standaloneMathFinalAnswer = isStandaloneMathInjected(options);
  const taskProtocol = injectedTaskProtocol(options.query);
  if (sections.length === 0 && !guidance && !standaloneMathFinalAnswer && !taskProtocol) return "";
  const parts: string[] = [];
  const header = injectedHeaderForMode(retrievalMode, standaloneMathFinalAnswer, Boolean(taskProtocol));
  if (header) parts.push(header);
  if (taskProtocol) {
    parts.push(taskProtocol);
  } else if (standaloneMathFinalAnswer) {
    parts.push(renderMathFinalAnswerProtocol(options.query));
  }
  const skills = sections.filter((section) => section.refKind === "skill");
  const episodes = sections.filter((section) => section.refKind === "episode");
  const traces = sections.filter((section) => section.refKind === "trace");
  const experiences = sections.filter((section) => section.refKind === "experience");
  const worlds = sections.filter((section) => section.refKind === "world-model");

  parts.push(...renderInjectedMemoriesSection(traces, episodes));

  if (experiences.length > 0) {
    parts.push("## L2 Experience Memories\n");
    experiences.forEach((section, index) => {
      parts.push(renderNumberedInjectedSection(section, index + 1));
    });
  }

  if (worlds.length > 0) {
    parts.push("## L3 Environment Knowledge\n");
    worlds.forEach((section, index) => {
      parts.push(renderNumberedInjectedSection(section, index + 1));
    });
  }

  if (skills.length > 0) {
    if (standaloneMathFinalAnswer) {
      parts.push("## Candidate method memories\n");
    } else {
      parts.push("## Skill Memories\n");
    }
    skills.forEach((section, index) => {
      parts.push(renderNumberedInjectedSection(section, index + 1));
    });
  }

  if (guidance) parts.push(standaloneMathFinalAnswer ? mathDecisionGuidance(guidance) : guidance.content);
  const footer = injectedFooterFor(sections, options.skillInjectionMode ?? "summary", standaloneMathFinalAnswer);
  if (footer) parts.push(footer);
  return prependResearchPlaybook(parts.join("\n\n"), options.domain);
}

const RESEARCH_RETRIEVAL_PLAYBOOK = `## Research retrieval playbook

Use this mode for research questions with multiple clues, indirect references, hidden candidates, or partial-match risk. Search or inspect sources to surface candidate answers, verify them against each constraint, and return the requested answer slot.

### 1. Hypothesize first, then verify by name
- Before your first search call, write a short numbered list of plausible candidate entities when you can name any.
- Probe candidates by name plus one distinguishing term.
- Treat source snippets as stronger evidence than prior guesses.

### 2. Decompose constraints
- Split the question into concrete nouns, dates, places, awards, numbers, roles, or titles.
- Keep searches short and search major clues separately.
- Intersect results across clues instead of relying on a single long query.

### 3. Pivot deliberately
- If two queries are irrelevant, switch to a different clue or candidate-name probe.
- Lead with rare terms and exact names when available.

### 4. Verify before answering
- Cross-check the final candidate against every important constraint.
- If full verification is impossible, commit to the best-supported specific answer and make the evidence limits clear.`;

function prependResearchPlaybook(markdown: string, domain?: string): string {
  if (!isResearchDomain(domain)) return markdown;
  const body = markdown.trim();
  return body ? `${RESEARCH_RETRIEVAL_PLAYBOOK}\n\n${body}` : RESEARCH_RETRIEVAL_PLAYBOOK;
}

function renderInjectedMemoriesSection(
  traces: RenderedInjectedSection[],
  episodes: RenderedInjectedSection[]
): string[] {
  if (episodes.length === 0 && traces.length === 0) return [];
  const parts: string[] = [];
  if (traces.length > 0) {
    parts.push("## L1 Trace Memories");
    traces.forEach((section, index) => {
      parts.push(renderNumberedInjectedSection(section, index + 1));
    });
  }
  if (episodes.length > 0) {
    parts.push("## Similar Past Episodes");
    episodes.forEach((section, index) => {
      parts.push(renderNumberedInjectedSection(section, index + 1));
    });
  }
  return parts;
}

function renderNumberedInjectedSection(section: RenderedInjectedSection, index: number): string {
  const title = section.section.title || section.hitId;
  const body = stripRedundantInjectedTitle(title, section.section.content, section.refKind);
  return indentInjectedBlock([`${index}. ${title}`, body].filter(Boolean).join("\n"));
}

function injectedHeaderForMode(mode: RetrievalMode, standaloneMathFinalAnswer = false, taskProtocol = false): string {
  if (taskProtocol) {
    return "# Current task protocol and recalled memories\n\n" +
      "IMPORTANT: The task protocol below is derived from the current user prompt, not from previous conversations.\n" +
      "Treat it as current execution guidance. Any recalled memories that follow are advisory; verify them against the current prompt and repository before using them.";
  }
  if (standaloneMathFinalAnswer) {
    if (mode === "turn_start") {
      return "# Retrieved prior problem-solving memories\n\n" +
        "These are candidate methods and guidance learned from previous tasks, not facts about the current problem.\n" +
        "Use them only when their assumptions match the original problem statement; ignore mismatched memories.";
    }
    return "# Memory search results\n\n" +
      "The memory tool returned candidate methods and prior examples. Verify fit before using them.";
  }
  if (mode === "turn_start") return "";
  if (mode === "skill_invoke") {
    return "# Invoked skill\n\n" +
      "Follow the procedure below; the verification step tells you when you're done.";
  }
  if (mode === "sub_agent") {
    return "# Parent-agent context\n\n" +
      "Relevant memory surfaced for this sub-agent's mission.";
  }
  if (mode === "decision_repair") {
    return "# Decision repair — please read before your next action\n\n" +
      "You have failed this tool multiple times in a row. Below are preferred / avoided actions\n" +
      "distilled from similar past situations. Please adapt your plan accordingly.";
  }
  return "";
}

function isStandaloneMathInjected(options: InjectedRenderOptions): boolean {
  return options.contextHints?.taskKind === STANDALONE_MATH_FINAL_ANSWER_TASK_KIND ||
    isStandaloneMathFinalAnswerTask(options.query);
}

function injectedTaskProtocol(query: string | undefined): string | null {
  if (!isRepositoryRepairPrompt(query)) return null;
  return renderRepositoryRepairProtocol(query);
}

function suppressIsolatedMathSkillSections(sections: RenderedInjectedSection[]): RenderedInjectedSection[] {
  const skills = sections.filter((section) => section.refKind === "skill");
  if (skills.length !== 1) return sections;
  const onlySkill = skills[0];
  if (onlySkill && shouldKeepIsolatedMathSkillSection(onlySkill)) return sections;
  const hasGrounding = sections.some((section) =>
    section.refKind === "trace" || section.refKind === "episode" || section.refKind === "experience"
  );
  if (hasGrounding) return sections;
  return sections.filter((section) => section.refKind !== "skill");
}

function shouldKeepIsolatedMathSkillSection(section: RenderedInjectedSection): boolean {
  const text = `${section.section.title}\n${firstLineSummary(section.section.content, 700)}`.toLowerCase();
  const isGeometryScaffold =
    /\b(geometry|triangle|circle|angle|circumcenter|incenter|barycentric)\b/.test(text) &&
    /\b(set\s*up|setup|coordinate|coordinates|place|placing|align|axis|origin|model)\b/.test(text);
  if (!isGeometryScaffold) return false;
  return !/\b(count|compute|sum|probability|expected|recurrence|polynomial|permutation|sequence)\b/.test(text);
}

function suppressLowSpecificityStandaloneMathSections(
  sections: RenderedInjectedSection[],
  taskText: string | undefined
): RenderedInjectedSection[] {
  const taskTerms = extractSpecificMathTerms(taskText ?? "");
  return sections.filter((section) => {
    if (section.refKind === "trace" || section.refKind === "episode" || section.refKind === "experience") {
      return hasEnoughStandaloneMathOverlap(sectionTextForSpecificity(section), taskTerms, 2);
    }
    if (section.refKind === "world-model") {
      return hasEnoughStandaloneMathOverlap(sectionTextForSpecificity(section), taskTerms, 3);
    }
    if (section.refKind === "skill") {
      if (shouldKeepIsolatedMathSkillSection(section)) return true;
      return hasEnoughStandaloneMathOverlap(sectionTextForSpecificity(section), taskTerms, 2);
    }
    return true;
  });
}

function hasEnoughStandaloneMathOverlap(
  candidateText: string,
  taskTerms: ReadonlySet<string>,
  minOverlap: number
): boolean {
  if (taskTerms.size === 0) {
    return !isGenericStandaloneMathMemory(candidateText);
  }
  const candidateTerms = extractSpecificMathTerms(candidateText);
  let overlap = 0;
  for (const term of candidateTerms) {
    if (!taskTerms.has(term)) continue;
    overlap += 1;
    if (overlap >= minOverlap) return true;
  }
  return false;
}

function sectionTextForSpecificity(section: RenderedInjectedSection): string {
  return `${section.section.title}\n${section.section.content}\n${section.section.memoryLayer}\n${section.section.kind}`;
}

function isGenericStandaloneMathMemory(text: string): boolean {
  const normalized = text.toLowerCase();
  return [
    /\b(?:math(?:ematical)?|olympiad|contest|competition)(?:[-\s]+(?:style|level|type))?[-\s]+(?:problem|task)s?\b/,
    /\bsolution\s+to\s+(?:a\s+|the\s+)?(?:math(?:ematical)?|olympiad|contest|competition)(?:[-\s]+(?:problem|task))?\b/,
    /\banaly[sz]e the problem step-by-step\b/,
    /\bprovide the final answer\b/,
    /\bensuring logical consistency\b/,
    /\bmathematical problem-solving environment\b/,
    /\bcompetition tasks\b/
  ].some((pattern) => pattern.test(normalized));
}

function extractSpecificMathTerms(text: string): Set<string> {
  const normalized = text.toLowerCase();
  const words = normalized.match(/[a-z0-9]{3,}|[\u4e00-\u9fff]{2,}/g) ?? [];
  return new Set(words.filter((word) =>
    !MATH_SPECIFICITY_STOPWORDS.has(word) &&
    !/^\d+$/.test(word)
  ));
}

const MATH_SPECIFICITY_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "problem",
  "solution",
  "answer",
  "math",
  "mathematical",
  "prove",
  "compute",
  "find",
  "show",
  "given",
  "using",
  "步骤",
  "答案",
  "问题",
  "数学",
  "求解",
  "证明"
]);

function mathDecisionGuidance(guidance: InjectedContext["sections"][number]): string {
  return guidance.content
    .replace("## Decision guidance (distilled from past similar situations)", "## Method guidance (distilled from past similar math tasks)")
    .replace(
      "Apply these BEFORE choosing your next action. Each line was learned\nfrom one or more past episodes where the user told us what to prefer\nor avoid in this kind of context.",
      "Treat these as advisory heuristics, not facts about the current problem.\nApply a line only after it matches the original problem constraints."
    );
}

function injectedFooterFor(
  sections: RenderedInjectedSection[],
  skillMode: "summary" | "full",
  standaloneMathFinalAnswer = false
): string {
  if (standaloneMathFinalAnswer) {
    return [
      "MemOS memory tools remain available when a concrete prior method is needed.",
      "Do not call them merely to browse when the original problem can be solved directly."
    ].join("\n");
  }
  if (sections.length > 0 && sections.every((section) => section.refKind === "trace")) {
    return "";
  }
  void skillMode;
  return [
    "## Follow-up memory tools",
    "",
    "If details are needed, use `memmy_memory_get(id)` with one of the ids above.",
    "Use `memmy_memory_search(query)` only when the recalled memory is insufficient or ambiguous."
  ].join("\n");
}

function firstLineSummary(guide: string, maxChars: number): string {
  const trimmed = guide.trim();
  if (!trimmed) return "";
  const paragraph = trimmed.split(/\n\s*\n/)[0] ?? trimmed;
  const cleaned = paragraph
    .split("\n")
    .map((line) => line.replace(/^\s*#+\s*/, "").trim())
    .filter(Boolean)
    .join(" ");
  return cleaned.length <= maxChars ? cleaned : `${cleaned.slice(0, maxChars - 1)}…`;
}

function truncateInjectedSnippet(value: string): string {
  if (value.length <= MEMORY_PACKET_MAX_SNIPPET_BODY_CHARS) return value;
  const head = value.slice(0, MEMORY_PACKET_MAX_SNIPPET_BODY_CHARS - 16);
  return `${head}\n...[truncated]`;
}

function stripEpisodePromptMetrics(summary: string): string {
  return summary
    .replace(
      /^episode\s+\d+\s+steps\s*·\s*best\s+V=[+-]?\d+(?:\.\d+)?\s*·\s*goal-sim=[+-]?\d+(?:\.\d+)?\s*\n?/i,
      ""
    )
    .replace(/^Past similar episode\s*\n?/i, "")
    .replace(/\bstep\s+(\d+)\s+\(V=[+-]?\d+(?:\.\d+)?\)/gi, "step $1")
    .trim();
}

function stripInternalReflectionLines(value: string): string {
  return value
    .split("\n")
    .filter((line) => {
      const match = line.match(/^\s*reflection:\s*(.+?)\s*$/i);
      return !match || Boolean(displayReflectionText(match[1]));
    })
    .join("\n")
    .trim();
}

function formatInjectedTimestamp(traceTs?: number, updatedAt?: string): string {
  if (Number.isFinite(traceTs)) return new Date(traceTs!).toISOString();
  const parsed = updatedAt ? Date.parse(updatedAt) : NaN;
  return new Date(Number.isFinite(parsed) ? parsed : Date.now()).toISOString();
}

function stripRedundantInjectedTitle(
  title: string,
  body: string,
  refKind: InjectedSnippetRefKind
): string {
  const normalizedTitle = normalizeInjectedLabel(title);
  return body
    .split("\n")
    .filter((line) => {
      const nameMatch = line.match(/^Name:\s*(.+)\s*$/i);
      if (nameMatch && normalizeInjectedLabel(nameMatch[1]!) === normalizedTitle) return false;
      if (refKind === "experience") {
        const triggerMatch = line.match(/^Trigger:\s*(.+)\s*$/i);
        if (triggerMatch && normalizeInjectedLabel(triggerMatch[1]!) === normalizedTitle) return false;
      }
      return true;
    })
    .join("\n")
    .trim();
}

function normalizeInjectedLabel(value: string): string {
  return value.trim().toLowerCase();
}

function indentInjectedBlock(value: string): string {
  return value
    .split("\n")
    .map((line) => (line ? `   ${line}` : line))
    .join("\n")
    .replace(/^ {3}/, "");
}

function contextMemoriesForInjectedSources(memories: MemoryRow[], sourceMemoryIds: string[]): MemoryRow[] {
  const visibleIds = new Set(sourceMemoryIds);
  const visibleEpisodeIds = new Set<string>();
  const legacySkillSourcePolicyIds = new Set<string>();
  for (const id of sourceMemoryIds) {
    if (readableMemoryIdKind(id) === "episode") visibleEpisodeIds.add(id);
  }
  for (const memory of memories) {
    if (!visibleIds.has(memory.id)) continue;
    if (memory.memoryLayer === "L1") {
      const trace = traceMetaFromMemory(memory);
      if (trace?.episodeId) visibleEpisodeIds.add(trace.episodeId);
    }
    for (const policyId of sourcePolicyIdsForLegacySkillGuidance(memory)) {
      legacySkillSourcePolicyIds.add(policyId);
    }
  }
  return memories.filter((memory) => {
    if (visibleIds.has(memory.id)) return true;
    if (memory.memoryLayer !== "L2") return false;
    const policy = policyMetaFromMemory(memory);
    if (!policy || !policyHasDecisionGuidance(policy)) return false;
    if (legacySkillSourcePolicyIds.has(memory.id)) return true;
    return policy.sourceTraceIds.some((id) => visibleIds.has(id)) ||
      policy.sourceEpisodeIds.some((id) => visibleEpisodeIds.has(id));
  });
}

function contextMemoriesForRecallHits(hits: RecallHit[], memories: MemoryRow[]): MemoryRow[] {
  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  const selected = new Map<string, MemoryRow>();
  const hitTraceIds = new Set<string>();
  const hitEpisodeIds = new Set<string>();
  const legacySkillSourcePolicyIds = new Set<string>();
  for (const hit of hits) {
    if (readableMemoryIdKind(hit.id) === "episode") hitEpisodeIds.add(hit.id);
    const memory = byId.get(hit.id);
    if (!memory) continue;
    selected.set(memory.id, memory);
    if (memory.memoryLayer === "L1") {
      hitTraceIds.add(memory.id);
      const trace = traceMetaFromMemory(memory);
      if (trace?.episodeId) hitEpisodeIds.add(trace.episodeId);
    }
    for (const policyId of sourcePolicyIdsForLegacySkillGuidance(memory)) {
      legacySkillSourcePolicyIds.add(policyId);
    }
  }
  for (const memory of memories) {
    if (memory.memoryLayer !== "L2") continue;
    const policy = policyMetaFromMemory(memory);
    if (!policy || !policyHasDecisionGuidance(policy)) continue;
    const traceOverlap = policy.sourceTraceIds.some((id) => hitTraceIds.has(id));
    const episodeOverlap = policy.sourceEpisodeIds.some((id) => hitEpisodeIds.has(id));
    const legacySkillFallback = legacySkillSourcePolicyIds.has(memory.id);
    if (traceOverlap || episodeOverlap || legacySkillFallback || hits.some((hit) => hit.id === memory.id)) {
      selected.set(memory.id, memory);
    }
  }
  return [...selected.values()];
}

function decisionGuidanceSection(memories: MemoryRow[]): InjectedContext["sections"][number] | undefined {
  const preference = new Map<string, { text: string; sourceIds: Set<string> }>();
  const antiPattern = new Map<string, { text: string; sourceIds: Set<string> }>();
  for (const memory of memories) {
    const guidance = decisionGuidanceFromMemory(memory);
    for (const item of guidance.preference) {
      addDecisionGuidanceLine(preference, item, memory.id);
    }
    for (const item of guidance.antiPattern) {
      addDecisionGuidanceLine(antiPattern, item, memory.id);
    }
  }
  const preferEntries = rankedDecisionGuidanceLines(preference).slice(0, 3);
  const avoidEntries = rankedDecisionGuidanceLines(antiPattern).slice(0, 3);
  const preferLines = preferEntries.map((entry) => entry.text);
  const avoidLines = avoidEntries.map((entry) => entry.text);
  if (preferLines.length === 0 && avoidLines.length === 0) return undefined;
  const memoryIds = new Set<string>();
  for (const entry of [...preferEntries, ...avoidEntries]) {
    for (const id of entry.sourceIds) {
      memoryIds.add(id);
    }
  }
  const contentLines = [
    "## Decision guidance (distilled from past similar situations)",
    "",
    "Apply these BEFORE choosing your next action. Each line was learned",
    "from one or more past episodes where the user told us what to prefer",
    "or avoid in this kind of context."
  ];
  if (preferLines.length > 0) {
    contentLines.push("", "**Prefer**");
    preferLines.forEach((item, index) => {
      contentLines.push(`  ${index + 1}. ${item}`);
    });
  }
  if (avoidLines.length > 0) {
    contentLines.push("", "**Avoid**");
    avoidLines.forEach((item, index) => {
      contentLines.push(`  ${index + 1}. ${item}`);
    });
  }
  const content = contentLines.join("\n");
  return {
    id: "decision-guidance",
    title: "Decision guidance",
    kind: "policy",
    memoryLayer: "L2",
    memoryIds: [...memoryIds],
    content,
    tokenEstimate: estimateTokens(content)
  };
}

function addDecisionGuidanceLine(
  into: Map<string, { text: string; sourceIds: Set<string> }>,
  raw: string,
  sourceId: string
): void {
  const text = clip(singleLine(raw), 220);
  const key = decisionGuidanceKey(text);
  if (!key) return;
  const existing = into.get(key);
  if (existing) {
    existing.sourceIds.add(sourceId);
    return;
  }
  into.set(key, {
    text,
    sourceIds: new Set([sourceId])
  });
}

function rankedDecisionGuidanceLines(
  lines: Map<string, { text: string; sourceIds: Set<string> }>
): Array<{ text: string; sourceIds: Set<string> }> {
  return [...lines.values()].sort((a, b) =>
    b.sourceIds.size - a.sourceIds.size ||
    a.text.localeCompare(b.text)
  );
}

function decisionGuidanceKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.。!！?？,，;；:：]+$/g, "")
    .trim();
}

function decisionGuidanceFromMemory(memory: MemoryRow): { preference: string[]; antiPattern: string[] } {
  if (memory.memoryLayer === "L2") {
    const policy = policyMetaFromMemory(memory);
    return {
      preference: policy?.decisionGuidance.preference ?? [],
      antiPattern: policy?.decisionGuidance.antiPattern ?? []
    };
  }
  if (memory.memoryLayer === "Skill") {
    const skill = isRecord(memory.properties.internal_info.skill)
      ? memory.properties.internal_info.skill
      : {};
    const procedure = isRecord(skill.procedure_json)
      ? skill.procedure_json
      : isRecord(memory.properties.internal_info.procedure_json)
      ? memory.properties.internal_info.procedure_json
      : {};
    const guidance = isRecord(procedure.decisionGuidance)
      ? procedure.decisionGuidance
      : isRecord(procedure.decision_guidance)
      ? procedure.decision_guidance
      : {};
    return {
      preference: stringArray(guidance.preference),
      antiPattern: stringArray(guidance.antiPattern ?? guidance.anti_pattern)
    };
  }
  return { preference: [], antiPattern: [] };
}

function policyHasDecisionGuidance(policy: PolicyMeta): boolean {
  return policy.decisionGuidance.preference.length > 0 || policy.decisionGuidance.antiPattern.length > 0;
}

function sourcePolicyIdsForLegacySkillGuidance(memory: MemoryRow): string[] {
  if (memory.memoryLayer !== "Skill") return [];
  const guidance = decisionGuidanceFromMemory(memory);
  if (guidance.preference.length > 0 || guidance.antiPattern.length > 0) return [];
  return skillMetaFromMemory(memory)?.sourcePolicyIds ?? [];
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function emptyInjectedContext(): InjectedContext {
  return {
    markdown: "",
    sections: [],
    tokenEstimate: 0
  };
}

function searchCandidateFromHit(hit: RecallHit, memory?: MemoryRow): Record<string, unknown> {
  const formatted = renderInjectedSnippet(hit, memory, {
    skillInjectionMode: "summary",
    skillSummaryChars: MEMORY_PACKET_SKILL_SUMMARY_CHARS
  });
  return {
    refKind: hit.kind,
    refId: hit.id,
    score: hit.score,
    content: formatted?.body ?? "",
    snippet: hit.snippet,
    summary: hit.title,
    origin: hit.source,
    tier: hit.memoryLayer
  };
}

function episodeDetailItem(
  episode: EpisodeRecord,
  timeline: EpisodeTimelineDetail,
  sourceMemoryIds: string[],
  refs: Record<string, unknown>
): EpisodeDetailItem {
  const firstUserText = timeline.rawTurns
    ?.map((turn) => turn.userText?.trim())
    .find((text): text is string => Boolean(text));
  const title = truncateDetailTitle(episode.title ?? firstLine(firstUserText ?? episode.summary ?? "") ?? episode.id);
  const summary = episode.summary ??
    firstLine(firstUserText ?? "") ??
    `${timeline.items.length} memory item(s), ${timeline.rawTurns?.length ?? 0} raw turn(s)`;
  const version = Math.max(1, episode.turnCount, sourceMemoryIds.length, timeline.rawTurns?.length ?? 0);
  return {
    id: episode.id,
    kind: "episode",
    memoryLayer: "Episode",
    status: episode.status,
    title,
    summary,
    tags: ["episode", episode.status],
    updatedAt: episode.updatedAt,
    version,
    body: renderEpisodeDetailBody(episode, timeline, title),
    createdAt: episode.openedAt,
    sourceMemoryIds,
    metadata: {
      episode,
      timeline: {
        memoryCount: timeline.items.length,
        rawTurnCount: timeline.rawTurns?.length ?? 0,
        traceMemoryIds: episode.l1MemoryIds,
        policyMemoryIds: episode.l2PolicyIds,
        worldModelMemoryIds: episode.l3WorldModelIds,
        skillMemoryIds: episode.skillMemoryIds
      },
      refs
    },
    timeline
  };
}

function renderEpisodeDetailBody(
  episode: EpisodeRecord,
  timeline: EpisodeTimelineDetail,
  title: string
): string {
  const lines = [
    `Episode: ${title}`,
    `Status: ${episode.status}`,
    typeof episode.rTask === "number" ? `Reward: ${episode.rTask}` : "",
    `Raw turns: ${timeline.rawTurns?.length ?? 0}`,
    `Memory timeline items: ${timeline.items.length}`
  ].filter(Boolean);
  if (timeline.rawTurns?.length) {
    lines.push("", "Raw turn details:");
    timeline.rawTurns.forEach((turn, index) => {
      lines.push(`${index + 1}. ${turn.turnId}`);
      if (turn.userText) lines.push(`   user: ${truncateEpisodeLine(turn.userText)}`);
      if (turn.assistantText) lines.push(`   assistant: ${truncateEpisodeLine(turn.assistantText)}`);
      if (turn.toolCalls?.length) lines.push(`   toolCalls: ${turn.toolCalls.length}`);
      if (turn.toolResults?.length) lines.push(`   toolResults: ${turn.toolResults.length}`);
    });
  }
  if (timeline.items.length) {
    lines.push("", "Related memories:");
    timeline.items.forEach((item, index) => {
      lines.push(`${index + 1}. [${item.memoryLayer}] ${item.id} - ${truncateEpisodeLine(item.title || item.summary, 160)}`);
    });
  }
  return lines.join("\n");
}

function truncateEpisodeLine(value: string, maxChars = 220): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length <= maxChars ? cleaned : `${cleaned.slice(0, maxChars - 3)}...`;
}

function panelListItemFromMemory(
  item: MemoryListItem,
  memory: MemoryRow,
  processing?: MemoryProcessingRecord
): MemoryListItem {
  return {
    ...item,
    processing,
    metadata: {
      ...(item.metadata ?? {}),
      source: panelSourceForMemory(memory)
    },
    tags: panelTagsForMemory(memory, processing)
  };
}

function detailFromMemory(memory: MemoryRow, processing?: MemoryProcessingRecord): MemoryDetailItem {
  const sourceMemoryIds = memory.properties.internal_info.source_memory_ids;
  const source = panelSourceForMemory(memory);
  return {
    id: memory.id,
    kind: kindFromMemory(memory),
    memoryLayer: memory.memoryLayer,
    status: memory.status,
    title: detailTitleForMemory(memory),
    summary: detailSummaryForMemory(memory),
    tags: panelTagsForMemory(memory, processing),
    updatedAt: memory.updatedAt,
    version: memory.version,
    processing,
    body: memory.memoryValue,
    createdAt: memory.createdAt,
    sourceMemoryIds: stringArray(sourceMemoryIds),
    metadata: {
      source,
      info: memory.info,
      properties: memory.properties
    }
  };
}

function detailTitleForMemory(memory: MemoryRow): string {
  const trace = traceMetaFromMemory(memory);
  const policy = policyMetaFromMemory(memory);
  const worldModel = worldModelMetaFromMemory(memory);
  const skill = skillMetaFromMemory(memory);
  const title = firstDetailDisplayString(
    stringFromMaybeRecord(memory.info, "title"),
    stringFromMaybeRecord(memory.properties.internal_info, "title"),
    trace?.summary,
    policy?.title,
    worldModel?.title,
    skill?.name,
    firstReadableDetailMemoryLine(memory.memoryValue),
    isInternalMemoryKeyForDisplay(memory.memoryKey) ? undefined : memory.memoryKey
  );

  return truncateDetailTitle(title ?? memory.id);
}

function detailSummaryForMemory(memory: MemoryRow): string {
  const trace = traceMetaFromMemory(memory);
  const policy = policyMetaFromMemory(memory);
  const worldModel = worldModelMetaFromMemory(memory);
  const skill = skillMetaFromMemory(memory);
  return firstDetailDisplayString(
    stringFromMaybeRecord(memory.info, "summary"),
    stringFromMaybeRecord(memory.properties.internal_info, "summary"),
    trace?.summary,
    policy?.trigger,
    policy?.procedure,
    worldModel?.body,
    worldModel?.title,
    skill?.invocationGuide,
    firstReadableDetailMemoryLine(memory.memoryValue),
    firstLine(memory.memoryValue)
  ) ?? "";
}

function firstDetailDisplayString(...values: Array<string | undefined | null>): string | undefined {
  return values
    .map(cleanDetailDisplayText)
    .find((value): value is string => Boolean(value && !isWorldSectionHeadingForDisplay(value) && !isInternalMemoryKeyForDisplay(value)));
}

function firstReadableDetailMemoryLine(value: string): string | undefined {
  return value
    .split(/\r?\n/)
    .map(cleanDetailDisplayText)
    .find((line): line is string => Boolean(line && !isWorldSectionHeadingForDisplay(line) && !isInternalMemoryKeyForDisplay(line)));
}

function cleanDetailDisplayText(value?: string | null): string | undefined {
  const text = (value ?? "")
    .replace(/^\s*Summary:\s*/i, "")
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/^\s*[-*]\s+/, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .trim();
  return text || undefined;
}

function isWorldSectionHeadingForDisplay(value: string): boolean {
  return /^(Environment|Inference|Constraints|Environment Knowledge|环境|环境拓扑|行为规律|约束禁忌|结构化认知)$/i.test(value.trim());
}

function isInternalMemoryKeyForDisplay(value?: string | null): boolean {
  return Boolean(value && /^(trace|policy|world|world_model|skill)[:_]/i.test(value.trim()));
}

function truncateDetailTitle(value: string): string {
  return value.length <= 80 ? value : `${value.slice(0, 77)}...`;
}

function memoryDetailWithLayerPayload(detail: MemoryDetailItem, memory: MemoryRow): MemoryDetailItem & Record<string, unknown> {
  const item: MemoryDetailItem & Record<string, unknown> = { ...detail };
  if (memory.memoryLayer === "L1") {
    const trace = traceMetaFromMemory(memory);
    const tracePayload = {
      episodeId: trace?.episodeId ?? stringFromMaybeRecord(memory.info, "episode_id") ?? "",
      rawTurnId: rawTurnIdFromMemory(memory) ?? "",
      turnId: trace?.turnId ?? stringFromMaybeRecord(memory.info, "turn_id") ?? ""
    };
    if (tracePayload.episodeId && tracePayload.rawTurnId && tracePayload.turnId) {
      item.trace = tracePayload;
    }
  } else if (memory.memoryLayer === "L2") {
    const policy = policyMetaFromMemory(memory);
    item.policy = {
      utilityScore: policy?.gain,
      confidence: policy?.confidence,
      evidenceMemoryIds: policy?.sourceTraceIds ?? sourceMemoryIdsFromMemory(memory),
      repairHints: policy?.verification ? [policy.verification] : []
    };
  } else if (memory.memoryLayer === "L3") {
    const worldModel = worldModelMetaFromMemory(memory);
    item.worldModel = {
      sourceMemoryIds: worldModel?.policyIds ?? sourceMemoryIdsFromMemory(memory),
      confidence: worldModel?.confidence
    };
  } else if (memory.memoryLayer === "Skill") {
    const skill = skillMetaFromMemory(memory);
    item.skill = {
      invocationGuide: skill?.invocationGuide ?? detail.body,
      procedure: procedureFromSkillMemory(memory),
      sourcePolicyIds: skill?.sourcePolicyIds ?? [],
      sourceWorldModelIds: skill?.sourceWorldModelIds ?? [],
      reliabilityScore: skill?.eta,
      utilityScore: skill?.eta,
      evidenceCount: skill?.evidenceAnchorIds.length
    };
  }
  return item;
}

function memoryEtag(memory: MemoryRow): string {
  return `${memory.id}-v${memory.version}`;
}

function sourceMemoryIdsFromMemory(memory: MemoryRow): string[] {
  return stringArrayFromInternal(memory, "source_memory_ids")
    .concat(stringArrayFromInternal(memory, "source_l1_memory_ids"))
    .concat(stringArrayFromInternal(memory, "source_policy_ids"))
    .concat(stringArrayFromInternal(memory, "evidence_anchor_ids"));
}

function memoryMatchesTags(memory: MemoryRow, tags: string[] | undefined): boolean {
  const requested = (tags ?? [])
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
  if (requested.length === 0) return true;
  const memoryTags = new Set(memory.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean));
  return requested.every((tag) => memoryTags.has(tag));
}

function emptyRetrievalResult(): RetrievalResult {
  return {
    hits: [],
    debug: {
      tierSizes: { tier1: 0, tier2: 0, tier3: 0 },
      kept: { tier1: 0, tier2: 0, tier3: 0 },
      topRelevance: 0,
      droppedByThreshold: 0
    }
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`operation timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function retrievedMemorySourceIds(memory: MemoryRow): string[] {
  const policy = policyMetaFromMemory(memory);
  const skill = skillMetaFromMemory(memory);
  const worldModel = worldModelMetaFromMemory(memory);
  return [
    memory.id,
    ...sourceMemoryIdsFromMemory(memory),
    ...(policy?.sourceTraceIds ?? []),
    ...(skill?.sourcePolicyIds ?? []),
    ...(skill?.evidenceAnchorIds ?? []),
    ...(worldModel?.policyIds ?? [])
  ];
}

function importedReembedMemoryIds(tables: Record<string, unknown>, currentEmbeddingModel: string): string[] {
  const ids = new Set<string>();
  for (const row of importedMemoryVectors(tables.memory_vectors)) {
    if (shouldReembedImportedVector(row.embedding_model, row.embedding, currentEmbeddingModel)) {
      ids.add(row.memory_id);
    }
  }
  return [...ids];
}

function importedMemoryVectors(value: unknown): SerializedMemoryVector[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!isRecord(item)) throw new Error("memory_vectors rows must be objects");
    const vectorField = item.vector_field;
    if (vectorField !== "vec" && vectorField !== "vec_summary" && vectorField !== "vec_action") {
      throw new Error("memory_vectors.vector_field is invalid");
    }
    if (
      typeof item.memory_id !== "string" ||
      typeof item.embedding !== "string" ||
      typeof item.embedding_dim !== "number" ||
      typeof item.updated_at !== "string"
    ) {
      throw new Error("memory_vectors row is incomplete");
    }
    return {
      memory_id: item.memory_id,
      vector_field: vectorField,
      embedding: item.embedding,
      embedding_model: typeof item.embedding_model === "string" ? item.embedding_model : null,
      embedding_provider: typeof item.embedding_provider === "string" ? item.embedding_provider : null,
      embedding_dim: item.embedding_dim,
      updated_at: item.updated_at
    };
  });
}

function shouldReembedImportedVector(
  embeddingModel: unknown,
  embedding: unknown,
  currentEmbeddingModel: string
): boolean {
  if (typeof embeddingModel === "string" && embeddingModel.trim()) {
    return embeddingModel !== currentEmbeddingModel;
  }
  return embedding !== null && embedding !== undefined;
}

function namespaceIdFromMemory(memory: MemoryRow): string {
  return namespaceIdFromContext(namespaceForMemory(memory));
}

function namespaceIdFromRawTurn(rawTurn: RawTurnRecord): string {
  return namespaceIdFromContext(namespaceForRawTurn(rawTurn));
}

function namespaceIdFromSession(session: SessionRecord): string {
  return namespaceIdFromContext(namespaceForSession(session));
}

function namespaceIdFromContext(namespace: RuntimeNamespace): string {
  return [
    namespace.tenantId,
    namespace.userId,
    namespace.projectId ?? namespace.workspaceId,
    namespace.source,
    namespace.profileId
  ].filter(Boolean).join(":");
}

function scopeBundleTables(
  tables: Record<string, Array<Record<string, unknown>>>,
  namespace: RuntimeNamespace
): Record<string, Array<Record<string, unknown>>> {
  void namespace;
  return tables;
}

function stringArrayFromInternal(memory: MemoryRow, key: string): string[] {
  const value = memory.properties.internal_info[key];
  return stringArray(value);
}

function procedureFromSkillMemory(memory: MemoryRow): string[] | undefined {
  const internal = memory.properties.internal_info;
  const value = internal.procedure_json ?? internal.procedure;
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === "string");
      }
    } catch {
      return value
        .split(/\r?\n/)
        .map((line) => line.replace(/^[-*]\s*/, "").trim())
        .filter(Boolean);
    }
  }
  return undefined;
}

interface SkillUsageStats {
  usageCount: number;
  lastUsedAt?: string;
  pendingTrials: number;
  trialsAttempted: number;
  trialsPassed: number;
  successRate: number;
  betaPosterior: {
    alpha: number;
    beta: number;
    mean: number;
  };
}

function skillListItem(item: MemoryListItem, memory: MemoryRow, usageStats?: SkillUsageStats): MemoryListItem & {
  name: string;
  invocationGuide?: string;
  reliabilityScore?: number;
  usageCount?: number;
  pendingTrials?: number;
  successRate?: number;
  betaPosterior?: {
    alpha: number;
    beta: number;
    mean: number;
  };
  utilityScore?: number;
  evidenceCount?: number;
  lastUsedAt?: string;
} {
  const skill = skillMetaFromMemory(memory);
  return {
    ...item,
    name: skill?.name ?? item.title,
    invocationGuide: skill?.invocationGuide,
    reliabilityScore: skill?.eta,
    usageCount: usageStats?.usageCount,
    pendingTrials: usageStats?.pendingTrials,
    successRate: usageStats?.trialsAttempted ? usageStats.successRate : skill?.successRate,
    betaPosterior: usageStats?.trialsAttempted ? usageStats.betaPosterior : skill?.betaPosterior,
    utilityScore: skill?.eta,
    evidenceCount: skill?.evidenceAnchorIds.length,
    lastUsedAt: usageStats?.lastUsedAt
  };
}

function changeLogToPanelChange(change: ChangeLogRecord): {
  seq: number;
  op: "created" | "updated" | "archived" | "deleted";
  kind: MemoryKind | "session" | "episode" | "job" | "feedback" | "raw_turn" | "repair" | "skill_trial" | "recall" | "artifact";
  id: string;
  version?: number;
  source: "turn_complete" | "feedback" | "worker" | "panel" | "system";
  updatedAt: string;
} {
  return {
    seq: change.seq,
    op: normalizeChangeOp(change.op) ?? changeOp(change.changeType),
    kind: normalizeChangeKind(change.kind) ?? changeKind(change),
    id: change.entityId ?? change.memoryId,
    version: change.version ?? versionFromChange(change),
    source: changeSource(change.source),
    updatedAt: change.createdAt
  };
}

function normalizeChangeOp(value: string | undefined): "created" | "updated" | "archived" | "deleted" | undefined {
  return value === "created" || value === "updated" || value === "archived" || value === "deleted"
    ? value
    : undefined;
}

function normalizeChangeKind(value: string | undefined): MemoryKind | "session" | "episode" | "job" | "feedback" | "raw_turn" | "repair" | "skill_trial" | "recall" | "artifact" | undefined {
  if (
    value === "trace" ||
    value === "policy" ||
    value === "world_model" ||
    value === "skill" ||
    value === "session" ||
    value === "episode" ||
    value === "job" ||
    value === "feedback" ||
    value === "raw_turn" ||
    value === "repair" ||
    value === "skill_trial" ||
    value === "recall" ||
    value === "artifact"
  ) {
    return value;
  }
  return undefined;
}

function changeOp(changeType: string): "created" | "updated" | "archived" | "deleted" {
  if (changeType.includes("delete")) return "deleted";
  if (changeType.includes("archive")) return "archived";
  if (changeType.includes("create") || changeType.includes("insert")) return "created";
  return "updated";
}

function changeKind(change: ChangeLogRecord): MemoryKind | "session" | "episode" | "job" | "feedback" | "raw_turn" | "repair" | "skill_trial" | "recall" | "artifact" {
  if (change.changeType.includes("artifact") || change.memoryId.startsWith("artifact_")) return "artifact";
  if (change.changeType.includes("skill_trial")) return "skill_trial";
  if (change.changeType.includes("recall")) return "recall";
  if (change.changeType.includes("session")) return "session";
  if (change.changeType.includes("episode")) return "episode";
  if (change.changeType.includes("job")) return "job";
  if (change.changeType.includes("feedback")) return "feedback";
  if (change.changeType.includes("repair") || change.memoryId.startsWith("repair_")) return "repair";
  if (change.changeType.includes("raw_turn") || change.memoryId.startsWith("raw_")) return "raw_turn";
  const after = isRecord(change.after) ? change.after : undefined;
  const layer = after?.memoryLayer ?? after?.memory_layer;
  if (layer === "L1") return "trace";
  if (layer === "L2") return "policy";
  if (layer === "L3") return "world_model";
  if (layer === "Skill") return "skill";
  return "trace";
}

function versionFromChange(change: ChangeLogRecord): number | undefined {
  const after = isRecord(change.after) ? change.after : undefined;
  const version = after?.version;
  return typeof version === "number" ? version : undefined;
}

function changeSource(source: string): "turn_complete" | "feedback" | "worker" | "panel" | "system" {
  if (source.startsWith("turn.")) return "turn_complete";
  if (source.startsWith("feedback.")) return "feedback";
  if (source.startsWith("worker.")) return "worker";
  if (source.startsWith("panel.")) return "panel";
  return "system";
}

interface ToolOutcomeObservation {
  toolId: string;
  success?: boolean;
  reason?: string;
}

function toolObservationEvent(input: ToolObserveRequest): {
  phase: "start" | "complete" | "error";
  event: ToolCallPayload;
  toolCall: ToolCallPayload;
  toolResult?: ToolCallPayload;
} {
  const error = errorMessageFromUnknown(input.error);
  const success = input.error !== undefined
    ? false
    : input.result !== undefined
      ? true
      : undefined;
  const phase = input.error !== undefined ? "error" : input.result !== undefined ? "complete" : "start";
  const event: ToolCallPayload = {
    id: input.toolCallId,
    name: input.toolName,
    input: input.args,
    output: input.error === undefined ? input.result : undefined,
    error,
    success
  };
  return {
    phase,
    event,
    toolCall: {
      id: input.toolCallId,
      name: input.toolName,
      input: input.args
    },
    toolResult: phase === "start" ? undefined : event
  };
}

function toolOutcomeFromObservation(
  input: ToolObserveRequest,
  rawTurn: RawTurnRecord,
  updatedRawTurn: RawTurnRecord
): ToolOutcomeObservation | undefined {
  const event = toolObservationEvent(input).event;
  const eventRecord = event as unknown as Record<string, unknown>;
  const call = matchingObservedToolCall(eventRecord, rawTurn, updatedRawTurn);
  const resultSuccess = input.result === undefined ? undefined : successFromToolObservation(eventRecord) ?? true;
  return {
    toolId: input.toolName,
    success: input.error !== undefined ? false : resultSuccess,
    reason: failureReasonFromToolObservation(event, call)
  };
}

function matchingObservedToolCall(
  record: Record<string, unknown> | undefined,
  rawTurn: RawTurnRecord,
  updatedRawTurn: RawTurnRecord
): ToolCallPayload | undefined {
  const id = stringFromMaybeRecord(record, "id") ?? stringFromMaybeRecord(record, "toolCallId");
  const name = stringFromMaybeRecord(record, "name") ?? stringFromMaybeRecord(record, "toolName");
  const calls = [...updatedRawTurn.toolCalls, ...rawTurn.toolCalls].filter(isToolCallPayload);
  return calls.find((call) => id && call.id === id) ?? calls.find((call) => name && call.name === name);
}

function successFromToolObservation(record: Record<string, unknown> | undefined): boolean | undefined {
  if (!record) return undefined;
  if (typeof record.success === "boolean") return record.success;
  if (typeof record.ok === "boolean") return record.ok;
  if (typeof record.exitCode === "number") return record.exitCode === 0;
  if (typeof record.status === "string") {
    const status = record.status.toLowerCase();
    if (status === "succeeded" || status === "success" || status === "ok" || status === "passed") return true;
    if (status === "failed" || status === "failure" || status === "error" || status === "cancelled") return false;
  }
  if (record.error !== undefined) return false;
  return undefined;
}

function failureReasonFromToolObservation(event: unknown, call: ToolCallPayload | undefined): string | undefined {
  const reason =
    errorMessageFromUnknown(event) ??
    (isRecord(event) ? stringFromMaybeRecord(event, "output") : undefined) ??
    call?.error ??
    errorMessageFromUnknown(call?.output);
  return reason ? clip(reason, 240) : undefined;
}

function toolRepairContext(session: SessionRecord, episode: EpisodeRecord): string {
  return [
    session.userId,
    session.projectId ?? session.workspaceId ?? session.conversationId ?? "default",
    episode.id
  ].join(":");
}

function toolSignalKey(toolId: string, context: string): string {
  return `${toolId}|${context}`;
}

function toolRepairContextHash(toolId: string, context: string): string {
  return stableHash(`${toolId}\n${context}`).slice(0, 16);
}

function repairEvidenceValueDiff(high: MemoryRow[], low: MemoryRow[]): number {
  if (high.length === 0 || low.length === 0) return Number.POSITIVE_INFINITY;
  return Math.abs(meanTraceValue(high) - meanTraceValue(low));
}

function meanTraceValue(memories: MemoryRow[]): number {
  const values = memories
    .map((memory) => traceMetaFromMemory(memory)?.value)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function isRepairFailureLikeTrace(trace: TraceMeta): boolean {
  const blob = `${trace.agentText}\n${trace.reflection ?? ""}`.toLowerCase();
  return /(error|failed|failure|exception|traceback|timeout|retry)/.test(blob) ||
    trace.toolCalls.some((call) => Boolean(call.error ?? errorMessageFromUnknown(call.output)));
}

function repairTraceContains(trace: TraceMeta, needle: string): boolean {
  const blob = `${trace.userText}\n${trace.agentText}\n${trace.reflection ?? ""}`.toLowerCase();
  return blob.includes(needle);
}

function failureBurstPreference(
  burst: ToolFailureBurst,
  reason: string,
  bestMemory: MemoryRow | undefined
): string {
  const trace = bestMemory ? traceMetaFromMemory(bestMemory) : null;
  const bestText = trace?.reflection ?? trace?.agentText ?? trace?.summary;
  if (bestText) return `Prefer: ${clip(bestText, 200)}`;
  return `Prefer: switch strategy for ${burst.toolId} instead of repeating the same failing call.`;
}

function failureBurstAntiPattern(burst: ToolFailureBurst, reason: string): string {
  return `Avoid: repeating ${burst.toolId} after ${burst.failureCount} failures with ${clip(reason, 160)}.`;
}

function valueDistributionPreference(memory: MemoryRow | undefined): string {
  const trace = memory ? traceMetaFromMemory(memory) : null;
  const text = trace?.reflection ?? trace?.agentText ?? trace?.summary;
  if (text) return `Prefer: ${clip(text, 200)}`;
  return "Prefer the approach used by high-value traces in this context.";
}

function valueDistributionAntiPattern(memory: MemoryRow | undefined): string {
  const trace = memory ? traceMetaFromMemory(memory) : null;
  const text = trace?.reflection ?? trace?.agentText ?? trace?.summary;
  if (text) return `Avoid: ${clip(text, 200)}`;
  return "Avoid repeating the low-value approach observed in this context.";
}

function l3DraftInCooldown(existing: MemoryRow, cooldownDays: number, at: string): boolean {
  if (cooldownDays <= 0) return false;
  const updatedAt = Date.parse(existing.updatedAt);
  const now = Date.parse(at);
  if (!Number.isFinite(updatedAt) || !Number.isFinite(now)) return false;
  return now - updatedAt < cooldownDays * 24 * 60 * 60 * 1000;
}

function l3PolicyOverlapScore(left: string[], right: string[]): { score: number; shared: number } {
  if (left.length === 0 || right.length === 0) return { score: 0, shared: 0 };
  const rightSet = new Set(right);
  let shared = 0;
  for (const id of new Set(left)) {
    if (rightSet.has(id)) shared += 1;
  }
  return {
    score: shared / Math.min(new Set(left).size, new Set(right).size),
    shared
  };
}

function mergeWorldModelDraftForUpdate(
  draft: WorldModelDraft,
  existing: MemoryRow,
  confidenceDelta: number
): WorldModelDraft {
  const world = worldModelMetaFromMemory(existing);
  if (!world) return draft;
  const policyIds = uniq([...world.policyIds, ...draft.policyIds]);
  const domainTags = uniq([...world.domainTags, ...draft.domainTags]);
  const confidence = clampNumber(world.confidence + confidenceDelta, 0, 1);
  return {
    ...draft,
    key: existing.memoryKey ?? draft.key,
    policyIds,
    domainTags,
    confidence,
    structure: mergeWorldModelStructure(world.structure, draft.structure),
    vec: draft.vec ?? world.vec,
    tags: uniq([...draft.tags, ...domainTags])
  };
}

function mergeWorldModelStructure(
  previous: WorldModelDraft["structure"],
  next: WorldModelDraft["structure"]
): WorldModelDraft["structure"] {
  return {
    environment: mergeWorldModelEntries(previous.environment, next.environment),
    inference: mergeWorldModelEntries(previous.inference, next.inference),
    constraints: mergeWorldModelEntries(previous.constraints, next.constraints)
  };
}

function mergeWorldModelEntries<T extends { label: string; description: string }>(previous: T[], next: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const entry of previous) byKey.set(worldModelEntryKey(entry), entry);
  for (const entry of next) byKey.set(worldModelEntryKey(entry), entry);
  return Array.from(byKey.values()).slice(0, 24);
}

function worldModelEntryKey(entry: { label: string; description: string }): string {
  return `${entry.label.toLowerCase().trim()}::${entry.description.toLowerCase().trim().slice(0, 64)}`;
}

function repairIssueFromFeedback(
  request: FeedbackRequest,
  classification: FeedbackTextClassification
): string {
  if (classification.shape === "correction" && classification.correction) {
    return `Correction requested: ${clip(classification.correction, 180)}`;
  }
  if (classification.shape === "preference" && classification.avoid) {
    return `Avoided approach: ${clip(classification.avoid, 180)}`;
  }
  if (classification.shape === "constraint" && classification.constraint) {
    return `Missing constraint: ${clip(classification.constraint, 180)}`;
  }
  return clip(request.rationale ?? classification.text, 220) || "negative feedback";
}

function repairSuggestionFromFeedback(
  request: FeedbackRequest,
  classification: FeedbackTextClassification
): string {
  const target = classification.prefer ?? classification.correction ?? classification.constraint;
  if (target) return `Prefer: ${clip(target, 200)}`;
  return clip(request.rationale ?? classification.text, 220) || "Prefer the path that avoids the reported issue.";
}

function repairPreferenceFromFeedback(
  request: FeedbackRequest,
  classification: FeedbackTextClassification
): string {
  const target = classification.prefer ?? classification.correction ?? classification.constraint;
  if (target) return `Prefer: ${clip(target, 200)}`;
  return `Prefer: ${clip(request.rationale ?? classification.text, 200) || "use a corrected approach next time"}`;
}

function repairAntiPatternFromFeedback(
  request: FeedbackRequest,
  classification: FeedbackTextClassification
): string {
  const target = classification.avoid ?? (
    classification.shape === "negative" ? (request.rationale ?? classification.text) : undefined
  );
  if (target) return `Avoid: ${clip(target, 200)}`;
  return "Avoid: repeating the same approach after negative feedback.";
}

function cleanFeedbackText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.trim().replace(/^["'`]|["'`]$/g, "").trim() || undefined;
}

const DECISION_REPAIR_OPERATION = `${DECISION_REPAIR_PROMPT.id}.v${DECISION_REPAIR_PROMPT.version}`;

const DECISION_REPAIR_SYSTEM_PROMPT = `${DECISION_REPAIR_PROMPT.system}

Service extension:
- USER_FEEDBACK may be provided when the repair is triggered by explicit user
  correction, preference, or constraint feedback instead of a pure retry loop.
- In that case, CURRENT_CONTEXT describes what the agent is trying to fix now,
  and FAILURE_HISTORY may contain low-value traces or the feedback text itself.
- Ground guidance in USER_FEEDBACK, FAILURE_HISTORY, or SIMILAR_SUCCESS.
- If SIMILAR_SUCCESS is empty, use severity="info" and confidence <= 0.5 unless
  the user feedback is a direct correction.`;

function decisionRepairPromptMessages(input: {
  trigger: string;
  contextHash: string;
  feedbackText: string;
  classification: FeedbackTextClassification;
  highValue: DecisionRepairTraceSource[];
  lowValue: DecisionRepairTraceSource[];
  traceCharCap: number;
}): Array<{ role: "system" | "user"; content: string }> {
  const high = input.highValue
    .map((memory) => decisionRepairTraceBlock(memory, input.traceCharCap))
    .filter(Boolean)
    .join("\n---\n");
  const low = input.lowValue
    .map((memory) => decisionRepairTraceBlock(memory, input.traceCharCap))
    .filter(Boolean)
    .join("\n---\n");
  const contextHead = [
    `TRIGGER: ${input.trigger}`,
    `CONTEXT_HASH: ${input.contextHash}`,
    `FEEDBACK_SHAPE: ${input.classification.shape}`,
    input.classification.prefer ? `USER_PREFERS: ${input.classification.prefer}` : "",
    input.classification.avoid ? `USER_AVOIDS: ${input.classification.avoid}` : "",
    input.classification.correction ? `USER_CORRECTION: ${input.classification.correction}` : "",
    input.classification.constraint ? `USER_CONSTRAINT: ${input.classification.constraint}` : ""
  ].filter(Boolean).join("\n");
  const userContent = [
    "CURRENT_CONTEXT:",
    contextHead,
    "",
    `USER_FEEDBACK:\n${clip(input.feedbackText, 800) || "(none)"}`,
    "",
    "FAILURE_HISTORY:",
    low || "(none)",
    "",
    "SIMILAR_SUCCESS:",
    high || "(none)",
    "",
    "Return the JSON object described in the system prompt."
  ].join("\n");
  return [
    { role: "system", content: DECISION_REPAIR_SYSTEM_PROMPT },
    { role: "user", content: userContent }
  ];
}

function decisionRepairTraceBlock(source: DecisionRepairTraceSource, charCap: number): string {
  const { memory, rawTurn } = source;
  const trace = traceMetaFromMemoryWithRaw(memory, rawTurn);
  if (!trace) return "";
  return [
    `trace ${memory.id}`,
    `value: ${roundNumber(trace.value)}`,
    trace.userText ? `user: ${tailClip(trace.userText, charCap)}` : "",
    trace.agentText ? `agent: ${tailClip(trace.agentText, charCap)}` : "",
    trace.reflection ? `reflection: ${tailClip(trace.reflection, charCap)}` : ""
  ].filter(Boolean).join("\n");
}

function normalizeDecisionRepairLlmDraft(value: {
  preference?: unknown;
  anti_pattern?: unknown;
  severity?: unknown;
  confidence?: unknown;
}): DecisionRepairLlmDraft | undefined {
  const preference = typeof value.preference === "string" ? value.preference.trim() : "";
  const antiPattern = typeof value.anti_pattern === "string" ? value.anti_pattern.trim() : "";
  if (!preference && !antiPattern) return undefined;
  const confidence = typeof value.confidence === "number" && Number.isFinite(value.confidence)
    ? clampNumber(value.confidence, 0, 1)
    : 0.5;
  return {
    preference: clip(preference || "Prefer the path that avoids the reported issue.", 360),
    antiPattern: clip(antiPattern || "Avoid repeating the reported failing approach.", 360),
    severity: value.severity === "warn" ? "warn" : "info",
    confidence
  };
}

const FAILURE_EXPERIENCE_SINK_PROMPT = {
  id: "failure.experience.sink",
  version: 5,
  system: `You induce a candidate policy from an episode where the task was not finished satisfactorily.

Goal:
- Extract one reusable policy that helps a similar task reach a satisfactory finish.
- Make it operational: trigger + procedure + verification. Prefer practical guidance (priorities, sequencing, closure checks) over abstract commentary.
- Use corrective_signals to see what the goal still needed; use phase_chunks and episode_timeline for context.

Input:
- task_context.user_goal: task framing and requirements (may be truncated).
- phase_chunks: recent traces (conversation + limited tool output snippets).
- episode_timeline.turns: ordered user turns with timing.
- corrective_signals: feedback with turn_index and timing relative to turns.

Evidence:
1) Ground only in the fields above. Do not invent tests, files, errors, or violations.
2) task_context states requirements; it does not by itself show what went wrong in the attempt.
3) Tie each claim to a quotable phenomenon (e.g. external judgment still open, requested substance missing, timeout without deliverable, feedback naming an unmet acceptance criterion).
4) If evidence is thin, keep the policy narrow and note limits in boundary.
5) Source-specific entities are not reusable guidance by default: names, locations, product names, file names, one-off requested targets, and one task's acceptance details must be abstracted into categories or variables.
6) Preserve an entity only when the input explicitly marks it as a structured stable fact, such as a user profile fact, workspace/project fact, long-term preference memory, or stable-fact annotation.
7) Current episode text, tool output, verifier feedback, or a one-time task requirement are not enough evidence to call an entity long-term. Do not infer long-term preference from them.
8) Do not put source-specific entities into title, trigger, procedure, verification, boundary, or decision_guidance unless the structured stable source is present.

Guidance:
9) prefer: habits that advance completion (may be empty).
10) avoid: habits that leave the goal unmet--outcome/behavior gaps only. Do not name tools or channels; do not use "do not use / never call" style lines.
11) procedure and verification must be checkable from visible outcomes or judgments in the input.
12) verification: how to tell the task is done or accepted.

Types:
13) "failure_avoidance" when feedback shows the goal stayed open and you mainly generalize what to stop doing before ending.
14) "repair_instruction" when you can give a repeatable completion pattern (what to finish or confirm before done).

Other:
15) trigger: task-level, recognizable when a similar task starts or nears closure.
16) support_trace_ids: only traces you actually used.

Return JSON:
{
  "title": "short title",
  "trigger": "state condition",
  "procedure": "step-by-step guidance",
  "verification": "how to verify completion",
  "boundary": "scope/limits",
  "experience_type": "repair_instruction | failure_avoidance",
  "decision_guidance": {
    "prefer": ["..."],
    "avoid": ["..."]
  },
  "support_trace_ids": ["tr_..."]
}`
} as const;

const FEEDBACK_REFINEMENT_SYSTEM_PROMPT = `You extract actionable guidance from user feedback.

Given a user's feedback on an agent's response, produce a procedural policy
that helps the agent avoid the same mistake (or replicate the same success)
in future similar tasks.

CRITICAL REQUIREMENTS:

1. TRIGGER must be SPECIFIC and CONCRETE:
   - BAD: "When a similar task appears" (what is similar?)
   - GOOD: "When the user asks to implement bubble sort"
   Extract the concrete task type, domain, or feature from the episode context.

2. PROCEDURE must be ACTIONABLE and CONCISE:
   - BAD: "adjust according to feedback"
   - GOOD: "Implement descending order by using > in the comparison"
   Specify concrete steps the agent should take.

3. CAVEATS must provide SPECIFIC ANTI-PATTERNS:
   - BAD: "avoid repeating the current mistake"
   - GOOD: "Do not assume the default sort direction is ascending"
   Return [] if no concrete anti-pattern can be extracted.

4. VERIFICATION is OPTIONAL:
   - BAD: "check whether the issue is solved"
   - GOOD: "Check the comparison operator direction (< vs >)"
   Return "" if no concrete, checkable verification method exists.

Focus on TRIGGER + PROCEDURE. Caveats and verification are optional - only
fill them when there is specific content.

Return JSON:
{
  "title": "short imperative title",
  "trigger": "SPECIFIC task type/domain/feature (not 'similar task')",
  "procedure": "CONCRETE actionable steps (not 'adjust according to feedback')",
  "caveats": ["SPECIFIC anti-patterns"] or [],
  "verification": "CHECKABLE verification method" or "",
  "confidence": number in [0, 1]
}`;

function feedbackExperienceText(feedback: FeedbackRecord): string {
  return dedupeTextLines([
    feedback.rationale,
    feedbackRawText(feedback.rawPayload)
  ]).join("\n").trim();
}

function feedbackPolarityForRefinement(
  feedback: FeedbackRecord,
  draft: FeedbackExperienceDraft
): "positive" | "negative" | "neutral" {
  if (feedback.polarity === "positive" || draft.polarity === "positive") return "positive";
  if (feedback.polarity === "negative" || draft.polarity === "negative") return "negative";
  return "neutral";
}

function feedbackRefinementUserPrompt(input: {
  feedbackText: string;
  polarity: "positive" | "negative" | "neutral";
  userRequest: string;
  agentResponse: string;
  episodeContext: string;
}): string {
  const isNegative = input.polarity === "negative";
  const context = input.episodeContext
    ? `EPISODE CONTEXT (first turn + last 3 turns):\n${input.episodeContext}`
    : [
        `USER REQUEST:\n${clip(input.userRequest, 500)}`,
        `AGENT RESPONSE:\n${clip(input.agentResponse, 800)}`
      ].join("\n\n");
  return [
    context,
    `USER FEEDBACK (${input.polarity}):\n${input.feedbackText}`,
    isNegative ? NEGATIVE_FEEDBACK_REFINEMENT_EXAMPLES : POSITIVE_FEEDBACK_REFINEMENT_EXAMPLES,
    "Output JSON only."
  ].join("\n\n");
}

function failureExperienceSinkUserPrompt(input: {
  feedbackText: string;
  userRequest: string;
  agentResponse: string;
  episodeContext: string;
}): string {
  const timeline = input.episodeContext
    .split(/\n\s*\n/)
    .map((text, index) => ({
      turn_index: index + 1,
      text: clip(text, 700)
    }))
    .filter((turn) => turn.text.length > 0);
  return stableStringify({
    task_context: {
      user_goal: clip(input.userRequest || input.episodeContext || "unknown task", 800)
    },
    phase_chunks: [
      {
        id: "recent_episode_context",
        text: clip(input.episodeContext || [
          `User: ${input.userRequest}`,
          `Agent: ${input.agentResponse}`
        ].join("\n"), 2400)
      }
    ],
    episode_timeline: {
      turns: timeline
    },
    corrective_signals: [
      {
        turn_index: timeline.length || null,
        timing: "after_attempt",
        text: clip(input.feedbackText, 1000)
      }
    ]
  });
}

const NEGATIVE_FEEDBACK_REFINEMENT_EXAMPLES = `Extract guidance to AVOID this mistake.

CRITICAL: Be SPECIFIC and CONCISE.
- Identify the concrete task type, e.g. "bubble sort implementation", not "similar task".
- Extract the specific requirement, e.g. "descending order", not "adjust according to feedback".
- Only fill caveats/verification if you have specific content.

Example 1:
Turn 1:
User: "写个冒泡排序"
Agent: [generates ascending sort code]

Turn 2:
User: "写的不对，我要的是从大到小的"

Output:
{
  "title": "Bubble sort: descending order",
  "trigger": "When the user asks to implement bubble sort.",
  "procedure": "Implement descending order by using > in the comparison.",
  "caveats": [],
  "verification": "",
  "confidence": 0.85
}

Example 2:
Turn 1:
User: "Write a function to filter even numbers from an array."
Agent: [generates filter with wrong boolean logic]

Turn 2:
User: "Wrong, it should use AND conditions, not OR."

Output:
{
  "title": "Confirm filter condition operators",
  "trigger": "When the user asks to filter or select data.",
  "procedure": "Before generating code, confirm whether multiple filter conditions should use AND or OR.",
  "caveats": ["Do not assume multiple conditions use OR by default."],
  "verification": "Check that the generated code uses the requested logical operator.",
  "confidence": 0.9
}

BAD Example:
{
  "title": "Fix user feedback",
  "trigger": "When a similar task appears",
  "procedure": "Adjust according to feedback",
  "caveats": ["Avoid repeating the current mistake"],
  "verification": "Check whether the issue is solved",
  "confidence": 0.5
}`;

const POSITIVE_FEEDBACK_REFINEMENT_EXAMPLES = `Extract guidance to REPLICATE this success.

CRITICAL: Be SPECIFIC and CONCISE.
- Identify the concrete task type.
- Extract the specific success pattern.
- Only fill caveats/verification if you have specific content.

Example:
Turn 1:
User: "写个快速排序"
Agent: [generates quicksort with three-way partitioning]

Turn 2:
User: "很好，这个实现很高效"

Output:
{
  "title": "Quicksort: use three-way partitioning",
  "trigger": "When the user asks to implement quicksort.",
  "procedure": "Use three-way partitioning for duplicate elements and choose a median or random pivot.",
  "caveats": ["Avoid always choosing the first element as pivot because sorted arrays degrade to O(n^2)."],
  "verification": "Check that the code partitions into less-than, equal-to, and greater-than groups.",
  "confidence": 0.85
}`;

function applyFeedbackRefinement(
  draft: FeedbackExperienceDraft,
  refinement: {
    title: string;
    trigger: string;
    procedure: string;
    verification: string;
    caveats: string[];
    confidence: number;
    method: "llm" | "rule";
  }
): FeedbackExperienceDraft {
  const prefix = feedbackExperiencePrefix(draft.type);
  const refinedTitle = cleanFeedbackText(refinement.title);
  const title = refinedTitle
    ? `${prefix}: ${stripFeedbackRefinementPrefix(refinedTitle, prefix)}`
    : draft.title;
  const trigger = cleanFeedbackText(refinement.trigger) ?? draft.trigger;
  const procedure = cleanFeedbackText(refinement.procedure) ?? draft.procedure;
  const verification = typeof refinement.verification === "string" && refinement.verification.trim()
    ? refinement.verification.trim()
    : draft.verification;
  const caveats = dedupeTextLines(refinement.caveats.map((item) => clip(item, 360)));
  const decisionGuidance = {
    preference: dedupeTextLines([
      ...draft.decisionGuidance.preference,
      draft.type === "success_pattern" || draft.type === "repair_validated" ? procedure : undefined
    ]),
    antiPattern: dedupeTextLines([
      ...draft.decisionGuidance.antiPattern,
      ...caveats
    ])
  };
  return {
    ...draft,
    title,
    trigger,
    procedure,
    verification,
    decisionGuidance,
    confidence: clampNumber(Math.max(draft.confidence, refinement.confidence), 0, 1),
    vectorText: [title, trigger, procedure, verification, draft.boundary].join("\n"),
    tags: uniq([...draft.tags, `feedback-${refinement.method}-refined`]).slice(0, 12)
  };
}

function applyFailureExperienceSink(
  draft: FeedbackExperienceDraft,
  sink: {
    title?: unknown;
    trigger?: unknown;
    procedure?: unknown;
    verification?: unknown;
    boundary?: unknown;
    experience_type?: unknown;
    decision_guidance?: unknown;
    support_trace_ids?: unknown;
  }
): FeedbackExperienceDraft {
  const guidance = isRecord(sink.decision_guidance) ? sink.decision_guidance : {};
  const title = cleanFeedbackText(stringOr(sink.title, "")) ?? draft.title;
  const trigger = cleanFeedbackText(stringOr(sink.trigger, "")) ?? draft.trigger;
  const procedure = cleanFeedbackText(stringOr(sink.procedure, "")) ?? draft.procedure;
  const verification = cleanFeedbackText(stringOr(sink.verification, "")) ?? draft.verification;
  const boundary = cleanFeedbackText(stringOr(sink.boundary, "")) ?? draft.boundary;
  const experienceType = sink.experience_type === "failure_avoidance"
    ? "failure_avoidance"
    : sink.experience_type === "repair_instruction"
      ? "repair_instruction"
      : draft.type === "failure_avoidance"
        ? "failure_avoidance"
        : "repair_instruction";
  const supportTraceIds = stringArray(sink.support_trace_ids);
  const decisionGuidance = {
    preference: dedupeTextLines([
      ...draft.decisionGuidance.preference,
      ...stringArray(guidance.prefer),
      ...stringArray(guidance.preference)
    ]),
    antiPattern: dedupeTextLines([
      ...draft.decisionGuidance.antiPattern,
      ...stringArray(guidance.avoid),
      ...stringArray(guidance.anti_pattern),
      ...stringArray(guidance.antiPattern)
    ])
  };
  return {
    ...draft,
    type: experienceType,
    title,
    trigger,
    procedure,
    verification,
    boundary,
    decisionGuidance,
    sourceTraceIds: supportTraceIds.length > 0
      ? uniq([...draft.sourceTraceIds, ...supportTraceIds]).slice(0, 20)
      : draft.sourceTraceIds,
    vectorText: [title, trigger, procedure, verification, boundary].join("\n"),
    tags: uniq([...draft.tags, "feedback-failure-sink-refined"]).slice(0, 12)
  };
}

function stripFeedbackRefinementPrefix(title: string, prefix: string): string {
  const pattern = new RegExp(`^${escapeRegExp(prefix)}\\s*[:：-]\\s*`, "i");
  return title.replace(pattern, "").trim() || title;
}

function refineFeedbackExperienceByRules(input: {
  feedbackText: string;
  polarity: "positive" | "negative" | "neutral";
  userRequest: string;
  episodeContext: string;
}): {
  title: string;
  trigger: string;
  procedure: string;
  verification: string;
  caveats: string[];
  confidence: number;
  method: "rule";
} {
  const text = input.feedbackText.trim();
  const lower = text.toLowerCase();
  const task = feedbackTaskContext(input.userRequest, input.episodeContext);

  const preferZh = text.match(/用\s*(.+?)\s*(代替|而不是)\s*(.+?)([。!?\n]|$)/i);
  const preferEn = preferZh ? null : text.match(/use\s+(.+?)\s+instead\s+of\s+(.+?)([.!?\n]|$)/i);
  if (preferZh || preferEn) {
    const preferred = cleanFeedbackText(preferZh?.[1] ?? preferEn?.[1]) ?? "";
    const avoided = cleanFeedbackText(preferZh?.[3] ?? preferEn?.[2]) ?? "";
    return {
      title: preferred ? `Use ${firstFeedbackSentence(preferred, 60)}` : firstFeedbackSentence(text, 80),
      trigger: task.trigger || "When choosing an implementation approach.",
      procedure: preferred && avoided ? `Use ${preferred} instead of ${avoided}.` : text,
      caveats: avoided ? [`Avoid using ${avoided}.`] : [],
      verification: preferred ? `Check that the answer uses ${firstFeedbackSentence(preferred, 80)}.` : "",
      confidence: 0.75,
      method: "rule"
    };
  }

  const should = text.match(/(?:应该|should)\s+(.+?)([。!?\n]|$)/i);
  if (should) {
    const action = cleanFeedbackText(should[1]) ?? text;
    return {
      title: firstFeedbackSentence(action, 80),
      trigger: task.trigger || "When handling the related task.",
      procedure: action,
      caveats: input.polarity === "negative" ? [`Avoid ignoring this requirement: ${action}`] : [],
      verification: `Check that the answer applies: ${firstFeedbackSentence(action, 80)}.`,
      confidence: 0.65,
      method: "rule"
    };
  }

  const avoid = text.match(/(?:不要|别|avoid|don't|do not)\s+(.+?)([。!?\n]|$)/i);
  if (avoid) {
    const antiPattern = cleanFeedbackText(avoid[1]) ?? text;
    return {
      title: `Avoid ${firstFeedbackSentence(antiPattern, 60)}`,
      trigger: task.trigger || "When handling the related task.",
      procedure: `Check the plan and avoid: ${antiPattern}`,
      caveats: [antiPattern],
      verification: `Check that the answer avoids: ${firstFeedbackSentence(antiPattern, 80)}.`,
      confidence: 0.7,
      method: "rule"
    };
  }

  if (input.polarity === "negative") {
    return {
      title: firstFeedbackSentence(text, 80),
      trigger: task.trigger || task.taskType || "When handling the related task.",
      procedure: text,
      caveats: [],
      verification: "",
      confidence: 0.5,
      method: "rule"
    };
  }

  return {
    title: firstFeedbackSentence(text, 80),
    trigger: task.trigger || task.taskType || "When handling the related task.",
    procedure: `Continue using this approach: ${text}`,
    caveats: [],
    verification: "",
    confidence: 0.6,
    method: "rule"
  };
}

function feedbackTaskContext(
  userRequest: string,
  episodeContext: string
): { trigger: string; taskType: string } {
  const combined = `${userRequest} ${episodeContext}`.toLowerCase();
  const patterns: Array<{ pattern: RegExp; trigger: string; taskType: string }> = [
    { pattern: /(写|实现|生成|创建).{0,8}(排序|冒泡|快排|归并|选择|插入)/, trigger: "When the user asks to implement a sorting algorithm.", taskType: "sorting algorithm implementation" },
    { pattern: /(写|实现|生成|创建).{0,8}(搜索|查找|二分|遍历)/, trigger: "When the user asks to implement a search algorithm.", taskType: "search algorithm implementation" },
    { pattern: /(筛选|过滤|filter|select).{0,16}(数据|数组|列表|records|rows)/, trigger: "When the user asks to filter data.", taskType: "data filtering" },
    { pattern: /(读取|写入|操作).{0,8}(文件|file)/, trigger: "When the user asks for file operations.", taskType: "file operation" },
    { pattern: /(调用|请求|fetch).{0,8}(api|接口|服务)/, trigger: "When the user asks to call an API or service.", taskType: "API call" },
    { pattern: /(处理|解析|parse).{0,12}(json|xml|csv|数据|filing|document)/, trigger: "When the user asks to parse structured data or documents.", taskType: "structured data parsing" },
    { pattern: /(格式化|format|转换|convert)/, trigger: "When the user asks to format or convert data.", taskType: "data formatting" },
    { pattern: /(sec|13f|cusip|issuer|holding)/, trigger: "When the user asks to parse SEC 13F holdings or issuer/CUSIP data.", taskType: "SEC 13F parsing" }
  ];
  for (const item of patterns) {
    if (item.pattern.test(combined)) {
      return { trigger: item.trigger, taskType: item.taskType };
    }
  }
  const verbNoun = combined.match(/\b(write|implement|create|parse|process|convert|filter)\s+(.{2,40}?)(?:\.|\n|$)/i);
  if (verbNoun?.[1] && verbNoun[2]) {
    const task = clip(verbNoun[2].trim(), 80);
    return {
      trigger: `When the user asks to ${verbNoun[1]} ${task}.`,
      taskType: `${verbNoun[1]} ${task}`
    };
  }
  return { trigger: "", taskType: "" };
}

function feedbackRefinementSelectedTraces(traces: TraceMeta[]): TraceMeta[] {
  const selected: TraceMeta[] = [];
  const first = traces[0];
  if (first) selected.push(first);
  const start = Math.max(1, traces.length - 3);
  for (let index = start; index < traces.length; index += 1) {
    const trace = traces[index];
    if (trace && trace.id !== first?.id) selected.push(trace);
  }
  return selected;
}

function feedbackRefinementTurnBlock(turnNumber: number, trace: TraceMeta): string {
  return [
    `Turn ${turnNumber}:`,
    `User: ${clip(trace.userText, 400)}`,
    `Agent: ${clip(trace.agentText, 600)}`
  ].join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function feedbackExperienceSignificance(
  feedback: FeedbackRecord,
  classification: FeedbackTextClassification,
  episode: EpisodeRecord | undefined
): number {
  const reward = isRecord(episode?.meta.reward) && typeof episode.meta.reward.rHuman === "number"
    ? Math.abs(episode.meta.reward.rHuman)
    : 0;
  return clampNumber(Math.max(
    feedback.magnitude ?? 0,
    classification.confidence,
    feedbackVerifierScore(feedback.rawPayload),
    reward
  ), 0, 1);
}

function isActionableFeedbackExperience(text: string, shape: FeedbackTextShape): boolean {
  if (shape !== "unknown" && shape !== "confusion") return true;
  return /\b(next time|should|must|avoid|prefer|instead|do not|don't|pass|fail|failed|success|expected|actual)\b/i.test(text) ||
    /下次|应该|必须|不要|别|成功|失败|反例|期望|实际|改/.test(text);
}

function buildFeedbackExperienceDraft(input: {
  feedback: FeedbackRecord;
  text: string;
  classification: FeedbackTextClassification;
  significance: number;
  episode?: EpisodeRecord;
  trace: TraceMeta | null;
  traceMemory?: MemoryRow;
}): FeedbackExperienceDraft {
  const text = clip(input.text, 360);
  const lower = input.text.toLowerCase();
  const verifierMeta = extractFeedbackVerifierMeta(input.feedback.rawPayload, lower);
  const pass = isPositiveFeedbackExperience(input.feedback, lower, input.classification.shape, verifierMeta);
  const fail = isNegativeFeedbackExperience(input.feedback, lower, input.classification.shape, verifierMeta);
  const hasAvoid = /\b(avoid|do not|don't|never|stop|wrong|incorrect|failed|fail)\b/i.test(input.text) ||
    /不要|别|不能|错误|失败|反例/.test(input.text);
  let type: FeedbackExperienceType;
  let polarity: FeedbackEvidencePolarity;
  let skillEligible = false;
  if (pass) {
    type = "success_pattern";
    polarity = "positive";
    skillEligible = true;
  } else if (fail && hasAvoid) {
    type = "failure_avoidance";
    polarity = "negative";
  } else if (input.classification.shape === "preference") {
    type = "preference";
    polarity = fail ? "negative" : "neutral";
  } else if (hasAvoid) {
    type = "failure_avoidance";
    polarity = "negative";
  } else if (input.classification.shape === "correction" || input.classification.shape === "constraint" || fail) {
    type = "repair_instruction";
    polarity = fail ? "negative" : "neutral";
  } else if (verifierMeta) {
    type = "verifier_feedback";
    polarity = pass ? "positive" : fail ? "negative" : "neutral";
  } else {
    type = "repair_instruction";
    polarity = "neutral";
  }
  const prefix = feedbackExperiencePrefix(type);
  const traceContext = input.trace ? feedbackTraceHint(input.trace) : null;
  const title = `${prefix}: ${firstFeedbackSentence(text, Math.max(30, 120 - prefix.length - 2))}`;
  const trigger = [
    "When a future task is similar to the source episode or asks for comparable output.",
    input.trace?.userText ? `Source user request: ${clip(input.trace.userText, 220)}` : null
  ].filter(Boolean).join("\n");
  const procedure = [
    type === "failure_avoidance"
      ? `Avoid repeating this behavior: ${text}`
      : type === "repair_instruction"
      ? `When this feedback pattern appears, repair the answer by applying: ${text}`
      : type === "preference"
      ? `Prefer this behavior in similar tasks: ${text}`
      : `This was accepted as a useful approach: ${text}`,
    traceContext ? `Source turn context: ${traceContext}` : null
  ].filter(Boolean).join("\n");
  const verification = type === "success_pattern"
    ? "Before reusing, confirm the current task has the same success criteria as the feedback."
    : "Before answering, check the current plan against this avoid/repair instruction.";
  const boundary = [
    "Use only for similar task shape, evaluator expectation, or user preference.",
    input.episode?.id ? `Source episode: ${input.episode.id}` : null,
    input.feedback.id ? `Source feedback: ${input.feedback.id}` : null
  ].filter(Boolean).join("\n");
  const sourceTraceIds = feedbackExperienceTraceIds(input.feedback, input.episode, input.trace);
  const guidance = feedbackExperienceGuidance(type, input.classification, text);
  const confidence = clampNumber(Math.max(input.classification.confidence, input.significance), 0, 1);
  const salience = clampNumber(Math.max(input.feedback.magnitude ?? 0, input.significance), 0, 1);
  const tags = uniq([
    "policy",
    "feedback",
    type,
    polarity,
    ...(input.trace?.tags ?? []),
    ...(input.traceMemory?.tags ?? [])
  ]).slice(0, 12);
  return {
    type,
    polarity,
    title,
    trigger,
    procedure,
    verification,
    boundary,
    decisionGuidance: guidance,
    salience,
    confidence,
    skillEligible,
    verifierMeta,
    sourceEpisodeIds: input.feedback.episodeId ? [input.feedback.episodeId] : [],
    sourceTraceIds,
    sourceFeedbackIds: [input.feedback.id],
    vectorText: [title, trigger, procedure, verification, boundary].join("\n"),
    tags
  };
}

function renderFeedbackExperienceBody(draft: FeedbackExperienceDraft & {
  support?: number;
  gain?: number;
}): string {
  return [
    draft.title,
    `Trigger: ${draft.trigger}`,
    `Procedure: ${draft.procedure}`,
    `Verification: ${draft.verification}`,
    `Boundary: ${draft.boundary}`,
    `Experience: ${draft.type}`,
    `Evidence polarity: ${draft.polarity}`,
    `Support: ${draft.support ?? 1}`,
    `Gain: ${roundNumber(draft.gain ?? Math.max(0.02, draft.salience))}`,
    `Confidence: ${roundNumber(draft.confidence)}`,
    draft.decisionGuidance.preference.length
      ? `Preference: ${draft.decisionGuidance.preference.join(" | ")}`
      : undefined,
    draft.decisionGuidance.antiPattern.length
      ? `Anti-pattern: ${draft.decisionGuidance.antiPattern.join(" | ")}`
      : undefined,
    `Feedback: ${draft.sourceFeedbackIds.join(", ")}`,
    draft.sourceTraceIds.length ? `Evidence: ${draft.sourceTraceIds.join(", ")}` : undefined
  ].filter(Boolean).join("\n");
}

function feedbackExperienceGuidance(
  type: FeedbackExperienceType,
  classification: FeedbackTextClassification,
  text: string
): FeedbackExperienceDraft["decisionGuidance"] {
  const preference: string[] = [];
  const antiPattern: string[] = [];
  if (classification.shape === "preference") {
    if (classification.prefer) preference.push(clip(classification.prefer, 360));
    if (classification.avoid) antiPattern.push(clip(classification.avoid, 360));
  } else if (classification.shape === "correction" && classification.correction) {
    preference.push(clip(classification.correction, 360));
  } else if (classification.shape === "constraint" && classification.constraint) {
    preference.push(clip(classification.constraint, 360));
  }
  if (type === "failure_avoidance") antiPattern.push(text);
  if (type === "repair_instruction" || type === "success_pattern") preference.push(text);
  return {
    preference: dedupeTextLines(preference),
    antiPattern: dedupeTextLines(antiPattern)
  };
}

function policyDecisionGuidanceForStorage(guidance: FeedbackExperienceDraft["decisionGuidance"]): {
  preference: string[];
  anti_pattern: string[];
} {
  return {
    preference: guidance.preference,
    anti_pattern: guidance.antiPattern
  };
}

function feedbackExperienceTraceIds(
  feedback: FeedbackRecord,
  episode: EpisodeRecord | undefined,
  trace: TraceMeta | null
): string[] {
  return uniq([
    feedback.l1MemoryId,
    trace?.id,
    ...(episode?.l1MemoryIds ?? [])
  ].filter((id): id is string => typeof id === "string" && id.length > 0));
}

function feedbackExperiencePrefix(type: FeedbackExperienceType): string {
  if (type === "failure_avoidance") return "Avoid";
  if (type === "repair_instruction") return "Repair";
  if (type === "preference") return "Prefer";
  if (type === "verifier_feedback") return "Verifier";
  if (type === "repair_validated") return "Validated";
  return "Success";
}

function firstFeedbackSentence(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const sentence = normalized.split(/(?<=[.!?。！？])\s+/)[0] ?? normalized;
  return clip(sentence, maxChars);
}

function feedbackTraceHint(trace: TraceMeta): string {
  return [
    trace.summary ? `summary=${clip(trace.summary, 140)}` : null,
    trace.userText ? `user=${clip(trace.userText, 140)}` : null,
    trace.reflection ? `note=${clip(trace.reflection, 140)}` : null
  ].filter(Boolean).join(" | ");
}

function feedbackRawText(raw: unknown): string {
  if (!raw) return "";
  if (typeof raw === "string") return raw.trim();
  if (!isRecord(raw)) return String(raw);
  return dedupeTextLines([
    raw.feedback,
    raw.text,
    raw.message,
    raw.rationale,
    raw.reason,
    raw.verdict,
    raw.summary
  ].filter((item): item is string => typeof item === "string")).join("\n");
}

function extractFeedbackVerifierMeta(raw: unknown, lower: string): Record<string, unknown> | null {
  const looksVerifier = lower.includes("verifier") ||
    lower.includes("verification") ||
    lower.includes("counterexample") ||
    lower.includes("本任务评为反例");
  if (!looksVerifier && !isRecord(raw)) return null;
  const meta: Record<string, unknown> = { source: "feedback" };
  if (looksVerifier) meta.verifier = true;
  if (isRecord(raw)) {
    for (const key of ["verdict", "score", "reward", "passed", "taskId", "family", "reason"]) {
      if (raw[key] !== undefined) meta[key] = raw[key];
    }
  }
  return Object.keys(meta).length > 1 || looksVerifier ? meta : null;
}

function feedbackVerifierScore(raw: unknown): number {
  if (!isRecord(raw)) return 0;
  for (const key of ["score", "reward", "r", "rating"]) {
    const value = Number(raw[key]);
    if (Number.isFinite(value)) return Math.min(1, Math.abs(value));
  }
  return 0;
}

function isPositiveFeedbackExperience(
  feedback: FeedbackRecord,
  lower: string,
  shape: FeedbackTextShape,
  verifier: Record<string, unknown> | null
): boolean {
  if (feedback.polarity === "positive") return true;
  if (shape === "positive") return true;
  if (verifier && lower.includes("pass")) return true;
  return /\b(success|succeeded|passed|task succeeded|works well|correct)\b/.test(lower) ||
    /成功|通过|正确|太好了|写得很好/.test(lower);
}

function isNegativeFeedbackExperience(
  feedback: FeedbackRecord,
  lower: string,
  shape: FeedbackTextShape,
  verifier: Record<string, unknown> | null
): boolean {
  if (feedback.polarity === "negative") return true;
  if (shape === "negative" || shape === "correction") return true;
  if (verifier && /\b(fail|failed|counterexample)\b/.test(lower)) return true;
  return /\b(fail|failed|wrong|incorrect|counterexample|not acceptable)\b/.test(lower) ||
    /失败|错误|不对|反例/.test(lower);
}

function mergeFeedbackPolarity(
  current: FeedbackEvidencePolarity,
  next: FeedbackEvidencePolarity
): FeedbackEvidencePolarity {
  if (current === next) return current;
  if (current === "mixed" || next === "mixed") return "mixed";
  if (current === "neutral") return next;
  if (next === "neutral") return current;
  return "mixed";
}

function dedupeTextLines(values: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const line = value.trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

function firstLine(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
}

function fallbackImportSummary(trace: TraceMeta, memory: MemoryRow): string {
  const title = stringFromRecord(memory.info, "title");
  const summary = [trace.userText, trace.agentText, title]
    .map((value) => firstLine(value ?? ""))
    .find((value) => value && !isImportSummaryPlaceholder(value));
  return clip(summary || "导入记忆", 200);
}

function fallbackTraceSummary(trace: TraceMeta): string {
  return clip(firstLine([trace.summary, trace.userText, trace.agentText].filter(Boolean).join("\n")) || "trace memory", 200);
}

function deriveTopic(value: string): string {
  const withoutLabels = value
    .replace(/^(Turn|User|Assistant|Reasoning summary|Tool calls|Tool results):/gim, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = withoutLabels
    .split(/[\s,.;:!?()[\]{}"'`|/\\]+/)
    .filter((word) => word.length >= 3)
    .slice(0, 8);
  const topic = words.join(" ");
  return topic || clip(withoutLabels, 60) || "general task";
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function clip(value: string, max: number): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 3)}...`;
}

function tailClip(value: string, max: number): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `...${cleaned.slice(Math.max(0, cleaned.length - max))}`;
}

function llmFilterFallbackCap(hits: RecallHit[], maxKeep: number): RecallHit[] {
  const capped = Math.max(0, maxKeep);
  return capped === 0 ? [] : hits.slice(0, capped);
}

const TRACE_REFLECTION_SYNTH_SYSTEM_PROMPT = `You are reviewing a single step of an AI agent's decision.

Write a first-person reflection from the agent's perspective explaining WHY
it produced this response / tool calls given the user input. Keep it to
2-4 sentences, concrete, avoid repeating the visible action.

If the step is empty or incoherent, return exactly: NO_REFLECTION`;

const CAPTURE_SUMMARY_SYSTEM_PROMPT = `You extract the most useful durable fact from a single user/agent exchange for future retrieval.

Rules:
- Output MUST be a single JSON object: { "summary": "..." }
- Write in the user's original language.
- Target <= 200 characters, but preserving key facts is more important than
  exact length; do not hard-truncate. Unless the exchange is genuinely simple,
  use most of the 200-character budget to retain details and retrieval keywords.
- Preserve concrete retrieval anchors: names, aliases, dates, times, places,
  relationships, numbers, exact titles, object names, event names, preferences,
  decisions, commitments, outcomes, confirmed answers, file paths, commands,
  and error signatures.
- Treat the conversation as evidence, not the memory itself. Do NOT write vague
  summaries like "A and B discussed X" unless the discussion itself is the
  durable fact.
- Prefer atomic real-world facts: who did/wanted/said/decided what, when/where,
  and with what outcome.
- If multiple independent facts appear, cover every independently retrievable
  fact and list them compactly with semicolons instead of dropping one or
  merging them into a broad umbrella topic.
- For temporal facts, record the EVENT date/time, not just the conversation
  date/time. When a session timestamp and a relative expression are present,
  the summary MUST include the resolved absolute date/time. It may also retain
  the relative wording, but never use it instead of the absolute value. Example:
  a session on 22 October 2023 saying "bought it yesterday" means 21 October 2023.
  If exact resolution is impossible, retain the relative wording and its anchor.
- Use future-query words from the source. Prefer concrete event/action/object
  terms over generic words such as "support", "journey", "strength", or
  "discussion" unless those are the only durable fact.
- For images, files, or search results, preserve image captions, visible text,
  retrieval queries, topics, and answer-relevant evidence; omit raw URLs unless
  the URL itself is important.
- Preserve original speaker/person names. User/assistant roles may be import
  roles and must not replace real participants when names are present.
- Do not invent facts. Do not infer ownership from neighboring turns.
- Do NOT prefix with "The user said" / "用户说了". Just state the fact.
- If no durable fact is present, summarize the concrete request/result that
  would be most useful for retrieval.`;

interface BatchReflectionScore {
  idx: number;
  reflectionText: string;
  alpha: number;
  usable: boolean;
  reason?: string;
}

interface BatchReflectionPayloadStep {
  state?: unknown;
  thinking?: unknown;
  action?: unknown;
  tool_calls?: unknown;
}

function parseBatchReflectionScores(
  value: unknown,
  expected: number
): BatchReflectionScore[] {
  if (!Array.isArray(value) || value.length !== expected) {
    throw new Error(`batch reflection scores length mismatch: expected ${expected}`);
  }
  const byIdx = new Map<number, BatchReflectionScore>();
  value.forEach((item) => {
    if (!isRecord(item)) {
      throw new Error("batch reflection score must be an object");
    }
    const idx = numberOr(item.idx, NaN);
    if (!Number.isInteger(idx) || idx < 0 || idx >= expected) {
      throw new Error(`batch reflection score idx out of range: ${String(item.idx)}`);
    }
    const relevance = parseBatchReflectionRelevance(item.relevance);
    byIdx.set(idx, {
      idx,
      reflectionText: relevance,
      alpha: alphaForBatchReflectionRelevance(relevance),
      usable: relevance !== "IRRELEVANT",
      reason: typeof item.reason === "string" ? item.reason : undefined
    });
  });
  if (byIdx.size !== expected) {
    throw new Error(`batch reflection scores missing or duplicate idx: expected ${expected}`);
  }
  return Array.from({ length: expected }, (_, idx) => byIdx.get(idx)!);
}

function isDurableMemoryBatchReflectionStep(step: BatchReflectionPayloadStep | undefined): boolean {
  if (!step) return false;
  const text = [
    typeof step.state === "string" ? step.state : "",
    typeof step.action === "string" ? step.action : "",
    typeof step.thinking === "string" ? step.thinking : ""
  ].join("\n").trim();
  if (!text) return false;
  if (/(不知道|不清楚|没有记录|未记录|还没有记录|not know|don't know|do not know|no record|not recorded)/i.test(text)) {
    return false;
  }
  const questionOnly = /(什么|哪(?:个|种)?|是否|吗|？|\?|what|which|whether|do i|did i|have i)/i.test(text) &&
    !/(记住|记下|保存|已记录|remember(?:ed)?|noted|saved|store(?:d)?)/i.test(text);
  if (questionOnly) return false;
  return [
    /(?:我|我的|用户).{0,24}(?:喜欢|不喜欢|偏好|讨厌|过敏|常用|默认|名字|叫|生日|住在|来自).{0,80}(?:是|为|叫|用|吃|:|：|，|。)/i,
    /(?:记住|记下|保存|已记录).{0,80}(?:喜欢|偏好|不喜欢|过敏|默认|名字|生日|项目|决定|要求|约束)/i,
    /\b(?:my|the user's)\s+(?:name|preference|favorite|default|shell|email|birthday|timezone|requirement)\b.{0,80}\b(?:is|are|=|:)\b/i,
    /\b(?:i|the user)\s+(?:like|likes|prefer|prefers|dislike|dislikes|am allergic to|is allergic to)\b.{1,80}/i,
    /(?:这个项目|本项目|当前项目|the project|this project).{0,80}(?:使用|用|依赖|要求|默认|决定|保留|采用|uses|depends on|requires|defaults to|decided)/i,
    /(?:我们|已|已经)?决定.{0,80}(?:使用|采用|保留|删除|改为|保持|merge|keep|use|adopt|remove)/i
  ].some((pattern) => pattern.test(text));
}

function parseBatchReflectionRelevance(value: unknown): "IRRELEVANT" | "RELATED" | "PIVOTAL" {
  if (value === "IRRELEVANT" || value === "RELATED" || value === "PIVOTAL") return value;
  throw new Error(`batch reflection relevance invalid: ${String(value)}`);
}

function alphaForBatchReflectionRelevance(value: "IRRELEVANT" | "RELATED" | "PIVOTAL"): number {
  if (value === "IRRELEVANT") return 0;
  if (value === "PIVOTAL") return 1;
  return 0.5;
}

function isSocialOnlyBatchReflectionStep(step: BatchReflectionPayloadStep | undefined): boolean {
  if (!step) return false;
  const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
  if (toolCalls.length > 0) return false;
  const state = typeof step.state === "string" ? step.state.trim().toLowerCase() : "";
  if (!state) return false;
  if (batchReflectionWordCount(state) > 6) return false;
  if (isDurableMemoryBatchReflectionStep(step)) return false;
  const explicitSocialPattern =
    /(谢谢|感谢|辛苦|客气|不用谢|再见|拜拜|你好|您好|早上好|晚上好)|\b(?:thanks?|thank\s+you|appreciate|great\s+job|well\s+done|awesome|nice|you(?:'|’)re\s+welcome|no\s+problem|bye|goodbye|hello|hi)\b/i;
  const shortPraisePattern =
    /^(?:你|您|回答|做得)?[^\n]{0,8}(?:真棒|棒极了|做得好|很好|很对|厉害|太强了)[！!。.]*$/i;
  const substantiveSignalPattern =
    /[?？]|(?:请|帮我|推荐|介绍|解释|分析|比较|查询|查找|查一下|告诉我|为什么|怎么|如何|什么|哪(?:个|种|里)?|是否|是不是|能否|需要|想要|问题|关于|区别|原因)|\b(?:please|help|recommend|introduce|explain|analy[sz]e|compare|find|search|tell\s+me|why|how|what|which|where|whether|can\s+you|could\s+you|need|want|question|about)\b/i;
  const taskSignalPattern =
    /(修复|实现|改|更新|测试|报错|错误|命令|脚本|代码|函数|文件|数据库|sql|trace|episode|reward|reflection|alpha|value|fix|implement|update|test|error|command|script|code|function|file|db|database|query|bug|issue|task)/i;
  const socialIntent = explicitSocialPattern.test(state) || shortPraisePattern.test(state);
  return socialIntent && !substantiveSignalPattern.test(state) && !taskSignalPattern.test(state);
}

function batchReflectionWordCount(text: string): number {
  return Array.from(new Intl.Segmenter(undefined, { granularity: "word" }).segment(text))
    .filter((part) => part.isWordLike)
    .length;
}

function socialOnlyBatchReflectionScore(idx: number): BatchReflectionScore {
  return {
    idx,
    reflectionText: "IRRELEVANT",
    alpha: 0,
    usable: false,
    reason: "SOCIAL_ONLY"
  };
}

function mergeBatchWindowScores(length: number, windowScores: Map<number, BatchReflectionScore[]>): BatchReflectionScore[] {
  const merged = new Map<number, BatchReflectionScore>();
  const starts = [...windowScores.keys()].sort((a, b) => a - b);
  for (const start of starts) {
    const scores = windowScores.get(start) ?? [];
    for (let index = 0; index < scores.length; index += 1) {
      const absolute = start + index;
      const next = scores[index];
      if (!next) continue;
      const previous = merged.get(absolute);
      if (!previous || batchReflectionRank(next) > batchReflectionRank(previous)) {
        merged.set(absolute, { ...next, idx: absolute });
      }
    }
  }
  return Array.from({ length }, (_, idx) => merged.get(idx) ?? {
    idx,
    reflectionText: "RELATED_DEFAULT",
    alpha: 0.5,
    usable: true,
    reason: "MISSING_WINDOW_DEFAULT"
  });
}

function batchRelatedDefaultScores(
  length: number,
  steps?: readonly unknown[]
): BatchReflectionScore[] {
  return Array.from({ length }, (_, idx) => {
    const step = isRecord(steps?.[idx]) ? steps[idx] : undefined;
    return isSocialOnlyBatchReflectionStep(step)
      ? socialOnlyBatchReflectionScore(idx)
      : {
        idx,
        reflectionText: "RELATED_DEFAULT",
        alpha: 0.5,
        usable: true,
        reason: "FALLBACK_RELATED_DEFAULT"
      };
  });
}

function batchReflectionRank(score: BatchReflectionScore): number {
  const label = score.reflectionText.trim();
  if (label === "PIVOTAL") return 2;
  if (label === "RELATED" || label === "RELATED_DEFAULT") return 1;
  return 0;
}

function buildBatchWindows(length: number, windowSize: number, overlap: number): Array<{ start: number; end: number }> {
  if (length <= 0) return [];
  const out: Array<{ start: number; end: number }> = [];
  const stride = Math.max(1, windowSize - overlap);
  let start = 0;
  while (start < length) {
    const end = Math.min(length, start + windowSize);
    out.push({ start, end });
    if (end >= length) break;
    start += stride;
  }
  return out;
}

function batchTaskContext(episode: EpisodeRecord, rawTurns: readonly RawTurnRecord[], maxChars = 1200): string | null {
  const parts = [
    episode.title ? `Title: ${episode.title}` : "",
    episode.summary ? `Episode summary: ${episode.summary}` : "",
    ...rawTurns.slice(0, 6).map((turn) => summarizeTurn(turn))
  ].filter(Boolean);
  return parts.length ? clip(parts.join("\n\n"), maxChars) : null;
}

function traceSortKey(memory: MemoryRow): number {
  const trace = traceMetaFromMemory(memory);
  if (!trace) return Date.parse(memory.timeline);
  return Number.isFinite(trace.ts) ? trace.ts : Date.parse(memory.timeline);
}

function traceReflectionSource(memory: MemoryRow): "adapter" | "extracted" | "synth" | "none" {
  const trace = isRecord(memory.properties.internal_info.trace)
    ? memory.properties.internal_info.trace
    : {};
  const source = trace.reflection_source;
  return source === "adapter" || source === "extracted" || source === "synth" || source === "none"
    ? source
    : "synth";
}

function sanitizeReflectionText(value: string): string {
  return value
    .replace(/^```(?:json|text|markdown)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function sanitizeSummaryText(value: string): string {
  return value
    .replace(/^```(?:json|text|markdown)?/i, "")
    .replace(/```$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function reflectionContextIncludesDownstream(mode: string): boolean {
  return mode === "downstream" || mode === "task_downstream";
}

function reflectionContextIncludesTask(mode: string): boolean {
  return mode === "task" || mode === "task_downstream";
}

function traceDownstreamPreviewBlock(memory: MemoryRow, offset: number, maxChars: number): string {
  const trace = traceMetaFromMemory(memory);
  if (!trace) {
    return "";
  }
  if (trace.toolCalls.length > 0) {
    const lines = [
      `[step+${offset}] type=tooluse`,
      `tool_names: ${trace.toolCalls.map((call) => call.name).filter(Boolean).join(", ") || "(unknown)"}`,
      `tool_output: ${clip(trace.toolCalls.map((call) => {
        const label = call.error ? `${call.name} ERROR[${call.error}]` : call.name;
        return `${label}: ${stringifyForMemory(call.output) || "(no output)"}`;
      }).join("\n"), maxChars)}`
    ];
    if (trace.reflection?.trim()) {
      lines.push(`existing_reflection: ${clip(trace.reflection, Math.floor(maxChars / 2))}`);
    }
    return lines.join("\n");
  }
  return [
    `[step+${offset}] type=text`,
    clip([trace.userText, trace.agentText, trace.reflection ?? ""].filter(Boolean).join("\n"), maxChars) || "(empty)"
  ].join("\n");
}

function traceReflectionScorePayload(input: {
  taskSummary: string;
  userText: string;
  agentThinking?: string;
  agentText: string;
  toolCalls: ToolCallPayload[];
  downstreamPreview: string;
  reflectionText: string;
}): string {
  return [
    "TASK CONTEXT:",
    clip(input.taskSummary, 1200) || "(none)",
    "",
    "STATE:",
    clip(input.userText, 1200) || "(none)",
    "",
    "THINKING:",
    input.agentThinking ? clip(input.agentThinking, 1500) : "(none - model did not emit thinking this turn)",
    "",
    "ACTION:",
    clip(input.agentText, 1500) || "(none)",
    input.toolCalls.length > 0
      ? `\nTOOL_CALLS:\n${input.toolCalls.map(formatReflectionToolCall).join("\n")}`
      : "\nTOOL_CALLS: (none)",
    "",
    "OUTCOME:",
    lastReflectionToolOutcome(input.toolCalls, 600),
    "",
    "DOWNSTREAM STEP PREVIEW:",
    input.downstreamPreview || "(none)",
    "",
    "REFLECTION:",
    clip(input.reflectionText, 1500)
  ].join("\n");
}

function traceReflectionSynthPayload(input: {
  taskSummary: string;
  userText: string;
  agentThinking?: string;
  agentText: string;
  toolCalls: ToolCallPayload[];
  downstreamPreview: string;
}): string {
  return [
    "TASK CONTEXT:",
    clip(input.taskSummary, 1200) || "(none)",
    "",
    "USER/OBSERVATION:",
    clip(input.userText, 1200) || "(none)",
    "",
    "THINKING (model's native chain-of-thought, if any):",
    input.agentThinking ? clip(input.agentThinking, 1500) : "(none)",
    "",
    "AGENT ACTION:",
    clip(input.agentText, 1500) || "(none)",
    input.toolCalls.length > 0
      ? `\nTOOL CALLS:\n${input.toolCalls.map((call) => {
        const inputText = clip(stringifyForMemory(call.input), 400);
        return call.error
          ? `- ${call.name}(${inputText}) -> ERROR[${call.error}]`
          : `- ${call.name}(${inputText})`;
      }).join("\n")}`
      : "",
    "",
    "OUTCOME:",
    lastReflectionToolOutcome(input.toolCalls, 600),
    "",
    "DOWNSTREAM STEP PREVIEW:",
    input.downstreamPreview || "(none)"
  ].filter((line) => line !== "").join("\n");
}

function traceSummaryPayload(input: {
  userText: string;
  agentText: string;
  toolCalls: ToolCallPayload[];
  reflectionText: string;
}): string {
  const parts: string[] = [];
  if (input.userText) {
    parts.push(`USER:\n${clip(input.userText, 1400)}`);
  }
  if (input.agentText) {
    parts.push(`ASSISTANT:\n${clip(input.agentText, 1400)}`);
  }
  if (input.toolCalls.length > 0) {
    parts.push(`TOOLS:\n${clip(input.toolCalls.map((call) =>
      `${call.name}(${clip(stringifyForMemory(call.input), 120)})`
    ).join("; "), 400)}`);
  }
  if (input.reflectionText) {
    parts.push(`REFLECTION:\n${clip(input.reflectionText, 300)}`);
  }
  return clip(parts.join("\n\n"), 3500);
}

function formatReflectionToolCall(call: ToolCallPayload): string {
  const io = stringifyForMemory({
    input: call.input,
    output: call.output,
    error: call.error
  });
  return call.error
    ? `- ${call.name}(${clip(stringifyForMemory(call.input), 200)}) -> ERROR ${clip(call.error, 300)} ${clip(io, 300)}`
    : `- ${call.name}(${clip(stringifyForMemory(call.input), 200)}) -> ${clip(stringifyForMemory(call.output), 300)}`;
}

function lastReflectionToolOutcome(toolCalls: ToolCallPayload[], maxChars: number): string {
  const last = toolCalls[toolCalls.length - 1];
  if (!last) return "(assistant-only step)";
  const output = last.error
    ? `ERROR ${last.error} ${stringifyForMemory(last.output)}`
    : stringifyForMemory(last.output);
  return clip(output, maxChars);
}

function traceAgentThinking(memory: MemoryRow): string | undefined {
  const trace = memory.properties.internal_info.trace;
  if (!trace || typeof trace !== "object" || Array.isArray(trace)) {
    return undefined;
  }
  const thinking = (trace as { agent_thinking?: unknown }).agent_thinking;
  return typeof thinking === "string" && thinking.trim() ? thinking.trim() : undefined;
}

function capText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

function capSkillPromptText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

function normalizeQueryRewriteQueries(value: unknown): string[] {
  const items = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") continue;
    const query = singleLine(item).slice(0, 500);
    if (!query) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
    if (queries.length >= QUERY_REWRITE_COUNT) break;
  }
  return queries;
}

function mergeRetrievalResults(retrievals: RetrievalResult[], limit: number): RetrievalResult {
  const entries = new Map<string, {
    hit: RecallHit;
    score: number;
    firstRank: number;
    firstQueryIndex: number;
  }>();
  for (const [queryIndex, retrieval] of retrievals.entries()) {
    for (const [rank, hit] of retrieval.hits.entries()) {
      const existing = entries.get(hit.id);
      const entry = existing ?? {
        hit,
        score: 0,
        firstRank: rank,
        firstQueryIndex: queryIndex
      };
      entry.score += 1 / (rank + 1 + QUERY_REWRITE_RRF_CONSTANT);
      if (!existing || hit.score > existing.hit.score) {
        entry.hit = hit;
      }
      entry.firstRank = Math.min(entry.firstRank, rank);
      entry.firstQueryIndex = Math.min(entry.firstQueryIndex, queryIndex);
      entries.set(hit.id, entry);
    }
  }
  const rankedEntries = Array.from(entries.values())
    .sort((left, right) =>
      right.score - left.score ||
      left.firstRank - right.firstRank ||
      left.firstQueryIndex - right.firstQueryIndex
    );
  const perQueryKeep = Math.min(
    QUERY_REWRITE_PER_QUERY_MIN_KEEP,
    Math.max(1, Math.floor(Math.max(0, limit) / Math.max(1, retrievals.length)))
  );
  const reservedIds = new Set(
    retrievals.flatMap((retrieval) => retrieval.hits.slice(0, perQueryKeep).map((hit) => hit.id))
  );
  const selectedEntries = [
    ...rankedEntries.filter((entry) => reservedIds.has(entry.hit.id)),
    ...rankedEntries.filter((entry) => !reservedIds.has(entry.hit.id))
  ].slice(0, Math.max(0, limit));
  const hits = selectedEntries
    .map((entry) => ({
      ...entry.hit,
      score: roundNumber(entry.score)
    }));
  const kept = {
    tier1: hits.filter((hit) => recallHitTier(hit) === "tier1").length,
    tier2: hits.filter((hit) => recallHitTier(hit) === "tier2").length,
    tier3: hits.filter((hit) => recallHitTier(hit) === "tier3").length
  };
  return {
    hits,
    debug: {
      tierSizes: retrievals.reduce(
        (acc, retrieval) => ({
          tier1: acc.tier1 + retrieval.debug.tierSizes.tier1,
          tier2: acc.tier2 + retrieval.debug.tierSizes.tier2,
          tier3: acc.tier3 + retrieval.debug.tierSizes.tier3
        }),
        { tier1: 0, tier2: 0, tier3: 0 }
      ),
      kept,
      topRelevance: hits[0]?.score ?? 0,
      droppedByThreshold: retrievals.reduce((sum, retrieval) => sum + retrieval.debug.droppedByThreshold, 0)
    }
  };
}

function recallHitTier(hit: RecallHit): "tier1" | "tier2" | "tier3" {
  if (hit.memoryLayer === "Skill") return "tier1";
  if (hit.memoryLayer === "L3") return "tier3";
  return "tier2";
}

function uniq<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizePageNumber(value: number | undefined): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value!));
}

function normalizePanelItemsLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return PANEL_ITEMS_PAGE_SIZE;
  return clampNumber(Math.floor(value!), 1, 100);
}

function normalizeOffsetCursor(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function l2InductionInvalidReason(result: unknown): string | null {
  if (!isRecord(result)) return "llm-failed: l2.induction.invalid: non-object output";
  if (!firstString(result.title)) return "llm-failed: l2.induction.invalid: missing title";
  if (!firstString(result.trigger)) return "llm-failed: l2.induction.invalid: missing trigger";
  if (!firstString(result.procedure, result.action)) {
    return "llm-failed: l2.induction.invalid: missing procedure";
  }
  return null;
}

function l3AbstractionInvalidReason(result: unknown): string | null {
  if (!isRecord(result)) return "llm-failed: l3.abstraction.invalid: non-object output";
  if (!firstString(result.title)) return "llm-failed: l3.abstraction.invalid: missing title";
  for (const key of ["environment", "inference", "constraints"]) {
    if (!Array.isArray(result[key])) {
      return `llm-failed: l3.abstraction.invalid: missing ${key}`;
    }
  }
  return null;
}

function coerceSkillProcedureJson(result: Record<string, unknown>): Record<string, unknown> {
  const steps = coerceSkillSteps(result.steps);
  const preconditions = skillMarkdownArray(result.preconditions);
  const parameters = coerceSkillParameters(result.parameters);
  const examples = coerceSkillExamples(result.examples);
  const tags = skillTextArray(result.tags);
  const tools = skillTextArray(result.tools);
  return {
    retrievalBlurb: skillText(result.retrieval_blurb ?? result.retrievalBlurb),
    triggerContext: skillText(result.trigger_context ?? result.triggerContext),
    summary: skillText(result.summary),
    parameters,
    preconditions,
    steps,
    examples,
    decisionGuidance: coerceSkillDecisionGuidance(
      result.decisionGuidance ??
        result.decision_guidance
    ),
    tags: dedupeCaseInsensitiveStrings(tags),
    tools: dedupeCaseInsensitiveStrings(tools)
  };
}

function skillOutputLanguageFor(mode: "follow_policy" | "zh" | "en", detected: "auto" | "zh" | "en"): "zh" | "en" {
  if (mode === "zh" || mode === "en") return mode;
  return detected === "zh" ? "zh" : "en";
}

function skillEvidenceEpisode(
  runtime: Pick<Repositories["runtime"], "getEpisode">,
  episodeId: string | undefined
): EpisodeRecord | undefined {
  return episodeId ? runtime.getEpisode(episodeId) : undefined;
}

function skillEvidenceEpisodeOutcome(episode: EpisodeRecord | undefined): "success" | "failure" | "unknown" {
  const rTask = typeof episode?.rTask === "number" ? episode.rTask : undefined;
  if (rTask === undefined) return "unknown";
  if (rTask >= 0.5) return "success";
  if (rTask <= -0.15) return "failure";
  return "unknown";
}

type SkillRebuildLevel = "L0" | "L1" | "L2";

function skillRebuildPlan(
  policy: PolicyMeta,
  existingSkill: NonNullable<ReturnType<typeof skillMetaFromMemory>>,
  evidenceTraces: TraceMeta[]
): {
  level: SkillRebuildLevel;
  policyHash: string;
  incrementalEvidence: TraceMeta[];
  snapshot: Record<string, unknown>;
} {
  const policyHash = skillPolicyContentHash(policy);
  const previousPolicyHash = storedSkillPolicyContentHash(existingSkill.memory);
  const incrementalEvidence = evidenceTraces.filter((trace) => !existingSkill.evidenceAnchorIds.includes(trace.id));
  const level: SkillRebuildLevel = previousPolicyHash !== policyHash
    ? "L2"
    : incrementalEvidence.length === 0
    ? "L0"
    : incrementalEvidence.length >= 2
    ? "L2"
    : "L1";
  const procedure = skillProcedureJsonFromMemory(existingSkill.memory);
  return {
    level,
    policyHash,
    incrementalEvidence,
    snapshot: {
      name: existingSkill.name,
      retrieval_blurb: procedure.retrievalBlurb,
      trigger_context: procedure.triggerContext,
      summary: procedure.summary,
      step_titles: skillStepsFromProcedure(procedure).map((step) => step.title),
      decision_guidance: procedure.decisionGuidance ?? { preference: [], antiPattern: [] },
      policy_content_hash: previousPolicyHash
    }
  };
}

function skillPolicyContentHash(policy: PolicyMeta): string {
  return stableHash({
    title: policy.title,
    trigger: policy.trigger,
    procedure: policy.procedure,
    verification: policy.verification,
    boundary: policy.boundary,
    decisionGuidance: policy.decisionGuidance
  });
}

function storedSkillPolicyContentHash(memory: MemoryRow): string | null {
  const internal = memory.properties.internal_info;
  const skill = isRecord(internal.skill) ? internal.skill : {};
  const value = skill.policy_content_hash ?? internal.policy_content_hash;
  return typeof value === "string" && value ? value : null;
}

function skillProcedureJsonFromMemory(memory: MemoryRow | undefined): Record<string, unknown> {
  if (!memory) return {};
  const internal = memory.properties.internal_info;
  const skill = isRecord(internal.skill) ? internal.skill : {};
  const fromSkill = skill.procedure_json;
  if (isRecord(fromSkill)) return fromSkill;
  const fromInternal = internal.procedure_json;
  return isRecord(fromInternal) ? fromInternal : {};
}

function mergeSkillRebuildProcedureJson(
  existing: Record<string, unknown>,
  draft: Record<string, unknown>,
  level: SkillRebuildLevel,
  changedSections: string[]
): Record<string, unknown> {
  if (Object.keys(existing).length === 0 || level === "L2") {
    return draft;
  }
  const allowed = skillRebuildAllowedSections(level, changedSections);
  const mergeField = (field: string): unknown =>
    allowed.has(field) ? draft[field] ?? existing[field] : existing[field] ?? draft[field];
  return {
    retrievalBlurb: mergeField("retrievalBlurb"),
    triggerContext: mergeField("triggerContext"),
    summary: mergeField("summary"),
    parameters: mergeField("parameters"),
    preconditions: mergeField("preconditions"),
    steps: mergeField("steps"),
    examples: mergeField("examples"),
    decisionGuidance: mergeField("decisionGuidance"),
    tags: mergeField("tags"),
    tools: mergeField("tools")
  };
}

function skillRebuildAllowedSections(level: SkillRebuildLevel, changedSections: string[]): Set<string> {
  if (level === "L0") {
    return new Set(["retrievalBlurb", "summary"]);
  }
  const normalized = new Set(
    changedSections.map((section) => section.trim().toLowerCase().replace(/_/g, ""))
  );
  if (normalized.size === 0) {
    return new Set(["retrievalBlurb", "summary", "decisionGuidance", "steps"]);
  }
  const mapped = new Set<string>();
  if (normalized.has("retrievalblurb")) mapped.add("retrievalBlurb");
  if (normalized.has("triggercontext")) mapped.add("triggerContext");
  if (normalized.has("summary")) mapped.add("summary");
  if (normalized.has("parameters")) mapped.add("parameters");
  if (normalized.has("preconditions")) mapped.add("preconditions");
  if (normalized.has("steps")) mapped.add("steps");
  if (normalized.has("examples")) mapped.add("examples");
  if (normalized.has("decisionguidance")) mapped.add("decisionGuidance");
  if (normalized.has("tags")) mapped.add("tags");
  if (normalized.has("tools")) mapped.add("tools");
  return mapped.size > 0 ? mapped : new Set(["retrievalBlurb", "summary", "decisionGuidance", "steps"]);
}

function skillStepsFromProcedure(procedure: Record<string, unknown>): Array<{ title: string }> {
  if (!Array.isArray(procedure.steps)) return [];
  return procedure.steps
    .map((step) => isRecord(step) ? { title: skillText(step.title) || "Step" } : null)
    .filter((step): step is { title: string } => Boolean(step));
}

function skillCrystallizerInvalidReason(result: unknown): string | null {
  if (!isRecord(result)) return "llm-failed: skill.crystallize.invalid: non-object output";
  if (!skillText(result.retrieval_blurb ?? result.retrievalBlurb)) {
    return "llm-failed: skill.crystallize.invalid: missing retrieval_blurb";
  }
  if (!skillText(result.trigger_context ?? result.triggerContext)) {
    return "llm-failed: skill.crystallize.invalid: missing trigger_context";
  }
  if (!skillText(result.summary)) return "llm-failed: skill.crystallize.invalid: missing summary";
  if (coerceSkillSteps(result.steps).length === 0) {
    return "llm-failed: skill.crystallize.invalid: missing steps";
  }
  return null;
}

function detectSkillModelRefusal(value: unknown): boolean {
  for (const text of collectSkillStrings(value)) {
    if (detectSkillModelRefusalText(text)) return true;
  }
  return false;
}

function detectSkillModelRefusalText(text: string): boolean {
  const normalized = text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000)
    .replace(/^[\uFEFF\s"'“”‘’`*_>-]+/, "")
    .replace(/[’]/g, "'")
    .toLowerCase();
  return SKILL_REFUSAL_PREFIXES.some((prefix) => prefix.test(normalized));
}

function collectSkillStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectSkillStrings);
  if (!value || typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>).flatMap(collectSkillStrings);
}

const SKILL_REFUSAL_PREFIXES = [
  /^i am claude\b/,
  /^i(?:'|’)m claude\b/,
  /^as claude\b/,
  /^as an ai assistant created by anthropic\b/,
  /^as an ai (?:assistant|language model)\b/,
  /^i(?:'|’)m sorry(?:,| but)?\s+(?:i\s+)?(?:can(?:not|(?:'|’)t)|am unable to)\b/,
  /^i apologize(?:,| but)?\s+(?:i\s+)?(?:can(?:not|(?:'|’)t)|am unable to)\b/,
  /^i (?:can(?:not|(?:'|’)t)|am unable to)\s+(?:assist|help|fulfill|process|comply|provide|engage)\b/,
  /^i do not feel comfortable\b/,
  /^i do not actually have the ability\b/
];

function coerceWorldModelStructure(
  result: Record<string, unknown>,
  fallback: WorldModelDraft["structure"]
): WorldModelDraft["structure"] {
  const rawStructure = isRecord(result.structure) ? result.structure : {};
  return {
    environment: coerceWorldModelEntries(rawStructure.environment ?? result.environment, fallback.environment),
    inference: coerceWorldModelEntries(rawStructure.inference ?? result.inference, fallback.inference),
    constraints: coerceWorldModelEntries(rawStructure.constraints ?? result.constraints, fallback.constraints)
  };
}

function coerceWorldModelEntries(
  value: unknown,
  fallback: WorldModelDraft["structure"]["environment"]
): WorldModelDraft["structure"]["environment"] {
  if (!Array.isArray(value)) return fallback;
  const entries = value
    .map((item) => {
      if (!isRecord(item)) return null;
      const label = skillText(item.label);
      const description = skillMarkdown(firstString(item.description, item.body, item.text));
      if (!label && !description) return null;
      const evidenceIds = stringArray(item.evidenceIds ?? item.evidence_ids);
      return {
        label: label || description.slice(0, 32),
        description,
        ...(evidenceIds.length > 0 ? { evidenceIds } : {})
      };
    })
    .filter((item): item is WorldModelDraft["structure"]["environment"][number] => Boolean(item))
    .slice(0, 16);
  return entries.length > 0 ? entries : fallback;
}

function normaliseWorldModelTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniq(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0 && item.length < 24)
  ).slice(0, 6);
}

function renderWorldModelBody(
  title: string,
  structure: WorldModelDraft["structure"]
): string {
  const lines: string[] = [`# ${title}`, ""];
  if (structure.environment.length > 0) {
    lines.push("## Environment");
    for (const entry of structure.environment) lines.push(`- **${entry.label}** - ${entry.description}`);
    lines.push("");
  }
  if (structure.inference.length > 0) {
    lines.push("## Inference rules");
    for (const entry of structure.inference) lines.push(`- **${entry.label}** - ${entry.description}`);
    lines.push("");
  }
  if (structure.constraints.length > 0) {
    lines.push("## Constraints");
    for (const entry of structure.constraints) lines.push(`- **${entry.label}** - ${entry.description}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

function coerceSkillSteps(value: unknown): Array<{ title: string; body: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (isRecord(item)) {
        const title = skillText(item.title);
        const body = skillMarkdown(item.body);
        if (!title && !body) return undefined;
        return {
          title: title || body.slice(0, 32),
          body
        };
      }
      return undefined;
    })
    .filter((item): item is { title: string; body: string } => Boolean(item));
}

function coerceSkillParameters(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isRecord(item)) return undefined;
      const name = skillText(item.name);
      if (!name) return undefined;
      const rawType = skillText(item.type).toLowerCase();
      const type = rawType && ["string", "number", "boolean", "enum"].includes(rawType)
        ? rawType
        : "string";
      const out: Record<string, unknown> = {
        name,
        type,
        required: Boolean(item.required),
        description: skillMarkdown(item.description)
      };
      if (type === "enum") {
        out.enumValues = skillMarkdownArray(item.enum);
      }
      return out;
    })
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

function coerceSkillExamples(value: unknown): Array<{ input: string; expected: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isRecord(item)) return undefined;
      const input = skillMarkdown(item.input);
      const expected = skillMarkdown(item.expected);
      if (!input && !expected) return undefined;
      return { input, expected };
    })
    .filter((item): item is { input: string; expected: string } => Boolean(item));
}

function coerceSkillDecisionGuidance(value: unknown): { preference: string[]; antiPattern: string[] } {
  if (!isRecord(value)) return { preference: [], antiPattern: [] };
  return {
    preference: dedupeCaseInsensitiveStrings(skillMarkdownArray(value.preference)).slice(0, 5),
    antiPattern: dedupeCaseInsensitiveStrings(skillMarkdownArray(value.antiPattern ?? value.anti_pattern)).slice(0, 5)
  };
}

const SKILL_HTML_BLOCK_RE = /<\s*(script|style|iframe|object|embed|svg|math|template)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const SKILL_DANGEROUS_TAG_RE = /<\/?\s*(script|style|iframe|object|embed|svg|math|template)\b[^>]*>/gi;
const SKILL_HTML_TAG_RE = /<\/?[a-z][a-z0-9:-]*(?:\s+[^<>]*)?>/gi;
const SKILL_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const SKILL_MARKDOWN_LINK_RE = /(!?)\[([^\]\n]*)\]\(((?:\\.|[^()\n]|\([^()\n]*\))+)\)/g;

function skillTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => skillText(item)).filter(Boolean);
}

function skillMarkdownArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => skillMarkdown(item)).filter(Boolean);
}

function skillText(value: unknown): string {
  return stripDangerousMarkdownLinks(stripUnsafeHtml(skillRawString(value)))
    .replace(SKILL_CONTROL_RE, "")
    .trim();
}

function skillMarkdown(value: unknown): string {
  return stripDangerousMarkdownLinks(stripDangerousHtmlBlocks(skillRawString(value)))
    .replace(SKILL_CONTROL_RE, "")
    .trim();
}

function skillRawString(value: unknown): string {
  return value == null ? "" : String(value);
}

function stripUnsafeHtml(text: string): string {
  return text
    .replace(SKILL_HTML_BLOCK_RE, "")
    .replace(SKILL_HTML_TAG_RE, "");
}

function stripDangerousHtmlBlocks(text: string): string {
  return text.replace(SKILL_HTML_BLOCK_RE, "").replace(SKILL_DANGEROUS_TAG_RE, "");
}

function stripDangerousMarkdownLinks(text: string): string {
  return text.replace(SKILL_MARKDOWN_LINK_RE, (_match, bang: string, label: string, rawUrl: string) => {
    const url = rawUrl.trim();
    const firstToken = url.split(/\s+/)[0] ?? "";
    if (!isSafeLinkTarget(firstToken)) return `${bang}${label}`;
    return `${bang}[${label}](${url})`;
  });
}

function isSafeLinkTarget(raw: string): boolean {
  const target = raw.trim().replace(/^["'<]+|[>"']+$/g, "");
  if (!target) return false;
  if (target.startsWith("#") || target.startsWith("/") || target.startsWith("./") || target.startsWith("../")) {
    return true;
  }
  try {
    const url = new URL(target);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}

function coerceSkillName(value: unknown, fallback: string): string {
  const raw = skillRawString(value).trim() || fallback;
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  return normalized || "skill";
}

function renderSkillInvocationGuide(input: {
  name: string;
  displayTitle?: string;
  procedureJson: Record<string, unknown>;
  policy: PolicyMeta;
}): string {
  const procedure = input.procedureJson;
  const title = skillText(input.displayTitle || input.name);
  const lines: string[] = [`# ${title}`, ""];
  const retrievalBlurb = firstString(procedure.retrievalBlurb, procedure.retrieval_blurb);
  if (retrievalBlurb) {
    lines.push(retrievalBlurb, "");
  }
  const summary = firstString(procedure.summary);
  if (summary) {
    lines.push(summary, "");
  }
  const triggerContext = firstString(procedure.triggerContext, procedure.trigger_context);
  lines.push("**When to use**", triggerContext || input.policy.trigger.trim() || "(derived from policy)", "");

  const preconditions = stringArray(procedure.preconditions);
  if (preconditions.length > 0) {
    lines.push("**Preconditions**");
    for (const item of preconditions) lines.push(`- ${item}`);
    lines.push("");
  }

  const parameters = Array.isArray(procedure.parameters) ? procedure.parameters : [];
  if (parameters.length > 0) {
    lines.push("**Parameters**");
    for (const item of parameters) {
      if (!isRecord(item)) continue;
      const name = firstString(item.name);
      if (!name) continue;
      const type = firstString(item.type) ?? "string";
      const required = Boolean(item.required) ? " (required)" : "";
      const description = firstString(item.description) ?? "";
      lines.push(`- \`${name}\`: ${type}${required}${description ? ` - ${description}` : ""}`);
    }
    lines.push("");
  }

  const steps = coerceSkillSteps(procedure.steps);
  if (steps.length > 0) {
    lines.push("**Procedure**");
    steps.forEach((step, index) => {
      lines.push(`${index + 1}. **${step.title}** - ${step.body}`);
    });
    lines.push("");
  }

  const examples = Array.isArray(procedure.examples) ? procedure.examples : [];
  if (examples.length > 0) {
    lines.push("**Examples**");
    for (const item of examples) {
      if (!isRecord(item)) continue;
      const exampleInput = firstString(item.input);
      const expected = firstString(item.expected);
      if (!exampleInput && !expected) continue;
      lines.push(`- Input: \`${exampleInput ?? ""}\``);
      if (expected) lines.push(`  Expected: ${expected}`);
    }
    lines.push("");
  }

  const tools = stringArray(procedure.tools);
  if (tools.length > 0) {
    lines.push("**Tools used**");
    for (const tool of tools) lines.push(`- \`${tool}\``);
    lines.push("");
  }

  const guidance = coerceSkillDecisionGuidance(procedure.decisionGuidance ?? procedure.decision_guidance);
  if (guidance.preference.length > 0 || guidance.antiPattern.length > 0) {
    lines.push("**Decision guidance**");
    if (guidance.preference.length > 0) {
      lines.push("Prefer:");
      for (const item of guidance.preference) lines.push(`- ${item}`);
    }
    if (guidance.antiPattern.length > 0) {
      lines.push("Avoid:");
      for (const item of guidance.antiPattern) lines.push(`- ${item}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function dedupeCaseInsensitiveStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function panelSourceDistribution(memories: MemoryRow[]): Array<{ source: string; count: number; percentage: number }> {
  const counts = new Map<string, number>();
  for (const memory of memories) {
    const source = panelSourceForMemory(memory);
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([source, count]) => ({
      source,
      count,
      percentage: memories.length > 0 ? panelRoundDecimal((count / memories.length) * 100, 1) : 0
    }))
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
}

function panelTagsForMemory(memory: MemoryRow, processing?: MemoryProcessingRecord): string[] {
  return panelStatusTagsForMemory(memory, processing);
}

function panelStatusTagsForMemory(memory: MemoryRow, processing?: MemoryProcessingRecord): string[] {
  const tags = memory.tags.filter((tag) => !IMPORT_STATUS_TAGS.includes(tag));
  if (memory.status === "archived" || memory.status === "deleted" || !processing) {
    return tags;
  }
  const label = processing.state === "summary_pending" || processing.state === "summarizing"
    ? IMPORT_SUMMARY_PROCESSING_TAG
    : processing.state === "embedding_pending" || processing.state === "embedding"
      ? IMPORT_INDEXING_TAG
      : processing.state === "failed"
        ? IMPORT_FAILED_TAG
        : undefined;
  return label ? uniq([...tags, label]) : tags;
}

function panelSourceForMemory(memory: MemoryRow): string {
  const internalInfo: Record<string, unknown> = isRecord(memory.properties.internal_info)
    ? memory.properties.internal_info
    : {};
  const explicitSources = [memory.info.source, internalInfo.source];
  const explicitSource = firstString(...explicitSources.map(panelNormalizeExplicitSource));
  if (explicitSource) return explicitSource;

  const hostSource = firstString(
    panelNormalizeKnownSource(memory.sessionId),
    panelNormalizeKnownSource(memory.conversationId),
    panelNormalizeSourceAgent(memory.agentId),
    panelNormalizeSourceAgent(memory.appId)
  );
  if (hostSource) return hostSource;

  return explicitSources.some(panelIsInternalSourceValue) ? "memmy" : "unknown";
}

function panelNormalizeExplicitSource(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (panelIsInternalSource(normalized)) return undefined;
  return panelNormalizeKnownSource(normalized) ?? normalized;
}

function panelNormalizeKnownSource(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "claude" || normalized.startsWith("claude-")) return "claude-code";
  if (normalized === "open-code" || normalized.startsWith("open-code-")) return "opencode";
  for (const source of ["hermes", "openclaw", "codex", "cursor", "claude-code", "opencode", "manual", "memmy"]) {
    if (normalized === source || normalized.startsWith(`${source}-`)) return source;
  }
  return undefined;
}

function panelNormalizeSourceAgent(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim().toLowerCase();
  return panelNormalizeKnownSource(normalized) ?? normalized;
}

function panelIsInternalSourceValue(value: unknown): boolean {
  return typeof value === "string" && panelIsInternalSource(value.trim().toLowerCase());
}

function panelIsInternalSource(value: string): boolean {
  return /^(?:turn|worker|panel|system|feedback|memory|session|episode|recall|skill_trial|l2_candidate)(?:[.:_-]|$)/.test(value);
}

function panelCountByDate<T>(
  rows: T[],
  dates: string[],
  getTime: (row: T) => string | undefined
): Array<{ date: string; count: number }> {
  const counts = new Map(dates.map((date) => [date, 0]));
  for (const row of rows) {
    const key = panelDateKey(getTime(row));
    if (counts.has(key)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return dates.map((date) => ({ date, count: counts.get(date) ?? 0 }));
}

function panelToolLatency(logs: ApiLogRecord[], dates: string[]): {
  tools: Array<{ name: string; calls: number; avgMs: number; p95Ms: number }>;
  series: Array<{ name: string; points: Array<{ date: string; avgMs: number }> }>;
} {
  const byTool = new Map<ApiLogRecord["toolName"], ApiLogRecord[]>();
  for (const log of logs) {
    const current = byTool.get(log.toolName) ?? [];
    current.push(log);
    byTool.set(log.toolName, current);
  }

  const tools = Array.from(byTool.entries())
    .map(([name, rows]) => {
      const durations = rows.map((row) => Math.max(0, Math.round(row.durationMs)));
      return {
        name,
        calls: rows.length,
        avgMs: panelRoundInt(panelAverage(durations)),
        p95Ms: panelPercentile95(durations)
      };
    })
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));

  return {
    tools,
    series: tools.map((tool) => {
      const rows = byTool.get(tool.name as ApiLogRecord["toolName"]) ?? [];
      return {
        name: tool.name,
        points: dates.map((date) => {
          const durations = rows
            .filter((row) => panelDateKey(row.calledAt) === date)
            .map((row) => Math.max(0, Math.round(row.durationMs)));
          return { date, avgMs: panelRoundInt(panelAverage(durations)) };
        })
      };
    })
  };
}

function panelRecallScore(outputJson: string): number | undefined {
  const output = panelJsonObject(outputJson);
  const stats = isRecord(output.stats) ? output.stats : {};
  const score = stats.topRelevance;
  return typeof score === "number" && Number.isFinite(score) ? Math.max(0, score) : undefined;
}

function panelJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function panelLastSevenDateKeys(now: string): string[] {
  return panelDateKeys(now, 7);
}

function panelDateKeys(now: string, days: number): string[] {
  const parsed = Date.parse(now);
  const end = Number.isFinite(parsed) ? new Date(parsed) : new Date();
  return Array.from({ length: days }, (_item, index) => {
    const day = new Date(end);
    day.setUTCDate(end.getUTCDate() - (days - 1 - index));
    return day.toISOString().slice(0, 10);
  });
}

function panelDateKey(value: string | undefined): string {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : "";
}

function panelAverage(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function panelPercentile95(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
  return panelRoundInt(sorted[index] ?? 0);
}

function panelRoundInt(value: number): number {
  return Math.max(0, Math.round(value));
}

function panelRoundDecimal(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function traceMetaFromMemoryWithRaw(memory: MemoryRow, rawTurn?: RawTurnRecord): TraceMeta | null {
  const trace = traceMetaFromMemory(memory);
  if (!trace || !rawTurn) return trace;

  const internalTrace = isRecord(memory.properties.internal_info.trace)
    ? memory.properties.internal_info.trace
    : {};
  const rawSpan = isRecord(internalTrace.raw_span) ? internalTrace.raw_span : {};
  const hasUserSpan = rawSpan.user_text === true;
  const hasAgentSpan = rawSpan.agent_text === true;
  const isRedacted = Boolean(rawTurn.redactedAt || rawTurn.deletedAt);

  return {
    ...trace,
    toolCalls: isRedacted
      ? trace.toolCalls
      : rawTurn.toolCalls.filter(isToolCallPayload),
    userText: isRedacted
      ? (hasUserSpan ? "[REDACTED]" : trace.userText)
      : (trace.userText || (hasUserSpan ? rawTurn.userText ?? "" : "")),
    agentText: isRedacted
      ? (hasAgentSpan ? "[REDACTED]" : trace.agentText)
      : (trace.agentText || (hasAgentSpan ? rawTurn.assistantText ?? "" : ""))
  };
}

function rawTurnIdFromMemory(memory: MemoryRow): string | undefined {
  const sourceRawTurnId = memory.properties.internal_info.source_raw_turn_id;
  if (typeof sourceRawTurnId === "string" && sourceRawTurnId) return sourceRawTurnId;
  const rawTurnId = memory.properties.internal_info.raw_turn_id;
  if (typeof rawTurnId === "string" && rawTurnId) return rawTurnId;
  const trace = memory.properties.internal_info.trace;
  return isRecord(trace) ? stringFromRecord(trace, "raw_turn_id") : undefined;
}

function stringFromRecord(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function stringFromMaybeRecord(record: unknown, key: string): string | undefined {
  return isRecord(record) ? stringFromRecord(record, key) : undefined;
}

function numberFromRecord(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isToolCallPayload(value: unknown): value is ToolCallPayload {
  return isRecord(value) && typeof value.name === "string";
}

function errorMessageFromUnknown(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (isRecord(value)) {
    const message = value.error ?? value.message;
    if (typeof message === "string") return message;
  }
  return undefined;
}

function cloneMemmyConfig(config: MemmyConfig): MemmyConfig {
  return structuredClone(config);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function roundNumber(value: number, digits = 4): number {
  const base = Math.pow(10, digits);
  return Math.round(value * base) / base;
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "pass", "passed", "success", "succeeded", "ok"].includes(normalized)) return true;
      if (["false", "fail", "failed", "failure", "error"].includes(normalized)) return false;
    }
  }
  return undefined;
}

function l3CooldownKey(userId: string, domainKey: string): string {
  return `l3.lastRun.${userId}.${stableHash(domainKey).slice(0, 24)}`;
}
