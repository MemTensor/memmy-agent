/** Real installed Chrome/Edge regression checks for the production extension's actions.
 * Bundle with esbuild (node/esm and a createRequire banner), then run in the
 * interactive Windows session: browser executable extension-dir output-dir playwright-package.
 */
import { ExternalBrowserBridge } from '../../src/core/agent-runtime/tools/external-browser-bridge.js';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const [browserName, executable, extensionSource, output, playwrightPackage] = process.argv.slice(2);
if (!['edge', 'chrome'].includes(browserName) || !playwrightPackage) throw Error('Missing live browser test arguments');
const run = path.join(output, browserName + '-actions-' + Date.now());
fs.mkdirSync(run, { recursive: true });
const report = { browserName, scenario: 'actions', startedAt: new Date().toISOString(), checks: {}, rejections: {}, commands: [], passed: false };
if (process.platform === 'win32') report.windowsSession = Number(execFileSync('powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command', '(Get-Process -Id $PID).SessionId'], { encoding: 'utf8' }).trim());
const require = createRequire(import.meta.url), { chromium } = require(path.resolve(playwrightPackage));
const bridge = new ExternalBrowserBridge(), { port } = await bridge.start(0);
const ext = path.join(run, 'extension');
fs.cpSync(extensionSource, ext, { recursive: true });
const background = path.join(ext, 'background.js');
fs.writeFileSync(background, fs.readFileSync(background, 'utf8').replace(/const BRIDGE_PORTS = \[[^\]]+\]/, 'const BRIDGE_PORTS = [' + port + ']'));
const html = `<!doctype html><html><meta charset="utf-8"><title>External browser action regression</title>
<style>body{font:18px system-ui;margin:40px}label{display:block;margin:10px}input,select,button{font:inherit;padding:6px}#covered-wrap{position:relative;width:240px}#overlay{position:absolute;inset:0;background:#ddd}#covered{width:240px}</style>
<h1>External browser action regression</h1><a id="next" href="/next">Next</a>
<button id="same-a" onclick="window.lastClick='a'">Repeat</button><button id="same-b" onclick="window.lastClick='b'">Repeat</button>
<button hidden id="hidden">Hidden target</button><button disabled id="disabled">Disabled target</button>
<div id="covered-wrap"><button id="covered" onclick="window.lastClick='covered'">Covered</button><div id="overlay">Overlay</div></div>
<form onsubmit="event.preventDefault();window.submitted=true">
<label>Invoice <input id="invoice" name="invoice"></label>
<label>Date <input id="date" type="date" required></label>
<label>Month <input id="month" type="month"></label>
<label>Week <input id="week" type="week"></label>
<label>Time <input id="time" type="time"></label>
<label>Local date time <input id="localtime" type="datetime-local"></label>
<label>Read only <input id="readonly" readonly value="retained"></label>
<label>Category <select id="category"><option value="travel">差旅</option><option value="office">办公</option><option value="closed" disabled>Unavailable</option></select></label>
<label>Rejected input <input id="rejected" oninput="this.value='rejected'"></label>
<label>Rejected selection <select id="rejected-select" onchange="this.value='a'"><option value="a">A</option><option value="b">B</option></select></label>
<button type="submit">Submit test</button></form></html>`;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' });
  res.end(req.url === '/next' ? '<html><title>Next page</title><h1>Reached next page</h1></html>' : html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(fn, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(100); }
  throw Error('Timeout: ' + label);
}
function check(name, value) {
  report.checks[name] = value === true;
  if (!report.checks[name]) throw Error('Failed: ' + name);
}
async function reject(name, action, pattern) {
  let error;
  try { await action(); } catch (value) { error = String(value); }
  report.rejections[name] = error ?? null;
  check(name, Boolean(error && pattern.test(error)));
}
let context, page, idle;
async function call(command, args = {}) {
  await idle.bringToFront();
  const claim = await wait(() => bridge.listClaims().find(value => value.url === page.url()), 'current page claim');
  report.commands.push({ command, args });
  return bridge.command(claim, command, args);
}
async function reset() { await page.goto(base + '/form'); await idle.bringToFront(); }
try {
  context = await chromium.launchPersistentContext(path.join(run, 'profile'), { executablePath: executable,
    headless: false, viewport: { width: 1280, height: 1100 },
    args: ['--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check'], ignoreDefaultArgs: ['--disable-extensions'] });
  const cdp = await context.browser().newBrowserCDPSession();
  report.version = await cdp.send('Browser.getVersion');
  await cdp.send('Extensions.loadUnpacked', { path: ext });
  await cdp.detach();
  page = context.pages()[0]; idle = await context.newPage(); await idle.goto('about:blank');
  for (const syntax of ['bare-ax', 'bracketed-ax', 'css', 'text', 'has-text']) {
    await reset();
    const snapshot = await call('snapshot');
    const link = snapshot.nodes.find(node => node.role === 'link' && node.name === 'Next');
    if (!link) throw Error('Missing accessible link');
    const target = syntax === 'bare-ax' ? link.ref : syntax === 'bracketed-ax' ? '[' + link.ref + ']'
      : syntax === 'css' ? 'a[href="/next"]' : syntax === 'text' ? 'text=Next' : 'a:has-text("Next")';
    await call('click', { target });
    await page.waitForURL(base + '/next');
    check(syntax + 'Navigates', await page.locator('h1').innerText() === 'Reached next page');
  }
  await reset();
  await reject('ambiguousTextRejected', () => call('click', { target: 'text=Repeat' }), /ambiguous/i);
  check('ambiguousDoesNotClick', await page.evaluate(() => window.lastClick === undefined));
  await call('click', { target: 'text=Repeat >> nth=1' });
  check('explicitNthClicksSecond', await page.evaluate(() => window.lastClick === 'b'));
  await reject('invalidCssReported', () => call('click', { target: 'input[' }), /locator failed|SyntaxError/i);
  await reject('missingTargetRejected', () => call('click', { target: '#absent' }), /no longer available/i);
  await reject('hiddenTargetRejected', () => call('click', { target: '#hidden' }), /not visible/i);
  await reject('disabledTargetRejected', () => call('click', { target: '#disabled' }), /disabled/i);
  await reject('coveredTargetRejected', () => call('click', { target: '#covered' }), /covered/i);
  check('rejectedTargetsDoNotClick', await page.evaluate(() => window.lastClick === 'b'));
  await call('type', { target: '#invoice', text: '发票-REPLAY-02' });
  check('textValueVerified', await page.locator('#invoice').inputValue() === '发票-REPLAY-02');
  await call('type', { target: '#invoice', text: 'replacement' });
  check('textReplacesOldValue', await page.locator('#invoice').inputValue() === 'replacement');
  await call('type', { target: '#invoice', text: '' });
  check('emptyTextClearsField', await page.locator('#invoice').inputValue() === '');
  await reject('readonlyInputRejected', () => call('type', { target: '#readonly', text: 'changed' }), /not editable/i);
  check('readonlyValueUnchanged', await page.locator('#readonly').inputValue() === 'retained');
  for (const [id, text] of [['date', '2026-10-21'], ['month', '2026-10'], ['week', '2026-W43'], ['time', '09:30'], ['localtime', '2026-10-23T09:30']]) {
    await call('type', { target: '#' + id, text });
    check(id + 'CanonicalValue', await page.locator('#' + id).inputValue() === text);
  }
  await reject('invalidDateRejected', () => call('type', { target: '#date', text: '2026-02-31' }), /invalid native date|not accepted/i);
  check('invalidDatePreservesPriorValue', await page.locator('#date').inputValue() === '2026-10-21');
  await call('selectOption', { target: '#category', values: ['office'] });
  check('selectedValueVerified', await page.locator('#category').inputValue() === 'office');
  await reject('missingOptionRejected', () => call('selectOption', { target: '#category', values: ['missing'] }), /unavailable/i);
  await reject('disabledOptionRejected', () => call('selectOption', { target: '#category', values: ['closed'] }), /unavailable/i);
  check('rejectedOptionsPreserveValue', await page.locator('#category').inputValue() === 'office');
  await reject('rejectedInputIsNotSuccess', () => call('type', { target: '#rejected', text: 'wanted', submit: true }), /does not match/i);
  check('unverifiedInputDoesNotSubmit', await page.evaluate(() => window.submitted !== true));
  await reject('rejectedSelectIsNotSuccess', () => call('selectOption', { target: '#rejected-select', values: ['b'] }), /not accepted/i);
  await page.screenshot({ path: path.join(run, 'verified-actions.png'), fullPage: true });
  const snapshot = await call('snapshot'), stale = snapshot.nodes.find(node => node.role === 'link' && node.name === 'Next').ref;
  await page.goto(base + '/next'); await idle.bringToFront();
  await reject('staleAxRejected', () => call('click', { target: '[' + stale + ']' }), /no longer|not found|resolve|node|document/i);
  report.passed = Object.values(report.checks).every(Boolean);
} catch (error) {
  report.error = error.stack || String(error); process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(run, 'failure.png'), fullPage: true }).catch(() => undefined);
} finally {
  const results = await Promise.allSettled([context?.close(), bridge.close()]);
  await new Promise(resolve => server.close(resolve));
  const errors = results.filter(value => value.status === 'rejected');
  if (errors.length) { report.cleanupErrors = errors.map(value => String(value.reason)); report.passed = false; process.exitCode = 1; }
  report.endedAt = new Date().toISOString();
  fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ run, ...report }));
}
