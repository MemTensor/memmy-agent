/**
 * Memmy WeChat channel implementation.
 *
 * This file handles WeChat QR-code login, long-poll message receiving, media
 * transfer, and reply delivery; the desktop UI only controls login through the
 * admin API.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import QRCode from "qrcode";
import { OutboundMessage } from "../../core/runtime-messages/index.js";
import { getMediaDir, getRuntimeSubdir } from "../../config/paths.js";
import { BaseChannel } from "./base.js";

export const ITEM_TEXT = 1;
export const ITEM_IMAGE = 2;
export const ITEM_VOICE = 3;
export const ITEM_FILE = 4;
export const ITEM_VIDEO = 5;

export const MESSAGE_TYPE_BOT = 2;
export const MESSAGE_STATE_FINISH = 2;

export const WEIXIN_MAX_MESSAGE_LEN = 4000;
export const WEIXIN_CHANNEL_VERSION = "2.1.1";
export const WECHAT_BRIDGE_FALLBACK_APP_ID = "bot";
export const WECHAT_BRIDGE_CLIENT_VERSION = buildClientVersion(WEIXIN_CHANNEL_VERSION);
export const BASE_INFO: Record<string, string> = { channel_version: WEIXIN_CHANNEL_VERSION };

export const ERRCODE_SESSION_EXPIRED = -14;
export const SESSION_PAUSE_DURATION_S = 60 * 60;
export const CONTEXT_TOKEN_MAX_AGE_S = 60;
export const MAX_CONSECUTIVE_FAILURES = 3;
export const BACKOFF_DELAY_S = 30;
export let RETRY_DELAY_S = 2;
export const MAX_QR_REFRESH_COUNT = 3;
export const TYPING_STATUS_TYPING = 1;
export const TYPING_STATUS_CANCEL = 2;
export const TYPING_TICKET_TTL_S = 24 * 60 * 60;
export let TYPING_KEEPALIVE_INTERVAL_S = 5;
export const CONFIG_CACHE_INITIAL_RETRY_S = 2;
export const CONFIG_CACHE_MAX_RETRY_S = 60 * 60;
export const DEFAULT_LONG_POLL_TIMEOUT_S = 35;

export const UPLOAD_MEDIA_IMAGE = 1;
export const UPLOAD_MEDIA_VIDEO = 2;
export const UPLOAD_MEDIA_FILE = 3;
export const UPLOAD_MEDIA_VOICE = 4;

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".ico", ".svg"]);
const VIDEO_EXTS = new Set([".mp4", ".avi", ".mov", ".mkv", ".webm", ".flv"]);
const VOICE_EXTS = new Set([".mp3", ".wav", ".amr", ".silk", ".ogg", ".m4a", ".aac", ".flac"]);

type TimerLike = ReturnType<typeof setTimeout>;

function buildClientVersion(version: string): number {
  const parts = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  return ((parts[0] & 0xff) << 16) | ((parts[1] & 0xff) << 8) | (parts[2] & 0xff);
}

function asArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function splitMessage(content: string, maxLen: number): string[] {
  if (content.length <= maxLen) return content ? [content] : [];
  const chunks: string[] = [];
  for (let index = 0; index < content.length; index += maxLen) chunks.push(content.slice(index, index + maxLen));
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function nowSeconds(): number {
  return Date.now() / 1000;
}

/**
 * Normalize the WeChat QR-code image source.
 *
 * @param value QR-code image content returned by the WeChat API, possibly a data URL, image URL, or raw base64.
 * @returns Image source directly renderable by browser `<img src>`.
 */
async function normalizeQrCodeImageSource(value: string): Promise<string> {
  const source = value.trim();
  if (!source || /^data:image\//i.test(source)) return source;
  if (/^https?:\/\//i.test(source)) {
    return QRCode.toDataURL(source, {
      errorCorrectionLevel: "M",
      margin: 1,
      scale: 8,
      type: "image/png"
    });
  }
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(source) && source.length >= 8) {
    return `data:image/png;base64,${source}`;
  }
  return source;
}

export function hasDownloadableMediaLocator(media: any): boolean {
  return Boolean(
    media &&
      typeof media === "object" &&
      (String(media.encrypt_query_param ?? "").trim() || String(media.full_url ?? "").trim()),
  );
}

/**
 * Memmy WeChat channel configuration.
 *
 * Field meanings:
 * - enabled: whether to enable the WeChat channel.
 * - allowFrom: WeChat user ID list allowed to access Memmy; `*` allows all users.
 * - appId: Memmy WeChat app ID used to generate QR-code authorization.
 * - baseUrl: WeChat bridge API root URL.
 * - cdnBaseUrl: WeChat media CDN root URL.
 * - routeTag: bridge service gray-release or routing tag.
 * - token: channel login token obtained after QR-code login, recoverable from the state file.
 * - stateDir: local state directory for the WeChat channel.
 * - pollTimeout: long-poll timeout in seconds.
 * - sendToolHints: whether to send tool execution hints to WeChat.
 */
export class WeixinConfig {
  enabled = false;
  allowFrom: string[] = [];
  appId = "";
  baseUrl = "https://ilinkai.weixin.qq.com";
  cdnBaseUrl = "https://novac2c.cdn.weixin.qq.com/c2c";
  routeTag: string | number | null = null;
  token = "";
  stateDir = "";
  pollTimeout = DEFAULT_LONG_POLL_TIMEOUT_S;
  sendToolHints = false;

  constructor(init: Partial<WeixinConfig> = {}) {
    this.enabled = init.enabled ?? this.enabled;
    this.allowFrom = asArray(init.allowFrom ?? this.allowFrom);
    this.appId = init.appId ?? this.appId;
    this.baseUrl = init.baseUrl ?? this.baseUrl;
    this.cdnBaseUrl = init.cdnBaseUrl ?? this.cdnBaseUrl;
    this.routeTag = init.routeTag ?? null;
    this.token = init.token ?? this.token;
    this.stateDir = init.stateDir ?? this.stateDir;
    this.pollTimeout = init.pollTimeout ?? this.pollTimeout;
    this.sendToolHints = init.sendToolHints ?? this.sendToolHints;
  }
}

