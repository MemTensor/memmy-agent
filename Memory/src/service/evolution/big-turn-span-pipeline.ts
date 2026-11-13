import { revisionInputHash, episodeGeneration, episodeRewardInputVersion, rewardInputIsCurrent } from "./episode-revision.js";
import { languageSteeringLine, steeredPromptLanguage } from "../../algorithm/plugin-algorithms.js";
import type { MemmyConfig } from "../../config/index.js";
import type { LlmClient } from "../../model/types.js";
import type {
  EvolutionJobRecord,
  RawTurnRecord,
  Repositories
} from "../../storage/repositories.js";
import { kindFromMemory } from "../../storage/repositories.js";
import type { MemoryRow,ToolCallPayload } from "../../types.js";
import { stableHash,stableStringify } from "../../utils/id.js";
import { isRecord } from "../../utils/json.js";
import { redactSensitiveText } from "../../utils/sensitive-data.js";
import { clip } from "../../utils/text.js";
import { formatZonedTime } from "../../utils/time.js";
import type { EnqueueJobInput } from "../worker/job-handlers.js";

export const SPAN_BIG_TURN_ENABLED = true;
export const SPAN_BIG_TURN_MIN_TOOL_CALLS = 11;

const SPAN_BIG_TURN_OPERATION = "span.big_turn.v1";
const SPAN_BIG_TURN_PROMPT = `You segment one completed AI-agent turn into meaningful subtask spans.

A span represents one coherent subtask goal pursued through a contiguous
sequence of tool calls. It is not a single tool call and not merely a change
of tool name.

Split only when the execution contains two or more clearly distinct subtask
goals or execution phases. Keep diagnosis and repair of the same problem in
one span unless the repair starts an independently meaningful task.

Boundary rules:
- Every span covers a contiguous inclusive tool-call range.
- Spans must not overlap and must remain in execution order.
- Tool calls that are repetitive, transitional, or irrelevant to reusable
  experience may remain outside all spans.
- Produce 2 to 6 spans when splitting.
- Avoid spans containing only one tool call unless it is an independently
  meaningful subtask.
- If the whole execution serves one coherent goal, return an empty spans list.
- Do not invent actions, results, goals, or errors.

spanGoal requirements:
- Describe the concrete subtask objective, not the tool used.
- Be independently understandable and suitable for retrieval.
- Preserve important artifact names, paths, modules, errors, and constraints.

summary requirements:
- State what was done and what result was obtained.
- Preserve important decisions, failures, fixes, and verification results.
- Be concise and evidence-based.

Language:
- spanGoal and summary are both natural-language fields.
- Write both in the language required by the language instruction.
- Use that one language for both fields. Do not mix languages.
- Do not follow the language of the user request, tool output, or source memory when it differs.

Return JSON only:
{
  "reason": "...",
  "spans": [
    {
      "start": 0,
      "end": 3,
      "spanGoal": "...",
      "summary": "..."
    }
  ]
}`;

interface SpanDraft {
  start: number;
  end: number;
  spanGoal: string;
  summary: string;
}

interface BigTurnSpanDeps {
  repos: Repositories;
  llm: LlmClient;
  config: MemmyConfig;
  buildMemory(input: Record<string, unknown>): MemoryRow;
  enqueueJob(input: EnqueueJobInput): EvolutionJobRecord;
  namespaceIdFromMemory(memory: MemoryRow): string;
  embedAfterCapture(): boolean;
}

export class BigTurnSpanPipeline {
  constructor(private readonly deps: BigTurnSpanDeps) {}

