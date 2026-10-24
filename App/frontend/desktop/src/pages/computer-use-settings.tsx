import { useEffect, useRef, useState } from "react";
import { AppWindow, X } from "lucide-react";
import type { ExcelControlStatus, MemmyAgentClient, NativeAppApproval } from "../api/memmy-agent-client.js";
import type { MessageKey } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import styles from "./computer-use-settings.module.css";
import { BrowserExtensionSetup } from "./browser-extension-setup.js";
import { BROWSER_EXTENSION_SECTION_ID, EXCEL_CONNECTION_SECTION_ID, scrollSettingsSectionIntoView } from "./settings-nav.js";
import { openExternalUrl } from "../utils/open-url.js";
import computerUseIcon from "../assets/computer-use-plugin-icon.png";
import excelIcon from "../assets/microsoft-excel.png";

type ComputerUseStatus = { enabled: boolean; available: boolean; binaryAvailable: boolean; restartRequired?: boolean };

function excelAutomationFailure(detail: string): "required" | "denied" | null {
  // Older agents described -1744 as denied even though it means consent is still needed.
  if (/-1744\b/.test(detail) || /automation permission required/i.test(detail)) return "required";
  if (/-1743\b/.test(detail) || /automation(?: permission)? denied/i.test(detail)) return "denied";
  return null;
}

/** Fixed status and authorization messages from the native Excel connection on either platform. */
const EXCEL_FAILURE_MESSAGES: ReadonlyArray<readonly [RegExp, MessageKey]> = [
  [/\bExcel is busy\b/i, "settings.computerUse.excelBusy"],
  [/unlocked interactive Windows desktop|macOS is locked|unlocked macOS login session could not be verified/i, "settings.computerUse.excelDesktopLocked"],
  [/Multiple Excel application instances/i, "settings.computerUse.excelMultipleInstances"],
  [/running Excel application is not available for control/i, "settings.computerUse.excelNotAvailable"],
  [/Excel application instance changed/i, "settings.computerUse.excelInstanceChanged"],
  [/Microsoft Excel is not installed/i, "settings.computerUse.excelUnavailable"],
  [/Microsoft Excel did not start/i, "settings.computerUse.excelDidNotStart"],
  [/Excel operation timed out/i, "settings.computerUse.excelTimedOut"],
  [/Excel connection settings could not be read/i, "settings.computerUse.excelSettingsUnreadable"],
  [/Excel Automation permission could not be verified/i, "settings.computerUse.excelAutomationUnknown"],
  [/permission was denied/i, "settings.computerUse.excelPermissionCheck"],
  [/Excel returned an? (?:invalid|inconsistent)|Excel response is too large/i, "settings.computerUse.excelUnexpectedResponse"],
];
const WINDOWS_EXCEL_ATTACH_UNAVAILABLE = /running Excel application is not available for control/i;

