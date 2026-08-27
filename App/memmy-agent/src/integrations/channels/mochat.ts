import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { io as createSocketIoClient } from "socket.io-client";
import { OutboundMessage } from "../../core/runtime-messages/index.js";
import { getRuntimeSubdir } from "../../config/paths.js";
import { BaseChannel } from "./base.js";

export const MAX_SEEN_MESSAGE_IDS = 2000;

type LoopWorker = {
  stopped: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

function coalesce<T>(...values: Array<T | null | undefined>): T | undefined {
  for (const value of values) if (value !== undefined && value !== null) return value;
  return undefined;
}

function asArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function safeDict(value: any): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
  });
}

export function strField(src: Record<string, any>, ...keys: string[]): string {
  for (const key of keys) {
    const value = src?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function makeSyntheticEvent(
  messageId: string,
  author: string,
  content: any,
  meta: any,
  groupId: string,
  converseId: string,
  timestamp: any = null,
  options: { authorInfo?: any } = {},
): Record<string, any> {
  const payload: Record<string, any> = {
    messageId,
    author,
    content,
    meta: safeDict(meta),
    groupId,
    converseId,
  };
  const authorInfo = options.authorInfo;
  if (authorInfo !== undefined) payload.authorInfo = safeDict(authorInfo);
  return { type: "message.add", timestamp: timestamp || new Date().toISOString(), payload };
}

export function normalizeMochatContent(content: any): string {
  if (typeof content === "string") return content.trim();
  if (content === null || content === undefined) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

export class MochatTarget {
  id: string;
  isPanel: boolean;
  constructor(id = "", isPanel = false) {
    this.id = id;
    this.isPanel = isPanel;
  }
}

export function resolveMochatTarget(raw: string): MochatTarget {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return new MochatTarget();
  const lowered = trimmed.toLowerCase();
  let cleaned = trimmed;
  let forcedPanel = false;
  for (const prefix of ["mochat:", "group:", "channel:", "panel:"]) {
    if (lowered.startsWith(prefix)) {
      cleaned = trimmed.slice(prefix.length).trim();
      forcedPanel = ["group:", "channel:", "panel:"].includes(prefix);
      break;
    }
  }
  if (!cleaned) return new MochatTarget();
  return new MochatTarget(cleaned, forcedPanel || !cleaned.startsWith("session_"));
}

export function extractMentionIds(value: any): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) ids.push(item.trim());
    else if (item && typeof item === "object") {
      for (const key of ["id", "userId", "_id"]) {
        const candidate = item[key];
        if (typeof candidate === "string" && candidate.trim()) {
          ids.push(candidate.trim());
          break;
        }
      }
    }
  }
  return ids;
}

export function resolveWasMentioned(payload: Record<string, any>, agentUserId: string): boolean {
  const meta = payload.meta;
  if (meta && typeof meta === "object") {
    if (meta.mentioned === true || meta.wasMentioned === true) return true;
    for (const field of ["mentions", "mentionIds", "mentionedUserIds", "mentionedUsers"]) {
      if (agentUserId && extractMentionIds(meta[field]).includes(agentUserId)) return true;
    }
  }
  if (!agentUserId || typeof payload.content !== "string") return false;
  return payload.content.includes(`<@${agentUserId}>`) || payload.content.includes(`@${agentUserId}`);
}

export class MochatMentionConfig {
  requireInGroups = false;
  constructor(init: Partial<MochatMentionConfig> & Record<string, any> = {}) {
    this.requireInGroups = Boolean(coalesce(init.requireInGroups, this.requireInGroups));
  }
}

export class MochatGroupRule {
  requireMention = false;
  constructor(init: Partial<MochatGroupRule> & Record<string, any> = {}) {
    this.requireMention = Boolean(coalesce(init.requireMention, this.requireMention));
  }
}

export class MochatBufferedEntry {
  rawBody: string;
  author: string;
  senderName: string;
  senderUsername: string;
  timestamp: number | null;
  messageId: string;
  groupId: string;
  constructor(init: Partial<MochatBufferedEntry> & Record<string, any> = {}) {
    this.rawBody = String(coalesce(init.rawBody, "") ?? "");
    this.author = String(init.author ?? "");
    this.senderName = String(coalesce(init.senderName, "") ?? "");
    this.senderUsername = String(coalesce(init.senderUsername, "") ?? "");
    this.timestamp = coalesce(init.timestamp, null) ?? null;
    this.messageId = String(coalesce(init.messageId, "") ?? "");
    this.groupId = String(coalesce(init.groupId, "") ?? "");
  }
}

