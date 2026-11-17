import {afterEach,expect,it,vi} from "vitest";
import {join} from "node:path";
import {MemoryDb} from "../../../src/storage/db.js";
import {Repositories,l3WorldModelScopeKey,l3WorldModelFieldScopeKey} from "../../../src/storage/repositories.js";
import {canonicalJson,sha256Hex,deriveWorkspaceHostId} from "../../../src/contracts/index.js";
import {DEVICE_MEMORY_OWNER as device} from "../../../src/service/namespace/memory-owner.js";
import {L3WorldModelTraceFieldPipeline} from "../../../src/service/evolution/l3-world-model-pipeline.js";
import {createMemoryServiceFixture,createFailingLlm} from "../../fixtures/memory-service-fixture.js";
import type {L3WorldModelTargetField} from "../../../src/storage/repositories.js";
import type {LlmClient} from "../../../src/model/types.js";

const f=createMemoryServiceFixture();afterEach(f.cleanup);
const fields=["project_contract","domain_knowledge","general_rules_and_safety_constraints"] as const;
const property=(field:L3WorldModelTargetField)=>field==="project_contract"?"projectContract":field==="domain_knowledge"?"domainKnowledge":"generalRulesAndSafetyConstraints";
function output(field:L3WorldModelTargetField,op:string,value:string){return JSON.stringify({op,[field]:value,...(field==="project_contract"?{reason:"Keep the rule from the historical conversation"}:{})});}

async function setup(field:L3WorldModelTargetField,legacy=true){
  const model={...createFailingLlm(),complete:vi.fn<LlmClient['complete']>()};
  const x=f.createTestService({skillLlm:model});const repos=new Repositories(x.db.db);
  const isProject=field!=="general_rules_and_safety_constraints";
  const uri='file:///tmp/pr796-deleted-dialogue';const host=deriveWorkspaceHostId('pr796-dialogue-machine');
  const workspace=isProject?{workspaceUri:uri,workspaceHostId:host}:{};
  const ns=(key:string)=>({source:'codex',profileId:'default',userId:device,sessionKey:key});
  const opened=x.service.openSession({...workspace,l3WorldModelProtocolVersion:2,l3WorldModelTransition:'resume_only',namespace:ns('historical')});
  await x.service.completeTurn('old-evidence',{sessionId:opened.sessionId,
    query:'Keep the confirmed project convention and reusable knowledge. Ask before deleting files.',answer:'Confirmed.',status:'succeeded'});
  x.service.closeSession(opened.sessionId);
  let job=repos.runtime.listJobs('queued',100).find(j=>j.jobType==='l3_world_model_update'&&j.payload.targetField===field)!;
  expect(job).toBeDefined();
  if(legacy){
    // Only fixture construction: reconstruct a valid pre-decoupling owner,
    // UID-derived project, immutable batch hash and field identity together.
    const owner='account-a';const project=isProject?`ws_${sha256Hex(`${owner}\0local\0${host}\0${uri}`)}`:null;
    const scope=l3WorldModelScopeKey(owner,project);
    const batch=repos.l3WorldModels.getBatch(String(job.payload.batchId))!;
    x.db.db.prepare(`INSERT INTO l3_world_model_scopes(scope_key,user_id,project_id,workspace_uri,memory_id,next_scope_seq,updated_at)
      SELECT ?,?,?,workspace_uri,NULL,next_scope_seq,updated_at FROM l3_world_model_scopes WHERE scope_key=?`).run(scope,owner,project,batch.scopeKey);
    x.db.db.prepare('UPDATE sessions SET user_id=?,project_id=? WHERE id=?').run(owner,project,opened.sessionId);
    x.db.db.prepare('UPDATE raw_turns SET user_id=? WHERE session_id=?').run(owner,opened.sessionId);
    x.db.db.prepare('UPDATE memories SET user_id=? WHERE session_id=? AND memory_layer=\'L1\'').run(owner,opened.sessionId);
    const hashPayload={scopeKey:scope,scopeSeq:batch.scopeSeq,userId:owner,projectId:project,sessionId:batch.sessionId,
      trigger:batch.trigger,startTraceSeq:batch.startTraceSeq,endTraceSeq:batch.endTraceSeq,
      l1MemoryIds:batch.l1MemoryIds,rawTurnIds:batch.rawTurnIds,feedbackIds:batch.feedbackIds};
    x.db.db.prepare('UPDATE l3_world_model_evidence_batches SET user_id=?,project_id=?,scope_key=?,payload_hash=? WHERE id=?')
      .run(owner,project,scope,sha256Hex(canonicalJson(hashPayload)),batch.id);
    for(const target of fields){
      const fieldScope=l3WorldModelFieldScopeKey(scope,target);
      x.db.db.prepare('UPDATE l3_world_model_batch_targets SET field_scope_key=? WHERE batch_id=? AND target_field=?').run(fieldScope,batch.id,target);
      x.db.db.prepare("UPDATE evolution_jobs SET user_id=?,scope_key=? WHERE job_type='l3_world_model_update' AND json_extract(payload_json,'$.batchId')=? AND json_extract(payload_json,'$.targetField')=?")
        .run(owner,fieldScope,batch.id,target);
    }
    job=repos.runtime.getJob(job.id)!;
  }
  const current=x.service.openSession({...workspace,l3WorldModelProtocolVersion:2,l3WorldModelTransition:'resume_only',namespace:ns('current-device')});
  const memory=repos.l3WorldModels.upsertField({userId:device,projectId:current.projectId,targetField:field,value:'Latest device content'})!;
  const context=(service=x.service)=>service.l3WorldModelContext(current.sessionId,{requestId:crypto.randomUUID(),adapterId:'test',
    namespace:{source:'codex',profileId:'default',userId:device,projectId:current.projectId??undefined}});
  const read=(service=x.service)=>context(service)[property(field)];
  expect(read()).toBe('Latest device content');
  return {...x,repos,model,job,current,memory,read,context,pipeline:new L3WorldModelTraceFieldPipeline({repos,skillLlm:model})};
}

