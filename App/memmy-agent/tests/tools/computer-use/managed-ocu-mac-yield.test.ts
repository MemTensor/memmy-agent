import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestContext } from '../../../src/core/agent-runtime/tools/context.js';
import { OcuUserYielded, withMacFocusGuard, waitForMacTargetIdle } from '../../../src/tools/computer-use/mac-focus-guard.js';
import { ManagedOcuSession, OCU_TOOLS } from '../../../src/tools/computer-use/managed-ocu-session.js';
import { MCPToolWrapper } from '../../../src/core/agent-runtime/tools/mcp.js';

const beforeMarker = 'MAC_FOCUS_GUARD_YIELD_BEFORE_DISPATCH: The action was not sent.';
const afterMarker = 'MAC_FOCUS_GUARD_YIELD_AFTER_DISPATCH: An action may have been sent.';
const currentState = { content: [{ type: 'text', text: 'Current WPS document state' }],
  _meta: { memmyComputerUse: { targetWindowID: 52, pid: 20 } } };

function fixture() {
  const callTool = vi.fn().mockResolvedValue(currentState);
  const connection = { close: vi.fn().mockResolvedValue(undefined), session: {
    ping: vi.fn().mockResolvedValue({}),
    listTools: vi.fn().mockResolvedValue({ tools: [...OCU_TOOLS].map(name => ({ name, inputSchema: {} })) }),
    callTool,
  } };
  const guard = vi.fn<typeof withMacFocusGuard>().mockImplementation(async (_app, _name, call) => call());
  const wait = vi.fn<typeof waitForMacTargetIdle>().mockResolvedValue(true);
  const connect = vi.fn(async () => connection);
  const probe = vi.fn().mockResolvedValue({ state: 'granted' });
  const owner = new ManagedOcuSession(connect, probe, undefined, undefined,
    { platform: 'darwin', macFocusGuard: guard as typeof withMacFocusGuard, macWaitForTargetIdle: wait });
  const context = new RequestContext({ sessionKey: 'session', channel: 'websocket', chatId: 'chat',
    messageId: 'message', metadata: { computerUseInteractive: true } });
  return { owner, callTool, guard, wait, context, connect, probe };
}

