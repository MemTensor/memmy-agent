import {afterEach,expect,it} from "vitest";
import {join} from "node:path";
import {createMemoryServiceFixture} from "../../fixtures/memory-service-fixture.js";
import {MemoryDb} from "../../../src/storage/db.js";
import type {SessionTurnService} from "../../../src/service/session/session-turn-service.js";
import {Repositories} from "../../../src/storage/repositories.js";
const f=createMemoryServiceFixture();afterEach(f.cleanup);
for(const legacy of [false,true])for(const restart of [false,true])for(const observedBeforeUpgrade of [true,false]){
 it(`legacy=${legacy} restart=${restart} observedBeforeUpgrade=${observedBeforeUpgrade}`,async()=>{
  const x=f.createTestService();let {service,db}=x;
  const opened=service.openSession({namespace:{userId:"old-account",source:"codex",profileId:"default",sessionKey:"pending-rebind"}});
  const sid=opened.sessionId;
  const first=await service.completeTurn("old-seed",{sessionId:sid,episodeId:"old-episode",query:"Configure nginx TLS",answer:"Use port 443."});
  let rawId:string|undefined;
  const observe=async()=>{const r=await service.observeTool({sessionId:sid,turnId:"pending",toolCallId:"call-plan",toolName:"read_file",args:{path:"plan.md"}});rawId=r.rawTurnId;};
  if(observedBeforeUpgrade)await observe();
  if(legacy){
   // Restore old storage only in the isolated fixture, before the new service task is created.
   db.db.prepare("UPDATE sessions SET user_id='old-account' WHERE id=?").run(sid);
   db.db.prepare("UPDATE episodes SET user_id='old-account' WHERE session_id=?").run(sid);
   db.db.prepare("UPDATE raw_turns SET user_id='old-account' WHERE session_id=?").run(sid);
   db.db.prepare("UPDATE memories SET user_id='old-account' WHERE session_id=?").run(sid);
  }
  if(!observedBeforeUpgrade)await observe();
  const target=await service.completeTurn("new-seed",{sessionId:sid,episodeId:"new-episode",query:"Summarize hiring plan",answer:"The plan is summarized."});
  let repos=new Repositories(db.db);
  expect(repos.runtime.getEpisode(first.episodeId!)?.sessionId).toBe(sid);
  expect(repos.runtime.getEpisode(target.episodeId!)?.sessionId).toBe(sid);
  const request={sessionId:sid,episodeId:target.episodeId,query:"Summarize hiring plan details",answer:"The remaining details are summarized."};
  if(restart){await service.stop();db.close();db=new MemoryDb({path:join(x.root,"memory.sqlite")});service=f.createTestMemoryService({db,mode:"dev"});repos=new Repositories(db.db);}
  const rawOwner = repos.runtime.getRawTurn(rawId!)!.userId;
  const completed = await service.completeTurn("pending", request);
  expect(completed.rawTurnId).toBe(rawId);expect(repos.runtime.getRawTurn(rawId!)?.episodeId).toBe("new-episode");
  expect(repos.runtime.getRawTurn(rawId!)?.assistantText).toBe(request.answer);
  expect(repos.runtime.getRawTurn(rawId!)?.userId).toBe(rawOwner);
  expect(await service.completeTurn("pending",request)).toMatchObject({duplicate:true,rawTurnId:rawId});
 });
}

it.each([false,true])("reassigns a completed text-only legacy turn through the assignment finalizer (restart=%s)", async restart => {
 const x=f.createTestService();let {db,service}=x;
 let repos=new Repositories(db.db);
 const {sessionId}=service.openSession({namespace:{source:"codex",profileId:"default",sessionKey:"text-only"}});
 const first=await service.completeTurn("text",{sessionId,episodeId:"episode_old_text",query:"Question without tools",answer:"Answer without tools"});
 db.db.prepare("UPDATE sessions SET user_id='legacy' WHERE id=?").run(sessionId);
 db.db.prepare("UPDATE episodes SET user_id='legacy' WHERE id=?").run(first.episodeId);
 db.db.prepare("UPDATE raw_turns SET user_id='legacy' WHERE id=?").run(first.rawTurnId);
 db.db.prepare("UPDATE memories SET user_id='legacy' WHERE id=?").run(first.l1MemoryId);
 const target=await service.completeTurn("target",{sessionId,episodeId:"episode_new_text",query:"Another task",answer:"Done"});
 const raw=repos.runtime.getRawTurn(first.rawTurnId)!;
 expect(raw.toolCalls).toEqual([]);
 repos.runtime.updateRawTurn({...raw,messagePayload:{...raw.messagePayload,episode_assignment:{
  status:"selected",generation:"legacy-assignment",turnJudge:true,
  selection:{episodeId:target.episodeId,title:"Reclassified text",summary:"Same session"}
 }}});
 // Restore a persisted finalization job and execute its production submission transaction.
 db.db.prepare("DELETE FROM evolution_jobs").run();
 const at=new Date().toISOString();
 repos.runtime.enqueueJob({id:"job_text_migration",jobType:"episode_finalize",userId:"__memmy_device_memory__",sessionId,
  episodeId:first.episodeId,status:"queued",attempts:0,maxAttempts:3,createdAt:at,updatedAt:at,
  payload:{rawTurnId:first.rawTurnId,generation:"legacy-assignment"}});
 if(restart){await service.stop();db.close();db=new MemoryDb({path:join(x.root,"memory.sqlite")});service=f.createTestMemoryService({db,mode:"dev"});repos=new Repositories(db.db);}
 const finalizer=(service as unknown as {sessionTurns:SessionTurnService}).sessionTurns;
 finalizer.finalizeAssignment(repos.runtime.getJob("job_text_migration")!);
 expect(repos.runtime.getRawTurn(first.rawTurnId)?.messagePayload?.episode_assignment).toMatchObject({status:"assigned"});
 expect(repos.runtime.getRawTurn(first.rawTurnId)).toMatchObject({episodeId:target.episodeId,userId:"legacy",toolCalls:[]});
 expect(repos.memories.get(first.l1MemoryId)).toMatchObject({userId:"legacy",info:{episode_id:target.episodeId}});
 expect(repos.runtime.getEpisode(target.episodeId)?.l1MemoryIds).toContain(first.l1MemoryId);
});
