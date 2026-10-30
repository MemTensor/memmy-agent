import { importedSkillMayEmbed, isImportedSkill } from "../../storage/imported-skill.js";
import { ModelHttpError } from "../../model/http.js";
/**
 * Worker scheduling and execution domain.
 *
 * Read-only behavior, durable write helpers, and job-specific execution are
 * injected explicitly so this module has no service-class dependency.
 */
import {
  allowedMemoryBudgetJobTypes
} from "@memmy/agent-source-core";
import { setImmediate as yieldWorkerTurn } from "node:timers/promises";
import type { Embedder } from "../../model/types.js";
import {
  retrievalDocumentIsCurrent,
  retrievalDocumentSourceHash
} from "../../algorithm/plugin-algorithms.js";
import { createMemoryLogger, memoryErrorFields } from "../../logging/logger.js";
import { JobLeaseLostError, withJobLeaseGuard, withoutJobLeaseGuard } from "../../storage/job-lease-context.js";
import { newId } from "../../utils/id.js";
import { isTerminalL3WorldModelError } from "../evolution/l3-world-model-pipeline.js";
import {
  jobToRef,
  type EmbeddingRetryRecord,
  type EmbeddingRetryTargetKind,
  type EmbeddingRetryVectorField,
  type EvolutionJobRecord,
  type Repositories
} from "../../storage/repositories.js";
import type { JobRef,MemoryRow,RequestEnvelope } from "../../types.js";
import {
  SummaryModelUnconfiguredError,
  type EmbeddingJobProcessor,
  type PreparedEmbeddingJob
} from "../embedding/embedding-job-processor.js";
import type { PolicyEvidencePreflightReport } from "../evolution/evolution-job-processor.js";
import { turnJudgeJobFlags } from "../evolution/turn-judge.js";
import {
  embeddingTextForMemory,
  traceActionEmbeddingText,
  embeddingRetryBackoffMs,
  embeddingRetryToRunItem
} from "../embedding/embedding-pipeline.js";
import { memoryNeedsImportSummary, summaryProcessingJobType } from "../import/import-job-processor.js";
import {
  classifyProcessingError,
  type EnqueueJobInput,
  processingJobMatchesMemory,
  processingStageForJob,
  sanitizeProcessingError,
  workerJobCanRunInParallel
} from "./job-handlers.js";

import { ObservationDependenciesPendingError } from "../evidence/observation-memory-pipeline.js";
import { isObservationMemory, observationJobPayload, observationMemoryState, OBSERVATION_SUMMARY_MODEL_UNCONFIGURED } from "../observation-memory-state.js";
import { externalSkillGeneration, externalSkillJobPayload } from "../evidence/history-skill-policy.js";
import { WorkerSchedulingShadow, type WorkerSchedulingComparison } from "./worker-scheduling-shadow.js";
import { WorkerScheduler } from "./worker-scheduler.js";
import { claimFairWorkerBatch, createFairWorkerScan, releaseFairWorkerResources, releaseFairWorkerDependencies, FAIR_CLAIM_BATCH_LIMIT, type FairClaimedWork } from "./fair-worker-queue.js";
import { resolveWorkerSchedulingOptions, type WorkerSchedulingOptions, type ResolvedWorkerSchedulingOptions } from "./worker-scheduling-options.js";
import { JobPolicyRegistry, UnknownJobPolicyError } from "./job-policy-registry.js";
import { resolveWorkerLeaseOptions, type WorkerLeaseOptions } from "./worker-lease-options.js";
import { WorkerConcurrencyController, workerCapacityKey, type PreparedWorkerExecution, type WorkerPermit } from "./worker-concurrency.js";
import { workerWorkRequirements, workerEmbeddingGroupKey } from "./worker-work-requirements.js";
import { observeWorker, type WorkerObserver, type WorkerMetricOutcome } from "./worker-observability.js";

export const SUMMARY_WORKER_CONCURRENCY = 4;
export const EMBEDDING_RETRY_LEASE_MS = 5 * 60_000;
export const WORKER_LEASE_SECONDS = 60;
export const WORKER_HEARTBEAT_MS = 20_000;
const SUMMARY_JOBS_REQUIRING_MODEL: readonly string[] = ["episode_assignment", "trace_summary", "import_summary", "observation_extract", "episode_title"];
const WORKER_TURN_JOB_LIMIT = 32;

const workerLogger = createMemoryLogger("worker");

export interface WorkerJobRunResult {
  succeeded: number;
  failed: number;
  ref: JobRef;
}

export interface EmbeddingRetryRunSummary {
  leased: number;
  succeeded: number;
  failed: number;
  items: Array<{
    id: string;
    status: EmbeddingRetryRecord["status"];
    targetKind: EmbeddingRetryTargetKind;
    targetMemoryId: string;
    vectorField: EmbeddingRetryVectorField;
    attempts: number;
    lastError?: string | null;
  }>;
}

export interface WorkerRunSummary {
  leased: number;
  succeeded: number;
  failed: number;
  jobs: JobRef[];
  embeddingRetries: EmbeddingRetryRunSummary;
  changeSeq: number;
  syncCursor: string;
  serverTime: string;
}

/** Internal execution controls; the HTTP manual request does not expose these. */
export interface WorkerRunExecution {
  continuous?: boolean;
  signal?: AbortSignal;
  /** Internal handoff signal; a zero-claim yield does not mean the queue is idle. */
  onYieldToPendingRequests?: () => void;
}

export interface WorkerStartupReconciliation {
  requeuedJobs: number;
  requeuedEmbeddingRetries: number;
  restartedFailedProcessing: number;
  reconciledOrphanPolicies: number;
  policyEvidencePreflight: PolicyEvidencePreflightReport;
  enqueuedImportSummaries: number;
  enqueuedEmbeddingRepairs: number;
  enqueuedRetrievalReindexes: number;
}

export interface EmbeddingRetryClaim {
  workerId: string;
  leaseUntil: number;
  leaseToken: string;
}

type EmbeddingRetryResult = {
  succeeded: number;
  failed: number;
  item: EmbeddingRetryRunSummary["items"][number] | null;
};

/**
 * Every side effect which crosses the worker domain boundary is injected.
 * In particular, `jobHandlers` and `embeddingJobs` own the job-specific work
 * that the scheduler invokes.
 */
export interface WorkerRunnerDeps {
  repos: Pick<Repositories, "transaction" | "memories" | "processing" | "runtime"> & Partial<Pick<Repositories, "l3WorldModels">>;
  // Mark exhausted judgment attempts; durable assignment waits for an explicit retry.
  onTurnJudgeDeadLetter?: (job: EvolutionJobRecord) => void;
  embedder: Embedder;
  capture: { embedAfterCapture: boolean };
  embeddingRetryWorkerId: string;
  memoryAddEnabled: () => boolean;
  memoryBudgetPaused: () => boolean;
  memoryBudgetJobConsumes: (jobType: string) => boolean;
  memoryBudgetModelSources: () => Parameters<typeof allowedMemoryBudgetJobTypes>[0];
  memoryBudgetNextWakeAtMs: () => number;
  memoryBudgetNextReconcileAtMs?: () => number | undefined;
  summaryModelConfigured: () => boolean;
  configurationFingerprint?: () => string;
  beforeRun?: (request?: { targetMemoryIds?: readonly string[] }) => Promise<void>;
  maintenanceNextRunAtMs?: () => number | undefined;
  afterRun?: () => void;
  scheduling?: WorkerSchedulingOptions;
  leases?: WorkerLeaseOptions;
  concurrency?: WorkerConcurrencyController;
  observer?: WorkerObserver;
  prepareExecution?: (work: FairClaimedWork) => PreparedWorkerExecution;
  prepareExecutionBatch?: () => (work: FairClaimedWork) => PreparedWorkerExecution;
  schedulingShadow?: {
    enabled?: boolean;
    onComparison?: (comparison: WorkerSchedulingComparison) => void;
  };
  nowIso: () => string;
  nowMs?: () => number;
  encodeChangeCursor: (changeSeq: number) => string;
  namespaceIdFromMemory: (memory: MemoryRow) => string;
  runWorkerNoWrite: (request: RequestEnvelope) => Promise<WorkerRunSummary>;
  restartFailedProcessing: (at: string, limit: number) => number;
  enqueueObservationBackfill?: (limit: number, at: string) => number;
  previewPolicyEvidenceReconciliation: (limit: number) => PolicyEvidencePreflightReport;
  reconcileOrphanedPolicies: (at: string, limit: number) => number;
  enqueueJob: (input: EnqueueJobInput) => EvolutionJobRecord;
  enqueueEmbeddingRetry: (
    memory: MemoryRow,
    sourceText: string,
    at: string,
    vectorField?: EmbeddingRetryVectorField
  ) => EmbeddingRetryRecord;
  appendJobChange: (
    job: EvolutionJobRecord,
    op: "queued" | "leased" | "succeeded" | "failed" | "dead_letter",
    before?: EvolutionJobRecord
  ) => void;
  appendEmbeddingRetryChange: (
    retry: EmbeddingRetryRecord,
    op: "queued" | "retry" | "succeeded" | "failed",
    before?: EmbeddingRetryRecord,
    error?: { code: string; message: string }
  ) => void;
  jobHandlers: {
    processJob: (job: EvolutionJobRecord) => Promise<void>;
  };
  embeddingJobs: Pick<EmbeddingJobProcessor,
    | "prepareEmbeddingJob"
    | "applyEmbeddingVector"
    | "persistEmbeddingVector"
    | "enqueueEmbeddingRetryAfterFailure"
  >;
}

export class WorkerRunner {
  private readonly jobPolicies: JobPolicyRegistry;
  private readonly scheduler = new WorkerScheduler();
  private readonly leaseOwner = newId("worker");
  private readonly executionConfiguration = new WeakMap<object, string>();
  private readonly observedFinished = new WeakSet<object>();
  private readonly observedStarted = new WeakSet<object>();
  private readonly schedulingShadow: WorkerSchedulingShadow;
  private readonly concurrency: WorkerConcurrencyController;
  private readonly wakeListeners = new Set<() => void>();
  private wakeVersion = 0;
  private stopping = false;
  private readonly unsubscribeConcurrency: () => void;

  constructor(private readonly deps: WorkerRunnerDeps) {
    this.jobPolicies = new JobPolicyRegistry(resolveWorkerLeaseOptions(deps.leases));
    // Environment settings are fixed at process launch. Reject invalid startup
    // configuration instead of repeatedly waking an un-runnable worker.
    resolveWorkerSchedulingOptions(deps.scheduling);
    this.schedulingShadow = new WorkerSchedulingShadow(deps.repos.runtime);
    this.concurrency = deps.concurrency ?? new WorkerConcurrencyController();
    this.unsubscribeConcurrency = this.concurrency.subscribe(() => this.notifyWorkAvailable());
  }

