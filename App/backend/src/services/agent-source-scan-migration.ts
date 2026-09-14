import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Migrates one legacy app-state journal into the durable per-job store. */
export function migrateLegacyScanJournal(databasePath: string, storePath: string, jobId: string): boolean {
  if (!existsSync(databasePath)) return false;
  mkdirSync(dirname(storePath), { recursive: true });
  const db = new DatabaseSync(storePath);
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL);
      INSERT INTO schema_meta(version) SELECT 2 WHERE NOT EXISTS (SELECT 1 FROM schema_meta);
      UPDATE schema_meta SET version = 2 WHERE version < 2;
      CREATE TABLE IF NOT EXISTS scan_meta (id INTEGER PRIMARY KEY CHECK (id = 1), job_id TEXT NOT NULL, source_id TEXT NOT NULL, mode TEXT NOT NULL, phase TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS staged_messages (job_id TEXT NOT NULL, source_id TEXT NOT NULL, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, workspace_path TEXT, git_root TEXT, raw_meta_json TEXT NOT NULL, ordinal INTEGER NOT NULL, PRIMARY KEY(job_id,source_id,message_id));
      CREATE TABLE IF NOT EXISTS scan_source_state (source_id TEXT PRIMARY KEY, mode TEXT NOT NULL, phase TEXT NOT NULL, message_count INTEGER NOT NULL DEFAULT 0, result_count INTEGER NOT NULL DEFAULT 0, error_count INTEGER NOT NULL DEFAULT 0, scan_started_at TEXT, watermarked_since TEXT, updated_at TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS scan_results (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL, conversation_id TEXT NOT NULL, memory_id TEXT, error TEXT);
      CREATE INDEX IF NOT EXISTS scan_result_identity ON scan_results(source_id,conversation_id,memory_id,error);
    `);
    db.exec(`ATTACH DATABASE '${databasePath.replaceAll("'", "''")}' AS legacy`);
    const oldMessages = Number((db.prepare("SELECT COUNT(*) AS count FROM legacy.account_agent_source_scan_messages WHERE job_id=?").get(jobId) as { count: number }).count);
    const oldSources = Number((db.prepare("SELECT COUNT(*) AS count FROM legacy.account_agent_source_scan_source_state WHERE job_id=?").get(jobId) as { count: number }).count);
    const oldResults = Number((db.prepare("SELECT COALESCE(SUM(COALESCE(json_array_length(memory_ids_json),0) + COALESCE(json_array_length(errors_json),0)),0) AS count FROM legacy.account_agent_source_scan_results WHERE job_id=?").get(jobId) as { count: number }).count);
    const oldSourceErrors = Number((db.prepare("SELECT COALESCE(SUM(COALESCE(json_array_length(errors_json),0)),0) AS count FROM legacy.account_agent_source_scan_source_state WHERE job_id=?").get(jobId) as { count: number }).count);
    const oldJob = db.prepare("SELECT job_id AS jobId, source_id AS sourceId, COALESCE(mode,'incremental') AS mode, phase, created_at AS createdAt, updated_at AS updatedAt FROM legacy.account_agent_source_scan_jobs WHERE job_id=?").get(jobId) as { jobId: string; sourceId: string; mode: string; phase: string; createdAt: string; updatedAt: string } | undefined;
    if (!oldJob) return false;
    db.prepare("INSERT OR IGNORE INTO scan_meta(id,job_id,source_id,mode,phase,created_at,updated_at,error) VALUES(1,?,?,?,?,?,?,NULL)").run(oldJob.jobId, oldJob.sourceId, oldJob.mode, oldJob.phase, oldJob.createdAt, oldJob.updatedAt);
    const existingResults = Number((db.prepare("SELECT COUNT(*) AS count FROM scan_results").get() as { count: number }).count);
    db.exec("BEGIN");
    db.prepare(`INSERT OR IGNORE INTO staged_messages(job_id,source_id,conversation_id,message_id,role,content,created_at,workspace_path,git_root,raw_meta_json,ordinal)
      SELECT job_id,source_id,conversation_id,message_id,role,content,created_at,workspace_path,git_root,raw_meta_json,message_order
      FROM legacy.account_agent_source_scan_messages WHERE job_id=?`).run(jobId);
    db.prepare(`INSERT OR IGNORE INTO scan_source_state(source_id,mode,phase,message_count,result_count,error_count,scan_started_at,watermarked_since,updated_at,error)
      SELECT s.source_id, COALESCE(s.scan_mode, ?), ?,
        (SELECT COUNT(*) FROM legacy.account_agent_source_scan_messages m WHERE m.job_id=s.job_id AND m.source_id=s.source_id),
        (SELECT COUNT(*) FROM legacy.account_agent_source_scan_results r WHERE r.job_id=s.job_id AND r.source_id=s.source_id),
        COALESCE(json_array_length(s.errors_json),0), s.scan_started_at, s.watermarked_since, s.updated_at, NULL
      FROM legacy.account_agent_source_scan_source_state s WHERE s.job_id=?`).run(oldJob.mode, oldJob.phase, jobId);
    // json_each keeps legacy result arrays out of JavaScript memory.
    db.prepare(`INSERT INTO scan_results(source_id,conversation_id,memory_id,error)
      SELECT r.source_id, 'scan', json_each.value, NULL
      FROM legacy.account_agent_source_scan_results r, json_each(r.memory_ids_json) WHERE r.job_id=?`).run(jobId);
    db.prepare(`INSERT INTO scan_results(source_id,conversation_id,memory_id,error)
      SELECT r.source_id, json_extract(json_each.value,'$.conversationId'), NULL, json_extract(json_each.value,'$.reason')
      FROM legacy.account_agent_source_scan_results r, json_each(r.errors_json) WHERE r.job_id=?`).run(jobId);
    db.prepare(`INSERT INTO scan_results(source_id,conversation_id,memory_id,error)
      SELECT s.source_id, json_extract(json_each.value,'$.conversationId'), NULL, json_extract(json_each.value,'$.reason')
      FROM legacy.account_agent_source_scan_source_state s, json_each(s.errors_json) WHERE s.job_id=?`).run(jobId);
    const newMessages = Number((db.prepare("SELECT COUNT(*) AS count FROM staged_messages WHERE job_id=?").get(jobId) as { count: number }).count);
    const newSources = Number((db.prepare("SELECT COUNT(*) AS count FROM scan_source_state").get() as { count: number }).count);
    const newResults = Number((db.prepare("SELECT COUNT(*) AS count FROM scan_results").get() as { count: number }).count) - existingResults;
    if (newMessages < oldMessages || newSources < oldSources || newResults < oldResults + oldSourceErrors) { db.exec("ROLLBACK"); return false; }
    db.prepare("DELETE FROM legacy.account_agent_source_scan_messages WHERE job_id=?").run(jobId);
    db.prepare("DELETE FROM legacy.account_agent_source_scan_source_state WHERE job_id=?").run(jobId);
    db.prepare("DELETE FROM legacy.account_agent_source_scan_results WHERE job_id=?").run(jobId);
    db.prepare("DELETE FROM legacy.account_agent_source_scan_jobs WHERE job_id=?").run(jobId);
    db.exec("COMMIT");
    return true;
  } catch {
    try { db.exec("ROLLBACK"); } catch { /* preserve legacy journal */ }
    return false;
  } finally {
    try { db.exec("DETACH DATABASE legacy"); } catch { /* no attachment */ }
    db.close();
  }
}

/** Migrates every legacy scan job during App startup without loading journal arrays. */
export function migrateLegacyScanJournals(databasePath: string): number {
  if (!existsSync(databasePath)) return 0;
  let jobIds: string[] = [];
  try {
    const db = new DatabaseSync(databasePath);
    try {
      jobIds = (db.prepare("SELECT job_id AS jobId FROM account_agent_source_scan_jobs ORDER BY job_id").all() as Array<{ jobId: string }>)
        .map((row) => row.jobId)
        .filter((jobId) => typeof jobId === "string" && jobId.length > 0);
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
  let migrated = 0;
  for (const jobId of jobIds) {
    if (migrateLegacyScanJournal(databasePath, join(dirname(databasePath), "agent-source-scans", `${jobId}.sqlite`), jobId)) migrated += 1;
  }
  return migrated;
}
