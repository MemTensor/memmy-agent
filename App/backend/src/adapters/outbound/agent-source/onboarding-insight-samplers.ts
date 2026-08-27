import { existsSync } from "node:fs";
import { access, open, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stripInlineMediaPayloads } from "../../../shared/inline-media-sanitizer.js";
import {
  resolveClaudeCodeProjectsDirectory,
  resolveCodexSessionsDirectory,
  resolveCursorDataPaths,
  resolveDeepseekHarnessHomeDirectory,
  resolveHermesHomeDirectory,
  resolveOpencodeDatabasePath,
  resolveOpenclawStateDirectory,
  resolvePiSessionsDirectory,
  resolveQwenworkProjectsDirectory,
  resolveWorkbuddyProjectsDirectory
} from "../agent-paths.js";
import { extractPiMessage } from "./pi/history-reader.js";
import { extractQwenworkMessage } from "./qwenwork/history-reader.js";
import { extractWorkbuddyMessage } from "./workbuddy/history-reader.js";
import { createDeepseekHarnessSourceAdapter } from "./deepseek-harness/index.js";
import { redactSecrets } from "./secret-redactor.js";
import type { SourceRegistry } from "./source-registry.js";
import {
  emptyOnboardingSampleResult,
  type OnboardingConversationWindow,
  type OnboardingConversationWindowReader,
  type OnboardingInsightSampleOptions,
  type OnboardingInsightSampler,
  type OnboardingSampleResult,
  type OnboardingSampledMessage,
  type OnboardingSampledQuery
} from "./insight-sampler-types.js";

const JSONL_CHUNK_SIZE = 64 * 1024;
const DEFAULT_MAX_SQL_ROWS = 200;
const MAX_RECENT_PROBE_MESSAGES = 64;
const CONVERSATION_SCAN_TARGETS = 6;
const FIRST_CONVERSATION_TURNS = 2;
const LAST_CONVERSATION_TURNS = 12;
const MAX_ASSISTANT_MESSAGES_PER_TURN = 2;
const MAX_TOOL_MESSAGES_PER_TURN = 4;
const MAX_USER_MESSAGE_CHARS = 1_200;
const MAX_ASSISTANT_MESSAGE_CHARS = 2_000;
const MAX_TOOL_MESSAGE_CHARS = 400;
const MAX_CONVERSATION_WINDOW_CHARS = 24_000;

interface RecentFile {
  filePath: string;
  mtimeMs: number;
}

type JsonRecord = Record<string, unknown>;
type JsonMessageExtractor = (record: JsonRecord, fallback: {
  sourceId: string;
  filePath: string;
  lineIndex: number;
}) => OnboardingSampledMessage | null;
type JsonLineFilter = (line: string) => boolean;

export function createBuiltinOnboardingInsightSamplers(): OnboardingInsightSampler[] {
  return [
    createCursorInsightSampler(),
    createClaudeCodeInsightSampler({ root: resolveClaudeCodeProjectsDirectory() }),
    createCodexInsightSampler({ root: resolveCodexSessionsDirectory() }),
    createOpencodeInsightSampler({ databasePath: resolveOpencodeDatabasePath() }),
    createOpenclawInsightSampler({ root: resolveOpenclawStateDirectory() }),
    createHermesInsightSampler({ root: resolveHermesHomeDirectory() }),
    createDeepseekHarnessInsightSampler({ root: resolveDeepseekHarnessHomeDirectory() }),
    createWorkbuddyInsightSampler({ root: resolveWorkbuddyProjectsDirectory() }),
    createPiInsightSampler({ root: resolvePiSessionsDirectory() }),
    createQwenworkInsightSampler({ root: resolveQwenworkProjectsDirectory() })
  ];
}

