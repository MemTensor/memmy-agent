import { describe, expect, it, vi } from 'vitest';
import { RequestContext } from '../../../src/core/agent-runtime/tools/context.js';
import { ManagedOcuSession, OCU_TOOLS, OcuBlocked, OcuUncertain } from '../../../src/tools/computer-use/managed-ocu-session.js';
import { ManagedOcuSessionPool } from '../../../src/tools/computer-use/managed-ocu-session-pool.js';

function request(turnId: string, chatId = 'chat') {
  return new RequestContext({ sessionKey: 'session', channel: 'websocket', chatId,
    messageId: 'original-user-message', metadata: { turnId } });
}

function fixture(platform: NodeJS.Platform) {
  const workers: Array<{ id: string; call: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
  const pool = new ManagedOcuSessionPool(id => {
    let revision = 0;
    const call = vi.fn(async (_name: string, args: Record<string, any>) => ({
      content: [{ type: 'text', text: 'state' }],
      _meta: { memmyComputerUse: { targetWindowID: args.window_id ?? 52, pid: 20,
        observationID: `${id}-${++revision}` } },
    }));
    const close = vi.fn(async () => undefined);
    workers.push({ id, call, close });
    return new ManagedOcuSession(async () => ({ close, session: {
      ping: async () => ({}), callTool: call,
      listTools: async () => ({ tools: [...OCU_TOOLS].map(name => ({ name, inputSchema: {} })) }),
    } }), async () => ({ state: 'granted' }), undefined, undefined, { platform,
      appApprovals: null, macFocusGuard: async (_app, _name, run) => run() });
  });
  const read = async (context: RequestContext) => {
    const result = await pool.invoke('get_app_state', { app: 'WPS' }, 30, context, null, { modelVisible: true });
    pool.presentModelResult('get_app_state', { app: 'WPS' }, result, 'state', context);
    return result;
  };
  return { pool, workers, read };
}

describe.each(['darwin', 'win32'] as const)('%s independent native tasks', platform => {
  it.each(['same chat', 'different chat'])('a waiting task cannot hold up another task in %s', async location => {
    const { pool, workers, read } = fixture(platform);
    const first = request('first');
    const second = request('second', location === 'same chat' ? 'chat' : 'other-chat');
    await read(first);
    let release!: (result: any) => void;
    workers[0].call.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const waiting = pool.invoke('get_app_state', { app: 'WPS' }, 30, first);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await read(second);
    expect(workers).toHaveLength(2);
    expect(workers[1].call).toHaveBeenCalledOnce();
    expect(workers[0].close).not.toHaveBeenCalled();
    release({ content: [] });
    await waiting;
    await pool.close();
  });

  it('stopping a hung task immediately closes only its helper and rejects late revival', async () => {
    const { pool, workers, read } = fixture(platform);
    const first = request('first'), second = request('second');
    const late = await read(first);
    await read(second);
    let release!: (result: any) => void;
    workers[0].call.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const waiting = pool.invoke('get_app_state', { app: 'WPS' }, 30, first).catch(() => undefined);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await pool.finishTurn(first);
    expect(workers[0].close).toHaveBeenCalledOnce();
    expect(workers[1].close).not.toHaveBeenCalled();
    pool.presentModelResult('get_app_state', {}, late, 'late state', first);
    expect(await pool.invoke('click', { app: 'WPS', element_index: '4' }, 30, first))
      .toMatchObject({ isError: true, _meta: { memmyComputerUse: { noActionDispatched: true } } });
    await pool.invoke('click', { app: 'WPS', element_index: '4' }, 30, second, null, { modelVisible: true });
    expect(workers[1].call.mock.calls[1][0]).toBe('click');
    expect(workers).toHaveLength(2);
    release({ content: [] }); await waiting;
    await pool.close();
  });

  it('a disconnected task blocks only itself while another keeps its model observation', async () => {
    const { pool, workers, read } = fixture(platform);
    const first = request('first'), second = request('second');
    await read(first);
    const secondState = await read(second);
    workers[0].call.mockRejectedValueOnce(new Error('lost response'));
    await expect(pool.invoke('type_text', { app: 'WPS', text: 'a' }, 30, first))
      .rejects.toBeInstanceOf(OcuUncertain);
    await expect(pool.invoke('type_text', { app: 'WPS', text: 'a' }, 30, first))
      .rejects.toBeInstanceOf(OcuBlocked);
    await pool.invoke('click', { app: 'WPS', element_index: '4' }, 30, second, null, { modelVisible: true });
    expect(workers[1].call.mock.calls[1][1]).toMatchObject({ window_id: 52,
      observation_id: secondState._meta.memmyComputerUse.observationID });
    expect(workers[1].close).not.toHaveBeenCalled();
    await pool.close();
  });

  it('discovery and separate pool lifetimes never share native helper namespaces', async () => {
    const a = fixture(platform), b = fixture(platform);
    await a.pool.initialize();
    await a.read(request('same-turn'));
    await b.read(request('same-turn'));
    expect(new Set([...a.workers, ...b.workers].map(worker => worker.id)).size).toBe(3);
    expect(a.workers[0].call).not.toHaveBeenCalled();
    await Promise.all([a.pool.close(), b.pool.close()]);
  });

  it('closing configuration closes every task once and cannot create another owner', async () => {
    const { pool, workers, read } = fixture(platform);
    await read(request('one')); await read(request('two'));
    await pool.close(); await pool.close();
    expect(workers.every(worker => worker.close.mock.calls.length === 1)).toBe(true);
    await expect(read(request('three'))).rejects.toBeInstanceOf(OcuBlocked);
    expect(workers).toHaveLength(2);
  });

  it('rejects unscoped operations without starting a helper', async () => {
    const { pool, workers } = fixture(platform);
    await expect(pool.invoke('click', { app: 'WPS' }, 30, null)).rejects.toBeInstanceOf(OcuBlocked);
    expect(workers).toHaveLength(0);
    await pool.close();
  });
});
