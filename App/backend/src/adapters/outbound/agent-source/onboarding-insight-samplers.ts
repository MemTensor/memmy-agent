import { existsSync } from "node:fs";
import { access, open, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stripInlineMediaPayloads } from "../../../shared/inline-media-sanitizer.js";
import {
  resolveClaudeCodeProjectsDirectory,
  resolveCodexSessionsDirectory,
  resolveCursorDataPaths,
  resolveHermesHomeDirectory,
  resolveOpencodeDatabasePath,
  resolveOpenclawStateDirectory,
  resolveWorkbuddyProjectsDirectory
} from "../agent-paths.js";
import { extractWorkbuddyUserMessage } from "./workbuddy/history-reader.js";
import { redactSecrets } from "./secret-redactor.js";
import {
  emptyOnboardingSampleResult,
  type OnboardingInsightSampleOptions,
  type OnboardingInsightSampler,
  type OnboardingSampleResult,
  type OnboardingSampledQuery
} from "./insight-sampler-types.js";

const JSONL_CHUNK_SIZE = 64 * 1024;
const DEFAULT_MAX_SQL_ROWS = 200;

interface RecentFile {
  filePath: string;
  mtimeMs: number;
}

type JsonRecord = Record<string, unknown>;
type JsonQueryExtractor = (record: JsonRecord, fallback: {
  sourceId: string;
  filePath: string;
  lineIndex: number;
}) => OnboardingSampledQuery | null;
type JsonLineFilter = (line: string) => boolean;

export function createBuiltinOnboardingInsightSamplers(): OnboardingInsightSampler[] {
  return [
    createCursorInsightSampler(),
    createClaudeCodeInsightSampler({ root: resolveClaudeCodeProjectsDirectory() }),
    createCodexInsightSampler({ root: resolveCodexSessionsDirectory() }),
    createOpencodeInsightSampler({ databasePath: resolveOpencodeDatabasePath() }),
    createOpenclawInsightSampler({ root: resolveOpenclawStateDirectory() }),
    createHermesInsightSampler({ root: resolveHermesHomeDirectory() }),
    createWorkbuddyInsightSampler({ root: resolveWorkbuddyProjectsDirectory() })
  ];
}

export function createWorkbuddyInsightSampler(input: { root: string }): OnboardingInsightSampler {
  return createJsonlInsightSampler({
    sourceId: "workbuddy",
    displayName: "WorkBuddy",
    root: input.root,
    matchesFile: (name) => name.endsWith(".jsonl"),
    shouldParseLine: isPotentialWorkbuddyUserMessageLine,
    extractQuery: extractWorkbuddyQuery
  });
}