async function newTarget(x:Awaited<ReturnType<typeof setup>>,field:L3WorldModelTargetField,session=x.current){
  const turn=await x.service.completeTurn(crypto.randomUUID(),{sessionId:session.sessionId,
    query:'A new confirmed rule after the deletion.',answer:'Confirmed new evidence.',status:'succeeded'});
  x.service.l3WorldModelBoundary(session.sessionId,{requestId:crypto.randomUUID(),adapterId:'test',
    namespace:{source:'codex',profileId:'default',userId:device,projectId:session.projectId??undefined},
    trigger:'token_compaction',throughL1MemoryId:turn.l1MemoryId!});
  const job=x.repos.runtime.listJobs('queued',100).find(j=>j.jobType==='l3_world_model_update'&&
    j.sessionId===session.sessionId&&j.payload.targetField===field);
  if(!job)throw new Error('expected newly created field target');
  return job;
}

function backupFor(source:Awaited<ReturnType<typeof setup>>){
  const backup=source.service.exportBundle({includeRawText:true,includeAudit:false});
  // Historical bundles predate enqueue_seq. Its current-format collision is
  // an independently tracked issue and production scheduling is unchanged.
  for(const row of backup.tables.evolution_jobs??[])delete row.enqueue_seq;
  return backup;
}
function targetFor(source:Awaited<ReturnType<typeof setup>>,field:L3WorldModelTargetField){
  const target=f.createTestService({skillLlm:source.model});const repos=new Repositories(target.db.db);
  const saved=source.repos.runtime.getSession(source.current.sessionId)!;
  const workspace=typeof saved.meta.workspace_uri==='string'&&typeof saved.meta.workspace_host_id==='string'
    ?{workspaceUri:saved.meta.workspace_uri,workspaceHostId:saved.meta.workspace_host_id}:{};
  const viewer=target.service.openSession({l3WorldModelProtocolVersion:2,l3WorldModelTransition:'resume_only',
    ...workspace,
    namespace:{source:'codex',profileId:'default',userId:device,sessionKey:'target-viewer'}});
  const context=(service=target.service)=>service.l3WorldModelContext(viewer.sessionId,{requestId:crypto.randomUUID(),adapterId:'test',
    namespace:{source:'codex',profileId:'default',userId:device,projectId:viewer.projectId??undefined}});
  const read=(service=target.service)=>context(service)[property(field)];
  const memory=repos.l3WorldModels.upsertField({userId:device,projectId:viewer.projectId,targetField:field,value:'Target latest content'})!;
  return {...target,repos,viewer,memory,context,read,runner:new L3WorldModelTraceFieldPipeline({repos,skillLlm:source.model})};
}

