import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect,it,vi} from "vitest";
import {PanelStats} from "../../../src/service/panel/stats.js";
import {MemoryDb} from "../../../src/storage/db.js";
import {openPanelCache} from "../../../src/storage/panel-cache-db.js";
import {loadStatistics,saveStatistics} from "../../../src/service/panel/stats-worker-store.js";
it("restores complete snapshots across restart and rejects changed privacy, date, timezone and cache format",async()=>{
 const root=mkdtempSync(join(tmpdir(),"panel-snapshot-")),path=join(root,"memory.sqlite");
 let safety="safe",revision="2:1";
 const read=vi.fn(async()=>({safety,data:{count:12}}));
 const source=new MemoryDb({path}),reader=new MemoryDb({path,readonly:true}),cache=openPanelCache(reader.db,path);
 const store={load:async(key:string)=>loadStatistics(reader.db,cache,path,"full",key) as {data:{count:number};safety:string;revision:string;day:string;generatedAt:string}|undefined,
 save:async(key:string,value:unknown)=>saveStatistics(cache,"full",key,value)};
 const create=()=>new PanelStats(read,()=>safety,()=>revision,store);
 const instances:PanelStats<{count:number}>[]=[];
 try {
  const first=create();instances.push(first);first.get({timeZone:"UTC"});
  await vi.waitFor(()=>expect(first.get({timeZone:"UTC"}).status).toBe("ready"));first.stop();read.mockClear();
  const restarted=create();instances.push(restarted);await vi.waitFor(()=>expect(restarted.get({timeZone:"UTC"}).data).toEqual({count:12}));expect(read).not.toHaveBeenCalled();
  expect(restarted.get({timeZone:"Asia/Shanghai"}).status).toBe("preparing");
  safety="deleted";expect(restarted.get({timeZone:"UTC"}).data).toBeUndefined();
  const replacement=create();instances.push(replacement);expect(replacement.get({timeZone:"UTC"}).data).toBeUndefined();
  safety="safe";revision="3:1";const incompatible=create();instances.push(incompatible);expect(incompatible.get({timeZone:"UTC"}).data).toBeUndefined();
 }finally{instances.forEach(x=>x.stop());reader.close();cache.close();source.close();rmSync(root,{recursive:true,force:true});}
});
