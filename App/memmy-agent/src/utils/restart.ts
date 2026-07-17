export const RESTART_NOTIFY_CHANNEL_ENV = "MEMMY_AGENT_RESTART_NOTIFY_CHANNEL";
export const RESTART_NOTIFY_CHAT_ID_ENV = "MEMMY_AGENT_RESTART_NOTIFY_CHAT_ID";
export const RESTART_NOTIFY_METADATA_ENV = "MEMMY_AGENT_RESTART_NOTIFY_METADATA";
export const RESTART_STARTED_AT_ENV = "MEMMY_AGENT_RESTART_STARTED_AT";

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
