import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { LOCKED_MAC_USE_REQUEST, isLockedMacUseResult,
  type LockedMacUseResult } from '@memmy/local-api-contracts';
import type { RequestContext } from '../../core/agent-runtime/tools/context.js';
import { OcuUserIntervened } from './mac-focus-guard.js';

function interactiveTurn(context: RequestContext | null): string | null {
  // The runtime marks only a live inbound user message as interactive. A
  // continuation's generated turnId is not a substitute for that message.
  if (!context || context.metadata.computerUseInteractive !== true
      || ['system', 'cron'].includes(context.channel ?? '')
      || !context.sessionKey || !context.channel || !context.chatId || !context.messageId) return null;
  return JSON.stringify([context.sessionKey, context.channel, context.chatId, context.messageId]);
}

function exchange(action: 'begin' | 'release', turnId: string, leaseId?: string): Promise<LockedMacUseResult> {
  if (!process.send || !process.connected || process.env.MEMMY_DESKTOP_MANAGED_GATEWAY !== '1') {
    return Promise.reject(new Error('Locked Mac use requires the managed desktop host'));
  }
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const finish = (result?: LockedMacUseResult) => {
      clearTimeout(timer);
      process.removeListener('message', receive);
      if (result) resolve(result); else reject(new Error('Locked Mac host did not authorize the operation'));
    };
    const receive = (raw: unknown) => {
      if (isLockedMacUseResult(raw) && raw.requestId === requestId) finish(raw);
    };
    const timer = setTimeout(() => finish(), 20_000);
    timer.unref?.();
    process.on('message', receive);
    try {
      process.send!({ type: LOCKED_MAC_USE_REQUEST, requestId, action, turnId,
        ...(leaseId ? { leaseId } : {}) }, error => { if (error) finish(); });
    } catch { finish(); }
  });
}

/** Desktop passes the consent file; the native helper receives the derived enable flag. */
export function lockedMacUseEnabled(): boolean {
  const filePath = process.env.MEMMY_LOCKED_MAC_CONSENT_FILE;
  if (typeof filePath === 'string' && filePath.length > 0) {
    try {
      const file = lstatSync(filePath);
      if (!file.isFile() || file.isSymbolicLink() || file.size > 4096) return false;
      const value: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const record = value as Record<string, unknown>;
      return record.version === 1 && record.granted === true
        && typeof record.grantedAt === 'string' && !Number.isNaN(Date.parse(record.grantedAt));
    } catch { return false; }
  }
  return process.env.MEMMY_LOCKED_MAC_USE_ENABLED === '1';
}

export async function beginLockedMacAction(context: RequestContext | null): Promise<{
  turnId: string; leaseId: string;
} | null> {
  if (process.platform !== 'darwin' || !lockedMacUseEnabled()) return null;
  const turnId = interactiveTurn(context);
  if (!turnId) throw new Error('Locked Mac use requires a current interactive message');
  const result = await exchange('begin', turnId);
  if (result.status === 'not-needed') return null;
  if (result.status !== 'ready' || !result.leaseId) throw new Error('Locked Mac use was not authorized');
  return { turnId, leaseId: result.leaseId };
}

export async function releaseLockedMacAction(lease: { turnId: string; leaseId: string } | null): Promise<void> {
  if (!lease) return;
  const result = await exchange('release', lease.turnId, lease.leaseId);
  if (result.status === 'user-intervened') {
    throw new OcuUserIntervened('You took over the Mac during locked Computer Use. Check the result before sending a new message.');
  }
  if (result.status !== 'relocked') {
    throw new Error('Locked Mac use did not finish safely');
  }
}
