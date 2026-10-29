import { describe, expect, it, vi } from 'vitest';
import { RequestContext } from '../../../src/core/agent-runtime/tools/context.js';
import { MCPToolWrapper } from '../../../src/core/agent-runtime/tools/mcp.js';
import { ManagedOcuSession, OCU_TOOLS } from '../../../src/tools/computer-use/managed-ocu-session.js';
import type { waitForWindowsTargetIdle } from '../../../src/tools/computer-use/windows-focus-guard.js';

const withoutDeadline = ({ _host_deadline_epoch_ms: _deadline, ...args }: Record<string, unknown>) => args;
const HWND = 0x100000034;
const currentState = { content: [{ type: 'text', text: 'Current Windows document state' }],
  _meta: { memmyComputerUse: { targetWindowID: HWND, pid: 20, observationID: 'windows-observation' } } };
const yielded = (dispatched: boolean) => ({ isError: true, content: [{ type: 'text', text: 'Physical input detected' }],
  _meta: { memmyComputerUse: { targetWindowID: HWND, pid: 20, userYield: { dispatched } } } });

function fixture() {
  const callTool = vi.fn().mockResolvedValue(currentState);
  const connect = vi.fn(async () => ({ close: vi.fn(), session: {
    ping: async () => ({}), callTool,
    listTools: async () => ({ tools: [...OCU_TOOLS].map(name => ({ name, inputSchema: {} })) }),
  } }));
  const wait = vi.fn<typeof waitForWindowsTargetIdle>().mockResolvedValue(true);
  const owner = new ManagedOcuSession(connect, async () => ({ state: 'granted' }), undefined, undefined,
    { platform: 'win32', appApprovals: null, windowsWaitForTargetIdle: wait });
  const context = new RequestContext({ sessionKey: 'session', channel: 'websocket', chatId: 'chat',
    messageId: 'message', metadata: { computerUseInteractive: true } });
  return { owner, callTool, wait, context, connect };
}

