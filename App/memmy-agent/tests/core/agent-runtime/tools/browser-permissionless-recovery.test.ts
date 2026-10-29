import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { WebSocket } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import type { ExternalBrowserState } from '@memmy/local-api-contracts';
import { BrowserListTabsTool, BrowserSessionManager } from '../../../../src/core/agent-runtime/tools/browser.js';
import { RequestContext } from '../../../../src/core/agent-runtime/tools/context.js';
import type { EmbeddedBrowserBridge } from '../../../../src/core/agent-runtime/tools/embedded-browser-bridge.js';
import { ExternalBrowserBridge, EXTERNAL_BROWSER_BRIDGE_PORTS,
  MEMMY_BROWSER_EXTENSION_ID } from '../../../../src/core/agent-runtime/tools/external-browser-bridge.js';
import { ExternalBrowserSessionRouter } from '../../../../src/core/agent-runtime/tools/external-browser-session-router.js';

type BrowserName = 'chrome' | 'edge';

// Execute the current Shell probe source without pulling another workspace into
// the Agent's TypeScript rootDir. Its imports are only Node builtins after types are erased.
const probeSource = fs.readFileSync(new URL('../../../../../shell/desktop/src/main/installed-external-browsers.ts', import.meta.url), 'utf8');
const compiledProbe = ts.transpileModule(probeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const probeModule = { exports: {} };
Function('require', 'module', 'exports', compiledProbe)(createRequire(import.meta.url), probeModule, probeModule.exports);
const { probeExternalBrowserInstallation } = probeModule.exports as {
  probeExternalBrowserInstallation(options: {
    platform: 'darwin' | 'win32'; home: string; env: NodeJS.ProcessEnv;
    fileExists(file: string): boolean; readFile(file: string): string;
  }): ExternalBrowserState['installation'];
};

const sockets: WebSocket[] = [];
const bridges: ExternalBrowserBridge[] = [];
const managers: BrowserSessionManager[] = [];
const roots: string[] = [];
const wakeTimers: ReturnType<typeof setTimeout>[] = [];

afterEach(async () => {
  for (const timer of wakeTimers.splice(0)) clearTimeout(timer);
  await Promise.all(managers.splice(0).map(manager => manager.close()));
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(bridges.splice(0).map(bridge => bridge.close()));
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** An isolated extension runtime: real hello/ready/refresh messages, no browser or page access. */
async function startProfileRuntime(port: number, browser: BrowserName): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
    origin: `chrome-extension://${MEMMY_BROWSER_EXTENSION_ID}`,
  });
  sockets.push(socket);
  const ready = new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.on('message', raw => {
      const message = JSON.parse(String(raw));
      if (message.type === 'ready') resolve();
      else if (message.type === 'refresh_tabs') {
        socket.send(JSON.stringify({ type: 'response', id: message.id, ok: true }));
      }
    });
    socket.once('open', () => socket.send(JSON.stringify({
      type: 'hello', browser, extensionVersion: '1.0.12', capabilities: ['openTab'],
    })));
  });
  await ready;
  return socket;
}

const scenarios = (['darwin', 'win32'] as const).flatMap(platform =>
  (['chrome', 'edge'] as const).flatMap(browser =>
    (['EPERM', 'EACCES'] as const).map(code => ({ platform, browser, code }))));

it.each(scenarios)('recovers $browser after profile teardown with $code metadata on $platform', async ({ platform, browser, code }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-permissionless-recovery-'));
  roots.push(root);
  vi.stubEnv('MEMMY_AGENT_DATA_DIR', path.join(root, 'agent'));
  const bridge = new ExternalBrowserBridge(); bridges.push(bridge);
  const { port } = await bridge.start(0);
  expect(EXTERNAL_BROWSER_BRIDGE_PORTS).not.toContain(port);
  const oldRuntime = await startProfileRuntime(port, browser);
  expect(bridge.listConnected()).toEqual([browser]);

  // The browser process survives, but the profile/worker lifetime ends with a real 1001 close.
  const closed = once(oldRuntime, 'close');
  oldRuntime.close(1001, 'profile runtime stopped');
  await closed;
  await vi.waitFor(() => {
    expect(bridge.listConnected()).toEqual([]);
    expect(bridge.connectionDiagnostics().events).toContainEqual(expect.objectContaining({
      stage: 'disconnected', browser, closeCode: 1001,
    }));
  });

  const readMetadata = vi.fn((_file: string): string => {
    throw Object.assign(new Error('Fixture metadata access denied'), { code });
  });
  const installation = probeExternalBrowserInstallation({ platform,
    home: platform === 'darwin' ? '/fixture/home' : 'C:\\fixture',
    env: { LOCALAPPDATA: 'C:\\fixture\\AppData\\Local' },
    fileExists: () => true, readFile: readMetadata,
  });
  expect(readMetadata).toHaveBeenCalled();
  expect(installation[browser]).toEqual({ installed: null, enabled: null });
  const state: ExternalBrowserState = { installation, runningBrowsers: [browser] };
  const router = new ExternalBrowserSessionRouter(bridge, async () => false);
  const waitForConnection = vi.spyOn(router, 'waitForConnection');
  let revived: Promise<WebSocket> | undefined;
  const wakeBrowser = vi.fn(async (target: BrowserName, signal?: AbortSignal) => {
    expect(target).toBe(browser);
    expect(signal?.aborted).toBe(false);
    // Model only OS activation. It does not install, enable, reload, navigate, or edit a profile.
    revived = new Promise<WebSocket>((resolve, reject) => {
      wakeTimers.push(setTimeout(() => { void startProfileRuntime(port, target).then(resolve, reject); }, 25));
    });
    void revived.catch(() => undefined);
    return 'woken' as const;
  });
  const embedded = {
    getExternalBrowserState: vi.fn(async () => state), recoverExternalBrowser: wakeBrowser,
    listTabs: vi.fn(async () => ({ tabs: [], browserId: null, selectedTabId: null })), close: vi.fn(),
  };
  const manager = new BrowserSessionManager({ enabled: true }, { desktopManaged: true,
    externalRouter: router, embeddedRouter: null, embeddedBridge: embedded as unknown as EmbeddedBrowserBridge });
  managers.push(manager);
  const tool = new BrowserListTabsTool(manager);
  tool.setContext(new RequestContext({ sessionKey: 'profile-recovery', channel: 'projected-session',
    chatId: 'profile-recovery', workspace: root, metadata: { computerUseInteractive: true } }));
  const result = JSON.parse(await tool.execute({ targetBrowser: browser }));

  expect(wakeBrowser).toHaveBeenCalledExactlyOnceWith(browser, expect.any(AbortSignal));
  expect(waitForConnection).toHaveBeenCalledExactlyOnceWith(browser, 45_000, expect.any(AbortSignal));
  expect(revived).toBeDefined();
  await revived;
  expect(result.connectedBrowsers).toEqual([browser]);
  expect(result.connectionStatus).toEqual([expect.objectContaining({ browser, connected: true,
    recovery: 'woken', waitTimeoutMs: 45_000 })]);
  expect(result.tabs).toEqual([]);
  expect(result.extensionSetup).toBeUndefined();
  expect(state.installation[browser]).toEqual({ installed: null, enabled: null });
  expect(embedded.listTabs).not.toHaveBeenCalled();
  expect(bridge.connectionDiagnostics().events.map(event => event.stage)).toEqual([
    'listening', 'connected', 'disconnected', 'connected',
  ]);
});
