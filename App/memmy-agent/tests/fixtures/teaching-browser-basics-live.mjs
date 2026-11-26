/** Live Windows/Chromium contract checks. Uses the production Host and extension.
 * Build with esbuild like teaching-browser-integrity-live.mjs; run with:
 *   browser executable extension-dir output-dir playwright-package
 * Every browser uses new isolated profiles. No desktop History source is acquired.
 */
import { ExternalBrowserBridge } from '../../src/core/agent-runtime/tools/external-browser-bridge.js';
import { createBrowserCaptureProvider } from '../../src/tools/computer-history/browser-event-capture.js';
import { PluginEventSessions } from '../../src/tools/plugin-host/event-sessions.js';
import fs from 'node:fs';import path from 'node:path';import http from 'node:http';
import { createRequire } from 'node:module';import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const [browserName,executable,extensionSource,output,playwrightPackage]=process.argv.slice(2);
if(!['edge','chrome'].includes(browserName)||!playwrightPackage)throw Error('browser executable extension-dir output-dir playwright-package required');
const run=path.join(output,`${browserName}-basics-${Date.now()}`);fs.mkdirSync(run,{recursive:true});
const report={browserName,scenario:'basics',run,startedAt:new Date().toISOString(),checks:{},errors:{},sessions:[],passed:false};
if(process.platform==='win32')report.windowsSession=Number(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','(Get-Process -Id $PID).SessionId'],{encoding:'utf8'}).trim());
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const require=createRequire(import.meta.url),{chromium}=require(path.resolve(playwrightPackage));
const bridge=new ExternalBrowserBridge(),{port}=await bridge.start(0);
const ext=path.join(run,'extension');fs.cpSync(extensionSource,ext,{recursive:true});
const bg=path.join(ext,'background.js');fs.writeFileSync(bg,fs.readFileSync(bg,'utf8').replace(/const BRIDGE_PORTS = \[[^\]]+\]/,`const BRIDGE_PORTS = [${port}]`));
const source={acquireEventCapture:async()=>{throw Error('Desktop/History source must never be acquired');}};
const dataRoot=path.join(run,'data');
const service=new PluginEventSessions({dataRoot,source,browser:createBrowserCaptureProvider(bridge,{settingsFile:path.join(run,'settings.json')})});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn,label,ms=15000){const end=Date.now()+ms;while(Date.now()<end){const r=await fn();if(r)return r;await delay(100);}throw Error('Timeout: '+label);}
function check(name,value){report.checks[name]=value===true;if(!report.checks[name])throw Error('Failed: '+name);}
async function rejected(name,action,pattern){try{await action();check(name,false);}catch(e){if(String(e).includes('Failed: '+name))throw e;report.errors[name]=String(e);check(name,pattern.test(String(e)));}}
const contexts=[];
const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html;charset=utf-8',...(req.url==='/daily'?{'set-cookie':'teach_basic_login=present; Path=/; SameSite=Lax'}:{})});res.end(`<!doctype html><html><meta charset="utf-8"><title>Teach browser basics</title><h1>Teach browser basic acceptance</h1><p id="login">${req.headers.cookie?.includes('teach_basic_login=present')?'Logged in':'Anonymous'}</p><label>Input <input id="query" aria-label="Input"></label><label>Password <input id="password" type="password"></label><label>Date <input type="date" id="expense-date"></label><label>Category <select id="category"><option>办公</option><option>差旅</option></select></label><p id="review">REVIEW_INVOICE_20261023</p><p id="receipt">RECEIPT_CONFIRMED_20261023</p><p id="api-token">COPY_SECRET_EXCLUDED</p><a href="/next">Next</a></html>`);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const local=`http://127.0.0.1:${server.address().port}`;
async function launch(label){const ctx=await chromium.launchPersistentContext(path.join(run,label),{executablePath:executable,headless:false,viewport:{width:1280,height:900},args:['--enable-unsafe-extension-debugging','--no-first-run','--no-default-browser-check'],ignoreDefaultArgs:['--disable-extensions']});contexts.push(ctx);const cdp=await ctx.browser().newBrowserCDPSession();report.version=await cdp.send('Browser.getVersion');await cdp.send('Extensions.loadUnpacked',{path:ext});await cdp.detach();return ctx;}
const owner='teach-mode',conversation='basic-main';
const folder=id=>path.join(dataRoot,owner,'event-sessions',id);
const contents=id=>fs.readFileSync(path.join(folder(id),'events.jsonl'),'utf8');
try{
const ctx=await launch('profile-1');await wait(()=>bridge.listTeachingProfiles().length===1,'first profile');
const daily=ctx.pages()[0];await daily.goto(local+'/daily');
const pageCount=ctx.pages().length;
await rejected('consentRequired',()=>service.start(owner,conversation,'basic',false,{name:browserName}),/capture_goal_and_consent_required/);
check('noConsentNoWindow',ctx.pages().length===pageCount);
const first=await service.start(owner,conversation,'Verify basic browser lifecycle',true,{name:browserName});
report.sessions.push(first.id);const page=await wait(()=>ctx.pages().find(p=>p!==daily),'teaching window');await page.goto(local+'/form');await page.locator('#memmy-teaching-recording').waitFor();
check('newWindowSharesLogin',await page.locator('#login').innerText()==='Logged in');
const duplicate=await service.start(owner,conversation,'duplicate start request',true,{name:browserName});
check('duplicateStartSameSession',duplicate.id===first.id&&ctx.pages().length===pageCount+1);
check('conversationListIsolated',service.list(owner,'other-conversation').length===0);
await rejected('crossConversationStopDenied',()=>service.stop(owner,'other-conversation',first.id),/capture_not_found_in_conversation/);
await rejected('readBeforeStopDenied',()=>service.readEvents(owner,conversation,first.id),/capture_ready_events_required/);
await daily.locator('#query').fill('BASIC_DAILY_EXCLUDED');await page.locator('#password').fill('BASIC_PASSWORD_EXCLUDED');await page.locator('#query').fill('BASIC_CAPTURED_INPUT');
// Use genuine keyboard input/copy: programmatic value assignment does not demonstrate native controls.
async function nativeDate(target,value){await target.click();for(let i=0;i<4;i++)await page.keyboard.press('ArrowLeft');const [year,month,day]=value.split('-');await page.keyboard.type(year,{delay:80});await page.keyboard.press('ArrowRight');await page.keyboard.type(month,{delay:80});await page.keyboard.press('ArrowRight');await page.keyboard.type(day,{delay:80});await page.keyboard.press('Tab');}
async function copyText(target,owner=page){await owner.bringToFront();await target.click({clickCount:3});await owner.keyboard.press('Control+c');await delay(120);}
await page.bringToFront();await nativeDate(page.locator('#expense-date'),'2026-10-23');
check('nativeDateActuallyFilled',await page.locator('#expense-date').inputValue()==='2026-10-23');
await page.locator('#category').click();await page.keyboard.press('Home');await page.keyboard.press('ArrowDown');await page.keyboard.press('Tab');
await copyText(page.locator('#review'));await copyText(page.locator('#receipt'));await copyText(page.locator('#api-token'));
await copyText(daily.locator('#review'),daily);await page.bringToFront();
await page.screenshot({path:path.join(run,'recording.png')});
const [stopped,stopAgain]=await Promise.all([service.stop(owner,conversation,first.id),service.stop(owner,conversation,first.id)]);
report.sessions[0]=stopped;
check('concurrentStopIdempotent',stopped.endedAt===stopAgain.endedAt&&stopped.eventsSha256===stopAgain.eventsSha256);
check('readyAndComplete',stopped.state==='ready'&&stopped.availability==='available'&&stopped.captureIntegrity?.coverageComplete===true&&stopped.captureIntegrity?.boundaryConfirmed===true&&stopped.captureIntegrity?.snapshotSaved===true);
const frozen=contents(first.id),proofPath=path.join(folder(first.id),'capture-proof.jsonl'),proof=fs.readFileSync(proofPath);
check('expectedInputCaptured',frozen.includes('BASIC_CAPTURED_INPUT'));
const captured=frozen.trim().split('\n').map(line=>JSON.parse(line).event);
check('nativeDateValueCaptured',captured.some(e=>e.eventType==='text_input'&&e.details?.textSource==='control_change'&&e.details.text==='2026-10-23'));
check('nativeCategoryLabelCaptured',captured.some(e=>e.eventType==='selection_changed'&&e.details?.textSource==='control_change'&&e.details.text==='差旅'));
const copied=captured.filter(e=>e.details?.textSource==='document_copy');
check('explicitReviewCopyCapturedOnce',copied.filter(e=>e.details.text==='REVIEW_INVOICE_20261023').length===1);
check('explicitReceiptCopyCaptured',copied.some(e=>e.details.text==='RECEIPT_CONFIRMED_20261023'));
check('sensitiveCopyExcluded',!frozen.includes('COPY_SECRET_EXCLUDED'));
check('dailyAndPasswordExcluded',!frozen.includes('BASIC_DAILY_EXCLUDED')&&!frozen.includes('BASIC_PASSWORD_EXCLUDED'));
check('bothEvidenceHashesValid',sha(frozen)===stopped.eventsSha256&&sha(proof)===stopped.captureIntegrity.proofSha256);
await page.locator('#query').fill('BASIC_AFTER_STOP_EXCLUDED');await nativeDate(page.locator('#expense-date'),'2026-10-24');await copyText(page.locator('#receipt'));await delay(400);
check('stopRevokedAndFrozen',await page.locator('#memmy-teaching-recording').count()===0&&contents(first.id)===frozen&&fs.readFileSync(proofPath).equals(proof));
check('readSavedEvents',service.readEvents(owner,conversation,first.id).events.length===stopped.eventCount);
await rejected('crossConversationReadDenied',()=>service.readEvents(owner,'other-conversation',first.id),/capture_not_found_in_conversation/);
const efile=path.join(folder(first.id),'events.jsonl');fs.appendFileSync(efile,'\n');
await rejected('eventsTamperRejected',()=>service.readEvents(owner,conversation,first.id),/capture_evidence_hash_mismatch/);fs.writeFileSync(efile,frozen);
fs.appendFileSync(proofPath,'\n');await rejected('proofTamperRejected',()=>service.readEvents(owner,conversation,first.id),/capture_proof_hash_mismatch/);fs.writeFileSync(proofPath,proof);
// Keep external-browser syntax diagnostics separate from lifecycle assertions.
const idle=await ctx.newPage();await idle.goto('about:blank');await idle.bringToFront();
report.targetDiagnostics=[];
for(const syntax of ['bare-ax','bracketed-ax','native-css','text-selector']){
  await page.goto(local+'/form');await idle.bringToFront();
  const claim=await wait(()=>bridge.listClaims().find(c=>c.url===local+'/form'),'external claim');
  const snapshot=await bridge.command(claim,'snapshot');
  const node=snapshot.nodes.find(node=>node.role==='link'&&node.name==='Next');
  if(!node)throw Error('Target diagnostic link missing');
  const target=syntax==='bare-ax'?node.ref:syntax==='bracketed-ax'?`[${node.ref}]`:syntax==='native-css'?'a[href="/next"]':'text=Next';
  const row={syntax,target,success:false};
  try{row.result=await bridge.command(claim,'click',{target});await page.waitForURL(local+'/next',{timeout:2000});row.success=true;}
  catch(error){row.error=String(error);}
  report.targetDiagnostics.push(row);
}
const cancel=await service.start(owner,'basic-cancel','Cancel a recording',true,{name:browserName});
const cancelled=await service.stop(owner,'basic-cancel',cancel.id,true);report.sessions.push(cancelled);
check('cancelTerminal',cancelled.state==='cancelled'&&!service.isBusy(owner));
await rejected('cancelledCannotGenerateFromRead',()=>service.readEvents(owner,'basic-cancel',cancel.id),/capture_ready_events_required/);
const beforeRelease=new Set(ctx.pages());const active=await service.start(owner,'basic-release','Disable plugin while recording',true,{name:browserName});
const releasePage=await wait(()=>ctx.pages().find(p=>!beforeRelease.has(p)),'release page');await releasePage.goto(local+'/release');await releasePage.locator('#memmy-teaching-recording').waitFor();await releasePage.locator('#query').fill('BEFORE_DISABLE_PRESERVED');await delay(1300);
const crashCopy=path.join(run,'host-crash-snapshot');fs.cpSync(dataRoot,crashCopy,{recursive:true});const beforeRestartWindows=ctx.pages().length;
const restarted=new PluginEventSessions({dataRoot:crashCopy,source});const recovered=restarted.list(owner,'basic-release')[0];
check('hostRestartDoesNotResume',recovered.state==='failed'&&recovered.availability==='partial'&&recovered.error==='capture_interrupted'&&ctx.pages().length===beforeRestartWindows);await restarted.close();
await service.release(owner);const released=service.list(owner,'basic-release')[0];report.sessions.push(released);
const releasedBytes=contents(active.id);await releasePage.locator('#query').fill('AFTER_DISABLE_EXCLUDED');await delay(400);
check('disableRevokedAndPartial',released.state==='failed'&&released.availability==='partial'&&released.error==='capture_plugin_stopped'&&!service.isBusy(owner)&&await releasePage.locator('#memmy-teaching-recording').count()===0);
check('disablePreservesAndFreezes',releasedBytes.includes('BEFORE_DISABLE_PRESERVED')&&contents(active.id)===releasedBytes&&!releasedBytes.includes('AFTER_DISABLE_EXCLUDED'));
const second=await launch('profile-2');await wait(()=>bridge.listTeachingProfiles().length===2,'two profiles');
await rejected('multipleProfilesRequireSelection',()=>service.start(owner,'basic-select','Select profile',true,{name:browserName}),/browser_capture_profile_selection_required/);
const profileId=bridge.listTeachingProfiles()[0].connectionId;
const selected=await service.start(owner,'basic-select-explicit','Explicit profile selection',true,{name:browserName,connection_id:profileId});
const selectedStopped=await service.stop(owner,'basic-select-explicit',selected.id);report.sessions.push(selectedStopped);
check('explicitProfileSelectionWorks',selectedStopped.state==='ready'&&selectedStopped.availability==='empty');
report.passed=Object.values(report.checks).every(Boolean);await page.screenshot({path:path.join(run,'stopped.png')});
}catch(e){report.error=e.stack||String(e);process.exitCode=1;}
finally{
  // Save the assertion results before cleanup, so a harness cleanup failure
  // never hides a useful product failure or its evidence.
  const save=()=>{report.endedAt=new Date().toISOString();fs.writeFileSync(path.join(run,'report.json'),JSON.stringify(report,null,2));};save();
  const cleanup=await Promise.allSettled([service.close(),...contexts.map(ctx=>ctx.close()),bridge.close()]);
  await new Promise(r=>server.close(r));
  const failures=cleanup.filter(result=>result.status==='rejected');
  if(failures.length){report.cleanupErrors=failures.map(result=>String(result.reason));report.passed=false;process.exitCode=1;}
  save();console.log(JSON.stringify(report));
}
