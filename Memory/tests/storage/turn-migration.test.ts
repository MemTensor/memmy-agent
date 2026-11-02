import { afterEach, expect, it, vi } from "vitest";
import { Repositories } from "../../src/storage/repositories.js";
import { DEVICE_MEMORY_OWNER } from "../../src/service/namespace/memory-owner.js";
import { createMemoryServiceFixture } from "../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(async()=>{vi.restoreAllMocks();await fixture.cleanup();});

async function setup(rawOwner = "legacy-raw", traceOwner = "legacy-trace") {
  const x = fixture.createTestService();
  const repos = new Repositories(x.db.db);
  const session = x.service.openSession({ namespace: { source: "codex", profileId: "default", sessionKey: "migration" } });
  const first = await x.service.completeTurn("first", { sessionId: session.sessionId, episodeId: "episode_old_task", query: "Question", answer: "Answer" });
  const trace = repos.memories.get(first.l1MemoryId)!;
  const span = { ...trace, id: "migration-span", memoryKey: "migration-span", info: { episode_id: "episode_old_task" },
    properties: { internal_info: { memory_layer: "L1" as const, memory_kind: "span" as const,
      span: { episode_id: "episode_old_task", source_trace_id: trace.id } } } };
  repos.memories.insert(span);
  const policy = { ...trace, id: "migration-policy", memoryKey: "migration-policy", memoryLayer: "L2" as const,
    properties: { internal_info: { memory_layer: "L2" as const, source_trace_ids: [trace.id] } } };
  repos.memories.insert(policy);
  x.db.db.prepare("UPDATE sessions SET user_id='legacy-session' WHERE id=?").run(session.sessionId);
  x.db.db.prepare("UPDATE episodes SET user_id='legacy-task' WHERE id=?").run(first.episodeId);
  x.db.db.prepare("UPDATE raw_turns SET user_id=? WHERE id=?").run(rawOwner, first.rawTurnId);
  x.db.db.prepare("UPDATE memories SET user_id=? WHERE id=?").run(traceOwner, trace.id);
  x.db.db.prepare("UPDATE memories SET user_id='legacy-span' WHERE id=?").run(span.id);
  const target = await x.service.completeTurn("episode_new_task-seed", { sessionId: session.sessionId, episodeId: "episode_new_task", query: "Another task", answer: "Done" });
  return { ...x, repos, sessionId: session.sessionId, rawId: first.rawTurnId, trace, span, policy, targetId: target.episodeId! };
}