export function createCodexInsightSampler(input: { root: string }): OnboardingInsightSampler {
  return createJsonlInsightSampler({
    sourceId: "codex",
    displayName: "Codex",
    root: input.root,
    matchesFile: (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"),
    shouldParseLine: isPotentialCodexUserMessageLine,
    extractQuery: extractCodexQuery
  });
}

export function createClaudeCodeInsightSampler(input: { root: string }): OnboardingInsightSampler {
  return createJsonlInsightSampler({
    sourceId: "claude_code",
    displayName: "Claude Code",
    root: input.root,
    matchesFile: (name) => name.endsWith(".jsonl"),
    extractQuery: extractClaudeCodeQuery
  });
}

export function createHermesInsightSampler(input: { root: string }): OnboardingInsightSampler {
  const stateDbPath = join(input.root, "state.db");
  const jsonl = createJsonlInsightSampler({
    sourceId: "hermes",
    displayName: "Hermes",
    root: join(input.root, "sessions"),
    matchesFile: (name) => name.endsWith(".jsonl"),
    extractQuery: extractGenericJsonlQuery
  });

  return {
    sourceId: "hermes",
    displayName: "Hermes",
    async detect() {
      return (await pathExists(input.root)) || (await pathExists(stateDbPath));
    },
    async sampleRecentUserQueries(options) {
      const [dbResult, jsonlResult] = await Promise.all([
        sampleHermesStateDb(stateDbPath, options),
        jsonl.sampleRecentUserQueries(options)
      ]);
      return mergeSampleResults("hermes", "Hermes", [dbResult, jsonlResult], options.maxQueries);
    }
  };
}

export function createOpencodeInsightSampler(input: { databasePath: string }): OnboardingInsightSampler {
  return {
    sourceId: "opencode",
    displayName: "Opencode",
    async detect() {
      return pathExists(input.databasePath);
    },
    async sampleRecentUserQueries(options) {
      return sampleOpencodeDb(input.databasePath, options);
    }
  };
}

export function createOpenclawInsightSampler(input: { root: string }): OnboardingInsightSampler {
  return {
    sourceId: "openclaw",
    displayName: "OpenClaw",
    async detect() {
      return pathExists(input.root);
    },
    async sampleRecentUserQueries(options) {
      const dbPaths = await listRecentFiles(input.root, (name) => name.endsWith(".sqlite") || name.endsWith(".db"), options.maxSessionFiles, options);
      const results = await Promise.all(dbPaths.map((file) => sampleOpenclawDb(file.filePath, options)));
      return mergeSampleResults("openclaw", "OpenClaw", results, options.maxQueries);
    }
  };
}

export function createCursorInsightSampler(): OnboardingInsightSampler {
  const {
    workspaceStorageDirectory: storageRoot,
    globalStateDbPath
  } = resolveCursorDataPaths();

  return {
    sourceId: "cursor",
    displayName: "Cursor",
    async detect() {
      return (await pathExists(storageRoot)) || (await pathExists(globalStateDbPath));
    },
    async sampleRecentUserQueries(options) {
      const dbFiles = await listRecentFiles(storageRoot, (name) => name === "state.vscdb", options.maxSessionFiles, options);
      if (await pathExists(globalStateDbPath)) {
        dbFiles.unshift({ filePath: globalStateDbPath, mtimeMs: Date.now() });
      }
      const results = await Promise.all(dbFiles.slice(0, options.maxSessionFiles).map((file) => sampleCursorDb(file.filePath, options)));
      return mergeSampleResults("cursor", "Cursor", results, options.maxQueries);
    }
  };
}

function createJsonlInsightSampler(input: {
  sourceId: string;
  displayName: string;
  root: string;
  matchesFile(name: string): boolean;
  shouldParseLine?: JsonLineFilter;
  extractQuery: JsonQueryExtractor;
}): OnboardingInsightSampler {
  return {
    sourceId: input.sourceId,
    displayName: input.displayName,
    async detect() {
      return pathExists(input.root);
    },
    async sampleRecentUserQueries(options) {
      if (!(await pathExists(input.root))) {
        return emptyOnboardingSampleResult({ sourceId: input.sourceId, displayName: input.displayName });
      }

      const startedAt = Date.now();
      const files = await listRecentFiles(input.root, input.matchesFile, options.maxSessionFiles, options);
      const queries: OnboardingSampledQuery[] = [];
      const errors: Array<{ target: string; reason: string }> = [];
      for (const file of files) {
        if (queries.length >= options.maxQueries || deadlineReached(options, startedAt)) {
          break;
        }
        try {
          const records = await readRecentJsonlObjects(file.filePath, options, input.shouldParseLine);
          for (const [lineIndex, record] of records.entries()) {
            if (queries.length >= options.maxQueries) {
              break;
            }
            const query = input.extractQuery(record, { sourceId: input.sourceId, filePath: file.filePath, lineIndex });
            if (query) {
              queries.push(limitSampledQuery(query, options.maxQueryChars));
            }
          }
        } catch (error) {
          errors.push({ target: file.filePath, reason: error instanceof Error ? error.message : "read failed" });
        }
      }

      return {
        sourceId: input.sourceId,
        displayName: input.displayName,
        recentSessionCount: files.length,
        latestActivityAt: files[0] ? new Date(files[0].mtimeMs).toISOString() : null,
        queries: sortQueriesRecent(queries).slice(0, options.maxQueries),
        errors
      };
    }
  };
}

async function listRecentFiles(
  root: string,
  matchesFile: (name: string) => boolean,
  limit: number,
  options: Pick<OnboardingInsightSampleOptions, "signal" | "deadlineMs">
): Promise<RecentFile[]> {
  const startedAt = Date.now();
  const files: RecentFile[] = [];

  async function walk(directory: string): Promise<void> {
    if (options.signal?.aborted || Date.now() - startedAt > options.deadlineMs) {
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile() || !matchesFile(entry.name)) {
        continue;
      }
      try {
        const fileStat = await stat(path);
        files.push({ filePath: path, mtimeMs: fileStat.mtimeMs });
        files.sort((left, right) => right.mtimeMs - left.mtimeMs);
        if (files.length > limit * 4) {
          files.length = limit * 4;
        }
      } catch {
        // Ignore unreadable candidate files.
      }
    }
  }

  await walk(root);
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, limit);
}

