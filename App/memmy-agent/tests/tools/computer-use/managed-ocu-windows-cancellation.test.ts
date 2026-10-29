import { expect, it, vi } from 'vitest';
import { RequestContext } from '../../../src/core/agent-runtime/tools/context.js';
import { ManagedOcuSession, OCU_TOOLS, OcuUncertain } from '../../../src/tools/computer-use/managed-ocu-session.js';

const state = (observationID: string) => ({ content: [{ type: 'text', text: 'Current target state' }],
  _meta: { memmyComputerUse: { pid: 20, targetWindowID: 52, observationID } } });
const context = new RequestContext({ sessionKey: 'session', channel: 'websocket', chatId: 'chat', messageId: 'message' });
const withoutDeadline = ({ _host_deadline_epoch_ms: _deadline, ...args }: Record<string, unknown>) => args;

function fixture(appApprovals: any = null) {
  const connections: Array<{ alive: boolean; close: ReturnType<typeof vi.fn>; callTool: ReturnType<typeof vi.fn> }> = [];
  const connect = vi.fn(async () => {
    const index = connections.length;
    const connection = { alive: true, close: vi.fn(async () => { connection.alive = false; }),
      callTool: vi.fn(async () => state(`connection-${index}`)) };
    connections.push(connection);
    return { close: connection.close, session: { ping: async () => ({}), callTool: connection.callTool,
      listTools: async () => ({ tools: [...OCU_TOOLS].map(name => ({ name, inputSchema: {} })) }) } };
  });
  const owner = new ManagedOcuSession(connect, async () => ({ state: 'granted' }), undefined, undefined,
    { platform: 'win32', appApprovals, windowsWaitForTargetIdle: async () => true });
  const see = async () => {
    const result = await owner.invoke('get_app_state', { app: 'WPS' }, 30, context, undefined, { modelVisible: true });
    owner.presentModelResult('get_app_state', { app: 'WPS' }, result, 'Current target state', context);
    return result;
  };
  return { owner, connect, connections, see };
}

it('stamps a host-owned deadline and forwards cancellation while discarding caller deadlines', async () => {
  const { owner, connections } = fixture();
  const before = Date.now();
  await owner.invoke('get_app_state', { app: 'WPS', _host_deadline_epoch_ms: Number.MAX_SAFE_INTEGER }, 2, context);
  const call = connections[0].callTool.mock.calls[0];
  expect(call[1]._host_deadline_epoch_ms).toBeGreaterThanOrEqual(before + 2000);
  expect(call[1]._host_deadline_epoch_ms).toBeLessThanOrEqual(Date.now() + 2000);
  expect(call[3]).toBeInstanceOf(AbortSignal);
  expect(call[3].aborted).toBe(false);
  await owner.close();
});

it('kills an uncooperative helper on abort before its delayed dispatch and reobserves for a queued model action', async () => {
  const { owner, connections, see } = fixture();
  await see();
  const old = connections[0];
  let progress!: () => void;
  const canProceed = new Promise<void>(resolve => { progress = resolve; });
  const dispatched = vi.fn();
  old.callTool.mockImplementationOnce(async () => {
    await canProceed;
    if (old.alive) dispatched();
    return state('late-old-helper');
  });
  const controller = new AbortController();
  const pending = owner.invoke('click', { app: 'WPS', element_index: 2 }, 30, context, controller.signal, { modelVisible: true });
  const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(old.callTool).toHaveBeenCalledTimes(2));
  const queued = owner.invoke('click', { app: 'WPS', element_index: 3 }, 30, context, undefined, { modelVisible: true });
  controller.abort();
  expect(old.close).toHaveBeenCalledOnce();
  expect(old.alive).toBe(false);
  await cancelled;
  const refreshed = await queued;
  expect(refreshed.content[0].text).toContain('was NOT dispatched');
  expect(connections[1].callTool.mock.calls.map(call => call[0])).toEqual(['get_app_state']);
  expect(withoutDeadline(connections[1].callTool.mock.calls[0][1])).toEqual({ app: 'WPS' });
  progress();
  await Promise.resolve();
  expect(dispatched).not.toHaveBeenCalled();
  await owner.close();
});

