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
  toolSuccess,
  type RawSourceMessage,
  type SourceToolCall,
  type SourceToolResult,
  type SourceTurn
} from "./source-turn.js";
import { redactSecrets } from "./secret-redactor.js";

export const CURSOR_SOURCE_ID = "cursor";

/**
 * Row access to Cursor's global `state.vscdb`. The hook and the scan run on different
 * SQLite drivers - the bundled hook may only use `node:sqlite`, the scan uses the
 * driver its workspace already depends on - so the queries are injected and only the
 * turn logic below is shared.
 */
export interface CursorVscdbSource {
  /** Main chats only: `composerHeaders.isSubagent = 0`. */
  mainComposerIds(): Iterable<string>;
  /** Parsed `cursorDiskKV` row `composerData:{composerId}`. */
  composerData(composerId: string): unknown;
  /** Parsed `cursorDiskKV` row `bubbleId:{composerId}:{bubbleId}`. */
  bubble(composerId: string, bubbleId: string): unknown;
}

const USER_BUBBLE = 1;
const ASSISTANT_BUBBLE = 2;

interface CursorBubble {
  bubbleId: string;
  type: number;
  createdAt: string;
  text: string;
  requestId: string;
  tool?: Record<string, unknown>;
}

/**
 * Streams one Cursor main chat as staged native turns. A turn starts at a user bubble
 * that carries real text and ends before the next one, so the assistant's intermediate
 * progress notes stay inside the turn they belong to.
 */
export async function* readCursorComposer(
  source: CursorVscdbSource,
  composerId: string,
  signal?: AbortSignal
): AsyncIterable<RawSourceMessage> {
  signal?.throwIfAborted();
  const data = source.composerData(composerId);
  if (!isRecord(data) || isRecord(data.subagentInfo)) return;
  const headers = Array.isArray(data.fullConversationHeadersOnly) ? data.fullConversationHeadersOnly : [];
  const composerStatus = text(data.status);

  let current: CursorBubble[] = [];
  let turnBubbleId = "";
  let sequence = 0;

  function finish(isLastTurn: boolean): RawSourceMessage[] {
    if (!turnBubbleId || current.length === 0) {
      current = []; turnBubbleId = ""; return [];
    }
    const messages = current.flatMap(toStagedMessage(composerId));
    const query = current.filter(bubble => bubble.type === USER_BUBBLE).map(bubble => bubble.text).join("\n\n");
    // Only the closing answer is the reply. Earlier assistant texts in the same turn
    // are progress notes that were already rendered next to their tool calls.
    const closing = [...current].reverse().find(bubble => bubble.type === ASSISTANT_BUBBLE && bubble.text);
    const startedAt = current[0]!.createdAt;
    const completedAt = closing?.createdAt ?? "";
    const toolCalls: SourceToolCall[] = [];
    const toolResults: SourceToolResult[] = [];
    for (const bubble of current) {
      if (!bubble.tool) continue;
      const { call, result } = toolFromBubble(bubble.tool);
      if (call) toolCalls.push(call);
      if (result) toolResults.push(result);
    }
    const hasOpenTools = current.some((bubble) => bubble.tool && isOpenCursorTool(bubble.tool));
    let reason = "";
    if (!query.trim()) reason = "turn_content_incomplete";
    else if (hasOpenTools) reason = "turn_incomplete";
    else if (isLastTurn && composerStatus === "generating") reason = "turn_incomplete";
    else if (!closing || !closing.text.trim()) reason = "turn_incomplete";
    else if (!Number.isFinite(Date.parse(startedAt)) || !Number.isFinite(Date.parse(completedAt))) reason = "timestamp_unresolved";
    const turn: SourceTurn | undefined = reason ? undefined : {
      source: CURSOR_SOURCE_ID, conversationId: composerId, turnId: turnBubbleId, profileId: "default",
      startedAt, completedAt, sequence,
      completionEvidence: `assistant_text:${closing!.bubbleId}`,
      query: redactSecrets(query), answer: redactSecrets(closing!.text), status: "succeeded",
      toolCalls: pairSourceToolCalls(toolCalls, toolResults).map(redactCall), toolResults: toolResults.map(redactResult)
    };
    const staged = stageSourceTurnMessages(messages, { turnId: turnBubbleId, sequence, startedAt, reason, turn });
    current = []; turnBubbleId = "";
    return staged;
  }

  for (const [index, header] of headers.entries()) {
    signal?.throwIfAborted();
    if (!isRecord(header)) continue;
    const bubble = readBubble(source, composerId, header);
    if (!bubble) continue;
    // A user bubble with no typed text is an injected context message, not a new turn.
    if (bubble.type === USER_BUBBLE && bubble.text.trim()) {
      yield* finish(false);
      turnBubbleId = bubble.bubbleId;
      sequence = index;
    }
    if (!turnBubbleId) continue;
    if (bubble.type === ASSISTANT_BUBBLE && !bubble.text && !bubble.tool) continue;
    current.push(bubble);
  }
  yield* finish(true);
}