  nextWorkerRunAt(): number | undefined {
    if (!this.deps.memoryAddEnabled()) {
      return undefined;
    }
    this.refreshConfigurationBlockedJobs();
    const reconcileAt = this.deps.memoryBudgetNextReconcileAtMs?.();
    const heldSummaryJobs = this.summaryJobsHeld();
    if (this.deps.memoryBudgetPaused()) {
      const allowed = allowedMemoryBudgetJobTypes(this.deps.memoryBudgetModelSources())
        .filter((jobType) => !heldSummaryJobs?.includes(jobType));
      const allowedAt = this.deps.repos.runtime.nextWorkerRunAt({
        jobTypes: allowed,
        includeEmbeddingRetries: !this.deps.memoryBudgetJobConsumes("embedding")
      });
      const midnight = this.deps.memoryBudgetNextWakeAtMs();
      const times = [allowedAt, midnight, reconcileAt].filter((time): time is number => Number.isFinite(time));
      return times.length > 0 ? Math.min(...times) : undefined;
    }
    const scheduled = this.deps.repos.runtime.nextWorkerRunAt(
      heldSummaryJobs ? { excludedJobTypes: heldSummaryJobs } : undefined
    );
    const times = [scheduled, reconcileAt].filter((time): time is number => Number.isFinite(time));
    return times.length > 0 ? Math.min(...times) : undefined;
  }

  reconcileWorkerStartup(limit = 10000): WorkerStartupReconciliation {
    if (!this.deps.memoryAddEnabled()) {
      return {
        requeuedJobs: 0,
        requeuedEmbeddingRetries: 0,
        restartedFailedProcessing: 0,
        reconciledOrphanPolicies: 0,
        policyEvidencePreflight: emptyPolicyEvidencePreflight(),
        enqueuedImportSummaries: 0,
        enqueuedEmbeddingRepairs: 0,
        enqueuedRetrievalReindexes: 0
      };
    }

    const at = this.deps.nowIso();
    this.refreshConfigurationBlockedJobs();
    this.deps.enqueueObservationBackfill?.(Math.min(limit, 100), at);
    const interruptedJobs = this.deps.repos.runtime.requeueLeasedJobsAfterRestart(at);
    observeWorker(this.deps.observer, { type: "lease", queue: "main", action: "recovered", count: interruptedJobs.length });
    const failedJobs = [...this.deps.repos.runtime.requeueFailedEpisodeAssignments(at), ...this.deps.repos.runtime.requeueFailedJobs(limit, at)];
    for (const { before, after } of [...interruptedJobs, ...failedJobs]) {
      this.deps.appendJobChange(after, "queued", before);
    }

    const embeddingRetries = this.deps.repos.runtime.requeueEmbeddingRetriesAfterRestart(Date.parse(at));
    observeWorker(this.deps.observer, { type: "lease", queue: "embedding_retry", action: "recovered", count: embeddingRetries.length });
    for (const { before, after } of embeddingRetries) {
      this.deps.appendEmbeddingRetryChange(after, "queued", before);
    }
    const restartedFailedProcessing = this.deps.restartFailedProcessing(at, limit);
    const policyEvidencePreflight = this.deps.previewPolicyEvidenceReconciliation(limit);
    const reconciledOrphanPolicies = this.deps.reconcileOrphanedPolicies(at, limit);

    let enqueuedImportSummaries = 0;
    let enqueuedEmbeddingRepairs = 0;
    let enqueuedRetrievalReindexes = 0;
    const activeProcessing = this.deps.repos.processing.listByStates([
      "summary_pending",
      "summarizing",
      "embedding_pending",
      "embedding"
    ], limit);
    for (const processing of activeProcessing) {
      const memory = this.deps.repos.memories.get(processing.memoryId);
      if (!memory) continue;
      if (
        processing.stage !== "summary" &&
        this.deps.repos.memories.hasVector(memory.id, "vec_summary") &&
        !memoryNeedsImportSummary(memory)
      ) {
        this.deps.repos.processing.update(memory.id, {
          state: "ready",
          stage: null,
          activeJobId: null,
          errorCode: null,
          errorMessage: null,
          failedAt: null,
          updatedAt: at
        });
        continue;
      }

      if (processing.state === "summary_pending" || processing.state === "summarizing") {
        const jobType = summaryProcessingJobType(memory);
        let job = this.deps.repos.runtime.getPendingJob(memory.id, jobType, memory.contentHash ?? undefined, String(observationMemoryState(memory)?.generation ?? "") || undefined);
        if (!job) {
          job = this.deps.enqueueJob({
            jobType,
            userId: memory.userId,
            sessionId: memory.sessionId,
            targetMemoryId: memory.id,
            payload: {
              source: "startup.processing_repair",
              ...observationJobPayload(memory),
              ...(jobType === "trace_summary"
                ? turnJudgeJobFlags(this.deps.repos.runtime.latestJobForTarget(memory.id, jobType)?.payload)
                : {})
            },
            maxAttempts: 3,
            createdAt: at
          });
          if (jobType === "import_summary") enqueuedImportSummaries += 1;
        }
        this.deps.repos.processing.update(memory.id, {
          state: "summary_pending",
          stage: "summary",
          activeJobId: job.id,
          updatedAt: at
        }, ["summary_pending", "summarizing"]);
        continue;
      }

      if (!this.deps.capture.embedAfterCapture) {
        this.deps.repos.processing.update(memory.id, {
          state: "ready_text_only",
          stage: null,
          activeJobId: null,
          attemptCount: 0,
          retryAction: "retry",
          errorCode: null,
          errorMessage: null,
          failedAt: null,
          updatedAt: at
        }, ["embedding_pending", "embedding"]);
        continue;
      }
      let job = this.deps.repos.runtime.getPendingJob(memory.id, "embedding", memory.contentHash ?? undefined, String(observationMemoryState(memory)?.generation ?? "") || undefined,
        externalSkillGeneration(memory));
      if (!job) {
        job = this.deps.enqueueJob({
          jobType: "embedding",
          userId: memory.userId,
          sessionId: memory.sessionId,
          targetMemoryId: memory.id,
          payload: {
            reason: "startup.processing_repair",
            ...observationJobPayload(memory), ...externalSkillJobPayload(memory)
          },
          ...(externalSkillGeneration(memory) ? { dedupeKey: `embedding:external-skill:${memory.id}:${externalSkillGeneration(memory)}` } : {}),
          maxAttempts: 6,
          createdAt: at
        });
        enqueuedEmbeddingRepairs += 1;
      }
      this.deps.repos.processing.update(memory.id, {
        state: "embedding_pending",
        stage: "embedding",
        activeJobId: job.id,
        updatedAt: at
      }, ["embedding_pending", "embedding"]);
    }

    for (const memory of this.deps.repos.memories.listImportMemoriesNeedingSummary(limit)) {
      const processing = this.deps.repos.processing.get(memory.id);
      if (processing?.state === "summary_pending" || processing?.state === "summarizing") continue;
      // Startup reconciliation must not erase an explicit failure or recreate a
      // terminal task. Manual retry/configuration recovery owns those states.
      if (processing?.state === "failed") continue;
      const jobType = summaryProcessingJobType(memory);
      let job = this.deps.repos.runtime.getPendingJob(memory.id, jobType, memory.contentHash ?? undefined, String(observationMemoryState(memory)?.generation ?? "") || undefined);
      if (!job) {
        this.deps.repos.memories.deleteVector(memory.id, "vec_summary");
        job = this.deps.enqueueJob({
          jobType,
          userId: memory.userId,
          sessionId: memory.sessionId,
          targetMemoryId: memory.id,
          payload: {
            source: "startup.placeholder_summary_repair",
            ...observationJobPayload(memory)
          },
          maxAttempts: 3,
          createdAt: at
        });
        if (jobType === "import_summary") enqueuedImportSummaries += 1;
      }
      this.deps.repos.processing.save({
        memoryId: memory.id,
        state: "summary_pending",
        stage: "summary",
        activeJobId: job.id,
        attemptCount: processing?.attemptCount ?? 0,
        manualRetryCount: processing?.manualRetryCount ?? 0,
        retryAction: "retry",
        errorCode: null,
        errorMessage: null,
        failedAt: null,
        updatedAt: at
      });
    }

    const retrievalMemories = this.deps.repos.memories.list({
      memoryLayer: ["Skill", "L3"],
      status: ["activated", "resolving"]
    }, limit);
    for (const memory of retrievalMemories) {
      this.deps.repos.memories.reindexFts(memory);
      if (!this.deps.capture.embedAfterCapture || retrievalDocumentIsCurrent(memory)) continue;
      if (!importedSkillMayEmbed(memory)) continue;
      if (this.deps.repos.runtime.hasPendingJob(memory.id, "embedding")) continue;
      const sourceHash = retrievalDocumentSourceHash(memory);
      this.deps.enqueueJob({
        jobType: "embedding",
        userId: memory.userId,
        sessionId: memory.sessionId,
        targetMemoryId: memory.id,
        dedupeKey: `embedding:retrieval-v2:${memory.id}:${sourceHash}${externalSkillGeneration(memory) ? `:${externalSkillGeneration(memory)}` : ""}`,
        payload: {
          reason: "startup.retrieval_document_v2",
          retrievalSourceHash: sourceHash, ...externalSkillJobPayload(memory)
        },
        maxAttempts: 6,
        createdAt: at
      });
      enqueuedRetrievalReindexes += 1;
    }

    this.refreshObservationModelConfiguration();
    return {
      requeuedJobs: interruptedJobs.length + failedJobs.length,
      requeuedEmbeddingRetries: embeddingRetries.length,
      restartedFailedProcessing,
      reconciledOrphanPolicies,
      policyEvidencePreflight,
      enqueuedImportSummaries,
      enqueuedEmbeddingRepairs,
      enqueuedRetrievalReindexes
    };
  }

  runWorkerOnce(
    limit = 100,
    request: RequestEnvelope & {
      targetMemoryIds?: string[];
      priorityCohortOnly?: boolean;
    } = {},
    execution: WorkerRunExecution = {}
  ): Promise<WorkerRunSummary> {
    // Wake callbacks may originate from an earlier job's async context. A new
    // drain establishes fresh per-job guards instead of inheriting that claim.
    return this.runScheduled(async () => {
      const wake = () => this.notifyWorkAvailable();
      execution.signal?.addEventListener("abort", wake, { once: true });
      try { return await this.runWorkerOnceUnscoped(limit, request, execution); }
      finally { execution.signal?.removeEventListener("abort", wake); }
    }, request);
  }

