import { execFile } from 'node:child_process';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { LockedMacUseConsent } from './locked-mac-use-consent.js';

const execFileAsync = promisify(execFile);
const HELPER_RELATIVE = 'app.asar.unpacked/dist/runtime/memmy-agent/dist/native-computer-use/Memmy Computer Use.app';
const BROKER_SOCKET = '/tmp/cn.memtensor.memmy.computeruse/LockScreenAuthorization.sock';
const LEASE_ID = /^[0-9a-fA-F-]{36}$/;

export function isInteractiveTurnId(value: string): boolean {
  try {
    const tuple: unknown = JSON.parse(value);
    return Array.isArray(tuple) && tuple.length === 4
      && tuple.every(part => typeof part === 'string' && part.trim().length > 0)
      && !['system', 'cron'].includes(tuple[1]);
  } catch { return false; }
}

export type LockedMacUseStatus = {
  available: boolean;
  installed: boolean;
  consented: boolean;
  reason?: 'unsupported' | 'missing' | 'probe-failed';
};

type Command = (binary: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export class LockedMacUseManager {
  private readonly command: Command;
  private readonly helperApp: string;
  private readonly controlOverride?: (request: Record<string, string>) => Promise<string>;
  private readonly consent: LockedMacUseConsent | null;
  private activeLease: { id: string; turnId: string } | null = null;

  constructor(options: { platform: NodeJS.Platform; packaged: boolean; resourcesPath: string;
    helperApp?: string; hostExecutable?: string; command?: Command;
    control?: (request: Record<string, string>) => Promise<string>;
    consent?: LockedMacUseConsent; userDataDirectory?: string }) {
    this.platform = options.platform;
    this.helperApp = options.helperApp ?? join(options.resourcesPath, HELPER_RELATIVE);
    this.controlOverride = options.control;
    this.consent = options.consent ?? (options.userDataDirectory
      ? new LockedMacUseConsent(options.userDataDirectory) : null);
    this.command = options.command ?? (async (binary, args) => execFileAsync(binary, args,
      { timeout: 30_000, maxBuffer: 64 * 1024 }));
  }
  private readonly platform: NodeJS.Platform;

  private support(name: string): string {
    return join(this.helperApp, 'Contents', 'SharedSupport', name);
  }

  consentGranted(): boolean {
    return this.consent?.isGranted() === true;
  }

  async status(): Promise<LockedMacUseStatus> {
    const consented = this.consent?.isGranted() === true;
    if (this.platform !== 'darwin') return { available: false, installed: false, consented, reason: 'unsupported' };
    try {
      const result = await this.command(this.support('lock-installer'), ['status']);
      if (!['installed', 'not-installed'].includes(result.stdout.trim())) {
        return { available: false, installed: false, consented, reason: 'probe-failed' };
      }
      const installed = result.stdout.trim() === 'installed';
      return { available: true, installed, consented };
    } catch {
      return { available: false, installed: false, consented, reason: 'missing' };
    }
  }

  /** Only a direct user click calls this method. `confirm` is a host dialog,
   * followed by macOS's own administrator prompt in osascript. No password is
   * returned to Memmy or the Agent.
   */
  async change(action: 'install' | 'uninstall', confirm: () => Promise<boolean>): Promise<LockedMacUseStatus> {
    const before = await this.status();
    if (!before.available && !(action === 'uninstall' && before.installed)) return before;
    if ((action === 'install') === before.installed) return before;
    if (!await confirm()) return before;
    if (action === 'uninstall') this.consent?.setGranted(false);
    await this.command('/usr/bin/osascript', [this.support('authorize-install.applescript'),
      this.support('lock-installer'), action]);
    const after = await this.status();
    if ((action === 'install' && !after.available) || after.installed !== (action === 'install')) {
      throw new Error('macOS lock authorization change did not verify');
    }
    return after;
  }

  /** Granting is initiated only by the main-window settings IPC after its own confirmation. */
  async changeConsent(granted: boolean, confirm: () => Promise<boolean>): Promise<LockedMacUseStatus> {
    if (!this.consent) throw new Error('Locked Mac consent store is unavailable');
    if (granted) {
      const status = await this.status();
      if (!status.available || !status.installed) return status;
      if (status.consented || !await confirm()) return status;
    }
    this.consent.setGranted(granted);
    return this.status();
  }

  private control(request: Record<string, string>): Promise<string> {
    if (this.controlOverride) return this.controlOverride(request);
    return new Promise((resolve, reject) => {
      const socket = createConnection(BROKER_SOCKET);
      let output = '';
      let settled = false;
      const finish = (error?: Error, value?: string) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error); else resolve(value ?? 'denied');
      };
      socket.setTimeout(2500, () => finish(new Error('Lock broker timed out')));
      socket.once('error', error => finish(error));
      socket.once('connect', () => socket.write(`H1\n${JSON.stringify(request)}\n`));
      socket.on('data', chunk => {
        output += chunk.toString('utf8');
        if (output.length > 1024) finish(new Error('Lock broker response was too large'));
        else if (output.includes('\n')) finish(undefined, output.slice(0, output.indexOf('\n')));
      });
      socket.once('end', () => { if (!output.includes('\n')) finish(new Error('Lock broker disconnected')); });
    });
  }

  /** The managed child derives turnId from its live RequestContext, never tool
   * arguments. The host validates its shape and current child generation here.
   */
  async beginTurn(turnId: string, isCurrentChild: () => boolean): Promise<string | null> {
    if (!isInteractiveTurnId(turnId) || Buffer.byteLength(turnId, 'utf8') > 512 || !isCurrentChild()) {
      throw new Error('Invalid or stale lock-screen turn');
    }
    const screen = await this.control({ action: 'screen-state' });
    if (this.activeLease) {
      if (screen === 'locked') this.activeLease = null;
      else {
        await this.control({ action: 'cancel', id: this.activeLease.id }).catch(() => undefined);
        throw new Error('Previous locked Mac lease has not been observed to relock');
      }
    }
    if (screen === 'unlocked') return null;
    if (screen !== 'locked') throw new Error('Cannot verify the locked Mac session');
    const available = await this.status();
    if (!available.available || !available.installed || !available.consented || !isCurrentChild()
      || this.activeLease) {
      throw new Error('Locked Mac use requires an installed component, separate consent, and a verified active message');
    }
    const id = await this.control({ action: 'begin', thread: turnId,
      interactive: '1', userApproved: '1' });
    if (!LEASE_ID.test(id)) throw new Error('Lock-screen lease was denied');
    try {
      if (!isCurrentChild()) throw new Error('Lock-screen turn ended before wake');
      if (await this.control({ action: 'wake', id }) !== 'wake-sent') throw new Error('Lock-screen wake was denied');
      for (let attempt = 0; attempt < 100; attempt++) {
        if (!isCurrentChild()) throw new Error('Lock-screen turn ended during wake');
        const state = await this.control({ action: 'status', id });
        if (state === 'auto-unlocked') {
          if (!isCurrentChild()) throw new Error('Lock-screen turn ended during wake');
          this.activeLease = { id, turnId };
          return id;
        }
        if (state !== 'waiting') throw new Error('Lock-screen authorization was interrupted');
        await delay(100);
      }
      throw new Error('Mac did not unlock within the lease');
    } catch (error) {
      await this.control({ action: 'cancel', id }).catch(() => undefined);
      throw error;
    }
  }

  async releaseTurn(id: string | null, turnId: string): Promise<'relocked' | 'user-intervened' | 'not-needed'> {
    if (id === null) return 'not-needed';
    if (!LEASE_ID.test(id) || this.activeLease?.id !== id || this.activeLease.turnId !== turnId) {
      throw new Error('Invalid lock-screen lease');
    }
    try {
      const result = await this.control({ action: 'release', id });
      if (result === 'user-intervened') {
        this.activeLease = null;
        return 'user-intervened';
      }
      if (result !== 'relock-sent') throw new Error('Lock broker did not request relock');
    } catch {
      // A consumed lease's cancel path requests relock. Keep the lease blocked
      // until the OS reports locked, even if the broker reply was lost.
      await this.control({ action: 'cancel', id }).catch(() => undefined);
    }
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await this.control({ action: 'screen-state' }) === 'locked') {
        this.activeLease = null;
        return 'relocked';
      }
      await delay(100);
    }
    throw new Error('Mac did not relock after Computer Use');
  }
}
