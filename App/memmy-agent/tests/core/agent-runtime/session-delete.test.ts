import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Config } from "../../../src/config/schema.js";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
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

describe("AgentLoop Session deletion barrier", () => {
  it("waits for preparation, starts one best-effort Memory close, and does not await it", async () => {
    const root = tempRoot();
    const manager = seed(root, "websocket:delete-memory");
    const loop = makeLoop(root, manager);
    let releasePreparation!: () => void;
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    let releaseClose!: () => void;
    const closePending = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const closeSession = vi.fn(() => closePending);
    (loop as any).memmyMemoryIntegration.closeSession = closeSession;
    const operation = vi.fn(async () => manager.deleteSession("websocket:delete-memory"));

    const deletion = loop.withSessionDeletionBarrier(
      "websocket:delete-memory",
      () => preparation,
      operation
    );
    await Promise.resolve();
    expect(operation).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();

    releasePreparation();
    await deletion;
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledWith("websocket:delete-memory", "deleted");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(manager.readSessionFile("websocket:delete-memory")).toBeNull();
    releaseClose();
  });

  it("keeps deletion unchanged without a cached Memory close callback", async () => {
    const root = tempRoot();
    const manager = seed(root, "websocket:delete-local");
    const loop = makeLoop(root, manager);
    (loop as any).memmyMemoryIntegration.closeSession = undefined;

    await expect(loop.withSessionDeletionBarrier(
      "websocket:delete-local",
      async () => undefined,
      async () => manager.deleteSession("websocket:delete-local")
    )).resolves.toBe(true);
    expect(manager.readSessionFile("websocket:delete-local")).toBeNull();
  });

  it("swallows a best-effort Memory close failure and never retries it", async () => {
    const root = tempRoot();
    const manager = seed(root, "websocket:delete-close-failure");
    const loop = makeLoop(root, manager);
    const closeSession = vi.fn().mockRejectedValue(new Error("memory unavailable"));
    (loop as any).memmyMemoryIntegration.closeSession = closeSession;

    await expect(loop.withSessionDeletionBarrier(
      "websocket:delete-close-failure",
      async () => undefined,
      async () => manager.deleteSession("websocket:delete-close-failure")
    )).resolves.toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(manager.readSessionFile("websocket:delete-close-failure")).toBeNull();
  });
});

function makeLoop(root: string, sessionManager: SessionManager): AgentLoop {
  return new AgentLoop({
    config: new Config({ memmyMemory: { enabled: false } }),
    provider: {
      generation: { maxTokens: 128 },
      getDefaultModel: () => "test-model",
      chatWithRetry: vi.fn()
    },
    workspace: root,
    sessionManager,
    model: "test-model"
  });
}