beforeEach(() => { vi.stubEnv('MEMMY_DESKTOP_MANAGED_GATEWAY', '1'); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('temporary Mac native Computer Use yield', () => {
  it('keeps reads and actions on the observed window even after focus changes', async () => {
    const { owner, callTool, guard, context } = fixture();
    await owner.invoke('get_app_state', { app: 'WPS' }, 30, context);
    await owner.invoke('click', { app: 'WPS', element_index: '42' }, 30, context);
    await owner.invoke('get_app_state', { app: 'WPS' }, 30, context);
    expect(callTool.mock.calls.map(call => call[1])).toEqual([
      { app: 'WPS' }, { app: 'WPS', element_index: '42', window_id: 52 }, { app: 'WPS', window_id: 52 },
    ]);
    expect(guard.mock.calls[1][4]).toMatchObject({ targetWindowId: 52, yieldOnUserInput: true });
    await owner.close();
  });

  it('requires a fresh explicit observation before switching to a new document', async () => {
    const { owner, callTool, context } = fixture();
    await owner.invoke('get_app_state', { app: 'WPS' }, 30, context);
    const denied = await owner.invoke('type_text', { app: 'WPS', window_id: 53, text: 'draft' }, 30, context);
    expect(denied.isError).toBe(true);
    expect(callTool).toHaveBeenCalledOnce();
    const nextState = { ...currentState, _meta: { memmyComputerUse: { targetWindowID: 53, pid: 20 } } };
    callTool.mockResolvedValue(nextState);
    await owner.invoke('get_app_state', { app: 'WPS', window_id: 53 }, 30, context);
    await owner.invoke('type_text', { app: 'WPS', text: 'draft' }, 30, context);
    expect(callTool.mock.calls[2][1]).toEqual({ app: 'WPS', text: 'draft', window_id: 53 });
    await owner.close();
  });

  it('isolates window bindings across chats and new user messages', async () => {
    const { owner, callTool, context } = fixture();
    await owner.invoke('get_app_state', { app: 'WPS' }, 30, context);
    const other = new RequestContext({ ...context, chatId: 'other' });
    callTool.mockResolvedValueOnce({ ...currentState, _meta: { memmyComputerUse: { targetWindowID: 53, pid: 20 } } });
    await owner.invoke('get_app_state', { app: 'WPS' }, 30, other);
    await owner.invoke('get_app_state', { app: 'WPS' }, 30, context);
    await owner.invoke('get_app_state', { app: 'WPS' }, 30,
      new RequestContext({ ...context, messageId: 'new-message' }));
    expect(callTool.mock.calls.map(call => call[1])).toEqual([
      { app: 'WPS' }, { app: 'WPS' }, { app: 'WPS', window_id: 52 }, { app: 'WPS' },
    ]);
    await owner.close();
  });

  it('requeries the bound window after a physical takeover without replaying the action', async () => {
    const { owner, callTool, guard, context } = fixture();
    await owner.invoke('get_app_state', { app: 'WPS' }, 30, context);
    guard.mockRejectedValueOnce(new OcuUserYielded(true));
    const result = await owner.invoke('click', { app: 'WPS', x: 3, y: 5 }, 30, context);
    expect(result.content[0].text).toContain('was not replayed');
    expect(callTool.mock.calls.map(call => call[0])).toEqual(['get_app_state', 'get_app_state']);
    expect(callTool.mock.calls[1][1]).toEqual({ app: 'WPS', window_id: 52 });
    await owner.close();
  });

  it('rejects a drifted helper frame without rebinding or blocking the next observation', async () => {
    const { owner, callTool, context, connect } = fixture();
    await owner.invoke('get_app_state', { app: 'WPS' }, 30, context);
    callTool.mockResolvedValueOnce({ ...currentState, _meta: { memmyComputerUse: { targetWindowID: 53, pid: 20 } } });
    const result = await owner.invoke('get_app_state', { app: 'WPS' }, 30, context);
    expect(result).toMatchObject({ isError: true });
    await owner.invoke('get_app_state', { app: 'WPS' }, 30, context);
    expect(callTool.mock.calls[2][1]).toEqual({ app: 'WPS', window_id: 52 });
    expect(connect).toHaveBeenCalledOnce();
    await owner.close();
  });

  it('reobserves after a JS predispatch yield and keeps the same user message usable', async () => {
    const { owner, callTool, guard, context, connect, probe } = fixture();
    guard.mockRejectedValueOnce(new OcuUserYielded(false));
    const result = await owner.invoke('click', { app: 'WPS', element_index: '42' }, 30, context);
    expect(result.content[0].text).toContain('was NOT dispatched');
    expect(result.content[1].text).toBe('Current WPS document state');
    expect(callTool.mock.calls).toEqual([['get_app_state', { app: 'WPS' }, 30]]);
    await expect(owner.invoke('press_key', { app: 'WPS', key: 'Enter' }, 30, context)).resolves.toEqual(currentState);
    expect(callTool.mock.calls[1]).toEqual(['press_key', { app: 'WPS', key: 'Enter', window_id: 52 }, 30]);
    expect(connect).toHaveBeenCalledOnce();
    expect(probe).not.toHaveBeenCalled();
    await owner.close();
  });

  it.each([beforeMarker, afterMarker])('waits after a native dispatch guard race, then reobserves without replay (%s)', async marker => {
    const { owner, callTool, wait, context, connect } = fixture();
    callTool.mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: marker }] });
    const result = await owner.invoke('click', { app: 'WPS', x: 3, y: 5 }, 30, context);
    expect(wait).toHaveBeenCalledWith('WPS', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(result.content[0].text).toContain(marker === beforeMarker ? 'was NOT dispatched' : 'was not replayed');
    expect(callTool.mock.calls).toEqual([['click', { app: 'WPS', x: 3, y: 5 }, 30],
      ['get_app_state', { app: 'WPS' }, 30]]);
    await owner.invoke('set_value', { app: 'WPS', element_index: '43', value: 'new' }, 30, context);
    expect(callTool).toHaveBeenCalledTimes(3);
    expect(connect).toHaveBeenCalledOnce();
    await owner.close();
  });

  it('returns a temporary wait at the deadline without poisoning permissions or reconnecting', async () => {
    const { owner, callTool, guard, context, connect, probe } = fixture();
    guard.mockRejectedValueOnce(new OcuUserYielded(false, true));
    const result = await owner.invoke('type_text', { app: 'WPS', text: 'stale text' }, 30, context);
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toContain('temporary yield, not a permission failure');
    expect(callTool).not.toHaveBeenCalled();
    await owner.invoke('get_app_state', { app: 'WPS' }, 30, context);
    expect(callTool.mock.calls).toEqual([['get_app_state', { app: 'WPS' }, 30]]);
    expect(connect).toHaveBeenCalledOnce();
    expect(probe).not.toHaveBeenCalled();
    await owner.close();
  });

  it('cancels a pending native yield on session removal without sending another action', async () => {
    const { owner, callTool, wait, context } = fixture();
    callTool.mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: beforeMarker }] });
    wait.mockImplementation(async (_target, { signal }) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
    }));
    const pending = owner.invoke('click', { app: 'WPS', element_index: '42' }, 30, context);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce());
    await owner.close();
    await rejected;
    expect(callTool).toHaveBeenCalledOnce();
  });

  it('does not interpret ordinary app text or a multi-block native error as a yield marker', async () => {
    const { owner, callTool, wait, context } = fixture();
    const ordinary = { content: [{ type: 'text', text: beforeMarker }] };
    const ambiguous = { isError: true, content: [{ type: 'text', text: beforeMarker }, { type: 'text', text: 'other failure' }] };
    callTool.mockResolvedValueOnce(ordinary).mockResolvedValueOnce(ambiguous);
    expect(await owner.invoke('get_app_state', { app: 'WPS' }, 30, context)).toBe(ordinary);
    expect(await owner.invoke('click', { app: 'WPS', x: 3, y: 5 }, 30, context)).toBe(ambiguous);
    expect(wait).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledTimes(2);
    await owner.close();
  });

  it.each([false, true])('does not stop the agent turn for a temporary yield (deadline=%s)', async timedOut => {
    const { owner, guard, context, callTool } = fixture();
    callTool.mockResolvedValue({ ...currentState, _meta: { memmyComputerUse: {
      ...currentState._meta.memmyComputerUse, observationID: 'first-observation',
    } } });
    const observe = new MCPToolWrapper({}, 'memmy_computer_use', { name: 'get_app_state' }, 30, undefined, owner);
    observe.setContext(context);
    await observe.execute({ app: 'WPS' });
    guard.mockRejectedValueOnce(new OcuUserYielded(false, timedOut));
    const tool = new MCPToolWrapper({}, 'memmy_computer_use', { name: 'click' }, 30, undefined, owner);
    tool.setContext(context);
    const stop = vi.fn();
    expect(await tool.execute({ app: 'WPS', x: 3, y: 5 }, { stopTurn: stop })).toContain('was NOT dispatched');
    expect(stop).not.toHaveBeenCalled();
    expect(guard.mock.calls.at(-1)?.[1]).toBe('click');
    await owner.close();
  });

  it('reports cancellation while yielding without replacing it with a permission-stop message', async () => {
    const { owner, callTool, wait, context } = fixture();
    callTool.mockResolvedValueOnce({ ...currentState, _meta: { memmyComputerUse: {
      ...currentState._meta.memmyComputerUse, observationID: 'first-observation',
    } } });
    const observe = new MCPToolWrapper({}, 'memmy_computer_use', { name: 'get_app_state' }, 30, undefined, owner);
    observe.setContext(context);
    await observe.execute({ app: 'WPS' });
    callTool.mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: beforeMarker }] });
    wait.mockImplementation(async (_target, { signal }) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
    }));
    const tool = new MCPToolWrapper({}, 'memmy_computer_use', { name: 'click' }, 30, undefined, owner);
    tool.setContext(context);
    const controller = new AbortController();
    const stop = vi.fn();
    const pending = tool.execute({ app: 'WPS', x: 3, y: 5 }, { stopTurn: stop, abortSignal: controller.signal });
    await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce());
    controller.abort();
    expect(await pending).toBe('(MCP tool call was cancelled)');
    expect(stop).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledTimes(2);
    await owner.close();
  });
});
