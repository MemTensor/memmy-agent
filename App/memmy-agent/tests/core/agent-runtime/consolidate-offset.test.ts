import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Consolidator, MemoryStore } from "../../../src/core/agent-runtime/memory.js";
import { Session, SessionManager } from "../../../src/core/session/manager.js";

const MEMORY_WINDOW = 50;
const KEEP_COUNT = MEMORY_WINDOW / 2;

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memmy-consolidate-offset-"));
}

function createSessionWithMessages(key: string, count: number, role = "user"): Session {
  const session = new Session({ key });
  for (let index = 0; index < count; index += 1) session.addMessage(role, `msg${index}`);
  return session;
}

function oldMessages(session: Session, lastConsolidated: number, keepCount: number): Record<string, any>[] {
  return session.messages.slice(lastConsolidated, keepCount > 0 ? -keepCount : undefined);
}

function expectMessageRange(messages: Record<string, any>[], start: number, end: number): void {
  expect(messages.length).toBeGreaterThan(0);
  expect(messages[0].content).toBe(`msg${start}`);
  expect(messages[messages.length - 1].content).toBe(`msg${end}`);
}

describe("Consolidator offset selection", () => {
  it("starts consolidation after lastConsolidated and cuts only on user boundaries", () => {
    const session = new Session({
      key: "s1",
      lastConsolidated: 2,
      messages: [
        { role: "user", content: "old" },
        { role: "assistant", content: "old reply" },
        { role: "user", content: "new 1" },
        { role: "assistant", content: "reply 1" },
        { role: "user", content: "new 2" },
      ],
    });
    const consolidator = new Consolidator({ store: new MemoryStore("/tmp/memmy-consolidate-offset"), provider: {}, model: "m", sessions: null as any });

    expect(consolidator.pickConsolidationBoundary(session, 1)?.[0]).toBe(4);
  });

  it("initializes lastConsolidated to zero", () => {
    expect(new Session({ key: "test:initial" }).lastConsolidated).toBe(0);
  });

  it("persists lastConsolidated across save and reload", () => {
    const manager = new SessionManager(tmpRoot());
    const session = createSessionWithMessages("test:persist", 20);
    session.lastConsolidated = 15;
    manager.save(session);

    const loaded = manager.getOrCreate("test:persist");

    expect(loaded.lastConsolidated).toBe(15);
    expect(loaded.messages).toHaveLength(20);
  });

  it("clear resets lastConsolidated", () => {
    const session = createSessionWithMessages("test:clear", 10);
    session.lastConsolidated = 5;

    session.clear();

    expect(session.messages).toHaveLength(0);
    expect(session.lastConsolidated).toBe(0);
  });

  it("starts with an empty message list", () => {
    expect(new Session({ key: "test:initial" }).messages).toEqual([]);
  });

  it("appends messages without rewriting earlier entries", () => {
    const session = new Session({ key: "test:preserve" });
    session.addMessage("user", "msg1");
    session.addMessage("assistant", "resp1");
    session.addMessage("user", "msg2");

    expect(session.messages).toHaveLength(3);
    expect(session.messages[0].content).toBe("msg1");
  });

  it("getHistory returns the most recent messages", () => {
    const session = new Session({ key: "test:history" });
    for (let index = 0; index < 10; index += 1) {
      session.addMessage("user", `msg${index}`);
      session.addMessage("assistant", `resp${index}`);
    }

    const history = session.getHistory(6);

    expect(history).toHaveLength(6);
    expect(history[0].content).toBe("msg7");
    expect(history[history.length - 1].content).toBe("resp9");
  });

  it("getHistory returns all messages when the limit is larger than the session", () => {
    const session = createSessionWithMessages("test:all", 5);

    const history = session.getHistory(100);

    expect(history).toHaveLength(5);
    expect(history[0].content).toBe("msg0");
  });

  it("getHistory is stable for the same max_messages", () => {
    const session = createSessionWithMessages("test:stable", 20);

    expect(session.getHistory(10)).toEqual(session.getHistory(10));
  });

  it("getHistory does not mutate the message list", () => {
    const session = createSessionWithMessages("test:immutable", 5);
    const originalLength = session.messages.length;

    session.getHistory(2);
    session.getHistory(3);

    expect(session.messages).toHaveLength(originalLength);
  });

  it("round-trips persisted messages", () => {
    const manager = new SessionManager(tmpRoot());
    const session = createSessionWithMessages("test:persistence", 20);
    manager.save(session);

    const loaded = manager.getOrCreate("test:persistence");

    expect(loaded.messages).toHaveLength(20);
    expect(loaded.messages[0].content).toBe("msg0");
    expect(loaded.messages[19].content).toBe("msg19");
  });

  it("getHistory works after reload", () => {
    const manager = new SessionManager(tmpRoot());
    manager.save(createSessionWithMessages("test:reload", 30));

    const history = manager.getOrCreate("test:reload").getHistory(10);

    expect(history).toHaveLength(10);
    expect(history[0].content).toBe("msg20");
    expect(history[9].content).toBe("msg29");
  });

  it("clear removes all session messages", () => {
    const session = createSessionWithMessages("test:clear", 10);

    session.clear();

    expect(session.messages).toEqual([]);
  });

  it("detects when consolidation is needed beyond the memory window", () => {
    const session = createSessionWithMessages("test:trigger", 60);

    const expectedConsolidateCount = session.messages.length - KEEP_COUNT;

    expect(session.messages.length).toBeGreaterThan(MEMORY_WINDOW);
    expect(expectedConsolidateCount).toBe(35);
  });

  it("skips consolidation when the total is within keep_count", () => {
    const session = createSessionWithMessages("test:skip", 20);

    expect(oldMessages(session, session.lastConsolidated, KEEP_COUNT)).toHaveLength(0);
  });

  it("skips consolidation when lastConsolidated catches up to the old slice", () => {
    const session = createSessionWithMessages("test:already-consolidated", 42);
    session.lastConsolidated = session.messages.length - KEEP_COUNT;

    expect(oldMessages(session, session.lastConsolidated, KEEP_COUNT)).toHaveLength(0);
  });

  it("handles lastConsolidated values beyond message count", () => {
    const session = createSessionWithMessages("test:corruption", 10);
    session.lastConsolidated = 20;

    expect(session.messages.length - session.lastConsolidated).toBeLessThanOrEqual(0);
    expect(oldMessages(session, session.lastConsolidated, 5)).toEqual([]);
  });

  it("keeps JavaScript slice semantics for negative lastConsolidated", () => {
    const session = createSessionWithMessages("test:negative", 10);
    session.lastConsolidated = -5;

    const selected = oldMessages(session, session.lastConsolidated, 3);

    expect(selected).toHaveLength(2);
    expectMessageRange(selected, 5, 6);
  });

  it("selects only new unconsolidated messages after consolidation", () => {
    const session = createSessionWithMessages("test:new-messages", 40);
    session.lastConsolidated = session.messages.length - KEEP_COUNT;
    for (let index = 40; index < 50; index += 1) session.addMessage("user", `msg${index}`);

    const selected = oldMessages(session, session.lastConsolidated, KEEP_COUNT);

    expect(selected).toHaveLength(10);
    expectMessageRange(selected, 15, 24);
  });

  it("returns an empty slice when consolidation indices overlap", () => {
    const session = createSessionWithMessages("test:overlap", 30);
    session.lastConsolidated = 12;

    expect(oldMessages(session, session.lastConsolidated, 20)).toEqual([]);
  });

  it("archive_all mode can select all messages", () => {
    const session = createSessionWithMessages("test:archive-all", 50);

    expect(session.messages).toHaveLength(50);
    expect(session.lastConsolidated).toBe(0);
  });

  it("archive_all mode resets lastConsolidated", () => {
    const session = createSessionWithMessages("test:archive-reset", 40);
    session.lastConsolidated = 15;

    session.lastConsolidated = 0;

    expect(session.lastConsolidated).toBe(0);
    expect(session.messages).toHaveLength(40);
  });

  it("distinguishes archive_all from normal consolidation offsets", () => {
    const normal = createSessionWithMessages("test:normal", 60);
    normal.lastConsolidated = normal.messages.length - KEEP_COUNT;
    const archiveAll = createSessionWithMessages("test:all", 60);

    expect(normal.lastConsolidated).toBe(35);
    expect(archiveAll.lastConsolidated).toBe(0);
  });

  it("consolidation offset updates do not modify messages", () => {
    const session = createSessionWithMessages("test:immutable", 50);
    const originalMessages = [...session.messages];

    session.lastConsolidated = session.messages.length - KEEP_COUNT;

    expect(session.messages).toEqual(originalMessages);
  });

  it("repeated history reads do not modify messages", () => {
    const session = createSessionWithMessages("test:history-immutable", 40);
    const originalMessages = session.messages.map((message) => ({ ...message }));

    for (let index = 0; index < 5; index += 1) expect(session.getHistory(10)).toHaveLength(10);

    expect(session.messages.map((message) => message.content)).toEqual(originalMessages.map((message) => message.content));
  });

  it("consolidation only updates lastConsolidated metadata", () => {
    const session = createSessionWithMessages("test:field-only", 60);
    const originalMessages = [...session.messages];
    const originalMetadata = { ...session.metadata };

    session.lastConsolidated = session.messages.length - KEEP_COUNT;

    expect(session.messages).toEqual(originalMessages);
    expect(session.metadata).toEqual(originalMetadata);
    expect(session.lastConsolidated).toBe(35);
  });

  it("extracts the expected old-message range", () => {
    const session = createSessionWithMessages("test:slice", 60);

    const selected = oldMessages(session, 0, KEEP_COUNT);

    expect(selected).toHaveLength(35);
    expectMessageRange(selected, 0, 34);
    expectMessageRange(session.messages.slice(-KEEP_COUNT), 35, 59);
  });

  it("extracts a partial-consolidation range", () => {
    const session = createSessionWithMessages("test:partial", 70);

    const selected = oldMessages(session, 30, KEEP_COUNT);

    expect(selected).toHaveLength(15);
    expectMessageRange(selected, 30, 44);
  });

  it("uses keep_count 10 to select 40 messages from a 50-message session", () => {
    expect(oldMessages(createSessionWithMessages("test:keep-10", 50), 0, 10)).toHaveLength(40);
  });

  it("uses keep_count 20 to select 30 messages from a 50-message session", () => {
    expect(oldMessages(createSessionWithMessages("test:keep-20", 50), 0, 20)).toHaveLength(30);
  });

  it("returns no old messages when keep_count exceeds total messages", () => {
    expect(oldMessages(createSessionWithMessages("test:exceed", 10), 0, 20)).toEqual([]);
  });

  it("handles empty sessions", () => {
    const session = new Session({ key: "test:empty" });

    expect(session.messages).toEqual([]);
    expect(session.lastConsolidated).toBe(0);
    expect(oldMessages(session, session.lastConsolidated, KEEP_COUNT)).toEqual([]);
  });

  it("handles single-message sessions", () => {
    const session = createSessionWithMessages("test:single", 1);

    expect(oldMessages(session, session.lastConsolidated, KEEP_COUNT)).toEqual([]);
  });

  it("handles exactly keep_count messages", () => {
    const session = createSessionWithMessages("test:exact", KEEP_COUNT);

    expect(oldMessages(session, session.lastConsolidated, KEEP_COUNT)).toEqual([]);
  });

  it("selects the first message when just over keep_count", () => {
    const session = createSessionWithMessages("test:over", KEEP_COUNT + 1);

    const selected = oldMessages(session, session.lastConsolidated, KEEP_COUNT);

    expect(selected).toHaveLength(1);
    expect(selected[0].content).toBe("msg0");
  });

  it("handles very large sessions", () => {
    const session = createSessionWithMessages("test:large", 1000);

    const selected = oldMessages(session, session.lastConsolidated, KEEP_COUNT);

    expect(selected).toHaveLength(975);
    expectMessageRange(selected, 0, 974);
    expectMessageRange(session.messages.slice(-KEEP_COUNT), 975, 999);
  });

  it("handles gaps in consolidation history", () => {
    const session = createSessionWithMessages("test:gaps", 50);
    session.lastConsolidated = 10;
    for (let index = 50; index < 60; index += 1) session.addMessage("user", `msg${index}`);

    const selected = oldMessages(session, session.lastConsolidated, KEEP_COUNT);

    expect(selected).toHaveLength(25);
    expectMessageRange(selected, 10, 34);
  });

  it("serializes lastConsolidated in session JSON", () => {
    const session = createSessionWithMessages("test:json", 3);
    session.lastConsolidated = 2;

    expect(session.toJSON()).toMatchObject({ key: "test:json", lastConsolidated: 2 });
  });

  it("reloads persisted consolidation offsets after cache invalidation", () => {
    const manager = new SessionManager(tmpRoot());
    const session = createSessionWithMessages("test:invalidate", 12);
    session.lastConsolidated = 7;
    manager.save(session);
    manager.invalidate("test:invalidate");

    expect(manager.getOrCreate("test:invalidate").lastConsolidated).toBe(7);
  });
});
