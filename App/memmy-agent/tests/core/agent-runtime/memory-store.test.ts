import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HISTORY_ENTRY_HARD_CAP, MemoryStore } from "../../../src/core/agent-runtime/memory.js";

const roots: string[] = [];

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-memory-"));
  roots.push(dir);
  return dir;
}

function store(maxHistoryEntries?: number): MemoryStore {
  return new MemoryStore(workspace(), maxHistoryEntries);
}

function readJsonl(file: string): any[] {
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function localMinute(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("MemoryStore file IO", () => {
  it("returns empty memory when MEMORY.md is missing", () => {
    expect(store().readMemory()).toBe("");
  });

  it("writes and reads MEMORY.md", () => {
    const s = store();
    s.writeMemory("hello");
    expect(s.readMemory()).toBe("hello");
  });

  it("returns empty soul when SOUL.md is missing", () => {
    expect(store().readSoul()).toBe("");
  });

  it("writes and reads SOUL.md", () => {
    const s = store();
    s.writeSoul("soul content");
    expect(s.readSoul()).toBe("soul content");
  });

  it("returns empty user profile when USER.md is missing", () => {
    expect(store().readUser()).toBe("");
  });

  it("writes and reads USER.md", () => {
    const s = store();
    s.writeUser("user content");
    expect(s.readUser()).toBe("user content");
  });

  it("returns empty memory context when long-term memory is missing", () => {
    expect(store().getMemoryContext()).toBe("");
  });

  it("formats memory context when memory exists", () => {
    const s = store();
    s.writeMemory("important fact");
    expect(s.getMemoryContext()).toContain("Long-term Memory");
    expect(s.getMemoryContext()).toContain("important fact");
  });

  it("reads missing memory files as empty and writes memory, soul, and user files", () => {
    const s = store();

    expect(s.readMemory()).toBe("");
    expect(s.readSoul()).toBe("");
    expect(s.readUser()).toBe("");
    expect(s.getMemoryContext()).toBe("");

    s.writeMemory("fact");
    s.writeSoul("soul");
    s.writeUser("user");

    expect(s.readMemory()).toBe("fact");
    expect(s.readSoul()).toBe("soul");
    expect(s.readUser()).toBe("user");
    expect(s.getMemoryContext()).toBe("## Long-term Memory\nfact");
    expect(fs.existsSync(path.join(s.workspace, "memory", "MEMORY.md"))).toBe(true);
  });

  it("keeps generic path/read/write helpers rooted in the workspace", () => {
    const s = store();

    s.write("hello", "notes/example.md");

    expect(s.path("notes/example.md")).toBe(path.join(s.workspace, "notes/example.md"));
    expect(s.read("notes/example.md")).toBe("hello");
    expect(s.read()).toBe("");
  });
});

describe("MemoryStore history and cursor recovery", () => {
  it("returns incrementing cursors from appendHistory", () => {
    const s = store();
    expect(s.appendHistory("event 1")).toBe(1);
    expect(s.appendHistory("event 2")).toBe(2);
  });

  it("includes cursor fields in history JSONL records", () => {
    const s = store();
    s.appendHistory("event 1");
    expect(JSON.parse(s.readFile(s.historyFile)).cursor).toBe(1);
  });

  it("persists session keys using the JSONL field name", () => {
    const s = store();
    s.appendHistory("scoped event", { sessionKey: "websocket:chat-1" });

    const row = JSON.parse(s.readFile(s.historyFile));
    expect(row.session_key).toBe("websocket:chat-1");
    expect(row).not.toHaveProperty("sessionKey");
  });

  it("keeps legacy history rows untagged when no session key is provided", () => {
    const s = store();
    s.appendHistory("legacy event");

    expect(JSON.parse(s.readFile(s.historyFile))).not.toHaveProperty("session_key");
  });

  it("persists cursor values across appends", () => {
    const s = store();
    s.appendHistory("event 1");
    s.appendHistory("event 2");
    expect(s.appendHistory("event 3")).toBe(3);
  });

  it("strips well-formed thinking content before history persistence", () => {
    const s = store();
    const cursor = s.appendHistory("<think>reasoning</think>final answer");
    const row = JSON.parse(s.readFile(s.historyFile));
    expect(row.cursor).toBe(cursor);
    expect(row.content).toBe("final answer");
  });

  it("drops pure thinking leaks instead of restoring raw content", () => {
    const s = store();
    s.appendHistory("<think>nothing user-facing</think>");
    expect(JSON.parse(s.readFile(s.historyFile)).content).toBe("");
  });

  it("drops malformed channel-marker leak prefixes", () => {
    const s = store();
    s.appendHistory("<channel|>");
    expect(JSON.parse(s.readFile(s.historyFile)).content).toBe("");
  });

  it("reads unprocessed history after a cursor", () => {
    const s = store();
    s.appendHistory("event 1");
    s.appendHistory("event 2");
    s.appendHistory("event 3");
    const entries = s.readUnprocessedHistory(1);
    expect(entries).toHaveLength(2);
    expect(entries[0].cursor).toBe(2);
  });

  it("returns all valid history entries when cursor is zero", () => {
    const s = store();
    s.appendHistory("event 1");
    s.appendHistory("event 2");
    expect(s.readUnprocessedHistory(0)).toHaveLength(2);
  });

  it("filters prompt history by exact session without changing the global reader", () => {
    const s = store();
    s.appendHistory("legacy event");
    s.appendHistory("wonton event", { sessionKey: "websocket:chat-1" });
    s.appendHistory("city event", { sessionKey: "websocket:chat-2" });

    expect(s.readUnprocessedHistory(0).map((entry) => entry.content)).toEqual([
      "legacy event",
      "wonton event",
      "city event",
    ]);
    expect(s.readRecentHistoryForPrompt(0, { sessionKey: "websocket:chat-1" }).map((entry) => entry.content)).toEqual([
      "wonton event",
    ]);
    expect(s.readRecentHistoryForPrompt(0, { sessionKey: "websocket:chat-2" }).map((entry) => entry.content)).toEqual([
      "city event",
    ]);
  });

  it("shares non-internal history in unified mode and keeps internal sessions isolated", () => {
    const s = store();
    s.appendHistory("legacy event");
    s.appendHistory("unified event", { sessionKey: "unified:default" });
    s.appendHistory("channel event", { sessionKey: "websocket:chat-1" });
    s.appendHistory("own cron event", { sessionKey: "cron:job-1" });
    s.appendHistory("other cron event", { sessionKey: "cron:job-2" });
    s.appendHistory("dream event", { sessionKey: "dream:nightly" });
    s.appendHistory("heartbeat event", { sessionKey: "heartbeat" });

    expect(
      s.readRecentHistoryForPrompt(0, { sessionKey: "unified:default", unifiedSession: true }).map((entry) => entry.content),
    ).toEqual(["legacy event", "unified event", "channel event"]);
    expect(
      s.readRecentHistoryForPrompt(0, { sessionKey: "cron:job-1", unifiedSession: true }).map((entry) => entry.content),
    ).toEqual(["legacy event", "unified event", "channel event", "own cron event"]);
  });

  it("fails closed on malformed session keys in prompt history", () => {
    const s = store();
    fs.writeFileSync(
      s.historyFile,
      [
        { cursor: 1, timestamp: "2026-04-01 10:00", content: "legacy" },
        { cursor: 2, timestamp: "2026-04-01 10:01", content: "null legacy", session_key: null },
        { cursor: 3, timestamp: "2026-04-01 10:02", content: "number", session_key: 42 },
        { cursor: 4, timestamp: "2026-04-01 10:03", content: "object", session_key: { bad: true } },
        { cursor: 5, timestamp: "2026-04-01 10:04", content: "array", session_key: ["websocket:chat-1"] },
        { cursor: 6, timestamp: "2026-04-01 10:05", content: "boolean", session_key: true },
        { cursor: 7, timestamp: "2026-04-01 10:06", content: "valid", session_key: "websocket:chat-1" },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      "utf8",
    );

    expect(s.readRecentHistoryForPrompt(0, { sessionKey: "websocket:chat-1" }).map((entry) => entry.content)).toEqual(["valid"]);
    expect(
      s.readRecentHistoryForPrompt(0, { sessionKey: "unified:default", unifiedSession: true }).map((entry) => entry.content),
    ).toEqual(["legacy", "null legacy", "valid"]);
  });

  it("skips entries missing cursor fields", () => {
    const s = store();
    fs.writeFileSync(
      s.historyFile,
      '{"timestamp":"2026-04-01 10:00","content":"no cursor"}\n{"cursor":2,"timestamp":"2026-04-01 10:01","content":"valid"}\n{"cursor":3,"timestamp":"2026-04-01 10:02","content":"also valid"}\n',
      "utf8",
    );
    expect(s.readUnprocessedHistory(0).map((entry) => entry.cursor)).toEqual([2, 3]);
  });

  it("falls back safely when the last entry has no cursor", () => {
    const s = store();
    fs.writeFileSync(s.historyFile, '{"timestamp":"2026-04-01 10:01","content":"no cursor"}\n', "utf8");
    fs.rmSync(s.cursorFile, { force: true });
    expect(s.appendHistory("new event")).toBe(1);
  });

  it("cleans up temporary history file when atomic replace fails", () => {
    const s = store();
    s.appendHistory("event 1");
    const entries = s.readUnprocessedHistory(0);
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("simulated failure");
    });

    expect(() => s.writeEntries(entries)).toThrow("simulated failure");
    expect(fs.existsSync(`${s.historyFile}.tmp`)).toBe(false);
    expect(fs.existsSync(s.historyFile)).toBe(true);
    rename.mockRestore();
  });

  it("appends JSONL records, increments cursors, strips thinking leaks, and persists .cursor", () => {
    const s = store();

    expect(s.appendHistory("event 1")).toBe(1);
    expect(s.appendHistory("<think>reasoning</think>final answer")).toBe(2);
    expect(s.appendHistory("<think>nothing user-facing</think>")).toBe(3);
    expect(s.appendHistory("<channel|>")).toBe(4);

    const rows = readJsonl(s.historyFile);
    expect(rows.map((row) => row.cursor)).toEqual([1, 2, 3, 4]);
    expect(rows[1].content).toBe("final answer");
    expect(rows[2].content).toBe("");
    expect(rows[3].content).toBe("");
    expect(s.readFile(s.cursorFile).trim()).toBe("4");
  });

  it("reads only unprocessed valid cursor entries and skips missing/corrupt cursor rows", () => {
    const s = store();
    fs.writeFileSync(
      s.historyFile,
      '{"timestamp": "2026-04-01 10:00", "content": "no cursor"}\n' +
        '{"cursor": "bad", "timestamp": "2026-04-01 10:01", "content": "bad"}\n' +
        '{"cursor": 2, "timestamp": "2026-04-01 10:02", "content": "good2"}\n' +
        '{"cursor": null, "timestamp": "2026-04-01 10:03", "content": "null"}\n' +
        '{"cursor": 4, "timestamp": "2026-04-01 10:04", "content": "good4"}\n' +
        '{"cursor": true, "timestamp": "2026-04-01 10:05", "content": "boolean"}\n',
      "utf8",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(s.readUnprocessedHistory(0).map((entry) => entry.cursor)).toEqual([2, 4]);
    expect(s.readUnprocessedHistory(2).map((entry) => entry.cursor)).toEqual([4]);
    s.readUnprocessedHistory(0);

    expect(warn.mock.calls.filter(([message]) => String(message).includes("non-int cursor"))).toHaveLength(1);
    expect(MemoryStore.validCursor(true)).toBeNull();
    expect(MemoryStore.validCursor(5)).toBe(5);
  });

  it("falls back from corrupt .cursor or corrupt tail rows to max(valid cursor) + 1", () => {
    const s = store();
    fs.writeFileSync(
      s.historyFile,
      '{"cursor": 100, "timestamp": "2026-04-01 10:00", "content": "high"}\n' +
        '{"cursor": 5, "timestamp": "2026-04-01 10:01", "content": "out of order"}\n' +
        '{"cursor": "poison", "timestamp": "2026-04-01 10:02", "content": "tail corrupt"}\n',
      "utf8",
    );
    fs.writeFileSync(s.cursorFile, "not-a-number", "utf8");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(s.appendHistory("safe next")).toBe(101);

    const allBad = store();
    fs.writeFileSync(
      allBad.historyFile,
      '{"cursor": "a", "timestamp": "2026-04-01 10:00", "content": "bad1"}\n' +
        '{"cursor": [1,2], "timestamp": "2026-04-01 10:01", "content": "bad2"}\n',
      "utf8",
    );
    expect(allBad.appendHistory("fresh start")).toBe(1);
  });

  it("compacts old entries and writes JSONL atomically with temp cleanup", () => {
    const s = store(2);
    for (let i = 1; i <= 5; i += 1) s.appendHistory(`event ${i}`, { sessionKey: `session:${i}` });

    s.compactHistory();

    expect(s.readUnprocessedHistory(0).map((entry) => entry.cursor)).toEqual([4, 5]);
    expect(s.readUnprocessedHistory(0).map((entry) => entry.session_key)).toEqual(["session:4", "session:5"]);
    const entries = s.readUnprocessedHistory(0);
    s.writeEntries(entries);
    expect(fs.existsSync(`${s.historyFile}.tmp`)).toBe(false);
    expect(fs.existsSync(s.historyFile)).toBe(true);
  });

  it("applies append hard caps once and supports caller-provided maxChars", () => {
    const s = store();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    s.appendHistory("x".repeat(HISTORY_ENTRY_HARD_CAP + 100));
    s.appendHistory("y".repeat(HISTORY_ENTRY_HARD_CAP + 100));
    s.appendHistory("a".repeat(500), { maxChars: 100 });

    const rows = s.readUnprocessedHistory(0);
    expect(String(rows[0].content).length).toBeLessThanOrEqual(HISTORY_ENTRY_HARD_CAP + 50);
    expect(String(rows[2].content).length).toBeLessThanOrEqual(150);
    expect(warn.mock.calls.filter(([message]) => String(message).includes("exceeds"))).toHaveLength(1);
  });

  it("leaves normal-sized history entries unchanged", () => {
    const s = store();
    s.appendHistory("normal short entry");
    expect(s.readUnprocessedHistory(0)[0].content).toBe("normal short entry");
  });

  it("applies caller-provided maxChars tighter than the hard cap", () => {
    const s = store();
    s.appendHistory("a".repeat(500), { maxChars: 100 });
    expect(String(s.readUnprocessedHistory(0)[0].content).length).toBeLessThanOrEqual(150);
  });
});

describe("MemoryStore dream cursor, raw archive, and git integration", () => {
  it("starts with dream cursor zero", () => {
    expect(store().getLastDreamCursor()).toBe(0);
  });

  it("sets and gets dream cursor", () => {
    const s = store();
    s.setLastDreamCursor(5);
    expect(s.getLastDreamCursor()).toBe(5);
  });

  it("persists dream cursor across store instances", () => {
    const root = workspace();
    const s = new MemoryStore(root);
    s.setLastDreamCursor(3);
    expect(new MemoryStore(root).getLastDreamCursor()).toBe(3);
  });

  it("persists dream cursor and lets git restore roll it back with memory", () => {
    const s = store();
    expect(s.getLastDreamCursor()).toBe(0);

    s.writeMemory("before");
    s.setLastDreamCursor(1);
    expect(s.git.init()).toBe(true);

    s.writeMemory("after");
    s.setLastDreamCursor(2);
    const dreamSha = s.git.autoCommit("dream: update");
    expect(dreamSha).not.toBeNull();

    s.writeMemory("newer");
    s.setLastDreamCursor(3);
    const restoreSha = s.git.revert(dreamSha!);

    expect(restoreSha).not.toBeNull();
    expect(s.readMemory()).toBe("before");
    expect(s.getLastDreamCursor()).toBe(1);
  });

  it("formats and truncates raw archives before appending to history", () => {
    const s = store();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    s.rawArchive(
      [
        { role: "user", content: "hello", timestamp: "2026-04-01 10:04:33" },
        { role: "assistant", content: "a".repeat(200), timestamp: "2026-04-01 10:05:10", toolsUsed: ["search"] },
      ],
      { maxChars: 100, sessionKey: "websocket:chat-1" },
    );

    const entry = s.readUnprocessedHistory(0)[0];
    expect(entry.content).toContain("[RAW] 2 messages");
    expect(entry.content).toContain("[2026-04-01 10:04] USER: hello");
    expect(entry.content).toContain("ASSISTANT [tools: search]");
    expect(String(entry.content).length).toBeLessThan(250);
    expect(entry.session_key).toBe("websocket:chat-1");
  });
});

describe("MemoryStore legacy HISTORY.md migration", () => {
  it("migrates legacy chunks, preserves raw blocks, writes cursors, and keeps a backup", () => {
    const root = workspace();
    const memoryDir = path.join(root, "memory");
    fs.mkdirSync(memoryDir);
    const legacyFile = path.join(memoryDir, "HISTORY.md");
    const legacyContent =
      "[2026-04-01 10:00] User prefers dark mode.\n\n" +
      "[2026-04-01 10:05] [RAW] 2 messages\n" +
      "[2026-04-01 10:04] USER: hello\n" +
      "[2026-04-01 10:04] ASSISTANT: hi\n\n" +
      "Legacy chunk without timestamp.\n" +
      "Keep whatever content we can recover.\n";
    fs.writeFileSync(legacyFile, legacyContent, "utf8");

    const s = new MemoryStore(root);
    const backup = path.join(memoryDir, "HISTORY.md.bak");
    const fallbackTimestamp = localMinute(fs.statSync(backup).mtime);
    const entries = s.readUnprocessedHistory(0);

    expect(entries.map((entry) => entry.cursor)).toEqual([1, 2, 3]);
    expect(entries[0]).toMatchObject({ timestamp: "2026-04-01 10:00", content: "User prefers dark mode." });
    expect(entries[1].timestamp).toBe("2026-04-01 10:05");
    expect(entries[1].content).toContain("[RAW] 2 messages");
    expect(entries[1].content).toContain("USER: hello");
    expect(entries[2].timestamp).toBe(fallbackTimestamp);
    expect(entries[2].content).toContain("Legacy chunk without timestamp.");
    expect(s.readFile(s.cursorFile).trim()).toBe("3");
    expect(s.readFile(s.dreamCursorFile).trim()).toBe("3");
    expect(fs.existsSync(legacyFile)).toBe(false);
    expect(fs.readFileSync(backup, "utf8")).toBe(legacyContent);
  });

  it("splits consecutive timestamped entries and nonstandard date headers, but skips migration when JSONL has data", () => {
    const root = workspace();
    const memoryDir = path.join(root, "memory");
    fs.mkdirSync(memoryDir);
    fs.writeFileSync(
      path.join(memoryDir, "HISTORY.md"),
      "[2026-04-01 10:00] First event.\n[2026-04-01 10:01] Second event.\n[2026-03-25-2026-04-02] Multi-day summary.\n",
      "utf8",
    );

    const s = new MemoryStore(root);
    const entries = s.readUnprocessedHistory(0);

    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.content)).toEqual([
      "First event.",
      "Second event.",
      "[2026-03-25-2026-04-02] Multi-day summary.",
    ]);

    const existingRoot = workspace();
    const existingMemory = path.join(existingRoot, "memory");
    fs.mkdirSync(existingMemory);
    fs.writeFileSync(path.join(existingMemory, "history.jsonl"), '{"cursor":7,"timestamp":"2026-04-01 12:00","content":"existing"}\n');
    fs.writeFileSync(path.join(existingMemory, "HISTORY.md"), "[2026-04-01 10:00] legacy\n\n");

    const existing = new MemoryStore(existingRoot);
    expect(existing.readUnprocessedHistory(0)).toHaveLength(1);
    expect(existing.readUnprocessedHistory(0)[0].content).toBe("existing");
    expect(fs.existsSync(path.join(existingMemory, "HISTORY.md"))).toBe(true);
  });

  it("migrates empty JSONL and invalid UTF-8 legacy files best-effort", () => {
    const root = workspace();
    const memoryDir = path.join(root, "memory");
    fs.mkdirSync(memoryDir);
    fs.writeFileSync(path.join(memoryDir, "history.jsonl"), "", "utf8");
    fs.writeFileSync(path.join(memoryDir, "HISTORY.md"), "[2026-04-01 10:00] legacy\n\n", "utf8");

    const s = new MemoryStore(root);
    expect(s.readUnprocessedHistory(0)[0]).toMatchObject({ cursor: 1, timestamp: "2026-04-01 10:00", content: "legacy" });

    const invalidRoot = workspace();
    const invalidMemory = path.join(invalidRoot, "memory");
    fs.mkdirSync(invalidMemory);
    fs.writeFileSync(path.join(invalidMemory, "HISTORY.md"), Buffer.from([0x5b, 0x32, 0x30, 0x32, 0x36, 0x2d, 0x30, 0x34, 0x2d, 0x30, 0x31, 0x20, 0x31, 0x30, 0x3a, 0x30, 0x30, 0x5d, 0x20, 0x42, 0x72, 0x6f, 0x6b, 0x65, 0x6e, 0x20, 0xff, 0x20, 0x64, 0x61, 0x74, 0x61, 0x0a]));

    const invalid = new MemoryStore(invalidRoot);
    expect(invalid.readUnprocessedHistory(0)[0].content).toContain("Broken");
    expect(invalid.readUnprocessedHistory(0)[0].content).toContain("data");
  });

  it("keeps legacy HISTORY.md when existing history JSONL has data", () => {
    const root = workspace();
    const memoryDir = path.join(root, "memory");
    fs.mkdirSync(memoryDir);
    fs.writeFileSync(path.join(memoryDir, "history.jsonl"), '{"cursor":7,"timestamp":"2026-04-01 12:00","content":"existing"}\n', "utf8");
    fs.writeFileSync(path.join(memoryDir, "HISTORY.md"), "[2026-04-01 10:00] legacy\n\n", "utf8");

    const s = new MemoryStore(root);

    expect(s.readUnprocessedHistory(0)[0]).toMatchObject({ cursor: 7, content: "existing" });
    expect(fs.existsSync(path.join(memoryDir, "HISTORY.md"))).toBe(true);
    expect(fs.existsSync(path.join(memoryDir, "HISTORY.md.bak"))).toBe(false);
  });
});
