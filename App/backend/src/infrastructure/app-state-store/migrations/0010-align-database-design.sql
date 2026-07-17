ALTER TABLE app_settings
  RENAME COLUMN avatar_id TO avatar;

ALTER TABLE app_settings
  RENAME COLUMN skin_id TO skin;

ALTER TABLE cloud_accounts
  RENAME COLUMN avatar_url TO avatar;

DROP INDEX IF EXISTS idx_account_ingestion_seen_source;

ALTER TABLE account_ingestion_seen
  RENAME TO account_ingestion_seen_old;

CREATE TABLE account_ingestion_seen (
  uuid TEXT NOT NULL REFERENCES cloud_accounts(uuid) ON DELETE CASCADE,
  dedup_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (uuid, dedup_key),
  FOREIGN KEY (uuid, source_id) REFERENCES account_agent_sources(uuid, source_id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO account_ingestion_seen (uuid, dedup_key, source_id, created_at)
SELECT old.uuid, old.dedup_key, old.source_id, old.created_at
FROM account_ingestion_seen_old old
WHERE EXISTS (
  SELECT 1
  FROM account_agent_sources source
  WHERE source.uuid = old.uuid
    AND source.source_id = old.source_id
);

DROP TABLE account_ingestion_seen_old;

CREATE INDEX idx_account_ingestion_seen_source
  ON account_ingestion_seen(uuid, source_id);

ALTER TABLE account_privacy_settings
  RENAME TO account_privacy_settings_old;

CREATE TABLE account_privacy_settings (
  uuid TEXT PRIMARY KEY REFERENCES cloud_accounts(uuid) ON DELETE CASCADE,
  allow_memory_improvement_upload INTEGER NOT NULL DEFAULT 0,
  local_only_mode INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR REPLACE INTO account_privacy_settings (
  uuid,
  allow_memory_improvement_upload,
  local_only_mode,
  created_at,
  updated_at
)
SELECT
  old.uuid,
  old.allow_memory_improvement_upload,
  old.local_only_mode,
  old.created_at,
  old.updated_at
FROM account_privacy_settings_old old
WHERE EXISTS (
  SELECT 1
  FROM cloud_accounts account
  WHERE account.uuid = old.uuid
);

DROP TABLE account_privacy_settings_old;

DROP INDEX IF EXISTS idx_idempotency_created;
DROP INDEX IF EXISTS idx_account_idempotency_created;

ALTER TABLE idempotency_keys
  RENAME TO idempotency_keys_legacy;

ALTER TABLE account_idempotency_keys
  RENAME TO idempotency_keys;

DROP TABLE idempotency_keys_legacy;

CREATE INDEX idx_idempotency_created
  ON idempotency_keys(uuid, created_at);

DROP INDEX IF EXISTS idx_secret_store_uuid_purpose;

ALTER TABLE secret_store
  RENAME TO secret_store_old;

CREATE TABLE secret_store (
  ref TEXT PRIMARY KEY,
  uuid TEXT REFERENCES cloud_accounts(uuid) ON DELETE CASCADE,
  purpose TEXT CHECK (purpose IN ('cloud_uuid', 'model_api_key', 'embedding_api_key') OR purpose IS NULL),
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
    WHEN old.purpose IN ('cloud_uuid', 'model_api_key', 'embedding_api_key') THEN old.purpose
    ELSE NULL
  END,
  old.ciphertext,
  old.iv,
  old.auth_tag,
  old.created_at,
  old.updated_at
FROM secret_store_old old
WHERE old.uuid IS NULL
  OR EXISTS (
    SELECT 1
    FROM cloud_accounts account
    WHERE account.uuid = old.uuid
  );

DROP TABLE secret_store_old;

CREATE INDEX idx_secret_store_uuid_purpose
  ON secret_store(uuid, purpose);
