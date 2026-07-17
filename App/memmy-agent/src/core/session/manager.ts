import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { scrubSubagentAnnounceBody } from "../../utils/subagent-channel-display.js";
import { findLegalMessageStart, imagePlaceholderText, stripThink } from "../../utils/helpers.js";

export const FILE_MAX_MESSAGES = 2_000;
const WEBUI_SESSION_METADATA_KEY = "webui";
const WEBUI_TITLE_METADATA_KEY = "title";
const WEBUI_TITLE_USER_EDITED_METADATA_KEY = "titleUserEdited";

export function estimateMessageTokens(message: Record<string, any>): number {
  return Math.ceil(JSON.stringify(message).length / 4);
}

function sanitizeAssistantReplayText(content: string): string {
  let out = stripThink(content);
  out = out.replace(/^\[Message Time: [^\]]+]\n?/, "");
  out = out
    .split(/\r?\n/)
    .filter((line) => !/^\[image: (?:\/|~)[^\]]+]\s*$/.test(line))
    .join("\n");
  out = out.replace(/^\s*(generate_image|message)\([^)]*\)\s*$/gm, "");
  return out.trim();
}

function messagePreviewText(message: Record<string, any>): string {
  const content = message.injectedEvent === "subagentResult" && typeof message.content === "string"
    ? scrubSubagentAnnounceBody(message.content)
    : message.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    }
    text = parts.join(" ");
  }
  text = sanitizeAssistantReplayText(text).replace(/\s+/g, " ").trim();
  return text.length > 120 ? `${text.slice(0, 119).trimEnd()}…` : text;
}

function sessionSummary(session: Session, filePath: string, options: { repairPreview?: boolean } = {}): Record<string, any> {
  const scan = session.messages.slice(0, 200);
  const previewMessage = options.repairPreview
    ? session.messages.find((m) => messagePreviewText(m)) ?? {}
    : scan.find((m) => m.role === "user") ?? scan[0] ?? {};
  return {
    key: session.key,
    title: session.metadata.title,
    preview: messagePreviewText(previewMessage),
    updatedAt: session.updatedAt,
    path: filePath,
  };
}

function alignWindowToUserTurn(messages: Record<string, any>[]): Record<string, any>[] {
  const firstUser = messages.findIndex((message) => message.role === "user");
  if (firstUser >= 0) {
    const start = firstUser > 0 && messages[firstUser - 1].channelDelivery ? firstUser - 1 : firstUser;
    return messages.slice(start);
  }
  return messages;
}

const REPLAY_EXTRA_KEYS = [
  "tool_calls",
  "tool_call_id",
  "name",
  "reasoning_content",
  "thinking_blocks",
  "extra_content",
] as const;

function hasAssistantReplayState(message: Record<string, any>): boolean {
  return "tool_calls" in message || "reasoning_content" in message || "thinking_blocks" in message;
}

function synthesizeContent(message: Record<string, any>, includeTimestamps: boolean): Record<string, any> | null {
  const role = message.role;
  let content = Object.prototype.hasOwnProperty.call(message, "content") ? message.content : "";
  if (role === "assistant" && typeof content === "string") {
    content = sanitizeAssistantReplayText(content);
  }
  if (role === "user" && typeof content === "string") {
    const parts = [content].filter(Boolean);
    for (const media of message.media ?? []) if (typeof media === "string" && media) parts.push(imagePlaceholderText(media));
    for (const preset of message.mcp_presets ?? []) {
      const name = String(preset?.name ?? "").trim().toLowerCase();
      if (!name) continue;
      const transport = String(preset?.transport ?? "mcp").trim() || "mcp";
      parts.push(`[MCP Preset Attachment: @${name}; tool_prefix=mcp_${name}_; transport=${transport}]`);
    }
    content = parts.join("\n");
    if (includeTimestamps && message.timestamp) content = `[Message Time: ${message.timestamp}]\n${content}`;
  }
  if (role === "assistant" && typeof content === "string" && !content.trim() && !hasAssistantReplayState(message)) {
    return null;
  }
  const entry: Record<string, any> = { role, content };
  for (const key of REPLAY_EXTRA_KEYS) {
    if (key in message) entry[key] = message[key];
  }
  return entry;
}

export class Session {
  key: string;
  messages: Record<string, any>[];
  metadata: Record<string, any>;
  lastConsolidated = 0;
  createdAt: string;
  updatedAt: string;

