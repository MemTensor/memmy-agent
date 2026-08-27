CREATE TABLE IF NOT EXISTS account_agent_source_watermarks (
  uuid                   TEXT NOT NULL REFERENCES cloud_accounts(uuid) ON DELETE CASCADE,
  source_id              TEXT NOT NULL,
  mode                   TEXT NOT NULL CHECK(mode IN ('initial_subset','incremental','full')),
  baseline_at            TEXT,
  latest_seen_created_at TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (uuid, source_id),
  FOREIGN KEY (uuid, source_id) REFERENCES account_agent_sources(uuid, source_id) ON DELETE CASCADE
);
