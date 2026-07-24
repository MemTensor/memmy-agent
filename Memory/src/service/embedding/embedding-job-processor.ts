import { isRecord } from "../../utils/json.js";
import { clip,firstLine } from "../../utils/text.js";
/**
 * Embedding and trace-summary worker domain, extracted from MemoryService.
 *
 * This module intentionally has no MemoryService import.  The host owns the
 * generic job-enqueue policy; this processor owns the job-specific state
 * transitions, model calls, and change records.
 */
import { traceMetaFromMemory } from "../../algorithm/plugin-algorithms.js";
import type { Embedder,LlmClient } from "../../model/types.js";
import type { EmbeddingRetryRecord,EmbeddingRetryVectorField,EvolutionJobRecord,Repositories } from "../../storage/repositories.js";
import { kindFromMemory } from "../../storage/repositories.js";
import type { JobType,MemoryProcessingState,MemoryRow,ToolCallPayload } from "../../types.js";
import {
  firstRealSummary,
  importStatusTags,
  isImportSummaryPlaceholder,
  memoryHasImportPipeline,
  memoryNeedsImportSummary,
  updateImportPipelineStatus,
  updateTraceImportSummary
} from "../import/import-job-processor.js";
import {
  IMPORT_DEFAULT_ALPHA,
  IMPORT_DEFAULT_PRIORITY,
  IMPORT_DEFAULT_VALUE
} from "../import/memory-import-pipeline.js";
import { namespaceForMemory } from "../namespace/namespace-scope.js";
import { processingJobMatchesMemory } from "../worker/job-handlers.js";
import {
  embeddingTextForMemory,
  traceSummaryEmbeddingText,
  updateMemoryVectorField
} from "./embedding-pipeline.js";

type TraceMeta = NonNullable<ReturnType<typeof traceMetaFromMemory>>;

export interface PreparedEmbeddingJob {
  job: EvolutionJobRecord;
  memory: MemoryRow;
  text: string;
  role: "document" | "query";
  vectorField: EmbeddingRetryVectorField;
}

export interface EnqueueWorkerJobInput {
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

export interface PersistEmbeddingVectorInput {
  memoryId: string;
  vectorField: EmbeddingRetryVectorField;
  vector: number[];
  attemptCount: number;
  source: string;
  allowedProcessingStates?: MemoryProcessingState[];
  finalize?: (saved: MemoryRow, hadProcessing: boolean, at: string) => void;
}

export interface ScheduleEmbeddingAfterTextUpdateInput {
  memory: MemoryRow;
  sourceJob: EvolutionJobRecord;
  reason: string;
  vectorField: EmbeddingRetryVectorField;
  clearExistingVector: boolean;
  allowedProcessingStates?: MemoryProcessingState[];
  textOnlyAttemptCount: number;
  at?: string;
}

/** The host supplies cross-domain policy rather than this module reaching into MemoryService. */
export interface EmbeddingJobProcessorDeps {
  repos: Pick<Repositories, "transaction" | "memories" | "processing" | "runtime">;
  embedder: Embedder;
  llm: LlmClient;
  capture: { embedAfterCapture: boolean };
  nowIso: () => string;
  enqueueJob: (input: EnqueueWorkerJobInput) => EvolutionJobRecord;
  enqueueImportSummaryIfMissing(memory: MemoryRow, at: string): void;
  enqueueEmbeddingRetry(
    memory: MemoryRow,
    sourceText: string,
    at: string,
    vectorField?: EmbeddingRetryVectorField
  ): EmbeddingRetryRecord;
  appendEmbeddingRetryChange(
    retry: EmbeddingRetryRecord,
    op: "queued" | "retry" | "succeeded" | "failed",
    before?: EmbeddingRetryRecord,
    error?: { code: string; message: string }
  ): void;
  summarizeTraceForCapture(
    input: {
      trace: TraceMeta;
      userText: string;
      agentText: string;
      toolCalls: ToolCallPayload[];
      reflectionText: string;
    },
    options?: { strict?: boolean }
  ): Promise<string>;
}

export class EmbeddingJobProcessor {
  constructor(private readonly deps: EmbeddingJobProcessorDeps) {}

  async embedMemory(job: EvolutionJobRecord): Promise<void> {
    const item = this.prepareEmbeddingJob(job);
    if (!item) return;
    try {
      const [vector] = await this.deps.embedder.embed([item.text], item.role);
      this.applyEmbeddingVector(item, vector ?? []);
    } catch (error) {
      if (!this.enqueueEmbeddingRetryAfterFailure(item, error)) throw error;
    }
  }

