import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { OCU_TOOLS, ManagedOcuSession, OcuBlocked } from '../../../src/tools/computer-use/managed-ocu-session.js';
import { RequestContext } from '../../../src/core/agent-runtime/tools/context.js';
import { activeComputerUseTurnId, closeNativeSurfacesForTurn, emitComputerUseSurface,
  mcpPreviewImage, registerComputerUseSurfaceAction, registerComputerUseTurnInterrupt } from '../../../src/tools/computer-use/surface-preview.js';

const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('reads screenshot dimensions for app-relative pointer actions', () => {
  const frame = mcpPreviewImage({ content: [{ type: 'image', mimeType: 'image/png', data: ONE_PIXEL_PNG }] });
  expect(frame).toEqual({ url: `data:image/png;base64,${ONE_PIXEL_PNG}`, width: 1, height: 1 });
});

it('accepts normalized image_url blocks from managed MCP responses', () => {
  const url = `data:image/png;base64,${ONE_PIXEL_PNG}`;
  const result = { _meta: { memmyComputerUse: { targetWindowID: 52 } },
    content: [{ type: 'image_url', image_url: { url, detail: 'auto' } }] };
  expect(mcpPreviewImage(result)).toEqual({ url, width: 1, height: 1, targetWindowId: 52 });
});

it('accepts the compact string form of an inline image_url block', () => {
  const url = `data:image/png;base64,${ONE_PIXEL_PNG}`;
  expect(mcpPreviewImage({ content: [{ type: 'image_url', image_url: url }] }))
    .toEqual({ url, width: 1, height: 1 });
});

it('does not fetch remote image_url blocks for a native preview', () => {
  expect(mcpPreviewImage({ content: [{ type: 'image_url', image_url: { url: 'https://example.test/frame.png' } }] }))
    .toBeUndefined();
});

it('keeps the native screenshot window ID with the preview frame', () => {
  const result = { _meta: { memmyComputerUse: { targetWindowID: 52, pid: 123 } },
    content: [{ type: 'image', mimeType: 'image/png', data: ONE_PIXEL_PNG }] };
  expect(mcpPreviewImage(result)).toMatchObject({ width: 1, height: 1, targetWindowId: 52 });
  expect(mcpPreviewImage({ ...result, _meta: { memmyComputerUse: { targetWindowID: -1 } } }))
    .not.toHaveProperty('targetWindowId');
});

it('does not create an interactive frame from malformed screenshot data', () => {
  expect(mcpPreviewImage({ content: [{ type: 'image', mimeType: 'image/png', data: 'oops' }] }))
    .toBeUndefined();
});

it('closes the native preview for its turn even when a frame is display-only', () => {
  vi.stubEnv('MEMMY_DESKTOP_MANAGED_GATEWAY', '1');
  const send = vi.fn();
  vi.stubGlobal('process', Object.assign(Object.create(process), { send, connected: true }));
  const scope = { sessionKey: 'turn', channel: 'websocket', chatId: 'chat' };
  emitComputerUseSurface({ surface: 'computer', ...scope, targetId: 'Notes', title: 'Notes', imageDataUrl: `data:image/png;base64,${ONE_PIXEL_PNG}` });
  closeNativeSurfacesForTurn(scope);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ type: 'memmy:computer-use-surface:close', targetId: 'Notes' }));
});

it('retains a surface when its preview image exceeds the IPC limit', () => {
  vi.stubEnv('MEMMY_DESKTOP_MANAGED_GATEWAY', '1');
  const send = vi.fn();
  vi.stubGlobal('process', Object.assign(Object.create(process), { send, connected: true }));
  emitComputerUseSurface({ surface: 'computer', sessionKey: 'large', channel: 'websocket',
    chatId: 'chat', targetId: 'Notes', title: 'Notes',
    imageDataUrl: `data:image/jpeg;base64,${'A'.repeat(3_000_001)}` });
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
    type: 'memmy:computer-use-surface:update', targetId: 'Notes', imageDataUrl: undefined,
  }));
});

function managedChild() {
  const child = Object.assign(new EventEmitter(), {
    env: { ...process.env, MEMMY_DESKTOP_MANAGED_GATEWAY: '1' },
    connected: true,
    send: vi.fn(),
  });
  vi.stubGlobal('process', child);
  return child;
}

