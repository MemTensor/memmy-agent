import fs from "node:fs/promises";
import path from "node:path";
import { lookup } from "mime-types";
import { OutboundMessage } from "../../core/runtime-messages/index.js";
import { getMediaDir } from "../../config/paths.js";
import { validateResolvedUrl, validateUrlTarget } from "../../security/network.js";
import { BaseChannel } from "./base.js";

export const DINGTALK_MAX_REMOTE_MEDIA_BYTES = 20 * 1024 * 1024;
export const DINGTALK_MAX_REMOTE_MEDIA_REDIRECTS = 3;

function coalesce<T>(...values: Array<T | undefined | null>): T | undefined {
  for (const value of values) if (value !== undefined && value !== null) return value;
  return undefined;
}

function asArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value);
  return buf;
}

function u32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0);
  return buf;
}

function zipSingleFile(filename: string, data: Buffer): Buffer {
  const name = Buffer.from(filename, "utf8");
  const crc = crc32(data);
  const local = Buffer.concat([
    u32(0x04034b50),
    u16(20),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(crc),
    u32(data.length),
    u32(data.length),
    u16(name.length),
    u16(0),
    name,
    data,
  ]);
  const central = Buffer.concat([
    u32(0x02014b50),
    u16(20),
    u16(20),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(crc),
    u32(data.length),
    u32(data.length),
    u16(name.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    name,
  ]);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(1),
    u16(1),
    u32(central.length),
    u32(local.length),
    u16(0),
  ]);
  return Buffer.concat([local, central, end]);
}

function responseText(resp: any): string {
  if (typeof resp?.text === "string") return resp.text;
  if (Buffer.isBuffer(resp?.content)) return resp.content.toString("utf8");
  return "";
}

function responseJson(resp: any): any {
  try {
    return typeof resp?.json === "function" ? resp.json() : {};
  } catch {
    return {};
  }
}

function responseContent(resp: any): Buffer {
  if (Buffer.isBuffer(resp?.content)) return resp.content;
  if (resp?.content instanceof Uint8Array) return Buffer.from(resp.content);
  if (typeof resp?.text === "string") return Buffer.from(resp.text, "utf8");
  return Buffer.alloc(0);
}

function safeFilename(name: string): string {
  return path.basename(name || "file").replace(/[^\w.\-]+/g, "_") || "file";
}

/** DingTalk permission-error keywords for both API shapes: code/message and errcode/errmsg. */
const DINGTALK_PERMISSION_PATTERN =
  /forbidden|access[\s._-]*denied|no[\s._-]*permission|not[\s._-]*(granted|authorized)|unauthorized|permission[\s._-]*denied|scope|无权限|没有权限|权限不足|未授权|尚未开通/i;

/**
 * If the error is a DingTalk application-permission failure, return a Chinese
 * user-action hint that can be displayed directly; otherwise return null.
 *
 * Common DingTalk pitfall: after enabling capabilities such as enterprise robot
 * message sending in the developer console, a new version must be published from
 * Version Management and Release before the permissions take effect. Enabling
 * without publishing still reports permission errors, so the hint explicitly
 * reminds users about this step and keeps the original error details.
 */
export function dingtalkPermissionHint(error: any): string | null {
  const data = error?.response?.data ?? error ?? {};
  const code = data.code ?? data.errcode ?? error?.code;
  const msg = String(data.message ?? data.errmsg ?? data.msg ?? error?.message ?? "");
  const denied =
    DINGTALK_PERMISSION_PATTERN.test(String(code ?? "")) || DINGTALK_PERMISSION_PATTERN.test(msg);
  if (!denied) return null;
  return (
    "钉钉机器人权限不足：请在钉钉开发者后台为该应用开通「企业内机器人发消息权限」等所需权限，" +
    "并在【版本管理与发布】发布新版本后生效。原始提示：" +
    (msg || String(code ?? "") || "无")
  );
}

export class DingtalkConfig {
  enabled = false;
  clientId = "";
  clientSecret = "";
  allowFrom: string[] = [];
  allowRemoteMediaRedirects = false;
  remoteMediaRedirectAllowedHosts: string[] = [];

