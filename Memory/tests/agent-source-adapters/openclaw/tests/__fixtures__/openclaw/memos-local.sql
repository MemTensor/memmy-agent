CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'paragraph',
  summary TEXT NOT NULL DEFAULT '',
  task_id TEXT,
  owner TEXT NOT NULL DEFAULT 'agent:main',
  dedup_status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO chunks (
  id,
  session_key,
  turn_id,
  seq,
  role,
  content,
  kind,
  summary,
  task_id,
  owner,
  dedup_status,
  created_at,
  updated_at
) VALUES (
  'chunk-user-1',
  'openclaw-session-1',
  'turn-1',
  0,
  'user',
  'Remember OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN from OpenClaw',
  'paragraph',
  'User asked OpenClaw to remember a secret',
  'task-1',
  'agent:main',
  'active',
  CAST(strftime('%s', '2026-06-02T10:10:01Z') AS INTEGER) * 1000,
  CAST(strftime('%s', '2026-06-02T10:10:01Z') AS INTEGER) * 1000
);

INSERT INTO chunks (
  id,
  session_key,
  turn_id,
  seq,
  role,
  content,
  kind,
  summary,
  task_id,
  owner,
  dedup_status,
  created_at,
  updated_at
) VALUES (
  'chunk-assistant-1',
  'openclaw-session-1',
  'turn-1',
  1,
  'assistant',
  'Stored from OpenClaw memory plugin',
  'paragraph',
  'Assistant confirmed storage',
  'task-1',
  'agent:main',
  'active',
  CAST(strftime('%s', '2026-06-02T10:10:02Z') AS INTEGER) * 1000,
  CAST(strftime('%s', '2026-06-02T10:10:02Z') AS INTEGER) * 1000
);

INSERT INTO chunks (
  id,
  session_key,
  turn_id,
  seq,
  role,
  content,
  kind,
  summary,
  task_id,
  owner,
  dedup_status,
  created_at,
  updated_at
) VALUES (
  'chunk-tool-1',
  'openclaw-session-1',
  'turn-1',
  2,
  'tool',
  'External tool output captured by OpenClaw',
  'tool_result',
  'Tool result',
  'task-1',
  'agent:main',
  'active',
  CAST(strftime('%s', '2026-06-02T10:10:03Z') AS INTEGER) * 1000,
  CAST(strftime('%s', '2026-06-02T10:10:03Z') AS INTEGER) * 1000
);

INSERT INTO chunks (
  id,
  session_key,
  turn_id,
  seq,
  role,
  content,
  kind,
  summary,
  task_id,
  owner,
  dedup_status,
  created_at,
  updated_at
) VALUES (
  'chunk-duplicate-1',
  'openclaw-session-1',
  'turn-1',
  3,
  'assistant',
  'Duplicate OpenClaw chunk should not be emitted',
  'paragraph',
  'Duplicate',
  'task-1',
  'agent:main',
  'duplicate',
  CAST(strftime('%s', '2026-06-02T10:10:04Z') AS INTEGER) * 1000,
  CAST(strftime('%s', '2026-06-02T10:10:04Z') AS INTEGER) * 1000
);
