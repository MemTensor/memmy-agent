import { BrowserWindow, ipcMain, screen, type Display, type Rectangle } from 'electron';
import { join } from 'node:path';

export type TeachingRecordingControlState = { id: string; startedAt: string; state: 'starting' | 'recording' | 'finalizing';
  conversationId: string; pluginId?: string; capabilityId?: string; labels: { stop: string; discard: string; drag: string;
    confirmTitle?: string; confirmMessage?: string; confirmDiscard?: string; confirmCancel?: string } };
export type TeachingRecordingControlAction = { id: string; action: 'stop' | 'cancel' };

const channel = 'memmy:teaching-recording-controls';
const width = 154, height = 46;
// Discarding deletes the recording, so it is confirmed in a popover above the bar (as in Codex).
// The window has to be wider than the panel itself: the 12px CSS shadow is drawn
// inside the window, and a window sized exactly to the panel cuts it into hard bands.
const confirmWidth = 276 + 2 * 14, confirmHeight = 178;
let panel: BrowserWindow | null = null;
let current: TeachingRecordingControlState | null = null;
let syncTimer: ReturnType<typeof setInterval> | null = null;
let collapsedBounds: Rectangle | null = null;
let reportVisibility: (visible: boolean) => void = () => undefined;
let syncFromHost: () => Promise<void> = async () => undefined;

// The bar follows the display the person is working on. Electron only reports
// the pointer, so the display under the pointer is the signal we can read on
// every tick: the pointer has to stay on a new display for a couple of ticks,
// otherwise a quick pass over another monitor would drag the bar with it.
const followTickMs = 1_500;
const followConfirmSamples = 2;
// setBounds() emits 'moved' too, so the move we applied ourselves is remembered:
// a 'moved' that still matches it is not the person dragging the bar.
let lastAppliedBounds: Rectangle | null = null;
let followedDisplayId: number | null = null;
let pendingDisplayId: number | null = null;
let pendingSamples = 0;
// Set once the person drags the bar: from then on their position wins, until
// the display it sits on disappears or its work area changes.
let userPositioned = false;
let watchingDisplays = false;

export type FollowDecision = { move: boolean; pendingDisplayId: number | null; pendingSamples: number };

/**
 * Decides whether a bar anchored to one display should move to the pointer's display.
 *
 * @param anchoredDisplayId The display the bar currently belongs to.
 * @param cursorDisplayId The display under the pointer on this tick.
 * @param pendingDisplayId The display seen on the previous tick, if it was not the anchored one.
 * @param pendingSamples How many ticks the pointer has already stayed on that display.
 * @param confirmSamples Ticks required before the bar actually moves.
 * @returns Whether to move, plus the pending-display bookkeeping for the next tick.
 */
export function resolveFollowDecision(anchoredDisplayId: number | null, cursorDisplayId: number,
  pendingDisplayId: number | null, pendingSamples: number, confirmSamples = followConfirmSamples): FollowDecision {
  if (anchoredDisplayId !== null && cursorDisplayId === anchoredDisplayId)
    return { move: false, pendingDisplayId: null, pendingSamples: 0 };
  const samples = cursorDisplayId === pendingDisplayId ? pendingSamples + 1 : 1;
  return samples >= Math.max(1, confirmSamples)
    ? { move: true, pendingDisplayId: null, pendingSamples: 0 }
    : { move: false, pendingDisplayId: cursorDisplayId, pendingSamples: samples };
}

function sameBounds(left: Rectangle, right: Rectangle): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

function applyPanelBounds(bounds: Rectangle): void {
  if (!panel || panel.isDestroyed()) return;
  lastAppliedBounds = bounds;
  console.info('[teach-panel] setBounds', JSON.stringify(bounds));
  panel.setBounds(bounds, false);
}

/** Moves the bar to the pointer's display once the pointer settles there. */
function followPointerDisplay(): void {
  if (!panel || panel.isDestroyed() || userPositioned || collapsedBounds) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const decision = resolveFollowDecision(followedDisplayId, display.id, pendingDisplayId, pendingSamples);
  pendingDisplayId = decision.pendingDisplayId;
  pendingSamples = decision.pendingSamples;
  if (!decision.move) return;
  followedDisplayId = display.id;
  const target = targetBounds(display);
  if (!sameBounds(panel.getBounds(), target)) applyPanelBounds(target);
}