  constructor(init: Partial<DingtalkConfig> & Record<string, any> = {}) {
    this.enabled = Boolean(coalesce(init.enabled, this.enabled));
    this.clientId = coalesce(init.clientId, this.clientId) ?? "";
    this.clientSecret = coalesce(init.clientSecret, this.clientSecret) ?? "";
    this.allowFrom = asArray(coalesce(init.allowFrom, this.allowFrom));
    this.allowRemoteMediaRedirects = Boolean(
      coalesce(init.allowRemoteMediaRedirects, this.allowRemoteMediaRedirects),
    );
    this.remoteMediaRedirectAllowedHosts = asArray(
      coalesce(init.remoteMediaRedirectAllowedHosts, this.remoteMediaRedirectAllowedHosts),
    );
  }
}

export class MemmyDingTalkHandler {
  channel: DingtalkChannel;

  constructor(channel: DingtalkChannel) {
    this.channel = channel;
  }

  async process(message: any): Promise<[string, string]> {
    try {
      const data = message?.data ?? {};
      const raw = data.text?.content ?? "";
      const senderId = String(data.senderStaffId ?? data.senderId ?? "unknown");
      const senderName = String(data.senderNick ?? "Unknown");
      let content = String(
        raw || data.extensions?.content?.recognition || data.content?.recognition || "",
      ).trim();
      const fileInfo = data.content ?? {};
      const downloadCode = fileInfo.downloadCode;
      const fileName = fileInfo.fileName;
      if (!content && downloadCode && fileName) {
        const downloaded = await this.channel.downloadDingtalkFile(
          String(downloadCode),
          String(fileName),
          senderId,
        );
        content = downloaded ? `[File] ${fileName}\n${downloaded}` : `[File] ${fileName}`;
      }
      await this.channel.onMessage(
        content,
        senderId,
        senderName,
        data.conversationType,
        data.conversationId ?? data.openConversationId,
      );
      return ["OK", "OK"];
    } catch {
      return ["OK", "Error"];
    }
  }
}

export class DingtalkChannel extends BaseChannel {
  override name = "dingtalk";
  override displayName = "DingTalk";
  override config: DingtalkConfig;
  http: any = null;
  streamClient: any = null;
  handler: MemmyDingTalkHandler;
  accessToken: string | null = null;
  tokenExpiry = 0;
  backgroundTasks = new Set<Promise<any>>();
  imageExtensions = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"]);
  audioExtensions = new Set([".amr", ".mp3", ".wav", ".ogg", ".m4a", ".aac"]);
  videoExtensions = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm"]);
  zipBeforeUploadExtensions = new Set([".htm", ".html"]);

  static override defaultConfig(): Record<string, any> {
    return new DingtalkConfig() as any;
  }

  constructor(config: Partial<DingtalkConfig> & Record<string, any> = {}, bus?: any) {
    const normalized = config instanceof DingtalkConfig ? config : new DingtalkConfig(config);
    super("dingtalk", normalized, bus);
    this.config = normalized;
    this.handler = new MemmyDingTalkHandler(this);
  }

  override async start(): Promise<void> {
    if (!this.config.clientId || !this.config.clientSecret) return;
    this.http = this.http ?? createDingtalkFetchHttpClient();
    await this.startStreamClient().catch(() => undefined);
    this.running = true;
  }

  override async stop(): Promise<void> {
    this.running = false;
    await this.streamClient?.disconnect?.();
    await this.streamClient?.close?.();
    this.streamClient = null;
    await this.http?.aclose?.();
    await this.http?.close?.();
    this.http = null;
    this.backgroundTasks.clear();
  }

  override permissionErrorHint(error: unknown): string | null {
    return dingtalkPermissionHint(error);
  }

  async startStreamClient(): Promise<void> {
    if (this.streamClient) return;
    try {
      const mod = await import("dingtalk-stream");
      const Client =
        (mod as any).DWClient ??
        (mod as any).DingTalkStreamClient ??
        (mod as any).DingTalkStream ??
        (mod as any).default;
      if (!Client) return;
      // Robot one-to-one and group messages are CALLBACK events on TOPIC_ROBOT and must use registerCallbackListener.
      // registerAllEventListener only receives EVENT types, such as contact or approval organization events, and will not receive robot messages.
      const robotTopic = (mod as any).TOPIC_ROBOT ?? "/v1.0/im/bot/messages/get";
      this.streamClient = new Client({
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
      });
      this.streamClient.registerCallbackListener?.(robotTopic, async (res: any) => {
        const messageId = res?.headers?.messageId;
        try {
          // Server-delivered data is a JSON string, so parse it into the robot message object before passing it to the handler.
          const payload = typeof res?.data === "string" ? JSON.parse(res.data) : (res?.data ?? {});
          await this.handler.process({ data: payload });
        } catch {
          // Ignore per-message handling errors to keep the long connection stable.
        } finally {
          // Acknowledge the server to avoid receiving the same message again within 60 seconds.
          this.streamClient?.socketCallBackResponse?.(messageId, {});
        }
      });
      await this.streamClient.start?.();
      await this.streamClient.connect?.();
    } catch {
      this.streamClient = null;
    }
  }