export function createSourceRegistryOnboardingConversationWindowReader(
  sourceRegistry: SourceRegistry
): OnboardingConversationWindowReader {
  return {
    async readConversation(reference, options) {
      const adapter = sourceRegistry.require(reference.sourceId);
      const deadlineSignal = AbortSignal.timeout(options.deadlineMs);
      const signal = options.signal ? AbortSignal.any([options.signal, deadlineSignal]) : deadlineSignal;
      const messages: OnboardingSampledMessage[] = [];
      let foundConversation = false;

      try {
        for await (const message of adapter.scan({
          maxScanTargets: CONVERSATION_SCAN_TARGETS,
          order: "recent_first",
          signal
        })) {
          if (message.conversationId !== reference.conversationId) {
            if (foundConversation) {
              break;
            }
            continue;
          }
          foundConversation = true;
          if (message.role === "system") {
            continue;
          }
          messages.push({
            sourceId: message.sourceId,
            conversationId: message.conversationId,
            messageId: message.messageId,
            role: message.role,
            createdAt: message.createdAt,
            text: message.content,
            workspacePath: message.workspacePath
          });
        }
      } catch (error) {
        if (!deadlineSignal.aborted && !options.signal?.aborted) {
          throw error;
        }
      }

      const windowMessages = selectConversationWindow(messages);
      if (windowMessages.length === 0) {
        return null;
      }
      return {
        ...reference,
        messages: windowMessages
      } satisfies OnboardingConversationWindow;
    }
  };
}

export function createWorkbuddyInsightSampler(input: { root: string }): OnboardingInsightSampler {
  return createJsonlInsightSampler({
    sourceId: "workbuddy",
    displayName: "WorkBuddy",
    root: input.root,
    matchesFile: (name) => name.endsWith(".jsonl"),
    shouldParseLine: isPotentialWorkbuddyMessageLine,
    extractMessage: extractWorkbuddySampledMessage
  });
}

export function createPiInsightSampler(input: { root: string }): OnboardingInsightSampler {
  return createJsonlInsightSampler({
    sourceId: "pi",
    displayName: "Pi",
    root: input.root,
    matchesFile: (name) => name.endsWith(".jsonl"),
    shouldParseLine: (line) => /"type"\s*:\s*"message"/u.test(line),
    extractMessage: extractPiSampledMessage
  });
}

export function createQwenworkInsightSampler(input: { root: string }): OnboardingInsightSampler {
  return createJsonlInsightSampler({
    sourceId: "qwenwork",
    displayName: "QwenWork",
    root: input.root,
    matchesFile: (name) => name.endsWith(".jsonl"),
    shouldParseLine: (line) => /"type"\s*:\s*"(?:user|assistant|system)"/u.test(line),
    extractMessage: extractQwenworkSampledMessage
  });
}

