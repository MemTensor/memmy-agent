/** Db reader module. */
import { DatabaseSync } from "node:sqlite";
import {
  readOpencodeSessions,
  type OpencodeSession,
  type OpencodeSource,
  type RawSourceMessage
} from "@memmy/agent-source-core";

/** Contract for raw opencode database message. */
export interface RawOpencodeDatabaseMessage extends RawSourceMessage {
  workspacePath: string | null;
  gitRoot: string | null;
}

/**
 * Reads OpenCode conversations as staged native turns. The plugin rereads the same
 * database on `session.idle` through the same parser, so both channels resolve one turn
 * to one identity. The connection is a plain read-only handle, never `immutable`, or a
 * turn that is still only in the write-ahead log would be missed.
 */
export async function* readOpencodeDatabase(path: string, signal?: AbortSignal): AsyncIterable<RawOpencodeDatabaseMessage> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const source = createSource(db);
    if (!source) return;
    const directories = new Map([...source.sessions()].map((session) => [session.id, session.directory ?? null]));
    for await (const message of readOpencodeSessions(source, signal)) {
      const directory = directories.get(message.conversationId) ?? null;
      yield { ...message, workspacePath: directory, gitRoot: directory };
    }
  } finally {
    db.close();
  }
}

/** Streams without materialising a database-wide message array. */
export async function* streamOpencodeDatabase(path: string, signal?: AbortSignal): AsyncIterable<RawOpencodeDatabaseMessage> {
  yield* readOpencodeDatabase(path, signal);
}

/** A database without the conversation tables is not a conversation store. */
function createSource(db: DatabaseSync): OpencodeSource | null {
  if (!hasTable(db, "session") || !hasTable(db, "message") || !hasTable(db, "part")) return null;
  const columns = tableColumns(db, "session");
  const sessions = db.prepare(`SELECT id, parent_id AS parentId, directory${columns.has("agent") ? ", agent" : ""}${columns.has("revert") ? ", revert" : ""} FROM session ORDER BY time_created ASC, id ASC`);
  const messages = db.prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC");
  const parts = db.prepare("SELECT id, data FROM part WHERE message_id = ? ORDER BY time_created ASC, id ASC");
  return {
    sessions: () => (sessions.all() as unknown as Array<Record<string, unknown>>).map(toOpencodeSession),
    messages: (sessionId) => (messages.all(sessionId) as unknown as Array<{ id: string; data: string }>)
      .map((row) => ({ id: row.id, data: parseJson(row.data) })),
    parts: (messageId) => (parts.all(messageId) as unknown as Array<{ id: string; data: string }>)
      .map((row) => ({ id: row.id, data: parseJson(row.data) }))
  };
}

function toOpencodeSession(row: Record<string, unknown>): OpencodeSession {
  return {
    id: String(row.id),
    parentId: row.parentId == null ? null : String(row.parentId),
    directory: row.directory == null ? null : String(row.directory),
    agent: typeof row.agent === "string" ? row.agent : null,
    revertMessageId: revertMessageId(row.revert)
  };
}

function revertMessageId(value: unknown): string | null {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const messageId = (parsed as { messageID?: unknown }).messageID;
  return typeof messageId === "string" && messageId ? messageId : null;
}

function tableColumns(db: DatabaseSync, tableName: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((row) => row.name));
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function hasTable(db: DatabaseSync, tableName: string): boolean {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}
