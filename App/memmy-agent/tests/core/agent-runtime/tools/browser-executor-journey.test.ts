import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExternalBrowserBridge } from '../../../../src/core/agent-runtime/tools/external-browser-bridge.js';
import { ExternalBrowserSessionRouter } from '../../../../src/core/agent-runtime/tools/external-browser-session-router.js';
import { BrowserSessionManager } from '../../../../src/core/agent-runtime/tools/browser.js';
import { BrowserUseSitePolicyReader } from '../../../../src/core/agent-runtime/tools/browser-use-site-policy-store.js';
import { BrowserCapabilityApproval } from '../../../../src/core/agent-runtime/tools/browser-capability-approval.js';
import { closeAllExternalBrowserPlaywright } from '../../../../src/core/agent-runtime/tools/external-browser-playwright.js';

// Requires a full Chromium/Chrome for Testing executable: branded Chrome disables
// loading unpacked extensions from the command line. Every profile and bridge is
// private to this test; no existing browser, Memmy process or profile is used.
const executable = process.env.MEMMY_BROWSER_TEST_EXECUTABLE || chromium.executablePath();
const extensionSource = fileURLToPath(new URL('../../../../../shell/desktop/extensions/memmy-browser', import.meta.url));
const scope = { sessionKey: 'real-extension-journey', channel: 'test', chatId: 'real-extension-journey' };
const markup = `<title>Isolated request fixture</title><h1>Request form</h1><form action="/receipt">
 <label>Name<input name="name" required></label><label><input type="checkbox" name="agreed" required>Agree</label>
 <label>Evidence<input type="file" name="evidence"></label>
 <button>Send request</button></form><button id="notice" onclick="alert('Isolated fixture notice');document.querySelector('#result').textContent='Notice dismissed'">Show notice</button>
 <a href="/popup" target="_blank">Open related page</a><div id="result"></div>
 <script>document.querySelector('form').onsubmit=()=>console.log('isolated fixture submitted');</script>`;

