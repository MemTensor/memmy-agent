import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { EMBEDDED_BROWSER_REQUEST, parseEmbeddedBrowserTabMention,
  type EmbeddedBrowserRequest } from '@memmy/local-api-contracts';
import { EmbeddedBrowserDriver } from '../src/main/embedded-browser-driver.js';
import { BrowserHistoryStore } from '../src/main/browser-history-store.js';

function harness(selected = true) {
  let url = 'https://example.com/';
  let focused = false;
  let destroyed = false;
  const guestFrame = { frameTreeNodeId: 27 };
  let focusedFrame: { frameTreeNodeId: number } | null = guestFrame;
  const browserSession = { partition: 'persist:memmy-browser' };
  const debuggerEvents = new EventEmitter();
  const sendCommand = vi.fn(async (method: string, args?: Record<string, any>) => {
    if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'target-27', type: 'page', url } };
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-27', url } } };
    if (method === 'Accessibility.getFullAXTree') return { nodes: [
      { backendDOMNodeId: 7, role: { value: 'link' }, name: { value: 'Learn more' }, ignored: false },
    ] };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'object-7', subtype: 'node' } };
    if (method === 'DOM.describeNode') return { node: { backendNodeId: 7, nodeType: 1 } };
    if (method === 'DOM.getContentQuads') return { quads: [[20, 30, 60, 30, 60, 70, 20, 70]] };
    if (method === 'DOM.getNodeForLocation') return { backendNodeId: 7 };
    if (method === 'Runtime.callFunctionOn') return { result: { value: true } };
    if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
    if (method === 'Runtime.evaluate') return { result: { value: 1 } };
    return {};
  });
  const guest = Object.assign(new EventEmitter(), { id: 27,
    session: browserSession,
    isDestroyed: () => destroyed, isLoading: () => false,
    mainFrame: { framesInSubtree: [guestFrame] }, backgroundThrottling: true,
    setBackgroundThrottling: vi.fn((value: boolean) => { guest.backgroundThrottling = value; }),
    getURL: () => url, getTitle: () => 'Example', isFocused: () => focused,
    focus: vi.fn(), loadURL: vi.fn(async (target: string) => { url = target; }),
    debugger: Object.assign(debuggerEvents, { attach: vi.fn(), detach: vi.fn(), sendCommand }) });
  const host = { isDestroyed: () => false, show: vi.fn(),
    webContents: Object.assign(new EventEmitter(), { get focusedFrame() { return focusedFrame; },
      executeJavaScript: vi.fn(async () => { focusedFrame = guestFrame; return true; }),
      send: vi.fn((channel: string, target: string | number) => {
      if (channel === 'memmy:browser:close-tab' && target === 27) {
        destroyed = true;
        guest.emit('destroyed');
      } else if (typeof target === 'string') url = target;
    }) }) };
  Object.defineProperty(host.webContents, 'focusedFrame', { get: () => focusedFrame });
  const driver = new EmbeddedBrowserDriver(() => host as any);
  driver.attach(guest as any, host as any);
  if (selected) driver.selectTab(guest.id, host as any);
  const request = (command: EmbeddedBrowserRequest['command'], args: Record<string, unknown> = {}): EmbeddedBrowserRequest =>
    ({ type: EMBEDDED_BROWSER_REQUEST, requestId: 'test', tabId: 27, command, args });
  return { driver, request, sendCommand, guest, host, browserSession,
    focusFrame: (frame: { frameTreeNodeId: number } | null) => { focusedFrame = frame; },
    navigate: (target: string) => { url = target; }, focus: (value: boolean) => { focused = value; } };
}

