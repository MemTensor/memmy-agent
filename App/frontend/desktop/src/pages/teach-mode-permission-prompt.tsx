import { useCallback, useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import type { MemmyAgentClient } from "../api/memmy-agent-client.js";
import type { ComputerHistoryPermission, ComputerHistoryPermissions } from "../api/computer-history-contract.js";
import { useTranslation } from "../i18n/use-translation.js";
import { Button } from "../components/button.js";
import { BrowserInstallDemo } from "./external-browser-settings.js";
import styles from "./external-browser-settings.module.css";
import memmyIcon from "../assets/memmy-app-icon.png";
import "./teach-mode-permission-prompt.css";

const permissions: ComputerHistoryPermission[] = ["accessibility", "inputMonitoring"];
type Browser = "chrome" | "edge";
type ExtensionState = "checking" | "enabled" | "disabled" | "missing" | "unknown";
const browsers: Browser[] = ["chrome", "edge"];
const browserName = (browser: Browser) => browser === "chrome" ? "Chrome" : "Edge";

async function readExtensions(): Promise<Record<Browser, ExtensionState>> {
  try {
    const installation = await window.memmy?.getBrowserExtensionInstallation?.();
    return Object.fromEntries(browsers.map(browser => {
      const result = installation?.[browser];
      const state: ExtensionState = result?.installed === true && result.enabled === true ? "enabled"
        : result?.installed === true && result.enabled === false ? "disabled"
          : result?.installed === false ? "missing" : "unknown";
      return [browser, state];
    })) as Record<Browser, ExtensionState>;
  } catch { return { chrome: "unknown", edge: "unknown" }; }
}

/**
 * The recording prompt shown before Teach Mode starts desktop capture.
 *
 * Grants are opened from the process that installs the History tap. The browser
 * extension is optional: it only makes web interactions more precise, so it can
 * be installed for Chrome or Edge, or skipped by closing the prompt.
 */
export function TeachModePermissionPrompt(props: {
  client: MemmyAgentClient;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ComputerHistoryPermissions | null>(null);
  const [extensions, setExtensions] = useState<Record<Browser, ExtensionState>>({ chrome: "checking", edge: "checking" });
  const [busy, setBusy] = useState(false);
  const [guiding, setGuiding] = useState(false);
  const [inputMonitoringGuided, setInputMonitoringGuided] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const active = useRef(false);
  const guideActive = useRef(false);

  const check = useCallback(async () => {
    if (active.current) return;
    active.current = true;
    try {
      const [next, installed] = await Promise.all([
        props.client.checkComputerHistoryPermissions(),
        // Only the desktop shell exposes the installation probe.
        window.memmy?.getBrowserExtensionInstallation ? readExtensions() : Promise.resolve(null),
      ]);
      if (!mounted.current) return;
      setStatus(next);
      if (installed) setExtensions(installed);
      setError(null);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      active.current = false;
    }
  }, [props.client]);

  useEffect(() => {
    mounted.current = true;
    void check();
    // Each check launches the native helper, so refresh on return instead of polling.
    const focus = () => { if (document.visibilityState !== "hidden") void check(); };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      mounted.current = false;
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [check]);

  const openPermission = async (permission: ComputerHistoryPermission) => {
    if (guideActive.current) return;
    guideActive.current = true;
    setGuiding(true);
    setError(null);
    let failed = false;
    try {
      // The request must come from the process that installs the History tap.
      try { await props.client.openComputerHistoryPermission(permission, "request"); } catch { /* Settings remains available. */ }
      if (!mounted.current) return;
      const granted = await window.memmy?.guideMemmyPermission?.(permission);
      if (permission === "inputMonitoring" && granted && mounted.current) setInputMonitoringGuided(true);
    } catch (cause) {
      failed = true;
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      guideActive.current = false;
      if (mounted.current) { setGuiding(false); if (!failed) void check(); }
    }
  };

  const restart = async () => {
    if (busy || guideActive.current) return;
    setBusy(true);
    setError(null);
    try {
      // Check again: a permission may have been revoked since the dialog refreshed.
      const next = await props.client.checkComputerHistoryPermissions();
      if (!mounted.current) return;
      setStatus(next);
      // The running process may not report input listening until the app restarts.
      if (next.supported && next.accessibility && (next.inputMonitoring || inputMonitoringGuided)) {
        await window.memmy?.restartForComputerHistoryPermissions?.();
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (mounted.current) setBusy(false); }
  };

  const authorized = Boolean(status?.supported && status.accessibility && (status.inputMonitoring || inputMonitoringGuided));
  const extensionEnabled = extensions.chrome === "enabled" || extensions.edge === "enabled";
  const blocked = busy || guiding;
  return <section className="teach-permission-card" role="group"
    aria-label={t(authorized ? "plugins.teachPermission.restartTitle" : "plugins.teachPermission.title")}>
    <div className="teach-permission-card__header">
      <strong>{t(authorized ? "plugins.teachPermission.restartTitle" : "plugins.teachPermission.title")}</strong>
      <button type="button" aria-label={t("common.close")} disabled={blocked}
        onClick={() => { if (!guideActive.current) props.onDismiss(); }}><X size={16} aria-hidden="true" /></button>
    </div>
    <p className="teach-permission-card__description">{t("plugins.teachPermission.description")}</p>
    {status?.supported === false ? <p role="status">{t("computerHistory.permissions.macOnly")}</p> : <div className="teach-permission-card__list">
      {permissions.map(permission =>
        <div className="teach-permission-card__row" key={permission}>
          <span>{t(permission === "accessibility" ? "plugins.teachPermission.accessibility" : "plugins.teachPermission.inputMonitoring")}</span>
          {!status ? <span role="status">{t("plugins.teachPermission.checking")}</span>
            : status[permission] ? <span className="teach-permission-card__granted" role="status"><Check size={16} aria-hidden="true" />{t("plugins.teachPermission.granted")}</span>
              : permission === "inputMonitoring" && inputMonitoringGuided
                ? <span className="teach-permission-card__granted" role="status">{t("plugins.teachPermission.pendingRestart")}</span>
                : <Button type="button" variant="primary" className="teach-permission-card__open" size="sm" disabled={blocked}
                  onClick={() => void openPermission(permission)}>{t("plugins.teachPermission.open")}</Button>}
        </div>)}
      <ExtensionRow extensions={extensions} extensionEnabled={extensionEnabled}
        t={t} blocked={blocked} onCheck={() => void check()} />
    </div>}
    {inputMonitoringGuided && !status?.inputMonitoring
      ? <p className="teach-permission-card__description" role="status">{t("plugins.teachPermission.restartRequired")}</p> : null}
    {error ? <p role="alert" className="teach-permission-card__error">{t("computerHistory.permissions.checkFailed", { error })}</p> : null}
    <div className="teach-permission-card__footer">
      <Button type="button" variant="ghost" size="sm" disabled={blocked} onClick={() => void check()}>{t("plugins.teachPermission.recheck")}</Button>
      <Button type="button" variant="ghost" size="sm" disabled={blocked} onClick={() => { if (!guideActive.current) props.onDismiss(); }}>{t("plugins.teachPermission.start")}</Button>
      {authorized ? <Button type="button" variant="primary" size="sm"
        disabled={blocked || !window.memmy?.restartForComputerHistoryPermissions} onClick={() => void restart()}>
        {t("computerHistory.permissions.restart")}</Button> : null}
    </div>
  </section>;
}

function ExtensionRow(props: {
  extensions: Record<Browser, ExtensionState>;
  extensionEnabled: boolean;
  t: ReturnType<typeof useTranslation>["t"];
  blocked: boolean;
  onCheck: () => void;
}) {
  const { t, extensions, extensionEnabled, blocked, onCheck } = props;
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Browser | null>(null);
  const [prepared, setPrepared] = useState<Browser | null>(null);
  const [preparing, setPreparing] = useState<Browser | null>(null);
  const [demo, setDemo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preparingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const prepare = async (browser: Browser) => {
    if (preparingRef.current) return;
    preparingRef.current = true;
    setSelected(browser); setPreparing(browser); setPrepared(null); setDemo(false); setError(null);
    try {
      const result = await window.memmy?.prepareBrowserExtension?.(browser, false);
      if (result?.status !== "browser-opened" || !result.directory) throw new Error();
      if (mounted.current) setPrepared(browser);
    } catch {
      if (mounted.current) setError(t("plugins.teachPermission.extensionPrepareFailed", { browser: browserName(browser) }));
    } finally {
      preparingRef.current = false;
      if (mounted.current) setPreparing(null);
    }
  };

  const stateLabel = (state: ExtensionState) => t(state === "enabled" ? "plugins.teachPermission.extensionEnabled"
    : state === "disabled" ? "plugins.teachPermission.extensionDisabled"
      : state === "checking" ? "plugins.teachPermission.checking" : "plugins.teachPermission.extensionMissing");
  const name = selected ? browserName(selected) : "";

  return <div className="teach-permission-card__extension">
    <div className="teach-permission-card__row">
      <span>{t("plugins.teachPermission.extension")}</span>
      <div className="teach-permission-card__extension-actions">
        {extensionEnabled ? <span className="teach-permission-card__granted" role="status"><Check size={16} aria-hidden="true" />{t("plugins.teachPermission.extensionEnabled")}</span> : null}
        <Button type="button" variant={extensionEnabled ? "ghost" : "primary"} size="sm" disabled={blocked}
          aria-expanded={open} aria-controls="teach-permission-extension"
          onClick={() => { setOpen(value => !value); onCheck(); }}>
          {t(open ? "plugins.teachPermission.extensionCollapse" : extensionEnabled ? "plugins.teachPermission.extensionManage" : "plugins.teachPermission.extensionInstall")}
        </Button>
      </div>
    </div>
    {open ? <div id="teach-permission-extension" className="teach-permission-card__extension-body">
      <p className="teach-permission-card__extension-hint">{t("plugins.teachPermission.extensionHint")}</p>
      <div className="teach-permission-card__browsers">{browsers.map(browser => {
        const state = extensions[browser];
        const active = selected === browser;
        return <button type="button" key={browser} disabled={preparing !== null}
          className={`teach-permission-card__browser${active ? " is-selected" : ""}`}
          aria-expanded={active} aria-controls="teach-permission-extension-steps"
          onClick={() => {
            if (state === "enabled") { setSelected(browser); setError(null); setDemo(false); }
            else void prepare(browser);
          }}>
          <span className="teach-permission-card__browser-copy"><strong>{browser === "chrome" ? "Google Chrome" : "Microsoft Edge"}</strong>
            <small className={state === "enabled" ? "is-enabled" : ""}>{stateLabel(state)}</small></span>
          <span className="teach-permission-card__browser-action">
            {t(preparing === browser ? "plugins.teachPermission.extensionOpening"
              : state === "enabled" ? "plugins.teachPermission.extensionEnabled"
                : state === "disabled" ? "plugins.teachPermission.extensionEnable" : "plugins.teachPermission.extensionInstall")}
          </span>
        </button>;
      })}</div>
      {selected ? <div id="teach-permission-extension-steps" className="teach-permission-card__steps">
        {demo ? <BrowserInstallDemo key={selected} browser={selected} onClose={() => setDemo(false)} labels={{
          chrome: "Google Chrome", edge: "Microsoft Edge",
          demoTitle: t("plugins.teachPermission.extensionDemoTitle"),
          demoBack: t("settings.computerUse.extensionDemoBack"),
          demoInstruction: t("plugins.teachPermission.extensionDemoInstruction", { browser: name }),
          demoDescription: t("plugins.teachPermission.extensionDemoInstruction", { browser: name }),
          dragCardTitle: t("settings.computerUse.extensionDragCardTitle"),
          demoExtensionsHeading: t("plugins.teachPermission.extension"),
          demoDeveloperMode: t("plugins.teachPermission.extensionDeveloperMode"),
          installTarget: t("plugins.teachPermission.extensionDropTarget"),
          demoDragging: t("plugins.teachPermission.extensionDemoDragging"),
          demoRelease: t("plugins.teachPermission.extensionDemoRelease"),
          demoReplay: t("settings.computerUse.extensionDemoReplay"),
        }} /> : <>
          <ol className="teach-permission-card__instructions">
            <li>{t("plugins.teachPermission.extensionStepPrefix")}{" "}
              <button type="button" className="teach-permission-card__page-link" disabled={preparing !== null}
                onClick={() => void prepare(selected)}>{t("plugins.teachPermission.extensionPage", { browser: name })}</button>{" "}
              {t("plugins.teachPermission.extensionStepSuffix")}</li>
            <li>{t("plugins.teachPermission.extensionStepTwo")}</li>
          </ol>
          {extensions[selected] === "disabled"
            ? <p className="teach-permission-card__description">{t("plugins.teachPermission.extensionDisabledHint", { browser: name })}</p>
            : <div className={`${styles.dragCard} teach-permission-card__drag`} draggable={prepared === selected}
              role="img" aria-label={t("settings.computerUse.extensionDragCardHint")}
              onDragStart={event => {
                if (prepared !== selected) { event.preventDefault(); return; }
                // The native directory drag must start synchronously inside dragstart.
                event.preventDefault();
                try {
                  if (!window.memmy?.dragBrowserExtension || !window.memmy.dragBrowserExtension()) setError(t("plugins.teachPermission.extensionDragFailed"));
                } catch { setError(t("plugins.teachPermission.extensionDragFailed")); }
              }}>
              <img src={memmyIcon} alt="" draggable={false} />
              <div className={styles.dragCardCopy}><strong>{t("settings.computerUse.extensionDragCardTitle")}</strong>
                <small>{t("settings.computerUse.extensionDragCardHint")}</small></div>
            </div>}
          <div className="teach-permission-card__extension-tools">
            <Button type="button" variant="ghost" size="sm" disabled={preparing !== null}
              onClick={() => void prepare(selected)}>{t("settings.computerUse.extensionOpenPage")}</Button>
            <button type="button" className="teach-permission-card__demo" onClick={() => setDemo(true)}>{t("settings.computerUse.extensionDemo")}</button>
          </div>
        </>}
        {error ? <p role="alert" className="teach-permission-card__error">{error}</p> : null}
      </div> : null}
    </div> : null}
  </div>;
}
