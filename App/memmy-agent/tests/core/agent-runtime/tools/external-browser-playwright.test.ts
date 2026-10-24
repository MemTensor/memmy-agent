import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeExternalBrowserPlaywright, closeExternalBrowserPlaywrightScope, closeAllExternalBrowserPlaywright, EXTERNAL_BROWSER_SNAPSHOT_BUDGET } from '../../../../src/core/agent-runtime/tools/external-browser-playwright.js';
import { ExternalBrowserPlaywrightRelay, type PlaywrightCommandBridge } from '../../../../src/core/agent-runtime/tools/external-browser-playwright-relay.js';
import type { BrowserCommandSettle, ExternalBrowserClaim, ExternalBrowserPlaywrightEvent } from '../../../../src/core/agent-runtime/tools/external-browser-bridge.js';
import { BROWSER_PLAYWRIGHT_CDP_METHODS } from '@memmy/local-api-contracts';
import { emitExternalBrowserFrame } from '../../../../src/core/agent-runtime/tools/external-browser-tools.js';

const executable = process.env.MEMMY_BROWSER_TEST_EXECUTABLE || (fs.existsSync(chromium.executablePath())
  ? chromium.executablePath() : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const scope = { sessionKey: 'fixture', channel: 'test', chatId: 'fixture' };
const FIXTURE = `<body><button id="replace">Replace</button><button id="action"><span>Continue</span></button>
 <label>Name<input id="name"></label><label><input id="check" type="checkbox">Agree</label>
 <select id="select" aria-label="Choice"><option value="a">Alpha</option><option value="b">Beta</option></select>
 <input id="file" type="file" aria-label="Attachment"><div id="result"></div>
 <script>document.querySelector('#action').onclick=()=>document.querySelector('#result').textContent='Done';
 document.querySelector('#replace').onclick=()=>{const el=document.querySelector('#action');const copy=el.cloneNode(true);copy.onclick=el.onclick;el.replaceWith(copy);};</script>`;
const JOURNEY_FORM = `<body><h1>New request</h1><form action="/journey/receipt">
 <label>Applicant<input name="applicant" required></label>
 <label>Category<select name="category"><option value="regular">Regular</option><option value="priority">Priority</option></select></label>
 <button type="button" role="combobox" aria-label="Delivery" aria-expanded="false" id="delivery">Choose delivery</button>
 <div id="choices" hidden><button type="button" role="option">Courier</button></div><input name="delivery" type="hidden">
 <div id="contact"></div><input type="hidden" name="contact">
 <div contenteditable="true" role="textbox" aria-label="Notes"></div><input type="hidden" name="notes">
 <label><input type="checkbox" name="accepted" required>I agree</label>
 <label>Evidence<input type="file" name="evidence" required></label>
 <div style="height:1500px">Review the request before sending.</div><button>Send request</button></form>
 <script>
 const host=document.querySelector('#contact').attachShadow({mode:'open'});
 host.innerHTML='<label>Contact<input aria-label="Contact"></label>';
 host.querySelector('input').oninput=e=>document.querySelector('[name=contact]').value=e.target.value;
 document.querySelector('[contenteditable]').oninput=e=>document.querySelector('[name=notes]').value=e.target.textContent;
 document.querySelector('#delivery').onclick=()=>{document.querySelector('#choices').hidden=false;document.querySelector('#delivery').setAttribute('aria-expanded','true');};
 document.querySelector('[role=option]').onclick=()=>{document.querySelector('[name=delivery]').value='courier';document.querySelector('#choices').hidden=true;
  const before=document.querySelector('#delivery'),copy=before.cloneNode(true);copy.textContent='Courier';copy.setAttribute('aria-expanded','false');before.replaceWith(copy);};
 document.querySelector('form').onsubmit=()=>{console.log('fixture request sent');fetch('/journey/audit');};
 </script>`;

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
  dropChildDefaultContexts = false;
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
      if (['Page.frameNavigated', 'Page.frameAttached', 'Page.frameDetached'].includes(message.method)) this.frameEpoch++;
      if (message.method === 'Runtime.executionContextCreated') this.contexts.push({
        child: message.sessionId !== this.sessionId, isDefault: message.params.context.auxData?.isDefault === true,
        origin: message.params.context.origin, frameId: message.params.context.auxData?.frameId,
      });
      if ((this.dropDefaultContexts || (this.dropChildDefaultContexts && message.sessionId !== this.sessionId))
        && message.method === 'Runtime.executionContextCreated' && message.params.context.auxData?.isDefault === true) return;
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
  close(): void { this.root.terminate(); }
}

