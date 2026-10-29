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
  type RawSourceMessage,
  type SourceToolCall,
  type SourceToolResult,
  type SourceTurn
} from "./source-turn.js";
import { redactSecrets } from "./secret-redactor.js";

export const CLAUDE_CODE_SOURCE_ID = "claude_code";

/**
 * Rows that are editor or session bookkeeping rather than conversation. `last-prompt` in
 * particular is only a snapshot of the latest input and appears while tools are still
 * running, so it must never be read as the end of a turn.
 */
const IGNORED_ROW_TYPES = new Set([
  "attachment", "file-history-snapshot", "mode", "permission-mode", "atis-latch", "last-prompt", "cost-state"
]);

interface ClaudeRow {
  type: string;
  uuid: string;
  timestamp: string;
  promptId: string;
  isHuman: boolean;
  userText: string;
  assistantText: string;
  toolCalls: SourceToolCall[];
  toolResults: SourceToolResult[];
  toolNames: Map<string, string>;
  turnDuration: boolean;
}

/**
 * Streams one Claude Code session file as staged native turns. A turn is one press of
 * enter: it starts at a human prompt and covers every assistant message and tool result
 * that follows, because Claude records tool results as `type: user` rows too.
 */
export async function* readClaudeCodeSession(
  filePath: string,
  signal?: AbortSignal,
  stopEvidence?: { conversationId?: string; promptId: string }
): AsyncIterable<RawSourceMessage> {
  let conversationId = "";
  let current: RawSourceMessage[] = [];
  let promptId = "";
  let startedAt = "";
  let sequence = 0;
  let lineNumber = 0;
  let invalidReason = "";
  let query = "";
  let answer = "";
  let completedAt = "";
  let evidence = "";
  let toolCalls: SourceToolCall[] = [];
  let toolResults: SourceToolResult[] = [];
  const toolNames = new Map<string, string>();

  function finish(stopPromptId = ""): RawSourceMessage[] {
    if (!promptId || current.length === 0) {
      current = []; toolCalls = []; toolResults = []; toolNames.clear();
      promptId = ""; query = ""; answer = ""; completedAt = ""; evidence = ""; invalidReason = "";
      return [];
    }
    const unpaired = toolCalls.some((call) => !call.id || !toolResults.some((result) => result.id === call.id));
    let reason = invalidReason;
    if (!conversationId) reason ||= "identity_unresolved";
    else if (!query.trim() || !answer.trim()) reason ||= "turn_content_incomplete";
    else if (unpaired) reason ||= "turn_incomplete";
    else if (!evidence && stopPromptId !== promptId) reason ||= "turn_incomplete";
    else if (!Number.isFinite(Date.parse(startedAt)) || !Number.isFinite(Date.parse(completedAt))) reason ||= "timestamp_unresolved";
    const turn: SourceTurn | undefined = reason ? undefined : {
      source: CLAUDE_CODE_SOURCE_ID, conversationId, turnId: promptId, startedAt, completedAt, sequence,
      completionEvidence: evidence || `stop:${promptId}`,
      query: redactSecrets(query), answer: redactSecrets(answer), status: "succeeded",
      toolCalls: pairSourceToolCalls(toolCalls, toolResults).map(redactCall), toolResults: toolResults.map(redactResult)
    };
    const staged = stageSourceTurnMessages(current, { turnId: promptId, sequence, startedAt, reason, turn });
    current = []; toolCalls = []; toolResults = []; toolNames.clear();
    promptId = ""; query = ""; answer = ""; completedAt = ""; evidence = ""; invalidReason = "";
    return staged;
  }

  for await (const record of readJsonlObjects(filePath, signal, (reason) => { invalidReason = reason; })) {
    lineNumber += 1;
    const row = toClaudeRow(record, toolNames);
    conversationId = text(record.sessionId) || conversationId;
    if (!row || IGNORED_ROW_TYPES.has(row.type)) continue;
    // A sidechain row belongs to a subagent branch and never joins the main session.
    if (record.isSidechain === true) continue;
    // Claude closes each turn with a turn_duration row. It carries no promptId, so it is
    // attributed to the turn currently open.
    if (row.type === "system") {
      if (row.turnDuration && promptId) {
        completedAt = row.timestamp || completedAt;
        evidence = `turn_duration:${row.uuid}`;
      }
      continue;
    }
    if (row.isHuman) {
      yield* finish();
      promptId = row.promptId || row.uuid;
      startedAt = row.timestamp;
      sequence = lineNumber;
      query = row.userText;
    }
    if (!promptId) continue;
    if (row.assistantText) {
      answer = answer ? `${answer}\n\n${row.assistantText}` : row.assistantText;
      completedAt = row.timestamp || completedAt;
    }
    toolCalls.push(...row.toolCalls);
    toolResults.push(...row.toolResults);
    for (const message of toStagedMessages(row, conversationId, lineNumber)) current.push(message);
  }
  yield* finish(stopEvidence && (!stopEvidence.conversationId || stopEvidence.conversationId === conversationId)
    ? stopEvidence.promptId
    : "");
}

