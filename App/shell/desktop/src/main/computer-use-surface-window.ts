import { BrowserWindow, desktopCapturer, ipcMain, screen, session,
  type DesktopCapturerSource, type Rectangle } from 'electron';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { isComputerUseSurfaceAction, type ComputerUseSurfaceAction, type ComputerUseSurfaceMessage } from '@memmy/local-api-contracts';
import { join } from 'node:path';
import { listComputerUseWindows, selectComputerUseWindowSource, windowIdFromSource } from './computer-use-video-source.js';

type NativePIP = {
  create(title: string, width: number, height: number, x: number, y: number,
    onAction: (action: 'open' | 'hide' | 'click' | 'scroll' | 'placement' | 'dragged' | 'interrupt',
      x: number, y: number, deltaY: number, frameWidth: number, frameHeight: number) => void, placementAvailable: boolean,
    interruptAvailable: boolean): number;
  setImage(id: number, png: Buffer): void;
  setTargetWindow(id: number, windowId: number): void;
  placeNearHost(id: number, hostX: number, hostY: number, hostWidth: number, hostHeight: number,
    areaX: number, areaY: number, areaWidth: number, areaHeight: number, animated: boolean): void;
  close(id: number): void;
};

function loadNativePIP(platform: string): NativePIP | null {
  if (platform !== 'darwin' || !process.versions.electron) return null;
  try {
    const addon = createRequire(import.meta.url)(join(import.meta.dirname, '../native/memmy-pip.node')) as NativePIP;
    return typeof addon.create === 'function' && typeof addon.setImage === 'function'
      && typeof addon.setTargetWindow === 'function' && typeof addon.placeNearHost === 'function'
      && typeof addon.close === 'function' ? addon : null;
  } catch (error) {
    console.warn('Memmy native Computer Use PiP is unavailable:', error);
    return null;
  }
}

type SurfaceWindow = { window: BrowserWindow; ready: boolean; latest: ComputerUseSurfaceMessage;
  sendAction: (action: ComputerUseSurfaceAction) => void; videoSource: DesktopCapturerSource | null;
  videoLookup: Promise<void> | null; videoEpoch: number; videoFailures: number;
  videoReadyAt: number; videoRetry: ReturnType<typeof setTimeout> | null;
  nativeId: number | null; lastNativePaint: number;
  expanded: boolean; hostAnchored: boolean; placementPending: boolean };

const VIDEO_RETRY_DELAYS_MS = [250, 1000, 3000] as const;
const VIDEO_STABLE_MS = 5000;

export type ComputerUsePIPPlacementHost = {
  onPlacement: () => Promise<Rectangle | null> | Rectangle | null;
};

function initialPIPSize(imageDataUrl: string | undefined, edge = 200): { width: number; height: number } {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(imageDataUrl ?? '');
  const header = match ? Buffer.from(match[1]!.slice(0, 48), 'base64') : null;
  const sourceWidth = header?.toString('ascii', 12, 16) === 'IHDR' ? header.readUInt32BE(16) : 4;
  const sourceHeight = header?.toString('ascii', 12, 16) === 'IHDR' ? header.readUInt32BE(20) : 3;
  const ratio = sourceWidth > 0 && sourceHeight > 0 ? sourceWidth / sourceHeight : 4 / 3;
  // The reference PIPStackItem clamps its long edge to 200–400 pt.
  return ratio >= 1 ? { width: edge, height: Math.max(100, Math.round(edge / ratio)) }
    : { width: Math.max(100, Math.round(edge * ratio)), height: edge };
}


function keyOf(message: ComputerUseSurfaceMessage): string {
  return JSON.stringify([message.surface, message.sessionKey, message.channel, message.chatId, message.targetId, message.turnId]);
}

