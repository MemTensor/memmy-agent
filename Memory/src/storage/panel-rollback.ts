import type Database from "better-sqlite3";
import { getSchemaVersion } from "./schema.js";

/** Explicit offline downgrade for v10's additive panel objects. Facts written
 * after upgrade remain intact; restoring the pre-upgrade backup would lose them. */
export function rollbackPanelSchema(db: Database.Database): void {
  const version = getSchemaVersion(db).version;
  if (version === 9) return;
  if (version !== 10) throw new Error(`Panel rollback supports schema 10, received ${version}`);
  db.transaction(() => {
    for (const name of [
      "idx_memories_panel_created",
      "idx_memories_panel_status_created",
      "idx_user_memories_panel_updated",
      "idx_user_memories_panel_status_updated",
      "idx_episodes_panel_opened",
      "idx_episodes_panel_user_opened"
    ])
      db.exec(`DROP INDEX IF EXISTS ${name}`);
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'panel_safety_%'")
      .pluck()
      .all() as string[];
    for (const name of triggers) db.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
    db.prepare("DELETE FROM runtime_kv WHERE key='panel_safety_token'").run();
    db.prepare("DELETE FROM schema_migrations WHERE version=10").run();
    db.prepare(
      "INSERT INTO schema_migrations(id,version,applied_at,checksum) VALUES('009_token_usage_outbox',9,?,'panel-rollback') ON CONFLICT(id) DO NOTHING"
    ).run(new Date().toISOString());
  })();
}