it('keeps inactive guests and history without selecting or losing an approved background tab', async () => {
  const { driver, guest, host, browserSession } = harness(false);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-inactive-browser-'));
  const history = new BrowserHistoryStore(path.join(root, 'history.json'));
  driver.setHistoryStore(history);
  const request = (command: EmbeddedBrowserRequest['command']): EmbeddedBrowserRequest => ({
    type: EMBEDDED_BROWSER_REQUEST, requestId: 'test', tabId: 27, command, args: {},
  });
  try {
    expect(await driver.handle(request('listTabs'))).toMatchObject({ selectedTabId: null,
      tabs: [{ tabId: 27, everSelected: false }] });
    driver.selectTab(27, host as any);
    const background = Object.assign(new EventEmitter(), { id: 28, isDestroyed: () => false,
      getURL: () => 'https://background.test/', getTitle: guest.getTitle, debugger: guest.debugger });
    driver.attach(background as any, host as any);
    expect(await driver.handle(request('listTabs'))).toMatchObject({ selectedTabId: 27 });
    await driver.handle({ ...request('allowOrigin'), args: { origin: 'https://example.com' } });
    driver.selectTab(null, host as any);
    expect(await driver.handle(request('listTabs'))).toMatchObject({ selectedTabId: null,
      tabs: [{ tabId: 27, everSelected: true }, { tabId: 28, everSelected: false }] });
    expect(await driver.handle({ ...request('probe'), tabId: undefined })).toBeNull();
    expect(await driver.handle(request('snapshot'))).toMatchObject({ tab: { id: 27 },
      nodes: [{ ref: 'ax-7', name: 'Learn more' }] });
    guest.emit('did-stop-loading');
    expect(history.list().map(entry => entry.url)).toEqual(['https://example.com/']);
    expect(() => driver.selectedTabOrigin(27, host as any, browserSession as any)).toThrow(/unavailable/);
    expect(() => driver.uploadOrigin(27)).toThrow(/Selected.*changed/);
    const collect = vi.fn();
    expect(await driver.requestAuth(27, { origin: 'https://example.com', fields: [
      { id: 'password', label: 'Password', type: 'password', required: true, selector: 'input[type=password]' },
    ] }, collect, () => true)).toEqual({ status: 'page_changed' });
    expect(collect).not.toHaveBeenCalled();
  } finally { driver.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});

it('clears only a host-owned selection and never selects an arbitrary remaining guest after destruction', async () => {
  const { driver, guest, host, request } = harness();
  const otherHost = { isDestroyed: () => false, webContents: Object.assign(new EventEmitter(), { send: vi.fn() }) };
  const other = Object.assign(new EventEmitter(), { id: 28, isDestroyed: () => false,
    getURL: guest.getURL, getTitle: guest.getTitle, debugger: guest.debugger });
  const hidden = Object.assign(new EventEmitter(), { id: 29, isDestroyed: () => false,
    getURL: guest.getURL, getTitle: guest.getTitle, debugger: guest.debugger });
  try {
    driver.attach(other as any, otherHost as any);
    driver.attach(hidden as any, host as any);
    expect(() => driver.selectTab(null, otherHost as any)).toThrow(/unavailable/);
    expect(() => driver.selectTab(27, otherHost as any)).toThrow(/unavailable/);
    expect(await driver.handle(request('listTabs'))).toMatchObject({ selectedTabId: 27 });
    other.emit('destroyed');
    expect(await driver.handle(request('listTabs'))).toMatchObject({ selectedTabId: 27 });
    guest.emit('destroyed');
    expect(await driver.handle(request('listTabs'))).toMatchObject({ selectedTabId: null, tabs: [{ tabId: 29 }] });
    expect(await driver.handle({ ...request('probe'), tabId: undefined })).toBeNull();
    driver.selectTab(29, host as any);
    expect(await driver.handle(request('listTabs'))).toMatchObject({ selectedTabId: 29 });
  } finally { driver.dispose(); }
});

it.each(['screenshot', 'cdpCall'] as const)('rejects %s screenshots before observing a page or requiring a tab', async command => {
  const { driver, request, sendCommand, guest, host } = harness();
  const capturePage = vi.fn();
  const setBackgroundThrottling = vi.fn();
  Object.assign(guest, { capturePage, setBackgroundThrottling });
  try {
    for (const args of [{}, { fullPage: true }, { ref: 'ax-7', type: 'jpeg', scale: 'device' }]) {
      const payload = request(command, command === 'cdpCall'
        ? { method: 'Page.captureScreenshot', params: args } : args);
      await expect(driver.handle(payload))
        .rejects.toThrow('Screenshots are not supported by the embedded browser');
      await expect(new EmbeddedBrowserDriver().handle({ ...payload, tabId: undefined }))
        .rejects.toThrow('Screenshots are not supported by the embedded browser');
    }
    expect(guest.debugger.attach).not.toHaveBeenCalled();
    expect(sendCommand).not.toHaveBeenCalled();
    expect(capturePage).not.toHaveBeenCalled();
    expect(setBackgroundThrottling).not.toHaveBeenCalled();
    expect(guest.focus).not.toHaveBeenCalled();
    expect(host.show).not.toHaveBeenCalled();
    expect(host.webContents.send).not.toHaveBeenCalled();
  } finally { driver.dispose(); }
});

it('keeps the selected tab and text snapshots usable after refusing a background screenshot', async () => {
  const { driver, request, sendCommand, guest, host } = harness();
  const otherCapture = vi.fn();
  const other = Object.assign(new EventEmitter(), { ...guest, id: 28,
    getURL: () => 'https://other.test/', capturePage: otherCapture, focus: vi.fn() });
  await driver.handle(request('allowOrigin', { origin: 'https://example.com' }));
  driver.attach(other as any, host as any);
  driver.selectTab(other.id, host as any);
  try {
    await expect(driver.handle(request('screenshot')))
      .rejects.toThrow('Screenshots are not supported by the embedded browser');
    await expect(driver.handle(request('cdpCall', { method: 'Page.captureScreenshot' })))
      .rejects.toThrow('Screenshots are not supported by the embedded browser');
    expect(sendCommand).not.toHaveBeenCalled();
    expect(otherCapture).not.toHaveBeenCalled();
    expect(other.focus).not.toHaveBeenCalled();
    expect(host.show).not.toHaveBeenCalled();
    expect(await driver.handle(request('listTabs'))).toMatchObject({ selectedTabId: 28 });
    expect(await driver.handle(request('snapshot'))).toMatchObject({
      tab: { id: 27 }, nodes: [{ ref: 'ax-7', name: 'Learn more' }],
    });
    expect(await driver.handle(request('listTabs'))).toMatchObject({ selectedTabId: 28 });
  } finally { driver.dispose(); }
});

it('fills only the selected main-window webview in the expected browser session and origin', async () => {
  const { driver, guest, host, browserSession, sendCommand, navigate } = harness();
  const data = { kind: 'credential' as const, origin: 'https://example.com',
    username: 'sample-user', password: 'fake-secret' };
  expect(driver.selectedTabOrigin(27, host as any, browserSession as any)).toBe('https://example.com');
  expect(await driver.fillFromVault(27, host as any, browserSession as any, data)).toBe(1);
  const evaluation = sendCommand.mock.calls.find(([method]) => method === 'Runtime.evaluate')?.[1];
  expect(evaluation?.expression).toContain('location.origin!=="https://example.com"');
  expect(evaluation?.expression).toContain('fake-secret');
  await expect(driver.handle({ type: EMBEDDED_BROWSER_REQUEST, requestId: 'test', tabId: 27,
    command: 'snapshot', args: {} })).rejects.toThrow(/credential protection/);
  guest.emit('did-navigate');
  await expect(driver.handle({ type: EMBEDDED_BROWSER_REQUEST, requestId: 'test', tabId: 27,
    command: 'snapshot', args: {} })).rejects.toThrow(/credential protection/);
  await driver.handle({ type: EMBEDDED_BROWSER_REQUEST, requestId: 'test', tabId: 27,
    command: 'allowOrigin', args: { origin: 'https://example.com' } });
  await driver.handle({ type: EMBEDDED_BROWSER_REQUEST, requestId: 'test', tabId: 27,
    command: 'navigate', args: { url: 'https://example.com/account' } });
  guest.emit('did-navigate');
  await expect(driver.handle({ type: EMBEDDED_BROWSER_REQUEST, requestId: 'test', tabId: 27,
    command: 'snapshot', args: {} })).resolves.toHaveProperty('nodes');
  sendCommand.mockClear();
  await expect(driver.fillFromVault(27, {} as any, browserSession as any, data)).rejects.toThrow(/unavailable/);
  await expect(driver.fillFromVault(27, host as any, { partition: 'persist:other' } as any, data)).rejects.toThrow(/unavailable/);
  navigate('https://other.test/');
  await expect(driver.fillFromVault(27, host as any, browserSession as any, data)).rejects.toThrow(/site changed/);
  expect(sendCommand).not.toHaveBeenCalled();
  navigate('https://example.com/');
  const second = Object.assign(new EventEmitter(), { ...guest, id: 28 });
  driver.attach(second as any, host as any);
  driver.selectTab(second.id, host as any);
  await expect(driver.fillFromVault(27, host as any, browserSession as any, data)).rejects.toThrow(/unavailable/);
  driver.dispose();
});

it('fills contact fields only after resolving the selected tab origin', async () => {
  const { driver, host, browserSession, sendCommand } = harness();
  const currentOrigin = driver.selectedTabOrigin(27, host as any, browserSession as any);
  expect(await driver.fillFromVault(27, host as any, browserSession as any,
    { kind: 'contact', origin: currentOrigin, name: 'Test Person', email: 'test@example.test',
      phone: '123', address: 'Test Lane' })).toBe(1);
  expect(sendCommand.mock.calls.find(([method]) => method === 'Runtime.evaluate')?.[1]?.expression)
    .toContain('location.origin!=="https://example.com"');
  driver.dispose();
});

it('validates an auth form, fills only inside main, and returns no credentials', async () => {
  const { driver, request, sendCommand, guest } = harness();
  await driver.handle(request('allowOrigin', { origin: 'https://example.com' }));
  sendCommand.mockImplementation(async (method: string, args?: Record<string, any>) => {
    if (method !== 'Runtime.evaluate') return {};
    return { result: { value: args?.expression.includes('const controls=') ? [] : true } };
  });
  const metadata = { origin: 'https://example.com', fields: [
    { id: 'password', label: 'Password', type: 'password', required: true,
      selector: 'input[type="password"]' },
  ], submit: { selector: 'button[type="submit"]', action: 'click' } };
  const result = await driver.requestAuth(27, metadata,
    async () => ({ values: { password: 'fake-secret' } }), () => true);
  expect(result).toEqual({ status: 'submitted' });
  const evaluations = sendCommand.mock.calls.filter(([method]) => method === 'Runtime.evaluate');
  expect(evaluations).toHaveLength(3);
  expect(evaluations[0]?.[1]?.expression).not.toContain('fake-secret');
  expect(evaluations[1]?.[1]?.expression).not.toContain('fake-secret');
  expect(evaluations[2]?.[1]?.expression).toContain('fake-secret');
  await expect(driver.handle(request('click', { target: '7' }))).rejects.toThrow(/credential protection/);
  await expect(driver.handle(request('type', { target: '7', text: 'x' }))).rejects.toThrow(/credential protection/);
  await expect(driver.handle(request('listTabs'))).rejects.toThrow(/credential protection/);
  await expect(driver.handle(request('navigate', { url: 'https://other.test/' })))
    .rejects.toThrow(/credential protection/);
  await driver.handle(request('navigate', { url: 'https://example.com/account' }));
  guest.emit('did-navigate');
  expect(await driver.handle(request('snapshot'))).toHaveProperty('nodes');
  driver.dispose();
});

it('does not show the secure form for stale or invisible auth locators', async () => {
  const { driver, request, sendCommand } = harness();
  await driver.handle(request('allowOrigin', { origin: 'https://example.com' }));
  sendCommand.mockImplementation(async method => method === 'Runtime.evaluate'
    ? { result: { value: ['password'] } } : {});
  const collect = vi.fn(async () => ({ values: { password: 'fake-secret' } }));
  expect(await driver.requestAuth(27, { origin: 'https://example.com', fields: [
    { id: 'password', label: 'Password', type: 'password', required: true,
      selector: 'input[type=password]' },
  ] }, collect, () => true)).toEqual({ status: 'locator_invalid',
    locator_error: { field_id: 'password', reason: 'not_user_visible' } });
  expect(collect).not.toHaveBeenCalled();
  expect(sendCommand.mock.calls.some(([, args]) => args?.expression?.includes('fake-secret'))).toBe(false);
  driver.dispose();
});

it('never fills after the auth form outlives its tab claim or page', async () => {
  const { driver, request, sendCommand, guest } = harness();
  await driver.handle(request('allowOrigin', { origin: 'https://example.com' }));
  sendCommand.mockImplementation(async (method: string, args?: Record<string, any>) =>
    method === 'Runtime.evaluate'
      ? { result: { value: args?.expression.includes('const controls=') ? [] : true } } : {});
  const metadata = { origin: 'https://example.com', fields: [
    { id: 'password', label: 'Password', type: 'password', required: true,
      selector: 'input[type=password]' },
  ] };
  let release!: (answer: { values: Record<string, string> }) => void;
  const answer = new Promise<{ values: Record<string, string> }>(resolve => { release = resolve; });
  const operation = driver.requestAuth(27, metadata, () => answer, () => true);
  await new Promise(resolve => setTimeout(resolve, 0));
  guest.emit('did-navigate');
  release({ values: { password: 'fake-secret' } });
  expect(await operation).toEqual({ status: 'page_changed' });
  expect(sendCommand.mock.calls.some(([, args]) => args?.expression?.includes('fake-secret'))).toBe(false);
  driver.dispose();
});

it('binds secure auth to an attached cross-origin iframe and rejects a changed child', async () => {
  const { driver, request, guest, sendCommand } = harness();
  await driver.handle(request('allowOrigin', { origin: 'https://example.com' }));
  await driver.handle(request('snapshot'));
  guest.debugger.emit('message', {}, 'Target.attachedToTarget', {
    sessionId: 'child-1', targetInfo: { type: 'iframe', targetId: 'frame-1', url: 'https://identity.test/login' },
  });
  sendCommand.mockImplementation(async (method: string, args?: Record<string, any>, sessionId?: string) => {
    if (method === 'Runtime.evaluate' && args?.expression?.includes('const found=doc?.querySelectorAll'))
      return { result: { objectId: 'frame-node' } };
    if (method === 'DOM.describeNode') return { node: { nodeName: 'IFRAME', frameId: 'frame-1' } };
    if (method === 'Target.getTargetInfo') {
      expect(args).toEqual({}); expect(sessionId).toBe('child-1');
      return { targetInfo: { type: 'iframe', targetId: 'frame-1', url: 'https://identity.test/login' } };
    }
    if (method === 'Runtime.evaluate' && args?.expression?.includes('timeOrigin:doc.defaultView.performance.timeOrigin'))
      return { result: { value: { url: 'https://identity.test/login', timeOrigin: 123 } } };
    if (method === 'Runtime.evaluate') return { result: { value:
      args?.expression.includes('const controls=') ? [] : true } };
    return {};
  });
  const metadata = { origin: 'https://example.com', frame: 'iframe#signin', fields: [
    { id: 'password', label: 'Password', type: 'password', required: true,
      selector: 'input[type=password]' },
  ] };
  expect(await driver.requestAuth(27, metadata,
    async () => ({ values: { password: 'fake-secret' } }), () => true))
    .toEqual({ status: 'submitted' });
  expect(sendCommand.mock.calls.filter(([method, args]) => method === 'Runtime.evaluate'
    && args?.expression?.includes('fake-secret')).map((call: any[]) => call[2])).toEqual(['child-1']);
  await driver.handle(request('navigate', { url: 'https://example.com/account' }));
  guest.emit('did-navigate');
  let release!: (value: { values: Record<string, string> }) => void;
  const pending = new Promise<{ values: Record<string, string> }>(resolve => { release = resolve; });
  const second = driver.requestAuth(27, metadata, () => pending, () => true);
  await new Promise(resolve => setTimeout(resolve, 0));
  guest.debugger.emit('message', {}, 'Target.targetInfoChanged', {
    targetInfo: { type: 'iframe', targetId: 'frame-1', url: 'https://identity.test/other' },
  });
  sendCommand.mockClear();
  release({ values: { password: 'late-secret' } });
  expect(await second).toEqual({ status: 'page_changed' });
  expect(sendCommand.mock.calls.some(([, args]) => args?.expression?.includes('late-secret'))).toBe(false);
  driver.dispose();
});

it('follows a bounded two-level cross-origin iframe chain without exposing credentials', async () => {
  const { driver, request, guest, sendCommand } = harness();
  await driver.handle(request('allowOrigin', { origin: 'https://example.com' }));
  await driver.handle(request('snapshot'));
  guest.debugger.emit('message', {}, 'Target.attachedToTarget', {
    sessionId: 'child-1', targetInfo: { type: 'iframe', targetId: 'frame-1', url: 'https://identity.test/' },
  });
  guest.debugger.emit('message', {}, 'Target.attachedToTarget', {
    sessionId: 'child-2', targetInfo: { type: 'iframe', targetId: 'frame-2', url: 'https://challenge.test/' },
  }, 'child-1');
  sendCommand.mockImplementation(async (method: string, args?: Record<string, any>, sessionId?: string) => {
    if (method === 'Runtime.evaluate' && args?.expression?.includes('const found=doc?.querySelectorAll'))
      return { result: { objectId: sessionId === 'child-1' ? 'node-2' : 'node-1' } };
    if (method === 'DOM.describeNode') return { node: { nodeName: 'IFRAME',
      frameId: args?.objectId === 'node-2' ? 'frame-2' : 'frame-1' } };
    if (method === 'Target.getTargetInfo') {
      expect(args).toEqual({}); expect(['child-1', 'child-2']).toContain(sessionId);
      return { targetInfo: { type: 'iframe', targetId: sessionId === 'child-1' ? 'frame-1' : 'frame-2',
        url: sessionId === 'child-1' ? 'https://identity.test/' : 'https://challenge.test/' } };
    }
    if (method === 'Runtime.evaluate' && args?.expression?.includes('timeOrigin:doc.defaultView.performance.timeOrigin'))
      return { result: { value: { url: sessionId === 'child-1'
        ? 'https://identity.test/' : 'https://challenge.test/', timeOrigin: sessionId === 'child-1' ? 123 : 456 } } };
    if (method === 'Runtime.evaluate') return { result: { value:
      args?.expression.includes('const controls=') ? [] : true } };
    return {};
  });
  expect(await driver.requestAuth(27, { origin: 'https://example.com',
    frames: ['iframe#identity', 'iframe#challenge'], fields: [
      { id: 'code', label: 'Verification code', type: 'text', required: true,
        selector: 'input[autocomplete="one-time-code"]' },
    ] }, async () => ({ values: { code: '123456' } }), () => true)).toEqual({ status: 'submitted' });
  expect(sendCommand.mock.calls.filter(([method, args]) => method === 'Runtime.evaluate'
    && args?.expression?.includes('"123456"')).map((call: any[]) => call[2])).toEqual(['child-2']);
  driver.dispose();
});

it('sets files only on the selected in-app file input after a main-process approval', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-embedded-upload-'));
  const file = path.join(root, 'report.txt');
  fs.writeFileSync(file, 'sample');
  const { driver, request, sendCommand, navigate } = harness();
  try {
    await driver.handle(request('allowOrigin', { origin: 'https://example.com' }));
    const upload = request('upload', { paths: [file], target: 'ax-7' });
    const info = fs.lstatSync(file);
    const approval = { origin: 'https://example.com', stamps: [{ path: file, realPath: fs.realpathSync(file),
      dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs }], isCurrentChild: () => true };
    await expect(driver.handle(upload)).rejects.toThrow('not approved');
    expect(sendCommand.mock.calls.some(([method]) => method === 'DOM.setFileInputFiles')).toBe(false);
    sendCommand.mockImplementation(async (method: string) => {
      if (method === 'DOM.resolveNode') return { object: { objectId: 'input-7' } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: true } };
      return {};
    });
    expect(await driver.handle(upload, approval)).toEqual({ uploaded: 1 });
    expect(sendCommand.mock.calls.find(([method]) => method === 'DOM.setFileInputFiles')?.[1])
      .toEqual({ files: [file], objectId: 'input-7' });
    sendCommand.mockClear();
    sendCommand.mockImplementation(async (method: string) => {
      if (method === 'DOM.resolveNode') return { object: { objectId: 'input-7' } };
      if (method === 'Runtime.callFunctionOn') { navigate('https://other.example/'); return { result: { value: true } }; }
      return {};
    });
    await expect(driver.handle(upload, approval)).rejects.toThrow('site changed');
    expect(sendCommand.mock.calls.some(([method]) => method === 'DOM.setFileInputFiles')).toBe(false);
  } finally {
    driver.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('runs only approved read-only CDP calls and drops results after origin changes', async () => {
  const { driver, request, sendCommand, navigate, guest } = harness();
  await driver.handle(request('allowOrigin', { origin: 'https://example.com' }));
  const approval = { origin: 'https://example.com', isCurrentChild: () => true, isAllowed: () => true };
  const read = request('cdpCall', { method: 'Runtime.evaluate', params: { expression: 'document.title' } });
  await expect(driver.handle(read)).rejects.toThrow(/not approved/);
  await driver.handle(read, undefined, approval);
  expect(sendCommand.mock.calls.find(([method]) => method === 'Runtime.evaluate')?.[1])
    .toMatchObject({ expression: 'document.title', throwOnSideEffect: true, returnByValue: true });
  sendCommand.mockClear();
  await expect(driver.handle(request('cdpCall', { method: 'DOM.setFileInputFiles', params: {} }),
    undefined, approval)).rejects.toThrow(/unavailable/);
  expect(sendCommand).not.toHaveBeenCalled();
  sendCommand.mockImplementation(async (method: string) => {
    if (method === 'Page.getLayoutMetrics') navigate('https://other.test/');
    return {};
  });
  await expect(driver.handle(request('cdpCall', { method: 'Page.getLayoutMetrics', params: {} }),
    undefined, approval)).rejects.toThrow(/site changed/);
  navigate('https://example.com/');
  sendCommand.mockImplementation(async (method: string) => {
    if (method === 'Page.getLayoutMetrics') {
      guest.emit('did-start-navigation', { isMainFrame: true, url: 'https://other.test/' });
      guest.emit('did-start-navigation', { isMainFrame: true, url: 'https://example.com/' });
    }
    return {};
  });
  await expect(driver.handle(request('cdpCall', { method: 'Page.getLayoutMetrics', params: {} }),
    undefined, approval)).rejects.toThrow(/site changed/);
  guest.debugger.emit('message', {}, 'Runtime.consoleAPICalled', { type: 'log' });
  expect(await driver.handle(request('cdpEvents', { afterSequence: 0 }), undefined, approval))
    .toMatchObject({ events: [{ method: 'Runtime.consoleAPICalled', source: { tabId: 27 } }] });
  navigate('https://other.test/');
  await driver.handle(request('allowOrigin', { origin: 'https://other.test' }));
  const otherApproval = { ...approval, origin: 'https://other.test' };
  expect(await driver.handle(request('cdpEvents', { afterSequence: 0 }), undefined, otherApproval))
    .toMatchObject({ events: [] });
  driver.dispose();
});

it('sends CDP mutations only with write approval on an idle selected tab', async () => {
  const { driver, request, sendCommand, navigate, guest, focus } = harness();
  await driver.handle(request('allowOrigin', { origin: 'https://example.com' }));
  const write = request('cdpWrite', { method: 'Runtime.evaluate',
    params: { expression: 'document.title = "changed"' } });
  const grant = { origin: 'https://example.com', isCurrentChild: () => true,
    isAllowed: () => true, mode: 'write' as const };
  await expect(driver.handle(write)).rejects.toThrow(/not approved/);
  await expect(driver.handle(write, undefined, { ...grant, mode: 'read' }))
    .rejects.toThrow(/not approved/);
  expect(sendCommand.mock.calls.some(([method]) => method === 'Runtime.evaluate')).toBe(false);
  expect(await driver.handle(write, undefined, grant)).toMatchObject({ result: { value: 1 } });
  expect(sendCommand.mock.calls.find(([method]) => method === 'Runtime.evaluate')?.[1])
    .toMatchObject({ expression: 'document.title = "changed"' });
  sendCommand.mockClear();
  await expect(driver.handle(request('cdpWrite', { method: 'DOM.setFileInputFiles', params: {} }),
    undefined, grant)).rejects.toThrow(/unavailable/);
  expect(sendCommand).not.toHaveBeenCalled();
  focus(true);
  vi.useFakeTimers();
  try {
    const typing = setInterval(() => guest.emit('before-input-event', {}, { type: 'keyDown', key: 'a' }), 500);
    guest.emit('before-input-event', {}, { type: 'keyDown', key: 'a' });
    const blocked = expect(driver.handle(write, undefined, grant)).rejects.toThrow(/USER_ACTIVE/);
    await vi.advanceTimersByTimeAsync(8_200);
    clearInterval(typing);
    await blocked;
  } finally { vi.useRealTimers(); }
  expect(sendCommand).not.toHaveBeenCalled();
  focus(false);
  navigate('https://other.test/');
  await expect(driver.handle(write, undefined, grant)).rejects.toThrow(/not approved/);
  expect(sendCommand).not.toHaveBeenCalled();
  driver.dispose();
});

it('blocks raw CDP writes while credential autofill is active', async () => {
  const { driver, host, browserSession, request, sendCommand } = harness();
  await driver.handle(request('allowOrigin', { origin: 'https://example.com' }));
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  sendCommand.mockImplementation(async (method: string) => {
    if (method === 'Runtime.evaluate') { entered(); await pending; return { result: { value: 1 } }; }
    return {};
  });
  const fill = driver.fillFromVault(27, host as any, browserSession as any,
    { kind: 'credential', origin: 'https://example.com', username: 'user', password: 'secret' });
  try {
    await started;
    await expect(driver.handle(request('cdpWrite', { method: 'Runtime.evaluate',
      params: { expression: 'document.title = "changed"' } }), undefined,
    { origin: 'https://example.com', isCurrentChild: () => true, isAllowed: () => true,
      mode: 'write' })).rejects.toThrow(/credential protection/);
    expect(sendCommand.mock.calls.filter(([method]) => method === 'Runtime.evaluate')).toHaveLength(1);
  } finally { release(); await fill; driver.dispose(); }
});

it('times out a raw CDP write while keeping autofill blocked until debugger completion', async () => {
  const { driver, request, host, browserSession, sendCommand } = harness();
  await driver.handle(request('allowOrigin', { origin: 'https://example.com' }));
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  sendCommand.mockImplementation(async (method: string) => {
    if (method === 'Runtime.evaluate') { entered(); await pending; return { result: { value: 1 } }; }
    return {};
  });
  const operation = driver.handle(request('cdpWrite', { method: 'Runtime.evaluate',
    params: { expression: 'document.title = "changed"' }, timeoutMs: 10 }), undefined,
  { origin: 'https://example.com', isCurrentChild: () => true, isAllowed: () => true,
    mode: 'write' });
  try {
    await started;
    await expect(operation).rejects.toThrow(/timed out/);
    await expect(driver.fillFromVault(27, host as any, browserSession as any,
      { kind: 'credential', origin: 'https://example.com', username: 'u', password: 'p' }))
      .rejects.toThrow(/during raw CDP/);
  } finally { release(); await new Promise(resolve => setTimeout(resolve, 0)); driver.dispose(); }
});

it('keeps vault credentials out of CDP reads, events, and snapshots until a new document', async () => {
  const { driver, request, guest, host, browserSession, sendCommand } = harness();
  await driver.handle(request('allowOrigin', { origin: 'https://example.com' }));
  const grant = { origin: 'https://example.com', isCurrentChild: () => true, isAllowed: () => true };
  await driver.handle(request('cdpCall', { method: 'Page.getLayoutMetrics' }), undefined, grant);
  const waiting = driver.handle(request('cdpEvents', { afterSequence: 0, timeoutMs: 500 }), undefined, grant);
  const waitingAssertion = expect(waiting).rejects.toThrow(/no longer approved/);
  await new Promise(resolve => setTimeout(resolve, 0));
  await driver.fillFromVault(27, host as any, browserSession as any,
    { kind: 'credential', origin: 'https://example.com', username: 'user', password: 'secret' });
  await waitingAssertion;
  sendCommand.mockClear();
  guest.debugger.emit('message', {}, 'Network.requestWillBeSent', {
    request: { method: 'POST', url: 'https://example.com/login?password=secret' },
  });
  await expect(driver.handle(request('cdpCall', { method: 'Runtime.evaluate',
    params: { expression: 'document.querySelector("input[type=password]").value' } }),
  undefined, grant)).rejects.toThrow(/credential protection/);
  await expect(driver.handle(request('cdpEvents', { afterSequence: 0 }), undefined, grant))
    .rejects.toThrow(/credential protection/);
  await expect(driver.handle(request('snapshot'), undefined, grant)).rejects.toThrow(/credential protection/);
  expect(sendCommand.mock.calls.some(([method]) => method === 'Runtime.evaluate')).toBe(false);
  guest.emit('did-navigate');
  await expect(driver.handle(request('cdpCall', { method: 'Page.getLayoutMetrics' }), undefined, grant))
    .rejects.toThrow(/credential protection/);
  await driver.handle(request('navigate', { url: 'https://example.com/account' }));
  guest.emit('did-navigate');
  expect(await driver.handle(request('cdpEvents', { afterSequence: 0 }), undefined, grant))
    .toMatchObject({ events: [] });
  await expect(driver.handle(request('cdpCall', { method: 'Page.getLayoutMetrics' }), undefined, grant))
    .resolves.toBeTruthy();
  driver.dispose();
});

it('does not fill a vault password while a timed-out CDP read is still in flight', async () => {
  const { driver, request, host, browserSession, sendCommand } = harness();
  await driver.handle(request('allowOrigin', { origin: 'https://example.com' }));
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  sendCommand.mockImplementation(async (method: string) => {
    if (method === 'Runtime.evaluate') { entered(); await pending; return { result: { value: 'title' } }; }
    return {};
  });
  const read = driver.handle(request('cdpCall', { method: 'Runtime.evaluate',
    params: { expression: 'document.title' }, timeoutMs: 10 }), undefined,
  { origin: 'https://example.com', isCurrentChild: () => true, isAllowed: () => true });
  try {
    await started;
    await expect(read).rejects.toThrow(/timed out/);
    await expect(driver.fillFromVault(27, host as any, browserSession as any,
      { kind: 'credential', origin: 'https://example.com', username: 'user', password: 'fake-secret' }))
      .rejects.toThrow(/during raw CDP/);
    expect(sendCommand.mock.calls.filter(([method]) => method === 'Runtime.evaluate')).toHaveLength(1);
  } finally { release(); await new Promise(resolve => setTimeout(resolve, 0)); driver.dispose(); }
});

it('sends child CDP commands only to the approved attached iframe and rejects probe/navigation races', async () => {
  const { driver, request, guest, sendCommand } = harness();
  await driver.handle(request('allowOrigin', { origin: 'https://example.com' }));
  const grant = { origin: 'https://example.com', isCurrentChild: () => true,
    isAllowed: () => true, mode: 'write' as const };
  await driver.handle(request('cdpCall', { method: 'Page.getLayoutMetrics' }), undefined,
    { ...grant, mode: 'read' });
  guest.debugger.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'session-1',
    targetInfo: { type: 'iframe', targetId: 'child-1', url: 'https://example.com/frame' } });
  let childUrl = 'https://example.com/frame';
  sendCommand.mockImplementation(async (method: string, args?: Record<string, any>, sessionId?: string) => {
    if (method === 'Target.getTargetInfo') {
      expect(args).toEqual({}); expect(sessionId).toBe('session-1');
      return { targetInfo: { type: 'iframe', targetId: 'child-1', url: childUrl } };
    }
    return {};
  });
  let approvedTarget = await driver.cdpTarget(27, { targetId: 'child-1' });
  await driver.handle(request('cdpWrite', { method: 'Input.dispatchMouseEvent',
    params: { type: 'mouseMoved', x: 1, y: 2 }, target: { targetId: 'child-1' } }), undefined,
    { ...grant, target: approvedTarget });
  expect(sendCommand.mock.calls.find(([method]) => method === 'Input.dispatchMouseEvent')?.[2])
    .toBe('session-1');
  sendCommand.mockClear();
  childUrl = 'https://silent-navigation.test/frame';
  await expect(driver.handle(request('cdpCall', { method: 'Page.getLayoutMetrics',
    target: { sessionId: 'session-1' } }), undefined, { ...grant, mode: 'read', target: approvedTarget }))
    .rejects.toThrow(/changed after approval/);
  expect(sendCommand.mock.calls.some(([method]) => method === 'Page.getLayoutMetrics')).toBe(false);
  childUrl = 'https://example.com/frame';
  guest.debugger.emit('message', {}, 'Target.targetInfoChanged', {
    targetInfo: { type: 'iframe', targetId: 'child-1', url: 'https://other.test/frame' } });
  childUrl = 'https://other.test/frame';
  await expect(driver.handle(request('cdpCall', { method: 'Page.getLayoutMetrics',
    target: { sessionId: 'session-1' } }), undefined, { ...grant, mode: 'read', target: approvedTarget }))
    .rejects.toThrow(/changed after approval/);
  expect(sendCommand.mock.calls.some(([method]) => method === 'Page.getLayoutMetrics')).toBe(false);
  approvedTarget = await driver.cdpTarget(27, { sessionId: 'session-1' });
  await expect(driver.handle(request('cdpCall', { method: 'Page.getLayoutMetrics',
    target: { sessionId: 'session-1' } }), undefined, { ...grant, mode: 'read', target: approvedTarget }))
    .resolves.toEqual({});
  expect(sendCommand.mock.calls.find(([method]) => method === 'Page.getLayoutMetrics')?.[2])
    .toBe('session-1');
  sendCommand.mockImplementation(async (method: string, args?: Record<string, any>, sessionId?: string) => {
    if (method === 'Target.getTargetInfo') {
      expect(args).toEqual({}); expect(sessionId).toBe('session-1');
      return { targetInfo: { type: 'iframe', targetId: 'child-1', url: childUrl } };
    }
    if (method === 'Page.getLayoutMetrics') {
      guest.debugger.emit('message', {}, 'Target.targetInfoChanged', {
        targetInfo: { type: 'iframe', targetId: 'child-1', url: 'https://example.com/frame' },
      });
      guest.debugger.emit('message', {}, 'Target.targetInfoChanged', {
        targetInfo: { type: 'iframe', targetId: 'child-1', url: 'https://other.test/frame' },
      });
    }
    return {};
  });
  await expect(driver.handle(request('cdpCall', { method: 'Page.getLayoutMetrics',
    target: { sessionId: 'session-1' } }), undefined, { ...grant, mode: 'read', target: approvedTarget }))
    .rejects.toThrow(/child target site changed/);
  guest.debugger.emit('message', {}, 'Target.detachedFromTarget', { sessionId: 'session-1' });
  await expect(driver.handle(request('cdpCall', { method: 'Page.getLayoutMetrics',
    target: { sessionId: 'session-1' } }), undefined, { ...grant, mode: 'read', target: approvedTarget }))
    .rejects.toThrow(/not attached/);
  driver.dispose();
});

