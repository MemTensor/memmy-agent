import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { OutboundMessage } from "../../core/runtime-messages/index.js";
import { getMediaDir } from "../../config/paths.js";
import { BaseChannel } from "./base.js";

export const WECOM_AVAILABLE = true;
export const WECOM_UPLOAD_MAX_BYTES = 1024 * 1024 * 200;

const SAFE_NAME_RE = /[^\w.\-()[\]（）【】\u4e00-\u9fff]+/gu;
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
const VIDEO_EXTS = new Set([".mp4", ".avi", ".mov"]);
const AUDIO_EXTS = new Set([".amr", ".mp3", ".wav", ".ogg"]);
const MSG_TYPE_MAP: Record<string, string> = {
  image: "[image]",
  voice: "[voice]",
  file: "[file]",
  mixed: "[mixed content]",
};

function coalesce<T>(...values: Array<T | null | undefined>): T | undefined {
  for (const value of values) if (value !== undefined && value !== null) return value;
  return undefined;
}

function asArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export function sanitizeFilename(name: string): string {
  const base = path.basename(String(name || "").trim());
  return base.replace(SAFE_NAME_RE, "_").replace(/^[._ ]+|[._ ]+$/g, "");
}

export function guessWecomMediaType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "voice";
  return "file";
}

export class WecomConfig {
  enabled = false;
  botId = "";
  secret = "";
  allowFrom: string[] = [];
  welcomeMessage = "";

  constructor(init: Partial<WecomConfig> & Record<string, any> = {}) {
    this.enabled = Boolean(coalesce(init.enabled, this.enabled));
    this.botId = coalesce(init.botId, this.botId) ?? "";
    this.secret = coalesce(init.secret, this.secret) ?? "";
    this.allowFrom = asArray(coalesce(init.allowFrom, this.allowFrom));
    this.welcomeMessage = coalesce(init.welcomeMessage, this.welcomeMessage) ?? "";
  }
}

export class WecomChannel extends BaseChannel {
  override name = "wecom";
  override displayName = "WeCom";
  override config: WecomConfig;
  client: any = null;
  processedMessageIds = new Map<string, null>();
  chatFrames: Record<string, any> = {};
  generateReqId: ((prefix: string) => string) | null = null;

  static override defaultConfig(): Record<string, any> {
    return new WecomConfig() as any;
  }

  constructor(config: Partial<WecomConfig> & Record<string, any> = {}, bus?: any) {
    const normalized = config instanceof WecomConfig ? config : new WecomConfig(config);
    super("wecom", normalized, bus);
    this.config = normalized;
  }

  override async start(): Promise<void> {
    if (!this.config.botId || !this.config.secret) return;
    if (!this.client) this.client = await this.createDefaultClient();
    await this.client?.connect?.();
    await this.client?.start?.();
    this.running = true;
  }

  override async stop(): Promise<void> {
    this.running = false;
    await this.client?.disconnect?.();
    await this.client?.close?.();
  }

  async createDefaultClient(): Promise<any> {
    const mod = await import("@wecom/aibot-node-sdk");
    const Client = (mod as any).WSClient ?? (mod as any).default;
    const client = new Client({ botId: this.config.botId, secret: this.config.secret });
    const bind = (event: string, handler: (frame: any) => Promise<void>) => {
      client.on?.(event, (frame: any) => {
        void handler.call(this, frame);
      });
    };
    bind("connected", this.onConnected);
    bind("authenticated", this.onAuthenticated);
    bind("disconnected", this.onDisconnected);
    bind("error", this.onError);
    for (const event of ["text", "message.text"]) bind(event, this.onTextMessage);
    for (const event of ["image", "message.image"]) bind(event, this.onImageMessage);
    for (const event of ["voice", "message.voice"]) bind(event, this.onVoiceMessage);
    for (const event of ["file", "message.file"]) bind(event, this.onFileMessage);
    bind("message.mixed", this.onMixedMessage);
    bind("event.enter_chat", this.onEnterChat);
    bind("event", (frame: any) => this.processMessage(frame, String(frame?.msgtype ?? frame?.msgType ?? "event")));
    bind("message", (frame: any) => this.processMessage(frame, String(frame?.msgtype ?? frame?.msgType ?? "text")));
    return client;
  }

  async onConnected(frame: any): Promise<void> {}
  async onAuthenticated(frame: any): Promise<void> {}
  async onDisconnected(frame: any): Promise<void> {}
  async onError(frame: any): Promise<void> {}

