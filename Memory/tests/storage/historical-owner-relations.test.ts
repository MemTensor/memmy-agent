import {afterEach,expect,it} from "vitest";
import {createMemoryServiceFixture} from "../fixtures/memory-service-fixture.js";
import {makeTraceEligibleForL2} from "../fixtures/evolution-fixture.js";
import {traceMetaFromMemory} from "../../src/algorithm/plugin-algorithms.js";
import {Repositories} from "../../src/storage/repositories.js";
import type {PolicyInductionEngine} from "../../src/service/evolution/policy-induction.js";
import { join } from "node:path";
import { MemoryDb } from "../../src/storage/db.js";
import { DEVICE_MEMORY_OWNER } from "../../src/service/namespace/memory-owner.js";
import { maintainMemoryRelations } from "../../src/storage/memory-relations.js";
import type { MemoryRow } from "../../src/types.js";
const f=createMemoryServiceFixture();afterEach(f.cleanup);
async function setup(legacy:boolean){
 const x=f.createTestService();const repos=new Repositories(x.db.db);
 const {sessionId}=x.service.openSession({namespace:{source:"codex",profileId:"default",sessionKey:"owner-audit"}});
 const saved=await x.service.completeTurn("seed",{sessionId,query:"Run tests before committing code",answer:"Tests passed and verified."});
 if(legacy){
  x.db.db.prepare("UPDATE sessions SET user_id='legacy' WHERE id=?").run(sessionId);
  x.db.db.prepare("UPDATE episodes SET user_id='legacy' WHERE id=?").run(saved.episodeId);
  x.db.db.prepare("UPDATE raw_turns SET user_id='legacy' WHERE id=?").run(saved.rawTurnId);
  x.db.db.prepare("UPDATE memories SET user_id='legacy' WHERE id=?").run(saved.l1MemoryId);
 }
 return {...x,repos,saved,sessionId};
}