async function readRecentJsonlObjects(
  filePath: string,
  options: OnboardingInsightSampleOptions,
  shouldParseLine?: JsonLineFilter
): Promise<JsonRecord[]> {
  const fileStat = await stat(filePath);
  const bytesToRead = Math.min(fileStat.size, options.maxBytesPerFile);
  if (bytesToRead <= 0) {
    return [];
  }
  const handle = await open(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    let remaining = bytesToRead;
    let position = fileStat.size;
    while (remaining > 0 && chunks.reduce((sum, chunk) => sum + chunk.length, 0) < options.maxBytesPerFile) {
      const size = Math.min(JSONL_CHUNK_SIZE, remaining);
      position -= size;
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, position);
      chunks.unshift(buffer);
      remaining -= size;
      if (position <= 0) {
        break;
      }
    }
    const text = Buffer.concat(chunks).toString("utf8");
    const lines = text.split(/\r?\n/);
    if (fileStat.size > bytesToRead) {
      lines.shift();
    }
    return lines
      .reverse()
      .map((line) => parseJsonObjectLine(line, shouldParseLine))
      .filter((record): record is JsonRecord => Boolean(record));
  } finally {
    await handle.close();
  }
}

function isPotentialCodexUserMessageLine(line: string): boolean {
  return /"type"\s*:\s*"response_item"/.test(line) &&
    /"type"\s*:\s*"message"/.test(line) &&
    /"role"\s*:\s*"user"/.test(line);
}

function isPotentialWorkbuddyUserMessageLine(line: string): boolean {
  return /"role"\s*:\s*"(?:user|human)"/u.test(line);
}

function sampleHermesStateDb(path: string, options: OnboardingInsightSampleOptions): OnboardingSampleResult {
  if (!pathExistsSync(path)) {
    return emptyOnboardingSampleResult({ sourceId: "hermes", displayName: "Hermes" });
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (!hasTable(db, "messages")) {
      return emptyOnboardingSampleResult({ sourceId: "hermes", displayName: "Hermes" });
    }
    const rows = db.prepare(`
      SELECT id, session_id, content, timestamp
      FROM messages
      WHERE role = 'user' AND content IS NOT NULL AND content != ''
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `).all(Math.min(DEFAULT_MAX_SQL_ROWS, options.maxQueries * 4)) as Array<{ id: number; session_id: string; content: string; timestamp: number }>;
    return sqlResult("hermes", "Hermes", rows.map((row) => ({
      sourceId: "hermes",
      conversationId: row.session_id,
      messageId: `${row.session_id}:${row.id}`,
      createdAt: normalizeTimestamp(row.timestamp),
      text: row.content,
      workspacePath: null
    })), options);
  } catch (error) {
    return emptyOnboardingSampleResult({
      sourceId: "hermes",
      displayName: "Hermes",
      errors: [{ target: path, reason: error instanceof Error ? error.message : "read failed" }]
    });
  } finally {
    db.close();
  }
}

function sampleOpencodeDb(path: string, options: OnboardingInsightSampleOptions): OnboardingSampleResult {
  if (!pathExistsSync(path)) {
    return emptyOnboardingSampleResult({ sourceId: "opencode", displayName: "Opencode" });
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (!hasTable(db, "message") || !hasTable(db, "part")) {
      return emptyOnboardingSampleResult({ sourceId: "opencode", displayName: "Opencode" });
    }
    const rows = db.prepare(`
      SELECT m.id, m.session_id, m.time_created, m.data AS message_data, p.data AS part_data
      FROM message m
      LEFT JOIN part p ON p.message_id = m.id
      ORDER BY m.time_created DESC, m.id DESC
      LIMIT ?
    `).all(Math.min(DEFAULT_MAX_SQL_ROWS, options.maxQueries * 6)) as Array<{
      id: string;
      session_id: string;
      time_created: number;
      message_data: string;
      part_data: string | null;
    }>;
    const queries = rows.flatMap((row) => {
      const messageData = parseJsonObject(row.message_data);
      if (!messageData || messageData.role !== "user") {
        return [];
      }
      const content = getPartText(parseJsonObject(row.part_data ?? "")) ?? stringValue(messageData.text) ?? stringValue(messageData.content);
      return content ? [{
        sourceId: "opencode",
        conversationId: row.session_id,
        messageId: row.id,
        createdAt: normalizeTimestamp(row.time_created),
        text: content,
        workspacePath: getNestedString(messageData, "path", "cwd")
      }] : [];
    });
    return sqlResult("opencode", "Opencode", queries, options);
  } catch (error) {
    return emptyOnboardingSampleResult({
      sourceId: "opencode",
      displayName: "Opencode",
      errors: [{ target: path, reason: error instanceof Error ? error.message : "read failed" }]
    });
  } finally {
    db.close();
  }
}