export class WeixinChannel extends BaseChannel {
  override name = "weixin";
  override displayName = "WeChat";
  override config: WeixinConfig;
  client: any = null;
  getUpdatesBuffer = "";
  contextTokens: Record<string, string> = {};
  contextTokenTimestamps: Record<string, number> = {};
  processedIds = new Map<string, null>();
  stateDirPath: string | null = null;
  authToken = "";
  pollTask: Promise<void> | null = null;
  nextPollTimeoutSeconds = DEFAULT_LONG_POLL_TIMEOUT_S;
  sessionPauseUntil = 0;
  typingTasks = new Map<string, { timer: TimerLike; stop: () => void }>();
  typingTickets: Record<string, Record<string, any>> = {};
  pendingToolHints: Record<string, string[]> = {};
  sendToolHints = false;
  loginSessions = new Map<string, { qrcodeId: string; pollBaseUrl: string }>();

  static override defaultConfig(): Record<string, any> {
    return new WeixinConfig() as any;
  }

  constructor(config: Partial<WeixinConfig> & Record<string, any> = {}, bus?: any) {
    const normalized = config instanceof WeixinConfig ? config : new WeixinConfig(config);
    super("weixin", normalized, bus);
    this.config = normalized;
    this.sendToolHints = normalized.sendToolHints;
  }

  getStateDir(): string {
    if (this.stateDirPath) return this.stateDirPath;
    const dir = this.config.stateDir || getRuntimeSubdir("weixin");
    fs.mkdirSync(dir, { recursive: true });
    this.stateDirPath = dir;
    return dir;
  }

  loadState(): boolean {
    const stateFile = path.join(this.getStateDir(), "account.json");
    if (!fs.existsSync(stateFile)) return false;
    try {
      const data = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      this.authToken = String(data.token ?? "");
      this.getUpdatesBuffer = String(data.getUpdatesBuffer ?? "");
      this.contextTokens = sanitizeStringRecord(data.contextTokens);
      this.contextTokenTimestamps = sanitizeNumberRecord(data.contextTokenTimestamps);
      this.typingTickets = sanitizeTicketRecord(data.typingTickets);
      if (data.baseUrl) this.config.baseUrl = String(data.baseUrl);
      return Boolean(this.authToken);
    } catch {
      return false;
    }
  }

  saveState(): void {
    try {
      const stateFile = path.join(this.getStateDir(), "account.json");
      fs.writeFileSync(
        stateFile,
        JSON.stringify({
          token: this.authToken,
          getUpdatesBuffer: this.getUpdatesBuffer,
          contextTokens: this.contextTokens,
          contextTokenTimestamps: this.contextTokenTimestamps,
          typingTickets: this.typingTickets,
          baseUrl: this.config.baseUrl,
        }),
      );
    } catch {
      // State persistence is best effort.
    }
  }

  static randomWechatUin(): string {
    const uint32 = crypto.randomBytes(4).readUInt32BE(0);
    return Buffer.from(String(uint32)).toString("base64");
  }

  makeHeaders({ auth = true }: { auth?: boolean } = {}): Record<string, string> {
    const appId = this.config.appId.trim() || WECHAT_BRIDGE_FALLBACK_APP_ID;
    const headers: Record<string, string> = {
      "X-WECHAT-UIN": WeixinChannel.randomWechatUin(),
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "iLink-App-Id": appId,
      "iLink-App-ClientVersion": String(WECHAT_BRIDGE_CLIENT_VERSION),
    };
    if (auth && this.authToken) headers.Authorization = `Bearer ${this.authToken}`;
    const routeTag = this.config.routeTag;
    if (routeTag !== null && routeTag !== undefined && String(routeTag).trim()) headers.SKRouteTag = String(routeTag).trim();
    return headers;
  }

  static isRetryableMediaDownloadError(err: any): boolean {
    const status = err?.response?.status ?? err?.status ?? err?.statusCode ?? 0;
    return Boolean(err?.name?.includes?.("Timeout") || err?.name?.includes?.("Transport") || err?.code || status >= 500 || err?.retryable);
  }

  isRetryableMediaDownloadError(err: any): boolean {
    return WeixinChannel.isRetryableMediaDownloadError(err);
  }

  async apiGet(endpoint: string, params: Record<string, any> | null = null, options: { auth?: boolean; extraHeaders?: Record<string, string> } = {}): Promise<any> {
    if (!this.client) throw new Error("WeChat client is not initialized");
    const url = `${this.config.baseUrl}/${endpoint}`;
    const headers = { ...this.makeHeaders({ auth: options.auth ?? true }), ...(options.extraHeaders ?? {}) };
    const response = await this.client.get(url, { params: params ?? undefined, headers });
    return readJsonResponse(response);
  }

  async apiGetWithBase({
    baseUrl,
    endpoint,
    params = null,
    auth = true,
    extraHeaders,
  }: {
    baseUrl?: string;
    endpoint: string;
    params?: Record<string, any> | null;
    auth?: boolean;
    extraHeaders?: Record<string, string>;
  }): Promise<any> {
    if (!this.client) throw new Error("WeChat client is not initialized");
    const base = (baseUrl ?? this.config.baseUrl).replace(/\/+$/g, "");
    const headers = { ...this.makeHeaders({ auth }), ...(extraHeaders ?? {}) };
    const response = await this.client.get(`${base}/${endpoint}`, { params: params ?? undefined, headers });
    return readJsonResponse(response);
  }

  async apiPost(endpoint: string, body: Record<string, any> | null = null, options: { auth?: boolean } = {}): Promise<any> {
    if (!this.client) throw new Error("WeChat client is not initialized");
    const payload = { ...(body ?? {}) };
    if (!("base_info" in payload)) payload.base_info = BASE_INFO;
    const response = await this.client.post(`${this.config.baseUrl}/${endpoint}`, {
      json: payload,
      headers: this.makeHeaders({ auth: options.auth ?? true }),
    });
    return readJsonResponse(response);
  }

