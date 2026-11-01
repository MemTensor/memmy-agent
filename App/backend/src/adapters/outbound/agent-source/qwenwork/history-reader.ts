import { basename } from "node:path";
import { readJsonlObjects } from "../jsonl-lines.js";
import { createJsonlTitleTracker } from "../jsonl-session-title.js";

export interface RawQwenworkMessage {
  messageId: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  workspacePath: string | null;
  /** The title QwenWork generated for the conversation, once it has written one. */
  sessionTitle?: string;
}

export async function* readQwenworkHistory(
  filePath: string,
  signal?: AbortSignal
): AsyncIterable<RawQwenworkMessage> {
  const fallbackConversationId = basename(filePath, ".jsonl");
  let lineNumber = 0;
  const titles = createJsonlTitleTracker();
  for await (const record of readJsonlObjects(filePath, signal)) {
    lineNumber += 1;
    // A title row is not a turn; keep it for the messages that follow and move on.
    if (titles.observe(record)) {
      continue;
    }
    const message = extractQwenworkMessage(record, fallbackConversationId, lineNumber);
    if (message) {
      const sessionTitle = titles.current();
      yield sessionTitle ? { ...message, sessionTitle } : message;
    }
  }
}

export function extractQwenworkMessage(
  record: Record<string, unknown>,
  fallbackConversationId: string,
  lineNumber: number
): RawQwenworkMessage | null {
  if (record.isSidechain === true) {
    return null;
  }
  const nestedMessage = recordValue(record.message);
  const role = normalizeRole(nestedMessage?.role ?? record.type);
  if (!nestedMessage || !role) {
    return null;
  }
  const origin = recordValue(record.origin);
  if (role === "user" && origin && origin.kind !== "human") {
    return null;
  }
  const text = visibleText(nestedMessage.content);
  if (!text) {
    return null;
  }

  const conversationId = stringValue(record.sessionId) ?? fallbackConversationId;
  return {
    messageId: stringValue(record.uuid) ?? `${conversationId}:${lineNumber}`,
    conversationId,
    role,
    content: text,
    createdAt: normalizeTimestamp(record.timestamp ?? nestedMessage.timestamp),
    workspacePath: stringValue(record.cwd)
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

function normalizeRole(value: unknown): RawQwenworkMessage["role"] | null {
  if (value === "user") return "user";
  if (value === "assistant") return "assistant";
  if (value === "system") return "system";
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
    ? value as Record<string, unknown>
    : null;
}
