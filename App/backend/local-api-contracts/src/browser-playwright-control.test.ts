import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { BROWSER_PLAYWRIGHT_CDP_METHODS } from './browser-playwright-control.js';
import { EMBEDDED_BROWSER_EVENT, EMBEDDED_BROWSER_REQUEST, isEmbeddedBrowserEvent, isEmbeddedBrowserRequest } from './embedded-browser-control.js';

it('keeps external and embedded fixed executor CDP methods aligned without browser-wide APIs', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const source = fs.readFileSync(path.join(root, 'App/shell/desktop/extensions/memmy-browser/background.js'), 'utf8');
  const body = source.match(/const PLAYWRIGHT_CDP_METHODS = new Set\(\[([\s\S]*?)\]\)/u)?.[1];
  expect(body).toBeDefined();
  const methods = [...body!.matchAll(/'([^']+)'/gu)].map(match => match[1]!);
  expect(methods).toEqual([...BROWSER_PLAYWRIGHT_CDP_METHODS]);
  expect(methods).not.toContain('DOM.setFileInputFiles');
  expect(methods.some(method => /^(?:Browser|Storage)\.|^Target\.(?:createTarget|closeTarget|attachToTarget|attachToBrowserTarget)$/u.test(method))).toBe(false);
});

it.each(['playwrightStart', 'playwrightCdp', 'playwrightEnd'] as const)('requires an explicit target tab for %s', command => {
  const request = { type: EMBEDDED_BROWSER_REQUEST, requestId: 'request-1', command, args: {} };
  expect(isEmbeddedBrowserRequest(request)).toBe(false);
  expect(isEmbeddedBrowserRequest({ ...request, tabId: 27 })).toBe(true);
});

it('accepts only a well-formed executor event for one tab and lease', () => {
  const event = { type: EMBEDDED_BROWSER_EVENT, tabId: 27, leaseId: 'a'.repeat(32), method: 'Page.frameNavigated', params: {} };
  expect(isEmbeddedBrowserEvent(event)).toBe(true);
  expect(isEmbeddedBrowserEvent({ ...event, sessionId: 'child' })).toBe(true);
  expect(isEmbeddedBrowserEvent({ ...event, tabId: 0 })).toBe(false);
  expect(isEmbeddedBrowserEvent({ ...event, leaseId: 'short' })).toBe(false);
  expect(isEmbeddedBrowserEvent({ ...event, method: 'not a method' })).toBe(false);
  expect(isEmbeddedBrowserEvent({ ...event, params: [] })).toBe(false);
});
