/** Pi session reader module. */
import { basename } from "node:path";
import { readJsonlObjects, type JsonObject } from "../jsonl-lines.js";

export interface RawPiMessage {
  messageId: string;
  conversationId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  createdAt: string;
}

interface PiEntry {
  id: string;
  parentId: string | null;
  record: JsonObject;
}

export async function* readPiSession(filePath: string, signal?: AbortSignal): AsyncIterable<RawPiMessage> {
  const entries: PiEntry[] = [];
  const handledEntryIds = new Set<string>();
  let sessionId = basename(filePath, ".jsonl");

  for await (const record of readJsonlObjects(filePath, signal)) {
    if (record.type === "session" && typeof record.id === "string") {
      sessionId = record.id;
    }
    if (typeof record.id === "string") {
      entries.push({
        id: record.id,
        parentId: typeof record.parentId === "string" ? record.parentId : null,
        record
      });
    }
    collectHandledEntryIds(record, handledEntryIds);
  }

  const activeEntryIds = collectActiveBranchIds(entries);
  for (const entry of entries) {
    if (!activeEntryIds.has(entry.id) || handledEntryIds.has(entry.id)) {
      continue;
    }
    const message = toRawPiMessage(entry.record, sessionId, entry.id);
    if (message) {
      yield message;
    }
  }
}

function collectHandledEntryIds(record: JsonObject, handledEntryIds: Set<string>): void {
  if (record.type !== "custom" || record.customType !== "memmy-memory-capture" || !isRecord(record.data)) {
    return;
  }
  if (!Array.isArray(record.data.entryIds)) {
    return;
  }
  for (const entryId of record.data.entryIds) {
    if (typeof entryId === "string") handledEntryIds.add(entryId);
  }
}

function collectActiveBranchIds(entries: readonly PiEntry[]): Set<string> {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const activeIds = new Set<string>();
  let current = entries.at(-1);
  while (current && !activeIds.has(current.id)) {
    activeIds.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return activeIds;
}

function toRawPiMessage(record: JsonObject, sessionId: string, entryId: string): RawPiMessage | null {
  if (record.type !== "message" || !isRecord(record.message)) {
    return null;
  }
  const message = record.message;
  const role = message.role;
  if (role !== "user" && role !== "assistant" && role !== "toolResult" && role !== "system") {
    return null;
  }
  const content = renderContent(message.content, role, message);
  if (!content) {
    return null;
  }
  return {
    messageId: `${sessionId}:${entryId}`,
    conversationId: sessionId,
    role: role === "toolResult" ? "tool" : role,
    content,
    createdAt: normalizeTimestamp(record.timestamp ?? message.timestamp)
  };
}

function renderContent(content: unknown, role: string, message: Record<string, unknown>): string | null {
  if (typeof content === "string") {
    return content.trim() || null;
  }
  if (!Array.isArray(content)) {
    return null;
  }

  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item) || item.type === "thinking") {
      continue;
    }
    if (item.type === "text" && typeof item.text === "string" && item.text.trim()) {
      parts.push(item.text.trim());
      continue;
    }
    if (item.type === "toolCall") {
      parts.push(renderToolCall(item));
      continue;
    }
    if (role === "toolResult") {
      const text = typeof item.text === "string" ? item.text : formatValue(item);
      if (text.trim()) {
        parts.push(text.trim());
      }
    }
  }
  const rendered = parts.filter(Boolean).join("\n\n");
  if (role !== "toolResult" || !rendered) {
    return rendered || null;
  }
  return [
    `Tool: ${normalizeString(message.toolName) || "tool"}`,
    normalizeString(message.toolCallId) ? `Call ID: ${normalizeString(message.toolCallId)}` : "",
    message.isError === true ? "Status: error" : "",
    `Output:\n${rendered}`
  ].filter(Boolean).join("\n\n");
}

function renderToolCall(item: Record<string, unknown>): string {
  return [
    `Tool: ${normalizeString(item.name) || "tool"}`,
    normalizeString(item.id) ? `Call ID: ${normalizeString(item.id)}` : "",
    item.arguments !== undefined ? `Input:\n${formatValue(item.arguments)}` : ""
  ].filter(Boolean).join("\n\n");
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
  }
  return new Date(0).toISOString();
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
