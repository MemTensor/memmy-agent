import { afterEach, expect, it, vi } from "vitest";
import { join } from "node:path";
import { RetrievalService } from "../../src/service/retrieval/retrieval-service.js";
import { createMemoryHttpServer } from "../../src/index.js";
import { MemoryDb } from "../../src/storage/db.js";
import { Repositories, l3WorldModelMemoryKey, l3WorldModelScopeKey, l3WorldModelFieldScopeKey } from "../../src/storage/repositories.js";
import { canonicalJson, deriveWorkspaceHostId, sha256Hex } from "../../src/contracts/index.js";
import { L3WorldModelTraceFieldPipeline } from "../../src/service/evolution/l3-world-model-pipeline.js";
import { DEVICE_MEMORY_OWNER } from "../../src/service/namespace/memory-owner.js";
import { createMemoryServiceFixture, LEGACY_TEST_CONFIG, createFailingLlm } from "../fixtures/memory-service-fixture.js";
import type { LlmClient } from "../../src/model/types.js";
const fixture = createMemoryServiceFixture();
afterEach(fixture.cleanup);
const ns = (userId: string, sessionKey = "review") => ({source:"codex", profileId:"default", userId, sessionKey});
const v2 = (userId: string, key = "review") => ({namespace:ns(userId,key), l3WorldModelProtocolVersion:2 as const, l3WorldModelTransition:"resume_only" as const});
function oldWorld(repos: Repositories, owner: string, projectId: string, value: string) {
  const row = repos.l3WorldModels.upsertField({userId:owner, projectId, targetField:"project_contract", value})!;
  repos.db.prepare("UPDATE memories SET user_id=?, memory_key=? WHERE id=?").run(owner,l3WorldModelMemoryKey(owner,projectId),row.id);
  repos.db.prepare("UPDATE l3_world_model_scopes SET user_id=?, scope_key=? WHERE memory_id=?").run(owner,l3WorldModelScopeKey(owner,projectId),row.id);
  // Old versions did not produce override state. Only the fixture simulates old storage.
  repos.db.prepare("DELETE FROM runtime_kv WHERE key LIKE 'l3_field_override_v1:%'").run();
  return row.id;
}

it.each([true,false])("preserves old User Memory across restart and searches with recall=%s", async enabled => {
  const config={...LEGACY_TEST_CONFIG,algorithm:{...LEGACY_TEST_CONFIG.algorithm,enableUserMemoryRecall:enabled}};
  const {service,db,root}=fixture.createTestService({config,llm:createFailingLlm()});const repos=new Repositories(db.db);
  repos.userMemories.insert({id:"old",userId:"account-a",sourceTurnId:"old-turn",sourceTurnRefs:["old-turn"],memoryTypes:["User Preference"],content:"python specialterm",normalizedUserTextHash:"old",status:"active",embedding:[1,0],createdAt:"2026-01-01",updatedAt:"2026-01-01"});
  db.db.prepare("UPDATE user_memories SET user_id='account-a' WHERE id='old'").run();
  const before=db.db.prepare("SELECT * FROM user_memories").all();
  expect(repos.userMemories.countActive(DEVICE_MEMORY_OWNER)).toBe(1);
  expect(repos.userMemories.searchFtsIds(DEVICE_MEMORY_OWNER,"specialterm",10)).toHaveLength(1);
  expect(repos.userMemories.searchPatternIds(DEVICE_MEMORY_OWNER,["specialterm"],10)).toHaveLength(1);
  expect(repos.userMemories.searchVectorIds(DEVICE_MEMORY_OWNER,[1,0],10)).toHaveLength(1);
  for(const namespace of [ns("account-a"), ns("account-b"), {source:"codex",profileId:"default"}]) {
    const result=await service.search({namespace,query:"python specialterm",layers:["L1"],limit:20,contextBudget:30000});
    expect(result.hits.some(hit=>hit.id==="old")).toBe(enabled);
  }
  await service.stop();db.close();
  const reopenedDb=new MemoryDb({path:join(root,"memory.sqlite")});
  const reopened=fixture.createTestMemoryService({db:reopenedDb,config,llm:createFailingLlm()});
  const result=await reopened.search({namespace:ns("account-b"),query:"python specialterm",layers:["L1"],limit:20,contextBudget:30000});
  expect(result.hits.some(hit=>hit.id==="old")).toBe(enabled);
  expect(reopenedDb.db.prepare("SELECT * FROM user_memories").all()).toEqual(before);
});

