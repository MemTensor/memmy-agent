import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DownloadItem, Session } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserDownloadCatalog } from '../src/main/browser-download-catalog.js';
import { BrowserDownloadSettings } from '../src/main/browser-download-settings.js';
import { attachBrowserWebviewDownloads, BrowserWebviewDownloads } from '../src/main/browser-webview-downloads.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function download(filename: string) {
  let saved = '';
  let dialogDefault = '';
  let paused = false;
  let received = 0;
  let total = 100;
  const emitter = Object.assign(new EventEmitter(), {
    getFilename: () => filename,
    getURL: () => 'https://example.com/report.txt',
    getSavePath: () => saved,
    setSavePath: (value: string) => { saved = value; },
    setSaveDialogOptions: (value: { defaultPath: string }) => { dialogDefault = value.defaultPath; },
    getReceivedBytes: () => received,
    getTotalBytes: () => total,
    isPaused: () => paused,
    canResume: () => paused,
    pause: () => { paused = true; },
    resume: () => { paused = false; },
    cancel: () => { emitter.emit('done', {}, 'cancelled'); },
  });
  return { item: emitter as unknown as DownloadItem,
    progress: (bytes: number, totalBytes = 100) => {
      received = bytes; total = totalBytes; emitter.emit('updated', {}, 'progressing');
    },
    finish: (state: string, chosen?: string) => {
      if (chosen) saved = chosen;
      if (state === 'completed') { fs.mkdirSync(path.dirname(saved), { recursive: true }); fs.writeFileSync(saved, 'data'); }
      emitter.emit('done', {}, state);
    },
    saved: () => saved, dialogDefault: () => dialogDefault };
}

it('records a completed embedded-browser download without adding it to the Agent catalog', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-webview-download-'));
  roots.push(root);
  const session = new EventEmitter();
  const dispose = attachBrowserWebviewDownloads(session as unknown as Session, root);
  const current = download('report.txt');
  session.emit('will-download', {}, current.item);
  expect(current.saved()).toContain('webview-downloads');
  current.finish('completed');
  const webview = new BrowserDownloadCatalog(root, 'webview');
  expect(webview.list()).toMatchObject([{ name: 'report.txt', url: 'https://example.com/report.txt' }]);
  expect(new BrowserDownloadCatalog(root).list()).toEqual([]);
  dispose();
  expect(session.listenerCount('will-download')).toBe(0);
});

it('records a folder chosen in the native save dialog and keeps cancelled history', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-webview-download-'));
  roots.push(root);
  const chosen = path.join(root, 'chosen');
  fs.mkdirSync(chosen);
  new BrowserDownloadSettings(root).setAskBeforeDownload(true);
  const session = new EventEmitter();
  attachBrowserWebviewDownloads(session as unknown as Session, root);
  const cancelled = download('cancelled.txt');
  session.emit('will-download', {}, cancelled.item);
  cancelled.finish('cancelled');
  const current = download('report.txt');
  session.emit('will-download', {}, current.item);
  expect(current.saved()).toBe('');
  expect(current.dialogDefault()).toContain('webview-downloads');
  current.finish('completed', path.join(chosen, 'report.txt'));
  const catalog = new BrowserDownloadCatalog(root, 'webview');
  expect(catalog.list()).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'report.txt', rootDirectory: chosen, status: 'complete' }),
    expect.objectContaining({ name: 'cancelled.txt', status: 'canceled', fileExists: false }),
  ]));
  expect(new BrowserDownloadSettings(root).read().approvedDirectories).toContain(chosen);
});

it('publishes progress and controls only live webview downloads by ID', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-webview-download-'));
  roots.push(root);
  const session = new EventEmitter();
  const updates: Array<ReturnType<BrowserWebviewDownloads['list']>> = [];
  const manager = new BrowserWebviewDownloads(session as unknown as Session, root, entries => updates.push(entries));
  const current = download('active.txt');
  session.emit('will-download', {}, current.item);
  const id = manager.list()[0]!.id;
  expect(manager.list()[0]).toMatchObject({ status: 'started', canPause: true, canCancel: true });
  current.progress(40);
  expect(manager.list()[0]).toMatchObject({ status: 'in_progress', receivedBytes: 40, totalBytes: 100 });
  expect(manager.control(id, 'pause')).toBe(true);
  expect(manager.list()[0]).toMatchObject({ status: 'paused', canResume: true });
  expect(manager.control(id, 'pause')).toBe(false);
  expect(manager.control(id, 'resume')).toBe(true);
  expect(manager.list()[0]).toMatchObject({ status: 'in_progress' });
  expect(manager.control('invalid', 'cancel')).toBe(false);
  expect(manager.control(id, 'cancel')).toBe(true);
  expect(manager.list()[0]).toMatchObject({ id, status: 'canceled', fileExists: false });
  expect(new BrowserDownloadCatalog(root, 'webview').list()[0]?.status).toBe('canceled');
  expect(updates.some(entries => entries[0]?.status === 'paused')).toBe(true);
  manager.dispose();
});

it('persists a failed download without a saved file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-webview-download-'));
  roots.push(root);
  const session = new EventEmitter();
  const manager = new BrowserWebviewDownloads(session as unknown as Session, root);
  const current = download('failed.txt');
  session.emit('will-download', {}, current.item);
  current.finish('interrupted');
  expect(manager.list()[0]).toMatchObject({ name: 'failed.txt', status: 'failed', fileExists: false });
  manager.dispose();
});

