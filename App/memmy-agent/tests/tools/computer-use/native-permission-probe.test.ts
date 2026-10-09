import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { DesktopOnboardingClient } from '../../../src/tools/computer-use/desktop-onboarding-client.js';
import { permissionFromSelfProbe, probeNativePermissions } from '../../../src/tools/computer-use/native-permission-probe.js';
import { ManagedOcuSession, OCU_TOOLS, OcuBlocked } from '../../../src/tools/computer-use/managed-ocu-session.js';
import { RequestContext } from '../../../src/core/agent-runtime/tools/context.js';

const target = { app: 'com.example.Memmy', pid: 42 };
const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' };
const success = { content: [{ type: 'text', text: 'App=com.example.Memmy (pid 42)\nPrivate chat content' }, image] };
const denied = { isError: true, content: [{ type: 'text', text: 'Accessibility permission is required. Run `open-computer-use doctor`.' }] };
const turn = (messageId: string) => new RequestContext({ messageId, sessionKey: 'chat' });

it('requires the actual parent identity and an image, never trusting page text as permission errors', () => {
  expect(permissionFromSelfProbe(success, target)).toEqual({ state: 'granted' });
  expect(permissionFromSelfProbe(denied, target)).toEqual({ state: 'missing', permission: 'accessibility' });
  expect(permissionFromSelfProbe({ ...denied, isError: false }, target)).toEqual({ state: 'unknown', reason: 'probeFailed' });
  expect(permissionFromSelfProbe(success, { ...target, pid: 43 })).toEqual({ state: 'unknown', reason: 'probeFailed' });
  expect(permissionFromSelfProbe({ content: [success.content[0]] }, target)).toEqual({ state: 'unknown', reason: 'screenCaptureUnavailable' });
  expect(permissionFromSelfProbe({ content: [success.content[0], { ...image, data: 'x'.repeat(44) }] }, target).state).toBe('unknown');
  expect(permissionFromSelfProbe({ content: [{ type: 'text', text: 'App=other (pid 9)\nApp=com.example.Memmy (pid 42)' }, image] }, target).state).toBe('unknown');
});

it('probes only the parent window, discards its content, and aborts without probing an unavailable parent', async () => {
  const session = { callTool: vi.fn().mockResolvedValue(success) };
  const desktop = { prepare: vi.fn().mockResolvedValue(target) };
  expect(await probeNativePermissions(session, null, desktop)).toEqual({ state: 'granted' });
  expect(session.callTool).toHaveBeenCalledExactlyOnceWith('get_app_state', { app: target.app, max_tree_nodes: 1, max_tree_depth: 1 }, 12);
  desktop.prepare.mockResolvedValue(null);
  expect(await probeNativePermissions(session, null, desktop)).toMatchObject({ reason: 'desktopUnavailable' });
  const abort = new AbortController(); abort.abort(); desktop.prepare.mockResolvedValue(target);
  expect(await probeNativePermissions(session, abort.signal, desktop)).toMatchObject({ reason: 'desktopUnavailable' });
  expect(session.callTool).toHaveBeenCalledOnce();
});

it('blocks the target until a NEW message verifies access; no doctor, target replay, or probe data in model result', async () => {
  let allowed = false;
  const calls: string[] = [];
  const connect = async () => ({ close: async () => {}, session: {
    listTools: async () => ({ tools: [...OCU_TOOLS].map(name => ({ name, inputSchema: {} })) }), ping: async () => {},
    callTool: async (_tool: string, args: any) => {
      calls.push(args.app);
      return args.app === target.app ? allowed ? success : denied : { content: [{ type: 'text', text: 'Notes result' }] };
    },
  } });
  const guide = vi.fn().mockResolvedValue(undefined);
  const owner = new ManagedOcuSession(connect, (session, signal) => probeNativePermissions(session, signal, { prepare: async () => target }), guide);
  await expect(owner.invoke('get_app_state', { app: 'Notes' }, 30, turn('1'))).rejects.toBeInstanceOf(OcuBlocked);
  allowed = true;
  await expect(owner.invoke('get_app_state', { app: 'Notes' }, 30, turn('1'))).rejects.toBeInstanceOf(OcuBlocked);
  expect(calls).toEqual([target.app]); expect(guide).toHaveBeenCalledOnce();
  expect(await owner.invoke('get_app_state', { app: 'Notes' }, 30, turn('2'))).toEqual({ content: [{ type: 'text', text: 'Notes result' }] });
  expect(calls).toEqual([target.app, target.app, 'Notes']); expect(guide).toHaveBeenCalledOnce();
  await owner.close();
});

function ipcFixture() {
  const ipc = Object.assign(new EventEmitter(), { ppid: 42, connected: true, send: vi.fn((_msg: any, cb: any) => cb?.(null)) });
  const client = new DesktopOnboardingClient(ipc as any);
  const reply = (data: any) => {
    const request = ipc.send.mock.calls.at(-1)![0];
    ipc.emit('message', { type: `${request.type}:result`, requestId: request.requestId, ...data });
  };
  return { client, ipc, reply };
}
it('correlates private parent replies and rejects a different process', async () => {
  const { client, ipc, reply } = ipcFixture();
  const first = client.prepare(); reply({ target: { ...target, pid: 43 } }); expect(await first).toBeNull();
  const second = client.prepare();
  ipc.emit('message', { type: 'memmy:computer-use-onboarding:prepare:result', requestId: 'wrong', target });
  expect(ipc.listenerCount('message')).toBe(1);
  reply({ target }); expect(await second).toEqual(target); expect(ipc.listenerCount('message')).toBe(0);
});
it.each(['abort', 'disconnect', 'timeout'])('cleans up an unanswered parent request on %s', async reason => {
  vi.useFakeTimers();
  try {
    const { client, ipc } = ipcFixture(); const abort = new AbortController(); const request = client.prepare(abort.signal);
    if (reason === 'abort') abort.abort();
    if (reason === 'disconnect') ipc.emit('disconnect');
    if (reason === 'timeout') await vi.advanceTimersByTimeAsync(2001);
    expect(await request).toBeNull(); expect(ipc.listenerCount('message')).toBe(0); expect(ipc.listenerCount('disconnect')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