  prepareEmbeddingJob(job: EvolutionJobRecord): PreparedEmbeddingJob | null {
    const memory = job.targetMemoryId ? this.deps.repos.memories.get(job.targetMemoryId) : undefined;
    if (!memory) throw new Error(`embedding target not found: ${job.targetMemoryId ?? "unknown"}`);
    if (!processingJobMatchesMemory(job, memory)) return null;

    if (memory.memoryLayer === "L1") {
      if (memoryNeedsImportSummary(memory)) {
        this.deps.enqueueImportSummaryIfMissing(memory, this.deps.nowIso());
        return null;
      }
      const text = traceSummaryEmbeddingText(memory);
      if (!text) {
        this.deps.enqueueImportSummaryIfMissing(memory, this.deps.nowIso());
        return null;
      }
      return { job, memory, text, role: "document", vectorField: "vec_summary" };
    }

    return {
      job,
      memory,
      text: embeddingTextForMemory(memory),
      role: "query",
      vectorField: "vec"
    };
  }

  applyEmbeddingVector(item: PreparedEmbeddingJob, vector: number[]): void {
    const current = this.deps.repos.memories.get(item.memory.id);
    if (!current) throw new Error(`embedding target not found: ${item.memory.id}`);
    if (!processingJobMatchesMemory(item.job, current)) return;
    this.persistEmbeddingVector({
      memoryId: current.id,
      vectorField: item.vectorField,
      vector,
      attemptCount: item.job.attempts,
      source: "worker.embedding",
      allowedProcessingStates: ["embedding_pending", "embedding"],
      finalize: (_saved, hadProcessing, at) => {
        if (hadProcessing) this.deps.repos.runtime.completeJob(item.job.id, at);
      }
    });
  }

  persistEmbeddingVector(input: PersistEmbeddingVectorInput): MemoryRow {
    const current = this.deps.repos.memories.get(input.memoryId);
    if (!current) throw new Error(`embedding target not found: ${input.memoryId}`);
    const at = this.deps.nowIso();
    let saved = current;
    this.deps.repos.transaction(() => {
      const vectorized = updateMemoryVectorField(current, input.vectorField, input.vector, {
        model: this.deps.embedder.config.model ?? this.deps.embedder.config.provider,
        provider: this.deps.embedder.config.provider,
        updatedAt: at
      });
      saved = this.deps.repos.memories.updateMaintenance(
        current.memoryLayer === "L1" ? updateImportPipelineStatus(vectorized, "indexed", at) : vectorized
      );
      const hadProcessing = Boolean(this.deps.repos.processing.get(saved.id));
      if (hadProcessing) {
        this.deps.repos.processing.update(saved.id, {
          state: "ready", stage: null, activeJobId: null, attemptCount: input.attemptCount,
          retryAction: "retry", errorCode: null, errorMessage: null, failedAt: null, updatedAt: at
        }, input.allowedProcessingStates ?? ["embedding_pending", "embedding"]);
      }
      this.appendMemoryChange(saved, current, input.source, at);
      input.finalize?.(saved, hadProcessing, at);
    });
    return saved;
  }

  enqueueEmbeddingRetryAfterFailure(item: PreparedEmbeddingJob, error: unknown): boolean {
    if (this.deps.repos.processing.get(item.memory.id)) return false;
    const retry = this.deps.enqueueEmbeddingRetry(
      item.memory,
      item.text,
      this.deps.nowIso(),
      item.vectorField
    );
    this.deps.appendEmbeddingRetryChange(retry, "queued", undefined, {
      code: "embedding_error",
      message: error instanceof Error ? error.message : String(error)
    });
    return true;
  }