  async fetchQrCode(): Promise<[string, string]> {
    this.requireMemmyAppIdentity();
    const data = await this.apiGet("ilink/bot/get_bot_qrcode", { bot_type: "3" }, { auth: false });
    const id = String(data.qrcode ?? "");
    if (!id) throw new Error(`Failed to get QR code from WeChat API: ${JSON.stringify(data)}`);
    return [id, await normalizeQrCodeImageSource(String(data.qrcode_img_content ?? id))];
  }

  /**
   * Create one WeChat QR-code login session for the desktop UI.
   *
   * @param force Whether to clear old login state and scan again.
   * @returns QR-code content and polling token.
   */
  async startLoginSession(force = false): Promise<{ status: string; qrCodeDataUrl: string; pollToken: string }> {
    this.requireMemmyAppIdentity();
    if (force) await this.clearLoginState();
    this.client = this.client ?? createFetchClient();
    const [qrcodeId, qrCodeDataUrl] = await this.fetchQrCode();
    const pollToken = `weixin-login-${crypto.randomUUID()}`;
    this.loginSessions.set(pollToken, { qrcodeId, pollBaseUrl: this.config.baseUrl });
    return { status: "pendingQr", qrCodeDataUrl, pollToken };
  }

  private requireMemmyAppIdentity(): void {
    if (this.config.appId.trim()) return;
    throw new Error("微信渠道还没有配置 Memmy 应用，无法生成授权二维码。");
  }

  /**
   * Poll a WeChat QR-code login session started by the desktop UI.
   *
   * @param pollToken Polling token returned by startLoginSession.
   * @returns Current QR-code scanning status.
   */
  async pollLoginSession(pollToken: string): Promise<{ status: string }> {
    const session = this.loginSessions.get(pollToken);
    if (!session) return { status: "expired" };

    const statusData = await this.apiGetWithBase({
      baseUrl: session.pollBaseUrl,
      endpoint: "ilink/bot/get_qrcode_status",
      params: { qrcode: session.qrcodeId },
      auth: false,
    });
    const status = String(statusData?.status ?? "");
    if (status === "confirmed") {
      const token = String(statusData.bot_token ?? "");
      if (!token) return { status: "error" };
      this.authToken = token;
      if (statusData.baseurl) this.config.baseUrl = String(statusData.baseurl);
      this.saveState();
      this.loginSessions.delete(pollToken);
      return { status: "connected" };
    }
    if (status === "scaned_but_redirect") {
      const redirectHost = String(statusData.redirect_host ?? "").trim();
      if (redirectHost) {
        session.pollBaseUrl = /^https?:\/\//i.test(redirectHost) ? redirectHost : `https://${redirectHost}`;
      }
      return { status: "pendingQr" };
    }
    if (status === "expired") {
      this.loginSessions.delete(pollToken);
      return { status: "expired" };
    }
    return { status: "pendingQr" };
  }

  async qrLogin(): Promise<boolean> {
    try {
      let refreshCount = 0;
      let [qrcodeId, scanUrl] = await this.fetchQrCode();
      this.printQrCode(scanUrl);
      let currentPollBaseUrl = this.config.baseUrl;
      while (this.running) {
        let statusData: any;
        try {
          statusData = await this.apiGetWithBase({
            baseUrl: currentPollBaseUrl,
            endpoint: "ilink/bot/get_qrcode_status",
            params: { qrcode: qrcodeId },
            auth: false,
          });
        } catch (err) {
          if (this.isRetryableQrPollError(err)) {
            await sleep(0);
            continue;
          }
          throw err;
        }

        if (!statusData || typeof statusData !== "object") {
          await sleep(0);
          continue;
        }

        const status = String(statusData.status ?? "");
        if (status === "confirmed") {
          const token = String(statusData.bot_token ?? "");
          if (!token) return false;
          this.authToken = token;
          if (statusData.baseurl) this.config.baseUrl = String(statusData.baseurl);
          this.saveState();
          return true;
        }
        if (status === "scaned_but_redirect") {
          const redirectHost = String(statusData.redirect_host ?? "").trim();
          if (redirectHost) {
            currentPollBaseUrl = /^https?:\/\//i.test(redirectHost) ? redirectHost : `https://${redirectHost}`;
          }
        } else if (status === "expired") {
          refreshCount += 1;
          if (refreshCount > MAX_QR_REFRESH_COUNT) return false;
          [qrcodeId, scanUrl] = await this.fetchQrCode();
          currentPollBaseUrl = this.config.baseUrl;
          this.printQrCode(scanUrl);
          continue;
        }
        await sleep(0);
      }
    } catch {
      return false;
    }
    return false;
  }

  isRetryableQrPollError(err: any): boolean {
    const status = err?.response?.status ?? err?.status ?? err?.statusCode ?? 0;
    return Boolean(err?.name?.includes?.("Timeout") || err?.name?.includes?.("Transport") || err?.code || status >= 500 || err?.retryable);
  }

  printQrCode(url: string): void {
    console.log(`\nLogin URL: ${url}\n`);
  }

  override async login(force = false): Promise<boolean> {
    if (force) {
      await this.clearLoginState();
    }
    if (this.authToken || this.loadState()) return true;
    this.client = this.client ?? createFetchClient();
    this.running = true;
    try {
      return await this.qrLogin();
    } finally {
      this.running = false;
      await this.client?.close?.();
      await this.client?.aclose?.();
      this.client = null;
    }
  }

  async clearLoginState(): Promise<void> {
    this.authToken = "";
    this.getUpdatesBuffer = "";
    this.loginSessions.clear();
    const stateFile = path.join(this.getStateDir(), "account.json");
    if (fs.existsSync(stateFile)) await fsp.rm(stateFile, { force: true });
  }