it("overrides and clears old L3 per field, preserving historical rows across restart", async()=>{
  const {service,db,root}=fixture.createTestService();const repos=new Repositories(db.db);
  const opened=service.openSession({...v2("account-a"),workspaceUri:"file:///tmp/review-rules",workspaceHostId:deriveWorkspaceHostId("host")});
  const projectId=opened.projectId!;const oldId=oldWorld(repos,"account-a",projectId,"Run tests.");const before=repos.memories.get(oldId);
  const context=()=>service.l3WorldModelContext(opened.sessionId,{requestId:crypto.randomUUID(),adapterId:"test",namespace:{...ns("account-b"),projectId}});
  expect(context().projectContract).toBe("Run tests.");
  expect(repos.l3WorldModels.fields("account-b",projectId).projectContract).toBe("Run tests.");
  repos.l3WorldModels.upsertField({userId:"account-b",projectId,targetField:"domain_knowledge",value:"Node"});
  expect(context().projectContract).toBe("Run tests.");
  repos.l3WorldModels.upsertField({userId:"account-b",projectId,targetField:"project_contract",value:"Use pnpm test instead of npm test."});
  expect(context().projectContract).toBe("Use pnpm test instead of npm test.");
  repos.l3WorldModels.upsertField({userId:"account-b",projectId,targetField:"project_contract",value:null});
  expect(context().projectContract).toBeNull();expect(context().domainKnowledge).toBe("Node");
  expect(repos.memories.get(oldId)).toEqual(before);
  await service.stop();db.close();const reopenedDb=new MemoryDb({path:join(root,"memory.sqlite")});
  const reopened=fixture.createTestMemoryService({db:reopenedDb});
  expect(reopened.l3WorldModelContext(opened.sessionId,{requestId:crypto.randomUUID(),adapterId:"test",namespace:{...ns("account-a"),projectId}}).projectContract).toBeNull();
  expect(new Repositories(reopenedDb.db).memories.get(oldId)).toEqual(before);
});

it.each(["missing-both","missing-peer","wrong-host","wrong-uri","wrong-project","conflicting-session","healthy","no-session"] as const)("validates project aliases with %s evidence",scenario=>{
  const {service,db}=fixture.createTestService();const repos=new Repositories(db.db);
  const uri="file:///tmp/review-same-path" as const;const host=deriveWorkspaceHostId("machine-a");
  const a=service.openSession({...v2("account-a","old-a"),workspaceUri:uri,workspaceHostId:host});
  const oldProject=`ws_${sha256Hex(`account-a\0local\0${host}\0${uri}`)}`;
  db.db.prepare("UPDATE sessions SET user_id='account-a',project_id=? WHERE id=?").run(oldProject,a.sessionId);
  oldWorld(repos,"account-a",oldProject,"Only A");
  db.db.prepare("UPDATE l3_world_model_scopes SET workspace_uri=? WHERE project_id=?").run(uri,oldProject);
  const b=service.openSession({...v2("account-b","new-b"),workspaceUri:uri,workspaceHostId:host});
  if(scenario==="missing-both")db.db.prepare("UPDATE sessions SET meta_json=json_remove(meta_json,'$.workspace_host_id')").run();
  if(scenario==="missing-peer")db.db.prepare("UPDATE sessions SET meta_json=json_remove(meta_json,'$.workspace_host_id') WHERE id=?").run(a.sessionId);
  if(scenario==="wrong-host")db.db.prepare("UPDATE sessions SET meta_json=json_set(meta_json,'$.workspace_host_id',?) WHERE id=?").run(deriveWorkspaceHostId("wrong"),a.sessionId);
  if(scenario==="wrong-uri")db.db.prepare("UPDATE sessions SET meta_json=json_set(meta_json,'$.workspace_uri','file:///tmp/forged') WHERE id=?").run(a.sessionId);
  if(scenario==="wrong-project") {db.db.prepare("UPDATE sessions SET project_id='forged' WHERE id=?").run(a.sessionId);db.db.prepare("UPDATE l3_world_model_scopes SET project_id='forged' WHERE project_id=?").run(oldProject);}
  if(scenario==="conflicting-session") {const c=service.openSession({...v2("account-c","conflict"),workspaceUri:"file:///tmp/other",workspaceHostId:host});db.db.prepare("UPDATE sessions SET project_id=? WHERE id=?").run(oldProject,c.sessionId);}
  if(scenario==="no-session") db.db.prepare("DELETE FROM sessions WHERE id=?").run(a.sessionId);
  const context=service.l3WorldModelContext(b.sessionId,{requestId:crypto.randomUUID(),adapterId:"test",namespace:{...ns("account-b","new-b"),projectId:b.projectId!}});
  expect(context.projectContract).toBe(scenario==="healthy" || scenario==="no-session" ? "Only A" : null);
});