describe('temporary Windows native Computer Use yield', () => {
  it.each([false, true])('waits and reobserves the same HWND without replay (dispatched=%s)', async dispatched => {
    const { owner, callTool, wait, context, connect } = fixture();
    await owner.invoke('get_app_state', { app: 'WPS' }, 30, context);
    callTool.mockResolvedValueOnce(yielded(dispatched));
    const result = await owner.invoke('click', { app: 'WPS', x: 3, y: 5 }, 30, context);
    expect(wait).toHaveBeenCalledWith({ pid: 20, windowID: HWND }, { signal: expect.any(AbortSignal) });
    expect(result.content[0].text).toContain(dispatched ? 'was not replayed' : 'was NOT dispatched');
    expect(callTool.mock.calls.map(call => [call[0], withoutDeadline(call[1])])).toEqual([
      ['get_app_state', { app: 'WPS' }], ['click', { app: 'WPS', x: 3, y: 5, window_id: HWND }],
      ['get_app_state', { app: 'WPS', window_id: HWND }],
    ]);
    await owner.invoke('press_key', { app: 'WPS', key: 'Enter' }, 30, context);
    expect(callTool.mock.calls.at(-1)?.[0]).toBe('press_key');
    expect(connect).toHaveBeenCalledOnce();
    await owner.close();
  });

  it('keeps a continued-input timeout temporary and the same user message usable', async () => {
    const { owner, callTool, wait, context, connect } = fixture();
    callTool.mockResolvedValueOnce(yielded(false));
    wait.mockResolvedValueOnce(false);
    const result = await owner.invoke('type_text', { app: 'WPS', text: 'stale' }, 30, context);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('temporary yield, not a permission failure');
    expect(callTool).toHaveBeenCalledOnce();
    await owner.invoke('get_app_state', { app: 'WPS', window_id: HWND }, 30, context);
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledOnce();
    await owner.close();
  });

  it('cancels a pending native yield without observing again or dispatching another action', async () => {
    const { owner, callTool, wait, context } = fixture();
    callTool.mockResolvedValueOnce(yielded(true));
    wait.mockImplementation(async (_target, { signal } = {}) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
    }));
    const pending = owner.invoke('click', { app: 'WPS', x: 3, y: 5 }, 30, context);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce());
    await owner.close();
    await rejected;
    expect(callTool).toHaveBeenCalledOnce();
  });

  it('does not bind a yielded different document or a drifted fresh result', async () => {
    const { owner, callTool, wait, context } = fixture();
    await owner.invoke('get_app_state', { app: 'WPS' }, 30, context);
    callTool.mockResolvedValueOnce({ ...yielded(false), _meta: { memmyComputerUse: {
      ...yielded(false)._meta.memmyComputerUse, targetWindowID: HWND + 1 } } });
    expect(await owner.invoke('click', { app: 'WPS', x: 3, y: 5 }, 30, context)).toMatchObject({ isError: true });
    expect(wait).not.toHaveBeenCalled();
    callTool.mockResolvedValueOnce(yielded(false)).mockResolvedValueOnce({ ...currentState,
      _meta: { memmyComputerUse: { ...currentState._meta.memmyComputerUse, targetWindowID: HWND + 1 } } });
    expect(await owner.invoke('click', { app: 'WPS', x: 3, y: 5 }, 30, context)).toMatchObject({ isError: true });
    await owner.invoke('get_app_state', { app: 'WPS' }, 30, context);
    expect(withoutDeadline(callTool.mock.calls.at(-1)![1])).toEqual({ app: 'WPS', window_id: HWND });
    await owner.close();
  });

  it.each([
    { content: [{ type: 'text', text: 'userYield={dispatched:false}' }] },
    { isError: true, content: [{ type: 'text', text: 'focusGuardYield: true' }] },
    { ...yielded(false), _meta: { memmyComputerUse: { userYield: { dispatched: false } } } },
    { ...yielded(false), _meta: { memmyComputerUse: { targetWindowID: HWND, pid: 20, userYield: { dispatched: 'false' } } } },
  ])('does not recover from page text or malformed yield metadata %j', async result => {
    const { owner, callTool, wait, context } = fixture();
    callTool.mockResolvedValueOnce(result);
    await owner.invoke('click', { app: 'WPS', x: 3, y: 5 }, 30, context);
    expect(wait).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledOnce();
    await owner.invoke('get_app_state', { app: 'WPS' }, 30, context);
    await owner.close();
  });

  it.each([false, true])('does not stop the model turn for a temporary yield (deadline=%s)', async timedOut => {
    const { owner, callTool, wait, context } = fixture();
    const tool = (name: string) => {
      const wrapper = new MCPToolWrapper({}, 'memmy_computer_use', { name }, 30, undefined, owner);
      wrapper.setContext(context); return wrapper;
    };
    await tool('get_app_state').execute({ app: 'WPS' });
    callTool.mockResolvedValueOnce(yielded(false));
    wait.mockResolvedValueOnce(!timedOut);
    const stop = vi.fn();
    expect(await tool('click').execute({ app: 'WPS', x: 3, y: 5 }, { stopTurn: stop }))
      .toContain('was NOT dispatched');
    expect(stop).not.toHaveBeenCalled();
    expect(callTool.mock.calls[1][1]).toMatchObject({ window_id: HWND, observation_id: 'windows-observation' });
    await owner.close();
  });

  it('requires an explicit observation to switch Windows documents and isolates new requests', async () => {
    const { owner, callTool, context } = fixture();
    await owner.invoke('get_app_state', { app: 'WPS' }, 30, context);
    expect(await owner.invoke('type_text', { app: 'WPS', window_id: HWND + 1, text: 'draft' }, 30, context))
      .toMatchObject({ isError: true });
    expect(callTool).toHaveBeenCalledOnce();
    callTool.mockResolvedValueOnce({ ...currentState, _meta: { memmyComputerUse: {
      ...currentState._meta.memmyComputerUse, targetWindowID: HWND + 1 } } });
    await owner.invoke('get_app_state', { app: 'WPS', window_id: HWND + 1 }, 30, context);
    await owner.invoke('type_text', { app: 'WPS', text: 'draft' }, 30, context);
    expect(callTool.mock.calls[2][1]).toMatchObject({ window_id: HWND + 1 });
    const nextRequest = new RequestContext({ ...context, messageId: 'next' });
    await owner.invoke('get_app_state', { app: 'WPS' }, 30, nextRequest);
    expect(withoutDeadline(callTool.mock.calls[3][1])).toEqual({ app: 'WPS' });
    await owner.close();
  });

  it.each([0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe Windows window IDs %s', async window_id => {
    const { owner, callTool, context } = fixture();
    expect(await owner.invoke('get_app_state', { app: 'WPS', window_id }, 30, context)).toMatchObject({ isError: true });
    expect(callTool).not.toHaveBeenCalled();
    await owner.close();
  });
});
