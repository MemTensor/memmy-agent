import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserDownloadStore } from '../../../../src/core/agent-runtime/tools/browser-downloads.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('keeps downloaded files after clearing the download history', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-browser-download-'));
  roots.push(root);
  const store = new BrowserDownloadStore(path.join(root, 'downloads'), async () => true);
  const saveAs = vi.fn(async (target: string) => { fs.writeFileSync(target, 'example'); });
  const entry = await store.save({ suggestedFilename: () => '../report.txt',
    url: () => 'https://example.com/report.txt', saveAs } as any, 'https://example.com/page');
  const saved = path.join(store.directory, entry.relativePath);
  expect(fs.readFileSync(saved, 'utf8')).toBe('example');
  expect(entry.name).toBe('report.txt');
  expect(new BrowserDownloadStore(store.directory).list()).toHaveLength(1);
  await store.clearHistory();
  expect(store.list()).toEqual([]);
  expect(fs.existsSync(saved)).toBe(true);
});

it('does not restore history when an in-flight download finishes after clearing it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-browser-download-'));
  roots.push(root);
  const store = new BrowserDownloadStore(path.join(root, 'downloads'), async () => true);
  let finish!: () => void;
  const saved = new Promise<void>(resolve => { finish = resolve; });
  const saving = store.save({ suggestedFilename: () => 'later.txt',
    url: () => 'https://example.com/later.txt', saveAs: async (target: string) => {
      await saved;
      fs.writeFileSync(target, 'later');
    } } as any, 'https://example.com/page');
  await store.clearHistory();
  finish();
  const entry = await saving;
  expect(store.list()).toEqual([]);
  expect(fs.existsSync(path.join(store.directory, entry.relativePath))).toBe(true);
});

it('saves new files in a folder selected through download settings', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-browser-download-'));
  roots.push(root);
  const custom = path.join(root, 'chosen');
  fs.mkdirSync(custom);
  const store = new BrowserDownloadStore(path.join(root, 'browser-use', 'downloads'), async () => true);
  fs.mkdirSync(path.dirname(store.settingsPath), { recursive: true });
  fs.writeFileSync(store.settingsPath, JSON.stringify({ directory: custom, approvedDirectories: [custom] }));
  const entry = await store.save({ suggestedFilename: () => 'report.txt',
    url: () => 'https://example.com/report.txt', saveAs: async (target: string) => {
      fs.writeFileSync(target, 'chosen');
    } } as any, 'https://example.com/page');
  expect(entry.rootDirectory).toBe(custom);
  expect(fs.readFileSync(path.join(custom, entry.relativePath), 'utf8')).toBe('chosen');
});

it('uses the exact file selected by the per-download save dialog', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-browser-download-'));
  roots.push(root);
  const store = new BrowserDownloadStore(path.join(root, 'browser-use', 'downloads'), async () => true);
  fs.mkdirSync(path.dirname(store.settingsPath), { recursive: true });
  fs.writeFileSync(store.settingsPath, JSON.stringify({ askBeforeDownload: true }));
  const target = path.join(root, 'chosen-name.txt');
  vi.spyOn(store as any, 'requestSavePath').mockResolvedValue(target);
  const entry = await store.save({ suggestedFilename: () => 'suggested.txt',
    url: () => 'https://example.com/file', saveAs: async (file: string) => { fs.writeFileSync(file, 'saved'); } } as any,
    'https://example.com/page');
  expect(entry.name).toBe('chosen-name.txt');
  expect(entry.rootDirectory).toBe(root);
  expect(entry.relativePath).toBe('chosen-name.txt');
  expect(fs.readFileSync(target, 'utf8')).toBe('saved');
});

it('blocks a download before saveAs or a save dialog when the site operation is denied', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-browser-download-'));
  roots.push(root);
  const approve = vi.fn(async () => false);
  const store = new BrowserDownloadStore(path.join(root, 'downloads'), approve);
  fs.mkdirSync(path.dirname(store.settingsPath), { recursive: true });
  fs.writeFileSync(store.settingsPath, JSON.stringify({ askBeforeDownload: true }));
  const requestSavePath = vi.spyOn(store as any, 'requestSavePath');
  const saveAs = vi.fn();
  await expect(store.save({ suggestedFilename: () => '/private/report.txt',
    url: () => 'https://cdn.example/file', saveAs } as any, 'https://example.com/page'))
    .rejects.toThrow('not approved');
  expect(approve).toHaveBeenCalledWith('https://example.com/page', 'report.txt');
  expect(requestSavePath).not.toHaveBeenCalled();
  expect(saveAs).not.toHaveBeenCalled();
  expect(store.list()).toEqual([]);
});

it('rechecks a newly blocked site after a delayed approval and before saveAs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-browser-download-'));
  let blocked = false;
  const saveAs = vi.fn(async () => undefined);
  const store = new BrowserDownloadStore(path.join(root, 'downloads'), async () => {
    blocked = true; return true;
  }, () => blocked);
  try {
    await expect(store.save({ suggestedFilename: () => 'file.txt', url: () => 'https://example.test/file', saveAs },
      'https://example.test/page')).rejects.toThrow(/blocked by site policy/);
    expect(saveAs).not.toHaveBeenCalled();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
