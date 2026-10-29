import type { Repositories } from "../storage/repositories.js";
import { kindFromMemory } from "../storage/repositories.js";
import type { MemoryRow, RuntimeNamespace } from "../types.js";
import { stableHash } from "../utils/id.js";
import { isRecord } from "../utils/json.js";
import { namespaceForMemory, normalizeNamespace } from "./namespace/namespace-scope.js";

/** Evidence keys include tenant identity, which ordinary MemoryRow fields omit. */
export function externalEvidenceNamespaceForMemory(memory: MemoryRow): RuntimeNamespace {
  const origin = memory.memoryLayer === "Skill"
    ? memory.properties.internal_info.external_evidence_candidate
    : memory.properties.internal_info.external_evidence;
  const fallback = namespaceForMemory(memory);
  return isRecord(origin) && isRecord(origin.namespace)
    ? normalizeNamespace({ ...fallback, ...origin.namespace })
    : fallback;
}

export function externalEvidenceMemoryKey(namespace: RuntimeNamespace, source: string, sourceRecordId: string): string {
  const normalized = normalizeNamespace(namespace);
  return `external-evidence:${stableHash({
    userId: normalized.userId, tenantId: normalized.tenantId, projectId: normalized.projectId,
    profileId: normalized.profileId, namespaceSource: normalized.source, source, sourceRecordId
  }).slice(0, 48)}`;
}

/** Older HTTP envelopes overwrote computer_history with the Memmy namespace source. */
export function lookupExternalEvidence(
  memories: Pick<Repositories["memories"], "getByKeyIncludingDeleted">,
  namespace: RuntimeNamespace,
  source: string,
  sourceRecordId: string
): { key: string; memory?: MemoryRow } {
  const key = externalEvidenceMemoryKey(namespace, source, sourceRecordId);
  const canonical = memories.getByKeyIncludingDeleted("L1", key);
  if (source !== "computer_history" || normalizeNamespace(namespace).source !== "memmy") {
    return { key, memory: canonical };
  }
  const legacyKey = externalEvidenceMemoryKey(namespace, "memmy", sourceRecordId);
  const legacy = memories.getByKeyIncludingDeleted("L1", legacyKey);
  if (!isLegacyHistoryEvidence(legacy, sourceRecordId)) return { key, memory: canonical };
  // A previously deleted source remains deleted even if a newer caller already
  // attempted to use its corrected source key. Never choose an active duplicate
  // over the user's durable deletion.
  if (legacy!.status === "deleted" || legacy!.deletedAt) return { key: legacyKey, memory: legacy };
  return canonical ? { key, memory: canonical } : { key: legacyKey, memory: legacy };
}

function externalEvidenceSourcesMatch(left: unknown, right: string): boolean {
  return left === right || ((left === "memmy" || left === "computer_history")
    && (right === "memmy" || right === "computer_history"));
}

/** Only records recognizable as History may use the old Memmy producer alias. */
export function externalEvidenceSourceMatchesMemory(memory: MemoryRow, source: string): boolean {
  const origin = memory.memoryLayer === "Skill"
    ? memory.properties.internal_info.external_evidence_candidate
    : memory.properties.internal_info.external_evidence;
  if (!isRecord(origin)) return false;
  if (origin.source === source) return true;
  if (memory.agentId !== "memmy" || !externalEvidenceSourcesMatch(origin.source, source)) return false;
  if (memory.memoryLayer === "Skill") return isHistorySkillOrigin(origin);
  return typeof origin.sourceRecordId === "string" && isLegacyHistoryEvidence(memory, origin.sourceRecordId);
}

export function externalEvidenceSkillKey(
  namespace: RuntimeNamespace, source: string, groupId: string, revision: string
): string {
  const normalized = normalizeNamespace(namespace);
  return `skill:external-evidence:${stableHash({
    userId: normalized.userId, tenantId: normalized.tenantId, projectId: normalized.projectId,
    profileId: normalized.profileId, namespaceSource: normalized.source, source, groupId, revision
  }).slice(0, 48)}`;
}

export function lookupExternalEvidenceSkill(
  memories: Pick<Repositories["memories"], "getByKeyIncludingDeleted">,
  namespace: RuntimeNamespace,
  source: string,
  groupId: string,
  revision: string
): { key: string; memory?: MemoryRow } {
  const key = externalEvidenceSkillKey(namespace, source, groupId, revision);
  const canonical = memories.getByKeyIncludingDeleted("Skill", key);
  if (source !== "computer_history" || normalizeNamespace(namespace).source !== "memmy") {
    return { key, memory: canonical };
  }
  const legacyKey = externalEvidenceSkillKey(namespace, "memmy", groupId, revision);
  const legacy = memories.getByKeyIncludingDeleted("Skill", legacyKey);
  const origin = legacy?.properties.internal_info.external_evidence_candidate;
  if (!legacy || !isRecord(origin) || !externalEvidenceSourceMatchesMemory(legacy, "computer_history")
    || origin.groupId !== groupId || origin.revision !== revision) return { key, memory: canonical };
  if (legacy.status === "deleted" || legacy.deletedAt) return { key: legacyKey, memory: legacy };
  return canonical ? { key, memory: canonical } : { key: legacyKey, memory: legacy };
}

function isLegacyHistoryEvidence(memory: MemoryRow | undefined, sourceRecordId: string): boolean {
  if (!memory || kindFromMemory(memory) !== "observed_activity") return false;
  const origin = memory.properties.internal_info.external_evidence;
  if (!isRecord(origin) || !externalEvidenceSourcesMatch(origin.source, "computer_history")
    || origin.sourceRecordId !== sourceRecordId) return false;
  const provenance = origin.provenance;
  return (isRecord(provenance) && provenance.historyId === sourceRecordId)
    || isHistoryRecordId(sourceRecordId);
}

function isHistoryRecordId(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z?-(?:10min|6h)-summary$/u.test(value);
}

function isHistorySkillOrigin(origin: Record<string, unknown>): boolean {
  return Array.isArray(origin.sourceRecordIds) && origin.sourceRecordIds.every(isHistoryRecordId)
    && new Set(origin.sourceRecordIds).size >= 2;
}
