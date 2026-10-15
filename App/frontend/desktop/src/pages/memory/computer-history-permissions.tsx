import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Globe, Plus, Search, X } from "lucide-react";
import { Modal } from "../../components/modal.js";
import { Button } from "../../components/button.js";
import { useTranslation } from "../../i18n/use-translation.js";
import type { MemmyAgentClient } from "../../api/memmy-agent-client.js";
import type { ComputerHistoryObservationPermissions, ComputerHistoryApplication } from "../../api/computer-history-contract.js";
import { AppIcon } from "./app-icon.js";
import { normalizeWebsite } from "./computer-history-permissions-utils.js";

type Observation = ComputerHistoryObservationPermissions["settings"]["observation"];
type Scope = "app" | "url";
type Behavior = Observation["defaultApplicationBehavior"];

/** Mounted afresh when opened, so Cancel cannot leak a draft into a later edit. */
export function ComputerHistoryPermissionsDialog(props: { client: MemmyAgentClient; onClose(): void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ComputerHistoryObservationPermissions | null>(null);
  const [apps, setApps] = useState<ComputerHistoryApplication[]>([]);
  const [appQuery, setAppQuery] = useState("");
  const [popover, setPopover] = useState<"app-mode" | "url-mode" | "apps" | null>(null);
  const [addingWebsite, setAddingWebsite] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const websiteAddRef = useRef<HTMLButtonElement>(null);
  const wasAddingWebsite = useRef(false);
  const appSearchRef = useRef<HTMLInputElement>(null);
  const popupTrigger = useRef<HTMLButtonElement | null>(null);
  const firstModeRef = useRef<HTMLButtonElement>(null);
  const [website, setWebsite] = useState("");
  const [error, setError] = useState("");
  const [appError, setAppError] = useState("");
  const [inputError, setInputError] = useState("");
  const [loading, setLoading] = useState(true);
  const [appsLoading, setAppsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const savingRef = useRef(false);
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { mounted.current = false; document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    let live = true;
    setLoading(true); setAppsLoading(true); setError(""); setAppError(""); setDraft(null);
    void props.client.getComputerHistoryObservationPermissions().then((value) => { if (live) setDraft(value); })
      .catch((cause) => { if (live) setError(String(cause)); }).finally(() => { if (live) setLoading(false); });
    void props.client.listComputerHistoryApplications().then((value) => { if (live) setApps(value); })
      .catch((cause) => { if (live) setAppError(String(cause)); }).finally(() => { if (live) setAppsLoading(false); });
    return () => { live = false; };
  }, [props.client, reload]);


  useEffect(() => {
    if (!popover) return;
    if (popover === "apps") appSearchRef.current?.focus();
    else firstModeRef.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(`[data-ch-popover="${popover}"]`)) setPopover(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopImmediatePropagation();
      setPopover(null); popupTrigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape, true); };
  }, [popover]);

  useEffect(() => {
    if (wasAddingWebsite.current && !addingWebsite) websiteAddRef.current?.focus();
    wasAddingWebsite.current = addingWebsite;
  }, [addingWebsite]);

  function togglePopover(value: "app-mode" | "url-mode" | "apps", trigger: HTMLButtonElement) {
    popupTrigger.current = trigger;
    setPopover((current) => current === value ? null : value);
  }

  function update(change: (observation: Observation) => Observation) {
    setDraft((current) => current ? { ...current, settings: { observation: change(current.settings.observation) } } : current);
  }
  function mode(scope: Scope, behavior: Behavior) {
    update((value) => ({ ...value, [scope === "app" ? "defaultApplicationBehavior" : "defaultURLBehavior"]: behavior,
      rules: value.rules.map((rule) => rule.scope === scope ? { ...rule, behavior: behavior === "observe" ? "do_not_observe" : "observe" } : rule) }));
  }
  function add(scope: Scope, id: string) {
    update((value) => {
      const exists = value.rules.some((rule) => rule.scope === scope && (rule.scope === "app" ? rule.bundleID : rule.urlDomain) === id);
      if (exists) return value;
      const fallback = scope === "app" ? value.defaultApplicationBehavior : value.defaultURLBehavior;
      const behavior = fallback === "observe" ? "do_not_observe" : "observe";
      return { ...value, rules: [...value.rules, scope === "app" ? { scope, bundleID: id, behavior } : { scope, urlDomain: id, behavior }] };
    });
  }
  function addWebsite() {
    const domain = normalizeWebsite(website);
    if (!domain) { setInputError(t("computerHistory.permissionsInvalidWebsite")); return; }
    add("url", domain); setWebsite(""); setInputError(""); setAddingWebsite(false);
  }
  async function save() {
    if (!draft || savingRef.current) return;
    let candidate = draft;
    // A pasted exclusion must not be lost just because Save was clicked before +.
    if (website.trim()) {
      const domain = normalizeWebsite(website);
      if (!domain) { setInputError(t("computerHistory.permissionsInvalidWebsite")); return; }
      const value = candidate.settings.observation;
      if (!value.rules.some((rule) => rule.scope === "url" && rule.urlDomain === domain)) {
        candidate = { ...candidate, settings: { observation: { ...value, rules: [...value.rules,
          { scope: "url", urlDomain: domain, behavior: value.defaultURLBehavior === "observe" ? "do_not_observe" : "observe" }] } } };
      }
      setDraft(candidate); setWebsite(""); setInputError("");
    }
    savingRef.current = true; setSaving(true); setError("");
    try { await props.client.saveComputerHistoryObservationPermissions(candidate); if (mounted.current) props.onClose(); }
    catch (cause) { if (mounted.current) setError(`${t("computerHistory.permissionsSaveFailed")} ${String(cause)}`); }
    finally { savingRef.current = false; if (mounted.current) setSaving(false); }
  }
  const observation = draft?.settings.observation;
  const selectedApps = new Set(observation?.rules.filter((rule) => rule.scope === "app").map((rule) => rule.bundleID));
  const availableApps = apps.filter((app) => !selectedApps.has(app.bundleId) &&
    `${app.name} ${app.bundleId}`.toLowerCase().includes(appQuery.toLowerCase()));

  const modeLabel = (scope: Scope, behavior: Behavior) => t(scope === "app"
    ? behavior === "observe" ? "computerHistory.permissionsExcludeApps" : "computerHistory.permissionsIncludeApps"
    : behavior === "observe" ? "computerHistory.permissionsExcludeWebsites" : "computerHistory.permissionsIncludeWebsites");

  return createPortal(<Modal open title={t("computerHistory.permissions")} showHeader={false}
    className="ch-permissions" backdropClassName="ch-permissions-backdrop"
    style={{ width: 840, maxWidth: "calc(100vw - 48px)" }}
    onClose={saving ? undefined : props.onClose}
    footer={<><Button variant="ghost" disabled={saving} onClick={props.onClose}>{t("dialog.cancel")}</Button>
      <Button variant="primary" disabled={saving || loading || !draft || (observation?.rules.length ?? 0) > 1000} onClick={() => void save()}>
        {t(saving ? "computerHistory.permissionsSaving" : "computerHistory.permissionsDone")}</Button></>}>
    {loading && <p role="status">{t("common.loading")}</p>}
    {error && <div role="alert" className="ch-permissions__error">{error}
      <Button size="sm" variant="ghost" disabled={saving} onClick={() => setReload((value) => value + 1)}>{t("computerHistory.permissionsReload")}</Button></div>}
    {observation && <fieldset disabled={saving} className="ch-permissions__fieldset">
      <div className="ch-permissions__columns">{(["app", "url"] as const).map((scope) => {
        const behavior = scope === "app" ? observation.defaultApplicationBehavior : observation.defaultURLBehavior;
        const rules = observation.rules.map((rule, index) => ({ rule, index })).filter(({ rule }) => rule.scope === scope);
        const custom = rules.some(({ rule }) => rule.behavior === behavior);
        const menu = scope === "app" ? "app-mode" : "url-mode";
        return <div className="ch-permissions__column" key={scope}>
          <div className="ch-permissions__mode" data-ch-popover={menu}
            onBlur={(event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setPopover((current) => current === menu ? null : current); }}>
            <button type="button" className="ch-permissions__mode-trigger" aria-haspopup="menu" aria-expanded={popover === menu}
              onClick={(event) => togglePopover(menu, event.currentTarget)}
              onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); popupTrigger.current = event.currentTarget; setPopover(menu); } }}>
              {modeLabel(scope, behavior)}<ChevronDown size={17} aria-hidden="true" />
            </button>
            {popover === menu && <div role="menu" aria-label={t(scope === "app" ? "computerHistory.permissionsApps" : "computerHistory.permissionsWebsites")}
              className="ch-permissions__popover ch-permissions__mode-menu"
              onKeyDown={(event) => {
                const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
                const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                  event.preventDefault();
                  buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
                }
              }}>
              {(["observe", "do_not_observe"] as const).map((option) => <button key={option} type="button" role="menuitemradio"
                ref={option === behavior ? firstModeRef : undefined} aria-checked={option === behavior}
                onClick={() => { if (option !== behavior) mode(scope, option); setPopover(null); popupTrigger.current?.focus(); }}>
                <span>{modeLabel(scope, option)}</span>{option === behavior && <Check size={18} aria-hidden="true" />}
              </button>)}
            </div>}
          </div>
          <div className="ch-permissions__list">
            {scope === "app" ? <div className="ch-permissions__app-add" data-ch-popover="apps"
              onBlur={(event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setPopover((current) => current === "apps" ? null : current); }}>
              <button type="button" className="ch-permissions__add" aria-expanded={popover === "apps"}
                onClick={(event) => togglePopover("apps", event.currentTarget)}><Plus size={22} aria-hidden="true" />{t("computerHistory.permissionsAddApp")}</button>
              {popover === "apps" && <div className="ch-permissions__popover ch-permissions__picker">
                <label className="ch-permissions__search"><Search size={18} aria-hidden="true" />
                  <input ref={appSearchRef} aria-label={t("computerHistory.permissionsSearch")} placeholder={t("computerHistory.permissionsSearch")} value={appQuery} onChange={(event) => setAppQuery(event.target.value)} /></label>
                {appsLoading ? <p role="status">{t("common.loading")}</p> : appError ? <p role="alert">{appError}<button type="button" onClick={() => setReload((value) => value + 1)}>{t("computerHistory.permissionsReload")}</button></p> :
                  <div className="ch-permissions__results">{availableApps.length ? availableApps.slice(0, 30).map((app) =>
                    <button type="button" key={app.bundleId} title={app.bundleId} onClick={() => { add("app", app.bundleId); setPopover(null); setAppQuery(""); popupTrigger.current?.focus(); }}>
                      <AppIcon client={props.client} bundleId={app.bundleId} /><span>{app.name}</span></button>) : <p>{t("computerHistory.permissionsNoApps")}</p>}</div>}
                {availableApps.length > 30 && <p className="ch-permissions__note">{t("computerHistory.permissionsMoreApps")}</p>}
              </div>}
            </div> : addingWebsite ? <div className="ch-permissions__website-input">
              <span className="ch-permissions__website-icon"><Globe size={20} aria-hidden="true" /></span>
              <input autoFocus aria-label={t("computerHistory.permissionsAddWebsite")} placeholder="example.com" value={website}
                onChange={(event) => { setWebsite(event.target.value); setInputError(""); }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") { event.preventDefault(); addWebsite(); }
                  if (event.key === "Escape") { event.stopPropagation(); setWebsite(""); setInputError(""); setAddingWebsite(false); }
                }} />
              <button type="button" className="ch-permissions__website-save" aria-label={t("computerHistory.permissionsSaveWebsite")} onClick={addWebsite}>{t("common.save")}</button>
            </div> : <button ref={websiteAddRef} type="button" className="ch-permissions__add" onClick={() => { setPopover(null); setAddingWebsite(true); }}>
              <Plus size={22} aria-hidden="true" />{t("computerHistory.permissionsAddWebsite")}</button>}
            {scope === "url" && inputError && <p role="alert" className="ch-permissions__error">{inputError}</p>}
            <div className="ch-permissions__entries">{rules.map(({ rule, index }) => {
              const id = rule.scope === "app" ? rule.bundleID : rule.urlDomain;
              const name = rule.scope === "app" ? apps.find((app) => app.bundleId === id)?.name ?? id : id;
              return <div className="ch-permissions__row" key={`${id}-${index}`}>
                {rule.scope === "app" ? <AppIcon client={props.client} bundleId={id} /> : <span className="ch-permissions__website-icon"><Globe size={20} aria-hidden="true" /></span>}
                <span className="ch-permissions__label" title={id}>{name}{custom && <small>{t(rule.behavior === "observe" ? "computerHistory.permissionsAllowed" : "computerHistory.permissionsBlocked")}</small>}</span>
                <button type="button" aria-label={t("computerHistory.permissionsRemove", { name })} onClick={() => update((value) => ({ ...value, rules: value.rules.filter((_, i) => i !== index) }))}><X size={16} /></button>
              </div>;
            })}</div>
            {!rules.length && behavior === "do_not_observe" && <p className="ch-permissions__empty">{t(scope === "app" ? "computerHistory.permissionsEmptyApps" : "computerHistory.permissionsEmptyWebsites")}</p>}
          </div>
          {custom && <p className="ch-permissions__note">{t("computerHistory.permissionsCustom")}</p>}
        </div>;
      })}</div>
      <div className="ch-permissions__privacy">
        <span>{t("computerHistory.permissionsFutureOnly")}</span>{" "}
        <button type="button" aria-expanded={showDetails} onClick={() => setShowDetails(!showDetails)}>{t("computerHistory.permissionsDetails")}</button>
        {showDetails && <div className="ch-permissions__details"><p>{t("computerHistory.permissionsScopeNote")}</p><p>{t("computerHistory.permissionsPrivacyNote")}</p></div>}
      </div>
    </fieldset>}
  </Modal>, document.body);
}
