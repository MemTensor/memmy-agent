import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {describe,expect,it} from 'vitest';
import YAML from 'yaml';
import {verifyCandidate} from '../scripts/main-sync/validate-source.mjs';
import {normalizeConfig} from '../scripts/main-sync/core.mjs';
const H='a'.repeat(40),B='b'.repeat(40),C='c'.repeat(40),key='d'.repeat(64);
const config=normalizeConfig({schemaVersion:1,repository:'MemTensor/memmy-agent',targets:['v1.2.5']});
const env={GITHUB_REPOSITORY:config.repository,GITHUB_REF:'refs/heads/main',
  SYNC_CANDIDATE_SHA:H,SYNC_BASE_SHA:B,SYNC_PR_NUMBER:'71',SYNC_VALIDATION_KEY:key};
function fixture(){
  const pr={state:'open',head:{sha:H,ref:'sync/main-to-v1.2.5',repo:{full_name:'Fixture/memmy-agent'}},
    base:{ref:'v1.2.5',repo:{full_name:config.repository}}};
  const ref={object:{sha:B}},comparison={merge_base_commit:{sha:B}},calls=[];
  const api={request(method,path){
    calls.push(path);expect(method).toBe('GET');
    if(path==='/pulls/71')return pr;
    if(path==='/git/ref/heads/v1.2.5')return ref;
    if(path==='/compare/'+B+'...'+H)return comparison;
    throw new Error('Unexpected provider read');
  }};
  return {api,pr,ref,comparison,calls};
}
const verify=f=>verifyCandidate({api:f.api,config,env});
describe('authoritative validation source',()=>{
  it('binds current H/B and the actual fork repository',()=>{
    const f=fixture();expect(verify(f)).toEqual({headSha:H,baseSha:B,prNumber:71,validationKey:key,headRepository:'Fixture/memmy-agent'});
    expect(f.calls).toHaveLength(3);
  });
  it.each([['GITHUB_REPOSITORY','Fork/memmy-agent'],['GITHUB_REF','refs/heads/candidate'],
    ['SYNC_CANDIDATE_SHA','a'.repeat(39)],['SYNC_CANDIDATE_SHA',H+'\n'],['SYNC_BASE_SHA','main'],
    ['SYNC_PR_NUMBER','0'],['SYNC_VALIDATION_KEY','d'.repeat(63)],['SYNC_VALIDATION_KEY',key+'\n']])
  ('rejects invalid %s before provider reads',(field,value)=>{
    const f=fixture();expect(()=>verifyCandidate({api:f.api,config,env:{...env,[field]:value}})).toThrow();expect(f.calls).toHaveLength(0);
  });
  it.each([f=>{f.pr.state='closed';},f=>{f.pr.head.sha=C;},f=>{f.pr.base.repo.full_name='Other/repo';},
    f=>{f.pr.base.ref='main';},f=>{f.pr.head.ref='main';},f=>{f.pr.head.repo.full_name='bad/repo/extra';},
    f=>{f.ref.object.sha=C;},f=>{f.comparison.merge_base_commit.sha=C;}])
  ('rejects changed scope or missing base integration',mutate=>{const f=fixture();mutate(f);expect(()=>verify(f)).toThrow();});
});
const source=readFileSync(new URL('../.github/workflows/main-sync-validation.yml',import.meta.url),'utf8');
const workflow=YAML.parse(source),jobs=workflow.jobs;
describe('trusted validation workflow',()=>{
  it('uses a read-only main controller and exact candidate checkout',()=>{
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.permissions).toEqual({contents:'read',actions:'read'});
    expect(jobs.source.if).toContain("github.ref == 'refs/heads/main'");
    expect(jobs.source.steps.find(s=>s.uses?.startsWith('actions/checkout@')).with)
      .toMatchObject({ref:'${{ github.workflow_sha }}','persist-credentials':false});
    expect(jobs.linux.steps.find(s=>s.uses?.startsWith('actions/checkout@')).with)
      .toMatchObject({repository:'${{ needs.source.outputs.head_repository }}',ref:'${{ needs.source.outputs.head }}','persist-credentials':false});
    expect(jobs.windows).toMatchObject({uses:'MemTensor/memmy-agent/.github/workflows/windows-computer-history-validation.yml@main',
      with:{source_sha:'${{ needs.source.outputs.head }}',source_repository:'${{ needs.source.outputs.head_repository }}'}});
    expect(source).not.toMatch(/secrets\.|pull_request_target|codex-action|contents: write/);
    expect(jobs.record.needs).toEqual(['source','linux','windows']);
    expect(jobs.linux.steps.map(step=>step.run??'').join('\n')).toContain('npm run version:check');
    for(const job of Object.values(jobs))expect(job.name).toMatch(/^Main sync /);
  });
});
function record(overrides={}){
  const writes=[],results={source:{result:'success'},linux:{result:'success'},windows:{result:'success'},...overrides};
  runInNewContext(jobs.record.steps[0].run,{process:{env:{SOURCE_SHA:H,BASE_SHA:B,PR_NUMBER:'71',VALIDATION_KEY:key,
    CONTROLLER_SHA:C,PROVIDER_RUN_ID:'1234',PROVIDER_ATTEMPT:'2',JOB_RESULTS:JSON.stringify(results),RUNNER_TEMP:'/runner-temp'}},
  require(name){
    if(name==='node:fs')return {mkdirSync(){},writeFileSync(file,value){writes.push(value);}};
    if(name==='node:path')return {join:(...parts)=>parts.join('/')};
    throw new Error('Unexpected module');
  }});
  expect(writes).toHaveLength(1);return JSON.parse(writes[0]);
}
describe('actual provider record producer',()=>{
  it('records exact identity and successful provider outcomes',()=>expect(record()).toMatchObject({
    headSha:H,baseSha:B,prNumber:71,validationKey:key,controllerSha:C,runId:'1234',runAttempt:2,passed:true}));
  it.each([['linux','failure'],['linux','cancelled'],['windows','failure'],['windows','skipped']])
    ('does not pass when %s is %s',(job,result)=>expect(record({[job]:{result}}).passed).toBe(false));
  it('rejects missing provider results',()=>expect(()=>record({windows:undefined})).toThrow());
});