/** A live mirror whose user actions route to the isolated browser or native helper. */
export function createComputerUseSurfaceWindows(platform = process.platform,
  placementHost?: ComputerUsePIPPlacementHost) {
  const windows = new Map<string, SurfaceWindow>();
  const hidden = new Set<string>();
  const nativePIP = loadNativePIP(platform);
  const framelessPIP = !nativePIP && (platform === 'darwin' || platform === 'win32');
  const placeAtHost = (entry: SurfaceWindow, host: Rectangle | null, animated: boolean) => {
    if (!nativePIP || entry.nativeId === null || !host || host.width <= 0 || host.height <= 0) return;
    const area = screen.getDisplayMatching(host).workArea;
    const primaryHeight = screen.getPrimaryDisplay().bounds.height;
    nativePIP.placeNearHost(entry.nativeId, host.x, primaryHeight - host.y - host.height,
      host.width, host.height, area.x, primaryHeight - area.y - area.height, area.width, area.height, animated);
    entry.hostAnchored = true;
    entry.placementPending = false;
  };
  const syncHostPlacement = (host: Rectangle | null) => {
    for (const entry of windows.values()) if ((entry.hostAnchored || entry.placementPending) && !entry.window.isDestroyed())
      placeAtHost(entry, host, entry.placementPending);
  };
  const attachNativeWindow = (entry: SurfaceWindow) => {
    if (!nativePIP || entry.nativeId === null || !entry.latest.targetWindowId) return;
    nativePIP.setTargetWindow(entry.nativeId, entry.latest.targetWindowId);
  };
  const pushNativeSnapshot = (entry: SurfaceWindow) => {
    if (!nativePIP || entry.nativeId === null || entry.latest.surface !== 'computer') return;
    const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(entry.latest.imageDataUrl ?? '');
    if (!match?.[1]) return;
    const buffer = Buffer.from(match[1], 'base64');
    if (buffer.length > 0 && buffer.length <= 8_000_000) nativePIP.setImage(entry.nativeId, buffer);
  };
  const cancelVideoRetry = (entry: SurfaceWindow) => {
    if (entry.videoRetry) clearTimeout(entry.videoRetry);
    entry.videoRetry = null;
  };
  const scheduleVideoRetry = (entry: SurfaceWindow) => {
    const delay = VIDEO_RETRY_DELAYS_MS[entry.videoFailures++];
    if (delay === undefined || entry.window.isDestroyed()) return;
    const epoch = entry.videoEpoch;
    const targetWindowId = entry.latest.targetWindowId;
    entry.videoRetry = setTimeout(() => {
      entry.videoRetry = null;
      if (entry.window.isDestroyed() || entry.videoEpoch !== epoch
          || entry.latest.targetWindowId !== targetWindowId) return;
      resolveVideo(entry, true);
    }, delay);
  };
  const resolveVideo = (entry: SurfaceWindow, retry = false) => {
    if (!['darwin', 'win32'].includes(platform) || entry.latest.surface !== 'computer' || entry.videoSource || entry.videoLookup
        || entry.videoRetry || (!retry && entry.videoFailures > 0)
        || typeof desktopCapturer?.getSources !== 'function') return;
    const requestedWindowId = entry.latest.targetWindowId;
    entry.videoLookup = desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1, height: 1 } })
      .then(sources => {
        if (entry.window.isDestroyed() || entry.latest.targetWindowId !== requestedWindowId) return;
        const owners = platform === 'darwin' ? listComputerUseWindows(process.resourcesPath || '') : [];
        const selected = selectComputerUseWindowSource(sources, entry.latest.targetId, owners,
          requestedWindowId);
        if (selected) {
          entry.videoSource = sources.find(source => source.id === selected.id) ?? null;
          if (entry.videoSource) entry.videoEpoch++;
          const windowId = windowIdFromSource(selected.id);
          if (nativePIP && entry.nativeId !== null && windowId !== null)
            nativePIP.setTargetWindow(entry.nativeId, windowId);
          if (entry.ready) render(entry);
        }
      }).catch(() => undefined).finally(() => {
        entry.videoLookup = null;
        if (entry.window.isDestroyed()) return;
        if (entry.latest.targetWindowId !== requestedWindowId) resolveVideo(entry);
        else if (!entry.videoSource) scheduleVideoRetry(entry);
      });
  };
  const receiveInteraction = (event: Electron.IpcMainEvent, raw: unknown) => {
    const entry = [...windows.values()].find(item => item.window.webContents === event.sender);
    if (!entry || entry.window.isDestroyed()) return;
    const identity = entry.latest;
    if (identity.surface === 'computer' && raw && typeof raw === 'object'
        && ['scroll', 'key'].includes(String((raw as Record<string, unknown>).action))) {
      if (!entry.videoSource) return;
      if ((raw as Record<string, unknown>).frameMode !== 'live') return;
      if (identity.targetWindowId !== undefined
          && windowIdFromSource(entry.videoSource.id) !== identity.targetWindowId) return;
    }
    const rawAction = raw && typeof raw === 'object' ? { ...raw } as Record<string, unknown> : {};
    delete rawAction.targetWindowId;
    delete rawAction.turnId;
    if (rawAction.action === 'click') {
      rawAction.action = 'open';
      for (const field of ['x', 'y', 'frameMode', 'frameWidth', 'frameHeight']) delete rawAction[field];
    }
    const action = { ...rawAction,
      type: 'memmy:computer-use-surface:action', surface: identity.surface,
      sessionKey: identity.sessionKey, channel: identity.channel, chatId: identity.chatId,
      targetId: identity.targetId,
      ...(identity.turnId === undefined ? {} : { turnId: identity.turnId }),
      ...(identity.targetWindowId === undefined ? {} : { targetWindowId: identity.targetWindowId }) };
    if (isComputerUseSurfaceAction(action)) entry.sendAction(action);
  };
  ipcMain.on('memmy:computer-use-surface:interaction', receiveInteraction);
  const receiveCaptureReady = (event: Electron.IpcMainEvent, source: unknown, epoch: unknown) => {
    const entry = [...windows.values()].find(item => item.window.webContents === event.sender);
    if (entry && entry.videoSource?.id === source && entry.videoEpoch === epoch)
      entry.videoReadyAt = Date.now();
  };
  ipcMain.on('memmy:computer-use-surface:capture-ready', receiveCaptureReady);
  const receiveCaptureEnded = (event: Electron.IpcMainEvent, source: unknown, epoch: unknown) => {
    const entry = [...windows.values()].find(item => item.window.webContents === event.sender);
    if (!entry || entry.videoSource?.id !== source || entry.videoEpoch !== epoch) return;
    if (entry.videoReadyAt && Date.now() - entry.videoReadyAt >= VIDEO_STABLE_MS)
      entry.videoFailures = 0;
    entry.videoReadyAt = 0;
    entry.videoSource = null;
    scheduleVideoRetry(entry);
  };
  ipcMain.on('memmy:computer-use-surface:capture-ended', receiveCaptureEnded);
  const receiveHide = (event: Electron.IpcMainEvent) => {
    const match = [...windows].find(([, entry]) => entry.window.webContents === event.sender);
    if (!match) return;
    hidden.add(match[0]);
    match[1].window.close();
  };
  ipcMain.on('memmy:computer-use-surface:hide', receiveHide);
  const receiveExpand = (event: Electron.IpcMainEvent) => {
    const entry = [...windows.values()].find(item => item.window.webContents === event.sender);
    if (!entry || entry.window.isDestroyed() || !framelessPIP) return;
    entry.expanded = !entry.expanded;
    const edge = entry.expanded ? 400 : 300;
    const size = initialPIPSize(entry.latest.imageDataUrl, edge);
    const previous = entry.window.getBounds();
    const width = size.width + 24, height = size.height + 24;
    entry.window.setBounds({ x: previous.x + previous.width - width,
      y: previous.y, width, height });
  };
  ipcMain.on('memmy:computer-use-surface:expand', receiveExpand);
  const sendNativePointer = (entry: SurfaceWindow, x: number, y: number, deltaY: number,
    frameWidth = 0, frameHeight = 0) => {
    const { window } = entry;
    const sourceId = entry.videoSource?.id;
    if (window.isDestroyed() || !Number.isFinite(x) || !Number.isFinite(y)
        || !Number.isFinite(deltaY) || deltaY === 0) return;
    if (frameWidth > 1 && frameHeight > 1) {
      const identity = entry.latest;
      const action = { type: 'memmy:computer-use-surface:action' as const, surface: identity.surface,
        sessionKey: identity.sessionKey, channel: identity.channel, chatId: identity.chatId,
        targetId: identity.targetId,
        ...(identity.turnId === undefined ? {} : { turnId: identity.turnId }),
        ...(identity.targetWindowId === undefined ? {} : { targetWindowId: identity.targetWindowId }),
        action: 'scroll' as const, x, y, frameMode: 'live' as const, frameWidth, frameHeight, deltaY };
      if (isComputerUseSurfaceAction(action)) entry.sendAction(action);
      return;
    }
    if (!sourceId) return;
    void window.webContents.executeJavaScript(`window.__memmyResolvePipPoint(${x},${y})`, true)
      .then((point: unknown) => {
        if (window.isDestroyed() || entry.videoSource?.id !== sourceId || !point || typeof point !== 'object') return;
        const frame = point as Record<string, unknown>;
        if (frame.frameMode !== 'live' || typeof frame.x !== 'number' || !Number.isFinite(frame.x)
            || typeof frame.y !== 'number' || !Number.isFinite(frame.y)
            || typeof frame.frameWidth !== 'number' || !Number.isFinite(frame.frameWidth)
            || typeof frame.frameHeight !== 'number' || !Number.isFinite(frame.frameHeight)) return;
        const identity = entry.latest;
        const action = { type: 'memmy:computer-use-surface:action', surface: identity.surface,
          sessionKey: identity.sessionKey, channel: identity.channel, chatId: identity.chatId,
          targetId: identity.targetId,
          ...(identity.turnId === undefined ? {} : { turnId: identity.turnId }),
          ...(identity.targetWindowId === undefined ? {} : { targetWindowId: identity.targetWindowId }),
          action: 'scroll', x: frame.x, y: frame.y,
          frameMode: 'live', frameWidth: frame.frameWidth, frameHeight: frame.frameHeight,
          deltaY };
        if (isComputerUseSurfaceAction(action)) entry.sendAction(action);
      }).catch(() => undefined);
  };
  const update = (message: ComputerUseSurfaceMessage, sendAction: (action: ComputerUseSurfaceAction) => void = () => undefined) => {
    const key = keyOf(message);
    const existing = windows.get(key);
    if (message.type.endsWith(':close')) {
      if (existing && !existing.window.isDestroyed()) existing.window.close();
      windows.delete(key);
      hidden.delete(key);
      return;
    }
    if (hidden.has(key)) return;
    if (existing && !existing.window.isDestroyed()) {
      // Native Computer Use emits status-only updates when an action cannot
      // be completed (permission denied, stale window, etc.).  Those updates
      // intentionally omit imageDataUrl, but replacing the last frame with
      // an empty value makes the PiP render a broken-image icon and leaves
      // the user with a black "快照" window.  Keep the most recent valid
      // frame while the live capture reconnects or the next frame arrives.
      const nextMessage = message.surface === 'computer' && !message.imageDataUrl
        && existing.latest.imageDataUrl
        ? { ...message, imageDataUrl: existing.latest.imageDataUrl,
          ...(message.targetWindowId === undefined && existing.latest.targetWindowId !== undefined
            ? { targetWindowId: existing.latest.targetWindowId } : {}) }
        : message;
      const targetChanged = existing.latest.targetWindowId !== nextMessage.targetWindowId;
      existing.latest = nextMessage;
      existing.sendAction = sendAction;
      if (targetChanged) {
        cancelVideoRetry(existing);
        existing.videoSource = null;
        existing.videoEpoch++;
        existing.videoFailures = 0;
        existing.videoReadyAt = 0;
      }
      if (existing.ready) {
        pushNativeSnapshot(existing);
        attachNativeWindow(existing);
        render(existing);
      }
      resolveVideo(existing);
      return;
    }
    const workArea = screen.getPrimaryDisplay().workArea;
    const offset = (windows.size % 4) * 28;
    const windowPIP = framelessPIP;
    const nativeSize = initialPIPSize(message.imageDataUrl);
    const windowsSize = initialPIPSize(message.imageDataUrl, 300);
    const previewSession = session.fromPartition(`memmy-computer-use-${randomUUID()}`);
    const window = new BrowserWindow({
      title: message.surface === 'browser' ? 'Memmy 浏览器' : 'Memmy 桌面应用',
      width: nativePIP ? nativeSize.width : windowPIP ? windowsSize.width + 24 : 400,
      height: nativePIP ? nativeSize.height : windowPIP ? windowsSize.height + 24 : 280,
      minWidth: nativePIP ? 100 : windowPIP ? 224 : 260,
      minHeight: nativePIP ? 100 : windowPIP ? 124 : 180,
      x: Math.max(workArea.x, workArea.x + workArea.width - (windowPIP ? windowsSize.width + 48 : 424) - offset),
      y: Math.max(workArea.y, workArea.y + workArea.height - (windowPIP ? windowsSize.height + 48 : 304) - offset),
      show: false, frame: !nativePIP && !windowPIP, transparent: windowPIP,
      hasShadow: !windowPIP, resizable: true, alwaysOnTop: !nativePIP, skipTaskbar: true,
      autoHideMenuBar: true, backgroundColor: windowPIP ? '#00000000' : '#17191d',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
        session: previewSession, ...(nativePIP ? { offscreen: { useSharedTexture: false }, backgroundThrottling: false } : {}),
        preload: join(import.meta.dirname, '../preload/computer-use-surface-preload.cjs') },
    });
    const entry: SurfaceWindow = { window, ready: false, latest: message, sendAction, videoSource: null,
      videoLookup: null, videoEpoch: 0, videoFailures: 0, videoReadyAt: 0, videoRetry: null,
      nativeId: null, lastNativePaint: 0,
      expanded: false, hostAnchored: false, placementPending: false };
    if (nativePIP) {
      const display = screen.getPrimaryDisplay();
      const x = Math.max(workArea.x + 8, workArea.x + workArea.width - nativeSize.width - 24 - offset);
      const top = Math.max(workArea.y + 8, workArea.y + workArea.height - nativeSize.height - 24 - offset);
      const y = display.bounds.height - top - nativeSize.height;
      entry.nativeId = nativePIP.create(message.title, nativeSize.width, nativeSize.height, x, y, (action, px, py, deltaY, frameWidth, frameHeight) => {
        if (window.isDestroyed()) return;
        if (action === 'hide') { hidden.add(key); window.close(); return; }
        if (action === 'dragged') { entry.hostAnchored = false; entry.placementPending = false; return; }
        if (action === 'placement') {
          if (placementHost) { entry.placementPending = true;
            void Promise.resolve().then(() => placementHost.onPlacement())
            .then(bounds => { if (!window.isDestroyed()) placeAtHost(entry, bounds, true); }).catch(() => undefined);
          }
          return;
        }
        if (action === 'click') action = 'open';
        if (action === 'interrupt') {
          const identity = entry.latest;
          if (!identity.turnId || identity.surface !== 'computer') return;
          const stop: ComputerUseSurfaceAction = { type: 'memmy:computer-use-surface:action',
            surface: 'computer', sessionKey: identity.sessionKey, channel: identity.channel,
            chatId: identity.chatId, targetId: identity.targetId, turnId: identity.turnId,
            ...(identity.targetWindowId === undefined ? {} : { targetWindowId: identity.targetWindowId }),
            action: 'interrupt' };
          if (isComputerUseSurfaceAction(stop)) entry.sendAction(stop);
          return;
        }
        if (action === 'scroll') {
          if (entry.latest.surface === 'computer') sendNativePointer(entry, px, py, deltaY, frameWidth, frameHeight);
          return;
        }
        const identity = entry.latest;
        entry.sendAction({ type: 'memmy:computer-use-surface:action', surface: identity.surface,
          sessionKey: identity.sessionKey, channel: identity.channel, chatId: identity.chatId,
          targetId: identity.targetId,
          ...(identity.turnId === undefined ? {} : { turnId: identity.turnId }),
          ...(identity.targetWindowId === undefined ? {} : { targetWindowId: identity.targetWindowId }),
          action: 'open' });
      }, Boolean(placementHost), message.surface === 'computer' && Boolean(message.turnId));
      window.webContents.on('paint', (_event, _dirty, image) => {
        if (entry.nativeId === null || image.isEmpty() || window.isDestroyed()) return;
        // A computer-use card is a live capture of the target window. Painting the
        // offscreen page would cover that video with a snapshot and its status badge.
        if (entry.latest.surface === 'computer' && entry.latest.targetWindowId) return;
        const now = Date.now();
        if (now - entry.lastNativePaint < 80) return;
        entry.lastNativePaint = now;
        nativePIP.setImage(entry.nativeId, image.toPNG());
      });
      window.webContents.setFrameRate(15);
    }
    previewSession.setDisplayMediaRequestHandler?.((_request, callback) => {
      if (entry.videoSource && !window.isDestroyed()) callback({ video: entry.videoSource });
      // Electron documents null as the rejection response; its TypeScript type omits it.
      else (callback as unknown as (streams: null) => void)(null);
    });
    windows.set(key, entry);
    window.on('closed', () => {
      cancelVideoRetry(entry);
      if (entry.nativeId !== null) { nativePIP?.close(entry.nativeId); entry.nativeId = null; }
      if (windows.get(key) === entry) windows.delete(key);
    });
    window.webContents.once('did-finish-load', () => {
      if (window.isDestroyed()) return;
      entry.ready = true;
      pushNativeSnapshot(entry);
      attachNativeWindow(entry);
      render(entry);
      if (!nativePIP) window.showInactive();
    });
    void window.loadFile(join(import.meta.dirname, 'computer-use-surface.html'),
      nativePIP ? { query: { nativePip: '1' } }
        : windowPIP ? { query: { windowPip: '1' } } : undefined);
    resolveVideo(entry);
  };
  const closeAll = () => {
    for (const entry of windows.values()) if (!entry.window.isDestroyed()) entry.window.close();
    windows.clear();
    hidden.clear();
  };
  const dispose = () => {
    closeAll();
    ipcMain.removeListener('memmy:computer-use-surface:interaction', receiveInteraction);
    ipcMain.removeListener('memmy:computer-use-surface:capture-ready', receiveCaptureReady);
    ipcMain.removeListener('memmy:computer-use-surface:capture-ended', receiveCaptureEnded);
    ipcMain.removeListener('memmy:computer-use-surface:hide', receiveHide);
    ipcMain.removeListener('memmy:computer-use-surface:expand', receiveExpand);
  };
  return { update, closeAll, dispose, syncHostPlacement };
}

function render(entry: SurfaceWindow): void {
  const { window, latest } = entry;
  if (window.isDestroyed()) return;
  const script = `window.__memmySetSurface(${JSON.stringify(latest.title)},${JSON.stringify(latest.imageDataUrl ?? null)},${JSON.stringify(latest.surface)},${JSON.stringify(entry.videoSource?.id ?? null)},${entry.videoEpoch},${Boolean(latest.turnId)})`;
  void window.webContents.executeJavaScript(script, Boolean(entry.videoSource)).catch(() => undefined);
}
