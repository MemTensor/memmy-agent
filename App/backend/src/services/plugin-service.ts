/** Plugin installation and lifecycle service. */
import {
  CapabilityCallSchema,
  PluginManifestSchema,
  PluginPermissionSchema,
  type InstalledPlugin,
  type CapabilityCall,
  type CapabilityEvent,
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
  invoke(call: CapabilityCall): AsyncIterable<CapabilityEvent>;
  cancel(pluginId: string, callId: string): Promise<void>;
  respond(pluginId: string, callId: string, interactionId: string, response: unknown): Promise<void>;
}

export type { PluginArtifactManager } from "../adapters/outbound/plugin-artifact/index.js";

export interface PluginService {
  list(): InstalledPlugin[];
  get(id: string): InstalledPlugin;
  install(pluginId: string, version?: string): Promise<InstalledPlugin>;
  update(id: string, version?: string): Promise<InstalledPlugin>;
  configure(id: string, input: UpdatePluginConfigInput): InstalledPlugin;
  approvePermissions(id: string, permissions: PluginPermission[]): Promise<InstalledPlugin>;
  enable(id: string): Promise<InstalledPlugin>;
  disable(id: string): Promise<InstalledPlugin>;
  uninstall(id: string): Promise<void>;
  invoke(call: CapabilityCall): AsyncIterable<CapabilityEvent>;
  cancel(id: string, callId: string): Promise<void>;
  respond(id: string, callId: string, interactionId: string, response: unknown): Promise<void>;
  restoreActive(): Promise<void>;
  shutdown(): Promise<void>;
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
          const releaseHash = release.artifact?.sha256.toLowerCase() ?? null;
          if (existing.artifactHash !== releaseHash) {
            throw pluginError("conflict", `Plugin release digest changed: ${pluginId}@${manifest.version}`);
          }
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

    async update(id, version) {
      const previous = required(id);
      const release = await options.registry.resolve(id, version);
      const manifest = PluginManifestSchema.parse(release.manifest);
      if (manifest.id !== id || (version && manifest.version !== version)) {
        throw pluginError("plugin_invalid", "Registry returned a different plugin release");
      }
      if (!options.runtimeHost.supports(manifest.runtime.adapter)) {
        throw pluginError("plugin_adapter_unsupported", `Unsupported plugin adapter: ${manifest.runtime.adapter}`);
      }
      if (previous.version === manifest.version && manifestsEqual(previous.manifest, manifest)) {
        return publicPlugin(previous);
      }

      const artifact = await options.artifactManager.install({ ...release, manifest });
      const approvedPermissions = previous.approvedPermissions.filter((approved) =>
        manifest.permissions.some((declared) => permissionKey(approved) === permissionKey(declared))
      );
      const pendingApproval = !samePermissions(approvedPermissions, manifest.permissions);
      const draft: PluginRecord = {
        ...previous,
        version: manifest.version,
        manifest,
        approvedPermissions,
        state: pendingApproval ? "pending_approval" : "disabled",
        ...artifact
      };
      try {
        validateConfig(draft, draft.config);
        const secrets = pendingApproval ? {} : readSecrets(draft, options.secretStore);
        if (previous.state === "active") await options.runtimeHost.deactivate(id);
        let updated = options.repository.save({
          manifest,
          state: draft.state,
          ...artifact
        });
        updated = options.repository.setApprovedPermissions(id, approvedPermissions);
        if (previous.state === "active" && !pendingApproval) {
          await options.runtimeHost.activate(updated, secrets);
          updated = options.repository.setState(id, "active");
        }
        if (artifact.rootPath !== previous.rootPath) await options.artifactManager.remove(previous);
        return publicPlugin(updated);
      } catch (error) {
        await options.runtimeHost.deactivate(id).catch(() => undefined);
        let restored = options.repository.save({
          manifest: previous.manifest,
          state: previous.state === "active" ? "disabled" : previous.state,
          artifactHash: previous.artifactHash,
          rootPath: previous.rootPath
        });
        restored = options.repository.setApprovedPermissions(id, previous.approvedPermissions);
        restored = options.repository.setConfig(id, previous.config);
        if (previous.state === "active") {
          await options.runtimeHost.activate(restored, readSecrets(restored, options.secretStore));
          options.repository.setState(id, "active");
        }
        if (artifact.rootPath !== previous.rootPath) await options.artifactManager.remove(artifact);
        throw error;
      }
    },

    configure(id, input) {
      const plugin = required(id);
      if (plugin.state === "active" || plugin.state === "enabling" || plugin.state === "disabling") {
        throw pluginError("conflict", "Disable plugin before changing its configuration");
      }
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
    },

    invoke(rawCall) {
      const call = CapabilityCallSchema.parse(rawCall);
      const plugin = required(call.pluginId);
      if (plugin.state !== "active") throw pluginError("plugin_unavailable", `Plugin is not active: ${plugin.id}`);
      if (!hasAllPermissions(plugin)) throw pluginError("plugin_permission_denied", "Plugin permissions have changed");
      if (!plugin.manifest.capabilities.some((capability) => capability.id === call.capabilityId)) {
        throw pluginError("plugin_unavailable", `Capability not found: ${call.capabilityId}`);
      }
      return options.runtimeHost.invoke(call);
    },

    async cancel(id, callId) {
      required(id);
      await options.runtimeHost.cancel(id, callId);
    },

    async respond(id, callId, interactionId, response) {
      required(id);
      await options.runtimeHost.respond(id, callId, interactionId, response);
    },

    async restoreActive() {
      for (const plugin of options.repository.list().filter((candidate) => candidate.state === "active")) {
        try {
          if (!hasAllPermissions(plugin)) throw new Error("Plugin permissions have changed");
          validateConfig(plugin, plugin.config);
          await options.runtimeHost.activate(plugin, readSecrets(plugin, options.secretStore));
        } catch (error) {
          options.repository.setState(plugin.id, "failed", errorMessage(error));
        }
      }
    },

    async shutdown() {
      await Promise.allSettled(options.repository.list()
        .filter((plugin) => plugin.state === "active" || plugin.state === "enabling")
        .map((plugin) => options.runtimeHost.deactivate(plugin.id)));
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