it.each([false,true])("queued L3 evolution reads old fields and retains immutable evidence (legacy batch=%s)",async legacyBatch=>{
  const {service,db}=fixture.createTestService();const repos=new Repositories(db.db);
  const opened=service.openSession({...v2("account-a"),workspaceUri:"file:///tmp/review-queue",workspaceHostId:deriveWorkspaceHostId("host")});const projectId=opened.projectId!;
  const id=oldWorld(repos,"account-a",projectId,"Run tests.");const before=repos.memories.get(id);
  await service.completeTurn("rule-turn",{sessionId:opened.sessionId,query:"Use pnpm test instead of npm test.",answer:"Updated.",status:"succeeded"});service.closeSession(opened.sessionId);
  const job=repos.runtime.listJobs("queued",100).find(j=>j.jobType==="l3_world_model_update" && j.payload.targetField==="project_contract")!;
  if (legacyBatch) {
    const batch=repos.l3WorldModels.getBatch(String(job.payload.batchId))!;
    const scopeKey=l3WorldModelScopeKey("account-a",projectId);
    const payload={scopeKey,scopeSeq:batch.scopeSeq,userId:"account-a",projectId,sessionId:batch.sessionId,trigger:batch.trigger,
      startTraceSeq:batch.startTraceSeq,endTraceSeq:batch.endTraceSeq,l1MemoryIds:batch.l1MemoryIds,rawTurnIds:batch.rawTurnIds,feedbackIds:batch.feedbackIds};
    db.db.prepare("UPDATE l3_world_model_evidence_batches SET user_id='account-a',scope_key=?,payload_hash=? WHERE id=?")
      .run(scopeKey,sha256Hex(canonicalJson(payload)),batch.id);
    for(const target of ["project_contract","domain_knowledge"] as const) {
      db.db.prepare("UPDATE l3_world_model_batch_targets SET field_scope_key=? WHERE batch_id=? AND target_field=?")
        .run(l3WorldModelFieldScopeKey(scopeKey,target),batch.id,target);
    }
    job.userId="account-a";job.scopeKey=l3WorldModelFieldScopeKey(scopeKey,"project_contract");
  }
  const batchBefore=repos.l3WorldModels.getBatch(String(job.payload.batchId));
  let release:((value:string)=>void)|undefined;
  const complete=vi.fn<LlmClient["complete"]>(()=>new Promise(resolve=>{release=resolve;}));
  const llm={complete,structuredCompletionMode:()=>"text"} as unknown as LlmClient;
  const pending=new L3WorldModelTraceFieldPipeline({repos,skillLlm:llm}).updateField(job);
  const rejection=expect(pending).rejects.toThrow("stale_l3_base");
  await vi.waitFor(()=>expect(complete).toHaveBeenCalledTimes(1));
  expect(JSON.parse(complete.mock.calls[0]![0][1]!.content).current_field).toBe("Run tests.");
  repos.l3WorldModels.upsertField({userId:"account-b",projectId,targetField:"project_contract",value:null});
  repos.l3WorldModels.upsertField({userId:"account-b",projectId,targetField:"project_contract",value:"Run tests."});
  release!(JSON.stringify({reason:"Changed command",op:"update",project_contract:"Use pnpm test instead of npm test."}));await rejection;
  const retry={...llm,complete:vi.fn<LlmClient["complete"]>().mockResolvedValue(JSON.stringify({reason:"Changed command",op:"update",project_contract:"Use pnpm test instead of npm test."}))} as LlmClient;
  await new L3WorldModelTraceFieldPipeline({repos,skillLlm:retry}).updateField(job);
  expect(repos.l3WorldModels.fields("account-b",projectId).projectContract).toBe("Use pnpm test instead of npm test.");
  expect(repos.l3WorldModels.getBatch(String(job.payload.batchId))).toEqual(batchBefore);
  expect(repos.memories.get(id)).toEqual(before);
});


