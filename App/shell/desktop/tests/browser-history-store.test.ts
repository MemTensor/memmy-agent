import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { BrowserHistoryStore, parseBrowserHistoryQuery } from '../src/main/browser-history-store.js';
import { queryInAppBrowserHistory } from '../src/main/browser-history-access.js';
import { EMBEDDED_BROWSER_REQUEST } from '@memmy/local-api-contracts';
import { vi } from 'vitest';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('keeps Agent navigation history across sidebar and desktop restarts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-browser-history-'));
  roots.push(root);
  const filePath = path.join(root, 'browser-history.json');
  const store = new BrowserHistoryStore(filePath);
  const message = { type: 'memmy:computer-use-surface:update' as const, surface: 'browser' as const,
    sessionKey: 'task', channel: 'projected-session', chatId: 'task', targetId: 'active-tab',
    title: 'Example', url: 'https://example.com/' };
  store.record(message);
  store.record(message);
  expect(store.list()).toHaveLength(1);
  expect(new BrowserHistoryStore(filePath).list()[0]?.url).toBe('https://example.com/');
  store.record({ ...message, url: 'https://example.com/next' });
  expect(store.list().map(entry => entry.url)).toEqual(['https://example.com/next', 'https://example.com/']);
  expect(store.remove('https://example.com/')).toBe(true);
  store.clear();
  expect(fs.existsSync(filePath)).toBe(false);
});

it('requires a bounded keyword and date range before a host-approved read', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-in-app-history-'));
  roots.push(root);
  const store = new BrowserHistoryStore(path.join(root, 'in-app-browser-history.json'));
  const now = Date.now();
  store.recordVisit('webview-1', 'https://example.com/a', 'Example Alpha', now - 10_000);
  store.recordVisit('webview-1', 'https://example.org/b', 'Other', now - 5_000);
  const request = { type: EMBEDDED_BROWSER_REQUEST, requestId: 'test', command: 'queryHistory' as const,
    args: { from: new Date(now - 20_000).toISOString(), to: new Date(now).toISOString(),
      keyword: 'example', limit: 20 } };
  const approve = vi.fn(async () => false);
  await expect(queryInAppBrowserHistory(store, request, approve)).rejects.toThrow(/denied/);
  expect(approve).toHaveBeenCalledOnce();
  approve.mockResolvedValue(true);
  expect(await queryInAppBrowserHistory(store, request, approve)).toMatchObject({ entries: [
    { id: expect.any(String), url: 'https://example.org/b', title: 'Other', visitedAt: now - 5_000, visitSource: 'other' },
    { id: expect.any(String), url: 'https://example.com/a', title: 'Example Alpha', visitedAt: now - 10_000, visitSource: 'other' },
  ] });
  approve.mockClear();
  await expect(queryInAppBrowserHistory(store, { ...request, args: { ...request.args, keyword: '' } }, approve))
    .rejects.toThrow(/Invalid/);
  expect(approve).not.toHaveBeenCalled();
  expect(parseBrowserHistoryQuery({ ...request.args, from: new Date(now - 31 * 86400_000).toISOString() }, now))
    .toBeNull();
  expect(store.remove('https://example.com/a')).toBe(true);
  expect(store.query({ from: now - 20_000, to: now, keyword: 'alpha', limit: 20 })).toEqual([]);
  store.clear();
  expect(store.query({ from: now - 20_000, to: now, keyword: 'example', limit: 20 })).toEqual([]);
});

it('migrates only bounded in-app legacy visits and keeps newer host visits', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-history-upgrade-'));
  roots.push(root);
  const filePath = path.join(root, 'in-app-browser-history.json');
  const store = new BrowserHistoryStore(filePath);
  store.recordVisit('webview-1', 'https://example.com/', 'New title', 300);
  const old = [
    { url: 'https://example.com/', title: 'Old title', visitedAt: 100 },
    { url: 'https://archive.example/', title: 'Archive', visitedAt: 200 },
    { url: 'https://archive.example/', title: 'Older duplicate', visitedAt: 150 },
  ];
  expect(store.importLegacy(old)).toBe(true);
  expect(store.list()).toMatchObject([
    { url: 'https://example.com/', title: 'New title', visitedAt: 300, visitSource: 'other' },
    { url: 'https://archive.example/', title: 'Archive', visitedAt: 200, visitSource: 'other' },
    { url: 'https://example.com/', title: 'Old title', visitedAt: 100, visitSource: 'other' },
  ]);
  expect(store.importLegacy(old)).toBe(true);
  expect(new BrowserHistoryStore(filePath).list()).toEqual(store.list());
  expect(store.importLegacy([{ url: 'file:///private', title: 'Invalid', visitedAt: 400 }])).toBe(false);
  expect(store.importLegacy([{ url: 'https://large.example/', title: 'x'.repeat(257), visitedAt: 400 }])).toBe(false);
  expect(store.importLegacy(Array.from({ length: 501 }, (_, i) => ({ url: `https://example.com/${i}`, title: 'x', visitedAt: i })))).toBe(false);
  expect(store.list()).toHaveLength(3);
  store.clear();
  expect(store.query({ from: 0, to: 500, keyword: 'archive', limit: 50 })).toEqual([]);
});

it('stores visit provenance and removes selected URLs from the same Agent query index', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-history-source-'));
  roots.push(root);
  const store = new BrowserHistoryStore(path.join(root, 'in-app-browser-history.json'));
  store.recordVisit('user-tab', 'https://other.example/', 'Other', 100, 'other');
  store.recordVisit('agent-tab', 'https://agent.example/', 'Agent', 200, 'agent');
  expect(store.list().map(item => item.visitSource)).toEqual(['agent', 'other']);
  expect(store.removeSelected(['https://agent.example/', 'https://other.example/'])).toBe(2);
  expect(store.query({ from: 0, to: 300, keyword: 'example', limit: 50 })).toEqual([]);
  expect(store.removeSelected(['file:///private'])).toBe(0);
});

it('keeps repeated visits separate and deletes only the selected visit ID', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-history-revisit-'));
  roots.push(root);
  const filePath = path.join(root, 'history.json');
  const store = new BrowserHistoryStore(filePath);
  store.recordVisit('tab', 'https://example.com/', 'First', 100, 'other');
  store.recordVisit('tab', 'https://elsewhere.example/', 'Elsewhere', 200, 'other');
  store.recordVisit('tab', 'https://example.com/', 'Second', 300, 'agent');
  const visits = store.list().filter(entry => entry.url === 'https://example.com/');
  expect(visits).toHaveLength(2);
  expect(visits.map(entry => entry.visitSource)).toEqual(['agent', 'other']);
  expect(visits[0]?.id).not.toBe(visits[1]?.id);
  store.reviseLatestVisit('tab', 'https://example.com/', 'Second title', 'agent');
  expect(store.list()[0]?.title).toBe('Second title');
  expect(store.remove(visits[0]!.id!)).toBe(true);
  expect(store.list().filter(entry => entry.url === 'https://example.com/')).toHaveLength(1);
  expect(new BrowserHistoryStore(filePath).list().filter(entry => entry.url === 'https://example.com/'))
    .toHaveLength(1);
});
