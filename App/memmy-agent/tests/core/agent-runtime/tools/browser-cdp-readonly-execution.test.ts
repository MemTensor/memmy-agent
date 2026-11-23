import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { ExternalBrowserSessionRouter } from '../../../../src/core/agent-runtime/tools/external-browser-session-router.js';
import { BrowserUseSitePolicyReader } from '../../../../src/core/agent-runtime/tools/browser-use-site-policy-store.js';
import type { ExternalBrowserBridge, ExternalBrowserClaim } from '../../../../src/core/agent-runtime/tools/external-browser-bridge.js';

const origin = 'https://example.test';
const scope = { sessionKey: 'cdp-read', channel: 'test', chatId: 'cdp-read' };
const claim: ExternalBrowserClaim = { connectionId: 'test', tabId: 7, browser: 'chrome',
  title: 'Test', url: `${origin}/`, claimedAt: 1 };
const source = fs.readFileSync(new URL(
  '../../../../../shell/desktop/extensions/memmy-browser/background.js', import.meta.url), 'utf8');

function fixture() {
  // Execute the complete extension worker. Only the Chrome API and transport are mocked;
  // the router, extension dispatch, parameter validation and CDP command path are real.
  const sendCommand = vi.fn(async (_target: unknown, method: string, _params: Record<string, unknown>) => {
    if (method === 'Runtime.evaluate') return { result: { type: 'number', value: 2 } };
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'Page.captureScreenshot') return { data: 'test-image' };
    return {};
  });
  const listener = { addListener() {} };
  const context = vm.createContext({
    chrome: {
      runtime: { onMessage: listener },
      storage: { session: { get: async () => ({}), set: async () => {} } },
      tabs: { get: async () => ({ id: claim.tabId, url: claim.url }),
        onRemoved: listener, onUpdated: listener, onActivated: listener },
      windows: { onFocusChanged: listener },
      debugger: { sendCommand, onDetach: listener, onEvent: listener },
    },
    WebSocket: class { static OPEN = 1; },
    navigator: { userAgent: 'Chrome/154', platform: 'Win32' },
    URL, setTimeout, clearTimeout,
  });
  vm.runInContext(source, context);
  vm.runInContext(`claims.set(7, newClaim(7, ${JSON.stringify(origin)}))`, context);
  const execute = async (operation: string, args: Record<string, unknown>) => {
    Object.assign(context, { request: { operation, args } });
    return await vm.runInContext("run(7, request.operation, request.args, 'cdp-test')", context);
  };
  const bridge = {
    listClaims: () => [claim], getClaim: () => claim,
    command: vi.fn(async (_claim: unknown, operation: string, args: Record<string, unknown>) => execute(operation, args)),
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-read-execution-'));
  const router = new ExternalBrowserSessionRouter(bridge as unknown as ExternalBrowserBridge,
    async () => true, 'external', new BrowserUseSitePolicyReader(path.join(directory, 'policy.json')));
  router.selectClaim(scope, claim);
  return { router, execute, sendCommand, close() {
    router.closeAll();
    fs.rmSync(directory, { recursive: true, force: true });
  } };
}

const reads = [
  { method: 'Runtime.evaluate', params: { expression: '1+1' },
    expected: { expression: '1+1', throwOnSideEffect: true, returnByValue: true,
      awaitPromise: false, userGesture: false }, result: { result: { type: 'number', value: 2 } } },
  { method: 'DOM.getDocument', params: {}, expected: { depth: 1, pierce: false }, result: { root: { nodeId: 1 } } },
  { method: 'DOM.getDocument', params: { depth: 3 }, expected: { depth: 3, pierce: false }, result: { root: { nodeId: 1 } } },
  { method: 'Page.captureScreenshot', params: {}, expected: { format: 'png', captureBeyondViewport: false }, result: { data: 'test-image' } },
  { method: 'Page.captureScreenshot', params: { format: 'jpeg' }, expected: { format: 'jpeg', captureBeyondViewport: false }, result: { data: 'test-image' } },
  { method: 'Page.getLayoutMetrics', params: {}, expected: {}, result: {} },
  { method: 'Accessibility.getFullAXTree', params: {}, expected: {}, result: {} },
];

describe('read-only CDP router to extension execution', () => {
  it.each(reads)('sends $method through both validators to Chrome', async ({ method, params, expected, result }) => {
    const test = fixture();
    try {
      const output = await test.router.cdp(scope, claim, 'cdpCall', { method, params }, async () => true);
      expect(JSON.parse(output)).toEqual(result);
      expect(test.sendCommand).toHaveBeenCalledExactlyOnceWith({ tabId: 7 }, method, expected);
      // The executor's output must also survive another trip through both layers.
      const sentParams = test.sendCommand.mock.calls[0][2];
      test.sendCommand.mockClear();
      const repeated = await test.router.cdp(scope, claim, 'cdpCall', { method, params: sentParams }, async () => true);
      expect(JSON.parse(repeated)).toEqual(result);
      expect(test.sendCommand).toHaveBeenCalledExactlyOnceWith({ tabId: 7 }, method, expected);
    } finally { test.close(); }
  });

  it.each([
    ['Runtime.evaluate', 'throwOnSideEffect', false],
    ['Runtime.evaluate', 'returnByValue', false],
    ['Runtime.evaluate', 'awaitPromise', true],
    ['Runtime.evaluate', 'userGesture', true],
    ['DOM.getDocument', 'pierce', true],
    ['Page.captureScreenshot', 'captureBeyondViewport', true],
    ['Runtime.evaluate', 'objectGroup', 'unavailable'],
    ['DOM.getDocument', 'unknown', false],
    ['Page.captureScreenshot', 'clip', {}],
  ])('blocks unsafe %s parameter %s at either boundary', async (method, key, unsafe) => {
    const test = fixture();
    const read = reads.find(read => read.method === method)!;
    try {
      for (const value of [unsafe, undefined, null, 'true', 0]) {
        const params = { ...read.expected, [key as string]: value };
        await expect(test.router.cdp(scope, claim, 'cdpCall', { method, params }, async () => true))
          .rejects.toThrow(/unavailable/);
        // An untrusted bridge caller cannot bypass the extension's own restrictions.
        await expect(test.execute('cdpCall', { method, params, approvedOrigin: origin }))
          .rejects.toThrow(/unavailable/);
      }
      expect(test.sendCommand).not.toHaveBeenCalled();
    } finally { test.close(); }
  });

  it('does not send a read when debug approval is denied', async () => {
    const test = fixture();
    try {
      await expect(test.router.cdp(scope, claim, 'cdpCall', {
        method: 'Runtime.evaluate', params: { expression: '1+1' },
      }, async () => false)).rejects.toThrow(/not approved/);
      expect(test.sendCommand).not.toHaveBeenCalled();
    } finally { test.close(); }
  });
});
