import type { Session } from 'electron';
import type { BrowserDownloadCatalog } from './browser-download-catalog.js';
import type { BrowserHistoryStore } from './browser-history-store.js';

export const BROWSER_DATA_CATEGORIES = ['cookies', 'siteData', 'cache', 'downloadHistory', 'browsingHistory'] as const;
export type BrowserDataCategory = typeof BROWSER_DATA_CATEGORIES[number];

export function parseBrowserDataCategories(value: unknown): BrowserDataCategory[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > BROWSER_DATA_CATEGORIES.length
    || value.some(item => typeof item !== 'string' || !BROWSER_DATA_CATEGORIES.includes(item as BrowserDataCategory))
    || new Set(value).size !== value.length) return null;
  return value as BrowserDataCategory[];
}

/** Operates only on the persist:memmy-browser session and its in-app indexes. */
export async function clearInAppBrowserData(
  browserSession: Pick<Session, 'clearStorageData' | 'clearCache'>,
  history: Pick<BrowserHistoryStore, 'clear'> | null,
  downloads: Pick<BrowserDownloadCatalog, 'clearHistory'> | null,
  categories: readonly BrowserDataCategory[],
): Promise<void> {
  if (categories.includes('cookies')) await browserSession.clearStorageData({ storages: ['cookies'] });
  if (categories.includes('siteData')) await browserSession.clearStorageData({
    storages: ['filesystem', 'indexdb', 'localstorage', 'websql', 'serviceworkers', 'cachestorage'],
  });
  if (categories.includes('cache')) await browserSession.clearCache();
  if (categories.includes('downloadHistory')) downloads?.clearHistory();
  if (categories.includes('browsingHistory')) history?.clear();
}
