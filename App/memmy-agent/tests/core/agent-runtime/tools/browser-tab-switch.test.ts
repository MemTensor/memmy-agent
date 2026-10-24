import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatEmbeddedBrowserTabMention } from '@memmy/local-api-contracts';
import { describe, expect, it, vi } from 'vitest';
import { BrowserSessionManager, type BrowserScope } from '../../../../src/core/agent-runtime/tools/browser.js';
import type { EmbeddedBrowserBridge } from '../../../../src/core/agent-runtime/tools/embedded-browser-bridge.js';
import type { ExternalBrowserClaim } from '../../../../src/core/agent-runtime/tools/external-browser-bridge.js';
import { ExternalBrowserSessionRouter } from '../../../../src/core/agent-runtime/tools/external-browser-session-router.js';
import { BrowserUseSitePolicyReader } from '../../../../src/core/agent-runtime/tools/browser-use-site-policy-store.js';

const scope: BrowserScope = { sessionKey: 'ordinary-browser-chat', channel: 'projected-session',
  chatId: 'ordinary-browser-chat' };
const endedTurn = /turn|cancel|changed|ended|stale/i;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-tab-switch-integration-'));
  const browserId = 'same-open-memmy-browser';
  const claims: ExternalBrowserClaim[] = ['A', 'B'].map((name, index) => ({
    connectionId: `memmy-webview:${browserId}`, tabId: index + 4, browser: 'memmy',
    title: `Memmy browser linkage test · tab ${name}`,
    url: `http://127.0.0.1:43210/?tab=${name}`, claimedAt: index + 1,
  }));
  const [a, b] = claims;
  // The user keeps B in front throughout. Resolving A must not change selection.
  const selectedTabId = b.tabId;
  const pages = new Map(claims.map(claim => [claim.tabId, {
    challenge: claim === a ? 'A-ABC123' : 'B-DEF456', value: '', verified: false, count: 0,
  }]));
  const mentions = new Map(claims.map(claim => [formatEmbeddedBrowserTabMention({
    browserId, tabId: claim.tabId, title: claim.title, url: claim.url,
  }), claim]));
  const bridge = {
    refresh: vi.fn(async (): Promise<ExternalBrowserClaim | null> => b),
    listTabs: vi.fn(async () => ({ browserId, selectedTabId,
      tabs: claims.map(claim => ({ tabId: claim.tabId, title: claim.title, url: claim.url,
        tabMention: [...mentions].find(([, value]) => value === claim)![0] })) })),
    resolveMention: vi.fn(async (mention: string) => {
      const claim = mentions.get(mention);
      if (!claim) throw new Error('Invalid or stale browser tab reference');
      return claim;
    }),
    listClaims: () => [b],
    getClaim: (identity: Pick<ExternalBrowserClaim, 'connectionId' | 'tabId'>) =>
      claims.find(claim => claim.connectionId === identity.connectionId && claim.tabId === identity.tabId) ?? null,
    command: vi.fn(async (claim: Pick<ExternalBrowserClaim, 'connectionId' | 'tabId'>,
      operation: string, args: Record<string, unknown> = {}): Promise<unknown> => {
      const page = pages.get(claim.tabId);
      if (!page) throw new Error('Tab is no longer open');
      if (operation === 'snapshot') return { nodes: [
        { ref: 'challenge', role: 'text', name: page.challenge },
        { ref: 'answer', role: 'textbox', value: page.value },
        { ref: 'verified', role: 'text', name: page.verified ? 'Verified' : 'Unverified' },
        { ref: 'count', role: 'text', name: `Count: ${page.count}` },
      ] };
      if (operation === 'type') page.value = String(args.text ?? '');
      if (operation === 'click' && args.target === 'verify') page.verified = page.value === page.challenge;
      if (operation === 'click' && args.target === 'increment') page.count++;
      if (operation === 'authRequest') return { status: 'completed' };
      return { ok: true };
    }),
    close: vi.fn(),
  };
  const authorize = vi.fn(async (url: string, allowed: Set<string>) => {
    allowed.add(new URL(url).origin);
    return true;
  });
  const router = new ExternalBrowserSessionRouter(bridge, authorize, 'embedded',
    new BrowserUseSitePolicyReader(path.join(directory, 'site-policy.json')));
  const external = { select: vi.fn(() => null), call: vi.fn(), cdp: vi.fn(), upload: vi.fn(),
    closeSurfacesForTurn: vi.fn(), closeAll: vi.fn() };
  const runtimeLoader = vi.fn(async () => { throw new Error('Must not launch a separate Chromium'); });
  const manager = new BrowserSessionManager({ enabled: true }, { desktopManaged: true,
    embeddedBridge: bridge as unknown as EmbeddedBrowserBridge, embeddedRouter: router,
    externalRouter: external as unknown as ExternalBrowserSessionRouter, runtimeLoader,
    profileStore: null, downloadStore: null, sitePermissionStore: null, accessApproval: null });
  async function aReference() {
    const listing = JSON.parse(await manager.listEmbeddedTabs());
    const target = listing.tabs.find((tab: { title: string }) => tab.title.endsWith('tab A'));
    expect(target).toMatchObject({ tabId: a.tabId, url: a.url });
    expect(listing.selectedTabId).toBe(b.tabId);
    return target.tabMention as string;
  }
  async function cleanup() {
    await manager.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
  function noFallback() {
    expect(external.select).not.toHaveBeenCalled();
    expect(external.call).not.toHaveBeenCalled();
    expect(external.cdp).not.toHaveBeenCalled();
    expect(external.upload).not.toHaveBeenCalled();
    expect(runtimeLoader).not.toHaveBeenCalled();
  }
  return { a, b, bridge, authorize, router, manager, pages, aReference, cleanup, noFallback };
}

