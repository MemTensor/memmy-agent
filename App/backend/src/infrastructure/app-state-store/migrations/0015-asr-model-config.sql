ALTER TABLE account_model_config
  ADD COLUMN asr_provider TEXT NOT NULL DEFAULT 'aliyun'
    CHECK (asr_provider IN ('aliyun'));

ALTER TABLE account_model_config
  ADD COLUMN asr_base_url TEXT NOT NULL DEFAULT 'https://dashscope.aliyuncs.com/compatible-mode/v1';

ALTER TABLE account_model_config
  ADD COLUMN asr_model_id TEXT NOT NULL DEFAULT 'qwen3-asr-flash'
    CHECK (asr_model_id IN ('qwen3-asr-flash'));

ALTER TABLE account_model_config
  ADD COLUMN asr_api_key_ref TEXT;

DROP INDEX IF EXISTS idx_secret_store_uuid_purpose;

ALTER TABLE secret_store
  RENAME TO secret_store_old;

CREATE TABLE secret_store (
  ref TEXT PRIMARY KEY,
  uuid TEXT REFERENCES cloud_accounts(uuid) ON DELETE CASCADE,
  purpose TEXT CHECK (
    purpose IN (
      'cloud_uuid',
      'model_api_key',
      'embedding_api_key',
      'memory_summary_api_key',
      'memory_evolution_api_key',
      'composio_machine_token',
      'asr_api_key'
    )
    OR purpose IS NULL
  ),
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR REPLACE INTO secret_store (
  ref,
  uuid,
  purpose,
  ciphertext,
  iv,
  auth_tag,
  created_at,
  updated_at
)
SELECT
  old.ref,
  old.uuid,
  CASE
    WHEN old.purpose IN (
      'cloud_uuid',
      'model_api_key',
      'embedding_api_key',
      'memory_summary_api_key',
      'memory_evolution_api_key',
      'composio_machine_token',
      'asr_api_key'
    ) THEN old.purpose
    ELSE NULL
  END,
  old.ciphertext,
  old.iv,
  old.auth_tag,
  old.created_at,
  old.updated_at
FROM secret_store_old old;

DROP TABLE secret_store_old;

CREATE INDEX idx_secret_store_uuid_purpose
  ON secret_store(uuid, purpose);
