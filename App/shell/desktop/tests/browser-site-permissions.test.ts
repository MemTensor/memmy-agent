import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { BrowserSitePermissions, type BrowserSitePermission } from '../src/main/browser-site-permissions.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('persists only explicit HTTP website grants', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-site-grants-'));
  roots.push(root);
  const store = new BrowserSitePermissions(root);
  expect(store.set('https://example.com', 'camera', true)).toEqual([
    { origin: 'https://example.com', permissions: ['camera'] },
  ]);
  expect(new BrowserSitePermissions(root).list()).toHaveLength(1);
  expect(() => store.set('file:///tmp', 'camera', true)).toThrow();
  expect(store.set('https://example.com', 'camera', false)).toEqual([]);
});

it('stores only permissions the embedded Electron session actually manages', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-site-grants-'));
  roots.push(root);
  const store = new BrowserSitePermissions(root);
  for (const permission of ['clipboard-read', 'clipboard-write', 'idle-detection',
    'midi', 'midiSysex', 'pointerLock'] as const) store.set('https://permissions.test', permission, true);
  expect(new BrowserSitePermissions(root).list()[0]?.permissions).toEqual([
    'clipboard-read', 'clipboard-write', 'idle-detection', 'midi', 'midiSysex', 'pointerLock',
  ]);
  for (const unsupported of ['usb', 'hid', 'serial', 'javascript', 'display-capture']) {
    expect(() => store.set('https://permissions.test', unsupported as BrowserSitePermission, true)).toThrow();
  }
});
