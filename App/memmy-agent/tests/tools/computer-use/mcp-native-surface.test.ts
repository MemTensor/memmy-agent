import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { MCPToolWrapper } from '../../../src/core/agent-runtime/tools/mcp.js';
import { RequestContext } from '../../../src/core/agent-runtime/tools/context.js';
import { ManagedOcuSession, OCU_TOOLS } from '../../../src/tools/computer-use/managed-ocu-session.js';
import { closeNativeSurfacesForTurn, nativeSurfaceTargetId, registerComputerUseTurnInterrupt } from '../../../src/tools/computer-use/surface-preview.js';
import { revealNativeWindow } from '../../../src/tools/computer-use/mac-focus-guard.js';

vi.mock('../../../src/tools/computer-use/mac-focus-guard.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/tools/computer-use/mac-focus-guard.js')>(),
  revealNativeWindow: vi.fn().mockResolvedValue(true),
}));

const scope = { sessionKey: 'window-only-preview', channel: 'websocket', chatId: 'chat' };
afterEach(() => {
  closeNativeSurfacesForTurn(scope);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('starts live window presentation when a successful native result has no preview image', async () => {
  vi.stubEnv('MEMMY_DESKTOP_MANAGED_GATEWAY', '1');
  const send = vi.fn();
  vi.stubGlobal('process', Object.assign(Object.create(process), { send, connected: true }));
  const result = { _meta: { memmyComputerUse: { targetWindowID: 52 } },
    content: [{ type: 'text', text: 'WPS window observed' }] };
  const owner = { invoke: vi.fn().mockResolvedValue(result),
    presentModelResult: vi.fn((_name, _args, _result, output) => output) } as unknown as ManagedOcuSession;
  const tool = new MCPToolWrapper({}, 'memmy_computer_use', { name: 'get_app_state' }, 30, undefined, owner);
  tool.setContext(new RequestContext(scope));
  await tool.execute({ app: 'WPS' });
  expect(send).toHaveBeenCalledWith(expect.objectContaining({
    type: 'memmy:computer-use-surface:update', surface: 'computer',
    targetId: 'WPS', targetWindowId: 52, imageDataUrl: undefined,
  }), expect.any(Function));
});

it('does not present a window from a failed native result', async () => {
  vi.stubEnv('MEMMY_DESKTOP_MANAGED_GATEWAY', '1');
  const send = vi.fn();
  vi.stubGlobal('process', Object.assign(Object.create(process), { send, connected: true }));
  const owner = { invoke: vi.fn().mockResolvedValue({ isError: true,
    _meta: { memmyComputerUse: { targetWindowID: 52 } }, content: [] }),
    presentModelResult: vi.fn((_name, _args, _result, output) => output) } as unknown as ManagedOcuSession;
  const tool = new MCPToolWrapper({}, 'memmy_computer_use', { name: 'get_app_state' }, 30, undefined, owner);
  tool.setContext(new RequestContext(scope));
  await tool.execute({ app: 'WPS' });
  expect(send).not.toHaveBeenCalled();
});

it.each(['darwin', 'win32'] as const)('emits %s ownership from native metadata and retains it across PiP updates', async platform => {
  vi.stubEnv('MEMMY_DESKTOP_MANAGED_GATEWAY', '1');
  const events = new EventEmitter();
  const send = vi.fn();
  const child = Object.assign(Object.create(process), { on: events.on.bind(events), send, connected: true });
  Object.defineProperty(child, 'platform', { value: platform });
  vi.stubGlobal('process', child);
  const hwnd = platform === 'win32' ? 0x100000034 : 52;
  const related = platform === 'win32' ? 0x100000035 : 53;
  const native = { _meta: { memmyComputerUse: { targetWindowID: hwnd, pid: 20, relatedWindowIDs: [related] } },
    content: [{ type: 'text', text: 'WPS observed' }] };
  const owner = { invoke: vi.fn().mockResolvedValueOnce(native).mockResolvedValue({ ...native,
    _meta: { memmyComputerUse: { targetWindowID: hwnd, pid: 21 } } }),
  presentModelResult: vi.fn((_name, _args, _result, output) => output) } as unknown as ManagedOcuSession;
  const tool = new MCPToolWrapper({}, 'memmy_computer_use', { name: 'get_app_state' }, 30, undefined, owner);
  tool.setContext(new RequestContext(scope));
  await tool.execute({ app: 'WPS', targetPid: 21, targetAssociatedWindowIds: [999] });
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ targetWindowId: hwnd, targetPid: 20 }), expect.any(Function));
  expect(send.mock.calls[0][0].targetAssociatedWindowIds).toEqual([related]);
  events.emit('message', { type: 'memmy:computer-use-surface:action', surface: 'computer', ...scope,
    targetId: nativeSurfaceTargetId('WPS', 20, hwnd), targetWindowId: hwnd, action: 'click', x: 0.5, y: 0.5 });
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({
    targetWindowId: hwnd, targetPid: 20, title: expect.stringContaining('所属应用已变化'),
  }), expect.any(Function)));
  expect(owner.invoke).toHaveBeenCalledTimes(2);
});