  private runScheduled<T>(execute: () => Promise<T>, request?: { targetMemoryIds?: readonly string[] }): Promise<T> {
    // Every entry, including retry-only requests, must wake an automatic pump
    // so it can yield the shared entry boundary to the waiting request.
    this.notifyWorkAvailable();
    return withoutJobLeaseGuard(() => this.scheduler.run(async () => {
      if (this.deps.beforeRun) await this.deps.beforeRun(request);
      const result = await execute();
      this.deps.afterRun?.();
      return result;
    }));
  }

  notifyWorkAvailable(): void {
    this.wakeVersion++;
    for (const wake of [...this.wakeListeners]) wake();
  }

  stop(): Promise<void> {
    const stopped = this.scheduler.close();
    this.stopping = true;
    this.notifyWorkAvailable();
    void stopped.then(this.unsubscribeConcurrency, this.unsubscribeConcurrency);
    return stopped;
  }

  private async runWorkerOnceUnscoped(
    limit: number,
    request: RequestEnvelope & { targetMemoryIds?: string[]; priorityCohortOnly?: boolean },
    execution: WorkerRunExecution = {}
  ): Promise<WorkerRunSummary> {
    if (!this.deps.memoryAddEnabled()) {
      return this.deps.runWorkerNoWrite(request);
    }
    const options = resolveWorkerSchedulingOptions(this.deps.scheduling);
    const normalizedLimit = Math.max(1, Math.floor(limit));
    const targetMemoryIds = request.targetMemoryIds;
    this.refreshConfigurationBlockedJobs();
    // A large upgrade drains in bounded batches over normal worker rounds.
    // Do not create a wake-up loop while configuration or budget blocks models.
    if (!targetMemoryIds && this.deps.summaryModelConfigured() && !this.deps.memoryBudgetPaused()) {
      this.deps.enqueueObservationBackfill?.(Math.min(normalizedLimit, 100), this.deps.nowIso());
    }
    const requeuedJobs = options.algorithm === "legacy" ? this.deps.repos.runtime.requeueFailedJobs(
      normalizedLimit,
      this.deps.nowIso(),
      targetMemoryIds
    ) : [];
    for (const { before, after } of requeuedJobs) {
      this.deps.appendJobChange(after, "queued", before);
    }
    this.refreshObservationModelConfiguration();
    const pausedAtLease = this.deps.memoryBudgetPaused();
    const allowedWhenPaused = pausedAtLease
      ? allowedMemoryBudgetJobTypes(this.deps.memoryBudgetModelSources())
      : undefined;
    if (pausedAtLease) {
      const expiredBudgeted = this.deps.repos.runtime.requeueExpiredLeasedJobsExcept(
        allowedWhenPaused ?? [],
        this.deps.nowIso()
      );
      for (const { before, after } of expiredBudgeted) {
        this.deps.appendJobChange(after, "queued", before);
      }
      observeWorker(this.deps.observer, { type: "lease", queue: "main", action: "recovered", count: expiredBudgeted.length });
    }
    // Diagnostics compare both algorithms; they never control real claims. A preview failure cannot prevent
    // the existing worker from claiming or executing its normal selection.
    if ((this.deps.schedulingShadow?.enabled ?? process.env.MEMMY_WORKER_SCHEDULER_SHADOW !== "0")) {
      try {
        const comparison = this.schedulingShadow.sample({
          at: this.deps.nowIso(), limit: normalizedLimit, targetMemoryIds, laneWeights: options.laneWeights,
          priorityCohortOnly: request.priorityCohortOnly,
          allowedJobTypes: allowedWhenPaused, excludedJobTypes: this.summaryJobsHeld(),
          includeRetries: !(this.deps.memoryBudgetPaused() && this.deps.memoryBudgetJobConsumes("embedding"))
        });
        if (comparison) {
          workerLogger.info("scheduler.shadow", { ...comparison });
          this.deps.schedulingShadow?.onComparison?.(comparison);
        }
      } catch (error) {
        workerLogger.warn("scheduler.shadow_failed", memoryErrorFields(error));
      }
    }
    return this.runFairWorkerOnce(normalizedLimit, request, options, false, execution);
  }

