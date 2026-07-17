/** State db reader module. */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

const SQLITE_ROW_YIELD_INTERVAL = 100;

/** Contract for raw hermes state db message. */
export interface RawHermesStateDbMessage {
  messageId: string;
  conversationId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  createdAt: string;
  workspacePath: string | null;
  gitRoot: string | null;
  rawMeta: Readonly<Record<string, unknown>>;
}

interface HermesMessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string | null;
  tool_call_id: string | null;
  tool_calls: string | null;
  tool_name: string | null;
  timestamp: number;
  platform_message_id: string | null;
  cwd: string | null;
}

/** State db reader module. */
export async function* readHermesStateDb(path: string): AsyncIterable<RawHermesStateDbMessage> {
  const db = new DatabaseSync(path, { readOnly: true });

  try {
    if (!hasTable(db, "messages")) {
      return;
    }

    const messageColumns = getTableColumns(db, "messages");
    if (!hasColumns(messageColumns, ["id", "session_id", "role", "content", "timestamp"])) {
      return;
    }

    const sessionColumns = hasTable(db, "sessions") ? getTableColumns(db, "sessions") : new Set<string>();
    const statement = db.prepare(buildMessagesSql(messageColumns, sessionColumns));

    let rows = 0;
    for (const row of statement.iterate() as Iterable<HermesMessageRow>) {
      rows += 1;
      if (rows % SQLITE_ROW_YIELD_INTERVAL === 0) {
        await yieldToEventLoop();
      }

      const message = toRawHermesStateDbMessage(row);
      if (message) {
        yield message;
      }
    }
  } finally {
    db.close();
  }
}

function toRawHermesStateDbMessage(row: HermesMessageRow): RawHermesStateDbMessage | null {
  let role = normalizeRole(row.role);
  if (!role) {
    return null;
  }

  if (role === "assistant" && !row.content && row.tool_calls) {
    role = "tool";
  }
  const content = renderHermesMessageContent(role, row);
  if (!content) {
    return null;
  }
  const workspacePath = row.cwd && row.cwd.length > 0 ? row.cwd : null;
  return {
    messageId: row.platform_message_id ?? `${row.session_id}:${row.id}`,
    conversationId: row.session_id,
    role,
    content,
    createdAt: normalizeTimestamp(row.timestamp),
    workspacePath,
    gitRoot: workspacePath ? findGitRoot(workspacePath) : null,
    rawMeta: Object.freeze({
      hermesMessageId: row.id,
      hermesPlatformMessageId: row.platform_message_id,
      hermesToolCallId: row.tool_call_id,
      hermesToolName: row.tool_name
    })
  };
}

function normalizeRole(role: string): RawHermesStateDbMessage["role"] | null {
  if (role === "user" || role === "assistant" || role === "tool" || role === "system") {
    return role;
  }

  return null;
}

function renderHermesMessageContent(role: RawHermesStateDbMessage["role"], row: HermesMessageRow): string | null {
  if (role !== "tool") {
    return row.content && row.content.length > 0 ? row.content : null;
  }

  const body = [
    row.tool_name ? `Tool: ${row.tool_name}` : undefined,
    row.tool_call_id ? `Call ID: ${row.tool_call_id}` : undefined,
    row.tool_calls ? `Input:\n${row.tool_calls}` : undefined,
    row.content ? `Output:\n${row.content}` : undefined
  ].filter(Boolean).join("\n\n");
  return body.length > 0 ? body : null;
}

function normalizeTimestamp(timestamp: number): string {
  return new Date(timestamp > 10_000_000_000 ? timestamp : timestamp * 1000).toISOString();
}

function findGitRoot(workspacePath: string): string | null {
  let current = workspacePath;
  while (current !== dirname(current)) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }

    current = dirname(current);
  }

  return existsSync(join(current, ".git")) ? current : null;
}

function hasTable(db: DatabaseSync, tableName: string): boolean {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function getTableColumns(db: DatabaseSync, tableName: string): ReadonlySet<string> {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function hasColumns(columns: ReadonlySet<string>, requiredColumns: readonly string[]): boolean {
  return requiredColumns.every((column) => columns.has(column));
}

function buildMessagesSql(messageColumns: ReadonlySet<string>, sessionColumns: ReadonlySet<string>): string {
  const joinSessions = hasColumns(sessionColumns, ["id", "cwd"]);
  const activeFilter = messageColumns.has("active") ? "AND (m.active IS NULL OR m.active != 0)" : "";

  return `
    SELECT
      m.id,
      m.session_id,
      m.role,
      m.content,
      ${messageColumns.has("tool_call_id") ? "m.tool_call_id" : "NULL"} AS tool_call_id,
      ${messageColumns.has("tool_calls") ? "m.tool_calls" : "NULL"} AS tool_calls,
      ${messageColumns.has("tool_name") ? "m.tool_name" : "NULL"} AS tool_name,
      m.timestamp,
      ${messageColumns.has("platform_message_id") ? "m.platform_message_id" : "NULL"} AS platform_message_id,
      ${joinSessions ? "s.cwd" : "NULL"} AS cwd
    FROM messages m
    ${joinSessions ? "LEFT JOIN sessions s ON s.id = m.session_id" : ""}
    WHERE ((m.content IS NOT NULL AND m.content != '')
      ${messageColumns.has("tool_calls") ? "OR (m.tool_calls IS NOT NULL AND m.tool_calls != '')" : ""})
      ${activeFilter}
    ORDER BY m.session_id ASC, m.timestamp ASC, m.id ASC
  `;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll("\"", "\"\"")}"`;
}
