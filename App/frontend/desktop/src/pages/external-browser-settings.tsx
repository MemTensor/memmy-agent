import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Copy, FolderOpen, MousePointer2, Play } from "lucide-react";
import type { ExternalBrowserInstallation } from "@memmy/local-api-contracts";
import styles from "./external-browser-settings.module.css";
import chromeIcon from "../assets/google-chrome.svg";
import edgeIcon from "../assets/microsoft-edge.svg";
import memmyIcon from "../assets/memmy-app-icon.png";

export type ExternalBrowserStatus = {
  connected: Array<"chrome" | "edge">;
  claims: Array<{ browser: "chrome" | "edge"; title: string; url: string }>;
};

type Browser = "chrome" | "edge";
type BrowserInstallation = Record<Browser, ExternalBrowserInstallation>;
const unknownInstallation = (): BrowserInstallation => ({
  chrome: { installed: null, enabled: null }, edge: { installed: null, enabled: null },
});
const connectionGraceMs = 60_000;

/** Stop a stalled status or IPC check from freezing a previously connected badge. */
function checkWithDeadline<T>(read: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Browser status check timed out")), 5_000);
  });
  return Promise.race([Promise.resolve().then(read), deadline]).finally(() => clearTimeout(timer));
}

function readablePath(value: string) {
  return value.split(/([/\\])/).map((part, index) => part === "/" || part === "\\"
    ? <span key={index}>{part}<wbr /></span>
    : <span key={index} className={styles.pathSegment}>{part}</span>);
}
type InstallPreparation = { status: "browser-opened" | "browser-not-found" | "browser-launch-failed" | "extension-missing"; directory: string | null };

export type ExternalBrowserLabels = {
  chrome: string;
  edge: string;
  description: string;
  connected: string;
  notInstalled: string;
  disconnected: string;
  install: string;
  copy: string;
  copied: string;
  loadError: string;
  setupTitle: string;
  setupIntro: string;
  developerModeStep: string;
  dragFolderStep: string;
  managerStep: string;
  copyAddress: string;
  unpackedStep: string;
  folderStep: string;
  macFolderHint: string;
  folderMissing: string;
  copyPath: string;
  openPage: string;
  preparing: string;
  prepared: string;
  browserNotFound: string;
  launchFailed: string;
  manualGuide: string;
  installButton: string;
  checking?: string;
  installedWaiting?: string;
  connecting?: string;
  browserClosed?: string;
  connectionFailed?: string;
  statusUnavailable?: string;
  installationUnavailable?: string;
  disabled?: string;
  openBrowser?: string;
  reinstall?: string;
  manage?: string;
  done?: string;
  dragCardTitle?: string;
  dragCardHint?: string;
  installTarget?: string;
  demo?: string;
  demoTitle?: string;
  demoBack?: string;
  demoReplay?: string;
  demoInstruction?: string;
  demoDescription?: string;
  demoDragging?: string;
  demoRelease?: string;
  demoExtensionsHeading?: string;
  demoDeveloperMode?: string;
  fallbackDragStep?: string;
};

