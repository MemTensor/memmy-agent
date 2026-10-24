import { BrowserWindow, desktopCapturer, ipcMain, screen, session,
  type DesktopCapturerSource } from 'electron';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { isComputerUseSurfaceAction, type ComputerUseSurfaceAction, type ComputerUseSurfaceMessage } from '@memmy/local-api-contracts';
import { join } from 'node:path';
import { release } from 'node:os';
import { listComputerUseWindows, selectComputerUseWindowSource, windowIdFromSource } from './computer-use-video-source.js';
import { layoutPIPStack, pipSize, type PIPSize } from './computer-use-pip-layout.js';
import { windowsSourceOwners } from './computer-use-window-capture.js';

export type NativePIP = {
  create(title: string, width: number, height: number, x: number, y: number,
    onAction: (action: 'open' | 'hide' | 'hide-task' | 'hide-all' | 'click' | 'scroll' | 'dragged' | 'resized' | 'source-size' | 'interrupt' | 'capture-ready' | 'capture-ended' | 'screen-permission-required',
      x: number, y: number, deltaY: number, frameWidth: number, frameHeight: number, captureEpoch?: number) => void,
    interruptAvailable: boolean): number;
  setImage(id: number, png: Buffer): void;
  setTargetWindow(id: number, windowId: number, pid: number, epoch: number, associatedWindowIds: number[]): void;
  clearTargetWindow(id: number, epoch: number): void;
  setVisible(id: number, visible: boolean): void;
  setPosition(id: number, x: number, y: number): void;
  close(id: number): void;
  screenRecordingGranted(): boolean;
};

function loadNativePIP(platform: string): NativePIP | null {
  if (platform !== 'darwin' || !process.versions.electron) return null;
  // ScreenCaptureKit is built for macOS 14; the frameless Electron mirror
  // remains available on the older systems supported by the desktop shell.
  if (Number.parseInt(release().split('.')[0] ?? '', 10) < 23) return null;
  try {
    const addon = createRequire(import.meta.url)(join(import.meta.dirname, '../native/memmy-pip.node')) as NativePIP;
    return typeof addon.create === 'function' && typeof addon.setImage === 'function'
      && typeof addon.setTargetWindow === 'function'
      && typeof addon.clearTargetWindow === 'function'
      && typeof addon.setVisible === 'function' && typeof addon.setPosition === 'function'
      && typeof addon.close === 'function' && typeof addon.screenRecordingGranted === 'function' ? addon : null;
  } catch (error) {
    console.warn('Memmy native Computer Use PiP is unavailable:', error);
    return null;
  }
}

type SurfaceWindow = { window: BrowserWindow; ready: boolean; closed: boolean; latest: ComputerUseSurfaceMessage;
  retiredTurns: Set<string | undefined>;
  sendAction: (action: ComputerUseSurfaceAction) => void; videoSource: DesktopCapturerSource | null;
  videoLookup: Promise<void> | null; cancelVideoLookup: (() => void) | null; videoEpoch: number; videoFailures: number;
  videoReadyAt: number; videoRetry: ReturnType<typeof setTimeout> | null;
  ownerTimer: ReturnType<typeof setTimeout> | null;
  nativeId: number | null; nativeLive: boolean; nativeEpoch: number; nativeBinding: string | null; lastNativePaint: number;
  snapshotReady: boolean; snapshotEpoch: number; unavailableHidden: boolean;
  expanded: boolean; layoutManaged: boolean; cardSize: PIPSize; inset: number; hidden: boolean };

const VIDEO_RETRY_DELAYS_MS = [250, 1000, 3000] as const;
const VIDEO_STABLE_MS = 5000;
const VIDEO_RECOVERY_MS = 15_000;
const VIDEO_DISCOVERY_TIMEOUT_MS = 3500;

export type ComputerUsePIPOptions = {
  onVisibilityChanged?: () => void;
  onScreenRecordingPermissionRequired?: (request: {
    isCurrent(): boolean; readGranted(): boolean; retryCapture(): void;
  }) => void;
};

function initialPIPSize(imageDataUrl: string | undefined, edge = 200): { width: number; height: number } {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(imageDataUrl ?? '');
  const bytes = match ? Buffer.from(match[1]!.slice(0, 48), 'base64') : null;
  const header = bytes && bytes.length >= 24 ? bytes : null;
  const sourceWidth = header?.toString('ascii', 12, 16) === 'IHDR' ? header.readUInt32BE(16) : 4;
  const sourceHeight = header?.toString('ascii', 12, 16) === 'IHDR' ? header.readUInt32BE(20) : 3;
  return pipSize(sourceWidth, sourceHeight, edge);
}

function associatedWindowIds(value: unknown, root: number): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is number => typeof id === 'number'
    && Number.isSafeInteger(id) && id > 0 && id <= 0xffffffff && id !== root))]
    .sort((a, b) => a - b).slice(0, 64);
}

function singleWindowVideoAllowed(message: ComputerUseSurfaceMessage, platform: string): boolean {
  return platform !== 'darwin' && !(platform === 'win32'
    && Array.isArray(message.targetAssociatedWindowIds) && message.targetAssociatedWindowIds.length > 0);
}

