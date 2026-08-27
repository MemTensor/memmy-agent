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
      'composio_machine_token'
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
      'composio_machine_token'
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
