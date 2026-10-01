/** Vscdb reader module. */
import Database from "better-sqlite3";
import {
  readCursorComposer,
  type CursorVscdbSource,
  type RawSourceMessage
} from "@memmy/agent-source-core";

/** Contract for raw cursor message. */
export type RawCursorMessage = RawSourceMessage;

/**
 * Reads Cursor conversations as staged native turns. The hook reads the same rows through
 * the same shared parser, so both channels resolve one turn to one identity.
 */
export async function* readCursorVscdb(path: string, signal?: AbortSignal): AsyncIterable<RawCursorMessage> {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    yield* readComposers(createSource(db), signal);
  } finally {
    db.close();
  }
}

/** Streams without materialising a database-wide message array. */
export async function* streamCursorVscdb(path: string, signal?: AbortSignal): AsyncIterable<RawCursorMessage> {
  const db = new Database(path, { readonly: true });
  try {
    yield* readComposers(createSource(db), signal);
  } finally {
    db.close();
  }
}

async function* readComposers(source: CursorVscdbSource | null, signal?: AbortSignal): AsyncIterable<RawCursorMessage> {
  if (!source) return;
  for (const composerId of source.mainComposerIds()) {
    signal?.throwIfAborted();
    yield* readCursorComposer(source, composerId, signal);
  }
}

/** A workspace database without the chat tables is not a conversation store. */
function createSource(db: Database.Database): CursorVscdbSource | null {
  if (!hasTable(db, "composerHeaders") || !hasTable(db, "cursorDiskKV")) return null;
  const mainComposers = db.prepare("SELECT composerId FROM composerHeaders WHERE isSubagent = 0 AND composerId IS NOT NULL");
  const diskValue = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");
  const parse = (key: string): unknown => {
    const row = diskValue.get(key) as { value?: unknown } | undefined;
    if (typeof row?.value !== "string") return undefined;
    try {
      return JSON.parse(row.value);
    } catch {
      return undefined;
    }
  };
  return {
    mainComposerIds: () => (mainComposers.all() as Array<{ composerId: string }>).map((row) => row.composerId),
    composerData: (composerId) => parse(`composerData:${composerId}`),
    bubble: (composerId, bubbleId) => parse(`bubbleId:${composerId}:${bubbleId}`)
  };
}

function hasTable(db: Database.Database, tableName: string): boolean {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}
