import { expect, it, vi } from "vitest";
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserListTabsTool, BrowserSessionManager } from "../../../../src/core/agent-runtime/tools/browser.js";
import type { EmbeddedBrowserBridge } from '../../../../src/core/agent-runtime/tools/embedded-browser-bridge.js';
import { RequestContext } from '../../../../src/core/agent-runtime/tools/context.js';
import type { ExternalBrowserState } from '@memmy/local-api-contracts';
import type { ExternalBrowserSessionRouter } from "../../../../src/core/agent-runtime/tools/external-browser-session-router.js";
import { OpenAICompatProvider } from "../../../../src/providers/openai-compat-provider.js";
import { findByName } from "../../../../src/providers/registry.js";
import { estimateMessageTokens } from "../../../../src/utils/helpers.js";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function discoveryFixture(browser: 'chrome' | 'edge' = 'chrome') {
  let connected = false;
  const scope = { sessionKey: 'first-connect', channel: 'projected-session', chatId: 'first-connect' };
  const router = {
    listTabs: vi.fn(async () => ({ connectedBrowsers: connected ? [browser] : [], tabs: [], tabStatuses: [],
      pageDiscoveryStatus: 'ready' as 'ready' | 'unresponsive' })),
    waitForConnection: vi.fn(async (_browser: string, _timeout: number, _signal?: AbortSignal) => { connected = true; return true; }),
    finishTurn: vi.fn(async () => undefined), closeAll: vi.fn(),
  };
  const bridge = {
    getExternalBrowserState: vi.fn(async (): Promise<ExternalBrowserState> => ({ installation: {
      chrome: { installed: true, enabled: true }, edge: { installed: true, enabled: true },
    }, runningBrowsers: [browser] })),
    recoverExternalBrowser: vi.fn(async () => 'woken'),
    listTabs: vi.fn(async () => ({ tabs: [], browserId: null, selectedTabId: null })), close: vi.fn(),
  };
  const manager = new BrowserSessionManager({ enabled: true }, {
    desktopManaged: true, externalRouter: router as unknown as ExternalBrowserSessionRouter,
    embeddedBridge: bridge as unknown as EmbeddedBrowserBridge, embeddedRouter: null,
  });
  return { manager, router, bridge, scope, connect: () => { connected = true; } };
}

it.each(['chrome', 'edge'] as const)('wakes an installed running %s and waits for its extension before returning discovery', async browser => {
  const f = discoveryFixture(browser);
  try {
    const result = JSON.parse(await f.manager.listBrowserTabs(f.scope, browser));
    expect(f.bridge.getExternalBrowserState).toHaveBeenCalledOnce();
    expect(f.bridge.recoverExternalBrowser).toHaveBeenCalledWith(browser, expect.any(AbortSignal));
    expect(f.router.waitForConnection).toHaveBeenCalledWith(browser, 45_000, expect.any(AbortSignal));
    expect(f.router.listTabs).toHaveBeenCalledTimes(2);
    expect(result.connectionStatus).toEqual([{ browser, installed: true, enabled: true, running: true,
      connected: true, recovery: 'woken', waitTimeoutMs: 45_000 }]);
    expect(result.extensionSetup).toBeUndefined();
    expect(f.bridge.listTabs).not.toHaveBeenCalled();
  } finally { await f.manager.close(); }
});

it('returns a connected extension immediately even when it has no controllable tabs', async () => {
  const f = discoveryFixture(); f.connect();
  try {
    const result = JSON.parse(await f.manager.listBrowserTabs(f.scope, 'chrome'));
    expect(result.connectionStatus).toEqual([{ browser: 'chrome', installed: true, enabled: true,
      running: true, connected: true, recovery: 'not_needed', waitTimeoutMs: 0 }]);
    expect(result.extensionSetup).toBeUndefined();
    expect(f.bridge.getExternalBrowserState).not.toHaveBeenCalled();
    expect(f.bridge.recoverExternalBrowser).not.toHaveBeenCalled();
    expect(f.router.waitForConnection).not.toHaveBeenCalled();
  } finally { await f.manager.close(); }
});

