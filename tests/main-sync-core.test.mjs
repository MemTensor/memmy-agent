import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { createRequest } from '../scripts/main-sync/cli.mjs';
import { normalizeConfig, validateRelease } from '../scripts/main-sync/core.mjs';

const roots=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const source='a'.repeat(40),controller='b'.repeat(40),main='c'.repeat(40);
const config=Buffer.from(JSON.stringify({schemaVersion:1,repository:'MemTensor/memmy-agent',targets:['v1.2.5','v1.2.6','v1.2.7']}));
const env={GITHUB_REPOSITORY:'MemTensor/memmy-agent',GITHUB_REPOSITORY_ID:'1302496224',GITHUB_REF:'refs/heads/main',
 GITHUB_WORKFLOW_SHA:controller,GITHUB_RUN_ID:'12345',GITHUB_RUN_ATTEMPT:'1',GITHUB_EVENT_NAME:'workflow_dispatch',SYNC_SOURCE_SHA:source,SYNC_RELEASE_ID:'123'};
function fixture() {
 const directory=mkdtempSync(join(tmpdir(),'main-sync-signal-'));roots.push(directory);
 const names=['Memmy-win-cn.exe','Memmy-win-intl.exe','Memmy-arm-cn.dmg','Memmy-arm-intl.dmg','Memmy-x64-cn.dmg','Memmy-x64-intl.dmg',
  'MD5SUMS.txt','SHA256SUMS.txt','RELEASE_NOTES.md','RELEASE_NOTES_SOURCE.json','QUALITY_REPORT.json','RELEASE_EVIDENCE.json'];
 const assets=names.map(name=>{
  const value=Buffer.from('fixture '+name);writeFileSync(join(directory,name),value);
  return {name,state:'uploaded',size:value.length,digest:'sha256:'+createHash('sha256').update(value).digest('hex')};
 });
 const release={id:123,tag_name:'v1.2.401',target_commitish:source,draft:true,prerelease:false,created_at:'2026-10-28T00:00:00Z',assets};
 const requests=[];
 const api={request(method,path){
  requests.push({method,path});expect(method).toBe('GET');
  if(path==='/releases/123')return release;
  if(path.startsWith('/git/ref/tags/'))return {object:{type:'commit',sha:source}};
  if(path==='/git/ref/heads/main')return {object:{sha:main}};
  if(path.startsWith('/compare/'))return {merge_base_commit:{sha:source}};
  throw new Error('Unexpected read '+path);
 }};
 return {directory,release,api,requests};
}

