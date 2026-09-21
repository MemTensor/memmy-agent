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
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(false);
  const mounted = useRef(true);
  const requestVersion = useRef(0);
  const autoStartAttempted = useRef(false);
  const onStart = useRef(props.onStart);
  onStart.current = props.onStart;

  const check = useCallback(async (open?: ComputerHistoryPermission, retry = false) => {
    if (active.current) return;
    active.current = true;
    const version = ++requestVersion.current;
    setBusy(true);
    if (open || retry || !autoStartAttempted.current) setError(null);
    try {
      const [next, sessionId] = await Promise.all([
        open ? props.client.openComputerHistoryPermission(open, "settings") : props.client.checkComputerHistoryPermissions(),
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
    if (active.current) return;
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
  return createPortal(<div className="ch-recording-confirmation"><Modal
    open
    title={t("computerHistory.permissions.title")}
    className="confirm-dialog confirm-dialog--titled ch__permission-dialog"
    bodyClassName="confirm-dialog__body"
    footerClassName="confirm-dialog__footer"
    style={{ width: 440, maxWidth: "calc(100vw - 32px)" }}
    closeLabel={t("common.close")}
    closeContent={<X size={16} aria-hidden="true" />}
    closeDisabled={busy}
    onClose={() => { if (!active.current) props.onCancel(); }}
    footer={<>
      <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={props.onCancel}>{t("dialog.cancel")}</Button>
      {ready && !starting ? <Button type="button" variant="primary" size="sm" disabled={busy || !window.memmy?.restartForComputerHistoryPermissions} onClick={() => void restart()}>
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
          : <Button type="button" variant="primary" className="ch__permission-open" size="sm" disabled={busy} onClick={() => void check(permission)}>{t("computerHistory.permissions.open")}</Button>}
      </div>,
    )}</div>}
    {ready ? <p className="ch__permission-description" role="status">{t(starting ? "computerHistory.permissions.starting" : "computerHistory.permissions.ready")}</p> : null}
    {error ? <div role="alert"><p className="ch__error">{t("computerHistory.permissions.checkFailed", { error })}</p>
      <Button type="button" variant="ghost" disabled={busy} onClick={() => void check(undefined, true)}>{t("computerHistory.permissions.retry")}</Button>
    </div> : null}
    </div>
  </Modal></div>, document.body);
}