it.each(["fts", "pattern", "vec"] as const)("refills historical User Memory through %s without rewriting or exposing archived rows", async route => {
  const {db}=fixture.createTestService();const repos=new Repositories(db.db);
  for(let i=0;i<65;i++) repos.userMemories.insert({id:`old-${i}`,userId:"account-a",sourceTurnId:i<35?"same-turn":`turn-${i}`,
    sourceTurnRefs:[],memoryTypes:["User Preference"],content:"python specialterm py",normalizedUserTextHash:`hash-${i}`,
    status:i>=60?"archived":"active",embedding:[1,0],createdAt:"2026-01-01",updatedAt:`2026-01-${i%28+1}`});
  db.db.prepare("UPDATE user_memories SET user_id=CASE WHEN rowid%2=0 THEN 'account-a' ELSE 'account-b' END").run();
  if(route!=="fts")vi.spyOn(repos.userMemories,"searchFtsIds").mockReturnValue([]);
  if(route!=="pattern")vi.spyOn(repos.userMemories,"searchPatternIds").mockReturnValue([]);
  const engine=new RetrievalService({repos,config:LEGACY_TEST_CONFIG} as never) as unknown as {
    retrieveUserMemories(input:unknown):Promise<{hits:Array<{id:string;sourceTurnId:string}>}>;
    queryVector(text:string):Promise<number[]>;
  };
  vi.spyOn(engine,"queryVector").mockResolvedValue(route === "vec" ? [1,0] : []);
  const before=db.db.prepare("SELECT * FROM user_memories ORDER BY id").all();
  const result=await engine.retrieveUserMemories({userId:DEVICE_MEMORY_OWNER,query:"py specialterm",queryVectorText:"python specialterm",queryExtract:null,limit:20});
  expect(result.hits, JSON.stringify(result)).toHaveLength(20);expect(new Set(result.hits.map(hit=>hit.sourceTurnId)).size).toBe(20);
  expect(result.hits.every(hit=>Number(hit.id.slice(4))<60)).toBe(true);
  expect(db.db.prepare("SELECT * FROM user_memories ORDER BY id").all()).toEqual(before);
});