it.each(['target-id', 'target-type', 'url', 'revision', 'detached'])('rejects changed child metadata (%s) on its own registered session', async change => {
  const { driver, request, guest, sendCommand } = harness();
  try {
    await driver.handle(request('allowOrigin', { origin: 'https://example.com' }));
    await driver.handle(request('viewport'));
    const info = { type: 'iframe', targetId: 'child-target', url: 'https://frame.test/form' };
    guest.debugger.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'bound-child', targetInfo: info });
    sendCommand.mockImplementation(async (method: string, params?: Record<string, any>, sessionId?: string) => {
      expect(method).toBe('Target.getTargetInfo'); expect(params).toEqual({}); expect(sessionId).toBe('bound-child');
      if (change === 'revision') guest.debugger.emit('message', {}, 'Target.targetInfoChanged', { targetInfo: info });
      if (change === 'detached') guest.debugger.emit('message', {}, 'Target.detachedFromTarget', { sessionId: 'bound-child' });
      return { targetInfo: { ...info, ...(change === 'target-id' ? { targetId: 'foreign-target' }
        : change === 'target-type' ? { type: 'page' } : change === 'url' ? { url: 'chrome://settings/' } : {}) } } as any;
    });
    sendCommand.mockClear();
    await expect(driver.cdpTarget(27, { sessionId: 'bound-child' })).rejects.toThrow();
    expect(sendCommand).toHaveBeenCalledTimes(1);
    sendCommand.mockClear();
    await expect(driver.cdpTarget(27, { sessionId: 'unregistered-child' })).rejects.toThrow(/not attached/);
    expect(sendCommand).not.toHaveBeenCalled();
  } finally { driver.dispose(); }
});

