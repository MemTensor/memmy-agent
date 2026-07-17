import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { AgentRunResult } from "../../../src/core/agent-runtime/runner.js";
import { SubagentManager, SubagentStatus } from "../../../src/core/agent-runtime/subagent.js";
import { cmdStop } from "../../../src/command/builtin.js";
import { CommandContext } from "../../../src/command/router.js";
import { InboundMessage } from "../../../src/core/runtime-messages/events.js";
import { MessageBus } from "../../../src/core/runtime-messages/queue.js";
import { Config } from "../../../src/config/schema.js";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeLoop(): AgentLoop {
  return new AgentLoop({
    provider: { generation: { maxTokens: 4096 }, getDefaultModel: () => "test-model" },
    workspace: tmpDir("memmy-task-cancel-"),
  });
}

function cancelableTask(): Promise<void> & { cancel: () => boolean; done: () => boolean } {
  let settled = false;
  let rejectTask!: (error: Error) => void;
  const task = new Promise<void>((resolve, reject) => {
    rejectTask = reject;
  }) as Promise<void> & { cancel: () => boolean; done: () => boolean };
  task.cancel = vi.fn(() => {
    settled = true;
    rejectTask(new Error("cancelled"));
    return true;
  });
  task.done = () => settled;
  task.catch(() => undefined);
  return task;
}

function cancelableTaskWithSignal(): Promise<void> & { cancel: () => boolean; done: () => boolean; signal: AbortSignal } {
  const controller = new AbortController();
  let settled = false;
  let rejectTask!: (error: Error) => void;
  const task = new Promise<void>((resolve, reject) => {
    rejectTask = reject;
  }) as Promise<void> & { cancel: () => boolean; done: () => boolean; signal: AbortSignal };
  task.signal = controller.signal;
  task.cancel = vi.fn(() => {
    if (settled) return false;
    settled = true;
    controller.abort();
    rejectTask(new Error("cancelled"));
    return true;
  });
  task.done = () => settled;
  task.catch(() => undefined);
  return task;
}

