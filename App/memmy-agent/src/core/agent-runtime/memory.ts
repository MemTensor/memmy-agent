import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { estimateMessageTokens, Session } from "../session/manager.js";
import { GitStore } from "../../utils/gitstore.js";
import { ensureDir, estimatePromptTokensChain, stripThink, truncateText } from "../../utils/helpers.js";
import { renderTemplate } from "../../utils/prompt-templates.js";
import { DagSnapshotBuilder, SessionDagStore, type SessionDagQueueManager } from "../../session-dag/index.js";
import { AgentHook, AgentHookContext } from "./hook.js";
import { AgentRunner, AgentRunSpec } from "./runner.js";
import { EditFileTool, ReadFileTool, WriteFileTool } from "./tools/filesystem.js";
import { ToolRegistry } from "./tools/registry.js";

export const RAW_ARCHIVE_MAX_CHARS = 16_000;
export const ARCHIVE_SUMMARY_MAX_CHARS = 8_000;
export const HISTORY_ENTRY_HARD_CAP = 64_000;
export const STALE_THRESHOLD_DAYS = 14;

export type TokenCompactionStatus = "running" | "done" | "error";

export interface TokenCompactionEvent {
  kind: "token";
  status: TokenCompactionStatus;
  replayMaxMessages: number | null;
  changed?: boolean;
}

export interface TokenCompactionResult {
  kind: "token";
  replayMaxMessages: number | null;
  changed: boolean;
  summary: string | null;
  error: string | null;
  started: boolean;
}

type TokenCompactionEventCallback = (event: TokenCompactionEvent) => Promise<void> | void;

type TokenCompactionOptions = {
  replayMaxMessages?: number | null;
  onCompactionEvent?: TokenCompactionEventCallback;
  notifyOnLockWait?: boolean;
};

export interface HistoryEntry {
  cursor?: unknown;
  timestamp?: string;
  content?: string;
  session_key?: string;
  [key: string]: unknown;
}

type AppendHistoryOptions = {
  maxChars?: number | null;
  sessionKey?: string | null;
};

type RecentHistoryPromptOptions = {
  sessionKey: string | null;
  unifiedSession?: boolean;
};

type ArchiveOptions = {
  sessionKey?: string | null;
};

const LEGACY_ENTRY_START_RE = /^\[(\d{4}-\d{2}-\d{2}[^\]]*)\]\s*/;
const LEGACY_TIMESTAMP_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\s*/;
const LEGACY_RAW_MESSAGE_RE = /^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s+[A-Z][A-Z0-9_]*(?:\s+\[tools:\s*[^\]]+\])?:/;

