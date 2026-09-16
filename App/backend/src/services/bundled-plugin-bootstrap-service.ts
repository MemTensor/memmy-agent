/** Idempotent startup reconciliation for immutable first-party desktop plugins. */
import type { BundledPluginRelease } from "../adapters/outbound/plugin-registry/index.js";
import type { PluginService } from "./plugin-service.js";

export interface BundledPluginBootstrapFailure {
  pluginId: string;
  message: string;
}

export interface ReconcileBundledPluginsOptions {
  plugins: PluginService;
  releases: readonly BundledPluginRelease[];
  enabledById: Readonly<Record<string, boolean>>;
}

export interface SuppressBundledPluginsOptions extends ReconcileBundledPluginsOptions {
  managedPluginIds: readonly string[];
}

/**
 * Deactivates persisted bundled plugins that the current distribution omitted
 * or explicitly disabled, while preserving their artifacts and task data.
 */
export async function suppressBundledPlugins(
  options: SuppressBundledPluginsOptions
): Promise<BundledPluginBootstrapFailure[]> {
  const releaseIds = new Set(options.releases.map((release) => release.id));
  const failures: BundledPluginBootstrapFailure[] = [];
  for (const pluginId of options.managedPluginIds) {
    if (releaseIds.has(pluginId) && options.enabledById[pluginId] !== false) continue;
    const installed = options.plugins.list().find((plugin) => plugin.id === pluginId);
    if (!installed || !["active", "enabling", "failed"].includes(installed.state)) continue;
    try {
      await options.plugins.disable(pluginId);
    } catch (error) {
      failures.push({
        pluginId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return failures;
}

/**
 * Installs or upgrades trusted bundled releases, grants their fixed declared
 * permissions, and applies the config.yaml desired state without deleting data.
 */
export async function reconcileBundledPlugins(
  options: ReconcileBundledPluginsOptions
): Promise<BundledPluginBootstrapFailure[]> {
  const failures: BundledPluginBootstrapFailure[] = [];
  for (const release of options.releases) {
    try {
      const existing = options.plugins.list().find((plugin) => plugin.id === release.id);
      let plugin = existing
        ? existing.version === release.version
          ? await options.plugins.install(release.id, release.version)
          : await options.plugins.update(release.id, release.version)
        : await options.plugins.install(release.id, release.version);

      plugin = await options.plugins.approvePermissions(release.id, plugin.manifest.permissions);
      if (options.enabledById[release.id] !== false) {
        await options.plugins.enable(release.id);
      } else {
        await options.plugins.disable(release.id);
      }
    } catch (error) {
      failures.push({
        pluginId: release.id,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return failures;
}
