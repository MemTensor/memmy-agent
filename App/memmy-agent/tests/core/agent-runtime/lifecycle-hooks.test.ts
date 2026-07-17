import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHook, AgentHookContext } from "../../../src/core/agent-runtime/hook.js";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { AgentRunResult } from "../../../src/core/agent-runtime/runner.js";
import { Config } from "../../../src/config/schema.js";
import { LLMResponse } from "../../../src/providers/base.js";

const roots: string[] = [];

function tmpWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-lifecycle-"));
  roots.push(root);
  return root;
}

function provider(responses: string[] = ["ok"]): any {
  const calls: any[] = [];
  return {
    generation: { maxTokens: 128 },
    calls,
    chat: vi.fn(async (args: any) => {
      calls.push(args);
      return new LLMResponse({ content: responses[Math.min(calls.length - 1, responses.length - 1)] });
    }),
    chatWithRetry: vi.fn(async () => new LLMResponse({ content: "summary" })),
    getDefaultModel: () => "test-model",
  };
}

function makeLoop(hooks: AgentHook[], extra: Record<string, any> = {}): AgentLoop {
  const root = tmpWorkspace();
  return new AgentLoop({
    config: new Config({ contextCompaction: { summaryMode: "text" } }),
    provider: provider(),
    workspace: root,
    model: "test-model",
    contextWindowTokens: 0,
    sessionDir: path.join(root, "sessions"),
    hooks,
    ...extra,
  });
}

class RecordingLifecycleHook extends AgentHook {
  events: Array<{ name: string; context: AgentHookContext }> = [];

  override async sessionStart(context: AgentHookContext): Promise<void> {
    this.events.push({ name: "sessionStart", context });
  }

  override async sessionEnd(context: AgentHookContext): Promise<void> {
    this.events.push({ name: "sessionEnd", context });
  }

  override async beforeCompaction(context: AgentHookContext): Promise<void> {
    this.events.push({ name: "beforeCompaction", context });
  }

  override async afterCompaction(context: AgentHookContext): Promise<void> {
    this.events.push({ name: "afterCompaction", context });
  }

  override async subagentStart(context: AgentHookContext): Promise<void> {
    this.events.push({ name: "subagentStart", context });
  }

  override async subagentStop(context: AgentHookContext): Promise<void> {
    this.events.push({ name: "subagentStop", context });
  }
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("lifecycle hooks", () => {
  it("emits sessionStart once for a newly created session", async () => {
    const hook = new RecordingLifecycleHook();
    const loop = makeLoop([hook]);

    await loop.processDirect("hello", { sessionKey: "cli:lifecycle" });
    await loop.processDirect("again", { sessionKey: "cli:lifecycle" });

    const starts = hook.events.filter((event) => event.name === "sessionStart");
    expect(starts).toHaveLength(1);
    expect(starts[0].context.sessionKey).toBe("cli:lifecycle");
    expect(starts[0].context.reason).toBe("created");
    expect(starts[0].context.session?.key).toBe("cli:lifecycle");
  });

  it("emits sessionEnd when /new resets a session", async () => {
    const hook = new RecordingLifecycleHook();
    const loop = makeLoop([hook]);

    await loop.processDirect("hello", { sessionKey: "cli:reset" });
    await loop.processDirect("/new", { sessionKey: "cli:reset" });

    const ends = hook.events.filter((event) => event.name === "sessionEnd");
    expect(ends).toHaveLength(1);
    expect(ends[0].context.sessionKey).toBe("cli:reset");
    expect(ends[0].context.reason).toBe("reset");
  });

  it("emits beforeCompaction and afterCompaction around token-budget compaction", async () => {
    const hook = new RecordingLifecycleHook();
    const loop = makeLoop([hook], { contextWindowTokens: 1000 });
    loop.consolidator.safetyBuffer = 0;
    loop.consolidator.maxCompletionTokens = 100;
    const session = loop.sessions.getOrCreate("cli:compact");
    session.messages = [
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
      { role: "user", content: "third" },
    ];
    const estimate = vi
      .spyOn(loop.consolidator, "estimateSessionPromptTokens")
      .mockReturnValueOnce([1200, "test"])
      .mockReturnValueOnce([100, "test"]);
    const boundary = vi.spyOn(loop.consolidator, "pickConsolidationBoundary").mockReturnValue([1, 1]);
    const archive = vi.spyOn(loop.consolidator, "archive").mockResolvedValue("summary");

    await loop.consolidator.maybeConsolidateByTokens(session);

    expect(estimate).toHaveBeenCalled();
    expect(boundary).toHaveBeenCalled();
    expect(archive).toHaveBeenCalledWith([{ role: "user", content: "first" }], { sessionKey: "cli:compact" });
    const compactEvents = hook.events.filter((event) => event.name.includes("Compaction"));
    expect(compactEvents.map((event) => event.name)).toEqual(["beforeCompaction", "afterCompaction"]);
    expect(compactEvents[0].context.sessionKey).toBe("cli:compact");
    expect(compactEvents[0].context.compaction?.kind).toBe("token");
    expect(compactEvents[1].context.compaction).toMatchObject({ kind: "token", changed: true, summary: "summary", error: null });
  });

  it("emits beforeCompaction and afterCompaction around idle compaction", async () => {
    const hook = new RecordingLifecycleHook();
    const loop = makeLoop([hook]);
    const session = loop.sessions.getOrCreate("cli:idle");
    session.messages = [
      { role: "user", content: "old" },
      { role: "assistant", content: "middle" },
      { role: "user", content: "recent" },
    ];
    loop.sessions.save(session);
    const archive = vi.spyOn(loop.consolidator, "archive").mockResolvedValue("idle summary");

    await loop.consolidator.compactIdleSession("cli:idle", 1);

    expect(archive).toHaveBeenCalled();
    const compactEvents = hook.events.filter((event) => event.name.includes("Compaction"));
    expect(compactEvents.map((event) => event.name)).toEqual(["beforeCompaction", "afterCompaction"]);
    expect(compactEvents[0].context.compaction).toMatchObject({ kind: "idle", maxSuffix: 1 });
    expect(compactEvents[1].context.compaction).toMatchObject({ kind: "idle", changed: true, summary: "idle summary", error: null });
  });

  it("emits subagentStart and subagentStop for spawned subagents", async () => {
    const hook = new RecordingLifecycleHook();
    const loop = makeLoop([hook]);
    loop.subagents.buildTools = vi.fn(() => ({}) as any);
    loop.subagents.announceResult = vi.fn(async () => undefined) as any;
    loop.subagents.runner.run = vi.fn(async () => new AgentRunResult({ finalContent: "done", messages: [], stopReason: "completed" }));

    await loop.subagents.spawn("do subtask", "Subtask", "cli", "direct", "cli:parent");
    await tick();

    const subagentEvents = hook.events.filter((event) => event.name.startsWith("subagent"));
    expect(subagentEvents.map((event) => event.name)).toEqual(["subagentStart", "subagentStop"]);
    expect(subagentEvents[0].context.sessionKey).toBe("cli:parent");
    expect(subagentEvents[0].context.subagent).toMatchObject({ label: "Subtask", task: "do subtask", reason: "spawn" });
    expect(subagentEvents[1].context.subagent).toMatchObject({
      label: "Subtask",
      task: "do subtask",
      reason: "completed",
      finalStatus: "ok",
      result: "done",
    });
  });
});
