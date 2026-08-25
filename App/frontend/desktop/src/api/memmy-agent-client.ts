/**
 * memmy-agent WebUI gateway client.
 *
 * This client talks to the local memmy-agent WebUI HTTP + WebSocket gateway.
 * It is separate from the desktop local API client because it uses bootstrap
 * bearer tokens and a WebSocket protocol owned by memmy-agent.
 */
import { z } from "zod";

export type AgentGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usage_limited"
  | "budget_limited"
  | "completed";

export type AgentGoalState = {
  goal_id: string | null;
  status: AgentGoalStatus | null;
  objective: string;
  token_budget: number | null;
  tokens_used: number;
  time_used_seconds: number;
  created_at: string | null;
  updated_at: string | null;
};

export type AgentGoalControlAction = "pause" | "resume" | "edit" | "set_budget" | "clear";

export type AgentGoalControlInput = {
  chatId: string;
  goalId: string;
  action: AgentGoalControlAction;
  requestId?: string;
  objective?: string;
  tokenBudget?: number | null;
};

export type AgentGoalControlResult = {
  ok: true;
  requestId: string;
  warning?: "turn_cancel_failed";
};

const AgentGoalStateSchema = z.object({
  goal_id: z.string().nullable(),
  status: z.union([
    z.literal("active"),
    z.literal("paused"),
    z.literal("blocked"),
    z.literal("usage_limited"),
    z.literal("budget_limited"),
    z.literal("completed")
  ]).nullable(),
  objective: z.string(),
  token_budget: z.number().int().positive().nullable(),
  tokens_used: z.number().int().nonnegative(),
  time_used_seconds: z.number().int().nonnegative(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable()
}).strict();

export function isAgentGoalStatus(value: unknown): value is AgentGoalStatus {
  return value === "active"
    || value === "paused"
    || value === "blocked"
    || value === "usage_limited"
    || value === "budget_limited"
    || value === "completed";
}

export function isAgentGoalState(value: unknown): value is AgentGoalState {
  return AgentGoalStateSchema.safeParse(value).success;
}

export const DEFAULT_MEMMY_AGENT_WEBUI_BASE_URL = "http://127.0.0.1:18980";
const WEBUI_TOKEN_REFRESH_SKEW_MS = 30_000;

const ModelSelectionWireSchema = z.object({
  preset_id: z.string().min(1),
  provider: z.string().min(1),
  endpoint_id: z.string().min(1),
  protocol: z.string().min(1),
  model: z.string().min(1),
  source: z.enum(["account", "byok"]),
  owner_account_id: z.string().min(1).nullable().optional(),
  capabilities: z.array(z.string().min(1))
}).strict();

export type MemmyAgentModelSelection = {
  presetId: string;
  provider: string;
  endpointId: string;
  protocol: string;
  model: string;
  source: "account" | "byok";
  ownerAccountId: string | null;
  capabilities: string[];
};

export function parseMemmyAgentModelSelection(value: unknown): MemmyAgentModelSelection | null {
  const parsed = ModelSelectionWireSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    presetId: parsed.data.preset_id,
    provider: parsed.data.provider,
    endpointId: parsed.data.endpoint_id,
    protocol: parsed.data.protocol,
    model: parsed.data.model,
    source: parsed.data.source,
    ownerAccountId: parsed.data.owner_account_id ?? null,
    capabilities: [...parsed.data.capabilities]
  };
}

const ModelSelectionSchema = ModelSelectionWireSchema.transform((value): MemmyAgentModelSelection => ({
  presetId: value.preset_id,
  provider: value.provider,
  endpointId: value.endpoint_id,
  protocol: value.protocol,
  model: value.model,
  source: value.source,
  ownerAccountId: value.owner_account_id ?? null,
  capabilities: [...value.capabilities]
}));

const BootstrapSchema = z.object({
  token: z.string(),
  ws_path: z.string(),
  expires_in: z.number(),
  model_name: z.string().nullable(),
  model_selection: ModelSelectionSchema.nullable().optional()
});

const ChatModelPresetSchema = z.object({
  name: z.string(),
  provider: z.string(),
  model: z.string(),
  is_default: z.boolean(),
  available: z.boolean()
});

const AgentSettingsSchema = z.object({
  agent: z.object({
    model_preset: z.string().nullable()
  }).passthrough(),
  model_presets: z.array(ChatModelPresetSchema)
}).passthrough();

const SessionSummarySchema = z.object({
  key: z.string(),
  title: z.string().optional(),
  preview: z.string().optional(),
  updatedAt: z.string().optional(),
  run_started_at: z.number().optional(),
  projectId: z.string().nullable(),
  cwd: z.string(),
  model_preset: z.string().nullable().optional(),
  model_selection: ModelSelectionSchema.nullable().optional()
}).passthrough();

const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  rootPath: z.string(),
  pinned: z.boolean(),
  createdAt: z.string()
});

const SessionSnapshotSchema = z.object({
  projectRegistryState: z.union([z.literal("ready"), z.literal("corrupt")]),
  projects: z.array(ProjectSchema),
  sessions: z.array(SessionSummarySchema)
});

const WorkspaceEnvironmentFileSchema = z.object({
  path: z.string(),
  status: z.string(),
  staged: z.boolean(),
  unstaged: z.boolean(),
  untracked: z.boolean(),
  conflict: z.boolean(),
  additions: z.number().nullable(),
  deletions: z.number().nullable(),
  attribution: z.union([
    z.literal("goal"),
    z.literal("preexisting"),
    z.literal("uncertain"),
    z.literal("unattributed")
  ])
});

const WorkspaceEnvironmentSnapshotSchema = z.object({
  scope_kind: z.union([z.literal("session"), z.literal("project")]),
  scope_key: z.string(),
  cwd: z.string(),
  status: z.union([
    z.literal("ready"),
    z.literal("not_git"),
    z.literal("workspace_unavailable"),
    z.literal("error")
  ]),
  revision: z.string(),
  captured_at: z.string(),
  repository: z.object({
    display_name: z.string(),
    root: z.string(),
    head_sha: z.string(),
    branch: z.string().nullable(),
    detached: z.boolean(),
    upstream: z.string().nullable(),
    ahead: z.number(),
    behind: z.number(),
    worktree: z.union([z.literal("clean"), z.literal("dirty")])
  }).nullable(),
  changes: z.object({
    file_count: z.number(),
    additions: z.number().nullable(),
    deletions: z.number().nullable(),
    conflicts: z.number(),
    staged: z.number(),
    unstaged: z.number(),
    untracked: z.number()
  }).nullable(),
  goal: z.object({
    goal_id: z.string(),
    base_head: z.string().nullable(),
    base_branch: z.string().nullable(),
    goal_files: z.number(),
    preexisting_files: z.number(),
    uncertain_files: z.number(),
    verification: z.union([
      z.literal("not_run"),
      z.literal("running"),
      z.literal("passed"),
      z.literal("failed"),
      z.literal("stale")
    ]),
    completion_audit: z.union([z.literal("pending"), z.literal("risk"), z.literal("satisfied")]),
    baseline_status: z.union([z.literal("captured"), z.literal("unavailable")])
  }).nullable()
});

const WorkspaceEnvironmentStateSchema = z.object({
  snapshot: WorkspaceEnvironmentSnapshotSchema,
  files: z.array(WorkspaceEnvironmentFileSchema),
  branches: z.array(z.string())
});

const WorkspaceEnvironmentDiffSchema = z.object({
  path: z.string(),
  diff: z.string(),
  truncated: z.boolean(),
  unavailable_reason: z.string().nullable()
});

const WorkspaceFileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.union([z.literal("directory"), z.literal("file")]),
  size: z.number().int().nonnegative().nullable(),
  modifiedAt: z.string().nullable()
});

const WorkspaceFilesListingSchema = z.object({
  root: z.object({
    kind: z.union([z.literal("project"), z.literal("task")]),
    label: z.string()
  }),
  path: z.string(),
  entries: z.array(WorkspaceFileEntrySchema),
  truncated: z.boolean()
});

const ProjectMutationResponseSchema = z.object({
  project: ProjectSchema,
  snapshot: SessionSnapshotSchema
});

const ProjectDeleteResponseSchema = z.object({
  deletedId: z.string(),
  deletedSessionKeys: z.array(z.string()),
  snapshot: SessionSnapshotSchema
});

const ProjectRevealResponseSchema = z.object({
  ok: z.literal(true)
});

const SlashCommandSchema = z.object({
  command: z.string(),
  title: z.string(),
  description: z.string(),
  icon: z.string(),
  arg_hint: z.string()
});

const SlashCommandsResponseSchema = z.object({
  commands: z.array(SlashCommandSchema)
});

const WEBUI_HIDDEN_SLASH_COMMANDS = new Set([
  "/stop",
  "/restart",
  "/dream",
  "/dream-log",
  "/dream-restore",
  "/history",
  "/pairing",
  "/help",
  "/model"
]);

const SidebarStateSchema = z.object({
  schema_version: z.literal(1),
  pinned_keys: z.array(z.string()),
  archived_keys: z.array(z.string()),
  title_overrides: z.record(z.string(), z.string()),
  tags_by_key: z.record(z.string(), z.array(z.string())),
  collapsed_groups: z.record(z.string(), z.boolean()),
  view: z.object({
    density: z.union([z.literal("comfortable"), z.literal("compact")]),
    show_previews: z.boolean(),
    show_timestamps: z.boolean(),
    show_archived: z.boolean(),
    show_project_archived: z.boolean(),
    sort: z.union([z.literal("updated_desc"), z.literal("created_desc"), z.literal("title_asc")])
  }),
  updated_at: z.string().nullable()
});

const WebuiThreadSchema = z.object({
  schemaVersion: z.number(),
  sessionKey: z.string(),
  last_turn_id: z.string().min(1).optional(),
  last_turn_closed: z.boolean().optional(),
  last_turn_goal_id: z.string().uuid().optional(),
  last_turn_goal_outcome: z.union([
    z.literal("active"),
    z.literal("paused"),
    z.literal("blocked"),
    z.literal("usage_limited"),
    z.literal("budget_limited"),
    z.literal("completed")
  ]).optional(),
  messages: z.array(z.record(z.string(), z.unknown()))
}).superRefine((value, context) => {
  if ((value.last_turn_goal_id === undefined) !== (value.last_turn_goal_outcome === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "last Turn Goal identity and outcome must be paired"
    });
  }
});

const SeedWebuiChatResponseSchema = z.object({
  chat_id: z.string().min(1),
  session_key: z.string().min(1)
});

const LastCompactionSchema = z.object({
  available: z.boolean(),
  sessionKey: z.string(),
  mode: z.union([z.literal("text"), z.literal("dag")]).nullable(),
  text: z.string(),
  lastActive: z.string().nullable(),
  dagSnapshotId: z.string().optional()
});

const DeleteSessionResponseSchema = z.object({
  deleted: z.boolean()
});

const RenameSessionResponseSchema = z.object({
  session: SessionSummarySchema
});

const ResolvedArtifactSchema = z.object({
  ok: z.literal(true),
  path: z.string(),
  name: z.string(),
  kind: z.union([z.literal("image"), z.literal("video"), z.literal("file"), z.literal("directory")]),
  media_url: z.string().optional()
});

const RevealArtifactResponseSchema = z.object({
  ok: z.literal(true),
  path: z.string()
});

const UploadedAgentImageMimeSchema = z.union([
  z.literal("image/png"),
  z.literal("image/jpeg"),
  z.literal("image/webp"),
  z.literal("image/gif")
]);

