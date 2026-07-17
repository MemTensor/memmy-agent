ALTER TABLE app_settings
  ADD COLUMN last_launch_mode TEXT NOT NULL DEFAULT 'full'
    CHECK (last_launch_mode IN ('full', 'pet'));