/** Hook path: reads the same file the scan reads, for the one prompt that just finished. */
export async function readClaudeCodeSourceTurn(
  filePath: string,
  expected: { conversationId?: string; promptId?: string; stop?: boolean } = {}
): Promise<{ turn: SourceTurn | null; reason?: string }> {
  const stopEvidence = expected.stop && expected.promptId
    ? { conversationId: expected.conversationId, promptId: expected.promptId }
    : undefined;
  return selectSourceTurn(readClaudeCodeSession(filePath, undefined, stopEvidence), {
    conversationId: expected.conversationId,
    turnId: expected.promptId
  });
}

function toClaudeRow(record: Record<string, unknown>, toolNames: Map<string, string>): ClaudeRow | undefined {
  const type = text(record.type);
  if (!type) return undefined;
  const message = isRecord(record.message) ? record.message : undefined;
  const blocks = Array.isArray(message?.content) ? message.content.filter(isRecord) : [];
  const plainText = typeof message?.content === "string" ? message.content : "";
  const origin = isRecord(record.origin) ? record.origin : undefined;
  const toolCalls: SourceToolCall[] = [];
  const toolResults: SourceToolResult[] = [];
  let assistantText = "";
  let userText = plainText;

  for (const block of blocks) {
    const kind = text(block.type);
    if (kind === "text" && type === "assistant") {
      assistantText = assistantText ? `${assistantText}\n${text(block.text)}` : text(block.text);
    } else if (kind === "text" && type === "user") {
      userText = userText ? `${userText}\n${text(block.text)}` : text(block.text);
    } else if (kind === "tool_use") {
      const id = text(block.id) || undefined;
      const name = text(block.name) || "tool";
      if (id) toolNames.set(id, name);
      toolCalls.push(compact({ id, name, input: block.input }) as unknown as SourceToolCall);
    } else if (kind === "tool_result") {
      const id = text(block.tool_use_id) || undefined;
      const failed = block.is_error === true;
      toolResults.push(compact({
        id, output: block.content, success: failed ? false : true, status: failed ? "failed" : "completed"
      }) as SourceToolResult);
    }
  }

  return {
    type,
    uuid: text(record.uuid),
    timestamp: iso(record.timestamp),
    promptId: text(record.promptId),
    // A tool result is also a `type: user` row, but it carries no origin and must not open a turn.
    isHuman: type === "user" && text(origin?.kind) === "human" && Boolean(userText.trim()),
    userText,
    assistantText,
    toolCalls,
    toolResults,
    toolNames,
    turnDuration: type === "system" && text(record.subtype) === "turn_duration"
  };
}

function toStagedMessages(row: ClaudeRow, conversationId: string, lineNumber: number): RawSourceMessage[] {
  const base = {
    messageId: row.uuid || `${conversationId}:${lineNumber}`,
    conversationId,
    createdAt: row.timestamp,
    ordinal: lineNumber
  };
  const messages: RawSourceMessage[] = [];
  if (row.isHuman) {
    messages.push({ ...base, role: "user", content: row.userText, rawMeta: { claudePromptId: row.promptId || undefined } });
  }
  if (row.assistantText) {
    messages.push({ ...base, messageId: `${base.messageId}:text`, role: "assistant", content: row.assistantText, rawMeta: {} });
  }
  for (const [index, call] of row.toolCalls.entries()) {
    messages.push({
      ...base, messageId: `${base.messageId}:call:${index}`, role: "tool", content: renderTool(call),
      rawMeta: { toolName: call.name, toolCallId: call.id }
    });
  }
  for (const [index, result] of row.toolResults.entries()) {
    const name = (result.id && row.toolNames.get(result.id)) || "tool";
    messages.push({
      ...base, messageId: `${base.messageId}:result:${index}`, role: "tool",
      content: renderTool({ ...result, name }), rawMeta: { toolName: name, toolCallId: result.id }
    });
  }
  return messages;
}
