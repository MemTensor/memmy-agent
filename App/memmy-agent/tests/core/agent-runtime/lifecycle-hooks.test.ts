import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentHook,
  AgentHookContext,
  CompositeAgentHook,
  type SystemPromptBuildContext,
} from "../../../src/core/agent-runtime/hook.js";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { Consolidator } from "../../../src/core/agent-runtime/memory.js";
import { AgentRunResult } from "../../../src/core/agent-runtime/runner.js";
import { Session } from "../../../src/core/session/manager.js";
import { Config } from "../../../src/config/schema.js";
import { LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";

const roots: string[] = [];

function tmpWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-lifecycle-"));
  roots.push(root);
  return root;
}

function provider(responses: string[] = ["ok"]): any {
  const calls: any[] = [];
  const respond = vi.fn(async (args: any) => {
    calls.push(args);
    return new LLMResponse({ content: responses[Math.min(calls.length - 1, responses.length - 1)] });
  });
  return {
    generation: { maxTokens: 128 },
    calls,
    chat: respond,
    chatWithRetry: respond,
    getDefaultModel: () => "test-model",
  };
}

function makeLoop(hooks: AgentHook[], extra: Record<string, any> = {}): AgentLoop {
  const root = tmpWorkspace();
  return new AgentLoop({
    config: new Config({
      contextCompaction: { summaryMode: "text" },
      memmyMemory: { enabled: false },
    }),
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

  override async beforeBuildSystemPrompt(context: AgentHookContext): Promise<void> {
    this.events.push({ name: "beforeBuildSystemPrompt", context });
  }

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
  it("emits beforeBuildSystemPrompt with the resolved Session workspace before every root turn", async () => {
    const hook = new RecordingLifecycleHook();
    const loop = makeLoop([hook]);

    await loop.processDirect("hello", { sessionKey: "cli:prompt" });
    await loop.processDirect("again", { sessionKey: "cli:prompt" });

    const events = hook.events.filter((event) => event.name === "beforeBuildSystemPrompt");
    expect(events).toHaveLength(2);
    expect(events[0].context).toMatchObject({
      sessionKey: "cli:prompt",
      reason: "system_prompt_build",
      spec: { hostProjectId: null, workspace: loop.workspace },
      metadata: { lifecycle: "system_prompt" },
    });
  });

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

  it("runs prompt preparation before token estimation and message construction on both root paths", async () => {
    const events: string[] = [];
    class PromptOrderHook extends AgentHook {
      override async beforeBuildSystemPrompt(ctx: AgentHookContext): Promise<void> {
        events.push(`${ctx.sessionKey}:prepare`);
      }

      override onBuildSystemPrompt(ctx: SystemPromptBuildContext): void {
        events.push(`${ctx.sessionKey}:build`);
      }
    }
    const loop = makeLoop([new PromptOrderHook()], { contextWindowTokens: 1_000 });
    const originalCompact = Consolidator.prototype.maybeConsolidateByTokens;
    vi.spyOn(Consolidator.prototype, "maybeConsolidateByTokens").mockImplementation(async function (
      this: Consolidator,
      session: any,
      options: any,
    ) {
      events.push(`${session.key}:estimate`);
      return originalCompact.call(this, session, options);
    });

    await loop.processDirect("ordinary", { sessionKey: "cli:ordinary-order" });
    await loop.processSystemMessage({
      channel: "system",
      chatId: "cli:system-order",
      senderId: "system",
      content: "system",
      metadata: {},
      media: [],
    } as any, "cli:system-order");

    for (const sessionKey of ["cli:ordinary-order", "cli:system-order"]) {
      const prepare = events.indexOf(`${sessionKey}:prepare`);
      const estimate = events.indexOf(`${sessionKey}:estimate`);
      const build = events.indexOf(`${sessionKey}:build`);
      expect(prepare).toBeGreaterThanOrEqual(0);
      expect(estimate).toBeGreaterThan(prepare);
      expect(build).toBeGreaterThan(estimate);
    }
  });

  it("uses the cache version refreshed by successful token compaction in the final prompt", async () => {
    class VersionedPromptHook extends AgentHook {
      version = "before-compaction";

      override onBuildSystemPrompt(ctx: SystemPromptBuildContext): void {
        ctx.upsertSection({ id: "versioned-cache", content: this.version });
      }

      override async afterCompaction(ctx: AgentHookContext): Promise<void> {
        if (ctx.compaction?.kind === "token" && ctx.compaction.changed === true) {
          this.version = "after-compaction";
        }
      }
    }
    const hook = new VersionedPromptHook();
    const loop = makeLoop([hook], { contextWindowTokens: 1_000 });
    const session = loop.sessions.getOrCreate("cli:versioned-cache");
    session.messages = [
      { role: "user", content: "old user message" },
      { role: "assistant", content: "old assistant message" },
    ];
    loop.sessions.save(session);
    let estimates = 0;
    vi.spyOn(loop.consolidator, "estimateSessionPromptTokens").mockImplementation(() => {
      estimates += 1;
      return estimates === 1 ? [1_200, "test"] : [100, "test"];
    });
    vi.spyOn(loop.consolidator, "pickConsolidationBoundary").mockReturnValue([1, 1]);
    vi.spyOn(loop.consolidator, "archive").mockResolvedValue("summary");

    await loop.processDirect("new user message", { sessionKey: "cli:versioned-cache" });

    const modelCalls = (loop.provider as any).calls as Array<{ messages?: Array<{ content?: unknown }> }>;
    const serialized = JSON.stringify(modelCalls.at(-1));
    expect(serialized).toContain("after-compaction");
    expect(serialized).not.toContain("before-compaction");
  });

  it("refreshes hook-backed prompt state during mid-turn compaction before the follow-up request", async () => {
    const events: string[] = [];
    class VersionedPromptHook extends AgentHook {
      version = "before-mid-turn";

      override onBuildSystemPrompt(ctx: SystemPromptBuildContext): void {
        ctx.upsertSection({ id: "mid-turn-version", content: this.version });
      }

      override async beforeCompaction(): Promise<void> {
        events.push("beforeCompaction");
      }

      override async afterCompaction(ctx: AgentHookContext): Promise<void> {
        events.push("afterCompaction");
        if (ctx.compaction?.changed) this.version = "after-mid-turn";
      }
    }
    const hook = new VersionedPromptHook();
    const calls: any[] = [];
    const p = {
      generation: { maxTokens: 128 },
      getDefaultModel: () => "test-model",
      chatWithRetry: vi.fn(async (args: any) => {
        calls.push(args);
        events.push(`model-${calls.length}`);
        if (calls.length === 1) {
          return new LLMResponse({
            content: "checking",
            toolCalls: [new ToolCallRequest({ id: "goal-1", name: "get_goal", arguments: {} })],
          });
        }
        return new LLMResponse({ content: "done" });
      }),
    };
    const loop = makeLoop([hook], { contextWindowTokens: 10_000, provider: p });
    const session = loop.sessions.getOrCreate("cli:mid-turn-hook");
    session.messages = [
      { role: "user", content: "old user" },
      { role: "assistant", content: "old answer" },
    ];
    loop.sessions.save(session);
    const originalCompaction = loop.consolidator.maybeConsolidateByTokens;
    vi.spyOn(loop.consolidator, "maybeConsolidateByTokens").mockImplementation(async function (
      this: Consolidator,
      currentSession: Session,
      options: any,
    ) {
      if (!options.estimateProjectionTokens) {
        return {
          kind: "token",
          replayMaxMessages: options.replayMaxMessages ?? null,
          changed: false,
          summary: null,
          error: null,
          started: false,
        };
      }
      const liveEstimator = options.estimateProjectionTokens;
      return originalCompaction.call(this, currentSession, {
        ...options,
        estimateProjectionTokens: (candidateSession: Session, projection: any) => {
          liveEstimator(candidateSession, projection);
          return [projection.visibleMessageStart === 0 ? 7_000 : 100, "test"];
        },
      });
    });
    vi.spyOn(loop.consolidator, "archive").mockResolvedValue("mid-turn summary");

    await loop.processDirect("current user", { sessionKey: session.key });

    expect(events).toEqual([
      "model-1",
      "beforeCompaction",
      "afterCompaction",
      "model-2",
    ]);
    const secondRequest = JSON.stringify(calls[1].messages);
    expect(secondRequest).toContain("after-mid-turn");
    expect(secondRequest).not.toContain("before-mid-turn");
  });

  it("keeps CompositeHook order and obeys each hook's reraise policy", async () => {
    const events: string[] = [];
    class NamedHook extends AgentHook {
      constructor(private readonly name: string, reraise = false, private readonly fail = false) {
        super(reraise);
      }

      override async beforeBuildSystemPrompt(): Promise<void> {
        events.push(this.name);
        if (this.fail) throw new Error(`${this.name}-failed`);
      }
    }
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tolerant = new CompositeAgentHook([
      new NamedHook("first"),
      new NamedHook("soft-failure", false, true),
      new NamedHook("third"),
    ]);
    await tolerant.beforeBuildSystemPrompt(new AgentHookContext());
    expect(events).toEqual(["first", "soft-failure", "third"]);
    expect(consoleError).toHaveBeenCalledTimes(1);

    events.length = 0;
    const strict = new CompositeAgentHook([
      new NamedHook("first"),
      new NamedHook("hard-failure", true, true),
      new NamedHook("never"),
    ]);
    await expect(strict.beforeBuildSystemPrompt(new AgentHookContext()))
      .rejects.toThrow("hard-failure-failed");
    expect(events).toEqual(["first", "hard-failure"]);
  });
});
