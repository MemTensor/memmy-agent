CREATE TABLE installed_plugins (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'installed',
    'pending_approval',
    'enabling',
    'active',
    'disabling',
    'disabled',
    'failed'
  )),
  approved_permissions_json TEXT NOT NULL DEFAULT '[]',
  config_json TEXT NOT NULL DEFAULT '{}',
  artifact_hash TEXT,
  root_path TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_installed_plugins_state ON installed_plugins(state);