type Fixture = Awaited<ReturnType<typeof setup>>;
function eligible(x: Fixture): boolean {
  const trace = traceMetaFromMemory(x.repos.memories.get(x.saved.l1MemoryId)!)!;
  const engine = (x.service as unknown as {evolutionJobs:{policy:PolicyInductionEngine}}).evolutionJobs.policy;
  return engine.isTraceEligibleForL2(trace);
}
function insertPolicy(x: Fixture, ids = [x.saved.l1MemoryId]) {
  const trace = x.repos.memories.get(x.saved.l1MemoryId)!;
  return x.repos.memories.insert({...trace, id:"owner-policy", memoryKey:"owner-policy", memoryLayer:"L2",
    properties:{internal_info:{memory_layer:"L2", source_trace_ids:ids, policy:{source_trace_ids:ids}}}});
}
function insertSpan(x: Fixture, parentOnly = false, patch: Partial<MemoryRow> = {}) {
  const trace = x.repos.memories.get(x.saved.l1MemoryId)!;
  return x.repos.memories.insert({...trace, id:"owner-span", memoryKey:"owner-span",
    info: {episode_id:x.saved.episodeId, ...(parentOnly ? {} : {raw_turn_id:x.saved.rawTurnId})},
    properties:{internal_info:{memory_layer:"L1",memory_kind:"span",
      span:{episode_id:x.saved.episodeId,source_trace_id:trace.id,...(parentOnly?{}:{raw_turn_id:x.saved.rawTurnId})}}}, ...patch});
}
async function restart(x: Fixture) {
  await x.service.stop(); x.db.close();
  x.db = new MemoryDb({path:join(x.root,"memory.sqlite")});
  x.service = f.createTestMemoryService({db:x.db,mode:"dev"});
  x.repos = new Repositories(x.db.db);
}
function unchangedSources(x: Fixture) {
  const raw = x.repos.runtime.getRawTurn(x.saved.rawTurnId)!;
  const { captured_memory_ids: _inverse, ...payload } = raw.messagePayload ?? {};
  return {
    session:x.repos.runtime.getSession(x.sessionId),
    raw:{...raw,messagePayload:payload},
    episodeOwner:x.repos.runtime.getEpisode(x.saved.episodeId!)?.userId,
    trace:x.repos.memories.get(x.saved.l1MemoryId)
  };
}
for (const legacy of [false,true]) for (const reopen of [false,true]) {
  it(`qualifies device Trace from preserved RawTurn (legacy=${legacy}, restart=${reopen})`,async()=>{
    const x=await setup(legacy);
    makeTraceEligibleForL2(x.db,x.saved.l1MemoryId);
    x.db.db.prepare("UPDATE memories SET user_id=? WHERE id=?").run(DEVICE_MEMORY_OWNER,x.saved.l1MemoryId);
    const before=unchangedSources(x);
    if(reopen) await restart(x);
    expect(eligible(x)).toBe(true);
    expect(unchangedSources(x)).toEqual(before);
  });
  it(`links device Policy to historical Trace and task (legacy=${legacy}, restart=${reopen})`,async()=>{
    const x=await setup(legacy), before=unchangedSources(x);
    const policy=insertPolicy(x);
    if(reopen) await restart(x);
    expect(policy.userId).toBe(DEVICE_MEMORY_OWNER);
    expect(x.repos.runtime.listTracePolicyLinks({l2MemoryId:policy.id}).map(l=>l.l1MemoryId)).toEqual([x.saved.l1MemoryId]);
    expect(x.repos.runtime.getEpisode(x.saved.episodeId!)?.l2PolicyIds).toContain(policy.id);
    expect(x.service.getMemory(x.saved.episodeId!).item.sourceMemoryIds).toContain(policy.id);
    maintainMemoryRelations(x.db.db,policy.id);
    expect(x.repos.runtime.listTracePolicyLinks({l2MemoryId:policy.id})).toHaveLength(1);
    expect(unchangedSources(x)).toEqual(before);
  });
  for (const parentOnly of [false,true]) it(`attaches device Span to historical source task (legacy=${legacy}, restart=${reopen}, parentOnly=${parentOnly})`,async()=>{
    const x=await setup(legacy), before=unchangedSources(x);
    const span=insertSpan(x,parentOnly);
    if(reopen) await restart(x);
    expect(span.userId).toBe(DEVICE_MEMORY_OWNER);
    expect(x.repos.runtime.getEpisode(x.saved.episodeId!)?.l1MemoryIds).toContain(span.id);
    expect(x.service.getMemory(x.saved.episodeId!).item.sourceMemoryIds).toContain(span.id);
    maintainMemoryRelations(x.db.db,span.id);
    expect(x.repos.runtime.getEpisode(x.saved.episodeId!)?.l1MemoryIds.filter(id=>id===span.id)).toHaveLength(1);
    expect(unchangedSources(x)).toEqual(before);
  });
}

