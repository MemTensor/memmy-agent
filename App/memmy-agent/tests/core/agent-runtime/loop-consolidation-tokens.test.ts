import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { MessageBus } from "../../../src/core/runtime-messages/index.js";
import { Config } from "../../../src/config/schema.js";
import { LLMResponse } from "../../../src/providers/base.js";

const roots: string[] = [];

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-loop-consolidation-"));
  roots.push(root);
  return root;
}

function makeLoop({ estimatedTokens, contextWindowTokens }: { estimatedTokens: number; contextWindowTokens: number }): AgentLoop {
  const response = new LLMResponse({ content: "ok", toolCalls: [], finishReason: "stop" });
  const provider = {
    generation: { maxTokens: 0, temperature: 0.7 },
    getDefaultModel: vi.fn(() => "test-model"),
    estimatePromptTokens: vi.fn((): [number, string] => [estimatedTokens, "test-counter"]),
    chatWithRetry: vi.fn(async () => response),
    chatStreamWithRetry: vi.fn(async () => response),
  };
  const loop = new AgentLoop({
    bus: new MessageBus(),
    config: new Config({ contextCompaction: { summaryMode: "text" } }),
    provider,
    workspace: tmpRoot(),
    model: "test-model",
    contextWindowTokens,
  });
  loop.tools.getDefinitions = vi.fn(() => []);
  loop.consolidator.safetyBuffer = 0;
  return loop;
}