export class DelayState {
  entries: MochatBufferedEntry[] = [];
  timer: ReturnType<typeof setTimeout> | null = null;
}

export function resolveRequireMention(config: MochatConfig, sessionId: string, groupId: string): boolean {
  const groups = config.groups ?? {};
  for (const key of [groupId, sessionId, "*"]) {
    const rule = key ? groups[key] : null;
    if (rule) return Boolean(rule.requireMention);
  }
  return Boolean(config.mention.requireInGroups);
}

export function buildBufferedBody(entries: MochatBufferedEntry[], isGroup: boolean): string {
  if (!entries.length) return "";
  if (entries.length === 1) return entries[0].rawBody;
  const lines: string[] = [];
  for (const entry of entries) {
    if (!entry.rawBody) continue;
    if (isGroup) {
      const label = entry.senderName.trim() || entry.senderUsername.trim() || entry.author;
      if (label) {
        lines.push(`${label}: ${entry.rawBody}`);
        continue;
      }
    }
    lines.push(entry.rawBody);
  }
  return lines.join("\n").trim();
}

export function parseTimestamp(value: any): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class MochatConfig {
  enabled = false;
  baseUrl = "https://mochat.io";
  socketUrl = "";
  socketPath = "/socket.io";
  socketDisableMsgpack = false;
  socketReconnectDelayMs = 1000;
  socketMaxReconnectDelayMs = 10_000;
  socketConnectTimeoutMs = 10_000;
  refreshIntervalMs = 30_000;
  watchTimeoutMs = 25_000;
  watchLimit = 100;
  retryDelayMs = 500;
  maxRetryAttempts = 0;
  clawToken = "";
  agentUserId = "";
  sessions: string[] = [];
  panels: string[] = [];
  allowFrom: string[] = [];
  mention = new MochatMentionConfig();
  groups: Record<string, MochatGroupRule> = {};
  replyDelayMode = "non-mention";
  replyDelayMs = 120_000;

  constructor(init: Partial<MochatConfig> & Record<string, any> = {}) {
    this.enabled = Boolean(coalesce(init.enabled, this.enabled));
    this.baseUrl = coalesce(init.baseUrl, this.baseUrl) ?? this.baseUrl;
    this.socketUrl = coalesce(init.socketUrl, this.socketUrl) ?? "";
    this.socketPath = coalesce(init.socketPath, this.socketPath) ?? "/socket.io";
    this.socketDisableMsgpack = Boolean(coalesce(init.socketDisableMsgpack, this.socketDisableMsgpack));
    this.socketReconnectDelayMs = coalesce(init.socketReconnectDelayMs, this.socketReconnectDelayMs) ?? 1000;
    this.socketMaxReconnectDelayMs = coalesce(init.socketMaxReconnectDelayMs, this.socketMaxReconnectDelayMs) ?? 10_000;
    this.socketConnectTimeoutMs = coalesce(init.socketConnectTimeoutMs, this.socketConnectTimeoutMs) ?? 10_000;
    this.refreshIntervalMs = coalesce(init.refreshIntervalMs, this.refreshIntervalMs) ?? 30_000;
    this.watchTimeoutMs = coalesce(init.watchTimeoutMs, this.watchTimeoutMs) ?? 25_000;
    this.watchLimit = coalesce(init.watchLimit, this.watchLimit) ?? 100;
    this.retryDelayMs = coalesce(init.retryDelayMs, this.retryDelayMs) ?? 500;
    this.maxRetryAttempts = coalesce(init.maxRetryAttempts, this.maxRetryAttempts) ?? 0;
    this.clawToken = coalesce(init.clawToken, this.clawToken) ?? "";
    this.agentUserId = coalesce(init.agentUserId, this.agentUserId) ?? "";
    this.sessions = asArray(init.sessions ?? this.sessions);
    this.panels = asArray(init.panels ?? this.panels);
    this.allowFrom = asArray(coalesce(init.allowFrom, this.allowFrom));
    this.mention = init.mention instanceof MochatMentionConfig ? init.mention : new MochatMentionConfig(init.mention ?? {});
    this.groups = {};
    for (const [key, value] of Object.entries(init.groups ?? this.groups ?? {})) {
      this.groups[key] = value instanceof MochatGroupRule ? value : new MochatGroupRule(value as any);
    }
    this.replyDelayMode = coalesce(init.replyDelayMode, this.replyDelayMode) ?? "non-mention";
    this.replyDelayMs = coalesce(init.replyDelayMs, this.replyDelayMs) ?? 120_000;
  }
}