  private async runFairWorkerOnce(
    limit: number,
    request: RequestEnvelope & { targetMemoryIds?: string[]; priorityCohortOnly?: boolean },
    options: ResolvedWorkerSchedulingOptions,
    retryOnly = false,
    execution: WorkerRunExecution = {}
  ): Promise<WorkerRunSummary> {
    type Admission = { permit: WorkerPermit; execution: PreparedWorkerExecution; group: symbol; priorRecoveries: number; release(): void };
    // Automatic execution stays open across refill waves. Finite manual requests
    // retain their exact budget and target filters through the same scheduler.
    let remaining = execution.continuous ? Number.POSITIVE_INFINITY : limit;
    let leased = 0;
    let fatal: unknown;
    let failedDrain = false;
    let attemptedReconcileDeadline: number | undefined;
    let filled = false;
    let jobsThisTurn = 0;
    let scan = createFairWorkerScan();
    let claiming = false;
    const unsubscribeScanAdmission = this.concurrency.subscribe(resources => {
      // A CAS-lost reservation is returned synchronously inside the claim. It
      // does not free capacity that was unavailable before that reservation.
      if (claiming) return;
      if (options.algorithm === "legacy") scan = createFairWorkerScan();
      else releaseFairWorkerResources(scan, resources);
    });
    let scanFilters = "";
    let scanDenied = false;
    let scanDeadline: number | undefined;
    let deadlineRevision: { revision: number; rescanRevision: number } | undefined;
    let prepareExecution: WorkerRunnerDeps["prepareExecution"];
    const active = new Set<Promise<void>>();
    const selectedMain: string[] = [];
    const claimKey = (job: EvolutionJobRecord) => `${job.id}:${job.leaseToken}`;
    const results = new Map<string, WorkerJobRunResult>();
    const retries: EmbeddingRetryRunSummary = { leased: 0, succeeded: 0, failed: 0, items: [] };
    const waitForWake = (version: number) => {
      let wake!: () => void;
      const promise = new Promise<void>(resolve => {
        wake = resolve;
        this.wakeListeners.add(wake);
        if (this.wakeVersion !== version || this.stopping) resolve();
      });
      return { promise, dispose: () => this.wakeListeners.delete(wake) };
    };
    try {
      while (remaining > 0 && this.deps.memoryAddEnabled() && !this.stopping && !failedDrain && !execution.signal?.aborted &&
        !(execution.continuous && this.scheduler.hasPendingRequests())) {
        if (jobsThisTurn >= WORKER_TURN_JOB_LIMIT) {
          // Resolved promises alone do not give HTTP, cancellation or timers a
          // turn. Yield before the next admission wave, not before starting
          // already claimed work. Re-enter the guards after the macro task.
          await yieldWorkerTurn();
          jobsThisTurn = 0;
          continue;
        }
        const maintenanceTimes = [this.deps.memoryBudgetNextReconcileAtMs?.(), this.deps.maintenanceNextRunAtMs?.()]
          .filter((time): time is number => time !== undefined && Number.isFinite(time));
        const reconcileAt = maintenanceTimes.length ? Math.min(...maintenanceTimes) : undefined;
        if (execution.continuous && this.deps.beforeRun && reconcileAt !== undefined &&
          Number.isFinite(reconcileAt) && reconcileAt <= this.nowMs() && reconcileAt !== attemptedReconcileDeadline) {
          // A long automatic run no longer re-enters beforeRun every four jobs.
          // Preserve budget reconciliation at its due time, without retrying an
          // unchanged in-flight deadline on every completion/refill.
          attemptedReconcileDeadline = reconcileAt;
          await this.deps.beforeRun(retryOnly ? undefined : request);
          if (!this.deps.memoryAddEnabled() || this.stopping || failedDrain || execution.signal?.aborted || this.scheduler.hasPendingRequests()) break;
        }
        let denied = false;
        const admissions = new Map<string, Admission>();
        let previous: { key: string; permit: WorkerPermit; group: symbol; count: number } | undefined;
        const keyOf = (work: FairClaimedWork) => `${work.queue}:${work.queue === "main" ? work.job.id : work.retry.id}`;
        const paused = this.deps.memoryBudgetPaused();
        const filters = JSON.stringify([retryOnly, paused, this.deps.memoryBudgetModelSources(), this.summaryJobsHeld(),
          this.deps.configurationFingerprint?.()]);
        if (!scan.more) scanDenied = scan.waiting.size > 0;
        const revision = this.deps.repos.runtime.scheduling.getDeadlineRevision();
        const filtersChanged = scanFilters !== filters;
        // Use one cutoff for both the expiry check and the future-only query.
        // A deadline crossed during the snapshot must survive until discovery
        // revisits older sequences, rather than being filtered out and forgotten.
        const deadlineNow = this.nowMs();
        const deadlineExpired = scanDeadline !== undefined && scanDeadline <= deadlineNow;
        const changed = revision.revision !== deadlineRevision?.revision;
        const previousDeadlineRevision = deadlineRevision;
        if (filtersChanged || deadlineExpired || changed) {
          // Read the token and deadline in one snapshot. Notifications alone do
          // not invalidate timing: ordinary completions only request a refill.
          this.deps.repos.runtime.scheduling.readSnapshot(() => {
            deadlineRevision = this.deps.repos.runtime.scheduling.getDeadlineRevision();
            scanDeadline = this.nextAdmissionDeadline(deadlineNow, request.targetMemoryIds, retryOnly);
          });
        }
        // Use the snapshot's token: another connection may edit an old row
        // between the cheap change probe and opening that snapshot.
        if (filtersChanged || deadlineExpired || (previousDeadlineRevision &&
          deadlineRevision?.rescanRevision !== previousDeadlineRevision.rescanRevision)) {
          scan = createFairWorkerScan();
          scanFilters = filters;
          scanDenied = false;
          prepareExecution = this.deps.prepareExecutionBatch?.() ?? this.deps.prepareExecution;
        }
        const capacity = Math.min(remaining, this.concurrency.availableJobs(), FAIR_CLAIM_BATCH_LIMIT);
        if (filled && capacity > 0 && !retryOnly && options.algorithm === "legacy") {
          // Legacy selection requires an explicit failed -> queued transition.
          // A deadline wake within a long run must perform that same step.
          for (const { before, after } of this.deps.repos.runtime.requeueFailedJobs(
            capacity, this.deps.nowIso(), request.targetMemoryIds
          )) this.deps.appendJobChange(after, "queued", before);
        }
        filled = true;
        claiming = true;
        const work = capacity > 0 ? this.deps.repos.transaction(() => {
          const before = this.deps.repos.runtime.scheduling.getDeadlineRevision();
          const claimed = claimFairWorkerBatch(this.deps.repos, {
          at: this.deps.nowIso(), limit: capacity, targetMemoryIds: request.targetMemoryIds,
          priorityCohortOnly: request.priorityCohortOnly,
          allowedJobTypes: retryOnly ? [] : paused ? allowedMemoryBudgetJobTypes(this.deps.memoryBudgetModelSources()) : undefined,
          excludedJobTypes: this.summaryJobsHeld(),
          includeRetries: !(paused && this.deps.memoryBudgetJobConsumes("embedding")),
          owner: this.leaseOwner, retryOwner: this.deps.embeddingRetryWorkerId,
          leaseSeconds: WORKER_LEASE_SECONDS,
          retryLeaseMs: this.leasePolicyFor("embedding_retry").durationSec * 1000,
          leaseFor: work => this.leasePolicyFor(work.queue === "main" ? work.job.jobType : "embedding_retry"),
          options, scan,
          admit: candidate => {
            const execution = prepareExecution?.(candidate) ?? { providers: [], run: <T>(operation: () => T) => operation() };
            const requirements = workerWorkRequirements(candidate, this.deps.repos, execution);
            // Reject held business state before loading any embedding body.
            const heldScopes = this.concurrency.snapshot().scopeKeys;
            const heldScope = requirements.scopeKeys.find(scope => heldScopes.includes(scope));
            if (heldScope) {
              observeWorker(this.deps.observer, { type: "skipped", lane: candidate.queue === "main" ? candidate.job.queueLane : candidate.retry.queueLane, reason: "scope" });
              denied = true; return { blockedOn: workerCapacityKey("scope", heldScope) };
            }
            const canShare = previous && previous.count < this.concurrency.limits.embeddingBatchSize;
            let batchKey: string | undefined;
            if (canShare) {
              const key = workerEmbeddingGroupKey(candidate, this.deps.repos);
              batchKey = key ? JSON.stringify([key, execution.batchKey ?? null]) : undefined;
            }
            const share = batchKey && previous?.key === batchKey ? previous : undefined;
            let blockedOn: string | undefined;
            const onBlocked = (resource: string) => { blockedOn = resource; };
            let permit = this.concurrency.tryAcquire(requirements, 1, share?.permit, onBlocked);
            const shared = permit !== undefined && share !== undefined;
            if (!permit && share) {
              blockedOn = undefined;
              permit = this.concurrency.tryAcquire(requirements, 1, undefined, onBlocked);
            }
            if (!permit) { denied = true; return blockedOn ? { blockedOn } : undefined; }
            if (!canShare) {
              const key = workerEmbeddingGroupKey(candidate, this.deps.repos);
              batchKey = key ? JSON.stringify([key, execution.batchKey ?? null]) : undefined;
            }
            const group = shared ? share!.group : Symbol("worker-execution");
            const beforeAdmission = previous;
            const acquiredPermit = permit;
            const admission: Admission = { permit, execution, group,
              priorRecoveries: (candidate.queue === "main" ? candidate.job : candidate.retry).leaseRecoveryCount ?? 0,
              release: () => {
              acquiredPermit.release();
              // A lost ID-CAS must not strand the surviving embedding group.
              if (previous?.permit === acquiredPermit) previous = beforeAdmission;
            } };
            admissions.set(keyOf(candidate), admission);
            previous = batchKey ? { key: batchKey, permit, group, count: shared ? share!.count + 1 : 1 } : undefined;
            return admission;
          }
          });
          // This transaction only classifies/claims rows. Account for its own
          // leases without requerying the queue, but never acknowledge a change
          // that was already present before it acquired the database snapshot.
          const after = this.deps.repos.runtime.scheduling.getDeadlineRevision();
          if (deadlineRevision?.revision === before.revision &&
            after.revision - before.revision === claimed.length &&
            after.rescanRevision - before.rescanRevision === claimed.length) {
            deadlineRevision = after;
            for (const item of claimed) {
              const expiry = item.queue === "main" ? Date.parse(item.job.leasedUntil!) : item.retry.leaseUntil!;
              if (Number.isFinite(expiry)) scanDeadline = scanDeadline === undefined ? expiry : Math.min(scanDeadline, expiry);
            }
          }
          return claimed;
        }) : [];
        claiming = false;
        scanDenied = denied || scan.blocked;
        denied = scanDenied;
        remaining -= work.length;
        jobsThisTurn += work.length;
        const groups: Array<{ work: FairClaimedWork[]; admission: Admission }> = [];
        for (const item of work) {
          this.observeWork(item, "claimed");
          const admission = admissions.get(keyOf(item))!;
          const recoveries = (item.queue === "main" ? item.job : item.retry).leaseRecoveryCount ?? 0;
          if (recoveries > admission.priorRecoveries) {
            const count = recoveries - admission.priorRecoveries;
            observeWorker(this.deps.observer, { type: "lease", queue: item.queue, action: "expired", count });
            observeWorker(this.deps.observer, { type: "lease", queue: item.queue, action: "recovered", count });
          }
          if (item.queue === "main") { leased++; selectedMain.push(claimKey(item.job)); }
          const last = groups.at(-1);
          if (last?.admission.group === admission.group) last.work.push(item);
          else groups.push({ work: [item], admission });
        }
        for (const group of groups) {
          let task!: Promise<void>;
          task = Promise.resolve().then(() => group.admission.permit.run(() => group.admission.execution.run(async () => {
            const jobs = group.work.flatMap(item => item.queue === "main" ? [item.job] : []);
            const retryRows = group.work.flatMap(item => item.queue === "embedding_retry" ? [item.retry] : []);
            const claims = new Map(retryRows.map(retry => [retry.id, {
              workerId: this.deps.embeddingRetryWorkerId, leaseUntil: retry.leaseUntil!, leaseToken: retry.leaseToken!
            }]));
            const stopMainHeartbeat = this.startLeaseHeartbeat(jobs);
            const stopRetryHeartbeat = this.startEmbeddingRetryHeartbeat(retryRows.map(retry => ({ retry, claim: claims.get(retry.id)! })));
            try {
              if (jobs.length) {
                const completed: WorkerJobRunResult[] = [];
                await this.runClaimedMainJobs(jobs, completed, true);
                for (const result of completed) {
                  const claim = jobs.find(job => job.id === result.ref.jobId)!;
                  results.set(claimKey(claim), result);
                }
              } else {
                const result = await this.runLeasedEmbeddingRetries(retryRows, claims);
                retries.leased += result.leased;
                retries.succeeded += result.succeeded;
                retries.failed += result.failed;
                retries.items.push(...result.items);
              }
            } finally { stopMainHeartbeat(); stopRetryHeartbeat(); }
          }))).catch(error => { if (!failedDrain) fatal = error; failedDrain = true; }).finally(() => {
            for (const item of group.work) {
              releaseFairWorkerDependencies(scan, item);
              item.admission?.release();
            }
            active.delete(task);
            this.notifyWorkAvailable();
          });
          active.add(task);
        }
        if (remaining <= 0 || !this.deps.memoryAddEnabled() || this.stopping || failedDrain || execution.signal?.aborted ||
          (execution.continuous && this.scheduler.hasPendingRequests())) break;
        if (capacity > 0 && scan.more) {
          // No await occurs inside the claim transaction. Start this slice's
          // claimed work above, then let HTTP, timers and cancellation run even
          // when thousands of inspected rows acquired no execution slot.
          await yieldWorkerTurn();
          jobsThisTurn = 0;
          continue;
        }
        // SQLite discovery can cross a saved deadline within this synchronous
        // turn. Handle it before either exiting or replacing it with a future
        // deadline, otherwise a skipped older sequence can remain invisible.
        const now = this.nowMs();
        if ((scanDeadline !== undefined && scanDeadline <= now) ||
          this.deps.repos.runtime.scheduling.getDeadlineRevision().revision !== deadlineRevision?.revision) continue;
        if (active.size === 0) {
          const snapshot = this.concurrency.snapshot();
          if (!denied || (snapshot.activeJobs === 0 && snapshot.embeddingRequests === 0 && Object.keys(snapshot.providers).length === 0)) break;
        }
        const wake = waitForWake(this.wakeVersion);
        // Budget deadlines are cheap in-memory state and may change independently
        // of durable queue timestamps. Do not issue another SQL query to combine them.
        const deadlines = [scanDeadline, this.deps.memoryBudgetNextReconcileAtMs?.(), this.deps.maintenanceNextRunAtMs?.(),
          ...(paused ? [this.deps.memoryBudgetNextWakeAtMs()] : [])]
          .filter((time): time is number => time !== undefined && Number.isFinite(time) && time > now);
        const deadline = deadlines.length ? Math.min(...deadlines) : undefined;
        // Already due rows may be blocked on a permit or dependency. They must
        // not hide a future deadline or create a repeating zero-delay timer.
        const timer = deadline === undefined ? undefined : setTimeout(
          () => this.notifyWorkAvailable(), Math.min(2_147_483_647, Math.max(1, deadline - now))
        );
        try { await Promise.race([...active, wake.promise]); }
        finally { if (timer !== undefined) clearTimeout(timer); wake.dispose(); }
      }
    } catch (error) { failedDrain = true; fatal = error; }
    finally { unsubscribeScanAdmission(); }
    // Stop admission first, then wait for every guarded execution before releasing
    // the shared entry boundary or allowing service shutdown to close storage.
    await Promise.all(active);
    if (failedDrain) throw fatal;
    if (execution.continuous && !this.stopping && !execution.signal?.aborted &&
      this.deps.memoryAddEnabled() && this.scheduler.hasPendingRequests()) {
      execution.onYieldToPendingRequests?.();
    }
    const ordered = selectedMain.flatMap(id => results.has(id) ? [results.get(id)!] : []);
    const succeeded = ordered.reduce((sum, item) => sum + item.succeeded, 0);
    const failed = ordered.reduce((sum, item) => sum + item.failed, 0);
    if (leased > 0 || retries.leased > 0) workerLogger.info("drain.completed", {
      algorithm: options.algorithm, laneWeights: options.laneWeights, leased, succeeded, failed,
      embeddingRetriesLeased: retries.leased, embeddingRetriesSucceeded: retries.succeeded,
      embeddingRetriesFailed: retries.failed
    });
    const changeSeq = this.deps.repos.runtime.latestChangeSeq();
    return { leased, succeeded, failed, jobs: ordered.map(item => item.ref), embeddingRetries: retries,
      changeSeq, syncCursor: this.deps.encodeChangeCursor(changeSeq), serverTime: this.deps.nowIso() };
  }