function formatLocalMinute(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

function readUtf8Replacing(file: string): string {
  return fs.readFileSync(file).toString("utf8");
}

export class MemoryStore {
  static DEFAULT_MAX_HISTORY = 1000;

  root: string;
  workspace: string;
  maxHistoryEntries: number;
  memoryDir: string;
  memoryFile: string;
  historyFile: string;
  legacyHistoryFile: string;
  soulFile: string;
  userFile: string;
  cursorFile: string;
  dreamCursorFile: string;
  corruptionLogged = false;
  oversizeLogged = false;
  gitStore: GitStore;

  constructor(workspace: string, maxHistoryEntries: number | { maxHistoryEntries?: number } = MemoryStore.DEFAULT_MAX_HISTORY) {
    this.workspace = this.root = path.resolve(workspace);
    const maxEntries =
      typeof maxHistoryEntries === "number"
        ? maxHistoryEntries
        : (maxHistoryEntries.maxHistoryEntries ?? MemoryStore.DEFAULT_MAX_HISTORY);
    this.maxHistoryEntries = maxEntries;
    this.memoryDir = ensureDir(path.join(this.workspace, "memory"));
    this.memoryFile = path.join(this.memoryDir, "MEMORY.md");
    this.historyFile = path.join(this.memoryDir, "history.jsonl");
    this.legacyHistoryFile = path.join(this.memoryDir, "HISTORY.md");
    this.soulFile = path.join(this.workspace, "SOUL.md");
    this.userFile = path.join(this.workspace, "USER.md");
    this.cursorFile = path.join(this.memoryDir, ".cursor");
    this.dreamCursorFile = path.join(this.memoryDir, ".dreamCursor");
    this.gitStore = new GitStore(this.workspace, ["SOUL.md", "USER.md", "memory/MEMORY.md", "memory/.dreamCursor"]);
    this.maybeMigrateLegacyHistory();
  }

  get git(): GitStore {
    return this.gitStore;
  }

  path(name = "memory/MEMORY.md"): string {
    return path.join(this.root, name);
  }

  read(name = "memory/MEMORY.md"): string {
    return this.readFile(this.path(name));
  }

  write(content: string, name = "memory/MEMORY.md"): void {
    const file = this.path(name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }

  readFile(filePath: string): string {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  readMemory(): string {
    return this.readFile(this.memoryFile);
  }

  writeMemory(content: string): void {
    fs.mkdirSync(path.dirname(this.memoryFile), { recursive: true });
    fs.writeFileSync(this.memoryFile, content, "utf8");
  }

  readSoul(): string {
    return this.readFile(this.soulFile);
  }

  writeSoul(content: string): void {
    fs.writeFileSync(this.soulFile, content, "utf8");
  }

  readUser(): string {
    return this.readFile(this.userFile);
  }

  writeUser(content: string): void {
    fs.writeFileSync(this.userFile, content, "utf8");
  }

  getMemoryContext(): string {
    const longTerm = this.readMemory();
    return longTerm ? `## Long-term Memory\n${longTerm}` : "";
  }

  appendHistory(entry: string, options: AppendHistoryOptions | number = {}): number {
    const opt = typeof options === "number" ? { maxChars: options } : options;
    const limit = opt.maxChars ?? HISTORY_ENTRY_HARD_CAP;
    const cursor = this.nextCursor();
    const timestamp = formatLocalMinute(new Date());
    let raw = entry.replace(/\s+$/u, "");
    if (raw.length > limit) {
      if (!this.oversizeLogged) {
        this.oversizeLogged = true;
        console.warn(`history entry exceeds ${limit} chars (${raw.length}); truncating. Further occurrences suppressed.`);
      }
      raw = truncateText(raw, limit);
    }
    const content = stripThink(raw).trim();
    const record: HistoryEntry = { cursor, timestamp, content };
    if (typeof opt.sessionKey === "string" && opt.sessionKey.length > 0) record.session_key = opt.sessionKey;
    fs.mkdirSync(path.dirname(this.historyFile), { recursive: true });
    fs.appendFileSync(this.historyFile, `${JSON.stringify(record)}\n`, "utf8");
    fs.writeFileSync(this.cursorFile, String(cursor), "utf8");
    return cursor;
  }

  static validCursor(value: unknown): number | null {
    return typeof value === "number" && Number.isInteger(value) ? value : null;
  }

  validCursor(value: unknown): number | null {
    return MemoryStore.validCursor(value);
  }

  *iterValidEntries(): IterableIterator<[HistoryEntry, number]> {
    let poisoned: unknown = undefined;
    for (const entry of this.readEntries()) {
      if (!Object.prototype.hasOwnProperty.call(entry, "cursor")) continue;
      const cursor = this.validCursor(entry.cursor);
      if (cursor === null) {
        poisoned = entry.cursor;
        continue;
      }
      yield [entry, cursor];
    }
    if (poisoned !== undefined && !this.corruptionLogged) {
      this.corruptionLogged = true;
      console.warn(`history.jsonl contains a non-int cursor (${JSON.stringify(poisoned)}); dropping it. Further occurrences suppressed.`);
    }
  }

  nextCursor(): number {
    if (fs.existsSync(this.cursorFile)) {
      try {
        const value = Number.parseInt(fs.readFileSync(this.cursorFile, "utf8").trim(), 10);
        if (Number.isFinite(value) && String(value) === fs.readFileSync(this.cursorFile, "utf8").trim()) return value + 1;
      } catch {
        // Fall back to history scan below.
      }
    }
    const last = this.readLastEntry();
    const cursor = this.validCursor(last?.cursor);
    if (cursor !== null) return cursor + 1;
    let max = 0;
    for (const [, validCursor] of this.iterValidEntries()) max = Math.max(max, validCursor);
    return max + 1;
  }

  readUnprocessedHistory(sinceCursor = 0): HistoryEntry[] {
    return [...this.iterValidEntries()].filter(([, cursor]) => cursor > sinceCursor).map(([entry]) => entry);
  }

  private static isInternalHistorySession(sessionKey: unknown): boolean {
    if (typeof sessionKey !== "string") return false;
    return sessionKey === "heartbeat" || sessionKey.startsWith("cron:") || sessionKey.startsWith("dream:");
  }

  readRecentHistoryForPrompt(
    sinceCursor: number,
    { sessionKey, unifiedSession = false }: RecentHistoryPromptOptions,
  ): HistoryEntry[] {
    const entries = this.readUnprocessedHistory(sinceCursor);
    if (sessionKey === null) return entries;
    return entries.filter((entry) => {
      const entrySessionKey = entry.session_key as unknown;
      if (entrySessionKey !== null && entrySessionKey !== undefined && typeof entrySessionKey !== "string") {
        return false;
      }
      if (!unifiedSession) return entrySessionKey === sessionKey;
      return entrySessionKey === sessionKey || !MemoryStore.isInternalHistorySession(entrySessionKey);
    });
  }

  readHistory(): HistoryEntry[] {
    return this.readEntries();
  }

  getLastCursor(): number {
    const last = this.readLastEntry();
    const cursor = this.validCursor(last?.cursor);
    if (cursor !== null) return cursor;
    let max = 0;
    for (const [, validCursor] of this.iterValidEntries()) max = Math.max(max, validCursor);
    return max;
  }

  compactHistory(): void {
    if (this.maxHistoryEntries <= 0) return;
    const entries = this.readEntries();
    if (entries.length <= this.maxHistoryEntries) return;
    this.writeEntries(entries.slice(-this.maxHistoryEntries));
  }

  readEntries(): HistoryEntry[] {
    const entries: HistoryEntry[] = [];
    if (!fs.existsSync(this.historyFile)) return entries;
    const text = fs.readFileSync(this.historyFile, "utf8");
    for (const line of text.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) entries.push(parsed as HistoryEntry);
      } catch {
        // Ignore corrupt JSONL rows just like memmy's best-effort reader.
      }
    }
    return entries;
  }

  readLastEntry(): HistoryEntry | null {
    if (!fs.existsSync(this.historyFile) || fs.statSync(this.historyFile).size === 0) return null;
    const text = fs.readFileSync(this.historyFile, "utf8");
    const lines = text.split(/\r?\n/u).filter((line) => line.trim());
    if (!lines.length) return null;
    try {
      const parsed = JSON.parse(lines.at(-1)!) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as HistoryEntry) : null;
    } catch {
      return null;
    }
  }

  writeEntries(entries: HistoryEntry[]): void {
    fs.mkdirSync(path.dirname(this.historyFile), { recursive: true });
    const tmpPath = `${this.historyFile}.tmp`;
    try {
      const fd = fs.openSync(tmpPath, "w");
      try {
        for (const entry of entries) fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmpPath, this.historyFile);
      try {
        const dirFd = fs.openSync(path.dirname(this.historyFile), "r");
        try {
          fs.fsyncSync(dirFd);
        } finally {
          fs.closeSync(dirFd);
        }
      } catch {
        // Some platforms do not support fsync on directories.
      }
    } catch (error) {
      fs.rmSync(tmpPath, { force: true });
      throw error;
    }
  }

  getLastDreamCursor(): number {
    if (!fs.existsSync(this.dreamCursorFile)) return 0;
    try {
      const raw = fs.readFileSync(this.dreamCursorFile, "utf8").trim();
      const value = Number.parseInt(raw, 10);
      return Number.isFinite(value) && String(value) === raw ? value : 0;
    } catch {
      return 0;
    }
  }

  setLastDreamCursor(cursor: number): void {
    fs.writeFileSync(this.dreamCursorFile, String(cursor), "utf8");
  }

  static formatMessages(messages: Array<Record<string, any>>): string {
    const lines: string[] = [];
    for (const message of messages) {
      const content = message.content;
      if (!content) continue;
      const toolsUsed = message.toolsUsed as unknown;
      const tools = Array.isArray(toolsUsed) && toolsUsed.length ? ` [tools: ${toolsUsed.join(", ")}]` : "";
      const timestamp = String(message.timestamp ?? "?").slice(0, 16);
      lines.push(`[${timestamp}] ${String(message.role ?? "").toUpperCase()}${tools}: ${String(content)}`);
    }
    return lines.join("\n");
  }

  formatMessages(messages: Array<Record<string, any>>): string {
    return MemoryStore.formatMessages(messages);
  }

  rawArchive(messages: Array<Record<string, any>>, options: AppendHistoryOptions | number = {}): void {
    const opt = typeof options === "number" ? { maxChars: options } : options;
    const limit = opt.maxChars ?? RAW_ARCHIVE_MAX_CHARS;
    const formatted = truncateText(this.formatMessages(messages), limit);
    this.appendHistory(`[RAW] ${messages.length} messages\n${formatted}`, {
      maxChars: limit,
      sessionKey: opt.sessionKey,
    });
    console.warn(`Memory consolidation degraded: raw-archived ${messages.length} messages`);
  }

  private maybeMigrateLegacyHistory(): void {
    if (!fs.existsSync(this.legacyHistoryFile)) return;
    if (fs.existsSync(this.historyFile) && fs.statSync(this.historyFile).size > 0) return;

    let legacyText: string;
    try {
      legacyText = readUtf8Replacing(this.legacyHistoryFile);
    } catch (error) {
      console.warn(`Failed to read legacy HISTORY.md for migration: ${(error as Error).message}`);
      return;
    }

    const entries = this.parseLegacyHistory(legacyText);
    try {
      if (entries.length) {
        this.writeEntries(entries);
        const lastCursor = this.validCursor(entries.at(-1)?.cursor) ?? entries.length;
        fs.writeFileSync(this.cursorFile, String(lastCursor), "utf8");
        fs.writeFileSync(this.dreamCursorFile, String(lastCursor), "utf8");
      }
      const backupPath = this.nextLegacyBackupPath();
      fs.renameSync(this.legacyHistoryFile, backupPath);
    } catch (error) {
      console.warn(`Failed to migrate legacy HISTORY.md: ${(error as Error).message}`);
    }
  }

  parseLegacyHistory(text: string): HistoryEntry[] {
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    if (!normalized) return [];

    const fallbackTimestamp = this.legacyFallbackTimestamp();
    return this.splitLegacyHistoryChunks(normalized).map((chunk, index) => {
      let timestamp = fallbackTimestamp;
      let content = chunk;
      const match = LEGACY_TIMESTAMP_RE.exec(chunk);
      if (match) {
        timestamp = match[1];
        const remainder = chunk.slice(match[0].length).trimStart();
        if (remainder) content = remainder;
      }
      return { cursor: index + 1, timestamp, content };
    });
  }

  splitLegacyHistoryChunks(text: string): string[] {
    const lines = text.split("\n");
    const chunks: string[] = [];
    let current: string[] = [];
    let sawBlankSeparator = false;

    for (const line of lines) {
      if (sawBlankSeparator && line.trim() && current.length) {
        chunks.push(current.join("\n").trim());
        current = [line];
        sawBlankSeparator = false;
        continue;
      }
      if (this.shouldStartNewLegacyChunk(line, current)) {
        chunks.push(current.join("\n").trim());
        current = [line];
        sawBlankSeparator = false;
        continue;
      }
      current.push(line);
      sawBlankSeparator = !line.trim();
    }

    if (current.length) chunks.push(current.join("\n").trim());
    return chunks.filter(Boolean);
  }

  shouldStartNewLegacyChunk(line: string, current: string[]): boolean {
    if (!current.length) return false;
    if (!LEGACY_ENTRY_START_RE.test(line)) return false;
    if (this.isRawLegacyChunk(current) && LEGACY_RAW_MESSAGE_RE.test(line)) return false;
    return true;
  }

  isRawLegacyChunk(lines: string[]): boolean {
    const firstNonempty = lines.find((line) => line.trim()) ?? "";
    const match = LEGACY_TIMESTAMP_RE.exec(firstNonempty);
    if (!match) return false;
    return firstNonempty.slice(match[0].length).trimStart().startsWith("[RAW]");
  }

  legacyFallbackTimestamp(): string {
    try {
      return formatLocalMinute(fs.statSync(this.legacyHistoryFile).mtime);
    } catch {
      return formatLocalMinute(new Date());
    }
  }

  nextLegacyBackupPath(): string {
    let candidate = path.join(this.memoryDir, "HISTORY.md.bak");
    let suffix = 2;
    while (fs.existsSync(candidate)) {
      candidate = path.join(this.memoryDir, `HISTORY.md.bak.${suffix}`);
      suffix += 1;
    }
    return candidate;
  }
}

