import { policyMetaFromMemory, traceMetaFromMemory, type PolicyMemoryMeta, type TraceMemoryMeta } from "../../algorithm/plugin-algorithms.js";
import type { Repositories } from "../../storage/repositories.js";
import type { MemoryRow } from "../../types.js";
import { isRecord } from "../../utils/json.js";
import { l2ContentRevision, l2SupportRelation } from "./l2-content-revision.js";

/** Evidence semantics belong to the stored lesson, never to today's extraction mode. */
export function policyUsesSpecialEvidence(policy: PolicyMemoryMeta): boolean {
  const raw = policy.memory.properties.internal_info.policy;
  return policy.schemaVersion === 2 || policy.sourceFeedbackIds.length > 0
    || (isRecord(raw) && Array.isArray(raw.special_source_trace_ids) && raw.special_source_trace_ids.length > 0)
    || ["failure_avoidance", "repair_instruction", "preference", "verifier_feedback"].includes(policy.experienceType);
}

/** Old associations support only the original, old-format lesson content. */
export function isCurrentPolicySupport(memory: MemoryRow, relation: string): boolean {
  const policy = policyMetaFromMemory(memory);
  if (!policy) return false;
  if (relation === l2SupportRelation(memory)) return true;
  return policy.schemaVersion !== 2 && l2ContentRevision(memory) === 1
    && (relation === "matches_signature" || relation === "similar_pattern");
}

export function isCurrentPolicyEvidence(repos: Repositories, trace: TraceMemoryMeta,
  policy: PolicyMemoryMeta, successEligible: (trace: TraceMemoryMeta) => boolean): boolean {
  if (trace.userId !== policy.memory.userId || trace.memory.deletedAt || trace.memory.status !== "activated") return false;
  const raw = trace.rawTurnId ? repos.runtime.getRawTurn(trace.rawTurnId) : undefined;
  if (raw && (raw.deletedAt || raw.redactedAt || raw.userId !== trace.userId)) return false;
  if (!policyUsesSpecialEvidence(policy)) return successEligible(trace);
  const info = trace.memory.properties.internal_info;
  return info.evidence_status !== "provisional" && info.evidence_status !== "disputed";
}

/** Shared by scoring, governance, and restart reconciliation. Keep withdrawn links for recovery. */
export function policyEvidenceSnapshot(repos: Repositories, memory: MemoryRow,
  successEligible: (trace: TraceMemoryMeta) => boolean) {
  const policy = policyMetaFromMemory(memory)!;
  const links = repos.runtime.listTracePolicyLinks({ l2MemoryId: policy.id, limit: -1 });
  const linkedTraceIds = new Set(links.filter(link => link.userId === memory.userId
    && isCurrentPolicySupport(memory, link.relation)).map(link => link.l1MemoryId));
  const candidates = new Set([...policy.sourceTraceIds, ...linkedTraceIds]);
  const validTraces = repos.memories.getMany([...candidates]).map(traceMetaFromMemory)
    .filter((trace): trace is TraceMemoryMeta => Boolean(trace && isCurrentPolicyEvidence(repos, trace, policy, successEligible)));
  return { links, linkedTraceIds, validTraces };
}
