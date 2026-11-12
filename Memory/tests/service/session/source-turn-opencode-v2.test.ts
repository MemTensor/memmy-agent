import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { buildSourceTurnRequest, createOpencodeDatabaseSource, readOpencodeSourceTurn } from "@memmy/agent-source-core";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(() => fixture.cleanup());

describe("OpenCode V2 live capture and historical scan", () => {
  it.each(["hook", "agent_source_scan"] as const)("stores consecutive turns once when %s arrives first", async (firstChannel) => {
    const native = new DatabaseSync(":memory:");
    const { db, service } = fixture.createTestService();
    try {
      native.exec("CREATE TABLE session_v2 (id TEXT, parent_id TEXT, directory TEXT, agent TEXT, time_created INTEGER); CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, data TEXT, seq INTEGER, time_created INTEGER)");
      native.exec("INSERT INTO session_v2 VALUES ('native-session', NULL, '/fixture', 'build', 1)");
      const insert = native.prepare("INSERT INTO session_message VALUES (?, 'native-session', ?, ?, ?, ?)");
      for (const [index, outcome] of ["succeeded", "failed", "interrupted"].entries()) {
        const id = `native-user-${index}`;
        const time = 4_070_944_800_000 + index * 1000;
        insert.run(id, "user", JSON.stringify({ type: "user", text: `Inspect and document lifecycle case ${index}.`, time: { created: time } }), index * 3, time);
        insert.run(`${id}-answer`, "assistant", JSON.stringify({ type: "assistant", agent: "build", finish: "stop", content: [{ type: "text", text: `Verified and documented lifecycle case ${index}.` }], time: { created: time + 1, completed: time + 2 } }), index * 3 + 1, time + 1);
        insert.run(`${id}-idle`, "idle", JSON.stringify({ type: "idle", outcome, time: { created: time + 3 } }), index * 3 + 2, time + 3);
        const identity = { conversationId: "native-session", turnId: id };
        const live = await readOpencodeSourceTurn(createOpencodeDatabaseSource(native)!, identity);
        const scanned = await readOpencodeSourceTurn(createOpencodeDatabaseSource(native)!, identity);
        expect(live.turn).not.toBeNull();
        expect(scanned.turn).toEqual(live.turn);
        const request = (channel: "hook" | "agent_source_scan") => ({
          ...buildSourceTurnRequest(channel === "hook" ? live.turn! : scanned.turn!, channel),
          namespace: { source: "opencode", profileId: "build", userId: "fixture-user" }
        });
        const first = (await service.completeSourceTurn(request(firstChannel)));
        expect(first.status).toBe("stored");
        const second = (await service.completeSourceTurn(request(firstChannel === "hook" ? "agent_source_scan" : "hook")));
        expect(second.status).toBe("existing");
        expect(second.result?.l1MemoryId).toBe(first.result?.l1MemoryId);
      }
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM source_turn_captures").get()).toEqual({ count: 3 });
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE memory_layer = 'L1'").get()).toEqual({ count: 3 });
    } finally { native.close(); }
  });
});

