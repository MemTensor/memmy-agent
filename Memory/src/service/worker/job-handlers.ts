/**
 * Worker job routing and durable write-back helpers.
 *
 * This module deliberately does not import MemoryService.  Callers bind the
 * concrete evolution, feedback, import, and embedding implementations through
 * WorkerJobHandlerDeps, keeping the worker orchestration independently testable.
 */
import type {
  EmbeddingRetryRecord,
  EmbeddingRetryVectorField,
  EpisodeRecord,
  EvolutionJobRecord,
  Repositories,
  SessionRecord
} from "../../storage/repositories.js";
import type { JobType,MemoryRow,RuntimeNamespace } from "../../types.js";
import { newId,stableHash } from "../../utils/id.js";
import { clip } from "../../utils/text.js";
import {
  embeddingRetryTargetKindForMemory,
  embeddingRetryVectorFieldForMemory
} from "../embedding/embedding-pipeline.js";
import { memoryHasImportPipeline } from "../import/import-job-processor.js";
import {
  namespaceForMemory,
  namespaceForSession
} from "../namespace/namespace-scope.js";

export type ProcessingStage = "summary" | "embedding";
export const EPISODE_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export type JobChangeOperation = "queued" | "leased" | "succeeded" | "failed" | "dead_letter";
export type EmbeddingRetryChangeOperation = "queued" | "retry" | "succeeded" | "failed";
export type ClosedEpisodeTrigger = "topic_boundary" | "session_closed" | "episode_rewarded" | "idle_timeout";

export interface EnqueueJobInput {
  jobType: JobType;
  userId: string;
  sessionId?: string;
  episodeId?: string;
  targetMemoryId?: string;
  dedupeKey?: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  createdAt?: string;
}

type MaybePromise<T> = T | Promise<T>;

/**
 * Job-specific work stays outside this module.  Supplying these callbacks makes
 * the former MemoryService method calls explicit and prevents a service import
 * cycle while retaining the exact job-type dispatch contract.
 */
export interface WorkerJobProcessors {
  import: {
    summarizeCapturedTrace(job: EvolutionJobRecord): MaybePromise<void>;
    summarizeImportedTrace(job: EvolutionJobRecord): MaybePromise<void>;
  };
  evolution: {
    induceL2(job: EvolutionJobRecord): MaybePromise<void>;
    abstractL3(job: EvolutionJobRecord): MaybePromise<void>;
    crystallizeSkill(job: EvolutionJobRecord): MaybePromise<void>;
    associateL2(job: EvolutionJobRecord): MaybePromise<void>;
  };
  feedback: {
    applyReward(job: EvolutionJobRecord): MaybePromise<void>;
    reflectTrace(job: EvolutionJobRecord): MaybePromise<void>;
    resolveSkillTrial(job: EvolutionJobRecord): MaybePromise<void>;
  };
  embedding: {
    embedMemory(job: EvolutionJobRecord): MaybePromise<void>;
  };
}

export interface WorkerJobHandlerDeps {
  repos: Pick<Repositories, "transaction" | "memories" | "processing" | "runtime">;
  capture: { synthReflection: boolean };
  reward: { feedbackWindowSec: number };
  nowIso(): string;
  requireSession(id: string): SessionRecord;
  feedbackTargetFromEpisode(episode: EpisodeRecord): MemoryRow | undefined;
  traceReflectionWasScored(memory: MemoryRow): boolean;
  traceSortKey(memory: MemoryRow): number;
  processors: WorkerJobProcessors;
}

/** Directly append the same change-log record previously written by MemoryService. */
export function appendJobChange(
  deps: WorkerJobHandlerDeps,
  job: EvolutionJobRecord,
  op: JobChangeOperation,
  before?: EvolutionJobRecord
): void {
  const session = job.sessionId ? deps.repos.runtime.getSession(job.sessionId) : undefined;
  deps.repos.runtime.appendChange({
    memoryId: job.id,
    namespaceId: session ? namespaceIdFromSession(session) : undefined,
    userId: job.userId,
    kind: "job",
    op,
    entityId: job.id,
    changeType: `job_${op}`,
    before,
    after: job,
    source: "worker.evolution_jobs",
    createdAt: job.updatedAt
  });
}