  async onTextMessage(frame: any): Promise<void> {
    return this.processMessage(frame, "text");
  }
  async onImageMessage(frame: any): Promise<void> {
    return this.processMessage(frame, "image");
  }
  async onVoiceMessage(frame: any): Promise<void> {
    return this.processMessage(frame, "voice");
  }
  async onFileMessage(frame: any): Promise<void> {
    return this.processMessage(frame, "file");
  }
  async onMixedMessage(frame: any): Promise<void> {
    return this.processMessage(frame, "mixed");
  }

  async onEnterChat(frame: any): Promise<void> {
    try {
      const body = frame?.body ?? frame?.body ?? frame ?? {};
      const chatId = typeof body === "object" ? String(body.chatid ?? "") : "";
      if (chatId && !this.isAllowed(chatId)) return;
      if (chatId && this.config.welcomeMessage) {
        await this.replyWelcome(frame, { msgtype: "text", text: { content: this.config.welcomeMessage } });
      }
    } catch {
      // best effort welcome
    }
  }

  async processMessage(frame: any, msgType: string): Promise<void> {
    try {
      const body = frame?.body ?? (typeof frame === "object" ? frame.body ?? frame : {});
      if (!body || typeof body !== "object") return;
      const msgId = String(body.msgid || `${body.chatid || ""}_${body.sendertime || ""}`);
      const fromInfo = body.from ?? {};
      const senderId = typeof fromInfo === "object" ? String(fromInfo.userid ?? "unknown") : "unknown";
      if (!this.isAllowed(senderId)) return;
      if (this.processedMessageIds.has(msgId)) return;
      this.processedMessageIds.set(msgId, null);
      while (this.processedMessageIds.size > 1000) {
        const first = this.processedMessageIds.keys().next().value;
        if (first === undefined) break;
        this.processedMessageIds.delete(first);
      }

      const chatType = body.chattype ?? "single";
      const chatId = String(body.chatid || senderId);
      const contentParts: string[] = [];
      const mediaPaths: string[] = [];

      if (msgType === "text") {
        const text = body.text?.content ?? "";
        if (text) contentParts.push(String(text));
      } else if (msgType === "image") {
        const filePath = await this.downloadAndSaveMedia(body.image?.url ?? "", body.image?.aeskey ?? "", "image");
        if (filePath) {
          contentParts.push(`[image: ${path.basename(filePath)}]`);
          mediaPaths.push(filePath);
        } else {
          contentParts.push("[image: download failed]");
        }
      } else if (msgType === "voice") {
        const text = body.voice?.content ?? "";
        contentParts.push(text ? `[voice] ${text}` : "[voice]");
      } else if (msgType === "file") {
        const fileName = body.file?.name || null;
        const filePath = await this.downloadAndSaveMedia(body.file?.url ?? "", body.file?.aeskey ?? "", "file", fileName);
        if (filePath) {
          contentParts.push(`[file: ${path.basename(filePath)}]`);
          mediaPaths.push(filePath);
        } else {
          contentParts.push(`[file: ${fileName || "unknown"}: download failed]`);
        }
      } else if (msgType === "mixed") {
        for (const item of body.mixed?.msg_item ?? []) {
          const itemType = item.msgtype ?? "";
          if (itemType === "text") {
            const text = item.text?.content ?? "";
            if (text) contentParts.push(String(text));
          } else if (itemType === "image") {
            const filePath = await this.downloadAndSaveMedia(item.image?.url ?? "", item.image?.aeskey ?? "", "image");
            if (filePath) {
              contentParts.push(`[image: ${path.basename(filePath)}]`);
              mediaPaths.push(filePath);
            }
          } else {
            contentParts.push(MSG_TYPE_MAP[itemType] ?? `[${itemType}]`);
          }
        }
      } else {
        contentParts.push(MSG_TYPE_MAP[msgType] ?? `[${msgType}]`);
      }

      const content = contentParts.join("\n");
      if (!content) return;
      this.chatFrames[chatId] = frame;
      await this.handleMessage({
        senderId,
        chatId,
        content,
        media: mediaPaths,
        metadata: { messageId: msgId, msgType, chatType },
      });
    } catch {
      // Message processing should not crash the websocket receive loop.
    }
  }

  async downloadAndSaveMedia(fileUrl: string, aesKey: string, mediaType: string, filename?: string | null): Promise<string | null> {
    try {
      if (!this.client || !fileUrl || !aesKey) return null;
      const [data, sdkName] = await this.downloadFile(fileUrl, aesKey);
      if (!data) return null;
      const buf = Buffer.from(data);
      if (buf.length > WECOM_UPLOAD_MAX_BYTES) return null;
      const mediaDir = getMediaDir("wecom");
      fs.mkdirSync(mediaDir, { recursive: true });
      const finalName = sanitizeFilename(filename || sdkName || `${mediaType}-${Math.abs(hashString(fileUrl))}`);
      if (!finalName) return null;
      const dest = path.join(mediaDir, finalName);
      await fsp.writeFile(dest, buf);
      return dest;
    } catch {
      return null;
    }
  }

