import Database from 'better-sqlite3';
import {afterEach,expect,it,vi} from 'vitest';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {createMemoryServiceFixture} from '../../fixtures/memory-service-fixture.js';
import {createAgentSourceExecutor} from '../../../src/agent-source/runtime.js';
import {createSourceRegistry} from '../../../src/agent-source/adapters/source-registry.js';
import {createSkillTargetRegistry} from '../../../src/agent-source/integration/target-registry.js';
import {createMemoryHttpServer,closeMemoryHttpServer} from '../../../src/server/http.js';
const fixture=createMemoryServiceFixture();
afterEach(fixture.cleanup);
it('imports real Codex Skills, syncs history and claims jobs while a real panel worker builds its cache',async()=>{
 const {root,db,service}=fixture.createTestService();
 const configPath=join(root,'config.json');writeFileSync(configPath,JSON.stringify({memmyMemory:{agentAccess:{autoScanKnownAgents:false,autoInjectSkill:false,watchFileChanges:false}}}));
 const agentRoot=join(root,'codex');
 for(let i=0;i<40;i++){const dir=join(agentRoot,'skills',`skill-${i}`);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'SKILL.md'),`---\nname: isolated-skill-${i}\n---\nUse fixture command ${i} to validate release ${i}.`);}
 const insert=db.db.prepare("INSERT INTO memories(id,user_id,timeline,memory_value,memory_layer,status,created_at,updated_at,properties_json) VALUES(?,'u','now','seed','L1','archived','2026-11-03','2026-11-03',?)");
 db.db.transaction(()=>{for(let i=0;i<6000;i++)insert.run(`seed-${i}`,JSON.stringify({padding:'x'.repeat(8192)}));})();
 const executor=createAgentSourceExecutor({service,configPath,statePath:join(root,'sources.json'),scanStoreDirectory:join(root,'scan-store'),legacyDatabasePath:join(root,'absent.sqlite'),
   sourceRegistry:createSourceRegistry([{descriptor:{sourceId:'codex',displayName:'Codex',builtin:true,dataPath:agentRoot},detect:async()=>true,async *scan(){/* Skills-only fixture. */}}]),
   integrationRegistry:createSkillTargetRegistry([]),resolveAgentSkillRoot:()=>agentRoot});
 const server=createMemoryHttpServer({service,configPath,auth:{localServiceToken:'fixture'},startAgentSourceAutomation:false,workerStartupFallbackMs:3600000,workerPostHealthDelayMs:3600000,workerIdlePollMs:3600000});
 const latencies:number[]=[];
 try {
   await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
   const address=server.address();if(!address||typeof address==='string')throw Error('no listener');
   const base=`http://127.0.0.1:${address.port}`;
   const pending=service.readPanel('overviewStats',[{}]);void pending.catch(()=>undefined);
   await vi.waitFor(()=>{expect(existsSync(db.path+'.panel-cache.sqlite')).toBe(true);const c=new Database(db.path+'.panel-cache.sqlite',{readonly:true});try{expect(Number(c.prepare('SELECT count(*) FROM panel_memory_facts').pluck().get())).toBeGreaterThan(0);expect(Number(c.prepare('SELECT count(*) FROM panel_memory_dirty').pluck().get())).toBeGreaterThan(0);}finally{c.close();}},{timeout:10000,interval:1});
   await executor.startScan({sourceId:'codex',mode:'incremental'});
   const evidenceIds:string[]=[];
   for(let i=0;i<25;i++){
     evidenceIds.push(service.syncExternalEvidence({action:'upsert',source:'computer_history',sourceRecordId:`fixture-${i}`,revision:'2026-11-03T00:10:00Z',title:`Fixture history ${i}`,content:`Reviewed fixture release ${i}.`,startedAt:'2026-11-03T00:00:00Z',endedAt:'2026-11-03T00:10:00Z',namespace:{source:'memmy',profileId:'default'}}).id);
     if(i%5===0){await service.runWorkerOnce(1);const start=performance.now();const response=await fetch(base+'/health',{signal:AbortSignal.timeout(5000)});expect(response.status).toBe(200);latencies.push(performance.now()-start);}
     await setImmediate();
   }
   await vi.waitFor(()=>expect(executor.scanStatus().running).toBe(false),{timeout:15000});
   expect(executor.scanStatus().error).toBeNull();expect(executor.scanStatus().results?.flatMap(x=>x.errors)).toEqual([]);
   expect(db.db.prepare("SELECT count(*) FROM memories WHERE memory_layer='Skill' AND json_extract(properties_json,'$.internal_info.source_agent_id')='codex'").pluck().get()).toBe(40);
   expect(new Set(evidenceIds).size).toBe(25);
   expect(db.db.prepare('SELECT count(*) FROM memories WHERE id IN (SELECT value FROM json_each(?))').pluck().get(JSON.stringify(evidenceIds))).toBe(25);
   await pending;await service.readPanel('overviewStats',[{}]);
   await executor.startScan({sourceId:'codex',mode:'incremental'});await vi.waitFor(()=>expect(executor.scanStatus().running).toBe(false),{timeout:15000});
   expect(db.db.prepare("SELECT count(*) FROM memories WHERE memory_layer='Skill' AND json_extract(properties_json,'$.internal_info.source_agent_id')='codex'").pluck().get()).toBe(40);
   console.log(JSON.stringify({scenario:'panel-scan-isolation',skills:40,evidence:25,healthMs:latencies}));
 }finally{await executor.dispose();await closeMemoryHttpServer(server);}
},60000);
it('keeps imports usable when the cache path cannot be opened',async()=>{
 const {db,service}=fixture.createTestService();mkdirSync(db.path+'.panel-cache.sqlite');
 await expect(service.readPanel('members',[{}])).rejects.toThrow();
 const result=service.addMemory({content:'cache failure must not block this skill',layer:'Skill',source:'codex',sourceAgentId:'codex',sourceSkillId:'fault-isolation',sourceSkillPath:'/fixture/SKILL.md',deferProcessing:true});
 expect(db.db.prepare('SELECT id FROM memories WHERE id=?').pluck().get(result.id)).toBe(result.id);
});
