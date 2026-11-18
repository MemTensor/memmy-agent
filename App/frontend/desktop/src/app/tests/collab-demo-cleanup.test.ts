/**
 * 引导结束后的清理：开始时记下的快照之外、又出现在同一个项目里的任务就是要删的那几条；
 * 清理时先取消共享再删本机会话，其中一步失败不影响其余。
 */
import { describe, expect, it, vi } from "vitest";
import {
  demoCleanupBaseline,
  demoTasksToRemove,
  removeDemoTasks,
  type DemoCleanupTask
} from "../collab-demo-cleanup.js";

const PROJECT = "local-1";

function task(sessionKey: string, projectId: string | null = PROJECT, archived = false): DemoCleanupTask {
  return { sessionKey, chatId: `chat-${sessionKey}`, projectId, archived };
}

describe("demoCleanupBaseline", () => {
  it("只记这个项目里没归档的任务", () => {
    const baseline = demoCleanupBaseline([
      task("kept"),
      task("archived", PROJECT, true),
      task("elsewhere", "local-2"),
      task("loose", null)
    ], PROJECT);
    expect([...baseline]).toEqual(["kept"]);
  });
});

describe("demoTasksToRemove", () => {
  it("只删引导开始之后出现的、这个项目里的任务", () => {
    const before = [task("before")];
    const baseline = demoCleanupBaseline(before, PROJECT);
    const targets = demoTasksToRemove([
      ...before,
      task("demo-task"),
      task("other-project", "local-2"),
      task("archived-demo", PROJECT, true)
    ], PROJECT, baseline);
    expect(targets.map((item) => item.sessionKey)).toEqual(["demo-task"]);
  });

  it("开始前就有任务的项目里什么也不删", () => {
    const baseline = demoCleanupBaseline([task("before")], PROJECT);
    expect(demoTasksToRemove([task("before")], PROJECT, baseline)).toEqual([]);
  });
});

describe("removeDemoTasks", () => {
  it("先取消共享再删本机会话，并返回删掉的几条", async () => {
    const calls: string[] = [];
    const removed = await removeDemoTasks({
      tasks: [task("demo-task")],
      localProjectId: PROJECT,
      cloudProjectId: "cloud-1",
      baseline: new Set<string>(),
      unshare: async (projectId, conversationId) => {
        calls.push(`unshare:${projectId}:${conversationId}`);
      },
      deleteSession: async (sessionKey) => {
        calls.push(`delete:${sessionKey}`);
      }
    });
    expect(calls).toEqual(["unshare:cloud-1:demo-task", "delete:demo-task"]);
    expect(removed.map((item) => item.sessionKey)).toEqual(["demo-task"]);
  });

  it("取消共享失败时仍然删本机会话", async () => {
    const deleteSession = vi.fn(async () => undefined);
    const removed = await removeDemoTasks({
      tasks: [task("demo-task")],
      localProjectId: PROJECT,
      cloudProjectId: "cloud-1",
      baseline: new Set<string>(),
      unshare: async () => {
        throw new Error("offline");
      },
      deleteSession
    });
    expect(deleteSession).toHaveBeenCalledWith("demo-task");
    expect(removed.map((item) => item.sessionKey)).toEqual(["demo-task"]);
  });

  it("本机会话删不掉时不把它算成已删，也不挡住后面的任务", async () => {
    const removed = await removeDemoTasks({
      tasks: [task("stuck"), task("later")],
      localProjectId: PROJECT,
      cloudProjectId: "cloud-1",
      baseline: new Set<string>(),
      unshare: async () => undefined,
      deleteSession: async (sessionKey) => {
        if (sessionKey === "stuck") throw new Error("locked");
      }
    });
    expect(removed.map((item) => item.sessionKey)).toEqual(["later"]);
  });

  it("引导期间什么都没建时一次请求都不发", async () => {
    const unshare = vi.fn(async () => undefined);
    const removed = await removeDemoTasks({
      tasks: [],
      localProjectId: PROJECT,
      cloudProjectId: "cloud-1",
      baseline: new Set<string>(),
      unshare,
      deleteSession: async () => undefined
    });
    expect(unshare).not.toHaveBeenCalled();
    expect(removed).toEqual([]);
  });
});