function findLegalMessageStart(messages: Record<string, any>[]): number {
  const declared = new Set<string>();
  let start = 0;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) if (call?.id) declared.add(String(call.id));
    } else if (message.role === "tool") {
      const id = message.tool_call_id;
      if (id && !declared.has(String(id))) {
        start = i + 1;
        declared.clear();
      }
    }
  }
  return start;
}

class AsyncLock {
  private tail: Promise<void> = Promise.resolve();
  private lockedValue = false;

  locked(): boolean {
    return this.lockedValue;
  }

  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    this.lockedValue = true;
    try {
      return await fn();
    } finally {
      this.lockedValue = false;
      release();
    }
  }
}

type ConsolidatorInit = {
  store: MemoryStore;
  provider: any;
  model: string;
  sessions: any;
  contextWindowTokens?: number;
  buildMessages?: (...args: any[]) => Record<string, any>[];
  getToolDefinitions?: () => Record<string, any>[];
  maxCompletionTokens?: number;
  consolidationRatio?: number;
  unifiedSession?: boolean;
  lifecycleHook?: (() => AgentHook | null) | null;
  summaryMode?: "text" | "dag";
  dagQueue?: SessionDagQueueManager | null;
  dagCatchupTimeoutMs?: number;
  createDagStore?: ((sessionKey: string) => SessionDagStore) | null;
};

