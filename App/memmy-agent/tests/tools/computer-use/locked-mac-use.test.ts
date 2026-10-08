import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCKED_MAC_USE_RESULT } from '@memmy/local-api-contracts';
import type { RequestContext } from '../../../src/core/agent-runtime/tools/context.js';
import { beginLockedMacAction, releaseLockedMacAction } from '../../../src/tools/computer-use/locked-mac-use.js';
import { OcuUserIntervened } from '../../../src/tools/computer-use/mac-focus-guard.js';

const leaseId = '12345678-1234-1234-1234-123456789abc';
const context = { sessionKey: 'session', channel: 'chat', chatId: 'thread',
  messageId: 'message', metadata: { computerUseInteractive: true } } as RequestContext;

afterEach(() => vi.unstubAllGlobals());

describe('locked Mac action host bridge', () => {
  it('uses a live interactive turn and waits for relock before completing', async () => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const sent: Array<Record<string, string>> = [];
    child.platform = 'darwin';
    child.env = { MEMMY_LOCKED_MAC_USE_ENABLED: '1', MEMMY_DESKTOP_MANAGED_GATEWAY: '1' };
    child.connected = true;
    child.send = (raw: Record<string, string>, callback: () => void) => {
      sent.push(raw);
      queueMicrotask(() => child.emit('message', { type: LOCKED_MAC_USE_RESULT, requestId: raw.requestId,
        status: raw.action === 'begin' ? 'ready' : 'relocked',
        ...(raw.action === 'begin' ? { leaseId } : {}) }));
      callback();
    };
    vi.stubGlobal('process', child);
    const lease = await beginLockedMacAction(context);
    expect(lease).toEqual({ turnId: '["session","chat","thread","message"]', leaseId });
    await releaseLockedMacAction(lease);
    expect(sent.map(item => item.action)).toEqual(['begin', 'release']);
  });

  it('rejects non-interactive contexts before contacting the host', async () => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child.platform = 'darwin';
    child.env = { MEMMY_LOCKED_MAC_USE_ENABLED: '1', MEMMY_DESKTOP_MANAGED_GATEWAY: '1' };
    child.connected = true;
    child.send = vi.fn();
    vi.stubGlobal('process', child);
    await expect(beginLockedMacAction({ ...context, channel: 'cron' } as RequestContext))
      .rejects.toThrow('current interactive message');
    await expect(beginLockedMacAction({ ...context, messageId: null,
      metadata: { computerUseInteractive: true, turnId: 'generated-continuation' } } as RequestContext))
      .rejects.toThrow('current interactive message');
    await expect(beginLockedMacAction({ ...context, metadata: { computerUseInteractive: false } } as RequestContext))
      .rejects.toThrow('current interactive message');
    expect(child.send).not.toHaveBeenCalled();
  });

  it('stops the turn when physical input takes over an auto-unlocked Mac', async () => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child.platform = 'darwin';
    child.env = { MEMMY_LOCKED_MAC_USE_ENABLED: '1', MEMMY_DESKTOP_MANAGED_GATEWAY: '1' };
    child.connected = true;
    child.send = (raw: Record<string, string>, callback: () => void) => {
      queueMicrotask(() => child.emit('message', { type: LOCKED_MAC_USE_RESULT, requestId: raw.requestId,
        status: 'user-intervened' }));
      callback();
    };
    vi.stubGlobal('process', child);
    await expect(releaseLockedMacAction({ turnId: '["session","chat","thread","message"]', leaseId }))
      .rejects.toBeInstanceOf(OcuUserIntervened);
  });
});
