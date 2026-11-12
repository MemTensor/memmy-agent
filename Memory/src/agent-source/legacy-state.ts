import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

export interface LegacySourceRecovery {
  sourceId: string;
  lastScannedAt: string | null;
  messageCount: number;
  checkpointCount: number;
  unfinished: boolean;
}

/** Read-only inspection. Never copy a legacy timestamp without reconciling its checkpoints. */
export function readLegacyScanState(databasePath: string | undefined): LegacySourceRecovery[] {
  if (!databasePath || !existsSync(databasePath)) return [];
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  const sources = new Map<string, LegacySourceRecovery>();
  let pendingAll = false;
  function source(sourceId: string) {
    let record = sources.get(sourceId);
    if (!record) {
      record = { sourceId, lastScannedAt: null, messageCount: 0, checkpointCount: 0, unfinished: false };
      sources.set(sourceId, record);
    }
    return record;
  }
  const scope = "local-agent-sources";
  const has = (table: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  try {
    if (has("account_agent_sources")) {
      for (const row of db.prepare("SELECT source_id, last_scanned_at FROM account_agent_sources WHERE uuid=? AND builtin=1").all(scope) as Array<{ source_id: string; last_scanned_at: string | null }>) {
        if (row.last_scanned_at) source(row.source_id).lastScannedAt = row.last_scanned_at;
      }
    }
    if (has("account_agent_source_watermarks")) {
      for (const row of db.prepare("SELECT source_id FROM account_agent_source_watermarks WHERE uuid=?").all(scope) as Array<{ source_id: string }>) source(row.source_id);
    }
    if (has("account_agent_source_conversation_checkpoints")) {
      for (const row of db.prepare("SELECT source_id, COUNT(*) AS count FROM account_agent_source_conversation_checkpoints WHERE uuid=? GROUP BY source_id").all(scope) as Array<{ source_id: string; count: number }>) source(row.source_id).checkpointCount = row.count;
    }
    if (has("account_ingestion_seen")) {
      for (const row of db.prepare("SELECT source_id, COUNT(*) AS count FROM account_ingestion_seen WHERE uuid=? GROUP BY source_id").all(scope) as Array<{ source_id: string; count: number }>) source(row.source_id).messageCount = row.count;
    }
    if (has("account_agent_source_scan_jobs")) {
      for (const row of db.prepare("SELECT source_id FROM account_agent_source_scan_jobs WHERE uuid=?").all(scope) as Array<{ source_id: string }>) {
        if (row.source_id === "all") pendingAll = true;
        else source(row.source_id).unfinished = true;
      }
    }
  } finally { db.close(); }
  const directory = join(dirname(databasePath), "agent-source-scans");
  if (existsSync(directory)) {
    for (const name of readdirSync(directory).filter((name) => name.endsWith(".sqlite"))) {
      let job: InstanceType<typeof Database> | undefined;
      try {
        job = new Database(join(directory, name), { readonly: true, fileMustExist: true });
        const meta = job.prepare("SELECT source_id, phase FROM scan_meta WHERE id=1").get() as { source_id: string; phase: string } | undefined;
        if (meta && meta.phase !== "done") {
          if (meta.source_id === "all") pendingAll = true;
          else source(meta.source_id).unfinished = true;
        }
      } catch {
        // A corrupt legacy journal cannot justify advancing any source boundary.
        pendingAll = true;
      } finally { job?.close(); }
    }
  }
  if (pendingAll) source("all").unfinished = true;
  return [...sources.values()];
}
