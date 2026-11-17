import { createHash } from "node:crypto";
import type { Repositories, EvolutionJobRecord, EmbeddingRetryRecord } from "../../storage/repositories.js";
import type { QueueEligibilityOptions } from "../../storage/queue-eligibility.js";
import type { SchedulingCandidate } from "../../storage/queue-scheduling-store.js";
import { LaneQueueSelector } from "./lane-queue-selector.js";
import { AdmissionLaneQueueSelector, type LaneQueueTurns } from "./admission-lane-queue-selector.js";
import { QUEUE_LANES, type QueueLane } from "./job-policy-registry.js";
import type { ResolvedWorkerSchedulingOptions } from "./worker-scheduling-options.js";
import { WorkerAdmissionWaitSet } from "./worker-admission-wait-set.js";

export interface WorkAdmission { release(): void }
export interface WorkAdmissionBlocked { blockedOn: string }
export type FairClaimedWork = ({ queue: "main"; job: EvolutionJobRecord } |
  { queue: "embedding_retry"; retry: EmbeddingRetryRecord }) & { admission?: WorkAdmission;
    selectionReason?: "wrr" | "aging" | "interactive" | "legacy" };
export interface FairWorkerClaimInput extends QueueEligibilityOptions {
  at: string; limit: number; includeRetries: boolean; owner: string;
  retryOwner: string; leaseSeconds: number; retryLeaseMs: number;
  leaseFor?: (work: FairClaimedWork) => { durationSec: number };
  options: ResolvedWorkerSchedulingOptions;
  priorityCohortOnly?: boolean;
  /** Optional resumable admission scan. Without it the synchronous API is unchanged. */
  scan?: FairWorkerScan;
  /** Acquire all permits synchronously, or report the capacity to wait for. */
  admit?: (work: FairClaimedWork) => WorkAdmission | WorkAdmissionBlocked | undefined;
}
const CURSOR_KEY = "worker.scheduler.wrr_cursor.v1";
export const FAIR_CLAIM_BATCH_LIMIT = 200;

export const FAIR_SCAN_CANDIDATE_LIMIT = 64;
type ScanBucket = { lane: SchedulingCandidate["lane"]; queue: SchedulingCandidate["queue"]; after: number; exhausted: boolean };
type ScanContinuation = {
  fingerprint: string;
  buckets: ScanBucket[];
  candidates: SchedulingCandidate[];
  mainSeen: string[];
  retrySeen: string[];
  mainDone: boolean;
  retryDone: boolean;
  cohort?: number;
  turns?: LaneQueueTurns;
  agingSkippedLanes: QueueLane[];
  interactiveDenied?: boolean;
};
/** Owned by one drain. Capacity releases only wake the matching parked rows;
 * configuration, classification and due-time changes still invalidate the scan. */
export interface FairWorkerScan {
  inspected: number;
  /** Waiters survive a completed pass or a filled execution slot. */
  blocked: boolean;
  /** Whether to yield and immediately continue; independent of cursor lifetime. */
  more: boolean;
  continuation?: ScanContinuation;
  fingerprint?: string;
  waiting: WorkerAdmissionWaitSet;
}
export function createFairWorkerScan(): FairWorkerScan {
  return { inspected: 0, blocked: false, more: false, waiting: new WorkerAdmissionWaitSet() };
}
export function releaseFairWorkerResources(scan: FairWorkerScan, resources: readonly string[]): void {
  const lanes = scan.waiting.release(resources);
  if (!scan.continuation) return;
  scan.continuation.agingSkippedLanes = scan.continuation.agingSkippedLanes.filter(lane => !lanes.has(lane));
  if (lanes.has("interactive")) scan.continuation.interactiveDenied = false;
}

function dependencyKey(job: EvolutionJobRecord): string | undefined {
  if (job.sessionId && (["episode_assignment", "episode_finalize", "feedback_experience"].includes(job.jobType) ||
    (job.jobType === "trace_summary" && job.payload.turnJudge === true))) {
    return JSON.stringify(["dependency", "session", job.sessionId]);
  }
  if (["l3_world_model_update", "work_memory_extract"].includes(job.jobType) && job.scopeKey) {
    return JSON.stringify(["dependency", "scope", job.jobType, job.scopeKey]);
  }
  if (job.jobType === "reward" && typeof job.payload.l1MemoryId === "string") {
    return JSON.stringify(["dependency", "memory", job.payload.l1MemoryId]);
  }
  return undefined;
}

