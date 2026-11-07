import {
  compact,
  isRecord,
  pairSourceToolCalls,
  redactCall,
  redactResult,
  renderTool,
  selectSourceTurn,
  stageSourceTurnMessages,
  text,
  type RawSourceMessage,
  type SourceToolCall,
  type SourceToolResult,
  type SourceTurn
} from "./source-turn.js";
import { redactSecrets } from "./secret-redactor.js";

export const DEEPSEEK_HARNESS_SOURCE_ID = "deepseek_harness";

/** One persisted DeepSeek Harness session event. The plugin and the scan feed the same rows. */
export interface DeepseekHarnessEvent {
  type?: unknown;
  seq?: unknown;
  time?: unknown;
  id?: unknown;
  cwd?: unknown;
  agentPreset?: unknown;
  data?: unknown;
}

interface DeepseekTurn {
  turn: number;
  startedAt: string;
  query: string;
  answer: string;
  userIds: string[];
  assistantIds: string[];
  toolCalls: SourceToolCall[];
  toolResults: SourceToolResult[];
  completedAt: string;
  endKind: string;
  sequence: number;
}

/**
 * Streams one DeepSeek Harness session as staged native turns. A turn is one
 * `turn/start` … `turn/end` pair. Only `source.kind === "user"` counts as the question.
 */
export async function* readDeepseekHarnessEvents(
  events: Iterable<DeepseekHarnessEvent>,
  signal?: AbortSignal
): AsyncIterable<RawSourceMessage> {
  let conversationId = "";
  let workspacePath: string | undefined;
  let profileId = "main";
  let current: DeepseekTurn | undefined;
  let ordinal = 0;

  const flush = (reason: string, turn?: SourceTurn): RawSourceMessage[] => {
    if (!current) return [];
    const staged = toStagedMessages(conversationId, current, workspacePath);
    const output = stageSourceTurnMessages(staged, {
      turnId: turnIdFor(conversationId, current.turn),
      sequence: current.sequence,
      startedAt: current.startedAt,
      reason,
      turn
    });
    current = undefined;
    return output;
  };

  for (const event of events) {
    signal?.throwIfAborted();
    const type = text(event.type);
    const data = isRecord(event.data) ? event.data : {};
    if (type === "session") {
      conversationId = text(event.id) || conversationId;
      workspacePath = text(event.cwd) || workspacePath;
      const header = isRecord((event as { header?: unknown }).header) ? (event as { header: Record<string, unknown> }).header : {};
      profileId = text(event.agentPreset) || text(header.agentPreset) || text(data.agentPreset) || profileId;
      continue;
    }
    if (type === "turn/start") {
      if (current) yield* flush("turn_incomplete");
      const turn = numberValue(data.turn);
      if (turn === undefined) continue;
      current = {
        turn,
        startedAt: eventTime(event),
        query: "",
        answer: "",
        userIds: [],
        assistantIds: [],
        toolCalls: [],
        toolResults: [],
        completedAt: "",
        endKind: "",
        sequence: numberValue(event.seq) ?? ordinal
      };
      ordinal += 1;
      continue;
    }
    if (!current) continue;
    if (type === "user/message") {
      if (!isUserKind(data.source)) continue;
      const content = contentText(data.content);
      if (!content) continue;
      current.query = current.query ? `${current.query}\n\n${content}` : content;
      current.userIds.push(text(data.id) || `${conversationId}:${event.seq ?? current.turn}:user`);
      if (!current.startedAt) current.startedAt = eventTime(event);
      continue;
    }
    if (type === "assistant/message") {
      const message = isRecord(data.message) ? data.message : {};
      const content = contentText(message.content);
      if (!content) continue;
      current.answer = current.answer ? `${current.answer}\n\n${content}` : content;
      current.assistantIds.push(text(message.id) || `${conversationId}:${event.seq ?? current.turn}:assistant`);
      current.completedAt = eventTime(event) || current.completedAt;
      continue;
    }
    if (type === "tool/call") {
      const id = text(data.callId) || undefined;
      current.toolCalls.push(compact({
        id,
        name: text(data.name) || "tool",
        input: data.arguments
      }) as unknown as SourceToolCall);
      continue;
    }
    if (type === "tool/result") {
      const message = isRecord(data.message) ? data.message : {};
      const source = isRecord(message.source) ? message.source : {};
      const id = text(source.callId) || toolCallIdFromContent(message.content) || undefined;
      const error = isRecord(data.error) ? data.error : undefined;
      current.toolResults.push(compact({
        id,
        output: contentText(message.content) || undefined,
        status: error ? "error" : "completed",
        success: !error,
        error: error ? `${text(error.code)}: ${text(error.name)}`.replace(/^: /u, "") || error : undefined
      }) as SourceToolResult);
      continue;
    }
    if (type !== "turn/end") continue;
    current.completedAt = eventTime(event) || current.completedAt;
    current.endKind = text(isRecord(data.reason) ? data.reason.kind : undefined);
    yield* finishTurn(conversationId, current, workspacePath, profileId, flush);
  }
  if (current) yield* flush("turn_incomplete");
}

