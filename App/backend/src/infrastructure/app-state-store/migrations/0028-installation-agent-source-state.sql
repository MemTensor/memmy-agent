-- Agent-source scans are installation-scoped. Preserve scan state created by
-- older account-scoped versions before removing the old rows.
WITH ranked_sources AS (
  SELECT
    source_id,
    display_name,
    data_path,
    builtin,
    status,
    last_scanned_at,
    sync_recipe_json,
    created_at,
    updated_at,
    ROW_NUMBER() OVER (
      PARTITION BY source_id
      ORDER BY updated_at DESC, created_at DESC, uuid DESC
    ) AS rank
  FROM account_agent_sources
  WHERE uuid != 'local-agent-sources'
)
INSERT OR IGNORE INTO account_agent_sources (
  uuid,
  source_id,
  display_name,
  data_path,
  builtin,
  status,
  last_scanned_at,
  sync_recipe_json,
  created_at,
  updated_at
)
SELECT
  'local-agent-sources',
  source_id,
  display_name,
  data_path,
  builtin,
  status,
  last_scanned_at,
  sync_recipe_json,
  created_at,
  updated_at
FROM ranked_sources
WHERE rank = 1;

INSERT OR IGNORE INTO account_ingestion_seen (uuid, dedup_key, source_id, created_at)
SELECT 'local-agent-sources', dedup_key, source_id, created_at
FROM account_ingestion_seen
WHERE uuid != 'local-agent-sources'
  AND EXISTS (
    SELECT 1
    FROM account_agent_sources source
    WHERE source.uuid = 'local-agent-sources'
      AND source.source_id = account_ingestion_seen.source_id
  );

WITH ranked_watermarks AS (
  SELECT
    source_id,
    mode,
    baseline_at,
    latest_seen_created_at,
    updated_at,
    ROW_NUMBER() OVER (
      PARTITION BY source_id
      ORDER BY updated_at DESC
    ) AS rank
  FROM account_agent_source_watermarks
  WHERE uuid != 'local-agent-sources'
)
INSERT OR IGNORE INTO account_agent_source_watermarks (
  uuid,
  source_id,
  mode,
  baseline_at,
  latest_seen_created_at,
  updated_at
)
SELECT
  'local-agent-sources',
  source_id,
  mode,
  baseline_at,
  latest_seen_created_at,
  updated_at
FROM ranked_watermarks
WHERE rank = 1
  AND EXISTS (
    SELECT 1
    FROM account_agent_sources source
    WHERE source.uuid = 'local-agent-sources'
      AND source.source_id = ranked_watermarks.source_id
  );

WITH ranked_checkpoints AS (
  SELECT
    source_id,
    conversation_id,
    last_message_id,
    last_created_at,
    content_hash,
    updated_at,
    ROW_NUMBER() OVER (
      PARTITION BY source_id, conversation_id
      ORDER BY updated_at DESC
    ) AS rank
  FROM account_agent_source_conversation_checkpoints
  WHERE uuid != 'local-agent-sources'
)
INSERT OR IGNORE INTO account_agent_source_conversation_checkpoints (
  uuid,
  source_id,
  conversation_id,
  last_message_id,
  last_created_at,
  content_hash,
  updated_at
)
SELECT
  'local-agent-sources',
  source_id,
  conversation_id,
  last_message_id,
  last_created_at,
  content_hash,
  updated_at
FROM ranked_checkpoints
WHERE rank = 1
  AND EXISTS (
    SELECT 1
    FROM account_agent_sources source
    WHERE source.uuid = 'local-agent-sources'
      AND source.source_id = ranked_checkpoints.source_id
  );

-- The repository now only reads the installation scope. Remove stale copies
-- so a future account switch cannot expose an older scan boundary again.
DELETE FROM account_ingestion_seen WHERE uuid != 'local-agent-sources';
DELETE FROM account_agent_source_watermarks WHERE uuid != 'local-agent-sources';
DELETE FROM account_agent_source_conversation_checkpoints WHERE uuid != 'local-agent-sources';
DELETE FROM account_agent_sources WHERE uuid != 'local-agent-sources';
