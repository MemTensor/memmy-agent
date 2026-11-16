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

for(const field of fields){
  it.each(['queued','failed-before-delete','in-flight-then-retry'] as const)(`deletion revokes historical ${field}: %s`,async mode=>{
    const x=await setup(field);const batchBefore=x.repos.l3WorldModels.getBatch(String(x.job.payload.batchId));
    const jobCount=x.db.db.prepare("SELECT COUNT(*) FROM evolution_jobs WHERE job_type='l3_world_model_update'").pluck().get();
    let pending:Promise<void>|undefined;let release:((value:string)=>void)|undefined;
    if(mode==='failed-before-delete'){
      x.model.complete.mockRejectedValueOnce(new Error('controlled provider error'));
      await expect(x.pipeline.updateField(x.job)).rejects.toThrow('controlled provider error');
      expect(x.repos.runtime.failJob(x.job.id,'controlled provider error')?.status).toBe('failed');
    }
    if(mode==='in-flight-then-retry'){
      const claim=x.repos.runtime.claimQueuedJob(x.job.id);expect(claim?.status).toBe('leased');
      x.model.complete.mockImplementationOnce(()=>new Promise<string>(resolve=>{release=resolve;}));
      pending=x.pipeline.updateField(claim!);await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
    }
    x.service.deleteMemory(x.memory.id);expect(x.read()).toBeNull();
    expect(x.repos.l3WorldModels.getTarget(String(x.job.payload.batchId),field)?.status).toBe('applied');
    if(pending){release!(output(field,'update','In-flight old content'));await expect(pending).resolves.toBeUndefined();expect(x.read()).toBeNull();}
    x.model.complete.mockResolvedValueOnce(output(field,'create','Resurrected historical content'));
    await x.pipeline.updateField(x.repos.runtime.getJob(x.job.id)!);
    const restored=x.read();expect(restored).toBeNull();
    expect(x.repos.runtime.getJob(x.job.id)?.userId).toBe('account-a');
    const batchAfter=x.repos.l3WorldModels.getBatch(String(x.job.payload.batchId));
    expect(batchAfter?.payloadHash).toBe(batchBefore?.payloadHash);
    expect(batchAfter?.userId).toBe(batchBefore?.userId);
    expect(batchAfter?.scopeKey).toBe(batchBefore?.scopeKey);
    expect(x.model.complete).toHaveBeenCalledTimes(mode==='queued'?0:1);
    expect(x.db.db.prepare("SELECT COUNT(*) FROM evolution_jobs WHERE job_type='l3_world_model_update'").pluck().get()).toBe(jobCount);
    await x.service.stop();x.db.close();const db=new MemoryDb({path:join(x.root,'memory.sqlite')});const service=f.createTestMemoryService({db,skillLlm:x.model});
    const restarted=new Repositories(db.db);
    await new L3WorldModelTraceFieldPipeline({repos:restarted,skillLlm:x.model}).updateField(restarted.runtime.getJob(x.job.id)!);
    expect(x.model.complete).toHaveBeenCalledTimes(mode==='queued'?0:1);
    const afterRestart=x.read(service);expect(afterRestart).toBe(restored);
  });
  it(`same-owner cancellation control: ${field}`,async()=>{
    const x=await setup(field,false);x.model.complete.mockResolvedValue(output(field,'create','Should not be written'));
    x.service.deleteMemory(x.memory.id);await x.pipeline.updateField(x.job);
    expect(x.model.complete).not.toHaveBeenCalled();expect(x.read()).toBeNull();
  });
  it(`allows a genuinely new ${field} task after deletion, but not an old replay`,async()=>{
    const x=await setup(field);x.service.deleteMemory(x.memory.id);
    const job=await newTarget(x,field);
    x.model.complete.mockResolvedValue(output(field,'create','Newly requested content'));
    await x.pipeline.updateField(job);await x.pipeline.updateField(x.job);
    expect(x.read()).toBe('Newly requested content');expect(x.model.complete).toHaveBeenCalledTimes(1);
    await x.service.stop();x.db.close();const db=new MemoryDb({path:join(x.root,'memory.sqlite')});
    const service=f.createTestMemoryService({db,skillLlm:x.model});expect(x.read(service)).toBe('Newly requested content');
  });
}

it('deleting the contract preserves another record and its old domain-knowledge task',async()=>{
  const x=await setup('project_contract');
  const project=x.repos.l3WorldModels.getBatch(String(x.job.payload.batchId))!.projectId;
  const independent=x.repos.l3WorldModels.upsertField({userId:device,projectId:project,
    targetField:'domain_knowledge',value:'Independent knowledge'})!;
  const before=x.repos.memories.get(independent.id);
  const domain=x.repos.runtime.listJobs('queued',100).find(j=>j.payload.batchId===x.job.payload.batchId&&j.payload.targetField==='domain_knowledge')!;
  expect(x.context().domainKnowledge).toBe('Independent knowledge');
  x.service.deleteMemory(x.memory.id);
  expect(x.context()).toMatchObject({projectContract:null,domainKnowledge:'Independent knowledge'});
  expect(x.repos.memories.get(independent.id)).toEqual(before);
  expect(x.repos.l3WorldModels.getTarget(String(domain.payload.batchId),'domain_knowledge')?.status).toBe('queued');
  x.model.complete.mockResolvedValue(output('domain_knowledge','update','Updated independent knowledge'));
  await x.pipeline.updateField(domain);
  expect(x.context()).toMatchObject({projectContract:null,domainKnowledge:'Updated independent knowledge'});
});

it.each(['other-host','other-path'] as const)('does not revoke a task in %s',async kind=>{
  const x=await setup('project_contract');
  const other=x.service.openSession({l3WorldModelProtocolVersion:2,l3WorldModelTransition:'resume_only',
    workspaceUri:kind==='other-host'?'file:///tmp/pr796-deleted-dialogue':'file:///tmp/pr796-other-project',
    workspaceHostId:deriveWorkspaceHostId(kind==='other-host'?'another-machine':'pr796-dialogue-machine'),
    namespace:{source:'codex',profileId:'default',userId:device,sessionKey:kind}});
  x.repos.l3WorldModels.upsertField({userId:device,projectId:other.projectId,targetField:'project_contract',value:'Other project contract'});
  const job=await newTarget(x,'project_contract',other);
  x.service.deleteMemory(x.memory.id);
  expect(x.repos.l3WorldModels.getTarget(String(job.payload.batchId),'project_contract')?.status).toBe('queued');
  x.model.complete.mockResolvedValue(output('project_contract','update','Other project updated'));
  await x.pipeline.updateField(job);
  expect(x.service.l3WorldModelContext(other.sessionId,{requestId:crypto.randomUUID(),adapterId:'test',
    namespace:{source:'codex',profileId:'default',userId:device,projectId:other.projectId!}}).projectContract).toBe('Other project updated');
  expect(x.read()).toBeNull();
});
