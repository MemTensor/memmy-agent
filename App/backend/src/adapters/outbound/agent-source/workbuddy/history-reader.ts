import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";

export interface RawWorkbuddyMessage {
  messageId: string;
  conversationId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  createdAt: string;
  workspacePath: string | null;
  eventType: string;
  toolName?: string;
}

export async function* readWorkbuddyHistory(
  filePath: string,
  signal?: AbortSignal
): AsyncIterable<RawWorkbuddyMessage> {
  const fallbackConversationId = basename(filePath, ".jsonl");
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  let lineNumber = 0;

  try {
    for await (const line of lines) {
      lineNumber += 1;
      throwIfAborted(signal, filePath);
      const record = parseRecord(line);
      if (!record) {
        continue;
      }

      const message = toRawWorkbuddyMessage(record, fallbackConversationId, lineNumber);
      if (message) {
        yield message;
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

export function extractWorkbuddyUserMessage(record: Record<string, unknown>, fallbackConversationId: string, lineNumber: number): RawWorkbuddyMessage | null {
  const message = toRawWorkbuddyMessage(record, fallbackConversationId, lineNumber);
  return message?.role === "user" ? message : null;
}

function toRawWorkbuddyMessage(
  record: Record<string, unknown>,
  fallbackConversationId: string,
  lineNumber: number
): RawWorkbuddyMessage | null {
  const eventType = stringValue(record.type) ?? "message";
  const nestedMessage = recordValue(record.message);
  const role = normalizeRole(record.role ?? nestedMessage?.role ?? (isRoleEvent(eventType) ? eventType : undefined));
  const conversationId = firstString(
    record.sessionId,
    record.conversationId,
    record.threadId,
    nestedMessage?.sessionId,
    nestedMessage?.conversationId
  ) ?? fallbackConversationId;
  const messageId = firstString(record.id, record.uuid, record.messageId, record.callId, nestedMessage?.id) ?? `${conversationId}:${lineNumber}`;
  const createdAt = normalizeTimestamp(record.timestamp ?? record.createdAt ?? record.updatedAt ?? nestedMessage?.timestamp);
  const workspacePath = firstString(record.cwd, record.workspacePath, nestedMessage?.cwd, nestedMessage?.workspacePath);

  if ((eventType === "message" || role) && role) {
    if (isInternalMessage(record)) {
      return null;
    }
    const content = extractMessageText(record, nestedMessage, role);
    if (!content) {
      return null;
    }
    const visibleContent = role === "user" ? stripWorkbuddySystemXmlTags(content) : content;
    if (!visibleContent) {
      return null;
    }
    return {
      messageId,
      conversationId,
      role,
      content: visibleContent,
      createdAt,
      workspacePath,
      eventType
    };
  }

  if (isToolCallEvent(eventType)) {
    const toolName = firstString(record.name, record.toolName, record.tool_name) ?? "tool";
    const callId = firstString(record.callId, record.call_id, record.id);
    const input = firstDefined(record.arguments, record.args, record.input);
    return {
      messageId,
      conversationId,
      role: "tool",
      content: renderToolEvent({ toolName, callId: callId ?? undefined, input }),
      createdAt,
      workspacePath,
      eventType,
      toolName
    };
  }

  if (isToolResultEvent(eventType)) {
    const toolName = firstString(record.name, record.toolName, record.tool_name) ?? "tool";
    const callId = firstString(record.callId, record.call_id);
    const output = firstDefined(record.output, record.result, record.content, record.message);
    const outputText = extractText(output) ?? formatStructuredValue(output);
    if (!outputText) {
      return null;
    }
    return {
      messageId,
      conversationId,
      role: "tool",
      content: renderToolEvent({
        toolName,
        callId: callId ?? undefined,
        output: outputText,
        status: stringValue(record.status) ?? undefined
      }),
      createdAt,
      workspacePath,
      eventType,
      toolName
    };
  }

  return null;
}

function extractMessageText(
  record: Record<string, unknown>,
  nestedMessage: Record<string, unknown> | null,
  role: RawWorkbuddyMessage["role"]
): string | null {
  const direct = extractText(record.content);
  if (direct) {
    return direct;
  }
  const nested = extractText(nestedMessage?.content);
  if (nested) {
    return nested;
  }
  if (typeof record.message === "string") {
    return extractText(record.message);
  }
  if (role === "tool") {
    return extractText(record.output ?? record.result);
  }
  return null;
}

function extractText(value: unknown, depth = 0): string | null {
  if (depth > 5 || value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && depth < 3) {
      try {
        const parsedText = extractText(JSON.parse(trimmed), depth + 1);
        if (parsedText) {
          return parsedText;
        }
      } catch {
        // Keep non-JSON strings as visible message text.
      }
    }
    return trimmed;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => extractText(item, depth + 1))
      .filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts.join("\n") : null;
  }
  if (!isRecord(value)) {
    return null;
  }

  for (const key of ["text", "content", "message", "output", "result", "value"] as const) {
    const text = extractText(value[key], depth + 1);
    if (text) {
      return text;
    }
  }
  return null;
}

function stripWorkbuddySystemXmlTags(value: string): string {
  let text = value
    .replace(/<additional_data>[\s\S]*?<\/additional_data>\s*/gu, "")
    .replace(/<system_reminder>[\s\S]*?<\/system_reminder>\s*/gu, "")
    .replace(/<working_memory_reminder>[\s\S]*?<\/working_memory_reminder>\s*/gu, "");
  const userQuery = text.match(/<user_query>([\s\S]*?)<\/user_query>/u)?.[1];
  if (userQuery) {
    text = userQuery;
  }
  return text.trim().replace(/\n{3,}/gu, "\n\n");
}

function isInternalMessage(record: Record<string, unknown>): boolean {
  const providerData = recordValue(record.providerData);
  return providerData?.skipRun === true ||
    providerData?.isCompactInternal === true ||
    providerData?.agent === "compact" ||
    typeof recordValue(providerData?.teammateMessage)?.from === "string";
}

function normalizeRole(value: unknown): RawWorkbuddyMessage["role"] | null {
  if (value === "user" || value === "human") return "user";
  if (value === "assistant" || value === "ai") return "assistant";
  if (value === "tool" || value === "function") return "tool";
  if (value === "system" || value === "developer") return "system";
  return null;
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    if (value.trim() && Number.isFinite(numeric)) {
      return normalizeTimestamp(numeric);
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
  }
  return new Date(0).toISOString();
}

function renderToolEvent(input: {
  toolName: string;
  callId?: string;
  status?: string;
  input?: unknown;
  output?: unknown;
}): string {
  return [
    `Tool: ${input.toolName}`,
    input.callId ? `Call ID: ${input.callId}` : undefined,
    input.status ? `Status: ${input.status}` : undefined,
    input.input !== undefined ? `Input:\n${formatStructuredValue(input.input)}` : undefined,
    input.output !== undefined ? `Output:\n${formatStructuredValue(input.output)}` : undefined
  ].filter((part): part is string => Boolean(part)).join("\n\n");
}

function formatStructuredValue(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseRecord(line: string): Record<string, unknown> | null {
  if (!line.trim()) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRoleEvent(value: string): boolean {
  return ["user", "human", "assistant", "ai", "tool", "function", "system", "developer"].includes(value);
}

function isToolCallEvent(value: string): boolean {
  return value === "function_call" || value === "function_call_input" || value === "tool_call" || value === "custom_tool_call";
}

function isToolResultEvent(value: string): boolean {
  return value === "function_call_result" || value === "function_call_output" || value === "tool_result" || value === "custom_tool_call_output";
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const text = stringValue(value);
    if (text) return text;
  }
  return null;
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function throwIfAborted(signal: AbortSignal | undefined, filePath: string): void {
  if (signal?.aborted) {
    throw new DOMException(`WorkBuddy history read aborted: ${filePath}`, "AbortError");
  }
}
