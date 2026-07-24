import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ManagedAgentSourceMessage,
  ManagedAgentSyncRecipe
} from "@memmy/local-api-contracts";

const MAX_HISTORY_FILES = 10_000;
const MAX_HISTORY_RECORDS = 200_000;
const MAX_HISTORY_BYTES = 500 * 1024 * 1024;

interface SourceRecord {
  value: Record<string, unknown>;
  coordinate: string;
  conversationFallback: string;
}

/**
 * Applies a persisted, declarative extraction recipe to an Agent's local history.
 */
export function extractManagedAgentHistory(
  recipe: ManagedAgentSyncRecipe
): ManagedAgentSourceMessage[] {
  const records = recipe.format === "sqlite"
    ? readSqliteRecords(recipe)
    : readFileRecords(recipe);
  if (records.length > MAX_HISTORY_RECORDS) {
    throw new Error(`Managed Agent history exceeds ${MAX_HISTORY_RECORDS} records`);
  }

  const messages: ManagedAgentSourceMessage[] = [];
  for (const record of records) {
    const roleValue = readPath(record.value, recipe.fields.role);
    const role = normalizeRole(roleValue, recipe.roleMap);
    if (!role) {
      continue;
    }
    const content = normalizeContent(readPath(record.value, recipe.fields.content));
    if (!content) {
      continue;
    }
    const createdAt = normalizeTimestamp(
      readPath(record.value, recipe.fields.createdAt),
      recipe.timestampFormat
    );
    if (!createdAt) {
      throw new Error(`Managed Agent record ${record.coordinate} has an invalid timestamp`);
    }

    const conversationValue = recipe.fields.conversationId
      ? scalarString(readPath(record.value, recipe.fields.conversationId))
      : null;
    const messageValue = recipe.fields.messageId
      ? scalarString(readPath(record.value, recipe.fields.messageId))
      : null;
    const conversationId = conversationValue || stableId("conversation", record.conversationFallback);
    const messageId = messageValue || stableId(
      "message",
      `${record.conversationFallback}:${record.coordinate}`
    );
    const workspacePath = optionalField(record.value, recipe.fields.workspacePath);
    const gitRoot = optionalField(record.value, recipe.fields.gitRoot);

    messages.push({
      messageId,
      conversationId,
      role,
      content,
      createdAt,
      ...(workspacePath ? { workspacePath } : {}),
      ...(gitRoot ? { gitRoot } : {}),
      rawMeta: {
        recipeFormat: recipe.format,
        sourceCoordinate: record.coordinate
      }
    });
  }
  return sortMessages(messages);
}

/**
 * Selects complete user/assistant turns strictly after the permanent initial boundary.
 */
export function selectIncrementalManagedMessages(
  messages: readonly ManagedAgentSourceMessage[],
  syncBoundaryAt: string
): ManagedAgentSourceMessage[] {
  const boundary = Date.parse(syncBoundaryAt);
  if (!Number.isFinite(boundary)) {
    throw new Error("Managed Agent sync boundary is invalid");
  }

  const byConversation = new Map<string, ManagedAgentSourceMessage[]>();
  for (const message of messages) {
    const conversation = byConversation.get(message.conversationId) ?? [];
    conversation.push(message);
    byConversation.set(message.conversationId, conversation);
  }

  const selected: ManagedAgentSourceMessage[] = [];
  for (const conversation of byConversation.values()) {
    let turn: ManagedAgentSourceMessage[] = [];
    for (const message of sortMessages(conversation)) {
      if (message.role === "user") {
        appendCompleteTurn(turn, boundary, selected);
        turn = [message];
      } else if (turn.length > 0) {
        turn.push(message);
      }
    }
    appendCompleteTurn(turn, boundary, selected);
  }
  return sortMessages(selected);
}