export class Consolidator {
  static MAX_CONSOLIDATION_ROUNDS = 5;
  static SAFETY_BUFFER = 1024;

  store: MemoryStore;
  provider: any;
  model: string;
  sessions: any;
  contextWindowTokens: number;
  maxCompletionTokens: number;
  consolidationRatio: number;
  unifiedSession: boolean;
  safetyBuffer = Consolidator.SAFETY_BUFFER;
  maxConsolidationRounds = Consolidator.MAX_CONSOLIDATION_ROUNDS;
  buildMessages: (...args: any[]) => Record<string, any>[];
  getToolDefinitions: () => Record<string, any>[];
  private lifecycleHook: (() => AgentHook | null) | null;
  summaryMode: "text" | "dag";
  dagQueue: SessionDagQueueManager | null;
  dagCatchupTimeoutMs: number;
  createDagStore: ((sessionKey: string) => SessionDagStore) | null;
  private locks = new Map<string, AsyncLock>();

  constructor(init: ConsolidatorInit);
  constructor(
    store: MemoryStore,
    provider: any,
    model: string,
    sessions: any,
    contextWindowTokens: number,
    buildMessages: (...args: any[]) => Record<string, any>[],
    getToolDefinitions: () => Record<string, any>[],
    maxCompletionTokens?: number,
    consolidationRatio?: number,
  );
  constructor(
    initOrStore: ConsolidatorInit | MemoryStore,
    provider?: any,
    model?: string,
    sessions?: any,
    contextWindowTokens?: number,
    buildMessages?: (...args: any[]) => Record<string, any>[],
    getToolDefinitions?: () => Record<string, any>[],
    maxCompletionTokens?: number,
    consolidationRatio?: number,
  ) {
    const init =
      initOrStore instanceof MemoryStore
        ? {
            store: initOrStore,
            provider,
            model: model ?? "",
            sessions,
            contextWindowTokens,
            buildMessages,
            getToolDefinitions,
            maxCompletionTokens,
            consolidationRatio,
          }
        : initOrStore;
    this.store = init.store;
    this.provider = init.provider;
    this.model = init.model;
    this.sessions = init.sessions;
    this.contextWindowTokens = init.contextWindowTokens ?? 0;
    this.maxCompletionTokens = init.maxCompletionTokens ?? init.provider?.generation?.maxTokens ?? 4096;
    this.consolidationRatio = init.consolidationRatio ?? 0.5;
    this.unifiedSession = init.unifiedSession ?? false;
    this.buildMessages = init.buildMessages ?? ((args: any) => args?.history ?? []);
    this.getToolDefinitions = init.getToolDefinitions ?? (() => []);
    this.lifecycleHook = init.lifecycleHook ?? null;
    this.summaryMode = init.summaryMode ?? "text";
    this.dagQueue = init.dagQueue ?? null;
    this.dagCatchupTimeoutMs = init.dagCatchupTimeoutMs ?? 120_000;
    this.createDagStore = init.createDagStore ?? null;
  }

  private getLifecycleHook(): AgentHook | null {
    return this.lifecycleHook?.() ?? null;
  }

  private async emitBeforeCompaction(context: AgentHookContext): Promise<void> {
    await this.getLifecycleHook()?.beforeCompaction(context);
  }

  private async emitAfterCompaction(context: AgentHookContext): Promise<void> {
    await this.getLifecycleHook()?.afterCompaction(context);
  }

  setProvider(provider: any, model: string, contextWindowTokens: number): void {
    this.provider = provider;
    this.model = model;
    this.contextWindowTokens = contextWindowTokens;
    this.maxCompletionTokens = provider?.generation?.maxTokens ?? this.maxCompletionTokens;
  }

  getLock(sessionKey: string): AsyncLock {
    let lock = this.locks.get(sessionKey);
    if (!lock) {
      lock = new AsyncLock();
      this.locks.set(sessionKey, lock);
    }
    return lock;
  }

  get inputTokenBudget(): number {
    return this.contextWindowTokens - this.maxCompletionTokens - this.safetyBuffer;
  }

  pickConsolidationBoundary(session: Session | any, tokensToRemove: number): [number, number] | null {
    const start = session.lastConsolidated ?? 0;
    if (start >= session.messages.length || tokensToRemove <= 0) return null;

    let removedTokens = 0;
    let lastBoundary: [number, number] | null = null;
    for (let idx = start; idx < session.messages.length; idx += 1) {
      const message = session.messages[idx];
      if (idx > start && message.role === "user") {
        lastBoundary = [idx, removedTokens];
        if (removedTokens >= tokensToRemove) return lastBoundary;
      }
      removedTokens += estimateMessageTokens(message);
    }
    return lastBoundary;
  }

  static fullUnconsolidatedHistory(session: Session | any, { includeTimestamps = false }: { includeTimestamps?: boolean } = {}): Record<string, any>[] {
    const last = session.lastConsolidated ?? 0;
    const unconsolidatedCount = session.messages.length - last;
    if (unconsolidatedCount <= 0) return [];
    if (typeof session.getHistory === "function") {
      return session.getHistory({ maxMessages: unconsolidatedCount, includeTimestamps });
    }
    return session.messages.slice(last);
  }

