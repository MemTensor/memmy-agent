/**
 * Lists Cursor's chats from the rows that name them, without their bubbles.
 *
 * <p>Cursor keeps every chat's header list, name and bubble rows in a key–value table that runs to hundreds of
 * thousands of rows and gigabytes of bubble text. A list only needs the name, the first question, the last question
 * and the time, so this reads the chat list, each chat's header list, and then a handful of bubbles at each end of
 * it. The bubble rows are fetched by primary key or by a bounded key range; a scan over the table would read the
 * whole store.</p>
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { discoverCursorWorkspaces } from "@memmy/agent-source-readers/adapters/cursor/workspace-discovery";
import type { SourceAdapter } from "@memmy/agent-source-readers/adapters/types";
import { iso, redactSecrets, text } from "@memmy/agent-source-core";
import type { LocalSession } from "../local-session-reader.js";
import { createSessionGrouper } from "../session-group.js";
import { finishSession, type SessionBuilder } from "../session-shape.js";

const CURSOR_SOURCE_ID = "cursor";
/** Bubbles read while looking for one end of a chat; past this a chat is read the slow but certain way. */
const BUBBLE_SCAN_LIMIT = 400;
const USER_BUBBLE = 1;
const ASSISTANT_BUBBLE = 2;

/** One store to read: a workspace's state database, or the global one that keeps chats opened without a folder. */
export interface CursorTarget {
  storageHash: string;
  stateDbPath: string;
  workspacePath: string | null;
}

/** How Cursor's chats are listed: the stores to read and how many chats each may hold. */
export interface CursorMetadataPlan {
  targets: CursorTarget[];
}

/** Returns the stores to read, or `null` when this agent is not Cursor or its store is gone. */
export async function planCursorSessions(adapter: SourceAdapter, window: number): Promise<CursorMetadataPlan | null> {
  if (adapter.descriptor.sourceId !== CURSOR_SOURCE_ID) {
    return null;
  }
  const storageRoot = adapter.descriptor.dataPath;
  const targets: CursorTarget[] = [];
  if (existsSync(storageRoot)) {
    const workspaces = await discoverCursorWorkspaces({ storageRoot, order: "recent_first", maxWorkspaces: window });
    for (const workspace of workspaces) {
      targets.push({ storageHash: workspace.storageHash, stateDbPath: workspace.stateDbPath, workspacePath: workspace.workspacePath });
    }
  }
  // Chats opened without a folder live in the global store, which the scan reads as its own target.
  const globalDb = join(dirname(storageRoot), "globalStorage", "state.vscdb");
  if (existsSync(globalDb)) {
    targets.push({ storageHash: "globalStorage", stateDbPath: globalDb, workspacePath: null });
  }
  return targets.length ? { targets } : null;
}

/** Lists the chats these stores hold, in the order the scan would emit them. */
export async function listCursorSessions(
  adapter: SourceAdapter,
  plan: CursorMetadataPlan,
  options: { limit: number; window: number }
): Promise<LocalSession[]> {
  const grouper = createSessionGrouper(adapter);
  const builders = new Map<string, SessionBuilder>();
  for (const target of plan.targets) {
    for (const chat of readTarget(target, options.window)) {
      let builder = builders.get(chat.conversationId);
      if (!builder) {
        builder = { workspacePath: null, updatedAt: "", turns: [], nativeTitle: "" };
        builders.set(chat.conversationId, builder);
      }
      builder.workspacePath ??= target.workspacePath;
      if (chat.updatedAt > builder.updatedAt) {
        builder.updatedAt = chat.updatedAt;
      }
      // 一个聊天的一个回合只有一条人问的话；列表要的就是第一句与最后一句。
      builder.turns.push({ question: chat.firstQuestion, reply: "", steps: [], startedAt: "" });
      if (chat.lastQuestion !== chat.firstQuestion) {
        builder.turns.push({ question: chat.lastQuestion, reply: "", steps: [], startedAt: "" });
      }
      if (chat.title) {
        builder.nativeTitle = chat.title;
      }
    }
  }
  return [...builders.entries()]
    .map(([conversationId, builder]) => finishSession(adapter, grouper, conversationId, builder))
    .filter((session): session is LocalSession => session !== null)
    .slice(0, options.limit);
}