function readFileRecords(
  recipe: Extract<ManagedAgentSyncRecipe, { format: "json" | "jsonl" }>
): SourceRecord[] {
  const files = listHistoryFiles(recipe.path, recipe.fileSuffix);
  let totalBytes = 0;
  const records: SourceRecord[] = [];
  for (const filePath of files) {
    const stat = fs.statSync(filePath);
    totalBytes += stat.size;
    if (totalBytes > MAX_HISTORY_BYTES) {
      throw new Error("Managed Agent history exceeds 500 MB");
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const relativePath = path.relative(recipe.path, filePath) || path.basename(filePath);
    const values = recipe.format === "jsonl"
      ? raw.split(/\r?\n/u).filter((line) => line.trim()).map((line, index) =>
        parseObject(JSON.parse(line) as unknown, `${relativePath}:${index + 1}`)
      )
      : readJsonValues(raw, recipe.recordsPath, relativePath);
    values.forEach((value, index) => {
      records.push({
        value,
        coordinate: `${relativePath}:${index + 1}`,
        conversationFallback: relativePath
      });
    });
  }
  return records;
}

function readJsonValues(
  raw: string,
  recordsPath: string | undefined,
  coordinate: string
): Record<string, unknown>[] {
  const parsed = JSON.parse(raw) as unknown;
  const selected = recordsPath
    ? readPath(parseObject(parsed, coordinate), recordsPath)
    : parsed;
  const values = Array.isArray(selected) ? selected : [selected];
  return values.map((value, index) => parseObject(value, `${coordinate}:${index + 1}`));
}

function readSqliteRecords(
  recipe: Extract<ManagedAgentSyncRecipe, { format: "sqlite" }>
): SourceRecord[] {
  if (!path.isAbsolute(recipe.path)) {
    throw new Error("Managed Agent recipe path must be absolute");
  }
  if (!recipe.fields.messageId || !recipe.fields.conversationId) {
    throw new Error("SQLite sync recipes require stable messageId and conversationId fields");
  }
  const query = recipe.query.trim();
  if (!/^select\b/iu.test(query) || query.includes(";")) {
    throw new Error("Managed Agent SQLite recipe must contain one read-only SELECT statement");
  }

  const db = new DatabaseSync(recipe.path, { readOnly: true });
  try {
    const rows = db.prepare(query).all() as unknown[];
    return rows.map((row, index) => ({
      value: parseObject(row, `row:${index + 1}`),
      coordinate: `row:${index + 1}`,
      conversationFallback: recipe.path
    }));
  } finally {
    db.close();
  }
}

function listHistoryFiles(inputPath: string, fileSuffix: string | undefined): string[] {
  if (!path.isAbsolute(inputPath)) {
    throw new Error("Managed Agent recipe path must be absolute");
  }
  const stat = fs.statSync(inputPath);
  if (stat.isFile()) {
    return [inputPath];
  }
  if (!stat.isDirectory()) {
    throw new Error(`Managed Agent recipe path is not a file or directory: ${inputPath}`);
  }
  if (!fileSuffix) {
    throw new Error("Directory-based managed Agent recipes require fileSuffix");
  }

  const files: string[] = [];
  const directories = [inputPath];
  while (directories.length > 0) {
    const directory = directories.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(fileSuffix)) {
        files.push(entryPath);
        if (files.length > MAX_HISTORY_FILES) {
          throw new Error(`Managed Agent history exceeds ${MAX_HISTORY_FILES} files`);
        }
      }
    }
  }
  return files.sort();
}

function parseObject(value: unknown, coordinate: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Managed Agent record ${coordinate} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readPath(value: Record<string, unknown>, fieldPath: string): unknown {
  let current: unknown = value;
  for (const segment of fieldPath.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function normalizeRole(
  value: unknown,
  roleMap: ManagedAgentSyncRecipe["roleMap"]
): ManagedAgentSourceMessage["role"] | null {
  const raw = scalarString(value);
  if (!raw) {
    return null;
  }
  const mapped = roleMap?.[raw] ?? raw.toLocaleLowerCase();
  return mapped === "user" || mapped === "assistant" || mapped === "tool" || mapped === "system"
    ? mapped
    : null;
}

function normalizeContent(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() || null;
  }
  if (Array.isArray(value)) {
    const text = value.map(normalizeContent).filter((part): part is string => Boolean(part)).join("\n");
    return text || null;
  }
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return normalizeContent(item.text ?? item.content);
  }
  return null;
}

function normalizeTimestamp(
  value: unknown,
  format: ManagedAgentSyncRecipe["timestampFormat"]
): string | null {
  if (format === "unix_seconds" || format === "unix_milliseconds") {
    const number = numericValue(value);
    if (number === null) return null;
    const millis = format === "unix_seconds" ? number * 1_000 : number;
    return finiteIso(millis);
  }
  if (format === "iso") {
    return typeof value === "string" ? finiteIso(Date.parse(value)) : null;
  }
  if (typeof value === "number") {
    return finiteIso(value < 10_000_000_000 ? value * 1_000 : value);
  }
  if (typeof value === "string") {
    const numeric = numericValue(value);
    if (numeric !== null && /^\d+(?:\.\d+)?$/u.test(value.trim())) {
      return finiteIso(numeric < 10_000_000_000 ? numeric * 1_000 : numeric);
    }
    return finiteIso(Date.parse(value));
  }
  return null;
}

function numericValue(value: unknown): number | null {
  const number = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function finiteIso(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function scalarString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return null;
}

function optionalField(record: Record<string, unknown>, fieldPath: string | undefined): string | null {
  return fieldPath ? scalarString(readPath(record, fieldPath)) : null;
}

function stableId(namespace: string, input: string): string {
  return `${namespace}-${createHash("sha256").update(input).digest("hex")}`;
}

function appendCompleteTurn(
  messages: readonly ManagedAgentSourceMessage[],
  boundary: number,
  output: ManagedAgentSourceMessage[]
): void {
  const user = messages.find((message) => message.role === "user");
  if (!user || Date.parse(user.createdAt) <= boundary) return;
  if (!messages.some((message) => message.role === "assistant")) return;
  output.push(...messages);
}

function sortMessages(
  messages: readonly ManagedAgentSourceMessage[]
): ManagedAgentSourceMessage[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((left, right) =>
      left.message.conversationId.localeCompare(right.message.conversationId) ||
      Date.parse(left.message.createdAt) - Date.parse(right.message.createdAt) ||
      left.index - right.index
    )
    .map((entry) => entry.message);
}
