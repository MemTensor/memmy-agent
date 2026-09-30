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

export const OPENCODE_SOURCE_ID = "opencode";

/**
 * Row access to an OpenCode database. The plugin and the scan run on different SQLite
 * drivers, so the queries are injected and only the turn logic below is shared.
 */
export interface OpencodeSession {
  id: string;
  parentId: string | null;
  directory: string | null;
  agent?: string | null;
  revertMessageId?: string | null;
}

export interface OpencodeSource {
  /** Rows from `session`; a session with a parent is a subagent branch. */
  sessions(): Iterable<OpencodeSession>;
  /** Parsed `message.data` rows for one session, ordered by creation time. */
  messages(sessionId: string): Iterable<{ id: string; data: unknown }>;
  /** Parsed `part.data` rows for one message, ordered by creation time. */
  parts(messageId: string): Iterable<{ id: string; data: unknown }>;
}

/**
 * Memmy replaces the user's text with a recall packet before OpenCode persists it, so the
 * question has to be unwrapped again on the way back out. Without this the scan would
 * store the injected memory as the user's own words.
 */
const CURRENT_REQUEST_PATTERN = /<current_user_request>([\s\S]*?)<\/current_user_request>/u;

interface OpencodeAssistant {
  id: string;
  createdAt: string;
  completedAt: string;
  aborted: boolean;
  finish: string;
  agent: string;
  isCompaction: boolean;
  assistantText: string;
  toolCalls: SourceToolCall[];
  toolResults: SourceToolResult[];
  pendingTool: boolean;
  hasOrdinaryTool: boolean;
  hasStructuredOutput: boolean;
}

/**
 * Streams one OpenCode session as staged native turns. A turn is one user message plus
 * every assistant message whose `parentID` points at it, so tool rounds stay inside the
 * turn that triggered them.
 */
