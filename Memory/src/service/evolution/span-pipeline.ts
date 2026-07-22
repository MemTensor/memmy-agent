import {
  BATCH_REFLECTION_PROMPT,
  REFLECTION_SCORE_PROMPT,
  detectDominantLanguage,
  languageSteeringLine,
  traceMetaFromMemory
} from "../../algorithm/plugin-algorithms.js";
import { MEMORY_SUMMARY_MAX_TOKENS,type MemmyConfig } from "../../config/index.js";
import { createMemoryLogger,memoryErrorFields } from "../../logging/logger.js";
import type { LlmClient } from "../../model/types.js";
import {
  kindFromMemory,
  type EpisodeRecord,
  type EvolutionJobRecord,
  type RawTurnRecord,
  type Repositories
} from "../../storage/repositories.js";
import type { MemoryRow,ToolCallPayload } from "../../types.js";
import { stableStringify } from "../../utils/id.js";
import { isRecord,stringifyForMemory } from "../../utils/json.js";
import { clip,firstLine } from "../../utils/text.js";
import { nowIso } from "../../utils/time.js";
import type { ScheduleEmbeddingAfterTextUpdateInput } from "../embedding/embedding-job-processor.js";
import {
  importStatusTags,
  memoryHasImportPipeline,
  updateImportPipelineStatus
} from "../import/import-job-processor.js";
import { summarizeTurn as sessionSummarizeTurn } from "../session/session-turn-service.js";
import type { EnqueueJobInput } from "../worker/job-handlers.js";

type TraceMeta = NonNullable<ReturnType<typeof traceMetaFromMemory>>;

const pipelineLogger = createMemoryLogger("pipeline");

export interface SpanPipelineDeps {
  repos: Repositories;
  config: MemmyConfig;
  llm: LlmClient;
  skillLlm: LlmClient;
  traceMeta(memory: MemoryRow | undefined | null): TraceMeta | null;
  namespaceIdFromMemory(memory: MemoryRow): string;
  enqueueJob(input: EnqueueJobInput): EvolutionJobRecord;
  scheduleEmbeddingAfterTextUpdate(input: ScheduleEmbeddingAfterTextUpdateInput): void;
  enqueueEpisodeRewardAfterReflection(episode: EpisodeRecord, at: string, trigger: string): EvolutionJobRecord[];
}

export class SpanPipeline {
  constructor(private readonly deps: SpanPipelineDeps) {}

