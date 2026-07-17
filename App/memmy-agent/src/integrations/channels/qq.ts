import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OutboundMessage } from "../../core/runtime-messages/index.js";
import { getMediaDir } from "../../config/paths.js";
import { BaseChannel } from "./base.js";

export const QQ_FILE_TYPE_IMAGE = 1;
export const QQ_FILE_TYPE_FILE = 4;

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tif", ".tiff", ".ico", ".svg"]);
const SAFE_NAME_RE = /[^\w.\-()[\]（）【】\u4e00-\u9fff]+/gu;

function coalesce<T>(...values: T[]): T | undefined {
  return values.find((value) => value !== undefined && value !== null && value !== "") as T | undefined;
}

function isNetworkError(error: any): boolean {
  const name = String(error?.name ?? error?.constructor?.name ?? "");
  const code = String(error?.code ?? "");
  return /(Client.*Error|Network|Timeout|Disconnected|Connect|Abort|FetchError|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN)/i.test(
    `${name} ${code}`,
  );
}

export function sanitizeFilename(name: string): string {
  const base = path.basename(String(name || "").trim());
  return base.replace(SAFE_NAME_RE, "_").replace(/^[._ ]+|[._ ]+$/g, "");
}

export function isImageName(name: string): boolean {
  return IMAGE_EXTS.has(path.extname(String(name)).toLowerCase());
}

export function guessSendFileType(filename: string): number {
  return isImageName(filename) ? QQ_FILE_TYPE_IMAGE : QQ_FILE_TYPE_FILE;
}

export class QQConfig {
  enabled = false;
  appId = "";
  secret = "";
  allowFrom: string[] = [];
  msgFormat: "plain" | "markdown" = "plain";
  ackMessage = "⏳ Processing...";
  mediaDir = "";
  downloadChunkSize = 1024 * 256;
  downloadMaxBytes = 1024 * 1024 * 200;

  constructor(init: Partial<QQConfig> & Record<string, any> = {}) {
    this.enabled = Boolean(coalesce(init.enabled, this.enabled));
    this.appId = String(coalesce(init.appId, this.appId));
    this.secret = String(coalesce(init.secret, this.secret));
    this.allowFrom = [...(coalesce(init.allowFrom, this.allowFrom) ?? [])];
    this.msgFormat = coalesce(init.msgFormat, this.msgFormat) as "plain" | "markdown";
    this.ackMessage = String(init.ackMessage ?? this.ackMessage);
    this.mediaDir = String(coalesce(init.mediaDir, this.mediaDir));
    this.downloadChunkSize = Number(coalesce(init.downloadChunkSize, this.downloadChunkSize));
    this.downloadMaxBytes = Number(coalesce(init.downloadMaxBytes, this.downloadMaxBytes));
  }
}

