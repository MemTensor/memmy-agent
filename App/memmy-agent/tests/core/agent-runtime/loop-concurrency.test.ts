import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { InboundMessage, MessageBus } from "../../../src/core/runtime-messages/index.js";
import { Config } from "../../../src/config/schema.js";
import { GOAL_STATE_KEY, readGoalState } from "../../../src/core/session/goal-state.js";

const roots: string[] = [];

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-loop-concurrency-"));
  roots.push(root);
  return root;
}

function makeLoop(fileMemoryEnabled = false): AgentLoop {
  return new AgentLoop({
    bus: new MessageBus(),
    config: new Config({
      fileMemory: { enabled: fileMemoryEnabled },
      memmyMemory: { enabled: false },
    }),
    provider: {
      generation: { maxTokens: 4096 },
      getDefaultModel: () => "test-model",
      chatWithRetry: vi.fn(),
    },
    workspace: tmpRoot(),
    model: "test-model",
  });
}

function runResult() {
  return {
    finalContent: "done",
    content: "done",
    messages: [],
    toolCalls: [],
    toolsUsed: ["message"],
    toolEvents: [],
    usage: {},
    response: { usage: {}, finishReason: "stop" },
    stopReason: "completed",
    finishReason: "stop",
    error: null,
    hadInjections: false,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("AgentLoop concurrent chat turns", () => {
  it("releases the slot after an image error so the next queued turn can run", async () => {
    const loop = makeLoop();
    loop.initializeRuntimeTools = vi.fn(async () => undefined);
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const calls: string[] = [];
    loop.runner.run = vi.fn(async (spec: any) => {
      calls.push(String(spec.initialMessages.at(-1)?.content ?? ""));
      if (calls.length === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
        return {
          ...runResult(),
          finalContent: "image_url is not supported",
          content: "image_url is not supported",
          stopReason: "error",
          finishReason: "error",
          error: "image_url is not supported",
          response: {
            usage: {},
            finishReason: "error",
            errorCategory: "image_input_unsupported",
          },
        } as any;
      }
      return { ...runResult(), finalContent: "second completed", content: "second completed" } as any;
    });

    const running = loop.run();
    await loop.bus.publishInbound(new InboundMessage({
      channel: "telegram",
      chatId: "image-queue",
      senderId: "user",
      content: "first image turn",
    }));
    await firstStarted.promise;
    await loop.bus.publishInbound(new InboundMessage({
      channel: "telegram",
      chatId: "image-queue",
      senderId: "user",
      content: "second text turn",
    }));
    expect(calls).toHaveLength(1);

    releaseFirst.resolve();
    while (calls.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    loop.stop();
    await running;

    expect(calls[0]).toContain("first image turn");
    expect(calls[1]).toContain("second text turn");
  });

  it("keeps A/B/C delivery routes as ordered independent turns", async () => {
    const loop = makeLoop();
    const started: string[] = [];
    let releaseA!: () => void;
    const aGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    loop.initializeRuntimeTools = vi.fn(async () => undefined);
    loop.processMessageInternal = vi.fn(async (message: InboundMessage, _key, options) => {
      started.push(`${message.channel}:${message.chatId}`);
      if (started.length === 1) await aGate;
      expect(options.pendingQueue?.size).toBe(0);
      return null;
    });
    const running = loop.run();
    const canonicalKey = "telegram:123";
    await loop.bus.publishInbound(new InboundMessage({
      channel: "telegram",
      chatId: "123",
      senderId: "user",
      content: "A",
    }));
    while (started.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
    await loop.bus.publishInbound(new InboundMessage({
      channel: "websocket",
      chatId: "ext_projection",
      senderId: "user",
      content: "B",
      sessionKeyOverride: canonicalKey,
    }));
    await loop.bus.publishInbound(new InboundMessage({
      channel: "telegram",
      chatId: "123",
      senderId: "user",
      content: "C",
    }));
    while ((loop.turnSlots.get(canonicalKey)?.length ?? 0) < 3) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    releaseA();
    while (started.length < 3) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(started).toEqual([
      "telegram:123",
      "websocket:ext_projection",
      "telegram:123",
    ]);
    loop.stop();
    await running;
  });

  it("defers new IM input only for the active deletion window", async () => {
    const loop = makeLoop();
    const canonicalKey = "telegram:delete-race";
    const processed: string[] = [];
    let releaseDeletion!: () => void;
    const deletionGate = new Promise<void>((resolve) => {
      releaseDeletion = resolve;
    });
    loop.initializeRuntimeTools = vi.fn(async () => undefined);
    loop.processMessageInternal = vi.fn(async (message: InboundMessage) => {
      processed.push(message.content);
      return null;
    });
    const running = loop.run();
    const deletion = loop.withSessionDeletionBarrier(
      canonicalKey,
      () => deletionGate,
      async () => undefined,
    );
    await loop.bus.publishInbound(new InboundMessage({
      channel: "telegram",
      chatId: "delete-race",
      senderId: "user",
      content: "arrived during delete",
    }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(processed).toEqual([]);

    releaseDeletion();
    await deletion;
    while (!processed.length) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(processed).toEqual(["arrived during delete"]);
    loop.stop();
    await running;
  });

  it("fences Goal writes until a Session deletion barrier fully exits", async () => {
    const loop = makeLoop();
    const sessionKey = "websocket:delete-goal";
    loop.sessions.getOrCreate(sessionKey);
    const goal = await loop.goalRuntime.create({
      sessionKey,
      objective: "delete without stale Goal writes",
      tokenBudget: null,
      route: { channel: "websocket", chatId: "delete-goal" },
      turnId: "turn-before-delete",
    });
    loop.goalRuntime.releaseTurn(sessionKey, "turn-before-delete");
    let releaseDeletion!: () => void;
    const deletionGate = new Promise<void>((resolve) => {
      releaseDeletion = resolve;
    });

    const deletion = loop.withSessionDeletionBarrier(
      sessionKey,
      () => deletionGate,
      async () => {
        loop.sessions.deleteSession(sessionKey);
      },
    );

    expect(loop.goalRuntime.reserveWork(sessionKey, "stale-continuation", "continuation")).toBe(false);
    await expect(loop.goalRuntime.setBudget(sessionKey, goal.goalId, 100))
      .rejects.toMatchObject({ code: "session_deletion_in_progress" });
    releaseDeletion();
    await deletion;

    expect(loop.sessions.get(sessionKey)).toBeNull();
    expect(loop.goalRuntime.get(sessionKey)).toBeNull();
    expect(loop.goalRuntime.hasGoalLease(sessionKey)).toBe(false);
    expect(loop.goalRuntime.hasWorkReservation(sessionKey)).toBe(false);
  });

  it("exposes WebUI-only cron target busy and goal-active checks", () => {
    const loop = makeLoop();
    const key = "websocket:chat-1";

    loop.activeTasks.set(key, [{ done: () => false }]);
    expect(loop.isSessionBusy(key)).toBe(true);
    expect(loop.isCronTargetBlocked("websocket", key)).toBe(true);
    expect(loop.isCronTargetBlocked("slack", "slack:C123")).toBe(false);

    loop.activeTasks.set(key, [{ done: () => true }]);
    expect(loop.isSessionBusy(key)).toBe(false);

    loop.pendingQueues.set(key, {} as any);
    expect(loop.isSessionBusy(key)).toBe(true);
    loop.pendingQueues.delete(key);

    const session = loop.sessions.getOrCreate(key);
    session.metadata.goalState = {
      goalId: "8f59f58a-7295-4c34-8e03-55e7035a5a8d",
      status: "active",
      objective: "finish the goal",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: "2026-08-04T08:00:00.000Z",
      updatedAt: "2026-08-04T08:00:00.000Z",
    };
    expect(loop.isSessionGoalActive(key)).toBe(true);
    expect(loop.isCronTargetBlocked("websocket", key)).toBe(true);
    expect(loop.isCronTargetBlocked("slack", key)).toBe(false);

    session.metadata.goalState = { ...session.metadata.goalState, status: "completed" };
    expect(loop.isCronTargetBlocked("websocket", key)).toBe(false);
  });

  it("uses isolated tool registries so message delivery stays in the originating chat", async () => {
    const loop = makeLoop();
    const specs: any[] = [];
    let releaseBoth: (() => void) | null = null;
    const bothStarted = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });

    loop.runner.run = vi.fn(async (spec: any) => {
      specs.push(spec);
      if (specs.length === 2) releaseBoth?.();
      await bothStarted;
      await spec.tools.get("message").execute({ content: `tool reply for ${spec.sessionKey}` });
      return runResult() as any;
    });

    const first = loop.processMessage(
      new InboundMessage({ channel: "websocket", senderId: "user", chatId: "chat-1", content: "第一个任务" }),
    );
    const second = loop.processMessage(
      new InboundMessage({ channel: "websocket", senderId: "user", chatId: "chat-2", content: "第二个任务" }),
    );

    await Promise.all([first, second]);

    expect(specs).toHaveLength(2);
    expect(new Set(specs.map((spec) => spec.tools)).size).toBe(2);
    const delivered = [await loop.bus.consumeOutbound(), await loop.bus.consumeOutbound()];
    expect(delivered.map((message) => message.chatId).sort()).toEqual(["chat-1", "chat-2"]);
    expect(delivered.map((message) => message.content).sort()).toEqual([
      "tool reply for websocket:chat-1",
      "tool reply for websocket:chat-2",
    ]);
  });

  it("keeps archived image artifact paths out of other session prompts", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const loop = makeLoop(true);
    loop.context.memory.rawArchive(
      [{ role: "tool", content: '{"artifacts":[{"path":"/media/wonton-a.png"}]}' }],
      { sessionKey: "websocket:chat-1" },
    );
    loop.context.memory.rawArchive(
      [{ role: "tool", content: '{"artifacts":[{"path":"/media/city-b.png"}]}' }],
      { sessionKey: "websocket:chat-2" },
    );
    const specs: any[] = [];
    loop.runner.run = vi.fn(async (spec: any) => {
      specs.push(spec);
      return runResult() as any;
    });

    await Promise.all([
      loop.processMessage(new InboundMessage({ channel: "websocket", senderId: "user", chatId: "chat-1", content: "继续馄饨任务" })),
      loop.processMessage(new InboundMessage({ channel: "websocket", senderId: "user", chatId: "chat-2", content: "继续城市任务" })),
    ]);

    const prompts = new Map(specs.map((spec) => [spec.sessionKey, String(spec.initialMessages[0]?.content)]));
    expect(prompts.get("websocket:chat-1")).toContain("/media/wonton-a.png");
    expect(prompts.get("websocket:chat-1")).not.toContain("/media/city-b.png");
    expect(prompts.get("websocket:chat-2")).toContain("/media/city-b.png");
    expect(prompts.get("websocket:chat-2")).not.toContain("/media/wonton-a.png");
  });

  it("keeps concurrent Turn usage and Goal settlement isolated by Session", async () => {
    const loop = makeLoop();
    const keys = ["websocket:usage-a", "websocket:usage-b"] as const;
    for (const [index, key] of keys.entries()) {
      const session = loop.sessions.getOrCreate(key);
      session.metadata[GOAL_STATE_KEY] = {
        goalId: `00000000-0000-4000-8000-00000000000${index + 1}`,
        status: "active",
        objective: `Goal ${index + 1}`,
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: "2026-08-04T08:00:00.000Z",
        updatedAt: "2026-08-04T08:00:00.000Z",
      };
      loop.sessions.save(session);
    }

    let releaseBoth!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const started: string[] = [];
    loop.runner.run = vi.fn(async (spec: any) => {
      started.push(spec.sessionKey);
      if (started.length === 2) releaseBoth();
      await bothStarted;
      const totalTokens = spec.sessionKey === keys[0] ? 11 : 22;
      return {
        ...runResult(),
        usage: { total_tokens: totalTokens, prompt_tokens: totalTokens - 1, completion_tokens: 1 },
        response: { usage: { total_tokens: totalTokens }, finishReason: "stop" },
      } as any;
    });

    await Promise.all([
      loop.processMessage(new InboundMessage({ channel: "websocket", senderId: "user", chatId: "usage-a", content: "Continue A" })),
      loop.processMessage(new InboundMessage({ channel: "websocket", senderId: "user", chatId: "usage-b", content: "Continue B" })),
    ]);

    expect(loop.lastUsageBySession.get(keys[0])).toMatchObject({ total_tokens: 11 });
    expect(loop.lastUsageBySession.get(keys[1])).toMatchObject({ total_tokens: 22 });
    expect(readGoalState(loop.sessions.getOrCreate(keys[0]).metadata)?.tokensUsed).toBe(11);
    expect(readGoalState(loop.sessions.getOrCreate(keys[1]).metadata)?.tokensUsed).toBe(22);
  });

  it("keeps different Provider snapshots, retries, usage, ACKs, and session metadata isolated", async () => {
    const providers = {
      "preset-a": { spec: { name: "provider-a" }, generation: { maxTokens: 256 } },
      "preset-b": { spec: { name: "provider-b" }, generation: { maxTokens: 512 } },
    } as const;
    const selections = Object.fromEntries(Object.entries(providers).map(([presetId, provider]) => [
      presetId,
      {
        preset: presetId,
        presetId,
        provider: provider.spec.name,
        endpointId: "chat",
        protocol: "openai-chat-completions",
        model: `model-${presetId.at(-1)}`,
        source: "byok",
        ownerAccountId: null,
        capability: "agent",
        capabilities: ["agent"],
        snapshot: {
          provider,
          model: `model-${presetId.at(-1)}`,
          contextWindowTokens: 200_000,
          signature: [presetId],
        },
      },
    ])) as Record<string, any>;
    const workspace = fs.realpathSync(tmpRoot());
    const loop = new AgentLoop({
      bus: new MessageBus(),
      config: new Config({ memmyMemory: { enabled: false } }),
      provider: providers["preset-a"],
      workspace,
      modelSelectionResolver: ({ requestedPreset }) => requestedPreset
        ? selections[requestedPreset] ?? null
        : selections["preset-a"],
    });
    const started: string[] = [];
    let releaseBoth!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    loop.runner.run = vi.fn(async (spec: any) => {
      started.push(spec.sessionKey);
      if (started.length === 2) releaseBoth();
      await bothStarted;
      await spec.retryWaitCallback?.(`retry:${spec.provider.spec.name}`);
      const totalTokens = spec.provider.spec.name === "provider-a" ? 11 : 22;
      if (spec.provider.spec.name === "provider-b") {
        return {
          ...runResult(),
          finalContent: "failure:provider-b",
          content: "failure:provider-b",
          stopReason: "error",
          finishReason: "error",
          error: "failure:provider-b",
          usage: { total_tokens: totalTokens, prompt_tokens: totalTokens - 1, completion_tokens: 1 },
          response: {
            usage: { total_tokens: totalTokens },
            finishReason: "error",
            errorCategory: "model_failed",
          },
        } as any;
      }
      return {
        ...runResult(),
        finalContent: `done:${spec.model}`,
        usage: { total_tokens: totalTokens, prompt_tokens: totalTokens - 1, completion_tokens: 1 },
        response: { usage: { total_tokens: totalTokens }, finishReason: "stop" },
      } as any;
    });
    for (const suffix of ["a", "b"]) {
      loop.sessions.reserveWebuiSessionBinding(`websocket:provider-${suffix}`, {
        projectId: null,
        cwd: workspace,
      });
    }

    const turnResults = await Promise.all(["a", "b"].map((suffix) => loop.processMessage(new InboundMessage({
      channel: "websocket",
      senderId: "user",
      chatId: `provider-${suffix}`,
      content: `run ${suffix}`,
      metadata: {
        webui: true,
        webuiProjectId: null,
        webuiWorkspaceCwd: workspace,
        client_request_id: `${suffix === "a" ? "aaaaaaaa" : "bbbbbbbb"}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
        model_preset: `preset-${suffix}`,
      },
    }))));

    expect(new Set((loop.runner.run as any).mock.calls.map(([spec]: any[]) => (
      `${spec.provider.spec.name}:${spec.model}`
    )))).toEqual(new Set(["provider-a:model-a", "provider-b:model-b"]));
    expect(loop.lastUsageBySession.get("websocket:provider-a")).toMatchObject({ total_tokens: 11 });
    expect(loop.lastUsageBySession.get("websocket:provider-b")).toMatchObject({ total_tokens: 22 });
    for (const suffix of ["a", "b"] as const) {
      expect(loop.sessions.get(`websocket:provider-${suffix}`)?.metadata.modelSelection).toMatchObject({
        presetId: `preset-${suffix}`,
        provider: `provider-${suffix}`,
        model: `model-${suffix}`,
      });
    }
    const outbound: any[] = [];
    while (loop.bus.outboundSize) outbound.push(await loop.bus.consumeOutbound());
    for (const suffix of ["a", "b"] as const) {
      expect(outbound).toContainEqual(expect.objectContaining({
        chatId: `provider-${suffix}`,
        metadata: expect.objectContaining({
          webuiMessageAccepted: true,
          modelSelection: expect.objectContaining({ preset_id: `preset-${suffix}` }),
        }),
      }));
      expect(outbound).toContainEqual(expect.objectContaining({
        chatId: `provider-${suffix}`,
        content: `retry:provider-${suffix}`,
        metadata: expect.objectContaining({
          model_selection: expect.objectContaining({ preset_id: `preset-${suffix}` }),
        }),
      }));
    }
    expect(turnResults[0]?.metadata).not.toHaveProperty("modelErrorCategory");
    expect(turnResults[1]).toMatchObject({
      chatId: "provider-b",
      metadata: {
        model_preset: "preset-b",
        modelErrorCategory: "model_failed",
        modelErrorDetail: "failure:provider-b",
        modelErrorContext: {
          presetId: "preset-b",
          source: "byok",
          provider: "provider-b",
          model: "model-b",
          capability: "agent",
        },
      },
    });
    expect(loop.sessions.get("websocket:provider-b")?.messages.filter((message) => message.model_error).at(-1)?.model_error).toEqual({
      category: "model_failed",
      detail: "failure:provider-b",
      presetId: "preset-b",
      source: "byok",
      provider: "provider-b",
      model: "model-b",
      capability: "agent",
    });
  });
});