it('rechecks selection and origin after attaching CDP but before sending autofill values', async () => {
  const first = harness();
  const data = { kind: 'credential' as const, origin: 'https://example.com',
    username: 'sample-user', password: 'fake-secret' };
  first.sendCommand.mockImplementation(async (method: string) => {
    if (method === 'Page.enable') {
      first.driver.attach(Object.assign(new EventEmitter(), { ...first.guest, id: 28 }) as any, first.host as any);
      first.driver.selectTab(28, first.host as any);
    }
    return {};
  });
  await expect(first.driver.fillFromVault(27, first.host as any, first.browserSession as any, data))
    .rejects.toThrow(/unavailable/);
  expect(first.sendCommand.mock.calls.some(([method]) => method === 'Runtime.evaluate')).toBe(false);
  first.driver.dispose();

  const second = harness();
  second.sendCommand.mockImplementation(async (method: string) => {
    if (method === 'Page.enable') second.navigate('https://other.test/');
    return {};
  });
  await expect(second.driver.fillFromVault(27, second.host as any, second.browserSession as any, data))
    .rejects.toThrow(/site changed/);
  expect(second.sendCommand.mock.calls.some(([method]) => method === 'Runtime.evaluate')).toBe(false);
  second.driver.dispose();
});

it('controls the exact user webview through CDP without creating a second page', async () => {
  const { driver, request, sendCommand } = harness();
  expect(await driver.handle(request('probe'))).toMatchObject({ tabId: 27, url: 'https://example.com/' });
  expect(await driver.handle(request('snapshot'))).toMatchObject({ nodes: [{ ref: 'ax-7', name: 'Learn more' }] });
  expect(await driver.handle(request('click', { ref: 'ax-7' }))).toEqual({ x: 40, y: 50 });
  expect(sendCommand).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed', x: 40, y: 50 }));
  await expect(driver.handle(request('navigate', { url: 'https://other.example/' }))).rejects.toThrow(/access approval/);
  await driver.handle(request('allowOrigin', { origin: 'https://other.example' }));
  expect(await driver.handle(request('navigate', { url: 'https://other.example/' }))).toEqual({ url: 'https://other.example/' });
  expect(await driver.handle(request('probe'))).toMatchObject({ tabId: 27, url: 'https://other.example/' });
  driver.dispose();
});

it('resolves bracketed accessibility references and uses native layout rather than page geometry methods', async () => {
  const { driver, request, sendCommand } = harness();
  try {
    await driver.handle(request('probe'));
    expect(await driver.handle(request('click', { target: '[ax-7]' }))).toEqual({ x: 40, y: 50 });
    expect(sendCommand).toHaveBeenCalledWith('DOM.resolveNode', { backendNodeId: 7 });
    expect(sendCommand).toHaveBeenCalledWith('DOM.scrollIntoViewIfNeeded', { objectId: 'object-7' });
    expect(sendCommand).toHaveBeenCalledWith('DOM.getContentQuads', { objectId: 'object-7' });
    expect(sendCommand.mock.calls.some(([method]) => method === 'Runtime.evaluate' || method === 'Runtime.callFunctionOn')).toBe(false);
  } finally { driver.dispose(); }
});

it.each(['text=Learn more', 'a:has-text("Learn more")', "a:has-text('Learn more')", 'a', 'text=Learn more >> nth=0'])(
  'resolves the generic locator %s to a real element', async target => {
    const { driver, request, sendCommand } = harness();
    const native = sendCommand.getMockImplementation()!;
    const view = { getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) };
    const leaf = { textContent: 'Learn more', getClientRects: () => [{}], ownerDocument: { defaultView: view },
      contains: () => false };
    const ancestor = { ...leaf, contains: (child: unknown) => child === leaf };
    sendCommand.mockImplementation(async (method, args) => {
      if (method === 'Runtime.evaluate') {
        const element = runInNewContext(String(args?.expression), { document: {
          querySelectorAll: (selector: string) => selector === '*' ? [ancestor, leaf] : [leaf],
        } });
        return { result: element === leaf ? { objectId: 'object-7', subtype: 'node' } : { subtype: 'null', value: null } };
      }
      return native(method, args);
    });
    try {
      await driver.handle(request('probe'));
      expect(await driver.handle(request('click', { target }))).toEqual({ x: 40, y: 50 });
    } finally { driver.dispose(); }
  });

