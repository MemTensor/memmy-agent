// An owned Electron fixture validates engine-level capture, not third-party App coverage.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../../../../../../..');
const dist = path.join(root, 'App/memmy-agent/dist/tools/computer-history');
const requireDesktop = createRequire(path.join(root, 'App/shell/desktop/package.json'));
const electron = process.env.MEMMY_ELECTRON_TEST_BIN ?? requireDesktop('electron');
const binary = process.env.MEMMY_WINDOWS_HISTORY_NATIVE_BIN ?? path.join(dist, 'win/memmy-history-recorder.exe');
const { compileWindowsPolicy } = await import(pathToFileURL(path.join(dist, 'win/policy.js')));
const { WindowsHistoryRecorder } = await import(pathToFileURL(path.join(dist, 'win/recorder.js')));
const { compactEventEvidence } = await import(pathToFileURL(path.join(dist, 'core/summary-writer.js')));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-electron-text-'));
const accessibility = process.env.MEMMY_ELECTRON_TEST_ACCESSIBILITY === 'on' ? 'on' : 'default';
const uiaProvider = process.env.MEMMY_ELECTRON_TEST_UIA === 'on';
const forceRenderer = process.env.MEMMY_ELECTRON_TEST_FORCE === 'on';
const appFile = path.join(directory, 'fixture.cjs');
fs.writeFileSync(appFile, `const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(path.join(directory, 'profile'))});
app.whenReady().then(()=>{${accessibility === 'on' ? 'app.setAccessibilitySupportEnabled(true);' : ''}const w=new BrowserWindow({width:900,height:700,webPreferences:{sandbox:true,contextIsolation:true}});
w.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<title>Memmy Electron Text Fixture</title><h1>ELECTRON_BODY_MARKER</h1><textarea aria-label="Draft">ORDINARY_EDIT_MARKER</textarea><input type="password" value="PASSWORD_MUST_NOT_ESCAPE"><p>password=syntheticcredential123</p>'));});
app.on('window-all-closed',()=>app.quit());`);
const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [...(uiaProvider ? ['--enable-features=UiaProvider'] : []), ...(forceRenderer ? ['--force-renderer-accessibility'] : []), appFile], { windowsHide: false, stdio: 'ignore', env: environment });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = (exe, args) => spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
const native = args => { const result = run(binary, args); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout.trim().split('\n').at(-1)); };
let recorder;
try {
  let window;
  for (let index = 0; index < 20; index++) {
    await sleep(500);
    window = native(['windows', '--pid', String(child.pid)]).windows.find(item => item.title === 'Memmy Electron Text Fixture');
    if (window) break;
  }
  assert.ok(window, 'Owned fixture window unavailable');
  const activation = run('powershell.exe', ['-NoProfile', '-File', path.join(here, 'activate-owned-window.ps1'), window.hwnd, String(child.pid)]);
  assert.equal(activation.status, 0, activation.stderr);
  const policyFile = path.join(directory, 'policy.json');
  fs.writeFileSync(policyFile, JSON.stringify(compileWindowsPolicy([], [{ pid: child.pid, executable: window.context.executable,
    processStart: window.context.processStart, hwnd: window.hwnd }], { defaultApplicationBehavior: 'observe' })));
  await sleep(750);
  let raw;
  for (let attempt = 0; attempt < 5; attempt++) {
    raw = native(['snapshot', '--hwnd', window.hwnd, '--policy', policyFile]);
    fs.writeFileSync(path.join(directory, `snapshot-${attempt}.json`), JSON.stringify(raw, null, 2));
    if (raw.snapshot.status === 'ok' && JSON.stringify(raw).includes('ELECTRON_BODY_MARKER')) break;
    await sleep(500);
  }
  assert.equal(raw.snapshot.status, 'ok');
  const probe = path.join(path.dirname(binary), 'memmy-history-capability-probe.exe');
  if (!JSON.stringify(raw).includes('ELECTRON_BODY_MARKER') && fs.existsSync(probe)) {
    const diagnostic = spawnSync(probe, [], { encoding: 'utf8', windowsHide: true, timeout: 15000,
      input: JSON.stringify({ syntheticOnly: true, mode: 'probe', hwnd: window.hwnd, pid: child.pid,
        processStart: window.context.processStart, executable: window.context.executable, title: window.title,
        policy: JSON.parse(fs.readFileSync(policyFile, 'utf8')), bodyIds: ['RootWebArea'], bodyNames: [], queryBudgetMs: 1500 }) + '\n' });
    fs.writeFileSync(path.join(directory, 'system-uia.json'), diagnostic.stdout ?? '');
  }
  assert.ok(JSON.stringify(raw).includes('ELECTRON_BODY_MARKER'), `Body unavailable; evidence: ${directory}`);
  assert.doesNotMatch(JSON.stringify(raw), /PASSWORD_MUST_NOT_ESCAPE/);
  const eventsFile = path.join(directory, 'events.jsonl');
  recorder = await WindowsHistoryRecorder.start({ binary, policyFile, eventsFile, seconds: 15, sampleMs: 500, title: 'Electron generic text fixture' });
  await sleep(2500); await recorder.stop(); recorder = undefined;
  const events = fs.readFileSync(eventsFile, 'utf8');
  const evidence = compactEventEvidence(events.trim().split('\n'));
  fs.writeFileSync(path.join(directory, 'summary-evidence.txt'), evidence);
  for (const content of [events, evidence]) {
    assert.match(content, /ELECTRON_BODY_MARKER/);
    assert.match(content, /ORDINARY_EDIT_MARKER/);
    assert.doesNotMatch(content, /PASSWORD_MUST_NOT_ESCAPE|syntheticcredential123/);
  }
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ status: 'passed', accessibility, uiaProvider, thirdPartyAppCoverage: false }));
  console.log(JSON.stringify({ directory, status: 'passed', accessibility, uiaProvider, thirdPartyAppCoverage: false }));
} catch (error) {
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ status: 'failed', accessibility, uiaProvider, reason: error.message, thirdPartyAppCoverage: false }));
  throw error;
} finally {
  await recorder?.stop().catch(() => {});
  if (child.pid) run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F']);
}