export function ComputerUseSettings(props: { client?: MemmyAgentClient; platform?: string; browserExtensionFocusNonce?: number; excelConnectionFocusNonce?: number }) {
  const { t } = useTranslation();
  const browserExtensionSection = useRef<HTMLDivElement>(null);
  const excelConnectionSection = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<ComputerUseStatus | null>(null);
  const [excelStatus, setExcelStatus] = useState<ExcelControlStatus | null>(null);
  const [excelBusy, setExcelBusy] = useState(false);
  const [excelError, setExcelError] = useState<Error | null>(null);
  const [excelStatusError, setExcelStatusError] = useState(false);
  const [excelStatusFailures, setExcelStatusFailures] = useState(0);
  const [excelRetryEnabled, setExcelRetryEnabled] = useState(true);
  const [excelPermissionDismissed, setExcelPermissionDismissed] = useState(false);
  const [awaitingExcelPermission, setAwaitingExcelPermission] = useState(false);
  const [approvals, setApprovals] = useState<NativeAppApproval[]>([]);
  const [revokeBusy, setRevokeBusy] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<NativeAppApproval | null>(null);
  const [approvalError, setApprovalError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [allowAll, setAllowAll] = useState(false);
  const [allowAllReady, setAllowAllReady] = useState(false);
  const [allowAllBusy, setAllowAllBusy] = useState(false);
  const allowAllEpoch = useRef(0);
  const allowAllWriting = useRef(false);
  const approvalEpoch = useRef(0);
  const excelEpoch = useRef(0);
  const failedExcelAction = useRef<boolean | null>(null);

  useEffect(() => {
    const section = browserExtensionSection.current;
    const flashClass = styles.extensionFocus;
    if (!props.browserExtensionFocusNonce || !section || !flashClass) return undefined;
    section.classList.add(flashClass);
    const frame = window.requestAnimationFrame(() => scrollSettingsSectionIntoView(section));
    const timer = window.setTimeout(() => section.classList.remove(flashClass), 1600);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      section.classList.remove(flashClass);
    };
  }, [props.browserExtensionFocusNonce]);

  useEffect(() => {
    const section = excelConnectionSection.current;
    const flashClass = styles.extensionFocus;
    if (!props.excelConnectionFocusNonce || !section || !flashClass) return undefined;
    section.classList.add(flashClass);
    const frame = window.requestAnimationFrame(() => scrollSettingsSectionIntoView(section));
    const timer = window.setTimeout(() => section.classList.remove(flashClass), 1600);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      section.classList.remove(flashClass);
    };
  }, [props.excelConnectionFocusNonce]);

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
    const apply = (value: boolean) => {
      if (!live) return;
      allowAllEpoch.current++;
      setAllowAll(value); setAllowAllReady(true);
    };
    const unsubscribe = window.memmy?.onBrowserAllowAllChanged?.(state => apply(state.inherited));
    const load = () => {
      if (allowAllWriting.current) return;
      const read = window.memmy?.getBrowserAllowAll
        ? () => window.memmy!.getBrowserAllowAll!().then(state => state.inherited)
        : window.memmy?.getNativeAppAllowAll;
      if (!read) { setAllowAllReady(true); return; }
      const epoch = ++allowAllEpoch.current;
      void read().then(value => {
        if (live && epoch === allowAllEpoch.current) apply(value);
      }).catch(() => {
        if (live && epoch === allowAllEpoch.current) { setError(true); setAllowAllReady(true); }
      });
    };
    load();
    window.addEventListener('focus', load);
    return () => { live = false; allowAllEpoch.current++; unsubscribe?.(); window.removeEventListener('focus', load); };
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
      if (excelEpoch.current % 2 !== 0) return;
      const seen = excelEpoch.current;
      void props.client!.getExcelAddinStatus().then(value => {
        if (live && seen === excelEpoch.current) {
          setExcelStatus(value);
          setExcelStatusError(false);
          setExcelStatusFailures(count => value.error ? Math.min(count + 1, 3) : 0);
          if (!value.error && failedExcelAction.current !== null
            && (value.enabled ?? value.configured) === failedExcelAction.current) {
            failedExcelAction.current = null;
            setExcelError(null);
          }
        }
      }).catch(() => {
        if (live && seen === excelEpoch.current) {
          setExcelStatusError(true);
          setExcelStatusFailures(count => Math.min(count + 1, 3));
        }
      });
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => { live = false; clearInterval(timer); };
  }, [props.client]);

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
    if (!window.memmy?.setNativeAppAllowAll || allowAllWriting.current) return;
    const epoch = ++allowAllEpoch.current;
    allowAllWriting.current = true;
    setAllowAllBusy(true);
    setError(false);
    try {
      const value = await window.memmy.setNativeAppAllowAll(enabled);
      if (epoch === allowAllEpoch.current) setAllowAll(value);
    } catch {
      if (epoch === allowAllEpoch.current) setError(true);
    } finally {
      allowAllWriting.current = false;
      setAllowAllBusy(false);
    }
  }

  const excelApplicationScope = excelStatus?.scope === "application";
  const excelLegacyScope = excelStatus !== null && !excelApplicationScope;
  const excelEnabled = excelApplicationScope ? excelStatus.enabled ?? excelStatus.configured : excelStatus?.configured === true;
  const excelInitialChecking = props.platform === "win32" && excelStatus === null;
  const excelFailureDetail = excelError?.message ?? (excelStatusError ? "" : excelStatus?.error ?? "");
  const excelAutomationError = props.platform === "darwin" && !excelLegacyScope
    ? excelAutomationFailure(excelFailureDetail) : null;
  const excelAttachUnavailable = props.platform === "win32" && WINDOWS_EXCEL_ATTACH_UNAVAILABLE.test(excelFailureDetail);
  const excelAttachChecking = excelAttachUnavailable && excelEnabled && excelStatusFailures < 3;
  const excelHardFailure = excelFailureDetail && !excelAttachUnavailable
    ? describeKnownExcelFailure(excelFailureDetail) : null;
  const excelHasFailure = Boolean(excelError || excelStatusError || excelStatus?.error);
  const excelFailureText = excelAttachUnavailable
    ? t(excelAttachChecking ? "settings.computerUse.excelChecking" : "settings.computerUse.excelStartupUnavailable")
    : excelHardFailure ?? (excelError
    ? t(excelRetryEnabled ? "settings.computerUse.excelConnectIncomplete"
      : "settings.computerUse.excelDisconnectIncomplete")
    : t(excelStatusFailures < 3 ? "settings.computerUse.excelChecking"
      : "settings.computerUse.excelStatusRetry"));
  const excelConnectionHint = excelApplicationScope && excelEnabled && !excelStatus.connected
    ? excelAutomationError ? null
      : excelStatus.permissionRequired ? "settings.computerUse.excelAutomationRequired"
      : excelStatus.available === false ? "settings.computerUse.excelUnavailable"
      : !excelStatus.error && !excelError && !excelStatusError ? "settings.computerUse.excelOpenWorkbook" : null
    : null;
  const excelPermissionOpen = excelLegacyScope && Boolean(excelStatus?.manualInstallPath) && !excelPermissionDismissed;
  const retryExcelInstall = useRef<() => Promise<void>>(async () => undefined);

  useEffect(() => {
    if (!excelStatus?.manualInstallPath) setExcelPermissionDismissed(false);
  }, [excelStatus?.manualInstallPath]);

  useEffect(() => {
    if (!awaitingExcelPermission || excelApplicationScope) return;
    const retry = () => { void retryExcelInstall.current(); };
    window.addEventListener("focus", retry);
    return () => window.removeEventListener("focus", retry);
  }, [awaitingExcelPermission, excelApplicationScope]);

  function describeExcelFailure(error: unknown): string {
    const fallback = t(excelLegacyScope ? "settings.computerUse.excelSetupError" : "settings.computerUse.excelControlError");
    const detail = error instanceof Error ? error.message.trim().replace(/^Excel (?:add-in setup|control|native control) failed:\s*/i, "") : "";
    return describeKnownExcelFailure(detail) ?? (detail ? `${fallback}：${detail}` : fallback);
  }

  function describeKnownExcelFailure(detail: string): string | null {
    if (excelLegacyScope) return null;
    const automation = props.platform === "darwin" ? excelAutomationFailure(detail) : null;
    if (automation) return t(automation === "required" ? "settings.computerUse.excelAutomationRequired"
      : "settings.computerUse.excelAutomationDenied");
    const known = EXCEL_FAILURE_MESSAGES.find(([pattern]) => pattern.test(detail));
    return known ? t(known[1]) : null;
  }

  async function enableExcel() {
    if ((!props.client?.setExcelAddinEnabled && !props.client?.enableExcelAddin) || excelBusy) return;
    setExcelBusy(true);
    setExcelError(null);
    setExcelRetryEnabled(true);
    failedExcelAction.current = null;
    excelEpoch.current += 1;
    try {
      const next = await (props.client.setExcelAddinEnabled
        ? props.client.setExcelAddinEnabled(true)
        : props.client.enableExcelAddin!());
      setExcelStatus(next);
      setExcelStatusError(false);
      setExcelStatusFailures(0);
      if (next.scope === "application" || !next.manualInstallPath) setAwaitingExcelPermission(false);
      if (props.platform === "win32" && next.scope === "application") {
        // A successful authorization can precede Excel's registration for the next process.
        // Confirm with a fresh probe before presenting it as connected.
        try {
          const verified = await props.client.getExcelAddinStatus();
          setExcelStatus(verified);
          setExcelStatusFailures(verified.error ? 1 : 0);
        } catch {
          setExcelStatusError(true);
          setExcelStatusFailures(1);
        }
      }
    } catch (error) {
      failedExcelAction.current = true;
      setExcelError(error instanceof Error ? error : new Error());
    } finally {
      excelEpoch.current += 1;
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
    setExcelRetryEnabled(false);
    failedExcelAction.current = null;
    excelEpoch.current += 1;
    try {
      setExcelStatus(await props.client.setExcelAddinEnabled(false));
      setExcelStatusError(false);
      setExcelStatusFailures(0);
    } catch (error) {
      failedExcelAction.current = false;
      setExcelError(error instanceof Error ? error : new Error());
    } finally {
      excelEpoch.current += 1;
      setExcelBusy(false);
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
        <div id={BROWSER_EXTENSION_SECTION_ID} ref={browserExtensionSection}>
        <BrowserExtensionSetup client={props.client} platform={props.platform} />
        </div>
        <div id={EXCEL_CONNECTION_SECTION_ID} ref={excelConnectionSection} className={`${styles.row} ${styles.separated}`}>
          <span className={styles.icon}><img src={excelIcon} alt="" aria-hidden="true" /></span>
          <span className={styles.copy}>
            <strong>Microsoft Excel</strong>
            <small>{t(excelLegacyScope ? "settings.computerUse.excelDescription" : "settings.computerUse.excelApplicationDescription")}</small>
            {excelBusy && <small>{t(excelLegacyScope ? "settings.computerUse.excelPreparing"
              : excelRetryEnabled ? "settings.computerUse.excelConnecting" : "settings.computerUse.excelDisconnecting")}</small>}
            {excelInitialChecking && !excelHasFailure && <small>{t("settings.computerUse.excelChecking")}</small>}
            {excelEnabled && excelStatus?.connected && (props.platform !== "win32" || !excelBusy) && !excelStatusError && !excelStatus.error
              && <small>{t("settings.computerUse.excelConnected")}</small>}
            {excelConnectionHint && !excelBusy && <small>{t(excelConnectionHint)}</small>}
            {!excelLegacyScope && excelHasFailure && !excelBusy && <small role={excelHardFailure ? "alert" : undefined}
              className={excelHardFailure ? styles.error : undefined}>{excelFailureText}</small>}
            {excelLegacyScope && excelStatusError && <small role="alert" className={styles.error}>{t("settings.computerUse.excelStatusError")}</small>}
            {excelLegacyScope && excelError && <small role="alert" className={styles.error}>{describeExcelFailure(excelError)}</small>}
            {excelAutomationError === "denied" && <button type="button" className={styles.setupButton} disabled={excelBusy}
              onClick={() => void openExternalUrl("x-apple.systempreferences:com.apple.preference.security?Privacy_Automation")}>
              {t("settings.computerUse.excelOpenAutomation")}</button>}
            {((excelError && !excelAttachChecking) || (!excelLegacyScope && excelStatusFailures >= 3) || (excelApplicationScope
              && (excelStatus.permissionRequired || excelHardFailure))) &&
              <button type="button" className={styles.setupButton} disabled={excelBusy}
                onClick={() => void setExcelEnabled(excelError ? excelRetryEnabled : true)}>{t("settings.computerUse.excelControlRetry")}</button>}
          </span>
          <input type="checkbox" role="switch" aria-label="Microsoft Excel"
            checked={excelEnabled} disabled={excelBusy || excelInitialChecking || !props.client}
            onChange={event => void setExcelEnabled(event.target.checked)} className={styles.switch} />
        </div>
        {excelLegacyScope && excelStatus?.manualInstallPath && excelPermissionDismissed && <div className={styles.guide}>
          <button type="button" onClick={() => setExcelPermissionDismissed(false)}>{t("settings.computerUse.excelPermissionTitle")}</button>
        </div>}
        {excelLegacyScope && excelStatus?.configured && !excelStatus.connected && excelStatus.connectionCount === 0 && !excelStatus.manualInstallPath
          && <div className={styles.guide}>
            <strong>{t("settings.computerUse.excelOpenTitle")}</strong>
            <ol>
              <li>{t("settings.computerUse.excelOpenHint")}</li>
              <li>{t("settings.computerUse.excelOpenKeep")}</li>
            </ol>
          </div>}
      </div>

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
