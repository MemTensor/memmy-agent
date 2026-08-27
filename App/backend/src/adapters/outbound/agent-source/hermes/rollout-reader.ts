/** Rollout reader module. */
import { basename } from "node:path";
import { readJsonlObjects, type JsonObject } from "../jsonl-lines.js";

/** Contract for raw hermes rollout message. */
export interface RawHermesRolloutMessage {
  messageId: string;
  conversationId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  createdAt: string;
}

/** Rollout reader module. */
export async function* readHermesRollout(filePath: string, signal?: AbortSignal): AsyncIterable<RawHermesRolloutMessage> {
  const fallbackConversationId = parseSessionId(filePath);
  let lineNumber = 0;

  for await (const record of readJsonlObjects(filePath, signal)) {
    lineNumber += 1;
    const message = toRawHermesMessage(record, fallbackConversationId, lineNumber);
    if (message) {
      yield message;
    }
  }
}

function toRawHermesMessage(record: JsonObject, fallbackConversationId: string, lineNumber: number): RawHermesRolloutMessage | null {
  const message = getMessageRecord(record);
  if (!message) {
    return null;
  }

  const role = message.role;
  if (role !== "user" && role !== "assistant" && role !== "tool" && role !== "system") {
    return null;
  }

  const content = getContentText(message.content);
  if (!content) {
    return null;
  }

  const conversationId =
    getString(message.conversationId) ?? getString(record.conversationId) ?? getString(message.sessionId) ?? getString(record.sessionId) ?? fallbackConversationId;

  return {
    messageId: getString(message.messageId) ?? getString(message.id) ?? `${conversationId}:${lineNumber}`,
    conversationId,
    role,
    content,
    createdAt: normalizeTimestamp(message.createdAt ?? message.timestamp ?? record.createdAt ?? record.timestamp)
  };
}

function getMessageRecord(record: JsonObject): Record<string, unknown> | null {
  if (record.type === "response_item" && isRecord(record.payload) && record.payload.type === "message") {
    return record.payload;
  }

  if (record.type === "message" || typeof record.role === "string") {
    return record;
  }

  if (isRecord(record.payload) && (record.payload.type === "message" || typeof record.payload.role === "string")) {
    return record.payload;
  }

  if (isRecord(record.message)) {
    return record.message;
  }

  return null;
}

function parseSessionId(filePath: string): string {
  return basename(filePath).replace(/\.jsonl$/, "");
}

function getContentText(content: unknown): string | null {
  if (typeof content === "string") {
    return content.length > 0 ? content : null;
  }

  if (isRecord(content)) {
    return getString(content.text) ?? getString(content.content);
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const text = content
    .filter(isRecord)
    .map((item) => getString(item.text) ?? getString(item.content))
    .filter((item): item is string => Boolean(item))
    .join("\n");

  return text.length > 0 ? text : null;
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
  }

  if (typeof value === "number") {
    return new Date(value > 10_000_000_000 ? value : value * 1000).toISOString();
  }

  return new Date(0).toISOString();
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
