/** Installed plugin persistence. */
import {
  InstalledPluginSchema,
  PluginManifestSchema,
  PluginPermissionSchema,
  PluginStateSchema,
  type InstalledPlugin,
  type PluginManifest,
  type PluginPermission,
  type PluginState
} from "@memmy/local-api-contracts";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const ConfigSchema = z.record(z.string(), z.unknown());
const PermissionsSchema = z.array(PluginPermissionSchema);

export interface PluginRecord extends InstalledPlugin {
  artifactHash: string | null;
  rootPath: string | null;
}

export interface SavePluginInput {
  manifest: PluginManifest;
  state: PluginState;
  artifactHash?: string | null;
  rootPath?: string | null;
}

export interface PluginRepository {
  list(): PluginRecord[];
  get(id: string): PluginRecord | null;
  save(input: SavePluginInput): PluginRecord;
  setState(id: string, state: PluginState, lastError?: string | null): PluginRecord;
  setConfig(id: string, config: Record<string, unknown>): PluginRecord;
  setApprovedPermissions(id: string, permissions: PluginPermission[]): PluginRecord;
  recordCall(input: PluginCallLogInput): void;
  delete(id: string): boolean;
}

export interface PluginCallLogInput {
  callId: string;
  pluginId: string;
  pluginVersion: string;
  capabilityId: string;
  adapterId: string;
  durationMs: number;
  outcome: "success" | "error" | "interrupted";
  errorCode?: string | null;
}

interface PluginRow {
  id: string;
  version: string;
  manifest_json: string;
  state: string;
  approved_permissions_json: string;
  config_json: string;
  artifact_hash: string | null;
  root_path: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export function createPluginRepository(db: DatabaseSync): PluginRepository {
  const getRequired = (id: string): PluginRecord => {
    const plugin = readPlugin(db, id);
    if (!plugin) throw Object.assign(new Error(`Plugin not found: ${id}`), { code: "not_found" as const });
    return plugin;
  };

  return {
    list() {
      const rows = db.prepare(`${SELECT_PLUGIN} ORDER BY id`).all() as unknown as PluginRow[];
      return rows.map(toPluginRecord);
    },

    get(id) {
      return readPlugin(db, id);
    },

    save(input) {
      const manifest = PluginManifestSchema.parse(input.manifest);
      const state = PluginStateSchema.parse(input.state);
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO installed_plugins (
          id, version, manifest_json, state, artifact_hash, root_path, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          version = excluded.version,
          manifest_json = excluded.manifest_json,
          state = excluded.state,
          artifact_hash = excluded.artifact_hash,
          root_path = excluded.root_path,
          last_error = NULL,
          updated_at = excluded.updated_at`
      ).run(
        manifest.id,
        manifest.version,
        JSON.stringify(manifest),
        state,
        input.artifactHash ?? null,
        input.rootPath ?? null,
        now,
        now
      );
      return getRequired(manifest.id);
    },

    setState(id, state, lastError = null) {
      const result = db.prepare(
        "UPDATE installed_plugins SET state = ?, last_error = ?, updated_at = ? WHERE id = ?"
      ).run(PluginStateSchema.parse(state), lastError, new Date().toISOString(), id);
      if (result.changes === 0) getRequired(id);
      return getRequired(id);
    },

    setConfig(id, config) {
      const result = db.prepare(
        "UPDATE installed_plugins SET config_json = ?, updated_at = ? WHERE id = ?"
      ).run(JSON.stringify(ConfigSchema.parse(config)), new Date().toISOString(), id);
      if (result.changes === 0) getRequired(id);
      return getRequired(id);
    },

    setApprovedPermissions(id, permissions) {
      const result = db.prepare(
        "UPDATE installed_plugins SET approved_permissions_json = ?, updated_at = ? WHERE id = ?"
      ).run(JSON.stringify(PermissionsSchema.parse(permissions)), new Date().toISOString(), id);
      if (result.changes === 0) getRequired(id);
      return getRequired(id);
    },

    recordCall(input) {
      db.prepare(`INSERT INTO plugin_call_logs (
        call_id, plugin_id, plugin_version, capability_id, adapter_id,
        duration_ms, outcome, error_code, called_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        input.callId,
        input.pluginId,
        input.pluginVersion,
        input.capabilityId,
        input.adapterId,
        Math.max(0, Math.trunc(input.durationMs)),
        input.outcome,
        input.errorCode ?? null,
        new Date().toISOString()
      );
    },

    delete(id) {
      return db.prepare("DELETE FROM installed_plugins WHERE id = ?").run(id).changes > 0;
    }
  };
}

const SELECT_PLUGIN = `SELECT
  id,
  version,
  manifest_json,
  state,
  approved_permissions_json,
  config_json,
  artifact_hash,
  root_path,
  last_error,
  created_at,
  updated_at
FROM installed_plugins`;

function readPlugin(db: DatabaseSync, id: string): PluginRecord | null {
  const row = db.prepare(`${SELECT_PLUGIN} WHERE id = ?`).get(id) as PluginRow | undefined;
  return row ? toPluginRecord(row) : null;
}

function toPluginRecord(row: PluginRow): PluginRecord {
  const installed = InstalledPluginSchema.parse({
    id: row.id,
    version: row.version,
    manifest: PluginManifestSchema.parse(JSON.parse(row.manifest_json)),
    state: row.state,
    approvedPermissions: PermissionsSchema.parse(JSON.parse(row.approved_permissions_json)),
    config: ConfigSchema.parse(JSON.parse(row.config_json)),
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
  return { ...installed, artifactHash: row.artifact_hash, rootPath: row.root_path };
}
