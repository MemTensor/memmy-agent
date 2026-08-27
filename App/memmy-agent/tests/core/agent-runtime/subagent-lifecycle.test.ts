import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentHookContext } from "../../../src/core/agent-runtime/hook.js";
import { AgentRunResult } from "../../../src/core/agent-runtime/runner.js";
import { SubagentHook, SubagentManager, SubagentStatus } from "../../../src/core/agent-runtime/subagent.js";
import { MessageBus } from "../../../src/core/runtime-messages/index.js";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memmy-subagent-"));
}

function manager(overrides: Record<string, any> = {}): SubagentManager {
  const provider = overrides.provider ?? {
    getDefaultModel: () => "test-model",
  };
  const sm = new SubagentManager({
    provider,
    workspace: overrides.workspace ?? tmpRoot(),
    bus: overrides.bus ?? new MessageBus(),
    model: overrides.model ?? "test-model",
    maxToolResultChars: 16_000,
    maxConcurrent: 4,
  });
  sm.buildTools = vi.fn(() => ({}) as any);
  return sm;
}

function runResult(init: Record<string, any> = {}): AgentRunResult {
  return new AgentRunResult({ finalContent: "done", messages: [], stopReason: "completed", ...init });
}

function hookContext(overrides: Record<string, any> = {}): AgentHookContext {
  return new AgentHookContext({
    iteration: 1,
    toolCalls: [],
    toolEvents: [],
    messages: [],
    usage: {},
    error: null,
    stopReason: "completed",
    finalContent: "ok",
    ...overrides,
  });
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T = AgentRunResult>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function cancelableTask(): Promise<void> & { cancel: () => boolean; done: () => boolean } {
  let settled = false;
  let resolveTask!: () => void;
  const task = new Promise<void>((resolve) => {
    resolveTask = resolve;
  }) as Promise<void> & { cancel: () => boolean; done: () => boolean };
  task.cancel = vi.fn(() => {
    if (settled) return false;
    settled = true;
    resolveTask();
    return true;
  });
  task.done = () => settled;
  return task;
}

describe("SubagentStatus", () => {
  it("uses runtime-parity default fields", () => {
    const status = new SubagentStatus({ taskId: "abc", label: "test", taskDescription: "do stuff", startedAt: performance.now() / 1000 });

    expect(status.phase).toBe("initializing");
    expect(status.iteration).toBe(0);
    expect(status.toolEvents).toEqual([]);
    expect(status.usage).toEqual({});
    expect(status.stopReason).toBeNull();
    expect(status.error).toBeNull();
  });
});

describe("SubagentManager provider setup", () => {
  it("updates provider, model, and runner provider", () => {
    const sm = manager();
    const newProvider = { getDefaultModel: () => "new-model" };

    sm.setProvider(newProvider, "new-model");

    expect(sm.provider).toBe(newProvider);
    expect(sm.model).toBe("new-model");
    expect(sm.runner.provider).toBe(newProvider);
  });
});

describe("SubagentManager spawn", () => {
  it("returns a started message with a task id", async () => {
    const sm = manager();
    sm.runner.run = vi.fn(async () => runResult());

    const result = await sm.spawn("do something");

    expect(result).toContain("started");
    expect(result).toContain("id:");
  });

  it("creates a task in running_tasks while work is pending", async () => {
    const sm = manager();
    const block = deferred();
    sm.runner.run = vi.fn(() => block.promise);

    await sm.spawn("task", null, "cli", "direct", "s1");

    expect(sm.runningTasks.size).toBe(1);
    block.resolve(runResult());
    await tick();
    expect(sm.runningTasks.size).toBe(0);
  });

  it("creates a status while work is pending", async () => {
    const sm = manager();
    const block = deferred();
    sm.runner.run = vi.fn(() => block.promise);

    await sm.spawn("my task", null, "cli", "direct", "s1");

    expect(sm.taskStatuses.size).toBe(1);
    expect([...sm.taskStatuses.values()][0].taskDescription).toBe("my task");
    block.resolve(runResult());
    await tick();
    expect(sm.taskStatuses.size).toBe(0);
  });

  it("registers spawned tasks under the session key", async () => {
    const sm = manager();
    const block = deferred();
    sm.runner.run = vi.fn(() => block.promise);

    await sm.spawn("task", null, "cli", "direct", "s1");

    expect(sm.sessionTasks.get("s1")?.size).toBe(1);
    block.resolve(runResult());
    await tick();
    expect(sm.sessionTasks.has("s1")).toBe(false);
  });

  it("does not register session tasks without a session key", async () => {
    const sm = manager();
    const block = deferred();
    sm.runner.run = vi.fn(() => block.promise);

    await sm.spawn("task");

    expect(sm.sessionTasks.size).toBe(0);
    block.resolve(runResult());
    await tick();
  });

  it("defaults labels to truncated task descriptions", async () => {
    const sm = manager();
    const block = deferred();
    sm.runner.run = vi.fn(() => block.promise);
    const longTask = "A".repeat(50);

    await sm.spawn(longTask, null, "cli", "direct", "s1");

    expect([...sm.taskStatuses.values()][0].label).toBe(`${longTask.slice(0, 30)}...`);
    block.resolve(runResult());
    await tick();
  });

  it("uses custom labels", async () => {
    const sm = manager();
    const block = deferred();
    sm.runner.run = vi.fn(() => block.promise);

    await sm.spawn("task", "Custom Label", "cli", "direct", "s1");

    expect([...sm.taskStatuses.values()][0].label).toBe("Custom Label");
    block.resolve(runResult());
    await tick();
  });

  it("cleanup removes running, status, and session task entries", async () => {
    const sm = manager();
    sm.runner.run = vi.fn(async () => runResult());

    await sm.spawn("task", null, "cli", "direct", "s1");
    await tick();

    expect(sm.runningTasks.size).toBe(0);
    expect(sm.taskStatuses.size).toBe(0);
    expect(sm.sessionTasks.size).toBe(0);
  });
});

describe("SubagentManager run", () => {
  it("announces successful runs as ok", async () => {
    const sm = manager();
    sm.runner.run = vi.fn(async () => runResult({ finalContent: "Task done!" }));
    sm.announceResult = vi.fn(async () => undefined) as any;
    const status = new SubagentStatus({ taskId: "t1", label: "label", taskDescription: "do task" });

    await sm.runSubagent("t1", "do task", "label", { channel: "cli", chatId: "direct" }, status);

    expect(sm.announceResult).toHaveBeenCalledOnce();
    expect((sm.announceResult as any).mock.calls[0][5]).toBe("ok");
  });

  it("announces toolError runs as error", async () => {
    const sm = manager();
    sm.runner.run = vi.fn(async () => runResult({
      finalContent: null,
      stopReason: "toolError",
      toolEvents: [{ name: "read_file", status: "error", detail: "not found" }],
    }));
    sm.announceResult = vi.fn(async () => undefined) as any;
    const status = new SubagentStatus({ taskId: "t1", label: "label", taskDescription: "do task" });

    await sm.runSubagent("t1", "do task", "label", { channel: "cli", chatId: "direct" }, status);

    expect((sm.announceResult as any).mock.calls[0][5]).toBe("error");
  });

  it("records exceptions and announces them as errors", async () => {
    const sm = manager();
    sm.runner.run = vi.fn(async () => {
      throw new Error("LLM down");
    });
    sm.announceResult = vi.fn(async () => undefined) as any;
    const status = new SubagentStatus({ taskId: "t1", label: "label", taskDescription: "do task" });

    await sm.runSubagent("t1", "do task", "label", { channel: "cli", chatId: "direct" }, status);

    expect(status.phase).toBe("error");
    expect(status.error).toContain("LLM down");
    expect((sm.announceResult as any).mock.calls[0][5]).toBe("error");
  });

  it("updates status on success", async () => {
    const sm = manager();
    sm.runner.run = vi.fn(async () => runResult({ finalContent: "ok", stopReason: "completed" }));
    sm.announceResult = vi.fn(async () => undefined) as any;
    const status = new SubagentStatus({ taskId: "t1", label: "label", taskDescription: "do task" });

    await sm.runSubagent("t1", "do task", "label", { channel: "cli", chatId: "direct" }, status);

    expect(status.phase).toBe("done");
    expect(status.stopReason).toBe("completed");
  });
});

describe("SubagentManager announcements", () => {
  function capturePublished(sm: SubagentManager): any[] {
    const published: any[] = [];
    sm.bus.publishInbound = vi.fn(async (msg) => {
      published.push(msg);
    }) as any;
    return published;
  }

  it("publishes inbound system messages", async () => {
    const sm = manager();
    const published = capturePublished(sm);

    await sm.announceResult("t1", "label", "task", "result text", { channel: "cli", chatId: "direct" }, "ok");

    expect(published).toHaveLength(1);
    expect(published[0].channel).toBe("system");
    expect(published[0].senderId).toBe("subagent");
    expect(published[0].metadata).toMatchObject({ injectedEvent: "subagentResult", subagentTaskId: "t1" });
  });

  it("uses explicit session key overrides", async () => {
    const sm = manager();
    const published = capturePublished(sm);

    await sm.announceResult("t1", "label", "task", "result", { channel: "telegram", chatId: "123", sessionKey: "s1" }, "ok");

    expect(published[0].sessionKeyOverride).toBe("s1");
  });

  it("falls back to channel/chat session key overrides", async () => {
    const sm = manager();
    const published = capturePublished(sm);

    await sm.announceResult("t1", "label", "task", "result", { channel: "telegram", chatId: "123" }, "ok");

    expect(published[0].sessionKeyOverride).toBe("telegram:123");
  });

  it("renders successful status text", async () => {
    const sm = manager();
    const published = capturePublished(sm);

    await sm.announceResult("t1", "label", "task", "result", { channel: "cli", chatId: "direct" }, "ok");

    expect(published[0].content).toContain("completed successfully");
  });

  it("renders failure status text", async () => {
    const sm = manager();
    const published = capturePublished(sm);

    await sm.announceResult("t1", "label", "task", "error details", { channel: "cli", chatId: "direct" }, "error");

    expect(published[0].content).toContain("failed");
  });

  it("preserves origin message ids in metadata", async () => {
    const sm = manager();
    const published = capturePublished(sm);

    await sm.announceResult("t1", "label", "task", "result", { channel: "cli", chatId: "direct" }, "ok", "msg-123");

    expect(published[0].metadata.originMessageId).toBe("msg-123");
  });
});

describe("SubagentManager partial progress", () => {
  it("formats completed tool steps", () => {
    const text = SubagentManager.formatPartialProgress({ toolEvents: [
      { name: "read_file", status: "ok", detail: "file content" },
      { name: "exec", status: "ok", detail: "output" },
    ] });

    expect(text).toContain("Completed steps:");
    expect(text).toContain("read_file");
    expect(text).toContain("exec");
  });

  it("formats failure-only progress", () => {
    const text = SubagentManager.formatPartialProgress({ toolEvents: [{ name: "read_file", status: "error", detail: "not found" }] });

    expect(text).toContain("Failure:");
    expect(text).toContain("not found");
  });

  it("formats completed steps and failures together", () => {
    const text = SubagentManager.formatPartialProgress({ toolEvents: [
      { name: "read_file", status: "ok", detail: "content" },
      { name: "exec", status: "error", detail: "timeout" },
    ] });

    expect(text).toContain("Completed steps:");
    expect(text).toContain("Failure:");
  });

  it("limits completed steps to the last three", () => {
    const text = SubagentManager.formatPartialProgress({
      toolEvents: Array.from({ length: 5 }, (value, index) => ({ name: `tool_${index}`, status: "ok", detail: `result_${index}` })),
    });

    expect(text).toContain("tool_2");
    expect(text).toContain("tool_3");
    expect(text).toContain("tool_4");
    expect(text).not.toContain("tool_0");
    expect(text).not.toContain("tool_1");
  });

  it("uses result errors when there is no failure event", () => {
    const text = SubagentManager.formatPartialProgress({
      toolEvents: [{ name: "read_file", status: "ok", detail: "ok" }],
      error: "Something went wrong",
    });

    expect(text).toContain("Something went wrong");
  });

  it("formats empty events with an error", () => {
    expect(SubagentManager.formatPartialProgress({ error: "Total failure" })).toContain("Total failure");
  });

  it("returns a fallback when there are no events and no error", () => {
    expect(SubagentManager.formatPartialProgress({})).toContain("Error");
  });
});

describe("SubagentManager cancellation and counts", () => {
  it("cancels running tasks by session", async () => {
    const sm = manager();
    const task1 = cancelableTask();
    const task2 = cancelableTask();
    sm.runningTasks.set("t1", task1 as any);
    sm.runningTasks.set("t2", task2 as any);
    sm.sessionTasks.set("s1", new Set(["t1", "t2"]));

    expect(await sm.cancelBySession("s1")).toBe(2);
    expect(task1.cancel).toHaveBeenCalledTimes(1);
    expect(task2.cancel).toHaveBeenCalledTimes(1);
    expect(sm.sessionTasks.has("s1")).toBe(false);
  });

  it("cancels real spawned subagents without announcing a late result", async () => {
    const sm = manager();
    const seen: { signal?: AbortSignal } = {};
    sm.runner.run = vi.fn((spec: any) => {
      seen.signal = spec.abortSignal;
      return new Promise<AgentRunResult>((resolve) => {
        spec.abortSignal.addEventListener(
          "abort",
          () => resolve(runResult({ finalContent: "late result", stopReason: "completed" })),
          { once: true },
        );
      });
    }) as any;
    sm.announceResult = vi.fn(async () => undefined) as any;

    await sm.spawn("long task", null, "cli", "direct", "s1");

    expect(seen.signal).toBeDefined();
    const signal = seen.signal!;
    expect(signal.aborted).toBe(false);
    expect(sm.getRunningCountBySession("s1")).toBe(1);
    expect(await sm.cancelBySession("s1")).toBe(1);
    expect(signal.aborted).toBe(true);
    expect(sm.announceResult).not.toHaveBeenCalled();
    expect(sm.getRunningCount()).toBe(0);
    expect(sm.getRunningCountBySession("s1")).toBe(0);
  });

  it("returns zero when a session has no tasks", async () => {
    expect(await manager().cancelBySession("nonexistent")).toBe(0);
  });

  it("does not count already completed tasks", async () => {
    const sm = manager();
    sm.sessionTasks.set("s1", new Set(["t1"]));

    expect(await sm.cancelBySession("s1")).toBe(0);
  });

  it("reports zero running tasks initially", () => {
    expect(manager().getRunningCount()).toBe(0);
  });

  it("tracks total and per-session running task counts", () => {
    const sm = manager();
    sm.runningTasks.set("t1", Promise.resolve() as any);
    sm.runningTasks.set("t2", Promise.resolve() as any);
    sm.sessionTasks.set("s1", new Set(["t1", "t2"]));

    expect(sm.getRunningCount()).toBe(2);
    expect(sm.getRunningCountBySession("s1")).toBe(2);
  });

  it("returns zero for unknown session running counts", () => {
    expect(manager().getRunningCountBySession("nonexistent")).toBe(0);
  });
});

describe("SubagentHook", () => {
  it("beforeExecuteTools is a no-op hook point", async () => {
    const hook = new SubagentHook("t1");

    await expect(hook.beforeExecuteTools(hookContext({ toolCalls: [{ name: "read_file", arguments: { path: "/tmp/test" } }] }))).resolves.toBeUndefined();
  });

  it("afterIteration updates status progress", async () => {
    const status = new SubagentStatus({ taskId: "t1", label: "test", taskDescription: "do" });
    const hook = new SubagentHook("t1", status);

    await hook.afterIteration(hookContext({ iteration: 3, toolEvents: [{ name: "read_file", status: "ok", detail: "" }], usage: { prompt_tokens: 100 } }));

    expect(status.iteration).toBe(3);
    expect(status.toolEvents).toHaveLength(1);
    expect(status.usage).toEqual({ prompt_tokens: 100 });
  });

  it("afterIteration without status is a no-op", async () => {
    await expect(new SubagentHook("t1", null).afterIteration(hookContext({ iteration: 5 }))).resolves.toBeUndefined();
  });

  it("afterIteration records errors", async () => {
    const status = new SubagentStatus({ taskId: "t1", label: "test", taskDescription: "do" });
    const hook = new SubagentHook("t1", status);

    await hook.afterIteration(hookContext({ error: "something broke" }));

    expect(status.error).toBe("something broke");
  });
});
