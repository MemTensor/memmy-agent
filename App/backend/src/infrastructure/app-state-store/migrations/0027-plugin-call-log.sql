CREATE TABLE IF NOT EXISTS plugin_call_logs (
  call_id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  plugin_version TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'error', 'interrupted')),
  error_code TEXT,
  called_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plugin_call_logs_plugin_called_at
  ON plugin_call_logs(plugin_id, called_at DESC);