describe("OpenCode V2 migration and immutable native boundaries", () => {
  it.each(["hook", "agent_source_scan"] as const)("keeps migrated V1 identity and freezes native turns when %s arrives first", async (firstChannel) => {
    const native = new DatabaseSync(":memory:");
    const { service, db } = fixture.createTestService();
    try {
      native.exec(`CREATE TABLE session_v2 (id TEXT, parent_id TEXT, directory TEXT, agent TEXT, time_created INTEGER);
        CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, data TEXT, seq INTEGER, time_created INTEGER);
        CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER);
        CREATE TABLE part (id TEXT, message_id TEXT, data TEXT, time_created INTEGER);
        INSERT INTO session_v2 VALUES ('session', NULL, '/fixture', 'build', 1)`);
      const time = 4_070_944_800_000;
      const insert = native.prepare("INSERT INTO session_message VALUES (?, 'session', ?, ?, ?, ?)");
      const user = { role: "user", agent: "build", time: { created: time } };
      const assistant = { role: "assistant", parentID: "old-user", agent: "build", finish: "stop", time: { created: time + 1, completed: time + 2 } };
      native.prepare("INSERT INTO message VALUES (?, 'session', ?, ?)").run("old-user", JSON.stringify(user), time);
      native.prepare("INSERT INTO message VALUES (?, 'session', ?, ?)").run("old-answer", JSON.stringify(assistant), time + 1);
      native.prepare("INSERT INTO part VALUES ('old-query', 'old-user', ?, ?)").run(JSON.stringify({ type: "text", text: "Inspect and document migrated storage behavior." }), time);
      native.prepare("INSERT INTO part VALUES ('old-text', 'old-answer', ?, ?)").run(JSON.stringify({ type: "text", text: "Verified migrated storage behavior." }), time + 1);
      // Official migration keeps the original rows and creates V2 rows without idle.
      insert.run("old-user", "user", JSON.stringify({ text: "Inspect and document migrated storage behavior.", time: user.time }), 0, time);
      insert.run("old-answer", "assistant", JSON.stringify({ agent: "build", finish: "stop", time: assistant.time, content: [{ type: "text", text: "Verified migrated storage behavior." }] }), 1, time + 1);
      const read = async (turnId: string) => (await readOpencodeSourceTurn(createOpencodeDatabaseSource(native)!, { conversationId: "session", turnId })).turn;
      const migrated = await read("old-user");
      expect(migrated).toMatchObject({ completedAt: new Date(time + 2).toISOString(), profileId: "build", answer: "Verified migrated storage behavior." });
      const capture = async (turn: NonNullable<typeof migrated>, channel: "hook" | "agent_source_scan") => (await service.completeSourceTurn({
        ...buildSourceTurnRequest(turn, channel), namespace: { source: "opencode", profileId: "build", userId: "fixture-user" }
      }));
      expect((await capture(migrated!, firstChannel)).status).toBe("stored");
      insert.run("new-user", "user", JSON.stringify({ text: "Inspect and document native boundaries.", time: { created: time + 10 } }), 2, time + 10);
      insert.run("tool-step", "assistant", JSON.stringify({ agent: "build", finish: "tool-calls", time: { created: time + 11, completed: time + 12 }, content: [{ type: "tool", id: "read", name: "read", time: { created: time + 11, completed: time + 12 }, state: { status: "completed", input: {}, content: [{ type: "text", text: "file contents" }] } }] }), 3, time + 11);
      expect(await read("new-user")).toBeNull(); // completed tool step is not a completed execution
      insert.run("final-step", "assistant", JSON.stringify({ agent: "build", finish: "stop", time: { created: time + 13, completed: time + 14 }, content: [{ type: "text", text: "Verified native boundaries." }] }), 4, time + 13);
      expect(await read("new-user")).toBeNull(); // native V2 still needs idle
      insert.run("idle", "idle", JSON.stringify({ outcome: "succeeded", time: { created: time + 15 } }), 5, time + 15);
      const completed = await read("new-user");
      expect(completed).not.toBeNull();
      expect((await capture(completed!, firstChannel)).status).toBe("stored");
      insert.run("maintenance", "synthetic", JSON.stringify({ text: "System continuation" }), 6, time + 16);
      insert.run("maintenance-answer", "assistant", JSON.stringify({ agent: "build", finish: "stop", time: { created: time + 17, completed: time + 18 }, content: [{ type: "text", text: "This is not part of the previous user turn." }] }), 7, time + 17);
      insert.run("maintenance-idle", "idle", JSON.stringify({ outcome: "succeeded", time: { created: time + 19 } }), 8, time + 19);
      insert.run("compact", "compaction", JSON.stringify({ status: "completed", summary: "Independent compaction" }), 9, time + 20);
      insert.run("compaction-idle", "idle", JSON.stringify({ outcome: "succeeded", time: { created: time + 21 } }), 10, time + 21);
      expect(await read("new-user")).toEqual(completed);
      expect(await read("old-user")).toEqual(migrated);
      const second = firstChannel === "hook" ? "agent_source_scan" : "hook";
      expect((await capture((await read("new-user"))!, second)).status).toBe("existing");
      expect((await capture((await read("old-user"))!, second)).status).toBe("existing");
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM source_turn_captures").get()).toEqual({ count: 2 });
      native.exec("DELETE FROM session_message WHERE id = 'old-user'");
      expect(await read("old-user")).toBeNull();
      expect(await read("new-user")).toEqual(completed);
    } finally { native.close(); }
  });
});
