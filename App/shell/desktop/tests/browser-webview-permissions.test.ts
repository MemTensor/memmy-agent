import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Session } from 'electron';
import { afterEach, expect, it } from 'vitest';
import { BrowserSitePermissions } from '../src/main/browser-site-permissions.js';
import { BrowserTaskSitePermissions } from '../src/main/browser-task-site-permissions.js';
import { attachBrowserWebviewPermissions } from '../src/main/browser-webview-permissions.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('applies current per-origin device grants to the embedded browser', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-webview-permissions-'));
  roots.push(root);
  type Check = NonNullable<Parameters<Session['setPermissionCheckHandler']>[0]>;
  type Request = NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>;
  let check: Check | null = null;
  let request: Request | null = null;
  const session = {
    setPermissionCheckHandler: (handler: Check | null) => { check = handler; },
    setPermissionRequestHandler: (handler: Request | null) => { request = handler; },
  } as unknown as Session;
  const dispose = attachBrowserWebviewPermissions(session, root, new BrowserTaskSitePermissions());
  const site = new BrowserSitePermissions(root);
  const requestMedia = (types: Array<'video' | 'audio'>, url = 'https://example.com/page') => {
    let decision: boolean | null = null;
    request!({} as Electron.WebContents, 'media', allowed => { decision = allowed; },
      { requestingUrl: url, securityOrigin: new URL(url).origin, mediaTypes: types, isMainFrame: true });
    return decision;
  };
  expect(requestMedia(['video'])).toBe(false);
  site.set('https://example.com', 'camera', true);
  expect(check!(null, 'media', 'https://example.com', { mediaType: 'video', isMainFrame: true })).toBe(true);
  expect(requestMedia(['video'])).toBe(true);
  expect(requestMedia(['audio'])).toBe(false);
  site.set('https://example.com', 'microphone', true);
  expect(requestMedia(['video', 'audio'])).toBe(true);
  expect(requestMedia(['video'], 'https://other.example/page')).toBe(false);
  expect(check!(null, 'clipboard-read', 'https://example.com', { isMainFrame: true })).toBe(false);
  dispose();
  expect(check).toBeNull();
  expect(request).toBeNull();
});

it('enforces additional Electron session permissions only for an explicitly granted origin', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-webview-permissions-'));
  roots.push(root);
  type Check = NonNullable<Parameters<Session['setPermissionCheckHandler']>[0]>;
  type Request = NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>;
  let check: Check | null = null;
  let request: Request | null = null;
  const session = {
    setPermissionCheckHandler: (handler: Check | null) => { check = handler; },
    setPermissionRequestHandler: (handler: Request | null) => { request = handler; },
  } as unknown as Session;
  attachBrowserWebviewPermissions(session, root, new BrowserTaskSitePermissions());
  const site = new BrowserSitePermissions(root);
  const origin = 'https://permissions.test';
  const checkPermission = (permission: Parameters<Check>[1], requestedOrigin = origin) =>
    check!(null, permission, requestedOrigin, { isMainFrame: requestedOrigin === origin,
      ...(requestedOrigin !== origin ? { embeddingOrigin: origin } : {}) });
  const requestPermission = (permission: Parameters<Request>[1], requestingUrl = `${origin}/page`) => {
    let decision: boolean | null = null;
    request!({} as Electron.WebContents, permission, granted => { decision = granted; },
      { requestingUrl, isMainFrame: requestingUrl.startsWith(origin) });
    return decision;
  };
  for (const permission of ['clipboard-read', 'clipboard-sanitized-write', 'idle-detection',
    'midi', 'midiSysex', 'pointerLock'] as const) {
    expect(checkPermission(permission)).toBe(false);
    expect(requestPermission(permission)).toBe(false);
  }
  site.set(origin, 'clipboard-read', true);
  expect(checkPermission('clipboard-read')).toBe(true);
  expect(checkPermission('deprecated-sync-clipboard-read')).toBe(true);
  expect(checkPermission('clipboard-read', 'https://other.test')).toBe(false);
  expect(requestPermission('clipboard-read', 'https://other.test/frame')).toBe(false);
  site.set(origin, 'clipboard-write', true);
  expect(requestPermission('clipboard-sanitized-write')).toBe(true);
  for (const permission of ['idle-detection', 'midi', 'pointerLock'] as const) {
    site.set(origin, permission, true);
    expect(checkPermission(permission)).toBe(true);
    expect(requestPermission(permission)).toBe(true);
  }
  site.set(origin, 'midiSysex', true);
  expect(checkPermission('midiSysex')).toBe(true);
  site.set(origin, 'midi', false);
  expect(requestPermission('midiSysex')).toBe(false);
  expect(checkPermission('usb')).toBe(false);
  expect(checkPermission('hid')).toBe(false);
  expect(requestPermission('display-capture')).toBe(false);
});

it('lets a live Agent task choice override saved grants only on its tab and origin', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-webview-permissions-'));
  roots.push(root);
  type Check = NonNullable<Parameters<Session['setPermissionCheckHandler']>[0]>;
  type Request = NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>;
  let check: Check | null = null;
  let request: Request | null = null;
  const session = {
    setPermissionCheckHandler: (handler: Check | null) => { check = handler; },
    setPermissionRequestHandler: (handler: Request | null) => { request = handler; },
  } as unknown as Session;
  const tasks = new BrowserTaskSitePermissions();
  attachBrowserWebviewPermissions(session, root, tasks);
  const site = new BrowserSitePermissions(root);
  const origin = 'https://meeting.example';
  const taskTab = { id: 7 } as Electron.WebContents, otherTab = { id: 8 } as Electron.WebContents;
  const requestMedia = (contents: Electron.WebContents, types: Array<'video' | 'audio'>, url = `${origin}/room`) => {
    let decision: boolean | null = null;
    request!(contents, 'media', allowed => { decision = allowed; },
      { requestingUrl: url, securityOrigin: new URL(url).origin, mediaTypes: types, isMainFrame: true });
    return decision;
  };
  site.set(origin, 'microphone', true);
  tasks.set(7, origin, 'camera', true, () => true);
  tasks.set(7, origin, 'microphone', false, () => true);
  expect(check!(taskTab, 'media', origin, { mediaType: 'video', isMainFrame: true })).toBe(true);
  expect(requestMedia(taskTab, ['video'])).toBe(true);
  expect(requestMedia(taskTab, ['audio'])).toBe(false);
  expect(requestMedia(taskTab, ['video'], 'https://frame.example/embed')).toBe(false);
  expect(requestMedia(otherTab, ['video'])).toBe(false);
  expect(requestMedia(otherTab, ['audio'])).toBe(true);
  expect(check!(null, 'media', origin, { mediaType: 'video', isMainFrame: true })).toBe(false);
  expect(site.list()).toEqual([{ origin, permissions: ['microphone'] }]);
  tasks.end(7);
  expect(requestMedia(taskTab, ['video'])).toBe(false);
  expect(requestMedia(taskTab, ['audio'])).toBe(true);
});