function draftProducerFixture(options={}) {
 const directory=mkdtempSync(join(tmpdir(),'main-sync-draft-id-'));roots.push(directory);
 const assetsDirectory=join(directory,'release-assets');mkdirSync(assetsDirectory);
 const names=['Memmy-1.2.5-win32-x64-cn-signed.exe','Memmy-1.2.5-win32-x64-intl-signed.exe',
  'Memmy-1.2.5-darwin-arm64-cn-signed.dmg','Memmy-1.2.5-darwin-arm64-intl-signed.dmg',
  'Memmy-1.2.5-darwin-x64-cn-signed.dmg','Memmy-1.2.5-darwin-x64-intl-signed.dmg',
  'MD5SUMS.txt','SHA256SUMS.txt','RELEASE_NOTES.md','RELEASE_NOTES_SOURCE.json','QUALITY_REPORT.json','RELEASE_EVIDENCE.json'];
 const assets=names.map(name=>{
  const bytes=Buffer.from('Owned Draft asset '+name);writeFileSync(join(assetsDirectory,name),bytes);
  return {name,state:'uploaded',size:bytes.length,digest:'sha256:'+createHash('sha256').update(bytes).digest('hex')};
 });
 const view={databaseId:123,tagName:'v1.2.5',isDraft:true,isPrerelease:false,targetCommitish:source,...options.view};
 const bin=join(directory,'bin');mkdirSync(bin);
 const calls=join(directory,'gh-argv.jsonl'),stateFile=join(directory,'remote-state.json'),output=join(directory,'github-output');
 writeFileSync(stateFile,JSON.stringify({created:false,uploaded:false,deleted:false}));
 writeFileSync(join(bin,'gh'),`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),names=${JSON.stringify(names)};
fs.appendFileSync(process.env.FIXTURE_CALLS,JSON.stringify(args)+'\\n');
const state=JSON.parse(fs.readFileSync(process.env.FIXTURE_STATE,'utf8'));
const option=name=>args[args.indexOf(name)+1];
function finish(code){fs.writeFileSync(process.env.FIXTURE_STATE,JSON.stringify(state));process.exit(code);}
if(args[0]!=='release'||args[2]!==process.env.TAG||option('--repo')!==process.env.GITHUB_REPOSITORY)throw new Error('Unexpected gh scope');
if(args[1]==='create'){
 if(!args.includes('--draft')||option('--target')!==process.env.TARGET_SHA)throw new Error('Unsafe create');
 state.created=true;finish(0);
}
if(args[1]==='upload'){
 const files=args.slice(3,args.indexOf('--repo'));
 if(!state.created||files.length!==12||new Set(files.map(file=>path.basename(file))).size!==12)throw new Error('Duplicate or missing upload argv');
 if(JSON.stringify(files.map(file=>path.basename(file)).sort())!==JSON.stringify([...names].sort()))throw new Error('Wrong asset set');
 for(const file of files)if(!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink())throw new Error('Missing actual asset');
 state.uploadFiles=files;state.uploaded=process.env.FIXTURE_FAIL_UPLOAD!=='1';finish(state.uploaded?0:1);
}
if(args[1]==='view'){
 if(!state.uploaded)throw new Error('ID lookup happened before upload completion');
 const fields=(option('--json')||'').split(',');
 if(!['databaseId','tagName','isDraft','isPrerelease','targetCommitish'].every(field=>fields.includes(field)))throw new Error('Incomplete Draft identity lookup');
 state.lookup=true;
 if(process.env.FIXTURE_VIEW_FAIL==='1'){process.stderr.write('HTTP500 lookup failed');finish(1);}
 process.stdout.write(process.env.FIXTURE_INVALID_JSON==='1'?'invalid JSON':process.env.FIXTURE_VIEW);finish(0);
}
if(args[1]==='delete'){state.deleted=true;finish(0);}
throw new Error('Unexpected gh operation');
`,{mode:0o755});
 const document=YAML.parse(readFileSync(new URL('../.github/workflows/github-draft-release-v2.yml',import.meta.url),'utf8'));
 const script=document.jobs.release.steps.find(step=>step.name==='Create draft release and upload every asset').run;
 return {directory,assetsDirectory,assets,view,
  run(){return spawnSync('bash',['-c',script],{cwd:directory,encoding:'utf8',env:{...process.env,
   PATH:bin+':'+process.env.PATH,TAG:'v1.2.5',TARGET_SHA:source,TAG_PREEXISTS:options.tagPreexists?'true':'false',
   GITHUB_REPOSITORY:'MemTensor/memmy-agent',GITHUB_OUTPUT:output,FIXTURE_CALLS:calls,FIXTURE_STATE:stateFile,
   FIXTURE_VIEW:JSON.stringify(view),FIXTURE_VIEW_FAIL:options.viewFail?'1':'0',FIXTURE_INVALID_JSON:options.invalidJson?'1':'0',
   FIXTURE_FAIL_UPLOAD:options.failUpload?'1':'0'}});},
  state:()=>JSON.parse(readFileSync(stateFile,'utf8')),
  calls:()=>readFileSync(calls,'utf8').trim().split('\n').map(line=>JSON.parse(line)),
  output:()=>existsSync(output)?readFileSync(output,'utf8'):'',
 };
}