/** Keeps the bar on a display that still exists and inside its work area. */
function handleDisplayChange(): void {
  if (!panel || panel.isDestroyed() || collapsedBounds) return;
  if (!userPositioned) {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    followedDisplayId = display.id;
    pendingDisplayId = null;
    pendingSamples = 0;
    const target = targetBounds(display);
    if (!sameBounds(panel.getBounds(), target)) applyPanelBounds(target);
    return;
  }
  const bounds = panel.getBounds(), area = screen.getDisplayMatching(bounds).workArea;
  const x = Math.round(Math.min(Math.max(bounds.x, area.x), area.x + area.width - bounds.width));
  const y = Math.round(Math.min(Math.max(bounds.y, area.y), area.y + area.height - bounds.height));
  if (x !== bounds.x || y !== bounds.y) applyPanelBounds({ ...bounds, x, y });
}

function attachDisplayWatchers(): void {
  if (watchingDisplays) return;
  watchingDisplays = true;
  screen.on('display-added', handleDisplayChange);
  screen.on('display-removed', handleDisplayChange);
  screen.on('display-metrics-changed', handleDisplayChange);
}

function detachDisplayWatchers(): void {
  if (!watchingDisplays) return;
  watchingDisplays = false;
  screen.removeListener('display-added', handleDisplayChange);
  screen.removeListener('display-removed', handleDisplayChange);
  screen.removeListener('display-metrics-changed', handleDisplayChange);
}

function validState(value: unknown): value is TeachingRecordingControlState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  return typeof state.id === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(state.id)
    && typeof state.startedAt === 'string' && Number.isFinite(Date.parse(state.startedAt))
    && typeof state.conversationId === 'string' && state.conversationId.length > 0 && state.conversationId.length <= 500
    && (state.state === 'starting' || state.state === 'recording' || state.state === 'finalizing')
    && [state.pluginId, state.capabilityId].every(id => id === undefined
      || (typeof id === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(id)))
    && Boolean(state.labels && typeof state.labels === 'object'
      && ['stop', 'discard', 'drag'].every(key => typeof (state.labels as Record<string, unknown>)[key] === 'string'
        && ((state.labels as Record<string, string>)[key]?.length ?? 0) <= 80)
      && ['confirmTitle', 'confirmMessage', 'confirmDiscard', 'confirmCancel'].every(key => {
        const label = (state.labels as Record<string, unknown>)[key];
        return label === undefined || (typeof label === 'string' && label.length <= 160);
      }));
}

function targetBounds(display: Display): Rectangle {
  const area = display.workArea;
  return { x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + area.height - height - 16),
    width, height };
}

function setConfirming(open: boolean) {
  if (!panel || panel.isDestroyed()) return;
  if (open && !collapsedBounds) {
    const bar = panel.getBounds(), area = screen.getDisplayMatching(bar).workArea;
    collapsedBounds = bar;
    // Grow upward and keep the bar itself where the user left it.
    const x = Math.round(Math.min(Math.max(bar.x + bar.width / 2 - confirmWidth / 2, area.x), area.x + area.width - confirmWidth));
    const y = Math.round(Math.max(bar.y + bar.height - confirmHeight, area.y));
    // Programmatic: growing the window for the popover must not look like a drag.
    applyPanelBounds({ x, y, width: confirmWidth, height: confirmHeight });
  } else if (!open && collapsedBounds) {
    const restore = collapsedBounds;
    collapsedBounds = null;
    applyPanelBounds(restore);
  }
}

function dispose() {
  console.info('[teach-panel] dispose');
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
  detachDisplayWatchers();
  if (panel && !panel.isDestroyed()) panel.destroy();
  panel = null;
  current = null;
  collapsedBounds = null;
  followedDisplayId = null;
  pendingDisplayId = null;
  pendingSamples = 0;
  userPositioned = false;
  lastAppliedBounds = null;
  reportVisibility(false);
}

/**
 * Whether the bar may become the key window when it is clicked.
 *
 * On macOS a click on the bar activates Memmy. If the bar itself cannot become
 * key, AppKit hands key status back to the Memmy window that last had it (the
 * conversation or pet window) and orders that window front; when it sits on
 * another Space, the Dock switches to that Space ("switching to space … for
 * window … ordered on non-visible space"). A drag that is still in progress
 * while the Space switches is carried along, which also takes the bar out of
 * the other Spaces. Letting the clicked bar take key status leaves the other
 * windows where they are. Windows has no Spaces, and a focusable window there
 * would take keyboard focus from the application being taught.
 *
 * @param platform The platform the bar is created on.
 * @returns Whether the bar window is created focusable.
 */
