ALTER TABLE account_onboarding_state
  ADD COLUMN first_encounter_report_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (first_encounter_report_status IN ('pending', 'shown', 'skipped'));

UPDATE account_onboarding_state
SET first_encounter_report_status = CASE
  WHEN scan_permission = 'none' THEN 'skipped'
  WHEN scan_permission IN ('scan_only', 'scan_and_write_skill') THEN 'shown'
  ELSE 'pending'
END,
updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE uuid = 'local-agent-sources';