  async splitAndStore(job: EvolutionJobRecord): Promise<void> {
    if (!SPAN_BIG_TURN_ENABLED) return;
    const source = job.targetMemoryId
      ? this.deps.repos.memories.get(job.targetMemoryId)
      : undefined;
    const rawTurnId = text(job.payload.rawTurnId);
    const rawTurn = rawTurnId
      ? this.deps.repos.runtime.getRawTurn(rawTurnId)
      : undefined;
    if (!source || !rawTurn) return;

    const episodeId = rawTurn.episodeId ?? job.episodeId;
    if (rawTurn.episodeId && job.episodeId && rawTurn.episodeId !== job.episodeId) return;
    const episode = episodeId ? this.deps.repos.runtime.getEpisode(episodeId) : undefined;
    const episodeVersion = episode ? episodeRewardInputVersion(this.deps.repos, episode) : undefined;
    const rawVersion = revisionInputHash(rawTurn);
    if (episode && (episode.status !== "closed" || (typeof job.payload.episodeGeneration === "number"
      && job.payload.episodeGeneration !== episodeGeneration(episode)))) return;
    const rTask = typeof episode?.rTask === "number" ? episode.rTask : Number(job.payload.rTask ?? 0);
    const eligible = rTask > 0 && !episode?.rewardDetail.skipped && !rawTurn.deletedAt && !rawTurn.redactedAt
      && rawTurn.toolCalls.length >= SPAN_BIG_TURN_MIN_TOOL_CALLS;
    const completionKey = `span-result:v1:${source.id}`;
    const inputVersion = revisionInputHash({ eligible, prompt: bigTurnPromptPayload(source, rawTurn, job),
      raw: { userText: rawTurn.userText, assistantText: rawTurn.assistantText, reasoningSummary: rawTurn.reasoningSummary,
        toolCalls: rawTurn.toolCalls, toolResults: rawTurn.toolResults, status: rawTurn.status,
        deletedAt: rawTurn.deletedAt, redactedAt: rawTurn.redactedAt },
      language: this.deps.config.language, model: [this.deps.llm.config.provider, this.deps.llm.config.model] });
    const completed = this.deps.repos.runtime.getKv(completionKey)?.value;
    if (isRecord(completed) && completed.inputVersion === inputVersion) return;
    if (eligible && !this.deps.llm.isConfigured()) return;
    const lang = steeredPromptLanguage(this.deps.config.language, [
      rawTurn.userText,
      rawTurn.assistantText
    ]);
    const result = eligible ? await this.deps.llm.completeJson<{
      reason?: unknown;
      spans?: unknown;
    }>([
      { role: "system", content: SPAN_BIG_TURN_PROMPT },
      { role: "system", content: languageSteeringLine(lang) },
      {
        role: "user",
        content: JSON.stringify(bigTurnPromptPayload(source, rawTurn, job))
      }
    ], {
      operation: SPAN_BIG_TURN_OPERATION,
      thinkingMode: "disabled",
      temperature: 0.6,
      maxTokens: 4096
    }) : { spans: [] };
    const spans = validateSpanResult(result, rawTurn.toolCalls.length);
    this.deps.repos.transaction(() => {
      const current = this.deps.repos.memories.get(source.id);
      if (!current || current.status !== "activated" || current.version !== source.version
        || revisionInputHash(this.deps.repos.runtime.getRawTurn(rawTurn.id)) !== rawVersion
        || (episode && episodeVersion && !rewardInputIsCurrent(this.deps.repos, episode.id, episodeVersion))) {
        throw new Error("span source changed during generation");
      }
      const oldTrace = current.properties.internal_info.trace;
      const oldIds = isRecord(oldTrace) && Array.isArray(oldTrace.span_ids)
        ? oldTrace.span_ids.filter((id): id is string => typeof id === "string") : [];
      const spanIds: string[] = [];
      for (const [spanIndex, span] of spans.entries()) {
        const id = this.storeSpan({ source, rawTurn, job, span, spanIndex });
        if (id) spanIds.push(id);
      }
      for (const id of oldIds) {
        if (spanIds.includes(id)) continue;
        const previous = this.deps.repos.memories.get(id);
        if (!previous || previous.status !== "activated") continue;
        const internal = previous.properties.internal_info;
        if (!isRecord(internal.span) || internal.span.source_trace_id !== source.id) continue;
        if (typeof internal.span_generated_content_hash === "string"
          && internal.span_generated_content_hash !== revisionInputHash(previous.memoryValue)) continue;
        const retired = this.deps.repos.memories.update({ ...previous, status: "archived",
          properties: { ...previous.properties, status: "archived", internal_info: { ...internal,
            span_replacement: { sourceTraceId: source.id, retiredVersion: previous.version + 1 } } },
          updatedAt: job.updatedAt });
        this.deps.repos.runtime.appendChange({ memoryId: id, namespaceId: this.deps.namespaceIdFromMemory(retired),
          kind: "span", op: "updated", entityId: id, userId: retired.userId,
          changeType: "span_replaced", before: previous, after: retired,
          source: "worker.span_big_turn.v1", createdAt: job.updatedAt });
      }
      this.linkSpansToSourceTrace(source.id, spanIds, job);
      this.deps.repos.runtime.setKv(completionKey, { inputVersion, spanIds }, job.updatedAt);
    });
  }