for(const field of fields){
  it.each(['before-delete','after-delete'] as const)(`historical import respects deletion of ${field}: %s`,async order=>{
    const source=await setup(field);const backup=backupFor(source);const x=targetFor(source,field);
    if(order==='before-delete')x.service.importBundle({bundle:backup,conflictStrategy:'skip'});
    x.service.deleteMemory(x.memory.id);expect(x.read()).toBeNull();
    if(order==='after-delete')x.service.importBundle({bundle:backup,conflictStrategy:'skip'});
    expect(x.read()).toBeNull(); // No saved active L3 copy was restored by import.
    const imported=x.repos.runtime.getJob(source.job.id)!;
    expect(imported).toMatchObject({userId:'account-a',payload:source.job.payload,scopeKey:source.job.scopeKey});
    source.model.complete.mockResolvedValue(output(field,'create','Imported old conversation resurrected'));
    await x.runner.updateField(imported);expect(source.model.complete).not.toHaveBeenCalled();expect(x.read()).toBeNull();
    await x.service.stop();x.db.close();const db=new MemoryDb({path:join(x.root,'memory.sqlite')});
    const service=f.createTestMemoryService({db,skillLlm:source.model});expect(x.read(service)).toBeNull();
  });

  it.each(['restart','repeat','new-local-value','legacy-clear','partial-target','default-status'] as const)(`keeps the ${field} deletion boundary across %s`,async mode=>{
    const source=await setup(field);const backup=backupFor(source);let x=targetFor(source,field);
    x.service.deleteMemory(x.memory.id);
    if(mode==='legacy-clear')x.db.db.prepare("DELETE FROM runtime_kv WHERE key LIKE 'l3_field_deletion_v1:%'").run();
    if(mode==='new-local-value')x.repos.l3WorldModels.upsertField({userId:device,projectId:x.viewer.projectId,targetField:field,value:'New local value'});
    if(mode==='restart'){
      await x.service.stop();x.db.close();const db=new MemoryDb({path:join(x.root,'memory.sqlite')});
      const service=f.createTestMemoryService({db,skillLlm:source.model});const repos=new Repositories(db.db);
      x={...x,db,service,repos,runner:new L3WorldModelTraceFieldPipeline({repos,skillLlm:source.model})};
    }
    const expected=mode==='new-local-value'?'New local value':null;
    if(mode==='default-status')for(const row of backup.tables.l3_world_model_batch_targets??[])delete row.status;
    if(mode==='partial-target'){
      const jobs=backup.tables.evolution_jobs;delete backup.tables.evolution_jobs;
      x.service.importBundle({bundle:backup,conflictStrategy:'skip'});
      expect(x.repos.l3WorldModels.getTarget(String(source.job.payload.batchId),field)).toMatchObject({status:'applied',noChange:true});
      x.repos.runtime.importBundleTables({evolution_jobs:jobs});
    }else{
      x.service.importBundle({bundle:backup,conflictStrategy:'skip'});
      if(mode==='repeat')x.service.importBundle({bundle:backup,conflictStrategy:'skip'});
    }
    source.model.complete.mockResolvedValue(output(field,expected?'update':'create','Obsolete imported value'));
    await x.runner.updateField(x.repos.runtime.getJob(source.job.id)!);
    expect(source.model.complete).not.toHaveBeenCalled();expect(x.read(x.service)).toBe(expected);
    await x.service.stop();x.db.close();const db=new MemoryDb({path:join(x.root,'memory.sqlite')});
    const service=f.createTestMemoryService({db,skillLlm:source.model});expect(x.read(service)).toBe(expected);
  });
}

it('preserves an independent imported domain target when only the contract was deleted',async()=>{
  const source=await setup('project_contract');const backup=backupFor(source);const x=targetFor(source,'project_contract');
  x.service.deleteMemory(x.memory.id);x.service.importBundle({bundle:backup,conflictStrategy:'skip'});
  const domain=x.repos.runtime.listJobs('queued',100).find(j=>j.payload.batchId===source.job.payload.batchId&&j.payload.targetField==='domain_knowledge')!;
  source.model.complete.mockResolvedValue(output('domain_knowledge','create','Independent imported knowledge'));
  await x.runner.updateField(domain);
  expect(x.context()).toMatchObject({projectContract:null,domainKnowledge:'Independent imported knowledge'});
});

it('a skipped import does not revoke a genuinely new local target',async()=>{
  const x=await setup('project_contract');x.service.deleteMemory(x.memory.id);
  const job=await newTarget(x,'project_contract');const backup=backupFor(x);
  x.service.importBundle({bundle:backup,conflictStrategy:'skip'});
  x.model.complete.mockResolvedValue(output('project_contract','create','New local task remains allowed'));
  await x.pipeline.updateField(job);expect(x.read()).toBe('New local task remains allowed');
});

