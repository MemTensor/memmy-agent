import {afterEach,expect,it,vi} from "vitest";
import {createMemoryServiceFixture} from "../../fixtures/memory-service-fixture.js";
import {Repositories} from "../../../src/storage/repositories.js";
import {createMemoryHttpServer,closeMemoryHttpServer} from "../../../src/server/http.js";
const fixture=createMemoryServiceFixture();
let server:ReturnType<typeof createMemoryHttpServer>|undefined;
afterEach(async()=>{if(server){await closeMemoryHttpServer(server);server=undefined;}await fixture.cleanup();});
it.each(["service","http","memmy-service","memmy-http"])("commits each capture exactly once during cold and incremental backfill: %s",async transport=>{
 const {service,db,root}=fixture.createTestService();
 const memmy=transport.startsWith("memmy"),http=transport.endsWith("http");
 const session=service.openSession({namespace:{source:"memmy-agent",profileId:"test"}});
 const count=memmy?32:8;
 let base="";
 if(http) {
  server=createMemoryHttpServer({service,configPath:`${root}/fixture.json`,auth:{localServiceToken:"fixture"}});
  await new Promise<void>((resolve,reject)=>{server!.once("error",reject);server!.listen(0,"127.0.0.1",resolve);});
  const address=server.address();if(!address||typeof address==="string")throw Error("missing test listener");
  base=`http://127.0.0.1:${address.port}`;
 }
 // Use independent connections: this test targets write admission, not keep-alive reuse
 // across long synchronous fixture/backfill phases. No client retries are used.
 const capture=async(input:Parameters<typeof service.completeSourceTurn>[0])=>{
  if(memmy){
   const request={sessionId:session.sessionId,query:input.query,answer:input.answer};
   if(!http)return {result:await service.completeTurn(input.sourceTurn!.turnId,request)};
   const response=await fetch(`${base}/api/v1/turns/${input.sourceTurn!.turnId}/complete`,{method:"POST",headers:{connection:"close",authorization:"Bearer fixture","content-type":"application/json"},body:JSON.stringify(request)});
   expect(response.status).toBe(200);
   return {result:await response.json() as Awaited<ReturnType<typeof service.completeTurn>>};
  }
  if(!http)return service.completeSourceTurn(input);
  const response=await fetch(`${base}/api/v1/source-turns/complete`,{method:"POST",headers:{connection:"close",authorization:"Bearer fixture","content-type":"application/json"},body:JSON.stringify(input)});
  expect(response.status).toBe(200);
  return await response.json() as Awaited<ReturnType<typeof service.completeSourceTurn>>;
 };
 service.addMemory({content:"synthetic seed",source:"codex"});
 const repos=new Repositories(db.db),seed=repos.memories.list({})[0]!;
 db.db.transaction(()=>{for(let i=0;i<6000;i++)repos.memories.insert({...seed,id:`cold-${i}`,memoryKey:`cold-${i}`,properties:{...seed.properties,internal_info:{...seed.properties.internal_info,padding:"x".repeat(16384)}}});})();
 repos.runtime.setKv("source_turn_capture_activated_at","2026-01-01T00:00:00Z");
 for(const phase of ["cold","incremental"]) {
 if(phase==="incremental") db.db.transaction(()=>{for(let i=0;i<600;i++)repos.memories.insert({...seed,id:`incremental-${i}`,memoryKey:`incremental-${i}`});})();
 service.startPanelWarmup();
 await vi.waitFor(()=>expect(Number(db.db.prepare("SELECT count(*) FROM panel_memory_facts").pluck().get())).toBeGreaterThan(0),{timeout:10000,interval:1});
 expect(Number(db.db.prepare("SELECT count(*) FROM panel_memory_dirty").pluck().get())).toBeGreaterThan(0);
 const capturedAt=new Date().toISOString();
 const inputs=Array.from({length:count},(_,i)=>({query:`synthetic ${phase} capture ${i}`,answer:"persist this completed native turn",channel:"hook" as const,
  sourceTurn:{completionEvidence:"native turn completed",source:"codex",profileId:"default",conversationId:`capture-${i}`,turnId:`${phase}-turn-${i}`,startedAt:capturedAt,completedAt:capturedAt}}));
 const pending=Promise.all(inputs.map(input=>capture(input)));
 if(http) expect((await fetch(`${base}/health`)).status).toBe(200);
 const results=await pending;
 expect(results.every(result=>result.result?.rawTurnId), JSON.stringify({phase,results:results.map(result=>({status:"status" in result?result.status:undefined,reason:"reason" in result?result.reason:undefined,saved:!!result.result?.rawTurnId}))})).toBe(true);
 const ids=results.map(result=>result.result!.rawTurnId);expect(new Set(ids).size).toBe(count);
 expect(db.db.prepare("SELECT count(*) FROM raw_turns WHERE id IN (SELECT value FROM json_each(?))").pluck().get(JSON.stringify(ids))).toBe(count);
 const duplicates=await Promise.all(inputs.map(input=>capture(input)));
 expect(duplicates.map(result=>result.result?.rawTurnId)).toEqual(ids);
 await vi.waitFor(()=>expect(service.panelOverviewStatsSnapshot({}).status).toBe("ready"),{timeout:10000});
 }
},60000);
