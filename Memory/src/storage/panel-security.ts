import type Database from "better-sqlite3";

/** A reset token, not a change log: any destructive/visibility change invalidates panel views. */
export function panelSafetyToken(db: Database.Database): string {
  return String(
    db.prepare("SELECT value_json FROM runtime_kv WHERE key='panel_safety_token'").pluck().get() ?? "missing"
  );
}
export function invalidatePanelViews(db: Database.Database): void {
  db.exec(`INSERT INTO runtime_kv(key,value_json,updated_at) VALUES('panel_safety_token',json_quote(lower(hex(randomblob(16)))),strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`);
}
export function installPanelSafetyTriggers(db: Database.Database): void {
  if (panelSafetyToken(db) === "missing") invalidatePanelViews(db);
  const reset = `INSERT INTO runtime_kv(key,value_json,updated_at) VALUES('panel_safety_token',json_quote(lower(hex(randomblob(16)))),strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at;`;
  const changes: Record<string, string> = {
    memories:
      "OLD.deleted_at IS NOT NEW.deleted_at OR (OLD.status='deleted') != (NEW.status='deleted') OR OLD.user_id IS NOT NEW.user_id OR OLD.visibility IS NOT NEW.visibility",
    user_memories:
      "OLD.deleted_at IS NOT NEW.deleted_at OR (OLD.status='deleted') != (NEW.status='deleted') OR OLD.user_id IS NOT NEW.user_id",
    raw_turns:
      "OLD.deleted_at IS NOT NEW.deleted_at OR OLD.redacted_at IS NOT NEW.redacted_at OR OLD.user_id IS NOT NEW.user_id OR OLD.episode_id IS NOT NEW.episode_id",
    episodes: "OLD.user_id IS NOT NEW.user_id OR OLD.project_id IS NOT NEW.project_id",
    l3_world_model_scopes:
      "OLD.user_id IS NOT NEW.user_id OR OLD.project_id IS NOT NEW.project_id OR OLD.workspace_uri IS NOT NEW.workspace_uri OR OLD.memory_id IS NOT NEW.memory_id"
  };
  for (const [table, condition] of Object.entries(changes)) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    db.exec(`CREATE TRIGGER IF NOT EXISTS panel_safety_${table}_delete AFTER DELETE ON ${table} BEGIN ${reset} END`);
    db.exec(`DROP TRIGGER IF EXISTS panel_safety_${table}_update`);
    db.exec(
      `CREATE TRIGGER panel_safety_${table}_update AFTER UPDATE ON ${table} WHEN ${condition} BEGIN ${reset} END`
    );
  }
}
