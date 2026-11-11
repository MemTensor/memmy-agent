import { notifyPluginChange, PLUGIN_CHANGE_EVENT } from "../lib/plugin-change-event.js";
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
import { resolveLanguage } from "../i18n/messages.js";
import { officialPluginCatalog } from "./official-plugin-catalog.js";

/** Live marketplace: installed state is always read back from the plugin host. */
export function PluginMarketplace() {
  const { clients } = useApiClients();
  const { state, dispatch } = useAppState();
  const { t, language } = useTranslation();
  const [catalog, setCatalog] = useState<PluginCatalogEntry[] | null>(null);
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionErrorPluginId, setActionErrorPluginId] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [officialModelReady, setOfficialModelReady] = useState<boolean | undefined>(undefined);
  const busy = useRef(false);
  const generation = useRef(0);
  const hostCompletion = useRef<{
    matches: (plugins: InstalledPlugin[]) => boolean;
    resolve: (failed: boolean) => void;
    failed: (plugins: InstalledPlugin[]) => boolean;
  } | null>(null);

  const refresh = useCallback(async (options: { preserveActionError?: boolean } = {}) => {
    if (!clients) return;
    const current = ++generation.current;
    setLoading(true);
    if (!options.preserveActionError) setActionError(null);
    let installedRead = 0;
    async function loadInstalled() {
      const read = ++installedRead;
      try {
        const plugins = await clients!.plugins.list();
        if (generation.current !== current || read !== installedRead) return;
        setInstalled(plugins);
        setError(null);
      } catch {
        if (generation.current !== current || read !== installedRead) return;
        setError(t("plugins.ui.couldNotLoadPluginsPleaseTryAgain"));
      } finally {
        if (generation.current === current && read === installedRead) setLoading(false);
      }
    }
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
    // Installation state belongs to the local Host. Load it independently so a
    // slow or unavailable remote registry cannot empty the user's plugin list.
    void (async () => {
      try {
        await clients.account?.getSession?.();
        if (generation.current !== current) return;
        // list() includes eligibility from the refreshed account grants. An
        // installed private plugin can disappear from the remote catalog.
        void loadInstalled();
        const entries = await clients.plugins.catalog?.();
        if (generation.current !== current) return;
        if (entries) setCatalog(entries);
        setCatalogError(null);
      } catch {
        if (generation.current === current) setCatalogError(t("plugins.ui.catalogUnavailable"));
      }
    })();
    await loadInstalled();
  }, [clients, t, state.account.userId]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => { if (!busy.current) void refresh(); }, 30_000);
    return () => { generation.current += 1; window.clearInterval(interval); };
  }, [refresh]);

  // Plugin lifecycle can finish in the Host after the original enable request
  // has returned (or after another surface changed it).  The marketplace must
  // refresh on the local change signal instead of waiting for navigation or
  // the 30-second background refresh interval.
  useEffect(() => {
    const onPluginChange = () => { void refresh({ preserveActionError: true }); };
    window.addEventListener(PLUGIN_CHANGE_EVENT, onPluginChange);
    return () => window.removeEventListener(PLUGIN_CHANGE_EVENT, onPluginChange);
  }, [refresh]);

  const hasHostTransition = installed.some(plugin => plugin.state === "enabling" || plugin.state === "disabling" || plugin.update);
  useEffect(() => {
    if (!clients || (!busyId && !hasHostTransition)) return;
    let disposed = false, reading = false;
    const timer = window.setInterval(() => {
      if (reading) return;
      reading = true;
      void clients.plugins.list().then(plugins => {
        if (disposed) return;
        setInstalled(plugins);
        // The Host may have committed the lifecycle change while the original
        // HTTP response is still waiting (e.g. for Agent tool publication).
        const completion = hostCompletion.current;
        if (completion?.matches(plugins)) completion.resolve(false);
        else if (completion?.failed(plugins)) completion.resolve(true);
      }, () => undefined).finally(() => { reading = false; });
    }, 1_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [clients, busyId, hasHostTransition]);

  async function mutate(plugin: MarketplacePlugin, operation: () => Promise<unknown>,
    matches: (plugins: InstalledPlugin[]) => boolean) {
    if (!clients || loading || busy.current || error) return;
    busy.current = true;
    setBusyId(plugin.id);
    setActionError(null);
    setActionErrorPluginId(null);
    let failed = false;
    const completion = {
      matches,
      failed: (records: InstalledPlugin[]) => records.some(record => record.id === plugin.id
        && record.state === "failed" && !record.update
        && (plugin.installed?.state !== "failed" || record.updatedAt !== plugin.installed.updatedAt)),
      resolve: (_failed: boolean) => {}
    };
    const committed = new Promise<{ failed: boolean; fromHost: boolean }>(resolve => {
      completion.resolve = failed => resolve({ failed, fromHost: true });
    });
    hostCompletion.current = completion;
    try {
      // Observe both channels. Late rejection of the original request is handled
      // even when polling has already confirmed the committed result.
      const outcome = await Promise.race([
        operation().then(() => ({ failed: false, fromHost: false }), () => ({ failed: true, fromHost: false })),
        committed
      ]);
      failed = outcome.failed;
      // A confirmed Host result must not wait on another HTTP read to clear busy.
      const refreshed = refresh();
      if (!outcome.fromHost) await refreshed;
      if (failed) {
        setActionError(t("plugins.ui.couldNotCompleteTheActionForPleaseTry", { name: plugin.name }));
        setActionErrorPluginId(plugin.id);
      }
    } finally {
      if (hostCompletion.current === completion) hostCompletion.current = null;
      notifyPluginChange();
      setBusyId(null);
      busy.current = false;
    }
  }

  async function activateOfficialPlugin(plugin: InstalledPlugin) {
    // Only this official catalog combines permission approval with installation.
    await clients!.plugins.approvePermissions(plugin.id, plugin.manifest.permissions);
    await clients!.plugins.enable(plugin.id);
  }

  const plugins = marketplacePlugins(catalog, installed, language);

  return <>
    {modelError && <p role="alert" className="mb-4 text-sm text-text-ink/60">{modelError}</p>}
    <PluginMarketplaceSection
    plugins={plugins}
    loading={loading}
    error={error ?? catalogError}
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
      }, records => records.some(record => record.id === plugin.id && record.state === "active" && record.version === plugin.version));
    }}
    onUpdate={(plugin) => {
      if (!plugin.installable || !plugin.installed || !plugin.version || !isNewerPluginVersion(plugin.version, plugin.installed.version)) return;
      void mutate(plugin, async () => {
        const updated = await clients!.plugins.update(plugin.id, plugin.version!);
        if (updated.state === "pending_approval") {
          await clients!.plugins.approvePermissions(updated.id, updated.manifest.permissions);
          if (plugin.installed?.state === "active") await clients!.plugins.enable(updated.id);
        }
      }, records => records.some(record => record.id === plugin.id && record.version === plugin.version
        && !record.update && record.state === plugin.installed!.state));
    }}
    onEnable={(plugin) => {
      const installedPlugin = plugin.installed;
      if (!installedPlugin) return;
      void mutate(plugin, () => activateOfficialPlugin(installedPlugin),
        records => records.some(record => record.id === plugin.id && record.state === "active"));
    }}
    onUninstall={(plugin) => void mutate(plugin, () => clients!.plugins.uninstall(plugin.id),
      records => !records.some(record => record.id === plugin.id))}
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