/** What one chat's ends told us. */
interface CursorChatFacts {
  conversationId: string;
  firstQuestion: string;
  lastQuestion: string;
  updatedAt: string;
  title: string;
}

function readTarget(target: CursorTarget, composerLimit: number): CursorChatFacts[] {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(target.stateDbPath, { readOnly: true });
    // 没有这两张表的库不是对话存储。
    if (!hasTable(db, "composerHeaders") || !hasTable(db, "cursorDiskKV")) {
      return [];
    }
    const rows = db.prepare(
      `SELECT composerId FROM composerHeaders WHERE isSubagent = 0 AND composerId IS NOT NULL ORDER BY lastUpdatedAt DESC LIMIT ${Math.max(1, Math.trunc(composerLimit))}`
    ).all() as unknown as Array<{ composerId: string }>;
    const reader = createRowReader(db);
    const facts: CursorChatFacts[] = [];
    for (const row of rows) {
      const chat = readChat(reader, row.composerId);
      if (chat) {
        facts.push(chat);
      }
    }
    return facts;
  } catch {
    // 库被占用或格式不认识：这一个库读不出来，别的照读。
    return [];
  } finally {
    db?.close();
  }
}

/** A chat's name, its first and last question, and the latest time any of its bubbles carried. */
function readChat(reader: RowReader, composerId: string): CursorChatFacts | null {
  const data = reader.json(`composerData:${composerId}`);
  if (!isRecord(data) || isRecord(data.subagentInfo)) {
    return null;
  }
  const headers = conversationHeaders(reader, composerId, data);
  const firstQuestion = findFirstQuestion(reader, composerId, headers);
  if (!firstQuestion) {
    return null;
  }
  const tail = findLastTurn(reader, composerId, headers);
  return {
    conversationId: composerId,
    firstQuestion: redactSecrets(firstQuestion),
    lastQuestion: redactSecrets(tail.question || firstQuestion),
    updatedAt: tail.updatedAt,
    title: composerTitle(data)
  };
}

/** Walks the header list from the start for the first user bubble that carries typed text. */
function findFirstQuestion(reader: RowReader, composerId: string, headers: readonly unknown[]): string {
  for (let index = 0; index < headers.length; index += 1) {
    const bubble = readBubble(reader, composerId, headers[index]);
    if (bubble?.type === USER_BUBBLE && bubble.text) {
      return bubble.text;
    }
    if (index >= BUBBLE_SCAN_LIMIT) {
      return "";
    }
  }
  return "";
}

/**
 * The chat's last turn: the last user bubble with text, and the latest time among the bubbles that reach the list.
 * Scanning stops at that bubble, and reads the rest of the chat only when a long turn hides it.
 */
function findLastTurn(reader: RowReader, composerId: string, headers: readonly unknown[]): { question: string; updatedAt: string } {
  let updatedAt = "";
  let question = "";
  let found = false;
  let scanned = 0;
  for (let index = headers.length - 1; index >= 0; index -= 1) {
    const bubble = readBubble(reader, composerId, headers[index]);
    if (bubble) {
      if (isListed(bubble) && bubble.createdAt > updatedAt) {
        updatedAt = bubble.createdAt;
      }
      if (bubble.type === USER_BUBBLE && bubble.text) {
        question = bubble.text;
        found = true;
        break;
      }
    }
    scanned += 1;
    if (scanned > BUBBLE_SCAN_LIMIT) {
      break;
    }
  }
  if (found) {
    return { question, updatedAt };
  }
  // 一个回合里工具气泡太多，靠窗前的这些行找不到它开头的问话：整份读，慢一次但不会错。
  return { question: findLastQuestionUnbounded(reader, composerId, headers), updatedAt };
}

