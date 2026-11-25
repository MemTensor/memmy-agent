import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { EventCaptureSessionSchema, type EventCaptureSession, type InstalledPlugin } from '@memmy/local-api-contracts';
import { createEventsConnection } from '../api/events.js';
import { ApiRequestError } from '../api/http.js';
import { notifyPluginChange, PLUGIN_CHANGE_EVENT } from '../lib/plugin-change-event.js';
import { agentChatScopeKey } from '../state/agent-composer-state.js';
import { TEACH_MODE_PLUGIN_ID } from '../lib/teach-mode-plugin.js';
import { useAppState } from '../state/app-state.js';
import { useTranslation } from '../i18n/use-translation.js';
import { useApiClients } from './providers.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import './teach-mode-recording-controller.css';

type ActiveRecording = { plugin: InstalledPlugin; session: EventCaptureSession };
const activeStates = new Set(['starting', 'recording', 'finalizing']);
const maxSeconds = 30 * 60;

/** Keeps Teach Mode's control available across all Memmy routes and desktop Spaces. */
export function TeachModeRecordingController() {
  const { clients } = useApiClients();
  const { state } = useAppState();
  const { t, language } = useTranslation();
  const [plugin, setPlugin] = useState<InstalledPlugin | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [active, setActive] = useState<ActiveRecording | null>(null);
  const [trackedConversationId, setTrackedConversationId] = useState<string | null>(null);
  const [eventConversationId, setEventConversationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [nativeVisible, setNativeVisible] = useState(false);
  /** The native panel appears a moment after the session starts, and leaves a moment before it ends. */
  const [fallbackReady, setFallbackReady] = useState(false);
  const [fallbackPosition, setFallbackPosition] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ x: number; y: number; left: number; top: number; previousSelection: string } | null>(null);
  const busyRef = useRef(false);
  const mutationEpochRef = useRef(0);
  /** Set once per failure so a disabled plugin triggers one list refresh, not one per poll tick. */
  const lifecycleRefreshRef = useRef(false);
  const activeRef = useRef<ActiveRecording | null>(null);
  activeRef.current = active;

  const selectedConversationId = (state.agent.currentChatId ?? state.agent.currentSessionKey
    ?? agentChatScopeKey(null, state.agent.newChatRequestId)).replace(/^websocket:/, '');
  const conversationId = trackedConversationId ?? eventConversationId ?? selectedConversationId;

  useEffect(() => window.memmy?.onTeachingRecordingControlsVisibility?.(setNativeVisible), []);

  useEffect(() => {
    if (!clients?.plugins) return;
    let mounted = true;
    const refresh = () => void clients.plugins.list().then(plugins => {
      if (mounted) setPlugin(plugins.find(item => item.id === TEACH_MODE_PLUGIN_ID && item.state === 'active'
        && item.manifest.conversation) ?? null);
    }).catch(() => { if (mounted) setPlugin(null); });
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener(PLUGIN_CHANGE_EVENT, refresh);
    window.addEventListener('memmy:plugins-changed', refresh);
    return () => { mounted = false; window.removeEventListener('focus', refresh);
      window.removeEventListener(PLUGIN_CHANGE_EVENT, refresh); window.removeEventListener('memmy:plugins-changed', refresh); };
  }, [clients]);

  useEffect(() => {
    if (!plugin || !clients || !conversationId) { setActive(null); return; }
    let mounted = true, pending = false;
    lifecycleRefreshRef.current = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      const epoch = mutationEpochRef.current;
      try {
        const result = await clients.plugins.invoke(plugin.id, plugin.manifest.conversation!.recordingCapabilityId,
          { conversationId, input: { action: 'status' }, origin: 'user', background: true });
        if (result.event.type === 'error') throw new Error(result.event.message);
        const output = result.event.type === 'result' ? result.event.output as { sessions?: unknown[]; active?: unknown } : {};
        const globalActive = output.active ? EventCaptureSessionSchema.parse(output.active) : null;
        const session = globalActive && activeStates.has(globalActive.state)
          ? globalActive
          : (output.sessions ?? []).map(raw => EventCaptureSessionSchema.parse(raw))
            .find(item => item.conversationId === conversationId && activeStates.has(item.state));
        if (!mounted || epoch !== mutationEpochRef.current) return;
        if (session) {
          setActive({ plugin, session });
          setTrackedConversationId(globalActive?.conversationId ?? conversationId);
          setError(null);
        } else {
          setActive(null);
          if (trackedConversationId === conversationId) setTrackedConversationId(null);
          if (eventConversationId === conversationId) setEventConversationId(null);
        }
      } catch (cause) {
        if (isPluginLifecycleError(cause)) {
          // Disabled, suspended, updating, or unpermissioned plugins are lifecycle
          // states. Refresh the plugin list once so polling stops instead of showing
          // the raw transport error and retrying every 1.5 seconds.
          if (mounted && !lifecycleRefreshRef.current) { lifecycleRefreshRef.current = true; notifyPluginChange(); }
          if (mounted) setError(null);
        } else if (mounted && activeRef.current) setError(cause instanceof Error ? cause.message : String(cause));
      } finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1_500);
    const events = typeof EventSource !== 'undefined' ? createEventsConnection(clients.runtimeConfig) : null;
    const onEvent = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(String(event.data)) as { pluginId?: string; conversationId?: string };
        if (payload.pluginId !== plugin.id || !payload.conversationId) return;
        if (!trackedConversationId) setEventConversationId(payload.conversationId.replace(/^websocket:/, ''));
        if (payload.conversationId.replace(/^websocket:/, '') === conversationId) void refresh();
      } catch { /* Other events do not describe this recording. */ }
    };
    events?.addEventListener('plugin.capability_event', onEvent as EventListener);
    window.addEventListener('memmy:plugins-changed', refresh);
    return () => { mounted = false; clearInterval(timer); events?.close(); window.removeEventListener('memmy:plugins-changed', refresh); };
  }, [clients, plugin, conversationId, trackedConversationId, eventConversationId]);

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active?.session.id]);

  useEffect(() => {
    const session = active?.session;
    const value = session && activeStates.has(session.state)
      ? { id: session.id, startedAt: session.startedAt, state: session.state as 'starting' | 'recording' | 'finalizing',
        conversationId: session.conversationId,
        pluginId: active?.plugin.id,
        capabilityId: active?.plugin.manifest.conversation?.recordingCapabilityId,
        labels: { stop: t('plugins.recording.floatingStop'), discard: t('plugins.recording.floatingDiscard'),
          drag: t('plugins.recording.floatingDrag'), confirmTitle: t('plugins.recording.discardConfirmTitle'),
          confirmMessage: t('plugins.recording.discardConfirmMessage'), confirmDiscard: t('plugins.recording.discardConfirmAction'),
          confirmCancel: t('plugins.recording.discardConfirmCancel') } }
      : null;
    if (!value) setNativeVisible(false);
    const update = window.memmy?.updateTeachingRecordingControls?.(value);
    void update?.catch(() => setNativeVisible(false));
  }, [active?.session.id, active?.session.startedAt, active?.session.state, language]);

  // The main process owns the native panel after it appears. Unmounting the
  // conversation renderer must never close the recording controls.

  async function control(action: 'stop' | 'cancel') {
    const selected = activeRef.current;
    if (!selected || !clients || busyRef.current || (action === 'stop' && selected.session.state !== 'recording')) return;
    mutationEpochRef.current++;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      const response = await clients.plugins.invoke(selected.plugin.id, selected.plugin.manifest.conversation!.recordingCapabilityId,
        { conversationId: selected.session.conversationId, origin: 'user',
          input: { action, session_id: selected.session.id } });
      if (response.event.type === 'error') throw new Error(response.event.message);
      if (response.event.type === 'result') {
        const session = EventCaptureSessionSchema.parse(response.event.output);
        setActive(activeStates.has(session.state) ? { ...selected, session } : null);
        if (!activeStates.has(session.state)) setTrackedConversationId(null);
      }
      notifyPluginChange();
    } catch (cause) {
      if (isPluginLifecycleError(cause)) { notifyPluginChange(); setError(null); }
      else setError(cause instanceof Error ? cause.message : String(cause));
    }
    finally { busyRef.current = false; setBusy(false); }
  }

  useEffect(() => window.memmy?.onTeachingRecordingControlAction?.(({ id, action }) => {
    if (activeRef.current?.session.id === id) void control(action);
  }), [clients]);

  function startFallbackDrag(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!bounds) return;
    event.preventDefault();
    dragRef.current = { x: event.clientX, y: event.clientY, left: bounds.left, top: bounds.top,
      previousSelection: document.body.style.userSelect };
    document.body.style.userSelect = 'none';
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moveFallbackDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    setFallbackPosition({ x: Math.max(0, Math.min(window.innerWidth - 148, drag.left + event.clientX - drag.x)),
      y: Math.max(0, Math.min(window.innerHeight - 40, drag.top + event.clientY - drag.y)) });
  }
  function endFallbackDrag() {
    const drag = dragRef.current;
    if (!drag) return;
    document.body.style.userSelect = drag.previousSelection;
    dragRef.current = null;
  }

  // The bar that lives inside the window is only a stand-in for browser previews
  // and for a native panel that never arrives. Showing it right away (or right
  // after the panel disappears) made it flash inside the conversation before the
  // floating bar appeared, so it waits out that hand-off first.
  useEffect(() => {
    if (!active || nativeVisible) { setFallbackReady(false); return; }
    const timer = setTimeout(() => setFallbackReady(true), 1_200);
    return () => clearTimeout(timer);
  }, [active?.session.id, nativeVisible]);

  // Browser previews have no native panel; keep the same compact control on
  // every route so the UI still exposes a way to end the recording.
  if (!active || nativeVisible || !fallbackReady) return null;
  const elapsed = active.session.state === 'starting' ? 0 : Math.max(0, Math.min(maxSeconds,
    Math.floor((now - Date.parse(active.session.startedAt)) / 1_000)));
  const duration = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
  return <div className="teach-recording-control" role="group" aria-label={t('plugins.recording.floatingLabel')}
    style={fallbackPosition ? { left: fallbackPosition.x, top: fallbackPosition.y, bottom: 'auto', transform: 'none' } : undefined}>
    <button type="button" aria-label={t('plugins.recording.floatingStop')} title={t('plugins.recording.floatingStop')} disabled={busy || active.session.state !== 'recording'} onClick={() => void control('stop')}>
      <span className="teach-recording-control__stop" /><span className={elapsed >= maxSeconds - 60 ? 'teach-recording-control__warning' : ''}>{duration}</span>
    </button>
    <button type="button" aria-label={t('plugins.recording.floatingDiscard')} title={t('plugins.recording.floatingDiscard')} disabled={busy || active.session.state === 'finalizing'} onClick={() => setConfirmingDiscard(true)}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 10v7M14 10v7" /></svg>
    </button>
    <div className="teach-recording-control__handle" title={t('plugins.recording.floatingDrag')} aria-label={t('plugins.recording.floatingDrag')}
      onPointerDown={startFallbackDrag} onPointerMove={moveFallbackDrag} onPointerUp={endFallbackDrag}
      onPointerCancel={endFallbackDrag}><svg viewBox="0 0 12 16" aria-hidden="true"><path d="M2 4h8M2 8h8M2 12h8" /></svg></div>
    {error && <span role="alert" className="teach-recording-control__error">{error}</span>}
    <ConfirmDialog open={confirmingDiscard} title={t('plugins.recording.discardConfirmTitle')}
      message={t('plugins.recording.discardConfirmMessage')} confirmLabel={t('plugins.recording.discardConfirmAction')}
      cancelLabel={t('plugins.recording.discardConfirmCancel')} confirmVariant="danger"
      onCancel={() => setConfirmingDiscard(false)} onConfirm={() => { setConfirmingDiscard(false); void control('cancel'); }} />
  </div>;
}

/**
 * Lifecycle errors mean the plugin changed state (disabled, suspended, updating, or
 * missing permissions) rather than that the recording call itself failed. They must
 * refresh the plugin list and stay out of the user-facing error slot.
 */
function isPluginLifecycleError(reason: unknown): boolean {
  return reason instanceof ApiRequestError
    && (reason.code === 'plugin_unavailable' || reason.code === 'conflict' || reason.code === 'plugin_permission_denied');
}
