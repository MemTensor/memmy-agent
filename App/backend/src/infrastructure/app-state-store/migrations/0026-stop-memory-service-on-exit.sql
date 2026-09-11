ALTER TABLE app_settings
  ADD COLUMN stop_memory_service_on_exit INTEGER NOT NULL DEFAULT 0
  CHECK (stop_memory_service_on_exit IN (0, 1));
