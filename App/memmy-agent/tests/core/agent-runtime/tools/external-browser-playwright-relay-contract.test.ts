import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeExternalBrowserPlaywright, closeAllExternalBrowserPlaywright, closeExternalBrowserPlaywrightScope } from '../../../../src/core/agent-runtime/tools/external-browser-playwright.js';
import { ExternalBrowserPlaywrightRelay, type PlaywrightCommandBridge } from '../../../../src/core/agent-runtime/tools/external-browser-playwright-relay.js';
import type { BrowserCommandSettle, ExternalBrowserClaim, ExternalBrowserPlaywrightEvent } from '../../../../src/core/agent-runtime/tools/external-browser-bridge.js';
import { BROWSER_PLAYWRIGHT_CDP_METHODS } from '@memmy/local-api-contracts';

const executable = process.env.MEMMY_BROWSER_TEST_EXECUTABLE || (fs.existsSync(chromium.executablePath())
  ? chromium.executablePath() : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const scope = { sessionKey: 'relay-contract', channel: 'test', chatId: 'relay-contract' };
class FixtureBridge implements PlaywrightCommandBridge {
  private static nextConnectionId = 0;
  claim: ExternalBrowserClaim;
  leaseId = '';
  documentEpoch = 0;
  frameEpoch = 0;
  private nextId = 0;
  private root: WebSocket;
  private sessionId = '';
  private children = new Set<string>();
  private childTargets = new Map<string, any>();
  private listeners = new Set<(event: ExternalBrowserPlaywrightEvent) => void>();
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; settle?: BrowserCommandSettle }>();
  private stopped = false;
  private input = false;
  private uploadPaths?: string[];
  readonly methods: string[] = [];
  readonly contexts: Array<{ child: boolean; isDefault: boolean; origin: string; frameId?: string }> = [];
  dropDefaultContexts = false;
  rejectObservation = false;

  private constructor(root: WebSocket, url: string) {
    this.root = root;
    this.claim = { connectionId: `fixture-${++FixtureBridge.nextConnectionId}`, tabId: 1,
      browser: 'chrome', title: 'fixture', url, claimedAt: Date.now() };
    root.on('message', raw => {
      const message = JSON.parse(String(raw));
      if (message.id) {
        const pending = this.pending.get(message.id); this.pending.delete(message.id);
        // Like the production bridges, report the reply before any later event.
        if (message.error) {
          const error = new Error(message.error.message); pending?.settle?.({ ok: false, error }); pending?.reject(error);
        } else { pending?.settle?.({ ok: true, result: message.result }); pending?.resolve(message.result); }
        return;
      }
      if (message.sessionId !== this.sessionId && !this.children.has(message.sessionId)) return;
      if (['Page.frameNavigated', 'Page.frameAttached', 'Page.frameDetached'].includes(message.method)) this.frameEpoch++;
      if (message.method === 'Target.attachedToTarget') {
        this.children.add(message.params.sessionId);
        this.childTargets.set(message.params.sessionId, message.params.targetInfo);
      }
      if (message.method === 'Target.detachedFromTarget') {
        this.children.delete(message.params.sessionId); this.childTargets.delete(message.params.sessionId);
      }
      if (message.method === 'Page.frameNavigated' && message.sessionId === this.sessionId && !message.params.frame.parentId) {
        this.claim.url = message.params.frame.url; this.documentEpoch++;
      }
      if (message.method === 'Runtime.executionContextCreated') this.contexts.push({
        child: message.sessionId !== this.sessionId, isDefault: message.params.context.auxData?.isDefault === true,
        origin: message.params.context.origin, frameId: message.params.context.auxData?.frameId,
      });
      if (this.dropDefaultContexts && message.method === 'Runtime.executionContextCreated'
        && message.params.context.auxData?.isDefault === true) return;
      if (this.leaseId) for (const listener of this.listeners) listener({ leaseId: this.leaseId,
        method: message.method, params: message.params,
        ...(message.sessionId !== this.sessionId ? { sessionId: message.sessionId } : {}) });
    });
  }
  static async create(port: number, page: Page): Promise<FixtureBridge> {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl: string };
    const root = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { root.once('open', resolve); root.once('error', reject); });
    const bridge = new FixtureBridge(root, page.url());
    const targets = await bridge.send('Target.getTargets');
    const target = targets.targetInfos.find((info: any) => info.url === page.url());
    const attached = await bridge.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    bridge.sessionId = attached.sessionId;
    await bridge.send('Page.enable', {}, bridge.sessionId);
    return bridge;
  }
  getClaim = () => this.stopped ? null : this.claim;
  subscribePlaywright = (_identity: any, listener: (event: ExternalBrowserPlaywrightEvent) => void) => {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  };
  command = async (_identity: any, name: string, args: Record<string, any> = {}, signal?: AbortSignal,
    settle?: BrowserCommandSettle): Promise<unknown> => {
    if (name === 'playwrightEnd') { if (this.leaseId === args.leaseId) this.leaseId = ''; return {}; }
    if (signal?.aborted || this.stopped) throw new Error('Browser executor cancelled');
    if (name === 'playwrightStart') {
      this.leaseId = args.leaseId; this.input = args.input; this.uploadPaths = args.uploadPaths;
      if (args.fresh) {
        await this.send('Runtime.disable', {}, this.sessionId);
        await this.send('Target.setAutoAttach', { autoAttach: false, flatten: true, waitForDebuggerOnStart: false }, this.sessionId);
      }
      const info = await this.send('Target.getTargetInfo', {}, this.sessionId);
      const tree = await this.send('Page.getFrameTree', {}, this.sessionId);
      return { ...info, ...tree, childTargets: [...this.childTargets.values()].map(child => ({ targetId: child.targetId, url: child.url })),
        documentEpoch: this.documentEpoch, frameEpoch: this.frameEpoch, cdpEpoch: 0 };
    }
    if (name !== 'playwrightCdp' || args.leaseId !== this.leaseId) throw new Error('Invalid action lease');
    if (this.rejectObservation && JSON.stringify(args.params).includes('const nonce=')) throw new Error('Fixture observation failed');
    if (args.method !== 'DOM.setFileInputFiles' && !(BROWSER_PLAYWRIGHT_CDP_METHODS as readonly string[]).includes(args.method)) {
      throw new Error(`The production executor does not permit ${args.method}`);
    }
    if (args.method.startsWith('Input.') && !this.input) throw new Error('Observation cannot send input');
    if (args.method === 'DOM.setFileInputFiles' && JSON.stringify(args.params.files) !== JSON.stringify(this.uploadPaths)) {
      throw new Error('Upload paths are not approved');
    }
    this.methods.push(args.method);
    return this.send(args.method, args.params, args.sessionId || this.sessionId, settle);
  };
  private send(method: string, params: any = {}, sessionId?: string, settle?: BrowserCommandSettle): Promise<any> {
    const id = ++this.nextId;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, settle }));
    this.root.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return result;
  }
  stop(): void { this.stopped = true; }
  get pendingCount(): number { return this.pending.size; }
  get childSessions(): string[] { return [...this.children]; }
  close(): void { this.root.terminate(); }
}

