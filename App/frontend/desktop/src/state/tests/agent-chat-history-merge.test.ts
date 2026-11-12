import { expect, it } from "vitest";
import { agentReducer, initialAgentState } from "../agent-chat-slice.js";

  it("restores earlier running steps from a richer history after switching sessions", () => {
    const turnId = "turn-running";
    let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    state = agentReducer(state, { type: "agent/wsEvent", event: {
      event: "run_status", chat_id: "chat-1", status: "running", started_at: 1780732800, turn_id: turnId
    } });
    state = agentReducer(state, { type: "agent/historyLoading", sessionKey: "websocket:chat-1", chatId: "chat-1", requestId: "first" });
    state = agentReducer(state, { type: "agent/historyLoaded", requestId: "first", thread: {
      schemaVersion: 3, sessionKey: "websocket:chat-1", last_turn_closed: false, last_turn_id: turnId,
      messages: [
        { role: "user", content: "做报告", turnId },
        { role: "tool", kind: "trace", content: "", turnId, toolEvents: [
          { phase: "end", call_id: "latest", name: "write_file", arguments: { path: "report.md" } }
        ] }
      ]
    } });
    state = agentReducer(state, { type: "agent/wsEvent", event: {
      event: "delta", chat_id: "chat-1", turn_id: turnId, text: "正在写报告"
    } });
    state = agentReducer(state, { type: "agent/historyLoading", sessionKey: "websocket:chat-2", chatId: "chat-2", requestId: "other" });
    state = agentReducer(state, { type: "agent/historyLoading", sessionKey: "websocket:chat-1", chatId: "chat-1", requestId: "return" });
    state = agentReducer(state, { type: "agent/historyLoaded", requestId: "return", thread: {
      schemaVersion: 3, sessionKey: "websocket:chat-1", last_turn_closed: false, last_turn_id: turnId,
      messages: [
        { role: "user", content: "做报告", turnId },
        { role: "assistant", content: "", reasoning: "先搜索资料", turnId },
        { role: "tool", kind: "trace", content: "", turnId, toolEvents: [
          { phase: "end", call_id: "earlier", name: "web_search", arguments: { query: "资料" } }
        ] },
        { role: "tool", kind: "trace", content: "", turnId, toolEvents: [
          { phase: "start", call_id: "latest", name: "write_file", arguments: { path: "report.md" } }
        ] }
      ]
    } });

    expect(state.messages.map((message) => message.reasoning ?? message.toolEvents?.[0]?.call_id ?? message.content))
      .toEqual(["做报告", "先搜索资料", "earlier", "latest", "正在写报告"]);
    expect(state.messages[3]?.toolEvents?.[0]?.phase).toBe("end");
    expect(state.messages.at(-1)?.isStreaming).toBe(true);
    expect(state.messagesByChatId["chat-1"]).toEqual(state.messages);
  });

it.each(["open", "hydrate"] as const)("restores the initial user message from full history after receiving only a live tail: %s", (mode) => {
  const turnId = "live-turn";
  let state = agentReducer(initialAgentState, { type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
  state = agentReducer(state, { type: "agent/wsEvent", event: {
    event: "run_status", chat_id: "chat-1", status: "running", started_at: 1780732800, turn_id: turnId
  } });
  state = agentReducer(state, { type: "agent/wsEvent", event: {
    event: "delta", chat_id: "chat-1", turn_id: turnId, text: "正在生成最后一节内容，稍后继续检查引用。"
  } });
  const requestId = "full-history";
  state = agentReducer(state, { type: mode === "open" ? "agent/historyLoading" : "agent/historyHydrateLoading",
    sessionKey: "websocket:chat-1", chatId: "chat-1", requestId });
  state = agentReducer(state, { type: mode === "open" ? "agent/historyLoaded" : "agent/historyHydrateLoaded", requestId, thread: {
    schemaVersion: 3, sessionKey: "websocket:chat-1", last_turn_closed: false, last_turn_id: turnId,
    messages: [
      { role: "user", content: "$literature-review", turnId },
      { role: "assistant", content: "已确认研究范围", turnId },
      { role: "assistant", content: "正在生成最后一节内容，稍后继续检查", turnId }
    ]
  } });
  expect(state.messages.map((message) => message.content)).toEqual([
    "$literature-review", "已确认研究范围", "正在生成最后一节内容，稍后继续检查引用。"
  ]);
  expect(state.messages.at(-1)?.isStreaming).toBe(true);
  expect(state.isSending).toBe(true);
});
