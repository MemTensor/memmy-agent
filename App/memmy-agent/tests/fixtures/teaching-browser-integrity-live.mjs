import { ExternalBrowserBridge } from '../../src/core/agent-runtime/tools/external-browser-bridge.js';
import { createBrowserCaptureProvider } from '../../src/tools/computer-history/browser-event-capture.js';
import { PluginEventSessions } from '../../src/tools/plugin-host/event-sessions.js';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const [browserName, executablePath, extensionSource, output, playwrightPackage, scenario = 'stress', detachHelper] = process.argv.slice(2);
const scenarios = ['stress','lifecycle','empty-redirect','drop-close','drop-event','startup-gap','bootstrap-input','drag','stop-navigation','reload','user-detach'];
if (!['chrome','edge'].includes(browserName) || !executablePath || !extensionSource || !output || !playwrightPackage || !scenarios.includes(scenario)) {
  throw Error('Usage: browser executable extension-dir output-dir playwright-package [stress|lifecycle|empty-redirect|drop-close|drop-event|startup-gap|bootstrap-input|drag|stop-navigation|reload]');
}
const run = path.join(output, `${browserName}-${scenario}-${Date.now()}`);
fs.mkdirSync(run, { recursive: true });
const playwrightRequire = createRequire(import.meta.url);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const { chromium } = playwrightRequire(path.resolve(playwrightPackage));
const bridge = new ExternalBrowserBridge();
const { port } = await bridge.start(0);
const trace = [];
const originalCommand = bridge.teachingCommand.bind(bridge);
bridge.teachingCommand = async (...args) => {
  const at = Date.now();
  try {
    const value = await originalCommand(...args);
    trace.push({ at, action: args[2], ended: Date.now(), result: value });
    return value;
  } catch (error) { trace.push({ at, action: args[2], error: String(error) }); throw error; }
};
const originalSubscribe = bridge.subscribeTeaching.bind(bridge);
bridge.subscribeTeaching = (connection, session, listener) => originalSubscribe(connection, session, message => {
  trace.push({ at: Date.now(), direction: 'event', ...message }); listener(message);
});
const service = new PluginEventSessions({ dataRoot: path.join(run, 'data'),
  source: { acquireEventCapture: async () => { throw Error('Desktop source forbidden in browser diagnostic'); } },
  browser: createBrowserCaptureProvider(bridge, { settingsFile: path.join(run, 'settings.json') }) });
