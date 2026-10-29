import type { ExternalBrowserClaim } from './external-browser-bridge.js';

export type ExternalBrowserTabReference = Pick<ExternalBrowserClaim,
  'connectionId' | 'browser' | 'tabId' | 'title' | 'url'> & { browser: 'chrome' | 'edge' };

export function formatExternalBrowserTabReference(tab: ExternalBrowserTabReference): string {
  const query = new URLSearchParams({ mention: 'external-tab-v1', connectionId: tab.connectionId,
    browser: tab.browser, tabId: String(tab.tabId), title: tab.title, url: tab.url });
  return `plugin://browser@memmy?${query}`;
}

export function parseExternalBrowserTabReference(value: unknown): ExternalBrowserTabReference | null {
  if (typeof value !== 'string' || value.length > 20_000) return null;
  let parsed: URL;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol !== 'plugin:' || parsed.username !== 'browser' || parsed.password
    || parsed.host !== 'memmy' || parsed.pathname || parsed.hash || parsed.searchParams.size !== 6
    || [...parsed.searchParams.keys()].some(key => parsed.searchParams.getAll(key).length !== 1)
    || parsed.searchParams.get('mention') !== 'external-tab-v1') return null;
  const connectionId = parsed.searchParams.get('connectionId') ?? '';
  const browser = parsed.searchParams.get('browser');
  const tabIdText = parsed.searchParams.get('tabId') ?? '';
  const tabId = Number(tabIdText);
  const title = parsed.searchParams.get('title');
  const url = parsed.searchParams.get('url') ?? '';
  if (!/^[a-f0-9]{24}$/i.test(connectionId) || !['chrome', 'edge'].includes(browser ?? '')
    || !/^(?:0|[1-9]\d*)$/.test(tabIdText) || !Number.isSafeInteger(tabId)
    || title === null || title.length > 4096 || url.length > 4096) return null;
  try { if (!['http:', 'https:'].includes(new URL(url).protocol)) return null; }
  catch { return null; }
  return { connectionId, browser: browser as 'chrome' | 'edge', tabId, title, url };
}
