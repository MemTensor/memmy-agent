import { policyMetaFromMemory, traceMetaFromMemory, type PolicyMemoryMeta, type TraceMemoryMeta } from "../../algorithm/plugin-algorithms.js";
import type { Repositories } from "../../storage/repositories.js";
import type { MemoryRow } from "../../types.js";
import { isRecord } from "../../utils/json.js";
import { DEVICE_MEMORY_OWNER } from "../namespace/memory-owner.js";
import { l2SharesComparisonScope } from "./l2-comparison-scope.js";
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

/** Validate declared raw provenance using the same rules as capture/migration. UID
 * alone is not a local source boundary; legacy source-free evidence stays valid. */
export function traceOriginIsCurrent(repos: Repositories, trace: TraceMemoryMeta): boolean {
  const internal = trace.memory.properties.internal_info;
  const metadata = isRecord(internal.trace) ? internal.trace : {};
  const rawId = [internal.source_raw_turn_id, internal.raw_turn_id, metadata.raw_turn_id, trace.memory.info.raw_turn_id]
    .find(value => value != null && value !== "");
  if (rawId === undefined) return true;
  const source = repos.runtime.resolveL1Source(trace.id);
  if (!source || source.rawTurnId !== rawId || source.episodeId !== trace.episodeId) return false;
  const raw = repos.runtime.getRawTurn(source.rawTurnId);
  if (!raw) return false;
  const session = repos.runtime.getSession(raw.sessionId);
  const episode = source.episodeId ? repos.runtime.getEpisode(source.episodeId) : undefined;
  // Retained raw turns may own a new device L1. Preserve that bridge through the
  // actual source/session/task, but never borrow an unrelated historical UID.
  return raw.userId === DEVICE_MEMORY_OWNER || raw.userId === trace.userId
    || raw.userId === session?.userId || raw.userId === episode?.userId;
}

type SupportLinks = ReturnType<Repositories["runtime"]["listTracePolicyLinks"]>;

/** Retain accepted ownership even when the source's verdict becomes invalid.
 * Cross-owner IDs alone never create trust: require a current attributed link. */
export function isTrustedPolicySource(repos: Repositories, source: MemoryRow, policy: MemoryRow,
  links: SupportLinks = repos.runtime.listTracePolicyLinks({ l2MemoryId: policy.id, limit: -1 })): boolean {
  if (source.memoryLayer !== "L1" || !l2SharesComparisonScope(source, policy)) return false;
  const meta = policyMetaFromMemory(policy);
  if (!meta) return false;
  return (source.userId === policy.userId && meta.sourceTraceIds.includes(source.id))
    || links.some(link => link.l1MemoryId === source.id && link.l2MemoryId === policy.id
      && link.userId === source.userId && isCurrentPolicySupport(policy, link.relation));
}

export function isCurrentPolicyEvidence(repos: Repositories, trace: TraceMemoryMeta,
  policy: PolicyMemoryMeta, successEligible: (trace: TraceMemoryMeta) => boolean): boolean {
  if (!isTrustedPolicySource(repos, trace.memory, policy.memory)
    || trace.memory.deletedAt || trace.memory.status !== "activated" || !traceOriginIsCurrent(repos, trace)) return false;
  if (!policyUsesSpecialEvidence(policy)) return successEligible(trace);
  const info = trace.memory.properties.internal_info;
  return info.evidence_status !== "provisional" && info.evidence_status !== "disputed";
}

/** Shared by scoring, governance, and restart reconciliation. Keep withdrawn links for recovery. */
export function policyEvidenceSnapshot(repos: Repositories, memory: MemoryRow,
  successEligible: (trace: TraceMemoryMeta) => boolean) {
  const policy = policyMetaFromMemory(memory)!;
  const links = repos.runtime.listTracePolicyLinks({ l2MemoryId: policy.id, limit: -1 });
  const candidates = new Set([...policy.sourceTraceIds,
    ...links.filter(link => isCurrentPolicySupport(memory, link.relation)).map(link => link.l1MemoryId)]);
  const sourceTraces = repos.memories.getMany([...candidates]).map(traceMetaFromMemory)
    .filter((trace): trace is TraceMemoryMeta => Boolean(trace && isTrustedPolicySource(repos, trace.memory, memory, links)));
  const linkedTraceIds = new Set(sourceTraces.filter(trace => links.some(link => link.l1MemoryId === trace.id
    && link.userId === trace.userId && isCurrentPolicySupport(memory, link.relation))).map(trace => trace.id));
  const validTraces = sourceTraces.filter(trace => isCurrentPolicyEvidence(repos, trace, policy, successEligible));
  return { links, linkedTraceIds, sourceTraces, validTraces };
}

/** Discovery must use the same ownership proof as computation, including on withdrawal. */
export function policiesDependingOnTrace(repos: Repositories, source: MemoryRow): MemoryRow[] {
  const ids = new Set([
    ...repos.memories.listByDerivedSource(source.userId, "L2", source.id, true).map(policy => policy.id),
    ...repos.runtime.listTracePolicyLinks({ l1MemoryId: source.id, limit: -1 }).map(link => link.l2MemoryId)
  ]);
  return repos.memories.getMany([...ids]).filter(policy => !policy.deletedAt
    && policy.memoryLayer === "L2" && isTrustedPolicySource(repos, source, policy));
}

/** Complete context of an accepted task, without a global newest-record limit.
 * Historical/device neighbours need real turn provenance, not only an episode ID. */
export function traceEpisodeContext(repos: Repositories, source: TraceMemoryMeta): TraceMemoryMeta[] {
  const candidates = [source, ...(source.episodeId
    ? repos.memories.listTracesForEpisodes(source.userId, [source.episodeId], true)
      .map(traceMetaFromMemory).filter((trace): trace is TraceMemoryMeta => Boolean(trace)) : [])];
  return candidates.filter(trace => {
    if (!l2SharesComparisonScope(source.memory, trace.memory) || trace.memory.deletedAt
      || trace.memory.status !== "activated" || !traceOriginIsCurrent(repos, trace)) return false;
    if (trace.userId === source.userId) return true;
    const origin = repos.runtime.resolveL1Source(trace.id);
    return Boolean(origin?.rawTurnId && source.episodeId && origin.episodeId === source.episodeId);
  });
}
