-- User intent survives runtime failures. Never infer intent from failure again.
ALTER TABLE installed_plugins ADD COLUMN desired_enabled INTEGER NOT NULL DEFAULT 0;
UPDATE installed_plugins SET desired_enabled = 1
WHERE state IN ('active', 'enabling')
   OR (state = 'failed' AND (
     last_error LIKE '%fetch failed%' OR last_error LIKE '%ECONNREFUSED%'
     OR last_error LIKE '%ECONNRESET%' OR last_error = 'Plugin process exited'
   ));
