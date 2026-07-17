import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { OutboundMessage } from "../../core/runtime-messages/index.js";
import { getDataDir, getMediaDir } from "../../config/paths.js";
import { BaseChannel } from "./base.js";

export const TYPING_NOTICE_TIMEOUT_MS = 30_000;
export let TYPING_KEEPALIVE_INTERVAL_MS = 20_000;
export const MATRIX_HTML_FORMAT = "org.matrix.custom.html";
export const _ATTACH_MARKER = "[attachment: {}]";
export const _ATTACH_TOO_LARGE = "[attachment: {} - too large]";
export const _ATTACH_FAILED = "[attachment: {} - download failed]";
export const _ATTACH_UPLOAD_FAILED = "[attachment: {} - upload failed]";
export const _DEFAULT_ATTACH_NAME = "attachment";

const MSGTYPE_MAP: Record<string, string> = {
  "m.image": "image",
  "m.audio": "audio",
  "m.video": "video",
  "m.file": "file",
};

type StreamTimer = ReturnType<typeof setInterval>;

function asArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function formatMarker(template: string, value: string): string {
  return template.replace("{}", value);
}

function safeFilename(name: string): string {
  const base = path.basename(String(name || "").trim());
  return base.replace(/[^\w.\-()[\]（）【】\u4e00-\u9fff]+/gu, "_").replace(/^[._ ]+|[._ ]+$/g, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export class RoomMessage {}
export class RoomMessageText extends RoomMessage {}
export class RoomMessageMedia extends RoomMessage {}
export class RoomEncryptedMedia extends RoomMessageMedia {}
export class InviteEvent {}

export class DownloadError extends Error {}
export class UploadError extends Error {}
export class RoomTypingError extends Error {}
export class RoomSendError extends Error {
  statusCode?: string;
  softLogout?: boolean;
  constructor(message = "", init: Record<string, any> = {}) {
    super(message);
    Object.assign(this, init);
  }
}
export class SyncError extends Error {
  statusCode?: string;
  softLogout?: boolean;
  constructor(message = "", init: Record<string, any> = {}) {
    super(message);
    Object.assign(this, init);
  }
}
export class JoinError extends RoomSendError {}
export class EncryptionError extends Error {}

export class LoginResponse {
  accessToken: string;
  deviceId: string;
  constructor(init: { access_token?: string; accessToken?: string; device_id?: string; deviceId?: string } = {}) {
    this.accessToken = init.accessToken ?? init.access_token ?? "";
    this.deviceId = init.deviceId ?? init.device_id ?? "";
  }
}

export class RoomSendResponse {
  eventId: string;
  roomId: string;
  constructor(init: { event_id?: string; eventId?: string; room_id?: string; roomId?: string } = {}) {
    this.eventId = init.event_id ?? init.eventId ?? "";
    this.roomId = init.room_id ?? init.roomId ?? "";
  }
}

export class MemoryDownloadResponse {
  body: Buffer;
  contentType: string;
  filename: string | null;
  constructor(init: { body?: Buffer | Uint8Array | string; content_type?: string; contentType?: string; filename?: string | null } = {}) {
    this.body = Buffer.from(init.body ?? "");
    this.contentType = init.content_type ?? init.contentType ?? "application/octet-stream";
    this.filename = init.filename ?? null;
  }
}

export const MATRIX_MEDIA_EVENT_FILTER = [RoomMessageMedia, RoomEncryptedMedia] as const;

export class StreamBuffer {
  text: string;
  eventId: string | null;
  lastEdit: number;
  constructor(init: { text?: string; eventId?: string | null; lastEdit?: number } = {}) {
    this.text = init.text ?? "";
    this.eventId = init.eventId ?? null;
    this.lastEdit = init.lastEdit ?? 0;
  }
}

export const MATRIX_HTML_CLEANER = {
  clean(html: string): string {
    let out = String(html);
    out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
    out = out.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    out = out.replace(/<a\b([^>]*)>/gi, (match, attrs: string) => {
      const href = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const value = href?.[1] ?? href?.[2] ?? href?.[3] ?? "";
      if (/^(https?:\/\/|matrix:|mailto:)/i.test(value)) return `<a href="${escapeAttr(value)}" rel="noopener noreferrer">`;
      return "<a>";
    });
    out = out.replace(/<img\b([^>]*)>/gi, (match, attrs: string) => {
      const src = attrs.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const srcValue = src?.[1] ?? src?.[2] ?? src?.[3] ?? "";
      if (!/^mxc:\/\//i.test(srcValue)) return "";
      const alt = attrs.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const altValue = alt?.[1] ?? alt?.[2] ?? alt?.[3] ?? "";
      return `<img src="${escapeAttr(srcValue)}"${altValue ? ` alt="${escapeAttr(altValue)}"` : ""}>`;
    });
    out = out.replace(/<code\b([^>]*)>/gi, (match, attrs: string) => {
      const cls = attrs.match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const classes = String(cls?.[1] ?? cls?.[2] ?? cls?.[3] ?? "")
        .split(/\s+/)
        .filter((name) => name.startsWith("language-") && !name.startsWith("language-_"));
      return classes.length ? `<code class="${classes.join(" ")}">` : "<code>";
    });
    return out;
  },
};

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

function renderInlineMarkdown(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}">`);
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, href) => `<a href="${escapeAttr(href)}">${label}</a>`);
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, (match, prefix, url) => `${prefix}<a href="${escapeAttr(url)}">${escapeHtml(url)}</a>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  out = out.replace(/\^([^^]+)\^/g, "<sup>$1</sup>");
  out = out.replace(/~([^~\s]+)~/g, "<sub>$1</sub>");
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  return out;
}

export function renderMarkdownHtml(text: string): string | null {
  try {
    if (!/[#*`~^|!\[\]()>-]|https?:\/\//.test(text)) return null;
    const lines = text.split(/\r?\n/);
    const blocks: string[] = [];
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        index += 1;
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        blocks.push(`<h${heading[1].length}>${renderInlineMarkdown(heading[2])}</h${heading[1].length}>`);
        index += 1;
        continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {
        const items: string[] = [];
        while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
          items.push(`<li>${renderInlineMarkdown(lines[index].replace(/^\s*[-*]\s+/, ""))}</li>`);
          index += 1;
        }
        blocks.push(`<ul>${items.join("")}</ul>`);
        continue;
      }
      if (line.includes("|") && index + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[index + 1])) {
        const headers = line.split("|").map((cell) => cell.trim()).filter(Boolean);
        index += 2;
        const rows: string[][] = [];
        while (index < lines.length && lines[index].includes("|")) {
          rows.push(lines[index].split("|").map((cell) => cell.trim()).filter(Boolean));
          index += 1;
        }
        blocks.push(
          `<table><thead><tr>${headers.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${rows
            .map((row) => `<tr>${row.map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`).join("")}</tr>`)
            .join("")}</tbody></table>`,
        );
        continue;
      }
      const para: string[] = [];
      while (index < lines.length && lines[index].trim() && !/^(#{1,6})\s+/.test(lines[index]) && !/^\s*[-*]\s+/.test(lines[index])) {
        para.push(lines[index]);
        index += 1;
      }
      blocks.push(`<p>${renderInlineMarkdown(para.join("\n"))}</p>`);
    }
    const cleaned = MATRIX_HTML_CLEANER.clean(blocks.join("\n")).trim();
    if (!cleaned) return null;
    if (cleaned.startsWith("<p>") && cleaned.endsWith("</p>")) {
      const inner = cleaned.slice(3, -4);
      if (!inner.includes("<") && !inner.includes(">")) return null;
    }
    return cleaned;
  } catch {
    return null;
  }
}

export function buildMatrixTextContent(
  text: string,
  eventId: string | null = null,
  threadRelatesTo: Record<string, any> | null = null,
): Record<string, any> {
  const content: Record<string, any> = { msgtype: "m.text", body: text, "m.mentions": {} };
  const html = renderMarkdownHtml(text);
  if (html) {
    content.format = MATRIX_HTML_FORMAT;
    content.formatted_body = html;
  }
  if (eventId) {
    content["m.new_content"] = { body: text, msgtype: "m.text" };
    content["m.relates_to"] = { rel_type: "m.replace", event_id: eventId };
    if (threadRelatesTo) content["m.new_content"]["m.relates_to"] = threadRelatesTo;
  } else if (threadRelatesTo) {
    content["m.relates_to"] = threadRelatesTo;
  }
  return content;
}

export class MatrixConfig {
  enabled = false;
  homeserver = "https://matrix.org";
  userId = "";
  password = "";
  accessToken = "";
  deviceId = "";
  e2eeEnabled = true;
  syncStopGraceSeconds = 2;
  maxMediaBytes = 20 * 1024 * 1024;
  allowFrom: string[] = [];
  groupPolicy: "open" | "mention" | "allowlist" = "open";
  groupAllowFrom: string[] = [];
  allowRoomMentions = false;
  streaming = false;

  constructor(init: Partial<MatrixConfig> = {}) {
    this.enabled = init.enabled ?? this.enabled;
    this.homeserver = init.homeserver ?? this.homeserver;
    this.userId = init.userId ?? this.userId;
    this.password = init.password ?? this.password;
    this.accessToken = init.accessToken ?? this.accessToken;
    this.deviceId = init.deviceId ?? this.deviceId;
    this.e2eeEnabled = init.e2eeEnabled ?? this.e2eeEnabled;
    this.syncStopGraceSeconds = init.syncStopGraceSeconds ?? this.syncStopGraceSeconds;
    this.maxMediaBytes = init.maxMediaBytes ?? this.maxMediaBytes;
    this.allowFrom = asArray(init.allowFrom ?? this.allowFrom);
    this.groupPolicy = init.groupPolicy ?? this.groupPolicy;
    this.groupAllowFrom = asArray(init.groupAllowFrom ?? this.groupAllowFrom);
    this.allowRoomMentions = init.allowRoomMentions ?? this.allowRoomMentions;
    this.streaming = init.streaming ?? this.streaming;
  }
}

export let decryptAttachment = (ciphertext: Buffer, key: string, sha256: string, iv: string): Buffer => {
  throw new EncryptionError("Matrix encrypted attachment decryptor is not configured");
};

export function setMatrixAttachmentDecryptor(fn: typeof decryptAttachment): void {
  decryptAttachment = fn;
}

export class MatrixChannel extends BaseChannel {
  override name = "matrix";
  override displayName = "Matrix";
  override config: MatrixConfig;
  static _STREAM_EDIT_INTERVAL = 2;
  _STREAM_EDIT_INTERVAL = 2;
  client: any = null;
  syncTask: Promise<void> | null = null;
  typingTasks = new Map<string, StreamTimer>();
  restrictToWorkspace = false;
  workspaceRoot: string | null = null;
  serverUploadLimitBytes: number | null = null;
  serverUploadLimitChecked = false;
  streamBuffers: Record<string, StreamBuffer> = {};
  startedAtMs = 0;
  monotonicTime = (): number => performance.now() / 1000;
  storePath = "";
  sessionPath = "";

  static override defaultConfig(): Record<string, any> {
    return new MatrixConfig() as any;
  }

  constructor(
    config: Partial<MatrixConfig> & Record<string, any> = {},
    bus?: any,
    options: { restrictToWorkspace?: boolean; workspace?: string | null } = {},
  ) {
    const normalized = config instanceof MatrixConfig ? config : new MatrixConfig(config);
    super("matrix", normalized, bus);
    this.config = normalized;
    this.restrictToWorkspace = Boolean(options.restrictToWorkspace);
    this.workspaceRoot = options.workspace ? path.resolve(options.workspace) : null;
  }

  override get supportsStreaming(): boolean {
    return Boolean(this.config.streaming);
  }

  override async start(): Promise<void> {
    this.running = true;
    this.startedAtMs = Date.now();
    const storePath = path.join(getDataDir(), "matrix-store");
    fs.mkdirSync(storePath, { recursive: true });
    this.storePath = storePath;
    this.sessionPath = path.join(storePath, "session.json");
    if (!this.client) this.client = await createDefaultMatrixClient(this.config).catch(() => createNoopMatrixClient());
    this.registerEventCallbacks();
    this.registerResponseCallbacks();
    if (this.config.password && fs.existsSync(this.sessionPath)) {
      try {
        const session = JSON.parse(fs.readFileSync(this.sessionPath, "utf8"));
        this.client.userId = this.config.userId;
        this.client.accessToken = session.accessToken ?? session.access_token;
        this.client.deviceId = session.deviceId ?? session.device_id;
        this.client.loadStore?.();
      } catch {
        // Fall back to login below.
      }
    }
    if (this.config.password && !this.client.accessToken) {
      const resp = await this.client.login?.(this.config.password);
      if (resp instanceof LoginResponse || resp?.accessToken || resp?.access_token) this.writeSessionToDisk(resp);
    } else if (this.config.accessToken && this.config.deviceId) {
      this.client.userId = this.config.userId;
      this.client.accessToken = this.config.accessToken;
      this.client.deviceId = this.config.deviceId;
      this.client.loadStore?.();
    }
    this.syncTask = this.syncLoop();
  }

  override async stop(): Promise<void> {
    this.running = false;
    for (const roomId of Array.from(this.typingTasks.keys())) await this.stopTypingKeepalive(roomId, { clearTyping: false });
    this.client?.stopSyncForever?.();
    await this.client?.close?.();
  }

  writeSessionToDisk(resp: any): void {
    if (!this.sessionPath) return;
    try {
      fs.mkdirSync(path.dirname(this.sessionPath), { recursive: true });
      const accessToken = resp.accessToken ?? resp.access_token ?? "";
      const deviceId = resp.deviceId ?? resp.device_id ?? "";
      fs.writeFileSync(this.sessionPath, JSON.stringify({ accessToken, deviceId }, null, 2));
    } catch {
      // best effort
    }
  }

  registerEventCallbacks(): void {
    this.client?.addEventCallback?.(this.onMessage.bind(this), RoomMessageText);
    this.client?.addEventCallback?.(this.onMediaMessage.bind(this), MATRIX_MEDIA_EVENT_FILTER);
    this.client?.addEventCallback?.(this.onRoomInvite.bind(this), InviteEvent);
  }

  registerResponseCallbacks(): void {
    this.client?.addResponseCallback?.(this.onSyncError.bind(this), SyncError);
    this.client?.addResponseCallback?.(this.onJoinError.bind(this), JoinError);
    this.client?.addResponseCallback?.(this.onSendError.bind(this), RoomSendError);
  }

  isFatalAuthResponse(response: any): boolean {
    const code = response?.statusCode;
    return ["M_UNKNOWN_TOKEN", "M_FORBIDDEN", "M_UNAUTHORIZED"].includes(code) || Boolean(response?.softLogout);
  }

  async onSyncError(response: any): Promise<void> {
    if (this.isFatalAuthResponse(response)) {
      this.running = false;
      this.client?.stopSyncForever?.();
    }
  }

  async onJoinError(response: any): Promise<void> {}
  async onSendError(response: any): Promise<void> {}

  async syncLoop(): Promise<void> {
    let backoff = 2;
    while (this.running) {
      try {
        if (!this.client?.syncForever) break;
        await this.client?.syncForever?.({ timeout: 30_000, fullState: true });
        backoff = 2;
      } catch {
        if (!this.running) break;
        await sleep(backoff * 1000);
        backoff = Math.min(backoff * 2, 60);
      }
    }
  }

  async onRoomInvite(room: any, event: any): Promise<void> {
    if (this.isAllowed(String(event?.sender ?? ""))) await this.client?.join?.(room.room_id);
  }

  isDirectRoom(room: any): boolean {
    const count = room?.member_count ?? room?.memberCount;
    return Number.isInteger(count) && count <= 2;
  }

  isBotMentioned(event: any): boolean {
    const mentions = event?.source?.content?.["m.mentions"];
    if (!mentions || typeof mentions !== "object") return false;
    return (Array.isArray(mentions.user_ids) && mentions.user_ids.includes(this.config.userId)) || Boolean(this.config.allowRoomMentions && mentions.room);
  }

  isPreStartupEvent(event: any): boolean {
    const ts = event?.server_timestamp ?? event?.serverTimestamp;
    const startedAt = this.startedAtMs;
    return Number.isInteger(ts) && ts < startedAt;
  }

  shouldProcessMessage(room: any, event: any): boolean {
    if (!this.isAllowed(String(event?.sender ?? ""))) return false;
    if (this.isDirectRoom(room)) return true;
    if (this.config.groupPolicy === "open") return true;
    if (this.config.groupPolicy === "allowlist") return this.config.groupAllowFrom.includes(String(room?.room_id ?? room?.roomId ?? ""));
    if (this.config.groupPolicy === "mention") return this.isBotMentioned(event);
    return false;
  }

  mediaDir(): string {
    const dir = getMediaDir("matrix");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  eventSourceContent(event: any): Record<string, any> {
    const content = event?.source?.content;
    return content && typeof content === "object" ? content : {};
  }

  eventThreadRootId(event: any): string | null {
    const relates = this.eventSourceContent(event)["m.relates_to"];
    if (!relates || relates.rel_type !== "m.thread" || typeof relates.event_id !== "string" || !relates.event_id) return null;
    return relates.event_id;
  }

  threadMetadata(event: any): Record<string, string> | null {
    const rootId = this.eventThreadRootId(event);
    if (!rootId) return null;
    const meta: Record<string, string> = { threadRootEventId: rootId };
    if (typeof event?.event_id === "string" && event.event_id) meta.threadReplyToEventId = event.event_id;
    return meta;
  }

  static buildThreadRelatesTo(metadata: Record<string, any> | null | undefined): Record<string, any> | null {
    if (!metadata) return null;
    const rootId = metadata.threadRootEventId;
    const replyTo = metadata.threadReplyToEventId ?? metadata.eventId;
    if (typeof rootId !== "string" || !rootId || typeof replyTo !== "string" || !replyTo) return null;
    return { rel_type: "m.thread", event_id: rootId, "m.in_reply_to": { event_id: replyTo }, is_falling_back: true };
  }

  buildThreadRelatesTo(metadata: Record<string, any> | null | undefined): Record<string, any> | null {
    return MatrixChannel.buildThreadRelatesTo(metadata);
  }

  eventAttachmentType(event: any): string {
    return MSGTYPE_MAP[this.eventSourceContent(event).msgtype] ?? "file";
  }

  static isEncryptedMediaEvent(event: any): boolean {
    return Boolean(event?.key && typeof event.key === "object" && event?.hashes && typeof event.hashes === "object" && typeof event?.iv === "string");
  }

  isEncryptedMediaEvent(event: any): boolean {
    return MatrixChannel.isEncryptedMediaEvent(event);
  }

  eventDeclaredSizeBytes(event: any): number | null {
    const size = this.eventSourceContent(event).info?.size;
    return Number.isInteger(size) && size >= 0 ? size : null;
  }

  eventMime(event: any): string | null {
    const mime = this.eventSourceContent(event).info?.mimetype ?? event?.mimetype;
    return typeof mime === "string" && mime ? mime : null;
  }

  eventFilename(event: any, attachmentType: string): string {
    if (typeof event?.body === "string" && event.body.trim()) {
      const candidate = safeFilename(path.basename(event.body));
      if (candidate) return candidate;
    }
    return attachmentType === "file" ? _DEFAULT_ATTACH_NAME : attachmentType;
  }

  buildAttachmentPath(event: any, attachmentType: string, filename: string, mime: string | null): string {
    let safeName = safeFilename(path.basename(filename)) || _DEFAULT_ATTACH_NAME;
    if (!path.extname(safeName) && mime) {
      const ext = mimeExtension(mime);
      if (ext) safeName += ext;
    }
    const stem = (path.parse(safeName).name || attachmentType).slice(0, 72);
    const suffix = path.extname(safeName).slice(0, 16);
    const eventId = safeFilename(String(event?.event_id ?? event?.eventId ?? "evt").replace(/^\$/, "")).slice(0, 24) || "evt";
    return path.join(this.mediaDir(), `${eventId}_${stem}${suffix}`);
  }

  async downloadMediaBytes(mxcUrl: string): Promise<Buffer | null> {
    if (!this.client) return null;
    const response = await this.client.download?.({ mxc: mxcUrl });
    if (!response || response instanceof DownloadError || response?.error) return null;
    if (response instanceof MemoryDownloadResponse) return Buffer.from(response.body);
    if (Buffer.isBuffer(response.body) || response.body instanceof Uint8Array) return Buffer.from(response.body);
    if (typeof response.body === "string" && fs.existsSync(response.body)) return await fsp.readFile(response.body);
    if (Buffer.isBuffer(response) || response instanceof Uint8Array) return Buffer.from(response);
    return null;
  }

  decryptMediaBytes(event: any, ciphertext: Buffer): Buffer | null {
    const key = event?.key?.k;
    const sha256 = event?.hashes?.sha256;
    const iv = event?.iv;
    if (![key, sha256, iv].every((value) => typeof value === "string")) return null;
    try {
      return Buffer.from(decryptAttachment(ciphertext, key, sha256, iv));
    } catch {
      return null;
    }
  }

  async fetchMediaAttachment(room: any, event: any): Promise<[Record<string, any> | null, string]> {
    const atype = this.eventAttachmentType(event);
    const mime = this.eventMime(event);
    const filename = this.eventFilename(event, atype);
    const mxcUrl = event?.url;
    const fail = formatMarker(_ATTACH_FAILED, filename);
    if (typeof mxcUrl !== "string" || !mxcUrl.startsWith("mxc://")) return [null, fail];
    const limit = await this.effectiveMediaLimitBytes();
    const declared = this.eventDeclaredSizeBytes(event);
    if (declared !== null && declared > limit) return [null, formatMarker(_ATTACH_TOO_LARGE, filename)];
    const downloaded = await this.downloadMediaBytes(mxcUrl);
    if (!downloaded) return [null, fail];
    const encrypted = this.isEncryptedMediaEvent(event);
    const data = encrypted ? this.decryptMediaBytes(event, downloaded) : downloaded;
    if (!data) return [null, fail];
    if (data.length > limit) return [null, formatMarker(_ATTACH_TOO_LARGE, filename)];
    const filePath = this.buildAttachmentPath(event, atype, filename, mime);
    try {
      await fsp.writeFile(filePath, data);
    } catch {
      return [null, fail];
    }
    const attachment = {
      type: atype,
      mime,
      filename,
      eventId: String(event?.event_id ?? ""),
      encrypted,
      sizeBytes: data.length,
      path: filePath,
      mxcUrl,
    };
    return [attachment, formatMarker(_ATTACH_MARKER, filePath)];
  }

  baseMetadata(room: any, event: any): Record<string, any> {
    const meta: Record<string, any> = { room: room?.display_name ?? room?.displayName ?? room?.room_id ?? room?.roomId };
    if (typeof event?.event_id === "string" && event.event_id) meta.eventId = event.event_id;
    const thread = this.threadMetadata(event);
    if (thread) Object.assign(meta, thread);
    return meta;
  }

  async onMessage(room: any, event: any): Promise<void> {
    if (event?.sender === this.config.userId || this.isPreStartupEvent(event) || !this.shouldProcessMessage(room, event)) return;
    await this.startTypingKeepalive(room.room_id ?? room.roomId);
    try {
      await this.handleMessage({
        senderId: event.sender,
        chatId: room.room_id ?? room.roomId,
        content: event.body ?? "",
        metadata: this.baseMetadata(room, event),
        isDm: this.isDirectRoom(room),
      });
    } catch (err) {
      await this.stopTypingKeepalive(room.room_id ?? room.roomId, { clearTyping: true });
      throw err;
    }
  }

  async onMediaMessage(room: any, event: any): Promise<void> {
    if (event?.sender === this.config.userId || this.isPreStartupEvent(event) || !this.shouldProcessMessage(room, event)) return;
    const [attachment, marker] = await this.fetchMediaAttachment(room, event);
    const parts: string[] = [];
    if (typeof event?.body === "string" && event.body.trim()) parts.push(event.body.trim());
    if (attachment?.type === "audio") {
      const transcription = await this.transcribeAudio(attachment.path);
      parts.push(transcription ? `[transcription: ${transcription}]` : marker);
    } else if (marker) {
      parts.push(marker);
    }
    await this.startTypingKeepalive(room.room_id ?? room.roomId);
    try {
      const meta = this.baseMetadata(room, event);
      meta.attachments = attachment ? [attachment] : [];
      await this.handleMessage({
        senderId: event.sender,
        chatId: room.room_id ?? room.roomId,
        content: parts.join("\n"),
        media: attachment ? [attachment.path] : [],
        metadata: meta,
        isDm: this.isDirectRoom(room),
      });
    } catch (err) {
      await this.stopTypingKeepalive(room.room_id ?? room.roomId, { clearTyping: true });
      throw err;
    }
  }

  async setTyping(roomId: string, typing: boolean): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.roomTyping?.({ roomId, typingState: typing, timeout: TYPING_NOTICE_TIMEOUT_MS });
    } catch {
      // best effort
    }
  }

  async startTypingKeepalive(roomId: string): Promise<void> {
    await this.stopTypingKeepalive(roomId, { clearTyping: false });
    await this.setTyping(roomId, true);
    if (!this.running) return;
    const timer = setInterval(() => {
      void this.setTyping(roomId, true);
    }, TYPING_KEEPALIVE_INTERVAL_MS);
    this.typingTasks.set(roomId, timer);
  }

  async stopTypingKeepalive(roomId: string, options: { clearTyping?: boolean } = {}): Promise<void> {
    const timer = this.typingTasks.get(roomId);
    if (timer) {
      clearInterval(timer);
      this.typingTasks.delete(roomId);
    }
    if (options.clearTyping) await this.setTyping(roomId, false);
  }

  isWorkspacePathAllowed(filePath: string): boolean {
    if (!this.restrictToWorkspace || !this.workspaceRoot) return true;
    const resolved = path.resolve(filePath);
    const root = path.resolve(this.workspaceRoot);
    return resolved === root || resolved.startsWith(root + path.sep);
  }

  collectOutboundMediaCandidates(media: string[]): string[] {
    const seen = new Set<string>();
    const candidates: string[] = [];
    for (const raw of media ?? []) {
      if (typeof raw !== "string" || !raw.trim()) continue;
      const resolved = path.resolve(raw.trim());
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      candidates.push(resolved);
    }
    return candidates;
  }

  static buildOutboundAttachmentContent({
    filename,
    mime,
    sizeBytes,
    mxcUrl,
    encryptionInfo,
  }: {
    filename: string;
    mime: string;
    sizeBytes?: number;
    mxcUrl?: string;
    encryptionInfo?: Record<string, any> | null;
  }): Record<string, any> {
    const size = sizeBytes ?? 0;
    const mxc = mxcUrl ?? "";
    const prefix = mime.split("/")[0];
    const msgtype = prefix === "image" ? "m.image" : prefix === "audio" ? "m.audio" : prefix === "video" ? "m.video" : "m.file";
    const content: Record<string, any> = { msgtype, body: filename, filename, info: { mimetype: mime, size }, "m.mentions": {} };
    const enc = encryptionInfo;
    if (enc) content.file = { ...enc, url: mxc };
    else content.url = mxc;
    return content;
  }

  buildOutboundAttachmentContent(args: any): Record<string, any> {
    return MatrixChannel.buildOutboundAttachmentContent(args);
  }

  isEncryptedRoom(roomId: string): boolean {
    return Boolean(this.client?.rooms?.[roomId]?.encrypted);
  }

  async sendRoomContent(roomId: string, content: Record<string, any>): Promise<any> {
    if (!this.client) return null;
    const payload: Record<string, any> = { roomId, messageType: "m.room.message", content };
    if (this.config.e2eeEnabled) payload.ignoreUnverifiedDevices = true;
    return await this.client.roomSend?.(payload);
  }

  async resolveServerUploadLimitBytes(): Promise<number | null> {
    if (this.serverUploadLimitChecked) return this.serverUploadLimitBytes;
    this.serverUploadLimitChecked = true;
    if (!this.client?.contentRepositoryConfig) return null;
    try {
      const response = await this.client.contentRepositoryConfig();
      const size = response?.upload_size ?? response?.uploadSize;
      if (Number.isInteger(size) && size > 0) {
        this.serverUploadLimitBytes = size;
        return size;
      }
    } catch {
      return null;
    }
    return null;
  }

  async effectiveMediaLimitBytes(): Promise<number> {
    const local = Math.max(Number(this.config.maxMediaBytes), 0);
    const server = await this.resolveServerUploadLimitBytes();
    return server === null ? local : local ? Math.min(local, server) : 0;
  }

  async uploadAndSendAttachment({
    roomId,
    path: filePath,
    limitBytes,
    relatesTo,
  }: {
    roomId?: string;
    path: string;
    limitBytes?: number;
    relatesTo?: Record<string, any> | null;
  }): Promise<string | null> {
    if (!this.client) return formatMarker(_ATTACH_UPLOAD_FAILED, safeFilename(path.basename(filePath)) || _DEFAULT_ATTACH_NAME);
    const room = roomId ?? "";
    const resolved = path.resolve(filePath);
    const filename = safeFilename(path.basename(resolved)) || _DEFAULT_ATTACH_NAME;
    const fail = formatMarker(_ATTACH_UPLOAD_FAILED, filename);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile() || !this.isWorkspacePathAllowed(resolved)) return fail;
    const size = fs.statSync(resolved).size;
    const limit = limitBytes ?? 0;
    if (limit <= 0 || size > limit) return formatMarker(_ATTACH_TOO_LARGE, filename);
    const mime = mimeFromFilename(filename);
    let stream: Readable | null = null;
    try {
      stream = Readable.from(fs.readFileSync(resolved));
      const uploadResult = await this.client.upload(stream, {
        contentType: mime,
        filename,
        filesize: size,
        encrypt: this.config.e2eeEnabled && this.isEncryptedRoom(room),
      });
      const uploadResponse = Array.isArray(uploadResult) ? uploadResult[0] : uploadResult;
      const encryptionInfo = Array.isArray(uploadResult) && uploadResult[1] && typeof uploadResult[1] === "object" ? uploadResult[1] : null;
      if (uploadResponse instanceof UploadError || uploadResponse?.error) return fail;
      const mxcUrl = uploadResponse?.content_uri ?? uploadResponse?.contentUri;
      if (typeof mxcUrl !== "string" || !mxcUrl.startsWith("mxc://")) return fail;
      const content = this.buildOutboundAttachmentContent({ filename, mime, sizeBytes: size, mxcUrl, encryptionInfo });
      if (relatesTo) content["m.relates_to"] = relatesTo;
      await this.sendRoomContent(room, content);
      return null;
    } catch {
      return fail;
    } finally {
      stream?.destroy();
    }
  }

  override async send(msg: OutboundMessage | any): Promise<void> {
    if (!this.client) return;
    const chatId = String(msg.chatId ?? "");
    let text = String(msg.content ?? msg.text ?? "");
    const metadata = msg.metadata ?? {};
    const isProgress = Boolean(metadata.agentProgress);
    const relatesTo = this.buildThreadRelatesTo(metadata);
    try {
      const failures: string[] = [];
      const candidates = this.collectOutboundMediaCandidates(Array.isArray(msg.media) ? msg.media : []);
      if (candidates.length) {
        const limit = await this.effectiveMediaLimitBytes();
        for (const candidate of candidates) {
          const failure = await this.uploadAndSendAttachment({ roomId: chatId, path: candidate, limitBytes: limit, relatesTo });
          if (failure) failures.push(failure);
        }
      }
      if (failures.length) text = text.trim() ? `${text.trimEnd()}\n${failures.join("\n")}` : failures.join("\n");
      if (text.trim()) {
        const content = buildMatrixTextContent(text);
        if (relatesTo) content["m.relates_to"] = relatesTo;
        await this.sendRoomContent(chatId, content);
      }
    } finally {
      if (!isProgress) await this.stopTypingKeepalive(chatId, { clearTyping: true });
    }
  }

  override async sendDelta(chatId: string, delta: string, metadata: Record<string, any> = {}): Promise<void> {
    const relatesTo = this.buildThreadRelatesTo(metadata);
    if (metadata.streamEnd) {
      const buf = this.streamBuffers[chatId];
      delete this.streamBuffers[chatId];
      if (!buf?.eventId || !buf.text) return;
      await this.stopTypingKeepalive(chatId, { clearTyping: true });
      const content = buildMatrixTextContent(buf.text, buf.eventId, relatesTo);
      await this.sendRoomContent(chatId, content);
      return;
    }

    const buf = (this.streamBuffers[chatId] ??= new StreamBuffer());
    buf.text += delta;
    if (!buf.text.trim()) return;
    const now = this.monotonicTime();
    if (!buf.lastEdit || now - buf.lastEdit >= this._STREAM_EDIT_INTERVAL) {
      try {
        const content = buildMatrixTextContent(buf.text, buf.eventId, relatesTo);
        const response = await this.sendRoomContent(chatId, content);
        buf.lastEdit = buf.lastEdit = now;
        if (!buf.eventId) buf.eventId = response?.event_id ?? response?.eventId ?? null;
      } catch {
        await this.stopTypingKeepalive(chatId, { clearTyping: true });
      }
    }
  }
}

function mimeFromFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if ([".jpg", ".jpeg"].includes(ext)) return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".ogg") return "audio/ogg";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".txt") return "text/plain";
  if (ext === ".pdf") return "application/pdf";
  return "application/octet-stream";
}

function mimeExtension(mime: string): string {
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/gif") return ".gif";
  if (mime === "text/plain") return ".txt";
  if (mime === "application/pdf") return ".pdf";
  if (mime === "audio/mpeg") return ".mp3";
  return "";
}

async function readableToBuffer(input: any): Promise<Buffer> {
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) return Buffer.from(input);
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function createDefaultMatrixClient(config: MatrixConfig): Promise<any> {
  if (!config.homeserver || !config.userId) return createNoopMatrixClient();
  const matrix = await import("matrix-js-sdk");
  const sdkClient: any = matrix.createClient({
    baseUrl: config.homeserver,
    userId: config.userId || undefined,
    accessToken: config.accessToken || undefined,
    deviceId: config.deviceId || undefined,
  } as any);
  const callbacks: any[] = [];
  const responseCallbacks: any[] = [];
  let syncPromise: Promise<void> | null = null;
  let syncResolve: (() => void) | null = null;
  const roomMap = (): Record<string, any> => {
    const out: Record<string, any> = {};
    for (const room of sdkClient.getRooms?.() ?? []) {
      const roomId = (room as any).roomId ?? (room as any).room_id;
      if (!roomId) continue;
      out[roomId] = {
        encrypted: Boolean((room as any).hasEncryptionStateEvent?.() ?? (room as any).currentState?.getStateEvents?.("m.room.encryption", "")),
      };
    }
    return out;
  };
  const adapter: any = {
    callbacks,
    responseCallbacks,
    get rooms() {
      return roomMap();
    },
    get userId() {
      return sdkClient.getUserId?.() ?? config.userId;
    },
    set userId(value: string) {
      sdkClient.credentials = { ...(sdkClient.credentials ?? {}), userId: value };
    },
    get accessToken() {
      return sdkClient.getAccessToken?.() ?? sdkClient.opts?.accessToken ?? "";
    },
    set accessToken(value: string) {
      sdkClient.opts = { ...(sdkClient.opts ?? {}), accessToken: value };
      sdkClient.credentials = { ...(sdkClient.credentials ?? {}), accessToken: value };
    },
    get deviceId() {
      return sdkClient.getDeviceId?.() ?? sdkClient.deviceId ?? "";
    },
    set deviceId(value: string) {
      sdkClient.deviceId = value;
    },
    addEventCallback(callback: any, eventType: any) {
      callbacks.push([callback, eventType]);
    },
    addResponseCallback(callback: any, responseType: any) {
      responseCallbacks.push([callback, responseType]);
    },
    loadStore() {},
    async login(password: string) {
      const response = await sdkClient.loginWithPassword(config.userId, password);
      adapter.accessToken = response?.access_token ?? response?.accessToken ?? adapter.accessToken;
      adapter.deviceId = response?.device_id ?? response?.deviceId ?? adapter.deviceId;
      return new LoginResponse(response);
    },
    async syncForever(options: Record<string, any> = {}) {
      if (!syncPromise) {
        syncPromise = new Promise<void>((resolve) => {
          syncResolve = resolve;
        });
        sdkClient.on?.((matrix as any).RoomEvent?.Timeline ?? "Room.timeline", (event: any, room: any) => {
          const eventType = event?.getType?.() ?? event?.event?.type;
          if (eventType !== "m.room.message") return;
          const content = event?.getContent?.() ?? event?.event?.content ?? {};
          const body = content.body ?? "";
          const msgtype = content.msgtype ?? "";
          const wrapped = {
            sender: event?.getSender?.() ?? event?.event?.sender,
            body,
            url: content.url ?? content.file?.url,
            mimetype: content.info?.mimetype,
            key: content.file?.key,
            hashes: content.file?.hashes,
            iv: content.file?.iv,
            event_id: event?.getId?.() ?? event?.event?.event_id,
            server_timestamp: event?.getTs?.() ?? event?.event?.origin_server_ts,
            source: { content },
          };
          const roomInfo = { room_id: room?.roomId ?? room?.room_id, display_name: room?.name, member_count: room?.getJoinedMemberCount?.() };
          for (const [callback, registeredType] of callbacks) {
            const isMedia = ["m.image", "m.audio", "m.video", "m.file"].includes(msgtype);
            if (registeredType === RoomMessageText && msgtype === "m.text") void callback(roomInfo, wrapped);
            else if (registeredType === MATRIX_MEDIA_EVENT_FILTER && isMedia) void callback(roomInfo, wrapped);
          }
        });
        await sdkClient.startClient?.({ initialSyncLimit: 10, ...options });
      }
      await syncPromise;
    },
    stopSyncForever() {
      sdkClient.stopClient?.();
      syncResolve?.();
      syncPromise = null;
      syncResolve = null;
    },
    async roomTyping({ roomId, typingState, timeout }: any) {
      await sdkClient.sendTyping?.(roomId, typingState, timeout);
    },
    async roomSend({ roomId, messageType, content }: any) {
      const response = await sdkClient.sendEvent(roomId, messageType, content, "");
      return new RoomSendResponse({ roomId, eventId: response?.event_id ?? response?.eventId });
    },
    async join(roomId: string) {
      await sdkClient.joinRoom?.(roomId);
    },
    async download({ mxc }: any) {
      const url = sdkClient.mxcUrlToHttp?.(mxc, undefined, undefined, undefined, false, true, true) ?? sdkClient.getHttpUriForMxc?.(mxc);
      if (!url) return new DownloadError("Matrix MXC URL could not be resolved");
      const response = await fetch(url);
      if (!response.ok) return new DownloadError(`Matrix download failed with HTTP ${response.status}`);
      return new MemoryDownloadResponse({ body: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get("content-type") ?? undefined });
    },
    async upload(dataProvider: any, options: any = {}) {
      const body = await readableToBuffer(dataProvider);
      return await sdkClient.uploadContent(body, {
        type: options.contentType,
        name: options.filename,
        rawResponse: false,
      });
    },
    async contentRepositoryConfig() {
      return await sdkClient.getMediaConfig?.();
    },
    async close() {
      adapter.stopSyncForever();
      sdkClient.removeAllListeners?.();
    },
  };
  return adapter;
}

function createNoopMatrixClient(): any {
  return {
    callbacks: [] as any[],
    responseCallbacks: [] as any[],
    rooms: {} as Record<string, any>,
    addEventCallback(callback: any, eventType: any) {
      this.callbacks.push([callback, eventType]);
    },
    addResponseCallback(callback: any, responseType: any) {
      this.responseCallbacks.push([callback, responseType]);
    },
    loadStore() {},
    stopSyncForever() {},
    async syncForever() {
      await sleep(0);
    },
    async roomTyping() {},
    async roomSend({ roomId }: any) {
      return new RoomSendResponse({ roomId, eventId: "" });
    },
    async close() {},
  };
}
