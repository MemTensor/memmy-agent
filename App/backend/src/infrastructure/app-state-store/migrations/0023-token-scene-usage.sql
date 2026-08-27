ALTER TABLE account_token_usage_cache
ADD COLUMN scene_usages_json TEXT NOT NULL DEFAULT '[]';