async function createDefaultQQClient(config: QQConfig): Promise<any> {
  const qq = await import("@tencent-connect/openclaw-qqbot");
  qq.initApiConfig?.({ markdownSupport: config.msgFormat === "markdown" });
  const token = () => qq.getAccessToken(config.appId, config.secret);

  const uploadBase64File = async (payload: Record<string, any>): Promise<any> => {
    const accessToken = await token();
    const isGroup = Boolean(payload.group_openid);
    const chatId = String(payload.group_openid ?? payload.openid ?? "");
    const fileType = Number(payload.file_type ?? QQ_FILE_TYPE_FILE);
    const result = isGroup
      ? await qq.uploadGroupMedia(accessToken, chatId, fileType as any, undefined, payload.file_data, payload.srv_send_msg, payload.file_name)
      : await qq.uploadC2CMedia(accessToken, chatId, fileType as any, undefined, payload.file_data, payload.srv_send_msg, payload.file_name);
    return result && typeof result === "object" && "file_info" in result ? { file_info: result.file_info } : result;
  };

  const sendMessage = async (payload: Record<string, any>, isGroup: boolean): Promise<any> => {
    const accessToken = await token();
    const chatId = String(isGroup ? payload.group_openid : payload.openid);
    const text = String(payload.markdown?.content ?? payload.content ?? "");
    if (payload.media?.file_info) {
      return isGroup
        ? qq.sendGroupMediaMessage(accessToken, chatId, payload.media.file_info, payload.msg_id, text)
        : qq.sendC2CMediaMessage(accessToken, chatId, payload.media.file_info, payload.msg_id, text);
    }
    return isGroup ? qq.sendGroupMessage(accessToken, chatId, text, payload.msg_id) : qq.sendC2CMessage(accessToken, chatId, text, payload.msg_id);
  };

  return {
    api: {
      postC2cMessage: (payload: Record<string, any>) => sendMessage(payload, false),
      post_c2c_message: (payload: Record<string, any>) => sendMessage(payload, false),
      postGroupMessage: (payload: Record<string, any>) => sendMessage(payload, true),
      post_group_message: (payload: Record<string, any>) => sendMessage(payload, true),
      postBase64File: uploadBase64File,
      post_base64file: uploadBase64File,
      http: {
        request: async (route: Record<string, any>, body: Record<string, any>) => {
          if (body?.json?.file_data) return uploadBase64File(body.json);
          const accessToken = await token();
          return qq.apiRequest(accessToken, route.method ?? "POST", route.endpoint ?? route.path ?? "", body?.json ?? body);
        },
      },
    },
    start: async () => {
      await token();
    },
    close: async () => undefined,
  };
}

export class QQChannel extends BaseChannel {
  override displayName = "QQ";
  declare config: QQConfig;
  client: any = null;
  processedIds: string[] = [];
  messageSeq = 1;
  chatTypeCache: Record<string, "c2c" | "group"> = {};
  mediaRoot: string;

  constructor(config: any = {}, bus?: any) {
    super("qq", config instanceof QQConfig ? config : new QQConfig(config), bus);
    this.config = config instanceof QQConfig ? config : new QQConfig(config);
    this.mediaRoot = this.initMediaRoot();
  }

  static override defaultConfig(): Record<string, any> {
    return { ...new QQConfig() };
  }

  initMediaRoot(): string {
    const root = this.config.mediaDir || getMediaDir("qq");
    fs.mkdirSync(root, { recursive: true });
    return root;
  }

  override async start(): Promise<void> {
    this.running = true;
    if (!this.config.appId || !this.config.secret) return;
    this.client = this.client ?? (await createDefaultQQClient(this.config));
    if (this.client?.start) await this.client.start({ appid: this.config.appId, secret: this.config.secret });
  }

  override async stop(): Promise<void> {
    this.running = false;
    if (this.client?.close) await this.client.close();
    this.client = null;
  }

  override async send(msg: OutboundMessage): Promise<void> {
    try {
      if (!this.client) return;
      const msgId = msg.metadata?.messageId ?? null;
      const chatType = this.chatTypeCache[msg.chatId] ?? "c2c";
      const isGroup = chatType === "group";

      for (const mediaRef of msg.media ?? []) {
        const ok = await this.sendMedia(msg.chatId, mediaRef, msgId, isGroup);
        if (!ok) {
          const filename = path.basename(new URL(mediaRef, "file:///").pathname) || path.basename(mediaRef) || "file";
          await this.sendTextOnly(msg.chatId, isGroup, msgId, `[Attachment send failed: ${filename}]`);
        }
      }

      if (msg.content?.trim()) await this.sendTextOnly(msg.chatId, isGroup, msgId, msg.content.trim());
    } catch (error) {
      if (isNetworkError(error)) throw error;
      // QQ API-level outbound failures are best-effort; channel adapters should not crash the agent loop.
    }
  }