  private nextAdmissionDeadline(now: number, targetMemoryIds: string[] | undefined, retryOnly: boolean): number | undefined {
    const paused = this.deps.memoryBudgetPaused();
    const scheduled = this.deps.repos.runtime.nextWorkerRunAt({
      futureAfterMs: now, targetMemoryIds,
      jobTypes: retryOnly ? [] : paused ? allowedMemoryBudgetJobTypes(this.deps.memoryBudgetModelSources()) : undefined,
      excludedJobTypes: this.summaryJobsHeld(),
      includeEmbeddingRetries: !(paused && this.deps.memoryBudgetJobConsumes("embedding"))
    });
    return scheduled;
  }

  private async runClaimedMainJobs(jobs: EvolutionJobRecord[], results: WorkerJobRunResult[], preserveRoleOrder = false): Promise<void> {
    const queue = [...jobs];
    while (queue.length > 0) {
      if (this.deps.memoryBudgetPaused()) {
        const hold = queue.filter((job) => this.deps.memoryBudgetJobConsumes(job.jobType));
        this.requeueUnstartedBudgetedJobs(hold);
        for (const job of hold) {
          const index = queue.indexOf(job);
          if (index >= 0) queue.splice(index, 1);
        }
        if (queue.length === 0) {
          break;
        }
      }
      const job = queue[0]!;
      if (workerJobCanRunInParallel(job)) {
        const batchType = job.jobType;
        const batch: EvolutionJobRecord[] = [];
        while (queue.length > 0 && (queue[0]?.jobType === batchType || (["trace_summary", "episode_assignment"].includes(batchType) && ["trace_summary", "episode_assignment"].includes(queue[0]!.jobType)))) {
          batch.push(queue.shift()!);
        }
        if (this.deps.memoryBudgetPaused() && this.deps.memoryBudgetJobConsumes(batchType)) {
          this.requeueUnstartedBudgetedJobs(batch);
          continue;
        }
        if (batchType === "embedding") {
          results.push(...await this.runLeasedEmbeddingJobs(batch, preserveRoleOrder));
        } else {
          for (let offset = 0; offset < batch.length; offset += SUMMARY_WORKER_CONCURRENCY) {
            if (offset > 0 && this.deps.memoryBudgetPaused() && this.deps.memoryBudgetJobConsumes(batchType)) {
              this.requeueUnstartedBudgetedJobs(batch.slice(offset));
              break;
            }
            results.push(...await Promise.all(
              batch.slice(offset, offset + SUMMARY_WORKER_CONCURRENCY)
                .map((item) => this.runLeasedWorkerJob(item))
            ));
          }
        }
        continue;
      }
      queue.shift();
      results.push(await this.runLeasedWorkerJob(job));
    }
  }

  async runLeasedWorkerJob(job: EvolutionJobRecord): Promise<WorkerJobRunResult> {
    if (!this.deps.repos.runtime.isJobLeaseHeld(job, this.deps.nowIso())) return this.lostLeaseResult(job);
    this.deps.appendJobChange(job, "leased");
    this.markProcessingJobLeased(job);
    workerLogger.info("job.started", workerJobLogFields(job));
    this.observeWork({ queue: "main", job }, "started");
    try {
      if (job.queueLane === "unregistered") throw new UnknownJobPolicyError(job.jobType);
      this.captureExecutionConfiguration(job);
      await this.withJobLease(job, () => this.deps.jobHandlers.processJob(job));
      return this.completeLeasedWorkerJob(job);
    } catch (error) {
      if (error instanceof JobLeaseLostError) return this.lostLeaseResult(job);
      if (error instanceof SummaryModelUnconfiguredError) {
        return this.holdUnconfiguredSummaryJob(job);
      }
      return this.failLeasedWorkerJob(job, error);
    }
  }

  async runLeasedEmbeddingJobs(jobs: EvolutionJobRecord[], preserveRoleOrder = false): Promise<WorkerJobRunResult[]> {
    const results: WorkerJobRunResult[] = [];
    const prepared: PreparedEmbeddingJob[] = [];

    for (const job of jobs) {
      if (!this.deps.repos.runtime.isJobLeaseHeld(job, this.deps.nowIso())) {
        results.push(this.lostLeaseResult(job));
        continue;
      }
      this.deps.appendJobChange(job, "leased");
      this.markProcessingJobLeased(job);
      workerLogger.info("job.started", workerJobLogFields(job));
      this.observeWork({ queue: "main", job }, "started");
      try {
        const item = this.withJobLease(job, () => this.deps.embeddingJobs.prepareEmbeddingJob(job));
        if (item) {
          prepared.push(item);
        } else {
          results.push(this.completeLeasedWorkerJob(job));
        }
      } catch (error) {
        results.push(this.failLeasedWorkerJob(job, error));
      }
    }

    const batches: PreparedEmbeddingJob[][] = [];
    if (preserveRoleOrder) {
      for (const item of prepared) {
        const last = batches.at(-1);
        if (last?.[0]?.role === item.role) last.push(item);
        else batches.push([item]);
      }
    } else {
      for (const role of ["document", "query"] as const) batches.push(prepared.filter((item) => item.role === role));
    }
    for (let offset = 0; offset < batches.length; offset++) {
      const batch = batches[offset]!;
      if (batch.length === 0) continue;
      if (this.deps.memoryBudgetPaused() && this.deps.memoryBudgetJobConsumes("embedding")) {
        results.push(...this.holdPreparedEmbeddingJobs(batches.slice(offset).flat()));
        break;
      }
      const role = batch[0]!.role;

      try {
        for (const item of batch) this.captureExecutionConfiguration(item.job);
        const vectors = await this.deps.embedder.embed(batch.map((item) => item.text || "(empty)"), role);
        for (const [index, item] of batch.entries()) {
          try {
            this.withJobLease(item.job, () => this.deps.embeddingJobs.applyEmbeddingVector(item, vectors[index] ?? []));
            results.push(this.completeLeasedWorkerJob(item.job));
          } catch (error) {
            results.push(this.failLeasedWorkerJob(item.job, error));
          }
        }
      } catch (error) {
        if (batch.length > 1 && shouldIsolateEmbeddingBatch(error)) {
          for (const item of batch) results.push(await this.runLeasedEmbeddingItem(item));
          continue;
        }
        for (const item of batch) {
          results.push(this.finishFailedEmbeddingItem(item, error));
        }
      }
    }

    return results;
  }

  async runLeasedEmbeddingItem(item: PreparedEmbeddingJob): Promise<WorkerJobRunResult> {
    if (this.deps.memoryBudgetPaused() && this.deps.memoryBudgetJobConsumes("embedding")) {
      return this.holdPreparedEmbeddingJobs([item])[0]!;
    }
    try {
      this.captureExecutionConfiguration(item.job);
      const vector = await this.deps.embedder.embedOne(item.text || "(empty)", item.role);
      this.withJobLease(item.job, () => this.deps.embeddingJobs.applyEmbeddingVector(item, vector));
      return this.completeLeasedWorkerJob(item.job);
    } catch (error) {
      return this.finishFailedEmbeddingItem(item, error);
    }
  }

  finishFailedEmbeddingItem(item: PreparedEmbeddingJob, error: unknown): WorkerJobRunResult {
    if (error instanceof JobLeaseLostError || !this.deps.repos.runtime.isJobLeaseHeld(item.job, this.deps.nowIso())) {
      return this.lostLeaseResult(item.job);
    }
    if (classifyProcessingError(error).retryAction !== "retry") {
      return this.failLeasedWorkerJob(item.job, error);
    }
    if (!this.withJobLease(item.job, () => this.deps.embeddingJobs.enqueueEmbeddingRetryAfterFailure(item, error))) {
      return this.failLeasedWorkerJob(item.job, error);
    }
    return this.completeLeasedWorkerJob(item.job);
  }

  completeLeasedWorkerJob(job: EvolutionJobRecord): WorkerJobRunResult {
    const completed = this.deps.repos.runtime.completeJob(job.id, this.deps.nowIso(), job);
    if (!completed) return this.lostLeaseResult(job);
    this.deps.appendJobChange(completed, "succeeded", job);
    workerLogger.info("job.succeeded", workerJobLogFields(completed));
    this.observeWork({ queue: "main", job }, "finished", "succeeded");
    return {
      succeeded: 1,
      failed: 0,
      ref: { ...jobToRef(job), status: "succeeded" }
    };
  }

