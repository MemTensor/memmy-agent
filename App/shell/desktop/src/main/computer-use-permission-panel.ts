import { BrowserWindow, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
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
    parent, width: 540, height: 510, resizable: false, minimizable: false, maximizable: false,
    title: '启用 Open Computer Use', show: false, backgroundColor: '#f8faf9',
    webPreferences: { preload: join(import.meta.dirname, '../preload/computer-use-permission-preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  current = window;
  window.setMenu(null);
  let state = initial, disposed = false, wasAway = false;
  const send = () => { if (!window.isDestroyed()) window.webContents.send(`${CHANNEL}:state`, state); };
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
    disposed = true; ipcMain.removeHandler(`${CHANNEL}:action`); parent.removeListener('focus', parentFocused);
    if (current === window) current = null;
  };
  ipcMain.handle(`${CHANNEL}:action`, (event, action: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
    if (action === 'ready') { send(); return; }
    if (typeof action !== 'string' || !['accessibility', 'screenRecording', 'recheck', 'continue', 'later', 'copyPath'].includes(action)) return;
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
    update(next) { state = next; send(); },
    close() { dispose(); if (!window.isDestroyed()) window.destroy(); },
  };
}