  async reflectTrace(job: EvolutionJobRecord): Promise<void> {
    const memory = job.targetMemoryId ? this.deps.repos.memories.get(job.targetMemoryId) : undefined;
    if (!memory || memory.memoryLayer !== "L1") {
      return;
    }
    const trace = this.deps.traceMeta(memory);
    if (!trace || traceReflectionWasScored(memory)) {
      return;
    }
    const episodeId = job.episodeId ?? trace.episodeId;
    const episode = episodeId ? this.deps.repos.runtime.getEpisode(episodeId) : undefined;
    if (episodeId && (!episode || episode.status !== "closed")) {
      return;
    }
    if (!this.deps.skillLlm.isConfigured()) {
      if (this.applyUnconfiguredEpisodeDefault(job)) {
        if (episode) {
          this.deps.enqueueEpisodeRewardAfterReflection(episode, nowIso(), "implicit_fallback");
        }
        return;
      }
      this.applyUnconfiguredTraceDefault(job, memory, trace);
      if (episode) {
        this.deps.enqueueEpisodeRewardAfterReflection(episode, nowIso(), "implicit_fallback");
      }
      return;
    }
    if (await this.reflectEpisodeBatch(job)) {
      if (episode) {
        this.deps.enqueueEpisodeRewardAfterReflection(episode, nowIso(), "implicit_fallback");
      }
      return;
    }
    this.applyUnconfiguredTraceDefault(job, memory, trace);
    if (episode) {
      this.deps.enqueueEpisodeRewardAfterReflection(episode, nowIso(), "implicit_fallback");
    }
  }

private async reflectSingleTrace(
    job: EvolutionJobRecord,
    memory: MemoryRow,
    trace: NonNullable<ReturnType<typeof traceMetaFromMemory>>
  ): Promise<void> {
    const rawTurnId = rawTurnIdFromMemory(memory);
    const rawTurn = rawTurnId ? this.deps.repos.runtime.getRawTurn(rawTurnId) : undefined;
    const userText = rawTurn?.userText ?? trace.userText;
    const agentText = rawTurn?.assistantText ?? trace.agentText;
    const toolCalls = rawTurn?.toolCalls.filter(isToolCallPayload) ?? trace.toolCalls;
    const agentThinking = traceAgentThinking(memory);
    const taskSummary = this.reflectionTaskSummary(job, trace.summary);
    const downstreamPreview = this.reflectionDownstreamPreview(job, memory);
    const synthesized = trace.reflection
      ? null
      : await this.synthesizeTraceReflection({
        trace,
        taskSummary,
        userText,
        agentThinking,
        agentText,
        toolCalls,
        downstreamPreview
      });
    const reflectionText = trace.reflection ?? synthesized ?? "";
    const reflectionLang = detectDominantLanguage([
      userText,
      agentText,
      agentThinking,
      reflectionText
    ]);
    const summarized = await this.summarizeTraceForCapture({
      trace,
      userText,
      agentText,
      toolCalls,
      reflectionText
    });

    if (!this.deps.config.algorithm.capture.alphaScoring) {
      const reflection = reflectionText || "RELATED_DEFAULT";
      const usable = true;
      const at = nowIso();
      const previous = memory;
      const saved = this.deps.repos.memories.update(updateImportPipelineStatus(updateTraceReflection(memory, {
        summary: summarized,
        reflection,
        alpha: 0.5,
        usable,
        source: trace.reflection ? traceReflectionSource(memory) : "synth",
        tags: memoryHasImportPipeline(memory) ? importStatusTags(memory.tags, "indexing") : memory.tags,
        updatedAt: at
      }), "indexing", at));
      this.deps.repos.runtime.appendChange({
        memoryId: saved.id,
        namespaceId: this.deps.namespaceIdFromMemory(saved),
        kind: kindFromMemory(saved),
        op: "updated",
        entityId: saved.id,
        userId: saved.userId,
        changeType: "update",
        before: previous,
        after: saved,
        source: "worker.reflection.neutral_alpha",
        createdAt: at
      });
      this.enqueuePostReflectionEmbedding(saved, job, at);
      return;
    }

    const result = await this.deps.skillLlm.completeJson<{
      summary?: unknown;
      reflection?: unknown;
      alpha?: unknown;
      usable?: unknown;
      tags?: unknown;
      reason?: unknown;
    }>([
      {
        role: "system",
        content: REFLECTION_SCORE_PROMPT.system
      },
      {
        role: "system",
        content: languageSteeringLine(reflectionLang)
      },
      {
        role: "user",
        content: traceReflectionScorePayload({
          taskSummary,
          userText,
          agentThinking,
          agentText,
          toolCalls,
          downstreamPreview,
          reflectionText
        })
      }
    ], {
      operation: `capture.alpha.${REFLECTION_SCORE_PROMPT.id}.v${REFLECTION_SCORE_PROMPT.version}`,
      thinkingMode: "disabled",
      temperature: 0,
      maxTokens: 700
    });

    const summary = stringOr(result.summary, summarized);
    const reflection = stringOr(result.reflection, reflectionText);
    const usable = typeof result.usable === "boolean" ? result.usable : Boolean(reflection);
    const rawAlpha = clampNumber(numberOr(result.alpha, trace.alpha || 0.5), 0, 1);
    const alpha = usable ? rawAlpha : 0;
    const modelTags = stringArray(result.tags).slice(0, 8);
    const reflectionTags = uniq([...memory.tags, ...modelTags]);
    const tags = memoryHasImportPipeline(memory)
      ? importStatusTags(reflectionTags, "indexing")
      : reflectionTags;
    const at = nowIso();
    const previous = memory;
    const next = updateImportPipelineStatus(updateTraceReflection(memory, {
      summary,
      reflection,
      alpha,
      usable,
      source: trace.reflection ? traceReflectionSource(memory) : reflection ? "synth" : "none",
      tags,
      updatedAt: at
    }), "indexing", at);
    const saved = this.deps.repos.memories.update(next);
    this.deps.repos.runtime.appendChange({
      memoryId: saved.id,
      namespaceId: this.deps.namespaceIdFromMemory(saved),
      kind: kindFromMemory(saved),
      op: "updated",
      entityId: saved.id,
      userId: saved.userId,
      changeType: "update",
      before: previous,
      after: saved,
      source: "worker.reflection.v7",
      createdAt: at
    });
    this.enqueuePostReflectionEmbedding(saved, job, at);
  }

private async reflectEpisodeBatch(job: EvolutionJobRecord): Promise<boolean> {
    const cfg = this.deps.config.algorithm.capture;
    if (!cfg.alphaScoring || !job.episodeId) {
      return false;
    }
    const episode = this.deps.repos.runtime.getEpisode(job.episodeId);
    if (!episode || episode.status !== "closed" || episode.l1MemoryIds.length === 0) {
      return false;
    }
    const memories = this.deps.repos.memories.getMany(episode.l1MemoryIds)
      .filter((memory) => memory.memoryLayer === "L1")
      .sort((a, b) => traceSortKey(a) - traceSortKey(b));
    if (memories.length === 0) {
      return false;
    }
    const unscored = memories.filter((memory) => !traceReflectionWasScored(memory));
    if (unscored.length === 0) {
      return true;
    }

    const primary = await this.runBatchReflectionWindowPass(
      episode,
      memories,
      cfg.reflectionBatchWindowSize,
      cfg.reflectionBatchOverlap,
      cfg.reflectionBatchPrimaryMaxRetries
    );
    if (primary.success) {
      await this.applyBatchReflectionScores(job, memories, mergeBatchWindowScores(memories.length, primary.results));
      return true;
    }

    const degraded = await this.runBatchReflectionWindowPass(
      episode,
      memories,
      cfg.reflectionBatchDegradedWindowSize,
      cfg.reflectionBatchDegradedOverlap,
      cfg.reflectionBatchDegradedMaxRetries
    );
    if (degraded.success) {
      await this.applyBatchReflectionScores(job, memories, mergeBatchWindowScores(memories.length, degraded.results));
      return true;
    }

    const payload = this.batchReflectionPayload(episode, memories);
    await this.applyBatchReflectionScores(job, memories, batchRelatedDefaultScores(
      memories.length,
      Array.isArray(payload.steps) ? payload.steps : undefined
    ));
    return true;
  }

private async runBatchReflectionWindowPass(
    episode: EpisodeRecord,
    memories: MemoryRow[],
    windowSize: number,
    overlap: number,
    maxRetries: number
  ): Promise<{ success: boolean; results: Map<number, BatchReflectionScore[]>; failedWindows: number }> {
    const windows = buildBatchWindows(memories.length, windowSize, overlap);
    const results = new Map<number, BatchReflectionScore[]>();
    let failedWindows = 0;
    for (const win of windows) {
      let ok = false;
      const windowMemories = memories.slice(win.start, win.end);
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
          const scores = await this.scoreBatchReflectionWindow(episode, windowMemories);
          results.set(win.start, scores);
          ok = true;
          break;
        } catch (error) {
          pipelineLogger.warn("batch_window.failed", {
            operation: BATCH_REFLECTION_OPERATION,
            pipeline: "reflection.batch_score",
            episodeId: episode.id,
            windowStart: win.start,
            windowEnd: win.end,
            attempt: attempt + 1,
            maxAttempts: maxRetries + 1,
            ...memoryErrorFields(error)
          });
          if (attempt === maxRetries) {
            failedWindows += 1;
          }
        }
      }
      if (!ok && failedWindows === 0) failedWindows += 1;
    }
    return { success: failedWindows === 0, results, failedWindows };
  }

