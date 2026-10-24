import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserSessionManager, BrowserSitePermissionTool, BrowserAuthRequestTool } from '../../../../src/core/agent-runtime/tools/browser.js';
import { BrowserSitePermissionStore } from '../../../../src/core/agent-runtime/tools/browser-site-permissions.js';
import { ExternalBrowserSessionRouter } from '../../../../src/core/agent-runtime/tools/external-browser-session-router.js';
import { BrowserUseSitePolicyReader } from '../../../../src/core/agent-runtime/tools/browser-use-site-policy-store.js';
import { RequestContext } from '../../../../src/core/agent-runtime/tools/context.js';
import type { ExternalBrowserClaim } from '../../../../src/core/agent-runtime/tools/external-browser-bridge.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const scope = { sessionKey: 'task-a', channel: 'websocket', chatId: 'chat-a' };
const request = { origin: 'https://meeting.example', permission: 'camera' as const, allow: true };

function managedFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-task-site-permission-')); roots.push(root);
  const store = new BrowserSitePermissionStore(root);
  let url = `${request.origin}/room`;
  const page = { url: () => url, isClosed: () => false };
  const grants = new Map<string, string[]>();
  const context = { pages: () => [page],
    clearPermissions: vi.fn(async () => { grants.clear(); }),
    grantPermissions: vi.fn(async (permissions: string[], options: { origin: string }) => {
      grants.set(options.origin, permissions);
    }),
  };
  const manager = new BrowserSessionManager({}, { desktopManaged: false, embeddedBridge: null,
    embeddedRouter: null, externalRouter: null, sitePermissionStore: store, accessApproval: null });
  const key = JSON.stringify([scope.sessionKey, scope.channel, scope.chatId]);
  (manager as any).sessions.set(key, { key, scope, context, closed: false,
    mutex: { runExclusive: async (work: () => Promise<unknown>) => work() }, allowedOrigins: new Set() });
  return { manager, store, context, grants, navigate: (next: string) => { url = next; },
    close: async () => { (manager as any).sessions.clear(); await manager.close(); } };
}