  constructor({ key, messages = [], metadata = {}, lastConsolidated, createdAt, updatedAt }: {
    key: string;
    messages?: Record<string, any>[];
    metadata?: Record<string, any>;
    lastConsolidated?: number;
    createdAt?: string;
    updatedAt?: string;
  }) {
    this.key = key;
    this.messages = messages;
    this.metadata = metadata;
    this.lastConsolidated = lastConsolidated ?? 0;
    const now = new Date().toISOString();
    this.createdAt = createdAt ?? now;
    this.updatedAt = updatedAt ?? now;
  }

  addMessage(role: string, content: any, extra: Record<string, any> = {}): void {
    this.messages.push({ role, content, timestamp: new Date().toISOString(), ...extra });
    this.updatedAt = new Date().toISOString();
  }

  getHistory(
    maxMessagesOrOptions: number | {
      maxMessages?: number;
      maxTokens?: number;
      includeTimestamps?: boolean;
    } = {},
    options: {
      maxTokens?: number;
      includeTimestamps?: boolean;
    } = {},
  ): Record<string, any>[] {
    const historyOptions = typeof maxMessagesOrOptions === "number"
      ? { maxMessages: maxMessagesOrOptions, ...options }
      : maxMessagesOrOptions;
    const {
      maxMessages = 120,
      maxTokens,
      includeTimestamps = false,
    } = historyOptions ?? {};
    const visibleMessages = this.messages.slice(this.lastConsolidated);
    const effectiveMsgLimit = maxMessages > 0 ? maxMessages : 120;
    let window = visibleMessages.slice(-effectiveMsgLimit);
    window = alignWindowToUserTurn(window);
    const legalStart = findLegalMessageStart(window);
    if (legalStart) window = window.slice(legalStart);
    window = window.filter((message) => !message.commandMessage);
    const synthesized = window.map((msg) => synthesizeContent(msg, includeTimestamps));
    let out = synthesized.filter((message): message is Record<string, any> => message != null);
    if (maxTokens != null && maxTokens > 0 && out.length) {
      const selected: Record<string, any>[] = [];
      let total = 0;
      for (let i = out.length - 1; i >= 0; i -= 1) {
        const cost = estimateMessageTokens(out[i]);
        if (selected.length && total + cost > maxTokens) break;
        selected.unshift(out[i]);
        total += cost;
      }
      const firstUser = selected.findIndex((message) => message.role === "user");
      if (firstUser >= 0) {
        out = selected.slice(firstUser);
      } else {
        const recoveredUser = (() => {
          for (let i = out.length - 1; i >= 0; i -= 1) if (out[i].role === "user") return i;
          return -1;
        })();
        out = recoveredUser >= 0 ? out.slice(recoveredUser) : selected;
      }
      const tokenLegalStart = findLegalMessageStart(out);
      if (tokenLegalStart) out = out.slice(tokenLegalStart);
    }
    const finalLegalStart = findLegalMessageStart(out);
    return finalLegalStart ? out.slice(finalLegalStart) : out;
  }

  retainRecentLegalSuffix(maxMessages: number): void {
    if (maxMessages <= 0) {
      this.messages = [];
      this.lastConsolidated = 0;
      return;
    }
    const oldLen = this.messages.length;
    let retained = this.messages.slice(-maxMessages);
    const firstUser = retained.findIndex((message) => message.role === "user");
    if (firstUser >= 0) {
      retained = retained.slice(firstUser);
    } else {
      for (let i = this.messages.length - 1; i >= 0; i -= 1) {
        if (this.messages[i].role === "user") {
          retained = this.messages.slice(i, i + maxMessages);
          break;
        }
      }
    }
    const legalStart = findLegalMessageStart(retained);
    if (legalStart) retained = retained.slice(legalStart);
    if (retained.length > maxMessages) retained = retained.slice(-maxMessages);
    const cappedLegalStart = findLegalMessageStart(retained);
    if (cappedLegalStart) retained = retained.slice(cappedLegalStart);
    this.messages = retained;
    const dropped = oldLen - retained.length;
    this.lastConsolidated = Math.max(0, this.lastConsolidated - dropped);
    this.updatedAt = new Date().toISOString();
  }