private async scoreBatchReflectionWindow(
    episode: EpisodeRecord,
    memories: MemoryRow[]
  ): Promise<BatchReflectionScore[]> {
    const payload = this.batchReflectionPayload(episode, memories);
    const steps = Array.isArray(payload.steps) ? payload.steps : [];
    if (steps.length !== memories.length) {
      throw new Error(`batch reflection payload length mismatch: expected ${memories.length}`);
    }
    const directScores = new Map<number, BatchReflectionScore>();
    const modelStepIndices: number[] = [];
    steps.forEach((value, idx) => {
      const step = isRecord(value) ? value : undefined;
      if (isSocialOnlyBatchReflectionStep(step)) {
        directScores.set(idx, socialOnlyBatchReflectionScore(idx));
      } else {
        modelStepIndices.push(idx);
      }
    });
    if (modelStepIndices.length === 0) {
      return Array.from({ length: steps.length }, (_, idx) => directScores.get(idx)!);
    }
    const modelPayload = {
      ...payload,
      steps: modelStepIndices.map((sourceIdx, idx) => ({
        ...(isRecord(steps[sourceIdx]) ? steps[sourceIdx] : {}),
        idx
      }))
    };
    const lang = detectDominantLanguage(memories.flatMap((memory) => {
      const trace = traceMetaFromMemory(memory);
      return trace
        ? [trace.userText, trace.agentText, traceAgentThinking(memory), trace.reflection]
        : [];
    }));
    const result = await this.deps.skillLlm.completeJson<{
      scores?: unknown;
    }>([
      {
        role: "system",
        content: BATCH_REFLECTION_PROMPT.system
      },
      {
        role: "system",
        content: languageSteeringLine(lang)
      },
      {
        role: "user",
        content: stableStringify(modelPayload)
      }
    ], {
      operation: BATCH_REFLECTION_OPERATION,
      thinkingMode: "disabled",
      temperature: 0,
      maxTokens: Math.max(1200, modelStepIndices.length * 220)
    });
    const modelScores = parseBatchReflectionScores(result.scores, modelStepIndices.length);
    for (const score of modelScores) {
      const sourceIdx = modelStepIndices[score.idx];
      if (sourceIdx === undefined) {
        throw new Error(`batch reflection model score idx out of range: ${score.idx}`);
      }
      directScores.set(sourceIdx, { ...score, idx: sourceIdx });
    }
    return Array.from({ length: steps.length }, (_, idx) => {
      const score = directScores.get(idx);
      if (!score) throw new Error(`batch reflection score missing idx: ${idx}`);
      return score;
    });
  }

private async applyBatchReflectionScores(
    job: EvolutionJobRecord,
    memories: MemoryRow[],
    scores: BatchReflectionScore[]
  ): Promise<void> {
    const at = nowIso();
    for (const [index, score] of scores.entries()) {
      const memory = memories[index];
      if (!memory || traceReflectionWasScored(memory)) {
        continue;
      }
      const trace = this.deps.traceMeta(memory);
      if (!trace) {
        continue;
      }
      const incoming = trace.reflection?.trim() ?? "";
      const reflection = incoming || score.reflectionText;
      const usable = score.usable;
      const alpha = clampNumber(score.alpha, 0, 1);
      const summary = await this.summarizeTraceForCapture({
        trace,
        userText: trace.userText,
        agentText: trace.agentText,
        toolCalls: trace.toolCalls,
        reflectionText: reflection
      });
      const previous = memory;
      const saved = this.deps.repos.memories.update(updateImportPipelineStatus(updateTraceReflection(memory, {
        summary,
        reflection,
        alpha,
        usable,
        reason: score.reason,
        source: incoming ? traceReflectionSource(memory) : score.reflectionText === "RELATED_DEFAULT" ? "none" : "synth",
        tags: memoryHasImportPipeline(memory) ? importStatusTags(memory.tags, "indexing") : memory.tags,
        updatedAt: at
      }), "indexing", at));
      this.deps.repos.runtime.appendChange({
        memoryId: saved.id,
        namespaceId: this.deps.namespaceIdFromMemory(saved),
        kind: kindFromMemory(saved),
        op: "updated",
        entityId: saved.id,
        userId: saved.userId,
        changeType: "update",
        before: previous,
        after: saved,
        source: "worker.reflection.batch.v13",
        createdAt: at
      });
      this.enqueuePostReflectionEmbedding(saved, job, at);
    }
  }

private applyUnconfiguredEpisodeDefault(job: EvolutionJobRecord): boolean {
    if (!job.episodeId) return false;
    const episode = this.deps.repos.runtime.getEpisode(job.episodeId);
    if (!episode || episode.status !== "closed" || episode.l1MemoryIds.length === 0) return false;
    const memories = this.deps.repos.memories.getMany(episode.l1MemoryIds)
      .filter((memory) => memory.memoryLayer === "L1")
      .sort((a, b) => traceSortKey(a) - traceSortKey(b));
    if (memories.length === 0) return false;
    const at = nowIso();
    for (const candidate of memories) {
      if (traceReflectionWasScored(candidate)) continue;
      const candidateTrace = this.deps.traceMeta(candidate);
      if (!candidateTrace) continue;
      this.applyUnconfiguredTraceDefault(job, candidate, candidateTrace, at);
    }
    return true;
  }

private applyUnconfiguredTraceDefault(
    job: EvolutionJobRecord,
    memory: MemoryRow,
    trace: NonNullable<ReturnType<typeof traceMetaFromMemory>>,
    at = nowIso()
  ): void {
    const next = updateImportPipelineStatus(updateTraceReflection(memory, {
      summary: trace.summary || fallbackTraceSummary(trace),
      reflection: "RELATED_DEFAULT",
      alpha: 0.5,
      usable: true,
      reason: "llm unavailable; default related path relevance",
      source: "none",
      tags: memoryHasImportPipeline(memory) ? importStatusTags(memory.tags, "indexing") : memory.tags,
      updatedAt: at
    }), "indexing", at);
    const saved = next === memory ? memory : this.deps.repos.memories.update(next);
    if (saved !== memory) {
      this.deps.repos.runtime.appendChange({
        memoryId: saved.id,
        namespaceId: this.deps.namespaceIdFromMemory(saved),
        kind: kindFromMemory(saved),
        op: "updated",
        entityId: saved.id,
        userId: saved.userId,
        changeType: "update",
        before: memory,
        after: saved,
        source: "worker.reflection.unconfigured",
        createdAt: at
      });
    }
    this.enqueuePostReflectionEmbedding(saved, job, at);
  }

