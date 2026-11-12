import { randomUUID } from "node:crypto";
import { traceMetaFromMemory } from "../../algorithm/plugin-algorithms.js";
import type { EpisodeRecord, EvolutionJobRecord, Repositories } from "../../storage/repositories.js";
import type { MemoryRow } from "../../types.js";
import { DEVICE_MEMORY_OWNER } from "../namespace/memory-owner.js";
import type { EnqueueJobInput } from "../worker/job-handlers.js";
import { episodeInputRevision } from "./episode-revision.js";
import { listL2Candidates } from "./l2-candidate-service.js";
import { L2ExtractionExhaustedError } from "./l2-extraction-contract.js";
import { traceOriginIsCurrent } from "./policy-evidence.js";

export interface L2ProcessingState {
  episodeId: string;
  state: "complete" | "pending" | "queued" | "running" | "failed" | "blocked";
  pendingCount: number;
  canRetry: boolean;
  jobId?: string;
  errorCode?: "invalid_model_output" | "model_or_processing_failed" | "task_changed";
}

/** IDs in a task are not enough to bridge owners: require current raw/session provenance.
 * Same-owner source-free history retains its established compatibility path. */
function recoverySources(repos: Repositories, episode: EpisodeRecord): Map<string, MemoryRow> {
  const sources = new Map<string, MemoryRow>();
  for (const id of episode.l1MemoryIds) {
    const memory = repos.memories.get(id);
    const trace = memory && traceMetaFromMemory(memory);
    if (!memory || !trace || memory.memoryLayer !== "L1" || memory.deletedAt
      || !["activated", "resolving"].includes(memory.status)
      || ["provisional", "disputed"].includes(String(memory.properties.internal_info.evidence_status))
      || (memory.userId !== episode.userId && memory.userId !== DEVICE_MEMORY_OWNER && episode.userId !== DEVICE_MEMORY_OWNER)
      || !traceOriginIsCurrent(repos, trace)) continue;
    const origin = repos.runtime.resolveL1Source(id);
    if (origin?.episodeId !== episode.id || (memory.sessionId && memory.sessionId !== episode.sessionId)
      || (memory.userId !== episode.userId && !origin.rawTurnId)) continue;
    sources.set(id, memory);
  }
  return sources;
}

/** Returns the recovery's source allowlist for the worker. Legacy queued recoveries
 * have no list, but still have to prove every source and their original task owner. */
export function assertL2RecoveryCurrent(repos: Repositories, job: EvolutionJobRecord): ReadonlySet<string> | undefined {
  if (typeof job.payload.l2RecoveryId !== "string") return undefined;
  const episode = repos.runtime.getEpisode(job.episodeId);
  const stale = () => new L2ExtractionExhaustedError(undefined, "task changed during experience recovery; pending evidence retained");
  if (!episode || episode.status !== "closed" || (job.sessionId && job.sessionId !== episode.sessionId)
    || job.payload.l2RecoveryRevision !== episodeInputRevision(repos, episode.id, true)) throw stale();
  const sources = recoverySources(repos, episode);
  const saved = job.payload.l2RecoverySourceIds;
  if (saved !== undefined && (!Array.isArray(saved) || !saved.length || saved.some(id => typeof id !== "string"))) throw stale();
  if (saved === undefined && job.userId !== episode.userId) throw stale();
  const ids = new Set<string>(saved as string[] | undefined
    ?? [...sources.values()].filter(memory => memory.userId === job.userId).map(memory => memory.id));
  if (!ids.size || [...ids].some(id => sources.get(id)?.userId !== job.userId)
    || (job.targetMemoryId && !ids.has(job.targetMemoryId))
    || (typeof job.payload.sourceMemoryId === "string" && !ids.has(job.payload.sourceMemoryId))) throw stale();
  return ids;
}

