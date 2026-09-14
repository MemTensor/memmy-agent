/** Reconciles entitlement-gated plugins against the grants held by the signed-in account. */
import type { PluginService } from "./plugin-service.js";

/** Prefix of an account grant that names an installable plugin, e.g. `plugin:literature-review`. */
export const PLUGIN_ENTITLEMENT_PREFIX = "plugin:";

export interface PluginEntitlementFailure {
  pluginId: string;
  message: string;
}

export interface ReconcileEntitledPluginsOptions {
  plugins: PluginService;
  /** Grants held by the active account; empty when signed out. */
  entitlements: readonly string[];
}

/** Derives the plugin ids an account is entitled to install. */
export function entitledPluginIds(entitlements: readonly string[]): string[] {
  return [...new Set(
    entitlements
      .filter((entitlement) => entitlement.startsWith(PLUGIN_ENTITLEMENT_PREFIX))
      .map((entitlement) => entitlement.slice(PLUGIN_ENTITLEMENT_PREFIX.length).trim())
      .filter((pluginId) => pluginId.length > 0)
  )];
}

/**
 * Installs and enables every plugin the account is entitled to, and disables
 * the ones whose grant has been revoked.
 *
 * Revoked plugins are disabled rather than uninstalled so a mistaken or
 * temporary revocation does not destroy locally generated plugin data.
 *
 * Failures are collected per plugin instead of thrown: a registry outage or one
 * broken release must not prevent the rest of the app from starting.
 */
export async function reconcileEntitledPlugins(
  options: ReconcileEntitledPluginsOptions
): Promise<PluginEntitlementFailure[]> {
  const failures: PluginEntitlementFailure[] = [];
  const granted = new Set(options.entitlements);

  for (const pluginId of entitledPluginIds(options.entitlements)) {
    try {
      const existing = options.plugins.list().find((plugin) => plugin.id === pluginId);
      // The registry resolves the version for this app build, so no version is pinned here.
      let plugin = existing
        ? await options.plugins.update(pluginId)
        : await options.plugins.install(pluginId);
      plugin = await options.plugins.approvePermissions(pluginId, plugin.manifest.permissions);
      if (plugin.state !== "active") {
        await options.plugins.enable(pluginId);
      }
    } catch (error) {
      failures.push({
        pluginId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  for (const installed of options.plugins.list()) {
    const required = installed.manifest.requiredEntitlement;
    if (!required || granted.has(required)) continue;
    if (installed.state !== "active" && installed.state !== "enabling") continue;
    try {
      await options.plugins.disable(installed.id);
    } catch (error) {
      failures.push({
        pluginId: installed.id,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return failures;
}
