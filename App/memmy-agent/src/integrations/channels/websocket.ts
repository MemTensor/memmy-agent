import crypto from "node:crypto";
import * as childProcess from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { lookup as lookupMime } from "mime-types";
import { requestMcpReload } from "../../core/agent-runtime/tools/mcp.js";
import { BaseChannel, type ChannelHandleMessageOptions } from "./base.js";
import { OUTBOUND_META_AGENT_UI, MessageBus, OutboundMessage } from "../../core/runtime-messages/index.js";
import { builtinCommandPalette } from "../../command/builtin.js";
import { loadConfig } from "../../config/loader.js";
import { getMediaDir, getWorkspacePath } from "../../config/paths.js";
import { goalStateWsBlob } from "../../core/session/goal-state.js";
import { websocketTurnWallStartedAt, websocketTurnWallStartTimes } from "../../core/session/webui-turns.js";
import type { WebuiTitleService } from "../../core/session/webui-title.js";
import { scrubSubagentMessagesForChannel } from "../../utils/subagent-channel-display.js";
import {
  mcpPresetsSettingsAction,
  normalizeMcpPresetMentions,
} from "../../entrypoints/frontend-bridge/mcp-presets-api.js";
import { readWebuiSidebarState, writeWebuiSidebarState } from "../../entrypoints/frontend-bridge/sidebar-state.js";
import {
  createModelConfiguration,
  settingsPayload,
  updateAgentSettings,
  updateImageGenerationSettings,
  updateProviderSettings,
  updateWebSearchSettings,
  WebUISettingsError,
} from "../../entrypoints/frontend-bridge/settings-api.js";
import { deleteWebuiThread } from "../../entrypoints/frontend-bridge/thread-disk.js";
import {
  appendTranscriptObject,
  buildWebuiThreadResponse,
  rewriteLocalMarkdownImages,
} from "../../entrypoints/frontend-bridge/transcript.js";
import type { ChannelAdminApi } from "../../entrypoints/frontend-bridge/channels-api.js";
import { MAX_FILE_SIZE } from "../../utils/media-decode.js";

type Query = Record<string, string[]>;
type HttpRequestLike = { path: string; method?: string; headers?: http.IncomingHttpHeaders | Record<string, any>; body?: Buffer | string };
type HttpLikeResponse = { status: number; headers: Record<string, string>; body: Buffer | string };
type RuntimeModelNameResolver = (() => string | null | undefined) | null;
type WebuiMediaKind = "image" | "video" | "file";
type WebuiArtifactKind = WebuiMediaKind | "directory";
type WebuiMediaAttachment = {
  kind: WebuiMediaKind;
  name: string;
  url?: string;
  path?: string;
};
type AllowedArtifactPath = {
  path: string;
  kind: "file" | "directory";
};
type SignedMediaPath = {
  url: string;
  name: string;
  path: string;
};
type ResolvedArtifactPath = {
  path: string;
  kind: WebuiArtifactKind;
  mediaUrl?: string;
};
type WebuiUploadClassification = {
  kind: "image" | "file";
  mime: string;
  extension: string;
  maxBytes: number;
};
type WebSocketChannelOptions = {
  sessionManager?: any;
  staticDistPath?: string | null;
  workspacePath?: string | null;
  runtimeModelName?: RuntimeModelNameResolver;
  cancelActiveTasks?: (sessionKey: string) => Promise<number>;
};
export type WebuiLanguage = "zh-CN" | "en-US";

const CHAT_ID_RE = /^[A-Za-z0-9_:-]{1,64}$/;
const API_KEY_RE = /^[A-Za-z0-9_:.-]{1,128}$/;
const WEBUI_LANGUAGE_VALUES = new Set<WebuiLanguage>(["zh-CN", "en-US"]);
const LOCALHOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const MCP_VALUES_HEADER = "x-memmy-agent-mcp-values";
const MCP_VALUES_HEADER_MAX_BYTES = 64 * 1024;
const MCP_PRESET_ACTIONS_BY_PATH: Record<string, string> = {
  "/api/settings/mcp-presets/enable": "enable",
  "/api/settings/mcp-presets/remove": "remove",
  "/api/settings/mcp-presets/test": "test",
  "/api/settings/mcp-presets/custom": "custom",
  "/api/settings/mcp-presets/import": "import",
  "/api/settings/mcp-presets/import-cursor": "import-cursor",
  "/api/settings/mcp-presets/tools": "tools",
};

const MAX_ATTACHMENTS_PER_MESSAGE = 4;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_WEBUI_UPLOAD_BODY_BYTES = MAX_ATTACHMENTS_PER_MESSAGE * MAX_FILE_SIZE + 1024 * 1024;
// Control characters and the escaped path separators are intentional filename exclusions.
// eslint-disable-next-line no-control-regex, no-useless-escape
const UNSAFE_FILENAME_CHARS = /[<>:"\/\\|?*\x00-\x1F]/g;
const IMAGE_MIME_ALLOWED = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const DOCUMENT_MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const TEXT_MIME_BY_EXTENSION: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".log": "text/plain",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".toml": "application/toml",
  ".ini": "text/plain",
  ".cfg": "text/plain",
};
const FILE_MIME_ALLOWED = new Set([
  ...Object.values(DOCUMENT_MIME_BY_EXTENSION),
  ...Object.values(TEXT_MIME_BY_EXTENSION),
  "text/xml",
  "text/yaml",
]);
const DISPLAY_MEDIA_RESPONSE_MIMES = new Set([...IMAGE_MIME_ALLOWED, "video/mp4", "video/webm", "video/quicktime"]);
const DATA_URL_MIME_RE = /^data:([^;]+);base64,/i;
const MAX_ISSUED_TOKENS = 10_000;
const MAX_HTTP_JSON_BODY_BYTES = 64 * 1024;
const MAX_ARTIFACT_STAGING_BYTES = 100 * 1024 * 1024;

export function stripTrailingSlash(value: string): string {
  if (!value) return "/";
  return value.length > 1 && value.endsWith("/") ? value.replace(/\/+$/g, "") || "/" : value;
}

export function normalizeConfigPath(value: string): string {
  return stripTrailingSlash(value || "/");
}

export function parseRequestPath(pathWithQuery: string): [string, Query] {
  const parsed = new URL(pathWithQuery || "/", "ws://memmy.local");
  const query: Query = {};
  for (const [key, value] of parsed.searchParams.entries()) {
    (query[key] ??= []).push(value);
  }
  return [normalizeConfigPath(parsed.pathname || "/"), query];
}

export function parseQuery(pathWithQuery: string): Query {
  return parseRequestPath(pathWithQuery)[1];
}

export function normalizeHttpPath(pathWithQuery: string): string {
  return parseRequestPath(pathWithQuery)[0];
}

export function parseMcpSettingsQuery(request: any): Query {
  const query = parseQuery(String(request?.path ?? "/"));
  const headers = request?.headers ?? {};
  const raw = getHeader(headers, MCP_VALUES_HEADER);
  if (!raw) return query;
  if (Buffer.byteLength(raw, "utf8") > MCP_VALUES_HEADER_MAX_BYTES) {
    throw new Error("MCP settings payload is too large");
  }
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("invalid MCP settings payload");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("MCP settings payload must be a JSON object");
  }
  const merged: Query = Object.fromEntries(Object.entries(query).map(([key, values]) => [key, [...values]]));
  for (const [key, value] of Object.entries(payload)) {
    if (!key) throw new Error("MCP settings payload contains an invalid key");
    if (value == null) continue;
    const text = typeof value === "string" ? value.trim() : JSON.stringify(value);
    if (text) merged[key] = [text];
  }
  return merged;
}

export function queryFirst(query: Query, key: string): string | null {
  return query[key]?.[0] ?? null;
}

export function parseInboundPayload(raw: string): string | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  if (!text.startsWith("{")) return text;
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    for (const key of ["content", "text", "message"]) {
      const value = data[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    return null;
  } catch {
    return text;
  }
}

export function isValidChatId(value: any): boolean {
  return typeof value === "string" && CHAT_ID_RE.test(value);
}

export function normalizeWebuiLanguage(value: any): WebuiLanguage | null {
  return typeof value === "string" && WEBUI_LANGUAGE_VALUES.has(value as WebuiLanguage)
    ? value as WebuiLanguage
    : null;
}

export function parseEnvelope(raw: string): Record<string, any> | null {
  const text = String(raw ?? "").trim();
  if (!text.startsWith("{")) return null;
  try {
    const data = JSON.parse(text);
    return data && typeof data === "object" && !Array.isArray(data) && typeof data.type === "string" ? data : null;
  } catch {
    return null;
  }
}

function looksLikeEnvelopeJson(raw: string): boolean {
  const text = String(raw ?? "").trim();
  return text.startsWith("{") && /"type"\s*:/.test(text);
}

export function extractDataUrlMime(dataUrl: string): string | null {
  const match = typeof dataUrl === "string" ? dataUrl.match(DATA_URL_MIME_RE) : null;
  return match?.[1]?.trim().toLowerCase() || null;
}

export function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 12
    && bytes[0] === 0x52
    && bytes[1] === 0x49
    && bytes[2] === 0x46
    && bytes[3] === 0x46
    && bytes[8] === 0x57
    && bytes[9] === 0x45
    && bytes[10] === 0x42
    && bytes[11] === 0x50) {
    return "image/webp";
  }
  if (bytes.length >= 6
    && bytes[0] === 0x47
    && bytes[1] === 0x49
    && bytes[2] === 0x46
    && bytes[3] === 0x38
    && (bytes[4] === 0x37 || bytes[4] === 0x39)
    && bytes[5] === 0x61) {
    return "image/gif";
  }
  return null;
}

function mediaKindForPath(filePath: string): WebuiMediaKind {
  const mime = String(lookupMime(path.basename(filePath)) || "");
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

function artifactKindForFile(filePath: string): Exclude<WebuiArtifactKind, "directory"> {
  return mediaKindForPath(filePath);
}

export function decodeApiKey(rawKey: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawKey);
  } catch {
    return null;
  }
  return API_KEY_RE.test(decoded) ? decoded : null;
}

export function isLocalhost(connection: any): boolean {
  let host = Array.isArray(connection?.remoteAddress) ? connection.remoteAddress[0] : connection?.remoteAddress;
  if (typeof host !== "string") return false;
  if (host.startsWith("::ffff:")) host = host.slice(7);
  return LOCALHOSTS.has(host);
}

export function bearerToken(headers: any): string | null {
  const auth = getHeader(headers, "authorization");
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  return auth.slice(7).trim() || null;
}

export function b64urlEncode(data: Buffer | Uint8Array | string): string {
  const buffer = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
  return buffer.toString("base64url");
}

export function b64urlDecode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export function issueRouteSecretMatches(headers: any, configuredSecret: string): boolean {
  if (!configuredSecret) return true;
  const token = bearerToken(headers) ?? getHeader(headers, "x-memmy-agent-auth");
  return Boolean(token) && safeCompare(token, configuredSecret);
}

export function defaultModelNameFromConfig(): string | null {
  try {
    const model = String(loadConfig().resolvePreset().model ?? "").trim();
    return model || null;
  } catch {
    return null;
  }
}

export function resolveBootstrapModelName(runtimeName: RuntimeModelNameResolver): string | null {
  if (runtimeName) {
    try {
      const raw = runtimeName();
      if (typeof raw === "string" && raw.trim()) return raw.trim();
    } catch {
      // Fall back to the persisted model configuration below.
    }
  }
  return defaultModelNameFromConfig();
}

