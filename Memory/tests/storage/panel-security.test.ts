import { afterEach, describe, expect, it } from "vitest";
import { createMemoryServiceFixture } from "../fixtures/memory-service-fixture.js";
import { Repositories } from "../../src/storage/repositories.js";
import { panelSafetyToken } from "../../src/storage/panel-security.js";
import { PanelBrowse } from "../../src/service/panel/browse.js";
const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(cleanup);
describe("panel safety generations", () => {
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
