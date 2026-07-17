export const OUTBOUND_META_AGENT_UI = "agentUi";
export const INBOUND_META_RUNTIME_CONTROL = "runtimeControl";
export const RUNTIME_CONTROL_ACK = "ack";
export const RUNTIME_CONTROL_MCP_RELOAD = "mcpReload";

type TimestampInput = Date | string | number;

function normalizeTimestamp(value: TimestampInput | null | undefined): Date {
  if (value instanceof Date) return new Date(value.getTime());
  if (value !== null && value !== undefined) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date();
}

export class InboundMessage {
  channel: string;
  chatId: string;
  senderId: string;
  text: string;
  content: string;
  attachments: string[];
  media: string[];
  metadata: Record<string, any>;
  role: string;
  sessionKeyOverride: string | null;
  timestamp: Date;
  private explicitSessionKey!: string | null;

  constructor(init: {
    channel: string;
    chatId?: string;
    senderId?: string;
    text?: string;
    content?: string;
    attachments?: string[];
    media?: string[];
    metadata?: Record<string, any>;
    role?: string;
    sessionKey?: string;
    sessionKeyOverride?: string | null;
    timestamp?: TimestampInput | null;
  }) {
    this.channel = init.channel;
    this.chatId = init.chatId ?? "";
    this.senderId = init.senderId ?? "";
    this.text = init.text ?? init.content ?? "";
    this.content = this.text;
    this.attachments = init.attachments ?? init.media ?? [];
    this.media = this.attachments;
    this.metadata = init.metadata ?? {};
    this.role = init.role ?? "user";
    this.sessionKeyOverride = init.sessionKeyOverride ?? null;
    this.timestamp = normalizeTimestamp(init.timestamp);
    Object.defineProperty(this, "explicitSessionKey", {
      value: init.sessionKey ?? null,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    Object.defineProperty(this, "sessionKey", {
      configurable: true,
      enumerable: true,
      get: () => this.computeSessionKey(),
      set: (value: string) => {
        this.explicitSessionKey = value;
      },
    });
  }

  get sessionKey(): string {
    return this.computeSessionKey();
  }

  set sessionKey(value: string) {
    this.explicitSessionKey = value;
  }

  private computeSessionKey(): string {
    return this.sessionKeyOverride ?? this.explicitSessionKey ?? `${this.channel}:${this.chatId}`;
  }
}

export class OutboundMessage {
  channel: string;
  chatId: string;
  text: string;
  content: string;
  role: string;
  metadata: Record<string, any>;
  media: string[];
  buttons: string[][];
  messageType: string;
  replyTo: string | null;

  constructor(init: {
    channel: string;
    chatId?: string;
    text?: string;
    content?: string;
    role?: string;
    metadata?: Record<string, any>;
    media?: string[];
    buttons?: string[][];
    messageType?: string;
    replyTo?: string | null;
    reply_to?: string | null;
  }) {
    this.channel = init.channel;
    this.chatId = init.chatId ?? "";
    this.text = init.text ?? init.content ?? "";
    this.content = this.text;
    this.role = init.role ?? "assistant";
    this.metadata = init.metadata ?? {};
    this.media = init.media ?? [];
    this.buttons = init.buttons ?? [];
    this.messageType = init.messageType ?? "message";
    this.replyTo = init.replyTo ?? init.reply_to ?? null;
  }
}