it.each([false, true])('recovers an unresponsive connected browser and preserves its connection facts (stillUnresponsive=%s)', async stillUnresponsive => {
  const f = discoveryFixture(); f.connect();
  const unresponsive = { connectedBrowsers: ['chrome' as const], tabs: [], tabStatuses: [],
    pageDiscoveryStatus: 'unresponsive' as const };
  if (stillUnresponsive) f.router.listTabs.mockResolvedValue(unresponsive);
  else f.router.listTabs.mockResolvedValueOnce(unresponsive);
  try {
    const result = JSON.parse(await f.manager.listBrowserTabs(f.scope, 'chrome'));
    expect(f.bridge.recoverExternalBrowser).toHaveBeenCalledWith('chrome', expect.any(AbortSignal));
    expect(f.router.listTabs).toHaveBeenCalledTimes(2);
    expect(result.connectedBrowsers).toEqual(['chrome']);
    expect(result.extensionSetup).toBeUndefined();
    expect(result.pageDiscoveryStatus).toBe(stillUnresponsive ? 'unresponsive' : 'ready');
    expect(result.connectionStatus[0]).toMatchObject({ connected: true, installed: true, enabled: true,
      running: true, recovery: 'woken' });
    expect(result.connectionStatus[0].reason).toBe(stillUnresponsive ? 'page_discovery_unresponsive' : undefined);
  } finally { await f.manager.close(); }
});

it.each([
  { installed: false, enabled: false, running: true, reason: 'not_installed', installRequired: true },
  { installed: true, enabled: true, running: false, reason: 'browser_not_running', installRequired: false },
  { installed: true, enabled: false, running: true, reason: 'extension_disabled', installRequired: false },
])('does not wait or wake on a confirmed $reason', async ({ installed, enabled, running, reason, installRequired }) => {
  const f = discoveryFixture();
  f.bridge.getExternalBrowserState.mockResolvedValue({ installation: {
    chrome: { installed, enabled }, edge: { installed: true, enabled: true },
  }, runningBrowsers: running ? ['chrome'] : [] });
  try {
    const result = JSON.parse(await f.manager.listBrowserTabs(f.scope, 'chrome'));
    expect(result.connectionStatus).toEqual([{ browser: 'chrome', installed, enabled, running,
      connected: false, recovery: 'not_attempted', waitTimeoutMs: 0, reason }]);
    expect(result.extensionSetup.installRequired).toEqual(installRequired ? ['chrome'] : []);
    expect(f.bridge.recoverExternalBrowser).not.toHaveBeenCalled();
    expect(f.router.waitForConnection).not.toHaveBeenCalled();
  } finally { await f.manager.close(); }
});

it('uses a short reconnect grace when metadata is unknown and never infers missing installation', async () => {
  const f = discoveryFixture();
  f.bridge.getExternalBrowserState.mockRejectedValue(new Error('probe unavailable'));
  f.router.waitForConnection.mockResolvedValue(false);
  try {
    const result = JSON.parse(await f.manager.listBrowserTabs(f.scope, 'chrome'));
    expect(f.router.waitForConnection).toHaveBeenCalledWith('chrome', 2_000, expect.any(AbortSignal));
    expect(f.bridge.recoverExternalBrowser).not.toHaveBeenCalled();
    expect(result.connectionStatus).toEqual([{ browser: 'chrome', installed: null, enabled: null,
      running: null, connected: false, recovery: 'not_attempted', waitTimeoutMs: 2_000, reason: 'state_unknown' }]);
    expect(result.extensionSetup.installRequired).toEqual([]);
    expect(result.extensionSetup.note).not.toMatch(/not installed, or/);
  } finally { await f.manager.close(); }
});

it('keeps discovery bounded and reports a reconnect timeout without suggesting reinstallation', async () => {
  const f = discoveryFixture(); f.router.waitForConnection.mockResolvedValue(false);
  try {
    const result = JSON.parse(await f.manager.listBrowserTabs(f.scope, 'chrome'));
    expect(result.connectionStatus[0]).toMatchObject({ connected: false, installed: true,
      reason: 'connection_timeout', recovery: 'woken', waitTimeoutMs: 45_000 });
    expect(result.extensionSetup.installRequired).toEqual([]);
  } finally { await f.manager.close(); }
});