/** Directly append an embedding-retry queue change, including optional model error metadata. */
export function appendEmbeddingRetryChange(
  deps: WorkerJobHandlerDeps,
  retry: EmbeddingRetryRecord,
  op: EmbeddingRetryChangeOperation,
  before?: EmbeddingRetryRecord,
  error?: { code: string; message: string }
): void {
  const memory = deps.repos.memories.get(retry.targetId);
  deps.repos.runtime.appendChange({
    memoryId: retry.id,
    namespaceId: memory ? namespaceIdFromMemory(memory) : undefined,
    userId: memory?.userId ?? "system",
    kind: "job",
    op: `embedding_${op}`,
    entityId: retry.id,
    changeType: `embedding_retry_${op}`,
    before,
    after: error ? { ...retry, error } : retry,
    source: "worker.embedding_retry",
    createdAt: new Date(retry.updatedAt).toISOString()
  });
}

/** Directly append an episode lifecycle change. */
export function appendEpisodeChange(
  deps: WorkerJobHandlerDeps,
  episode: EpisodeRecord,
  input: {
    before?: EpisodeRecord;
    session?: SessionRecord;
    source: string;
    createdAt: string;
    changeType?: string;
    op?: string;
  }
): void {
  const session = input.session ?? deps.requireSession(episode.sessionId);
  deps.repos.runtime.appendChange({
    memoryId: episode.id,
    namespaceId: namespaceIdFromSession(session),
    kind: "episode",
    op: input.op ?? "updated",
    entityId: episode.id,
    userId: episode.userId,
    changeType: input.changeType ?? "episode_closed",
    before: input.before,
    after: episode,
    source: input.source,
    createdAt: input.createdAt
  });
}

/** Queue (or refresh) the durable retry record used after an asynchronous embedding failure. */
export function enqueueEmbeddingRetry(
  deps: WorkerJobHandlerDeps,
  memory: MemoryRow,
  sourceText: string,
  at: string,
  vectorField = embeddingRetryVectorFieldForMemory(memory)
): EmbeddingRetryRecord {
  return deps.repos.runtime.enqueueEmbeddingRetry({
    targetKind: embeddingRetryTargetKindForMemory(memory),
    targetId: memory.id,
    vectorField,
    sourceText,
    embedRole: memory.memoryLayer === "L1" ? "document" : "query",
    now: Date.parse(at)
  });
}

/** Queue a worker job and immediately publish its queued change record. */
export function enqueueJob(
  deps: WorkerJobHandlerDeps,
  input: EnqueueJobInput
): EvolutionJobRecord {
  const at = input.createdAt ?? deps.nowIso();
  const job = deps.repos.runtime.enqueueJob({
    id: newId("job"),
    jobType: input.jobType,
    status: "queued",
    dedupeKey: input.dedupeKey ?? evolutionJobDedupeKey(input),
    userId: input.userId,
    sessionId: input.sessionId,
    episodeId: input.episodeId,
    targetMemoryId: input.targetMemoryId,
    payload: input.payload ?? {},
    attempts: 0,
    maxAttempts: input.maxAttempts ?? 3,
    createdAt: at,
    updatedAt: at
  });
  appendJobChange(deps, job, "queued");
  return job;
}

/** Route one leased worker job to a host-provided implementation. */
export async function processJob(
  deps: WorkerJobHandlerDeps,
  job: EvolutionJobRecord
): Promise<void> {
  switch (job.jobType) {
    case "episode_idle_close":
      closeIdleEpisodesForMemoryWrite(deps, job);
      return;
    case "trace_summary":
      await deps.processors.import.summarizeCapturedTrace(job);
      return;
    case "import_summary":
      await deps.processors.import.summarizeImportedTrace(job);
      return;
    case "l2_induction":
      await deps.processors.evolution.induceL2(job);
      return;
    case "l3_abstraction":
      await deps.processors.evolution.abstractL3(job);
      return;
    case "skill_crystallization":
      await deps.processors.evolution.crystallizeSkill(job);
      return;
    case "reward":
      await deps.processors.feedback.applyReward(job);
      return;
    case "embedding":
      await deps.processors.embedding.embedMemory(job);
      return;
    case "reflection":
      await deps.processors.feedback.reflectTrace(job);
      return;
    case "skill_trial_resolve":
      await deps.processors.feedback.resolveSkillTrial(job);
      return;
    case "l2_association":
      await deps.processors.evolution.associateL2(job);
      return;
    default:
      throw new Error(`unsupported job type: ${job.jobType}`);
  }
}

