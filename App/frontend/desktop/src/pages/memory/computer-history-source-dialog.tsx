import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Plus, Search, X } from "lucide-react";
import type { ComputerHistoryObservationSettings } from "../../api/computer-history-contract.js";
import type { MemmyAgentClient } from "../../api/memmy-agent-client.js";
import { useTranslation } from "../../i18n/use-translation.js";
import { AppIcon } from "./app-icon.js";

type Rule = ComputerHistoryObservationSettings["observation"]["rules"][number];
type Scope = Rule["scope"];
type Behavior = Rule["behavior"];
const APP_MENU_WIDTH = 240;

function opposite(behavior: Behavior): Behavior {
  return behavior === "observe" ? "do_not_observe" : "observe";
}

function ruleKey(rule: Rule): string {
  return rule.scope === "app" ? rule.bundleID : rule.urlDomain;
}

function normalizeDomain(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
    const host = new URL(candidate).hostname.replace(/\.$/u, "").replace(/^www\./u, "").toLowerCase();
    return host.includes(".") ? host : null;
  } catch {
    return null;
  }
}

/** Drafts the scope locally. Cancel never changes the recorder's settings. */
export function ComputerHistorySourceDialog(props: {
  client: MemmyAgentClient | null;
  open: boolean;
  mode: "start" | "edit";
  onCancel(): void;
  onContinue(): void;
}) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<ComputerHistoryObservationSettings | null>(null);
  const [applications, setApplications] = useState<Array<{ bundleId: string; name: string }>>([]);
  const [catalogState, setCatalogState] = useState<"loading" | "ready" | "error">("loading");
  const [appQuery, setAppQuery] = useState("");
  const [activeAppIndex, setActiveAppIndex] = useState(0);
  const [appMenuOpen, setAppMenuOpen] = useState(false);
  const [appMenuBox, setAppMenuBox] = useState({ top: 0, left: 0 });
  const [domainInput, setDomainInput] = useState("");
  const [addingWebsite, setAddingWebsite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const addAppRef = useRef<HTMLButtonElement | null>(null);
  const appMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!props.open) return;
    let active = true;
    setSettings(null);
    setError(null);
    setAddingWebsite(false);
    setAppMenuOpen(false);
    setAppQuery("");
    setDomainInput("");
    setCatalogState("loading");
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    if (props.client) {
      void props.client.getComputerHistorySettings().then((value) => {
        if (active) setSettings(value);
      }).catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
      void props.client.listComputerHistoryApplications().then((items) => {
        if (!active) return;
        setApplications(items);
        setCatalogState("ready");
      }).catch(() => {
        if (active) setCatalogState("error");
      });
    }
    return () => {
      active = false;
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [props.open, props.client]);

  useEffect(() => {
    if (!props.open || busy) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        if (appMenuOpen) {
          event.preventDefault();
          event.stopPropagation();
          setAppMenuOpen(false);
          return;
        }
        event.preventDefault();
        props.onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled)") ?? [])];
      const first = controls[0];
      const last = controls.at(-1);
      if (!first || !last) return;
      if (!dialogRef.current?.contains(document.activeElement) || document.activeElement === dialogRef.current) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [props.open, props.onCancel, busy, appMenuOpen]);

  useEffect(() => {
    if (appMenuOpen) return;
    setAppQuery("");
    setActiveAppIndex(0);
  }, [appMenuOpen]);

  useEffect(() => {
    if (!appMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (addAppRef.current?.contains(target) || appMenuRef.current?.contains(target)) return;
      setAppMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [appMenuOpen]);

  const appNames = useMemo(() => new Map(applications.map((app) => [app.bundleId, app.name])), [applications]);
  const selectedBundleIds = useMemo(() => new Set(
    settings?.observation.rules.filter((rule) => rule.scope === "app").map((rule) => rule.bundleID) ?? [],
  ), [settings]);
  const availableApps = useMemo(() => applications
    .filter((app) => !selectedBundleIds.has(app.bundleId))
    .sort((left, right) => left.bundleId.localeCompare(right.bundleId)), [applications, selectedBundleIds]);
  const matchingApps = useMemo(() => {
    const query = appQuery.trim().toLocaleLowerCase();
    if (!query) return availableApps;
    return availableApps.filter((app) =>
      app.name.toLocaleLowerCase().includes(query) || app.bundleId.toLocaleLowerCase().includes(query));
  }, [availableApps, appQuery]);
  const highlightedAppIndex = Math.min(activeAppIndex, Math.max(matchingApps.length - 1, 0));

  function placeAppMenu() {
    const button = addAppRef.current;
    const dialog = dialogRef.current;
    if (!button || !dialog) return;
    const buttonBox = button.getBoundingClientRect();
    const dialogBox = dialog.getBoundingClientRect();
    const left = Math.max(8, Math.min(buttonBox.left - dialogBox.left, dialogBox.width - APP_MENU_WIDTH - 8));
    setAppMenuBox({ top: buttonBox.bottom - dialogBox.top + 4, left });
  }

  useLayoutEffect(() => {
    if (!appMenuOpen) return;
    placeAppMenu();
    const list = addAppRef.current?.closest(".ch-source-dialog__list");
    const onMove = () => placeAppMenu();
    window.addEventListener("resize", onMove);
    list?.addEventListener("scroll", onMove);
    return () => {
      window.removeEventListener("resize", onMove);
      list?.removeEventListener("scroll", onMove);
    };
  }, [appMenuOpen]);

  function defaultBehavior(scope: Scope): Behavior {
    return scope === "app" ? settings!.observation.defaultApplicationBehavior : settings!.observation.defaultURLBehavior;
  }

  function setBehavior(scope: Scope, behavior: Behavior) {
    if (!settings) return;
    setSettings({ ...settings, observation: {
      ...settings.observation,
      ...(scope === "app" ? { defaultApplicationBehavior: behavior } : { defaultURLBehavior: behavior }),
      rules: settings.observation.rules.map((rule) =>
        rule.scope === scope ? { ...rule, behavior: opposite(behavior) } : rule),
    } });
  }

  function addApp(bundleId: string) {
    if (!settings) return;
    const value = bundleId.trim();
    if (!value) return;
    const rule: Rule = { scope: "app", bundleID: value, behavior: opposite(defaultBehavior("app")) };
    setSettings({ ...settings, observation: { ...settings.observation,
      rules: [...settings.observation.rules.filter((item) => item.scope !== "app" || ruleKey(item) !== value), rule],
    } });
    setError(null);
  }

  function addWebsite() {
    if (!settings) return;
    const value = normalizeDomain(domainInput);
    if (!value) {
      setError(t("computerHistory.sources.invalidDomain"));
      return;
    }
    const rule: Rule = { scope: "url", urlDomain: value, behavior: opposite(defaultBehavior("url")) };
    setSettings({ ...settings, observation: { ...settings.observation,
      rules: [...settings.observation.rules.filter((item) => item.scope !== "url" || ruleKey(item) !== value), rule],
    } });
    setError(null);
    setDomainInput("");
    setAddingWebsite(false);
  }

  function onAppSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (matchingApps.length === 0) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActiveAppIndex((index) => (Math.min(index, matchingApps.length - 1) + delta + matchingApps.length) % matchingApps.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const app = matchingApps[highlightedAppIndex];
      if (app) addApp(app.bundleId);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setAppMenuOpen(false);
    }
  }

  async function continueWithSources() {
    if (!props.client || !settings || busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.client.updateComputerHistorySettings(settings);
      props.onContinue();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!props.open) return null;

  return createPortal(<div className="ch-source-dialog__backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !busy) props.onCancel();
  }}>
    <section ref={dialogRef} className="ch-source-dialog" role="dialog" aria-modal="true" aria-labelledby="ch-source-dialog-title" aria-describedby="ch-source-dialog-privacy" tabIndex={-1}>
      <h2 id="ch-source-dialog-title" className="sr-only">{t("computerHistory.sources.dialogTitle")}</h2>
      {!settings && !error ? <p className="ch-source-dialog__loading">{t("computerHistory.sources.loading")}</p> : null}
      {settings ? <div className="ch-source-dialog__columns">
        {(["app", "url"] as const).map((scope) => {
          const behavior = defaultBehavior(scope);
          const rules = settings.observation.rules.filter((rule) => rule.scope === scope);
          return <div className="ch-source-dialog__column" key={scope}>
            <label className="ch-source-dialog__select-label">
              <select value={behavior} disabled={busy} aria-label={t(scope === "app" ? "computerHistory.sources.apps" : "computerHistory.sources.websites")}
                onChange={(event) => setBehavior(scope, event.target.value as Behavior)}>
                <option value="observe">{t(scope === "app" ? "computerHistory.sources.dialogExcludeApps" : "computerHistory.sources.dialogExcludeWebsites")}</option>
                <option value="do_not_observe">{t(scope === "app" ? "computerHistory.sources.dialogIncludeApps" : "computerHistory.sources.dialogIncludeWebsites")}</option>
              </select>
              <ChevronDown size={16} aria-hidden="true" />
            </label>
            <div className="ch-source-dialog__list">
              {scope === "app" ? <button ref={addAppRef} type="button" className="ch-source-dialog__add" disabled={busy}
                aria-expanded={appMenuOpen} aria-haspopup="listbox" aria-controls="ch-app-menu"
                onClick={() => {
                  if (appMenuOpen) {
                    setAppMenuOpen(false);
                    return;
                  }
                  setActiveAppIndex(0);
                  placeAppMenu();
                  setAppMenuOpen(true);
                }}>
                <span className="ch-source-dialog__add-icon" aria-hidden="true"><Plus size={18} /></span>
                {t("computerHistory.sources.dialogAddApp")}
              </button> : addingWebsite ? <div className="ch-source-dialog__add-field">
                <input autoFocus value={domainInput}
                  onChange={(event) => setDomainInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      setDomainInput("");
                      setAddingWebsite(false);
                      return;
                    }
                    if (event.key === "Enter") addWebsite();
                  }}
                  placeholder={t("computerHistory.sources.domain")}
                  aria-label={t("computerHistory.sources.domain")} />
                <button type="button" disabled={busy} onClick={addWebsite}>{t("computerHistory.sources.add")}</button>
              </div> : <button type="button" className="ch-source-dialog__add" disabled={busy} onClick={() => setAddingWebsite(true)}>
                <Plus size={18} /> {t("computerHistory.sources.dialogAddWebsite")}
              </button>}
              <ul className="ch-source-dialog__rules">{rules.map((rule) => <li key={ruleKey(rule)}>
                {rule.scope === "app" ? <AppIcon bundleId={rule.bundleID} client={props.client} /> : null}
                <span>{rule.scope === "app" ? appNames.get(rule.bundleID) ?? rule.bundleID : rule.urlDomain}</span>
                <button type="button" disabled={busy} aria-label={t("computerHistory.sources.remove", { name: ruleKey(rule) })}
                  onClick={() => setSettings({ ...settings, observation: { ...settings.observation,
                    rules: settings.observation.rules.filter((item) => item !== rule),
                  } })}><X size={16} /></button>
              </li>)}</ul>
            </div>
          </div>;
        })}
      </div> : null}
      {settings && appMenuOpen ? <div ref={appMenuRef} id="ch-app-menu" className="ch-source-dialog__app-menu" role="listbox"
        aria-label={t("computerHistory.sources.matches")} style={{ top: appMenuBox.top, left: appMenuBox.left }}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.querySelector("input")?.focus();
        }}>
        <div className="ch-source-dialog__app-search">
          <Search size={14} aria-hidden="true" />
          <input autoFocus value={appQuery} aria-label={t("computerHistory.sources.searchApps")}
            placeholder={t("computerHistory.sources.searchApps")}
            onChange={(event) => {
              setAppQuery(event.target.value);
              setActiveAppIndex(0);
            }}
            onKeyDown={onAppSearchKeyDown} />
        </div>
        {catalogState === "ready" && matchingApps.length > 0 ? matchingApps.map((app, index) =>
          <button type="button" role="option" key={app.bundleId} className="ch-source-dialog__app-option"
            aria-selected={index === highlightedAppIndex} onMouseEnter={() => setActiveAppIndex(index)}
            onClick={() => addApp(app.bundleId)}>
            <AppIcon bundleId={app.bundleId} client={props.client} />
            <span>{app.name}</span>
          </button>) : <p className="ch-source-dialog__app-empty" role="status">{t(
            catalogState === "loading" ? "computerHistory.sources.loadingApps"
              : catalogState === "error" ? "computerHistory.sources.catalogUnavailable"
                : availableApps.length === 0 ? "computerHistory.sources.allAppsAdded"
                  : "computerHistory.sources.noAppsFound")}</p>}
      </div> : null}
      <p id="ch-source-dialog-privacy" className="ch-source-dialog__privacy">{t("computerHistory.sources.browserPrivacy")}</p>
      {error ? <p className="ch-source-dialog__error" role="alert">{error}</p> : null}
      <div className="ch-source-dialog__footer">
        <button type="button" disabled={busy} onClick={props.onCancel}>{t("dialog.cancel")}</button>
        <button type="button" disabled={!settings || busy} className="ch-source-dialog__continue" onClick={() => void continueWithSources()}>
          {t(props.mode === "start" ? "computerHistory.sources.continue" : "computerHistory.sources.save")}
        </button>
      </div>
    </section>
  </div>, document.body);
}
