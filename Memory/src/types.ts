export type IsoTime = string;
export const DEFAULT_NAMESPACE_SOURCE = "unknown";
export type Cursor = string;
export type MemoryLayer = "L1" | "L2" | "L3" | "Skill";
export type MemoryKind = "trace" | "policy" | "world_model" | "skill";
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
export type JobType =
  | "episode_idle_close"
  | "trace_summary"
  | "import_summary"
  | "reflection"
  | "embedding"
  | "reward"
  | "l2_association"
  | "l2_induction"
  | "l3_abstraction"
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

export interface MemoryFilter {
  userId?: string;
  sessionId?: string;
  conversationId?: string;
  agentId?: string;
  excludedAgentIds?: string[];
  appId?: string;
  memoryLayer?: MemoryLayer | MemoryLayer[];
  status?: MemoryStatus | MemoryStatus[];
  tags?: string[];
  ids?: string[];
}

export interface RecallHit {
  id: string;
  kind: MemoryKind;
  memoryLayer: MemoryLayer;
  status: MemoryStatus;
  title?: string;
  snippet: string;
  score: number;
  tags: string[];
  updatedAt?: IsoTime;
  source: "search" | "episode" | "rule" | "skill";
}

export interface InjectedContext {
  markdown: string;
  sections: Array<{
    id: string;
    title: string;
    kind: MemoryKind;
    memoryLayer: MemoryLayer;
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
  activeProfile: "account" | "byok";
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
    };
    evolution: {
      provider: string;
      model?: string;
      configured: boolean;
      remote: boolean;
      lastOkAt?: string;
      lastError?: string;
    };
    embedding: {
      provider: string;
      model?: string;
      configured: boolean;
      remote: boolean;
      lastOkAt?: string;
      lastError?: string;
    };
  };
  capabilities: {
    routes: string[];
    tools: string[];
    memoryLayers: MemoryLayer[];
    supportsCli: boolean;
  };
  serverTime: IsoTime;
}

export interface MemoryReloadConfigRequest extends RequestEnvelope {
  reason?: string;
}

export interface MemoryReloadConfigResponse {
  activeProfile: "account" | "byok";
  changed: boolean;
  requiresRestart: boolean;
  models: HealthResponse["models"];
  reloadedAt: IsoTime;
}
