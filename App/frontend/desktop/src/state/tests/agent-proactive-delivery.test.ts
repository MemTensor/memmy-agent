import { describe, expect, it, vi } from "vitest";
import type { MemmyAgentWsEvent } from "../../api/memmy-agent-client.js";
import { agentReducer, initialAgentState } from "../agent-chat-slice.js";

function setup() {
  const sessions = ["chat-1", "chat-2"].map((id) => ({
    key: `websocket:${id}`, title: id, preview: "", updatedAt: "2026-10-12T12:00:00.000Z", projectId: null, cwd: null,
  }));
  let state = agentReducer(initialAgentState, { type: "agent/sessionsLoaded", sessions });
  state = agentReducer(state, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
  return agentReducer(state, { type: "agent/chatViewVisibilityChanged", visible: true });
}

function delivery(id = "delivery-1", chatId = "chat-2", replayed = false): MemmyAgentWsEvent {
  return { event: "message", chat_id: chatId, text: "暂无微信新消息", metadata: {
    proactiveDelivery: "cron", deliveryId: id, cronJobId: "job-1", scheduledForMs: 1_000,
    client_request_id: "old-request", ...(replayed ? { replayed: true } : {}),
  } };
}

describe("scheduled proactive deliveries", () => {
  it("keeps task-name snapshots and gateway timestamps in live, replayed and historical messages", () => {
    const event = delivery("named");
    event.metadata!.cronJobName = " 微信新消息\n监测 ";
    event.metadata!.deliveredAtMs = 4_000;
    const live = agentReducer(setup(), { type: "agent/wsEvent", event });
    expect(live.messagesByChatId["chat-2"]?.[0]).toMatchObject({
      proactiveTaskName: "微信新消息 监测", createdAt: 4_000,
    });
    const replay = agentReducer(setup(), { type: "agent/wsEvent", event: {
      ...event, metadata: { ...event.metadata, replayed: true },
    } });
    expect(replay.messagesByChatId["chat-2"]?.[0]?.proactiveTaskName).toBe("微信新消息 监测");
    expect(replay.proactiveUnseenByChatId).toEqual({});
    let history = agentReducer(setup(), { type: "agent/historyHydrateLoading", chatId: "chat-2", sessionKey: "websocket:chat-2", requestId: "named-history" });
    history = agentReducer(history, { type: "agent/historyHydrateLoaded", requestId: "named-history", thread: {
      schemaVersion: 1, sessionKey: "websocket:chat-2", last_turn_closed: true,
      // A later foreground turn can stamp the transcript row; the delivery time remains authoritative.
      messages: [{ role: "assistant", content: "历史提醒", createdAt: 9_000, metadata: event.metadata }],
    } });
    expect(history.messagesByChatId["chat-2"]?.[0]).toMatchObject({
      proactiveDelivery: "cron", proactiveTaskName: "微信新消息 监测", createdAt: 4_000,
    });
    expect(history.proactiveUnseenByChatId).toEqual({});
  });

  it.each([undefined, "", " \n ", 123])("keeps old or invalid task names absent for the localized renderer fallback (%s)", (name) => {
    const event = delivery();
    event.metadata!.cronJobName = name;
    const state = agentReducer(setup(), { type: "agent/wsEvent", event });
    expect(state.messagesByChatId["chat-2"]?.[0]?.proactiveTaskName).toBeUndefined();
    expect(state.tasks.find((task) => task.chatId === "chat-2")?.completedUnseen).toBe(true);
  });

  it("uses the gateway delivery time consistently across renderers with different receive times", () => {
    const event = delivery("cross-window");
    event.metadata!.deliveredAtMs = 4_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(4_100);
    const main = agentReducer(setup(), { type: "agent/wsEvent", event });
    clock.mockReturnValue(6_000);
    const pet = agentReducer(setup(), { type: "agent/wsEvent", event });
    expect(main.proactiveUnseenByChatId["chat-2"]).toBe(4_000);
    expect(pet.proactiveUnseenByChatId["chat-2"]).toBe(4_000);
    expect(pet.messagesByChatId["chat-2"]?.[0]?.createdAt).toBe(4_000);
    expect(pet.proactiveDeliveredAtByChatId["chat-2"]).toBe(4_000);
    clock.mockRestore();
  });

  it("updates a never-opened background chat and produces an independent unread/notification signal", () => {
    const state = agentReducer(setup(), { type: "agent/wsEvent", event: delivery() });
    expect(state.currentChatId).toBe("chat-1");
    expect(state.messages).toEqual([]);
    expect(state.messagesByChatId["chat-2"]?.[0]?.content).toBe("暂无微信新消息");
    expect(state.tasks.find((task) => task.chatId === "chat-2")?.completedUnseen).toBe(true);
    expect(state.proactiveNotifications).toEqual([{ deliveryId: "delivery-1", chatId: "chat-2", content: "暂无微信新消息" }]);
    expect(state.lastTaskCompletion).toBeNull();
    expect(state.completedUnseenByChatId).toEqual({});
    expect(state.runStartedAtByChatId).toEqual({});
  });

  it("deduplicates global/current-chat copies but keeps distinct results from the same scheduled run", () => {
    let state = agentReducer(setup(), { type: "agent/wsEvent", event: delivery() });
    expect(agentReducer(state, { type: "agent/wsEvent", event: delivery() })).toBe(state);
    state = agentReducer(state, { type: "agent/wsEvent", event: delivery("delivery-2") });
    expect(state.messagesByChatId["chat-2"]).toHaveLength(2);
    expect(state.proactiveNotifications.map((item) => item.deliveryId)).toEqual(["delivery-1", "delivery-2"]);
    state = agentReducer(state, { type: "agent/proactiveNotificationsAcknowledged", deliveryIds: ["delivery-1"] });
    expect(state.proactiveNotifications.map((item) => item.deliveryId)).toEqual(["delivery-2"]);
  });

  it("does not mark a visible focused chat unread and marks a hidden current chat until focus returns", () => {
    let state = agentReducer(setup(), { type: "agent/wsEvent", event: delivery("visible", "chat-1") });
    expect(state.proactiveNotifications).toEqual([]);
    expect(state.proactiveUnseenByChatId).toEqual({});
    state = agentReducer(state, { type: "agent/chatWindowFocusChanged", focused: false });
    state = agentReducer(state, { type: "agent/wsEvent", event: delivery("hidden", "chat-1") });
    expect(state.tasks.find((task) => task.chatId === "chat-1")?.completedUnseen).toBe(true);
    expect(state.proactiveNotifications.map((item) => item.deliveryId)).toEqual(["hidden"]);
    state = agentReducer(state, { type: "agent/chatWindowFocusChanged", focused: true });
    expect(state.proactiveUnseenByChatId).toEqual({});
  });

  it("preserves a foreground stream and lets its later deltas/end update the original answer", () => {
    let state = agentReducer(setup(), { type: "agent/userMessageQueued", chatId: "chat-1", content: "前台任务" });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "前半" } });
    const streamingId = state.messages.at(-1)?.id;
    state = agentReducer(state, { type: "agent/wsEvent", event: delivery("interleaved", "chat-1") });
    expect(state.isSending).toBe(true);
    expect(state.messages.find((message) => message.id === streamingId)?.isStreaming).toBe(true);
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "后半" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "stream_end", chat_id: "chat-1", text: "完整前台回答" } });
    expect(state.messages.find((message) => message.id === streamingId)?.content).toBe("完整前台回答");
    expect(state.messages.find((message) => message.proactiveDeliveryId === "interleaved")?.content).toBe("暂无微信新消息");
    expect(state.lastTaskCompletion).toBeNull();
  });

  it("does not restamp an interleaved scheduled result when the foreground turn finishes", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(4_000);
    try {
      let state = agentReducer(setup(), { type: "agent/userMessageQueued", chatId: "chat-1", content: "前台任务" });
      state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", text: "前台回答" } });
      const foregroundId = state.messages.at(-1)?.id;
      const event = delivery("during-turn", "chat-1");
      event.metadata!.cronJobName = "微信新消息监测";
      event.metadata!.deliveredAtMs = 4_000;
      state = agentReducer(state, { type: "agent/wsEvent", event });
      clock.mockReturnValue(9_000);
      state = agentReducer(state, { type: "agent/wsEvent", event: { event: "turn_end", chat_id: "chat-1" } });
      expect(state.messages.find((message) => message.proactiveDeliveryId === "during-turn")).toMatchObject({
        createdAt: 4_000, proactiveTaskName: "微信新消息监测",
      });
      expect(state.messages.find((message) => message.id === foregroundId)).toMatchObject({ createdAt: 9_000, isStreaming: false });
    } finally { clock.mockRestore(); }
  });

  it("keeps replayed results readable without notifications or unread and seeds identities from history", () => {
    let state = agentReducer(setup(), { type: "agent/wsEvent", event: delivery("replay", "chat-2", true) });
    expect(state.messagesByChatId["chat-2"]).toHaveLength(1);
    expect(state.proactiveNotifications).toEqual([]);
    expect(state.proactiveUnseenByChatId).toEqual({});
    state = agentReducer(state, { type: "agent/historyHydrateLoading", chatId: "chat-2", sessionKey: "websocket:chat-2", requestId: "history" });
    state = agentReducer(state, { type: "agent/historyHydrateLoaded", requestId: "history", thread: {
      schemaVersion: 1, sessionKey: "websocket:chat-2", last_turn_closed: true,
      messages: [{ role: "assistant", content: "旧提醒", metadata: delivery("history").metadata }],
    } });
    expect(state.messagesByChatId["chat-2"]?.[0]?.proactiveDeliveryId).toBe("history");
    expect(agentReducer(state, { type: "agent/wsEvent", event: delivery("history", "chat-2", true) })).toBe(state);
    expect(state.proactiveNotifications).toEqual([]);
  });

  it("merges a history reminder while preserving an active foreground stream", () => {
    let state = agentReducer(setup(), { type: "agent/userMessageQueued", chatId: "chat-1", content: "前台任务" });
    state = agentReducer(state, { type: "agent/wsEvent", event: { event: "delta", chat_id: "chat-1", turn_id: "active-turn", text: "前台回答" } });
    state = agentReducer(state, { type: "agent/historyHydrateLoading", chatId: "chat-1", sessionKey: "websocket:chat-1", requestId: "history" });
    state = agentReducer(state, { type: "agent/historyHydrateLoaded", requestId: "history", thread: {
      schemaVersion: 1, sessionKey: "websocket:chat-1", last_turn_closed: false,
      messages: [{ role: "assistant", content: "历史提醒", metadata: delivery("history-during-stream").metadata }],
    } });
    expect(state.messages.some((message) => message.content === "前台回答" && message.isStreaming)).toBe(true);
    expect(state.messages.filter((message) => message.proactiveDeliveryId === "history-during-stream")).toHaveLength(1);
    expect(state.proactiveNotifications).toEqual([]);
    expect(agentReducer(state, { type: "agent/wsEvent", event: delivery("history-during-stream", "chat-1", true) })).toBe(state);
  });

  it("notifies the first live arrival when its persisted history reached the client first", () => {
    let state = agentReducer(setup(), { type: "agent/historyHydrateLoading", chatId: "chat-2", sessionKey: "websocket:chat-2", requestId: "history" });
    state = agentReducer(state, { type: "agent/historyHydrateLoaded", requestId: "history", thread: {
      schemaVersion: 1, sessionKey: "websocket:chat-2", last_turn_closed: true,
      messages: [{ role: "assistant", content: "暂无微信新消息", metadata: delivery("history-first").metadata }],
    } });
    state = agentReducer(state, { type: "agent/wsEvent", event: delivery("history-first") });
    expect(state.messagesByChatId["chat-2"]).toHaveLength(1);
    expect(state.proactiveNotifications.map((item) => item.deliveryId)).toEqual(["history-first"]);
    expect(state.tasks.find((task) => task.chatId === "chat-2")?.completedUnseen).toBe(true);
    expect(agentReducer(state, { type: "agent/wsEvent", event: delivery("history-first") })).toBe(state);
  });

  it.each(["historyHydrate", "history"] as const)("preserves a live result delivered during an idle %s request without preventing later authoritative clearing", (kind) => {
    let state = setup();
    if (kind === "historyHydrate") {
      state = agentReducer(state, { type: "agent/historyHydrateLoading", chatId: "chat-2", sessionKey: "websocket:chat-2", requestId: "history" });
    } else {
      state = agentReducer(state, { type: "agent/historyLoading", chatId: "chat-2", sessionKey: "websocket:chat-2", requestId: "history" });
    }
    state = agentReducer(state, { type: "agent/wsEvent", event: delivery("live-during-history") });
    const thread = { schemaVersion: 1, sessionKey: "websocket:chat-2", last_turn_closed: true,
      messages: [{ role: "user", content: "旧请求" }, { role: "assistant", content: "旧回答" }] };
    state = agentReducer(state, { type: kind === "historyHydrate" ? "agent/historyHydrateLoaded" : "agent/historyLoaded", requestId: "history", thread });
    expect(state.messagesByChatId["chat-2"]?.map((message) => message.content)).toEqual(["旧请求", "旧回答", "暂无微信新消息"]);
    state = agentReducer(state, { type: "agent/historyHydrateLoading", chatId: "chat-2", sessionKey: "websocket:chat-2", requestId: "clear" });
    state = agentReducer(state, { type: "agent/historyHydrateLoaded", requestId: "clear", thread: { ...thread,
      messages: [{ role: "user", content: "新的权威请求" }, { role: "assistant", content: "新的权威回答" }] } });
    expect(state.messagesByChatId["chat-2"]?.map((message) => message.content)).toEqual(["新的权威请求", "新的权威回答"]);
  });

  it("preserves a live result arriving during reconnect recovery", () => {
    let state = setup();
    state = { ...state, recoveringGeneration: 1 };
    state = agentReducer(state, { type: "agent/recoveryChatLoading", request: {
      requestId: "recovery", generation: 1, chatId: "chat-1", chatSelectionEpoch: state.chatSelectionEpoch, runStatusVersionAtStart: 0,
    } });
    state = agentReducer(state, { type: "agent/wsEvent", event: delivery("recovery-live", "chat-1") });
    state = agentReducer(state, { type: "agent/recoveryChatSnapshotLoaded", requestId: "recovery", generation: 1,
      chatId: "chat-1", chatSelectionEpoch: state.chatSelectionEpoch, noticeId: "recovery-notice", completedAt: 5_000,
      runSnapshot: { chatId: "chat-1", status: "idle", startedAt: null, turnId: null, goalState: null },
      thread: { schemaVersion: 1, sessionKey: "websocket:chat-1", last_turn_closed: true,
        messages: [{ role: "user", content: "旧请求" }, { role: "assistant", content: "旧回答" }] },
    });
    expect(state.messages.map((message) => message.content)).toEqual(["旧请求", "旧回答", "暂无微信新消息"]);
  });
});
