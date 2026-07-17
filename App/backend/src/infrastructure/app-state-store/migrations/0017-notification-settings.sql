ALTER TABLE app_settings
  ADD COLUMN task_done_notification_enabled INTEGER NOT NULL DEFAULT 1
    CHECK (task_done_notification_enabled IN (0, 1));

ALTER TABLE app_settings
  ADD COLUMN notification_sound_enabled INTEGER NOT NULL DEFAULT 1
    CHECK (notification_sound_enabled IN (0, 1));
