import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, X } from "lucide-react";
import type { MemmyAgentClient } from "../../api/memmy-agent-client.js";
import type { ComputerHistoryPermission, ComputerHistoryPermissions } from "../../api/computer-history-contract.js";
import { useTranslation } from "../../i18n/use-translation.js";
import { Button } from "../../components/button.js";
import { Modal } from "../../components/modal.js";
import { readHistoryPermissionIntent, saveHistoryPermissionSetup } from "./computer-history-permission-state.js";

const permissions: ComputerHistoryPermission[] = ["accessibility", "inputMonitoring"];

export function ComputerHistoryPermissionGuide(props: {
  client: MemmyAgentClient;
  onStart: () => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ComputerHistoryPermissions | null>(null);
  const [busy, setBusy] = useState(false);
  const [guiding, setGuiding] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(false);
  const guideActive = useRef(false);
  const mounted = useRef(true);
  const requestVersion = useRef(0);
  const autoStartAttempted = useRef(false);
  const onStart = useRef(props.onStart);
  onStart.current = props.onStart;

  const check = useCallback(async (retry = false) => {
    if (active.current) return;
    active.current = true;
    const version = ++requestVersion.current;
    setBusy(true);
    if (retry || !autoStartAttempted.current) setError(null);
    try {
      const [next, sessionId] = await Promise.all([
        props.client.checkComputerHistoryPermissions(),
        window.memmy?.getComputerHistoryPermissionSessionId?.() ?? Promise.resolve(null),
      ]);
      if (!mounted.current || version !== requestVersion.current) return;
      setStatus(next);
      const intent = readHistoryPermissionIntent();
      const restarted = sessionId && intent?.sessionId && intent.sessionId !== sessionId;
      const ready = next.supported && next.accessibility && next.inputMonitoring;
      if (ready && restarted && (!autoStartAttempted.current || retry)) {
        // A process change resumes the enable action; remounts and reloads do not.
        autoStartAttempted.current = true;
        setStarting(true);
        await onStart.current();
      } else if (sessionId && intent && (!intent.sessionId || !ready)) {
        // If permission is still missing after a restart, finish setup in this process.
        saveHistoryPermissionSetup(intent.action, sessionId);
      }
    } catch (cause) {
      if (mounted.current && version === requestVersion.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (version === requestVersion.current) {
        active.current = false;
        if (mounted.current) { setBusy(false); setStarting(false); }
      }
    }
  }, [props.client]);

  const openPermission = async (permission: ComputerHistoryPermission) => {
    if (active.current || guideActive.current) return;
    guideActive.current = true;
    setGuiding(true);
    setError(null);
    let failed = false;
    try {
      // The request must come from the process that installs the History tap.
      try { await props.client.openComputerHistoryPermission(permission, "request"); } catch { /* Settings remains available. */ }
      if (!mounted.current) return;
      // Keep status reads independent: this panel may stay open in Settings
      // while a focus event needs to refresh the newly granted permissions.
      await window.memmy?.guideMemmyPermission?.(permission);
    } catch (cause) {
      failed = true;
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      guideActive.current = false;
      if (mounted.current) { setGuiding(false); if (!failed) void check(); }
    }
  };

  useEffect(() => {
    mounted.current = true;
    void check();
    const focus = () => { if (document.visibilityState !== "hidden") void check(); };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      mounted.current = false;
      ++requestVersion.current;
      active.current = false;
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [check]);

  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const restart = async () => {
    if (active.current || guideActive.current) return;
    active.current = true;
    setError(null);
    setBusy(true);
    try {
      // Check again: a permission may have been revoked since the dialog refreshed.
      const next = await props.client.checkComputerHistoryPermissions();
      if (!mounted.current) return;
      setStatus(next);
      if (next.supported && next.accessibility && next.inputMonitoring) {
        await window.memmy?.restartForComputerHistoryPermissions?.();
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { active.current = false; if (mounted.current) setBusy(false); }
  };

  const ready = status?.supported && status.accessibility && status.inputMonitoring;
  const blocked = busy || guiding;
  return createPortal(<div className="ch-recording-confirmation"><Modal
    open
    title={t("computerHistory.permissions.title")}
    className="confirm-dialog confirm-dialog--titled ch__permission-dialog"
    bodyClassName="confirm-dialog__body"
    footerClassName="confirm-dialog__footer"
    style={{ width: 440, maxWidth: "calc(100vw - 32px)" }}
    closeLabel={t("common.close")}
    closeContent={<X size={16} aria-hidden="true" />}
    closeDisabled={blocked}
    onClose={() => { if (!active.current && !guideActive.current) props.onCancel(); }}
    footer={<>
      <Button type="button" variant="ghost" size="sm" disabled={blocked} onClick={props.onCancel}>{t("dialog.cancel")}</Button>
      {ready && !starting ? <Button type="button" variant="primary" size="sm" disabled={blocked || !window.memmy?.restartForComputerHistoryPermissions} onClick={() => void restart()}>
        {t("computerHistory.permissions.restart")}
      </Button> : null}
    </>}
  >
    <div className="confirm-dialog__message confirm-dialog__message--no-icon">
    <p className="ch__permission-description">{t("computerHistory.permissions.description")}</p>
    {status?.supported === false ? <p role="status">{t("computerHistory.permissions.macOnly")}</p> : <div className="ch__permission-list">{permissions.map((permission) =>
      <div className="ch__permission-row" key={permission}>
        <span>{t(permission === "accessibility" ? "computerHistory.permissions.accessibility" : "computerHistory.permissions.inputMonitoring")}</span>
        {!status ? <span role="status">{t("computerHistory.permissions.checking")}</span>
          : status[permission] ? <span className="ch__permission-granted" role="status"><Check size={16} aria-hidden="true" />{t("computerHistory.permissions.granted")}</span>
          : <Button type="button" variant="primary" className="ch__permission-open" size="sm" disabled={blocked} onClick={() => void openPermission(permission)}>{t("computerHistory.permissions.open")}</Button>}
      </div>,
    )}</div>}
    {ready ? <p className="ch__permission-description" role="status">{t(starting ? "computerHistory.permissions.starting" : "computerHistory.permissions.ready")}</p> : null}
    {error ? <div role="alert"><p className="ch__error">{t("computerHistory.permissions.checkFailed", { error })}</p>
      <Button type="button" variant="ghost" disabled={blocked} onClick={() => void check(true)}>{t("computerHistory.permissions.retry")}</Button>
    </div> : null}
    </div>
  </Modal></div>, document.body);
}