  failLeasedWorkerJob(job: EvolutionJobRecord, error: unknown): WorkerJobRunResult {
    if (error instanceof JobLeaseLostError || !this.deps.repos.runtime.isJobLeaseHeld(job, this.deps.nowIso())) {
      return this.lostLeaseResult(job);
    }
    if (error instanceof ObservationDependenciesPendingError) {
      const at = this.deps.nowIso();
      const deferred = this.deps.repos.runtime.deferProcessingJob(job.id, new Date(Date.parse(at) + 30_000).toISOString(), at, job);
      if (!deferred) return this.lostLeaseResult(job);
      const memory = job.targetMemoryId ? this.deps.repos.memories.get(job.targetMemoryId) : undefined;
      if (memory && processingJobMatchesMemory(job, memory)) {
        this.deps.repos.processing.update(memory.id, { state: "summary_pending", stage: "summary", activeJobId: job.id,
          attemptCount: deferred.attempts, updatedAt: at }, ["summary_pending", "summarizing"]);
      }
      this.deps.appendJobChange(deferred, "queued", job);
      observeWorker(this.deps.observer, { type: "skipped", lane: job.queueLane, reason: "dependency" });
      this.observeWork({ queue: "main", job }, "finished", "released");
      return { succeeded: 0, failed: 0, ref: { ...jobToRef(deferred), status: "queued" } };
    }
    const errorMessage = processingStageForJob(job.jobType)
      ? sanitizeProcessingError(error)
      : error instanceof Error ? error.message : String(error);
    const classification = classifyProcessingError(error);
    const configurationBlocked = classification.retryAction === "open_settings" && classification.code !== "40309";
    const forceDeadLetter = classification.code === "40309"
      || classification.retryAction === "none"
      || error instanceof UnknownJobPolicyError
      || isTerminalL3WorldModelError(error)
      || /unsupported job type/i.test(errorMessage);
    const failureNo = (job.failureCount ?? 0) + 1;
    const availableAt = configurationBlocked || forceDeadLetter ? null
      : new Date(this.nowMs() + workerFailureBackoffMs(failureNo)).toISOString();
    const failedJob = this.deps.repos.runtime.failJob(
      job.id,
      errorMessage,
      this.deps.nowIso(),
      forceDeadLetter,
      job,
      { availableAt, blockedReason: configurationBlocked ? "configuration" : null, countFailure: !configurationBlocked }
    );
    if (!failedJob) return this.lostLeaseResult(job);
    const failOp = failedJob.status === "dead_letter" ? "dead_letter" : "failed";
    this.deps.appendJobChange(failedJob, failOp, job);
    this.updateProcessingAfterJobFailure(failedJob, error);
    const resumed = configurationBlocked && this.executionConfigurationChanged(job)
      ? this.resumeConfigurationBlockedMainJobs([job.id])[0]?.after
      : undefined;
    if (failedJob.status === "dead_letter" && failedJob.jobType === "trace_summary" && failedJob.payload.turnJudge === true) {
      this.deps.onTurnJudgeDeadLetter?.(failedJob);
    }
    workerLogger.error("job.failed", {
      ...workerJobLogFields(failedJob),
      terminal: failedJob.status === "dead_letter",
      ...memoryErrorFields(error),
      availableAt: failedJob.availableAt,
      blockedReason: failedJob.blockedReason
    });
    if (configurationBlocked) observeWorker(this.deps.observer, { type: "skipped", lane: job.queueLane, reason: "configuration" });
    this.observeWork({ queue: "main", job }, "finished", "failed");
    return {
      succeeded: 0,
      failed: 1,
      ref: {
        ...jobToRef(job),
        status: resumed?.status ?? (failedJob.status === "dead_letter" ? "dead_letter" : "failed")
      }
    };
  }

  markProcessingJobLeased(job: EvolutionJobRecord): void {
    if (!this.deps.repos.runtime.isJobLeaseHeld(job, this.deps.nowIso())) throw new JobLeaseLostError(job.id);
    if (!job.targetMemoryId) return;
    const stage = processingStageForJob(job.jobType);
    if (!stage) return;
    const memory = this.deps.repos.memories.get(job.targetMemoryId);
    if (!memory || !processingJobMatchesMemory(job, memory)) return;
    const state = stage === "summary" ? "summarizing" : "embedding";
    const processing = this.deps.repos.processing.get(job.targetMemoryId);
    this.deps.repos.processing.update(job.targetMemoryId, {
      state,
      stage,
      activeJobId: job.id,
      attemptCount: job.attempts,
      ...(processing?.errorCode === OBSERVATION_SUMMARY_MODEL_UNCONFIGURED.errorCode
        ? { retryAction: "retry" as const, errorCode: null, errorMessage: null, failedAt: null }
        : {}),
      updatedAt: this.deps.nowIso()
    }, stage === "summary"
      ? ["summary_pending", "summarizing"]
      : ["embedding_pending", "embedding"]);
  }

  updateProcessingAfterJobFailure(job: EvolutionJobRecord, error: unknown): void {
    if (!job.targetMemoryId) return;
    const stage = processingStageForJob(job.jobType);
    if (!stage || !this.deps.repos.processing.get(job.targetMemoryId)) return;
    const memory = this.deps.repos.memories.get(job.targetMemoryId);
    if (!memory || !processingJobMatchesMemory(job, memory)) return;
    const message = sanitizeProcessingError(error);
    const terminal = job.status === "dead_letter";
    const classification = classifyProcessingError(error);
    if (terminal && stage === "embedding" && classification.code === "model_input_too_long") {
      this.deps.repos.processing.update(job.targetMemoryId, {
        state: "ready_text_only",
        stage: null,
        activeJobId: null,
        attemptCount: job.attempts,
        retryAction: "none",
        errorCode: classification.code,
        errorMessage: message,
        failedAt: this.deps.nowIso(),
        updatedAt: this.deps.nowIso()
      }, ["embedding_pending", "embedding", "failed"]);
      return;
    }
    this.deps.repos.processing.update(job.targetMemoryId, {
      state: terminal || job.blockedReason === "configuration" ? "failed" : stage === "summary" ? "summary_pending" : "embedding_pending",
      stage,
      activeJobId: terminal ? null : job.id,
      attemptCount: job.attempts,
      retryAction: job.blockedReason === "configuration" ? "open_settings" : terminal ? classification.retryAction : "retry",
      errorCode: classification.code,
      errorMessage: message,
      failedAt: this.deps.nowIso(),
      updatedAt: this.deps.nowIso()
    }, stage === "summary"
      ? ["summary_pending", "summarizing", "failed"]
      : ["embedding_pending", "embedding", "failed"]);
  }

  runEmbeddingRetryOnce(
    limit: number,
    targetMemoryIds?: readonly string[]
  ): Promise<EmbeddingRetryRunSummary> {
    return this.runScheduled(async () => {
      if (!this.deps.memoryAddEnabled()) return { leased: 0, succeeded: 0, failed: 0, items: [] };
      const options = resolveWorkerSchedulingOptions(this.deps.scheduling);
      this.refreshConfigurationBlockedJobs();
      return (await this.runFairWorkerOnce(Math.max(1, Math.floor(limit)),
        { targetMemoryIds: targetMemoryIds ? [...targetMemoryIds] : undefined }, options, true)).embeddingRetries;
    });
  }

  private async runLeasedEmbeddingRetries(
    retries: EmbeddingRetryRecord[], prefetchedClaims?: ReadonlyMap<string, EmbeddingRetryClaim>
  ): Promise<EmbeddingRetryRunSummary> {
    const now = this.nowMs();
    const results: EmbeddingRetryResult[] = [];
    const claimed: Array<{ retry: EmbeddingRetryRecord; claim: EmbeddingRetryClaim; attemptNo: number }> = [];

    for (const retry of retries) {
      const claim = prefetchedClaims?.get(retry.id) ?? {
        workerId: this.deps.embeddingRetryWorkerId,
        leaseUntil: retry.leaseUntil ?? now + this.leasePolicyFor("embedding_retry").durationSec * 1000,
        leaseToken: retry.leaseToken!
      };
      if (!this.deps.repos.runtime.isEmbeddingRetryClaimHeld(retry.id, claim)) {
        this.observeWork({ queue: "embedding_retry", retry }, "finished", "fenced");
        results.push({ succeeded: 0, failed: 0, item: null });
        continue;
      }
      if (this.settleImportedSkillRetry(retry, claim, results)) continue;
      claimed.push({ retry, claim, attemptNo: retry.attempts + 1 });
    }
    const stopHeartbeat = prefetchedClaims ? () => {} : this.startEmbeddingRetryHeartbeat(claimed);
    try {
      for (const role of ["document", "query"] as const) {
        const batch = claimed.filter((item) => item.retry.embedRole === role);
        if (batch.length === 0) continue;
        if (this.deps.memoryBudgetPaused() && this.deps.memoryBudgetJobConsumes("embedding")) {
          for (const item of batch) results.push(this.holdUnstartedEmbeddingRetry(item.retry));
          continue;
        }

        try {
          for (const item of batch) this.observeWork({ queue: "embedding_retry", retry: item.retry }, "started");
          for (const item of batch) this.captureExecutionConfiguration(item.claim);
          const vectors = await this.deps.embedder.embed(
            batch.map((item) => item.retry.sourceText || "(empty)"),
            role
          );
          for (const [index, item] of batch.entries()) {
            try {
              results.push(this.applyEmbeddingRetryVector(item.retry, item.claim, vectors[index] ?? []));
            } catch (error) {
              results.push(this.failClaimedEmbeddingRetry(item.retry, item.claim, item.attemptNo, error));
            }
          }
        } catch (error) {
          if (batch.length > 1 && shouldIsolateEmbeddingBatch(error)) {
            for (const item of batch) {
              results.push(await this.runClaimedEmbeddingRetryItem(item.retry, item.claim, item.attemptNo));
            }
            continue;
          }
          for (const item of batch) {
            results.push(this.failClaimedEmbeddingRetry(item.retry, item.claim, item.attemptNo, error));
          }
        }
      }

      return {
        leased: retries.length,
        succeeded: results.reduce((sum, result) => sum + result.succeeded, 0),
        failed: results.reduce((sum, result) => sum + result.failed, 0),
        items: results.map((result) => result.item).filter((item): item is EmbeddingRetryRunSummary["items"][number] => Boolean(item))
      };
    } finally {
      stopHeartbeat();
    }
  }

  async runClaimedEmbeddingRetryItem(
    retry: EmbeddingRetryRecord,
    claim: EmbeddingRetryClaim,
    attemptNo: number
  ): Promise<EmbeddingRetryResult> {
    if (this.deps.memoryBudgetPaused() && this.deps.memoryBudgetJobConsumes("embedding")) {
      return this.holdUnstartedEmbeddingRetry(retry);
    }
    try {
      this.observeWork({ queue: "embedding_retry", retry }, "started");
      this.captureExecutionConfiguration(claim);
      const vector = await this.deps.embedder.embedOne(retry.sourceText || "(empty)", retry.embedRole);
      return this.applyEmbeddingRetryVector(retry, claim, vector);
    } catch (error) {
      return this.failClaimedEmbeddingRetry(retry, claim, attemptNo, error);
    }
  }

  /**
   * Imported skills are checked before the embedding call: a deleted,
   * archived or identity-only record is settled without one, and a retry
   * whose text is outdated is replaced by one for the current text.
   */
  private settleImportedSkillRetry(
    retry: EmbeddingRetryRecord,
    claim: EmbeddingRetryClaim,
    results: EmbeddingRetryResult[]
  ): boolean {
    const memory = this.deps.repos.memories.getIncludingDeleted(retry.targetId);
    if (!memory || !isImportedSkill(memory)) return false;
    const mayEmbed = importedSkillMayEmbed(memory);
    const currentText = embeddingTextForMemory(memory);
    if (mayEmbed && currentText === retry.sourceText) return false;
    const completed = this.deps.repos.runtime.markEmbeddingRetrySucceededClaimed(retry.id, { ...claim, now: this.nowMs() });
    if (completed) this.deps.appendEmbeddingRetryChange(completed, "succeeded", retry);
    if (mayEmbed) {
      const replacement = this.deps.enqueueEmbeddingRetry(memory, currentText, this.deps.nowIso(), retry.vectorField);
      this.deps.appendEmbeddingRetryChange(replacement, "queued");
    }
    results.push({ succeeded: 0, failed: 0, item: completed ? embeddingRetryToRunItem(completed) : null });
    return true;
  }

