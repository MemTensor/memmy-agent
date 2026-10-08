import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExternalBrowserSessionRouter } from "../../../../src/core/agent-runtime/tools/external-browser-session-router.js";
import { BrowserUseSitePolicyReader } from '../../../../src/core/agent-runtime/tools/browser-use-site-policy-store.js';
import type { ExternalBrowserBridge, ExternalBrowserClaim } from "../../../../src/core/agent-runtime/tools/external-browser-bridge.js";

const scopeA = { sessionKey: "a", channel: "projected-session", chatId: "a" };
const scopeB = { sessionKey: "b", channel: "projected-session", chatId: "b" };
const claim: ExternalBrowserClaim = {
  connectionId: "connection", tabId: 9, browser: "edge",
  title: "Test", url: "https://example.test/", claimedAt: 1,
};

function fakeBridge(claims: ExternalBrowserClaim[] = [claim]) {
  const command = vi.fn(async (_claim: unknown, operation: string) => {
    if (operation === "viewport") return { width: 1000, height: 600 };
    if (operation === "screenshot") return { format: "jpeg", data: "AAA" };
    if (operation === "historyState") return { canGoBack: false, canGoForward: false };
    return {};
  });
  return { listClaims: () => claims,
    getClaim: (identity: { connectionId: string; tabId: number }) => claims.find(item =>
      item.connectionId === identity.connectionId && item.tabId === identity.tabId) ?? null,
    command } as unknown as ExternalBrowserBridge;
}

describe("external browser session router", () => {
  it('keeps high-risk CDP approval for another site without asking for page access again', async () => {
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
    router.select(scopeA, false);
    const approve = vi.fn(async (url: string) => url !== 'https://destination.test/');
    const input = { method: 'Network.setCookie', params: {
      name: 'sample', value: '1', url: 'https://destination.test/',
    } };
    try {
      await expect(router.cdp(scopeA, claim, 'cdpWrite', input, approve))
        .rejects.toThrow(/destination debug access/);
      expect((bridge.command as ReturnType<typeof vi.fn>).mock.calls.some(call => call[1] === 'cdpWrite'))
        .toBe(false);
      expect(authorize).not.toHaveBeenCalled();
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
    router.select(scopeA, false);
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
    router.select(scopeA, false);
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
    const router = new ExternalBrowserSessionRouter(bridge, async () => false);
    router.select(scopeA, false);
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
  it("binds the only explicitly claimed tab to one chat and never silently switches", () => {
    const claims = [claim];
    const bridge = fakeBridge(claims);
    const router = new ExternalBrowserSessionRouter(bridge, async () => false);
    expect(router.select(scopeA, false)).toEqual(claim);
    expect(router.select(scopeB, false)).toBeNull();
    claims.length = 0;
    expect(() => router.select(scopeA, false)).toThrow(/disconnected/);
    router.closeSession(scopeA);
    expect(router.select(scopeA, false)).toBeNull();
  });

  it("uses the active tab when several ordinary pages are open", () => {
    const bridge = fakeBridge([claim, { ...claim, tabId: 10, active: true, claimedAt: 2 }]);
    const router = new ExternalBrowserSessionRouter(bridge, async () => false);
    expect(router.select(scopeA, false)?.tabId).toBe(10);
    expect(router.select(scopeB, true)).toBeNull();
  });

  it("sends normalized sidebar clicks to the same claimed tab", async () => {
    const bridge = fakeBridge();
    const router = new ExternalBrowserSessionRouter(bridge, async () => true);
    router.select(scopeA, false);
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
    router.select(scopeA, false);
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
    router.select(scopeA, false);
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
