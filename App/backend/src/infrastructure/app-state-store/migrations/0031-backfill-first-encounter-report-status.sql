-- Back-fill first_encounter_report_status for existing users who already finished
-- onboarding before the 0027 migration introduced this column.
--
-- 0027 set the value based on scan_permission alone, leaving users whose
-- scan_permission was 'unset' (the default) stuck on 'pending'. Those users
-- then see the first-encounter report again on every launch.
--
-- If any real account row shows has_finished_guide = 1, the installation has
-- already completed onboarding and the first-encounter report should not replay.
UPDATE account_onboarding_state
SET
  first_encounter_report_status = 'skipped',
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE uuid = 'local-agent-sources'
  AND first_encounter_report_status = 'pending'
  AND EXISTS (
    SELECT 1
    FROM account_onboarding_state
    WHERE uuid != 'local-agent-sources'
      AND (has_finished_guide = 1 OR completed_at IS NOT NULL)
  );