it("recalls historical User Memory with a scoped API key and preserves token/scope checks", async()=>{
  const config={...LEGACY_TEST_CONFIG,algorithm:{...LEGACY_TEST_CONFIG.algorithm,enableUserMemoryRecall:true}};
  const {service,db,root}=fixture.createTestService({config,llm:createFailingLlm()});const repos=new Repositories(db.db);
  repos.userMemories.insert({id:"old-api",userId:"account-a",sourceTurnId:"old-turn",sourceTurnRefs:[],memoryTypes:["User Preference"],content:"python specialterm",normalizedUserTextHash:"old",status:"active",createdAt:"2026-01-01",updatedAt:"2026-01-01"});
  db.db.prepare("UPDATE user_memories SET user_id='account-a' WHERE id='old-api'").run();
  const server=createMemoryHttpServer({service,configPath:join(root,"config.yaml"),startAgentSourceAutomation:false,auth:{mode:"dev",scopedApiKeys:{
    "review-key":{namespace:{source:"codex",profileId:"default"},scopes:["memory:read"]},
    "no-read-key":{namespace:{source:"codex",profileId:"default"},scopes:[]}
  }}});
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  const address=server.address();if(!address || typeof address==="string")throw new Error("expected TCP port");
  const search=(token:string)=>fetch(`http://127.0.0.1:${address.port}/api/v1/memory/search`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},
    body:JSON.stringify({query:"python specialterm",layers:["L1"],limit:20,contextBudget:30000})});
  try {
    const allowed=await search("review-key");expect(allowed.status).toBe(200);expect(JSON.stringify(await allowed.json())).toContain("old-api");
    expect((await search("invalid-key")).status).toBe(401);
    expect((await search("no-read-key")).status).toBe(403);
  } finally {server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

it("keeps historical environment scan provenance on noop and persists an explicit profile clear",()=>{
  const {service,db}=fixture.createTestService();const repos=new Repositories(db.db);
  const opened=service.openSession({...v2("account-a"),workspaceUri:"file:///tmp/review-profile",workspaceHostId:deriveWorkspaceHostId("host")});const projectId=opened.projectId!;
  const memory=repos.l3WorldModels.upsertField({userId:"account-a",projectId,targetField:"project_environment_profile",value:"Legacy TypeScript project",projectEnvironmentAppliedScanId:"legacy-scan"})!;
  db.db.prepare("UPDATE memories SET user_id='account-a',memory_key=? WHERE id=?").run(l3WorldModelMemoryKey("account-a",projectId),memory.id);
  db.db.prepare("UPDATE l3_world_model_scopes SET user_id='account-a',scope_key=? WHERE memory_id=?").run(l3WorldModelScopeKey("account-a",projectId),memory.id);
  db.db.prepare("UPDATE l3_world_model_project_environment_state SET user_id='account-a',applied_scan_id='legacy-scan' WHERE project_id=?").run(projectId);
  db.db.prepare("DELETE FROM runtime_kv WHERE key LIKE 'l3_field_override_v1:%'").run();
  const before=repos.memories.get(memory.id);
  const context=()=>service.l3WorldModelContext(opened.sessionId,{requestId:crypto.randomUUID(),adapterId:"test",namespace:{...ns("account-b"),projectId}});
  expect(context().projectEnvironmentProfile).toBe("Legacy TypeScript project");
  const request=repos.projectEnvironments.requestScan({userId:DEVICE_MEMORY_OWNER,projectId,sessionId:opened.sessionId,trigger:"session_start",dedupeKey:"profile-review"});
  const scanId=String(request.job.payload.scanId);
  repos.projectEnvironments.applyProfile({userId:DEVICE_MEMORY_OWNER,projectId,scanId,projectKind:"code",fingerprint:"same",expectedCurrentProfile:"Legacy TypeScript project",operation:"noop",profile:""});
  expect(repos.l3WorldModels.getMemory(DEVICE_MEMORY_OWNER,projectId)).toBeUndefined();
  expect(context().projectEnvironmentProfile).toBe("Legacy TypeScript project");
  db.db.prepare("UPDATE l3_world_model_project_environment_state SET applied_scan_id='stale' WHERE user_id='account-a' AND project_id=?").run(projectId);
  expect(context().projectEnvironmentProfile).toBeNull();
  expect(repos.l3WorldModels.fields("account-b",projectId).projectEnvironmentProfile).toBeNull();
  db.db.prepare("UPDATE l3_world_model_project_environment_state SET applied_scan_id='legacy-scan' WHERE user_id='account-a' AND project_id=?").run(projectId);
  repos.l3WorldModels.upsertField({userId:"account-b",projectId,targetField:"project_environment_profile",value:null});
  expect(context().projectEnvironmentProfile).toBeNull();expect(repos.memories.get(memory.id)).toEqual(before);
});
