/** Reconciles entitlement-gated plugins against the grants held by the signed-in account. */
import type { PluginCatalogEntry } from "@memmy/local-api-contracts";
import { pluginRules } from "./plugin-rules.js";
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
  userUninstalledIds?: ReadonlySet<string>;
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
async function reconcileOnce(
  options: ReconcileEntitledPluginsOptions
): Promise<PluginEntitlementFailure[]> {
  const failures: PluginEntitlementFailure[] = [];
  const granted = new Set(options.entitlements);

  let catalog: PluginCatalogEntry[];
  try { catalog = await options.plugins.catalog?.() ?? []; }
  catch (error) {
    failures.push({ pluginId: "catalog", message: String(error) });
    catalog = [];
  }
  const declared = new Map(catalog.map((entry) => [entry.manifest.id, entry]));
  const candidates = new Set([
    // Private plugins may deliberately be omitted from the public catalog.
    // Their server-issued entitlement is the discovery signal; resolve still
    // authenticates the account and returns an immutable release descriptor.
    ...entitledPluginIds(options.entitlements),
    ...catalog.filter((entry) => entry.eligibility.canInstall && pluginRules(entry.manifest).installation === "automatic").map((entry) => entry.manifest.id)
  ]);
  for (const pluginId of candidates) {
    if (options.userUninstalledIds?.has(pluginId)) continue;
    if (declared.has(pluginId) && !declared.get(pluginId)!.eligibility.canInstall) continue;
    try {
      const existing = options.plugins.list().find((plugin) => plugin.id === pluginId);
      if (existing?.update) continue;
      // Freeze the catalog selection across resolve/download, even if the server default changes.
      const entry = declared.get(pluginId);
      // Publishing a new catalog entry never authorizes replacing an installed
      // plugin. Updates are an explicit user action, including legacy manifests
      // with autoUpdate=true and entitlement-only/offline catalog paths.
      let plugin = existing ?? (entry
        ? await options.plugins.install(pluginId, entry.manifest.version)
        : await options.plugins.install(pluginId));
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
    if (installed.eligibility ? installed.eligibility.canUse : (!required || granted.has(required))) continue;
    if (installed.state !== "active" && installed.state !== "enabling") continue;
    try {
      if (options.plugins.suspend) await options.plugins.suspend(installed.id);
      else await options.plugins.disable(installed.id);
    } catch (error) {
      failures.push({
        pluginId: installed.id,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return failures;
}

// Login, panel refresh and startup may overlap; serialize installation decisions per Host.
const reconciliations = new WeakMap<PluginService, Promise<PluginEntitlementFailure[]>>();
export function reconcileEntitledPlugins(options: ReconcileEntitledPluginsOptions): Promise<PluginEntitlementFailure[]> {
  const previous = reconciliations.get(options.plugins) ?? Promise.resolve([]);
  const next = previous.catch(() => []).then(() => reconcileOnce(options));
  reconciliations.set(options.plugins, next);
  return next;
}
