import { expect, it, vi } from 'vitest';
import { createBrowserSidebarBridge } from '../src/main/browser-sidebar-bridge.js';

const state = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => unknown>() }));
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((name: string, handler: (...args: any[]) => unknown) => state.handlers.set(name, handler)),
    removeHandler: vi.fn((name: string) => state.handlers.delete(name)),
  },
}));

it('routes only the current session through the trusted main renderer', () => {
  const send = vi.fn();
  const webContents = { send: vi.fn() };
  const bridge = createBrowserSidebarBridge(() => ({ webContents, isDestroyed: () => false }) as any);
  const message = { type: 'memmy:computer-use-surface:update', surface: 'browser',
    sessionKey: 'session-a', channel: 'projected-session', chatId: 'session-a',
    targetId: 'active-tab', title: 'Example', imageDataUrl: 'data:image/jpeg;base64,YWJj' } as const;
  bridge.update(message, send);
  expect(webContents.send).toHaveBeenCalledWith('memmy:browser-sidebar:surface', message);
  const get = state.handlers.get('memmy:browser-sidebar:get')!;
  const action = state.handlers.get('memmy:browser-sidebar:action')!;
  expect(get({ sender: webContents }, 'session-a')).toEqual(message);
  expect(get({ sender: webContents }, 'session-b')).toBeNull();
  expect(() => get({ sender: {} }, 'session-a')).toThrow('Invalid browser sidebar request');
  expect(action({ sender: webContents }, 'session-b', { action: 'open' })).toBe(false);
  expect(action({ sender: webContents }, 'session-a', { action: 'click', x: 0.5, y: 0.25, chatId: 'spoofed' })).toBe(false);
  expect(action({ sender: webContents }, 'session-a', { action: 'open' })).toBe(true);
  expect(send).toHaveBeenCalledWith({ type: 'memmy:computer-use-surface:action',
    surface: 'browser', sessionKey: 'session-a', channel: 'projected-session',
    chatId: 'session-a', targetId: 'active-tab', action: 'open' });
  bridge.update({ ...message, type: 'memmy:computer-use-surface:close', presentationOnly: true }, send);
  expect(get({ sender: webContents }, 'session-a')).toEqual(message);
  expect(webContents.send).toHaveBeenCalledTimes(1);
  bridge.clear();
  expect(get({ sender: webContents }, 'session-a')).toBeNull();
  bridge.dispose();
});

it('starts a browser session through the managed Agent without an existing frame', () => {
  const webContents = { send: vi.fn() };
  const direct = vi.fn(() => true);
  const bridge = createBrowserSidebarBridge(() => ({ webContents, isDestroyed: () => false }) as any, direct);
  const action = state.handlers.get('memmy:browser-sidebar:action')!;
  expect(action({ sender: webContents }, 'session-a', { action: 'back' })).toBe(false);
  expect(action({ sender: webContents }, 'session-a', { action: 'navigate', url: 'javascript:alert(1)' })).toBe(false);
  expect(action({ sender: webContents }, 'session-a', { action: 'navigate', url: 'https://example.com/' })).toBe(true);
  expect(direct).toHaveBeenCalledWith({ type: 'memmy:computer-use-surface:action',
    surface: 'browser', sessionKey: 'session-a', channel: 'projected-session',
    chatId: 'session-a', targetId: 'active-tab', action: 'navigate', url: 'https://example.com/' });
  bridge.dispose();
});

it('exposes managed history only to the main renderer', () => {
  const webContents = { send: vi.fn() };
  const history = { list: vi.fn(() => [{ url: 'https://example.com/', title: 'Example', visitedAt: 1 }]),
    record: vi.fn(), remove: vi.fn(() => true), clear: vi.fn() };
  const bridge = createBrowserSidebarBridge(() => ({ webContents, isDestroyed: () => false }) as any,
    () => false, history as any);
  const get = state.handlers.get('memmy:browser-sidebar:history')!;
  const remove = state.handlers.get('memmy:browser-sidebar:history-remove')!;
  expect(() => get({ sender: {} })).toThrow('Invalid browser history request');
  expect(get({ sender: webContents })).toHaveLength(1);
  expect(remove({ sender: webContents }, 'https://example.com/')).toBe(true);
  bridge.clearHistory();
  expect(history.clear).toHaveBeenCalledOnce();
  bridge.dispose();
});