function findLastQuestionUnbounded(reader: RowReader, composerId: string, headers: readonly unknown[]): string {
  for (let index = headers.length - 1; index >= 0; index -= 1) {
    const bubble = readBubble(reader, composerId, headers[index]);
    if (bubble?.type === USER_BUBBLE && bubble.text) {
      return bubble.text;
    }
  }
  return "";
}

/** A chat's header list: kept inline until Cursor 3 moved it to `composerConvHeaders` rows. */
function conversationHeaders(reader: RowReader, composerId: string, data: Record<string, unknown>): readonly unknown[] {
  const inline = Array.isArray(data.fullConversationHeadersOnly) ? data.fullConversationHeadersOnly : [];
  if (inline.length > 0) {
    return inline;
  }
  return reader.headerChunks(composerId);
}

interface Bubble {
  type: number;
  createdAt: string;
  text: string;
  tool: boolean;
}

function readBubble(reader: RowReader, composerId: string, header: unknown): Bubble | undefined {
  if (!isRecord(header)) {
    return undefined;
  }
  const bubbleId = text(header.bubbleId);
  if (!bubbleId) {
    return undefined;
  }
  const raw = reader.json(`bubbleId:${composerId}:${bubbleId}`);
  if (!isRecord(raw)) {
    return undefined;
  }
  const type = typeof raw.type === "number" ? raw.type : Number.NaN;
  if (type !== USER_BUBBLE && type !== ASSISTANT_BUBBLE) {
    return undefined;
  }
  return {
    type,
    createdAt: iso(raw.createdAt) || iso(header.createdAt),
    text: text(raw.text).trim(),
    tool: isRecord(raw.toolFormerData)
  };
}

/** What the scan would emit for this bubble: an empty assistant bubble without a tool is not a message. */
function isListed(bubble: Bubble): boolean {
  return bubble.type === USER_BUBBLE ? Boolean(bubble.text) : Boolean(bubble.text) || bubble.tool;
}

/** `composerData.name` holds the name Cursor shows for the chat; blank until Cursor names it. */
function composerTitle(data: Record<string, unknown>): string {
  return text(data.name).replace(/\s+/gu, " ").trim();
}

interface RowReader {
  json(key: string): unknown;
  /** The chat's header list when it lives outside `composerData`, by primary-key range. */
  headerChunks(composerId: string): readonly unknown[];
}

/** Reads `cursorDiskKV` rows by key; the range query keeps the primary-key index instead of scanning the table. */
function createRowReader(db: DatabaseSync): RowReader {
  const value = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");
  const chunks = db.prepare("SELECT value FROM cursorDiskKV WHERE key >= ? AND key < ? ORDER BY key");
  const json = (key: string): unknown => {
    const row = value.get(key) as { value?: unknown } | undefined;
    if (typeof row?.value !== "string") {
      return undefined;
    }
    try {
      return JSON.parse(row.value);
    } catch {
      return undefined;
    }
  };
  return {
    json,
    headerChunks(composerId) {
      const prefix = `composerConvHeaders:${composerId}:`;
      const rows = chunks.all(prefix, `${prefix.slice(0, -1)};`) as unknown as Array<{ value?: unknown }>;
      const headers: unknown[] = [];
      for (const row of rows) {
        if (typeof row.value !== "string") {
          continue;
        }
        try {
          const parsed: unknown = JSON.parse(row.value);
          if (Array.isArray(parsed)) {
            headers.push(...parsed);
          }
        } catch {
          // 一个读不懂的分片跳过，其余分片仍然能排出这个聊天。
        }
      }
      return headers;
    }
  };
}

function hasTable(db: DatabaseSync, tableName: string): boolean {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Unused in this file's flow, kept out of the bundle's way: the questions carry no redaction of their own. */
export const redactCursorQuestion = redactSecrets;