private batchReflectionPayload(episode: EpisodeRecord, memories: MemoryRow[]): Record<string, unknown> {
    const cfg = this.deps.config.algorithm.capture;
    const rawTurns = this.deps.repos.runtime.listRawTurnsByEpisode(episode.id, 100);
    return {
      host_context: {
        reflectionProvider: this.deps.skillLlm.config.provider,
        reflectionModel: this.deps.skillLlm.config.model,
        sessionId: episode.sessionId
      },
      task_context: reflectionContextIncludesTask(this.deps.config.algorithm.capture.reflectionContextMode)
        ? batchTaskContext(episode, rawTurns, this.deps.config.algorithm.capture.taskContextMaxChars)
        : null,
      steps: memories.map((memory, index) => {
        const trace = traceMetaFromMemory(memory);
        const userText = trace?.userText ?? "";
        const agentText = trace?.agentText ?? "";
        const toolCalls = trace?.toolCalls ?? [];
        return {
          idx: index,
          state: clip(userText, cfg.reflectionBatchStepStateChars),
          thinking: clip(traceAgentThinking(memory) ?? "", cfg.reflectionBatchStepThinkingChars),
          action: clip(agentText, cfg.reflectionBatchStepActionChars) || "(none)",
          tool_calls: toolCalls.map((call) => ({
            name: call.name,
            input: clip(stringifyForMemory(call.input), cfg.reflectionBatchToolInputChars),
            output: clip(stringifyForMemory(call.output), cfg.reflectionBatchToolOutputChars),
            errorCode: call.error ? clip(call.error, cfg.reflectionBatchToolErrorChars) : null
          })),
          outcome: lastReflectionToolOutcome(toolCalls, cfg.reflectionBatchOutcomeChars),
          reflection: clip(trace?.reflection ?? "", cfg.reflectionBatchReflectionChars),
          synth_allowed: this.deps.config.algorithm.capture.synthReflection
        };
      })
    };
  }

private async synthesizeTraceReflection(input: {
    trace: NonNullable<ReturnType<typeof traceMetaFromMemory>>;
    taskSummary: string;
    userText: string;
    agentThinking?: string;
    agentText: string;
    toolCalls: ToolCallPayload[];
    downstreamPreview: string;
  }): Promise<string | null> {
    if (!this.deps.config.algorithm.capture.synthReflection) {
      return null;
    }
    try {
      const text = await this.deps.skillLlm.complete([
        {
          role: "system",
          content: TRACE_REFLECTION_SYNTH_SYSTEM_PROMPT
        },
        {
          role: "user",
          content: traceReflectionSynthPayload({
            taskSummary: input.taskSummary,
            userText: input.userText,
            agentThinking: input.agentThinking,
            agentText: input.agentText,
            toolCalls: input.toolCalls,
            downstreamPreview: input.downstreamPreview
          })
        }
      ], {
        operation: "capture.reflection.synth",
        thinkingMode: "disabled",
        temperature: 0.1,
        maxTokens: 500
      });
      const cleaned = sanitizeReflectionText(text);
      return cleaned && cleaned !== "NO_REFLECTION" ? clip(cleaned, 1500) : null;
    } catch (error) {
      pipelineLogger.warn("fallback.used", {
        operation: "capture.reflection.synth",
        pipeline: "reflection.synthesis",
        fallback: "no_synthetic_reflection",
        ...memoryErrorFields(error)
      });
      return null;
    }
  }

private reflectionTaskSummary(job: EvolutionJobRecord, fallback: string): string {
    if (!reflectionContextIncludesTask(this.deps.config.algorithm.capture.reflectionContextMode)) {
      return "";
    }
    if (!job.episodeId) {
      return fallback;
    }
    const episode = this.deps.repos.runtime.getEpisode(job.episodeId);
    if (!episode) {
      return fallback;
    }
    const rawTurns = this.deps.repos.runtime.listRawTurnsByEpisode(episode.id, 100);
    return batchTaskContext(episode, rawTurns, this.deps.config.algorithm.capture.taskContextMaxChars) ?? fallback;
  }

private reflectionDownstreamPreview(job: EvolutionJobRecord, memory: MemoryRow): string {
    const cfg = this.deps.config.algorithm.capture;
    if (
      !job.episodeId ||
      cfg.longEpisodeReflectMode !== "per_step_downstream" ||
      !reflectionContextIncludesDownstream(cfg.reflectionContextMode) ||
      cfg.downstreamStepCount <= 0 ||
      cfg.downstreamContextMaxChars <= 0
    ) {
      return "(none)";
    }
    const episode = this.deps.repos.runtime.getEpisode(job.episodeId);
    if (!episode || episode.l1MemoryIds.length <= cfg.batchThreshold) {
      return "(none)";
    }
    const memories = this.deps.repos.memories.getMany(episode.l1MemoryIds)
      .filter((item) => item.memoryLayer === "L1")
      .sort((a, b) => traceSortKey(a) - traceSortKey(b));
    const index = memories.findIndex((item) => item.id === memory.id);
    if (index < 0) {
      return "(none)";
    }
    const lines: string[] = [];
    let usedChars = 0;
    const count = Math.max(0, Math.min(3, Math.floor(cfg.downstreamStepCount)));
    for (let offset = 1; offset <= count; offset += 1) {
      const next = memories[index + offset];
      if (!next) break;
      const remaining = cfg.downstreamContextMaxChars - usedChars;
      if (remaining <= 0) break;
      const block = traceDownstreamPreviewBlock(next, offset, Math.min(cfg.downstreamPerStepMaxChars, remaining));
      if (!block) continue;
      usedChars += block.length;
      lines.push(block);
    }
    return lines.length ? lines.join("\n\n") : "(none)";
  }

  async summarizeTraceForCapture(input: {
    trace: NonNullable<ReturnType<typeof traceMetaFromMemory>>;
    userText: string;
    agentText: string;
    toolCalls: ToolCallPayload[];
    reflectionText: string;
  }, options: { strict?: boolean } = {}): Promise<string> {
    const messages = [
      {
        role: "system" as const,
        content: CAPTURE_SUMMARY_SYSTEM_PROMPT
      },
      {
        role: "user" as const,
        content: traceSummaryPayload(input)
      }
    ];
    const summarizeWith = async (
      llm: LlmClient,
      thinkingMode?: "disabled"
    ): Promise<string> => {
      const result = await llm.completeJson<{
        summary?: unknown;
      }>(messages, {
        operation: "capture.summarize",
        thinkingMode,
        temperature: 0,
        maxTokens: MEMORY_SUMMARY_MAX_TOKENS
      });
      const summary = sanitizeSummaryText(stringOr(result.summary, ""));
      return summary || input.trace.summary;
    };

    try {
      return await summarizeWith(this.deps.llm);
    } catch (primaryError) {
      const logContext = {
        operation: "capture.summarize",
        pipeline: "trace.summary",
        sourceMemoryId: input.trace.id,
        episodeId: input.trace.episodeId,
        primaryModel: this.deps.llm.config.model,
        fallbackModel: this.deps.skillLlm.config.model
      };
      if (this.deps.llm.isConfigured() && this.deps.skillLlm.isConfigured() && this.deps.skillLlm !== this.deps.llm) {
        pipelineLogger.warn("summary.fallback_started", {
          ...logContext,
          ...memoryErrorFields(primaryError)
        });
        try {
          const summary = await summarizeWith(this.deps.skillLlm, "disabled");
          pipelineLogger.info("summary.fallback_succeeded", logContext);
          return summary;
        } catch (fallbackError) {
          pipelineLogger.error("summary.fallback_failed", {
            ...logContext,
            primaryErrorMessage: primaryError instanceof Error ? primaryError.message : String(primaryError),
            fallbackErrorMessage: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
          });
          if (options.strict) throw fallbackError;
        }
      } else if (options.strict) {
        throw primaryError;
      }
      pipelineLogger.warn("fallback.used", {
        ...logContext,
        fallback: "existing_summary",
        ...memoryErrorFields(primaryError)
      });
      return input.trace.summary;
    }
  }

