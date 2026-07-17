import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../../../src/core/agent-runtime/loop.js";
import { SubagentManager, SubagentStatus } from "../../../../src/core/agent-runtime/subagent.js";
import { SpawnTool } from "../../../../src/core/agent-runtime/tools/spawn.js";
import { AsyncQueue, InboundMessage, MessageBus } from "../../../../src/core/runtime-messages/index.js";
import { AgentDefaults, ToolsConfig } from "../../../../src/config/schema.js";
import { Session } from "../../../../src/core/session/manager.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-subagent-tools-"));
  roots.push(root);
  return root;
}

function provider() {
  return { getDefaultModel: () => "test-model" };
}

function result() {
  return { stopReason: "done", finalContent: "done", error: null, toolEvents: [] };
}

function loopResult() {
  return { ...result(), messages: [], usage: {}, hadInjections: false, toolsUsed: [] };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("subagent tools", () => {
  it("forwards allowed env keys to the subagent exec tool", async () => {
    const manager = new SubagentManager({
      provider: provider() as any,
      workspace: tempRoot(),
      bus: new MessageBus(),
      toolsConfig: new ToolsConfig({ exec: { allowedEnvKeys: ["GOPATH", "JAVA_HOME"] } }),
    });
    manager.announceResult = async () => undefined;
    let ran = false;
    manager.runner.run = async (spec: any) => {
      ran = true;
      expect(spec.tools.get("exec")?.allowedEnvKeys).toEqual(["GOPATH", "JAVA_HOME"]);
      return result() as any;
    };

    await manager.runSubagent("sub-1", "do task", "label", { channel: "test", chatId: "c1" }, new SubagentStatus({ taskId: "sub-1", label: "label", taskDescription: "do task" }));

    expect(ran).toBe(true);
  });

  it("uses the configured max iteration limit", async () => {
    const manager = new SubagentManager({
      provider: provider() as any,
      workspace: tempRoot(),
      bus: new MessageBus(),
      maxIterations: 37,
    });
    manager.announceResult = async () => undefined;
    let ran = false;
    manager.runner.run = async (spec: any) => {
      ran = true;
      expect(spec.maxIterations).toBe(37);
      return result() as any;
    };

    await manager.runSubagent("sub-1", "do task", "label", { channel: "test", chatId: "c1" }, new SubagentStatus({ taskId: "sub-1", label: "label", taskDescription: "do task" }));

    expect(ran).toBe(true);
  });

  it("forwards spawn temperature to the run spec", async () => {
    const manager = new SubagentManager({ provider: provider() as any, workspace: tempRoot(), bus: new MessageBus() });
    manager.announceResult = async () => undefined;
    let seen: number | null = null;
    manager.runner.run = async (spec: any) => {
      seen = spec.temperature;
      return result() as any;
    };

    await manager.spawn({ task: "do task", temperature: 0.9 });
    await Promise.allSettled([...manager.runningTasks.values()]);

    expect(seen).toBe(0.9);
  });

  it("passes origin context into the subagent manager", async () => {
    const calls: any[] = [];
    const tool = new SpawnTool({ manager: { getRunningCount: () => 0, maxConcurrentSubagents: 2, spawn: async (args: any) => { calls.push(args); return "started"; } } });
    tool.setContext({ channel: "telegram", chatId: "chat-1", sessionKey: "s1", messageId: "m1" });

    expect(await tool.execute({ task: "do work", label: "work", temperature: 0.2 })).toBe("started");
    expect(calls[0]).toMatchObject({ originChannel: "telegram", originChatId: "chat-1", sessionKey: "s1", originMessageId: "m1" });
  });

  it("rejects spawn when the concurrency limit is reached", async () => {
    const tool = new SpawnTool({ manager: { getRunningCount: () => 1, maxConcurrentSubagents: 1, spawn: async () => "started" } });

    const out = await tool.execute({ task: "second task" });

    expect(out).toContain("Cannot spawn subagent");
    expect(out).toContain("concurrency limit reached");
    expect(out).toContain("Wait for a running subagent to complete");
  });

  it("returns an explicit error when no subagent manager is available", async () => {
    const tool = new SpawnTool();

    const out = await tool.execute({ task: "do work" });

    expect(out).toContain("Error: subagent manager is unavailable");
    expect(out).not.toContain("queued");
  });

  it("returns an explicit error when the manager cannot spawn", async () => {
    const tool = new SpawnTool({ manager: { getRunningCount: () => 0, maxConcurrentSubagents: 2 } });

    const out = await tool.execute({ task: "do work" });

    expect(out).toContain("Error: subagent manager is unavailable");
    expect(out).not.toContain("queued");
  });

  it("uses AgentDefaults for default max concurrency", () => {
    const manager = new SubagentManager({ provider: provider() as any, workspace: tempRoot(), bus: new MessageBus() });

    expect(manager.maxConcurrentSubagents).toBe(new AgentDefaults().maxConcurrentSubagents);
  });

  it("uses AgentDefaults for default max iterations", () => {
    const manager = new SubagentManager({ provider: provider() as any, workspace: tempRoot(), bus: new MessageBus() });

    expect(manager.maxIterations).toBe(new AgentDefaults().maxToolIterations);
  });

  it("passes AgentLoop max iterations to subagents at construction", () => {
    const loop = new AgentLoop({
      bus: new MessageBus(),
      provider: provider(),
      workspace: tempRoot(),
      model: "test-model",
      maxIterations: 42,
    });

    expect(loop.subagents.maxIterations).toBe(42);
  });

  it("syncs updated AgentLoop max iterations before runner execution", async () => {
    const loop = new AgentLoop({
      bus: new MessageBus(),
      provider: provider(),
      workspace: tempRoot(),
      model: "test-model",
      maxIterations: 42,
    });
    loop.tools.getDefinitions = vi.fn(() => []);
    loop.runner.run = vi.fn(async (spec: any) => {
      expect(spec.maxIterations).toBe(55);
      expect(loop.subagents.maxIterations).toBe(55);
      return loopResult() as any;
    });
    loop.maxIterations = loop.maxIterations = 55;

    await loop.runAgentLoop([]);

    expect(loop.runner.run).toHaveBeenCalledTimes(1);
  });

  it("blocks pending-message drain while subagents are still running for the session", async () => {
    const loop = new AgentLoop({ bus: new MessageBus(), provider: provider(), workspace: tempRoot(), model: "test-model" });
    const pendingQueue = new AsyncQueue<InboundMessage>();
    const session = new Session({ key: "test:drain-block" });
    let injectionCallback: any = null;
    loop.runner.run = vi.fn(async (spec: any) => {
      injectionCallback = spec.injectionCallback;
      return loopResult() as any;
    });
    (loop.subagents as any).sessionTasks.set(session.key, new Set(["sub-drain-1"]));
    (loop.subagents as any).runningTasks.set("sub-drain-1", new Promise<void>(() => undefined));

    await loop.runAgentLoop([{ role: "user", content: "test" }], {
      session,
      channel: "test",
      chatId: "c1",
      pendingQueue,
    });
    const drainTask = injectionCallback();
    let settled = false;
    drainTask.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(settled).toBe(false);

    pendingQueue.put(new InboundMessage({
      senderId: "subagent",
      channel: "test",
      chatId: "c1",
      content: "Sub-agent result",
      media: [],
      metadata: {},
    }));
    const results = await drainTask;

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].role).toBe("user");
    expect(String(results[0].content)).toContain("Sub-agent result");
    (loop.subagents as any).runningTasks.clear();
    (loop.subagents as any).sessionTasks.clear();
  });

  it("does not block pending-message drain when no subagents are running", async () => {
    const loop = new AgentLoop({ bus: new MessageBus(), provider: provider(), workspace: tempRoot(), model: "test-model" });
    const pendingQueue = new AsyncQueue<InboundMessage>();
    let injectionCallback: any = null;
    loop.runner.run = vi.fn(async (spec: any) => {
      injectionCallback = spec.injectionCallback;
      return loopResult() as any;
    });

    await loop.runAgentLoop([{ role: "user", content: "test" }], {
      channel: "test",
      chatId: "c1",
      pendingQueue,
    });

    await expect(injectionCallback()).resolves.toEqual([]);
  });

  it("returns an empty injection list after pending-message drain timeout", async () => {
    const loop = new AgentLoop({ bus: new MessageBus(), provider: provider(), workspace: tempRoot(), model: "test-model" });
    loop.subagentPendingWaitMs = 20;
    const pendingQueue = new AsyncQueue<InboundMessage>();
    const session = new Session({ key: "test:drain-timeout" });
    let injectionCallback: any = null;
    loop.runner.run = vi.fn(async (spec: any) => {
      injectionCallback = spec.injectionCallback;
      return loopResult() as any;
    });
    (loop.subagents as any).sessionTasks.set(session.key, new Set(["sub-timeout-1"]));
    (loop.subagents as any).runningTasks.set("sub-timeout-1", new Promise<void>(() => undefined));

    await loop.runAgentLoop([{ role: "user", content: "test" }], {
      session,
      channel: "test",
      chatId: "c1",
      pendingQueue,
    });

    await expect(injectionCallback()).resolves.toEqual([]);
    (loop.subagents as any).runningTasks.clear();
    (loop.subagents as any).sessionTasks.clear();
  });
});
