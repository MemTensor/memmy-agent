import { sameEmbeddingIdentity, type EmbeddingIdentity } from "../../model/embedding-identity.js";
import {
  kindFromMemory,
  type EmbeddingMaintenanceTask,
  type EmbeddingRetryVectorField,
  type Repositories
} from "../../storage/repositories.js";
import type { EmbeddingMaintenanceEntry } from "../../storage/sqlite-vec-store.js";
import type { MemoryRow } from "../../types.js";
import { stableHash } from "../../utils/id.js";
import {
  embeddingTextForMemory,
  traceActionEmbeddingText,
  traceSummaryEmbeddingText
} from "./embedding-pipeline.js";
import { canonicalWorkMemoryText } from "../work-memory/work-memory-pipeline.js";

export type EmbeddingMaintenanceHealth =
  | "ready"
  | "missing"
  | "dimMismatch"
  | "modelMismatch"
  | "contentMismatch";

export interface EmbeddingMaintenanceReaderTarget {
  id: string;
  kind: "memory" | "user_memory";
  vectorField?: EmbeddingRetryVectorField;
  jobId?: string;
}

export interface EmbeddingMaintenanceReaderStatsRequest {
  userId: string;
  identity: EmbeddingIdentity;
  available: boolean;
  knownDimension?: number;
  requestedDimension?: number;
  /** Return the fixed target list and per-target health needed to plan a run. */
  includePlan?: boolean;
  targets?: EmbeddingMaintenanceReaderTarget[];
}

export interface EmbeddingMaintenanceReaderTargetsRequest {
  userId: string;
  identity: EmbeddingIdentity;
  dimension: number;
  targets: EmbeddingMaintenanceReaderTarget[];
}

export interface EmbeddingMaintenanceReaderStats {
  dimension: number;
  available: boolean;
  totalSlots: number;
  ready: number;
  missing: number;
  dimMismatch: number;
  modelMismatch: number;
  needsRepair: number;
  contentMismatch?: number;
  retryQueue?: { pending: number; active: number; stale: number; failed: number };
}

export interface EmbeddingMaintenanceTargetProgress {
  key: string;
  health: EmbeddingMaintenanceHealth;
  sourceCurrent: boolean;
  succeeded: boolean;
  terminalFailure: boolean;
  retrying: boolean;
}

export interface EmbeddingMaintenanceStatsSnapshot {
  readAt: string;
  entries: EmbeddingMaintenanceEntry[];
  health: Record<string, EmbeddingMaintenanceHealth>;
  stats: EmbeddingMaintenanceReaderStats;
  targets?: EmbeddingMaintenanceTargetProgress[];
}

export interface EmbeddingMaintenanceTargetsSnapshot {
  readAt: string;
  targets: EmbeddingMaintenanceTargetProgress[];
}

export function readEmbeddingMaintenanceStats(
  repos: Repositories,
  request: EmbeddingMaintenanceReaderStatsRequest
): EmbeddingMaintenanceStatsSnapshot {
  return repos.db.transaction(() => {
    const readAt = new Date().toISOString();
    const entries = [
      ...repos.vectors.maintenanceEntries(),
      ...repos.userMemories.embeddingMaintenanceEntries(request.userId)
    ];
    const dimension = resolveDimension(entries, request);
    const work = currentEmbeddingMaintenanceState(repos, request.userId, dimension, request.identity, entries);
    const health: Record<string, EmbeddingMaintenanceHealth> = {};
    const stats: EmbeddingMaintenanceReaderStats = {
      dimension,
      available: request.available,
      totalSlots: entries.length,
      ready: 0,
      missing: 0,
      dimMismatch: 0,
      modelMismatch: 0,
      contentMismatch: 0,
      needsRepair: 0,
      retryQueue: work.retryQueue
    };
    for (const entry of entries) {
      const state = healthForEntry(entry, request.identity, dimension, work.outdatedVectors);
      if (request.includePlan) health[targetKey(entry)] = state;
      stats[state] = (stats[state] ?? 0) + 1;
    }
    stats.needsRepair = stats.missing + stats.dimMismatch + stats.modelMismatch + (stats.contentMismatch ?? 0);
    return {
      readAt,
      entries: request.includePlan ? entries : [],
      health,
      stats,
      ...(request.targets ? {
        targets: readTargetProgress(repos, {
          userId: request.userId,
          identity: request.identity,
          dimension,
          targets: request.targets
        })
      } : {})
    };
  })();
}

export function readEmbeddingMaintenanceTargets(
  repos: Repositories,
  request: EmbeddingMaintenanceReaderTargetsRequest
): EmbeddingMaintenanceTargetsSnapshot {
  return repos.db.transaction(() => {
    const readAt = new Date().toISOString();
    return { readAt, targets: readTargetProgress(repos, request) };
  })();
}

export function readEmbeddingUpgradeCandidates(repos: Repositories): EmbeddingMaintenanceEntry[] {
  return repos.db.transaction(() => repos.vectors.provenanceUpgradeEntries())();
}

