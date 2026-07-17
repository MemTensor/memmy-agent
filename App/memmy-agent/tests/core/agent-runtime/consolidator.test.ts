import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ARCHIVE_SUMMARY_MAX_CHARS, Consolidator, MemoryStore } from "../../../src/core/agent-runtime/memory.js";
import { Session, SessionManager } from "../../../src/core/session/manager.js";

const roots: string[] = [];

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-consolidator-"));
  roots.push(dir);
  return dir;
}

function provider(content = "summary", finishReason = "stop"): any {
  return {
    generation: { maxTokens: 100 },
    chatWithRetry: vi.fn(async () => ({ content, finishReason, finish_reason: finishReason })),
    estimatePromptTokens: vi.fn(() => [10, "test"]),
  };
}

function makeConsolidator(opts: { contextWindowTokens?: number; maxCompletionTokens?: number; provider?: any } = {}) {
  const root = workspace();
  const store = new MemoryStore(root);
  const sessions = new SessionManager(root);
  const p = opts.provider ?? provider();
  const consolidator = new Consolidator({
    store,
    provider: p,
    model: "test-model",
    sessions,
    contextWindowTokens: opts.contextWindowTokens ?? 1000,
    maxCompletionTokens: opts.maxCompletionTokens ?? 100,
    buildMessages: ({ history }: any) => history,
    getToolDefinitions: () => [],
  });
  return { root, store, sessions, provider: p, consolidator };
}

function makeMockConsolidator() {
  const root = workspace();
  const store = new MemoryStore(root);
  const p = provider();
  const cache: Record<string, any> = {};
  const sessions = {
    sessionCache: cache,
    save: vi.fn(),
    getOrCreate: vi.fn((key: string) => cache[key] ?? new Session({ key })),
  };
  const consolidator = new Consolidator({
    store,
    provider: p,
    model: "test-model",
    sessions,
    contextWindowTokens: 1000,
    maxCompletionTokens: 100,
    buildMessages: ({ history }: any) => history,
    getToolDefinitions: () => [],
  });
  return { store, provider: p, sessions, cache, consolidator };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Consolidator archive", () => {
  it("summarizes messages and appends to history", async () => {
    const { store, provider: p, consolidator } = makeConsolidator({ provider: provider("User fixed a bug in the auth module.") });

    const result = await consolidator.archive(
      [{ role: "user", content: "fix the auth bug" }, { role: "assistant", content: "Done." }],
      { sessionKey: "websocket:chat-1" },
    );

    expect(result).toBe("User fixed a bug in the auth module.");
    expect(store.readUnprocessedHistory(0)).toHaveLength(1);
    expect(store.readUnprocessedHistory(0)[0].session_key).toBe("websocket:chat-1");
    const systemPrompt = p.chatWithRetry.mock.calls[0][0].messages[0].content;
    expect(systemPrompt).toContain("User facts");
    expect(systemPrompt).toContain("Skip: code patterns that can be inferred from source");
    expect(systemPrompt).toContain("If nothing noteworthy happened, output: (nothing)");
  });

  it("raw-archives messages when the LLM throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = { generation: { maxTokens: 100 }, chatWithRetry: vi.fn(async () => { throw new Error("API error"); }) };
    const { store, consolidator } = makeConsolidator({ provider: p });

    await expect(
      consolidator.archive([{ role: "user", content: "hello" }], { sessionKey: "websocket:chat-2" }),
    ).resolves.toBeNull();

    const entries = store.readUnprocessedHistory(0);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toContain("[RAW]");
    expect(entries[0].session_key).toBe("websocket:chat-2");
  });

  it("skips empty archive inputs", async () => {
    const { consolidator } = makeConsolidator();
    await expect(consolidator.archive([])).resolves.toBeNull();
  });

  it("falls back to raw archive on error finish_reason", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { store, consolidator } = makeConsolidator({ provider: provider("Error: overloaded", "error") });

    await expect(consolidator.archive([{ role: "user", content: "fix" }, { role: "assistant", content: "done" }])).resolves.toBeNull();

    const entry = store.readUnprocessedHistory(0)[0];
    expect(entry.content).toContain("[RAW]");
    expect(entry.content).not.toContain("Error: overloaded");
  });

  it("preserves summaries on successful archive responses", async () => {
    const { store, consolidator } = makeConsolidator({ provider: provider("User fixed a bug in the auth module.", "stop") });

    await expect(consolidator.archive([{ role: "user", content: "fix" }, { role: "assistant", content: "Done." }])).resolves.toBe("User fixed a bug in the auth module.");

    expect(store.readUnprocessedHistory(0)[0].content).not.toContain("[RAW]");
  });
});