  override async start(): Promise<void> {
    this.running = true;
    this.nextPollTimeoutSeconds = this.config.pollTimeout;
    this.client = this.client ?? createFetchClient();
    if (this.config.token) this.authToken = this.config.token;
    else if (!this.loadState() && !(await this.qrLogin())) {
      this.running = false;
      return;
    }

    let consecutiveFailures = 0;
    while (this.running) {
      try {
        await this.pollOnce();
        consecutiveFailures = 0;
      } catch (err: any) {
        if (!this.running) break;
        if (err?.name?.includes?.("Timeout")) continue;
        consecutiveFailures += 1;
        await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_S * 1000 : RETRY_DELAY_S * 1000);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0;
      }
    }
  }

  override async stop(): Promise<void> {
    this.running = false;
    this.pendingToolHints = {};
    for (const chatId of Array.from(this.typingTasks.keys())) await this.stopTyping(chatId, { clearRemote: false });
    await this.client?.close?.();
    await this.client?.aclose?.();
    this.client = null;
    this.saveState();
  }

  pauseSession(durationS = SESSION_PAUSE_DURATION_S): void {
    this.sessionPauseUntil = nowSeconds() + durationS;
  }

  sessionPauseRemainingSeconds(): number {
    const remaining = Math.trunc(this.sessionPauseUntil - nowSeconds());
    if (remaining <= 0) {
      this.sessionPauseUntil = 0;
      return 0;
    }
    return remaining;
  }

  assertSessionActive(): void {
    const remaining = this.sessionPauseRemainingSeconds();
    if (remaining > 0) {
      const minutes = Math.max(Math.ceil(remaining / 60), 1);
      throw new Error(`WeChat session paused, ${minutes} min remaining (errcode ${ERRCODE_SESSION_EXPIRED})`);
    }
  }

  async pollOnce(): Promise<void> {
    const remaining = this.sessionPauseRemainingSeconds();
    if (remaining > 0) {
      await sleep(0);
      return;
    }
    const data = await this.apiPost("ilink/bot/getupdates", {
      get_updates_buf: this.getUpdatesBuffer,
      base_info: BASE_INFO,
    });
    const ret = data.ret ?? 0;
    const errcode = data.errcode ?? 0;
    if ((ret !== null && ret !== 0) || (errcode !== null && errcode !== 0)) {
      if (ret === ERRCODE_SESSION_EXPIRED || errcode === ERRCODE_SESSION_EXPIRED) {
        this.pauseSession();
        return;
      }
      throw new Error(`getUpdates failed: ret=${ret} errcode=${errcode} errmsg=${data.errmsg ?? ""}`);
    }
    const serverTimeoutMs = Number(data.longpolling_timeout_ms ?? 0);
    if (serverTimeoutMs > 0) this.nextPollTimeoutSeconds = Math.max(Math.floor(serverTimeoutMs / 1000), 5);
    if (data.get_updates_buf) {
      this.getUpdatesBuffer = String(data.get_updates_buf);
      this.saveState();
    }
    for (const msg of data.msgs ?? []) {
      try {
        await this.processMessage(msg);
      } catch {
        // Keep polling even if a single inbound message is malformed.
      }
    }
  }

  async processMessage(msg: any): Promise<void> {
    if (msg?.message_type === MESSAGE_TYPE_BOT) return;
    const fromUserId = String(msg?.from_user_id ?? "");
    if (!fromUserId) return;

    let msgId = String(msg?.message_id ?? msg?.seq ?? "");
    if (!msgId) msgId = `${fromUserId}_${msg?.create_time_ms ?? ""}`;
    if (this.processedIds.has(msgId)) return;
    this.processedIds.set(msgId, null);
    while (this.processedIds.size > 1000) {
      const first = this.processedIds.keys().next().value;
      if (first === undefined) break;
      this.processedIds.delete(first);
    }

    const ctxToken = String(msg?.context_token ?? "");
    if (ctxToken) {
      this.contextTokens[fromUserId] = ctxToken;
      this.contextTokenTimestamps[fromUserId] = nowSeconds();
      this.saveState();
    }

    if (!this.isAllowed(fromUserId)) {
      // Unauthorized WeChat DMs still need explicit feedback; otherwise users see a message sent with no response.
      await this.handleMessage({
        senderId: fromUserId,
        chatId: fromUserId,
        content: "",
        media: [],
        metadata: { message_id: msgId, messageId: msgId },
        isDm: true,
      });
      return;
    }

    const itemList = Array.isArray(msg?.item_list) ? msg.item_list : [];
    const contentParts: string[] = [];
    const mediaPaths: string[] = [];
    let hasTopLevelDownloadableMedia = false;

    for (const item of itemList) {
      const itemType = Number(item?.type ?? 0);
      if (itemType === ITEM_TEXT) {
        const text = String(item?.text_item?.text ?? "");
        if (!text) continue;
        const ref = item?.ref_msg;
        const refItem = ref?.message_item;
        if (ref && refItem && [ITEM_IMAGE, ITEM_VOICE, ITEM_FILE, ITEM_VIDEO].includes(Number(refItem.type ?? 0))) {
          contentParts.push(text);
        } else if (ref) {
          const refParts: string[] = [];
          if (ref.title) refParts.push(String(ref.title));
          const refText = String(refItem?.text_item?.text ?? "");
          if (refText) refParts.push(refText);
          contentParts.push(refParts.length ? `[引用: ${refParts.join(" | ")}]\n${text}` : text);
        } else {
          contentParts.push(text);
        }
      } else if (itemType === ITEM_IMAGE) {
        const imageItem = item?.image_item ?? {};
        if (hasDownloadableMediaLocator(imageItem.media)) hasTopLevelDownloadableMedia = true;
        const filePath = await this.downloadMediaItem(imageItem, "image");
        if (filePath) {
          contentParts.push(`[image]\n[Image: source: ${filePath}]`);
          mediaPaths.push(filePath);
        } else {
          contentParts.push("[image]");
        }
      } else if (itemType === ITEM_VOICE) {
        const voiceItem = item?.voice_item ?? {};
        const voiceText = String(voiceItem.text ?? "");
        if (voiceText) {
          contentParts.push(`[voice] ${voiceText}`);
        } else {
          if (hasDownloadableMediaLocator(voiceItem.media)) hasTopLevelDownloadableMedia = true;
          const filePath = await this.downloadMediaItem(voiceItem, "voice");
          if (filePath) {
            const transcription = await this.transcribeAudio(filePath);
            contentParts.push(transcription ? `[voice] ${transcription}` : `[voice]\n[Audio: source: ${filePath}]`);
            mediaPaths.push(filePath);
          } else {
            contentParts.push("[voice]");
          }
        }
      } else if (itemType === ITEM_FILE) {
        const fileItem = item?.file_item ?? {};
        if (hasDownloadableMediaLocator(fileItem.media)) hasTopLevelDownloadableMedia = true;
        const fileName = String(fileItem.file_name ?? "unknown");
        const filePath = await this.downloadMediaItem(fileItem, "file", fileName);
        if (filePath) {
          contentParts.push(`[file: ${fileName}]\n[File: source: ${filePath}]`);
          mediaPaths.push(filePath);
        } else {
          contentParts.push(`[file: ${fileName}]`);
        }
      } else if (itemType === ITEM_VIDEO) {
        const videoItem = item?.video_item ?? {};
        if (hasDownloadableMediaLocator(videoItem.media)) hasTopLevelDownloadableMedia = true;
        const filePath = await this.downloadMediaItem(videoItem, "video");
        if (filePath) {
          contentParts.push(`[video]\n[Video: source: ${filePath}]`);
          mediaPaths.push(filePath);
        } else {
          contentParts.push("[video]");
        }
      }
    }

    if (mediaPaths.length === 0 && !hasTopLevelDownloadableMedia) {
      const refMediaItem = findReferencedMediaItem(itemList);
      if (refMediaItem) await this.appendReferencedMedia(refMediaItem, contentParts, mediaPaths);
    }

    const content = contentParts.join("\n");
    if (!content) return;
    await this.startTyping(fromUserId, ctxToken);
    await this.handleMessage({
      senderId: fromUserId,
      chatId: fromUserId,
      content,
      media: mediaPaths,
      metadata: { message_id: msgId, messageId: msgId },
    });
  }

  async appendReferencedMedia(refMediaItem: any, contentParts: string[], mediaPaths: string[]): Promise<void> {
    const refType = Number(refMediaItem?.type ?? 0);
    if (refType === ITEM_IMAGE) {
      const filePath = await this.downloadMediaItem(refMediaItem.image_item ?? {}, "image");
      if (filePath) {
        contentParts.push(`[image]\n[Image: source: ${filePath}]`);
        mediaPaths.push(filePath);
      }
    } else if (refType === ITEM_VOICE) {
      const filePath = await this.downloadMediaItem(refMediaItem.voice_item ?? {}, "voice");
      if (filePath) {
        const transcription = await this.transcribeAudio(filePath);
        contentParts.push(transcription ? `[voice] ${transcription}` : `[voice]\n[Audio: source: ${filePath}]`);
        mediaPaths.push(filePath);
      }
    } else if (refType === ITEM_FILE) {
      const fileItem = refMediaItem.file_item ?? {};
      const fileName = String(fileItem.file_name ?? "unknown");
      const filePath = await this.downloadMediaItem(fileItem, "file", fileName);
      if (filePath) {
        contentParts.push(`[file: ${fileName}]\n[File: source: ${filePath}]`);
        mediaPaths.push(filePath);
      }
    } else if (refType === ITEM_VIDEO) {
      const filePath = await this.downloadMediaItem(refMediaItem.video_item ?? {}, "video");
      if (filePath) {
        contentParts.push(`[video]\n[Video: source: ${filePath}]`);
        mediaPaths.push(filePath);
      }
    }
  }

  async downloadMediaItem(typedItem: any, mediaType: string, filename?: string | null): Promise<string | null> {
    try {
      const media = typedItem?.media ?? {};
      const encryptQueryParam = String(media.encrypt_query_param ?? "");
      const fullUrl = String(media.full_url ?? "").trim();
      if (!encryptQueryParam && !fullUrl) return null;

      let aesKeyB64 = "";
      const rawAesKeyHex = String(typedItem?.aeskey ?? "");
      if (rawAesKeyHex) aesKeyB64 = Buffer.from(rawAesKeyHex, "hex").toString("base64");
      else if (media.aes_key) aesKeyB64 = String(media.aes_key);
      if (mediaType !== "image" && !aesKeyB64) return null;

      const fallbackUrl = encryptQueryParam
        ? `${this.config.cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`
        : "";
      const candidates: Array<[string, string]> = [];
      if (fullUrl) candidates.push(["full_url", fullUrl]);
      if (fallbackUrl && fallbackUrl !== fullUrl) candidates.push(["encrypt_query_param", fallbackUrl]);

      let data: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      for (const [index, [source, url]] of candidates.entries()) {
        try {
          const response = await this.client.get(url);
          data = await readByteResponse(response);
          break;
        } catch (err) {
          const hasMore = index + 1 < candidates.length;
          if (source === "full_url" && hasMore && this.isRetryableMediaDownloadError(err)) continue;
          throw err;
        }
      }
      if (!data.length) return null;
      if (aesKeyB64) data = decryptAesEcb(data, aesKeyB64);
      if (!data.length) return null;

      const mediaDir = getMediaDir("weixin");
      fs.mkdirSync(mediaDir, { recursive: true });
      const finalName =
        path.basename(filename || "") ||
        `${mediaType}_${Math.trunc(nowSeconds())}_${Math.abs(hashString(encryptQueryParam || fullUrl))}${extForType(mediaType)}`;
      const filePath = path.join(mediaDir, finalName);
      await fsp.writeFile(filePath, data);
      return filePath;
    } catch {
      return null;
    }
  }

  async getTypingTicket(userId: string, contextToken = ""): Promise<string> {
    const now = nowSeconds();
    const entry = this.typingTickets[userId];
    if (entry && now < Number(entry.nextFetchAt ?? 0)) return String(entry.ticket ?? "");
    const data = await this.apiPost("ilink/bot/getconfig", {
      ilink_user_id: userId,
      context_token: contextToken || null,
      base_info: BASE_INFO,
    });
    if ((data.ret ?? 0) === 0) {
      const ticket = String(data.typing_ticket ?? "");
      this.typingTickets[userId] = {
        ticket,
        everSucceeded: true,
        nextFetchAt: now + Math.random() * TYPING_TICKET_TTL_S,
        retryDelaySeconds: CONFIG_CACHE_INITIAL_RETRY_S,
      };
      return ticket;
    }
    const prevDelay = Number(entry?.retryDelaySeconds ?? CONFIG_CACHE_INITIAL_RETRY_S);
    const nextDelay = Math.min(prevDelay * 2, CONFIG_CACHE_MAX_RETRY_S);
    if (entry) {
      entry.nextFetchAt = now + nextDelay;
      entry.retryDelaySeconds = nextDelay;
      return String(entry.ticket ?? "");
    }
    this.typingTickets[userId] = {
      ticket: "",
      everSucceeded: false,
      nextFetchAt: now + CONFIG_CACHE_INITIAL_RETRY_S,
      retryDelaySeconds: CONFIG_CACHE_INITIAL_RETRY_S,
    };
    return "";
  }

  async refreshContextTokenIfStale(chatId: string, contextToken: string): Promise<string> {
    if (!contextToken) return contextToken;
    const age = nowSeconds() - Number(this.contextTokenTimestamps[chatId] ?? 0);
    if (age < CONTEXT_TOKEN_MAX_AGE_S) return contextToken;
    try {
      const data = await this.apiPost("ilink/bot/getconfig", {
        ilink_user_id: chatId,
        context_token: contextToken,
        base_info: BASE_INFO,
      });
      const newToken = String(data.context_token ?? "");
      if ((data.ret ?? 0) === 0 && newToken && newToken !== contextToken) {
        this.contextTokens[chatId] = newToken;
        this.contextTokenTimestamps[chatId] = nowSeconds();
        this.saveState();
        return newToken;
      }
    } catch {
      return contextToken;
    }
    return contextToken;
  }

  async flushToolHints(chatId: string): Promise<void> {
    const hints = this.pendingToolHints[chatId];
    if (!hints?.length) return;
    delete this.pendingToolHints[chatId];
    let contextToken = this.contextTokens[chatId] ?? "";
    contextToken = await this.refreshContextTokenIfStale(chatId, contextToken);
    if (!contextToken) return;
    try {
      await this.sendText(chatId, hints.join("\n\n"), contextToken);
    } catch {
      // Final visible messages should not be blocked by progress hint failures.
    }
  }

  async sendTyping(userId: string, typingTicket: string, status: number): Promise<void> {
    if (!typingTicket) return;
    await this.apiPost("ilink/bot/sendtyping", {
      ilink_user_id: userId,
      typing_ticket: typingTicket,
      status,
      base_info: BASE_INFO,
    });
  }

  async startTyping(chatId: string, contextToken = ""): Promise<void> {
    if (!this.running || !this.client || !this.authToken || !chatId) return;
    await this.stopTyping(chatId, { clearRemote: false });
    try {
      const ticket = await this.getTypingTicket(chatId, contextToken);
      if (!ticket) return;
      await this.sendTyping(chatId, ticket, TYPING_STATUS_TYPING);
      const timer = setInterval(() => {
        void this.sendTyping(chatId, ticket, TYPING_STATUS_TYPING).catch(() => undefined);
      }, TYPING_KEEPALIVE_INTERVAL_S * 1000);
      const stop = () => clearInterval(timer);
      this.typingTasks.set(chatId, { timer, stop });
    } catch {
      return;
    }
  }

  async stopTyping(chatId: string, options: { clearRemote?: boolean } = {}): Promise<void> {
    const task = this.typingTasks.get(chatId);
    if (task) {
      task.stop();
      this.typingTasks.delete(chatId);
    }
    if (!options.clearRemote) return;
    const ticket = String(this.typingTickets[chatId]?.ticket ?? "");
    if (!ticket) return;
    try {
      await this.sendTyping(chatId, ticket, TYPING_STATUS_CANCEL);
    } catch {
      return;
    }
  }

  override async send(msg: OutboundMessage | any): Promise<void> {
    if (!this.client || !this.authToken) throw new Error("WeChat client not initialized or not authenticated");
    this.assertSessionActive();
    const chatId = String(msg.chatId ?? "");
    const metadata = msg.metadata ?? {};
    const isProgress = Boolean(metadata.agentProgress);

    if (isProgress && metadata.toolHint) {
      if (!this.sendToolHints) return;
      (this.pendingToolHints[chatId] ??= []).push(String(msg.content ?? msg.text ?? ""));
      return;
    }
    if (isProgress && metadata.reasoningDelta) return;

    const media = Array.isArray(msg.media) ? msg.media : [];
    const content = String(msg.content ?? msg.text ?? "").trim();
    if (isProgress && !content && media.length === 0) return;

    await this.flushToolHints(chatId);
    if (!isProgress) await this.stopTyping(chatId, { clearRemote: true });

    let contextToken = this.contextTokens[chatId] ?? "";
    contextToken = await this.refreshContextTokenIfStale(chatId, contextToken);
    if (!contextToken) throw new Error(`WeChat context_token missing for chat_id=${chatId}, cannot send`);

    let typingTicket = "";
    try {
      typingTicket = await this.getTypingTicket(chatId, contextToken);
      if (typingTicket) await this.sendTyping(chatId, typingTicket, TYPING_STATUS_TYPING);
    } catch {
      typingTicket = "";
    }

    const keepalive = typingTicket
      ? setInterval(() => {
          void this.sendTyping(chatId, typingTicket, TYPING_STATUS_TYPING).catch(() => undefined);
        }, TYPING_KEEPALIVE_INTERVAL_S * 1000)
      : null;

    try {
      for (const mediaPath of media) {
        try {
          await this.sendMediaFile(chatId, String(mediaPath), contextToken);
        } catch (err: any) {
          if (isNetworkLikeError(err) || errorStatus(err) >= 500) throw err;
          await this.sendText(chatId, `[Failed to send: ${path.basename(String(mediaPath))}]`, contextToken);
        }
      }
      for (const chunk of splitMessage(content, WEIXIN_MAX_MESSAGE_LEN)) await this.sendText(chatId, chunk, contextToken);
    } finally {
      if (keepalive) clearInterval(keepalive);
      if (typingTicket && !isProgress) {
        try {
          await this.sendTyping(chatId, typingTicket, TYPING_STATUS_CANCEL);
        } catch {
          // best effort
        }
      }
    }
  }

  override async sendDelta(chatId: string, delta: string, metadata: Record<string, any> = {}): Promise<void> {
    if (metadata.streamEnd) await this.flushToolHints(chatId);
  }

  async sendText(toUserId: string, text: string, contextToken: string): Promise<void> {
    const itemList = text ? [{ type: ITEM_TEXT, text_item: { text } }] : [];
    const data = await this.apiPost("ilink/bot/sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: `memmy-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
        message_type: MESSAGE_TYPE_BOT,
        message_state: MESSAGE_STATE_FINISH,
        ...(itemList.length ? { item_list: itemList } : {}),
        ...(contextToken ? { context_token: contextToken } : {}),
      },
      base_info: BASE_INFO,
    });
    const ret = data.ret ?? 0;
    const errcode = data.errcode ?? 0;
    if ((ret !== null && ret !== 0) || (errcode !== null && errcode !== 0)) {
      throw new Error(`WeChat send text error (ret=${ret}, errcode=${errcode}): ${data.errmsg ?? ""}`);
    }
  }

  async sendMediaFile(toUserId: string, mediaPath: string, contextToken: string): Promise<void> {
    if (!fs.existsSync(mediaPath)) throw new Error(`Media file not found: ${mediaPath}`);
    const stat = fs.statSync(mediaPath);
    if (!stat.isFile()) throw new Error(`Media file not found: ${mediaPath}`);
    const rawData = fs.readFileSync(mediaPath);
    const rawSize = rawData.length;
    const rawMd5 = crypto.createHash("md5").update(rawData).digest("hex");
    const ext = path.extname(mediaPath).toLowerCase();
    let uploadType = UPLOAD_MEDIA_FILE;
    let itemType = ITEM_FILE;
    let itemKey = "file_item";
    if (IMAGE_EXTS.has(ext)) {
      uploadType = UPLOAD_MEDIA_IMAGE;
      itemType = ITEM_IMAGE;
      itemKey = "image_item";
    } else if (VIDEO_EXTS.has(ext)) {
      uploadType = UPLOAD_MEDIA_VIDEO;
      itemType = ITEM_VIDEO;
      itemKey = "video_item";
    } else if (VOICE_EXTS.has(ext)) {
      uploadType = UPLOAD_MEDIA_VOICE;
      itemType = ITEM_VOICE;
      itemKey = "voice_item";
    }

    const aesKeyRaw = crypto.randomBytes(16);
    const aesKeyHex = aesKeyRaw.toString("hex");
    const paddedSize = Math.ceil((rawSize + 1) / 16) * 16;
    const fileKey = crypto.randomBytes(16).toString("hex");
    const uploadResp = await this.apiPost("ilink/bot/getuploadurl", {
      filekey: fileKey,
      media_type: uploadType,
      to_user_id: toUserId,
      rawsize: rawSize,
      rawfilemd5: rawMd5,
      filesize: paddedSize,
      no_need_thumb: true,
      aeskey: aesKeyHex,
    });
    const uploadFullUrl = String(uploadResp.upload_full_url ?? "").trim();
    const uploadParam = String(uploadResp.upload_param ?? "");
    if (!uploadFullUrl && !uploadParam) throw new Error(`getuploadurl returned no upload URL: ${JSON.stringify(uploadResp)}`);

    const encryptedData = encryptAesEcb(rawData, aesKeyRaw.toString("base64"));
    const cdnUploadUrl =
      uploadFullUrl ||
      `${this.config.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(fileKey)}`;
    const cdnResp = await this.client.post(cdnUploadUrl, {
      content: encryptedData,
      body: encryptedData,
      headers: { "Content-Type": "application/octet-stream" },
    });
    const headers = normalizeHeaders(cdnResp?.headers);
    const downloadParam = headers["x-encrypted-param"] ?? headers["X-Encrypted-Param"];
    if (!downloadParam) throw new Error("CDN upload response missing x-encrypted-param header");

    const mediaItem: Record<string, any> = {
      media: {
        encrypt_query_param: downloadParam,
        aes_key: Buffer.from(aesKeyHex).toString("base64"),
        encrypt_type: 1,
      },
    };
    if (itemType === ITEM_IMAGE) mediaItem.mid_size = paddedSize;
    else if (itemType === ITEM_VIDEO) mediaItem.video_size = paddedSize;
    else if (itemType === ITEM_FILE) {
      mediaItem.file_name = path.basename(mediaPath);
      mediaItem.len = String(rawSize);
    }

    const data = await this.apiPost("ilink/bot/sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: `memmy-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
        message_type: MESSAGE_TYPE_BOT,
        message_state: MESSAGE_STATE_FINISH,
        item_list: [{ type: itemType, [itemKey]: mediaItem }],
        ...(contextToken ? { context_token: contextToken } : {}),
      },
      base_info: BASE_INFO,
    });
    const ret = data.ret ?? 0;
    const errcode = data.errcode ?? 0;
    if ((ret !== null && ret !== 0) || (errcode !== null && errcode !== 0)) {
      throw new Error(`WeChat send media error (ret=${ret}, errcode=${errcode}): ${data.errmsg ?? ""}`);
    }
  }

}

