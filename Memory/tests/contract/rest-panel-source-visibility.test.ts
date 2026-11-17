import {afterEach,expect,it,vi} from "vitest";
import {createMemoryHttpServer,closeMemoryHttpServer} from "../../src/server/http.js";
import {createMemoryServiceFixture} from "../fixtures/memory-service-fixture.js";
import {createLocalOwnerFixture} from "../fixtures/panel-local-owners.js";
import {panelSafetyToken} from "../../src/storage/panel-security.js";
const fixture=createMemoryServiceFixture();afterEach(fixture.cleanup);

async function openPanel(service:Parameters<typeof createMemoryHttpServer>[0]["service"]){
  const server=createMemoryHttpServer({service,configPath:"/private/tmp/panel-source-synthetic-config.json",auth:{localServiceToken:"synthetic-panel-source"},workerStartupFallbackMs:3600000,workerPostHealthDelayMs:3600000,workerIdlePollMs:3600000,startAgentSourceAutomation:false});
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  const address=server.address();if(!address||typeof address==="string")throw new Error("Missing listener");
  const call=async(path:string,body?:unknown)=>{
    const response=await fetch(`http://127.0.0.1:${address.port}/api/v1/${path}`,{method:body?"POST":"GET",headers:{authorization:"Bearer synthetic-panel-source","content-type":"application/json","x-memmy-user-id":"unrelated","x-memmy-time-zone":"UTC"},body:body?JSON.stringify(body):undefined});
    return {status:response.status,data:await response.json()};
  };
  return {server,call};
}

it.each(["redact","delete"] as const)("never reloads a %s source through real management HTTP lists, search, pages or statistics",async mode=>{
  const {service,repos,turns}=await createLocalOwnerFixture(fixture),turn=turns[1]!;
  const source=repos.memories.get(turn.l1MemoryId)!;
  repos.memories.update({...source,memoryValue:source.memoryValue+" "+"x".repeat(400)+" hiddenhttppayloadneedle"});
  for(let i=0;i<50;i++)service.addMemory({content:`fixed HTTP source page ${i}`,source:"codex"});
  const {server,call}=await openPanel(service);
  try{
    const old=(await call("panel/browse",{op:"create",filter:{section:"items",layer:"L1"}})).data;
    expect(old.total).toBe(53);
    expect((await call("panel/items?layer=L1&q=hiddenhttppayloadneedle")).data.total).toBe(1);
    await vi.waitFor(async()=>expect((await call("panel/stats")).data).toMatchObject({status:"ready",data:{overview:{counts:{memories:53}}}}));
    const stored=repos.memories.getForDisplay(turn.l1MemoryId)!;
    service.redactRawTurn(turn.rawTurnId,{mode});
    expect((await call("panel/browse",{op:"check",viewId:old.viewId})).status).toBe(409);
    expect((await call("panel/memory/"+turn.l1MemoryId)).status).toBe(404);
    expect((await call("panel/items?layer=L1&q=hiddenhttppayloadneedle")).data).toMatchObject({total:0,items:[]});
    const fresh=(await call("panel/browse",{op:"create",filter:{section:"items",layer:"L1"}})).data;
    expect(fresh.total).toBe(52);
    const ids=[];
    for(let page=1;page<=3;page++){
      const direct=await call(`panel/items?layer=L1&page=${page}`);
      const fixed=await call("panel/browse",{op:"page",viewId:fresh.viewId,page});
      expect(direct.status).toBe(200);expect(fixed.status).toBe(200);
      expect(direct.data).toMatchObject({page,total:52,totalPages:3});
      expect(direct.data.items).toHaveLength(page===3?12:20);
      expect(fixed.data.items).toHaveLength(page===3?12:20);
      expect(direct.data.items.map((item:{id:string})=>item.id)).not.toContain(turn.l1MemoryId);
      ids.push(...fixed.data.items.map((item:{id:string})=>item.id));
    }
    expect(new Set(ids).size).toBe(52);expect(ids).not.toContain(turn.l1MemoryId);
    await vi.waitFor(async()=>expect((await call("panel/stats")).data).toMatchObject({status:"ready",data:{overview:{counts:{memories:52}}}}));
    expect(repos.memories.getForDisplay(turn.l1MemoryId)).toEqual(stored);
  }finally{await closeMemoryHttpServer(server);}
});

it("retains page 2/3 across NULL-owner first binding while still rejecting an existing binding move",async()=>{
  const {service,db,repos,turns}=await createLocalOwnerFixture(fixture),turn=turns[2]!;
  db.db.prepare("UPDATE raw_turns SET episode_id=NULL,message_payload_json=json_set(message_payload_json,'$.episode_assignment.status','pending') WHERE id=?").run(turn.rawTurnId);
  for(let i=0;i<50;i++)service.addMemory({content:`NULL-owner HTTP page ${i}`,source:"codex"});
  const {server,call}=await openPanel(service);
  try{
    const view=(await call("panel/browse",{op:"create",filter:{section:"items",layer:"L1"}})).data;
    const second=(await call("panel/browse",{op:"page",viewId:view.viewId,page:2})).data;
    const safety=panelSafetyToken(db.db);
    const episode=repos.runtime.getEpisode(turn.episodeId!)!;
    repos.runtime.bindRawTurnEpisode(turn.rawTurnId,episode.id,episode.updatedAt);
    expect(panelSafetyToken(db.db)).toBe(safety);
    expect((await call("panel/browse",{op:"check",viewId:view.viewId}))).toMatchObject({status:200,data:{viewId:view.viewId,updated:true}});
    const repeat=await call("panel/browse",{op:"page",viewId:view.viewId,page:2});
    expect(repeat).toMatchObject({status:200,data:{viewId:view.viewId,total:53,page:2,items:second.items}});
    const third=await call("panel/browse",{op:"page",viewId:view.viewId,page:3});
    expect(third).toMatchObject({status:200,data:{viewId:view.viewId,total:53,page:3}});
    expect(third.data.items).toHaveLength(13);
    const target=repos.runtime.createEpisode({...episode,id:"null-owner-rebind",l1MemoryIds:[],rawTurnIds:[],turnCount:0});
    repos.runtime.rebindRawTurnEpisode(turn.rawTurnId,episode.id,target.id);
    expect((await call("panel/browse",{op:"page",viewId:view.viewId,page:2})).status).toBe(409);
  }finally{await closeMemoryHttpServer(server);}
});