it('uses a task destination for only its tab and action, without a save picker', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-webview-download-'));
  roots.push(root);
  new BrowserDownloadSettings(root).setAskBeforeDownload(true);
  const session = new EventEmitter();
  const manager = new BrowserWebviewDownloads(session as unknown as Session, root);
  const destination = path.join(root, '用户指定报告.txt');
  const destinationId = 'b3d0d156-6d48-4f27-a4cc-d629944236cf';
  manager.setDestination(27, destination, destinationId, () => true);
  const other = download('other.txt');
  session.emit('will-download', {}, other.item, { id: 99 });
  expect(other.saved()).toBe('');
  const target = download('server-name.txt');
  session.emit('will-download', {}, target.item, { id: 27 });
  expect(target.saved()).toBe(destination);
  expect(target.dialogDefault()).toBe('');
  const next = download('next.txt');
  session.emit('will-download', {}, next.item, { id: 27 });
  expect(next.saved()).toBe('');
  manager.dispose();
});

it('does not use cancelled, stale or replaced task destinations or overwrite an existing file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-webview-download-'));
  roots.push(root);
  new BrowserDownloadSettings(root).setAskBeforeDownload(true);
  const session = new EventEmitter();
  const manager = new BrowserWebviewDownloads(session as unknown as Session, root);
  const destination = path.join(root, 'report.txt');
  manager.setDestination(27, destination, 'first', () => false);
  const stale = download('stale.txt');
  session.emit('will-download', {}, stale.item, { id: 27 });
  expect(stale.saved()).toBe('');
  manager.setDestination(27, destination, 'second', () => true);
  manager.setDestination(27, null, 'first', () => false);
  const current = download('current.txt');
  session.emit('will-download', {}, current.item, { id: 27 });
  expect(current.saved()).toBe(destination);
  manager.setDestination(27, destination, 'third', () => true);
  manager.setDestination(27, null, 'third', () => false);
  const cancelled = download('cancelled.txt');
  session.emit('will-download', {}, cancelled.item, { id: 27 });
  expect(cancelled.saved()).toBe('');
  fs.writeFileSync(destination, 'keep');
  expect(() => manager.setDestination(27, destination, 'fourth', () => true)).toThrow(/new file/);
  expect(fs.readFileSync(destination, 'utf8')).toBe('keep');
  manager.dispose();
});


it('returns a tab to normal downloads once a cancelled action can no longer deliver late', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-lapsed-download-')); roots.push(root);
  const session = new EventEmitter();
  const manager = new BrowserWebviewDownloads(session as unknown as Session, root);
  const started = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(started);
  try {
    manager.setDestination(27, path.join(root, 'first.txt'), 'first', () => true);
    manager.setDestination(27, null, 'first', () => false);
    expect(() => manager.setDestination(27, path.join(root, 'second.txt'), 'second', () => true)).toThrow(/previous download/);
    clock.mockReturnValue(started + 31_000);
    const own = download('own.txt'); session.emit('will-download', {}, own.item, { id: 27 });
    expect(own.saved()).not.toBe('');
    manager.setDestination(27, path.join(root, 'second.txt'), 'second', () => true);
    const next = download('second.txt'); session.emit('will-download', {}, next.item, { id: 27 });
    expect(next.saved()).toBe(path.join(root, 'second.txt'));
  } finally { clock.mockRestore(); manager.dispose(); }
});

it('waits for the matching tab download after its triggering action has returned', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-delayed-download-')); roots.push(root);
  const session = new EventEmitter();
  const manager = new BrowserWebviewDownloads(session as unknown as Session, root);
  const destinationId = 'b3d0d156-6d48-4f27-a4cc-d629944236cf';
  const destination = path.join(root, '延迟报告.txt');
  manager.setDestination(27, destination, destinationId, () => true);
  let returned = false;
  const waiting = manager.waitDestination(27, destinationId, () => true).then(result => { returned = true; return result; });
  await Promise.resolve(); expect(returned).toBe(false);
  const other = download('other.txt'); session.emit('will-download', {}, other.item, { id: 99 });
  await Promise.resolve(); expect(returned).toBe(false);
  const current = download('server.txt'); session.emit('will-download', {}, current.item, { id: 27 });
  expect(await waiting).toEqual({ started: true });
  expect(current.saved()).toBe(destination);
  manager.setDestination(27, null, destinationId, () => false);
  manager.dispose();
});

it.each(['timeout', 'cancel', 'request-cancel'] as const)('fails a %s wait and prevents a late download from taking another action destination', async reason => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-cancel-download-')); roots.push(root);
  const session = new EventEmitter();
  const manager = new BrowserWebviewDownloads(session as unknown as Session, root);
  const firstId = 'b3d0d156-6d48-4f27-a4cc-d629944236cf';
  const secondId = '50c7f1c4-2d53-41c4-851d-c2a6efa86db5';
  manager.setDestination(27, path.join(root, 'first.txt'), firstId, () => true);
  let requestCurrent = true;
  const waiting = manager.waitDestination(27, firstId, () => requestCurrent, reason === 'timeout' ? 1 : 30_000);
  const rejected = expect(waiting).rejects.toThrow(reason === 'timeout' ? /did not start/ : /cancelled/);
  if (reason === 'cancel') manager.setDestination(27, null, firstId, () => false);
  if (reason === 'request-cancel') requestCurrent = false;
  await rejected;
  manager.setDestination(27, null, firstId, () => false);
  expect(() => manager.setDestination(27, path.join(root, 'second.txt'), secondId, () => true))
    .toThrow(/previous download/);
  const late = download('late-first.txt'); session.emit('will-download', {}, late.item, { id: 27 });
  expect(late.saved()).toBe('');
  manager.setDestination(27, path.join(root, 'second.txt'), secondId, () => true);
  const current = download('second.txt'); session.emit('will-download', {}, current.item, { id: 27 });
  expect(await manager.waitDestination(27, secondId, () => true)).toEqual({ started: true });
  expect(current.saved()).toBe(path.join(root, 'second.txt'));
  manager.dispose();
});
