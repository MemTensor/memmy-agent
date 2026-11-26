import { app, BrowserWindow, ipcMain, nativeImage, screen, type IpcMainEvent, type NativeImage } from 'electron';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { PermissionPanel, PermissionPanelAction, PermissionPanelState } from './computer-use-onboarding.js';
import { computerUsePermissionHtml } from './computer-use-permission-view.js';
import { permissionPanelBounds, trustedComputerUseWindowWatcher, watchSystemSettingsWindow } from './computer-use-settings-window.js';

const CHANNEL = 'memmy:computer-use-permission-panel';

/** Select the production Memmy.app TCC client for every permission. */
export function permissionDragTarget(helperApp: string): string {
  const marker = '/Memmy.app/Contents/';
  const index = helperApp.indexOf(marker);
  if (index <= 0) return helperApp;
  return helperApp.slice(0, index + '/Memmy.app'.length);
}
let current: BrowserWindow | null = null;
export function isComputerUsePermissionPanelFocused(): boolean {
  return Boolean(current && !current.isDestroyed() && current.isVisible() && current.isFocused());
}

/** Local, sandboxed view with a narrowly scoped preload; no generic shell IPC. */
export function showComputerUsePermissionPanel(parent: BrowserWindow, initial: PermissionPanelState,
  act: (action: PermissionPanelAction) => void): PermissionPanel {
  if (current && !current.isDestroyed()) throw new Error('Permission panel already open');
  const area = screen.getDisplayMatching(parent.getBounds()).workArea;
  // The reference screenshot is Retina pixels; BrowserWindow uses logical points.
  const width = 545, height = 114;
  const window = new BrowserWindow({
    // This is an accessory for macOS System Settings, not a child of the
    // Memmy window.  Parenting it to Memmy makes AppKit hide/reorder the
    // guide when System Settings becomes active, which is exactly the case
    // the guide is meant to support.  Codex keeps this panel as an
    // independent floating window and follows the Settings window geometry.
    type: 'panel', width, height,
    x: Math.max(area.x + 6, area.x + area.width - width - 6), y: area.y + area.height - height - 7,
    frame: false, transparent: true, hasShadow: true, skipTaskbar: true,
    // Keep the accessory interactive even while System Settings owns the
    // active app. `showInactive()` must not turn the close control into a
    // decorative element.
    focusable: true, acceptFirstMouse: true,
    resizable: false, minimizable: false, maximizable: false,
    title: 'Memmy 权限', show: false, backgroundColor: '#00000000',
    webPreferences: { preload: join(import.meta.dirname, '../preload/computer-use-permission-preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  current = window;
  let disposed = false;
  const watcherBinary = trustedComputerUseWindowWatcher(initial.helperApp, app.isPackaged,
    process.resourcesPath, process.env.MEMMY_DEV_COMPUTER_USE_BINARY);
  const stopFollowing = watcherBinary ? watchSystemSettingsWindow(watcherBinary, frame => {
    if (disposed || !frame || window.isDestroyed()) return;
    const next = permissionPanelBounds(frame, screen.getDisplayMatching(frame).workArea);
    const currentBounds = window.getBounds();
    if (next.x !== currentBounds.x || next.y !== currentBounds.y
      || next.width !== currentBounds.width || next.height !== currentBounds.height) window.setBounds(next, false);
  }) : () => undefined;
  window.setMenu(null);
  window.setAlwaysOnTop(true, 'floating');
  // System Settings may be on another Space or enter full-screen while the
  // user grants the permission.  The Codex accessory remains available with
  // that Settings window, so keep the independent panel in the same window
  // collection instead of letting it disappear with Memmy's Space.
  window.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
  let state = initial, wasAway = false;
  // The owned gateway supplies this path. The renderer can only request a drag;
  // it cannot select a file or replace the helper with another installed copy.
  const helperApp = initial.helperApp;
  const dragTarget = permissionDragTarget(helperApp);
  let helperIcon: NativeImage | undefined;
  let dragError = '';
  const canDrag = () => Boolean(helperIcon && !state.busy && state.permissions.failure !== 'helperPauseFailed');
  const send = () => {
    if (!disposed && !window.isDestroyed()) window.webContents.send(`${CHANNEL}:state`, {
      ...state, helperApp, helperIcon: helperIcon?.toDataURL(), canDragHelper: canDrag(), dragError,
    });
  };
  const dragHelper = (event: IpcMainEvent) => {
    let started = false;
    try {
      if (disposed || window.isDestroyed() || !window.isVisible() || !canDrag() ||
          event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
      window.webContents.startDrag({ file: dragTarget, icon: helperIcon! });
      started = true;
    }
    catch {
      dragError = '暂时无法拖动，请在“遇到问题？”中复制程序路径。';
      send();
    }
    finally {
      // The preload uses sendSync so the native drag starts during dragstart.
      // Reply after startDrag, including rejected/failed gestures, or the
      // renderer stays blocked and can never handle the close button again.
      event.returnValue = started;
    }
  };
  // Resolve the icon ahead of the gesture; startDrag must run from dragstart.
  void stat(dragTarget).then(async info => {
    if (!info.isDirectory()) throw new Error('Helper app is unavailable');
    // Launch Services may cache a generic icon for a development installation.
    const iconFile = dragTarget === helperApp
      ? join(helperApp, 'Contents/Resources/MemmyComputerUse.icns')
      : join(dragTarget, 'Contents/Resources/icon.icns');
    const icon = await nativeImage.createThumbnailFromPath(iconFile, { width: 64, height: 64 })
      .catch(() => app.getFileIcon(dragTarget, { size: 'normal' }));
    if (disposed) return;
    if (icon.isEmpty()) throw new Error('Helper app icon is unavailable');
    helperIcon = icon; send();
  }).catch(() => {
    dragError = '暂时无法拖动，请在“遇到问题？”中复制程序路径。'; send();
  });
  const returned = () => {
    if (disposed || !wasAway || state.busy) return;
    wasAway = false; act('returned');
  };
  const parentFocused = () => {
    if (disposed || state.busy || !wasAway) return;
    window.show(); window.focus(); returned();
  };
  const closePanel = (event: IpcMainEvent) => {
    // This channel is exposed only by this panel's isolated preload. Keep the
    // sender check, but do not require a frame object here: on macOS an
    // inactive data: panel can report a transient frame wrapper while it is
    // becoming key, which used to make the visible close button a no-op.
    if (event.sender !== window.webContents) { event.returnValue = false; return; }
    event.returnValue = true;
    act('later');
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true; ipcMain.removeHandler(`${CHANNEL}:action`);
    stopFollowing();
    ipcMain.removeListener(`${CHANNEL}:close`, closePanel);
    ipcMain.removeListener(`${CHANNEL}:drag-helper`, dragHelper);
    parent.removeListener('focus', parentFocused);
    if (current === window) current = null;
  };
  ipcMain.on(`${CHANNEL}:close`, closePanel);
  ipcMain.on(`${CHANNEL}:drag-helper`, dragHelper);
  ipcMain.handle(`${CHANNEL}:action`, (event, action: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
    if (action === 'ready') { send(); return; }
    if (typeof action !== 'string' || !['accessibility', 'screenRecording', 'inputMonitoring', 'recheck', 'continue', 'later', 'copyPath'].includes(action)) return;
    act(action as PermissionPanelAction);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('blur', () => { if (!state.busy) wasAway = true; });
  window.on('focus', returned);
  parent.on('focus', parentFocused);
  window.on('closed', () => { dispose(); act('later'); });
  // System Settings is the active work surface during the drag. Showing this
  // accessory without activation avoids pulling Memmy in front of its list.
  window.once('ready-to-show', () => { if (!disposed) window.showInactive(); });
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(computerUsePermissionHtml(randomUUID()))}`)
    .catch(() => { act('later'); if (!window.isDestroyed()) window.destroy(); dispose(); });
  return {
    update(next) {
      state = next;
      send();
    },
    close() { dispose(); if (!window.isDestroyed()) window.destroy(); },
  };
}
