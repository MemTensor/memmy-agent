ALTER TABLE app_settings
  ADD COLUMN menu_bar_icon_enabled INTEGER NOT NULL DEFAULT 1
    CHECK (menu_bar_icon_enabled IN (0, 1));
