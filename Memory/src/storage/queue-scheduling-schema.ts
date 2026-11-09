import { installQueueDeadlineSchema } from "./queue-deadline-schema.js";
import type Database from "better-sqlite3";
import { JOB_POLICY_VERSION } from "../service/worker/job-policy-registry.js";

// A persisted, event-maintained worklist: valid rows occupy no entries. Literal
// version predicates let SQLite use this partial index without scanning valid jobs.
export const pendingPolicyPredicate = `(policy_version IS NULL OR policy_version != ${JOB_POLICY_VERSION})`;
export const pendingPolicyIndex = (table: string, active = false): string => `${table}_policy_pending_v${JOB_POLICY_VERSION}${active ? "_active" : ""}`;
export const activePolicyPredicate = (table: string, prefix = ""): string => table === "evolution_jobs"
  ? `${prefix}status IN ('queued', 'leased', 'failed')` : `${prefix}status IN ('pending', 'in_progress')`;

/** Metadata only: none of these triggers changes job state, claims or eligibility. */
export function installQueueSchedulingSchema(db: Database.Database): void {
  for (const table of ["evolution_jobs", "embedding_retry_queue"]) {
    const names = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
    for (const [name, type] of Object.entries({
      queue_lane: "TEXT", resource_class: "TEXT", enqueue_seq: "INTEGER", first_queued_at: "TEXT",
      base_priority: "INTEGER", policy_version: "INTEGER", policy_promotion: "TEXT"
    })) {
      if (!names.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
  // An auxiliary counter holds no task facts. Keeping it after deletion prevents
  // reuse of a retired sequence, including when the newest row was deleted.
  db.exec(`CREATE TABLE IF NOT EXISTS worker_enqueue_counter (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1), value INTEGER NOT NULL
  )`);
  db.prepare(`INSERT INTO worker_enqueue_counter(singleton, value)
    VALUES (1, MAX(
      COALESCE((SELECT MAX(enqueue_seq) FROM evolution_jobs), 0),
      COALESCE((SELECT MAX(enqueue_seq) FROM embedding_retry_queue), 0)))
    ON CONFLICT(singleton) DO UPDATE SET value = MAX(value, excluded.value)`).run();
  const missing = db.prepare(`SELECT 'evolution_jobs' AS table_name, id, created_at AS queued_at,
      (julianday(created_at) - 2440587.5) * 86400000 AS queued_ms, rowid AS tie
    FROM evolution_jobs WHERE enqueue_seq IS NULL
    UNION ALL
    SELECT 'embedding_retry_queue', id, strftime('%Y-%m-%dT%H:%M:%fZ', created_at / 1000.0, 'unixepoch'),
      created_at, rowid FROM embedding_retry_queue WHERE enqueue_seq IS NULL
    ORDER BY queued_ms, table_name, tie`).all() as Array<{ table_name: string; id: string; queued_at: string }>;
  const next = db.prepare("UPDATE worker_enqueue_counter SET value = value + 1 WHERE singleton = 1 RETURNING value");
  for (const row of missing) {
    const seq = (next.get() as { value: number }).value;
    db.prepare(`UPDATE ${row.table_name} SET enqueue_seq = ?, first_queued_at = COALESCE(first_queued_at, ?) WHERE id = ?`)
      .run(seq, row.queued_at, row.id);
  }
  for (const table of ["evolution_jobs", "embedding_retry_queue"]) {
    // Some import producers deliberately backdate created_at to the source
    // conversation. New waiting time must start at insertion, not that date.
    const firstAt = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_enqueue_sequence AFTER INSERT ON ${table} BEGIN
      UPDATE worker_enqueue_counter SET value = value + 1 WHERE singleton = 1;
      UPDATE ${table} SET enqueue_seq = (SELECT value FROM worker_enqueue_counter WHERE singleton = 1),
        first_queued_at = ${firstAt}, policy_version = NULL WHERE id = NEW.id;
    END`);
    const main = table === "evolution_jobs";
    const columns = main ? ["job_type", "payload_json", "target_memory_id", "user_id", "session_id", "episode_id", "scope_key", "scope_seq"]
      : ["target_kind", "target_id", "vector_field", "source_text", "embed_role"];
    const newCycle = main
      ? "OLD.status IN ('succeeded', 'dead_letter') AND NEW.status IN ('queued', 'leased', 'failed')"
      : "OLD.status IN ('succeeded', 'failed') AND NEW.status IN ('pending', 'in_progress')";
    // Replace older broad triggers on existing installations as well. A reused
    // unfinished task retains its promotion; a new work cycle must earn it again.
    db.exec(`DROP TRIGGER IF EXISTS ${table}_policy_dirty`);
    db.exec(`CREATE TRIGGER ${table}_policy_dirty AFTER UPDATE OF ${columns.join(", ")}, status ON ${table}
      WHEN (${columns.map(column => `OLD.${column} IS NOT NEW.${column}`).join(" OR ")}) OR (${newCycle}) BEGIN
      UPDATE ${table} SET policy_version = NULL,
        policy_promotion = CASE WHEN ${newCycle} THEN NULL ELSE NEW.policy_promotion END WHERE id = NEW.id;
    END`);
    // Rule upgrades build a new worklist once; processing removes entries in FIFO
    // order. Reopening resumes remaining entries rather than restarting a scan.
    const obsolete = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND name GLOB ?")
      .all(table, `${table}_policy_pending_v*`) as Array<{ name: string }>;
    for (const index of obsolete) {
      if (![pendingPolicyIndex(table), pendingPolicyIndex(table, true)].includes(index.name)) db.exec(`DROP INDEX "${index.name.replaceAll('"', '""')}"`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS ${pendingPolicyIndex(table)} ON ${table}(enqueue_seq) WHERE ${pendingPolicyPredicate}`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${pendingPolicyIndex(table, true)} ON ${table}(enqueue_seq)
      WHERE ${pendingPolicyPredicate} AND ${activePolicyPredicate(table)}`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${table}_enqueue_seq ON ${table}(enqueue_seq)`);
    const due = table === "evolution_jobs" ? "available_at" : "next_attempt_at";
    db.exec(`CREATE INDEX IF NOT EXISTS ${table}_lane_due ON ${table}(status, queue_lane, ${due}, enqueue_seq)`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${table}_lane_fifo ON ${table}(queue_lane, enqueue_seq)`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${table}_policy_dirty ON ${table}(policy_version)`);
  }
  // Target-only invalidations cannot use the existing (target_kind, target_id)
  // index's left prefix; avoid a retry-table scan for every imported memory.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_embedding_retry_policy_target ON embedding_retry_queue(target_id)`);
  db.exec("DROP TRIGGER IF EXISTS memories_worker_policy_dirty");
  db.exec(`CREATE TRIGGER memories_worker_policy_dirty
    AFTER UPDATE OF agent_id, tags_json, properties_json, memory_layer ON memories
    WHEN OLD.agent_id IS NOT NEW.agent_id OR OLD.tags_json IS NOT NEW.tags_json
      OR OLD.memory_layer IS NOT NEW.memory_layer
      OR json_extract(OLD.properties_json, '$.internal_info.plugin_algorithm') IS NOT json_extract(NEW.properties_json, '$.internal_info.plugin_algorithm')
      OR json_extract(OLD.properties_json, '$.internal_info.capture_origin') IS NOT json_extract(NEW.properties_json, '$.internal_info.capture_origin')
      OR json_extract(OLD.properties_json, '$.internal_info.project_id') IS NOT json_extract(NEW.properties_json, '$.internal_info.project_id')
      OR json_extract(OLD.properties_json, '$.internal_info.projectId') IS NOT json_extract(NEW.properties_json, '$.internal_info.projectId')
    BEGIN
      UPDATE evolution_jobs SET policy_version = NULL WHERE target_memory_id = NEW.id;
      UPDATE embedding_retry_queue SET policy_version = NULL WHERE target_id = NEW.id;
    END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS memories_worker_policy_insert AFTER INSERT ON memories BEGIN
    UPDATE evolution_jobs SET policy_version = NULL WHERE target_memory_id = NEW.id;
    UPDATE embedding_retry_queue SET policy_version = NULL WHERE target_id = NEW.id;
  END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS memories_worker_policy_delete AFTER DELETE ON memories BEGIN
    UPDATE evolution_jobs SET policy_version = NULL WHERE target_memory_id = OLD.id;
    UPDATE embedding_retry_queue SET policy_version = NULL WHERE target_id = OLD.id;
  END`);
  installQueueDeadlineSchema(db);
}
