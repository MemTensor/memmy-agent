import { expect, it } from 'vitest';
import { EMBEDDED_BROWSER_REQUEST, formatEmbeddedBrowserTabMention, isEmbeddedBrowserRequest,
  parseEmbeddedBrowserTabMention } from './embedded-browser-control.js';

it('round trips the exact browser, tab, title, and URL snapshot', () => {
  const tab = { browserId: 'fb77c359-316a-4221-8cb7-967e230a8d50', tabId: 7,
    title: 'A & B', url: 'https://example.com/path?q=one%20two#part' };
  const mention = formatEmbeddedBrowserTabMention(tab);
  expect(parseEmbeddedBrowserTabMention(mention)).toEqual(tab);
  expect(parseEmbeddedBrowserTabMention(`${mention}&tabId=8`)).toBeNull();
  expect(parseEmbeddedBrowserTabMention(mention.replace('browser@memmy', 'browser@other'))).toBeNull();
});

it.each(['closeTab', 'endSitePermissions'])('requires an exact tab ID for a %s request', command => {
  const close = { type: EMBEDDED_BROWSER_REQUEST, requestId: 'test', command, args: {} };
  expect(isEmbeddedBrowserRequest(close)).toBe(false);
  expect(isEmbeddedBrowserRequest({ ...close, tabId: 27 })).toBe(true);
});

it('accepts a standalone history request without claiming a tab', () => {
  expect(isEmbeddedBrowserRequest({ type: EMBEDDED_BROWSER_REQUEST, requestId: 'test',
    command: 'queryHistory', args: { from: '2026-09-28T00:00:00Z', to: '2026-09-29T00:00:00Z',
      keyword: 'example', limit: 20 } })).toBe(true);
});

it('limits external browser metadata and recovery requests to browser identity', () => {
  const state = { type: EMBEDDED_BROWSER_REQUEST, requestId: 'test', command: 'externalBrowserState', args: {} };
  expect(isEmbeddedBrowserRequest(state)).toBe(true);
  expect(isEmbeddedBrowserRequest({ ...state, tabId: 1 })).toBe(false);
  expect(isEmbeddedBrowserRequest({ ...state, args: { path: '/private/profile' } })).toBe(false);
  const recover = { ...state, command: 'recoverExternalBrowser', args: { browser: 'chrome' } };
  expect(isEmbeddedBrowserRequest(recover)).toBe(true);
  expect(isEmbeddedBrowserRequest({ ...recover, args: { browser: 'edge' } })).toBe(true);
  expect(isEmbeddedBrowserRequest({ ...recover, tabId: 1 })).toBe(false);
  for (const args of [{}, { browser: 'memmy' }, { browser: 'chrome', url: 'https://example.com' }]) {
    expect(isEmbeddedBrowserRequest({ ...recover, args })).toBe(false);
  }
});