it.each((['chrome', 'edge'] as const).flatMap(browser => [
  { browser, installed: null, enabled: null },
  { browser, installed: true, enabled: null },
  { browser, installed: null, enabled: true },
]))('recovers a requested running $browser when installation metadata is unreadable: $installed/$enabled', async ({ browser, installed, enabled }) => {
  const f = discoveryFixture(browser);
  f.bridge.getExternalBrowserState.mockResolvedValue({ installation: {
    chrome: { installed: null, enabled: null }, edge: { installed: null, enabled: null },
    [browser]: { installed, enabled },
  }, runningBrowsers: [browser] });
  try {
    const result = JSON.parse(await f.manager.listBrowserTabs(f.scope, browser));
    expect(f.bridge.recoverExternalBrowser).toHaveBeenCalledWith(browser, expect.any(AbortSignal));
    expect(f.router.waitForConnection).toHaveBeenCalledWith(browser, 45_000, expect.any(AbortSignal));
    // Only the authenticated extension handshake promotes unknown metadata to true.
    expect(result.connectionStatus).toEqual([{ browser, installed: true, enabled: true, running: true,
      connected: true, recovery: 'woken', waitTimeoutMs: 45_000 }]);
    expect(result.extensionSetup).toBeUndefined();
  } finally { await f.manager.close(); }
});

it.each(['woken', 'failed', 'unavailable', 'throw'] as const)('waits for a live handshake after %s recovery with unreadable installation metadata', async outcome => {
  const f = discoveryFixture();
  f.bridge.getExternalBrowserState.mockResolvedValue({ installation: {
    chrome: { installed: null, enabled: null }, edge: { installed: null, enabled: null },
  }, runningBrowsers: ['chrome'] });
  if (outcome === 'throw') f.bridge.recoverExternalBrowser.mockRejectedValue(new Error('launch failed'));
  else f.bridge.recoverExternalBrowser.mockResolvedValue(outcome);
  f.router.waitForConnection.mockResolvedValue(false);
  try {
    const result = JSON.parse(await f.manager.listBrowserTabs(f.scope, 'chrome'));
    expect(f.bridge.recoverExternalBrowser).toHaveBeenCalledOnce();
    expect(f.router.waitForConnection).toHaveBeenCalledWith('chrome', 45_000, expect.any(AbortSignal));
    expect(result.connectionStatus).toEqual([{ browser: 'chrome', installed: null, enabled: null, running: true,
      connected: false, recovery: outcome === 'throw' ? 'failed' : outcome, waitTimeoutMs: 45_000, reason: 'connection_timeout' }]);
    expect(result.extensionSetup.installRequired).toEqual([]);
  } finally { await f.manager.close(); }
});

it('keeps recovery passive when only the running-browser probe is unavailable', async () => {
  const f = discoveryFixture();
  f.bridge.getExternalBrowserState.mockResolvedValue({ installation: {
    chrome: { installed: true, enabled: true }, edge: { installed: null, enabled: null },
  }, runningBrowsers: null });
  f.router.waitForConnection.mockResolvedValue(false);
  try {
    const result = JSON.parse(await f.manager.listBrowserTabs(f.scope, 'chrome'));
    expect(f.bridge.recoverExternalBrowser).not.toHaveBeenCalled();
    expect(f.router.waitForConnection).toHaveBeenCalledWith('chrome', 2_000, expect.any(AbortSignal));
    expect(result.connectionStatus[0]).toMatchObject({ running: null, recovery: 'not_attempted', reason: 'state_unknown' });
  } finally { await f.manager.close(); }
});

it.each(['system', 'cron', 'readonly'] as const)('does not wake or wait for browser recovery in a %s context', async kind => {
  const f = discoveryFixture();
  const tool = new BrowserListTabsTool(f.manager);
  tool.setContext(new RequestContext({ ...f.scope, workspace: '/tmp/test',
    channel: kind === 'readonly' ? f.scope.channel : kind,
    metadata: { computerUseInteractive: kind === 'readonly' ? false : true } }));
  try {
    const result = JSON.parse(await tool.execute({ targetBrowser: 'chrome' }));
    expect(f.bridge.recoverExternalBrowser).not.toHaveBeenCalled();
    expect(f.router.waitForConnection).not.toHaveBeenCalled();
    expect(result.connectionStatus[0]).toMatchObject({ recovery: 'not_attempted', reason: 'recovery_not_allowed' });
    expect(tool.readOnly).toBe(false);
  } finally { await f.manager.close(); }
});