it('rejects ambiguous locators and permits only an explicit matching nth index', async () => {
  const { driver, request, sendCommand } = harness();
  const native = sendCommand.getMockImplementation()!;
  const leaves = [0, 1].map(() => ({ textContent: 'Learn more', getClientRects: () => [{}],
    ownerDocument: { defaultView: { getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) } }, contains: () => false }));
  sendCommand.mockImplementation(async (method, args) => {
    if (method === 'Runtime.evaluate') {
      try {
        const element = runInNewContext(String(args?.expression), { document: { querySelectorAll: () => leaves } });
        return { result: element === leaves[1] ? { objectId: 'object-7', subtype: 'node' } : { value: null } };
      } catch (error) {
        return { exceptionDetails: { exception: { description: String(error) } }, result: { objectId: 'exception-1', subtype: 'error' } };
      }
    }
    return native(method, args);
  });
  try {
    await driver.handle(request('probe'));
    await expect(driver.handle(request('click', { target: 'text=Learn more' }))).rejects.toThrow(/ambiguous/);
    expect(sendCommand.mock.calls.some(([method]) => method.startsWith('Input.'))).toBe(false);
    expect(await driver.handle(request('click', { target: 'text=Learn more >> nth=1' }))).toEqual({ x: 40, y: 50 });
    await expect(driver.handle(request('click', { target: 'text=Learn more >> nth=2' }))).rejects.toThrow(/no longer available/);
  } finally { driver.dispose(); }
});

it('preserves Runtime selector exceptions and never mistakes the exception object for a DOM element', async () => {
  const { driver, request, sendCommand } = harness();
  const native = sendCommand.getMockImplementation()!;
  sendCommand.mockImplementation(async (method, args) => method === 'Runtime.evaluate'
    ? { exceptionDetails: { exception: { description: 'SyntaxError: selector is invalid\nprivate stack' } },
      result: { objectId: 'exception-1', subtype: 'error' } } : native(method, args));
  try {
    await driver.handle(request('probe'));
    await expect(driver.handle(request('click', { target: 'button:unknown(' }))).rejects.toThrow(/locator failed: SyntaxError: selector is invalid/);
    expect(sendCommand.mock.calls.some(([method]) => ['DOM.describeNode', 'Runtime.callFunctionOn'].includes(method) || method.startsWith('Input.'))).toBe(false);
    expect(sendCommand).toHaveBeenCalledWith('Runtime.releaseObject', { objectId: 'exception-1' });
  } finally { driver.dispose(); }
});

it('releases a locator result that is not a DOM node', async () => {
  const { driver, request, sendCommand } = harness();
  const native = sendCommand.getMockImplementation()!;
  sendCommand.mockImplementation(async (method, args) => method === 'Runtime.evaluate'
    ? { result: { objectId: 'non-node', subtype: 'error' } } : native(method, args));
  try {
    await driver.handle(request('probe'));
    await expect(driver.handle(request('click', { target: 'a' }))).rejects.toThrow(/no longer available/);
    expect(sendCommand).toHaveBeenCalledWith('Runtime.releaseObject', { objectId: 'non-node' });
    expect(sendCommand.mock.calls.some(([method]) => method === 'DOM.describeNode' || method.startsWith('Input.'))).toBe(false);
  } finally { driver.dispose(); }
});

it('refuses a remote object that is not a native element even when it has an object ID', async () => {
  const { driver, request, sendCommand } = harness();
  const native = sendCommand.getMockImplementation()!;
  sendCommand.mockImplementation(async (method, args) => method === 'DOM.describeNode'
    ? { node: { backendNodeId: 7, nodeType: 3 } } : native(method, args));
  try {
    await driver.handle(request('probe'));
    await expect(driver.handle(request('click', { ref: 'ax-7' }))).rejects.toThrow(/native DOM node/);
    expect(sendCommand.mock.calls.some(([method]) => method.startsWith('Input.'))).toBe(false);
  } finally { driver.dispose(); }
});

it.each([{ quads: [] }, { quads: [[10, 10, 10, 10, 10, 10, 10, 10]] }, { quads: [[900, 900, 940, 900, 940, 940, 900, 940]] }])(
  'refuses hidden, zero-area, or fully clipped native layouts', async ({ quads }) => {
    const { driver, request, sendCommand } = harness();
    const native = sendCommand.getMockImplementation()!;
    sendCommand.mockImplementation(async (method, args) => method === 'DOM.getContentQuads' ? { quads } : native(method, args));
    try {
      await driver.handle(request('probe'));
      await expect(driver.handle(request('click', { ref: 'ax-7' }))).rejects.toThrow(/no visible non-zero layout/);
      expect(sendCommand.mock.calls.some(([method]) => method.startsWith('Input.'))).toBe(false);
    } finally { driver.dispose(); }
  });

it('clips native transformed quads to the viewport before choosing a click point', async () => {
  const { driver, request, sendCommand } = harness();
  const native = sendCommand.getMockImplementation()!;
  sendCommand.mockImplementation(async (method, args) => {
    if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 30, clientHeight: 40 } };
    if (method === 'DOM.getContentQuads') return { quads: [[-20, 10, 40, 10, 40, 40, -20, 40]] };
    return native(method, args);
  });
  try {
    await driver.handle(request('probe'));
    expect(await driver.handle(request('click', { ref: 'ax-7' }))).toEqual({ x: 15, y: 25 });
  } finally { driver.dispose(); }
});

it.each([false, true])('validates native hit testing against the target or its descendant (%s)', async descendant => {
  const { driver, request, sendCommand } = harness();
  const native = sendCommand.getMockImplementation()!;
  sendCommand.mockImplementation(async (method, args) => {
    if (method === 'DOM.getNodeForLocation') return { backendNodeId: 8 };
    if (method === 'Runtime.callFunctionOn') return { result: { value: descendant } };
    return native(method, args);
  });
  try {
    await driver.handle(request('probe'));
    if (descendant) expect(await driver.handle(request('click', { ref: 'ax-7' }))).toEqual({ x: 40, y: 50 });
    else {
      await expect(driver.handle(request('click', { ref: 'ax-7' }))).rejects.toThrow(/covered by another element/);
      expect(sendCommand.mock.calls.some(([method]) => method.startsWith('Input.'))).toBe(false);
    }
    expect(sendCommand.mock.calls.filter(([method]) => method === 'Runtime.callFunctionOn')
      .every(([, args]) => !String(args?.functionDeclaration).includes('.click('))).toBe(true);
  } finally { driver.dispose(); }
});

it.each(['node', 'layout', 'document', 'user'] as const)('rejects a %s change during native point validation', async change => {
  const { driver, request, sendCommand, guest, focus } = harness();
  const native = sendCommand.getMockImplementation()!;
  let descriptions = 0, layouts = 0;
  sendCommand.mockImplementation(async (method, args) => {
    if (method === 'DOM.describeNode' && ++descriptions > 1 && change === 'node') return { node: { backendNodeId: 8, nodeType: 1 } };
    if (method === 'DOM.getContentQuads') {
      layouts++;
      if (change === 'layout' && layouts > 1) return { quads: [[30, 30, 70, 30, 70, 70, 30, 70]] };
      if (change === 'document') guest.emit('did-navigate');
      if (change === 'user') { focus(true); guest.emit('input-event', {}, { type: 'mouseDown' }); }
    }
    return native(method, args);
  });
  try {
    await driver.handle(request('probe'));
    await expect(driver.handle(request('click', { ref: 'ax-7' }))).rejects.toThrow(/changed|USER_ACTIVE_ON_TARGET_TAB/);
    expect(sendCommand.mock.calls.some(([method]) => method.startsWith('Input.'))).toBe(false);
  } finally { driver.dispose(); }
});

it('types into the exact element validated by the click chain without resolving a second locator', async () => {
  const { driver, request, sendCommand } = harness();
  try {
    await driver.handle(request('probe'));
    expect(await driver.handle(request('type', { ref: 'ax-7', text: 'sample' }))).toEqual({ ok: true });
    expect(sendCommand.mock.calls.filter(([method]) => method === 'DOM.resolveNode')).toHaveLength(1);
    expect(sendCommand).toHaveBeenCalledWith('Input.insertText', { text: 'sample' });
  } finally { driver.dispose(); }
});

it.each(['exception', 'unfocused', 'document'] as const)('does not insert text after an editable receiver %s', async change => {
  const { driver, request, sendCommand, guest } = harness();
  const native = sendCommand.getMockImplementation()!;
  sendCommand.mockImplementation(async (method, args) => {
    if (method === 'Runtime.callFunctionOn' && String(args?.functionDeclaration).includes('this.select()')) {
      if (change === 'exception') return { exceptionDetails: { exception: { description: 'Error: Element is not editable' } }, result: { objectId: 'exception' } };
      if (change === 'document') guest.emit('did-navigate');
    }
    if (method === 'Runtime.callFunctionOn' && String(args?.functionDeclaration).includes('activeElement') && change === 'unfocused') return { result: { value: false } };
    return native(method, args);
  });
  try {
    await driver.handle(request('probe'));
    await expect(driver.handle(request('type', { ref: 'ax-7', text: 'sample' }))).rejects.toThrow(/not editable|receiver changed|document changed/);
    expect(sendCommand.mock.calls.some(([method]) => method === 'Input.insertText')).toBe(false);
  } finally { driver.dispose(); }
});

it('reports unsupported snapshot boxes instead of silently returning an unboxed snapshot', async () => {
  const { driver, request, sendCommand } = harness();
  try {
    await driver.handle(request('probe'));
    await expect(driver.handle(request('snapshot', { boxes: true }))).rejects.toThrow(/snapshot boxes are not supported/);
    expect(sendCommand.mock.calls.some(([method]) => method === 'Accessibility.getFullAXTree')).toBe(false);
  } finally { driver.dispose(); }
});

it.each([{ x: null, y: 10 }, { x: 20 }, { x: -1, y: 20 }, { x: 800, y: 20 }])(
  'refuses invalid or out-of-viewport coordinate input', async coordinates => {
    const { driver, request, sendCommand } = harness();
    try {
      await driver.handle(request('probe'));
      await expect(driver.handle(request('click', coordinates))).rejects.toThrow(/finite x\/y|outside the visible viewport/);
      expect(sendCommand.mock.calls.some(([method]) => method.startsWith('Input.'))).toBe(false);
    } finally { driver.dispose(); }
  });

it.each(['overlay', 'layout', 'document'] as const)('refuses a second click after a first-click %s change', async change => {
  const { driver, request, sendCommand, guest } = harness();
  const native = sendCommand.getMockImplementation()!;
  let presses = 0;
  sendCommand.mockImplementation(async (method, args) => {
    if (method === 'Input.dispatchMouseEvent' && args?.type === 'mousePressed') {
      presses++;
      if (change === 'document') guest.emit('did-navigate');
    }
    if (presses && change === 'overlay' && method === 'DOM.getNodeForLocation') return { backendNodeId: 8 };
    if (presses && change === 'overlay' && method === 'Runtime.callFunctionOn') return { result: { value: false } };
    if (presses && change === 'layout' && method === 'DOM.getContentQuads') return { quads: [[30, 30, 70, 30, 70, 70, 30, 70]] };
    return native(method, args);
  });
  try {
    await driver.handle(request('probe'));
    await expect(driver.handle(request('click', { ref: 'ax-7', doubleClick: true }))).rejects.toThrow(/covered|changed/);
    expect(sendCommand.mock.calls.filter(([method, args]) => method === 'Input.dispatchMouseEvent' && args?.type === 'mousePressed')).toHaveLength(1);
    expect(sendCommand.mock.calls.filter(([method, args]) => method === 'Input.dispatchMouseEvent' && args?.type === 'mouseReleased')).toHaveLength(1);
  } finally { driver.dispose(); }
});

