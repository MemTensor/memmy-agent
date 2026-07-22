export const RESTART_NOTIFY_CHANNEL_ENV = "MEMMY_AGENT_RESTART_NOTIFY_CHANNEL";
export const RESTART_NOTIFY_CHAT_ID_ENV = "MEMMY_AGENT_RESTART_NOTIFY_CHAT_ID";
export const RESTART_NOTIFY_METADATA_ENV = "MEMMY_AGENT_RESTART_NOTIFY_METADATA";
export const RESTART_STARTED_AT_ENV = "MEMMY_AGENT_RESTART_STARTED_AT";
export const DESKTOP_MANAGED_GATEWAY_ENV = "MEMMY_DESKTOP_MANAGED_GATEWAY";
export const MANAGED_RESTART_IPC_TYPE = "memmy-agent:restart";

export interface ManagedRestartNotice {
  type: typeof MANAGED_RESTART_IPC_TYPE;
  channel: string;
  chatId: string;
  startedAt: string;
  metadata: Record<string, unknown>;
}

export class RestartNotice {
  channel: string;
  chatId: string;
  startedAtRaw: string;
  metadata: Record<string, any>;

  constructor(init: {
    channel?: string;
    chatId?: string;
    startedAtRaw?: string;
    metadata?: Record<string, any>;
  } = {}) {
    this.channel = init.channel ?? "";
    this.chatId = init.chatId ?? "";
    this.startedAtRaw = init.startedAtRaw ?? "";
    this.metadata = init.metadata ?? {};
  }
}

export function formatRestartCompletedMessage(startedAtRaw: string): string {
  let elapsed = "";
  if (startedAtRaw) {
    const started = Number(startedAtRaw);
    if (Number.isFinite(started)) elapsed = ` in ${Math.max(0, Date.now() / 1000 - started).toFixed(1)}s`;
  }
  return `Restart completed${elapsed}.`;
}

export function setRestartNoticeToEnv({
  channel,
  chatId,
  metadata,
}: {
  channel: string;
  chatId?: string;
  metadata?: Record<string, any> | null;
}): void {
  process.env[RESTART_NOTIFY_CHANNEL_ENV] = channel;
  process.env[RESTART_NOTIFY_CHAT_ID_ENV] = chatId ?? "";
  process.env[RESTART_STARTED_AT_ENV] = String(Date.now() / 1000);
  if (metadata && Object.keys(metadata).length) {
    try {
      process.env[RESTART_NOTIFY_METADATA_ENV] = JSON.stringify(metadata);
    } catch {
      delete process.env[RESTART_NOTIFY_METADATA_ENV];
    }
  } else {
    delete process.env[RESTART_NOTIFY_METADATA_ENV];
  }
}

export function restartNoticeEnv(notice: ManagedRestartNotice): Record<string, string> {
  return {
    [RESTART_NOTIFY_CHANNEL_ENV]: notice.channel,
    [RESTART_NOTIFY_CHAT_ID_ENV]: notice.chatId,
    [RESTART_STARTED_AT_ENV]: notice.startedAt,
    ...(Object.keys(notice.metadata).length > 0
      ? { [RESTART_NOTIFY_METADATA_ENV]: JSON.stringify(notice.metadata) }
      : {})
  };
}

export function createManagedRestartNotice(input: {
  channel: string;
  chatId?: string;
  metadata?: Record<string, unknown> | null;
  startedAt?: number;
}): ManagedRestartNotice {
  return {
    type: MANAGED_RESTART_IPC_TYPE,
    channel: input.channel,
    chatId: input.chatId ?? "",
    startedAt: String(input.startedAt ?? Date.now() / 1000),
    metadata: input.metadata ?? {}
  };
}

export function parseManagedRestartNotice(value: unknown): ManagedRestartNotice | null {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.some((key) => !["type", "channel", "chatId", "startedAt", "metadata"].includes(key))) return null;
  if (value.type !== MANAGED_RESTART_IPC_TYPE) return null;
  if (typeof value.channel !== "string" || value.channel.trim().length === 0 || value.channel.length > 64) return null;
  if (typeof value.chatId !== "string" || value.chatId.length > 256) return null;
  if (typeof value.startedAt !== "string" || value.startedAt.trim().length === 0 || value.startedAt.length > 32 || !Number.isFinite(Number(value.startedAt))) return null;
  if (!isPlainObject(value.metadata)) return null;
  let metadataJson: string;
  try {
    metadataJson = JSON.stringify(value.metadata);
  } catch {
    return null;
  }
  if (typeof metadataJson !== "string") return null;
  if (Buffer.byteLength(metadataJson, "utf8") > 16 * 1024) return null;
  const metadata = JSON.parse(metadataJson) as unknown;
  if (!isPlainObject(metadata)) return null;
  return {
    type: MANAGED_RESTART_IPC_TYPE,
    channel: value.channel,
    chatId: value.chatId,
    startedAt: value.startedAt,
    metadata
  };
}

export function consumeRestartNoticeFromEnv(): RestartNotice | null {
  const channel = (process.env[RESTART_NOTIFY_CHANNEL_ENV] ?? "").trim();
  const chatId = (process.env[RESTART_NOTIFY_CHAT_ID_ENV] ?? "").trim();
  const startedAtRaw = (process.env[RESTART_STARTED_AT_ENV] ?? "").trim();
  const metadataRaw = (process.env[RESTART_NOTIFY_METADATA_ENV] ?? "").trim();
  delete process.env[RESTART_NOTIFY_CHANNEL_ENV];
  delete process.env[RESTART_NOTIFY_CHAT_ID_ENV];
  delete process.env[RESTART_STARTED_AT_ENV];
  delete process.env[RESTART_NOTIFY_METADATA_ENV];
  if (!channel || !chatId) return null;
  let metadata: Record<string, any> = {};
  if (metadataRaw) {
    try {
      const parsed = JSON.parse(metadataRaw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed;
    } catch {
      metadata = {};
    }
  }
  return new RestartNotice({ channel, chatId, startedAtRaw, metadata });
}

export function shouldShowCliRestartNotice(notice: RestartNotice, sessionId: string): boolean {
  if (notice.channel !== "cli") return false;
  const cliChatId = sessionId.includes(":") ? sessionId.split(":", 2)[1] : sessionId;
  return !notice.chatId || notice.chatId === cliChatId;
}

export function requestRestart(reason = ""): RestartNotice {
  return new RestartNotice({ metadata: reason ? { reason } : {} });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
