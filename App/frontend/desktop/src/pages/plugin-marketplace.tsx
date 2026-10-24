import { useCallback, useEffect, useRef, useState } from "react";
import type { InstalledPlugin, PluginCatalogEntry } from "@memmy/local-api-contracts";
import { useApiClients } from "../app/providers.js";
import { useTranslation } from "../i18n/use-translation.js";
import { agentActions, appActions } from "../state/app-actions.js";
import { agentChatScopeKey } from "../state/agent-composer-state.js";
import { useAppState } from "../state/app-state.js";
import {
  addPluginCommandToDraft,
  PluginMarketplaceSection,
  pluginComposerCommand,
  type MarketplacePlugin
} from "./plugin-marketplace-section.js";
import { writeSettingsTabHash } from "./settings-nav.js";
import { isNewerPluginVersion } from "./plugin-version.js";

/** Live marketplace: installed state is always read back from the plugin host. */
export function PluginMarketplace() {
  const { clients } = useApiClients();
  const { state, dispatch } = useAppState();
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<PluginCatalogEntry[] | null>(null);
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionErrorPluginId, setActionErrorPluginId] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [officialModelReady, setOfficialModelReady] = useState<boolean | undefined>(undefined);
  const busy = useRef(false);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (!clients) return;
    const current = ++generation.current;
    setLoading(true);
    setActionError(null);
    // Model readiness is supplementary; never hold the catalog behind this request.
    void clients.config.getModelConfig().then((model) => {
      if (generation.current !== current) return;
      setModelError(null);
      setOfficialModelReady(Boolean(state.account.userId)
      && Boolean(model.catalog?.effectiveCandidates.account.some((candidate) => (
        candidate.source === "account" && candidate.available && candidate.capabilities.includes("agent")
        && candidate.ownerAccountId === state.account.userId
      ))));
    }, () => {
      if (generation.current !== current) return;
      setOfficialModelReady(undefined);
      setModelError(t("plugins.ui.couldNotReadModelSettingsRefreshToCheck"));
    });
    try {
      await clients.account?.getSession?.();
      const entries = await clients.plugins.catalog?.();
      if (generation.current === current && entries) setCatalog(entries);
      const plugins = await clients.plugins.list();
      if (generation.current !== current) return;
      setInstalled(plugins);
      if (entries) setCatalog(entries);
      setError(null);
    } catch {
      if (generation.current !== current) return;
      setError(t("plugins.ui.couldNotLoadPluginsPleaseTryAgain"));
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, [clients, t, state.account.userId]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => { if (!busy.current) void refresh(); }, 30_000);
    return () => { generation.current += 1; window.clearInterval(interval); };
  }, [refresh]);

  async function mutate(plugin: MarketplacePlugin, operation: () => Promise<unknown>) {
    if (!clients || loading || busy.current || error) return;
    busy.current = true;
    setBusyId(plugin.id);
    setActionError(null);
    setActionErrorPluginId(null);
    let failed = false;
    try {
      try { await operation(); } catch { failed = true; }
      // Read back even after partial failure (e.g. installed but activation failed).
      await refresh();
      if (failed) {
        setActionError(t("plugins.ui.couldNotCompleteTheActionForPleaseTry", { name: plugin.name }));
        setActionErrorPluginId(plugin.id);
      }
    } finally {
      setBusyId(null);
      busy.current = false;
    }
  }

  async function activateOfficialPlugin(plugin: InstalledPlugin) {
    // Only this official catalog combines permission approval with installation.
    await clients!.plugins.approvePermissions(plugin.id, plugin.manifest.permissions);
    await clients!.plugins.enable(plugin.id);
  }

  const plugins: MarketplacePlugin[] = catalog ? catalog.map((entry) => ({
    id: entry.manifest.id, name: entry.manifest.name, eligibility: entry.eligibility,
    description: entry.manifest.capabilities[0]?.description ?? "",
    category: pluginCategory(entry.manifest.id), version: entry.manifest.version,
    requiresLogin: entry.eligibility.reason === "login_required" || entry.manifest.rules?.requiresLogin,
    requiresOfficialModel: entry.manifest.rules?.recommendsOfficialModel,
    installable: entry.eligibility.canInstall,
    installed: installed.find((plugin) => plugin.id === entry.manifest.id)
  })) : [];

  return <>
    {modelError && <p role="alert" className="mb-4 text-sm text-text-ink/60">{modelError}</p>}
    <PluginMarketplaceSection
    plugins={plugins}
    loading={loading}
    error={error}
    actionError={actionError}
    actionErrorPluginId={actionErrorPluginId}
    busyId={busyId}
    actionsDisabled={!clients || Boolean(error)}
    officialModelReady={officialModelReady}
    signedIn={Boolean(state.account.userId)}
    onRefresh={() => void refresh()}
    onInstall={(plugin) => {
      if (!plugin.installable) return;
      void mutate(plugin, async () => {
        const installedPlugin = await clients!.plugins.install(plugin.id, plugin.version);
        await activateOfficialPlugin(installedPlugin);
      });
    }}
    onUpdate={(plugin) => {
      if (!plugin.installable || !plugin.installed || !plugin.version || !isNewerPluginVersion(plugin.version, plugin.installed.version)) return;
      void mutate(plugin, async () => {
        const updated = await clients!.plugins.update(plugin.id, plugin.version!);
        // The host preserves active/disabled state and rolls back failed updates.
        // Official plugins with new permissions follow the same approval flow as installation.
        if (updated.state === "pending_approval") {
          await clients!.plugins.approvePermissions(updated.id, updated.manifest.permissions);
          if (plugin.installed?.state === "active") await clients!.plugins.enable(updated.id);
        }
      });
    }}
    onEnable={(plugin) => {
      const installedPlugin = plugin.installed;
      if (!installedPlugin) return;
      void mutate(plugin, () => activateOfficialPlugin(installedPlugin));
    }}
    onUninstall={(plugin) => void mutate(plugin, () => clients!.plugins.uninstall(plugin.id))}
    onAddToChat={(plugin) => {
      const command = pluginComposerCommand(plugin);
      if (command) {
        const scopeKey = agentChatScopeKey(state.agent.currentChatId, state.agent.newChatRequestId);
        dispatch(agentActions.composerDraftUpdated(
          scopeKey,
          addPluginCommandToDraft(command, state.agent.composerDraftsByScope[scopeKey] ?? "")
        ));
      }
      dispatch(appActions.navigate("/main"));
    }}
    onConfigureModel={() => {
      writeSettingsTabHash(state.account.userId ? "model" : "account");
      dispatch(appActions.navigate("/settings"));
    }}
    onSignIn={() => dispatch(appActions.navigate("/welcome"))}
    />
  </>;
}

function pluginCategory(pluginId: string): MarketplacePlugin["category"] {
  if (pluginId === "legal-labor") return "legal";
  if (pluginId === "literature-review") return "research";
  if (pluginId === "office") return "office";
  return "other";
}
