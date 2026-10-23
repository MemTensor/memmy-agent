import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { setImmediate as yieldEventLoop } from "node:timers/promises";
import Database from "better-sqlite3";
import type { ConversationCheckpoint, ConversationMessage } from "@memmy/agent-source-core";
import type { MemoryAgentSourceScanStore } from "./scan-store.js";

/** Source-wide progress survives individual job cleanup, cancellation and retries. */
export function openSourceCheckpoints(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (source_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS messages (
      source_id TEXT NOT NULL, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
      PRIMARY KEY (source_id, conversation_id, message_id)
    );
    CREATE TABLE IF NOT EXISTS conversations (
      source_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      last_message_id TEXT NOT NULL, last_created_at TEXT NOT NULL,
      content_hash TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (source_id, conversation_id)
    );
  `);
  const seen = db.prepare("INSERT OR IGNORE INTO messages VALUES (?, ?, ?)");
  const markMessages = db.transaction((messages: readonly ConversationMessage[]) => {
    for (const message of messages) seen.run(message.sourceId, message.conversationId, message.messageId);
  });
  const checkpoint = db.prepare(`INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id, conversation_id) DO UPDATE SET
      last_message_id=excluded.last_message_id, last_created_at=excluded.last_created_at,
      content_hash=excluded.content_hash, updated_at=excluded.updated_at`);
  const saveCheckpointBatch = db.transaction((values: readonly ConversationCheckpoint[]) => {
    const startedAt = performance.now();
    let written = 0;
    for (const value of values) {
      checkpoint.run(value.sourceId, value.conversationId,
        value.lastMessageId, value.lastCreatedAt, value.contentHash, value.updatedAt);
      written += 1;
      // Cooperative budget: a single synchronous write/commit can still take longer.
      if (written >= 100 || performance.now() - startedAt >= 16) break;
    }
    return written;
  });
  return {
    hasSource(sourceId: string): boolean {
      return Boolean(db.prepare("SELECT 1 FROM sources WHERE source_id=?").get(sourceId));
    },
    initializeSource(sourceId: string): void {
      db.prepare("INSERT OR IGNORE INTO sources VALUES (?)").run(sourceId);
    },
    getCheckpoint(sourceId: string, conversationId: string): ConversationCheckpoint | null {
      return db.prepare(`SELECT source_id AS sourceId, conversation_id AS conversationId,
        last_message_id AS lastMessageId, last_created_at AS lastCreatedAt,
        content_hash AS contentHash, updated_at AS updatedAt
        FROM conversations WHERE source_id=? AND conversation_id=?`)
        .get(sourceId, conversationId) as ConversationCheckpoint | undefined ?? null;
    },
    markMessages,
    saveCheckpointBatch,
    messageCount(sourceId: string): number {
      return (db.prepare("SELECT COUNT(*) AS count FROM messages WHERE source_id=?")
        .get(sourceId) as { count: number }).count;
    },
    close(): void { db.close(); }
  };
}

export type SourceCheckpoints = ReturnType<typeof openSourceCheckpoints>;

/** Call only after raw records and required background jobs are durable for this source. */
export async function publishSourceCheckpoints(
  store: Pick<MemoryAgentSourceScanStore, "checkpointPage">,
  checkpoints: Pick<SourceCheckpoints, "saveCheckpointBatch">,
  sourceId: string,
  cooperate: () => Promise<void>
): Promise<void> {
  let cursor: string | undefined;
  while (true) {
    // Always yield, including before the first batch and after the last commit.
    // The runtime's unit counter counts calls, not rows in a checkpoint batch.
    await yieldEventLoop();
    await cooperate();
    const page = store.checkpointPage(sourceId, cursor);
    if (page.length === 0) return;
    const written = checkpoints.saveCheckpointBatch(page);
    cursor = page[written - 1]!.conversationId;
  }
}
