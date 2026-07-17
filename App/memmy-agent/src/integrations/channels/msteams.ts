import fs from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { createPublicKey, verify as verifySignature } from "node:crypto";
import { OutboundMessage } from "../../core/runtime-messages/index.js";
import { getWorkspacePath } from "../../config/paths.js";
import { BaseChannel } from "./base.js";

export let MSTEAMS_AVAILABLE = true;
export const MSTEAMS_REF_TTL_DAYS = 30;
export const MSTEAMS_WEBCHAT_HOST = "webchat.botframework.com";
export const MSTEAMS_REF_META_FILENAME = "msteams_conversations_meta.json";
export const MSTEAMS_REF_LOCK_FILENAME = "msteams_conversations.lock";
export const MSTEAMS_REF_TOUCH_INTERVAL_S = 300;

export function setMsteamsAvailableForTest(value: boolean): void {
  MSTEAMS_AVAILABLE = value;
}

function asArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function safeFloat(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function htmlUnescape(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;?/gi, "’")
    .replace(/&hellip;?/gi, "…");
}

function readJson(filePath: string): Record<string, any> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export class MSTeamsConfig {
  enabled = false;
  appId = "";
  appPassword = "";
  tenantId = "";
  host = "0.0.0.0";
  port = 3978;
  path = "/api/messages";
  allowFrom: string[] = [];
  replyInThread = true;
  mentionOnlyResponse = "Hi — what can I help with?";
  validateInboundAuth = true;
  refTtlDays = MSTEAMS_REF_TTL_DAYS;
  pruneWebChatRefs = true;
  pruneNonPersonalRefs = true;
  refTouchIntervalS = MSTEAMS_REF_TOUCH_INTERVAL_S;

  constructor(init: Partial<MSTeamsConfig> = {}) {
    this.enabled = init.enabled ?? this.enabled;
    this.appId = init.appId ?? this.appId;
    this.appPassword = init.appPassword ?? this.appPassword;
    this.tenantId = init.tenantId ?? this.tenantId;
    this.host = init.host ?? this.host;
    this.port = init.port ?? this.port;
    this.path = init.path ?? this.path;
    this.allowFrom = asArray(init.allowFrom ?? this.allowFrom);
    this.replyInThread = init.replyInThread ?? this.replyInThread;
    this.mentionOnlyResponse = init.mentionOnlyResponse ?? this.mentionOnlyResponse;
    this.validateInboundAuth = init.validateInboundAuth ?? this.validateInboundAuth;
    this.refTtlDays = Math.max(1, Number(init.refTtlDays ?? this.refTtlDays));
    this.pruneWebChatRefs = init.pruneWebChatRefs ?? this.pruneWebChatRefs;
    this.pruneNonPersonalRefs = init.pruneNonPersonalRefs ?? this.pruneNonPersonalRefs;
    this.refTouchIntervalS = Math.max(0, Number(init.refTouchIntervalS ?? this.refTouchIntervalS));
  }
}

export class ConversationRef {
  serviceUrl: string;
  conversationId: string;
  botId: string | null;
  activityId: string | null;
  conversationType: string | null;
  tenantId: string | null;
  updatedAt: number | null;

  constructor(init: {
    serviceUrl?: string;
    service_url?: string;
    conversationId?: string;
    conversation_id?: string;
    botId?: string | null;
    bot_id?: string | null;
    activityId?: string | null;
    activity_id?: string | null;
    conversationType?: string | null;
    conversation_type?: string | null;
    tenantId?: string | null;
    tenant_id?: string | null;
    updatedAt?: number | null;
    updated_at?: number | null;
  }) {
    this.serviceUrl = init.serviceUrl ?? init.service_url ?? "";
    this.conversationId = init.conversationId ?? init.conversation_id ?? "";
    this.botId = init.botId ?? init.bot_id ?? null;
    this.activityId = init.activityId ?? init.activity_id ?? null;
    this.conversationType = init.conversationType ?? init.conversation_type ?? null;
    this.tenantId = init.tenantId ?? init.tenant_id ?? null;
    this.updatedAt = init.updatedAt ?? init.updated_at ?? null;
  }
}

