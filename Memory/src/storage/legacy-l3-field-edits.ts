import type Database from "better-sqlite3";
import { L3WorldModelFieldNameSchema, type L3WorldModelFieldName } from "../contracts/index.js";
import { isRecord, parseJson } from "../utils/json.js";

export interface LegacyL3Change {
  memory_id: string;
  before_json: string | null;
  after_json: string | null;
  created_at: string;
  seq: number;
}

export interface LegacyL3FieldEdit {
  memory_id: string;
  field: L3WorldModelFieldName;
  deleted: number;
  edited_at: string;
  change_seq: number;
}

/** Persist evidence of an edit, never infer a deletion from an uninitialized null. */
export function legacyL3FieldEditsFromChanges(rows: LegacyL3Change[]): LegacyL3FieldEdit[] {
  const body = (json: string | null) => {
    const value = parseJson<unknown>(json, null);
    if (!isRecord(value) || !isRecord(value.properties)) return undefined;
    const internal = value.properties.internal_info;
    return isRecord(internal) && internal.schema_version === 2 && isRecord(internal.world_model)
      ? internal.world_model : undefined;
  };
  return rows.flatMap(row => {
    const before = body(row.before_json), after = body(row.after_json);
    if (!after) return [];
    return L3WorldModelFieldNameSchema.options.flatMap(field => {
      const deleted = typeof before?.[field] === "string" && after[field] === null;
      const written = typeof after[field] === "string" && after[field] !== before?.[field];
      return deleted || written ? [{ memory_id: row.memory_id, field, deleted: Number(deleted),
        edited_at: row.created_at, change_seq: row.seq }] : [];
    });
  });
}

/** Called inside the migration/retention transaction before any evidence is removed. */
export function preserveLegacyL3FieldEdits(db: Database.Database, importedChanges?: LegacyL3Change[]): void {
  const rows = importedChanges ?? db.prepare(`SELECT change.memory_id, change.before_json, change.after_json, change.created_at, change.seq
    FROM memory_change_log AS change JOIN l3_world_model_scopes AS scope ON scope.memory_id = change.memory_id
    WHERE scope.user_id IS NOT NULL AND change.change_type IN ('l3_world_model_create', 'l3_world_model_update')`)
    .all() as LegacyL3Change[];
  const legacyMemoryIds = importedChanges ? new Set((db.prepare(
    "SELECT memory_id FROM l3_world_model_scopes WHERE user_id IS NOT NULL AND memory_id IS NOT NULL"
  ).all() as Array<{memory_id: string}>).map(row => row.memory_id)) : undefined;
  const save = db.prepare(`INSERT INTO memory_l3_legacy_field_edits(memory_id, field, deleted, edited_at, change_seq)
    VALUES (@memory_id, @field, @deleted, @edited_at, @change_seq)
    ON CONFLICT(memory_id, field, deleted) DO UPDATE SET edited_at=excluded.edited_at, change_seq=excluded.change_seq
    WHERE excluded.edited_at > edited_at OR (excluded.edited_at = edited_at AND excluded.change_seq > change_seq)`);
  for (const edit of legacyL3FieldEditsFromChanges(rows)) {
    if (!legacyMemoryIds || legacyMemoryIds.has(edit.memory_id)) save.run(edit);
  }
}
