import { Link2, MessageCircle, MoreHorizontal, Plus, RefreshCw, Search } from "lucide-react";
import { Memmy } from "../components/mascot/memmy.js";
import { deriveIntegrationState, type IntegrationConnectionState } from "../integrations/connection-state.js";
import { CATEGORY_TABS, IntegrationLogoBadge, type IntegrationCategoryTab, type IntegrationMeta } from "../integrations/integration-meta.js";
import { useTranslation } from "../i18n/use-translation.js";
import { selectConnectionForIntegration, type ToolsState } from "../state/tools-slice.js";

export interface ConnectionCatalogSectionProps {
  kind: "tools" | "channels";
  /** The parent owns filtering and ordering; this view renders the supplied results. */
  items: IntegrationMeta[];
  tools: ToolsState;
  loading?: boolean;
  error?: string | null;
  search: string;
  onSearchChange(value: string): void;
  filter: "all" | "connected";
  onFilterChange(value: "all" | "connected"): void;
  connectedCount: number;
  onOpenIntegration(integration: IntegrationMeta): void;
  onRefresh(): void;
  activeCategory?: IntegrationCategoryTab;
  onCategoryChange?(category: IntegrationCategoryTab): void;
}

/** App tools and chat channels share a catalog, while preserving connection identity. */
export function ConnectionCatalogSection(props: ConnectionCatalogSectionProps) {
  const { t } = useTranslation();
  const channels = props.kind === "channels";
  const title = channels ? t("tools.channelsTab") : t("tools.connectionsTab");
  const searchLabel = channels ? t("connections.catalog.searchChatChannels") : t("connections.catalog.searchAppTools");
  const loading = props.loading ?? props.tools.status === "loading";
  const error = props.error === undefined ? props.tools.loadError : props.error;

  return (
    <section className="memory-panel plugin-marketplace-section" aria-label={title}>
      <div className="memory-panel__header">
        <div className="memory-panel__header-main extension-catalog-heading">
          <Memmy pose={channels ? "chat" : "connect"} size={56} />
          <div className="extension-catalog-heading-copy">
            <h2 className="memory-panel__title">{title}</h2>
            <p className="memory-panel__subtitle">{channels
              ? t("connections.catalog.connectAChatChannelToSendTasksTo")
              : t("connections.catalog.connectYourAppAccountsSoMemmyCanUse")}</p>
          </div>
        </div>
        <button type="button" className="memory-refresh-button" disabled={loading} onClick={props.onRefresh}
          aria-label={t("common.refresh")} title={t("common.refresh")}>
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} aria-hidden="true" />
        </button>
      </div>

      <div className="extension-catalog-toolbar">
        <div className="memory-log-filter-group" aria-label={t("connections.catalog.filterByConnectionStatus")}>
          {(["all", "connected"] as const).map((filter) => (
            <button key={filter} type="button" aria-pressed={props.filter === filter}
              className={`memory-log-filter${props.filter === filter ? " memory-log-filter--active" : ""}`}
              onClick={() => props.onFilterChange(filter)}>
              {filter === "all" ? t("memory.memories.all") : `${t("settings.computerUse.connected")} (${props.connectedCount})`}
            </button>
          ))}
        </div>
        <label className="extension-catalog-search">
          <Search size={15} aria-hidden="true" />
          <input type="search" aria-label={searchLabel} placeholder={searchLabel} value={props.search}
            onChange={(event) => props.onSearchChange(event.target.value)} />
        </label>
        {!channels && props.onCategoryChange ? (
          <label className="extension-catalog-category">
            <span className="sr-only">{t("connections.catalog.toolCategory")}</span>
            <select aria-label={t("connections.catalog.toolCategory")} value={props.activeCategory ?? "All"}
              onChange={(event) => props.onCategoryChange?.(event.target.value as IntegrationCategoryTab)}>
              {CATEGORY_TABS.map((category) => <option key={category} value={category}>{categoryLabel(category, t)}</option>)}
            </select>
          </label>
        ) : null}
      </div>

      {error ? <p role="alert" className="mb-4 rounded-card border border-status-error/20 bg-status-error/5 p-3 text-sm text-status-error">{error}</p> : null}
      {loading ? <p role="status" className="mb-4 text-sm text-text-ink/55">{t("connections.catalog.loadingConnectionStatus")}</p> : null}
      {!loading && props.items.length === 0 ? (
        <div className="memory-state-box">
          {channels ? <MessageCircle size={24} aria-hidden="true" /> : <Link2 size={24} aria-hidden="true" />}
          <p>{props.filter === "connected" && !props.search
            ? t("connections.catalog.noConnectedItemsYet")
            : t("connections.catalog.noMatchingResults")}</p>
        </div>
      ) : null}

      <div className="plugin-marketplace-grid connection-catalog-grid">
        {props.items.map((item) => {
          const state = deriveIntegrationState(selectConnectionForIntegration(props.tools, item));
          const manage = state === "connected" || state === "pending";
          const action = manage ? t("settings.computerUse.extensionManage") : state === "expired" || state === "error" ? t("computerHistory.wechat.reconnectButton") : t("tools.connect.btn");
          const kind = item.surface === "channel" ? t("connections.catalog.chatChannel") : t("connections.catalog.appTool");
          const actionLabel = t("connections.catalog.label", { action: action, name: item.name, kind: kind });
          const statusLabel = connectionStatusLabel(state, t);
          return (
            <article key={item.identity} className="plugin-marketplace-row" data-surface={item.surface} aria-label={`${item.name} · ${kind}`}>
              <button type="button" className="plugin-marketplace-summary" disabled={loading}
                aria-label={t("connections.catalog.view", { name: item.name, kind: kind })} onClick={() => props.onOpenIntegration(item)}>
                <IntegrationLogoBadge slug={item.slug} name={item.name} surface={item.surface} sizeClassName="plugin-marketplace-icon" />
                <span className="plugin-marketplace-text">
                  <span className="plugin-marketplace-name" title={item.name}>{item.name}</span>
                  {statusLabel ? <span role="status" className={`extension-catalog-connection-status extension-catalog-connection-status--${state}`}>{statusLabel}</span> : null}
                </span>
              </button>
              <div className="plugin-marketplace-row-actions">
                <button type="button" className="plugin-marketplace-icon-button" aria-label={actionLabel} title={actionLabel}
                  disabled={loading} onClick={() => props.onOpenIntegration(item)}>
                  {manage ? <MoreHorizontal size={18} aria-hidden="true" /> : <Plus size={18} aria-hidden="true" />}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

type CatalogTranslate = ReturnType<typeof useTranslation>["t"];

function categoryLabel(category: IntegrationCategoryTab, t: CatalogTranslate): string {
  switch (category) {
    case "All": return t("connections.catalog.allCategories");
    case "Chat": return t("connections.catalog.chat");
    case "Productivity": return t("connections.catalog.productivity");
    case "Tools & Automation": return t("connections.catalog.toolsAutomation");
    case "Social": return t("connections.catalog.social");
    case "Platform": return t("connections.catalog.platform");
  }
}

function connectionStatusLabel(state: IntegrationConnectionState, t: CatalogTranslate): string | null {
  switch (state) {
    case "connected": return t("settings.computerUse.connected");
    case "pending": return t("tools.card.connecting");
    case "expired": return t("connections.catalog.expired");
    case "error": return t("settings.modelWorkspace.testFailed");
    case "disconnected": return null;
  }
}
