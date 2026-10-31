import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryServiceFixture } from "../fixtures/memory-service-fixture.js";
import { Repositories } from "../../src/storage/repositories.js";

const fixture = createMemoryServiceFixture();
afterEach(async () => { vi.restoreAllMocks(); await fixture.cleanup(); });

async function setup(scoped = true) {
  const { service, db } = fixture.createTestService();
  const repos = new Repositories(db.db);
  const session = service.openSession({ namespace: { userId: "lookup-owner", source: "codex", profileId: "default" } });
  const turn = await service.completeTurn("seed", { sessionId: session.sessionId, query: "Implement lookup", answer: "Verified outcome" });
  const seedRaw = repos.runtime.getRawTurn(turn.rawTurnId)!;
  const raw = repos.runtime.insertRawTurn({ ...seedRaw, id: "lookup-pending", turnId: "lookup-pending", episodeId: undefined,
    messagePayload: { ...(scoped ? { captured_memory_ids: [] } : {}), episode_assignment: { status: "selected" } } });
  const seed = repos.memories.getIncludingDeleted(turn.l1MemoryId)!;
  const add = (id: string, overrides: Record<string, unknown> = {}) => repos.memories.insert({ ...seed,
    id, memoryKey: id, contentHash: undefined,
    info: JSON.parse(String(overrides.info_json ?? JSON.stringify({ raw_turn_id: raw.id }))),
    properties: { ...seed.properties, internal_info: {}, ...JSON.parse(String(overrides.properties_json ?? "{}")) },
    sessionId: overrides.session_id === null ? undefined : String(overrides.session_id ?? seed.sessionId),
    status: (overrides.status ?? seed.status) as typeof seed.status,
    deletedAt: overrides.deleted_at as string | undefined,
    memoryLayer: (overrides.memory_layer ?? seed.memoryLayer) as typeof seed.memoryLayer
  });
  const episode = repos.runtime.getEpisode(seedRaw.episodeId)!;
  return { service, db, repos, raw, add, episode, session };
}

describe("first binding lookup through existing indexes", () => {
  it("finds all same-session traces, old JSON fields and unscoped tombstones through primary keys", async () => {
    const { db, repos, raw, add } = await setup();
    add("direct");
    add("span", { info_json: "{}", properties_json: JSON.stringify({ internal_info: { memory_kind: "span", trace: { raw_turn_id: raw.id } } }) });
    add("old-unscoped", { session_id: null });
    add("deleted", { status: "deleted", deleted_at: "2026-10-29T00:00:00Z" });
    add("other-session", { session_id: "unrelated-session", info_json: "{}" });
    const prepare = vi.spyOn(db.db, "prepare");
    expect(repos.runtime.l1MemoryIdsForRawTurn(raw.id).sort()).toEqual(["direct", "span", "old-unscoped", "deleted"].sort());
    const lookup = prepare.mock.calls.map(x => x[0]).find(sql => sql.includes("id = @id AND memory_layer"))!;
    prepare.mockRestore();
    expect(lookup, "new captures must use existing primary-key indexes").toBeDefined();
    const plan = db.db.prepare("EXPLAIN QUERY PLAN " + lookup).all({ raw: raw.id, id: "direct" }) as Array<{ detail: string }>;
    expect(plan.filter(x => x.detail.includes("SEARCH memories"))).toHaveLength(1);
    expect(plan.filter(x => x.detail.includes("SEARCH memories")).every(x => x.detail.includes("sqlite_autoindex_memories_1"))).toBe(true);
  });

  it("keeps the complete legacy lookup when old captures lack scope metadata", async () => {
    const { repos, raw, add } = await setup(false);
    add("legacy-no-session", { session_id: null });
    add("legacy-session", { session_id: "old-import-session" });
    expect(repos.runtime.l1MemoryIdsForRawTurn(raw.id).sort()).toEqual(["legacy-no-session", "legacy-session"]);
  });

  it("falls back safely for malformed capture metadata", async () => {
    const { db, repos, raw, add } = await setup();
    add("old-reference", { session_id: "old-import-session" });
    db.db.prepare("UPDATE raw_turns SET message_payload_json=? WHERE id=?").run(JSON.stringify({ captured_memory_ids: [123] }), raw.id);
    expect(repos.runtime.l1MemoryIdsForRawTurn(raw.id)).toEqual(["old-reference"]);
  });

  it("preserves write-maintained IDs across stale raw updates and rolls links back with failed writes", async () => {
    const { repos, raw, add } = await setup();
    add("kept");
    repos.runtime.updateRawTurn({ ...raw, messagePayload: { ...raw.messagePayload, status_note: "stale" } });
    expect(repos.runtime.l1MemoryIdsForRawTurn(raw.id)).toEqual(["kept"]);
    expect(() => repos.transaction(() => { add("rollback"); throw Error("abort write"); })).toThrow("abort write");
    expect(repos.runtime.getRawTurn(raw.id)!.messagePayload?.captured_memory_ids).toEqual(["kept"]);
    const memory = repos.memories.get("kept")!;
    repos.memories.update({ ...memory, info: { raw_turn_id: "moved" } });
    expect(repos.runtime.l1MemoryIdsForRawTurn(raw.id)).toEqual([]);
  });

  it("updates jobs by raw-turn and all-layer target provenance without a nested memories scan", async () => {
    const { db, repos, raw, add, episode } = await setup();
    add("trace-target");
    add("derived-target", { memory_layer: "L2" });
    add("unrelated", { info_json: "{}" });
    for (const [id, target, payload] of [
      ["job-raw", null, { rawTurnId: raw.id }],
      ["job-trace", "trace-target", {}],
      ["job-derived", "derived-target", {}],
      ["job-other", "unrelated", {}]
    ] as const) db.db.prepare("INSERT INTO evolution_jobs(id,job_type,status,user_id,session_id,target_memory_id,payload_json,created_at,updated_at) VALUES(?,'embedding','queued',?,?,?,?,?,?)")
      .run(id, raw.userId, raw.sessionId, target, JSON.stringify(payload), episode.updatedAt, episode.updatedAt);
    const prepare = vi.spyOn(db.db, "prepare");
    repos.transaction(() => repos.runtime.bindRawTurnEpisode(raw.id, episode.id, episode.updatedAt));
    const statements = prepare.mock.calls.map(x => x[0]); prepare.mockRestore();
    expect(statements.some(sql => sql.includes("UPDATE evolution_jobs") && sql.includes("SELECT id FROM memories"))).toBe(false);
    expect(db.db.prepare("SELECT id,episode_id FROM evolution_jobs WHERE id LIKE 'job-%' ORDER BY id").all()).toEqual([
      { id: "job-derived", episode_id: episode.id }, { id: "job-other", episode_id: null },
      { id: "job-raw", episode_id: episode.id }, { id: "job-trace", episode_id: episode.id }
    ]);
    expect(repos.memories.getIncludingDeleted("trace-target")?.info.episode_id).toBe(episode.id);
  });

  it("does not trust an older imported raw ID list over retained target memories", async () => {
    const { db, repos, raw, add } = await setup();
    add("first");
    const olderRaw = db.db.prepare("SELECT * FROM raw_turns WHERE id=?").get(raw.id);
    add("later");
    repos.runtime.importBundleTables({ raw_turns: [olderRaw] }, { conflictStrategy: "replace" });
    expect(repos.runtime.getRawTurn(raw.id)!.messagePayload?.captured_memory_ids).toBeUndefined();
    expect(repos.runtime.l1MemoryIdsForRawTurn(raw.id).sort()).toEqual(["first", "later"]);
  });
});