function sampleOpenclawDb(path: string, options: OnboardingInsightSampleOptions): OnboardingSampleResult {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (hasTable(db, "messages")) {
      const queries = sampleOpenclawTable(db, "messages", options);
      if (queries) {
        return sqlResult("openclaw", "OpenClaw", queries, options);
      }
    }
    if (hasTable(db, "chunks")) {
      const queries = sampleOpenclawTable(db, "chunks", options);
      if (queries) {
        return sqlResult("openclaw", "OpenClaw", queries, options);
      }
    }
    return emptyOnboardingSampleResult({ sourceId: "openclaw", displayName: "OpenClaw" });
  } catch (error) {
    return emptyOnboardingSampleResult({
      sourceId: "openclaw",
      displayName: "OpenClaw",
      errors: [{ target: path, reason: error instanceof Error ? error.message : "read failed" }]
    });
  } finally {
    db.close();
  }
}

function sampleOpenclawTable(
  db: DatabaseSync,
  tableName: string,
  options: OnboardingInsightSampleOptions
): OnboardingSampledQuery[] | null {
  const columns = tableColumns(db, tableName);
  const contentColumn = firstColumn(columns, ["content", "text", "message", "body"]);
  if (!contentColumn) {
    return null;
  }

  const idColumn = firstColumn(columns, ["id", "uuid", "message_id", "chunk_id"]);
  const sessionColumn = firstColumn(columns, ["conversation_id", "session_key", "session_id", "thread_id", "chat_id", "source_id"]);
  const createdAtColumn = firstColumn(columns, ["created_at", "timestamp", "time", "time_created", "updated_at", "createdAt"]);
  const roleColumn = firstColumn(columns, ["role", "sender", "author"]);
  const selectedColumns = uniqueStrings([idColumn, sessionColumn, contentColumn, createdAtColumn, roleColumn])
    .map((column) => quoteIdentifier(column))
    .join(", ");
  const where = roleColumn
    ? `WHERE LOWER(CAST(${quoteIdentifier(roleColumn)} AS TEXT)) IN ('user', 'human', '1') AND ${quoteIdentifier(contentColumn)} IS NOT NULL AND CAST(${quoteIdentifier(contentColumn)} AS TEXT) != ''`
    : `WHERE ${quoteIdentifier(contentColumn)} IS NOT NULL AND CAST(${quoteIdentifier(contentColumn)} AS TEXT) != ''`;
  const orderBy = createdAtColumn
    ? `ORDER BY ${quoteIdentifier(createdAtColumn)} DESC${idColumn ? `, ${quoteIdentifier(idColumn)} DESC` : ""}`
    : idColumn ? `ORDER BY ${quoteIdentifier(idColumn)} DESC` : "";
  const rows = db.prepare(`
    SELECT ${selectedColumns}
    FROM ${quoteIdentifier(tableName)}
    ${where}
    ${orderBy}
    LIMIT ?
  `).all(Math.min(DEFAULT_MAX_SQL_ROWS, options.maxQueries * 4)) as Array<Record<string, unknown>>;

  return rows.flatMap((row, index) => {
    const content = stringValue(row[contentColumn]);
    if (!content) {
      return [];
    }
    const id = idColumn ? stringValue(row[idColumn]) : null;
    const conversationId = sessionColumn ? stringValue(row[sessionColumn]) : null;
    return [{
      sourceId: "openclaw",
      conversationId: conversationId ?? `${tableName}:${id ?? index}`,
      messageId: id ?? `${tableName}:${index}`,
      createdAt: normalizeTimestamp(createdAtColumn ? row[createdAtColumn] : null),
      text: content,
      workspacePath: null
    }];
  });
}

