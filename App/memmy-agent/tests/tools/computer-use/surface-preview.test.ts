import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { OCU_TOOLS, ManagedOcuSession, OcuBlocked } from '../../../src/tools/computer-use/managed-ocu-session.js';
import { RequestContext } from '../../../src/core/agent-runtime/tools/context.js';
import { activeComputerUseTurnId, closeNativeSurfacesForTurn, emitComputerUseSurface,
  mcpPreviewImage, mcpTargetPid, mcpTargetAssociatedWindowIds, mcpTargetWindowId, nativeSurfaceTargetId, registerComputerUseSurfaceAction,
  registerComputerUseTurnInterrupt, registerNativeTurnCleanup } from '../../../src/tools/computer-use/surface-preview.js';

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

it('preserves safe Windows HWNDs without weakening the Mac UInt32 window boundary', () => {
  const hwnd = 0x100000034;
  const result = { _meta: { memmyComputerUse: { targetWindowID: hwnd } },
    content: [{ type: 'image', mimeType: 'image/png', data: ONE_PIXEL_PNG }] };
  expect(mcpTargetWindowId(result, 'win32')).toBe(hwnd);
  expect(mcpPreviewImage(result, 'win32')).toMatchObject({ targetWindowId: hwnd });
  expect(mcpTargetWindowId(result, 'darwin')).toBeUndefined();
  expect(mcpPreviewImage(result, 'darwin')).not.toHaveProperty('targetWindowId');
  expect(mcpTargetWindowId({ _meta: { memmyComputerUse: { targetWindowID: Number.MAX_SAFE_INTEGER + 1 } } }, 'win32'))
    .toBeUndefined();
});

it('identifies each document window independently of shared app names or aliases', () => {
  expect(nativeSurfaceTargetId('Notes', 20, 52)).toBe(nativeSurfaceTargetId('com.apple.Notes', 20, 52));
  expect(nativeSurfaceTargetId('Notes', 20, 52)).not.toBe(nativeSurfaceTargetId('Notes', 20, 53));
  expect(nativeSurfaceTargetId('WPS', 20, 0x100000034)).toBe('native-window:20:4294967348');
  expect(nativeSurfaceTargetId('Notes', undefined, 52)).toBe('Notes');
});

it('takes surface ownership only from a valid native PID in transport metadata', () => {
  expect(mcpTargetPid({ _meta: { memmyComputerUse: { pid: 20 } } })).toBe(20);
  expect(mcpTargetPid({ content: [{ type: 'text', text: 'App=Notepad (pid 20)' }] })).toBeUndefined();
  for (const pid of [0, -1, 1.5, 0x100000000, '20'])
    expect(mcpTargetPid({ _meta: { memmyComputerUse: { pid } } })).toBeUndefined();
});

it('does not create an interactive frame from malformed screenshot data', () => {
  expect(mcpPreviewImage({ content: [{ type: 'image', mimeType: 'image/png', data: 'oops' }] }))
    .toBeUndefined();
});

it.each(['darwin', 'win32'] as const)('takes associated windows only from bounded %s native metadata for the same observed root', platform => {
  const result = (relatedWindowIDs: unknown) => ({ _meta: { memmyComputerUse: { targetWindowID: 52, pid: 20, relatedWindowIDs } } });
  expect(mcpTargetAssociatedWindowIds(result([54, 52, 53, 54]), platform)).toEqual([53, 54]);
  for (const ids of [[0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1], ['53'], Array(65).fill(53)])
    expect(mcpTargetAssociatedWindowIds(result(ids), platform)).toEqual([]);
  expect(mcpTargetAssociatedWindowIds({ content: [{ type: 'text', text: 'relatedWindowIDs=[53]' }] }, platform)).toEqual([]);
  expect(mcpTargetAssociatedWindowIds({ _meta: { memmyComputerUse: { relatedWindowIDs: [53] } } }, platform)).toEqual([]);
});