function sanitizeStringRecord(value: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, val] of Object.entries(value)) {
    if (String(key).trim() && String(val).trim()) out[String(key)] = String(val);
  }
  return out;
}

function sanitizeNumberRecord(value: any): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, val] of Object.entries(value)) {
    const number = Number(val);
    if (String(key).trim() && Number.isFinite(number)) out[String(key)] = number;
  }
  return out;
}

function sanitizeTicketRecord(value: any): Record<string, Record<string, any>> {
  const out: Record<string, Record<string, any>> = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, val] of Object.entries(value)) {
    if (String(key).trim() && val && typeof val === "object" && !Array.isArray(val)) out[String(key)] = val as Record<string, any>;
  }
  return out;
}

function findReferencedMediaItem(itemList: any[]): any | null {
  for (const item of itemList) {
    if (Number(item?.type ?? 0) !== ITEM_TEXT) continue;
    const candidate = item?.ref_msg?.message_item;
    if (candidate && [ITEM_IMAGE, ITEM_VOICE, ITEM_FILE, ITEM_VIDEO].includes(Number(candidate.type ?? 0))) return candidate;
  }
  return null;
}

async function readJsonResponse(response: any): Promise<any> {
  if (response?.raiseForStatus) response.raiseForStatus();
  if (typeof response?.json === "function") return await response.json();
  if (response?.data !== undefined) return response.data;
  return response ?? {};
}