describe('immutable Draft release ID consumer',()=>{
 it.each([undefined,''])('rejects a missing release ID before any provider call: %s',async releaseId=>{
  const f=fixture();
  await expect(createRequest({api:f.api,env:{...env,SYNC_RELEASE_ID:releaseId,SYNC_TAG:'v1.2.401'},
   configBytes:config,assetDirectory:f.directory})).rejects.toThrow();
  expect(f.requests).toEqual([]);
 });
 it('rejects response ID124 for requested ID123',async()=>{
  const f=fixture();f.release.id=124;
  await expect(createRequest({api:f.api,env,configBytes:config,assetDirectory:f.directory})).rejects.toThrow();
 });
 it('rejects the normal workflow tag when the returned Draft has another tag',async()=>{
  const f=fixture();
  await expect(createRequest({api:f.api,env:{...env,SYNC_TAG:'v1.2.5'},
   configBytes:config,assetDirectory:f.directory})).rejects.toThrow();
 });
 it('seals an unpublished Draft by ID even when release-by-tag is unavailable',async()=>{
  const f=fixture(),calls=[];
  const api={request(method,path,...rest){
   calls.push({method,path});
   if(path.startsWith('/releases/tags/'))throw new Error('HTTP404: only published releases are returned here');
   if(path.startsWith('/git/ref/tags/'))return undefined;
   return f.api.request(method,path,...rest);
  }};
  const request=await createRequest({api,env:{...env,SYNC_TAG:'v1.2.401'},configBytes:config,assetDirectory:f.directory});
  expect(request).toMatchObject({releaseId:123,tag:'v1.2.401',sourceSha:source,phase:'draft_ready'});
  expect(request.assets).toHaveLength(12);
  expect(calls.some(call=>call.path==='/releases/123')).toBe(true);
  expect(calls.some(call=>call.path.startsWith('/releases/tags/'))).toBe(false);
 });
 it('keeps explicit-ID manual recovery authoritative without an optional tag',async()=>{
  const f=fixture();f.release.draft=false;
  const request=await createRequest({api:f.api,env,configBytes:config,allowPublished:true});
  expect(request).toMatchObject({releaseId:123,tag:'v1.2.401',sourceSha:source,phase:'manual_recovery'});
 });
 it('rejects an existing tag whose actual commit differs from the requested source',async()=>{
  const f=fixture();f.release.target_commitish='main';
  const api={request(method,path,...rest){
   if(path.startsWith('/git/ref/tags/'))return {object:{type:'commit',sha:main}};
   return f.api.request(method,path,...rest);
  }};
  await expect(createRequest({api,env,configBytes:config,assetDirectory:f.directory})).rejects.toThrow(/Tag points to another source/);
 });
});

