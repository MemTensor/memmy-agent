import { describe, expect, it } from "vitest";
import {
  addTaskToSnapshot,
  appendChunkToSnapshot,
  completeTaskInSnapshot,
  createEmptyTaskBusSnapshot,
  createTaskRecord,
  dismissTaskInSnapshot,
  focusTaskInSnapshot,
  loadTaskBusSnapshot,
  markTaskReadInSnapshot,
  removeTasksBySessionIdsInSnapshot,
  saveTaskBusSnapshot,
  startNewSessionInSnapshot,
  syncAgentConversationToSnapshot,
  syncAgentTaskStatusesToSnapshot,
  type TaskBusSnapshot
} from "../task-bus.js";

describe("TaskBus snapshot helpers", () => {
  it("createTask 写入任务、摘要标题、焦点和显式 session", () => {
    const task = createTaskRecord(
      { input: "  帮我总结一下今天   的会议纪要，并列出后续行动项和每个负责人的截止时间  ", source: "pet", sessionId: "session-old" },
      { now: 1000, makeId: nextId(["task-1"]) }
    );
    const snapshot = addTaskToSnapshot(createEmptyTaskBusSnapshot(), task);

    expect(task.id).toBe("task-1");
    expect(task.sessionId).toBe("session-old");
    expect(task.title).toBe("帮我总结一下今天 的会议纪要，并列出后续行动项和每个负责…");
    expect(task.status).toBe("processing");
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.focusedTaskId).toBe("task-1");
    expect(snapshot.pendingNewSession).toBe(false);
  });

  it("appendChunk 累积 streamingChunks，非 pending 空焦点时可唤回任务并展示最终答案", () => {
    const first = createTaskRecord({ input: "任务一", source: "pet" }, { now: 1000, makeId: nextId(["task-1", "session-1"]) });
    const second = createTaskRecord({ input: "任务二", source: "main" }, { now: 1200, makeId: nextId(["task-2", "session-2"]) });
    let snapshot = addTaskToSnapshot(addTaskToSnapshot(createEmptyTaskBusSnapshot(), first), second);

    snapshot = focusTaskInSnapshot(snapshot, null);
    snapshot = appendChunkToSnapshot(snapshot, first.id, "第一段", 1300);
    snapshot = appendChunkToSnapshot(snapshot, first.id, "第二段", 1400);
    expect(snapshot.tasks.find((item) => item.id === first.id)?.status).toBe("answering");
    expect(snapshot.tasks.find((item) => item.id === first.id)?.lastAgentMessage).toBe("第一段第二段");
    snapshot = completeTaskInSnapshot(snapshot, first.id, "最终答案", 1500);

    const task = snapshot.tasks.find((item) => item.id === first.id);
    expect(task?.streamingChunks).toEqual(["最终答案"]);
    expect(task?.lastAgentMessage).toBe("最终答案");
    expect(task?.finishedAt).toBe(1500);
    expect(task?.status).toBe("done");
    expect(snapshot.focusedTaskId).toBe(first.id);
  });

  it("completeTask 保留当前仍聚焦的任务，避免当前结果丢失", () => {
    const task = createTaskRecord({ input: "当前任务", source: "pet" }, { now: 1000, makeId: nextId(["task-1", "session-1"]) });
    const snapshot = completeTaskInSnapshot(addTaskToSnapshot(createEmptyTaskBusSnapshot(), task), task.id, "答案", 1500);

    expect(snapshot.focusedTaskId).toBe(task.id);
    expect(snapshot.pendingNewSession).toBe(false);
  });

  it("pending 新会话输入期间，后台旧任务流式片段和完成不会抢回焦点", () => {
    const task = createTaskRecord({ input: "旧任务", source: "pet" }, { now: 1000, makeId: nextId(["task-1", "session-1"]) });
    let snapshot = startNewSessionInSnapshot(addTaskToSnapshot(createEmptyTaskBusSnapshot(), task));

    snapshot = appendChunkToSnapshot(snapshot, task.id, "工具调用中", 1200);
    expect(snapshot.focusedTaskId).toBeNull();
    expect(snapshot.pendingNewSession).toBe(true);

    snapshot = completeTaskInSnapshot(snapshot, task.id, "旧任务答案", 1500);
    expect(snapshot.focusedTaskId).toBeNull();
    expect(snapshot.tasks[0]?.lastAgentMessage).toBe("旧任务答案");
  });

  it("完整模式消息可把匹配的桌宠任务同步到 answering 并在结束后完成", () => {
    const task = createTaskRecord({ input: "帮我整理任务", source: "pet", sessionId: "chat-1" }, { now: 1000, makeId: nextId(["task-1"]) });
    let snapshot = addTaskToSnapshot(createEmptyTaskBusSnapshot(), task);

    snapshot = syncAgentConversationToSnapshot(snapshot, {
      sessionIds: ["websocket:chat-1"],
      isRunning: true,
      now: 1300,
      messages: [
        { role: "user", content: "帮我整理任务" },
        { role: "assistant", content: "正在整理", isStreaming: true }
      ]
    });

    expect(snapshot.tasks[0]?.status).toBe("answering");
    expect(snapshot.tasks[0]?.lastAgentMessage).toBe("正在整理");
    expect(snapshot.tasks[0]?.finishedAt).toBeUndefined();

    snapshot = syncAgentConversationToSnapshot(snapshot, {
      sessionIds: ["chat-1"],
      isRunning: false,
      now: 1600,
      messages: [
        { role: "user", content: "帮我整理任务" },
        { role: "assistant", content: "整理完成" }
      ]
    });

    expect(snapshot.tasks[0]?.status).toBe("done");
    expect(snapshot.tasks[0]?.lastAgentMessage).toBe("整理完成");
    expect(snapshot.tasks[0]?.finishedAt).toBe(1600);
  });

  it("完整模式运行已结束时忽略 assistant 残留 streaming 标记并完成任务", () => {
    const task = createTaskRecord({ input: "帮我整理任务", source: "pet", sessionId: "chat-1" }, { now: 1000, makeId: nextId(["task-1"]) });
    const snapshot = syncAgentConversationToSnapshot(addTaskToSnapshot(createEmptyTaskBusSnapshot(), task), {
      sessionIds: ["chat-1"],
      isRunning: false,
      now: 1500,
      messages: [
        { role: "user", content: "帮我整理任务" },
        { role: "assistant", content: "整理完成", isStreaming: true }
      ]
    });

    expect(snapshot.tasks[0]?.status).toBe("done");
    expect(snapshot.tasks[0]?.lastAgentMessage).toBe("整理完成");
    expect(snapshot.tasks[0]?.finishedAt).toBe(1500);
  });

  it("完整模式消息不会把旧 query 串到后续 query 的 answer", () => {
    const oldTask = createTaskRecord({ input: "旧问题", source: "pet", sessionId: "chat-1" }, { now: 1000, makeId: nextId(["task-old"]) });
    const snapshot = syncAgentConversationToSnapshot(addTaskToSnapshot(createEmptyTaskBusSnapshot(), oldTask), {
      sessionIds: ["chat-1"],
      isRunning: false,
      now: 2500,
      makeId: nextId(["task-new"]),
      messages: [
        { role: "user", content: "旧问题", createdAt: 1000 },
        { role: "assistant", content: "旧答案", createdAt: 1100 },
        { role: "user", content: "新问题", createdAt: 2000 },
        { role: "assistant", content: "新答案", createdAt: 2100 }
      ]
    });

    const oldSyncedTask = snapshot.tasks.find((item) => item.id === oldTask.id);
    const latestTask = snapshot.tasks.find((item) => item.id === "task-new");
    expect(oldSyncedTask?.lastUserMessage).toBe("旧问题");
    expect(oldSyncedTask?.lastAgentMessage).toBe("旧答案");
    expect(latestTask?.lastUserMessage).toBe("新问题");
    expect(latestTask?.lastAgentMessage).toBe("新答案");
    expect(snapshot.focusedTaskId).toBe("task-new");
  });

  it("完整模式最新 query/answer 可 upsert 成桌宠焦点任务", () => {
    const oldTask = createTaskRecord({ input: "旧问题", source: "pet", sessionId: "chat-1" }, { now: 1000, makeId: nextId(["task-old"]) });
    const snapshot = syncAgentConversationToSnapshot(addTaskToSnapshot(createEmptyTaskBusSnapshot(), oldTask), {
      sessionIds: ["websocket:chat-1"],
      isRunning: false,
      now: 2600,
      makeId: nextId(["task-latest"]),
      messages: [
        { role: "user", content: "最新问题", createdAt: 2000 },
        { role: "assistant", content: "最新回答", createdAt: 2500 }
      ]
    });

    expect(snapshot.focusedTaskId).toBe("task-latest");
    expect(snapshot.tasks[0]).toMatchObject({
      id: "task-latest",
      sessionId: "chat-1",
      source: "main",
      title: "最新问题",
      status: "done",
      lastUserMessage: "最新问题",
      lastAgentMessage: "最新回答",
      finishedAt: 2600
    });
  });

  it("后台会话同步完成结果时可保持当前焦点不被抢走", () => {
    const backgroundTask = createTaskRecord({ input: "后台任务", source: "pet", sessionId: "chat-bg" }, { now: 1000, makeId: nextId(["task-bg"]) });
    const focusedTask = createTaskRecord({ input: "当前任务", source: "pet", sessionId: "chat-current" }, { now: 1200, makeId: nextId(["task-current"]) });
    const focusedSnapshot = focusTaskInSnapshot(addTaskToSnapshot(addTaskToSnapshot(createEmptyTaskBusSnapshot(), backgroundTask), focusedTask), focusedTask.id);
    const snapshot = syncAgentConversationToSnapshot(focusedSnapshot, {
      sessionIds: ["websocket:chat-bg"],
      isRunning: false,
      preserveFocus: true,
      now: 2000,
      messages: [
        { role: "user", content: "后台任务", createdAt: 1000 },
        { role: "assistant", content: "后台答案", createdAt: 1900 }
      ]
    });

    expect(snapshot.focusedTaskId).toBe(focusedTask.id);
    expect(snapshot.tasks.find((item) => item.id === backgroundTask.id)).toMatchObject({
      status: "done",
      lastAgentMessage: "后台答案",
      finishedAt: 2000
    });
  });

  it("完整模式任务列表可把已结束 session 的桌宠运行态收敛为 done", () => {
    const task = createTaskRecord({ input: "2027年呢", source: "pet", sessionId: "chat-1" }, { now: 1000, makeId: nextId(["task-1"]) });
    let snapshot = appendChunkToSnapshot(addTaskToSnapshot(createEmptyTaskBusSnapshot(), task), task.id, "端午节是6月9日", 1200);

    snapshot = syncAgentTaskStatusesToSnapshot(snapshot, {
      now: 1500,
      tasks: [{ sessionIds: ["websocket:chat-1"], isRunning: false }]
    });

    expect(snapshot.tasks[0]?.status).toBe("done");
    expect(snapshot.tasks[0]?.lastAgentMessage).toBe("端午节是6月9日");
    expect(snapshot.tasks[0]?.finishedAt).toBe(1500);
  });

  it("完整模式任务列表只把同 session 最新代表任务推进为 running", () => {
    const older = createTaskRecord({ input: "旧问题", source: "pet", sessionId: "chat-1" }, { now: 1000, makeId: nextId(["task-old"]) });
    const latest = createTaskRecord({ input: "新问题", source: "pet", sessionId: "websocket:chat-1" }, { now: 2000, makeId: nextId(["task-new"]) });
    let snapshot = addTaskToSnapshot(addTaskToSnapshot(createEmptyTaskBusSnapshot(), older), latest);
    snapshot = completeTaskInSnapshot(snapshot, older.id, "旧答案", 1100);
    snapshot = completeTaskInSnapshot(snapshot, latest.id, "新答案", 2100);

    snapshot = syncAgentTaskStatusesToSnapshot(snapshot, {
      now: 2500,
      tasks: [{ sessionIds: ["chat-1"], isRunning: true }]
    });

    expect(snapshot.tasks.find((item) => item.id === older.id)?.status).toBe("done");
    expect(snapshot.tasks.find((item) => item.id === latest.id)?.status).toBe("processing");
    expect(snapshot.tasks.find((item) => item.id === latest.id)?.finishedAt).toBeUndefined();
  });

  it("startNewSession 清焦点并置位，下一次创建任务后由调用方清掉 pendingNewSession", () => {
    const task = createTaskRecord({ input: "旧任务", source: "pet" }, { now: 1000, makeId: nextId(["task-1", "session-1"]) });
    const snapshot = startNewSessionInSnapshot(addTaskToSnapshot(createEmptyTaskBusSnapshot(), task));

    expect(snapshot.focusedTaskId).toBeNull();
    expect(snapshot.pendingNewSession).toBe(true);
  });

  it("focusTask 显式切回任务时取消 pending 新会话并恢复结果回看", () => {
    const task = createTaskRecord({ input: "旧任务", source: "pet" }, { now: 1000, makeId: nextId(["task-1", "session-1"]) });
    const dismissed = dismissTaskInSnapshot(completeTaskInSnapshot(addTaskToSnapshot(createEmptyTaskBusSnapshot(), task), task.id, "答案", 1100), task.id);
    const pending = startNewSessionInSnapshot(dismissed);
    const snapshot = focusTaskInSnapshot(pending, task.id);

    expect(snapshot.focusedTaskId).toBe(task.id);
    expect(snapshot.pendingNewSession).toBe(false);
    expect(snapshot.tasks[0]?.dismissed).toBe(false);
  });

  it("markTaskRead 只标记完成通知已读，不改变焦点和气泡展开状态", () => {
    const task = createTaskRecord({ input: "旧任务", source: "pet" }, { now: 1000, makeId: nextId(["task-1", "session-1"]) });
    const done = completeTaskInSnapshot(addTaskToSnapshot(createEmptyTaskBusSnapshot(), task), task.id, "答案", 1100);
    const snapshot = markTaskReadInSnapshot(done, task.id, 1200);

    expect(snapshot.focusedTaskId).toBe(task.id);
    expect(snapshot.tasks[0]?.dismissed).toBeUndefined();
    expect(snapshot.tasks[0]?.readAt).toBe(1200);
  });

  it("dismissTask 只关闭桌宠 answering 气泡，不删除任务历史", () => {
    const task = createTaskRecord({ input: "旧任务", source: "pet" }, { now: 1000, makeId: nextId(["task-1", "session-1"]) });
    const done = completeTaskInSnapshot(addTaskToSnapshot(createEmptyTaskBusSnapshot(), task), task.id, "答案", 1100);
    const snapshot = dismissTaskInSnapshot(done, task.id);

    expect(snapshot.tasks).toHaveLength(1);
    const dismissedTask = snapshot.tasks[0];
    expect(dismissedTask).toBeDefined();
    expect(dismissedTask?.dismissed).toBe(true);
    expect(snapshot.focusedTaskId).toBeNull();
  });

  it("removeTasksBySessionIds 删除已被完整模式移除的会话任务并清理焦点", () => {
    const deletedTask = createTaskRecord({ input: "删除的桌宠任务", source: "pet", sessionId: "chat-1" }, { now: 1000, makeId: nextId(["task-1"]) });
    const keptTask = createTaskRecord({ input: "保留的桌宠任务", source: "pet", sessionId: "chat-2" }, { now: 1200, makeId: nextId(["task-2"]) });
    let snapshot = addTaskToSnapshot(addTaskToSnapshot(createEmptyTaskBusSnapshot(), keptTask), deletedTask);

    snapshot = focusTaskInSnapshot(snapshot, deletedTask.id);
    snapshot = removeTasksBySessionIdsInSnapshot(snapshot, ["websocket:chat-1"]);

    expect(snapshot.tasks.map((task) => task.sessionId)).toEqual(["chat-2"]);
    expect(snapshot.focusedTaskId).toBeNull();
    expect(snapshot.pendingNewSession).toBe(false);
  });

  it("localStorage 持久化恢复任务、焦点和新会话旗标，但不落盘 streamingChunks", () => {
    const storage = new MemoryStorage();
    const task = createTaskRecord({ input: "持久化任务", source: "pet" }, { now: 1000, makeId: nextId(["task-1", "session-1"]) });
    const snapshot: TaskBusSnapshot = {
      ...appendChunkToSnapshot(addTaskToSnapshot(createEmptyTaskBusSnapshot(), task), task.id, "临时片段", 1100),
      pendingNewSession: true
    };

    saveTaskBusSnapshot(storage, snapshot);
    const restored = loadTaskBusSnapshot(storage);

    expect(restored.tasks).toHaveLength(1);
    const restoredTask = restored.tasks[0];
    expect(restoredTask).toBeDefined();
    expect(restoredTask?.id).toBe("task-1");
    expect(restoredTask?.streamingChunks).toBeUndefined();
    expect(restored.focusedTaskId).toBe("task-1");
    expect(restored.pendingNewSession).toBe(true);
  });
});

function nextId(ids: string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? `id-${index}`;
}

/**
 * In-memory Storage implementation.
 *
 * Field meanings:
 * - data: The key-value table that simulates the browser localStorage.
 */
class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}