function BrowserInstallDemo({ browser, labels, onClose }: {
  browser: Browser;
  labels: ExternalBrowserLabels;
  onClose(): void;
}) {
  const [replay, setReplay] = useState(0);
  const [playing, setPlaying] = useState(false);
  const desktop = useRef<HTMLDivElement>(null);
  const source = useRef<HTMLSpanElement>(null);
  const target = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const withBrowser = (value: string) => value.replaceAll("{browser}", labels[browser]);

  useEffect(() => {
    back.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, []);

  useEffect(() => {
    const frame = desktop.current;
    const start = source.current;
    const finish = target.current;
    if (!frame || !start || !finish) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let animation: Animation | undefined;
    let clone: HTMLElement | undefined;
    const clear = () => {
      if (animation) {
        animation.onfinish = null;
        animation.cancel();
      }
      clone?.remove();
    };
    const play = () => {
      clear();
      if (motion.matches || typeof start.animate !== "function") {
        setPlaying(false);
        return;
      }
      const bounds = frame.getBoundingClientRect();
      const from = start.getBoundingClientRect();
      const to = finish.getBoundingClientRect();
      const dx = to.left + to.width / 2 - from.left - from.width / 2;
      const dy = to.top + to.height / 2 - from.top - from.height / 2;
      clone = start.cloneNode(true) as HTMLElement;
      clone.className = styles.installDemoMovingIcon ?? "";
      clone.style.left = `${from.left - bounds.left}px`;
      clone.style.top = `${from.top - bounds.top}px`;
      frame.append(clone);
      setPlaying(true);
      animation = clone.animate([
        { transform: "translate(0, 0) scale(1)", offset: 0 },
        { transform: "translate(0, -4px) scale(1.08)", offset: .18 },
        { transform: `translate(${dx}px, ${dy}px) scale(.88)`, offset: .85 },
        { transform: `translate(${dx}px, ${dy}px) scale(.88)`, offset: 1 },
      ], { duration: 1900, easing: "ease-in-out", fill: "forwards" });
      animation.onfinish = () => {
        clone?.remove();
        setPlaying(false);
      };
    };
    play();
    window.addEventListener("resize", play);
    motion.addEventListener("change", play);
    return () => {
      window.removeEventListener("resize", play);
      motion.removeEventListener("change", play);
      clear();
    };
  }, [replay, browser]);

  return <section className={styles.installDemo} aria-label={labels.demoTitle ?? "Installation demo"}>
    <div className={styles.installDemoToolbar}>
      <button type="button" ref={back} onClick={onClose}>
        <ArrowLeft size={14} aria-hidden="true" />{labels.demoBack ?? "Back to installation"}
      </button>
      <span>{labels.demoTitle ?? "Installation demo"}</span>
    </div>
    <p className={styles.installDemoTitle}>{withBrowser(labels.demoInstruction
      ?? "Drag the Memmy icon to an empty area of the {browser} extensions page")}</p>
    <div className={`${styles.installDemoDesktop} ${playing ? styles.installDemoPlaying : ""}`} ref={desktop}
      role="img" aria-label={withBrowser(labels.demoDescription
        ?? "Demo: drag the Memmy icon out of the Memmy window and release it on an empty area of the {browser} extensions page.")}
      onDragStart={event => event.preventDefault()}>
      <div className={styles.installDemoWindow} aria-hidden="true">
        <div className={styles.installDemoWindowTitle}><img src={memmyIcon} alt="" draggable={false} />Memmy</div>
        <div className={styles.installDemoMemmyBody}>
          <span className={styles.installDemoSourceIcon} ref={source}>
            <img src={memmyIcon} alt="" draggable={false} />
            <MousePointer2 size={19} className={styles.installDemoPointer} />
          </span>
          <span>{labels.dragCardTitle ?? "Memmy browser extension"}</span>
        </div>
      </div>
      <div className={styles.installDemoWindow} aria-hidden="true">
        <div className={styles.installDemoWindowTitle}>
          <img src={browser === "chrome" ? chromeIcon : edgeIcon} alt="" draggable={false} />{labels[browser]}
        </div>
        <div className={styles.installDemoAddress}>{browser}://extensions</div>
        <div className={styles.installDemoBrowserHeading}>
          <span>{labels.demoExtensionsHeading ?? "Extensions"}</span>
          <small>{labels.demoDeveloperMode ?? "Developer mode"}<i /></small>
        </div>
        <div className={styles.installDemoBrowserSpace} ref={target}>{labels.installTarget ?? "Empty area of the extensions page"}</div>
      </div>
    </div>
    <div className={styles.installDemoFooter}>
      <span role="status" aria-live="polite">{playing
        ? labels.demoDragging ?? "Hold the icon and drag it out of Memmy"
        : labels.demoRelease ?? "Release it on an empty area of the browser extensions page"}</span>
      <button type="button" onClick={() => setReplay(value => value + 1)} disabled={playing}>
        <Play size={13} aria-hidden="true" />{labels.demoReplay ?? "Replay"}
      </button>
    </div>
  </section>;
}

export function ExternalBrowserSettings({ getStatus, getInstallation, getRunning, revealExtensionFolder, getExtensionDirectory, prepareInstall, platform, dragExtension, labels }: {
  getStatus: () => Promise<ExternalBrowserStatus>;
  /** Installed extensions are separate from a verified live browser connection. */
  getInstallation?: () => Promise<BrowserInstallation>;
  /** Null means process observation was unavailable, never that the browser is closed. */
  getRunning?: () => Promise<Array<Browser> | null>;
  revealExtensionFolder: () => Promise<void>;
  getExtensionDirectory?: () => Promise<string | null>;
  prepareInstall?: (browser: Browser) => Promise<InstallPreparation>;
  platform?: string;
  dragExtension?: () => boolean;
  labels: ExternalBrowserLabels;
}) {
  const [status, setStatus] = useState<ExternalBrowserStatus | null>(null);
  const [installation, setInstallation] = useState<BrowserInstallation>(unknownInstallation);
  const [installChecked, setInstallChecked] = useState(false);
  const [running, setRunning] = useState<Browser[] | null>(null);
  const [checkedAt, setCheckedAt] = useState(0);
  const [managementBrowser, setManagementBrowser] = useState<Browser | null>(null);
  const managementRef = useRef<Browser | null>(null);
  managementRef.current = managementBrowser;
  const disconnectedSince = useRef(new Map<Browser, number>());
  const [statusError, setStatusError] = useState(false);
  const [actionError, setActionError] = useState(false);
  const [directory, setDirectory] = useState<string | null | undefined>(undefined);
  const [expanded, setExpanded] = useState<ReadonlySet<Browser>>(() => new Set());
  const [copied, setCopied] = useState<string | null>(null);
  const [preparing, setPreparing] = useState<Browser | null>(null);
  const [preparation, setPreparation] = useState<Partial<Record<Browser, InstallPreparation["status"]>>>({});
  const [demoBrowser, setDemoBrowser] = useState<Browser | null>(null);
  const demoButtons = useRef<Partial<Record<Browser, HTMLButtonElement>>>({});
  const restoreDemoFocus = useRef<Browser | null>(null);
  const getStatusRef = useRef(getStatus);
  getStatusRef.current = getStatus;
  const getInstallationRef = useRef(getInstallation);
  getInstallationRef.current = getInstallation;
  const getRunningRef = useRef(getRunning);
  getRunningRef.current = getRunning;
  const getDirectoryRef = useRef(getExtensionDirectory);
  getDirectoryRef.current = getExtensionDirectory;

  useEffect(() => {
    let live = true;
    let refreshing = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      if (!live || refreshing) return;
      refreshing = true;
      clearTimeout(timer);
      void (async () => {
        const [statusResult, installationResult, runningResult] = await Promise.allSettled([
          checkWithDeadline(() => getStatusRef.current()),
          checkWithDeadline(() => getInstallationRef.current?.() ?? Promise.resolve(unknownInstallation())),
          checkWithDeadline(() => getRunningRef.current?.() ?? Promise.resolve(null)),
        ]);
        if (!live) return;
        const now = Date.now();
        const runningBrowsers = runningResult.status === "fulfilled" ? runningResult.value : null;
        setRunning(runningBrowsers);
        setInstallChecked(true);
        setCheckedAt(now);
        const installations = installationResult.status === "fulfilled" ? installationResult.value : unknownInstallation();
        setInstallation(installations);
        for (const browser of ["chrome", "edge"] as const) {
          const installed = installations?.[browser];
          if (installed?.installed !== true || installed.enabled !== true || runningBrowsers?.includes(browser) === false
            || (statusResult.status === "fulfilled" && statusResult.value.connected.includes(browser))) {
            disconnectedSince.current.delete(browser);
          } else if (!disconnectedSince.current.has(browser)) disconnectedSince.current.set(browser, now);
        }
        if (statusResult.status === "rejected") {
          // A successful old response is not evidence of a connection during an outage.
          setStatus(null);
          setStatusError(true);
          return;
        }
        const value = statusResult.value;
        setStatus(value);
        setStatusError(false);
        const connectedAutomatically = (browser: Browser | null) => browser !== null
          && value.connected.includes(browser) && managementRef.current !== browser;
        setExpanded(current => {
          const next = new Set(current);
          for (const browser of ["chrome", "edge"] as const) {
            const connected = value.connected.includes(browser) && managementRef.current !== browser;
            if (connected) next.delete(browser);
          }
          return next;
        });
        setDemoBrowser(current => connectedAutomatically(current) ? null : current);
        setPreparation(current => {
          if (!value.connected.some(browser => current[browser])) return current;
          const next = { ...current };
          for (const browser of value.connected) delete next[browser];
          return next;
        });
      })().finally(() => {
        refreshing = false;
        if (live) timer = setTimeout(refresh, 3_000);
      });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      live = false;
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  useEffect(() => {
    if (!demoBrowser && restoreDemoFocus.current) {
      demoButtons.current[restoreDemoFocus.current]?.focus();
      restoreDemoFocus.current = null;
    }
  }, [demoBrowser]);

  function closeDemo() {
    restoreDemoFocus.current = demoBrowser;
    setDemoBrowser(null);
  }

  useEffect(() => {
    let live = true;
    if (!getDirectoryRef.current) { setDirectory(null); return; }
    void getDirectoryRef.current().then(value => {
      if (live) setDirectory(value);
    }).catch(() => {
      if (live) { setDirectory(null); setActionError(true); }
    });
    return () => { live = false; };
  }, []);

  async function revealFolder() {
    try { await revealExtensionFolder(); setActionError(false); }
    catch { setActionError(true); }
  }

  async function copyText(value: string | null | undefined, field: string) {
    if (!value) return;
    try { await navigator.clipboard.writeText(value); setCopied(field); setActionError(false); }
    catch { setActionError(true); }
  }

  async function prepare(browser: Browser) {
    if (preparing) return;
    setPreparing(browser);
    setActionError(false);
    setExpanded(current => new Set(current).add(browser));
    setDemoBrowser(null);
    try {
      if (!prepareInstall) throw new Error("Browser installation preparation is unavailable");
      const result = await prepareInstall(browser);
      setPreparation(current => ({ ...current, [browser]: result.status }));
      setDirectory(result.directory);
    } catch {
      setPreparation(current => ({ ...current, [browser]: "browser-launch-failed" }));
    } finally {
      setPreparing(null);
    }
  }

  const startDrag = dragExtension ?? window.memmy?.dragBrowserExtension;

  return (
    <section className={styles.section}>
      {(["chrome", "edge"] as const).map(browser => {
        const ready = !statusError && status?.connected.includes(browser) === true;
        const installed = installation?.[browser];
        const hasInstallation = installed?.installed === true;
        const notInstalled = installed?.installed === false;
        const disabled = hasInstallation && installed.enabled === false;
        const installationUnavailable = !notInstalled && (!hasInstallation
          || (installed?.enabled !== true && installed?.enabled !== false));
        const enabled = hasInstallation && installed.enabled === true;
        const browserClosed = enabled && running?.includes(browser) === false;
        const since = disconnectedSince.current.get(browser);
        const connectionFailed = enabled && !browserClosed && !ready
          && since !== undefined && checkedAt - since >= connectionGraceMs;
        const showSetup = !ready || managementBrowser === browser;
        const connectionText = disabled ? labels.disabled ?? "Memmy extension is disabled. Enable it in the browser."
          : installationUnavailable ? labels.installationUnavailable ?? "Unable to read Memmy extension status. Open Manage to view it in the browser."
          : notInstalled ? labels.notInstalled
          : statusError ? labels.statusUnavailable ?? "Connection status is unavailable."
          : browserClosed ? labels.browserClosed ?? "Installed. Open the browser to connect."
          : connectionFailed ? labels.connectionFailed ?? "Installed. Connection has not recovered."
          : running === null
            ? labels.installedWaiting ?? "Installed. Waiting for the browser to connect."
            : labels.connecting ?? "Installed. Connecting automatically…";
        const managerUrl = `${browser}://extensions`;
        return <div className={styles.browser} key={browser}>
          <div className={styles.row}>
            <img className={styles.browserIcon} src={browser === "chrome" ? chromeIcon : edgeIcon} alt="" aria-hidden="true" />
            <div className={styles.browserCopy}>
              <strong>{labels[browser]}</strong>
              {ready
                ? <small>{labels.connected}</small>
                : installChecked
                  ? <small>{(!hasInstallation || disabled || installationUnavailable || connectionFailed || statusError) &&
                    <span className={styles.statusDot} aria-hidden="true" />}{connectionText}</small>
                  : <small>{labels.checking ?? "Checking installation…"}</small>}
            </div>
            {installChecked && (ready || browserClosed) && <div className={styles.rowActions}>
              <button type="button" className={styles.secondaryButton} disabled={preparing !== null}
                aria-expanded={managementBrowser === browser}
                onClick={() => { setManagementBrowser(current => current === browser ? null : browser);
                  setDemoBrowser(null); }}>
                {managementBrowser === browser ? labels.done ?? "Done" : labels.manage ?? "Manage"}
              </button>
              {managementBrowser === browser && <button type="button" className={styles.secondaryButton}
                disabled={preparing !== null}
                aria-expanded={expanded.has(browser)} aria-controls={`memmy-${browser}-extension-guide`}
                onClick={() => void prepare(browser)}>
                {preparing === browser ? labels.preparing : labels.reinstall ?? "Reinstall"}
              </button>}
            </div>}
            {showSetup && installChecked && !ready && !browserClosed && <div className={styles.rowActions}>
              <button type="button" className={styles.primaryButton} disabled={preparing !== null}
                aria-expanded={expanded.has(browser)} aria-controls={`memmy-${browser}-extension-guide`}
                onClick={() => void prepare(browser)}>
                {preparing === browser ? labels.preparing
                  : installationUnavailable || disabled ? labels.manage ?? "Manage"
                  : hasInstallation ? labels.reinstall ?? "Reinstall" : labels.installButton}
              </button>
            </div>}
          </div>
          {showSetup && installChecked && preparation[browser] && preparation[browser] !== "browser-opened" && <p role="status" className={styles.preparationStatus}>
            {preparation[browser] === "browser-not-found" ? labels.browserNotFound
              : preparation[browser] === "extension-missing" ? labels.folderMissing : labels.launchFailed}
          </p>}
          {showSetup && installChecked && expanded.has(browser) && <div id={`memmy-${browser}-extension-guide`} className={styles.guide}>
            {demoBrowser === browser ? <BrowserInstallDemo browser={browser} labels={labels} onClose={closeDemo} /> : <>
            {directory === null && <small className={styles.missing}>{labels.folderMissing}</small>}
            <ol>
              <li>{labels.developerModeStep}</li>
              <li>{startDrag ? labels.dragFolderStep : (labels.fallbackDragStep ?? labels.dragFolderStep)}</li>
            </ol>
            {startDrag && directory && <div className={styles.dragSourceRow}>
              <div className={styles.dragCard} draggable role="img"
                aria-label={labels.dragCardHint ?? labels.dragFolderStep}
                onDragStart={event => {
                  event.preventDefault();
                  try { setActionError(!startDrag()); }
                  catch { setActionError(true); }
                }}>
                <img src={memmyIcon} alt="" draggable={false} aria-hidden="true" />
                <div className={styles.dragCardCopy}>
                  <strong>{labels.dragCardTitle ?? "Memmy"}</strong>
                  <small>{labels.dragCardHint ?? labels.dragFolderStep}</small>
                </div>
              </div>
            </div>}
            <div className={styles.installActions}>
              {startDrag && directory && labels.demo && <button className={styles.demoButton} type="button"
                ref={node => {
                  if (node) demoButtons.current[browser] = node;
                  else delete demoButtons.current[browser];
                }} onClick={() => setDemoBrowser(browser)}>
                <Play size={13} aria-hidden="true" />{labels.demo}
              </button>}
              <button type="button" className={styles.openPage} disabled={preparing !== null}
                onClick={() => void prepare(browser)}>{labels.openPage}</button>
            </div>
            <details className={styles.fallback}>
              <summary>{labels.manualGuide}</summary>
              <ol>
                <li>
                  <span>{labels.managerStep}</span>
                  <div className={styles.guideActions}>
                    <code>{managerUrl}</code>
                    <button type="button" onClick={() => void copyText(managerUrl, `address-${browser}`)}>
                      <Copy size={15} aria-hidden="true" />
                      {copied === `address-${browser}` ? labels.copied : labels.copyAddress}
                    </button>
                  </div>
                </li>
                <li>{labels.unpackedStep}</li>
                <li>
                  <span>{labels.folderStep}</span>
                  {directory && <div className={`${styles.guideActions} ${styles.pathActions}`}>
                    <code className={styles.path} title={directory}>{readablePath(directory)}</code>
                    <button type="button" onClick={() => void copyText(directory, `path-${browser}`)}>
                      <Copy size={15} aria-hidden="true" />
                      {copied === `path-${browser}` ? labels.copied : labels.copyPath}
                    </button>
                  </div>}
                  {platform === "darwin" && directory && <p className={styles.hint}>{labels.macFolderHint}</p>}
                  <button type="button" className={styles.revealFolder} onClick={() => void revealFolder()}>
                    <FolderOpen size={15} aria-hidden="true" />{labels.install}
                  </button>
                </li>
              </ol>
            </details>
            </>}
          </div>}
        </div>;
      })}
      {(statusError || actionError) && <p role="alert" className={styles.error}>{labels.loadError}</p>}
    </section>
  );
}
