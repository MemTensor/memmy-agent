import { expect, it } from 'vitest';
import { normalizeBrowserCdpWriteCall } from './browser-cdp-write.js';
import { BROWSER_CAPABILITY_REQUEST, isBrowserCapabilityRequest } from './browser-capability-approval.js';
import { EMBEDDED_BROWSER_REQUEST, isEmbeddedBrowserRequest } from './embedded-browser-control.js';

it('permits bounded page mutations but rejects prohibited raw CDP commands and extra parameters', () => {
  expect(normalizeBrowserCdpWriteCall('Runtime.evaluate', { expression: 'document.title = "Updated"' }))
    .toEqual({ method: 'Runtime.evaluate', params: { expression: 'document.title = "Updated"' },
      targetUrls: [] });
  expect(normalizeBrowserCdpWriteCall('DOM.setAttributeValue', {
    nodeId: 3, name: 'data-status', value: 'ready',
  })).toEqual({ method: 'DOM.setAttributeValue', params: {
    nodeId: 3, name: 'data-status', value: 'ready',
  }, targetUrls: [] });
  for (const method of ['DOM.setFileInputFiles', 'Input.dispatchKeyEvent', 'Page.navigate',
    'Target.attachToTarget']) {
    expect(() => normalizeBrowserCdpWriteCall(method, {})).toThrow(/unavailable/);
  }
  expect(() => normalizeBrowserCdpWriteCall('Network.setCookie', {})).toThrow(/valid url/);
  expect(normalizeBrowserCdpWriteCall('Runtime.evaluate', {
    expression: 'document.title = "changed"', throwOnSideEffect: false,
  }).params.throwOnSideEffect).toBe(false);
  expect(() => normalizeBrowserCdpWriteCall('Fetch.enable', {
    patterns: [{ resourceType: 'Document' }],
  })).toThrow(/unavailable/);
  expect(normalizeBrowserCdpWriteCall('Network.setCookie', {
    name: 'test', value: '1', url: 'https://other.test/path',
  }).targetUrls).toEqual(['https://other.test/path']);
});

it('accepts only a typed write approval and embedded command at the IPC boundary', () => {
  expect(isBrowserCapabilityRequest({ type: BROWSER_CAPABILITY_REQUEST,
    requestId: 'f6715e94-0c77-4796-96bb-1ebd0fc1700a', capability: 'debug-write',
    origin: 'https://example.test', names: ['Runtime.evaluate'] })).toBe(true);
  expect(isEmbeddedBrowserRequest({ type: EMBEDDED_BROWSER_REQUEST,
    requestId: 'operation-1', tabId: 3, command: 'cdpWrite', args: {
      method: 'Runtime.evaluate', params: { expression: 'document.title = "changed"' },
    } })).toBe(true);
});
