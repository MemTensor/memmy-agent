import type { EpisodeRecord, Repositories } from "../../storage/repositories.js";
import { createHash } from "node:crypto";
import { canonicalJson } from "../../contracts/memory-canonical-json.js";
import { traceMetaFromMemory } from "../../algorithm/plugin-algorithms.js";

/** Lossless versioning of stored JSON inputs; display/logging truncation cannot define identity. */
export function revisionInputHash(value: unknown): string {
  const json = JSON.parse(JSON.stringify(value) ?? "null");
  return createHash("sha256").update(canonicalJson(json)).digest("hex");
}

/** A reopen invalidates in-flight work even when the task closes again. */
export function episodeGeneration(episode: EpisodeRecord): number {
  const value = episode.meta.processingGeneration;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Inputs only: reward outputs, timestamps and worker bookkeeping are excluded. */
export function episodeRewardInputVersion(repos: Repositories, episode: EpisodeRecord): string {
  return revisionInputHash({
    episode: {
      id: episode.id, userId: episode.userId, sessionId: episode.sessionId,
      projectId: episode.projectId, title: episode.title, summary: episode.summary,
      generation: episodeGeneration(episode),
      canonicalGoal: episode.meta.canonicalGoal, initialUserText: episode.meta.initialUserText,
      rawTurnIds: episode.rawTurnIds, l1MemoryIds: episode.l1MemoryIds,
      feedbackIds: episode.feedbackIds
    },
    turns: repos.runtime.listRawTurnsByEpisode(episode.id, Number.MAX_SAFE_INTEGER).map(turn => {
      return { id: turn.id, episodeId: turn.episodeId, userId: turn.userId,
        userText: turn.userText, assistantText: turn.assistantText,
        reasoningSummary: turn.reasoningSummary, toolCalls: turn.toolCalls, toolResults: turn.toolResults,
        status: turn.status, deletedAt: turn.deletedAt, redactedAt: turn.redactedAt };
    }),
    traces: repos.memories.getMany(episode.l1MemoryIds).map(memory => {
      const trace = traceMetaFromMemory(memory);
      return { id: memory.id, userId: memory.userId, status: memory.status, deletedAt: memory.deletedAt,
        projectId: memory.info.project_id, profileId: memory.info.profile_id,
        summary: trace?.summary, userText: trace?.userText, agentText: trace?.agentText,
        toolCalls: trace?.toolCalls, reflection: trace?.reflection, ts: trace?.ts };
    }),
    feedback: episode.feedbackIds.map(id => repos.runtime.getFeedback(id) ?? { id, missing: true })
  });
}

export function rewardInputIsCurrent(repos: Repositories, episodeId: string, version: string): boolean {
  const current = repos.runtime.getEpisode(episodeId);
  return Boolean(current && current.status === "closed" && episodeRewardInputVersion(repos, current) === version);
}
