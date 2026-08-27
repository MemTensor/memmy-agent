import type { MemoryRow,RecallHit } from "../../types.js";
import { isRecord } from "../../utils/json.js";

export const MAX_RECALLED_SPANS_PER_TRACE = 2;

export function filterL1TraceSpanRecallHits(
  hits: readonly RecallHit[],
  memories: readonly MemoryRow[]
): RecallHit[] {
  const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
  const recalledSpanSources = new Set<string>();
  for (const hit of hits) {
    if (hit.memoryLayer !== "L1" || hit.kind !== "span") continue;
    const sourceTraceId = spanSourceTraceId(memoryById.get(hit.id));
    if (sourceTraceId) recalledSpanSources.add(sourceTraceId);
  }
  if (recalledSpanSources.size === 0) return [...hits];

  const keptSpansBySource = new Map<string,number>();
  return hits.filter((hit) => {
    if (hit.memoryLayer !== "L1") return true;
    if (hit.kind === "trace" && recalledSpanSources.has(hit.id)) return false;
    if (hit.kind !== "span") return true;
    const sourceTraceId = spanSourceTraceId(memoryById.get(hit.id));
    if (!sourceTraceId) return true;
    const kept = keptSpansBySource.get(sourceTraceId) ?? 0;
    if (kept >= MAX_RECALLED_SPANS_PER_TRACE) return false;
    keptSpansBySource.set(sourceTraceId,kept + 1);
    return true;
  });
}

function spanSourceTraceId(memory: MemoryRow | undefined): string | undefined {
  if (!memory || memory.memoryLayer !== "L1") return undefined;
  const span = isRecord(memory.properties.internal_info.span)
    ? memory.properties.internal_info.span
    : undefined;
  const sourceTraceId = span?.source_trace_id ?? memory.info.source_trace_id;
  return typeof sourceTraceId === "string" && sourceTraceId.trim()
    ? sourceTraceId.trim()
    : undefined;
}
