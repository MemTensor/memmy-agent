import { describe, expect, it } from "vitest";
import { countUnreadPetSessions } from "../../pages/pet-page.js";
import { addTaskToSnapshot, completeTaskInSnapshot, createEmptyTaskBusSnapshot, createTaskRecord,
  markTaskReadInSnapshot, syncAgentConversationToSnapshot, syncAgentTaskStatusesToSnapshot } from "../task-bus.js";

describe("scheduled delivery unread epochs", () => {
  it("keeps a main-window-read delivery read when its pet-window copy arrives later, and reopens for a newer delivery", () => {
    const task = createTaskRecord({ input: "检查消息", source: "main", sessionId: "chat-1" }, { now: 1_000, makeId: () => "one" });
    let snapshot = completeTaskInSnapshot(addTaskToSnapshot(createEmptyTaskBusSnapshot(), task), task.id, "已设置", 2_000);
    snapshot = markTaskReadInSnapshot(snapshot, task.id, 3_000);
    // Main sees the new result in its focused chat and classifies it as read.
    snapshot = syncAgentTaskStatusesToSnapshot(snapshot, { now: 4_100,
      tasks: [{ sessionIds: ["chat-1"], isRunning: false, completedUnseen: false, proactiveUnseenAt: 4_000 }] });
    expect(snapshot.tasks[0]?.readAt).toBe(4_100);
    // Pet receives the same delivery two seconds later; its epoch stays 4_000.
    snapshot = syncAgentTaskStatusesToSnapshot(snapshot, { now: 6_000,
      tasks: [{ sessionIds: ["chat-1"], isRunning: false, completedUnseen: true, proactiveUnseenAt: 4_000 }] });
    expect(countUnreadPetSessions(snapshot.tasks)).toBe(0);
    snapshot = syncAgentTaskStatusesToSnapshot(snapshot, { now: 9_000,
      tasks: [{ sessionIds: ["chat-1"], isRunning: false, completedUnseen: true, proactiveUnseenAt: 7_000 }] });
    expect(countUnreadPetSessions(snapshot.tasks)).toBe(1);
  });

  it("reopens a read session for each newer live delivery, keeps one badge, and ignores stale/ordinary status repeats", () => {
    const first = createTaskRecord({ input: "旧请求", source: "pet", sessionId: "chat-1" }, { now: 1_000, makeId: () => "one" });
    const second = createTaskRecord({ input: "新请求", source: "main", sessionId: "websocket:chat-1" }, { now: 2_000, makeId: () => "two" });
    let snapshot = addTaskToSnapshot(addTaskToSnapshot(createEmptyTaskBusSnapshot(), first), second);
    snapshot = completeTaskInSnapshot(snapshot, first.id, "旧回答", 1_500);
    snapshot = completeTaskInSnapshot(snapshot, second.id, "新回答", 2_500);
    snapshot = markTaskReadInSnapshot(snapshot, second.id, 3_000);
    const sync = (proactiveUnseenAt?: number) => { snapshot = syncAgentTaskStatusesToSnapshot(snapshot, { now: 10_000,
      tasks: [{ sessionIds: ["chat-1", "websocket:chat-1"], isRunning: false, completedUnseen: true, proactiveUnseenAt }] }); };
    sync(4_000);
    expect(countUnreadPetSessions(snapshot.tasks)).toBe(1);
    expect(snapshot.tasks.find((task) => task.id === second.id)).toMatchObject({ status: "done", finishedAt: 2_500, proactiveUnseenAt: 4_000 });
    snapshot = markTaskReadInSnapshot(snapshot, second.id, 4_500);
    sync(4_000);
    sync();
    expect(countUnreadPetSessions(snapshot.tasks)).toBe(0);
    sync(5_000);
    expect(countUnreadPetSessions(snapshot.tasks)).toBe(1);
    snapshot = markTaskReadInSnapshot(snapshot, second.id, 6_000);
    sync(4_000);
    expect(countUnreadPetSessions(snapshot.tasks)).toBe(0);
    expect(snapshot.tasks.find((task) => task.id === second.id)?.readAt).toBe(6_000);
  });

  it("applies the live epoch through conversation synchronization without making a second task", () => {
    const task = createTaskRecord({ input: "检查消息", source: "main", sessionId: "chat-1" }, { now: 1_000, makeId: () => "one" });
    let snapshot = completeTaskInSnapshot(addTaskToSnapshot(createEmptyTaskBusSnapshot(), task), task.id, "已设置", 2_000);
    snapshot = markTaskReadInSnapshot(snapshot, task.id, 3_000);
    snapshot = syncAgentConversationToSnapshot(snapshot, { now: 4_000, sessionIds: ["chat-1"], isRunning: false,
      completedUnseen: true, proactiveUnseenAt: 4_000, preserveFocus: true,
      messages: [{ role: "user", content: "检查消息", createdAt: 1_000 }, { role: "assistant", content: "暂无微信新消息", createdAt: 4_000 }],
    });
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({ lastAgentMessage: "暂无微信新消息", unseen: true, proactiveUnseenAt: 4_000 });
    expect(countUnreadPetSessions(snapshot.tasks)).toBe(1);
  });
});
