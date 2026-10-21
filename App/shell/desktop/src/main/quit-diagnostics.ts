import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface QuitDiagnostic {
  schemaVersion: 1;
  quitId: string;
  pid: number;
  timestamp: string;
  elapsedMs: number;
  stopMemory: boolean;
  phase: string;
  event: "start" | "history-stopped" | "history-stop-failed" | "services-closed"
    | "cleanup-complete" | "cleanup-failed" | "force-start" | "force-complete" | "force-failed";
}

/** Complete the tiny write before app.exit; never include captured content or credentials. */
export function writeQuitDiagnostic(path: string, record: QuitDiagnostic): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", flush: true });
  } catch {
    // A missing/unwritable diagnostic destination must not prevent shutdown.
  }
}