it('accepts a stop only for the active native surface and exact turn', async () => {
  const child = managedChild();
  const scope = { sessionKey: 'session-one', channel: 'websocket', chatId: 'chat-one' };
  const identity = { ...scope, targetId: 'Notes', turnId: 'turn-one' };
  const stop = vi.fn(async () => 'stopped');
  const release = registerComputerUseTurnInterrupt({ ...scope, turnId: 'turn-one' }, stop);
  registerComputerUseSurfaceAction(identity, vi.fn(async () => undefined));
  emitComputerUseSurface({ surface: 'computer', ...identity, title: 'Notes' });
  const action = { type: 'memmy:computer-use-surface:action', surface: 'computer',
    ...identity, action: 'interrupt' };

  expect(activeComputerUseTurnId(scope)).toBe('turn-one');
  child.emit('message', { ...action, turnId: 'old-turn' });
  child.emit('message', { ...action, sessionKey: 'other-session' });
  child.emit('message', { ...action, targetId: 'Other app' });
  await Promise.resolve();
  expect(stop).not.toHaveBeenCalled();

  child.emit('message', action);
  await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
  release();
  expect(activeComputerUseTurnId(scope)).toBeUndefined();
  child.emit('message', action);
  await Promise.resolve();
  expect(stop).toHaveBeenCalledOnce();
  closeNativeSurfacesForTurn(scope);
});

it('prevents the next managed native action after a PiP stop aborts its turn', async () => {
  const child = managedChild();
  const controller = new AbortController();
  const scope = { sessionKey: 'session-two', channel: 'websocket', chatId: 'chat-two' };
  const identity = { ...scope, targetId: 'Notes', turnId: 'turn-two' };
  const session = { ping: vi.fn(async () => undefined),
    listTools: vi.fn(async () => ({ tools: [...OCU_TOOLS].map(name => ({ name, inputSchema: {} })) })),
    callTool: vi.fn(async (_name: string) => ({ content: [] })) };
  const managed = new ManagedOcuSession(async () => ({ session, close: async () => undefined }),
    async () => ({ state: 'granted' }), undefined, undefined, { appApprovals: null, platform: 'linux' });
  const context = new RequestContext({ ...scope, messageId: 'user-message' });
  await managed.invoke('get_app_state', { app: 'Notes' }, 30, context, controller.signal);
  const release = registerComputerUseTurnInterrupt({ ...scope, turnId: 'turn-two' }, async () => {
    controller.abort();
    return 'stopped';
  });
  registerComputerUseSurfaceAction(identity, vi.fn(async () => undefined));
  emitComputerUseSurface({ surface: 'computer', ...identity, title: 'Notes' });

  child.emit('message', { type: 'memmy:computer-use-surface:action', surface: 'computer',
    ...identity, action: 'interrupt' });
  await vi.waitFor(() => expect(controller.signal.aborted).toBe(true));
  await expect(managed.invoke('click', { app: 'Notes', x: 10, y: 10 }, 30, context, controller.signal))
    .rejects.toBeInstanceOf(OcuBlocked);
  expect(session.callTool.mock.calls.map(call => call[0])).toEqual(['get_app_state']);
  release();
  closeNativeSurfacesForTurn(scope);
  await managed.close();
});

it('cancels the old PiP action queue when a surface is replaced or its turn closes', () => {
  managedChild();
  const scope = { sessionKey: 'session-lifetime', channel: 'websocket', chatId: 'chat-lifetime' };
  const identity = { ...scope, targetId: 'Notes', turnId: 'turn-lifetime' };
  const first = new AbortController();
  const second = new AbortController();
  registerComputerUseSurfaceAction(identity, vi.fn(async () => undefined), first);
  emitComputerUseSurface({ surface: 'computer', ...identity, title: 'Notes' });
  registerComputerUseSurfaceAction(identity, vi.fn(async () => undefined), second);
  expect(first.signal.aborted).toBe(true);
  expect(second.signal.aborted).toBe(false);
  closeNativeSurfacesForTurn(scope);
  expect(second.signal.aborted).toBe(true);
});