describe('ordinary in-app browser tab changes across Agent turns', () => {
  it('operates B, then discovers and operates A in the same chat while leaving B in front and unchanged', async () => {
    const f = fixture();
    try {
      await f.manager.callTool(scope, 'browser_type', { target: 'answer', text: 'B-DEF456' });
      await f.manager.callTool(scope, 'browser_click', { target: 'verify' });
      for (let index = 0; index < 3; index++) {
        await f.manager.callTool(scope, 'browser_click', { target: 'increment' });
      }
      expect(f.pages.get(f.b.tabId)).toMatchObject({ verified: true, count: 3 });
      await f.manager.closeSurfacesForTurn(scope);
      const bCommands = f.bridge.command.mock.calls.filter(([claim]) => claim.tabId === f.b.tabId);

      // The Agent obtains this exact reference from its own tab inventory tool;
      // the user only asks to operate A and does not copy a plugin URL.
      const tabMention = await f.aReference();
      expect(await f.manager.callTool(scope, 'browser_snapshot', { tabMention }))
        .toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('A-ABC123') })]));
      await f.manager.callTool(scope, 'browser_type', { target: 'answer', text: 'A-ABC123' });
      await f.manager.callTool(scope, 'browser_click', { target: 'verify' });
      for (let index = 0; index < 3; index++) {
        await f.manager.callTool(scope, 'browser_click', { target: 'increment' });
      }
      expect(await f.manager.callTool(scope, 'browser_snapshot', {}))
        .toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('Count: 3') })]));
      expect(f.pages.get(f.a.tabId)).toEqual({ challenge: 'A-ABC123', value: 'A-ABC123', verified: true, count: 3 });
      expect(f.pages.get(f.b.tabId)).toEqual({ challenge: 'B-DEF456', value: 'B-DEF456', verified: true, count: 3 });
      expect(f.bridge.command.mock.calls.filter(([claim]) => claim.tabId === f.b.tabId)).toEqual(bCommands);
      expect(f.router.select(scope, false)).toEqual(f.a);
      expect(JSON.parse(await f.manager.listEmbeddedTabs())).toMatchObject({ selectedTabId: f.b.tabId, count: 2 });
      expect(f.bridge.command.mock.calls.some(([, operation]) =>
        ['closeTab', 'openTab', 'activateTab', 'screenshot', 'navigate'].includes(operation))).toBe(false);
      f.noFallback();
    } finally { await f.cleanup(); }
  });

  it('switches tabs within one turn and keeps implicit calls on the chosen tab rather than the front tab', async () => {
    const f = fixture();
    try {
      await f.manager.callTool(scope, 'browser_type', { target: 'answer', text: 'B-DEF456' });
      const tabMention = await f.aReference();
      expect(await f.manager.callTool(scope, 'browser_snapshot', { tabMention }))
        .toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('A-ABC123') })]));
      await f.manager.callTool(scope, 'browser_type', { target: 'answer', text: 'A-ABC123' });
      expect(f.router.select(scope, false)).toEqual(f.a);
      expect(f.pages.get(f.a.tabId)?.value).toBe('A-ABC123');
      expect(f.pages.get(f.b.tabId)?.value).toBe('B-DEF456');
      await f.manager.closeSurfacesForTurn(scope);
      // B is still selected, but implicit follow-up remains on explicitly chosen A.
      await f.manager.callTool(scope, 'browser_snapshot', {});
      expect(f.router.select(scope, false)).toEqual(f.a);
      f.noFallback();
    } finally { await f.cleanup(); }
  });

  it.each(['tool', 'CDP', 'auth'] as const)('discards a %s mention resolution that completes after its turn ended', async kind => {
    const f = fixture();
    const result = deferred<ExternalBrowserClaim>();
    const started = deferred<void>();
    const select = vi.spyOn(f.router, 'selectClaim');
    const mark = vi.spyOn(f.router, 'markTab');
    f.bridge.resolveMention.mockImplementationOnce(async () => { started.resolve(); return result.promise; });
    try {
      const oldCall = kind === 'tool'
        ? f.manager.callTool(scope, 'browser_snapshot', { tabMention: 'pending-reference', tabDisposition: 'handoff' })
        : kind === 'CDP'
          ? f.manager.callCdp(scope, 'cdpCall', { tabMention: 'pending-reference', method: 'Runtime.evaluate',
            params: { expression: 'document.title' } })
          : f.manager.requestBrowserAuth(scope, { tabMention: 'pending-reference' });
      const cancelled = expect(oldCall).rejects.toThrow(endedTurn);
      await started.promise;
      await f.manager.closeSurfacesForTurn(scope);
      result.resolve(f.b);
      await cancelled;
      expect(select).not.toHaveBeenCalled();
      expect(mark).not.toHaveBeenCalled();
      expect(f.router.hasBinding(scope)).toBe(false);
      expect(f.bridge.command).not.toHaveBeenCalled();
      await f.manager.callTool(scope, 'browser_snapshot', { tabMention: await f.aReference() });
      expect(f.router.select(scope, false)).toEqual(f.a);
      f.noFallback();
    } finally { result.resolve(f.b); await f.cleanup(); }
  });

  it.each(['tool', 'CDP', 'auth'] as const)('does not let a late %s refresh fall through to another browser after turn cleanup', async kind => {
    const f = fixture();
    const result = deferred<ExternalBrowserClaim | null>();
    const started = deferred<void>();
    const select = vi.spyOn(f.router, 'select');
    f.bridge.refresh.mockImplementationOnce(async () => { started.resolve(); return result.promise; });
    try {
      const oldCall = kind === 'tool' ? f.manager.callTool(scope, 'browser_snapshot', {})
        : kind === 'CDP' ? f.manager.callCdp(scope, 'cdpCall', { method: 'Runtime.evaluate',
          params: { expression: 'document.title' } })
        : f.manager.requestBrowserAuth(scope, {});
      const cancelled = expect(oldCall).rejects.toThrow(endedTurn);
      await started.promise;
      await f.manager.closeSurfacesForTurn(scope);
      result.resolve(null);
      await cancelled;
      expect(select).not.toHaveBeenCalled();
      expect(f.router.hasBinding(scope)).toBe(false);
      expect(f.bridge.command).not.toHaveBeenCalled();
      f.noFallback();
    } finally { result.resolve(null); await f.cleanup(); }
  });

  it('discards a late auth response and leaves the next turn on A', async () => {
    const f = fixture();
    const result = deferred<{ status: string }>();
    const started = deferred<void>();
    const command = f.bridge.command.getMockImplementation()!;
    try {
      await f.manager.callTool(scope, 'browser_snapshot', {});
      f.bridge.command.mockImplementation(async (claim, operation, args) => {
        if (operation === 'authRequest') { started.resolve(); return result.promise; }
        return command(claim, operation, args);
      });
      const cancelled = expect(f.manager.requestBrowserAuth(scope, {})).rejects.toThrow(endedTurn);
      await started.promise;
      await f.manager.closeSurfacesForTurn(scope);
      await f.manager.callTool(scope, 'browser_snapshot', { tabMention: await f.aReference() });
      result.resolve({ status: 'completed' });
      await cancelled;
      expect(f.router.select(scope, false)).toEqual(f.a);
      expect(f.bridge.command.mock.calls.filter(([, operation]) => operation === 'authRequest'))
        .toEqual([[f.b, 'authRequest', {}, undefined]]);
      f.noFallback();
    } finally { result.resolve({ status: 'completed' }); await f.cleanup(); }
  });

  it('does not mark a handoff or return a delayed old result after turn cleanup, even before rebinding', async () => {
    const f = fixture();
    const result = deferred<{ nodes: Array<{ role: string; name: string }> }>();
    const started = deferred<void>();
    const mark = vi.spyOn(f.router, 'markTab');
    const command = f.bridge.command.getMockImplementation()!;
    try {
      f.bridge.command.mockImplementation(async (claim, operation, args) => {
        if (operation === 'snapshot') { started.resolve(); return result.promise; }
        return command(claim, operation, args);
      });
      const cancelled = expect(f.manager.callTool(scope, 'browser_snapshot', { tabDisposition: 'handoff' }))
        .rejects.toThrow(endedTurn);
      await started.promise;
      await f.manager.closeSurfacesForTurn(scope);
      result.resolve({ nodes: [{ role: 'text', name: 'Old turn result must not return' }] });
      await cancelled;
      expect(mark).not.toHaveBeenCalled();
      f.bridge.command.mockImplementation(command);
      await f.manager.callTool(scope, 'browser_snapshot', { tabMention: await f.aReference() });
      expect(f.router.select(scope, false)).toEqual(f.a);
      f.noFallback();
    } finally { result.resolve({ nodes: [] }); await f.cleanup(); }
  });
});