/** Close every other inactive episode, publish its change, and finalize its follow-on work. */
export function closeIdleEpisodesForMemoryWrite(
  deps: WorkerJobHandlerDeps,
  job: EvolutionJobRecord
): void {
  const triggerEpisodeId = typeof job.payload.triggerEpisodeId === "string"
    ? job.payload.triggerEpisodeId
    : job.episodeId;
  const triggerMemoryId = typeof job.payload.triggerMemoryId === "string"
    ? job.payload.triggerMemoryId
    : undefined;
  const triggerSource = typeof job.payload.triggerSource === "string"
    ? job.payload.triggerSource
    : "turn.complete";
  const triggeredAt = typeof job.payload.triggeredAt === "string"
    ? job.payload.triggeredAt
    : job.createdAt;
  const triggeredAtMs = Date.parse(triggeredAt);
  if ((!triggerEpisodeId && !triggerMemoryId) || !Number.isFinite(triggeredAtMs)) {
    throw new Error(`invalid episode idle close job: ${job.id}`);
  }

  const inactiveBefore = new Date(triggeredAtMs - EPISODE_IDLE_TIMEOUT_MS).toISOString();
  const closedAt = deps.nowIso();
  deps.repos.transaction(() => {
    const episodes = deps.repos.runtime.listIdleEpisodes(triggerEpisodeId, inactiveBefore);
    for (const episode of episodes) {
      // Keep the original ordering: a missing session prevents the close.
      const session = deps.requireSession(episode.sessionId);
      const closed = deps.repos.runtime.closeEpisode(episode.id, {
        closeReason: "idle_timeout",
        closedBy: "worker.episode_idle_close",
        idleTimeoutMs: EPISODE_IDLE_TIMEOUT_MS,
        triggeredAt,
        triggerSource,
        ...(triggerEpisodeId ? { triggerEpisodeId } : {}),
        ...(triggerMemoryId ? { triggerMemoryId } : {})
      }, closedAt);
      if (!closed) continue;
      appendEpisodeChange(deps, closed, {
        before: episode,
        session,
        source: "worker.episode_idle_close",
        createdAt: closedAt
      });
      finalizeClosedEpisode(deps, closed, closedAt, "idle_timeout");
    }
  });
}

export function finalizeClosedEpisode(
  deps: WorkerJobHandlerDeps,
  episode: EpisodeRecord,
  at: string,
  trigger: ClosedEpisodeTrigger
): EvolutionJobRecord[] {
  const current = deps.repos.runtime.getEpisode(episode.id) ?? episode;
  if (current.status !== "closed" || current.l1MemoryIds.length === 0) return [];
  if (episodeRewardWasSkipped(current)) return [];
  const reflectionJobs = enqueueEpisodeReflection(deps, current, at, trigger);
  if (reflectionJobs.length > 0) return reflectionJobs;
  if (episodeHasRewardForReflection(current)) return [];
  return enqueueEpisodeRewardAfterReflection(deps, current, at, trigger);
}

export function enqueueEpisodeRewardAfterReflection(
  deps: WorkerJobHandlerDeps,
  episode: EpisodeRecord,
  at: string,
  trigger: string
): EvolutionJobRecord[] {
  if (
    episode.status !== "closed" ||
    episodeHasRewardForReflection(episode) ||
    episodeRewardWasSkipped(episode) ||
    deps.repos.runtime.hasEpisodeJob(episode.id, "reward", ["queued", "leased", "failed"])
  ) return [];
  const target = deps.feedbackTargetFromEpisode(episode);
  if (!target) return [];
  const feedbackWindowSec = Math.max(1, deps.reward.feedbackWindowSec);
  const runAfter = new Date(Date.parse(at) + feedbackWindowSec * 1000).toISOString();
  return [enqueueJob(deps, {
    jobType: "reward",
    userId: episode.userId,
    sessionId: episode.sessionId,
    episodeId: episode.id,
    payload: {
      l1MemoryId: target.id,
      trigger,
      targetKind: "episode",
      runAfter
    },
    createdAt: at
  })];
}

