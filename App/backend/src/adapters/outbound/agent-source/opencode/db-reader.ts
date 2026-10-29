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
