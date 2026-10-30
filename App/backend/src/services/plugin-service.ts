import { PLUGIN_HOST_CAPABILITIES } from "./plugin-host-capabilities.js";
import { setTimeout as delay } from "node:timers/promises";
/** Plugin installation and lifecycle service. */
import {
  CapabilityCallSchema,
  PluginManifestSchema,
  PluginPermissionSchema,
  type InstalledPlugin,
  type PluginCatalogEntry,
  type CapabilityCall,
  type CapabilityEvent,
  type PluginPermission,
  type PluginUiSlot,
  type UpdatePluginConfigInput
} from "@memmy/local-api-contracts";
import { pluginEligibility } from "./plugin-rules.js";
import { Ajv } from "ajv";
import { fileURLToPath } from "node:url";
import type { PluginRegistry } from "../adapters/outbound/plugin-registry/index.js";
import type { PluginArtifactManager } from "../adapters/outbound/plugin-artifact/index.js";
import type { PluginRuntimeHost } from "../adapters/outbound/plugin-runtime/index.js";
import { noopPluginSkillManager, type PluginSkillManager } from "../adapters/outbound/plugin-skill/index.js";
import {
  createPluginLocalArtifactService,
  type HostedPluginArtifact,
  type PluginLocalArtifactService
} from "./plugin-local-artifact-service.js";
import type { PluginRecord, PluginRepository } from "../infrastructure/app-state-store/repositories/plugin-repo.js";
import type { SecretStore } from "../infrastructure/app-state-store/index.js";

export type { PluginArtifactManager } from "../adapters/outbound/plugin-artifact/index.js";
export type { PluginRuntimeHost } from "../adapters/outbound/plugin-runtime/index.js";

export interface PluginService {
  isBusy(id: string): boolean;
  list(): InstalledPlugin[];
  catalog(): Promise<PluginCatalogEntry[]>;
  suspend(id: string): Promise<void>;
  get(id: string): InstalledPlugin;
  readUi(id: string, slot: PluginUiSlot): Promise<string>;
  openArtifact(id: string, token: string): Promise<HostedPluginArtifact>;
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
  skillManager?: PluginSkillManager;
  onSkillContentInvalidated?: (pluginId?: string) => void;
  localArtifactService?: PluginLocalArtifactService;
  /** Resolves whether the signed-in account holds a manifest-declared entitlement. */
  isAuthenticated?: () => boolean;
  isEntitlementGranted?: (entitlement: string) => boolean;
  platform?: NodeJS.Platform;
  hostVersion?: string;
  hasResourceLease?: (id: string) => boolean;
  releaseResources?: (id: string) => Promise<void>;
  activateGeneratedSkills?: (id: string) => Promise<void>;
  /** Resolves only after the real Gateway health/bootstrap check succeeds. */
  gatewayReady?: Promise<void>;
  restoreRetryDelaysMs?: readonly number[];
  onRestored?: () => Promise<unknown>;
  /** Private plugin IDs discoverable through server-issued account entitlements. */
  catalogPluginIds?: () => readonly string[];
  /** Runtime-wide barrier: plugin tools and Skills are shared across Agent turns. */
  hasActiveAgentTasks?: (signal: AbortSignal) => Promise<boolean>;
}

