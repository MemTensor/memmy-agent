import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop, UNIFIED_SESSION_KEY } from "../../../src/core/agent-runtime/loop.js";
import { AgentRunResult } from "../../../src/core/agent-runtime/runner.js";
import { SESSION_TOOL_RESULT_MAX_CHARS_BY_NAME } from "../../../src/core/agent-runtime/tool-result-budget.js";
import { InboundMessage } from "../../../src/core/runtime-messages/events.js";
import { Config } from "../../../src/config/schema.js";
import { LLMResponse } from "../../../src/providers/base.js";
import { GOAL_STATE_KEY, readGoalState } from "../../../src/core/session/goal-state.js";
import { Session, SessionManager } from "../../../src/core/session/manager.js";
import { GuiTranscriptMirror } from "../../../src/entrypoints/frontend-bridge/gui-transcript-sync.js";

const roots: string[] = [];
const originalDataDir = process.env.MEMMY_AGENT_DATA_DIR;

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-loop-"));
  roots.push(dir);
  return dir;
}

function provider(responses: string[] = ["ok"]): any {
  const calls: any[] = [];
  return {
    generation: { maxTokens: 100 },
    calls,
    chat: vi.fn(async (args: any) => {
      calls.push(args);
      return new LLMResponse({ content: responses[Math.min(calls.length - 1, responses.length - 1)] });
    }),
    getDefaultModel: () => "test-model",
  };
}

function quotaProvider(): any {
  return {
    generation: { maxTokens: 100 },
    chat: vi.fn(async () =>
      new LLMResponse({
        content: "raw provider quota detail",
        finishReason: "error",
        errorCode: "40309",
        errorCategory: "quota_exhausted",
      })),
    getDefaultModel: () => "test-model",
  };
}

function loop(p = provider(), extra: Record<string, any> = {}): AgentLoop {
  const root = workspace();
  return new AgentLoop({
    provider: p,
    workspace: root,
    model: "test-model",
    contextWindowTokens: 4096,
    sessionDir: path.join(root, "sessions"),
    config: new Config({ memmyMemory: { enabled: false } }),
    ...extra,
  });
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(await predicate()).toBe(true);
}