function addMessages(loop: AgentLoop, key: string, contents: string[]): any {
  const session = loop.sessions.getOrCreate(key);
  session.messages = contents.map((content, idx) => ({
    role: idx % 2 === 0 ? "user" : "assistant",
    content,
    timestamp: `2026-01-01T00:00:0${idx}`,
  }));
  loop.sessions.save(session);
  return session;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("AgentLoop replay token budget", () => {
  it("reserves completion tokens and a safety margin", () => {
    const loop = new AgentLoop({
      config: new Config({ contextCompaction: { summaryMode: "text" } }),
      provider: { generation: { maxTokens: 1000 }, getDefaultModel: () => "m" },
      contextWindowTokens: 10_000,
      workspace: "/tmp/memmy-loop-budget",
    });

    expect(loop.replayTokenBudget()).toBe(10_000 - 1000 - 1024);
  });

  it("does not consolidate when the prompt is below the token threshold", async () => {
    const loop = makeLoop({ estimatedTokens: 100, contextWindowTokens: 200 });
    loop.consolidator.archive = vi.fn(async () => "summary");

    await loop.processDirect("hello", { sessionKey: "cli:test" });

    expect(loop.consolidator.archive).not.toHaveBeenCalled();
  });

  it("triggers consolidation when the prompt is above the token threshold", async () => {
    const loop = makeLoop({ estimatedTokens: 1000, contextWindowTokens: 200 });
    loop.consolidator.archive = vi.fn(async () => "summary");
    addMessages(loop, "cli:test", ["u1", "a1", "u2"]);

    await loop.processDirect("hello", { sessionKey: "cli:test" });

    expect(loop.consolidator.archive).toHaveBeenCalled();
  });

  it("archives through the next user boundary when over the token threshold", async () => {
    const loop = makeLoop({ estimatedTokens: 1000, contextWindowTokens: 200 });
    loop.consolidator.archive = vi.fn(async () => "summary");
    const session = addMessages(loop, "cli:test", ["u1", "a1", "u2", "a2", "u3"]);

    await loop.consolidator.maybeConsolidateByTokens(session);

    const archivedChunk = vi.mocked(loop.consolidator.archive).mock.calls[0][0];
    expect(archivedChunk.map((message: any) => message.content)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(session.lastConsolidated).toBe(4);
  });

  it("continues token consolidation until the target budget is met", async () => {
    const loop = makeLoop({ estimatedTokens: 0, contextWindowTokens: 200 });
    loop.consolidator.archive = vi.fn(async () => "summary");
    const session = addMessages(loop, "cli:test", ["u1", "a1", "u2", "a2", "u3", "a3", "u4"]);
    const estimates = [500, 300, 80];
    loop.consolidator.estimateSessionPromptTokens = vi.fn((): [number, string] => [estimates.shift() ?? 80, "test"]);
    loop.consolidator.pickConsolidationBoundary = vi.fn((freshSession: any): [number, number] | null => {
      const last = freshSession.lastConsolidated ?? 0;
      return last >= 4 ? null : [last + 2, 100];
    });

    await loop.consolidator.maybeConsolidateByTokens(session);

    expect(loop.consolidator.archive).toHaveBeenCalledTimes(2);
    expect(session.lastConsolidated).toBe(4);
  });

  it("continues below the trigger threshold until the half-budget target is met", async () => {
    const loop = makeLoop({ estimatedTokens: 0, contextWindowTokens: 200 });
    loop.consolidator.archive = vi.fn(async () => "summary");
    const session = addMessages(loop, "cli:test", ["u1", "a1", "u2", "a2", "u3", "a3", "u4"]);
    const estimates = [500, 150, 80];
    loop.consolidator.estimateSessionPromptTokens = vi.fn((): [number, string] => [estimates.shift() ?? 80, "test"]);
    loop.consolidator.pickConsolidationBoundary = vi.fn((freshSession: any): [number, number] | null => {
      const last = freshSession.lastConsolidated ?? 0;
      return last >= 4 ? null : [last + 2, 100];
    });

    await loop.consolidator.maybeConsolidateByTokens(session);

    expect(loop.consolidator.archive).toHaveBeenCalledTimes(2);
    expect(session.lastConsolidated).toBe(4);
  });

  it("persists consolidation summaries for the next prepared session", async () => {
    const loop = makeLoop({ estimatedTokens: 0, contextWindowTokens: 200 });
    loop.consolidator.archive = vi.fn(async () => "User discussed project status.");
    const session = addMessages(loop, "cli:test", ["u1", "a1", "u2"]);
    const estimates = [500, 80];
    loop.consolidator.estimateSessionPromptTokens = vi.fn((): [number, string] => [estimates.shift() ?? 80, "test"]);

    await loop.consolidator.maybeConsolidateByTokens(session);

    const reloaded = loop.sessions.getOrCreate("cli:test");
    expect(reloaded.metadata.lastSummary.text).toBe("User discussed project status.");
    const [, pending] = loop.autoCompact.prepareSession(reloaded, "cli:test");
    expect(pending).toContain("User discussed project status.");
    expect(reloaded.metadata).toHaveProperty("lastSummary");
  });

  it("runs preflight consolidation with the prepared session", async () => {
    const loop = makeLoop({ estimatedTokens: 100, contextWindowTokens: 200 });
    const session = loop.sessions.getOrCreate("cli:test");
    loop.autoCompact.prepareSession = vi.fn(() => [session, "Previous conversation summary: earlier context"] as [typeof session, string]);
    loop.consolidator.maybeConsolidateByTokens = vi.fn(async () => ({
      kind: "token" as const,
      replayMaxMessages: loop.maxMessages,
      changed: false,
      summary: null,
      error: null,
      started: false,
    }));
    loop.scheduleBackground = vi.fn();

    await loop.processDirect("hello", { sessionKey: "cli:test" });

    expect(loop.consolidator.maybeConsolidateByTokens).toHaveBeenCalledWith(session, {
      replayMaxMessages: loop.maxMessages,
    });
  });

  it("runs preflight consolidation before the LLM call", async () => {
    const order: string[] = [];
    const loop = makeLoop({ estimatedTokens: 0, contextWindowTokens: 200 });
    loop.consolidator.archive = vi.fn(async () => {
      order.push("consolidate");
      return "summary";
    });
    const session = addMessages(loop, "cli:test", ["u1", "a1", "u2"]);
    const estimates = [1000, 80];
    loop.consolidator.estimateSessionPromptTokens = vi.fn((): [number, string] => [estimates.shift() ?? 80, "test"]);
    (loop.provider as any).chatWithRetry = vi.fn(async () => {
      order.push("llm");
      return new LLMResponse({ content: "ok", toolCalls: [], finishReason: "stop" });
    });
    (loop.provider as any).chatWithRetry = (loop.provider as any).chatWithRetry;
    loop.scheduleBackground = vi.fn();

    await loop.processDirect("hello", { sessionKey: session.key });

    expect(order).toContain("consolidate");
    expect(order).toContain("llm");
    expect(order.indexOf("consolidate")).toBeLessThan(order.indexOf("llm"));
  });
});