  private storeSpan(input: {
    source: MemoryRow;
    rawTurn: RawTurnRecord;
    job: EvolutionJobRecord;
    span: SpanDraft;
    spanIndex: number;
  }): string | undefined {
    const { source, rawTurn, job, span, spanIndex } = input;
    const id = spanId(source.id, span);
    const previous = this.deps.repos.memories.getIncludingDeleted(id);
    if (previous?.deletedAt || previous?.status === "deleted") return undefined;
    const retirement = previous?.properties.internal_info.span_replacement;
    if (previous?.status === "archived" && (!isRecord(retirement)
      || retirement.sourceTraceId !== source.id || retirement.retiredVersion !== previous.version)) return undefined;
    const generatedHash = previous?.properties.internal_info.span_generated_content_hash;
    if (previous && typeof generatedHash === "string" && generatedHash !== revisionInputHash(previous.memoryValue)) {
      return previous.status === "activated" ? previous.id : undefined;
    }
    const value = [
      `Goal: ${span.spanGoal}`,
      `Summary: ${span.summary}`
    ].join("\n");
    const memory = this.deps.buildMemory({
      id,
      userId: source.userId,
      conversationId: source.conversationId,
      sessionId: source.sessionId,
      agentId: source.agentId,
      appId: source.appId,
      projectId: text(source.info.project_id),
      profileId: text(source.info.profile_id),
      layer: "L1",
      kind: "span",
      memoryType: "LongTermMemory",
      key: span.spanGoal,
      value,
      tags: ["span", "big-turn", "derived"],
      info: {
        title: span.spanGoal,
        summary: span.summary,
        span_goal: span.spanGoal,
        source_trace_id: source.id,
        raw_turn_id: rawTurn.id,
        episode_id: job.episodeId
      },
      internal: {
        source: "worker.span_big_turn.v1",
        span_generated_content_hash: revisionInputHash(value),
        plugin_algorithm: "span.big_turn.v1",
        summary: span.summary,
        span: {
          source_trace_id: source.id,
          raw_turn_id: rawTurn.id,
          episode_id: job.episodeId,
          span_index: spanIndex,
          tool_call_start: span.start,
          tool_call_end: span.end,
          span_goal: span.spanGoal,
          summary: span.summary,
          reward: number(job.payload.rTask),
          derived: true
        }
      },
      createdAt: job.createdAt
    });
    const saved = previous
      ? this.deps.repos.memories.update({
          ...memory,
          createdAt: previous.createdAt,
          version: previous.version
        })
      : this.deps.repos.memories.insert(memory);
    this.deps.repos.runtime.appendChange({
      memoryId: saved.id,
      namespaceId: this.deps.namespaceIdFromMemory(saved),
      kind: kindFromMemory(saved),
      op: previous ? "updated" : "created",
      entityId: saved.id,
      userId: saved.userId,
      changeType: previous ? "span_updated" : "span_created",
      before: previous,
      after: saved,
      source: "worker.span_big_turn.v1",
      createdAt: job.createdAt
    });
    if (this.deps.embedAfterCapture()) {
      this.deps.enqueueJob({
        jobType: "embedding",
        userId: saved.userId,
        sessionId: saved.sessionId,
        episodeId: job.episodeId,
        targetMemoryId: saved.id,
        payload: {
          reason: "span.big_turn",
          sourceJobId: job.id,
          contentHash: saved.contentHash
        },
        createdAt: job.createdAt
      });
    }
    return saved.id;
  }