export class MSTeamsChannel extends BaseChannel {
  override name = "msteams";
  override displayName = "Microsoft Teams";
  override config: MSTeamsConfig;
  http: any = null;
  token: string | null = null;
  tokenExpiresAt = 0;
  conversationRefs: Record<string, ConversationRef> = {};
  refsPath: string;
  refsMetaPath: string;
  refsLockPath: string;
  botFrameworkOpenIdConfigUrl = "https://login.botframework.com/v1/.well-known/openidconfiguration";
  botFrameworkOpenIdConfig: Record<string, any> | null = null;
  botFrameworkOpenIdConfigExpiresAt = 0;
  botFrameworkJwks: Record<string, any> | null = null;
  botFrameworkJwksExpiresAt = 0;
  logger = console;
  server: Server | null = null;
  botAdapter: any = null;

  static override defaultConfig(): Record<string, any> {
    return new MSTeamsConfig() as any;
  }

  constructor(config: Partial<MSTeamsConfig> & Record<string, any> = {}, bus?: any) {
    const normalized = config instanceof MSTeamsConfig ? config : new MSTeamsConfig(config);
    super("msteams", normalized, bus);
    this.config = normalized;
    const stateDir = path.join(getWorkspacePath(), "state");
    fs.mkdirSync(stateDir, { recursive: true });
    this.refsPath = path.join(stateDir, "msteams_conversations.json");
    this.refsMetaPath = path.join(stateDir, MSTEAMS_REF_META_FILENAME);
    this.refsLockPath = path.join(stateDir, MSTEAMS_REF_LOCK_FILENAME);
    this.conversationRefs = this.loadRefs();
    if (this.pruneConversationRefs()) this.saveRefs(false);
  }

  activeConversationRefs(): Record<string, ConversationRef> {
    return this.conversationRefs;
  }

  override async start(): Promise<void> {
    if (!MSTEAMS_AVAILABLE) {
      this.logger.error("MSTeams support is unavailable in this build. Reinstall memmy-agent with MSTeams support enabled.");
      return;
    }
    if (!this.config.appId || !this.config.appPassword) return;
    this.http = this.http ?? createMSTeamsFetchHttpClient();
    await this.startHttpServer();
    this.running = true;
  }

