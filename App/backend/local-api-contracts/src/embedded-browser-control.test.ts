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

it('requires an exact tab ID for a close request', () => {
  const close = { type: EMBEDDED_BROWSER_REQUEST, requestId: 'test',
    command: 'closeTab', args: {} };
  expect(isEmbeddedBrowserRequest(close)).toBe(false);
  expect(isEmbeddedBrowserRequest({ ...close, tabId: 27 })).toBe(true);
});

it('accepts a standalone history request without claiming a tab', () => {
  expect(isEmbeddedBrowserRequest({ type: EMBEDDED_BROWSER_REQUEST, requestId: 'test',
    command: 'queryHistory', args: { from: '2026-09-28T00:00:00Z', to: '2026-09-29T00:00:00Z',
      keyword: 'example', limit: 20 } })).toBe(true);
});
