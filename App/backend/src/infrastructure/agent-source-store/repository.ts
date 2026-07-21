/** Repository module. */
import type { AgentSourceScanMode, AgentSourceStatus } from "@memmy/local-api-contracts";
import type { DatabaseSync } from "node:sqlite";

const AGENT_SOURCE_SCOPE_UUID = "local-agent-sources";

/** Contract for agent source record. */
export interface AgentSourceRecord {
  sourceId: string;
  displayName: string;
  dataPath: string;
  builtin: boolean;
  status: AgentSourceStatus;
  messageCount: number;
  lastScannedAt: string | null;
}

export interface AgentSourceScanWatermark {
  sourceId: string;
  mode: AgentSourceScanMode;
  baselineAt: string | null;
  latestSeenCreatedAt: string | null;
  updatedAt: string;
}

export interface UpsertAgentSourceScanWatermarkInput {
  sourceId: string;
  mode: AgentSourceScanMode;
  baselineAt: string | null;
  latestSeenCreatedAt: string | null;
  updatedAt: string;
}

export interface AgentSourceConversationCheckpoint {
  sourceId: string;
  conversationId: string;
  lastMessageId: string;
  lastCreatedAt: string;
  contentHash: string;
  updatedAt: string;
}

/** Contract for upsert agent source input. */
export interface UpsertAgentSourceInput {
  sourceId: string;
  displayName: string;
  dataPath: string;
  builtin: boolean;
}

/** Contract for agent source repository. */
export interface AgentSourceRepository {
  listSources(): AgentSourceRecord[];
  upsertSource(input: UpsertAgentSourceInput): void;
  removeSource(sourceId: string): void;
  setStatus(sourceId: string, status: AgentSourceStatus): void;
  setLastScannedAt(sourceId: string, scannedAt: string): void;
  getScanWatermark(sourceId: string): AgentSourceScanWatermark | null;
  upsertScanWatermark(input: UpsertAgentSourceScanWatermarkInput): void;
  getConversationCheckpoint(sourceId: string, conversationId: string): AgentSourceConversationCheckpoint | null;
  upsertConversationCheckpoint(input: AgentSourceConversationCheckpoint): void;
  hasSeen(dedupKey: string): boolean;
  markSeen(dedupKey: string, sourceId: string): boolean;
}

interface AgentSourceRow {
  source_id: string;
  display_name: string;
  data_path: string;
  builtin: 0 | 1;
  status: AgentSourceStatus;
  message_count: number;
  last_scanned_at: string | null;
}

interface AgentSourceWatermarkRow {
  source_id: string;
  mode: AgentSourceScanMode;
  baseline_at: string | null;
  latest_seen_created_at: string | null;
  updated_at: string;
}

interface AgentSourceConversationCheckpointRow {
  source_id: string;
  conversation_id: string;
  last_message_id: string;
  last_created_at: string;
  content_hash: string;
  updated_at: string;
}

