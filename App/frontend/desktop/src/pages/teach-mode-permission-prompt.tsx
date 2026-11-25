import { useCallback, useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import type { MemmyAgentClient } from "../api/memmy-agent-client.js";
import type { ComputerHistoryPermission, ComputerHistoryPermissions } from "../api/computer-history-contract.js";
import { useTranslation } from "../i18n/use-translation.js";
import { Button } from "../components/button.js";
import "./teach-mode-permission-prompt.css";

const permissions: ComputerHistoryPermission[] = ["accessibility", "inputMonitoring"];

/**
 * The recording prompt shown before Teach Mode starts desktop capture.
 *
 * It follows the Computer History permission guide: one native guide per
 * missing grant, a status refresh when the guide closes or the window regains
 * focus, and a Quit & Reopen action once the grants are set. Unlike Computer
 * History it does not persist an intent: after a restart the user asks to
 * start again in the conversation.
 */
export function TeachModePermissionPrompt(props: {
  client: MemmyAgentClient;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ComputerHistoryPermissions | null>(null);
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
      const next = await props.client.checkComputerHistoryPermissions();
      if (mounted.current) { setStatus(next); setError(null); }
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
  const blocked = busy || guiding;
  return <section className="teach-permission-card" role="group"
    aria-label={t(authorized ? "plugins.teachPermission.restartTitle" : "plugins.teachPermission.title")}>
    <div className="teach-permission-card__header">
      <strong>{t(authorized ? "plugins.teachPermission.restartTitle" : "plugins.teachPermission.title")}</strong>
      <button type="button" aria-label={t("common.close")} disabled={blocked}
        onClick={() => { if (!guideActive.current) props.onDismiss(); }}><X size={16} aria-hidden="true" /></button>
    </div>
    <p className="teach-permission-card__description">{t("plugins.teachPermission.description")}</p>
    {status?.supported === false ? <p role="status">{t("computerHistory.permissions.macOnly")}</p> : <div className="teach-permission-card__list">{permissions.map(permission =>
      <div className="teach-permission-card__row" key={permission}>
        <span>{t(permission === "accessibility" ? "plugins.teachPermission.accessibility" : "plugins.teachPermission.inputMonitoring")}</span>
        {!status ? <span role="status">{t("plugins.teachPermission.checking")}</span>
          : status[permission] ? <span className="teach-permission-card__granted" role="status"><Check size={16} aria-hidden="true" />{t("plugins.teachPermission.granted")}</span>
          : permission === "inputMonitoring" && inputMonitoringGuided
            ? <span className="teach-permission-card__granted" role="status">{t("computerHistory.permissions.pendingRestart")}</span>
            : <Button type="button" variant="primary" className="teach-permission-card__open" size="sm" disabled={blocked}
              onClick={() => void openPermission(permission)}>{t("plugins.teachPermission.open")}</Button>}
      </div>)}</div>}
    {authorized ? <p className="teach-permission-card__description" role="status">{t("plugins.teachPermission.restartRequired")}</p> : null}
    {error ? <p role="alert" className="teach-permission-card__error">{t("computerHistory.permissions.checkFailed", { error })}</p> : null}
    <div className="teach-permission-card__footer">
      <Button type="button" variant="ghost" size="sm" disabled={blocked} onClick={() => void check()}>{t("plugins.teachPermission.recheck")}</Button>
      <Button type="button" variant="ghost" size="sm" disabled={blocked} onClick={props.onDismiss}>{t("plugins.teachPermission.later")}</Button>
      {authorized ? <Button type="button" variant="primary" size="sm"
        disabled={blocked || !window.memmy?.restartForComputerHistoryPermissions} onClick={() => void restart()}>
        {t("computerHistory.permissions.restart")}</Button> : null}
    </div>
  </section>;
}
