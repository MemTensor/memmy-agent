import { useEffect, useRef, useState } from "react";
import { ChevronDown, Copy, FolderOpen } from "lucide-react";
import styles from "./external-browser-settings.module.css";
import chromeIcon from "../assets/google-chrome.svg";
import edgeIcon from "../assets/microsoft-edge.svg";

export type ExternalBrowserStatus = {
  connected: Array<"chrome" | "edge">;
  claims: Array<{ browser: "chrome" | "edge"; title: string; url: string }>;
};

type Browser = "chrome" | "edge";
type InstallPreparation = { status: "browser-opened" | "browser-not-found" | "browser-launch-failed" | "extension-missing"
  | "managed-installed" | "managed-install-failed"; directory: string | null };

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
  managerStep: string;
  copyAddress: string;
  unpackedStep: string;
  folderStep: string;
  folderMissing: string;
  copyPath: string;
  autoPrepare: string;
  preparing: string;
  prepared: string;
  browserNotFound: string;
  launchFailed: string;
  manualGuide: string;
  managedInstall: string;
  managedConsent: string;
  managedConfirm: string;
  managedCancel: string;
  managedInstalled: string;
  managedFailed: string;
  managedInstalledIntro: string;
  moreBrowsers: string;
};

export function ExternalBrowserSettings({ getStatus, revealExtensionFolder, getExtensionDirectory, prepareInstall, installManaged, manualOnly = false, labels }: {
  getStatus: () => Promise<ExternalBrowserStatus>;
  revealExtensionFolder: () => Promise<void>;
  getExtensionDirectory?: () => Promise<string | null>;
  prepareInstall?: (browser: Browser) => Promise<InstallPreparation>;
  installManaged?: (browser: Browser) => Promise<InstallPreparation>;
  /** Memmy's bundled extension is unpacked and not published in a browser store. */
  manualOnly?: boolean;
  labels: ExternalBrowserLabels;
}) {
  const [status, setStatus] = useState<ExternalBrowserStatus | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [actionError, setActionError] = useState(false);
  const [directory, setDirectory] = useState<string | null | undefined>(undefined);
  const [expanded, setExpanded] = useState<Browser | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [preparing, setPreparing] = useState<Browser | null>(null);
  const [preparation, setPreparation] = useState<Partial<Record<Browser, InstallPreparation["status"]>>>({});
  const [confirmBrowser, setConfirmBrowser] = useState<Browser | null>(null);
  const [showMore, setShowMore] = useState(false);
  const getStatusRef = useRef(getStatus);
  getStatusRef.current = getStatus;
  const getDirectoryRef = useRef(getExtensionDirectory);
  getDirectoryRef.current = getExtensionDirectory;

  useEffect(() => {
    let live = true;
    const refresh = () => void getStatusRef.current().then(value => {
      if (live) { setStatus(value); setStatusError(false); }
    }).catch(() => { if (live) setStatusError(true); });
    refresh();
    const timer = setInterval(refresh, 3_000);
    return () => { live = false; clearInterval(timer); };
  }, []);

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
    setExpanded(browser);
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

  async function confirmManagedInstall(browser: Browser) {
    if (preparing) return;
    setConfirmBrowser(null);
    setPreparing(browser);
    setActionError(false);
    try {
      if (!installManaged) throw new Error("Managed browser installation is unavailable");
      const result = await installManaged(browser);
      setPreparation(current => ({ ...current, [browser]: result.status }));
      setDirectory(result.directory);
      setExpanded(result.status === "managed-installed" ? null : browser);
    } catch {
      setPreparation(current => ({ ...current, [browser]: "managed-install-failed" }));
      setExpanded(browser);
    } finally {
      setPreparing(null);
    }
  }

  return (
    <section className={styles.section}>
      {(["chrome", "edge"] as const).filter(browser => browser === "chrome" || showMore).map(browser => {
        const ready = status?.connected.includes(browser) === true;
        const managerUrl = `${browser}://extensions`;
        return <div className={styles.browser} key={browser}>
          <div className={styles.row}>
            <img className={styles.browserIcon} src={browser === "chrome" ? chromeIcon : edgeIcon} alt="" aria-hidden="true" />
            <div className={styles.browserCopy}>
              <strong>{labels[browser]}</strong>
              {ready
                ? <small>{labels.connected}</small>
                : <small><span className={styles.statusDot} aria-hidden="true" />{labels.notInstalled}</small>}
            </div>
            <button type="button" className={styles.primaryButton} disabled={preparing !== null}
              onClick={() => installManaged && !manualOnly ? setConfirmBrowser(browser) : void prepare(browser)}>
              {preparing === browser ? labels.preparing : labels.managedInstall}
            </button>
          </div>
          {confirmBrowser === browser && <div className={styles.consent} role="group" aria-label={labels.managedInstall}>
            <p>{labels.managedConsent}</p>
            <div className={styles.guideActions}>
              <button type="button" onClick={() => void confirmManagedInstall(browser)}>{labels.managedConfirm}</button>
              <button type="button" onClick={() => setConfirmBrowser(null)}>{labels.managedCancel}</button>
            </div>
          </div>}
          {preparation[browser] && <p role="status" className={styles.preparationStatus}>
            {preparation[browser] === "managed-installed" ? labels.managedInstalled
              : preparation[browser] === "managed-install-failed" ? labels.managedFailed
                : preparation[browser] === "browser-opened" ? labels.prepared
              : preparation[browser] === "browser-not-found" ? labels.browserNotFound
                : preparation[browser] === "extension-missing" ? labels.folderMissing : labels.launchFailed}
          </p>}
          {expanded === browser && <div id={`memmy-${browser}-extension-guide`} className={styles.guide}>
            <strong>{labels.setupTitle} {labels[browser]}</strong>
            <p>{labels.setupIntro}</p>
            <button type="button" className={styles.folderButton} disabled={preparing !== null}
              onClick={() => void prepare(browser)}>{labels.autoPrepare}</button>
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
                {directory === null && <small className={styles.missing}>{labels.folderMissing}</small>}
                {directory && <div className={styles.guideActions}>
                  <code className={styles.path} title={directory}>{directory}</code>
                  <button type="button" onClick={() => void copyText(directory, `path-${browser}`)}>
                    <Copy size={15} aria-hidden="true" />
                    {copied === `path-${browser}` ? labels.copied : labels.copyPath}
                  </button>
                </div>}
                <button type="button" className={styles.folderButton} onClick={() => void revealFolder()}>
                  <FolderOpen size={15} aria-hidden="true" />{labels.install}
                </button>
              </li>
            </ol>
          </div>}
          {preparation[browser] === "managed-installed" && <p>{labels.managedInstalledIntro}</p>}
        </div>;
      })}
      <button type="button" className={styles.moreBrowsers} onClick={() => setShowMore(value => !value)}
        aria-expanded={showMore}>
        {labels.moreBrowsers}<ChevronDown size={15} className={showMore ? styles.chevronOpen : undefined} aria-hidden="true" />
      </button>
      {(statusError || actionError) && <p role="alert" className={styles.error}>{labels.loadError}</p>}
    </section>
  );
}