it.each(["missing-raw","deleted-raw","redacted-raw","raw-session","trace-session","episode-session","missing-episode","conflicting-raw","conflicting-episode"])(
  "rejects inconsistent %s evidence for qualification, policy links and Span membership",async invalid=>{
    const x=await setup(true);
    makeTraceEligibleForL2(x.db,x.saved.l1MemoryId);
    x.db.db.prepare("UPDATE memories SET user_id=? WHERE id=?").run(DEVICE_MEMORY_OWNER,x.saved.l1MemoryId);
    const foreign=x.service.openSession({namespace:{source:"codex",profileId:"default",sessionKey:"foreign"}}).sessionId;
    if(invalid==="missing-raw")x.db.db.prepare("DELETE FROM raw_turns WHERE id=?").run(x.saved.rawTurnId);
    if(invalid==="deleted-raw" || invalid==="redacted-raw")x.db.db.prepare(`UPDATE raw_turns SET ${invalid==="deleted-raw"?"deleted_at":"redacted_at"}='now' WHERE id=?`).run(x.saved.rawTurnId);
    if(invalid==="raw-session")x.db.db.prepare("UPDATE raw_turns SET session_id=? WHERE id=?").run(foreign,x.saved.rawTurnId);
    if(invalid==="trace-session")x.db.db.prepare("UPDATE memories SET session_id=? WHERE id=?").run(foreign,x.saved.l1MemoryId);
    if(invalid==="episode-session")x.db.db.prepare("UPDATE episodes SET session_id=? WHERE id=?").run(foreign,x.saved.episodeId);
    if(invalid==="missing-episode")x.db.db.prepare("DELETE FROM episodes WHERE id=?").run(x.saved.episodeId);
    if(invalid==="conflicting-raw")x.db.db.prepare("UPDATE memories SET properties_json=json_set(properties_json,'$.internal_info.source_raw_turn_id','forged') WHERE id=?").run(x.saved.l1MemoryId);
    if(invalid==="conflicting-episode")x.db.db.prepare("UPDATE memories SET info_json=json_set(info_json,'$.episode_id','forged') WHERE id=?").run(x.saved.l1MemoryId);
    expect(eligible(x)).toBe(false);
    const policy=insertPolicy(x), span=insertSpan(x,true);
    expect(x.repos.runtime.listTracePolicyLinks({l2MemoryId:policy.id})).toEqual([]);
    expect(x.repos.runtime.getEpisode(x.saved.episodeId!)?.l1MemoryIds ?? []).not.toContain(span.id);
    expect(x.repos.runtime.getEpisode(x.saved.episodeId!)?.l2PolicyIds ?? []).not.toContain(policy.id);
  });

it.each(["missing","deleted","wrong-layer","self","conflicting-raw","conflicting-episode","foreign-session"])(
  "does not attach a Span with %s parent provenance",async invalid=>{
    const x=await setup(true), trace=x.repos.memories.get(x.saved.l1MemoryId)!;
    const foreign=x.service.openSession({namespace:{source:"codex",profileId:"default",sessionKey:"foreign-span"}}).sessionId;
    const span=insertSpan(x,true,{sessionId:invalid==="foreign-session"?foreign:trace.sessionId,
      info:{episode_id:x.saved.episodeId},properties:{internal_info:{memory_layer:"L1",memory_kind:"span",span:{
        episode_id:invalid==="conflicting-episode"?"forged":x.saved.episodeId,
        source_trace_id:invalid==="missing"?"missing":invalid==="self"?"owner-span":trace.id,
        ...(invalid==="conflicting-raw"?{raw_turn_id:"forged"}:{})}}}});
    // Recheck ordinary maintenance after the parent becomes unavailable.
    x.db.db.prepare("UPDATE episodes SET l1_memory_ids_json=json_array(?) WHERE id=?").run(trace.id,x.saved.episodeId);
    if(invalid==="deleted")x.db.db.prepare("UPDATE memories SET deleted_at='now' WHERE id=?").run(trace.id);
    if(invalid==="wrong-layer")x.db.db.prepare("UPDATE memories SET memory_layer='L2' WHERE id=?").run(trace.id);
    maintainMemoryRelations(x.db.db,span.id);
    expect(x.repos.runtime.getEpisode(x.saved.episodeId!)?.l1MemoryIds).not.toContain(span.id);
  });

