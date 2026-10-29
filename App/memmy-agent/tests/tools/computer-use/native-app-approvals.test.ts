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
    expect(resolveNativeAppIdentity(result, 'Calculator', 'darwin')).toBeNull();
    expect(resolveNativeAppIdentity(result, calculator.appId, 'darwin')).toEqual(calculator);
    expect(resolveNativeAppIdentity(result, 'missing', 'darwin')).toBeNull();
    expect(resolveNativeAppIdentity({ content: [{ type: 'text', text:
      'Same — example.one [running]\nSame — example.two [running]' }] }, 'Same', 'darwin')).toBeNull();
    expect(resolveNativeAppIdentity({ content: [{ type: 'text', text:
      '计算器 — com.apple.calculator [running]\nOther — example.calculator [running]' }] }, 'Calculator', 'darwin')).toBeNull();
    expect(resolveNativeAppIdentity({ isError: true, content: result.content }, '计算器', 'darwin')).toBeNull();
    expect(resolveNativeAppIdentity({ content: [{ type: 'text', text:
      'Other — example.calculator [running]' }] }, 'Calculator', 'darwin')).toBeNull();
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
    expect(resolveNativeAppIdentity(result, 'Untitled - Notepad', 'win32')).toBeNull();
  });

  const windowsCalculator = { appId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', displayName: '计算器',
    processName: 'CalculatorApp', pid: 2049, aliases: ['Calculator', 'Windows Calculator'] };
  function windowsListing(apps: unknown[], discovery: Record<string, unknown> = {}) {
    return { content: [{ type: 'text', text: 'notepad -- notepad [running, pid=4812, window=私人文档]' }],
      _meta: { memmyComputerUse: { runningApps: { version: 1, apps, ...discovery } } } };
  }
  const resolvedWindowsCalculator = { platform: 'win32', appId: windowsCalculator.appId,
    displayName: '计算器', runtimeSelector: '2049' };

  it('resolves a localized Windows app from native installed names while retaining its exact PID and package identity', () => {
    const listing = windowsListing([windowsCalculator]);
    for (const target of ['计算器', 'Calculator', 'CalculatorApp', 'calculatorapp.exe', windowsCalculator.appId, '2049'])
      expect(resolveNativeAppIdentity(listing, target, 'win32')).toEqual(resolvedWindowsCalculator);
    expect(resolveNativeAppIdentity(listing, 'calc', 'win32')).toBeNull();
    expect(resolveNativeAppIdentity(listing, '私人文档', 'win32')).toBeNull();
    expect(resolveNativeAppIdentity(listing, 'notepad', 'win32')).toBeNull();
  });

  it('keeps same-named Windows apps and separate instances ambiguous until an exact ID or PID is supplied', () => {
    const twoInstances = windowsListing([windowsCalculator, { ...windowsCalculator, pid: 2050 }]);
    expect(resolveNativeAppIdentity(twoInstances, '计算器', 'win32')).toBeNull();
    expect(resolveNativeAppIdentity(twoInstances, windowsCalculator.appId, 'win32')).toBeNull();
    expect(resolveNativeAppIdentity(twoInstances, '2049', 'win32')).toEqual(resolvedWindowsCalculator);
    const sameAlias = windowsListing([windowsCalculator,
      { ...windowsCalculator, appId: 'example.other', processName: 'OtherCalculator', pid: 2050 }]);
    expect(resolveNativeAppIdentity(sameAlias, 'Calculator', 'win32')).toBeNull();
    expect(resolveNativeAppIdentity(sameAlias, windowsCalculator.appId, 'win32')).toEqual(resolvedWindowsCalculator);
    expect(resolveNativeAppIdentity(windowsListing([windowsCalculator, windowsCalculator]),
      '计算器', 'win32')).toEqual(resolvedWindowsCalculator);
  });

  it('rejects inconsistent identity metadata for the same PID instead of choosing one label', () => {
    for (const extra of [{ appId: 'example.other' }, { processName: 'OtherProcess' },
      { appId: 'powershell', processName: 'powershell' }]) {
      const listing = windowsListing([windowsCalculator, { ...windowsCalculator, ...extra }]);
      expect(resolveNativeAppIdentity(listing, '2049', 'win32')).toBeNull();
    }
  });

  it('fails closed on malformed native metadata without downgrading to the legacy text format', () => {
    const invalidApps = [
      { ...windowsCalculator, pid: 0 }, { ...windowsCalculator, pid: -1 },
      { ...windowsCalculator, pid: 1.5 }, { ...windowsCalculator, pid: 0x80000000 },
      { ...windowsCalculator, pid: '2049' }, { ...windowsCalculator, appId: '../calculator' },
      { ...windowsCalculator, displayName: '计算器\nnotepad' },
      { ...windowsCalculator, aliases: 'notepad' }, { ...windowsCalculator, aliases: [''] },
      { ...windowsCalculator, aliases: Array(17).fill('Calculator') }, null,
    ];
    for (const invalid of invalidApps)
      expect(resolveNativeAppIdentity(windowsListing([invalid]), 'notepad', 'win32')).toBeNull();
    for (const discovery of [{ version: 2 }, { apps: 'notepad' }, { apps: Array(1025).fill(windowsCalculator) }])
      expect(resolveNativeAppIdentity(windowsListing([], discovery), 'notepad', 'win32')).toBeNull();
    expect(resolveNativeAppIdentity(windowsListing([]), 'notepad', 'win32')).toBeNull();
  });

  it('does not authorize a shared UWP host or hide a blocked terminal behind a package identity', () => {
    for (const processName of ['ApplicationFrameHost', 'PowerShell', 'WindowsTerminal']) {
      const listing = windowsListing([{ ...windowsCalculator, processName }]);
      expect(resolveNativeAppIdentity(listing, '2049', 'win32')).toBeNull();
      expect(resolveNativeAppIdentity(listing, '计算器', 'win32')).toBeNull();
    }
  });

  it('resolves Memmy itself and asks for approval like any other app', async () => {
    const memmy = { platform: 'darwin' as const, appId: 'cn.memtensor.memmy', displayName: 'Memmy' };
    expect(resolveNativeAppIdentity({ content: [{ type: 'text', text: 'Memmy — cn.memtensor.memmy [running]' }] },
      'Memmy', 'darwin')).toEqual(memmy);
    expect(resolveNativeAppIdentity(windowsListing([{ appId: 'cn.memtensor.memmy', displayName: 'Memmy',
      processName: 'Memmy', pid: 3001 }]), 'Memmy', 'win32')).toEqual({ platform: 'win32',
      appId: 'cn.memtensor.memmy', displayName: 'Memmy', runtimeSelector: '3001' });
    const ask = vi.fn().mockResolvedValue('allow-once');
    await new NativeAppApprovalGate(store(), ask).authorize(memmy, turn('first'));
    expect(ask).toHaveBeenCalledWith(memmy);
    expect(store().allow(memmy)).toMatchObject([{ appId: memmy.appId }]);
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