export function isWebsocketUpgrade(request: any): boolean {
  const upgrade = getHeader(request?.headers, "upgrade");
  const connection = getHeader(request?.headers, "connection");
  return upgrade.toLowerCase().includes("websocket") && connection.toLowerCase().includes("upgrade");
}

export function httpResponse(
  body: Buffer | string,
  { status = 200, contentType = "text/plain; charset=utf-8", extraHeaders = {} }: {
    status?: number;
    contentType?: string;
    extraHeaders?: Record<string, string>;
  } = {},
): HttpLikeResponse {
  const buffer = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  return {
    status,
    headers: {
      date: new Date().toUTCString(),
      connection: "close",
      "content-length": String(buffer.length),
      "content-type": contentType,
      ...extraHeaders,
    },
    body: buffer,
  };
}

export function httpJsonResponse(data: Record<string, any>, { status = 200 }: { status?: number } = {}): HttpLikeResponse {
  return httpResponse(JSON.stringify(data), { status, contentType: "application/json; charset=utf-8" });
}

export function httpError(status: number, message?: string): HttpLikeResponse {
  return httpResponse(message ?? `HTTP ${status}`, { status });
}

export function publishRuntimeModelUpdate(bus: MessageBus, model: string, modelPreset?: string | null): void {
  bus.outbound.put(new OutboundMessage({
    channel: "websocket",
    chatId: "*",
    content: "",
    metadata: {
      runtimeModelUpdated: true,
      model,
      model_preset: modelPreset ?? null,
    },
  }));
}

export class WebSocketConfig {
  enabled = false;
  host = "127.0.0.1";
  port = 18980;
  path = "/";
  token = "";
  tokenIssuePath = "";
  tokenIssueSecret = "";
  tokenTtlS = 300;
  websocketRequiresToken = true;
  allowFrom: string[] = ["*"];
  streaming = true;
  maxMessageBytes = 37_748_736;
  pingIntervalS = 20;
  pingTimeoutS = 20;
  sslCertfile = "";
  sslKeyfile = "";
  serverFactory?: ((channel: WebSocketChannel) => Promise<any> | any) | null;

  constructor(init: Partial<WebSocketConfig> = {}) {
    this.enabled = init.enabled ?? this.enabled;
    this.host = init.host ?? this.host;
    this.port = init.port ?? this.port;
    this.path = normalizeRequiredPath(init.path ?? this.path, "path");
    this.token = init.token ?? this.token;
    this.tokenIssuePath = normalizeOptionalPath(init.tokenIssuePath ?? this.tokenIssuePath, "tokenIssuePath");
    this.tokenIssueSecret = init.tokenIssueSecret ?? this.tokenIssueSecret;
    this.tokenTtlS = boundedNumber(init.tokenTtlS ?? this.tokenTtlS, 30, 86_400, "tokenTtlS");
    this.websocketRequiresToken = init.websocketRequiresToken ?? this.websocketRequiresToken;
    this.allowFrom = Array.isArray(init.allowFrom) ? init.allowFrom.map(String) : this.allowFrom;
    this.streaming = init.streaming ?? this.streaming;
    this.maxMessageBytes = boundedNumber(init.maxMessageBytes ?? this.maxMessageBytes, 1024, 41_943_040, "maxMessageBytes");
    this.pingIntervalS = boundedNumber(init.pingIntervalS ?? this.pingIntervalS, 5, 300, "pingIntervalS");
    this.pingTimeoutS = boundedNumber(init.pingTimeoutS ?? this.pingTimeoutS, 5, 300, "pingTimeoutS");
    this.sslCertfile = init.sslCertfile ?? this.sslCertfile;
    this.sslKeyfile = init.sslKeyfile ?? this.sslKeyfile;
    this.serverFactory = init.serverFactory ?? null;
    if (this.tokenIssuePath && this.tokenIssuePath === this.path) {
      throw new Error("tokenIssuePath must differ from path (the WebSocket upgrade path)");
    }
    if ((this.host === "0.0.0.0" || this.host === "::") && !this.token.trim() && !this.tokenIssueSecret.trim()) {
      throw new Error("host is all interfaces but neither token nor tokenIssueSecret is set");
    }
  }

  static pathMustStartWithSlash(value: string): string {
    return normalizeRequiredPath(value, "path");
  }

  static tokenIssuePathFormat(value: string): string {
    return normalizeOptionalPath(value, "tokenIssuePath");
  }

  tokenIssuePathDiffersFromWsPath(): this {
    if (this.tokenIssuePath && this.tokenIssuePath === this.path) {
      throw new Error("tokenIssuePath must differ from path (the WebSocket upgrade path)");
    }
    return this;
  }

  wildcardHostRequiresAuth(): this {
    if ((this.host === "0.0.0.0" || this.host === "::") && !this.token.trim() && !this.tokenIssueSecret.trim()) {
      throw new Error("host is all interfaces but neither token nor tokenIssueSecret is set");
    }
    return this;
  }

  toObject(): Record<string, any> {
    return {
      enabled: this.enabled,
      host: this.host,
      port: this.port,
      path: this.path,
      token: this.token,
      tokenIssuePath: this.tokenIssuePath,
      tokenIssueSecret: this.tokenIssueSecret,
      tokenTtlS: this.tokenTtlS,
      websocketRequiresToken: this.websocketRequiresToken,
      allowFrom: this.allowFrom,
      streaming: this.streaming,
      maxMessageBytes: this.maxMessageBytes,
      pingIntervalS: this.pingIntervalS,
      pingTimeoutS: this.pingTimeoutS,
      sslCertfile: this.sslCertfile,
      sslKeyfile: this.sslKeyfile,
    };
  }
}

export class WebSocketChannel extends BaseChannel {
  override config: WebSocketConfig;
  displayName = "WebSocket";
  subscriptions = new Map<string, Set<any>>();
  connectionChats = new Map<any, Set<string>>();
  connectionDefaultChats = new Map<any, string>();
  issuedTokens = new Map<string, number>();
  apiTokens = new Map<string, number>();
  streamTextBuffers = new Map<string, string[]>();
  activeTurnIdByChatId = new Map<string, string>();
  mediaSecret = crypto.randomBytes(32);
  settingsRestartSections = new Set<string>();
  sessionManager: any = null;
  staticDistPath: string | null = null;
  runtimeModelName: RuntimeModelNameResolver = null;
  workspacePath: string;
  cancelActiveTasks: ((sessionKey: string) => Promise<number>) | null = null;
  server: any = null;
  channelAdmin: ChannelAdminApi | null = null;
  webuiTitleService: WebuiTitleService | null = null;

  constructor(config: any = {}, bus?: any, options: WebSocketChannelOptions = {}) {
    const normalized = config instanceof WebSocketConfig ? config : new WebSocketConfig(config);
    super("websocket", normalized, bus);
    this.config = normalized;
    this.sessionManager = options.sessionManager ?? config?.sessionManager ?? null;
    const staticDistPath = options.staticDistPath ?? config?.staticDistPath ?? null;
    this.staticDistPath = staticDistPath ? path.resolve(String(staticDistPath)) : null;
    this.runtimeModelName = options.runtimeModelName ?? config?.runtimeModelName ?? null;
    this.cancelActiveTasks = options.cancelActiveTasks ?? config?.cancelActiveTasks ?? null;
    const workspacePath = options.workspacePath ?? config?.workspacePath ?? getWorkspacePath();
    this.workspacePath = path.resolve(String(workspacePath));
  }

  setChannelAdmin(admin: ChannelAdminApi | null): void {
    this.channelAdmin = admin;
  }

  setWebuiTitleService(service: WebuiTitleService | null): void {
    this.webuiTitleService = service;
  }

  static override defaultConfig(): Record<string, any> {
    return { ...new WebSocketConfig().toObject(), enabled: true };
  }

  override get supportsStreaming(): boolean {
    return Boolean(this.config.streaming);
  }

  attachConnection(connection: any, chatId: string): void {
    (this.subscriptions.get(chatId) ?? this.subscriptions.set(chatId, new Set()).get(chatId)!).add(connection);
    (this.connectionChats.get(connection) ?? this.connectionChats.set(connection, new Set()).get(connection)!).add(chatId);
  }

  detachConnection(connection: any, chatId?: string): void {
    if (chatId) {
      this.subscriptions.get(chatId)?.delete(connection);
      if (this.subscriptions.get(chatId)?.size === 0) this.subscriptions.delete(chatId);
      this.connectionChats.get(connection)?.delete(chatId);
      if (this.connectionChats.get(connection)?.size === 0) this.cleanupConnection(connection);
      return;
    }
    this.cleanupConnection(connection);
  }

  cleanupConnection(connection: any): void {
    for (const chatId of this.connectionChats.get(connection) ?? []) {
      const subs = this.subscriptions.get(chatId);
      subs?.delete(connection);
      if (subs?.size === 0) this.subscriptions.delete(chatId);
    }
    this.connectionChats.delete(connection);
    this.connectionDefaultChats.delete(connection);
  }

  async maybePushActiveGoalState(chatId: string): Promise<void> {
    if (!this.sessionManager) return;
    const row = this.readSessionFile(`websocket:${chatId}`);
    const metadata = row && typeof row.metadata === "object" ? row.metadata : {};
    const blob = goalStateWsBlob(metadata);
    if (!blob.active) return;
    await this.sendGoalState(chatId, blob);
  }

  async maybePushTurnRunWallClock(chatId: string): Promise<void> {
    const startedAt = websocketTurnWallStartedAt(chatId);
    if (startedAt == null) return;
    await this.sendGoalStatus(chatId, "running", { startedAt });
  }

  async sendRunStatusSnapshot(connection: any, chatId: string): Promise<void> {
    const startedAt = websocketTurnWallStartedAt(chatId);
    const turnId = this.activeTurnIdByChatId.get(chatId) ?? null;
    const payload = startedAt == null
      ? {
          event: "run_status_snapshot",
          chat_id: chatId,
          status: "idle",
          ...(turnId ? { turn_id: turnId } : {}),
        }
      : {
          event: "run_status_snapshot",
          chat_id: chatId,
          status: "running",
          started_at: startedAt,
          ...(turnId ? { turn_id: turnId } : {}),
        };
    await this.safeSendTo(connection, JSON.stringify(payload));
  }

  async hydrateAfterSubscribe(chatId: string): Promise<void> {
    await this.maybePushActiveGoalState(chatId);
    await this.maybePushTurnRunWallClock(chatId);
  }

  async safeSendTo(connection: any, raw: string): Promise<void> {
    try {
      if (typeof connection?.send === "function") await connection.send(raw);
    } catch {
      // A renderer can close its socket while subscription hydration or a
      // broadcast is still in flight. Treat that as a per-connection event;
      // rejecting here would escape the fire-and-forget connection loop and
      // terminate the packaged Agent gateway process.
      this.cleanupConnection(connection);
    }
  }

  async sendEvent(connection: any, event: string, fields: Record<string, any> = {}): Promise<void> {
    await this.safeSendTo(connection, JSON.stringify({ event, ...fields }));
  }

  expectedPath(): string {
    return normalizeConfigPath(this.config.path);
  }

  buildSslContext(): { cert: Buffer; key: Buffer } | null {
    const cert = this.config.sslCertfile.trim();
    const key = this.config.sslKeyfile.trim();
    if (!cert && !key) return null;
    if (!cert || !key) {
      throw new Error("sslCertfile and sslKeyfile must both be set for WSS, or both left empty");
    }
    return { cert: fs.readFileSync(cert), key: fs.readFileSync(key) };
  }

