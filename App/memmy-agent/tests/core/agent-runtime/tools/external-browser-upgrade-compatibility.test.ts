import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExternalBrowserBridge, EXTERNAL_BROWSER_EXTENSION_NOT_READY,
  MEMMY_BROWSER_EXTENSION_ID } from '../../../../src/core/agent-runtime/tools/external-browser-bridge.js';
import { callExternalBrowserTool } from '../../../../src/core/agent-runtime/tools/external-browser-tools.js';
import { closeAllExternalBrowserPlaywright } from '../../../../src/core/agent-runtime/tools/external-browser-playwright.js';
import { DEFAULT_OBSERVATION_SETTINGS } from '../../../../src/tools/computer-history/mac/observation-settings.js';

const resources: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  await closeAllExternalBrowserPlaywright();
  for (const close of resources.splice(0).reverse()) await close();
});

async function extension(bridge: ExternalBrowserBridge, browser: 'chrome' | 'edge', capabilities?: string[]) {
  const { port } = await bridge.start(0);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/extension`,
    { origin: `chrome-extension://${MEMMY_BROWSER_EXTENSION_ID}` });
  resources.push(() => socket.terminate());
  const messages: any[] = [];
  socket.on('message', value => messages.push(JSON.parse(String(value))));
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ type: 'hello', browser, ...(capabilities ? { capabilities } : {}) }));
  await vi.waitFor(() => expect(messages.some(message => message.type === 'ready')).toBe(true));
  const connectionId = messages.find(message => message.type === 'ready').connectionId as string;
  socket.send(JSON.stringify({ type: 'claim', browser, tabId: 7, title: 'Existing signed-in page',
    url: 'https://upgrade-fixture.test/form' }));
  await vi.waitFor(() => expect(bridge.getClaim({ connectionId, tabId: 7 })).not.toBeNull());
  return { socket, messages, claim: bridge.getClaim({ connectionId, tabId: 7 })! };
}

function bridge() {
  const result = new ExternalBrowserBridge(); resources.push(() => result.close()); return result;
}

describe('external browser extension upgrade compatibility', () => {
  it.each(['chrome', 'edge'] as const)('blocks new executor commands before sending to a connected old %s worker', async browser => {
    const transport = bridge(), old = await extension(transport, browser, ['openTab']);
    for (const command of ['playwrightStart', 'playwrightCdp', 'playwrightEnd']) {
      await expect(transport.command(old.claim, command, { method: 'Input.dispatchMouseEvent' })).rejects.toMatchObject({
        code: EXTERNAL_BROWSER_EXTENSION_NOT_READY, retryable: false,
        dispatchState: 'none', noActionDispatched: true, inputDispatched: false,
      });
    }
    expect(old.messages.filter(message => message.type === 'command')).toEqual([]);
    expect(transport.listConnected()).toEqual([browser]);
    expect(transport.getClaim(old.claim)).toEqual(old.claim);
    // Compatibility checks do not revoke the user's existing claim or block legacy read-only commands.
    const read = transport.command(old.claim, 'historyState');
    await vi.waitFor(() => expect(old.messages.some(message => message.command === 'historyState')).toBe(true));
    const request = old.messages.find(message => message.command === 'historyState');
    old.socket.send(JSON.stringify({ type: 'response', id: request.id, ok: true, result: { canGoBack: true } }));
    await expect(read).resolves.toEqual({ canGoBack: true });
  });

  it.each([undefined, [], ['unrelated-capability']])('fails closed when the hello does not advertise Playwright: %j', async capabilities => {
    const transport = bridge(), old = await extension(transport, 'chrome', capabilities);
    await expect(transport.command(old.claim, 'playwrightStart')).rejects.toMatchObject({
      code: EXTERNAL_BROWSER_EXTENSION_NOT_READY, noActionDispatched: true,
    });
    expect(old.messages.filter(message => message.type === 'command')).toEqual([]);
  });

  it('uses the capability of the claimed connection and accepts an updated worker without changing site permissions', async () => {
    const transport = bridge(), old = await extension(transport, 'chrome', ['openTab']);
    const updated = await extension(transport, 'chrome', ['openTab', 'playwright', 'browserHistory']);
    await expect(transport.command(old.claim, 'playwrightStart')).rejects.toMatchObject({ code: EXTERNAL_BROWSER_EXTENSION_NOT_READY });
    const action = transport.command(updated.claim, 'playwrightStart', { leaseId: 'fixture-lease' });
    await vi.waitFor(() => expect(updated.messages.some(message => message.command === 'playwrightStart')).toBe(true));
    const request = updated.messages.find(message => message.command === 'playwrightStart');
    updated.socket.send(JSON.stringify({ type: 'response', id: request.id, ok: true, result: { documentEpoch: 1 } }));
    await expect(action).resolves.toEqual({ documentEpoch: 1 });
    expect(old.messages.filter(message => message.type === 'command')).toEqual([]);
    expect(transport.listClaims()).toEqual(expect.arrayContaining([old.claim, updated.claim]));
  });

  it.each(['browser_snapshot', 'browser_click', 'browser_file_upload'] as const)('reports a short non-retryable connection failure for %s without a new user flow', async tool => {
    const transport = bridge(), old = await extension(transport, 'chrome', ['openTab']);
    const result = await callExternalBrowserTool(transport, old.claim,
      { sessionKey: 'upgrade-fixture', channel: 'test', chatId: tool }, tool,
      { element: 'button', paths: ['/tmp/unused-upgrade-fixture.txt'] }, async () => true);
    const status = JSON.parse(result[0].text);
    expect(status).toEqual({ ok: false, code: EXTERNAL_BROWSER_EXTENSION_NOT_READY,
      retryable: false, noActionDispatched: true, inputDispatched: false,
      error: 'External browser extension is not ready.' });
    expect(status).not.toHaveProperty('requiresUserAction');
    expect(status).not.toHaveProperty('recoveryInstructions');
    expect(status.error).not.toMatch(/version|1\.0\.5|permission|setup|update|reload|reconnect|manual|fresh observation/iu);
    expect(old.messages.filter(message => message.type === 'command')).toEqual([]);
    expect(transport.getClaim(old.claim)).toEqual(old.claim);
  });

  it('does not enable browser History for an old worker without its independently negotiated capability', async () => {
    const transport = bridge(), old = await extension(transport, 'edge', ['openTab']);
    const listener = vi.fn(); transport.subscribeBrowserHistory(listener);
    transport.setBrowserHistoryIntentProvider(() => ({ enabled: true, generation: 'recording-1', captureText: true,
      settings: structuredClone(DEFAULT_OBSERVATION_SETTINGS) }));
    old.socket.send(JSON.stringify({ type: 'browser_history_config_request', id: 'old-config', browser: 'edge',
      tabId: 7, windowId: 1, documentId: 'old-document', topUrl: old.claim.url, frameUrl: old.claim.url,
      privateBrowsing: false, protected: false }));
    old.socket.send(JSON.stringify({ type: 'browser_history', browser: 'edge', tabId: 7, windowId: 1,
      documentId: 'old-document', topUrl: old.claim.url, frameUrl: old.claim.url, privateBrowsing: false,
      protected: false, generation: 'recording-1', payload: { version: 1, generation: 'recording-1',
        documentId: 'old-document', eventId: 'old-event', observedAt: Date.now(), action: 'click' } }));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(listener).not.toHaveBeenCalled();
    expect(old.messages.filter(message => message.type === 'browser_history_intent' || message.id === 'old-config')).toEqual([]);
  });
});
