import type { ApiLogRecord, Repositories } from "../../storage/repositories.js";
import { nowIso } from "../../utils/time.js";

type ApiLogRepository = Pick<Repositories["runtime"], "insertApiLog">;

export function recordApiLog(
  runtime: ApiLogRepository,
  toolName: ApiLogRecord["toolName"],
  input: unknown,
  output: unknown,
  durationMs: number,
  success: boolean,
  calledAt = nowIso(),
  sourceAgent?: string
): void {
  runtime.insertApiLog({
    toolName,
    sourceAgent: sourceAgent?.trim() || undefined,
    inputJson: JSON.stringify(input ?? {}),
    outputJson: JSON.stringify(output ?? {}),
    durationMs: Math.max(0, Math.round(durationMs)),
    success,
    calledAt
  });
}
