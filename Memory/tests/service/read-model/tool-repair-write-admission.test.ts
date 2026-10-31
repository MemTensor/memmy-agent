import Database from "better-sqlite3";
import {afterEach,expect,it,vi} from "vitest";
import {createMemoryServiceFixture,LEGACY_TEST_CONFIG} from "../../fixtures/memory-service-fixture.js";
import type {PanelWriteCoordinator} from "../../../src/service/panel/write-coordinator.js";
import type {Repositories} from "../../../src/storage/repositories.js";
const fixture=createMemoryServiceFixture();
afterEach(async()=>{vi.restoreAllMocks();await fixture.cleanup();});
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function setup(){
 const config=structuredClone(LEGACY_TEST_CONFIG);config.algorithm.feedback={...config.algorithm.feedback,failureThreshold:1,valueDelta:0,cooldownMs:0};
 const test=fixture.createTestService({config});
 const {sessionId}=test.service.openSession({namespace:{source:"memmy-agent",profileId:"test"}});
 const internals=test.service as unknown as {panelWrites:PanelWriteCoordinator;repos:Repositories;sessionTurns:{maybeSynthesizeFailureBurstDecisionRepair:()=>Promise<undefined>}};
 const observe=()=>test.service.observeTool({sessionId,episodeId:"repair-episode",turnId:"failure",toolName:"shell",error:"exit code 2"});
 return {...test,...internals,observe};
}
it.each([false,true])("waits outside the repair transaction while a cache writer holds SQLite (stop: %s)",async stop=>{
 const {service,db,panelWrites,sessionTurns,observe}=setup();
 let entered!:()=>void,finish!:()=>void;
 const enteredGate=new Promise<void>(r=>{entered=r;}),modelGate=new Promise<void>(r=>{finish=r;});
 vi.spyOn(sessionTurns,"maybeSynthesizeFailureBurstDecisionRepair").mockImplementation(async()=>{entered();await modelGate;return undefined;});
 let settled=false;const result=observe().then(value=>{settled=true;return value;},error=>{settled=true;throw error;});
 const caught=result.catch(error=>error);
 await enteredGate;
 // Acquiring during model wait also proves the model does not retain the lease.
 const release=await panelWrites.acquire();const writer=new Database(db.db.name);
 db.db.pragma("busy_timeout=0");writer.exec("BEGIN IMMEDIATE");
 try{
  finish();await tick();expect(settled).toBe(false);
  expect(db.db.prepare("SELECT count(*) FROM decision_repairs").pluck().get()).toBe(0);
  const stopping=stop?service.stop():Promise.resolve();
  writer.exec("ROLLBACK");release();
  const value=await caught;await stopping;
  if(stop)expect(value.name).toBe("AbortError");else expect(value.repair.repairId).toMatch(/^repair_/);
  expect(db.db.prepare("SELECT count(*) FROM raw_turns").pluck().get()).toBe(1);
  expect(db.db.prepare("SELECT count(*) FROM decision_repairs").pluck().get()).toBe(stop?0:1);
 }finally{if(writer.inTransaction)writer.exec("ROLLBACK");writer.close();release();finish();await caught;}
});
it.each([false,true])("rolls back all repair writes before bounded retry (persistent: %s)",async persistent=>{
 const {db,repos,observe}=setup();const original=repos.runtime.appendEpisodeDecisionRepair.bind(repos.runtime);let attempts=0;
 vi.spyOn(repos.runtime,"appendEpisodeDecisionRepair").mockImplementation((...args)=>{original(...args);if(++attempts===1||persistent)throw Object.assign(new Error("busy after repair insert"),{code:"SQLITE_BUSY"});});
 if(persistent)await expect(observe()).rejects.toThrow("busy after repair insert");else expect((await observe()).repair?.repairId).toMatch(/^repair_/);
 expect(attempts).toBe(persistent?4:2);
 expect(db.db.prepare("SELECT count(*) FROM decision_repairs").pluck().get()).toBe(persistent?0:1);
 expect(db.db.prepare("SELECT count(*) FROM memory_change_log WHERE kind='repair'").pluck().get()).toBe(persistent?0:1);
 expect(db.db.prepare("SELECT count(*) FROM raw_turns").pluck().get()).toBe(1);
});
