CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  workspace_path TEXT,
  git_root TEXT,
  created_at TEXT
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

INSERT INTO conversations (id, workspace_path, git_root, created_at)
VALUES ('openclaw-conversation-1', '$WORKSPACE_PATH', '$WORKSPACE_PATH', '2026-06-02T10:00:00.000Z');

INSERT INTO messages (id, conversation_id, role, content, created_at)
VALUES (
  'openclaw-message-1',
  'openclaw-conversation-1',
  'user',
  'Please remember OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN',
  '2026-06-02T10:00:01.000Z'
);

INSERT INTO messages (id, conversation_id, role, content, created_at)
VALUES (
  'openclaw-message-ignored',
  'openclaw-conversation-1',
  'tool',
  'ignored tool output',
  '2026-06-02T10:00:02.000Z'
);

INSERT INTO messages (id, conversation_id, role, content, created_at)
VALUES (
  'openclaw-message-2',
  'openclaw-conversation-1',
  'assistant',
  'Done from OpenClaw',
  '2026-06-02T10:00:03.000Z'
);
