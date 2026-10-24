import type { EmbeddedBrowserRequest } from '@memmy/local-api-contracts';
import { parseBrowserHistoryQuery, type BrowserHistoryQuery, type BrowserHistoryStore } from './browser-history-store.js';

/** Only the host can approve a bounded read of the in-app webview history. */
export async function queryInAppBrowserHistory(
  store: BrowserHistoryStore,
  request: EmbeddedBrowserRequest,
  approve: (query: BrowserHistoryQuery) => Promise<boolean>,
): Promise<{ entries: ReturnType<BrowserHistoryStore['query']> }> {
  const query = request.command === 'queryHistory' && request.tabId === undefined
    ? parseBrowserHistoryQuery(request.args) : null;
  if (!query) throw new Error('Invalid in-app browser history request');
  if (!await approve(query)) throw new Error('In-app browser history access was denied');
  return { entries: store.query(query) };
}
