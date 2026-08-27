import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../../../src/core/agent-runtime/memory.js";

const roots: string[] = [];

function store(): MemoryStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-cursor-"));
  roots.push(root);
  return new MemoryStore(root);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("MemoryStore cursor recovery", () => {
  it("falls back from corrupt cursor files to the last valid history cursor", () => {
    const s = store();
    const c1 = s.appendHistory("one");
    s.appendHistory("two");
    fs.writeFileSync(s.cursorFile, "not-an-int", "utf8");

    expect(c1).toBe(1);
    expect(s.nextCursor()).toBe(3);
  });

  it("scans backward when the last history cursor is a string", () => {
    const s = store();
    fs.writeFileSync(
      s.historyFile,
      '{"cursor": 5, "timestamp": "2026-04-01 10:00", "content": "good"}\n' +
        '{"cursor": 6, "timestamp": "2026-04-01 10:01", "content": "also good"}\n' +
        '{"cursor": "bad", "timestamp": "2026-04-01 10:02", "content": "corrupted"}\n',
      "utf8",
    );
    fs.rmSync(s.cursorFile, { force: true });

    expect(s.appendHistory("recovered event")).toBe(7);
  });

  it("restarts at one when every cursor is corrupted", () => {
    const s = store();
    fs.writeFileSync(
      s.historyFile,
      '{"cursor": "a", "timestamp": "2026-04-01 10:00", "content": "bad1"}\n' +
        '{"cursor": "b", "timestamp": "2026-04-01 10:01", "content": "bad2"}\n',
      "utf8",
    );
    fs.rmSync(s.cursorFile, { force: true });

    expect(s.appendHistory("fresh start")).toBe(1);
  });

  it("handles fractional, null, and array cursor values", () => {
    const s = store();
    fs.writeFileSync(
      s.historyFile,
      '{"cursor": 3, "timestamp": "2026-04-01 10:00", "content": "valid"}\n' +
        '{"cursor": 3.5, "timestamp": "2026-04-01 10:01", "content": "fractional"}\n' +
        '{"cursor": null, "timestamp": "2026-04-01 10:02", "content": "null"}\n' +
        '{"cursor": [1,2], "timestamp": "2026-04-01 10:03", "content": "array"}\n',
      "utf8",
    );
    fs.rmSync(s.cursorFile, { force: true });

    expect(s.appendHistory("handles weird types")).toBe(4);
  });

  it("falls back when the cursor file contains a non-numeric string", () => {
    const s = store();
    fs.writeFileSync(s.cursorFile, "not-a-number", "utf8");
    fs.writeFileSync(s.historyFile, '{"cursor": 10, "timestamp": "2026-04-01 10:00", "content": "valid"}\n', "utf8");

    expect(s.appendHistory("after bad cursor file")).toBe(11);
  });

  it("skips history entries with string cursors", () => {
    const s = store();
    fs.writeFileSync(
      s.historyFile,
      '{"cursor": 1, "timestamp": "2026-04-01 10:00", "content": "valid1"}\n' +
        '{"cursor": "bad", "timestamp": "2026-04-01 10:01", "content": "corrupted"}\n' +
        '{"cursor": 3, "timestamp": "2026-04-01 10:02", "content": "valid3"}\n',
      "utf8",
    );

    expect(s.readUnprocessedHistory(0).map((entry) => entry.cursor)).toEqual([1, 3]);
  });

  it("preserves valid entry order around corrupt neighbors", () => {
    const s = store();
    fs.writeFileSync(
      s.historyFile,
      '{"cursor": "x", "timestamp": "2026-04-01 10:00", "content": "bad"}\n' +
        '{"cursor": 2, "timestamp": "2026-04-01 10:01", "content": "good2"}\n' +
        '{"cursor": null, "timestamp": "2026-04-01 10:02", "content": "also bad"}\n' +
        '{"cursor": 4, "timestamp": "2026-04-01 10:03", "content": "good4"}\n',
      "utf8",
    );

    expect(s.readUnprocessedHistory(0).map((entry) => entry.cursor)).toEqual([2, 4]);
  });

  it("keeps normal unprocessed-history reads working", () => {
    const s = store();
    s.appendHistory("event 1");
    s.appendHistory("event 2");
    s.appendHistory("event 3");

    expect(s.readUnprocessedHistory(1).map((entry) => entry.cursor)).toEqual([2, 3]);
  });

  it("rejects boolean cursors and continues from the real max cursor", () => {
    const s = store();
    expect(MemoryStore.validCursor(true)).toBeNull();
    expect(MemoryStore.validCursor(false)).toBeNull();
    expect(MemoryStore.validCursor(5)).toBe(5);
    expect(MemoryStore.validCursor(0)).toBe(0);
    fs.writeFileSync(
      s.historyFile,
      '{"cursor": 4, "timestamp": "2026-04-01 10:00", "content": "real"}\n' +
        '{"cursor": true, "timestamp": "2026-04-01 10:01", "content": "boolean"}\n',
      "utf8",
    );
    fs.rmSync(s.cursorFile, { force: true });

    expect(s.appendHistory("next")).toBe(5);
    expect(s.readUnprocessedHistory(0).map((entry) => entry.cursor)).toEqual([4, 5]);
  });

  it("returns max valid cursor plus one rather than the last valid cursor plus one", () => {
    const s = store();
    fs.writeFileSync(
      s.historyFile,
      '{"cursor": 100, "timestamp": "2026-04-01 10:00", "content": "high"}\n' +
        '{"cursor": 5, "timestamp": "2026-04-01 10:01", "content": "out of order"}\n' +
        '{"cursor": "poison", "timestamp": "2026-04-01 10:02", "content": "tail corrupt"}\n',
      "utf8",
    );
    fs.rmSync(s.cursorFile, { force: true });

    expect(s.appendHistory("safe next")).toBe(101);
  });

  it("logs cursor corruption exactly once per store", () => {
    const s = store();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.writeFileSync(
      s.historyFile,
      '{"cursor": "bad1", "timestamp": "2026-04-01 10:00", "content": "x"}\n' +
        '{"cursor": 2, "timestamp": "2026-04-01 10:01", "content": "y"}\n',
      "utf8",
    );
    fs.rmSync(s.cursorFile, { force: true });

    s.readUnprocessedHistory(0);
    s.readUnprocessedHistory(0);
    s.appendHistory("another");

    const corruptionWarnings = warn.mock.calls.filter(([message]) => String(message).includes("non-int cursor"));
    expect(corruptionWarnings).toHaveLength(1);
  });
});
