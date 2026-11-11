import {afterEach,describe,expect,it,vi} from "vitest";
import {MemoryDb} from "../../../src/storage/db.js";
import {createMemoryServiceFixture} from "../../fixtures/memory-service-fixture.js";
import {createLocalOwnerFixture} from "../../fixtures/panel-local-owners.js";

const fixture=createMemoryServiceFixture();
afterEach(fixture.cleanup);
const owner={namespace:{userId:"unrelated",source:"codex",profileId:"default"}};
function sources(db:MemoryDb){
  return Object.fromEntries(["sessions","episodes","raw_turns","memories","user_memories","evolution_jobs","trace_policy_links"].map(table=>[table,db.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

describe("management source visibility before counting and pagination",()=>{
  it.each(["redact","delete"] as const)("does not republish a %s source in lists, search, fixed pages or statistics",async mode=>{
    const {service,db,repos,turns}=await createLocalOwnerFixture(fixture),turn=turns[1]!;
    const source=repos.memories.get(turn.l1MemoryId)!;
    repos.memories.update({...source,memoryValue:source.memoryValue+" "+"x".repeat(400)+" revokeduniqueneedle"});
    expect(service.panelItems({...owner,layer:"L1",q:"revokeduniqueneedle"}).total).toBe(1);
    for(let i=0;i<50;i++)service.addMemory({content:`stable page ${i}`,source:"codex"});
    const view=await service.browsePanel({op:"create",filter:{section:"items",layer:"L1"}},owner);
    if(!("viewId" in view))throw new Error("Missing view");
    const oldMemory=repos.memories.getForDisplay(turn.l1MemoryId)!;
    service.redactRawTurn(turn.rawTurnId,{mode});
    const before=sources(db);
    await expect(service.browsePanel({op:"page",viewId:view.viewId,page:2},owner)).rejects.toThrow("expired");
    const rows=[];
    for(let page=1;page<=3;page++){
      const result=service.panelItems({...owner,layer:"L1",page});
      expect(result).toMatchObject({total:52,totalPages:3,page});
      expect(result.items).toHaveLength(page===3?12:20);
      rows.push(...result.items.map(item=>item.id));
    }
    expect(new Set(rows).size).toBe(52);expect(rows).not.toContain(turn.l1MemoryId);
    expect(service.panelItems({...owner,layer:"L1",q:"revokeduniqueneedle"}).items.map(item=>item.id)).not.toContain(turn.l1MemoryId);
    expect(service.panelItems({...owner,layer:"L1",q:"revokeduniqueneedle"}).total).toBe(0);
    const refreshed=await service.browsePanel({op:"create",filter:{section:"items",layer:"L1"}},owner);
    if(!("viewId" in refreshed) || !("total" in refreshed))throw new Error("Missing fresh view");
    expect(refreshed.total).toBe(52);
    const filtered=await service.browsePanel({op:"create",filter:{section:"items",layer:"L1",sourceAgent:"codex"}},owner);
    if(!("items" in filtered))throw new Error("Missing filtered page");
    expect(filtered.total).toBe(52);
    expect(filtered.items?.map(item=>item.id)).not.toContain(turn.l1MemoryId);
    const fixed=[];
    for(let page=1;page<=3;page++){
      const result=await service.browsePanel({op:"page",viewId:refreshed.viewId,page},owner);
      if("items" in result)fixed.push(...(result.items??[]).map(item=>item.id));
    }
    expect(new Set(fixed).size).toBe(52);expect(fixed).not.toContain(turn.l1MemoryId);
    expect(()=>service.getPanelMemory(turn.l1MemoryId,owner)).toThrow("unavailable");
    expect(service.panelOverviewSummary(owner).counts.memories).toBe(52);
    expect(service.panelAnalysis(owner).dailyMemoryWrites.reduce((sum,day)=>sum+day.count,0)).toBe(52);
    await vi.waitFor(()=>expect(service.panelStatsSnapshot(owner)).toMatchObject({status:"ready",data:{overview:{counts:{memories:52}}}}));
    expect(repos.memories.getForDisplay(turn.l1MemoryId)).toEqual(oldMemory);
    expect(repos.memories.count({memoryLayer:"L1"})).toBe(53); // Ordinary storage/recall filtering stays unchanged.
    expect(sources(db)).toEqual(before);
    const reopened=new MemoryDb({path:db.path});
    const restarted=fixture.createTestMemoryService({db:reopened,mode:"dev"});
    expect(restarted.panelItems({...owner,layer:"L1"}).total).toBe(52);
    expect(restarted.panelItems({...owner,layer:"L1"}).items.map(item=>item.id)).not.toContain(turn.l1MemoryId);
  });

  it("uses current raw state and actual session links, preserving source-free records and history",async()=>{
    const {service,db,repos,turns}=await createLocalOwnerFixture(fixture),turn=turns[0]!;
    const free=service.addMemory({content:"source-free local record",source:"codex"});
    service.panelOverviewSummary(owner); // Materialize the source pointers once.
    db.db.prepare("UPDATE raw_turns SET session_id=? WHERE id=?").run(turns[1]!.sessionId,turn.rawTurnId);
    const before=sources(db);
    expect(service.panelItems({...owner,layer:"L1"}).items.map(item=>item.id)).not.toContain(turn.l1MemoryId);
    expect(service.panelItems({...owner,layer:"L1"}).items.map(item=>item.id)).toContain(free.id);
    expect(service.panelOverviewSummary(owner).counts.memories).toBe(3);
    expect(repos.memories.getForDisplay(turn.l1MemoryId)).toBeDefined();
    expect(sources(db)).toEqual(before);
    db.db.prepare("UPDATE raw_turns SET session_id=? WHERE id=?").run(turn.sessionId,turn.rawTurnId);
    expect(service.panelItems({...owner,layer:"L1"}).items.map(item=>item.id)).toContain(turn.l1MemoryId);
  });

  it("checks source privacy by primary key without parsing source JSON in count queries",async()=>{
    const {service,db}=await createLocalOwnerFixture(fixture);
    service.panelOverviewSummary(owner);
    const prepare=vi.spyOn(db.db,"prepare");
    service.panelItems({...owner,layer:"L1"});
    const sql=prepare.mock.calls.map(([sql])=>sql).find(sql=>sql.includes("COUNT(*)") && sql.includes("panel_fact"));
    prepare.mockRestore();
    expect(sql).toBeDefined();
    expect(sql).not.toContain("json_extract");
    const plan=db.db.prepare("EXPLAIN QUERY PLAN "+sql!).all("L1") as {detail:string}[];
    expect(plan.some(row=>/SEARCH r USING INDEX sqlite_autoindex_raw_turns/.test(row.detail))).toBe(true);
    expect(plan.some(row=>row.detail.includes("SCAN r"))).toBe(false);
  });
});
