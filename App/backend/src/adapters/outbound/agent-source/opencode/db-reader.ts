/** Db reader module. */
import { DatabaseSync } from "node:sqlite";
import {
  readOpencodeSessions,
  createOpencodeDatabaseSource,
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
    const source = createOpencodeDatabaseSource(db);
    if (!source) return;
    const directories = new Map([...source.sessions()].map((session) => [session.id, session.directory ?? null]));
    // OpenCode names each session itself; the row is read here rather than through the turn parser.
    const titles = readSessionTitles(db);
    for await (const message of readOpencodeSessions(source, signal)) {
      const directory = directories.get(message.conversationId) ?? null;
      const sessionTitle = titles.get(message.conversationId);
      yield { ...message, workspacePath: directory, gitRoot: directory, ...(sessionTitle ? { sessionTitle } : {}) };
    }
  } finally {
    db.close();
  }
}

/** Streams without materialising a database-wide message array. */
export async function* streamOpencodeDatabase(path: string, signal?: AbortSignal): AsyncIterable<RawOpencodeDatabaseMessage> {
  yield* readOpencodeDatabase(path, signal);
}

/** Session titles, when this OpenCode stores them; older schemas have no such column. */
function readSessionTitles(db: DatabaseSync): ReadonlyMap<string, string> {
  const titles = new Map<string, string>();
  if (!tableColumns(db, "session").has("title")) return titles;
  for (const row of db.prepare("SELECT id, title FROM session").all() as unknown as Array<{ id: string; title: string | null }>) {
    const title = typeof row.title === "string" ? row.title.replace(/\s+/gu, " ").trim() : "";
    if (row.id && title) titles.set(row.id, title);
  }
  return titles;
}

function tableColumns(db: DatabaseSync, tableName: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((row) => row.name));
}
