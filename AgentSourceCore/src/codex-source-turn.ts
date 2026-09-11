import { basename } from "node:path";
import { readJsonlObjects } from "./jsonl-lines.js";
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
export interface SourceTurn {
  source: "codex";
  conversationId: string;
  turnId: string;
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
export interface RawCodexMessage {
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
  if (turn.source !== "codex" || !text(turn.conversationId) || !text(turn.turnId) || !text(turn.completionEvidence)) return null;
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

export function buildSourceTurnRequest(turn: SourceTurn, channel: "hook" | "agent_source_scan", profileId = "default") {
  return {
    sourceTurn: {
      source: turn.source, profileId, conversationId: turn.conversationId, turnId: turn.turnId,
      startedAt: turn.startedAt, completedAt: turn.completedAt, sequence: turn.sequence, completionEvidence: turn.completionEvidence
    },
    source: turn.source, profileId, channel, query: turn.query, answer: turn.answer,
    status: turn.status, toolCalls: turn.toolCalls, toolResults: turn.toolResults,
    workspacePath: turn.workspacePath
  };
}

/** Read one native turn at a time; neither assistant text alone nor EOF proves completion. */
export async function* readCodexRollout(
  filePath: string,
  signal?: AbortSignal,
  stopEvidence?: { conversationId?: string; turnId: string }
): AsyncIterable<RawCodexMessage> {
  const fileId = rolloutFileId(filePath);
  let conversationId = "";
  let workspacePath: string | undefined;
  let current: RawCodexMessage[] = [];
  let turnId = "";
  let startedAt = "";
  let sequence = 0;
  let lineNumber = 0;
  let invalidReason = "";
  let toolCalls: SourceToolCall[] = [];
  let toolResults: SourceToolResult[] = [];
  const toolNames = new Map<string, string>();

  function finish(completedAt = "", completionId = "", status: "succeeded" | "failed" = "succeeded", completionKind = "task_complete"): RawCodexMessage[] {
    if (current.length === 0) return [];
    if (current.every(message => message.role === "system")) {
      current = []; invalidReason = "";
      return [];
    }
    const query = current.filter(message => message.role === "user").map(message => message.content).join("\n\n");
    const answer = current.filter(message => message.role === "assistant").map(message => message.content).join("\n\n");
    let reason = invalidReason;
    if (!conversationId || !turnId) reason ||= "identity_unresolved";
    else if (!completedAt || completionId !== turnId) reason ||= "turn_incomplete";
    else if (!startedAt || !Number.isFinite(Date.parse(startedAt)) || !Number.isFinite(Date.parse(completedAt))) reason ||= "timestamp_unresolved";
    else if (!query.trim() || !answer.trim()) reason ||= "turn_content_incomplete";
    const finalMessage = [...current].reverse().find(message => message.role !== "system");
    const hasFinalAnswer = finalMessage?.role === "assistant" && finalMessage.rawMeta.sourcePhase === "final_answer";
    const canonicalCompletedAt = hasFinalAnswer ? finalMessage.createdAt : completedAt;
    const completionEvidence = hasFinalAnswer
      ? `final_answer:${text(finalMessage.rawMeta.sourceRecordId) || turnId}`
      : `task_complete:${turnId}`;
    if (completedAt && completionKind === "task_complete") {
      current.push({ messageId: `${fileId}:${String(lineNumber).padStart(12, "0")}`, conversationId: conversationId || fileId,
        role: "system", content: "Codex task_complete", createdAt: completedAt, ordinal: lineNumber,
        rawMeta: { sourceFile: filePath, sourceTurnId: turnId || undefined, sourceTurnSequence: sequence, sourceTurnStartedAt: startedAt || undefined }
      });
    }
    const output = current.map(message => ({ ...message, rawMeta: { ...message.rawMeta, sourceTurnId: turnId || undefined, sourceTurnState: reason || "complete", sourceTurnReason: reason || undefined } }));
    if (!reason) {
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
      const paired = toolCalls.map(call => {
        const result = call.id && callCounts.get(call.id) === 1 && !duplicateIds.has(call.id) ? resultsById.get(call.id) : undefined;
        return result ? { ...call, ...result, name: call.name, input: call.input } : call;
      });
      const turn: SourceTurn = {
        source: "codex", conversationId, turnId, startedAt, completedAt: canonicalCompletedAt, sequence,
        completionEvidence, query: redactSecrets(query), answer: redactSecrets(answer), status,
        toolCalls: paired.map(redactCall), toolResults: toolResults.map(redactResult), workspacePath
      };
      const last = output[output.length - 1]!;
      last.rawMeta = { ...last.rawMeta, sourceTurn: turn } as typeof last.rawMeta;
    }
    current = []; toolCalls = []; toolResults = []; toolNames.clear(); invalidReason = "";
    return output;
  }

  for await (const record of readJsonlObjects(filePath, signal, reason => { invalidReason = reason; })) {
    lineNumber += 1;
    const payload = isRecord(record.payload) ? record.payload : {};
    const timestamp = iso(record.timestamp);
    if (record.type === "session_meta") {
      const nativeId = text(payload.session_id) || text(payload.id);
      if (conversationId && nativeId && nativeId !== conversationId) {
        invalidReason = "identity_conflict";
        yield* finish(); turnId = "";
      }
      conversationId = nativeId || conversationId;
      workspacePath = text(payload.cwd) || workspacePath;
      continue;
    }
    if (record.type === "turn_context" || (record.type === "event_msg" && payload.type === "task_started")) {
      const nextId = text(payload.turn_id);
      if (nextId && nextId !== turnId) {
        if (turnId || current.some(message => message.role === "assistant" || message.role === "tool")) yield* finish();
        turnId = nextId;
        startedAt = current.find(message => message.role === "user")?.createdAt || timestamp;
        sequence = lineNumber;
      }
      workspacePath = text(payload.cwd) || workspacePath;
      continue;
    }
    if (record.type === "event_msg" && payload.type === "task_complete") {
      const completeId = text(payload.turn_id);
      if (completeId !== turnId) invalidReason = "identity_conflict";
      yield* finish(timestamp, completeId, payload.status === "failed" ? "failed" : "succeeded");
      turnId = ""; startedAt = "";
      continue;
    }
    if (record.type === "event_msg" && (payload.type === "turn_aborted" || payload.type === "task_aborted")) {
      invalidReason = "turn_cancelled"; yield* finish(); turnId = ""; startedAt = ""; continue;
    }
    if (record.type !== "response_item") continue;
    if (text(payload.turn_id) && text(payload.turn_id) !== turnId) invalidReason = "identity_conflict";
    let role: RawCodexMessage["role"];
    let content: string;
    if (payload.type === "message") {
      const rawRole = payload.role;
      if (rawRole !== "user" && rawRole !== "assistant" && rawRole !== "developer" && rawRole !== "system") continue;
      role = rawRole === "developer" ? "system" : rawRole;
      content = Array.isArray(payload.content) ? payload.content.map(item => isRecord(item) ? text(item.text) : "").filter(Boolean).join("\n") : "";
    } else {
      role = "tool";
      const id = text(payload.call_id) || text(payload.id) || undefined;
      const status = text(payload.status) || undefined;
      const success = toolSuccess(payload);
      const error = payload.error;
      if (payload.type === "function_call" || payload.type === "custom_tool_call" || payload.type === "web_search_call") {
        const name = payload.type === "web_search_call" ? "web_search" : text(payload.name) || "tool";
        const input = payload.type === "web_search_call" ? payload.action : payload.arguments ?? payload.input;
        const call = compact({ id, name, status, success, error, input, output: payload.output ?? payload.result }) as unknown as SourceToolCall;
        toolCalls.push(call); if (id) toolNames.set(id, name);
        content = renderTool(call);
      } else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
        const result = compact({ id, output: payload.output ?? payload.result, status, success, error }) as SourceToolResult;
        toolResults.push(result); content = renderTool({ ...result, name: id ? toolNames.get(id) ?? "tool" : "tool" });
      } else continue;
    }
    if (!content) continue;
    if (!timestamp && role !== "system") invalidReason = "timestamp_unresolved";
    current.push({ messageId: `${fileId}:${String(lineNumber).padStart(12, "0")}`, conversationId: conversationId || fileId, role, content, createdAt: timestamp || new Date(0).toISOString(), ordinal: lineNumber,
      rawMeta: { sourceFile: filePath, sourceRecordId: text(payload.id) || undefined, sourcePhase: text(payload.phase) || undefined, sourceTurnId: turnId || undefined, sourceTurnSequence: sequence, sourceTurnStartedAt: startedAt || undefined } });
  }
  const lastResponse = [...current].reverse().find(message => message.role !== "system");
  const stopMatches = stopEvidence?.turnId === turnId &&
    (!stopEvidence.conversationId || stopEvidence.conversationId === conversationId);
  if (stopMatches && lastResponse?.role === "assistant" && lastResponse.rawMeta.sourcePhase === "final_answer") {
    yield* finish(lastResponse.createdAt, turnId, "succeeded", "stop");
  } else {
    yield* finish();
  }
}

/** Hook uses the exact same streaming parser as the scan adapter. */
export async function readCodexSourceTurn(filePath: string, expected: { conversationId?: string; turnId?: string; stop?: boolean } = {}): Promise<{ turn: SourceTurn | null; reason?: string }> {
  let latest: SourceTurn | null = null;
  let observed: SourceTurn | null = null;
  let conflict = false;
  let unresolved = false;
  let reason = "identity_unresolved";
  let latestTurnId: unknown;
  const stopEvidence = expected.stop && expected.turnId
    ? { conversationId: expected.conversationId, turnId: expected.turnId }
    : undefined;
  for await (const message of readCodexRollout(filePath, undefined, stopEvidence)) {
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

function canonicalTurnContent(turn: Record<string, unknown> | SourceTurn): string {
  const { sequence: _sequence, ...content } = turn;
  return JSON.stringify(content);
}

function redactCall(call: SourceToolCall): SourceToolCall { return { ...call, name: redactSecrets(call.name), ...redactResult(call), ...(call.input !== undefined ? { input: redactValue(call.input) } : {}) }; }
function redactResult(result: SourceToolResult): SourceToolResult { return { ...result, ...(result.output !== undefined ? { output: redactValue(result.output) } : {}), ...(result.error !== undefined ? { error: redactValue(result.error) } : {}) }; }
function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactValue(entry)]));
  return value;
}
function toolSuccess(payload: Record<string, unknown>): boolean | undefined {
  if (typeof payload.success === "boolean") return payload.success;
  if (typeof payload.is_error === "boolean") return !payload.is_error;
  if ((payload.error !== undefined && payload.error !== null) || payload.status === "failed" || payload.status === "cancelled") return false;
  if (payload.status === "completed" || payload.status === "succeeded") return true;
  return undefined;
}
function renderTool(tool: SourceToolCall): string { return [`Tool: ${tool.name}`, tool.id ? `Call ID: ${tool.id}` : undefined, tool.status ? `Status: ${tool.status}` : undefined, tool.input !== undefined ? `Input:\n${format(tool.input)}` : undefined, tool.output !== undefined ? `Output:\n${format(tool.output)}` : undefined].filter(Boolean).join("\n\n"); }
function format(value: unknown): string { return typeof value === "string" ? value.trim() : JSON.stringify(value, null, 2); }
function compact(value: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)); }
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function iso(value: unknown): string { const parsed = typeof value === "string" ? Date.parse(value) : NaN; return Number.isFinite(parsed) ? new Date(parsed).toISOString() : ""; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function rolloutFileId(path: string): string { const name = basename(path).replace(/\.jsonl$/u, ""); return name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu)?.[0] ?? name; }
