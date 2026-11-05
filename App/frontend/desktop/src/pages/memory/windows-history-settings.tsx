import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Modal } from "../../components/modal.js";
import { Button } from "../../components/button.js";
import type { MemmyAgentClient } from "../../api/memmy-agent-client.js";
import type { WindowsHistoryConfiguration } from "../../api/computer-history-contract.js";
import { useTranslation } from "../../i18n/use-translation.js";

export function WindowsHistorySettings(props: { client: MemmyAgentClient; onClose: () => void;
  onSaved: (configuration: WindowsHistoryConfiguration) => void; onStart?: () => Promise<void> }) {
  const { t } = useTranslation();
  const [configuration, setConfiguration] = useState<WindowsHistoryConfiguration | null>(null);
  const [selected, setSelected] = useState(new Set<string>());
  const [query, setQuery] = useState("");
  const [behavior, setBehavior] = useState<"observe" | "do_not_observe">("observe");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  const refresh = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const next = await props.client.getWindowsHistoryConfiguration();
      if (!active.current) return;
      setConfiguration(next); setBehavior(next.settings.defaultApplicationBehavior ?? "do_not_observe");
      setSelected(new Set(next.applications.filter((app) => app.allowed).map((app) => app.id)));
    } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (active.current) setBusy(false); }
  }, [props.client]);
  useEffect(() => { active.current = true; void refresh(); return () => { active.current = false; }; }, [refresh]);
  const save = async () => {
    if (!configuration || busy) return;
    setBusy(true); setError(null);
    try {
      const applications = behavior === "observe" ? configuration.settings.applications
        : configuration.applications.filter((app) => selected.has(app.id)).map((app) => app.rule ?? { executable: app.executable });
      const excluded = configuration.applications.filter((app) => app.supported && !selected.has(app.id)).map((app) => app.executable);
      const next = await props.client.updateWindowsHistorySettings({ ...configuration.settings, applications,
        ...(behavior === "observe" ? { defaultApplicationBehavior: behavior, deny: { executables: excluded } }
          : { ...(configuration.settings.defaultApplicationBehavior ? { defaultApplicationBehavior: behavior } : {}),
            ...(configuration.settings.deny ? { deny: { executables: configuration.settings.deny.executables?.filter((exe) =>
              !configuration.applications.some((app) => selected.has(app.id) && app.executable.toLowerCase() === exe.toLowerCase())) } } : {}) }) });
      if (!active.current) return;
      props.onSaved(next);
      if (props.onStart) {
        if (!next.permissions.ready) throw new Error(t(`computerHistory.windows.${next.permissions.reason === "ready" || !next.permissions.reason ? "no_running_authorized_application" : next.permissions.reason}`));
        await props.onStart();
      }
      props.onClose();
    } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (active.current) setBusy(false); }
  };
  const reason = configuration?.permissions.reason;
  const reasonText = reason && reason !== "ready" ? t(`computerHistory.windows.${reason}`) : null;
  const search = query.trim().toLocaleLowerCase();
  const visibleApplications = configuration?.applications.filter((app) =>
    !search || app.name.toLocaleLowerCase().includes(search) || app.executable.toLocaleLowerCase().includes(search)) ?? [];
  return createPortal(<Modal open title={t("computerHistory.windows.title")} closeLabel={t("common.close")} onClose={() => { if (!busy) props.onClose(); }}
    closeDisabled={busy} className="confirm-dialog confirm-dialog--titled ch__permission-dialog ch__windows-settings"
    bodyClassName="confirm-dialog__body ch__windows-settings-body" footerClassName="confirm-dialog__footer"
    style={{ width: 520, maxWidth: "calc(100vw - 32px)" }}
    footer={<><Button disabled={busy} onClick={props.onClose}>{t("dialog.cancel")}</Button>
      <Button disabled={busy || !configuration} onClick={() => void refresh()}>{t("computerHistory.windows.refresh")}</Button>
      <Button disabled={busy || !configuration || (!!props.onStart && ((behavior !== "observe" && !selected.size) || reason === "collector_unavailable"))} onClick={() => void save()}>
        {t(props.onStart ? "computerHistory.windows.saveAndStart" : "computerHistory.windows.save")}</Button></>}>
    <p>{t("computerHistory.windows.description")}</p>
    <p>{t("computerHistory.windows.changesStopRecording")}</p>
    <label className="ch__windows-scope">{t("computerHistory.windows.scope")}
      <select aria-label={t("computerHistory.windows.scope")} value={behavior} disabled={busy} onChange={(event) => {
        const next = event.target.value as "observe" | "do_not_observe";
        setBehavior(next);
        setSelected(new Set(configuration?.applications.filter((app) => app.supported && (next === "observe"
          ? !configuration.settings.deny?.executables?.some((exe) => exe.toLowerCase() === app.executable.toLowerCase())
          : !!app.rule && app.allowed)).map((app) => app.id)));
      }}>
        <option value="observe">{t("computerHistory.windows.allApplications")}</option>
        <option value="do_not_observe">{t("computerHistory.windows.selectedApplications")}</option>
      </select>
    </label>
    {reasonText ? <p role="status">{reasonText}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <input type="search" aria-label={t("computerHistory.windows.search")} placeholder={t("computerHistory.windows.search")}
      value={query} disabled={busy} onChange={(event) => setQuery(event.target.value)} />
    <div className="ch__windows-applications">
      {visibleApplications.map((app) => <label key={app.id} className="ch__windows-application">
        <input type="checkbox" checked={selected.has(app.id)} disabled={busy || (!app.supported && !selected.has(app.id)) || (behavior !== "observe" && !selected.has(app.id) && selected.size >= 32)} onChange={(event) => {
          setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(app.id); else next.delete(app.id); return next; });
        }} />
        <span><strong>{app.name}</strong><span className="ch__windows-application-state">{t(!app.supported ? "computerHistory.windows.browserUnsupported" : app.running ? "computerHistory.windows.running" : "computerHistory.windows.closed")}</span>
          <span className="ch__windows-application-path">{app.executable}</span></span>
      </label>)}
      {configuration && !configuration.applications.length ? <p>{t("computerHistory.windows.empty")}</p> : null}
      {configuration && !!configuration.applications.length && !visibleApplications.length ? <p>{t("computerHistory.windows.noMatches")}</p> : null}
    </div>
  </Modal>, document.body);
}
