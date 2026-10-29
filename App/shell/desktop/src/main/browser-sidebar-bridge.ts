import { BrowserWindow, ipcMain, type WebContents } from 'electron';
import {
  isComputerUseSurfaceAction,
  type ComputerUseSurfaceAction,
  type ComputerUseSurfaceMessage,
} from '@memmy/local-api-contracts';
import type { BrowserHistoryStore } from './browser-history-store.js';

type BrowserSidebarAction = Pick<ComputerUseSurfaceAction, 'action' | 'x' | 'y' | 'deltaY' | 'key' | 'url'>;
type ActiveBrowserSurface = {
  message: ComputerUseSurfaceMessage;
  sendAction: (action: ComputerUseSurfaceAction) => void;
};

/** Exposes the Agent's existing browser page to the trusted main renderer. */
export function createBrowserSidebarBridge(
  getMainWindow: () => BrowserWindow | null,
  sendDirect: (action: ComputerUseSurfaceAction) => boolean = () => false,
  historyStore: BrowserHistoryStore | null = null,
  recordSurfaceHistory = true,
) {
  const surfaces = new Map<string, ActiveBrowserSurface>();
  const isMainRenderer = (sender: WebContents) => {
    const mainWindow = getMainWindow();
    return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents === sender);
  };
  const publish = (message: ComputerUseSurfaceMessage) => {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('memmy:browser-sidebar:surface', message);
    }
  };
  const getSurface = (event: Electron.IpcMainInvokeEvent, sessionKey: unknown) => {
    if (!isMainRenderer(event.sender)) throw new Error('Invalid browser sidebar request');
    if (typeof sessionKey !== 'string' || !sessionKey || sessionKey.length > 256) return null;
    return surfaces.get(sessionKey)?.message ?? null;
  };
  const sendAction = (event: Electron.IpcMainInvokeEvent, sessionKey: unknown, input: unknown) => {
    if (!isMainRenderer(event.sender)) throw new Error('Invalid browser sidebar request');
    if (typeof sessionKey !== 'string' || !sessionKey || sessionKey.length > 256) return false;
    const surface = surfaces.get(sessionKey);
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    if (Object.keys(input).some(key => !['action', 'x', 'y', 'deltaY', 'key', 'url'].includes(key))) return false;
    const command = input as BrowserSidebarAction;
    if (!surface && command.action !== 'navigate') return false;
    const identity = surface?.message ?? {
      sessionKey, channel: 'projected-session', chatId: sessionKey, targetId: 'active-tab',
    };
    const action: ComputerUseSurfaceAction = {
      type: 'memmy:computer-use-surface:action', surface: 'browser',
      sessionKey: identity.sessionKey, channel: identity.channel,
      chatId: identity.chatId, targetId: identity.targetId,
      action: command.action,
      ...(command.x !== undefined ? { x: command.x } : {}),
      ...(command.y !== undefined ? { y: command.y } : {}),
      ...(command.deltaY !== undefined ? { deltaY: command.deltaY } : {}),
      ...(command.key !== undefined ? { key: command.key } : {}),
      ...(command.url !== undefined ? { url: command.url } : {}),
    };
    if (!isComputerUseSurfaceAction(action)) return false;
    if (surface) { surface.sendAction(action); return true; }
    return sendDirect(action);
  };
  ipcMain.handle('memmy:browser-sidebar:get', getSurface);
  ipcMain.handle('memmy:browser-sidebar:action', sendAction);
  ipcMain.handle('memmy:browser-sidebar:history', event => {
    if (!isMainRenderer(event.sender)) throw new Error('Invalid browser history request');
    return historyStore?.list() ?? [];
  });
  ipcMain.handle('memmy:browser-sidebar:history-remove', (event, url: unknown) => {
    if (!isMainRenderer(event.sender)) throw new Error('Invalid browser history request');
    if (typeof url !== 'string' || url.length > 4096) return false;
    return historyStore?.remove(url) ?? false;
  });
  ipcMain.handle('memmy:browser-sidebar:history-remove-selected', (event, urls: unknown) => {
    if (!isMainRenderer(event.sender)) throw new Error('Invalid browser history request');
    return historyStore?.removeSelected(urls) ?? 0;
  });
  ipcMain.handle('memmy:browser-sidebar:history-import-legacy', (event, entries: unknown) => {
    if (!isMainRenderer(event.sender)) throw new Error('Invalid browser history request');
    return historyStore?.importLegacy(entries) ?? false;
  });
  return {
    update(message: ComputerUseSurfaceMessage, send: (action: ComputerUseSurfaceAction) => void) {
      if (message.surface !== 'browser') return;
      if (message.type.endsWith(':close') && message.presentationOnly) return;
      try { if (recordSurfaceHistory) historyStore?.record(message); }
      catch { /* History disk errors cannot interrupt browser control. */ }
      if (message.type.endsWith(':close')) {
        surfaces.delete(message.sessionKey);
      } else {
        const previous = surfaces.get(message.sessionKey)?.message;
        if (message.error && !message.imageDataUrl && previous?.imageDataUrl) {
          message = { ...message, imageDataUrl: previous.imageDataUrl };
        }
        surfaces.set(message.sessionKey, { message, sendAction: send });
      }
      publish(message);
    },
    clear() {
      for (const surface of surfaces.values()) {
        publish({ ...surface.message, type: 'memmy:computer-use-surface:close', imageDataUrl: undefined });
      }
      surfaces.clear();
    },
    clearHistory() { historyStore?.clear(); },
    fill(sessionKey: string, action: 'fill-credential' | 'fill-contact', autofill: ComputerUseSurfaceAction['autofill']): boolean {
      const surface = surfaces.get(sessionKey);
      if (!surface || !autofill) return false;
      const message = surface.message;
      try { if (new URL(message.url ?? '').origin !== autofill.origin) return false; }
      catch { return false; }
      const command: ComputerUseSurfaceAction = { type: 'memmy:computer-use-surface:action', surface: 'browser',
        sessionKey: message.sessionKey, channel: message.channel, chatId: message.chatId,
        targetId: message.targetId, action, autofill };
      if (!isComputerUseSurfaceAction(command)) return false;
      surface.sendAction(command);
      return true;
    },
    dispose() {
      surfaces.clear();
      ipcMain.removeHandler('memmy:browser-sidebar:get');
      ipcMain.removeHandler('memmy:browser-sidebar:action');
      ipcMain.removeHandler('memmy:browser-sidebar:history');
      ipcMain.removeHandler('memmy:browser-sidebar:history-remove');
      ipcMain.removeHandler('memmy:browser-sidebar:history-remove-selected');
      ipcMain.removeHandler('memmy:browser-sidebar:history-import-legacy');
    },
  };
}
