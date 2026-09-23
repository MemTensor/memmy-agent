import { expect, it } from 'vitest';
import { isScreenCaptureRequest, isScreenCaptureResult } from '../src/desktop-screen-capture.js';
it('accepts only bounded display requests, never paths or execution payloads', () => {
  const request = { type: 'memmy:screen-capture:request', requestId: 'test-1', displayId: '7' };
  expect(isScreenCaptureRequest(request)).toBe(true);
  expect(isScreenCaptureRequest({ ...request, displayId: '../../file' })).toBe(false);
  expect(isScreenCaptureRequest({ ...request, command: 'open' })).toBe(false);
  expect(isScreenCaptureRequest({ ...request, requestId: 'x'.repeat(100) })).toBe(false);
});
it('rejects malformed or oversized responses', () => {
  const result = { ok: true, pngBase64: 'png', displayId: '7', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, width: 1280, height: 720 };
  expect(isScreenCaptureResult(result)).toBe(true);
  expect(isScreenCaptureResult({ ...result, pngBase64: 'x'.repeat(2 * 1024 * 1024) })).toBe(false);
  expect(isScreenCaptureResult({ ...result, width: Infinity })).toBe(false);
  expect(isScreenCaptureResult({ ...result, bounds: null })).toBeFalsy();
});
