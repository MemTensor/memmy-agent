import { stableHash } from "../utils/id.js";
import type { RuntimeNamespace } from "../types.js";
import type Database from "better-sqlite3";
import { resolveWorkspaceIdentity } from "../service/namespace/workspace-identity.js";

const installed = new WeakSet<Database.Database>();
const namespaces = new WeakMap<Database.Database, Map<string, string>>();
const aliases = new WeakMap<Database.Database, Map<string, string>>();

/** Account identities are never memory scopes. Only evidence-backed workspace aliases are persisted. */
export function installDeviceScope(db: Database.Database): void {
  if (installed.has(db)) return;
  aliases.set(db, new Map((db.prepare("SELECT legacy_id, project_id FROM memory_project_aliases").all() as Array<{legacy_id: string; project_id: string}>).map(row => [row.legacy_id, row.project_id])));
  db.function("memory_project_id", (value: unknown) => canonicalProjectId(db, typeof value === "string" ? value : null));
  namespaces.set(db, new Map());
  db.function("memory_namespace_key", (value: unknown) => typeof value === "string" ? canonicalNamespaceKey(db, value) : null);
  installed.add(db);
  refreshProjectAliases(db);
}

export function canonicalProjectId(db: Database.Database, id: string | null | undefined): string | null {
  if (!id?.trim()) return null;
  return aliases.get(db)?.get(id) ?? id;
}

export function registerProjectAlias(db: Database.Database, legacyId: string, uri: string, host?: string | null): string {
  const identity = resolveWorkspaceIdentity(null, { workspaceUri: uri, ...(host ? { workspaceHostId: host } : {}) });
  if (!identity.projectId) return legacyId;
  const existing = canonicalProjectId(db, legacyId);
  if (existing !== legacyId && existing !== identity.projectId) throw new Error("conflicting legacy workspace identity");
  if (!db.readonly) db.prepare(`INSERT INTO memory_project_aliases(legacy_id, project_id, workspace_uri, workspace_host_id, created_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(legacy_id) DO NOTHING`)
    .run(legacyId, identity.projectId, uri, host ?? null, new Date().toISOString());
  aliases.get(db)?.set(legacyId, identity.projectId);
  return identity.projectId;
}

