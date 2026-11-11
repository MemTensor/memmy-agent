import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RequestContext } from '../../../src/core/agent-runtime/tools/context.js';
import { ManagedOcuSession, OCU_TOOLS } from '../../../src/tools/computer-use/managed-ocu-session.js';
import { MCPToolWrapper } from '../../../src/core/agent-runtime/tools/mcp.js';
import { InstalledAppIdentityLookupError, NativeAppApprovalDenied, NativeAppApprovalGate, NativeAppApprovalStore }
  from '../../../src/tools/computer-use/native-app-approvals.js';

const APP_ID = 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App';
const identity = { platform: 'win32' as const, appId: APP_ID, displayName: '计算器' };
const runningApp = { appId: APP_ID, displayName: '计算器', processName: 'CalculatorApp',
  pid: 2049, aliases: ['Calculator'] };
const listing = { content: [{ type: 'text', text: '计算器 -- CalculatorApp [running, pid=2049]' }],
  _meta: { memmyComputerUse: { runningApps: { version: 1, apps: [runningApp] } } } };
const state = { content: [{ type: 'text', text: 'Calculator buttons 3, +, 2, =' }],
  _meta: { memmyComputerUse: { targetWindowID: 1001, pid: 2049, observationID: 'calculator-observation' } } };
const roots: string[] = [];
const owners: ManagedOcuSession[] = [];
const context = new RequestContext({ messageId: 'user-message', sessionKey: 'calculator-chat',
  channel: 'websocket', chatId: 'calculator-chat' });
function fixture(ask = vi.fn().mockResolvedValue('allow-once'), approvals = true,
  resolver = vi.fn().mockRejectedValue(new InstalledAppIdentityLookupError('not-found'))) {
  const root = mkdtempSync(join(tmpdir(), 'memmy-win-app-identity-')); roots.push(root);
  const callTool = vi.fn(async (name: string, _args: Record<string, unknown>): Promise<any> => name === 'list_apps' ? listing : state);
  const gate = new NativeAppApprovalGate(new NativeAppApprovalStore(join(root, 'approvals.json')), ask);
  const wait = vi.fn().mockResolvedValue(true);
  const owner = new ManagedOcuSession(async () => ({ close: async () => undefined, session: {
    ping: async () => ({}), callTool,
    listTools: async () => ({ tools: [...OCU_TOOLS].map(name => ({ name, inputSchema: {} })) }),
  } }), async () => ({ state: 'granted' }), undefined, undefined,
  { platform: 'win32', appApprovals: approvals ? gate : null, windowsWaitForTargetIdle: wait, appIdentityResolver: resolver });
  owners.push(owner);
  return { owner, callTool, ask, wait, resolver };
}
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
  vi.restoreAllMocks();
});

