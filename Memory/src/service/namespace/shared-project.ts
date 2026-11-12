import type Database from "better-sqlite3";
import { WorkspaceIdentityFieldsSchema, isLocalWorkspaceUri, sha256Hex } from "../../contracts/index.js";

interface Evidence { projectId: string; identity: string }

/** Verify identity before admitting an alias. Missing/conflicting evidence stays isolated. */
export function sharedProjectIdentity(db: Database.Database, projectId: string | null): {
  projectIds: Array<string | null>; deviceProjectId: string | null;
} {
  const isolated = { projectIds: [projectId], deviceProjectId: projectId };
  if (projectId === null) return isolated;
  const origins = db.prepare(`SELECT user_id, project_id, meta_json FROM sessions WHERE project_id = ?`)
    .all(projectId) as Array<{user_id: string; project_id: string; meta_json: string}>;
  const saved = db.prepare(`SELECT user_id, project_id, workspace_uri FROM l3_world_model_scopes WHERE project_id = ?`)
    .all(projectId) as Array<{user_id: string; project_id: string; workspace_uri: string | null}>;
  const uris = new Set<string>();
  for (const origin of origins) {
    try { const meta = JSON.parse(origin.meta_json); if (typeof meta.workspace_uri === "string") uris.add(meta.workspace_uri); }
    catch { return isolated; }
  }
  for (const scope of saved) if (scope.workspace_uri) uris.add(scope.workspace_uri);
  if (uris.size !== 1) return isolated;
  const uri = [...uris][0]!;
  const sessions = db.prepare(`SELECT user_id, project_id, meta_json FROM sessions
    WHERE json_valid(meta_json) AND json_extract(meta_json, '$.workspace_uri') = ? AND project_id IS NOT NULL`)
    .all(uri) as typeof origins;
  const evidence: Evidence[] = [];
  const invalid = new Set<string>();
  for (const row of sessions) {
    const meta = JSON.parse(row.meta_json) as Record<string, unknown>;
    const parsed = WorkspaceIdentityFieldsSchema.safeParse({workspaceUri: uri, workspaceHostId: meta.workspace_host_id});
    if (!parsed.success || (isLocalWorkspaceUri(uri) && !parsed.data.workspaceHostId)) { invalid.add(row.project_id); continue; }
    const identity = isLocalWorkspaceUri(uri) ? `local\0${parsed.data.workspaceHostId}\0${uri}` : `remote\0${uri}`;
    if (row.project_id !== deviceId(identity) && row.project_id !== legacyId(row.user_id, identity)) {
      invalid.add(row.project_id); continue;
    }
    evidence.push({projectId: row.project_id, identity});
  }
  // No-session scopes may be verified against a peer's host, never URI alone.
  const scopes = db.prepare(`SELECT user_id, project_id, workspace_uri FROM l3_world_model_scopes
    WHERE workspace_uri = ? AND project_id IS NOT NULL`).all(uri) as typeof saved;
  for (const scope of scopes) {
    const matching = new Set(evidence.filter(peer => scope.project_id === deviceId(peer.identity) ||
      scope.project_id === legacyId(scope.user_id, peer.identity)).map(peer => peer.identity));
    if (matching.size === 1) evidence.push({projectId: scope.project_id, identity: [...matching][0]!});
    else if (matching.size > 1) invalid.add(scope.project_id);
  }
  // Validate conflicting mappings in batches, rather than querying once per alias.
  const candidateIds = JSON.stringify([...new Set(evidence.flatMap(row => [row.projectId, deviceId(row.identity)]))]);
  const mappings = db.prepare(`SELECT project_id, meta_json FROM sessions
    WHERE project_id IN (SELECT value FROM json_each(?))`).all(candidateIds) as Array<{project_id:string; meta_json:string}>;
  for (const row of mappings) {
    try { if (JSON.parse(row.meta_json).workspace_uri !== uri) invalid.add(row.project_id); }
    catch { invalid.add(row.project_id); }
  }
  const scopeMappings = db.prepare(`SELECT project_id, workspace_uri FROM l3_world_model_scopes
    WHERE project_id IN (SELECT value FROM json_each(?)) AND workspace_uri IS NOT NULL`)
    .all(candidateIds) as Array<{project_id:string; workspace_uri:string}>;
  for (const row of scopeMappings) if (row.workspace_uri !== uri) invalid.add(row.project_id);
  const identities = new Set(evidence.filter(row => row.projectId === projectId).map(row => row.identity));
  if (invalid.has(projectId) || identities.size !== 1) return isolated;
  const identity = [...identities][0]!;
  const projects = new Set<string>([projectId]);
  for (const row of evidence) {
    if (row.identity === identity && !invalid.has(row.projectId)) projects.add(row.projectId);
  }
  const canonical = deviceId(identity);
  if (invalid.has(canonical)) return isolated;
  projects.add(canonical);
  return {projectIds: [...projects], deviceProjectId: canonical};
}

function deviceId(identity: string): string { return `ws_${sha256Hex(identity)}`; }
function legacyId(owner: string, identity: string): string { return `ws_${sha256Hex(`${owner}\0${identity}`)}`; }

/** Read-only aliases. No session, scope, or historical memory is repaired. */
export function sharedProjectIds(db: Database.Database, projectId: string | null): Array<string | null> {
  return sharedProjectIdentity(db, projectId).projectIds;
}
