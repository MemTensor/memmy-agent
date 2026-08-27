import type {
  L3WorldModelFeatures,
  L3WorldModelProtocolVersion,
  L3WorldModelTransition,
  WorkspaceHostId,
  WorkspaceUri
} from "@memmy/local-api-contracts";

export type {
  L3WorldModelBoundaryRequest,
  L3WorldModelBoundaryResponse,
  L3WorldModelBoundaryTrigger,
  L3WorldModelFeatures,
  L3WorldModelFieldName,
  L3WorldModelFields,
  L3WorldModelProtocolVersion,
  L3WorldModelRequestEnvelope,
  L3WorldModelRuntimeNamespace,
  L3WorldModelTraceHeadResponse,
  L3WorldModelTransition,
  SessionL3WorldModelContextResponse,
  WorkspaceHostId,
  WorkspaceIdentityFields,
  WorkspaceUri
} from "@memmy/local-api-contracts";

export type IsoTime = string;
export const DEFAULT_NAMESPACE_SOURCE = "unknown";
export type Cursor = string;
export type MemoryLayer = "L1" | "L2" | "L3" | "Skill";
export type RecallMemoryLayer = MemoryLayer | "UserMemory";
export type MemoryKind = "user_memory" | "trace" | "span" | "policy" | "world_model" | "skill";
export type MemoryStatus = "activated" | "resolving" | "archived" | "deleted";
export type RetrievalMode =
  | "search"
  | "turn_start"
  | "tool_driven"
  | "skill_invoke"
  | "sub_agent"
  | "decision_repair"
  | "world_model";
export type JobStatus = "queued" | "leased" | "succeeded" | "failed" | "dead_letter";
export type MemoryProcessingState =
  | "summary_pending"
  | "summarizing"
  | "embedding_pending"
  | "embedding"
  | "ready"
  | "ready_text_only"
  | "failed";
export type MemoryProcessingStage = "summary" | "embedding";
export type MemoryProcessingRetryAction = "retry" | "open_settings" | "none";

export interface MemoryProcessingRecord {
  memoryId: string;
  state: MemoryProcessingState;
  stage?: MemoryProcessingStage | null;
  activeJobId?: string | null;
  attemptCount: number;
  manualRetryCount: number;
  retryAction: MemoryProcessingRetryAction;
  errorCode?: string | null;
  errorMessage?: string | null;
  failedAt?: IsoTime | null;
  autoRetryScheduled?: boolean;
  updatedAt: IsoTime;
}
export type JobType =
  | "episode_idle_close"
  | "trace_summary"
  | "user_memory_embedding"
  | "import_summary"
  | "reflection"
  | "embedding"
  | "reward"
  | "span_big_turn"
  | "negative_experience"
  | "l2_association"
  | "l2_induction"
  | "l3_abstraction"
  | "l3_world_model_update"
  | "project_environment_profile"
  | "skill_crystallization"
  | "skill_trial_resolve";

export interface RuntimeNamespace {
  source: string;
  profileId: string;
  profileLabel?: string;
  projectId?: string;
  workspaceId?: string;
  workspacePath?: string;
  sessionKey?: string;
  userId?: string;
  tenantId?: string;
}

export interface RequestEnvelope {
  requestId?: string;
  adapterId?: string;
  source?: string;
  namespace?: RuntimeNamespace;
  /** IANA timezone for user-facing calendar and relative-time semantics. */
  timeZone?: string;
}

export interface ApiErrorBody {
  error: {
    code:
      | "invalid_argument"
      | "unauthorized"
      | "forbidden"
      | "not_found"
      | "conflict"
      | "rate_limited"
      | "internal";
    message: string;
    requestId?: string;
  };
}

export interface JobRef {
  jobId: string;
  jobType: JobType;
  status: JobStatus;
  targetMemoryId?: string;
}

export interface MemoryRow {
  id: string;
  timeline: IsoTime;
  userId: string;
  conversationId?: string;
  sessionId?: string;
  agentId?: string;
  appId?: string;
  memoryType: "LongTermMemory" | "SkillMemory" | string;
  status: MemoryStatus;
  visibility: "private" | "public" | "session" | string;
  memoryKey?: string;
  memoryValue: string;
  tags: string[];
  info: Record<string, unknown>;
  properties: {
    memory_type?: string;
    status?: MemoryStatus;
    tags?: string[];
    info?: Record<string, unknown>;
    internal_info: Record<string, unknown> & {
      memory_layer: MemoryLayer;
      memory_kind?: MemoryKind;
      schema_version?: number;
    };
    [key: string]: unknown;
  };
  memoryLayer: MemoryLayer;
  contentHash?: string | null;
  version: number;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  deletedAt?: IsoTime | null;
}

/** Narrow projection used by aggregate read models without loading memory payloads or vectors. */
export interface MemoryStatsRow {
  conversationId?: string;
  sessionId?: string;
  agentId?: string;
  appId?: string;
  status: MemoryStatus;
  memoryLayer: MemoryLayer;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  infoSource?: unknown;
  internalSource?: unknown;
}