private enqueuePostReflectionEmbedding(memory: MemoryRow, job: EvolutionJobRecord, at: string): void {
    this.deps.scheduleEmbeddingAfterTextUpdate({
      memory,
      sourceJob: job,
      reason: "reflection.updated",
      vectorField: "vec_summary",
      clearExistingVector: true,
      textOnlyAttemptCount: 0,
      at
    });
  }
}

const BATCH_REFLECTION_OPERATION = `capture.${BATCH_REFLECTION_PROMPT.id}.v${BATCH_REFLECTION_PROMPT.version}`;

function renderTraceMemoryValue(step: {
  summary: string;
  rawTurnId?: string;
  stepIndex?: number;
  userText?: string;
  agentText?: string;
  toolCalls: Array<{ name: string; input?: unknown; output?: unknown; error?: string }>;
  reflection: { text: string | null; alpha: number };
  value: number;
  priority: number;
}): string {
  const parts = [
    `Summary: ${step.summary}`,
    step.rawTurnId ? `RawTurn: ${step.rawTurnId}` : undefined,
    typeof step.stepIndex === "number" ? `TraceStep: ${step.stepIndex}` : undefined,
    step.userText ? `User:\n${step.userText}` : undefined,
    step.toolCalls.length
      ? [
          "Tool calls:",
          ...step.toolCalls.map((call) =>
            `- ${call.name}${call.error ? ` error=${clip(call.error, 160)}` : ""}`
          )
        ].join("\n")
      : undefined,
    step.agentText ? `Agent:\n${step.agentText}` : undefined,
    step.reflection.text ? `Reflection: ${clip(step.reflection.text, 800)}` : undefined,
    `Alpha: ${step.reflection.alpha}`,
    `Value: ${step.value}`,
    `Priority: ${step.priority}`
  ].filter(Boolean);
  return parts.join("\n");
}

function updateTraceReflection(memory: MemoryRow, input: {
  summary: string;
  reflection: string;
  alpha: number;
  usable: boolean;
  reason?: string;
  source?: "adapter" | "extracted" | "synth" | "none";
  tags: string[];
  updatedAt: string;
}): MemoryRow {
  const trace = traceMetaFromMemory(memory);
  if (!trace) {
    return memory;
  }
  const internalTrace = isRecord(memory.properties.internal_info.trace)
    ? memory.properties.internal_info.trace
    : {};
  const nextTrace = {
    ...internalTrace,
    summary: input.summary,
    reflection: input.reflection,
    alpha: input.alpha,
    usable: input.usable,
    reflection_reason: input.reason,
    reflection_source: input.source ?? "synth",
    reflection_scored_at: input.updatedAt
  };
  return {
    ...memory,
    memoryValue: renderTraceMemoryValue({
      summary: input.summary,
      rawTurnId: stringFromRecord(internalTrace, "raw_turn_id"),
      stepIndex: numberFromRecord(internalTrace, "step_index"),
      toolCalls: trace.toolCalls,
      userText: trace.userText,
      agentText: trace.agentText,
      reflection: {
        text: input.reflection || null,
        alpha: input.alpha
      },
      value: trace.value,
      priority: trace.priority
    }),
    tags: input.tags,
    info: {
      ...memory.info,
      summary: input.summary,
      tags: input.tags
    },
    properties: {
      ...memory.properties,
      tags: input.tags,
      info: {
        ...(memory.properties.info ?? {}),
        summary: input.summary,
        tags: input.tags
      },
      internal_info: {
        ...memory.properties.internal_info,
        summary: input.summary,
        reflection: input.reflection,
        alpha: input.alpha,
        trace: nextTrace
      }
    },
    updatedAt: input.updatedAt
  };
}

function fallbackTraceSummary(trace: TraceMeta): string {
  return clip(firstLine([trace.summary, trace.userText, trace.agentText].filter(Boolean).join("\n")) || "trace memory", 200);
}

const TRACE_REFLECTION_SYNTH_SYSTEM_PROMPT = `You are reviewing a single step of an AI agent's decision.

Write a first-person reflection from the agent's perspective explaining WHY
it produced this response / tool calls given the user input. Keep it to
2-4 sentences, concrete, avoid repeating the visible action.

If the step is empty or incoherent, return exactly: NO_REFLECTION`;

