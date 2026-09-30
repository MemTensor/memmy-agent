/** Db reader module. */
import Database from "better-sqlite3";
import {
  readOpenclawTranscripts,
  type OpenclawTranscriptSource,
  type RawSourceMessage
} from "@memmy/agent-source-core";

/** Contract for raw openclaw message. */
export interface RawOpenclawMessage extends RawSourceMessage {
  workspacePath: string | null;
  gitRoot: string | null;
}

/**
 * Reads OpenClaw conversations as staged native turns. The plugin rereads the same
 * database on `agent_end` through the same parser, so both channels resolve one run to
 * one identity.
 */
export async function* readOpenclawDatabase(path: string, signal?: AbortSignal): AsyncIterable<RawOpenclawMessage> {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const source = createSource(db);
    if (!source) return;
    for await (const message of readOpenclawTranscripts(source, signal)) {
      yield { ...message, workspacePath: null, gitRoot: null };
    }
  } finally {
    db.close();
  }
}

/** A database without the transcript tables is not a conversation store. */
function createSource(db: Database.Database): OpenclawTranscriptSource | null {
  if (!hasTable(db, "transcript_events") || !hasTable(db, "session_windows")) return null;
  const windows = db.prepare(
    "SELECT session_id AS sessionId, session_key AS sessionKey FROM session_windows WHERE session_key IS NOT NULL ORDER BY session_id ASC"
  );
  const events = db.prepare("SELECT seq, event_json AS eventJson FROM transcript_events WHERE session_id = ? ORDER BY seq ASC");
  return {
    windows: () => windows.all() as Array<{ sessionId: string; sessionKey: string }>,
    events: (sessionId) => (events.all(sessionId) as Array<{ seq: number; eventJson: string }>).map((row) => ({
      seq: row.seq,
      event: parseJson(row.eventJson)
    }))
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function hasTable(db: Database.Database, tableName: string): boolean {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}