it.each(['skip','replace','error'] as const)('ignores foreign deletion metadata under %s',async conflictStrategy=>{
  const x=await setup('project_contract',false);
  const key='l3_field_deletion_v1:'+JSON.stringify([x.current.projectId,'project_contract']);
  const result=x.repos.runtime.importBundleTables({runtime_kv:[{key,value_json:'true',updated_at:new Date().toISOString()}]},{conflictStrategy});
  expect(result.skipped.runtime_kv).toBe(1);expect(x.repos.runtime.getKv(key)).toBeUndefined();
  x.model.complete.mockResolvedValue(output('project_contract','update','Allowed local task'));
  await x.pipeline.updateField(x.job);expect(x.read()).toBe('Allowed local task');
});

it('rolls back compatibility metadata when an import conflicts',async()=>{
  const x=await setup('project_contract');x.service.deleteMemory(x.memory.id);
  x.db.db.prepare("DELETE FROM runtime_kv WHERE key LIKE 'l3_field_deletion_v1:%'").run();
  const backup=backupFor(x);const before=x.db.db.prepare('SELECT * FROM runtime_kv ORDER BY key').all();
  expect(()=>x.service.importBundle({bundle:backup,conflictStrategy:'error'})).toThrow('import conflict');
  expect(x.db.db.prepare('SELECT * FROM runtime_kv ORDER BY key').all()).toEqual(before);expect(x.read()).toBeNull();
});

it('does not apply another host deletion boundary to imported tasks',async()=>{
  const source=await setup('project_contract');const target=f.createTestService({skillLlm:source.model});
  const repos=new Repositories(target.db.db);
  const viewer=target.service.openSession({l3WorldModelProtocolVersion:2,l3WorldModelTransition:'resume_only',
    workspaceUri:'file:///tmp/pr796-deleted-dialogue',workspaceHostId:deriveWorkspaceHostId('different-machine'),
    namespace:{source:'codex',profileId:'default',userId:device,sessionKey:'another-host'}});
  const memory=repos.l3WorldModels.upsertField({userId:device,projectId:viewer.projectId,targetField:'project_contract',value:'Other host contract'})!;
  target.service.deleteMemory(memory.id);target.service.importBundle({bundle:backupFor(source),conflictStrategy:'skip'});
  source.model.complete.mockResolvedValue(output('project_contract','update','Imported task remains allowed'));
  await new L3WorldModelTraceFieldPipeline({repos,skillLlm:source.model}).updateField(repos.runtime.getJob(source.job.id)!);
  const read=(sessionId:string,projectId:string)=>target.service.l3WorldModelContext(sessionId,{requestId:crypto.randomUUID(),adapterId:'test',
    namespace:{source:'codex',profileId:'default',userId:device,projectId}}).projectContract;
  expect(read(source.current.sessionId,source.current.projectId!)).toBe('Imported task remains allowed');
  expect(read(viewer.sessionId,viewer.projectId!)).toBeNull();
});

it('protects an existing pre-fix clear when only the missing job is imported later',async()=>{
  const source=await setup('project_contract');const backup=backupFor(source);const jobs=backup.tables.evolution_jobs;
  delete backup.tables.evolution_jobs;const x=targetFor(source,'project_contract');
  x.service.importBundle({bundle:backup,conflictStrategy:'skip'});x.service.deleteMemory(x.memory.id);
  // Reconstruct pre-fix deletion: it skipped targets whose partial bundle had
  // not supplied the job. Only mutable terminal metadata differs; identity and
  // payload hash remain valid, and the local cleared marker is retained.
  x.db.db.prepare("DELETE FROM runtime_kv WHERE key GLOB 'l3_field_deletion_v1:*'").run();
  x.db.db.prepare("UPDATE l3_world_model_batch_targets SET status='queued',no_change=0,applied_at=NULL WHERE batch_id=? AND target_field='project_contract'")
    .run(source.job.payload.batchId);
  x.db.db.prepare('UPDATE l3_world_model_evidence_batches SET terminal_outcome=NULL,completed_at=NULL WHERE id=?').run(source.job.payload.batchId);
  x.repos.runtime.importBundleTables({evolution_jobs:jobs});
  source.model.complete.mockResolvedValue(output('project_contract','create','Late old job'));
  await x.runner.updateField(x.repos.runtime.getJob(source.job.id)!);
  expect(source.model.complete).not.toHaveBeenCalled();expect(x.read()).toBeNull();
});

