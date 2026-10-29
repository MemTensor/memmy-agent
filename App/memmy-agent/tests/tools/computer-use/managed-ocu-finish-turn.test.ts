import { afterEach, expect, it, vi } from 'vitest';
import { RequestContext } from '../../../src/core/agent-runtime/tools/context.js';
import { ManagedOcuSession, OCU_TOOLS } from '../../../src/tools/computer-use/managed-ocu-session.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function request(turnId: string, chatId = 'chat') {
  return new RequestContext({ sessionKey: 'native-owner', channel: 'websocket', chatId,
    messageId: `message-${turnId}`, metadata: { turnId } });
}

function fixture(platform: NodeJS.Platform = 'darwin', notifyAvailable = true) {
  let revision = 0;
  const callTool = vi.fn(async (_name: string, _args: Record<string, any>, _timeout: number) => ({
    content: [{ type: 'text', text: 'Current native state' }],
    _meta: { memmyComputerUse: { targetWindowID: 52, pid: 20, observationID: `token-${++revision}` } },
  }));
  const notifyTurnEnded = vi.fn(async () => undefined);
  const session = { callTool, ping: vi.fn(async () => ({})),
    listTools: vi.fn(async () => ({ tools: [...OCU_TOOLS].map(name => ({ name, inputSchema: {} })) })),
    ...(notifyAvailable ? { notifyTurnEnded } : {}),
  };
  const close = vi.fn(async () => undefined);
  const connect = vi.fn(async () => ({ session, close }));
  const probe = vi.fn(async () => ({ state: 'granted' as const }));
  const owner = new ManagedOcuSession(connect, probe, undefined, undefined, { platform,
    appApprovals: null, macFocusGuard: async (_target, _name, run) => run() });
  const observe = async (context: RequestContext) => {
    const result = await owner.invoke('get_app_state', { app: 'WPS' }, 30, context, null, { modelVisible: true });
    owner.presentModelResult('get_app_state', { app: 'WPS' }, result, 'model state', context);
    return result;
  };
  return { owner, session, callTool, notifyTurnEnded, connect, close, probe, observe };
}

it('notifies an existing Darwin connection once without another native observation or reconnect', async () => {
  const { owner, observe, notifyTurnEnded, connect, callTool, session, probe } = fixture();
  const context = request('one');
  await observe(context);
  const pingCount = session.ping.mock.calls.length;
  const probeCount = probe.mock.calls.length;
  await Promise.all([owner.finishTurn(context), owner.finishTurn(context)]);
  expect(notifyTurnEnded).toHaveBeenCalledOnce();
  expect(connect).toHaveBeenCalledOnce();
  expect(probe).toHaveBeenCalledTimes(probeCount);
  expect(session.ping).toHaveBeenCalledTimes(pingCount);
  expect(callTool.mock.calls.map(call => call[0])).toEqual(['get_app_state']);
  await owner.close();
});

it('does not create a connection or notify for absent, incomplete or unobserved host turn contexts', async () => {
  const { owner, connect, notifyTurnEnded } = fixture();
  await owner.finishTurn(null);
  await owner.finishTurn(new RequestContext({ metadata: { turnId: 'unscoped' } }));
  await owner.finishTurn(new RequestContext({ sessionKey: 'native-owner', channel: 'websocket', chatId: 'chat' }));
  await owner.finishTurn(request('unused'));
  expect(connect).not.toHaveBeenCalled();
  expect(notifyTurnEnded).not.toHaveBeenCalled();
  await owner.close();
});

it.each(['win32', 'darwin'] as const)('is safe when %s has no supported notification capability', async platform => {
  const { owner, observe, notifyTurnEnded, connect } = fixture(platform, platform !== 'darwin');
  const context = request('compatibility');
  await observe(context);
  await expect(owner.finishTurn(context)).resolves.toBeUndefined();
  expect(notifyTurnEnded).not.toHaveBeenCalled();
  expect(connect).toHaveBeenCalledOnce();
  await owner.close();
});

it('finishes one chat without clearing another chat observation or resetting its shared helper', async () => {
  const { owner, observe, callTool, notifyTurnEnded } = fixture();
  const first = request('one');
  const other = request('one', 'other-chat');
  await observe(first);
  const result = await observe(other);
  await owner.finishTurn(first);
  expect(notifyTurnEnded).not.toHaveBeenCalled();
  await owner.invoke('click', { app: 'WPS', element_index: '4' }, 30, other, null, { modelVisible: true });
  expect(callTool.mock.calls[2]).toEqual(['click', expect.objectContaining({
    window_id: 52, observation_id: result._meta.memmyComputerUse.observationID,
  }), 30]);
  await owner.finishTurn(other);
  expect(notifyTurnEnded).toHaveBeenCalledOnce();
  await owner.close();
});