it.each([undefined, 'memmy'] as const)('does not wake or wait during untargeted/%s discovery', async target => {
  const f = discoveryFixture();
  try {
    await f.manager.listBrowserTabs(f.scope, target);
    expect(f.bridge.getExternalBrowserState).not.toHaveBeenCalled();
    expect(f.bridge.recoverExternalBrowser).not.toHaveBeenCalled();
    expect(f.router.waitForConnection).not.toHaveBeenCalled();
  } finally { await f.manager.close(); }
});

it.each(['abort', 'finish'] as const)('cancels connection recovery when the owning turn ends through %s', async end => {
  const f = discoveryFixture();
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  f.router.waitForConnection.mockImplementation((_browser, _timeout, signal) =>
    new Promise<boolean>((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(new Error('Browser operation was canceled')), { once: true });
      began();
    }));
  const tool = new BrowserListTabsTool(f.manager);
  tool.setContext(new RequestContext({ ...f.scope, workspace: '/tmp/test' }));
  const controller = new AbortController();
  const pending = tool.execute({ targetBrowser: 'chrome' }, { abortSignal: controller.signal });
  const rejected = expect(pending).rejects.toThrow(/canceled|finished turn/);
  try {
    await started;
    if (end === 'abort') controller.abort();
    else await f.manager.closeSurfacesForTurn(f.scope);
    await rejected;
    expect(f.router.listTabs).toHaveBeenCalledOnce();
  } finally { await f.manager.close(); }
});

it('never wakes the browser if its turn finishes while the metadata probe is pending', async () => {
  const f = discoveryFixture();
  let finishProbe!: (state: ExternalBrowserState) => void;
  let probeStarted!: () => void;
  const started = new Promise<void>(resolve => { probeStarted = resolve; });
  f.bridge.getExternalBrowserState.mockImplementation(() => new Promise<ExternalBrowserState>(resolve => {
    finishProbe = resolve; probeStarted();
  }));
  const pending = f.manager.listBrowserTabs(f.scope, 'chrome');
  const rejected = expect(pending).rejects.toThrow(/canceled|finished turn/);
  try {
    await started;
    await f.manager.closeSurfacesForTurn(f.scope);
    finishProbe({ installation: { chrome: { installed: true, enabled: true }, edge: { installed: false, enabled: false } },
      runningBrowsers: ['chrome'] });
    await rejected;
    expect(f.bridge.recoverExternalBrowser).not.toHaveBeenCalled();
    expect(f.router.waitForConnection).not.toHaveBeenCalled();
  } finally { await f.manager.close(); }
});

it('keeps the next turn cancelable when a finished discovery cleans up after that next turn has begun', async () => {
  const f = discoveryFixture();
  const first = new AbortController();
  let resolveFirst!: (connected: boolean) => void;
  let firstStarted!: () => void;
  let secondStarted!: () => void;
  const startedFirst = new Promise<void>(resolve => { firstStarted = resolve; });
  const startedSecond = new Promise<void>(resolve => { secondStarted = resolve; });
  let secondSignal: AbortSignal | undefined;
  f.router.waitForConnection
    .mockImplementationOnce(() => new Promise<boolean>(resolve => { resolveFirst = resolve; firstStarted(); }))
    .mockImplementationOnce((_browser, _timeout, signal) => new Promise<boolean>((_resolve, reject) => {
      secondSignal = signal;
      signal!.addEventListener('abort', () => reject(new Error('Browser operation was canceled')), { once: true });
      secondStarted();
    }));
  const firstPending = f.manager.listBrowserTabs(f.scope, 'chrome', first.signal);
  const firstRejected = expect(firstPending).rejects.toThrow(/canceled|finished turn/);
  try {
    await startedFirst;
    await f.manager.closeSurfacesForTurn(f.scope);
    const secondPending = f.manager.listBrowserTabs(f.scope, 'chrome');
    const secondRejected = expect(secondPending).rejects.toThrow(/canceled|finished turn/);
    await startedSecond;
    resolveFirst(false);
    await firstRejected;
    expect(secondSignal?.aborted).toBe(false);
    await f.manager.closeSurfacesForTurn(f.scope);
    expect(secondSignal?.aborted).toBe(true);
    await secondRejected;
  } finally { await f.manager.close(); }
});