const extension = path.join(run, 'extension');
fs.cpSync(extensionSource, extension, { recursive: true });
const backgroundFile=path.join(extension,'background.js');
fs.writeFileSync(backgroundFile, fs.readFileSync(backgroundFile,'utf8').replace(/const BRIDGE_PORTS = \[[^\]]+\]/, `const BRIDGE_PORTS = [${port}]`));
if (['drop-close','drop-event','startup-gap','bootstrap-input'].includes(scenario)) {
 const file=path.join(extension,'teaching-page.js'); let content=fs.readFileSync(file,'utf8');
 const original=content;
 if(scenario==='drop-close') content=content.replace('const send = value => { try {', 'const send = value => { if(value.kind==="closed" && value.reason==="pagehide")return; try {');
 if(scenario==='drop-event') content=content.replace('const send = value => { try {', 'const send = value => { if(value.kind==="event" && value.eventType==="text_input" && !location.search)return; try {');
 if(scenario==='startup-gap') content=content.replace('  function connect() {', '  let connectDeferred=false; function connect() { if(location.pathname==="/fast" && !connectDeferred){connectDeferred=true;setTimeout(connect,700);return;} if(location.pathname==="/fast" && !current)return;');
 if(scenario==='bootstrap-input') content=content.replace('if (current !== connection || !message || typeof message !== "object") return;', 'if (current !== connection || !message || typeof message !== "object") return; if(message.type==="configure" && location.pathname==="/fast")return;');
 if(content===original)throw Error('Fault injection did not match the current collector source');
 fs.writeFileSync(file,content);
}
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/redirect') { res.writeHead(302, { Location: `/form?step=${url.searchParams.get('step')}` }).end(); return; }
  res.end(`<!doctype html><html><head><title>Teaching integrity ${url.pathname}</title></head><body><h1>Teaching navigation</h1><form action="/form"><input id="query" name="q" aria-label="Query"><button id="go">Search</button></form><a id="popup" href="/popup" target="_blank">New tab</a><a id="next" href="/next">Next page</a><input id="password" type="password" aria-label="Password"><button id="spa" onclick="history.pushState({},'','/spa')">SPA route</button><button id="popupwin" onclick="window.open('/popup-window','_blank','width=700,height=600')">Popup window</button><textarea id="notes" aria-label="Notes"></textarea><script>if(location.pathname==="/instant")setTimeout(()=>location.replace("/form"),50)</script></body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const local = `http://127.0.0.1:${server.address().port}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (fn, description, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(100); } throw Error(`Timed out: ${description}`); };
let context, worker, recording;
let flushTimer;
const report = { browserName, scenario, run, startedAt: new Date().toISOString(), captureSource: 'actual Host source and copied extension; only test bridge port changes for normal scenarios', faultInjection: ['drop-close','drop-event','startup-gap','bootstrap-input'].includes(scenario) };
if(process.platform==='win32') report.windowsSession=Number(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','(Get-Process -Id $PID).SessionId'],{encoding:'utf8'}).trim());
async function dump() {
  fs.writeFileSync(path.join(run, 'host-trace.json'), JSON.stringify(trace, null, 2));

}
try {
  context = await chromium.launchPersistentContext(path.join(run, 'profile'), {
    executablePath: executablePath,
    headless: false, viewport: { width: 1280, height: 900 },
    args: ['--enable-unsafe-extension-debugging','--no-first-run','--no-default-browser-check',...(scenario==='user-detach'?['--force-renderer-accessibility=complete']:[])],
    ignoreDefaultArgs: ['--disable-extensions',...(scenario==='user-detach'?['--enable-automation','--disable-infobars']:[])] });
  const cdp = await context.browser().newBrowserCDPSession();
  report.version = await cdp.send('Browser.getVersion');
  await cdp.send('Extensions.loadUnpacked', { path: extension });
  worker = await waitFor(() => context.serviceWorkers().find(w => w.url().includes('/background.js')), 'extension worker');
  await waitFor(() => bridge.listTeachingProfiles().length === 1, 'extension connection');
  flushTimer = setInterval(() => { void dump(); }, 2000);

 if(scenario==='stress') {
  report.rounds = [];
  const daily = context.pages()[0];
  await daily.goto(`${local}/daily`, {waitUntil:'domcontentloaded'});
  for (let round = 0; round < 10; round++) {
    const before = new Set(context.pages());
    recording = await service.start('teach-mode', `stress-${round}`, 'Verify 100 navigations and capture proof', true, {name: browserName});
    const page = await waitFor(()=>context.pages().find(p=>!before.has(p)), 'new teaching page');
    page.setDefaultTimeout(15000); await page.bringToFront();
    await page.goto(`${local}/form`, {waitUntil:'domcontentloaded'});
    await page.locator('#memmy-teaching-recording').waitFor();
    await delay((round * 137) % 700);
    await daily.bringToFront(); await daily.locator('#query').fill(`DAILY_EXCLUDED_${round}`);
    await page.bringToFront(); await page.locator('#password').fill(`PASSWORD_EXCLUDED_${round}`);
    const expected = [];
    for (let i = 0; i < 100; i++) {
      const text = `${browserName.toUpperCase()}_ROUND_${round}_NAV_${i}`; expected.push(text);
      await page.locator('#query').fill(text);
      await page.locator('#query').press('Enter');
      await page.waitForURL(url=>url.searchParams.get('q')===text);
      await page.waitForLoadState('domcontentloaded');
      await page.locator('#memmy-teaching-recording').waitFor();
      await delay(5 + i % 7 * 11);
    }
    await delay(50);
    if (round===0 || round===9) await page.screenshot({path:path.join(run,`recording-round-${round}.png`)});
    const ended = await service.stop('teach-mode', `stress-${round}`, recording.id);
    const folder=path.join(run,'data/teach-mode/event-sessions',recording.id), file=path.join(folder,'events.jsonl');
    const frozen=fs.readFileSync(file,'utf8'), events=frozen.trim().split('\n').map(line=>JSON.parse(line).event);
    const proofFile=path.join(folder,'capture-proof.jsonl'), frozenProof=fs.readFileSync(proofFile,'utf8');
    const actual=events.filter(e=>e.eventType==='text_input').map(e=>e.details.text);
    const checks={exactInputs:JSON.stringify(actual)===JSON.stringify(expected),navigationCount:events.filter(e=>e.eventType==='navigation').length===101,
      outsideExcluded:!frozen.includes('DAILY_EXCLUDED_'),passwordExcluded:!frozen.includes('PASSWORD_EXCLUDED_'),
      available:ended.availability==='available',boundary:ended.captureIntegrity?.boundaryConfirmed===true,
      coverage:ended.captureIntegrity?.coverageComplete===true,saved:ended.captureIntegrity?.snapshotSaved===true};
    const documents=new Map();
    checks.documentSequences=events.every(event=>{
      if(event.eventType==='navigation')return true;
      const capture=event.details.browserCapture, previous=documents.get(capture.documentId)||0;
      documents.set(capture.documentId,capture.documentSequence);
      return capture.documentSequence===previous+1;
    });
    checks.eventCounts=events.length===601&&['text_input','key_press','selection_changed','click','submit'].every(type=>events.filter(event=>event.eventType===type).length===100);
    checks.hashes=sha256(frozen)===ended.eventsSha256&&sha256(frozenProof)===ended.captureIntegrity.proofSha256;
    await page.locator('#query').fill(`AFTER_STOP_EXCLUDED_${round}`); await delay(50);
    checks.frozen=fs.readFileSync(file,'utf8')===frozen;
    checks.proofFrozen=fs.readFileSync(proofFile,'utf8')===frozenProof;
    checks.badgeRemoved=await page.locator('#memmy-teaching-recording').count()===0;
    const item={round,expectedInputs:expected.length,actualInputs:actual.length,eventCount:events.length,checks,session:ended};
    report.rounds.push(item);
    fs.writeFileSync(path.join(run,'report-progress.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({round,browserName,checks,events:events.length}));
    await dump(); await page.close();
    if(Object.values(checks).some(v=>v!==true)) throw Error(`Stress round ${round} failed: ${JSON.stringify(checks)}`);
  }
  report.passed=report.rounds.length===10 && report.rounds.every(r=>Object.values(r.checks).every(Boolean));

 } else {
  const before = new Set(context.pages());
  const conversation='case-'+scenario;
  recording=await service.start('teach-mode',conversation,'Verify native Port '+scenario,true,{name:browserName});
  const page=await waitFor(()=>context.pages().find(p=>!before.has(p)),'teaching page');
  await page.bringToFront(); page.setDefaultTimeout(15000);
  const ready=async p=>{await p.locator('#memmy-teaching-recording').waitFor();};
  const input=async(p,text)=>{await p.bringToFront();await ready(p);await p.locator('#query').fill(text);};
  const expected=[];
  if(scenario==='empty-redirect') {
    await page.goto(local+'/instant',{waitUntil:'domcontentloaded'});
    await page.waitForURL(local+'/form');await ready(page);await input(page,'AFTER_EMPTY_REDIRECT');expected.push('AFTER_EMPTY_REDIRECT');
  } else if(['startup-gap','bootstrap-input'].includes(scenario)) {
    await page.goto(local+'/fast',{waitUntil:'domcontentloaded'});
    await page.locator('#query').fill('MISSED_STARTUP');
    await page.locator('#query').press('Enter');
    await page.waitForURL(u=>u.searchParams.get('q')==='MISSED_STARTUP');
    await ready(page);await input(page,'AFTER_READY');
  } else {
    await page.goto(local+'/form',{waitUntil:'domcontentloaded'});await ready(page);
    await input(page,'CASE_START');expected.push('CASE_START');
    if(scenario==='drop-close'||scenario==='drop-event') {
      await page.locator('#query').press('Enter');
      await page.waitForURL(u=>u.searchParams.get('q')==='CASE_START');await ready(page);await delay(2200);
      await input(page,'AFTER_NAV');
    } else if(scenario==='lifecycle') {
      await page.locator('#spa').click();await waitFor(()=>page.url().endsWith('/spa'),'SPA route');await delay(150);
      await input(page,'AFTER_SPA');expected.push('AFTER_SPA');
      await page.goto(local+'/redirect?step=one',{waitUntil:'domcontentloaded'});await ready(page);
      await input(page,'AFTER_REDIRECT');expected.push('AFTER_REDIRECT');
      await page.goto(local.replace('127.0.0.1','localhost')+'/cross-site',{waitUntil:'domcontentloaded'});await ready(page);
      await input(page,'AFTER_CROSS_SITE');expected.push('AFTER_CROSS_SITE');
      await page.goBack({waitUntil:'domcontentloaded'});await ready(page);
      await input(page,'AFTER_BACK');expected.push('AFTER_BACK');
      await page.goForward({waitUntil:'domcontentloaded'});await ready(page);
      await input(page,'AFTER_FORWARD');expected.push('AFTER_FORWARD');
      let next=context.waitForEvent('page');await page.locator('#popup').click();const tab=await next;
      await tab.waitForLoadState('domcontentloaded');await input(tab,'CHILD_TAB');expected.push('CHILD_TAB');
      await page.bringToFront();next=context.waitForEvent('page');await page.locator('#popupwin').click();const popup=await next;
      await popup.waitForLoadState('domcontentloaded');await input(popup,'CHILD_POPUP');expected.push('CHILD_POPUP');
      report.popupUrl=popup.url();report.tabs=context.pages().length;
      await popup.screenshot({path:path.join(run,'authorized-popup.png')});
    } else if(scenario==='user-detach') {
      if(process.platform!=='win32'||!detachHelper)throw Error('user-detach requires Windows and the UI Automation helper path');
      report.userDetach=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',detachHelper,
        '-TestProfilePath',path.join(run,'profile'),'-ExecutableName',path.basename(executablePath),'-Screenshot',path.join(run,'browser-debugging-cancel.png')],{encoding:'utf8',timeout:15000}));
      await delay(700);
    } else if(scenario==='reload') {
      await worker.evaluate(()=>chrome.runtime.reload()).catch(()=>{});await delay(700);
    } else if(scenario==='drag') {
      report.binding=await worker.evaluate(async()=>{const t=(await chrome.tabs.query({})).find(t=>t.url?.includes('/form'));const old=t.windowId;await chrome.tabs.create({windowId:old,url:'about:blank',active:false});const w=await chrome.windows.create({tabId:t.id});return {tab:t.id,old,outside:w.id};});
      await waitFor(async()=>await page.locator('#memmy-teaching-recording').count()===0,'drag-out revocation');
      await page.bringToFront();await page.locator('#query').fill('DRAG_OUTSIDE_SECRET');
      await worker.evaluate(async b=>{await chrome.tabs.move(b.tab,{windowId:b.old,index:-1});await chrome.windows.update(b.old,{focused:true});},report.binding);
      await input(page,'DRAG_BACK_IN');expected.push('DRAG_BACK_IN');
    } else if(scenario==='stop-navigation') {
      const navigation=page.goto(local+'/during-stop',{waitUntil:'domcontentloaded'}).catch(()=>{});
      report.session=await service.stop('teach-mode',conversation,recording.id);await navigation;
    }
  }
  await delay(150);
  if(!report.session) report.session=await service.stop('teach-mode',conversation,recording.id);
  report.faults=trace.filter(x=>x.kind==='fault');
  const folder=path.join(run,'data/teach-mode/event-sessions',recording.id),file=path.join(folder,'events.jsonl');
  const frozen=fs.readFileSync(file,'utf8'),events=frozen.trim()?frozen.trim().split('\n').map(l=>JSON.parse(l).event):[];
  const actual=events.filter(e=>e.eventType==='text_input').map(e=>e.details.text);
  report.inputs=actual;report.expected=expected;report.eventCount=events.length;
  report.checks={boundary:report.session.captureIntegrity?.boundaryConfirmed===true,saved:report.session.captureIntegrity?.snapshotSaved===true};
  if(['lifecycle','empty-redirect'].includes(scenario)) Object.assign(report.checks,{exactInputs:JSON.stringify(actual)===JSON.stringify(expected),available:report.session.availability==='available',coverage:report.session.captureIntegrity?.coverageComplete===true});
  if(['drop-close','drop-event','startup-gap','bootstrap-input','reload','user-detach'].includes(scenario)) Object.assign(report.checks,{partial:report.session.availability==='partial',gap:report.session.captureIntegrity?.coverageComplete===false});
  if(scenario==='drop-close') Object.assign(report.checks,{retainedInputs:JSON.stringify(actual)===JSON.stringify(['CASE_START','AFTER_NAV'])});
  if(scenario==='drop-event') Object.assign(report.checks,{lostInputNotInvented:!actual.includes('CASE_START'),laterInputRetained:actual.includes('AFTER_NAV')});
  if(['startup-gap','bootstrap-input'].includes(scenario)) Object.assign(report.checks,{missedInputNotInvented:!actual.includes('MISSED_STARTUP'),laterInputRetained:actual.includes('AFTER_READY')});
  if(scenario==='empty-redirect') Object.assign(report.checks,{closeProof:trace.some(x=>x.kind==='proof'&&(x.status==='empty_document_closed'||x.status==='closing'))});
  if(['reload','user-detach'].includes(scenario)) Object.assign(report.checks,{boundary:report.session.captureIntegrity?.boundaryConfirmed===false,saved:report.session.captureIntegrity?.snapshotSaved===false,failed:report.session.state==='failed',retainedInput:actual.includes('CASE_START')});
  if(scenario==='drag') Object.assign(report.checks,{exactInputs:JSON.stringify(actual)===JSON.stringify(expected),outsideExcluded:!frozen.includes('DRAG_OUTSIDE_SECRET'),available:report.session.availability==='available',coverage:report.session.captureIntegrity?.coverageComplete===true});
  await page.bringToFront();await page.locator('#query').fill('AFTER_STOP_SECRET');await delay(100);
  Object.assign(report.checks,{frozen:fs.readFileSync(file,'utf8')===frozen,badgeRemoved:await page.locator('#memmy-teaching-recording').count()===0});
  await page.screenshot({path:path.join(run,'after-stop.png')});
  report.passed=Object.values(report.checks).every(Boolean);

 }
  await dump();
} catch (error) {
  report.error = error.stack || String(error);
  if (recording && !report.session && !report.rounds?.some(r=>r.session.id===recording.id)) {
    report.beforeStop=service.list('teach-mode',recording.conversationId)[0];
    report.session = await service.stop('teach-mode',recording.conversationId,recording.id).catch(error => ({ stopError: String(error) }));
    report.faults = trace.filter(x => x.kind === 'fault');
  }
  await dump().catch(() => {});
}
finally {
  clearInterval(flushTimer);
  await service.close(); await bridge.close(); await context?.close();
  await new Promise(resolve => server.close(resolve));
  report.endedAt = new Date().toISOString();
  fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({run,error:report.error,passed:report.passed,checks:report.checks,inputs:report.inputs,rounds:report.rounds?.length}));
  if (!report.passed) process.exitCode = 1;
}
