// Owned browser profiles and synthetic pages only. No full Memmy App is launched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const agent = path.resolve(here, '../../../../../../..');
const require = createRequire(path.join(agent, 'package.json'));
const { chromium } = require('playwright');
const kind = process.argv.includes('--browser=edge') ? 'edge' : 'chrome';
const channel = kind === 'edge' ? 'msedge' : 'chrome';
const dist = path.join(agent, 'dist/tools/computer-history');
const binary = process.env.MEMMY_WINDOWS_HISTORY_NATIVE_BIN ?? path.join(dist, 'win/memmy-history-recorder.exe');
const { WindowsHistoryRecorder } = await import(pathToFileURL(path.join(dist, 'win/recorder.js')));
const { compactEventEvidence } = await import(pathToFileURL(path.join(dist, 'core/summary-writer.js')));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), `memmy-generic-${kind}-`));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = (exe, args) => {
  const result = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 4e6 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
};
const native = args => JSON.parse(run(binary, args).trim().split('\n').at(-1));
const server = http.createServer((request, response) => {
  const book = request.url === '/b' ? 'B' : 'A';
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(`<title>Memmy Generic Browser ${book}</title><h1>BOOK_${book}_TITLE</h1><p>AUTHOR_${book}</p><input aria-label="Draft" value="ORDINARY_FIELD"><input type="password" value="PASSWORD_MUST_NOT_ESCAPE"><p style="margin-top:1600px">SCROLLED_${book}_DETAILS</p>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let context, recorder;
try {
  context = await chromium.launchPersistentContext(path.join(directory, 'profile'), {
    channel, headless: false, viewport: null, args: ['--window-size=1000,800'], timeout: 25000,
  });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(origin + '/a');
  const session = await context.browser().newBrowserCDPSession();
  const pid = (await session.send('SystemInfo.getProcessInfo')).processInfo.find(p => p.type === 'browser').id;
  const window = native(['windows', '--pid', String(pid)]).windows.find(w => w.title.startsWith('Memmy Generic Browser A'));
  assert.ok(window);
  run('powershell.exe', ['-NoProfile', '-File', path.join(here, 'activate-owned-window.ps1'), window.hwnd, String(pid)]);
  const policyFile = path.join(directory, 'policy.json');
  fs.writeFileSync(policyFile, JSON.stringify({ version: 1, applications: [{ pid, executable: window.context.executable,
    processStart: window.context.processStart, browser: kind, captureText: true }] }));
  await sleep(500);
  const raw = native(['snapshot', '--hwnd', window.hwnd, '--policy', policyFile]);
  fs.writeFileSync(path.join(directory, 'snapshot-a.json'), JSON.stringify(raw, null, 2));
  assert.equal(raw.snapshot.status, 'ok');
  assert.match(JSON.stringify(raw), /BOOK_A_TITLE/);
  assert.doesNotMatch(JSON.stringify(raw), /PASSWORD_MUST_NOT_ESCAPE/);
  if (raw.context.browser) assert.equal(raw.context.browser.url, origin + '/a');
  if (process.argv.includes('--diagnose-url')) {
    const script = `Add-Type -AssemblyName UIAutomationClient
$root=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${window.hwnd})
$condition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Document)
$documents=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition)
@($documents | ForEach-Object { $value=$null; $available=$_.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$value); @{name=$_.Current.Name; valueAvailable=$available; value=$(if($available){$value.Current.Value}else{$null})} }) | ConvertTo-Json -Compress`;
    fs.writeFileSync(path.join(directory, 'url-diagnostic.json'), run('powershell.exe', ['-NoProfile', '-Command', script]));
  }
  await page.getByText('SCROLLED_A_DETAILS', { exact: true }).scrollIntoViewIfNeeded();
  await sleep(300);
  const scrolled = native(['snapshot', '--hwnd', window.hwnd, '--policy', policyFile]);
  fs.writeFileSync(path.join(directory, 'snapshot-scrolled.json'), JSON.stringify(scrolled, null, 2));
  assert.equal(scrolled.snapshot.status, 'ok');
  assert.match(JSON.stringify(scrolled), /SCROLLED_A_DETAILS/);
  await page.evaluate(() => window.scrollTo(0, 0));
  const eventsFile = path.join(directory, 'events.jsonl');
  recorder = await WindowsHistoryRecorder.start({ binary, policyFile, eventsFile, seconds: 20, sampleMs: 500 });
  await sleep(1800);
  await page.goto(origin + '/b'); await sleep(1800);
  await recorder.stop(); recorder = undefined;
  const second = await context.newPage(); await second.goto(origin + '/b');
  await second.bringToFront(); await sleep(300);
  const tab = native(['snapshot', '--hwnd', window.hwnd, '--policy', policyFile]);
  fs.writeFileSync(path.join(directory, 'snapshot-tab.json'), JSON.stringify(tab, null, 2));
  assert.equal(tab.snapshot.status, 'ok'); assert.match(JSON.stringify(tab), /BOOK_B_TITLE/);
  if (tab.context.browser) assert.equal(tab.context.browser.url, origin + '/b');
  const saved = fs.readFileSync(eventsFile, 'utf8');
  const evidence = compactEventEvidence(saved.trim().split('\n'));
  fs.writeFileSync(path.join(directory, 'summary-evidence.txt'), evidence);
  for (const output of [saved, evidence]) {
    assert.match(output, /BOOK_A_TITLE/); assert.match(output, /BOOK_B_TITLE/);
    assert.doesNotMatch(output, /PASSWORD_MUST_NOT_ESCAPE/);
  }
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ status: 'passed', browser: kind, urlAvailable: !!raw.context.browser }));
  console.log(JSON.stringify({ directory, status: 'passed', browser: kind, urlAvailable: !!raw.context.browser }));
} catch (error) {
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ status: 'failed', reason: error.message }));
  throw error;
} finally {
  await recorder?.stop().catch(() => {});
  await context?.close();
  await new Promise(resolve => server.close(resolve));
}