async function readByteResponse(response: any): Promise<Buffer> {
  if (response?.raiseForStatus) response.raiseForStatus();
  if (response instanceof Buffer) return response;
  if (response?.content !== undefined) return Buffer.from(response.content);
  if (response?.data !== undefined) return Buffer.from(response.data);
  if (response?.body !== undefined) return Buffer.from(response.body);
  if (typeof response?.arrayBuffer === "function") return Buffer.from(await response.arrayBuffer());
  return Buffer.from([]);
}

function normalizeHeaders(headers: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (typeof headers.get === "function") {
    const value = headers.get("x-encrypted-param");
    if (value) out["x-encrypted-param"] = String(value);
    return out;
  }
  for (const [key, value] of Object.entries(headers)) out[key] = String(value);
  return out;
}

function createFetchClient(): any {
  return {
    async get(url: string, options: any = {}) {
      const requestUrl = new URL(url);
      for (const [key, value] of Object.entries(options.params ?? {})) requestUrl.searchParams.set(key, String(value));
      const response = await fetch(requestUrl, { headers: options.headers });
      return {
        headers: response.headers,
        status: response.status,
        raiseForStatus() {
          if (!response.ok) {
            const err: any = new Error(`HTTP ${response.status}`);
            err.response = { status: response.status };
            throw err;
          }
        },
        json: () => response.json(),
        arrayBuffer: () => response.arrayBuffer(),
      };
    },
    async post(url: string, options: any = {}) {
      const response = await fetch(url, {
        method: "POST",
        headers: options.headers,
        body: options.content ?? options.body ?? (options.json ? JSON.stringify(options.json) : undefined),
      });
      return {
        headers: response.headers,
        status: response.status,
        raiseForStatus() {
          if (!response.ok) {
            const err: any = new Error(`HTTP ${response.status}`);
            err.response = { status: response.status };
            throw err;
          }
        },
        json: () => response.json(),
        arrayBuffer: () => response.arrayBuffer(),
      };
    },
  };
}

