/** Tools page module. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { useApiClients } from "../app/providers.js";
import { PRODUCT_TOUR_TOOLS_CONTENT_ANCHOR } from "../app/product-tour-layout.js";
import type { ChannelsClient } from "../api/channels-client.js";
import type { IntegrationsClient } from "../api/integrations-client.js";
import { Banner } from "../components/banner.js";
import { ConnectChannelModal } from "../components/connect-channel-modal.js";
import { ConnectIntegrationModal } from "../components/connect-integration-modal.js";
import { IntegrationCard } from "../components/integration-card.js";
import { Memmy } from "../components/mascot/memmy.js";
import { CATEGORY_TABS, getAllIntegrationMeta, type IntegrationCategoryTab, type IntegrationMeta } from "../integrations/integration-meta.js";
import { useTranslation } from "../i18n/use-translation.js";
import { appActions, loadToolConnectionRecords, toolsActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import { selectConnectionForIntegration, selectStatusPrioritizedIntegrations, selectVisibleIntegrations, type ToolsState } from "../state/tools-slice.js";
import { AppFrame } from "./app-frame.js";

const CONNECTION_REFRESH_INTERVAL_MS = 5_000;

/** Contract for tools page view props. */
export interface ToolsPageViewProps {
  tools: ToolsState;
  client?: IntegrationsClient;
  channelsClient?: ChannelsClient;
  search?: string;
  activeCategory?: IntegrationCategoryTab;
  onSearchChange: (value: string) => void;
  onCategoryChange: (category: IntegrationCategoryTab) => void;
  onOpenIntegration: (integration: IntegrationMeta) => void;
  onModalClose: () => void;
  onConnectionsChanged: () => void;
}

/** Handles tools page. */
export function ToolsPage() {
  const { state, dispatch } = useAppState();
  const { clients } = useApiClients();
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<IntegrationCategoryTab>("All");

  useEffect(() => {
    if (!clients || !shouldLoadConnectionsForPage(state.tools.status)) {
      return;
    }

    void toolsActions.loadConnections(clients.integrations, clients.channels, dispatch);
  }, [clients, dispatch, state.tools.status]);

  useEffect(() => {
    if (!clients || state.tools.status !== "ready") {
      return undefined;
    }

    const interval = window.setInterval(() => {
      void toolsActions.refreshConnections(clients.integrations, clients.channels, dispatch);
    }, CONNECTION_REFRESH_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [clients, dispatch, state.tools.status]);

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

  return (
    <ToolsPageView
      tools={state.tools}
      client={clients?.integrations}
      channelsClient={clients?.channels}
      search={search}
      activeCategory={activeCategory}
      onSearchChange={setSearch}
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
  const allIntegrations = useMemo(() => getAllIntegrationMeta(), []);
  const unavailableIntegrationsClient = useMemo(
    () => createUnavailableIntegrationsClient(t("tools.error.initializing")),
    [t]
  );
  const unavailableChannelsClient = useMemo(
    () => createUnavailableChannelsClient(t("tools.error.initializing")),
    [t]
  );
  const channels = selectStatusPrioritizedIntegrations(
    allIntegrations.filter((item) => item.isChannel),
    props.tools
  );
  const integrations = allIntegrations.filter((item) => !item.isChannel);
  const filtered = selectStatusPrioritizedIntegrations(
    selectVisibleIntegrations(integrations, search, activeCategory),
    props.tools
  );
  const modalIntegration = getModalIntegration(props.tools, allIntegrations);
  const modalConnection = modalIntegration ? selectConnectionForIntegration(props.tools, modalIntegration) : undefined;

  return (
    <AppFrame title={t("tools.title")}>
      <div className="app-frame-page-content h-full overflow-y-auto py-6">
        <div className="mb-6 flex items-center gap-3 border-b border-border-stone/30 pb-4">
          <Memmy pose="connect" size={56} />
          <div>
            <h1 className="text-lg font-bold text-text-ink">{t("tools.title")}</h1>
            <p className="text-xs text-text-ink/65">{t("tools.subtitle")}</p>
          </div>
        </div>

        <div data-tour-anchor={PRODUCT_TOUR_TOOLS_CONTENT_ANCHOR}>
          {props.tools.loadError && <Banner tone="danger">{props.tools.loadError}</Banner>}

          <section className="mb-8">
            <div className="mb-4 flex items-center gap-2.5">
              <span className="text-base font-semibold text-text-ink">{t("tools.channels")}</span>
            </div>
            <div className="tools-icon-grid">
              {channels.map((channel) => (
                <IntegrationCard
                  key={channel.identity}
                  meta={channel}
                  connection={selectConnectionForIntegration(props.tools, channel)}
                  onClick={props.onOpenIntegration}
                />
              ))}
            </div>
          </section>

          <section>
            <div className="mb-4 flex items-center gap-2.5">
              <span className="text-base font-semibold text-text-ink">{t("tools.integrations")}</span>
            </div>

            <div className="relative mb-4">
              <Search size={15} className="absolute left-4 top-1/2 -translate-y-1/2 text-text-ink/45" aria-hidden="true" />
              <input
                type="text"
                placeholder={t("tools.search")}
                value={search}
                onChange={(event) => props.onSearchChange(event.target.value)}
                className="w-full rounded-input border-content-panel bg-background-paper py-2.5 pl-10 pr-4 text-sm placeholder:text-text-ink/40 focus:outline-none"
              />
            </div>

            <div className="mb-5 flex flex-wrap gap-2">
              {CATEGORY_TABS.map((category) => (
                <button
                  key={category}
                  type="button"
                  onClick={() => props.onCategoryChange(category)}
                  className={`rounded-btn border px-4 py-2 text-xs transition-all ${
                    activeCategory === category
                      ? "border-action-sky/30 bg-action-sky/10 font-semibold text-action-sky"
                      : "border-content-panel bg-background-paper text-text-ink/65 hover:bg-canvas-oat/40"
                  }`}
                >
                  {category}
                </button>
              ))}
            </div>

            {props.tools.status === "loading" && <p className="text-sm text-text-ink/55">{t("common.loading")}</p>}
            {filtered.length === 0 && props.tools.status !== "loading" && (
              <p className="rounded-card border-content-panel bg-background-paper p-4 text-sm text-text-ink/55">{t("tools.list.empty")}</p>
            )}
            <div className="tools-icon-grid">
              {filtered.map((integration) => (
                <IntegrationCard
                  key={integration.identity}
                  meta={integration}
                  connection={selectConnectionForIntegration(props.tools, integration)}
                  onClick={props.onOpenIntegration}
                />
              ))}
            </div>
          </section>
        </div>
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
    deleteConnection: async () => unavailable()
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
    disconnect: async () => unavailable()
  };
}