  async sendTextOnly(chatId: string, isGroup: boolean, msgId: string | null, content: string): Promise<void> {
    if (!this.client) return;
    this.messageSeq += 1;
    const useMarkdown = this.config.msgFormat === "markdown";
    const payload: Record<string, any> = {
      msg_type: useMarkdown ? 2 : 0,
      msg_id: msgId,
      msg_seq: this.messageSeq,
    };
    if (useMarkdown) payload.markdown = { content };
    else payload.content = content;

    if (isGroup) await this.postGroupMessage({ group_openid: chatId, ...payload });
    else await this.postC2cMessage({ openid: chatId, ...payload });
  }

  async sendMedia(chatId: string, mediaRef: string, msgId: string | null, isGroup: boolean): Promise<boolean> {
    if (!this.client) return false;
    const [data, filename] = await this.readMediaBytes(mediaRef);
    if (!data || !filename) return false;
    try {
      const fileType = guessSendFileType(filename);
      const media = await this.postBase64File(chatId, isGroup, fileType, data.toString("base64"), filename, false);
      if (!media) return false;
      this.messageSeq += 1;
      const payload = { msg_type: 7, msg_id: msgId, msg_seq: this.messageSeq, media };
      if (isGroup) await this.postGroupMessage({ group_openid: chatId, ...payload });
      else await this.postC2cMessage({ openid: chatId, ...payload });
      return true;
    } catch (error) {
      if (isNetworkError(error)) throw error;
      return false;
    }
  }