export interface MemoryFilter {
  userId?: string;
  sessionId?: string;
  conversationId?: string;
  agentId?: string;
  excludedAgentIds?: string[];
  appId?: string;
  createdAtGte?: IsoTime;
  createdAtLt?: IsoTime;
  memoryLayer?: MemoryLayer | MemoryLayer[];
  status?: MemoryStatus | MemoryStatus[];
  tags?: string[];
  ids?: string[];
}

export interface RecallHit {
  id: string;
  kind: MemoryKind;
  memoryLayer: RecallMemoryLayer;
  status: MemoryStatus;
  title?: string;
  snippet: string;
  score: number;
  tags: string[];
  createdAt?: IsoTime;
  updatedAt?: IsoTime;
  source: "search" | "episode" | "rule" | "skill";
  sourceTurnId?: string;
  memberMemoryIds?: string[];
  retrievalRoutes?: Array<"user_memory" | "l1" | "agent_memory">;
  sourceAgentId?: string;
  sourceSkillId?: string;
  sourceSkillVersion?: string;
  readOnly?: boolean;
  members?: Array<{
    id: string;
    kind: MemoryKind;
    memoryLayer: RecallMemoryLayer;
    status: MemoryStatus | UserMemoryStatus;
    content: string;
    createdAt: IsoTime;
    updatedAt: IsoTime;
    retrievalRoute: "user_memory" | "l1" | "agent_memory";
  }>;
}

export interface InjectedContext {
  markdown: string;
  sections: Array<{
    id: string;
    title: string;
    kind: MemoryKind;
    memoryLayer: RecallMemoryLayer;
    memoryIds: string[];
    content: string;
    tokenEstimate?: number;
  }>;
  tokenEstimate?: number;
}

export interface MemoryListItem {
  id: string;
  kind: MemoryKind;
  memoryLayer: MemoryLayer;
  status: MemoryStatus;
  title: string;
  summary: string;
  tags: string[];
  metrics?: {
    value?: number;
    alpha?: number;
    reflectionDone: boolean;
  };
  metadata?: Record<string, unknown>;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  version: number;
  processing?: MemoryProcessingRecord;
}

export type WorldModelScope =
  | { kind: "general" }
  | {
      kind: "project";
      projectLabel: string | null;
      workspaceDisplayPath: string | null;
    };

export interface PanelMemoryListItem extends Omit<MemoryListItem, "memoryLayer"> {
  memoryLayer: RecallMemoryLayer;
  worldModelScope?: WorldModelScope;
}

export interface MemoryDetailItem extends MemoryListItem {
  body: string;
  createdAt: IsoTime;
  sourceMemoryIds: string[];
  metadata: Record<string, unknown>;
}

export interface RawTurnSummary {
  rawTurnId: string;
  episodeId: string;
  turnId: string;
  userText?: string;
  assistantText?: string;
  reasoningSummary?: string;
  toolCalls?: unknown[];
  toolResults?: unknown[];
  createdAt: IsoTime;
}

export interface ToolCallPayload {
  id?: string;
  name: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  errorCode?: string;
  success?: boolean;
  startedAt?: IsoTime;
  endedAt?: IsoTime;
  thinkingBefore?: string;
  assistantTextBefore?: string;
}

export interface SessionCompactRequest extends RequestEnvelope {
  episodeId?: string;
  summary?: string;
  sourceTurnIds?: string[];
  sourceMemoryIds?: string[];
  tokenEstimate?: number;
  createL1?: boolean;
}

export interface SessionOpenRequest extends RequestEnvelope {
  source?: string;
  profileId?: string;
  l3WorldModelProtocolVersion?: L3WorldModelProtocolVersion;
  l3WorldModelTransition?: L3WorldModelTransition;
  workspaceUri?: WorkspaceUri;
  workspaceHostId?: WorkspaceHostId;
  projectId?: string;
  workspaceId?: string;
  workspacePath?: string;
  sessionId?: string;
  meta?: Record<string, unknown>;
}

export interface TurnStartRequest extends RequestEnvelope {
  sessionId: string;
  query: string;
  turnId?: string;
  layers?: MemoryLayer[];
  contextHints?: Record<string, unknown>;
  contextBudget?: number;
}

export interface TurnCompleteRequest extends RequestEnvelope {
  sessionId: string;
  episodeId?: string;
  query: string;
  answer: string;
  reasoningSummary?: string;
  tags?: string[];
  toolCalls?: unknown[];
  toolResults?: unknown[];
  artifacts?: unknown[];
  sourceMemoryIds?: string[];
  usage?: Record<string, unknown>;
  status?: "succeeded" | "failed" | "cancelled";
  userMemoryCorrection?: {
    targetMemoryId: string;
    revisedContent: string;
  };
}

export type UserMemoryType = "User Fact" | "User Preference" | "User Directive";
export type UserMemoryStatus = "active" | "archived" | "deleted";

export interface UserMemoryRecord {
  id: string;
  sourceTurnId: string;
  userId: string;
  memoryTypes: UserMemoryType[];
  content: string;
  normalizedUserTextHash: string;
  sourceTurnRefs: string[];
  status: UserMemoryStatus;
  replacesMemoryId?: string;
  replacedByMemoryId?: string;
  archivedAt?: IsoTime | null;
  archiveReason?: string;
  embedding?: number[];
  embeddingModel?: string;
  embeddingProvider?: string;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  deletedAt?: IsoTime | null;
}

