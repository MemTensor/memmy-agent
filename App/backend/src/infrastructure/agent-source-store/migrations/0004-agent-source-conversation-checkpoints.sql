CREATE TABLE IF NOT EXISTS account_agent_source_conversation_checkpoints (
  uuid            TEXT NOT NULL REFERENCES cloud_accounts(uuid) ON DELETE CASCADE,
  source_id       TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  last_message_id TEXT NOT NULL,
  last_created_at TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (uuid, source_id, conversation_id),
  FOREIGN KEY (uuid, source_id) REFERENCES account_agent_sources(uuid, source_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_source_conversation_checkpoints_time
  ON account_agent_source_conversation_checkpoints(uuid, source_id, last_created_at);