  async getAccessToken(): Promise<string | null> {
    if (this.accessToken && Date.now() / 1000 < this.tokenExpiry) return this.accessToken;
    if (!this.http) return null;
    const resp = await this.http.post("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
      json: { appKey: this.config.clientId, appSecret: this.config.clientSecret },
    });
    resp.raiseForStatus?.();
    const body = responseJson(resp);
    this.accessToken = body.accessToken ?? null;
    this.tokenExpiry = Date.now() / 1000 + Number(body.expireIn ?? 7200) - 60;
    return this.accessToken;
  }

  static isHttpUrl(value: string): boolean {
    try {
      return ["http:", "https:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }

  guessUploadType(mediaRef: string): string {
    const ext = path.extname(new URL(mediaRef, "file:///").pathname).toLowerCase();
    if (this.imageExtensions.has(ext)) return "image";
    if (this.audioExtensions.has(ext)) return "voice";
    if (this.videoExtensions.has(ext)) return "video";
    return "file";
  }

  guessFilename(mediaRef: string, uploadType: string): string {
    let pathname = "";
    try {
      pathname = new URL(mediaRef).pathname;
    } catch {
      pathname = mediaRef;
    }
    const name = path.basename(decodeURIComponent(pathname));
    return (
      name ||
      ({ image: "image.jpg", voice: "audio.amr", video: "video.mp4" } as Record<string, string>)[
        uploadType
      ] ||
      "file.bin"
    );
  }

  static zipBytes(filename: string, data: Buffer | Uint8Array): [Buffer, string, string] {
    const safeName = filename || "attachment.bin";
    const stem = path.basename(safeName, path.extname(safeName)) || "attachment";
    return [zipSingleFile(safeName, Buffer.from(data)), `${stem}.zip`, "application/zip"];
  }

  normalizeUploadPayload(
    filename: string,
    data: Buffer | Uint8Array,
    contentType: string | null,
  ): [Buffer, string, string | null] {
    const ext = path.extname(filename).toLowerCase();
    if (this.zipBeforeUploadExtensions.has(ext) || contentType === "text/html")
      return DingtalkChannel.zipBytes(filename, Buffer.from(data));
    return [Buffer.from(data), filename, contentType];
  }

  async validateRemoteMediaUrl(mediaRef: string): Promise<boolean> {
    const [ok] = await validateUrlTarget(mediaRef);
    return ok;
  }

  async validateResolvedRemoteMediaUrl(mediaRef: string): Promise<boolean> {
    const [ok] = await validateResolvedUrl(mediaRef);
    return ok;
  }

  isRedirectHostAllowed(currentUrl: string, nextUrl: string): boolean {
    const current = new URL(currentUrl).hostname.toLowerCase();
    const next = new URL(nextUrl).hostname.toLowerCase();
    if (!next) return false;
    if (next === current) return true;
    return this.config.remoteMediaRedirectAllowedHosts
      .map((host) => host.toLowerCase())
      .includes(next);
  }

  async nextRemoteMediaUrl(currentUrl: string, location?: string | null): Promise<string | null> {
    if (!this.config.allowRemoteMediaRedirects || !location) return null;
    const next = new URL(location, currentUrl).toString();
    if (!this.isRedirectHostAllowed(currentUrl, next)) return null;
    return (await this.validateRemoteMediaUrl(next)) ? next : null;
  }

  async fetchRemoteMediaBytes(mediaRef: string): Promise<[Buffer | null, string | null]> {
    if (!this.http || !(await this.validateRemoteMediaUrl(mediaRef))) return [null, null];
    let current = mediaRef;
    for (let redirects = 0; redirects <= DINGTALK_MAX_REMOTE_MEDIA_REDIRECTS; redirects += 1) {
      const resp = await this.http.get(current, { followRedirects: false });
      if (!(await this.validateResolvedRemoteMediaUrl(String(resp.url ?? current))))
        return [null, null];
      if (resp.statusCode >= 300 && resp.statusCode < 400) {
        const next = await this.nextRemoteMediaUrl(
          String(resp.url ?? current),
          resp.headers?.location,
        );
        if (!next) return [null, null];
        current = next;
        continue;
      }
      if (resp.statusCode >= 400) return [null, null];
      const content = responseContent(resp);
      if (content.length > DINGTALK_MAX_REMOTE_MEDIA_BYTES) return [null, null];
      return [content, String(resp.headers?.["content-type"] ?? "")];
    }
    return [null, null];
  }

  async readMediaBytes(mediaRef: string): Promise<[Buffer | null, string | null, string | null]> {
    if (!mediaRef) return [null, null, null];
    if (DingtalkChannel.isHttpUrl(mediaRef)) {
      const [data, rawContentType] = await this.fetchRemoteMediaBytes(mediaRef);
      if (!data) return [null, null, null];
      const type = (rawContentType || "").split(";")[0].trim() || null;
      return [data, this.guessFilename(mediaRef, this.guessUploadType(mediaRef)), type];
    }
    const localPath = mediaRef.startsWith("file://")
      ? new URL(mediaRef).pathname
      : mediaRef.replace(/^~(?=\/|$)/, process.env.HOME ?? "");
    try {
      const stat = await fs.stat(localPath);
      if (!stat.isFile()) return [null, null, null];
      return [await fs.readFile(localPath), path.basename(localPath), lookup(localPath) || null];
    } catch {
      return [null, null, null];
    }
  }

  async uploadMedia(
    token: string,
    data: Buffer,
    mediaType: string,
    filename: string,
    contentType: string | null,
  ): Promise<string | null> {
    if (!this.http) return null;
    const url = `https://oapi.dingtalk.com/media/upload?access_token=${token}&type=${mediaType}`;
    const mime = contentType || lookup(filename) || "application/octet-stream";
    const resp = await this.http.post(url, { files: { media: [filename, data, mime] } });
    const body = responseJson(resp);
    if (resp.statusCode >= 400 || (body.errcode != null && body.errcode !== 0)) return null;
    const nested = body.result ?? {};
    return body.media_id ?? body.mediaId ?? nested.media_id ?? nested.mediaId ?? null;
  }

  async sendBatchMessage(
    token: string,
    chatId: string,
    msgKey: string,
    msgParam: Record<string, any>,
  ): Promise<boolean> {
    if (!this.http) return false;
    const headers = { "x-acs-dingtalk-access-token": token };
    const isGroup = chatId.startsWith("group:");
    const payload = isGroup
      ? {
          robotCode: this.config.clientId,
          openConversationId: chatId.slice(6),
          msgKey,
          msgParam: JSON.stringify(msgParam),
        }
      : {
          robotCode: this.config.clientId,
          userIds: [chatId],
          msgKey,
          msgParam: JSON.stringify(msgParam),
        };
    const url = isGroup
      ? "https://api.dingtalk.com/v1.0/robot/groupMessages/send"
      : "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend";
    const resp = await this.http.post(url, { json: payload, headers });
    const body = responseJson(resp);
    if (resp.statusCode !== 200) {
      this.recordPermissionError({ statusCode: resp.statusCode, ...body });
      return false;
    }
    if (body.errcode != null && body.errcode !== 0) {
      this.recordPermissionError(body);
      return false;
    }
    // A successful send proves permissions are healthy, so clear stale warnings instead of leaving old permission alerts visible.
    this.lastError = null;
    return true;
  }

  async sendMarkdownText(token: string, chatId: string, content: string): Promise<boolean> {
    return this.sendBatchMessage(token, chatId, "sampleMarkdown", {
      text: content,
      title: "Memmy Reply",
    });
  }

  async sendMediaRef(token: string, chatId: string, mediaRef: string): Promise<boolean> {
    mediaRef = mediaRef.trim();
    if (!mediaRef) return true;
    const uploadType = this.guessUploadType(mediaRef);
    if (uploadType === "image" && DingtalkChannel.isHttpUrl(mediaRef)) {
      if (await this.sendBatchMessage(token, chatId, "sampleImageMsg", { photoURL: mediaRef }))
        return true;
    }
    let [data, filename, contentType] = await this.readMediaBytes(mediaRef);
    if (!data || !filename) return false;
    [data, filename, contentType] = this.normalizeUploadPayload(filename, data, contentType);
    let fileType =
      path.extname(filename).slice(1).toLowerCase() ||
      (lookup(filename) ? (String(lookup(filename)).split("/").pop() ?? "bin") : "bin");
    if (fileType === "jpeg") fileType = "jpg";
    const mediaId = await this.uploadMedia(token, data, uploadType, filename, contentType);
    if (!mediaId) return false;
    if (
      uploadType === "image" &&
      (await this.sendBatchMessage(token, chatId, "sampleImageMsg", { photoURL: mediaId }))
    )
      return true;
    return this.sendBatchMessage(token, chatId, "sampleFile", {
      mediaId,
      fileName: filename,
      fileType,
    });
  }

  override async send(msg: OutboundMessage): Promise<void> {
    const token = await this.getAccessToken();
    if (!token) return;
    if (msg.content.trim()) await this.sendMarkdownText(token, msg.chatId, msg.content.trim());
    for (const mediaRef of msg.media ?? []) {
      if (await this.sendMediaRef(token, msg.chatId, mediaRef)) continue;
      await this.sendMarkdownText(
        token,
        msg.chatId,
        `[Attachment send failed: ${this.guessFilename(mediaRef, this.guessUploadType(mediaRef))}]`,
      );
    }
  }

  async onMessage(
    content: string,
    senderId: string,
    senderName: string,
    conversationType?: string | null,
    conversationId?: string | null,
  ): Promise<void> {
    const isGroup = conversationType === "2" && Boolean(conversationId);
    await this.handleMessage({
      senderId,
      chatId: isGroup ? `group:${conversationId}` : senderId,
      content: String(content),
      metadata: { senderName, platform: "dingtalk", conversationType },
    });
  }

  async downloadDingtalkFile(
    downloadCode: string,
    filename: string,
    senderId: string,
  ): Promise<string | null> {
    const token = await this.getAccessToken();
    if (!token || !this.http) return null;
    const resp = await this.http.post("https://api.dingtalk.com/v1.0/robot/messageFiles/download", {
      json: { downloadCode, robotCode: this.config.clientId },
      headers: { "x-acs-dingtalk-access-token": token, "Content-Type": "application/json" },
    });
    if (resp.statusCode !== 200) return null;
    const downloadUrl = responseJson(resp).downloadUrl;
    if (!downloadUrl) return null;
    const fileResp = await this.http.get(downloadUrl, { followRedirects: true });
    if (fileResp.statusCode !== 200) return null;
    const dir = path.join(getMediaDir("dingtalk"), safeFilename(senderId));
    await fs.mkdir(dir, { recursive: true });
    const dest = path.join(dir, safeFilename(filename));
    await fs.writeFile(dest, responseContent(fileResp));
    return dest;
  }
}

function headersObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function createDingtalkFetchHttpClient(): any {
  async function request(method: string, url: string, options: any = {}): Promise<any> {
    let body: any;
    let headers = options.headers ?? {};
    if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      headers = { "Content-Type": "application/json", ...headers };
    } else if (options.files?.media) {
      const [filename, data, mime] = options.files.media;
      const form = new FormData();
      form.append("media", new Blob([Buffer.from(data)], { type: mime }), filename);
      body = form;
    }
    const response = await fetch(url, {
      method,
      headers,
      body,
      redirect: options.followRedirects === false ? "manual" : "follow",
    });
    const content = Buffer.from(await response.arrayBuffer());
    const text = content.toString("utf8");
    return {
      statusCode: response.status,
      headers: headersObject(response.headers),
      content,
      text,
      json: () => JSON.parse(text || "{}"),
      raiseForStatus: () => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      },
    };
  }
  return {
    post: (url: string, options: any = {}) => request("POST", url, options),
    get: (url: string, options: any = {}) => request("GET", url, options),
    close: async () => undefined,
    aclose: async () => undefined,
  };
}
