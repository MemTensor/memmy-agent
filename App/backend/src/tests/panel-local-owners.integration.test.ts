import Fastify from "fastify";
import {afterEach,expect,it,vi} from "vitest";
import {createMemoryHttpServer,closeMemoryHttpServer} from "../../../../Memory/src/server/http.js";
import {createMemoryServiceFixture} from "../../../../Memory/tests/fixtures/memory-service-fixture.js";
import {createLocalOwnerFixture} from "../../../../Memory/tests/fixtures/panel-local-owners.js";
import {createHttpMemoryClient} from "../adapters/outbound/memory-client/http-memory-client.js";
import {registerPanelRoutes} from "../adapters/inbound/local-api/routes/agent-runtime/panel.js";
import type {AgentRuntimeRouteDeps} from "../adapters/inbound/local-api/routes/agent-runtime/index.js";
import {createPanelService} from "../services/panel-service.js";
const fixture=createMemoryServiceFixture();afterEach(fixture.cleanup);
it("reads all stored owners through the authenticated desktop Backend and Memory chain",async()=>{
  const {service}=await createLocalOwnerFixture(fixture);
  const memory=createMemoryHttpServer({service,configPath:"/private/tmp/panel-backend-local-synthetic.json",auth:{localServiceToken:"memory-local-test"},workerStartupFallbackMs:3600000,workerPostHealthDelayMs:3600000,workerIdlePollMs:3600000,startAgentSourceAutomation:false});
  const app=Fastify();
  try{
    await new Promise<void>((resolve,reject)=>{memory.once("error",reject);memory.listen(0,"127.0.0.1",resolve);});
    const address=memory.address();if(!address||typeof address==="string")throw new Error("No Memory listener");
    let owner="a";
    const client=createHttpMemoryClient({baseUrl:`http://127.0.0.1:${address.port}`,token:"memory-local-test",timeoutMs:5000,maxRetries:0});
    const panel=createPanelService({memoryClient:client,getUserId:()=>owner});
    registerPanelRoutes(app,{services:{panel},authenticateRuntimeToken:async(request,reply)=>{if(request.headers["x-memmy-local-token"]!=="desktop-local-test")return reply.code(401).send({error:"unauthorized"});}} as unknown as AgentRuntimeRouteDeps);
    const call=async(url:string)=>app.inject({method:"GET",url,headers:{"x-memmy-local-token":"desktop-local-test"}});
    expect((await app.inject({method:"GET",url:"/api/v1/panel/memory/user-b"})).statusCode).toBe(401);
    for(const next of ["a","b","unrelated"]){
      owner=next;
      const users=await call("/api/v1/panel/items?layer=UserMemory");expect(users.statusCode).toBe(200);expect(users.json().total).toBe(3);
      const found=await call("/api/v1/panel/items?layer=UserMemory&q=b-tail-needle");expect(found.json().items.map((row:{id:string})=>row.id)).toEqual(["user-b"]);
      const detail=await call("/api/v1/panel/memory/user-b");expect(detail.statusCode).toBe(200);expect(detail.json().item.body).toContain("b-tail-needle");
      expect((await call("/api/v1/panel/tasks")).json().total).toBe(3);
    }
    await vi.waitFor(async()=>expect((await call("/api/v1/panel/overview-stats")).json()).toMatchObject({status:"ready",data:{counts:{userMemories:3}}}));
    await expect(client.getMemory({memoryId:"user-b"},{userId:"a"})).rejects.toMatchObject({status:404});
    await expect(client.deleteMemory({memoryId:"user-b"},{userId:"a"})).rejects.toMatchObject({status:403});
  }finally{await app.close();await closeMemoryHttpServer(memory);}
});