describe("Consolidator token and replay-window compaction", () => {
  it("does not consolidate when prompt pressure is below threshold", async () => {
    const { cache, consolidator } = makeMockConsolidator();
    const session = new Session({ key: "test:key", messages: [{ role: "user", content: "hi" }] });
    cache[session.key] = session;
    vi.spyOn(consolidator, "estimateSessionPromptTokens").mockReturnValue([100, "test"]);
    const archive = vi.spyOn(consolidator, "archive").mockResolvedValue("summary");
    const onCompactionEvent = vi.fn();

    const result = await consolidator.maybeConsolidateByTokens(session, { onCompactionEvent });

    expect(archive).not.toHaveBeenCalled();
    expect(onCompactionEvent).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: "token", started: false, changed: false, summary: null, error: null });
  });

  it("uses the full unconsolidated tail for token estimation", () => {
    const { consolidator } = makeConsolidator();
    const session = new Session({ key: "test:full-tail" });
    for (let i = 0; i < 160; i += 1) session.addMessage("user", `msg-${i}`);
    let captured: Record<string, any>[] = [];
    let capturedArgs: Record<string, any> = {};
    consolidator.unifiedSession = true;
    consolidator.buildMessages = (args: any) => {
      const { history } = args;
      capturedArgs = args;
      captured = history;
      return history;
    };

    consolidator.estimateSessionPromptTokens(session);

    expect(captured).toHaveLength(160);
    expect(captured[0].content).toContain("msg-0");
    expect(capturedArgs).toMatchObject({ sessionKey: "test:full-tail", unifiedSession: true });
  });

  it("archives replay-window overflow even under token budget", async () => {
    const { cache, sessions, consolidator } = makeMockConsolidator();
    consolidator.safetyBuffer = 0;
    const session = new Session({ key: "test:replay-overflow" });
    for (let i = 0; i < 10; i += 1) {
      session.addMessage("user", `u${i}`);
      session.addMessage("assistant", `a${i}`);
    }
    cache[session.key] = session;
    vi.spyOn(consolidator, "estimateSessionPromptTokens").mockReturnValue([100, "test"]);
    const archive = vi.spyOn(consolidator, "archive").mockResolvedValue("old conversation summary");

    await consolidator.maybeConsolidateByTokens(session, { replayMaxMessages: 6 });

    const archived = archive.mock.calls[0][0];
    expect(archived[0].content).toBe("u0");
    expect(archived.at(-1)?.content).toBe("a6");
    expect(archive).toHaveBeenCalledWith(expect.any(Array), { sessionKey: "test:replay-overflow" });
    expect(session.lastConsolidated).toBe(14);
    expect(session.metadata.lastSummary.text).toBe("old conversation summary");
    expect(sessions.save).toHaveBeenCalled();
  });

  it("emits token compaction events only around real archive work", async () => {
    const { cache, consolidator } = makeMockConsolidator();
    consolidator.safetyBuffer = 0;
    const session = new Session({ key: "test:compaction-events" });
    for (let i = 0; i < 10; i += 1) {
      session.addMessage("user", `u${i}`);
      session.addMessage("assistant", `a${i}`);
    }
    cache[session.key] = session;
    vi.spyOn(consolidator, "estimateSessionPromptTokens").mockReturnValue([100, "test"]);
    vi.spyOn(consolidator, "archive").mockResolvedValue("old conversation summary");
    const events: Array<Record<string, any>> = [];

    const result = await consolidator.maybeConsolidateByTokens(session, {
      replayMaxMessages: 6,
      onCompactionEvent: (event) => {
        events.push({ ...event });
      },
    });

    expect(events.map((event) => event.status)).toEqual(["running", "done"]);
    expect(events[0]).toMatchObject({ kind: "token", replayMaxMessages: 6 });
    expect(events[1]).toMatchObject({ kind: "token", replayMaxMessages: 6, changed: true });
    expect(result).toMatchObject({ kind: "token", replayMaxMessages: 6, started: true, changed: true, summary: "old conversation summary", error: null });
  });

  it("does not let compaction event failures interrupt archive work", async () => {
    const { cache, consolidator } = makeMockConsolidator();
    consolidator.safetyBuffer = 0;
    const session = new Session({ key: "test:best-effort-events" });
    for (let i = 0; i < 10; i += 1) {
      session.addMessage("user", `u${i}`);
      session.addMessage("assistant", `a${i}`);
    }
    cache[session.key] = session;
    vi.spyOn(consolidator, "estimateSessionPromptTokens").mockReturnValue([100, "test"]);
    const archive = vi.spyOn(consolidator, "archive").mockResolvedValue("old conversation summary");
    const onCompactionEvent = vi.fn(async () => {
      throw new Error("websocket down");
    });

    const result = await consolidator.maybeConsolidateByTokens(session, {
      replayMaxMessages: 6,
      onCompactionEvent,
    });

    expect(archive).toHaveBeenCalledOnce();
    expect(onCompactionEvent).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ started: true, changed: true, error: null });
  });

  it("emits compaction events while waiting for an existing compaction lock when requested", async () => {
    const { cache, consolidator } = makeMockConsolidator();
    consolidator.safetyBuffer = 0;
    const session = new Session({ key: "test:lock-wait", messages: [{ role: "user", content: "hi" }] });
    cache[session.key] = session;
    vi.spyOn(consolidator, "estimateSessionPromptTokens").mockReturnValue([100, "test"]);
    const archive = vi.spyOn(consolidator, "archive").mockResolvedValue("summary");
    const lock = consolidator.getLock(session.key);
    let releaseLock!: () => void;
    const lockEntered = new Promise<void>((resolve) => {
      void lock.runExclusive(async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseLock = release;
        });
      });
    });
    await lockEntered;
    const events: Array<Record<string, any>> = [];
    let resolveFirstEvent!: () => void;
    const firstEvent = new Promise<void>((resolve) => {
      resolveFirstEvent = resolve;
    });

    const resultPromise = consolidator.maybeConsolidateByTokens(session, {
      notifyOnLockWait: true,
      onCompactionEvent: (event) => {
        events.push({ ...event });
        if (events.length === 1) resolveFirstEvent();
      },
    });
    await firstEvent;

    expect(events.map((event) => event.status)).toEqual(["running"]);
    releaseLock();
    const result = await resultPromise;

    expect(events.map((event) => event.status)).toEqual(["running", "done"]);
    expect(archive).not.toHaveBeenCalled();
    expect(result).toMatchObject({ started: true, changed: false, error: null });
  });

  it("does not emit lock-wait events unless notifyOnLockWait is enabled", async () => {
    const { cache, consolidator } = makeMockConsolidator();
    consolidator.safetyBuffer = 0;
    const session = new Session({ key: "test:lock-wait-disabled", messages: [{ role: "user", content: "hi" }] });
    cache[session.key] = session;
    vi.spyOn(consolidator, "estimateSessionPromptTokens").mockReturnValue([100, "test"]);
    const archive = vi.spyOn(consolidator, "archive").mockResolvedValue("summary");
    const onCompactionEvent = vi.fn();
    const lock = consolidator.getLock(session.key);
    let releaseLock!: () => void;
    const lockEntered = new Promise<void>((resolve) => {
      void lock.runExclusive(async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseLock = release;
        });
      });
    });
    await lockEntered;

    const resultPromise = consolidator.maybeConsolidateByTokens(session, { onCompactionEvent });
    await Promise.resolve();
    expect(onCompactionEvent).not.toHaveBeenCalled();
    releaseLock();
    const result = await resultPromise;

    expect(archive).not.toHaveBeenCalled();
    expect(onCompactionEvent).not.toHaveBeenCalled();
    expect(result).toMatchObject({ started: false, changed: false, error: null });
  });

  it("does not duplicate running when lock wait is followed by archive work", async () => {
    const { cache, consolidator } = makeMockConsolidator();
    consolidator.safetyBuffer = 0;
    const session = new Session({ key: "test:lock-wait-archive" });
    for (let i = 0; i < 4; i += 1) {
      session.addMessage("user", `u${i}`);
      session.addMessage("assistant", `a${i}`);
    }
    cache[session.key] = session;
    vi.spyOn(consolidator, "estimateSessionPromptTokens")
      .mockReturnValueOnce([1000, "test"])
      .mockReturnValue([100, "test"]);
    const archive = vi.spyOn(consolidator, "archive").mockResolvedValue("old conversation summary");
    const lock = consolidator.getLock(session.key);
    let releaseLock!: () => void;
    const lockEntered = new Promise<void>((resolve) => {
      void lock.runExclusive(async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseLock = release;
        });
      });
    });
    await lockEntered;
    const events: Array<Record<string, any>> = [];
    let resolveFirstEvent!: () => void;
    const firstEvent = new Promise<void>((resolve) => {
      resolveFirstEvent = resolve;
    });

    const resultPromise = consolidator.maybeConsolidateByTokens(session, {
      notifyOnLockWait: true,
      onCompactionEvent: (event) => {
        events.push({ ...event });
        if (events.length === 1) resolveFirstEvent();
      },
    });
    await firstEvent;
    releaseLock();
    const result = await resultPromise;

    expect(events.map((event) => event.status)).toEqual(["running", "done"]);
    expect(archive).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ started: true, changed: true, error: null });
  });

  it("emits an error event after running when archive throws", async () => {
    const { cache, consolidator } = makeMockConsolidator();
    consolidator.safetyBuffer = 0;
    const session = new Session({ key: "test:event-error" });
    for (let i = 0; i < 10; i += 1) {
      session.addMessage("user", `u${i}`);
      session.addMessage("assistant", `a${i}`);
    }
    cache[session.key] = session;
    vi.spyOn(consolidator, "estimateSessionPromptTokens").mockReturnValue([100, "test"]);
    vi.spyOn(consolidator, "archive").mockRejectedValue(new Error("archive failed"));
    const events: Array<Record<string, any>> = [];

    await expect(consolidator.maybeConsolidateByTokens(session, {
      replayMaxMessages: 6,
      onCompactionEvent: (event) => {
        events.push({ ...event });
      },
    })).rejects.toThrow("archive failed");

    expect(events.map((event) => event.status)).toEqual(["running", "error"]);
    expect(events[1]).toMatchObject({ kind: "token", replayMaxMessages: 6, changed: false });
  });

  it("matches replay-window overflow to the history tool boundary", async () => {
    const { cache, consolidator } = makeMockConsolidator();
    const session = new Session({ key: "test:replay-tool-boundary" });
    session.addMessage("user", "run the tool");
    session.addMessage("assistant", "", { tool_calls: [{ id: "call-1", type: "function", function: { name: "x", arguments: "{}" } }] });
    session.addMessage("tool", "tool result", { tool_call_id: "call-1", name: "x" });
    session.addMessage("assistant", "final answer");
    cache[session.key] = session;
    vi.spyOn(consolidator, "estimateSessionPromptTokens").mockReturnValue([100, "test"]);
    const archive = vi.spyOn(consolidator, "archive").mockResolvedValue("tool turn summary");

    await consolidator.maybeConsolidateByTokens(session, { replayMaxMessages: 2 });

    expect(archive.mock.calls[0][0].map((msg) => msg.role)).toEqual(["user", "assistant", "tool"]);
    expect(session.lastConsolidated).toBe(3);
    expect(session.getHistory(2)).toEqual([{ role: "assistant", content: "final answer" }]);
  });

  it("archives a large chunk without a cap", async () => {
    const { cache, consolidator } = makeMockConsolidator();
    consolidator.safetyBuffer = 0;
    const session = new Session({ key: "test:key" });
    for (let i = 0; i < 70; i += 1) session.messages.push({ role: i === 0 || i === 50 || i === 61 ? "user" : "assistant", content: `m${i}` });
    cache[session.key] = session;
    vi.spyOn(consolidator, "estimateSessionPromptTokens").mockReturnValueOnce([1200, "test"]).mockReturnValueOnce([400, "test"]);
    const archive = vi.spyOn(consolidator, "archive").mockResolvedValue("summary");

    await consolidator.maybeConsolidateByTokens(session);

    expect(archive.mock.calls[0][0][0].content).toBe("m0");
    expect(archive).toHaveBeenCalledWith(expect.any(Array), { sessionKey: "test:key" });
    expect(session.lastConsolidated).toBeGreaterThan(0);
  });

  it("advances lastConsolidated when raw archive fallback fires", async () => {
    const { cache, consolidator } = makeMockConsolidator();
    consolidator.safetyBuffer = 0;
    const session = new Session({ key: "test:key", metadata: {} });
    for (let i = 0; i < 70; i += 1) session.messages.push({ role: i === 0 || i === 50 ? "user" : "assistant", content: `m${i}` });
    cache[session.key] = session;
    vi.spyOn(consolidator, "estimateSessionPromptTokens").mockReturnValueOnce([1200, "test"]).mockReturnValueOnce([400, "test"]);
    vi.spyOn(consolidator, "archive").mockResolvedValue(null);

    await consolidator.maybeConsolidateByTokens(session);

    expect(session.lastConsolidated).toBe(50);
  });

  it("breaks the consolidation round loop after raw archive fallback", async () => {
    const { cache, consolidator } = makeMockConsolidator();
    consolidator.safetyBuffer = 0;
    const session = new Session({ key: "test:key", metadata: {} });
    for (let i = 0; i < 70; i += 1) session.messages.push({ role: [0, 20, 40, 60].includes(i) ? "user" : "assistant", content: `m${i}` });
    cache[session.key] = session;
    vi.spyOn(consolidator, "estimateSessionPromptTokens").mockReturnValue([1200, "test"]);
    const archive = vi.spyOn(consolidator, "archive").mockResolvedValue(null);

    await consolidator.maybeConsolidateByTokens(session);

    expect(archive).toHaveBeenCalledOnce();
  });

  it("respects a boundary past a long assistant/tool chain", async () => {
    const { cache, consolidator } = makeMockConsolidator();
    consolidator.safetyBuffer = 0;
    const session = new Session({ key: "test:key" });
    for (let i = 0; i < 70; i += 1) session.messages.push({ role: i === 0 || i === 61 ? "user" : "assistant", content: `m${i}` });
    cache[session.key] = session;
    vi.spyOn(consolidator, "estimateSessionPromptTokens").mockReturnValueOnce([1200, "test"]).mockReturnValueOnce([400, "test"]);
    vi.spyOn(consolidator, "archive").mockResolvedValue("summary");

    await consolidator.maybeConsolidateByTokens(session);

    expect(session.lastConsolidated).toBe(61);
  });
});

