import fs from "node:fs";
import path from "node:path";
import { slackifyMarkdown } from "slackify-markdown";
import { OutboundMessage } from "../../core/runtime-messages/index.js";
import { getMediaDir } from "../../config/paths.js";
import { splitMessage } from "../../utils/helpers.js";
import { BaseChannel } from "./base.js";

export const SLACK_MAX_MESSAGE_LEN = 39_000;
export const SLACK_DOWNLOAD_TIMEOUT = 30.0;
const THREAD_CONTEXT_CACHE_LIMIT = 1024;
const TABLE_RE = /^\|.*\|$(?:\n\|[\s:|-]*\|$)(?:\n\|.*\|$)*/gm;
const CODE_FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`]+`/g;
const LEFTOVER_BOLD_RE = /\*\*(.+?)\*\*/g;
const LEFTOVER_HEADER_RE = /^#{1,6}\s+(.+)$/gm;
const BARE_URL_RE = /(?<![|<])(https?:\/\/\S+)/g;
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\uFEFF]/g;
const HTML_AMP_RE = /&amp;/g;

export class SlackDMConfig {
  enabled = true;
  policy = "open";
  allowFrom: string[] = [];

  constructor(init: Partial<SlackDMConfig> = {}) {
    this.enabled = init.enabled ?? this.enabled;
    this.policy = init.policy ?? this.policy;
    this.allowFrom = init.allowFrom ?? [];
  }
}

export class SlackConfig {
  enabled = false;
  mode = "socket";
  webhookPath = "/slack/events";
  botToken = "";
  appToken = "";
  userTokenReadOnly = true;
  replyInThread = true;
  reactEmoji = "eyes";
  doneEmoji = "white_check_mark";
  includeThreadContext = true;
  threadContextLimit = 20;
  allowFrom: string[] = [];
  groupPolicy = "mention";
  groupAllowFrom: string[] = [];
  dm: SlackDMConfig;

  constructor(init: Partial<SlackConfig> = {}) {
    this.enabled = init.enabled ?? this.enabled;
    this.mode = init.mode ?? this.mode;
    this.webhookPath = init.webhookPath ?? this.webhookPath;
    this.botToken = init.botToken ?? this.botToken;
    this.appToken = init.appToken ?? this.appToken;
    this.userTokenReadOnly = init.userTokenReadOnly ?? this.userTokenReadOnly;
    this.replyInThread = init.replyInThread ?? this.replyInThread;
    this.reactEmoji = init.reactEmoji ?? this.reactEmoji;
    this.doneEmoji = init.doneEmoji ?? this.doneEmoji;
    this.includeThreadContext = init.includeThreadContext ?? this.includeThreadContext;
    this.threadContextLimit = init.threadContextLimit ?? this.threadContextLimit;
    this.allowFrom = init.allowFrom ?? [];
    this.groupPolicy = init.groupPolicy ?? this.groupPolicy;
    this.groupAllowFrom = init.groupAllowFrom ?? [];
    this.dm = init.dm instanceof SlackDMConfig ? init.dm : new SlackDMConfig(init.dm ?? {});
  }
}

function valueOf(response: any, key: string, fallback: any): any {
  return response?.[key] ?? fallback;
}

export class SlackChannel extends BaseChannel {
  override name = "slack";
  override displayName = "Slack";
  override config: SlackConfig;
  webClient: any = null;
  socketClient: any = null;
  botUserId: string | null = null;
  targetCache = new Map<string, string>();
  threadContextAttempted = new Set<string>();

  static override defaultConfig(): Record<string, any> {
    return new SlackConfig() as any;
  }

  constructor(config: Partial<SlackConfig> = {}, bus?: any) {
    super("slack", config instanceof SlackConfig ? config : new SlackConfig(config), bus);
    this.config = config instanceof SlackConfig ? config : new SlackConfig(config);
  }

