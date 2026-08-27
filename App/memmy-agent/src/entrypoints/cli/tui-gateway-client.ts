import crypto from "node:crypto";
import WebSocket, { type RawData } from "ws";
import {
  ModelCapabilitySchema,
  ModelEndpointProtocolSchema,
  type ModelCapability,
  type ModelEndpointProtocol,
} from "@memmy/local-api-contracts";
import type { Config } from "../../config/schema.js";
import { parseTurnSource, type TurnSource } from "../../core/runtime-messages/events.js";
import { toGuiChatId } from "../frontend-bridge/gui-session-projection.js";
import { WebSocketConfig } from "../../integrations/channels/websocket.js";

export type TuiGatewayConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed";

export type TuiGatewayQueueItem = {
  clientRequestId: string;
  text: string;
  queuedAt: string;
  source: TurnSource;
};

export type TuiGatewayMessageRole = "assistant" | "progress" | "system" | "user";

export type TuiGatewayMessage = {
  id: string;
  role: TuiGatewayMessageRole;
  text: string;
  clientRequestId: string | null;
  turnId: string | null;
};

export type TuiModelSelection = Readonly<{
  presetId: string;
  provider: string;
  endpointId: string;
  protocol: ModelEndpointProtocol;
  model: string;
  source: "account" | "byok";
  ownerAccountId: string | null;
  capabilities: readonly ModelCapability[];
}>;

export type TuiGatewayState = {
  connection: TuiGatewayConnectionStatus;
  attached: boolean;
  queueLoading: boolean;
  queueRevision: number | null;
  queueItems: TuiGatewayQueueItem[];
  busy: boolean;
  ownedByTui: boolean;
  activeTurnId: string | null;
  startedAt: number | null;
  messages: TuiGatewayMessage[];
  goalState: Record<string, unknown> | null;
  modelName: string | null;
  modelSelection: TuiModelSelection | null;
  toolNames: string[];
  notice: string;
};

export type TuiGatewaySubmissionResult = {
  clientRequestId: string;
  status: "accepted" | "queued" | "steered";
};

