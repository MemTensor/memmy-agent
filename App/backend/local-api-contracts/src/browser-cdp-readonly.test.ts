import { describe, expect, it } from 'vitest';
import { normalizeBrowserCdpCommandOptions, normalizeBrowserCdpEventQuery,
  normalizeBrowserCdpReadCall } from './browser-cdp-readonly.js';

describe('controlled browser CDP contract', () => {
  it.each([
    ['Runtime.evaluate', { expression: '1+1' }],
    ['DOM.getDocument', {}],
    ['DOM.getDocument', { depth: 3 }],
    ['Page.captureScreenshot', {}],
    ['Page.captureScreenshot', { format: 'jpeg' }],
    ['Page.getLayoutMetrics', {}],
    ['Accessibility.getFullAXTree', {}],
  ])('accepts its own normalized output for %s', (method, params) => {
    const call = normalizeBrowserCdpReadCall(method, params);
    expect(normalizeBrowserCdpReadCall(call.method, call.params)).toEqual(call);
  });

  it.each([
    ['Runtime.evaluate', { expression: '1+1' }, 'throwOnSideEffect', false],
    ['Runtime.evaluate', { expression: '1+1' }, 'returnByValue', false],
    ['Runtime.evaluate', { expression: '1+1' }, 'awaitPromise', true],
    ['Runtime.evaluate', { expression: '1+1' }, 'userGesture', true],
    ['DOM.getDocument', {}, 'pierce', true],
    ['Page.captureScreenshot', {}, 'captureBeyondViewport', true],
  ])('rejects altered %s safety parameter %s', (method, params, key, unsafe) => {
    const call = normalizeBrowserCdpReadCall(method, params);
    for (const value of [unsafe, undefined, null, 0, 'false']) {
      expect(() => normalizeBrowserCdpReadCall(method, { ...call.params, [key as string]: value }))
        .toThrow(/unavailable/);
    }
    expect(() => normalizeBrowserCdpReadCall(method, { ...call.params, unknown: false }))
      .toThrow(/unavailable/);
  });

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