export function enqueueEpisodeReflection(
  deps: WorkerJobHandlerDeps,
  episode: EpisodeRecord,
  at: string,
  trigger: string
): EvolutionJobRecord[] {
  if (
    !deps.capture.synthReflection ||
    episode.status !== "closed" ||
    deps.repos.runtime.hasEpisodeJob(episode.id, "reflection", ["queued", "leased", "failed"])
  ) return [];
  const target = deps.repos.memories.getMany(episode.l1MemoryIds)
    .filter((memory) => memory.memoryLayer === "L1" && !deps.traceReflectionWasScored(memory))
    .sort((a, b) => deps.traceSortKey(a) - deps.traceSortKey(b))[0];
  if (!target) return [];
  return [enqueueJob(deps, {
    jobType: "reflection",
    userId: episode.userId,
    sessionId: episode.sessionId,
    episodeId: episode.id,
    targetMemoryId: target.id,
    payload: { trigger, targetKind: "episode" },
    createdAt: at
  })];
}

export function enqueueImportSummaryIfMissing(
  deps: WorkerJobHandlerDeps,
  memory: MemoryRow,
  at: string
): void {
  const jobType = memoryHasImportPipeline(memory) ? "import_summary" : "trace_summary";
  if (deps.repos.runtime.hasPendingJob(memory.id, jobType, memory.contentHash ?? undefined)) return;
  deps.repos.transaction(() => {
    const job = enqueueJob(deps, {
      jobType,
      userId: memory.userId,
      sessionId: memory.sessionId,
      targetMemoryId: memory.id,
      payload: { source: "worker.embedding.summary_guard", contentHash: memory.contentHash },
      maxAttempts: 3,
      createdAt: at
    });
    deps.repos.processing.update(memory.id, {
      state: "summary_pending",
      stage: "summary",
      activeJobId: job.id,
      attemptCount: 0,
      retryAction: "retry",
      errorCode: null,
      errorMessage: null,
      failedAt: null,
      updatedAt: at
    }, ["embedding_pending", "embedding", "summary_pending", "summarizing"]);
  });
}

export function episodeHasRewardForReflection(episode: EpisodeRecord): boolean {
  return typeof episode.rTask === "number" && !episodeRewardWasSkipped(episode);
}

export function episodeRewardWasSkipped(episode: EpisodeRecord): boolean {
  return episode.rewardDetail.skipped === true;
}

export function workerJobCanRunInParallel(job: EvolutionJobRecord): boolean {
  return job.jobType === "trace_summary" || job.jobType === "import_summary" || job.jobType === "embedding";
}

export function processingStageForJob(jobType: JobType): ProcessingStage | undefined {
  if (jobType === "trace_summary" || jobType === "import_summary") return "summary";
  if (jobType === "embedding") return "embedding";
  return undefined;
}

export function processingJobMatchesMemory(job: EvolutionJobRecord, memory: MemoryRow): boolean {
  const contentHash = typeof job.payload.contentHash === "string" ? job.payload.contentHash : undefined;
  return !contentHash || contentHash === memory.contentHash;
}