  purgeExpiredIssuedTokens(): void {
    const now = nowSeconds();
    for (const [token, expiry] of [...this.issuedTokens.entries()]) {
      if (now > expiry) this.issuedTokens.delete(token);
    }
  }

  purgeExpiredApiTokens(): void {
    const now = nowSeconds();
    for (const [token, expiry] of [...this.apiTokens.entries()]) {
      if (now > expiry) this.apiTokens.delete(token);
    }
  }

  takeIssuedTokenIfValid(tokenValue: string | null | undefined): boolean {
    if (!tokenValue) return false;
    this.purgeExpiredIssuedTokens();
    const expiry = this.issuedTokens.get(tokenValue);
    this.issuedTokens.delete(tokenValue);
    return expiry != null && nowSeconds() <= expiry;
  }

  handleTokenIssueHttp(connection: any, request: any): HttpLikeResponse {
    const secret = this.config.tokenIssueSecret.trim();
    if (secret && !issueRouteSecretMatches(request?.headers, secret)) {
      return connectionRespond(connection, 401, "Unauthorized");
    }
    this.purgeExpiredIssuedTokens();
    if (this.issuedTokens.size >= MAX_ISSUED_TOKENS) {
      return httpJsonResponse({ error: "too many outstanding tokens" }, { status: 429 });
    }
    const token = issueTokenValue();
    this.issuedTokens.set(token, nowSeconds() + this.config.tokenTtlS);
    return httpJsonResponse({ token, expires_in: this.config.tokenTtlS });
  }

  checkApiToken(request: any): boolean {
    this.purgeExpiredApiTokens();
    const token = bearerToken(request?.headers) ?? queryFirst(parseQuery(String(request?.path ?? "/")), "token");
    if (!token) return false;
    const expiry = this.apiTokens.get(token);
    if (expiry == null || nowSeconds() > expiry) {
      this.apiTokens.delete(token);
      return false;
    }
    return true;
  }

  handleBootstrap(connection: any, request: any): HttpLikeResponse {
    const secret = this.config.tokenIssueSecret.trim() || this.config.token.trim();
    if (secret) {
      if (!issueRouteSecretMatches(request?.headers, secret)) return httpError(401, "Unauthorized");
    } else if (!isLocalhost(connection)) {
      return httpError(403, "bootstrap is localhost-only");
    }
    this.purgeExpiredIssuedTokens();
    this.purgeExpiredApiTokens();
    if (this.issuedTokens.size >= MAX_ISSUED_TOKENS || this.apiTokens.size >= MAX_ISSUED_TOKENS) {
      return httpResponse(JSON.stringify({ error: "too many outstanding tokens" }), { status: 429, contentType: "application/json; charset=utf-8" });
    }
    const token = issueTokenValue();
    const expiry = nowSeconds() + this.config.tokenTtlS;
    this.issuedTokens.set(token, expiry);
    this.apiTokens.set(token, expiry);
    return httpJsonResponse({
      token,
      ws_path: this.expectedPath(),
      expires_in: this.config.tokenTtlS,
      model_name: resolveBootstrapModelName(this.runtimeModelName),
    });
  }

  handleSessionsList(request: any): HttpLikeResponse {
    if (!this.checkApiToken(request)) return httpError(401, "Unauthorized");
    if (!this.sessionManager) return httpError(503, "session manager unavailable");
    const sessions = this.sessionManager.listSessions();
    const cleaned = Array.isArray(sessions)
      ? sessions.flatMap((session: any) => {
          const key = session?.key;
          if (typeof key !== "string" || !this.isWebsocketChannelSessionKey(key)) return [];
          const row = { ...session };
          delete row.path;
          const chatId = key.split(":", 2)[1] ?? "";
          const startedAt = websocketTurnWallStartedAt(chatId);
          if (startedAt != null) row.run_started_at = startedAt;
          return [row];
        })
      : [];
    return httpJsonResponse({ sessions: cleaned });
  }

  handleSettings(request: any): HttpLikeResponse {
    if (!this.checkApiToken(request)) return httpError(401, "Unauthorized");
    return httpJsonResponse(this.withSettingsRestartState(settingsPayload()));
  }

  withSettingsRestartState(payload: Record<string, any>, { section = null }: { section?: string | null } = {}): Record<string, any> {
    const out = { ...payload };
    if (section && out.requires_restart) this.settingsRestartSections.add(section);
    if (this.settingsRestartSections.size) {
      out.requires_restart = true;
      out.restart_required_sections = [...this.settingsRestartSections].sort();
    } else {
      out.restart_required_sections = [];
    }
    return out;
  }

  handleCommands(request: any): HttpLikeResponse {
    if (!this.checkApiToken(request)) return httpError(401, "Unauthorized");
    let sessionDagEnabled = true;
    try {
      sessionDagEnabled = loadConfig().sessionDag.enabled;
    } catch {
      sessionDagEnabled = true;
    }
    return httpJsonResponse({ commands: builtinCommandPalette({ sessionDagEnabled }) });
  }

  handleWebuiSidebarState(request: any): HttpLikeResponse {
    if (!this.checkApiToken(request)) return httpError(401, "Unauthorized");
    return httpJsonResponse(readWebuiSidebarState());
  }