  private linkSpansToSourceTrace(
    sourceTraceId: string,
    spanIds: string[],
    job: EvolutionJobRecord
  ): void {
    const previous = this.deps.repos.memories.get(sourceTraceId);
    if (!previous) {
      throw new Error(`span.big_turn source Trace not found: ${sourceTraceId}`);
    }
    const previousTrace = previous.properties.internal_info.trace;
    if (!isRecord(previousTrace)) {
      throw new Error(`span.big_turn source Trace metadata is invalid: ${sourceTraceId}`);
    }
    const saved = this.deps.repos.memories.update({
      ...previous,
      properties: {
        ...previous.properties,
        internal_info: {
          ...previous.properties.internal_info,
          trace: {
            ...previousTrace,
            span_ids: spanIds
          }
        }
      },
      updatedAt: job.updatedAt
    });
    this.deps.repos.runtime.appendChange({
      memoryId: saved.id,
      namespaceId: this.deps.namespaceIdFromMemory(saved),
      kind: kindFromMemory(saved),
      op: "updated",
      entityId: saved.id,
      userId: saved.userId,
      changeType: "span_links_updated",
      before: previous,
      after: saved,
      source: "worker.span_big_turn.v1",
      createdAt: job.updatedAt
    });
  }
}

function spanId(sourceTraceId: string, span: SpanDraft): string {
  return `span_${stableHash(`${sourceTraceId}:${span.start}:${span.end}`).slice(0, 20)}`;
}

function bigTurnPromptPayload(
  source: MemoryRow,
  rawTurn: RawTurnRecord,
  job: EvolutionJobRecord
): Record<string, unknown> {
  const internal = source.properties.internal_info;
  const trace = isRecord(internal.trace) ? internal.trace : {};
  const traceTimestamp = number(trace.ts);
  const traceTimeZone = text(trace.time_zone);
  return {
    sourceTraceId: redactSensitiveText(source.id),
    capturedAt: traceTimestamp === undefined
      ? undefined
      : formatZonedTime(traceTimestamp, traceTimeZone),
    userRequest: redactAndClip(rawTurn.userText ?? "", 2_000),
    assistantFinalAnswer: redactAndClip(rawTurn.assistantText ?? "", 2_000),
    traceSummary: redactAndClip(
      text(trace.summary) ?? text(source.info.summary) ?? "",
      1_000
    ),
    reflection: redactAndClip(
      text(trace.reflection) ?? text(internal.reflection) ?? "",
      1_000
    ),
    reward: {
      rTask: number(job.payload.rTask),
      reason: redactAndClip(text(job.payload.rewardReason) ?? "", 600)
    },
    toolCalls: rawTurn.toolCalls.map((call, index) => isToolCall(call)
      ? {
          index,
          name: redactAndClip(call.name, 200),
          input: redactAndClip(stableStringify(call.input ?? null), 500),
          output: redactAndClip(stableStringify(call.output ?? null), 800),
          error: call.error ? redactAndClip(call.error, 400) : null,
          success: call.success ?? !call.error
        }
      : {
          index,
          raw: redactAndClip(stableStringify(call), 100)
        })
  };
}

function redactAndClip(value: string, maxChars: number): string {
  return clip(redactSensitiveText(value), maxChars);
}

function validateSpanResult(
  result: { spans?: unknown },
  toolCallCount: number
): SpanDraft[] {
  if (Array.isArray(result.spans) && result.spans.length === 0) return [];
  if (!Array.isArray(result.spans) || result.spans.length < 2 || result.spans.length > 6) {
    throw new Error("span.big_turn returned invalid span count");
  }
  const spans = result.spans.map((value) => {
    if (!isRecord(value)) throw new Error("span.big_turn returned invalid span");
    const start = integer(value.start);
    const end = integer(value.end);
    const spanGoal = text(value.spanGoal)?.trim();
    const summary = text(value.summary)?.trim();
    if (
      start === undefined ||
      end === undefined ||
      start < 0 ||
      start > end ||
      end >= toolCallCount ||
      !spanGoal ||
      !summary
    ) {
      throw new Error("span.big_turn returned invalid span fields");
    }
    return { start, end, spanGoal, summary };
  });
  for (let index = 1; index < spans.length; index += 1) {
    if (spans[index]!.start <= spans[index - 1]!.end) {
      throw new Error("span.big_turn returned overlapping or unordered spans");
    }
  }
  return spans;
}

function isToolCall(value: unknown): value is ToolCallPayload {
  return isRecord(value) && typeof value.name === "string" && value.name.length > 0;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}