/** Plugin path: reads the same events the scan reads, for the turn that just ended. */
export async function readDeepseekHarnessSourceTurn(
  events: Iterable<DeepseekHarnessEvent>,
  expected: { conversationId?: string; turnId?: string; turn?: number } = {}
): Promise<{ turn: SourceTurn | null; reason?: string }> {
  const turnId = expected.turnId
    || (expected.conversationId !== undefined && expected.turn !== undefined
      ? turnIdFor(expected.conversationId, expected.turn)
      : undefined);
  return selectSourceTurn(readDeepseekHarnessEvents(events), {
    conversationId: expected.conversationId,
    turnId
  });
}

export function turnIdFor(sessionId: string, turn: number): string {
  return `${sessionId}:${turn}`;
}

function finishTurn(
  conversationId: string,
  current: DeepseekTurn,
  workspacePath: string | undefined,
  profileId: string,
  flush: (reason: string, turn?: SourceTurn) => RawSourceMessage[]
): RawSourceMessage[] {
  const turnId = turnIdFor(conversationId, current.turn);
  let reason = "";
  if (!conversationId || !Number.isFinite(current.turn)) reason = "identity_unresolved";
  else if (current.endKind === "aborted") reason = "turn_cancelled";
  else if (!current.endKind) reason = "turn_incomplete";
  else if (!current.query.trim() || !current.answer.trim()) reason = "turn_content_incomplete";
  else if (!current.startedAt || !current.completedAt
    || !Number.isFinite(Date.parse(current.startedAt))
    || !Number.isFinite(Date.parse(current.completedAt))) {
    reason = "timestamp_unresolved";
  }
  const turn: SourceTurn | undefined = reason ? undefined : {
    source: DEEPSEEK_HARNESS_SOURCE_ID,
    conversationId,
    turnId,
    profileId,
    startedAt: current.startedAt,
    completedAt: current.completedAt,
    sequence: current.sequence,
    completionEvidence: `turn_end:${turnId}:${current.endKind}`,
    query: redactSecrets(current.query),
    answer: redactSecrets(current.answer),
    status: current.endKind === "error" || current.endKind === "blocked" ? "failed" : "succeeded",
    toolCalls: pairSourceToolCalls(current.toolCalls, current.toolResults).map(redactCall),
    toolResults: current.toolResults.map(redactResult),
    ...(workspacePath ? { workspacePath } : {})
  };
  return flush(reason, turn);
}

function toStagedMessages(
  conversationId: string,
  turn: DeepseekTurn,
  workspacePath: string | undefined
): RawSourceMessage[] {
  const messages: RawSourceMessage[] = [];
  const baseMeta = workspacePath ? { workspacePath } : {};
  if (turn.query) {
    messages.push({
      messageId: turn.userIds[0] || `${conversationId}:${turn.turn}:user`,
      conversationId,
      role: "user",
      content: turn.query,
      createdAt: turn.startedAt,
      ordinal: turn.sequence,
      rawMeta: { ...baseMeta }
    });
  }
  for (const [index, call] of turn.toolCalls.entries()) {
    messages.push({
      messageId: `${conversationId}:${turn.turn}:call:${index}`,
      conversationId,
      role: "tool",
      content: renderTool(call),
      createdAt: turn.completedAt || turn.startedAt,
      ordinal: turn.sequence,
      rawMeta: { ...baseMeta, toolName: call.name, toolCallId: call.id }
    });
  }
  if (turn.answer) {
    messages.push({
      messageId: turn.assistantIds[turn.assistantIds.length - 1] || `${conversationId}:${turn.turn}:assistant`,
      conversationId,
      role: "assistant",
      content: turn.answer,
      createdAt: turn.completedAt || turn.startedAt,
      ordinal: turn.sequence,
      rawMeta: { ...baseMeta }
    });
  }
  return messages;
}

function isUserKind(source: unknown): boolean {
  return isRecord(source) && text(source.kind) === "user";
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .filter(isRecord)
    .map((block) => {
      if (block.type === "text" && typeof block.text === "string") return block.text.trim();
      return block.type === "tool-result" ? contentText(block.content) : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function toolCallIdFromContent(value: unknown): string {
  if (!Array.isArray(value)) return "";
  for (const block of value) {
    if (isRecord(block) && typeof block.toolCallId === "string") return block.toolCallId;
  }
  return "";
}

function eventTime(event: DeepseekHarnessEvent): string {
  if (typeof event.time === "number" && Number.isFinite(event.time)) return new Date(event.time).toISOString();
  if (typeof event.time === "string") {
    const parsed = Date.parse(event.time);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
