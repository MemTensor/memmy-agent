/** Transcript reader module. */
import { readJsonlObjects, type JsonObject } from "../jsonl-lines.js";

/** Contract for raw claude code message. */
export interface RawClaudeCodeMessage {
  messageId: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  workspacePath: string | null;
  gitRoot: string | null;
}

/** Transcript reader module. */
export async function* readClaudeCodeTranscript(
  filePath: string,
  signal?: AbortSignal
): AsyncIterable<RawClaudeCodeMessage> {
  let fallbackIndex = 0;

  for await (const record of readJsonlObjects(filePath, signal)) {
    fallbackIndex += 1;
    const message = toRawClaudeCodeMessage(record, fallbackIndex);
    if (message) {
      yield message;
    }
  }
}

/** Handles to raw claude code message. */
function toRawClaudeCodeMessage(record: JsonObject, fallbackIndex: number): RawClaudeCodeMessage | null {
  const type = getString(record.type);
  if (type !== "user" && type !== "assistant") {
    return null;
  }

  const message = isRecord(record.message) ? record.message : null;
  const content = getContentText(message?.content);
  if (!message || !content) {
    return null;
  }

  const sessionId = getString(record.sessionId) ?? "unknown-session";
  const cwd = getString(record.cwd);

  return {
    messageId: getString(record.uuid) ?? `${sessionId}:${fallbackIndex}`,
    conversationId: sessionId,
    role: type,
    content,
    createdAt: normalizeTimestamp(record.timestamp),
    workspacePath: cwd,
    gitRoot: cwd
  };
}

/**
 * Extracts the text from Claude Code content.
 *
 * @param content Raw message.content value.
 * @returns The merged text, or null when it cannot be parsed.
 */
function getContentText(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const text = content
    .filter(isRecord)
    .map((item) => (item.type === "text" ? getString(item.text) : null))
    .filter((item): item is string => Boolean(item))
    .join("\n");
  return text.length > 0 ? text : null;
}

/**
 * Normalizes a timestamp.
 *
 * @param value Unknown timestamp.
 * @returns An ISO 8601 time.
 */
function normalizeTimestamp(value: unknown): string {
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
  }

  return new Date(0).toISOString();
}

/**
 * Plain-object type guard.
 *
 * @param value Unknown value.
 * @returns Whether it is an indexable record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * String type guard.
 *
 * @param value Unknown value.
 * @returns The string, or null.
 */
function getString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