it.each([
  { browser: 'chrome' as const, explicit: true },
  { browser: 'edge' as const, explicit: true },
  { browser: 'chrome' as const, explicit: false },
  { browser: 'edge' as const, explicit: false },
])('sends $browser screenshots as image inputs for explicit=$explicit targeting', async ({ browser, explicit }) => {
  const scope = { sessionKey: 'screenshots', channel: 'projected-session', chatId: 'screenshots' };
  const claim = { connectionId: 'browser', tabId: 5, browser,
    title: 'Product', url: 'https://example.test/', claimedAt: 1 };
  const raw = [
    { type: 'text', text: 'Screenshot saved to the browser output directory.' },
    { type: 'image', mimeType: 'image/png', data: PNG_BASE64 },
  ];
  const router = {
    select: vi.fn(() => claim), selectBrowser: vi.fn(() => claim),
    call: vi.fn(async () => raw), closeAll: vi.fn(),
  } as unknown as ExternalBrowserSessionRouter;
  const manager = new BrowserSessionManager({ enabled: true }, {
    desktopManaged: false, externalRouter: router, embeddedBridge: null,
    runtimeLoader: vi.fn(async () => { throw new Error('Playwright should not start'); }),
  });
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-screenshot-model-input-'));
  vi.stubEnv('MEMMY_AGENT_DATA_DIR', dataRoot);
  try {
    const messages: Record<string, any>[] = [{ role: 'user', content: 'B' }];
    for (let index = 0; index < 4; index += 1) {
      const content = await manager.callTool(scope, 'browser_take_screenshot',
        explicit ? { targetBrowser: browser, type: 'png' } : { type: 'png' });
      expect(content).toEqual([
        raw[0],
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BASE64}`, detail: 'auto' },
          meta: { path: expect.any(String) } },
      ]);
      const image = (content as Record<string, any>[])[1];
      expect(fs.readFileSync(image.meta.path)).toEqual(Buffer.from(PNG_BASE64, 'base64'));
      const id = `screenshot-${index}`;
      messages.push({ role: 'assistant', content: '', tool_calls: [
        { id, type: 'function', function: { name: 'browser_take_screenshot', arguments: '{}' } },
      ] }, { role: 'tool', tool_call_id: id, name: 'browser_take_screenshot', content });
      expect(estimateMessageTokens(messages.at(-1)!)).toBeLessThan(5_000);
    }
    for (const provider of [
      new OpenAICompatProvider({ apiKey: 'test', defaultModel: 'agent_chat', spec: findByName('memmy_account') }),
      new OpenAICompatProvider({ apiKey: 'test', defaultModel: 'vision-model' }),
    ]) {
      const body = provider.buildKwargs({ messages });
      const toolMessages = body.messages.filter((message: any) => message.role === 'tool');
      expect(toolMessages).toHaveLength(4);
      expect(toolMessages.map((message: any) => message.content).join('\n')).not.toContain(PNG_BASE64);
      const images = body.messages.flatMap((message: any) =>
        Array.isArray(message.content) ? message.content.filter((block: any) => block.type === 'image_url') : []);
      expect(images).toHaveLength(4);
      expect(images.every((image: any) => image.image_url.url === `data:image/png;base64,${PNG_BASE64}`)).toBe(true);
    }
    expect(raw[1]).toEqual({ type: 'image', mimeType: 'image/png', data: PNG_BASE64 });
  } finally {
    await manager.close();
    vi.unstubAllEnvs();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

it.each([
  { data: 'invalid-base64-payload', mimeType: 'image/png' },
  { data: PNG_BASE64, mimeType: 'image/jpeg' },
])('does not forward malformed screenshot bytes as model text ($mimeType)', async (image) => {
  const scope = { sessionKey: 'invalid-image', channel: 'projected-session', chatId: 'invalid-image' };
  const claim = { connectionId: 'browser', tabId: 5, browser: 'edge' as const,
    title: 'Product', url: 'https://example.test/', claimedAt: 1 };
  const router = { select: () => claim,
    call: vi.fn(async () => [{ type: 'image', ...image }]), closeAll: vi.fn(),
  } as unknown as ExternalBrowserSessionRouter;
  const manager = new BrowserSessionManager({ enabled: true }, {
    desktopManaged: false, externalRouter: router, embeddedBridge: null,
  });
  try {
    const content = await manager.callTool(scope, 'browser_take_screenshot', {});
    expect(content).toEqual([{ type: 'text', text: expect.stringContaining('[image unavailable:') }]);
    expect(JSON.stringify(content)).not.toContain(image.data);
  } finally { await manager.close(); }
});

it("routes Agent tools and sidebar actions to the claimed external tab without launching Playwright", async () => {
  const scope = { sessionKey: "chat", channel: "projected-session", chatId: "chat" };
  const claim = { connectionId: "browser", tabId: 5, browser: "chrome" as const,
    title: "Test", url: "https://example.test/", claimedAt: 1 };
  const router = {
    select: vi.fn(() => claim),
    call: vi.fn(async () => [{ type: "text", text: "[ax-1] button" }]),
    handleSurfaceAction: vi.fn(async () => true),
    closeSession: vi.fn(), closeChat: vi.fn(), finishTurn: vi.fn(async () => undefined), closeAll: vi.fn(),
  } as unknown as ExternalBrowserSessionRouter;
  const manager = new BrowserSessionManager({ enabled: true }, {
    desktopManaged: false, externalRouter: router,
    runtimeLoader: vi.fn(async () => { throw new Error("Playwright should not start"); }),
  });
  expect(await manager.callTool(scope, "browser_snapshot", {})).toEqual([
    { type: "text", text: "[ax-1] button" },
  ]);
  expect(router.select).toHaveBeenCalledWith(scope, false);
  expect(router.call).toHaveBeenCalledWith(scope, claim, "browser_snapshot", {}, null);
  const action = { type: "memmy:computer-use-surface:action" as const,
    surface: "browser" as const, ...scope, targetId: "external:browser:5",
    action: "click" as const, x: 0.2, y: 0.3 };
  await (manager as any).handleSurfaceAction(action);
  expect(router.handleSurfaceAction).toHaveBeenCalledWith(action);
  await manager.closeSurfacesForTurn(scope);
  expect(router.finishTurn).toHaveBeenCalledWith(scope);
  await manager.closeSession(scope);
  expect(router.closeSession).toHaveBeenCalledWith(scope);
  await manager.close();
  expect(router.closeAll).toHaveBeenCalledOnce();
});

it('routes external uploads through workspace validation and the approval path', async () => {
  const scope = { sessionKey: 'upload', channel: 'projected-session', chatId: 'upload' };
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-external-upload-'));
  const source = path.join(workspace, 'document.txt');
  fs.writeFileSync(source, 'test');
  const claim = { connectionId: 'browser', tabId: 5, browser: 'chrome' as const,
    title: 'Form', url: 'https://example.test/form', claimedAt: 1 };
  const upload = vi.fn(async () => [{ type: 'text', text: '{"uploaded":1}' }]);
  const router = { select: () => claim, upload, closeAll: vi.fn() } as unknown as ExternalBrowserSessionRouter;
  const manager = new BrowserSessionManager({ enabled: true }, {
    desktopManaged: false, externalRouter: router, embeddedBridge: null,
    runtimeLoader: vi.fn(async () => { throw new Error('Playwright should not start'); }),
  });
  try {
    await expect(manager.callTool(scope, 'browser_file_upload', { target: 'ax-1', paths: ['/etc/passwd'] },
      null, { workspace, readonlyRoots: [] })).rejects.toThrow(/outside the trusted workspace/);
    expect(upload).not.toHaveBeenCalled();
    await manager.callTool(scope, 'browser_file_upload', { target: 'ax-1', paths: [source] },
      null, { workspace, readonlyRoots: [] });
    expect(upload).toHaveBeenCalledWith(scope, claim, { target: 'ax-1', paths: [source] },
      expect.any(Function), null);
  } finally { await manager.close(); fs.rmSync(workspace, { recursive: true, force: true }); }
});