it('registers takeover and stop for a live window that has no screenshot dimensions', async () => {
  vi.stubEnv('MEMMY_DESKTOP_MANAGED_GATEWAY', '1');
  const events = new EventEmitter();
  vi.stubGlobal('process', Object.assign(Object.create(process), {
    on: events.on.bind(events), send: vi.fn(), connected: true,
  }));
  const result = { _meta: { memmyComputerUse: { targetWindowID: 52 } },
    content: [{ type: 'text', text: 'App=WPS (pid 123)\nWindow=Presentation' }] };
  const owner = { invoke: vi.fn().mockResolvedValue(result),
    presentModelResult: vi.fn((_name, _args, _result, output) => output) } as unknown as ManagedOcuSession;
  const stop = vi.fn().mockResolvedValue(undefined);
  const release = registerComputerUseTurnInterrupt({ ...scope, turnId: 'window-only-turn' }, stop);
  try {
    const tool = new MCPToolWrapper({}, 'memmy_computer_use', { name: 'get_app_state' }, 30, undefined, owner);
    tool.setContext(new RequestContext(scope));
    await tool.execute({ app: 'WPS' });
    const identity = { type: 'memmy:computer-use-surface:action', surface: 'computer', ...scope,
      targetId: 'WPS', targetWindowId: 52, turnId: 'window-only-turn' };
    events.emit('message', { ...identity, action: 'open' });
    await vi.waitFor(() => expect(revealNativeWindow).toHaveBeenCalledWith(123, 52, expect.any(AbortSignal)));
    events.emit('message', { ...identity, action: 'interrupt' });
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    expect(owner.invoke).toHaveBeenCalledTimes(2); // Observation only; no pointer action.
  } finally { release(); }
});

it('does not attach an older delayed native result to a newer turn or RequestContext', async () => {
  vi.stubEnv('MEMMY_DESKTOP_MANAGED_GATEWAY', '1');
  const events = new EventEmitter(), send = vi.fn();
  vi.stubGlobal('process', Object.assign(Object.create(process), { on: events.on.bind(events), send, connected: true }));
  let completeFirst!: (result: unknown) => void;
  const firstResult = new Promise(resolve => { completeFirst = resolve; });
  const state = (id: number) => ({ content: [], _meta: { memmyComputerUse: { targetWindowID: id, pid: 20 } } });
  const owner = { invoke: vi.fn().mockReturnValueOnce(firstResult).mockResolvedValue(state(53)),
    presentModelResult: vi.fn((_name, _args, _result, output) => output) } as unknown as ManagedOcuSession;
  const tool = new MCPToolWrapper({}, 'memmy_computer_use', { name: 'get_app_state' }, 30, undefined, owner);
  const releaseFirst = registerComputerUseTurnInterrupt({ ...scope, turnId: 'delayed-first' }, vi.fn());
  tool.setContext(new RequestContext({ ...scope, metadata: { turnId: 'delayed-first' } }));
  const first = tool.execute({ app: 'WPS' });
  releaseFirst();
  await closeNativeSurfacesForTurn({ ...scope, turnId: 'delayed-first' });
  const releaseNext = registerComputerUseTurnInterrupt({ ...scope, turnId: 'current-next' }, vi.fn());
  try {
    tool.setContext(new RequestContext({ ...scope, metadata: { turnId: 'current-next' } }));
    await tool.execute({ app: 'WPS' });
    completeFirst(state(52));
    await first;
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toMatchObject({ turnId: 'current-next', targetWindowId: 53 });
    expect(vi.mocked(owner.invoke).mock.calls.map(call => call[3]?.metadata.turnId)).toEqual(['delayed-first', 'current-next']);
  } finally { releaseFirst(); releaseNext(); }
});

