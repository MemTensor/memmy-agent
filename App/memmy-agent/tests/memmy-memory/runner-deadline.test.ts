import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentHookContext, SystemPromptBuildContext } from "../../src/core/agent-runtime/hook.js";
import { AgentRunner, AgentRunSpec } from "../../src/core/agent-runtime/runner.js";
import { LLMResponse } from "../../src/providers/base.js";
import { MemmyMemoryHook } from "../../src/memmy-memory/hook.js";
import { MemoryWriteQueue } from "../../src/memmy-memory/lifecycle.js";

vi.mock("../../src/analytics/memory-lifecycle-analytics.js", async (original) => ({
  ...(await original<typeof import("../../src/analytics/memory-lifecycle-analytics.js")>()),
  createMemoryLifecycleAnalytics: () => ({
    track: vi.fn(),
    trackAwait: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
  }),
}));
function deferred<T = any>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const health = { features: { l3WorldModelProtocolVersions: [2] } };
const opened = { sessionId: "session-1", projectId: null, resumed: true };
const l3 = {
  sessionId: "session-1",
  projectId: null,
  memoryId: null,
  memoryVersion: null,
  renderedContext: "",
  sourceMemoryIds: [],
};
const recalled = { sourceMemoryIds: [], injectedContext: null };
function fixture() {
  const client = {
    health: vi.fn(async () => health),
    openSession: vi.fn(async () => opened),
    l3WorldModelContext: vi.fn(async () => l3),
    startTurn: vi.fn(async () => recalled),
    completeTurn: vi.fn(async () => ({ rawTurnId: "raw-1", l1MemoryId: "l1-1" })),
    closeSession: vi.fn(async () => ({ status: "closed" })),
    l3WorldModelTraceHead: vi.fn(async () => ({ throughL1MemoryId: "l1-1" })),
    l3WorldModelBoundary: vi.fn(async () => ({})),
  };
  const hook = new MemmyMemoryHook(client as any);
  const model = vi.fn(async () => new LLMResponse({ content: "回答成功" }));
  const runner = new AgentRunner({ chatWithRetry: model } as any);
  const spec = new AgentRunSpec({
    sessionKey: "cli:deadline",
    turnId: "turn-1",
    hook,
    messages: [{ role: "user", content: "Inspect the pending memory operation" }],
    maxIterations: 1,
  });
  return {
    client,
    hook,
    runner,
    model,
    spec,
    ctx: new AgentHookContext({ spec, sessionKey: spec.sessionKey }),
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("memory deadlines on the real AgentRunner", () => {
  it.each(["health", "openSession"] as const)(
    "bounds %s across sessionStart, prompt and Runner, then captures after recovery",
    async (stage) => {
      const f = fixture();
      const pending = deferred();
      f.client[stage].mockImplementation(() => pending.promise);
      await f.hook.sessionStart(f.ctx);
      const prep = f.hook.beforeBuildSystemPrompt(f.ctx);
      await vi.advanceTimersByTimeAsync(8_000);
      await prep;
      expect((await f.runner.run(f.spec)).finalContent).toBe("回答成功");
      expect(f.model).toHaveBeenCalledTimes(1);
      expect(f.client[stage]).toHaveBeenCalledTimes(1);
      expect(f.client.startTurn).not.toHaveBeenCalled();
      expect(f.client.completeTurn).not.toHaveBeenCalled();
      pending.resolve(stage === "health" ? health : opened);
      await f.hook.flushPendingWrites();
      expect(f.client[stage]).toHaveBeenCalledTimes(1);
      expect(f.client.completeTurn).toHaveBeenCalledTimes(1);
      expect((f.client.completeTurn.mock.calls as any)[0][1]).toMatchObject({
        recallApplied: false,
        sourceMemoryIds: [],
        sessionId: "session-1",
        answer: "回答成功",
      });
      expect(f.client.l3WorldModelContext).not.toHaveBeenCalled();
    },
  );
  it("shares the remaining two seconds after six seconds of initialization", async () => {
    const f = fixture();
    const ready = deferred();
    const recall = deferred();
    f.client.health.mockImplementation(() => ready.promise);
    f.client.startTurn.mockImplementation(() => recall.promise);
    const prep = f.hook.beforeBuildSystemPrompt(f.ctx);
    await vi.advanceTimersByTimeAsync(6_000);
    ready.resolve(health);
    await prep;
    const run = f.runner.run(f.spec);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(f.model).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await run).finalContent).toBe("回答成功");
    const input = JSON.stringify(f.model.mock.calls);
    recall.resolve({ injectedContext: "late context", sourceMemoryIds: ["late-memory"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(f.model.mock.calls)).toBe(input);
    await f.hook.flushPendingWrites();
    expect((f.client.completeTurn.mock.calls as any)[0][1].recallApplied).toBe(false);
  });
  it.each(["startTurn", "l3WorldModelContext"] as const)(
    "ignores late %s results after the budget expires",
    async (stage) => {
      const f = fixture();
      const pending = deferred();
      f.client[stage].mockImplementation(() => pending.promise);
      const prep = f.hook.beforeBuildSystemPrompt(f.ctx);
      if (stage === "l3WorldModelContext") await vi.advanceTimersByTimeAsync(8_000);
      await prep;
      const run = f.runner.run(f.spec);
      if (stage === "startTurn") await vi.advanceTimersByTimeAsync(8_000);
      const result = await run;
      const before = JSON.stringify(result.messages);
      pending.resolve({
        ...l3,
        memoryId: "late",
        renderedContext: "late world model",
        injectedContext: "late recall",
        sourceMemoryIds: ["late"],
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(JSON.stringify(result.messages)).toBe(before);
      const prompt = new SystemPromptBuildContext({ sessionKey: f.spec.sessionKey });
      f.hook.onBuildSystemPrompt(prompt);
      expect(prompt.getSection("memmy-l3-world-model")).toBeNull();
      await f.hook.flushPendingWrites();
    },
  );
  it("cancels beforeRun promptly but lets shared initialization warm the session", async () => {
    const f = fixture();
    const ready = deferred();
    f.client.health.mockImplementation(() => ready.promise);
    const abort = new AbortController();
    f.spec.abortSignal = abort.signal;
    const run = f.runner.run(f.spec);
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    expect((await run).stopReason).toBe("cancelled");
    expect(f.model).not.toHaveBeenCalled();
    expect(f.client.completeTurn).not.toHaveBeenCalled();
    ready.resolve(health);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.hook.currentSessionId(f.spec.sessionKey)).toBe("session-1");
    expect(f.client.startTurn).not.toHaveBeenCalled();
  });
  it("isolates a cancelled first recall from the next turn", async () => {
    const f = fixture();
    const pending = deferred();
    f.client.startTurn.mockImplementationOnce(() => pending.promise);
    const abort = new AbortController();
    f.spec.abortSignal = abort.signal;
    const first = f.runner.run(f.spec);
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await first;
    const second = await f.runner.run(
      new AgentRunSpec({
        ...f.spec,
        turnId: "turn-2",
        abortSignal: null,
        messages: [{ role: "user", content: "Second request" }],
      }),
    );
    pending.resolve({ injectedContext: "first-turn-only", sourceMemoryIds: ["first"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(second.finalContent).toBe("回答成功");
    expect(JSON.stringify(second.messages)).not.toContain("first-turn-only");
    await f.hook.flushPendingWrites();
    expect(f.client.completeTurn).toHaveBeenCalledTimes(1);
    expect((f.client.completeTurn.mock.calls as any)[0][0]).toBe("turn-2");
  });
  it("does not let slow completion block answers or overwrite the next turn", async () => {
    const f = fixture();
    const pending = deferred();
    f.client.completeTurn.mockImplementationOnce(() => pending.promise);
    const first = await f.runner.run(f.spec);
    first.messages.length = 0;
    const second = await f.runner.run(
      new AgentRunSpec({
        ...f.spec,
        turnId: "turn-2",
        messages: [{ role: "user", content: "Second request" }],
      }),
    );
    expect(second.finalContent).toBe("回答成功");
    expect(f.model).toHaveBeenCalledTimes(2);
    expect(f.client.completeTurn).toHaveBeenCalledTimes(1);
    pending.resolve({ rawTurnId: "raw-1" });
    await f.hook.flushPendingWrites();
    const calls = f.client.completeTurn.mock.calls as any;
    expect(calls.map((call: any) => call[0])).toEqual(["turn-1", "turn-2"]);
    expect(calls[0][1].query).toBe("Inspect the pending memory operation");
    expect(calls[1][1].query).toBe("Second request");
  });
  it("closes a late initialization before opening a replacement session", async () => {
    const f = fixture();
    const pending = deferred();
    const operations: string[] = [];
    f.client.openSession
      .mockImplementationOnce(() => {
        operations.push("open-old");
        return pending.promise;
      })
      .mockImplementationOnce(async () => {
        operations.push("open-new");
        return { ...opened, sessionId: "session-2" };
      });
    f.client.closeSession.mockImplementation(async () => {
      operations.push("close-old");
      return { status: "closed" };
    });
    await f.hook.sessionStart(f.ctx);
    await vi.advanceTimersByTimeAsync(0);
    await f.hook.sessionEnd(f.ctx);
    expect(f.hook.currentSessionId(f.spec.sessionKey)).toBeNull();
    await f.hook.sessionStart(f.ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.client.openSession).toHaveBeenCalledTimes(1);
    pending.resolve(opened);
    await f.hook.flushPendingWrites();
    await vi.advanceTimersByTimeAsync(0);
    expect(operations).toEqual(["open-old", "close-old", "open-new"]);
    expect(f.hook.currentSessionId(f.spec.sessionKey)).toBe("session-2");
  });
  it("retries a failed close before allowing a replacement session", async () => {
    const f = fixture();
    await f.hook.beforeBuildSystemPrompt(f.ctx);
    f.client.closeSession.mockRejectedValueOnce(new Error("close temporarily unavailable"));
    await f.hook.sessionEnd(f.ctx);
    await f.hook.flushPendingWrites();
    f.client.openSession.mockResolvedValue({ ...opened, sessionId: "session-2" });
    await f.runner.run(new AgentRunSpec({ ...f.spec, turnId: "turn-2" }));
    await f.hook.flushPendingWrites();
    expect(f.client.closeSession).toHaveBeenCalledTimes(2);
    expect(f.client.openSession).toHaveBeenCalledTimes(2);
    expect(f.hook.currentSessionId(f.spec.sessionKey)).toBe("session-2");
  });
  it("does not attribute source IDs when the response contains no injected context", async () => {
    const f = fixture();
    f.client.startTurn.mockResolvedValue({
      sourceMemoryIds: ["not-delivered"],
      injectedContext: null,
    } as any);
    await f.runner.run(f.spec);
    await f.hook.flushPendingWrites();
    expect((f.client.completeTurn.mock.calls as any)[0][1]).toMatchObject({
      recallApplied: false,
      sourceMemoryIds: [],
    });
  });
  it("recovers from failed initialization on the next turn", async () => {
    const f = fixture();
    f.client.openSession.mockRejectedValueOnce(new Error("offline"));
    await f.hook.beforeRun(f.ctx);
    expect(f.client.startTurn).not.toHaveBeenCalled();
    await f.runner.run(new AgentRunSpec({ ...f.spec, turnId: "turn-2" }));
    expect(f.client.startTurn).toHaveBeenCalledTimes(1);
    await f.hook.flushPendingWrites();
  });
  it("does not block the foreground on a compaction boundary", async () => {
    const f = fixture();
    const pending = deferred();
    await f.hook.beforeBuildSystemPrompt(f.ctx);
    f.client.l3WorldModelTraceHead.mockImplementation(() => pending.promise);
    await f.hook.afterCompaction(
      new AgentHookContext({ spec: f.spec, compaction: { kind: "token", changed: true } }),
    );
    expect((await f.runner.run(f.spec)).finalContent).toBe("回答成功");
    pending.resolve({ throughL1MemoryId: "l1-1" });
    await f.hook.flushPendingWrites();
    expect(f.client.l3WorldModelBoundary).toHaveBeenCalledTimes(1);
    expect(f.client.completeTurn).toHaveBeenCalledTimes(1);
  });
  it("bounds shutdown and rejects late initialization after disposal", async () => {
    const f = fixture();
    const pending = deferred();
    f.client.health.mockImplementation(() => pending.promise);
    await f.hook.sessionStart(f.ctx);
    const disposal = f.hook.dispose();
    await vi.advanceTimersByTimeAsync(2_000);
    await disposal;
    pending.resolve(health);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.client.openSession).not.toHaveBeenCalled();
    expect(f.hook.currentSessionId(f.spec.sessionKey)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
describe("bounded memory capture queue", () => {
  it("limits payloads and expires hung queued tasks with a reported failure", async () => {
    const queue = new MemoryWriteQueue();
    const error = vi.fn();
    const pending = deferred();
    expect(queue.enqueue({}, 11 * 1024 * 1024, async () => {}, error)).toBe(false);
    const key = {};
    for (let index = 0; index < 100; index += 1)
      expect(queue.enqueue(key, 1, () => pending.promise, error)).toBe(true);
    expect(queue.enqueue(key, 1, async () => {}, error)).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    await queue.flush();
    expect(error).toHaveBeenCalledTimes(102);
    expect(queue.has(key)).toBe(false);
    pending.resolve(undefined);
  });
});