  handleWebuiSidebarStateUpdate(request: any): HttpLikeResponse {
    if (!this.checkApiToken(request)) return httpError(401, "Unauthorized");
    const raw = queryFirst(parseQuery(String(request?.path ?? "/")), "state");
    if (raw == null) return httpError(400, "missing state");
    let decoded: any;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return httpError(400, "state must be JSON");
    }
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return httpError(400, "state must be an object");
    try {
      return httpJsonResponse(writeWebuiSidebarState(decoded));
    } catch (error) {
      if (error instanceof Error && error.message) return httpError(400, error.message);
      return httpError(500, "failed to write sidebar state");
    }
  }

  settingsErrorResponse(error: any): HttpLikeResponse {
    if (error instanceof WebUISettingsError || typeof error?.status === "number") {
      return httpError(error.status ?? 400, error.message ?? String(error));
    }
    return httpError(500, error instanceof Error ? error.message : String(error));
  }

  handleSettingsUpdate(request: any): HttpLikeResponse {
    if (!this.checkApiToken(request)) return httpError(401, "Unauthorized");
    try {
      return httpJsonResponse(this.withSettingsRestartState(updateAgentSettings(parseQuery(String(request?.path ?? "/"))), { section: "runtime" }));
    } catch (error) {
      return this.settingsErrorResponse(error);
    }
  }

  handleSettingsModelConfigurationCreate(request: any): HttpLikeResponse {
    if (!this.checkApiToken(request)) return httpError(401, "Unauthorized");
    try {
      return httpJsonResponse(this.withSettingsRestartState(createModelConfiguration(parseQuery(String(request?.path ?? "/")))));
    } catch (error) {
      return this.settingsErrorResponse(error);
    }
  }

  handleSettingsProviderUpdate(request: any): HttpLikeResponse {
    if (!this.checkApiToken(request)) return httpError(401, "Unauthorized");
    try {
      return httpJsonResponse(this.withSettingsRestartState(updateProviderSettings(parseQuery(String(request?.path ?? "/"))), { section: "image" }));
    } catch (error) {
      return this.settingsErrorResponse(error);
    }
  }

  handleSettingsWebSearchUpdate(request: any): HttpLikeResponse {
    if (!this.checkApiToken(request)) return httpError(401, "Unauthorized");
    try {
      return httpJsonResponse(this.withSettingsRestartState(updateWebSearchSettings(parseQuery(String(request?.path ?? "/"))), { section: "web" }));
    } catch (error) {
      return this.settingsErrorResponse(error);
    }
  }

  handleSettingsImageGenerationUpdate(request: any): HttpLikeResponse {
    if (!this.checkApiToken(request)) return httpError(401, "Unauthorized");
    try {
      return httpJsonResponse(this.withSettingsRestartState(updateImageGenerationSettings(parseQuery(String(request?.path ?? "/"))), { section: "image" }));
    } catch (error) {
      return this.settingsErrorResponse(error);
    }
  }

  async handleSettingsMcpPresets(request: any, action: string | null = null): Promise<HttpLikeResponse> {
    if (!this.checkApiToken(request)) return httpError(401, "Unauthorized");
    try {
      const payload = await mcpPresetsSettingsAction(action, parseMcpSettingsQuery(request), {
        reloadMcp: () => requestMcpReload(this.bus),
      });
      return httpJsonResponse(action == null ? payload : this.withSettingsRestartState(payload, { section: "runtime" }));
    } catch (error: any) {
      const message = error?.message ?? String(error);
      const status = error?.status ?? (message.includes("MCP settings payload") ? 400 : 500);
      return httpError(status, message);
    }
  }

  async handleChannelAdmin(request: any, action: string, value: string | null = null): Promise<HttpLikeResponse> {
    if (!this.checkApiToken(request)) return httpError(401, "Unauthorized");
    if (!this.channelAdmin) return httpError(503, "channel admin unavailable");
    try {
      switch (action) {
        case "definitions":
          return httpJsonResponse(this.channelAdmin.definitions());
        case "status":
          return httpJsonResponse(this.channelAdmin.status());
        case "configure":
          return httpJsonResponse(await this.channelAdmin.configure(String(value ?? "")));
        case "stop":
          return httpJsonResponse(await this.channelAdmin.stop(String(value ?? "")));
        case "weixin-login-start":
          return httpJsonResponse(await this.channelAdmin.startWeixinLogin());
        case "weixin-login-poll":
          return httpJsonResponse(await this.channelAdmin.pollWeixinLogin(String(value ?? "")));
        default:
          return httpError(404, "Not Found");
      }
    } catch (error: any) {
      return httpError(error?.status ?? 500, error?.message ?? String(error));
    }
  }

  isWebsocketChannelSessionKey(key: string): boolean {
    return key.startsWith("websocket:");
  }

  readSessionFile(key: string): Record<string, any> | null {
    const read = this.sessionManager?.readSessionFile;
    if (typeof read === "function") return read.call(this.sessionManager, key);
    const pathFor = this.sessionManager?.pathFor;
    if (typeof pathFor !== "function") return null;
    const file = pathFor.call(this.sessionManager, key);
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }

  handleSessionMessages(request: any, key: string): HttpLikeResponse {
    if (!this.checkApiToken(request)) return httpError(401, "Unauthorized");
    if (!this.sessionManager) return httpError(503, "session manager unavailable");
    const decodedKey = decodeApiKey(key);
    if (decodedKey == null) return httpError(400, "invalid session key");
    if (!this.isWebsocketChannelSessionKey(decodedKey)) return httpError(404, "session not found");
    const data = this.readSessionFile(decodedKey);
    if (!data) return httpError(404, "session not found");
    if (Array.isArray(data.messages)) scrubSubagentMessagesForChannel(data.messages);
    this.augmentMediaUrls(data);
    return httpJsonResponse(data);
  }

  handleWebuiThreadGet(request: any, key: string): HttpLikeResponse {
    if (!this.checkApiToken(request)) return httpError(401, "Unauthorized");
    const decodedKey = decodeApiKey(key);
    if (decodedKey == null) return httpError(400, "invalid session key");
    if (!this.isWebsocketChannelSessionKey(decodedKey)) return httpError(404, "session not found");
    const sessionMessages = this.readSessionFile(decodedKey)?.messages;
    const data = buildWebuiThreadResponse(decodedKey, {
      sessionMessages: Array.isArray(sessionMessages) ? sessionMessages : null,
      augmentUserMedia: (paths: string[]) => this.augmentTranscriptUserMedia(paths),
      augmentAssistantMedia: (paths: string[]) => paths.flatMap((p) => this.webuiMediaAttachmentForPath(p) ?? []),
      augmentAssistantText: (text: string) => this.rewriteLocalMarkdownImages(text),
    });
    if (!data) return httpError(404, "webui thread not found");
    return httpJsonResponse(data);
  }

  lastCompactionPayload(decodedKey: string, summary: unknown): Record<string, any> {
    const unavailable = {
      available: false,
      sessionKey: decodedKey,
      mode: null,
      text: "",
      lastActive: null,
    };
    if (typeof summary === "string") {
      if (!summary.trim()) return unavailable;
      return {
        available: true,
        sessionKey: decodedKey,
        mode: "text",
        text: summary,
        lastActive: null,
      };
    }
    if (!summary || typeof summary !== "object" || Array.isArray(summary)) return unavailable;
    const raw = summary as Record<string, unknown>;
    const text = typeof raw.text === "string" ? raw.text : "";
    if (!text.trim()) return unavailable;
    const mode = raw.mode === "dag" ? "dag" : "text";
    const payload: Record<string, any> = {
      available: true,
      sessionKey: decodedKey,
      mode,
      text,
      lastActive: typeof raw.lastActive === "string" ? raw.lastActive : null,
    };
    if (mode === "dag" && typeof raw.dagSnapshotId === "string") {
      payload.dagSnapshotId = raw.dagSnapshotId;
    }
    return payload;
  }

  handleLastCompactionGet(request: any, key: string): HttpLikeResponse {
    if (!this.checkApiToken(request)) return httpError(401, "Unauthorized");
    const decodedKey = decodeApiKey(key);
    if (decodedKey == null) return httpError(400, "invalid session key");
    if (!this.isWebsocketChannelSessionKey(decodedKey)) return httpError(404, "session not found");
    const data = this.readSessionFile(decodedKey);
    if (!data) return httpError(404, "session not found");
    return httpJsonResponse(this.lastCompactionPayload(decodedKey, data.metadata?.lastSummary));
  }

  handleArtifactResolve(request: HttpRequestLike): HttpLikeResponse {
    if (!this.checkApiToken(request)) return httpError(401, "Unauthorized");
    if ((request.method ?? "GET").toUpperCase() !== "POST") return httpError(405, "method not allowed");
    const requestedPath = artifactPathFromRequest(request);
    if (!requestedPath) return httpError(400, "missing path");
    const resolved = this.resolveOrStageArtifactPath(requestedPath);
    if (!resolved) return httpError(404, "artifact not found");
    return httpJsonResponse({
      ok: true,
      path: resolved.path,
      name: path.basename(expandHomePath(requestedPath)) || path.basename(resolved.path),
      kind: resolved.kind,
      ...(resolved.mediaUrl ? { media_url: resolved.mediaUrl } : {}),
    });
  }

  handleArtifactReveal(request: HttpRequestLike): HttpLikeResponse {
    if (!this.checkApiToken(request)) return httpError(401, "Unauthorized");
    if ((request.method ?? "GET").toUpperCase() !== "POST") return httpError(405, "method not allowed");
    const requestedPath = artifactPathFromRequest(request);
    if (!requestedPath) return httpError(400, "missing path");
    const resolved = this.resolveOrStageArtifactPath(requestedPath);
    if (!resolved) return httpError(404, "artifact not found");
    try {
      revealFileInSystemManager(resolved.path);
    } catch (error) {
      return httpError(500, error instanceof Error ? error.message : "failed to reveal artifact");
    }
    return httpJsonResponse({ ok: true, path: resolved.path });
  }

  handleArtifactOpen(request: HttpRequestLike): HttpLikeResponse {
    if (!this.checkApiToken(request)) return httpError(401, "Unauthorized");
    if ((request.method ?? "GET").toUpperCase() !== "POST") return httpError(405, "method not allowed");
    const requestedPath = artifactPathFromRequest(request);
    if (!requestedPath) return httpError(400, "missing path");
    const resolved = this.resolveOrStageArtifactPath(requestedPath);
    if (!resolved) return httpError(404, "artifact not found");
    const result = openPathWithSystemDefault(resolved.path);
    if (!result.ok) return httpError(500, result.message);
    return httpJsonResponse({ ok: true, path: resolved.path });
  }

  async handleWebuiMediaUpload(request: HttpRequestLike): Promise<HttpLikeResponse> {
    if (!this.checkApiToken(request)) return httpError(401, "Unauthorized");
    if ((request.method ?? "GET").toUpperCase() !== "POST") return httpError(405, "method not allowed");
    const contentType = getHeader(request.headers, "content-type").toLowerCase();
    if (!contentType.includes("multipart/form-data")) return httpError(415, "multipart/form-data required");

    let form: FormData;
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers ?? {})) {
        if (Array.isArray(value)) headers.set(key, value.join(", "));
        else if (value != null) headers.set(key, String(value));
      }
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.from(String(request.body ?? ""), "utf8");
      form = await new Request("http://memmy.local/api/webui/media/upload", {
        method: "POST",
        headers,
        body,
      }).formData();
    } catch {
      return httpError(400, "invalid multipart body");
    }

    const files = form.getAll("files");
    if (!files.length) return httpError(400, "missing files");
    if (files.length > MAX_ATTACHMENTS_PER_MESSAGE) return httpError(400, "too many attachments");

    const mediaDir = path.join(getMediaDir("websocket"), "webui");
    fs.mkdirSync(mediaDir, { recursive: true });
    const saved: Array<Record<string, any>> = [];
    const savedPaths: string[] = [];
    const failUpload = (response: HttpLikeResponse): HttpLikeResponse => {
      for (const itemPath of savedPaths) fs.rmSync(itemPath, { force: true });
      return response;
    };

    try {
      for (const entry of files) {
        if (typeof entry === "string" || typeof (entry as any).arrayBuffer !== "function") {
          return failUpload(httpError(400, "invalid file"));
        }
        const file = entry as any;
        const declaredMime = String(file.type ?? "").toLowerCase();
        const bytes = Buffer.from(await file.arrayBuffer());
        const originalName = typeof file.name === "string" && file.name.trim() ? file.name : "attachment";
        const classification = classifyWebuiUploadAttachment(originalName, declaredMime, bytes);
        if (!classification) return failUpload(httpError(415, "unsupported attachment mime"));
        if (bytes.length > classification.maxBytes) return failUpload(httpError(413, classification.kind === "image" ? "image too large" : "file too large"));
        const safeOriginalName = safeFilename(originalName).replace(/\.[^.]*$/, "") + classification.extension;
        const filename = `${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}-${safeOriginalName}`;
        const target = path.join(mediaDir, filename);
        fs.writeFileSync(target, bytes);
        const real = fs.realpathSync(target);
        savedPaths.push(real);
        const url = this.signMediaPath(real);
        if (!url) return failUpload(httpError(500, "failed to sign attachment"));
        saved.push({
          path: real,
          url,
          name: safeOriginalName,
          kind: classification.kind,
          mime: classification.mime,
          bytes: bytes.length,
        });
      }
    } catch (error) {
      for (const itemPath of savedPaths) fs.rmSync(itemPath, { force: true });
      return httpError(500, error instanceof Error ? error.message : "failed to save attachment");
    }

    return httpJsonResponse({
      attachments: saved,
      images: saved.filter((item) => item.kind === "image"),
    });
  }

  handleSessionDelete(request: any, key: string): HttpLikeResponse {
    if (!this.checkApiToken(request)) return httpError(401, "Unauthorized");
    if (!this.sessionManager) return httpError(503, "session manager unavailable");
    const decodedKey = decodeApiKey(key);
    if (decodedKey == null) return httpError(400, "invalid session key");
    if (!this.isWebsocketChannelSessionKey(decodedKey)) return httpError(404, "session not found");
    const del = this.sessionManager.deleteSession ?? this.sessionManager.delete;
    const deleted = typeof del === "function" ? del.call(this.sessionManager, decodedKey) : false;
    deleteWebuiThread(decodedKey);
    return httpJsonResponse({ deleted: Boolean(deleted) });
  }

  handleSessionTitleUpdate(request: any, key: string): HttpLikeResponse {
    if (!this.checkApiToken(request)) return httpError(401, "Unauthorized");
    if ((request.method ?? "GET").toUpperCase() !== "POST") return httpError(405, "method not allowed");
    if (!this.sessionManager) return httpError(503, "session manager unavailable");
    const decodedKey = decodeApiKey(key);
    if (decodedKey == null) return httpError(400, "invalid session key");
    if (!this.isWebsocketChannelSessionKey(decodedKey)) return httpError(404, "session not found");
    let decoded: any;
    try {
      decoded = JSON.parse(requestBodyText(request));
    } catch {
      return httpError(400, "body must be JSON");
    }
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return httpError(400, "body must be an object");
    const title = typeof decoded.title === "string" ? decoded.title : null;
    if (title == null) return httpError(400, "missing title");
    const rename = this.sessionManager.renameSession;
    const session = typeof rename === "function" ? rename.call(this.sessionManager, decodedKey, title) : null;
    if (!session) return httpError(404, "session not found");
    return httpJsonResponse({ session });
  }

  augmentMediaUrls(payload: Record<string, any>): void {
    const messages = payload.messages;
    if (!Array.isArray(messages)) return;
    for (const msg of messages) {
      if (!msg || typeof msg !== "object") continue;
      const media = msg.media;
      if (!Array.isArray(media) || !media.length) continue;
      const attachments = media
        .filter((entry: any): entry is string => typeof entry === "string" && Boolean(entry))
        .map((entry) => this.webuiMediaAttachmentForPath(entry))
        .filter((entry): entry is WebuiMediaAttachment => Boolean(entry));
      if (attachments.length) msg.media_urls = attachments;
      delete msg.media;
    }
  }

  resolveAllowedArtifactPath(rawPath: string): AllowedArtifactPath | null {
    const expanded = expandHomePath(rawPath);
    const isAbsoluteRequest = path.isAbsolute(expanded) || rawPath.startsWith("~/");
    const candidate = path.isAbsolute(expanded)
      ? path.resolve(expanded)
      : path.resolve(this.workspacePath, rawPath);
    let resolved: string;
    let stat: fs.Stats;
    try {
      resolved = fs.realpathSync(candidate);
      stat = fs.statSync(resolved);
    } catch {
      return null;
    }
    const workspaceRoot = realpathIfExists(this.workspacePath);
    if (stat.isDirectory()) {
      if (isAbsoluteRequest || isPathInside(resolved, workspaceRoot)) {
        return { path: resolved, kind: "directory" };
      }
      return null;
    }
    if (!stat.isFile()) return null;

    const allowedRoots = [workspaceRoot, realpathIfExists(getMediaDir())];
    return allowedRoots.some((root) => isPathInside(resolved, root))
      ? { path: resolved, kind: "file" }
      : null;
  }

  resolveOrStageArtifactPath(rawPath: string): ResolvedArtifactPath | null {
    const allowed = this.resolveAllowedArtifactPath(rawPath);
    if (allowed) {
      if (allowed.kind === "directory") {
        return { path: allowed.path, kind: "directory" };
      }
      const signed = this.signOrStageMediaPath(allowed.path);
      return {
        path: allowed.path,
        kind: artifactKindForFile(allowed.path),
        ...(signed?.url ? { mediaUrl: signed.url } : {})
      };
    }

    const expanded = expandHomePath(rawPath);
    if (!path.isAbsolute(expanded) && !rawPath.startsWith("~/")) {
      return null;
    }
    const staged = this.stageArtifactPath(expanded);
    return staged ? { path: staged.path, kind: artifactKindForFile(staged.path), mediaUrl: staged.url } : null;
  }

  stageArtifactPath(rawPath: string): SignedMediaPath | null {
    let resolved: string;
    let stat: fs.Stats;
    try {
      resolved = fs.realpathSync(path.resolve(expandHomePath(rawPath)));
      stat = fs.statSync(resolved);
    } catch {
      return null;
    }
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_STAGING_BYTES) {
      return null;
    }

    try {
      const mediaDir = getMediaDir("websocket");
      fs.mkdirSync(mediaDir, { recursive: true });
      const staged = path.join(mediaDir, `${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}-${safeFilename(path.basename(resolved)) || "artifact"}`);
      fs.copyFileSync(resolved, staged);
      const stagedReal = fs.realpathSync(staged);
      const url = this.signMediaPath(stagedReal);
      return url ? { url, name: path.basename(resolved), path: stagedReal } : null;
    } catch {
      return null;
    }
  }

  augmentTranscriptUserMedia(paths: string[]): Array<Record<string, any>> {
    const out: Array<Record<string, any>> = [];
    for (const p of paths) {
      const att = this.webuiMediaAttachmentForPath(p);
      if (!att) continue;
      out.push(att);
    }
    return out;
  }

  tryAppendWebuiTranscript(chatId: string, wire: Record<string, any>): void {
    try {
      appendTranscriptObject(`websocket:${chatId}`, structuredClone(wire));
    } catch {
      // Transcript persistence is best-effort for live WebSocket delivery.
    }
  }

  turnIdFromMetadata(metadata?: Record<string, any> | null): string | null {
    return firstNonemptyString(metadata?.turn_id, metadata?.turnId);
  }

  payloadIsTerminal(payload: Record<string, any>): boolean {
    return (
      payload.event === "turn_end" ||
      payload.event === "stop_result" ||
      (payload.event === "goal_status" && payload.status === "idle") ||
      (payload.event === "file_edit" && payload.cancellation_terminal === true)
    );
  }

  shouldSendTurnPayload(chatId: string, payload: Record<string, any>): boolean {
    const turnId = firstNonemptyString(payload.turn_id, payload.turnId);
    if (!turnId || this.payloadIsTerminal(payload)) return true;
    return this.activeTurnIdByChatId.get(chatId) === turnId;
  }

  async sendTurnPayload(
    chatId: string,
    payload: Record<string, any>,
    {
      appendTranscript = true,
      targets = null,
    }: {
      appendTranscript?: boolean;
      targets?: any[] | null;
    } = {},
  ): Promise<void> {
    if (!this.shouldSendTurnPayload(chatId, payload)) return;
    if (appendTranscript) this.tryAppendWebuiTranscript(chatId, payload);
    const raw = JSON.stringify(payload);
    for (const connection of targets ?? [...(this.subscriptions.get(chatId) ?? [])]) await this.safeSendTo(connection, raw);
  }

  rewriteLocalMarkdownImages(text: string): string {
    return rewriteLocalMarkdownImages(text, {
      workspacePath: this.workspacePath,
      signPath: (filePath: string) => this.signOrStageMediaPath(filePath),
    });
  }

  serveStatic(requestPath: string): HttpLikeResponse | null {
    if (!this.staticDistPath) return null;
    let rel = requestPath.replace(/^\/+/, "") || "index.html";
    if (rel.split("/").includes("..") || path.isAbsolute(rel)) return httpError(403, "Forbidden");
    let candidate = path.resolve(this.staticDistPath, rel);
    const rootRel = path.relative(this.staticDistPath, candidate);
    if (rootRel.startsWith("..") || path.isAbsolute(rootRel)) return httpError(403, "Forbidden");
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
      const index = path.join(this.staticDistPath, "index.html");
      if (!fs.existsSync(index) || !fs.statSync(index).isFile()) return null;
      candidate = index;
      rel = "index.html";
    }
    const mime = String(lookupMime(candidate) || "application/octet-stream");
    const contentType = mime.startsWith("text/") || ["application/javascript", "application/json"].includes(mime) ? `${mime}; charset=utf-8` : mime;
    return httpResponse(fs.readFileSync(candidate), {
      contentType,
      extraHeaders: { "cache-control": path.basename(rel) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable" },
    });
  }

  authorizeWebsocketHandshake(connection: any, query: Query): HttpLikeResponse | null {
    const supplied = queryFirst(query, "token");
    const staticToken = this.config.token.trim();
    if (staticToken) {
      if (supplied && safeCompare(supplied, staticToken)) return null;
      if (supplied && this.takeIssuedTokenIfValid(supplied)) return null;
      return connectionRespond(connection, 401, "Unauthorized");
    }
    if (this.config.websocketRequiresToken) {
      if (supplied && this.takeIssuedTokenIfValid(supplied)) return null;
      return connectionRespond(connection, 401, "Unauthorized");
    }
    if (supplied) this.takeIssuedTokenIfValid(supplied);
    return null;
  }

  async dispatchHttp(connection: any, request: any): Promise<HttpLikeResponse | null> {
    const [got, query] = parseRequestPath(String(request?.path ?? "/"));
    if (this.config.tokenIssuePath && got === normalizeConfigPath(this.config.tokenIssuePath)) {
      return this.handleTokenIssueHttp(connection, request);
    }
    if (got === "/webui/bootstrap") return this.handleBootstrap(connection, request);
    if (got === "/api/channels/definitions") return this.handleChannelAdmin(request, "definitions");
    if (got === "/api/channels/status") return this.handleChannelAdmin(request, "status");
    let channelAdminMatch = got.match(/^\/api\/channels\/([^/]+)\/configure$/);
    if (channelAdminMatch) return this.handleChannelAdmin(request, "configure", decodeURIComponent(channelAdminMatch[1]));
    channelAdminMatch = got.match(/^\/api\/channels\/([^/]+)\/stop$/);
    if (channelAdminMatch) return this.handleChannelAdmin(request, "stop", decodeURIComponent(channelAdminMatch[1]));
    if (got === "/api/channels/weixin/login/start") return this.handleChannelAdmin(request, "weixin-login-start");
    channelAdminMatch = got.match(/^\/api\/channels\/weixin\/login\/([^/]+)$/);
    if (channelAdminMatch) return this.handleChannelAdmin(request, "weixin-login-poll", decodeURIComponent(channelAdminMatch[1]));
    if (got === "/api/sessions") return this.handleSessionsList(request);
    if (got === "/api/settings") return this.handleSettings(request);
    if (got === "/api/commands") return this.handleCommands(request);
    if (got === "/api/webui/sidebar-state") return this.handleWebuiSidebarState(request);
    if (got === "/api/webui/sidebar-state/update") return this.handleWebuiSidebarStateUpdate(request);
    if (got === "/api/webui/artifacts/resolve") return this.handleArtifactResolve(request);
    if (got === "/api/webui/artifacts/reveal") return this.handleArtifactReveal(request);
    if (got === "/api/webui/artifacts/open") return this.handleArtifactOpen(request);
    if (got === "/api/webui/media/upload") return this.handleWebuiMediaUpload(request);
    if (got === "/api/settings/update") return this.handleSettingsUpdate(request);
    if (got === "/api/settings/model-configurations/create") return this.handleSettingsModelConfigurationCreate(request);
    if (got === "/api/settings/provider/update") return this.handleSettingsProviderUpdate(request);
    if (got === "/api/settings/web-search/update") return this.handleSettingsWebSearchUpdate(request);
    if (got === "/api/settings/image-generation/update") return this.handleSettingsImageGenerationUpdate(request);
    if (got === "/api/settings/mcp-presets") return this.handleSettingsMcpPresets(request);
    if (MCP_PRESET_ACTIONS_BY_PATH[got]) return this.handleSettingsMcpPresets(request, MCP_PRESET_ACTIONS_BY_PATH[got]);
    let match = got.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (match) return this.handleSessionMessages(request, match[1]);
    match = got.match(/^\/api\/sessions\/([^/]+)\/webui-thread$/);
    if (match) return this.handleWebuiThreadGet(request, match[1]);
    match = got.match(/^\/api\/sessions\/([^/]+)\/last-compaction$/);
    if (match) return this.handleLastCompactionGet(request, match[1]);
    match = got.match(/^\/api\/sessions\/([^/]+)\/delete$/);
    if (match) return this.handleSessionDelete(request, match[1]);
    match = got.match(/^\/api\/sessions\/([^/]+)\/title$/);
    if (match) return this.handleSessionTitleUpdate(request, match[1]);
    match = got.match(/^\/api\/media\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/);
    if (match) return this.handleMediaFetch(match[1], match[2]);
    if (got === this.expectedPath() && isWebsocketUpgrade(request)) {
      const clientId = (queryFirst(query, "client_id") ?? "").slice(0, 128);
      if (!this.isAllowed(clientId)) return connectionRespond(connection, 403, "Forbidden");
      return this.authorizeWebsocketHandshake(connection, query);
    }
    const staticResponse = this.serveStatic(got);
    if (staticResponse) return staticResponse;
    return connectionRespond(connection, 404, "Not Found");
  }

  override async start(): Promise<void> {
    this.running = true;
    const factory = this.config.serverFactory;
    if (factory) {
      this.server = await factory(this);
      return;
    }
    if (this.server) return;
    const tls = this.buildSslContext();
    const handler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
      let request = requestFromIncoming(req);
      try {
        if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
          const bodyLimit = normalizeHttpPath(request.path) === "/api/webui/media/upload"
            ? MAX_WEBUI_UPLOAD_BODY_BYTES
            : MAX_HTTP_JSON_BODY_BYTES;
          request = { ...request, body: await readIncomingBody(req, bodyLimit) };
        }
        const response = request.method === "OPTIONS"
          ? corsPreflightResponse(this.config, request)
          : await this.dispatchHttp(httpConnectionFromRequest(req), request);
        writeNodeResponse(res, withCorsHeaders(response ?? httpError(404, "Not Found"), this.config, request));
      } catch (error) {
        const status = error instanceof HttpBodyTooLargeError ? 413 : 400;
        writeNodeResponse(res, withCorsHeaders(httpError(status, error instanceof Error ? error.message : "invalid request"), this.config, request));
      }
    };
    const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
    server.on("upgrade", async (req, socket, head) => {
      const request = requestFromIncoming(req);
      const connection = new MinimalWebSocketConnection(socket, request, this.config.maxMessageBytes);
      try {
        const gate = await this.dispatchHttp(connection, request);
        if (gate) {
          rejectUpgrade(socket, gate);
          return;
        }
        connection.accept(head);
        void this.connectionLoop(connection);
      } catch (error) {
        rejectUpgrade(socket, httpError(500, error instanceof Error ? error.message : "Internal Server Error"));
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(this.config.port, this.config.host, () => resolve());
    });
    this.server = server;
  }

  override async stop(): Promise<void> {
    if (!this.running && !this.server) return;
    this.running = false;
    if (typeof this.server?.close === "function") {
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }
    this.server = null;
    this.subscriptions.clear();
    this.connectionChats.clear();
    this.connectionDefaultChats.clear();
    this.issuedTokens.clear();
    this.apiTokens.clear();
    this.streamTextBuffers.clear();
    this.activeTurnIdByChatId.clear();
  }

  async connectionLoop(connection: any): Promise<void> {
    const [, query] = parseRequestPath(String(connection?.request?.path ?? "/"));
    const rawClientId = queryFirst(query, "client_id");
    let clientId = rawClientId?.trim() || "";
    if (!clientId) clientId = `anon-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    if (clientId.length > 128) clientId = clientId.slice(0, 128);
    const defaultChatId = crypto.randomUUID();

    try {
      await connection.send(JSON.stringify({ event: "ready", chat_id: defaultChatId, client_id: clientId }));
      this.connectionDefaultChats.set(connection, defaultChatId);
      this.attachConnection(connection, defaultChatId);
      await this.hydrateAfterSubscribe(defaultChatId);

      for await (let raw of connection) {
        if (Buffer.isBuffer(raw)) {
          try {
            raw = raw.toString("utf8");
          } catch {
            continue;
          }
        }
        const envelope = parseEnvelope(String(raw));
        if (envelope) {
          await this.dispatchEnvelope(connection, clientId, envelope);
          continue;
        }
        if (looksLikeEnvelopeJson(String(raw))) {
          await this.sendEvent(connection, "error", { detail: "malformed envelope" });
          continue;
        }
        const content = parseInboundPayload(String(raw));
        if (content == null) continue;
        await this.handleMessage({
          senderId: clientId,
          chatId: defaultChatId,
          content,
          metadata: { remote: connection?.remoteAddress ?? null },
          isDm: false,
        });
      }
    } finally {
      this.cleanupConnection(connection);
    }
  }

  override async handleMessage(
    senderIdOrOptions: string | ChannelHandleMessageOptions,
    chatId?: string,
    content?: string,
    media?: string[],
    metadata?: Record<string, any>,
    sessionKey?: string | null,
    isDm = false,
  ): Promise<void> {
    const opts =
      typeof senderIdOrOptions === "object"
        ? senderIdOrOptions
        : {
            senderId: senderIdOrOptions,
            chatId,
            content: content ?? "",
            media,
            metadata,
            sessionKey,
            isDm,
          };
    const messageMetadata = opts.metadata ?? {};
    if (messageMetadata.webui) {
      const chatId = String(opts.chatId ?? "");
      const userObj: Record<string, any> = {
        event: "user",
        chat_id: chatId,
        text: opts.content,
      };
      const media = opts.media ?? [];
      if (media.length) userObj.media_paths = [...media];
      if (Array.isArray(messageMetadata.mcp_presets) && messageMetadata.mcp_presets.length) userObj.mcp_presets = messageMetadata.mcp_presets;
      this.tryAppendWebuiTranscript(chatId, userObj);
    }
    await super.handleMessage(opts);
  }

  resolveEnvelopeMediaPaths(value: any): [string[], string | null] {
    if (value == null) return [[], null];
    if (!Array.isArray(value)) return [[], "malformed"];
    if (value.length > MAX_ATTACHMENTS_PER_MESSAGE) return [[], "too_many_attachments"];
    const mediaRoot = realpathIfExists(getMediaDir("websocket"));
    const out: string[] = [];
    for (const item of value) {
      if (typeof item !== "string" || !item.trim()) return [[], "malformed"];
      let resolved: string;
      let stat: fs.Stats;
      try {
        resolved = fs.realpathSync(path.resolve(expandHomePath(item)));
        stat = fs.statSync(resolved);
      } catch {
        return [[], "missing"];
      }
      if (!stat.isFile() || !isPathInside(resolved, mediaRoot)) return [[], "path"];
      const bytes = fs.readFileSync(resolved);
      const classification = classifySavedWebuiAttachment(resolved, bytes);
      if (!classification) return [[], "mime"];
      if (stat.size > classification.maxBytes) return [[], "size"];
      out.push(resolved);
    }
    return [out, null];
  }

  deprecatedEnvelopeMediaReason(value: any): string {
    if (!Array.isArray(value)) return "malformed";
    for (const item of value) {
      if (!item || typeof item !== "object" || typeof item.data_url !== "string") return "malformed";
      const mime = extractDataUrlMime(item.data_url);
      if (!mime) return "decode";
      if (IMAGE_MIME_ALLOWED.has(mime)) return "deprecated_payload";
      return "mime";
    }
    return "deprecated_payload";
  }

  async dispatchEnvelope(connection: any, clientId: string, envelope: Record<string, any>): Promise<void> {
    const type = envelope.type;
    if (type === "new_chat") {
      const chatId = crypto.randomUUID();
      this.attachConnection(connection, chatId);
      await this.sendEvent(connection, "attached", { chat_id: chatId });
      await this.hydrateAfterSubscribe(chatId);
      return;
    }
    if (type === "attach") {
      const chatId = envelope.chat_id;
      if (!isValidChatId(chatId)) return this.sendEvent(connection, "error", { detail: "invalid chat_id" });
      this.attachConnection(connection, chatId);
      await this.sendEvent(connection, "attached", { chat_id: chatId });
      await this.sendRunStatusSnapshot(connection, chatId);
      await this.hydrateAfterSubscribe(chatId);
      return;
    }
    if (type === "status") {
      const chatId = envelope.chat_id;
      if (!isValidChatId(chatId)) return this.sendEvent(connection, "error", { detail: "invalid chat_id" });
      this.attachConnection(connection, chatId);
      await this.hydrateAfterSubscribe(chatId);
      await this.handleMessage({
        senderId: clientId,
        chatId,
        content: "/status",
        metadata: {
          remote: connection?.remoteAddress ?? null,
          webui_ephemeral_command: "status",
        },
        isDm: false,
      });
      return;
    }
    if (type === "history_dag") {
      const chatId = envelope.chat_id;
      if (!isValidChatId(chatId)) return this.sendEvent(connection, "error", { detail: "invalid chat_id" });
      this.attachConnection(connection, chatId);
      await this.hydrateAfterSubscribe(chatId);
      await this.handleMessage({
        senderId: clientId,
        chatId,
        content: "/history-dag",
        metadata: {
          remote: connection?.remoteAddress ?? null,
          webui_ephemeral_command: "historyDag",
        },
        isDm: false,
      });
      return;
    }
    if (type === "stop") {
      const chatId = envelope.chat_id;
      if (!isValidChatId(chatId)) return this.sendEvent(connection, "error", { detail: "invalid chat_id" });
      this.attachConnection(connection, chatId);
      const turnId = this.activeTurnIdByChatId.get(chatId) ?? null;
      let stopped = 0;
      try {
        stopped = await (this.cancelActiveTasks?.(`websocket:${chatId}`) ?? Promise.resolve(0));
      } catch {
        await this.sendEvent(connection, "error", { chat_id: chatId, detail: "stop_failed" });
        return;
      }
      this.activeTurnIdByChatId.delete(chatId);
      await this.sendTurnPayload(chatId, {
        event: "stop_result",
        chat_id: chatId,
        stopped,
        ...(turnId ? { turn_id: turnId } : {}),
      });
      return;
    }
    if (type === "message") {
      const chatId = envelope.chat_id;
      const content = envelope.content;
      if (!isValidChatId(chatId)) return this.sendEvent(connection, "error", { detail: "invalid chat_id" });
      if (typeof content !== "string") return this.sendEvent(connection, "error", { chat_id: chatId, detail: "missing content" });
      let mediaPaths: string[] = [];
      if (envelope.media != null) {
        await this.sendEvent(connection, "error", { chat_id: chatId, detail: "attachment_rejected", reason: this.deprecatedEnvelopeMediaReason(envelope.media) });
        return;
      }
      if (envelope.media_paths != null) {
        const [resolved, reason] = this.resolveEnvelopeMediaPaths(envelope.media_paths);
        if (reason) {
          await this.sendEvent(connection, "error", { chat_id: chatId, detail: "attachment_rejected", reason });
          return;
        }
        mediaPaths = resolved;
      }
      if (!content.trim() && !mediaPaths.length) return this.sendEvent(connection, "error", { chat_id: chatId, detail: "missing content" });
      this.attachConnection(connection, chatId);
      await this.hydrateAfterSubscribe(chatId);
      const metadata: Record<string, any> = { remote: connection?.remoteAddress ?? null };
      if (envelope.webui === true) metadata.webui = true;
      const language = normalizeWebuiLanguage(envelope.language);
      if (language) metadata.webui_language = language;
      const mcpPresets: any[] = normalizeMcpPresetMentions(envelope.mcp_presets);
      if (!mcpPresets.length) mcpPresets.push(...normalizeMentionList(envelope.mcp_presets));
      if (mcpPresets.length) metadata.mcp_presets = mcpPresets;
      if (envelope.image_generation && typeof envelope.image_generation === "object" && envelope.image_generation.enabled === true) {
        metadata.image_generation = {
          enabled: true,
          aspect_ratio: typeof envelope.image_generation.aspect_ratio === "string" ? envelope.image_generation.aspect_ratio : null,
        };
      }
      this.webuiTitleService?.trackUserMessage({ chatId, content, metadata, mediaPaths });
      await this.handleMessage({
        senderId: clientId,
        chatId,
        content,
        media: mediaPaths.length ? mediaPaths : undefined,
        metadata,
        isDm: false,
      });
      return;
    }
    await this.sendEvent(connection, "error", { detail: `unknown type: ${JSON.stringify(type)}` });
  }

  signMediaPath(absPath: string): string | null {
    let rel: string;
    try {
      const mediaDir = getMediaDir();
      const mediaRoot = realpathIfExists(mediaDir);
      const candidate = path.resolve(expandHomePath(absPath));
      let resolved = realpathIfExists(candidate);
      if (!isPathInside(resolved, mediaRoot) && isPathInside(candidate, mediaDir)) {
        resolved = path.join(mediaRoot, path.relative(path.resolve(mediaDir), candidate));
      }
      rel = path.relative(mediaRoot, resolved);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    } catch {
      return null;
    }
    const payload = b64urlEncode(rel.split(path.sep).join("/"));
    const mac = crypto.createHmac("sha256", this.mediaSecret).update(payload).digest().subarray(0, 16);
    return `/api/media/${b64urlEncode(mac)}/${payload}`;
  }

  signOrStageMediaPath(filePath: string): SignedMediaPath | null {
    const expanded = expandHomePath(filePath);
    const candidate = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(this.workspacePath, expanded);
    const direct = this.signMediaPath(candidate);
    if (direct) {
      return { url: direct, name: path.basename(candidate), path: realpathIfExists(candidate) };
    }

    let resolved: string;
    try {
      resolved = fs.realpathSync(candidate);
      if (!fs.statSync(resolved).isFile()) return null;
    } catch {
      return null;
    }

    return this.stageArtifactPath(resolved);
  }

  webuiMediaAttachmentForPath(filePath: string): WebuiMediaAttachment | null {
    const name = path.basename(filePath) || "attachment";
    const kind = mediaKindForPath(filePath);
    const resolved = this.resolveAllowedArtifactPath(filePath);
    if (resolved?.kind === "directory") return null;
    const signed = this.signOrStageMediaPath(filePath);
    const resolvedFilePath = resolved?.path ?? null;
    if (!signed && !resolvedFilePath) return null;
    return {
      kind,
      name: signed?.name ?? name,
      ...(signed?.url ? { url: signed.url } : {}),
      ...(resolvedFilePath ?? signed?.path ? { path: resolvedFilePath ?? signed?.path } : {}),
    };
  }

  handleMediaFetch(sig: string, payload: string): HttpLikeResponse {
    const expected = crypto.createHmac("sha256", this.mediaSecret).update(payload).digest().subarray(0, 16);
    let provided: Buffer;
    try {
      provided = b64urlDecode(sig);
    } catch {
      return httpError(401, "invalid signature");
    }
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
      return httpError(401, "invalid signature");
    }
    let rel: string;
    try {
      rel = b64urlDecode(payload).toString("utf8");
    } catch {
      return httpError(400, "invalid payload");
    }
    const mediaRoot = path.resolve(getMediaDir());
    const candidate = path.resolve(mediaRoot, rel);
    if (path.relative(mediaRoot, candidate).startsWith("..")) return httpError(404, "not found");
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return httpError(404, "not found");
    const mime = String(lookupMime(candidate) || "application/octet-stream");
    return {
      status: 200,
      headers: {
        "content-type": DISPLAY_MEDIA_RESPONSE_MIMES.has(mime) ? mime : "application/octet-stream",
        "cache-control": "private, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      },
      body: fs.readFileSync(candidate),
    };
  }

  override async send(message: OutboundMessage): Promise<void> {
    if (message.metadata?.runtimeModelUpdated) {
      await this.sendRuntimeModelUpdated({
        modelName: message.metadata.model,
        modelPreset: message.metadata.model_preset,
      });
      return;
    }
    if (message.metadata?.goalStateSync) {
      await this.sendGoalState(message.chatId, typeof message.metadata.goalState === "object" ? message.metadata.goalState : { active: false });
      return;
    }
    if (message.metadata?.goalStatusEvent) {
      await this.sendGoalStatus(message.chatId, String(message.metadata.goalStatus), {
        startedAt: numberOrNull(message.metadata.startedAt ?? message.metadata.goalStartedAt),
        turnId: this.turnIdFromMetadata(message.metadata),
      });
      return;
    }
    if (message.metadata?.turnEnd) {
      await this.sendTurnEnd(message.chatId, {
        latencyMs: numberOrNull(message.metadata.latencyMs),
        goalState: typeof message.metadata.goalState === "object" ? message.metadata.goalState : null,
        turnId: this.turnIdFromMetadata(message.metadata),
      });
      return;
    }
    if (message.metadata?.sessionUpdated) {
      const scope = typeof message.metadata.sessionUpdateScope === "string" ? message.metadata.sessionUpdateScope : null;
      await this.sendSessionUpdated(message.chatId, scope);
      if (scope === "thread") this.webuiTitleService?.onUserMessagePersisted(message.chatId);
      return;
    }
    if (message.metadata?.fileEditEvents) {
      const turnId = this.turnIdFromMetadata(message.metadata);
      const edits = Array.isArray(message.metadata.fileEditEvents) ? message.metadata.fileEditEvents : [];
      const cancellationTerminal = edits.length > 0 && edits.every((event: any) => event?.cancellation_terminal === true);
      const payload = {
        event: "file_edit",
        chat_id: message.chatId,
        edits,
        ...(turnId ? { turn_id: turnId } : {}),
        ...(cancellationTerminal ? { cancellation_terminal: true } : {}),
      };
      await this.sendTurnPayload(message.chatId, payload);
      return;
    }
    if (message.metadata?.contextCompaction) {
      const wireText = this.rewriteLocalMarkdownImages(message.content);
      const turnId = this.turnIdFromMetadata(message.metadata);
      const payload = {
        event: "context_compaction",
        chat_id: message.chatId,
        compaction_id: String(message.metadata.compactionId ?? ""),
        status: normalizeContextCompactionStatus(message.metadata.compactionStatus),
        text: wireText,
        content: wireText,
        ...(turnId ? { turn_id: turnId } : {}),
      };
      await this.sendTurnPayload(message.chatId, payload);
      return;
    }
    if (message.metadata?.retryWait) {
      const wireText = this.rewriteLocalMarkdownImages(message.content);
      const turnId = this.turnIdFromMetadata(message.metadata);
      const payload = {
        event: "retry_wait",
        chat_id: message.chatId,
        text: wireText,
        ...(turnId ? { turn_id: turnId } : {}),
      };
      await this.sendTurnPayload(message.chatId, payload, { appendTranscript: false });
      return;
    }
    if (message.metadata?.webui_ephemeral_command === "status") {
      const wireText = this.rewriteLocalMarkdownImages(message.content);
      await this.broadcast(message.chatId, {
        event: "status_result",
        chat_id: message.chatId,
        text: wireText,
        content: wireText,
        metadata: message.metadata ?? {},
      });
      return;
    }
    if (message.metadata?.webui_ephemeral_command === "historyDag") {
      const wireText = this.rewriteLocalMarkdownImages(message.content);
      await this.broadcast(message.chatId, {
        event: "history_dag_result",
        chat_id: message.chatId,
        text: wireText,
        content: wireText,
        metadata: message.metadata ?? {},
        ...(message.metadata?.[OUTBOUND_META_AGENT_UI] != null
          ? { agent_ui: message.metadata[OUTBOUND_META_AGENT_UI] }
          : {}),
      });
      return;
    }

    const targets = message.chatId === "*" ? [...this.connectionChats.keys()] : [...(this.subscriptions.get(message.chatId) ?? [])];
    const wireText = this.rewriteLocalMarkdownImages(message.content);
    const turnId = this.turnIdFromMetadata(message.metadata);
    const payload: Record<string, any> = {
      event: "message",
      chat_id: message.chatId,
      text: wireText,
      content: wireText,
      metadata: message.metadata ?? {},
      media: message.media ?? [],
      ...(turnId ? { turn_id: turnId } : {}),
    };
    const mediaUrls = (message.media ?? []).map((entry) => this.webuiMediaAttachmentForPath(entry)).filter((entry): entry is WebuiMediaAttachment => Boolean(entry));
    if (mediaUrls.length) payload.media_urls = mediaUrls;
    if (message.metadata?.toolHint) payload.kind = "tool_hint";
    else if (message.metadata?.agentProgress) payload.kind = "progress";
    if (typeof message.replyTo === "string") payload.reply_to = message.replyTo;
    if (typeof (message as any).reply_to === "string") payload.reply_to = (message as any).reply_to;
    if (typeof message.metadata?.latencyMs === "number") payload.latency_ms = Math.trunc(message.metadata.latencyMs);
    if (message.metadata?.toolEvents) payload.tool_events = message.metadata.toolEvents;
    if (message.metadata?.[OUTBOUND_META_AGENT_UI] != null) payload.agent_ui = message.metadata[OUTBOUND_META_AGENT_UI];
    if (!this.shouldSendTurnPayload(message.chatId, payload)) return;
    this.tryAppendWebuiTranscript(message.chatId, { ...payload, text: message.content, content: message.content });
    const raw = JSON.stringify(payload);
    for (const connection of targets) await this.safeSendTo(connection, raw);
  }

  async sendDelta(chatId: string, delta: string, metadata: Record<string, any> = {}): Promise<void> {
    const targets = [...(this.subscriptions.get(chatId) ?? [])];
    const streamId = metadata.streamId == null ? "" : String(metadata.streamId);
    const key = `${chatId}\0${streamId}`;
    const turnId = this.turnIdFromMetadata(metadata);
    let payload: Record<string, any>;
    if (metadata.streamEnd) {
      const buffered = this.streamTextBuffers.get(key) ?? [];
      this.streamTextBuffers.delete(key);
      if (delta) buffered.push(delta);
      payload = { event: "stream_end", chat_id: chatId };
      if (metadata.resuming === true) payload.resuming = true;
      if (buffered.length) payload.text = this.rewriteLocalMarkdownImages(buffered.join(""));
    } else {
      if (turnId && this.activeTurnIdByChatId.get(chatId) !== turnId) return;
      (this.streamTextBuffers.get(key) ?? this.streamTextBuffers.set(key, []).get(key)!).push(delta);
      payload = { event: "delta", chat_id: chatId, text: delta };
    }
    if (metadata.streamId != null) payload.stream_id = metadata.streamId;
    if (turnId) payload.turn_id = turnId;
    await this.sendTurnPayload(chatId, payload, { targets });
  }

  override async sendReasoningDelta(chatId: string, delta: string, metadata: Record<string, any> = {}): Promise<void> {
    if (!delta) return;
    const turnId = this.turnIdFromMetadata(metadata);
    const payload = { event: "reasoning_delta", chat_id: chatId, text: delta, ...(metadata.streamId != null ? { stream_id: metadata.streamId } : {}), ...(turnId ? { turn_id: turnId } : {}) };
    await this.sendTurnPayload(chatId, payload);
  }

  override async sendReasoningEnd(chatId: string, metadata: Record<string, any> = {}): Promise<void> {
    const turnId = this.turnIdFromMetadata(metadata);
    const payload = { event: "reasoning_end", chat_id: chatId, ...(metadata.streamId != null ? { stream_id: metadata.streamId } : {}), ...(turnId ? { turn_id: turnId } : {}) };
    await this.sendTurnPayload(chatId, payload);
  }

  async sendTurnEnd(chatId: string, { latencyMs = null, goalState = null, turnId = null }: { latencyMs?: number | null; goalState?: Record<string, any> | null; turnId?: string | null } = {}): Promise<void> {
    const payload = {
      event: "turn_end",
      chat_id: chatId,
      ...(latencyMs != null ? { latency_ms: latencyMs } : {}),
      ...(goalState ? { goal_state: goalState } : {}),
      ...(turnId ? { turn_id: turnId } : {}),
    };
    await this.sendTurnPayload(chatId, payload);
    if (turnId && this.activeTurnIdByChatId.get(chatId) === turnId) this.activeTurnIdByChatId.delete(chatId);
  }

  async sendGoalState(chatId: string, blob: Record<string, any>): Promise<void> {
    await this.broadcast(chatId, { event: "goal_state", chat_id: chatId, goal_state: blob });
  }

  async sendGoalStatus(chatId: string, status: string, { startedAt = null, turnId = null }: { startedAt?: number | null; turnId?: string | null } = {}): Promise<void> {
    if (status === "running" && startedAt != null) {
      websocketTurnWallStartTimes.set(chatId, startedAt);
      if (turnId) this.activeTurnIdByChatId.set(chatId, turnId);
    } else if (status === "idle") {
      websocketTurnWallStartTimes.delete(chatId);
      if (turnId && this.activeTurnIdByChatId.get(chatId) === turnId) this.activeTurnIdByChatId.delete(chatId);
    }
    await this.sendTurnPayload(chatId, {
      event: "goal_status",
      chat_id: chatId,
      status,
      ...(status === "running" && startedAt != null ? { started_at: startedAt } : {}),
      ...(turnId ? { turn_id: turnId } : {}),
    }, { appendTranscript: false });
  }

  async sendSessionUpdated(chatId: string, scope: string | null = null): Promise<void> {
    await this.broadcast(chatId, { event: "session_updated", chat_id: chatId, ...(scope ? { scope } : {}) });
  }

  async sendRuntimeModelUpdated({ modelName, modelPreset }: { modelName?: any; modelPreset?: any }): Promise<void> {
    const model = String(modelName ?? "").trim();
    if (!model) return;
    const body: Record<string, any> = { event: "runtime_model_updated", model_name: model };
    if (typeof modelPreset === "string" && modelPreset.trim()) body.model_preset = modelPreset.trim();
    const raw = JSON.stringify(body);
    for (const connection of this.connectionChats.keys()) await this.safeSendTo(connection, raw);
  }

  private async broadcast(chatId: string, payload: Record<string, any>): Promise<void> {
    const raw = JSON.stringify(payload);
    for (const connection of this.subscriptions.get(chatId) ?? []) await this.safeSendTo(connection, raw);
  }
}

function getHeader(headers: any, name: string): string {
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) ?? headers.get(name.toLowerCase()) ?? "";
  const direct = headers[name] ?? headers[name.toLowerCase()];
  const value = direct ?? Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? "";
  return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
}

function nowSeconds(): number {
  return Date.now() / 1000;
}

function issueTokenValue(): string {
  return `nbwt_${crypto.randomBytes(32).toString("base64url")}`;
}

function safeCompare(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requestBodyText(request: HttpRequestLike): string {
  if (Buffer.isBuffer(request.body)) return request.body.toString("utf8");
  return typeof request.body === "string" ? request.body : "";
}

function artifactPathFromRequest(request: HttpRequestLike): string | null {
  const body = requestBodyText(request).trim();
  if (!body) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rawPath = (parsed as Record<string, unknown>).path;
  return typeof rawPath === "string" && rawPath.trim() ? rawPath.trim() : null;
}

function expandHomePath(value: string): string {
  return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function realpathIfExists(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function openPathWithSystemDefault(filePath: string): { ok: true } | { ok: false; message: string } {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd.exe"
      : "xdg-open";
  const args = process.platform === "darwin"
    ? [filePath]
    : process.platform === "win32"
      ? ["/c", "start", "", filePath]
      : [filePath];
  const result = childProcess.spawnSync(command, args, {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  if (result.error) return { ok: false, message: result.error.message };
  if (typeof result.status === "number" && result.status !== 0) {
    return { ok: false, message: result.stderr || `open command exited with ${result.status}` };
  }
  return { ok: true };
}

function revealFileInSystemManager(filePath: string): void {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "explorer.exe"
      : "xdg-open";
  const args = process.platform === "darwin"
    ? ["-R", filePath]
    : process.platform === "win32"
      ? ["/select,", filePath]
      : [path.dirname(filePath)];
  const child = childProcess.spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function connectionRespond(connection: any, status: number, body: string): HttpLikeResponse {
  if (connection && typeof connection.respond === "function") return connection.respond(status, body);
  return httpError(status, body);
}

class HttpBodyTooLargeError extends Error {}

function requestFromIncoming(req: http.IncomingMessage): HttpRequestLike & { method: string; headers: http.IncomingHttpHeaders } {
  return { path: req.url || "/", method: req.method ?? "GET", headers: req.headers };
}

async function readIncomingBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new HttpBodyTooLargeError("request body too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function httpConnectionFromRequest(req: http.IncomingMessage): any {
  const host = req.socket.remoteAddress ?? "";
  return {
    remoteAddress: [host],
    respond: (status: number, body: string) => httpError(status, body),
  };
}

function writeNodeResponse(res: http.ServerResponse, response: HttpLikeResponse): void {
  const body = typeof response.body === "string" ? Buffer.from(response.body, "utf8") : response.body;
  const headers = { ...response.headers, "content-length": String(body.length) };
  res.writeHead(response.status, headers);
  res.end(body);
}

function corsPreflightResponse(config: WebSocketConfig, request: { headers?: http.IncomingHttpHeaders }): HttpLikeResponse {
  return httpResponse("", {
    status: 204,
    contentType: "text/plain; charset=utf-8",
    extraHeaders: corsHeadersForRequest(config, request),
  });
}

function withCorsHeaders(
  response: HttpLikeResponse,
  config: WebSocketConfig,
  request: { headers?: http.IncomingHttpHeaders },
): HttpLikeResponse {
  const corsHeaders = corsHeadersForRequest(config, request);
  if (!Object.keys(corsHeaders).length) return response;
  return {
    ...response,
    headers: {
      ...response.headers,
      ...corsHeaders,
      vary: appendVary(response.headers.vary, "Origin"),
    },
  };
}

function corsHeadersForRequest(config: WebSocketConfig, request: { headers?: http.IncomingHttpHeaders }): Record<string, string> {
  const origin = getHeader(request.headers, "origin").trim();
  if (!isAllowedCorsOrigin(origin, config)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": [
      "authorization",
      "content-type",
      "x-memmy-agent-auth",
      MCP_VALUES_HEADER,
    ].join(", "),
    "access-control-max-age": "600",
  };
}

function isAllowedCorsOrigin(origin: string, config: WebSocketConfig): boolean {
  if (!origin) return false;
  if (origin === "null") return Boolean(config.tokenIssueSecret.trim() || config.token.trim());
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    return LOCALHOSTS.has(hostname);
  } catch {
    return false;
  }
}

function appendVary(existing: string | undefined, value: string): string {
  if (!existing) return value;
  const parts = existing.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
  return parts.includes(value.toLowerCase()) ? existing : `${existing}, ${value}`;
}

function rejectUpgrade(socket: any, response: HttpLikeResponse): void {
  const body = typeof response.body === "string" ? Buffer.from(response.body, "utf8") : response.body;
  const reason = response.status === 401 ? "Unauthorized" : response.status === 403 ? "Forbidden" : response.status === 404 ? "Not Found" : "Error";
  socket.write(`HTTP/1.1 ${response.status} ${reason}\r\nConnection: close\r\nContent-Length: ${body.length}\r\nContent-Type: ${response.headers["content-type"] ?? "text/plain"}\r\n\r\n`);
  socket.write(body);
  socket.destroy();
}

function normalizeRequiredPath(value: string, field: string): string {
  if (!value.startsWith("/")) throw new Error(`${field} must start with "/"`);
  return normalizeConfigPath(value);
}

function normalizeOptionalPath(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return normalizeRequiredPath(trimmed, field);
}

function boundedNumber(value: any, min: number, max: number, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be between ${min} and ${max}`);
  }
  return parsed;
}

