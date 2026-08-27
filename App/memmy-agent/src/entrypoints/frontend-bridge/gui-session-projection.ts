import { Buffer } from "node:buffer";
import {
  readWebuiSessionBinding,
  Session,
  SessionManager,
  type WebuiSessionBinding,
} from "../../core/session/manager.js";

const NATIVE_GUI_CHAT_ID_RE = /^[A-Za-z0-9_:-]{1,64}$/;
const EXTERNAL_GUI_CHAT_ID_RE = /^ext_([A-Za-z0-9_-]{1,214})$/;
const EXTERNAL_GUI_CHAT_ID_PREFIX = "ext_";
const WEBSOCKET_SESSION_PREFIX = "websocket:";
const CLI_SESSION_PREFIX = "cli:";
const MAX_CANONICAL_SESSION_KEY_BYTES = 160;
const MAX_DISPLAY_TITLE_LENGTH = 52;

export const GUI_IM_CHANNELS = {
  dingtalk: "DingTalk",
  discord: "Discord",
  feishu: "飞书",
  imessage: "iMessage",
  matrix: "Matrix",
  mochat: "Mochat",
  msteams: "Microsoft Teams",
  qq: "QQ",
  signal: "Signal",
  slack: "Slack",
  telegram: "Telegram",
  wecom: "企业微信",
  weixin: "微信",
  whatsapp: "WhatsApp",
} as const;

type GuiImChannel = keyof typeof GUI_IM_CHANNELS;

export function isGuiImChannel(value: string): value is GuiImChannel {
  return Object.prototype.hasOwnProperty.call(GUI_IM_CHANNELS, value);
}

export type GuiSessionSource =
  | { kind: "gui"; channel: null; displayName: null }
  | { kind: "terminal"; channel: "cli"; displayName: null }
  | { kind: "im"; channel: GuiImChannel; displayName: string };

export type ResolvedGuiSession = {
  session: Session;
  canonicalSessionKey: string;
  guiChatId: string;
  guiSessionKey: string;
  binding: WebuiSessionBinding;
  source: GuiSessionSource;
};

export class GuiSessionProjectionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 404) {
    super(code);
    this.name = "GuiSessionProjectionError";
    this.code = code;
    this.status = status;
  }
}

function sourceForCanonicalSessionKey(sessionKey: string): GuiSessionSource | null {
  if (sessionKey.startsWith(WEBSOCKET_SESSION_PREFIX)) {
    return { kind: "gui", channel: null, displayName: null };
  }
  if (sessionKey.startsWith(CLI_SESSION_PREFIX)) {
    return { kind: "terminal", channel: "cli", displayName: null };
  }
  const separator = sessionKey.indexOf(":");
  if (separator <= 0) return null;
  const channel = sessionKey.slice(0, separator);
  if (!isGuiImChannel(channel)) return null;
  const displayName = GUI_IM_CHANNELS[channel];
  return displayName ? { kind: "im", channel, displayName } : null;
}

function encodeExternalSessionKey(sessionKey: string): string {
  const bytes = Buffer.from(sessionKey, "utf8");
  if (bytes.length === 0 || bytes.length > MAX_CANONICAL_SESSION_KEY_BYTES) {
    throw new GuiSessionProjectionError("session_key_invalid", 400);
  }
  return bytes.toString("base64url");
}

export function isNativeGuiChatId(value: string): boolean {
  return NATIVE_GUI_CHAT_ID_RE.test(value) && !value.startsWith(EXTERNAL_GUI_CHAT_ID_PREFIX);
}

export function isExternalGuiChatId(value: string): boolean {
  return EXTERNAL_GUI_CHAT_ID_RE.test(value);
}

export function isProjectableCanonicalSessionKey(sessionKey: string): boolean {
  const source = sourceForCanonicalSessionKey(sessionKey);
  if (!source || source.kind === "gui") return false;
  return Buffer.byteLength(sessionKey, "utf8") <= MAX_CANONICAL_SESSION_KEY_BYTES;
}

export function toGuiChatId(sessionKey: string): string {
  if (sessionKey.startsWith(WEBSOCKET_SESSION_PREFIX)) {
    const chatId = sessionKey.slice(WEBSOCKET_SESSION_PREFIX.length);
    if (!isNativeGuiChatId(chatId)) {
      throw new GuiSessionProjectionError("chat_id_invalid", 400);
    }
    return chatId;
  }
  if (!isProjectableCanonicalSessionKey(sessionKey)) {
    throw new GuiSessionProjectionError("session_source_invalid", 400);
  }
  return `${EXTERNAL_GUI_CHAT_ID_PREFIX}${encodeExternalSessionKey(sessionKey)}`;
}

