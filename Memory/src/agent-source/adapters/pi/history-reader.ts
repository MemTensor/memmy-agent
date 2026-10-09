import { basename } from "node:path";
import { readJsonlObjects, type JsonObject } from "../jsonl-lines.js";

export interface RawPiMessage {
  messageId: string;
  conversationId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt: string;
  workspacePath: string | null;
}

export async function* readPiHistory(filePath: string, signal?: AbortSignal): AsyncIterable<RawPiMessage> {
  let conversationId = basename(filePath, ".jsonl");
  let workspacePath: string | null = null;
  let lineNumber = 0;

  for await (const record of readJsonlObjects(filePath, signal)) {
    lineNumber += 1;
    if (record.type === "session") {
      conversationId = stringValue(record.id) ?? conversationId;
      workspacePath = stringValue(record.cwd);
      continue;
    }

    const message = extractPiMessage(record, conversationId, lineNumber, workspacePath);
    if (message) {
      yield message;
    }
  }
}

export function extractPiMessage(
  record: Record<string, unknown>,
  fallbackConversationId: string,
  lineNumber: number,
  fallbackWorkspacePath: string | null = null
): RawPiMessage | null {
  if (record.type !== "message") {
    return null;
  }
  const message = recordValue(record.message);
  const role = normalizeRole(message?.role);
  if (!message || !role) {
    return null;
  }
  const text = visibleText(message.content);
  if (!text) {
    return null;
  }

  const conversationId = stringValue(record.sessionId) ?? fallbackConversationId;
  const messageId = stringValue(record.id) ?? `${conversationId}:${lineNumber}`;
  const content = role === "tool"
    ? [`Tool: ${stringValue(message.toolName) ?? "tool"}`, text].join("\n\n")
    : text;
  return {
    messageId,
    conversationId,
    role,
    content,
    createdAt: normalizeTimestamp(record.timestamp ?? message.timestamp),
    workspacePath: stringValue(record.cwd) ?? fallbackWorkspacePath
  };
}

function visibleText(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() || null;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parts = value.flatMap((item) => {
    const block = recordValue(item);
    return block?.type === "text" && typeof block.text === "string" && block.text.trim()
      ? [block.text.trim()]
      : [];
  });
  return parts.length > 0 ? parts.join("\n") : null;
}

function normalizeRole(value: unknown): RawPiMessage["role"] | null {
  if (value === "user") return "user";
  if (value === "assistant") return "assistant";
  if (value === "toolResult") return "tool";
  return null;
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value > 10_000_000_000 ? value : value * 1000);
    return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
  }
  return new Date(0).toISOString();
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}
