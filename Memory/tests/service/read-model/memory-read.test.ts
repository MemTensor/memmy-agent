import { afterEach, describe, expect, it } from "vitest";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const {
  cleanup,
  createTestService
} = createMemoryServiceFixture();

afterEach(cleanup);

describe("MemoryService / read model / memory detail", () => {
  it("omits incomplete L1 trace payloads from memory detail", () => {
    const { db, service } = createTestService();
    const namespace = {
      source: "codex",
      profileId: "default",
      userId: "detail-trace-user"
    };
    const session = service.openSession({ namespace });
    const complete = service.completeTurn("turn-detail-empty-trace", {
      sessionId: session.sessionId,
      query: "remember incomplete detail trace",
      answer: "detail payload should not include empty trace ids"
    });
    const row = db.db.prepare(
      `SELECT info_json, properties_json
       FROM memories
       WHERE id = ?`
    ).get(complete.l1MemoryId) as { info_json: string; properties_json: string };
    const info = JSON.parse(row.info_json) as Record<string, unknown>;
    delete info.episode_id;
    delete info.raw_turn_id;
    delete info.turn_id;
    const properties = JSON.parse(row.properties_json) as {
      internal_info?: Record<string, unknown>;
    };
    properties.internal_info = {
      ...(properties.internal_info ?? {}),
      source_raw_turn_id: "",
      raw_turn_id: "",
      source_memory_ids: ["", "source-memory-1", "   "],
      trace: {
        episode_id: "",
        raw_turn_id: "",
        turn_id: ""
      }
    };
    db.db.prepare(
      `UPDATE memories
       SET info_json = ?,
           properties_json = ?
       WHERE id = ?`
    ).run(JSON.stringify(info), JSON.stringify(properties), complete.l1MemoryId);

    const detail = service.getMemory(complete.l1MemoryId, { namespace });
    expect(detail.item.sourceMemoryIds).toEqual(["source-memory-1"]);
    expect("trace" in detail.item).toBe(false);

    db.close();
  });
});
