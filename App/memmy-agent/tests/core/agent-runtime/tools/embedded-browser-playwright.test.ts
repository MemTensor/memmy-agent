import { expect, it, vi } from 'vitest';
import { EMBEDDED_BROWSER_EVENT, EMBEDDED_BROWSER_RESULT } from '@memmy/local-api-contracts';
import { EmbeddedBrowserBridge } from '../../../../src/core/agent-runtime/tools/embedded-browser-bridge.js';

const leaseId = 'a'.repeat(32);
const identity = { connectionId: 'memmy-webview:fixture', tabId: 9 };

function withDesktopChannel(run: (deliver: (message: unknown) => void, sent: Array<Record<string, any>>) => Promise<void>) {
  return async () => {
    const previousSend = Object.getOwnPropertyDescriptor(process, 'send');
    const sent: Array<Record<string, any>> = [];
    Object.defineProperty(process, 'send', { configurable: true,
      value: (message: Record<string, any>, callback?: (error: Error | null) => void) => { sent.push(message); callback?.(null); return true; } });
    try { await run(message => process.emit('message', message as any, undefined), sent); }
    finally {
      if (previousSend) Object.defineProperty(process, 'send', previousSend);
      else delete (process as { send?: unknown }).send;
    }
  };
}

it('forwards pushed executor events for the subscribed tab and stops after unsubscribe', withDesktopChannel(async deliver => {
  const bridge = new EmbeddedBrowserBridge();
  (bridge as any).browserId = 'fixture';
  (bridge as any).claims.set(9, { ...identity, browser: 'memmy', title: 'fixture', url: 'https://example.test/' });
  const received = vi.fn();
  try {
    const stop = bridge.subscribePlaywright(identity, received);
    deliver({ type: EMBEDDED_BROWSER_EVENT, tabId: 10, leaseId, method: 'Runtime.executionContextCreated', params: { other: true } });
    deliver({ type: EMBEDDED_BROWSER_EVENT, tabId: 9, leaseId, method: 'Runtime.executionContextCreated', params: { context: { id: 7 } } });
    deliver({ type: EMBEDDED_BROWSER_EVENT, tabId: 9, leaseId: 'short', method: 'Runtime.executionContextCreated', params: {} });
    expect(received).toHaveBeenCalledExactlyOnceWith({ leaseId, method: 'Runtime.executionContextCreated', params: { context: { id: 7 } } });
    stop();
    deliver({ type: EMBEDDED_BROWSER_EVENT, tabId: 9, leaseId, method: 'Page.frameNavigated', params: {} });
    expect(received).toHaveBeenCalledTimes(1);
  } finally { bridge.close(); }
}));

it('reports a command reply before an event that arrives after it on the desktop channel', withDesktopChannel(async (deliver, sent) => {
  const bridge = new EmbeddedBrowserBridge();
  (bridge as any).browserId = 'fixture';
  (bridge as any).claims.set(9, { ...identity, browser: 'memmy', title: 'fixture', url: 'https://example.test/' });
  const order: string[] = [];
  try {
    bridge.subscribePlaywright(identity, event => order.push(`event:${event.method}`));
    const pending = bridge.command(identity, 'playwrightCdp', { leaseId, approvedOrigin: 'https://example.test',
      method: 'Page.getFrameTree', params: {} }, undefined, outcome => order.push(`reply:${outcome.ok}`));
    const requestId = sent.at(-1)!.requestId;
    deliver({ type: EMBEDDED_BROWSER_RESULT, requestId, ok: true, result: { frameTree: {} } });
    deliver({ type: EMBEDDED_BROWSER_EVENT, tabId: 9, leaseId, method: 'Runtime.executionContextCreated', params: {} });
    expect(order).toEqual(['reply:true', 'event:Runtime.executionContextCreated']);
    await expect(pending).resolves.toEqual({ frameTree: {} });
  } finally { bridge.close(); }
}));

it('keeps upload approval pending beyond 30 seconds and sends IPC cancellation when it times out', async () => {
  const previousSend = Object.getOwnPropertyDescriptor(process, 'send');
  const send = vi.fn((_message: unknown, callback?: (error: Error | null) => void) => callback?.(null));
  Object.defineProperty(process, 'send', { configurable: true, value: send });
  vi.useFakeTimers();
  const bridge = new EmbeddedBrowserBridge();
  (bridge as any).browserId = 'fixture';
  (bridge as any).claims.set(9, { ...identity, browser: 'memmy', title: 'fixture', url: 'https://example.test/' });
  try {
    const pending = bridge.command(identity, 'playwrightStart', { leaseId, approvedOrigin: 'https://example.test',
      uploadPaths: ['/approved/file.txt'] });
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 15_000 - 30_001);
    await assertion;
    expect(send.mock.calls[1][0]).toEqual({ type: 'memmy:embedded-browser:cancel',
      requestId: (send.mock.calls[0][0] as { requestId: string }).requestId });
  } finally {
    bridge.close(); vi.useRealTimers();
    if (previousSend) Object.defineProperty(process, 'send', previousSend);
    else delete (process as { send?: unknown }).send;
  }
});