/** Creates create agent source repository. */
export function createAgentSourceRepository(
  db: DatabaseSync
): AgentSourceRepository {
  ensureAgentSourceScope(db);

  return {
    listSources() {
      const rows = db
        .prepare(
          `
            SELECT
              source.source_id,
              source.display_name,
              source.data_path,
              source.builtin,
              source.status,
              source.last_scanned_at,
              COUNT(seen.dedup_key) AS message_count
            FROM account_agent_sources source
            LEFT JOIN account_ingestion_seen seen ON seen.uuid = source.uuid AND seen.source_id = source.source_id
            WHERE source.uuid = ?
            GROUP BY source.uuid, source.source_id
            ORDER BY source.builtin DESC, source.display_name ASC
          `
        )
        .all(AGENT_SOURCE_SCOPE_UUID) as unknown as AgentSourceRow[];

      return rows.map(toAgentSourceRecord);
    },

    upsertSource(input) {
      db.prepare(
        `
            INSERT INTO account_agent_sources (uuid, source_id, display_name, data_path, builtin, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(uuid, source_id) DO UPDATE SET
              display_name = excluded.display_name,
              data_path = excluded.data_path,
              builtin = excluded.builtin,
              updated_at = excluded.updated_at
          `
      ).run(AGENT_SOURCE_SCOPE_UUID, input.sourceId, input.displayName, input.dataPath, input.builtin ? 1 : 0, new Date().toISOString());
    },

    removeSource(sourceId) {
      db.prepare("DELETE FROM account_agent_sources WHERE uuid = ? AND source_id = ?").run(AGENT_SOURCE_SCOPE_UUID, sourceId);
    },

    setStatus(sourceId, status) {
      db.prepare("UPDATE account_agent_sources SET status = ?, updated_at = ? WHERE uuid = ? AND source_id = ?").run(
        status,
        new Date().toISOString(),
        AGENT_SOURCE_SCOPE_UUID,
        sourceId
      );
    },

    setLastScannedAt(sourceId, scannedAt) {
      db.prepare("UPDATE account_agent_sources SET last_scanned_at = ?, updated_at = ? WHERE uuid = ? AND source_id = ?").run(
        scannedAt,
        new Date().toISOString(),
        AGENT_SOURCE_SCOPE_UUID,
        sourceId
      );
    },

    getScanWatermark(sourceId) {
      const row = db.prepare(`
        SELECT source_id, mode, baseline_at, latest_seen_created_at, updated_at
        FROM account_agent_source_watermarks
        WHERE uuid = ? AND source_id = ?
      `).get(AGENT_SOURCE_SCOPE_UUID, sourceId) as AgentSourceWatermarkRow | undefined;
      return row ? toAgentSourceScanWatermark(row) : null;
    },

    upsertScanWatermark(input) {
      db.prepare(`
        INSERT INTO account_agent_source_watermarks (
          uuid,
          source_id,
          mode,
          baseline_at,
          latest_seen_created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(uuid, source_id) DO UPDATE SET
          mode = excluded.mode,
          baseline_at = excluded.baseline_at,
          latest_seen_created_at = excluded.latest_seen_created_at,
          updated_at = excluded.updated_at
      `).run(
        AGENT_SOURCE_SCOPE_UUID,
        input.sourceId,
        input.mode,
        input.baselineAt,
        input.latestSeenCreatedAt,
        input.updatedAt
      );
    },

    getConversationCheckpoint(sourceId, conversationId) {
      const row = db.prepare(`
        SELECT source_id, conversation_id, last_message_id, last_created_at, content_hash, updated_at
        FROM account_agent_source_conversation_checkpoints
        WHERE uuid = ? AND source_id = ? AND conversation_id = ?
      `).get(AGENT_SOURCE_SCOPE_UUID, sourceId, conversationId) as AgentSourceConversationCheckpointRow | undefined;
      return row ? toConversationCheckpoint(row) : null;
    },

    upsertConversationCheckpoint(input) {
      db.prepare(`
        INSERT INTO account_agent_source_conversation_checkpoints (
          uuid, source_id, conversation_id, last_message_id, last_created_at, content_hash, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(uuid, source_id, conversation_id) DO UPDATE SET
          last_message_id = excluded.last_message_id,
          last_created_at = excluded.last_created_at,
          content_hash = excluded.content_hash,
          updated_at = excluded.updated_at
      `).run(
        AGENT_SOURCE_SCOPE_UUID,
        input.sourceId,
        input.conversationId,
        input.lastMessageId,
        input.lastCreatedAt,
        input.contentHash,
        input.updatedAt
      );
    },

    hasSeen(dedupKey) {
      const row = db.prepare("SELECT dedup_key FROM account_ingestion_seen WHERE uuid = ? AND dedup_key = ?").get(AGENT_SOURCE_SCOPE_UUID, dedupKey);
      return Boolean(row);
    },

    markSeen(dedupKey, sourceId) {
      const result = db
        .prepare("INSERT OR IGNORE INTO account_ingestion_seen (uuid, dedup_key, source_id) VALUES (?, ?, ?)")
        .run(AGENT_SOURCE_SCOPE_UUID, dedupKey, sourceId);
      return result.changes > 0;
    }
  };
}

/** Validates ensure agent source scope. */
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

/** Handles to agent source record. */
function toAgentSourceRecord(row: AgentSourceRow): AgentSourceRecord {
  return {
    sourceId: row.source_id,
    displayName: row.display_name,
    dataPath: row.data_path,
    builtin: row.builtin === 1,
    status: row.status,
    messageCount: row.message_count,
    lastScannedAt: row.last_scanned_at
  };
}

function toAgentSourceScanWatermark(row: AgentSourceWatermarkRow): AgentSourceScanWatermark {
  return {
    sourceId: row.source_id,
    mode: row.mode,
    baselineAt: row.baseline_at,
    latestSeenCreatedAt: row.latest_seen_created_at,
    updatedAt: row.updated_at
  };
}

function toConversationCheckpoint(row: AgentSourceConversationCheckpointRow): AgentSourceConversationCheckpoint {
  return {
    sourceId: row.source_id,
    conversationId: row.conversation_id,
    lastMessageId: row.last_message_id,
    lastCreatedAt: row.last_created_at,
    contentHash: row.content_hash,
    updatedAt: row.updated_at
  };
}
