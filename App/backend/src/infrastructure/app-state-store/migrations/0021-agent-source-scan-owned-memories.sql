ALTER TABLE account_agent_source_scan_results
  ADD COLUMN memory_ids_json TEXT NOT NULL DEFAULT '[]';