it("keeps legitimate policy evidence from different sessions and ignores deleted/missing traces",async()=>{
  const x=await setup(true);
  const second=x.service.openSession({namespace:{source:"codex",profileId:"default",sessionKey:"second-evidence"}});
  const next=await x.service.completeTurn("second-turn",{sessionId:second.sessionId,query:"Run tests",answer:"Tests passed"});
  const trace=x.repos.memories.get(x.saved.l1MemoryId)!;
  x.repos.memories.insert({...trace,id:"deleted-trace",memoryKey:"deleted-trace"});
  x.db.db.prepare("UPDATE memories SET deleted_at='now' WHERE id='deleted-trace'").run();
  const policy=insertPolicy(x,[trace.id,next.l1MemoryId,"deleted-trace","missing",trace.id]);
  expect(x.repos.runtime.listTracePolicyLinks({l2MemoryId:policy.id}).map(l=>l.l1MemoryId).sort()).toEqual([trace.id,next.l1MemoryId].sort());
  for(const episode of [x.saved.episodeId,next.episodeId])expect(x.repos.runtime.getEpisode(episode!)?.l2PolicyIds).toContain(policy.id);
});

it.each(["provisional","disputed","disabled","low-value","no-vector"])("retains %s qualification gate",async gate=>{
  const x=await setup(true);
  makeTraceEligibleForL2(x.db,x.saved.l1MemoryId);
  x.db.db.prepare("UPDATE memories SET user_id=? WHERE id=?").run(DEVICE_MEMORY_OWNER,x.saved.l1MemoryId);
  expect(eligible(x)).toBe(true);
  if(gate==="provisional" || gate==="disputed")x.db.db.prepare("UPDATE memories SET properties_json=json_set(properties_json,'$.internal_info.evidence_status',?) WHERE id=?").run(gate,x.saved.l1MemoryId);
  if(gate==="disabled")x.db.db.prepare("UPDATE memories SET properties_json=json_set(properties_json,'$.internal_info.policy_eligible',json('false')) WHERE id=?").run(x.saved.l1MemoryId);
  if(gate==="low-value")x.db.db.prepare("UPDATE memories SET properties_json=json_set(properties_json,'$.internal_info.trace.value',-1) WHERE id=?").run(x.saved.l1MemoryId);
  if(gate==="no-vector"){x.repos.memories.deleteVector(x.saved.l1MemoryId,"vec_summary");x.repos.memories.deleteVector(x.saved.l1MemoryId,"vec_action");}
  expect(eligible(x)).toBe(false);
});

it("rejects a captured Trace snapshot after its persisted raw source changes", async () => {
  const x=await setup(true);
  makeTraceEligibleForL2(x.db,x.saved.l1MemoryId);
  const snapshot=traceMetaFromMemory(x.repos.memories.get(x.saved.l1MemoryId)!)!;
  const next=await x.service.completeTurn("replacement-source",{sessionId:x.sessionId,episodeId:x.saved.episodeId,query:"Other evidence",answer:"Done"});
  x.db.db.prepare("UPDATE memories SET info_json=json_set(info_json,'$.raw_turn_id',?),properties_json=json_set(properties_json,'$.internal_info.trace.raw_turn_id',?,'$.internal_info.source_raw_turn_id',?,'$.internal_info.raw_turn_id',?) WHERE id=?")
    .run(next.rawTurnId,next.rawTurnId,next.rawTurnId,next.rawTurnId,x.saved.l1MemoryId);
  const engine=(x.service as unknown as {evolutionJobs:{policy:PolicyInductionEngine}}).evolutionJobs.policy;
  expect(engine.isTraceEligibleForL2(snapshot)).toBe(false);
  expect(eligible(x)).toBe(true);
});

it("preserves source-free legacy/manual membership and policy evidence",async()=>{
  const x=await setup(true), trace=x.repos.memories.get(x.saved.l1MemoryId)!;
  const metadata=trace.properties.internal_info.trace as Record<string,unknown>;
  const manual=x.repos.memories.insert({...trace,id:"manual-trace",memoryKey:"manual-trace",info:{episode_id:x.saved.episodeId},
    properties:{internal_info:{memory_layer:"L1",memory_kind:"trace",trace:{...metadata,raw_turn_id:undefined}}}});
  expect(x.repos.runtime.getEpisode(x.saved.episodeId!)?.l1MemoryIds).toContain(manual.id);
  const policy=insertPolicy(x,[manual.id]);
  expect(x.repos.runtime.listTracePolicyLinks({l2MemoryId:policy.id}).map(l=>l.l1MemoryId)).toEqual([manual.id]);
});

