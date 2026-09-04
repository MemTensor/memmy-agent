import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  ConversationCheckpoint,
  ConversationMessage,
  MessageCursor,
  PreparedConversation,
  PreparedTurn,
  ScanSourceState,
  ScanStore,
  ScanStoredResult
} from "@memmy/agent-source-core";

const MAX_RECORD_BYTES = 64 * 1024 * 1024;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;

export interface AppScanJobMeta {
  jobId: string;
  sourceId: string;
  mode: string;
  phase: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface AppAgentSourceScanStore extends ScanStore {
  readonly path: string;
  saveMeta(meta: AppScanJobMeta): void;
  getMeta(): AppScanJobMeta | null;
  clearMeta(): void;
  conversationCount(sourceId: string): number;
}

export function openAppAgentSourceScanStore(path: string, job: AppScanJobMeta): AppAgentSourceScanStore {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL);
    INSERT INTO schema_meta(version) SELECT 2 WHERE NOT EXISTS (SELECT 1 FROM schema_meta);
    UPDATE schema_meta SET version = 2 WHERE version < 2;
    CREATE TABLE IF NOT EXISTS scan_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      job_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      phase TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS staged_messages (
      job_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      workspace_path TEXT,
      git_root TEXT,
      raw_meta_json TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (job_id, source_id, message_id)
    );
    CREATE TABLE IF NOT EXISTS scan_source_state (
      source_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      phase TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      result_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      scan_started_at TEXT,
      watermarked_since TEXT,
      updated_at TEXT NOT NULL,
      error TEXT
    );
  `);
  // Older stores created before the job_id column are upgraded in place.
  try { db.exec("ALTER TABLE staged_messages ADD COLUMN job_id TEXT NOT NULL DEFAULT ''"); } catch { /* already present */ }
  db.exec("CREATE INDEX IF NOT EXISTS staged_order ON staged_messages(job_id, source_id, conversation_id, created_at, message_id, ordinal)");
  db.exec("CREATE TABLE IF NOT EXISTS scan_cursors (source_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, created_at TEXT NOT NULL, message_id TEXT NOT NULL, ordinal INTEGER NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS checkpoints (source_id TEXT NOT NULL, conversation_id TEXT NOT NULL, last_message_id TEXT NOT NULL, last_created_at TEXT NOT NULL, content_hash TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(source_id, conversation_id))");
  db.exec("CREATE TABLE IF NOT EXISTS conversation_meta (source_id TEXT NOT NULL, conversation_id TEXT NOT NULL, last_message_id TEXT NOT NULL, last_created_at TEXT NOT NULL, content_hash TEXT NOT NULL, selected INTEGER NOT NULL, PRIMARY KEY(source_id, conversation_id))");
  db.exec("CREATE TABLE IF NOT EXISTS turn_meta (source_id TEXT NOT NULL, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL, first_message_id TEXT NOT NULL, first_created_at TEXT NOT NULL, last_message_id TEXT NOT NULL, last_created_at TEXT NOT NULL, selected INTEGER NOT NULL, PRIMARY KEY(source_id, conversation_id, turn_id))");
  db.exec("CREATE INDEX IF NOT EXISTS turn_selection_order ON turn_meta(first_created_at DESC, source_id, conversation_id, first_message_id, turn_id)");
  db.exec("CREATE TABLE IF NOT EXISTS scan_results (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL, conversation_id TEXT NOT NULL, memory_id TEXT, error TEXT)");
  db.exec("CREATE INDEX IF NOT EXISTS scan_result_identity ON scan_results(source_id,conversation_id,memory_id,error)");
  const meta = db.prepare("SELECT job_id AS jobId, source_id AS sourceId, mode, phase, created_at AS createdAt, updated_at AS updatedAt, error FROM scan_meta WHERE id=1").get() as AppScanJobMeta | undefined;
  if (!meta) {
    db.prepare("INSERT INTO scan_meta(id,job_id,source_id,mode,phase,created_at,updated_at,error) VALUES(1,?,?,?,?,?,?,?)").run(job.jobId, job.sourceId, job.mode, job.phase, job.createdAt, job.updatedAt, job.error ?? null);
  }
  let ordinal = Number((db.prepare("SELECT COALESCE(MAX(ordinal), -1) AS value FROM staged_messages WHERE job_id=?").get(job.jobId) as { value: number }).value) + 1;
  const insert = db.prepare("INSERT OR IGNORE INTO staged_messages(job_id,source_id,conversation_id,message_id,role,content,created_at,workspace_path,git_root,raw_meta_json,ordinal) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
  const store: AppAgentSourceScanStore = {
    path,
    stage(message) {
      const bytes = Buffer.byteLength(JSON.stringify(message));
      if (bytes > MAX_RECORD_BYTES) throw new Error(`scan record exceeds 64 MiB limit (${bytes} bytes)`);
      const result = insert.run(job.jobId, message.sourceId, message.conversationId, message.messageId, message.role, message.content, message.createdAt, message.workspacePath, message.gitRoot, JSON.stringify(message.rawMeta), ordinal++);
      return Number(result.changes) > 0;
    },
    stageBatch(messages) {
      let inserted = 0;
      db.exec("BEGIN IMMEDIATE");
      try { for (const message of messages) if (store.stage(message)) inserted += 1; db.exec("COMMIT"); }
      catch (error) { db.exec("ROLLBACK"); throw error; }
      return inserted;
    },
    messages(sourceId, cursor, limit = 500) {
      limit = Number.isFinite(limit) ? Math.min(500, Math.max(1, Math.floor(limit))) : 500;
      const parameters: SQLInputValue[] = [job.jobId, sourceId];
      let where = "job_id=? AND source_id=?";
      if (cursor) {
        where += " AND ((conversation_id > ?) OR (conversation_id = ? AND (created_at > ? OR (created_at = ? AND (message_id > ? OR (message_id = ? AND ordinal > ?))))))";
        parameters.push(cursor.conversationId, cursor.conversationId, cursor.createdAt, cursor.createdAt, cursor.messageId, cursor.messageId, cursor.ordinal);
      }
      const iterator = db.prepare(`SELECT source_id AS sourceId, conversation_id AS conversationId, message_id AS messageId, role, content, created_at AS createdAt, workspace_path AS workspacePath, git_root AS gitRoot, raw_meta_json AS rawMetaJson, ordinal FROM staged_messages WHERE ${where} ORDER BY conversation_id, created_at, message_id, ordinal LIMIT ?`).iterate(...parameters, limit) as Iterable<Record<string, unknown>>;
      return (function*() {
        let bytes = 0;
        let count = 0;
        for (const row of iterator) {
          const message = rowToMessage(row);
          yield message;
          count += 1;
          bytes += Buffer.byteLength(JSON.stringify(message));
          if (count >= 500 || bytes >= MAX_PAGE_BYTES) break;
        }
      })();
    },
    saveScanCursor(sourceId, cursor) { db.prepare("INSERT INTO scan_cursors(source_id,conversation_id,created_at,message_id,ordinal) VALUES(?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET conversation_id=excluded.conversation_id,created_at=excluded.created_at,message_id=excluded.message_id,ordinal=excluded.ordinal").run(sourceId, cursor.conversationId, cursor.createdAt, cursor.messageId, cursor.ordinal); },
    getScanCursor(sourceId) { const row = db.prepare("SELECT conversation_id AS conversationId,created_at AS createdAt,message_id AS messageId,ordinal FROM scan_cursors WHERE source_id=?").get(sourceId) as MessageCursor|undefined; return row ?? null; },
    saveSourceState(state) {
      db.prepare(`INSERT INTO scan_source_state(source_id,mode,phase,message_count,result_count,error_count,scan_started_at,watermarked_since,updated_at,error)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET mode=excluded.mode,phase=excluded.phase,message_count=excluded.message_count,result_count=excluded.result_count,error_count=excluded.error_count,scan_started_at=excluded.scan_started_at,watermarked_since=excluded.watermarked_since,updated_at=excluded.updated_at,error=excluded.error`)
        .run(state.sourceId, state.mode, state.phase, state.messageCount, state.resultCount, state.errorCount, state.scanStartedAt ?? null, state.watermarkedSince ?? null, state.updatedAt, state.error ?? null);
    },
    getSourceState(sourceId) {
      const row = db.prepare("SELECT source_id AS sourceId,mode,phase,message_count AS messageCount,result_count AS resultCount,error_count AS errorCount,scan_started_at AS scanStartedAt,watermarked_since AS watermarkedSince,updated_at AS updatedAt,error FROM scan_source_state WHERE source_id=?").get(sourceId) as ScanSourceState | undefined;
      return row ?? null;
    },
    sourceCount() { return Number((db.prepare("SELECT COUNT(*) AS count FROM scan_source_state").get() as { count: number }).count); },
    count(sourceId) {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM staged_messages WHERE job_id=?${sourceId ? " AND source_id=?" : ""}`).get(job.jobId, ...(sourceId ? [sourceId] : [])) as { count: number };
      return Number(row.count);
    },
    conversationCount(sourceId) {
      const row = db.prepare("SELECT COUNT(DISTINCT conversation_id) AS count FROM staged_messages WHERE job_id=? AND source_id=?").get(job.jobId, sourceId) as { count: number };
      return Number(row.count);
    },
    saveCheckpoint(checkpoint) { db.prepare("INSERT INTO checkpoints(source_id,conversation_id,last_message_id,last_created_at,content_hash,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(source_id,conversation_id) DO UPDATE SET last_message_id=excluded.last_message_id,last_created_at=excluded.last_created_at,content_hash=excluded.content_hash,updated_at=excluded.updated_at").run(checkpoint.sourceId, checkpoint.conversationId, checkpoint.lastMessageId, checkpoint.lastCreatedAt, checkpoint.contentHash, checkpoint.updatedAt); },
    getCheckpoint(sourceId, conversationId) { return (db.prepare("SELECT source_id AS sourceId, conversation_id AS conversationId, last_message_id AS lastMessageId, last_created_at AS lastCreatedAt, content_hash AS contentHash, updated_at AS updatedAt FROM checkpoints WHERE source_id=? AND conversation_id=?").get(sourceId, conversationId) as ConversationCheckpoint | undefined) ?? null; },
    saveConversationMeta(meta) { db.prepare("INSERT INTO conversation_meta(source_id,conversation_id,last_message_id,last_created_at,content_hash,selected) VALUES(?,?,?,?,?,?) ON CONFLICT(source_id,conversation_id) DO UPDATE SET last_message_id=excluded.last_message_id,last_created_at=excluded.last_created_at,content_hash=excluded.content_hash,selected=excluded.selected").run(meta.sourceId,meta.conversationId,meta.lastMessageId,meta.lastCreatedAt,meta.contentHash,meta.selected?1:0); },
    getConversationMeta(sourceId, conversationId) { const row = db.prepare("SELECT source_id AS sourceId,conversation_id AS conversationId,last_message_id AS lastMessageId,last_created_at AS lastCreatedAt,content_hash AS contentHash,selected FROM conversation_meta WHERE source_id=? AND conversation_id=?").get(sourceId,conversationId) as (Omit<PreparedConversation,"selected"> & {selected:number})|undefined; return row ? {...row, selected: row.selected === 1} : null; },
    selectAllConversations(sourceId) { db.prepare("UPDATE conversation_meta SET selected=1 WHERE source_id=?").run(sourceId); },
    saveTurnMeta(meta) { db.prepare("INSERT INTO turn_meta(source_id,conversation_id,turn_id,first_message_id,first_created_at,last_message_id,last_created_at,selected) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source_id,conversation_id,turn_id) DO UPDATE SET first_message_id=excluded.first_message_id,first_created_at=excluded.first_created_at,last_message_id=excluded.last_message_id,last_created_at=excluded.last_created_at,selected=excluded.selected").run(meta.sourceId,meta.conversationId,meta.turnId,meta.firstMessageId,meta.firstCreatedAt,meta.lastMessageId,meta.lastCreatedAt,meta.selected?1:0); },
    getTurnMeta(sourceId, conversationId, turnId) { const row = db.prepare("SELECT source_id AS sourceId,conversation_id AS conversationId,turn_id AS turnId,first_message_id AS firstMessageId,first_created_at AS firstCreatedAt,last_message_id AS lastMessageId,last_created_at AS lastCreatedAt,selected FROM turn_meta WHERE source_id=? AND conversation_id=? AND turn_id=?").get(sourceId,conversationId,turnId) as (Omit<PreparedTurn,"selected"> & {selected:number})|undefined; return row ? {...row,selected:row.selected===1} : null; },
    selectInitialTurns(sourceIds, globalLimit, absentSourceLimit) {
      if (sourceIds.length === 0) return;
      const placeholders = sourceIds.map(() => "?").join(",");
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`UPDATE turn_meta SET selected=0 WHERE source_id IN (${placeholders})`).run(...sourceIds);
        db.prepare(`UPDATE turn_meta SET selected=1 WHERE rowid IN (SELECT rowid FROM turn_meta WHERE source_id IN (${placeholders}) ORDER BY first_created_at DESC,source_id,conversation_id,first_message_id,turn_id LIMIT ?)`).run(...sourceIds, globalLimit);
        db.prepare(`WITH ranked AS (SELECT source_id,turn_id,ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY first_created_at DESC,conversation_id,first_message_id,turn_id) AS rank FROM turn_meta WHERE source_id IN (${placeholders})), absent AS (SELECT source_id FROM turn_meta WHERE source_id IN (${placeholders}) GROUP BY source_id HAVING MAX(selected)=0) UPDATE turn_meta SET selected=1 WHERE rowid IN (SELECT t.rowid FROM turn_meta t JOIN ranked r ON r.source_id=t.source_id AND r.turn_id=t.turn_id JOIN absent a ON a.source_id=t.source_id WHERE r.rank <= ?)`).run(...sourceIds, ...sourceIds, absentSourceLimit);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    saveResult(result) {
      db.prepare(`INSERT INTO scan_results(source_id,conversation_id,memory_id,error)
        SELECT ?,?,?,? WHERE NOT EXISTS (
          SELECT 1 FROM scan_results WHERE source_id=? AND conversation_id=? AND memory_id IS ? AND error IS ?
        )`).run(result.sourceId, result.conversationId, result.memoryId ?? null, result.error ?? null, result.sourceId, result.conversationId, result.memoryId ?? null, result.error ?? null);
    },
    resultCount(sourceId) {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM scan_results${sourceId ? " WHERE source_id=?" : ""}`).get(...(sourceId ? [sourceId] : [])) as { count: number };
      return Number(row.count);
    },
    results(sourceId, cursor, limit = 100) {
      const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
      const numericCursor = Number(cursor);
      const safeCursor = Number.isFinite(numericCursor) && numericCursor >= 0 ? Math.floor(numericCursor) : 0;
      const parameters: SQLInputValue[] = [sourceId ?? "%", safeCursor];
      const iterator = db.prepare("SELECT id, source_id AS sourceId, conversation_id AS conversationId, memory_id AS memoryId, error FROM scan_results WHERE source_id LIKE ? AND id > ? ORDER BY id LIMIT ?").iterate(...parameters, safeLimit) as Iterable<Record<string, unknown>>;
      return (function*() {
        for (const row of iterator) {
          const result = { sourceId: String(row.sourceId), conversationId: String(row.conversationId), ...(row.memoryId ? { memoryId: String(row.memoryId) } : {}), ...(row.error ? { error: String(row.error) } : {}) } as ScanStoredResult;
          Object.defineProperty(result, "cursor", { value: String(row.id), enumerable: false });
          yield result;
        }
      })();
    },
    saveMeta(meta) { db.prepare("UPDATE scan_meta SET job_id=?,source_id=?,mode=?,phase=?,created_at=?,updated_at=?,error=? WHERE id=1").run(meta.jobId, meta.sourceId, meta.mode, meta.phase, meta.createdAt, meta.updatedAt, meta.error ?? null); },
    getMeta() { return (db.prepare("SELECT job_id AS jobId, source_id AS sourceId, mode, phase, created_at AS createdAt, updated_at AS updatedAt, error FROM scan_meta WHERE id=1").get() as AppScanJobMeta | undefined) ?? null; },
    clearMeta() { db.prepare("DELETE FROM scan_meta WHERE id=1").run(); },
    close() { db.close(); },
    remove() { db.close(); rmSync(path, { force: true }); rmSync(`${path}-wal`, { force: true }); rmSync(`${path}-shm`, { force: true }); }
  };
  return store;
}

export function removeAppAgentSourceScanStore(path: string): void {
  rmSync(path, { force: true });
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}

function rowToMessage(row: Record<string, unknown>): ConversationMessage {
  return {
    sourceId: String(row.sourceId), conversationId: String(row.conversationId), messageId: String(row.messageId),
    role: row.role as ConversationMessage["role"], content: String(row.content), createdAt: String(row.createdAt),
    workspacePath: row.workspacePath == null ? null : String(row.workspacePath), gitRoot: row.gitRoot == null ? null : String(row.gitRoot),
    rawMeta: JSON.parse(String(row.rawMetaJson)) as Record<string, unknown>, ordinal: Number(row.ordinal)
  };
}
