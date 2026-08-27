import fs from "node:fs";
import path from "node:path";
import { BaseChannel } from "./base.js";
import { OutboundMessage } from "../../core/runtime-messages/index.js";
import { getMediaDir } from "../../config/paths.js";

export const MSG_TYPE_MAP: Record<string, string> = {
  image: "[image]",
  audio: "[audio]",
  file: "[file]",
  sticker: "[sticker]",
};

const FEISHU_IMAGE_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".webp",
  ".ico",
  ".tiff",
  ".tif",
]);
const FEISHU_AUDIO_EXTS = new Set([".opus"]);
const FEISHU_VIDEO_EXTS = new Set([".mp4", ".mov", ".avi"]);
const FEISHU_FILE_TYPE_MAP: Record<string, string> = {
  ".opus": "opus",
  ".mp4": "mp4",
  ".pdf": "pdf",
  ".doc": "doc",
  ".docx": "doc",
  ".xls": "xls",
  ".xlsx": "xls",
  ".ppt": "ppt",
  ".pptx": "ppt",
};

export function extractShareCardContent(contentJson: Record<string, any>, msgType: string): string {
  if (msgType === "share_chat") return `[shared chat: ${contentJson.chat_id ?? ""}]`;
  if (msgType === "share_user") return `[shared user: ${contentJson.user_id ?? ""}]`;
  if (msgType === "interactive") return extractInteractiveContent(contentJson).join("\n");
  if (msgType === "share_calendar_event")
    return `[shared calendar event: ${contentJson.event_key ?? ""}]`;
  if (msgType === "system") return "[system message]";
  if (msgType === "merge_forward") return "[merged forward messages]";
  return `[${msgType}]`;
}

export function extractInteractiveContent(raw: any): string[] {
  let content = raw;
  if (typeof content === "string") {
    try {
      content = JSON.parse(content);
    } catch {
      return content.trim() ? [content] : [];
    }
  }
  if (!content || typeof content !== "object" || Array.isArray(content)) return [];
  const parts: string[] = [];
  const title = content.title;
  if (typeof title === "string" && title) parts.push(`title: ${title}`);
  else if (title && typeof title === "object") {
    const text = title.content ?? title.text;
    if (text) parts.push(`title: ${text}`);
  }
  const elements = Array.isArray(content.elements) ? content.elements : [];
  for (const row of elements) {
    if (Array.isArray(row))
      for (const element of row) parts.push(...extractElementContent(element));
    else parts.push(...extractElementContent(row));
  }
  if (content.card) parts.push(...extractInteractiveContent(content.card));
  const headerTitle = content.header?.title;
  const headerText = headerTitle?.content ?? headerTitle?.text;
  if (headerText) parts.push(`title: ${headerText}`);
  return parts;
}

export function extractElementContent(element: any): string[] {
  if (!element || typeof element !== "object" || Array.isArray(element)) return [];
  const tag = element.tag ?? "";
  const parts: string[] = [];
  if (tag === "markdown" || tag === "lark_md") {
    if (element.content) parts.push(String(element.content));
  } else if (tag === "div") {
    const text = element.text;
    const content = typeof text === "string" ? text : (text?.content ?? text?.text);
    if (content) parts.push(String(content));
    for (const field of element.fields ?? []) {
      const fieldText = field?.text;
      const fieldContent =
        typeof fieldText === "string" ? fieldText : (fieldText?.content ?? fieldText?.text);
      if (fieldContent) parts.push(String(fieldContent));
    }
  } else if (tag === "a") {
    if (element.href) parts.push(`link: ${element.href}`);
    if (element.text) parts.push(String(element.text));
  } else if (tag === "button") {
    const text = element.text;
    const content = typeof text === "string" ? text : (text?.content ?? text?.text);
    if (content) parts.push(String(content));
    const url = element.url ?? element.multi_url?.url;
    if (url) parts.push(`link: ${url}`);
  } else if (tag === "img") {
    parts.push(element.alt?.content ?? "[image]");
  } else if (tag === "plain_text") {
    if (element.content) parts.push(String(element.content));
  }
  for (const nested of element.elements ?? []) parts.push(...extractElementContent(nested));
  for (const column of element.columns ?? [])
    for (const nested of column.elements ?? []) parts.push(...extractElementContent(nested));
  return parts;
}

export function extractPostContent(contentJson: any): [string, string[]] {
  const root = contentJson.post ? (Object.values(contentJson.post)[0] as any) : contentJson;
  const parts: string[] = [];
  const imageKeys: string[] = [];
  if (root.title) parts.push(String(root.title));
  for (const row of root.content ?? []) {
    for (const item of row ?? []) {
      if (item.tag === "text" && item.text) parts.push(String(item.text));
      if (item.tag === "a" && item.text) parts.push(String(item.text));
      if (item.tag === "at") parts.push(`@${item.user_name ?? "user"}`);
      if (item.tag === "code_block")
        parts.push(`\n\`\`\`${item.language ?? ""}\n${item.text ?? ""}\n\`\`\`\n`);
      if (item.tag === "img" && item.image_key) imageKeys.push(String(item.image_key));
    }
  }
  return [parts.join(" ").trim(), imageKeys];
}

export function extractPostText(contentJson: any): string {
  return extractPostContent(contentJson)[0];
}

export class FeishuConfig {
  enabled = false;
  appId = "";
  appSecret = "";
  encryptKey = "";
  verificationToken = "";
  domain: "feishu" | "lark" = "feishu";
  replyToMessage = false;
  topicIsolation = true;
  streaming = true;
  allowFrom: string[] = [];
  groupPolicy = "mention";
  reactEmoji = "THUMBSUP";
  doneEmoji: string | null = null;
  toolHintPrefix = "🔧";
  clientFactory?: ((config: FeishuConfig) => Promise<any> | any) | null;

