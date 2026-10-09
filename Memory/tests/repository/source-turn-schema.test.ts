import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryDb, SCHEMA_VERSION } from "../../src/index.js";
import { Repositories } from "../../src/storage/repositories.js";
import { createMemoryServiceFixture } from "../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(cleanup);

describe("source turn schema upgrade", () => {
  it("upgrades v7 without changing old memories and keeps its activation boundary after reopen", () => {
    const { db, service, root } = createTestService();
    const session = service.openSession({});
    service.completeTurn("old-turn", { sessionId: session.sessionId, query: "Implement a schema migration safely.", answer: "Existing data is preserved by the migration." });
    const before = db.db.prepare("SELECT * FROM memories ORDER BY id").all();
    db.db.exec(`DROP TABLE source_turn_captures;
      DELETE FROM runtime_kv WHERE key = 'source_turn_capture_activated_at';
      DELETE FROM schema_migrations;
      INSERT INTO schema_migrations VALUES ('007_memory_capture_claims', 7, '2026-01-01', 'old-v7');`);
    const path = join(root, "memory.sqlite");
    db.close();
    const upgraded = new MemoryDb({ path });
    const activation = new Repositories(upgraded.db).runtime.getKv("source_turn_capture_activated_at");
    expect(activation?.value).toEqual(expect.any(String));
    expect(upgraded.schemaVersion().version).toBe(SCHEMA_VERSION);
    expect(upgraded.db.prepare("SELECT * FROM memories ORDER BY id").all()).toEqual(before);
    expect(upgraded.db.prepare("SELECT COUNT(*) AS count FROM source_turn_captures").get()).toEqual({ count: 0 });
    expect(existsSync(`${path}.pre-v${SCHEMA_VERSION}.bak`)).toBe(true);
    upgraded.close();
    const reopened = new MemoryDb({ path });
    try { expect(new Repositories(reopened.db).runtime.getKv("source_turn_capture_activated_at")).toEqual(activation); }
    finally { reopened.close(); }
  });

  it("enforces source uniqueness across separate database connections", () => {
    const { db, root } = createTestService();
    const second = new MemoryDb({ path: join(root, "memory.sqlite") });
    const capture = {
      userId: "user-a", source: "codex", profileId: "default", namespaceKey: "scope-a",
      conversationId: "conversation-a", turnId: "turn-a", contentHash: "same-content",
      startedAt: "2099-01-01T10:00:00.000Z", completedAt: "2099-01-01T10:01:00.000Z", createdAt: "2099-01-01T10:01:00.000Z",
      response: { status: "rejected" as const, reason: "capture_policy" }
    };
    try {
      new Repositories(db.db).runtime.insertSourceTurnCapture(capture);
      expect(() => new Repositories(second.db).runtime.insertSourceTurnCapture(capture)).toThrow(/UNIQUE constraint/);
      expect(new Repositories(second.db).runtime.getSourceTurnCapture(capture, capture.turnId)?.response).toEqual(capture.response);
    } finally { second.close(); }
  });
});
