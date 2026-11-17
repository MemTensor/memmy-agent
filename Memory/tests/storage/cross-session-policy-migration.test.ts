import {afterEach,expect,it} from "vitest";
import {join} from "node:path";
import {createMemoryServiceFixture} from "../fixtures/memory-service-fixture.js";
import {MemoryDb} from "../../src/storage/db.js";
import {Repositories} from "../../src/storage/repositories.js";
import type {SessionTurnService} from "../../src/service/session/session-turn-service.js";
const f=createMemoryServiceFixture();afterEach(f.cleanup);
for(const entry of ["direct","binding","finalizer"] as const)for(const crossCreator of [false,true])for(const restart of [false,true]){
 it(`${entry} crossCreator=${crossCreator} restart=${restart}`,async()=>{
  const x=f.createTestService();let {db,service}=x;let repos=new Repositories(db.db);
  const a=service.openSession({namespace:{source:"codex",profileId:"default",sessionKey:"A"}}).sessionId;
  const b=service.openSession({namespace:{source:"codex",profileId:"default",sessionKey:"B"}}).sessionId;
  const tA=await service.completeTurn("A1",{sessionId:a,episodeId:"episode_A",query:"Run tests before committing",answer:"Tests passed"});
  const tB=await service.completeTurn("B1",{sessionId:b,episodeId:"episode_B_old",query:"Run tests before committing",answer:"Tests passed"});
  // Historical fixture only: production must retain these values.
  for(const [session,turn,owner] of [[a,tA,"legacy-A"],[b,tB,"legacy-B"]] as const){
   db.db.prepare("UPDATE sessions SET user_id=? WHERE id=?").run(owner,session);
   db.db.prepare("UPDATE episodes SET user_id=? WHERE id=?").run(owner,turn.episodeId);
   db.db.prepare("UPDATE raw_turns SET user_id=? WHERE id=?").run(owner,turn.rawTurnId);
   db.db.prepare("UPDATE memories SET user_id=? WHERE id=?").run(owner,turn.l1MemoryId);
  }
  const next=await service.completeTurn("B2",{sessionId:b,episodeId:"episode_B_new",query:"Another task",answer:"Done"});
  const creator=repos.memories.get(crossCreator?tA.l1MemoryId:tB.l1MemoryId)!;
  const policy=repos.memories.insert({...creator,id:"audit-policy",memoryKey:"audit-policy",memoryLayer:"L2",info:{},
   properties:{internal_info:{memory_layer:"L2",source_trace_ids:[tA.l1MemoryId,tB.l1MemoryId],policy:{source_trace_ids:[tA.l1MemoryId,tB.l1MemoryId]}}}});
  db.db.prepare("UPDATE memories SET user_id='legacy-policy' WHERE id=?").run(policy.id);
  const links=repos.runtime.listTracePolicyLinks({l2MemoryId:policy.id});
  expect(links.map(l=>l.l1MemoryId).sort()).toEqual([tA.l1MemoryId,tB.l1MemoryId].sort());
  for(const id of [tA.episodeId,tB.episodeId]){
   expect(repos.runtime.getEpisode(id!)?.l2PolicyIds).toContain(policy.id);
   expect(service.getMemory(id!).item.sourceMemoryIds).toContain(policy.id);
  }
  expect(repos.runtime.getEpisode(next.episodeId!)?.l2PolicyIds).not.toContain(policy.id);
  const before=repos.memories.get(policy.id)!;
  if(entry==="direct")repos.runtime.rebindRawTurnEpisode(tB.rawTurnId,tB.episodeId!,next.episodeId!);
  else if(entry==="binding")repos.runtime.bindRawTurnEpisode(tB.rawTurnId,next.episodeId!,new Date().toISOString());
  else{
   const raw=repos.runtime.getRawTurn(tB.rawTurnId)!;
   repos.runtime.updateRawTurn({...raw,messagePayload:{...raw.messagePayload,episode_assignment:{status:"selected",generation:"audit-reclassify",turnJudge:true,selection:{episodeId:next.episodeId,title:"Reclassified",summary:"Same session"}}}});
   db.db.prepare("DELETE FROM evolution_jobs").run();
   const at=new Date().toISOString();
   repos.runtime.enqueueJob({id:"audit-job",jobType:"episode_finalize",userId:creator.userId,sessionId:b,episodeId:tB.episodeId,status:"queued",attempts:0,maxAttempts:3,createdAt:at,updatedAt:at,payload:{rawTurnId:tB.rawTurnId,generation:"audit-reclassify"}});
   (service as unknown as {sessionTurns:SessionTurnService}).sessionTurns.finalizeAssignment(repos.runtime.getJob("audit-job")!);
  }
  if(restart){await service.stop();db.close();db=new MemoryDb({path:join(x.root,"memory.sqlite")});service=f.createTestMemoryService({db,mode:"dev"});repos=new Repositories(db.db);}
  const actual={rawMoved:repos.runtime.getRawTurn(tB.rawTurnId)?.episodeId===next.episodeId,
   historicalRawPreserved:repos.runtime.getRawTurn(tB.rawTurnId)?.userId==="legacy-B",
   historicalTracePreserved:repos.memories.get(tB.l1MemoryId)?.userId==="legacy-B",
   l1Moved:service.getMemory(next.episodeId!).item.sourceMemoryIds.includes(tB.l1MemoryId),
   policyUnchanged:JSON.stringify(repos.memories.get(policy.id))===JSON.stringify(before),
   linksUnchanged:JSON.stringify(repos.runtime.listTracePolicyLinks({l2MemoryId:policy.id}))===JSON.stringify(links),
   otherTaskPreserved:service.getMemory(tA.episodeId!).item.sourceMemoryIds.includes(policy.id),
   policyMember:repos.runtime.getEpisode(next.episodeId!)!.l2PolicyIds.includes(policy.id),
   policyVisible:service.getMemory(next.episodeId!).item.sourceMemoryIds.includes(policy.id)};
  expect(actual).toEqual({rawMoved:true,historicalRawPreserved:true,historicalTracePreserved:true,l1Moved:true,policyUnchanged:true,linksUnchanged:true,otherTaskPreserved:true,policyMember:true,policyVisible:true});
  repos.runtime.bindRawTurnEpisode(tB.rawTurnId,next.episodeId!,new Date().toISOString());
  expect(repos.runtime.getEpisode(next.episodeId!)?.l2PolicyIds.filter(id=>id===policy.id)).toHaveLength(1);
  expect(repos.memories.get(policy.id)).toEqual(before);
 });
}

