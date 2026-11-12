import {afterEach,expect,it,vi} from "vitest";
import {createHttpMemoryRuntimeClient} from "../memory-runtime-client.js";
import {memoryDetailFixture} from "../../pages/memory/tests/fixtures.js";
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
const client=()=>createHttpMemoryRuntimeClient({baseUrl:"http://synthetic.invalid",localToken:"test"});
it.each(["recover","exhaust",401,403,404,409] as const)("bounds shared detail recovery: %s",async scenario=>{
 vi.useFakeTimers();let calls=0;
 vi.stubGlobal("fetch",vi.fn(async()=>{calls++;return scenario==="recover"&&calls===2 ? new Response(JSON.stringify(memoryDetailFixture)) : new Response("{}",{status:typeof scenario==="number"?scenario:503});}));
 const api=client();const a=api.getPanelMemory!("same").catch(e=>e),b=api.getPanelMemory!("same").catch(e=>e);
 await vi.advanceTimersByTimeAsync(10000);const values=await Promise.all([a,b]);
 expect(calls).toBe(scenario==="recover"?2:scenario==="exhaust"?4:1);
 if(scenario==="recover")expect(values).toEqual([memoryDetailFixture,memoryDetailFixture]);else expect(values[0].status).toBe(typeof scenario==="number"?scenario:503);
});
it("cancels only one detail subscriber and stops retrying after the last leaves",async()=>{
 vi.useFakeTimers();const fetch=vi.fn(async()=>new Response("{}",{status:503}));vi.stubGlobal("fetch",fetch);
 const api=client(),a=new AbortController(),b=new AbortController();
 const first=api.getPanelMemory!("same",a.signal).catch(e=>e),second=api.getPanelMemory!("same",b.signal).catch(e=>e);
 await vi.advanceTimersByTimeAsync(1);a.abort();expect((await first).name).toBe("AbortError");
 await vi.advanceTimersByTimeAsync(250);expect(fetch).toHaveBeenCalledTimes(2);
 b.abort();expect((await second).name).toBe("AbortError");await vi.advanceTimersByTimeAsync(10000);expect(fetch).toHaveBeenCalledTimes(2);
});
it("does not wrap the legacy backend fallback in frontend retries",async()=>{
 const calls:string[]=[];
 vi.stubGlobal("fetch",vi.fn(async(url)=>{calls.push(String(url));return calls.length===1 ? new Response(JSON.stringify({message:"Route GET:/api/v1/panel/memory/test not found"}),{status:404}) : new Response("{}",{status:503});}));
 await expect(client().getPanelMemory!("test")).rejects.toMatchObject({status:503});expect(calls).toHaveLength(2);expect(calls[1]).toContain("/api/v1/memory/test");
});
