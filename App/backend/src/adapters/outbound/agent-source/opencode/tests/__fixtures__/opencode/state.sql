CREATE TABLE session (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  directory TEXT NOT NULL,
  title TEXT NOT NULL,
  agent TEXT,
  time_created INTEGER NOT NULL
);

CREATE TABLE message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  data TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES session(id)
);

CREATE TABLE part (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  data TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES message(id)
);

INSERT INTO session (id, parent_id, directory, title, agent, time_created)
VALUES ('opencode-db-session-1', NULL, '$WORKSPACE_PATH', 'Real schema fixture', 'build', 1780305733388);

-- A subagent session is its own conversation and is never staged.
INSERT INTO session (id, parent_id, directory, title, agent, time_created)
VALUES ('opencode-db-subagent', 'opencode-db-session-1', '$WORKSPACE_PATH', 'Subagent', 'build', 1780305733400);

-- Memmy replaces the typed question with a recall packet, so the reader has to unwrap it.
INSERT INTO message (id, session_id, time_created, time_updated, data)
VALUES (
  'opencode-db-message-user',
  'opencode-db-session-1',
  1780305834748,
  1780305834748,
  '{"role":"user","agent":"build","time":{"created":1780305834748}}'
);

INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
VALUES (
  'opencode-db-part-user',
  'opencode-db-message-user',
  'opencode-db-session-1',
  1780305834757,
  1780305834757,
  '{"type":"text","text":"<memmy_memory_context source=\"turn_start\">recalled</memmy_memory_context>\n<current_user_request>\nPlease remember OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN\n</current_user_request>"}'
);

INSERT INTO message (id, session_id, time_created, time_updated, data)
VALUES (
  'opencode-db-message-tools',
  'opencode-db-session-1',
  1780305834760,
  1780305834760,
  '{"role":"assistant","agent":"build","parentID":"opencode-db-message-user","time":{"created":1780305834760,"completed":1780305834765}}'
);

INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
VALUES (
  'opencode-db-part-tool',
  'opencode-db-message-tools',
  'opencode-db-session-1',
  1780305834762,
  1780305834762,
  '{"type":"tool","callID":"toolu_read_1","tool":"read","state":{"status":"completed","input":{"filePath":"tmp.md"},"output":"file body"}}'
);

INSERT INTO message (id, session_id, time_created, time_updated, data)
VALUES (
  'opencode-db-message-assistant',
  'opencode-db-session-1',
  1780305834768,
  1780305834768,
  '{"role":"assistant","agent":"build","parentID":"opencode-db-message-user","finish":"stop","time":{"created":1780305834768,"completed":1780305834777}}'
);

INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
VALUES (
  'opencode-db-part-assistant',
  'opencode-db-message-assistant',
  'opencode-db-session-1',
  1780305834777,
  1780305834777,
  '{"type":"text","text":"Done from Opencode SQLite"}'
);

-- An assistant carrying only step bookkeeping is idle output, not part of the answer.
INSERT INTO message (id, session_id, time_created, time_updated, data)
VALUES (
  'opencode-db-message-idle',
  'opencode-db-session-1',
  1780305834780,
  1780305834780,
  '{"role":"assistant","agent":"build","parentID":"opencode-db-message-user","time":{"created":1780305834780,"completed":1780305834781}}'
);

INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
VALUES (
  'opencode-db-part-idle',
  'opencode-db-message-idle',
  'opencode-db-session-1',
  1780305834781,
  1780305834781,
  '{"type":"step-finish","finish":"unknown"}'
);

-- Compaction inserts a synthetic user row and a summary assistant. Neither is a turn.
INSERT INTO message (id, session_id, time_created, time_updated, data)
VALUES (
  'opencode-db-message-compaction',
  'opencode-db-session-1',
  1780305834790,
  1780305834790,
  '{"role":"user","agent":"build","time":{"created":1780305834790}}'
);

INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
VALUES (
  'opencode-db-part-compaction',
  'opencode-db-message-compaction',
  'opencode-db-session-1',
  1780305834790,
  1780305834790,
  '{"type":"compaction","auto":false,"tail_start_id":"opencode-db-message-assistant"}'
);

INSERT INTO message (id, session_id, time_created, time_updated, data)
VALUES (
  'opencode-db-message-summary',
  'opencode-db-session-1',
  1780305834795,
  1780305834795,
  '{"role":"assistant","agent":"compaction","summary":true,"parentID":"opencode-db-message-compaction","time":{"created":1780305834795,"completed":1780305834796}}'
);

INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
VALUES (
  'opencode-db-part-summary',
  'opencode-db-message-summary',
  'opencode-db-session-1',
  1780305834796,
  1780305834796,
  '{"type":"text","text":"Conversation summary so far"}'
);

-- A question OpenCode has not answered yet stays unwritten for the scan to fill in.
INSERT INTO message (id, session_id, time_created, time_updated, data)
VALUES (
  'opencode-db-message-unanswered',
  'opencode-db-session-1',
  1780305834800,
  1780305834800,
  '{"role":"user","agent":"build","time":{"created":1780305834800}}'
);

INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
VALUES (
  'opencode-db-part-unanswered',
  'opencode-db-message-unanswered',
  'opencode-db-session-1',
  1780305834800,
  1780305834800,
  '{"type":"text","text":"still thinking?"}'
);

INSERT INTO message (id, session_id, time_created, time_updated, data)
VALUES (
  'opencode-db-message-subagent-user',
  'opencode-db-subagent',
  1780305834810,
  1780305834810,
  '{"role":"user","agent":"build","time":{"created":1780305834810}}'
);

INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
VALUES (
  'opencode-db-part-subagent-user',
  'opencode-db-message-subagent-user',
  'opencode-db-subagent',
  1780305834810,
  1780305834810,
  '{"type":"text","text":"subagent question"}'
);
