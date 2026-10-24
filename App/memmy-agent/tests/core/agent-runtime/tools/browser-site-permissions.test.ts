import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserSitePermissionStore } from '../../../../src/core/agent-runtime/tools/browser-site-permissions.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('applies saved grants to a live context and removes them after clearing data', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-browser-permissions-'));
  roots.push(root);
  const store = new BrowserSitePermissionStore(root);
  const context = { clearPermissions: vi.fn(async () => undefined),
    grantPermissions: vi.fn(async () => undefined) } as any;
  fs.writeFileSync(store.filePath, JSON.stringify({ 'https://example.com': ['camera'] }));
  await store.apply(context);
  expect(context.grantPermissions).toHaveBeenCalledWith(['camera'], { origin: 'https://example.com' });
  await store.apply(context);
  expect(context.clearPermissions).toHaveBeenCalledOnce();
  fs.writeFileSync(store.filePath, JSON.stringify({ 'https://example.com': ['microphone'] }));
  await store.apply(context);
  expect(context.clearPermissions).toHaveBeenCalledTimes(2);
  store.clear();
  await store.apply(context);
  expect(context.clearPermissions).toHaveBeenCalledTimes(3);
  expect(fs.existsSync(store.filePath)).toBe(false);
});

it('keeps supported grants from mixed legacy records and preserves other device settings during task overrides', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-browser-mixed-permissions-'));
  roots.push(root);
  const store = new BrowserSitePermissionStore(root);
  const raw = JSON.stringify({ 'https://example.com': ['camera', 'clipboard-read', 'midi'],
    'https://other.example': ['microphone', 'clipboard-write'] });
  fs.writeFileSync(store.filePath, raw);
  const context = { clearPermissions: vi.fn(async () => undefined), grantPermissions: vi.fn(async () => undefined) } as any;
  await store.apply(context);
  expect(context.grantPermissions).toHaveBeenCalledWith(['camera'], { origin: 'https://example.com' });
  expect(context.grantPermissions).toHaveBeenCalledWith(['microphone'], { origin: 'https://other.example' });
  await store.setForContext(context, { origin: 'https://example.com', permission: 'microphone', allow: true });
  await store.setForContext(context, { origin: 'https://example.com', permission: 'camera', allow: false });
  expect(context.grantPermissions).toHaveBeenLastCalledWith(['microphone'], { origin: 'https://other.example' });
  expect(fs.readFileSync(store.filePath, 'utf8')).toBe(raw);
});