export type TuiGatewayStopResult = "stopped" | "already_finished" | "not_owned";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type TuiWebSocket = {
  readonly readyState: number;
  on(event: "open", listener: () => void): TuiWebSocket;
  on(event: "message", listener: (data: RawData) => void): TuiWebSocket;
  on(event: "error", listener: (error: Error) => void): TuiWebSocket;
  on(event: "close", listener: () => void): TuiWebSocket;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

type SubmissionWaiter = {
  resolve: (result: TuiGatewaySubmissionResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type PendingSubmission = {
  clientRequestId: string;
  content: string;
  admission: "queue" | "steer";
  expectedTurnId: string | null;
  frame: Record<string, unknown>;
  sentGeneration: number | null;
  waiters: Set<SubmissionWaiter>;
};

type BootstrapResponse = {
  token: string;
  ws_path: string;
  expires_in: number;
  model_name: string | null;
  model_selection: TuiModelSelection | null;
  tool_names: string[];
};

type QueueWireItem = {
  client_request_id: string;
  text: string;
  queued_at: string;
  source: TurnSource;
};

type GatewayEvent = Record<string, unknown> & {
  event: string;
  chat_id?: string;
};

export type TuiGatewayClientOptions = {
  baseUrl: string;
  bootstrapSecret?: string | null;
  sessionKey: string;
  fetchImpl?: FetchLike;
  webSocketFactory?: (url: string) => TuiWebSocket;
  reconnectDelayMs?: number;
  requestTimeoutMs?: number;
};

const CONTENT_EVENTS = new Set([
  "context_compaction",
  "delta",
  "file_edit",
  "message",
  "reasoning_delta",
  "reasoning_end",
  "retry_wait",
  "stream_end",
  "turn_end",
  "user",
]);
const WS_OPEN = 1;
const DEFAULT_RECONNECT_DELAY_MS = 500;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_TUI_MESSAGES = 24;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function gatewayUnavailable(baseUrl: string, detail?: string): Error {
  const suffix = detail ? ` (${detail})` : "";
  return new Error(
    `Gateway unavailable at ${baseUrl}${suffix}. Start Desktop runtime or run \`memmy gateway\`.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nonnegativeSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function parseGatewayEvent(value: RawData | string): GatewayEvent | null {
  try {
    const raw = typeof value === "string"
      ? value
      : Buffer.isBuffer(value)
        ? value.toString("utf8")
        : Array.isArray(value)
          ? Buffer.concat(value).toString("utf8")
          : Buffer.from(value as ArrayBuffer).toString("utf8");
    const parsed = JSON.parse(raw);
    return isRecord(parsed) && typeof parsed.event === "string"
      ? parsed as GatewayEvent
      : null;
  } catch {
    return null;
  }
}

function parseBootstrap(value: unknown): BootstrapResponse | null {
  if (!isRecord(value)) return null;
  const token = stringValue(value.token);
  const wsPath = stringValue(value.ws_path);
  if (!token || !wsPath || typeof value.expires_in !== "number") return null;
  return {
    token,
    ws_path: wsPath,
    expires_in: value.expires_in,
    model_name: stringValue(value.model_name),
    model_selection: parseModelSelection(value.model_selection),
    tool_names: Array.isArray(value.tool_names)
      ? value.tool_names.filter((item): item is string => typeof item === "string")
      : [],
  };
}

function parseModelSelection(value: unknown): TuiModelSelection | null {
  if (!isRecord(value)) return null;
  const presetId = stringValue(value.preset_id);
  const provider = stringValue(value.provider);
  const endpointId = stringValue(value.endpoint_id);
  const model = stringValue(value.model);
  const protocol = ModelEndpointProtocolSchema.safeParse(value.protocol);
  const capabilities = Array.isArray(value.capabilities)
    ? value.capabilities.map((capability) => ModelCapabilitySchema.safeParse(capability))
    : [];
  if (
    !presetId || !provider || !endpointId || !model || !protocol.success
    || (value.source !== "account" && value.source !== "byok")
    || (value.owner_account_id !== null && typeof value.owner_account_id !== "string")
    || capabilities.length === 0 || capabilities.some((capability) => !capability.success)
  ) return null;
  return Object.freeze({
    presetId,
    provider,
    endpointId,
    protocol: protocol.data,
    model,
    source: value.source,
    ownerAccountId: value.owner_account_id,
    capabilities: Object.freeze(capabilities.flatMap((capability) => (
      capability.success ? [capability.data] : []
    ))),
  });
}

function parseQueueItem(value: unknown): TuiGatewayQueueItem | null {
  if (!isRecord(value)) return null;
  const clientRequestId = stringValue(value.client_request_id);
  const queuedAt = stringValue(value.queued_at);
  const source = parseTurnSource(value.source);
  if (!clientRequestId || !queuedAt || !source || typeof value.text !== "string") return null;
  return { clientRequestId, text: value.text, queuedAt, source };
}

function normalizeHistoryMessage(value: unknown, index: number): TuiGatewayMessage | null {
  if (!isRecord(value)) return null;
  const rawRole = stringValue(value.role);
  const role: TuiGatewayMessageRole = rawRole === "user"
    ? "user"
    : rawRole === "assistant"
      ? "assistant"
      : rawRole === "tool"
        ? "progress"
        : "system";
  const traces = Array.isArray(value.traces)
    ? value.traces.filter((item): item is string => typeof item === "string")
    : [];
  const text = typeof value.content === "string"
    ? value.content
    : typeof value.text === "string"
      ? value.text
      : traces.join("\n");
  if (!text && role !== "user") return null;
  return {
    id: stringValue(value.id) ?? `history:${index}`,
    role,
    text,
    clientRequestId: stringValue(value.client_request_id) ?? stringValue(value.clientRequestId),
    turnId: stringValue(value.turn_id) ?? stringValue(value.turnId),
  };
}

function sameSubmission(
  attempt: PendingSubmission,
  content: string,
  admission: "queue" | "steer",
  expectedTurnId: string | null,
): boolean {
  return attempt.content === content
    && attempt.admission === admission
    && attempt.expectedTurnId === expectedTurnId;
}

function gatewayHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function tuiGatewayOptionsFromConfig(
  config: Config,
  sessionKey: string,
): TuiGatewayClientOptions {
  const channels = config.channels as unknown as Record<string, unknown>;
  const websocket = new WebSocketConfig(
    isRecord(channels.websocket) ? channels.websocket : {},
  );
  if (!websocket.enabled) {
    throw new Error(
      "WebSocket Gateway is disabled. Enable channels.websocket, then start Desktop runtime or run `memmy gateway`.",
    );
  }
  const protocol = websocket.sslCertfile && websocket.sslKeyfile ? "https" : "http";
  return {
    baseUrl: `${protocol}://${gatewayHost(websocket.host)}:${websocket.port}`,
    bootstrapSecret: websocket.tokenIssueSecret.trim() || websocket.token.trim() || null,
    sessionKey,
  };
}

export class TuiGatewayClient {
  readonly chatId: string;
  readonly sessionKey: string;
  private readonly baseUrl: string;
  private readonly bootstrapSecret: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly webSocketFactory: (url: string) => TuiWebSocket;
  private readonly reconnectDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly listeners = new Set<(state: TuiGatewayState) => void>();
  private readonly pendingSubmissions = new Map<string, PendingSubmission>();
  private readonly acceptedModelUpdateRequests = new Set<string>();
  private readonly queuedContents = new Map<string, string>();
  private readonly historyBuffers = new Map<number, GatewayEvent[]>();
  private socket: TuiWebSocket | null = null;
  private generation = 0;
  private closed = true;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private snapshotRequestGeneration: number | null = null;
  private desyncedQueueRevision: number | null = null;
  private initialStart: Deferred<void> | null = null;
  private stopRequest: Deferred<TuiGatewayStopResult> | null = null;
  private state: TuiGatewayState = {
    connection: "closed",
    attached: false,
    queueLoading: true,
    queueRevision: null,
    queueItems: [],
    busy: false,
    ownedByTui: false,
    activeTurnId: null,
    startedAt: null,
    messages: [],
    goalState: null,
    modelName: null,
    modelSelection: null,
    toolNames: [],
    notice: "connecting",
  };

  constructor(options: TuiGatewayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.bootstrapSecret = options.bootstrapSecret?.trim() || null;
    this.sessionKey = options.sessionKey;
    this.chatId = toGuiChatId(options.sessionKey);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  snapshot(): TuiGatewayState {
    return this.state;
  }

  subscribe(listener: (state: TuiGatewayState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (!this.closed) return this.initialStart?.promise ?? Promise.resolve();
    this.closed = false;
    this.initialStart = deferred<void>();
    this.patch({ connection: "connecting", notice: "connecting to Gateway" });
    void this.connect(true);
    return this.initialStart.promise;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "TUI closed");
    const error = new Error("TUI Gateway connection closed");
    this.initialStart?.reject(error);
    this.initialStart = null;
    this.stopRequest?.reject(error);
    this.stopRequest = null;
    for (const attempt of this.pendingSubmissions.values()) {
      this.rejectSubmissionWaiters(attempt, error);
    }
    this.pendingSubmissions.clear();
    this.acceptedModelUpdateRequests.clear();
    this.patch({
      connection: "closed",
      attached: false,
      busy: false,
      ownedByTui: false,
      activeTurnId: null,
      startedAt: null,
      notice: "closed",
    });
  }

  submit(
    content: string,
    admission: "queue" | "steer",
    clientRequestId: string = crypto.randomUUID(),
  ): Promise<TuiGatewaySubmissionResult> {
    const text = content.trim();
    if (!text) return Promise.reject(new Error("Message is empty"));
    if (!this.state.attached || this.state.connection !== "connected") {
      return Promise.reject(new Error("Gateway is not attached to this Session"));
    }
    const expectedTurnId = admission === "steer" ? this.state.activeTurnId : null;
    if (admission === "steer" && (!this.state.ownedByTui || !expectedTurnId)) {
      return Promise.reject(new Error("The current Turn is not owned by this TUI"));
    }
    const existing = this.pendingSubmissions.get(clientRequestId);
    if (existing && !sameSubmission(existing, text, admission, expectedTurnId)) {
      return Promise.reject(new Error("client_request_id conflicts with another submission"));
    }
    const attempt = existing ?? {
      clientRequestId,
      content: text,
      admission,
      expectedTurnId,
      frame: {
        type: "message",
        chat_id: this.chatId,
        content: text,
        webui: true,
        queue_surface: "chat_composer",
        client_request_id: clientRequestId,
        turn_admission: admission,
        ...(expectedTurnId ? { expected_turn_id: expectedTurnId } : {}),
      },
      sentGeneration: null,
      waiters: new Set<SubmissionWaiter>(),
    };
    this.pendingSubmissions.set(clientRequestId, attempt);
    const result = this.waitForSubmission(attempt);
    this.sendSubmission(attempt);
    return result;
  }

  async stopOwnedTurn(): Promise<TuiGatewayStopResult> {
    const expectedTurnId = this.state.ownedByTui ? this.state.activeTurnId : null;
    if (!expectedTurnId) throw new Error("The current Turn is not owned by this TUI");
    if (!this.state.attached || this.state.connection !== "connected") {
      throw new Error("Gateway is not attached to this Session");
    }
    if (this.stopRequest) return this.stopRequest.promise;
    const pending = deferred<TuiGatewayStopResult>();
    this.stopRequest = pending;
    const timer = setTimeout(() => {
      if (this.stopRequest !== pending) return;
      this.stopRequest = null;
      pending.reject(new Error("Stop request timed out"));
    }, this.requestTimeoutMs);
    pending.promise.finally(() => clearTimeout(timer)).catch(() => undefined);
    this.sendFrame({
      type: "stop",
      chat_id: this.chatId,
      expected_turn_id: expectedTurnId,
    });
    return pending.promise;
  }

  private patch(patch: Partial<TuiGatewayState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private async connect(initial: boolean): Promise<void> {
    const generation = ++this.generation;
    try {
      const bootstrap = await this.bootstrap();
      if (this.closed || generation !== this.generation) return;
      this.patch({
        modelName: bootstrap.model_name,
        modelSelection: bootstrap.model_selection,
        toolNames: bootstrap.tool_names,
      });
      const url = new URL(bootstrap.ws_path, this.baseUrl);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("token", bootstrap.token);
      url.searchParams.set("client_id", `tui-${crypto.randomUUID()}`);
      url.searchParams.set("client_surface", "tui");
      const socket = this.webSocketFactory(url.toString());
      this.socket = socket;
      socket.on("open", () => this.handleOpen(socket, generation));
      socket.on("message", (data) => this.handleMessage(socket, generation, data, bootstrap.token));
      socket.on("error", (error) => this.handleSocketError(socket, generation, error));
      socket.on("close", () => this.handleClose(socket, generation));
      if (socket.readyState === WS_OPEN) this.handleOpen(socket, generation);
    } catch (error) {
      if (this.closed || generation !== this.generation) return;
      const unavailable = gatewayUnavailable(this.baseUrl, errorMessage(error));
      if (initial && this.initialStart) {
        this.initialStart.reject(unavailable);
        this.initialStart = null;
        this.closed = true;
        this.patch({ connection: "closed", notice: unavailable.message });
        return;
      }
      this.patch({ connection: "reconnecting", notice: unavailable.message });
      this.scheduleReconnect();
    }
  }

  private async bootstrap(): Promise<BootstrapResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/webui/bootstrap`, {
        headers: this.bootstrapSecret
          ? { authorization: `Bearer ${this.bootstrapSecret}` }
          : undefined,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`bootstrap HTTP ${response.status}`);
      const parsed = parseBootstrap(await response.json());
      if (!parsed) throw new Error("bootstrap response is invalid");
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }

  private handleOpen(socket: TuiWebSocket, generation: number): void {
    if (!this.isCurrent(socket, generation)) return;
    this.patch({
      connection: generation === 1 ? "connecting" : "reconnecting",
      attached: false,
      queueLoading: true,
      queueRevision: null,
      queueItems: [],
      busy: false,
      ownedByTui: false,
      activeTurnId: null,
      startedAt: null,
      goalState: null,
      notice: "attaching Session",
    });
    this.desyncedQueueRevision = null;
  }

  private handleMessage(
    socket: TuiWebSocket,
    generation: number,
    raw: RawData,
    apiToken: string,
  ): void {
    if (!this.isCurrent(socket, generation)) return;
    const event = parseGatewayEvent(raw);
    if (!event) return;
    if (event.event === "ready") {
      this.sendFrame({ type: "attach", chat_id: this.chatId });
      return;
    }
    if (event.chat_id && event.chat_id !== this.chatId) return;
    if (event.event === "attached") {
      this.patch({
        attached: true,
        modelSelection: parseModelSelection(event.model_selection) ?? this.state.modelSelection,
        notice: "loading Session",
      });
      this.historyBuffers.set(generation, []);
      void this.hydrateHistory(generation, apiToken);
      return;
    }
    if (!this.state.attached) return;
    this.applyControlEvent(event, generation);
    if (!CONTENT_EVENTS.has(event.event)) return;
    const contentSource = parseTurnSource(event.source)
      ?? (isRecord(event.metadata) ? parseTurnSource(event.metadata.turn_source) : null);
    if (contentSource?.kind !== "tui") return;
    const buffer = this.historyBuffers.get(generation);
    if (buffer) {
      buffer.push(event);
      return;
    }
    this.applyTranscriptEvent(event);
  }

  private applyControlEvent(event: GatewayEvent, generation: number): void {
    if (event.event === "message_queue_snapshot") {
      const revision = nonnegativeSafeInteger(event.revision);
      const rawItems = Array.isArray(event.items) ? event.items : null;
      if (revision === null || !rawItems) return;
      const items = rawItems.map(parseQueueItem);
      if (items.some((item) => item === null)) return;
      if (this.state.queueRevision !== null && revision < this.state.queueRevision) return;
      if (this.desyncedQueueRevision !== null && revision < this.desyncedQueueRevision) return;
      this.snapshotRequestGeneration = null;
      this.desyncedQueueRevision = null;
      this.patch({
        queueLoading: false,
        queueRevision: revision,
        queueItems: items as TuiGatewayQueueItem[],
      });
      const startedItems = Array.isArray(event.started_items)
        ? event.started_items.map(parseQueueItem).filter((item): item is TuiGatewayQueueItem => item !== null)
        : [];
      for (const item of startedItems) this.promoteQueueItem(item);
      return;
    }
    if (event.event === "message_queued") {
      const id = stringValue(event.client_request_id);
      const item = parseQueueItem(event.item);
      if (id && item) this.queuedContents.set(id, item.text);
      if (item) this.applyQueueIncrement(event, (items) => [...items, item]);
      this.resolveSubmission(id, "queued");
      return;
    }
    if (event.event === "message_dequeued") {
      const item = parseQueueItem(event.item);
      const id = stringValue(event.client_request_id) ?? item?.clientRequestId ?? null;
      this.applyQueueIncrement(event, (items) => items.filter((candidate) => candidate.clientRequestId !== id));
      if (item) this.promoteQueueItem(item);
      return;
    }
    if (event.event === "message_queue_removed") {
      const id = stringValue(event.client_request_id);
      this.applyQueueIncrement(event, (items) => items.filter((candidate) => candidate.clientRequestId !== id));
      if (id) this.queuedContents.delete(id);
      return;
    }
    if (event.event === "message_steered") {
      const id = stringValue(event.client_request_id);
      if (id) this.promoteSubmission(id, stringValue(event.turn_id));
      this.resolveSubmission(id, "steered");
      return;
    }
    if (event.event === "message_accepted") {
      const id = stringValue(event.client_request_id);
      const attempt = id ? this.pendingSubmissions.get(id) : null;
      const selection = attempt ? parseModelSelection(event.model_selection) : null;
      if (selection) this.patch({ modelSelection: selection, modelName: selection.model });
      if (id && attempt?.content.trim().match(/^\/model\s+\S+$/i)) {
        this.acceptedModelUpdateRequests.add(id);
      }
      if (id && !this.state.queueItems.some((item) => item.clientRequestId === id)) {
        this.promoteSubmission(id, stringValue(event.turn_id));
      }
      this.resolveSubmission(id, "accepted");
      return;
    }
    if (event.event === "runtime_model_updated") {
      const id = stringValue(event.client_request_id);
      if (!id || !this.acceptedModelUpdateRequests.delete(id)) return;
      const selection = parseModelSelection(event.model_selection);
      if (selection) this.patch({ modelSelection: selection, modelName: selection.model });
      return;
    }
    if (event.event === "goal_state") {
      this.patch({ goalState: isRecord(event.goal_state) ? { ...event.goal_state } : null });
      return;
    }
    if (event.event === "run_status" || event.event === "run_status_snapshot") {
      const busy = event.status === "running" || event.busy === true;
      const ownedByTui = busy && event.owned_by_tui === true;
      this.patch({
        busy,
        ownedByTui,
        activeTurnId: ownedByTui ? stringValue(event.turn_id) ?? stringValue(event.turnId) : null,
        startedAt: busy && typeof event.started_at === "number" ? event.started_at * 1_000 : null,
        notice: busy
          ? ownedByTui
            ? "working"
            : "Session is running from another channel"
          : "ready",
      });
      return;
    }
    if (event.event === "stop_result") {
      const outcome = event.outcome;
      if (
        this.stopRequest
        && (outcome === "stopped" || outcome === "already_finished" || outcome === "not_owned")
      ) {
        const pending = this.stopRequest;
        this.stopRequest = null;
        pending.resolve(outcome);
      }
      return;
    }
    if (event.event === "error") {
      const id = stringValue(event.client_request_id);
      if (id) this.rejectSubmission(id, new Error(stringValue(event.reason) ?? stringValue(event.detail) ?? "Gateway rejected message"));
      if (this.stopRequest && event.detail === "stop_failed") {
        const pending = this.stopRequest;
        this.stopRequest = null;
        pending.reject(new Error(stringValue(event.reason) ?? "Stop failed"));
      }
      return;
    }
    if (event.event === "turn_end" && stringValue(event.turn_id) === this.state.activeTurnId) {
      this.patch({ busy: false, ownedByTui: false, activeTurnId: null, startedAt: null, notice: "ready" });
    }
    if (event.event === "attached" && generation !== this.generation) return;
  }

  private applyQueueIncrement(
    event: GatewayEvent,
    apply: (items: TuiGatewayQueueItem[]) => TuiGatewayQueueItem[],
  ): void {
    const revision = nonnegativeSafeInteger(event.revision);
    const current = this.state.queueRevision;
    if (revision === null || current === null || revision > current + 1) {
      if (revision !== null) {
        this.desyncedQueueRevision = Math.max(this.desyncedQueueRevision ?? 0, revision);
      }
      this.requestQueueSnapshot();
      return;
    }
    if (revision <= current) return;
    this.patch({ queueRevision: revision, queueItems: apply(this.state.queueItems) });
  }

  private requestQueueSnapshot(): void {
    if (this.snapshotRequestGeneration === this.generation) return;
    this.snapshotRequestGeneration = this.generation;
    this.patch({ queueLoading: true, queueItems: [] });
    try {
      this.sendFrame({ type: "queue_snapshot_request", chat_id: this.chatId });
    } catch {
      // A reconnect will request the authoritative attach snapshot.
    }
  }

  private async hydrateHistory(generation: number, apiToken: string): Promise<void> {
    try {
      const key = encodeURIComponent(`websocket:${this.chatId}`);
      const response = await this.fetchImpl(
        `${this.baseUrl}/api/sessions/${key}/webui-thread?surface=tui`,
        { headers: { authorization: `Bearer ${apiToken}` } },
      );
      if (!this.isGenerationCurrent(generation)) return;
      let messages: TuiGatewayMessage[] = [];
      if (response.status !== 404) {
        if (!response.ok) throw new Error(`history HTTP ${response.status}`);
        const body = await response.json();
        if (!isRecord(body) || !Array.isArray(body.messages)) {
          throw new Error("history response is invalid");
        }
        messages = body.messages
          .map(normalizeHistoryMessage)
          .filter((message): message is TuiGatewayMessage => message !== null)
          .slice(-MAX_TUI_MESSAGES);
      }
      const buffered = this.historyBuffers.get(generation) ?? [];
      this.historyBuffers.delete(generation);
      this.patch({ messages });
      this.replayBufferedTranscriptEvents(buffered);
      this.patch({ connection: "connected", attached: true, notice: this.state.busy ? this.state.notice : "ready" });
      for (const attempt of this.pendingSubmissions.values()) this.sendSubmission(attempt);
      this.initialStart?.resolve(undefined);
      this.initialStart = null;
    } catch (error) {
      if (!this.isGenerationCurrent(generation)) return;
      const startup = this.initialStart;
      if (startup) {
        const unavailable = gatewayUnavailable(this.baseUrl, errorMessage(error));
        startup.reject(unavailable);
        this.initialStart = null;
        this.closed = true;
        this.socket?.close(1011, "history unavailable");
        this.patch({ connection: "closed", attached: false, notice: unavailable.message });
        return;
      }
      this.socket?.close(1011, "history unavailable");
    }
  }

  private applyTranscriptEvent(event: GatewayEvent): void {
    const turnId = stringValue(event.turn_id) ?? stringValue(event.turnId);
    const clientRequestId = stringValue(event.client_request_id);
    if (event.event === "user") {
      this.upsertMessage({
        id: clientRequestId ? `user:${clientRequestId}` : `user:${turnId ?? crypto.randomUUID()}`,
        role: "user",
        text: typeof event.text === "string" ? event.text : "",
        clientRequestId,
        turnId,
      });
      return;
    }
    if (event.event === "delta") {
      const id = `assistant:${stringValue(event.stream_id) ?? turnId ?? "active"}`;
      const current = this.state.messages.find((message) => message.id === id)
        ?? (turnId
          ? this.state.messages.find((message) => (
              message.role === "assistant" && message.turnId === turnId
            ))
          : undefined);
      this.upsertMessage({
        id: current?.id ?? id,
        role: "assistant",
        text: `${current?.text ?? ""}${typeof event.text === "string" ? event.text : ""}`,
        clientRequestId: null,
        turnId,
      });
      return;
    }
    if (event.event === "reasoning_delta") {
      const text = typeof event.text === "string" ? event.text.trim() : "";
      if (text) this.patch({ notice: text.slice(0, 80) });
      return;
    }
    if (event.event === "message") {
      const text = typeof event.text === "string"
        ? event.text
        : typeof event.content === "string"
          ? event.content
          : "";
      const progress = event.kind === "progress" || event.tool_events != null;
      if (!text && !progress) return;
      this.upsertMessage({
        id: `${progress ? "progress" : "message"}:${turnId ?? crypto.randomUUID()}:${this.state.messages.length}`,
        role: progress ? "progress" : "assistant",
        text: text || "Tool activity",
        clientRequestId: null,
        turnId,
      });
      if (progress && text) this.patch({ notice: text.trim().slice(0, 80) });
      return;
    }
    if (event.event === "retry_wait" || event.event === "context_compaction") {
      const text = typeof event.text === "string" ? event.text : "";
      if (text) this.upsertMessage({
        id: `${event.event}:${turnId ?? crypto.randomUUID()}`,
        role: "system",
        text,
        clientRequestId: null,
        turnId,
      });
    }
  }

  private replayBufferedTranscriptEvents(events: GatewayEvent[]): void {
    for (let index = 0; index < events.length;) {
      const event = events[index]!;
      if (event.event !== "delta" || typeof event.text !== "string") {
        this.applyTranscriptEvent(event);
        index += 1;
        continue;
      }
      const turnId = stringValue(event.turn_id) ?? stringValue(event.turnId);
      const streamId = stringValue(event.stream_id);
      let end = index + 1;
      let text = event.text;
      while (end < events.length) {
        const candidate = events[end]!;
        const candidateTurnId = stringValue(candidate.turn_id) ?? stringValue(candidate.turnId);
        if (
          candidate.event !== "delta"
          || candidateTurnId !== turnId
          || stringValue(candidate.stream_id) !== streamId
          || typeof candidate.text !== "string"
        ) break;
        text += candidate.text;
        end += 1;
      }
      const existing = turnId
        ? this.state.messages.find((message) => (
            message.role === "assistant" && message.turnId === turnId
          ))
        : undefined;
      let overlap = 0;
      if (existing?.text) {
        const limit = Math.min(existing.text.length, text.length);
        for (let size = limit; size > 0; size -= 1) {
          if (existing.text.endsWith(text.slice(0, size))) {
            overlap = size;
            break;
          }
        }
      }
      if (overlap < text.length) {
        this.applyTranscriptEvent({ ...event, text: text.slice(overlap) });
      }
      index = end;
    }
  }

  private promoteQueueItem(item: TuiGatewayQueueItem): void {
    if (item.source.kind !== "tui") return;
    this.queuedContents.delete(item.clientRequestId);
    this.upsertMessage({
      id: `user:${item.clientRequestId}`,
      role: "user",
      text: item.text,
      clientRequestId: item.clientRequestId,
      turnId: null,
    });
  }

  private promoteSubmission(clientRequestId: string, turnId: string | null): void {
    const attempt = this.pendingSubmissions.get(clientRequestId);
    const text = attempt?.content ?? this.queuedContents.get(clientRequestId);
    if (!text) return;
    this.queuedContents.delete(clientRequestId);
    this.upsertMessage({
      id: `user:${clientRequestId}`,
      role: "user",
      text,
      clientRequestId,
      turnId,
    });
  }

  private upsertMessage(message: TuiGatewayMessage): void {
    const matchIndex = this.state.messages.findIndex((candidate) => (
      candidate.id === message.id
      || (
        message.clientRequestId !== null
        && candidate.clientRequestId === message.clientRequestId
        && candidate.role === message.role
      )
      || (
        message.turnId !== null
        && candidate.turnId === message.turnId
        && candidate.role === message.role
        && (
          message.role === "assistant"
          || message.role === "user"
          || candidate.text === message.text
        )
      )
    ));
    const messages = [...this.state.messages];
    if (matchIndex >= 0) messages[matchIndex] = { ...messages[matchIndex], ...message };
    else messages.push(message);
    this.patch({ messages: messages.slice(-MAX_TUI_MESSAGES) });
  }

  private waitForSubmission(attempt: PendingSubmission): Promise<TuiGatewaySubmissionResult> {
    return new Promise<TuiGatewaySubmissionResult>((resolve, reject) => {
      const waiter = {} as SubmissionWaiter;
      waiter.resolve = resolve;
      waiter.reject = reject;
      waiter.timer = setTimeout(() => {
        attempt.waiters.delete(waiter);
        attempt.sentGeneration = null;
        reject(new Error("Message confirmation timed out; the draft was kept"));
      }, this.requestTimeoutMs);
      attempt.waiters.add(waiter);
    });
  }

  private sendSubmission(attempt: PendingSubmission): void {
    if (attempt.sentGeneration === this.generation) return;
    this.sendFrame(attempt.frame);
    attempt.sentGeneration = this.generation;
  }

  private resolveSubmission(
    clientRequestId: string | null,
    status: TuiGatewaySubmissionResult["status"],
  ): void {
    if (!clientRequestId) return;
    const attempt = this.pendingSubmissions.get(clientRequestId);
    if (!attempt) return;
    if (status === "queued") this.queuedContents.set(clientRequestId, attempt.content);
    const result = { clientRequestId, status };
    for (const waiter of attempt.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(result);
    }
    attempt.waiters.clear();
    this.pendingSubmissions.delete(clientRequestId);
  }

  private rejectSubmission(clientRequestId: string, error: Error): void {
    const attempt = this.pendingSubmissions.get(clientRequestId);
    if (!attempt) return;
    this.rejectSubmissionWaiters(attempt, error);
    this.pendingSubmissions.delete(clientRequestId);
  }

  private rejectSubmissionWaiters(attempt: PendingSubmission, error: Error): void {
    for (const waiter of attempt.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    attempt.waiters.clear();
  }

  private sendFrame(frame: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WS_OPEN) {
      throw new Error("Gateway WebSocket is not connected");
    }
    this.socket.send(JSON.stringify(frame));
  }

  private handleSocketError(socket: TuiWebSocket, generation: number, error: Error): void {
    if (!this.isCurrent(socket, generation)) return;
    this.patch({ notice: `Gateway connection error: ${error.message}` });
  }

  private handleClose(socket: TuiWebSocket, generation: number): void {
    if (!this.isCurrent(socket, generation)) return;
    this.socket = null;
    this.historyBuffers.delete(generation);
    if (this.closed) return;
    for (const attempt of this.pendingSubmissions.values()) attempt.sentGeneration = null;
    this.acceptedModelUpdateRequests.clear();
    this.patch({
      connection: "reconnecting",
      attached: false,
      queueLoading: true,
      queueRevision: null,
      queueItems: [],
      busy: false,
      ownedByTui: false,
      activeTurnId: null,
      startedAt: null,
      goalState: null,
      notice: "Gateway disconnected; reconnecting",
    });
    this.desyncedQueueRevision = null;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) void this.connect(false);
    }, this.reconnectDelayMs);
  }

  private isCurrent(socket: TuiWebSocket, generation: number): boolean {
    return !this.closed && this.socket === socket && this.generation === generation;
  }

  private isGenerationCurrent(generation: number): boolean {
    return !this.closed && this.generation === generation;
  }
}
