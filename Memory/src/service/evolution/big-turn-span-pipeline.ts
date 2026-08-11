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
- Use the same language as the user's request.

summary requirements:
- State what was done and what result was obtained.
- Preserve important decisions, failures, fixes, and verification results.
- Be concise and evidence-based.

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
  buildMemory(input: Record<string, unknown>): MemoryRow;
  enqueueJob(input: EnqueueJobInput): EvolutionJobRecord;
  namespaceIdFromMemory(memory: MemoryRow): string;
  embedAfterCapture(): boolean;
}

export class BigTurnSpanPipeline {
  constructor(private readonly deps: BigTurnSpanDeps) {}

  async splitAndStore(job: EvolutionJobRecord): Promise<void> {
    if (!SPAN_BIG_TURN_ENABLED || !this.deps.llm.isConfigured()) return;
    const source = job.targetMemoryId
      ? this.deps.repos.memories.get(job.targetMemoryId)
      : undefined;
    const rawTurnId = text(job.payload.rawTurnId);
    const rawTurn = rawTurnId
      ? this.deps.repos.runtime.getRawTurn(rawTurnId)
      : undefined;
    if (!source || !rawTurn || rawTurn.toolCalls.length < SPAN_BIG_TURN_MIN_TOOL_CALLS) return;

    const result = await this.deps.llm.completeJson<{
      reason?: unknown;
      spans?: unknown;
    }>([
      { role: "system", content: SPAN_BIG_TURN_PROMPT },
      {
        role: "user",
        content: stableStringify(bigTurnPromptPayload(source, rawTurn, job))
      }
    ], {
      operation: SPAN_BIG_TURN_OPERATION,
      thinkingMode: "disabled",
      temperature: 0.6,
      maxTokens: 4096
    });
    const spans = validateSpanResult(result, rawTurn.toolCalls.length);
    if (!spans) return;
    this.deps.repos.transaction(() => {
      const spanIds: string[] = [];
      for (const [spanIndex, span] of spans.entries()) {
        spanIds.push(this.storeSpan({ source, rawTurn, job, span, spanIndex }));
      }
      this.linkSpansToSourceTrace(source.id, spanIds, job);
    });
  }

  private storeSpan(input: {
    source: MemoryRow;
    rawTurn: RawTurnRecord;
    job: EvolutionJobRecord;
    span: SpanDraft;
    spanIndex: number;
  }): string {
    const { source, rawTurn, job, span, spanIndex } = input;
    const id = spanId(source.id, span);
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
    const previous = this.deps.repos.memories.get(id);
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
): SpanDraft[] | null {
  if (Array.isArray(result.spans) && result.spans.length === 0) return null;
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