  static replayOverflowBoundary(session: Session | any, replayMaxMessages?: number | null): number | null {
    if (!replayMaxMessages || replayMaxMessages <= 0) return null;
    const last = session.lastConsolidated ?? 0;
    const tail: Array<[number, Record<string, any>]> = session.messages
      .slice(last)
      .map((message: Record<string, any>, offset: number) => [last + offset, message]);
    if (tail.length <= replayMaxMessages) return null;

    let sliced: Array<[number, Record<string, any>]> = tail.slice(-replayMaxMessages);
    const firstUser = sliced.findIndex(([, message]) => message.role === "user");
    if (firstUser >= 0) {
      const start = firstUser > 0 && sliced[firstUser - 1][1].channelDelivery ? firstUser - 1 : firstUser;
      sliced = sliced.slice(start);
    }

    const legalStart = findLegalMessageStart(sliced.map(([, message]) => message));
    if (legalStart) sliced = sliced.slice(legalStart);
    if (!sliced.length) return session.messages.length;

    const firstVisibleIdx = sliced[0][0];
    if (firstVisibleIdx <= last) return null;
    return firstVisibleIdx;
  }

  async consolidateReplayOverflow(
    session: Session | any,
    replayMaxMessages?: number | null,
    beforeArchive?: () => Promise<void> | void,
  ): Promise<string | null> {
    const endIdx = Consolidator.replayOverflowBoundary(session, replayMaxMessages);
    if (endIdx == null) return null;
    const last = session.lastConsolidated ?? 0;
    const chunk = session.messages.slice(last, endIdx);
    if (!chunk.length) return null;
    await beforeArchive?.();
    const summary = await this.archive(chunk, { sessionKey: session.key ?? null });
    session.lastConsolidated = endIdx;
    this.saveSession(session);
    return summary;
  }

  persistLastSummary(session: Session | any, summary: string | null | undefined): void {
    if (!summary || summary === "(nothing)") return;
    session.metadata ??= {};
    session.metadata.lastSummary = {
      text: summary,
      mode: "text",
      lastActive: session.updatedAt ?? new Date().toISOString(),
    };
    this.saveSession(session);
  }

  estimateSessionPromptTokens(session: Session | any): [number, string] {
    const history = Consolidator.fullUnconsolidatedHistory(session, { includeTimestamps: true });
    const [channel, chatId] = String(session.key ?? "").includes(":") ? String(session.key).split(":", 2) : [null, null];
    const meta = session.metadata?.lastSummary;
    const summary = typeof meta === "string" ? meta : meta && typeof meta === "object" ? meta.text : null;
    const messages = this.buildMessages({
      history,
      currentMessage: "[token-probe]",
      channel,
      chatId,
      senderId: null,
      sessionSummary: summary,
      sessionMetadata: session.metadata ?? {},
      sessionKey: session.key ?? null,
      unifiedSession: this.unifiedSession,
    });
    const tools = this.getToolDefinitions();
    if (typeof this.provider?.estimatePromptTokens === "function") {
      return this.provider.estimatePromptTokens(this.model, messages, tools);
    }
    return [estimatePromptTokensChain([...messages, ...tools]) as number, "json"];
  }

  truncateToTokenBudget(text: string): string {
    const budget = this.inputTokenBudget;
    if (budget <= 0) return truncateText(text, RAW_ARCHIVE_MAX_CHARS);
    return truncateText(text, budget * 4);
  }

  async archive(messages: Record<string, any>[], { sessionKey = null }: ArchiveOptions = {}): Promise<string | null> {
    if (!messages.length) return null;
    try {
      const formatted = this.truncateToTokenBudget(MemoryStore.formatMessages(messages));
      const chat = this.provider?.chatWithRetry ?? this.provider?.chatWithRetry;
      if (typeof chat !== "function") throw new Error("provider does not implement chatWithRetry");
      const response = await chat.call(this.provider, {
        model: this.model,
        messages: [
          {
            role: "system",
            content: renderTemplate("agent/consolidator-archive.md", { strip: true }),
          },
          { role: "user", content: formatted },
        ],
        tools: null,
        tool_choice: null,
        toolChoice: null,
      });
      const finishReason = response?.finishReason ?? response?.finish_reason ?? "stop";
      if (finishReason === "error") throw new Error(`LLM returned error: ${response?.content ?? ""}`);
      const summary = response?.content || "[no summary]";
      this.store.appendHistory(summary, { maxChars: ARCHIVE_SUMMARY_MAX_CHARS, sessionKey });
      return summary;
    } catch {
      this.store.rawArchive(messages, { sessionKey });
      return null;
    }
  }

