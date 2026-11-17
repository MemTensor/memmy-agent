import type Database from "better-sqlite3";
import type { L3WorldModelFieldName } from "../contracts/index.js";
import { sharedProjectIds } from "../service/namespace/shared-project.js";
import { newId } from "../utils/id.js";

type TraceField = Exclude<L3WorldModelFieldName, "project_environment_profile">;
const PREFIX = "l3_field_deletion_v1:";
const OVERRIDE_PREFIX = "l3_field_override_v1:";
const fields: readonly string[] = ["project_contract", "domain_knowledge", "general_rules_and_safety_constraints"];
const key = (projectId: string | null, field: TraceField): string => PREFIX + JSON.stringify([projectId, field]);

export function l3FieldOverrideIdentity(value: string): [string | null, TraceField] | undefined {
  if (!value.startsWith(OVERRIDE_PREFIX)) return undefined;
  let identity: unknown;
  try { identity = JSON.parse(value.slice(OVERRIDE_PREFIX.length)); }
  catch { return undefined; }
  if (!Array.isArray(identity) || identity.length !== 2 ||
      (identity[0] !== null && typeof identity[0] !== "string") || !fields.includes(identity[1])) return undefined;
  return identity as [string | null, TraceField];
}

export function isL3FieldDeletionBoundaryKey(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

/** Local deletion intent survives later field writes and is never imported. */
export function recordL3FieldDeletion(db: Database.Database, projectId: string | null, field: TraceField, at: string): void {
  const insert = db.prepare(`INSERT INTO runtime_kv (key,value_json,updated_at) VALUES (?,'true',?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`);
  for (const project of sharedProjectIds(db, projectId)) insert.run(key(project, field), at);
}

export function hasL3FieldDeletion(db: Database.Database, projectId: string | null, field: TraceField): boolean {
  const keys = sharedProjectIds(db, projectId).map(project => key(project, field));
  return !!db.prepare("SELECT 1 FROM runtime_kv WHERE key IN (SELECT value FROM json_each(?)) LIMIT 1")
    .get(JSON.stringify(keys));
}

/** Preserve pre-fix local clears before a bundle can replace their markers. */
export function preserveExistingL3FieldDeletions(db: Database.Database, at: string): void {
  const rows = db.prepare(`SELECT key,value_json FROM runtime_kv WHERE key GLOB ?
    AND json_valid(value_json) AND json_extract(value_json,'$.cleared')=1`)
    .all(`${OVERRIDE_PREFIX}*`) as Array<{key: string; value_json: string}>;
  for (const row of rows) {
    const identity = l3FieldOverrideIdentity(row.key);
    if (!identity) continue;
    recordL3FieldDeletion(db, identity[0], identity[1], at);
    const state = JSON.parse(row.value_json) as {cleared?: unknown; revision?: unknown};
    if (typeof state.cleared !== "boolean" || typeof state.revision !== "string") {
      // A recognizable legacy clear remains a clear; repair only its local
      // control metadata so a valid restore cannot leave context unreadable.
      db.prepare("UPDATE runtime_kv SET value_json=?,updated_at=? WHERE key=?")
        .run(JSON.stringify({cleared: true, revision: newId("l3revision")}), at, row.key);
    }
  }
}

/** Freeze local bindings before incoming scopes or metadata can change aliases.
 * A later local field write keeps its deletion boundary and its new binding. */
export function protectedL3FieldOverrideKeys(db: Database.Database, incomingKeys: readonly unknown[], replacingData = false): Set<string> {
  const keys = incomingKeys.filter((value): value is string => typeof value === "string" && value.startsWith(OVERRIDE_PREFIX));
  if (!keys.length && !replacingData) return new Set();
  const rows = db.prepare(replacingData ? "SELECT key FROM runtime_kv WHERE key GLOB ?"
    : "SELECT key FROM runtime_kv WHERE key IN (SELECT value FROM json_each(?))")
    .all(replacingData ? `${OVERRIDE_PREFIX}*` : JSON.stringify(keys)) as Array<{key: string}>;
  return new Set(rows.filter(row => {
    const identity = l3FieldOverrideIdentity(row.key);
    return identity && hasL3FieldDeletion(db, identity[0], identity[1]);
  }).map(row => row.key));
}
