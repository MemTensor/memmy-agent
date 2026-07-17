CREATE TABLE agent_sources (
  source_id       TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  data_path       TEXT NOT NULL,
  builtin         INTEGER NOT NULL CHECK(builtin IN (0,1)),
  status          TEXT NOT NULL DEFAULT 'not_connected'
    CHECK(status IN ('not_connected','skill_installed','plugin_installed')),
  last_scanned_at TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE ingestion_seen (
  dedup_key  TEXT PRIMARY KEY,
  source_id  TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_ingestion_seen_source ON ingestion_seen(source_id);