describe('Windows localized application identity and approval dispatch', () => {
  it('keeps an ambiguous Windows name recoverable, without approval or input, then resolves an exact PID', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const f = fixture(undefined, true, vi.fn().mockRejectedValue(new InstalledAppIdentityLookupError('ambiguous')));
    const candidates = { ...listing, _meta: { memmyComputerUse: { runningApps: { version: 1,
      apps: [runningApp, { ...runningApp, pid: 2050 }] } } } };
    f.callTool.mockImplementation(async name => name === 'list_apps' ? candidates : state);
    const tool = new MCPToolWrapper({}, 'memmy-computer-use', { name: 'get_app_state' }, 30, undefined, f.owner);
    tool.setContext(context);
    const stopTurn = vi.fn();
    const unresolved = await tool.execute({ app: 'Calculator' }, { stopTurn });
    expect(unresolved).toContain('list_apps');
    expect(unresolved).toContain('尚未请求应用授权');
    expect(stopTurn).not.toHaveBeenCalled();
    expect(f.ask).not.toHaveBeenCalled();
    expect(f.callTool.mock.calls.map(call => call[0])).toEqual(['list_apps']);

    await f.owner.invoke('list_apps', {}, 30, context);
    const resolved = await f.owner.invoke('get_app_state', { app: '2049' }, 30, context);
    expect(resolved._meta.memmyComputerUse).toMatchObject({ targetWindowID: 1001, pid: 2049 });
    expect(f.ask).toHaveBeenCalledExactlyOnceWith(identity);
    expect(f.callTool.mock.calls.map(call => call[0])).toEqual(['list_apps', 'list_apps', 'list_apps', 'get_app_state']);
    expect(f.callTool.mock.calls.at(-1)![1]).toMatchObject({ app: '2049', _memmy_expected_app_id: APP_ID });
  });

  it('still ends the turn after an actual Windows app approval refusal', async () => {
    const f = fixture(vi.fn().mockResolvedValue('deny'));
    const tool = new MCPToolWrapper({}, 'memmy-computer-use', { name: 'get_app_state' }, 30, undefined, f.owner);
    tool.setContext(context);
    const stopTurn = vi.fn();
    const result = await tool.execute({ app: '2049' }, { stopTurn });
    expect(result).toContain('was not allowed');
    expect(stopTurn).toHaveBeenCalledExactlyOnceWith(result);
    expect(f.ask).toHaveBeenCalledExactlyOnceWith(identity);
    expect(f.callTool.mock.calls.map(call => call[0])).toEqual(['list_apps']);
  });

  it('waits for approval of the native package identity and binds the selected PID to that identity', async () => {
    let approve!: (value: string) => void;
    const ask = vi.fn(() => new Promise<string>(resolve => { approve = resolve; }));
    const f = fixture(ask);
    const pending = f.owner.invoke('get_app_state', { app: '计算器', require_screenshot: true,
      _memmy_expected_app_id: 'forged.identity' }, 30, context);
    await vi.waitFor(() => expect(ask).toHaveBeenCalledOnce());
    expect(ask).toHaveBeenCalledWith(identity);
    expect(f.callTool.mock.calls.map(call => call[0])).toEqual(['list_apps']);
    approve('allow-once'); await pending;
    expect(f.callTool).toHaveBeenLastCalledWith('get_app_state', expect.objectContaining({ app: '2049',
      require_screenshot: true, _memmy_expected_app_id: APP_ID, _host_deadline_epoch_ms: expect.any(Number) }),
    30, expect.any(AbortSignal));
  });

  it('withholds every target tool when approval is denied', async () => {
    const f = fixture(vi.fn().mockResolvedValue('deny'));
    await expect(f.owner.invoke('click', { app: 'Calculator', element_index: 3 }, 30, context))
      .rejects.toBeInstanceOf(NativeAppApprovalDenied);
    expect(f.ask).toHaveBeenCalledWith(identity);
    expect(f.callTool.mock.calls.map(call => call[0])).toEqual(['list_apps']);
  });

  it('carries the approved identity when a model action is replaced by a fresh observation', async () => {
    const f = fixture();
    const result = await f.owner.invoke('click', { app: '计算器', element_index: 3,
      _memmy_expected_app_id: 'forged.identity' }, 30, context, undefined, { modelVisible: true });
    expect(result._meta.memmyComputerUse).toMatchObject({ noActionDispatched: true });
    expect(f.callTool.mock.calls.map(call => call[0])).toEqual(['list_apps', 'get_app_state']);
    expect(f.callTool.mock.calls[1][1]).toMatchObject({ app: '2049', _memmy_expected_app_id: APP_ID });
    expect(f.callTool.mock.calls[1][1]).not.toHaveProperty('element_index');
  });

  it('retains identity and window binding during a user-input yield without replaying the action', async () => {
    const f = fixture();
    await f.owner.invoke('get_app_state', { app: '计算器' }, 30, context);
    f.callTool.mockImplementation(async (name: string) => name === 'list_apps' ? listing : name === 'click'
      ? { isError: true, content: [{ type: 'text', text: 'Physical input detected' }],
        _meta: { memmyComputerUse: { targetWindowID: 1001, pid: 2049, userYield: { dispatched: false } } } }
      : state);
    const result = await f.owner.invoke('click', { app: '计算器', element_index: 3 }, 30, context);
    expect(result.content[0].text).toContain('was NOT dispatched');
    expect(f.callTool.mock.calls.map(call => call[0])).toEqual(['list_apps', 'get_app_state',
      'list_apps', 'click', 'get_app_state']);
    expect(f.callTool.mock.calls[4][1]).toMatchObject({ app: '2049', window_id: 1001, _memmy_expected_app_id: APP_ID });
    expect(f.wait).toHaveBeenCalledOnce();
  });

  it('does not borrow a stale discovery result when the selected app has exited', async () => {
    const f = fixture();
    await f.owner.invoke('get_app_state', { app: '计算器' }, 30, context);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    f.callTool.mockResolvedValueOnce({ ...listing,
      _meta: { memmyComputerUse: { runningApps: { version: 1, apps: [] } } } });
    await expect(f.owner.invoke('click', { app: '计算器', element_index: 3 }, 30, context))
      .rejects.toBeInstanceOf(NativeAppApprovalDenied);
    expect(f.ask).toHaveBeenCalledOnce();
    expect(f.callTool.mock.calls.map(call => call[0])).toEqual(['list_apps', 'get_app_state', 'list_apps']);
  });

  it('approves an app missing from the running list, opens it by identity, then acts on its new window by PID', async () => {
    const weixin = { platform: 'win32' as const, appId: 'Weixin', displayName: '微信' };
    const f = fixture(undefined, true, vi.fn().mockResolvedValue(weixin));
    const opened = { content: [{ type: 'text', text: 'Weixin chat list' }],
      _meta: { memmyComputerUse: { targetWindowID: 3002, pid: 3001, observationID: 'weixin-observation' } } };
    const running = { ...listing, _meta: { memmyComputerUse: { runningApps: { version: 1, apps: [runningApp,
      { appId: 'Weixin', displayName: '微信', processName: 'Weixin', pid: 3001, aliases: [] }] } } } };
    let launched = false;
    f.callTool.mockImplementation(async (name: string) => {
      if (name === 'list_apps') return launched ? running : listing;
      launched = true;
      return opened;
    });
    const result = await f.owner.invoke('get_app_state', { app: '微信' }, 30, context, undefined, { modelVisible: true });
    expect(f.resolver).toHaveBeenCalledWith('微信', 'win32', expect.any(AbortSignal));
    expect(f.ask).toHaveBeenCalledWith(weixin);
    expect(f.callTool.mock.calls[1][1]).toMatchObject({ app: 'Weixin', _memmy_expected_app_id: 'Weixin' });
    f.owner.presentModelResult('get_app_state', { app: '微信' }, result, 'Weixin chat list', context);
    await f.owner.invoke('click', { app: '微信', element_index: 3 }, 30, context, undefined, { modelVisible: true });
    expect(f.ask).toHaveBeenCalledOnce();
    expect(f.callTool.mock.calls.map(call => call[0])).toEqual(['list_apps', 'get_app_state', 'list_apps', 'click']);
    expect(f.callTool.mock.calls[3][1]).toMatchObject({ app: '3001', window_id: 3002,
      observation_id: 'weixin-observation', _memmy_expected_app_id: 'Weixin' });
  });

  it('strips forged private identity fields even when the host approval gate is disabled', async () => {
    const f = fixture(undefined, false);
    await f.owner.invoke('get_app_state', { app: 'CalculatorApp', _memmy_expected_app_id: APP_ID }, 30, context);
    expect(f.callTool.mock.calls[0][1]).not.toHaveProperty('_memmy_expected_app_id');
  });
});