export function createCodexInsightSampler(input: { root: string }): OnboardingInsightSampler {
  return createJsonlInsightSampler({
    sourceId: "codex",
    displayName: "Codex",
    root: input.root,
    matchesFile: (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"),
    shouldParseLine: isPotentialCodexMessageLine,
    extractMessage: extractCodexMessage
  });
}

export function createClaudeCodeInsightSampler(input: { root: string }): OnboardingInsightSampler {
  return createJsonlInsightSampler({
    sourceId: "claude_code",
    displayName: "Claude Code",
    root: input.root,
    matchesFile: (name) => name.endsWith(".jsonl"),
    extractMessage: extractClaudeCodeMessage
  });
}

export function createHermesInsightSampler(input: { root: string }): OnboardingInsightSampler {
  const stateDbPath = join(input.root, "state.db");
  const jsonl = createJsonlInsightSampler({
    sourceId: "hermes",
    displayName: "Hermes",
    root: join(input.root, "sessions"),
    matchesFile: (name) => name.endsWith(".jsonl"),
    extractMessage: extractGenericJsonlMessage
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

export function createDeepseekHarnessInsightSampler(input: { root: string }): OnboardingInsightSampler {
  const adapter = createDeepseekHarnessSourceAdapter({ rootDirectory: input.root });
  return {
    sourceId: "deepseek_harness",
    displayName: "DeepSeek Harness",
    detect: () => adapter.detect(),
    async sampleRecentUserQueries(options) {
      const messages: OnboardingSampledMessage[] = [];
      const errors: Array<{ target: string; reason: string }> = [];
      try {
        for await (const message of adapter.scan({
          maxScanTargets: options.maxSessionFiles,
          order: "recent_first",
          signal: options.signal
        })) {
          if (message.role !== "user" && message.role !== "assistant" && message.role !== "tool") continue;
          messages.push(limitSampledMessage({
            sourceId: message.sourceId,
            conversationId: message.conversationId,
            messageId: message.messageId,
            role: message.role,
            createdAt: message.createdAt,
            text: message.content,
            workspacePath: message.workspacePath
          }, message.role === "tool" ? MAX_TOOL_MESSAGE_CHARS : options.maxQueryChars));
        }
      } catch (error) {
        errors.push({ target: input.root, reason: error instanceof Error ? error.message : "read failed" });
      }
      const sorted = sortMessagesRecent(messages);
      return {
        sourceId: "deepseek_harness",
        displayName: "DeepSeek Harness",
        recentSessionCount: new Set(messages.map((message) => message.conversationId)).size,
        latestActivityAt: sorted[0]?.createdAt ?? null,
        queries: sorted.filter((message) => message.role === "user").slice(0, options.maxQueries),
        recentMessages: sorted.slice(0, MAX_RECENT_PROBE_MESSAGES),
        errors
      };
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
  extractMessage: JsonMessageExtractor;
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
      const recentMessages: OnboardingSampledMessage[] = [];
      const errors: Array<{ target: string; reason: string }> = [];
      for (const file of files) {
        if (queries.length >= options.maxQueries || deadlineReached(options, startedAt)) {
          break;
        }
        try {
          const records = await readRecentJsonlObjects(file.filePath, options, input.shouldParseLine);
          for (const [lineIndex, record] of records.entries()) {
            if (queries.length >= options.maxQueries && recentMessages.length >= MAX_RECENT_PROBE_MESSAGES) {
              break;
            }
            const message = input.extractMessage(record, { sourceId: input.sourceId, filePath: file.filePath, lineIndex });
            if (!message) {
              continue;
            }
            if (recentMessages.length < MAX_RECENT_PROBE_MESSAGES) {
              recentMessages.push(limitSampledMessage(message, message.role === "tool" ? MAX_TOOL_MESSAGE_CHARS : options.maxQueryChars));
            }
            if (message.role === "user" && queries.length < options.maxQueries) {
              queries.push(limitSampledQuery(message, options.maxQueryChars));
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
        recentMessages: sortMessagesRecent(recentMessages).slice(0, MAX_RECENT_PROBE_MESSAGES),
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

function isPotentialCodexMessageLine(line: string): boolean {
  return /"type"\s*:\s*"response_item"/.test(line) &&
    /"type"\s*:\s*"message"/.test(line) &&
    /"role"\s*:\s*"(?:user|assistant)"/.test(line);
}

function isPotentialWorkbuddyMessageLine(line: string): boolean {
  return /"role"\s*:\s*"(?:user|human|assistant|agent|tool)"/u.test(line) ||
    /"type"\s*:\s*"(?:tool_call|tool_result|function_call|function_call_output)"/u.test(line);
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
      SELECT id, session_id, role, content, timestamp
      FROM messages
      WHERE role IN ('user', 'assistant', 'tool') AND content IS NOT NULL AND content != ''
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `).all(Math.min(DEFAULT_MAX_SQL_ROWS, options.maxQueries * 8)) as Array<{
      id: number;
      session_id: string;
      role: "user" | "assistant" | "tool";
      content: string;
      timestamp: number;
    }>;
    return sqlResult("hermes", "Hermes", rows.map((row) => ({
      sourceId: "hermes",
      conversationId: row.session_id,
      messageId: `${row.session_id}:${row.id}`,
      role: row.role,
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
    const messages = rows.flatMap((row): OnboardingSampledMessage[] => {
      const messageData = parseJsonObject(row.message_data);
      const role = normalizeSampledRole(messageData?.role);
      if (!messageData || (role !== "user" && role !== "assistant")) {
        return [];
      }
      const content = getPartText(parseJsonObject(row.part_data ?? "")) ?? stringValue(messageData.text) ?? stringValue(messageData.content);
      return content ? [{
        sourceId: "opencode",
        conversationId: row.session_id,
        messageId: row.id,
        role,
        createdAt: normalizeTimestamp(row.time_created),
        text: content,
        workspacePath: getNestedString(messageData, "path", "cwd")
      }] : [];
    });
    return sqlResult("opencode", "Opencode", messages, options);
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
      const messages = sampleOpenclawTable(db, "messages", options);
      if (messages) {
        return sqlResult("openclaw", "OpenClaw", messages, options);
      }
    }
    if (hasTable(db, "chunks")) {
      const messages = sampleOpenclawTable(db, "chunks", options);
      if (messages) {
        return sqlResult("openclaw", "OpenClaw", messages, options);
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
): OnboardingSampledMessage[] | null {
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
    ? `WHERE LOWER(CAST(${quoteIdentifier(roleColumn)} AS TEXT)) IN ('user', 'human', 'assistant', 'agent', 'tool', '1', '2') AND ${quoteIdentifier(contentColumn)} IS NOT NULL AND CAST(${quoteIdentifier(contentColumn)} AS TEXT) != ''`
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
    const role = normalizeSampledRole(roleColumn ? row[roleColumn] : "user");
    if (!role) {
      return [];
    }
    return [{
      sourceId: "openclaw",
      conversationId: conversationId ?? `${tableName}:${id ?? index}`,
      messageId: id ?? `${tableName}:${index}`,
      role,
      createdAt: normalizeTimestamp(createdAtColumn ? row[createdAtColumn] : null),
      text: content,
      workspacePath: null
    }];
  });
}

function sampleCursorDb(path: string, options: OnboardingInsightSampleOptions): OnboardingSampleResult {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const messages: OnboardingSampledMessage[] = [];
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
        const role = parsed?.type === 1 ? "user" : parsed?.type === 2 ? "assistant" : null;
        if (!parsed || !role) {
          continue;
        }
        const text = stringValue(parsed.text);
        const keyParts = row.key.split(":");
        if (!text || keyParts.length !== 3 || !keyParts[1] || !keyParts[2]) {
          continue;
        }
        messages.push({
          sourceId: "cursor",
          conversationId: keyParts[1],
          messageId: stringValue(parsed.bubbleId) ?? keyParts[2],
          role,
          createdAt: normalizeTimestamp(parsed.createdAt ?? parsed.timestamp ?? row.rowid),
          text,
          workspacePath: null
        });
      }
    }
    return sqlResult("cursor", "Cursor", messages, options);
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
  messages: OnboardingSampledMessage[],
  options: OnboardingInsightSampleOptions
): OnboardingSampleResult {
  const recentMessages = sortMessagesRecent(messages)
    .slice(0, MAX_RECENT_PROBE_MESSAGES)
    .map((message) => limitSampledMessage(message, message.role === "tool" ? MAX_TOOL_MESSAGE_CHARS : options.maxQueryChars));
  const queries = recentMessages
    .filter((message) => message.role === "user")
    .slice(0, options.maxQueries)
    .map(({ role: _role, ...query }) => query);
  return {
    sourceId,
    displayName,
    recentSessionCount: new Set(recentMessages.map((message) => message.conversationId)).size,
    latestActivityAt: recentMessages[0]?.createdAt ?? null,
    queries,
    recentMessages,
    errors: []
  };
}

function mergeSampleResults(sourceId: string, displayName: string, results: OnboardingSampleResult[], maxQueries: number): OnboardingSampleResult {
  const queries = sortQueriesRecent(results.flatMap((result) => result.queries)).slice(0, maxQueries);
  const recentMessages = sortMessagesRecent(results.flatMap((result) => result.recentMessages ?? []))
    .slice(0, MAX_RECENT_PROBE_MESSAGES);
  return {
    sourceId,
    displayName,
    recentSessionCount: results.reduce((sum, result) => sum + result.recentSessionCount, 0),
    latestActivityAt: recentMessages[0]?.createdAt ?? queries[0]?.createdAt ?? results.map((result) => result.latestActivityAt).filter(Boolean).sort().at(-1) ?? null,
    queries,
    recentMessages,
    errors: results.flatMap((result) => result.errors)
  };
}

function extractCodexMessage(record: JsonRecord, fallback: { sourceId: string; filePath: string; lineIndex: number }): OnboardingSampledMessage | null {
  const payload = recordValue(record.payload);
  const role = normalizeSampledRole(payload?.role);
  if (record.type !== "response_item" || !payload || payload.type !== "message" || (role !== "user" && role !== "assistant")) {
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
    role,
    createdAt: normalizeTimestamp(record.timestamp),
    text,
    workspacePath: stringValue(record.cwd) ?? stringValue(recordValue(record.payload)?.cwd)
  };
}

function extractClaudeCodeMessage(record: JsonRecord, fallback: { sourceId: string; lineIndex: number }): OnboardingSampledMessage | null {
  const role = normalizeSampledRole(record.type);
  if (role !== "user" && role !== "assistant") {
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
    role,
    createdAt: normalizeTimestamp(record.timestamp),
    text,
    workspacePath: stringValue(record.cwd)
  };
}

function extractWorkbuddySampledMessage(
  record: JsonRecord,
  fallback: { sourceId: string; filePath: string; lineIndex: number }
): OnboardingSampledMessage | null {
  const message = extractWorkbuddyMessage(record, basename(fallback.filePath, ".jsonl"), fallback.lineIndex);
  if (!message?.content.trim()) {
    return null;
  }
  const role = normalizeSampledRole(message.role);
  if (!role) {
    return null;
  }
  return {
    sourceId: fallback.sourceId,
    conversationId: message.conversationId,
    messageId: message.messageId,
    role,
    createdAt: message.createdAt,
    text: message.content,
    workspacePath: message.workspacePath
  };
}

function extractPiSampledMessage(
  record: JsonRecord,
  fallback: { sourceId: string; filePath: string; lineIndex: number }
): OnboardingSampledMessage | null {
  return toSampledMessage(
    fallback.sourceId,
    extractPiMessage(record, basename(fallback.filePath, ".jsonl"), fallback.lineIndex)
  );
}

function extractQwenworkSampledMessage(
  record: JsonRecord,
  fallback: { sourceId: string; filePath: string; lineIndex: number }
): OnboardingSampledMessage | null {
  return toSampledMessage(
    fallback.sourceId,
    extractQwenworkMessage(record, basename(fallback.filePath, ".jsonl"), fallback.lineIndex)
  );
}

function toSampledMessage(
  sourceId: string,
  message: {
    conversationId: string;
    messageId: string;
    role: "user" | "assistant" | "tool" | "system";
    createdAt: string;
    content: string;
    workspacePath: string | null;
  } | null
): OnboardingSampledMessage | null {
  const role = normalizeSampledRole(message?.role);
  if (!message || !role || !message.content.trim()) return null;
  return {
    sourceId,
    conversationId: message.conversationId,
    messageId: message.messageId,
    role,
    createdAt: message.createdAt,
    text: message.content,
    workspacePath: message.workspacePath
  };
}

function extractGenericJsonlMessage(record: JsonRecord, fallback: { sourceId: string; filePath: string; lineIndex: number }): OnboardingSampledMessage | null {
  const role = normalizeSampledRole(stringValue(record.role) ?? stringValue(record.type));
  if (!role) {
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
    role,
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

function limitSampledMessage(message: OnboardingSampledMessage, maxChars: number): OnboardingSampledMessage {
  return {
    ...message,
    text: clipMessageText(message.text, maxChars)
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

function sortMessagesRecent(messages: OnboardingSampledMessage[]): OnboardingSampledMessage[] {
  return [...messages].sort((left, right) =>
    Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
    left.sourceId.localeCompare(right.sourceId) ||
    left.conversationId.localeCompare(right.conversationId) ||
    left.messageId.localeCompare(right.messageId)
  );
}

function selectConversationWindow(messages: readonly OnboardingSampledMessage[]): OnboardingSampledMessage[] {
  const chronological = [...messages]
    .filter((message) => message.role === "user" || message.role === "assistant" || message.role === "tool")
    .sort((left, right) =>
      Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.messageId.localeCompare(right.messageId)
    );
  const turns: OnboardingSampledMessage[][] = [];
  let currentTurn: OnboardingSampledMessage[] | null = null;
  for (const message of chronological) {
    if (message.role === "user") {
      currentTurn = [message];
      turns.push(currentTurn);
      continue;
    }
    currentTurn?.push(message);
  }

  const selectedTurns = [...turns.slice(0, FIRST_CONVERSATION_TURNS), ...turns.slice(-LAST_CONVERSATION_TURNS)];
  const seen = new Set<string>();
  const compacted = selectedTurns.flatMap(compactConversationTurn).filter((message) => {
    if (seen.has(message.messageId)) {
      return false;
    }
    seen.add(message.messageId);
    return true;
  }).map((message) => limitSampledMessage(
    message,
    message.role === "user"
      ? MAX_USER_MESSAGE_CHARS
      : message.role === "assistant"
        ? MAX_ASSISTANT_MESSAGE_CHARS
        : MAX_TOOL_MESSAGE_CHARS
  ));
  return boundConversationWindowChars(compacted);
}

function compactConversationTurn(turn: readonly OnboardingSampledMessage[]): OnboardingSampledMessage[] {
  const assistantIds = new Set(turn.filter((message) => message.role === "assistant")
    .slice(-MAX_ASSISTANT_MESSAGES_PER_TURN)
    .map((message) => message.messageId));
  const toolIds = new Set(turn.filter((message) => message.role === "tool")
    .slice(-MAX_TOOL_MESSAGES_PER_TURN)
    .map((message) => message.messageId));
  return turn.filter((message) =>
    message.role === "user" || assistantIds.has(message.messageId) || toolIds.has(message.messageId)
  );
}

function boundConversationWindowChars(messages: readonly OnboardingSampledMessage[]): OnboardingSampledMessage[] {
  const totalChars = messages.reduce((sum, message) => sum + message.text.length, 0);
  if (totalChars <= MAX_CONVERSATION_WINDOW_CHARS) {
    return [...messages];
  }
  const ratio = MAX_CONVERSATION_WINDOW_CHARS / totalChars;
  return messages.map((message) => limitSampledMessage(message, Math.max(120, Math.floor(message.text.length * ratio))));
}

function clipMessageText(text: string, maxChars: number): string {
  const sanitized = stripInlineMediaPayloads(redactSecrets(text)).trim();
  if (sanitized.length <= maxChars) {
    return sanitized;
  }
  const headLength = Math.max(1, Math.floor(maxChars * 0.35));
  const tailLength = Math.max(1, maxChars - headLength - 5);
  return `${sanitized.slice(0, headLength)}\n...\n${sanitized.slice(-tailLength)}`;
}

function normalizeSampledRole(value: unknown): OnboardingSampledMessage["role"] | null {
  if (value === "user" || value === "human" || value === "1" || value === 1) {
    return "user";
  }
  if (value === "assistant" || value === "agent" || value === "2" || value === 2) {
    return "assistant";
  }
  if (value === "tool") {
    return "tool";
  }
  return null;
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
