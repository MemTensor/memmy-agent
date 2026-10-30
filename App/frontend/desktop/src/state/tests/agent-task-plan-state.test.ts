import { expect, it } from "vitest";
import { agentReducer, initialAgentState } from "../agent-chat-slice.js";

it("keeps a plan scoped to its chat while switching away and returning", () => {
  const plan = { plan_id: "32f2868d-ae25-4f47-b33b-17f474eecc3a", title: "完成综述", status: "active" as const,
    items: [
      { id: "scope", content: "确认范围", status: "completed" as const },
      { id: "search", content: "检索文献", status: "in_progress" as const },
      { id: "write", content: "写作", status: "pending" as const }
    ], created_at: "2026-10-26T10:00:00.000Z", updated_at: "2026-10-26T10:01:00.000Z" };
  let state = agentReducer(initialAgentState, { type: "agent/historyLoading",
    sessionKey: "websocket:review", chatId: "review", requestId: "open-review" });
  state = agentReducer(state, { type: "agent/wsEvent", event: {
    event: "task_plan_state", chat_id: "review", task_plan_state: plan
  } });
  expect(state.taskPlanState).toEqual(plan);
  state = agentReducer(state, { type: "agent/historyLoading",
    sessionKey: "websocket:other", chatId: "other", requestId: "open-other" });
  expect(state.taskPlanState).toBeNull();
  state = agentReducer(state, { type: "agent/historyLoading",
    sessionKey: "websocket:review", chatId: "review", requestId: "return-review" });
  expect(state.taskPlanState).toEqual(plan);
  const finished = { ...plan, status: "completed" as const, items: plan.items.map((item) => ({ ...item, status: "completed" as const })) };
  state = agentReducer(state, { type: "agent/wsEvent", event: {
    event: "task_plan_state", chat_id: "review", task_plan_state: finished
  } });
  expect(state.taskPlanState).toEqual(finished);
  expect(state.taskPlanStatesByChatId.review).toEqual(finished);
});
