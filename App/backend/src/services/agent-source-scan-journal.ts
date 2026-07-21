/** Agent source scan journal service helpers. */
import { DatabaseSync } from "node:sqlite";
import { createAgentSourceScanJournal } from "../infrastructure/agent-source-scan-journal/index.js";
import type { ScanResumeStateReference } from "./agent-source-scan-runner.js";

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
    if (!job) return null;
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
