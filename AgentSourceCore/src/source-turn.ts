import { redactSecrets } from "./secret-redactor.js";

export interface SourceToolResult {
  id?: string;
  output?: unknown;
  status?: string;
  success?: boolean;
  error?: unknown;
}
export interface SourceToolCall extends SourceToolResult {
  name: string;
  input?: unknown;
}

/**
 * One completed native turn, read from an agent's own on-disk record. Every source
 * fills the same fields so the hook/plugin channel and the offline scan can submit
 * the same turn through `completeSourceTurn` and deduplicate on identity alone.
 */
export interface SourceTurn {
  source: string;
  conversationId: string;
  turnId: string;
  /** Native profile the disk record belongs to. Hook and scan must submit the same value. */
  profileId?: string;
  startedAt: string;
  completedAt: string;
  sequence: number;
  completionEvidence: string;
  query: string;
  answer: string;
  status: "succeeded" | "failed";
  toolCalls: SourceToolCall[];
  toolResults: SourceToolResult[];
  workspacePath?: string;
}

/** Shape every native reader stages, before it is turned into a ConversationMessage. */
export interface RawSourceMessage {
  messageId: string;
  conversationId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  createdAt: string;
  ordinal: number;
  rawMeta: Readonly<Record<string, unknown>>;
}

/** Canonical turn is stored once, on the final staged message, including its native completion evidence. */
export function sourceTurnFromMessages(messages: readonly { rawMeta: Readonly<Record<string, unknown>> }[]): SourceTurn | null {
  if (messages.some(message => message.rawMeta.sourceTurnState && message.rawMeta.sourceTurnState !== "complete")) return null;
  const turns = messages.map(message => message.rawMeta.sourceTurn).filter(isRecord);
  if (turns.length === 0) return null;
  if (turns.some(turn => canonicalTurnContent(turn) !== canonicalTurnContent(turns[0]!))) return null;
  const turn = turns[0]!;
  if (!text(turn.source) || !text(turn.conversationId) || !text(turn.turnId) || !text(turn.completionEvidence)) return null;
  return turn as unknown as SourceTurn;
}

/** Preserve the reason a staged native turn cannot be submitted, including conflicting complete evidence. */
export function sourceTurnFailureReason(messages: readonly { rawMeta: Readonly<Record<string, unknown>> }[]): string {
  for (const message of messages) {
    const state = text(message.rawMeta.sourceTurnState);
    if (state && state !== "complete") return text(message.rawMeta.sourceTurnReason) || state;
  }
  const turns = messages.map(message => message.rawMeta.sourceTurn).filter(isRecord);
  if (turns.length > 1 && turns.some(turn => canonicalTurnContent(turn) !== canonicalTurnContent(turns[0]!))) {
    return "source_turn_content_conflict";
  }
  return "identity_unresolved";
}

/**
 * A reader that stages native turns marks every message with its turn state, so the
 * scan can tell an unfinished native turn apart from a source that has no native
 * reader at all and still needs the legacy add-memory path.
 */
export function hasStagedSourceTurn(message: { rawMeta: Readonly<Record<string, unknown>> } | undefined): boolean {
  return typeof message?.rawMeta.sourceTurnState === "string";
}

export function buildSourceTurnRequest(turn: SourceTurn, channel: "hook" | "agent_source_scan", profileId?: string) {
  const resolvedProfileId = profileId || turn.profileId || "default";
  return {
    sourceTurn: {
      source: turn.source, profileId: resolvedProfileId, conversationId: turn.conversationId, turnId: turn.turnId,
      startedAt: turn.startedAt, completedAt: turn.completedAt, sequence: turn.sequence, completionEvidence: turn.completionEvidence
    },
    source: turn.source, profileId: resolvedProfileId, channel, query: turn.query, answer: turn.answer,
    status: turn.status, toolCalls: turn.toolCalls, toolResults: turn.toolResults,
    workspacePath: turn.workspacePath
  };
}

/**
 * Merges each result into its call by id. An id that appears more than once on either
 * side stays unpaired: position is never used as a fallback, because a retried tool
 * would otherwise inherit the wrong output.
 */
export function pairSourceToolCalls(
  toolCalls: readonly SourceToolCall[],
  toolResults: readonly SourceToolResult[]
): SourceToolCall[] {
  const resultsById = new Map<string, SourceToolResult>();
  const duplicateIds = new Set<string>();
  for (const result of toolResults) {
    if (!result.id) continue;
    if (resultsById.has(result.id)) duplicateIds.add(result.id);
    else resultsById.set(result.id, result);
  }
  const callCounts = new Map<string, number>();
  for (const call of toolCalls) {
    if (call.id) callCounts.set(call.id, (callCounts.get(call.id) ?? 0) + 1);
  }
  return toolCalls.map(call => {
    const result = call.id && callCounts.get(call.id) === 1 && !duplicateIds.has(call.id) ? resultsById.get(call.id) : undefined;
    return result ? { ...call, ...result, name: call.name, input: call.input } : call;
  });
}

