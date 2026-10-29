import { afterEach, describe, expect, it } from "vitest";
import { createMemoryServiceFixture } from "../fixtures/memory-service-fixture.js";
import { Repositories } from "../../src/storage/repositories.js";
import { panelSafetyToken } from "../../src/storage/panel-security.js";
import { createLocalOwnerFixture } from "../fixtures/panel-local-owners.js";
import { PanelBrowse } from "../../src/service/panel/browse.js";
import { MemoryDb } from "../../src/storage/db.js";
const ownerFixture=createMemoryServiceFixture();
const { cleanup, createTestService } = ownerFixture;
afterEach(cleanup);
async function pendingCapture(status: string | null = "selected") {
  const fixture = createTestService();
  const repos = new Repositories(fixture.db.db);
  const session = fixture.service.openSession({ namespace: { userId: "owner", source: "codex", profileId: "default" } });
  const turn = await fixture.service.completeTurn("seed", { sessionId: session.sessionId, query: "question", answer: "answer" });
  const raw = repos.runtime.getRawTurn(turn.rawTurnId)!;
  const episode = repos.runtime.getEpisode(raw.episodeId)!;
  const pending = repos.runtime.insertRawTurn({ ...raw, id: "pending", turnId: "pending", episodeId: undefined,
    messagePayload: status === null ? {} : { episode_assignment: { status } } });
  return { ...fixture, repos, pending, episode };
}
describe("panel safety generations", () => {
  it.each(["pending", "selected"])("keeps normal %s first binding and same-task retries, but revokes an existing binding's move", async status => {
    const { db, repos, pending, episode } = await pendingCapture(status);
    const safety = panelSafetyToken(db.db);
    repos.runtime.bindRawTurnEpisode(pending.id, episode.id, episode.updatedAt);
    expect(panelSafetyToken(db.db)).toBe(safety);
    repos.runtime.bindRawTurnEpisode(pending.id, episode.id, episode.updatedAt);
    expect(panelSafetyToken(db.db)).toBe(safety);
    const target = repos.runtime.createEpisode({ ...episode, id: "target", l1MemoryIds: [], rawTurnIds: [], turnCount: 0 });
    repos.runtime.rebindRawTurnEpisode(pending.id, episode.id, target.id);
    expect(panelSafetyToken(db.db)).not.toBe(safety);
  });
  it.each([null, "assigned", "applying", "invalid"])("still revokes a legacy/orphan first binding without a pending capture (%s)", async status => {
    const { db, repos, pending, episode } = await pendingCapture(status);
    const safety = panelSafetyToken(db.db);
    repos.runtime.bindRawTurnEpisode(pending.id, episode.id, episode.updatedAt);
    expect(panelSafetyToken(db.db)).not.toBe(safety);
  });
  it.each(["delete", "redact", "owner", "target owner", "target session", "session"])("does not exempt a first binding combined with a %s change", async change => {
    const { db, repos, pending, episode, service } = await pendingCapture();
    let target = episode.id;
    if (change === "target owner" || change === "target session") {
      const sessionId = change === "target session" ? service.openSession({}).sessionId : episode.sessionId;
      target = repos.runtime.createEpisode({ ...episode, id: "different-scope", sessionId,
        userId: change === "target owner" ? "other" : episode.userId, l1MemoryIds: [], rawTurnIds: [], turnCount: 0 }).id;
    }
    const extra = change === "delete" ? ",deleted_at='now'" : change === "redact" ? ",redacted_at='now'"
      : change === "owner" ? ",user_id='other'" : change === "session" ? ",session_id=@session" : "";
    const session = change === "session" ? service.openSession({}).sessionId : episode.sessionId;
    const safety = panelSafetyToken(db.db);
    db.db.prepare(`UPDATE raw_turns SET episode_id=@target${extra} WHERE id=@id`).run({ target, session, id: pending.id });
    expect(panelSafetyToken(db.db)).not.toBe(safety);
  });
  it.each(["pending","selected"])("preserves NULL-owner %s first binding but still revokes rebinds and privacy changes",async status=>{
    const {db,repos,turns}=await createLocalOwnerFixture(ownerFixture),turn=turns[2]!;
    const episode=repos.runtime.getEpisode(turn.episodeId!)!;
    db.db.prepare("UPDATE raw_turns SET episode_id=NULL,message_payload_json=json_set(message_payload_json,'$.episode_assignment.status',?) WHERE id=?").run(status,turn.rawTurnId);
    const safety=panelSafetyToken(db.db);
    repos.runtime.bindRawTurnEpisode(turn.rawTurnId,episode.id,episode.updatedAt);
    expect(panelSafetyToken(db.db)).toBe(safety);
    repos.runtime.bindRawTurnEpisode(turn.rawTurnId,episode.id,episode.updatedAt);
    expect(panelSafetyToken(db.db)).toBe(safety);
    const target=repos.runtime.createEpisode({...episode,id:"new-null-target",l1MemoryIds:[],rawTurnIds:[],turnCount:0});
    repos.runtime.rebindRawTurnEpisode(turn.rawTurnId,episode.id,target.id);
    expect(panelSafetyToken(db.db)).not.toBe(safety);
    const rebound=panelSafetyToken(db.db);
    db.db.prepare("UPDATE raw_turns SET redacted_at='now' WHERE id=?").run(turn.rawTurnId);
    expect(panelSafetyToken(db.db)).not.toBe(rebound);
  });
  it.each(["raw session","memory session"])("revokes cached pages when the %s changes",async change=>{
    const {db,turns}=await createLocalOwnerFixture(ownerFixture),turn=turns[0]!;
    const before=panelSafetyToken(db.db);
    if(change==="raw session")db.db.prepare("UPDATE raw_turns SET session_id=? WHERE id=?").run(turns[1]!.sessionId,turn.rawTurnId);
    else db.db.prepare("UPDATE memories SET session_id=? WHERE id=?").run(turns[1]!.sessionId,turn.l1MemoryId);
    expect(panelSafetyToken(db.db)).not.toBe(before);
  });
  it("does not exempt a NULL-owner first binding to a different historical owner",async()=>{
    const {db,repos,turns}=await createLocalOwnerFixture(ownerFixture),turn=turns[2]!;
    const episode=repos.runtime.getEpisode(turn.episodeId!)!;
    const wrong=repos.runtime.createEpisode({...episode,id:"wrong-owner-target",userId:"a",l1MemoryIds:[],rawTurnIds:[],turnCount:0});
    db.db.prepare("UPDATE raw_turns SET episode_id=NULL,message_payload_json=json_set(message_payload_json,'$.episode_assignment.status','pending') WHERE id=?").run(turn.rawTurnId);
    const before=panelSafetyToken(db.db);
    db.db.prepare("UPDATE raw_turns SET episode_id=? WHERE id=?").run(wrong.id,turn.rawTurnId);
    expect(panelSafetyToken(db.db)).not.toBe(before);
  });
  it("replaces an existing v14 trigger without changing its safety token or facts", async () => {
    const { db, repos, pending, episode } = await pendingCapture();
    db.db.exec(`DROP TRIGGER panel_safety_raw_turns_update;
      CREATE TRIGGER panel_safety_raw_turns_update AFTER UPDATE ON raw_turns
      WHEN OLD.episode_id IS NOT NEW.episode_id BEGIN
        UPDATE runtime_kv SET value_json='"old-trigger"' WHERE key='panel_safety_token';
      END`);
    const safety = panelSafetyToken(db.db);
    const reopened = new MemoryDb({ path: db.path });
    reopened.close();
    expect(db.schemaVersion().version).toBe(14);
    expect(panelSafetyToken(db.db)).toBe(safety);
    repos.runtime.bindRawTurnEpisode(pending.id, episode.id, episode.updatedAt);
    expect(panelSafetyToken(db.db)).toBe(safety);
    db.db.prepare("UPDATE raw_turns SET redacted_at='now' WHERE id=?").run(pending.id);
    expect(panelSafetyToken(db.db)).not.toBe(safety);
  });
  it("never returns to an old token after empty clears or importing an old runtime key", () => {
    const { db } = createTestService();
    const repos = new Repositories(db.db);
    const tokens = [panelSafetyToken(db.db)];
    for (let i = 0; i < 3; i++) {
      repos.clearAllMemoryData();
      tokens.push(panelSafetyToken(db.db));
    }
    repos.runtime.importBundleTables(
      { runtime_kv: [{ key: "panel_safety_token", value_json: tokens[0], updated_at: "2026-10-27T00:00:00Z" }] },
      { conflictStrategy: "replace" }
    );
    tokens.push(panelSafetyToken(db.db));
    expect(tokens).not.toContain("missing");
    expect(new Set(tokens).size).toBe(tokens.length);
  });
  it("invalidates owner changes and restores but not ordinary L3 counters", () => {
    const { db, service } = createTestService();
    const repos = new Repositories(db.db);
    const added = service.addMemory({ content: "test", source: "codex" });
    const memory = repos.memories.get(added.id)!;
    db.db
      .prepare(
        "INSERT INTO l3_world_model_scopes(scope_key,user_id,project_id,updated_at) VALUES('scope','owner','project','now')"
      )
      .run();
    const before = panelSafetyToken(db.db);
    db.db.prepare("UPDATE l3_world_model_scopes SET next_scope_seq=next_scope_seq+1,updated_at='later'").run();
    expect(panelSafetyToken(db.db)).toBe(before);
    db.db.prepare("UPDATE l3_world_model_scopes SET user_id='other'").run();
    const changed = panelSafetyToken(db.db);
    expect(changed).not.toBe(before);
    service.deleteMemory(memory.id);
    const deleted = panelSafetyToken(db.db);
    db.db.prepare("UPDATE memories SET status='activated',deleted_at=NULL WHERE id=?").run(memory.id);
    expect(panelSafetyToken(db.db)).not.toBe(deleted);
  });
  it("cannot publish a delayed worker page after clear even if change seq resets", async () => {
    let safety = "before";
    let finish!: (result: { safety: string; data: unknown }) => void;
    const browse = new PanelBrowse({
      safety: () => safety,
      change: () => 0,
      read: async <T>(method: string) =>
        method === "members"
          ? { safety, data: ["id"] as T }
          : new Promise<{ safety: string; data: T }>((resolve) => {
              finish = resolve as typeof finish;
            })
    });
    const created = browse.create({});
    await Promise.resolve();
    await Promise.resolve();
    safety = "after-clear";
    finish({ safety: "before", data: { items: [] } });
    await expect(created).rejects.toThrow("expired");
  });
  it("rolls back import invalidation together with a failed write", () => {
    const { db } = createTestService();
    const repos = new Repositories(db.db);
    const before = panelSafetyToken(db.db);
    expect(() =>
      repos.runtime.importBundleTables(
        { runtime_kv: [{ key: "broken", value_json: "not-json", updated_at: "now" }] },
        { conflictStrategy: "replace" }
      )
    ).toThrow();
    expect(panelSafetyToken(db.db)).toBe(before);
  });
});
