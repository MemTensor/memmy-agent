import { describe, expect, it, vi } from 'vitest';
import { LockedMacUseManager, isInteractiveTurnId } from '../src/main/locked-mac-use.js';
import { LockedMacUseConsent } from '../src/main/locked-mac-use-consent.js';

const helperApp = '/Applications/Memmy.app/Contents/Resources/helper/Memmy Computer Use.app';
const signedDetails = 'Identifier=cn.memtensor.memmy\nTeamIdentifier=S7NLXHGBJ2';
const hostDetails = 'Identifier=cn.memtensor.memmy\nTeamIdentifier=S7NLXHGBJ2';
const turnId = '["session","websocket","chat","message"]';
const consent = { isGranted: () => true, setGranted: vi.fn() } as unknown as LockedMacUseConsent;

describe('LockedMacUseManager', () => {
  it('accepts only a structured interactive message identity', () => {
    expect(isInteractiveTurnId(turnId)).toBe(true);
    expect(isInteractiveTurnId('turn')).toBe(false);
    expect(isInteractiveTurnId('["session","cron","chat","message"]')).toBe(false);
    expect(isInteractiveTurnId('["session","websocket","chat",null]')).toBe(false);
  });
  it('never offers a system-policy change when the authorization helper is unavailable', async () => {
    const command = vi.fn();
    const unsigned = new LockedMacUseManager({ platform: 'darwin', packaged: false,
      resourcesPath: '/unused', helperApp, command });
    const windows = new LockedMacUseManager({ platform: 'win32', packaged: true,
      resourcesPath: '/unused', helperApp, command });
    expect(await unsigned.status()).toMatchObject({ available: false, reason: 'missing' });
    expect(await windows.status()).toMatchObject({ available: false, reason: 'unsupported' });
    await unsigned.change('install', async () => true);
    expect(command).not.toHaveBeenCalledWith('/usr/bin/osascript', expect.anything());
  });

  it('does not claim availability when the authorization probe fails', async () => {
    const command = vi.fn(async (_binary: string, args: string[]) => ({
      stdout: '', stderr: args[0] === '-dv' ? signedDetails : '',
    }));
    const manager = new LockedMacUseManager({ platform: 'darwin', packaged: true,
      resourcesPath: '/unused', helperApp, hostExecutable: '/Applications/Unsigned', command });
    expect(await manager.status()).toMatchObject({ available: false, reason: 'probe-failed' });
    expect(command).not.toHaveBeenCalledWith('/usr/bin/osascript', expect.anything());
  });

  it('requires host confirmation before invoking the administrator installer', async () => {
    let installed = false;
    const command = vi.fn(async (binary: string, args: string[]) => {
      if (binary === '/usr/bin/codesign' && args[0] === '-dv') {
        return { stdout: '', stderr: args.at(-1) === '/Applications/Memmy' ? hostDetails : signedDetails };
      }
      if (binary === '/usr/bin/codesign') return { stdout: '', stderr: '' };
      if (binary === '/usr/bin/osascript') {
        installed = args.at(-1) === 'install';
        return { stdout: '', stderr: '' };
      }
      return { stdout: installed ? 'installed\n' : 'not-installed\n', stderr: '' };
    });
    const manager = new LockedMacUseManager({ platform: 'darwin', packaged: true,
      resourcesPath: '/unused', helperApp, hostExecutable: '/Applications/Memmy', command });
    expect(await manager.change('install', async () => false)).toMatchObject({ installed: false });
    expect(command).not.toHaveBeenCalledWith('/usr/bin/osascript', expect.anything());
    expect(await manager.change('install', async () => true)).toMatchObject({ installed: true });
    expect(await manager.change('uninstall', async () => true)).toMatchObject({ installed: false });
    expect(command).toHaveBeenCalledWith('/usr/bin/osascript', expect.arrayContaining(['uninstall']));
    expect(command).toHaveBeenCalledWith('/usr/bin/osascript', expect.arrayContaining([
      '/Applications/Memmy.app/Contents/Resources/helper/Memmy Computer Use.app/Contents/SharedSupport/lock-installer',
    ]));
  });

  it('reports an installed component and permits removal and reinstallation', async () => {
    let installed = true;
    const command = vi.fn(async (binary: string, args: string[]) => {
      if (binary === '/usr/bin/osascript') installed = args.at(-1) === 'install';
      return { stdout: args[0] === 'status' ? installed ? 'installed\n' : 'not-installed\n' : '',
        stderr: args[0] === '-dv' ? args.at(-1) === '/Applications/Memmy' ? hostDetails : signedDetails : '' };
    });
    const manager = new LockedMacUseManager({ platform: 'darwin', packaged: true,
      resourcesPath: '/unused', helperApp, hostExecutable: '/Applications/Memmy', command });
    expect(await manager.status()).toMatchObject({ available: true, installed: true });
    expect(await manager.change('uninstall', async () => true)).toMatchObject({ installed: false });
    await manager.change('install', async () => true);
    expect(command).toHaveBeenCalledWith('/usr/bin/osascript', expect.arrayContaining(['install']));
  });

  it('keeps one locked action inside an observed unlock and verified relock', async () => {
    const id = '12345678-1234-1234-1234-123456789abc';
    let screen = 'locked';
    const control = vi.fn(async (request: Record<string, string>) => {
      if (request.action === 'screen-state') return screen;
      if (request.action === 'begin') return id;
      if (request.action === 'wake') return 'wake-sent';
      if (request.action === 'status') { screen = 'unlocked'; return 'auto-unlocked'; }
      if (request.action === 'release') { screen = 'locked'; return 'relock-sent'; }
      return 'denied';
    });
    const command = vi.fn(async (_binary: string, args: string[]) => ({ stdout: args[0] === 'status' ? 'installed\n' : '',
      stderr: args[0] === '-dv' ? args.at(-1) === '/Applications/Memmy' ? hostDetails : signedDetails : '' }));
    const manager = new LockedMacUseManager({ platform: 'darwin', packaged: true,
      resourcesPath: '/unused', helperApp, hostExecutable: '/Applications/Memmy', command, control,
      consent });
    expect(await manager.beginTurn(turnId, () => true)).toBe(id);
    await expect(manager.releaseTurn(id, '["other","websocket","chat","message"]')).rejects.toThrow('Invalid lock-screen lease');
    expect(await manager.releaseTurn(id, turnId)).toBe('relocked');
    expect(control.mock.calls.map(([request]) => request.action))
      .toEqual(['screen-state', 'begin', 'wake', 'status', 'release', 'screen-state']);
    expect(control).toHaveBeenCalledWith({ action: 'begin', thread: turnId,
      interactive: '1', userApproved: '1' });
  });

  it('cancels the lease when a wake is denied before app input', async () => {
    const id = '12345678-1234-1234-1234-123456789abc';
    const control = vi.fn(async (request: Record<string, string>) =>
      request.action === 'screen-state' ? 'locked' : request.action === 'begin' ? id
        : request.action === 'cancel' ? 'cancelled' : 'denied');
    const command = vi.fn(async (_binary: string, args: string[]) => ({ stdout: args[0] === 'status' ? 'installed\n' : '',
      stderr: args[0] === '-dv' ? args.at(-1) === '/Applications/Memmy' ? hostDetails : signedDetails : '' }));
    const manager = new LockedMacUseManager({ platform: 'darwin', packaged: true,
      resourcesPath: '/unused', helperApp, hostExecutable: '/Applications/Memmy', command, control,
      consent });
    await expect(manager.beginTurn(turnId, () => true)).rejects.toThrow('wake was denied');
    expect(control).toHaveBeenCalledWith({ action: 'cancel', id });
  });

  it('denies a locked request without the component, separate consent, or the current child', async () => {
    const control = vi.fn(async () => 'locked');
    let installed = false;
    const command = vi.fn(async (_binary: string, args: string[]) => ({
      stdout: args[0] === 'status' ? installed ? 'installed\n' : 'not-installed\n' : '',
      stderr: args[0] === '-dv' ? args.at(-1) === '/Applications/Memmy' ? hostDetails : signedDetails : '',
    }));
    const separateConsent = { isGranted: () => false, setGranted: vi.fn() } as unknown as LockedMacUseConsent;
    const manager = new LockedMacUseManager({ platform: 'darwin', packaged: true,
      resourcesPath: '/unused', helperApp, hostExecutable: '/Applications/Memmy', command, control,
      consent: separateConsent });
    await expect(manager.beginTurn(turnId, () => true)).rejects.toThrow('requires an installed component');
    installed = true;
    await expect(manager.beginTurn(turnId, () => true)).rejects.toThrow('separate consent');
    await expect(manager.beginTurn(turnId, () => false)).rejects.toThrow('stale lock-screen turn');
    expect(control.mock.calls.every(([request]) => request.action === 'screen-state')).toBe(true);
  });

  it('cancels the lease if its child generation ends before wake', async () => {
    const id = '12345678-1234-1234-1234-123456789abc';
    let current = true;
    const control = vi.fn(async (request: Record<string, string>) => {
      if (request.action === 'screen-state') return 'locked';
      if (request.action === 'begin') { current = false; return id; }
      if (request.action === 'cancel') return 'cancelled';
      return 'denied';
    });
    const command = vi.fn(async (_binary: string, args: string[]) => ({
      stdout: args[0] === 'status' ? 'installed\n' : '',
      stderr: args[0] === '-dv' ? args.at(-1) === '/Applications/Memmy' ? hostDetails : signedDetails : '',
    }));
    const manager = new LockedMacUseManager({ platform: 'darwin', packaged: true,
      resourcesPath: '/unused', helperApp, hostExecutable: '/Applications/Memmy', command, control,
      consent });
    await expect(manager.beginTurn(turnId, () => current)).rejects.toThrow('ended before wake');
    expect(control).toHaveBeenCalledWith({ action: 'cancel', id });
    expect(control).not.toHaveBeenCalledWith({ action: 'wake', id });
  });

  it('requires an independent confirmation to grant consent and permits revocation', async () => {
    let granted = false;
    const separateConsent = { isGranted: () => granted, setGranted: vi.fn((value: boolean) => { granted = value; })
    } as unknown as LockedMacUseConsent;
    const command = vi.fn(async (_binary: string, args: string[]) => ({
      stdout: args[0] === 'status' ? 'installed\n' : '',
      stderr: args[0] === '-dv' ? args.at(-1) === '/Applications/Memmy' ? hostDetails : signedDetails : '',
    }));
    const manager = new LockedMacUseManager({ platform: 'darwin', packaged: true,
      resourcesPath: '/unused', helperApp, hostExecutable: '/Applications/Memmy', command,
      consent: separateConsent });
    expect((await manager.changeConsent(true, async () => false)).consented).toBe(false);
    expect(separateConsent.setGranted).not.toHaveBeenCalled();
    expect((await manager.changeConsent(true, async () => true)).consented).toBe(true);
    expect((await manager.changeConsent(false, async () => { throw new Error('should not prompt'); })).consented).toBe(false);
  });

  it('keeps an uncertain lease blocked until the OS is observed locked', async () => {
    const id = '12345678-1234-1234-1234-123456789abc';
    let screen = 'locked';
    const control = vi.fn(async (request: Record<string, string>) => {
      if (request.action === 'screen-state') return screen;
      if (request.action === 'begin') return id;
      if (request.action === 'wake') return 'wake-sent';
      if (request.action === 'status') { screen = 'unlocked'; return 'auto-unlocked'; }
      if (request.action === 'release') throw new Error('broker disconnected');
      if (request.action === 'cancel') return 'cancelled';
      return 'denied';
    });
    const command = vi.fn(async (_binary: string, args: string[]) => ({
      stdout: args[0] === 'status' ? 'installed\n' : '',
      stderr: args[0] === '-dv' ? args.at(-1) === '/Applications/Memmy' ? hostDetails : signedDetails : '',
    }));
    const manager = new LockedMacUseManager({ platform: 'darwin', packaged: true,
      resourcesPath: '/unused', helperApp, hostExecutable: '/Applications/Memmy', command, control,
      consent });
    await manager.beginTurn(turnId, () => true);
    await expect(manager.beginTurn(turnId, () => true)).rejects.toThrow('not been observed to relock');
    screen = 'locked';
    expect(await manager.releaseTurn(id, turnId)).toBe('relocked');
  });
});
