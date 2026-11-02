import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BookOpen, Check, Clock3, FileText, Loader2, LogIn, MessageSquare, MoreHorizontal, Plus, Puzzle, RefreshCw, Scale, Search, X } from "lucide-react";
import type { InstalledPlugin, PluginEligibility } from "@memmy/local-api-contracts";
import { Button } from "../components/button.js";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { Modal } from "../components/modal.js";
import { Tooltip } from "../components/tooltip.js";
import { useTranslation } from "../i18n/use-translation.js";
import { Memmy } from "../components/mascot/memmy.js";
import { PluginDetailPreview } from "./plugin-detail-preview.js";
import { isNewerPluginVersion } from "./plugin-version.js";

export interface MarketplacePlugin {
  id: string;
  name: string;
  description: string;
  category: "legal" | "research" | "office" | "other";
  version?: string;
  defaultInstalled?: boolean;
  /** Declared by the plugin: needs a signed-in account to install/use. */
  requiresLogin?: boolean;
  /** Presentation recommendation only; never restricts installation or use. */
  requiresOfficialModel?: boolean;
  installed?: InstalledPlugin;
  eligibility?: PluginEligibility;
  installable: boolean;
}

export interface PluginMarketplaceSectionProps {
  /** The parent supplies the catalog after applying account visibility rules. */
  plugins: MarketplacePlugin[];
  loading?: boolean;
  error?: string | null;
  actionError?: string | null;
  actionErrorPluginId?: string | null;
  busyId?: string | null;
  /** Temporarily block lifecycle mutations while keeping refresh available. */
  actionsDisabled?: boolean;
  onInstall(plugin: MarketplacePlugin): void;
  onUpdate(plugin: MarketplacePlugin): void;
  onUninstall(plugin: MarketplacePlugin): void;
  onEnable(plugin: MarketplacePlugin): void;
  onAddToChat(plugin: MarketplacePlugin): void;
  onConfigureModel(): void;
  onRefresh(): void;
  onSignIn?(): void;
  officialModelReady: boolean | undefined;
  /**
   * Account sign-in state, sourced from the server. Login is applied per plugin
   * (only plugins that declare it), never as a section-wide gate. Whitelist / beta
   * eligibility is applied upstream when the parent builds `plugins`, and will be
   * fed by the server through the same seam.
   */
  signedIn?: boolean;
}

/** Slash command inserted into the current chat composer for an active plugin. */
export function pluginComposerCommand(plugin: MarketplacePlugin): string | null {
  if (plugin.installed?.state !== "active") return null;
  return plugin.installed.manifest.commands?.[0]?.command ?? `/${plugin.id}`;
}

/** Prepends a plugin command without duplicating it or wiping the current draft. */
export function addPluginCommandToDraft(command: string, draft: string): string {
  const existing = draft.trim();
  if (!existing) return `${command}  `;
  const leading = existing.split(/\s/, 1)[0];
  if (leading === command) return existing === command ? `${command}  ` : draft;
  return `${command}  ${existing}`;
}

type PrimaryAction = "install" | "update" | "enable" | "configure" | "sign-in" | "unavailable" | null;

/** A plugin needs sign-in when it declares login (or an official model, which is account-owned) and the user is signed out. */
function pluginNeedsSignIn(plugin: MarketplacePlugin, signedIn: boolean): boolean {
  return plugin.eligibility?.reason === "login_required" || (!signedIn && Boolean(plugin.requiresLogin));
}