function safeFilename(name: string): string {
  const base = path.basename(name || "attachment").replace(UNSAFE_FILENAME_CHARS, "_").trim();
  return base && base !== "." && base !== ".." ? base : "attachment";
}

function extensionForImageMime(mime: string): string {
  switch (mime) {
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "image/png":
    default:
      return ".png";
  }
}

function classifyWebuiUploadAttachment(name: string, declaredMime: string, bytes: Buffer): WebuiUploadClassification | null {
  const sniffedImage = sniffImageMime(bytes.subarray(0, 16));
  if (sniffedImage) {
    if (declaredMime && declaredMime !== sniffedImage) return null;
    return {
      kind: "image",
      mime: sniffedImage,
      extension: extensionForImageMime(sniffedImage),
      maxBytes: MAX_IMAGE_BYTES,
    };
  }

  const fileClassification = classifyFileAttachmentByName(name);
  if (!fileClassification) return null;
  const isDocument = Boolean(DOCUMENT_MIME_BY_EXTENSION[fileClassification.extension]);
  if (declaredMime && isDocument && declaredMime !== fileClassification.mime) return null;
  if (declaredMime && !isDocument && !FILE_MIME_ALLOWED.has(declaredMime) && !declaredMime.startsWith("text/")) return null;
  if (!fileBytesMatchClassification(fileClassification, bytes)) return null;
  return fileClassification;
}

