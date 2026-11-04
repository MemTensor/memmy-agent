import { traceMetaFromMemory } from "../../algorithm/plugin-algorithms.js";
import type { MemoryProcessingRecord, MemoryRow } from "../../types.js";
import { isObservationMemory } from "../observation-memory-state.js";

export function canRetryMemoryProcessing(memory: MemoryRow, processing: MemoryProcessingRecord): boolean {
  if (processing.state !== "failed" || (processing.stage !== "summary" && processing.stage !== "embedding")) return false;
  if (memory.status === "deleted" || memory.deletedAt || !memory.memoryValue.trim()) return false;
  // Legacy generic 4xx failures may become runnable after a connection repair.
  // Corrupt, oversized and other explicitly terminal failures remain restricted.
  if (processing.retryAction === "none" && processing.errorCode !== "invalid_model_request") return false;
  if (memory.memoryLayer === "L1" && !isObservationMemory(memory)) {
    const trace = traceMetaFromMemory(memory);
    if (!trace || !(trace.userText.trim() || trace.agentText.trim() || trace.toolCalls.some(call =>
      call.input !== undefined || call.output !== undefined))) return false;
  }
  return true;
}

/** Expose manual recovery without rewriting diagnostics or enabling automatic retries. */
export function processingWithRetryAction(memory: MemoryRow, processing?: MemoryProcessingRecord): MemoryProcessingRecord | undefined {
  return processing?.retryAction === "none" && canRetryMemoryProcessing(memory, processing)
    ? { ...processing, retryAction: "retry" } : processing;
}
