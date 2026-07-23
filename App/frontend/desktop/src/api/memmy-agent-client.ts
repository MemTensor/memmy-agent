/**
 * memmy-agent WebUI gateway client.
 *
 * This client talks to the local memmy-agent WebUI HTTP + WebSocket gateway.
 * It is separate from the desktop local API client because it uses bootstrap
 * bearer tokens and a WebSocket protocol owned by memmy-agent.
 */
import { z } from "zod";

export const DEFAULT_MEMMY_AGENT_WEBUI_BASE_URL = "http://127.0.0.1:18980";
const WEBUI_TOKEN_REFRESH_SKEW_MS = 30_000;

const BootstrapSchema = z.object({
  token: z.string(),
  ws_path: z.string(),
  expires_in: z.number(),
  model_name: z.string().nullable()
});

const SessionSummarySchema = z.object({
  key: z.string(),
  title: z.string().optional(),
  preview: z.string().optional(),
  updatedAt: z.string().optional(),
  run_started_at: z.number().optional()
}).passthrough();

const SessionsResponseSchema = z.object({
  sessions: z.array(SessionSummarySchema)
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
  "/goal",
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
    sort: z.union([z.literal("updated_desc"), z.literal("created_desc"), z.literal("title_asc")])
  }),
  updated_at: z.string().nullable()
});