  private async downloadFile(fileUrl: string, aesKey: string): Promise<[Buffer | null, string | null]> {
    return this.client?.downloadFile?.(fileUrl, aesKey) ?? this.client?.download_file?.(fileUrl, aesKey) ?? [null, null];
  }

  nextReqId(prefix: string): string {
    return this.generateReqId?.(prefix) ?? `${prefix}-${crypto.randomUUID()}`;
  }

  async uploadMediaWs(client: any, filePath: string): Promise<[string | null, string | null]> {
    try {
      const fileSize = fs.statSync(filePath).size;
      if (fileSize > WECOM_UPLOAD_MAX_BYTES) throw new Error("File too large");
      const data = fs.readFileSync(filePath);
      const filename = path.basename(filePath);
      const mediaType = guessWecomMediaType(filename);
      const md5 = crypto.createHash("md5").update(data).digest("hex");
      const chunkSize = 512 * 1024;
      const chunks: Buffer[] = [];
      for (let offset = 0; offset < data.length; offset += chunkSize) chunks.push(data.subarray(offset, offset + chunkSize));

      let resp = await this.sendWsReply(
        client,
        this.nextReqId("upload-init"),
        { type: mediaType, filename, total_size: fileSize, total_chunks: chunks.length, md5 },
        "aibot_upload_media_init",
      );
      if (resp.errcode !== 0) return [null, null];
      const uploadId = resp.body?.upload_id;
      if (!uploadId) return [null, null];
      for (const [index, chunk] of chunks.entries()) {
        resp = await this.sendWsReply(
          client,
          this.nextReqId("upload-chunk"),
          { upload_id: uploadId, chunk_index: index, base64_data: chunk.toString("base64") },
          "aibot_upload_media_chunk",
        );
        if (resp.errcode !== 0) return [null, null];
      }
      resp = await this.sendWsReply(client, this.nextReqId("upload-finish"), { upload_id: uploadId }, "aibot_upload_media_finish");
      if (resp.errcode !== 0 || !resp.body?.media_id) return [null, null];
      return [resp.body.media_id, mediaType];
    } catch {
      return [null, null];
    }
  }

  private async sendWsReply(client: any, reqId: string, data: Record<string, any>, cmd: string): Promise<any> {
    const manager = client.wsManager ?? client._ws_manager;
    return manager?.sendReply?.(reqId, data, cmd) ?? manager?.send_reply?.(reqId, data, cmd);
  }

  override async send(msg: OutboundMessage): Promise<void> {
    if (!this.client) return;
    try {
      let content = (msg.content || "").trim();
      const isProgress = Boolean(msg.metadata?.agentProgress);
      const frame = this.chatFrames[msg.chatId];
      for (const filePath of msg.media ?? []) {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
        const [mediaId, mediaType] = await this.uploadMediaWs(this.client, filePath);
        if (mediaId && mediaType) {
          const payload = { msgtype: mediaType, [mediaType]: { media_id: mediaId } };
          if (frame) await this.reply(frame, payload);
          else await this.sendMessage(msg.chatId, payload);
        } else {
          content += `\n[file upload failed: ${path.basename(filePath)}]`;
        }
      }
      if (!content) return;
      if (frame) {
        await this.replyStream(frame, this.nextReqId("stream"), content, { finish: !isProgress });
      } else {
        await this.sendMessage(msg.chatId, { msgtype: "markdown", markdown: { content } });
      }
    } catch {
      // Keep channel sends best-effort; a platform failure should not crash the agent loop.
    }
  }

  private async reply(frame: any, payload: Record<string, any>): Promise<void> {
    await (this.client?.reply?.(frame, payload));
  }

  private async replyStream(frame: any, reqId: string, content: string, options: Record<string, any>): Promise<void> {
    await (this.client?.replyStream?.(frame, reqId, content, options) ?? this.client?.reply_stream?.(frame, reqId, content, options));
  }

  private async replyWelcome(frame: any, payload: Record<string, any>): Promise<void> {
    await (this.client?.replyWelcome?.(frame, payload) ?? this.client?.reply_welcome?.(frame, payload));
  }

  private async sendMessage(chatId: string, payload: Record<string, any>): Promise<void> {
    await (this.client?.sendMessage?.(chatId, payload) ?? this.client?.send_message?.(chatId, payload));
  }
}

function hashString(value: string): number {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return hash;
}