async function withTimeout<T>(promise: Promise<T>, ms = 1000): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((resolve, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

describe("task cancellation", () => {
  it("reports no active task for /stop when nothing is running", async () => {
    const loop = makeLoop();
    const msg = new InboundMessage({ channel: "test", senderId: "u1", chatId: "c1", content: "/stop" });
    const ctx = new CommandContext({ msg, session: null, key: msg.sessionKey, raw: "/stop", loop });

    const out = await cmdStop(ctx);

    expect(out.content).toContain("No active task");
  });

  it("cancels active tasks for the current session", async () => {
    const loop = makeLoop();
    const task = cancelableTask();
    loop.activeTasks.set("test:c1", [task]);

    const msg = new InboundMessage({ channel: "test", senderId: "u1", chatId: "c1", content: "/stop" });
    const out = await cmdStop(new CommandContext({ msg, session: null, key: msg.sessionKey, raw: "/stop", loop }));

    expect(task.cancel).toHaveBeenCalledTimes(1);
    expect(loop.activeTasks.has("test:c1")).toBe(false);
    expect(out.content.toLowerCase()).toContain("stopped");
  });

  it("reports the number of stopped tasks for multiple active tasks", async () => {
    const loop = makeLoop();
    const task1 = cancelableTask();
    const task2 = cancelableTask();
    loop.activeTasks.set("test:c1", [task1, task2]);
    loop.subagents.cancelBySession = vi.fn(async () => 0);

    const msg = new InboundMessage({ channel: "test", senderId: "u1", chatId: "c1", content: "/stop" });
    const out = await cmdStop(new CommandContext({ msg, session: null, key: msg.sessionKey, raw: "/stop", loop }));

    expect(task1.cancel).toHaveBeenCalledTimes(1);
    expect(task2.cancel).toHaveBeenCalledTimes(1);
    expect(out.content).toContain("2 task");
  });

  it("counts multiple active tasks and subagents", async () => {
    const loop = makeLoop();
    const task1 = cancelableTask();
    const task2 = cancelableTask();
    loop.activeTasks.set("test:c1", [task1, task2]);
    loop.subagents.cancelBySession = vi.fn(async () => 1);

    const total = await loop.cancelActiveTasks("test:c1");

    expect(total).toBe(3);
    expect(task1.cancel).toHaveBeenCalledTimes(1);
    expect(task2.cancel).toHaveBeenCalledTimes(1);
    expect(loop.subagents.cancelBySession).toHaveBeenCalledWith("test:c1");
  });

  it("excludes the current dispatch task while cancelling the rest", async () => {
    const loop = makeLoop();
    const currentTask = cancelableTaskWithSignal();
    const otherTask = cancelableTaskWithSignal();
    loop.activeTasks.set("test:c1", [currentTask, otherTask]);
    loop.subagents.cancelBySession = vi.fn(async () => 1);

    const total = await withTimeout(loop.cancelActiveTasks("test:c1", { excludeSignal: currentTask.signal }), 100);

    expect(total).toBe(2);
    expect(currentTask.cancel).not.toHaveBeenCalled();
    expect(otherTask.cancel).toHaveBeenCalledTimes(1);
    expect(loop.activeTasks.get("test:c1")).toEqual([currentTask]);
    expect(loop.subagents.cancelBySession).toHaveBeenCalledWith("test:c1");
  });

  it("cancels and cleans up subagent task bookkeeping by session", async () => {
    const manager = new SubagentManager({ bus: new MessageBus(), maxConcurrent: 2 });
    const task = cancelableTask();
    const status = new SubagentStatus({ taskId: "sub-1", label: "label", taskDescription: "do task" });
    manager.runningTasks.set("sub-1", task);
    manager.taskStatuses.set("sub-1", status);
    manager.tasks.set("sub-1", status);
    manager.sessionTasks.set("test:c1", new Set(["sub-1"]));

    const count = await manager.cancelBySession("test:c1");

    expect(count).toBe(1);
    expect(task.cancel).toHaveBeenCalledTimes(1);
    expect(status.phase).toBe(SubagentStatus.CANCELLED);
    expect(manager.getRunningCount()).toBe(0);
    expect(manager.getRunningCountBySession("test:c1")).toBe(0);
  });

  it("returns zero when cancelling a session with no subagent tasks", async () => {
    const manager = new SubagentManager({ bus: new MessageBus(), maxConcurrent: 2 });

    await expect(manager.cancelBySession("missing")).resolves.toBe(0);
  });

  it("announces subagent results with the effective session key", async () => {
    const bus = new MessageBus();
    const manager = new SubagentManager({ bus });

    await manager.announceResult(
      "sub-1",
      "label",
      "do task",
      "result",
      { channel: "telegram", chatId: "222", sessionKey: "unified:default" },
      "ok",
    );

    const msg = await bus.consumeInbound();
    expect(msg.sessionKey).toBe("unified:default");
    expect(msg.sessionKeyOverride).toBe("unified:default");
    expect(msg.metadata.subagentTaskId).toBe("sub-1");
  });

  it("announces subagent results with the raw channel session key in normal mode", async () => {
    const bus = new MessageBus();
    const manager = new SubagentManager({ bus });

    await manager.announceResult(
      "sub-2",
      "label",
      "do task",
      "result",
      { channel: "telegram", chatId: "222", sessionKey: "telegram:222" },
      "ok",
    );

    const msg = await bus.consumeInbound();
    expect(msg.sessionKey).toBe("telegram:222");
    expect(msg.sessionKeyOverride).toBe("telegram:222");
  });

  it("falls back to channel and chat id when announcing without a session key", async () => {
    const bus = new MessageBus();
    const manager = new SubagentManager({ bus });

    await manager.announceResult(
      "sub-3",
      "label",
      "do task",
      "result",
      { channel: "discord", chatId: "333", sessionKey: null },
      "ok",
    );

    const msg = await bus.consumeInbound();
    expect(msg.sessionKey).toBe("discord:333");
    expect(msg.sessionKeyOverride).toBe("discord:333");
    expect(msg.channel).toBe("system");
    expect(msg.chatId).toBe("discord:333");
  });

  it("propagates the origin session key through runSubagent announcements", async () => {
    const bus = new MessageBus();
    const manager = new SubagentManager({ bus });
    manager.runner.run = vi.fn(async () => new AgentRunResult({
      finalContent: "done",
      messages: [],
      stopReason: "completed",
    }));
    const status = new SubagentStatus({ taskId: "sub-4", label: "label", taskDescription: "task" });

    await manager.runSubagent(
      "sub-4",
      "task",
      "label",
      { channel: "telegram", chatId: "444", sessionKey: "unified:default" },
      status,
    );

    const msg = await bus.consumeInbound();
    expect(msg.sessionKeyOverride).toBe("unified:default");
  });

  it("does not register exec in subagent tools when disabled by config", () => {
    const config = new Config({ tools: { exec: { enable: false } } });
    const manager = new SubagentManager({
      bus: new MessageBus(),
      workspace: tmpDir("memmy-subagent-tools-"),
      toolsConfig: config.tools,
    });

    expect(manager.buildTools().get("exec")).toBeUndefined();
  });

  it("does not register exec in AgentLoop tools when disabled by config", () => {
    const loop = new AgentLoop({
      provider: { generation: { maxTokens: 4096 }, getDefaultModel: () => "test-model" },
      workspace: tmpDir("memmy-task-cancel-"),
      config: new Config({ tools: { exec: { enable: false } } }),
    });

    expect(loop.tools.get("exec")).toBeUndefined();
  });

  it("dispatch publishes processed outbound messages", async () => {
    const loop = makeLoop();
    loop.runner.run = vi.fn(async (spec: any) => new AgentRunResult({
      finalContent: "hi",
      messages: [...spec.messages, { role: "assistant", content: "hi" }],
      stopReason: "completed",
    }));

    await loop.dispatchMessage(new InboundMessage({ channel: "test", chatId: "c1", senderId: "u1", content: "hello" }));

    const out = await withTimeout(loop.bus.consumeOutbound());
    expect(out.content).toBe("hi");
  });

  it("dispatch publishes WebUI running and idle around a normal turn", async () => {
    const loop = makeLoop();
    loop.runner.run = vi.fn(async (spec: any) => new AgentRunResult({
      finalContent: "hi",
      messages: [...spec.messages, { role: "assistant", content: "hi" }],
      stopReason: "completed",
    }));

    await loop.dispatchMessage(new InboundMessage({
      channel: "websocket",
      chatId: "c1",
      senderId: "u1",
      content: "hello",
      metadata: { webui: true },
    }));

    const running = await withTimeout(loop.bus.consumeOutbound());
    const sessionUpdated = await withTimeout(loop.bus.consumeOutbound());
    const answer = await withTimeout(loop.bus.consumeOutbound());
    const turnEnd = await withTimeout(loop.bus.consumeOutbound());
    const idle = await withTimeout(loop.bus.consumeOutbound());
    expect(running.metadata).toMatchObject({ goalStatusEvent: true, goalStatus: "running" });
    expect(sessionUpdated.metadata).toMatchObject({ sessionUpdated: true, sessionUpdateScope: "thread" });
    expect(answer.content).toBe("hi");
    expect(turnEnd.metadata).toMatchObject({ turnEnd: true });
    expect(idle.metadata).toMatchObject({ goalStatusEvent: true, goalStatus: "idle" });
  });

  it("dispatch streaming preserves message metadata", async () => {
    const loop = makeLoop();
    const msg = new InboundMessage({
      channel: "matrix",
      senderId: "u1",
      chatId: "!room:matrix.org",
      content: "hello",
      metadata: {
        wantsStream: true,
        thread_root_event_id: "$root1",
        thread_reply_to_event_id: "$reply1",
      },
    });
    loop.processMessageInternal = vi.fn(async (msg, key, opts) => {
      expect(opts.onStream).toBeTypeOf("function");
      expect(opts.onStreamEnd).toBeTypeOf("function");
      await opts.onStream("hi");
      await opts.onStreamEnd({ resuming: false });
      return null;
    });

    await loop.dispatchMessage(msg);

    const first = await withTimeout(loop.bus.consumeOutbound());
    const second = await withTimeout(loop.bus.consumeOutbound());
    expect(first.metadata).toMatchObject({
      thread_root_event_id: "$root1",
      thread_reply_to_event_id: "$reply1",
      streamDelta: true,
    });
    expect(second.metadata).toMatchObject({
      thread_root_event_id: "$root1",
      thread_reply_to_event_id: "$reply1",
      streamEnd: true,
    });
  });

  it("dispatch serializes messages for the same session", async () => {
    const loop = makeLoop();
    const order: string[] = [];
    loop.processMessageInternal = vi.fn(async (msg: InboundMessage) => {
      order.push(`start-${msg.content}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(`end-${msg.content}`);
      return { channel: msg.channel, chatId: msg.chatId, content: msg.content, metadata: {} } as any;
    });

    await Promise.all([
      loop.dispatchMessage(new InboundMessage({ channel: "test", chatId: "c1", senderId: "u1", content: "a" })),
      loop.dispatchMessage(new InboundMessage({ channel: "test", chatId: "c1", senderId: "u1", content: "b" })),
    ]);

    expect(order).toEqual(["start-a", "end-a", "start-b", "end-b"]);
  });

  it("run dispatches priority stop commands without processing a normal turn", async () => {
    const loop = makeLoop();
    const task = cancelableTask();
    loop.activeTasks.set("test:c1", [task]);
    loop.processMessageInternal = vi.fn(async () => {
      throw new Error("priority command should not enter processMessageInternal");
    });

    const running = loop.run();
    await loop.bus.publishInbound(new InboundMessage({ channel: "test", chatId: "c1", senderId: "u1", content: "/stop" }));
    const out = await withTimeout(loop.bus.consumeOutbound());
    loop.stop();
    await withTimeout(running, 1000);

    expect(out.content.toLowerCase()).toContain("stopped");
    expect(task.cancel).toHaveBeenCalledTimes(1);
    expect(loop.processMessageInternal).not.toHaveBeenCalled();
  });

  it("run completes /new without cancelling itself and processes the next message", async () => {
    const loop = new AgentLoop({
      provider: { generation: { maxTokens: 4096 }, getDefaultModel: () => "test-model" },
      workspace: tmpDir("memmy-task-cancel-"),
      config: new Config({ memmyMemory: { enabled: false } }),
    });
    loop.runner.run = vi.fn(async (spec: any) => new AgentRunResult({
      finalContent: "after-new",
      messages: [...spec.messages, { role: "assistant", content: "after-new" }],
      stopReason: "completed",
    }));

    const running = loop.run();
    try {
      await loop.bus.publishInbound(new InboundMessage({
        channel: "websocket",
        chatId: "c1",
        senderId: "u1",
        content: "/new",
        metadata: { webui: true },
      }));
      const runningStatus = await withTimeout(loop.bus.consumeOutbound(), 2000);
      const reset = await withTimeout(loop.bus.consumeOutbound(), 2000);
      const resetTurnEnd = await withTimeout(loop.bus.consumeOutbound(), 2000);
      const idleStatus = await withTimeout(loop.bus.consumeOutbound(), 2000);

      expect(runningStatus.metadata).toMatchObject({ goalStatusEvent: true, goalStatus: "running" });
      expect(reset.content).toBe("New session started.");
      expect(resetTurnEnd.metadata).toMatchObject({ turnEnd: true });
      expect(idleStatus.metadata).toMatchObject({ goalStatusEvent: true, goalStatus: "idle" });
      expect(loop.pendingQueues.has("websocket:c1")).toBe(false);

      await loop.bus.publishInbound(new InboundMessage({
        channel: "websocket",
        chatId: "c1",
        senderId: "u1",
        content: "hello after reset",
        metadata: { webui: true },
      }));
      const reply = await withTimeout(loop.bus.consumeOutbound(), 2000);

      expect(reply.metadata).toMatchObject({ goalStatusEvent: true, goalStatus: "running" });
      const answerSessionUpdated = await withTimeout(loop.bus.consumeOutbound(), 2000);
      const answer = await withTimeout(loop.bus.consumeOutbound(), 2000);
      const answerTurnEnd = await withTimeout(loop.bus.consumeOutbound(), 2000);
      const answerIdle = await withTimeout(loop.bus.consumeOutbound(), 2000);

      expect(answerSessionUpdated.metadata).toMatchObject({ sessionUpdated: true, sessionUpdateScope: "thread" });
      expect(answer.content).toBe("after-new");
      expect(answerTurnEnd.metadata).toMatchObject({ turnEnd: true });
      expect(answerIdle.metadata).toMatchObject({ goalStatusEvent: true, goalStatus: "idle" });
      expect(loop.runner.run).toHaveBeenCalledTimes(1);
    } finally {
      loop.stop();
      await withTimeout(running, 1000);
    }
  });

  it("aborts the active websocket turn and restores pending context on /stop", async () => {
    let entered!: () => void;
    let seenSignal: AbortSignal | null = null;
    const providerEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const loop = new AgentLoop({
      workspace: tmpDir("memmy-task-cancel-"),
      config: new Config({ memmyMemory: { enabled: false } }),
      provider: {
        generation: { maxTokens: 4096, temperature: 0.1, reasoningEffort: null },
        getDefaultModel: () => "test-model",
        estimatePromptTokens: () => [10_000, "test"],
        chat: vi.fn((args: any) => {
          seenSignal = args.signal ?? null;
          entered();
          return new Promise(() => undefined);
        }),
      } as any,
    });

    const running = loop.run();
    try {
      await loop.bus.publishInbound(new InboundMessage({
        channel: "websocket",
        chatId: "c1",
        senderId: "u1",
        content: "执行一个长任务",
        metadata: { webui: true, wantsStream: true },
      }));
      await withTimeout(providerEntered);
      expect(seenSignal).toBeInstanceOf(AbortSignal);

      await loop.bus.publishInbound(new InboundMessage({
        channel: "websocket",
        chatId: "c1",
        senderId: "u1",
        content: "/stop",
        metadata: { webui: true },
      }));

      const first = await withTimeout(loop.bus.consumeOutbound(), 2000);
      const second = await withTimeout(loop.bus.consumeOutbound(), 2000);
      const third = await withTimeout(loop.bus.consumeOutbound(), 2000);
      const fourth = await withTimeout(loop.bus.consumeOutbound(), 2000);
      const fifth = await withTimeout(loop.bus.consumeOutbound(), 2000);

      const signal = seenSignal as unknown as AbortSignal;
      expect(signal.aborted).toBe(true);
      expect(first.metadata).toMatchObject({ goalStatusEvent: true, goalStatus: "running" });
      expect(second.metadata).toMatchObject({ sessionUpdated: true, sessionUpdateScope: "thread" });
      expect(third.metadata).toMatchObject({ turnEnd: true });
      expect(fourth.metadata).toMatchObject({ goalStatusEvent: true, goalStatus: "idle" });
      expect(fifth.content.toLowerCase()).toContain("stopped");
      const session = loop.sessions.getOrCreate("websocket:c1");
      expect(session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
      expect(session.messages.at(-1)?.content).toBe("Error: Task interrupted before a response was generated.");
      expect(session.messages.some((message) => message.content === "Error: task cancelled")).toBe(false);
    } finally {
      loop.stop();
      await withTimeout(running, 1000);
    }
  });

  it("run routes follow-up messages into the active turn pending queue", async () => {
    const loop = makeLoop();
    let entered!: () => void;
    const runnerEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const injections: any[] = [];
    loop.runner.run = vi.fn(async (spec: any) => {
      entered();
      await new Promise((resolve) => setTimeout(resolve, 150));
      injections.push(...await spec.injectionCallback({ limit: 3 }));
      return new AgentRunResult({
        finalContent: "done",
        messages: [...spec.messages, { role: "assistant", content: "done" }],
        stopReason: "completed",
      });
    });

    const running = loop.run();
    await loop.bus.publishInbound(new InboundMessage({ channel: "test", chatId: "c1", senderId: "u1", content: "first" }));
    await withTimeout(runnerEntered);
    await loop.bus.publishInbound(new InboundMessage({ channel: "test", chatId: "c1", senderId: "u1", content: "second" }));

    const out = await withTimeout(loop.bus.consumeOutbound(), 2000);
    loop.stop();
    await withTimeout(running, 1000);

    expect(out.content).toBe("done");
    expect(loop.runner.run).toHaveBeenCalledTimes(1);
    expect(injections).toEqual([{ role: "user", content: "second" }]);
  });
});