it.each(fields.flatMap(field=>['applied','dead_letter','missing-target','missing-batch'].map(terminal=>({field,terminal}))))('a late failed $field job cannot block a new task ($terminal)',async ({field,terminal})=>{
  const x=await setup(field,false);x.service.reconcileWorkerStartup(10);
  const claim=x.repos.runtime.claimQueuedJob(x.job.id)!;
  expect(claim).toBeDefined();
  x.repos.runtime.failJob(x.job.id,'model configuration missing',new Date().toISOString(),false,claim,
    {availableAt:null,blockedReason:'configuration',countFailure:false});
  const backup=backupFor(x);const old=backup.tables.evolution_jobs!.find(row=>row.id===x.job.id)!;
  const targetRow=backup.tables.l3_world_model_batch_targets!.find(row=>row.batch_id===x.job.payload.batchId&&row.target_field===field)!;
  if(terminal==='dead_letter'){
    x.repos.runtime.resumeConfigurationBlockedJobs(new Date().toISOString(),[x.job.id]);
    const retry=x.repos.runtime.claimQueuedJob(x.job.id)!;expect(retry).toBeDefined();
    x.repos.runtime.failJob(x.job.id,'permanent evidence failure',new Date().toISOString(),true,retry);
  }
  if(terminal==='missing-target')x.db.db.prepare('DELETE FROM l3_world_model_batch_targets WHERE batch_id=? AND target_field=?').run(x.job.payload.batchId,field);
  if(terminal==='missing-batch')x.db.db.prepare('DELETE FROM l3_world_model_evidence_batches WHERE id=?').run(x.job.payload.batchId);
  // Model a targets-only delivery; its independently delivered failed job is
  // valid and retains the same identity, payload and scope sequence.
  x.db.db.prepare('DELETE FROM evolution_jobs WHERE id=?').run(x.job.id);
  x.service.deleteMemory(x.memory.id);
  x.service.importBundle({bundle:{...backup,tables:{evolution_jobs:[old]}},conflictStrategy:'skip'});
  expect(x.repos.runtime.getJob(x.job.id)).toMatchObject({status:terminal==='dead_letter'?'dead_letter':'succeeded',blockedReason:null,availableAt:null});
  if(terminal==='missing-target')x.repos.runtime.importBundleTables({l3_world_model_batch_targets:[targetRow]});
  if(terminal==='missing-batch')x.repos.runtime.importBundleTables({
    l3_world_model_evidence_batches:backup.tables.l3_world_model_evidence_batches!.filter(row=>row.id===x.job.payload.batchId),
    l3_world_model_batch_targets:[targetRow]
  });
  expect(x.repos.l3WorldModels.getTarget(String(x.job.payload.batchId),field)).toMatchObject(
    terminal==='dead_letter'?{status:'dead_letter',noChange:false}:{status:'applied',noChange:true});
  const fresh=await newTarget(x,field);
  // Isolate actual worker scheduling from unrelated fixture capture jobs.
  x.db.db.prepare("UPDATE evolution_jobs SET status='succeeded' WHERE id NOT IN (?,?)").run(x.job.id,fresh.id);
  x.model.complete.mockResolvedValue(output(field,'create','Genuine new value'));
  await x.service.runWorkerOnce(10);
  expect(x.repos.runtime.getJob(fresh.id)?.status).toBe('succeeded');expect(x.read()).toBe('Genuine new value');
  await x.service.stop();x.db.close();const db=new MemoryDb({path:join(x.root,'memory.sqlite')});
  const service=f.createTestMemoryService({db,skillLlm:x.model});const repos=new Repositories(db.db);
  const replay=new L3WorldModelTraceFieldPipeline({repos,skillLlm:x.model}).updateField(repos.runtime.getJob(x.job.id)!);
  if(terminal==='dead_letter')await expect(replay).rejects.toThrow('already dead letter');else await replay;
  expect(x.read(service)).toBe('Genuine new value');
});

it.each(fields)('preserves a pre-fix %s clear before metadata-only import',async field=>{
  const source=await setup(field);const backup=backupFor(source);const x=targetFor(source,field);
  x.service.deleteMemory(x.memory.id);
  x.db.db.prepare("DELETE FROM runtime_kv WHERE key GLOB 'l3_field_deletion_v1:*'").run();
  const key='l3_field_override_v1:'+JSON.stringify([x.viewer.projectId??null,field]);
  const marker=backup.tables.runtime_kv!.find(row=>row.key===key)!;expect(marker).toBeDefined();
  x.service.importBundle({bundle:{...backup,tables:{runtime_kv:[marker]}},conflictStrategy:'replace'});
  expect(x.read()).toBeNull();
  x.service.importBundle({bundle:backup,conflictStrategy:'skip'});expect(x.read()).toBeNull();
  source.model.complete.mockResolvedValue(output(field,'create','Old evidence through split metadata'));
  expect(x.repos.runtime.getJob(source.job.id)?.status).toBe('succeeded');
  await x.runner.updateField(x.repos.runtime.getJob(source.job.id)!);
  expect(source.model.complete).not.toHaveBeenCalled();expect(x.read()).toBeNull();
  await x.service.stop();x.db.close();const db=new MemoryDb({path:join(x.root,'memory.sqlite')});
  const service=f.createTestMemoryService({db,skillLlm:source.model});expect(x.read(service)).toBeNull();
});

