-- Update the legacy default plan name to the trial Token display name.
UPDATE token_usage_cache
SET
  plan_name = '体验 Token',
  updated_at = datetime('now')
WHERE id = 'default'
  AND plan_name = char(109, 111, 99, 107);
