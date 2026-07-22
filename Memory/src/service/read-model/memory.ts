import type { MemoryDetailItem, MemoryProcessingRecord, MemoryRow } from "../../types.js";
import { kindFromMemory } from "../../storage/repositories.js";
import { policyMetaFromMemory, skillMetaFromMemory, traceMetaFromMemory, worldModelMetaFromMemory } from "../../algorithm/plugin-algorithms.js";
import { panelSourceForMemory, panelTagsForMemory } from "./panel.js";
import { isRecord } from "../../utils/json.js";
import { firstLine } from "../../utils/text.js";

export function detailFromMemory(memory: MemoryRow, processing?: MemoryProcessingRecord): MemoryDetailItem {
  const sourceMemoryIds = memory.properties.internal_info.source_memory_ids;
  return { id: memory.id, kind: kindFromMemory(memory), memoryLayer: memory.memoryLayer, status: memory.status,
    title: detailTitleForMemory(memory), summary: detailSummaryForMemory(memory), tags: panelTagsForMemory(memory, processing),
    updatedAt: memory.updatedAt, version: memory.version, processing, body: memory.memoryValue, createdAt: memory.createdAt,
    sourceMemoryIds: stringArray(sourceMemoryIds), metadata: { source: panelSourceForMemory(memory), info: memory.info, properties: memory.properties } };
}

export function detailTitleForMemory(memory: MemoryRow): string {
  const trace = traceMetaFromMemory(memory); const policy = policyMetaFromMemory(memory); const worldModel = worldModelMetaFromMemory(memory); const skill = skillMetaFromMemory(memory);
  const title = firstDetailDisplayString(stringFromMaybeRecord(memory.info, "title"), stringFromMaybeRecord(memory.properties.internal_info, "title"), trace?.summary, policy?.title, worldModel?.title, skill?.name, firstReadableDetailMemoryLine(memory.memoryValue), isInternalMemoryKeyForDisplay(memory.memoryKey) ? undefined : memory.memoryKey);
  return truncateDetailTitle(title ?? memory.id);
}

export function detailSummaryForMemory(memory: MemoryRow): string {
  const trace = traceMetaFromMemory(memory); const policy = policyMetaFromMemory(memory); const worldModel = worldModelMetaFromMemory(memory); const skill = skillMetaFromMemory(memory);
  return firstDetailDisplayString(stringFromMaybeRecord(memory.info, "summary"), stringFromMaybeRecord(memory.properties.internal_info, "summary"), trace?.summary, policy?.trigger, policy?.procedure, worldModel?.body, worldModel?.title, skill?.invocationGuide, firstReadableDetailMemoryLine(memory.memoryValue), firstLine(memory.memoryValue)) ?? "";
}

export function firstDetailDisplayString(...values: Array<string | undefined | null>): string | undefined {
  return values.map(cleanDetailDisplayText).find((value): value is string => Boolean(value && !isWorldSectionHeadingForDisplay(value) && !isInternalMemoryKeyForDisplay(value)));
}

