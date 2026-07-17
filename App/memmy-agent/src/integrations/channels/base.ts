import { InboundMessage, MessageBus, OutboundMessage } from "../../core/runtime-messages/index.js";
import {
  formatPairingReply,
  generateCode,
  isApproved,
  PAIRING_CODE_META_KEY,
} from "../channel-auth/index.js";

function configValue(config: any, key: string): any {
  if (!config) return undefined;
  if (typeof config.get === "function") return config.get(key);
  return config[key];
}

export interface ChannelHandleMessageOptions {
  senderId?: string;
  chatId?: string;
  content: string;
  media?: string[];
  metadata?: Record<string, any>;
  sessionKey?: string | null;
  isDm?: boolean;
}

export class BaseChannel {
  name = "base";
  displayName = "Base";
  transcriptionProvider = "groq";
  transcriptionApiKey = "";
  transcriptionApiBase = "";
  transcriptionLanguage: string | null = null;
  sendProgress = true;
  sendToolHints = false;
  showReasoning = true;
  bus: MessageBus;
  config: any;
  running = false;
  /** Most recent user-actionable error, mainly insufficient permissions, exposed to the frontend across channels. */
  lastError: string | null = null;

  constructor(nameOrConfig: string | any = {}, configOrBus: any = {}, maybeBus?: MessageBus) {
    if (typeof nameOrConfig === "string") {
      this.name = nameOrConfig;
      this.config = configOrBus ?? {};
      this.bus = maybeBus ?? new MessageBus();
    } else {
      this.config = nameOrConfig ?? {};
      this.bus = configOrBus instanceof MessageBus ? configOrBus : new MessageBus();
    }
  }

  async transcribeAudio(filePath: string): Promise<string> {
    if (!this.transcriptionApiKey) return "";
    try {
      const mod = await import("../../providers/transcription.js");
      const Provider =
        this.transcriptionProvider === "openai"
          ? mod.OpenAITranscriptionProvider
          : mod.GroqTranscriptionProvider;
      const provider = new Provider({
        apiKey: this.transcriptionApiKey,
        apiBase: this.transcriptionApiBase,
        language: this.transcriptionLanguage,
      });
      return await provider.transcribe(filePath);
    } catch {
      return "";
    }
  }

  async login(force = false): Promise<boolean> {
    return true;
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async send(message: OutboundMessage): Promise<void> {
    await this.bus.publishOutbound(message);
  }

  async sendDelta(
    chatId: string,
    delta: string,
    metadata: Record<string, any> = {},
  ): Promise<void> {}

  async sendReasoningDelta(
    chatId: string,
    delta: string,
    metadata: Record<string, any> = {},
  ): Promise<void> {}

  async sendReasoningEnd(chatId: string, metadata: Record<string, any> = {}): Promise<void> {}

  async sendReasoning(msg: OutboundMessage): Promise<void> {
    if (!msg.content) return;
    const meta: Record<string, any> = { ...(msg.metadata ?? {}), reasoningDelta: true };
    await this.sendReasoningDelta(msg.chatId, msg.content, meta);
    const endMeta = { ...meta };
    delete endMeta.reasoningDelta;
    endMeta.reasoningEnd = true;
    await this.sendReasoningEnd(msg.chatId, endMeta);
  }

  get supportsStreaming(): boolean {
    const streaming = configValue(this.config, "streaming");
    const overridesDelta = this.sendDelta !== BaseChannel.prototype.sendDelta;
    return Boolean(streaming) && overridesDelta;
  }

  isAllowed(senderId: string): boolean {
    const allow = configValue(this.config, "allowFrom") ?? [];
    const allowList = Array.isArray(allow) ? allow.map(String) : [];
    if (allowList.includes("*")) return true;
    if (allowList.includes(String(senderId))) return true;
    return isApproved(this.name, String(senderId));
  }

  async handleMessage(options: ChannelHandleMessageOptions): Promise<void>;
  async handleMessage(
    senderId: string,
    chatId?: string,
    content?: string,
    media?: string[],
    metadata?: Record<string, any>,
    sessionKey?: string | null,
    isDm?: boolean,
  ): Promise<void>;
  async handleMessage(
    senderIdOrOptions: string | ChannelHandleMessageOptions,
    chatId?: string,
    content?: string,
    media?: string[],
    metadata?: Record<string, any>,
    sessionKey?: string | null,
    isDm = false,
  ): Promise<void> {
    const options =
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
    const {
      senderId,
      chatId: optionChatId,
      content: optionContent,
      media: optionMedia = [],
      metadata: optionMetadata = {},
      sessionKey: optionSessionKey,
      isDm: optionIsDm,
    } = options;
    const sender = String(senderId ?? "");
    const chat = String(optionChatId ?? "");
    if (!this.isAllowed(sender)) {
      if (optionIsDm) {
        const code = generateCode(this.name, sender);
        await this.send(
          new OutboundMessage({
            channel: this.name,
            chatId: chat,
            content: formatPairingReply(code),
            metadata: { [PAIRING_CODE_META_KEY]: code },
          }),
        );
      }
      return;
    }
    const meta = this.supportsStreaming ? { ...optionMetadata, wantsStream: true } : optionMetadata;
    await this.bus.publishInbound(
      new InboundMessage({
        channel: this.name,
        senderId: sender,
        chatId: chat,
        content: optionContent,
        media: optionMedia,
        metadata: meta,
        sessionKeyOverride: optionSessionKey ?? undefined,
      }),
    );
  }

  /**
   * Subclasses may override this to turn channel API permission errors into a Chinese user-action hint; non-permission errors return null.
   */
  permissionErrorHint(error: unknown): string | null {
    return null;
  }

  /**
   * Record a user-actionable error: when it matches a permission hint, write lastError so the frontend can surface it.
   *
   * @param error Error object thrown or returned by the channel API.
   */
  recordPermissionError(error: unknown): void {
    const hint = this.permissionErrorHint(error);
    if (hint) this.lastError = hint;
  }

  static defaultConfig(): Record<string, any> {
    return { enabled: false };
  }

  get isRunning(): boolean {
    return this.running;
  }
}
