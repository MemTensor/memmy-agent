import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserHistoryTool, BrowserListTabsTool, BrowserSessionManager } from '../../../../src/core/agent-runtime/tools/browser.js';
import { RequestContext } from '../../../../src/core/agent-runtime/tools/context.js';
import type { EmbeddedBrowserBridge } from '../../../../src/core/agent-runtime/tools/embedded-browser-bridge.js';
import type { ExternalBrowserSessionRouter } from '../../../../src/core/agent-runtime/tools/external-browser-session-router.js';
import type { BrowserAccessApproval } from '../../../../src/core/agent-runtime/tools/browser-access-approval.js';

it.each(['mention', 'selected', 'bound'] as const)('rejects an in-app screenshot from a %s target before approval or binding, without external fallback', async target => {
  const scope = { sessionKey: 'no-screenshot', channel: 'projected-session', chatId: 'no-screenshot' };
  const claim = { connectionId: 'memmy-webview:browser', tabId: 41, browser: 'memmy' as const,
    title: 'A', url: 'https://example.com/', claimedAt: 1 };
  const bridge = { refresh: vi.fn(async () => target === 'selected' ? claim : null),
    resolveMention: vi.fn(async () => claim), close: vi.fn() } as unknown as EmbeddedBrowserBridge;
  const router = { hasBinding: vi.fn(() => target === 'bound'), select: vi.fn(() => claim),
    selectClaim: vi.fn(() => claim), call: vi.fn(), cdp: vi.fn(),
    closeAll: vi.fn() } as unknown as ExternalBrowserSessionRouter;
  const external = { select: vi.fn(), call: vi.fn(), cdp: vi.fn(),
    closeAll: vi.fn() } as unknown as ExternalBrowserSessionRouter;
  const accessApproval = { authorize: vi.fn(async () => true) } as unknown as BrowserAccessApproval;
  const runtimeLoader = vi.fn(async () => { throw new Error('Must not start another browser'); });
  const manager = new BrowserSessionManager({ enabled: true }, { desktopManaged: true,
    embeddedBridge: bridge, embeddedRouter: router, externalRouter: external, accessApproval, runtimeLoader });
  const params = target === 'mention' ? { tabMention: 'plugin://browser@memmy?mention=tab-v1' } : {};
  try {
    await expect(manager.callTool(scope, 'browser_take_screenshot', params)).rejects.toThrow(/not supported.*browser_snapshot/);
    await expect(manager.callCdp(scope, 'cdpCall', { ...params, method: 'Page.captureScreenshot' }))
      .rejects.toThrow(/not supported.*browser_snapshot/);
    expect(accessApproval.authorize).not.toHaveBeenCalled();
    expect(bridge.resolveMention).not.toHaveBeenCalled();
    expect(router.select).not.toHaveBeenCalled();
    expect(router.selectClaim).not.toHaveBeenCalled();
    expect(router.call).not.toHaveBeenCalled();
    expect(router.cdp).not.toHaveBeenCalled();
    expect(external.select).not.toHaveBeenCalled();
    expect(external.call).not.toHaveBeenCalled();
    expect(external.cdp).not.toHaveBeenCalled();
    expect(runtimeLoader).not.toHaveBeenCalled();
  } finally { await manager.close(); }
});