it('detaches and closes immediately on host timeout without replaying the lost action', async () => {
  const { owner, connections, see, connect } = fixture();
  await see();
  const old = connections[0];
  old.callTool.mockImplementationOnce(async () => new Promise(() => {}));
  await expect(owner.invoke('click', { app: 'WPS', element_index: 2 }, 0.01, context))
    .rejects.toBeInstanceOf(OcuUncertain);
  expect(old.close).toHaveBeenCalledOnce();
  expect(old.alive).toBe(false);
  const next = new RequestContext({ ...context, messageId: 'next-message' });
  await owner.invoke('get_app_state', { app: 'WPS' }, 30, next);
  expect(connect).toHaveBeenCalledTimes(2);
  expect(old.callTool.mock.calls.map(call => call[0])).toEqual(['get_app_state', 'click']);
  expect(withoutDeadline(connections[1].callTool.mock.calls[0][1])).toEqual({ app: 'WPS' });
  await owner.close();
});

it('closes on native transport rejection and lets a queued new message reconnect', async () => {
  const { owner, connections, see, connect } = fixture();
  await see();
  const old = connections[0];
  let fail!: () => void;
  old.callTool.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = () => reject(new Error('native EOF')); }));
  const first = owner.invoke('click', { app: 'WPS', element_index: 2 }, 30, context);
  const failed = expect(first).rejects.toBeInstanceOf(OcuUncertain);
  await vi.waitFor(() => expect(old.callTool).toHaveBeenCalledTimes(2));
  const next = new RequestContext({ ...context, messageId: 'next' });
  const queued = owner.invoke('get_app_state', { app: 'WPS' }, 30, next);
  fail();
  await failed;
  await queued;
  expect(old.close).toHaveBeenCalledOnce();
  expect(connect).toHaveBeenCalledTimes(2);
  expect(withoutDeadline(connections[1].callTool.mock.calls[0][1])).toEqual({ app: 'WPS' });
  await owner.close();
});

it('also closes the helper if cancellation occurs during the fresh read after user yield', async () => {
  const { owner, connections, see } = fixture();
  await see();
  const old = connections[0];
  old.callTool.mockResolvedValueOnce({ isError: true, content: [],
    _meta: { memmyComputerUse: { pid: 20, targetWindowID: 52, userYield: { dispatched: true } } } })
    .mockImplementationOnce(async () => new Promise(() => {}));
  const controller = new AbortController();
  const pending = owner.invoke('click', { app: 'WPS', element_index: 2 }, 30, context, controller.signal);
  const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(old.callTool).toHaveBeenCalledTimes(3));
  const freshCall = old.callTool.mock.calls[2];
  expect(freshCall[0]).toBe('get_app_state');
  expect(freshCall[1]).toMatchObject({ app: 'WPS', window_id: 52, _host_deadline_epoch_ms: expect.any(Number) });
  expect(freshCall[3]).toBeInstanceOf(AbortSignal);
  controller.abort();
  expect(old.close).toHaveBeenCalledOnce();
  await cancelled;
  await owner.close();
});

it('cancels an identity probe before approval without leaving a native child or dispatching a mutation', async () => {
  const approvals = { authorize: vi.fn() };
  const { owner, connections } = fixture(approvals);
  await owner.initialize();
  const old = connections[0];
  old.callTool.mockImplementationOnce(async () => new Promise(() => {}));
  const controller = new AbortController();
  const pending = owner.invoke('click', { app: 'WPS', element_index: 2 }, 30, context, controller.signal);
  const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(old.callTool).toHaveBeenCalledOnce());
  expect(old.callTool.mock.calls[0][0]).toBe('list_apps');
  expect(old.callTool.mock.calls[0][1]).toEqual({ _host_deadline_epoch_ms: expect.any(Number) });
  expect(old.callTool.mock.calls[0][3]).toBeInstanceOf(AbortSignal);
  controller.abort();
  expect(old.close).toHaveBeenCalledOnce();
  await cancelled;
  expect(approvals.authorize).not.toHaveBeenCalled();
  expect(old.callTool.mock.calls.map(call => call[0])).toEqual(['list_apps']);
  await owner.close();
});

it('does not republish a detached generation token when an old completed result is presented late', async () => {
  const { owner, connections } = fixture();
  const oldResult = await owner.invoke('get_app_state', { app: 'WPS' }, 30, context);
  const old = connections[0];
  old.callTool.mockImplementationOnce(async () => new Promise(() => {}));
  const controller = new AbortController();
  const pending = owner.invoke('get_app_state', { app: 'WPS' }, 30, context, controller.signal);
  const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(old.callTool).toHaveBeenCalledTimes(2));
  controller.abort();
  await cancelled;
  owner.presentModelResult('get_app_state', { app: 'WPS' }, oldResult, 'Old state', context);
  const result = await owner.invoke('click', { app: 'WPS', element_index: 3 }, 30, context, undefined, { modelVisible: true });
  expect(result.content[0].text).toContain('has not observed');
  expect(connections[1].callTool.mock.calls.map(call => call[0])).toEqual(['get_app_state']);
  await owner.close();
});