/**
 * Resolves the turn the Cursor `stop` hook just finished. The payload carries
 * `generation_id`, which is the user bubble's `requestId`; the cross-channel turn id is
 * that bubble's `bubbleId`, because the scan cannot rely on `requestId` being present.
 */
export function resolveCursorTurnId(
  source: CursorVscdbSource,
  composerId: string,
  requestId: string
): string | undefined {
  if (!requestId) return undefined;
  const data = source.composerData(composerId);
  if (!isRecord(data)) return undefined;
  const headers = Array.isArray(data.fullConversationHeadersOnly) ? data.fullConversationHeadersOnly : [];
  for (const header of headers) {
    if (!isRecord(header) || header.type !== USER_BUBBLE) continue;
    const bubble = readBubble(source, composerId, header);
    if (bubble?.requestId === requestId && bubble.text.trim()) return bubble.bubbleId;
  }
  return undefined;
}

/** Hook path: reads the same rows the scan reads, for one identified turn. */
export async function readCursorSourceTurn(
  source: CursorVscdbSource,
  expected: { conversationId: string; requestId?: string; turnId?: string }
): Promise<{ turn: SourceTurn | null; reason?: string }> {
  const turnId = expected.turnId
    || (expected.requestId ? resolveCursorTurnId(source, expected.conversationId, expected.requestId) : undefined);
  if (!turnId) return { turn: null, reason: "identity_unresolved" };
  return selectSourceTurn(readCursorComposer(source, expected.conversationId), { conversationId: expected.conversationId, turnId });
}

function readBubble(source: CursorVscdbSource, composerId: string, header: Record<string, unknown>): CursorBubble | undefined {
  const bubbleId = text(header.bubbleId);
  if (!bubbleId) return undefined;
  const raw = source.bubble(composerId, bubbleId);
  if (!isRecord(raw)) return undefined;
  const type = typeof raw.type === "number" ? raw.type : Number.NaN;
  if (type !== USER_BUBBLE && type !== ASSISTANT_BUBBLE) return undefined;
  return {
    bubbleId,
    type,
    createdAt: iso(raw.createdAt) || iso(header.createdAt),
    text: text(raw.text).trim(),
    requestId: text(raw.requestId),
    tool: isRecord(raw.toolFormerData) ? raw.toolFormerData : undefined
  };
}

function isOpenCursorTool(tool: Record<string, unknown>): boolean {
  const status = text(tool.status);
  return status === "running" || status === "pending" || status === "generating";
}

/** Cursor keeps a call and its result on the same bubble, so both are read from it. */
function toolFromBubble(tool: Record<string, unknown>): { call?: SourceToolCall; result?: SourceToolResult } {
  const id = text(tool.toolCallId) || undefined;
  const name = text(tool.name) || "tool";
  const status = text(tool.status) || undefined;
  const success = toolSuccess(tool);
  const input = tool.rawArgs ?? tool.params;
  const output = tool.result;
  const call = compact({ id, name, status, success, error: tool.error ?? undefined, input, output }) as unknown as SourceToolCall;
  const result = output === undefined || output === null
    ? undefined
    : compact({ id, output, status, success, error: tool.error ?? undefined }) as SourceToolResult;
  return { call, result };
}

function toStagedMessage(composerId: string) {
  return (bubble: CursorBubble, index: number): RawSourceMessage[] => {
    const base = { messageId: bubble.bubbleId, conversationId: composerId, createdAt: bubble.createdAt, ordinal: index };
    if (bubble.type === USER_BUBBLE) {
      return bubble.text ? [{ ...base, role: "user" as const, content: bubble.text, rawMeta: { cursorBubbleType: bubble.type } }] : [];
    }
    if (bubble.tool) {
      const { call } = toolFromBubble(bubble.tool);
      return [{
        ...base,
        role: "tool" as const,
        content: renderTool(call ?? { name: "tool" }),
        rawMeta: { cursorBubbleType: bubble.type, toolName: text(bubble.tool.name) || undefined, toolCallId: text(bubble.tool.toolCallId) || undefined }
      }];
    }
    return bubble.text ? [{ ...base, role: "assistant" as const, content: bubble.text, rawMeta: { cursorBubbleType: bubble.type } }] : [];
  };
}
