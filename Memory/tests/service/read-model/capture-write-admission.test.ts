import { afterEach, expect, it, vi } from "vitest";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";
import type { PanelWriteCoordinator } from "../../../src/service/panel/write-coordinator.js";
import type { Repositories } from "../../../src/storage/repositories.js";
const fixture = createMemoryServiceFixture();
afterEach(async () => { vi.restoreAllMocks(); await fixture.cleanup(); });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

it.each(["complete", "observe", "subagentStart", "subagentComplete", "compact", "start"])("admits %s before opening its capture transaction", async kind => {
  const { service, db } = fixture.createTestService();
  const { sessionId } = service.openSession({ namespace: { source: "memmy-agent", profileId: "test" } });
  const internals = service as unknown as { panelWrites: PanelWriteCoordinator; repos: Repositories };
  const release = await internals.panelWrites.acquire();
  const transaction = vi.spyOn(internals.repos, "transaction");
  const count = () => db.db.prepare("SELECT count(*) FROM raw_turns").pluck().get();
  const before = count();
  const pending = kind === "complete" ? service.completeTurn("test", {sessionId, query:"query", answer:"answer"})
    : kind === "observe" ? service.observeTool({sessionId,turnId:"test",toolName:"read",result:"contents"})
    : kind === "subagentStart" ? service.subagentStart({sessionId,subagentId:"child",task:"task"})
    : kind === "subagentComplete" ? service.subagentComplete({sessionId,subagentId:"child",summary:"result",status:"succeeded"})
    : kind === "start" ? service.startTurn({sessionId,turnId:"test",query:"hello",layers:[]})
    : service.compactSession(sessionId,{summary:"summary"});
  try {
    await tick(); expect(transaction).not.toHaveBeenCalled(); expect(count()).toBe(before);
  } finally { release(); }
  await pending;
  expect(transaction).toHaveBeenCalled();
  if(kind === "start")expect(db.db.prepare("SELECT count(*) FROM recall_events").pluck().get()).toBe(1);
  else expect(Number(count())).toBeGreaterThan(Number(before));
});

it.each([false,true])("rolls back the entire completion before bounded busy retry (persistent: %s)", async persistent => {
  const { service, db } = fixture.createTestService();
  const { sessionId } = service.openSession({namespace:{source:"memmy-agent",profileId:"test"}});
  const { repos } = service as unknown as {repos:Repositories};
  const original = repos.runtime.insertRawTurn.bind(repos.runtime);
  let attempts=0;
  vi.spyOn(repos.runtime,"insertRawTurn").mockImplementation(input => {
    const result=original(input);
    if (++attempts===1 || persistent) throw Object.assign(new Error("busy after insert"),{code:"SQLITE_BUSY"});
    return result;
  });
  const input={sessionId,query:"persist query",answer:"persist answer"};
  if(persistent) {
    await expect(service.completeTurn("test",input)).rejects.toThrow("busy after insert");
    expect(attempts).toBe(4);
    expect(db.db.prepare("SELECT count(*) FROM raw_turns").pluck().get()).toBe(0);
  } else {
    const result=await service.completeTurn("test",input);
    expect(attempts).toBe(2);
    expect(db.db.prepare("SELECT id FROM raw_turns").all()).toEqual([{id:result.rawTurnId}]);
    expect(await service.completeTurn("test",input)).toMatchObject({duplicate:true,rawTurnId:result.rawTurnId});
    expect(attempts).toBe(2);
  }
});

it.each(["abort","stop","native-abort","native-stop"])("does not write a queued completion after %s", async mode => {
  const { service, db } = fixture.createTestService();
  const { sessionId } = service.openSession({namespace:{source:"memmy-agent",profileId:"test"}});
  const { panelWrites } = service as unknown as {panelWrites:PanelWriteCoordinator};
  const release=await panelWrites.acquire(), controller=new AbortController();
  const result=(mode.startsWith("native") ? service.completeSourceTurn({query:"query",answer:"answer",channel:"hook",
    sourceTurn:{source:"codex",profileId:"test",conversationId:"test",turnId:"test",completionEvidence:"complete",startedAt:"2026-10-30T00:00:00Z",completedAt:"2026-10-30T00:01:00Z"}},controller.signal)
    : service.completeTurn("test",{sessionId,query:"query",answer:"answer"},controller.signal)).catch(error=>error);
  await tick();
  if(mode.endsWith("abort"))controller.abort();
  const stop=mode.endsWith("stop")?service.stop():Promise.resolve();
  release();
  expect((await result).name).toBe("AbortError");await stop;
  expect(db.db.prepare("SELECT count(*) FROM raw_turns").pluck().get()).toBe(0);
});

it("does not hold the write lease while turn-start retrieval is waiting", async () => {
  const { service } = fixture.createTestService();
  const { sessionId } = service.openSession({namespace:{source:"memmy-agent",profileId:"test"}});
  const { sessionTurns, panelWrites } = service as unknown as {
    panelWrites:PanelWriteCoordinator;
    sessionTurns:{deps:{search:(...args:unknown[])=>Promise<unknown>}};
  };
  const original=sessionTurns.deps.search;
  let releaseSearch!:()=>void;
  const gate=new Promise<void>(resolve=>{releaseSearch=resolve;});
  vi.spyOn(sessionTurns.deps,"search").mockImplementation(async (...args)=>{await gate;return original(...args);});
  const started=service.startTurn({sessionId,turnId:"waiting",query:"hello",layers:[]});
  let admitted=false;
  const other=panelWrites.acquire().then(release=>{admitted=true;release();});
  try {await tick();expect(admitted).toBe(true);}
  finally {releaseSearch();await Promise.all([started,other]);}
});
