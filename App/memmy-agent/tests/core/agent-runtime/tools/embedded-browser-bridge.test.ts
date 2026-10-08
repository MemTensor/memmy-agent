import { expect, it, vi } from 'vitest';
import { formatEmbeddedBrowserTabMention } from '@memmy/local-api-contracts';
import { EmbeddedBrowserBridge } from '../../../../src/core/agent-runtime/tools/embedded-browser-bridge.js';

it('requires all four tab mention fields to match the fresh open-tab list', async () => {
  const browserId = 'fb77c359-316a-4221-8cb7-967e230a8d50';
  const tab = { browserId, tabId: 27, title: 'Original', url: 'https://example.com/' };
  const response = { browserId, selectedTabId: 27, tabs: [{ tabId: 27, title: tab.title, url: tab.url }] };
  const bridge = new EmbeddedBrowserBridge();
  (bridge as any).request = vi.fn(async () => response);
  const mention = formatEmbeddedBrowserTabMention(tab);
  expect(await bridge.resolveMention(mention)).toMatchObject({ tabId: 27, title: tab.title, url: tab.url });
  response.tabs[0].title = 'Changed';
  await expect(bridge.resolveMention(mention)).rejects.toThrow('Stale tab mention');
  response.tabs[0].title = tab.title;
  response.tabs[0].url = 'https://example.com/next';
  await expect(bridge.resolveMention(mention)).rejects.toThrow('Stale tab mention');
  response.tabs[0].url = tab.url;
  response.browserId = 'a64660a4-689c-4fb4-bd9f-98d4ae090ca3';
  await expect(bridge.resolveMention(mention)).rejects.toThrow('Stale tab mention');
  bridge.close();
});

it('lists every controllable in-app tab and marks the selected tab', async () => {
  const browserId = 'fb77c359-316a-4221-8cb7-967e230a8d50';
  const tabs = [
    { tabId: 27, title: 'First', url: 'https://example.com/' },
    { tabId: 28, title: 'Second', url: 'https://example.org/' },
  ];
  const bridge = new EmbeddedBrowserBridge();
  (bridge as any).request = vi.fn(async () => ({ browserId, selectedTabId: 28, tabs }));
  expect(await bridge.listTabs()).toEqual({
    browserId, selectedTabId: 28,
    tabs: tabs.map(tab => ({ ...tab, tabMention: formatEmbeddedBrowserTabMention({ browserId, ...tab }) })),
  });
  expect((bridge as any).request).toHaveBeenCalledExactlyOnceWith('listTabs');
  bridge.close();
});

it('counts an initial blank sidebar tab without giving it a webpage action reference', async () => {
  const browserId = 'fb77c359-316a-4221-8cb7-967e230a8d50';
  const bridge = new EmbeddedBrowserBridge();
  (bridge as any).request = vi.fn(async () => ({ browserId, selectedTabId: 28,
    tabs: [{ tabId: 27, title: 'Example', url: 'https://example.com/' },
      { tabId: 28, title: '', url: 'about:blank' }] }));
  expect(await bridge.listTabs()).toEqual({ browserId, selectedTabId: 28, tabs: [
    { tabId: 27, title: 'Example', url: 'https://example.com/',
      tabMention: formatEmbeddedBrowserTabMention({ browserId, tabId: 27,
        title: 'Example', url: 'https://example.com/' }) },
    { tabId: 28, title: '', url: 'about:blank', tabMention: null },
  ] });
  expect(bridge.listClaims()).toEqual([]);
  bridge.close();
});

it('sends a cancel request when an in-app upload turn is aborted', async () => {
  const previousSend = Object.getOwnPropertyDescriptor(process, 'send');
  const send = vi.fn((_message: unknown, callback?: (error: Error | null) => void) => callback?.(null));
  Object.defineProperty(process, 'send', { configurable: true, value: send });
  const bridge = new EmbeddedBrowserBridge();
  try {
    const claim = { connectionId: 'memmy-webview:test', tabId: 27, browser: 'memmy',
      title: 'Example', url: 'https://example.com/', claimedAt: Date.now() };
    (bridge as any).browserId = 'test';
    (bridge as any).claims.set(27, claim);
    const controller = new AbortController();
    const pending = bridge.command(claim, 'upload', { paths: ['/workspace/report.txt'], target: 'ax-7' },
      controller.signal);
    const requestId = (send.mock.calls[0]![0] as { requestId: string }).requestId;
    controller.abort();
    await expect(pending).rejects.toThrow('canceled');
    expect(send).toHaveBeenCalledWith({ type: 'memmy:embedded-browser:cancel', requestId },
      expect.any(Function));
  } finally {
    bridge.close();
    if (previousSend) Object.defineProperty(process, 'send', previousSend);
    else delete (process as { send?: unknown }).send;
  }
});