export function sanitizeProcessingError(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\b(api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .trim();
  return clip(message || "Unknown processing error", 1000);
}

export function classifyProcessingError(message: string): {
  code: string;
  retryAction: "retry" | "open_settings" | "none";
} {
  const normalized = message.toLowerCase();
  if (/api.?key|unauthorized|forbidden|\b401\b|\b403\b|\b404\b|model.+not configured|missing.+model|expected json|html instead of json|configured model endpoint/.test(normalized)) {
    return { code: "model_configuration", retryAction: "open_settings" };
  }
  if (/trace payload is missing|memory content is missing|corrupt|malformed memory/.test(normalized)) {
    return { code: "memory_corrupt", retryAction: "none" };
  }
  if (/timeout|timed out|network|connect|temporar|rate.?limit|\b429\b|\b5\d\d\b/.test(normalized)) {
    return { code: "transient_provider_error", retryAction: "retry" };
  }
  if (/vector|embedding|dimension|finite values/.test(normalized)) {
    return { code: "embedding_failed", retryAction: "retry" };
  }
  return { code: "processing_failed", retryAction: "retry" };
}

export function evolutionJobDedupeKey(input: Pick<EnqueueJobInput, "jobType" | "episodeId" | "targetMemoryId" | "payload">): string | undefined {
  const payload = input.payload ?? {};
  const payloadString = (key: string): string | undefined => {
    const value = payload[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const payloadStringArray = (key: string): string[] => {
    const value = payload[key];
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
  };
  const target = input.targetMemoryId;
  switch (input.jobType) {
    case "episode_idle_close":
      return input.episodeId
        ? `episode_idle_close:${input.episodeId}:${payloadString("triggerRawTurnId") ?? "turn"}`
        : undefined;
    case "embedding":
      return target ? `embedding:${target}:${payloadString("contentHash") ?? "current"}` : undefined;
    case "trace_summary":
      return target ? `trace_summary:${target}:${payloadString("contentHash") ?? "current"}` : undefined;
    case "import_summary":
      return target ? `import_summary:${target}:${payloadString("contentHash") ?? "current"}` : undefined;
    case "reflection":
      return input.episodeId ? `reflection:${input.episodeId}` : target ? `reflection:${target}` : undefined;
    case "reward":
      return input.episodeId ? `reward:${input.episodeId}` : target ? `reward:${target}` : undefined;
    case "l2_association":
      return target ? `l2_association:${target}` : undefined;
    case "l2_induction": {
      const seed = target ?? payloadString("sourceMemoryId") ?? payloadString("seedMemoryId");
      return seed ? `l2_induction:${seed}` : input.episodeId ? `l2_induction:${input.episodeId}` : undefined;
    }
    case "l3_abstraction": {
      const signature = payloadString("signature");
      const seed = payloadString("seedPolicyId") ?? target;
      const policyIds = payloadStringArray("policyIds").sort();
      const basis = signature ?? seed ?? (policyIds.length ? stableHash(policyIds).slice(0, 24) : undefined);
      return basis ? `l3_abstraction:${basis}` : input.episodeId ? `l3_abstraction:${input.episodeId}` : undefined;
    }
    case "skill_crystallization": {
      const seed = target ?? payloadString("policyId") ?? payloadString("skillId");
      return seed ? `skill_crystallization:${seed}` : input.episodeId ? `skill_crystallization:${input.episodeId}` : undefined;
    }
    case "skill_trial_resolve": {
      const trial = payloadString("trialId") ?? target;
      return trial ? `skill_trial_resolve:${trial}` : input.episodeId ? `skill_trial_resolve:${input.episodeId}` : undefined;
    }
  }
}

/** Convenience adapter for hosts that prefer a single injected worker façade. */
export function createWorkerJobHandlers(deps: WorkerJobHandlerDeps) {
  return {
    processJob: (job: EvolutionJobRecord) => processJob(deps, job),
    closeIdleEpisodesForMemoryWrite: (job: EvolutionJobRecord) => closeIdleEpisodesForMemoryWrite(deps, job),
    appendJobChange: (job: EvolutionJobRecord, op: JobChangeOperation, before?: EvolutionJobRecord) => appendJobChange(deps, job, op, before),
    appendEmbeddingRetryChange: (retry: EmbeddingRetryRecord, op: EmbeddingRetryChangeOperation, before?: EmbeddingRetryRecord, error?: { code: string; message: string }) => appendEmbeddingRetryChange(deps, retry, op, before, error),
    appendEpisodeChange: (episode: EpisodeRecord, input: Parameters<typeof appendEpisodeChange>[2]) => appendEpisodeChange(deps, episode, input),
    enqueueEmbeddingRetry: (memory: MemoryRow, sourceText: string, at: string, vectorField?: EmbeddingRetryVectorField) => enqueueEmbeddingRetry(deps, memory, sourceText, at, vectorField),
    enqueueJob: (input: EnqueueJobInput) => enqueueJob(deps, input),
    finalizeClosedEpisode: (episode: EpisodeRecord, at: string, trigger: ClosedEpisodeTrigger) => finalizeClosedEpisode(deps, episode, at, trigger),
    enqueueEpisodeRewardAfterReflection: (episode: EpisodeRecord, at: string, trigger: string) => enqueueEpisodeRewardAfterReflection(deps, episode, at, trigger),
    enqueueEpisodeReflection: (episode: EpisodeRecord, at: string, trigger: string) => enqueueEpisodeReflection(deps, episode, at, trigger),
    enqueueImportSummaryIfMissing: (memory: MemoryRow, at: string) => enqueueImportSummaryIfMissing(deps, memory, at)
  };
}

function namespaceIdFromMemory(memory: MemoryRow): string {
  return namespaceIdFromContext(namespaceForMemory(memory));
}

function namespaceIdFromSession(session: SessionRecord): string {
  return namespaceIdFromContext(namespaceForSession(session));
}

function namespaceIdFromContext(namespace: RuntimeNamespace): string {
  return [
    namespace.tenantId,
    namespace.userId,
    namespace.projectId ?? namespace.workspaceId,
    namespace.source,
    namespace.profileId
  ].filter(Boolean).join(":");
}