export interface ToolObserveRequest extends RequestEnvelope {
  sessionId: string;
  episodeId?: string;
  turnId?: string;
  toolName: string;
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
  error?: unknown;
  metadata?: Record<string, unknown>;
}

export interface RepairSuggestionRequest extends RequestEnvelope {
  sessionId: string;
  toolName?: string;
  issue: string;
  error?: unknown;
  context?: string;
  metadata?: Record<string, unknown>;
}

export interface SubagentStartRequest extends RequestEnvelope {
  sessionId: string;
  episodeId?: string;
  subagentId?: string;
  task: string;
  metadata?: Record<string, unknown>;
}

export interface SubagentCompleteRequest extends RequestEnvelope {
  sessionId: string;
  episodeId?: string;
  subagentId?: string;
  result?: string;
  summary?: string;
  status?: "succeeded" | "failed" | "cancelled";
  metadata?: Record<string, unknown>;
}

export interface MemorySearchRequest extends RequestEnvelope {
  query: string;
  sessionId?: string;
  episodeId?: string;
  turnId?: string;
  layers?: MemoryLayer[];
  tags?: string[];
  limit?: number;
  contextBudget?: number;
  includeInjectedContext?: boolean;
  verbose?: boolean;
}

export interface MemoryAddRequest extends RequestEnvelope {
  content: string;
  layer?: MemoryLayer;
  title?: string;
  tags?: string[];
  source?: string;
  sessionId?: string;
  turnId?: string;
  createdAt?: string;
  deferProcessing?: boolean;
  sourceAgentId?: string;
  sourceSkillId?: string;
  sourceSkillPath?: string;
  sourceSkillVersion?: string;
  sourceContentHash?: string;
}

export interface FeedbackTarget {
  kind: "memory" | "raw_turn" | "recall";
  id: string;
}

export interface FeedbackRequest extends RequestEnvelope {
  sessionId?: string;
  episodeId?: string;
  target?: FeedbackTarget;
  channel: "explicit" | "implicit";
  polarity: "positive" | "negative" | "neutral";
  magnitude?: number;
  rationale?: string;

  // Internal attribution fields. HTTP and CLI expose `target` instead.
  l1MemoryId?: string;
  rawTurnId?: string;
  recallEventId?: string;
  rawPayload?: unknown;
}

export interface SkillUseRequest extends RequestEnvelope {
  sessionId: string;
  episodeId: string;
  l1MemoryId?: string;
  rawTurnId?: string;
  turnId?: string;
  toolCallId?: string;
}

export interface MemoryExportRequest extends RequestEnvelope {
  includeRawText?: boolean;
  includeAudit?: boolean;
}

export interface MemoryImportRequest extends RequestEnvelope {
  bundle: {
    schemaVersion?: number;
    exportedAt?: IsoTime;
    tables: Record<string, unknown>;
    manifest?: Record<string, unknown>;
  };
  conflictStrategy?: "skip" | "replace" | "error";
}

export interface MemoryGovernanceRequest extends RequestEnvelope {
  reason?: string;
}

export interface RawTurnRedactRequest extends RequestEnvelope {
  reason?: string;
  mode?: "redact" | "delete";
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  uptimeMs: number;
  mode: "local" | "cloud" | "dev";
  storage: {
    backend: "sqlite" | "openmem-cloud-rest";
    backendId?: "sqlite-local" | "openmem-cloud-rest";
    schemaVersion: string;
    ready: boolean;
    lastMigrationId?: string;
    fullText?: "fts5" | "tsvector" | "remote" | "none";
    vector?: "sidecar" | "native" | "remote" | "none";
    changeLog?: boolean;
    idempotency?: boolean;
    jobs?: boolean;
    importExport?: boolean;
  };
  models: {
    summary: {
      provider: string;
      model?: string;
      configured: boolean;
      remote: boolean;
      lastOkAt?: string;
      lastError?: string;
      routing: "follow" | "fixed" | null;
    };
    evolution: {
      provider: string;
      model?: string;
      configured: boolean;
      remote: boolean;
      lastOkAt?: string;
      lastError?: string;
      routing: "follow" | "fixed" | null;
    };
    embedding: {
      provider: string;
      model?: string;
      configured: boolean;
      remote: boolean;
      lastOkAt?: string;
      lastError?: string;
      mode: "cloud" | "local" | "custom" | null;
    };
  };
  capabilities: {
    routes: string[];
    tools: string[];
    memoryLayers: MemoryLayer[];
    supportsCli: boolean;
  };
  features?: L3WorldModelFeatures;
  serverTime: IsoTime;
}

export interface MemoryReloadConfigRequest extends RequestEnvelope {
  reason?: string;
  restartFailedProcessing?: boolean;
}

export interface MemoryReloadConfigResponse {
  changed: boolean;
  requiresRestart: boolean;
  models: HealthResponse["models"];
  reloadedAt: IsoTime;
}
