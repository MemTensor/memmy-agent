import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { InboundMessage, MessageBus } from "../../../src/core/runtime-messages/index.js";
import { Config } from "../../../src/config/schema.js";

const roots: string[] = [];

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-loop-concurrency-"));
  roots.push(root);
  return root;
}

function makeLoop(): AgentLoop {
  return new AgentLoop({
    bus: new MessageBus(),
    config: new Config({ memmyMemory: { enabled: false } }),
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
    session.metadata.goalState = { status: "active", objective: "finish the goal" };
    expect(loop.isSessionGoalActive(key)).toBe(true);
    expect(loop.isCronTargetBlocked("websocket", key)).toBe(true);
    expect(loop.isCronTargetBlocked("slack", key)).toBe(false);

    session.metadata.goalState = { status: "complete" };
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
    const loop = makeLoop();
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
});
