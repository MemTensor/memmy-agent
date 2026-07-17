import fs from "node:fs/promises";
import path from "node:path";
import { sessionDagDebugLogPath } from "./paths.js";

export type SessionDagDebugErrorStage = "request" | "parse" | "validation" | "apply";

export type SessionDagBuildAuditRecord = {
  version: 1;
  sessionKey: string;
  turnId: string;
  attempt: number;
  messageRange: { start: number; end: number };
  provider?: string | null;
  model?: string | null;
  startedAt: string;
  finishedAt?: string;
  request?: unknown;
  response?: unknown;
  parse?: unknown;
  validation?: unknown;
  apply?: unknown;
  error?: { stage: SessionDagDebugErrorStage; message: string } | null;
};

export class SessionDagDebugLogger {
  constructor(private readonly shouldWrite: boolean) {}

  enabled(): boolean {
    return this.shouldWrite;
  }

  async writeAttempt(record: SessionDagBuildAuditRecord): Promise<void> {
    if (!this.shouldWrite) return;
    const filePath = sessionDagDebugLogPath(record.sessionKey);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
  }
}
