import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { EMBEDDED_BROWSER_REQUEST, parseEmbeddedBrowserTabMention,
  type EmbeddedBrowserRequest } from '@memmy/local-api-contracts';
import { EmbeddedBrowserDriver } from '../src/main/embedded-browser-driver.js';
import { BrowserHistoryStore } from '../src/main/browser-history-store.js';

function harness() {
  let url = 'https://example.com/';
  let focused = false;
  let destroyed = false;
  const browserSession = { partition: 'persist:memmy-browser' };
  const debuggerEvents = new EventEmitter();
  const sendCommand = vi.fn(async (method: string, args?: Record<string, any>) => {
    if (method === 'Accessibility.getFullAXTree') return { nodes: [
      { backendDOMNodeId: 7, role: { value: 'link' }, name: { value: 'Learn more' }, ignored: false },
    ] };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'object-7' } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: { x: 40, y: 50 } } };
    if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
    if (method === 'Runtime.evaluate') return { result: { value: 1 } };
    if (method === 'Page.captureScreenshot') return { data: 'AAAA' };
    return {};
  });
  const guest = Object.assign(new EventEmitter(), { id: 27,
    session: browserSession,
    isDestroyed: () => destroyed, isLoading: () => false,
    getURL: () => url, getTitle: () => 'Example', isFocused: () => focused,
    focus: vi.fn(), loadURL: vi.fn(async (target: string) => { url = target; }),
    debugger: Object.assign(debuggerEvents, { attach: vi.fn(), detach: vi.fn(), sendCommand }) });
  const host = { isDestroyed: () => false, show: vi.fn(),
    webContents: { send: vi.fn((channel: string, target: string | number) => {
      if (channel === 'memmy:browser:close-tab' && target === 27) {
        destroyed = true;
        guest.emit('destroyed');
      } else if (typeof target === 'string') url = target;
    }) } };
  const driver = new EmbeddedBrowserDriver(() => host as any);
  driver.attach(guest as any, host as any);
  const request = (command: EmbeddedBrowserRequest['command'], args: Record<string, unknown> = {}): EmbeddedBrowserRequest =>
    ({ type: EMBEDDED_BROWSER_REQUEST, requestId: 'test', tabId: 27, command, args });
  return { driver, request, sendCommand, guest, host, browserSession,
    navigate: (target: string) => { url = target; }, focus: (value: boolean) => { focused = value; } };
}

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
  sendCommand.mockImplementation(async (method: string, args?: Record<string, any>) => {
    if (method === 'Runtime.evaluate' && args?.expression?.includes('const found=doc?.querySelectorAll'))
      return { result: { objectId: 'frame-node' } };
    if (method === 'DOM.describeNode') return { node: { nodeName: 'IFRAME', frameId: 'frame-1' } };
    if (method === 'Target.getTargetInfo') return { targetInfo: {
      targetId: 'frame-1', url: 'https://identity.test/login' } };
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
    if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: args?.targetId,
      url: args?.targetId === 'frame-1' ? 'https://identity.test/' : 'https://challenge.test/' } };
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
  guest.emit('before-input-event');
  await expect(driver.handle(write, undefined, grant)).rejects.toThrow(/USER_ACTIVE/);
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