it('accepts a composed shadow descendant as the native click hit target', async () => {
  const { driver, request, sendCommand } = harness();
  const native = sendCommand.getMockImplementation()!;
  const target = {}, child = { getRootNode: () => ({ host: target }) };
  sendCommand.mockImplementation(async (method, args) => {
    if (method === 'DOM.getNodeForLocation') return { backendNodeId: 8 };
    if (method === 'Runtime.callFunctionOn') {
      const fn = runInNewContext(`(${String(args?.functionDeclaration)})`, { Node: { prototype: { contains: () => false } } });
      return { result: { value: fn.call(target, child) } };
    }
    return native(method, args);
  });
  try {
    await driver.handle(request('probe'));
    expect(await driver.handle(request('click', { ref: 'ax-7' }))).toEqual({ x: 40, y: 50 });
  } finally { driver.dispose(); }
});

it('proves the active editable receiver through each shadow root before inserting text', async () => {
  const { driver, request, sendCommand } = harness();
  const native = sendCommand.getMockImplementation()!;
  const document: any = {}, shadow: any = {};
  const host = { getRootNode: () => document };
  const editable = { isConnected: true, disabled: false, readOnly: false, ownerDocument: document, getRootNode: () => shadow };
  document.activeElement = host; shadow.host = host; shadow.activeElement = editable;
  sendCommand.mockImplementation(async (method, args) => {
    if (method === 'Runtime.callFunctionOn' && String(args?.functionDeclaration).includes('root.activeElement')) {
      const fn = runInNewContext(`(${String(args?.functionDeclaration)})`);
      return { result: { value: fn.call(editable) } };
    }
    return native(method, args);
  });
  try {
    await driver.handle(request('probe'));
    expect(await driver.handle(request('type', { ref: 'ax-7', text: 'sample' }))).toEqual({ ok: true });
    expect(sendCommand).toHaveBeenCalledWith('Input.insertText', { text: 'sample' });
  } finally { driver.dispose(); }
});

it('rejects a read-only field before dispatching its initial click', async () => {
  const { driver, request, sendCommand } = harness();
  const native = sendCommand.getMockImplementation()!;
  sendCommand.mockImplementation(async (method, args) => {
    if (method === 'Runtime.callFunctionOn' && String(args?.functionDeclaration).includes("this.tagName==='TEXTAREA'")) {
      const fn = runInNewContext(`(${String(args?.functionDeclaration)})`);
      return { result: { value: fn.call({ isConnected: true, tagName: 'INPUT', type: 'text', readOnly: true }) } };
    }
    return native(method, args);
  });
  try {
    await driver.handle(request('probe'));
    await expect(driver.handle(request('type', { ref: 'ax-7', text: 'sample' }))).rejects.toThrow(/not editable/);
    expect(sendCommand.mock.calls.some(([method]) => method.startsWith('Input.'))).toBe(false);
  } finally { driver.dispose(); }
});

it('does not submit Enter after insertion changes the exact field focus', async () => {
  const { driver, request, sendCommand } = harness();
  const native = sendCommand.getMockImplementation()!;
  let inserted = false;
  sendCommand.mockImplementation(async (method, args) => {
    if (method === 'Input.insertText') inserted = true;
    if (inserted && method === 'Runtime.callFunctionOn' && String(args?.functionDeclaration).includes('root.activeElement')) return { result: { value: false } };
    return native(method, args);
  });
  try {
    await driver.handle(request('probe'));
    await expect(driver.handle(request('type', { ref: 'ax-7', text: 'sample', submit: true }))).rejects.toThrow(/receiver changed/);
    expect(sendCommand).toHaveBeenCalledWith('Input.insertText', { text: 'sample' });
    expect(sendCommand.mock.calls.some(([method]) => method === 'Input.dispatchKeyEvent')).toBe(false);
  } finally { driver.dispose(); }
});

it.each(['exception', 'unavailable option', 'disabled optgroup', 'disabled fieldset'] as const)('reports a select %s without returning a success', async change => {
  const { driver, request, sendCommand } = harness();
  const native = sendCommand.getMockImplementation()!;
  let assignments = 0, events = 0;
  const option = { value: 'existing', disabled: false, matches: () => change === 'disabled optgroup',
    get selected() { return true; }, set selected(_value: boolean) { assignments++; } };
  const value = change === 'unavailable option' ? 'missing' : 'existing';
  sendCommand.mockImplementation(async (method, args) => {
    if (method === 'Runtime.callFunctionOn') {
      if (change === 'exception') return { exceptionDetails: { exception: { description: 'Error: Target is not an enabled select' } }, result: { objectId: 'exception' } };
      try {
        const fn = runInNewContext(`(${String(args?.functionDeclaration)})`, { Event: class {} });
        return { result: { value: fn.call({ isConnected: true, disabled: false, matches: () => change === 'disabled fieldset',
          tagName: 'SELECT', multiple: false,
          options: [option], dispatchEvent: () => { events++; }, value: 'existing' }, [value]) } };
      } catch (error) { return { exceptionDetails: { exception: { description: String(error) } }, result: { objectId: 'exception' } }; }
    }
    return native(method, args);
  });
  try {
    await driver.handle(request('probe'));
    await expect(driver.handle(request('selectOption', { ref: 'ax-7', values: [value] }))).rejects.toThrow(/select option failed/);
    expect(assignments).toBe(0); expect(events).toBe(0);
    expect(sendCommand).toHaveBeenCalledWith('Runtime.releaseObject', { objectId: 'object-7' });
  } finally { driver.dispose(); }
});

it('records only navigations from the attached in-app webview', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-webview-history-'));
  try {
    const { driver, guest } = harness();
    const store = new BrowserHistoryStore(path.join(root, 'in-app-browser-history.json'));
    driver.setHistoryStore(store);
    guest.emit('did-stop-loading');
    expect(store.list().map(entry => entry.url)).toEqual(['https://example.com/']);
    guest.emit('did-stop-loading');
    expect(store.list()).toHaveLength(1);
    guest.emit('did-start-navigation', { isMainFrame: true, url: 'https://example.com/' });
    guest.emit('did-stop-loading');
    expect(store.list()).toHaveLength(2);
    expect(store.list()[0]?.id).not.toBe(store.list()[1]?.id);
    guest.emit('page-title-updated');
    expect(store.list()).toHaveLength(2);
    guest.emit('destroyed');
    driver.dispose();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('ends Agent task device choices when the tab moves to another origin or closes', () => {
  const { driver, guest, navigate } = harness();
  const tasks = driver.taskSitePermissions;
  const origin = 'https://example.com';
  try {
    tasks.set(27, origin, 'camera', true, () => true);
    guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: `${origin}/room` });
    navigate(`${origin}/room`);
    guest.emit('did-navigate');
    guest.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false, url: 'https://frame.test/' });
    expect(tasks.decision(27, origin, 'camera')).toBe(true);
    guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'https://other.test/' });
    expect(tasks.decision(27, origin, 'camera')).toBeUndefined();
    tasks.set(27, origin, 'camera', true, () => true);
    guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: `${origin}/redirect` });
    navigate('https://other.test/landing');
    guest.emit('did-navigate');
    navigate(`${origin}/room`);
    expect(tasks.decision(27, origin, 'camera')).toBeUndefined();
    tasks.set(27, origin, 'microphone', true, () => true);
    guest.emit('destroyed');
    expect(tasks.decision(27, origin, 'microphone')).toBeUndefined();
  } finally { driver.dispose(); }
});

it('marks Agent navigations separately from user address-bar navigation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-webview-sources-'));
  try {
    const { driver, guest, host, request } = harness();
    const store = new BrowserHistoryStore(path.join(root, 'in-app-browser-history.json'));
    driver.setHistoryStore(store);
    await driver.handle(request('probe'));
    await driver.handle(request('allowOrigin', { origin: 'https://agent.example' }));
    await driver.handle(request('navigate', { url: 'https://agent.example/' }));
    guest.emit('did-stop-loading');
    expect(store.list()[0]).toMatchObject({ url: 'https://agent.example/', visitSource: 'agent' });
    driver.markUserNavigation(27, host as any);
    await guest.loadURL('https://user.example/');
    guest.emit('did-start-navigation', { isMainFrame: true, url: 'https://user.example/' });
    guest.emit('did-stop-loading');
    expect(store.list()[0]).toMatchObject({ url: 'https://user.example/', visitSource: 'other' });
    expect(() => driver.markUserNavigation(27, {} as any)).toThrow(/unavailable/);
    driver.dispose();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('opens a new visible tab for an Agent navigation while retaining the user tab', async () => {
  const { driver, request, host, guest } = harness();
  host.webContents.send.mockImplementation((_channel: string, target: string) => {
    const next = Object.assign(new EventEmitter(), { ...guest, id: 28,
      getURL: () => target, getTitle: () => 'New tab' });
    next.removeAllListeners();
    driver.attach(next as any, host as any);
    next.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: target });
    next.emit('did-finish-load');
  });
  const result = await driver.handle(request('openTab', { url: 'https://example.com/guide', scopeKey: 'chat-owner' }));
  expect(host.webContents.send).toHaveBeenCalledWith('memmy:browser:open-url', 'https://example.com/guide', { scopeKey: 'chat-owner' });
  expect(result).toMatchObject({ tabId: 28, url: 'https://example.com/guide' });
  expect(await driver.handle(request('listTabs'))).toMatchObject({ selectedTabId: 27 });
  driver.selectTab(27, host as any);
  expect(await driver.handle(request('probe'))).toMatchObject({ tabId: 27, url: 'https://example.com/' });
  driver.selectTab(28, host as any);
  expect(await driver.handle(request('probe'))).toMatchObject({ tabId: 28, url: 'https://example.com/guide' });
  expect(await driver.handle(request('listTabs'))).toMatchObject({
    selectedTabId: 28, tabs: [{ tabId: 27 }, { tabId: 28 }],
  });
  expect(await driver.handle(request('snapshot'))).toMatchObject({ tab: { id: 27 } });
  driver.dispose();
});

it('refuses an ownerless Agent open request before creating or selecting a tab', async () => {
  const { driver, request, host } = harness();
  try {
    for (const scopeKey of [undefined, '', '   ', 'x'.repeat(513), 'scope\nother', false, {}]) {
      await expect(driver.handle(request('openTab', { url: 'https://example.com/guide', scopeKey })))
        .rejects.toThrow('Browser tab owner is required');
    }
    expect(host.webContents.send).not.toHaveBeenCalled();
    expect(await driver.handle(request('listTabs'))).toMatchObject({ selectedTabId: 27, tabs: [{ tabId: 27 }] });
  } finally { driver.dispose(); }
});

it('skips the initial blank webview when a new browser panel mounts before the requested tab', async () => {
  const { driver, request, host, guest } = harness();
  host.webContents.send.mockImplementation((_channel: string, target: string) => {
    const blank = Object.assign(new EventEmitter(), { ...guest, id: 28,
      getURL: () => 'about:blank', getTitle: () => '' });
    blank.removeAllListeners();
    driver.attach(blank as any, host as any);
    const requested = Object.assign(new EventEmitter(), { ...guest, id: 29,
      getURL: () => target, getTitle: () => 'Requested tab' });
    requested.removeAllListeners();
    driver.attach(requested as any, host as any);
    requested.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: target });
    requested.emit('did-finish-load');
  });
  await expect(driver.handle(request('openTab', { url: 'https://example.com/guide', scopeKey: 'chat-owner' })))
    .resolves.toMatchObject({ tabId: 29, url: 'https://example.com/guide' });
  expect(await driver.handle(request('listTabs'))).toMatchObject({
    tabs: [{ tabId: 27 }, { tabId: 28, url: 'about:blank' }, { tabId: 29 }],
  });
  driver.dispose();
});