  override async stop(): Promise<void> {
    this.running = false;
    if (this.server) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
      this.server = null;
    }
    await this.http?.close?.();
    this.http = null;
  }

  async startHttpServer(): Promise<void> {
    if (this.server) return;
    const { BotFrameworkAdapter } = await import("botbuilder");
    this.botAdapter = new BotFrameworkAdapter({
      appId: this.config.appId,
      appPassword: this.config.appPassword,
    });
    const server = createServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.config.port, this.config.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
  }

  async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method !== "POST" || url.pathname !== this.config.path) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    try {
      await this.botAdapter.processActivity(req as any, res as any, async (context: any) => {
        await this.handleActivity(context.activity ?? {});
      });
    } catch (error: any) {
      this.logger.error?.(`MSTeams activity processing failed: ${String(error?.message ?? error)}`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("error");
      }
    }
  }

  override async send(msg: OutboundMessage): Promise<void> {
    if (!this.http) throw new Error("MSTeams HTTP client not initialized");
    const refs = this.activeConversationRefs();
    const ref = refs[msg.chatId];
    if (!ref) throw new Error(`MSTeams conversation ref not found for chatId=${msg.chatId}`);
    const token = await this.getAccessToken();
    const url = `${ref.serviceUrl.replace(/\/+$/, "")}/v3/conversations/${ref.conversationId}/activities`;
    const payload: Record<string, any> = { type: "message", text: msg.content || " " };
    if (this.config.replyInThread && ref.activityId) payload.replyToId = ref.activityId;
    const resp = await this.http.post(url, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      json: payload,
    });
    resp.raiseForStatus?.();
    this.touchConversationRef(msg.chatId, true);
  }

  async handleActivity(activity: Record<string, any>): Promise<void> {
    if (activity.type !== "message") return;
    const conversation = activity.conversation ?? {};
    const fromUser = activity.from ?? {};
    const recipient = activity.recipient ?? {};
    const channelData = activity.channelData ?? {};
    const senderId = String(fromUser.aadObjectId || fromUser.id || "").trim();
    const conversationId = String(conversation.id || "").trim();
    const serviceUrl = String(activity.serviceUrl || "").trim();
    const activityId = String(activity.id || "").trim();
    const conversationType = String(conversation.conversationType || "").trim();
    if (!senderId || !conversationId || !serviceUrl) return;
    if (recipient.id && fromUser.id === recipient.id) return;
    if (conversationType && conversationType !== "personal") return;
    let text = this.sanitizeInboundText(activity);
    if (!text) {
      text = this.config.mentionOnlyResponse.trim();
      if (!text) return;
    }
    if (!this.isAllowed(senderId)) return;
    const refs = this.activeConversationRefs();
    refs[conversationId] = new ConversationRef({
      serviceUrl,
      conversationId,
      botId: recipient.id || null,
      activityId: activityId || null,
      conversationType: conversationType || "personal",
      tenantId: channelData.tenant?.id || null,
      updatedAt: Date.now() / 1000,
    });
    this.conversationRefs = refs;
    this.saveRefs();
    await this.handleMessage({
      senderId,
      chatId: conversationId,
      content: text,
      metadata: {
        msteams: {
          activityId,
          conversationId,
          conversationType: conversationType || "personal",
          fromName: fromUser.name,
        },
      },
    });
  }

  sanitizeInboundText(activity: Record<string, any>): string {
    let text = this.stripPossibleBotMention(String(activity.text || ""));
    text = this.normalizeHtmlWhitespace(text);
    const replyToId = String(activity.replyToId || "").trim();
    const channelData = activity.channelData ?? {};
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    const firstLine = normalized.split("\n").find((line) => line.trim())?.trim() ?? "";
    const looksLikeQuote = firstLine.toLowerCase().startsWith("replying to ") || firstLine.startsWith("Reply wrapper");
    if (replyToId || channelData.messageType === "reply" || looksLikeQuote) text = this.normalizeTeamsReplyQuote(text);
    return text.trim();
  }

  stripPossibleBotMention(text: string): string {
    return text
      .replace(/<at\b[^>]*>.*?<\/at>/gis, " ")
      .replace(/[^\S\r\n]+/g, " ")
      .replace(/(?:\r?\n){3,}/g, "\n\n")
      .trim();
  }

  normalizeHtmlWhitespace(text: string): string {
    return htmlUnescape(text).replace(/\u00a0/g, " ");
  }

  normalizeTeamsReplyQuote(text: string): string {
    const cleaned = this.normalizeHtmlWhitespace(text).trim();
    if (!cleaned) return "";
    const normalized = cleaned.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n").map((line) => line.trim());
    while (lines.length && !lines[0]) lines.shift();
    if (lines.length >= 2 && lines[0].toLowerCase().startsWith("replying to ")) {
      return this.formatReplyWithQuote(lines[0].slice("replying to ".length).replace(/[ :]+$/, ""), lines.slice(1).join("\n").trim());
    }
    if (lines[0]?.startsWith("Reply wrapper")) {
      const body = normalized.includes("\n") ? normalized.split("\n").slice(1).join("\n").trimStart() : normalized.slice("Reply wrapper".length).trim();
      const parts = body.split(/\n\s*\n/);
      if (parts.length >= 2) return this.formatReplyWithQuote(parts[0].replace(/\s+/g, " ").trim(), parts.slice(1).join("\n").replace(/\s+/g, " ").trim());
      const bodyLines = body.split("\n").map((line) => line.trim()).filter(Boolean);
      if (bodyLines.length >= 2) return this.formatReplyWithQuote(bodyLines.slice(0, -1).join(" "), bodyLines.at(-1) ?? "");
    }
    const compact = normalized.replace(/\s+/g, " ").trim();
    if (compact.startsWith("Reply wrapper ")) {
      const rest = compact.slice("Reply wrapper ".length).trim();
      for (const boundary of [". ", "! ", "? ", "… "]) {
        const idx = rest.lastIndexOf(boundary);
        if (idx >= 0) {
          const quoted = rest.slice(0, idx + 1).trim();
          const reply = rest.slice(idx + boundary.length).trim();
          if (quoted && reply && reply.length <= 160) return this.formatReplyWithQuote(quoted, reply);
        }
      }
    }
    return cleaned;
  }

  formatReplyWithQuote(quoted: string, reply: string): string {
    quoted = quoted.trim();
    reply = reply.trim();
    if (quoted && reply) return `User is replying to: ${quoted}\nUser reply: ${reply}`;
    return reply || quoted;
  }

  normalizeRefRecord(value: any): ConversationRef | null {
    if (!value || typeof value !== "object") return null;
    const serviceUrl = String(value.service_url ?? value.serviceUrl ?? "").trim();
    const conversationId = String(value.conversation_id ?? value.conversationId ?? "").trim();
    if (!serviceUrl || !conversationId) return null;
    return new ConversationRef({
      serviceUrl,
      conversationId,
      botId: value.bot_id ?? value.botId ?? null,
      activityId: value.activity_id ?? value.activityId ?? null,
      conversationType: value.conversation_type ?? value.conversationType ?? null,
      tenantId: value.tenant_id ?? value.tenantId ?? null,
      updatedAt: safeFloat(value.updated_at ?? value.updatedAt),
    });
  }

  loadRefsRaw(): [Record<string, any>, Record<string, any>, boolean] {
    const metaExists = fs.existsSync(this.refsMetaPath);
    return [readJson(this.refsPath), metaExists ? readJson(this.refsMetaPath) : {}, metaExists];
  }

  loadRefsFromDisk(): Record<string, ConversationRef> {
    const [main, meta, metaExists] = this.loadRefsRaw();
    const out: Record<string, ConversationRef> = {};
    const now = Date.now() / 1000;
    for (const [key, value] of Object.entries(main)) {
      const ref = this.normalizeRefRecord(value);
      if (!ref) continue;
      const metaValue = meta[key];
      const metaTs = typeof metaValue === "object" && metaValue ? safeFloat(metaValue.updated_at ?? metaValue.updatedAt) : safeFloat(metaValue);
      ref.updatedAt = metaTs ?? (!metaExists ? now : ref.updatedAt ?? now);
      out[key] = ref;
    }
    return out;
  }

  loadRefs(): Record<string, ConversationRef> {
    return this.loadRefsFromDisk();
  }

  isWebchatServiceUrl(serviceUrl: string): boolean {
    try {
      const host = new URL(serviceUrl).hostname.toLowerCase();
      return host === MSTEAMS_WEBCHAT_HOST || host.endsWith(`.${MSTEAMS_WEBCHAT_HOST}`);
    } catch {
      return serviceUrl.toLowerCase().includes(MSTEAMS_WEBCHAT_HOST);
    }
  }

  pruneConversationRefs(now = Date.now() / 1000): boolean {
    const refs = this.activeConversationRefs();
    const before = now - this.config.refTtlDays * 24 * 60 * 60;
    const drop: string[] = [];
    for (const [key, ref] of Object.entries(refs)) {
      if (this.config.pruneWebChatRefs && this.isWebchatServiceUrl(ref.serviceUrl)) {
        drop.push(key);
        continue;
      }
      const type = String(ref.conversationType || "").toLowerCase();
      if (this.config.pruneNonPersonalRefs && type && type !== "personal") {
        drop.push(key);
        continue;
      }
      const updated = safeFloat(ref.updatedAt) ?? 0;
      if (updated <= 0 || updated < before) drop.push(key);
    }
    for (const key of drop) delete refs[key];
    this.conversationRefs = refs;
    return drop.length > 0;
  }

  writeJsonAtomically(filePath: string, data: Record<string, any>): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = path.join(path.dirname(filePath), `${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
      fs.renameSync(tmp, filePath);
    } finally {
      if (fs.existsSync(tmp)) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // best effort cleanup
        }
      }
    }
  }

  saveRefs(prune = true): void {
    try {
      const refsStore = this.activeConversationRefs();
      if (prune) this.pruneConversationRefs();
      const refs: Record<string, any> = {};
      const meta: Record<string, any> = {};
      for (const [key, ref] of Object.entries(refsStore)) {
        refs[key] = {
          service_url: ref.serviceUrl,
          conversation_id: ref.conversationId,
          bot_id: ref.botId,
          activity_id: ref.activityId,
          conversation_type: ref.conversationType,
          tenant_id: ref.tenantId,
        };
        meta[key] = { updated_at: safeFloat(ref.updatedAt) };
      }
      this.writeJsonAtomically(this.refsPath, refs);
      this.writeJsonAtomically(this.refsMetaPath, meta);
    } catch {
      // Preserve the previous file on failed atomic replace.
    }
  }

  touchConversationRef(chatId: string, persist = false): void {
    const refs = this.activeConversationRefs();
    const ref = refs[chatId];
    if (!ref) return;
    const now = Date.now() / 1000;
    const prev = safeFloat(ref.updatedAt) ?? 0;
    if (this.config.refTouchIntervalS > 0 && prev > 0 && now - prev < this.config.refTouchIntervalS) return;
    ref.updatedAt = now;
    if (persist) this.saveRefs();
  }

  async getAccessToken(): Promise<string> {
    const now = Date.now() / 1000;
    if (this.token && now < this.tokenExpiresAt - 60) return this.token;
    if (!this.http) throw new Error("MSTeams HTTP client not initialized");
    const tenant = this.config.tenantId.trim() || "botframework.com";
    const resp = await this.http.post(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      data: {
        grant_type: "client_credentials",
        client_id: this.config.appId,
        client_secret: this.config.appPassword,
        scope: "https://api.botframework.com/.default",
      },
    });
    resp.raiseForStatus?.();
    const payload = resp.json();
    this.token = payload.access_token;
    this.tokenExpiresAt = now + Number(payload.expires_in ?? 3600);
    return this.token!;
  }

  async getBotFrameworkOpenIdConfig(): Promise<Record<string, any>> {
    const now = Date.now() / 1000;
    if (this.botFrameworkOpenIdConfig && now < this.botFrameworkOpenIdConfigExpiresAt) return this.botFrameworkOpenIdConfig;
    if (!this.http) throw new Error("MSTeams HTTP client not initialized");
    const resp = await this.http.get(this.botFrameworkOpenIdConfigUrl);
    resp.raiseForStatus?.();
    this.botFrameworkOpenIdConfig = resp.json();
    this.botFrameworkOpenIdConfigExpiresAt = now + 3600;
    return this.botFrameworkOpenIdConfig!;
  }

  async getBotFrameworkJwks(): Promise<Record<string, any>> {
    const now = Date.now() / 1000;
    if (this.botFrameworkJwks && now < this.botFrameworkJwksExpiresAt) return this.botFrameworkJwks;
    if (!this.http) throw new Error("MSTeams HTTP client not initialized");
    const openid = await this.getBotFrameworkOpenIdConfig();
    const jwksUri = String(openid.jwks_uri || "").trim();
    if (!jwksUri) throw new Error("Bot Framework OpenID config missing jwks_uri");
    const resp = await this.http.get(jwksUri);
    resp.raiseForStatus?.();
    this.botFrameworkJwks = resp.json();
    this.botFrameworkJwksExpiresAt = now + 3600;
    return this.botFrameworkJwks!;
  }

  async validateInboundAuth(authHeader: string, activity?: Record<string, any>): Promise<void> {
    if (!authHeader.toLowerCase().startsWith("bearer ")) throw new Error("missing bearer token");
    const token = authHeader.split(" ", 2)[1]?.trim();
    if (!token) throw new Error("empty bearer token");
    const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
    if (!encodedHeader || !encodedPayload || !encodedSignature) throw new Error("invalid bearer token");
    const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
    const kid = String(header.kid || "").trim();
    if (!kid) throw new Error("missing token kid");
    const jwks = await this.getBotFrameworkJwks();
    const jwk = (jwks.keys || []).find((key: any) => key?.kid === kid);
    if (!jwk) throw new Error(`signing key not found for kid=${kid}`);
    const verified = verifySignature(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      createPublicKey({ key: jwk, format: "jwk" } as any),
      Buffer.from(encodedSignature, "base64url"),
    );
    if (!verified) throw new Error("invalid token signature");
    const claims = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (claims.iss !== "https://api.botframework.com") throw new Error("invalid token issuer");
    const audiences = Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud || "")];
    if (!audiences.includes(this.config.appId)) throw new Error("invalid token audience");
    if (claims.exp == null || claims.nbf == null) throw new Error("token missing required time claims");
    const now = Date.now() / 1000;
    if (Number(claims.nbf) > now) throw new Error("token not yet valid");
    if (Number(claims.exp) <= now) throw new Error("token expired");
    if (activity) {
      const claimServiceUrl = String(claims.serviceurl ?? claims.serviceUrl ?? "").trim();
      const activityServiceUrl = String(activity.serviceUrl ?? "").trim();
      if (claimServiceUrl && activityServiceUrl && claimServiceUrl !== activityServiceUrl) {
        throw new Error("serviceUrl claim mismatch");
      }
    }
  }
}

function teamsHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function createMSTeamsFetchHttpClient(): any {
  const request = async (method: string, url: string, options: any = {}): Promise<any> => {
    let body: any;
    let headers = options.headers ?? {};
    if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      headers = { "Content-Type": "application/json", ...headers };
    } else if (options.data !== undefined) {
      body = new URLSearchParams(Object.entries(options.data).map(([key, value]) => [key, String(value)]));
      headers = { "Content-Type": "application/x-www-form-urlencoded", ...headers };
    }
    const response = await fetch(url, { method, headers, body });
    const text = await response.text();
    return {
      statusCode: response.status,
      headers: teamsHeaders(response.headers),
      text,
      json: () => JSON.parse(text || "{}"),
      raiseForStatus: () => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      },
    };
  };
  return {
    post: (url: string, options: any = {}) => request("POST", url, options),
    get: (url: string, options: any = {}) => request("GET", url, options),
    close: async () => undefined,
  };
}