describe.skipIf(!fs.existsSync(executable))('production extension through the real bridge, router and browser tools', () => {
  let root: string;
  let server: http.Server;
  let context: BrowserContext;
  let bridge: ExternalBrowserBridge;
  let manager: BrowserSessionManager;

  afterEach(async () => {
    await manager?.close(); await closeAllExternalBrowserPlaywright();
    await context?.close(); await bridge?.close();
    if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    vi.unstubAllEnvs();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('observes, fills, dismisses a notice, opens a related tab and submits using the unmocked MV3 worker', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-real-extension-journey-'));
    vi.stubEnv('MEMMY_AGENT_DATA_DIR', path.join(root, 'agent-data'));
    server = http.createServer((request, response) => {
      response.setHeader('content-type', 'text/html');
      const url = new URL(request.url || '/', 'http://fixture');
      response.end(url.pathname === '/receipt' ? `<h1>Request received</h1><output>${url.searchParams.get('name')} ${url.searchParams.get('agreed')} ${url.searchParams.get('evidence')}</output>`
        : url.pathname === '/frame' ? '<label>Frame note<input></label>'
        : url.pathname === '/popup' ? '<title>Related fixture</title><h1>Related page ready</h1><label>Related note<input></label>' : markup);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    bridge = new ExternalBrowserBridge(); const { port } = await bridge.start(0);
    const extension = path.join(root, 'extension'); fs.cpSync(extensionSource, extension, { recursive: true });
    const workerPath = path.join(extension, 'background.js'); const worker = fs.readFileSync(workerPath, 'utf8');
    const discovery = 'const BRIDGE_PORTS = [47321, 47322, 47323];';
    expect(worker.split(discovery)).toHaveLength(2);
    // Only discovery is redirected to this test's random bridge. No Chrome API,
    // permission check, event, command, document epoch or input guard is mocked.
    fs.writeFileSync(workerPath, worker.replace(discovery, `const BRIDGE_PORTS = [${port}];`));
    context = await chromium.launchPersistentContext(path.join(root, 'profile'), { executablePath: executable,
      headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    const extensionWorker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 5000 });
    expect(extensionWorker.url()).toMatch(/^chrome-extension:\/\//);
    const page = await context.newPage(); await page.goto(origin);
    // The fixture's browser owner observes only. Without a listener both its
    // Playwright connection and Memmy's executor would dismiss the same alert.
    page.on('dialog', () => undefined);
    const control = await context.newPage(); await control.bringToFront();
    await vi.waitFor(() => expect(bridge.listClaims().some(claim => claim.url === origin + '/')).toBe(true), { timeout: 7000 });
    const policyPath = path.join(root, 'site-policy.json');
    fs.writeFileSync(policyPath, JSON.stringify({ version: 1, rules: [{ pattern: origin,
      access: 'allow', uploads: 'allow', downloads: 'block', fullCdp: 'block' }] }));
    const policy = new BrowserUseSitePolicyReader(policyPath);
    const router = new ExternalBrowserSessionRouter(bridge, async url => new URL(url).origin === origin, 'external', policy);
    manager = new BrowserSessionManager({ enabled: true }, { desktopManaged: false, externalRouter: router,
      embeddedBridge: null, embeddedRouter: null, capabilityApproval: new BrowserCapabilityApproval(policy) });
    const listed = await router.listTabs(scope, 'chrome');
    const main = listed.tabs.find(tab => tab.url === origin + '/')!; expect(main).toBeTruthy();
    const text = (result: string | Array<Record<string, any>>) => typeof result === 'string' ? result
      : result.filter(item => item.type === 'text').map(item => item.text).join('\n');
    const snapshot = text(await manager.callTool(scope, 'browser_snapshot', { targetBrowser: 'chrome', tabMention: main.tabMention }));
    const nameRef = /\[([^\]]+)\] textbox "Name"/.exec(snapshot)?.[1]; expect(nameRef).toBeTruthy();
    await manager.callTool(scope, 'browser_type', { target: nameRef, text: 'Isolated applicant' });
    expect(await page.locator('[name=name]').inputValue()).toBe('Isolated applicant');
    await page.evaluate((url: string) => {
      const doc = (globalThis as any).document, iframe = doc.createElement('iframe');
      iframe.src = url; doc.body.append(iframe);
    }, origin.replace('127.0.0.1', 'localhost') + '/frame');
    await page.locator('iframe').contentFrame().locator('input').waitFor();
    const framed = text(await manager.callTool(scope, 'browser_snapshot', {}));
    const frameRef = /\[([^\]]+)\] textbox "Frame note"/.exec(framed)?.[1]; expect(frameRef).toBeTruthy();
    const frameInput = text(await manager.callTool(scope, 'browser_type', { target: frameRef, text: 'Cross-frame note' }));
    expect(frameInput).not.toContain('"ok":false');
    expect(await page.locator('iframe').contentFrame().locator('input').inputValue()).toBe('Cross-frame note');
    await manager.callTool(scope, 'browser_click', { target: 'text=Show notice' });
    expect(await page.locator('#result').textContent()).toBe('Notice dismissed');
    const popupReady = context.waitForEvent('page');
    await manager.callTool(scope, 'browser_click', { target: 'text=Open related page' });
    const popup = await popupReady; await popup.waitForLoadState('domcontentloaded'); await control.bringToFront();
    await vi.waitFor(() => expect(bridge.listClaims().some(claim => claim.url === origin + '/popup')).toBe(true), { timeout: 5000 });
    const related = (await router.listTabs(scope, 'chrome')).tabs.find(tab => tab.url === origin + '/popup')!;
    const relatedScope = { sessionKey: 'related-task', channel: 'test', chatId: 'related-task' };
    const popupSnapshot = text(await manager.callTool(relatedScope, 'browser_snapshot', {
      targetBrowser: 'chrome', tabMention: related.tabMention }));
    expect(popupSnapshot).toContain('Related page ready');
    await manager.callTool(relatedScope, 'browser_type', { target: 'input', text: 'Separate related task' });
    expect(await popup.locator('input').inputValue()).toBe('Separate related task');
    expect(await page.locator('[name=name]').inputValue()).toBe('Isolated applicant');
    const cancel = new AbortController();
    const waiting = manager.callTool(scope, 'browser_click', { target: '#missing-fixture-control' }, cancel.signal);
    const outcome = waiting.then(() => null, error => error);
    setTimeout(() => cancel.abort(), 80);
    expect((await outcome)?.message).toMatch(/cancelled/);
    const recovered = text(await manager.callTool(scope, 'browser_snapshot', {}));
    expect(recovered).toContain('Isolated applicant');
    const file = path.join(root, 'evidence.txt'); fs.writeFileSync(file, 'isolated approved upload');
    await manager.callTool(scope, 'browser_file_upload', { target: 'input[type=file]', paths: [file] }, null,
      { workspace: root, readonlyRoots: [] });
    expect(await page.locator('[name=evidence]').evaluate((input: any) => input.files[0].name)).toBe('evidence.txt');
    await manager.callTool(scope, 'browser_click', { target: 'text=Agree' });
    expect(await page.locator('[name=agreed]').isChecked()).toBe(true);
    const submit = text(await manager.callTool(scope, 'browser_click', { target: 'text=Send request' }));
    await page.waitForURL('**/receipt?**');
    expect(await page.locator('output').textContent()).toBe('Isolated applicant on evidence.txt');
    // The submit replaced the document: that is the click's success, and the
    // result already shows the page it led to.
    expect(submit).toContain('"ok":true');
    expect(submit).toContain('Request received');
    const receipt = text(await manager.callTool(scope, 'browser_snapshot', {}));
    expect(receipt).toContain('Request received');
    const consoleLog = text(await manager.callTool(scope, 'browser_console_messages', {}));
    expect(consoleLog).toContain('isolated fixture submitted');
    fs.writeFileSync(policyPath, JSON.stringify({ version: 1, rules: [{ pattern: origin,
      access: 'block', uploads: 'block', downloads: 'block', fullCdp: 'block' }] }));
    await expect(manager.callTool(scope, 'browser_snapshot', {})).rejects.toThrow(/blocked/);
    await manager.closeSession(relatedScope);
    expect(page.isClosed()).toBe(false); expect(popup.isClosed()).toBe(false);
  }, 45_000);
});
