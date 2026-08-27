CREATE TABLE IF NOT EXISTS account_agent_source_scan_jobs (
  uuid       TEXT NOT NULL REFERENCES cloud_accounts(uuid) ON DELETE CASCADE,
  job_id     TEXT NOT NULL,
  source_id  TEXT NOT NULL,
  mode       TEXT CHECK(mode IN ('initial_subset','incremental','full')),
  phase      TEXT NOT NULL CHECK(phase IN ('add','summarize')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (uuid, job_id)
);

CREATE TABLE IF NOT EXISTS account_agent_source_scan_source_state (
  uuid                 TEXT NOT NULL REFERENCES cloud_accounts(uuid) ON DELETE CASCADE,
  job_id               TEXT NOT NULL,
  source_id            TEXT NOT NULL,
  scan_mode            TEXT CHECK(scan_mode IN ('initial_subset','incremental','full')),
  scan_started_at      TEXT,
  watermarked_since    TEXT,
  conversation_ids_json TEXT NOT NULL,
  errors_json          TEXT NOT NULL,
  source_order         INTEGER NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (uuid, job_id, source_id),
  FOREIGN KEY (uuid, job_id) REFERENCES account_agent_source_scan_jobs(uuid, job_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS account_agent_source_scan_messages (
  uuid           TEXT NOT NULL REFERENCES cloud_accounts(uuid) ON DELETE CASCADE,
  job_id         TEXT NOT NULL,
  source_id      TEXT NOT NULL,
  message_order  INTEGER NOT NULL,
  message_id     TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  role           TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
  content        TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  workspace_path TEXT,
  git_root       TEXT,
  raw_meta_json  TEXT NOT NULL,
  PRIMARY KEY (uuid, job_id, source_id, message_order),
  FOREIGN KEY (uuid, job_id, source_id)
    REFERENCES account_agent_source_scan_source_state(uuid, job_id, source_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_account_agent_source_scan_messages_source
  ON account_agent_source_scan_messages(uuid, job_id, source_id, message_order);

CREATE TABLE IF NOT EXISTS account_agent_source_scan_results (
  uuid                     TEXT NOT NULL REFERENCES cloud_accounts(uuid) ON DELETE CASCADE,
  job_id                   TEXT NOT NULL,
  source_id                TEXT NOT NULL,
  result_order             INTEGER NOT NULL,
  discovered_conversations INTEGER NOT NULL,
  emitted_messages         INTEGER NOT NULL,
  skipped                  INTEGER NOT NULL,
  errors_json              TEXT NOT NULL,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (uuid, job_id, source_id),
  FOREIGN KEY (uuid, job_id) REFERENCES account_agent_source_scan_jobs(uuid, job_id) ON DELETE CASCADE
);
