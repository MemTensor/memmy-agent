import { expect, it, vi } from 'vitest';
import { BROWSER_DATA_CATEGORIES, clearInAppBrowserData, parseBrowserDataCategories } from '../src/main/browser-browsing-data.js';

it('clears only selected data types from the in-app partition and indexes', async () => {
  const browserSession = { clearStorageData: vi.fn(async () => undefined), clearCache: vi.fn(async () => undefined) };
  const history = { clear: vi.fn() };
  const downloads = { clearHistory: vi.fn() };
  await clearInAppBrowserData(browserSession as any, history as any, downloads as any, ['cookies']);
  expect(browserSession.clearStorageData).toHaveBeenCalledWith({ storages: ['cookies'] });
  expect(browserSession.clearCache).not.toHaveBeenCalled();
  expect(history.clear).not.toHaveBeenCalled();
  expect(downloads.clearHistory).not.toHaveBeenCalled();
  browserSession.clearStorageData.mockClear();
  await clearInAppBrowserData(browserSession as any, history as any, downloads as any,
    ['siteData', 'cache', 'downloadHistory', 'browsingHistory']);
  expect(browserSession.clearStorageData).toHaveBeenCalledWith({ storages: [
    'filesystem', 'indexdb', 'localstorage', 'websql', 'serviceworkers', 'cachestorage',
  ] });
  expect(browserSession.clearCache).toHaveBeenCalledOnce();
  expect(history.clear).toHaveBeenCalledOnce();
  expect(downloads.clearHistory).toHaveBeenCalledOnce();
});

it('rejects unsupported or duplicate data categories', () => {
  expect(parseBrowserDataCategories(BROWSER_DATA_CATEGORIES)).toEqual(BROWSER_DATA_CATEGORIES);
  expect(parseBrowserDataCategories(['cookies', 'cookies'])).toBeNull();
  expect(parseBrowserDataCategories(['cookies', 'agentProfile'])).toBeNull();
  expect(parseBrowserDataCategories([])).toBeNull();
});