for (const entry of ["direct","binding"] as const) {
 it.each(["missing-link","undeclared","deleted-trace","deleted-policy","deleted-status","conflicting-raw","foreign-trace-session"] as const)(
  `does not migrate ${entry} policy membership with %s evidence`,async invalid=>{
   const x=f.createTestService(),repos=new Repositories(x.db.db);
   const a=x.service.openSession({namespace:{source:"codex",profileId:"default",sessionKey:"source-A"}}).sessionId;
   const b=x.service.openSession({namespace:{source:"codex",profileId:"default",sessionKey:"source-B"}}).sessionId;
   const tA=await x.service.completeTurn("A",{sessionId:a,episodeId:"episode_source_A",query:"Run tests",answer:"Done"});
   const tB=await x.service.completeTurn("B",{sessionId:b,episodeId:"episode_source_B",query:"Run tests",answer:"Done"});
   const next=await x.service.completeTurn("next",{sessionId:b,episodeId:"episode_target_B",query:"Another task",answer:"Done"});
   const creator=repos.memories.get(tA.l1MemoryId)!;
   const policy=repos.memories.insert({...creator,id:"invalid-policy",memoryKey:"invalid-policy",memoryLayer:"L2",info:{},
    properties:{internal_info:{memory_layer:"L2",source_trace_ids:[tA.l1MemoryId,tB.l1MemoryId]}}});
   expect(repos.runtime.listTracePolicyLinks({l2MemoryId:policy.id}).map(l=>l.l1MemoryId)).toContain(tB.l1MemoryId);
   if(invalid==="missing-link")x.db.db.prepare("DELETE FROM trace_policy_links WHERE l1_memory_id=? AND l2_memory_id=?").run(tB.l1MemoryId,policy.id);
   if(invalid==="undeclared")x.db.db.prepare("UPDATE memories SET properties_json=json_set(properties_json,'$.internal_info.source_trace_ids',json(?)) WHERE id=?").run(JSON.stringify([tA.l1MemoryId]),policy.id);
   if(invalid==="deleted-trace")repos.memories.softDelete(tB.l1MemoryId);
   if(invalid==="deleted-policy")repos.memories.softDelete(policy.id);
   if(invalid==="deleted-status")x.db.db.prepare("UPDATE memories SET status='deleted' WHERE id=?").run(policy.id);
   if(invalid==="conflicting-raw")x.db.db.prepare("UPDATE memories SET info_json=json_set(info_json,'$.raw_turn_id',?) WHERE id=?").run(tA.rawTurnId,tB.l1MemoryId);
   if(invalid==="foreign-trace-session")x.db.db.prepare("UPDATE memories SET session_id=? WHERE id=?").run(a,tB.l1MemoryId);
   const before=repos.memories.getIncludingDeleted(policy.id);
   const links=repos.runtime.listTracePolicyLinks({l2MemoryId:policy.id});
   if(entry==="direct")repos.runtime.rebindRawTurnEpisode(tB.rawTurnId,tB.episodeId!,next.episodeId!);
   else repos.runtime.bindRawTurnEpisode(tB.rawTurnId,next.episodeId!,new Date().toISOString());
   expect(repos.runtime.getRawTurn(tB.rawTurnId)?.episodeId).toBe(next.episodeId);
   expect(repos.runtime.getEpisode(next.episodeId!)?.l2PolicyIds).not.toContain(policy.id);
   expect(x.service.getMemory(next.episodeId!).item.sourceMemoryIds).not.toContain(policy.id);
   expect(repos.memories.getIncludingDeleted(policy.id)).toEqual(before);
   expect(repos.runtime.listTracePolicyLinks({l2MemoryId:policy.id})).toEqual(links);
  }
 );
}