  applyEmbeddingRetryVector(
    retry: EmbeddingRetryRecord,
    claim: EmbeddingRetryClaim,
    vector: number[]
  ): EmbeddingRetryResult {
    if (!this.isEmbeddingRetryLeaseHeld(retry, claim)) {
      this.observeWork({ queue: "embedding_retry", retry }, "finished", "fenced");
      return { succeeded: 0, failed: 0, item: null };
    }
    const memory = this.deps.repos.memories.get(retry.targetId);
    if (!memory) {
      throw new Error(`embedding retry target not found: ${retry.targetKind}:${retry.targetId}`);
    }
    const currentText = retry.vectorField === "vec_action" ? traceActionEmbeddingText(memory)
      : memory.memoryLayer === "Skill" || memory.memoryLayer === "L3" || memory.memoryLayer === "L2"
        ? embeddingTextForMemory(memory) : undefined;
    if (currentText !== undefined && currentText !== retry.sourceText) {
      const completed = this.deps.repos.runtime.markEmbeddingRetrySucceededClaimed(retry.id, {
        ...claim,
        now: this.nowMs()
      });
      if (!completed) {
        this.observeWork({ queue: "embedding_retry", retry }, "finished", "fenced");
        return { succeeded: 0, failed: 0, item: null };
      }
      this.observeWork({ queue: "embedding_retry", retry }, "finished", "released");
      if (completed) this.deps.appendEmbeddingRetryChange(completed, "succeeded", retry);
      const replacement = this.deps.enqueueEmbeddingRetry(
        memory,
        currentText,
        this.deps.nowIso(),
        retry.vectorField
      );
      this.deps.appendEmbeddingRetryChange(replacement, "queued");
      return { succeeded: 0, failed: 0, item: completed ? embeddingRetryToRunItem(completed) : null };
    }
    let completed: EmbeddingRetryRecord | undefined;
    withJobLeaseGuard(retry, () => this.isEmbeddingRetryLeaseHeld(retry, claim), () => this.deps.embeddingJobs.persistEmbeddingVector({
      memoryId: memory.id,
      vectorField: retry.vectorField,
      vector,
      attemptCount: retry.attempts + 1,
      source: "worker.embedding_retry",
      sourceHash: memory.memoryLayer === "Skill" || memory.memoryLayer === "L3"
        ? retrievalDocumentSourceHash(memory)
        : undefined,
      allowedProcessingStates: ["embedding_pending", "embedding"],
      finalize: () => {
        completed = this.deps.repos.runtime.markEmbeddingRetrySucceededClaimed(retry.id, {
          ...claim,
          now: this.nowMs()
        });
      }
    }));
    if (completed) {
      this.deps.appendEmbeddingRetryChange(completed, "succeeded", retry);
      workerLogger.info("embedding_retry.succeeded", embeddingRetryLogFields(completed));
      this.observeWork({ queue: "embedding_retry", retry }, "finished", "succeeded");
      return { succeeded: 1, failed: 0, item: embeddingRetryToRunItem(completed) };
    }
    this.observeWork({ queue: "embedding_retry", retry }, "finished", "fenced");
    return { succeeded: 0, failed: 0, item: null };
  }

  failClaimedEmbeddingRetry(
    retry: EmbeddingRetryRecord,
    claim: EmbeddingRetryClaim,
    attemptNo: number,
    error: unknown
  ): EmbeddingRetryResult {
    if (error instanceof JobLeaseLostError || !this.isEmbeddingRetryLeaseHeld(retry, claim)) {
      this.observeWork({ queue: "embedding_retry", retry }, "finished", "fenced");
      return { succeeded: 0, failed: 0, item: null };
    }
    const message = sanitizeProcessingError(error);
    const classification = classifyProcessingError(error);
    const configurationBlocked = classification.retryAction === "open_settings" && classification.code !== "40309";
    const terminal = classification.retryAction !== "retry" || attemptNo >= retry.maxAttempts;
    const updated = configurationBlocked
      ? this.deps.repos.runtime.markEmbeddingRetryConfigurationBlockedClaimed(retry.id, {
        ...claim, error: message, now: this.nowMs()
      })
      : terminal
      ? this.deps.repos.runtime.markEmbeddingRetryFailedClaimed(retry.id, {
        ...claim,
        attempts: attemptNo,
        error: message,
        now: this.nowMs()
      })
      : this.deps.repos.runtime.markEmbeddingRetryRetryClaimed(retry.id, {
        ...claim,
        attempts: attemptNo,
        nextAttemptAt: this.nowMs() + embeddingRetryBackoffMs(attemptNo),
        error: message,
        now: this.nowMs()
      });
    if (updated) {
      if (configurationBlocked) observeWorker(this.deps.observer, { type: "skipped", lane: retry.queueLane, reason: "configuration" });
      this.observeWork({ queue: "embedding_retry", retry }, "finished", "failed");
      this.deps.appendEmbeddingRetryChange(updated, terminal ? "failed" : "retry", retry);
      const fields = {
        ...embeddingRetryLogFields(updated),
        terminal,
        blockedReason: updated.blockedReason,
        ...memoryErrorFields(error)
      };
      if (terminal) {
        workerLogger.error("embedding_retry.failed", fields);
      } else {
        workerLogger.warn("embedding_retry.retry_scheduled", fields);
      }
      const resumed = configurationBlocked && this.executionConfigurationChanged(claim)
        ? this.deps.repos.runtime.resumeConfigurationBlockedEmbeddingRetries(this.nowMs(), [retry.id])[0]?.after
        : undefined;
      if (resumed) this.deps.appendEmbeddingRetryChange(resumed, "queued", updated);
      return { succeeded: 0, failed: 1, item: embeddingRetryToRunItem(resumed ?? updated) };
    }
    this.observeWork({ queue: "embedding_retry", retry }, "finished", "fenced");
    return { succeeded: 0, failed: 0, item: null };
  }

  private summaryJobsHeld(): readonly string[] | undefined {
    return this.deps.summaryModelConfigured() ? undefined : SUMMARY_JOBS_REQUIRING_MODEL;
  }

  private refreshObservationModelConfiguration(): void {
    const configured = this.deps.summaryModelConfigured();
    const at = this.deps.nowIso();
    // Keep queued work durable while distinguishing a missing model from a
    // normal wait. Configuration restoration resumes the original job.
    for (const processing of this.deps.repos.processing.listByStates(["summary_pending"])) {
      const memory = this.deps.repos.memories.get(processing.memoryId);
      if (!memory || !isObservationMemory(memory) || observationMemoryState(memory)?.status !== "pending") continue;
      if (!configured && processing.errorCode !== OBSERVATION_SUMMARY_MODEL_UNCONFIGURED.errorCode) {
        this.deps.repos.processing.update(memory.id, {
          ...OBSERVATION_SUMMARY_MODEL_UNCONFIGURED, failedAt: null, updatedAt: at
        }, ["summary_pending"]);
      } else if (configured && processing.errorCode === OBSERVATION_SUMMARY_MODEL_UNCONFIGURED.errorCode) {
        this.deps.repos.processing.update(memory.id, {
          retryAction: "retry", errorCode: null, errorMessage: null, failedAt: null, updatedAt: at
        }, ["summary_pending"]);
      }
    }
  }

  private holdUnconfiguredSummaryJob(job: EvolutionJobRecord): WorkerJobRunResult {
    if (!this.deps.repos.runtime.isJobLeaseHeld(job, this.deps.nowIso())) return this.lostLeaseResult(job);
    this.requeueUnstartedBudgetedJobs([job], "configuration");
    if (job.targetMemoryId) {
      const memory = this.deps.repos.memories.get(job.targetMemoryId);
      this.deps.repos.processing.update(job.targetMemoryId, {
        state: "summary_pending",
        stage: "summary",
        activeJobId: job.id,
        errorCode: null,
        errorMessage: null,
        failedAt: null,
        updatedAt: this.deps.nowIso(),
        ...(memory && isObservationMemory(memory) ? OBSERVATION_SUMMARY_MODEL_UNCONFIGURED : {})
      }, ["summary_pending", "summarizing"]);
    }
    return {
      succeeded: 0,
      failed: 0,
      ref: { ...jobToRef(job), status: "queued" }
    };
  }

  private requeueUnstartedBudgetedJobs(jobs: readonly EvolutionJobRecord[], reason: "budget" | "configuration" = "budget"): void {
    if (jobs.length === 0) {
      return;
    }
    const requeued = this.deps.repos.runtime.releaseClaimedJobs(jobs, this.deps.nowIso());
    for (const { before, after } of requeued) {
      this.deps.appendJobChange(after, "queued", before);
      observeWorker(this.deps.observer, { type: "skipped", lane: before.queueLane, reason });
      this.observeWork({ queue: "main", job: before }, "finished", "released");
    }
  }

  /** Prepared items are marked embedding already, but no new request may start
   * after a budget pause. Return their claims and processing state atomically;
   * a replacement lease or another active job must retain its own state. */
  private holdPreparedEmbeddingJobs(items: readonly PreparedEmbeddingJob[]): WorkerJobRunResult[] {
    const transitions = this.deps.repos.transaction(() => {
      const released = this.deps.repos.runtime.releaseClaimedJobs(items.map(item => item.job), this.deps.nowIso());
      for (const { before, after } of released) {
        if (!after.targetMemoryId) continue;
        const processing = this.deps.repos.processing.get(after.targetMemoryId);
        const memory = this.deps.repos.memories.get(after.targetMemoryId);
        if (processing?.activeJobId !== before.id || !memory || !processingJobMatchesMemory(before, memory)) continue;
        this.deps.repos.processing.update(after.targetMemoryId, {
          state: "embedding_pending", stage: "embedding", activeJobId: after.id,
          attemptCount: after.attempts, updatedAt: this.deps.nowIso()
        }, ["embedding"]);
      }
      return released;
    });
    const releasedById = new Map(transitions.map(transition => [transition.after.id, transition]));
    return items.map(({ job }) => {
      const transition = releasedById.get(job.id);
      if (!transition) return this.lostLeaseResult(job);
      this.deps.appendJobChange(transition.after, "queued", transition.before);
      observeWorker(this.deps.observer, { type: "skipped", lane: job.queueLane, reason: "budget" });
      this.observeWork({ queue: "main", job }, "finished", "released");
      return { succeeded: 0, failed: 0, ref: jobToRef(transition.after) };
    });
  }

