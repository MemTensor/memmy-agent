/**
 * Worker scheduling and execution domain.
 *
 * Read-only behavior, durable write helpers, and job-specific execution are
 * injected explicitly so this module has no service-class dependency.
 */
import type { Embedder } from "../../model/types.js";
import {
  jobToRef,
  type EmbeddingRetryRecord,
  type EmbeddingRetryTargetKind,
  type EmbeddingRetryVectorField,
  type EvolutionJobRecord,
  type Repositories
} from "../../storage/repositories.js";
import type { JobRef,MemoryRow,RequestEnvelope } from "../../types.js";
import type {
  EmbeddingJobProcessor,
  PreparedEmbeddingJob
} from "../embedding/embedding-job-processor.js";
import {
  embeddingRetryBackoffMs,
  embeddingRetryToRunItem
} from "../embedding/embedding-pipeline.js";
import { memoryHasImportPipeline } from "../import/import-job-processor.js";
import {
  classifyProcessingError,
  type EnqueueJobInput,
  processingJobMatchesMemory,
  processingStageForJob,
  sanitizeProcessingError,
  workerJobCanRunInParallel
} from "./job-handlers.js";

export const SUMMARY_WORKER_CONCURRENCY = 4;
export const EMBEDDING_RETRY_LEASE_MS = 5 * 60_000;

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

export interface WorkerStartupReconciliation {
  requeuedJobs: number;
  requeuedEmbeddingRetries: number;
  restartedFailedProcessing: number;
  enqueuedImportSummaries: number;
  enqueuedEmbeddingRepairs: number;
}

export interface EmbeddingRetryClaim {
  workerId: string;
  leaseUntil: number;
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
  repos: Pick<Repositories, "transaction" | "memories" | "processing" | "runtime">;
  embedder: Embedder;
  capture: { embedAfterCapture: boolean };
  embeddingRetryWorkerId: string;
  memoryAddEnabled: () => boolean;
  nowIso: () => string;
  nowMs?: () => number;
  encodeChangeCursor: (changeSeq: number) => string;
  namespaceIdFromMemory: (memory: MemoryRow) => string;
  runWorkerNoWrite: (request: RequestEnvelope) => Promise<WorkerRunSummary>;
  restartFailedProcessing: (at: string, limit: number) => number;
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
  constructor(private readonly deps: WorkerRunnerDeps) {}

  nextWorkerRunAt(): number | undefined {
    return this.deps.memoryAddEnabled()
      ? this.deps.repos.runtime.nextWorkerRunAt()
      : undefined;
  }

