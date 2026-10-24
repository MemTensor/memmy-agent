import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserSessionManager } from '../../../../src/core/agent-runtime/tools/browser.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

it.each([false, true])('binds a known download path to the selected tab/action and clears it when the action fails=%s', async fails => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-known-input-')); roots.push(root);
  const scope = { sessionKey: 'task', channel: 'projected-session', chatId: 'task' };
  const claim = { connectionId: 'memmy-webview', tabId: 27, browser: 'memmy',
    title: 'Report', url: 'https://example.com/report', claimedAt: 1 };
  const sequence: unknown[] = [];
  const router: any = { hasBinding: () => true, select: () => claim, closeAll: vi.fn(),
    setDownloadDestination: vi.fn(async (...args) => { sequence.push(args[2]); }),
    waitDownloadDestination: vi.fn(async () => { sequence.push('started'); return { started: true }; }),
    call: vi.fn(async (_scope, _claim, _name, params) => {
      sequence.push('action'); expect(params).toEqual({ target: '#download' });
      if (fails) throw new Error('action failed');
      return [{ type: 'text', text: '{}' }];
    }) };
  const manager = new BrowserSessionManager({}, { desktopManaged: true,
    embeddedBridge: { refresh: async () => claim, close: vi.fn() } as any,
    embeddedRouter: router, externalRouter: null });
  const destination = path.join(root, '用户报告.pdf');
  try {
    const operation = manager.callTool(scope, 'browser_click', { target: '#download', downloadPath: destination });
    if (fails) await expect(operation).rejects.toThrow('action failed'); else await operation;
    expect(sequence).toEqual(fails ? [destination, 'action', null] : [destination, 'action', 'started', null]);
    expect(router.setDownloadDestination.mock.calls[0][3]).toBe(router.setDownloadDestination.mock.calls[1][3]);
    await expect(manager.callTool(scope, 'browser_navigate', { url: 'https://example.com', newTab: true,
      downloadPath: destination })).rejects.toThrow(/existing browser tab/);
  } finally { await manager.close(); }
});


it('keeps an in-app destination active after an action returns until that download starts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-late-download-')); roots.push(root);
  const scope = { sessionKey: 'late', channel: 'projected-session', chatId: 'late' };
  const claim = { connectionId: 'memmy-webview', tabId: 27, browser: 'memmy',
    title: 'Report', url: 'https://example.com/report', claimedAt: 1 };
  let start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const router: any = { hasBinding: () => true, select: () => claim, closeAll: vi.fn(),
    setDownloadDestination: vi.fn(async () => undefined),
    waitDownloadDestination: vi.fn(async () => { await started; return { started: true }; }),
    call: vi.fn(async () => [{ type: 'text', text: '{}' }]) };
  const manager = new BrowserSessionManager({}, { desktopManaged: true,
    embeddedBridge: { refresh: async () => claim, close: vi.fn() } as any,
    embeddedRouter: router, externalRouter: null });
  let returned = false;
  try {
    const operation = manager.callTool(scope, 'browser_click', { target: '#download',
      downloadPath: path.join(root, 'late.pdf') }).then(result => { returned = true; return result; });
    await vi.waitFor(() => expect(router.waitDownloadDestination).toHaveBeenCalledOnce());
    expect(returned).toBe(false);
    expect(router.setDownloadDestination).toHaveBeenCalledTimes(1);
    start(); await operation;
    expect(returned).toBe(true);
    expect(router.setDownloadDestination.mock.calls[1][2]).toBeNull();
  } finally { await manager.close(); }
});