it("preserves NULL-session historical L1s with a verifiable raw source",async()=>{
  const x=await setup(true), before=unchangedSources(x);
  const span=insertSpan(x,true,{sessionId:undefined});
  expect(x.repos.runtime.getEpisode(x.saved.episodeId!)?.l1MemoryIds).toContain(span.id);
  expect(x.service.getMemory(x.saved.episodeId!).item.sourceMemoryIds).toContain(span.id);
  expect(unchangedSources(x)).toEqual(before);
});

it("maintains corrected Span and Policy sources through ordinary update",async()=>{
  const x=await setup(true), trace=x.repos.memories.get(x.saved.l1MemoryId)!;
  const policy=insertPolicy(x,["missing"]);
  const span=insertSpan(x,true,{properties:{internal_info:{memory_layer:"L1",memory_kind:"span",span:{source_trace_id:"missing"}}}});
  expect(x.repos.runtime.listTracePolicyLinks({l2MemoryId:policy.id})).toEqual([]);
  expect(x.repos.runtime.getEpisode(x.saved.episodeId!)?.l1MemoryIds).not.toContain(span.id);
  x.repos.memories.update({...policy,properties:{internal_info:{memory_layer:"L2",source_trace_ids:[trace.id]}}});
  x.repos.memories.update({...span,properties:{internal_info:{memory_layer:"L1",memory_kind:"span",span:{episode_id:x.saved.episodeId,source_trace_id:trace.id}}}});
  expect(x.repos.runtime.listTracePolicyLinks({l2MemoryId:policy.id}).map(l=>l.l1MemoryId)).toEqual([trace.id]);
  expect(x.service.getMemory(x.saved.episodeId!).item.sourceMemoryIds).toEqual(expect.arrayContaining([span.id,policy.id]));
});

it("maintains declared historical sources during bundle import without rewriting their UID",async()=>{
  const x=await setup(true), before=unchangedSources(x);
  const policy=insertPolicy(x),span=insertSpan(x,true);
  const tables=x.repos.runtime.exportBundleTables(true);
  const target=f.createTestService(), repos=new Repositories(target.db.db);
  repos.runtime.importBundleTables({sessions:tables.sessions,raw_turns:tables.raw_turns,
    episodes:tables.episodes!.map(row=>({...row,l1_memory_ids_json:"[]",l2_policy_ids_json:"[]"})),memories:tables.memories});
  expect(repos.runtime.listTracePolicyLinks({l2MemoryId:policy.id}).map(l=>l.l1MemoryId)).toEqual([x.saved.l1MemoryId]);
  expect(target.service.getMemory(x.saved.episodeId!).item.sourceMemoryIds).toEqual(expect.arrayContaining([span.id,policy.id,x.saved.l1MemoryId]));
  expect(repos.memories.get(x.saved.l1MemoryId)).toEqual(before.trace);
  expect(repos.runtime.getEpisode(x.saved.episodeId!)?.userId).toBe(before.episodeOwner);
  expect(repos.runtime.getRawTurn(x.saved.rawTurnId)?.userId).toBe(before.raw.userId);
  expect(repos.runtime.getSession(x.sessionId)?.userId).toBe(before.session?.userId);
});

it("uses a valid parent Trace when a legacy Span's direct raw reference is empty",async()=>{
  const x=await setup(true);
  const span=insertSpan(x,true,{info:{raw_turn_id:"",episode_id:x.saved.episodeId}});
  expect(x.repos.runtime.getEpisode(x.saved.episodeId!)?.l1MemoryIds).toContain(span.id);
  expect(x.service.getMemory(x.saved.episodeId!).item.sourceMemoryIds).toContain(span.id);
});