  static fromObject(data: Partial<FeishuConfig> = {}): FeishuConfig {
    return new FeishuConfig(data);
  }

  constructor(init: Partial<FeishuConfig> = {}) {
    this.enabled = init.enabled ?? this.enabled;
    this.appId = init.appId ?? this.appId;
    this.appSecret = init.appSecret ?? this.appSecret;
    this.encryptKey = init.encryptKey ?? this.encryptKey;
    this.verificationToken = init.verificationToken ?? this.verificationToken;
    this.domain = init.domain === "lark" ? "lark" : "feishu";
    this.replyToMessage = init.replyToMessage ?? this.replyToMessage;
    this.topicIsolation = init.topicIsolation ?? this.topicIsolation;
    this.streaming = init.streaming ?? this.streaming;
    this.allowFrom = Array.isArray(init.allowFrom) ? init.allowFrom.map(String) : this.allowFrom;
    this.groupPolicy = init.groupPolicy ?? this.groupPolicy;
    this.reactEmoji = init.reactEmoji ?? this.reactEmoji;
    this.doneEmoji = init.doneEmoji ?? null;
    this.toolHintPrefix = init.toolHintPrefix ?? this.toolHintPrefix;
    this.clientFactory = init.clientFactory ?? null;
  }

  toObject(): Record<string, any> {
    return {
      enabled: this.enabled,
      appId: this.appId,
      appSecret: this.appSecret,
      encryptKey: this.encryptKey,
      verificationToken: this.verificationToken,
      domain: this.domain,
      replyToMessage: this.replyToMessage,
      topicIsolation: this.topicIsolation,
      streaming: this.streaming,
      allowFrom: this.allowFrom,
      groupPolicy: this.groupPolicy,
      reactEmoji: this.reactEmoji,
      doneEmoji: this.doneEmoji,
      toolHintPrefix: this.toolHintPrefix,
    };
  }
}

export class FeishuChannel extends BaseChannel {
  static REPLY_CONTEXT_MAX_LEN = 200;
  static STREAM_EDIT_INTERVAL = 0.5;
  override config: FeishuConfig;
  botOpenId: string | null = null;
  client: any = null;
  // lastError is provided by BaseChannel for insufficient permissions and other user-actionable errors exposed to the frontend.
  /** Deduplicates printed error messages to avoid repeatedly logging the same streaming delta error. */
  loggedErrorMessages = new Set<string>();
  streamBuffers: Record<string, any> = {};
  reactionIds: Record<string, string> = {};
  processedMessageIds = new Map<string, null>();
  backgroundTasks = new Set<Promise<any>>();
  loop: any = null;
  wsClient: any = null;
  wsEventDispatcher: any = null;

