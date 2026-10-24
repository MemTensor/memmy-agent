import { describe, expect, it } from "vitest";
import {
  TASK_BUS_STORAGE_KEY,
  addTaskToSnapshot,
  appendChunkToSnapshot,
  bindTaskGoalInSnapshot,
  completeTaskInSnapshot,
  createEmptyTaskBusSnapshot,
  createTaskRecord,
  dismissTaskInSnapshot,
  errorTaskInSnapshot,
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
    expect(snapshot.tasks[0]?.unseen).toBe(true);
  });

  it("侧边栏未读点按 session 同步，已读会话里的多条任务都不再计为未读", () => {
    const older = createTaskRecord({ input: "旧问题", source: "main", sessionId: "chat-1" }, { now: 1000, makeId: nextId(["task-old"]) });
    const latest = createTaskRecord({ input: "新问题", source: "main", sessionId: "websocket:chat-1" }, { now: 2000, makeId: nextId(["task-new"]) });
    const other = createTaskRecord({ input: "另一个会话", source: "main", sessionId: "chat-2" }, { now: 3000, makeId: nextId(["task-other"]) });
    let snapshot = addTaskToSnapshot(addTaskToSnapshot(addTaskToSnapshot(createEmptyTaskBusSnapshot(), other), latest), older);
    snapshot = completeTaskInSnapshot(snapshot, older.id, "旧答案", 1100);
    snapshot = completeTaskInSnapshot(snapshot, latest.id, "新答案", 2100);
    snapshot = completeTaskInSnapshot(snapshot, other.id, "其他答案", 3100);

    snapshot = syncAgentTaskStatusesToSnapshot(snapshot, {
      now: 4000,
      tasks: [
        { sessionIds: ["chat-1", "websocket:chat-1"], isRunning: false, completedUnseen: false },
        { sessionIds: ["chat-2"], isRunning: false, completedUnseen: true }
      ]
    });

    expect(snapshot.tasks.find((item) => item.id === older.id)).toMatchObject({ unseen: false, readAt: 4000 });
    expect(snapshot.tasks.find((item) => item.id === latest.id)).toMatchObject({ unseen: false, readAt: 4000 });
    expect(snapshot.tasks.find((item) => item.id === other.id)?.unseen).toBe(true);
    expect(snapshot.tasks.find((item) => item.id === other.id)?.readAt).toBeUndefined();

    const acknowledged = markTaskReadInSnapshot(snapshot, other.id, 5000);
    const resurfaced = syncAgentTaskStatusesToSnapshot(acknowledged, {
      now: 6000,
      tasks: [{ sessionIds: ["chat-2"], isRunning: false, completedUnseen: true }]
    });
    expect(resurfaced.tasks.find((item) => item.id === other.id)).toMatchObject({ unseen: false, readAt: 5000 });
  });

  it("已读会话的历史消息首次同步时原子应用侧边栏未读状态", () => {
    const snapshot = syncAgentConversationToSnapshot(createEmptyTaskBusSnapshot(), {
      sessionIds: ["chat-1"],
      isRunning: false,
      completedUnseen: false,
      now: 2000,
      makeId: nextId(["task-history"]),
      messages: [
        { role: "user", content: "历史问题", createdAt: 1000 },
        { role: "assistant", content: "已看过的答案", createdAt: 1500 }
      ]
    });

    expect(snapshot.tasks[0]).toMatchObject({ status: "done", unseen: false, readAt: 2000 });
  });

  it("新完成回合保持未读，但重复同步不会重新标记同回合的桌宠已读通知", () => {
    const input = {
      sessionIds: ["chat-1"],
      isRunning: false,
      completedUnseen: true,
      now: 2000,
      makeId: nextId(["task-unread"]),
      messages: [
        { role: "user", content: "后台问题", createdAt: 1000 },
        { role: "assistant", content: "后台答案", createdAt: 1500 }
      ]
    };
    const unread = syncAgentConversationToSnapshot(createEmptyTaskBusSnapshot(), input);
    expect(unread.tasks[0]).toMatchObject({ unseen: true });
    const read = markTaskReadInSnapshot(unread, "task-unread", 2500);
    const repeated = syncAgentConversationToSnapshot(read, { ...input, now: 3000 });

    expect(repeated.tasks[0]).toMatchObject({ unseen: false, readAt: 2500 });
  });

  it("一分钟内相同输入的新回合不会复用已读桌宠回合", () => {
    const oldTask = createTaskRecord({ input: "重复问题", source: "pet", sessionId: "chat-1" }, { now: 1000, makeId: nextId(["task-old"]) });
    const read = markTaskReadInSnapshot(completeTaskInSnapshot(addTaskToSnapshot(createEmptyTaskBusSnapshot(), oldTask), oldTask.id, "第一次答案", 2000), oldTask.id, 2500);
    const snapshot = syncAgentConversationToSnapshot(read, {
      sessionIds: ["websocket:chat-1"],
      isRunning: false,
      completedUnseen: true,
      now: 12000,
      makeId: nextId(["task-new"]),
      messages: [
        { role: "user", content: "重复问题", createdAt: 10000 },
        { role: "assistant", content: "第二次答案", createdAt: 11000 }
      ]
    });

    expect(snapshot.tasks).toHaveLength(2);
    expect(snapshot.tasks.find((item) => item.id === "task-old")).toMatchObject({ lastAgentMessage: "第一次答案", unseen: false, readAt: 2500 });
    expect(snapshot.tasks.find((item) => item.id === "task-new")).toMatchObject({ lastAgentMessage: "第二次答案", unseen: true });
  });

  it("历史回合同步不推进完成时间，随后相同输入的新回合保持独立未读", () => {
    const oldTask = createTaskRecord({ input: "重复问题", source: "pet", sessionId: "chat-1" }, { now: 1000, makeId: nextId(["task-old"]) });
    let snapshot = markTaskReadInSnapshot(completeTaskInSnapshot(addTaskToSnapshot(createEmptyTaskBusSnapshot(), oldTask), oldTask.id, "第一次答案", 2000), oldTask.id, 2500);
    snapshot = syncAgentConversationToSnapshot(snapshot, {
      sessionIds: ["chat-1"],
      isRunning: false,
      now: 10000,
      messages: [
        { role: "user", content: "重复问题", createdAt: 1100 },
        { role: "assistant", content: "第一次答案", createdAt: 1500 }
      ]
    });
    expect(snapshot.tasks[0]?.finishedAt).toBe(2000);
    snapshot = syncAgentConversationToSnapshot(snapshot, {
      sessionIds: ["chat-1"],
      isRunning: false,
      completedUnseen: true,
      now: 11000,
      makeId: nextId(["task-new"]),
      messages: [
        { role: "user", content: "重复问题", createdAt: 9000 },
        { role: "assistant", content: "第二次答案", createdAt: 10500 }
      ]
    });

    expect(snapshot.tasks).toHaveLength(2);
    expect(snapshot.tasks.find((item) => item.id === "task-old")).toMatchObject({ lastAgentMessage: "第一次答案", unseen: false, readAt: 2500 });
    expect(snapshot.tasks.find((item) => item.id === "task-new")).toMatchObject({ lastAgentMessage: "第二次答案", unseen: true });
  });

  it("已关联的桌宠回合在重启后也不会复用完成前排队的同文新回合", () => {
    const oldTask = createTaskRecord({ input: "重复问题", source: "pet", sessionId: "chat-1" }, { now: 1000, makeId: nextId(["task-old"]) });
    let snapshot = markTaskReadInSnapshot(completeTaskInSnapshot(addTaskToSnapshot(createEmptyTaskBusSnapshot(), oldTask), oldTask.id, "第一次答案", 10000), oldTask.id, 10500);
    snapshot = syncAgentConversationToSnapshot(snapshot, {
      sessionIds: ["chat-1"],
      isRunning: false,
      now: 11000,
      messages: [
        { role: "user", content: "重复问题", createdAt: 1100 },
        { role: "assistant", content: "第一次答案", createdAt: 5000 }
      ]
    });
    const storage = new MemoryStorage();
    saveTaskBusSnapshot(storage, snapshot);
    snapshot = loadTaskBusSnapshot(storage);
    snapshot = syncAgentConversationToSnapshot(snapshot, {
      sessionIds: ["chat-1"],
      isRunning: false,
      completedUnseen: true,
      now: 12500,
      makeId: nextId(["task-new"]),
      messages: [
        { role: "user", content: "重复问题", createdAt: 9000 },
        { role: "assistant", content: "第二次答案", createdAt: 12000 }
      ]
    });

    expect(snapshot.tasks).toHaveLength(2);
    expect(snapshot.tasks.find((item) => item.id === "task-old")).toMatchObject({ lastAgentMessage: "第一次答案", unseen: false, finishedAt: 10000 });
    expect(snapshot.tasks.find((item) => item.id === "task-new")).toMatchObject({ lastAgentMessage: "第二次答案", unseen: true });
  });

  it("已关联的运行中桌宠回合只获取对应 user 时间戳的答案", () => {
    const task = createTaskRecord({ input: "重复问题", source: "pet", sessionId: "chat-1" }, { now: 1000, makeId: nextId(["task-old"]) });
    let snapshot = syncAgentConversationToSnapshot(addTaskToSnapshot(createEmptyTaskBusSnapshot(), task), {
      sessionIds: ["chat-1"],
      isRunning: true,
      now: 2000,
      messages: [
        { role: "user", content: "重复问题", createdAt: 1100 },
        { role: "assistant", content: "第一次答案", createdAt: 1500 }
      ]
    });
    snapshot = syncAgentConversationToSnapshot(snapshot, {
      sessionIds: ["chat-1"],
      isRunning: false,
      now: 3000,
      makeId: nextId(["task-new"]),
      messages: [
        { role: "user", content: "重复问题", createdAt: 1100 },
        { role: "assistant", content: "第一次答案", createdAt: 1500 },
        { role: "user", content: "重复问题", createdAt: 1900 },
        { role: "assistant", content: "第二次答案", createdAt: 2500 }
      ]
    });

    expect(snapshot.tasks.find((item) => item.id === "task-old")?.lastAgentMessage).toBe("第一次答案");
    expect(snapshot.tasks.find((item) => item.id === "task-new")?.lastAgentMessage).toBe("第二次答案");
  });

  it("重复同步已收起的完成回合不会重新展开气泡或恢复未读", () => {
    const task = createTaskRecord({ input: "完成问题", source: "pet", sessionId: "chat-1" }, { now: 1000, makeId: nextId(["task-1"]) });
    const dismissed = dismissTaskInSnapshot(completeTaskInSnapshot(addTaskToSnapshot(createEmptyTaskBusSnapshot(), task), task.id, "完成答案", 2000), task.id, 2500);
    const snapshot = syncAgentConversationToSnapshot(dismissed, {
      sessionIds: ["chat-1"],
      isRunning: false,
      completedUnseen: true,
      now: 3000,
      messages: [
        { role: "user", content: "完成问题", createdAt: 1100 },
        { role: "assistant", content: "完成答案", createdAt: 1500 }
      ]
    });

    expect(snapshot.tasks[0]).toMatchObject({ dismissed: true, unseen: false, readAt: 2500 });
  });

  it.each(["done", "error"] as const)("%s 重复完成回调不会恢复同一结果的已读通知，更新结果仍可通知", (status) => {
    const finish = status === "done" ? completeTaskInSnapshot : errorTaskInSnapshot;
    const task = createTaskRecord({ input: "任务问题", source: "pet", sessionId: "chat-1" }, { now: 1000, makeId: nextId(["task-1"]) });
    const done = finish(addTaskToSnapshot(createEmptyTaskBusSnapshot(), task), task.id, "结果一", 2000);
    const read = markTaskReadInSnapshot(done, task.id, 2500);
    const repeated = finish(read, task.id, "结果一", 3000);

    expect(repeated).toBe(read);
    expect(repeated.tasks[0]).toMatchObject({ status, unseen: false, readAt: 2500, finishedAt: 2000 });
    expect(finish(repeated, task.id, "结果二", 3500).tasks[0]).toMatchObject({ status, unseen: true, readAt: undefined, lastAgentMessage: "结果二", finishedAt: 3500 });
  });

  it.each(["read", "dismiss"] as const)("%s 完成回合时按会话确认所有完成通知，并保留其他会话和运行中回合", (action) => {
    const older = createTaskRecord({ input: "旧问题", source: "pet", sessionId: "chat-1" }, { now: 1000, makeId: nextId(["task-old"]) });
    const latest = createTaskRecord({ input: "新问题", source: "pet", sessionId: "websocket:chat-1" }, { now: 2000, makeId: nextId(["task-new"]) });
    const other = createTaskRecord({ input: "另一个会话", source: "pet", sessionId: "chat-2" }, { now: 3000, makeId: nextId(["task-other"]) });
    const running = createTaskRecord({ input: "运行中问题", source: "pet", sessionId: "chat-1" }, { now: 4000, makeId: nextId(["task-running"]) });
    let snapshot = addTaskToSnapshot(addTaskToSnapshot(addTaskToSnapshot(addTaskToSnapshot(createEmptyTaskBusSnapshot(), older), latest), other), running);
    snapshot = completeTaskInSnapshot(snapshot, older.id, "旧答案", 1500);
    snapshot = completeTaskInSnapshot(snapshot, latest.id, "新答案", 2500);
    snapshot = completeTaskInSnapshot(snapshot, other.id, "其他答案", 3500);
    snapshot = action === "read" ? markTaskReadInSnapshot(snapshot, latest.id, 5000) : dismissTaskInSnapshot(snapshot, latest.id, 5000);

    expect(snapshot.tasks.find((item) => item.id === older.id)).toMatchObject({ unseen: false, readAt: 5000 });
    expect(snapshot.tasks.find((item) => item.id === latest.id)).toMatchObject({ unseen: false, readAt: 5000 });
    expect(snapshot.tasks.find((item) => item.id === other.id)).toMatchObject({ unseen: true });
    expect(snapshot.tasks.find((item) => item.id === running.id)).toEqual(running);
  });

  it.each(["read", "dismiss"] as const)("%s 旧完成回合不会确认同会话后来完成的新通知", (action) => {
    const older = createTaskRecord({ input: "旧问题", source: "pet", sessionId: "chat-1" }, { now: 1000, makeId: nextId(["task-old"]) });
    const latest = createTaskRecord({ input: "新问题", source: "pet", sessionId: "websocket:chat-1" }, { now: 2000, makeId: nextId(["task-new"]) });
    let snapshot = addTaskToSnapshot(addTaskToSnapshot(createEmptyTaskBusSnapshot(), older), latest);
    snapshot = completeTaskInSnapshot(snapshot, older.id, "旧答案", 1500);
    snapshot = completeTaskInSnapshot(snapshot, latest.id, "新答案", 2500);
    const newerCompleted = snapshot.tasks.find((item) => item.id === latest.id);
    snapshot = action === "read" ? markTaskReadInSnapshot(snapshot, older.id, 3000) : dismissTaskInSnapshot(snapshot, older.id, 3000);

    expect(snapshot.tasks.find((item) => item.id === older.id)).toMatchObject({ unseen: false, readAt: 3000 });
    expect(snapshot.tasks.find((item) => item.id === latest.id)).toEqual(newerCompleted);
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

  it("旧回合迟到的完成时间不会抢走同 session 新回合的 running 状态", () => {
    const older = createTaskRecord({ input: "旧问题", source: "pet", sessionId: "chat-1" }, { now: 1000, makeId: nextId(["task-old"]) });
    const latest = createTaskRecord({ input: "新问题", source: "pet", sessionId: "websocket:chat-1" }, { now: 2000, makeId: nextId(["task-new"]) });
    let snapshot = addTaskToSnapshot(addTaskToSnapshot(createEmptyTaskBusSnapshot(), older), latest);
    snapshot = completeTaskInSnapshot(snapshot, latest.id, "新答案", 2500);
    snapshot = completeTaskInSnapshot(snapshot, older.id, "迟到的旧答案", 8000);
    snapshot = syncAgentTaskStatusesToSnapshot(snapshot, {
      now: 9000,
      tasks: [{ sessionIds: ["chat-1"], isRunning: true }]
    });

    expect(snapshot.tasks.find((item) => item.id === older.id)).toMatchObject({ status: "done", finishedAt: 8000 });
    const running = snapshot.tasks.find((item) => item.id === latest.id);
    expect(running?.status).toBe("processing");
    expect(running?.finishedAt).toBeUndefined();
    expect(running?.unseen).toBeUndefined();
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
    expect(snapshot.tasks[0]?.unseen).toBe(false);
  });

  it("dismissTask 只关闭桌宠 answering 气泡，不删除任务历史", () => {
    const task = createTaskRecord({ input: "旧任务", source: "pet" }, { now: 1000, makeId: nextId(["task-1", "session-1"]) });
    const done = completeTaskInSnapshot(addTaskToSnapshot(createEmptyTaskBusSnapshot(), task), task.id, "答案", 1100);
    const snapshot = dismissTaskInSnapshot(done, task.id);

    expect(snapshot.tasks).toHaveLength(1);
    const dismissedTask = snapshot.tasks[0];
    expect(dismissedTask).toBeDefined();
    expect(dismissedTask?.dismissed).toBe(true);
    expect(dismissedTask?.unseen).toBe(false);
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

  it("Goal identity 只首次绑定运行中的 Task，旧 Task 不会被后续 Goal 接管", () => {
    const task = createTaskRecord({ input: "持续任务", source: "pet" }, { now: 1000, makeId: nextId(["task-1", "session-1"]) });
    const initial = addTaskToSnapshot(createEmptyTaskBusSnapshot(), task);
    const bound = bindTaskGoalInSnapshot(initial, task.id, " goal-1 ");
    const rebound = bindTaskGoalInSnapshot(bound, task.id, "goal-2");
    const completed = completeTaskInSnapshot(bound, task.id, "完成", 1200);

    expect(bound.tasks[0]?.goalId).toBe("goal-1");
    expect(rebound).toBe(bound);
    expect(bindTaskGoalInSnapshot(completed, task.id, "goal-2")).toBe(completed);
    expect(bindTaskGoalInSnapshot(initial, task.id, "   ")).toBe(initial);
  });

  it("localStorage 保留合法 goalId，并兼容没有 goalId 的历史 Task", () => {
    const storage = new MemoryStorage();
    const task = createTaskRecord({ input: "持久 Goal", source: "pet" }, { now: 1000, makeId: nextId(["task-1", "session-1"]) });
    const bound = bindTaskGoalInSnapshot(addTaskToSnapshot(createEmptyTaskBusSnapshot(), task), task.id, "goal-1");

    saveTaskBusSnapshot(storage, bound);
    expect(loadTaskBusSnapshot(storage).tasks[0]?.goalId).toBe("goal-1");

    const legacyTask = { ...task } as Record<string, unknown>;
    delete legacyTask.goalId;
    storage.setItem(TASK_BUS_STORAGE_KEY, JSON.stringify({ tasks: [legacyTask], focusedTaskId: task.id, pendingNewSession: false }));
    const restoredLegacyTask = loadTaskBusSnapshot(storage).tasks[0];
    expect(restoredLegacyTask?.id).toBe(task.id);
    expect(restoredLegacyTask?.goalId).toBeUndefined();
  });

  it("localStorage 丢弃 goalId 为空或类型错误的 Task", () => {
    const storage = new MemoryStorage();
    const task = createTaskRecord({ input: "坏数据", source: "pet" }, { now: 1000, makeId: nextId(["task-1", "session-1"]) });

    for (const goalId of ["", "   ", 42]) {
      storage.setItem(TASK_BUS_STORAGE_KEY, JSON.stringify({
        tasks: [{ ...task, goalId }],
        focusedTaskId: task.id,
        pendingNewSession: false
      }));
      expect(loadTaskBusSnapshot(storage)).toEqual(createEmptyTaskBusSnapshot());
    }
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
