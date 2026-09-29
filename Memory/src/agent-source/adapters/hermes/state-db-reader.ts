/** State db reader module. */
import Database from "better-sqlite3";
import {
  readHermesSessions,
  type HermesRow,
  type HermesSource,
  type RawSourceMessage
} from "@memmy/agent-source-core";

/** Contract for raw hermes state db message. */
export interface RawHermesStateDbMessage extends RawSourceMessage {
  workspacePath: string | null;
  gitRoot: string | null;
}

/**
 * Reads Hermes conversations as staged native turns. The plugin rereads the same database
 * on `sync_turn` through the same parser, so both channels resolve one turn to one
 * identity. Inactive rows are read too: compaction archives originals and can drop a
 * replayed user row, so an active-only view would lose whole turns.
 */
export async function* readHermesStateDb(path: string, signal?: AbortSignal): AsyncIterable<RawHermesStateDbMessage> {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const source = createSource(db);
    if (!source) return;
    const workspaces = new Map([...source.sessions()].map((session) => [session.id, session.cwd ?? null]));
    for await (const message of readHermesSessions(source, signal)) {
      const cwd = workspaces.get(message.conversationId) ?? null;
      yield { ...message, workspacePath: cwd, gitRoot: cwd };
    }
  } finally {
    db.close();
  }
}

/** A database without the conversation tables is not a conversation store. */
function createSource(db: Database.Database): HermesSource | null {
  if (!hasTable(db, "sessions") || !hasTable(db, "messages")) return null;
  const columns = tableColumns(db, "messages");
  if (!["id", "session_id", "role", "content", "timestamp"].every((column) => columns.has(column))) return null;
  const sessions = db.prepare("SELECT id, cwd FROM sessions ORDER BY id ASC");
  const messages = db.prepare(`SELECT id, role, content,
      ${optionalColumn(columns, "tool_call_id")} AS toolCallId,
      ${optionalColumn(columns, "tool_calls")} AS toolCalls,
      ${optionalColumn(columns, "tool_name")} AS toolName,
      timestamp,
      ${optionalColumn(columns, "finish_reason")} AS finishReason,
      ${optionalColumn(columns, "_compressed_summary")} AS compressedSummary,
      ${optionalColumn(columns, "active")} AS active,
      ${optionalColumn(columns, "compacted")} AS compacted
    FROM messages WHERE session_id = ? ORDER BY id ASC`);
  return {
    sessions: () => sessions.all() as Array<{ id: string; cwd: string | null }>,
    messages: (sessionId) => messages.all(sessionId) as HermesRow[]
  };
}

function optionalColumn(columns: ReadonlySet<string>, name: string): string {
  return columns.has(name) ? `"${name}"` : "NULL";
}

function tableColumns(db: Database.Database, tableName: string): ReadonlySet<string> {
  return new Set((db.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{ name: string }>).map((row) => row.name));
}

function hasTable(db: Database.Database, tableName: string): boolean {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}
