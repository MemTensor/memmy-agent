import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../../src/core/session/manager.js";

let roots: string[] = [];

function sessionsRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-sessions-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe("SessionManager save fsync", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager(sessionsRoot());
  });

  it("does not call fsync when fsync is false", () => {
    const session = manager.getOrCreate("test:no-fsync");
    session.addMessage("user", "hello");
    const fsync = vi.spyOn(fs, "fsyncSync").mockImplementation(() => undefined);
    manager.save(session, { fsync: false });
    expect(fsync).not.toHaveBeenCalled();
  });

  it("calls fsync for file and directory when requested", () => {
    const session = manager.getOrCreate("test:with-fsync");
    session.addMessage("user", "hello");
    const fsync = vi.spyOn(fs, "fsyncSync").mockImplementation(() => undefined);
    manager.save(session, { fsync: true });
    expect(fsync).toHaveBeenCalledTimes(process.platform === "win32" ? 1 : 2);
  });

  it("defaults to no fsync", () => {
    const session = manager.getOrCreate("test:default");
    session.addMessage("user", "hello");
    const fsync = vi.spyOn(fs, "fsyncSync").mockImplementation(() => undefined);
    manager.save(session);
    expect(fsync).not.toHaveBeenCalled();
  });
});

describe("SessionManager flushAll", () => {
  it("returns zero for an empty cache", () => {
    expect(new SessionManager(sessionsRoot()).flushAll()).toBe(0);
  });

  it("saves cached sessions with fsync", () => {
    const manager = new SessionManager(sessionsRoot());
    const s1 = manager.getOrCreate("test:session-1");
    s1.addMessage("user", "msg 1");
    manager.save(s1);
    const s2 = manager.getOrCreate("test:session-2");
    s2.addMessage("user", "msg 2");
    manager.save(s2);

    const fsync = vi.spyOn(fs, "fsyncSync").mockImplementation(() => undefined);
    expect(manager.flushAll()).toBe(2);
    expect(fsync).toHaveBeenCalledTimes(process.platform === "win32" ? 2 : 4);
  });

  it("uses fsync when flushing a cached session", () => {
    const manager = new SessionManager(sessionsRoot());
    const session = manager.getOrCreate("test:fsync-check");
    session.addMessage("user", "important");
    manager.save(session);

    const fsync = vi.spyOn(fs, "fsyncSync").mockImplementation(() => undefined);

    expect(manager.flushAll()).toBe(1);
    expect(fsync).toHaveBeenCalledTimes(process.platform === "win32" ? 1 : 2);
  });

  it("continues when one cached session fails to save", () => {
    const manager = new SessionManager(sessionsRoot());
    const good = manager.getOrCreate("test:good");
    good.addMessage("user", "ok");
    manager.save(good);
    const bad = manager.getOrCreate("test:bad");
    bad.addMessage("user", "ok");
    manager.save(bad);

    const original = manager.save.bind(manager);
    let calls = 0;
    manager.save = ((session, options) => {
      calls += 1;
      if (session.key === "test:bad") throw new Error("disk on fire");
      original(session, options);
    }) as SessionManager["save"];

    expect(manager.flushAll()).toBe(1);
    expect(calls).toBe(2);
  });

  it("persists flushed data for a fresh manager", () => {
    const root = sessionsRoot();
    const manager = new SessionManager(root);
    const session = manager.getOrCreate("test:persist");
    session.addMessage("user", "remember this");
    session.addMessage("assistant", "noted");
    manager.save(session);
    manager.flushAll();

    const reloaded = new SessionManager(root).getOrCreate("test:persist");
    expect(reloaded.getHistory({ maxMessages: 100 }).map((message) => message.content)).toEqual(["remember this", "noted"]);
  });
});
