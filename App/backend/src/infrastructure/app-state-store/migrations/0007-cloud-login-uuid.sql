-- Rename agentUser/login credentials from token naming to uuid naming.
-- Use the old cloud_token_ref and account-session key only as migration sources.
ALTER TABLE account_session
  RENAME COLUMN cloud_token_ref TO cloud_uuid_ref;

UPDATE secret_store
SET ref = 'account-session:default:cloud-uuid'
WHERE ref = 'account-session:default:cloud-token'
  AND NOT EXISTS (
    SELECT 1 FROM secret_store WHERE ref = 'account-session:default:cloud-uuid'
  );

UPDATE account_session
SET cloud_uuid_ref = 'account-session:default:cloud-uuid'
WHERE cloud_uuid_ref = 'account-session:default:cloud-token';

DELETE FROM secret_store
WHERE ref = 'account-session:default:cloud-token';