const WebuiThreadSchema = z.object({
  schemaVersion: z.number(),
  sessionKey: z.string(),
  last_turn_closed: z.boolean().optional(),
  messages: z.array(z.record(z.string(), z.unknown()))
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
export type MemmyAgentSessionSummary = z.infer<typeof SessionSummarySchema>;
export type MemmyAgentSidebarState = z.infer<typeof SidebarStateSchema>;
export type MemmyAgentWebuiThread = z.infer<typeof WebuiThreadSchema>;
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

export type MemmyAgentSendMessageInput = {
  chatId: string;
  content: string;
  language?: MemmyAgentUiLanguage;
  media?: MemmyAgentMediaInput[];
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
  latency_ms?: number;
  media_urls?: MemmyAgentMediaAttachment[];
  metadata?: Record<string, unknown>;
  tool_events?: unknown;
  agent_ui?: unknown;
  edits?: unknown;
  goal_state?: unknown;
  compaction_id?: string;
  status?: string;
  started_at?: number;
  stopped?: number;
  scope?: string;
  model_name?: string;
  model_preset?: string;
  [key: string]: unknown;
};

export type MemmyAgentRunLifecycleEvent = MemmyAgentWsEvent & {
  event: "goal_status" | "turn_end" | "stop_result" | "run_status_snapshot";
  chat_id: string;
};

export interface MemmyAgentClient {
  bootstrap(options?: { force?: boolean }): Promise<MemmyAgentBootstrap>;
  listSessions(): Promise<MemmyAgentSessionSummary[]>;
  listSlashCommands(): Promise<MemmyAgentSlashCommand[]>;
  readSidebarState(): Promise<MemmyAgentSidebarState>;
  writeSidebarState(state: MemmyAgentSidebarState): Promise<MemmyAgentSidebarState>;
  readWebuiThread(sessionKey: string): Promise<MemmyAgentWebuiThread>;
  readLastCompaction(sessionKey: string): Promise<MemmyAgentLastCompaction>;
  renameSession(sessionKey: string, title: string): Promise<MemmyAgentSessionSummary>;
  deleteSession(sessionKey: string): Promise<boolean>;
  resolveArtifact(path: string): Promise<ResolvedAgentArtifact>;
  revealArtifact(path: string): Promise<void>;
  openArtifact(path: string): Promise<void>;
  uploadAgentMedia(attachments: UploadAgentMediaInput[]): Promise<UploadedAgentMedia[]>;
  uploadAgentImages(images: UploadAgentImageInput[]): Promise<UploadedAgentImage[]>;
  connectWebSocket(onEvent?: (event: MemmyAgentWsEvent) => void): Promise<MemmyAgentWebSocketConnection>;
  sessionKeyToChatId(sessionKey: string): string;
  chatIdToSessionKey(chatId: string): string;
}

export type MemmyAgentUnsubscribe = () => void;

export interface MemmyAgentWebSocketConnection {
  getReadyGeneration(): number | null;
  newChat(expectedGeneration: number, timeoutMs?: number): Promise<string>;
  attach(chatId: string): void;
  sendMessage(input: MemmyAgentSendMessageInput, expectedGeneration: number): void;
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
  getGoalState(chatId: string): unknown;
  close(): void;
}

export type MemmyAgentRunStatusSnapshot = {
  status: "running" | "idle";
  startedAt: number | null;
  turnId: string | null;
  connectionGeneration: number;
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

  constructor(message: string, status: number) {
    super(message);
    this.name = "MemmyAgentRequestError";
    this.status = status;
  }
}

export class AgentGatewayUnavailableError extends Error {
  constructor(message = "Agent gateway is not ready") {
    super(message);
    this.name = "AgentGatewayUnavailableError";
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

  async listSessions(): Promise<MemmyAgentSessionSummary[]> {
    const response = await this.request("/api/sessions", SessionsResponseSchema);
    return response.sessions;
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

  async writeSidebarState(state: MemmyAgentSidebarState): Promise<MemmyAgentSidebarState> {
    const query = new URLSearchParams({ state: JSON.stringify(state) });
    return this.request(`/api/webui/sidebar-state/update?${query.toString()}`, SidebarStateSchema);
  }

  async readWebuiThread(sessionKey: string): Promise<MemmyAgentWebuiThread> {
    return this.request(`/api/sessions/${encodeURIComponent(sessionKey)}/webui-thread`, WebuiThreadSchema);
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

  async resolveArtifact(path: string): Promise<ResolvedAgentArtifact> {
    return this.request("/api/webui/artifacts/resolve", ResolvedArtifactSchema, {
      method: "POST",
      body: { path }
    });
  }

  async revealArtifact(path: string): Promise<void> {
    await this.request("/api/webui/artifacts/reveal", RevealArtifactResponseSchema, {
      method: "POST",
      body: { path }
    });
  }

  async openArtifact(path: string): Promise<void> {
    await this.request("/api/webui/artifacts/open", RevealArtifactResponseSchema, {
      method: "POST",
      body: { path }
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
    options: { includeToken?: boolean; headers?: Record<string, string>; method?: string; body?: unknown; retryOnUnauthorized?: boolean } = {}
  ): Promise<T> {
    const includeToken = options.includeToken ?? true;
    const retryOnUnauthorized = options.retryOnUnauthorized ?? true;
    const send = async (boot: MemmyAgentBootstrap | null): Promise<Response> => {
      const headers = {
        ...(options.headers ?? {}),
        ...(options.body == null ? {} : { "Content-Type": "application/json" }),
        ...(boot ? { Authorization: `Bearer ${boot.token}` } : {})
      };
      return this.fetchFn(new URL(path, this.baseUrl), {
        method: options.method ?? "GET",
        headers: Object.keys(headers).length ? headers : undefined,
        ...(options.body == null ? {} : { body: JSON.stringify(options.body) })
      });
    };

    let boot = includeToken ? await this.bootstrap() : null;
    let response = await send(boot);
    if (response.status === 401 && includeToken && retryOnUnauthorized) {
      this.boot = null;
      this.bootExpiresAtMs = 0;
      boot = await this.bootstrap({ force: true });
      response = await send(boot);
    }

    if (!response.ok) {
      throw new MemmyAgentRequestError(await errorMessage(response), response.status);
    }

    const parsed = schema.parse(await response.json());
    return normalizeGatewayMediaUrls(parsed, this.baseUrl);
  }
}

const WS_OPEN = 1;
const PENDING_INBOUND_MAX = 2000;
const READY_HANDSHAKE_TIMEOUT_MS = 5_000;

interface MemmyAgentWebSocketSessionInput {
  bootstrap(options?: { force?: boolean }): Promise<MemmyAgentBootstrap>;
  baseUrl: string;
  clientId: string;
  webSocketFactory: (url: string) => WebSocketLike;
  onEvent?: (event: MemmyAgentWsEvent) => void;
}

interface PendingNewChat {
  generation: number;
  resolve: (chatId: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingRunStatusSnapshot {
  generation: number;
  resolve: (snapshot: MemmyAgentRunStatusSnapshot) => void;
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
  private readonly goalStateByChatId = new Map<string, unknown>();

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

  newChat(expectedGeneration: number, timeoutMs = 5000): Promise<string> {
    if (this.pendingNewChat) {
      return Promise.reject(new Error("newChat already in flight"));
    }

    try {
      this.assertReadyGeneration(expectedGeneration);
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise<string>((resolve, reject) => {
      const pending: PendingNewChat = {
        generation: expectedGeneration,
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
        this.sendOrdinaryFrame({ type: "new_chat" }, expectedGeneration);
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

  sendMessage(input: MemmyAgentSendMessageInput, expectedGeneration: number): void {
    this.sendOrdinaryFrame({
      type: "message",
      chat_id: input.chatId,
      content: input.content,
      webui: true,
      ...(input.language ? { language: input.language } : {}),
      ...(input.media?.length ? { media_paths: input.media.map((item) => item.path) } : {})
    }, expectedGeneration);
    this.knownChats.add(input.chatId);
    this.lastOrdinarySendChatId = input.chatId;
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
        event: "goal_status",
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

  getGoalState(chatId: string): unknown {
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
      }
      if (normalized.chat_id) {
        this.knownChats.add(normalized.chat_id);
      }
      this.emitEvent(normalized);
      return;
    }

    this.emitEvent(normalized);

    if (normalized.event === "attached") {
      if (normalized.chat_id) {
        this.knownChats.add(normalized.chat_id);
        this.resolvePendingNewChat(normalized.chat_id, generation);
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
    this.rejectPendingNewChat(new Error("newChat failed because websocket closed"));
    this.rejectPendingRunStatusSnapshots(new Error("run status snapshot failed because websocket closed"), generation);
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

  private resolvePendingNewChat(chatId: string, generation: number): void {
    const pending = this.pendingNewChat;
    if (!pending || pending.generation !== generation) {
      return;
    }
    this.pendingNewChat = null;
    clearTimeout(pending.timer);
    pending.resolve(chatId);
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
    if (event.event !== "goal_status" && event.event !== "turn_end" && event.event !== "stop_result" && event.event !== "run_status_snapshot") {
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
    if (event.event === "goal_state") {
      this.goalStateByChatId.set(chatId, event.goal_state);
    } else if (event.event === "turn_end" && event.goal_state != null) {
      this.goalStateByChatId.set(chatId, event.goal_state);
    }
  }

  private emitEvent(event: MemmyAgentWsEvent): void {
    this.input.onEvent?.(event);
  }
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
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