export function createPluginService(options: CreatePluginServiceOptions): PluginService {
  const skillManager = options.skillManager ?? noopPluginSkillManager;
  const localArtifacts = options.localArtifactService ?? createPluginLocalArtifactService();
  const isEntitlementGranted = options.isEntitlementGranted ?? (() => false);
  const compatible = (manifest: import("@memmy/local-api-contracts").PluginManifest) => {
    if (manifest.platforms && !manifest.platforms.includes((options.platform ?? process.platform) as "win32" | "darwin" | "linux")) {
      throw pluginError("plugin_incompatible", "This plugin does not support this operating system");
    }
    if (manifest.minimumHostVersion && (!options.hostVersion || compareVersions(options.hostVersion, manifest.minimumHostVersion) < 0)) {
      throw pluginError("plugin_incompatible", `Requires Memmy ${manifest.minimumHostVersion} or later`);
    }
  };
  const missingFeatures = (manifest: import("@memmy/local-api-contracts").PluginManifest) =>
    (manifest.requiredHostCapabilities ?? []).filter(feature => !(PLUGIN_HOST_CAPABILITIES as readonly string[]).includes(feature));
  const busy = (id: string) => Boolean(options.runtimeHost.isBusy?.(id) || options.hasResourceLease?.(id));
  // Enforced here rather than only in the reconciler so a direct local-API call cannot bypass it.
  const eligibility = (manifest: PluginRecord["manifest"]) => pluginEligibility(manifest, options.isAuthenticated?.() ?? false, isEntitlementGranted);
  const activeCalls = new Map<string, number>();
  const suspended = new Set<string>();
  const updates = new Map<string, { status: "waiting" | "installing"; version?: string; promise: Promise<InstalledPlugin> }>();
  const idleWaiters = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  let closing = false;
  const shutdown = new AbortController();
  const withActivity = (plugin: InstalledPlugin): InstalledPlugin => ({
    ...plugin, activeCallCount: activeCalls.get(plugin.id) ?? 0,
    ...(updates.has(plugin.id) ? { update: { status: updates.get(plugin.id)!.status, version: updates.get(plugin.id)!.version } } : {})
  });
  const assertEntitled = (manifest: PluginRecord["manifest"]) => {
    if (!eligibility(manifest).canUse) throw pluginError("plugin_entitlement_required", `Plugin access denied: ${manifest.id}`);
    const entitlement = manifest.requiredEntitlement;
    if (!entitlement || isEntitlementGranted(entitlement)) return;
    throw pluginError(
      "plugin_entitlement_required",
      `Plugin requires an account entitlement that is not granted: ${manifest.id}`
    );
  };
  const required = (id: string) => {
    const plugin = options.repository.get(id);
    if (!plugin) throw pluginError("plugin_unavailable", `Plugin not found: ${id}`);
    return plugin;
  };
  const activateContributions = async (plugin: PluginRecord, secrets: Readonly<Record<string, string>>) => {
    await skillManager.activate(plugin);
    try {
      await options.runtimeHost.activate(plugin, secrets);
      await options.activateGeneratedSkills?.(plugin.id);
    } catch (error) {
      await options.runtimeHost.deactivate(plugin.id).catch(() => undefined);
      await skillManager.deactivate(plugin.id).catch(() => undefined);
      await options.releaseResources?.(plugin.id).catch(() => undefined);
      throw error;
    }
  };
  const deactivateContributions = async (pluginId: string) => {
    options.onSkillContentInvalidated?.(pluginId);
    const results = await Promise.allSettled([
      options.runtimeHost.deactivate(pluginId),
      skillManager.deactivate(pluginId)
    ]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    await options.releaseResources?.(pluginId);
    if (failure) throw failure.reason;
  };
  const queues = new Map<string, Promise<unknown>>();
  const serial = <T>(id: string, operation: () => Promise<T>): Promise<T> => {
    const next = (queues.get(id) ?? Promise.resolve()).catch(() => undefined).then(operation);
    queues.set(id, next);
    void next.finally(() => { if (queues.get(id) === next) queues.delete(id); }).catch(() => undefined);
    return next;
  };
  let gatewayAvailable = !options.gatewayReady;
  void options.gatewayReady?.then(() => { gatewayAvailable = true; }).catch(() => undefined);
  const recoveries = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  const wantsEnabled = (plugin: PluginRecord) => plugin.desiredEnabled ?? ["active", "enabling"].includes(plugin.state);
  const needsGateway = (plugin: PluginRecord) => plugin.manifest.permissions.some(permission => permission.type === "host-service"
    && permission.services.some(name => ["collector", "recording", "event-sessions", "window-focus"].includes(name)));
  const cancelRecovery = (id: string) => {
    const recovery = recoveries.get(id); if (!recovery) return;
    recovery.controller.abort();
    // Abort an in-flight MCP handshake as well as a pending retry timer.
    void options.runtimeHost.deactivate(id).catch(() => undefined);
  };
  const restore = (id: string): Promise<void> => {
    const existing = recoveries.get(id); if (existing) return existing.promise;
    const controller = new AbortController(), signal = controller.signal;
    const promise = Promise.resolve().then(async () => {
      const initial = required(id);
      if (needsGateway(initial) && options.gatewayReady) {
        options.repository.setState(id, "enabling");
        await waitForPluginPromise(options.gatewayReady, signal);
      }
      const delays = options.restoreRetryDelaysMs ?? [500, 1_500, 5_000];
      for (let attempt = 0; !closing && !signal.aborted; attempt++) {
        try {
          const restored = await serial(id, async () => {
            const plugin = options.repository.get(id);
            if (!plugin || !wantsEnabled(plugin) || signal.aborted || closing) return false;
            compatible(plugin.manifest);
            if (missingFeatures(plugin.manifest).length) throw pluginError("plugin_incompatible", "Required Host capabilities are unavailable");
            assertEntitled(plugin.manifest);
            if (!hasAllPermissions(plugin)) throw pluginError("plugin_permission_denied", "Plugin permissions have changed");
            validateConfig(plugin, plugin.config);
            options.repository.setState(id, "enabling");
            await activateContributions(plugin, readSecrets(plugin, options.secretStore));
            const current = options.repository.get(id);
            if (signal.aborted || closing || !current || !wantsEnabled(current)) {
              await deactivateContributions(id).catch(() => undefined);
              if (current && !wantsEnabled(current)) options.repository.setState(id, "disabled");
              return false;
            }
            options.repository.setState(id, "active");
            return true;
          });
          if (restored) await options.onRestored?.().catch(error => console.warn(`Restored plugin tool refresh failed: ${errorMessage(error)}`));
          return;
        } catch (error) {
          if (signal.aborted || closing) return;
          const current = options.repository.get(id);
          if (!current || !wantsEnabled(current)) return;
          options.repository.setState(id, "failed", errorMessage(error));
          if (!transientPluginConnectionError(error) || attempt >= delays.length) return;
          await waitForPluginRetry(delays[attempt]!, signal);
        }
      }
    }).catch(error => {
      if (!signal.aborted && !closing && options.repository.get(id)) options.repository.setState(id, "failed", errorMessage(error));
    });
    recoveries.set(id, { controller, promise });
    void promise.finally(() => { if (recoveries.get(id)?.controller === controller) recoveries.delete(id); });
    return promise;
  };

  const service: PluginService = {
    isBusy: busy,
    list() {
      return options.repository.list().map((plugin) => withActivity({ ...publicPlugin(plugin), eligibility: eligibility(plugin.manifest) }));
    },
    async catalog() {
      const listed = await options.registry.list?.() ?? [];
      const manifests = new Map(listed.map((manifest) => [manifest.id, manifest]));
      const privatePluginIds = [...new Set(options.catalogPluginIds?.() ?? [])]
        .filter((pluginId) => !manifests.has(pluginId));
      const privateReleases = await Promise.allSettled(
        privatePluginIds.map((pluginId) => options.registry.resolve(pluginId))
      );
      for (const result of privateReleases) {
        if (result.status === "fulfilled") {
          manifests.set(result.value.manifest.id, result.value.manifest);
        }
      }
      return [...manifests.values()].filter((manifest) => eligibility(manifest).visible).map((manifest) => ({
        manifest, eligibility: eligibility(manifest),
        ...(options.repository.get(manifest.id) ? { installed: this.list().find((plugin) => plugin.id === manifest.id) } : {})
      }));
    },
    async suspend(id) {
      suspended.add(id);
      if (!activeCalls.get(id)) await this.disable(id);
    },

    get(id) {
      const plugin = required(id);
      return withActivity({ ...publicPlugin(plugin), eligibility: eligibility(plugin.manifest) });
    },

    async readUi(id, slot) {
      const plugin = required(id);
      const entry = plugin.manifest.ui?.[slot]?.entry;
      if (!entry) throw pluginError("plugin_unavailable", `Plugin has no UI ${slot}: ${id}`);
      return options.artifactManager.readTextFile(plugin, entry, 512 * 1024);
    },

    async openArtifact(id, token) {
      required(id);
      return localArtifacts.open(id, token);
    },

    async install(pluginId, version) {
      const release = await options.registry.resolve(pluginId, version);
      const manifest = PluginManifestSchema.parse(release.manifest);
      compatible(manifest);
      if (missingFeatures(manifest).length) throw pluginError("plugin_incompatible", `Missing Host capabilities: ${missingFeatures(manifest).join(", ")}`);
      if (manifest.id !== pluginId || (version && manifest.version !== version)) {
        throw pluginError("plugin_invalid", "Registry returned a different plugin release");
      }
      if (!options.runtimeHost.supports(manifest.runtime.adapter)) {
        throw pluginError("plugin_adapter_unsupported", `Unsupported plugin adapter: ${manifest.runtime.adapter}`);
      }
      assertEntitled(manifest);

      const existing = options.repository.get(pluginId);
      if (existing) {
        if (existing.version === manifest.version && manifestsEqual(existing.manifest, manifest)) {
          assertReleaseDigest(existing, release.artifact?.sha256);
          return publicPlugin(existing);
        }
        throw pluginError("conflict", `Plugin is already installed: ${pluginId}@${existing.version}`);
      }

      const artifact = await options.artifactManager.install({ ...release, manifest });
      try {
        return publicPlugin(options.repository.save({
          manifest,
          state: manifest.permissions.length ? "pending_approval" : "installed",
          nativeExecutionAllowed: release.nativeExecutionAllowed,
          registryOrigin: release.registryOrigin,
          ...artifact
        }));
      } catch (error) {
        await options.artifactManager.remove(artifact);
        throw error;
      }
    },

    async update(id, version) {
      if (closing) throw pluginError("plugin_unavailable", "Plugin host is shutting down");
      required(id);
      const current = updates.get(id);
      if (current) {
        if (current.version !== version) throw pluginError("conflict", "An update to another version is already pending");
        return current.promise;
      }
      const entry = { status: "waiting" as "waiting" | "installing", version, promise: undefined as unknown as Promise<InstalledPlugin> };
      updates.set(id, entry);
      entry.promise = Promise.resolve().then(async () => {
        try {
          // A gap between calls is not a task boundary. Keep serving the old
          // version until the Agent turn AND all capability iterators finish.
          for (;;) {
            while (activeCalls.get(id)) {
              if (closing) throw pluginError("plugin_unavailable", "Plugin host is shutting down");
              await new Promise<void>((resolve, reject) => idleWaiters.set(id, { resolve, reject }));
            }
            if (closing) throw pluginError("plugin_unavailable", "Plugin host is shutting down");
            const agentBusy = await options.hasActiveAgentTasks?.(shutdown.signal) ?? false;
            if (closing) throw pluginError("plugin_unavailable", "Plugin host is shutting down");
            // A call can start while the runtime status request is in flight.
            if (!agentBusy && !activeCalls.get(id) && !busy(id)) break;
            await delay(1_000, undefined, { signal: shutdown.signal });
          }
          return await serial(id, async () => {
            entry.status = "installing";
            const previous = required(id);
            const release = await options.registry.resolve(id, version);
            const manifest = PluginManifestSchema.parse(release.manifest);
            compatible(manifest);
            if (missingFeatures(manifest).length) throw pluginError("plugin_incompatible", `Missing Host capabilities: ${missingFeatures(manifest).join(", ")}`);
            if (manifest.id !== id || (version && manifest.version !== version)) {
              throw pluginError("plugin_invalid", "Registry returned a different plugin release");
            }
            if (!options.runtimeHost.supports(manifest.runtime.adapter)) {
              throw pluginError("plugin_adapter_unsupported", `Unsupported plugin adapter: ${manifest.runtime.adapter}`);
            }
            assertEntitled(manifest);
            if (previous.version === manifest.version) {
              if (!manifestsEqual(previous.manifest, manifest)) {
                throw pluginError("conflict", `Plugin release manifest changed: ${id}@${manifest.version}`);
              }
              assertReleaseDigest(previous, release.artifact?.sha256);
              return publicPlugin(previous);
            }

            const artifact = await options.artifactManager.install({ ...release, manifest });
            if (busy(id)) {
              if (artifact.rootPath !== previous.rootPath) await options.artifactManager.remove(artifact);
              throw pluginError("conflict", "Plugin became busy; update deferred");
            }
            const approvedPermissions = previous.approvedPermissions.filter((approved) =>
              manifest.permissions.some((declared) => permissionKey(approved) === permissionKey(declared))
            );
            const pendingApproval = !samePermissions(approvedPermissions, manifest.permissions);
            const draft: PluginRecord = {
              ...previous,
              nativeExecutionAllowed: release.nativeExecutionAllowed, registryOrigin: release.registryOrigin,
              version: manifest.version,
              manifest,
              approvedPermissions,
              state: pendingApproval ? "pending_approval" : "disabled",
              ...artifact
            };
            try {
              validateConfig(draft, draft.config);
              const secrets = pendingApproval ? {} : readSecrets(draft, options.secretStore);
              if (previous.state === "active") {
                options.repository.setState(id, "disabling");
                await deactivateContributions(id);
              }
              let updated = options.repository.save({
                manifest,
                state: draft.state,
                nativeExecutionAllowed: release.nativeExecutionAllowed, registryOrigin: release.registryOrigin,
                ...artifact
              });
              updated = options.repository.setApprovedPermissions(id, approvedPermissions);
              if (previous.state === "active" && !pendingApproval) {
                await activateContributions(updated, secrets);
                updated = options.repository.setState(id, "active");
              }
              if (artifact.rootPath !== previous.rootPath) await options.artifactManager.remove(previous);
              return publicPlugin(updated);
            } catch (error) {
              await deactivateContributions(id).catch(() => undefined);
              let restored = options.repository.save({
                manifest: previous.manifest,
                state: previous.state === "active" ? "disabled" : previous.state,
                artifactHash: previous.artifactHash,
                rootPath: previous.rootPath,
                nativeExecutionAllowed: previous.nativeExecutionAllowed, registryOrigin: previous.registryOrigin
              });
              restored = options.repository.setApprovedPermissions(id, previous.approvedPermissions);
              restored = options.repository.setConfig(id, previous.config);
              let rollbackError: unknown;
              if (previous.state === "active") {
                try {
                  await activateContributions(restored, readSecrets(restored, options.secretStore));
                  options.repository.setState(id, "active");
                } catch (restoreError) {
                  rollbackError = restoreError;
                  options.repository.setState(id, "failed", `Update rollback failed: ${errorMessage(restoreError)}`);
                }
              }
              if (artifact.rootPath !== previous.rootPath) await options.artifactManager.remove(artifact);
              if (rollbackError) {
                throw pluginError(
                  "plugin_activation_failed",
                  `Plugin update failed (${errorMessage(error)}) and rollback failed (${errorMessage(rollbackError)})`
                );
              }
              throw error;
            }
          });
        } finally {
          updates.delete(id);
          idleWaiters.delete(id);
        }
      });
      return entry.promise;
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
        options.repository.setState(id, "disabling");
        try {
          await deactivateContributions(id);
          options.repository.setState(id, "disabled");
        } catch (error) {
          options.repository.setState(id, "failed", errorMessage(error));
          throw pluginError("plugin_runtime_error", errorMessage(error));
        }
      }
      const updated = options.repository.setApprovedPermissions(id, approved);
      const next = updated.state === "pending_approval" && hasAllPermissions(updated)
        ? options.repository.setState(id, "installed")
        : updated;
      return publicPlugin(next);
    },

    async enable(id) {
      suspended.delete(id);
      const plugin = required(id);
      compatible(plugin.manifest);
      if (missingFeatures(plugin.manifest).length) throw pluginError("plugin_incompatible", "Required Host capabilities are unavailable");
      assertEntitled(plugin.manifest);
      if (plugin.state === "active") return publicPlugin(options.repository.setDesiredEnabled(id, true));
      if (!hasAllPermissions(plugin)) {
        throw pluginError("plugin_permission_denied", "Plugin permissions have not been approved");
      }
      validateConfig(plugin, plugin.config);
      const secrets = readSecrets(plugin, options.secretStore);
      options.repository.setDesiredEnabled(id, true);
      if (needsGateway(plugin) && options.gatewayReady && !gatewayAvailable) {
        const waiting = options.repository.setState(id, "enabling");
        void restore(id);
        return publicPlugin(waiting);
      }
      options.repository.setState(id, "enabling");
      try {
        await activateContributions(plugin, secrets);
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
        await deactivateContributions(id);
        return publicPlugin(options.repository.setState(id, "disabled"));
      } catch (error) {
        options.repository.setState(id, "failed", errorMessage(error));
        throw pluginError("plugin_runtime_error", errorMessage(error));
      }
    },

    async uninstall(id) {
      if (updates.has(id)) throw pluginError("conflict", "Wait for the pending plugin update before uninstalling");
      options.onSkillContentInvalidated?.(id);
      let plugin = required(id);
      if (plugin.state === "active" || plugin.state === "enabling" || plugin.state === "failed") {
        await this.disable(id);
        plugin = required(id);
      }
      await options.artifactManager.remove(plugin);
      await skillManager.deactivate(id);
      localArtifacts.revokePlugin(id);
      for (const key of declaredSecretKeys(plugin.manifest.permissions)) {
        options.secretStore.delete(secretRef(id, key));
      }
      options.repository.delete(id);
    },

    async *invoke(rawCall) {
      const call = CapabilityCallSchema.parse(rawCall);
      const plugin = required(call.pluginId);
      if (updates.get(plugin.id)?.status === "installing") throw pluginError("conflict", "Plugin update is being installed; retry after completion");
      if (plugin.state !== "active") throw pluginError("plugin_unavailable", `Plugin is not active: ${plugin.id}`);
      // Covers the window between a grant being revoked and the reconciler disabling the plugin.
      assertEntitled(plugin.manifest);
      if (!hasAllPermissions(plugin)) throw pluginError("plugin_permission_denied", "Plugin permissions have changed");
      if (!plugin.manifest.capabilities.some((capability) => capability.id === call.capabilityId)) {
        throw pluginError("plugin_unavailable", `Capability not found: ${call.capabilityId}`);
      }
      activeCalls.set(plugin.id, (activeCalls.get(plugin.id) ?? 0) + 1);
      const startedAt = Date.now();
      let outcome: "success" | "error" | "interrupted" = "interrupted";
      let errorCode: string | null = null;
      const publishedPaths = new Map<string, string>();
      try {
        for await (const event of options.runtimeHost.invoke(call)) {
          if (event.type === "result") outcome = "success";
          if (event.type === "error") {
            outcome = "error";
            errorCode = event.code;
          }
          if (event.type === "artifact") {
            const sourcePath = localArtifactPath(event.artifact.uri);
            const artifact = await localArtifacts.host(plugin, event.artifact, {
              conversationId: call.conversationId,
              taskId: capabilityTaskId(call.input),
              callId: call.callId
            });
            if (sourcePath && artifact.path) publishedPaths.set(sourcePath, artifact.path);
            yield { ...event, artifact };
            continue;
          }
          yield event.type === "result" && publishedPaths.size
            ? { ...event, output: replacePublishedPaths(event.output, publishedPaths) }
            : event;
        }
      } catch (error) {
        outcome = "error";
        errorCode = typeof (error as { code?: unknown })?.code === "string"
          ? (error as { code: string }).code
          : "plugin_runtime_error";
        throw error;
      } finally {
        activeCalls.set(plugin.id, (activeCalls.get(plugin.id) ?? 1) - 1);
        if (!activeCalls.get(plugin.id)) {
          try { if (suspended.has(plugin.id)) await this.disable(plugin.id); }
          finally { idleWaiters.get(plugin.id)?.resolve(); }
        }
        try {
          options.repository.recordCall({
            callId: call.callId,
            pluginId: plugin.id,
            pluginVersion: plugin.version,
            capabilityId: call.capabilityId,
            adapterId: plugin.manifest.runtime.adapter,
            durationMs: Date.now() - startedAt,
            outcome,
            errorCode
          });
        } catch (error) {
          console.warn(`Plugin call audit write failed: ${errorMessage(error)}`);
        }
      }
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
      if (closing) return;
      for (const plugin of options.repository.list().filter(plugin => wantsEnabled(plugin) && plugin.state !== "pending_approval")) {
        if (!eligibility(plugin.manifest).canUse) {
          options.repository.setState(plugin.id, "disabled");
          continue;
        }
        const recovery = restore(plugin.id);
        // Preserve Windows' first-window optimization. Gateway-backed workers
        // wait independently; local plugins retain the existing startup flow.
        if (!(needsGateway(plugin) && options.gatewayReady)) await recovery;
      }
    },

    async shutdown() {
      closing = true;
      shutdown.abort();
      for (const waiter of idleWaiters.values()) waiter.reject(pluginError("plugin_unavailable", "Plugin host is shutting down"));
      const restoring = [...recoveries.values()];
      for (const id of recoveries.keys()) cancelRecovery(id);
      await Promise.allSettled(restoring.map(job => job.promise));
      options.onSkillContentInvalidated?.();
      await Promise.allSettled(options.repository.list()
        .filter((plugin) => plugin.state === "active" || plugin.state === "enabling")
        .map((plugin) => deactivateContributions(plugin.id)));
    }
  };
  // Serialize lifecycle mutations per plugin. Internal calls use the unwrapped
  // service, so uninstall -> disable cannot deadlock against its own queue.
  return { ...service,
    install: (id, version) => serial(id, () => service.install(id, version)),
    update: (id, version) => service.update(id, version),
    enable: async id => {
      // A successful restore can still be refreshing the Agent catalog. A
      // duplicate enable must not tear down that already active worker.
      if (options.repository.get(id)?.state === "active") return serial(id, () => service.enable(id));
      const previous = recoveries.get(id); cancelRecovery(id);
      await previous?.promise;
      return serial(id, () => service.enable(id));
    },
    disable: async id => {
      options.repository.setDesiredEnabled(id, false); cancelRecovery(id);
      return serial(id, () => service.disable(id));
    },
    uninstall: async id => {
      options.repository.setDesiredEnabled(id, false); cancelRecovery(id);
      return serial(id, () => service.uninstall(id));
    },
    approvePermissions: (id, permissions) => serial(id, () => service.approvePermissions(id, permissions))
  };
}

