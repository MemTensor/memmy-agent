import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RequestContext } from '../../../src/core/agent-runtime/tools/context.js';
import { ManagedOcuSession, OCU_TOOLS } from '../../../src/tools/computer-use/managed-ocu-session.js';
import { ManagedOcuSessionPool } from '../../../src/tools/computer-use/managed-ocu-session-pool.js';
import { NativeAppApprovalGate, NativeAppApprovalStore } from '../../../src/tools/computer-use/native-app-approvals.js';
import { browserAppKey, nativeAppKey } from '../../../src/tools/computer-use/native-app-key.js';
import { NativeAppLeases } from '../../../src/tools/computer-use/native-app-leases.js';

const APP_ID = 'Microsoft.Office.POWERPNT.EXE.15';
const runningApp = { appId: APP_ID, displayName: 'PowerPoint', processName: 'POWERPNT', pid: 2049, aliases: [] };
const listing = { content: [{ type: 'text', text: 'PowerPoint -- POWERPNT [running, pid=2049]' }],
  _meta: { memmyComputerUse: { runningApps: { version: 1, apps: [runningApp] } } } };
const state = { content: [{ type: 'text', text: 'Slide 1' }],
  _meta: { memmyComputerUse: { targetWindowID: 1001, pid: 2049, observationID: 'slides-observation' } } };
const context = new RequestContext({ messageId: 'user-message', sessionKey: 'slides-chat',
  channel: 'websocket', chatId: 'slides-chat' });
const roots: string[] = [];
const owners: ManagedOcuSession[] = [];

function owner(leases: NativeAppLeases, appWaitMs = 30) {
  const root = mkdtempSync(join(tmpdir(), 'memmy-app-lease-')); roots.push(root);
  const callTool = vi.fn(async (name: string): Promise<any> => name === 'list_apps' ? listing : state);
  const gate = new NativeAppApprovalGate(new NativeAppApprovalStore(join(root, 'approvals.json')),
    vi.fn().mockResolvedValue('allow-once'));
  const session = new ManagedOcuSession(async () => ({ close: async () => undefined, session: {
    ping: async () => ({}), callTool,
    listTools: async () => ({ tools: [...OCU_TOOLS].map(name => ({ name, inputSchema: {} })) }),
  } }), async () => ({ state: 'granted' }), undefined, undefined,
  { platform: 'win32', appApprovals: gate, windowsWaitForTargetIdle: vi.fn().mockResolvedValue(true),
    appLeases: leases, appWaitMs });
  owners.push(session);
  return { session, callTool };
}

