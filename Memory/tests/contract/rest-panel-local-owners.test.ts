import {afterEach,expect,it,vi} from "vitest";
import {createMemoryHttpServer,closeMemoryHttpServer} from "../../src/server/http.js";
import {createMemoryServiceFixture} from "../fixtures/memory-service-fixture.js";
import {createLocalOwnerFixture} from "../fixtures/panel-local-owners.js";
const fixture=createMemoryServiceFixture();afterEach(fixture.cleanup);
it("limits owner-independent reads to authenticated local management routes",async()=>{
  const {service,turns}=await createLocalOwnerFixture(fixture);
  const server=createMemoryHttpServer({service,configPath:"/private/tmp/panel-local-synthetic-config.json",auth:{localServiceToken:"local-panel",cloudAccessTokens:{"cloud-a":{userId:"a",source:"codex",profileId:"default"}},scopedApiKeys:{"write-only":{namespace:{userId:"a",source:"codex",profileId:"default"},scopes:["memory:write"]}}},workerStartupFallbackMs:3600000,workerPostHealthDelayMs:3600000,workerIdlePollMs:3600000,startAgentSourceAutomation:false});
  try{
    await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
    const address=server.address();if(!address||typeof address==="string")throw new Error("No listener");
    const call=async(path:string,token="local-panel",owner?:string,body?:unknown,method?:string)=>{
      const response=await fetch(`http://127.0.0.1:${address.port}/api/v1/${path}`,{method:method??(body?"POST":"GET"),headers:{authorization:"Bearer "+token,"content-type":"application/json",...(owner?{"x-memmy-user-id":owner}:{}),"x-memmy-time-zone":"UTC"},body:body?JSON.stringify(body):undefined});
      return {status:response.status,data:await response.json()};
    };
    expect((await call("panel/items?layer=UserMemory","invalid","a")).status).toBe(401);
    expect((await call("panel/memory/user-b","write-only")).status).toBe(404); // Existing scope policy remains account-bound.
    for(const owner of ["a","b"]){
      const list=await call("panel/items?layer=UserMemory","local-panel",owner);
      expect(list.status).toBe(200);expect(list.data.total).toBe(3);
      expect((await call("panel/items?layer=UserMemory&q=b-tail-needle","local-panel",owner)).data.items.map((row:{id:string})=>row.id)).toEqual(["user-b"]);
      expect((await call("panel/memory/user-b","local-panel",owner)).data.item.body).toContain("b-tail-needle");
      expect((await call("panel/task-summaries","local-panel",owner)).data.total).toBe(3);
      const turn=turns[2]!;
      expect((await call(`panel/task-details/${turn.episodeId}`,"local-panel",owner)).data.turns[0].userText).toBe("new task question");
      expect((await call(`panel/task-details/${turn.episodeId}/turns/${turn.rawTurnId}/field?field=userText`,"local-panel",owner)).data.text).toBe("new task question");
    }
    const view=(await call("panel/browse","local-panel","a",{op:"create",filter:{section:"items",layer:"UserMemory"}})).data;
    expect((await call("panel/browse","local-panel","b",{op:"page",viewId:view.viewId,page:1})).data).toMatchObject({viewId:view.viewId,total:3});
    await vi.waitFor(async()=>{
      expect((await call("panel/overview-stats","local-panel","b")).data).toMatchObject({status:"ready",data:{counts:{userMemories:3}}});
    });
    expect((await call("memory/user-b","local-panel","a")).status).toBe(200);
    expect((await call("panel/items?layer=UserMemory","cloud-a")).data.items.map((row:{id:string})=>row.id)).toEqual(["user-a"]);
    expect((await call("panel/task-summaries","cloud-a")).data.total).toBe(1);
    expect((await call("panel/memory/user-b","cloud-a")).status).toBe(404);
    expect((await call("memory/user-b","invalid","a",undefined,"DELETE")).status).toBe(401);
    expect((await call("memory/user-b","local-panel","a",undefined,"DELETE")).status).toBe(200);
    expect((await call("panel/items?layer=UserMemory","local-panel","a")).data.total).toBe(2);
  }finally{await closeMemoryHttpServer(server);}
});
