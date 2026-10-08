import { expect, it, vi } from 'vitest';
import { BrowserHistoryTool, BrowserListTabsTool, BrowserSessionManager } from '../../../../src/core/agent-runtime/tools/browser.js';
import { RequestContext } from '../../../../src/core/agent-runtime/tools/context.js';
import type { EmbeddedBrowserBridge } from '../../../../src/core/agent-runtime/tools/embedded-browser-bridge.js';
import type { ExternalBrowserSessionRouter } from '../../../../src/core/agent-runtime/tools/external-browser-session-router.js';
import type { BrowserAccessApproval } from '../../../../src/core/agent-runtime/tools/browser-access-approval.js';

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
  const created = { ...claim, tabId: 28, url: 'https://other.example/' };
  const bridge = { refresh: vi.fn(async () => claim), openTab: vi.fn(async () => created),
    close: vi.fn() } as unknown as EmbeddedBrowserBridge;
  const router = { hasBinding: vi.fn(() => false), select: vi.fn(() => created),
    selectClaim: vi.fn(() => created), markTab: vi.fn(), finishTurn: vi.fn(async () => undefined),
    call: vi.fn(async () => [{ type: 'text', text: '{}' }]), closeAll: vi.fn() } as unknown as ExternalBrowserSessionRouter;
  const accessApproval = { authorize: vi.fn(async () => true) } as unknown as BrowserAccessApproval;
  const manager = new BrowserSessionManager({ enabled: true }, {
    desktopManaged: true, embeddedBridge: bridge, embeddedRouter: router, accessApproval,
    externalRouter: null, runtimeLoader: vi.fn(async () => { throw new Error('Separate Chromium must not start'); }),
  });
  await manager.callTool(scope, 'browser_navigate', { url: 'https://other.example/' });
  expect(bridge.openTab).toHaveBeenCalledWith('https://other.example/');
  expect(router.selectClaim).toHaveBeenCalledWith(scope, created,
    { allowedOrigins: new Set(['https://other.example']), agentCreated: true });
  expect(router.call).toHaveBeenCalledWith(scope, created, 'browser_navigate', { url: 'https://other.example/' });
  await manager.close();
});

it('opens a visible embedded tab for the first Agent navigation after site approval', async () => {
  const scope = { sessionKey: 'fresh', channel: 'projected-session', chatId: 'fresh' };
  const claim = { connectionId: 'memmy-webview', tabId: 31, browser: 'memmy' as const,
    title: 'Example', url: 'https://example.com/', claimedAt: 1 };
  const bridge = { refresh: vi.fn(async () => null), openTab: vi.fn(async () => claim),
    close: vi.fn() } as unknown as EmbeddedBrowserBridge;
  const router = { hasBinding: vi.fn(() => false), select: vi.fn(() => claim),
    selectClaim: vi.fn(() => claim), markTab: vi.fn(), finishTurn: vi.fn(async () => undefined),
    call: vi.fn(async () => [{ type: 'text', text: '{}' }]), closeAll: vi.fn() } as unknown as ExternalBrowserSessionRouter;
  const accessApproval = { authorize: vi.fn(async (_url: string, allowed: Set<string>) => {
    allowed.add('https://example.com'); return true;
  }) } as unknown as BrowserAccessApproval;
  const manager = new BrowserSessionManager({ enabled: true }, {
    desktopManaged: true, embeddedBridge: bridge, embeddedRouter: router, accessApproval,
    externalRouter: null, runtimeLoader: vi.fn(async () => { throw new Error('Separate Chromium must not start'); }),
  });
  await manager.callTool(scope, 'browser_navigate', { url: 'https://example.com/' });
  expect(bridge.openTab).toHaveBeenCalledWith('https://example.com/');
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
  expect(router.markTab).toHaveBeenCalledWith(scope, 'handoff');
  vi.mocked(bridge.resolveMention).mockRejectedValueOnce(new Error('Stale tab mention'));
  await expect(manager.callTool(scope, 'browser_snapshot', { tabMention: 'stale' }))
    .rejects.toThrow('Stale tab mention');
  expect(router.call).toHaveBeenCalledTimes(1);
  await manager.close();
});
