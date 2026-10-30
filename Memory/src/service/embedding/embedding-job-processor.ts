import type { EpisodeSelectionContext } from "../session/episode-selection.js";
import { embeddingIdentity, vectorEmbeddingIdentity } from "../../model/embedding-identity.js";
import { l2VectorCacheKey, readL2VectorCache } from "./l2-vector-cache.js";
import { isRecord } from "../../utils/json.js";

export class SummaryModelUnconfiguredError extends Error {
  constructor() {
    super("summary model is not configured");
    this.name = "SummaryModelUnconfiguredError";
  }
}
import { clip,firstLine } from "../../utils/text.js";
/**
 * Embedding and trace-summary worker domain, extracted from MemoryService.
 *
 * This module intentionally has no MemoryService import.  The host owns the
 * generic job-enqueue policy; this processor owns the job-specific state
 * transitions, model calls, and change records.
 */
import type { TraceCaptureSummary } from "../evolution/span-pipeline.js";
import {
  prunedTurnJudgeInput,
  storedTurnJudgeInput,
  TURN_JUDGE_PROMPT_VERSION,
  turnJudgeSnapshotFromPayload,
  type TurnJudgeSnapshot,
  type TurnJudgment
} from "../evolution/turn-judge.js";
import { retrievalDocumentSourceHash,traceMetaFromMemory } from "../../algorithm/plugin-algorithms.js";
import type { Embedder,LlmClient } from "../../model/types.js";
import type { EmbeddingRetryRecord,EmbeddingRetryVectorField,EpisodeRecord,EvolutionJobRecord,RawTurnRecord,Repositories } from "../../storage/repositories.js";
import { kindFromMemory } from "../../storage/repositories.js";
import type { JobType,MemoryProcessingState,MemoryRow,ToolCallPayload,UserMemoryType } from "../../types.js";
import { stableHash } from "../../utils/id.js";
import { isMemmyRecallToolName } from "../../utils/memmy-context-tags.js";
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
  buildUserMemory,
  isDynamicCurrentFactQuery
} from "../user-memory/user-memory.js";
import {
  embeddingTextForMemory,
  traceSummaryEmbeddingText,
  updateMemoryVectorField
} from "./embedding-pipeline.js";
import { canonicalWorkMemoryText } from "../work-memory/work-memory-pipeline.js";
import { isObservationMemory, isObservationMemoryProcessed, observationJobPayload } from "../observation-memory-state.js";

type TraceMeta = NonNullable<ReturnType<typeof traceMetaFromMemory>>;
type TurnCaptureDecision = {
  createL1: boolean;
  l1Title: string;
  l1Summary: string;
  policyEligible: boolean;
  createUserMemory: boolean;
  userMemoryTypes: UserMemoryType[];
  userMemoryEvidence: Array<{ quote: string; type: UserMemoryType }>;
  userMemoryAction: "none" | "create" | "confirm_existing" | "correct_existing";
  matchedUserMemoryId?: string;
  correctedUserMemoryContent?: string;
  l1Evidence: Array<{ quote: string; sourceRole: "user" | "assistant" | "tool"; kind: string }>;
  reason: string;
  // turn.judge.v1 only. unverifiedAnswer is the final flag after the tool check;
  // turnJudge carries what the model said and the checks recorded.
  unverifiedAnswer?: boolean;
  turnJudge?: TurnJudgeRecord;
};

type TurnJudgeRecord = {
  promptVersion: typeof TURN_JUDGE_PROMPT_VERSION;
  relation: TurnJudgment["relation"];
  feedback: TurnJudgment["feedback"];
  reason: string;
  modelUnverifiedAnswer?: boolean;
  diagnostics: TurnJudgment["diagnostics"];
};

type UserMemoryCaptureResult = {
  action: "created" | "updated" | "confirmed" | "corrected";
  memoryId: string;
  targetMemoryId?: string;
};

