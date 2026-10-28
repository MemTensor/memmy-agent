import type Database from "better-sqlite3";
import { canonicalProjectId } from "./device-scope.js";
import { resolveWorkspaceIdentity } from "../service/namespace/workspace-identity.js";
import { parseJson } from "../utils/json.js";

type Row = Record<string, unknown>;
type Strategy = "skip" | "replace" | "error";
const str = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;
const json = (value: unknown): Row => typeof value === "string" ? parseJson<Row>(value, {}) : {};

/** A stable, pre-write decision shared by tables and their post-import work. */
export function planBundleImport(db: Database.Database, tables: Record<string, Row[]>, strategy: Strategy) {
  const rows = (table: string) => tables[table] ?? [];
  const aliases = new Map<string, string>();
  for (const row of db.prepare("SELECT legacy_id,project_id FROM memory_project_aliases").all() as Row[]) {
    aliases.set(String(row.legacy_id), String(row.project_id));
  }
  const existingAliases = new Map(aliases);
  for (const row of rows("memory_project_aliases")) {
    const from = str(row.legacy_id), to = str(row.project_id);
    if (!from || !to) throw new Error("invalid project alias in bundle");
    if (!aliases.has(from) || strategy === "replace") aliases.set(from, to);
  }
  const canonical = (value: unknown): string | null => {
    let current = str(value);
    if (!current) return null;
    const seen = new Set<string>();
    while (aliases.has(current) && aliases.get(current) !== current) {
      if (seen.has(current)) throw new Error("cyclic project aliases in bundle");
      seen.add(current); current = aliases.get(current)!;
    }
    return current;
  };
  for (const id of aliases.keys()) canonical(id);
  // Include inferred identities now, before override rows are considered. Only
  // rows that would be accepted can contribute new alias evidence.
  for (const table of ["sessions", "l3_world_model_scopes"]) {
    const key = table === "sessions" ? "id" : "scope_key";
    for (const row of rows(table)) {
      if (strategy === "skip" && db.prepare(`SELECT 1 FROM ${table} WHERE ${key}=?`).get(row[key])) continue;
      const meta = table === "sessions" ? json(row.meta_json) : row;
      const project = str(row.project_id), uri = str(meta.workspace_uri);
      if (!project || !uri) continue;
      let identity: ReturnType<typeof resolveWorkspaceIdentity>;
      try { identity = resolveWorkspaceIdentity(null, { workspaceUri: uri, workspaceHostId: str(meta.workspace_host_id) }); }
      catch { continue; } // Incomplete evidence does not create an alias.
      if (!identity.projectId) continue;
      const prior = canonical(project);
      if (prior !== project && prior !== identity.projectId) throw new Error("conflicting project identity in bundle");
      aliases.set(project, identity.projectId);
      const workspace = str(row.workspace_id);
      if (workspace && identity.workspaceId) aliases.set(workspace, identity.workspaceId);
    }
  }

  const targetMemories = db.prepare("SELECT * FROM memories WHERE memory_layer='L3'").all() as Row[];
  const targetScopes = db.prepare("SELECT * FROM l3_world_model_scopes").all() as Row[];
  const protectedProjects = new Set<string | null>();
  const originalProjects = new Set<string | null>();
  const rawTargetProjects = new Set<string>();
  const memoryProjects = new Map<string, Set<string | null>>();
  const remember = (id: unknown, project: unknown) => {
    if (!str(id)) return;
    const projects = memoryProjects.get(String(id)) ?? new Set();
    projects.add(canonical(project)); memoryProjects.set(String(id), projects);
  };
  const rememberTarget = (project: unknown) => {
    originalProjects.add(canonicalProjectId(db, str(project)));
    protectedProjects.add(canonical(project));
    if (str(project)) rawTargetProjects.add(String(project));
  };
  if (strategy === "skip") {
    for (const row of targetMemories) {
      rememberTarget(json(row.info_json).project_id);
      remember(row.id, json(row.info_json).project_id);
    }
    for (const row of targetScopes) {
      rememberTarget(row.project_id); remember(row.memory_id, row.project_id);
    }
  }
  for (const row of rows("memories")) if (row.memory_layer === "L3") remember(row.id, json(row.info_json).project_id);
  for (const row of rows("l3_world_model_scopes")) remember(row.memory_id, row.project_id);
  const skippedMemoryIds = new Set<string>();
  if (strategy === "skip") {
    for (const row of targetMemories) if (typeof row.id === "string") skippedMemoryIds.add(row.id);
    for (const row of rows("memories")) {
      if (typeof row.id === "string" && (db.prepare("SELECT 1 FROM memories WHERE id=?").get(row.id)
        || (row.memory_layer === "L3" && protectedProjects.has(canonical(json(row.info_json).project_id))))) {
        skippedMemoryIds.add(row.id);
      }
    }
  }
  const touchesMemory = (id: unknown) => typeof id === "string" &&
    (skippedMemoryIds.has(id) || [...(memoryProjects.get(id) ?? [])].some(p => protectedProjects.has(p)));
  const touchesProject = (project: unknown) => protectedProjects.has(canonical(project));
  // An incoming row can lose a physical-ID conflict to the retained target row.
  // Keep both dependency scopes: rejected input must neither mask the target's
  // protection nor authorize dependents that would resume under another scope.
  const dependencyProjects = (key: string, records: Row[]) => {
    const projects = new Map<string, Set<string | null>>();
    for (const row of records) {
      const id = str(row[key]);
      if (!id) continue;
      const values = projects.get(id) ?? new Set<string | null>();
      values.add(canonical(row.project_id)); projects.set(id, values);
    }
    return projects;
  };
  const batches = dependencyProjects("id", [...db.prepare("SELECT id,project_id FROM l3_world_model_evidence_batches").all() as Row[],
    ...rows("l3_world_model_evidence_batches")]);
  const scopes = dependencyProjects("scope_key", [...targetScopes, ...rows("l3_world_model_scopes")]);
  const sessions = dependencyProjects("id", [...db.prepare("SELECT id,project_id FROM sessions").all() as Row[], ...rows("sessions")]);
  const hasProtectedProject = (projects: Set<string | null> | undefined) =>
    [...(projects ?? [])].some(project => protectedProjects.has(project));
  const batchProtected = (id: unknown) => typeof id === "string" && hasProtectedProject(batches.get(id));
  const scopeProtected = (key: unknown) => typeof key === "string" && [...scopes].some(([scope, projects]) =>
    (key === scope || key.startsWith(scope + ":")) && hasProtectedProject(projects));
  const sessionProtected = (id: unknown) => typeof id === "string" && hasProtectedProject(sessions.get(id));

  const shouldSkip = (table: string, row: Row): boolean => {
    if (strategy !== "skip") return false;
    if (table === "memories") return typeof row.id === "string" && skippedMemoryIds.has(row.id);
    if (table === "memory_l3_overrides") return touchesProject(row.project_key) || touchesMemory(row.memory_id);
    if (table === "l3_world_model_scopes") return touchesProject(row.project_id) || touchesMemory(row.memory_id);
    if (table === "memory_l3_legacy_field_edits") return touchesMemory(row.memory_id);
    if (table === "memory_change_log") return (row.change_type === "l3_world_model_create"
      || row.change_type === "l3_world_model_update" || row.change_type === "l3_world_model_delete"
      || row.change_type === "archive") && touchesMemory(row.memory_id);
    if (table === "audit_logs") return row.action === "archive" && touchesMemory(row.target_id);
    if (table === "memory_project_aliases") {
      const from = str(row.legacy_id);
      return Boolean(from && rawTargetProjects.has(from) && !existingAliases.has(from));
    }
    if (table === "l3_world_model_project_environment_state" || table === "l3_world_model_evidence_batches") return touchesProject(row.project_id);
    if (table === "l3_world_model_batch_targets") return batchProtected(row.batch_id) || scopeProtected(row.field_scope_key);
    if (table === "l3_world_model_session_cursors" || table === "l3_world_model_input_traces") return sessionProtected(row.session_id);
    if (table === "memory_processing_state") return touchesMemory(row.memory_id);
    if (table === "embedding_retry_queue") return touchesMemory(row.target_id);
    if (table === "evolution_jobs") {
      if (touchesMemory(row.target_memory_id)) return true;
      if (row.job_type !== "l3_world_model_update" && row.job_type !== "project_environment_profile") return false;
      const payload = json(row.payload_json);
      return batchProtected(payload.batchId) || scopeProtected(row.scope_key) || sessionProtected(row.session_id)
        || (Object.hasOwn(payload, "projectId") && touchesProject(payload.projectId));
    }
    return false;
  };
  return { shouldSkip, skippedMemoryIds, originalProjects, canonical };
}