  async start(): Promise<void> {
    if (!this.config.botToken || !this.config.appToken) return;
    if (!this.webClient) {
      const { WebClient } = await import("@slack/web-api");
      this.webClient = new WebClient(this.config.botToken);
    }
    try {
      const auth = await this.webClient.auth?.test?.();
      if (auth?.user_id) this.botUserId = String(auth.user_id);
    } catch {
      // auth.test is helpful but not required for already-injected test clients.
    }
    if (!this.socketClient) {
      const { SocketModeClient } = await import("@slack/socket-mode");
      const socket = new SocketModeClient({ appToken: this.config.appToken });
      socket.on?.("slack_event", async ({ body, ack }: any) => {
        await ack?.();
        await this.onSocketRequest({ sendSocketModeResponse: async () => undefined }, {
          type: "events_api",
          envelope_id: body?.envelope_id,
          payload: body,
        });
      });
      socket.on?.("interactive", async ({ body, ack }: any) => {
        await ack?.();
        await this.onSocketRequest({ sendSocketModeResponse: async () => undefined }, {
          type: "interactive",
          envelope_id: body?.envelope_id,
          payload: body,
        });
      });
      this.socketClient = socket;
    }
    await this.socketClient.start?.();
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.socketClient?.disconnect) await this.socketClient.disconnect();
    if (this.socketClient?.close) await this.socketClient.close();
    this.socketClient = null;
  }

  toMrkdwn(text: string): string {
    if (!text) return "";
    const convertedTables = text.replace(TABLE_RE, (match) => SlackChannel.convertTable(match));
    return SlackChannel.fixupMrkdwn(slackifyMarkdown(convertedTables)).replace(/\n+$/g, "");
  }

  static fixupMrkdwn(text: string): string {
    const codeBlocks: string[] = [];
    const saveCode = (match: string): string => {
      codeBlocks.push(match);
      return `\0CB${codeBlocks.length - 1}\0`;
    };
    let fixed = text
      .replace(CODE_FENCE_RE, saveCode)
      .replace(INLINE_CODE_RE, saveCode)
      .replace(LEFTOVER_BOLD_RE, "*$1*")
      .replace(LEFTOVER_HEADER_RE, "*$1*")
      .replace(BARE_URL_RE, (match) => match.replace(/&amp;/g, "&"));
    while (HTML_AMP_RE.test(fixed)) {
      fixed = fixed.replace(HTML_AMP_RE, "&");
      HTML_AMP_RE.lastIndex = 0;
    }
    fixed = fixed.replace(ZERO_WIDTH_RE, "");
    codeBlocks.forEach((block, index) => {
      fixed = fixed.replace(`\0CB${index}\0`, block);
    });
    return fixed;
  }

  static convertTable(table: string): string {
    const lines = table.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length < 2) return table;
    const headers = lines[0].replace(/^\||\|$/g, "").split("|").map((header) => header.trim());
    const start = /^[|\s:-]+$/.test(lines[1]) ? 2 : 1;
    const rows: string[] = [];
    for (const line of lines.slice(start)) {
      const cells = line.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
      while (cells.length < headers.length) cells.push("");
      const parts = headers
        .map((header, index) => (cells[index] ? `**${header}**: ${cells[index]}` : ""))
        .filter(Boolean);
      if (parts.length) rows.push(parts.join(" · "));
    }
    return rows.join("\n");
  }

  buildButtonBlocks(text: string, buttons: string[][]): Record<string, any>[] {
    const elements = buttons.flat().filter(Boolean).map((label) => ({
      type: "button",
      text: { type: "plain_text", text: label },
      value: label,
      action_id: `btn_${label}`,
    }));
    return [
      { type: "section", text: { type: "mrkdwn", text } },
      { type: "actions", elements },
    ];
  }

  async send(msg: OutboundMessage): Promise<void> {
    const web = this.webClient;
    if (!web) return;
    const target = await this.resolveTargetChatId(msg.chatId);
    const slackMeta = msg.metadata?.slack ?? {};
    const originChat = String(slackMeta.event?.channel ?? msg.chatId);
    const threadTs = slackMeta.thread_ts && target === originChat ? slackMeta.thread_ts : null;
    const isProgress = Boolean(msg.metadata?.agentProgress);

    if (!(isProgress && !msg.content) && (msg.content || !msg.media.length)) {
      const chunks = splitMessage(this.toMrkdwn(msg.content || " "), SLACK_MAX_MESSAGE_LEN);
      for (const [index, chunk] of chunks.entries()) {
        const kwargs: Record<string, any> = { channel: target, text: chunk, thread_ts: threadTs };
        if (msg.buttons?.length && index === chunks.length - 1) kwargs.blocks = this.buildButtonBlocks(chunk, msg.buttons);
        await web.chatPostMessage(kwargs);
      }
    }

    for (const mediaPath of msg.media ?? []) {
      await web.filesUploadV2?.({ channel: target, file: mediaPath, thread_ts: threadTs });
    }

    if (!isProgress) {
      await this.updateReactEmoji(originChat, slackMeta.event?.ts);
    }
  }

  async resolveTargetChatId(target: string): Promise<string> {
    const cached = this.targetCache.get(target);
    if (cached) return cached;
    const trimmed = target.trim();
    const channelRef = /^<#([A-Z0-9]+)(?:\|[^>]+)?>$/.exec(trimmed);
    if (channelRef) return channelRef[1];
    const userRef = /^<@([A-Z0-9]+)(?:\|[^>]+)?>$/.exec(trimmed);
    if (userRef) return this.openDmForUser(userRef[1]);
    if (/^[CDG][A-Z0-9]{2,}$/.test(trimmed)) return trimmed;
    if (/^[UW][A-Z0-9]{2,}$/.test(trimmed)) return this.openDmForUser(trimmed);
    if (trimmed.startsWith("#")) return this.resolveChannelName(trimmed.slice(1));
    if (trimmed.startsWith("@")) return this.resolveUserHandle(trimmed.slice(1));
    return this.resolveChannelName(trimmed);
  }

  async resolveChannelName(name: string): Promise<string> {
    const web = this.webClient;
    let cursor = "";
    do {
      const response = await web.conversationsList?.({ cursor, limit: 200, exclude_archived: true, types: "public_channel,private_channel" });
      for (const channel of response?.channels ?? []) {
        if (channel.name === name || channel.name_normalized === name || channel.id === name) {
          this.targetCache.set(name, channel.id);
          this.targetCache.set(`#${name}`, channel.id);
          return channel.id;
        }
      }
      cursor = response?.response_metadata?.next_cursor ?? "";
    } while (cursor);
    throw new ValueError(`Slack channel '${name}' was not found`);
  }

  async resolveUserHandle(handle: string): Promise<string> {
    const web = this.webClient;
    let cursor = "";
    do {
      const response = await web.usersList?.({ cursor, limit: 200 });
      for (const member of response?.members ?? []) {
        const display = member.profile?.display_name;
        if (member.name === handle || display === handle || member.id === handle) {
          return this.openDmForUser(member.id);
        }
      }
      cursor = response?.response_metadata?.next_cursor ?? "";
    } while (cursor);
    throw new ValueError(`Slack user '${handle}' was not found`);
  }

  async openDmForUser(userId: string): Promise<string> {
    const cached = this.targetCache.get(`@${userId}`);
    if (cached) return cached;
    const response = await this.webClient.conversationsOpen({ users: userId });
    const id = response?.channel?.id;
    if (!id) throw new ValueError(`Slack DM for '${userId}' was not opened`);
    this.targetCache.set(`@${userId}`, id);
    this.targetCache.set(userId, id);
    return id;
  }

  async updateReactEmoji(channel: string, ts?: string | null): Promise<void> {
    if (!channel || !ts) return;
    const web = this.webClient;
    if (!web) return;
    await web.reactionsRemove?.({ channel, name: this.config.reactEmoji, timestamp: ts });
    await web.reactionsAdd?.({ channel, name: this.config.doneEmoji, timestamp: ts });
  }

  async withThreadContext(content: string, chatId: string, channelType: string, threadTs?: string | null, rawThreadTs?: string | null, currentTs?: string | null): Promise<string> {
    if (!this.config.includeThreadContext || !rawThreadTs || !threadTs || threadTs === currentTs) return content;
    const key = `${chatId}:${threadTs}`;
    if (this.threadContextAttempted.has(key)) return content;
    if (this.threadContextAttempted.size >= THREAD_CONTEXT_CACHE_LIMIT) this.threadContextAttempted.clear();
    this.threadContextAttempted.add(key);
    let response: any;
    try {
      response = await this.webClient?.conversationsReplies?.({
        channel: chatId,
        ts: rawThreadTs ?? threadTs,
        limit: Math.max(1, this.config.threadContextLimit),
      });
    } catch {
      return content;
    }
    const lines: string[] = [];
    for (const msg of response?.messages ?? []) {
      if (msg.ts === currentTs) continue;
      if (msg.subtype) continue;
      const user = msg.user === this.botUserId ? "bot" : `<@${msg.user}>`;
      let text = String(msg.text ?? "").trim();
      if (!text) continue;
      text = this.stripBotMention(text);
      if (text.length > 500) text = `${text.slice(0, 500)}…`;
      lines.push(`- ${user}: ${text}`);
    }
    if (!lines.length) return content;
    return `Slack thread context before this mention:\n${lines.join("\n")}\n\nCurrent message:\n${content}`;
  }

  isSlackAllowed(senderId: string, chatId = "", channelType = "channel"): boolean {
    if (channelType === "im") {
      if (!this.config.dm.enabled) return false;
      if (this.config.dm.policy === "allowlist") return this.config.dm.allowFrom.includes(senderId) || this.baseSenderAllowed(senderId);
      return true;
    }
    if (this.config.groupPolicy === "allowlist") {
      return this.config.groupAllowFrom.includes(chatId);
    }
    if (this.config.allowFrom.length === 0) return true;
    return this.baseSenderAllowed(senderId);
  }

  baseSenderAllowed(senderId: string): boolean {
    return BaseChannel.prototype.isAllowed.call(this, senderId);
  }

  override isAllowed(senderId: string): boolean {
    void senderId;
    return true;
  }

  inferChannelType(chatId: string): string {
    if (chatId.startsWith("D")) return "im";
    if (chatId.startsWith("G")) return "group";
    return "channel";
  }

  static looksLikeHtmlDownload(response: any): boolean {
    const contentType = String(valueOf(response, "headers", {})?.["content-type"] ?? valueOf(response, "headers", {})?.get?.("content-type") ?? "").toLowerCase();
    const content = Buffer.isBuffer(response?.content) ? response.content : Buffer.from(response?.content ?? "");
    const head = content.subarray(0, 32).toString("utf8").trimStart().toLowerCase();
    return contentType.includes("text/html") || head.startsWith("<!doctype html") || head.startsWith("<html");
  }

  static downloadFailureMarker(kind: string, filename: string, reason: string): string {
    return `[${kind}: ${filename} not available to memmy-agent (${reason}). Ensure Slack files:read is granted and reinstall the Slack app.]`;
  }

  shouldRespondInChannel(eventType: string, text: string, chatId: string): boolean {
    if (this.config.groupPolicy === "open") return true;
    if (this.config.groupPolicy === "allowlist") return this.config.groupAllowFrom.includes(chatId);
    if (eventType === "app_mention") return true;
    return Boolean(this.botUserId && text.includes(`<@${this.botUserId}>`));
  }

  stripBotMention(text: string): string {
    const bot = this.botUserId;
    if (!text || !bot) return text;
    return text.replace(new RegExp(`<@${bot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>\\s*`, "g"), "").trim();
  }

  async downloadSlackFile(fileInfo: Record<string, any>): Promise<[string | null, string]> {
    const fileId = String(fileInfo.id ?? "file");
    const name = String(fileInfo.name ?? fileInfo.title ?? fileInfo.id ?? "slack-file");
    const markerType = String(fileInfo.mimetype ?? "").startsWith("image/") ? "image" : "file";
    const marker = `[${markerType}: ${name}]`;
    const url = String(fileInfo.url_private_download ?? fileInfo.url_private ?? "");
    if (!url) return [null, SlackChannel.downloadFailureMarker(markerType, name, "missing download url")];
    if (!this.config.botToken) return [null, SlackChannel.downloadFailureMarker(markerType, name, "missing bot token")];
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SLACK_DOWNLOAD_TIMEOUT * 1000);
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.config.botToken}` },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const content = Buffer.from(await response.arrayBuffer());
      if (SlackChannel.looksLikeHtmlDownload({ headers: response.headers, content })) throw new Error("Slack returned HTML instead of file content");
      const safe = `${fileId}_${name}`.replace(/[^A-Za-z0-9_.-]+/g, "_");
      const dir = getMediaDir("slack");
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, safe);
      fs.writeFileSync(filePath, content);
      return [filePath, marker];
    } catch {
      return [null, SlackChannel.downloadFailureMarker(markerType, name, "download failed")];
    }
  }

  async onSocketRequest(client: any, req: any): Promise<void> {
    if (req?.type === "interactive") return this.onBlockAction(client, req);
    if (req?.type !== "events_api") return;
    await client?.sendSocketModeResponse?.({ envelope_id: req.envelope_id });
    const event = req.payload?.event ?? {};
    const eventType = event.type;
    if (!["message", "app_mention"].includes(eventType)) return;
    const senderId = event.user;
    const chatId = event.channel;
    const subtype = event.subtype;
    if (subtype && subtype !== "file_share") return;
    if (this.botUserId && senderId === this.botUserId) return;
    let text = String(event.text ?? "");
    if (eventType === "message" && this.botUserId && text.includes(`<@${this.botUserId}>`)) return;
    if (!senderId || !chatId) return;
    const channelType = String(event.channel_type ?? "");
    if (!this.isSlackAllowed(senderId, chatId, channelType)) {
      if (channelType === "im" && this.config.dm.enabled) {
        await (this as any).handleMessage({ senderId, chatId, content: "", isDm: true });
      }
      return;
    }
    if (channelType !== "im" && !this.shouldRespondInChannel(eventType, text, chatId)) return;
    text = this.stripBotMention(text);
    const eventTs = event.ts ?? null;
    const rawThreadTs = event.thread_ts ?? null;
    let threadTs = rawThreadTs;
    if (this.config.replyInThread && !threadTs && channelType !== "im") threadTs = eventTs;
    try {
      if (this.webClient && eventTs) {
        await this.webClient.reactionsAdd?.({ channel: chatId, name: this.config.reactEmoji, timestamp: eventTs });
      }
    } catch {
      // Reactions are best-effort and should never block message handling.
    }
    const sessionKey = threadTs && rawThreadTs ? `slack:${chatId}:${threadTs}` : null;
    const media: string[] = [];
    const markers: string[] = [];
    for (const fileInfo of event.files ?? []) {
      if (!fileInfo || typeof fileInfo !== "object") continue;
      const [filePath, marker] = await this.downloadSlackFile(fileInfo);
      if (filePath) media.push(filePath);
      if (marker) markers.push(marker);
    }
    const slash = text.trim().startsWith("/");
    let content = slash
      ? text
      : await this.withThreadContext(text, chatId, channelType, threadTs, rawThreadTs, eventTs);
    if (markers.length) content = [content, ...markers].filter(Boolean).join("\n");
    if (!content && !media.length) return;
    await (this as any).handleMessage({
      senderId,
      chatId,
      content,
      media,
      metadata: { slack: { event, thread_ts: threadTs, channel_type: channelType } },
      sessionKey,
    });
  }

  async onBlockAction(client: any, req: any): Promise<void> {
    await client?.sendSocketModeResponse?.({ envelope_id: req?.envelope_id });
    const payload = req?.payload ?? {};
    const actions = payload.actions ?? [];
    if (!actions.length) return;
    const value = String(actions[0]?.value ?? "");
    const senderId = String(payload.user?.id ?? "");
    const chatId = String(payload.channel?.id ?? "");
    if (!senderId || !chatId || !value) return;
    const messageInfo = payload.message ?? {};
    const threadTs = messageInfo.thread_ts ?? messageInfo.ts ?? null;
    const channelType = this.inferChannelType(chatId);
    if (!this.isSlackAllowed(senderId, chatId, channelType)) return;
    const sessionKey = threadTs ? `slack:${chatId}:${threadTs}` : null;
    await (this as any).handleMessage({
      senderId,
      chatId,
      content: value,
      metadata: { slack: { thread_ts: threadTs, channel_type: channelType } },
      sessionKey,
    });
  }
}

export class ValueError extends Error {}
