/** Plugin installation and lifecycle service. */
import {
  PluginManifestSchema,
  PluginPermissionSchema,
  type InstalledPlugin,
  type PluginPermission,
  type UpdatePluginConfigInput
} from "@memmy/local-api-contracts";
import { Ajv } from "ajv";
import type { PluginRegistry } from "../adapters/outbound/plugin-registry/index.js";
import type { PluginArtifactManager } from "../adapters/outbound/plugin-artifact/index.js";
import type { PluginRecord, PluginRepository } from "../infrastructure/app-state-store/repositories/plugin-repo.js";
import type { SecretStore } from "../infrastructure/app-state-store/index.js";

export interface PluginRuntimeHost {
  supports(adapterId: string): boolean;
  activate(plugin: PluginRecord, secrets: Readonly<Record<string, string>>): Promise<void>;
  deactivate(pluginId: string): Promise<void>;
}

export type { PluginArtifactManager } from "../adapters/outbound/plugin-artifact/index.js";

export interface PluginService {
  list(): InstalledPlugin[];
  get(id: string): InstalledPlugin;
  install(pluginId: string, version?: string): Promise<InstalledPlugin>;
  configure(id: string, input: UpdatePluginConfigInput): InstalledPlugin;
  approvePermissions(id: string, permissions: PluginPermission[]): Promise<InstalledPlugin>;
  enable(id: string): Promise<InstalledPlugin>;
  disable(id: string): Promise<InstalledPlugin>;
  uninstall(id: string): Promise<void>;
}

export interface CreatePluginServiceOptions {
  repository: PluginRepository;
  secretStore: SecretStore;
  registry: PluginRegistry;
  runtimeHost: PluginRuntimeHost;
  artifactManager: PluginArtifactManager;
}

export function createPluginService(options: CreatePluginServiceOptions): PluginService {
  const required = (id: string) => {
    const plugin = options.repository.get(id);
    if (!plugin) throw pluginError("plugin_unavailable", `Plugin not found: ${id}`);
    return plugin;
  };

  return {
    list() {
      return options.repository.list().map(publicPlugin);
    },

    get(id) {
      return publicPlugin(required(id));
    },

    async install(pluginId, version) {
      const release = await options.registry.resolve(pluginId, version);
      const manifest = PluginManifestSchema.parse(release.manifest);
      if (manifest.id !== pluginId || (version && manifest.version !== version)) {
        throw pluginError("plugin_invalid", "Registry returned a different plugin release");
      }
      if (!options.runtimeHost.supports(manifest.runtime.adapter)) {
        throw pluginError("plugin_adapter_unsupported", `Unsupported plugin adapter: ${manifest.runtime.adapter}`);
      }

      const existing = options.repository.get(pluginId);
      if (existing) {
        if (existing.version === manifest.version && manifestsEqual(existing.manifest, manifest)) {
          return publicPlugin(existing);
        }
        throw pluginError("conflict", `Plugin is already installed: ${pluginId}@${existing.version}`);
      }

      const artifact = await options.artifactManager.install({ ...release, manifest });
      try {
        return publicPlugin(options.repository.save({
          manifest,
          state: manifest.permissions.length ? "pending_approval" : "installed",
          ...artifact
        }));
      } catch (error) {
        await options.artifactManager.remove(artifact);
        throw error;
      }
    },

    configure(id, input) {
      const plugin = required(id);
      validateConfig(plugin, input.config);
      const allowedSecrets = declaredSecretKeys(plugin.manifest.permissions);
      for (const [key, secret] of Object.entries(input.secrets ?? {})) {
        if (!allowedSecrets.has(key)) {
          throw pluginError("plugin_permission_denied", `Secret is not declared by plugin: ${key}`);
        }
        if (!secret) throw pluginError("plugin_invalid", `Secret cannot be empty: ${key}`);
        options.secretStore.set(secretRef(id, key), secret);
      }
      return publicPlugin(options.repository.setConfig(id, input.config));
    },

    async approvePermissions(id, permissions) {
      const plugin = required(id);
      const approved = permissions.map((permission) => PluginPermissionSchema.parse(permission));
      assertPermissionSubset(approved, plugin.manifest.permissions);
      if (plugin.state === "active" && !samePermissions(approved, plugin.approvedPermissions)) {
        await options.runtimeHost.deactivate(id);
        options.repository.setState(id, "disabled");
      }
      const updated = options.repository.setApprovedPermissions(id, approved);
      const next = updated.state === "pending_approval" && hasAllPermissions(updated)
        ? options.repository.setState(id, "installed")
        : updated;
      return publicPlugin(next);
    },

    async enable(id) {
      const plugin = required(id);
      if (plugin.state === "active") return publicPlugin(plugin);
      if (!hasAllPermissions(plugin)) {
        throw pluginError("plugin_permission_denied", "Plugin permissions have not been approved");
      }
      validateConfig(plugin, plugin.config);
      const secrets = readSecrets(plugin, options.secretStore);
      options.repository.setState(id, "enabling");
      try {
        await options.runtimeHost.activate(plugin, secrets);
        return publicPlugin(options.repository.setState(id, "active"));
      } catch (error) {
        options.repository.setState(id, "failed", errorMessage(error));
        throw pluginError("plugin_activation_failed", errorMessage(error));
      }
    },

    async disable(id) {
      const plugin = required(id);
      if (plugin.state !== "active" && plugin.state !== "enabling" && plugin.state !== "failed") {
        return publicPlugin(options.repository.setState(id, "disabled"));
      }
      options.repository.setState(id, "disabling");
      try {
        await options.runtimeHost.deactivate(id);
        return publicPlugin(options.repository.setState(id, "disabled"));
      } catch (error) {
        options.repository.setState(id, "failed", errorMessage(error));
        throw pluginError("plugin_runtime_error", errorMessage(error));
      }
    },

    async uninstall(id) {
      let plugin = required(id);
      if (plugin.state === "active" || plugin.state === "enabling" || plugin.state === "failed") {
        await this.disable(id);
        plugin = required(id);
      }
      await options.artifactManager.remove(plugin);
      for (const key of declaredSecretKeys(plugin.manifest.permissions)) {
        options.secretStore.delete(secretRef(id, key));
      }
      options.repository.delete(id);
    }
  };
}