export function refreshProjectAliases(db: Database.Database): void {
  namespaces.set(db, new Map());
  aliases.set(db, new Map((db.prepare("SELECT legacy_id, project_id FROM memory_project_aliases").all() as Array<{legacy_id:string;project_id:string}>).map(row => [row.legacy_id,row.project_id])));
  const rows = db.prepare(`SELECT project_id, workspace_id, meta_json FROM sessions WHERE project_id IS NOT NULL`).all() as Array<{ project_id: string; workspace_id: string | null; meta_json: string }>;
  // Resolve all evidence before writing any mapping; conflicting identities remain isolated.
  const candidates = new Map<string, Map<string, { uri: string; host?: string }>>();
  const scopeRows = db.prepare(`SELECT project_id, workspace_uri FROM l3_world_model_scopes
    WHERE project_id IS NOT NULL AND workspace_uri IS NOT NULL`).all() as Array<{project_id:string;workspace_uri:string}>;
  // Remote URIs are self-contained; local paths still require the originating host ID.
  const evidence = [...rows, ...scopeRows.map(row => ({project_id:row.project_id,
    meta_json:JSON.stringify({workspace_uri:row.workspace_uri})}))];
  for (const row of evidence) {
    try {
      const meta = JSON.parse(row.meta_json);
      const uri = typeof meta.workspace_uri === "string" ? meta.workspace_uri : undefined;
      const host = typeof meta.workspace_host_id === "string" ? meta.workspace_host_id : undefined;
      if (!uri) continue;
      const identity = resolveWorkspaceIdentity(null, { workspaceUri: uri, ...(host ? { workspaceHostId: host } : {}) });
      if (!identity.projectId) continue;
      const group = candidates.get(row.project_id) ?? new Map();
      group.set(identity.projectId, { uri, host });
      candidates.set(row.project_id, group);
    } catch { /* Incomplete legacy evidence must never merge unrelated projects. */ }
  }
  db.transaction(() => {
    for (const [id, candidatesForId] of candidates) {
      const existing = aliases.get(db)?.get(id);
      if (candidatesForId.size !== 1 || (existing && !candidatesForId.has(existing))) {
        // Later imports can reveal conflicting evidence. Never keep a stale merge.
        if (!db.readonly) db.prepare("DELETE FROM memory_project_aliases WHERE legacy_id = ?").run(id);
        aliases.get(db)?.delete(id);
        continue;
      }
      const candidate = [...candidatesForId.values()][0]!;
      registerProjectAlias(db, id, candidate.uri, candidate.host);
    }
  })();
  const workspaceTargets = new Map<string, Set<string>>();
  for (const row of rows) {
    const projectId = canonicalProjectId(db, row.project_id);
    if (row.workspace_id) {
      const targets = workspaceTargets.get(row.workspace_id) ?? new Set<string>();
      targets.add(projectId !== row.project_id && projectId?.startsWith("ws_") ? projectId.slice(3) : row.workspace_id);
      workspaceTargets.set(row.workspace_id, targets);
    }
  }
  for (const [id, targets] of workspaceTargets) {
    const target = targets.size === 1 ? [...targets][0]! : id;
    if (target === id) {
      if (!db.readonly) db.prepare("DELETE FROM memory_project_aliases WHERE legacy_id = ? AND workspace_uri = ''").run(id);
      aliases.get(db)?.delete(id);
      continue;
    }
    if (!db.readonly) db.prepare(`INSERT INTO memory_project_aliases(legacy_id, project_id, workspace_uri, created_at)
      VALUES (?, ?, '', ?) ON CONFLICT(legacy_id) DO UPDATE SET project_id = excluded.project_id`)
      .run(id, target, new Date().toISOString());
    aliases.get(db)?.set(id, target);
  }
  for (const row of rows) {
    const projectId = canonicalProjectId(db, row.project_id);
    let meta: Record<string, unknown>;
    try { meta = JSON.parse(row.meta_json); } catch { continue; }
    if (!meta || typeof meta !== "object") continue;
    const tenantId = meta.tenant_id ?? meta.tenantId ?? null;
    const current = stableHash({tenantId, projectId, workspaceId: canonicalProjectId(db, row.workspace_id)});
    const old = stableHash({tenantId, projectId: row.project_id, workspaceId: row.workspace_id});
    namespaces.get(db)?.set(old, current);
    if (meta.source_namespace_key === old) namespaces.get(db)?.set(meta.source_namespace_key, current);
  }
}

export function canonicalNamespaceKey(db: Database.Database, key: string): string {
  return namespaces.get(db)?.get(key) ?? key;
}

export function deviceNamespace(db: Database.Database, namespace: RuntimeNamespace): RuntimeNamespace {
  return {...namespace, userId: null,
    projectId: canonicalProjectId(db, namespace.projectId) ?? undefined,
    workspaceId: canonicalProjectId(db, namespace.workspaceId) ?? undefined};
}

/** Normalize only protocol envelopes, never user content or nested tool payloads. */
export function memoryFingerprint(db: Database.Database, value: unknown, legacyUserId?: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const result = { ...record };
  if (record.namespace && typeof record.namespace === "object" && !Array.isArray(record.namespace)) {
    result.namespace = legacyUserId === undefined
      ? deviceNamespace(db, record.namespace as RuntimeNamespace)
      : { ...record.namespace, userId: legacyUserId };
  }
  for (const key of ["request", "skill"]) {
    if (record[key] && typeof record[key] === "object") result[key] = memoryFingerprint(db, record[key], legacyUserId);
  }
  return result;
}

export function matchesLegacyMemoryFingerprint(db: Database.Database, fingerprint: unknown, expected: string,
  hash: (value: unknown) => string): boolean {
  if (hash(fingerprint) === expected) return true;
  const owners = db.prepare(`SELECT DISTINCT user_id FROM sessions WHERE user_id IS NOT NULL
    UNION SELECT DISTINCT user_id FROM memories WHERE user_id IS NOT NULL`).pluck().all() as string[];
  return owners.some(owner => hash(memoryFingerprint(db, fingerprint, owner)) === expected);
}