afterEach(() => {
  vi.restoreAllMocks();
  if (originalDataDir === undefined) delete process.env.MEMMY_AGENT_DATA_DIR;
  else process.env.MEMMY_AGENT_DATA_DIR = originalDataDir;
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("AgentLoop direct processing", () => {
  it("expands the default home workspace instead of creating a literal tilde directory", () => {
    const fakeHome = workspace();
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
    const p = provider(["ok"]);
    const agent = new AgentLoop({
      provider: p,
      config: new Config({ agents: { defaults: { workspace: "~/agent-workspace" } } }),
      model: "test-model",
      sessionDir: path.join(workspace(), "sessions"),
    });

    expect(agent.workspace).toBe(path.join(fakeHome, "agent-workspace"));
    expect(agent.workspace).not.toContain(`${path.sep}~${path.sep}`);
  });

  it("processDirect runs the model, returns outbound content, and persists a clean user/assistant turn", async () => {
    const p = provider(["first answer"]);
    const agent = loop(p);

    const outbound = await agent.processDirect("hello", { sessionKey: "cli:test" });

    expect(outbound?.content).toBe("first answer");
    expect(p.chat).toHaveBeenCalledOnce();
    const session = agent.sessions.getOrCreate("cli:test");
    expect(session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(session.messages[0].content).toBe("hello");
    expect(session.messages[0].content).not.toContain("[Runtime Context");
    expect(session.messages[1].content).toBe("first answer");
    expect(session.messages[1].finish_reason).toBe("stop");
    expect(session.messages[1].latency_ms).toBeGreaterThanOrEqual(0);
    const persistedMessages = fs.readFileSync(agent.sessions.pathFor("cli:test"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(persistedMessages.find((message) => message.role === "assistant")).toMatchObject({
      content: "first answer",
      finish_reason: "stop",
    });
  });

  it("passes the structured Turn source into tool request metadata", async () => {
    const agent = loop(provider(["ok"]));
    const source = { kind: "gui", channel: "websocket" } as const;
    const contextSpy = vi.spyOn(agent, "setToolContext");

    await agent.processMessage(new InboundMessage({
      channel: "websocket",
      chatId: "goal-source",
      content: "create a Goal",
      turnSource: source,
    }));

    expect(contextSpy.mock.calls.some((call) => (
      call[3]?.turn_source?.kind === source.kind
      && call[3]?.turn_source?.channel === source.channel
    ))).toBe(true);
  });

  it("keeps a projected CLI Session on its canonical workspace across the whole turn", async () => {
    const root = workspace();
    process.env.MEMMY_AGENT_DATA_DIR = path.join(root, "data");
    const canonicalWorkspace = path.join(root, "canonical");
    const workspaceAlias = path.join(root, "alias");
    fs.mkdirSync(canonicalWorkspace, { recursive: true });
    fs.symlinkSync(canonicalWorkspace, workspaceAlias, "dir");
    const sessions = new SessionManager(path.join(canonicalWorkspace, "sessions"));
    const session = new Session({
      key: "cli:direct",
      metadata: {
        webui: true,
        webuiProjectId: null,
        webuiWorkspaceCwd: fs.realpathSync(canonicalWorkspace),
      },
    });
    sessions.save(session, { fsync: true });
    const p = provider(["projected answer"]);
    const agent = new AgentLoop({
      provider: p,
      workspace: workspaceAlias,
      model: "test-model",
      contextWindowTokens: 4096,
      sessionDir: sessions.root,
      sessionManager: sessions,
      config: new Config({ memmyMemory: { enabled: false } }),
    });
    agent.guiTranscriptMirror = new GuiTranscriptMirror(sessions, canonicalWorkspace);

    const outbound = await agent.processDirect("hello", { sessionKey: "cli:direct" });

    expect(outbound?.content).toBe("projected answer");
    expect(p.chat).toHaveBeenCalledOnce();
  });

  it("treats a GUI cancellation of an independent cli turn as a normal stopped result", async () => {
    const p = {
      generation: { maxTokens: 100 },
      getDefaultModel: () => "test-model",
      chatWithRetry: vi.fn(async (args: Record<string, any>) => (
        new Promise<never>((_resolve, reject) => {
          const onAbort = () => {
            const error = new Error("task cancelled");
            error.name = "AbortError";
            reject(error);
          };
          args.signal?.addEventListener("abort", onAbort, { once: true });
        })
      )),
    };
    const agent = loop(p);
    const turn = agent.processDirect("keep working", { sessionKey: "cli:stoppable" });
    while (!agent.terminalRunControl.read("cli:stoppable")) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await agent.terminalRunControl.requestCancel("cli:stoppable");

    await expect(turn).resolves.toBeNull();
    expect(agent.terminalRunControl.read("cli:stoppable")).toBeNull();
    const session = agent.sessions.reload("cli:stoppable");
    expect(session?.messages.map((message) => message.role)).toEqual(["user"]);
    expect(session?.metadata).not.toHaveProperty(AgentLoop.PENDING_USER_TURN_KEY);
    expect(session?.metadata).not.toHaveProperty(AgentLoop.RUNTIME_CHECKPOINT_KEY);
    expect(agent.restorePendingUserTurn(session!)).toBe(false);
  });

  it("attaches each turn's accumulated usage to its own outbound message", async () => {
    const agent = loop();
    const usages = [
      { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165, cached_tokens: 90 },
      { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 },
    ];
    let calls = 0;
    agent.runner.run = vi.fn(async () =>
      new AgentRunResult({
        finalContent: "done",
        messages: [{ role: "assistant", content: "done" }],
        stopReason: "completed",
        usage: usages[calls++],
      }));

    const first = await agent.processDirect("first", { sessionKey: "cli:usage-a" });
    const second = await agent.processDirect("second", { sessionKey: "cli:usage-b" });

    expect(first?.metadata.usage).toEqual(usages[0]);
    expect(second?.metadata.usage).toEqual({ ...usages[1], cached_tokens: 0 });
    expect(agent.lastUsageBySession.get("cli:usage-a")).toEqual(usages[0]);
    expect(agent.lastUsageBySession.get("cli:usage-b")).toEqual({
      ...usages[1],
      cached_tokens: 0,
    });
  });

  it("publishes a thread session update after early-persisting WebUI user messages", async () => {
    const p = provider(["web answer"]);
    const agent = loop(p);
    agent.sessions.reserveWebuiSessionBinding("websocket:web-chat", {
      projectId: null,
      cwd: fs.realpathSync(agent.workspace),
    });

    const outbound = await agent.processMessage(new InboundMessage({
      channel: "websocket",
      chatId: "web-chat",
      senderId: "user",
      content: "hello from web",
      metadata: { webui: true },
    }));

    expect(outbound?.content).toBe("web answer");
    const update = await agent.bus.nextOutbound();
    expect(update.chatId).toBe("web-chat");
    expect(update.metadata).toMatchObject({
      webui: true,
      sessionUpdated: true,
      sessionUpdateScope: "thread",
    });
    expect(agent.bus.outboundSize).toBe(0);
  });

  it("propagates a structured quota category through the WebUI state path", async () => {
    const agent = loop(quotaProvider());
    agent.sessions.reserveWebuiSessionBinding("websocket:web-quota", {
      projectId: null,
      cwd: fs.realpathSync(agent.workspace),
    });

    const outbound = await agent.processMessage(
      new InboundMessage({
        channel: "websocket",
        chatId: "web-quota",
        senderId: "user",
        content: "hello",
        metadata: { webui: true, webui_language: "zh-CN" },
      }),
    );

    expect(outbound?.content).toBe("当前模型额度已用完");
    expect(outbound?.metadata.modelErrorCategory).toBe("quota_exhausted");
    expect(outbound?.metadata.modelErrorDetail).toBe("raw provider quota detail");
    const persisted = agent.sessions.getOrCreate("websocket:web-quota").messages;
    expect(persisted.at(-1)?.model_error).toEqual({
      category: "quota_exhausted",
      detail: "raw provider quota detail",
      presetId: "default",
      provider: "unknown",
      model: "test-model",
      capability: "agent",
      source: "byok",
    });
  });

  it("propagates a structured quota category through the system-message path", async () => {
    const agent = loop(quotaProvider());

    const outbound = await agent.processMessage(
      new InboundMessage({
        channel: "system",
        chatId: "websocket:system-quota",
        senderId: "system",
        content: "background prompt",
        metadata: { webui_language: "en" },
      }),
    );

    expect(outbound?.channel).toBe("websocket");
    expect(outbound?.content).toBe("This model's quota has been used up.");
    expect(outbound?.metadata.modelErrorCategory).toBe("quota_exhausted");
    expect(outbound?.metadata.modelErrorDetail).toBe("raw provider quota detail");
  });

  it("does not classify quota-like answer text without a structured category", async () => {
    const agent = loop(provider(["Your quota balance is healthy."]));
    agent.sessions.reserveWebuiSessionBinding("websocket:web-normal", {
      projectId: null,
      cwd: fs.realpathSync(agent.workspace),
    });

    const outbound = await agent.processMessage(
      new InboundMessage({
        channel: "websocket",
        chatId: "web-normal",
        senderId: "user",
        content: "status",
        metadata: { webui: true, webui_language: "en" },
      }),
    );

    expect(outbound?.content).toBe("Your quota balance is healthy.");
    expect(outbound?.metadata).not.toHaveProperty("modelErrorCategory");
  });

  it("replays prior history on the next direct turn without duplicating the current user message", async () => {
    const p = provider(["one", "two"]);
    const agent = loop(p);

    await agent.processDirect("first", { sessionKey: "cli:test" });
    await agent.processDirect("second", { sessionKey: "cli:test" });

    const secondCallMessages = p.calls[1].messages;
    const userContents = secondCallMessages.filter((message: any) => message.role === "user").map((message: any) => message.content);
    expect(JSON.stringify(secondCallMessages)).toContain("first");
    expect(JSON.stringify(secondCallMessages)).toContain("one");
    expect(secondCallMessages.every((message: any) => !("finish_reason" in message))).toBe(true);
    expect(userContents.filter((content: string) => content.includes("second"))).toHaveLength(1);
    expect(agent.sessions.getOrCreate("cli:test").messages.map((message) => message.content)).toEqual(["first", "one", "second", "two"]);
  });

  it("keeps explicit cli sessions separate when unified sessions are enabled", async () => {
    const p = provider(["ok"]);
    const agent = loop(p, { unifiedSession: true });

    await agent.processDirect("hello", { sessionKey: "cli:a", chatId: "a" });

    expect(agent.sessionKey({ sessionKey: "cli:a" } as any)).toBe(UNIFIED_SESSION_KEY);
    expect(agent.sessions.getOrCreate("cli:a").messages[0].content).toBe("hello");
    expect(agent.sessions.get(UNIFIED_SESSION_KEY)).toBeNull();
  });

  it("handles slash command shortcuts without calling the model and persists command turns outside LLM history", async () => {
    const p = provider(["should not be used"]);
    const agent = loop(p);

    const outbound = await agent.processDirect("/help", { sessionKey: "cli:test" });

    expect(outbound?.content).toContain("memmy commands");
    expect(p.chat).not.toHaveBeenCalled();
    const session = agent.sessions.getOrCreate("cli:test");
    expect(session.messages).toHaveLength(2);
    expect(session.messages.every((message) => message.commandMessage)).toBe(true);
    expect(session.getHistory({ maxMessages: 10 }).some((message) => String(message.content).includes("/help"))).toBe(false);
  });

  it("creates /goal state directly and returns the control result before continuation output", async () => {
    const p = provider(["working on it"]);
    const agent = loop(p);

    const outbound = await agent.processDirect("/goal migrate the database", { sessionKey: "cli:test" });

    expect(outbound?.content).toContain("Goal created.");
    expect(outbound?.content).toContain("migrate the database");
    const session = agent.sessions.getOrCreate("cli:test");
    expect(readGoalState(session.metadata)).toMatchObject({
      objective: "migrate the database",
      status: "active",
      tokensUsed: 0,
    });
    expect(session.messages[0]).toMatchObject({
      role: "user",
      content: "/goal migrate the database",
      commandMessage: true,
    });
  });

  it("passes active goal state and runtime runner options through ordinary turns", async () => {
    const p = provider(["unused"]);
    const agent = loop(p);
    agent.contextBlockLimit = 1234;
    agent.providerRetryMode = "aggressive";
    agent.toolHintMaxLength = 12;
    const session = agent.sessions.getOrCreate("cli:goal");
    session.metadata[GOAL_STATE_KEY] = {
      goalId: "8cd503f0-dc78-45c6-8978-983a09f694a0",
      status: "active",
      objective: "Finish the TypeScript parity fixes.",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    agent.sessions.save(session);
    let seenSpec: any = null;
    agent.runner.run = vi.fn(async (spec: any) => {
      seenSpec = spec;
      return new AgentRunResult({
        finalContent: "still working",
        messages: [...spec.messages, { role: "assistant", content: "still working" }],
        stopReason: "completed",
      });
    });

    const outbound = await agent.processDirect("continue", { sessionKey: "cli:goal" });

    expect(outbound?.content).toBe("still working");
    expect(JSON.stringify(seenSpec.messages)).not.toContain("Goal (active):");
    expect(seenSpec.contextWindowTokens).toBe(4096);
    expect(seenSpec.contextBlockLimit).toBe(1234);
    expect(seenSpec.providerRetryMode).toBe("aggressive");
    expect(seenSpec.toolResultMaxCharsByName).toEqual(SESSION_TOOL_RESULT_MAX_CHARS_BY_NAME);
    expect(seenSpec.retryWaitCallback).toBeTypeOf("function");
    expect(seenSpec.checkpointCallback).toBeTypeOf("function");
    expect(seenSpec.llmTimeoutS).toBe(0);
    expect(seenSpec.goalActivePredicate).toBeUndefined();
    expect(seenSpec.goalContinueMessage).toBeUndefined();
  });

  it("consumes a TUI Goal Steer in the same Runner Turn and persists its identity", async () => {
    const calls: Array<{ messages: Record<string, any>[] }> = [];
    let notifyFirstCall!: () => void;
    const firstCallStarted = new Promise<void>((resolve) => {
      notifyFirstCall = resolve;
    });
    let releaseFirstCall!: () => void;
    const firstCallGate = new Promise<void>((resolve) => {
      releaseFirstCall = resolve;
    });
    const p = {
      generation: { maxTokens: 100 },
      getDefaultModel: () => "test-model",
      chat: vi.fn(async (args: any) => {
        calls.push({ messages: structuredClone(args.messages) });
        if (calls.length === 1) {
          notifyFirstCall();
          await firstCallGate;
          return new LLMResponse({
            content: "Initial Goal response",
            usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
          });
        }
        return new LLMResponse({
          content: "Goal response after steer",
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        });
      }),
    };
    const agent = loop(p);
    agent.initializeRuntimeTools = vi.fn(async () => undefined);
    vi.spyOn(agent, "scheduleGoalWork").mockImplementation(() => undefined);
    const sessionKey = "websocket:tui-goal-runner";
    const chatId = "tui-goal-runner";
    const activeTurnId = "17171717-1717-4717-8717-171717171717";
    const clientRequestId = "18181818-1818-4818-8818-181818181818";
    agent.sessions.reserveWebuiSessionBinding(sessionKey, {
      projectId: null,
      cwd: fs.realpathSync(agent.workspace),
    });
    const session = agent.sessions.getOrCreate(sessionKey);
    session.metadata.webui = true;
    session.metadata.webuiProjectId = null;
    session.metadata.webuiWorkspaceCwd = fs.realpathSync(agent.workspace);
    agent.sessions.save(session);
    const goal = await agent.goalRuntime.create({
      sessionKey,
      objective: "Complete the TUI Goal steer implementation",
      tokenBudget: 1_000,
      route: {
        channel: "websocket",
        chatId,
        source: { kind: "tui", channel: "websocket" },
      },
      turnId: "goal-create-turn",
    });
    agent.goalRuntime.releaseTurn(sessionKey, "goal-create-turn");
    while (agent.bus.outboundSize) await agent.bus.consumeOutbound();

    const running = agent.run();
    expect(agent.goalRuntime.reserveWork(sessionKey, activeTurnId, "continuation")).toBe(true);
    await agent.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId,
      content: "Continue the active Goal",
      metadata: { webui: true, turn_id: activeTurnId },
      internal: {
        kind: "goal_continuation",
        goalId: goal.goalId,
        goalUpdatedAt: goal.updatedAt,
      },
      sessionKeyOverride: sessionKey,
      turnSource: { kind: "tui", channel: "websocket" },
    }));
    await firstCallStarted;
    await waitUntil(() => (agent.turnSlots.get(sessionKey) as any[])?.[0]?.acceptingSteer === true);

    await agent.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId,
      content: "Adjust the implementation and keep the same Goal Turn",
      metadata: {
        webui: true,
        client_request_id: clientRequestId,
        webui_request_digest: "tui-goal-runner-digest",
      },
      sessionKeyOverride: sessionKey,
      turnAdmission: "steer",
      expectedTurnId: activeTurnId,
      turnSource: { kind: "tui", channel: "websocket" },
    }));
    await waitUntil(() => ((agent.turnSlots.get(sessionKey) as any[])?.[0]?.pendingSteer.size ?? 0) === 1);
    expect(agent.goalRuntime.inbox(sessionKey)).toEqual([]);
    expect(await agent.getQueueSnapshot(sessionKey)).toMatchObject({ revision: 0, items: [] });
    releaseFirstCall();

    await waitUntil(() => calls.length === 2);
    await waitUntil(() => agent.sessions.getOrCreate(sessionKey).messages.some((message) => (
      message.client_request_id === clientRequestId
    )), 5_000);
    await waitUntil(() => !agent.isSessionBusy(sessionKey), 5_000);
    agent.stop();
    await running;

    expect(JSON.stringify(calls[1].messages)).toContain(
      "Adjust the implementation and keep the same Goal Turn",
    );
    expect(JSON.stringify(calls[1].messages)).not.toContain(clientRequestId);
    expect(JSON.stringify(calls[1].messages)).not.toContain("turn_source");
    expect(JSON.stringify(calls[1].messages)).not.toContain("turn_id");
    const persisted = agent.sessions.getOrCreate(sessionKey).messages;
    expect(persisted.find((message) => message.client_request_id === clientRequestId)).toMatchObject({
      role: "user",
      content: "Adjust the implementation and keep the same Goal Turn",
      client_request_id: clientRequestId,
      turn_id: activeTurnId,
      turn_source: { kind: "tui", channel: "websocket" },
    });
    expect(persisted).toContainEqual(expect.objectContaining({
      role: "assistant",
      content: "Goal response after steer",
    }));
    expect(agent.goalRuntime.get(sessionKey)).toMatchObject({
      goalId: goal.goalId,
      objective: goal.objective,
      status: "active",
      tokensUsed: 14,
    });
    expect(agent.goalRuntime.route(sessionKey)).toEqual({
      channel: "websocket",
      chatId,
      source: { kind: "tui", channel: "websocket" },
    });
    expect(agent.goalRuntime.inbox(sessionKey)).toEqual([]);
    expect(await agent.getQueueSnapshot(sessionKey)).toMatchObject({ revision: 0, items: [] });
    const outbound = [];
    while (agent.bus.outboundSize) outbound.push(await agent.bus.consumeOutbound());
    expect(outbound).toContainEqual(expect.objectContaining({
      metadata: expect.objectContaining({
        webuiMessageSteered: true,
        clientRequestId,
        turnId: activeTurnId,
      }),
    }));
    expect(outbound).toContainEqual(expect.objectContaining({
      metadata: expect.objectContaining({
        turnEnd: true,
        turn_id: activeTurnId,
        goalId: goal.goalId,
        goalOutcome: "active",
      }),
    }));
    expect(outbound.some((message) => message.metadata?.webuiMessageQueued)).toBe(false);
  });

  it("extracts document media before building prompt and keeps image media for multimodal content", async () => {
    const p = provider(["read it"]);
    const root = workspace();
    const note = path.join(root, "note.txt");
    fs.writeFileSync(note, "Quarterly revenue is $5M", "utf8");
    const png = path.join(root, "image.png");
    fs.writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]));
    const agent = new AgentLoop({
      provider: p,
      workspace: root,
      model: "gpt-4.1",
      contextWindowTokens: 4096,
      sessionDir: path.join(root, "sessions"),
    });

    await agent.processDirect("summarize", { sessionKey: "cli:test", media: [note, png] });

    const sent = p.calls[0].messages.at(-1).content;
    expect(JSON.stringify(sent)).toContain("Quarterly revenue is $5M");
    expect(JSON.stringify(sent)).toContain("data:image/png;base64");
    const session = agent.sessions.getOrCreate("cli:test");
    expect(session.messages[0].content).toContain("Quarterly revenue is $5M");
    expect(session.messages[0].media).toEqual([png]);
  });

  it("falls back to the empty-response message and truncates oversized tool outputs when saving turns", async () => {
    const p = provider([""]);
    const agent = loop(p, { maxToolResultChars: 20 });

    const outbound = await agent.processDirect("hello", { sessionKey: "cli:test" });

    expect(outbound?.content).toContain("couldn't produce a final answer");

    const session = agent.sessions.getOrCreate("cli:test");
    agent.saveTurn(
      session,
      [
        { role: "system", content: "sys" },
        { role: "tool", tool_call_id: "t1", name: "x", content: "x".repeat(100) },
      ],
      1,
    );
    expect(String(session.messages.at(-1)?.content).length).toBeLessThan(60);
    expect(String(session.messages.at(-1)?.content)).toContain("truncated");
  });

  it("can be constructed from config with the existing facade path", async () => {
    const p = provider(["ok"]);
    const root = workspace();
    const config = new Config({ agents: { defaults: { workspace: root, provider: "custom", model: "test-model" } } });
    const agent = AgentLoop.fromConfig(config, undefined as any, { provider: p, sessionDir: path.join(root, "sessions") });

    const outbound = await agent.processMessage({ channel: "cli", chatId: "direct", sessionKey: "cli:direct", content: "hi", media: [], metadata: {}, senderId: "user" } as any);

    expect(outbound?.content).toBe("ok");
  });
});
