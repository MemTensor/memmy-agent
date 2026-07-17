/** Agent source scan journal repository module. */
import type { AgentSourceScanMode, ScanResult } from "@memmy/local-api-contracts";
import type { DatabaseSync } from "node:sqlite";

const AGENT_SOURCE_SCOPE_UUID = "local-agent-sources";

export interface JournalConversationMessage {
  messageId: string;
  sourceId: string;
  conversationId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  createdAt: string;
  workspacePath: string | null;
  gitRoot: string | null;
  rawMeta: Readonly<Record<string, unknown>>;
}

export interface JournalCollectedSourceScan {
  sourceId: string;
  scanMode?: AgentSourceScanMode;
  scanStartedAt?: string;
  watermarkedSince?: string;
  conversationIds: string[];
  messages: JournalConversationMessage[];
  errors: Array<{ conversationId: string; reason: string }>;
}

export type JournalScanResumeState =
  | {
    phase: "add";
    collected: JournalCollectedSourceScan[];
  }
  | {
    phase: "summarize";
    results: ScanResult[];
  };

export interface WriteScanResumeInput {
  jobId: string;
  sourceId: string;
  mode?: AgentSourceScanMode;
  resume: JournalScanResumeState;
}

export interface AgentSourceScanJournal {
  writeResume(input: WriteScanResumeInput): void;
  readResume(jobId: string): JournalScanResumeState | null;
  deleteJob(jobId: string): void;
}

interface SourceStateRow {
  source_id: string;
  scan_mode: AgentSourceScanMode | null;
  scan_started_at: string | null;
  watermarked_since: string | null;
  conversation_ids_json: string;
  errors_json: string;
}

interface MessageRow {
  message_id: string;
  conversation_id: string;
  role: JournalConversationMessage["role"];
  content: string;
  created_at: string;
  workspace_path: string | null;
  git_root: string | null;
  raw_meta_json: string;
}

interface ResultRow {
  source_id: string;
  discovered_conversations: number;
  emitted_messages: number;
  skipped: number;
  errors_json: string;
}

interface JobRow {
  phase: JournalScanResumeState["phase"];
}