it.each(fields)('preserves the current %s binding when old metadata precedes a split task import',async field=>{
  const source=await setup(field);const backup=backupFor(source);const x=targetFor(source,field);
  x.service.deleteMemory(x.memory.id);
  const fresh=x.repos.l3WorldModels.upsertField({userId:device,projectId:x.viewer.projectId,targetField:field,value:'New local value after deletion'})!;
  const key='l3_field_override_v1:'+JSON.stringify([x.viewer.projectId??null,field]);
  const before=x.repos.runtime.getKv(key);
  const tables={...backup.tables};const jobs=tables.evolution_jobs;const batches=tables.l3_world_model_evidence_batches;const targets=tables.l3_world_model_batch_targets;
  delete tables.evolution_jobs;delete tables.l3_world_model_evidence_batches;delete tables.l3_world_model_batch_targets;
  x.repos.runtime.importBundleTables({evolution_jobs:jobs},{conflictStrategy:'skip'});
  const metadata=x.repos.runtime.importBundleTables({runtime_kv:tables.runtime_kv},{conflictStrategy:'replace'});
  expect(x.read()).toBe('New local value after deletion');expect(x.repos.runtime.getKv(key)).toEqual(before);
  expect(metadata.conflicts).toContainEqual(expect.objectContaining({table:'runtime_kv',sourceId:key,action:'skipped'}));
  x.repos.runtime.importBundleTables(tables,{conflictStrategy:'skip'});
  x.repos.runtime.importBundleTables({l3_world_model_evidence_batches:batches},{conflictStrategy:'skip'});
  x.repos.runtime.importBundleTables({l3_world_model_batch_targets:targets},{conflictStrategy:'skip'});
  await x.service.stop();x.db.close();const db=new MemoryDb({path:join(x.root,'memory.sqlite')});
  const service=f.createTestMemoryService({db,skillLlm:source.model});const repos=new Repositories(db.db);
  source.model.complete.mockResolvedValue(output(field,'update','Old imported value'));
  await new L3WorldModelTraceFieldPipeline({repos,skillLlm:source.model}).updateField(repos.runtime.getJob(source.job.id)!);
  expect(source.model.complete).not.toHaveBeenCalled();expect(x.read(service)).toBe('New local value after deletion');
  expect(repos.memories.get(fresh.id)?.userId).toBe(device);
});

it.each(fields)('preserves an explicit %s clear and its revision during metadata replacement',async field=>{
  const source=await setup(field);const backup=backupFor(source);const x=targetFor(source,field);
  x.service.deleteMemory(x.memory.id);
  const key='l3_field_override_v1:'+JSON.stringify([x.viewer.projectId??null,field]);
  const before=x.repos.runtime.getKv(key);
  x.service.importBundle({bundle:{...backup,tables:{runtime_kv:backup.tables.runtime_kv}},conflictStrategy:'replace'});
  expect(x.read()).toBeNull();expect(x.repos.runtime.getKv(key)).toEqual(before);
});

it.each(fields)('keeps normal replace import working for an undeleted %s field',async field=>{
  const source=await setup(field);const x=targetFor(source,field);
  x.service.importBundle({bundle:backupFor(source),conflictStrategy:'replace'});
  expect(x.read()).toBe('Latest device content');
  expect(x.repos.runtime.getJob(source.job.id)?.userId).toBe('account-a');
  await x.service.stop();x.db.close();const db=new MemoryDb({path:join(x.root,'memory.sqlite')});
  const service=f.createTestMemoryService({db,skillLlm:source.model});expect(x.read(service)).toBe('Latest device content');
});

