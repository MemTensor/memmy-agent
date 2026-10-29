import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExternalBrowserSessionRouter } from "../../../../src/core/agent-runtime/tools/external-browser-session-router.js";
import { BrowserUseSitePolicyReader } from '../../../../src/core/agent-runtime/tools/browser-use-site-policy-store.js';
import { BrowserAccessApproval } from '../../../../src/core/agent-runtime/tools/browser-access-approval.js';
import { BrowserCapabilityApproval } from '../../../../src/core/agent-runtime/tools/browser-capability-approval.js';
import type { ExternalBrowserBridge, ExternalBrowserClaim } from "../../../../src/core/agent-runtime/tools/external-browser-bridge.js";
import * as surfaces from '../../../../src/tools/computer-use/surface-preview.js';

const scopeA = { sessionKey: "a", channel: "projected-session", chatId: "a" };
const scopeB = { sessionKey: "b", channel: "projected-session", chatId: "b" };
const claim: ExternalBrowserClaim = {
  connectionId: "connection", tabId: 9, browser: "edge",
  title: "Test", url: "https://example.test/", claimedAt: 1,
};

function fakeBridge(claims: ExternalBrowserClaim[] = [claim]) {
  const refresh = vi.fn(async (): Promise<ExternalBrowserClaim | null> => null);
  const command = vi.fn(async (_claim: unknown, operation: string) => {
    if (operation === "viewport") return { width: 1000, height: 600 };
    if (operation === "screenshot") return { format: "jpeg", data: "AAA" };
    if (operation === "historyState") return { canGoBack: false, canGoForward: false };
    return {};
  });
  return { listClaims: () => claims, refresh,
    getClaim: (identity: { connectionId: string; tabId: number }) => claims.find(item =>
      item.connectionId === identity.connectionId && item.tabId === identity.tabId) ?? null,
    command } as unknown as ExternalBrowserBridge & { refresh: typeof refresh };
}

function bindingOf(router: ExternalBrowserSessionRouter, scope: typeof scopeA, tab: ExternalBrowserClaim) {
  return (router as any).chats.get(JSON.stringify(Object.values(scope)))?.tabs.get(`${tab.connectionId}:${tab.tabId}`);
}

