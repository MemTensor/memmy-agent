import { afterEach, describe, expect, it } from "vitest";
import type { LlmClient, LlmMessage } from "../../../src/index.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { DEVICE_MEMORY_OWNER } from "../../../src/service/namespace/memory-owner.js";
import { upsertL2Candidate } from "../../../src/service/evolution/l2-candidate-service.js";
import { assertL2RecoveryCurrent } from "../../../src/service/evolution/l2-extraction-recovery.js";
import { episodeInputRevision } from "../../../src/service/evolution/episode-revision.js";
import { byokRuntimeConfig, LEGACY_TEST_CONFIG, createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(fixture.cleanup);
const HISTORY = "preserved-history";
async function setup(withExtra = false) {
  const config = byokRuntimeConfig({algorithm:structuredClone(LEGACY_TEST_CONFIG.algorithm)});
  config.algorithm.capture.embedAfterCapture = false;
  config.algorithm.l2Induction.mode = "unified";
  config.algorithm.l2Induction.useLlm = true;
  let enabled = false;
  const calls: string[][] = [];
  let output: (ids: string[]) => Promise<Record<string, unknown>> = async ids => ({operations:[{operation:"ignore", l1_ids:ids}]});
  const llm = { config:config.evolution, isConfigured:()=>enabled,
    complete:async()=>"{}", completeJson:async(messages:LlmMessage[])=>{
      const input = JSON.parse(messages[2]!.content);
      const ids = input.L1_RECORDS.map((record:{id:string})=>record.id); calls.push(ids); return output(ids);
    }, status:()=>({provider:config.evolution.provider,model:config.evolution.model,configured:enabled,remote:false}) } as LlmClient;
  const {db,service} = fixture.createTestService({config,llm,skillLlm:llm});
  const repos = new Repositories(db.db);
  const session = service.openSession({namespace:{source:"codex",profileId:"default"}});
  const first = await service.completeTurn("history-turn", {sessionId:session.sessionId,query:"Check parser results",answer:"The first parser run failed"});
  expect(first.episodeId).toBeTruthy();
  // Preserve real pre-device rows; the next normal completeTurn keeps the new owner.
  for (const [table,id] of [["sessions",first.sessionId],["episodes",first.episodeId],["raw_turns",first.rawTurnId],["memories",first.l1MemoryId]])
    db.db.prepare(`UPDATE ${table} SET user_id=? WHERE id=?`).run(HISTORY,id);
  const second = await service.completeTurn("device-correction", {sessionId:session.sessionId,episodeId:first.episodeId,
    query:"Continue the same parser task with corrected input",answer:"The corrected input was checked"});
  expect(second.episodeId).toBe(first.episodeId);
  expect(repos.runtime.resolveL1Source(second.l1MemoryId)).toEqual({episodeId:first.episodeId,rawTurnId:second.rawTurnId});
  expect(repos.memories.get(second.l1MemoryId)?.userId).toBe(DEVICE_MEMORY_OWNER);
  const extra = withExtra ? await service.completeTurn("later-admission", {sessionId:session.sessionId,episodeId:first.episodeId,
    query:"Verify an additional parser case",answer:"The additional case was verified"}) : undefined;
  repos.runtime.closeEpisode(first.episodeId!, {closeReason:"finalized"});
  // This fixture isolates recovery from the ordinary capture queue, using real persisted turns/L1s.
  db.db.prepare("DELETE FROM evolution_jobs").run();
  for (const turn of [first,second]) {
    const memory = repos.memories.get(turn.l1MemoryId)!;
    expect(upsertL2Candidate(repos,{sourceMemoryId:memory.id,userId:memory.userId,episodeId:first.episodeId,route:"negative"})).not.toBeNull();
  }
  enabled = true;
  return {service,db,repos,first,second,extra,calls,episodeId:first.episodeId!,setOutput:(fn:typeof output)=>{output=fn;}};
}
function queued(h: Awaited<ReturnType<typeof setup>>) {
  return h.repos.runtime.listJobs("queued",-1).filter(job=>job.jobType==="l2_induction");
}
async function drain(h: Awaited<ReturnType<typeof setup>>) {
  for (let i=0;i<10 && queued(h).length;i++) await h.service.runWorkerOnce(10);
}
describe("v1.2.8 recovery of historical tasks with device-owned corrections",()=>{
  it("reads both owners' real candidates without mutating either snapshot",async()=>{
    const h=await setup();
    const before=h.db.db.prepare("SELECT * FROM l2_candidate_pool ORDER BY id").all();
    expect(h.service.taskExperienceProcessing(h.episodeId)).toMatchObject({state:"pending",pendingCount:2,canRetry:true});
    expect(h.db.db.prepare("SELECT * FROM l2_candidate_pool ORDER BY id").all()).toEqual(before);
    expect(queued(h)).toEqual([]); expect(h.calls).toEqual([]);
  });
  it("queues one batch per proven owner, coalesces repeated retries and processes both exactly once",async()=>{
    const h=await setup();
    const result=h.service.retryTaskExperienceProcessing(h.episodeId);
    const duplicate=h.service.retryTaskExperienceProcessing(h.episodeId);
    expect(result).toMatchObject({accepted:true,state:"queued",pendingCount:2});
    expect(duplicate).toMatchObject({accepted:false,jobId:result.jobId});
    expect(queued(h).map(job=>job.userId).sort()).toEqual([DEVICE_MEMORY_OWNER,HISTORY].sort());
    for (const job of queued(h)) expect(()=>assertL2RecoveryCurrent(h.repos,job)).not.toThrow();
    await drain(h);
    expect(h.service.taskExperienceProcessing(h.episodeId)).toMatchObject({state:"complete",pendingCount:0});
    expect(h.calls.flat().sort()).toEqual([h.first.l1MemoryId,h.second.l1MemoryId].sort());
    expect(h.service.retryTaskExperienceProcessing(h.episodeId).accepted).toBe(false);
    expect(h.repos.runtime.getEpisode(h.episodeId)?.userId).toBe(HISTORY);
    expect(h.repos.memories.get(h.first.l1MemoryId)?.userId).toBe(HISTORY);
  });
  it("does not report complete when only the device-owned batch failed",async()=>{
    const h=await setup();
    h.db.db.prepare("UPDATE l2_candidate_pool SET status='promoted' WHERE user_id=?").run(HISTORY);
    const at=new Date().toISOString();
    h.repos.runtime.enqueueJob({id:"device-failed",jobType:"l2_induction",userId:DEVICE_MEMORY_OWNER,episodeId:h.episodeId,
      sessionId:h.second.sessionId,targetMemoryId:h.second.l1MemoryId,payload:{unified:true},status:"dead_letter",attempts:1,maxAttempts:1,
      lastError:"l2 extraction: model correction budget exhausted",createdAt:at,updatedAt:at});
    expect(h.service.taskExperienceProcessing(h.episodeId)).toMatchObject({state:"failed",pendingCount:1,canRetry:true,jobId:"device-failed"});
    const result=h.service.retryTaskExperienceProcessing(h.episodeId);
    expect(result).toMatchObject({accepted:true,pendingCount:1});
    await drain(h);
    expect(h.calls.flat()).toEqual([h.second.l1MemoryId]);
  });
  it("rejects reopened or replaced sources before the recovery model can commit",async()=>{
    const h=await setup(); h.service.retryTaskExperienceProcessing(h.episodeId);
    const base = queued(h)[0]!;
    const job = {...base, userId:DEVICE_MEMORY_OWNER, targetMemoryId:h.second.l1MemoryId,
      payload:{...base.payload,sourceMemoryId:h.second.l1MemoryId,l2RecoverySourceIds:[h.second.l1MemoryId]}};
    expect(()=>assertL2RecoveryCurrent(h.repos,job)).not.toThrow();
    h.repos.runtime.reopenEpisode(h.episodeId);
    expect(()=>assertL2RecoveryCurrent(h.repos,job)).toThrow(/task changed/);
    h.repos.runtime.closeEpisode(h.episodeId,{closeReason:"finalized"});
    expect(()=>assertL2RecoveryCurrent(h.repos,{...job,payload:{...job.payload,l2RecoveryRevision:episodeInputRevision(h.repos,h.episodeId,true)},targetMemoryId:h.first.l1MemoryId})).toThrow(/task changed/);
    expect(h.calls).toEqual([]);
  });
  it("accepts current raw provenance across a preserved owner but rejects a missing declared raw turn",async()=>{
    const h=await setup();
    h.db.db.prepare("UPDATE raw_turns SET user_id=? WHERE id=?").run(HISTORY,h.second.rawTurnId);
    expect(h.repos.runtime.resolveL1Source(h.second.l1MemoryId)).toEqual({episodeId:h.episodeId,rawTurnId:h.second.rawTurnId});
    expect(upsertL2Candidate(h.repos,{sourceMemoryId:h.second.l1MemoryId,userId:DEVICE_MEMORY_OWNER,route:"negative"})).not.toBeNull();
    h.db.db.prepare("DELETE FROM raw_turns WHERE id=?").run(h.second.rawTurnId);
    expect(upsertL2Candidate(h.repos,{sourceMemoryId:h.second.l1MemoryId,userId:DEVICE_MEMORY_OWNER,route:"negative"})).toBeNull();
  });

  it("does not consume a source-free device candidate merely claiming the historical task",async()=>{
    const h=await setup();
    const fake=structuredClone(h.repos.memories.get(h.second.l1MemoryId)!);
    fake.id="unproven-device-source";
    delete fake.info.raw_turn_id;
    delete fake.properties.internal_info.source_raw_turn_id;
    delete fake.properties.internal_info.raw_turn_id;
    delete (fake.properties.internal_info.trace as Record<string,unknown>).raw_turn_id;
    // Preserve the legacy candidate admission path, but it cannot prove a cross-owner task source.
    h.repos.memories.insert(fake);
    const ids=[...h.repos.runtime.getEpisode(h.episodeId)!.l1MemoryIds,fake.id];
    h.db.db.prepare("UPDATE episodes SET l1_memory_ids_json=? WHERE id=?").run(JSON.stringify(ids),h.episodeId);
    expect(upsertL2Candidate(h.repos,{sourceMemoryId:fake.id,userId:DEVICE_MEMORY_OWNER,route:"negative"})).not.toBeNull();
    const before=h.db.db.prepare("SELECT * FROM l2_candidate_pool WHERE source_memory_id=?").get(fake.id);
    expect(h.service.taskExperienceProcessing(h.episodeId)).toMatchObject({state:"pending",pendingCount:2});
    h.service.retryTaskExperienceProcessing(h.episodeId);
    expect(queued(h).flatMap(job=>job.payload.l2RecoverySourceIds)).not.toContain(fake.id);
    await drain(h);
    expect(h.calls.flat().sort()).toEqual([h.first.l1MemoryId,h.second.l1MemoryId].sort());
    expect(h.db.db.prepare("SELECT * FROM l2_candidate_pool WHERE source_memory_id=?").get(fake.id)).toEqual(before);
    expect(h.service.taskExperienceProcessing(h.episodeId)).toMatchObject({state:"complete",pendingCount:0});
  });
  it("does not expand a manual batch to evidence admitted while its model is running",async()=>{
    const h=await setup(true);
    const extra=h.extra!;
    let admitted=false;
    h.setOutput(async ids=>{
      if (!admitted) {
        admitted=true;
        expect(upsertL2Candidate(h.repos,{sourceMemoryId:extra.l1MemoryId,userId:DEVICE_MEMORY_OWNER,route:"negative"})).not.toBeNull();
      }
      return {operations:[{operation:"ignore",l1_ids:ids}]};
    });
    h.service.retryTaskExperienceProcessing(h.episodeId);
    await drain(h);
    expect(h.calls.flat().sort()).toEqual([h.first.l1MemoryId,h.second.l1MemoryId].sort());
    expect(queued(h)).toEqual([]);
    expect(h.service.taskExperienceProcessing(h.episodeId)).toMatchObject({state:"pending",pendingCount:1,canRetry:true});
    // Admission normally owns its automatic job; an explicitly requested later retry may also recover it.
    expect(h.service.retryTaskExperienceProcessing(h.episodeId).accepted).toBe(true);
    await drain(h);
    expect(h.calls.flat().filter(id=>id===extra.l1MemoryId)).toHaveLength(1);
    expect(h.service.taskExperienceProcessing(h.episodeId)).toMatchObject({state:"complete",pendingCount:0});
  });
  it("retains pending evidence when the task reopens during the actual worker model call",async()=>{
    const h=await setup();
    h.setOutput(async ids=>{
      h.repos.runtime.reopenEpisode(h.episodeId);
      return {operations:[{operation:"ignore",l1_ids:ids}]};
    });
    h.service.retryTaskExperienceProcessing(h.episodeId);
    await drain(h);
    expect(h.calls).toHaveLength(1);
    expect(h.service.taskExperienceProcessing(h.episodeId)).toMatchObject({state:"blocked",pendingCount:2,canRetry:false});
    expect(h.db.db.prepare("SELECT DISTINCT status FROM l2_candidate_pool").all()).toEqual([{status:"pending"}]);
  });

  it("keeps a late signal pending and observable instead of accepting the stale model decision",async()=>{
    const h=await setup();
    let lateSource="";
    h.setOutput(async ids=>{
      if (!lateSource) {
        lateSource=ids[0]!;
        const source=h.repos.memories.get(lateSource)!;
        upsertL2Candidate(h.repos,{sourceMemoryId:source.id,userId:source.userId,route:"negative",
          signal:{eventId:"late-observed-failure",route:"negative",text:"A later check found the original failure was still present"}});
      }
      return {operations:[{operation:"ignore",l1_ids:ids}]};
    });
    h.service.retryTaskExperienceProcessing(h.episodeId);
    await drain(h);
    const source=h.repos.memories.get(lateSource)!;
    const remaining=h.repos.runtime.listUnifiedL2Candidates({userId:source.userId,episodeId:h.episodeId});
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.evidence).toMatchObject({signals:[expect.objectContaining({eventId:"late-observed-failure"})]});
    const state=h.service.taskExperienceProcessing(h.episodeId);
    expect(state.pendingCount).toBe(1);
    expect(state.state).not.toBe("complete");
    expect(h.repos.runtime.listJobs("queued",-1).some(job=>job.payload.reason==="unified_candidates_arrived_during_extraction")).toBe(false);
  });

});
