ALTER TABLE account_model_config
  RENAME TO account_model_config_old_embedding_mode;

CREATE TABLE account_model_config (
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
  embedding_mode TEXT NOT NULL DEFAULT 'local'
    CHECK (embedding_mode IN ('local', 'custom')),
  embedding_base_url TEXT,
  embedding_model_id TEXT,
  embedding_api_key_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  memory_provider TEXT,
  memory_base_url TEXT,
  memory_model_id TEXT,
  memory_api_key_ref TEXT,
  skill_provider TEXT,
  skill_base_url TEXT,
  skill_model_id TEXT,
  skill_api_key_ref TEXT
);

INSERT INTO account_model_config (
  uuid,
  provider,
  base_url,
  model_id,
  api_key_ref,
  embedding_mode,
  embedding_base_url,
  embedding_model_id,
  embedding_api_key_ref,
  created_at,
  updated_at,
  memory_provider,
  memory_base_url,
  memory_model_id,
  memory_api_key_ref,
  skill_provider,
  skill_base_url,
  skill_model_id,
  skill_api_key_ref
)
SELECT
  uuid,
  provider,
  base_url,
  model_id,
  api_key_ref,
  CASE embedding_mode
    WHEN 'separate' THEN 'custom'
    ELSE 'local'
  END,
  CASE embedding_mode
    WHEN 'separate' THEN embedding_base_url
    ELSE NULL
  END,
  CASE embedding_mode
    WHEN 'separate' THEN embedding_model_id
    ELSE NULL
  END,
  CASE embedding_mode
    WHEN 'separate' THEN embedding_api_key_ref
    ELSE NULL
  END,
  created_at,
  updated_at,
  memory_provider,
  memory_base_url,
  memory_model_id,
  memory_api_key_ref,
  skill_provider,
  skill_base_url,
  skill_model_id,
  skill_api_key_ref
FROM account_model_config_old_embedding_mode;

DROP TABLE account_model_config_old_embedding_mode;
