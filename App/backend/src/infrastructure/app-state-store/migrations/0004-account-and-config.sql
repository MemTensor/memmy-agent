ALTER TABLE app_settings
  ADD COLUMN default_launch_mode TEXT NOT NULL DEFAULT 'last'
    CHECK (default_launch_mode IN ('full', 'pet', 'last'));

ALTER TABLE app_settings
  ADD COLUMN avatar_id TEXT NOT NULL DEFAULT 'memmy-default';

ALTER TABLE app_settings
  ADD COLUMN skin_id TEXT NOT NULL DEFAULT 'default';

CREATE TABLE IF NOT EXISTS model_config (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_session (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  user_id TEXT,
  email TEXT,
  phone TEXT,
  nickname TEXT,
  avatar_url TEXT,
  plan_type TEXT,
  has_finished_guide INTEGER,
  region TEXT,
  raw_profile_json TEXT,
  cloud_token_ref TEXT,
  last_code_key TEXT,
  last_code_sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS secret_store (
  ref TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO model_config (
  id,
  provider,
  base_url,
  model_id,
  created_at,
  updated_at
) VALUES (
  'default',
  'openai_compatible',
  'https://api.openai.com/v1',
  'gpt-4.1-mini',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

INSERT OR IGNORE INTO account_session (
  id,
  created_at,
  updated_at
) VALUES (
  'default',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