it('keeps parallel wrapper results, window handlers, and stop cleanup separate in one chat', async () => {
  vi.stubEnv('MEMMY_DESKTOP_MANAGED_GATEWAY', '1');
  const events = new EventEmitter(), send = vi.fn();
  const child = Object.assign(Object.create(process), { on: events.on.bind(events), send, connected: true });
  Object.defineProperty(child, 'platform', { value: 'darwin' });
  vi.stubGlobal('process', child);
  vi.mocked(revealNativeWindow).mockClear();
  let completeFirst!: (result: unknown) => void;
  const firstResult = new Promise(resolve => { completeFirst = resolve; });
  const state = (id: number) => ({ content: [], _meta: { memmyComputerUse: { targetWindowID: id, pid: 20 } } });
  const owner = { invoke: vi.fn().mockReturnValueOnce(firstResult).mockResolvedValue(state(53)),
    finishTurn: vi.fn(async () => undefined),
    presentModelResult: vi.fn((_name, _args, _result, output) => output) } as unknown as ManagedOcuSession;
  const tool = new MCPToolWrapper({}, 'memmy_computer_use', { name: 'get_app_state' }, 30, undefined, owner);
  const firstScope = { ...scope, turnId: 'parallel-wrapper-a' }, secondScope = { ...scope, turnId: 'parallel-wrapper-b' };
  const stopFirst = vi.fn(async () => 'stopped'), stopSecond = vi.fn(async () => 'stopped');
  const releaseFirst = registerComputerUseTurnInterrupt(firstScope, stopFirst);
  const releaseSecond = registerComputerUseTurnInterrupt(secondScope, stopSecond);
  const action = (task: typeof firstScope, id: number, action: 'open' | 'interrupt') => ({
    type: 'memmy:computer-use-surface:action', surface: 'computer', ...task,
    targetId: nativeSurfaceTargetId('WPS', 20, id), targetWindowId: id, action,
  });
  try {
    tool.setContext(new RequestContext({ ...scope, metadata: { turnId: firstScope.turnId } }));
    const pendingFirst = tool.execute({ app: 'WPS' });
    tool.setContext(new RequestContext({ ...scope, metadata: { turnId: secondScope.turnId } }));
    await tool.execute({ app: 'WPS' });
    completeFirst(state(52));
    await pendingFirst;
    expect(send.mock.calls.map(call => [call[0].turnId, call[0].targetId])).toEqual([
      [secondScope.turnId, nativeSurfaceTargetId('WPS', 20, 53)],
      [firstScope.turnId, nativeSurfaceTargetId('WPS', 20, 52)],
    ]);
    expect(vi.mocked(owner.invoke).mock.calls.map(call => call[3]?.metadata.turnId))
      .toEqual([firstScope.turnId, secondScope.turnId]);
    events.emit('message', action(firstScope, 52, 'open'));
    events.emit('message', action(secondScope, 53, 'open'));
    await vi.waitFor(() => expect(revealNativeWindow).toHaveBeenCalledTimes(2));
    expect(revealNativeWindow).toHaveBeenCalledWith(20, 52, expect.any(AbortSignal));
    expect(revealNativeWindow).toHaveBeenCalledWith(20, 53, expect.any(AbortSignal));
    events.emit('message', action(firstScope, 52, 'interrupt'));
    await vi.waitFor(() => expect(stopFirst).toHaveBeenCalledOnce());
    expect(stopSecond).not.toHaveBeenCalled();
    await closeNativeSurfacesForTurn(firstScope);
    expect(owner.finishTurn).toHaveBeenCalledOnce();
    expect(vi.mocked(owner.finishTurn).mock.calls[0][0]?.metadata.turnId).toBe(firstScope.turnId);
    events.emit('message', action(firstScope, 52, 'open'));
    events.emit('message', action(secondScope, 53, 'open'));
    await vi.waitFor(() => expect(revealNativeWindow).toHaveBeenCalledTimes(3));
    expect(send.mock.calls.filter(call => call[0].type.endsWith(':close')).map(call => call[0].turnId))
      .toEqual([firstScope.turnId]);
  } finally {
    await closeNativeSurfacesForTurn(firstScope);
    await closeNativeSurfacesForTurn(secondScope);
    releaseFirst(); releaseSecond();
  }
});

