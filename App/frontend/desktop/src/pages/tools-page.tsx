import "./plugin-tools-layout.css";
import { usePluginUpdateAvailable, PluginUpdateDot } from "./plugin-update-indicator.js";
/** Tools page module. */
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link2, MessageCircle, Puzzle } from "lucide-react";
import { useApiClients } from "../app/providers.js";
import { PRODUCT_TOUR_TOOLS_CONTENT_ANCHOR } from "../app/product-tour-layout.js";
import type { ChannelsClient } from "../api/channels-client.js";
import type { IntegrationsClient } from "../api/integrations-client.js";
import { ConnectChannelModal } from "../components/connect-channel-modal.js";
import { ConnectIntegrationModal } from "../components/connect-integration-modal.js";
import { getAllIntegrationMeta, type IntegrationCategoryTab, type IntegrationMeta } from "../integrations/integration-meta.js";
import { deriveIntegrationState } from "../integrations/connection-state.js";
import { useTranslation } from "../i18n/use-translation.js";
import { appActions, loadToolConnectionRecords, toolsActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import { selectConnectionForIntegration, selectStatusPrioritizedIntegrations, selectVisibleIntegrations, type ToolsState } from "../state/tools-slice.js";
import { AppFrame } from "./app-frame.js";
import { PluginMarketplace } from "./plugin-marketplace.js";
import { ConnectionCatalogSection } from "./connection-catalog-section.js";
import "./plugin-marketplace.css";

const MarketplacePreview = import.meta.env.DEV
  ? lazy(() => import("./plugin-marketplace-preview.js"))
  : null;

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
  const preview = MarketplacePreview && typeof window !== "undefined"
    && new URLSearchParams(window.location.search).get("plugin-market-preview") === "1";

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
  const marketplace = useMemo(() => preview && MarketplacePreview
    ? <Suspense fallback={<p className="text-sm text-text-ink/50">Loading…</p>}><MarketplacePreview /></Suspense>
    : <PluginMarketplace />, [preview]);

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
      marketplace={marketplace}
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

  return (
    <AppFrame title={t("tools.hubTitle")} topBarInset={true} topBarInsetOffsetPx={-8}>
      <div
        className="app-frame-page-content h-full overflow-y-auto tools-page-content"
        style={{ paddingBottom: 24 }}
      >
        <div role="tablist" aria-label={t("tools.hubTitle")} className="plugin-marketplace-tabs" data-window-drag-exclusion="tools-tabs">
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
              {t(item === "plugins" ? "tools.pluginsTab" : item === "channels" ? "tools.channelsTab" : "tools.connectionsTab")}
              {item === "plugins" && props.pluginUpdatesAvailable ? <PluginUpdateDot /> : null}
            </button>
          ))}
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
