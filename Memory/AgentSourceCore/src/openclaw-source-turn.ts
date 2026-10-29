import {
  compact,
  isRecord,
  iso,
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

export const OPENCLAW_SOURCE_ID = "openclaw";

/**
 * Row access to an OpenClaw agent database. The plugin and the scan run on different
 * SQLite drivers, so the queries are injected and only the turn logic below is shared.
 */
export interface OpenclawWindow {
  sessionId: string;
  sessionKey: string;
  profileId?: string | null;
}

export interface OpenclawTranscriptSource {
  /** Windows from `session_windows`, mapping the transcript's window id to its session key. */
  windows(): Iterable<OpenclawWindow>;
  /** Parsed `transcript_events.event_json` rows for one window, ordered by `seq`. */
  events(sessionId: string): Iterable<{ seq: number; event: unknown }>;
}

/**
 * OpenClaw wakes the agent up on its own for heartbeats, cron and similar events, and
 * records those as ordinary user messages. They are the product talking to itself, so
 * they never become a memory.
 */
const INTERNAL_WAKE_PROMPTS = new Set([
  "[OpenClaw heartbeat poll]",
  "[OpenClaw cron wake]",
  "[OpenClaw exec completion]",
  "[OpenClaw session event]"
]);

/** Dreaming runs in its own session key and is a background routine, not a conversation. */
const DREAMING_SESSION_MARKER = "dreaming-narrative-";

/** Events that carry neither a question nor an answer. */
const IGNORED_EVENT_TYPES = new Set(["session", "thinking_level_change", "custom"]);

interface OpenclawEvent {
  eventId: string;
  seq: number;
  role: string;
  runId: string;
  runTerminal: boolean;
  stopReason: string;
  createdAt: string;
  userText: string;
  assistantText: string;
  toolCalls: SourceToolCall[];
  toolResults: SourceToolResult[];
}

/**
 * Streams one OpenClaw session window as staged native turns. A turn is one `runId`: the
 * same run can contain more than one user message, so the boundary follows the run rather
 * than the appearance of a user role.
 */
export async function* readOpenclawWindow(
  source: OpenclawTranscriptSource,
  window: OpenclawWindow,
  signal?: AbortSignal
): AsyncIterable<RawSourceMessage> {
  if (window.sessionKey.includes(DREAMING_SESSION_MARKER)) return;
  let current: OpenclawEvent[] = [];
  let pendingUsers: OpenclawEvent[] = [];
  let runId = "";

  function finish(): RawSourceMessage[] {
    if (!runId || current.length === 0) {
      current = []; runId = ""; return [];
    }
    const events = current;
    current = []; runId = "";
    const query = events.filter((event) => event.userText).map((event) => event.userText).join("\n\n");
    if (isInternalWake(query)) return [];
    const closing = [...events].reverse().find((event) => event.runTerminal && event.assistantText)
      ?? [...events].reverse().find((event) => event.stopReason === "stop" && event.assistantText);
    const toolCalls = events.flatMap((event) => event.toolCalls);
    const toolResults = events.flatMap((event) => event.toolResults);
    const startedAt = events[0]!.createdAt;
    const completedAt = closing?.createdAt ?? "";
    let reason = "";
    if (!query.trim()) reason = "turn_content_incomplete";
    else if (!closing) reason = "turn_incomplete";
    else if (!Number.isFinite(Date.parse(startedAt)) || !Number.isFinite(Date.parse(completedAt))) reason = "timestamp_unresolved";
    const turnId = events.find((event) => event.runId)?.runId ?? "";
    const turn: SourceTurn | undefined = reason ? undefined : {
      source: OPENCLAW_SOURCE_ID, conversationId: window.sessionKey, turnId,
      profileId: text(window.profileId) || profileIdFromSessionKey(window.sessionKey),
      startedAt, completedAt,
      sequence: events[0]!.seq, completionEvidence: `run_terminal:${closing!.eventId}`,
      query: redactSecrets(query), answer: redactSecrets(closing!.assistantText), status: "succeeded",
      toolCalls: pairSourceToolCalls(toolCalls, toolResults).map(redactCall), toolResults: toolResults.map(redactResult)
    };
    return stageSourceTurnMessages(events.flatMap(toStagedMessages(window.sessionKey)), {
      turnId, sequence: events[0]!.seq, startedAt, reason, turn
    });
  }

  for (const row of source.events(window.sessionId)) {
    signal?.throwIfAborted();
    const event = toOpenclawEvent(row);
    if (!event) continue;
    // A user message can be recorded before its run is known; it belongs to the run that
    // starts right after it.
    if (!event.runId) {
      if (event.userText) pendingUsers.push(event);
      continue;
    }
    if (event.runId !== runId) {
      yield* finish();
      runId = event.runId;
      current = pendingUsers.map((pending) => ({ ...pending, runId }));
      pendingUsers = [];
    }
    current.push(event);
  }
  yield* finish();
}

/** Streams every window of an OpenClaw database as staged native turns. */
export async function* readOpenclawTranscripts(
  source: OpenclawTranscriptSource,
  signal?: AbortSignal
): AsyncIterable<RawSourceMessage> {
  for (const window of source.windows()) {
    signal?.throwIfAborted();
    yield* readOpenclawWindow(source, window, signal);
  }
}

/** Plugin path: reads the same rows the scan reads, for the run that just ended. */
export async function readOpenclawSourceTurn(
  source: OpenclawTranscriptSource,
  expected: { sessionId?: string; sessionKey?: string; runId: string }
): Promise<{ turn: SourceTurn | null; reason?: string }> {
  const windows = [...source.windows()].filter((window) =>
    (!expected.sessionId || window.sessionId === expected.sessionId) &&
    (!expected.sessionKey || window.sessionKey === expected.sessionKey));
  const window = windows[0];
  if (!window) return { turn: null, reason: "source_window_unresolved" };
  return selectSourceTurn(readOpenclawWindow(source, window), {
    conversationId: window.sessionKey,
    turnId: expected.runId
  });
}

function profileIdFromSessionKey(sessionKey: string): string {
  const parts = sessionKey.split(":");
  return parts[0] === "agent" && parts[1] ? parts[1] : "main";
}

function isInternalWake(query: string): boolean {
  const lines = query.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((line) => INTERNAL_WAKE_PROMPTS.has(line));
}

function toOpenclawEvent(row: { seq: number; event: unknown }): OpenclawEvent | undefined {
  const record = isRecord(row.event) ? row.event : undefined;
  if (!record || IGNORED_EVENT_TYPES.has(text(record.type))) return undefined;
  const message = isRecord(record.message) ? record.message : undefined;
  if (!message) return undefined;
  const meta = isRecord(message.__openclaw) ? message.__openclaw : {};
  const role = text(message.role);
  const blocks = Array.isArray(message.content) ? message.content.filter(isRecord) : [];
  const plain = typeof message.content === "string" ? message.content : "";
  const toolCalls: SourceToolCall[] = [];
  const toolResults: SourceToolResult[] = [];
  const seenResultIds = new Set<string>();
  let assistantText = "";
  let userText = role === "user" ? plain : "";

  const pushResult = (id: string | undefined, output: unknown, failed: boolean): void => {
    if (id && seenResultIds.has(id)) return;
    if (id) seenResultIds.add(id);
    toolResults.push(compact({
      id,
      output,
      success: !failed,
      status: failed ? "failed" : "completed"
    }) as SourceToolResult);
  };

  for (const block of blocks) {
    const kind = text(block.type);
    if (kind === "text" && role === "assistant") {
      assistantText = assistantText ? `${assistantText}\n${text(block.text)}` : text(block.text);
    } else if (kind === "text" && role === "user") {
      userText = userText ? `${userText}\n${text(block.text)}` : text(block.text);
    } else if (kind === "toolCall" || kind === "toolUse") {
      toolCalls.push(compact({
        id: text(block.id) || undefined, name: text(block.name) || "tool", input: block.input ?? block.arguments
      }) as unknown as SourceToolCall);
    } else if (kind === "toolResult") {
      pushResult(
        text(block.toolCallId) || text(block.tool_call_id) || text(block.id) || text(message.toolCallId) || text(message.tool_call_id) || undefined,
        block.content ?? block.text,
        message.isError === true || block.isError === true
      );
    }
  }

  if ((role === "toolResult" || role === "tool") && toolResults.length === 0) {
    const output = plain || blocks.map((block) => text(block.text) || (typeof block.content === "string" ? block.content : "")).filter(Boolean).join("\n");
    pushResult(
      text(message.tool_call_id) || text(message.toolCallId) || text(message.toolCallID) || undefined,
      output || undefined,
      message.isError === true
    );
  }

  return {
    eventId: text(record.id),
    seq: row.seq,
    role,
    runId: text(meta.runId),
    runTerminal: meta.runTerminal === true,
    stopReason: text(message.stopReason),
    createdAt: iso(record.timestamp) || iso(message.timestamp),
    userText,
    assistantText,
    toolCalls,
    toolResults
  };
}

function toStagedMessages(sessionKey: string) {
  return (event: OpenclawEvent): RawSourceMessage[] => {
    const base = { messageId: event.eventId || `${sessionKey}:${event.seq}`, conversationId: sessionKey, createdAt: event.createdAt, ordinal: event.seq };
    const messages: RawSourceMessage[] = [];
    if (event.userText) messages.push({ ...base, role: "user", content: event.userText, rawMeta: {} });
    if (event.assistantText) {
      messages.push({ ...base, messageId: `${base.messageId}:text`, role: "assistant", content: event.assistantText, rawMeta: {} });
    }
    for (const [index, call] of event.toolCalls.entries()) {
      messages.push({
        ...base, messageId: `${base.messageId}:call:${index}`, role: "tool", content: renderTool(call),
        rawMeta: { toolName: call.name, toolCallId: call.id }
      });
    }
    for (const [index, result] of event.toolResults.entries()) {
      messages.push({
        ...base, messageId: `${base.messageId}:result:${index}`, role: "tool",
        content: renderTool({ ...result, name: "tool" }), rawMeta: { toolCallId: result.id }
      });
    }
    return messages;
  };
}
