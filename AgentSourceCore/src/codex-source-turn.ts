import { basename } from "node:path";
import { readJsonlObjects } from "./jsonl-lines.js";
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

export type RawCodexMessage = RawSourceMessage;

/**
 * Codex runs its own auxiliary prompts through dedicated models and records them
 * as ordinary user/assistant messages. Those turns are Codex talking to itself,
 * not a conversation the user had, so they are dropped before staging.
 * A new auxiliary model has to be added here; an unknown model is kept.
 */
const INTERNAL_CODEX_MODELS = new Set(["codex-auto-review"]);

/** The one content kind that carries what the person actually typed. */
const USER_CONTENT_ITEM_KIND = "user.text";

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
  let turnModel = "";
  let toolCalls: SourceToolCall[] = [];
  let toolResults: SourceToolResult[] = [];
  const toolNames = new Map<string, string>();

  function discard(): RawCodexMessage[] {
    current = []; toolCalls = []; toolResults = []; toolNames.clear(); invalidReason = "";
    return [];
  }

  function finish(completedAt = "", completionId = "", status: "succeeded" | "failed" = "succeeded", completionKind = "task_complete"): RawCodexMessage[] {
    if (current.length === 0) return [];
    if (INTERNAL_CODEX_MODELS.has(turnModel)) return discard();
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
    const turn: SourceTurn | undefined = reason ? undefined : {
      source: "codex", conversationId, turnId, startedAt, completedAt: canonicalCompletedAt, sequence,
      completionEvidence, query: redactSecrets(query), answer: redactSecrets(answer), status,
      toolCalls: pairSourceToolCalls(toolCalls, toolResults).map(redactCall), toolResults: toolResults.map(redactResult), workspacePath
    };
    const output = stageSourceTurnMessages(current, { turnId, reason, turn });
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
        turnModel = "";
        startedAt = current.find(message => message.role === "user")?.createdAt || timestamp;
        sequence = lineNumber;
      }
      turnModel = text(payload.model) || turnModel;
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
      // A user message also carries injected context - AGENTS.md, environment,
      // plugin lists - which Codex labels per content item. Only the person's own
      // text belongs in the turn; an unlabelled item is kept for older rollouts.
      const kinds = rawRole === "user" ? contentItemKinds(payload) : undefined;
      content = Array.isArray(payload.content)
        ? payload.content
            .map((item, index) => isRecord(item) && keepsUserContentItem(kinds, index) ? text(item.text) : "")
            .filter(Boolean)
            .join("\n")
        : "";
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
  const stopEvidence = expected.stop && expected.turnId
    ? { conversationId: expected.conversationId, turnId: expected.turnId }
    : undefined;
  return selectSourceTurn(readCodexRollout(filePath, undefined, stopEvidence), expected);
}

/** Codex labels every content item it packs into a message; absent on older rollouts. */
function contentItemKinds(payload: Record<string, unknown>): string[] | undefined {
  const meta = payload.internal_chat_message_metadata_passthrough;
  if (!isRecord(meta) || !Array.isArray(meta.content_item_kinds)) return undefined;
  return meta.content_item_kinds.map(kind => text(kind));
}

function keepsUserContentItem(kinds: string[] | undefined, index: number): boolean {
  if (!kinds) return true;
  const kind = kinds[index];
  return kind === undefined || kind === "" || kind === USER_CONTENT_ITEM_KIND;
}

function rolloutFileId(path: string): string { const name = basename(path).replace(/\.jsonl$/u, ""); return name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu)?.[0] ?? name; }