function publicPlugin(plugin: PluginRecord): InstalledPlugin {
  const { artifactHash: _artifactHash, rootPath: _rootPath, ...result } = plugin;
  return result;
}

function validateConfig(plugin: PluginRecord, config: Record<string, unknown>): void {
  if (!plugin.manifest.configSchema) return;
  const validate = new Ajv({ allErrors: true, strict: false }).compile(plugin.manifest.configSchema);
  if (!validate(config)) {
    throw pluginError("plugin_invalid", `Invalid plugin config: ${validate.errors?.[0]?.message ?? "unknown error"}`);
  }
}

function declaredSecretKeys(permissions: PluginPermission[]): Set<string> {
  return new Set(permissions.flatMap((permission) => permission.type === "secret" ? permission.keys : []));
}

function readSecrets(plugin: PluginRecord, secretStore: SecretStore): Record<string, string> {
  return Object.fromEntries([...declaredSecretKeys(plugin.manifest.permissions)].map((key) => {
    const value = secretStore.get(secretRef(plugin.id, key));
    if (value === null) throw pluginError("plugin_invalid", `Missing plugin secret: ${key}`);
    return [key, value];
  }));
}

function secretRef(pluginId: string, key: string): string {
  return `plugin:${pluginId}:${key}`;
}

function hasAllPermissions(plugin: Pick<PluginRecord, "manifest" | "approvedPermissions">): boolean {
  return samePermissions(plugin.approvedPermissions, plugin.manifest.permissions);
}

function assertPermissionSubset(approved: PluginPermission[], declared: PluginPermission[]): void {
  const declaredKeys = new Set(declared.map(permissionKey));
  const invalid = approved.find((permission) => !declaredKeys.has(permissionKey(permission)));
  if (invalid) throw pluginError("plugin_permission_denied", "Cannot approve a permission the plugin did not declare");
}

function samePermissions(left: PluginPermission[], right: PluginPermission[]): boolean {
  return left.length === right.length && left.every((permission) =>
    right.some((candidate) => permissionKey(candidate) === permissionKey(permission))
  );
}

function permissionKey(permission: PluginPermission): string {
  return JSON.stringify(permission);
}

function manifestsEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pluginError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
