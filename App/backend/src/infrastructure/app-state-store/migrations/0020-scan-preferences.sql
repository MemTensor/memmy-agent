ALTER TABLE app_settings
  ADD COLUMN auto_scan_known_agents INTEGER NOT NULL DEFAULT 1
    CHECK (auto_scan_known_agents IN (0, 1));

ALTER TABLE app_settings
  ADD COLUMN watch_file_changes INTEGER NOT NULL DEFAULT 1
    CHECK (watch_file_changes IN (0, 1));

ALTER TABLE app_settings
  ADD COLUMN auto_inject_skill INTEGER NOT NULL DEFAULT 0
    CHECK (auto_inject_skill IN (0, 1));