function hashString(value: string): number {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return hash;
}

function extForType(mediaType: string): string {
  if (mediaType === "image") return ".jpg";
  if (mediaType === "voice") return ".silk";
  if (mediaType === "video") return ".mp4";
  return "";
}

export function parseAesKey(aesKeyB64: string): Buffer<ArrayBufferLike> {
  const decoded = Buffer.from(aesKeyB64, "base64");
  if (decoded.length === 16 || decoded.length === 24 || decoded.length === 32) {
    if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) return Buffer.from(decoded.toString("ascii"), "hex");
    return decoded;
  }
  throw new Error(`aes_key must decode to a supported AES key, got ${decoded.length} bytes`);
}

function cipherName(key: Buffer<ArrayBufferLike>): string {
  if (key.length === 16) return "aes-128-ecb";
  if (key.length === 24) return "aes-192-ecb";
  if (key.length === 32) return "aes-256-ecb";
  throw new Error(`Unsupported AES key length: ${key.length}`);
}

export function encryptAesEcb(data: Buffer | Uint8Array, aesKeyB64: string): Buffer<ArrayBufferLike> {
  try {
    const key = parseAesKey(aesKeyB64);
    const cipher = crypto.createCipheriv(cipherName(key), key, null);
    cipher.setAutoPadding(true);
    return Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]);
  } catch {
    return Buffer.from(data);
  }
}