it('records a newer queued turn before earlier cleanup can send a global native reset', async () => {
  const { owner, observe, notifyTurnEnded } = fixture();
  const first = request('one');
  const newer = request('two');
  await observe(first);
  const finish = owner.finishTurn(first);
  const queued = observe(newer);
  await finish;
  expect(notifyTurnEnded).not.toHaveBeenCalled();
  await queued;
  await owner.finishTurn(newer);
  expect(notifyTurnEnded).toHaveBeenCalledOnce();
  await owner.close();
});

it('rejects late ended-turn actions and ignores late model presentation without dispatching or reviving its token', async () => {
  const { owner, observe, callTool, notifyTurnEnded } = fixture();
  const ended = request('one');
  const result = await observe(ended);
  await owner.finishTurn(ended);
  owner.presentModelResult('get_app_state', { app: 'WPS' }, result, 'late result', ended);
  const outcome = await owner.invoke('click', { app: 'WPS', element_index: '4' }, 30, ended, null, { modelVisible: true });
  expect(outcome).toMatchObject({ isError: true, _meta: { memmyComputerUse: { noActionDispatched: true } } });
  expect(callTool).toHaveBeenCalledOnce();
  await owner.finishTurn(ended);
  expect(notifyTurnEnded).toHaveBeenCalledOnce();
  const next = new RequestContext({ ...ended, metadata: { turnId: 'two' } });
  await owner.invoke('click', { app: 'WPS', element_index: '4' }, 30, next, null, { modelVisible: true });
  expect(callTool.mock.calls[1][0]).toBe('get_app_state');
  expect(callTool.mock.calls[1][1]).not.toHaveProperty('observation_id');
  await owner.close();
});

it('preserves a new turn using the same message cache key while ending its predecessor', async () => {
  const { owner, observe, callTool, notifyTurnEnded } = fixture();
  const first = request('one');
  const next = new RequestContext({ ...first, metadata: { turn_id: 'two' } });
  await observe(first);
  const result = await observe(next);
  await owner.finishTurn(first);
  expect(notifyTurnEnded).not.toHaveBeenCalled();
  await owner.invoke('click', { app: 'WPS', element_index: '4' }, 30, next, null, { modelVisible: true });
  expect(callTool.mock.calls[2][0]).toBe('click');
  expect(callTool.mock.calls[2][1].observation_id).toBe(result._meta.memmyComputerUse.observationID);
  await owner.close();
});

it('logs notification failure without changing permissions, reconnecting or blocking a new turn', async () => {
  const { owner, observe, notifyTurnEnded, connect, callTool } = fixture();
  const context = request('one');
  await observe(context);
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  notifyTurnEnded.mockRejectedValueOnce(new Error('private title / secret path'));
  await expect(owner.finishTurn(context)).resolves.toBeUndefined();
  expect(logged).toHaveBeenCalledWith('[memmy-computer-use]', expect.stringContaining('"stage":"finish-turn"'));
  expect(JSON.stringify(logged.mock.calls)).not.toMatch(/private title|secret path/);
  expect(owner.preflight.blocked(context)).toBeUndefined();
  await observe(request('two'));
  expect(connect).toHaveBeenCalledOnce();
  expect(callTool.mock.calls.map(call => call[0])).toEqual(['get_app_state', 'get_app_state']);
  await owner.close();
});

it('bounds a hanging native notification so the next request can proceed', async () => {
  const { owner, observe, notifyTurnEnded, connect } = fixture();
  const context = request('one');
  await observe(context);
  vi.useFakeTimers();
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  notifyTurnEnded.mockImplementationOnce(() => new Promise<undefined>(() => {}));
  const finishing = owner.finishTurn(context);
  await vi.waitFor(() => expect(notifyTurnEnded).toHaveBeenCalledOnce());
  const next = observe(request('two'));
  await vi.advanceTimersByTimeAsync(1000);
  await finishing;
  await next;
  expect(logged).toHaveBeenCalledWith('[memmy-computer-use]', expect.stringContaining('"code":"ETIMEDOUT"'));
  expect(connect).toHaveBeenCalledOnce();
  await owner.close();
});