function snapshot(x: Awaited<ReturnType<typeof setup>>) {
  return Object.fromEntries(["sessions", "episodes", "raw_turns", "memories", "trace_policy_links", "artifacts", "evolution_jobs"]
    .map(table => [table, x.db.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

for (const rawOwner of ["legacy-raw", DEVICE_MEMORY_OWNER]) for (const traceOwner of ["legacy-trace", DEVICE_MEMORY_OWNER]) {
  it(`moves verified trace/span/policy membership with raw=${rawOwner}, trace=${traceOwner}, preserving provenance`, async () => {
    const x = await setup(rawOwner, traceOwner);
    const before = [x.trace.id, x.span.id, x.policy.id].map(id => x.repos.memories.get(id)!);
    x.repos.runtime.rebindRawTurnEpisode(x.rawId, "episode_old_task", x.targetId);
    expect(x.repos.runtime.getRawTurn(x.rawId)).toMatchObject({ episodeId: x.targetId, userId: rawOwner });
    expect(x.repos.runtime.getEpisode(x.targetId)?.l1MemoryIds).toEqual(expect.arrayContaining([x.trace.id, x.span.id]));
    expect(x.repos.runtime.getEpisode(x.targetId)?.l2PolicyIds).toContain(x.policy.id);
    for (const old of before) {
      const current = x.repos.memories.get(old.id)!;
      expect(current).toMatchObject({ userId: old.userId, memoryValue: old.memoryValue, contentHash: old.contentHash });
      if (old.memoryLayer === "L1") expect(current.info.episode_id).toBe(x.targetId);
    }
    expect(x.repos.memories.get(x.span.id)?.properties.internal_info.span).toMatchObject({ episode_id: x.targetId });
    expect(x.repos.memories.get(x.trace.id)?.properties.internal_info.trace).toMatchObject({key:expect.stringMatching(/^episode_new_task:/u)});
    expect(x.service.getMemory(x.targetId).item.sourceMemoryIds).toEqual(expect.arrayContaining([x.trace.id, x.span.id]));
    expect(x.service.deletePanelTask("episode_old_task").deletedMemoryIds).not.toEqual(expect.arrayContaining([x.trace.id]));
    expect(x.repos.memories.get(x.trace.id)).toBeDefined();
    expect(x.repos.memories.get(x.span.id)).toBeDefined();
    const removed = x.service.deletePanelTask(x.targetId).deletedMemoryIds;
    expect(removed).toEqual(expect.arrayContaining([x.trace.id, x.span.id]));
  });
}

it.each(["cross-session", "missing-target", "raw-session", "raw-episode", "deleted", "redacted"] as const)(
  "rejects %s migration atomically", async invalid => {
    const x = await setup();
    if (invalid === "cross-session" || invalid === "raw-session") {
      const foreign = x.service.openSession({ namespace: { source: "codex", profileId: "default", sessionKey: "foreign" } });
      if (invalid === "cross-session") x.db.db.prepare("UPDATE episodes SET session_id=? WHERE id=?").run(foreign.sessionId, x.targetId);
      else x.db.db.prepare("UPDATE raw_turns SET session_id=? WHERE id=?").run(foreign.sessionId, x.rawId);
    }
    if (invalid === "raw-episode") x.db.db.prepare("UPDATE raw_turns SET episode_id=? WHERE id=?").run(x.targetId, x.rawId);
    if (invalid === "deleted" || invalid === "redacted") x.db.db.prepare(`UPDATE raw_turns SET ${invalid}_at='now' WHERE id=?`).run(x.rawId);
    const before = snapshot(x);
    expect(() => x.repos.runtime.rebindRawTurnEpisode(x.rawId, "episode_old_task", invalid === "missing-target" ? "missing" : x.targetId)).toThrow();
    expect(snapshot(x)).toEqual(before);
  }
);

it.each(["session", "raw", "episode", "parent", "missing-parent"] as const)("excludes conflicting %s provenance even if a caller supplies its ID", async invalid => {
  const x = await setup();
  const fake = { ...x.trace, id: "forged-memory", memoryKey: "forged-memory" };
  if (invalid === "session") fake.sessionId = x.service.openSession({ namespace: { source: "codex", profileId: "default", sessionKey: "forged" } }).sessionId;
  if (invalid === "raw") fake.info = { ...fake.info, raw_turn_id: "another-raw" };
  if (invalid === "episode") fake.info = { ...fake.info, episode_id: x.targetId };
  if (invalid === "parent" || invalid === "missing-parent") {
    fake.properties = { internal_info: { memory_layer: "L1", memory_kind: "span", span: {
      raw_turn_id: x.rawId, episode_id: "episode_old_task", source_trace_id: invalid === "missing-parent" ? "missing" : x.repos.runtime.getEpisode(x.targetId)!.l1MemoryIds[0]
    } } };
  }
  x.repos.memories.insert(fake);
  const before = x.repos.memories.getIncludingDeleted(fake.id);
  x.repos.runtime.moveTurnLinks({ rawTurnId: x.rawId, l1MemoryIds: [fake.id], fromEpisodeId: "episode_old_task", toEpisodeId: x.targetId });
  expect(x.repos.memories.getIncludingDeleted(fake.id)).toEqual(before);
  expect(x.repos.memories.get(x.trace.id)?.info.episode_id).toBe(x.targetId);
  expect(x.repos.runtime.getEpisode(x.targetId)?.l1MemoryIds).not.toContain(fake.id);
});

it("rolls back raw, memory, membership and jobs when a span update fails", async () => {
  const x = await setup();
  x.db.db.exec("CREATE TRIGGER fail_migration BEFORE UPDATE ON memories WHEN new.id='migration-span' BEGIN SELECT RAISE(ABORT,'span failure'); END");
  const before = snapshot(x);
  expect(() => x.repos.runtime.moveTurnLinks({ rawTurnId: x.rawId, l1MemoryIds: [], fromEpisodeId: "episode_old_task", toEpisodeId: x.targetId })).toThrow("span failure");
  expect(snapshot(x)).toEqual(before);
});

it("keeps a rejected L1 tombstoned while migrating only its relationship metadata", async () => {
  const x = await setup();
  x.repos.memories.softDelete(x.trace.id);
  x.repos.runtime.rebindRawTurnEpisode(x.rawId, "episode_old_task", x.targetId);
  expect(x.repos.memories.getIncludingDeleted(x.trace.id)).toMatchObject({ deletedAt: expect.any(String), userId: "legacy-trace", info: { episode_id: x.targetId } });
  expect(x.repos.memories.get(x.trace.id)).toBeUndefined();
});

it("makes first binding and repeated binding idempotent with mixed historical owners", async () => {
  const x = await setup();
  x.db.db.prepare("UPDATE raw_turns SET episode_id=NULL WHERE id=?").run(x.rawId);
  for (const id of [x.trace.id,x.span.id]) x.db.db.prepare(`UPDATE memories SET
    info_json=json_remove(info_json,'$.episode_id'),
    properties_json=json_remove(properties_json,'$.info.episode_id','$.internal_info.trace.episode_id','$.internal_info.span.episode_id') WHERE id=?`).run(id);
  const at=new Date().toISOString();
  x.repos.runtime.bindRawTurnEpisode(x.rawId,x.targetId,at);
  expect(x.repos.runtime.getEpisode(x.targetId)?.l1MemoryIds).toEqual(expect.arrayContaining([x.trace.id,x.span.id]));
  const after=snapshot(x);
  x.repos.runtime.bindRawTurnEpisode(x.rawId,x.targetId,at);
  expect(snapshot(x)).toEqual(after);
});

it("keeps indexed candidate lookup for new first bindings, including parent-only spans", async () => {
  const x=await setup();
  const raw=x.repos.runtime.getRawTurn(x.rawId)!;
  expect(raw.messagePayload?.captured_memory_ids).toEqual(expect.arrayContaining([x.trace.id,x.span.id]));
  x.db.db.prepare("UPDATE raw_turns SET episode_id=NULL WHERE id=?").run(x.rawId);
  const prepare=vi.spyOn(x.db.db,"prepare");
  x.repos.runtime.bindRawTurnEpisode(x.rawId,"episode_old_task",new Date().toISOString());
  const sql=prepare.mock.calls.map(([sql])=>sql).find(sql=>sql.includes("json_each(@ids) candidates CROSS JOIN memories"));
  prepare.mockRestore();
  expect(sql).toBeDefined();
  const plan=x.db.db.prepare("EXPLAIN QUERY PLAN "+sql!).all({raw:x.rawId,ids:JSON.stringify(raw.messagePayload!.captured_memory_ids)}) as Array<{detail:string}>;
  expect(plan.some(row=>row.detail.includes("SEARCH m USING INDEX sqlite_autoindex_memories_1"))).toBe(true);
  expect(plan.some(row=>row.detail.startsWith("SCAN m"))).toBe(false);
});

it.each(["direct","binding"] as const)("preserves other-session attachments and policies during %s migration", async entry => {
  const x=await setup();
  const foreign=x.service.openSession({namespace:{source:"codex",profileId:"default",sessionKey:"foreign-links"}}).sessionId;
  const artifact=x.repos.runtime.insertArtifact({sessionId:foreign,episodeId:"episode_old_task",rawTurnId:x.rawId,userId:"foreign",kind:"tool_call",payload:{},createdAt:new Date().toISOString()});
  const fakePolicy={...x.policy,id:"foreign-policy",memoryKey:"foreign-policy",sessionId:foreign};
  x.repos.memories.insert(fakePolicy);
  x.db.db.prepare("INSERT OR IGNORE INTO trace_policy_links(id,user_id,l1_memory_id,l2_memory_id,relation,strength,created_at) VALUES('foreign-link','foreign',?,?,'supports',1,'now')").run(x.trace.id,fakePolicy.id);
  x.db.db.prepare("INSERT INTO feedback(id,user_id,session_id,episode_id,raw_turn_id,channel,polarity,created_at) VALUES('foreign-feedback','foreign',?,'episode_old_task',?,'explicit','neutral','now')").run(foreign,x.rawId);
  const before=x.db.db.prepare("SELECT * FROM artifacts WHERE id=?").get(artifact);
  expect(before).toBeDefined();
  if(entry==="direct")x.repos.runtime.moveTurnLinks({rawTurnId:x.rawId,l1MemoryIds:[],fromEpisodeId:"episode_old_task",toEpisodeId:x.targetId});
  else x.repos.runtime.bindRawTurnEpisode(x.rawId,x.targetId,new Date().toISOString());
  expect(x.db.db.prepare("SELECT * FROM artifacts WHERE id=?").get(artifact)).toEqual(before);
  expect(x.db.db.prepare("SELECT episode_id FROM feedback WHERE id='foreign-feedback'").get()).toEqual({episode_id:"episode_old_task"});
  expect(x.repos.runtime.getEpisode(x.targetId)?.l2PolicyIds).not.toContain(fakePolicy.id);
  expect(x.repos.runtime.getEpisode(x.targetId)?.feedbackIds).not.toContain("foreign-feedback");
});
