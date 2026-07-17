ALTER TABLE account_onboarding_state
  RENAME TO account_onboarding_state_old;

CREATE TABLE account_onboarding_state (
  uuid TEXT PRIMARY KEY REFERENCES cloud_accounts(uuid) ON DELETE CASCADE,
  has_finished_guide INTEGER NOT NULL DEFAULT 0,
  current_step TEXT NOT NULL DEFAULT 'scan_permission_required'
    CHECK (current_step IN (
      'byok_setup_required',
      'account_auth_required',
      'scan_permission_required',
      'improvement_program_required',
      'product_tour_required',
      'completed'
    )),
  has_accepted_terms INTEGER NOT NULL DEFAULT 0,
  accepted_terms_version TEXT,
  scan_permission TEXT NOT NULL DEFAULT 'unset'
    CHECK (scan_permission IN ('unset', 'none', 'scan_only', 'scan_and_write_skill')),
  improvement_program TEXT NOT NULL DEFAULT 'unset'
    CHECK (improvement_program IN ('unset', 'accepted', 'declined', 'not_applicable')),
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR REPLACE INTO account_onboarding_state (
  uuid,
  has_finished_guide,
  current_step,
  has_accepted_terms,
  accepted_terms_version,
  scan_permission,
  improvement_program,
  completed_at,
  created_at,
  updated_at
)
SELECT
  old.uuid,
  old.has_finished_guide,
  old.current_step,
  old.has_accepted_terms,
  old.accepted_terms_version,
  old.scan_permission,
  old.improvement_program,
  old.completed_at,
  old.created_at,
  old.updated_at
FROM account_onboarding_state_old old
WHERE EXISTS (
  SELECT 1
  FROM cloud_accounts account
  WHERE account.uuid = old.uuid
);

DROP TABLE account_onboarding_state_old;