function readTargetProgress(
  repos: Repositories,
  request: EmbeddingMaintenanceReaderTargetsRequest
): EmbeddingMaintenanceTargetProgress[] {
  const memoryTargets = request.targets.filter(target => target.kind === "memory");
  const userTargets = request.targets.filter(target => target.kind === "user_memory");
  const entries = [
    ...repos.vectors.maintenanceEntriesForTargets(memoryTargets),
    ...repos.userMemories.embeddingMaintenanceEntriesByIds(request.userId, userTargets.map(target => target.id))
  ];
  const byKey = new Map(entries.map(entry => [targetKey(entry), entry]));
  const memoryJobs = new Map(repos.runtime.getEmbeddingRetries(
    memoryTargets.map(target => target.jobId).filter((id): id is string => Boolean(id))
  ).map(job => [job.id, job]));
  const userJobs = new Map(repos.runtime.getJobs(
    userTargets.map(target => target.jobId).filter((id): id is string => Boolean(id))
  ).map(job => [job.id, job]));
  const memories = new Map(repos.memories.getManyWithoutVectors(
    memoryTargets.map(target => target.id)
  ).map(memory => [memory.id, memory]));
  const userMemories = new Map(repos.userMemories.embeddingMaintenanceSourcesByIds(
    userTargets.map(target => target.id)
  ).map(memory => [memory.id, memory]));
  // Health must agree with the global statistics: a target whose current content
  // has no successful embedding work behind it is contentMismatch, not ready.
  // Without this the upgrade planner treats stale vectors as done and marks the
  // one-time repair complete while the panel still reports needsRepair.
  const { outdatedVectors } = currentEmbeddingMaintenanceState(
    repos,
    request.userId,
    request.dimension,
    request.identity,
    entries
  );
  return request.targets.map(target => {
    const entry = byKey.get(targetKey(target));
    const health = entry
      ? healthForEntry(entry, request.identity, request.dimension, outdatedVectors)
      : "missing";
    let sourceCurrent = true;
    let succeeded = false;
    let terminalFailure = false;
    let retrying = false;
    if (target.jobId && target.kind === "memory") {
      const job = memoryJobs.get(target.jobId);
      const memory = memories.get(target.id);
      // Accept any text this target's maintenance would legitimately embed, not
      // just today's canonical text: a queued retry may carry an older-but-valid
      // rendering (e.g. the raw memoryValue) and still produce the right vector.
      // Strict equality here reported successful reused jobs as failures.
      sourceCurrent = Boolean(job && memory && sourceTextIsCurrent(memory, target.vectorField, job.sourceText));
      succeeded = job?.status === "succeeded";
      terminalFailure = !job || job.status === "failed";
      retrying = Boolean(job && job.attempts > 0 && job.lastError && !succeeded && !terminalFailure);
    } else if (target.jobId) {
      const job = userJobs.get(target.jobId);
      const memory = userMemories.get(target.id);
      sourceCurrent = Boolean(job && memory && job.payload.contentHash === stableHash(memory.content));
      succeeded = job?.status === "succeeded";
      terminalFailure = !job || job.status === "dead_letter" ||
        (job.status === "failed" && job.attempts >= job.maxAttempts);
      retrying = Boolean(job && job.attempts > 0 && job.lastError && !succeeded && !terminalFailure);
    }
    return {
      key: targetKey(target),
      health,
      sourceCurrent,
      succeeded,
      terminalFailure,
      retrying
    };
  });
}

function resolveDimension(
  entries: EmbeddingMaintenanceEntry[],
  request: EmbeddingMaintenanceReaderStatsRequest
): number {
  if (request.knownDimension !== undefined) return request.knownDimension;
  if (request.requestedDimension && Number.isSafeInteger(request.requestedDimension) && request.requestedDimension > 0) {
    return request.requestedDimension;
  }
  if (request.identity.provider === "local" && request.identity.model === "Xenova/all-MiniLM-L6-v2") return 384;
  const dimensions = new Map<number, number>();
  for (const entry of entries) {
    if (entry.dimension > 0 && sameEmbeddingIdentity(entry, request.identity)) {
      dimensions.set(entry.dimension, (dimensions.get(entry.dimension) ?? 0) + 1);
    }
  }
  return [...dimensions].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 0;
}

function healthForEntry(
  entry: EmbeddingMaintenanceEntry,
  identity: EmbeddingIdentity,
  dimension: number,
  outdatedVectors?: Set<string>
): EmbeddingMaintenanceHealth {
  if (entry.dimension <= 0) return "missing";
  if (!sameEmbeddingIdentity(entry, identity)) return "modelMismatch";
  if (dimension > 0 && entry.dimension !== dimension) return "dimMismatch";
  return outdatedVectors?.has(targetKey(entry)) ? "contentMismatch" : "ready";
}