  constructor(config: any = {}, bus?: any) {
    const normalized = config instanceof FeishuConfig ? config : new FeishuConfig(config);
    super("feishu", normalized, bus);
    this.config = normalized;
  }
  static override defaultConfig(): Record<string, any> {
    return new FeishuConfig().toObject();
  }
  override get supportsStreaming(): boolean {
    return Boolean(this.config.streaming);
  }
  static safeMediaFilename(filename: string | null | undefined, fallback: string): string {
    const base = path.basename(filename || fallback).replace(/[^\w.-]/g, "_");
    return base || fallback;
  }
  static registerOptionalEvent(builder: any, methodName: string, handler: any): any {
    return typeof builder?.[methodName] === "function" ? builder[methodName](handler) : builder;
  }
  static stripMarkdownFormatting(text: string): string {
    return text
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/__(.+?)__/g, "$1")
      .replace(/\*(.+?)\*/g, "$1")
      .replace(/~~(.+?)~~/g, "$1")
      .replace(/`([^`]+)`/g, "$1");
  }
  static detectMessageFormat(content: string): string {
    const stripped = content.trim();
    if (/```|^\s*#{1,6}\s+|^\s*\|.+\|\s*\n\s*\|[-:\s|]+\|/m.test(stripped)) return "interactive";
    if (stripped.length > 2000) return "interactive";
    if (/\*\*.+?\*\*|__.+?__|(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)|~~.+?~~/s.test(stripped))
      return "interactive";
    if (/^[\s]*[-*+]\s+|^[\s]*\d+\.\s+/m.test(stripped)) return "interactive";
    if (/\[[^\]]+]\([^)]+\)/.test(content)) return "post";
    if (stripped.length > 200) return "post";
    return "text";
  }
  static markdownToPost(content: string): string {
    return JSON.stringify({
      post: {
        zh_cn: {
          title: "",
          content: content
            .split(/\r?\n/)
            .map((line) => [{ tag: "text", text: this.stripMarkdownFormatting(line) }]),
        },
      },
    });
  }
  static resolveMentions(text: string, mentions: any[] | null | undefined): string {
    if (!text || !mentions?.length) return text;
    let result = text;
    for (const mention of mentions) {
      const key = mention?.key;
      if (!key || !result.includes(key)) continue;
      const id = mention.id ?? {};
      const openId = id.open_id ?? mention.open_id ?? "";
      const userId = id.user_id ?? mention.user_id ?? "";
      if (!openId && !userId) continue;
      const label = `@${mention.name ?? key}${openId ? ` (${openId}${userId ? `, user id: ${userId}` : ""})` : ` (user id: ${userId})`}`;
      result = result.replaceAll(key, label);
    }
    return result;
  }
  isBotMentioned(message: any): boolean {
    const rawContent = message?.content ?? "";
    if (typeof rawContent === "string" && rawContent.includes("@_all")) return true;
    const mentions = message?.mentions ?? [];
    if (!mentions.length) return false;
    for (const mention of mentions) {
      if (mention?.id?.open_id === "all" || mention?.key === "@_all") return true;
      const openId = mention?.id?.open_id ?? mention?.open_id ?? "";
      const userId = mention?.id?.user_id ?? mention?.user_id ?? "";
      if (this.botOpenId && openId === this.botOpenId) return true;
      if (!this.botOpenId && openId.startsWith("ou_") && !userId) return true;
    }
    return false;
  }
  isGroupMessageForBot(message: any): boolean {
    if (this.config.groupPolicy === "open") return true;
    return this.isBotMentioned(message);
  }
  static parseMarkdownTable(tableText: string): Record<string, any> | null {
    const rows = tableText
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (rows.length < 3) return null;
    const split = (line: string) =>
      line
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => this.stripMarkdownFormatting(cell.trim()));
    const headers = split(rows[0]);
    if (!split(rows[1]).every((cell) => /^:?-+:?$/.test(cell))) return null;
    return {
      tag: "table",
      columns: headers.map((name, index) => ({
        data_type: "text",
        name: `col_${index}`,
        display_name: name,
      })),
      rows: rows
        .slice(2)
        .map((line) =>
          Object.fromEntries(split(line).map((cell, index) => [`col_${index}`, cell])),
        ),
    };
  }
  static splitElementsByTableLimit(
    elements: Record<string, any>[],
    maxTables = 1,
  ): Record<string, any>[][] {
    if (!elements.length) return [[]];
    const groups: Record<string, any>[][] = [[]];
    let tables = 0;
    for (const element of elements) {
      if (element.tag === "table" && tables >= maxTables) {
        groups.push([]);
        tables = 0;
      }
      groups[groups.length - 1].push(element);
      if (element.tag === "table") tables += 1;
    }
    return groups;
  }
  buildCardElements(content: string): Record<string, any>[] {
    const tableRe =
      /((?:^[ \t]*\|.+\|[ \t]*\n)(?:^[ \t]*\|[-:\s|]+\|[ \t]*\n)(?:^[ \t]*\|.+\|[ \t]*\n?)+)/gm;
    const elements: Record<string, any>[] = [];
    let lastEnd = 0;
    for (const match of content.matchAll(tableRe)) {
      const before = content.slice(lastEnd, match.index).trim();
      if (before) elements.push(...this.splitHeadings(before));
      elements.push(
        FeishuChannel.parseMarkdownTable(match[1]) ?? { tag: "markdown", content: match[1] },
      );
      lastEnd = (match.index ?? 0) + match[0].length;
    }
    const remaining = content.slice(lastEnd).trim();
    if (remaining) elements.push(...this.splitHeadings(remaining));
    return elements.length ? elements : [{ tag: "markdown", content }];
  }
  splitHeadings(content: string): Record<string, any>[] {
    const codeBlocks: string[] = [];
    let protectedText = content.replace(/```[\s\S]*?```/g, (block) => {
      codeBlocks.push(block);
      return `\0CODE${codeBlocks.length - 1}\0`;
    });
    const elements: Record<string, any>[] = [];
    let lastEnd = 0;
    for (const match of protectedText.matchAll(/^(#{1,6})\s+(.+)$/gm)) {
      const before = protectedText.slice(lastEnd, match.index).trim();
      if (before) elements.push({ tag: "markdown", content: before });
      const text = FeishuChannel.stripMarkdownFormatting(match[2].trim());
      elements.push({ tag: "div", text: { tag: "lark_md", content: text ? `**${text}**` : "" } });
      lastEnd = (match.index ?? 0) + match[0].length;
    }
    const remaining = protectedText.slice(lastEnd).trim();
    if (remaining) elements.push({ tag: "markdown", content: remaining });
    for (const [idx, block] of codeBlocks.entries()) {
      protectedText = `\0CODE${idx}\0`;
      for (const element of elements) {
        if (element.tag === "markdown")
          element.content = String(element.content).replace(protectedText, block);
      }
    }
    return elements.length ? elements : [{ tag: "markdown", content }];
  }
  addReactionSync(messageId: string, emojiType: string): string | null {
    try {
      const response = this.client?.im?.v1?.message_reaction?.create?.({ messageId, emojiType });
      if (!isSuccessfulResponse(response)) return null;
      return response?.data?.reaction_id ?? response?.data?.reactionId ?? null;
    } catch {
      return null;
    }
  }
  async addReaction(messageId: string, emojiType = this.config.reactEmoji): Promise<string | null> {
    if (!this.client) return null;
    return this.addReactionSync(messageId, emojiType);
  }
  removeReactionSync(messageId: string, reactionId: string): void {
    try {
      this.client?.im?.v1?.message_reaction?.delete?.({ messageId, reactionId });
    } catch {
      // best effort cleanup
    }
  }
  async removeReaction(messageId: string, reactionId: string | null | undefined): Promise<void> {
    if (!this.client || !reactionId) return;
    this.removeReactionSync(messageId, reactionId);
  }
  async onBackgroundTaskDone(task: Promise<any>): Promise<void> {
    try {
      await task;
    } catch {
      // background reaction failures are best effort
    } finally {
      this.backgroundTasks.delete(task);
    }
  }
  async onReactionAdded(
    messageId: string,
    task: Promise<string | null | undefined>,
  ): Promise<void> {
    try {
      const reactionId = await task;
      if (reactionId) this.reactionIds[messageId] = reactionId;
      const keys = Object.keys(this.reactionIds);
      if (keys.length > 500) delete this.reactionIds[keys[0]];
    } catch {
      // failures are handled by onBackgroundTaskDone
    }
  }
  override async start(): Promise<void> {
    if (!this.config.appId || !this.config.appSecret) {
      throw new Error("Feishu 渠道需要 App ID 和 App Secret");
    }
    if (!this.client) {
      const factory = this.config.clientFactory;
      this.client =
        typeof factory === "function"
          ? await factory(this.config)
          : await this.createDefaultClient();
    }
    // Validate credentials against Feishu so arbitrary input is not misreported as a successful connection.
    await this.verifyCredentials();
    if (!this.wsClient) this.wsClient = await this.createDefaultWsClient();
    if (!this.wsClient) {
      throw new Error("Feishu 事件订阅客户端不可用，无法建立 websocket 连接");
    }
    // A failed event-subscription long connection is also a connection failure because the bot cannot receive messages.
    await this.wsClient.start(
      this.wsEventDispatcher ? { eventDispatcher: this.wsEventDispatcher } : undefined,
    );
    this.running = true;
    this.botOpenId = await this.fetchBotOpenId();
  }

  /**
   * Call the Feishu tenant auth endpoint to verify whether App ID/App Secret are valid.
   *
   * @throws When credentials are invalid, Feishu returns a non-zero code, or the request fails; callers use this to mark connection failure.
   */
  async verifyCredentials(): Promise<void> {
    let response: any;
    try {
      response = await this.client.request({
        method: "POST",
        url: "/open-apis/auth/v3/tenant_access_token/internal",
        data: { app_id: this.config.appId, app_secret: this.config.appSecret },
      });
    } catch (error: any) {
      throw new Error(`Feishu 凭证校验失败：${error?.message ?? String(error)}`);
    }

    const payload = response?.data ?? response;
    const code =
      typeof payload?.code === "number"
        ? payload.code
        : typeof response?.code === "number"
          ? response.code
          : undefined;
    const hasToken = Boolean(payload?.tenant_access_token ?? response?.tenant_access_token);
    if (code === 0 || (code === undefined && hasToken)) {
      return;
    }
    const message = payload?.msg ?? response?.msg ?? "App ID 或 App Secret 无效";
    throw new Error(`Feishu 凭证校验失败：${message}`);
  }

  async createDefaultClient(): Promise<any> {
    const lark = await import("@larksuiteoapi/node-sdk");
    const domain = this.config.domain === "lark" ? lark.Domain?.Lark : lark.Domain?.Feishu;
    return new lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      appType: lark.AppType?.SelfBuild,
      domain,
      // The SDK logger dumps full axios error objects and floods logs; reportEventError logs errors instead.
      // Keep the SDK logger at fatal so only fatal logs remain.
      loggerLevel: lark.LoggerLevel?.fatal,
    });
  }

  async createDefaultWsClient(): Promise<any> {
    const lark = await import("@larksuiteoapi/node-sdk");
    const WsClient = (lark as any).WSClient ?? (lark as any).ws?.Client;
    if (!WsClient) return null;
    const client = new WsClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });
    this.wsEventDispatcher = this.createWsEventDispatcher(lark);
    client.on?.("event", (event: any) => {
      void this.safeOnMessage(event);
    });
    return client;
  }
  override async stop(): Promise<void> {
    this.running = false;
    if (typeof this.wsClient?.close === "function") await this.wsClient.close();
    this.wsClient = null;
    this.wsEventDispatcher = null;
  }

  createWsEventDispatcher(lark: any): any {
    const handleMessage = (event: any) => {
      void this.safeOnMessage(event);
    };
    if (typeof lark.EventDispatcher !== "function") {
      return { invoke: handleMessage };
    }

    // Current Lark SDK WSClient.start only accepts EventDispatcher and no longer triggers the legacy client.on("event").
    const dispatcher = new lark.EventDispatcher({
      verificationToken: this.config.verificationToken,
      encryptKey: this.config.encryptKey,
    });
    dispatcher.register?.({
      "im.message.receive_v1": handleMessage,
    });
    return dispatcher;
  }
  /**
   * Fetch the bot's own open_id.
   *
   * client.request is async and must be awaited and caught. Otherwise, as in the
   * previous implementation, it returns a Promise, botOpenId stays null, and
   * startup network errors such as ECONNRESET become unhandled rejections that
   * crash the gateway. The axios config field is url, not uri.
   */
  async fetchBotOpenId(): Promise<string | null> {
    try {
      const response = await this.client?.request?.({
        method: "GET",
        url: "/open-apis/bot/v3/info",
      });
      const raw = response?.raw?.content ?? response?.body ?? response;
      const data = typeof raw === "string" ? JSON.parse(raw) : raw;
      return data?.data?.bot?.open_id ?? data?.bot?.open_id ?? null;
    } catch (error) {
      this.reportEventError(error);
      return null;
    }
  }
  static streamKey(chatId: string, metadata: Record<string, any> | null = null): string {
    return String(metadata?.message_id ?? chatId);
  }
  /**
   * Upload an image and return image_key.
   *
   * Feishu SDK im.v1.image.create is async and reads upload fields only from
   * payload.data, which axios then uses to build the multipart form. If
   * image_type/image are placed at the top level, data is empty, producing an
   * empty request body (Content-Length: 0) and Feishu 400. It must also be
   * awaited; otherwise the Promise is treated as a synchronous result, image_key
   * is missing on success, and failures escape as unhandled rejections that crash
   * the gateway.
   */
  async uploadImage(filePath: string): Promise<string | null> {
    try {
      const response = await this.client?.im?.v1?.image?.create?.({
        data: {
          image_type: "message",
          image: fs.createReadStream(filePath),
        },
      });
      if (!isSuccessfulResponse(response)) return null;
      return response?.data?.image_key ?? response?.image_key ?? null;
    } catch (error) {
      this.reportEventError(error);
      return null;
    }
  }
  async uploadFile(filePath: string): Promise<string | null> {
    try {
      const ext = path.extname(filePath).toLowerCase();
      const fileType = FEISHU_FILE_TYPE_MAP[ext] ?? "stream";
      const response = await this.client?.im?.v1?.file?.create?.({
        data: {
          file_type: fileType,
          file_name: path.basename(filePath),
          file: fs.createReadStream(filePath),
        },
      });
      if (!isSuccessfulResponse(response)) return null;
      return response?.data?.file_key ?? response?.file_key ?? null;
    } catch (error) {
      this.reportEventError(error);
      return null;
    }
  }
  downloadImageSync(messageId: string, imageKey: string): [Buffer | null, string | null] {
    return this.downloadResourceSync(messageId, imageKey, "image");
  }
  downloadFileSync(
    messageId: string,
    fileKey: string,
    resourceType = "file",
  ): [Buffer | null, string | null] {
    return this.downloadResourceSync(
      messageId,
      fileKey,
      resourceType === "audio" || resourceType === "media" ? "file" : resourceType,
    );
  }
  private downloadResourceSync(
    messageId: string,
    fileKey: string,
    resourceType: string,
  ): [Buffer | null, string | null] {
    try {
      const response = this.client?.im?.v1?.message_resource?.get?.({
        message_id: messageId,
        file_key: fileKey,
        type: resourceType,
      });
      if (!isSuccessfulResponse(response)) return [null, null];
      const file = response?.file ?? response?.data ?? null;
      const data = Buffer.isBuffer(file)
        ? file
        : typeof file?.read === "function"
          ? Buffer.from(file.read())
          : file?.bytes
            ? Buffer.from(file.bytes)
            : null;
      return [data, response?.file_name ?? response?.filename ?? null];
    } catch {
      return [null, null];
    }
  }
  async downloadAndSaveMedia(
    msgType: string,
    contentJson: Record<string, any>,
    messageId: string | null = null,
  ): Promise<[string | null, string]> {
    fs.mkdirSync(getMediaDir("feishu"), { recursive: true });
    let data: Buffer | null = null;
    let filename: string | null = null;
    let fallback = cryptoLikeId();
    if (msgType === "image") {
      const imageKey = contentJson.image_key;
      if (imageKey && messageId) {
        fallback = `${String(imageKey).slice(0, 16)}.jpg`;
        [data, filename] = this.downloadImageSync(messageId, imageKey);
      }
    } else if (["audio", "file", "media"].includes(msgType)) {
      const fileKey = contentJson.file_key;
      if (!fileKey) return [null, `[${msgType}: missing file_key]`];
      if (!messageId) return [null, `[${msgType}: missing message_id]`];
      fallback = String(fileKey).slice(0, 16);
      [data, filename] = this.downloadFileSync(messageId, fileKey, msgType);
      if (!data) return [null, `[${msgType}: download failed]`];
      if (!filename) filename = fallback;
      if (msgType === "audio" && !/\.(opus|ogg|oga)$/i.test(filename)) filename = `${filename}.ogg`;
    }
    if (!data) return [null, `[${msgType}: download failed]`];
    const safeName = FeishuChannel.safeMediaFilename(filename, fallback);
    const target = path.join(getMediaDir("feishu"), safeName);
    fs.writeFileSync(target, data);
    return [target, `[${msgType}: ${target}]`];
  }
  getMessageContentSync(messageId: string): string | null {
    try {
      const response = this.client?.im?.v1?.message?.get?.({ message_id: messageId });
      if (!isSuccessfulResponse(response)) return null;
      const item = response?.data?.items?.[0] ?? response?.items?.[0];
      const raw = item?.body?.content ?? item?.content;
      if (!raw) return null;
      const contentJson = typeof raw === "string" ? JSON.parse(raw) : raw;
      const msgType = item?.msg_type ?? item?.message_type ?? "";
      let text = "";
      if (msgType === "text") text = contentJson.text ?? "";
      else if (msgType === "post") text = extractPostText(contentJson);
      text = String(text).trim();
      return text
        ? `[Reply to: ${text.length > FeishuChannel.REPLY_CONTEXT_MAX_LEN ? `${text.slice(0, FeishuChannel.REPLY_CONTEXT_MAX_LEN)}...` : text}]`
        : null;
    } catch {
      return null;
    }
  }
  replyMessageSync(
    parentMessageId: string,
    msgType: string,
    content: string,
    { replyInThread = false }: { replyInThread?: boolean } = {},
  ): boolean {
    try {
      const response = this.client?.im?.v1?.message?.reply?.({
        path: { message_id: parentMessageId },
        data: { msg_type: msgType, content, reply_in_thread: replyInThread },
        message_id: parentMessageId,
        msg_type: msgType,
        content,
        reply_in_thread: replyInThread,
        request_body: {
          msg_type: msgType,
          content,
          reply_in_thread: replyInThread,
        },
      });
      if (isPromiseLike(response)) {
        response.catch((error: unknown) => this.reportEventError(error));
        return true;
      }
      return isSuccessfulResponse(response);
    } catch (error) {
      this.reportEventError(error);
      return false;
    }
  }
  shouldUseReplyInThread(metadata: Record<string, any>): boolean {
    return metadata.chat_type === "group" && this.config.replyToMessage;
  }
  threadReplyTarget(metadata: Record<string, any>): string | null {
    if (metadata.chat_type !== "group") return null;
    const messageId = metadata.message_id;
    if (!messageId) return null;
    if (metadata.thread_id || this.config.replyToMessage) return messageId;
    return null;
  }
  sendMessageSync(
    receiveIdType: string,
    receiveId: string,
    msgType: string,
    content: string,
  ): string | null {
    try {
      const response = this.client?.im?.v1?.message?.create?.({
        params: { receive_id_type: receiveIdType },
        data: { receive_id: receiveId, msg_type: msgType, content },
        receive_id_type: receiveIdType,
        receive_id: receiveId,
        msg_type: msgType,
        content,
        request_body: {
          receive_id: receiveId,
          msg_type: msgType,
          content,
        },
      });
      if (isPromiseLike(response)) {
        response.catch((error: unknown) => this.reportEventError(error));
        return null;
      }
      if (!isSuccessfulResponse(response)) return null;
      return response?.data?.message_id ?? response?.message_id ?? null;
    } catch (error) {
      this.reportEventError(error);
      return null;
    }
  }
  formatToolHintDelta(toolHint: string): string {
    return FeishuChannel.formatToolHintLines(toolHint)
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => `${this.config.toolHintPrefix} ${line}`)
      .join("\n");
  }
  createStreamingCardSync(
    receiveIdType: string,
    chatId: string,
    replyMessageId: string | null = null,
    { replyInThread = false }: { replyInThread?: boolean } = {},
  ): string | null {
    try {
      const data = JSON.stringify({
        schema: "2.0",
        config: { width_mode: "fill", update_multi: true, streaming_mode: true },
        body: { elements: [{ tag: "markdown", content: "", element_id: "streaming_md" }] },
      });
      const response = this.client?.cardkit?.v1?.card?.create?.({
        data: { type: "card_json", data },
      });
      if (isPromiseLike(response)) {
        response.catch((error: unknown) => this.reportEventError(error));
        return null;
      }
      if (!isSuccessfulResponse(response)) return null;
      const cardId = response?.data?.card_id ?? response?.card_id ?? null;
      if (!cardId) return null;
      const content = JSON.stringify({ type: "card", data: { card_id: cardId } });
      const sent = replyMessageId
        ? this.replyMessageSync(replyMessageId, "interactive", content, { replyInThread })
        : this.sendMessageSync(receiveIdType, chatId, "interactive", content) != null;
      return sent ? cardId : null;
    } catch {
      return null;
    }
  }
  streamUpdateTextSync(cardId: string, content: string, sequence: number): boolean {
    try {
      const response = this.client?.cardkit?.v1?.cardElement?.content?.({
        path: { card_id: cardId, element_id: "streaming_md" },
        data: { content, sequence },
      });
      if (isPromiseLike(response)) {
        response.catch((error: unknown) => this.reportEventError(error));
        return true;
      }
      return isSuccessfulResponse(response);
    } catch {
      return false;
    }
  }
  closeStreamingModeSync(cardId: string, sequence: number): boolean {
    try {
      const settings = JSON.stringify({ config: { streaming_mode: false } });
      const uuid = cryptoLikeId();
      const response = this.client?.cardkit?.v1?.card?.settings?.({
        path: { card_id: cardId },
        data: { settings, sequence, uuid },
      });
      if (isPromiseLike(response)) {
        response.catch((error: unknown) => this.reportEventError(error));
        return true;
      }
      return isSuccessfulResponse(response);
    } catch {
      return false;
    }
  }
  override async sendDelta(
    chatId: string,
    delta: string,
    metadata: Record<string, any> = {},
  ): Promise<void> {
    if (!this.client) return;
    const key = FeishuChannel.streamKey(chatId, metadata);
    const ridType = chatId.startsWith("oc_") ? "chat_id" : "open_id";
    if (metadata.streamEnd) {
      if (delta) (this.streamBuffers[key] ??= new FeishuStreamBuffer()).text += delta;
      if (metadata.message_id && !metadata.resuming) {
        const reactionId = this.reactionIds[metadata.message_id];
        if (reactionId) await this.removeReaction(metadata.message_id, reactionId);
        delete this.reactionIds[metadata.message_id];
        if (this.config.doneEmoji)
          await this.addReaction(metadata.message_id, this.config.doneEmoji);
      }
      const buf = this.streamBuffers[key];
      delete this.streamBuffers[key];
      if (!buf?.text) return;
      const cardId = buf.cardId;
      if (cardId && this.streamUpdateTextSync(cardId, buf.text, ++buf.sequence)) {
        this.closeStreamingModeSync(cardId, ++buf.sequence);
        return;
      }
      for (const chunk of FeishuChannel.splitElementsByTableLimit(
        this.buildCardElements(buf.text),
      )) {
        const card = JSON.stringify({ config: { wide_screen_mode: true }, elements: chunk });
        const target = this.threadReplyTarget(metadata);
        if (target)
          this.replyMessageSync(target, "interactive", card, {
            replyInThread: this.shouldUseReplyInThread(metadata),
          });
        else this.sendMessageSync(ridType, chatId, "interactive", card);
      }
      return;
    }
    const buf = (this.streamBuffers[key] ??= new FeishuStreamBuffer());
    buf.text += delta;
    if (!buf.text.trim()) return;
    const now = monotonicSeconds();
    const cardId = buf.cardId;
    if (!cardId && !buf.cardCreateFailed && this.client?.cardkit) {
      const target = this.threadReplyTarget(metadata);
      const cardId = this.createStreamingCardSync(ridType, chatId, target, {
        replyInThread: this.shouldUseReplyInThread(metadata),
      });
      if (cardId) {
        buf.cardId = cardId;
        buf.sequence = 1;
        this.streamUpdateTextSync(cardId, buf.text, 1);
        buf.lastEdit = now;
      } else {
        // Card creation failed, such as missing cardkit permission; do not retry this stream, and send one plain-text/1.0-card fallback at the end.
        buf.cardCreateFailed = true;
      }
    } else if (cardId && now - buf.lastEdit >= FeishuChannel.STREAM_EDIT_INTERVAL) {
      buf.sequence += 1;
      this.streamUpdateTextSync(cardId, buf.text, buf.sequence);
      buf.lastEdit = now;
    }
  }
  override async send(msg: OutboundMessage): Promise<void> {
    if (!this.client) return;
    const receiveIdType = msg.chatId.startsWith("oc_") ? "chat_id" : "open_id";
    const replyTarget =
      this.config.replyToMessage && !msg.metadata?.agentProgress
        ? msg.metadata?.message_id
        : this.threadReplyTarget(msg.metadata ?? {});
    let firstSend = true;
    const doSend = (msgType: string, content: string): void => {
      if (replyTarget && (firstSend || msg.metadata?.thread_id)) {
        firstSend = false;
        if (
          this.replyMessageSync(replyTarget, msgType, content, {
            replyInThread: this.shouldUseReplyInThread(msg.metadata ?? {}),
          })
        )
          return;
      }
      this.sendMessageSync(receiveIdType, msg.chatId, msgType, content);
    };
    if (msg.metadata?.toolHint) {
      const hint = this.formatToolHintDelta((msg.content ?? "").trim());
      if (!hint) return;
      const buf = this.streamBuffers[FeishuChannel.streamKey(msg.chatId, msg.metadata)];
      if (buf && buf.cardId) {
        await this.sendDelta(msg.chatId, `\n\n${hint}\n\n`);
        return;
      }
      const card = JSON.stringify({
        config: { wide_screen_mode: true },
        elements: [{ tag: "markdown", content: hint }],
      });
      const target = this.threadReplyTarget(msg.metadata ?? {});
      if (target)
        this.replyMessageSync(target, "interactive", card, {
          replyInThread: this.shouldUseReplyInThread(msg.metadata ?? {}),
        });
      else this.sendMessageSync(receiveIdType, msg.chatId, "interactive", card);
      return;
    }
    for (const filePath of msg.media ?? []) {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
      const ext = path.extname(filePath).toLowerCase();
      if (FEISHU_IMAGE_EXTS.has(ext)) {
        const key = await this.uploadImage(filePath);
        if (key) doSend("image", JSON.stringify({ image_key: key }));
      } else {
        const key = await this.uploadFile(filePath);
        if (!key) continue;
        const msgType = FEISHU_AUDIO_EXTS.has(ext)
          ? "audio"
          : FEISHU_VIDEO_EXTS.has(ext)
            ? "media"
            : "file";
        doSend(msgType, JSON.stringify({ file_key: key }));
      }
    }
    if (!msg.content?.trim()) return;
    const fmt = FeishuChannel.detectMessageFormat(msg.content);
    if (fmt === "text") doSend("text", JSON.stringify({ text: msg.content.trim() }));
    else if (fmt === "post") doSend("post", FeishuChannel.markdownToPost(msg.content));
    else {
      for (const chunk of FeishuChannel.splitElementsByTableLimit(
        this.buildCardElements(msg.content),
      )) {
        doSend(
          "interactive",
          JSON.stringify({ config: { wide_screen_mode: true }, elements: chunk }),
        );
      }
    }
  }
  async onMessage(data: any): Promise<void> {
    const event = data?.event ?? data;
    const message = event?.message;
    const sender = event?.sender;
    if (!message || !sender) return;
    if (sender.sender_type === "bot" || sender.senderType === "bot") return;
    const messageId = message.message_id ?? message.messageId;
    if (messageId && this.processedMessageIds.has(messageId)) return;
    if (messageId) {
      this.processedMessageIds.set(messageId, null);
      while (this.processedMessageIds.size > 1000)
        this.processedMessageIds.delete(this.processedMessageIds.keys().next().value!);
    }
    const senderId =
      sender.sender_id?.open_id ?? sender.senderId?.openId ?? sender.open_id ?? "unknown";
    const chatId = message.chat_id ?? message.chatId;
    const chatType = message.chat_type ?? message.chatType ?? "p2p";
    const msgType = message.message_type ?? message.messageType ?? message.msg_type ?? "text";
    if (chatType === "group" && !this.isGroupMessageForBot(message)) return;
    if (!this.isAllowed(senderId)) {
      if (chatType === "p2p")
        await this.handleMessage({ senderId, chatId: senderId, content: "", isDm: true });
      return;
    }
    if (messageId) {
      const task = this.addReaction(messageId, this.config.reactEmoji);
      this.backgroundTasks.add(task);
      void this.onBackgroundTaskDone(task);
      void this.onReactionAdded(messageId, task);
    }
    let contentJson: Record<string, any> = {};
    try {
      contentJson =
        typeof message.content === "string"
          ? JSON.parse(message.content || "{}")
          : (message.content ?? {});
    } catch {
      contentJson = {};
    }
    const contentParts: string[] = [];
    const mediaPaths: string[] = [];
    if (msgType === "text") {
      const text = FeishuChannel.resolveMentions(contentJson.text ?? "", message.mentions);
      if (text) contentParts.push(text);
    } else if (msgType === "post") {
      const [text, imageKeys] = extractPostContent(contentJson);
      if (text) contentParts.push(text);
      for (const imageKey of imageKeys) {
        const [filePath, contentText] = await this.downloadAndSaveMedia(
          "image",
          { image_key: imageKey },
          messageId,
        );
        if (filePath) mediaPaths.push(filePath);
        contentParts.push(contentText);
      }
    } else if (["image", "audio", "file", "media"].includes(msgType)) {
      let [filePath, contentText] = await this.downloadAndSaveMedia(
        msgType,
        contentJson,
        messageId,
      );
      if (filePath) mediaPaths.push(filePath);
      if (msgType === "audio" && filePath) {
        const transcription = await this.transcribeAudio(filePath);
        if (transcription) contentText = `[transcription: ${transcription}]`;
      }
      contentParts.push(contentText);
    } else if (
      [
        "share_chat",
        "share_user",
        "interactive",
        "share_calendar_event",
        "system",
        "merge_forward",
      ].includes(msgType)
    ) {
      contentParts.push(extractShareCardContent(contentJson, msgType));
    } else {
      contentParts.push(MSG_TYPE_MAP[msgType] ?? `[${msgType}]`);
    }
    const parentId = message.parent_id ?? message.parentId ?? null;
    const rootId = message.root_id ?? message.rootId ?? null;
    const threadId = message.thread_id ?? message.threadId ?? null;
    if (parentId && this.client) {
      const reply = this.getMessageContentSync(parentId);
      if (reply) contentParts.unshift(reply);
    }
    const content = contentParts.filter(Boolean).join("\n");
    if (!content && !mediaPaths.length) return;
    const sessionKey =
      chatType === "group"
        ? `feishu:${chatId}${this.config.topicIsolation ? `:${rootId || messageId}` : ""}`
        : undefined;
    const replyTo = chatType === "group" ? chatId : senderId;
    await this.handleMessage({
      senderId,
      chatId: replyTo,
      content,
      media: mediaPaths,
      metadata: {
        message_id: messageId,
        chat_type: chatType,
        msg_type: msgType,
        parent_id: parentId,
        root_id: rootId,
        thread_id: threadId,
      },
      sessionKey,
      isDm: chatType === "p2p",
    });
  }
  /**
   * Safely handle Feishu events: if the onMessage path, including direct sends,
   * throws, only log it and prevent unhandled Promise rejections from crashing
   * the gateway process.
   */
  safeOnMessage(event: any): Promise<void> {
    return Promise.resolve()
      .then(() => this.onMessage(event))
      .catch((error) => {
        this.reportEventError(error);
      });
  }

  override permissionErrorHint(error: unknown): string | null {
    return feishuPermissionHint(error);
  }

  reportEventError(error: unknown): void {
    // Insufficient permissions are a configuration issue the user must fix in the open platform; record them in lastError for frontend surfacing.
    this.recordPermissionError(error);
    const message = feishuPermissionHint(error) ?? describeFeishuError(error);
    // Log each error once because streaming replies can trigger the same permission error for every delta.
    if (this.loggedErrorMessages.has(message)) return;
    this.loggedErrorMessages.add(message);
    console.error("[feishu] 处理事件失败，已忽略以保持网关运行：", message);
  }

  onMessageSync(data: any): void {
    void this.safeOnMessage(data);
  }
  onReactionCreated(data: any): void {}
  onReactionDeleted(data: any): void {}
  onMessageRead(data: any): void {}
  onBotP2pChatEntered(data: any): void {}
  static formatToolHintLines(toolHint: string): string {
    const parts: string[] = [];
    let buf = "";
    let depth = 0;
    let quote = "";
    let escaped = false;
    for (let i = 0; i < toolHint.length; i += 1) {
      const ch = toolHint[i];
      buf += ch;
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "(") depth += 1;
      else if (ch === ")" && depth > 0) depth -= 1;
      else if (ch === "," && depth === 0 && toolHint[i + 1] === " ") {
        parts.push(buf.trimEnd());
        buf = "";
      }
    }
    if (buf.trim()) parts.push(buf.trim());
    return parts.filter(Boolean).join("\n");
  }
}

