import "./plugin-tools-layout.css";
import { usePluginUpdateAvailable, PluginUpdateDot } from "./plugin-update-indicator.js";
/** Tools page module. */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, Link2, MessageCircle, Puzzle, RefreshCw } from "lucide-react";
import { SearchField } from "../components/search-field.js";
import { useApiClients } from "../app/providers.js";
import { PRODUCT_TOUR_TOOLS_CONTENT_ANCHOR } from "../app/product-tour-layout.js";
import type { ChannelsClient } from "../api/channels-client.js";
import type { IntegrationsClient } from "../api/integrations-client.js";
import { ConnectChannelModal } from "../components/connect-channel-modal.js";
import { ConnectIntegrationModal } from "../components/connect-integration-modal.js";
import { Memmy } from "../components/mascot/memmy.js";
import { CATEGORY_TABS, getAllIntegrationMeta, type IntegrationCategoryTab, type IntegrationMeta } from "../integrations/integration-meta.js";
import { deriveIntegrationState } from "../integrations/connection-state.js";
import { useTranslation } from "../i18n/use-translation.js";
import { appActions, loadToolConnectionRecords, toolsActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import { selectConnectionForIntegration, selectStatusPrioritizedIntegrations, selectVisibleIntegrations, type ToolsState } from "../state/tools-slice.js";
import { AppFrame } from "./app-frame.js";
import { PluginMarketplace } from "./plugin-marketplace.js";
import { ConnectionCatalogSection } from "./connection-catalog-section.js";
import "./plugin-marketplace.css";

export type ToolsSection = "connections" | "channels" | "plugins";
export type ConnectionCatalogFilter = "all" | "connected";

const CONNECTION_REFRESH_INTERVAL_MS = 5_000;

/** Contract for tools page view props. */
export interface ToolsPageViewProps {
  tools: ToolsState;
  client?: IntegrationsClient;
  channelsClient?: ChannelsClient;
  search?: string;
  searchBySection?: Record<"connections" | "channels", string>;
  filterBySection?: Record<"connections" | "channels", ConnectionCatalogFilter>;
  activeCategory?: IntegrationCategoryTab;
  section?: ToolsSection;
  connectionFilter?: ConnectionCatalogFilter;
  onConnectionFilterChange?: (filter: ConnectionCatalogFilter, section?: "connections" | "channels") => void;
  marketplace?: ReactNode;
  pluginUpdatesAvailable?: boolean;
  pluginFilter?: "all" | "installed";
  pluginInstalledCount?: number;
  onPluginFilterChange?: (filter: "all" | "installed") => void;
  pluginSearch?: string;
  onPluginSearchChange?: (value: string) => void;
  onPluginRefresh?: () => void;
  onSectionChange?: (section: ToolsSection) => void;
  onSearchChange: (value: string, section?: "connections" | "channels") => void;
  onCategoryChange: (category: IntegrationCategoryTab) => void;
  onOpenIntegration: (integration: IntegrationMeta) => void;
  onModalClose: () => void;
  onConnectionsChanged: () => void;
}

/** Handles tools page. */
export function ToolsPage() {
  const { state, dispatch } = useAppState();
  const { clients } = useApiClients();
  const pluginUpdatesAvailable = usePluginUpdateAvailable(clients?.plugins, state.account.userId);
  const [searchBySection, setSearchBySection] = useState({ connections: "", channels: "" });
  const [filterBySection, setFilterBySection] = useState<Record<"connections" | "channels", ConnectionCatalogFilter>>({ connections: "all", channels: "all" });
  const [activeCategory, setActiveCategory] = useState<IntegrationCategoryTab>("All");
  const [section, setSection] = useState<ToolsSection>("connections");
  const [pluginFilter, setPluginFilter] = useState<"all" | "installed">("all");
  const [pluginInstalledCount, setPluginInstalledCount] = useState(0);
  const [pluginSearch, setPluginSearch] = useState("");
  const [pluginRefreshRequestId, setPluginRefreshRequestId] = useState(0);

  useEffect(() => {
    if (section === "plugins" || !clients || !shouldLoadConnectionsForPage(state.tools.status)) {
      return;
    }

    void toolsActions.loadConnections(clients.integrations, clients.channels, dispatch);
  }, [clients, dispatch, section, state.tools.status]);

  useEffect(() => {
    if (section === "plugins" || !clients || state.tools.status !== "ready") {
      return undefined;
    }

    const interval = window.setInterval(() => {
      void toolsActions.refreshConnections(clients.integrations, clients.channels, dispatch);
    }, CONNECTION_REFRESH_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [clients, dispatch, section, state.tools.status]);

  const openIntegration = useCallback(
    (integration: IntegrationMeta) => {
      dispatch(appActions.openToolConnectModal(integration));
    },
    [dispatch]
  );

  const closeModal = useCallback(() => {
    dispatch(appActions.closeToolModal());
  }, [dispatch]);

  const refreshConnections = useCallback(() => {
    if (!clients) {
      return;
    }

    void toolsActions.refreshConnections(clients.integrations, clients.channels, dispatch);
  }, [clients, dispatch]);

  const changeCatalogSearch = useCallback((value: string, target: "connections" | "channels" = "connections") => {
    setSearchBySection((current) => ({ ...current, [target]: value }));
  }, []);
  const changeCatalogFilter = useCallback((value: ConnectionCatalogFilter, target: "connections" | "channels" = "connections") => {
    setFilterBySection((current) => ({ ...current, [target]: value }));
  }, []);
  return (
    <ToolsPageView
      pluginUpdatesAvailable={pluginUpdatesAvailable}
      tools={state.tools}
      client={clients?.integrations}
      channelsClient={clients?.channels}
      search={section === "plugins" ? "" : searchBySection[section]}
      searchBySection={searchBySection}
      filterBySection={filterBySection}
      activeCategory={activeCategory}
      section={section}
      onSectionChange={(next) => {
        if (next === section) return;
        if (state.tools.modal.kind !== "closed") dispatch(appActions.closeToolModal());
        setSection(next);
      }}
      connectionFilter={section === "plugins" ? "all" : filterBySection[section]}
      onConnectionFilterChange={changeCatalogFilter}
      pluginFilter={pluginFilter}
      pluginInstalledCount={pluginInstalledCount}
      onPluginFilterChange={setPluginFilter}
      pluginSearch={pluginSearch}
      onPluginSearchChange={setPluginSearch}
      onPluginRefresh={() => setPluginRefreshRequestId((current) => current + 1)}
      marketplace={<PluginMarketplace showHeader={false} showToolbar={false} filter={pluginFilter}
        search={pluginSearch} onSearchChange={setPluginSearch} refreshRequestId={pluginRefreshRequestId}
        onFilterChange={setPluginFilter} onInstalledCountChange={setPluginInstalledCount} />}
      onSearchChange={changeCatalogSearch}
      onCategoryChange={setActiveCategory}
      onOpenIntegration={openIntegration}
      onModalClose={closeModal}
      onConnectionsChanged={refreshConnections}
    />
  );
}

/** Reads load connections for page. */
export async function loadConnectionsForPage(client: IntegrationsClient, channelsClient: ChannelsClient) {
  return loadToolConnectionRecords(client, channelsClient);
}

/** Checks should load connections for page. */
export function shouldLoadConnectionsForPage(status: ToolsState["status"]): boolean {
  return status === "idle";
}

/** Handles tools page view. */
export function ToolsPageView(props: ToolsPageViewProps) {
  const { t } = useTranslation();
  const search = props.search ?? "";
  const activeCategory = props.activeCategory ?? "All";
  const section = props.section ?? "connections";
  // Mount each catalog on its first visit, then retain its DOM and local state.
  const [visitedSections, setVisitedSections] = useState<Set<ToolsSection>>(() => new Set([section]));
  useEffect(() => {
    setVisitedSections((current) => current.has(section) ? current : new Set([...current, section]));
  }, [section]);
  const allIntegrations = useMemo(() => getAllIntegrationMeta(), []);
  const unavailableIntegrationsClient = useMemo(
    () => createUnavailableIntegrationsClient(t("tools.error.initializing")),
    [t]
  );
  const unavailableChannelsClient = useMemo(
    () => createUnavailableChannelsClient(t("tools.error.initializing")),
    [t]
  );
  const connectionFilter = props.connectionFilter ?? "all";
  const toolsSearch = props.searchBySection?.connections ?? search;
  const channelsSearch = props.searchBySection?.channels ?? search;
  const toolsFilter = props.filterBySection?.connections ?? connectionFilter;
  const channelsFilter = props.filterBySection?.channels ?? connectionFilter;
  // Reuse the catalog React nodes as well as their DOM when only the active tab changes.
  const connectionPanels = useMemo(() => {
    const isConnected = (item: IntegrationMeta) => deriveIntegrationState(selectConnectionForIntegration(props.tools, item)) === "connected";
    return Object.fromEntries((["connections", "channels"] as const).map((panel) => {
      const catalog = allIntegrations.filter((item) => panel === "channels" ? item.isChannel : !item.isChannel);
      const panelSearch = panel === "channels" ? channelsSearch : toolsSearch;
      const panelFilter = panel === "channels" ? channelsFilter : toolsFilter;
      const filtered = selectStatusPrioritizedIntegrations(
        selectVisibleIntegrations(catalog, panelSearch, panel === "channels" ? "All" : activeCategory)
          .filter((item) => panelFilter !== "connected" || isConnected(item)), props.tools
      );
      return [panel, <ConnectionCatalogSection
        showHeader={false}
        showToolbar={false}
        kind={panel === "channels" ? "channels" : "tools"}
        items={filtered} tools={props.tools} loading={props.tools.status === "loading"} error={props.tools.loadError}
        search={panelSearch} onSearchChange={(value) => props.onSearchChange(value, panel)}
        filter={panelFilter} onFilterChange={(value) => props.onConnectionFilterChange?.(value, panel)}
        connectedCount={catalog.filter(isConnected).length}
        onOpenIntegration={props.onOpenIntegration} onRefresh={props.onConnectionsChanged}
        activeCategory={activeCategory} onCategoryChange={panel === "connections" ? props.onCategoryChange : undefined}
      />];
    }));
  }, [allIntegrations, props.tools, toolsSearch, channelsSearch, toolsFilter, channelsFilter, activeCategory,
    props.onSearchChange, props.onConnectionFilterChange, props.onOpenIntegration, props.onConnectionsChanged, props.onCategoryChange]);
  const modalIntegration = getModalIntegration(props.tools, allIntegrations);
  const modalConnection = modalIntegration ? selectConnectionForIntegration(props.tools, modalIntegration) : undefined;
  const statusFilter = section === "plugins" ? props.pluginFilter ?? "all" : section === "channels" ? channelsFilter : toolsFilter;
  const statusCount = section === "plugins" ? props.pluginInstalledCount ?? 0
    : allIntegrations.filter((item) => item.isChannel === (section === "channels")
      && deriveIntegrationState(selectConnectionForIntegration(props.tools, item)) === "connected").length;

  return (
    <AppFrame title={t("tools.hubTitle")} topBarInset={true} topBarInsetOffsetPx={-20}>
      <div
        className="app-frame-page-content h-full overflow-y-auto tools-page-content"
        style={{ paddingBottom: 24 }}
      >
        <header className="tools-page-heading extension-catalog-heading">
          <Memmy pose="connect" size={56} />
          <div className="extension-catalog-heading-copy">
            <h1 className="memory-panel__title">{t("tools.hubTitle")}</h1>
            <p className="memory-panel__subtitle">{t("tools.hubSubtitle")}</p>
          </div>
        </header>
        <div className="tools-page-navigation" data-window-drag-exclusion="tools-tabs">
        <div role="tablist" aria-label={t("tools.hubTitle")} className="plugin-marketplace-tabs">
          {(["connections", "channels", "plugins"] as const).map((item) => (
            <button key={item} type="button" role="tab" id={`tools-tab-${item}`}
              aria-selected={section === item} aria-controls={`tools-panel-${item}`}
              onClick={() => props.onSectionChange?.(item)}
              className="plugin-marketplace-section-button">
              {item === "connections"
                ? <Link2 size={17} strokeWidth={1.8} aria-hidden="true" />
                : item === "channels"
                  ? <MessageCircle size={17} strokeWidth={1.8} aria-hidden="true" />
                  : <Puzzle size={17} strokeWidth={1.8} aria-hidden="true" />}
              {t(item === "plugins" ? "tools.hubPluginsTab" : item === "channels" ? "tools.hubChannelsTab" : "tools.connectionsTab")}
              {item === "plugins" && props.pluginUpdatesAvailable ? <PluginUpdateDot /> : null}
            </button>
          ))}
        </div>
        <div className="tools-page-navigation-actions">
          <SearchField className="extension-catalog-search" label={section === "plugins" ? t("plugins.ui.searchTaskPlugins")
              : t(section === "channels" ? "connections.catalog.searchChatChannels" : "connections.catalog.searchAppTools")}
              value={section === "plugins" ? props.pluginSearch ?? "" : section === "channels" ? channelsSearch : toolsSearch}
              onChange={(value) => section === "plugins" ? props.onPluginSearchChange?.(value)
                : props.onSearchChange(value, section)} />
          {section === "connections" ? <label className="extension-catalog-category">
            <span className="sr-only">{t("connections.catalog.toolCategory")}</span>
            <select aria-label={t("connections.catalog.toolCategory")} value={activeCategory}
              onChange={(event) => props.onCategoryChange(event.target.value as IntegrationCategoryTab)}>
              {CATEGORY_TABS.map((category) => <option key={category} value={category}>{category === "All"
                ? t("connections.catalog.allCategories") : category === "Chat" ? t("connections.catalog.chat")
                  : category === "Productivity" ? t("connections.catalog.productivity")
                    : category === "Tools & Automation" ? t("connections.catalog.toolsAutomation")
                      : category === "Social" ? t("connections.catalog.social") : t("connections.catalog.platform")}</option>)}
            </select>
            <ChevronDown className="tools-page-category-chevron" size={15} aria-hidden="true" />
          </label> : null}
          <button type="button" aria-pressed={statusFilter !== "all"}
            className={`memory-log-filter tools-page-status-filter${statusFilter !== "all" ? " memory-log-filter--active" : ""}`}
            disabled={statusCount === 0 && statusFilter === "all"}
            onClick={() => section === "plugins"
              ? props.onPluginFilterChange?.(statusFilter === "all" ? "installed" : "all")
              : props.onConnectionFilterChange?.(statusFilter === "all" ? "connected" : "all", section)}>
            {`${t(section === "plugins" ? "memory.cliInstalled" : "settings.computerUse.connected")} (${statusCount})`}
          </button>
          <button type="button" className="memory-refresh-button tools-page-refresh"
            aria-label={t("common.refresh")} title={t("common.refresh")}
            disabled={section !== "plugins" && props.tools.status === "loading"}
            onClick={() => section === "plugins" ? props.onPluginRefresh?.() : props.onConnectionsChanged()}>
            <RefreshCw size={15} className={section !== "plugins" && props.tools.status === "loading" ? "animate-spin" : ""} aria-hidden="true" />
          </button>
        </div>
        </div>
        {(["connections", "channels", "plugins"] as const).map((panel) => {
          if (panel !== section && !visitedSections.has(panel)) return null;
          return <div key={panel} className="extension-catalog-content"
            hidden={panel !== section}
            data-tour-anchor={panel === section ? PRODUCT_TOUR_TOOLS_CONTENT_ANCHOR : undefined} role="tabpanel"
            id={`tools-panel-${panel}`} aria-labelledby={`tools-tab-${panel}`}>
            {panel === "plugins" ? props.marketplace : connectionPanels[panel]}
          </div>;
        })}
      </div>

      {props.tools.modal.kind !== "closed" &&
        (modalIntegration?.surface === "channel" ? (
          <ConnectChannelModal
            open={true}
            channel={modalIntegration}
            connection={modalConnection}
            client={props.channelsClient ?? unavailableChannelsClient}
            onClose={props.onModalClose}
            onChanged={props.onConnectionsChanged}
          />
        ) : (
          <ConnectIntegrationModal
            open={true}
            integration={modalIntegration}
            connection={modalConnection}
            client={props.client ?? unavailableIntegrationsClient}
            onClose={props.onModalClose}
            onChanged={props.onConnectionsChanged}
          />
        ))}
    </AppFrame>
  );
}

/**
 * Reads the integration item for the current modal.
 *
 * @param tools The tools state.
 * @param integrations The full integration meta list.
 * @returns The current modal item; null when not open or not found.
 */
function getModalIntegration(tools: ToolsState, integrations: IntegrationMeta[]): IntegrationMeta | null {
  const modal = tools.modal;

  if (modal.kind === "closed") {
    return null;
  }

  return integrations.find((item) => item.slug === modal.slug && item.surface === modal.kind) ?? null;
}

/**
 * Creates a placeholder integrations client for use before the client is initialized.
 *
 * @returns An IntegrationsClient that only throws an initialization error.
 */
function createUnavailableIntegrationsClient(message: string): IntegrationsClient {
  const unavailable = () => {
    throw Object.assign(new Error(message), { code: "internal" as const });
  };

  return {
    listCapabilities: async () => unavailable(),
    authorize: async () => unavailable(),
    listConnections: async () => unavailable(),
    deleteConnection: async () => unavailable(),
    reportConnectionEvent: async () => unavailable()
  };
}

/**
 * Creates a placeholder channels client for use before the client is initialized.
 *
 * @param message The initialization error text.
 * @returns A ChannelsClient that only throws an initialization error.
 */
function createUnavailableChannelsClient(message: string): ChannelsClient {
  const unavailable = () => {
    throw Object.assign(new Error(message), { code: "internal" as const });
  };

  return {
    listDefinitions: async () => unavailable(),
    listConnections: async () => unavailable(),
    connect: async () => unavailable(),
    pollConnect: async () => unavailable(),
    disconnect: async () => unavailable(),
    reportConnectionEvent: async () => unavailable()
  };
}