const CAPTURE_SUMMARY_SYSTEM_PROMPT = `You extract the most useful durable fact from a single user/agent exchange for future retrieval.

Rules:
- Output MUST be a single JSON object: { "summary": "..." }
- Write in the user's original language.
- Target <= 200 characters, but preserving key facts is more important than
  exact length; do not hard-truncate. Unless the exchange is genuinely simple,
  use most of the 200-character budget to retain details and retrieval keywords.
- Preserve concrete retrieval anchors: names, aliases, dates, times, places,
  relationships, numbers, exact titles, object names, event names, preferences,
  decisions, commitments, outcomes, confirmed answers, file paths, commands,
  and error signatures.
- Treat the conversation as evidence, not the memory itself. Do NOT write vague
  summaries like "A and B discussed X" unless the discussion itself is the
  durable fact.
- Prefer atomic real-world facts: who did/wanted/said/decided what, when/where,
  and with what outcome.
- If multiple independent facts appear, cover every independently retrievable
  fact and list them compactly with semicolons instead of dropping one or
  merging them into a broad umbrella topic.
- For temporal facts, record the EVENT date/time, not just the conversation
  date/time. When a session timestamp and a relative expression are present,
  the summary MUST include the resolved absolute date/time. It may also retain
  the relative wording, but never use it instead of the absolute value. Example:
  a session on 22 October 2023 saying "bought it yesterday" means 21 October 2023.
  If exact resolution is impossible, retain the relative wording and its anchor.
- Use future-query words from the source. Prefer concrete event/action/object
  terms over generic words such as "support", "journey", "strength", or
  "discussion" unless those are the only durable fact.
- For images, files, or search results, preserve image captions, visible text,
  retrieval queries, topics, and answer-relevant evidence; omit raw URLs unless
  the URL itself is important.
- Preserve original speaker/person names. User/assistant roles may be import
  roles and must not replace real participants when names are present.
- Do not invent facts. Do not infer ownership from neighboring turns.
- Do NOT prefix with "The user said" / "用户说了". Just state the fact.
- If no durable fact is present, summarize the concrete request/result that
  would be most useful for retrieval.`;

interface BatchReflectionScore {
  idx: number;
  reflectionText: string;
  alpha: number;
  usable: boolean;
  reason?: string;
}

interface BatchReflectionPayloadStep {
  state?: unknown;
  thinking?: unknown;
  action?: unknown;
  tool_calls?: unknown;
}

function parseBatchReflectionScores(
  value: unknown,
  expected: number
): BatchReflectionScore[] {
  if (!Array.isArray(value) || value.length !== expected) {
    throw new Error(`batch reflection scores length mismatch: expected ${expected}`);
  }
  const byIdx = new Map<number, BatchReflectionScore>();
  value.forEach((item) => {
    if (!isRecord(item)) {
      throw new Error("batch reflection score must be an object");
    }
    const idx = numberOr(item.idx, NaN);
    if (!Number.isInteger(idx) || idx < 0 || idx >= expected) {
      throw new Error(`batch reflection score idx out of range: ${String(item.idx)}`);
    }
    const relevance = parseBatchReflectionRelevance(item.relevance);
    byIdx.set(idx, {
      idx,
      reflectionText: relevance,
      alpha: alphaForBatchReflectionRelevance(relevance),
      usable: relevance !== "IRRELEVANT",
      reason: typeof item.reason === "string" ? item.reason : undefined
    });
  });
  if (byIdx.size !== expected) {
    throw new Error(`batch reflection scores missing or duplicate idx: expected ${expected}`);
  }
  return Array.from({ length: expected }, (_, idx) => byIdx.get(idx)!);
}