  reconcileWorkerStartup(limit = 10000): WorkerStartupReconciliation {
    if (!this.deps.memoryAddEnabled()) {
      return {
        requeuedJobs: 0,
        requeuedEmbeddingRetries: 0,
        restartedFailedProcessing: 0,
        enqueuedImportSummaries: 0,
        enqueuedEmbeddingRepairs: 0
      };
    }

    const at = this.deps.nowIso();
    const interruptedJobs = this.deps.repos.runtime.requeueLeasedJobsAfterRestart(at);
    const failedJobs = this.deps.repos.runtime.requeueFailedJobs(limit, at);
    for (const { before, after } of [...interruptedJobs, ...failedJobs]) {
      this.deps.appendJobChange(after, "queued", before);
    }

    const embeddingRetries = this.deps.repos.runtime.requeueEmbeddingRetriesAfterRestart(Date.parse(at));
    for (const { before, after } of embeddingRetries) {
      this.deps.appendEmbeddingRetryChange(after, "queued", before);
    }
    const restartedFailedProcessing = this.deps.restartFailedProcessing(at, limit);

    let enqueuedImportSummaries = 0;
    let enqueuedEmbeddingRepairs = 0;
    const activeProcessing = this.deps.repos.processing.listByStates([
      "summary_pending",
      "summarizing",
      "embedding_pending",
      "embedding"
    ], limit);
    for (const processing of activeProcessing) {
      const memory = this.deps.repos.memories.get(processing.memoryId);
      if (!memory) continue;
      if (this.deps.repos.memories.hasVector(memory.id, "vec_summary")) {
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
        const jobType = memoryHasImportPipeline(memory) ? "import_summary" : "trace_summary";
        let job = this.deps.repos.runtime.getPendingJob(memory.id, jobType, memory.contentHash ?? undefined);
        if (!job) {
          job = this.deps.enqueueJob({
            jobType,
            userId: memory.userId,
            sessionId: memory.sessionId,
            targetMemoryId: memory.id,
            payload: {
              source: "startup.processing_repair",
              contentHash: memory.contentHash
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
      let job = this.deps.repos.runtime.getPendingJob(memory.id, "embedding", memory.contentHash ?? undefined);
      if (!job) {
        job = this.deps.enqueueJob({
          jobType: "embedding",
          userId: memory.userId,
          sessionId: memory.sessionId,
          targetMemoryId: memory.id,
          payload: {
            reason: "startup.processing_repair",
            contentHash: memory.contentHash
          },
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

    return {
      requeuedJobs: interruptedJobs.length + failedJobs.length,
      requeuedEmbeddingRetries: embeddingRetries.length,
      restartedFailedProcessing,
      enqueuedImportSummaries,
      enqueuedEmbeddingRepairs
    };
  }

  async runWorkerOnce(
    limit = 100,
    request: RequestEnvelope & { targetMemoryIds?: string[] } = {}
  ): Promise<WorkerRunSummary> {
    if (!this.deps.memoryAddEnabled()) {
      return this.deps.runWorkerNoWrite(request);
    }
    const normalizedLimit = Math.max(1, Math.floor(limit));
    const targetMemoryIds = request.targetMemoryIds;
    const requeuedJobs = this.deps.repos.runtime.requeueFailedJobs(
      normalizedLimit,
      this.deps.nowIso(),
      targetMemoryIds
    );
    for (const { before, after } of requeuedJobs) {
      this.deps.appendJobChange(after, "queued", before);
    }
    const jobs = this.deps.repos.runtime.leaseQueuedJobs(normalizedLimit, 60, targetMemoryIds);
    const retryCapacity = Math.max(0, normalizedLimit - jobs.length);
    const embeddingRetries = retryCapacity > 0
      ? await this.runEmbeddingRetryOnce(retryCapacity, targetMemoryIds)
      : { leased: 0, succeeded: 0, failed: 0, items: [] };
    const results: WorkerJobRunResult[] = [];
    for (let index = 0; index < jobs.length;) {
      const job = jobs[index]!;
      if (workerJobCanRunInParallel(job)) {
        const batchType = job.jobType;
        const batch: EvolutionJobRecord[] = [];
        while (index < jobs.length && jobs[index]?.jobType === batchType) {
          batch.push(jobs[index]!);
          index += 1;
        }
        if (batchType === "embedding") {
          results.push(...await this.runLeasedEmbeddingJobs(batch));
        } else {
          for (let offset = 0; offset < batch.length; offset += SUMMARY_WORKER_CONCURRENCY) {
            results.push(...await Promise.all(
              batch.slice(offset, offset + SUMMARY_WORKER_CONCURRENCY)
                .map((item) => this.runLeasedWorkerJob(item))
            ));
          }
        }
        continue;
      }
      results.push(await this.runLeasedWorkerJob(job));
      index += 1;
    }

    const succeeded = results.reduce((sum, result) => sum + result.succeeded, 0);
    const failed = results.reduce((sum, result) => sum + result.failed, 0);
    const changeSeq = this.deps.repos.runtime.latestChangeSeq();
    return {
      leased: jobs.length,
      succeeded,
      failed,
      jobs: results.map((result) => result.ref),
      embeddingRetries,
      changeSeq,
      syncCursor: this.deps.encodeChangeCursor(changeSeq),
      serverTime: this.deps.nowIso()
    };
  }

  async runLeasedWorkerJob(job: EvolutionJobRecord): Promise<WorkerJobRunResult> {
    this.deps.appendJobChange(job, "leased");
    this.markProcessingJobLeased(job);
    try {
      await this.deps.jobHandlers.processJob(job);
      return this.completeLeasedWorkerJob(job);
    } catch (error) {
      return this.failLeasedWorkerJob(job, error);
    }
  }

  async runLeasedEmbeddingJobs(jobs: EvolutionJobRecord[]): Promise<WorkerJobRunResult[]> {
    const results: WorkerJobRunResult[] = [];
    const prepared: PreparedEmbeddingJob[] = [];

    for (const job of jobs) {
      this.deps.appendJobChange(job, "leased");
      this.markProcessingJobLeased(job);
      try {
        const item = this.deps.embeddingJobs.prepareEmbeddingJob(job);
        if (item) {
          prepared.push(item);
        } else {
          results.push(this.completeLeasedWorkerJob(job));
        }
      } catch (error) {
        results.push(this.failLeasedWorkerJob(job, error));
      }
    }

    for (const role of ["document", "query"] as const) {
      const batch = prepared.filter((item) => item.role === role);
      if (batch.length === 0) continue;

      try {
        const vectors = await this.deps.embedder.embed(batch.map((item) => item.text || "(empty)"), role);
        for (const [index, item] of batch.entries()) {
          try {
            this.deps.embeddingJobs.applyEmbeddingVector(item, vectors[index] ?? []);
            results.push(this.completeLeasedWorkerJob(item.job));
          } catch (error) {
            results.push(this.failLeasedWorkerJob(item.job, error));
          }
        }
      } catch (error) {
        for (const item of batch) {
          if (!this.deps.embeddingJobs.enqueueEmbeddingRetryAfterFailure(item, error)) {
            results.push(this.failLeasedWorkerJob(item.job, error));
          } else {
            results.push(this.completeLeasedWorkerJob(item.job));
          }
        }
      }
    }

    return results;
  }

  completeLeasedWorkerJob(job: EvolutionJobRecord): WorkerJobRunResult {
    const completed = this.deps.repos.runtime.completeJob(job.id) ?? {
      ...job,
      status: "succeeded" as const,
      leasedUntil: null,
      updatedAt: this.deps.nowIso()
    };
    this.deps.appendJobChange(completed, "succeeded", job);
    return {
      succeeded: 1,
      failed: 0,
      ref: { ...jobToRef(job), status: "succeeded" }
    };
  }

  failLeasedWorkerJob(job: EvolutionJobRecord, error: unknown): WorkerJobRunResult {
    const errorMessage = processingStageForJob(job.jobType)
      ? sanitizeProcessingError(error)
      : error instanceof Error ? error.message : String(error);
    const failedJob = this.deps.repos.runtime.failJob(job.id, errorMessage) ?? {
      ...job,
      status: "failed" as const,
      leasedUntil: null,
      lastError: errorMessage,
      updatedAt: this.deps.nowIso()
    };
    const failOp = failedJob.status === "dead_letter" ? "dead_letter" : "failed";
    this.deps.appendJobChange(failedJob, failOp, job);
    this.updateProcessingAfterJobFailure(failedJob, errorMessage);
    return {
      succeeded: 0,
      failed: 1,
      ref: {
        ...jobToRef(job),
        status: failedJob.status === "dead_letter" ? "dead_letter" : "failed"
      }
    };
  }

  markProcessingJobLeased(job: EvolutionJobRecord): void {
    if (!job.targetMemoryId) return;
    const stage = processingStageForJob(job.jobType);
    if (!stage) return;
    const memory = this.deps.repos.memories.get(job.targetMemoryId);
    if (!memory || !processingJobMatchesMemory(job, memory)) return;
    const state = stage === "summary" ? "summarizing" : "embedding";
    this.deps.repos.processing.update(job.targetMemoryId, {
      state,
      stage,
      activeJobId: job.id,
      attemptCount: job.attempts,
      errorCode: null,
      errorMessage: null,
      failedAt: null,
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
    const classification = classifyProcessingError(message);
    this.deps.repos.processing.update(job.targetMemoryId, {
      state: terminal ? "failed" : stage === "summary" ? "summary_pending" : "embedding_pending",
      stage,
      activeJobId: terminal ? null : job.id,
      attemptCount: job.attempts,
      retryAction: terminal ? classification.retryAction : "retry",
      errorCode: terminal ? classification.code : null,
      errorMessage: terminal ? message : null,
      failedAt: terminal ? this.deps.nowIso() : null,
      updatedAt: this.deps.nowIso()
    }, stage === "summary"
      ? ["summary_pending", "summarizing", "failed"]
      : ["embedding_pending", "embedding", "failed"]);
  }

  async runEmbeddingRetryOnce(
    limit: number,
    targetMemoryIds?: readonly string[]
  ): Promise<EmbeddingRetryRunSummary> {
    const now = this.nowMs();
    const retries = this.deps.repos.runtime.claimDueEmbeddingRetries({
      now,
      workerId: this.deps.embeddingRetryWorkerId,
      leaseUntil: now + EMBEDDING_RETRY_LEASE_MS,
      limit,
      targetMemoryIds
    });
    const results: EmbeddingRetryResult[] = [];
    const claimed: Array<{ retry: EmbeddingRetryRecord; claim: EmbeddingRetryClaim; attemptNo: number }> = [];

    for (const retry of retries) {
      const claim = {
        workerId: this.deps.embeddingRetryWorkerId,
        leaseUntil: retry.leaseUntil ?? now + EMBEDDING_RETRY_LEASE_MS
      };
      if (!this.deps.repos.runtime.isEmbeddingRetryClaimHeld(retry.id, claim)) {
        results.push({ succeeded: 0, failed: 0, item: null });
        continue;
      }
      claimed.push({ retry, claim, attemptNo: retry.attempts + 1 });
    }

    for (const role of ["document", "query"] as const) {
      const batch = claimed.filter((item) => item.retry.embedRole === role);
      if (batch.length === 0) continue;

      try {
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
  }

  applyEmbeddingRetryVector(
    retry: EmbeddingRetryRecord,
    claim: EmbeddingRetryClaim,
    vector: number[]
  ): EmbeddingRetryResult {
    const memory = this.deps.repos.memories.get(retry.targetId);
    if (!memory) {
      throw new Error(`embedding retry target not found: ${retry.targetKind}:${retry.targetId}`);
    }
    let completed: EmbeddingRetryRecord | undefined;
    this.deps.embeddingJobs.persistEmbeddingVector({
      memoryId: memory.id,
      vectorField: retry.vectorField,
      vector,
      attemptCount: retry.attempts + 1,
      source: "worker.embedding_retry",
      allowedProcessingStates: ["embedding_pending", "embedding"],
      finalize: () => {
        completed = this.deps.repos.runtime.markEmbeddingRetrySucceededClaimed(retry.id, {
          ...claim,
          now: this.nowMs()
        });
      }
    });
    if (completed) {
      this.deps.appendEmbeddingRetryChange(completed, "succeeded", retry);
      return { succeeded: 1, failed: 0, item: embeddingRetryToRunItem(completed) };
    }
    return { succeeded: 0, failed: 0, item: null };
  }

  failClaimedEmbeddingRetry(
    retry: EmbeddingRetryRecord,
    claim: EmbeddingRetryClaim,
    attemptNo: number,
    error: unknown
  ): EmbeddingRetryResult {
    const message = error instanceof Error ? error.message : String(error);
    const terminal = attemptNo >= retry.maxAttempts;
    const updated = terminal
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
      this.deps.appendEmbeddingRetryChange(updated, terminal ? "failed" : "retry", retry);
      return { succeeded: 0, failed: 1, item: embeddingRetryToRunItem(updated) };
    }
    return { succeeded: 0, failed: 1, item: null };
  }

  private nowMs(): number {
    return this.deps.nowMs?.() ?? Date.now();
  }
}