  async summarizeImportedTrace(job: EvolutionJobRecord): Promise<void> {
    const memory = job.targetMemoryId ? this.deps.repos.memories.get(job.targetMemoryId) : undefined;
    if (!memory || memory.memoryLayer !== "L1") {
      throw new Error(`import summary target not found: ${job.targetMemoryId ?? "unknown"}`);
    }
    if (!processingJobMatchesMemory(job, memory)) return;
    const trace = traceMetaFromMemory(memory);
    if (!trace) throw new Error(`import trace payload is missing: ${memory.id}`);

    const generated = this.deps.llm.isConfigured()
      ? await this.deps.summarizeTraceForCapture({ trace, userText: trace.userText, agentText: trace.agentText, toolCalls: trace.toolCalls, reflectionText: "" }, { strict: true })
      : fallbackImportSummary(trace, memory);
    const summary = firstRealSummary(generated) ?? fallbackImportSummary(trace, memory);
    const at = this.deps.nowIso();
    const current = this.deps.repos.memories.get(memory.id);
    if (!current || !processingJobMatchesMemory(job, current)) return;

    this.deps.repos.transaction(() => {
      const previous = current;
      const next = updateImportPipelineStatus(updateTraceImportSummary(current, {
        summary, alpha: IMPORT_DEFAULT_ALPHA, value: IMPORT_DEFAULT_VALUE, priority: IMPORT_DEFAULT_PRIORITY,
        tags: importStatusTags(memory.tags, "indexing"), updatedAt: at
      }), "indexing", at);
      const saved = this.deps.repos.memories.update(next);
      this.appendMemoryChange(saved, previous, "worker.import_summary", at);
      this.scheduleEmbeddingAfterTextUpdate({
        memory: saved,
        sourceJob: job,
        reason: "import.summary.updated",
        vectorField: "vec_summary",
        clearExistingVector: false,
        allowedProcessingStates: ["summary_pending", "summarizing"],
        textOnlyAttemptCount: 0,
        at
      });
    });
  }

  async summarizeCapturedTrace(job: EvolutionJobRecord): Promise<void> {
    const memory = job.targetMemoryId ? this.deps.repos.memories.get(job.targetMemoryId) : undefined;
    if (!memory || memory.memoryLayer !== "L1" || memoryHasImportPipeline(memory)) {
      throw new Error(`trace summary target is invalid: ${job.targetMemoryId ?? "unknown"}`);
    }
    if (!processingJobMatchesMemory(job, memory)) return;
    const trace = traceMetaFromMemory(memory);
    if (!trace) throw new Error(`trace payload is missing: ${memory.id}`);

    const summary = this.deps.llm.isConfigured()
      ? await this.deps.summarizeTraceForCapture({ trace, userText: trace.userText, agentText: trace.agentText, toolCalls: trace.toolCalls, reflectionText: trace.reflection ?? "" }, { strict: true })
      : trace.summary || fallbackTraceSummary(trace);
    const at = this.deps.nowIso();
    const current = this.deps.repos.memories.get(memory.id);
    if (!current || !processingJobMatchesMemory(job, current)) return;
    const currentTrace = traceMetaFromMemory(current);
    if (!currentTrace) throw new Error(`trace payload is missing: ${current.id}`);

    this.deps.repos.transaction(() => {
      const previous = current;
      const saved = summary.trim() && summary.trim() !== currentTrace.summary.trim()
        ? this.deps.repos.memories.update(updateTraceSummary(current, { summary: summary.trim(), updatedAt: at }))
        : previous;
      if (saved !== previous) this.appendMemoryChange(saved, previous, "worker.trace_summary", at);
      this.scheduleEmbeddingAfterTextUpdate({
        memory: saved,
        sourceJob: job,
        reason: "trace.summary.updated",
        vectorField: "vec_summary",
        clearExistingVector: false,
        allowedProcessingStates: ["summary_pending", "summarizing"],
        textOnlyAttemptCount: job.attempts,
        at
      });
    });
  }

  scheduleEmbeddingAfterTextUpdate(input: ScheduleEmbeddingAfterTextUpdateInput): void {
    const { memory, sourceJob, allowedProcessingStates } = input;
    const at = input.at ?? this.deps.nowIso();
    if (input.clearExistingVector && this.deps.repos.processing.get(memory.id)) {
      this.deps.repos.memories.deleteVector(memory.id, input.vectorField);
    }
    if (!this.deps.capture.embedAfterCapture) {
      this.markReadyTextOnly(memory, input.textOnlyAttemptCount, at, allowedProcessingStates);
      return;
    }
    const embeddingJob = this.enqueueEmbeddingJob(memory, sourceJob, at, input.reason);
    this.markEmbeddingPending(memory, embeddingJob.id, at, allowedProcessingStates);
  }

  private enqueueEmbeddingJob(memory: MemoryRow, source: EvolutionJobRecord, at: string, reason: string): EvolutionJobRecord {
    return this.deps.enqueueJob({
      jobType: "embedding", userId: memory.userId, sessionId: memory.sessionId, episodeId: source.episodeId,
      targetMemoryId: memory.id,
      payload: { reason, sourceJobId: source.id, contentHash: memory.contentHash },
      maxAttempts: 6, createdAt: at
    });
  }

