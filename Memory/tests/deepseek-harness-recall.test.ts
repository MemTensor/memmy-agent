import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { DEEPSEEK_HARNESS_PLUGIN_INDEX } from "../src/agent-source/integration/templates/memmy-deepseek-harness-plugin.js";

type PreStepListener = (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>;

describe("DeepSeek Harness automatic recall", () => {
  it.each(["deadline", "host cancellation", "healthy response"] as const)("handles %s during recall", async (scenario) => {
    const directory = mkdtempSync(join(tmpdir(), "memmy-dsh-recall-"));
    const deadline = new AbortController();
    const host = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const signals: Array<AbortSignal | undefined> = [];
    let reachedRecall!: () => void;
    const recalling = new Promise<void>((resolve) => { reachedRecall = resolve; });
    let releaseRecall!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseRecall = resolve; });
    vi.stubGlobal("memmyRecallFixture", {
      async openRuntimeSession(input: { signal?: AbortSignal }) {
        signals.push(input.signal);
        return { sessionId: "fixture-memory-session" };
      },
      async loadRuntimeL3(_session: unknown, signal?: AbortSignal) {
        signals.push(signal);
        return { additionalContext: "" };
      },
      async startRuntimeTurn(_session: unknown, _turn: string, _query: string, signal?: AbortSignal) {
        signals.push(signal);
        reachedRecall();
        await Promise.race([blocked, new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        })]);
        signal?.throwIfAborted();
        return { injectedContext: { markdown: "Fixture recall" } };
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
        "export const { openRuntimeSession, loadRuntimeL3, startRuntimeTurn } = globalThis.memmyRecallFixture;",
        "export const completeSourceTurn = () => {};",
        "export const notifyRuntimeBoundary = () => {};",
        "export const readDeepseekHookSourceTurn = () => {};"
      ].join("\n"));

      const plugin = await import(pathToFileURL(index).href);
      const listeners = new Map<string, PreStepListener>();
      const warn = vi.fn();
      plugin.apply({
        logger: { warn },
        systemPrompt: { section: vi.fn() },
        tools: { register: vi.fn() },
        on: (event: string, listener: PreStepListener) => {
          listeners.set(event, listener);
        },
        effect: vi.fn()
      });

      const messages = [{ source: { kind: "user" }, content: "Fixture query" }];
      const decision = { kind: "enter", messages };
      pending = listeners.get("agent/pre-step")!({
        agent: { id: "fixture-agent", session: { id: "fixture-session", header: {} } },
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
        (scenario === "deadline" ? deadline : host).abort();
        const stillBlocked = Symbol("recall is still blocking the turn");
        await expect(Promise.race([
          pending,
          new Promise((resolve) => setImmediate(() => resolve(stillBlocked)))
        ])).resolves.toBe(decision);
      }
      expect(timeout).toHaveBeenCalledExactlyOnceWith(3_000);
      expect(signals).toHaveLength(3);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      expect(signals.every((signal) => signal === signals[0])).toBe(true);

      expect(signals[0]?.aborted).toBe(scenario !== "healthy response");
      expect(warn).toHaveBeenCalledTimes(scenario === "deadline" ? 1 : 0);
    } finally {
      releaseRecall();
      await pending;
      vi.unstubAllGlobals();
      timeout.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
