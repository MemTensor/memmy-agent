import {afterEach,expect,it} from "vitest";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {MemoryDb} from "../../src/storage/db.js";
import {openCacheFixture} from "../fixtures/panel-cache-fixture.js";
import {fillPanelCacheBatch,panelMemoryStats} from "../../src/storage/panel-cache.js";
import {sourceVersion,SOURCE_CHANGE_RETENTION} from "../../src/storage/source-changes.js";
import {Repositories} from "../../src/storage/repositories.js";
const roots:string[]=[];const closes:Array<()=>void>=[];
afterEach(()=>{for(const close of closes.splice(0).reverse())close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture() {
 const root=mkdtempSync(join(tmpdir(),'panel-isolation-'));roots.push(root);
 const path=root+'/memory.sqlite';const source=new MemoryDb({path});closes.push(()=>source.close());
 const add=(id:string)=>source.db.prepare("INSERT INTO memories(id,user_id,timeline,memory_value,memory_layer,created_at,updated_at) VALUES(?,'u','now','body','L1','2026-11-03','2026-11-03')").run(id);
 const open=()=>{const reader=openCacheFixture(path);closes.push(()=>reader.source.db.open&&reader.close());return reader;};
 return {source,add,open,path};
}
it('keeps every persistent panel table outside the source and enforces readonly on both worker read schemas',()=>{
 const {source,add,open}=fixture();add('a');const reader=open();reader.prepare(['memories']);
 expect(source.db.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name GLOB 'panel_*'").all()).toEqual([]);
 expect(()=>reader.source.db.exec("DELETE FROM memories")).toThrow(/readonly/i);
 expect(()=>reader.source.db.exec("DELETE FROM panel.panel_memory_facts")).toThrow(/readonly/i);
 reader.cache.exec('BEGIN IMMEDIATE');reader.cache.exec("UPDATE panel_memory_facts SET source='cache-only'");
 expect(()=>add('b')).not.toThrow();reader.cache.exec('ROLLBACK');
 expect(source.db.prepare('SELECT count(*) FROM memories').pluck().get()).toBe(2);
});
it('resumes a committed partial build, catches concurrent insert/update/delete and preserves source data',()=>{
 const {source,add,open}=fixture();for(let i=0;i<300;i++)add(`m-${String(i).padStart(4,'0')}`);
 let reader=open();reader.ingest();expect(fillPanelCacheBatch(reader.source.db,'memories',32)).toBe(32);reader.close();
 source.db.exec("DELETE FROM memories WHERE id='m-0000';UPDATE memories SET memory_layer='Skill' WHERE id='m-0001'");add('a-before-cursor');
 reader=open();expect(reader.cache.prepare('SELECT count(*) FROM panel_memory_facts').pluck().get()).toBe(32);reader.prepare(['memories']);
 const rows=[...panelMemoryStats(reader.source.db,true)];expect(rows).toHaveLength(300);
 expect(rows.some(x=>x.id==='m-0000')).toBe(false);expect(rows.find(x=>x.id==='m-0001')?.memoryLayer).toBe('Skill');expect(rows.some(x=>x.id==='a-before-cursor')).toBe(true);
});
it('rolls back journal changes with the source transaction and does not acknowledge failed cache batches',()=>{
 const {source,add,open}=fixture();const before=sourceVersion(source.db);
 expect(()=>source.db.transaction(()=>{add('rolled-back');throw new Error('rollback');})()).toThrow('rollback');expect(sourceVersion(source.db)).toEqual(before);
 add('kept');const reader=open();reader.ingest();reader.cache.exec("CREATE TRIGGER inject_failure BEFORE INSERT ON panel_memory_facts BEGIN SELECT RAISE(ABORT,'injected'); END");
 expect(()=>fillPanelCacheBatch(reader.source.db,'memories')).toThrow('injected');expect(reader.cache.prepare('SELECT count(*) FROM panel_memory_dirty').pluck().get()).toBe(1);
 reader.cache.exec('DROP TRIGGER inject_failure');reader.prepare(['memories']);expect([...panelMemoryStats(reader.source.db,true)].map(x=>x.id)).toEqual(['kept']);
});
it('detects journal truncation and rebuilds instead of returning an incomplete projection',()=>{
 const {source,add,open}=fixture();add('old');const reader=open();reader.prepare(['memories']);
 source.db.exec("DELETE FROM memories WHERE id='old'");add('new');
 source.db.exec('DELETE FROM source_changes;UPDATE source_change_state SET floor=seq');reader.prepare(['memories']);
 expect([...panelMemoryStats(reader.source.db,true)].map(x=>x.id)).toEqual(['new']);
});
it('bounds the durable journal and advances its floor in the same transaction',()=>{
 const {source,add}=fixture();add('a');const update=source.db.prepare("UPDATE memories SET updated_at=? WHERE id='a'");
 source.db.transaction(()=>{for(let i=0;i<SOURCE_CHANGE_RETENTION+300;i++)update.run(String(i));})();
 expect(Number(source.db.prepare('SELECT count(*) FROM source_changes').pluck().get())).toBeLessThanOrEqual(SOURCE_CHANGE_RETENTION+255);
 expect(sourceVersion(source.db).floor).toBeGreaterThan(0);
 // A changed primary key emits two events and may skip a modulo boundary.
 source.db.exec('DELETE FROM source_changes;UPDATE source_change_state SET seq=100255,floor=0;UPDATE sqlite_sequence SET seq=100255 WHERE name=\'source_changes\'');
 source.db.exec("UPDATE memories SET id='renamed' WHERE id='a'");
 expect(sourceVersion(source.db)).toMatchObject({seq:100257,floor:257});
});
it('invalidates a cache after clear even if the same source IDs are reused',()=>{
 const {source,add,open}=fixture();add('a');const reader=open();reader.prepare(['memories']);const generation=sourceVersion(source.db).generation;
 new Repositories(source.db).clearAllMemoryData();add('a');source.db.exec("UPDATE memories SET memory_layer='Skill' WHERE id='a'");reader.prepare(['memories']);
 expect(sourceVersion(source.db).generation).toBeGreaterThan(generation);expect([...panelMemoryStats(reader.source.db,true)]).toMatchObject([{id:'a',memoryLayer:'Skill'}]);
});
it('rebuilds a corrupt cache without touching business rows',()=>{
 const {source,add,open,path}=fixture();add('a');writeFileSync(path+'.panel-cache.sqlite','not sqlite');const reader=open();reader.prepare(['memories']);
 expect([...panelMemoryStats(reader.source.db,true)]).toHaveLength(1);expect(source.db.prepare('SELECT count(*) FROM memories').pluck().get()).toBe(1);
});