function sampleCursorDb(path: string, options: OnboardingInsightSampleOptions): OnboardingSampleResult {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const queries: OnboardingSampledQuery[] = [];
    if (hasTable(db, "cursorDiskKV")) {
      const rows = db.prepare(`
        SELECT rowid, key, value
        FROM cursorDiskKV
        WHERE key LIKE 'bubbleId:%' AND value IS NOT NULL
        ORDER BY rowid DESC
        LIMIT ?
      `).all(Math.min(DEFAULT_MAX_SQL_ROWS, options.maxQueries * 8)) as Array<{ rowid: number; key: string; value: string }>;
      for (const row of rows) {
        const parsed = parseJsonObject(row.value);
        if (!parsed || parsed.type !== 1) {
          continue;
        }
        const text = stringValue(parsed.text);
        const keyParts = row.key.split(":");
        if (!text || keyParts.length !== 3 || !keyParts[1] || !keyParts[2]) {
          continue;
        }
        queries.push({
          sourceId: "cursor",
          conversationId: keyParts[1],
          messageId: stringValue(parsed.bubbleId) ?? keyParts[2],
          createdAt: normalizeTimestamp(parsed.createdAt ?? parsed.timestamp ?? row.rowid),
          text,
          workspacePath: null
        });
      }
    }
    return sqlResult("cursor", "Cursor", queries, options);
  } catch (error) {
    return emptyOnboardingSampleResult({
      sourceId: "cursor",
      displayName: "Cursor",
      errors: [{ target: path, reason: error instanceof Error ? error.message : "read failed" }]
    });
  } finally {
    db.close();
  }
}

function sqlResult(
  sourceId: string,
  displayName: string,
  queries: OnboardingSampledQuery[],
  options: OnboardingInsightSampleOptions
): OnboardingSampleResult {
  const limited = sortQueriesRecent(queries).slice(0, options.maxQueries).map((query) => limitSampledQuery(query, options.maxQueryChars));
  return {
    sourceId,
    displayName,
    recentSessionCount: new Set(limited.map((query) => query.conversationId)).size,
    latestActivityAt: limited[0]?.createdAt ?? null,
    queries: limited,
    errors: []
  };
}

function mergeSampleResults(sourceId: string, displayName: string, results: OnboardingSampleResult[], maxQueries: number): OnboardingSampleResult {
  const queries = sortQueriesRecent(results.flatMap((result) => result.queries)).slice(0, maxQueries);
  return {
    sourceId,
    displayName,
    recentSessionCount: results.reduce((sum, result) => sum + result.recentSessionCount, 0),
    latestActivityAt: queries[0]?.createdAt ?? results.map((result) => result.latestActivityAt).filter(Boolean).sort().at(-1) ?? null,
    queries,
    errors: results.flatMap((result) => result.errors)
  };
}

function extractCodexQuery(record: JsonRecord, fallback: { sourceId: string; filePath: string; lineIndex: number }): OnboardingSampledQuery | null {
  const payload = recordValue(record.payload);
  if (record.type !== "response_item" || !payload || payload.type !== "message" || payload.role !== "user") {
    return null;
  }
  const text = contentText(payload.content);
  if (!text) {
    return null;
  }
  return {
    sourceId: fallback.sourceId,
    conversationId: rolloutIdFromPath(fallback.filePath),
    messageId: `${rolloutIdFromPath(fallback.filePath)}:${fallback.lineIndex}`,
    createdAt: normalizeTimestamp(record.timestamp),
    text,
    workspacePath: stringValue(record.cwd) ?? stringValue(recordValue(record.payload)?.cwd)
  };
}

function extractClaudeCodeQuery(record: JsonRecord, fallback: { sourceId: string; lineIndex: number }): OnboardingSampledQuery | null {
  if (record.type !== "user") {
    return null;
  }
  const message = recordValue(record.message);
  const text = message ? contentText(message.content) : null;
  if (!text) {
    return null;
  }
  const conversationId = stringValue(record.sessionId) ?? "unknown-session";
  return {
    sourceId: fallback.sourceId,
    conversationId,
    messageId: stringValue(record.uuid) ?? `${conversationId}:${fallback.lineIndex}`,
    createdAt: normalizeTimestamp(record.timestamp),
    text,
    workspacePath: stringValue(record.cwd)
  };
}

