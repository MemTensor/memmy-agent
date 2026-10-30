import {afterEach,expect,it,vi} from "vitest";
import {createMemoryServiceFixture} from "../../fixtures/memory-service-fixture.js";
import {Repositories} from "../../../src/storage/repositories.js";
import {createMemoryHttpServer,closeMemoryHttpServer} from "../../../src/server/http.js";
const fixture=createMemoryServiceFixture();
let server:ReturnType<typeof createMemoryHttpServer>|undefined;
afterEach(async()=>{if(server){await closeMemoryHttpServer(server);server=undefined;}await fixture.cleanup();});
it.each(["service","http"])("commits each native capture exactly once while cold cache backfill runs: %s",async transport=>{
 const {service,db,root}=fixture.createTestService();
 let base="";
 if(transport==="http") {
  server=createMemoryHttpServer({service,configPath:`${root}/fixture.json`,auth:{localServiceToken:"fixture"}});
  await new Promise<void>((resolve,reject)=>{server!.once("error",reject);server!.listen(0,"127.0.0.1",resolve);});
  const address=server.address();if(!address||typeof address==="string")throw Error("missing test listener");
  base=`http://127.0.0.1:${address.port}`;
 }
 const capture=async(input:Parameters<typeof service.completeSourceTurn>[0])=>{
  if(transport==="service")return service.completeSourceTurn(input);
  const response=await fetch(`${base}/api/v1/source-turns/complete`,{method:"POST",headers:{authorization:"Bearer fixture","content-type":"application/json"},body:JSON.stringify(input)});
  expect(response.status).toBe(200);
  return await response.json() as Awaited<ReturnType<typeof service.completeSourceTurn>>;
 };
 service.addMemory({content:"synthetic seed",source:"codex"});
 const repos=new Repositories(db.db),seed=repos.memories.list({})[0]!;
 db.db.transaction(()=>{for(let i=0;i<6000;i++)repos.memories.insert({...seed,id:`cold-${i}`,memoryKey:`cold-${i}`,properties:{...seed.properties,internal_info:{...seed.properties.internal_info,padding:"x".repeat(16384)}}});})();
 repos.runtime.setKv("source_turn_capture_activated_at","2026-01-01T00:00:00Z");
 service.startPanelWarmup();
 await vi.waitFor(()=>expect(Number(db.db.prepare("SELECT count(*) FROM panel_memory_facts").pluck().get())).toBeGreaterThan(0),{timeout:10000,interval:1});
 expect(Number(db.db.prepare("SELECT count(*) FROM panel_memory_dirty").pluck().get())).toBeGreaterThan(0);
 const inputs=Array.from({length:8},(_,i)=>({query:`synthetic capture ${i}`,answer:"persist this completed native turn",channel:"hook" as const,
  sourceTurn:{completionEvidence:"native turn completed",source:"codex",profileId:"default",conversationId:`capture-${i}`,turnId:`turn-${i}`,startedAt:"2026-10-30T00:00:00Z",completedAt:"2026-10-30T00:01:00Z"}}));
 const pending=Promise.all(inputs.map(input=>capture(input)));
 if(transport==="http") expect((await fetch(`${base}/health`)).status).toBe(200);
 const results=await pending;
 expect(results.every(result=>result.result?.rawTurnId)).toBe(true);
 const ids=results.map(result=>result.result!.rawTurnId);expect(new Set(ids).size).toBe(8);
 expect(db.db.prepare("SELECT count(*) FROM raw_turns WHERE id IN (SELECT value FROM json_each(?))").pluck().get(JSON.stringify(ids))).toBe(8);
 const duplicates=await Promise.all(inputs.map(input=>capture(input)));
 expect(duplicates.map(result=>result.result?.rawTurnId)).toEqual(ids);
 await vi.waitFor(()=>expect(service.panelOverviewStatsSnapshot({}).status).toBe("ready"),{timeout:10000});
},15000);
