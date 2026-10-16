import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { ConversationCheckpoint, ConversationMessage } from "@memmy/agent-source-core";

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
  const saveCheckpoints = db.transaction((values: Iterable<ConversationCheckpoint>) => {
    for (const value of values) checkpoint.run(value.sourceId, value.conversationId,
      value.lastMessageId, value.lastCreatedAt, value.contentHash, value.updatedAt);
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
    saveCheckpoints,
    messageCount(sourceId: string): number {
      return (db.prepare("SELECT COUNT(*) AS count FROM messages WHERE source_id=?")
        .get(sourceId) as { count: number }).count;
    },
    close(): void { db.close(); }
  };
}

export type SourceCheckpoints = ReturnType<typeof openSourceCheckpoints>;