export interface PreparedEmbeddingJob {
  job: EvolutionJobRecord;
  memory: MemoryRow;
  text: string;
  role: "document" | "query";
  vectorField: EmbeddingRetryVectorField;
  sourceHash?: string;
  l2VectorCacheKey?: string;
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
  sourceHash?: string;
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
  repos: Pick<Repositories, "transaction" | "memories" | "userMemories" | "processing" | "runtime">;
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
  ): Promise<TraceCaptureSummary>;
  decideTurnMemoryForCapture(input: {
    trace: TraceMeta;
    userText: string;
    agentText: string;
    toolCalls: ToolCallPayload[];
    reflectionText: string;
    mustKeep?: boolean;
  }): Promise<TurnCaptureDecision>;
  buildTurnJudgeSnapshot(input: {
    trace: TraceMeta;
    rawTurn: RawTurnRecord;
    mustKeep: boolean;
    catchUp?: boolean;
    at: string;
  }): TurnJudgeSnapshot;
  judgeTurnForCapture(input: {
    trace: TraceMeta;
    rawTurn: RawTurnRecord;
    snapshot: TurnJudgeSnapshot;
  }): Promise<TurnJudgment>;
  finalizeClosedEpisode(episode: EpisodeRecord, at: string): EvolutionJobRecord[];
  // turn.judge.v1 (PR-2): files the judged turn and records its feedback.
  withEpisodeSelection?<T>(context: EpisodeSelectionContext, operation: () => T): Promise<T>;
  applyTurnJudgment?(input: {
    rawTurnId: string;
    relation: TurnJudgment["relation"];
    feedback: TurnJudgment["feedback"];
    reason: string;
    filedByRule?: string;
    baseEpisodeId?: string;
    previousRawTurnId?: string;
    previousL1MemoryId?: string;
    at: string;
  }): { affectedEpisodeIds: string[]; jobs: EvolutionJobRecord[] };
  // algorithm.session.turnJudgeKeepInput: keep the stored input after a successful judgment.
  turnJudgeKeepInput?(): boolean;
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

  async embedUserMemory(job: EvolutionJobRecord): Promise<void> {
    const memory = job.targetMemoryId
      ? this.deps.repos.userMemories.get(job.targetMemoryId)
      : undefined;
    if (!memory) throw new Error(`user memory embedding target not found: ${job.targetMemoryId ?? "unknown"}`);
    const contentHash = typeof job.payload.contentHash === "string" ? job.payload.contentHash : undefined;
    if (contentHash && contentHash !== stableHash(memory.content)) return;
    const vector = await this.deps.embedder.embedOne(memory.content, "document");
    const current = this.deps.repos.userMemories.get(memory.id);
    if (!current || (contentHash && contentHash !== stableHash(current.content))) return;
    const at = this.deps.nowIso();
    const saved = this.deps.repos.userMemories.updateEmbedding(current.id, vector, {
      ...(vectorEmbeddingIdentity(vector) ?? embeddingIdentity(this.deps.embedder.config)),
      updatedAt: at
    });
    if (!saved) return;
    this.deps.repos.runtime.appendChange({
      memoryId: saved.id,
      kind: "user_memory",
      op: "updated",
      entityId: saved.id,
      userId: saved.userId,
      changeType: "user_memory_embedding_updated",
      before: current,
      after: saved,
      source: "worker.user_memory_embedding",
      createdAt: at
    });
  }

  prepareEmbeddingJob(job: EvolutionJobRecord): PreparedEmbeddingJob | null {
    const memory = job.targetMemoryId ? this.deps.repos.memories.get(job.targetMemoryId) : undefined;
    if (!memory) {
      if (job.targetMemoryId && this.isRejectedCaptureTarget(job.targetMemoryId)) return null;
      throw new Error(`embedding target not found: ${job.targetMemoryId ?? "unknown"}`);
    }
    if (!processingJobMatchesMemory(job, memory)) return null;

    if (isObservationMemory(memory)) {
      if (!isObservationMemoryProcessed(memory)) return null;
      return { job, memory, text: embeddingTextForMemory(memory), role: "document", vectorField: "vec_summary" };
    }

    if (memory.memoryLayer === "L1" && kindFromMemory(memory) === "work_memory") {
      const internal = memory.properties.internal_info;
      const topic = typeof internal.work_topic === "string" ? internal.work_topic : "Work requirements";
      const requirement = typeof internal.requirement === "string" ? internal.requirement : "";
      const reason = typeof internal.reason === "string" ? internal.reason : "";
      return {
        job,
        memory,
        text: canonicalWorkMemoryText(topic, requirement, reason),
        role: "document",
        vectorField: "vec_summary"
      };
    }
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

    const text = embeddingTextForMemory(memory);
    const item: PreparedEmbeddingJob = {
      job,
      memory,
      text,
      role: "query",
      vectorField: "vec",
      sourceHash: memory.memoryLayer === "Skill" || memory.memoryLayer === "L3"
        ? retrievalDocumentSourceHash(memory)
        : undefined,
      l2VectorCacheKey: memory.memoryLayer === "L2" ? l2VectorCacheKey(this.deps.embedder.config, "query", text) : undefined
    };
    if (item.l2VectorCacheKey) {
      const cached = readL2VectorCache(this.deps.repos.runtime, item.l2VectorCacheKey, this.deps.embedder.config);
      if (cached) {
        this.applyEmbeddingVector(item, cached);
        return null;
      }
    }
    return item;
  }

  applyEmbeddingVector(item: PreparedEmbeddingJob, vector: number[]): void {
    const current = this.deps.repos.memories.get(item.memory.id);
    if (!current) {
      if (this.isRejectedCaptureTarget(item.memory.id)) return;
      throw new Error(`embedding target not found: ${item.memory.id}`);
    }
    if (!processingJobMatchesMemory(item.job, current)) return;
    // L2 text may have been revised while this embedding request was in flight.
    if (current.memoryLayer === "L2" && embeddingTextForMemory(current) !== item.text) return;
    if (item.sourceHash && retrievalDocumentSourceHash(current) !== item.sourceHash) return;
    if (item.l2VectorCacheKey && item.l2VectorCacheKey === l2VectorCacheKey(this.deps.embedder.config, item.role, item.text)) {
      const actual = vectorEmbeddingIdentity(vector);
      const expected = embeddingIdentity(this.deps.embedder.config);
      if ((!actual || (actual.provider === expected.provider && actual.model === expected.model))
        && vector.length && vector.every(Number.isFinite) && vector.some((value) => value !== 0)) {
        this.deps.repos.runtime.setKv(item.l2VectorCacheKey, vector, this.deps.nowIso());
      }
    }
    this.persistEmbeddingVector({
      memoryId: current.id,
      vectorField: item.vectorField,
      vector,
      attemptCount: item.job.attempts,
      source: "worker.embedding",
      sourceHash: item.sourceHash,
      allowedProcessingStates: ["embedding_pending", "embedding"]
    });
  }

  persistEmbeddingVector(input: PersistEmbeddingVectorInput): MemoryRow {
    const current = this.deps.repos.memories.get(input.memoryId);
    if (!current) throw new Error(`embedding target not found: ${input.memoryId}`);
    const at = this.deps.nowIso();
    let saved = current;
    this.deps.repos.transaction(() => {
      const vectorized = updateMemoryVectorField(current, input.vectorField, input.vector, {
        ...(vectorEmbeddingIdentity(input.vector) ?? embeddingIdentity(this.deps.embedder.config)),
        updatedAt: at,
        sourceHash: input.sourceHash
      });
      saved = this.deps.repos.memories.updateMaintenance(
        current.memoryLayer === "L1" && input.vectorField !== "vec_action"
          ? updateImportPipelineStatus(vectorized, "indexed", at) : vectorized
      );
      const hadProcessing = input.vectorField !== "vec_action" && Boolean(this.deps.repos.processing.get(saved.id));
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
    if (!this.deps.llm.isConfigured()) throw new SummaryModelUnconfiguredError();

    const generated = await this.deps.summarizeTraceForCapture({ trace, userText: trace.userText, agentText: trace.agentText, toolCalls: trace.toolCalls, reflectionText: "" }, { strict: true });
    const summary = firstRealSummary(generated.summary) ?? fallbackImportSummary(trace, memory);
    const title = generated?.title.trim() || stringFromRecord(memory.info, "title") || "";
    const at = this.deps.nowIso();
    const current = this.deps.repos.memories.get(memory.id);
    if (!current || !processingJobMatchesMemory(job, current)) return;

    this.deps.repos.transaction(() => {
      const previous = current;
      const next = updateImportPipelineStatus(updateTraceImportSummary(current, {
        summary, title, alpha: IMPORT_DEFAULT_ALPHA, value: IMPORT_DEFAULT_VALUE, priority: IMPORT_DEFAULT_PRIORITY,
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
    if (!this.deps.llm.isConfigured()) throw new SummaryModelUnconfiguredError();

    const turnJudge = job.payload.turnJudge === true;
    if (turnJudge && typeof job.payload.turnJudgeNoise === "string") {
      this.skipNoiseTurn(job, memory, trace, job.payload.turnJudgeNoise);
      return;
    }
    const decideCapture = job.payload.decideCapture === true;
    const mustKeep = turnJudge ? isDeviceMemoryForcedCapture(memory, trace) : isForcedL1Capture(memory, trace);
    const judged = turnJudge
      ? await this.judgeCapturedTurn(job, memory, trace, mustKeep)
      : undefined;
    const judgment = judged?.judgment;
    const proposedDecision = judgment
      ? captureDecisionFromTurnJudgment(judgment)
      : decideCapture
      ? await this.deps.decideTurnMemoryForCapture({
          trace,
          userText: trace.userText,
          agentText: trace.agentText,
          toolCalls: trace.toolCalls,
          reflectionText: "",
          mustKeep
        })
      : undefined;
    const proposedSummary = proposedDecision
      ? { title: proposedDecision.l1Title, summary: proposedDecision.l1Summary }
      : await this.deps.summarizeTraceForCapture({ trace, userText: trace.userText, agentText: trace.agentText, toolCalls: trace.toolCalls, reflectionText: "" }, { strict: true });
    const at = this.deps.nowIso();
    const current = this.deps.repos.memories.get(memory.id);
    if (!current || !processingJobMatchesMemory(job, current)) return;
    const currentTrace = traceMetaFromMemory(current);
    if (!currentTrace) throw new Error(`trace payload is missing: ${current.id}`);
    const decision = proposedDecision
      ? judgment
        ? constrainTurnJudgeDecision(proposedDecision, current, currentTrace)
        : constrainTurnMemoryDecision(proposedDecision, current, currentTrace)
      : undefined;
    const title = (decision?.l1Title ?? proposedSummary.title).trim();
    const summary = decision?.l1Summary ?? proposedSummary.summary;
    if (decision?.createL1 && (!title || !summary.trim())) {
      throw new Error("trace summary requires non-empty title and summary");
    }

    let finalizedEpisodeId: string | undefined;
    const affectedEpisodeIds: string[] = [];
    // Filing the turn and its feedback commit with the capture result, after the
    // L1 row is written (the move rewrites its episode); the closing work of
    // every episode it touched runs after the commit.
    const applyJudgment = () => {
      if (!judged || !currentTrace.rawTurnId) return;
      this.recordTurnJudgment(currentTrace.rawTurnId, judged.judgment, at);
      const applied = this.deps.applyTurnJudgment?.({
        rawTurnId: currentTrace.rawTurnId,
        relation: judged.snapshot.taskEmpty ? null : judged.judgment.relation,
        feedback: judged.snapshot.taskEmpty ? null : judged.judgment.feedback,
        reason: judged.judgment.reason,
        ...(judged.snapshot.filedByRule ? { filedByRule: judged.snapshot.filedByRule } : {
          baseEpisodeId: judged.snapshot.baseEpisodeId,
          previousRawTurnId: judged.snapshot.previousRawTurnId,
          previousL1MemoryId: judged.snapshot.previousL1MemoryId
        }),
        at
      });
      if (applied) affectedEpisodeIds.push(...applied.affectedEpisodeIds);
    };
    const commitCapture = () => this.deps.repos.transaction(() => {
      let userMemoryCapture = userMemoryCaptureFromJob(job);
      if (decision?.createUserMemory && job.payload.captureUserMemory === true) {
        userMemoryCapture = this.captureUserMemoryFromDecision(current, currentTrace, decision, job, at);
      }
      if (decision && !decision.createL1) {
        this.recordTurnCaptureDiagnostics(currentTrace, current.id, decision, userMemoryCapture, job, at);
        const rejected = this.deps.repos.memories.update(
          recordTurnMemoryDecision(current, decision, "rejected", at)
        );
        const deleted = this.deps.repos.memories.softDelete(rejected.id, at);
        if (deleted) this.appendMemoryChange(deleted, current, "worker.turn_memory_decision.rejected", at);
        this.deps.repos.processing.delete(current.id);
        const episodeId = currentTrace.episodeId ?? job.episodeId;
        if (episodeId) {
          finalizedEpisodeId = episodeId;
        }
        applyJudgment();
        return;
      }
      const previous = current;
      const summarized = (summary.trim() && summary.trim() !== currentTrace.summary.trim()) ||
        (title && title !== stringFromRecord(current.info, "title"))
        ? this.deps.repos.memories.update(updateTraceSummary(current, { summary: summary.trim(), title, updatedAt: at }))
        : previous;
      const saved = decision
        ? this.deps.repos.memories.update(acceptTurnMemoryDecision(summarized, decision, at))
        : summarized;
      if (saved !== previous) this.appendMemoryChange(saved, previous, "worker.trace_summary", at);
      if (decision) {
        this.recordTurnCaptureDiagnostics(currentTrace, saved.id, decision, userMemoryCapture, job, at);
      }
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
      if (decision) finalizedEpisodeId = currentTrace.episodeId ?? job.episodeId;
      applyJudgment();
    });
    if (this.deps.withEpisodeSelection) {
      const raw = currentTrace.rawTurnId ? this.deps.repos.runtime.getRawTurn(currentTrace.rawTurnId) : undefined;
      await this.deps.withEpisodeSelection({ userText: raw?.userText ?? "", rawTurnId: raw?.id }, () => {
        affectedEpisodeIds.length = 0;
        commitCapture();
      });
    } else {
      commitCapture();
    }
    const movedTo = judged && currentTrace.rawTurnId
      ? this.deps.repos.runtime.getRawTurn(currentTrace.rawTurnId)?.episodeId
      : undefined;
    for (const episodeId of new Set([finalizedEpisodeId, movedTo, ...affectedEpisodeIds])) {
      if (!episodeId) continue;
      const episode = this.deps.repos.runtime.getEpisode(episodeId);
      if (episode?.status === "closed") this.deps.finalizeClosedEpisode(episode, at);
    }
  }

  // A host-generated turn (task notification, heartbeat, ...) is recognised by
  // its structure and never sent to the model: no L1, no routing, no feedback.
  private skipNoiseTurn(job: EvolutionJobRecord, memory: MemoryRow, trace: TraceMeta, noiseKind: string): void {
    const at = this.deps.nowIso();
    let finalizedEpisodeId: string | undefined;
    this.deps.repos.transaction(() => {
      const current = this.deps.repos.memories.get(memory.id);
      if (!current || !processingJobMatchesMemory(job, current)) return;
      const rawTurn = trace.rawTurnId ? this.deps.repos.runtime.getRawTurn(trace.rawTurnId) : undefined;
      if (rawTurn) {
        this.deps.repos.runtime.updateRawTurn({
          ...rawTurn,
          messagePayload: {
            ...rawTurn.messagePayload,
            turn_judge: { prompt_version: TURN_JUDGE_PROMPT_VERSION, status: "skipped", noise_kind: noiseKind, judged_at: at }
          }
        });
      }
      const pending = isRecord(current.properties.internal_info.capture_decision) ? current.properties.internal_info.capture_decision : {};
      const rejected = this.deps.repos.memories.update({
        ...current,
        properties: {
          ...current.properties,
          internal_info: {
            ...current.properties.internal_info,
            capture_decision: {
              ...pending,
              status: "rejected",
              create_l1: false,
              prompt_version: TURN_JUDGE_PROMPT_VERSION,
              reason: `noise:${noiseKind}`,
              decided_at: at
            }
          }
        },
        updatedAt: at
      });
      const deleted = this.deps.repos.memories.softDelete(rejected.id, at);
      if (deleted) this.appendMemoryChange(deleted, current, "worker.turn_judge.noise", at);
      this.deps.repos.processing.delete(current.id);
      finalizedEpisodeId = trace.episodeId ?? job.episodeId;
    });
    if (finalizedEpisodeId) {
      const episode = this.deps.repos.runtime.getEpisode(finalizedEpisodeId);
      if (episode?.status === "closed") this.deps.finalizeClosedEpisode(episode, at);
    }
  }

  // A per-turn judgment that failed on every attempt: the L1 is not written,
  // the turn stays where it was filed, no feedback is recorded, and the
  // capture record is marked failed so the task's closing work can run. A
  // manual retry rebuilds the job with the same flags and input.
  markTurnJudgeFailed(job: EvolutionJobRecord): void {
    const at = this.deps.nowIso();
    let finalizedEpisodeId: string | undefined;
    this.deps.repos.transaction(() => {
      const memory = job.targetMemoryId ? this.deps.repos.memories.get(job.targetMemoryId) : undefined;
      if (!memory) return;
      const pending = isRecord(memory.properties.internal_info.capture_decision) ? memory.properties.internal_info.capture_decision : {};
      if (pending.status !== "pending") return;
      const failed = this.deps.repos.memories.update({
        ...memory,
        properties: {
          ...memory.properties,
          internal_info: {
            ...memory.properties.internal_info,
            capture_decision: {
              ...pending,
              status: "failed",
              prompt_version: TURN_JUDGE_PROMPT_VERSION,
              failed_at: at,
              error: job.lastError ?? null
            }
          }
        },
        updatedAt: at
      });
      this.appendMemoryChange(failed, memory, "worker.turn_judge.failed", at);
      const trace = traceMetaFromMemory(failed);
      const rawTurn = trace?.rawTurnId ? this.deps.repos.runtime.getRawTurn(trace.rawTurnId) : undefined;
      if (rawTurn) {
        const stored = isRecord(rawTurn.messagePayload?.turn_judge) ? rawTurn.messagePayload.turn_judge : {};
        this.deps.repos.runtime.updateRawTurn({
          ...rawTurn,
          messagePayload: {
            ...rawTurn.messagePayload,
            turn_judge: { ...stored, prompt_version: TURN_JUDGE_PROMPT_VERSION, status: "failed", failed_at: at }
          }
        });
      }
      finalizedEpisodeId = trace?.episodeId ?? job.episodeId;
    });
    if (finalizedEpisodeId) {
      const episode = this.deps.repos.runtime.getEpisode(finalizedEpisodeId);
      if (episode?.status === "closed") this.deps.finalizeClosedEpisode(episode, at);
    }
  }

  // Builds the input once (stored on the raw turn) and reuses it on every
  // retry, so a later attempt does not see turns stored after this one.
  private async judgeCapturedTurn(
    job: EvolutionJobRecord,
    memory: MemoryRow,
    trace: TraceMeta,
    mustKeep: boolean
  ): Promise<{ judgment: TurnJudgment; snapshot: TurnJudgeSnapshot }> {
    const rawTurn = trace.rawTurnId ? this.deps.repos.runtime.getRawTurn(trace.rawTurnId) : undefined;
    if (!rawTurn) throw new Error(`turn judgment raw turn is missing: ${memory.id}`);
    const previousDecision = isRecord(memory.properties.internal_info.capture_decision)
      ? memory.properties.internal_info.capture_decision
      : undefined;
    if (previousDecision?.status === "failed") {
      // A rerun after the failed state: hold the task's closing work again until it is judged.
      this.deps.repos.memories.update({
        ...memory,
        properties: {
          ...memory.properties,
          internal_info: { ...memory.properties.internal_info, capture_decision: { ...previousDecision, status: "pending" } }
        }
      });
    }
    const stored = isRecord(rawTurn.messagePayload?.turn_judge) ? rawTurn.messagePayload.turn_judge : {};
    let snapshot = turnJudgeSnapshotFromPayload(stored.input);
    if (!snapshot) {
      snapshot = this.deps.buildTurnJudgeSnapshot({
        trace,
        rawTurn,
        mustKeep,
        catchUp: job.payload.turnJudgeCatchUp === true,
        at: this.deps.nowIso()
      });
      this.deps.repos.runtime.updateRawTurn({
        ...rawTurn,
        messagePayload: {
          ...rawTurn.messagePayload,
          turn_judge: { ...stored, prompt_version: TURN_JUDGE_PROMPT_VERSION, status: "pending", input: storedTurnJudgeInput(snapshot) }
        }
      });
    }
    return { judgment: await this.deps.judgeTurnForCapture({ trace, rawTurn, snapshot }), snapshot };
  }

  private recordTurnJudgment(rawTurnId: string, judgment: TurnJudgment, at: string): void {
    const rawTurn = this.deps.repos.runtime.getRawTurn(rawTurnId);
    if (!rawTurn) return;
    const stored = isRecord(rawTurn.messagePayload?.turn_judge) ? rawTurn.messagePayload.turn_judge : {};
    this.deps.repos.runtime.updateRawTurn({
      ...rawTurn,
      messagePayload: {
        ...rawTurn.messagePayload,
        turn_judge: {
          ...stored,
          ...(this.deps.turnJudgeKeepInput?.() ? {} : { input: prunedTurnJudgeInput(stored.input) }),
          prompt_version: TURN_JUDGE_PROMPT_VERSION,
          status: "judged",
          judged_at: at,
          relation: judgment.relation,
          feedback: judgment.feedback,
          reason: judgment.reason,
          diagnostics: judgment.diagnostics
        }
      }
    });
  }

  private isRejectedCaptureTarget(memoryId: string): boolean {
    const memory = this.deps.repos.memories.getIncludingDeleted(memoryId);
    const decision = memory && isRecord(memory.properties.internal_info.capture_decision)
      ? memory.properties.internal_info.capture_decision
      : undefined;
    return decision?.status === "rejected";
  }

  private captureUserMemoryFromDecision(
    sourceMemory: MemoryRow,
    trace: TraceMeta,
    decision: TurnCaptureDecision,
    job: EvolutionJobRecord,
    at: string
  ): UserMemoryCaptureResult | undefined {
    const content = decision.userMemoryAction === "correct_existing"
      ? decision.correctedUserMemoryContent?.trim() ?? ""
      : trace.userText.trim();
    const sourceTurnId = trace.rawTurnId;
    if (!content || !sourceTurnId || decision.userMemoryTypes.length === 0) return undefined;
    const sourceAt = Number.isFinite(trace.ts) ? new Date(trace.ts).toISOString() : at;
    if (decision.userMemoryAction === "confirm_existing" && decision.matchedUserMemoryId) {
      const confirmed = this.deps.repos.userMemories.confirmExisting({
        id: decision.matchedUserMemoryId,
        userId: sourceMemory.userId,
        sourceTurnId,
        memoryTypes: decision.userMemoryTypes,
        updatedAt: sourceAt
      });
      if (!confirmed) return undefined;
      this.deps.repos.runtime.appendChange({
        memoryId: confirmed.memory.id,
        kind: "user_memory",
        op: "updated",
        entityId: confirmed.memory.id,
        userId: confirmed.memory.userId,
        changeType: "user_memory_confirmed",
        before: confirmed.previous,
        after: confirmed.memory,
        source: "worker.turn_memory_decision",
        createdAt: at
      });
      return { action: "confirmed", memoryId: confirmed.memory.id };
    }
    const correctionTarget = decision.userMemoryAction === "correct_existing" && decision.matchedUserMemoryId
      ? this.deps.repos.userMemories.get(decision.matchedUserMemoryId)
      : undefined;
    if (
      decision.userMemoryAction === "correct_existing" &&
      (!correctionTarget || correctionTarget.userId !== sourceMemory.userId || correctionTarget.status !== "active")
    ) return undefined;
    const candidate = buildUserMemory({
      id: `user_memory_${stableHash(`${sourceTurnId}:${content}`).slice(0, 20)}`,
      sourceTurnId,
      userId: sourceMemory.userId,
      memoryTypes: decision.userMemoryTypes,
      content,
      createdAt: sourceAt,
      ...(correctionTarget ? { replacesMemoryId: correctionTarget.id } : {})
    });
    const upsert = this.deps.repos.userMemories.upsertExact(candidate);
    if (correctionTarget && upsert.memory.id === correctionTarget.id) {
      throw new Error("user memory correction must change the target content");
    }
    this.deps.repos.runtime.appendChange({
      memoryId: upsert.memory.id,
      kind: "user_memory",
      op: upsert.created ? "created" : "updated",
      entityId: upsert.memory.id,
      userId: upsert.memory.userId,
      changeType: upsert.created ? "user_memory_created" : "user_memory_updated",
      before: upsert.previous,
      after: upsert.memory,
      source: "worker.turn_memory_decision",
      createdAt: at
    });
    if (correctionTarget) {
      const archived = this.deps.repos.userMemories.archiveForCorrection(
        correctionTarget.id,
        upsert.memory.id,
        at
      );
      if (archived) {
        this.deps.repos.runtime.appendChange({
          memoryId: archived.id,
          kind: "user_memory",
          op: "archived",
          entityId: archived.id,
          userId: archived.userId,
          changeType: "user_memory_archived",
          before: correctionTarget,
          after: archived,
          source: "worker.turn_memory_decision",
          createdAt: at
        });
      }
    }
    if (upsert.created && this.deps.capture.embedAfterCapture) {
      this.deps.enqueueJob({
        jobType: "user_memory_embedding",
        userId: upsert.memory.userId,
        sessionId: sourceMemory.sessionId,
        episodeId: job.episodeId,
        targetMemoryId: upsert.memory.id,
        payload: { contentHash: stableHash(upsert.memory.content) },
        maxAttempts: 6,
        createdAt: at
      });
    }
    return {
      action: correctionTarget ? "corrected" : upsert.created ? "created" : "updated",
      memoryId: upsert.memory.id,
      ...(correctionTarget ? { targetMemoryId: correctionTarget.id } : {})
    };
  }

  private recordTurnCaptureDiagnostics(
    trace: TraceMeta,
    l1MemoryId: string,
    decision: TurnCaptureDecision,
    userMemoryCapture: UserMemoryCaptureResult | undefined,
    job: EvolutionJobRecord,
    at: string
  ): void {
    if (!trace.rawTurnId) return;
    const rawTurn = this.deps.repos.runtime.getRawTurn(trace.rawTurnId);
    if (!rawTurn) return;
    const turnComplete = isRecord(rawTurn.messagePayload?.turn_complete)
      ? rawTurn.messagePayload.turn_complete
      : {};
    const previous = isRecord(turnComplete.memory_capture) ? turnComplete.memory_capture : {};
    const previousL1 = Array.isArray(previous.l1)
      ? previous.l1.filter(isRecord)
      : [];
    const l1 = [
      ...previousL1.filter((item) => item.memory_id !== l1MemoryId),
      {
        memory_id: l1MemoryId,
        written: decision.createL1,
        policy_eligible: decision.policyEligible
      }
    ];
    const recordsUserMemory = job.payload.captureUserMemory === true || Boolean(userMemoryCapture);
    this.deps.repos.runtime.updateRawTurn({
      ...rawTurn,
      messagePayload: {
        ...rawTurn.messagePayload,
        turn_complete: {
          ...turnComplete,
          memory_capture: {
            status: "completed",
            decided_at: at,
            l1,
            ...(recordsUserMemory ? {
              user_memory: {
                written: Boolean(userMemoryCapture),
                action: userMemoryCapture?.action ?? "none",
                memory_id: userMemoryCapture?.memoryId,
                target_memory_id: userMemoryCapture?.targetMemoryId
              }
            } : isRecord(previous.user_memory) ? { user_memory: previous.user_memory } : {})
          }
        }
      }
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
      payload: { reason, sourceJobId: source.id, ...observationJobPayload(memory) },
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
      updatedAt: at
    }, allowedStates);
  }

  private appendMemoryChange(after: MemoryRow, before: MemoryRow, source: string, createdAt: string): void {
    this.deps.repos.runtime.appendChange({
      memoryId: after.id, namespaceId: namespaceIdFromMemory(after), kind: kindFromMemory(after), op: "updated",
      entityId: after.id, userId: after.userId, changeType: "update", before, after, source, createdAt
    });
  }
}

export function updateTraceSummary(memory: MemoryRow, input: { summary: string; title?: string; updatedAt: string }): MemoryRow {
  const trace = traceMetaFromMemory(memory);
  if (!trace) return memory;
  const internalTrace = isRecord(memory.properties.internal_info.trace) ? memory.properties.internal_info.trace : {};
  const title = input.title?.trim();
  const nextTrace = {
    ...internalTrace,
    summary: input.summary,
    summary_at: input.updatedAt,
    ...(title ? { title } : {})
  };
  const memoryValue = renderTraceMemoryValue({
    summary: input.summary, rawTurnId: stringFromRecord(internalTrace, "raw_turn_id"), stepIndex: numberFromRecord(internalTrace, "step_index"),
    userText: trace.userText, agentText: trace.agentText, toolCalls: trace.toolCalls,
    reflection: { text: trace.reflection, alpha: trace.alpha }, value: trace.value, priority: trace.priority
  });
  return { ...memory, memoryValue, contentHash: stableHash(memoryValue), info: { ...memory.info, summary: input.summary, ...(title ? { title } : {}) }, properties: {
    ...memory.properties, info: { ...(memory.properties.info ?? {}), summary: input.summary, ...(title ? { title } : {}) },
    internal_info: { ...memory.properties.internal_info, summary: input.summary, ...(title ? { title } : {}), trace: nextTrace }
  }, updatedAt: input.updatedAt };
}

function acceptTurnMemoryDecision(
  memory: MemoryRow,
  decision: TurnCaptureDecision,
  updatedAt: string
): MemoryRow {
  const internal = memory.properties.internal_info;
  const pending = isRecord(internal.capture_decision) ? internal.capture_decision : {};
  const pendingEvidenceStatus = typeof pending.original_evidence_status === "string"
    ? pending.original_evidence_status
    : undefined;
  // turn.judge.v1: only the model's unverified_answer (after the tool check)
  // marks an L1 provisional; a verified tool observation stays verified.
  const originalEvidenceStatus = decision.unverifiedAnswer === undefined
    ? pendingEvidenceStatus
    : decision.unverifiedAnswer
      ? "provisional"
      : pendingEvidenceStatus === "verified" ? "verified" : undefined;
  const observedAt = typeof internal.observed_at === "string" ? internal.observed_at : updatedAt;
  const unverifiedFields = decision.unverifiedAnswer === true ? { observed_at: observedAt } : {};
  const unverifiedClaims = decision.unverifiedAnswer === true
    ? {
        observed_at: observedAt,
        claims: [{ source_role: "agent", evidence_status: "provisional", observed_at: observedAt }]
      }
    : {};
  const { evidence_status: _infoEvidenceStatus, ...info } = memory.info;
  const { evidence_status: _propertyInfoEvidenceStatus, ...propertyInfo } = memory.properties.info ?? {};
  const { evidence_status: _internalEvidenceStatus, ...internalWithoutEvidence } = internal;
  return {
    ...memory,
    status: "activated",
    info: {
      ...info,
      ...unverifiedFields,
      policy_eligible: decision.policyEligible,
      ...(originalEvidenceStatus ? { evidence_status: originalEvidenceStatus } : {})
    },
    properties: {
      ...memory.properties,
      status: "activated",
      info: {
        ...propertyInfo,
        ...unverifiedFields,
        policy_eligible: decision.policyEligible,
        ...(originalEvidenceStatus ? { evidence_status: originalEvidenceStatus } : {})
      },
      internal_info: {
        ...internalWithoutEvidence,
        ...unverifiedClaims,
        policy_eligible: decision.policyEligible,
        ...(originalEvidenceStatus ? { evidence_status: originalEvidenceStatus } : {}),
        capture_decision: recordTurnMemoryDecisionFields(pending, decision, "accepted", updatedAt)
      }
    },
    updatedAt
  };
}

function recordTurnMemoryDecision(
  memory: MemoryRow,
  decision: TurnCaptureDecision,
  status: "accepted" | "rejected",
  updatedAt: string
): MemoryRow {
  const internal = memory.properties.internal_info;
  const pending = isRecord(internal.capture_decision) ? internal.capture_decision : {};
  return {
    ...memory,
    properties: {
      ...memory.properties,
      internal_info: {
        ...internal,
        capture_decision: recordTurnMemoryDecisionFields(pending, decision, status, updatedAt)
      }
    },
    updatedAt
  };
}

function recordTurnMemoryDecisionFields(
  pending: Record<string, unknown>,
  decision: TurnCaptureDecision,
  status: "accepted" | "rejected",
  updatedAt: string
): Record<string, unknown> {
  return {
    ...pending,
    status,
    create_l1: decision.createL1,
    policy_eligible: decision.policyEligible,
    create_user_memory: decision.createUserMemory,
    user_memory_types: decision.userMemoryTypes,
    user_memory_evidence: decision.userMemoryEvidence,
    user_memory_action: decision.userMemoryAction,
    matched_user_memory_id: decision.matchedUserMemoryId,
    corrected_user_memory_content: decision.correctedUserMemoryContent,
    l1_evidence: decision.l1Evidence.map((item) => ({
      quote: item.quote,
      source_role: item.sourceRole,
      kind: item.kind
    })),
    reason: decision.reason,
    decided_at: updatedAt,
    ...(decision.turnJudge ? {
      prompt_version: decision.turnJudge.promptVersion,
      ...(decision.turnJudge.modelUnverifiedAnswer !== undefined
        ? { unverified_answer: decision.turnJudge.modelUnverifiedAnswer }
        : {}),
      turn_judge: {
        relation: decision.turnJudge.relation,
        feedback: decision.turnJudge.feedback,
        reason: decision.turnJudge.reason,
        dropped_quotes: decision.turnJudge.diagnostics.droppedQuotes,
        quote_fixes: decision.turnJudge.diagnostics.quoteFixes,
        violations: decision.turnJudge.diagnostics.violations
      }
    } : {})
  };
}

function captureDecisionFromTurnJudgment(judgment: TurnJudgment): TurnCaptureDecision {
  const l1 = judgment.l1;
  const user = judgment.user;
  const userMemoryEvidence = user?.evidence ?? [];
  return {
    createL1: Boolean(l1),
    l1Title: l1?.title ?? "",
    l1Summary: l1?.summary ?? "",
    policyEligible: Boolean(l1?.evidence.some((item) =>
      item.kind === "user_preference" ||
      item.kind === "user_directive" ||
      item.kind === "decision" ||
      item.kind === "correction" ||
      item.kind === "task_outcome"
    )),
    createUserMemory: Boolean(user),
    userMemoryTypes: uniq(userMemoryEvidence.map((item) => item.type)),
    userMemoryEvidence,
    userMemoryAction: user?.action === "confirm"
      ? "confirm_existing"
      : user?.action === "correct"
        ? "correct_existing"
        : user ? "create" : "none",
    ...(user && user.action !== "create" ? { matchedUserMemoryId: user.target } : {}),
    ...(user?.action === "correct" ? { correctedUserMemoryContent: user.replacement } : {}),
    l1Evidence: l1?.evidence ?? [],
    reason: "",
    ...(l1 ? { unverifiedAnswer: l1.unverifiedAnswer } : {}),
    turnJudge: {
      promptVersion: TURN_JUDGE_PROMPT_VERSION,
      relation: judgment.relation,
      feedback: judgment.feedback,
      reason: judgment.reason,
      ...(l1 ? { modelUnverifiedAnswer: l1.unverifiedAnswer } : {}),
      diagnostics: judgment.diagnostics
    }
  };
}

// turn.judge.v1 keeps only the checks that rules can settle: no real-time
// keyword guard, and an L1 the model marks unverified stays unverified only
// when the turn has no non-recall tool result.
function constrainTurnJudgeDecision(
  decision: TurnCaptureDecision,
  memory: MemoryRow,
  trace: TraceMeta
): TurnCaptureDecision {
  const userMemoryTypes = uniq(decision.userMemoryEvidence.map((item) => item.type));
  const verifiedToolObservation = hasVerifiedDurableToolObservation(memory, trace, false);
  const createUserMemory = userMemoryTypes.length > 0 &&
    decision.createUserMemory && decision.userMemoryEvidence.length > 0;
  const guards: string[] = [];
  if (decision.createUserMemory && decision.userMemoryEvidence.length === 0) {
    guards.push("user-memory-evidence-missing");
  }
  if (decision.createL1 && decision.l1Evidence.length === 0) {
    guards.push("l1-evidence-missing");
  }
  const unverified = decision.createL1 && decision.unverifiedAnswer === true && !verifiedToolObservation;
  return {
    ...decision,
    policyEligible: unverified ? false : isPolicyEligibleCapture(decision, decision.createL1, verifiedToolObservation),
    createUserMemory,
    userMemoryTypes: createUserMemory ? userMemoryTypes : [],
    userMemoryAction: createUserMemory ? decision.userMemoryAction : "none",
    matchedUserMemoryId: createUserMemory ? decision.matchedUserMemoryId : undefined,
    correctedUserMemoryContent: createUserMemory ? decision.correctedUserMemoryContent : undefined,
    ...(decision.createL1 ? { unverifiedAnswer: unverified } : {}),
    reason: guards.length > 0 ? `guards=${guards.join(",")}` : ""
  };
}

// turn.judge.v1 narrows forced L1 to the device memory observation (BC-04),
// with its original conditions unchanged.
export function isDeviceMemoryForcedCapture(memory: MemoryRow, trace: TraceMeta): boolean {
  return (memory.memoryKey ?? "").startsWith("trace:environment:device:") && isForcedL1Capture(memory, trace);
}

function constrainTurnMemoryDecision(
  decision: TurnCaptureDecision,
  memory: MemoryRow,
  trace: TraceMeta
): typeof decision {
  const text = trace.userText.trim();
  const evidenceTypes = decision.userMemoryEvidence.map((item) => item.type);
  const userMemoryTypes = uniq(evidenceTypes);
  const dynamicCurrent = isDynamicCurrentFactQuery(text);
  const verifiedToolObservation = hasVerifiedDurableToolObservation(memory, trace, dynamicCurrent);

  const createUserMemory = !dynamicCurrent && userMemoryTypes.length > 0 &&
    decision.createUserMemory && decision.userMemoryEvidence.length > 0;
  let createL1 = decision.createL1;
  const guards: string[] = [];
  if (decision.createUserMemory && decision.userMemoryEvidence.length === 0) {
    guards.push("user-memory-evidence-missing");
  }
  if (decision.createL1 && decision.l1Evidence.length === 0) {
    guards.push("l1-evidence-missing");
  }
  if (dynamicCurrent) {
    createL1 = false;
    guards.push("dynamic-current");
  } else if (verifiedToolObservation) {
    createL1 = true;
    guards.push("verified-tool-evidence");
  }
  const policyEligible = isPolicyEligibleCapture(decision, createL1, verifiedToolObservation);

  return {
    ...decision,
    createL1,
    l1Title: createL1 ? decision.l1Title.trim() : "",
    l1Summary: createL1 ? decision.l1Summary.trim() : "",
    policyEligible,
    createUserMemory,
    userMemoryTypes: createUserMemory ? userMemoryTypes : [],
    userMemoryAction: createUserMemory ? decision.userMemoryAction : "none",
    matchedUserMemoryId: createUserMemory ? decision.matchedUserMemoryId : undefined,
    reason: clip([decision.reason, guards.length > 0 ? `guards=${guards.join(",")}` : ""].filter(Boolean).join("; "), 300)
  };
}

function isPolicyEligibleCapture(
  decision: TurnCaptureDecision,
  createL1: boolean,
  verifiedToolObservation: boolean
): boolean {
  if (!createL1 || !decision.policyEligible) return false;
  return decision.l1Evidence.some((evidence) => {
    if (
      evidence.sourceRole === "user" &&
      (evidence.kind === "user_preference" ||
        evidence.kind === "user_directive" ||
        evidence.kind === "decision" ||
        evidence.kind === "correction")
    ) return true;
    if (evidence.kind !== "task_outcome") return false;
    return evidence.sourceRole === "user" || evidence.sourceRole === "tool" || verifiedToolObservation;
  });
}

export function isForcedL1Capture(memory: MemoryRow, trace: TraceMeta): boolean {
  return hasVerifiedDurableToolObservation(memory, trace, isDynamicCurrentFactQuery(trace.userText.trim()));
}

function hasVerifiedDurableToolObservation(
  memory: MemoryRow,
  trace: TraceMeta,
  dynamicCurrent: boolean
): boolean {
  if (dynamicCurrent || trace.toolCalls.length === 0) return false;
  const captureDecision = isRecord(memory.properties.internal_info.capture_decision)
    ? memory.properties.internal_info.capture_decision
    : {};
  if (captureDecision.original_evidence_status !== "verified") return false;
  return trace.toolCalls.some((call) => !isMemmyRecallToolName(call.name));
}

function uniq<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function userMemoryCaptureFromJob(job: EvolutionJobRecord): UserMemoryCaptureResult | undefined {
  const memoryId = Array.isArray(job.payload.capturedUserMemoryIds)
    ? job.payload.capturedUserMemoryIds.find((id): id is string => typeof id === "string" && id.length > 0)
    : undefined;
  if (!memoryId) return undefined;
  const corrected = job.payload.capturedUserMemoryAction === "corrected";
  return {
    action: corrected ? "corrected" : "created",
    memoryId,
    ...(corrected && typeof job.payload.capturedUserMemoryTargetId === "string"
      ? { targetMemoryId: job.payload.capturedUserMemoryTargetId }
      : {})
  };
}

function fallbackImportSummary(trace: TraceMeta, memory: MemoryRow): string {
  const title = stringFromRecord(memory.info, "title");
  const summary = [trace.userText, trace.agentText, title].map((value) => firstLine(value ?? "")).find((value) => value && !isImportSummaryPlaceholder(value));
  return clip(summary || "导入记忆", 200);
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
