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

it('carries the owning chat across child IPC and returns the new tab while another tab is selected', async () => {
  const previousSend = Object.getOwnPropertyDescriptor(process, 'send');
  const browserId = 'fb77c359-316a-4221-8cb7-967e230a8d50';
  const created = { tabId: 28, title: 'Background chat tab', url: 'https://example.com/', everSelected: false };
  const send = vi.fn((message: { type: string; requestId: string; command: string; args: unknown },
    callback?: (error: Error | null) => void) => {
    callback?.(null);
    queueMicrotask(() => process.emit('message', { type: 'memmy:embedded-browser:result',
      requestId: message.requestId, ok: true, result: message.command === 'openTab' ? { tabId: 28 }
        : { browserId, selectedTabId: 27, tabs: [
          { tabId: 27, title: 'Foreground chat tab', url: 'https://other.test/' }, created,
        ] } }));
  });
  Object.defineProperty(process, 'send', { configurable: true, value: send });
  const bridge = new EmbeddedBrowserBridge();
  try {
    expect(await bridge.openTab(created.url, 'background-chat')).toMatchObject(created);
    expect(bridge.getClaim({ connectionId: `memmy-webview:${browserId}`, tabId: 28 }))
      .toMatchObject({ everSelected: false });
    expect(send.mock.calls[0]?.[0]).toMatchObject({ command: 'openTab',
      args: { url: created.url, scopeKey: 'background-chat' } });
    expect(bridge.listClaims()).toMatchObject([{ tabId: 27 }]);
    expect(send).toHaveBeenCalledTimes(2);
  } finally {
    bridge.close();
    if (previousSend) Object.defineProperty(process, 'send', previousSend);
    else delete (process as { send?: unknown }).send;
  }
});

it.each([undefined, '', '   ', 'x'.repeat(513)])('refuses to open an Agent tab with an invalid owner before child IPC', async owner => {
  const bridge = new EmbeddedBrowserBridge();
  const request = vi.fn();
  (bridge as any).request = request;
  try {
    await expect(bridge.openTab('https://example.com/', owner as string)).rejects.toThrow(/valid chat scope/);
    expect(request).not.toHaveBeenCalled();
  } finally { bridge.close(); }
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

it('requests external browser facts without reading or claiming any page', async () => {
  const bridge = new EmbeddedBrowserBridge();
  const signal = new AbortController().signal;
  (bridge as any).request = vi.fn(async () => ({ installation: {
    chrome: { installed: true, enabled: false }, edge: { installed: null, enabled: null },
  }, runningBrowsers: ['chrome', 'chrome'] }));
  try {
    expect(await bridge.getExternalBrowserState(signal)).toEqual({ installation: {
      chrome: { installed: true, enabled: false }, edge: { installed: null, enabled: null },
    }, runningBrowsers: ['chrome'] });
    expect((bridge as any).request).toHaveBeenCalledExactlyOnceWith('externalBrowserState', {}, undefined, signal);
    expect(bridge.listClaims()).toEqual([]);
  } finally { bridge.close(); }
});

it.each([null, {}, { installation: { chrome: { installed: 'yes', enabled: 1 } }, runningBrowsers: ['other'] }])
  ('preserves malformed external browser facts as unknown: %j', async response => {
    const bridge = new EmbeddedBrowserBridge();
    (bridge as any).request = vi.fn(async () => response);
    try {
      expect(await bridge.getExternalBrowserState()).toEqual({ installation: {
        chrome: { installed: null, enabled: null }, edge: { installed: null, enabled: null },
      }, runningBrowsers: null });
    } finally { bridge.close(); }
  });

it('sends only the target browser identity and cancellation signal for recovery', async () => {
  const bridge = new EmbeddedBrowserBridge();
  const signal = new AbortController().signal;
  (bridge as any).request = vi.fn(async () => 'woken');
  try {
    expect(await bridge.recoverExternalBrowser('edge', signal)).toBe('woken');
    expect((bridge as any).request).toHaveBeenCalledExactlyOnceWith('recoverExternalBrowser', { browser: 'edge' }, undefined, signal);
    (bridge as any).request.mockResolvedValue({ private: 'untrusted' });
    expect(await bridge.recoverExternalBrowser('chrome')).toBe('unavailable');
  } finally { bridge.close(); }
});