it('sends child CDP commands only to an attached same-site session and rejects navigation races', async () => {
  const { driver, request, guest, sendCommand } = harness();
  await driver.handle(request('allowOrigin', { origin: 'https://example.com' }));
  const grant = { origin: 'https://example.com', isCurrentChild: () => true,
    isAllowed: () => true, mode: 'write' as const };
  await driver.handle(request('cdpCall', { method: 'Page.getLayoutMetrics' }), undefined,
    { ...grant, mode: 'read' });
  guest.debugger.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'session-1',
    targetInfo: { type: 'iframe', targetId: 'child-1', url: 'https://example.com/frame' } });
  let childUrl = 'https://example.com/frame';
  sendCommand.mockImplementation(async (method: string) => method === 'Target.getTargetInfo'
    ? { targetInfo: { type: 'iframe', targetId: 'child-1', url: childUrl } } : {});
  await driver.handle(request('cdpWrite', { method: 'Input.dispatchMouseEvent',
    params: { type: 'mouseMoved', x: 1, y: 2 }, target: { targetId: 'child-1' } }), undefined, grant);
  expect(sendCommand.mock.calls.find(([method]) => method === 'Input.dispatchMouseEvent')?.[2])
    .toBe('session-1');
  sendCommand.mockClear();
  guest.debugger.emit('message', {}, 'Target.targetInfoChanged', {
    targetInfo: { type: 'iframe', targetId: 'child-1', url: 'https://other.test/frame' } });
  childUrl = 'https://other.test/frame';
  await expect(driver.handle(request('cdpCall', { method: 'Page.getLayoutMetrics',
    target: { sessionId: 'session-1' } }), undefined, { ...grant, mode: 'read' }))
    .resolves.toEqual({});
  expect(sendCommand.mock.calls.find(([method]) => method === 'Page.getLayoutMetrics')?.[2])
    .toBe('session-1');
  sendCommand.mockImplementation(async (method: string) => {
    if (method === 'Target.getTargetInfo') return { targetInfo: {
      type: 'iframe', targetId: 'child-1', url: childUrl,
    } };
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
    target: { sessionId: 'session-1' } }), undefined, { ...grant, mode: 'read' }))
    .rejects.toThrow(/child target site changed/);
  guest.debugger.emit('message', {}, 'Target.detachedFromTarget', { sessionId: 'session-1' });
  await expect(driver.handle(request('cdpCall', { method: 'Page.getLayoutMetrics',
    target: { sessionId: 'session-1' } }), undefined, { ...grant, mode: 'read' }))
    .rejects.toThrow(/not attached/);
  driver.dispose();
});

it('rechecks selection and origin after attaching CDP but before sending autofill values', async () => {
  const first = harness();
  const data = { kind: 'credential' as const, origin: 'https://example.com',
    username: 'sample-user', password: 'fake-secret' };
  first.sendCommand.mockImplementation(async (method: string) => {
    if (method === 'Page.enable') first.driver.attach(Object.assign(new EventEmitter(),
      { ...first.guest, id: 28 }) as any, first.host as any);
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
    driver.attach(next as any, host as any);
  });
  const result = await driver.handle(request('openTab', { url: 'https://example.com/guide' }));
  expect(host.webContents.send).toHaveBeenCalledWith('memmy:browser:open-url', 'https://example.com/guide');
  expect(result).toMatchObject({ tabId: 28, url: 'https://example.com/guide' });
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

it('skips the initial blank webview when a new browser panel mounts before the requested tab', async () => {
  const { driver, request, host, guest } = harness();
  host.webContents.send.mockImplementation((_channel: string, target: string) => {
    driver.attach(Object.assign(new EventEmitter(), { ...guest, id: 28,
      getURL: () => 'about:blank', getTitle: () => '' }) as any, host as any);
    driver.attach(Object.assign(new EventEmitter(), { ...guest, id: 29,
      getURL: () => target, getTitle: () => 'Requested tab' }) as any, host as any);
  });
  await expect(driver.handle(request('openTab', { url: 'https://example.com/guide' })))
    .resolves.toMatchObject({ tabId: 29, url: 'https://example.com/guide' });
  expect(await driver.handle(request('listTabs'))).toMatchObject({
    tabs: [{ tabId: 27 }, { tabId: 28, url: 'about:blank' }, { tabId: 29 }],
  });
  driver.dispose();
});

it('pauses writes on recent user input in that browser tab and rejects stale tab IDs', async () => {
  const { driver, request, sendCommand, focus, guest } = harness();
  await driver.handle(request('probe'));
  focus(true);
  expect(await driver.handle(request('click', { ref: 'ax-7' }))).toEqual({ x: 40, y: 50 });
  guest.emit('input-event', {}, { type: 'mouseDown' });
  await expect(driver.handle(request('click', { ref: 'ax-7' }))).rejects.toThrow('USER_ACTIVE_ON_TARGET_TAB');
  expect(sendCommand).toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed' }));
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
