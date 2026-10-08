import { expect, it } from 'vitest';
import { isBrowserProfileClearRequest, isBrowserProfileClearResult } from './browser-profile-control.js';

it('accepts only a bounded browser clear request and result', () => {
  expect(isBrowserProfileClearRequest({ type: 'memmy:browser-profile:clear', requestId: 'a-123' })).toBe(true);
  expect(isBrowserProfileClearRequest({ type: 'memmy:browser-profile:clear', requestId: 'a-123', path: '/tmp' })).toBe(false);
  expect(isBrowserProfileClearResult({ type: 'memmy:browser-profile:clear-result', requestId: 'a-123', ok: true })).toBe(true);
  expect(isBrowserProfileClearResult({ type: 'memmy:browser-profile:clear-result', requestId: 'a-123', ok: false, error: 'failed' })).toBe(true);
  expect(isBrowserProfileClearResult({ type: 'memmy:browser-profile:clear-result', requestId: 'a-123', ok: true, error: 'x'.repeat(513) })).toBe(false);
});