describe.skipIf(!fs.existsSync(executable))('external Playwright executor with an isolated headless Chromium fixture', () => {
  let browser: Browser;
  let page: Page;
  let bridge: FixtureBridge;
  let server: http.Server;
  let origin: string;
  let debugPort: number;
  beforeEach(async () => {
    server = http.createServer((request, response) => {
      response.setHeader('content-type', 'text/html');
      const route = new URL(request.url || '/', 'http://fixture');
      response.end(route.pathname === '/journey' ? JOURNEY_FORM
        : route.pathname === '/journey/receipt' ? `<h1>Request recorded</h1><output>${JSON.stringify(Object.fromEntries(route.searchParams)).replaceAll('<', '&lt;')}</output>`
        : request.url?.startsWith('/frame') ? '<label>Frame name<input id="inside"></label><button>Frame action</button>'
        : request.url?.startsWith('/blocked') ? '<div>PRIVATE BLOCKED CONTENT</div><input id="private">' : FIXTURE);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    const portServer = net.createServer();
    await new Promise<void>(resolve => portServer.listen(0, '127.0.0.1', resolve));
    const port = debugPort = (portServer.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => portServer.close(() => resolve()));
    browser = await chromium.launch({ executablePath: executable, headless: true,
      args: [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'] });
    page = await browser.newPage(); await page.goto(origin);
    bridge = await FixtureBridge.create(port, page);
  }, 30_000);
  afterEach(async () => {
    await closeAllExternalBrowserPlaywright(); bridge?.close();
    await browser?.close();
    if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const run = (action: string, args: Record<string, any> = {}, allow = (_url: string) => true, signal?: AbortSignal) =>
    executeExternalBrowserPlaywright(bridge, bridge.claim, scope, action, args, allow, signal);

  it('resolves visible text refs, text selectors, dynamic nodes and observed form states', async () => {
    const cold = performance.now();
    const snapshot = await run('snapshot');
    const coldMs = performance.now() - cold;
    const reference = snapshot.nodes.find((node: any) => node.name === 'Continue' && node.role === 'text');
    expect(reference).toBeTruthy();
    const warm = performance.now();
    const clicked = await run('click', { target: `[${reference.ref}]` });
    const warmMs = performance.now() - warm;
    expect(clicked.observation.nodes.some((node: any) => node.name === 'Done')).toBe(true);
    const typed = await run('type', { target: '#name', text: 'Ada' });
    expect(typed.observation.nodes.find((node: any) => node.name === 'Name').value).toBe('Ada');
    const checked = await run('click', { target: 'text=Agree' });
    expect(checked.observation.nodes.find((node: any) => node.role === 'checkbox').state.checked).toBe(true);
    const selected = await run('selectOption', { target: '#select', values: ['b'] });
    expect(selected.observation.nodes.find((node: any) => node.role === 'combobox').state.options[1].selected).toBe(true);
    expect(bridge.methods.some(method => method.startsWith('Storage.') || method === 'Network.getCookies')).toBe(false);
    process.stdout.write(`External browser fixture timing: cold snapshot ${Math.round(coldMs)}ms; warm click+observation ${Math.round(warmMs)}ms\n`);
  });

  it('does not report successful typing or submit when the page rejects the dispatched text', async () => {
    await page.setContent('<form><input id="reject"><button>Send</button></form><script>reject.onbeforeinput=e=>e.preventDefault();document.querySelector("form").onsubmit=e=>{e.preventDefault();document.body.dataset.submitted="yes"}</script>');
    const result = await run('type', { target: '#reject', text: 'Rejected fixture text', submit: true });
    expect(result).toMatchObject({ ok: false, inputDispatched: true, inputVerified: false, submitted: false,
      verification: { status: 'modified', reason: 'page_changed_value' }, freshObservationRequired: true });
    expect(await page.locator('#reject').inputValue()).toBe('');
    expect(await page.locator('body').getAttribute('data-submitted')).toBeNull();
  });

  it('reports truncation and page transformations without replaying the requested value', async () => {
    await page.setContent('<input id="limited" maxlength="3"><input id="changed"><script>changed.oninput=()=>{changed.value=changed.value.toUpperCase();document.body.dataset.events=String(Number(document.body.dataset.events||0)+1)}</script>');
    expect(await run('type', { target: '#limited', text: 'abcdef' })).toMatchObject({ ok: false,
      inputVerified: false, verification: { status: 'modified', reason: 'maxlength' } });
    expect(await run('type', { target: '#changed', text: 'lowercase' })).toMatchObject({ ok: false,
      inputVerified: false, verification: { status: 'modified', reason: 'page_changed_value' } });
    expect(await page.locator('#changed').inputValue()).toBe('LOWERCASE');
    expect(await page.locator('body').getAttribute('data-events')).toBe('1');
  });

  it('verifies multiline, numeric and password fields without returning password text', async () => {
    await page.setContent('<textarea id="multiline"></textarea><input id="numeric" type="number"><input id="secret" type="password">');
    expect(await run('type', { target: '#multiline', text: 'first\r\nsecond' })).toMatchObject({ ok: true, inputVerified: true });
    expect(await run('type', { target: '#numeric', text: '1.50' })).toMatchObject({ ok: true, inputVerified: true });
    const secret = await run('type', { target: '#secret', text: 'fixture-password-never-returned' });
    expect(secret).toMatchObject({ ok: true, inputVerified: true });
    expect(JSON.stringify(secret)).not.toContain('fixture-password-never-returned');
  });

  it.each(['9007199254740993', '1.0000000000000001'])('does not submit or replay numeric input rounded by the page: %s', async text => {
    await page.setContent(`<form><input id="numeric" type="number" step="any"><button>Send</button></form>
      <script>numeric.oninput=()=>{numeric.value=String(Number(numeric.value));document.body.dataset.events=String(Number(document.body.dataset.events||0)+1)};
      document.querySelector('form').onsubmit=e=>{e.preventDefault();document.body.dataset.submitted='yes'};</script>`);
    expect(await run('type', { target: '#numeric', text, submit: true })).toMatchObject({
      ok: false, inputDispatched: true, inputVerified: false, submitted: false,
      verification: { status: 'modified', reason: 'page_changed_value' }, freshObservationRequired: true,
    });
    expect(await page.locator('#numeric').inputValue()).toBe(String(Number(text)));
    expect(await page.locator('body').getAttribute('data-events')).toBe('1');
    expect(await page.locator('body').getAttribute('data-submitted')).toBeNull();
  });

  it.each(['001.500e+1', '000.0100', '-0.000', '.500', '1.5e+2'])('accepts exact decimal formatting before submitting numeric input: %s', async text => {
    await page.setContent(`<form><input id="numeric" type="number" step="any"><button>Send</button></form>
      <script>numeric.oninput=()=>{numeric.value=String(Number(numeric.value));document.body.dataset.events=String(Number(document.body.dataset.events||0)+1)};
      document.querySelector('form').onsubmit=e=>{e.preventDefault();document.body.dataset.submitted='yes'};</script>`);
    expect(await run('type', { target: '#numeric', text, submit: true })).toMatchObject({
      ok: true, inputVerified: true, submitted: true, verification: { status: 'normalized' },
    });
    expect(await page.locator('body').getAttribute('data-events')).toBe('1');
    expect(await page.locator('body').getAttribute('data-submitted')).toBe('yes');
  });

  it('verifies the original field when input handlers replace it, without submitting the replacement', async () => {
    await page.setContent('<form><input id="replace-on-input"></form><script>document.querySelector("input").oninput=e=>{const next=e.target.cloneNode();e.target.replaceWith(next)}</script>');
    expect(await run('type', { target: '#replace-on-input', text: 'once', submit: true })).toMatchObject({ ok: false,
      inputVerified: false, submitted: false, verification: { status: 'unavailable', reason: 'target_replaced' } });
  });

  it.each(['#field-label', '#label-text'])('binds a label receiver before typing and refuses its replacement for %s', async target => {
    await page.setContent(`<form><label id="field-label" for="original"><span id="label-text">Notes</span></label><input id="original"></form>
      <script>document.querySelector('input').oninput=e=>{const next=e.target.cloneNode();next.value='once';e.target.replaceWith(next)};
      document.querySelector('form').onsubmit=e=>{e.preventDefault();document.body.dataset.submitted='yes'};</script>`);
    expect(await run('type', { target, text: 'once', submit: true })).toMatchObject({ ok: false,
      inputVerified: false, submitted: false, verification: { status: 'unavailable', reason: 'target_replaced' } });
    expect(await page.locator('#original').inputValue()).toBe('once');
    expect(await page.locator('body').getAttribute('data-submitted')).toBeNull();
  });

  it('submits the same original receiver when its label is retargeted by an input handler', async () => {
    await page.setContent(`<form><label id="field-label" for="original">Notes</label><input id="original"><input id="decoy" value="once"></form>
      <script>document.querySelector('#original').oninput=()=>document.querySelector('label').htmlFor='decoy';
      document.onkeydown=e=>{if(e.key==='Enter')document.body.dataset.enterReceiver=e.target.id};
      document.querySelector('form').onsubmit=e=>e.preventDefault();</script>`);
    expect(await run('type', { target: '#field-label', text: 'once', submit: true })).toMatchObject({ ok: true,
      inputVerified: true, submitted: true, verification: { status: 'matched' } });
    expect(await page.locator('body').getAttribute('data-enter-receiver')).toBe('original');
  });

  it('verifies clearing a rich editor that retains an empty starter paragraph', async () => {
    await page.setContent(`<div contenteditable="true" id="editor">Old value</div>
      <script>document.querySelector('#editor').oninput=e=>{if(!e.target.textContent)e.target.innerHTML='<p><br></p>'};</script>`);
    expect(await run('type', { target: '#editor', text: '' })).toMatchObject({ ok: true,
      inputVerified: true, verification: { status: 'matched' } });
    expect(await page.locator('#editor').textContent()).toBe('');
    expect(await page.locator('#editor').innerText()).toBe('\n');
  });

  it('captures a cold sandboxed cross-origin iframe with opaque execution context origins', async () => {
    const frameUrl = origin.replace('127.0.0.1', 'localhost') + '/frame';
    await page.evaluate((url: string) => {
      const document = (globalThis as any).document;
      const frame = document.createElement('iframe'); frame.id = 'sandbox';
      frame.setAttribute('sandbox', 'allow-scripts'); frame.src = url; document.body.append(frame);
    }, frameUrl);
    await page.locator('#sandbox').contentFrame().locator('#inside').waitFor();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const snapshot = await Promise.race([run('snapshot', { includeBoxes: true }, () => true, controller.signal),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Cold sandboxed OOPIF snapshot did not settle')), 4000); })]);
      expect(snapshot.nodes.some((node: any) => node.name === 'Frame name')).toBe(true);
      expect(bridge.contexts.some(context => context.child && context.isDefault && !/^https?:/u.test(context.origin))).toBe(true);
    } finally { clearTimeout(timer); controller.abort(); }
  }, 15_000);

  it('captures a fresh page again after a real actionability failure disposes the executor', async () => {
    const before = await run('snapshot');
    expect(before.nodes.length).toBeGreaterThan(0);
    await expect(run('click', { target: '#missing-control' })).rejects.toThrow(/Timeout|waiting for locator/);
    const after = await run('snapshot', { includeBoxes: true });
    expect(after.nodes.some((node: any) => node.role === 'button' && node.name === 'Continue')).toBe(true);
  }, 20_000);

  it('keeps the default context when the frame-tree reply settles late', async () => {
    const originalCommand = bridge.command;
    bridge.command = async (...args: Parameters<FixtureBridge['command']>) => {
      const result = await originalCommand(...args);
      // The relay answers when the bridge reports a reply; a late promise cannot reorder it.
      if (args[1] === 'playwrightCdp' && args[2]?.method === 'Page.getFrameTree') {
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      return result;
    };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const snapshot = await Promise.race([run('snapshot', {}, () => true, controller.signal),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Default execution context was lost during frame-tree bootstrap')), 4000); })]);
      expect(snapshot.nodes.some((node: any) => node.role === 'button' && node.name === 'Continue')).toBe(true);
    } finally { clearTimeout(timer); controller.abort(); }
  }, 15_000);

  it('keeps an OOPIF context when its frame-tree reply settles late', async () => {
    const frameUrl = origin.replace('127.0.0.1', 'localhost') + '/frame';
    await page.evaluate((url: string) => {
      const document = (globalThis as any).document;
      const frame = document.createElement('iframe'); frame.id = 'sandbox';
      frame.setAttribute('sandbox', 'allow-scripts'); frame.src = url; document.body.append(frame);
    }, frameUrl);
    await page.locator('#sandbox').contentFrame().locator('#inside').waitFor();
    const originalCommand = bridge.command;
    bridge.command = async (...args: Parameters<FixtureBridge['command']>) => {
      const result = await originalCommand(...args);
      if (args[1] === 'playwrightCdp' && args[2]?.method === 'Page.getFrameTree' && args[2].sessionId) {
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      return result;
    };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const snapshot = await Promise.race([run('snapshot', {}, () => true, controller.signal),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Opaque OOPIF execution context was filtered before frame-tree bootstrap')), 4000); })]);
      expect(snapshot.nodes.some((node: any) => node.name === 'Frame name')).toBe(true);
      expect(bridge.contexts.some(context => context.child && context.isDefault && !/^https?:/u.test(context.origin))).toBe(true);
    } finally { clearTimeout(timer); controller.abort(); }
  }, 15_000);

  it('leaves out an embedded frame that never exposes a context instead of stalling the observation', async () => {
    await page.evaluate((url: string) => {
      const frame = (globalThis as any).document.createElement('iframe'); frame.src = url;
      (globalThis as any).document.body.append(frame);
    }, origin.replace('127.0.0.1', 'localhost') + '/frame');
    await page.locator('iframe').contentFrame().locator('#inside').waitFor();
    bridge.dropChildDefaultContexts = true;
    const started = Date.now();
    const snapshot = await run('snapshot');
    expect(Date.now() - started).toBeLessThan(12_000);
    expect(snapshot.nodes.some((node: any) => node.role === 'button' && node.name === 'Continue')).toBe(true);
    expect(snapshot.nodes.some((node: any) => node.name === 'Frame name')).toBe(false);
    expect(snapshot.nodes.at(-1)).toMatchObject({ role: 'note', name: expect.stringMatching(/embedded frame/) });
    expect(snapshot.truncated).toBe(true);
  }, 20_000);

  it.each([['clear', true], ['blocked', false]] as const)('previews a %s page from the executor that just observed it, without another executor action', async (_label, frameAllowed) => {
    await page.evaluate((url: string) => {
      const frame = (globalThis as any).document.createElement('iframe'); frame.src = url;
      (globalThis as any).document.body.append(frame);
    }, origin + '/blocked');
    await page.locator('iframe').contentFrame().locator('#private').waitFor();
    const allow = (url: string) => frameAllowed || !url.includes('/blocked');
    await run('snapshot', {}, allow);
    const command = vi.fn((identity: any, name: string, args?: Record<string, any>, signal?: AbortSignal, settle?: any) =>
      name === 'screenshot' ? Promise.resolve({ format: 'jpeg', data: 'AAA' })
        : name === 'historyState' ? Promise.resolve({ canGoBack: false, canGoForward: false })
          : bridge.command(identity, name, args, signal, settle));
    await emitExternalBrowserFrame({ command, getClaim: bridge.getClaim, subscribePlaywright: bridge.subscribePlaywright,
      isFrameAllowed: allow } as any, bridge.claim, scope);
    expect(command.mock.calls.map(call => call[1])).toEqual(frameAllowed ? ['screenshot', 'historyState'] : []);
  });

  it('observes fields beside their labels and actions inside their table row, dialog and frame', async () => {
    await page.setContent(`<style>.action{cursor:pointer}</style><form><div><span>Invoice date</span><div><input placeholder="Pick a date"></div></div>
      <div class="action">Search</div></form>
      <table><tr><td>044001</td><td>1000.00</td><td><button>Delete</button></td></tr>
      <tr><td>044002</td><td>2000.00</td><td><button>Delete</button></td></tr></table>
      <div role="dialog" aria-modal="true"><h3>Confirm issue</h3><button>Confirm</button></div>
      <iframe src="${origin.replace('127.0.0.1', 'localhost')}/frame"></iframe>`);
    bridge.claim.url = page.url();
    await page.locator('iframe').contentFrame().locator('#inside').waitFor();
    const { nodes } = await run('snapshot');
    const at = (role: string, name: string) => nodes.findIndex((node: any) => node.role === role && node.name === name);
    expect(at('textbox', 'Pick a date')).toBe(at('text', 'Invoice date') + 1);
    expect(nodes[at('text', 'Search')].state).toMatchObject({ clickable: true });
    const row = at('row', '044002 | 2000.00 | Delete');
    expect(row).toBeGreaterThan(-1);
    expect(nodes.slice(row + 1).find((node: any) => node.role === 'button')).toMatchObject({ name: 'Delete', depth: nodes[row].depth + 1 });
    expect(nodes[at('dialog', 'Confirm issue')]).toMatchObject({ ref: '', state: { modal: true } });
    const frame = at('iframe', new URL(origin.replace('127.0.0.1', 'localhost')).host);
    expect(nodes[frame + 1]).toMatchObject({ name: 'Frame name', depth: nodes[frame].depth + 1 });
    const found = await run('find', { text: 'Delete' });
    expect(found.nodes.map((node: any) => node.context)).toEqual(['table > row "044001 | 1000.00 | Delete"', 'table > row "044002 | 2000.00 | Delete"']);
    const inFrame = await run('find', { text: 'Frame action' });
    expect(inFrame.nodes[0].context).toMatch(/^iframe localhost:/);
  });

  it('keeps the labels beside controls before unrelated text when a page is over budget', async () => {
    await page.setContent(`${Array.from({ length: 1500 }, (_, index) => `<p>Background ${index} ${'x'.repeat(40)}</p>`).join('')}
      <form><span>Buyer tax ID</span><input placeholder="Required"></form>`);
    bridge.claim.url = page.url();
    const { nodes, truncated } = await run('snapshot');
    expect(truncated).toBe(true);
    const field = nodes.findIndex((node: any) => node.role === 'textbox' && node.name === 'Required');
    expect(nodes[field - 1]).toMatchObject({ role: 'text', name: 'Buyer tax ID' });
  });

  it('reports a confirmation it dismissed and accepts it only when asked', async () => {
    await page.setContent(`<button id="issue" onclick="document.querySelector('#state').textContent = confirm('Issue the invoice?') ? 'Issued' : 'Kept'">Issue</button><p id="state">Draft</p>`);
    // The fixture's own Playwright connection must leave the dialog to the executor.
    page.on('dialog', () => undefined);
    const dismissed = await run('click', { target: '#issue' });
    expect(dismissed).toMatchObject({ ok: true, dialogs: [{ type: 'confirm', handled: 'dismissed', message: 'Issue the invoice?' }],
      dialogNote: expect.stringMatching(/acceptDialog/) });
    expect(await page.locator('#state').textContent()).toBe('Kept');
    const accepted = await run('click', { target: '#issue', acceptDialog: true });
    expect(accepted).toMatchObject({ ok: true, dialogs: [{ type: 'confirm', handled: 'accepted' }] });
    expect(accepted).not.toHaveProperty('dialogNote');
    expect(await page.locator('#state').textContent()).toBe('Issued');
  });

  it('reports input that replaced the page as done and returns the new page', async () => {
    await page.setContent(`<a href="${origin}/journey/receipt?applicant=Ada">Send</a>`);
    bridge.claim.url = page.url();
    const result = await run('click', { target: 'text=Send' });
    expect(result).toMatchObject({ ok: true, inputDispatched: true });
    expect(result.observation.nodes.some((node: any) => node.role === 'heading' && node.name === 'Request recorded')).toBe(true);
  }, 20_000);

  it('bounds a contextless snapshot and releases the tab queue for a fresh observation', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const deadlines: Array<() => void> = [];
    const timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: any[]) => void,
      milliseconds?: number, ...args: any[]) => {
      const timer = originalSetTimeout(callback, milliseconds, ...args);
      if (milliseconds === 30_000) deadlines.push(() => { clearTimeout(timer); callback(...args); });
      return timer;
    }) as typeof setTimeout);
    const controller = new AbortController();
    bridge.dropDefaultContexts = true;
    const stalled = run('snapshot', {}, () => true, controller.signal).then(
      value => ({ kind: 'result' as const, value }), error => ({ kind: 'error' as const, error }));
    try {
      // Chrome bootstrap completes, but the frame has no default context and no CDP request is outstanding.
      await vi.waitFor(() => {
        expect(bridge.contexts.some(context => context.isDefault)).toBe(true);
        expect(bridge.methods).toContain('Page.createIsolatedWorld');
        expect(bridge.pendingCount).toBe(0);
      }, { timeout: 3000 });
      expect(deadlines.length).toBeGreaterThan(0);
      deadlines[0]();
      const outcome = await Promise.race([stalled, new Promise<never>((_resolve, reject) =>
        originalSetTimeout(() => reject(new Error('Expired contextless snapshot retained the tab queue')), 3000))]);
      expect(outcome).toMatchObject({ kind: 'error', error: { code: 'BROWSER_ACTION_DEADLINE', noActionDispatched: true } });
      timerSpy.mockRestore();
      bridge.dropDefaultContexts = false;
      const recovered = await run('snapshot');
      expect(recovered.nodes.some((node: any) => node.role === 'button' && node.name === 'Continue')).toBe(true);
    } finally { timerSpy.mockRestore(); controller.abort(); }
  }, 15_000);

  it('waits for an overlay to clear and handles cross-origin iframe refs', async () => {
    await page.evaluate("const overlay=document.createElement('div');overlay.id='overlay';overlay.style='position:fixed;inset:0;z-index:1000;background:white';document.body.append(overlay);setTimeout(()=>overlay.remove(),350)");
    await run('click', { target: '#action' });
    expect(await page.locator('#result').textContent()).toBe('Done');
    const frameUrl = origin.replace('127.0.0.1', 'localhost') + '/frame';
    await page.evaluate(`const iframe=document.createElement('iframe');iframe.src=${JSON.stringify(frameUrl)};document.body.append(iframe)`);
    await page.locator('iframe').contentFrame().locator('#inside').waitFor();
    const snapshot = await run('snapshot');
    const input = snapshot.nodes.find((node: any) => node.name === 'Frame name');
    expect(input).toBeTruthy();
    await run('type', { target: input.ref, text: 'Inside frame' });
    expect(await page.locator('iframe').contentFrame().locator('#inside').inputValue()).toBe('Inside frame');
  });

  it('does not return blocked iframe content or screenshots, and rejects blocked selectors', async () => {
    await page.evaluate(`const frame=document.createElement('iframe');frame.src=${JSON.stringify(origin + '/blocked')};document.body.append(frame)`);
    await page.locator('iframe').contentFrame().locator('#private').waitFor();
    const allow = (url: string) => !url.includes('/blocked');
    const snapshot = await run('snapshot', {}, allow);
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE BLOCKED CONTENT');
    await expect(run('screenshot', {}, allow)).rejects.toThrow(/blocked/);
    const captureCount = bridge.methods.filter(method => method === 'Page.captureScreenshot').length;
    await emitExternalBrowserFrame({ command: bridge.command, getClaim: bridge.getClaim,
      subscribePlaywright: bridge.subscribePlaywright, isFrameAllowed: allow }, bridge.claim, scope);
    expect(bridge.methods.filter(method => method === 'Page.captureScreenshot')).toHaveLength(captureCount);
    await expect(run('type', { target: 'iframe >> internal:control=enter-frame >> #private', text: 'No' }, allow)).rejects.toThrow();
    expect(await page.locator('iframe').contentFrame().locator('#private').inputValue()).toBe('');
  });

  it('keeps observed refs after an optional preview is denied, but rejects them after navigation', async () => {
    await page.evaluate(`const frame=document.createElement('iframe');frame.src=${JSON.stringify(origin + '/blocked')};document.body.append(frame)`);
    await page.locator('iframe').contentFrame().locator('#private').waitFor();
    const allow = (url: string) => !url.includes('/blocked');
    const snapshot = await run('snapshot', {}, allow);
    const reference = snapshot.nodes.find((node: any) => node.role === 'button' && node.name === 'Continue');
    expect(reference).toBeTruthy();
    await emitExternalBrowserFrame({ command: bridge.command, getClaim: bridge.getClaim,
      subscribePlaywright: bridge.subscribePlaywright, isFrameAllowed: allow }, bridge.claim, scope);
    expect(bridge.methods).not.toContain('Page.captureScreenshot');
    const clicked = await run('click', { target: reference.ref }, allow);
    expect(clicked.observation.nodes.some((node: any) => node.name === 'Done')).toBe(true);
    const currentRef = clicked.observation.nodes.find((node: any) => node.role === 'button' && node.name === 'Continue').ref;
    await page.reload();
    const inputCount = bridge.methods.filter(method => method.startsWith('Input.')).length;
    await expect(run('click', { target: currentRef }, allow)).rejects.toThrow(/document changed/);
    expect(bridge.methods.filter(method => method.startsWith('Input.'))).toHaveLength(inputCount);
    expect(await page.locator('#result').textContent()).toBe('');
  });

  it('keeps observed refs after an idle transport detach, but rejects them after navigation', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const idleTimers: Array<() => void> = [];
    const timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: any[]) => void,
      milliseconds?: number, ...args: any[]) => {
      const timer = originalSetTimeout(callback, milliseconds, ...args);
      if (milliseconds === 45_000) idleTimers.push(() => { clearTimeout(timer); callback(...args); });
      return timer;
    }) as typeof setTimeout);
    let snapshot: any;
    try {
      snapshot = await run('snapshot');
      // The last idle timer is installed only after the completed operation releases its lease.
      expect(idleTimers.length).toBeGreaterThan(0);
      idleTimers.at(-1)!();
      await new Promise<void>(resolve => originalSetTimeout(resolve, 30));
    } finally { timerSpy.mockRestore(); }
    const reference = snapshot.nodes.find((node: any) => node.role === 'button' && node.name === 'Continue');
    expect(reference).toBeTruthy();
    const clicked = await run('click', { target: reference.ref });
    expect(clicked.observation.nodes.some((node: any) => node.name === 'Done')).toBe(true);
    const currentRef = clicked.observation.nodes.find((node: any) => node.role === 'button' && node.name === 'Continue').ref;
    await page.reload();
    const inputCount = bridge.methods.filter(method => method.startsWith('Input.')).length;
    await expect(run('click', { target: currentRef })).rejects.toThrow(/document changed/);
    expect(bridge.methods.filter(method => method.startsWith('Input.'))).toHaveLength(inputCount);
    expect(await page.locator('#result').textContent()).toBe('');
  });

  it.each(['scope', 'all'] as const)('revokes %s work while an old connection is recycling, before a new lease or input', async close => {
    await run('snapshot');
    await page.reload();
    const originalCommand = bridge.command;
    let release!: () => void, entered = false, held = false, starts = 0;
    const cleanup = new Promise<void>(resolve => { release = resolve; });
    bridge.command = async (...args: Parameters<FixtureBridge['command']>) => {
      if (args[1] === 'playwrightStart') starts++;
      // Recycling ends the old lease without detaching; hold that cleanup open.
      if (args[1] === 'playwrightEnd' && !held) {
        held = true; entered = true;
        await cleanup;
      }
      return originalCommand(...args);
    };
    const waiting = run('click', { target: '#action' }).then(
      value => ({ kind: 'result' as const, value }), error => ({ kind: 'error' as const, error }));
    try {
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 2000 });
      // Recycling has removed the old session before its asynchronous detach
      // finishes. Revocation must still cover the old work in this empty gap.
      if (close === 'scope') await closeExternalBrowserPlaywrightScope(scope);
      else await closeAllExternalBrowserPlaywright();
      const startsAtClose = starts;
      const inputsAtClose = bridge.methods.filter(method => method.startsWith('Input.')).length;
      release();
      const outcome = await waiting;
      expect.soft(outcome).toMatchObject({ kind: 'error', error: { noActionDispatched: true } });
      expect.soft(starts).toBe(startsAtClose);
      expect.soft(bridge.methods.filter(method => method.startsWith('Input.'))).toHaveLength(inputsAtClose);
      expect.soft(await page.locator('#result').textContent()).toBe('');
      const recovered = await run('snapshot');
      const reference = recovered.nodes.find((node: any) => node.role === 'button' && node.name === 'Continue');
      await page.evaluate("document.querySelector('#result').textContent=''");
      const completed = await run('click', { target: reference.ref });
      expect(completed.observation.nodes.some((node: any) => node.name === 'Done')).toBe(true);
    } finally { release(); await waiting; bridge.command = originalCommand; }
  }, 15_000);

  it('cancels waiting input, revokes user-stopped claims and accepts approved uploads by ref', async () => {
    const controller = new AbortController();
    const pending = run('click', { target: '#missing' }, undefined, controller.signal);
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toThrow(/cancelled/);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-browser-upload-fixture-'));
    const file = path.join(temporary, 'fixture.txt'); fs.writeFileSync(file, 'fixture upload');
    try {
      const snapshot = await run('snapshot');
      const reference = snapshot.nodes.find((node: any) => node.name === 'Attachment');
      const uploaded = await run('upload', { target: reference.ref, paths: [file] });
      expect(uploaded.uploaded).toBe(1);
      expect(await page.locator('#file').evaluate((el: any) => el.files[0].name)).toBe('fixture.txt');
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    bridge.stop();
    await expect(run('click', { target: '#action' })).rejects.toThrow(/changed|cancelled/);
  });

  it('completes a request through native and custom controls, shadow DOM, keyboard, scroll, upload and navigation', async () => {
    await page.goto(origin + '/journey');
    let observation = await run('snapshot');
    const reference = (name: string, role?: string) => {
      const matches = observation.nodes.filter((node: any) => node.name.startsWith(name) && (!role || node.role === role));
      expect(matches).toHaveLength(1);
      return matches[0].ref;
    };
    const act = async (action: string, args: Record<string, any>) => {
      const result = await run(action, args);
      expect(result.ok).not.toBe(false);
      if (result.observation) observation = result.observation;
      return result;
    };
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-browser-journey-'));
    const file = path.join(temporary, 'evidence.txt'); fs.writeFileSync(file, 'isolated fixture evidence');
    try {
      await act('type', { target: reference('Applicant'), text: 'Fixture Applicant' });
      await act('selectOption', { target: reference('Category', 'combobox'), values: ['priority'] });
      await act('click', { target: reference('Delivery') });
      await act('click', { target: reference('Courier', 'option') });
      expect(observation.nodes.find((node: any) => node.name === 'Delivery').state.expanded).toBe(false);
      await act('type', { target: reference('Contact'), text: 'fixture@example.invalid' });
      await act('type', { target: reference('Notes'), text: 'Review' });
      await act('pressKey', { key: 'End' });
      await act('pressKey', { key: 'Space' });
      await act('pressKey', { key: 'A' });
      await act('click', { target: reference('I agree') });
      expect(observation.nodes.find((node: any) => node.name === 'I agree').state.checked).toBe(true);
      await act('upload', { target: reference('Evidence'), paths: [file] });
      await act('scroll', { deltaY: 700 });
      await page.waitForFunction(() => (globalThis as any).scrollY > 0);
      await act('click', { target: reference('Send request') });
      expect(page.url()).toContain('/journey/receipt?');
      const receipt = JSON.parse((await page.locator('output').textContent())!);
      expect(receipt).toMatchObject({ applicant: 'Fixture Applicant', category: 'priority', delivery: 'courier',
        contact: 'fixture@example.invalid', notes: 'Review A', accepted: 'on', evidence: 'evidence.txt' });
      expect(observation.nodes.some((node: any) => node.name === 'Request recorded')).toBe(true);
      const consoleResult = await run('consoleMessages');
      const network = await run('networkRequests');
      expect.soft(consoleResult.messages.some((message: any) => message.text === 'fixture request sent')).toBe(true);
      expect.soft(network.requests.some((request: any) => request.url.includes('/journey/receipt?'))).toBe(true);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }, 20_000);

  it('keeps two task tabs separate while one task is cancelled and stopped and the other completes', async () => {
    const otherPage = await browser.newPage(); await otherPage.goto(origin + '/?other-task');
    const other = await FixtureBridge.create(debugPort, otherPage);
    const otherScope = { sessionKey: 'other-fixture', channel: 'test', chatId: 'other-fixture' };
    const runOther = (action: string, args: Record<string, any> = {}) =>
      executeExternalBrowserPlaywright(other, other.claim, otherScope, action, args, () => true);
    const controller = new AbortController();
    try {
      const snapshots = await Promise.all([run('snapshot'), runOther('snapshot')]);
      const otherName = snapshots[1].nodes.find((node: any) => node.name === 'Name').ref;
      const inputCount = bridge.methods.filter(method => method.startsWith('Input.')).length;
      await expect(run('type', { target: otherName, text: 'wrong tab' })).rejects.toThrow(/stale/);
      expect(bridge.methods.filter(method => method.startsWith('Input.'))).toHaveLength(inputCount);
      const waiting = run('click', { target: '#missing-control' }, () => true, controller.signal);
      const outcome = waiting.then(() => null, error => error);
      const typed = await runOther('type', { target: otherName, text: 'Other task continued' });
      controller.abort();
      expect((await outcome)?.message).toMatch(/cancelled/);
      expect(await page.locator('#name').inputValue()).toBe('');
      expect(await otherPage.locator('#name').inputValue()).toBe('Other task continued');
      bridge.stop(); await closeExternalBrowserPlaywrightScope(scope);
      await expect(run('click', { target: '#action' })).rejects.toThrow(/changed|cancelled/);
      const nextRef = typed.observation.nodes.find((node: any) => node.role === 'button' && node.name === 'Continue').ref;
      const completed = await runOther('click', { target: nextRef });
      expect(completed.observation.nodes.some((node: any) => node.name === 'Done')).toBe(true);
      expect(await page.locator('#result').textContent()).toBe('');
    } finally { controller.abort(); await closeExternalBrowserPlaywrightScope(otherScope); other.close(); await otherPage.close(); }
  }, 15_000);

  it('denies browser-wide CDP and other targets even during an active action', async () => {
    const relay = new ExternalBrowserPlaywrightRelay(bridge.claim, () => true);
    await relay.begin(bridge, origin, false, true);
    const endpoint = await relay.start();
    const socket = new WebSocket(endpoint);
    await new Promise<void>(resolve => socket.once('open', resolve));
    const send = (method: string, params = {}) => new Promise<any>(resolve => {
      socket.once('message', raw => resolve(JSON.parse(String(raw)))); socket.send(JSON.stringify({ id: 1, method, params }));
    });
    expect((await send('Storage.getCookies')).error.message).toMatch(/Browser-wide/);
    expect((await send('Target.attachToTarget', { targetId: 'other-tab' })).error.message).toMatch(/another tab/);
    await expect(relay.send('Runtime.evaluate', { expression: 'document.body.innerText', contextId: 987654321 })).rejects.toThrow(/identity.*blocked/);
    socket.terminate(); await relay.close();
  });

  it('uses the same executor for Memmy tabs and reports input sent when the post-action observation fails', async () => {
    bridge.claim.browser = 'memmy';
    const snapshot = await run('snapshot');
    expect(snapshot.nodes.some((node: any) => node.name === 'Continue')).toBe(true);
    await expect(run('screenshot')).rejects.toThrow(/not supported/);
    await run('snapshot');
    bridge.rejectObservation = true;
    const failedObservation = await run('click', { target: '#action' });
    expect(failedObservation).toMatchObject({ ok: false, dispatchState: 'confirmed',
      inputDispatched: true, noActionDispatched: false, freshObservationRequired: true });
    expect(await page.locator('#result').textContent()).toBe('Done');
  });

  it('never rebinds snapshot refs to replacement controls, even when cloneNode copies their attributes', async () => {
    const snapshot = await run('snapshot');
    const ref = (name: string) => snapshot.nodes.find((node: any) => node.name === name)?.ref as string;
    const refs = { click: ref('Continue'), type: ref('Name'), selectOption: ref('Choice'),
      upload: ref('Attachment') };
    expect(Object.values(refs).every(Boolean)).toBe(true);
    await page.evaluate((refs: Record<string, string>) => {
      const doc = (globalThis as any).document;
      for (const [id, ref] of [['action', refs.click], ['name', refs.type],
        ['select', refs.selectOption], ['file', refs.upload]]) {
        const old = doc.getElementById(id);
        // A legacy marker is deliberately copied to the replacement. A ref
        // must still remain bound to the original DOM node.
        old.setAttribute('data-memmy-playwright-ref', ref);
        const replacement = old.cloneNode(true);
        replacement.id = `replacement-${id}`;
        old.replaceWith(replacement);
      }
      doc.getElementById('replacement-action').onclick = () => {
        doc.getElementById('result').textContent = 'Wrong replacement clicked';
      };
    }, refs);
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-ref-identity-'));
    const uploadFile = path.join(uploadDir, 'approved.txt');
    fs.writeFileSync(uploadFile, 'isolated fixture');
    try {
      for (const [action, args] of [
        ['click', { target: refs.click }],
        ['type', { target: refs.type, text: 'Wrong replacement typed' }],
        ['selectOption', { target: refs.selectOption, values: ['b'] }],
        ['upload', { target: refs.upload, paths: [uploadFile] }],
        ['screenshot', { target: refs.click }],
      ] as const) {
        await expect(run(action, args)).rejects.toThrow(/stale|removed|replaced/i);
      }
      expect(bridge.methods.some(method => method.startsWith('Input.') || method === 'DOM.setFileInputFiles')).toBe(false);
      expect(await page.locator('#result').textContent()).toBe('');
      expect(await page.locator('#replacement-name').inputValue()).toBe('');
      expect(await page.locator('#replacement-select').inputValue()).toBe('a');
      expect(await page.locator('#replacement-file').evaluate((input: any) => input.files?.length)).toBe(0);
      const explicit = await run('click', { target: '#replacement-action' });
      expect(explicit.observation.nodes.some((node: any) => node.name === 'Wrong replacement clicked')).toBe(true);
    } finally { fs.rmSync(uploadDir, { recursive: true, force: true }); }
  }, 30_000);

  it('rejects references from a reloaded document and supports unique :has-text selectors', async () => {
    const snapshot = await run('snapshot');
    const reference = snapshot.nodes.find((node: any) => node.role === 'button' && node.name === 'Continue');
    await page.reload();
    await expect(run('click', { target: reference.ref })).rejects.toThrow(/document changed/);
    expect(await page.locator('#result').textContent()).toBe('');
    const current = await run('click', { target: 'button:has-text("Continue")' });
    expect(current.observation.nodes.some((node: any) => node.name === 'Done')).toBe(true);
  });

  it('bounds large tables and many frames across the whole observation, while a narrow find reaches a deep control', async () => {
    await page.evaluate(() => {
      const doc = (globalThis as any).document;
      const table = doc.createElement('div');
      table.innerHTML = Array.from({ length: 2200 }, (_, index) => `<span>Row ${index} ${'x'.repeat(100)}</span>`).join('');
      doc.body.prepend(table);
      const deep = doc.createElement('button'); deep.textContent = 'Deep unique action'; doc.body.append(deep);
      for (let index = 0; index < 35; index++) {
        const frame = doc.createElement('iframe'); frame.srcdoc = `<button>Nested ${index}</button>`; doc.body.append(frame);
      }
    });
    await page.waitForFunction(() => (globalThis as any).document.querySelectorAll('iframe').length === 35);
    const snapshot = await run('snapshot');
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.nodes.length).toBeLessThanOrEqual(EXTERNAL_BROWSER_SNAPSHOT_BUDGET.nodes);
    expect(JSON.stringify(snapshot.nodes).length).toBeLessThan(EXTERNAL_BROWSER_SNAPSHOT_BUDGET.characters + 1000);
    const found = await run('find', { text: 'Deep unique action' });
    expect(found.nodes.some((node: any) => node.name === 'Deep unique action')).toBe(true);
    expect(found.truncated).toBe(true);
  });

  it('discards screenshot bytes when a frame navigates to a blocked site during capture', async () => {
    await page.evaluate(`const frame=document.createElement('iframe');frame.src=${JSON.stringify(origin + '/frame')};document.body.append(frame)`);
    await page.locator('iframe').contentFrame().locator('#inside').waitFor();
    const command = bridge.command;
    bridge.command = async (identity, name, args = {}, signal, settle) => {
      if (name !== 'playwrightCdp' || args.method !== 'Page.captureScreenshot') return command(identity, name, args, signal, settle);
      const result = await command(identity, name, args, signal);
      // An ordered transport delivers the navigation events before this reply.
      await page.locator('iframe').evaluate((el: any, url: string) => { el.src = url; }, origin + '/blocked');
      await page.locator('iframe').contentFrame().locator('#private').waitFor();
      settle?.({ ok: true, result });
      return result;
    };
    await expect(run('screenshot', {}, url => !url.includes('/blocked'))).rejects.toThrow(/blocked/);
  });

  it('blocks untargeted click, keyboard and wheel before input when an iframe is denied, while allowed DOM targets still work', async () => {
    await page.evaluate(`const frame=document.createElement('iframe');frame.src=${JSON.stringify(origin + '/blocked')};document.body.append(frame)`);
    const privateInput = page.locator('iframe').contentFrame().locator('#private');
    await privateInput.waitFor(); await privateInput.focus();
    const allow = (url: string) => !url.includes('/blocked');
    for (const [action, args] of [
      ['click', { x: 20, y: 180 }], ['pressKey', { key: 'A' }], ['scroll', { deltaY: 300 }],
    ] as Array<[string, Record<string, unknown>]>) {
      const inputCount = bridge.methods.filter(method => method.startsWith('Input.')).length;
      await expect(run(action, args, allow)).rejects.toThrow(/Untargeted input.*blocked/);
      expect(bridge.methods.filter(method => method.startsWith('Input.'))).toHaveLength(inputCount);
    }
    expect(await privateInput.inputValue()).toBe('');
    const allowed = await run('click', { target: '#action' }, allow);
    expect(allowed.ok).toBe(true);
    expect(await page.locator('#result').textContent()).toBe('Done');
  });
});