/** Completion only wakes related SQL dependencies, not every historical task. */
export function releaseFairWorkerDependencies(scan: FairWorkerScan, work: FairClaimedWork): void {
  const keys: string[] = [];
  if (work.queue === "main") {
    if (["l3_world_model_update", "work_memory_extract"].includes(work.job.jobType)) {
      const key = dependencyKey(work.job); if (key) keys.push(key);
    }
    if (work.job.sessionId) keys.push(JSON.stringify(["dependency", "session", work.job.sessionId]));
    if (work.job.targetMemoryId) keys.push(JSON.stringify(["dependency", "memory", work.job.targetMemoryId]));
  } else keys.push(JSON.stringify(["dependency", "memory", work.retry.targetId]));
  releaseFairWorkerResources(scan, keys);
}

function normalizeFilter(values: readonly string[] | undefined): string[] | undefined {
  return values === undefined ? undefined : [...new Set(values)].sort();
}

function scopeCursorKey(filters: QueueEligibilityOptions & { includeRetries: boolean }): string {
  if (filters.targetMemoryIds === undefined && filters.allowedJobTypes === undefined &&
    !filters.excludedJobTypes?.length && filters.includeRetries) return CURSOR_KEY;
  // A manual/targeted drain must not skip other lanes in the automatic round.
  // Keep a persistent round for each equivalent scope, including limit=1 calls.
  // Hash the full sets: truncating large target lists would merge distinct scopes.
  const scope = JSON.stringify({ targets: filters.targetMemoryIds ?? null,
    allowed: filters.allowedJobTypes ?? null, excluded: filters.excludedJobTypes ?? [],
    includeRetries: filters.includeRetries });
  return `${CURSOR_KEY}.scope.${createHash("sha256").update(scope).digest("hex")}`;
}

/** Both backing tables share one selection, one budget and one atomic cursor. */
export function claimFairWorkerBatch(
  repos: Pick<Repositories, "transaction" | "runtime">,
  input: FairWorkerClaimInput
): FairClaimedWork[] {
  if (input.admit) return claimAdmittedWorkerBatch(repos, input);
  const request = { ...input,
    targetMemoryIds: normalizeFilter(input.targetMemoryIds),
    allowedJobTypes: normalizeFilter(input.allowedJobTypes),
    excludedJobTypes: normalizeFilter(input.excludedJobTypes),
    includeDueFailed: true
  };
  const cursorKey = scopeCursorKey(request);
  return repos.transaction(() => {
    repos.runtime.scheduling.refreshActivePolicies({ includeRetries: input.includeRetries });
    const weightsKey = QUEUE_LANES.map((lane) => input.options.laneWeights[lane]).join("/");
    const saved = repos.runtime.getKv(cursorKey)?.value as { weightsKey?: unknown; cursor?: unknown } | undefined;
    const cursor = saved?.weightsKey === weightsKey && Number.isSafeInteger(saved.cursor) && Number(saved.cursor) >= 0
      ? Number(saved.cursor) : 0;
    const selector = new LaneQueueSelector(input.options.laneWeights, cursor);
    const limit = Math.min(FAIR_CLAIM_BATCH_LIMIT, input.limit);
    const candidates = repos.runtime.scheduling.candidates({ ...request, limit, includeUnregistered: true });
    const claimed: FairClaimedWork[] = [];
    while (claimed.length < limit && candidates.length > 0) {
      const before = selector.getCursor();
      const chosen = selector.select(candidates, 1).selected[0];
      if (!chosen) break;
      candidates.splice(candidates.findIndex((item) => item.queue === chosen.queue && item.id === chosen.id), 1);
      if (chosen.queue === "main") {
        const job = repos.runtime.claimQueuedJob(chosen.id, request);
        if (job) claimed.push({ queue: "main", job, selectionReason: "wrr" });
        else selector.setCursor(before);
      } else {
        const retry = repos.runtime.claimEmbeddingRetryById(chosen.id, {
          now: Date.parse(input.at), workerId: input.retryOwner,
          leaseUntil: Date.parse(input.at) + input.retryLeaseMs,
          targetMemoryIds: request.targetMemoryIds
        });
        if (retry) claimed.push({ queue: "embedding_retry", retry, selectionReason: "wrr" });
        else selector.setCursor(before);
      }
    }
    // Commit the cursor with the claims. Rollback cannot consume opportunities,
    // and a process restart or a series of limit=1 calls cannot reset the round.
    if (claimed.length > 0) repos.runtime.setKv(cursorKey, { weightsKey, cursor: selector.getCursor() }, input.at);
    return claimed;
  });
}

