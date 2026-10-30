import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
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
  const document=YAML.parse(readFileSync(new URL('../.github/workflows/github-draft-release-v2.yml',import.meta.url),'utf8'));
  const script=document.jobs.release.steps.find(step=>step.name==='Create draft release and upload every asset').run;
  const directory=mkdtempSync(join(tmpdir(),'main-sync-upload-'));roots.push(directory);
  const bin=join(directory,'bin');mkdirSync(bin);
  const log=join(directory,'calls');
  writeFileSync(join(bin,'gh'),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$FIXTURE_LOG"\nif [ "$1 $2" = "release upload" ] && [ "$FAIL_UPLOAD" = "1" ]; then exit 1; fi\nexit 0\n',{mode:0o755});
  for(const fail of ['0','1']) {
   writeFileSync(log,'');
   const result=spawnSync('bash',['-c',script],{cwd:directory,encoding:'utf8',env:{...process.env,PATH:bin+':'+process.env.PATH,FIXTURE_LOG:log,FAIL_UPLOAD:fail,TAG:'v1.2.401',TARGET_SHA:source,TAG_PREEXISTS:'false',GITHUB_REPOSITORY:'MemTensor/memmy-agent'}});
   expect(result.status).toBe(fail==='0'?0:1);
   const calls=readFileSync(log,'utf8');
   expect(calls.includes('release delete')).toBe(fail==='1');
   if(fail==='0') {
    // A distinct post-upload step may fail; its process has no cleanup trap.
    expect(spawnSync('bash',['-c','exit 17'],{cwd:directory}).status).toBe(17);
    expect(readFileSync(log,'utf8')).not.toContain('release delete');
   }
  }
 });
});
