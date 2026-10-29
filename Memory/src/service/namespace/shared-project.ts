import type Database from "better-sqlite3";
import { isLocalWorkspaceUri, sha256Hex } from "../../contracts/index.js";

/** Read-only aliases for legacy UID-derived project hashes. No row is repaired. */
export function sharedProjectIds(db: Database.Database, projectId: string | null): Array<string | null> {
  if (projectId === null) return [null];
  const rows = db.prepare(`
    SELECT DISTINCT peer.project_id AS projectId
    FROM sessions origin JOIN sessions peer
      ON json_extract(peer.meta_json, '$.workspace_uri') = json_extract(origin.meta_json, '$.workspace_uri')
      AND json_extract(peer.meta_json, '$.workspace_host_id') IS json_extract(origin.meta_json, '$.workspace_host_id')
    WHERE origin.project_id = ? AND peer.project_id IS NOT NULL
      AND json_extract(origin.meta_json, '$.workspace_uri') IS NOT NULL
  `).all(projectId) as Array<{ projectId: string }>;
  const projects = new Set([projectId, ...rows.map(row => row.projectId)]);
  // A legacy scope can outlive its Sessions. For local URIs, also verify the
  // old project hash against the historical owner and current host evidence.
  const origins = db.prepare(`SELECT project_id, meta_json FROM sessions WHERE project_id = ?`).all(projectId) as Array<{ project_id: string; meta_json: string }>;
  if (!origins.length) {
    const saved = db.prepare(`SELECT user_id, workspace_uri FROM l3_world_model_scopes WHERE project_id = ? AND workspace_uri IS NOT NULL`)
      .all(projectId) as Array<{ user_id: string; workspace_uri: string }>;
    for (const scope of saved) {
      const peers = db.prepare(`SELECT project_id, meta_json FROM sessions WHERE project_id IS NOT NULL AND json_extract(meta_json, '$.workspace_uri') = ?`)
        .all(scope.workspace_uri) as Array<{ project_id: string; meta_json: string }>;
      for (const peer of peers) {
        const meta = JSON.parse(peer.meta_json) as Record<string, unknown>;
        if (isLocalWorkspaceUri(scope.workspace_uri) && typeof meta.workspace_host_id !== "string") continue;
        const identity = isLocalWorkspaceUri(scope.workspace_uri)
          ? `local\0${meta.workspace_host_id}\0${scope.workspace_uri}` : `remote\0${scope.workspace_uri}`;
        if (projectId === `ws_${sha256Hex(`${scope.user_id}\0${identity}`)}` || projectId === `ws_${sha256Hex(identity)}`) origins.push(peer);
      }
    }
  }
  for (const origin of origins) {
    const meta = JSON.parse(origin.meta_json) as Record<string, unknown>;
    const uri = meta.workspace_uri;
    const host = meta.workspace_host_id;
    if (typeof uri !== "string" || (isLocalWorkspaceUri(uri) && typeof host !== "string")) continue;
    projects.add(origin.project_id);
    const identity = isLocalWorkspaceUri(uri) ? `local\0${host}\0${uri}` : `remote\0${uri}`;
    const scopes = db.prepare(`SELECT user_id, project_id FROM l3_world_model_scopes WHERE workspace_uri = ? AND project_id IS NOT NULL`)
      .all(uri) as Array<{ user_id: string; project_id: string }>;
    for (const scope of scopes) {
      if (scope.project_id === `ws_${sha256Hex(`${scope.user_id}\0${identity}`)}` ||
          scope.project_id === `ws_${sha256Hex(identity)}`) projects.add(scope.project_id);
    }
  }
  return [...projects];
}