afterEach(async () => {
  for (const session of owners.splice(0)) await session.close();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

describe('native app keys', () => {
  it('gives a connected browser tab and that browser\'s native windows one key', () => {
    expect(nativeAppKey({ platform: 'darwin', appId: 'com.google.Chrome', displayName: 'Google Chrome' }, 'Chrome'))
      .toBe(browserAppKey('chrome'));
    expect(nativeAppKey({ platform: 'darwin', appId: 'com.google.Chrome.canary', displayName: 'Google Chrome Canary' }, 'x'))
      .toBe('browser:chrome');
    expect(nativeAppKey({ platform: 'darwin', appId: 'com.microsoft.edgemac', displayName: 'Microsoft Edge' }, 'Edge'))
      .toBe(browserAppKey('edge'));
    expect(nativeAppKey({ platform: 'win32', appId: 'MSEdge', displayName: 'Microsoft Edge' }, 'msedge.exe'))
      .toBe('browser:edge');
    expect(nativeAppKey(null, 'Google Chrome', 'win32')).toBe('browser:chrome');
  });

  it('keys other apps by their resolved identity, falling back to the requested name', () => {
    expect(nativeAppKey({ platform: 'darwin', appId: 'com.microsoft.Powerpoint', displayName: 'Microsoft PowerPoint' }, 'PPT'))
      .toBe('app:darwin:com.microsoft.powerpoint');
    expect(nativeAppKey(null, ' WPS Office ', 'darwin')).toBe('app:darwin:wps office');
    expect(nativeAppKey({ platform: 'darwin', appId: 'com.google.Chrome.helper', displayName: 'Chrome Helper' }, 'helper'))
      .toBe('app:darwin:com.google.chrome.helper');
  });
});

describe('native app leases', () => {
  it('reserves an app for one owner until it is released or stays idle', () => {
    let now = 0;
    const leases = new NativeAppLeases(60_000, () => now);
    leases.claim('app:darwin:com.microsoft.powerpoint', 'first');
    expect(leases.heldByOther('app:darwin:com.microsoft.powerpoint', 'first')).toBe(false);
    expect(leases.heldByOther('app:darwin:com.microsoft.powerpoint', 'second')).toBe(true);
    expect(leases.heldByOther('app:darwin:com.apple.notes', 'second')).toBe(false);
    now = 59_000;
    leases.touch('app:darwin:com.microsoft.powerpoint', 'first');
    now = 118_000;
    expect(leases.heldByOther('app:darwin:com.microsoft.powerpoint', 'second')).toBe(true);
    now = 119_000;
    expect(leases.heldByOther('app:darwin:com.microsoft.powerpoint', 'second')).toBe(false);
    leases.claim('app:darwin:com.microsoft.powerpoint', 'second');
    leases.release('second');
    expect(leases.heldByOther('app:darwin:com.microsoft.powerpoint', 'first')).toBe(false);
  });
});

describe('one Memmy task sends input to a native app at a time', () => {
  it('lets another task observe but not act until the first task ends', async () => {
    const leases = new NativeAppLeases();
    const first = owner(leases);
    const second = owner(leases);
    const result = await first.session.invoke('click', { app: 'PowerPoint', element_index: 2 }, 30, context);
    expect(first.session.appKeyFor(result)).toBe('app:win32:microsoft.office.powerpnt.exe.15');
    expect(result).toBe(state);
    const observed = await second.session.invoke('get_app_state', { app: 'PowerPoint' }, 30, context);
    expect(second.session.appKeyFor(observed)).toBe('app:win32:microsoft.office.powerpnt.exe.15');
    const busy = await second.session.invoke('type_text', { app: 'PowerPoint', text: '第二个文档' }, 30, context);
    expect(busy).toMatchObject({ isError: true, _meta: { memmyComputerUse: { noActionDispatched: true } } });
    expect(busy.content[0].text).toMatch(/PowerPoint is being used by another Memmy task\. The type_text action was not sent/);
    expect(second.callTool.mock.calls.map(call => call[0])).toEqual(['list_apps', 'get_app_state', 'list_apps']);
    await first.session.close();
    await second.session.invoke('type_text', { app: 'PowerPoint', text: '第二个文档' }, 30, context);
    expect(second.callTool.mock.calls.at(-1)?.[0]).toBe('type_text');
  });

  it('waits for input access while the other task finishes within the wait window', async () => {
    const leases = new NativeAppLeases();
    const first = owner(leases);
    const second = owner(leases, 5_000);
    await first.session.invoke('click', { app: 'PowerPoint', element_index: 2 }, 30, context);
    const waiting = second.session.invoke('click', { app: 'PowerPoint', element_index: 3 }, 30, context);
    await vi.waitFor(() => expect(second.callTool).toHaveBeenCalledWith('list_apps', expect.anything(), 30, expect.anything()));
    expect(second.callTool.mock.calls.map(call => call[0])).toEqual(['list_apps']);
    await first.session.close();
    expect(second.session.appKeyFor(await waiting)).toBe('app:win32:microsoft.office.powerpnt.exe.15');
    expect(second.callTool.mock.calls.map(call => call[0])).toEqual(['list_apps', 'click']);
  });

  it('shares one lease registry across the tasks of a pool', async () => {
    const seen: NativeAppLeases[] = [];
    const pool = new ManagedOcuSessionPool((_ownerId, appLeases) => {
      seen.push(appLeases);
      return { invoke: async () => ({ content: [] }), close: async () => undefined } as unknown as ManagedOcuSession;
    });
    for (const turnId of ['first', 'second']) await pool.invoke('get_app_state', { app: 'PowerPoint' }, 30,
      new RequestContext({ messageId: turnId, sessionKey: 'slides-chat', channel: 'websocket', chatId: 'slides-chat' }));
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    await pool.close();
  });
});