const UploadedAgentFileMimeSchema = z.union([
  z.literal("application/pdf"),
  z.literal("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
  z.literal("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
  z.literal("application/vnd.openxmlformats-officedocument.presentationml.presentation"),
  z.literal("text/plain"),
  z.literal("text/markdown"),
  z.literal("text/csv"),
  z.literal("application/json"),
  z.literal("application/xml"),
  z.literal("text/xml"),
  z.literal("text/html"),
  z.literal("application/yaml"),
  z.literal("text/yaml"),
  z.literal("application/toml")
]);

const UploadedAgentImageSchema = z.object({
  path: z.string(),
  url: z.string(),
  name: z.string(),
  kind: z.literal("image"),
  mime: UploadedAgentImageMimeSchema,
  bytes: z.number()
});

const UploadedAgentFileSchema = z.object({
  path: z.string(),
  url: z.string(),
  name: z.string(),
  kind: z.literal("file"),
  mime: UploadedAgentFileMimeSchema,
  bytes: z.number()
});

const UploadedAgentMediaSchema = z.discriminatedUnion("kind", [
  UploadedAgentImageSchema,
  UploadedAgentFileSchema
]);

const UploadedAgentMediaResponseSchema = z.object({
  attachments: z.array(UploadedAgentMediaSchema).optional(),
  images: z.array(UploadedAgentImageSchema).optional()
});

export type MemmyAgentBootstrap = z.infer<typeof BootstrapSchema>;
export type ChatModelPreset = z.infer<typeof ChatModelPresetSchema>;
export type MemmyAgentSettings = z.infer<typeof AgentSettingsSchema>;
export type MemmyAgentSessionSummary = z.infer<typeof SessionSummarySchema>;
export type WorkspaceEnvironmentSnapshot = z.infer<typeof WorkspaceEnvironmentSnapshotSchema>;
export type WorkspaceEnvironmentFile = z.infer<typeof WorkspaceEnvironmentFileSchema>;
export type WorkspaceEnvironmentState = z.infer<typeof WorkspaceEnvironmentStateSchema>;
export type WorkspaceEnvironmentDiff = z.infer<typeof WorkspaceEnvironmentDiffSchema>;
export type WorkspaceEnvironmentScope = { kind: "session" | "project"; key: string };
export type WorkspaceFileEntry = z.infer<typeof WorkspaceFileEntrySchema>;
export type WorkspaceFilesListing = z.infer<typeof WorkspaceFilesListingSchema>;
export type MemmyAgentProject = z.infer<typeof ProjectSchema>;
export type MemmyAgentSessionSnapshot = z.infer<typeof SessionSnapshotSchema>;
export type MemmyAgentSidebarState = z.infer<typeof SidebarStateSchema>;
export type MemmyAgentWebuiThread = z.infer<typeof WebuiThreadSchema>;
export type MemmyAgentSeededChat = z.infer<typeof SeedWebuiChatResponseSchema>;
export type MemmyAgentLastCompaction = z.infer<typeof LastCompactionSchema>;
export type ResolvedAgentArtifact = z.infer<typeof ResolvedArtifactSchema>;
export type UploadedAgentImage = z.infer<typeof UploadedAgentImageSchema>;
export type UploadedAgentMedia = z.infer<typeof UploadedAgentMediaSchema>;

export type MemmyAgentSlashCommand = {
  command: string;
  title: string;
  description: string;
  icon: string;
  argHint: string;
};

export type HistoryDagSourceRef = {
  type: "file" | "artifact" | "url";
  title: string;
  turn_id?: string;
  path?: string;
  line?: number;
  artifact_path?: string;
  url?: string;
};

export type HistoryDagPayloadNode = {
  id: string;
  kind: "task" | "subtask" | "decision";
  status: "active" | "done" | "failed" | "blocked" | "frozen";
  title: string;
  summary: string;
  importance: number;
  createdBy: "llm_patch" | "deterministic_fallback" | "repair";
  updatedBy: "llm_patch" | "deterministic_fallback" | "repair";
  sourceRefs: HistoryDagSourceRef[];
};

export type HistoryDagPayloadEdge = {
  id: string;
  source_id: string;
  target_id: string;
  type: "decomposes" | "continues" | "blocks" | "supersedes";
  createdBy: "llm_patch" | "deterministic_fallback" | "repair";
};

export type HistoryDagPayload = {
  sessionKey: string;
  nodes: HistoryDagPayloadNode[];
  edges: HistoryDagPayloadEdge[];
  activePathNodeIds: string[];
  activePathEdgeIds?: string[];
  snapshotText: string;
};

export type UploadAgentImageInput = {
  blob: Blob;
  name: string;
  mime: UploadedAgentImage["mime"];
};

export type UploadAgentMediaInput = {
  blob: Blob;
  name: string;
  kind: UploadedAgentMedia["kind"];
  mime: UploadedAgentMedia["mime"];
};

export type MemmyAgentMediaInput = UploadedAgentMedia;

export type MemmyAgentMediaKind = "image" | "video" | "file";
export type MemmyAgentUiLanguage = "zh-CN" | "en-US";

export type MemmyAgentMediaAttachment = {
  url?: string;
  name?: string;
  kind?: MemmyAgentMediaKind;
  path?: string;
};

export type AgentTurnSource = {
  kind: "gui" | "tui" | "im";
  channel: string;
};

export function parseAgentTurnSource(value: unknown): AgentTurnSource | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (
    (source.kind !== "gui" && source.kind !== "tui" && source.kind !== "im")
    || typeof source.channel !== "string"
    || !source.channel
  ) return null;
  return { kind: source.kind, channel: source.channel };
}

export type WebuiQueuedMessage = {
  client_request_id: string;
  text: string;
  media_urls: MemmyAgentMediaAttachment[];
  queued_at: string;
  source?: AgentTurnSource;
  queue_surface?: "chat_composer" | null;
  turn_admission?: "steer";
  turn_id?: string;
};

export type MemmyAgentMessageSubmissionResult = {
  status: "accepted" | "queued";
};

export type MemmyAgentQueueRemovalResult = {
  outcome: "removed" | "already_dequeued";
  revision: number;
};

export type MemmyAgentQueueSteerResult = {
  outcome: "steered" | "not_steerable" | "already_dequeued" | "missing";
  revision: number;
  turnId: string | null;
};

export type WebuiSessionTarget =
  | { kind: "standalone" }
  | { kind: "project"; projectId: string };

export type MemmyAgentSendMessageInput = {
  chatId: string;
  content: string;
  clientRequestId?: string;
  target?: WebuiSessionTarget;
  language?: MemmyAgentUiLanguage;
  media?: MemmyAgentMediaInput[];
  modelPreset?: string | null;
};

export interface MemmyAgentNewChatResult {
  chatId: string;
  modelPreset: string;
  modelSelection: MemmyAgentModelSelection;
}

export type MemmyAgentModelError = {
  category: "quota_exhausted" | "image_input_unsupported" | "image_analysis_failed" | "model_failed";
  detail?: string;
  presetId?: string;
  source?: "account" | "byok";
  provider?: string;
  model?: string;
  capability?: "agent" | "memory_summary" | "memory_evolution" | "embedding" | "asr" | "image_generation";
  failedProvider?: string;
  failedModel?: string;
};

export type MemmyAgentWsEvent = {
  event: string;
  connection_generation?: number;
  chat_id?: string;
  client_id?: string;
  text?: string;
  content?: string;
  stream_id?: string;
  turn_id?: string;
  turnId?: string;
  resuming?: boolean;
  kind?: string;
  detail?: string;
  reason?: string;
  client_request_id?: string;
  latency_ms?: number;
  media_urls?: MemmyAgentMediaAttachment[];
  model_error?: MemmyAgentModelError;
  metadata?: Record<string, unknown>;
  tool_events?: unknown;
  agent_ui?: unknown;
  edits?: unknown;
  goal_state?: AgentGoalState;
  goal_id?: string;
  goal_outcome?: AgentGoalStatus;
  compaction_id?: string;
  status?: string;
  started_at?: number;
  stopped?: number;
  scope?: string;
  model_name?: string;
  model_preset?: string;
  model_selection?: unknown;
  request_id?: string;
  ok?: boolean;
  outcome?: string;
  item?: WebuiQueuedMessage;
  items?: WebuiQueuedMessage[];
  started_items?: WebuiQueuedMessage[];
  revision?: number;
  [key: string]: unknown;
};

export type MemmyAgentRunLifecycleEvent = MemmyAgentWsEvent & {
  event: "run_status" | "turn_end" | "stop_result" | "run_status_snapshot";
  chat_id: string;
};

export interface MemmyAgentClient {
  bootstrap(options?: { force?: boolean }): Promise<MemmyAgentBootstrap>;
  getSettings(): Promise<MemmyAgentSettings>;
  getSessionSnapshot(options?: MemmyAgentRequestOptions): Promise<MemmyAgentSessionSnapshot>;
  listSessions(): Promise<MemmyAgentSessionSummary[]>;
  readWorkspaceEnvironment(scope: WorkspaceEnvironmentScope): Promise<WorkspaceEnvironmentState>;
  readWorkspaceEnvironmentDiff(scope: WorkspaceEnvironmentScope, path: string): Promise<WorkspaceEnvironmentDiff>;
  listWorkspaceFiles(sessionKey: string, path?: string): Promise<WorkspaceFilesListing>;
  switchWorkspaceEnvironmentBranch(
    scope: WorkspaceEnvironmentScope,
    branch: string,
    expectedRevision: string
  ): Promise<WorkspaceEnvironmentState>;
  createOrCheckoutWorkspaceEnvironmentBranch(
    scope: WorkspaceEnvironmentScope,
    branch: string,
    expectedRevision: string
  ): Promise<WorkspaceEnvironmentState>;
  listSlashCommands(): Promise<MemmyAgentSlashCommand[]>;
  readSidebarState(): Promise<MemmyAgentSidebarState>;
  writeSidebarState(
    baseUpdatedAt: string | null,
    state: MemmyAgentSidebarState,
    options?: MemmyAgentRequestOptions
  ): Promise<MemmyAgentSidebarState>;
  createProject(
    input: { mode: "blank" | "existing"; path: string; name?: string },
    options?: MemmyAgentRequestOptions
  ): Promise<MemmyAgentProjectMutationResult>;
  updateProject(
    projectId: string,
    update: { name: string } | { pinned: boolean },
    options?: MemmyAgentRequestOptions
  ): Promise<MemmyAgentProjectMutationResult>;
  revealProject(projectId: string, options?: MemmyAgentRequestOptions): Promise<void>;
  deleteProject(
    projectId: string,
    options?: MemmyAgentRequestOptions
  ): Promise<MemmyAgentProjectDeleteResult>;
  readWebuiThread(sessionKey: string): Promise<MemmyAgentWebuiThread>;
  seedWebuiChat(input: {
    userText: string;
    assistantText: string;
    title?: string;
  }): Promise<MemmyAgentSeededChat>;
  readLastCompaction(sessionKey: string): Promise<MemmyAgentLastCompaction>;
  renameSession(sessionKey: string, title: string): Promise<MemmyAgentSessionSummary>;
  deleteSession(sessionKey: string): Promise<boolean>;
  resolveArtifact(path: string, sessionKey: string): Promise<ResolvedAgentArtifact>;
  revealArtifact(path: string, sessionKey: string): Promise<void>;
  openArtifact(path: string, sessionKey: string): Promise<void>;
  uploadAgentMedia(attachments: UploadAgentMediaInput[]): Promise<UploadedAgentMedia[]>;
  uploadAgentImages(images: UploadAgentImageInput[]): Promise<UploadedAgentImage[]>;
  connectWebSocket(onEvent?: (event: MemmyAgentWsEvent) => void): Promise<MemmyAgentWebSocketConnection>;
  sessionKeyToChatId(sessionKey: string): string;
  chatIdToSessionKey(chatId: string): string;
}

export type MemmyAgentUnsubscribe = () => void;

export interface MemmyAgentWebSocketConnection {
  getReadyGeneration(): number | null;
  newChat(
    expectedGeneration: number,
    timeoutMs?: number,
    modelPreset?: string | null,
    clientRequestId?: string
  ): Promise<MemmyAgentNewChatResult>;
  attach(chatId: string): void;
  sendMessage(input: MemmyAgentSendMessageInput, expectedGeneration: number): Promise<void>;
  submitMessage(
    input: MemmyAgentSendMessageInput,
    expectedGeneration: number
  ): Promise<MemmyAgentMessageSubmissionResult>;
  removeQueuedMessage(
    chatId: string,
    clientRequestId: string,
    expectedGeneration: number,
    timeoutMs?: number
  ): Promise<MemmyAgentQueueRemovalResult>;
  steerQueuedMessage(
    chatId: string,
    clientRequestId: string,
    expectedTurnId: string,
    expectedGeneration: number,
    timeoutMs?: number
  ): Promise<MemmyAgentQueueSteerResult>;
  requestQueueSnapshot(chatId: string, expectedGeneration: number): void;
  controlGoal(
    input: AgentGoalControlInput,
    expectedGeneration: number,
    timeoutMs?: number
  ): Promise<AgentGoalControlResult>;
  stop(chatId: string): void;
  restart(chatId: string): void;
  status(chatId: string): void;
  historyDag(chatId: string): void;
  onChat(chatId: string, handler: (event: MemmyAgentWsEvent) => void): MemmyAgentUnsubscribe;
  onStatusResult(handler: (chatId: string, content: string) => void): MemmyAgentUnsubscribe;
  onHistoryDagResult(handler: (chatId: string, content: string, payload: HistoryDagPayload) => void): MemmyAgentUnsubscribe;
  onSessionUpdate(handler: (chatId: string, scope: string | undefined, generation: number) => void): MemmyAgentUnsubscribe;
  onRuntimeModelUpdate(handler: (modelName: string | null, modelPreset: string | null | undefined, generation: number) => void): MemmyAgentUnsubscribe;
  onRunStatus(handler: (chatId: string, startedAt: number | null) => void): MemmyAgentUnsubscribe;
  onRunLifecycle(handler: (chatId: string, event: MemmyAgentRunLifecycleEvent) => void): MemmyAgentUnsubscribe;
  requestRunStatusSnapshot(chatId: string, expectedGeneration: number, timeoutMs?: number): Promise<MemmyAgentRunStatusSnapshot>;
  getRunStartedAt(chatId: string): number | null;
  getGoalState(chatId: string): AgentGoalState | undefined;
  close(): void;
}

export type MemmyAgentRunStatusSnapshot = {
  status: "running" | "idle";
  startedAt: number | null;
  turnId: string | null;
  source: AgentTurnSource | null;
  connectionGeneration: number;
};

export type MemmyAgentProjectMutationResult = {
  project: MemmyAgentProject;
  snapshot: MemmyAgentSessionSnapshot;
};

export type MemmyAgentProjectDeleteResult = {
  deletedId: string;
  deletedSessionKeys: string[];
  snapshot: MemmyAgentSessionSnapshot;
};

export type MemmyAgentRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export interface CreateMemmyAgentClientInput {
  baseUrl?: string | null;
  bootstrapSecret?: string | null;
  clientId?: string | null;
  fetchFn?: typeof fetch;
  webSocketFactory?: (url: string) => WebSocketLike;
}

export interface WebSocketLike {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export class MemmyAgentRequestError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly data?: { sidebarState: MemmyAgentSidebarState };

  constructor(
    message: string,
    status: number,
    code: string | null = null,
    data?: { sidebarState: MemmyAgentSidebarState }
  ) {
    super(message);
    this.name = "MemmyAgentRequestError";
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export class AgentGatewayUnavailableError extends Error {
  constructor(message = "Agent gateway is not ready") {
    super(message);
    this.name = "AgentGatewayUnavailableError";
  }
}

export class MemmyAgentMessageRejectedError extends Error {
  readonly detail: string;
  readonly reason: string;

  constructor(detail: string, reason: string) {
    super("Message was rejected");
    this.name = "MemmyAgentMessageRejectedError";
    this.detail = detail;
    this.reason = reason;
  }
}

export class MemmyAgentGoalControlError extends Error {
  readonly code: string;
  readonly unknownResult: boolean;

  constructor(code: string, { unknownResult = false }: { unknownResult?: boolean } = {}) {
    super(unknownResult ? "Goal control result is unknown" : `Goal control failed: ${code}`);
    this.name = "MemmyAgentGoalControlError";
    this.code = code;
    this.unknownResult = unknownResult;
  }
}

export function createMemmyAgentClient(input: CreateMemmyAgentClientInput = {}): MemmyAgentClient {
  return new HttpMemmyAgentClient(input);
}

export function defaultMemmyAgentBaseUrl(): string {
  const envUrl = import.meta.env.VITE_MEMMY_AGENT_WEBUI_URL;
  if (typeof envUrl === "string" && envUrl.trim()) {
    return envUrl.trim();
  }

  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }

  return DEFAULT_MEMMY_AGENT_WEBUI_BASE_URL;
}

export function defaultMemmyAgentBootstrapSecret(): string | null {
  const envSecret = import.meta.env.VITE_MEMMY_AGENT_BOOTSTRAP_SECRET;
  return typeof envSecret === "string" && envSecret.trim() ? envSecret.trim() : null;
}

export function chatIdToSessionKey(chatId: string): string {
  return `websocket:${chatId}`;
}

export function sessionKeyToChatId(sessionKey: string): string {
  return sessionKey.startsWith("websocket:") ? sessionKey.slice("websocket:".length) : sessionKey;
}

function toWebSocketUrl(baseUrl: string, wsPath: string, token: string, clientId: string): string {
  const url = new URL(wsPath || "/", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("client_surface", "gui");
  return url.toString();
}

function isGatewayMediaPath(value: string): boolean {
  return value.startsWith("/api/media/");
}

function toGatewayAbsoluteMediaUrl(value: string, baseUrl: string): string {
  return isGatewayMediaPath(value) ? new URL(value, baseUrl).toString() : value;
}

function normalizeMarkdownMediaLinks(text: string, baseUrl: string): string {
  if (!text.includes("](/api/media/") && !text.includes("](</api/media/")) {
    return text;
  }

  return text.replace(/(\]\()(<)?(\/api\/media\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+)(>)?(\))/g, (_match, prefix: string, open: string | undefined, path: string, close: string | undefined, suffix: string) => {
    return `${prefix}${open ?? ""}${toGatewayAbsoluteMediaUrl(path, baseUrl)}${close ?? ""}${suffix}`;
  });
}

function normalizeGatewayMediaUrls<T>(value: T, baseUrl: string): T {
  return normalizeGatewayMediaUrlsValue(value, baseUrl) as T;
}

function normalizeGatewayMediaUrlsValue(value: unknown, baseUrl: string, key?: string): unknown {
  if (typeof value === "string") {
    if (key === "url" || key === "media_url") {
      return toGatewayAbsoluteMediaUrl(value, baseUrl);
    }
    if (key === "content" || key === "text") {
      return normalizeMarkdownMediaLinks(value, baseUrl);
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeGatewayMediaUrlsValue(item, baseUrl));
  }

  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        normalizeGatewayMediaUrlsValue(entryValue, baseUrl, entryKey)
      ])
    );
  }

  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