it('keeps the in-app history store free of projected browser surface records', () => {
  const webContents = { send: vi.fn() };
  const history = { list: vi.fn(() => []), record: vi.fn(), remove: vi.fn(), clear: vi.fn() };
  const bridge = createBrowserSidebarBridge(() => ({ webContents, isDestroyed: () => false }) as any,
    () => false, history as any, false);
  bridge.update({ type: 'memmy:computer-use-surface:update', surface: 'browser',
    sessionKey: 'task', channel: 'projected-session', chatId: 'task',
    targetId: 'active-tab', title: 'External', url: 'https://external.example/' } as const, vi.fn());
  expect(history.record).not.toHaveBeenCalled();
  expect(state.handlers.get('memmy:browser-sidebar:history')!({ sender: webContents })).toEqual([]);
  bridge.dispose();
});

it('accepts legacy history imports only from the trusted main renderer', () => {
  const webContents = { send: vi.fn() };
  const history = { list: vi.fn(() => []), importLegacy: vi.fn(() => true), record: vi.fn(), remove: vi.fn(), clear: vi.fn() };
  const bridge = createBrowserSidebarBridge(() => ({ webContents, isDestroyed: () => false }) as any,
    () => false, history as any, false);
  const importLegacy = state.handlers.get('memmy:browser-sidebar:history-import-legacy')!;
  const entries = [{ url: 'https://example.com/', title: 'Example', visitedAt: 1 }];
  expect(() => importLegacy({ sender: {} }, entries)).toThrow('Invalid browser history request');
  expect(history.importLegacy).not.toHaveBeenCalled();
  expect(importLegacy({ sender: webContents }, entries)).toBe(true);
  expect(history.importLegacy).toHaveBeenCalledWith(entries);
  bridge.dispose();
});

it('removes selected history only through the trusted main renderer', () => {
  const webContents = { send: vi.fn() };
  const history = { list: vi.fn(() => []), removeSelected: vi.fn(() => 2), record: vi.fn(), remove: vi.fn(), clear: vi.fn() };
  const bridge = createBrowserSidebarBridge(() => ({ webContents, isDestroyed: () => false }) as any,
    () => false, history as any, false);
  const remove = state.handlers.get('memmy:browser-sidebar:history-remove-selected')!;
  const urls = ['https://a.example/', 'https://b.example/'];
  expect(() => remove({ sender: {} }, urls)).toThrow('Invalid browser history request');
  expect(remove({ sender: webContents }, urls)).toBe(2);
  expect(history.removeSelected).toHaveBeenCalledWith(urls);
  bridge.dispose();
});

it('keeps the last frame on navigation failure and restricts autofill to the current origin', () => {
  const send = vi.fn();
  const webContents = { send: vi.fn() };
  const bridge = createBrowserSidebarBridge(() => ({ webContents, isDestroyed: () => false }) as any);
  const message = { type: 'memmy:computer-use-surface:update', surface: 'browser',
    sessionKey: 'task', channel: 'projected-session', chatId: 'task', targetId: 'active-tab',
    title: 'Example', url: 'https://example.com/login', imageDataUrl: 'data:image/jpeg;base64,YWJj' } as const;
  bridge.update(message, send);
  bridge.update({ ...message, imageDataUrl: undefined, error: 'access-blocked' }, send);
  expect(webContents.send).toHaveBeenLastCalledWith('memmy:browser-sidebar:surface',
    expect.objectContaining({ error: 'access-blocked', imageDataUrl: message.imageDataUrl }));
  expect(bridge.fill('task', 'fill-credential', { origin: 'https://other.example',
    username: 'alice', password: 'secret' })).toBe(false);
  expect(bridge.fill('task', 'fill-credential', { origin: 'https://example.com',
    username: 'alice', password: 'secret' })).toBe(true);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ action: 'fill-credential',
    autofill: { origin: 'https://example.com', username: 'alice', password: 'secret' } }));
  bridge.dispose();
});
