import Database from "better-sqlite3";
import {join} from "node:path";
import {MemoryDb} from "../../src/storage/db.js";
import {Repositories} from "../../src/storage/repositories.js";
import {createMemoryServiceFixture} from "./memory-service-fixture.js";
const ns=(userId:string)=>({userId,source:"codex",profileId:"default"});
export async function createLocalOwnerFixture(fixture:ReturnType<typeof createMemoryServiceFixture>){
  // Build a separate nullable-owner fixture. Production schema and stored user data are untouched.
  const seed=fixture.createTestService();
  const path=join(fixture.createTestRoot("panel-local-owners-"),"memory.sqlite");
  const raw=new Database(path);
  for(const table of ["schema_migrations","sessions","episodes","raw_turns","memories","user_memories"]){
    const row=seed.db.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as {sql:string};
    raw.exec(row.sql.replace(/\buser_id TEXT NOT NULL/g,"user_id TEXT"));
  }
  for(const row of seed.db.db.prepare("SELECT * FROM schema_migrations").all() as {id:string;version:number;applied_at:string;checksum:string}[])
    raw.prepare("INSERT INTO schema_migrations VALUES(?,?,?,?)").run(row.id,row.version,row.applied_at,row.checksum);
  raw.close();
  const db=new MemoryDb({path}),service=fixture.createTestMemoryService({db,mode:"dev"}),repos=new Repositories(db.db);
  const turns=[];
  for(const owner of ["a","b","new"]){
    const session=service.openSession({namespace:ns(owner)});
    const turn=await service.completeTurn("turn-"+owner,{namespace:ns(owner),sessionId:session.sessionId,query:owner+" task question",answer:owner+" task answer"});
    turns.push({...turn,owner});
    repos.userMemories.insert({id:"user-"+owner,sourceTurnId:turn.rawTurnId,userId:owner,memoryTypes:["User Preference"],content:owner+" preference "+"x".repeat(400)+" "+owner+"-tail-needle",normalizedUserTextHash:owner,sourceTurnRefs:[turn.rawTurnId],status:"active",createdAt:"2026-10-29T00:00:00Z",updatedAt:"2026-10-29T00:00:00Z"});
  }
  const newest=turns[2]!;
  for(const [table,id] of [["sessions",newest.sessionId],["episodes",newest.episodeId],["raw_turns",newest.rawTurnId],["memories",newest.l1MemoryId],["user_memories","user-new"]])
    db.db.prepare(`UPDATE ${table} SET user_id=NULL WHERE id=?`).run(id);
  return {db,service,repos,turns};
}
