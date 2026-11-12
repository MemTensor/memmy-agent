import {afterAll,afterEach,beforeAll,expect,it} from 'vitest';
import {copyFileSync,mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {MemoryDb} from '../../../src/storage/db.js';
import {openCacheFixture} from '../../fixtures/panel-cache-fixture.js';
import {panelSafetyToken} from '../../../src/storage/panel-security.js';
import {loadStatistics,saveStatistics} from '../../../src/service/panel/stats-worker-store.js';
import {PanelMemoryBudget} from '../../../src/service/panel/memory-budget.js';
let schemaRoot:string;let schemaPath:string;let schemaVersion:number;
beforeAll(()=>{
 schemaRoot=mkdtempSync(join(tmpdir(),'panel-stats-schema-'));schemaPath=join(schemaRoot,'empty.sqlite');
 const source=new MemoryDb({path:schemaPath});
 try {schemaVersion=source.schemaVersion().version;source.db.pragma('wal_checkpoint(TRUNCATE)');} finally {source.close();}
});
afterAll(()=>{if(schemaRoot)rmSync(schemaRoot,{recursive:true,force:true});});
const close:Array<()=>void>=[];afterEach(()=>close.splice(0).reverse().forEach(fn=>fn()));
function fixture(){const root=mkdtempSync(join(tmpdir(),'panel-json-'));close.push(()=>rmSync(root,{recursive:true,force:true}));const path=root+'/memory.sqlite';copyFileSync(schemaPath,path);const db=new MemoryDb({path});close.push(()=>db.close());
 expect(db.schemaVersion().version).toBe(schemaVersion);
 expect(db.db.prepare('SELECT count(*) FROM memories').pluck().get()).toBe(0);
 expect(db.db.prepare('SELECT count(*) FROM source_changes').pluck().get()).toBe(0);
 const reader=openCacheFixture(path);close.push(()=>reader.close());
 const key=JSON.stringify([{},null,'UTC']),dir=path+'.panel-statistics';mkdirSync(dir);
 const file=dir+'/overview-'+createHash('sha256').update(key).digest('hex')+'.json';
 const snapshot={data:{count:3},safety:panelSafetyToken(db.db),revision:'2:999',day:'2026-11-03',generatedAt:'2026-11-03T00:00:00Z'};
 const write=(value= snapshot)=>writeFileSync(file,JSON.stringify({format:1,database:path,key,snapshot:value}));
 return {db,reader,path,key,file,snapshot,write};}
it('imports matching legacy JSON once, marks it stale and never overwrites a newer SQLite snapshot',()=>{
 const f=fixture();f.write();const loaded=loadStatistics(f.reader.source.db,f.reader.cache,f.path,'overview',f.key);
 expect(loaded?.data).toEqual({count:3});expect(loaded?.revision).toMatch(/:legacy$/);expect(existsSync(f.file)).toBe(false);
 saveStatistics(f.reader.cache,'overview',f.key,{...f.snapshot,data:{count:9}});f.write();
 expect(loadStatistics(f.reader.source.db,f.reader.cache,f.path,'overview',f.key)?.data).toEqual({count:9});
 expect(existsSync(f.file)).toBe(false);
});
it('keeps legacy JSON on a failed cache transaction, and discards invalid privacy snapshots',()=>{
 const f=fixture();f.write();f.reader.cache.exec("CREATE TRIGGER fail_snapshot BEFORE INSERT ON panel_statistics BEGIN SELECT RAISE(ABORT,'failed snapshot');END");
 expect(()=>loadStatistics(f.reader.source.db,f.reader.cache,f.path,'overview',f.key)).toThrow('failed snapshot');expect(existsSync(f.file)).toBe(true);
 f.reader.cache.exec('DROP TRIGGER fail_snapshot');f.write({...f.snapshot,safety:'wrong'});
 expect(loadStatistics(f.reader.source.db,f.reader.cache,f.path,'overview',f.key)).toBeUndefined();expect(existsSync(f.file)).toBe(false);
});
it('shares one bounded LRU budget across different page result owners',()=>{
 const budget=new PanelMemoryBudget(100),evicted:string[]=[];
 budget.reserve('browse',60,()=>evicted.push('browse'));budget.reserve('overview',30,()=>evicted.push('overview'));budget.touch('browse');
 budget.reserve('analysis',20,()=>evicted.push('analysis'));
 expect(evicted).toEqual(['overview']);expect(budget.bytes()).toBe(80);
 expect(()=>budget.reserve('too-big',101,()=>{})).toThrow('memory budget');expect(budget.bytes()).toBe(80);
});