  enforceFileCap(onArchive: ((messages: Record<string, any>[]) => void) | null = null, limit = FILE_MAX_MESSAGES): void {
    if (limit <= 0 || this.messages.length <= limit) return;
    const before = [...this.messages];
    const beforeLastConsolidated = this.lastConsolidated;
    const beforeCount = before.length;
    this.retainRecentLegalSuffix(limit);
    const droppedCount = beforeCount - this.messages.length;
    if (droppedCount <= 0) return;
    const dropped = before.slice(0, droppedCount);
    const alreadyConsolidated = Math.min(beforeLastConsolidated, droppedCount);
    const archiveChunk = dropped.slice(alreadyConsolidated);
    if (archiveChunk.length && onArchive) onArchive(archiveChunk);
  }

  clear(): void {
    this.messages = [];
    this.lastConsolidated = 0;
    delete this.metadata.lastSummary;
    this.updatedAt = new Date().toISOString();
  }

  toJSON(): Record<string, any> {
    return {
      key: this.key,
      messages: this.messages,
      metadata: this.metadata,
      lastConsolidated: this.lastConsolidated,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

export class SessionManager {
  root: string;
  sessionsDir: string;
  sessions = new Map<string, Session>();

  constructor(root: string) {
    this.root = path.resolve(String(root));
    this.sessionsDir = this.root;
    fs.mkdirSync(this.root, { recursive: true });
  }

  static safeKey(key: string): string {
    return key.replace(/[^A-Za-z0-9_.-]+/g, "_");
  }

  pathFor(key: string): string {
    return path.join(this.root, `${SessionManager.safeKey(key.replaceAll(":", "_"))}.jsonl`);
  }

  getOrCreate(key: string): Session {
    const cached = this.sessions.get(key);
    if (cached) return cached;
    const session = this.loadSession(key) ?? new Session({ key });
    this.sessions.set(key, session);
    return session;
  }

  getOrCreateWithInfo(key: string): { session: Session; created: boolean } {
    const cached = this.sessions.get(key);
    if (cached) return { session: cached, created: false };
    const loaded = this.loadSession(key);
    const session = loaded ?? new Session({ key });
    this.sessions.set(key, session);
    return { session, created: loaded == null };
  }

  invalidate(key: string): void {
    this.sessions.delete(key);
  }

  private parseDate(value: any): string | undefined {
    if (typeof value !== "string" || !value) return undefined;
    const time = Date.parse(value);
    return Number.isNaN(time) ? undefined : new Date(time).toISOString();
  }

  private sessionFromParts(
    key: string,
    {
      storedKey,
      messages,
      metadata,
      lastConsolidated,
      createdAt,
      updatedAt,
    }: {
      storedKey?: string | null;
      messages: Record<string, any>[];
      metadata: Record<string, any>;
      lastConsolidated: number;
      createdAt?: string;
      updatedAt?: string;
    },
  ): Session {
    return new Session({
      key: storedKey || key,
      messages,
      metadata,
      lastConsolidated,
      createdAt: this.parseDate(createdAt),
      updatedAt: this.parseDate(updatedAt),
    });
  }

  private parseJsonlSession(key: string, repair: boolean): Session | null {
    const file = this.pathFor(key);
    if (!fs.existsSync(file)) return null;
    const messages: Record<string, any>[] = [];
    let metadata: Record<string, any> = {};
    let createdAt: string | undefined;
    let updatedAt: string | undefined;
    let storedKey: string | null = null;
    let lastConsolidated = 0;
    let skipped = 0;
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      let data: any;
      try {
        data = JSON.parse(line);
      } catch (error) {
        if (!repair) throw error;
        skipped += 1;
        continue;
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        if (!repair) throw new Error("session JSONL record must be an object");
        skipped += 1;
        continue;
      }
      if (data.recordType === "metadata") {
        metadata = data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata) ? data.metadata : {};
        createdAt = data.createdAt;
        updatedAt = data.updatedAt;
        storedKey = typeof data.key === "string" ? data.key : null;
        lastConsolidated = Number.isFinite(data.lastConsolidated) ? Number(data.lastConsolidated) : 0;
      } else {
        messages.push(data);
      }
    }
    if (repair && skipped && !messages.length && !Object.keys(metadata).length) return null;
    return this.sessionFromParts(key, { storedKey, messages, metadata, lastConsolidated, createdAt, updatedAt });
  }

  loadSession(key: string): Session | null {
    try {
      return this.parseJsonlSession(key, false);
    } catch {
      return this.repairSession(key);
    }
  }

  repairSession(key: string): Session | null {
    try {
      return this.parseJsonlSession(key, true);
    } catch {
      return null;
    }
  }

  private metadataLine(session: Session): Record<string, any> {
    return {
      recordType: "metadata",
      key: session.key,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      metadata: session.metadata,
      lastConsolidated: session.lastConsolidated,
    };
  }

  private encodeJsonl(session: Session): string {
    const lines = [this.metadataLine(session), ...session.messages].map((item) => JSON.stringify(item));
    return `${lines.join("\n")}\n`;
  }

  save(session: Session, options: { fsync?: boolean } | boolean = {}): void {
    const shouldFsync = typeof options === "boolean" ? options : Boolean(options.fsync);
    fs.mkdirSync(this.root, { recursive: true });
    const file = this.pathFor(session.key);
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, this.encodeJsonl(session), "utf8");
      if (shouldFsync) {
        const fd = fs.openSync(tmp, "r");
        try {
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      }
      fs.renameSync(tmp, file);
      if (shouldFsync && process.platform !== "win32") {
        try {
          const dirFd = fs.openSync(this.root, "r");
          try {
            fs.fsyncSync(dirFd);
          } finally {
            fs.closeSync(dirFd);
          }
        } catch {
          // Some filesystems do not support directory fsync; the file has already been flushed.
        }
      }
    } catch (error) {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        // Best-effort temp cleanup; rethrow the original failure.
      }
      throw error;
    }
    this.sessions.set(session.key, session);
  }

  flushAll(): number {
    let flushed = 0;
    for (const session of this.sessions.values()) {
      try {
        this.save(session, { fsync: true });
        flushed += 1;
      } catch {
        // Keep shutdown flushing best-effort across all cached sessions.
      }
    }
    return flushed;
  }

  async saveAsync(session: Session): Promise<void> {
    await fsp.mkdir(this.root, { recursive: true });
    const file = this.pathFor(session.key);
    const tmp = `${file}.tmp`;
    try {
      await fsp.writeFile(tmp, this.encodeJsonl(session), "utf8");
      await fsp.rename(tmp, file);
      this.sessions.set(session.key, session);
    } catch (error) {
      await fsp.unlink(tmp).catch(() => undefined);
      throw error;
    }
  }

  delete(key: string): boolean {
    this.sessions.delete(key);
    const file = this.pathFor(key);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      return true;
    }
    return false;
  }

  deleteSession(key: string): boolean {
    return this.delete(key);
  }

  renameSession(key: string, title: string): Record<string, any> | null {
    const session = this.loadSession(key);
    if (!session) {
      return null;
    }

    const trimmedTitle = title.trim();
    session.metadata ??= {};
    session.metadata[WEBUI_SESSION_METADATA_KEY] = true;
    if (trimmedTitle) {
      session.metadata[WEBUI_TITLE_METADATA_KEY] = trimmedTitle;
      session.metadata[WEBUI_TITLE_USER_EDITED_METADATA_KEY] = true;
    } else {
      delete session.metadata[WEBUI_TITLE_METADATA_KEY];
      delete session.metadata[WEBUI_TITLE_USER_EDITED_METADATA_KEY];
    }
    session.updatedAt = new Date().toISOString();
    this.save(session);
    return sessionSummary(session, this.pathFor(key));
  }

  readSessionFile(key: string): Record<string, any> | null {
    const session = this.loadSession(key);
    if (!session) {
      return null;
    }
    return {
      key: session.key,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      metadata: session.metadata,
      messages: session.messages,
    };
  }

  listSessions(): Record<string, any>[] {
    const rows: Record<string, any>[] = [];
    for (const file of fs.readdirSync(this.root).filter((name) => name.endsWith(".jsonl"))) {
      const fullPath = path.join(this.root, file);
      const fallbackKey = path.basename(file, ".jsonl").replace("_", ":");
      try {
        const session = this.parseJsonlSession(fallbackKey, false);
        if (!session) continue;
        rows.push(sessionSummary(session, fullPath));
      } catch {
        const repaired = this.repairSession(fallbackKey);
        if (!repaired) continue;
        rows.push(sessionSummary(repaired, fullPath, { repairPreview: true }));
      }
    }
    rows.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
    return rows;
  }
}
