import { afterEach, describe, expect, it } from "vitest";
import { createMemoryServiceFixture } from "../fixtures/memory-service-fixture.js";
import { Repositories } from "../../src/storage/repositories.js";
import { effectiveEpisodeMemoryIds, repairMemoryRelations } from "../../src/storage/memory-relations.js";
const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(cleanup);
function setup() {
  const fixture = createTestService();
  const repos = new Repositories(fixture.db.db);
  const session = fixture.service.openSession({
    namespace: { userId: "owner", source: "codex", profileId: "default" }
  });
  const turn = fixture.service.completeTurn("turn", {
    sessionId: session.sessionId,
    query: "question",
    answer: "answer"
  });
  const raw = repos.runtime.listRawTurnsByEpisode(turn.episodeId)[0]!;
  const trace = repos.memories.get(turn.l1MemoryId)!;
  const episode = repos.runtime.getEpisode(turn.episodeId)!;
  return { ...fixture, repos, raw, trace, episode };
}
function withSpan() {
  const fixture=setup(), {repos,raw,trace,episode}=fixture;
  const span={...trace,id:"owned-span",memoryKey:"owned-span",info:{raw_turn_id:raw.id,episode_id:episode.id},
    properties:{...trace.properties,internal_info:{memory_layer:"L1" as const,memory_kind:"span" as const,
      span:{episode_id:episode.id,raw_turn_id:raw.id,source_trace_id:trace.id}}}};
  repos.memories.insert(span);
  const target={...episode,id:"span-target",l1MemoryIds:[],rawTurnIds:[],turnCount:0};
  repos.runtime.createEpisode(target);
  return {...fixture,span,target};
}
describe("declared memory relationships", () => {
  it.each(["visible","redacted","deleted","missing"])("preserves moved spans through %s sources and deletes them with the current task",state=>{
    const {db,service,repos,raw,trace,episode,span,target}=withSpan();
    repos.runtime.rebindRawTurnEpisode(raw.id,episode.id,target.id);
    expect(repos.memories.get(span.id)?.properties.internal_info.span).toMatchObject({episode_id:target.id});
    // A historical stale span must still use the current raw/trace ownership.
    db.db.prepare("UPDATE memories SET properties_json=json_set(properties_json,'$.internal_info.span.episode_id',?) WHERE id=?").run(episode.id,span.id);
    if(state==="missing")db.db.prepare("DELETE FROM raw_turns WHERE id=?").run(raw.id);
    else if(state!=="visible")service.redactRawTurn(raw.id,{mode:state==="deleted"?"delete":"redact"});
    expect(service.deletePanelTask(episode.id).deletedMemoryIds).not.toContain(span.id);
    expect(repos.memories.get(span.id)).toBeDefined();
    expect(repos.memories.get(trace.id)).toBeDefined();
    const removed=service.deletePanelTask(target.id).deletedMemoryIds;
    expect(removed).toEqual(expect.arrayContaining([trace.id,span.id]));
    expect(repos.memories.getIncludingDeleted(span.id)?.deletedAt).toBeDefined();
  });

  it("uses a parent trace's current ownership for a legacy span without a direct raw reference",()=>{
    const {service,repos,raw,trace,episode,span,target}=withSpan();
    repos.memories.update({...span,info:{episode_id:episode.id},properties:{internal_info:{memory_layer:"L1",memory_kind:"span",span:{episode_id:episode.id,source_trace_id:trace.id}}}});
    repos.runtime.rebindRawTurnEpisode(raw.id,episode.id,target.id);
    expect(repos.memories.get(span.id)?.properties.internal_info.span).toMatchObject({episode_id:target.id});
    expect(service.deletePanelTask(episode.id).deletedMemoryIds).not.toContain(span.id);
    expect(service.deletePanelTask(target.id).deletedMemoryIds).toContain(span.id);
    expect(repos.memories.getIncludingDeleted(span.id)?.deletedAt).toBeDefined();
  });

  it("rolls back all raw, trace and span ownership when rebinding fails",()=>{
    const {db,repos,raw,trace,episode,span,target}=withSpan();
    db.db.exec("CREATE TRIGGER fail_span_rebind BEFORE UPDATE ON memories WHEN new.id='owned-span' BEGIN SELECT RAISE(ABORT,'rebind failure'); END");
    expect(()=>repos.runtime.rebindRawTurnEpisode(raw.id,episode.id,target.id)).toThrow("rebind failure");
    expect(repos.runtime.getRawTurn(raw.id)?.episodeId).toBe(episode.id);
    expect(repos.memories.get(trace.id)?.info.episode_id).toBe(episode.id);
    expect(repos.memories.get(span.id)?.properties.internal_info.span).toMatchObject({episode_id:episode.id});
    expect(repos.runtime.getEpisode(target.id)?.l1MemoryIds).toEqual([]);
  });

  it.each(["trace","raw"])("does not delete spans with a foreign %s owner",source=>{
    const {service,repos,raw,trace,episode,span}=withSpan();
    if(source==="trace"){
      repos.memories.insert({...trace,id:"foreign-parent",memoryKey:"foreign-parent",userId:"other-owner"});
      repos.memories.update({...span,properties:{...span.properties,internal_info:{...span.properties.internal_info,
        span:{...span.properties.internal_info.span,source_trace_id:"foreign-parent"}}}});
    }else{
      repos.runtime.insertRawTurn({...raw,id:"foreign-source",turnId:"foreign-source",userId:"other-owner"});
      repos.memories.update({...span,info:{...span.info,raw_turn_id:"foreign-source"},properties:{...span.properties,
        internal_info:{...span.properties.internal_info,span:{...span.properties.internal_info.span,raw_turn_id:"foreign-source"}}}});
    }
    expect(service.deletePanelTask(episode.id).deletedMemoryIds).not.toContain(span.id);
    expect(repos.memories.get(span.id)).toBeDefined();
  });

  it("rolls back span and trace deletion together if task deletion fails",()=>{
    const {db,service,repos,raw,trace,episode,span}=withSpan();
    db.db.exec("CREATE TRIGGER fail_span_task_delete BEFORE DELETE ON episodes BEGIN SELECT RAISE(ABORT,'delete failure'); END");
    expect(()=>service.deletePanelTask(episode.id)).toThrow("delete failure");
    for(const id of [span.id,trace.id]){
      expect(repos.memories.get(id)).toBeDefined();
      expect(repos.memories.getIncludingDeleted(id)?.deletedAt).toBeNull();
    }
    expect(repos.runtime.getRawTurn(raw.id)?.episodeId).toBe(episode.id);
  });

  it("does not rewrite another user's forged raw-turn references during rebind",()=>{
    const {repos,raw,trace,episode,target}=withSpan();
    repos.memories.insert({...trace,id:"foreign-rebind",memoryKey:"foreign-rebind",userId:"other-owner"});
    const before=repos.memories.getIncludingDeleted("foreign-rebind");
    repos.runtime.rebindRawTurnEpisode(raw.id,episode.id,target.id);
    expect(repos.memories.getIncludingDeleted("foreign-rebind")).toEqual(before);
  });

  it("moves effective L1 membership on raw-turn rebind while retaining old history", () => {
    const { db, repos, raw, trace, episode } = setup();
    const target = { ...episode, id: "target", l1MemoryIds: [], rawTurnIds: [], turnCount: 0 };
    repos.runtime.createEpisode(target);
    repos.runtime.rebindRawTurnEpisode(raw.id, episode.id, target.id);
    const episodes = [repos.runtime.getEpisode(episode.id)!, repos.runtime.getEpisode(target.id)!];
    expect(episodes[0]!.l1MemoryIds).toContain(trace.id);
    expect(episodes[1]!.l1MemoryIds).toContain(trace.id);
    const effective = effectiveEpisodeMemoryIds(db.db, episodes);
    expect(effective.get(episode.id)?.has(trace.id)).toBe(false);
    expect(effective.get(target.id)?.has(trace.id)).toBe(true);
    repos.runtime.rebindRawTurnEpisode(raw.id, target.id, episode.id);
    expect(repos.runtime.getEpisode(episode.id)!.l1MemoryIds.filter((id) => id === trace.id)).toHaveLength(1);
  });
  it("atomically maintains a later L2 and repairs reliable missing history idempotently", () => {
    const { db, repos, trace, episode } = setup();
    const policy = {
      ...trace,
      id: "policy-test",
      memoryLayer: "L2" as const,
      memoryKey: "policy-test",
      properties: {
        ...trace.properties,
        internal_info: { memory_layer: "L2" as const, source_trace_ids: [trace.id, trace.id] }
      }
    };
    repos.memories.insert(policy);
    expect(repos.runtime.listTracePolicyLinks({ l2MemoryId: policy.id })).toHaveLength(1);
    expect(repos.runtime.getEpisode(episode.id)!.l2PolicyIds).toContain(policy.id);
    db.db.prepare("DELETE FROM trace_policy_links WHERE l2_memory_id=?").run(policy.id);
    repairMemoryRelations(db.db);
    repairMemoryRelations(db.db);
    expect(repos.runtime.listTracePolicyLinks({ l2MemoryId: policy.id })).toHaveLength(1);
    expect(repos.runtime.getEpisode(episode.id)!.l2PolicyIds.filter((id) => id === policy.id)).toHaveLength(1);
  });
  it("rolls back the memory when relation maintenance fails", () => {
    const { db, repos, trace } = setup();
    db.db.exec(
      "CREATE TRIGGER relation_failure BEFORE INSERT ON trace_policy_links BEGIN SELECT RAISE(ABORT,'relation failure'); END"
    );
    expect(() =>
      repos.memories.insert({
        ...trace,
        id: "policy-fail",
        memoryLayer: "L2",
        memoryKey: "failure",
        properties: {
          ...trace.properties,
          internal_info: { memory_layer: "L2" as const, source_trace_ids: [trace.id] }
        }
      })
    ).toThrow("relation failure");
    expect(repos.memories.get("policy-fail")).toBeUndefined();
  });
  it("never counts deleted, redacted, missing or moved endpoints when restoring history", () => {
    const { db, repos, raw, trace, episode } = setup();
    const dirty = { ...episode, l1MemoryIds: [trace.id, trace.id, "missing"] };
    expect(effectiveEpisodeMemoryIds(db.db, [dirty]).get(episode.id)?.size).toBe(1);
    db.db.prepare("UPDATE memories SET deleted_at='now' WHERE id=?").run(trace.id);
    expect(effectiveEpisodeMemoryIds(db.db, [dirty]).get(episode.id)?.size).toBe(0);
    db.db.prepare("UPDATE raw_turns SET redacted_at='now' WHERE id=?").run(raw.id);
    db.db.prepare("UPDATE memories SET deleted_at=NULL WHERE id=?").run(trace.id);
    expect(effectiveEpisodeMemoryIds(db.db, [dirty]).get(episode.id)?.size).toBe(0);
    db.db.prepare("UPDATE raw_turns SET redacted_at=NULL WHERE id=?").run(raw.id);
    repairMemoryRelations(db.db);
    expect(effectiveEpisodeMemoryIds(db.db, [dirty]).get(episode.id)?.size).toBe(1);
    db.db.prepare("UPDATE memories SET deleted_at='later' WHERE id=?").run(trace.id);
    repos.memories.insert({
      ...trace,
      id: "policy-late",
      memoryLayer: "L2",
      memoryKey: "late",
      properties: { ...trace.properties, internal_info: { memory_layer: "L2" as const, source_trace_ids: [trace.id] } }
    });
    expect(repos.runtime.listTracePolicyLinks({ l2MemoryId: "policy-late" })).toHaveLength(0);
  });
  it("deleting an old episode never deletes a trace moved to another episode", () => {
    const { db, service, repos, raw, trace, episode } = setup();
    const target = { ...episode, id: "episode-target", l1MemoryIds: [], rawTurnIds: [], turnCount: 0 };
    repos.runtime.createEpisode(target);
    repos.runtime.rebindRawTurnEpisode(raw.id, episode.id, target.id);
    expect(service.getMemory(episode.id).item.sourceMemoryIds).not.toContain(trace.id);
    const result = service.deletePanelTask(episode.id);
    expect(result.deletedMemoryIds).not.toContain(trace.id);
    expect(repos.memories.get(trace.id)).toBeDefined();
    expect(repos.runtime.getRawTurn(raw.id)?.episodeId).toBe(target.id);
    expect(
      effectiveEpisodeMemoryIds(db.db, [repos.runtime.getEpisode(target.id)!])
        .get(target.id)
        ?.has(trace.id)
    ).toBe(true);
  });

  it.each(["redacted", "deleted", "missing"])("deletes task-owned L1 after the raw source is %s", (state) => {
    const { db, service, repos, raw, trace, episode } = setup();
    if (state === "missing") db.db.prepare("DELETE FROM raw_turns WHERE id=?").run(raw.id);
    else service.redactRawTurn(raw.id, { mode: state === "deleted" ? "delete" : "redact" });
    const result = service.deletePanelTask(episode.id);
    expect(result.deletedMemoryIds).toContain(trace.id);
    expect(repos.memories.get(trace.id)).toBeUndefined();
    expect(repos.memories.getIncludingDeleted(trace.id)?.deletedAt).toBeDefined();
    expect(repos.runtime.getEpisode(episode.id)).toBeUndefined();
  });

  it("preserves a moved redacted trace until its current task is deleted", () => {
    const { service, repos, raw, trace, episode } = setup();
    const target = { ...episode, id: "redacted-target", l1MemoryIds: [], rawTurnIds: [], turnCount: 0 };
    repos.runtime.createEpisode(target);
    repos.runtime.rebindRawTurnEpisode(raw.id, episode.id, target.id);
    service.redactRawTurn(raw.id);
    expect(service.deletePanelTask(episode.id).deletedMemoryIds).not.toContain(trace.id);
    expect(repos.memories.get(trace.id)).toBeDefined();
    expect(service.deletePanelTask(target.id).deletedMemoryIds).toContain(trace.id);
    expect(repos.memories.get(trace.id)).toBeUndefined();
  });

  it("does not delete another user's L1 from a forged historical task reference", () => {
    const { db, service, repos, trace, episode } = setup();
    const foreign = { ...trace, id: "foreign-trace", memoryKey: "foreign-trace", userId: "other-owner" };
    repos.memories.insert(foreign);
    db.db.prepare("UPDATE episodes SET l1_memory_ids_json=? WHERE id=?")
      .run(JSON.stringify([trace.id, foreign.id]), episode.id);
    expect(service.deletePanelTask(episode.id).deletedMemoryIds).not.toContain(foreign.id);
    expect(repos.memories.get(foreign.id)).toBeDefined();
  });

  it("deletes a task-owned legacy trace without a raw-turn reference", () => {
    const { service, repos, trace, episode } = setup();
    repos.memories.insert({ ...trace, id: "legacy-owned", memoryKey: "legacy-owned", info: {},
      properties: { ...trace.properties, internal_info: { memory_layer: "L1", trace: { episode_id: episode.id } } } });
    expect(service.deletePanelTask(episode.id).deletedMemoryIds).toContain("legacy-owned");
    expect(repos.memories.get("legacy-owned")).toBeUndefined();
  });

  it("rolls back task-owned trace deletion when deleting the task fails", () => {
    const { db, service, repos, raw, trace, episode } = setup();
    service.redactRawTurn(raw.id);
    db.db.exec("CREATE TRIGGER fail_task_delete BEFORE DELETE ON episodes BEGIN SELECT RAISE(ABORT,'task failure'); END");
    expect(() => service.deletePanelTask(episode.id)).toThrow("task failure");
    expect(repos.memories.get(trace.id)).toBeDefined();
    expect(repos.runtime.getEpisode(episode.id)).toBeDefined();
  });
});