function classifySavedWebuiAttachment(filePath: string, bytes: Buffer): WebuiUploadClassification | null {
  const sniffedImage = sniffImageMime(bytes.subarray(0, 16));
  if (sniffedImage) {
    return {
      kind: "image",
      mime: sniffedImage,
      extension: extensionForImageMime(sniffedImage),
      maxBytes: MAX_IMAGE_BYTES,
    };
  }

  const classification = classifyFileAttachmentByName(filePath);
  if (!classification) return null;
  return fileBytesMatchClassification(classification, bytes) ? classification : null;
}

function classifyFileAttachmentByName(name: string): WebuiUploadClassification | null {
  const extension = path.extname(name).toLowerCase();
  const mime = DOCUMENT_MIME_BY_EXTENSION[extension] ?? TEXT_MIME_BY_EXTENSION[extension];
  if (!mime) return null;
  return {
    kind: "file",
    mime,
    extension,
    maxBytes: MAX_FILE_SIZE,
  };
}

function fileBytesMatchClassification(classification: WebuiUploadClassification, bytes: Buffer): boolean {
  if (classification.kind !== "file") return true;
  if (classification.extension === ".pdf") return looksLikePdf(bytes);
  if (DOCUMENT_MIME_BY_EXTENSION[classification.extension]) return looksLikeZip(bytes);
  return looksLikeText(bytes);
}