export class MochatChannel extends BaseChannel {
  override name = "mochat";
  override displayName = "Mochat";
  override config: MochatConfig;
  http: any = null;
  socket: any = null;
  socketFactory: any = createSocketIoClient;
  wsConnected = false;
  wsReady = false;
  stateDir: string;
  cursorPath: string;
  sessionCursor: Record<string, number> = {};
  sessionSet = new Set<string>();
  panelSet = new Set<string>();
  autoDiscoverSessions = false;
  autoDiscoverPanels = false;
  coldSessions = new Set<string>();
  sessionByConverse: Record<string, string> = {};
  seenSet: Record<string, Set<string>> = {};
  seenQueue: Record<string, string[]> = {};
  delayStates: Record<string, DelayState> = {};
  fallbackMode = false;
  sessionFallbackWorkers = new Map<string, LoopWorker>();
  panelFallbackWorkers = new Map<string, LoopWorker>();
  refreshTimer: ReturnType<typeof setInterval> | null = null;
  targetLocks: Record<string, Promise<void>> = {};

  static override defaultConfig(): Record<string, any> {
    return new MochatConfig() as any;
  }

  constructor(config: Partial<MochatConfig> & Record<string, any> = {}, bus?: any) {
    const normalized = config instanceof MochatConfig ? config : new MochatConfig(config);
    super("mochat", normalized, bus);
    this.config = normalized;
    this.stateDir = getRuntimeSubdir("mochat");
    this.cursorPath = path.join(this.stateDir, "session-cursors.json");
  }

  override async start(): Promise<void> {
    if (!this.config.clawToken) return;
    this.running = true;
    this.http = this.http ?? createFetchHttpClient();
    fs.mkdirSync(this.stateDir, { recursive: true });
    await this.loadSessionCursors();
    this.seedTargetsFromConfig();
    await this.refreshTargets(false);
    if (!await this.startSocketClient()) {
      this.ensureFallbackWorkers();
    }
    this.startRefreshLoop();
  }

  override async stop(): Promise<void> {
    this.running = false;
    this.stopRefreshLoop();
    this.stopFallbackWorkers();
    await this.cancelDelayTimers();
    await this.socket?.disconnect?.();
    await this.saveSessionCursors();
    await this.http?.close?.();
    await this.http?.aclose?.();
    this.socket = null;
    this.http = null;
    this.wsConnected = this.wsReady = false;
  }

  override async send(msg: OutboundMessage): Promise<void> {
    if (!this.config.clawToken) return;
    const parts: string[] = [];
    const content = String(msg.content ?? msg.text ?? "").trim();
    if (content) parts.push(content);
    if (Array.isArray(msg.media)) parts.push(...msg.media.filter((item: any) => typeof item === "string" && item.trim()).map(String));
    const body = parts.join("\n").trim();
    if (!body) return;
    const chatId = String(msg.chatId ?? "");
    const target = resolveMochatTarget(chatId);
    if (!target.id) return;
    const isPanel = (target.isPanel || this.panelSet.has(target.id)) && !target.id.startsWith("session_");
    if (isPanel) {
      await this.apiSend("/api/claw/groups/panels/send", "panelId", target.id, body, msg.replyTo ?? null, this.readGroupId(msg.metadata));
    } else {
      await this.apiSend("/api/claw/sessions/send", "sessionId", target.id, body, msg.replyTo ?? null);
    }
  }