function isDurableMemoryBatchReflectionStep(step: BatchReflectionPayloadStep | undefined): boolean {
  if (!step) return false;
  const text = [
    typeof step.state === "string" ? step.state : "",
    typeof step.action === "string" ? step.action : "",
    typeof step.thinking === "string" ? step.thinking : ""
  ].join("\n").trim();
  if (!text) return false;
  if (/(不知道|不清楚|没有记录|未记录|还没有记录|not know|don't know|do not know|no record|not recorded)/i.test(text)) {
    return false;
  }
  const questionOnly = /(什么|哪(?:个|种)?|是否|吗|？|\?|what|which|whether|do i|did i|have i)/i.test(text) &&
    !/(记住|记下|保存|已记录|remember(?:ed)?|noted|saved|store(?:d)?)/i.test(text);
  if (questionOnly) return false;
  return [
    /(?:我|我的|用户).{0,24}(?:喜欢|不喜欢|偏好|讨厌|过敏|常用|默认|名字|叫|生日|住在|来自).{0,80}(?:是|为|叫|用|吃|:|：|，|。)/i,
    /(?:记住|记下|保存|已记录).{0,80}(?:喜欢|偏好|不喜欢|过敏|默认|名字|生日|项目|决定|要求|约束)/i,
    /\b(?:my|the user's)\s+(?:name|preference|favorite|default|shell|email|birthday|timezone|requirement)\b.{0,80}\b(?:is|are|=|:)\b/i,
    /\b(?:i|the user)\s+(?:like|likes|prefer|prefers|dislike|dislikes|am allergic to|is allergic to)\b.{1,80}/i,
    /(?:这个项目|本项目|当前项目|the project|this project).{0,80}(?:使用|用|依赖|要求|默认|决定|保留|采用|uses|depends on|requires|defaults to|decided)/i,
    /(?:我们|已|已经)?决定.{0,80}(?:使用|采用|保留|删除|改为|保持|merge|keep|use|adopt|remove)/i
  ].some((pattern) => pattern.test(text));
}

function parseBatchReflectionRelevance(value: unknown): "IRRELEVANT" | "RELATED" | "PIVOTAL" {
  if (value === "IRRELEVANT" || value === "RELATED" || value === "PIVOTAL") return value;
  throw new Error(`batch reflection relevance invalid: ${String(value)}`);
}

function alphaForBatchReflectionRelevance(value: "IRRELEVANT" | "RELATED" | "PIVOTAL"): number {
  if (value === "IRRELEVANT") return 0;
  if (value === "PIVOTAL") return 1;
  return 0.5;
}

function isSocialOnlyBatchReflectionStep(step: BatchReflectionPayloadStep | undefined): boolean {
  if (!step) return false;
  const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
  if (toolCalls.length > 0) return false;
  const state = typeof step.state === "string" ? step.state.trim().toLowerCase() : "";
  if (!state) return false;
  if (batchReflectionWordCount(state) > 6) return false;
  if (isDurableMemoryBatchReflectionStep(step)) return false;
  const explicitSocialPattern =
    /(谢谢|感谢|辛苦|客气|不用谢|再见|拜拜|你好|您好|早上好|晚上好)|\b(?:thanks?|thank\s+you|appreciate|great\s+job|well\s+done|awesome|nice|you(?:'|’)re\s+welcome|no\s+problem|bye|goodbye|hello|hi)\b/i;
  const shortPraisePattern =
    /^(?:你|您|回答|做得)?[^\n]{0,8}(?:真棒|棒极了|做得好|很好|很对|厉害|太强了)[！!。.]*$/i;
  const substantiveSignalPattern =
    /[?？]|(?:请|帮我|推荐|介绍|解释|分析|比较|查询|查找|查一下|告诉我|为什么|怎么|如何|什么|哪(?:个|种|里)?|是否|是不是|能否|需要|想要|问题|关于|区别|原因)|\b(?:please|help|recommend|introduce|explain|analy[sz]e|compare|find|search|tell\s+me|why|how|what|which|where|whether|can\s+you|could\s+you|need|want|question|about)\b/i;
  const taskSignalPattern =
    /(修复|实现|改|更新|测试|报错|错误|命令|脚本|代码|函数|文件|数据库|sql|trace|episode|reward|reflection|alpha|value|fix|implement|update|test|error|command|script|code|function|file|db|database|query|bug|issue|task)/i;
  const socialIntent = explicitSocialPattern.test(state) || shortPraisePattern.test(state);
  return socialIntent && !substantiveSignalPattern.test(state) && !taskSignalPattern.test(state);
}

function batchReflectionWordCount(text: string): number {
  return Array.from(new Intl.Segmenter(undefined, { granularity: "word" }).segment(text))
    .filter((part) => part.isWordLike)
    .length;
}

function socialOnlyBatchReflectionScore(idx: number): BatchReflectionScore {
  return {
    idx,
    reflectionText: "IRRELEVANT",
    alpha: 0,
    usable: false,
    reason: "SOCIAL_ONLY"
  };
}

function mergeBatchWindowScores(length: number, windowScores: Map<number, BatchReflectionScore[]>): BatchReflectionScore[] {
  const merged = new Map<number, BatchReflectionScore>();
  const starts = [...windowScores.keys()].sort((a, b) => a - b);
  for (const start of starts) {
    const scores = windowScores.get(start) ?? [];
    for (let index = 0; index < scores.length; index += 1) {
      const absolute = start + index;
      const next = scores[index];
      if (!next) continue;
      const previous = merged.get(absolute);
      if (!previous || batchReflectionRank(next) > batchReflectionRank(previous)) {
        merged.set(absolute, { ...next, idx: absolute });
      }
    }
  }
  return Array.from({ length }, (_, idx) => merged.get(idx) ?? {
    idx,
    reflectionText: "RELATED_DEFAULT",
    alpha: 0.5,
    usable: true,
    reason: "MISSING_WINDOW_DEFAULT"
  });
}

function batchRelatedDefaultScores(
  length: number,
  steps?: readonly unknown[]
): BatchReflectionScore[] {
  return Array.from({ length }, (_, idx) => {
    const step = isRecord(steps?.[idx]) ? steps[idx] : undefined;
    return isSocialOnlyBatchReflectionStep(step)
      ? socialOnlyBatchReflectionScore(idx)
      : {
        idx,
        reflectionText: "RELATED_DEFAULT",
        alpha: 0.5,
        usable: true,
        reason: "FALLBACK_RELATED_DEFAULT"
      };
  });
}

function batchReflectionRank(score: BatchReflectionScore): number {
  const label = score.reflectionText.trim();
  if (label === "PIVOTAL") return 2;
  if (label === "RELATED" || label === "RELATED_DEFAULT") return 1;
  return 0;
}

function buildBatchWindows(length: number, windowSize: number, overlap: number): Array<{ start: number; end: number }> {
  if (length <= 0) return [];
  const out: Array<{ start: number; end: number }> = [];
  const stride = Math.max(1, windowSize - overlap);
  let start = 0;
  while (start < length) {
    const end = Math.min(length, start + windowSize);
    out.push({ start, end });
    if (end >= length) break;
    start += stride;
  }
  return out;
}

function batchTaskContext(episode: EpisodeRecord, rawTurns: readonly RawTurnRecord[], maxChars = 1200): string | null {
  const parts = [
    episode.title ? `Title: ${episode.title}` : "",
    episode.summary ? `Episode summary: ${episode.summary}` : "",
    ...rawTurns.slice(0, 6).map((turn) => sessionSummarizeTurn(turn))
  ].filter(Boolean);
  return parts.length ? clip(parts.join("\n\n"), maxChars) : null;
}

export function traceSortKey(memory: MemoryRow): number {
  const trace = traceMetaFromMemory(memory);
  if (!trace) return Date.parse(memory.timeline);
  return Number.isFinite(trace.ts) ? trace.ts : Date.parse(memory.timeline);
}

function traceReflectionSource(memory: MemoryRow): "adapter" | "extracted" | "synth" | "none" {
  const trace = isRecord(memory.properties.internal_info.trace)
    ? memory.properties.internal_info.trace
    : {};
  const source = trace.reflection_source;
  return source === "adapter" || source === "extracted" || source === "synth" || source === "none"
    ? source
    : "synth";
}

export function traceReflectionWasScored(memory: MemoryRow): boolean {
  const internalTrace = isRecord(memory.properties.internal_info.trace)
    ? memory.properties.internal_info.trace
    : {};
  return typeof internalTrace.reflection_scored_at === "string";
}

function sanitizeReflectionText(value: string): string {
  return value
    .replace(/^```(?:json|text|markdown)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function sanitizeSummaryText(value: string): string {
  return value
    .replace(/^```(?:json|text|markdown)?/i, "")
    .replace(/```$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function reflectionContextIncludesDownstream(mode: string): boolean {
  return mode === "downstream" || mode === "task_downstream";
}

function reflectionContextIncludesTask(mode: string): boolean {
  return mode === "task" || mode === "task_downstream";
}

function traceDownstreamPreviewBlock(memory: MemoryRow, offset: number, maxChars: number): string {
  const trace = traceMetaFromMemory(memory);
  if (!trace) {
    return "";
  }
  if (trace.toolCalls.length > 0) {
    const lines = [
      `[step+${offset}] type=tooluse`,
      `tool_names: ${trace.toolCalls.map((call) => call.name).filter(Boolean).join(", ") || "(unknown)"}`,
      `tool_output: ${clip(trace.toolCalls.map((call) => {
        const label = call.error ? `${call.name} ERROR[${call.error}]` : call.name;
        return `${label}: ${stringifyForMemory(call.output) || "(no output)"}`;
      }).join("\n"), maxChars)}`
    ];
    if (trace.reflection?.trim()) {
      lines.push(`existing_reflection: ${clip(trace.reflection, Math.floor(maxChars / 2))}`);
    }
    return lines.join("\n");
  }
  return [
    `[step+${offset}] type=text`,
    clip([trace.userText, trace.agentText, trace.reflection ?? ""].filter(Boolean).join("\n"), maxChars) || "(empty)"
  ].join("\n");
}

function traceReflectionScorePayload(input: {
  taskSummary: string;
  userText: string;
  agentThinking?: string;
  agentText: string;
  toolCalls: ToolCallPayload[];
  downstreamPreview: string;
  reflectionText: string;
}): string {
  return [
    "TASK CONTEXT:",
    clip(input.taskSummary, 1200) || "(none)",
    "",
    "STATE:",
    clip(input.userText, 1200) || "(none)",
    "",
    "THINKING:",
    input.agentThinking ? clip(input.agentThinking, 1500) : "(none - model did not emit thinking this turn)",
    "",
    "ACTION:",
    clip(input.agentText, 1500) || "(none)",
    input.toolCalls.length > 0
      ? `\nTOOL_CALLS:\n${input.toolCalls.map(formatReflectionToolCall).join("\n")}`
      : "\nTOOL_CALLS: (none)",
    "",
    "OUTCOME:",
    lastReflectionToolOutcome(input.toolCalls, 600),
    "",
    "DOWNSTREAM STEP PREVIEW:",
    input.downstreamPreview || "(none)",
    "",
    "REFLECTION:",
    clip(input.reflectionText, 1500)
  ].join("\n");
}

function traceReflectionSynthPayload(input: {
  taskSummary: string;
  userText: string;
  agentThinking?: string;
  agentText: string;
  toolCalls: ToolCallPayload[];
  downstreamPreview: string;
}): string {
  return [
    "TASK CONTEXT:",
    clip(input.taskSummary, 1200) || "(none)",
    "",
    "USER/OBSERVATION:",
    clip(input.userText, 1200) || "(none)",
    "",
    "THINKING (model's native chain-of-thought, if any):",
    input.agentThinking ? clip(input.agentThinking, 1500) : "(none)",
    "",
    "AGENT ACTION:",
    clip(input.agentText, 1500) || "(none)",
    input.toolCalls.length > 0
      ? `\nTOOL CALLS:\n${input.toolCalls.map((call) => {
        const inputText = clip(stringifyForMemory(call.input), 400);
        return call.error
          ? `- ${call.name}(${inputText}) -> ERROR[${call.error}]`
          : `- ${call.name}(${inputText})`;
      }).join("\n")}`
      : "",
    "",
    "OUTCOME:",
    lastReflectionToolOutcome(input.toolCalls, 600),
    "",
    "DOWNSTREAM STEP PREVIEW:",
    input.downstreamPreview || "(none)"
  ].filter((line) => line !== "").join("\n");
}

function traceSummaryPayload(input: {
  userText: string;
  agentText: string;
  toolCalls: ToolCallPayload[];
  reflectionText: string;
}): string {
  const parts: string[] = [];
  if (input.userText) {
    parts.push(`USER:\n${clip(input.userText, 1400)}`);
  }
  if (input.agentText) {
    parts.push(`ASSISTANT:\n${clip(input.agentText, 1400)}`);
  }
  if (input.toolCalls.length > 0) {
    parts.push(`TOOLS:\n${clip(input.toolCalls.map((call) =>
      `${call.name}(${clip(stringifyForMemory(call.input), 120)})`
    ).join("; "), 400)}`);
  }
  if (input.reflectionText) {
    parts.push(`REFLECTION:\n${clip(input.reflectionText, 300)}`);
  }
  return clip(parts.join("\n\n"), 3500);
}

function formatReflectionToolCall(call: ToolCallPayload): string {
  const io = stringifyForMemory({
    input: call.input,
    output: call.output,
    error: call.error
  });
  return call.error
    ? `- ${call.name}(${clip(stringifyForMemory(call.input), 200)}) -> ERROR ${clip(call.error, 300)} ${clip(io, 300)}`
    : `- ${call.name}(${clip(stringifyForMemory(call.input), 200)}) -> ${clip(stringifyForMemory(call.output), 300)}`;
}

function lastReflectionToolOutcome(toolCalls: ToolCallPayload[], maxChars: number): string {
  const last = toolCalls[toolCalls.length - 1];
  if (!last) return "(assistant-only step)";
  const output = last.error
    ? `ERROR ${last.error} ${stringifyForMemory(last.output)}`
    : stringifyForMemory(last.output);
  return clip(output, maxChars);
}

function traceAgentThinking(memory: MemoryRow): string | undefined {
  const trace = memory.properties.internal_info.trace;
  if (!trace || typeof trace !== "object" || Array.isArray(trace)) {
    return undefined;
  }
  const thinking = (trace as { agent_thinking?: unknown }).agent_thinking;
  return typeof thinking === "string" && thinking.trim() ? thinking.trim() : undefined;
}

function uniq<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function stringFromRecord(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function rawTurnIdFromMemory(memory: MemoryRow): string | undefined {
  const sourceRawTurnId = memory.properties.internal_info.source_raw_turn_id;
  if (typeof sourceRawTurnId === "string" && sourceRawTurnId) return sourceRawTurnId;
  const rawTurnId = memory.properties.internal_info.raw_turn_id;
  if (typeof rawTurnId === "string" && rawTurnId) return rawTurnId;
  const trace = memory.properties.internal_info.trace;
  return isRecord(trace) ? stringFromRecord(trace, "raw_turn_id") : undefined;
}

function numberFromRecord(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isToolCallPayload(value: unknown): value is ToolCallPayload {
  return isRecord(value) && typeof value.name === "string";
}
