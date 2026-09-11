/** Agent source scan journal service helpers. */
import { DatabaseSync } from "node:sqlite";
import { readdirSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createAgentSourceScanJournal } from "../infrastructure/agent-source-scan-journal/index.js";
import { openAppAgentSourceScanStore } from "../infrastructure/agent-source-scan-store/index.js";
import type { ScanResumeStateReference } from "./agent-source-scan-runner.js";

const COMPLETED_DETAILS_RETENTION_MS = 60 * 60 * 1000;

export interface PersistedScanResume {
  jobId: string;
  sourceId: string;
  mode?: "initial_subset" | "incremental" | "full";
  resume: ScanResumeStateReference;
}

/** Reads the most recently persisted resumable scan, if one exists. */
export function readLatestPersistedScanResume(databasePath: string | undefined): PersistedScanResume | null {
  if (!databasePath) return null;
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    const job = createAgentSourceScanJournal(db).findLatestJob();
    if (!job) {
      return readLatestDurableScanResume(databasePath);
    }
    return {
      jobId: job.jobId,
      sourceId: job.sourceId,
      mode: job.mode,
      resume: job.phase === "add"
        ? {
          storage: "sqlite",
          phase: "add",
          jobId: job.jobId,
          sourceId: job.sourceId,
          messageCount: job.messageCount,
          sourceCount: job.sourceCount
        }
        : {
          storage: "sqlite",
          phase: "summarize",
          jobId: job.jobId,
          sourceId: job.sourceId,
          resultCount: job.resultCount
        }
    };
  } finally {
    db.close();
  }
}

function readLatestDurableScanResume(databasePath: string): PersistedScanResume | null {
  const directory = join(dirname(databasePath), "agent-source-scans");
  if (!existsSync(directory)) return null;
  const files = readdirSync(directory).filter((file) => file.endsWith(".sqlite"));
  let latest: PersistedScanResume | null = null;
  let latestUpdatedAt = Number.NEGATIVE_INFINITY;
  for (const file of files) {
    const path = join(directory, file);
    try {
      const db = new DatabaseSync(path);
      const row = db.prepare("SELECT job_id AS jobId, source_id AS sourceId, mode, phase, updated_at AS updatedAt FROM scan_meta WHERE id=1").get() as { jobId: string; sourceId: string; mode?: "initial_subset" | "incremental" | "full"; phase: string; updatedAt: string } | undefined;
      const count = Number((db.prepare("SELECT COUNT(*) AS count FROM staged_messages").get() as { count: number }).count);
      let sourceCount = 1;
      try {
        sourceCount = Number((db.prepare("SELECT COUNT(*) AS count FROM scan_source_state").get() as { count: number }).count) || 1;
      } catch {
        // Stores created by the first staging build did not have source state.
      }
      const resultCount = Number((db.prepare("SELECT COUNT(*) AS count FROM scan_results").get() as { count: number }).count);
      db.close();
      if (!row) continue;
      const updatedAt = Date.parse(row.updatedAt);
      if (row.phase === "done") {
        if (Number.isFinite(updatedAt) && Date.now() - updatedAt > COMPLETED_DETAILS_RETENTION_MS) deleteDurableScanStore(databasePath, row.jobId);
        continue;
      }
      if (updatedAt >= latestUpdatedAt) {
        latestUpdatedAt = updatedAt;
        latest = row.phase === "summarize"
          ? { jobId: row.jobId, sourceId: row.sourceId, mode: row.mode, resume: { storage: "sqlite", phase: "summarize", jobId: row.jobId, sourceId: row.sourceId, resultCount } }
          : { jobId: row.jobId, sourceId: row.sourceId, mode: row.mode, resume: { storage: "sqlite", phase: "add", jobId: row.jobId, sourceId: row.sourceId, messageCount: count, sourceCount: sourceCount || 1 } };
      }
    } catch { /* corrupt stores are retained for diagnostics */ }
  }
  return latest;
}

/** Deletes persisted scan resume state for one job. */
export function deletePersistedScanResume(databasePath: string | undefined, jobId: string): void {
  if (!databasePath) {
    return;
  }

  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    createAgentSourceScanJournal(db).deleteJob(jobId);
  } finally {
    db.close();
  }
}

export function deleteDurableScanStore(databasePath: string | undefined, jobId: string): void {
  if (!databasePath) return;
  const path = join(dirname(databasePath), "agent-source-scans", `${jobId}.sqlite`);
  rmSync(path, { force: true });
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}

export function readDurableScanResults(databasePath: string | undefined, jobId: string, cursor = "0", limit = 100): { items: unknown[]; nextCursor: string | null } {
  if (!databasePath) return { items: [], nextCursor: null };
  const path = join(dirname(databasePath), "agent-source-scans", `${jobId}.sqlite`);
  if (!existsSync(path)) return { items: [], nextCursor: null };
  const store = openAppAgentSourceScanStore(path, { jobId, sourceId: "all", mode: "incremental", phase: "ingest", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  let removeAfterRead = false;
  try {
    const safeLimit = Math.min(500, Math.max(1, limit));
    const safeCursor = Number.isFinite(Number(cursor)) && Number(cursor) >= 0 ? String(Math.floor(Number(cursor))) : "0";
    const rows = [...store.results(undefined, safeCursor, safeLimit)];
    const items = rows.map(({ cursor: _cursor, ...item }) => item);
    const nextCursor = rows.length < safeLimit ? null : rows.at(-1)?.cursor ?? null;
    removeAfterRead = nextCursor === null && store.getMeta()?.phase === "done";
    return { items, nextCursor };
  } finally {
    store.close();
    if (removeAfterRead) deleteDurableScanStore(databasePath, jobId);
  }
}
