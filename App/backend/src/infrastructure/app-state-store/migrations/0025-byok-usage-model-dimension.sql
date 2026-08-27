ALTER TABLE byok_token_usage_events ADD COLUMN preset_id TEXT;
ALTER TABLE byok_token_usage_events ADD COLUMN provider TEXT;
ALTER TABLE byok_token_usage_events ADD COLUMN model TEXT;
ALTER TABLE byok_token_usage_events ADD COLUMN capability TEXT
  CHECK (capability IS NULL OR capability IN ('agent', 'memory_summary', 'memory_evolution', 'embedding'));

CREATE INDEX IF NOT EXISTS idx_byok_token_usage_events_model
  ON byok_token_usage_events(provider, model, capability, created_at);
