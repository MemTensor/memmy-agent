import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RequestContext } from '../../../src/core/agent-runtime/tools/context.js';
import { ManagedOcuSession, OCU_TOOLS, OcuBlocked } from '../../../src/tools/computer-use/managed-ocu-session.js';
import { NativeAppApprovalGate, NativeAppApprovalStore, InstalledAppIdentityLookupError }
  from '../../../src/tools/computer-use/native-app-approvals.js';
import { recordNativeFailure } from '../../../src/tools/computer-use/native-diagnostics.js';
import { MCPToolWrapper } from '../../../src/core/agent-runtime/tools/mcp.js';

const calculator = { platform: 'darwin' as const, appId: 'com.apple.calculator', displayName: '计算器' };
const roots: string[] = [];
const turn = (id: string) => new RequestContext({ messageId: id, sessionKey: 'chat', channel: 'websocket', chatId: 'chat' });
function fixture(ask = vi.fn().mockResolvedValue('allow-once'), resolver = vi.fn().mockResolvedValue(calculator)) {
  const root = mkdtempSync(join(tmpdir(), 'memmy-identity-recovery-')); roots.push(root);
  const calls: any[] = [];
  const connect = vi.fn(async () => {
    const callTool = vi.fn(async (name: string) => ({ content: [{ type: 'text', text: name === 'list_apps' ? 'WPS — com.kingsoft.wpsoffice.mac [running]' : 'state' }] }));
    const session = { callTool, ping: vi.fn().mockResolvedValue({}), listTools: vi.fn().mockResolvedValue({ tools: [...OCU_TOOLS].map(name => ({ name, inputSchema: {} })) }) };
    const c = { session, close: vi.fn().mockResolvedValue(undefined) }; calls.push(c); return c;
  });
  const owner = new ManagedOcuSession(connect, async () => ({ state: 'granted' }), undefined, undefined,
    { platform: 'darwin', appApprovals: new NativeAppApprovalGate(new NativeAppApprovalStore(join(root, 'approval.json')), ask), appIdentityResolver: resolver });
  return { owner, calls, connect, ask, resolver };
}
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });

describe('installed application approval and connection recovery', () => {
  it('resolves an app missing from the recent list, then waits for approval before launch/state', async () => {
    let approve!: (value: string) => void;
    const ask = vi.fn(() => new Promise(resolve => { approve = resolve; }));
    const f = fixture(ask); await f.owner.initialize();
    try {
      const state = f.owner.invoke('get_app_state', { app: 'Calculator', require_screenshot: true }, 30, turn('first'));
      await vi.waitFor(() => expect(ask).toHaveBeenCalledOnce());
      expect(f.resolver).toHaveBeenCalledWith('Calculator', 'darwin', expect.any(AbortSignal));
      expect(ask).toHaveBeenCalledWith(calculator);
      expect(f.calls[0].session.callTool.mock.calls.map((x: any[]) => x[0])).toEqual(['list_apps']);
      approve('allow-once'); await state;
      expect(f.calls[0].session.callTool).toHaveBeenLastCalledWith('get_app_state', { app: calculator.appId, require_screenshot: true }, 30);
    } finally { await f.owner.close(); }
  });
  it('does not ask or launch when installed lookup finds ambiguous copies', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const f = fixture(undefined, vi.fn().mockRejectedValue(new InstalledAppIdentityLookupError('ambiguous')));
    try {
      await expect(f.owner.invoke('get_app_state', { app: 'Calculator' }, 30, turn('ambiguous'))).rejects.toThrow('多个匹配应用');
      expect(f.ask).not.toHaveBeenCalled();
      expect(f.calls[0].session.callTool.mock.calls.map((x: any[]) => x[0])).toEqual(['list_apps']);
    } finally { await f.owner.close(); }
  });
  it('keeps a list RPC failure distinct from app lookup and reconnects for the next user message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const f = fixture(); await f.owner.initialize();
    f.calls[0].session.callTool.mockRejectedValueOnce(Object.assign(new Error('private document details'), { code: 'ECONNRESET' }));
    try {
      await expect(f.owner.invoke('get_app_state', { app: 'Calculator' }, 30, turn('failed'))).rejects.toMatchObject({ status: { reason: 'connectionFailed', diagnostic: { stage: 'list-apps', code: 'ECONNRESET' } } });
      expect(f.resolver).not.toHaveBeenCalled(); expect(f.ask).not.toHaveBeenCalled();
      await f.owner.invoke('get_app_state', { app: 'Calculator' }, 30, turn('new-user-message'));
      expect(f.connect).toHaveBeenCalledTimes(2);
      expect(f.calls[0].session.callTool).toHaveBeenCalledOnce();
      expect(f.calls[1].session.callTool).toHaveBeenLastCalledWith('get_app_state', { app: calculator.appId }, 30);
    } finally { await f.owner.close(); }
  });
  it('rebuilds once after initialization transport failure before any target operation', async () => {
    const f = fixture(); f.connect.mockRejectedValueOnce(Object.assign(new Error('pipe closed'), { code: 'ECONNRESET' }));
    try {
      await f.owner.invoke('get_app_state', { app: 'Calculator' }, 30, turn('initial-transport'));
      expect(f.connect).toHaveBeenCalledTimes(2);
      expect(f.calls[0].session.callTool.mock.calls.map((x: any[]) => x[0])).toEqual(['list_apps', 'get_app_state']);
    } finally { await f.owner.close(); }
  });
  it('logs bounded failure metadata without the document, arguments, message id or raw error', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    recordNativeFailure('ping', Object.assign(new Error('SECRET document /users/private'), { code: 'ECONNRESET' }), turn('SECRET-message-id'));
    const recorded = JSON.parse(log.mock.calls[0][1]);
    expect(recorded).toMatchObject({ stage: 'ping', code: 'ECONNRESET', hasMessageId: true, actionMayHaveBeenDispatched: false });
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
    recordNativeFailure('ping', { code: 'SECRET-token', name: 'SECRET_document' });
    expect(JSON.parse(log.mock.calls[1][1])).toMatchObject({ code: 'native-failure', errorName: 'Error' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
  });
  it('reports connection failure without claiming a missing system permission', async () => {
    const managed = { invoke: vi.fn().mockRejectedValue(new OcuBlocked({ state: 'unknown', reason: 'connectionFailed', diagnostic: { id: '12345678', stage: 'ping', code: 'ECONNRESET' } })) };
    const tool = new MCPToolWrapper({}, 'memmy-computer-use', { name: 'get_app_state' }, 30, undefined, managed as any);
    const stopTurn = vi.fn();
    const result = await tool.execute({ app: 'WPS' }, { stopTurn });
    expect(result).toContain('辅助程序连接或读取失败'); expect(result).toContain('12345678');
    expect(result).not.toContain('尚未完成权限设置'); expect(stopTurn).toHaveBeenCalledWith(result);
  });
});