describe('actual Draft ID producer workflow',()=>{
 it.each([
  {name:'new Draft',options:{}},
  {name:'pre-existing exact tag with branch metadata',options:{tagPreexists:true,view:{targetCommitish:'main'}}},
 ])('hands off twelve unique real assets from a $name by numeric ID',async({options})=>{
  const f=draftProducerFixture(options),result=f.run();
  expect(result.error).toBeUndefined();expect(result.status,result.stderr).toBe(0);
  expect(f.state()).toMatchObject({created:true,uploaded:true,deleted:false});
  expect(f.state().uploadFiles).toHaveLength(12);
  expect(new Set(f.state().uploadFiles).size).toBe(12);
  expect(f.output()).toMatch(/^release_id=123$/m);
  const releaseId=f.output().match(/^release_id=(\d+)$/m)[1],calls=[];
  const release={id:123,tag_name:'v1.2.5',target_commitish:f.view.targetCommitish,draft:true,prerelease:false,
   created_at:'2026-11-06T00:00:00Z',assets:f.assets};
  const api={request(method,path){
   calls.push({method,path});expect(method).toBe('GET');
   if(path==='/releases/123')return release;
   if(path.startsWith('/git/ref/tags/'))return options.tagPreexists?{object:{type:'commit',sha:source}}:undefined;
   if(path==='/git/ref/heads/main')return {object:{sha:main}};
   if(path.startsWith('/compare/'))return {merge_base_commit:{sha:source}};
   throw new Error('Unexpected provider route '+path);
  }};
  const request=await createRequest({api,env:{...env,SYNC_RELEASE_ID:releaseId,SYNC_TAG:'v1.2.5'},configBytes:config,assetDirectory:f.assetsDirectory});
  expect(request).toMatchObject({releaseId:123,tag:'v1.2.5',sourceSha:source,phase:'draft_ready'});
  expect(request.assets).toHaveLength(12);
  expect(calls.some(call=>call.path.startsWith('/releases/tags/'))).toBe(false);
 });
 it.each([
  {name:'lookup HTTP500',viewFail:true},
  {name:'malformed JSON',invalidJson:true},
  {name:'zero ID',view:{databaseId:0}},
  {name:'string ID',view:{databaseId:'123'}},
  {name:'unsafe numeric ID',view:{databaseId:Number.MAX_SAFE_INTEGER+1}},
  {name:'wrong tag',view:{tagName:'v1.2.6'}},
  {name:'published release',view:{isDraft:false}},
  {name:'prerelease',view:{isPrerelease:true}},
  {name:'wrong new-tag source',view:{targetCommitish:'d'.repeat(40)}},
 ])('retains a fully uploaded Draft and refuses output on $name',options=>{
  const f=draftProducerFixture(options),result=f.run();
  expect(result.error).toBeUndefined();
  expect(result.status,result.stderr).not.toBe(0);
  expect(f.state()).toMatchObject({created:true,uploaded:true,deleted:false});
  expect(f.output()).not.toContain('release_id=');
  expect(f.calls().some(args=>args[0]==='release'&&args[1]==='delete')).toBe(false);
 });
});

