import type Database from "better-sqlite3";
import { sharedProjectIds } from "../service/namespace/shared-project.js";

const PREFIX = "project_environment_scan_boundary_v1:";
interface ScanBoundary { jobId: string | null; sequence: number }

export function isProjectEnvironmentScanBoundaryKey(key: unknown): boolean {
  return typeof key === "string" && key.startsWith(PREFIX);
}

function key(projectId: string): string { return PREFIX + JSON.stringify(projectId); }

/** Publication permission is local metadata, never an imported job's queue position. */
export function readProjectEnvironmentScanBoundary(db: Database.Database, projectId: string): ScanBoundary | undefined {
  const keys = sharedProjectIds(db, projectId).filter((id): id is string => id !== null).map(key);
  const rows = db.prepare("SELECT value_json FROM runtime_kv WHERE key IN (SELECT value FROM json_each(?))")
    .all(JSON.stringify(keys)) as Array<{value_json: string}>;
  let latest: ScanBoundary | undefined;
  for (const row of rows) {
    const value = JSON.parse(row.value_json) as ScanBoundary;
    if (!value || (value.jobId !== null && typeof value.jobId !== "string") ||
        !Number.isSafeInteger(value.sequence) || value.sequence < 0) {
      throw new Error("corrupt project environment scan boundary");
    }
    // A deletion at the same local queue position wins over its preceding request.
    if (!latest || value.sequence > latest.sequence ||
        (value.sequence === latest.sequence && value.jobId === null)) latest = value;
  }
  return latest;
}

function write(db: Database.Database, projectId: string, boundary: ScanBoundary, at: string): ScanBoundary {
  db.prepare(`INSERT INTO runtime_kv (key,value_json,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
    .run(key(projectId), JSON.stringify(boundary), at);
  return boundary;
}

export function revokeProjectEnvironmentScans(db: Database.Database, projectId: string, at: string): void {
  const counter = db.prepare("SELECT value FROM worker_enqueue_counter WHERE singleton=1").get() as {value: number};
  write(db, projectId, {jobId: null, sequence: counter.value}, at);
}

export function recordProjectEnvironmentScanRequest(db: Database.Database, projectId: string, jobId: string, at: string): void {
  const job = db.prepare("SELECT enqueue_seq FROM evolution_jobs WHERE id=?").get(jobId) as {enqueue_seq: number};
  write(db, projectId, {jobId, sequence: job.enqueue_seq}, at);
}

/** Lazy compatibility for an existing local database; preserve deleted scan history too. */
export function ensureProjectEnvironmentScanBoundary(db: Database.Database, projectId: string, at: string): ScanBoundary {
  const existing = readProjectEnvironmentScanBoundary(db, projectId);
  if (existing) return existing;
  const projects = sharedProjectIds(db, projectId);
  const latest = db.prepare(`SELECT job.id, job.enqueue_seq, state.current_scan_id,
      json_extract(job.payload_json, '$.scanId') AS scan_id
    FROM evolution_jobs AS job JOIN l3_world_model_project_environment_state AS state
      ON job.user_id=state.user_id
      AND json_extract(job.payload_json, '$.userId')=state.user_id
      AND json_extract(job.payload_json, '$.projectId')=state.project_id
    WHERE job.job_type='project_environment_profile'
      AND state.project_id IN (SELECT value FROM json_each(?))
    ORDER BY job.enqueue_seq DESC LIMIT 1`).get(JSON.stringify(projects)) as
      {id: string; enqueue_seq: number; current_scan_id: string | null; scan_id: string} | undefined;
  if (!latest) {
    revokeProjectEnvironmentScans(db, projectId, at);
    return readProjectEnvironmentScanBoundary(db, projectId)!;
  }
  return write(db, projectId, {
    jobId: latest.current_scan_id === latest.scan_id ? latest.id : null,
    sequence: latest.enqueue_seq
  }, at);
}
