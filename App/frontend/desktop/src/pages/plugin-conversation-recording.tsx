import { useEffect, useState } from "react";
import { LoaderCircle, Square, Video, X } from "lucide-react";
import { EventCaptureSessionSchema, PluginConversationPresentationSchema, type PluginConversationPresentation, type EventCaptureSession, type InstalledPlugin, type RuntimeConfig } from "@memmy/local-api-contracts";
import type { PluginsClient } from "../api/plugins-client.js";
import { createEventsConnection } from "../api/events.js";
import { useTranslation } from "../i18n/use-translation.js";
import { Button } from "../components/button.js";

export function PluginConversationRecording({ client, config, plugins, conversationId: currentConversationId, onPrompt }: {
  client?: PluginsClient; config?: RuntimeConfig; plugins: InstalledPlugin[]; conversationId: string | null; onPrompt: (text: string) => void;
}) {
  const { t } = useTranslation();
  const conversationId = currentConversationId?.replace(/^websocket:/, "") ?? null;
  const [sessions, setSessions] = useState<Array<{ plugin: InstalledPlugin; session: EventCaptureSession; presentation?: PluginConversationPresentation }>>([]);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const [endingAt, setEndingAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const key = plugins.filter(p => p.state === "active" && p.manifest.conversation).map(p => `${p.id}:${p.version}`).join("|");
  useEffect(() => { setNotice(""); }, [conversationId]);
  useEffect(() => {
    let active = true, pending = false;
    setSessions([]); setError(null);
    if (!conversationId || !client || !key) return;
    const owners = plugins.filter(p => p.state === "active" && p.manifest.conversation);
    const refresh = async () => {
      if (pending) return; pending = true;
      try {
        const results = await Promise.all(owners.map(async plugin => {
          const response = await client.invoke(plugin.id, plugin.manifest.conversation!.recordingCapabilityId,
            { conversationId, input: { action: "status" }, origin: "user", background: true });
          if (response.event.type === "error") { window.dispatchEvent(new Event("memmy:plugins-changed")); throw new Error(response.event.message); }
          const output = response.event.type === "result" ? response.event.output as { sessions?: unknown[] } : {};
          return (output.sessions ?? []).map(raw => ({ plugin, session: EventCaptureSessionSchema.parse(raw), presentation: PluginConversationPresentationSchema.optional().parse((raw as { presentation?: unknown }).presentation) }));
        }));
        if (active) { setSessions(results.flat().filter(item => item.session.conversationId === conversationId)); setError(null); }
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : String(reason)); }
      finally { pending = false; }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 1_500);
    const connection = config && typeof EventSource !== "undefined" ? createEventsConnection(config) : null;
    const onEvent = (event: MessageEvent) => {
      try { const payload = JSON.parse(String(event.data)); if (payload.origin === "agent" && payload.conversationId === conversationId && owners.some(p => p.id === payload.pluginId)) void refresh(); } catch { /* Ignore other events. */ }
    };
    connection?.addEventListener("plugin.capability_event", onEvent as EventListener);
    const changed = () => void refresh(); window.addEventListener("memmy:plugins-changed", changed);
    return () => { active = false; clearInterval(timer); connection?.close(); window.removeEventListener("memmy:plugins-changed", changed); };
  }, [client, config, conversationId, key]);
  const selected = sessions.filter(item => item.session.conversationId === conversationId).sort((a, b) => Number(["starting", "recording", "finalizing"].includes(b.session.state)) - Number(["starting", "recording", "finalizing"].includes(a.session.state))
    || b.session.startedAt.localeCompare(a.session.startedAt))[0];
  const ongoing = selected && ["starting", "recording", "finalizing"].includes(selected.session.state);
  useEffect(() => {
    setNow(Date.now()); setEndingAt(null);
    if (!ongoing) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [selected?.session.id, ongoing]);
  async function control(action: "stop" | "cancel" | "disable") {
    if (!selected || !client || !conversationId || busy) return;
    setBusy(true); setEndingAt(Date.now()); setError(null);
    try {
      if (action === "disable") {
        await client.disable(selected.plugin.id);
        setNotice(t("plugins.recording.disabledNotice"));
        setSessions([]); window.dispatchEvent(new Event("memmy:plugins-changed"));
      } else {
        const response = await client.invoke(selected.plugin.id, selected.plugin.manifest.conversation!.recordingCapabilityId,
          { conversationId, origin: "user", input: { action, session_id: selected.session.id } });
        if (response.event.type === "error") throw new Error(response.event.message);
        if (response.event.type === "result") {
          const session = EventCaptureSessionSchema.parse(response.event.output);
          setSessions(old => old.map(item => item.session.id === session.id ? { ...item, session, presentation: PluginConversationPresentationSchema.optional().parse((response.event.type === "result" ? response.event.output as { presentation?: unknown } : {}).presentation) } : item));
        }
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); setEndingAt(null); }
  }
  if (!selected) return error || notice ? <div className="mx-4 my-2 text-sm" role={error ? "alert" : "status"}>{error ?? notice}</div> : null;
  const { session, presentation } = selected, recording = session.state === "recording";
  const elapsed = session.state === "starting" ? 0 : Math.max(0, Math.floor(((session.endedAt ? Date.parse(session.endedAt) : endingAt ?? now) - Date.parse(session.startedAt)) / 1_000));
  const duration = `${elapsed >= 3600 ? `${String(Math.floor(elapsed / 3600)).padStart(2, "0")}:` : ""}${String(Math.floor(elapsed / 60) % 60).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
  const availability = t(`plugins.recording.availability.${session.availability}`);
  const label = error ? t("plugins.recording.statusUnavailable") : busy ? t("plugins.recording.ending") : recording ? t("plugins.recording.active") :
    session.state === "ready" ? t("plugins.recording.ended") : session.state === "cancelled" ? t("plugins.recording.cancelled") :
    session.state === "finalizing" ? t("plugins.recording.ending") : session.state === "starting" ? session.browserCapture
      ? t("plugins.recording.preparingWindow") : t("plugins.recording.starting") : t("plugins.recording.failed");
  return <section aria-label={t("plugins.recording.label")} data-recording-session={session.id}
    className={ongoing ? `recording-bar recording-bar--activity${recording && !busy && !error ? " recording-bar--live" : ""}` : "mx-4 my-2 rounded-card border border-border-stone/40 bg-background-paper p-3 text-sm"} aria-live="polite">
    {ongoing ? <>
      <span className="recording-bar__icon" aria-hidden="true">{busy || session.state === "starting" || session.state === "finalizing" ? <LoaderCircle size={18} className="animate-spin" /> : <Video size={18} />}</span>
      <strong className="recording-bar__title"><span className="recording-bar__indicator" aria-hidden="true" />{label}</strong>
      <time className="recording-bar__clock" role="timer" aria-label={t("plugins.recording.elapsed")} aria-live="off" dateTime={`PT${elapsed}S`}>{duration}</time>
      <span className="recording-bar__goal" title={session.goal}>{selected.plugin.manifest.name} · {session.goal}</span>
      <div className="recording-bar__actions">
        <button type="button" className="recording-bar__button" disabled={busy || !recording} onClick={() => void control("stop")}><Square size={12} aria-hidden="true" />{t("plugins.recording.stop")}</button>
        <button type="button" className="recording-bar__button" disabled={busy || session.state === "finalizing"} onClick={() => void control("cancel")}><X size={13} aria-hidden="true" />{t("plugins.recording.cancel")}</button>
        <button type="button" className="recording-bar__button" disabled={busy} onClick={() => void control("disable")}>{t("plugins.recording.disable")}</button>
      </div>
      {session.availability === "partial" && <p className="recording-bar__note recording-bar__note--warning">{t("plugins.recording.partialNotice")}</p>}
      {session.limitations.includes("browser_capture_popup_unconfirmed") && <p className="recording-bar__note recording-bar__note--warning">{t("plugins.recording.popupUnconfirmed")}</p>}
      {session.browserCapture && <p className="recording-bar__note">{session.state === "starting"
        ? t("plugins.recording.bindingWindow")
        : t("plugins.recording.windowScope")}</p>}
    </> : <div className="flex flex-wrap items-center gap-3"><strong>{label}</strong><time aria-live="off">{duration}</time><span>{session.goal}</span>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void control("disable")}>{t("plugins.recording.disable")}</Button>
    </div>}
    {!recording && <p className="mt-2">{session.eventCount} {t("plugins.recording.events")}{session.applications.length ? ` · ${session.applications.join(", ")}` : ""} · {availability}</p>}
    {session.state === "ready" && session.captureIntegrity && <p className="mt-2" role="status">{!session.captureIntegrity.snapshotSaved
      ? t("plugins.recording.snapshotFailed")
      : !session.captureIntegrity.boundaryConfirmed
        ? t("plugins.recording.boundaryUnconfirmed")
        : !session.captureIntegrity.coverageComplete
          ? t("plugins.recording.savedWithGaps")
          : t("plugins.recording.saved")}</p>}
    {presentation && <div className="mt-2 flex flex-wrap items-center gap-3"><span>{presentation.message}</span>
      {presentation.actions.map(action => <Button key={action.id} size="sm" disabled={busy} onClick={() => onPrompt(action.prompt)}>{action.label}</Button>)}</div>}
    {session.error && <p role="alert" className={ongoing ? "recording-bar__note recording-bar__note--warning" : undefined}>{session.error}</p>}{error && <p role="alert" className={ongoing ? "recording-bar__note recording-bar__note--warning" : undefined}>{error}</p>}
    {session.limitations.length > 0 && !recording && <details className="mt-2"><summary>{t("plugins.recording.limitations")}</summary>{session.limitations.map((text, i) => <p key={i}>{text}</p>)}</details>}
  </section>;
}