it.each(fields.flatMap(field=>['skip','replace'].map(strategy=>({field,strategy:strategy as 'skip'|'replace'}))))('restores $field into an empty database using $strategy',async({field,strategy})=>{
  const source=await setup(field);const x=f.createTestService({skillLlm:source.model});
  x.service.importBundle({bundle:backupFor(source),conflictStrategy:strategy});
  expect(source.read(x.service)).toBe('Latest device content');
  expect(new Repositories(x.db.db).runtime.getJob(source.job.id)?.userId).toBe('account-a');
  await x.service.stop();x.db.close();const db=new MemoryDb({path:join(x.root,'memory.sqlite')});
  const service=f.createTestMemoryService({db,skillLlm:source.model});expect(source.read(service)).toBe('Latest device content');
});

it('rolls back an error import without changing the post-deletion field binding',async()=>{
  const source=await setup('project_contract');const x=targetFor(source,'project_contract');
  x.service.deleteMemory(x.memory.id);
  x.repos.l3WorldModels.upsertField({userId:device,projectId:x.viewer.projectId,targetField:'project_contract',value:'Keep local binding'});
  const before=x.db.db.prepare('SELECT * FROM runtime_kv ORDER BY key').all();
  expect(()=>x.service.importBundle({bundle:{...backupFor(source),tables:{runtime_kv:backupFor(source).tables.runtime_kv}},conflictStrategy:'error'})).toThrow('import conflict');
  expect(x.db.db.prepare('SELECT * FROM runtime_kv ORDER BY key').all()).toEqual(before);
  expect(x.read()).toBe('Keep local binding');
});

it.each(fields.flatMap(field=>['atomic','data-first','metadata-first','scope-first','memory-first'].map(order=>({field,order}))))('keeps $field readable after a complete replace restore ($order)',async({field,order})=>{
  const source=await setup(field);const backup=backupFor(source);const x=targetFor(source,field);
  x.service.deleteMemory(x.memory.id);
  x.repos.l3WorldModels.upsertField({userId:device,projectId:x.viewer.projectId,targetField:field,value:'New local binding'});
  if(order==='atomic')x.service.importBundle({bundle:backup,conflictStrategy:'replace'});
  else if(order==='data-first'){
    const tables={...backup.tables};delete tables.runtime_kv;
    x.service.importBundle({bundle:{...backup,tables},conflictStrategy:'replace'});
    x.service.importBundle({bundle:{...backup,tables:{runtime_kv:backup.tables.runtime_kv}},conflictStrategy:'replace'});
  }else{
    x.service.importBundle({bundle:{...backup,tables:{runtime_kv:backup.tables.runtime_kv}},conflictStrategy:'replace'});
    const tables={...backup.tables};delete tables.runtime_kv;
    if(order==='scope-first'||order==='memory-first'){
      const first=order==='scope-first'?'l3_world_model_scopes':'memories';
      if(order==='scope-first'){
        // A scope referencing a not-yet-restored memory must fail atomically;
        // retry it with its prerequisite rows rather than bypassing the FK.
        const before=x.db.db.prepare('SELECT * FROM runtime_kv ORDER BY key').all();
        expect(()=>x.service.importBundle({bundle:{...backup,tables:{[first]:tables[first]}},conflictStrategy:'replace'})).toThrow('FOREIGN KEY');
        expect(x.db.db.prepare('SELECT * FROM runtime_kv ORDER BY key').all()).toEqual(before);
        expect(x.read()).toBe('New local binding');
      }else{
        x.service.importBundle({bundle:{...backup,tables:{[first]:tables[first]}},conflictStrategy:'replace'});
        delete tables[first];
      }
    }
    x.service.importBundle({bundle:{...backup,tables},conflictStrategy:'replace'});
  }
  expect(x.read()).toBe('Latest device content');
  source.model.complete.mockResolvedValue(output(field,'update','Obsolete task overwrite'));
  await x.runner.updateField(x.repos.runtime.getJob(source.job.id)!);
  expect(source.model.complete).not.toHaveBeenCalled();expect(x.read()).toBe('Latest device content');
  await x.service.stop();x.db.close();const db=new MemoryDb({path:join(x.root,'memory.sqlite')});
  const service=f.createTestMemoryService({db,skillLlm:source.model});expect(x.read(service)).toBe('Latest device content');
});

