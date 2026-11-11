import { describe, expect, it, vi } from 'vitest';
import { RequestContext } from '../../../src/core/agent-runtime/tools/context.js';
import { MCPToolWrapper } from '../../../src/core/agent-runtime/tools/mcp.js';
import { ManagedOcuSession, OCU_TOOLS } from '../../../src/tools/computer-use/managed-ocu-session.js';

function fixture(platform: NodeJS.Platform) {
  let revision = 0;
  let current = '';
  const dispatched: string[] = [];
  const fresh = (note = '') => {
    current = `observation-${++revision}`;
    return { content: [{ type: 'text', text: `${note}Current state ${revision}` }],
      _meta: { memmyComputerUse: { targetWindowID: 52, pid: 20, observationID: current } } };
  };
  const callTool = vi.fn(async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    if (name === 'get_app_state') return fresh();
    if (args.observation_id !== current) return fresh('State changed. The action was NOT dispatched. ');
    dispatched.push(String(args.observation_id));
    return fresh('Action completed. ');
  });
  const owner = new ManagedOcuSession(async () => ({ close: async () => {}, session: {
    ping: async () => ({}), callTool,
    listTools: async () => ({ tools: [...OCU_TOOLS].map(name => ({ name, inputSchema: {} })) }),
  } }), async () => ({ state: 'granted' }), undefined, undefined, { platform, appApprovals: null });
  const context = new RequestContext({ sessionKey: 'session', channel: 'websocket', chatId: 'chat', messageId: 'message' });
  const tool = (name: string, request = context) => {
    const wrapper = new MCPToolWrapper({}, 'memmy_computer_use', { name }, 30, undefined, owner);
    wrapper.setContext(request);
    return wrapper;
  };
  return { owner, context, tool, callTool, dispatched };
}

describe.each(['darwin', 'win32'] as const)('%s model-visible observations', platform => {
it('retains separate observations for two windows of the same application', async () => {
  const { owner, context, tool, callTool } = fixture(platform);
  let revision = 0;
  callTool.mockImplementation(async (name, args) => ({ content: [{ type: 'text', text: name }],
    _meta: { memmyComputerUse: { targetWindowID: Number(args.window_id), pid: 20,
      observationID: `window-${args.window_id}-${++revision}` } } }));
  await tool('get_app_state').execute({ app: 'WPS', window_id: 52 });
  await tool('get_app_state').execute({ app: 'WPS', window_id: 53 });
  await tool('click').execute({ app: 'WPS', window_id: 52, element_index: '4' });
  expect(callTool.mock.calls[2]).toEqual(['click', expect.objectContaining({
    window_id: 52, observation_id: 'window-52-1',
  }), 30, ...(platform === 'win32' ? [expect.any(AbortSignal)] : [])]);
  await tool('click').execute({ app: 'WPS', window_id: 53, element_index: '5' });
  expect(callTool.mock.calls[3][0]).toBe('click');
  expect(callTool.mock.calls[3][1]).toMatchObject({ window_id: 53, observation_id: 'window-53-2' });
  await owner.invoke('get_app_state', { app: 'WPS', window_id: 52 }, 30, context);
  await tool('click').execute({ app: 'WPS', element_index: '5' });
  expect(callTool.mock.calls[5][1]).toMatchObject({ window_id: 53, observation_id: 'window-53-4' });
  const previous = callTool.mock.calls.length;
  expect(await tool('click').execute({ app: 'WPS', window_id: 54, element_index: '5' })).toContain('Observe the requested window');
  expect(callTool).toHaveBeenCalledTimes(previous);
  await owner.close();
});

it('observes first when a new request tries to act without its own model-visible state', async () => {
  const { owner, tool, callTool, dispatched } = fixture(platform);
  const click = tool('click');
  expect(await click.execute({ app: 'WPS', element_index: '4' })).toContain('was NOT dispatched');
  expect(callTool.mock.calls.map(call => call[0])).toEqual(['get_app_state']);
  expect(dispatched).toEqual([]);
  await click.execute({ app: 'WPS', element_index: '4' });
  expect(dispatched).toEqual(['observation-1']);
  await owner.close();
});

it('does not replace the model observation with a PiP-only read of the same window', async () => {
  const { owner, context, tool, callTool, dispatched } = fixture(platform);
  await tool('get_app_state').execute({ app: 'WPS' });
  await owner.invoke('get_app_state', { app: 'WPS', window_id: 52 }, 30, context);
  const click = tool('click');
  expect(await click.execute({ app: 'WPS', element_index: '4' })).toContain('was NOT dispatched');
  expect(callTool.mock.calls[2][1].observation_id).toBe('observation-1');
  expect(dispatched).toEqual([]);
  await click.execute({ app: 'WPS', element_index: '4' });
  expect(dispatched).toEqual(['observation-3']);
  await owner.close();
});

it('keeps provenance separate when two chats observe the same native window', async () => {
  const { owner, context, tool, callTool, dispatched } = fixture(platform);
  await tool('get_app_state').execute({ app: 'WPS' });
  const other = new RequestContext({ ...context, chatId: 'other' });
  await tool('get_app_state', other).execute({ app: 'WPS' });
  expect(await tool('click').execute({ app: 'WPS', element_index: '4' })).toContain('was NOT dispatched');
  expect(callTool.mock.calls[2][1].observation_id).toBe('observation-1');
  expect(dispatched).toEqual([]);
  await owner.close();
});

it('does not inherit another message snapshot for an unobserved request', async () => {
  const { owner, context, tool, callTool, dispatched } = fixture(platform);
  await tool('get_app_state').execute({ app: 'WPS' });
  const next = new RequestContext({ ...context, messageId: 'next-message' });
  expect(await tool('click', next).execute({ app: 'WPS', element_index: '4' })).toContain('has not observed');
  expect(callTool.mock.calls.map(call => call[0])).toEqual(['get_app_state', 'get_app_state']);
  expect(dispatched).toEqual([]);
  await owner.close();
});

it('does not rewrite an explicit stale observation token as a newer model-visible token', async () => {
  const { owner, tool, callTool, dispatched } = fixture(platform);
  await tool('get_app_state').execute({ app: 'WPS' });
  await tool('get_app_state').execute({ app: 'WPS' });
  expect(await tool('click').execute({ app: 'WPS', element_index: '4', observation_id: 'observation-1' }))
    .toContain('was NOT dispatched');
  expect(callTool.mock.calls[2][0]).toBe('get_app_state');
  expect(dispatched).toEqual([]);
  await owner.close();
});

it('does not borrow a future observation from an earlier tool in the same concurrent batch', async () => {
  const { owner, tool, callTool, dispatched } = fixture(platform);
  await tool('get_app_state').execute({ app: 'WPS' });
  const read = tool('get_app_state').execute({ app: 'WPS' });
  const click = tool('click').execute({ app: 'WPS', element_index: '4' });
  await read;
  expect(await click).toContain('was NOT dispatched');
  expect(callTool.mock.calls[2][1].observation_id).toBe('observation-1');
  expect(dispatched).toEqual([]);
  await owner.close();
});

});