describe("Consolidator idle session compaction", () => {
  it("archives the old prefix, keeps a suffix, and stores lastSummary", async () => {
    const { sessions, consolidator } = makeConsolidator({ provider: provider("Summary of old conversation.") });
    const session = sessions.getOrCreate("cli:test");
    for (let i = 0; i < 20; i += 1) {
      session.addMessage("user", `user msg ${i}`);
      session.addMessage("assistant", `assistant msg ${i}`);
    }
    sessions.save(session);

    const result = await consolidator.compactIdleSession("cli:test", 8);

    expect(result).toBe("Summary of old conversation.");
    const reloaded = sessions.getOrCreate("cli:test");
    expect(reloaded.messages.length).toBeLessThanOrEqual(8);
    expect(reloaded.lastConsolidated).toBe(0);
    expect(reloaded.metadata.lastSummary.text).toBe("Summary of old conversation.");
    expect(reloaded.metadata.lastSummary.lastActive).toBeDefined();
    expect(sessions.getOrCreate("cli:test").key).toBe("cli:test");
    expect(consolidator.store.readUnprocessedHistory(0)[0].session_key).toBe("cli:test");
  });

  it("refreshes timestamps on empty idle sessions", async () => {
    const { sessions, consolidator } = makeConsolidator();
    const session = sessions.getOrCreate("cli:empty");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    session.updatedAt = old;
    sessions.save(session);

    await expect(consolidator.compactIdleSession("cli:empty")).resolves.toBe("");

    expect(new Date(sessions.getOrCreate("cli:empty").updatedAt).getTime()).toBeGreaterThan(new Date(old).getTime());
  });

  it("does not store lastSummary for a nothing summary", async () => {
    const { sessions, consolidator } = makeConsolidator({ provider: provider("(nothing)") });
    const session = sessions.getOrCreate("cli:nothing");
    for (let i = 0; i < 10; i += 1) {
      session.addMessage("user", `u${i}`);
      session.addMessage("assistant", `a${i}`);
    }
    sessions.save(session);

    await expect(consolidator.compactIdleSession("cli:nothing", 4)).resolves.toBe("(nothing)");

    expect(sessions.getOrCreate("cli:nothing").metadata.lastSummary).toBeUndefined();
  });

  it("still truncates idle sessions when the LLM fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = { generation: { maxTokens: 100 }, chatWithRetry: vi.fn(async () => { throw new Error("LLM unavailable"); }) };
    const { store, sessions, consolidator } = makeConsolidator({ provider: p });
    const session = sessions.getOrCreate("cli:fail");
    for (let i = 0; i < 10; i += 1) {
      session.addMessage("user", `u${i}`);
      session.addMessage("assistant", `a${i}`);
    }
    sessions.save(session);

    await expect(consolidator.compactIdleSession("cli:fail", 4)).resolves.toBeNull();

    expect(store.readUnprocessedHistory(0).some((entry) => String(entry.content).includes("[RAW]"))).toBe(true);
    expect(sessions.getOrCreate("cli:fail").messages.length).toBeLessThanOrEqual(4);
  });

  it("respects lastConsolidated when compacting idle sessions", async () => {
    const p = provider("Tail summary.");
    const { sessions, consolidator } = makeConsolidator({ provider: p });
    const session = sessions.getOrCreate("cli:offset");
    for (let i = 0; i < 30; i += 1) {
      session.addMessage("user", `u${i}`);
      session.addMessage("assistant", `a${i}`);
    }
    session.lastConsolidated = 50;
    sessions.save(session);

    await expect(consolidator.compactIdleSession("cli:offset", 4)).resolves.toBe("Tail summary.");

    const userContent = p.chatWithRetry.mock.calls[0][0].messages[1].content;
    expect(userContent).not.toContain("u0");
    expect(userContent.includes("u25") || userContent.includes("a25")).toBe(true);
  });

  it("holds the consolidation lock during idle compaction", async () => {
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const p = {
      generation: { maxTokens: 100 },
      chatWithRetry: vi.fn(async () => {
        started();
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { content: "Summary.", finishReason: "stop" };
      }),
    };
    const { sessions, consolidator } = makeConsolidator({ provider: p });
    const session = sessions.getOrCreate("cli:lock");
    for (let i = 0; i < 10; i += 1) {
      session.addMessage("user", `u${i}`);
      session.addMessage("assistant", `a${i}`);
    }
    sessions.save(session);
    const lock = consolidator.getLock("cli:lock");

    const task = consolidator.compactIdleSession("cli:lock", 4);
    await startedPromise;
    expect(lock.locked()).toBe(true);
    await task;
    expect(lock.locked()).toBe(false);
  });
});