/** Merge the remote catalog with Host state, including plugins missing from that catalog. */
export function marketplacePlugins(catalog: PluginCatalogEntry[] | null, installed: InstalledPlugin[], language = "en-US"): MarketplacePlugin[] {
  const installedById = new Map(installed.map((plugin) => [plugin.id, plugin]));
  const listed = new Set((catalog ?? []).map((entry) => entry.manifest.id));
  const plugins = (catalog ?? []).filter((entry) => entry.eligibility.visible
    && installedById.get(entry.manifest.id)?.eligibility?.visible !== false).map((entry): MarketplacePlugin => {
    const local = installedById.get(entry.manifest.id);
    return {
      id: entry.manifest.id, name: entry.manifest.name, eligibility: entry.eligibility,
      description: entry.manifest.capabilities[0]?.description ?? "",
      category: pluginCategory(entry.manifest.id), version: entry.manifest.version,
      requiresLogin: entry.eligibility.reason === "login_required" || entry.manifest.rules?.requiresLogin,
      requiresOfficialModel: entry.manifest.rules?.recommendsOfficialModel,
      installable: entry.eligibility.canInstall,
      ...(local ? { installed: local } : {})
    };
  });
  for (const local of installed) {
    if (listed.has(local.id) || local.eligibility?.visible === false) continue;
    plugins.push({
      id: local.id, name: local.manifest.name,
      description: local.manifest.capabilities[0]?.description ?? "",
      category: pluginCategory(local.id), version: local.version,
      requiresLogin: local.manifest.rules?.requiresLogin,
      requiresOfficialModel: local.manifest.rules?.recommendsOfficialModel,
      // The installed version is usable; a new release needs a registry entry.
      installable: false, eligibility: local.eligibility, installed: local
    });
  }
  if (resolveLanguage(language) !== "zh-CN") return plugins;
  // Registry manifests describe runtime tools in English. Use the official UI
  // copy for these plugins, including when only the installed record is available.
  const localized = new Map(officialPluginCatalog({ language, installed: [] })
    .filter((plugin) => plugin.id === "literature-review" || plugin.id === "office")
    .map((plugin) => [plugin.id, plugin]));
  return plugins.map((plugin) => {
    const presentation = localized.get(plugin.id);
    return presentation ? { ...plugin, name: presentation.name, description: presentation.description } : plugin;
  });
}

function pluginCategory(pluginId: string): MarketplacePlugin["category"] {
  if (pluginId === "legal-labor") return "legal";
  if (pluginId === "literature-review") return "research";
  if (pluginId === "office") return "office";
  return "other";
}