export class FeishuStreamBuffer {
  text = "";
  sequence = 0;
  cardId: string | null = null;
  lastEdit = 0;
  // Set after streaming card creation fails, such as missing cardkit permission, so later deltas do not retry card creation and flood logs.
  cardCreateFailed = false;

  constructor(init: Partial<FeishuStreamBuffer> = {}) {
    Object.assign(this, init);
  }
}

function monotonicSeconds(): number {
  return Date.now() / 1000;
}

function cryptoLikeId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(16).slice(2)}`;
}

function isPromiseLike(value: any): value is Promise<any> {
  return Boolean(value) && typeof value.then === "function";
}

/**
 * Compress a Feishu SDK / axios error into a one-line readable summary.
 *
 * Feishu SDK errors are often axios errors. Direct console.error prints the
 * entire socket/TLS internals over thousands of lines and hides the useful
 * code/msg. Prefer Feishu business error codes and messages, including
 * permission errors such as 99991672, then fall back to message.
 */
export function describeFeishuError(error: any): string {
  if (!error || typeof error !== "object") return String(error);
  const data = error.response?.data ?? error;
  const code = data?.code ?? error?.code;
  const msg = data?.msg ?? error?.msg;
  const parts: string[] = [];
  if (code !== undefined && code !== null) parts.push(`code=${code}`);
  if (msg) parts.push(`msg=${msg}`);
  if (parts.length) return parts.join(" ");
  return error?.message ?? String(error);
}

/** Feishu application permission-denied error code. */
const FEISHU_PERMISSION_DENIED_CODE = 99991672;

/**
 * If the error is an application permission failure, return a Chinese
 * user-action hint that can be displayed directly; otherwise return null.
 *
 * Common Feishu pitfall: after enabling permissions in the open platform, users
 * must create and publish a new version before the permissions take effect.
 * Enabling without publishing still reports 99991672, so the hint explicitly
 * reminds users about this step and keeps Feishu's original msg, including the
 * required scope and application link.
 */
export function feishuPermissionHint(error: any): string | null {
  const data = error?.response?.data ?? error;
  const code = data?.code ?? error?.code;
  const msg = String(data?.msg ?? error?.msg ?? "");
  const denied =
    code === FEISHU_PERMISSION_DENIED_CODE ||
    /access denied|scopes? (is |are )?required|应用尚未开通|权限/i.test(msg);
  if (!denied) return null;
  return (
    "飞书机器人权限不足：请在飞书开放平台为该应用开通所需权限（如 im:message:send），" +
    "并【创建并发布新版本】后生效。原始提示：" +
    (msg || describeFeishuError(error))
  );
}

function isSuccessfulResponse(response: any): boolean {
  if (!response) return false;
  if (typeof response.success === "function") return Boolean(response.success());
  if (response.success === false) return false;
  return !response.code;
}