it('carries a host fallback turn through the real managed invocation and native finish notification without modifying its caller', async () => {
  vi.stubEnv('MEMMY_DESKTOP_MANAGED_GATEWAY', '1');
  const events = new EventEmitter(), send = vi.fn();
  const child = Object.assign(Object.create(process), { on: events.on.bind(events), send, connected: true });
  Object.defineProperty(child, 'platform', { value: 'darwin' });
  vi.stubGlobal('process', child);
  const nativeCall = vi.fn(async () => ({ content: [{ type: 'text', text: 'Current native state' }],
    _meta: { memmyComputerUse: { targetWindowID: 52, pid: 20, observationID: 'fallback-observation' } } }));
  const notifyTurnEnded = vi.fn(async () => undefined);
  const session = { callTool: nativeCall, notifyTurnEnded, ping: vi.fn(async () => ({})),
    listTools: vi.fn(async () => ({ tools: [...OCU_TOOLS].map(name => ({ name, inputSchema: {} })) })) };
  const connect = vi.fn(async () => ({ session, close: vi.fn(async () => undefined) }));
  const owner = new ManagedOcuSession(connect, async () => ({ state: 'granted' }), undefined, undefined,
    { platform: 'darwin', appApprovals: null, macFocusGuard: async (_target, _name, run) => run() });
  const invoke = vi.spyOn(owner, 'invoke'), present = vi.spyOn(owner, 'presentModelResult'), finish = vi.spyOn(owner, 'finishTurn');
  const requestScope = { sessionKey: 'real-managed-fallback', channel: 'websocket', chatId: 'fallback-chat' };
  const turnScope = { ...requestScope, turnId: 'trusted-host-fallback-turn' };
  const metadata = Object.freeze({ computerUseInteractive: true, computerUseInteractiveReason: 'interactive-user-message',
    message_id: 'fallback-user-message', marker: { retained: true } });
  const original = Object.freeze(new RequestContext({ ...requestScope, senderId: 'fallback-user', messageId: 'fallback-user-message',
    workspace: 'isolated-test-workspace', browserScope: requestScope, metadata }));
  const originalValues = { ...original, metadata: { ...metadata } };
  const release = registerComputerUseTurnInterrupt(turnScope, vi.fn(async () => undefined));
  try {
    const tool = new MCPToolWrapper({}, 'memmy_computer_use', { name: 'get_app_state' }, 30, undefined, owner);
    tool.setContext(original);
    await tool.execute({ app: 'WPS' });
    expect(nativeCall).toHaveBeenCalledOnce();
    const bound = invoke.mock.calls[0][3]!;
    expect(bound).toBeInstanceOf(RequestContext);
    expect(bound).not.toBe(original);
    expect(bound).toEqual(new RequestContext({ ...originalValues, metadata: { ...metadata, turnId: turnScope.turnId } }));
    expect(bound.metadata).not.toBe(metadata);
    expect(present.mock.calls[0][4]).toBe(bound);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'memmy:computer-use-surface:update',
      ...turnScope, targetId: nativeSurfaceTargetId('WPS', 20, 52) }), expect.any(Function));
    await closeNativeSurfacesForTurn(turnScope);
    await closeNativeSurfacesForTurn(turnScope);
    expect(finish).toHaveBeenCalledExactlyOnceWith(bound);
    // notifyTurnEnded is reached by the production ManagedOcuSession, not a
    // stubbed finishTurn, proving the native owner registered this fallback.
    expect(notifyTurnEnded).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
    expect(nativeCall).toHaveBeenCalledOnce();
    expect(original).toEqual(new RequestContext(originalValues));
    expect(original.metadata).toBe(metadata);
    expect(original.metadata).not.toHaveProperty('turnId');
    expect(original.metadata).not.toHaveProperty('turn_id');
  } finally { release(); await closeNativeSurfacesForTurn(turnScope); await owner.close(); }
});
