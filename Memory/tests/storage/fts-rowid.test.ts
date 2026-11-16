import {expect,it,vi} from 'vitest';
import {MemoryDb} from '../../src/storage/db.js';
import {repairFts,writeFts,installFtsMappings,retryFtsRepairs} from '../../src/storage/fts-maintenance.js';
import {Repositories} from '../../src/storage/repositories.js';
function add(db:MemoryDb,id:string){db.db.prepare("INSERT INTO memories(id,user_id,timeline,memory_value,memory_layer,created_at,updated_at) VALUES(?,'u','now','original keyword','L1','now','now')").run(id);repairFts(db.db,'memories',id);}
it('reuses rowids through updates, soft deletion and restoration, and removes mappings on physical deletion',()=>{
 const db=new MemoryDb({path:':memory:'});try{
 add(db,'a');const rowid=db.db.prepare('SELECT rowid FROM memories_fts WHERE id=?').pluck().get('a');
 writeFts(db.db,'memories','a',['a','new keyword','']);writeFts(db.db,'memories','a',['a','new keyword','']);
 expect(db.db.prepare('SELECT rowid FROM memories_fts').pluck().all()).toEqual([rowid]);
 writeFts(db.db,'memories','a');expect(db.db.prepare('SELECT count(*) FROM memories_fts').pluck().get()).toBe(0);
 repairFts(db.db,'memories','a');expect(db.db.prepare('SELECT rowid FROM memories_fts').pluck().get()).toBe(rowid);
 db.db.exec("DELETE FROM memories WHERE id='a'");expect(db.db.prepare('SELECT count(*) FROM memories_fts_ids').pluck().get()).toBe(0);
 expect(db.db.prepare('SELECT count(*) FROM memories_fts').pluck().get()).toBe(0);
 }finally{db.close();}
});
it('keeps User Memory visibility and search fields correct through archive and restoration',()=>{
 const db=new MemoryDb({path:':memory:'});try{
 db.db.prepare("INSERT INTO user_memories(id,source_turn_id,user_id,content,normalized_user_text_hash,memory_types_json,created_at,updated_at) VALUES('u','turn','owner','preferred language','hash','[\"preference\"]','now','now')").run();
 repairFts(db.db,'user_memories','u');
 const first=db.db.prepare('SELECT rowid,content,memory_types FROM user_memories_fts').get();
 expect(first).toMatchObject({content:'preferred language',memory_types:'preference'});
 db.db.exec("UPDATE user_memories SET status='archived' WHERE id='u'");repairFts(db.db,'user_memories','u');
 expect(db.db.prepare('SELECT count(*) FROM user_memories_fts').pluck().get()).toBe(0);
 db.db.exec("UPDATE user_memories SET status='active' WHERE id='u'");repairFts(db.db,'user_memories','u');
 expect(db.db.prepare('SELECT rowid,content,memory_types FROM user_memories_fts').get()).toEqual(first);
 db.db.exec("DELETE FROM user_memories WHERE id='u'");
 expect(db.db.prepare('SELECT count(*) FROM user_memories_fts_ids').pluck().get()).toBe(0);
 }finally{db.close();}
});
it('durably queues a failed ordinary FTS update and repairs it on the next worker pass',()=>{
 const db=new MemoryDb({path:':memory:'});try{
 add(db,'a');db.db.exec("UPDATE memories SET memory_value='repaired keyword' WHERE id='a'");
 const repos=new Repositories(db.db),memory=repos.memories.get('a')!;
 const prepare=db.db.prepare.bind(db.db);
 const failure=vi.spyOn(db.db,'prepare').mockImplementation((sql:string)=>{
   if(sql.startsWith('DELETE FROM memories_fts WHERE rowid='))throw Object.assign(new Error('index fault'),{code:'SQLITE_IOERR'});
   return prepare(sql);
 });
 try{repos.memories.reindexFts(memory);}finally{failure.mockRestore();}
 expect(db.db.prepare('SELECT memory_id FROM fts_repair_queue').pluck().all()).toEqual(['a']);
 expect(db.db.prepare('SELECT memory_value FROM memories_fts').pluck().get()).toBe('original keyword');
 retryFtsRepairs(db.db);
 expect(db.db.prepare('SELECT memory_value FROM memories_fts').pluck().get()).toBe('repaired keyword');
 expect(db.db.prepare('SELECT count(*) FROM fts_repair_queue').pluck().get()).toBe(0);
 }finally{db.close();}
});
it('rolls back both mapping and FTS changes on an index update failure',()=>{
 const db=new MemoryDb({path:':memory:'});try{add(db,'a');
 expect(()=>writeFts(db.db,'memories','a',['wrong-column-count'])).toThrow();
 expect(db.db.prepare('SELECT memory_value FROM memories_fts').pluck().get()).toBe('original keyword');
 expect(db.db.prepare('SELECT count(*) FROM memories_fts_ids').pluck().get()).toBe(1);
 }finally{db.close();}
});
it('repairs duplicate, orphan and missing legacy FTS rows using canonical source data',()=>{
 const db=new MemoryDb({path:':memory:'});try{add(db,'a');add(db,'b');
 db.db.exec("DROP TRIGGER memories_fts_delete;DROP TABLE memories_fts_ids;DELETE FROM memories_fts;INSERT INTO memories_fts(id,memory_value) VALUES('a','wrong'),('a','duplicate'),('orphan','wrong')");
 installFtsMappings(db.db);
 expect(db.db.prepare('SELECT id,memory_value FROM memories_fts ORDER BY id').all()).toEqual([{id:'a',memory_value:'original keyword'},{id:'b',memory_value:'original keyword'}]);
 const plan=db.db.prepare('EXPLAIN QUERY PLAN SELECT fts_rowid FROM memories_fts_ids WHERE memory_id=?').all('a') as {detail:string}[];
 expect(plan.some(x=>x.detail.includes('INDEX'))).toBe(true);
 expect((db.db.prepare('EXPLAIN QUERY PLAN DELETE FROM memories_fts WHERE rowid=?').all(1) as {detail:string}[]).some(x=>x.detail.includes('='))).toBe(true);
 }finally{db.close();}
});
