import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserProfileStore } from '../../../../src/core/agent-runtime/tools/browser-profile.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('persists cookies, local storage and IndexedDB for the next browser context', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-browser-profile-test-'));
  roots.push(root);
  const store = new BrowserProfileStore(path.join(root, 'profile'));
  const state = { cookies: [{ name: 'sid', value: 'secret', domain: 'example.com', path: '/' }],
    origins: [{ origin: 'https://example.com', localStorage: [{ name: 'mode', value: 'dark' }], indexedDB: [] }] };
  const context = { storageState: vi.fn(async () => state) } as any;
  await store.save(context);
  expect(context.storageState).toHaveBeenCalledWith({ indexedDB: true });
  expect(store.load()).toBe(store.statePath);
  expect(JSON.parse(fs.readFileSync(store.statePath, 'utf8'))).toEqual(state);
  if (process.platform !== 'win32') expect(fs.statSync(store.statePath).mode & 0o777).toBe(0o600);
  await store.clear();
  expect(store.load()).toBeUndefined();
});

it('ignores malformed profile contents', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-browser-profile-test-'));
  roots.push(root);
  const store = new BrowserProfileStore(root);
  fs.writeFileSync(store.statePath, '{bad json');
  expect(store.load()).toBeUndefined();
});