it('preserves Windows safe-integer HWNDs while Mac associations remain uint32', () => {
  const result = { _meta: { memmyComputerUse: { targetWindowID: 52, pid: 20, relatedWindowIDs: [0x100000035] } } };
  expect(mcpTargetAssociatedWindowIds(result, 'win32')).toEqual([0x100000035]);
  expect(mcpTargetAssociatedWindowIds(result, 'darwin')).toEqual([]);
  expect(mcpTargetAssociatedWindowIds(result, 'linux')).toEqual([]);
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

it.each(['darwin', 'win32'] as const)('gives the same exact %s window one current handler across sequential requests and aliases', async platform => {
  const child = managedChild();
  const scope = { sessionKey: `sequential-${platform}`, channel: 'websocket', chatId: 'chat' };
  const targetWindowId = platform === 'win32' ? 0x100000034 : 52;
  const first = { ...scope, targetId: 'Calculator', turnId: 'turn-one' };
  const second = { ...scope, targetId: '计算器', turnId: 'turn-two' };
  const oldAction = vi.fn(async () => undefined), newAction = vi.fn(async () => undefined);
  const oldCancel = new AbortController(), newCancel = new AbortController();
  const releaseFirst = registerComputerUseTurnInterrupt(first, vi.fn());
  emitComputerUseSurface({ surface: 'computer', ...first, title: first.targetId, targetPid: 20, targetWindowId });
  registerComputerUseSurfaceAction(first, oldAction, oldCancel);
  releaseFirst();
  await closeNativeSurfacesForTurn(first);
  const releaseSecond = registerComputerUseTurnInterrupt(second, vi.fn());
  emitComputerUseSurface({ surface: 'computer', ...second, title: second.targetId, targetPid: 20, targetWindowId });
  registerComputerUseSurfaceAction(second, newAction, newCancel);
  expect(oldCancel.signal.aborted).toBe(true);
  releaseFirst();
  expect(activeComputerUseTurnId(scope)).toBe(second.turnId);
  closeNativeSurfacesForTurn(first);
  expect(newCancel.signal.aborted).toBe(false);
  const count = child.send.mock.calls.length;
  emitComputerUseSurface({ surface: 'computer', ...first, title: 'late old result', targetPid: 20, targetWindowId });
  const lateCancel = new AbortController();
  registerComputerUseSurfaceAction(first, oldAction, lateCancel);
  expect(lateCancel.signal.aborted).toBe(true);
  expect(child.send).toHaveBeenCalledTimes(count);
  const action = { type: 'memmy:computer-use-surface:action', surface: 'computer', action: 'open', targetWindowId };
  child.emit('message', { ...action, ...first });
  child.emit('message', { ...action, ...second });
  await vi.waitFor(() => expect(newAction).toHaveBeenCalledOnce());
  expect(oldAction).not.toHaveBeenCalled();
  closeNativeSurfacesForTurn(second);
  expect(newCancel.signal.aborted).toBe(true);
  expect(child.send.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'memmy:computer-use-surface:close', ...second });
  child.emit('message', { ...action, ...second });
  await Promise.resolve();
  expect(newAction).toHaveBeenCalledOnce();
  releaseSecond();
  const afterClose = child.send.mock.calls.length;
  emitComputerUseSurface({ surface: 'computer', ...second, title: 'late finished result', targetPid: 20, targetWindowId });
  const completedCancel = new AbortController();
  registerComputerUseSurfaceAction(second, newAction, completedCancel);
  expect(completedCancel.signal.aborted).toBe(true);
  expect(child.send).toHaveBeenCalledTimes(afterClose);
});

it('finishes each native owner once even when a failed request never created a preview', async () => {
  const scope = { sessionKey: 'failed-no-preview', channel: 'websocket', chatId: 'chat', turnId: 'turn' };
  const owner = {}, finish = vi.fn(async () => undefined);
  registerNativeTurnCleanup(scope, owner, finish);
  registerNativeTurnCleanup(scope, owner, finish);
  const other = { ...scope, turnId: 'new-turn' }, newFinish = vi.fn(async () => undefined);
  registerNativeTurnCleanup(other, owner, newFinish);
  await closeNativeSurfacesForTurn(scope);
  expect(finish).toHaveBeenCalledOnce();
  expect(newFinish).not.toHaveBeenCalled();
  await closeNativeSurfacesForTurn(scope);
  expect(finish).toHaveBeenCalledOnce();
  await closeNativeSurfacesForTurn(other);
  expect(newFinish).toHaveBeenCalledOnce();
});

it('keeps parallel same-chat and cross-chat task interrupts, windows, and cleanup independent', async () => {
  const child = managedChild();
  const scope = { sessionKey: 'parallel-surfaces', channel: 'websocket', chatId: 'chat' };
  const tasks = [{ ...scope, turnId: 'task-a' }, { ...scope, turnId: 'task-b' },
    { ...scope, chatId: 'other-chat', turnId: 'task-c' }];
  const stops = tasks.map(() => vi.fn(async () => 'stopped'));
  const releases = tasks.map((task, index) => registerComputerUseTurnInterrupt(task, stops[index]!));
  const owners = [...Array.from({ length: 18 }, (_, index) => ({ ...tasks[0]!,
    targetId: nativeSurfaceTargetId('Notes', 20, 52 + index), targetWindowId: 52 + index })),
  { ...tasks[1]!, targetId: nativeSurfaceTargetId('Notes', 20, 52), targetWindowId: 52 },
  { ...tasks[2]!, targetId: nativeSurfaceTargetId('Notes', 20, 52), targetWindowId: 52 }];
  const controls = owners.map(() => new AbortController());
  const actions = owners.map(() => vi.fn(async () => undefined));
  try {
    owners.forEach((owner, index) => {
      emitComputerUseSurface({ surface: 'computer', ...owner, title: 'Notes', targetPid: 20 });
      registerComputerUseSurfaceAction(owner, actions[index]!, controls[index]);
    });
    expect(activeComputerUseTurnId(scope)).toBeUndefined();
    expect(activeComputerUseTurnId(tasks[0]!)).toBe('task-a');
    expect(controls.every(controller => !controller.signal.aborted)).toBe(true);
    const message = { type: 'memmy:computer-use-surface:action', surface: 'computer', action: 'interrupt' };
    child.emit('message', { ...message, ...owners[0]! });
    await vi.waitFor(() => expect(stops[0]).toHaveBeenCalledOnce());
    expect(stops[1]).not.toHaveBeenCalled();
    expect(stops[2]).not.toHaveBeenCalled();
    await closeNativeSurfacesForTurn(tasks[0]!);
    expect(controls.slice(0, 18).every(controller => controller.signal.aborted)).toBe(true);
    expect(controls.slice(18).every(controller => !controller.signal.aborted)).toBe(true);
    child.emit('message', { ...message, ...owners[0]! });
    child.emit('message', { ...message, ...owners[18]!, action: 'open' });
    child.emit('message', { ...message, ...owners[19]!, action: 'open' });
    await vi.waitFor(() => expect(actions[18]).toHaveBeenCalledOnce());
    expect(actions[19]).toHaveBeenCalledOnce();
    expect(stops[0]).toHaveBeenCalledOnce();
    expect(child.send.mock.calls.filter(call => call[0].type.endsWith(':close'))).toHaveLength(18);
  } finally {
    await Promise.all(tasks.map(task => closeNativeSurfacesForTurn(task)));
    releases.forEach(release => release());
  }
});

it('cancels a registered action queue even if its failed task never emitted a surface', async () => {
  managedChild();
  const identity = { sessionKey: 'handler-no-frame', channel: 'websocket', chatId: 'chat',
    turnId: 'task', targetId: 'native-window:20:52' };
  const cancel = new AbortController();
  registerComputerUseSurfaceAction(identity, vi.fn(async () => undefined), cancel);
  await closeNativeSurfacesForTurn(identity);
  expect(cancel.signal.aborted).toBe(true);
});

it('does not hold task completion open for a stuck native cleanup or register it again after finishing', async () => {
  vi.useFakeTimers();
  try {
    const scope = { sessionKey: 'stuck-notification', channel: 'websocket', chatId: 'chat', turnId: 'turn' };
    const finish = vi.fn(() => new Promise<void>(() => undefined));
    const owner = {};
    registerNativeTurnCleanup(scope, owner, finish);
    const done = closeNativeSurfacesForTurn(scope);
    await vi.advanceTimersByTimeAsync(1500);
    await done;
    expect(finish).toHaveBeenCalledOnce();
    registerNativeTurnCleanup(scope, owner, finish);
    await closeNativeSurfacesForTurn(scope);
    expect(finish).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});