describe.skipIf(!fs.existsSync(executable))('selected-tab relay protocol contract against real Chromium', () => {
  let browser: Browser, page: Page, bridge: FixtureBridge, server: http.Server, origin: string;
  let frameGeneration = 0;
  let slowResponses: http.ServerResponse[] = [];
  beforeEach(async () => {
    frameGeneration = 0; slowResponses = [];
    server = http.createServer((request, response) => {
      response.setHeader('content-type', 'text/html');
      if (request.url === '/slow-frame') { slowResponses.push(response); return; }
      if (request.url?.startsWith('/frame')) response.end(`<input id="inside" aria-label="Frame generation ${++frameGeneration}"><button id="frame-action">Frame action</button>`);
      else response.end('<button id="main-action">Main action</button><iframe id="child" src="/frame"></iframe>');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    const listener = net.createServer();
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = (listener.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => listener.close(() => resolve()));
    browser = await chromium.launch({ executablePath: executable, headless: true,
      args: [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'] });
    page = await browser.newPage(); await page.goto(origin);
    bridge = await FixtureBridge.create(port, page);
  });
  afterEach(async () => {
    await closeAllExternalBrowserPlaywright(); bridge?.close(); await browser?.close();
    if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const run = async (action: string, args: Record<string, any> = {}, allowFrame: (url: string) => boolean = () => true) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try { return await executeExternalBrowserPlaywright(bridge, bridge.claim, scope, action, args, allowFrame, controller.signal); }
    finally { clearTimeout(timer); }
  };
  it.each(['same-process', 'OOPIF'])('observes a %s child document reloaded at the same URL between action leases', async kind => {
    if (kind === 'OOPIF') {
      await page.locator('#child').evaluate((node: any, url: string) => { node.src = url; }, origin.replace('127.0.0.1', 'localhost') + '/frame');
      await page.frameLocator('#child').getByRole('textbox', { name: 'Frame generation 2' }).waitFor();
    }
    const generation = frameGeneration;
    const first = await run('snapshot');
    expect(first.nodes.some((node: any) => node.name === `Frame generation ${generation}`)).toBe(true);
    await page.frames().find(frame => frame.parentFrame())!.evaluate('location.reload()');
    await page.frameLocator('#child').getByRole('textbox', { name: `Frame generation ${generation + 1}` }).waitFor();
    const next = await run('snapshot');
    expect(next.nodes.some((node: any) => node.name === `Frame generation ${generation + 1}`)).toBe(true);
  });

  it('keeps main-frame locator handles valid when a different child document navigates during the action', async () => {
    await run('snapshot');
    const failures: string[] = [];
    const originalSend = ExternalBrowserPlaywrightRelay.prototype.send;
    const send = vi.spyOn(ExternalBrowserPlaywrightRelay.prototype, 'send').mockImplementation(async function(this: ExternalBrowserPlaywrightRelay, ...args) {
      try { return await originalSend.apply(this, args); }
      catch (error) { failures.push(`${args[0]}:${(error as Error).message}`); throw error; }
    });
    const originalCommand = bridge.command;
    let navigated = false;
    bridge.command = async (...args: Parameters<FixtureBridge['command']>) => {
      const result = await originalCommand(...args);
      if (!navigated && args[1] === 'playwrightCdp' && args[2]?.method === 'Runtime.callFunctionOn' && args[2]?.params?.objectId) {
        navigated = true;
        await page.frames().find(frame => frame.parentFrame())!.evaluate('location.reload()');
        await page.frameLocator('#child').getByRole('textbox', { name: 'Frame generation 2' }).waitFor();
      }
      return result;
    };
    try {
      const result = await run('click', { target: '#main-action' });
      expect(navigated).toBe(true);
      expect(result.ok).toBe(true);
      expect(result.observation.nodes.some((node: any) => node.name === 'Frame generation 2')).toBe(true);
    } catch (error) { throw new Error(`Child navigation affected main-frame handles (triggered=${navigated}; protocol=${JSON.stringify(failures)}): ${(error as Error).message}`); }
    finally { send.mockRestore(); }
  });

  it('reuses an unchanged OOPIF connection across successive observation leases', async () => {
    await page.locator('#child').evaluate((node: any, url: string) => { node.src = url; }, origin.replace('127.0.0.1', 'localhost') + '/frame');
    await page.frameLocator('#child').getByRole('textbox', { name: 'Frame generation 2' }).waitFor();
    const originalCommand = bridge.command;
    let freshStarts = 0;
    bridge.command = async (...args: Parameters<FixtureBridge['command']>) => {
      if (args[1] === 'playwrightStart' && args[2]?.fresh) freshStarts++;
      return originalCommand(...args);
    };
    for (let i = 0; i < 3; i++) {
      const result = await run('snapshot');
      expect(result.nodes.some((node: any) => node.name === 'Frame generation 2')).toBe(true);
    }
    expect(freshStarts).toBe(1);
  });

  it.each(['same-process', 'OOPIF'])('observes an allowed dynamic %s iframe before returning post-action state', async kind => {
    const frameUrl = (kind === 'OOPIF' ? origin.replace('127.0.0.1', 'localhost') : origin) + '/frame';
    await page.locator('#main-action').evaluate((node: any, url: string) => {
      node.onclick = () => {
        const frame = node.ownerDocument.createElement('iframe');
        frame.id = 'dynamic'; frame.src = url; node.ownerDocument.body.append(frame);
      };
    }, frameUrl);
    await run('snapshot');
    const originalCommand = bridge.command;
    bridge.command = async (...args: Parameters<FixtureBridge['command']>) => {
      const result = await originalCommand(...args);
      if (args[1] === 'playwrightCdp' && args[2]?.method === 'Input.dispatchMouseEvent' && args[2]?.params?.type === 'mouseReleased') {
        // Wait only in the fixture transport so the new document is demonstrably loaded before observation.
        await page.frameLocator('#dynamic').getByRole('textbox', { name: 'Frame generation 2' }).waitFor();
      }
      return result;
    };
    const result = await run('click', { target: '#main-action' });
    expect(result.ok).toBe(true);
    expect(result.observation.nodes.some((node: any) => node.name === 'Frame generation 2')).toBe(true);
  });


  it.each(['same-process', 'OOPIF'])('keeps the main page usable when an action attaches a denied dynamic %s iframe', async kind => {
    const denied = (kind === 'OOPIF' ? origin.replace('127.0.0.1', 'localhost') : origin) + '/frame-blocked';
    const policy = (url: string) => !url.includes('/frame-blocked');
    await page.locator('#main-action').evaluate((node: any, url: string) => {
      node.onclick = () => {
        const frame = node.ownerDocument.createElement('iframe');
        frame.id = 'dynamic'; frame.src = url; node.ownerDocument.body.append(frame);
      };
    }, denied);
    await run('snapshot', {}, policy);
    const originalCommand = bridge.command;
    bridge.command = async (...args: Parameters<FixtureBridge['command']>) => {
      const result = await originalCommand(...args);
      if (args[1] === 'playwrightCdp' && args[2]?.method === 'Input.dispatchMouseEvent' && args[2]?.params?.type === 'mouseReleased') {
        await page.frameLocator('#dynamic').getByRole('textbox', { name: 'Frame generation 2' }).waitFor();
      }
      return result;
    };
    const result = await run('click', { target: '#main-action' }, policy);
    expect(result.ok).toBe(true);
    expect(result.observation.nodes.some((node: any) => node.name === 'Main action')).toBe(true);
    expect(result.observation.nodes.some((node: any) => node.name === 'Frame generation 2')).toBe(false);
  });

  it('removes a denied same-process frame from the view and reattaches it when an action navigates back to an allowed document', async () => {
    const policy = (url: string) => !url.includes('/frame-blocked');
    await run('snapshot', {}, policy);
    const originalCommand = bridge.command;
    let generation = 2;
    bridge.command = async (...args: Parameters<FixtureBridge['command']>) => {
      const result = await originalCommand(...args);
      if (args[1] === 'playwrightCdp' && args[2]?.method === 'Input.dispatchMouseEvent' && args[2]?.params?.type === 'mouseReleased') {
        await page.frameLocator('#child').getByRole('textbox', { name: `Frame generation ${generation}` }).waitFor();
      }
      return result;
    };
    await page.locator('#main-action').evaluate((node: any) => {
      node.onclick = () => { node.ownerDocument.querySelector('#child').src = '/frame-blocked'; };
    });
    const denied = await run('click', { target: '#main-action' }, policy);
    expect(denied.ok).toBe(true);
    expect(denied.observation.nodes.some((node: any) => node.name === 'Frame generation 2')).toBe(false);
    generation = 3;
    await page.locator('#main-action').evaluate((node: any) => {
      node.onclick = () => { node.ownerDocument.querySelector('#child').src = '/frame'; };
    });
    const allowed = await run('click', { target: '#main-action' }, policy);
    expect(allowed.ok).toBe(true);
    expect(allowed.observation.nodes.some((node: any) => node.name === 'Frame generation 3')).toBe(true);
  });

  it('revokes an exposed OOPIF view immediately when navigation crosses into a denied document', async () => {
    const policy = (url: string) => !url.includes('/frame-blocked');
    const childOrigin = origin.replace('127.0.0.1', 'localhost');
    await page.locator('#child').evaluate((node: any, url: string) => { node.src = url; }, childOrigin + '/frame');
    await page.frameLocator('#child').getByRole('textbox', { name: 'Frame generation 2' }).waitFor();
    await run('snapshot', {}, policy);
    await page.locator('#main-action').evaluate((node: any, url: string) => {
      node.onclick = () => { node.ownerDocument.querySelector('#child').src = url; };
    }, childOrigin + '/frame-blocked');
    const originalCommand = bridge.command;
    bridge.command = async (...args: Parameters<FixtureBridge['command']>) => {
      const result = await originalCommand(...args);
      if (args[1] === 'playwrightCdp' && args[2]?.method === 'Input.dispatchMouseEvent' && args[2]?.params?.type === 'mouseReleased') {
        await page.frameLocator('#child').getByRole('textbox', { name: 'Frame generation 3' }).waitFor();
      }
      return result;
    };
    const result = await run('click', { target: '#main-action' }, policy);
    expect(result.ok).toBe(false);
    expect(result.freshObservationRequired).toBe(true);
    expect(result.dispatchState).not.toBe('none');
    expect(result.error).toMatch(/frame access changed/);
    const fresh = await run('snapshot', {}, policy);
    expect(fresh.nodes.some((node: any) => node.name === 'Main action')).toBe(true);
    expect(fresh.nodes.some((node: any) => node.name === 'Frame generation 3')).toBe(false);
  });



  it('publishes an initially denied OOPIF when an action navigates it into an allowed document', async () => {
    const policy = (url: string) => !url.includes('/frame-blocked');
    const childOrigin = origin.replace('127.0.0.1', 'localhost');
    await page.locator('#child').evaluate((node: any, url: string) => { node.src = url; }, childOrigin + '/frame-blocked');
    await page.frameLocator('#child').getByRole('textbox', { name: 'Frame generation 2' }).waitFor();
    const hidden = await run('snapshot', {}, policy);
    expect(hidden.nodes.some((node: any) => node.name === 'Frame generation 2')).toBe(false);
    await page.locator('#main-action').evaluate((node: any, url: string) => {
      node.onclick = () => { node.ownerDocument.querySelector('#child').src = url; };
    }, childOrigin + '/frame');
    const originalCommand = bridge.command;
    bridge.command = async (...args: Parameters<FixtureBridge['command']>) => {
      const result = await originalCommand(...args);
      if (args[1] === 'playwrightCdp' && args[2]?.method === 'Input.dispatchMouseEvent' && args[2]?.params?.type === 'mouseReleased') {
        await page.frameLocator('#child').getByRole('textbox', { name: 'Frame generation 3' }).waitFor();
      }
      return result;
    };
    const allowed = await run('click', { target: '#main-action' }, policy);
    expect(allowed.ok).toBe(true);
    expect(allowed.observation.nodes.some((node: any) => node.name === 'Frame generation 3')).toBe(true);
  });

  it('removes denied frame metadata when its physical subtree is detached', async () => {
    const policy = (url: string) => !url.includes('/frame-blocked');
    await page.locator('#child').evaluate((node: any) => { node.src = '/frame-blocked'; });
    await page.frameLocator('#child').getByRole('textbox', { name: 'Frame generation 2' }).waitFor();
    await run('snapshot', {}, policy);
    await page.locator('#main-action').evaluate((node: any) => {
      node.onclick = () => { node.ownerDocument.querySelector('#child').remove(); };
    });
    const result = await run('click', { target: '#main-action' }, policy);
    expect(result.ok).toBe(true);
    const screenshot = await run('screenshot', {}, policy);
    expect(screenshot.format).toBe('png');
    expect(screenshot.data).toBeTruthy();
  });

  it.each(['screenshot', 'coordinates', 'pressKey', 'scroll', 'locator'])('treats an attached frame with an unconfirmed URL as denied for %s', async kind => {
    const originalCommand = bridge.command;
    let injected = false;
    bridge.command = async (...args: Parameters<FixtureBridge['command']>) => {
      const result = await originalCommand(...args);
      if (!injected && args[1] === 'playwrightStart') {
        injected = true;
        const epoch = bridge.frameEpoch;
        await page.evaluate(() => {
          const document = (globalThis as any).document;
          const frame = document.createElement('iframe');
          frame.id = 'pending'; frame.src = '/slow-frame'; document.body.append(frame);
        });
        await expect.poll(() => bridge.frameEpoch).toBeGreaterThan(epoch);
        await expect.poll(() => slowResponses.length).toBe(1);
      }
      return result;
    };
    const action = kind === 'coordinates' || kind === 'locator' ? 'click' : kind;
    const args = kind === 'coordinates' ? { x: 15, y: 15 } : kind === 'locator' ? { target: '#main-action' }
      : kind === 'pressKey' ? { key: 'A' } : kind === 'scroll' ? { deltaY: 40 } : {};
    if (kind === 'locator') {
      const result = await run(action, args);
      expect(result.ok).toBe(true);
    } else {
      await expect(run(action, args)).rejects.toThrow(/blocked by site policy/);
      expect(bridge.methods.some(method => method.startsWith('Input.'))).toBe(false);
    }
    slowResponses[0].end('<input aria-label="Confirmed slow frame">');
    await page.frameLocator('#pending').getByRole('textbox', { name: 'Confirmed slow frame' }).waitFor();
    const confirmed = await run('snapshot');
    expect(confirmed.nodes.some((node: any) => node.name === 'Confirmed slow frame')).toBe(true);
  });


  it('revokes an active context wait, queued input and old refs when a scope ends, then permits a new task', async () => {
    const observed = await run('snapshot');
    const oldRef = observed.nodes.find((node: any) => node.name === 'Frame generation 1').ref;
    bridge.methods.length = 0;
    const active = executeExternalBrowserPlaywright(bridge, bridge.claim, scope,
      'click', { target: '#never-present' }, () => true);
    void active.catch(() => undefined);
    const queued = executeExternalBrowserPlaywright(bridge, bridge.claim, scope,
      'type', { target: oldRef, text: 'must not be entered' }, () => true);
    void queued.catch(() => undefined);
    await expect.poll(() => bridge.methods.filter(method => method === 'Runtime.callFunctionOn').length).toBeGreaterThan(0);
    await closeExternalBrowserPlaywrightScope(scope);
    await expect(active).rejects.toThrow(/cancelled|disconnected|closed/i);
    await expect(queued).rejects.toThrow(/cancelled/i);
    expect(bridge.methods.some(method => method.startsWith('Input.'))).toBe(false);
    const fresh = await run('snapshot');
    expect(fresh.nodes.some((node: any) => node.name === 'Frame generation 1')).toBe(true);
    await expect(run('type', { target: oldRef, text: 'old task ref' })).rejects.toThrow(/reference|ref|observation/i);
    expect(bridge.methods.some(method => method.startsWith('Input.'))).toBe(false);
    expect(await page.frameLocator('#child').getByRole('textbox').inputValue()).toBe('');
  });


  it.each(['same-process', 'OOPIF'])('refreshes the admitted %s frame view when the live policy changes without navigation', async kind => {
    if (kind === 'OOPIF') {
      await page.locator('#child').evaluate((node: any, url: string) => { node.src = url; }, origin.replace('127.0.0.1', 'localhost') + '/frame');
      await page.frameLocator('#child').getByRole('textbox', { name: 'Frame generation 2' }).waitFor();
    }
    const generation = frameGeneration;
    let allowChild = false;
    const policy = (url: string) => !new URL(url).pathname.startsWith('/frame') || allowChild;
    const hidden = await run('snapshot', {}, policy);
    expect(hidden.nodes.some((node: any) => node.name === `Frame generation ${generation}`)).toBe(false);
    allowChild = true;
    const allowed = await run('snapshot', {}, policy);
    expect(allowed.nodes.some((node: any) => node.name === `Frame generation ${generation}`)).toBe(true);
    allowChild = false;
    const deniedAgain = await run('snapshot', {}, policy);
    expect(deniedAgain.nodes.some((node: any) => node.name === `Frame generation ${generation}`)).toBe(false);
    await expect(run('screenshot', {}, policy)).rejects.toThrow(/blocked by site policy/);
  });

  it('does not forward a remote object handle into a different CDP child session', async () => {
    await page.locator('#child').evaluate((node: any, url: string) => { node.src = url; }, origin.replace('127.0.0.1', 'localhost') + '/frame');
    await page.frameLocator('#child').getByRole('textbox', { name: 'Frame generation 2' }).waitFor();
    const relay = new ExternalBrowserPlaywrightRelay(bridge.claim, () => true);
    try {
      await relay.begin(bridge, origin, false, true);
      await relay.send('Runtime.enable');
      await relay.send('Target.setAutoAttach', { autoAttach: true, flatten: true, waitForDebuggerOnStart: false });
      await expect.poll(() => bridge.childSessions.length).toBeGreaterThan(0);
      const object = await relay.send('Runtime.evaluate', { expression: '({fixture:1})' });
      expect(object.result.objectId).toBeTruthy();
      await relay.send('Runtime.getProperties', { objectId: object.result.objectId });
      const before = bridge.methods.length;
      await expect(relay.send('Runtime.getProperties', { objectId: object.result.objectId }, bridge.childSessions[0])).rejects.toThrow(/identity.*blocked/);
      expect(bridge.methods.length).toBe(before);
    } finally { await relay.close(); }
  });
});