it('keeps external screenshot and CDP screenshot routing when no in-app tab is selected or bound', async () => {
  const scope = { sessionKey: 'external-screenshot', channel: 'projected-session', chatId: 'external-screenshot' };
  const claim = { connectionId: 'chrome', tabId: 5, browser: 'chrome' as const,
    title: 'External', url: 'https://example.com/', claimedAt: 1 };
  const bridge = { refresh: vi.fn(async () => null), close: vi.fn() } as unknown as EmbeddedBrowserBridge;
  const embedded = { hasBinding: vi.fn(() => false), select: vi.fn(() => null),
    closeAll: vi.fn() } as unknown as ExternalBrowserSessionRouter;
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
  const image = [{ type: 'image', mimeType: 'image/png', data: png }];
  const external = { select: vi.fn(() => claim), call: vi.fn(async () => image),
    cdp: vi.fn(async () => '{"data":"AAAA"}'), closeAll: vi.fn() } as unknown as ExternalBrowserSessionRouter;
  const runtimeLoader = vi.fn(async () => { throw new Error('Must not start another browser'); });
  const manager = new BrowserSessionManager({ enabled: true }, { desktopManaged: true,
    embeddedBridge: bridge, embeddedRouter: embedded, externalRouter: external, runtimeLoader });
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'embedded-routing-screenshot-'));
  vi.stubEnv('MEMMY_AGENT_DATA_DIR', dataRoot);
  try {
    const content = await manager.callTool(scope, 'browser_take_screenshot', {}) as Record<string, any>[];
    expect(content).toEqual([{ type: 'image_url', image_url: {
      url: `data:image/png;base64,${png}`, detail: 'auto' }, meta: { path: expect.any(String) } }]);
    expect(fs.readFileSync(content[0].meta.path)).toEqual(Buffer.from(png, 'base64'));
    expect(external.call).toHaveBeenCalledWith(scope, claim, 'browser_take_screenshot', {}, null);
    expect(await manager.callCdp(scope, 'cdpCall', { method: 'Page.captureScreenshot' })).toBe('{"data":"AAAA"}');
    expect(external.cdp).toHaveBeenCalledWith(scope, claim, 'cdpCall',
      { method: 'Page.captureScreenshot' }, expect.any(Function), undefined);
    expect(runtimeLoader).not.toHaveBeenCalled();
  } finally {
    await manager.close();
    vi.unstubAllEnvs();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

it('exposes in-app tab count to the Agent without navigating or claiming a tab', async () => {
  const bridge = { listTabs: vi.fn(async () => ({ browserId: 'browser', selectedTabId: 28,
    tabs: [{ tabId: 27, title: 'First', url: 'https://example.com/', tabMention: 'first' },
      { tabId: 28, title: 'Second', url: 'https://example.org/', tabMention: 'second' }] })),
    close: vi.fn() } as unknown as EmbeddedBrowserBridge;
  const manager = new BrowserSessionManager({ enabled: true }, { desktopManaged: true,
    embeddedBridge: bridge, externalRouter: null, embeddedRouter: null });
  const tool = new BrowserListTabsTool(manager);
  tool.setContext(new RequestContext({ sessionKey: 'session', channel: 'projected-session',
    chatId: 'chat', workspace: '/tmp/test' }));
  expect(JSON.parse(await tool.execute())).toMatchObject({ count: 2, selectedTabId: 28,
    tabs: [{ tabId: 27 }, { tabId: 28 }] });
  expect(bridge.listTabs).toHaveBeenCalledOnce();
  await manager.close();
});

it('sends only a bounded in-app history request through the desktop bridge', async () => {
  const bridge = { queryHistory: vi.fn(async () => ({ entries: [
    { url: 'https://example.com/', title: 'Example', visitedAt: 1 },
  ] })), close: vi.fn() } as unknown as EmbeddedBrowserBridge;
  const manager = new BrowserSessionManager({ enabled: true }, { desktopManaged: true,
    embeddedBridge: bridge, externalRouter: null, embeddedRouter: null });
  const tool = new BrowserHistoryTool(manager);
  tool.setContext(new RequestContext({ sessionKey: 'session', channel: 'projected-session',
    chatId: 'chat', workspace: '/tmp/test', messageId: 'message' }));
  const input = { from: '2026-09-28T00:00:00Z', to: '2026-09-29T00:00:00Z', keyword: 'example' };
  expect(JSON.parse(await tool.execute(input))).toEqual({ entries: [
    { url: 'https://example.com/', title: 'Example', visitedAt: 1 },
  ] });
  expect(bridge.queryHistory).toHaveBeenCalledWith({ ...input, limit: 20 });
  tool.setContext(new RequestContext({ sessionKey: 'session', channel: 'cron',
    chatId: 'chat', workspace: '/tmp/test', messageId: 'message' }));
  await expect(tool.execute(input)).rejects.toThrow(/interactive/);
  expect(bridge.queryHistory).toHaveBeenCalledTimes(1);
  await manager.close();
});

it('routes an Agent call to the actual open Memmy webview and preserves its tab identity', async () => {
  const scope = { sessionKey: 'chat', channel: 'projected-session', chatId: 'chat' };
  const claim = { connectionId: 'memmy-webview', tabId: 27, browser: 'memmy' as const,
    title: 'Example', url: 'https://example.com/', claimedAt: 1 };
  const bridge = { refresh: vi.fn(async () => claim), close: vi.fn() } as unknown as EmbeddedBrowserBridge;
  let bound = false;
  const router = { hasBinding: vi.fn(() => bound), select: vi.fn(() => { bound = true; return claim; }),
    selectClaim: vi.fn(() => claim), markTab: vi.fn(), finishTurn: vi.fn(async () => undefined),
    call: vi.fn(async () => [{ type: 'text', text: '[ax-7] link Learn more' }]),
    handleSurfaceAction: vi.fn(async () => true), closeSession: vi.fn(), closeChat: vi.fn(),
    closeSurfacesForTurn: vi.fn(), closeAll: vi.fn() } as unknown as ExternalBrowserSessionRouter;
  const manager = new BrowserSessionManager({ enabled: true }, {
    desktopManaged: true, embeddedBridge: bridge, embeddedRouter: router,
    externalRouter: null, runtimeLoader: vi.fn(async () => { throw new Error('Separate Chromium must not start'); }),
  });
  expect(await manager.callTool(scope, 'browser_snapshot', {}))
    .toEqual([{ type: 'text', text: '[ax-7] link Learn more' }]);
  expect(await manager.callTool(scope, 'browser_navigate', { url: 'https://example.com/page' }))
    .toEqual([{ type: 'text', text: '[ax-7] link Learn more' }]);
  expect(router.select).toHaveBeenCalledWith(scope, false);
  expect(router.call).toHaveBeenCalledWith(scope, claim, 'browser_navigate', { url: 'https://example.com/page' }, null);
  await manager.close();
  expect(bridge.close).toHaveBeenCalledOnce();
});

it('opens an unrelated site in a new Agent tab without replacing the user tab', async () => {
  const scope = { sessionKey: 'new-chat', channel: 'projected-session', chatId: 'new-chat' };
  const claim = { connectionId: 'memmy-webview', tabId: 27, browser: 'memmy' as const,
    title: 'Example', url: 'https://example.com/', claimedAt: 1 };
  const created = { ...claim, tabId: 28, url: 'https://other.example/landing' };
  const bridge = { refresh: vi.fn(async () => claim), openTab: vi.fn(async () => created),
    close: vi.fn() } as unknown as EmbeddedBrowserBridge;
  const router = { hasBinding: vi.fn(() => false), select: vi.fn(() => created),
    selectClaim: vi.fn(() => created), markTab: vi.fn(), finishTurn: vi.fn(async () => undefined),
    authorizeCurrent: vi.fn(async () => undefined),
    call: vi.fn(async () => [{ type: 'text', text: '{}' }]), closeAll: vi.fn() } as unknown as ExternalBrowserSessionRouter;
  const accessApproval = { authorize: vi.fn(async () => true) } as unknown as BrowserAccessApproval;
  const manager = new BrowserSessionManager({ enabled: true }, {
    desktopManaged: true, embeddedBridge: bridge, embeddedRouter: router, accessApproval,
    externalRouter: null, runtimeLoader: vi.fn(async () => { throw new Error('Separate Chromium must not start'); }),
  });
  expect(await manager.callTool(scope, 'browser_navigate', { url: 'https://other.example/' }))
    .toEqual([{ type: 'text', text: JSON.stringify({ url: created.url }) }]);
  expect(bridge.openTab).toHaveBeenCalledWith('https://other.example/', 'new-chat');
  expect(bridge.openTab).toHaveBeenCalledOnce();
  expect(router.selectClaim).toHaveBeenCalledWith(scope, created,
    { allowedOrigins: new Set(['https://other.example']), agentCreated: true });
  expect(router.authorizeCurrent).toHaveBeenCalledWith(scope, created);
  expect(router.call).not.toHaveBeenCalled();
  await manager.close();
});

it('opens another in-app tab on request while the chat already works in one', async () => {
  const scope = { sessionKey: 'compare', channel: 'projected-session', chatId: 'compare' };
  const first = { connectionId: 'memmy-webview', tabId: 27, browser: 'memmy' as const,
    title: 'First', url: 'https://first.example/', claimedAt: 1 };
  const second = { ...first, tabId: 28, title: 'Second', url: 'https://second.example/' };
  const bridge = { refresh: vi.fn(async () => first), openTab: vi.fn(async () => second),
    close: vi.fn() } as unknown as EmbeddedBrowserBridge;
  const router = { hasBinding: vi.fn(() => true), lastUsed: vi.fn(() => 1), select: vi.fn(() => first),
    selectClaim: vi.fn(() => second), markTab: vi.fn(), finishTurn: vi.fn(async () => undefined),
    authorizeCurrent: vi.fn(async () => undefined),
    call: vi.fn(async () => [{ type: 'text', text: '{}' }]), closeAll: vi.fn() } as unknown as ExternalBrowserSessionRouter;
  const external = { hasBinding: vi.fn(() => true), lastUsed: vi.fn(() => 2), select: vi.fn(),
    call: vi.fn(), closeAll: vi.fn() } as unknown as ExternalBrowserSessionRouter;
  const accessApproval = { authorize: vi.fn(async () => true) } as unknown as BrowserAccessApproval;
  const manager = new BrowserSessionManager({ enabled: true }, {
    desktopManaged: true, embeddedBridge: bridge, embeddedRouter: router, accessApproval,
    externalRouter: external, runtimeLoader: vi.fn(async () => { throw new Error('Separate Chromium must not start'); }),
  });
  expect(await manager.callTool(scope, 'browser_navigate', { url: 'https://second.example/', newTab: true,
    targetBrowser: 'memmy', tabDisposition: 'deliverable' }))
    .toEqual([{ type: 'text', text: JSON.stringify({ url: second.url }) }]);
  expect(bridge.openTab).toHaveBeenCalledWith('https://second.example/', 'compare');
  expect(bridge.openTab).toHaveBeenCalledOnce();
  expect(router.selectClaim).toHaveBeenCalledWith(scope, second,
    { allowedOrigins: new Set(['https://second.example']), agentCreated: true });
  expect(router.authorizeCurrent).toHaveBeenCalledWith(scope, second);
  expect(router.call).not.toHaveBeenCalled();
  expect(router.markTab).toHaveBeenCalledWith(scope, 'deliverable', second);
  expect(router.select).not.toHaveBeenCalled();
  expect(external.select).not.toHaveBeenCalled();
  await expect(manager.callTool(scope, 'browser_navigate', { url: 'https://x.example/', newTab: true, tabMention: 'tab' }))
    .rejects.toThrow(/omit tabMention/);
  await manager.close();
});

it('opens the first Agent tab in its runtime chat after site approval, ignoring a tool-provided owner', async () => {
  const scope = { sessionKey: 'websocket:fresh', channel: 'websocket', chatId: 'fresh' };
  const claim = { connectionId: 'memmy-webview', tabId: 31, browser: 'memmy' as const,
    title: 'Example', url: 'https://example.com/', claimedAt: 1 };
  const bridge = { refresh: vi.fn(async () => null), openTab: vi.fn(async () => claim),
    close: vi.fn() } as unknown as EmbeddedBrowserBridge;
  const router = { hasBinding: vi.fn(() => false), select: vi.fn(() => claim),
    selectClaim: vi.fn(() => claim), markTab: vi.fn(), finishTurn: vi.fn(async () => undefined),
    authorizeCurrent: vi.fn(async () => undefined),
    call: vi.fn(async () => [{ type: 'text', text: '{}' }]), closeAll: vi.fn() } as unknown as ExternalBrowserSessionRouter;
  const accessApproval = { authorize: vi.fn(async (_url: string, allowed: Set<string>) => {
    allowed.add('https://example.com'); return true;
  }) } as unknown as BrowserAccessApproval;
  const manager = new BrowserSessionManager({ enabled: true }, {
    desktopManaged: true, embeddedBridge: bridge, embeddedRouter: router, accessApproval,
    externalRouter: null, runtimeLoader: vi.fn(async () => { throw new Error('Separate Chromium must not start'); }),
  });
  await manager.callTool(scope, 'browser_navigate', { url: 'https://example.com/', scopeKey: 'another-chat' });
  expect(bridge.openTab).toHaveBeenCalledWith('https://example.com/', 'fresh');
  expect(router.selectClaim).toHaveBeenCalledWith(scope, claim,
    { allowedOrigins: new Set(['https://example.com']), agentCreated: true });
  await manager.close();
});

it('uses an exact tab mention and never falls back when the mention is stale', async () => {
  const scope = { sessionKey: 'mentioned', channel: 'projected-session', chatId: 'mentioned' };
  const claim = { connectionId: 'memmy-webview:browser', tabId: 41, browser: 'memmy' as const,
    title: 'Original', url: 'https://example.com/', claimedAt: 1 };
  const bridge = { resolveMention: vi.fn(async () => claim), refresh: vi.fn(async () => null),
    close: vi.fn() } as unknown as EmbeddedBrowserBridge;
  const router = { selectClaim: vi.fn(() => claim), call: vi.fn(async () => [{ type: 'text', text: 'page' }]),
    markTab: vi.fn(), finishTurn: vi.fn(async () => undefined), closeAll: vi.fn() } as unknown as ExternalBrowserSessionRouter;
  const manager = new BrowserSessionManager({ enabled: true }, { desktopManaged: true,
    embeddedBridge: bridge, embeddedRouter: router, externalRouter: null,
    runtimeLoader: vi.fn(async () => { throw new Error('Must not launch Chromium'); }) });
  expect(await manager.callTool(scope, 'browser_snapshot',
    { tabMention: 'plugin://browser@memmy?mention=tab-v1', tabDisposition: 'handoff' }))
    .toEqual([{ type: 'text', text: 'page' }]);
  expect(router.selectClaim).toHaveBeenCalledWith(scope, claim);
  expect(router.call).toHaveBeenCalledWith(scope, claim, 'browser_snapshot', {}, null);
  expect(router.markTab).toHaveBeenCalledWith(scope, 'handoff', claim);
  vi.mocked(bridge.resolveMention).mockRejectedValueOnce(new Error('Stale tab mention'));
  await expect(manager.callTool(scope, 'browser_snapshot', { tabMention: 'stale' }))
    .rejects.toThrow('Stale tab mention');
  expect(router.call).toHaveBeenCalledTimes(1);
  await manager.close();
});

it.each(['stop', 'abort'] as const)('does not bind or navigate a newly opened tab after %s', async interruption => {
  const scope = { sessionKey: 'opening', channel: 'projected-session', chatId: 'opening' };
  const claim = { connectionId: 'memmy-webview', tabId: 31, browser: 'memmy' as const,
    title: 'Form', url: 'https://example.com/form', claimedAt: 1 };
  let finishOpening!: (value: typeof claim) => void;
  const opening = new Promise<typeof claim>(resolve => { finishOpening = resolve; });
  const bridge = { refresh: vi.fn(async () => null), openTab: vi.fn(() => opening),
    command: vi.fn(async () => ({ ok: true })), close: vi.fn() } as unknown as EmbeddedBrowserBridge;
  const router = { hasBinding: vi.fn(() => false), selectClaim: vi.fn(() => claim),
    authorizeCurrent: vi.fn(async () => undefined), call: vi.fn(), markTab: vi.fn(),
    finishTurn: vi.fn(async () => undefined), closeAll: vi.fn() } as unknown as ExternalBrowserSessionRouter;
  const accessApproval = { authorize: vi.fn(async () => true) } as unknown as BrowserAccessApproval;
  const manager = new BrowserSessionManager({ enabled: true }, { desktopManaged: true,
    embeddedBridge: bridge, embeddedRouter: router, externalRouter: null, accessApproval });
  const cancel = new AbortController();
  try {
    const pending = manager.callTool(scope, 'browser_navigate',
      { url: claim.url, tabDisposition: 'deliverable' }, cancel.signal);
    const rejected = expect(pending).rejects.toThrow(/cancel|finished turn/);
    await vi.waitFor(() => expect(bridge.openTab).toHaveBeenCalledOnce());
    if (interruption === 'stop') await manager.closeSurfacesForTurn(scope);
    else cancel.abort();
    finishOpening(claim);
    await rejected;
    expect(bridge.command).toHaveBeenCalledExactlyOnceWith(claim, 'closeTab');
    expect(router.selectClaim).not.toHaveBeenCalled();
    expect(router.authorizeCurrent).not.toHaveBeenCalled();
    expect(router.call).not.toHaveBeenCalled();
    expect(router.markTab).not.toHaveBeenCalled();
  } finally { await manager.close(); }
});

it('does not report or retain a new tab if the turn stops during live-site authorization', async () => {
  const scope = { sessionKey: 'opening-approval', channel: 'projected-session', chatId: 'opening-approval' };
  const claim = { connectionId: 'memmy-webview', tabId: 31, browser: 'memmy' as const,
    title: 'Form', url: 'https://example.com/form', claimedAt: 1 };
  let finishApproval!: () => void;
  const approval = new Promise<void>(resolve => { finishApproval = resolve; });
  const bridge = { refresh: vi.fn(async () => null), openTab: vi.fn(async () => claim),
    close: vi.fn() } as unknown as EmbeddedBrowserBridge;
  const router = { hasBinding: vi.fn(() => false), selectClaim: vi.fn(() => claim),
    authorizeCurrent: vi.fn(() => approval), call: vi.fn(), markTab: vi.fn(),
    finishTurn: vi.fn(async () => undefined), closeAll: vi.fn() } as unknown as ExternalBrowserSessionRouter;
  const accessApproval = { authorize: vi.fn(async () => true) } as unknown as BrowserAccessApproval;
  const manager = new BrowserSessionManager({ enabled: true }, { desktopManaged: true,
    embeddedBridge: bridge, embeddedRouter: router, externalRouter: null, accessApproval });
  try {
    const pending = manager.callTool(scope, 'browser_navigate',
      { url: claim.url, tabDisposition: 'deliverable' });
    const rejected = expect(pending).rejects.toThrow(/finished turn/);
    await vi.waitFor(() => expect(router.authorizeCurrent).toHaveBeenCalledOnce());
    await manager.closeSurfacesForTurn(scope);
    finishApproval();
    await rejected;
    expect(router.call).not.toHaveBeenCalled();
    expect(router.markTab).not.toHaveBeenCalled();
  } finally { await manager.close(); }
});

it.each([false, true])('preserves the new-tab download destination restriction (newTab=%s)', async newTab => {
  const scope = { sessionKey: 'download', channel: 'projected-session', chatId: 'download' };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'embedded-new-tab-download-'));
  const bridge = { refresh: vi.fn(async () => null), openTab: vi.fn(), close: vi.fn() } as unknown as EmbeddedBrowserBridge;
  const router = { hasBinding: vi.fn(() => false), call: vi.fn(), closeAll: vi.fn() } as unknown as ExternalBrowserSessionRouter;
  const accessApproval = { authorize: vi.fn(async () => true) } as unknown as BrowserAccessApproval;
  const manager = new BrowserSessionManager({ enabled: true }, { desktopManaged: true,
    embeddedBridge: bridge, embeddedRouter: router, externalRouter: null, accessApproval });
  try {
    await expect(manager.callTool(scope, 'browser_navigate', { url: 'https://example.com/file', newTab,
      downloadPath: path.join(directory, 'download.pdf') })).rejects.toThrow(/downloadPath requires an existing/);
    expect(bridge.openTab).not.toHaveBeenCalled();
    expect(accessApproval.authorize).not.toHaveBeenCalled();
    expect(router.call).not.toHaveBeenCalled();
  } finally {
    await manager.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