function pendingCandidates(repos: Repositories, episode: EpisodeRecord, sources = recoverySources(repos, episode)) {
  const owners = [...new Set([...sources.values()].map(memory => memory.userId))];
  return owners.flatMap(userId => repos.runtime.listUnifiedL2Candidates({userId, episodeId:episode.id})
    .filter(candidate => sources.get(candidate.sourceMemoryId)?.userId === candidate.userId));
}

/** Read-only: opening the detail drawer must never refresh or mutate candidate rows. */
export function l2ProcessingState(repos: Repositories, episode: EpisodeRecord, enabled: boolean): L2ProcessingState {
  const sources = recoverySources(repos, episode);
  const pending = pendingCandidates(repos, episode, sources);
  const base = { episodeId: episode.id, pendingCount: pending.length, canRetry: false };
  if (!enabled || episode.status !== "closed") return { ...base, state: "blocked" };
  if (!pending.length) return { ...base, state: "complete" };
  const jobs = [...new Set(pending.map(candidate => candidate.userId))]
    .flatMap(owner => repos.runtime.listL2JobsForEpisode(owner, episode.id))
    .filter(job => (!job.sessionId || job.sessionId === episode.sessionId)
      && (!job.targetMemoryId || sources.get(job.targetMemoryId)?.userId === job.userId));
  const active = jobs.find(job => job.status === "leased") ?? jobs.find(job => ["queued", "failed"].includes(job.status));
  if (active) return { ...base, state: active.status === "leased" ? "running" : "queued", jobId: active.id };
  const failed = jobs.find(job => job.status === "dead_letter");
  return { ...base, state: failed ? "failed" : "pending", canRetry: true,
    ...(failed ? { jobId: failed.id, errorCode: /changed during|^l2 revision: stale target|task changed/.test(failed.lastError ?? "")
      ? "task_changed" as const : /l2 extraction:|l2 revision:/.test(failed.lastError ?? "")
      ? "invalid_model_output" as const : "model_or_processing_failed" as const } : {}) };
}

export function retryL2Extraction(deps: {
  repos: Repositories;
  enabled: boolean;
  enqueueJob(input: EnqueueJobInput): EvolutionJobRecord;
}, episode: EpisodeRecord, at: string): L2ProcessingState & { accepted: boolean } {
  return deps.repos.transaction(() => {
    const current = deps.repos.runtime.getEpisode(episode.id)!;
    const before = l2ProcessingState(deps.repos, current, deps.enabled);
    if (!before.canRetry) return { ...before, accepted: false };
    // Refresh only proven task sources, retaining each candidate's persisted owner.
    const pending = pendingCandidates(deps.repos, current);
    const recoveryId = randomUUID();
    const revision = episodeInputRevision(deps.repos, current.id, true);
    const jobs: EvolutionJobRecord[] = [];
    for (const owner of [...new Set(pending.map(candidate => candidate.userId))]) {
      const sourceMemoryIds = new Set(pending.filter(candidate => candidate.userId === owner).map(candidate => candidate.sourceMemoryId));
      const candidates = listL2Candidates(deps.repos, { userId: owner, episodeId: current.id, sourceMemoryIds });
      if (!candidates.length) continue;
      jobs.push(deps.enqueueJob({ jobType: "l2_induction", userId: owner,
        sessionId: current.sessionId, episodeId: current.id, targetMemoryId: candidates[0]!.sourceMemoryId,
        dedupeKey: `l2.recovery:${current.id}:${owner}:${recoveryId}`, createdAt: at,
        payload: { unified: true, l2RecoveryId: recoveryId, l2RecoveryRevision: revision,
          l2RecoverySourceIds: candidates.map(candidate => candidate.sourceMemoryId),
          sourceMemoryId: candidates[0]!.sourceMemoryId, reason: "manual_experience_recovery" } }));
    }
    if (!jobs.length) return { ...l2ProcessingState(deps.repos, current, deps.enabled), accepted: false };
    return { ...before, state: "queued", canRetry: false, accepted: true, jobId: jobs[0]!.id };
  });
}
