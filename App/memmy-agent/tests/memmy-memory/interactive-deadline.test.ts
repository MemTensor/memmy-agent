import { describe, expect, it, vi } from "vitest";
import { AgentHookContext } from "../../src/core/agent-runtime/hook.js";
import { AgentRunner, AgentRunSpec } from "../../src/core/agent-runtime/runner.js";
import { LLMResponse } from "../../src/providers/base.js";
import { INTERACTIVE_MEMORY_TIMEOUT_MS } from "../../src/memmy-memory/client.js";
import { MemmyMemoryHook } from "../../src/memmy-memory/hook.js";
import { waitForMemory } from "../../src/memmy-memory/lifecycle.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function memoryClient() {
  return {
    health: vi.fn(async () => ({})),
    openSession: vi.fn(async (_body: any) => ({ sessionId: "memory-session", resumed: true })),
    startTurn: vi.fn(async (_turnId: string, _body: any) => ({ injectedContext: { markdown: "current memory" } })),
    completeTurn: vi.fn(async (_turnId: string, _body: any) => ({})),
    closeSession: vi.fn(async (_sessionId: string, _body: any) => ({ status: "noop" })),
  };
}

function context(turnId = "turn-1", sessionKey = "websocket:deadline") {
  return new AgentHookContext({
    spec: { sessionKey, turnId, workspace: "/tmp/workspace" },
    messages: [{ role: "user", content: "Open Calculator and enter 2×3." }],
  });
}

function expectUnavailable(ctx: AgentHookContext) {
  expect(ctx.messages?.[0].content).toEqual(expect.arrayContaining([
    expect.objectContaining({ text: expect.stringContaining('<memmy_memory_status status="unavailable">') }),
  ]));
}