/** Admission and ID-CAS share the transaction; waiting tasks retain their FIFO position. */
function claimAdmittedWorkerBatch(
  repos: Pick<Repositories, "transaction" | "runtime">, input: FairWorkerClaimInput
): FairClaimedWork[] {
  const request = { ...input,
    targetMemoryIds: normalizeFilter(input.targetMemoryIds),
    allowedJobTypes: normalizeFilter(input.allowedJobTypes),
    excludedJobTypes: normalizeFilter(input.excludedJobTypes),
    includeDueFailed: input.options.algorithm === "wrr"
  };
  const admissions: WorkAdmission[] = [];
  let admissionBlocked = false;
  const limit = Math.max(0, Math.min(FAIR_CLAIM_BATCH_LIMIT, Math.floor(input.limit)));
  function tryClaim(work: FairClaimedWork, candidate?: SchedulingCandidate): FairClaimedWork | undefined {
    const acquired = input.admit!(work);
    if (!acquired) return undefined;
    if ("blockedOn" in acquired) {
      admissionBlocked = true;
      if (candidate) input.scan?.waiting.park(candidate, acquired.blockedOn);
      return undefined;
    }
    let released = false;
    const admission = { release() {
      if (released) return;
      released = true;
      acquired.release();
    } };
    admissions.push(admission);
    if (work.queue === "main") {
      const job = repos.runtime.claimQueuedJob(work.job.id, { ...request,
        leaseSeconds: input.leaseFor?.(work).durationSec ?? input.leaseSeconds });
      if (job) return { queue: "main", job, admission };
    } else {
      const retry = repos.runtime.claimEmbeddingRetryById(work.retry.id, {
        now: Date.parse(input.at), workerId: input.retryOwner,
        leaseUntil: Date.parse(input.at) + input.retryLeaseMs,
        targetMemoryIds: request.targetMemoryIds
      });
      if (retry) return { queue: "embedding_retry", retry, admission };
    }
    admission.release();
    return undefined;
  }
  try {
    return repos.transaction(() => {
      if (limit === 0) return [];
      const claimed: FairClaimedWork[] = [];
      const fingerprint = JSON.stringify([scopeCursorKey(request), input.options, input.priorityCohortOnly ?? false,
        repos.runtime.scheduling.getSelectionRevision()]);
      const scan = input.scan;
      if (scan) {
        scan.inspected = 0; scan.blocked = false; scan.more = false;
        if (scan.fingerprint !== fingerprint) scan.waiting.clear();
        scan.fingerprint = fingerprint;
      }
      const continuing = scan?.continuation?.fingerprint === fingerprint ? scan.continuation : undefined;
      // Buffers are copied so transaction rollback cannot leave a half-consumed
      // continuation. On rollback all drain-local wait references are discarded.
      const state: ScanContinuation = continuing ? { ...continuing, mainDone: false,
        buckets: continuing.buckets.map(bucket => ({ ...bucket, exhausted: false })),
        candidates: [...continuing.candidates], agingSkippedLanes: [...continuing.agingSkippedLanes], mainSeen: [...continuing.mainSeen], retrySeen: [...continuing.retrySeen]
      } : { fingerprint, buckets: QUEUE_LANES.flatMap(lane =>
        (input.includeRetries ? ["main", "embedding_retry"] as const : ["main"] as const)
          .map(queue => ({ lane, queue, after: 0, exhausted: false }))), candidates: [],
        mainSeen: [], retrySeen: [], mainDone: false, retryDone: false, agingSkippedLanes: [] };
      let inspected = 0;
      const inspectLimit = scan ? FAIR_SCAN_CANDIDATE_LIMIT : Number.POSITIVE_INFINITY;
      const saveScan = (more: boolean) => {
        if (scan) {
          scan.inspected = inspected;
          scan.more = more || scan.waiting.hasPendingPrune;
          scan.continuation = input.options.algorithm === "wrr" || more ? state : undefined;
          scan.blocked = scan.waiting.size > 0;
        }
      };
      if (input.options.algorithm === "legacy") {
        // Offsets become invalid when another macro task removes or leases an
        // examined row. Exclude examined IDs instead, keeping the original SQL
        // priority/recency ordering for every remaining eligible candidate.
        mainPages: while (!state.mainDone && claimed.length < limit && inspected < inspectLimit) {
          const pageLimit = Math.min(200, inspectLimit - inspected);
          const page = repos.runtime.previewLegacyJobPage({ ...request, limit: pageLimit, excludedIds: state.mainSeen });
          for (const { job, priority } of page) {
            if (claimed.length >= limit) break mainPages;
            if (input.priorityCohortOnly && state.cohort !== undefined && priority !== state.cohort) {
              state.mainDone = true; break mainPages;
            }
            inspected++;
            state.mainSeen.push(job.id);
            const result = tryClaim({ queue: "main", job });
            if (result) { claimed.push({ ...result, selectionReason: "legacy" }); state.cohort ??= priority; }
          }
          if (page.length < pageLimit) state.mainDone = true;
        }
        retryPages: while (state.mainDone && input.includeRetries && !state.retryDone && claimed.length < limit && inspected < inspectLimit) {
          const pageLimit = Math.min(200, inspectLimit - inspected);
          const page = repos.runtime.previewLegacyRetryPage({ now: Date.parse(input.at),
            targetMemoryIds: request.targetMemoryIds, limit: pageLimit, excludedIds: state.retrySeen });
          for (const retry of page) {
            if (claimed.length >= limit) break retryPages;
            inspected++;
            state.retrySeen.push(retry.id);
            const result = tryClaim({ queue: "embedding_retry", retry });
            if (result) claimed.push({ ...result, selectionReason: "legacy" });
          }
          if (page.length < pageLimit) state.retryDone = true;
        }
        saveScan(claimed.length < limit && (!state.mainDone || (input.includeRetries && !state.retryDone)));
        return claimed;
      }

      // An upgrade may leave thousands of older rows with stale policy. Finish
      // their active-task projection before FIFO selection, but never do all writes in one
      // event-loop turn. Recheck each slice for metadata dirtied between turns.
      const beforeProjectionRevision = repos.runtime.scheduling.getSelectionRevision();
      const projection = repos.runtime.scheduling.refreshActivePolicies({ includeRetries: input.includeRetries,
        ...(scan ? { maxRows: inspectLimit } : {}) });
      if (scan) {
        inspected += projection.refreshed;
        if (repos.runtime.scheduling.getSelectionRevision() !== beforeProjectionRevision) {
          scan.waiting.clear();
          state.candidates = [];
          for (const bucket of state.buckets) { bucket.after = 0; bucket.exhausted = false; }
        }
        if (projection.hasMore || inspected >= inspectLimit) { saveScan(true); return []; }
      }
      if (scan) {
        inspected += scan.waiting.pruneHeads(candidate => repos.runtime.scheduling.isPendingCandidate(candidate), inspectLimit - inspected,
          (candidate, resource) => resource.startsWith('["dependency",') &&
            repos.runtime.scheduling.isEligibleCandidate(candidate, input.at, request));
        if (inspected >= inspectLimit) { saveScan(true); return []; }
      }
      const cursorKey = scopeCursorKey(request);
      const weightsKey = QUEUE_LANES.map(lane => input.options.laneWeights[lane]).join("/");
      const saved = repos.runtime.getKv(cursorKey)?.value as { weightsKey?: unknown; cursor?: unknown; turns?: unknown } | undefined;
      const cursor = saved?.weightsKey === weightsKey && Number.isSafeInteger(saved.cursor) && Number(saved.cursor) >= 0 ? Number(saved.cursor) : 0;
      const selector = new AdmissionLaneQueueSelector(input.options.laneWeights, cursor,
        state.turns ?? (saved?.weightsKey === weightsKey ? saved.turns : undefined));
      const { buckets, candidates } = state;
      function refill() {
        for (const bucket of buckets) {
          if (bucket.exhausted || candidates.some(candidate => candidate.queue === bucket.queue && candidate.lane === bucket.lane)) continue;
          const page = repos.runtime.scheduling.candidatePage({ ...request, ...bucket, limit: 200,
            afterEnqueueSeq: bucket.after, includeUnregistered: true, includeDependencyBlocked: true });
          if (page.length) bucket.after = page[page.length - 1]!.enqueueSeq;
          bucket.exhausted = page.length < 200;
          candidates.push(...page);
        }
      }
      let exhausted = false;
      const deniedLanes = new Set<QueueLane>();
      while (claimed.length < limit && inspected < inspectLimit) {
        refill();
        // A deleted ID may already have been reinserted with a new sequence.
        // Discard stale ready heads before combining them with discovery pages.
        const heads = scan?.waiting.heads() ?? [];
        const ready = heads.filter(candidate => {
          if (repos.runtime.scheduling.isPendingCandidate(candidate)) return true;
          scan?.waiting.take(candidate);
          return false;
        });
        if (ready.length !== heads.length) { inspected++; continue; }
        const readyKeys = new Set(ready.map(candidate => `${candidate.queue}:${candidate.id}`));
        const available = [...candidates.filter(candidate => !readyKeys.has(`${candidate.queue}:${candidate.id}`)), ...ready];
        // A denied lane consumes no ticket, but must let other lanes try their
        // already assigned tickets before probing its next blocked row.
        let selectable = available.filter(candidate => !deniedLanes.has(candidate.lane));
        if (!selectable.length) { deniedLanes.clear(); selectable = available; }
        // A page that has never contained a row proves an empty lane. Exhausted
        // pages after rejected candidates do not: their unspent turn survives.
        selector.dropEmpty(new Set(QUEUE_LANES.filter(lane =>
          buckets.filter(bucket => bucket.lane === lane).every(bucket => bucket.after === 0 && bucket.exhausted) &&
          !selectable.some(candidate => candidate.lane === lane))));
        const interactive = state.interactiveDenied ? undefined : selector.chooseInteractive(selectable);
        const aged = !interactive && input.options.aging?.enabled ? selector.chooseAged(selectable, Date.parse(input.at),
          input.options.aging.thresholdMs, new Set(state.agingSkippedLanes)) : undefined;
        const chosen = interactive ?? aged ?? selector.choose(selectable);
        if (!chosen) { exhausted = true; break; }
        const index = candidates.findIndex(candidate => candidate.queue === chosen.queue && candidate.id === chosen.id);
        if (index >= 0) candidates.splice(index, 1);
        inspected++;
        let result: FairClaimedWork | undefined;
        const acquiredBefore = admissions.length;
        admissionBlocked = false;
        const blocked = scan?.waiting.isBlocked(chosen);
        if (blocked && scan) scan.blocked = true;
        if (!blocked) scan?.waiting.take(chosen);
        const eligible = !blocked && repos.runtime.scheduling.isEligibleCandidate(chosen, input.at, request);
        if (!blocked && !eligible && scan && chosen.queue === "main") {
          const job = repos.runtime.getJob(chosen.id);
          const key = job && dependencyKey(job);
          if (key && repos.runtime.scheduling.isPendingCandidate(chosen)) {
            scan.waiting.park(chosen, key); admissionBlocked = true;
          }
        }
        if (eligible && chosen.queue === "main") {
          const job = repos.runtime.getJob(chosen.id);
          if (job) result = tryClaim({ queue: "main", job }, chosen);
        } else if (eligible && chosen.queue === "embedding_retry") {
          const retry = repos.runtime.getEmbeddingRetry(chosen.id);
          if (retry) result = tryClaim({ queue: "embedding_retry", retry }, chosen);
        }
        if (!result && (blocked || admissionBlocked)) deniedLanes.add(chosen.lane);
        if (!result && admissions.length > acquiredBefore && scan && repos.runtime.scheduling.isEligibleCandidate(chosen, input.at, request)) {
          // A transient CAS miss must not permanently hide a still-runnable row.
          // Retry on the next fill, preserving its original sequence.
          scan.waiting.park(chosen, "claim_retry");
        }
        if (result) {
          claimed.push({ ...result, selectionReason: interactive ? "interactive" : aged ? "aging" : "wrr" });
          selector.commit(chosen.lane, aged !== undefined);
        }
        else if (aged && admissions.length === acquiredBefore) {
          // A busy aged lane must not make every later candidate in that lane
          // jump ahead of other runnable work. Retry aging after admission state
          // changes; ordinary FIFO scanning remains available in this fill.
          state.agingSkippedLanes.push(chosen.lane);
        }
        if (interactive && !result && admissions.length === acquiredBefore) state.interactiveDenied = true;
      }
      scan?.waiting.release(["claim_retry"]);
      state.turns = selector.snapshot();
      saveScan(!exhausted && claimed.length < limit);
      if (claimed.length) repos.runtime.setKv(cursorKey, { weightsKey, cursor: selector.getCursor(), turns: selector.snapshot() }, input.at);
      return claimed;
    });
  } catch (error) {
    if (input.scan) { input.scan.more = false; input.scan.continuation = undefined; input.scan.waiting.clear(); }
    // Rollback also covers successful earlier CAS operations. Returning all
    // permits here prevents a failed transaction from leaking execution slots.
    for (const admission of admissions) {
      try { admission.release(); } catch { /* Keep releasing the remaining permits and preserve the transaction error. */ }
    }
    throw error;
  }
}