it('keeps media grants scoped to this task context and origin, independent of browser allow-all', async () => {
  const f = managedFixture();
  try {
    fs.writeFileSync(path.join(path.dirname(f.store.filePath), 'allow-all-websites.json'), '{"version":1,"enabled":true}');
    fs.writeFileSync(path.join(path.dirname(f.store.filePath), 'allow-all-apps.json'), '{"version":1,"enabled":true}');
    await f.store.apply(f.context as any);
    expect(f.context.grantPermissions).not.toHaveBeenCalled();
    await expect(f.manager.setBrowserSitePermission({ ...scope, sessionKey: 'another-task' }, request))
      .rejects.toThrow(/already bound to this task/);
    expect(f.context.grantPermissions).not.toHaveBeenCalled();
    expect(JSON.parse(await f.manager.setBrowserSitePermission(scope, request)))
      .toEqual({ status: 'granted', origin: request.origin, permission: 'camera', allowed: true, lasts: 'task' });
    expect(f.grants.get(request.origin)).toEqual(['camera']);
    expect([...f.grants.keys()]).toEqual([request.origin]);
    expect(fs.existsSync(f.store.filePath)).toBe(false);
    expect(JSON.parse(await f.manager.setBrowserSitePermission(scope, { ...request, allow: false })))
      .toEqual({ status: 'revoked', origin: request.origin, permission: 'camera', allowed: false, lasts: 'task' });
    expect(f.grants.has(request.origin)).toBe(false);
    const other = { clearPermissions: vi.fn(async () => undefined), grantPermissions: vi.fn(async () => undefined) };
    await f.store.apply(other as any);
    expect(other.grantPermissions).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it('rejects a changed main origin and rolls back a permission if the page changes during its application', async () => {
  const f = managedFixture();
  try {
    f.navigate('https://other.example/');
    await expect(f.manager.setBrowserSitePermission(scope, request)).rejects.toThrow(/origin or task changed/);
    expect(f.context.grantPermissions).not.toHaveBeenCalled();
    f.navigate(`${request.origin}/room`);
    f.context.grantPermissions.mockImplementationOnce(async (permissions, options) => {
      f.grants.set(options.origin, permissions); f.navigate('https://other.example/');
    });
    await expect(f.manager.setBrowserSitePermission(scope, request)).rejects.toThrow(/origin or task changed/);
    expect(f.grants.has(request.origin)).toBe(false);
    f.navigate(`${request.origin}/room`);
    await f.manager.setBrowserSitePermission(scope, { ...request, permission: 'microphone' });
    expect(f.grants.get(request.origin)).toEqual(['microphone']);
  } finally { await f.close(); }
});

it('binds embedded media grants and revocations to the task tab and permits revocation after access is blocked', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-bound-media-permission-')); roots.push(root);
  let live: ExternalBrowserClaim = { connectionId: 'embedded', tabId: 7, browser: 'memmy', title: 'Meeting',
    url: `${request.origin}/room`, claimedAt: 1 };
  const claim = live;
  const command = vi.fn(async (_claim: unknown, name: string, args?: Record<string, unknown>) => {
    if (name === 'setSitePermission') return { status: args?.allow ? 'granted' : 'revoked',
      origin: args?.origin, permission: args?.permission, allowed: args?.allow };
    return {};
  });
  const authorize = vi.fn(async () => true);
  const router = new ExternalBrowserSessionRouter({ listClaims: () => [live], getClaim: () => live, command },
    authorize, 'embedded', new BrowserUseSitePolicyReader(path.join(root, 'site-policy.json')));
  router.selectClaim(scope, claim);
  try {
    await expect(router.setSitePermission({ ...scope, sessionKey: 'other-task' }, claim, request)).rejects.toThrow(/changed/);
    expect(command).not.toHaveBeenCalled();
    expect(JSON.parse(await router.setSitePermission(scope, claim, request)).status).toBe('granted');
    expect(authorize).toHaveBeenCalledOnce();
    authorize.mockResolvedValue(false);
    expect(JSON.parse(await router.setSitePermission(scope, claim, { ...request, allow: false })).status).toBe('revoked');
    expect(authorize).toHaveBeenCalledOnce();
    live = { ...live, url: 'https://other.example/room' };
    await expect(router.setSitePermission(scope, claim, request)).rejects.toThrow(/origin changed/);
    expect(command.mock.calls.filter(call => call[1] === 'setSitePermission')).toHaveLength(2);
  } finally { router.closeAll(); }
});

it('ends in-app media grants with the turn before cleanup yields and when the chat releases the tab', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-media-permission-turn-')); roots.push(root);
  const claim: ExternalBrowserClaim = { connectionId: 'embedded', tabId: 7, browser: 'memmy', title: 'Meeting',
    url: `${request.origin}/room`, claimedAt: 1 };
  const command = vi.fn(async (_claim: unknown, name: string, args?: Record<string, unknown>) => {
    if (name === 'setSitePermission') return { status: args?.allow ? 'granted' : 'revoked',
      origin: args?.origin, permission: args?.permission, allowed: args?.allow, lasts: 'task' };
    return {};
  });
  const refresh = vi.fn(async () => claim);
  const router = new ExternalBrowserSessionRouter({ listClaims: () => [claim], getClaim: () => claim, command, refresh },
    async () => true, 'embedded', new BrowserUseSitePolicyReader(path.join(root, 'site-policy.json')));
  const ended = () => command.mock.calls.filter(call => call[1] === 'endSitePermissions');
  router.selectClaim(scope, claim);
  try {
    await router.finishTurn(scope);
    expect(ended()).toEqual([]);
    router.selectClaim(scope, claim);
    expect(JSON.parse(await router.setSitePermission(scope, claim, request))).toMatchObject({ status: 'granted', lasts: 'task' });
    refresh.mockClear();
    const finishing = router.finishTurn(scope);
    expect(ended()).toEqual([[{ connectionId: 'embedded', tabId: 7 }, 'endSitePermissions']]);
    expect(refresh).not.toHaveBeenCalled();
    await finishing;
    await router.finishTurn(scope);
    expect(ended()).toHaveLength(1);
    router.selectClaim(scope, claim);
    await router.setSitePermission(scope, claim, { ...request, allow: false });
    router.closeSession(scope);
    expect(ended()).toHaveLength(2);
  } finally { router.closeAll(); }
});

it.each(['chrome', 'edge'] as const)('keeps %s media permission in normal browser UI and gives the Agent its next action', async browser => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-media-ui-permission-')); roots.push(root);
  const claim: ExternalBrowserClaim = { connectionId: browser, tabId: 7, browser, title: 'Meeting',
    url: `${request.origin}/room`, claimedAt: 1 };
  const command = vi.fn(async () => ({}));
  const router = new ExternalBrowserSessionRouter({ listClaims: () => [claim], getClaim: () => claim, command },
    async () => true, 'external', new BrowserUseSitePolicyReader(path.join(root, 'site-policy.json')));
  router.selectClaim(scope, claim);
  try {
    const result = JSON.parse(await router.setSitePermission(scope, claim, request));
    expect(result).toMatchObject({ status: 'requires_browser_ui', browser, ...request });
    expect(result.agentAction).toContain('use Computer Use');
    expect(result.agentAction).not.toMatch(/ask the user|manually/i);
    expect(command.mock.calls).toHaveLength(1);
    expect(command).toHaveBeenCalledWith(claim, 'allowOrigin', { origin: request.origin });
  } finally { router.closeAll(); }
});

it('requires an interactive trusted tool context and exposes secure form capability without signup bans', async () => {
  const manager = { setBrowserSitePermission: vi.fn(async () => '{}') } as any;
  const tool = new BrowserSitePermissionTool(manager);
  await expect(tool.execute(request)).rejects.toThrow(/interactive desktop chat/);
  tool.setContext(new RequestContext({ ...scope, workspace: '/task', channel: 'cron' }));
  await expect(tool.execute(request)).rejects.toThrow(/interactive desktop chat/);
  tool.setContext(new RequestContext({ ...scope, workspace: '/task' }));
  await tool.execute(request);
  expect(manager.setBrowserSitePermission).toHaveBeenCalledWith(scope, request, undefined);
  const secure = new BrowserAuthRequestTool(manager);
  expect(secure.description).toContain('secure web form');
  expect(secure.description).not.toMatch(/not for signup|not signup/i);
});
