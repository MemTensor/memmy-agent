CREATE TABLE IF NOT EXISTS byok_token_usage_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('agent_chat', 'memory_summary', 'memory_evolution', 'embedding')),
  source TEXT NOT NULL CHECK (source IN ('agent', 'memory')),
  operation_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  total_tokens INTEGER NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  cached_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_creation_input_tokens >= 0),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  usage_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(usage_json)),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_byok_token_usage_events_created
  ON byok_token_usage_events(created_at);

CREATE INDEX IF NOT EXISTS idx_byok_token_usage_events_kind_created
  ON byok_token_usage_events(kind, created_at);

CREATE INDEX IF NOT EXISTS idx_byok_token_usage_events_source_created
  ON byok_token_usage_events(source, created_at);
