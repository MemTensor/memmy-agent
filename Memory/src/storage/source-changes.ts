import type Database from "better-sqlite3";

export interface SourceVersion { identity: string; generation: number; seq: number; floor: number }
export const SOURCE_CHANGE_RETENTION = 100_000;
/** Source metadata is written by the existing business transaction, never by a cache consumer. */
export function installSourceChanges(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS source_change_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), identity TEXT NOT NULL,
    generation INTEGER NOT NULL, seq INTEGER NOT NULL, floor INTEGER NOT NULL);
    INSERT OR IGNORE INTO source_change_state VALUES(1,lower(hex(randomblob(16))),1,0,0);
    CREATE TABLE IF NOT EXISTS source_changes (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL, operation TEXT NOT NULL);`);
  for (const [table, key] of Object.entries({ memories: "id", user_memories: "id", api_logs: "id",
    raw_turns: "id", sessions: "id", episodes: "id", l3_world_model_scopes: "scope_key" })) {
    for (const event of ["INSERT", "UPDATE", "DELETE"]) {
      const row = event === "DELETE" ? "OLD" : "NEW";
      db.exec(`CREATE TRIGGER IF NOT EXISTS source_changes_${table}_${event.toLowerCase()}
        AFTER ${event} ON ${table} BEGIN
        INSERT INTO source_changes(entity_type,entity_id,operation) VALUES('${table}',CAST(${row}.${key} AS TEXT),'${event.toLowerCase()}');
        ${event === "UPDATE" ? `INSERT INTO source_changes(entity_type,entity_id,operation) SELECT '${table}',CAST(OLD.${key} AS TEXT),'delete' WHERE OLD.${key} IS NOT NEW.${key};` : ""}
        UPDATE source_change_state SET seq=last_insert_rowid() WHERE singleton=1;
        DELETE FROM source_changes WHERE seq <= (SELECT seq-${SOURCE_CHANGE_RETENTION} FROM source_change_state WHERE seq-floor>=${SOURCE_CHANGE_RETENTION}+256);
        UPDATE source_change_state SET floor=seq-${SOURCE_CHANGE_RETENTION} WHERE seq-floor>=${SOURCE_CHANGE_RETENTION}+256;
      END`);
    }
  }
}
export function sourceVersion(db: Database.Database): SourceVersion {
  return db.prepare("SELECT identity,generation,seq,floor FROM source_change_state WHERE singleton=1").get() as SourceVersion;
}
export function resetSourceGeneration(db: Database.Database): void {
  db.exec("UPDATE source_change_state SET generation=generation+1 WHERE singleton=1");
}