  private holdUnstartedEmbeddingRetry(retry: EmbeddingRetryRecord): EmbeddingRetryResult {
    const released = this.deps.repos.runtime.releaseClaimedEmbeddingRetries([retry], this.nowMs())[0];
    if (!released) {
      this.observeWork({ queue: "embedding_retry", retry }, "finished", "fenced");
      return { succeeded: 0, failed: 0, item: null };
    }
    this.deps.appendEmbeddingRetryChange(released.after, "queued", released.before);
    observeWorker(this.deps.observer, { type: "skipped", lane: retry.queueLane, reason: "budget" });
    this.observeWork({ queue: "embedding_retry", retry }, "finished", "released");
    return { succeeded: 0, failed: 0, item: embeddingRetryToRunItem(released.after) };
  }

  private nowMs(): number {
    return this.deps.nowMs?.() ?? Date.now();
  }

  private withJobLease<T>(job: EvolutionJobRecord, work: () => T): T {
    return withJobLeaseGuard(job, () => this.deps.repos.runtime.isJobLeaseHeld(job, this.deps.nowIso()), work);
  }

  private lostLeaseResult(job: EvolutionJobRecord): WorkerJobRunResult {
    workerLogger.warn("lease.fenced", { jobId: job.id, jobType: job.jobType });
    this.observeWork({ queue: "main", job }, "finished", "fenced");
    // A rejected result is neither a business failure nor a success. Report the
    // durable current state without inventing a terminal outcome for the caller.
    const current = this.deps.repos.runtime.getJob(job.id) ?? job;
    return { succeeded: 0, failed: 0, ref: jobToRef(current) };
  }

  private observeWork(item: FairClaimedWork, type: "claimed" | "started" | "finished", outcome?: WorkerMetricOutcome): void {
    if (!this.deps.observer) return;
    const row = item.queue === "main" ? item.job : item.retry;
    if (type === "started") {
      if (this.observedStarted.has(row)) return;
      this.observedStarted.add(row);
    }
    if (type === "finished") {
      if (this.observedFinished.has(row)) return;
      this.observedFinished.add(row);
      if (outcome === "fenced") observeWorker(this.deps.observer, { type: "lease", queue: item.queue, action: "fenced" });
    }
    const work = { queue: item.queue, lane: row.queueLane, firstQueuedAt: row.firstQueuedAt,
      leaseCount: row.leaseCount, leaseRecoveryCount: row.leaseRecoveryCount,
      ...(item.selectionReason ? { selectionReason: item.selectionReason } : {}) };
    if (type === "finished") observeWorker(this.deps.observer, { type, work, outcome: outcome! });
    else observeWorker(this.deps.observer, { type, work });
  }

  private leasePolicyFor(jobType: string) {
    try { return this.jobPolicies.resolve({ jobType }).lease; }
    catch (error) {
      if (!(error instanceof UnknownJobPolicyError)) throw error;
      // Lease an unregistered persisted row only so its existing terminal
      // error path can quarantine it; do not let it block the entire drain.
      return { durationSec: WORKER_LEASE_SECONDS, heartbeatMs: WORKER_HEARTBEAT_MS };
    }
  }

  private startLeaseHeartbeat(jobs: readonly EvolutionJobRecord[]): () => void {
    if (jobs.length === 0) return () => {};
    const tracked = new Map<string, { job: EvolutionJobRecord; policy: { durationSec: number; heartbeatMs: number }; nextRenewAt: number }>(jobs.map(job => {
      const policy = this.leasePolicyFor(job.jobType);
      return [job.id, { job, policy, nextRenewAt: this.nowMs() + policy.heartbeatMs }];
    }));
    const timer = setInterval(() => {
      for (const [id, entry] of tracked) {
        const { job, policy } = entry;
        if (this.nowMs() < entry.nextRenewAt) continue;
        try {
          const renewed = this.deps.repos.runtime.renewJobLease(job, policy.durationSec, this.deps.nowIso());
          if (!renewed) {
            observeWorker(this.deps.observer, { type: "lease", queue: "main", action: "renew_failed" });
            tracked.delete(id);
            continue;
          }
          job.leasedUntil = renewed.leasedUntil;
          entry.nextRenewAt = this.nowMs() + policy.heartbeatMs;
          workerLogger.debug("lease.renewed", { jobId: id, leasedUntil: renewed.leasedUntil });
          observeWorker(this.deps.observer, { type: "lease", queue: "main", action: "renewed" });
        } catch (error) {
          // A busy database may recover on a later heartbeat. If the deadline
          // passes first, all subsequent writes are rejected by the lease guard.
          workerLogger.warn("lease.renew_failed", { jobId: id, ...memoryErrorFields(error) });
          observeWorker(this.deps.observer, { type: "lease", queue: "main", action: "renew_failed" });
        }
      }
    }, Math.min(...[...tracked.values()].map(entry => entry.policy.heartbeatMs)));
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private captureExecutionConfiguration(execution: object): void {
    const fingerprint = this.deps.configurationFingerprint?.();
    if (fingerprint) this.executionConfiguration.set(execution, fingerprint);
  }

  private executionConfigurationChanged(execution: object): boolean {
    const startedWith = this.executionConfiguration.get(execution);
    const current = this.deps.configurationFingerprint?.();
    // A config reload can happen while a request from the previous config is
    // still in flight. Its late failure must not block work under the new config.
    // Resume only this execution, so a genuinely invalid current config stays held.
    return Boolean(startedWith && current && startedWith !== current);
  }

  private resumeConfigurationBlockedMainJobs(ids?: readonly string[]) {
    const transitions = this.deps.repos.runtime.resumeConfigurationBlockedJobs(this.deps.nowIso(), ids);
    for (const { before, after } of transitions) {
      const stage = processingStageForJob(after.jobType);
      if (after.targetMemoryId && stage) {
        this.deps.repos.processing.update(after.targetMemoryId, {
          state: stage === "summary" ? "summary_pending" : "embedding_pending", stage,
          activeJobId: after.id, attemptCount: after.attempts, retryAction: "retry",
          errorCode: null, errorMessage: null, failedAt: null, updatedAt: this.deps.nowIso()
        }, ["failed"]);
      }
      this.deps.appendJobChange(after, "queued", before);
    }
    return transitions;
  }

  private refreshConfigurationBlockedJobs(): void {
    const fingerprint = this.deps.configurationFingerprint?.();
    if (!fingerprint) return;
    const key = "worker.model_configuration_fingerprint";
    if (this.deps.repos.runtime.getKv(key)?.value === fingerprint) return;
    this.resumeConfigurationBlockedMainJobs();
    for (const { before, after } of this.deps.repos.runtime.resumeConfigurationBlockedEmbeddingRetries(this.nowMs())) {
      this.deps.appendEmbeddingRetryChange(after, "queued", before);
    }
    this.deps.repos.runtime.setKv(key, fingerprint, this.deps.nowIso());
  }

  resumeJobsAfterConfigurationChange(): void {
    this.refreshConfigurationBlockedJobs();
  }

  private isEmbeddingRetryLeaseHeld(retry: EmbeddingRetryRecord, claim: EmbeddingRetryClaim): boolean {
    return claim.leaseUntil > this.nowMs() && this.deps.repos.runtime.isEmbeddingRetryClaimHeld(retry.id, claim);
  }

  private startEmbeddingRetryHeartbeat(items: Array<{ retry: EmbeddingRetryRecord; claim: EmbeddingRetryClaim }>): () => void {
    if (items.length === 0) return () => {};
    const policy = this.leasePolicyFor("embedding_retry");
    const tracked = new Set(items);
    const timer = setInterval(() => {
      for (const item of tracked) {
        try {
          const now = this.nowMs();
          const renewed = this.deps.repos.runtime.renewEmbeddingRetryClaim(item.retry.id, item.claim, now + policy.durationSec * 1000, now);
          if (!renewed?.leaseUntil) {
            observeWorker(this.deps.observer, { type: "lease", queue: "embedding_retry", action: "renew_failed" });
            tracked.delete(item); continue;
          }
          item.claim.leaseUntil = renewed.leaseUntil;
          item.retry.leaseUntil = renewed.leaseUntil;
          observeWorker(this.deps.observer, { type: "lease", queue: "embedding_retry", action: "renewed" });
        } catch (error) {
          workerLogger.warn("embedding_retry.renew_failed", { retryId: item.retry.id, ...memoryErrorFields(error) });
          observeWorker(this.deps.observer, { type: "lease", queue: "embedding_retry", action: "renew_failed" });
        }
      }
    }, policy.heartbeatMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}

export function workerFailureBackoffMs(failureNo: number): number {
  const base = Math.min(5 * 60_000, 5_000 * 2 ** Math.min(10, Math.max(0, failureNo - 1)));
  return Math.min(5 * 60_000, Math.round(base * (0.8 + Math.random() * 0.4)));
}

function emptyPolicyEvidencePreflight(): PolicyEvidencePreflightReport {
  return {
    orphanPolicyIds: [],
    affectedWorldModelIds: [],
    affectedSkillIds: [],
    restorablePolicyIds: []
  };
}

function workerJobLogFields(job: EvolutionJobRecord): Record<string, unknown> {
  return {
    jobId: job.id,
    jobType: job.jobType,
    queueLane: job.queueLane,
    enqueueSeq: job.enqueueSeq,
    status: job.status,
    attempt: job.attempts,
    maxAttempts: job.maxAttempts,
    sessionId: job.sessionId,
    episodeId: job.episodeId,
    targetMemoryId: job.targetMemoryId
  };
}

function embeddingRetryLogFields(retry: EmbeddingRetryRecord): Record<string, unknown> {
  return {
    retryId: retry.id,
    queueLane: retry.queueLane,
    enqueueSeq: retry.enqueueSeq,
    targetKind: retry.targetKind,
    targetMemoryId: retry.targetId,
    vectorField: retry.vectorField,
    role: retry.embedRole,
    status: retry.status,
    attempt: retry.attempts,
    maxAttempts: retry.maxAttempts,
    nextAttemptAt: retry.nextAttemptAt
  };
}

// A rejected input can poison a whole provider request. Probe each original
// item once; do not split authentication, quota, rate-limit or server failures.
function shouldIsolateEmbeddingBatch(error: unknown): boolean {
  const classification = classifyProcessingError(error);
  return classification.code === "model_input_too_long" ||
    (classification.code === "invalid_model_request" && error instanceof ModelHttpError &&
      [400, 413, 422].includes(error.httpStatus));
}
