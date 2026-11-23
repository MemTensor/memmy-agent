import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { DEEPSEEK_HARNESS_PLUGIN_INDEX } from "../src/agent-source/integration/templates/memmy-deepseek-harness-plugin.js";

import { createRuntimeDeadline } from "../src/agent-source/integration/workspace-bridge/runtime.js";

type PreStepListener = (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>;
type SessionEventListener = (session: unknown, event: unknown) => Promise<void>;

describe("DeepSeek Harness automatic recall", () => {
  it.each([
    "deadline", "configured deadline", "host cancellation", "healthy response", "completed start at cancellation"
  ] as const)("handles %s during recall", async (scenario) => {
    const directory = mkdtempSync(join(tmpdir(), "memmy-dsh-recall-"));
    const host = new AbortController();
    const completeSourceTurn = vi.fn();
    const timeoutMs = scenario === "configured deadline" ? 5_000 : 3_000;
    const startDeadline = vi.fn(createRuntimeDeadline);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const signals: Array<AbortSignal | undefined> = [];
    let reachedRecall!: () => void;
    const recalling = new Promise<void>((resolve) => { reachedRecall = resolve; });
    let releaseRecall!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseRecall = resolve; });
    vi.stubGlobal("memmyRecallFixture", {
      createRuntimeDeadline: startDeadline,
      completeSourceTurn,
      readDeepseekHookSourceTurn: () => ({ turn: { profileId: "main" } }),
      async openRuntimeSession(_input: unknown, { signal }: { signal?: AbortSignal }) {
        signals.push(signal);
        return { sessionId: "fixture-memory-session" };
      },
      async loadRuntimeL3(_session: unknown, { signal }: { signal?: AbortSignal }) {
        signals.push(signal);
        return { additionalContext: "" };
      },
      async startRuntimeTurn(_session: unknown, _turn: string, _query: string, { signal }: { signal?: AbortSignal }) {
        signals.push(signal);
        reachedRecall();
        await Promise.race([blocked, new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        })]);
        signal?.throwIfAborted();
        if (scenario === "completed start at cancellation") host.abort();
        return { sourceMemoryIds: ["fixture-memory"], injectedContext: { markdown: "Fixture recall" } };
      }
    });

    let pending: Promise<unknown> | undefined;
    try {
      const index = join(directory, "index.mjs");
      writeFileSync(index, DEEPSEEK_HARNESS_PLUGIN_INDEX
        .replace('"@deepseek-ai/dsh-llm"', '"./messages.mjs"')
        .replace('"@deepseek-ai/dsh-tools"', '"./tools.mjs"'));
      writeFileSync(join(directory, "messages.mjs"), "export const createUserMessage = (input) => input;");
      writeFileSync(join(directory, "tools.mjs"), "export const defineTool = (input) => input;");
      writeFileSync(join(directory, "memmy-workspace-bridge.mjs"), [
        "export const { openRuntimeSession, loadRuntimeL3, startRuntimeTurn, createRuntimeDeadline, completeSourceTurn, readDeepseekHookSourceTurn } = globalThis.memmyRecallFixture;",
        "export const notifyRuntimeBoundary = () => {};"
      ].join("\n"));

      const plugin = await import(pathToFileURL(index).href);
      const listeners = new Map<string, unknown>();
      const warn = vi.fn();
      let drainCaptures: (() => Promise<unknown>) | undefined;
      plugin.apply({
        logger: { warn },
        systemPrompt: { section: vi.fn() },
        tools: { register: vi.fn() },
        on: (event: string, listener: unknown) => {
          listeners.set(event, listener);
        },
        effect: (effect: () => () => Promise<unknown>) => { drainCaptures = effect(); }
      }, scenario === "configured deadline" ? { autoRecallTimeoutMs: timeoutMs } : {});

      const messages = [{ source: { kind: "user" }, content: "Fixture query" }];
      const decision = { kind: "enter", messages };
      const session = { id: "fixture-session", header: {} };
      const onSessionEvent = listeners.get("session/event") as SessionEventListener;
      const onPreStep = listeners.get("agent/pre-step") as PreStepListener;
      await onSessionEvent(session, { type: "turn/start", data: { turn: 1 } });
      pending = onPreStep({
        agent: { id: "fixture-agent", session },
        messages,
        turn: 1,
        signal: host.signal
      }, async () => decision);
      await recalling;
      if (scenario === "healthy response") {
        releaseRecall();
        await expect(pending).resolves.toMatchObject({
          kind: "enter",
          messages: [messages[0], { source: { kind: "memmy-memory" } }]
        });
      } else {
        if (scenario === "host cancellation") host.abort();
        else if (scenario === "completed start at cancellation") releaseRecall();
        else await vi.advanceTimersByTimeAsync(timeoutMs);
        const stillBlocked = Symbol("recall is still blocking the turn");
        await expect(Promise.race([
          pending,
          new Promise((resolve) => setImmediate(() => resolve(stillBlocked)))
        ])).resolves.toBe(decision);
      }
      await onSessionEvent(session, { type: "turn/end", data: { turn: 1 } });
      await drainCaptures?.();
      const sourceMemoryIds = scenario === "completed start at cancellation" || scenario === "healthy response"
        ? ["fixture-memory"]
        : undefined;
      expect(completeSourceTurn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sourceMemoryIds }));
      expect(startDeadline).toHaveBeenCalledExactlyOnceWith(timeoutMs, host.signal);
      expect(signals).toHaveLength(3);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      expect(signals.every((signal) => signal === signals[0])).toBe(true);

      expect(signals[0]?.aborted).toBe(scenario !== "healthy response");
      const timedOut = scenario === "deadline" || scenario === "configured deadline";
      expect(warn).toHaveBeenCalledTimes(timedOut ? 1 : 0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      releaseRecall();
      await pending;
      vi.unstubAllGlobals();
      vi.useRealTimers();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