export function decryptAesEcb(data: Buffer | Uint8Array, aesKeyB64: string): Buffer<ArrayBufferLike> {
  try {
    const input = Buffer.from(data);
    if (input.length % 16 !== 0) return input;
    const key = parseAesKey(aesKeyB64);
    const decipher = crypto.createDecipheriv(cipherName(key), key, null);
    decipher.setAutoPadding(false);
    return pkcs7UnpadSafe(Buffer.concat([decipher.update(input), decipher.final()]));
  } catch {
    return Buffer.from(data);
  }
}

function pkcs7UnpadSafe(data: Buffer<ArrayBufferLike>, blockSize = 16): Buffer<ArrayBufferLike> {
  if (!data.length || data.length % blockSize !== 0) return data;
  const padLen = data[data.length - 1];
  if (padLen < 1 || padLen > blockSize) return data;
  for (let index = data.length - padLen; index < data.length; index += 1) if (data[index] !== padLen) return data;
  return data.subarray(0, data.length - padLen);
}

function errorStatus(err: any): number {
  return Number(err?.response?.status ?? err?.status ?? err?.statusCode ?? 0);
}

function isNetworkLikeError(err: any): boolean {
  const name = String(err?.name ?? "");
  return Boolean(name.includes("Timeout") || name.includes("Transport") || name.includes("Connect") || err?.code);
}