class HttpMemmyAgentClient implements MemmyAgentClient {
  private readonly baseUrl: string;
  private readonly bootstrapSecret: string | null;
  private readonly clientId: string;
  private readonly fetchFn: typeof fetch;
  private readonly webSocketFactory: (url: string) => WebSocketLike;
  private boot: MemmyAgentBootstrap | null = null;
  private bootExpiresAtMs = 0;
  private bootRefreshPromise: Promise<MemmyAgentBootstrap> | null = null;

  constructor(input: CreateMemmyAgentClientInput) {
    this.baseUrl = normalizeBaseUrl(input.baseUrl ?? defaultMemmyAgentBaseUrl());
    this.bootstrapSecret = input.bootstrapSecret?.trim() || defaultMemmyAgentBootstrapSecret();
    this.clientId = input.clientId?.trim() || stableClientId();
    this.fetchFn = input.fetchFn ?? fetch.bind(globalThis);
    this.webSocketFactory = input.webSocketFactory ?? ((url) => new WebSocket(url));
  }

  async bootstrap(options: { force?: boolean } = {}): Promise<MemmyAgentBootstrap> {
    if (this.boot && !options.force && Date.now() < this.bootExpiresAtMs - WEBUI_TOKEN_REFRESH_SKEW_MS) {
      return this.boot;
    }

    if (this.bootRefreshPromise) {
      return this.bootRefreshPromise;
    }

    this.bootRefreshPromise = this.request("/webui/bootstrap", BootstrapSchema, {
      includeToken: false,
      retryOnUnauthorized: false,
      headers: this.bootstrapSecret ? { "X-Memmy-Agent-Auth": this.bootstrapSecret } : undefined
    }).then((boot) => {
      this.boot = boot;
      this.bootExpiresAtMs = Date.now() + Math.max(0, boot.expires_in) * 1000;
      return boot;
    }).finally(() => {
      this.bootRefreshPromise = null;
    });
    return this.bootRefreshPromise;
  }

  async getSessionSnapshot(options: MemmyAgentRequestOptions = {}): Promise<MemmyAgentSessionSnapshot> {
    return this.request("/api/sessions", SessionSnapshotSchema, options);
  }

  async getSettings(): Promise<MemmyAgentSettings> {
    return this.request("/api/settings", AgentSettingsSchema);
  }

  async listSessions(): Promise<MemmyAgentSessionSummary[]> {
    return (await this.getSessionSnapshot()).sessions;
  }

  async readWorkspaceEnvironment(scope: WorkspaceEnvironmentScope): Promise<WorkspaceEnvironmentState> {
    const collection = scope.kind === "session" ? "sessions" : "projects";
    return this.request(
      `/api/${collection}/${encodeURIComponent(scope.key)}/environment`,
      WorkspaceEnvironmentStateSchema
    );
  }

  async readWorkspaceEnvironmentDiff(scope: WorkspaceEnvironmentScope, path: string): Promise<WorkspaceEnvironmentDiff> {
    const collection = scope.kind === "session" ? "sessions" : "projects";
    const query = new URLSearchParams({ path });
    return this.request(
      `/api/${collection}/${encodeURIComponent(scope.key)}/environment/diff?${query.toString()}`,
      WorkspaceEnvironmentDiffSchema
    );
  }

  async listWorkspaceFiles(sessionKey: string, path = ""): Promise<WorkspaceFilesListing> {
    const query = path ? `?${new URLSearchParams({ path }).toString()}` : "";
    return this.request(
      `/api/sessions/${encodeURIComponent(sessionKey)}/workspace/files${query}`,
      WorkspaceFilesListingSchema
    );
  }

  async switchWorkspaceEnvironmentBranch(
    scope: WorkspaceEnvironmentScope,
    branch: string,
    expectedRevision: string
  ): Promise<WorkspaceEnvironmentState> {
    const collection = scope.kind === "session" ? "sessions" : "projects";
    return this.request(
      `/api/${collection}/${encodeURIComponent(scope.key)}/environment/branch`,
      WorkspaceEnvironmentStateSchema,
      { method: "POST", body: { branch, expected_revision: expectedRevision } }
    );
  }

  async createOrCheckoutWorkspaceEnvironmentBranch(
    scope: WorkspaceEnvironmentScope,
    branch: string,
    expectedRevision: string
  ): Promise<WorkspaceEnvironmentState> {
    const collection = scope.kind === "session" ? "sessions" : "projects";
    return this.request(
      `/api/${collection}/${encodeURIComponent(scope.key)}/environment/branch`,
      WorkspaceEnvironmentStateSchema,
      { method: "POST", body: { branch, expected_revision: expectedRevision, create: true } }
    );
  }

  async listSlashCommands(): Promise<MemmyAgentSlashCommand[]> {
    const response = await this.request("/api/commands", SlashCommandsResponseSchema);
    return response.commands
      .filter((command) => !WEBUI_HIDDEN_SLASH_COMMANDS.has(command.command))
      .map((command) => ({
        command: command.command,
        title: command.title,
        description: command.description,
        icon: command.icon,
        argHint: command.arg_hint
      }));
  }

  async readSidebarState(): Promise<MemmyAgentSidebarState> {
    return this.request("/api/webui/sidebar-state", SidebarStateSchema);
  }

  async writeSidebarState(
    baseUpdatedAt: string | null,
    state: MemmyAgentSidebarState,
    options: MemmyAgentRequestOptions = {}
  ): Promise<MemmyAgentSidebarState> {
    return this.request("/api/webui/sidebar-state/update", SidebarStateSchema, {
      ...options,
      method: "POST",
      body: {
        base_updated_at: baseUpdatedAt,
        state
      }
    });
  }

  async createProject(
    input: { mode: "blank" | "existing"; path: string; name?: string },
    options: MemmyAgentRequestOptions = {}
  ): Promise<MemmyAgentProjectMutationResult> {
    return this.request("/api/projects", ProjectMutationResponseSchema, {
      ...options,
      method: "POST",
      body: input
    });
  }

