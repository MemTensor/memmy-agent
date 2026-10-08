import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestContext } from '../../../src/core/agent-runtime/tools/context.js';
import { NativeAppApprovalDenied, NativeAppApprovalGate, NativeAppApprovalStore,
  resolveNativeAppIdentity } from '../../../src/tools/computer-use/native-app-approvals.js';

const roots: string[] = [];
function store() {
  const root = mkdtempSync(join(tmpdir(), 'memmy-app-approval-'));
  roots.push(root);
  return new NativeAppApprovalStore(join(root, 'approvals.json'));
}
const calculator = { platform: 'darwin' as const, appId: 'com.apple.calculator', displayName: '计算器' };
const turn = (id: string) => new RequestContext({ channel: 'webui', chatId: 'test',
  sessionKey: 'test', messageId: id });

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('native app approval', () => {
  it('resolves only an exact unambiguous native helper identity', () => {
    const result = { content: [{ type: 'text', text:
      '计算器 — com.apple.calculator [running]\nOther — example.other [running]' }] };
    expect(resolveNativeAppIdentity(result, '计算器', 'darwin')).toEqual(calculator);
    expect(resolveNativeAppIdentity(result, 'Calculator', 'darwin')).toEqual(calculator);
    expect(resolveNativeAppIdentity(result, calculator.appId, 'darwin')).toEqual(calculator);
    expect(resolveNativeAppIdentity(result, 'missing', 'darwin')).toBeNull();
    expect(resolveNativeAppIdentity({ content: [{ type: 'text', text:
      'Same — example.one [running]\nSame — example.two [running]' }] }, 'Same', 'darwin')).toBeNull();
    expect(resolveNativeAppIdentity({ content: [{ type: 'text', text:
      '计算器 — com.apple.calculator [running]\nOther — example.calculator [running]' }] }, 'Calculator', 'darwin')).toBeNull();
    expect(resolveNativeAppIdentity({ isError: true, content: result.content }, '计算器', 'darwin')).toBeNull();
  });

  it('parses the pinned Windows process/PID format and rejects ambiguous instances', () => {
    const result = { content: [{ type: 'text', text:
      'notepad -- notepad [running, pid=4812, window=Untitled - Notepad]\n' +
      'calc -- calc [running, pid=2049, window=Calculator]' }] };
    expect(resolveNativeAppIdentity(result, 'notepad', 'win32')).toEqual({ platform: 'win32',
      appId: 'notepad', displayName: 'notepad', runtimeSelector: '4812' });
    expect(resolveNativeAppIdentity(result, '4812', 'win32')?.appId).toBe('notepad');
    expect(resolveNativeAppIdentity(result, 'notepad.exe', 'win32')?.appId).toBe('notepad');
    expect(resolveNativeAppIdentity({ content: [{ type: 'text', text:
      'notepad -- notepad [running, pid=4812, window=One]\n' +
      'notepad -- notepad [running, pid=4813, window=Two]' }] }, 'notepad', 'win32')).toBeNull();
  });

  it('asks before use, scopes allow-once and deny to a single user message', async () => {
    const ask = vi.fn().mockResolvedValueOnce('allow-once').mockResolvedValueOnce('deny');
    const approvals = store();
    const gate = new NativeAppApprovalGate(approvals, ask);
    await gate.authorize(calculator, turn('first'));
    await gate.authorize(calculator, turn('first'));
    expect(ask).toHaveBeenCalledTimes(1);
    await expect(gate.authorize(calculator, turn('second'))).rejects.toBeInstanceOf(NativeAppApprovalDenied);
    await expect(gate.authorize(calculator, turn('second'))).rejects.toBeInstanceOf(NativeAppApprovalDenied);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(approvals.list()).toEqual([]);
  });

  it('persists only explicit always allow and revocation takes effect before the next operation', async () => {
    const ask = vi.fn().mockResolvedValueOnce('allow-always').mockResolvedValueOnce('deny');
    const approvals = store();
    const gate = new NativeAppApprovalGate(approvals, ask);
    await gate.authorize(calculator, turn('first'));
    expect(approvals.list()).toMatchObject([{ appId: calculator.appId }]);
    await gate.authorize(calculator, turn('second'));
    expect(ask).toHaveBeenCalledTimes(1);
    approvals.remove('darwin', calculator.appId);
    await expect(gate.authorize(calculator, turn('second'))).rejects.toBeInstanceOf(NativeAppApprovalDenied);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('fails closed for missing interactive context and protected terminal apps', async () => {
    const ask = vi.fn().mockResolvedValue('allow-always');
    const gate = new NativeAppApprovalGate(store(), ask);
    await expect(gate.authorize(calculator, null)).rejects.toBeInstanceOf(NativeAppApprovalDenied);
    await expect(gate.authorize({ platform: 'darwin', appId: 'com.apple.Terminal', displayName: 'Terminal' },
      turn('first'))).rejects.toBeInstanceOf(NativeAppApprovalDenied);
    await expect(gate.authorize({ platform: 'win32', appId: 'powershell', displayName: 'powershell' },
      turn('first'))).rejects.toBeInstanceOf(NativeAppApprovalDenied);
    expect(ask).not.toHaveBeenCalled();
  });

  it('fails closed when the desktop replies with an unexpected decision', async () => {
    const ask = vi.fn().mockResolvedValue('unexpected');
    const approvals = store();
    const gate = new NativeAppApprovalGate(approvals, ask);
    await expect(gate.authorize(calculator, turn('first'))).rejects.toBeInstanceOf(NativeAppApprovalDenied);
    expect(approvals.list()).toEqual([]);
  });
});
