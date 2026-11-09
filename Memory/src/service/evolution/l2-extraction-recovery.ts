import { randomUUID } from "node:crypto";
import { traceMetaFromMemory } from "../../algorithm/plugin-algorithms.js";
import type { EpisodeRecord, EvolutionJobRecord, Repositories } from "../../storage/repositories.js";
import type { EnqueueJobInput } from "../worker/job-handlers.js";
import { episodeInputRevision } from "./episode-revision.js";
import { listL2Candidates } from "./l2-candidate-service.js";
import { L2ExtractionExhaustedError } from "./l2-extraction-contract.js";

export interface L2ProcessingState {
  episodeId: string;
  state: "complete" | "pending" | "queued" | "running" | "failed" | "blocked";
  pendingCount: number;
  canRetry: boolean;
  jobId?: string;
  errorCode?: "invalid_model_output" | "model_or_processing_failed" | "task_changed";
}

export function assertL2RecoveryCurrent(repos: Repositories, job: EvolutionJobRecord): void {
  if (typeof job.payload.l2RecoveryId !== "string") return;
  const episode = repos.runtime.getEpisode(job.episodeId);
  if (!episode || episode.userId !== job.userId || episode.status !== "closed"
    || job.payload.l2RecoveryRevision !== episodeInputRevision(repos, episode.id, true)) {
    throw new L2ExtractionExhaustedError(undefined, "task changed during experience recovery; pending evidence retained");
  }
}

/** Read-only: opening the detail drawer must never refresh or mutate candidate rows. */
export function l2ProcessingState(repos: Repositories, episode: EpisodeRecord, enabled: boolean): L2ProcessingState {
  const pending = repos.runtime.listUnifiedL2Candidates({ userId: episode.userId, episodeId: episode.id }).filter(candidate => {
    const source = repos.memories.get(candidate.sourceMemoryId);
    return source && source.userId === episode.userId && !source.deletedAt
      && ["activated", "resolving"].includes(source.status) && source.memoryLayer === "L1"
      && traceMetaFromMemory(source)?.episodeId === episode.id;
  });
  const base = { episodeId: episode.id, pendingCount: pending.length, canRetry: false };
  if (!enabled || episode.status !== "closed") return { ...base, state: "blocked" };
  if (!pending.length) return { ...base, state: "complete" };
  const jobs = repos.runtime.listL2JobsForEpisode(episode.userId, episode.id);
  const active = jobs.find(job => ["queued", "leased", "failed"].includes(job.status));
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
    // Re-read current evidence; do not copy the failed job's stale target list/response.
    const candidates = listL2Candidates(deps.repos, { userId: current.userId, episodeId: current.id });
    if (!candidates.length) return { ...l2ProcessingState(deps.repos, current, deps.enabled), accepted: false };
    const recoveryId = randomUUID();
    const job = deps.enqueueJob({ jobType: "l2_induction", userId: current.userId,
      sessionId: current.sessionId, episodeId: current.id, targetMemoryId: candidates[0]!.sourceMemoryId,
      dedupeKey: `l2.recovery:${current.id}:${recoveryId}`, createdAt: at,
      payload: { unified: true, l2RecoveryId: recoveryId, l2RecoveryRevision: episodeInputRevision(deps.repos, current.id, true),
        sourceMemoryId: candidates[0]!.sourceMemoryId, reason: "manual_experience_recovery" } });
    return { ...before, state: "queued", canRetry: false, accepted: true, jobId: job.id };
  });
}