describe("interactive memory deadline", () => {
  it("stays well inside the window the desktop client allows a send", () => {
    // The client abandons a message after 30s. A best-effort enrichment that
    // could outlast that turns a slow memory service into a failed send.
    expect(INTERACTIVE_MEMORY_TIMEOUT_MS).toBeLessThan(30_000);
  });

  it("gives up on a hanging memory service instead of holding the reply", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise(() => {});
      const raced = waitForMemory(() => never, INTERACTIVE_MEMORY_TIMEOUT_MS);
      const settled = raced.then(() => "resolved", (error: Error) => error.message);

      await vi.advanceTimersByTimeAsync(INTERACTIVE_MEMORY_TIMEOUT_MS + 1);

      expect(await settled).toContain("did not answer");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the value untouched when memory answers in time", async () => {
    await expect(waitForMemory(async () => "session-1", INTERACTIVE_MEMORY_TIMEOUT_MS)).resolves.toBe("session-1");
  });

  it("propagates a real failure rather than masking it as a timeout", async () => {
    await expect(waitForMemory(async () => {
      throw new Error("memory refused the connection");
    }, INTERACTIVE_MEMORY_TIMEOUT_MS)).rejects.toThrow("memory refused the connection");
  });

  it("does not let a hanging turn-start retrieval hold beforeRun", async () => {
    vi.useFakeTimers();
    try {
      const client = {
        openSession: vi.fn(async () => ({
          sessionId: "session-1",
          userId: "local-user",
          resumed: false,
        })),
        startTurn: vi.fn(() => new Promise(() => {})),
        completeTurn: vi.fn(),
      };
      const hook = new MemmyMemoryHook(client as any, { workspace: "/tmp/workspace" });
      const messages = [{ role: "user", content: "Open Calculator and enter 2×3." }];
      const run = hook.beforeRun(new AgentHookContext({
        spec: { sessionKey: "cli:deadline", workspace: "/tmp/workspace" },
        messages,
      }));

      await vi.advanceTimersByTimeAsync(INTERACTIVE_MEMORY_TIMEOUT_MS + 1);
      await expect(run).resolves.toBeUndefined();
      expect(messages[0].content).toEqual(expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("<memmy_memory_status status=\"unavailable\">") }),
      ]));
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["health", "openSession"] as const)("bounds a hanging %s before asking the model", async (stage) => {
    vi.useFakeTimers();
    try {
      const client = memoryClient();
      client[stage].mockImplementation(() => new Promise(() => {}));
      const hook = new MemmyMemoryHook(client as any);
      const ctx = context();
      const run = hook.beforeRun(ctx);

      await vi.advanceTimersByTimeAsync(INTERACTIVE_MEMORY_TIMEOUT_MS + 1);
      await run;

      expectUnavailable(ctx);
      expect(client.startTurn).not.toHaveBeenCalled();
      await hook.afterRun(ctx, { finalContent: "5", stopReason: "completed" });
      expect(client.completeTurn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a failed background open so a later turn can recover", async () => {
    vi.useFakeTimers();
    try {
      const client = memoryClient();
      const opening = deferred<any>();
      client.openSession.mockImplementationOnce(() => opening.promise);
      const hook = new MemmyMemoryHook(client as any);
      const first = hook.beforeRun(context());
      await vi.advanceTimersByTimeAsync(INTERACTIVE_MEMORY_TIMEOUT_MS + 1);
      await first;
      opening.reject(new Error("temporarily unavailable"));
      await vi.advanceTimersByTimeAsync(0);

      await hook.beforeRun(context("turn-2"));

      expect(client.openSession).toHaveBeenCalledTimes(2);
      expect(client.startTurn).toHaveBeenCalledOnce();
      expect(hook.lastError).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares the prompt L3 budget with turn retrieval rather than granting another eight seconds", async () => {
    vi.useFakeTimers();
    try {
      const client = {
        ...memoryClient(),
        health: vi.fn(async () => ({ features: { l3WorldModelProtocolVersions: [2] } })),
        l3WorldModelContext: vi.fn(() => new Promise<any>(resolve => {
          setTimeout(() => resolve({ memoryId: null, projectId: null, renderedContext: "", sourceMemoryIds: [] }), 6_000);
        })),
      };
      client.startTurn.mockImplementation(() => new Promise(() => {}));
      const hook = new MemmyMemoryHook(client as any);
      const ctx = context();
      const prompt = hook.beforeBuildSystemPrompt(ctx);
      await vi.advanceTimersByTimeAsync(6_000);
      await prompt;
      let completed = false;
      const run = hook.beforeRun(ctx).then(() => { completed = true; });

      await vi.advanceTimersByTimeAsync(1_999);
      expect(completed).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await run;

      expectUnavailable(ctx);
      expect(client.startTurn).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips retrieval after L3 uses the budget and gives a different turn its own budget", async () => {
    vi.useFakeTimers();
    try {
      const client = {
        ...memoryClient(),
        health: vi.fn(async () => ({ features: { l3WorldModelProtocolVersions: [2] } })),
        l3WorldModelContext: vi.fn(() => new Promise<any>(() => {})),
      };
      const hook = new MemmyMemoryHook(client as any);
      const ctx = context();
      const prompt = hook.beforeBuildSystemPrompt(ctx);
      await vi.advanceTimersByTimeAsync(INTERACTIVE_MEMORY_TIMEOUT_MS + 1);
      await prompt;
      const afterPrompt = Date.now();
      await hook.beforeRun(ctx);

      expect(Date.now()).toBe(afterPrompt);
      expectUnavailable(ctx);
      expect(client.startTurn).not.toHaveBeenCalled();

      // An expired prompt from another turn cannot exhaust a new turn's
      // independent budget, even if it is delivered out of order.
      const stalePrompt = hook.beforeBuildSystemPrompt(context("stale-prompt"));
      await vi.advanceTimersByTimeAsync(INTERACTIVE_MEMORY_TIMEOUT_MS + 1);
      await stalePrompt;
      await hook.beforeRun(context("turn-2"));
      expect(client.startTurn).toHaveBeenCalledOnce();
      expect(hook.lastError).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the real runner answer while Memory health never resolves", async () => {
    vi.useFakeTimers();
    try {
      const client = memoryClient();
      client.health.mockImplementation(() => new Promise(() => {}));
      const hook = new MemmyMemoryHook(client as any);
      const provider = { chatWithRetry: vi.fn(async () => new LLMResponse({ content: "5" })) };
      const run = new AgentRunner(provider as any).run(new AgentRunSpec({
        messages: context().messages,
        sessionKey: "websocket:runner-deadline",
        turnId: "turn-1",
        model: "test-model",
        hook,
      }));

      await vi.advanceTimersByTimeAsync(INTERACTIVE_MEMORY_TIMEOUT_MS + 1);
      const result = await run;

      expect(result.finalContent).toBe("5");
      expect(result.stopReason).toBe("completed");
      expect(provider.chatWithRetry).toHaveBeenCalledOnce();
      expect(client.completeTurn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