describe("Consolidator stale session refresh", () => {
  it("reloads before the empty-session guard", async () => {
    const { sessions, consolidator } = makeConsolidator({ contextWindowTokens: 128_000, provider: provider("summary") });
    const fresh = sessions.getOrCreate("cli:test");
    fresh.addMessage("user", "fresh message");
    sessions.save(fresh);
    const staleEmpty = new Session({ key: "cli:test" });
    let seen: Session | null = null;
    vi.spyOn(consolidator, "estimateSessionPromptTokens").mockImplementation((session: any) => {
      seen = session;
      return [10, "test"];
    });

    await consolidator.maybeConsolidateByTokens(staleEmpty);

    expect(seen).toBe(fresh);
  });

  it("reloads stale session references after idle compact", async () => {
    const { sessions, consolidator } = makeConsolidator({ contextWindowTokens: 128_000, provider: provider("summary") });
    const session = sessions.getOrCreate("cli:test");
    for (let i = 0; i < 20; i += 1) {
      session.addMessage("user", `u${i}`);
      session.addMessage("assistant", `a${i}`);
    }
    sessions.save(session);
    const oldRef = session;

    await consolidator.compactIdleSession("cli:test", 8);
    await consolidator.maybeConsolidateByTokens(oldRef);

    expect(sessions.getOrCreate("cli:test").messages.length).toBeLessThanOrEqual(8);
  });
});