/** Catalog presentation only: installation state always comes from the parent. */
export function PluginMarketplaceSection(props: PluginMarketplaceSectionProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<"all" | "installed">("all");
  const [query, setQuery] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [uninstallId, setUninstallId] = useState<string | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const installedCount = props.plugins.filter((plugin) => Boolean(plugin.installed)).length;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visiblePlugins = props.plugins.filter((plugin) => (
    (filter === "all" || plugin.installed)
    && `${plugin.name}\n${plugin.description}`.toLocaleLowerCase().includes(normalizedQuery)
  ));
  const detail = props.plugins.find((plugin) => plugin.id === detailId);
  const detailNote = detail ? detailModelNote(detail, t) : null;
  const confirmedPlugin = props.plugins.find((plugin) => plugin.id === uninstallId);
  const busy = Boolean(props.busyId) || Boolean(props.loading);
  const actionsDisabled = busy || Boolean(props.actionsDisabled);
  const confirmationValid = Boolean(confirmedPlugin?.installed);
  const signedIn = props.signedIn !== false;

  useEffect(() => {
    if (!menuId) return;
    const closeOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest("[data-plugin-menu]")) setMenuId(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuId(null);
        sectionRef.current?.querySelector<HTMLButtonElement>(`[data-menu-trigger="${CSS.escape(menuId)}"]`)?.focus();
      }
    };
    sectionRef.current?.querySelector<HTMLElement>("[role=menu] [role=menuitem]")?.focus();
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuId]);

  function requestUninstall(plugin: MarketplacePlugin) {
    if (actionsDisabled) return;
    setMenuId(null);
    setDetailId(null);
    setUninstallId(plugin.id);
  }

  function performPrimary(plugin: MarketplacePlugin) {
    if (busy) return;
    switch (primaryAction(plugin, signedIn, props.officialModelReady)) {
      case "update":
        if (actionsDisabled) return;
        setDetailId(null);
        props.onUpdate(plugin);
        break;
      case "install":
        if (actionsDisabled) return;
        setDetailId(null);
        props.onInstall(plugin);
        break;
      case "enable":
        if (actionsDisabled) return;
        setDetailId(null);
        props.onEnable(plugin);
        break;
      case "configure": setDetailId(null); props.onConfigureModel(); break;
      case "sign-in": setDetailId(null); props.onSignIn?.(); break;
    }
  }

  function addToChat(plugin: MarketplacePlugin) {
    if (plugin.installed?.state !== "active" || plugin.installed.eligibility?.canUse === false || plugin.eligibility?.canUse === false) return;
    setMenuId(null);
    setDetailId(null);
    props.onAddToChat(plugin);
  }

  function updateStatus(plugin: MarketplacePlugin) {
    if (plugin.installed?.update) return plugin.installed.update.status;
    if (props.busyId === plugin.id && primaryAction(plugin, signedIn, props.officialModelReady) === "update") {
      // The Agent can be busy between plugin calls; await the Host status.
      return "waiting";
    }
    return undefined;
  }

  function renderPrimary(plugin: MarketplacePlugin) {
    const action = primaryAction(plugin, signedIn, props.officialModelReady);
    if (!action) return null;
    const working = props.busyId === plugin.id || isTransitioning(plugin);
    const updating = updateStatus(plugin);
    const label = updating === "waiting" ? t("plugins.ui.updateQueued") : updating === "installing" ? t("plugins.ui.updating") : action === "unavailable" ? plugin.eligibility?.reason ? t("plugins.ui.accessUnavailable") : t("plugins.ui.comingSoon")
      : action === "update" ? t("plugins.ui.updateToVersion", { version: plugin.version! })
      : action === "install" ? t("settings.computerUse.extensionInstall")
      : action === "configure" ? t("plugins.ui.setUpOfficialModel")
      : action === "sign-in" ? t("plugins.ui.signIn")
      : t("plugins.ui.retryInstallation");
    // Sign-in and model setup are navigation, not lifecycle mutations, so they stay enabled while actions are disabled.
    const bypassesActionsDisabled = action === "configure" || action === "sign-in";
    return (
      <button type="button" className="plugin-marketplace-detail-primary w-full rounded-xl bg-action-sky text-white text-sm font-normal py-2.5 hover:bg-action-sky-hover transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        aria-label={action === "update" ? t("plugins.ui.update", { name: plugin.name }) : action === "install" ? t("plugins.ui.install", { name: plugin.name }) : action === "enable" ? t("plugins.ui.retryInstalling", { name: plugin.name }) : undefined}
        disabled={busy || working || action === "unavailable" || (!bypassesActionsDisabled && actionsDisabled)} onClick={() => performPrimary(plugin)}>
        {working ? updating === "waiting" ? <Clock3 size={14} aria-hidden="true" /> : <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
        {updating ? label : working ? t("settings.computerUse.extensionPreparing") : label}
      </button>
    );
  }

  function renderWorking(plugin: MarketplacePlugin) {
    const updating = updateStatus(plugin);
    const description = updating === "waiting" ? t("plugins.ui.waitingForTasks")
      : updating === "installing" ? t("plugins.ui.installingUpdate")
      : t("plugins.ui.workingOn", { name: plugin.name });
    const indicator = (
      <span className={`plugin-marketplace-working${updating ? " plugin-marketplace-update-status" : ""}`}
        data-update-state={updating} role="status" aria-label={description} tabIndex={updating ? 0 : undefined}>
        {updating === "waiting" ? <Clock3 size={14} aria-hidden="true" />
          : <Loader2 size={updating ? 14 : 16} className="animate-spin" aria-hidden="true" />}
        {updating ? <span className="plugin-marketplace-update-label">{t(updating === "waiting" ? "plugins.ui.updateQueued" : "plugins.ui.updating")}</span> : null}
      </span>
    );
    return updating ? <Tooltip content={description}>{indicator}</Tooltip> : indicator;
  }

  const status = (plugin: MarketplacePlugin) => {
    if (props.busyId === plugin.id || isTransitioning(plugin)) return t("plugins.ui.working");
    if (!plugin.installed) return t("memory.cliNotInstalled");
    if (plugin.installed.state === "failed") return t("plugins.ui.installationFailed");
    if (plugin.installed.state !== "active") return t("plugins.ui.installationIncomplete");
    if (pluginNeedsSignIn(plugin, signedIn)) return t("plugins.ui.installedSignInRequired");
    return t("memory.cliInstalled");
  };

  return (
    <section ref={sectionRef} className="memory-panel plugin-marketplace-section" aria-label={t("tools.pluginsTab")}>
      <div className="memory-panel__header">
        <div className="memory-panel__header-main extension-catalog-heading">
          <Memmy pose="box" size={56} />
          <div className="extension-catalog-heading-copy">
            <h2 className="memory-panel__title">{t("tools.pluginsTab")}</h2>
            <p className="memory-panel__subtitle">{t("plugins.ui.completeEntireTasksWithCapabilitiesProvidedAndMaintained")}</p>
          </div>
        </div>
        <button type="button" disabled={props.loading || busy} onClick={props.onRefresh}
          aria-label={t("common.refresh")} title={t("common.refresh")}
          className="memory-refresh-button">
          <RefreshCw size={15} className={props.loading ? "animate-spin" : ""} aria-hidden="true" />
        </button>
      </div>
      <div className="extension-catalog-toolbar">
        <div className="memory-log-filter-group" aria-label={t("plugins.ui.filterPlugins")}>
          {(["all", "installed"] as const).map((value) => (
            <button key={value} type="button" aria-pressed={filter === value} onClick={() => { setFilter(value); setMenuId(null); }}
              className={`memory-log-filter${filter === value ? " memory-log-filter--active" : ""}`}>
              {value === "all" ? t("memory.memories.all") : `${t("memory.cliInstalled")} (${installedCount})`}
            </button>
          ))}
        </div>
        <label className="extension-catalog-search">
          <Search size={15} aria-hidden="true" />
          <input type="search" value={query}
            aria-label={t("plugins.ui.searchTaskPlugins")} placeholder={t("plugins.ui.searchTaskPlugins")}
            onChange={(event) => { setQuery(event.target.value); setMenuId(null); }} />
        </label>
      </div>

      {props.error ? <p role="alert" className="mb-4 rounded-card border border-status-error/20 bg-status-error/5 p-3 text-sm text-status-error">{props.error}</p> : null}
      {props.loading ? <p role="status" className="mb-4 text-sm text-text-ink/55">{t("plugins.ui.loadingPlugins")}</p> : null}
      {!props.loading && visiblePlugins.length === 0 ? (
        <div className="plugin-marketplace-empty-state" role="status">
          <Puzzle size={18} aria-hidden="true" />
          {normalizedQuery ? t("plugins.ui.noTaskPluginsMatchYourSearch")
            : filter === "installed" ? t("plugins.ui.noPluginsInstalledExploreTheAllTab") : t("plugins.ui.noPluginsAvailable")}
        </div>
      ) : null}
      <div className="plugin-marketplace-grid">
        {visiblePlugins.map((plugin) => (
          <article key={plugin.id} aria-label={plugin.name}
            className={`plugin-marketplace-row${props.actionErrorPluginId === plugin.id && props.actionError ? " plugin-marketplace-row--error" : ""}`}
            data-installed={plugin.installed?.state === "active" && !pluginNeedsSignIn(plugin, signedIn) ? "true" : undefined}>
            <button type="button" onClick={() => setDetailId(plugin.id)} className="plugin-marketplace-summary" aria-label={`${t("plugins.ui.view")}${plugin.name}${t("plugins.ui.details")}`}>
              <PluginIcon category={plugin.category} />
              <span className="plugin-marketplace-text">
                <span className="plugin-marketplace-name-line">
                  <span className="plugin-marketplace-name">{plugin.name}</span>
                </span>
                <span className="plugin-marketplace-description" title={plugin.description}>{plugin.description}</span>
              </span>
            </button>
            <div className="plugin-marketplace-row-actions">
              {props.busyId === plugin.id || plugin.installed?.update || isTransitioning(plugin) ? (
                renderWorking(plugin)
              ) : pluginNeedsSignIn(plugin, signedIn) ? (
                <Button type="button" size="sm" variant="secondary"
                  aria-label={t("plugins.ui.signInToUse", { name: plugin.name })} title={t("plugins.ui.signInToUse2")}
                  disabled={busy} onClick={() => performPrimary(plugin)}>
                  <LogIn size={14} aria-hidden="true" />
                  {t("plugins.ui.signIn")}
                </Button>
              ) : plugin.eligibility?.canUse === false ? (
                <span className="plugin-marketplace-coming-soon">{t("plugins.ui.accessUnavailable")}</span>
              ) : !plugin.installed ? (
                <button type="button" className={plugin.installable ? "plugin-marketplace-icon-button" : "plugin-marketplace-coming-soon"}
                  aria-label={plugin.installable ? t("plugins.ui.install", { name: plugin.name }) : t("plugins.ui.comingSoon")}
                  title={plugin.installable ? t("plugins.ui.install", { name: plugin.name }) : undefined}
                  disabled={actionsDisabled || !plugin.installable} onClick={() => performPrimary(plugin)}>
                  {plugin.installable ? <Plus size={18} aria-hidden="true" /> : t("plugins.ui.comingSoon")}
                </button>
              ) : primaryAction(plugin, signedIn, props.officialModelReady) === "update" ? (
                <button type="button" className="plugin-marketplace-icon-button" aria-label={t("plugins.ui.update", { name: plugin.name })}
                  title={t("plugins.ui.updateToVersion", { version: plugin.version! })} disabled={actionsDisabled} onClick={() => performPrimary(plugin)}><RefreshCw size={16} /></button>
              ) : plugin.installed.state === "active" ? (
                <span className="plugin-marketplace-installed-slot">
                  <span className="plugin-marketplace-installed-check" role="img" aria-label={t("memory.cliInstalled")}>
                    <Check size={16} aria-hidden="true" />
                  </span>
                  <Tooltip content={t("plugins.ui.tryIt")}>
                    <button type="button" className="plugin-marketplace-icon-button plugin-marketplace-try"
                      aria-label={t("plugins.ui.addToChat", { name: plugin.name })}
                      onClick={() => addToChat(plugin)}>
                      <MessageSquare size={16} aria-hidden="true" />
                    </button>
                  </Tooltip>
                </span>
              ) : (
                <Button type="button" size="sm" variant="secondary" aria-label={t("plugins.ui.retryInstalling", { name: plugin.name })} disabled={actionsDisabled} onClick={() => performPrimary(plugin)}>{t("plugins.ui.retryInstallation")}</Button>
              )}
              {plugin.installed ? (
                <div className="plugin-marketplace-menu-anchor" data-plugin-menu>
                  <button type="button" aria-label={`${plugin.name}${t("plugins.ui.options")}`} aria-haspopup="menu" aria-expanded={menuId === plugin.id}
                    data-menu-trigger={plugin.id} disabled={busy} onClick={() => setMenuId(menuId === plugin.id ? null : plugin.id)}
                    className="plugin-marketplace-icon-button">
                    <MoreHorizontal size={18} aria-hidden="true" />
                  </button>
                  {menuId === plugin.id ? (
                    <div role="menu" aria-label={`${plugin.name}${t("plugins.ui.actions")}`} className="plugin-marketplace-menu"
                      onKeyDown={(event) => {
                        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)"));
                        const index = items.indexOf(document.activeElement as HTMLButtonElement);
                        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                          event.preventDefault();
                          items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
                        } else if (event.key === "Tab") setMenuId(null);
                      }}>
                      <button type="button" role="menuitem" onClick={() => { setMenuId(null); setDetailId(plugin.id); }}>{t("plugins.ui.viewDetails")}</button>
                      <button type="button" role="menuitem" className="plugin-marketplace-menu-danger" disabled={actionsDisabled} onClick={() => requestUninstall(plugin)}>{t("settings.plugins.uninstall")}</button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            {props.actionErrorPluginId === plugin.id && props.actionError ? (
              <p role="alert" className="plugin-marketplace-row-error">{props.actionError}</p>
            ) : null}
          </article>
        ))}
      </div>

      {detail ? createPortal(
        <Modal open title={detail.name} subtitle={t("plugins.ui.anOfficialMemmyPlugin")} headerIcon={<PluginIcon category={detail.category} />}
          className="plugin-marketplace-detail"
          backdropClassName="plugin-marketplace-detail-backdrop"
          closeLabel={t("common.close")} closeContent={<X size={16} aria-hidden="true" />} onClose={() => setDetailId(null)}
          footer={<div className="plugin-marketplace-detail-footer">
            <span className="plugin-marketplace-detail-status">
              {status(detail)}{detail.installed ? ` · v${detail.installed.version}` : ""}
              {detail.version ? `${detail.installed ? " ｜ " : " · "}${t("plugins.ui.latestVersion", { version: detail.version })}` : ""}
            </span>
            {updateStatus(detail) ? <p className="plugin-marketplace-update-note" role="status">
              {t(updateStatus(detail) === "waiting" ? "plugins.ui.waitingForTasks" : "plugins.ui.installingUpdate")}
            </p> : null}
            <div className="plugin-marketplace-detail-actions">
              {detail.installed ? <button type="button" className="w-full rounded-xl border border-stone-200 bg-white text-stone-700 text-sm font-normal py-2.5 hover:bg-stone-50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed" disabled={actionsDisabled} onClick={() => requestUninstall(detail)}>{t("settings.plugins.uninstall")}</button> : null}
              {renderPrimary(detail) ?? (detail.installed?.state === "active"
                ? <button type="button" className="w-full rounded-xl bg-action-sky text-white text-sm font-normal py-2.5 hover:bg-action-sky-hover transition-colors" onClick={() => addToChat(detail)}>{t("plugin.ui.addToChat")}</button>
                : null)}
            </div>
          </div>}>
          <div className="plugin-marketplace-detail-content">
            {props.actionErrorPluginId === detail.id && props.actionError ? <p role="alert" className="plugin-marketplace-detail-error">{props.actionError}</p> : null}
            {props.error ? <p role="alert" className="plugin-marketplace-detail-error">{props.error}</p> : null}
            <PluginDetailPreview category={detail.category} name={detail.name} />
            <p className="plugin-marketplace-detail-description">
              {capabilityDescription(detail.category, t)}{detail.id !== "literature-review" && detail.requiresOfficialModel ? ` ${t("plugins.ui.memmyOfficialModelsAreRecommendedForThisPlugin")}` : ""}
            </p>
            {detailNote ? <p className="plugin-marketplace-detail-note">{detailNote}</p> : null}
            {!detail.installed && !detail.installable && !detail.requiresLogin ? <p className="plugin-marketplace-detail-note">{t("plugins.ui.anInstallableReleaseIsNotAvailableYet")}</p> : null}
            {detail.installed?.state === "failed" ? <p className="plugin-marketplace-detail-error">{t("plugins.ui.installationCouldNotCompleteRetryInstallationOrContact")}</p> : null}
          </div>
        </Modal>,
        document.body
      ) : null}

      <ConfirmDialog open={Boolean(uninstallId && confirmationValid)}
        title={t("plugins.ui.uninstall", { name: confirmedPlugin?.name ?? "" })}
        message={t("plugins.ui.newTasksWillNoLongerBeAbleTo")}
        cancelLabel={t("settings.model.cancelConfig")} closeLabel={t("common.close")}
        confirmLabel={t("settings.plugins.uninstall")}
        confirmVariant="danger"
        confirmDisabled={actionsDisabled || !confirmationValid} onCancel={() => setUninstallId(null)}
        onConfirm={() => {
          if (actionsDisabled || !confirmationValid || !confirmedPlugin || !uninstallId) return;
          setUninstallId(null);
          props.onUninstall(confirmedPlugin);
        }} />
    </section>
  );
}

function detailModelNote(plugin: MarketplacePlugin, t: ReturnType<typeof useTranslation>["t"]): string | null {
  if (!plugin.requiresLogin) return null;
  if (plugin.id === "literature-review") return t("plugins.ui.literatureReviewModelNote");
  return `${t("plugins.ui.signInRequired")}${plugin.requiresOfficialModel ? t("plugins.ui.memmyOfficialModelsRecommended") : ""}`;
}

function isTransitioning(plugin: MarketplacePlugin): boolean {
  return Boolean(plugin.installed?.update) || plugin.installed?.state === "enabling" || plugin.installed?.state === "disabling";
}

function primaryAction(plugin: MarketplacePlugin, signedIn: boolean, officialModelReady: boolean | undefined): PrimaryAction {
  if (pluginNeedsSignIn(plugin, signedIn)) return "sign-in";
  if (plugin.eligibility?.canUse === false) return "unavailable";
  if (!plugin.installed) {
    if (!plugin.installable) return "unavailable";
    return pluginNeedsSignIn(plugin, signedIn) ? "sign-in" : "install";
  }
  if (plugin.installable && isNewerPluginVersion(plugin.version, plugin.installed.version)) return "update";
  if (plugin.installed.state !== "active") return "enable";
  if (pluginNeedsSignIn(plugin, signedIn)) return "sign-in";
  void officialModelReady;
  return null;
}

function PluginIcon(props: { category: MarketplacePlugin["category"] }) {
  const Icon = props.category === "legal" ? Scale : props.category === "research" ? BookOpen : props.category === "office" ? FileText : Puzzle;
  return <span className={`plugin-marketplace-icon plugin-marketplace-icon--${props.category}`}><Icon size={20} strokeWidth={1.6} aria-hidden="true" /></span>;
}

function capabilityDescription(category: MarketplacePlugin["category"], t: ReturnType<typeof useTranslation>["t"]): string {
  switch (category) {
    case "research": return t("plugins.ui.findPapersForYourResearchTopicOrganizeEvidence");
    case "office": return t("plugins.ui.createAndEditDocumentsSpreadsheetsAndPresentationsAnd");
    case "legal": return t("plugins.ui.helpOrganizeEmploymentResearchMaterialsVerifyInformationAnd");
    case "other": return t("plugins.ui.provideThePluginSCapabilitiesAccordingToYour");
  }
}