function associatedScopeChanged(previous: ComputerUseSurfaceMessage, next: ComputerUseSurfaceMessage): boolean {
  if (!Array.isArray(next.targetAssociatedWindowIds)) return false;
  const before = [...(previous.targetAssociatedWindowIds ?? [])].sort((a, b) => a - b);
  const after = [...next.targetAssociatedWindowIds].sort((a, b) => a - b);
  return before.length !== after.length || before.some((id, index) => id !== after[index]);
}

function keyOf(message: ComputerUseSurfaceMessage): string {
  return JSON.stringify([message.surface, message.sessionKey, message.channel, message.chatId, message.targetId, message.turnId]);
}
function chatOf(message: ComputerUseSurfaceMessage): string {
  return JSON.stringify([message.sessionKey, message.channel, message.chatId]);
}
function taskOf(message: ComputerUseSurfaceMessage): string {
  return JSON.stringify([message.sessionKey, message.channel, message.chatId, message.turnId]);
}

function exactNativeTarget(message: ComputerUseSurfaceMessage, platform: string): string | null {
  const id = message.targetWindowId, pid = message.targetPid;
  if (message.surface !== 'computer' || !['darwin', 'win32'].includes(platform)
    || typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || (platform === 'darwin' && id > 0xffffffff)
    || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1 || pid > 0xffffffff) return null;
  return JSON.stringify([taskOf(message), pid, id]);
}

function isClosed(entry: SurfaceWindow): boolean {
  return entry.closed || entry.window.isDestroyed();
}

