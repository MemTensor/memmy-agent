import { panelSourceForStatsRow } from "../../utils/panel-source.js";
import type { MemoryListItem, MemoryProcessingRecord, MemoryRow, MemoryStatsRow } from "../../types.js";
import { isRecord } from "../../utils/json.js";
import {
  IMPORT_FAILED_TAG,
  IMPORT_INDEXING_TAG,
  IMPORT_STATUS_TAGS,
  IMPORT_SUMMARY_PROCESSING_TAG
} from "../import/memory-import-pipeline.js";
import { panelDateKey, panelRoundDecimal } from "./model-costs.js";
import { observedActivitySummary } from "./display-fields.js";
import { externalEvidenceSourceMatchesMemory } from "../external-evidence-source.js";

export function panelListItemFromMemory(
  item: MemoryListItem,
  memory: MemoryRow,
  processing?: MemoryProcessingRecord
): MemoryListItem {
  const spanGoal = panelSpanGoalForMemory(memory);
  const observationSummary = observedActivitySummary(memory);
  const observation = isRecord(memory.properties.internal_info.observation_memory)
    ? memory.properties.internal_info.observation_memory : {};
  return {
    ...item,
    ...(observationSummary ? { summary: observationSummary } : {}),
    processing,
    metadata: {
      ...(item.metadata ?? {}),
      source: panelSourceForMemory(memory),
      ...(memory.properties.internal_info.memory_kind === "observed_activity" && observation.schema_version === 1
        ? { observationStatus: observation.status, observationSkipReason: observation.skip_reason }
        : {}),
      ...(spanGoal ? { spanGoal } : {})
    },
    tags: panelTagsForMemory(memory, processing)
  };
}

function panelSpanGoalForMemory(memory: MemoryRow): string | undefined {
  if (memory.properties.internal_info.memory_kind !== "span") return undefined;
  const span = isRecord(memory.properties.internal_info.span) ? memory.properties.internal_info.span : {};
  const goal = span.span_goal;
  return typeof goal === "string" && goal.trim() ? goal.trim() : undefined;
}

export function panelSourceDistribution(memories: MemoryStatsRow[]): Array<{ source: string; count: number; percentage: number }> {
  const counts = new Map<string, number>();
  for (const memory of memories) {
    const rawSource = panelSourceForStatsRow(memory);
    // Aggregate History with Memmy here; individual records retain their source metadata.
    const source = rawSource === "computer_history" ? "memmy" : rawSource;
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([source, count]) => ({
      source,
      count,
      percentage: memories.length > 0 ? panelRoundDecimal((count / memories.length) * 100, 1) : 0
    }))
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
}

export function panelCountByDate<T>(
  rows: T[],
  dates: string[],
  getTime: (row: T) => string | undefined,
  timeZone?: string
): Array<{ date: string; count: number }> {
  const counts = new Map(dates.map((date) => [date, 0]));
  for (const row of rows) {
    const key = panelDateKey(getTime(row), timeZone);
    if (counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return dates.map((date) => ({ date, count: counts.get(date) ?? 0 }));
}

export function panelTagsForMemory(memory: MemoryRow, processing?: MemoryProcessingRecord): string[] {
  const tags = memory.tags.filter((tag) => !IMPORT_STATUS_TAGS.includes(tag));
  if (memory.status === "archived" || memory.status === "deleted" || !processing) return tags;
  const label = processing.state === "summary_pending" || processing.state === "summarizing"
    ? IMPORT_SUMMARY_PROCESSING_TAG
    : processing.state === "embedding_pending" || processing.state === "embedding"
      ? IMPORT_INDEXING_TAG
      : processing.state === "failed"
        ? IMPORT_FAILED_TAG
        : undefined;
  return label ? uniq([...tags, label]) : tags;
}

export function panelSourceForMemory(memory: MemoryRow): string {
  const internalInfo: Record<string, unknown> = isRecord(memory.properties.internal_info)
    ? memory.properties.internal_info
    : {};
  const external = isRecord(internalInfo.external_evidence) ? internalInfo.external_evidence : {};
  const provenance = isRecord(external.provenance) ? external.provenance : {};
  if (memory.memoryLayer === "Skill" && externalEvidenceSourceMatchesMemory(memory, "computer_history")) {
    return "computer_history";
  }
  if (internalInfo.memory_kind === "observed_activity" && (
    external.source === "computer_history" || typeof provenance.historyId === "string"
  )) return "computer_history";
  return panelSourceForStatsRow({
    conversationId: memory.conversationId,
    sessionId: memory.sessionId,
    agentId: memory.agentId,
    appId: memory.appId,
    infoSource: memory.info.source,
    internalSource: internalInfo.source
  });
}


function uniq(values: string[]): string[] {
  return [...new Set(values)];
}
