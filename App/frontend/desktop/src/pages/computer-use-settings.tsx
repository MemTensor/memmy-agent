import { useEffect, useRef, useState } from "react";
import { AppWindow, LockKeyhole, X } from "lucide-react";
import type { MemmyAgentClient, NativeAppApproval } from "../api/memmy-agent-client.js";
import { useTranslation } from "../i18n/use-translation.js";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import styles from "./computer-use-settings.module.css";
import { ExternalBrowserSettings } from "./external-browser-settings.js";
import { openExternalUrl } from "../utils/open-url.js";
import computerUseIcon from "../assets/computer-use-plugin-icon.png";
import excelIcon from "../assets/microsoft-excel.png";

type ComputerUseStatus = { enabled: boolean; available: boolean; binaryAvailable: boolean; restartRequired?: boolean };
type ExcelAddinStatus = Awaited<ReturnType<MemmyAgentClient["getExcelAddinStatus"]>>;
type LockedMacStatus = { available: boolean; installed: boolean; consented: boolean;
  reason?: 'unsupported' | 'missing' | 'probe-failed' };

export function ComputerUseSettings(props: { client?: MemmyAgentClient; platform?: string }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ComputerUseStatus | null>(null);
  const [excelStatus, setExcelStatus] = useState<ExcelAddinStatus | null>(null);
  const [excelBusy, setExcelBusy] = useState(false);
  const [excelError, setExcelError] = useState<string | null>(null);
  const [excelPermissionDismissed, setExcelPermissionDismissed] = useState(false);
  const [awaitingExcelPermission, setAwaitingExcelPermission] = useState(false);
  const [lockedMacStatus, setLockedMacStatus] = useState<LockedMacStatus | null>(null);
  const [lockedMacBusy, setLockedMacBusy] = useState(false);
  const [lockedMacError, setLockedMacError] = useState(false);
  const [approvals, setApprovals] = useState<NativeAppApproval[]>([]);
  const [revokeBusy, setRevokeBusy] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<NativeAppApproval | null>(null);
  const [approvalError, setApprovalError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [allowAll, setAllowAll] = useState(false);
  const [allowAllReady, setAllowAllReady] = useState(false);
  const [allowAllBusy, setAllowAllBusy] = useState(false);
  const approvalEpoch = useRef(0);

  useEffect(() => {
    let live = true;
    if (!props.client) return;
    void props.client.getComputerUseSetting().then((value) => {
      if (live) { setStatus(value); setError(false); }
    }).catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [props.client]);

  useEffect(() => {
    let live = true;
    if (typeof props.client?.getNativeAppApprovals !== "function") return;
    const load = () => {
      const seen = approvalEpoch.current;
      void props.client!.getNativeAppApprovals().then(value => {
        if (live && seen === approvalEpoch.current) { setApprovals(value); setApprovalError(false); }
      }).catch(() => { if (live && seen === approvalEpoch.current) setApprovalError(true); });
    };
    load();
    const timer = window.setInterval(load, 2000);
    window.addEventListener("focus", load);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [props.client]);

  useEffect(() => {
    let live = true;
    const read = window.memmy?.getNativeAppAllowAll;
    if (!read) {
      setAllowAllReady(true);
      return;
    }
    void read().then(value => {
      if (live) { setAllowAll(value); setAllowAllReady(true); }
    }).catch(() => { if (live) { setError(true); setAllowAllReady(true); } });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!props.client || !status || status.enabled || status.binaryAvailable === false
      || typeof props.client.setComputerUseEnabled !== "function" || busy) return;
    void setEnabled(true);
  }, [props.client, status?.enabled, status?.binaryAvailable]);

  async function revokeApproval(item: NativeAppApproval) {
    if (!props.client || revokeBusy || typeof props.client.revokeNativeAppApproval !== "function") return;
    const epoch = approvalEpoch.current + 1;
    approvalEpoch.current = epoch;
    setRevokeBusy(`${item.platform}:${item.appId}`);
    setApprovalError(false);
    try {
      const next = await props.client.revokeNativeAppApproval(item.platform, item.appId);
      if (approvalEpoch.current === epoch) setApprovals(next);
    } catch {
      if (approvalEpoch.current === epoch) setApprovalError(true);
    } finally {
      if (approvalEpoch.current === epoch) approvalEpoch.current += 1;
      setRevokeBusy(null);
    }
  }

  async function confirmRevokeApproval() {
    if (!pendingRevoke) return;
    await revokeApproval(pendingRevoke);
    setPendingRevoke(null);
  }

  useEffect(() => {
    let live = true;
    if (typeof props.client?.getExcelAddinStatus !== "function") return;
    const refresh = () => {
      void props.client!.getExcelAddinStatus().then(value => {
        if (live) setExcelStatus(value);
      }).catch(() => {
        if (live) setExcelStatus(null);
      });
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => { live = false; clearInterval(timer); };
  }, [props.client]);

  useEffect(() => {
    let live = true;
    if (props.platform !== 'darwin' || !window.memmy?.getLockedMacUseStatus) return;
    void window.memmy.getLockedMacUseStatus().then(value => {
      if (live) setLockedMacStatus(value);
    }).catch(() => { if (live) setLockedMacError(true); });
    return () => { live = false; };
  }, [props.platform]);

  async function setEnabled(enabled: boolean) {
    if (!props.client || busy || typeof props.client.setComputerUseEnabled !== "function") return;
    setBusy(true);
    setError(false);
    try {
      setStatus(await props.client.setComputerUseEnabled(enabled));
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function setAllowAllApps(enabled: boolean) {
    if (!window.memmy?.setNativeAppAllowAll || allowAllBusy) return;
    setAllowAllBusy(true);
    setError(false);
    try {
      setAllowAll(await window.memmy.setNativeAppAllowAll(enabled));
    } catch {
      setError(true);
    } finally {
      setAllowAllBusy(false);
    }
  }

  const excelPermissionOpen = Boolean(excelStatus?.manualInstallPath) && !excelPermissionDismissed;
  const retryExcelInstall = useRef<() => Promise<void>>(async () => undefined);

  useEffect(() => {
    if (!excelStatus?.manualInstallPath) setExcelPermissionDismissed(false);
  }, [excelStatus?.manualInstallPath]);

  useEffect(() => {
    if (!awaitingExcelPermission) return;
    const retry = () => { void retryExcelInstall.current(); };
    window.addEventListener("focus", retry);
    return () => window.removeEventListener("focus", retry);
  }, [awaitingExcelPermission]);

  function describeExcelFailure(error: unknown): string {
    const fallback = t("settings.computerUse.excelSetupError");
    const detail = error instanceof Error ? error.message.trim().replace(/^Excel add-in setup failed:\s*/i, "") : "";
    return detail ? `${fallback}：${detail}` : fallback;
  }

  async function enableExcel() {
    if ((!props.client?.setExcelAddinEnabled && !props.client?.enableExcelAddin) || excelBusy) return;
    setExcelBusy(true);
    setExcelError(null);
    try {
      const next = await (props.client.setExcelAddinEnabled
        ? props.client.setExcelAddinEnabled(true)
        : props.client.enableExcelAddin!());
      setExcelStatus(next);
      if (!next.manualInstallPath) setAwaitingExcelPermission(false);
    } catch (error) {
      setExcelError(describeExcelFailure(error));
    } finally {
      setExcelBusy(false);
    }
  }
  retryExcelInstall.current = enableExcel;

  function openExcelPermissionSettings() {
    setAwaitingExcelPermission(true);
    void openExternalUrl("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles");
  }

  async function setExcelEnabled(enabled: boolean) {
    if (excelBusy || !props.client) return;
    if (enabled) return enableExcel();
    if (!props.client.setExcelAddinEnabled) return;
    setExcelBusy(true);
    setExcelError(null);
    try {
      setExcelStatus(await props.client.setExcelAddinEnabled(false));
    } catch (error) {
      setExcelError(describeExcelFailure(error));
    } finally {
      setExcelBusy(false);
    }
  }

  async function changeLockedMac() {
    if (!window.memmy?.changeLockedMacUse || !lockedMacStatus
      || (!lockedMacStatus.available && !lockedMacStatus.installed) || lockedMacBusy) return;
    setLockedMacBusy(true);
    setLockedMacError(false);
    try {
      setLockedMacStatus(await window.memmy.changeLockedMacUse(lockedMacStatus.installed ? 'uninstall' : 'install'));
    } catch {
      setLockedMacError(true);
    } finally {
      setLockedMacBusy(false);
    }
  }

  async function setLockedMacEnabled(enabled: boolean) {
    if (!window.memmy?.setLockedMacUseConsent || !lockedMacStatus || lockedMacBusy
      || !lockedMacStatus.available) return;
    setLockedMacBusy(true);
    setLockedMacError(false);
    try {
      if (enabled && !lockedMacStatus.installed) {
        const installed = await window.memmy.changeLockedMacUse?.('install');
        if (!installed?.installed) throw new Error('Lock-screen helper was not installed');
        setLockedMacStatus(installed);
      }
      setLockedMacStatus(await window.memmy.setLockedMacUseConsent(enabled));
    } catch {
      setLockedMacError(true);
    } finally {
      setLockedMacBusy(false);
    }
  }

  const isWindows = props.platform === "win32";
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1>{t("settings.computerUse")}</h1>
          <p>{t("settings.computerUse.description")}</p>
        </div>
      </header>

      <h2>{t("settings.computerUse.control")}</h2>
      <div className={styles.card}>
        <div className={styles.row}>
          <span className={styles.icon}><img src={computerUseIcon} alt="" aria-hidden="true" /></span>
          <span className={styles.copy}>
            <strong>{t("settings.computerUse.anyApp")}</strong>
            <small>{status?.binaryAvailable === false
              ? t("settings.computerUse.helperMissing")
              : t(isWindows ? "settings.computerUse.anyAppWindows" : "settings.computerUse.anyAppMac")}</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            aria-label={t("settings.computerUse.anyApp")}
            checked={allowAll}
            disabled={!allowAllReady || allowAllBusy || !window.memmy?.setNativeAppAllowAll || status?.binaryAvailable === false}
            onChange={(event) => void setAllowAllApps(event.target.checked)}
            className={styles.switch}
          />
        </div>
        <ExternalBrowserSettings
          getStatus={() => typeof props.client?.getExternalBrowserStatus === "function"
            ? props.client.getExternalBrowserStatus()
            : Promise.reject(new Error("Computer use browser status is unavailable"))}
          revealExtensionFolder={async () => {
            if (!window.memmy?.revealBrowserExtension || !await window.memmy.revealBrowserExtension()) {
              throw new Error("Browser extension folder is unavailable");
            }
          }}
          getExtensionDirectory={() => window.memmy?.getBrowserExtensionDirectory?.() ?? Promise.resolve(null)}
          prepareInstall={async browser => {
            if (!window.memmy?.prepareBrowserExtension) throw new Error("Browser installation preparation is unavailable");
            return window.memmy.prepareBrowserExtension(browser);
          }}
          installManaged={async browser => {
            if (!window.memmy?.installManagedBrowserExtension) throw new Error("Managed browser installation is unavailable");
            return window.memmy.installManagedBrowserExtension(browser);
          }}
          manualOnly
          labels={{
            chrome: t("settings.computerUse.chrome"),
            edge: t("settings.computerUse.edge"),
            description: t("settings.computerUse.extensionDescription"),
            connected: t("settings.computerUse.extensionReady"),
            disconnected: t("settings.computerUse.notConnected"),
            notInstalled: t("settings.computerUse.extensionNotInstalled"),
            install: t("settings.computerUse.extensionOpenFolder"),
            copy: t("settings.computerUse.extensionCopy"),
            copied: t("settings.computerUse.extensionCopied"),
            loadError: t("settings.computerUse.extensionLoadError"),
            setupTitle: t("settings.computerUse.extensionSetupTitle"),
            setupIntro: t("settings.computerUse.extensionSetupIntro"),
            managerStep: t("settings.computerUse.extensionManagerStep"),
            copyAddress: t("settings.computerUse.extensionCopyAddress"),
            unpackedStep: t("settings.computerUse.extensionUnpackedStep"),
            folderStep: t("settings.computerUse.extensionFolderStep"),
            folderMissing: t("settings.computerUse.extensionFolderMissing"),
            copyPath: t("settings.computerUse.extensionCopyPath"),
            autoPrepare: t("settings.computerUse.extensionAutoPrepare"),
            preparing: t("settings.computerUse.extensionPreparing"),
            prepared: t("settings.computerUse.extensionPrepared"),
            browserNotFound: t("settings.computerUse.extensionBrowserNotFound"),
            launchFailed: t("settings.computerUse.extensionLaunchFailed"),
            manualGuide: t("settings.computerUse.extensionManualGuide"),
            managedInstall: t("settings.computerUse.extensionManagedInstall"),
            managedConsent: t("settings.computerUse.extensionManagedConsent"),
            managedConfirm: t("settings.computerUse.extensionManagedConfirm"),
            managedCancel: t("settings.computerUse.extensionManagedCancel"),
            managedInstalled: t("settings.computerUse.extensionManagedInstalled"),
            managedFailed: t("settings.computerUse.extensionManagedFailed"),
            managedInstalledIntro: t("settings.computerUse.extensionManagedInstalledIntro"),
            moreBrowsers: t("settings.computerUse.moreBrowsers"),
          }}
        />
        <div className={styles.row}>
          <span className={styles.icon}><img src={excelIcon} alt="" aria-hidden="true" /></span>
          <span className={styles.copy}>
            <strong>Microsoft Excel</strong>
            <small>{t("settings.computerUse.excelDescription")}</small>
            {excelStatus?.configured && excelStatus.connected && <small>{t("settings.computerUse.excelConnected")}</small>}
            {excelError && <small role="alert" className={styles.error}>{excelError}</small>}
          </span>
          <input type="checkbox" role="switch" aria-label="Microsoft Excel"
            checked={excelStatus?.configured === true} disabled={excelBusy || !props.client}
            onChange={event => void setExcelEnabled(event.target.checked)} className={styles.switch} />
        </div>
        {excelStatus?.manualInstallPath && excelPermissionDismissed && <div className={styles.guide}>
          <button type="button" onClick={() => setExcelPermissionDismissed(false)}>{t("settings.computerUse.excelPermissionTitle")}</button>
        </div>}
        {excelStatus?.configured && !excelStatus.connected && excelStatus.connectionCount === 0 && !excelStatus.manualInstallPath
          && <div className={styles.guide}>
            <strong>{t("settings.computerUse.excelOpenTitle")}</strong>
            <ol>
              <li>{t("settings.computerUse.excelOpenHint")}</li>
              <li>{t("settings.computerUse.excelOpenKeep")}</li>
            </ol>
          </div>}
      </div>

      {!isWindows && <div className={styles.card}>
        <div className={styles.row}>
          <span className={styles.icon}><LockKeyhole size={22} aria-hidden="true" /></span>
          <span className={styles.copy}>
            <strong>{t("settings.computerUse.locked")}</strong>
            <small>{t("settings.computerUse.lockedMac")}</small>
            {lockedMacStatus?.installed && <button type="button" className={styles.setupButton}
              disabled={lockedMacBusy} onClick={() => void changeLockedMac()}>{t(lockedMacBusy
                ? "settings.computerUse.lockedMacWorking" : "settings.computerUse.lockedMacRemove")}</button>}
            {lockedMacError && <small role="alert" className={styles.error}>{t("settings.computerUse.lockedMacError")}</small>}
          </span>
          {lockedMacStatus?.available ? <input type="checkbox" role="switch"
            aria-label={t("settings.computerUse.locked")}
            checked={lockedMacStatus.consented} disabled={lockedMacBusy}
            onChange={event => void setLockedMacEnabled(event.target.checked)} className={styles.switch} />
            : <span className={styles.badge}>{t("settings.computerUse.notConnected")}</span>}
        </div>
      </div>}

      {typeof props.client?.getNativeAppApprovals === "function" && <>
        <h2>{t("settings.computerUse.alwaysAllowed")}</h2>
        <div className={styles.card}>
          {approvals.length === 0 ? <div className={styles.empty}>{t(allowAll
            ? "settings.computerUse.allowAllEmpty" : "settings.computerUse.noAllowlist")}</div> : approvals.map(item => (
            <div className={styles.row} key={`${item.platform}:${item.appId}`}>
              <span className={styles.icon}><AppWindow size={22} aria-hidden="true" /></span>
              <span className={styles.copy}><strong>{item.displayName}</strong></span>
              <button type="button" className={styles.revokeButton}
                aria-label={`${t("settings.computerUse.revoke")} ${item.displayName}`}
                disabled={revokeBusy !== null}
                onClick={() => setPendingRevoke(item)}>
                <X size={16} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
        {approvalError && <p role="alert" className={styles.error}>{t("settings.computerUse.approvalError")}</p>}
      </>}

      {status?.restartRequired && <p className={styles.platformNote}>{t("settings.computerUse.restartRequired")}</p>}
      {error && <p role="alert" className={styles.error}>{t("settings.computerUse.loadError")}</p>}
      <ConfirmDialog
        open={excelPermissionOpen}
        title={t("settings.computerUse.excelPermissionTitle")}
        message={t("settings.computerUse.excelPermissionMessage")}
        cancelLabel={t("settings.computerUse.excelPermissionLater")}
        confirmLabel={t("settings.computerUse.excelGoSettings")}
        onCancel={() => { setExcelPermissionDismissed(true); setAwaitingExcelPermission(false); }}
        onConfirm={openExcelPermissionSettings}
      />
      <ConfirmDialog
        open={pendingRevoke !== null}
        title={pendingRevoke ? t("settings.computerUse.revokeTitle", { displayName: pendingRevoke.displayName }) : undefined}
        message={pendingRevoke ? t("settings.computerUse.revokeDescription", { displayName: pendingRevoke.displayName }) : ""}
        cancelLabel={t("dialog.cancel")}
        confirmLabel={t("settings.computerUse.revokeConfirm")}
        confirmVariant="danger"
        onCancel={() => setPendingRevoke(null)}
        onConfirm={() => void confirmRevokeApproval()}
      />
    </div>
  );
}
