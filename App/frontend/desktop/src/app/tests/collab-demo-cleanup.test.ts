/**
 * 引导结束后的清理：以磁盘上的会话列表为准，引导开始时的快照之外就是要删的那几条；
 * 界面清单只作兜底，两份取并集；清理时先取消共享再删本机会话，其中一步失败不影响其余。
 */
import { describe, expect, it, vi } from "vitest";
import {
  demoCleanupBaseline,
  demoSessionKey,
  demoTasksToRemove,
  removeDemoTasks
} from "../collab-demo-cleanup.js";

describe("demoSessionKey", () => {
  it("本机会话存成 websocket_<id>.jsonl，key 就是 websocket:<id>", () => {
    expect(demoSessionKey("abc-123")).toBe("websocket:abc-123");
  });
});

describe("demoCleanupBaseline", () => {
  it("记下引导开始时已有的会话", () => {
    expect([...demoCleanupBaseline(["a", "b"])]).toEqual(["a", "b"]);
  });

  it("新项目没有会话时是空集", () => {
    expect([...demoCleanupBaseline([])]).toEqual([]);
  });
});

describe("demoTasksToRemove", () => {
  it("磁盘列表里快照之外的就是要删的", () => {
    const baseline = demoCleanupBaseline(["before"]);
    expect(demoTasksToRemove(["before", "demo-task"], baseline)).toEqual(["demo-task"]);
  });

  it("快照为空时把磁盘列表全算进去（演示项目本来就是这次新建的）", () => {
    expect(demoTasksToRemove(["demo-task"], demoCleanupBaseline([]))).toEqual(["demo-task"]);
  });

  it("界面清单作为兜底并进结果，但不重复、也不越过快照", () => {
    const baseline = demoCleanupBaseline(["before"]);
    expect(demoTasksToRemove(["demo-task"], baseline, ["demo-task", "listed-only", "before"]))
      .toEqual(["demo-task", "listed-only"]);
  });

  it("两边都没有新会话时什么也不删", () => {
    expect(demoTasksToRemove(["before"], demoCleanupBaseline(["before"]), ["before"])).toEqual([]);
  });

  it("空 id 不进结果", () => {
    expect(demoTasksToRemove(["", "demo-task"], demoCleanupBaseline([]), [""])).toEqual(["demo-task"]);
  });
});

describe("removeDemoTasks", () => {
  it("先取消共享再删本机会话，并返回删掉的会话", async () => {
    const calls: string[] = [];
    const removed = await removeDemoTasks({
      conversationIds: ["demo-task"],
      cloudProjectId: "cloud-1",
      unshare: async (projectId, conversationId) => {
        calls.push(`unshare:${projectId}:${conversationId}`);
      },
      deleteSession: async (sessionKey) => {
        calls.push(`delete:${sessionKey}`);
      }
    });
    expect(calls).toEqual(["unshare:cloud-1:demo-task", "delete:websocket:demo-task"]);
    expect(removed).toEqual(["demo-task"]);
  });

  it("取消共享失败时仍然删本机会话", async () => {
    const deleteSession = vi.fn(async () => undefined);
    const removed = await removeDemoTasks({
      conversationIds: ["demo-task"],
      cloudProjectId: "cloud-1",
      unshare: async () => {
        throw new Error("offline");
      },
      deleteSession
    });
    expect(deleteSession).toHaveBeenCalledWith("websocket:demo-task");
    expect(removed).toEqual(["demo-task"]);
  });

  it("本机会话删不掉时不把它算成已删，也不挡住后面的", async () => {
    const removed = await removeDemoTasks({
      conversationIds: ["stuck", "later"],
      cloudProjectId: "cloud-1",
      unshare: async () => undefined,
      deleteSession: async (sessionKey) => {
        if (sessionKey === "websocket:stuck") throw new Error("locked");
      }
    });
    expect(removed).toEqual(["later"]);
  });

  it("引导期间什么都没建时一次请求都不发", async () => {
    const unshare = vi.fn(async () => undefined);
    const removed = await removeDemoTasks({
      conversationIds: [],
      cloudProjectId: "cloud-1",
      unshare,
      deleteSession: async () => undefined
    });
    expect(unshare).not.toHaveBeenCalled();
    expect(removed).toEqual([]);
  });
});
