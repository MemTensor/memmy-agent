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
describe("declared memory relationships", () => {
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
});