export function memoryDetailWithLayerPayload(detail: MemoryDetailItem, memory: MemoryRow): MemoryDetailItem & Record<string, unknown> {
  const item: MemoryDetailItem & Record<string, unknown> = { ...detail };
  if (memory.memoryLayer === "L1") {
    const trace = traceMetaFromMemory(memory);
    const tracePayload = { episodeId: trace?.episodeId ?? stringFromMaybeRecord(memory.info, "episode_id") ?? "", rawTurnId: rawTurnIdFromMemory(memory) ?? "", turnId: trace?.turnId ?? stringFromMaybeRecord(memory.info, "turn_id") ?? "" };
    if (tracePayload.episodeId && tracePayload.rawTurnId && tracePayload.turnId) item.trace = tracePayload;
  } else if (memory.memoryLayer === "L2") {
    const policy = policyMetaFromMemory(memory); item.policy = { utilityScore: policy?.gain, confidence: policy?.confidence, evidenceMemoryIds: policy?.sourceTraceIds ?? sourceMemoryIdsFromMemory(memory), repairHints: policy?.verification ? [policy.verification] : [] };
  } else if (memory.memoryLayer === "L3") {
    const worldModel = worldModelMetaFromMemory(memory); item.worldModel = { sourceMemoryIds: worldModel?.policyIds ?? sourceMemoryIdsFromMemory(memory), confidence: worldModel?.confidence };
  } else if (memory.memoryLayer === "Skill") {
    const skill = skillMetaFromMemory(memory); item.skill = { invocationGuide: skill?.invocationGuide ?? detail.body, procedure: procedureFromSkillMemory(memory), sourcePolicyIds: skill?.sourcePolicyIds ?? [], sourceWorldModelIds: skill?.sourceWorldModelIds ?? [], reliabilityScore: skill?.eta, utilityScore: skill?.eta, evidenceCount: skill?.evidenceAnchorIds.length };
  }
  return item;
}

export function memoryEtag(memory: MemoryRow): string { return `${memory.id}-v${memory.version}`; }
export function sourceMemoryIdsFromMemory(memory: MemoryRow): string[] { return stringArrayFromInternal(memory, "source_memory_ids").concat(stringArrayFromInternal(memory, "source_l1_memory_ids")).concat(stringArrayFromInternal(memory, "source_policy_ids")).concat(stringArrayFromInternal(memory, "evidence_anchor_ids")); }
export function procedureFromSkillMemory(memory: MemoryRow): string[] | undefined { const value = memory.properties.internal_info.procedure_json ?? memory.properties.internal_info.procedure; if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string"); if (typeof value === "string") { try { const parsed = JSON.parse(value) as unknown; if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string"); } catch { return value.split(/\r?\n/).map((line) => line.replace(/^[-*]\s*/, "").trim()).filter(Boolean); } } return undefined; }

function firstReadableDetailMemoryLine(value: string): string | undefined { return value.split(/\r?\n/).map(cleanDetailDisplayText).find((line): line is string => Boolean(line && !isWorldSectionHeadingForDisplay(line) && !isInternalMemoryKeyForDisplay(line))); }
function cleanDetailDisplayText(value?: string | null): string | undefined { const text = (value ?? "").replace(/^\s*Summary:\s*/i, "").replace(/^\s*#{1,6}\s+/, "").replace(/^\s*[-*]\s+/, "").replace(/\*\*([^*]+)\*\*/g, "$1").trim(); return text || undefined; }
function isWorldSectionHeadingForDisplay(value: string): boolean { return /^(Environment|Inference|Constraints|Environment Knowledge|环境|环境拓扑|行为规律|约束禁忌|结构化认知)$/i.test(value.trim()); }
function isInternalMemoryKeyForDisplay(value?: string | null): boolean { return Boolean(value && /^(trace|policy|world|world_model|skill)[:_]/i.test(value.trim())); }
export function truncateDetailTitle(value: string): string { return value.length <= 80 ? value : `${value.slice(0, 77)}...`; }
function stringArrayFromInternal(memory: MemoryRow, key: string): string[] { return stringArray(memory.properties.internal_info[key]); }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : []; }
function stringFromMaybeRecord(record: unknown, key: string): string | undefined { return isRecord(record) ? stringFromRecord(record, key) : undefined; }
function stringFromRecord(record: Record<string, unknown>, key: string): string | undefined { const value = record[key]; return typeof value === "string" ? value : undefined; }
function rawTurnIdFromMemory(memory: MemoryRow): string | undefined { const source = memory.properties.internal_info.source_raw_turn_id; if (typeof source === "string" && source) return source; const raw = memory.properties.internal_info.raw_turn_id; if (typeof raw === "string" && raw) return raw; const trace = memory.properties.internal_info.trace; return isRecord(trace) ? stringFromRecord(trace, "raw_turn_id") : undefined; }