it('waits out brief user input in that browser tab, stops on continued use and rejects stale tab IDs', async () => {
  const { driver, request, sendCommand, focus, guest } = harness();
  const presses = () => sendCommand.mock.calls.filter(([method, args]) =>
    method === 'Input.dispatchMouseEvent' && args?.type === 'mousePressed').length;
  vi.useFakeTimers();
  try {
    await driver.handle(request('probe'));
    focus(true);
    expect(await driver.handle(request('click', { ref: 'ax-7' }))).toEqual({ x: 40, y: 50 });
    guest.emit('before-input-event', {}, { type: 'keyDown', key: 'Meta' });
    guest.emit('before-input-event', {}, { type: 'keyUp', key: 'Tab' });
    expect(await driver.handle(request('click', { ref: 'ax-7' }))).toEqual({ x: 40, y: 50 });
    expect(presses()).toBe(2);

    guest.emit('input-event', {}, { type: 'mouseDown' });
    const settled = driver.handle(request('click', { ref: 'ax-7' }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(presses()).toBe(2);
    await vi.advanceTimersByTimeAsync(1_200);
    await expect(settled).resolves.toEqual({ x: 40, y: 50 });
    expect(presses()).toBe(3);

    const typing = setInterval(() => guest.emit('before-input-event', {}, { type: 'keyDown', key: 'a' }), 500);
    guest.emit('before-input-event', {}, { type: 'keyDown', key: 'a' });
    const blocked = expect(driver.handle(request('click', { ref: 'ax-7' })))
      .rejects.toThrow('USER_ACTIVE_ON_TARGET_TAB');
    await vi.advanceTimersByTimeAsync(8_200);
    clearInterval(typing);
    await blocked;
    expect(presses()).toBe(3);

    await vi.advanceTimersByTimeAsync(2_000);
    let current = true;
    guest.emit('input-event', {}, { type: 'mouseDown' });
    const cancelled = expect(driver.handle(request('click', { ref: 'ax-7' }), undefined, undefined, () => current))
      .rejects.toThrow(/canceled/);
    await vi.advanceTimersByTimeAsync(400);
    current = false;
    await vi.advanceTimersByTimeAsync(400);
    await cancelled;
    expect(presses()).toBe(3);
  } finally { vi.useRealTimers(); }
  focus(false);
  await expect(driver.handle({ ...request('snapshot'), tabId: 28 })).rejects.toThrow(/no longer open/);
  driver.dispose();
});

it('issues an exact current tab mention and closes the addressed webview', async () => {
  const { driver, request, host } = harness();
  const mention = parseEmbeddedBrowserTabMention(driver.tabMention(27, host as any));
  expect(mention).toMatchObject({ tabId: 27, title: 'Example', url: 'https://example.com/' });
  expect((await driver.handle(request('listTabs')) as any).browserId).toBe(mention?.browserId);
  expect(await driver.handle(request('closeTab'))).toEqual({ closed: true });
  expect(host.webContents.send).toHaveBeenCalledWith('memmy:browser:close-tab', 27);
  await expect(driver.handle(request('snapshot'))).rejects.toThrow(/no longer open/);
  driver.dispose();
});

function playwrightHarness() {
  const test = harness();
  let allowed = true, current = true;
  const approval = { origin: 'https://example.com', isAllowed: () => allowed, isCurrentChild: () => current };
  const id = 'a'.repeat(32);
  const events: Array<{ leaseId: string; method: string; params: Record<string, unknown>; sessionId?: string }> = [];
  const run = (command: EmbeddedBrowserRequest['command'], args: Record<string, unknown> = {}, upload?: any) =>
    test.driver.handle(test.request(command, { approvedOrigin: 'https://example.com', leaseId: id, ...args }), upload, approval,
      () => current, event => { events.push(event); });
  return { ...test, id, run, approval, events, start: (input = false, args: Record<string, unknown> = {}, upload?: any) =>
    run('playwrightStart', { input, fresh: true, ...args }, upload),
    setAllowed: (value: boolean) => { allowed = value; }, setCurrent: (value: boolean) => { current = value; } };
}

it('focuses only the exact guest for an input lease and stops before dispatch if the host regains focus', async () => {
  const test = playwrightHarness();
  try {
    await test.driver.handle(test.request('allowOrigin', { origin: 'https://example.com' }));
    test.focusFrame({ frameTreeNodeId: 99 });
    await test.start(true);
    expect(test.host.webContents.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('getWebContentsId() === 27'));
    expect(test.guest.backgroundThrottling).toBe(false);
    await test.run('playwrightCdp', { method: 'Input.insertText', params: { text: 'exact guest' } });
    test.sendCommand.mockClear();
    test.focusFrame({ frameTreeNodeId: 99 });
    await expect(test.run('playwrightCdp', { method: 'Input.insertText', params: { text: 'never sent' } }))
      .rejects.toThrow(/input receiver changed/);
    expect(test.sendCommand).not.toHaveBeenCalled();
    await test.run('playwrightEnd');
    expect(test.guest.backgroundThrottling).toBe(true);
    expect(test.guest.focus).not.toHaveBeenCalled();
    expect(test.host.show).not.toHaveBeenCalled();
  } finally { test.driver.dispose(); }
});

it('does not focus or change animation throttling for observation leases', async () => {
  const test = playwrightHarness();
  try {
    await test.driver.handle(test.request('allowOrigin', { origin: 'https://example.com' }));
    await test.start(false);
    expect(test.host.webContents.executeJavaScript).not.toHaveBeenCalled();
    expect(test.guest.setBackgroundThrottling).not.toHaveBeenCalled();
  } finally { test.driver.dispose(); }
});

it('waits for real typing in the host composer and leaves its focus alone during continued use', async () => {
  vi.useFakeTimers();
  const test = playwrightHarness();
  let repeated: ReturnType<typeof setInterval> | undefined;
  try {
    await test.driver.handle(test.request('allowOrigin', { origin: 'https://example.com' }));
    const type = () => test.host.webContents.emit('before-input-event', {}, { type: 'keyDown', key: 'a' });
    type(); repeated = setInterval(type, 200);
    const starting = test.start(true).then(() => null, error => error);
    await vi.advanceTimersByTimeAsync(8_001);
    expect((await starting)?.message).toBe('USER_ACTIVE_ON_TARGET_TAB');
    expect(test.host.webContents.executeJavaScript).not.toHaveBeenCalled();
    expect(test.guest.setBackgroundThrottling).not.toHaveBeenCalled();
  } finally { clearInterval(repeated); vi.useRealTimers(); test.driver.dispose(); }
});

it('ignores its own keyboard input echoed by the host and removes host listeners on disposal', async () => {
  const test = playwrightHarness();
  try {
    await test.driver.handle(test.request('allowOrigin', { origin: 'https://example.com' }));
    await test.start(true);
    const send = test.sendCommand.getMockImplementation()!;
    test.sendCommand.mockImplementation(async (method, args) => {
      if (method === 'Input.insertText') test.host.webContents.emit('before-input-event', {}, { type: 'keyDown', key: 'a' });
      return send(method, args);
    });
    await test.run('playwrightCdp', { method: 'Input.insertText', params: { text: 'first' } });
    await test.run('playwrightCdp', { method: 'Input.insertText', params: { text: 'second' } });
    expect(test.sendCommand.mock.calls.filter(([method]) => method === 'Input.insertText')).toHaveLength(2);
    test.driver.dispose();
    expect(test.host.webContents.listenerCount('before-input-event')).toBe(0);
  } finally { test.driver.dispose(); }
});

it.each(['focus-failed', 'cancelled', 'navigation', 'expired'] as const)('restores animation throttling when an input lease is %s', async failure => {
  const test = playwrightHarness();
  try {
    await test.driver.handle(test.request('allowOrigin', { origin: 'https://example.com' }));
    if (failure === 'focus-failed') test.host.webContents.executeJavaScript.mockResolvedValueOnce(false);
    if (failure === 'cancelled') test.host.webContents.executeJavaScript.mockImplementationOnce(async () => {
      test.setCurrent(false); return true;
    });
    if (failure === 'focus-failed' || failure === 'cancelled') await expect(test.start(true)).rejects.toThrow();
    else {
      if (failure === 'expired') vi.useFakeTimers();
      await test.start(true);
      if (failure === 'navigation') test.guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'https://example.com/next' });
      else await vi.advanceTimersByTimeAsync(45_001);
    }
    expect(test.guest.backgroundThrottling).toBe(true);
    expect(test.guest.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
  } finally { vi.useRealTimers(); test.driver.dispose(); }
});

it('restores an already unthrottled guest without enabling throttling, and ignores stale lease cleanup', async () => {
  const test = playwrightHarness();
  test.guest.backgroundThrottling = false;
  try {
    await test.driver.handle(test.request('allowOrigin', { origin: 'https://example.com' }));
    await test.start(true); await test.run('playwrightEnd');
    expect(test.guest.backgroundThrottling).toBe(false);
    await test.start(true, { leaseId: 'b'.repeat(32) });
    test.guest.setBackgroundThrottling.mockClear();
    await test.run('playwrightEnd');
    expect(test.guest.setBackgroundThrottling).not.toHaveBeenCalled();
  } finally { test.driver.dispose(); }
});

it('starts the built-in executor only with current site access and a fixed explicit tab', async () => {
  const test = playwrightHarness();
  try {
    await test.driver.handle(test.request('allowOrigin', { origin: 'https://example.com' }));
    await expect(test.driver.handle(test.request('playwrightStart', { leaseId: test.id, approvedOrigin: 'https://example.com', input: false, fresh: true })))
      .rejects.toThrow(/cancelled|permission/);
    expect(test.guest.debugger.attach).not.toHaveBeenCalled();
    expect(await test.start()).toMatchObject({ targetInfo: { targetId: 'target-27', type: 'page' },
      frameTree: { frame: { id: 'frame-27' } }, childTargets: [], documentEpoch: 0 });
    expect(test.sendCommand).toHaveBeenCalledWith('Runtime.disable', {});
    await expect(test.run('playwrightCdp', { method: 'Page.captureScreenshot', params: {} }))
      .rejects.toThrow(/Screenshots are not supported/);
  } finally { test.driver.dispose(); }
});

it('limits observation leases, rejects browser-wide/foreign targets and cancels before sending input', async () => {
  const test = playwrightHarness();
  try {
    await test.driver.handle(test.request('allowOrigin', { origin: 'https://example.com' })); await test.start();
    test.sendCommand.mockClear();
    await expect(test.run('playwrightCdp', { method: 'Input.insertText', params: { text: 'forbidden' } })).rejects.toThrow(/observation cannot send input/);
    for (const method of ['Browser.close', 'Storage.getCookies', 'Target.createTarget', 'Target.attachToTarget']) {
      await expect(test.run('playwrightCdp', { method, params: {} })).rejects.toThrow(/method is unavailable/);
    }
    await expect(test.run('playwrightCdp', { method: 'Target.getTargetInfo', params: { targetId: 'another-browser-tab' } }))
      .rejects.toThrow(/outside this tab/);
    expect(test.sendCommand).not.toHaveBeenCalled();
    await test.run('playwrightEnd'); await test.start(true); test.sendCommand.mockClear();
    test.setAllowed(false);
    await expect(test.run('playwrightCdp', { method: 'Input.insertText', params: { text: 'never-sent' } })).rejects.toThrow(/revoked/);
    test.setAllowed(true); test.setCurrent(false);
    await expect(test.run('playwrightCdp', { method: 'Input.insertText', params: { text: 'never-sent' } })).rejects.toThrow(/cancelled/);
    expect(test.sendCommand).not.toHaveBeenCalled();
  } finally { test.driver.dispose(); }
});

it('revokes same-site old documents, protects the current owner from stale End and avoids duplicate debugger listeners', async () => {
  const test = playwrightHarness();
  try {
    await test.driver.handle(test.request('allowOrigin', { origin: 'https://example.com' })); await test.start();
    test.guest.emit('did-navigate');
    await expect(test.run('playwrightCdp', { method: 'Runtime.evaluate', params: { expression: 'document.title' } }))
      .rejects.toThrow(/lease expired/);
    await test.start(); await test.run('playwrightEnd');
    const replacement = 'b'.repeat(32);
    await test.run('playwrightStart', { leaseId: replacement, input: false, fresh: true });
    await test.run('playwrightEnd', { detach: true });
    expect(test.guest.debugger.detach).not.toHaveBeenCalled();
    test.setCurrent(false);
    await expect(test.run('playwrightEnd', { leaseId: replacement, detach: true })).resolves.toEqual({ ok: true });
    expect(test.guest.debugger.detach).toHaveBeenCalledTimes(1);
    test.setCurrent(true); await test.start();
    expect(test.guest.debugger.listenerCount('message')).toBe(1);
    expect(test.guest.debugger.listenerCount('detach')).toBe(1);
  } finally { test.driver.dispose(); }
});

it.each([
  { label: 'main frame navigation', method: 'Page.frameNavigated', params: { frame: { id: 'frame-27', url: 'https://example.com/' } } },
  { label: 'same-process iframe reload', method: 'Page.frameNavigated', params: { frame: { id: 'iframe-1', parentId: 'frame-27', url: 'https://frame.test/form' } } },
  { label: 'OOPIF reload', method: 'Page.frameNavigated', params: { frame: { id: 'iframe-1', parentId: 'frame-27', url: 'https://frame.test/form' } }, sessionId: 'session-1' },
  { label: 'iframe attachment', method: 'Page.frameAttached', params: { frameId: 'iframe-1', parentFrameId: 'frame-27' } },
  { label: 'iframe removal', method: 'Page.frameDetached', params: { frameId: 'iframe-1', reason: 'remove' } },
])('versions idle $label without revoking an active executor for frame metadata', async event => {
  const test = playwrightHarness();
  try {
    await test.driver.handle(test.request('allowOrigin', { origin: 'https://example.com' }));
    await test.driver.handle(test.request('viewport'));
    test.guest.debugger.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'session-1',
      targetInfo: { type: 'iframe', targetId: 'iframe-1', url: 'https://frame.test/form' } });
    const first = await test.start(false, { fresh: false }) as any;
    await test.run('playwrightEnd');
    test.guest.debugger.emit('message', {}, event.method, event.params, 'sessionId' in event ? event.sessionId : undefined);
    const second = await test.start(false, { fresh: false }) as any;
    expect(second.frameEpoch).toBe(first.frameEpoch + 1);
    expect(second.documentEpoch).toBe(first.documentEpoch);
    expect(second.cdpEpoch).toBe(first.cdpEpoch);
    expect(second.frameTree).toEqual(first.frameTree);
    expect(second.childTargets).toEqual(first.childTargets);
    expect(test.events.filter(item => item.method === event.method)).toEqual([]);
    test.guest.debugger.emit('message', {}, event.method, event.params, 'sessionId' in event ? event.sessionId : undefined);
    await expect(test.run('playwrightCdp', { method: 'Page.getLayoutMetrics', params: {} }))
      .resolves.toMatchObject({ cssVisualViewport: { clientWidth: 800 } });
  } finally { test.driver.dispose(); }
});

