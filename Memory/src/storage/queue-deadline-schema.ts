import type Database from "better-sqlite3";

export const MAIN_DEADLINE = "MAX(COALESCE(available_at, ''), COALESCE(CAST(json_extract(payload_json, '$.runAfter') AS TEXT), ''))";
export const MAIN_TIMED = `status IN ('queued', 'failed') AND failure_count < max_attempts
  AND (blocked_reason IS NULL OR blocked_reason != 'configuration')
  AND (available_at IS NOT NULL OR json_type(payload_json, '$.runAfter') = 'text')`;
export const MAIN_LEASED = "status = 'leased' AND failure_count < max_attempts AND leased_until IS NOT NULL";
export const RETRY_LEASED = "status = 'in_progress'";
export const RETRY_DEADLINE = "CASE WHEN claimed_by IS NULL OR lease_until IS NULL THEN next_attempt_at ELSE MAX(next_attempt_at, lease_until) END";

/** Transactional change tokens, including raw/other-connection producers. New
 * sequences need discovery; changes to existing rows also invalidate old cursors.
 * Terminal removals cannot introduce an earlier deadline: a cached, earlier wake
 * is harmless and will recompute the remaining deadlines when it arrives. */
export function installQueueDeadlineSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS worker_deadline_revision (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL, rescan_revision INTEGER NOT NULL
  ); INSERT OR IGNORE INTO worker_deadline_revision VALUES (1, 0, 0)`);
  for (const table of ["evolution_jobs", "embedding_retry_queue"]) {
    const main = table === "evolution_jobs";
    const active = main ? "NEW.status IN ('queued','failed','leased')" : "NEW.status IN ('pending','in_progress')";
    const columns = main
      ? ["status", "available_at", "leased_until", "lease_owner", "job_type", "target_memory_id", "failure_count", "max_attempts", "blocked_reason", "payload_json"]
      : ["status", "next_attempt_at", "lease_until", "claimed_by", "target_id"];
    const changed = columns.map(column => column === "payload_json"
      ? "json_extract(OLD.payload_json, '$.runAfter') IS NOT json_extract(NEW.payload_json, '$.runAfter')"
      : `OLD.${column} IS NOT NEW.${column}`).join(" OR ");
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_deadline_insert AFTER INSERT ON ${table} WHEN ${active} BEGIN
      UPDATE worker_deadline_revision SET revision = revision + 1 WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS ${table}_deadline_update AFTER UPDATE OF ${columns.join(",")} ON ${table}
      WHEN (${active}) AND (${changed}) BEGIN
      UPDATE worker_deadline_revision SET revision = revision + 1, rescan_revision = rescan_revision + 1 WHERE singleton = 1;
    END`);
  }
  // Upgrade the earlier lease-only expression once; keep the ordered index on
  // normal reopens while allowing unowned legacy rows to wake at their backoff.
  const retryIndex = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='worker_retry_lease_deadline'")
    .get() as { sql: string } | undefined;
  if (retryIndex && !retryIndex.sql.includes(RETRY_DEADLINE)) db.exec("DROP INDEX worker_retry_lease_deadline");
  db.exec(`CREATE INDEX IF NOT EXISTS worker_main_deadline ON evolution_jobs(${MAIN_DEADLINE}) WHERE ${MAIN_TIMED};
    CREATE INDEX IF NOT EXISTS worker_main_lease_deadline ON evolution_jobs(leased_until) WHERE ${MAIN_LEASED};
    CREATE INDEX IF NOT EXISTS worker_retry_lease_deadline ON embedding_retry_queue(${RETRY_DEADLINE}) WHERE ${RETRY_LEASED}`);
}