export function recordingBarFocusable(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin';
}

function createPanel() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  console.info('[teach-panel] create display', display.id, JSON.stringify(targetBounds(display)));
  const window = new BrowserWindow({
    ...targetBounds(display), type: 'panel', frame: false, transparent: true, backgroundColor: '#00000000',
    resizable: false, minimizable: false, maximizable: false, skipTaskbar: true, hasShadow: false,
    focusable: recordingBarFocusable(), acceptFirstMouse: true, show: false,
    webPreferences: { preload: join(import.meta.dirname, '../preload/teaching-recording-controls-preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  panel = window;
  followedDisplayId = display.id;
  pendingDisplayId = null;
  pendingSamples = 0;
  userPositioned = false;
  attachDisplayWatchers();
  window.setMenu(null);
  window.setAlwaysOnTop(true, 'screen-saver');
  // Without skipTransformProcessType Electron switches the whole app to
  // UIElementApplication when this is called: Memmy's window and Dock icon
  // disappear for a moment and the foreground falls back to the previous app
  // (the one the person was teaching). The window still joins every Space.
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  // Dragging pins the bar at the person's own spot; automatic following stops.
  window.on('moved', () => {
    const bounds = window.getBounds();
    const byUs = Boolean(lastAppliedBounds && sameBounds(bounds, lastAppliedBounds));
    console.info('[teach-panel] moved', JSON.stringify(bounds), byUs ? 'by-us' : 'externally');
    if (byUs) return;
    userPositioned = true;
  });
  window.on('closed', () => { if (panel === window) { panel = null; current = null; detachDisplayWatchers(); reportVisibility(false); } });
  window.once('ready-to-show', () => {
    if (panel !== window) return;
    console.info('[teach-panel] shown', JSON.stringify(window.getBounds()));
    window.showInactive();
    reportVisibility(window.isVisible());
  });
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html())}`).catch(() => dispose());
  syncTimer = setInterval(() => { followPointerDisplay(); void syncFromHost(); }, followTickMs);
  syncTimer.unref();
}

// The owning plugin and capability come from the renderer, never from a hardcoded name.
async function invokeRecording(config: { baseUrl: string; localToken: string }, conversationId: string,
  input: { action: 'status' | 'stop' | 'cancel'; session_id?: string },
  target: { pluginId?: string; capabilityId?: string } = {}): Promise<Record<string, unknown>> {
  const pluginId = target.pluginId ?? 'teach-mode', capabilityId = target.capabilityId ?? 'recording';
  const path = `/api/v1/plugins/${encodeURIComponent(pluginId)}/capabilities/${encodeURIComponent(capabilityId)}/invoke`;
  const response = await fetch(new URL(path, config.baseUrl), {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-memmy-local-token': config.localToken },
    body: JSON.stringify({ conversationId, origin: 'user', background: input.action === 'status', input }),
  });
  if (!response.ok) throw new Error(`Teach Mode control request failed: ${response.status}`);
  const result = await response.json() as { event?: { type?: string; output?: unknown } };
  if (result.event?.type !== 'result' || !result.event.output || typeof result.event.output !== 'object')
    throw new Error('Teach Mode control did not return a recording status');
  return result.event.output as Record<string, unknown>;
}

export function registerTeachingRecordingControls(getMainWindow: () => BrowserWindow | null,
  getRuntimeConfig: () => { baseUrl: string; localToken: string } | null): void {
  let syncing = false, controlling = false;
  const keepMainWindowVisible = () => {
    const main = getMainWindow();
    if (!main || main.isDestroyed()) return;
    // Starting Teach Mode must not turn the conversation window into a
    // background/minimized app. If macOS has already collapsed it during the
    // transition, restore it without activating it; the user's next click can
    // still move to another app normally.
    if (main.isMinimized()) main.restore();
    if (!main.isVisible()) main.showInactive();
  };
  syncFromHost = async () => {
    const session = current, config = getRuntimeConfig();
    if (!session || !config || syncing || controlling) return;
    syncing = true;
    try {
      const output = await invokeRecording(config, session.conversationId, { action: 'status' },
        { pluginId: session.pluginId, capabilityId: session.capabilityId });
      if (current?.id !== session.id) return;
      const match = Array.isArray(output.sessions) ? output.sessions.find(value =>
        value && typeof value === 'object' && (value as { id?: unknown }).id === session.id) as { state?: string; startedAt?: string } | undefined : undefined;
      if (!match || !['starting', 'recording', 'finalizing'].includes(match.state ?? '')) { dispose(); return; }
      if (match.state !== current.state || match.startedAt !== current.startedAt) {
        current = { ...current, state: match.state as TeachingRecordingControlState['state'],
          startedAt: match.startedAt ?? current.startedAt };
        panel?.webContents.send(`${channel}:state`, current);
      }
    } catch { /* Keep the control usable during a temporary Host interruption. */ }
    finally { syncing = false; }
  };
  reportVisibility = visible => {
    const main = getMainWindow();
    if (main && !main.isDestroyed()) main.webContents.send(`${channel}:visible`, visible);
  };
  ipcMain.handle(`${channel}:update`, (event, value: unknown) => {
    if (BrowserWindow.fromWebContents(event.sender) !== getMainWindow()
      || event.senderFrame !== event.sender.mainFrame) return;
    // A route change, reload or main-window close must not end an active
    // recording. The Host owns its terminal state; verify it independently.
    if (value === null) { void syncFromHost(); return; }
    if (!validState(value)) return;
    if (current?.id !== value.id) dispose();
    current = value;
    keepMainWindowVisible();
    if (!panel) createPanel();
    if (panel && !panel.isDestroyed() && !panel.webContents.isLoading()) panel.webContents.send(`${channel}:state`, value);
    if (panel?.isVisible()) reportVisibility(true);
  });
  ipcMain.handle(`${channel}:ready`, event => {
    if (panel && event.sender === panel.webContents && event.senderFrame === panel.webContents.mainFrame && current)
      panel.webContents.send(`${channel}:state`, current);
  });
  ipcMain.on(`${channel}:confirm`, (event, open: unknown) => {
    if (!panel || event.sender !== panel.webContents || event.senderFrame !== panel.webContents.mainFrame) return;
    setConfirming(open === true);
  });
  ipcMain.on(`${channel}:action`, (event, action: unknown) => {
    if (!panel || event.sender !== panel.webContents || event.senderFrame !== panel.webContents.mainFrame
      || !current || !action || typeof action !== 'object') return;
    const value = action as Record<string, unknown>;
    if (value.id !== current.id || (value.action !== 'stop' && value.action !== 'cancel')) return;
    if (controlling) return;
    const session = current, config = getRuntimeConfig();
    if (!config) return;
    controlling = true;
    void invokeRecording(config, session.conversationId,
      { action: value.action, session_id: session.id },
      { pluginId: session.pluginId, capabilityId: session.capabilityId }).then(output => {
        if (current?.id !== session.id) return;
        if (!['starting', 'recording', 'finalizing'].includes(String(output.state))) { dispose(); return; }
        current = { ...current, state: output.state as TeachingRecordingControlState['state'] };
        panel?.webContents.send(`${channel}:state`, current);
      }).catch(() => undefined).finally(() => { controlling = false; });
  });
}

function html(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>
  *{box-sizing:border-box;-webkit-user-select:none;user-select:none}html,body{margin:0;height:100%;background:transparent;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;color:#fff}body{padding:3px;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:8px}
  .bar{width:148px;height:40px;flex:none;border:1px solid #3b3b3b;border-radius:20px;background:#505050;box-shadow:0 2px 4px #0003;display:flex;align-items:stretch;overflow:hidden}
  button{border:0;color:inherit;cursor:pointer;background:transparent;font:inherit;-webkit-app-region:no-drag}button:disabled{opacity:.45;cursor:default}
  .end{flex:1;display:flex;align-items:center;justify-content:center;gap:5px;min-width:0;padding:0 3px;color:#ff5959;font-size:12px;font-weight:600;white-space:nowrap}.end:hover:not(:disabled),.discard:hover:not(:disabled),.discard.active{background:#ffffff19}
  .stop{width:18px;height:18px;display:grid;place-items:center;border:1.5px solid #ff5959;border-radius:50%;flex:none}.stop:after{content:'';width:6px;height:6px;border-radius:1px;background:#ff5959}
  .time{font-variant-numeric:tabular-nums;letter-spacing:.1px}.time.warning{animation:pulse 1s infinite alternate}@keyframes pulse{to{opacity:.55}}
  .discard{width:36px;border-left:.5px solid #ffffff26;display:grid;place-items:center}.discard svg{width:18px;height:18px;stroke:#fff;fill:none;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
  .handle{-webkit-app-region:drag;cursor:grab;width:24px;border-left:.5px solid #ffffff26;display:flex;align-items:center;justify-content:center;user-select:none}.handle svg{width:10px;height:14px;stroke:#a0a0a0;fill:none;stroke-width:1.2;stroke-linecap:round}
  .confirm{display:none;width:276px;flex:none;padding:14px 14px 12px;border:1px solid #3b3b3b;border-radius:12px;background:#2f2f2f;box-shadow:0 4px 12px #0005}.confirm.open{display:block}
  .confirm h1{margin:0 0 4px;font-size:13px;font-weight:600;line-height:18px}.confirm p{margin:0 0 12px;font-size:12px;line-height:17px;color:#c8c8c8}
  .actions{display:flex;justify-content:flex-end;gap:8px}.actions button{height:28px;padding:0 12px;border-radius:7px;font-size:12px;font-weight:500}
  .keep{background:#ffffff1f}.keep:hover{background:#ffffff2e}.drop{background:#e5484d}.drop:hover{background:#f05a5f}
  </style></head><body><div id="confirm" class="confirm" role="alertdialog" aria-labelledby="confirm-title" aria-describedby="confirm-message"><h1 id="confirm-title">确定要丢弃这段录制吗？</h1><p id="confirm-message">录到的内容会被删除，无法恢复。</p><div class="actions"><button id="keep" class="keep">继续录制</button><button id="drop" class="drop">丢弃录制</button></div></div><div class="bar"><button id="end" class="end" title="录制完成（最长 30 分钟）" aria-label="录制完成"><span class="stop"></span><span id="time" class="time">0:00</span></button><button id="discard" class="discard" title="丢弃录制" aria-label="丢弃录制" aria-haspopup="dialog"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 10v7M14 10v7"/></svg></button><div class="handle" title="拖动控制条" aria-label="拖动控制条"><svg viewBox="0 0 12 16"><path d="M2 4h8M2 8h8M2 12h8"/></svg></div></div><script>
  const bridge=window.teachingRecordingControls,$=id=>document.getElementById(id),end=$('end'),discard=$('discard'),time=$('time'),confirmBox=$('confirm');let state=null;
  function setConfirm(open){if(confirmBox.classList.contains('open')===open)return;confirmBox.classList.toggle('open',open);discard.classList.toggle('active',open);bridge.confirm(open)}
  function tick(){if(!state)return;const sec=state.state==='starting'?0:Math.max(0,Math.min(1800,Math.floor((Date.now()-Date.parse(state.startedAt))/1000)));const mm=String(Math.floor(sec/60)),ss=String(sec%60).padStart(2,'0');time.textContent=mm+':'+ss;time.classList.toggle('warning',sec>=1740);end.disabled=state.state!=='recording';discard.disabled=state.state==='finalizing'}
  end.onclick=()=>{if(state)bridge.action({id:state.id,action:'stop'})};
  discard.onclick=()=>{if(state)setConfirm(!confirmBox.classList.contains('open'))};
  $('keep').onclick=()=>setConfirm(false);
  $('drop').onclick=()=>{if(state)bridge.action({id:state.id,action:'cancel'})};
  document.addEventListener('keydown',event=>{if(event.key==='Escape')setConfirm(false)});
  function label(el,text){if(text){el.title=text;el.setAttribute('aria-label',text)}}
  bridge.subscribe(next=>{state=next;const l=next.labels;label(end,l.stop);label(discard,l.discard);label(document.querySelector('.handle'),l.drag);if(l.confirmTitle)$('confirm-title').textContent=l.confirmTitle;if(l.confirmMessage)$('confirm-message').textContent=l.confirmMessage;if(l.confirmDiscard)$('drop').textContent=l.confirmDiscard;if(l.confirmCancel)$('keep').textContent=l.confirmCancel;tick()});setInterval(tick,1000);
  </script></body></html>`;
}
