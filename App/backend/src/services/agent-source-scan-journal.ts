/** Agent source scan journal service helpers. */
import { DatabaseSync } from "node:sqlite";
import { createAgentSourceScanJournal } from "../infrastructure/agent-source-scan-journal/index.js";

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
