CREATE TABLE IF NOT EXISTS cloud_accounts (
  uuid TEXT PRIMARY KEY,
  user_id TEXT,
  email TEXT,
  phone TEXT,
  nickname TEXT,
  avatar_url TEXT,
  plan_type TEXT,
  has_finished_guide INTEGER,
  region TEXT,
  registered_at TEXT,
  cloud_uuid_ref TEXT,
  raw_profile_json TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS verification_code_throttle (
  throttle_key TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'phone')),
  identifier_hash TEXT NOT NULL,
  last_code_sent_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS account_onboarding_state (
  uuid TEXT PRIMARY KEY REFERENCES cloud_accounts(uuid) ON DELETE CASCADE,
  completed INTEGER NOT NULL DEFAULT 0,
  current_step TEXT NOT NULL DEFAULT 'scan_permission_required'
    CHECK (current_step IN (
      'byok_setup_required',
      'account_auth_required',
      'scan_permission_required',
      'improvement_program_required',
      'product_tour_required',
      'completed'
    )),
  has_accepted_terms INTEGER NOT NULL DEFAULT 0,
  accepted_terms_version TEXT,
  scan_permission TEXT NOT NULL DEFAULT 'unset'
    CHECK (scan_permission IN ('unset', 'none', 'scan_only', 'scan_and_write_skill')),
  improvement_program TEXT NOT NULL DEFAULT 'unset'
    CHECK (improvement_program IN ('unset', 'accepted', 'declined', 'not_applicable')),
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS account_privacy_settings (
  uuid TEXT PRIMARY KEY REFERENCES cloud_accounts(uuid) ON DELETE CASCADE,
  telemetry_opt_in INTEGER NOT NULL DEFAULT 0,
  crash_report_opt_in INTEGER NOT NULL DEFAULT 0,
  allow_memory_improvement_upload INTEGER NOT NULL DEFAULT 0,
  local_only_mode INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS account_token_usage_cache (
  uuid TEXT PRIMARY KEY REFERENCES cloud_accounts(uuid) ON DELETE CASCADE,
  plan_name TEXT NOT NULL DEFAULT '体验 Token',
  total_tokens INTEGER NOT NULL DEFAULT 30000000,
  used_tokens INTEGER NOT NULL DEFAULT 0,
  remaining_tokens INTEGER NOT NULL DEFAULT 30000000,
  expires_at TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS account_model_config (
  uuid TEXT PRIMARY KEY REFERENCES cloud_accounts(uuid) ON DELETE CASCADE,
  provider TEXT NOT NULL
    CHECK (provider IN (
      'openai_compatible',
      'anthropic',
      'google',
      'deepseek',
      'zhipu',
      'qwen',
      'kimi',
      'minimax',
      'baidu',
      'doubao'
    )),
  base_url TEXT NOT NULL,
  model_id TEXT NOT NULL,
  api_key_ref TEXT,
  embedding_mode TEXT NOT NULL DEFAULT 'disabled'
    CHECK (embedding_mode IN ('disabled', 'same', 'separate')),
  embedding_base_url TEXT,
  embedding_model_id TEXT,
  embedding_api_key_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS account_agent_sources (
  uuid TEXT NOT NULL REFERENCES cloud_accounts(uuid) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  data_path TEXT NOT NULL,
  builtin INTEGER NOT NULL CHECK(builtin IN (0,1)),
  status TEXT NOT NULL DEFAULT 'not_connected'
    CHECK(status IN ('not_connected','skill_installed','plugin_installed')),
  last_scanned_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (uuid, source_id)
);

CREATE TABLE IF NOT EXISTS account_ingestion_seen (
  uuid TEXT NOT NULL REFERENCES cloud_accounts(uuid) ON DELETE CASCADE,
  dedup_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (uuid, dedup_key)
);

CREATE INDEX IF NOT EXISTS idx_account_ingestion_seen_source
  ON account_ingestion_seen(uuid, source_id);

CREATE TABLE IF NOT EXISTS account_idempotency_keys (
  uuid TEXT NOT NULL REFERENCES cloud_accounts(uuid) ON DELETE CASCADE,
  adapter_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (uuid, adapter_id, request_id)
);

CREATE INDEX IF NOT EXISTS idx_account_idempotency_created
  ON account_idempotency_keys(uuid, created_at);

ALTER TABLE app_settings
  ADD COLUMN active_uuid TEXT REFERENCES cloud_accounts(uuid);

ALTER TABLE secret_store
  ADD COLUMN uuid TEXT;

ALTER TABLE secret_store
  ADD COLUMN purpose TEXT;

CREATE INDEX IF NOT EXISTS idx_secret_store_uuid_purpose
  ON secret_store(uuid, purpose);