export async function* readOpencodeSession(
  source: OpencodeSource,
  session: OpencodeSession,
  signal?: AbortSignal
): AsyncIterable<RawSourceMessage> {
  // A subagent session is its own conversation in OpenCode and is not recorded.
  if (session.parentId) return;
  const messages = visibleOpencodeMessages([...source.messages(session.id)], session.revertMessageId);
  const assistantsByParent = new Map<string, OpencodeAssistant[]>();
  const users: Array<{ id: string; query: string; startedAt: string; isCompaction: boolean; ordinal: number; userAgent: string }> = [];

  for (const [ordinal, row] of messages.entries()) {
    signal?.throwIfAborted();
    const data = isRecord(row.data) ? row.data : {};
    const role = text(data.role);
    if (role === "user") {
      const collected = collectParts(source, row.id);
      users.push({
        id: row.id,
        query: unwrapUserRequest(collected.userText),
        startedAt: epochIso(isRecord(data.time) ? data.time.created : undefined),
        isCompaction: collected.isCompaction,
        ordinal,
        userAgent: text(data.agent)
      });
      continue;
    }
    if (role !== "assistant") continue;
    const parentId = text(data.parentID);
    if (!parentId) continue;
    const collected = collectParts(source, row.id);
    const error = isRecord(data.error) ? data.error : undefined;
    const time = isRecord(data.time) ? data.time : {};
    const assistant: OpencodeAssistant = {
      id: row.id,
      createdAt: epochIso(time.created),
      completedAt: epochIso(time.completed),
      aborted: text(error?.name) === "MessageAbortedError",
      finish: text(data.finish),
      agent: text(data.agent),
      isCompaction: text(data.agent) === "compaction" || data.summary === true,
      assistantText: collected.assistantText,
      toolCalls: collected.toolCalls,
      toolResults: collected.toolResults,
      pendingTool: collected.pendingTool,
      hasOrdinaryTool: collected.hasOrdinaryTool,
      hasStructuredOutput: data.structured !== undefined
    };
    // An assistant with neither text nor a tool is idle bookkeeping (`step-finish` only).
    if (!assistant.assistantText && assistant.toolCalls.length === 0 && !assistant.pendingTool) continue;
    const bucket = assistantsByParent.get(parentId) ?? [];
    bucket.push(assistant);
    assistantsByParent.set(parentId, bucket);
  }

  for (const user of users) {
    signal?.throwIfAborted();
    const assistants = assistantsByParent.get(user.id) ?? [];
    // Compaction inserts a synthetic user row and a summary assistant. Neither is a turn.
    if (user.isCompaction || assistants.some((assistant) => assistant.isCompaction)) continue;
    const answer = assistants.map((assistant) => assistant.assistantText).filter(Boolean).join("\n\n");
    const toolCalls = assistants.flatMap((assistant) => assistant.toolCalls);
    const toolResults = assistants.flatMap((assistant) => assistant.toolResults);
    const last = assistants[assistants.length - 1];
    const completedAt = last?.completedAt || (last?.aborted ? last.createdAt : "");
    const profileId = user.userAgent || assistantProfileId(assistants);
    let reason = "";
    if (!user.query.trim()) reason = "turn_content_incomplete";
    else if (!last) reason = "turn_incomplete";
    else if (assistants.some((assistant) => assistant.pendingTool)) reason = "turn_incomplete";
    else if (!last.aborted && opencodeAssistantStillOpen(last)) reason = "turn_incomplete";
    // An interrupted turn still counts when it produced text or a finished tool.
    else if (!answer.trim() && toolResults.length === 0) reason = "turn_incomplete";
    else if (!profileId) reason = "identity_unresolved";
    else if (!Number.isFinite(Date.parse(user.startedAt)) || !Number.isFinite(Date.parse(completedAt))) reason = "timestamp_unresolved";
    const turn: SourceTurn | undefined = reason ? undefined : {
      source: OPENCODE_SOURCE_ID, conversationId: session.id, turnId: user.id, profileId,
      startedAt: user.startedAt, completedAt, sequence: user.ordinal,
      completionEvidence: last!.aborted ? `assistant_aborted:${last!.id}` : `assistant_completed:${last!.id}`,
      query: redactSecrets(user.query), answer: redactSecrets(answer), status: "succeeded",
      toolCalls: pairSourceToolCalls(toolCalls, toolResults).map(redactCall), toolResults: toolResults.map(redactResult),
      ...(session.directory ? { workspacePath: session.directory } : {})
    };
    yield* stageSourceTurnMessages(
      toStagedMessages(session.id, user, assistants),
      { turnId: user.id, sequence: user.ordinal, startedAt: user.startedAt, reason, turn }
    );
  }
}

/** Streams every top-level session of an OpenCode database as staged native turns. */
export async function* readOpencodeSessions(source: OpencodeSource, signal?: AbortSignal): AsyncIterable<RawSourceMessage> {
  for (const session of source.sessions()) {
    signal?.throwIfAborted();
    yield* readOpencodeSession(source, session, signal);
  }
}

/** Plugin path: reads the same rows the scan reads, for the turn that just went idle. */
export async function readOpencodeSourceTurn(
  source: OpencodeSource,
  expected: { conversationId: string; turnId: string }
): Promise<{ turn: SourceTurn | null; reason?: string }> {
  const session = [...source.sessions()].find((candidate) => candidate.id === expected.conversationId);
  if (!session) return { turn: null, reason: "source_session_missing" };
  return selectSourceTurn(readOpencodeSession(source, session), expected);
}

