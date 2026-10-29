import { describe, expect, it } from 'vitest';
import { normalizeBrowserCdpCommandOptions, normalizeBrowserCdpEventQuery,
  normalizeBrowserCdpReadCall } from './browser-cdp-readonly.js';

describe('controlled browser CDP contract', () => {
  it('restricts commands to bounded reads and forces side-effect checks', () => {
    expect(normalizeBrowserCdpReadCall('Runtime.evaluate', { expression: 'document.title' }))
      .toEqual({ method: 'Runtime.evaluate', params: { expression: 'document.title',
        throwOnSideEffect: true, returnByValue: true, awaitPromise: false, userGesture: false } });
    expect(() => normalizeBrowserCdpReadCall('DOM.setFileInputFiles', { files: ['/private/file'] }))
      .toThrow(/unavailable/);
    expect(() => normalizeBrowserCdpReadCall('Runtime.evaluate', {
      expression: 'document.title', throwOnSideEffect: false,
    })).toThrow(/unavailable/);
    expect(() => normalizeBrowserCdpReadCall('DOM.getDocument', { depth: -1 })).toThrow(/unavailable/);
  });

  it('bounds event cursor, page size and filters', () => {
    expect(normalizeBrowserCdpEventQuery({ afterSequence: 3, methods: ['Network.requestWillBeSent'] }))
      .toEqual({ afterSequence: 3, limit: 100, methods: ['Network.requestWillBeSent'] });
    expect(() => normalizeBrowserCdpEventQuery({ limit: 1001 })).toThrow(/Invalid/);
    expect(normalizeBrowserCdpEventQuery({ target: { targetId: 'child-1' }, timeoutMs: 30000 }))
      .toEqual({ limit: 100, target: { targetId: 'child-1' }, timeoutMs: 30000 });
    expect(normalizeBrowserCdpCommandOptions({ target: { sessionId: 'session-1' } }))
      .toEqual({ target: { sessionId: 'session-1' } });
    expect(() => normalizeBrowserCdpEventQuery({ target: { targetId: 'a', sessionId: 'b' } }))
      .toThrow(/Invalid/);
    expect(() => normalizeBrowserCdpEventQuery({ timeoutMs: 30001 })).toThrow(/timeout/);
  });
});