/** A live mirror whose user actions route to the isolated browser or native helper. */
export function createComputerUseSurfaceWindows(platform = process.platform,
  options?: ComputerUsePIPOptions, nativePIP = loadNativePIP(platform)) {
  const windows = new Map<string, SurfaceWindow>();
  const hiddenTasks = new Set<string>();
  const completedTurns = new Set<string>();
  const completedTurnKey = (message: ComputerUseSurfaceMessage) => message.surface === 'computer' && message.turnId
    ? JSON.stringify([chatOf(message), message.turnId]) : null;
  const rememberCompletedTurn = (message: ComputerUseSurfaceMessage) => {
    const key = completedTurnKey(message);
    if (key === null) return;
    completedTurns.add(key);
    while (completedTurns.size > 256) completedTurns.delete(completedTurns.values().next().value!);
  };
  const hasHiddenActive = () => [...windows.values()].some(entry => entry.hidden && !isClosed(entry));
  const notifyVisibility = () => options?.onVisibilityChanged?.();
  const applyVisibility = (entry: SurfaceWindow) => {
    const visible = !entry.hidden && !entry.unavailableHidden;
    if (entry.nativeId !== null) nativePIP?.setVisible(entry.nativeId, visible);
    else if (visible && entry.ready) entry.window.showInactive();
    else if (!visible) entry.window.hide();
  };
  const setVisible = (entry: SurfaceWindow, visible: boolean) => {
    entry.hidden = !visible;
    applyVisibility(entry);
  };
  const previewRecovered = (entry: SurfaceWindow) => {
    if (!entry.unavailableHidden) return;
    entry.unavailableHidden = false;
    applyVisibility(entry);
    relayout();
  };
  const relayout = () => {
    const entries = [...windows.values()].filter(entry => entry.layoutManaged && !entry.hidden && !entry.unavailableHidden
      && !isClosed(entry));
    if (!entries.length) return;
    const area = screen.getPrimaryDisplay().workArea;
    const bounds = layoutPIPStack(entries.map(entry => entry.cardSize), area);
    entries.forEach((entry, index) => {
      const card = bounds[index]!;
      if (entry.nativeId !== null) nativePIP?.setPosition(entry.nativeId, card.x,
        screen.getPrimaryDisplay().bounds.height - card.y - card.height);
      else {
        const margin = entry.inset;
        entry.window.setBounds({ x: card.x - margin / 2, y: card.y - margin / 2,
          width: card.width + margin, height: card.height + margin });
      }
    });
  };
  const hide = (entry: SurfaceWindow, scope: unknown) => {
    const tasks = scope === 'all' ? [...windows.values()].map(item => taskOf(item.latest)) : [taskOf(entry.latest)];
    tasks.forEach(task => hiddenTasks.add(task));
    for (const item of windows.values()) if (hiddenTasks.has(taskOf(item.latest))) setVisible(item, false);
    relayout();
    notifyVisibility();
  };
  const restoreAll = () => {
    hiddenTasks.clear();
    for (const entry of windows.values()) if (entry.hidden && !isClosed(entry)) setVisible(entry, true);
    relayout();
    notifyVisibility();
  };
  const attachNativeWindow = (entry: SurfaceWindow) => {
    const pid = entry.latest.targetPid;
    if (!nativePIP || entry.nativeId === null) return;
    const windowId = entry.latest.targetWindowId;
    if (typeof windowId !== 'number' || !Number.isSafeInteger(windowId) || windowId < 1 || windowId > 0xffffffff
      || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff) {
      if (entry.nativeBinding !== null) {
        entry.nativeBinding = null;
        entry.nativeLive = false;
        nativePIP.clearTargetWindow(entry.nativeId, ++entry.nativeEpoch);
      }
      return;
    }
    const associated = associatedWindowIds(entry.latest.targetAssociatedWindowIds, windowId);
    const binding = JSON.stringify([windowId, pid, associated]);
    if (entry.nativeBinding === binding) return;
    entry.nativeLive = false;
    entry.nativeBinding = binding;
    nativePIP.setTargetWindow(entry.nativeId, windowId, pid, ++entry.nativeEpoch, associated);
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
  const cancelOwnerCheck = (entry: SurfaceWindow) => {
    if (entry.ownerTimer) clearTimeout(entry.ownerTimer);
    entry.ownerTimer = null;
  };
  const ownsVideoSource = async (entry: SurfaceWindow, source: DesktopCapturerSource): Promise<boolean> => {
    if (!singleWindowVideoAllowed(entry.latest, platform)
        || !Number.isSafeInteger(entry.latest.targetPid) || !entry.latest.targetPid
        || windowIdFromSource(source.id) !== entry.latest.targetWindowId) return false;
    const expectedPid = entry.latest.targetPid;
    const owned = platform === 'win32'
      ? (await windowsSourceOwners([source])).get(source.id) === expectedPid
      : selectComputerUseWindowSource([source], entry.latest.targetId,
        listComputerUseWindows(process.resourcesPath || ''), entry.latest.targetWindowId, expectedPid) !== null;
    return !isClosed(entry) && entry.latest.targetPid === expectedPid
      && windowIdFromSource(source.id) === entry.latest.targetWindowId && owned;
  };
  const scheduleOwnerCheck = (entry: SurfaceWindow) => {
    cancelOwnerCheck(entry);
    if (!['darwin', 'win32'].includes(platform) || !entry.videoSource || isClosed(entry)) return;
    const source = entry.videoSource, epoch = entry.videoEpoch;
    entry.ownerTimer = setTimeout(() => {
      entry.ownerTimer = null;
      void ownsVideoSource(entry,source).catch(() => false).then(owned => {
        if (isClosed(entry) || entry.videoSource !== source || entry.videoEpoch !== epoch) return;
        if (owned) { scheduleOwnerCheck(entry); return; }
        entry.videoSource = null;
        entry.videoEpoch++;
        entry.videoReadyAt = 0;
        if (entry.nativeId !== null) {
          // Revoke native coordinate proof too. A fresh binding stops the old
          // stream and revalidates the same window/PID before any new frame.
          entry.nativeLive = false;
          entry.nativeBinding = null;
          attachNativeWindow(entry);
          pushNativeSnapshot(entry);
        }
        if (entry.ready) render(entry);
        scheduleVideoRetry(entry);
      });
    },2000);
    entry.ownerTimer.unref?.();
  };
  const scheduleVideoRetry = (entry: SurfaceWindow) => {
    if (isClosed(entry) || entry.nativeLive || entry.videoRetry || !singleWindowVideoAllowed(entry.latest, platform)) return;
    const delay = VIDEO_RETRY_DELAYS_MS[entry.videoFailures++] ?? VIDEO_RECOVERY_MS;
    entry.videoFailures = Math.min(entry.videoFailures, VIDEO_RETRY_DELAYS_MS.length + 1);
    if (entry.videoFailures > VIDEO_RETRY_DELAYS_MS.length && !entry.snapshotReady && !entry.videoReadyAt) {
      entry.unavailableHidden = true;
      applyVisibility(entry);
      relayout();
    }
    if (entry.ready) render(entry);
    const epoch = entry.videoEpoch;
    const targetWindowId = entry.latest.targetWindowId;
    const targetPid = entry.latest.targetPid;
    entry.videoRetry = setTimeout(() => {
      entry.videoRetry = null;
      if (isClosed(entry) || entry.videoEpoch !== epoch
          || entry.latest.targetWindowId !== targetWindowId || entry.latest.targetPid !== targetPid || entry.nativeLive) return;
      resolveVideo(entry, true);
    }, delay);
    entry.videoRetry.unref?.();
  };
  const resolveVideo = (entry: SurfaceWindow, retry = false) => {
    // Chromium's single-window stream omits detached Mac menus and popovers.
    // Keep the verified model snapshot while native group capture reconnects.
    if (!singleWindowVideoAllowed(entry.latest, platform)) return;
    if (isClosed(entry) || !['darwin', 'win32'].includes(platform) || entry.latest.surface !== 'computer' || entry.nativeLive || entry.videoSource || entry.videoLookup
        || entry.videoRetry || (!retry && entry.videoFailures > 0)
        || typeof desktopCapturer?.getSources !== 'function') return;
    const requestedWindowId = entry.latest.targetWindowId;
    const requestedPid = entry.latest.targetPid;
    const requestedVideoEpoch = entry.videoEpoch;
    if (!Number.isSafeInteger(requestedWindowId) || !requestedWindowId
      || !Number.isSafeInteger(requestedPid) || !requestedPid) return;
    let discoveryTimer: ReturnType<typeof setTimeout> | undefined;
    const discovery = Promise.race([
      // Any non-empty thumbnail size makes Electron capture every window.
      desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } }),
      new Promise<DesktopCapturerSource[]>((_resolve, reject) => {
        discoveryTimer = setTimeout(() => reject(new Error('Window capture discovery timed out')), VIDEO_DISCOVERY_TIMEOUT_MS);
        discoveryTimer.unref?.();
        entry.cancelVideoLookup = () => {
          if (discoveryTimer) clearTimeout(discoveryTimer);
          reject(new Error('Window capture presentation closed'));
        };
      }),
    ]);
    entry.videoLookup = discovery
      .then(async sources => {
        if (isClosed(entry) || entry.nativeLive || !singleWindowVideoAllowed(entry.latest, platform)
            || entry.videoEpoch !== requestedVideoEpoch || entry.latest.targetWindowId !== requestedWindowId
            || entry.latest.targetPid !== requestedPid) return;
        const owners = platform === 'darwin' ? listComputerUseWindows(process.resourcesPath || '') : [];
        const selected = selectComputerUseWindowSource(sources, entry.latest.targetId, owners,
          requestedWindowId, platform === 'darwin' ? requestedPid : undefined);
        if (selected) {
          const source = sources.find(source => source.id === selected.id) ?? null;
          if (!source || !await ownsVideoSource(entry,source)) return;
          if (isClosed(entry) || entry.nativeLive || !singleWindowVideoAllowed(entry.latest, platform)
              || entry.videoEpoch !== requestedVideoEpoch || entry.latest.targetWindowId !== requestedWindowId
              || entry.latest.targetPid !== requestedPid) return;
          entry.videoSource = source;
          if (entry.videoSource) entry.videoEpoch++;
          attachNativeWindow(entry);
          if (entry.ready) render(entry);
          scheduleOwnerCheck(entry);
        }
      }).catch(() => undefined).finally(() => {
        if (discoveryTimer) clearTimeout(discoveryTimer);
        entry.cancelVideoLookup = null;
        entry.videoLookup = null;
        if (isClosed(entry)) return;
        if (entry.latest.targetWindowId !== requestedWindowId || entry.latest.targetPid !== requestedPid) resolveVideo(entry);
        else if (!entry.videoSource) scheduleVideoRetry(entry);
      });
  };
  const receiveInteraction = (event: Electron.IpcMainEvent, raw: unknown) => {
    const entry = [...windows.values()].find(item => item.window.webContents === event.sender);
    if (!entry || isClosed(entry)) return;
    const identity = entry.latest;
    if (identity.surface === 'computer' && raw && typeof raw === 'object'
        && ['scroll', 'key'].includes(String((raw as Record<string, unknown>).action))) {
      if (!entry.videoSource || entry.nativeLive) return;
      if ((raw as Record<string, unknown>).frameMode !== 'live') return;
      if (identity.targetWindowId !== undefined
          && windowIdFromSource(entry.videoSource.id) !== identity.targetWindowId) return;
    }
    const rawAction = raw && typeof raw === 'object' ? { ...raw } as Record<string, unknown> : {};
    delete rawAction.targetWindowId;
    delete rawAction.targetPid;
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
  const receiveCaptureReady = (event: Electron.IpcMainEvent, source: unknown, epoch: unknown, width: unknown, height: unknown) => {
    const entry = [...windows.values()].find(item => item.window.webContents === event.sender);
    if (!entry || entry.nativeLive || !entry.videoSource || entry.videoSource.id !== source || entry.videoEpoch !== epoch
      || typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width)
      || !Number.isFinite(height) || width < 2 || height < 2) return;
    const selected = entry.videoSource;
    void ownsVideoSource(entry, selected).catch(() => false).then(owned => {
      if (!owned || entry.nativeLive || isClosed(entry) || entry.videoSource !== selected || entry.videoEpoch !== epoch) return;
      entry.videoReadyAt = Date.now();
      previewRecovered(entry);
      if (entry.nativeId === null) {
        entry.cardSize = pipSize(width, height, Math.max(entry.cardSize.width, entry.cardSize.height));
        entry.window.setAspectRatio(width / height, { width: 24, height: 24 });
        relayout();
      }
    });
  };
  ipcMain.on('memmy:computer-use-surface:capture-ready', receiveCaptureReady);
  const receiveSnapshotReady = (event: Electron.IpcMainEvent, epoch: unknown) => {
    const entry = [...windows.values()].find(item => item.window.webContents === event.sender);
    if (!entry || isClosed(entry) || entry.snapshotEpoch !== epoch || !entry.latest.imageDataUrl) return;
    entry.snapshotReady = true;
    previewRecovered(entry);
  };
  ipcMain.on('memmy:computer-use-surface:snapshot-ready', receiveSnapshotReady);
  const receiveCaptureEnded = (event: Electron.IpcMainEvent, source: unknown, epoch: unknown) => {
    const entry = [...windows.values()].find(item => item.window.webContents === event.sender);
    if (!entry || entry.videoSource?.id !== source || entry.videoEpoch !== epoch) return;
    if (entry.videoReadyAt && Date.now() - entry.videoReadyAt >= VIDEO_STABLE_MS)
      entry.videoFailures = 0;
    entry.videoReadyAt = 0;
    entry.videoSource = null;
    cancelOwnerCheck(entry);
    if (entry.ready) render(entry);
    scheduleVideoRetry(entry);
  };
  ipcMain.on('memmy:computer-use-surface:capture-ended', receiveCaptureEnded);
  const receiveHide = (event: Electron.IpcMainEvent, scope: unknown) => {
    const match = [...windows].find(([, entry]) => entry.window.webContents === event.sender);
    if (!match) return;
    hide(match[1], scope);
  };
  ipcMain.on('memmy:computer-use-surface:hide', receiveHide);
  const receiveExpand = (event: Electron.IpcMainEvent) => {
    const entry = [...windows.values()].find(item => item.window.webContents === event.sender);
    if (!entry || isClosed(entry) || entry.nativeId !== null) return;
    entry.expanded = !entry.expanded;
    const edge = entry.expanded ? 400 : 300;
    const size = initialPIPSize(entry.latest.imageDataUrl, edge);
    entry.cardSize = size;
    entry.layoutManaged = false;
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
    const videoEpoch = entry.videoEpoch;
    if (isClosed(entry) || !Number.isFinite(x) || !Number.isFinite(y)
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
        if (isClosed(entry) || entry.nativeLive || entry.videoEpoch !== videoEpoch
          || entry.videoSource?.id !== sourceId || !point || typeof point !== 'object') return;
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
  const releasePresentation = (entry: SurfaceWindow) => {
    if (entry.closed) return;
    entry.closed = true;
    cancelVideoRetry(entry);
    cancelOwnerCheck(entry);
    entry.cancelVideoLookup?.();
    entry.cancelVideoLookup = null;
    entry.videoSource = null;
    entry.videoEpoch++;
    entry.videoReadyAt = 0;
    entry.nativeBinding = null;
    entry.nativeLive = false;
    const nativeId = entry.nativeId;
    entry.nativeId = null;
    const epoch = ++entry.nativeEpoch;
    if (nativeId !== null) {
      // Clear capture before closing its panels. Either addon call may fail;
      // neither may prevent other presentations or host state being released.
      try { nativePIP?.clearTargetWindow(nativeId, epoch); }
      catch { console.warn('Memmy Computer Use capture cleanup failed.'); }
      try { nativePIP?.close(nativeId); }
      catch { console.warn('Memmy Computer Use native presentation close failed.'); }
    }
    for (const [key, item] of windows) if (item === entry) windows.delete(key);
    const task = taskOf(entry.latest);
    if (![...windows.values()].some(item => taskOf(item.latest) === task)) hiddenTasks.delete(task);
    relayout();
    notifyVisibility();
  };
  const closePresentation = (entry: SurfaceWindow) => {
    releasePresentation(entry);
    if (entry.window.isDestroyed()) return;
    try { entry.window.close(); }
    catch { console.warn('Memmy Computer Use fallback presentation close failed.'); }
    // These private mirrors must never keep an offscreen media context alive
    // when a renderer is unresponsive or fails to complete its close event.
    if (!entry.window.isDestroyed()) {
      try { entry.window.destroy(); }
      catch { console.warn('Memmy Computer Use fallback presentation destroy failed.'); }
    }
  };
  const update = (message: ComputerUseSurfaceMessage, sendAction: (action: ComputerUseSurfaceAction) => void = () => undefined) => {
    const ownerKey = keyOf(message);
    if (message.type.endsWith(':close')) {
      rememberCompletedTurn(message);
      // The agent closes with its per-turn handler identity, often without a
      // native tuple. A completed older turn must not close a reused panel.
      for (const entry of windows.values()) {
        if (keyOf(entry.latest) === ownerKey) closePresentation(entry);
      }
      return;
    }
    const completed = completedTurnKey(message);
    if (completed !== null && completedTurns.has(completed)) return;
    const nativeTarget = exactNativeTarget(message, platform);
    const existing = (nativeTarget === null ? undefined : [...windows.values()].find(entry =>
      !isClosed(entry) && exactNativeTarget(entry.latest, platform) === nativeTarget))
      ?? [...windows.values()].find(entry => !isClosed(entry) && keyOf(entry.latest) === ownerKey);
    if (existing && !existing.window.isDestroyed()) {
      if (existing.retiredTurns.has(message.turnId)) return;
      if (existing.latest.turnId !== message.turnId) {
        existing.retiredTurns.add(existing.latest.turnId);
        while (existing.retiredTurns.size > 32) existing.retiredTurns.delete(existing.retiredTurns.values().next().value);
      }
      // Native Computer Use emits status-only updates when an action cannot
      // be completed (permission denied, stale window, etc.).  Those updates
      // intentionally omit imageDataUrl, but replacing the last frame with
      // an empty value makes the PiP render a broken-image icon and leaves
      // the user with a black "快照" window.  Keep the most recent valid
      // frame while the live capture reconnects or the next frame arrives.
      const popupScopeChanged = platform === 'win32' && associatedScopeChanged(existing.latest, message);
      let nextMessage = message.surface === 'computer' && !message.imageDataUrl && !popupScopeChanged
        && existing.latest.imageDataUrl
        && (message.targetWindowId === undefined || message.targetWindowId === existing.latest.targetWindowId)
        && (message.targetPid === undefined || message.targetPid === existing.latest.targetPid)
        ? { ...message, imageDataUrl: existing.latest.imageDataUrl,
          ...(message.targetWindowId === undefined && existing.latest.targetWindowId !== undefined
            ? { targetWindowId: existing.latest.targetWindowId } : {}),
          ...(message.targetPid === undefined && existing.latest.targetPid !== undefined
            ? { targetPid: existing.latest.targetPid } : {}),
          ...(message.targetAssociatedWindowIds === undefined && existing.latest.targetAssociatedWindowIds !== undefined
            ? { targetAssociatedWindowIds: existing.latest.targetAssociatedWindowIds } : {}) }
        : message;
      if (nextMessage.appKey === undefined && existing.latest.appKey !== undefined)
        nextMessage = { ...nextMessage, appKey: existing.latest.appKey };
      const targetChanged = existing.latest.targetWindowId !== nextMessage.targetWindowId
        || existing.latest.targetPid !== nextMessage.targetPid;
      const videoScopeChanged = singleWindowVideoAllowed(existing.latest, platform)
        !== singleWindowVideoAllowed(nextMessage, platform);
      if (targetChanged || existing.latest.imageDataUrl !== nextMessage.imageDataUrl) {
        existing.snapshotReady = false;
        existing.snapshotEpoch++;
      }
      existing.latest = nextMessage;
      existing.sendAction = sendAction;
      if (popupScopeChanged && !nextMessage.imageDataUrl) {
        // Pixels of the prior popup group cannot represent this new topology.
        existing.unavailableHidden = true;
        applyVisibility(existing);
      }
      if (targetChanged || videoScopeChanged) {
        cancelVideoRetry(existing);
        cancelOwnerCheck(existing);
        existing.cancelVideoLookup?.();
        existing.videoSource = null;
        existing.videoEpoch++;
        existing.videoFailures = 0;
        existing.videoReadyAt = 0;
        if (targetChanged) {
          existing.nativeLive = false;
          existing.unavailableHidden = true;
          applyVisibility(existing);
        }
      }
      attachNativeWindow(existing);
      if (existing.ready) {
        pushNativeSnapshot(existing);
        render(existing);
      }
      resolveVideo(existing);
      return;
    }
    // One app keeps one card per chat: an extension tab and a native window of
    // the same browser, or two windows of one app, replace each other.
    const sameApp = message.appKey === undefined ? [] : [...windows.values()].filter(entry =>
      !isClosed(entry) && entry.latest.appKey === message.appKey && chatOf(entry.latest) === chatOf(message));
    const inheritHidden = sameApp.some(entry => entry.hidden);
    for (const entry of sameApp) closePresentation(entry);
    // A native window may have parallel task owners. Each task retains its
    // own presentation and callbacks; aliases share a card only within a task.
    // Keep a unique map key so alias adoption cannot overwrite another window.
    const key = randomUUID();
    const workArea = screen.getPrimaryDisplay().workArea;
    let useNative = Boolean(nativePIP);
    let windowPIP = !useNative && (platform === 'darwin' || platform === 'win32');
    const nativeSize = initialPIPSize(message.imageDataUrl);
    const windowsSize = initialPIPSize(message.imageDataUrl, 300);
    const previewSession = session.fromPartition(`memmy-computer-use-${randomUUID()}`);
    let nativeId: number | null = null;
    let entry!: SurfaceWindow;
    if (nativePIP) {
      try {
        const display = screen.getPrimaryDisplay();
        const x = Math.max(workArea.x + 8, workArea.x + workArea.width - nativeSize.width - 24);
        const top = Math.max(workArea.y + 8, workArea.y + workArea.height - nativeSize.height - 24);
        const y = display.bounds.height - top - nativeSize.height;
        nativeId = nativePIP.create(message.title, nativeSize.width, nativeSize.height, x, y, (action, px, py, deltaY, frameWidth, frameHeight, captureEpoch) => {
          if (!entry || isClosed(entry)) return;
          if (action === 'screen-permission-required') {
            const binding = entry.nativeBinding;
            const epoch = entry.nativeEpoch;
            const current = () => !isClosed(entry) && entry.nativeBinding === binding && entry.nativeEpoch === epoch
              && entry.latest.targetWindowId === px;
            if (binding !== null && captureEpoch === epoch && current()) {
              options?.onScreenRecordingPermissionRequired?.({
                isCurrent: current,
                readGranted: () => nativePIP.screenRecordingGranted(),
                retryCapture: () => {
                  if (!current() || !nativePIP.screenRecordingGranted()) return;
                  entry.nativeBinding = null;
                  attachNativeWindow(entry);
                },
              });
            }
            return;
          }
          if (action === 'capture-ready' || action === 'capture-ended') {
            // Capture notifications use x for the CGWindowID, so a delayed event
            // from the previous target cannot disable the current live stream.
            const activeWindowId = entry.latest.targetWindowId
              ?? (entry.videoSource ? windowIdFromSource(entry.videoSource.id) : null);
            if (entry.nativeBinding === null || px !== activeWindowId || captureEpoch !== entry.nativeEpoch) return;
            const becameLive = action === 'capture-ready' && !entry.nativeLive;
            entry.nativeLive = action === 'capture-ready';
            if (entry.nativeLive) {
              if (becameLive) {
                // The stopped fallback stream must not authorize late ready/
                // ended IPC after native pauses and reopens the same source.
                entry.videoEpoch++;
                scheduleOwnerCheck(entry);
              }
              entry.videoReadyAt = 0;
              cancelVideoRetry(entry);
              previewRecovered(entry);
            } else {
              console.warn('Memmy native PiP capture stopped; reconnecting the window preview.', px);
              pushNativeSnapshot(entry);
              resolveVideo(entry);
            }
            if (entry.ready) render(entry);
            return;
          }
          if (action === 'hide' || action === 'hide-task' || action === 'hide-all') { hide(entry, action === 'hide-all' ? 'all' : 'task'); return; }
          if (action === 'dragged') { entry.layoutManaged = false; relayout(); return; }
          if (action === 'resized' || action === 'source-size') {
            if (px > 0 && py > 0) entry.cardSize = { width: px, height: py };
            if (action === 'resized') entry.layoutManaged = false;
            relayout(); return;
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
            if (captureEpoch !== entry.nativeEpoch || (frameWidth > 1 && frameHeight > 1 && !entry.nativeLive)) return;
            if (entry.latest.surface === 'computer') sendNativePointer(entry, px, py, deltaY, frameWidth, frameHeight);
            return;
          }
          if (action !== 'open') return;
          const identity = entry.latest;
          if (identity.surface === 'computer' && (entry.nativeBinding === null || captureEpoch !== entry.nativeEpoch)) return;
          entry.sendAction({ type: 'memmy:computer-use-surface:action', surface: identity.surface,
            sessionKey: identity.sessionKey, channel: identity.channel, chatId: identity.chatId,
            targetId: identity.targetId,
            ...(identity.turnId === undefined ? {} : { turnId: identity.turnId }),
            ...(identity.targetWindowId === undefined ? {} : { targetWindowId: identity.targetWindowId }),
            action: 'open' });
        }, message.surface === 'computer' && Boolean(message.turnId));
      } catch (error) {
        console.warn('Memmy native PiP could not create this presentation; using Electron:', error);
        useNative = false;
        windowPIP = platform === 'darwin' || platform === 'win32';
      }
    }
    const window = new BrowserWindow({
      title: message.surface === 'browser' ? 'Memmy 浏览器' : 'Memmy 桌面应用',
      width: useNative ? nativeSize.width : windowPIP ? windowsSize.width + 24 : 400,
      height: useNative ? nativeSize.height : windowPIP ? windowsSize.height + 24 : 280,
      minWidth: useNative ? 1 : windowPIP ? 25 : 260,
      minHeight: useNative ? 1 : windowPIP ? 25 : 180,
      x: Math.max(workArea.x, workArea.x + workArea.width - (windowPIP ? windowsSize.width + 48 : 424)),
      y: Math.max(workArea.y, workArea.y + workArea.height - (windowPIP ? windowsSize.height + 48 : 304)),
      show: false, frame: !useNative && !windowPIP, transparent: windowPIP,
      hasShadow: !windowPIP, resizable: true, alwaysOnTop: !useNative, skipTaskbar: true,
      ...(windowPIP ? { focusable: false } : {}),
      autoHideMenuBar: true, backgroundColor: windowPIP ? '#00000000' : '#17191d',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
        session: previewSession, backgroundThrottling: false, ...(useNative ? { offscreen: { useSharedTexture: false } } : {}),
        preload: join(import.meta.dirname, '../preload/computer-use-surface-preload.cjs') },
    });
    entry = { window, ready: false, closed: false, latest: message, retiredTurns: new Set(), sendAction, videoSource: null,
      videoLookup: null, cancelVideoLookup: null, videoEpoch: 0, videoFailures: 0, videoReadyAt: 0, videoRetry: null, ownerTimer: null,
      nativeId, nativeLive: false, nativeEpoch: 0, nativeBinding: null, lastNativePaint: 0,
      snapshotReady: false, snapshotEpoch: message.imageDataUrl ? 1 : 0, unavailableHidden: message.surface === 'computer',
      expanded: false, layoutManaged: true,
      cardSize: useNative ? nativeSize : windowPIP ? windowsSize : { width: 400, height: 280 },
      inset: windowPIP ? 24 : 0,
      hidden: inheritHidden || hiddenTasks.has(taskOf(message)) };
    if (windowPIP) window.setAspectRatio(windowsSize.width / windowsSize.height, { width: 24, height: 24 });
    window.on('will-move', () => { entry.layoutManaged = false; });
    window.on('will-resize', () => { entry.layoutManaged = false; });
    if (nativeId !== null && nativePIP) {
      window.webContents.on('paint', (_event, _dirty, image) => {
        if (entry.nativeId === null || image.isEmpty() || isClosed(entry)) return;
        // Mac computer snapshots are passed directly as verified image bytes.
        // Never overwrite them with a rendered page or a root-only video frame.
        if (entry.latest.surface === 'computer'
          && (platform === 'darwin' || entry.nativeLive || (!entry.snapshotReady && !entry.videoReadyAt))) return;
        const now = Date.now();
        if (now - entry.lastNativePaint < 80) return;
        entry.lastNativePaint = now;
        nativePIP.setImage(entry.nativeId, image.toPNG());
      });
      window.webContents.setFrameRate(15);
    }
    previewSession.setDisplayMediaRequestHandler?.((_request, callback) => {
      if (entry.videoSource && !isClosed(entry) && !entry.nativeLive) {
        const source = entry.videoSource;
        const epoch = entry.videoEpoch;
        void ownsVideoSource(entry,source).catch(() => false).then(owned => {
          if (owned && !isClosed(entry) && !entry.nativeLive
            && entry.videoSource === source && entry.videoEpoch === epoch) callback({video:source});
          else (callback as unknown as (streams:null)=>void)(null);
        });
      }
      // Electron documents null as the rejection response; its TypeScript type omits it.
      else (callback as unknown as (streams: null) => void)(null);
    });
    windows.set(key, entry);
    if (entry.hidden || entry.unavailableHidden) applyVisibility(entry);
    relayout();
    notifyVisibility();
    // The AppKit stream is independent of the hidden fallback page. Start it
    // as soon as the target is known, even while that page is loading.
    attachNativeWindow(entry);
    pushNativeSnapshot(entry);
    window.on('closed', () => releasePresentation(entry));
    const closeFailedPreview = () => {
      closePresentation(entry);
    };
    window.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame) return;
      console.error('Memmy Computer Use preview failed to load:', code, description);
      closeFailedPreview();
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      console.error('Memmy Computer Use preview renderer stopped:', details.reason);
      closeFailedPreview();
    });
    // Chromium error pages can emit did-finish-load. Only a successful loadFile
    // may mark this preview ready or display an always-on-top fallback window.
    void window.loadFile(join(import.meta.dirname, 'computer-use-surface.html'),
      useNative ? { query: { nativePip: '1' } }
        : windowPIP ? { query: { windowPip: '1' } } : undefined).then(() => {
          if (isClosed(entry)) return;
          entry.ready = true;
          attachNativeWindow(entry);
          pushNativeSnapshot(entry);
          render(entry);
          if (entry.nativeId === null && !entry.hidden && !entry.unavailableHidden) window.showInactive();
        }).catch(error => {
          console.error('Memmy Computer Use preview failed to load:', error);
          closeFailedPreview();
        });
    resolveVideo(entry);
  };
  const closeAll = () => {
    for (const entry of [...windows.values()]) {
      rememberCompletedTurn(entry.latest);
      closePresentation(entry);
    }
    windows.clear();
    hiddenTasks.clear();
    notifyVisibility();
  };
  const dispose = () => {
    closeAll();
    ipcMain.removeListener('memmy:computer-use-surface:interaction', receiveInteraction);
    ipcMain.removeListener('memmy:computer-use-surface:capture-ready', receiveCaptureReady);
    ipcMain.removeListener('memmy:computer-use-surface:snapshot-ready', receiveSnapshotReady);
    ipcMain.removeListener('memmy:computer-use-surface:capture-ended', receiveCaptureEnded);
    ipcMain.removeListener('memmy:computer-use-surface:hide', receiveHide);
    ipcMain.removeListener('memmy:computer-use-surface:expand', receiveExpand);
  };
  return { update, closeAll, dispose, hasHiddenActive, restoreAll };
}

function render(entry: SurfaceWindow): void {
  const { window, latest } = entry;
  if (isClosed(entry)) return;
  const unavailable = !entry.videoSource && entry.videoFailures > VIDEO_RETRY_DELAYS_MS.length;
  const popupSnapshot = entry.nativeId === null && (latest.targetAssociatedWindowIds?.length ?? 0) > 0;
  const source = entry.nativeLive ? null : entry.videoSource?.id ?? null;
  const script = `window.__memmySetSurface(${JSON.stringify(latest.title)},${JSON.stringify(latest.imageDataUrl ?? null)},${JSON.stringify(latest.surface)},${JSON.stringify(source)},${entry.videoEpoch},${Boolean(latest.turnId)},${unavailable},${entry.nativeLive},${entry.snapshotEpoch},${popupSnapshot})`;
  void window.webContents.executeJavaScript(script, Boolean(source)).catch(() => undefined);
}
