ALTER TABLE account_agent_sources
  ADD COLUMN auto_inject_suppressed INTEGER NOT NULL DEFAULT 0
    CHECK(auto_inject_suppressed IN (0,1));