function currentEmbeddingMaintenanceState(
  repos: Repositories,
  userId: string,
  dimension: number,
  identity: EmbeddingIdentity,
  entries: EmbeddingMaintenanceEntry[]
): {
  retryQueue: { pending: number; active: number; stale: number; failed: number };
  outdatedVectors: Set<string>;
} {
  const outdatedVectors = new Set<string>();
  const memories = new Map<string, ReturnType<typeof repos.memories.getWithoutVectors>>();
  const userMemories = new Map<string, ReturnType<typeof repos.userMemories.get>>();
  const byKey = new Map(entries.map(entry => [targetKey(entry), entry]));
  const isCurrentWork = (task: EmbeddingMaintenanceTask): boolean => {
    const id = task.targetId;
    const retainQueueRow = task.status !== "failed";
    let contentHash: string;
    let sourceTexts: string[];
    let vectorField = task.vectorField;
    let entry: EmbeddingMaintenanceEntry | undefined;
    if (task.userMemory) {
      if (!userMemories.has(id)) userMemories.set(id, repos.userMemories.get(id));
      const memory = userMemories.get(id);
      if (!memory || memory.status !== "active" || memory.deletedAt) return retainQueueRow;
      contentHash = stableHash(memory.content);
      sourceTexts = [memory.content];
      vectorField = "vec";
      entry = byKey.get(targetKey({ id, kind: "user_memory", vectorField }));
    } else {
      if (!memories.has(id)) memories.set(id, repos.memories.getWithoutVectors(id));
      const memory = memories.get(id);
      if (!memory || memory.status === "deleted" || memory.deletedAt) return retainQueueRow;
      contentHash = memory.contentHash ?? stableHash(memory.memoryValue);
      vectorField ??= memory.memoryLayer === "L1" ? "vec_summary" : "vec";
      entry = byKey.get(targetKey({ id, kind: "memory", vectorField }));
      sourceTexts = maintenanceSourceTexts(memory, vectorField);
      if (!sourceTextIsCurrent(memory, vectorField, task.sourceText)) return retainQueueRow;
    }
    if (task.contentHash && task.contentHash !== contentHash) return retainQueueRow;
    if (!entry || dimension === 0 || entry.dimension !== dimension || !sameEmbeddingIdentity(entry, identity)) return true;
    const completed = repos.runtime.hasSuccessfulEmbeddingWork({
      targetId: id,
      userMemory: task.userMemory,
      vectorField: vectorField ?? "vec",
      contentHash,
      sourceTexts,
      since: task.updatedAt
    });
    if (!completed) outdatedVectors.add(targetKey({
      id,
      kind: task.userMemory ? "user_memory" : "memory",
      vectorField
    }));
    return retainQueueRow || !completed;
  };
  const retryQueue = repos.runtime.embeddingMaintenanceQueueStats(userId, Date.now(), isCurrentWork);
  return { retryQueue, outdatedVectors };
}

/**
 * Whether a queued or completed job's source text still describes this memory.
 * Historical jobs may carry an older-but-valid rendering of the same content, so
 * every text the target would legitimately embed counts as current.
 */
function sourceTextIsCurrent(
  memory: MemoryRow,
  vectorField: EmbeddingRetryVectorField | undefined,
  sourceText: string | undefined
): boolean {
  if (!sourceText) return true;
  return sourceText === maintenanceText(memory, vectorField) ||
    maintenanceSourceTexts(memory, vectorField).includes(sourceText);
}

function maintenanceSourceTexts(memory: MemoryRow, vectorField?: EmbeddingRetryVectorField): string[] {
  const values = (vectorField === "vec_action"
    ? [traceActionEmbeddingText(memory)]
    : [memory.memoryValue, embeddingTextForMemory(memory), traceSummaryEmbeddingText(memory)])
    .filter((text): text is string => text !== undefined);
  if (kindFromMemory(memory) === "work_memory") {
    const internal = memory.properties.internal_info;
    values.push(canonicalWorkMemoryText(
      typeof internal.work_topic === "string" ? internal.work_topic : "Work requirements",
      typeof internal.requirement === "string" ? internal.requirement : "",
      typeof internal.reason === "string" ? internal.reason : ""
    ));
  }
  return values;
}

export function maintenanceText(memory: MemoryRow, vectorField?: EmbeddingRetryVectorField): string {
  if (vectorField === "vec_action") return traceActionEmbeddingText(memory);
  if (memory.memoryLayer === "L1" && kindFromMemory(memory) === "work_memory") {
    const internal = memory.properties.internal_info;
    return canonicalWorkMemoryText(
      typeof internal.work_topic === "string" ? internal.work_topic : "Work requirements",
      typeof internal.requirement === "string" ? internal.requirement : "",
      typeof internal.reason === "string" ? internal.reason : ""
    );
  }
  return memory.memoryLayer === "L1"
    ? traceSummaryEmbeddingText(memory) ?? embeddingTextForMemory(memory)
    : embeddingTextForMemory(memory);
}

export function targetKey(
  target: Pick<EmbeddingMaintenanceReaderTarget, "kind" | "id" | "vectorField">
): string {
  return `${target.kind}:${target.id}:${target.vectorField ?? "vec"}`;
}