function looksLikePdf(bytes: Buffer): boolean {
  return bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-";
}

function looksLikeZip(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (
    (bytes[2] === 0x03 && bytes[3] === 0x04)
    || (bytes[2] === 0x05 && bytes[3] === 0x06)
    || (bytes[2] === 0x07 && bytes[3] === 0x08)
  );
}

function looksLikeText(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 64 * 1024));
  return !sample.includes(0);
}

function normalizeMentionList(value: any): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function numberOrNull(value: any): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function firstNonemptyString(...values: any[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizeContextCompactionStatus(value: any): "running" | "done" | "error" {
  return value === "running" || value === "done" || value === "error" ? value : "done";
}

class MinimalWebSocketConnection implements AsyncIterable<string | Buffer> {
  request: { path: string; headers: http.IncomingHttpHeaders };
  remoteAddress: [string];
  private buffer = Buffer.alloc(0);
  private queue: Array<string | Buffer> = [];
  private waiters: Array<(value: IteratorResult<string | Buffer>) => void> = [];
  private closed = false;

  constructor(
    private socket: any,
    request: { path: string; headers: http.IncomingHttpHeaders },
    private maxMessageBytes: number,
  ) {
    this.request = request;
    this.remoteAddress = [socket.remoteAddress ?? ""];
  }

  respond(status: number, body: string): HttpLikeResponse {
    return httpError(status, body);
  }

  accept(head: Buffer): void {
    const key = getHeader(this.request.headers, "sec-websocket-key");
    const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    this.socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ].join("\r\n"));
    this.socket.on("data", (chunk: any) => this.onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    this.socket.on("close", () => this.closeQueue());
    this.socket.on("end", () => this.closeQueue());
    this.socket.on("error", () => this.closeQueue());
    if (head.length) this.onData(head);
  }

  async send(raw: string): Promise<void> {
    if (this.closed) throw new Error("connection closed");
    this.socket.write(encodeServerFrame(Buffer.from(raw, "utf8"), 0x1));
  }

  [Symbol.asyncIterator](): AsyncIterator<string | Buffer> {
    return {
      next: () => this.next(),
    };
  }

  private next(): Promise<IteratorResult<string | Buffer>> {
    const value = this.queue.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private push(value: string | Buffer): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.queue.push(value);
  }

  private closeQueue(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        const long = this.buffer.readBigUInt64BE(offset);
        if (long > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.closeWithCode(1009, "message too big");
          return;
        }
        length = Number(long);
        offset += 8;
      }
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) return;
      if (length > this.maxMessageBytes) {
        this.closeWithCode(1009, "message too big");
        return;
      }
      let payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (masked) {
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask![index % 4]));
      }
      if (opcode === 0x8) {
        this.socket.write(encodeServerFrame(Buffer.alloc(0), 0x8));
        this.socket.end();
        this.closeQueue();
        return;
      }
      if (opcode === 0x9) {
        this.socket.write(encodeServerFrame(payload, 0xA));
        continue;
      }
      if (opcode === 0x1) this.push(payload.toString("utf8"));
      else if (opcode === 0x2) this.push(payload);
    }
  }

  private closeWithCode(code: number, reason: string): void {
    if (this.closed) return;
    const reasonBuffer = Buffer.from(reason, "utf8");
    const payload = Buffer.alloc(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);
    this.socket.write(encodeServerFrame(payload, 0x8));
    this.socket.end();
    this.closeQueue();
  }

}

function encodeServerFrame(payload: Buffer, opcode: number): Buffer {
  const length = payload.length;
  if (length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload]);
  if (length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
}
