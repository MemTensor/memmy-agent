CREATE TABLE IF NOT EXISTS app_settings (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  user_mode TEXT NOT NULL DEFAULT 'unset'
    CHECK (user_mode IN ('unset', 'byok', 'account')),
  language TEXT NOT NULL DEFAULT 'system'
    CHECK (language IN ('system', 'zh-CN', 'en-US')),
  theme TEXT NOT NULL DEFAULT 'system'
    CHECK (theme IN ('system', 'light', 'dark')),
  auto_update_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS onboarding_state (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS privacy_settings (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  telemetry_opt_in INTEGER NOT NULL DEFAULT 0,
  crash_report_opt_in INTEGER NOT NULL DEFAULT 0,
  allow_memory_improvement_upload INTEGER NOT NULL DEFAULT 0,
  local_only_mode INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS token_usage_cache (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  plan_name TEXT NOT NULL DEFAULT '体验 Token',
  total_tokens INTEGER NOT NULL DEFAULT 30000000,
  used_tokens INTEGER NOT NULL DEFAULT 0,
  remaining_tokens INTEGER NOT NULL DEFAULT 30000000,
  expires_at TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO app_settings (id, created_at, updated_at)
VALUES ('default', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT OR IGNORE INTO onboarding_state (id, created_at, updated_at)
VALUES ('default', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT OR IGNORE INTO privacy_settings (id, created_at, updated_at)
VALUES ('default', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT OR IGNORE INTO token_usage_cache (id, created_at, updated_at)
VALUES ('default', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