function transientPluginConnectionError(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  if (code && ["plugin_permission_denied", "plugin_entitlement_required", "plugin_invalid", "plugin_incompatible"].includes(code)) return false;
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|fetch failed|socket hang up|connection (?:closed|reset)|\b(?:502|503|504)\b/i.test(errorMessage(error));
}
function waitForPluginPromise<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}
function waitForPluginRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms); timer.unref();
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}

function capabilityTaskId(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const taskId = (input as Record<string, unknown>).taskId;
  return typeof taskId === "string" && taskId.trim() ? taskId.trim() : undefined;
}

function localArtifactPath(uri: string): string | null {
  try {
    const url = new URL(uri);
    return url.protocol === "file:" ? fileURLToPath(url) : null;
  } catch {
    return null;
  }
}

function replacePublishedPaths(value: unknown, paths: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return paths.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => replacePublishedPaths(item, paths));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    replacePublishedPaths(item, paths)
  ]));
}

function publicPlugin(plugin: PluginRecord): InstalledPlugin {
  const { artifactHash: _artifactHash, rootPath: _rootPath,
    nativeExecutionAllowed: _native, registryOrigin: _origin, ...result } = plugin;
  return result;
}

export function compareVersions(left: string, right: string): number {
  const split = (value: string) => { const [core, ...suffix] = value.split("-"); return { core: core!.split(".").map(Number), suffix: suffix.join("-") }; };
  const a = split(left), b = split(right);
  for (let i = 0; i < 3; i++) { const delta = (a.core[i] ?? 0) - (b.core[i] ?? 0); if (delta) return delta; }
  if (!a.suffix || !b.suffix) return a.suffix === b.suffix ? 0 : a.suffix ? -1 : 1;
  const ap = a.suffix.split("."), bp = b.suffix.split(".");
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (ap[i] === bp[i]) continue;
    if (ap[i] === undefined || bp[i] === undefined) return ap[i] === undefined ? -1 : 1;
    const an = /^\d+$/.test(ap[i]!), bn = /^\d+$/.test(bp[i]!);
    return an && bn ? Number(ap[i]) - Number(bp[i]) : an !== bn ? an ? -1 : 1 : ap[i]! < bp[i]! ? -1 : 1;
  }
  return 0;
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
  switch (permission.type) {
    case "network": return JSON.stringify([permission.type, [...permission.hosts].sort()]);
    case "filesystem": return JSON.stringify([permission.type, permission.access, [...permission.paths].sort()]);
    case "secret": return JSON.stringify([permission.type, [...permission.keys].sort()]);
    case "host-service": return JSON.stringify([permission.type, [...permission.services].sort()]);
  }
}

function manifestsEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertReleaseDigest(plugin: Pick<PluginRecord, "id" | "version" | "artifactHash">, sha256?: string): void {
  if (plugin.artifactHash !== (sha256?.toLowerCase() ?? null)) {
    throw pluginError("conflict", `Plugin release digest changed: ${plugin.id}@${plugin.version}`);
  }
}

function pluginError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