function collectParts(source: OpencodeSource, messageId: string): {
  userText: string;
  assistantText: string;
  isCompaction: boolean;
  pendingTool: boolean;
  hasOrdinaryTool: boolean;
  toolCalls: SourceToolCall[];
  toolResults: SourceToolResult[];
} {
  let userText = "";
  let assistantText = "";
  let isCompaction = false;
  let pendingTool = false;
  let hasOrdinaryTool = false;
  const toolCalls: SourceToolCall[] = [];
  const toolResults: SourceToolResult[] = [];

  for (const part of source.parts(messageId)) {
    const data = isRecord(part.data) ? part.data : {};
    const kind = text(data.type);
    if (kind === "compaction") {
      isCompaction = true;
    } else if (kind === "text") {
      const value = text(data.text);
      userText = userText ? `${userText}\n${value}` : value;
      assistantText = assistantText ? `${assistantText}\n${value}` : value;
    } else if (kind === "tool") {
      const id = text(data.callID) || undefined;
      const name = text(data.tool) || "tool";
      const state = isRecord(data.state) ? data.state : {};
      const status = text(state.status) || undefined;
      if (status === "pending" || status === "running") pendingTool = true;
      if (isOrdinaryOpencodeTool(data, state)) hasOrdinaryTool = true;
      toolCalls.push(compact({ id, name, status, input: state.input }) as unknown as SourceToolCall);
      if (status === "completed" || status === "error") {
        toolResults.push(compact({
          id, output: state.output ?? state.error, status, success: status === "completed"
        }) as SourceToolResult);
      }
    }
  }

  return { userText, assistantText, isCompaction, pendingTool, hasOrdinaryTool, toolCalls, toolResults };
}

/**
 * OpenCode keeps the prompt loop running when the last assistant is still a
 * tool-calls/unknown step, or when it has a host-side tool that must go back to
 * the model. A persisted `structured` value is the native StructuredOutput
 * success path: prompt.ts writes it and returns "break" without a later text
 * assistant. Provider-executed tools and cleanup-marked interrupted orphans
 * also do not keep the loop open.
 */
function opencodeAssistantStillOpen(last: OpencodeAssistant): boolean {
  if (!last.completedAt) return true;
  if (last.hasStructuredOutput) return false;
  if (!last.finish || last.finish === "tool-calls" || last.finish === "unknown") return true;
  return last.hasOrdinaryTool;
}

function isOrdinaryOpencodeTool(data: Record<string, unknown>, state: Record<string, unknown>): boolean {
  const metadata = isRecord(data.metadata) ? data.metadata : {};
  if (metadata.providerExecuted === true) return false;
  const stateMeta = isRecord(state.metadata) ? state.metadata : {};
  return !(text(state.status) === "error" && stateMeta.interrupted === true);
}

function assistantProfileId(assistants: readonly OpencodeAssistant[]): string {
  for (const assistant of assistants) {
    if (assistant.agent && assistant.agent !== "compaction") return assistant.agent;
  }
  return "";
}

/** Hide the reverted message and everything after it until OpenCode cleanup deletes the rows. */
function visibleOpencodeMessages<T extends { id: string }>(
  messages: readonly T[],
  revertMessageId?: string | null
): T[] {
  if (!revertMessageId) return [...messages];
  const index = messages.findIndex((message) => message.id === revertMessageId);
  return index < 0 ? [...messages] : messages.slice(0, index);
}

function unwrapUserRequest(value: string): string {
  return (CURRENT_REQUEST_PATTERN.exec(value)?.[1] ?? value).trim();
}

function epochIso(value: unknown): string {
  const millis = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(millis) ? new Date(millis).toISOString() : "";
}

function toStagedMessages(
  sessionId: string,
  user: { id: string; query: string; startedAt: string; ordinal: number },
  assistants: readonly OpencodeAssistant[]
): RawSourceMessage[] {
  const messages: RawSourceMessage[] = [{
    messageId: user.id, conversationId: sessionId, role: "user", content: user.query,
    createdAt: user.startedAt, ordinal: user.ordinal, rawMeta: {}
  }];
  for (const [index, assistant] of assistants.entries()) {
    const base = { conversationId: sessionId, createdAt: assistant.completedAt || assistant.createdAt, ordinal: user.ordinal + index + 1 };
    for (const [callIndex, call] of assistant.toolCalls.entries()) {
      messages.push({
        ...base, messageId: `${assistant.id}:call:${callIndex}`, role: "tool", content: renderTool(call),
        rawMeta: { toolName: call.name, toolCallId: call.id }
      });
    }
    if (assistant.assistantText) {
      messages.push({ ...base, messageId: assistant.id, role: "assistant", content: assistant.assistantText, rawMeta: {} });
    }
  }
  return messages;
}