describe('Windows unavailable-window recovery', () => {
  const unavailable = (windowID: number, dispatched = true) => ({
    isError: !dispatched, content: [{ type: 'text', text: 'The requested window is unavailable.' }],
    _meta: { memmyComputerUse: { targetWindowUnavailable: true, requestedWindowID: windowID,
      pid: 20, closedAfterAction: dispatched, availableWindows: [{ windowID: 52, title: 'PowerPoint' }] } },
  });

  it('discovers the application again after its observed dialog closes', async () => {
    const { owner, tool, callTool } = fixture('win32');
    let revision = 0;
    callTool.mockImplementation(async (name, args) => name === 'click' ? unavailable(53) : {
      content: [{ type: 'text', text: 'Observed the requested window' }],
      _meta: { memmyComputerUse: { targetWindowID: args.window_id ?? 52, pid: 20,
        observationID: `fresh-${++revision}` } },
    });
    await tool('get_app_state').execute({ app: 'POWERPNT', window_id: 52 });
    await tool('get_app_state').execute({ app: 'POWERPNT', window_id: 53 });
    await tool('click').execute({ app: 'POWERPNT', window_id: 53, element_index: '4' });
    await tool('get_app_state').execute({ app: 'POWERPNT' });
    expect(callTool.mock.calls[3][0]).toBe('get_app_state');
    expect(callTool.mock.calls[3][1]).not.toHaveProperty('window_id');
    expect(callTool.mock.calls.filter(call => call[0] === 'click')).toHaveLength(1);
    await owner.close();
  });

  it('observes instead of transferring an implicit action to another document after closure', async () => {
    const { owner, tool, callTool } = fixture('win32');
    await tool('get_app_state').execute({ app: 'POWERPNT' });
    callTool.mockResolvedValueOnce(unavailable(52));
    await tool('click').execute({ app: 'POWERPNT', window_id: 52, element_index: '4' });
    expect(await tool('click').execute({ app: 'POWERPNT', element_index: '4' })).toContain('was NOT dispatched');
    expect(callTool.mock.calls.map(call => call[0])).toEqual(['get_app_state', 'click', 'get_app_state']);
    expect(callTool.mock.calls[2][1]).not.toHaveProperty('window_id');
    const calls = callTool.mock.calls.length;
    expect(await tool('click').execute({ app: 'POWERPNT', window_id: 53, element_index: '4' })).toContain('Observe the requested window');
    expect(callTool).toHaveBeenCalledTimes(calls);
    await owner.close();
  });

  it('does not evict the current target when native metadata names a different unavailable window', async () => {
    const { owner, tool, callTool } = fixture('win32');
    await tool('get_app_state').execute({ app: 'POWERPNT' });
    callTool.mockResolvedValueOnce(unavailable(53, false));
    await tool('get_app_state').execute({ app: 'POWERPNT' });
    await tool('get_app_state').execute({ app: 'POWERPNT' });
    expect(callTool.mock.calls[2][1]).toMatchObject({ window_id: 52 });
    await owner.close();
  });
});
