import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BrowserSessionManager, type BrowserScope } from '../../../../src/core/agent-runtime/tools/browser.js';
import type { BrowserCapabilityApproval } from '../../../../src/core/agent-runtime/tools/browser-capability-approval.js';
import { BrowserUseSitePolicyReader } from '../../../../src/core/agent-runtime/tools/browser-use-site-policy-store.js';
import type { EmbeddedBrowserBridge } from '../../../../src/core/agent-runtime/tools/embedded-browser-bridge.js';
import type { ExternalBrowserClaim, ExternalBrowserTabStatus } from '../../../../src/core/agent-runtime/tools/external-browser-bridge.js';
import { ExternalBrowserSessionRouter } from '../../../../src/core/agent-runtime/tools/external-browser-session-router.js';
import { formatExternalBrowserTabReference } from '../../../../src/core/agent-runtime/tools/external-browser-tab-reference.js';

type ExternalPage = ExternalBrowserClaim & { browser: 'chrome' | 'edge' };
const scope: BrowserScope = { sessionKey: 'ordinary-external-browser-chat',
  channel: 'projected-session', chatId: 'ordinary-external-browser-chat' };
const otherScope: BrowserScope = { sessionKey: 'other-chat', channel: 'projected-session', chatId: 'other-chat' };
const identity = (claim: Pick<ExternalBrowserClaim, 'connectionId' | 'tabId'>) => `${claim.connectionId}:${claim.tabId}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(options: { pages?: Array<'chrome' | 'edge'>; secondEdge?: boolean; secondEdgeOpenedFromFirst?: boolean } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-external-browser-target-'));
  const policyPath = path.join(directory, 'site-policy.json');
  fs.writeFileSync(policyPath, JSON.stringify({ version: 1, rules: [
    { pattern: 'https://www.baidu.com', access: 'allow', downloads: 'allow', uploads: 'allow', fullCdp: 'allow' },
    { pattern: 'https://embedded.test', access: 'allow', downloads: 'allow', uploads: 'allow', fullCdp: 'allow' },
  ] }));
  const sitePolicy = new BrowserUseSitePolicyReader(policyPath);
  // Tab IDs are browser-local: these two unrelated pages deliberately share 7.
  const edge: ExternalPage = { connectionId: 'e'.repeat(24), tabId: 7, browser: 'edge',
    title: '百度 · Edge', url: 'https://www.baidu.com/?browser=edge', active: false, claimedAt: 1 };
  const chrome: ExternalPage = { connectionId: 'c'.repeat(24), tabId: 7, browser: 'chrome',
    title: '百度 · Chrome', url: 'https://www.baidu.com/?browser=chrome', active: false, claimedAt: 10 };
  const secondEdge: ExternalPage = { ...edge, tabId: 8, title: '另一个百度标签',
    url: 'https://www.baidu.com/?browser=edge&tab=second', claimedAt: 20,
    ...(options.secondEdgeOpenedFromFirst ? { openerTabId: edge.tabId } : {}) };
  const browsers: Array<'chrome' | 'edge'> = options.pages ?? ['edge', 'chrome'];
  const claims: ExternalPage[] = [edge, chrome].filter(page => browsers.includes(page.browser));
  if (options.secondEdge) claims.push(secondEdge);
  const statuses: ExternalBrowserTabStatus[] = [];
  const typedValues = new Map<string, string>();
  const bridge = {
    listClaims: () => claims,
    listConnected: () => [...browsers],
    listTabStatuses: () => statuses,
    refreshTabs: vi.fn(async (_browser?: 'chrome' | 'edge') => undefined),
    openBrowserTab: vi.fn(async (browser: 'chrome' | 'edge', url: string,
      source?: Pick<ExternalBrowserClaim, 'connectionId' | 'tabId'>): Promise<ExternalPage> => {
      const page: ExternalPage = { connectionId: (browser === 'edge' ? edge : chrome).connectionId, tabId: 30,
        browser, title: '新标签', url, claimedAt: 40, ...(source ? { openerTabId: source.tabId } : {}) };
      claims.push(page);
      return page;
    }),
    getClaim: (target: Pick<ExternalBrowserClaim, 'connectionId' | 'tabId'>) =>
      claims.find(page => identity(page) === identity(target)) ?? null,
    command: vi.fn(async (target: Pick<ExternalBrowserClaim, 'connectionId' | 'tabId'>,
      operation: string, args: Record<string, unknown> = {}): Promise<unknown> => {
      const page = claims.find(candidate => identity(candidate) === identity(target));
      if (!page) throw new Error('External browser tab is no longer connected');
      if (operation === 'snapshot') return { nodes: [{ ref: 'answer', role: 'textbox',
        name: page.title, value: typedValues.get(identity(page)) ?? '' }] };
      if (operation === 'type') typedValues.set(identity(page), String(args.text ?? ''));
      if (operation === 'tabState') return { title: page.title, url: page.url, origin: new URL(page.url).origin };
      if (operation === 'cdpCall') return { result: { value: page.title } };
      if (operation === 'authRequest') return { status: 'submitted' };
      if (operation === 'screenshot') return { format: 'jpeg', data: 'AAA' };
      if (operation === 'historyState') return { canGoBack: false, canGoForward: false };
      return { ok: true };
    }),
  };
  const router = new ExternalBrowserSessionRouter(bridge, async () => true, 'external', sitePolicy);
  const embedded: ExternalBrowserClaim = { connectionId: 'memmy-webview:existing-sidebar', tabId: 99,
    browser: 'memmy', title: 'Existing Memmy page', url: 'https://embedded.test/', claimedAt: 30 };
  const embeddedBridge = {
    refresh: vi.fn(async () => embedded),
    listTabs: vi.fn(async () => ({ browserId: 'existing-sidebar', selectedTabId: 99,
      tabs: [{ tabId: 99, title: embedded.title, url: embedded.url, tabMention: 'unused-in-app-reference' }] })),
    listClaims: () => [embedded],
    getClaim: (target: Pick<ExternalBrowserClaim, 'connectionId' | 'tabId'>) =>
      identity(target) === identity(embedded) ? embedded : null,
    command: vi.fn(async () => ({ nodes: [{ role: 'text', name: 'Wrong in-app page' }] })),
    close: vi.fn(),
  };
  const embeddedRouter = new ExternalBrowserSessionRouter(embeddedBridge, async () => true, 'embedded', sitePolicy);
  const runtimeLoader = vi.fn(async () => { throw new Error('A requested external browser must not launch managed Chromium'); });
  const capabilityApproval = { authorize: vi.fn(async () => true), blocked: vi.fn(() => false) };
  const manager = new BrowserSessionManager({ enabled: true }, { desktopManaged: true,
    externalRouter: router, embeddedBridge: embeddedBridge as unknown as EmbeddedBrowserBridge,
    embeddedRouter, runtimeLoader, capabilityApproval: capabilityApproval as unknown as BrowserCapabilityApproval,
    profileStore: null, downloadStore: null, sitePermissionStore: null, accessApproval: null });
  const reference = (page: ExternalPage) => formatExternalBrowserTabReference(page);
  function noFallback() {
    expect(runtimeLoader).not.toHaveBeenCalled();
    expect(embeddedBridge.command).not.toHaveBeenCalled();
    expect(embeddedRouter.hasBinding(scope)).toBe(false);
  }
  async function cleanup() {
    await manager.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
  return { edge, chrome, secondEdge, claims, statuses, bridge, router, embedded, embeddedBridge,
    embeddedRouter, runtimeLoader, manager, reference, typedValues, capabilityApproval, noFallback, cleanup };
}

describe('ordinary Chrome and Edge requests use the requested extension tab', () => {
  it.each(['edge', 'chrome'] as const)('lists only %s pages without binding or operating a tab', async browser => {
    const f = fixture();
    try {
      expect(f.manager.supportsTabListing()).toBe(true);
      const listing = JSON.parse(await f.manager.listBrowserTabs(scope, browser));
      expect(listing.connectedBrowsers).toEqual([browser]);
      expect(listing.tabs).toEqual([expect.objectContaining({ browser, tabId: 7,
        inUseByCurrentChat: false, available: true, tabMention: expect.any(String) })]);
      expect(f.router.hasBinding(scope)).toBe(false);
      expect(f.bridge.command).not.toHaveBeenCalled();
      expect(f.embeddedBridge.listTabs).not.toHaveBeenCalled();
      f.noFallback();
    } finally { await f.cleanup(); }
  });

  it.each(['edge', 'chrome'] as const)('selects %s while another browser has the same tab ID and a newer claim', async browser => {
    const f = fixture();
    try {
      const selected = browser === 'edge' ? f.edge : f.chrome;
      expect(await f.manager.callTool(scope, 'browser_snapshot', { targetBrowser: browser }))
        .toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining(selected.title) })]));
      await f.manager.callTool(scope, 'browser_type', { target: 'answer', text: '上海博物馆官网' });
      expect(f.typedValues.get(identity(selected))).toBe('上海博物馆官网');
      expect(f.typedValues.size).toBe(1);
      expect(f.bridge.command.mock.calls.every(([target]) => identity(target) === identity(selected))).toBe(true);
      f.noFallback();
    } finally { await f.cleanup(); }
  });

  it('retains Edge for implicit text, CDP and secure auth while an in-app page is selected', async () => {
    const f = fixture();
    try {
      await f.manager.callTool(scope, 'browser_snapshot', { targetBrowser: 'edge', tabMention: f.reference(f.edge) });
      await f.manager.callTool(scope, 'browser_type', { target: 'answer', text: '上海博物馆官网' });
      expect(JSON.parse(await f.manager.callCdp(scope, 'cdpCall', {
        method: 'Runtime.evaluate', params: { expression: 'document.title' },
      }))).toMatchObject({ result: { value: f.edge.title } });
      expect(JSON.parse(await f.manager.requestBrowserAuth(scope, {
        origin: 'https://www.baidu.com', fields: [],
      }))).toEqual({ status: 'submitted' });
      expect(f.bridge.command.mock.calls.some(([, operation]) => operation === 'cdpCall')).toBe(true);
      expect(f.bridge.command.mock.calls.some(([, operation]) => operation === 'authRequest')).toBe(true);
      expect(f.bridge.command.mock.calls.every(([target]) => identity(target) === identity(f.edge))).toBe(true);
      f.noFallback();
    } finally { await f.cleanup(); }
  });

  it('moves from Edge to the in-app browser and back in one chat, continuing each page', async () => {
    const f = fixture();
    try {
      await f.manager.callTool(scope, 'browser_snapshot', { targetBrowser: 'edge' });
      f.bridge.command.mockClear();
      await f.manager.callTool(scope, 'browser_snapshot', { targetBrowser: 'memmy' });
      expect(f.embeddedRouter.hasBinding(scope)).toBe(true);
      expect(f.router.hasBinding(scope)).toBe(true);
      await f.manager.callTool(scope, 'browser_type', { target: 'answer', text: '内置浏览器页面' });
      expect(f.embeddedBridge.command).toHaveBeenCalledWith(f.embedded, 'type',
        { target: 'answer', text: '内置浏览器页面' });
      expect(f.bridge.command).not.toHaveBeenCalled();
      await f.manager.callTool(scope, 'browser_type', { targetBrowser: 'edge', target: 'answer', text: '继续原Edge页面' });
      expect(f.typedValues.get(identity(f.edge))).toBe('继续原Edge页面');
      await f.manager.callTool(scope, 'browser_type', { target: 'answer', text: '仍在Edge' });
      expect(f.typedValues.get(identity(f.edge))).toBe('仍在Edge');
      expect(f.bridge.command.mock.calls.every(([target]) => identity(target) === identity(f.edge))).toBe(true);
      expect(f.runtimeLoader).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });

  it('moves from the in-app browser to an Edge tab by reference and back to the in-app page', async () => {
    const f = fixture();
    try {
      await f.manager.callTool(scope, 'browser_snapshot', { targetBrowser: 'memmy' });
      expect(f.embeddedRouter.hasBinding(scope)).toBe(true);
      f.embeddedBridge.command.mockClear();
      expect(await f.manager.callTool(scope, 'browser_snapshot', { tabMention: f.reference(f.edge) }))
        .toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining(f.edge.title) })]));
      await f.manager.callTool(scope, 'browser_type', { target: 'answer', text: 'Edge页面' });
      expect(f.typedValues.get(identity(f.edge))).toBe('Edge页面');
      expect(f.embeddedBridge.command).not.toHaveBeenCalled();
      await f.manager.callTool(scope, 'browser_type', { targetBrowser: 'memmy', target: 'answer', text: '回到Memmy页面' });
      expect(f.embeddedRouter.select(scope, false)).toEqual(f.embedded);
      expect(f.embeddedBridge.command).toHaveBeenCalledWith(f.embedded, 'type',
        { target: 'answer', text: '回到Memmy页面' });
      expect(f.typedValues.get(identity(f.edge))).toBe('Edge页面');
      expect(f.runtimeLoader).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });

  it.each(['tool', 'CDP', 'auth'] as const)('does not use Chrome or the selected in-app page when Edge is unavailable for %s', async kind => {
    const f = fixture({ pages: ['chrome'] });
    try {
      const failure = kind === 'tool'
        ? f.manager.callTool(scope, 'browser_snapshot', { targetBrowser: 'edge' })
        : kind === 'CDP' ? f.manager.callCdp(scope, 'cdpCall', { targetBrowser: 'edge',
          method: 'Runtime.evaluate', params: { expression: 'document.title' } })
          : f.manager.requestBrowserAuth(scope, { targetBrowser: 'edge', origin: 'https://www.baidu.com', fields: [] });
      await expect(failure).rejects.toThrow(/edge.*no controllable|edge.*unavailable|not connected/i);
      expect(f.router.hasBinding(scope)).toBe(false);
      expect(f.bridge.command).not.toHaveBeenCalled();
      f.noFallback();
    } finally { await f.cleanup(); }
  });

  it('reports two matching Edge candidates instead of using claim recency, then accepts the exact listed page', async () => {
    const f = fixture({ secondEdge: true });
    try {
      await expect(f.manager.callTool(scope, 'browser_snapshot', { targetBrowser: 'edge' }))
        .rejects.toThrow(/several|ambiguous|multiple/i);
      expect(f.router.hasBinding(scope)).toBe(false);
      expect(f.bridge.command).not.toHaveBeenCalled();
      const listing = JSON.parse(await f.manager.listBrowserTabs(scope, 'edge'));
      const intended = listing.tabs.find((tab: { title: string }) => tab.title === f.edge.title);
      await f.manager.callTool(scope, 'browser_type', { targetBrowser: 'edge',
        tabMention: intended.tabMention, target: 'answer', text: '精确选择的页面' });
      expect(f.typedValues.get(identity(f.edge))).toBe('精确选择的页面');
      expect(f.typedValues.has(identity(f.secondEdge))).toBe(false);
      f.noFallback();
    } finally { await f.cleanup(); }
  });

  it.each(['title', 'url', 'connection', 'closed'] as const)('rejects a listed reference after its %s changes without operating a replacement page', async change => {
    const f = fixture();
    const mention = f.reference(f.edge);
    try {
      if (change === 'title') f.edge.title = 'Changed title';
      else if (change === 'url') f.edge.url = 'https://www.baidu.com/other-page';
      else if (change === 'connection') f.edge.connectionId = 'a'.repeat(24);
      else f.claims.splice(f.claims.indexOf(f.edge), 1);
      await expect(f.manager.callTool(scope, 'browser_snapshot', { targetBrowser: 'edge', tabMention: mention }))
        .rejects.toThrow(/changed|disconnected|stale|no longer/i);
      expect(f.router.hasBinding(scope)).toBe(false);
      expect(f.bridge.command).not.toHaveBeenCalled();
      f.noFallback();
    } finally { await f.cleanup(); }
  });

  it('rejects a Chrome reference paired with targetBrowser Edge', async () => {
    const f = fixture();
    try {
      await expect(f.manager.callTool(scope, 'browser_snapshot', {
        targetBrowser: 'edge', tabMention: f.reference(f.chrome),
      })).rejects.toThrow(/mismatch|invalid|different/i);
      expect(f.router.hasBinding(scope)).toBe(false);
      expect(f.bridge.command).not.toHaveBeenCalled();
      f.noFallback();
    } finally { await f.cleanup(); }
  });

  it.each(['title', 'url'] as const)('rejects a changed live %s even before cached claims receive the page update', async field => {
    const f = fixture();
    try {
      f.bridge.command.mockImplementationOnce(async () => ({ title: f.edge.title,
        url: f.edge.url, [field]: field === 'title' ? 'Different live title' : 'https://www.baidu.com/live-other-page' }));
      await expect(f.manager.callTool(scope, 'browser_snapshot', {
        targetBrowser: 'edge', tabMention: f.reference(f.edge),
      })).rejects.toThrow(/changed|stale/i);
      expect(f.router.hasBinding(scope)).toBe(false);
      expect(f.bridge.command.mock.calls.map(([, operation]) => operation)).toEqual(['tabState']);
      f.noFallback();
    } finally { await f.cleanup(); }
  });

  it.each(['refresh', 'reference'] as const)('does not bind or operate Edge when a delayed %s resolves after its turn ended', async kind => {
    const f = fixture();
    const result = deferred<unknown>();
    const started = deferred<void>();
    if (kind === 'refresh') {
      f.bridge.refreshTabs.mockImplementationOnce(async () => {
        started.resolve(); await result.promise; return undefined;
      });
    } else {
      const command = f.bridge.command.getMockImplementation()!;
      f.bridge.command.mockImplementationOnce(async (target, operation, args) => {
        if (operation === 'tabState') { started.resolve(); return result.promise; }
        return command(target, operation, args);
      });
    }
    try {
      const pending = f.manager.callTool(scope, 'browser_snapshot', { targetBrowser: 'edge',
        ...(kind === 'reference' ? { tabMention: f.reference(f.edge) } : {}) });
      const rejected = expect(pending).rejects.toThrow(/turn|cancel|changed|ended|finished/i);
      await started.promise;
      await f.manager.closeSurfacesForTurn(scope);
      result.resolve({ title: f.edge.title, url: f.edge.url, origin: new URL(f.edge.url).origin });
      await rejected;
      expect(f.router.hasBinding(scope)).toBe(false);
      expect(f.bridge.command.mock.calls.every(([, operation]) => operation === 'tabState')).toBe(true);
      f.noFallback();
    } finally { result.resolve(undefined); await f.cleanup(); }
  });

  it('follows a tab opened from the bound tab, keeps saved files, and shows the original tab again', async () => {
    const f = fixture({ secondEdge: true, secondEdgeOpenedFromFirst: true });
    try {
      await f.manager.callTool(scope, 'browser_snapshot', { targetBrowser: 'edge', tabMention: f.reference(f.edge) });
      const shot = await f.manager.callTool(scope, 'browser_take_screenshot', { targetBrowser: 'edge' }) as Array<{ text?: string }>;
      const saved = String(shot[0].text).replace('Screenshot saved to ', '');
      expect(fs.existsSync(saved)).toBe(true);
      expect(await f.manager.callTool(scope, 'browser_snapshot', { targetBrowser: 'edge', tabMention: f.reference(f.secondEdge) }))
        .toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining(f.secondEdge.title) })]));
      expect(fs.existsSync(saved)).toBe(true);
      expect(JSON.parse(await f.manager.selectBrowserTab(scope, { targetBrowser: 'edge', tabMention: f.reference(f.edge) })))
        .toMatchObject({ selected: true, title: f.edge.title, url: f.edge.url });
      expect(f.bridge.command.mock.calls.some(([target, operation]) =>
        identity(target) === identity(f.edge) && operation === 'activate')).toBe(true);
      await f.manager.callTool(scope, 'browser_type', { target: 'answer', text: '回到结果页' });
      expect(f.typedValues.get(identity(f.edge))).toBe('回到结果页');
      f.noFallback();
    } finally { await f.cleanup(); }
  });

  it('works in two unrelated Edge tabs in one chat and switches between them', async () => {
    const f = fixture({ secondEdge: true });
    try {
      await f.manager.callTool(scope, 'browser_snapshot', { targetBrowser: 'edge', tabMention: f.reference(f.edge) });
      await f.manager.callTool(scope, 'browser_type', { targetBrowser: 'edge', target: 'answer', text: '第一个标签' });
      expect(await f.manager.callTool(scope, 'browser_snapshot', { targetBrowser: 'edge', tabMention: f.reference(f.secondEdge) }))
        .toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining(f.secondEdge.title) })]));
      await f.manager.callTool(scope, 'browser_type', { targetBrowser: 'edge', target: 'answer', text: '第二个标签' });
      expect(JSON.parse(await f.manager.selectBrowserTab(scope, { targetBrowser: 'edge', tabMention: f.reference(f.edge) })))
        .toMatchObject({ selected: true, title: f.edge.title });
      await f.manager.callTool(scope, 'browser_type', { targetBrowser: 'edge', target: 'answer', text: '回到第一个' });
      expect(f.typedValues.get(identity(f.edge))).toBe('回到第一个');
      expect(f.typedValues.get(identity(f.secondEdge))).toBe('第二个标签');
      const listing = JSON.parse(await f.manager.listBrowserTabs(scope, 'edge'));
      expect(listing.tabs.map((tab: { inUseByCurrentChat: boolean }) => tab.inUseByCurrentChat)).toEqual([true, true]);
      f.noFallback();
    } finally { await f.cleanup(); }
  });

  it('opens a new Edge tab beside the chat tab and keeps working in both', async () => {
    const f = fixture();
    try {
      await f.manager.callTool(scope, 'browser_snapshot', { targetBrowser: 'edge' });
      const result = await f.manager.callTool(scope, 'browser_navigate',
        { url: 'https://www.baidu.com/s?wd=compare', newTab: true }) as Array<{ text: string }>;
      expect(JSON.parse(result[0].text)).toMatchObject({ newTab: true, browser: 'edge',
        url: 'https://www.baidu.com/s?wd=compare', tabMention: expect.stringContaining('plugin://') });
      expect(f.bridge.openBrowserTab).toHaveBeenCalledWith('edge', 'https://www.baidu.com/s?wd=compare',
        { connectionId: f.edge.connectionId, tabId: f.edge.tabId });
      await f.manager.callTool(scope, 'browser_type', { target: 'answer', text: '新标签里输入' });
      expect(f.typedValues.get(`${f.edge.connectionId}:30`)).toBe('新标签里输入');
      await f.manager.callTool(scope, 'browser_type', { targetBrowser: 'edge', tabMention: f.reference(f.edge),
        target: 'answer', text: '回到原标签' });
      expect(f.typedValues.get(identity(f.edge))).toBe('回到原标签');
      f.noFallback();
    } finally { await f.cleanup(); }
  });

  it('takes over a tab another chat used once that chat finished its turn', async () => {
    const f = fixture();
    try {
      f.router.selectClaim(otherScope, f.edge);
      await expect(f.manager.callTool(scope, 'browser_snapshot', { targetBrowser: 'edge', tabMention: f.reference(f.edge) }))
        .rejects.toThrow(/in use by another chat/i);
      await f.manager.closeSurfacesForTurn(otherScope);
      const listing = JSON.parse(await f.manager.listBrowserTabs(scope, 'edge'));
      expect(listing.tabs[0]).toMatchObject({ available: true, inUseByCurrentChat: false });
      await f.manager.callTool(scope, 'browser_type', { targetBrowser: 'edge', tabMention: f.reference(f.edge),
        target: 'answer', text: '接手后的输入' });
      expect(f.typedValues.get(identity(f.edge))).toBe('接手后的输入');
      expect(f.router.hasBinding(otherScope)).toBe(false);
      f.noFallback();
    } finally { await f.cleanup(); }
  });

  it.each(['edge', undefined] as const)('offers the extension setup link when %s has no connected extension', async browser => {
    const f = fixture({ pages: [] });
    try {
      const listing = JSON.parse(await f.manager.listBrowserTabs(scope, browser));
      expect(listing.extensionSetup).toMatchObject({ notConnected: browser ? [browser] : ['chrome', 'edge'],
        settingsLink: 'memmy://settings/browser-extension' });
      const connected = fixture();
      try {
        expect(JSON.parse(await connected.manager.listBrowserTabs(scope, browser)).extensionSetup).toBeUndefined();
      } finally { await connected.cleanup(); }
    } finally { await f.cleanup(); }
  });

  it('does not follow into a related tab that another chat is using', async () => {
    const f = fixture({ secondEdge: true, secondEdgeOpenedFromFirst: true });
    try {
      await f.manager.callTool(scope, 'browser_snapshot', { targetBrowser: 'edge', tabMention: f.reference(f.edge) });
      f.router.selectClaim(otherScope, f.secondEdge);
      await expect(f.manager.selectBrowserTab(scope, { targetBrowser: 'edge', tabMention: f.reference(f.secondEdge) }))
        .rejects.toThrow(/in use by another chat/i);
      expect(f.router.select(scope, false)).toEqual(f.edge);
    } finally { await f.cleanup(); }
  });

  it('refreshes once when the bound tab is briefly missing, then continues it', async () => {
    const f = fixture();
    try {
      await f.manager.callTool(scope, 'browser_snapshot', { targetBrowser: 'edge' });
      const index = f.claims.indexOf(f.edge);
      f.claims.splice(index, 1);
      f.bridge.refreshTabs.mockImplementationOnce(async () => { f.claims.splice(index, 0, f.edge); });
      await f.manager.callTool(scope, 'browser_type', { targetBrowser: 'edge', target: 'answer', text: '恢复后继续' });
      expect(f.typedValues.get(identity(f.edge))).toBe('恢复后继续');
      f.noFallback();
    } finally { await f.cleanup(); }
  });

  it('exposes an occupied tab but refuses to replace it with another available Edge tab', async () => {
    const f = fixture({ secondEdge: true });
    try {
      f.router.selectClaim(otherScope, f.edge);
      const listing = JSON.parse(await f.manager.listBrowserTabs(scope, 'edge'));
      const intended = listing.tabs.find((tab: { title: string }) => tab.title === f.edge.title);
      expect(intended).toMatchObject({ available: false, inUseByCurrentChat: false });
      expect(JSON.stringify(intended)).not.toContain(otherScope.chatId);
      await expect(f.manager.callTool(scope, 'browser_snapshot', {
        targetBrowser: 'edge', tabMention: intended.tabMention,
      })).rejects.toThrow(/in use by another chat/i);
      expect(f.router.hasBinding(scope)).toBe(false);
      expect(f.bridge.command).not.toHaveBeenCalled();
      expect(f.typedValues.size).toBe(0);
      f.noFallback();
    } finally { await f.cleanup(); }
  });
});