  private markReadyTextOnly(memory: MemoryRow, attemptCount: number, at: string, allowedStates?: MemoryProcessingState[]): void {
    this.deps.repos.processing.update(memory.id, {
      state: "ready_text_only", stage: null, activeJobId: null, attemptCount, retryAction: "retry",
      errorCode: null, errorMessage: null, failedAt: null, updatedAt: at
    }, allowedStates);
  }

  private markEmbeddingPending(memory: MemoryRow, activeJobId: string, at: string, allowedStates?: MemoryProcessingState[]): void {
    this.deps.repos.processing.update(memory.id, {
      state: "embedding_pending", stage: "embedding", activeJobId, attemptCount: 0, retryAction: "retry",
      errorCode: null, errorMessage: null, failedAt: null, updatedAt: at
    }, allowedStates);
  }

  private appendMemoryChange(after: MemoryRow, before: MemoryRow, source: string, createdAt: string): void {
    this.deps.repos.runtime.appendChange({
      memoryId: after.id, namespaceId: namespaceIdFromMemory(after), kind: kindFromMemory(after), op: "updated",
      entityId: after.id, userId: after.userId, changeType: "update", before, after, source, createdAt
    });
  }
}

export function updateTraceSummary(memory: MemoryRow, input: { summary: string; updatedAt: string }): MemoryRow {
  const trace = traceMetaFromMemory(memory);
  if (!trace) return memory;
  const internalTrace = isRecord(memory.properties.internal_info.trace) ? memory.properties.internal_info.trace : {};
  const nextTrace = { ...internalTrace, summary: input.summary, summary_at: input.updatedAt };
  return { ...memory, memoryValue: renderTraceMemoryValue({
    summary: input.summary, rawTurnId: stringFromRecord(internalTrace, "raw_turn_id"), stepIndex: numberFromRecord(internalTrace, "step_index"),
    userText: trace.userText, agentText: trace.agentText, toolCalls: trace.toolCalls,
    reflection: { text: trace.reflection, alpha: trace.alpha }, value: trace.value, priority: trace.priority
  }), info: { ...memory.info, summary: input.summary }, properties: {
    ...memory.properties, info: { ...(memory.properties.info ?? {}), summary: input.summary },
    internal_info: { ...memory.properties.internal_info, summary: input.summary, trace: nextTrace }
  }, updatedAt: input.updatedAt };
}

function fallbackImportSummary(trace: TraceMeta, memory: MemoryRow): string {
  const title = stringFromRecord(memory.info, "title");
  const summary = [trace.userText, trace.agentText, title].map((value) => firstLine(value ?? "")).find((value) => value && !isImportSummaryPlaceholder(value));
  return clip(summary || "导入记忆", 200);
}

function fallbackTraceSummary(trace: TraceMeta): string {
  return clip(firstLine([trace.summary, trace.userText, trace.agentText].filter(Boolean).join("\n")) || "trace memory", 200);
}

function renderTraceMemoryValue(step: { summary: string; rawTurnId?: string; stepIndex?: number; userText?: string; agentText?: string; toolCalls: Array<{ name: string; input?: unknown; output?: unknown; error?: string }>; reflection: { text: string | null; alpha: number }; value: number; priority: number }): string {
  return [
    `Summary: ${step.summary}`, step.rawTurnId ? `RawTurn: ${step.rawTurnId}` : undefined,
    typeof step.stepIndex === "number" ? `TraceStep: ${step.stepIndex}` : undefined,
    step.userText ? `User:\n${step.userText}` : undefined,
    step.toolCalls.length ? ["Tool calls:", ...step.toolCalls.map((call) => `- ${call.name}${call.error ? ` error=${clip(call.error, 160)}` : ""}`)].join("\n") : undefined,
    step.agentText ? `Agent:\n${step.agentText}` : undefined,
    step.reflection.text ? `Reflection: ${clip(step.reflection.text, 800)}` : undefined,
    `Alpha: ${step.reflection.alpha}`, `Value: ${step.value}`, `Priority: ${step.priority}`
  ].filter(Boolean).join("\n");
}

function namespaceIdFromMemory(memory: MemoryRow): string {
  const namespace = namespaceForMemory(memory);
  return [namespace.tenantId, namespace.userId, namespace.projectId ?? namespace.workspaceId, namespace.source, namespace.profileId].filter(Boolean).join(":");
}
function stringFromRecord(record: Record<string, unknown>, key: string): string | undefined { const value = record[key]; return typeof value === "string" ? value : undefined; }
function numberFromRecord(record: Record<string, unknown>, key: string): number | undefined { const value = record[key]; return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
