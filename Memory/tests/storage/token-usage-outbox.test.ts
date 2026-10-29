import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryDb } from "../../src/index.js";
import { Repositories } from "../../src/storage/repositories.js";
import { TokenUsageOutbox } from "../../src/storage/token-usage-outbox.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("token usage outbox", () => {
  it("reads events in sequence order and deletes only the confirmed id", () => {
    const { outbox } = createOutbox();
    outbox.enqueue("event-a", `{"id":"event-a"}`);
    outbox.enqueue("event-b", `{"id":"event-b"}`);
    outbox.enqueue("event-c", `{"id":"event-c"}`);

    expect(outbox.listNext(2)).toEqual([
      { eventId: "event-a", payloadJson: `{"id":"event-a"}` },
      { eventId: "event-b", payloadJson: `{"id":"event-b"}` }
    ]);
    outbox.deleteByEventId("event-a");
    expect(outbox.listNext(10).map((row) => row.eventId)).toEqual(["event-b", "event-c"]);
    expect(outbox.hasPending()).toBe(true);
    outbox.deleteByEventId("event-b");
    outbox.deleteByEventId("event-c");
    expect(outbox.hasPending()).toBe(false);
    expect(outbox.listNext(10)).toEqual([]);
  });

  it("does not drop pending usage when memory content is cleared", () => {
    const { db, outbox } = createOutbox();
    outbox.enqueue("event-keep", `{"id":"event-keep"}`);
    new Repositories(db.db).clearAllMemoryData();
    expect(outbox.listNext(1)).toEqual([
      { eventId: "event-keep", payloadJson: `{"id":"event-keep"}` }
    ]);
  });

  it("creates the outbox on upgrade from schema v8 and leaves existing memories", () => {
    const root = createRoot();
    const dbPath = join(root, "memory.sqlite");
    const seeded = new MemoryDb({ path: dbPath });
    seeded.db.prepare(
      `INSERT INTO memories (
         id, timeline, user_id, memory_type, status, visibility, memory_value,
         tags_json, info_json, properties_json, memory_layer, version, created_at, updated_at
       ) VALUES (?, 't', 'u', 'LongTermMemory', 'activated', 'private', 'keep',
                 '[]', '{}', '{}', 'L1', 1, ?, ?)`
    ).run("memory-keep", "2026-09-20T00:00:00.000Z", "2026-09-20T00:00:00.000Z");
    seeded.db.exec(`
      DROP TABLE token_usage_outbox;
      DELETE FROM schema_migrations;
      INSERT INTO schema_migrations (id, version, applied_at, checksum)
      VALUES ('008_source_turn_captures', 8, '2026-09-20T00:00:00.000Z', 'v8');
    `);
    seeded.close();

    const upgraded = new MemoryDb({ path: dbPath });
    expect(upgraded.schemaVersion()).toMatchObject({
      version: 9,
      lastMigrationId: "009_token_usage_outbox"
    });
    expect(upgraded.db.prepare(`SELECT id FROM memories`).get()).toEqual({ id: "memory-keep" });
    expect(upgraded.db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'token_usage_outbox'`
    ).get()).toEqual({ name: "token_usage_outbox" });
    expect(upgraded.db.prepare(`SELECT COUNT(*) AS count FROM token_usage_outbox`).get()).toEqual({ count: 0 });
    upgraded.close();

    const reopened = new MemoryDb({ path: dbPath });
    expect(reopened.schemaVersion().version).toBe(9);
    expect(reopened.db.prepare(`SELECT COUNT(*) AS count FROM memories`).get()).toEqual({ count: 1 });
    reopened.close();
  });
});

function createOutbox(): { db: MemoryDb; outbox: TokenUsageOutbox } {
  const root = createRoot();
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  return { db, outbox: new TokenUsageOutbox(db.db) };
}

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-token-outbox-"));
  roots.push(root);
  return root;
}
