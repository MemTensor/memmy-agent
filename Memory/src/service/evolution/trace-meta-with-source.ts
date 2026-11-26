import { traceMetaFromMemory } from "../../algorithm/plugin-algorithms.js";
import type { RawTurnRecord, Repositories } from "../../storage/repositories.js";
import type { MemoryRow, ToolCallPayload } from "../../types.js";
import { isRecord } from "../../utils/json.js";

type TraceMeta = NonNullable<ReturnType<typeof traceMetaFromMemory>>;

export function traceMetaWithSource(repos: Repositories, memory: MemoryRow | undefined | null): TraceMeta | null {
  if (!memory) return null;
  const id = rawTurnIdFromMemory(memory);
  return traceMetaFromMemoryWithRaw(memory, id ? repos.runtime.getRawTurn(id) : undefined);
}

function traceMetaFromMemoryWithRaw(memory: MemoryRow, rawTurn?: RawTurnRecord): TraceMeta | null {
  const trace = traceMetaFromMemory(memory);
  if (!trace || !rawTurn) return trace;

  const internalTrace = isRecord(memory.properties.internal_info.trace)
    ? memory.properties.internal_info.trace
    : {};
  const rawSpan = isRecord(internalTrace.raw_span) ? internalTrace.raw_span : {};
  const hasUserSpan = rawSpan.user_text === true;
  const hasAgentSpan = rawSpan.agent_text === true;
  const isRedacted = Boolean(rawTurn.redactedAt || rawTurn.deletedAt);

  return {
    ...trace,
    toolCalls: isRedacted
      ? trace.toolCalls
      : rawTurn.toolCalls.filter(isToolCallPayload),
    userText: isRedacted
      ? (hasUserSpan ? "[REDACTED]" : trace.userText)
      : (trace.userText || (hasUserSpan ? rawTurn.userText ?? "" : "")),
    agentText: isRedacted
      ? (hasAgentSpan ? "[REDACTED]" : trace.agentText)
      : (trace.agentText || (hasAgentSpan ? rawTurn.assistantText ?? "" : ""))
  };
}

export function rawTurnIdFromMemory(memory: MemoryRow): string | undefined {
  const sourceRawTurnId = memory.properties.internal_info.source_raw_turn_id;
  if (typeof sourceRawTurnId === "string" && sourceRawTurnId) return sourceRawTurnId;
  const rawTurnId = memory.properties.internal_info.raw_turn_id;
  if (typeof rawTurnId === "string" && rawTurnId) return rawTurnId;
  const trace = memory.properties.internal_info.trace;
  return isRecord(trace) ? stringFromRecord(trace, "raw_turn_id") : undefined;
}

function stringFromRecord(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function isToolCallPayload(value: unknown): value is ToolCallPayload {
  return isRecord(value) && typeof value.name === "string";
}
