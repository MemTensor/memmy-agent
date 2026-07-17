import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Session, SessionManager } from "../../../src/core/session/manager.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-session-delete-"));
  tempRoots.push(root);
  return root;
}

function seed(root = tempRoot(), key = "telegram:abc"): SessionManager {
  const manager = new SessionManager(root);
  const session = new Session({ key });
  session.addMessage("user", "hello");
  session.addMessage("assistant", "hi back");
  manager.save(session);
  return manager;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("SessionManager delete", () => {
  it("removes the file and invalidates the cache", () => {
    const manager = seed(tempRoot(), "telegram:abc");
    const filePath = manager.pathFor("telegram:abc");
    expect(fs.existsSync(filePath)).toBe(true);

    const cached = manager.getOrCreate("telegram:abc");
    expect(cached.messages.length).toBeGreaterThan(0);

    expect(manager.deleteSession("telegram:abc")).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);

    const fresh = manager.getOrCreate("telegram:abc");
    expect(fresh.messages).toEqual([]);
  });

  it("returns false when the session file is missing", () => {
    const manager = new SessionManager(tempRoot());

    expect(manager.deleteSession("nope:none")).toBe(false);
  });

  it("reads session file metadata and messages", () => {
    const manager = seed(tempRoot(), "telegram:abc");

    const data = manager.readSessionFile("telegram:abc");

    expect(data).not.toBeNull();
    expect(data?.key).toBe("telegram:abc");
    expect(Array.isArray(data?.messages)).toBe(true);
    expect(data?.messages.map((message: Record<string, unknown>) => message.role)).toEqual(["user", "assistant"]);
    expect(data?.createdAt).toBeTruthy();
    expect(data?.updatedAt).toBeTruthy();
  });

  it("does not populate the session cache when reading a session file", () => {
    const manager = seed(tempRoot(), "telegram:abc");
    manager.invalidate("telegram:abc");
    expect(manager.sessions.has("telegram:abc")).toBe(false);

    manager.readSessionFile("telegram:abc");

    expect(manager.sessions.has("telegram:abc")).toBe(false);
  });

  it("returns null when reading a missing session file", () => {
    const manager = new SessionManager(tempRoot());

    expect(manager.readSessionFile("nope:none")).toBeNull();
  });

  it("uses safeKey consistently with the internal file path", () => {
    const manager = new SessionManager(tempRoot());
    const key = "telegram:abc/def";
    const expected = path.basename(manager.pathFor(key));

    expect(`${SessionManager.safeKey(key)}.jsonl`).toBe(expected);
  });
});
