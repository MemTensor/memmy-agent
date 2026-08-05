INSERT OR IGNORE INTO cloud_accounts (
  uuid,
  created_at,
  updated_at
) VALUES (
  'local-agent-sources',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

WITH current_scope AS (
  SELECT CASE
    WHEN user_mode = 'byok' THEN 'local-byok-onboarding'
    WHEN user_mode = 'account' THEN active_uuid
    ELSE NULL
  END AS uuid
  FROM app_settings
  WHERE id = 'default'
),
current_permission AS (
  SELECT onboarding.scan_permission AS permission
  FROM account_onboarding_state onboarding
  JOIN current_scope scope ON scope.uuid = onboarding.uuid
),
latest_explicit_permission AS (
  SELECT scan_permission AS permission
  FROM account_onboarding_state
  WHERE uuid != 'local-agent-sources'
    AND scan_permission != 'unset'
  ORDER BY updated_at DESC
  LIMIT 1
),
selected_permission AS (
  SELECT COALESCE(
    (
      SELECT permission
      FROM current_permission
      WHERE permission != 'unset'
    ),
    (SELECT permission FROM latest_explicit_permission),
    (SELECT permission FROM current_permission),
    'unset'
  ) AS permission
)
INSERT OR IGNORE INTO account_onboarding_state (
  uuid,
  scan_permission,
  created_at,
  updated_at
)
SELECT
  'local-agent-sources',
  permission,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM selected_permission;

UPDATE account_onboarding_state
SET scan_permission = 'unset',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE uuid != 'local-agent-sources'
  AND scan_permission != 'unset';