describe('CodingAgent Draft synchronization request',()=>{
 it('writes a stable business identity and freezes source/config/assets',async()=>{
  const f=fixture();
  const first=await createRequest({api:f.api,env,configBytes:config,assetDirectory:f.directory});
  const retry=await createRequest({api:f.api,env:{...env,GITHUB_RUN_ID:'99999',GITHUB_RUN_ATTEMPT:'2'},configBytes:config,assetDirectory:f.directory});
  expect(first.requestId).toBe(retry.requestId);
  expect(first.sourceSha).toBe(source);
  expect(first.controllerSha).toBe(controller);
  expect(first.configSha256).toBe(createHash('sha256').update(config).digest('hex'));
  expect(first.assets).toHaveLength(12);
  expect(first.kind).toBe('memmy.main-sync-request');
  expect(first.phase).toBe('draft_ready');
  expect(first).not.toHaveProperty('token');
 });
 it.each(['GITHUB_REPOSITORY','GITHUB_REF','GITHUB_REPOSITORY_ID','GITHUB_WORKFLOW_SHA','GITHUB_RUN_ID'])('rejects invalid producer field %s',async field=>{
  const f=fixture();
  await expect(createRequest({api:f.api,env:{...env,[field]:'invalid'},configBytes:config,assetDirectory:f.directory})).rejects.toThrow();
 });
 it('rejects published initial requests, but supports explicit recovery with exact tag',async()=>{
  const f=fixture();f.release.draft=false;
  await expect(createRequest({api:f.api,env,configBytes:config,assetDirectory:f.directory})).rejects.toThrow();
  const recovered=await createRequest({api:f.api,env,configBytes:config,allowPublished:true});
  expect(recovered.phase).toBe('manual_recovery');
  expect(recovered.sourceSha).toBe(source);
 });
 it('checks upload state, exact asset set, size and digest',async()=>{
  for(const mutate of [
   f=>f.release.assets.pop(),
   f=>f.release.assets[0].state='new',
   f=>f.release.assets[0].size++,
   f=>f.release.assets[0].digest='sha256:'+'0'.repeat(64),
   f=>f.release.assets.push({...f.release.assets[0]})
  ]) {
   const f=fixture();mutate(f);
   await expect(createRequest({api:f.api,env,configBytes:config,assetDirectory:f.directory})).rejects.toThrow();
  }
 });
 it('requires a real release PR number for the automatic release path',async()=>{
  const f=fixture();
  await expect(createRequest({api:f.api,env:{...env,GITHUB_EVENT_NAME:'pull_request_target'},configBytes:config,assetDirectory:f.directory})).rejects.toThrow();
  const request=await createRequest({api:f.api,env:{...env,GITHUB_EVENT_NAME:'pull_request_target',SYNC_RELEASE_PR_NUMBER:'729'},configBytes:config,assetDirectory:f.directory});
  expect(request.pullRequestNumber).toBe(729);
 });
 it('keeps an explicit target allowlist and finite repair budgets',()=>{
  expect(normalizeConfig(JSON.parse(config)).targets).toEqual(['v1.2.5','v1.2.6','v1.2.7']);
  for(const changed of [{targets:['main']},{targets:['v1.2.5','v1.2.5']},{maxRounds:100000},{maxDurationMinutes:0}])
   expect(()=>normalizeConfig({...JSON.parse(config),...changed})).toThrow();
 });
 it('binds draft/tag source even before a Draft has created its tag',()=>{
  const f=fixture();
  expect(validateRelease(f.release,{releaseId:123,sourceSha:source}).sourceSha).toBe(source);
  expect(()=>validateRelease({...f.release,target_commitish:'main'},{releaseId:123,sourceSha:source})).toThrow();
  expect(()=>validateRelease(f.release,{releaseId:123,sourceSha:source,tagSha:main})).toThrow();
 });
 it('only publishes a request after upload and verified readback',()=>{
  const path=new URL('../.github/workflows/github-draft-release-v2.yml',import.meta.url);
  const document=YAML.parse(readFileSync(path,'utf8'));
  const steps=document.jobs.release.steps;
  const create=steps.findIndex(step=>step.name==='Create draft release and upload every asset');
  const verify=steps.findIndex(step=>step.name==='Verify completed draft for synchronization');
  const publish=steps.findIndex(step=>step.name==='Publish CodingAgent synchronization request');
  expect(verify).toBeGreaterThan(create);expect(publish).toBeGreaterThan(verify);
  expect(steps[create].run).toContain('trap - EXIT');
  expect(steps[verify].run).not.toContain('release delete');
  expect(steps[publish].if).toContain("steps.sync-source.outputs.sync_ready == 'true'");
  expect(steps[publish].with.path).toContain('main-sync-request.json');
  expect(document.jobs).not.toHaveProperty('sync-main');
  expect(readFileSync(new URL('../.github/workflows/main-sync.yml',import.meta.url),'utf8')).not.toContain('codex-action');
 });
 it('executes the actual upload cleanup boundary without deleting a complete draft on later failure',()=>{
  for(const fail of ['0','1']) {
   const f=draftProducerFixture({failUpload:fail==='1'}),result=f.run();
   expect(result.error).toBeUndefined();
   expect(result.status).toBe(fail==='0'?0:1);
   expect(f.calls().some(args=>args[0]==='release'&&args[1]==='delete')).toBe(fail==='1');
   if(fail==='0') {
    // A distinct post-upload step may fail; its process has no cleanup trap.
    expect(spawnSync('bash',['-c','exit 17'],{cwd:f.directory}).status).toBe(17);
    expect(f.calls().some(args=>args[0]==='release'&&args[1]==='delete')).toBe(false);
   }
  }
 });
});
