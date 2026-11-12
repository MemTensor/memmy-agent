import { useCallback, useEffect, useRef, useState } from "react";
import { Video } from "lucide-react";
import { recordingEventVideoTime, recordingSourceTime, type RecordingEvent, type RecordingExportResult, type RecordingSession, type RecordingStart, type RecordingConfiguration, type RecordingPermission } from "@memmy/local-api-contracts";
import type { MemmyAgentClient, MemmyAgentWebSocketConnection } from "../../api/memmy-agent-client.js";
import type { ComputerRecordingsClient } from "../../api/computer-recordings-client.js";
import { useTranslation } from "../../i18n/use-translation.js";
import { Button } from "../../components/button.js";
import { Modal } from "../../components/modal.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import "./task-recordings.css";

const active = (session: RecordingSession) => !["ready", "failed"].includes(session.state);
const recordingDesktop = () => typeof window !== "undefined" && (window.memmy?.platform === "win32" || window.memmy?.platform === "darwin");
const duration = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
function useRecordingList(client: ComputerRecordingsClient | undefined, chatId?: string) {
  const [sessions, setSessions] = useState<RecordingSession[]>([]);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    if (!client || !recordingDesktop()) return;
    try { const result = await client.list(chatId); if (generation.current === request) { setSessions(result.recordings); setError(false); } }
    catch { if (generation.current === request) setError(true); }
  }, [client, chatId]);
  useEffect(() => {
    if (!client || !recordingDesktop()) return;
    setSessions([]); void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => { generation.current++; clearInterval(timer); };
  }, [refresh]);
  return { sessions, error, refresh };
}
export function RecordingConsentDialog(props: { client: MemmyAgentClient; open: boolean; agent?: boolean;
  onConfirm(input: RecordingStart): void; onCancel(): void }) {
  const { t } = useTranslation();
  const [applications, setApplications] = useState<{ executable: string; name: string }[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [consent, setConsent] = useState(false);
  const [title, setTitle] = useState("");
  const [skipIdle, setSkipIdle] = useState(true);
  const [error, setError] = useState(false);
  const [macConfiguration, setMacConfiguration] = useState<RecordingConfiguration | null>(null);
  const [checking, setChecking] = useState(false);
  const mac = typeof window !== "undefined" && window.memmy?.platform === "darwin";
  const applyMacConfiguration = useCallback((configuration: RecordingConfiguration) => {
    setMacConfiguration(configuration);
    const applications = configuration.applications.filter((app) => app.running && app.supported && app.allowed)
      .map((app) => ({ executable: app.id, name: app.name }));
    setApplications(applications); setSelected((current) => current.filter((id) => applications.some((app) => app.executable === id)));
  }, []);
  useEffect(() => {
    if (!props.open) return;
    let cancelled = false;
    setSelected([]); setConsent(false); setSkipIdle(true); setError(false); setApplications([]); setMacConfiguration(null); setTitle(t(props.agent ? "recordings.agentTitle" : "recordings.title"));
    const load = async () => {
      setChecking(true);
      try {
        if (mac && props.client.recordings) {
          const config = await props.client.recordings.configuration(); if (!cancelled) applyMacConfiguration(config);
        } else {
          const config = await props.client.getWindowsHistoryConfiguration();
          if (!cancelled) setApplications(config.applications.filter((app) => app.running && app.supported && app.allowed
            && !["mstsc.exe", "msrdc.exe", "wfica32.exe", "cdviewer.exe"].includes(app.executable.split(/[\\/]/u).at(-1)!.toLowerCase())));
        }
      } catch { if (!cancelled) setError(true); }
      finally { if (!cancelled) setChecking(false); }
    };
    void load();
    if (mac) window.addEventListener("focus", load);
    return () => { cancelled = true; window.removeEventListener("focus", load); };
  }, [props.open, props.client, props.agent, t, mac, applyMacConfiguration]);
  const permissionsReady = !mac || !!(macConfiguration?.supported && macConfiguration.permissions && Object.values(macConfiguration.permissions).every(Boolean));
  const openPermission = async (permission: RecordingPermission, mode: "request" | "settings") => {
    if (!props.client.recordings) return;
    setChecking(true); setError(false);
    try { applyMacConfiguration(await props.client.recordings.openPermission(permission, mode)); }
    catch { setError(true); } finally { setChecking(false); }
  };
  return <Modal open={props.open} title={t("recordings.consentTitle")} onClose={props.onCancel} closeLabel={t("common.close")}
    footer={<><Button variant="ghost" onClick={props.onCancel}>{t("dialog.cancel")}</Button>
      <Button disabled={checking || !permissionsReady || !consent || !selected.length || !title.trim()} onClick={() => props.onConfirm({ title: title.trim(), applications: selected, consent: true, ...(!mac ? { skipIdle } : {}) })}>
        {t(props.agent ? "recordings.confirm" : "recordings.start")}</Button></>}>
    <div className="task-recordings__consent">
      <p>{t("recordings.privacy")}</p><p>{t("recordings.limits")}</p>
      {mac && <fieldset><legend>{t("recordings.macPermissions")}</legend><p>{t("recordings.macPermissionHint")}</p>
        {macConfiguration && !macConfiguration.supported && <p role="alert">{t("recordings.macVersion")}</p>}
        {(["screenRecording", "accessibility", "inputMonitoring"] as const).map((permission) => <div key={permission} className="task-recordings__permission">
          <span>{t(`recordings.permission.${permission}`)}</span>
          {macConfiguration?.permissions?.[permission] ? <span>{t("recordings.permissionGranted")}</span> : <>
            <Button size="sm" disabled={checking || !macConfiguration?.supported} onClick={() => void openPermission(permission, "request")}>{t("recordings.grantPermission")}</Button>
            <Button size="sm" variant="ghost" disabled={checking || !macConfiguration?.supported} onClick={() => void openPermission(permission, "settings")}>{t("recordings.openSettings")}</Button></>}
        </div>)}
      </fieldset>}
      <label>{t("recordings.titleLabel")}<input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} /></label>
      {!mac && <label><input type="checkbox" checked={skipIdle} onChange={(event) => setSkipIdle(event.target.checked)} />{t("recordings.skipIdle")}</label>}
      <fieldset><legend>{t("recordings.scope")}</legend><p className="task-recordings__hint">{t("recordings.scopeHint")}</p>
        {applications.map((app) => <label key={app.executable}><input type="checkbox" checked={selected.includes(app.executable)}
          onChange={(event) => setSelected((current) => event.target.checked ? [...current, app.executable] : current.filter((item) => item !== app.executable))} />{app.name}</label>)}
      </fieldset>
      <label><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />{t("recordings.consent")}</label>
      {error && <p role="alert">{t("recordings.error")}</p>}
    </div>
  </Modal>;
}
export function AgentTaskRecordingOption(props: { client: MemmyAgentClient | null; value: RecordingStart | null; disabled?: boolean; onChange(value: RecordingStart | null): void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!recordingDesktop() || !props.client?.recordings) return null;
  return <><button type="button" role="checkbox" aria-checked={!!props.value} className={`task-recordings__agent-option${props.value ? " is-selected" : ""}`}
    disabled={props.disabled} onClick={() => props.value ? props.onChange(null) : setOpen(true)}><Video size={14} />{t("recordings.agentOption")}</button>
    <RecordingConsentDialog client={props.client} agent open={open} onCancel={() => setOpen(false)}
      onConfirm={(input) => { props.onChange(input); setOpen(false); }} /></>;
}
export function ActiveRecordingBar(props: { client: MemmyAgentClient | null }) {
  const { t } = useTranslation();
  const api = props.client?.recordings;
  const { sessions, refresh } = useRecordingList(api);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const session = sessions.find(active);
  if (!session || !api || !recordingDesktop()) return null;
  const control = async (action: "pause" | "resume" | "stop") => {
    setBusy(true); setError(false);
    try { await api.control(session.id, action); } catch { setError(true); } finally { setBusy(false); void refresh(); }
  };
  return <aside className="task-recordings__active" role="status" aria-live="polite">
    <span className="task-recordings__dot" /> <strong>{session.title}</strong><span>{t(session.idlePaused && session.state === "recording" ? "recordings.state.idle" : `recordings.state.${session.state}`)} · {duration(session.recordedDurationMs ?? session.durationMs)}</span>
    {(session.state === "recording" || session.state === "paused") && <>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void control(session.state === "paused" ? "resume" : "pause")}>{t(session.state === "paused" ? "recordings.resume" : "recordings.pause")}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void control("stop")}>{t("recordings.stop")}</Button></>}
    <small>{t(window.memmy?.platform === "darwin" ? "recordings.stopHintMac" : "recordings.stopHint")}</small>{error && <span role="alert">{t("recordings.error")}</span>}
  </aside>;
}
export function TaskRecordingsPanel(props: { client: MemmyAgentClient | null; chatId?: string; connection?: MemmyAgentWebSocketConnection | null; human?: boolean }) {
  const { t } = useTranslation();
  const api = props.client?.recordings;
  const { sessions, error: fetchError, refresh } = useRecordingList(api, props.chatId);
  const [confirm, setConfirm] = useState(false);
  const [selected, setSelected] = useState<RecordingSession | null>(null);
  const [deleting, setDeleting] = useState<RecordingSession | null>(null);
  const [clearing, setClearing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [agentFailed, setAgentFailed] = useState(false);
  useEffect(() => {
    setAgentFailed(false);
    if (!props.chatId || !props.connection) return;
    return props.connection.onChat(props.chatId, (event) => {
      if (event.event === "task_recording") { setAgentFailed(event.recording_state === "failed"); void refresh(); }
    });
  }, [props.chatId, props.connection, refresh]);
  useEffect(() => { if (selected) setSelected(sessions.find((session) => session.id === selected.id) ?? null); }, [sessions]);
  if (!api || !props.client || !recordingDesktop()) return null;
  if (!props.human && !sessions.length && !agentFailed) return null;
  const perform = async (operation: () => Promise<unknown>) => {
    setBusy(true); setError(false);
    try { await operation(); } catch { setError(true); } finally { setBusy(false); void refresh(); }
  };
  return <section className="task-recordings" aria-label={t("recordings.title")}>
    <header><h3><Video size={18} />{t("recordings.title")}</h3>
      {props.human && <div className="task-recordings__actions">
        {sessions.length > 0 && <Button size="sm" variant="ghost" disabled={busy || sessions.some(active)} onClick={() => setClearing(true)}>{t("recordings.clear")}</Button>}
        <Button size="sm" disabled={busy || sessions.some(active)} onClick={() => setConfirm(true)}>{t("recordings.new")}</Button></div>}</header>
    {props.human && <p className="task-recordings__hint">{t("recordings.limits")}</p>}
    {(error || fetchError) && <p role="alert">{t("recordings.error")}</p>}
    {agentFailed && <p role="alert">{t("recordings.agentFailed")}</p>}
    {sessions.map((session) => <article className="task-recordings__item" key={session.id}>
      <div><strong>{session.title}</strong><span>{t(session.idlePaused && session.state === "recording" ? "recordings.state.idle" : `recordings.state.${session.state}`)} · {duration(session.recordedDurationMs ?? session.video?.durationMs ?? session.durationMs)}</span>
        <small>{new Date(session.createdAt).toLocaleString()}</small>
        {!!session.idleSpans?.length && <small>{t("recordings.idleSkipped")} {duration(session.durationMs - (session.video?.durationMs ?? session.durationMs))}</small>}
        {session.videoIntegrity !== "complete" && !active(session) && <small>{t("recordings.incomplete")}</small>}
        {session.timelineCompleteness === "partial" && <small>{t("recordings.timelinePartial")}</small>}
      </div><div className="task-recordings__actions">
        {session.video || session.parts.length ? <Button size="sm" variant="ghost" onClick={() => setSelected(session)}>{t("recordings.view")}</Button> : <span>{t("recordings.noVideo")}</span>}
        <Button size="sm" variant="ghost" disabled={busy} aria-pressed={session.pinned} onClick={() => void perform(() => api.pin(session.id, !session.pinned))}>{t(session.pinned ? "recordings.unkeep" : "recordings.keep")}</Button>
        <Button size="sm" variant="ghost" disabled={busy || active(session)} onClick={() => setDeleting(session)}>{t("recordings.delete")}</Button>
      </div>
    </article>)}
    {props.human && !sessions.length && <p className="task-recordings__hint">{t("recordings.empty")}</p>}
    <RecordingConsentDialog client={props.client} open={confirm} onCancel={() => setConfirm(false)} onConfirm={(input) => { setConfirm(false); void perform(() => api.start(input)); }} />
    {selected && <RecordingPlayer api={api} session={selected} onClose={() => setSelected(null)} />}
    <ConfirmDialog open={!!deleting || clearing} title={t(clearing ? "recordings.clear" : "recordings.delete")} message={t(clearing ? "recordings.clearNotice" : "recordings.deleteNotice")}
      cancelLabel={t("dialog.cancel")} confirmLabel={t(clearing ? "recordings.clear" : "recordings.delete")} onCancel={() => { setDeleting(null); setClearing(false); }} onConfirm={() => {
        const target = deleting; const clear = clearing; setDeleting(null); setClearing(false);
        if (clear) void perform(() => api.clear("all")); else if (target) void perform(() => api.delete(target.id));
      }} />
  </section>;
}
function RecordingPlayer(props: { api: ComputerRecordingsClient; session: RecordingSession; onClose(): void }) {
  const { t } = useTranslation();
  const video = useRef<HTMLVideoElement>(null);
  const pendingSeek = useRef<number | null>(null);
  const [events, setEvents] = useState<RecordingEvent[]>([]);
  const [cursor, setCursor] = useState<number | null>(0);
  const [error, setError] = useState(false);
  const [exportResult, setExportResult] = useState<RecordingExportResult | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [mediaId, setMediaId] = useState(props.session.video ? "recording" : props.session.parts[0]?.mediaId ?? "recording");
  const [time, setTime] = useState(0);
  const partOffset = mediaId === "recording" ? 0 : props.session.parts.find((part) => part.mediaId === mediaId)?.startMs ?? 0;
  const sourceTime = recordingSourceTime(time, props.session.idleSpans);
  const gap = props.session.gaps.find((item) => item.startMs <= sourceTime && item.endMs >= sourceTime);
  const load = useCallback(async (after: number) => {
    try { const page = await props.api.events(props.session.id, after); setEvents((current) => after ? [...current, ...page.events] : page.events); setCursor(page.nextCursor); }
    catch { setError(true); }
  }, [props.api, props.session.id]);
  useEffect(() => { void load(0); }, [load]);
  useEffect(() => {
    if (!exportResult || exportResult.state !== "processing") return;
    let cancelled = false;
    const timer = setInterval(() => { void props.api.exportStatus(props.session.id, exportResult.id).then((result) => {
      if (!cancelled) { setExportResult(result); if (result.state === "failed") setError(true); }
    }).catch(() => { if (!cancelled) setError(true); }); }, 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [props.api, props.session.id, exportResult?.id, exportResult?.state]);
  const jump = (event: RecordingEvent) => {
    if (!video.current) return;
    const videoTime = recordingEventVideoTime(event.timeMs, props.session.idleSpans);
    if (mediaId !== "recording") {
      const target = props.session.parts.find((part) => part.startMs <= videoTime && part.startMs + part.durationMs > videoTime);
      if (!target) { setError(true); return; }
      if (target.mediaId !== mediaId) { pendingSeek.current = (videoTime - target.startMs) / 1000; setMediaId(target.mediaId); return; }
    }
    video.current.currentTime = Math.max(0, (videoTime - partOffset) / 1000);
  };
  return <Modal open title={t("recordings.view")} closeLabel={t("common.close")} onClose={props.onClose} className="task-recordings__player-modal">
    <div className="task-recordings__player">
      <div className="task-recordings__video"><video ref={video} controls preload="metadata" src={props.api.mediaUrl(props.session, mediaId)}
        onLoadedMetadata={() => { if (video.current && pendingSeek.current !== null) { video.current.currentTime = pendingSeek.current; pendingSeek.current = null; } }}
        onError={() => setError(true)} onTimeUpdate={() => setTime((video.current?.currentTime ?? 0) * 1000 + partOffset)} />
        {gap && <div className="task-recordings__gap" aria-live="polite">{t(`recordings.gap.${gap.reason}`)}</div>}</div>
      <div className="task-recordings__actions"><label>{t("recordings.speed")} <select defaultValue="1" onChange={(event) => { if (video.current) video.current.playbackRate = Number(event.target.value); }}>
        {[0.5, 1, 1.5, 2].map((rate) => <option value={rate} key={rate}>{rate}×</option>)}</select></label>
        <label>{t("recordings.source")} <select value={mediaId} onChange={(event) => setMediaId(event.target.value)}>
          {props.session.video && <option value="recording">{t("recordings.fullVideo")}</option>}
          {props.session.parts.map((part, index) => <option key={part.mediaId} value={part.mediaId}>{index + 1} · {duration(part.startMs)}</option>)}</select></label>
        <a href={props.api.mediaUrl(props.session, mediaId, true)} download>{t("recordings.download")}</a>
        <Button size="sm" variant="ghost" disabled={exportBusy || exportResult?.state === "processing"} onClick={() => {
          setExportBusy(true); void props.api.export(props.session.id).then(setExportResult).catch(() => setError(true)).finally(() => setExportBusy(false));
        }}>{t(exportBusy || exportResult?.state === "processing" ? "recordings.exporting" : "recordings.export")}</Button>
        {exportResult?.state === "ready" && <a href={props.api.mediaUrl(props.session, `export-${exportResult.id}`, true)} download>{t("recordings.exportDownload")}</a>}
      </div>
      {exportResult?.state === "ready" && <p>{t(exportResult.missing.length ? "recordings.evidence" : "recordings.notAdmitted")}</p>}
      {error && <p role="alert">{t("recordings.error")}</p>}
      <h4>{t("recordings.events")}</h4><ol className="task-recordings__timeline">
        {[...events].sort((a, b) => a.timeMs - b.timeMs || a.sequence - b.sequence).map((event) => <li key={event.id}><button type="button" onClick={() => jump(event)}>
          <time>{duration(recordingEventVideoTime(event.timeMs, props.session.idleSpans))}</time><span>{t(event.origin === "ocu" ? "recordings.ocu" : "recordings.native")}</span>
          <span>{event.origin === "ocu" ? event.action?.tool : event.type === "mouse_click" ? t("recordings.event.mouse_click") : event.type === "scroll" ? t("recordings.event.scroll")
            : event.type === "key_press" ? `${t("recordings.event.key_press")} ${event.action?.key ?? ""}` : event.type === "text_input" ? t("recordings.event.text_input") : t("recordings.event.input_overflow")}</span>
        </button></li>)}
      </ol>{cursor !== null && <Button size="sm" onClick={() => void load(cursor)}>{t("recordings.more")}</Button>}
    </div>
  </Modal>;
}