describe("external browser session router", () => {
  it('reports an unresponsive refresh without losing connection facts or offering stale pages', async () => {
    const bridge = fakeBridge();
    Object.assign(bridge, { refreshTabs: vi.fn(async () => { throw new Error('Browser extension page refresh timed out'); }),
      listConnected: () => ['edge'] });
    const router = new ExternalBrowserSessionRouter(bridge, async () => true);
    try {
      const listing = await router.listTabs(scopeA, 'edge');
      expect(listing).toMatchObject({ pageDiscoveryStatus: 'unresponsive', connectedBrowsers: ['edge'], tabs: [] });
      expect(bridge.listClaims()).toEqual([claim]);
      expect(router.hasBinding(scopeA)).toBe(false);
      Object.assign(bridge, { refreshTabs: vi.fn(async () => { throw new Error('unexpected bridge error'); }) });
      await expect(router.listTabs(scopeA, 'edge')).rejects.toThrow('unexpected bridge error');
    } finally { router.closeAll(); }
  });

  it('waits for the requested browser without binding or claiming a page', async () => {
    const bridge = fakeBridge([]);
    const waitForConnection = vi.fn(async () => true);
    Object.assign(bridge, { waitForConnection });
    const router = new ExternalBrowserSessionRouter(bridge, async () => true);
    const signal = new AbortController().signal;
    try {
      await expect(router.waitForConnection('chrome', 45_000, signal)).resolves.toBe(true);
      expect(waitForConnection).toHaveBeenCalledExactlyOnceWith('chrome', 45_000, signal);
      expect(router.hasBinding(scopeA)).toBe(false);
      expect(router.hasBinding(scopeB)).toBe(false);
    } finally { router.closeAll(); }
  });

  it.each(['website', 'computer'] as const)('applies %s allow-all and revocation to raw CDP attached cross-site iframe targets', async source => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-child-cdp-policy-'));
    const reader = new BrowserUseSitePolicyReader(path.join(directory, 'site-policy.json'), {
      nativeAllowAllFilePath: path.join(directory, 'allow-all-apps.json'),
    });
    fs.writeFileSync(reader.filePath, JSON.stringify({ version: 1, rules: [
      { pattern: 'https://example.test', access: 'allow', downloads: 'ask', uploads: 'ask', fullCdp: 'allow' },
      { pattern: 'https://frame.test', access: 'block', downloads: 'block', uploads: 'block', fullCdp: 'block' },
    ] }));
    const approvedTarget = { sessionId: 'child-session', targetId: 'child-target',
      url: 'https://frame.test/private', origin: 'https://frame.test', revision: 1 };
    const bridge = fakeBridge();
    const command = vi.fn(async (_bound: unknown, operation: string) => {
      if (operation === 'tabState') return { url: claim.url, origin: 'https://example.test' };
      if (operation === 'cdpTarget') return approvedTarget;
      return {};
    });
    bridge.command = command;
    const access = new BrowserAccessApproval(path.join(directory, 'access.json'), reader);
    const prompt = vi.spyOn(access as any, 'requestDecision').mockResolvedValue('deny');
    const capability = new BrowserCapabilityApproval(reader);
    const router = new ExternalBrowserSessionRouter(bridge, (url, grants) => access.authorize(url, grants), 'external', reader);
    router.selectClaim(scopeA, claim);
    const run = () => router.cdp(scopeA, claim, 'cdpCall', { method: 'Page.getLayoutMetrics',
      target: { sessionId: 'child-session' } }, (url, method) => capability.authorize('debug', url, [method]));
    try {
      await expect(run()).rejects.toThrow(/child target site was not approved/);
      expect(command.mock.calls.some(call => call[1] === 'cdpCall')).toBe(false);
      const globalPath = source === 'website' ? reader.allowAllFilePath : reader.nativeAllowAllFilePath!;
      fs.writeFileSync(globalPath, JSON.stringify({ version: 1, enabled: true }));
      await expect(run()).resolves.toBe('{}');
      expect(bridge.command).toHaveBeenCalledWith(claim, 'cdpCall', expect.objectContaining({ approvedTarget }), undefined);
      expect(prompt).not.toHaveBeenCalled();
      command.mockClear();
      fs.writeFileSync(globalPath, JSON.stringify({ version: 1, enabled: false }));
      await expect(run()).rejects.toThrow(/child target site was not approved/);
      expect(command.mock.calls.some(call => call[1] === 'cdpCall')).toBe(false);
    } finally { router.closeAll(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('clears only the bound in-app download destination after page access is revoked without asking again', async () => {
    const current = { ...claim, browser: 'memmy' as const };
    const bridge = fakeBridge([current]);
    const authorize = vi.fn(async () => true);
    const router = new ExternalBrowserSessionRouter(bridge, authorize, 'embedded');
    try {
      router.selectClaim(scopeA, current);
      await router.setDownloadDestination(scopeA, current, '/private/output.txt', 'request-a');
      expect(authorize).toHaveBeenCalledOnce();
      authorize.mockResolvedValue(false);
      await router.setDownloadDestination(scopeA, current, null, 'request-a');
      expect(authorize).toHaveBeenCalledOnce();
      expect(bridge.command).toHaveBeenCalledWith(current, 'setDownloadDestination',
        { filePath: null, destinationId: 'request-a' }, undefined);
      router.closeSession(scopeA);
      await expect(router.setDownloadDestination(scopeA, current, null, 'request-a')).rejects.toThrow(/changed/);
    } finally { router.closeAll(); }
  });

  it.each(['memmy', 'chrome', 'edge'] as const)('uses the shared website gate for %s and revalidates global revocation', async browser => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-shared-access-'));
    const current = { ...claim, browser };
    const bridge = fakeBridge([current]);
    const reader = new BrowserUseSitePolicyReader(path.join(directory, 'site-policy.json'));
    const access = new BrowserAccessApproval(path.join(directory, 'access.json'), reader);
    const prompt = vi.spyOn(access as any, 'requestDecision').mockResolvedValue('deny');
    const router = new ExternalBrowserSessionRouter(bridge,
      (url, allowed) => access.authorize(url, allowed), browser === 'memmy' ? 'embedded' : 'external', reader);
    try {
      router.selectClaim(scopeA, current);
      expect(bindingOf(router, scopeA, current).allowedOrigins.size).toBe(0);
      await expect(router.call(scopeA, current, 'browser_snapshot', {})).rejects.toThrow(/not approved/);
      expect(prompt).toHaveBeenCalledOnce();
      expect(bridge.command).not.toHaveBeenCalled();
      fs.writeFileSync(reader.allowAllFilePath, JSON.stringify({ version: 1, enabled: true }));
      await expect(router.call(scopeA, current, 'browser_snapshot', {})).resolves.toBeDefined();
      expect(prompt).toHaveBeenCalledOnce();
      (bridge.command as ReturnType<typeof vi.fn>).mockClear();
      fs.writeFileSync(reader.allowAllFilePath, JSON.stringify({ version: 1, enabled: false }));
      await expect(router.call(scopeA, current, 'browser_click', { target: 'ax-1' })).rejects.toThrow(/not approved/);
      expect(prompt).toHaveBeenCalledTimes(2);
      expect(bridge.command).not.toHaveBeenCalled();
      expect(bindingOf(router, scopeA, current).allowedOrigins.size).toBe(0);
    } finally { router.closeAll(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('rejects in-app screenshot tools and CDP before site approval or any browser command', async () => {
    const current = { ...claim, browser: 'memmy' as const };
    const bridge = fakeBridge([current]);
    const authorize = vi.fn(async () => true);
    const debugApproval = vi.fn(async () => true);
    const router = new ExternalBrowserSessionRouter(bridge, authorize, 'embedded');
    try {
      router.selectClaim(scopeA, current);
      await expect(router.call(scopeA, current, 'browser_take_screenshot', {}))
        .rejects.toThrow(/not supported.*browser_snapshot/);
      await expect(router.cdp(scopeA, current, 'cdpCall', { method: 'Page.captureScreenshot' }, debugApproval))
        .rejects.toThrow(/not supported.*browser_snapshot/);
      expect(authorize).not.toHaveBeenCalled();
      expect(debugApproval).not.toHaveBeenCalled();
      expect(bridge.command).not.toHaveBeenCalled();
      expect(router.select(scopeA, false)).toEqual(current);
    } finally { router.closeAll(); }
  });

  it('recovers a disconnected in-app binding only from a fresh explicit claim and resets its grants and files', async () => {
    const original = { ...claim, browser: 'memmy' as const };
    const replacement = { ...original, tabId: 18 };
    const claims = [original];
    const bridge = fakeBridge(claims);
    const allowedAtApproval: string[][] = [];
    const authorize = vi.fn(async (url: string, allowed: Set<string>) => {
      allowedAtApproval.push([...allowed]);
      allowed.add(new URL(url).origin);
      return true;
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'embedded-binding-recovery-'));
    const router = new ExternalBrowserSessionRouter(bridge, authorize, 'embedded',
      new BrowserUseSitePolicyReader(path.join(directory, 'site-policy.json')));
    const publish = vi.spyOn(surfaces, 'emitComputerUseSurface');
    try {
      router.selectClaim(scopeA, original, { agentCreated: true });
      router.markTab(scopeA, 'handoff');
      await router.call(scopeA, original, 'browser_snapshot', {});
      const oldDirectory = bindingOf(router, scopeA, original).outputDir;
      const oldFile = path.join(oldDirectory, 'owned-session-output.txt');
      fs.writeFileSync(oldFile, 'old session output');
      expect(fs.existsSync(oldFile)).toBe(true);
      publish.mockClear();
      (bridge.command as ReturnType<typeof vi.fn>).mockClear();
      claims.splice(0, 1, replacement);
      expect(() => router.select(scopeA, false)).toThrow(/Memmy in-app.*closed or replaced.*browser_list_tabs/);
      expect(bridge.command).not.toHaveBeenCalled();
      expect(fs.existsSync(oldFile)).toBe(true);
      expect(router.selectClaim(scopeA, replacement)).toEqual(replacement);
      expect(fs.existsSync(path.dirname(oldFile))).toBe(false);
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({ ...scopeA,
        targetId: 'embedded:connection:9', close: true }));
      await router.call(scopeA, replacement, 'browser_snapshot', {});
      expect(allowedAtApproval).toEqual([[], []]);
      expect(bridge.command).toHaveBeenCalledWith(replacement, 'allowOrigin', { origin: 'https://example.test' });
      expect(bridge.command).toHaveBeenCalledWith(replacement, 'snapshot', {});
      await router.finishTurn(scopeA);
      expect(router.hasBinding(scopeA)).toBe(true);
      expect((bridge.command as ReturnType<typeof vi.fn>).mock.calls.some(call => call[1] === 'closeTab')).toBe(false);
    } finally { router.closeAll(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('works with several in-app tabs in one turn and returns to each one', () => {
    const original = { ...claim, browser: 'memmy' as const };
    const other = { ...original, tabId: 18 };
    const bridge = fakeBridge([original, other]);
    const router = new ExternalBrowserSessionRouter(bridge, async () => true, 'embedded');
    try {
      router.selectClaim(scopeA, original);
      expect(router.selectClaim(scopeA, other)).toEqual(other);
      expect(router.select(scopeA, false)).toEqual(other);
      expect(router.selectClaim(scopeA, original)).toEqual(original);
      expect(router.select(scopeA, false)).toEqual(original);
      expect(() => router.selectClaim(scopeB, other)).toThrow(/in use by another chat/);
      expect(bridge.command).not.toHaveBeenCalled();
    } finally { router.closeAll(); }
  });

  it('keeps grants, files and disposition separate for each in-app tab a chat uses', async () => {
    const original = { ...claim, browser: 'memmy' as const };
    const replacement = { ...original, tabId: 18 };
    const bridge = fakeBridge([original, replacement]);
    const grants: string[][] = [];
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'embedded-live-switch-'));
    const router = new ExternalBrowserSessionRouter(bridge, async (url, allowed) => {
      grants.push([...allowed]); allowed.add(new URL(url).origin); return true;
    }, 'embedded', new BrowserUseSitePolicyReader(path.join(directory, 'site-policy.json')));
    const publish = vi.spyOn(surfaces, 'emitComputerUseSurface');
    try {
      router.selectClaim(scopeA, original, { agentCreated: true });
      await router.call(scopeA, original, 'browser_snapshot', {});
      router.markTab(scopeA, 'handoff', original);
      const oldBinding = bindingOf(router, scopeA, original);
      const oldFile = path.join(oldBinding.outputDir, 'old-output.txt');
      fs.writeFileSync(oldFile, 'old');
      await router.finishTurn(scopeA);
      expect(bridge.command).not.toHaveBeenCalledWith(original, 'closeTab');
      publish.mockClear();
      expect(router.selectClaim(scopeA, replacement)).toEqual(replacement);
      const current = bindingOf(router, scopeA, replacement);
      expect(current).toMatchObject({ agentCreated: false, disposition: null, usedInTurn: true });
      expect(current.allowedOrigins.size).toBe(0);
      expect(current.outputDir).not.toBe(oldBinding.outputDir);
      expect(fs.existsSync(oldFile)).toBe(true);
      expect(publish).not.toHaveBeenCalled();
      await router.call(scopeA, replacement, 'browser_snapshot', {});
      expect(grants).toEqual([[], []]);
      expect(bridge.command).toHaveBeenCalledWith(replacement, 'allowOrigin', { origin: 'https://example.test' });
      router.markTab(scopeA, 'handoff', original);
      expect(oldBinding.disposition).toBe('handoff');
      expect(current.disposition).toBeNull();
      await router.finishTurn(scopeA);
      expect(bridge.command).not.toHaveBeenCalledWith(original, 'closeTab');
      expect(bridge.command).not.toHaveBeenCalledWith(replacement, 'closeTab');
      expect(router.hasBinding(scopeA)).toBe(true);
      router.markTab(scopeA, 'deliverable', replacement);
      expect(current.disposition).toBe('deliverable');
      await router.call(scopeA, original, 'browser_snapshot', {});
      expect(grants).toEqual([[], [], ['https://example.test']]);
    } finally { router.closeAll(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(['explicit', 'implicit'] as const)('rearms the turn target when the same in-app tab is selected %sly', async selection => {
    const original = { ...claim, browser: 'memmy' as const };
    const replacement = { ...original, tabId: 18, active: true };
    const bridge = fakeBridge([original, replacement]);
    const router = new ExternalBrowserSessionRouter(bridge, async () => true, 'embedded');
    try {
      router.selectClaim(scopeA, original);
      await router.finishTurn(scopeA);
      expect(selection === 'explicit' ? router.selectClaim(scopeA, original) : router.select(scopeA, false)).toEqual(original);
      expect(router.selectClaim(scopeA, replacement)).toEqual(replacement);
      expect(router.select(scopeA, false)).toEqual(replacement);
      expect(bridge.command).not.toHaveBeenCalled();
    } finally { router.closeAll(); }
  });

  it('does not switch to a live tab owned by another chat after the turn ends', async () => {
    const original = { ...claim, browser: 'memmy' as const };
    const occupied = { ...original, tabId: 18 };
    const bridge = fakeBridge([original, occupied]);
    const router = new ExternalBrowserSessionRouter(bridge, async () => true, 'embedded');
    try {
      router.selectClaim(scopeA, original);
      router.selectClaim(scopeB, occupied);
      await router.finishTurn(scopeA);
      expect(() => router.selectClaim(scopeA, occupied)).toThrow(/already in use by another chat/);
      expect(router.select(scopeA, false)).toEqual(original);
      expect(router.select(scopeB, false)).toEqual(occupied);
      expect(bridge.command).not.toHaveBeenCalled();
    } finally { router.closeAll(); }
  });

  it('hands a tab to another chat only after its current chat finishes the turn', async () => {
    for (const kind of ['external', 'embedded'] as const) {
      const shared = { ...claim, browser: kind === 'external' ? 'edge' as const : 'memmy' as const };
      const bridge = fakeBridge([shared]);
      const publish = vi.spyOn(surfaces, 'emitComputerUseSurface');
      const router = new ExternalBrowserSessionRouter(bridge, async () => true, kind);
      try {
        router.selectClaim(scopeA, shared);
        expect(() => router.selectClaim(scopeB, shared)).toThrow(/in use by another chat/);
        await router.finishTurn(scopeA);
        publish.mockClear();
        expect(router.selectClaim(scopeB, shared)).toEqual(shared);
        expect(publish).toHaveBeenCalledWith(expect.objectContaining({ ...scopeA, close: true }));
        expect(router.hasBinding(scopeA)).toBe(false);
        expect(router.select(scopeB, false)).toEqual(shared);
        expect(() => router.selectClaim(scopeA, shared)).toThrow(/in use by another chat/);
      } finally { router.closeAll(); publish.mockRestore(); }
    }
  });

  it('lets a Chrome/Edge chat use any tab and return to an earlier one with its saved files', async () => {
    const other = { ...claim, tabId: 18, title: 'Other', url: 'https://other.test/' };
    const bridge = fakeBridge([claim, other]);
    const router = new ExternalBrowserSessionRouter(bridge, async () => true, 'external');
    try {
      router.selectClaim(scopeA, claim);
      const shot = await router.call(scopeA, claim, 'browser_take_screenshot', { filename: 'first.jpeg' });
      const saved = String(shot[0].text).replace('Screenshot saved to ', '');
      await router.finishTurn(scopeA);
      expect(router.selectClaim(scopeA, other)).toEqual(other);
      expect(router.select(scopeA, false)).toEqual(other);
      await router.call(scopeA, other, 'browser_snapshot', {});
      expect(router.selectClaim(scopeA, claim)).toEqual(claim);
      expect(router.select(scopeA, false)).toEqual(claim);
      expect(fs.existsSync(saved)).toBe(true);
      expect(bindingOf(router, scopeA, other).allowedOrigins).toEqual(new Set(['https://other.test']));
    } finally { router.closeAll(); }
  });

  it('rejects a pending approval after turn completion even when the chat already moved to another tab', async () => {
    const original = { ...claim, browser: 'memmy' as const };
    const replacement = { ...original, tabId: 18 };
    const bridge = fakeBridge([original, replacement]);
    let resolveApproval!: (value: boolean) => void;
    const approval = new Promise<boolean>(resolve => { resolveApproval = resolve; });
    let started!: () => void;
    const approvalStarted = new Promise<void>(resolve => { started = resolve; });
    const router = new ExternalBrowserSessionRouter(bridge, async () => { started(); return approval; }, 'embedded');
    try {
      router.selectClaim(scopeA, original);
      const pending = expect(router.call(scopeA, original, 'browser_snapshot', {})).rejects.toThrow(/Memmy in-app.*changed/);
      await approvalStarted;
      await router.finishTurn(scopeA);
      expect(router.selectClaim(scopeA, replacement)).toEqual(replacement);
      resolveApproval(true);
      await pending;
      expect(bridge.command).not.toHaveBeenCalled();
      expect(router.select(scopeA, false)).toEqual(replacement);
    } finally { resolveApproval(true); router.closeAll(); }
  });

  it('discards a late command result after turn completion and keeps the tab busy for other chats until it settles', async () => {
    const original = { ...claim, browser: 'memmy' as const };
    const replacement = { ...original, tabId: 18 };
    const bridge = fakeBridge([original, replacement]);
    let resolveCommand!: (value: unknown) => void;
    const result = new Promise<unknown>(resolve => { resolveCommand = resolve; });
    let started!: () => void;
    const commandStarted = new Promise<void>(resolve => { started = resolve; });
    const command = bridge.command;
    bridge.command = vi.fn((bound, operation, args, signal) => {
      if (operation === 'snapshot') { started(); return result; }
      return command(bound, operation, args, signal);
    });
    const router = new ExternalBrowserSessionRouter(bridge, async () => true, 'embedded');
    const publish = vi.spyOn(surfaces, 'emitComputerUseSurface');
    try {
      router.selectClaim(scopeA, original);
      const pending = expect(router.call(scopeA, original, 'browser_snapshot', {})).rejects.toThrow(/Memmy in-app.*changed/);
      await commandStarted;
      await router.finishTurn(scopeA);
      expect(() => router.selectClaim(scopeB, original)).toThrow(/in use by another chat/);
      expect(router.selectClaim(scopeA, replacement)).toEqual(replacement);
      publish.mockClear();
      resolveCommand({ nodes: [{ name: 'stale content' }] });
      await pending;
      expect(publish).not.toHaveBeenCalled();
      expect(router.selectClaim(scopeB, original)).toEqual(original);
      expect((bridge.command as ReturnType<typeof vi.fn>).mock.calls.filter(call => call[1] === 'snapshot')).toHaveLength(1);
    } finally { resolveCommand({}); router.closeAll(); }
  });

  it('does not execute a pending surface click after its turn finishes', async () => {
    const original = { ...claim, browser: 'memmy' as const };
    const replacement = { ...original, tabId: 18 };
    const bridge = fakeBridge([original, replacement]);
    let resolveViewport!: (value: { width: number; height: number }) => void;
    const viewport = new Promise<{ width: number; height: number }>(resolve => { resolveViewport = resolve; });
    let started!: () => void;
    const commandStarted = new Promise<void>(resolve => { started = resolve; });
    const command = bridge.command;
    bridge.command = vi.fn((bound, operation, args, signal) => {
      if (operation === 'viewport') { started(); return viewport; }
      return command(bound, operation, args, signal);
    });
    const router = new ExternalBrowserSessionRouter(bridge, async () => true, 'embedded');
    try {
      router.selectClaim(scopeA, original);
      const pending = router.handleSurfaceAction({ type: 'memmy:computer-use-surface:action',
        surface: 'browser', ...scopeA, targetId: 'embedded:connection:9', action: 'click', x: 0.25, y: 0.5 });
      await commandStarted;
      await router.finishTurn(scopeA);
      expect(router.selectClaim(scopeA, replacement)).toEqual(replacement);
      resolveViewport({ width: 1000, height: 600 });
      await expect(pending).resolves.toBe(true);
      expect((bridge.command as ReturnType<typeof vi.fn>).mock.calls.some(call => call[1] === 'click')).toBe(false);
      expect(router.selectClaim(scopeA, replacement)).toEqual(replacement);
    } finally { resolveViewport({ width: 1000, height: 600 }); router.closeAll(); }
  });

  it('discards a late in-app CDP response after turn completion before switching tabs', async () => {
    const original = { ...claim, browser: 'memmy' as const };
    const replacement = { ...original, tabId: 18 };
    const bridge = fakeBridge([original, replacement]);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'embedded-late-cdp-'));
    const policyPath = path.join(directory, 'site-policy.json');
    fs.writeFileSync(policyPath, JSON.stringify({ version: 1, rules: [{ pattern: 'https://example.test',
      access: 'ask', downloads: 'ask', uploads: 'ask', fullCdp: 'ask' }] }));
    let resolveRead!: (value: unknown) => void;
    const result = new Promise<unknown>(resolve => { resolveRead = resolve; });
    let started!: () => void;
    const commandStarted = new Promise<void>(resolve => { started = resolve; });
    const command = bridge.command;
    bridge.command = vi.fn((bound, operation, args, signal) => {
      if (operation === 'cdpCall') { started(); return result; }
      return command(bound, operation, args, signal);
    });
    const router = new ExternalBrowserSessionRouter(bridge, async () => true, 'embedded',
      new BrowserUseSitePolicyReader(policyPath));
    try {
      router.selectClaim(scopeA, original);
      const pending = expect(router.cdp(scopeA, original, 'cdpCall',
        { method: 'Runtime.evaluate', params: { expression: 'document.title' } }, async () => true))
        .rejects.toThrow(/Memmy in-app.*changed/);
      await commandStarted;
      await router.finishTurn(scopeA);
      expect(router.selectClaim(scopeA, replacement)).toEqual(replacement);
      resolveRead({ result: { value: 'old title' } });
      await pending;
      expect(router.selectClaim(scopeA, replacement)).toEqual(replacement);
    } finally { resolveRead({}); router.closeAll(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('does not recover to a replacement already owned by another chat', () => {
    const original = { ...claim, browser: 'memmy' as const };
    const replacement = { ...original, tabId: 18 };
    const claims = [original, replacement];
    const bridge = fakeBridge(claims);
    const router = new ExternalBrowserSessionRouter(bridge, async () => true, 'embedded');
    try {
      router.selectClaim(scopeA, original);
      router.selectClaim(scopeB, replacement);
      claims.shift();
      expect(() => router.selectClaim(scopeA, replacement)).toThrow(/already in use by another chat/);
      expect(() => router.select(scopeA, false)).toThrow(/closed or replaced/);
      expect(router.select(scopeB, false)).toEqual(replacement);
      expect(router.hasBinding(scopeA)).toBe(true);
      expect(bridge.command).not.toHaveBeenCalled();
    } finally { router.closeAll(); }
  });

  it('rejects a replacement that disappeared and preserves the disconnected binding', () => {
    const original = { ...claim, browser: 'memmy' as const };
    const claims = [original];
    const bridge = fakeBridge(claims);
    const router = new ExternalBrowserSessionRouter(bridge, async () => true, 'embedded');
    try {
      router.selectClaim(scopeA, original);
      claims.length = 0;
      expect(() => router.selectClaim(scopeA, { ...original, tabId: 18 })).toThrow(/referenced Memmy in-app.*no longer open/);
      expect(router.hasBinding(scopeA)).toBe(true);
      expect(bridge.command).not.toHaveBeenCalled();
    } finally { router.closeAll(); }
  });

  it('accepts the same live reference repeatedly without resetting its origin grant', async () => {
    const current = { ...claim, browser: 'memmy' as const };
    const bridge = fakeBridge([current]);
    const grants: string[][] = [];
    const authorize = vi.fn(async (url: string, allowed: Set<string>) => {
      grants.push([...allowed]); allowed.add(new URL(url).origin); return true;
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'embedded-stable-binding-'));
    const router = new ExternalBrowserSessionRouter(bridge, authorize, 'embedded',
      new BrowserUseSitePolicyReader(path.join(directory, 'site-policy.json')));
    try {
      router.selectClaim(scopeA, current);
      await router.call(scopeA, current, 'browser_snapshot', {});
      expect(router.selectClaim(scopeA, { ...current })).toEqual(current);
      await router.call(scopeA, current, 'browser_snapshot', {});
      expect(authorize).toHaveBeenCalledTimes(2);
      expect(grants).toEqual([[], ['https://example.test']]);
      expect((bridge.command as ReturnType<typeof vi.fn>).mock.calls.filter(call => call[1] === 'allowOrigin')).toHaveLength(1);
    } finally { router.closeAll(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(['tool', 'surface', 'CDP'] as const)('revalidates a cached in-app origin before a %s action after approval was revoked', async action => {
    const current = { ...claim, browser: 'memmy' as const };
    const bridge = fakeBridge([current]);
    const grants: string[][] = [];
    const authorize = vi.fn(async (url: string, allowed: Set<string>) => {
      grants.push([...allowed]);
      if (grants.length > 1) return false;
      allowed.add(new URL(url).origin);
      return true;
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'embedded-revoked-binding-'));
    const router = new ExternalBrowserSessionRouter(bridge, authorize, 'embedded',
      new BrowserUseSitePolicyReader(path.join(directory, 'site-policy.json')));
    try {
      router.selectClaim(scopeA, current);
      await router.call(scopeA, current, 'browser_snapshot', {});
      (bridge.command as ReturnType<typeof vi.fn>).mockClear();
      if (action === 'tool') {
        await expect(router.call(scopeA, current, 'browser_click', { target: 'ax-1' })).rejects.toThrow(/not approved/);
      } else if (action === 'surface') {
        await expect(router.handleSurfaceAction({ type: 'memmy:computer-use-surface:action',
          surface: 'browser', ...scopeA, targetId: 'embedded:connection:9',
          action: 'click', x: 0.25, y: 0.5 })).resolves.toBe(true);
      } else {
        await expect(router.cdp(scopeA, current, 'cdpCall', { method: 'Runtime.evaluate',
          params: { expression: 'document.title' } }, async () => true)).rejects.toThrow(/not approved/);
      }
      expect(grants).toEqual([[], ['https://example.test']]);
      expect(bridge.command).not.toHaveBeenCalled();
      expect(router.select(scopeA, false)).toEqual(current);
    } finally { router.closeAll(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('does not continue an old pending approval after explicit binding recovery', async () => {
    const original = { ...claim, browser: 'memmy' as const };
    const replacement = { ...original, tabId: 18 };
    const claims = [original];
    const bridge = fakeBridge(claims);
    let grant!: (value: boolean) => void;
    const pendingApproval = new Promise<boolean>(resolve => { grant = resolve; });
    let approvals = 0;
    const authorize = vi.fn(async (url: string, allowed: Set<string>) => {
      const approved = ++approvals === 1 ? await pendingApproval : true;
      if (approved) allowed.add(new URL(url).origin);
      return approved;
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'embedded-pending-binding-'));
    const router = new ExternalBrowserSessionRouter(bridge, authorize, 'embedded',
      new BrowserUseSitePolicyReader(path.join(directory, 'site-policy.json')));
    try {
      router.selectClaim(scopeA, original);
      const cancelled = expect(router.call(scopeA, original, 'browser_snapshot', {})).rejects.toThrow(/Memmy in-app.*changed/);
      claims.splice(0, 1, replacement);
      router.selectClaim(scopeA, replacement);
      grant(true);
      await cancelled;
      expect(bridge.command).not.toHaveBeenCalled();
      await router.call(scopeA, replacement, 'browser_snapshot', {});
      expect(authorize).toHaveBeenCalledTimes(2);
      expect((bridge.command as ReturnType<typeof vi.fn>).mock.calls.every(call => call[0] === replacement)).toBe(true);
    } finally { grant(true); router.closeAll(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('does not execute an external click after its turn ends during page approval', async () => {
    const bridge = fakeBridge();
    let grant!: (allowed: boolean) => void;
    const waiting = new Promise<boolean>(resolve => { grant = resolve; });
    let entered!: () => void;
    const approvalStarted = new Promise<void>(resolve => { entered = resolve; });
    let approvals = 0;
    const authorize = vi.fn(async (url: string, allowed: Set<string>) => {
      const approved = ++approvals === 1 ? (entered(), await waiting) : true;
      if (approved) allowed.add(new URL(url).origin);
      return approved;
    });
    const router = new ExternalBrowserSessionRouter(bridge, authorize, 'external');
    try {
      router.selectClaim(scopeA, claim);
      const pending = expect(router.call(scopeA, claim, 'browser_click', { target: '#submit' }))
        .rejects.toThrow(/Chrome\/Edge.*changed/);
      await approvalStarted;
      await router.finishTurn(scopeA);
      expect(router.hasBinding(scopeA)).toBe(true);
      grant(true);
      await pending;
      expect((bridge.command as ReturnType<typeof vi.fn>).mock.calls.some(call => call[1] === 'click')).toBe(false);
      await router.call(scopeA, claim, 'browser_click', { target: '#submit' });
      expect((bridge.command as ReturnType<typeof vi.fn>).mock.calls.filter(call => call[1] === 'click')).toHaveLength(1);
    } finally { grant(true); router.closeAll(); }
  });

  it('revokes an in-app click while page approval is still pending', async () => {
    const current = { ...claim, browser: 'memmy' as const };
    const bridge = fakeBridge([current]);
    let grant!: (allowed: boolean) => void;
    const waiting = new Promise<boolean>(resolve => { grant = resolve; });
    let entered!: () => void;
    const approvalStarted = new Promise<void>(resolve => { entered = resolve; });
    let approvals = 0;
    const router = new ExternalBrowserSessionRouter(bridge, async (url, allowed) => {
      const approved = ++approvals === 1 ? (entered(), await waiting) : true;
      if (approved) allowed.add(new URL(url).origin);
      return approved;
    }, 'embedded');
    try {
      router.selectClaim(scopeA, current);
      const pending = expect(router.call(scopeA, current, 'browser_click', { target: 'ax-1' }))
        .rejects.toThrow(/Memmy in-app.*changed/);
      await approvalStarted;
      await router.finishTurn(scopeA);
      grant(true);
      await pending;
      expect((bridge.command as ReturnType<typeof vi.fn>).mock.calls.some(call => call[1] === 'click')).toBe(false);
      await router.call(scopeA, current, 'browser_click', { target: 'ax-1' });
      expect((bridge.command as ReturnType<typeof vi.fn>).mock.calls.filter(call => call[1] === 'click')).toHaveLength(1);
    } finally { grant(true); router.closeAll(); }
  });

  it('does not upload after its turn ends while file approval is pending', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'external-upload-stopped-turn-'));
    const source = path.join(workspace, 'evidence.txt');
    fs.writeFileSync(source, 'fixture evidence');
    const bridge = fakeBridge();
    const originalCommand = bridge.command;
    bridge.command = vi.fn((bound, operation, args, signal) => operation === 'tabState'
      ? Promise.resolve({ url: claim.url, origin: new URL(claim.url).origin })
      : originalCommand(bound, operation, args, signal));
    let grant!: (allowed: boolean) => void;
    const waiting = new Promise<boolean>(resolve => { grant = resolve; });
    let entered!: () => void;
    const approvalStarted = new Promise<void>(resolve => { entered = resolve; });
    const approve = vi.fn(async () => { entered(); return waiting; });
    const router = new ExternalBrowserSessionRouter(bridge, async (url, allowed) => {
      allowed.add(new URL(url).origin); return true;
    }, 'external');
    try {
      router.selectClaim(scopeA, claim);
      const pending = expect(router.upload(scopeA, claim, { target: '#attachment', paths: [source] }, approve))
        .rejects.toThrow(/Chrome\/Edge.*changed/);
      await approvalStarted;
      await router.finishTurn(scopeA);
      grant(true);
      await pending;
      expect((bridge.command as ReturnType<typeof vi.fn>).mock.calls.some(call => call[1] === 'upload')).toBe(false);
      await router.upload(scopeA, claim, { target: '#attachment', paths: [source] }, async () => true);
      expect((bridge.command as ReturnType<typeof vi.fn>).mock.calls.filter(call => call[1] === 'upload')).toHaveLength(1);
    } finally { grant(true); router.closeAll(); fs.rmSync(workspace, { recursive: true, force: true }); }
  });

  it('discards a late screenshot after recovery without recreating old files or surfaces', async () => {
    const original = { ...claim };
    const replacement = { ...original, tabId: 18 };
    const claims = [original];
    const bridge = fakeBridge(claims);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'embedded-late-screenshot-'));
    const router = new ExternalBrowserSessionRouter(bridge, async (url, allowed) => {
      allowed.add(new URL(url).origin); return true;
    }, 'external', new BrowserUseSitePolicyReader(path.join(directory, 'site-policy.json')));
    const publish = vi.spyOn(surfaces, 'emitComputerUseSurface');
    let finish!: (value: { format: string; data: string }) => void;
    const screenshotResult = new Promise<{ format: string; data: string }>(resolve => { finish = resolve; });
    let started!: () => void;
    const screenshotStarted = new Promise<void>(resolve => { started = resolve; });
    try {
      router.selectClaim(scopeA, original);
      const saved = await router.call(scopeA, original, 'browser_take_screenshot', { filename: 'before.jpeg' });
      const oldDirectory = path.dirname(String(saved[0].text).replace('Screenshot saved to ', ''));
      const command = bridge.command;
      bridge.command = vi.fn((bound, operation, args, signal) => {
        if (bound.tabId === original.tabId && operation === 'screenshot') { started(); return screenshotResult; }
        return command(bound, operation, args, signal);
      });
      const cancelled = expect(router.call(scopeA, original, 'browser_take_screenshot',
        { filename: 'late.jpeg' })).rejects.toThrow(/Chrome\/Edge.*changed/);
      await screenshotStarted;
      claims.splice(0, 1, replacement);
      router.selectClaim(scopeA, replacement);
      expect(fs.existsSync(oldDirectory)).toBe(false);
      publish.mockClear();
      finish({ format: 'jpeg', data: 'AAA' });
      await cancelled;
      expect(fs.existsSync(oldDirectory)).toBe(false);
      expect(publish).not.toHaveBeenCalled();
      expect((bridge.command as ReturnType<typeof vi.fn>).mock.calls.some(call => call[1] === 'historyState')).toBe(false);
    } finally { finish({ format: 'jpeg', data: 'AAA' }); router.closeAll(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('discards a late preview history response after recovery without reopening the old surface', async () => {
    const original = { ...claim };
    const replacement = { ...original, tabId: 18 };
    const claims = [original];
    const bridge = fakeBridge(claims);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'embedded-late-history-'));
    const router = new ExternalBrowserSessionRouter(bridge, async (url, allowed) => {
      allowed.add(new URL(url).origin); return true;
    }, 'external', new BrowserUseSitePolicyReader(path.join(directory, 'site-policy.json')));
    const publish = vi.spyOn(surfaces, 'emitComputerUseSurface');
    let finish!: (value: { canGoBack: boolean; canGoForward: boolean }) => void;
    const historyResult = new Promise<{ canGoBack: boolean; canGoForward: boolean }>(resolve => { finish = resolve; });
    let started!: () => void;
    const historyStarted = new Promise<void>(resolve => { started = resolve; });
    try {
      router.selectClaim(scopeA, original);
      const saved = await router.call(scopeA, original, 'browser_take_screenshot', { filename: 'before.jpeg' });
      const oldDirectory = path.dirname(String(saved[0].text).replace('Screenshot saved to ', ''));
      const command = bridge.command;
      bridge.command = vi.fn((bound, operation, args, signal) => {
        if (bound.tabId === original.tabId && operation === 'historyState') { started(); return historyResult; }
        return command(bound, operation, args, signal);
      });
      const cancelled = expect(router.call(scopeA, original, 'browser_take_screenshot',
        { filename: 'late.jpeg' })).rejects.toThrow(/Chrome\/Edge.*changed/);
      await historyStarted;
      claims.splice(0, 1, replacement);
      router.selectClaim(scopeA, replacement);
      publish.mockClear();
      finish({ canGoBack: false, canGoForward: false });
      await cancelled;
      expect(publish).not.toHaveBeenCalled();
      expect(fs.existsSync(oldDirectory)).toBe(false);
      expect(router.select(scopeA, false)).toEqual(replacement);
    } finally { finish({ canGoBack: false, canGoForward: false }); router.closeAll(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('does not forward a pending surface click after explicit binding recovery', async () => {
    const original = { ...claim, browser: 'memmy' as const };
    const replacement = { ...original, tabId: 18 };
    const claims = [original];
    const bridge = fakeBridge(claims);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'embedded-late-click-'));
    const router = new ExternalBrowserSessionRouter(bridge, async () => true, 'embedded',
      new BrowserUseSitePolicyReader(path.join(directory, 'site-policy.json')));
    let finish!: (value: { width: number; height: number }) => void;
    const viewportResult = new Promise<{ width: number; height: number }>(resolve => { finish = resolve; });
    let started!: () => void;
    const viewportStarted = new Promise<void>(resolve => { started = resolve; });
    try {
      router.selectClaim(scopeA, original);
      const command = bridge.command;
      bridge.command = vi.fn((bound, operation, args, signal) => {
        if (operation === 'viewport') { started(); return viewportResult; }
        return command(bound, operation, args, signal);
      });
      const pending = router.handleSurfaceAction({ type: 'memmy:computer-use-surface:action',
        surface: 'browser', ...scopeA, targetId: 'embedded:connection:9',
        action: 'click', x: 0.25, y: 0.5 });
      await viewportStarted;
      claims.splice(0, 1, replacement);
      router.selectClaim(scopeA, replacement);
      finish({ width: 1000, height: 600 });
      await expect(pending).resolves.toBe(true);
      expect((bridge.command as ReturnType<typeof vi.fn>).mock.calls.some(call => ['click', 'screenshot'].includes(call[1]))).toBe(false);
      expect(router.select(scopeA, false)).toEqual(replacement);
    } finally { finish({ width: 1000, height: 600 }); router.closeAll(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('does not close a replacement binding when an old turn cleanup finishes late', async () => {
    const original = { ...claim, browser: 'memmy' as const };
    const replacement = { ...original, tabId: 18 };
    const claims = [original];
    const bridge = fakeBridge(claims);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'embedded-late-close-'));
    const router = new ExternalBrowserSessionRouter(bridge, async () => true, 'embedded',
      new BrowserUseSitePolicyReader(path.join(directory, 'site-policy.json')));
    const publish = vi.spyOn(surfaces, 'emitComputerUseSurface');
    let finish!: (value: unknown) => void;
    const closeResult = new Promise<unknown>(resolve => { finish = resolve; });
    let started!: () => void;
    const closeStarted = new Promise<void>(resolve => { started = resolve; });
    try {
      router.selectClaim(scopeA, original, { agentCreated: true });
      const command = bridge.command;
      bridge.command = vi.fn((bound, operation, args, signal) => {
        if (operation === 'closeTab') { started(); return closeResult; }
        return command(bound, operation, args, signal);
      });
      const pending = router.finishTurn(scopeA);
      await closeStarted;
      claims.splice(0, 1, replacement);
      router.selectClaim(scopeA, replacement);
      await router.call(scopeA, replacement, 'browser_snapshot', {});
      const outputDir = bindingOf(router, scopeA, replacement).outputDir;
      const savedFile = path.join(outputDir, 'replacement-output.txt');
      fs.writeFileSync(savedFile, 'replacement session output');
      publish.mockClear();
      finish({});
      await pending;
      expect(router.select(scopeA, false)).toEqual(replacement);
      expect(fs.existsSync(savedFile)).toBe(true);
      expect(publish).not.toHaveBeenCalled();
      expect((bridge.command as ReturnType<typeof vi.fn>).mock.calls.filter(call => call[1] === 'closeTab')).toHaveLength(1);
    } finally { finish({}); router.closeAll(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('checks page access and high-risk CDP approval for both current and destination sites', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'external-cdp-destination-'));
    const policyPath = path.join(directory, 'site-policy.json');
    fs.writeFileSync(policyPath, JSON.stringify({ version: 1, rules: [
      { pattern: 'https://example.test', access: 'ask', downloads: 'ask', uploads: 'ask', fullCdp: 'ask' },
      { pattern: 'https://destination.test', access: 'ask', downloads: 'ask', uploads: 'ask', fullCdp: 'ask' },
    ] }));
    const bridge = fakeBridge();
    bridge.command = vi.fn(async (_bound, operation: string) => {
      if (operation === 'tabState') return { url: claim.url, origin: 'https://example.test' };
      return {};
    });
    const authorize = vi.fn(async (_url: string, allowed: Set<string>) => {
      allowed.add('https://destination.test'); return true;
    });
    const router = new ExternalBrowserSessionRouter(bridge, authorize, 'external',
      new BrowserUseSitePolicyReader(policyPath));
    router.selectClaim(scopeA, claim);
    const approve = vi.fn(async (url: string) => url !== 'https://destination.test/');
    const input = { method: 'Network.setCookie', params: {
      name: 'sample', value: '1', url: 'https://destination.test/',
    } };
    try {
      await expect(router.cdp(scopeA, claim, 'cdpWrite', input, approve))
        .rejects.toThrow(/destination debug access/);
      expect((bridge.command as ReturnType<typeof vi.fn>).mock.calls.some(call => call[1] === 'cdpWrite'))
        .toBe(false);
      expect(authorize.mock.calls.map(call => call[0])).toEqual([claim.url, 'https://destination.test/']);
      approve.mockResolvedValue(true);
      await expect(router.cdp(scopeA, claim, 'cdpWrite', input, approve)).resolves.toBe('{}');
      expect(bridge.command).toHaveBeenCalledWith(claim, 'allowOrigin',
        { origin: 'https://destination.test' }, undefined);
      expect(bridge.command).toHaveBeenCalledWith(claim, 'cdpWrite', {
        method: 'Network.setCookie', params: input.params, approvedOrigin: 'https://example.test',
      }, undefined);
    } finally { router.closeAll(); fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it('binds each read-only CDP operation to the approved tab, site and current policy', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'external-cdp-policy-'));
    const policyPath = path.join(directory, 'site-policy.json');
    const rule = { pattern: 'https://example.test', access: 'ask', downloads: 'ask',
      uploads: 'ask', fullCdp: 'ask' };
    fs.writeFileSync(policyPath, JSON.stringify({ version: 1, rules: [rule] }));
    let currentUrl = claim.url;
    let changeDuringRead = false;
    const bridge = fakeBridge();
    bridge.command = vi.fn(async (_bound, operation: string, args: Record<string, unknown>) => {
      if (operation === 'tabState') return { url: currentUrl, origin: new URL(currentUrl).origin };
      if (operation === 'cdpTarget') return { sessionId: 'child-1', targetId: 'frame-1',
        url: claim.url, origin: 'https://example.test', revision: 0 };
      if (operation === 'cdpCall') {
        expect(args).toMatchObject({ method: 'Runtime.evaluate', approvedOrigin: 'https://example.test',
          params: { expression: 'document.title', throwOnSideEffect: true } });
        if (changeDuringRead) currentUrl = 'https://other.test/';
        return { result: { value: 'Example' } };
      }
      return {};
    });
    const router = new ExternalBrowserSessionRouter(bridge, async () => true, 'external',
      new BrowserUseSitePolicyReader(policyPath));
    router.selectClaim(scopeA, claim);
    const approve = vi.fn(async () => true);
    try {
      await expect(router.cdp(scopeA, claim, 'cdpCall', { method: 'Runtime.evaluate',
        params: { expression: 'document.title' } }, approve)).resolves.toContain('Example');
      expect(approve).toHaveBeenCalledWith(claim.url, 'Runtime.evaluate', undefined);
      await router.cdp(scopeA, claim, 'cdpCall', { method: 'Runtime.evaluate',
        params: { expression: 'document.title' }, target: { sessionId: 'child-1' } }, approve);
      expect(bridge.command).toHaveBeenCalledWith(claim, 'cdpCall', expect.objectContaining({
        target: { sessionId: 'child-1' }, approvedOrigin: 'https://example.test',
      }), undefined);
      await router.cdp(scopeA, claim, 'cdpEvents', {
        afterSequence: 2, target: { targetId: 'frame-1' }, timeoutMs: 10,
      }, approve);
      expect(bridge.command).toHaveBeenCalledWith(claim, 'cdpEvents', expect.objectContaining({
        target: { targetId: 'frame-1' }, timeoutMs: 10, approvedOrigin: 'https://example.test',
      }), undefined);
      await router.cdp(scopeA, claim, 'cdpCall', { method: 'Runtime.evaluate',
        params: { expression: 'document.title' }, timeoutMs: 10 }, approve);
      expect(bridge.command).toHaveBeenCalledWith(claim, 'cdpCall', expect.objectContaining({
        timeoutMs: 10, approvedOrigin: 'https://example.test',
      }), undefined);
      (bridge.command as ReturnType<typeof vi.fn>).mockClear();
      await expect(router.cdp(scopeA, claim, 'cdpCall', { method: 'DOM.setFileInputFiles' }, approve))
        .rejects.toThrow(/unavailable/);
      expect(bridge.command).not.toHaveBeenCalled();
      changeDuringRead = true;
      await expect(router.cdp(scopeA, claim, 'cdpCall', { method: 'Runtime.evaluate',
        params: { expression: 'document.title' } }, approve)).rejects.toThrow(/site changed/);
      currentUrl = claim.url;
      changeDuringRead = false;
      (bridge.command as ReturnType<typeof vi.fn>).mockClear();
      await expect(router.cdp(scopeA, claim, 'cdpCall', { method: 'Runtime.evaluate',
        params: { expression: 'document.title' } }, async () => {
        fs.writeFileSync(policyPath, JSON.stringify({ version: 1,
          rules: [{ ...rule, fullCdp: 'block' }] }));
        return true;
      })).rejects.toThrow(/blocked/);
      expect((bridge.command as ReturnType<typeof vi.fn>).mock.calls.some(call => call[1] === 'cdpCall')).toBe(false);
      fs.writeFileSync(policyPath, JSON.stringify({ version: 1, rules: [{ ...rule, fullCdp: 'block' }] }));
      (bridge.command as ReturnType<typeof vi.fn>).mockClear();
      await expect(router.cdp(scopeA, claim, 'cdpCall', { method: 'Runtime.evaluate',
        params: { expression: 'document.title' } }, approve)).rejects.toThrow(/blocked/);
      expect((bridge.command as ReturnType<typeof vi.fn>).mock.calls.some(call => call[1] === 'cdpCall')).toBe(false);
    } finally { router.closeAll(); fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it('blocks an already claimed external tab when a site rule changes to Block', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claimed-site-policy-'));
    const policyPath = path.join(directory, 'site-policy.json');
    const bridge = fakeBridge();
    const router = new ExternalBrowserSessionRouter(bridge, async () => true, 'external',
      new BrowserUseSitePolicyReader(policyPath));
    router.selectClaim(scopeA, claim);
    try {
      fs.writeFileSync(policyPath, JSON.stringify({ version: 1, rules: [{ pattern: 'https://example.test',
        access: 'block', downloads: 'allow', uploads: 'allow', fullCdp: 'block' }] }));
      await expect(router.call(scopeA, claim, 'browser_click', { target: 'ax-1' })).rejects.toThrow(/blocked by policy/);
      expect(bridge.command).not.toHaveBeenCalled();
    } finally { router.closeAll(); fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it('uploads only after approval to the same claimed tab and origin, and removes private staging', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'external-upload-test-'));
    const source = path.join(workspace, 'document.txt');
    fs.writeFileSync(source, 'approved content');
    let currentUrl = 'https://example.test/form';
    const bridge = fakeBridge();
    const original = bridge.command;
    const command = vi.fn(async (bound: ExternalBrowserClaim, operation: string, args: Record<string, any>) => {
      if (operation === 'tabState') return { url: currentUrl, origin: new URL(currentUrl).origin };
      if (operation === 'upload') {
        expect(bound.tabId).toBe(claim.tabId);
        expect(args.approvedOrigin).toBe('https://example.test');
        expect(args.target).toBe('ax-12');
        expect(fs.statSync(args.paths[0]).mode & 0o777).toBe(0o600);
        expect(fs.readFileSync(args.paths[0], 'utf8')).toBe('approved content');
        return { uploaded: 1 };
      }
      return original(bound, operation, args);
    });
    bridge.command = command;
    const router = new ExternalBrowserSessionRouter(bridge, async () => true);
    router.selectClaim(scopeA, claim);
    const approve = vi.fn(async () => true);
    try {
      const result = await router.upload(scopeA, claim, { target: 'ax-12', paths: [source] }, approve);
      expect(result[0]).toMatchObject({ type: 'text', text: '{"uploaded":1}' });
      expect(approve).toHaveBeenCalledWith('https://example.test/form', [source], undefined);
      const staged = command.mock.calls.find(call => call[1] === 'upload')![2].paths[0];
      expect(fs.existsSync(staged)).toBe(false);
      command.mockClear();
      await expect(router.upload(scopeA, claim, { target: 'ax-12', paths: [source] }, async () => false))
        .rejects.toThrow(/not approved/);
      expect(command.mock.calls.some(call => call[1] === 'upload')).toBe(false);
      command.mockClear();
      await expect(router.upload(scopeA, claim, { target: 'ax-12', paths: [source] }, async () => {
        currentUrl = 'https://other.test/form'; return true;
      })).rejects.toThrow(/site changed/);
      expect(command.mock.calls.some(call => call[1] === 'upload')).toBe(false);
      currentUrl = 'https://example.test/form';
      command.mockClear();
      await expect(router.upload(scopeA, claim, { target: 'ax-12', paths: [source] }, async () => {
        fs.writeFileSync(source, 'changed after approval'); return true;
      })).rejects.toThrow(/file changed/);
      expect(command.mock.calls.some(call => call[1] === 'upload')).toBe(false);
      fs.writeFileSync(source, 'approved content');
      command.mockClear();
      await expect(router.upload(scopeA, claim, { target: 'ax-12', paths: [source] }, async () => {
        router.closeSession(scopeA); return true;
      })).rejects.toThrow(/cancelled/);
      expect(command.mock.calls.some(call => call[1] === 'upload')).toBe(false);
    } finally { router.closeAll(); fs.rmSync(workspace, { recursive: true, force: true }); }
  });
  it("never adopts a Chrome/Edge tab the chat did not select and never silently switches", () => {
    const claims = [claim];
    const bridge = fakeBridge(claims);
    const router = new ExternalBrowserSessionRouter(bridge, async () => false);
    expect(router.select(scopeA, false)).toBeNull();
    expect(router.selectClaim(scopeA, claim)).toEqual(claim);
    expect(router.select(scopeA, false)).toEqual(claim);
    expect(router.select(scopeB, false)).toBeNull();
    claims.length = 0;
    expect(() => router.select(scopeA, false)).toThrow(/disconnected/);
    router.closeSession(scopeA);
    expect(router.select(scopeA, false)).toBeNull();
  });

  it("uses the active tab when several ordinary pages are open in the requested browser", async () => {
    const bridge = fakeBridge([claim, { ...claim, tabId: 10, active: true, claimedAt: 2 }]);
    const router = new ExternalBrowserSessionRouter(bridge, async () => false);
    expect((await router.selectBrowser(scopeA, 'edge')).tabId).toBe(10);
    expect(router.select(scopeB, true)).toBeNull();
    router.closeAll();
  });

  it("sends normalized sidebar clicks to the same claimed tab", async () => {
    const bridge = fakeBridge();
    const router = new ExternalBrowserSessionRouter(bridge, async () => true);
    router.selectClaim(scopeA, claim);
    const handled = await router.handleSurfaceAction({ type: "memmy:computer-use-surface:action",
      surface: "browser", ...scopeA, targetId: "external:connection:9",
      action: "click", x: 0.25, y: 0.5 });
    expect(handled).toBe(true);
    expect(bridge.command).toHaveBeenCalledWith(claim, "click", { x: 250, y: 300 });
    expect(await router.handleSurfaceAction({ type: "memmy:computer-use-surface:action",
      surface: "browser", ...scopeA, targetId: "active-tab", action: "open" })).toBe(false);
    router.closeAll();
  });

  it('does not swallow actions addressed to the other browser bridge', async () => {
    const bridge = fakeBridge([{ ...claim, browser: 'memmy' }]);
    const router = new ExternalBrowserSessionRouter(bridge, async () => true, 'embedded');
    router.select(scopeA, false);
    expect(await router.handleSurfaceAction({ type: 'memmy:computer-use-surface:action',
      surface: 'browser', ...scopeA, targetId: 'external:connection:9', action: 'open' })).toBe(false);
    expect(await router.handleSurfaceAction({ type: 'memmy:computer-use-surface:action',
      surface: 'browser', ...scopeA, targetId: 'embedded:connection:9', action: 'open' })).toBe(true);
    router.closeAll();
  });

  it("only forwards autofill to the currently claimed origin", async () => {
    const bridge = fakeBridge();
    const router = new ExternalBrowserSessionRouter(bridge, async () => true);
    router.selectClaim(scopeA, claim);
    const base = { type: "memmy:computer-use-surface:action" as const,
      surface: "browser" as const, ...scopeA, targetId: "external:connection:9",
      action: "fill-credential" as const };
    await router.handleSurfaceAction({ ...base, autofill: {
      origin: "https://other.test", username: "a", password: "b",
    } });
    expect(bridge.command).not.toHaveBeenCalled();
    const autofill = { origin: "https://example.test", username: "a", password: "b" };
    await router.handleSurfaceAction({ ...base, autofill });
    expect(bridge.command).toHaveBeenCalledWith(claim, "fillCredential", autofill);
    router.closeAll();
  });

  it("saves screenshots inside its session directory and removes them when closed", async () => {
    const router = new ExternalBrowserSessionRouter(fakeBridge(), async () => true);
    router.selectClaim(scopeA, claim);
    const content = await router.call(scopeA, claim, "browser_take_screenshot", {
      filename: "captures/test.jpeg", type: "jpeg",
    });
    const destination = String(content[0].text).replace("Screenshot saved to ", "");
    expect(fs.existsSync(destination)).toBe(true);
    await expect(router.call(scopeA, claim, "browser_take_screenshot", {
      filename: "../outside.jpeg", type: "jpeg",
    })).rejects.toThrow(/must stay within/);
    router.closeSession(scopeA);
    expect(fs.existsSync(destination)).toBe(false);
  });

  it('closes only Agent-created unmarked tabs at turn end', async () => {
    const userTab = { ...claim, browser: 'memmy' as const };
    const agentTab = { ...userTab, tabId: 10 };
    const bridge = fakeBridge([userTab, agentTab]);
    const router = new ExternalBrowserSessionRouter(bridge, async () => true, 'embedded');
    router.selectClaim(scopeA, userTab);
    router.selectClaim(scopeB, agentTab, { agentCreated: true });
    await router.finishTurn(scopeA);
    expect(bridge.command).not.toHaveBeenCalledWith(userTab, 'closeTab');
    await router.finishTurn(scopeB);
    expect(bridge.command).toHaveBeenCalledWith(agentTab, 'closeTab');
    expect(router.hasBinding(scopeB)).toBe(false);
    router.closeAll();
  });

  it('keeps an unseen background Agent tab for the user to see, then restores normal cleanup', async () => {
    const unseen = { ...claim, browser: 'memmy' as const, everSelected: false };
    const bridge = fakeBridge([unseen]);
    const router = new ExternalBrowserSessionRouter(bridge, async () => true, 'embedded');
    try {
      router.selectClaim(scopeA, unseen, { agentCreated: true });
      await router.finishTurn(scopeA);
      expect(bridge.refresh).toHaveBeenCalledTimes(1);
      expect(bridge.command).not.toHaveBeenCalledWith(unseen, 'closeTab');
      expect(router.hasBinding(scopeA)).toBe(true);

      unseen.everSelected = true;
      await router.call(scopeA, unseen, 'browser_snapshot', {});
      await router.finishTurn(scopeA);
      expect(bridge.command).toHaveBeenCalledWith(unseen, 'closeTab');
      expect(router.hasBinding(scopeA)).toBe(false);
    } finally { router.closeAll(); }
  });

  it('does not retain an unseen tab when its visibility inventory cannot be refreshed', async () => {
    const unseen = { ...claim, browser: 'memmy' as const, everSelected: false };
    const bridge = fakeBridge([unseen]);
    vi.mocked(bridge.refresh).mockRejectedValueOnce(new Error('browser disconnected'));
    const router = new ExternalBrowserSessionRouter(bridge, async () => true, 'embedded');
    try {
      router.selectClaim(scopeA, unseen, { agentCreated: true });
      await router.finishTurn(scopeA);
      expect(bridge.command).toHaveBeenCalledWith(unseen, 'closeTab');
    } finally { router.closeAll(); }
  });

  it('retains a marked Agent tab for one turn and requires marking again', async () => {
    const created = { ...claim, browser: 'memmy' as const };
    const bridge = fakeBridge([created]);
    const router = new ExternalBrowserSessionRouter(bridge, async () => true, 'embedded');
    router.selectClaim(scopeA, created, { agentCreated: true });
    router.markTab(scopeA, 'handoff');
    await router.finishTurn(scopeA);
    expect(bridge.command).not.toHaveBeenCalledWith(created, 'closeTab');
    expect(router.hasBinding(scopeA)).toBe(true);
    await router.finishTurn(scopeA);
    expect(bridge.command).not.toHaveBeenCalledWith(created, 'closeTab');
    await router.call(scopeA, created, 'browser_snapshot', {});
    await router.finishTurn(scopeA);
    expect(bridge.command).toHaveBeenCalledWith(created, 'closeTab');
    router.closeAll();
  });
});
