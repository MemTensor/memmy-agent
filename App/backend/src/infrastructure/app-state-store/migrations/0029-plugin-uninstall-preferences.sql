-- Keep explicit user removals after the installed plugin record is deleted.
CREATE TABLE plugin_uninstall_preferences (
  plugin_id TEXT PRIMARY KEY,
  uninstalled_at TEXT NOT NULL
);
