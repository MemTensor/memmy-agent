import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { BrowserDownloadCatalog } from '../src/main/browser-download-catalog.js';
import { BrowserDownloadSettings } from '../src/main/browser-download-settings.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('lists saved downloads and rejects a forged path outside the download directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-browser-catalog-'));
  roots.push(root);
  const catalog = new BrowserDownloadCatalog(root);
  const id = 'fba476e1-81d0-4e39-b771-a955718719d1';
  const file = path.join(catalog.directory, id, 'report.txt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'example');
  fs.writeFileSync(catalog.indexPath, JSON.stringify([
    { id, name: 'report.txt', relativePath: path.join(id, 'report.txt'),
      url: 'https://example.com/report.txt', downloadedAt: 1 },
    { id: 'd6c67570-9b6c-45f0-a4c7-4d0b3509fc4d', name: 'escape',
      relativePath: '../../outside', url: 'https://example.com/', downloadedAt: 2 },
  ]));
  expect(catalog.list()).toHaveLength(1);
  expect(catalog.fileForId(id)).toBe(file);
  expect(catalog.fileForId('../../outside')).toBeNull();
});

it('keeps completed history visible after its file is deleted outside the app', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-browser-missing-download-'));
  roots.push(root);
  const catalog = new BrowserDownloadCatalog(root, 'webview');
  const id = 'fba476e1-81d0-4e39-b771-a955718719d1';
  const file = path.join(catalog.directory, id, 'report.txt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'data');
  catalog.record({ id, name: 'report.txt', relativePath: path.join(id, 'report.txt'),
    url: 'https://example.com/report.txt', downloadedAt: 1, status: 'complete' });
  fs.rmSync(file);
  expect(catalog.list()).toMatchObject([{ id, status: 'complete', fileExists: false }]);
  expect(catalog.fileForId(id)).toBeNull();
  expect(catalog.removeRecord(id)).toBe(true);
  expect(catalog.list()).toEqual([]);
});

it('reveals a custom-folder download only when that folder was selected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-browser-catalog-'));
  roots.push(root);
  const custom = path.join(root, 'chosen');
  fs.mkdirSync(custom);
  new BrowserDownloadSettings(root).select(custom);
  const catalog = new BrowserDownloadCatalog(root);
  const id = 'fba476e1-81d0-4e39-b771-a955718719d1';
  const file = path.join(custom, id, 'report.txt');
  fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, 'example');
  fs.writeFileSync(catalog.indexPath, JSON.stringify([{ id, name: 'report.txt', relativePath: path.join(id, 'report.txt'),
    url: 'https://example.com/report.txt', downloadedAt: 1, rootDirectory: custom }]));
  expect(catalog.fileForId(id)).toBe(file);
  new BrowserDownloadSettings(root).select(null);
  expect(catalog.fileForId(id)).toBe(file);
  fs.writeFileSync(new BrowserDownloadSettings(root).filePath, JSON.stringify({ directory: null, approvedDirectories: [] }));
  expect(catalog.fileForId(id)).toBeNull();
});

it('preserves the selected folder when toggling the save prompt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-browser-catalog-'));
  roots.push(root);
  const custom = path.join(root, 'chosen'); fs.mkdirSync(custom);
  const settings = new BrowserDownloadSettings(root);
  settings.select(custom);
  expect(settings.setAskBeforeDownload(true)).toMatchObject({ directory: custom, askBeforeDownload: true });
  expect(settings.select(null)).toMatchObject({ directory: null, askBeforeDownload: true });
});

it('keeps live-webview downloads in a separate, validated index', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-browser-catalog-'));
  roots.push(root);
  const agent = new BrowserDownloadCatalog(root);
  const webview = new BrowserDownloadCatalog(root, 'webview');
  const id = 'fba476e1-81d0-4e39-b771-a955718719d1';
  const file = path.join(webview.directory, id, 'report.txt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'example');
  webview.record({ id, name: 'report.txt', relativePath: path.join(id, 'report.txt'),
    url: 'https://example.com/report.txt', downloadedAt: 1 });
  expect(webview.fileForId(id)).toBe(file);
  expect(agent.list()).toEqual([]);
  expect(() => webview.record({ id, name: 'stolen.txt', relativePath: '../../outside',
    url: 'https://example.com/', downloadedAt: 2 })).toThrow('Invalid browser download');
  expect(webview.list()).toHaveLength(1);
  webview.clearHistory();
  expect(webview.list()).toEqual([]);
  expect(fs.existsSync(file)).toBe(true);
});

it('removes one webview download record while preserving its file and the Agent catalog', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-download-record-'));
  roots.push(root);
  const webview = new BrowserDownloadCatalog(root, 'webview');
  const agent = new BrowserDownloadCatalog(root, 'agent');
  const id = 'fba476e1-81d0-4e39-b771-a955718719d1';
  const file = path.join(webview.directory, id, 'report.txt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'contents');
  webview.record({ id, name: 'report.txt', relativePath: path.join(id, 'report.txt'),
    url: 'https://example.com/report.txt', downloadedAt: 1 });
  expect(webview.removeRecord(id)).toBe(true);
  expect(webview.list()).toEqual([]);
  expect(webview.fileForId(id)).toBeNull();
  expect(fs.readFileSync(file, 'utf8')).toBe('contents');
  expect(agent.list()).toEqual([]);
  expect(webview.removeRecord(id)).toBe(false);
  expect(webview.removeRecord('../../outside')).toBe(false);
});