describe("MemoryStore raw archive truncation", () => {
  it("truncates large raw archive content", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new MemoryStore(workspace());

    store.rawArchive([{ role: "user", content: "x".repeat(50_000) }]);

    const entry = store.readUnprocessedHistory(0)[0];
    expect(String(entry.content).length).toBeLessThan(50_000);
    expect(entry.content).toContain("[RAW]");
  });

  it("preserves small raw archive content", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new MemoryStore(workspace());

    store.rawArchive([{ role: "user", content: "hello" }], { sessionKey: "websocket:chat-1" });

    expect(store.readUnprocessedHistory(0)[0].content).toContain("hello");
    expect(store.readUnprocessedHistory(0)[0].session_key).toBe("websocket:chat-1");
  });

  it("honors custom raw archive max chars", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new MemoryStore(workspace());

    store.rawArchive([{ role: "user", content: "a".repeat(200) }], { maxChars: 100 });

    expect(String(store.readUnprocessedHistory(0)[0].content).length).toBeLessThan(200);
  });
});

describe("Consolidator archive truncation", () => {
  it("truncates large formatted text before calling the LLM", async () => {
    const p = provider("Summary of large input.");
    const { consolidator } = makeConsolidator({ provider: p });

    await consolidator.archive([{ role: "user", content: "x".repeat(100_000) }]);

    expect(p.chatWithRetry.mock.calls[0][0].messages[1].content.length).toBeLessThan(50_000);
  });

  it("truncates with a small token budget", async () => {
    const p = provider("Summary.");
    const { consolidator } = makeConsolidator({ contextWindowTokens: 500, provider: p });

    await consolidator.archive([{ role: "user", content: "word ".repeat(50_000) }]);

    expect(p.chatWithRetry.mock.calls[0][0].messages[1].content.length).toBeLessThan(250_000);
  });

  it("caps oversized summaries before appending to history", async () => {
    const { store, consolidator } = makeConsolidator({ provider: provider("S".repeat(ARCHIVE_SUMMARY_MAX_CHARS * 10)) });

    await consolidator.archive([{ role: "user", content: "hi" }]);

    expect(String(store.readUnprocessedHistory(0)[0].content).length).toBeLessThanOrEqual(ARCHIVE_SUMMARY_MAX_CHARS + 50);
  });

  it("uses the positive input token budget for truncation", async () => {
    const p = provider("Summary.");
    const { consolidator } = makeConsolidator({ contextWindowTokens: 10_000, provider: p });
    consolidator.safetyBuffer = 0;

    await consolidator.archive([{ role: "user", content: "word ".repeat(50_000) }]);

    const sent = p.chatWithRetry.mock.calls[0][0].messages[1].content;
    expect(sent.length).toBeLessThan("word ".repeat(50_000).length);
    expect(sent.length).toBeLessThanOrEqual(9_900 * 4 + 200);
  });
});
