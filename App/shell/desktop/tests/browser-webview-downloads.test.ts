import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DownloadItem, Session } from 'electron';
import { afterEach, expect, it } from 'vitest';
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