it.each(['missing','number','numeric-clear'] as const)('repairs a legacy clear with %s control metadata without reviving content',async mode=>{
  const source=await setup('project_contract');const x=targetFor(source,'project_contract');
  x.service.deleteMemory(x.memory.id);
  const key='l3_field_override_v1:'+JSON.stringify([x.viewer.projectId??null,'project_contract']);
  const state=x.repos.runtime.getKv(key)!.value as Record<string,unknown>;
  if(mode==='missing')delete state.revision;else if(mode==='number')state.revision=42;else state.cleared=1;
  x.repos.runtime.setKv(key,state);
  x.service.importBundle({bundle:backupFor(source),conflictStrategy:'replace'});
  expect(x.read()).toBeNull();expect(x.repos.runtime.getKv(key)?.value).toEqual({cleared:true,revision:expect.any(String)});
  await x.service.stop();x.db.close();const db=new MemoryDb({path:join(x.root,'memory.sqlite')});
  const service=f.createTestMemoryService({db,skillLlm:source.model});expect(x.read(service)).toBeNull();
});

it.each(['missing','number'] as const)('restores a valid binding over a non-clear marker with a %s revision',async mode=>{
  const source=await setup('project_contract');const x=targetFor(source,'project_contract');
  x.service.deleteMemory(x.memory.id);
  x.repos.l3WorldModels.upsertField({userId:device,projectId:x.viewer.projectId,targetField:'project_contract',value:'Current value'});
  const key='l3_field_override_v1:'+JSON.stringify([x.viewer.projectId??null,'project_contract']);
  const state=x.repos.runtime.getKv(key)!.value as Record<string,unknown>;
  if(mode==='missing')delete state.revision;else state.revision=42;
  x.repos.runtime.setKv(key,state);
  x.service.importBundle({bundle:backupFor(source),conflictStrategy:'replace'});
  expect(x.read()).toBe('Latest device content');
  await x.service.stop();x.db.close();const db=new MemoryDb({path:join(x.root,'memory.sqlite')});
  const service=f.createTestMemoryService({db,skillLlm:source.model});expect(x.read(service)).toBe('Latest device content');
});

it.each(['project_contract','domain_knowledge'] as const)('does not turn an alias missing %s into an explicit clear',async field=>{
  const x=await setup(field);x.service.deleteMemory(x.memory.id);
  x.repos.l3WorldModels.upsertField({userId:device,projectId:x.current.projectId,targetField:field,value:'Restored canonical field'});
  const legacy=x.repos.runtime.getSession(x.job.sessionId!)!;
  const other=field==='project_contract'?'domain_knowledge':'project_contract';
  const alias=x.repos.l3WorldModels.upsertField({userId:device,projectId:legacy.projectId,targetField:other,value:'Independent alias field'})!;
  const backup=backupFor(x);
  const key='l3_field_override_v1:'+JSON.stringify([x.current.projectId,field]);
  const scopes=backup.tables.l3_world_model_scopes!.filter(row=>row.memory_id===alias.id);
  expect(scopes).toHaveLength(1);
  x.service.importBundle({bundle:{...backup,tables:{memories:backup.tables.memories,l3_world_model_scopes:scopes}},conflictStrategy:'replace'});
  expect(x.repos.runtime.getKv(key)?.value).toMatchObject({cleared:false});
  x.service.importBundle({bundle:backup,conflictStrategy:'replace'});
  x.service.importBundle({bundle:backup,conflictStrategy:'replace'});
  expect(x.read()).toBe('Restored canonical field');
  await x.service.stop();x.db.close();const db=new MemoryDb({path:join(x.root,'memory.sqlite')});
  const service=f.createTestMemoryService({db,skillLlm:x.model});expect(x.read(service)).toBe('Restored canonical field');
});

it.each(fields)('does not infer an explicit %s clear from a scope-only placeholder',async field=>{
  const x=await setup(field);x.service.deleteMemory(x.memory.id);
  x.repos.l3WorldModels.upsertField({userId:device,projectId:x.current.projectId,targetField:field,value:'Canonical content to restore'});
  const backup=backupFor(x);
  const scope=backup.tables.l3_world_model_scopes!.find(row=>row.user_id===device&&row.project_id===(x.current.projectId??null))!;
  expect(scope).toBeDefined();
  const key='l3_field_override_v1:'+JSON.stringify([x.current.projectId??null,field]);
  x.service.importBundle({bundle:{...backup,tables:{l3_world_model_scopes:[{...scope,memory_id:null}]}},conflictStrategy:'replace'});
  expect(x.repos.runtime.getKv(key)?.value).toMatchObject({cleared:false});
  x.service.importBundle({bundle:backup,conflictStrategy:'replace'});
  expect(x.read()).toBe('Canonical content to restore');
  await x.service.stop();x.db.close();const db=new MemoryDb({path:join(x.root,'memory.sqlite')});
  const service=f.createTestMemoryService({db,skillLlm:x.model});expect(x.read(service)).toBe('Canonical content to restore');
});