/** Creates create agent source scan journal. */
export function createAgentSourceScanJournal(db: DatabaseSync): AgentSourceScanJournal {
  ensureAgentSourceScope(db);

  return {
    writeResume(input) {
      db.exec("BEGIN");
      try {
        deleteJobRows(db, input.jobId);
        upsertJob(db, input);
        if (input.resume.phase === "add") {
          writeCollectedSources(db, input.jobId, input.resume.collected);
        } else {
          writeResults(db, input.jobId, input.resume.results);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    readResume(jobId) {
      const job = db.prepare(`
        SELECT phase
        FROM account_agent_source_scan_jobs
        WHERE uuid = ? AND job_id = ?
      `).get(AGENT_SOURCE_SCOPE_UUID, jobId) as JobRow | undefined;
      if (!job) {
        return null;
      }

      return job.phase === "add"
        ? { phase: "add", collected: readCollectedSources(db, jobId) }
        : { phase: "summarize", results: readResults(db, jobId) };
    },

    deleteJob(jobId) {
      deleteJobRows(db, jobId);
    }
  };
}

function ensureAgentSourceScope(db: DatabaseSync): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO cloud_accounts (
      uuid,
      created_at,
      updated_at
    ) VALUES (?, ?, ?)`
  ).run(AGENT_SOURCE_SCOPE_UUID, now, now);
}

function upsertJob(db: DatabaseSync, input: WriteScanResumeInput): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO account_agent_source_scan_jobs (
      uuid,
      job_id,
      source_id,
      mode,
      phase,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    AGENT_SOURCE_SCOPE_UUID,
    input.jobId,
    input.sourceId,
    input.mode ?? null,
    input.resume.phase,
    now,
    now
  );
}

function writeCollectedSources(db: DatabaseSync, jobId: string, collected: readonly JournalCollectedSourceScan[]): void {
  const insertSource = db.prepare(`
    INSERT INTO account_agent_source_scan_source_state (
      uuid,
      job_id,
      source_id,
      scan_mode,
      scan_started_at,
      watermarked_since,
      conversation_ids_json,
      errors_json,
      source_order,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMessage = db.prepare(`
    INSERT INTO account_agent_source_scan_messages (
      uuid,
      job_id,
      source_id,
      message_order,
      message_id,
      conversation_id,
      role,
      content,
      created_at,
      workspace_path,
      git_root,
      raw_meta_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();

  for (const [sourceIndex, source] of collected.entries()) {
    insertSource.run(
      AGENT_SOURCE_SCOPE_UUID,
      jobId,
      source.sourceId,
      source.scanMode ?? null,
      source.scanStartedAt ?? null,
      source.watermarkedSince ?? null,
      JSON.stringify(source.conversationIds),
      JSON.stringify(source.errors),
      sourceIndex,
      now
    );

    for (const [messageIndex, message] of source.messages.entries()) {
      insertMessage.run(
        AGENT_SOURCE_SCOPE_UUID,
        jobId,
        source.sourceId,
        messageIndex,
        message.messageId,
        message.conversationId,
        message.role,
        message.content,
        message.createdAt,
        message.workspacePath,
        message.gitRoot,
        JSON.stringify(message.rawMeta)
      );
    }
  }
}

function writeResults(db: DatabaseSync, jobId: string, results: readonly ScanResult[]): void {
  const insertResult = db.prepare(`
    INSERT INTO account_agent_source_scan_results (
      uuid,
      job_id,
      source_id,
      result_order,
      discovered_conversations,
      emitted_messages,
      skipped,
      errors_json,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();

  for (const [resultIndex, result] of results.entries()) {
    insertResult.run(
      AGENT_SOURCE_SCOPE_UUID,
      jobId,
      result.sourceId,
      resultIndex,
      result.discoveredConversations,
      result.emittedMessages,
      result.skipped,
      JSON.stringify(result.errors),
      now
    );
  }
}

function readCollectedSources(db: DatabaseSync, jobId: string): JournalCollectedSourceScan[] {
  const sourceRows = db.prepare(`
    SELECT
      source_id,
      scan_mode,
      scan_started_at,
      watermarked_since,
      conversation_ids_json,
      errors_json
    FROM account_agent_source_scan_source_state
    WHERE uuid = ? AND job_id = ?
    ORDER BY source_order ASC
  `).all(AGENT_SOURCE_SCOPE_UUID, jobId) as unknown as SourceStateRow[];

  return sourceRows.map((row) => ({
    sourceId: row.source_id,
    scanMode: row.scan_mode ?? undefined,
    scanStartedAt: row.scan_started_at ?? undefined,
    watermarkedSince: row.watermarked_since ?? undefined,
    conversationIds: parseJsonArray<string>(row.conversation_ids_json),
    messages: readSourceMessages(db, jobId, row.source_id),
    errors: parseJsonArray<{ conversationId: string; reason: string }>(row.errors_json)
  }));
}

function readSourceMessages(db: DatabaseSync, jobId: string, sourceId: string): JournalConversationMessage[] {
  const rows = db.prepare(`
    SELECT
      message_id,
      conversation_id,
      role,
      content,
      created_at,
      workspace_path,
      git_root,
      raw_meta_json
    FROM account_agent_source_scan_messages
    WHERE uuid = ? AND job_id = ? AND source_id = ?
    ORDER BY message_order ASC
  `).all(AGENT_SOURCE_SCOPE_UUID, jobId, sourceId) as unknown as MessageRow[];

  return rows.map((row) => ({
    messageId: row.message_id,
    sourceId,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    workspacePath: row.workspace_path,
    gitRoot: row.git_root,
    rawMeta: Object.freeze(parseRecord(row.raw_meta_json))
  }));
}

function readResults(db: DatabaseSync, jobId: string): ScanResult[] {
  const rows = db.prepare(`
    SELECT
      source_id,
      discovered_conversations,
      emitted_messages,
      skipped,
      errors_json
    FROM account_agent_source_scan_results
    WHERE uuid = ? AND job_id = ?
    ORDER BY result_order ASC
  `).all(AGENT_SOURCE_SCOPE_UUID, jobId) as unknown as ResultRow[];

  return rows.map((row) => ({
    sourceId: row.source_id,
    discoveredConversations: row.discovered_conversations,
    emittedMessages: row.emitted_messages,
    skipped: row.skipped,
    errors: parseJsonArray<{ conversationId: string; reason: string }>(row.errors_json)
  }));
}

function deleteJobRows(db: DatabaseSync, jobId: string): void {
  db.prepare("DELETE FROM account_agent_source_scan_messages WHERE uuid = ? AND job_id = ?").run(AGENT_SOURCE_SCOPE_UUID, jobId);
  db.prepare("DELETE FROM account_agent_source_scan_source_state WHERE uuid = ? AND job_id = ?").run(AGENT_SOURCE_SCOPE_UUID, jobId);
  db.prepare("DELETE FROM account_agent_source_scan_results WHERE uuid = ? AND job_id = ?").run(AGENT_SOURCE_SCOPE_UUID, jobId);
  db.prepare("DELETE FROM account_agent_source_scan_jobs WHERE uuid = ? AND job_id = ?").run(AGENT_SOURCE_SCOPE_UUID, jobId);
}

function parseJsonArray<T>(value: string): T[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed as T[] : [];
}

function parseRecord(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}
