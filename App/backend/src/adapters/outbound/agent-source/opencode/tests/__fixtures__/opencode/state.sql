CREATE TABLE session (
  id TEXT PRIMARY KEY,
  directory TEXT NOT NULL,
  title TEXT NOT NULL,
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

INSERT INTO session (id, directory, title, time_created)
VALUES ('opencode-db-session-1', '$WORKSPACE_PATH', 'Real schema fixture', 1780305733388);

INSERT INTO message (id, session_id, time_created, time_updated, data)
VALUES (
  'opencode-db-message-user',
  'opencode-db-session-1',
  1780305834748,
  1780305834748,
  '{"role":"user","time":{"created":1780305834748},"path":{"cwd":"$WORKSPACE_PATH","root":"$WORKSPACE_PATH"}}'
);

INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
VALUES (
  'opencode-db-part-user',
  'opencode-db-message-user',
  'opencode-db-session-1',
  1780305834757,
  1780305834757,
  '{"type":"text","text":"Please remember OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN"}'
);

INSERT INTO message (id, session_id, time_created, time_updated, data)
VALUES (
  'opencode-db-message-assistant',
  'opencode-db-session-1',
  1780305834768,
  1780305834768,
  '{"role":"assistant","time":{"created":1780305834768},"path":{"cwd":"$WORKSPACE_PATH","root":"$WORKSPACE_PATH"}}'
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

INSERT INTO message (id, session_id, time_created, time_updated, data)
VALUES (
  'opencode-db-message-tool',
  'opencode-db-session-1',
  1780305834788,
  1780305834788,
  '{"role":"tool","time":{"created":1780305834788}}'
);

INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
VALUES (
  'opencode-db-part-tool',
  'opencode-db-message-tool',
  'opencode-db-session-1',
  1780305834788,
  1780305834788,
  '{"type":"text","text":"ignored tool output"}'
);