  async maybeConsolidateByTokens(
    session: Session | any,
    opts: TokenCompactionOptions = {},
  ): Promise<TokenCompactionResult> {
    if (this.summaryMode === "dag") return this.maybeConsolidateByDag(session, opts);
    const replayMaxMessages = opts.replayMaxMessages ?? null;
    const sessionKey = String(session.key ?? "");
    let currentSession = session;
    let changed = false;
    let summary: string | null = null;
    let error: string | null = null;
    let started = false;
    const result = (): TokenCompactionResult => ({
      kind: "token",
      replayMaxMessages,
      changed,
      summary,
      error,
      started,
    });
    const emitCompactionEvent = async (event: TokenCompactionEvent): Promise<void> => {
      try {
        await opts.onCompactionEvent?.(event);
      } catch {
        // UI notification is best-effort and must not affect session compaction.
      }
    };
    const notifyRunning = async (): Promise<void> => {
      if (started) return;
      started = true;
      await emitCompactionEvent({
        kind: "token",
        status: "running",
        replayMaxMessages,
      });
    };
    if (this.contextWindowTokens <= 0) return result();
    await this.emitBeforeCompaction(new AgentHookContext({
      sessionKey,
      session,
      reason: "tokenBudget",
      compaction: { kind: "token", replayMaxMessages },
    }));
    const lock = this.getLock(session.key);
    if (opts.notifyOnLockWait && lock.locked()) await notifyRunning();
    try {
      await lock.runExclusive(async () => {
        const fresh = this.getSession(session.key);
        if (fresh && fresh !== session) session = fresh;
        currentSession = session;
        const beforeLastConsolidated = session.lastConsolidated ?? 0;
        const beforeMessageCount = session.messages?.length ?? 0;
        if (!session.messages?.length) return;

        const budget = this.inputTokenBudget;
        const target = Math.floor(budget * this.consolidationRatio);
        let lastSummary = await this.consolidateReplayOverflow(session, replayMaxMessages, notifyRunning);
        if (lastSummary) summary = lastSummary;
        let estimated: number;
        let source: string;
        try {
          [estimated, source] = this.estimateSessionPromptTokens(session);
          void source;
        } catch {
          estimated = 0;
        }
        if (estimated <= 0 || estimated < budget) {
          this.persistLastSummary(session, lastSummary);
          changed = changed || beforeLastConsolidated !== (session.lastConsolidated ?? 0) || beforeMessageCount !== (session.messages?.length ?? 0);
          return;
        }

        for (let round = 0; round < this.maxConsolidationRounds; round += 1) {
          if (estimated <= target) break;
          const boundary = this.pickConsolidationBoundary(session, Math.max(1, estimated - target));
          if (!boundary) break;
          const [endIdx] = boundary;
          const last = session.lastConsolidated ?? 0;
          const chunk = session.messages.slice(last, endIdx);
          if (!chunk.length) break;
          await notifyRunning();
          const archived = await this.archive(chunk, { sessionKey });
          if (archived) {
            lastSummary = archived;
            summary = archived;
          }
          session.lastConsolidated = endIdx;
          this.saveSession(session);
          if (!archived) break;
          try {
            [estimated, source] = this.estimateSessionPromptTokens(session);
            void source;
          } catch {
            estimated = 0;
          }
          if (estimated <= 0) break;
        }
        this.persistLastSummary(session, lastSummary);
        changed = changed || beforeLastConsolidated !== (session.lastConsolidated ?? 0) || beforeMessageCount !== (session.messages?.length ?? 0);
      });
      if (started) {
        await emitCompactionEvent({
          kind: "token",
          status: "done",
          replayMaxMessages,
          changed,
        });
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      if (started) {
        await emitCompactionEvent({
          kind: "token",
          status: "error",
          replayMaxMessages,
          changed,
        });
      }
      throw caught;
    } finally {
      await this.emitAfterCompaction(new AgentHookContext({
        sessionKey,
        session: currentSession,
        reason: "tokenBudget",
        compaction: { kind: "token", replayMaxMessages, changed, summary, error },
      }));
    }
    return result();
  }

  async maybeConsolidateByDag(
    session: Session | any,
    opts: TokenCompactionOptions = {},
  ): Promise<TokenCompactionResult> {
    const replayMaxMessages = opts.replayMaxMessages ?? null;
    const sessionKey = String(session.key ?? "");
    let currentSession = session;
    let changed = false;
    let summary: string | null = null;
    let error: string | null = null;
    let started = false;
    const result = (): TokenCompactionResult => ({
      kind: "token",
      replayMaxMessages,
      changed,
      summary,
      error,
      started,
    });
    const emitCompactionEvent = async (event: TokenCompactionEvent): Promise<void> => {
      try {
        await opts.onCompactionEvent?.(event);
      } catch {
        // UI notification is best-effort and must not affect session compaction.
      }
    };
    const notifyRunning = async (): Promise<void> => {
      if (started) return;
      started = true;
      await emitCompactionEvent({
        kind: "token",
        status: "running",
        replayMaxMessages,
      });
    };
    if (this.contextWindowTokens <= 0) return result();
    await this.emitBeforeCompaction(new AgentHookContext({
      sessionKey,
      session,
      reason: "tokenBudget",
      compaction: { kind: "token", mode: "dag", replayMaxMessages },
    }));
    const lock = this.getLock(session.key);
    if (opts.notifyOnLockWait && lock.locked()) await notifyRunning();
    try {
      await lock.runExclusive(async () => {
        const fresh = this.getSession(session.key);
        if (fresh && fresh !== session) session = fresh;
        currentSession = session;
        if (!session.messages?.length) return;

        const replayOverflow = Consolidator.replayOverflowBoundary(session, replayMaxMessages);
        let estimated = 0;
        try {
          [estimated] = this.estimateSessionPromptTokens(session);
        } catch {
          estimated = 0;
        }
        const budget = this.inputTokenBudget;
        if (replayOverflow == null && (estimated <= 0 || estimated < budget)) return;

        if (!this.dagQueue) {
          error = "Session DAG queue is not available for dag compaction";
          return;
        }

        const store = this.createDagStore ? this.createDagStore(sessionKey) : new SessionDagStore({ sessionKey });
        try {
          const target = latestDagTurnForSessionPrefix(store, session.messages.length);
          if (!target) return;
          if (target.message_end <= (session.lastConsolidated ?? 0)) return;
          await notifyRunning();
          const caughtUp = await this.dagQueue.waitUntilProcessed(sessionKey, target.turn_id, this.dagCatchupTimeoutMs);
          if (!caughtUp) {
            error = `Session DAG did not catch up to turn ${target.turn_id}`;
            return;
          }
          const refreshedTarget = store.getTurn(target.turn_id);
          if (!refreshedTarget || refreshedTarget.dag_status !== "done") {
            error = `Session DAG turn ${target.turn_id} is not done`;
            return;
          }
          const tokenBudget = Math.max(128, Math.floor(this.inputTokenBudget * this.consolidationRatio));
          const snapshot = new DagSnapshotBuilder(store).build({ turnId: target.turn_id, tokenBudget });
          summary = snapshot.snapshot_text;
          session.metadata ??= {};
          session.metadata.lastSummary = {
            text: snapshot.snapshot_text,
            mode: "dag",
            dagSnapshotId: snapshot.id,
            lastActive: session.updatedAt ?? new Date().toISOString(),
          };
          session.lastConsolidated = target.message_end;
          this.saveSession(session);
          changed = true;
        } finally {
          store.close();
        }
      });
      if (started) {
        await emitCompactionEvent({
          kind: "token",
          status: error ? "error" : "done",
          replayMaxMessages,
          changed,
        });
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      if (started) {
        await emitCompactionEvent({
          kind: "token",
          status: "error",
          replayMaxMessages,
          changed,
        });
      }
      throw caught;
    } finally {
      await this.emitAfterCompaction(new AgentHookContext({
        sessionKey,
        session: currentSession,
        reason: "tokenBudget",
        compaction: { kind: "token", mode: "dag", replayMaxMessages, changed, summary, error },
      }));
    }
    return result();
  }

  async compactIdleSession(sessionKey: string, maxSuffix = 8): Promise<string | null> {
    if (this.summaryMode === "dag") return null;
    let currentSession: Session | any = null;
    let changed = false;
    let summary: string | null = null;
    let error: string | null = null;
    await this.emitBeforeCompaction(new AgentHookContext({
      sessionKey,
      reason: "idle",
      compaction: { kind: "idle", maxSuffix },
    }));
    const lock = this.getLock(sessionKey);
    try {
      return await lock.runExclusive(async () => {
        this.invalidateSession(sessionKey);
        const session = this.getSession(sessionKey);
        currentSession = session;
        if (!session) return "";
        const beforeMessageCount = session.messages?.length ?? 0;
        const last = session.lastConsolidated ?? 0;
        const tail = session.messages.slice(last);
        if (!tail.length) {
          session.updatedAt = new Date().toISOString();
          this.saveSession(session);
          return "";
        }

        const probe = new Session({
          key: session.key,
          messages: tail.map((message: Record<string, any>) => ({ ...message })),
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          metadata: {},
          lastConsolidated: 0,
        });
        probe.retainRecentLegalSuffix(maxSuffix);
        const kept = probe.messages;
        const cut = tail.length - kept.length;
        const archiveMessages = tail.slice(0, cut);
        if (!archiveMessages.length && !kept.length) {
          session.updatedAt = new Date().toISOString();
          this.saveSession(session);
          return "";
        }

        const lastActive = session.updatedAt ?? new Date().toISOString();
        if (archiveMessages.length) summary = await this.archive(archiveMessages, { sessionKey });
        if (summary && summary !== "(nothing)") {
          session.metadata ??= {};
          session.metadata.lastSummary = { text: summary, mode: "text", lastActive };
        }
        session.messages = kept;
        session.lastConsolidated = 0;
        session.updatedAt = new Date().toISOString();
        this.saveSession(session);
        changed = beforeMessageCount !== (session.messages?.length ?? 0);
        return summary;
      });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      throw caught;
    } finally {
      await this.emitAfterCompaction(new AgentHookContext({
        sessionKey,
        session: currentSession,
        reason: "idle",
        compaction: { kind: "idle", maxSuffix, changed, summary, error },
      }));
    }
  }

  async consolidate(messages: Record<string, any>[], options: ArchiveOptions = {}): Promise<Record<string, any>[]> {
    await this.archive(messages, options);
    return messages;
  }

  private getSession(key: string): any {
    if (typeof this.sessions?.getOrCreate === "function") return this.sessions.getOrCreate(key);
    return this.sessions?.sessionCache?.[key] ?? this.sessions?.sessions?.get?.(key) ?? null;
  }

  private saveSession(session: any): void {
    if (typeof this.sessions?.save === "function") this.sessions.save(session);
  }

  private invalidateSession(key: string): void {
    if (typeof this.sessions?.invalidate === "function") this.sessions.invalidate(key);
    else if (typeof this.sessions?.sessions?.delete === "function") this.sessions.sessions.delete(key);
  }
}

function latestDagTurnForSessionPrefix(store: SessionDagStore, messageEnd: number): { turn_id: string; message_end: number; dag_status: string } | null {
  const candidates = store
    .listTurns()
    .filter((turn) => turn.message_end <= messageEnd)
    .sort((left, right) => right.message_end - left.message_end);
  return candidates[0] ?? null;
}

type DreamInit = {
  store: MemoryStore;
  provider: any;
  model: string;
  maxBatchSize?: number;
  maxIterations?: number;
  maxToolResultChars?: number;
  annotateLineAges?: boolean;
};

function sourceRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function formatDateOnly(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function skillCreatorPath(): string {
  return path.join(sourceRoot(), "skills", "skill-creator", "SKILL.md");
}

export class Dream {
  memoryFileMaxChars = 32_000;
  soulFileMaxChars = 16_000;
  userFileMaxChars = 16_000;
  historyEntryPreviewMaxChars = 4_000;

  store: MemoryStore;
  provider: any;
  model: string;
  maxBatchSize: number;
  maxIterations: number;
  maxToolResultChars: number;
  annotateLineAges: boolean;
  runner: AgentRunner;
  tools: ToolRegistry;

  constructor(init: DreamInit);
  constructor(
    store: MemoryStore,
    provider: any,
    model: string,
    maxBatchSize?: number,
    maxIterations?: number,
    maxToolResultChars?: number,
    annotateLineAges?: boolean,
  );
  constructor(
    initOrStore: DreamInit | MemoryStore,
    provider?: any,
    model?: string,
    maxBatchSize?: number,
    maxIterations?: number,
    maxToolResultChars?: number,
    annotateLineAges?: boolean,
  ) {
    const init =
      initOrStore instanceof MemoryStore
        ? { store: initOrStore, provider, model: model ?? "", maxBatchSize, maxIterations, maxToolResultChars, annotateLineAges }
        : initOrStore;
    this.store = init.store;
    this.provider = init.provider;
    this.model = init.model;
    this.maxBatchSize = init.maxBatchSize ?? 20;
    this.maxIterations = init.maxIterations ?? 10;
    this.maxToolResultChars = init.maxToolResultChars ?? 16_000;
    this.annotateLineAges = init.annotateLineAges ?? true;
    this.runner = new AgentRunner();
    this.tools = this.buildTools();
  }

  setProvider(provider: any, model: string): void {
    this.provider = provider;
    this.model = model;
    this.runner.provider = provider;
  }

  buildTools(): ToolRegistry {
    const tools = new ToolRegistry();
    tools.register(new ReadFileTool({ workspace: this.store.workspace, allowedDir: this.store.workspace }));
    tools.register(new EditFileTool({ workspace: this.store.workspace, allowedDir: this.store.workspace }));
    const skillsDir = path.join(this.store.workspace, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    tools.register(new WriteFileTool({ workspace: this.store.workspace, allowedDir: skillsDir }));
    return tools;
  }

  listExistingSkills(): string[] {
    const entries = new Map<string, string>();
    const descRe = /^description:\s*(.+)$/im;
    for (const base of [path.join(this.store.workspace, "skills"), path.join(sourceRoot(), "skills")]) {
      if (!fs.existsSync(base)) continue;
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillFile = path.join(base, entry.name, "SKILL.md");
        if (!fs.existsSync(skillFile)) continue;
        if (entries.has(entry.name) && base !== path.join(this.store.workspace, "skills")) continue;
        const match = fs.readFileSync(skillFile, "utf8").slice(0, 500).match(descRe);
        entries.set(entry.name, match?.[1]?.trim() || "(no description)");
      }
    }
    return [...entries.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, desc]) => `${name} - ${desc}`);
  }

  annotateWithAges(content: string): string {
    let ages: Array<{ ageDays?: number }>;
    try {
      ages = this.store.git.lineAges("memory/MEMORY.md");
    } catch {
      return content;
    }
    if (!ages.length) return content;

    const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const hadTrailing = normalized.endsWith("\n");
    const lines = normalized.split("\n");
    if (hadTrailing) lines.pop();
    if (lines.length !== ages.length) return content;

    const annotated = lines.map((line, index) => {
      if (!line.trim()) return line;
      const days = ages[index].ageDays ?? 0;
      return days > STALE_THRESHOLD_DAYS ? `${line}  ← ${days}d` : line;
    });
    return `${annotated.join("\n")}${hadTrailing ? "\n" : ""}`;
  }

  async run(): Promise<boolean> {
    const lastCursor = this.store.getLastDreamCursor();
    const entries = this.store.readUnprocessedHistory(lastCursor);
    if (!entries.length) return false;

    const batch = entries.slice(0, this.maxBatchSize);
    const historyText = batch
      .map((entry) => `[${entry.timestamp ?? "?"}] ${truncateText(String(entry.content ?? ""), this.historyEntryPreviewMaxChars)}`)
      .join("\n");

    const rawMemory = this.store.readMemory() || "(empty)";
    const memoryPreview = this.annotateLineAges ? this.annotateWithAges(rawMemory) : rawMemory;
    const currentMemory = truncateText(memoryPreview, this.memoryFileMaxChars);
    const currentSoul = truncateText(this.store.readSoul() || "(empty)", this.soulFileMaxChars);
    const currentUser = truncateText(this.store.readUser() || "(empty)", this.userFileMaxChars);
    const fileContext =
      `## Current Date\n${formatDateOnly(new Date())}\n\n` +
      `## Current MEMORY.md (${currentMemory.length} chars)\n${currentMemory}\n\n` +
      `## Current SOUL.md (${currentSoul.length} chars)\n${currentSoul}\n\n` +
      `## Current USER.md (${currentUser.length} chars)\n${currentUser}`;

    let analysis = "";
    try {
      const chat = this.provider?.chatWithRetry ?? this.provider?.chatWithRetry;
      if (typeof chat !== "function") throw new Error("provider does not implement chatWithRetry");
      const response = await chat.call(this.provider, {
        model: this.model,
        messages: [
          {
            role: "system",
            content: renderTemplate("agent/dream-phase-1.md", {
              strip: true,
              staleThresholdDays: STALE_THRESHOLD_DAYS,
            }),
          },
          { role: "user", content: `## Conversation History\n${historyText}\n\n${fileContext}` },
        ],
        tools: null,
        tool_choice: null,
        toolChoice: null,
      });
      analysis = response?.content ?? "";
    } catch {
      return false;
    }

    const existingSkills = this.listExistingSkills();
    const skillsSection = existingSkills.length ? `\n\n## Existing Skills\n${existingSkills.map((skill) => `- ${skill}`).join("\n")}` : "";
    const messages = [
      {
        role: "system",
        content: renderTemplate("agent/dream-phase-2.md", {
          strip: true,
          skillCreatorPath: skillCreatorPath(),
        }),
      },
      { role: "user", content: `## Analysis Result\n${analysis}\n\n${fileContext}${skillsSection}` },
    ];

    let result: any = null;
    try {
      result = await this.runner.run(
        new AgentRunSpec({
          messages,
          initialMessages: messages,
          provider: this.provider,
          tools: this.tools,
          model: this.model,
          maxIterations: this.maxIterations,
          maxToolResultChars: this.maxToolResultChars,
          failOnToolError: false,
        }),
      );
    } catch {
      result = null;
    }

    const toolEvents = result?.toolEvents ?? [];
    const changelog = toolEvents
      .filter((event: any) => event?.status === "ok")
      .map((event: any) => `${event.name}: ${event.detail ?? ""}`);
    const stopReason = result?.stopReason;
    if (result && stopReason === "completed") {
      const newCursor = MemoryStore.validCursor(batch.at(-1)?.cursor);
      if (newCursor !== null) this.store.setLastDreamCursor(newCursor);
    }

    this.store.compactHistory();

    if (changelog.length && this.store.git.isInitialized()) {
      const timestamp = batch.at(-1)?.timestamp ?? "?";
      this.store.git.autoCommit(`dream: ${timestamp}, ${changelog.length} change(s)\n\n${analysis.trim()}`);
    }
    return true;
  }
}