  async updateProject(
    projectId: string,
    update: { name: string } | { pinned: boolean },
    options: MemmyAgentRequestOptions = {}
  ): Promise<MemmyAgentProjectMutationResult> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}`, ProjectMutationResponseSchema, {
      ...options,
      method: "PATCH",
      body: update
    });
  }

  async revealProject(projectId: string, options: MemmyAgentRequestOptions = {}): Promise<void> {
    await this.request(`/api/projects/${encodeURIComponent(projectId)}/reveal`, ProjectRevealResponseSchema, {
      ...options,
      method: "POST"
    });
  }

  async deleteProject(
    projectId: string,
    options: MemmyAgentRequestOptions = {}
  ): Promise<MemmyAgentProjectDeleteResult> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}`, ProjectDeleteResponseSchema, {
      ...options,
      method: "DELETE"
    });
  }

  async readWebuiThread(sessionKey: string): Promise<MemmyAgentWebuiThread> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionKey)}/webui-thread`, WebuiThreadSchema);
  }

  async seedWebuiChat(input: {
    userText: string;
    assistantText: string;
    title?: string;
  }): Promise<MemmyAgentSeededChat> {
    const title = input.title?.trim();
    return this.request("/api/webui/seed-chat", SeedWebuiChatResponseSchema, {
      method: "POST",
      body: {
        user_text: input.userText,
        assistant_text: input.assistantText,
        ...(title ? { title } : {})
      }
    });
  }

  async readLastCompaction(sessionKey: string): Promise<MemmyAgentLastCompaction> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionKey)}/last-compaction`, LastCompactionSchema);
  }

  async renameSession(sessionKey: string, title: string): Promise<MemmyAgentSessionSummary> {
    const response = await this.request(`/api/sessions/${encodeURIComponent(sessionKey)}/title`, RenameSessionResponseSchema, {
      method: "POST",
      body: { title }
    });
    return response.session;
  }

  async deleteSession(sessionKey: string): Promise<boolean> {
    const response = await this.request(`/api/sessions/${encodeURIComponent(sessionKey)}/delete`, DeleteSessionResponseSchema);
    return response.deleted;
  }

  async resolveArtifact(path: string, sessionKey: string): Promise<ResolvedAgentArtifact> {
    return this.request("/api/webui/artifacts/resolve", ResolvedArtifactSchema, {
      method: "POST",
      body: { path, sessionKey }
    });
  }

  async revealArtifact(path: string, sessionKey: string): Promise<void> {
    await this.request("/api/webui/artifacts/reveal", RevealArtifactResponseSchema, {
      method: "POST",
      body: { path, sessionKey }
    });
  }

  async openArtifact(path: string, sessionKey: string): Promise<void> {
    await this.request("/api/webui/artifacts/open", RevealArtifactResponseSchema, {
      method: "POST",
      body: { path, sessionKey }
    });
  }

  async uploadAgentMedia(attachments: UploadAgentMediaInput[]): Promise<UploadedAgentMedia[]> {
    if (!attachments.length) {
      return [];
    }

    const buildBody = (): FormData => {
      const form = new FormData();
      for (const attachment of attachments) {
        form.append("files", blobWithUploadMime(attachment.blob, attachment.mime), uploadFilenameForMedia(attachment.name, attachment.mime, attachment.kind));
      }
      return form;
    };
    const send = async (boot: MemmyAgentBootstrap): Promise<Response> => this.fetchFn(
      new URL("/api/webui/media/upload", this.baseUrl),
      {
        method: "POST",
        headers: { Authorization: `Bearer ${boot.token}` },
        body: buildBody()
      }
    );

    let boot = await this.bootstrap();
    let response = await send(boot);
    if (response.status === 401) {
      this.boot = null;
      this.bootExpiresAtMs = 0;
      boot = await this.bootstrap({ force: true });
      response = await send(boot);
    }

    if (!response.ok) {
      throw new MemmyAgentRequestError(await errorMessage(response), response.status);
    }

    const parsed = UploadedAgentMediaResponseSchema.parse(await response.json());
    return normalizeGatewayMediaUrls(parsed.attachments ?? parsed.images ?? [], this.baseUrl);
  }

  async uploadAgentImages(images: UploadAgentImageInput[]): Promise<UploadedAgentImage[]> {
    const media = await this.uploadAgentMedia(images.map((image) => ({ ...image, kind: "image" })));
    return media.filter((item): item is UploadedAgentImage => item.kind === "image");
  }

  async connectWebSocket(onEvent?: (event: MemmyAgentWsEvent) => void): Promise<MemmyAgentWebSocketConnection> {
    const session = new MemmyAgentWebSocketSession({
      bootstrap: (options) => this.bootstrap(options),
      baseUrl: this.baseUrl,
      clientId: this.clientId,
      webSocketFactory: this.webSocketFactory,
      onEvent
    });
    await session.connect();
    return session;
  }

  sessionKeyToChatId(sessionKey: string): string {
    return sessionKeyToChatId(sessionKey);
  }

  chatIdToSessionKey(chatId: string): string {
    return chatIdToSessionKey(chatId);
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: {
      includeToken?: boolean;
      headers?: Record<string, string>;
      method?: string;
      body?: unknown;
      retryOnUnauthorized?: boolean;
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {}
  ): Promise<T> {
    const includeToken = options.includeToken ?? true;
    const retryOnUnauthorized = options.retryOnUnauthorized ?? true;
    const timeoutController = options.timeoutMs == null ? null : new AbortController();
    const timeout = timeoutController
      ? setTimeout(() => timeoutController.abort(new DOMException("Request timed out", "TimeoutError")), options.timeoutMs)
      : null;
    const signal = combineAbortSignals(options.signal, timeoutController?.signal);
    const send = async (boot: MemmyAgentBootstrap | null): Promise<Response> => {
      const headers = {
        ...(options.headers ?? {}),
        ...(options.body == null ? {} : { "Content-Type": "application/json" }),
        ...(boot ? { Authorization: `Bearer ${boot.token}` } : {})
      };
      return this.fetchFn(new URL(path, this.baseUrl), {
        method: options.method ?? "GET",
        headers: Object.keys(headers).length ? headers : undefined,
        ...(options.body == null ? {} : { body: JSON.stringify(options.body) }),
        ...(signal ? { signal } : {})
      });
    };

    try {
      let boot = includeToken ? await this.bootstrap() : null;
      let response = await send(boot);
      if (response.status === 401 && includeToken && retryOnUnauthorized) {
        this.boot = null;
        this.bootExpiresAtMs = 0;
        boot = await this.bootstrap({ force: true });
        response = await send(boot);
      }

      if (!response.ok) {
        const parsed = await parseRequestError(response);
        throw new MemmyAgentRequestError(parsed.message, response.status, parsed.code, parsed.data);
      }

      const parsed = schema.parse(await response.json());
      return normalizeGatewayMediaUrls(parsed, this.baseUrl);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

const WS_OPEN = 1;
const PENDING_INBOUND_MAX = 2000;
const READY_HANDSHAKE_TIMEOUT_MS = 5_000;
const MESSAGE_ACK_TIMEOUT_MS = 10_000;
const MESSAGE_RESULT_TIMEOUT_MS = 30_000;
const MAX_AUTOMATIC_MESSAGE_CONFIRMATIONS = 3;
const GOAL_CONTROL_TIMEOUT_MS = 15_000;
const GOAL_CONTROL_HYDRATE_TIMEOUT_MS = 5_000;
const QUEUE_REMOVE_TIMEOUT_MS = 15_000;
const QUEUE_STEER_TIMEOUT_MS = 15_000;

interface MemmyAgentWebSocketSessionInput {
  bootstrap(options?: { force?: boolean }): Promise<MemmyAgentBootstrap>;
  baseUrl: string;
  clientId: string;
  webSocketFactory: (url: string) => WebSocketLike;
  onEvent?: (event: MemmyAgentWsEvent) => void;
}

interface PendingNewChat {
  generation: number;
  clientRequestId: string;
  resolve: (result: MemmyAgentNewChatResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingRunStatusSnapshot {
  generation: number;
  resolve: (snapshot: MemmyAgentRunStatusSnapshot) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingGoalControl {
  input: AgentGoalControlInput & { requestId: string };
  promise: Promise<AgentGoalControlResult>;
  resolve: (result: AgentGoalControlResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  calibrating: boolean;
}

interface PendingMessageAttempt {
  input: MemmyAgentSendMessageInput & { clientRequestId: string };
  queueSurface: "chat_composer" | null;
  finalPromise: Promise<void>;
  resolveFinal: () => void;
  rejectFinal: (error: Error) => void;
  firstPromise: Promise<MemmyAgentMessageSubmissionResult>;
  resolveFirst: (result: MemmyAgentMessageSubmissionResult) => void;
  rejectFirst: (error: Error) => void;
  firstSettled: boolean;
  acknowledgementTimer: ReturnType<typeof setTimeout> | null;
  resultTimer: ReturnType<typeof setTimeout> | null;
  reconnectConfirmations: number;
  lastSentGeneration: number | null;
  queued: boolean;
}

interface PendingQueueRemoval {
  chatId: string;
  clientRequestId: string;
  resolve: (result: MemmyAgentQueueRemovalResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingQueueSteer {
  chatId: string;
  clientRequestId: string;
  expectedTurnId: string;
  resolve: (result: MemmyAgentQueueSteerResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingInitialReady {
  resolve: () => void;
  reject: (error: Error) => void;
}

class MemmyAgentWebSocketSession implements MemmyAgentWebSocketConnection {
  private socket: WebSocketLike | null = null;
  private intentionallyClosed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private pendingNewChat: PendingNewChat | null = null;
  private pendingInitialReady: PendingInitialReady | null = null;
  private readonly pendingRunStatusSnapshots = new Map<string, PendingRunStatusSnapshot>();
  private readonly pendingMessageAttempts = new Map<string, PendingMessageAttempt>();
  private readonly pendingQueueRemovals = new Map<string, PendingQueueRemoval>();
  private readonly pendingQueueSteers = new Map<string, PendingQueueSteer>();
  private readonly pendingGoalControls = new Map<string, PendingGoalControl>();
  private connectionGeneration = 0;
  private transportOpenGeneration: number | null = null;
  private readyGeneration: number | null = null;
  private readyHandshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private hasReachedReady = false;
  private lastOrdinarySendChatId: string | null = null;
  private readonly knownChats = new Set<string>();
  private readonly controlQueue: Record<string, unknown>[] = [];
  private readonly chatHandlers = new Map<string, Set<(event: MemmyAgentWsEvent) => void>>();
  private readonly pendingInboundByChat = new Map<string, MemmyAgentWsEvent[]>();
  private readonly statusResultHandlers = new Set<(chatId: string, content: string) => void>();
  private readonly historyDagResultHandlers = new Set<(chatId: string, content: string, payload: HistoryDagPayload) => void>();
  private readonly sessionUpdateHandlers = new Set<(chatId: string, scope: string | undefined, generation: number) => void>();
  private readonly runtimeModelHandlers = new Set<(modelName: string | null, modelPreset: string | null | undefined, generation: number) => void>();
  private readonly runStatusHandlers = new Set<(chatId: string, startedAt: number | null) => void>();
  private readonly runLifecycleHandlers = new Set<(chatId: string, event: MemmyAgentRunLifecycleEvent) => void>();
  private readonly runStartedAtByChatId = new Map<string, number>();
  private readonly goalStateByChatId = new Map<string, AgentGoalState>();

  constructor(private readonly input: MemmyAgentWebSocketSessionInput) {}

  async connect(): Promise<void> {
    const ready = new Promise<void>((resolve, reject) => {
      this.pendingInitialReady = { resolve, reject };
    });
    try {
      await this.openSocket(true);
      await ready;
    } catch (error) {
      const connectError = asError(error, "Agent gateway connection failed");
      this.rejectInitialReady(connectError);
      this.close();
      throw connectError;
    }
  }

  getReadyGeneration(): number | null {
    return this.readyGeneration;
  }

  newChat(
    expectedGeneration: number,
    timeoutMs = 5000,
    modelPreset?: string | null,
    suppliedClientRequestId?: string
  ): Promise<MemmyAgentNewChatResult> {
    if (this.pendingNewChat) {
      return Promise.reject(new Error("newChat already in flight"));
    }

    try {
      this.assertReadyGeneration(expectedGeneration);
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise<MemmyAgentNewChatResult>((resolve, reject) => {
      const clientRequestId = suppliedClientRequestId ?? crypto.randomUUID();
      const pending: PendingNewChat = {
        generation: expectedGeneration,
        clientRequestId,
        resolve,
        reject,
        timer: setTimeout(() => {
          if (this.pendingNewChat === pending) {
            this.pendingNewChat = null;
          }
          reject(new Error("newChat timed out"));
        }, timeoutMs)
      };
      this.pendingNewChat = pending;
      try {
        this.sendOrdinaryFrame({
          type: "new_chat",
          client_request_id: clientRequestId,
          ...(modelPreset !== undefined ? { model_preset: modelPreset } : {})
        }, expectedGeneration);
      } catch (error) {
        this.pendingNewChat = null;
        clearTimeout(pending.timer);
        reject(asError(error, "Unable to create chat"));
      }
    });
  }

  attach(chatId: string): void {
    if (!chatId) {
      return;
    }
    this.knownChats.add(chatId);
    const generation = this.readyGeneration;
    if (generation !== null) {
      this.sendAttach(chatId, generation);
    }
  }

  requestQueueSnapshot(chatId: string, expectedGeneration: number): void {
    this.assertReadyGeneration(expectedGeneration);
    this.knownChats.add(chatId);
    this.sendOrdinaryFrame({
      type: "queue_snapshot_request",
      chat_id: chatId
    }, expectedGeneration);
  }

  sendMessage(input: MemmyAgentSendMessageInput, expectedGeneration: number): Promise<void> {
    if (!input.clientRequestId) {
      this.sendMessageFrame(input, expectedGeneration, null);
      return Promise.resolve();
    }
    return this.getOrCreatePendingMessageAttempt(
      { ...input, clientRequestId: input.clientRequestId },
      expectedGeneration,
      null
    ).finalPromise;
  }

  submitMessage(
    input: MemmyAgentSendMessageInput,
    expectedGeneration: number
  ): Promise<MemmyAgentMessageSubmissionResult> {
    if (!input.clientRequestId) {
      return Promise.reject(new Error("clientRequestId is required for queued submission"));
    }
    return this.getOrCreatePendingMessageAttempt(
      { ...input, clientRequestId: input.clientRequestId },
      expectedGeneration,
      "chat_composer"
    ).firstPromise;
  }

  removeQueuedMessage(
    chatId: string,
    clientRequestId: string,
    expectedGeneration: number,
    timeoutMs = QUEUE_REMOVE_TIMEOUT_MS
  ): Promise<MemmyAgentQueueRemovalResult> {
    this.assertReadyGeneration(expectedGeneration);
    const requestId = crypto.randomUUID();
    return new Promise<MemmyAgentQueueRemovalResult>((resolve, reject) => {
      const pending: PendingQueueRemoval = {
        chatId,
        clientRequestId,
        resolve,
        reject,
        timer: setTimeout(() => {
          if (this.pendingQueueRemovals.get(requestId) === pending) {
            this.pendingQueueRemovals.delete(requestId);
          }
          reject(new Error("Queue removal timed out"));
        }, timeoutMs)
      };
      this.pendingQueueRemovals.set(requestId, pending);
      try {
        this.sendOrdinaryFrame({
          type: "queue_remove",
          chat_id: chatId,
          request_id: requestId,
          client_request_id: clientRequestId
        }, expectedGeneration);
      } catch (error) {
        this.pendingQueueRemovals.delete(requestId);
        clearTimeout(pending.timer);
        reject(asError(error, "Unable to remove queued message"));
      }
    });
  }

  steerQueuedMessage(
    chatId: string,
    clientRequestId: string,
    expectedTurnId: string,
    expectedGeneration: number,
    timeoutMs = QUEUE_STEER_TIMEOUT_MS
  ): Promise<MemmyAgentQueueSteerResult> {
    this.assertReadyGeneration(expectedGeneration);
    const requestId = crypto.randomUUID();
    return new Promise<MemmyAgentQueueSteerResult>((resolve, reject) => {
      const pending: PendingQueueSteer = {
        chatId,
        clientRequestId,
        expectedTurnId,
        resolve,
        reject,
        timer: setTimeout(() => {
          if (this.pendingQueueSteers.get(requestId) === pending) {
            this.pendingQueueSteers.delete(requestId);
          }
          reject(new Error("Queue steer timed out"));
        }, timeoutMs)
      };
      this.pendingQueueSteers.set(requestId, pending);
      try {
        this.sendOrdinaryFrame({
          type: "queue_steer",
          chat_id: chatId,
          request_id: requestId,
          client_request_id: clientRequestId,
          expected_turn_id: expectedTurnId
        }, expectedGeneration);
      } catch (error) {
        this.pendingQueueSteers.delete(requestId);
        clearTimeout(pending.timer);
        reject(asError(error, "Unable to steer queued message"));
      }
    });
  }

  private getOrCreatePendingMessageAttempt(
    input: MemmyAgentSendMessageInput & { clientRequestId: string },
    expectedGeneration: number,
    queueSurface: "chat_composer" | null
  ): PendingMessageAttempt {
    const key = messageAttemptKey(input.chatId, input.clientRequestId);
    const current = this.pendingMessageAttempts.get(key);
    if (current) {
      if (!sameMessageAttempt(current.input, input) || current.queueSurface !== queueSurface) {
        throw new Error("clientRequestId already belongs to another message");
      }
      current.reconnectConfirmations = 0;
      this.sendPendingMessageAttempt(current, expectedGeneration);
      return current;
    }

    let resolveFinal!: () => void;
    let rejectFinal!: (error: Error) => void;
    const finalPromise = new Promise<void>((resolve, reject) => {
      resolveFinal = resolve;
      rejectFinal = reject;
    });
    void finalPromise.catch(() => undefined);
    let resolveFirst!: (result: MemmyAgentMessageSubmissionResult) => void;
    let rejectFirst!: (error: Error) => void;
    const firstPromise = new Promise<MemmyAgentMessageSubmissionResult>((resolve, reject) => {
      resolveFirst = resolve;
      rejectFirst = reject;
    });
    void firstPromise.catch(() => undefined);
    const attempt: PendingMessageAttempt = {
      input: { ...input, clientRequestId: input.clientRequestId },
      queueSurface,
      finalPromise,
      resolveFinal,
      rejectFinal,
      firstPromise,
      resolveFirst,
      rejectFirst,
      firstSettled: false,
      acknowledgementTimer: null,
      resultTimer: null,
      reconnectConfirmations: 0,
      lastSentGeneration: null,
      queued: false
    };
    this.pendingMessageAttempts.set(key, attempt);
    attempt.resultTimer = setTimeout(() => {
      if (this.pendingMessageAttempts.get(key) !== attempt) return;
      this.pendingMessageAttempts.delete(key);
      if (attempt.acknowledgementTimer) clearTimeout(attempt.acknowledgementTimer);
      this.emitEvent({
        event: "message_confirmation_exhausted",
        chat_id: attempt.input.chatId,
        client_request_id: attempt.input.clientRequestId
      });
      const error = new MemmyAgentMessageRejectedError(
        "message_result_unknown",
        "result_unknown"
      );
      if (!attempt.firstSettled) {
        attempt.firstSettled = true;
        attempt.rejectFirst(error);
      }
      attempt.rejectFinal(error);
    }, MESSAGE_RESULT_TIMEOUT_MS);
    try {
      this.sendPendingMessageAttempt(attempt, expectedGeneration);
    } catch (error) {
      this.pendingMessageAttempts.delete(key);
      if (attempt.resultTimer) clearTimeout(attempt.resultTimer);
      throw error;
    }
    return attempt;
  }

  controlGoal(
    input: AgentGoalControlInput,
    expectedGeneration: number,
    timeoutMs = GOAL_CONTROL_TIMEOUT_MS
  ): Promise<AgentGoalControlResult> {
    this.assertReadyGeneration(expectedGeneration);
    const requestId = input.requestId ?? crypto.randomUUID();
    const normalizedInput = { ...input, requestId };
    const key = messageAttemptKey(input.chatId, requestId);
    const current = this.pendingGoalControls.get(key);
    if (current) {
      if (!sameGoalControl(current.input, normalizedInput)) {
        return Promise.reject(new MemmyAgentGoalControlError("request_id_conflict"));
      }
      return current.promise;
    }

    let resolveControl!: (result: AgentGoalControlResult) => void;
    let rejectControl!: (error: Error) => void;
    const promise = new Promise<AgentGoalControlResult>((resolve, reject) => {
      resolveControl = resolve;
      rejectControl = reject;
    });
    const pending: PendingGoalControl = {
      input: normalizedInput,
      promise,
      resolve: resolveControl,
      reject: rejectControl,
      calibrating: false,
      timer: null
    };
    pending.timer = setTimeout(() => {
      if (this.pendingGoalControls.get(key) !== pending) return;
      this.beginGoalControlCalibration(key, pending);
    }, timeoutMs);
    this.pendingGoalControls.set(key, pending);
    try {
      this.sendOrdinaryFrame({
        type: "goal_control",
        chat_id: input.chatId,
        request_id: requestId,
        goal_id: input.goalId,
        action: input.action,
        ...(input.action === "edit" ? { objective: input.objective } : {}),
        ...(input.action === "set_budget" ? { token_budget: input.tokenBudget } : {})
      }, expectedGeneration);
      this.knownChats.add(input.chatId);
    } catch (error) {
      if (pending.timer) clearTimeout(pending.timer);
      this.pendingGoalControls.delete(key);
      pending.reject(asError(error, "Unable to control Goal"));
    }
    return promise;
  }

  stop(chatId: string): void {
    if (!chatId) {
      return;
    }
    this.knownChats.add(chatId);
    this.queueControl({
      type: "stop",
      chat_id: chatId
    });
  }

  restart(chatId: string): void {
    if (!chatId) {
      return;
    }
    this.knownChats.add(chatId);
    this.queueControl({
      type: "message",
      chat_id: chatId,
      content: "/restart",
      webui: true
    });
  }

  status(chatId: string): void {
    if (!chatId) {
      return;
    }
    this.knownChats.add(chatId);
    this.queueControl({ type: "status", chat_id: chatId });
  }

  historyDag(chatId: string): void {
    if (!chatId) {
      return;
    }
    this.knownChats.add(chatId);
    this.queueControl({ type: "history_dag", chat_id: chatId });
  }

  onChat(chatId: string, handler: (event: MemmyAgentWsEvent) => void): MemmyAgentUnsubscribe {
    let handlers = this.chatHandlers.get(chatId);
    if (!handlers) {
      handlers = new Set();
      this.chatHandlers.set(chatId, handlers);
    }
    handlers.add(handler);

    const pending = this.pendingInboundByChat.get(chatId);
    if (pending?.length) {
      const events = pending.splice(0);
      this.pendingInboundByChat.delete(chatId);
      for (const event of events) {
        handler(event);
      }
    }

    this.attach(chatId);
    return () => {
      const current = this.chatHandlers.get(chatId);
      if (!current) {
        return;
      }
      current.delete(handler);
      if (current.size === 0) {
        this.chatHandlers.delete(chatId);
      }
    };
  }

  onStatusResult(handler: (chatId: string, content: string) => void): MemmyAgentUnsubscribe {
    this.statusResultHandlers.add(handler);
    return () => this.statusResultHandlers.delete(handler);
  }

  onHistoryDagResult(handler: (chatId: string, content: string, payload: HistoryDagPayload) => void): MemmyAgentUnsubscribe {
    this.historyDagResultHandlers.add(handler);
    return () => this.historyDagResultHandlers.delete(handler);
  }

  onSessionUpdate(handler: (chatId: string, scope: string | undefined, generation: number) => void): MemmyAgentUnsubscribe {
    this.sessionUpdateHandlers.add(handler);
    return () => this.sessionUpdateHandlers.delete(handler);
  }

  onRuntimeModelUpdate(handler: (modelName: string | null, modelPreset: string | null | undefined, generation: number) => void): MemmyAgentUnsubscribe {
    this.runtimeModelHandlers.add(handler);
    return () => this.runtimeModelHandlers.delete(handler);
  }

  onRunStatus(handler: (chatId: string, startedAt: number | null) => void): MemmyAgentUnsubscribe {
    this.runStatusHandlers.add(handler);
    for (const [chatId, startedAt] of this.runStartedAtByChatId) {
      handler(chatId, startedAt);
    }
    return () => this.runStatusHandlers.delete(handler);
  }

  onRunLifecycle(handler: (chatId: string, event: MemmyAgentRunLifecycleEvent) => void): MemmyAgentUnsubscribe {
    this.runLifecycleHandlers.add(handler);
    for (const [chatId, startedAt] of this.runStartedAtByChatId) {
      handler(chatId, {
        event: "run_status",
        chat_id: chatId,
        status: "running",
        started_at: startedAt,
        ...(this.readyGeneration !== null ? { connection_generation: this.readyGeneration } : {})
      });
    }
    return () => this.runLifecycleHandlers.delete(handler);
  }

  getRunStartedAt(chatId: string): number | null {
    return this.runStartedAtByChatId.get(chatId) ?? null;
  }

  getGoalState(chatId: string): AgentGoalState | undefined {
    return this.goalStateByChatId.get(chatId);
  }

  requestRunStatusSnapshot(
    chatId: string,
    expectedGeneration: number,
    timeoutMs = 5_000
  ): Promise<MemmyAgentRunStatusSnapshot> {
    try {
      this.assertReadyGeneration(expectedGeneration);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.pendingRunStatusSnapshots.has(chatId)) {
      return Promise.reject(new Error(`Run status snapshot already pending for ${chatId}`));
    }

    return new Promise<MemmyAgentRunStatusSnapshot>((resolve, reject) => {
      const pending: PendingRunStatusSnapshot = {
        generation: expectedGeneration,
        resolve,
        reject,
        timer: setTimeout(() => {
          if (this.pendingRunStatusSnapshots.get(chatId) === pending) {
            this.pendingRunStatusSnapshots.delete(chatId);
          }
          reject(new Error(`Run status snapshot timed out for ${chatId}`));
        }, timeoutMs)
      };
      this.pendingRunStatusSnapshots.set(chatId, pending);
      try {
        this.sendOrdinaryFrame({ type: "attach", chat_id: chatId }, expectedGeneration);
      } catch (error) {
        this.pendingRunStatusSnapshots.delete(chatId);
        clearTimeout(pending.timer);
        reject(asError(error, "Unable to request run status snapshot"));
      }
    });
  }

  close(): void {
    this.intentionallyClosed = true;
    this.connectionGeneration += 1;
    this.rejectPendingNewChat(new Error("newChat cancelled"));
    this.rejectPendingRunStatusSnapshots(new Error("run status snapshot cancelled"));
    this.rejectPendingMessageAttempts(new Error("message confirmation cancelled"));
    this.rejectPendingQueueRemovals(new Error("queue removal cancelled"));
    this.rejectPendingQueueSteers(new Error("queue steer cancelled"));
    this.rejectPendingGoalControls(new Error("Goal control cancelled"));
    this.rejectInitialReady(new Error("Agent gateway connection cancelled"));
    this.clearReadyHandshakeTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.readyGeneration = null;
    this.transportOpenGeneration = null;
    socket?.close();
  }

  private async openSocket(forceBootstrap: boolean): Promise<void> {
    const generation = this.connectionGeneration + 1;
    this.connectionGeneration = generation;
    const boot = await this.input.bootstrap({ force: forceBootstrap });
    if (this.intentionallyClosed || generation !== this.connectionGeneration) {
      return;
    }
    const ws = this.input.webSocketFactory(toWebSocketUrl(this.input.baseUrl, boot.ws_path, boot.token, this.input.clientId));
    this.socket = ws;
    ws.onopen = () => this.handleOpen(ws, generation);
    ws.onmessage = (event) => this.handleMessage(ws, generation, event);
    ws.onerror = () => this.handleError(ws, generation);
    ws.onclose = (event) => this.handleClose(ws, generation, event);
    if (ws.readyState === WS_OPEN) {
      this.handleOpen(ws, generation);
    }
  }

  private handleOpen(socket: WebSocketLike, generation: number): void {
    if (!this.isCurrentSocket(socket, generation) || this.transportOpenGeneration === generation) {
      return;
    }
    this.transportOpenGeneration = generation;
    this.clearReadyHandshakeTimer();
    this.readyHandshakeTimer = setTimeout(() => {
      if (this.isCurrentSocket(socket, generation) && this.readyGeneration !== generation) {
        socket.close(1011, "ready timeout");
      }
    }, READY_HANDSHAKE_TIMEOUT_MS);
  }

  private handleMessage(socket: WebSocketLike, generation: number, event: MessageEvent): void {
    if (!this.isCurrentSocket(socket, generation)) {
      return;
    }
    const parsed = parseWsEvent(event.data);
    if (!parsed) {
      return;
    }

    const normalized: MemmyAgentWsEvent = {
      ...normalizeGatewayMediaUrls(parsed, this.input.baseUrl),
      connection_generation: generation
    };

    if (normalized.event === "ready") {
      if (this.readyGeneration !== generation) {
        this.clearReadyHandshakeTimer();
        this.readyGeneration = generation;
        this.hasReachedReady = true;
        this.reconnectAttempts = 0;
        this.pendingInitialReady?.resolve();
        this.pendingInitialReady = null;
        for (const chatId of this.knownChats) {
          this.sendAttach(chatId, generation);
        }
        this.flushControlQueue(socket, generation);
        this.confirmPendingMessagesAfterReconnect(generation);
      }
      if (normalized.chat_id) {
        this.knownChats.add(normalized.chat_id);
      }
      this.emitEvent(normalized);
      return;
    }

    this.emitEvent(normalized);

    if (normalized.event === "message_queued") {
      this.markPendingMessageQueued(normalized);
    } else if (normalized.event === "message_accepted") {
      this.resolvePendingMessageAttempt(normalized);
    } else if (
      normalized.event === "message_steered"
      || (normalized.event === "message_dequeued" && normalized.turn_admission === "steer")
    ) {
      this.resolvePendingMessageAttempt(normalized);
    } else if (normalized.event === "message_queue_removed") {
      this.resolveRemovedMessageAttempt(normalized);
    } else if (normalized.event === "error") {
      this.rejectPendingNewChatAttempt(normalized, generation);
      this.rejectPendingMessageAttempt(normalized);
    } else if (normalized.event === "goal_control_result") {
      this.resolvePendingGoalControl(normalized);
    } else if (normalized.event === "queue_remove_result") {
      this.resolvePendingQueueRemoval(normalized);
    } else if (normalized.event === "queue_steer_result") {
      this.resolvePendingQueueSteer(normalized);
    }

    if (normalized.event === "attached") {
      if (normalized.chat_id) {
        this.knownChats.add(normalized.chat_id);
        this.resolvePendingNewChat(normalized, generation);
        this.dispatchChat(normalized.chat_id, normalized);
      }
      return;
    }

    if (normalized.event === "runtime_model_updated") {
      for (const handler of this.runtimeModelHandlers) {
        handler(normalized.model_name ?? null, typeof normalized.model_preset === "string" ? normalized.model_preset : null, generation);
      }
      return;
    }

    if (normalized.event === "session_updated") {
      if (normalized.chat_id) {
        for (const handler of this.sessionUpdateHandlers) {
          handler(normalized.chat_id, typeof normalized.scope === "string" ? normalized.scope : undefined, generation);
        }
      }
      return;
    }

    if (normalized.event === "status_result") {
      if (normalized.chat_id) {
        const content = String(normalized.content ?? normalized.text ?? "");
        for (const handler of this.statusResultHandlers) {
          handler(normalized.chat_id, content);
        }
      }
      return;
    }

    if (normalized.event === "history_dag_result") {
      const historyDagPayload = readHistoryDagPayload(normalized.agent_ui);
      if (historyDagPayload && normalized.chat_id) {
        const content = String(normalized.content ?? normalized.text ?? "");
        for (const handler of this.historyDagResultHandlers) {
          handler(normalized.chat_id, content, historyDagPayload);
        }
      }
      return;
    }

    const historyDagPayload = readHistoryDagPayload(normalized.agent_ui);
    if (historyDagPayload && normalized.chat_id) {
      const content = String(normalized.content ?? normalized.text ?? "");
      for (const handler of this.historyDagResultHandlers) {
        handler(normalized.chat_id, content, historyDagPayload);
      }
      return;
    }

    const chatId = normalized.chat_id;
    if (!chatId) {
      return;
    }

    this.recordRunStatus(chatId, normalized);
    this.recordGoalState(chatId, normalized);
    this.resolveRunStatusSnapshot(chatId, normalized, generation);
    this.dispatchChat(chatId, normalized);
  }

  private handleError(socket: WebSocketLike, generation: number): void {
    if (!this.isCurrentSocket(socket, generation)) {
      return;
    }
    this.emitEvent({ event: "transport_error", detail: "websocket_error", connection_generation: generation });
  }

  private handleClose(socket: WebSocketLike, generation: number, event?: CloseEvent): void {
    if (!this.isCurrentSocket(socket, generation)) {
      return;
    }
    this.socket = null;
    this.transportOpenGeneration = null;
    this.readyGeneration = null;
    this.clearReadyHandshakeTimer();
    this.suspendPendingMessageAttemptsForReconnect();
    for (const [key, pending] of this.pendingGoalControls) {
      this.beginGoalControlCalibration(key, pending);
    }
    this.rejectPendingNewChat(new Error("newChat failed because websocket closed"));
    this.rejectPendingRunStatusSnapshots(new Error("run status snapshot failed because websocket closed"), generation);
    this.rejectPendingQueueRemovals(new Error("queue removal failed because websocket closed"));
    this.rejectPendingQueueSteers(new Error("queue steer failed because websocket closed"));
    if (this.intentionallyClosed) {
      return;
    }
    if (!this.hasReachedReady) {
      this.lastOrdinarySendChatId = null;
      this.rejectInitialReady(new Error("Agent gateway closed before ready"));
      return;
    }
    if (event?.code === 1009) {
      this.emitEvent({
        event: "transport_error",
        detail: "message_too_big",
        connection_generation: generation,
        ...(this.lastOrdinarySendChatId ? { chat_id: this.lastOrdinarySendChatId } : {})
      });
    }
    this.lastOrdinarySendChatId = null;
    this.emitEvent({ event: "connection_closed", connection_generation: generation });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }
    const delayMs = Math.min(500 * 2 ** this.reconnectAttempts, 15_000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket(true).catch((error) => {
        this.emitEvent({
          event: "connection_attempt_failed",
          detail: asError(error, "Agent gateway reconnect failed").message,
          connection_generation: this.connectionGeneration
        });
        this.scheduleReconnect();
      });
    }, delayMs);
  }

  private queueControl(frame: Record<string, unknown>): void {
    const socket = this.socket;
    const generation = this.readyGeneration;
    if (!socket || generation === null || socket.readyState !== WS_OPEN) {
      this.controlQueue.push(frame);
      return;
    }
    try {
      this.rawSend(socket, generation, frame);
    } catch {
      this.controlQueue.push(frame);
      socket.close(1011, "send failed");
    }
  }

  private flushControlQueue(socket: WebSocketLike, generation: number): void {
    while (this.controlQueue.length > 0 && this.isReadySocket(socket, generation)) {
      const frame = this.controlQueue[0]!;
      try {
        this.rawSend(socket, generation, frame);
        this.controlQueue.shift();
      } catch {
        socket.close(1011, "send failed");
        return;
      }
    }
  }

  private sendAttach(chatId: string, generation: number): void {
    const socket = this.socket;
    if (!socket || !this.isReadySocket(socket, generation)) {
      return;
    }
    try {
      this.rawSend(socket, generation, { type: "attach", chat_id: chatId });
    } catch {
      socket.close(1011, "attach failed");
    }
  }

  private sendOrdinaryFrame(frame: Record<string, unknown>, expectedGeneration: number): void {
    this.assertReadyGeneration(expectedGeneration);
    this.rawSend(this.socket!, expectedGeneration, frame);
  }

  private sendMessageFrame(
    input: MemmyAgentSendMessageInput,
    expectedGeneration: number,
    queueSurface: "chat_composer" | null
  ): void {
    this.sendOrdinaryFrame({
      type: "message",
      chat_id: input.chatId,
      content: input.content,
      webui: true,
      ...(queueSurface ? { queue_surface: queueSurface } : {}),
      ...(input.clientRequestId ? { client_request_id: input.clientRequestId } : {}),
      ...(input.target ? { target: input.target } : {}),
      ...(input.language ? { language: input.language } : {}),
      ...(input.modelPreset !== undefined ? { model_preset: input.modelPreset } : {}),
      ...(input.media?.length ? { media_paths: input.media.map((item) => item.path) } : {})
    }, expectedGeneration);
    this.knownChats.add(input.chatId);
    this.lastOrdinarySendChatId = input.chatId;
  }

  private sendPendingMessageAttempt(attempt: PendingMessageAttempt, generation: number): void {
    this.sendMessageFrame(attempt.input, generation, attempt.queueSurface);
    attempt.lastSentGeneration = generation;
    if (attempt.acknowledgementTimer) clearTimeout(attempt.acknowledgementTimer);
    if (attempt.queued) {
      attempt.acknowledgementTimer = null;
      return;
    }
    attempt.acknowledgementTimer = setTimeout(() => {
      attempt.acknowledgementTimer = null;
      this.emitEvent({
        event: "message_confirmation_pending",
        chat_id: attempt.input.chatId,
        client_request_id: attempt.input.clientRequestId,
        connection_generation: generation
      });
    }, MESSAGE_ACK_TIMEOUT_MS);
  }

  private confirmPendingMessagesAfterReconnect(generation: number): void {
    for (const attempt of this.pendingMessageAttempts.values()) {
      if (attempt.lastSentGeneration === generation) continue;
      if (!attempt.queued && attempt.reconnectConfirmations >= MAX_AUTOMATIC_MESSAGE_CONFIRMATIONS) {
        this.emitEvent({
          event: "message_confirmation_exhausted",
          chat_id: attempt.input.chatId,
          client_request_id: attempt.input.clientRequestId,
          connection_generation: generation
        });
        const key = messageAttemptKey(attempt.input.chatId, attempt.input.clientRequestId);
        if (this.pendingMessageAttempts.get(key) === attempt) {
          this.pendingMessageAttempts.delete(key);
          if (attempt.acknowledgementTimer) clearTimeout(attempt.acknowledgementTimer);
          if (attempt.resultTimer) clearTimeout(attempt.resultTimer);
          const error = new MemmyAgentMessageRejectedError(
            "message_result_unknown",
            "result_unknown"
          );
          if (!attempt.firstSettled) {
            attempt.firstSettled = true;
            attempt.rejectFirst(error);
          }
          attempt.rejectFinal(error);
        }
        continue;
      }
      if (!attempt.queued) attempt.reconnectConfirmations += 1;
      try {
        this.sendPendingMessageAttempt(attempt, generation);
      } catch {
        this.emitEvent({
          event: "message_confirmation_pending",
          chat_id: attempt.input.chatId,
          client_request_id: attempt.input.clientRequestId,
          connection_generation: generation
        });
      }
    }
  }

  private resolvePendingMessageAttempt(event: MemmyAgentWsEvent): void {
    if (!event.chat_id || !event.client_request_id) return;
    const key = messageAttemptKey(event.chat_id, event.client_request_id);
    const attempt = this.pendingMessageAttempts.get(key);
    if (!attempt) return;
    this.pendingMessageAttempts.delete(key);
    if (attempt.acknowledgementTimer) clearTimeout(attempt.acknowledgementTimer);
    if (attempt.resultTimer) clearTimeout(attempt.resultTimer);
    if (!attempt.firstSettled) {
      attempt.firstSettled = true;
      attempt.resolveFirst({ status: "accepted" });
    }
    attempt.resolveFinal();
  }

  private markPendingMessageQueued(event: MemmyAgentWsEvent): void {
    if (!event.chat_id || !event.client_request_id) return;
    const key = messageAttemptKey(event.chat_id, event.client_request_id);
    const attempt = this.pendingMessageAttempts.get(key);
    if (!attempt) return;
    attempt.queued = true;
    attempt.reconnectConfirmations = 0;
    if (attempt.acknowledgementTimer) clearTimeout(attempt.acknowledgementTimer);
    if (attempt.resultTimer) clearTimeout(attempt.resultTimer);
    attempt.acknowledgementTimer = null;
    attempt.resultTimer = null;
    if (event.item && attempt.queueSurface === "chat_composer" && !attempt.firstSettled) {
      attempt.firstSettled = true;
      attempt.resolveFirst({ status: "queued" });
    }
  }

  private resolveRemovedMessageAttempt(event: MemmyAgentWsEvent): void {
    if (!event.chat_id || !event.client_request_id) return;
    const key = messageAttemptKey(event.chat_id, event.client_request_id);
    const attempt = this.pendingMessageAttempts.get(key);
    if (!attempt) return;
    this.pendingMessageAttempts.delete(key);
    if (attempt.acknowledgementTimer) clearTimeout(attempt.acknowledgementTimer);
    if (attempt.resultTimer) clearTimeout(attempt.resultTimer);
    attempt.resolveFinal();
  }

  private rejectPendingMessageAttempt(event: MemmyAgentWsEvent): void {
    if (!event.chat_id || !event.client_request_id) return;
    const key = messageAttemptKey(event.chat_id, event.client_request_id);
    const attempt = this.pendingMessageAttempts.get(key);
    if (!attempt) return;
    this.pendingMessageAttempts.delete(key);
    if (attempt.acknowledgementTimer) clearTimeout(attempt.acknowledgementTimer);
    if (attempt.resultTimer) clearTimeout(attempt.resultTimer);
    const error = new MemmyAgentMessageRejectedError(
      typeof event.detail === "string" ? event.detail : "message_request_rejected",
      typeof event.reason === "string" ? event.reason : "message_rejected"
    );
    if (!attempt.firstSettled) {
      attempt.firstSettled = true;
      attempt.rejectFirst(error);
    }
    attempt.rejectFinal(error);
  }

  private rejectPendingMessageAttempts(error: Error): void {
    for (const [key, attempt] of this.pendingMessageAttempts) {
      this.pendingMessageAttempts.delete(key);
      if (attempt.acknowledgementTimer) clearTimeout(attempt.acknowledgementTimer);
      if (attempt.resultTimer) clearTimeout(attempt.resultTimer);
      if (!attempt.firstSettled) {
        attempt.firstSettled = true;
        attempt.rejectFirst(error);
      }
      attempt.rejectFinal(error);
    }
  }

  private suspendPendingMessageAttemptsForReconnect(): void {
    for (const attempt of this.pendingMessageAttempts.values()) {
      if (attempt.acknowledgementTimer) {
        clearTimeout(attempt.acknowledgementTimer);
        attempt.acknowledgementTimer = null;
      }
    }
  }

  private rawSend(socket: WebSocketLike, generation: number, frame: Record<string, unknown>): void {
    if (!this.isReadySocket(socket, generation)) {
      throw new AgentGatewayUnavailableError();
    }
    sendJson(socket, frame);
  }

  private assertReadyGeneration(expectedGeneration: number): void {
    const socket = this.socket;
    if (!socket || !this.isReadySocket(socket, expectedGeneration)) {
      throw new AgentGatewayUnavailableError();
    }
  }

  private isReadySocket(socket: WebSocketLike, generation: number): boolean {
    return this.isCurrentSocket(socket, generation)
      && this.readyGeneration === generation
      && socket.readyState === WS_OPEN;
  }

  private isCurrentSocket(socket: WebSocketLike, generation: number): boolean {
    return !this.intentionallyClosed
      && this.socket === socket
      && this.connectionGeneration === generation;
  }

  private dispatchChat(chatId: string, event: MemmyAgentWsEvent): void {
    const handlers = this.chatHandlers.get(chatId);
    if (handlers?.size) {
      for (const handler of handlers) {
        handler(event);
      }
      return;
    }

    const queue = this.pendingInboundByChat.get(chatId) ?? [];
    queue.push(event);
    const overflow = queue.length - PENDING_INBOUND_MAX;
    if (overflow > 0) {
      queue.splice(0, overflow);
    }
    this.pendingInboundByChat.set(chatId, queue);
  }

  private resolvePendingNewChat(event: MemmyAgentWsEvent, generation: number): void {
    const pending = this.pendingNewChat;
    const modelSelection = parseMemmyAgentModelSelection(event.model_selection);
    if (
      !pending
      || pending.generation !== generation
      || event.client_request_id !== pending.clientRequestId
      || !event.chat_id
      || !modelSelection
    ) {
      return;
    }
    this.pendingNewChat = null;
    clearTimeout(pending.timer);
    pending.resolve({
      chatId: event.chat_id,
      modelPreset: modelSelection.presetId,
      modelSelection
    });
  }

  private rejectPendingNewChat(error: Error): void {
    const pending = this.pendingNewChat;
    if (!pending) {
      return;
    }
    this.pendingNewChat = null;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private rejectPendingNewChatAttempt(event: MemmyAgentWsEvent, generation: number): void {
    const pending = this.pendingNewChat;
    if (
      !pending
      || pending.generation !== generation
      || event.client_request_id !== pending.clientRequestId
      || event.detail !== "new_chat_rejected"
    ) {
      return;
    }
    this.rejectPendingNewChat(new MemmyAgentMessageRejectedError(
      typeof event.detail === "string" ? event.detail : "new_chat_rejected",
      typeof event.reason === "string" ? event.reason : "message_rejected"
    ));
  }

  private resolveRunStatusSnapshot(chatId: string, event: MemmyAgentWsEvent, generation: number): void {
    if (event.event !== "run_status_snapshot") {
      return;
    }
    const pending = this.pendingRunStatusSnapshots.get(chatId);
    if (!pending || pending.generation !== generation) {
      return;
    }
    const status = event.status === "running" ? "running" : event.status === "idle" ? "idle" : null;
    if (!status) {
      return;
    }
    this.pendingRunStatusSnapshots.delete(chatId);
    clearTimeout(pending.timer);
    pending.resolve({
      status,
      startedAt: typeof event.started_at === "number" ? event.started_at : null,
      turnId: typeof event.turn_id === "string" ? event.turn_id : typeof event.turnId === "string" ? event.turnId : null,
      source: parseAgentTurnSource(event.source),
      connectionGeneration: generation
    });
  }

  private rejectPendingRunStatusSnapshots(error: Error, generation?: number): void {
    for (const [chatId, pending] of this.pendingRunStatusSnapshots) {
      if (generation !== undefined && pending.generation !== generation) {
        continue;
      }
      this.pendingRunStatusSnapshots.delete(chatId);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private rejectInitialReady(error: Error): void {
    const pending = this.pendingInitialReady;
    if (!pending) {
      return;
    }
    this.pendingInitialReady = null;
    pending.reject(error);
  }

  private clearReadyHandshakeTimer(): void {
    if (!this.readyHandshakeTimer) {
      return;
    }
    clearTimeout(this.readyHandshakeTimer);
    this.readyHandshakeTimer = null;
  }

  private recordRunStatus(chatId: string, event: MemmyAgentWsEvent): void {
    if (event.event !== "run_status" && event.event !== "turn_end" && event.event !== "stop_result" && event.event !== "run_status_snapshot") {
      return;
    }
    if (event.event === "run_status_snapshot") {
      if (event.status !== "running" && event.status !== "idle") {
        return;
      }
      if (event.status === "running" && typeof event.started_at !== "number") {
        return;
      }
    }
    const lifecycleEvent = { ...event, chat_id: chatId } as MemmyAgentRunLifecycleEvent;
    if (event.status === "running" && typeof event.started_at === "number") {
      this.runStartedAtByChatId.set(chatId, event.started_at);
      for (const handler of this.runStatusHandlers) {
        handler(chatId, event.started_at);
      }
      for (const handler of this.runLifecycleHandlers) {
        handler(chatId, lifecycleEvent);
      }
      return;
    }
    this.runStartedAtByChatId.delete(chatId);
    for (const handler of this.runStatusHandlers) {
      handler(chatId, null);
    }
    for (const handler of this.runLifecycleHandlers) {
      handler(chatId, lifecycleEvent);
    }
  }

  private recordGoalState(chatId: string, event: MemmyAgentWsEvent): void {
    if (event.event !== "goal_state") return;
    const parsed = AgentGoalStateSchema.safeParse(event.goal_state);
    if (!parsed.success) return;
    this.goalStateByChatId.set(chatId, parsed.data);
    for (const [key, pending] of this.pendingGoalControls) {
      if (pending.input.chatId !== chatId || !pending.calibrating) continue;
      this.pendingGoalControls.delete(key);
      if (pending.timer) clearTimeout(pending.timer);
      if (goalControlPostcondition(pending.input, parsed.data)) {
        pending.resolve({ ok: true, requestId: pending.input.requestId });
      } else {
        pending.reject(new MemmyAgentGoalControlError("result_unknown", { unknownResult: true }));
      }
    }
  }

  private resolvePendingGoalControl(event: MemmyAgentWsEvent): void {
    const chatId = event.chat_id;
    const requestId = typeof event.request_id === "string" ? event.request_id : null;
    if (!chatId || !requestId) return;
    const key = messageAttemptKey(chatId, requestId);
    const pending = this.pendingGoalControls.get(key);
    if (!pending) return;
    this.pendingGoalControls.delete(key);
    if (pending.timer) clearTimeout(pending.timer);
    if (event.ok === true) {
      pending.resolve({
        ok: true,
        requestId,
        ...(event.warning === "turn_cancel_failed" ? { warning: event.warning } : {})
      });
      return;
    }
    pending.reject(new MemmyAgentGoalControlError(
      typeof event.error === "string" ? event.error : "invalid_transition"
    ));
  }

  private beginGoalControlCalibration(key: string, pending: PendingGoalControl): void {
    if (this.pendingGoalControls.get(key) !== pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    pending.calibrating = true;
    const generation = this.readyGeneration;
    if (generation !== null) this.sendAttach(pending.input.chatId, generation);
    pending.timer = setTimeout(() => {
      if (this.pendingGoalControls.get(key) !== pending) return;
      this.pendingGoalControls.delete(key);
      pending.reject(new MemmyAgentGoalControlError("result_unknown", { unknownResult: true }));
    }, GOAL_CONTROL_HYDRATE_TIMEOUT_MS);
  }

  private rejectPendingGoalControls(error: Error): void {
    for (const [key, pending] of this.pendingGoalControls) {
      this.pendingGoalControls.delete(key);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private resolvePendingQueueRemoval(event: MemmyAgentWsEvent): void {
    const requestId = typeof event.request_id === "string" ? event.request_id : null;
    if (!requestId) return;
    const pending = this.pendingQueueRemovals.get(requestId);
    if (!pending) return;
    if (
      event.chat_id !== pending.chatId
      || event.client_request_id !== pending.clientRequestId
    ) return;
    this.pendingQueueRemovals.delete(requestId);
    clearTimeout(pending.timer);
    if (
      event.ok === true
      && (event.outcome === "removed" || event.outcome === "already_dequeued")
      && typeof event.revision === "number"
      && Number.isSafeInteger(event.revision)
      && event.revision >= 0
    ) {
      pending.resolve({ outcome: event.outcome, revision: event.revision });
      return;
    }
    pending.reject(new Error(
      typeof event.error === "string" ? event.error : "Unable to remove queued message"
    ));
  }

  private rejectPendingQueueRemovals(error: Error): void {
    for (const [requestId, pending] of this.pendingQueueRemovals) {
      this.pendingQueueRemovals.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private resolvePendingQueueSteer(event: MemmyAgentWsEvent): void {
    const requestId = typeof event.request_id === "string" ? event.request_id : null;
    if (!requestId) return;
    const pending = this.pendingQueueSteers.get(requestId);
    if (!pending) return;
    if (
      event.chat_id !== pending.chatId
      || event.client_request_id !== pending.clientRequestId
    ) return;
    this.pendingQueueSteers.delete(requestId);
    clearTimeout(pending.timer);
    const validOutcome = event.outcome === "steered"
      || event.outcome === "not_steerable"
      || event.outcome === "already_dequeued"
      || event.outcome === "missing";
    const turnId = typeof event.turn_id === "string" ? event.turn_id : null;
    if (
      event.ok === true
      && validOutcome
      && typeof event.revision === "number"
      && Number.isSafeInteger(event.revision)
      && event.revision >= 0
      && (event.outcome !== "steered" || turnId === pending.expectedTurnId)
    ) {
      pending.resolve({
        outcome: event.outcome as MemmyAgentQueueSteerResult["outcome"],
        revision: event.revision,
        turnId
      });
      return;
    }
    pending.reject(new Error(
      typeof event.error === "string" ? event.error : "Unable to steer queued message"
    ));
  }

  private rejectPendingQueueSteers(error: Error): void {
    for (const [requestId, pending] of this.pendingQueueSteers) {
      this.pendingQueueSteers.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private emitEvent(event: MemmyAgentWsEvent): void {
    this.input.onEvent?.(event);
  }
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

function messageAttemptKey(chatId: string, clientRequestId: string): string {
  return `${chatId}\u0000${clientRequestId}`;
}

function sameMessageAttempt(
  left: MemmyAgentSendMessageInput,
  right: MemmyAgentSendMessageInput
): boolean {
  return JSON.stringify({
    chatId: left.chatId,
    content: left.content,
    clientRequestId: left.clientRequestId,
    target: left.target ?? null,
    language: left.language ?? null,
    modelPreset: left.modelPreset ?? null,
    mediaPaths: left.media?.map((item) => item.path) ?? []
  }) === JSON.stringify({
    chatId: right.chatId,
    content: right.content,
    clientRequestId: right.clientRequestId,
    target: right.target ?? null,
    language: right.language ?? null,
    modelPreset: right.modelPreset ?? null,
    mediaPaths: right.media?.map((item) => item.path) ?? []
  });
}

function sameGoalControl(
  left: AgentGoalControlInput & { requestId: string },
  right: AgentGoalControlInput & { requestId: string }
): boolean {
  return JSON.stringify({
    chatId: left.chatId,
    requestId: left.requestId,
    goalId: left.goalId,
    action: left.action,
    objective: left.action === "edit" ? left.objective?.trim() ?? "" : null,
    tokenBudget: left.action === "set_budget" ? left.tokenBudget ?? null : null
  }) === JSON.stringify({
    chatId: right.chatId,
    requestId: right.requestId,
    goalId: right.goalId,
    action: right.action,
    objective: right.action === "edit" ? right.objective?.trim() ?? "" : null,
    tokenBudget: right.action === "set_budget" ? right.tokenBudget ?? null : null
  });
}

function goalControlPostcondition(
  input: AgentGoalControlInput,
  state: AgentGoalState
): boolean {
  if (input.action === "clear") return state.goal_id === null && state.status === null;
  if (state.goal_id !== input.goalId) return false;
  if (input.action === "pause") return state.status === "paused";
  if (input.action === "resume") return state.status === "active";
  if (input.action === "edit") return state.objective === input.objective?.trim();
  return state.token_budget === (input.tokenBudget ?? null);
}

function combineAbortSignals(
  external: AbortSignal | undefined,
  timeout: AbortSignal | undefined
): AbortSignal | undefined {
  if (!external) return timeout;
  if (!timeout) return external;
  const controller = new AbortController();
  const abort = (signal: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  if (external.aborted) abort(external);
  if (timeout.aborted) abort(timeout);
  external.addEventListener("abort", () => abort(external), { once: true });
  timeout.addEventListener("abort", () => abort(timeout), { once: true });
  return controller.signal;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value || DEFAULT_MEMMY_AGENT_WEBUI_BASE_URL);
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return url.toString();
}

function stableClientId(): string {
  const storage = typeof window === "undefined" ? null : window.localStorage;
  const key = "memmy-agent-webui-client-id";
  const existing = storage?.getItem(key);
  if (existing) {
    return existing;
  }

  const randomId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  const generated = `frontend-${randomId}`;
  storage?.setItem(key, generated);
  return generated;
}

function parseWsEvent(data: unknown): MemmyAgentWsEvent | null {
  if (typeof data !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.event === "string"
      ? parsed as MemmyAgentWsEvent
      : null;
  } catch {
    return null;
  }
}

function readHistoryDagPayload(value: unknown): HistoryDagPayload | null {
  if (!isRecord(value)) return null;
  const payload = value.historyDag;
  if (!isRecord(payload)) return null;
  if (typeof payload.sessionKey !== "string") return null;
  if (!Array.isArray(payload.nodes) || !Array.isArray(payload.edges) || !Array.isArray(payload.activePathNodeIds)) return null;
  const hasActivePathEdgeIds = Object.prototype.hasOwnProperty.call(payload, "activePathEdgeIds");
  return {
    sessionKey: payload.sessionKey,
    nodes: payload.nodes.filter(isHistoryDagNode),
    edges: payload.edges.filter(isHistoryDagEdge),
    activePathNodeIds: payload.activePathNodeIds.filter((id): id is string => typeof id === "string"),
    ...(hasActivePathEdgeIds ? {
      activePathEdgeIds: Array.isArray(payload.activePathEdgeIds)
        ? payload.activePathEdgeIds.filter((id): id is string => typeof id === "string")
        : []
    } : {}),
    snapshotText: typeof payload.snapshotText === "string" ? payload.snapshotText : ""
  };
}

function isHistoryDagNode(value: unknown): value is HistoryDagPayloadNode {
  return isRecord(value)
    && typeof value.id === "string"
    && (value.kind === "task" || value.kind === "subtask" || value.kind === "decision")
    && (value.status === "active" || value.status === "done" || value.status === "failed" || value.status === "blocked" || value.status === "frozen")
    && typeof value.title === "string"
    && typeof value.summary === "string"
    && typeof value.importance === "number"
    && isHistoryDagWriteSource(value.createdBy)
    && isHistoryDagWriteSource(value.updatedBy)
    && Array.isArray(value.sourceRefs);
}

function isHistoryDagEdge(value: unknown): value is HistoryDagPayloadEdge {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.source_id === "string"
    && typeof value.target_id === "string"
    && (value.type === "decomposes" || value.type === "continues" || value.type === "blocks" || value.type === "supersedes")
    && isHistoryDagWriteSource(value.createdBy);
}

function isHistoryDagWriteSource(value: unknown): value is HistoryDagPayloadNode["createdBy"] {
  return value === "llm_patch" || value === "deterministic_fallback" || value === "repair";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function sendJson(ws: WebSocketLike, payload: Record<string, unknown>): void {
  ws.send(JSON.stringify(payload));
}

const AGENT_UPLOAD_UNSAFE_FILENAME_CHARS = new RegExp(
  `[<>:"/\\\\|?*${String.fromCharCode(0)}-${String.fromCharCode(31)}]`,
  "g"
);

function uploadFilenameForMedia(name: string, mime: UploadedAgentMedia["mime"], kind: UploadedAgentMedia["kind"]): string {
  const fallback = kind === "image" ? "image" : "attachment";
  const base = uploadFilenameBase(name, fallback);
  if (kind === "file") {
    return base;
  }

  const ext = mime === "image/jpeg" ? ".jpg" : `.${mime.slice("image/".length)}`;
  return base.replace(/\.[^.]*$/, "") + ext;
}

function uploadFilenameBase(name: string, fallback: string): string {
  const base = (name || fallback).split(/[\\/]/).pop()?.replace(AGENT_UPLOAD_UNSAFE_FILENAME_CHARS, "_").trim() || fallback;
  return base && base !== "." && base !== ".." ? base : fallback;
}

function blobWithUploadMime(blob: Blob, mime: UploadedAgentMedia["mime"]): Blob {
  return blob.type === mime ? blob : new Blob([blob], { type: mime });
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const data = await response.json();
    if (data && typeof data === "object" && "error" in data && typeof data.error === "string") {
      return data.error;
    }
  } catch {
    // Fall through to generic status message.
  }
  return `memmy-agent request failed with status ${response.status}`;
}

async function parseRequestError(response: Response): Promise<{
  message: string;
  code: string | null;
  data?: { sidebarState: MemmyAgentSidebarState };
}> {
  try {
    const body = await response.json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const record = body as Record<string, unknown>;
      const code = typeof record.code === "string" ? record.code : null;
      const message = typeof record.message === "string"
        ? record.message
        : typeof record.error === "string"
          ? record.error
          : `memmy-agent request failed with status ${response.status}`;
      if (code === "sidebar_state_conflict") {
        const sidebarState = SidebarStateSchema.safeParse(record.sidebarState);
        if (sidebarState.success) {
          return { message, code, data: { sidebarState: sidebarState.data } };
        }
      }
      return { message, code };
    }
  } catch {
    // Fall through to the status-only error.
  }
  return {
    message: `memmy-agent request failed with status ${response.status}`,
    code: null
  };
}
