import {createLocalOwnerFixture} from "../../fixtures/panel-local-owners.js";
import {afterEach,describe,expect,it,vi} from "vitest";
import {MemoryDb} from "../../../src/storage/db.js";
import {PanelLogReader} from "../../../src/storage/panel-log-read.js";
import {PanelTaskReader} from "../../../src/storage/panel-task-read.js";
import {createMemoryServiceFixture} from "../../fixtures/memory-service-fixture.js";
const fixture=createMemoryServiceFixture();
afterEach(fixture.cleanup);
const ns=(userId:string)=>({userId,source:"codex",profileId:"default"});

const setup=()=>createLocalOwnerFixture(fixture);

function sources(db:MemoryDb){
  return Object.fromEntries(["sessions","episodes","raw_turns","memories","user_memories","evolution_jobs","trace_policy_links"].map(table=>[table,db.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
describe("local management reads every stored owner",()=>{
  it("shows and searches old A/B and NULL records with identical counts, preserving every source row",async()=>{
    const {db,service,turns}=await setup(),before=sources(db);
    for(const userId of ["a","b","unrelated"]){
      const request={namespace:ns(userId)};
      expect(service.panelItems({...request,layer:"UserMemory"}).items.map(row=>row.id).sort()).toEqual(["user-a","user-b","user-new"]);
      expect(service.panelItems({...request,layer:"UserMemory",q:"b-tail-needle"}).items.map(row=>row.id)).toEqual(["user-b"]);
      expect(service.panelItems({...request,layer:"L1"}).items.map(row=>row.id).sort()).toEqual(turns.map(turn=>turn.l1MemoryId).sort());
      expect(service.panelItems({...request,layer:"L1",q:"b task question"}).items.map(row=>row.id)).toContain(turns[1]!.l1MemoryId);
      expect(service.panelOverviewSummary(request).counts).toMatchObject({userMemories:3,memories:3});
      expect(service.panelAnalysis(request).dailyMemoryWrites.reduce((sum,day)=>sum+day.count,0)).toBe(3);
      expect(service.panelTaskSummaries(request).tasks.map(row=>row.id).sort()).toEqual(turns.map(turn=>turn.episodeId).sort());
      expect(service.panelTasks({...request,q:"b task question"}).tasks.map(row=>row.id)).toEqual([turns[1]!.episodeId]);
      expect(service.getPanelMemory("user-b",request).item.body).toContain("b-tail-needle");
      expect(service.getPanelMemory("user-new",request).item.body).toContain("new-tail-needle");
      expect(service.getPanelMemory(turns[1]!.l1MemoryId,request).item.id).toBe(turns[1]!.l1MemoryId);
    }
    expect(service.panelItems({layer:"UserMemory"}).total).toBe(3);
    expect(sources(db)).toEqual(before);
  });
  it("reads NULL-owner dialogue/fields and reuses fixed views and statistics across account changes",async()=>{
    const {db,service,turns}=await setup(),newest=turns[2]!;
    const before=sources(db);
    const view=await service.browsePanel({op:"create",filter:{section:"items",layer:"UserMemory"}},{namespace:ns("a")});
    if(!("viewId" in view))throw new Error("Expected a fixed panel view");
    const repeat=await service.browsePanel({op:"page",viewId:view.viewId,page:1},{namespace:ns("b")});
    expect(repeat).toMatchObject({viewId:view.viewId,total:3});
    for(const owner of ["a","b"]){
      expect(service.panelTaskDetail(newest.episodeId!,{namespace:ns(owner)}).turns[0]?.userText).toBe("new task question");
      expect(service.panelTaskField(newest.episodeId!,newest.rawTurnId,"userText",{namespace:ns(owner)}).text).toBe("new task question");
      expect(service.getPanelMemory(newest.episodeId!,{namespace:ns(owner)}).item.id).toBe(newest.episodeId);
    }
    const read=vi.spyOn(service,"readPanel");
    service.panelStatsSnapshot({namespace:ns("a")});service.panelOverviewStatsSnapshot({namespace:ns("b")});
    await vi.waitFor(()=>expect(service.panelStatsSnapshot({namespace:ns("b")}).status).toBe("ready"));
    expect(service.panelStatsSnapshot({namespace:ns("b")}).data?.overview.counts).toMatchObject({userMemories:3,memories:3});
    expect(read.mock.calls.filter(([method])=>method==="stats")).toHaveLength(1);read.mockRestore();
    expect(sources(db)).toEqual(before);
  });
  it("keeps ordinary user-memory authorization and deletion rules unchanged",async()=>{
    const {db,service,repos}=await setup(),before=sources(db);
    expect(()=>service.getMemory("user-b",{namespace:ns("a")})).toThrow("unavailable");
    expect(()=>service.deleteMemory("user-b",{namespace:ns("a")})).toThrow("different user");
    expect(repos.userMemories.listActive("a").map(row=>row.id)).toEqual(["user-a"]);
    expect(repos.userMemories.listActive("b").map(row=>row.id)).toEqual(["user-b"]);
    expect(sources(db)).toEqual(before);
  });
  it("validates source relationships by task/session IDs rather than matching stored UIDs",async()=>{
    const {db,service,repos,turns}=await setup();const turn=turns[0]!;
    db.db.prepare("UPDATE raw_turns SET user_id='different-historical-owner' WHERE id=?").run(turn.rawTurnId);
    const log=repos.runtime.insertApiLog({toolName:"memory_add",inputJson:"{}",outputJson:JSON.stringify({details:[{traceId:turn.l1MemoryId,summary:"current source"}]}),durationMs:1,success:true,calledAt:"2026-10-29T00:00:00Z"});
    expect(service.getPanelMemory(turn.l1MemoryId,{namespace:ns("b")}).refs).toMatchObject({rawTurn:{rawTurnId:turn.rawTurnId}});
    expect(service.panelTaskDetail(turn.episodeId!,{namespace:ns("b")}).turns).toHaveLength(1);
    const logs=new PanelLogReader(db.db);
    expect(logs.list({}).logs.map(row=>row.id)).toContain(log.id);
    db.db.prepare("UPDATE raw_turns SET session_id=? WHERE id=?").run(turns[1]!.sessionId,turn.rawTurnId);
    expect(logs.list({}).logs.map(row=>row.id)).not.toContain(log.id);
  });
  it("continues rejecting removed/redacted sources and invalid task relationships",async()=>{
    const {db,service,repos,turns}=await setup();
    const turn=turns[1]!;
    service.redactRawTurn(turn.rawTurnId,{mode:"redact"});
    expect(service.panelTaskDetail(turn.episodeId!,{namespace:ns("a")}).turns).toEqual([]);
    expect(()=>service.panelTaskField(turn.episodeId!,turn.rawTurnId,"userText",{namespace:ns("a")})).toThrow("unavailable");
    expect(()=>service.getPanelMemory(turn.l1MemoryId,{namespace:ns("a")})).toThrow("unavailable");
    repos.userMemories.softDelete("user-b");
    expect(service.panelItems({layer:"UserMemory",namespace:ns("a")}).items.map(row=>row.id)).not.toContain("user-b");
    expect(()=>service.getPanelMemory("user-b",{namespace:ns("a")})).toThrow();
    const other=turns[0]!,newest=turns[2]!;
    db.db.prepare("UPDATE raw_turns SET session_id=? WHERE id=?").run(other.sessionId,newest.rawTurnId);
    expect(new PanelTaskReader(db.db).turns(newest.episodeId!).turns).toEqual([]);
  });
});
