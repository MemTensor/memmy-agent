ALTER TABLE app_settings
  ADD COLUMN memory_byok_daily_limit_m INTEGER NOT NULL DEFAULT 10
  CHECK (memory_byok_daily_limit_m >= 0 AND memory_byok_daily_limit_m <= 99999);

ALTER TABLE app_settings
  ADD COLUMN memory_byok_total_limit_m INTEGER NOT NULL DEFAULT 500
  CHECK (memory_byok_total_limit_m >= 0 AND memory_byok_total_limit_m <= 99999);