  seedTargetsFromConfig(): void {
    const [sessions, autoSessions] = this.normalizeIdList(this.config.sessions);
    const [panels, autoPanels] = this.normalizeIdList(this.config.panels);
    this.autoDiscoverSessions = autoSessions;
    this.autoDiscoverPanels = autoPanels;
    for (const session of sessions) {
      this.sessionSet.add(session);
      if (!(session in this.sessionCursor)) this.coldSessions.add(session);
    }
    for (const panel of panels) this.panelSet.add(panel);
  }

  normalizeIdList(values: string[]): [string[], boolean] {
    const cleaned = asArray(values).map((value) => value.trim()).filter(Boolean);
    return [[...new Set(cleaned.filter((value) => value !== "*"))].sort(), cleaned.includes("*")];
  }

  async startSocketClient(): Promise<boolean> {
    const socketUrl = (this.config.socketUrl || this.config.baseUrl).trim().replace(/\/+$/g, "");
    const socketPath = (this.config.socketPath || "/socket.io").trim().replace(/^\/+/, "") || "socket.io";
    const connectTimeoutMs = Math.max(1000, Number(this.config.socketConnectTimeoutMs));
    const socket = this.socketFactory(socketUrl, {
      path: `/${socketPath}`,
      transports: ["websocket"],
      auth: { token: this.config.clawToken },
      reconnection: true,
      reconnectionAttempts: this.config.maxRetryAttempts || Infinity,
      reconnectionDelay: Math.max(100, Number(this.config.socketReconnectDelayMs)),
      reconnectionDelayMax: Math.max(100, Number(this.config.socketMaxReconnectDelayMs)),
      timeout: connectTimeoutMs,
      forceNew: true,
    });
    this.socket = socket;

    let firstConnectFinish: ((ok: boolean) => void) | null = null;
    const onConnect = async (): Promise<void> => {
      this.wsConnected = true;
      this.wsReady = false;
      const subscribed = await this.subscribeAll();
      this.wsReady = subscribed;
      if (subscribed) this.stopFallbackWorkers();
      else this.ensureFallbackWorkers();
      firstConnectFinish?.(true);
      firstConnectFinish = null;
    };
    socket.on?.("connect", () => {
      void onConnect();
    });
    socket.on?.("disconnect", () => {
      if (!this.running) return;
      this.wsConnected = false;
      this.wsReady = false;
      this.ensureFallbackWorkers();
    });
    socket.on?.("connect_error", () => undefined);
    socket.on?.("claw.session.events", (payload: any) => {
      void this.handleWatchPayload(payload, "session");
    });
    socket.on?.("claw.panel.events", (payload: any) => {
      void this.handleWatchPayload(payload, "panel");
    });
    for (const eventName of [
      "notify:chat.inbox.append",
      "notify:chat.message.add",
      "notify:chat.message.update",
      "notify:chat.message.recall",
      "notify:chat.message.delete",
    ]) {
      socket.on?.(eventName, this.buildNotifyHandler(eventName));
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      firstConnectFinish = finish;
      const timer = setTimeout(() => {
        socket.disconnect?.();
        if (this.socket === socket) this.socket = null;
        finish(false);
      }, connectTimeoutMs);
      timer.unref?.();
      socket.once?.("connect_error", () => {
        firstConnectFinish = null;
        socket.disconnect?.();
        if (this.socket === socket) this.socket = null;
        finish(false);
      });
    });
  }

  buildNotifyHandler(eventName: string): (payload: any) => void {
    return (payload: any) => {
      if (eventName === "notify:chat.inbox.append") void this.handleNotifyInboxAppend(payload);
      else if (eventName.startsWith("notify:chat.message.")) void this.handleNotifyChatMessage(payload);
    };
  }

  async subscribeAll(): Promise<boolean> {
    let ok = await this.subscribeSessions([...this.sessionSet].sort());
    ok = await this.subscribePanels([...this.panelSet].sort()) && ok;
    if (this.autoDiscoverSessions || this.autoDiscoverPanels) await this.refreshTargets(true);
    return ok;
  }

  async subscribeSessions(sessionIds: string[]): Promise<boolean> {
    if (!sessionIds.length) return true;
    for (const sessionId of sessionIds) if (!(sessionId in this.sessionCursor)) this.coldSessions.add(sessionId);
    const ack = await this.socketCall("com.claw.im.subscribeSessions", {
      sessionIds,
      cursors: this.sessionCursor,
      limit: this.config.watchLimit,
    });
    if (!ack.result) return false;
    const data = ack.data;
    const items = Array.isArray(data)
      ? data.filter((item: any) => item && typeof item === "object")
      : Array.isArray(data?.sessions)
        ? data.sessions.filter((item: any) => item && typeof item === "object")
        : data?.sessionId
          ? [data]
          : [];
    for (const item of items) await this.handleWatchPayload(item, "session");
    return true;
  }

  async subscribePanels(panelIds: string[]): Promise<boolean> {
    if (!this.autoDiscoverPanels && !panelIds.length) return true;
    const ack = await this.socketCall("com.claw.im.subscribePanels", { panelIds });
    return Boolean(ack.result);
  }

  async socketCall(eventName: string, payload: Record<string, any>): Promise<Record<string, any>> {
    const socket = this.socket;
    if (!socket?.emit) return { result: false, message: "socket not connected" };
    return await new Promise<Record<string, any>>((resolve) => {
      const done = (...args: any[]): void => {
        if (args.length >= 2 && args[0]) {
          resolve({ result: false, message: String(args[0]?.message ?? args[0]) });
          return;
        }
        const raw = args.length >= 2 ? args[1] : args[0];
        resolve(raw && typeof raw === "object" && !Array.isArray(raw) ? raw : { result: true, data: raw });
      };
      try {
        const target = typeof socket.timeout === "function" ? socket.timeout(10_000) : socket;
        target.emit(eventName, payload, done);
      } catch (error: any) {
        resolve({ result: false, message: String(error?.message ?? error) });
      }
    });
  }

  startRefreshLoop(): void {
    this.stopRefreshLoop();
    const interval = Math.max(1000, Number(this.config.refreshIntervalMs));
    this.refreshTimer = setInterval(() => {
      void this.refreshTick();
    }, interval);
    this.refreshTimer.unref?.();
  }

  stopRefreshLoop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  async refreshTick(): Promise<void> {
    if (!this.running) return;
    await this.refreshTargets(this.wsReady);
    if (this.fallbackMode) this.ensureFallbackWorkers();
  }

  async refreshTargets(subscribeNew: boolean): Promise<void> {
    if (this.autoDiscoverSessions) await this.refreshSessionsDirectory(subscribeNew);
    if (this.autoDiscoverPanels) await this.refreshPanels(subscribeNew);
  }

  async refreshSessionsDirectory(subscribeNew: boolean): Promise<void> {
    let response: Record<string, any>;
    try {
      response = await this.postJson("/api/claw/sessions/list", {});
    } catch {
      return;
    }
    const sessions = Array.isArray(response.sessions) ? response.sessions : [];
    const newIds: string[] = [];
    for (const session of sessions) {
      if (!session || typeof session !== "object") continue;
      const sessionId = strField(session, "sessionId");
      if (!sessionId) continue;
      if (!this.sessionSet.has(sessionId)) {
        this.sessionSet.add(sessionId);
        newIds.push(sessionId);
        if (!(sessionId in this.sessionCursor)) this.coldSessions.add(sessionId);
      }
      const converseId = strField(session, "converseId");
      if (converseId) this.sessionByConverse[converseId] = sessionId;
    }
    if (!newIds.length) return;
    if (this.wsReady && subscribeNew) await this.subscribeSessions(newIds);
    if (this.fallbackMode) this.ensureFallbackWorkers();
  }

  async refreshPanels(subscribeNew: boolean): Promise<void> {
    let response: Record<string, any>;
    try {
      response = await this.postJson("/api/claw/groups/get", {});
    } catch {
      return;
    }
    const panels = Array.isArray(response.panels) ? response.panels : [];
    const newIds: string[] = [];
    for (const panel of panels) {
      if (!panel || typeof panel !== "object") continue;
      if (typeof panel.type === "number" && panel.type !== 0) continue;
      const panelId = strField(panel, "id", "_id");
      if (!panelId || this.panelSet.has(panelId)) continue;
      this.panelSet.add(panelId);
      newIds.push(panelId);
    }
    if (!newIds.length) return;
    if (this.wsReady && subscribeNew) await this.subscribePanels(newIds);
    if (this.fallbackMode) this.ensureFallbackWorkers();
  }

  ensureFallbackWorkers(): void {
    if (!this.running) return;
    this.fallbackMode = true;
    for (const sessionId of [...this.sessionSet].sort()) {
      if (!this.sessionFallbackWorkers.has(sessionId)) {
        this.startLoopWorker(this.sessionFallbackWorkers, sessionId, () => this.sessionWatchTick(sessionId), () => Math.max(100, Number(this.config.retryDelayMs)));
      }
    }
    for (const panelId of [...this.panelSet].sort()) {
      if (!this.panelFallbackWorkers.has(panelId)) {
        this.startLoopWorker(this.panelFallbackWorkers, panelId, () => this.panelPollTick(panelId), () => Math.max(1000, Number(this.config.refreshIntervalMs)));
      }
    }
  }

  stopFallbackWorkers(): void {
    this.fallbackMode = false;
    for (const worker of [...this.sessionFallbackWorkers.values(), ...this.panelFallbackWorkers.values()]) {
      worker.stopped = true;
      if (worker.timer) clearTimeout(worker.timer);
      worker.timer = null;
    }
    this.sessionFallbackWorkers.clear();
    this.panelFallbackWorkers.clear();
  }

  startLoopWorker(
    workers: Map<string, LoopWorker>,
    key: string,
    tick: () => Promise<void>,
    delayMs: () => number,
  ): void {
    const worker: LoopWorker = { stopped: false, timer: null };
    const run = async (): Promise<void> => {
      if (worker.stopped || !this.running) return;
      try {
        await tick();
      } catch {
        // Fallback workers keep running across transient network/API errors.
      }
      if (worker.stopped || !this.running || !this.fallbackMode) return;
      worker.timer = setTimeout(() => {
        void run();
      }, delayMs());
      worker.timer.unref?.();
    };
    workers.set(key, worker);
    worker.timer = setTimeout(() => {
      void run();
    }, 0);
    worker.timer.unref?.();
  }

  async sessionWatchTick(sessionId: string): Promise<void> {
    const payload = await this.postJson("/api/claw/sessions/watch", {
      sessionId,
      cursor: this.sessionCursor[sessionId] ?? 0,
      timeoutMs: this.config.watchTimeoutMs,
      limit: this.config.watchLimit,
    });
    await this.handleWatchPayload(payload, "session");
  }

  async panelPollTick(panelId: string): Promise<void> {
    const response = await this.postJson("/api/claw/groups/panels/messages", {
      panelId,
      limit: Math.min(100, Math.max(1, Number(this.config.watchLimit))),
    });
    const messages = Array.isArray(response.messages) ? response.messages : [];
    for (const message of [...messages].reverse()) {
      if (!message || typeof message !== "object") continue;
      const event = makeSyntheticEvent(
        String(message.messageId ?? ""),
        String(message.author ?? ""),
        message.content,
        message.meta,
        String(response.groupId ?? ""),
        panelId,
        message.createdAt,
        { authorInfo: message.authorInfo },
      );
      await this.processInboundEvent(panelId, event, "panel");
    }
  }

  async handleWatchPayload(payload: Record<string, any>, targetKind: string): Promise<void> {
    if (!payload || typeof payload !== "object") return;
    const targetId = strField(payload, "sessionId");
    if (!targetId) return;
    const previousCursor = targetKind === "session" ? this.sessionCursor[targetId] ?? 0 : 0;
    if (targetKind === "session" && Number.isInteger(payload.cursor) && payload.cursor >= 0) this.markSessionCursor(targetId, payload.cursor);
    const events = Array.isArray(payload.events) ? payload.events : [];
    if (targetKind === "session" && this.coldSessions.has(targetId)) {
      this.coldSessions.delete(targetId);
      return;
    }
    for (const event of events) {
      if (!event || typeof event !== "object") continue;
      if (targetKind === "session" && Number.isInteger(event.seq) && event.seq > (this.sessionCursor[targetId] ?? previousCursor)) {
        this.markSessionCursor(targetId, event.seq);
      }
      if (event.type === "message.add") await this.processInboundEvent(targetId, event, targetKind);
    }
  }

  async processInboundEvent(targetId: string, event: Record<string, any>, targetKind: string): Promise<void> {
    const payload = event.payload;
    if (!payload || typeof payload !== "object") return;
    const author = strField(payload, "author");
    if (!author || (this.config.agentUserId && author === this.config.agentUserId)) return;
    if (!this.isAllowed(author)) return;
    const messageId = strField(payload, "messageId");
    const seenKey = `${targetKind}:${targetId}`;
    if (messageId && this.rememberMessageId(seenKey, messageId)) return;
    const rawBody = normalizeMochatContent(payload.content) || "[empty message]";
    const authorInfo = safeDict(payload.authorInfo);
    const groupId = strField(payload, "groupId");
    const isGroup = Boolean(groupId);
    const wasMentioned = resolveWasMentioned(payload, this.config.agentUserId);
    const requireMention = targetKind === "panel" && isGroup && resolveRequireMention(this.config, targetId, groupId);
    const useDelay = targetKind === "panel" && this.config.replyDelayMode === "non-mention";
    if (requireMention && !wasMentioned && !useDelay) return;
    const entry = new MochatBufferedEntry({
      rawBody,
      author,
      senderName: strField(authorInfo, "nickname", "email"),
      senderUsername: strField(authorInfo, "agentId"),
      timestamp: parseTimestamp(event.timestamp),
      messageId,
      groupId,
    });
    if (useDelay) {
      const key = seenKey;
      if (wasMentioned) await this.flushDelayedEntries(key, targetId, targetKind, "mention", entry);
      else await this.enqueueDelayedEntry(key, targetId, targetKind, entry);
      return;
    }
    await this.dispatchEntries(targetId, targetKind, [entry], wasMentioned);
  }

  rememberMessageId(key: string, messageId: string): boolean {
    const seen = (this.seenSet[key] ??= new Set<string>());
    const queue = (this.seenQueue[key] ??= []);
    if (seen.has(messageId)) return true;
    seen.add(messageId);
    queue.push(messageId);
    while (queue.length > MAX_SEEN_MESSAGE_IDS) {
      const old = queue.shift();
      if (old) seen.delete(old);
    }
    return false;
  }

  async enqueueDelayedEntry(key: string, targetId: string, targetKind: string, entry: MochatBufferedEntry): Promise<void> {
    const state = (this.delayStates[key] ??= new DelayState());
    state.entries.push(entry);
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      void this.flushDelayedEntries(key, targetId, targetKind, "timer", null);
    }, Math.max(0, this.config.replyDelayMs));
  }

  async flushDelayedEntries(
    key: string,
    targetId: string,
    targetKind: string,
    reason: string,
    entry: MochatBufferedEntry | null,
  ): Promise<void> {
    const state = (this.delayStates[key] ??= new DelayState());
    if (entry) state.entries.push(entry);
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    const entries = state.entries.splice(0);
    if (entries.length) await this.dispatchEntries(targetId, targetKind, entries, reason === "mention");
  }

  async dispatchEntries(targetId: string, targetKind: string, entries: MochatBufferedEntry[], wasMentioned: boolean): Promise<void> {
    if (!entries.length) return;
    const last = entries[entries.length - 1];
    const isGroup = Boolean(last.groupId);
    const body = buildBufferedBody(entries, isGroup) || "[empty message]";
    await this.handleMessage({
      senderId: last.author,
      chatId: targetId,
      content: body,
      metadata: {
        messageId: last.messageId,
        timestamp: last.timestamp,
        isGroup,
        groupId: last.groupId,
        senderName: last.senderName,
        senderUsername: last.senderUsername,
        targetKind,
        wasMentioned,
        bufferedCount: entries.length,
      },
    });
  }

  async cancelDelayTimers(): Promise<void> {
    for (const state of Object.values(this.delayStates)) if (state.timer) clearTimeout(state.timer);
    this.delayStates = {};
  }

  async handleNotifyChatMessage(payload: any): Promise<void> {
    if (!payload || typeof payload !== "object") return;
    const groupId = strField(payload, "groupId");
    const panelId = strField(payload, "converseId", "panelId");
    if (!groupId || !panelId) return;
    if (this.panelSet.size && !this.panelSet.has(panelId)) return;
    const event = makeSyntheticEvent(
      String(payload._id ?? payload.messageId ?? ""),
      String(payload.author ?? ""),
      payload.content,
      payload.meta,
      groupId,
      panelId,
      payload.createdAt,
      { authorInfo: payload.authorInfo },
    );
    await this.processInboundEvent(panelId, event, "panel");
  }

  async handleNotifyInboxAppend(payload: any): Promise<void> {
    if (!payload || typeof payload !== "object" || payload.type !== "message") return;
    const detail = payload.payload;
    if (!detail || typeof detail !== "object" || strField(detail, "groupId")) return;
    const converseId = strField(detail, "converseId");
    if (!converseId) return;
    let sessionId = this.sessionByConverse[converseId];
    if (!sessionId) {
      await this.refreshSessionsDirectory(this.wsReady);
      sessionId = this.sessionByConverse[converseId];
    }
    if (!sessionId) return;
    const event = makeSyntheticEvent(
      String(detail.messageId ?? payload._id ?? ""),
      String(detail.messageAuthor ?? ""),
      String(detail.messagePlainContent ?? detail.messageSnippet ?? ""),
      { source: "notify:chat.inbox.append", converseId },
      "",
      converseId,
      payload.createdAt,
    );
    await this.processInboundEvent(sessionId, event, "session");
  }

  markSessionCursor(sessionId: string, cursor: number): void {
    if (cursor < 0 || cursor < (this.sessionCursor[sessionId] ?? 0)) return;
    this.sessionCursor[sessionId] = cursor;
  }

  async loadSessionCursors(): Promise<void> {
    if (!fs.existsSync(this.cursorPath)) return;
    try {
      const data = JSON.parse(await fsp.readFile(this.cursorPath, "utf8"));
      const cursors = safeDict(data.cursors);
      for (const [sid, cursor] of Object.entries(cursors)) {
        if (typeof sid === "string" && Number.isInteger(cursor) && cursor >= 0) this.sessionCursor[sid] = cursor;
      }
    } catch {
      return;
    }
  }

  async saveSessionCursors(): Promise<void> {
    try {
      await fsp.mkdir(this.stateDir, { recursive: true });
      await fsp.writeFile(
        this.cursorPath,
        JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), cursors: this.sessionCursor }, null, 2) + "\n",
      );
    } catch {
      return;
    }
  }

  async postJson(apiPath: string, payload: Record<string, any>): Promise<Record<string, any>> {
    if (!this.http) throw new Error("Mochat HTTP client not initialized");
    const url = `${this.config.baseUrl.replace(/\/+$/g, "")}${apiPath}`;
    const response = await this.http.post(url, {
      headers: { "Content-Type": "application/json", "X-Claw-Token": this.config.clawToken },
      json: payload,
    });
    if (response?.success === false || Number(response?.statusCode) >= 400) {
      throw new Error(`Mochat HTTP ${response.statusCode}: ${String(response.text ?? "").slice(0, 200)}`);
    }
    const parsed = typeof response?.json === "function" ? await response.json() : response?.data ?? response;
    if (parsed && typeof parsed === "object" && Number.isInteger(parsed.code)) {
      if (parsed.code !== 200) throw new Error(`Mochat API error: ${parsed.message ?? parsed.name ?? "request failed"} (code=${parsed.code})`);
      return safeDict(parsed.data);
    }
    return safeDict(parsed);
  }

  async apiSend(apiPath: string, idKey: string, idValue: string, content: string, replyTo?: string | null, groupId?: string | null): Promise<Record<string, any>> {
    const body: Record<string, any> = { [idKey]: idValue, content };
    if (replyTo) body.replyTo = replyTo;
    if (groupId) body.groupId = groupId;
    return this.postJson(apiPath, body);
  }

  readGroupId(metadata: Record<string, any> | null | undefined): string | null {
    const value = metadata?.groupId;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }
}

function createFetchHttpClient(): any {
  return {
    async post(url: string, options: any) {
      const response = await fetch(url, {
        method: "POST",
        headers: options.headers,
        body: JSON.stringify(options.json ?? {}),
      });
      return {
        statusCode: response.status,
        success: response.ok,
        text: await response.clone().text(),
        json: () => response.json(),
      };
    },
  };
}
