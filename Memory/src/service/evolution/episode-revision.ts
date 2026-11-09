// Contribution identity/replay adapted from yxyi123, PR #740 (660b3b9c).
import type { EvolutionJobRecord, Repositories } from "../../storage/repositories.js";
import { createHash } from "node:crypto";

/** Content identity, deliberately excluding derived scores, timestamps and job IDs. */
export function episodeInputRevision(repos: Pick<Repositories, "memories" | "runtime">, episodeId: string, includeReward = false): string {
  const episode = repos.runtime.getEpisode(episodeId);
  if (!episode) return "missing";
  return createHash("sha256").update(JSON.stringify({
    generation: episode.meta.processingGeneration ?? 0,
    status: episode.status,
    mission: episode.meta.canonicalGoal ?? episode.meta.initialUserText,
    turns: repos.runtime.listRawTurnsByEpisode(episodeId, -1),
    traces: episode.l1MemoryIds.map(id => {
      const memory = repos.memories.get(id);
      return memory && { id, status: memory.status,
        trace: memory.properties.internal_info.trace };
    }).map(memory => memory && { ...memory, trace: scoringTraceInput(memory.trace) }),
    feedback: episode.feedbackIds.map(id => repos.runtime.getFeedback(id)),
    ...(includeReward ? { rTask: episode.rTask, rewardDetail: episode.rewardDetail } : {})
  })).digest("hex");
}

function scoringTraceInput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  // alpha is a derived weight the reward write itself rewrites, so including it would make the
  // revision move underneath jobs enqueued earlier in the same reward pass.
  const { value: _value, priority: _priority, alpha: _alpha, r_human: _reward, reward_reason: _reason,
    source_feedback_id: _feedback, source_feedback_ids: _feedbacks, updated_at: _at, span_ids: _spans, ...input } = value as Record<string, unknown>;
  return input;
}

export const REVISIONED_JOBS = new Set([
  "reward", "negative_experience", "span_big_turn", "l2_association", "l2_induction", "skill_cluster_assign"
]);

export function jobEpisodeRevision(repos: Pick<Repositories, "memories" | "runtime">, job: Pick<EvolutionJobRecord, "episodeId" | "jobType"> & { payload?: Record<string, unknown> }): string | undefined {
  // Unified extraction loads durable candidate versions at execution and validates
  // them before committing. Episode changes must not drop pending explicit feedback.
  if (job.jobType === "l2_induction" && job.payload?.unified === true) return undefined;
  return job.episodeId && REVISIONED_JOBS.has(job.jobType)
    ? episodeInputRevision(repos, job.episodeId, job.jobType !== "reward" || job.payload?.afterRewardRepair === true)
    : undefined;
}

export function jobRevisionIsCurrent(repos: Pick<Repositories, "memories" | "runtime">, job: EvolutionJobRecord): boolean {
  if (job.jobType === "l2_induction" && job.payload.unified === true) return true;
  // Explicit feedback and repair events survive an Episode lifecycle transition.
  // Their worker re-reads current context and retries if that context changes while generating.
  if (job.jobType === "negative_experience" && job.payload.source !== "episode_reward") return true;
  // Reflection can finish between enqueue and execution. Both reward phases read
  // the latest inputs at start, then verify that captured snapshot before writing.
  if (job.jobType === "reward" && job.payload.afterRewardRepair !== true && job.episodeId && typeof job.payload.episodeGeneration === "number") {
    const episode = repos.runtime.getEpisode(job.episodeId);
    return Boolean(episode && (episode.meta.processingGeneration ?? 0) === job.payload.episodeGeneration);
  }
  return typeof job.payload.episodeRevision !== "string"
    || job.payload.episodeRevision === jobEpisodeRevision(repos, job);
}
