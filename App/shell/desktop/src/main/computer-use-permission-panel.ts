import { app, BrowserWindow, ipcMain, nativeImage, type IpcMainEvent, type NativeImage } from 'electron';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { PermissionPanel, PermissionPanelAction, PermissionPanelState } from './computer-use-onboarding.js';
import { computerUsePermissionHtml } from './computer-use-permission-view.js';

const CHANNEL = 'memmy:computer-use-permission-panel';
let current: BrowserWindow | null = null;
export function isComputerUsePermissionPanelFocused(): boolean {
  return Boolean(current && !current.isDestroyed() && current.isVisible() && current.isFocused());
}

/** Local, sandboxed view with a narrowly scoped preload; no generic shell IPC. */
export function showComputerUsePermissionPanel(parent: BrowserWindow, initial: PermissionPanelState,
  act: (action: PermissionPanelAction) => void): PermissionPanel {
  if (current && !current.isDestroyed()) throw new Error('Permission panel already open');
  const window = new BrowserWindow({
    parent, width: 540, height: 620, resizable: false, minimizable: false, maximizable: false,
    title: '启用 Open Computer Use', show: false, backgroundColor: '#f8faf9',
    webPreferences: { preload: join(import.meta.dirname, '../preload/computer-use-permission-preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  current = window;
  window.setMenu(null);
  let state = initial, disposed = false, wasAway = false;
  // The owned gateway supplies this path. The renderer can only request a drag;
  // it cannot select a file or replace the helper with another installed copy.
  const helperApp = initial.helperApp;
  let helperIcon: NativeImage | undefined;
  let dragError = '';
  const canDrag = () => Boolean(helperIcon && !state.busy && state.permissions.failure !== 'helperPauseFailed');
  const send = () => {
    if (!disposed && !window.isDestroyed()) window.webContents.send(`${CHANNEL}:state`, {
      ...state, helperApp, helperIcon: helperIcon?.toDataURL(), canDragHelper: canDrag(), dragError,
    });
  };
  const dragHelper = (event: IpcMainEvent) => {
    if (disposed || window.isDestroyed() || !window.isVisible() || !canDrag() ||
        event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
    try { window.webContents.startDrag({ file: helperApp, icon: helperIcon! }); }
    catch {
      dragError = '暂时无法拖动，请在“遇到问题？”中复制程序路径。';
      send();
    }
  };
  // Resolve the icon ahead of the gesture; startDrag must run from dragstart.
  void stat(helperApp).then(async info => {
    if (!info.isDirectory()) throw new Error('Helper app is unavailable');
    // Launch Services may cache a generic icon for a development installation.
    // Read the unchanged npm bundle's own icon; fall back if its layout changes.
    const icon = await nativeImage.createThumbnailFromPath(
      join(helperApp, 'Contents/Resources/OpenComputerUse.icns'), { width: 64, height: 64 },
    ).catch(() => app.getFileIcon(helperApp, { size: 'normal' }));
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
  const dispose = () => {
    if (disposed) return;
    disposed = true; ipcMain.removeHandler(`${CHANNEL}:action`);
    ipcMain.removeListener(`${CHANNEL}:drag-helper`, dragHelper);
    parent.removeListener('focus', parentFocused);
    if (current === window) current = null;
  };
  ipcMain.on(`${CHANNEL}:drag-helper`, dragHelper);
  ipcMain.handle(`${CHANNEL}:action`, (event, action: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
    if (action === 'ready') { send(); return; }
    if (typeof action !== 'string' || !['accessibility', 'screenRecording', 'recheck', 'continue', 'later', 'copyPath'].includes(action)) return;
    if ((action === 'accessibility' || action === 'screenRecording') && !state.busy &&
        state.permissions.failure !== 'helperPauseFailed') {
      // Keep the drag source reachable without changing the user's window position.
      window.setAlwaysOnTop(true, 'floating');
    }
    act(action as PermissionPanelAction);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('blur', () => { if (!state.busy) wasAway = true; });
  window.on('focus', returned);
  parent.on('focus', parentFocused);
  window.on('closed', () => { dispose(); act('later'); });
  window.once('ready-to-show', () => { if (!disposed) { window.show(); window.focus(); } });
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(computerUsePermissionHtml(randomUUID()))}`)
    .catch(() => { act('later'); if (!window.isDestroyed()) window.destroy(); dispose(); });
  return {
    update(next) {
      state = next;
      if (state.busy && !window.isDestroyed()) window.setAlwaysOnTop(false);
      send();
    },
    close() { dispose(); if (!window.isDestroyed()) window.destroy(); },
  };
}
