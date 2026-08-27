import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Session, SessionManager } from "../../../src/core/session/manager.js";

const roots: string[] = [];

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-session-atomic-"));
  roots.push(root);
  return root;
}

function writeJsonl(file: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("SessionManager atomic save", () => {
  it("saves sessions as valid JSONL with metadata and message records", () => {
    const manager = new SessionManager(tmpRoot());
    const session = new Session({ key: "test:1" });
    session.addMessage("user", "hello");
    session.addMessage("assistant", "hi");

    manager.save(session);

    const file = manager.pathFor("test:1");
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0])).toMatchObject({ recordType: "metadata", key: "test:1" });
    expect(JSON.parse(lines[1])).toMatchObject({ role: "user", content: "hello" });
  });

  it("leaves no temp file after a successful save", () => {
    const manager = new SessionManager(tmpRoot());

    manager.save(new Session({ key: "test:clean" }));

    expect(fs.readdirSync(manager.sessionsDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("cleans stale temp files when a save fails while writing", () => {
    const manager = new SessionManager(tmpRoot());
    const file = manager.pathFor("test:fail");
    const tmp = `${file}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, "stale", "utf8");
    const original = JSON.stringify;
    vi.spyOn(JSON, "stringify").mockImplementation(((value: any) => {
      if (value?.role === "assistant") throw new Error("simulated disk full");
      return original(value);
    }) as typeof JSON.stringify);
    const session = new Session({
      key: "test:fail",
      messages: [
        { role: "user", content: "ok" },
        { role: "assistant", content: "will fail" },
      ],
    });

    expect(() => manager.save(session)).toThrow(/simulated disk full/);
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it("overwrites a session while preserving the latest data", () => {
    const manager = new SessionManager(tmpRoot());
    const session = new Session({ key: "test:overwrite" });
    session.addMessage("user", "first");
    manager.save(session);
    session.addMessage("user", "second");
    manager.save(session);

    manager.invalidate("test:overwrite");
    const loaded = manager.getOrCreate("test:overwrite");

    expect(loaded.messages.map((message) => message.content)).toEqual(["first", "second"]);
  });

  it("keeps consecutive saves consistent", () => {
    const manager = new SessionManager(tmpRoot());
    const session = new Session({ key: "test:consistency" });
    for (let i = 0; i < 5; i += 1) {
      session.addMessage("user", `msg${i}`);
      manager.save(session);
    }

    manager.invalidate("test:consistency");
    const loaded = manager.getOrCreate("test:consistency");

    expect(loaded.messages.map((message) => message.content)).toEqual(["msg0", "msg1", "msg2", "msg3", "msg4"]);
  });
});

describe("SessionManager corrupt JSONL repair", () => {
  it("recovers from a truncated final line", () => {
    const manager = new SessionManager(tmpRoot());
    const file = manager.pathFor("test:trunc");
    writeJsonl(file, [
      JSON.stringify({ recordType: "metadata", key: "test:trunc", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), metadata: {}, lastConsolidated: 0 }),
      JSON.stringify({ role: "user", content: "hello" }),
      '{"role": "assistant", "content": "partial...',
    ]);

    const session = manager.loadSession("test:trunc");

    expect(session?.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("skips a corrupt metadata line and keeps valid messages", () => {
    const manager = new SessionManager(tmpRoot());
    writeJsonl(manager.pathFor("test:badmeta"), [
      "NOT VALID JSON!!!",
      JSON.stringify({ role: "user", content: "survived" }),
    ]);

    const session = manager.loadSession("test:badmeta");

    expect(session?.messages).toEqual([{ role: "user", content: "survived" }]);
  });

  it("returns null when every non-empty line is corrupt", () => {
    const manager = new SessionManager(tmpRoot());
    writeJsonl(manager.pathFor("test:allbad"), ["garbage line 1", "garbage line 2", "{{invalid json"]);

    expect(manager.loadSession("test:allbad")).toBeNull();
  });

  it("loads an empty file as an empty session", () => {
    const manager = new SessionManager(tmpRoot());
    const file = manager.pathFor("test:empty");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "", "utf8");

    const session = manager.loadSession("test:empty");

    expect(session?.key).toBe("test:empty");
    expect(session?.messages).toEqual([]);
  });

  it("preserves valid messages among corrupt lines", () => {
    const manager = new SessionManager(tmpRoot());
    writeJsonl(manager.pathFor("test:mixed"), [
      JSON.stringify({ recordType: "metadata", key: "test:mixed", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), metadata: {}, lastConsolidated: 0 }),
      "BROKEN",
      JSON.stringify({ role: "user", content: "msg1" }),
      '{"role": "assistant", "content": "broken',
      JSON.stringify({ role: "user", content: "msg2" }),
    ]);

    const session = manager.loadSession("test:mixed");

    expect(session?.messages.map((message) => message.content)).toEqual(["msg1", "msg2"]);
  });

  it("falls back to current timestamps when metadata timestamps are invalid", () => {
    const manager = new SessionManager(tmpRoot());
    writeJsonl(manager.pathFor("test:badts"), [
      JSON.stringify({ recordType: "metadata", key: "test:badts", createdAt: "not-a-date", updatedAt: "also-bad", metadata: {}, lastConsolidated: 5 }),
      JSON.stringify({ role: "user", content: "hi" }),
    ]);

    const session = manager.loadSession("test:badts");

    expect(session?.lastConsolidated).toBe(5);
    expect(Number.isNaN(Date.parse(session?.createdAt ?? ""))).toBe(false);
  });

  it("readSessionFile repairs corrupt JSONL for read-only payloads", () => {
    const manager = new SessionManager(tmpRoot());
    writeJsonl(manager.pathFor("test:read-repair"), [
      JSON.stringify({ recordType: "metadata", key: "test:read-repair", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), metadata: { source: "repair" }, lastConsolidated: 0 }),
      JSON.stringify({ role: "user", content: "survived" }),
      '{"role": "assistant", "content": "partial...',
    ]);

    const payload = manager.readSessionFile("test:read-repair");

    expect(payload).toMatchObject({
      key: "test:read-repair",
      metadata: { source: "repair" },
      messages: [{ role: "user", content: "survived" }],
    });
  });

  it("listSessions includes repaired corrupt files", () => {
    const manager = new SessionManager(tmpRoot());
    writeJsonl(manager.pathFor("test:list-repair"), [
      "NOT VALID JSON",
      JSON.stringify({ recordType: "metadata", key: "test:list-repair", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), metadata: {}, lastConsolidated: 0 }),
      JSON.stringify({ role: "user", content: "hello" }),
    ]);

    expect(manager.listSessions()).toEqual(expect.arrayContaining([expect.objectContaining({ key: "test:list-repair" })]));
  });

  it("getOrCreate returns a new empty session for fully corrupt files", () => {
    const manager = new SessionManager(tmpRoot());
    writeJsonl(manager.pathFor("test:fallback"), ["{{{{"]);

    const session = manager.getOrCreate("test:fallback");

    expect(session.key).toBe("test:fallback");
    expect(session.messages).toEqual([]);
  });
});