  async readMediaBytes(mediaRef: string): Promise<[Buffer | null, string | null]> {
    const ref = String(mediaRef || "").trim();
    if (!ref) return [null, null];

    if (!/^https?:\/\//i.test(ref)) {
      try {
        const localPath = ref.startsWith("file://") ? fileURLToPath(ref) : path.resolve(ref.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
        if (!fs.existsSync(localPath) || !fs.statSync(localPath).isFile()) return [null, null];
        return [fs.readFileSync(localPath), path.basename(localPath)];
      } catch {
        return [null, null];
      }
    }

    try {
      const response = await fetch(ref, { redirect: "follow" });
      if (!response.ok) return [null, null];
      const data = Buffer.from(await response.arrayBuffer());
      if (!data.length) return [null, null];
      return [data, path.basename(new URL(ref).pathname) || "file.bin"];
    } catch {
      return [null, null];
    }
  }

  async postBase64File(chatId: string, isGroup: boolean, fileType: number, fileData: string, fileName: string | null = null, srvSendMsg = false): Promise<any> {
    if (!this.client) throw new Error("QQ client not initialized");
    const endpoint = isGroup ? "/v2/groups/{group_openid}/files" : "/v2/users/{openid}/files";
    const idKey = isGroup ? "group_openid" : "openid";
    const payload: Record<string, any> = {
      [idKey]: chatId,
      file_type: fileType,
      file_data: fileData,
      srv_send_msg: srvSendMsg,
    };
    if (fileType !== QQ_FILE_TYPE_IMAGE && fileName) payload.file_name = fileName;
    const result =
      (await this.requestApi({ method: "POST", endpoint, [idKey]: chatId }, { json: payload })) ??
      (await this.postBase64FileViaApi(payload));
    return result && typeof result === "object" && "file_info" in result ? { file_info: result.file_info } : result;
  }

  private async postC2cMessage(payload: Record<string, any>): Promise<any> {
    const api = this.client?.api;
    return api?.postC2cMessage?.(payload) ?? api?.post_c2c_message?.(payload);
  }

  private async postGroupMessage(payload: Record<string, any>): Promise<any> {
    const api = this.client?.api;
    return api?.postGroupMessage?.(payload) ?? api?.post_group_message?.(payload);
  }

  private async postBase64FileViaApi(payload: Record<string, any>): Promise<any> {
    const api = this.client?.api;
    return api?.postBase64File?.(payload) ?? api?.post_base64file?.(payload);
  }

  private async requestApi(route: Record<string, any>, body: Record<string, any>): Promise<any> {
    const api = this.client?.api;
    return api?.http?.request?.(route, body) ?? api?._http?.request?.(route, body);
  }

  async onMessage(data: any, isGroup = false): Promise<void> {
    const chatId = isGroup ? String(data.group_openid ?? "") : String(data.author?.id ?? data.author?.user_openid ?? "unknown");
    const userId = isGroup ? String(data.author?.member_openid ?? data.author?.id ?? "") : chatId;
    const messageId = String(data.id ?? "");
    if (!this.isAllowed(userId)) return;
    if (messageId && this.processedIds.includes(messageId)) return;
    if (messageId) {
      this.processedIds.push(messageId);
      if (this.processedIds.length > 1000) this.processedIds.shift();
    }
    this.chatTypeCache[chatId] = isGroup ? "group" : "c2c";

    const attachments = data.attachments ?? [];
    const [mediaPaths, recvLines, attMeta] = await this.handleAttachments(attachments);
    let content = String(data.content ?? "").trim();
    if (recvLines.length) {
      const tag = mediaPaths.some((p) => isImageName(path.basename(p))) ? "[Image]" : "[File]";
      const block = `Received files:\n${recvLines.join("\n")}`;
      content = content ? `${content}\n\n${block}` : `${tag}\n${block}`;
    }
    if (!content && !mediaPaths.length) return;

    if (this.config.ackMessage) {
      try {
        await this.sendTextOnly(chatId, isGroup, messageId, this.config.ackMessage);
      } catch {
        // Ack is best-effort.
      }
    }
    await this.handleMessage(userId, chatId, content, mediaPaths, { messageId, attachments: attMeta });
  }

  async handleAttachments(attachments: any[]): Promise<[string[], string[], Record<string, any>[]]> {
    const mediaPaths: string[] = [];
    const recvLines: string[] = [];
    const metadata: Record<string, any>[] = [];
    for (const att of attachments ?? []) {
      const url = att.url ?? "";
      const filename = att.filename ?? "";
      const contentType = att.content_type ?? att.contentType ?? "";
      const saved = await this.downloadToMediaDirChunked(url, filename);
      metadata.push({ url, filename, contentType, savedPath: saved });
      const shown = filename || (saved ? path.basename(saved) : url);
      if (saved) {
        mediaPaths.push(saved);
        recvLines.push(`- ${shown}\n  saved: ${saved}`);
      } else {
        recvLines.push(`- ${shown}\n  saved: [download failed]`);
      }
    }
    return [mediaPaths, recvLines, metadata];
  }

  async downloadToMediaDirChunked(url: string, filenameHint = ""): Promise<string | null> {
    let targetUrl = String(url || "");
    if (targetUrl.startsWith("//")) targetUrl = `https:${targetUrl}`;
    if (!targetUrl) return null;
    try {
      const response = await fetch(targetUrl, { redirect: "follow" });
      if (!response.ok) return null;
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length > this.config.downloadMaxBytes) return null;
      let ext = path.extname(new URL(targetUrl).pathname) || path.extname(filenameHint);
      if (!ext) {
        const type = response.headers.get("content-type") ?? "";
        if (type.includes("png")) ext = ".png";
        else if (type.includes("jpeg") || type.includes("jpg")) ext = ".jpg";
        else if (type.includes("gif")) ext = ".gif";
        else if (type.includes("webp")) ext = ".webp";
        else if (type.includes("pdf")) ext = ".pdf";
        else ext = ".bin";
      }
      const safe = sanitizeFilename(filenameHint);
      const baseName = safe ? (path.extname(safe) ? safe : `${safe}${ext}`) : `qq-file-${Date.now()}${ext}`;
      let target = path.join(this.mediaRoot, baseName);
      if (fs.existsSync(target)) {
        const parsed = path.parse(target);
        target = path.join(parsed.dir, `${parsed.name}_${Date.now()}${parsed.ext}`);
      }
      const tmp = `${target}.part`;
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, target);
      return target;
    } catch {
      return null;
    }
  }
}