export function fromGuiChatId(guiChatId: string): string {
  const match = EXTERNAL_GUI_CHAT_ID_RE.exec(guiChatId);
  if (!match) throw new GuiSessionProjectionError("chat_id_invalid", 400);
  let canonicalSessionKey: string;
  try {
    canonicalSessionKey = Buffer.from(match[1], "base64url").toString("utf8");
  } catch {
    throw new GuiSessionProjectionError("chat_id_invalid", 400);
  }
  if (
    !canonicalSessionKey
    || !isProjectableCanonicalSessionKey(canonicalSessionKey)
    || `${EXTERNAL_GUI_CHAT_ID_PREFIX}${encodeExternalSessionKey(canonicalSessionKey)}` !== guiChatId
  ) {
    throw new GuiSessionProjectionError("chat_id_invalid", 400);
  }
  return canonicalSessionKey;
}

function truncateDisplayTitle(baseTitle: string, suffix: string): string {
  const available = MAX_DISPLAY_TITLE_LENGTH - suffix.length;
  if (available <= 0) return suffix.slice(0, MAX_DISPLAY_TITLE_LENGTH);
  if (baseTitle.length <= available) return `${baseTitle}${suffix}`;
  if (available === 1) return `…${suffix}`;
  return `${baseTitle.slice(0, available - 1).trimEnd()}…${suffix}`;
}

function baseTitle(summary: Record<string, any>): string {
  for (const candidate of [summary.title, summary.preview, "Untitled task"]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "Untitled task";
}

export function guiDisplayTitle(
  summary: Record<string, any>,
  source: GuiSessionSource,
): string {
  const title = baseTitle(summary);
  if (source.kind !== "im") return title;
  return truncateDisplayTitle(title, ` · ${source.displayName}`);
}

export function stripGuiDisplayTitleSuffix(title: string, source: GuiSessionSource): string {
  const trimmed = title.trim();
  if (source.kind !== "im") return trimmed;
  const suffix = ` · ${source.displayName}`;
  return trimmed.endsWith(suffix)
    ? trimmed.slice(0, -suffix.length).trimEnd()
    : trimmed;
}

export class GuiSessionProjection {
  readonly sessions: SessionManager;

  constructor(sessions: SessionManager) {
    this.sessions = sessions;
  }

  resolve(input: string): ResolvedGuiSession {
    const guiChatId = input.startsWith(WEBSOCKET_SESSION_PREFIX)
      ? input.slice(WEBSOCKET_SESSION_PREFIX.length)
      : input;
    const canonicalSessionKey = isExternalGuiChatId(guiChatId)
      ? fromGuiChatId(guiChatId)
      : isNativeGuiChatId(guiChatId)
        ? `${WEBSOCKET_SESSION_PREFIX}${guiChatId}`
        : (() => {
            throw new GuiSessionProjectionError("chat_id_invalid", 400);
          })();
    const source = sourceForCanonicalSessionKey(canonicalSessionKey);
    if (!source) throw new GuiSessionProjectionError("session_source_invalid");
    const session = this.sessions.get(canonicalSessionKey);
    if (!session || session.metadata?.webui !== true) {
      throw new GuiSessionProjectionError("session_not_found");
    }
    let binding: WebuiSessionBinding;
    try {
      binding = readWebuiSessionBinding(session);
    } catch {
      throw new GuiSessionProjectionError("session_binding_invalid");
    }
    const expectedGuiChatId = toGuiChatId(canonicalSessionKey);
    if (expectedGuiChatId !== guiChatId) {
      throw new GuiSessionProjectionError("session_projection_invalid");
    }
    return {
      session,
      canonicalSessionKey,
      guiChatId,
      guiSessionKey: `${WEBSOCKET_SESSION_PREFIX}${guiChatId}`,
      binding,
      source,
    };
  }

  projectSession(session: Session): Record<string, any> | null {
    if (session.metadata?.webui !== true) return null;
    const source = sourceForCanonicalSessionKey(session.key);
    if (!source) return null;
    let binding: WebuiSessionBinding;
    let guiChatId: string;
    try {
      binding = readWebuiSessionBinding(session);
      guiChatId = toGuiChatId(session.key);
    } catch {
      return null;
    }
    const canonicalSummary = this.sessions.webuiSessionSummary(session);
    return {
      ...canonicalSummary,
      key: `${WEBSOCKET_SESSION_PREFIX}${guiChatId}`,
      title: guiDisplayTitle(canonicalSummary, source),
      projectId: binding.projectId,
      cwd: binding.cwd,
    };
  }

  snapshot(): Record<string, any>[] {
    return this.sessions.listWebuiSessionRecords()
      .map((session) => this.projectSession(session))
      .filter((summary): summary is Record<string, any> => summary !== null);
  }
}