it('does not replace a new executor owner after an older Start finishes waiting for user idle', async () => {
  const test = playwrightHarness();
  let resume!: () => void, entered = false;
  const idle = vi.spyOn(test.driver as any, 'waitForUserIdle').mockImplementationOnce(async () => {
    entered = true;
    await new Promise<void>(resolve => { resume = resolve; });
  });
  try {
    await test.driver.handle(test.request('allowOrigin', { origin: 'https://example.com' }));
    const waiting = test.start(true);
    const checked = expect(waiting).rejects.toThrow(/already busy/);
    await vi.waitFor(() => expect(entered).toBe(true));
    const replacement = 'b'.repeat(32);
    await test.run('playwrightStart', { leaseId: replacement, input: false, fresh: false });
    test.sendCommand.mockClear();
    resume(); await checked;
    expect(test.sendCommand).not.toHaveBeenCalled();
    await expect(test.run('playwrightCdp', { leaseId: replacement, method: 'Page.getLayoutMetrics', params: {} }))
      .resolves.toMatchObject({ cssVisualViewport: { clientWidth: 800 } });
  } finally { resume?.(); idle.mockRestore(); test.driver.dispose(); }
});

it('pushes only current-lease executor events and reports a revoked lease to the waiting executor', async () => {
  const test = playwrightHarness();
  try {
    await test.driver.handle(test.request('allowOrigin', { origin: 'https://example.com' })); await test.start();
    test.guest.debugger.emit('message', {}, 'Runtime.executionContextCreated', { context: { id: 4 } });
    expect(test.events.at(-1)).toEqual({ leaseId: test.id, method: 'Runtime.executionContextCreated', params: { context: { id: 4 } } });
    await test.run('playwrightEnd');
    const ended = test.events.length;
    test.guest.debugger.emit('message', {}, 'Page.lifecycleEvent', { name: 'load', frameId: 'frame-27' });
    expect(test.events).toHaveLength(ended);
    await test.start();
    test.guest.emit('did-start-navigation', { isMainFrame: true, url: 'https://example.com/reloaded' });
    expect(test.events.at(-1)).toEqual({ leaseId: test.id, method: 'Memmy.executorRevoked', params: { reason: 'navigation' } });
    await expect(test.run('playwrightCdp', { method: 'Page.getLayoutMetrics', params: {} })).rejects.toThrow(/page changed|lease expired/);
  } finally { test.driver.dispose(); }
});

it('permits only an existing iframe session without a metadata round trip and detects frame replacement during a call', async () => {
  const test = playwrightHarness();
  try {
    await test.driver.handle(test.request('allowOrigin', { origin: 'https://example.com' })); await test.start();
    await expect(test.run('playwrightCdp', { method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: 'foreign-session' }))
      .rejects.toThrow(/frame changed/);
    const info = { targetId: 'iframe-1', type: 'iframe', url: 'https://frame.test/form' };
    test.guest.debugger.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'session-1', targetInfo: info });
    const initial = test.sendCommand.getMockImplementation()!;
    test.sendCommand.mockImplementation(async (method, args) => {
      if (method === 'Target.getTargetInfo') throw new Error('Executor child commands must not query metadata first');
      if (method === 'Runtime.evaluate') {
        test.guest.debugger.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'iframe-1' } }, 'session-1');
        return { result: { value: 1 } };
      }
      return initial(method, args);
    });
    await expect(test.run('playwrightCdp', { method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: 'session-1' }))
      .rejects.toThrow(/frame changed/);
  } finally { test.driver.dispose(); }
});

it('retains typed upload permission only for matching stamped files and refuses mutation or ordinary leases', async () => {
  const test = playwrightHarness(), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-pw-upload-'));
  const file = path.join(directory, 'approved.txt'); fs.writeFileSync(file, 'approved');
  const stat = fs.lstatSync(file), upload = { origin: 'https://example.com', isCurrentChild: () => true, stamps: [{
    path: file, realPath: fs.realpathSync(file), dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs }] };
  try {
    await test.driver.handle(test.request('allowOrigin', { origin: 'https://example.com' })); await test.start(true);
    await expect(test.run('playwrightCdp', { method: 'DOM.setFileInputFiles', params: { files: [file], objectId: 'file-input' } }))
      .rejects.toThrow(/not approved/);
    await test.run('playwrightEnd');
    await expect(test.start(true, { uploadPaths: [file] })).rejects.toThrow(/not approved/);
    await test.start(true, { uploadPaths: [file] }, upload);
    await expect(test.run('playwrightCdp', { method: 'DOM.setFileInputFiles', params: { files: [file], objectId: 'file-input' } })).resolves.toEqual({});
    fs.writeFileSync(file, 'file changed after approval'); test.sendCommand.mockClear();
    await expect(test.run('playwrightCdp', { method: 'DOM.setFileInputFiles', params: { files: [file], objectId: 'file-input' } })).rejects.toThrow(/file changed/);
    expect(test.sendCommand).not.toHaveBeenCalled();
  } finally { test.driver.dispose(); fs.rmSync(directory, { recursive: true, force: true }); }
});

it.each([true, false])('fills required secure inputs (already known = %s) without changing an unspecified optional input', async known => {
  const { driver, request, sendCommand } = harness();
  await driver.handle(request('allowOrigin', { origin: 'https://example.com' }));
  class Input {
    isConnected = true; disabled = false; type = 'text';
    constructor(private currentValue: string) {}
    get value() { return this.currentValue; }
    set value(value: string) { this.currentValue = value; }
    getClientRects() { return [{}]; }
    dispatchEvent() {}
  }
  const code = new Input('old code'), optional = new Input('keep this optional value');
  const document = { URL: 'https://example.com/', defaultView: {
    HTMLInputElement: Input, Event: class { constructor(_name: string, _options: unknown) {} },
    getComputedStyle: () => ({ visibility: 'visible' }),
  }, querySelectorAll: (selector: string) => selector === '#code' ? [code] : selector === '#optional' ? [optional] : [] };
  sendCommand.mockImplementation(async (method: string, args?: Record<string, any>) => {
    if (method !== 'Runtime.evaluate') return {};
    return { result: { value: runInNewContext(args?.expression, { document }) } };
  });
  const collect = vi.fn(async metadata => {
    expect(metadata.fields.map((field: { id: string }) => field.id)).toEqual(['code']);
    return { values: { code: 'collected-code' } };
  });
  const result = await driver.requestAuth(27, { origin: 'https://example.com', fields: [
    { id: 'code', label: '验证码', type: 'text', required: true, selector: '#code' },
    { id: 'optional', label: 'Optional value', type: 'text', required: false, selector: '#optional' },
  ], provided_values: known ? { code: 'provided-code-246810' } : {} }, collect, () => true);
  expect(result).toEqual({ status: 'submitted' });
  expect(collect).toHaveBeenCalledTimes(known ? 0 : 1);
  expect(code.value).toBe(known ? 'provided-code-246810' : 'collected-code');
  expect(optional.value).toBe('keep this optional value');
  expect(JSON.stringify(result)).not.toContain('provided-code-246810');
  await expect(driver.handle(request('snapshot'))).rejects.toThrow(/credential protection/);
  driver.dispose();
});