/** Redacts a turn's free text and tool payloads on the way out of a reader. */
export function redactSourceTurn(turn: SourceTurn): SourceTurn {
  return {
    ...turn,
    query: redactSecrets(turn.query),
    answer: redactSecrets(turn.answer),
    toolCalls: turn.toolCalls.map(redactCall),
    toolResults: turn.toolResults.map(redactResult)
  };
}

/**
 * Stamps the shared turn identity onto every staged message and attaches the canonical
 * turn to the last one when it is complete. Readers call this instead of writing the
 * `sourceTurn*` meta keys by hand, so hook and scan observe the same staging contract.
 */
export function stageSourceTurnMessages<T extends RawSourceMessage>(
  messages: readonly T[],
  input: { turnId: string; sequence?: number; startedAt?: string; reason?: string; turn?: SourceTurn }
): T[] {
  const reason = input.reason ?? "";
  const staged = messages.map(message => ({
    ...message,
    rawMeta: {
      ...message.rawMeta,
      sourceTurnId: input.turnId || undefined,
      ...(input.sequence === undefined ? {} : { sourceTurnSequence: input.sequence }),
      ...(input.startedAt ? { sourceTurnStartedAt: input.startedAt } : {}),
      sourceTurnState: reason || "complete",
      sourceTurnReason: reason || undefined
    }
  })) as T[];
  const last = staged[staged.length - 1];
  if (!reason && input.turn && last) {
    last.rawMeta = { ...last.rawMeta, sourceTurn: input.turn } as typeof last.rawMeta;
  }
  return staged;
}

/**
 * Picks the one turn a hook/plugin asked for out of a staged message stream. Shared by
 * every source so the realtime channel resolves identity exactly like the scan does:
 * an unresolved or conflicting turn is reported instead of being written.
 */
export async function selectSourceTurn(
  messages: AsyncIterable<RawSourceMessage>,
  expected: { conversationId?: string; turnId?: string } = {}
): Promise<{ turn: SourceTurn | null; reason?: string }> {
  let latest: SourceTurn | null = null;
  let observed: SourceTurn | null = null;
  let conflict = false;
  let unresolved = false;
  let reason = "identity_unresolved";
  let latestTurnId: unknown;
  for await (const message of messages) {
    if (expected.conversationId && message.conversationId !== expected.conversationId) return { turn: null, reason: "identity_conflict" };
    if (expected.turnId && message.rawMeta.sourceTurnId !== expected.turnId) continue;
    if (message.rawMeta.sourceTurnId !== latestTurnId) {
      latest = null; observed = null; conflict = false; unresolved = false;
    }
    latestTurnId = message.rawMeta.sourceTurnId;
    reason = text(message.rawMeta.sourceTurnReason) || "turn_incomplete";
    if (message.rawMeta.sourceTurnState !== "complete") { latest = null; unresolved = true; }
    const turn = sourceTurnFromMessages([message]);
    if (turn) {
      if (observed && canonicalTurnContent(observed) !== canonicalTurnContent(turn)) conflict = true;
      observed = turn;
      latest = turn;
    }
  }
  if (conflict) return { turn: null, reason: "source_turn_content_conflict" };
  if (unresolved) return { turn: null, reason };
  return latest ? { turn: latest } : { turn: null, reason };
}

export function canonicalTurnContent(turn: Record<string, unknown> | SourceTurn): string {
  const { sequence: _sequence, ...content } = turn;
  return JSON.stringify(content);
}

export function redactCall(call: SourceToolCall): SourceToolCall { return { ...call, name: redactSecrets(call.name), ...redactResult(call), ...(call.input !== undefined ? { input: redactValue(call.input) } : {}) }; }
export function redactResult(result: SourceToolResult): SourceToolResult { return { ...result, ...(result.output !== undefined ? { output: redactValue(result.output) } : {}), ...(result.error !== undefined ? { error: redactValue(result.error) } : {}) }; }
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactValue(entry)]));
  return value;
}
export function toolSuccess(payload: Record<string, unknown>): boolean | undefined {
  if (typeof payload.success === "boolean") return payload.success;
  if (typeof payload.is_error === "boolean") return !payload.is_error;
  if ((payload.error !== undefined && payload.error !== null) || payload.status === "failed" || payload.status === "cancelled") return false;
  if (payload.status === "completed" || payload.status === "succeeded") return true;
  return undefined;
}
export function renderTool(tool: SourceToolCall): string { return [`Tool: ${tool.name}`, tool.id ? `Call ID: ${tool.id}` : undefined, tool.status ? `Status: ${tool.status}` : undefined, tool.input !== undefined ? `Input:\n${format(tool.input)}` : undefined, tool.output !== undefined ? `Output:\n${format(tool.output)}` : undefined].filter(Boolean).join("\n\n"); }
export function format(value: unknown): string { return typeof value === "string" ? value.trim() : JSON.stringify(value, null, 2); }
export function compact(value: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)); }
export function text(value: unknown): string { return typeof value === "string" ? value : ""; }
export function iso(value: unknown): string { const parsed = typeof value === "string" ? Date.parse(value) : NaN; return Number.isFinite(parsed) ? new Date(parsed).toISOString() : ""; }
export function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
