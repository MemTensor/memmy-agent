CREATE TABLE project_memory_bindings (
  binding_id INTEGER PRIMARY KEY AUTOINCREMENT,
  account TEXT NOT NULL, project TEXT NOT NULL, kind TEXT NOT NULL, location TEXT NOT NULL,
  UNIQUE(account, project, kind, location)
);
CREATE TABLE project_memory_sessions (
  account TEXT NOT NULL, source TEXT NOT NULL, conversation TEXT NOT NULL,
  workspace TEXT, folder TEXT, needs_index INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(account, source, conversation)
);
CREATE TABLE project_memory_turns (
  account TEXT NOT NULL, source TEXT NOT NULL, conversation TEXT NOT NULL, turn TEXT NOT NULL,
  bindings TEXT NOT NULL, started TEXT NOT NULL, completed TEXT,
  PRIMARY KEY(account, source, conversation, turn)
);
CREATE TABLE project_memory_submissions (
  account TEXT NOT NULL, submission TEXT NOT NULL, project TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL,
  request TEXT, retry_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(account, submission, project)
);
CREATE INDEX project_memory_retry ON project_memory_submissions(account,retry_at) WHERE retry_at IS NOT NULL;
CREATE TABLE project_memory_cache (
  account TEXT NOT NULL, project TEXT NOT NULL, memory TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY(account, project, memory)
);
CREATE TRIGGER project_memory_account_changed AFTER UPDATE OF active_uuid ON app_settings
WHEN OLD.active_uuid IS NOT NEW.active_uuid BEGIN
  UPDATE project_memory_submissions SET request=NULL,retry_at=NULL WHERE account=OLD.active_uuid;
  DELETE FROM project_memory_cache WHERE account = OLD.active_uuid;
  DELETE FROM project_memory_turns WHERE account = OLD.active_uuid;
  DELETE FROM project_memory_sessions WHERE account = OLD.active_uuid;
END;
