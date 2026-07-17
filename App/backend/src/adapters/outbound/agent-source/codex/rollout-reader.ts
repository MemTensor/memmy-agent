/** Rollout reader module. */
import { basename } from "node:path";
import { readJsonlObjects, type JsonObject } from "../jsonl-lines.js";

export interface RawCodexMessage {
  /** Message id. */
  messageId: string;
  conversationId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  createdAt: string;
}

/** Rollout reader module. */
export async function* readCodexRollout(filePath: string, signal?: AbortSignal): AsyncIterable<RawCodexMessage> {
  const rolloutId = parseRolloutId(filePath);
  const toolNamesByCallId = new Map<string, string>();
  let lineNumber = 0;

  for await (const record of readJsonlObjects(filePath, signal)) {
    lineNumber += 1;
    const message = toRawCodexMessage(record, rolloutId, lineNumber, toolNamesByCallId);
    if (message) {
      yield message;
    }
  }
}

/** Handles to raw codex message. */
function toRawCodexMessage(
  record: JsonObject,
  rolloutId: string,
  lineNumber: number,
  toolNamesByCallId: Map<string, string>
): RawCodexMessage | null {
  if (record.type !== "response_item" || !isRecord(record.payload)) {
    return null;
  }

  if (record.payload.type !== "message") {
    return toToolMessage(record.payload, rolloutId, lineNumber, normalizeTimestamp(record.timestamp), toolNamesByCallId);
  }

  const role = record.payload.role;
  if (role !== "user" && role !== "assistant" && role !== "developer" && role !== "system") {
    return null;
  }

  const content = getContentText(record.payload.content);
  if (!content) {
    return null;
  }

  return {
    messageId: `${rolloutId}:${lineNumber}`,
    conversationId: rolloutId,
    role: role === "developer" ? "system" : role,
    content,
    createdAt: normalizeTimestamp(record.timestamp)
  };
}

function toToolMessage(
  payload: Record<string, unknown>,
  rolloutId: string,
  lineNumber: number,
  createdAt: string,
  toolNamesByCallId: Map<string, string>
): RawCodexMessage | null {
  const type = payload.type;
  if (type === "function_call" || type === "custom_tool_call") {
    const callId = getString(payload.call_id) ?? getString(payload.id);
    const name = getString(payload.name) ?? "tool";
    if (callId) {
      toolNamesByCallId.set(callId, name);
    }
    return {
      messageId: `${rolloutId}:${lineNumber}`,
      conversationId: rolloutId,
      role: "tool",
      content: renderToolMessage({
        name,
        callId,
        status: getString(payload.status),
        input: firstDefined(payload.arguments, payload.input)
      }),
      createdAt
    };
  }

  if (type === "function_call_output" || type === "custom_tool_call_output") {
    const callId = getString(payload.call_id) ?? getString(payload.id);
    return {
      messageId: `${rolloutId}:${lineNumber}`,
      conversationId: rolloutId,
      role: "tool",
      content: renderToolMessage({
        name: callId ? toolNamesByCallId.get(callId) ?? "tool" : "tool",
        callId,
        status: getString(payload.status),
        output: firstDefined(payload.output, payload.result)
      }),
      createdAt
    };
  }

  if (type === "web_search_call") {
    return {
      messageId: `${rolloutId}:${lineNumber}`,
      conversationId: rolloutId,
      role: "tool",
      content: renderToolMessage({
        name: "web_search",
        callId: getString(payload.call_id) ?? getString(payload.id),
        status: getString(payload.status),
        input: payload.action
      }),
      createdAt
    };
  }

  return null;
}

/**
 * Parses the rollout uuid from the file name.
 *
 * @param filePath Rollout path.
 * @returns The uuid, falling back to the file name.
 */
function parseRolloutId(filePath: string): string {
  const name = basename(filePath).replace(/\.jsonl$/, "");
  const uuid = name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)?.[0];
  return uuid ?? name;
}

/**
 * Extracts the text from Codex content.
 *
 * @param content Raw payload.content value.
 * @returns The merged text, or null.
 */
function getContentText(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }

  const text = content
    .filter(isRecord)
    .map((item) => (typeof item.text === "string" ? item.text : null))
    .filter((item): item is string => Boolean(item))
    .join("\n");
  return text.length > 0 ? text : null;
}

function renderToolMessage(input: {
  name: string;
  callId?: string;
  status?: string;
  input?: unknown;
  output?: unknown;
}): string {
  return [
    `Tool: ${input.name}`,
    input.callId ? `Call ID: ${input.callId}` : undefined,
    input.status ? `Status: ${input.status}` : undefined,
    input.input !== undefined ? `Input:\n${formatToolPayload(input.input)}` : undefined,
    input.output !== undefined ? `Output:\n${formatToolPayload(input.output)}` : undefined
  ].filter(Boolean).join("\n\n");
}

function formatToolPayload(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
  }

  return new Date(0).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