function extractWorkbuddyQuery(
  record: JsonRecord,
  fallback: { sourceId: string; filePath: string; lineIndex: number }
): OnboardingSampledQuery | null {
  const message = extractWorkbuddyUserMessage(record, basename(fallback.filePath, ".jsonl"), fallback.lineIndex);
  if (!message?.content.trim()) {
    return null;
  }
  return {
    sourceId: fallback.sourceId,
    conversationId: message.conversationId,
    messageId: message.messageId,
    createdAt: message.createdAt,
    text: message.content,
    workspacePath: message.workspacePath
  };
}

function extractGenericJsonlQuery(record: JsonRecord, fallback: { sourceId: string; filePath: string; lineIndex: number }): OnboardingSampledQuery | null {
  const role = stringValue(record.role) ?? stringValue(record.type);
  if (role !== "user") {
    return null;
  }
  const text = stringValue(record.content) ?? stringValue(record.text) ?? contentText(record.message);
  if (!text) {
    return null;
  }
  const conversationId = stringValue(record.sessionId) ?? stringValue(record.conversationId) ?? basename(fallback.filePath);
  return {
    sourceId: fallback.sourceId,
    conversationId,
    messageId: stringValue(record.id) ?? stringValue(record.uuid) ?? `${conversationId}:${fallback.lineIndex}`,
    createdAt: normalizeTimestamp(record.timestamp ?? record.createdAt),
    text,
    workspacePath: stringValue(record.cwd) ?? stringValue(record.workspacePath)
  };
}

function limitSampledQuery(query: OnboardingSampledQuery, maxChars: number): OnboardingSampledQuery {
  const redacted = stripInlineMediaPayloads(redactSecrets(query.text)).trim();
  return {
    ...query,
    text: redacted.length <= maxChars ? redacted : `${redacted.slice(0, maxChars)}...`
  };
}

function sortQueriesRecent(queries: OnboardingSampledQuery[]): OnboardingSampledQuery[] {
  return [...queries].sort((left, right) =>
    Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
    left.sourceId.localeCompare(right.sourceId) ||
    left.conversationId.localeCompare(right.conversationId) ||
    left.messageId.localeCompare(right.messageId)
  );
}

function contentText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const text = value
    .filter((item): item is JsonRecord => typeof item === "object" && item !== null && !Array.isArray(item))
    .map((item) => stringValue(item.text) ?? stringValue(item.content))
    .filter((item): item is string => Boolean(item))
    .join("\n");
  return text.trim() || null;
}

function parseJsonObject(input: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(input) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as JsonRecord : null;
  } catch {
    return null;
  }
}

function parseJsonObjectLine(input: string, shouldParseLine?: JsonLineFilter): JsonRecord | null {
  const line = input.trim();
  if (!line || (shouldParseLine && !shouldParseLine(line))) {
    return null;
  }

  return parseJsonObject(line);
}

function recordValue(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getPartText(value: JsonRecord | null): string | null {
  return value?.type === "text" ? stringValue(value.text) : null;
}

function getNestedString(record: JsonRecord, parentKey: string, childKey: string): string | null {
  const parent = recordValue(record[parentKey]);
  return parent ? stringValue(parent[childKey]) : null;
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value === "number") {
    const date = new Date(value > 10_000_000_000 ? value : value * 1000);
    return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
  }
  if (typeof value === "string") {
    const date = /^\d+$/.test(value) ? new Date(Number(value)) : new Date(value);
    return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
  }
  return new Date(0).toISOString();
}

function rolloutIdFromPath(filePath: string): string {
  const name = basename(filePath).replace(/\.jsonl$/, "");
  return name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)?.[0] ?? name;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function pathExistsSync(path: string): boolean {
  return existsSync(path);
}

function hasTable(db: DatabaseSync, tableName: string): boolean {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function tableColumns(db: DatabaseSync, tableName: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<{ name?: unknown }>;
  return rows.map((row) => stringValue(row.name)).filter((name): name is string => Boolean(name));
}

function firstColumn(columns: readonly string[], candidates: readonly string[]): string | null {
  const normalized = new Map(columns.map((column) => [column.toLocaleLowerCase(), column]));
  for (const candidate of candidates) {
    const column = normalized.get(candidate.toLocaleLowerCase());
    if (column) {
      return column;
    }
  }
  return null;
}

function uniqueStrings(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function deadlineReached(options: OnboardingInsightSampleOptions, startedAt: number): boolean {
  return Boolean(options.signal?.aborted) || Date.now() - startedAt > options.deadlineMs;
}
