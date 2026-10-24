// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRuntimeBridge } from "../../app/agent-runtime-bridge.js";
import { AppProviders } from "../../app/providers.js";
import { useTaskBus, type TaskBusValue } from "../../lib/task-bus.js";
import { agentActions, appActions } from "../../state/app-actions.js";
import { useAppState, type AppStateContextValue } from "../../state/app-state.js";
import { HomePage } from "../home-page.js";
import { countUnreadPetSessions } from "../pet-page.js";
import { mockBootstrap } from "./fixtures/bootstrap.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("HomePage pet unread synchronization", () => {
  let root: Root;
  let app: AppStateContextValue;
  let bus: TaskBusValue;
  let visibility: DocumentVisibilityState;

  function ObserveState() {
    app = useAppState();
    bus = useTaskBus();
    return null;
  }

  beforeEach(() => {
    Object.defineProperty(window, "localStorage", { configurable: true, value: createMemoryStorage() });
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: createMemoryStorage() });
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(
      <AppProviders>
        <AgentRuntimeBridge>
          <ObserveState />
          <HomePage />
        </AgentRuntimeBridge>
      </AppProviders>
    ));
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  function loadReadConversation() {
    const requestId = "pet-read-history";
    act(() => {
      app.dispatch(appActions.bootstrapLoaded(mockBootstrap, "/main"));
      app.dispatch(agentActions.sessionsLoaded([{
        key: "websocket:read-chat",
        title: "历史会话",
        preview: "已读回答",
        updatedAt: new Date(2000).toISOString(),
        projectId: null,
        cwd: null
      }]));
      app.dispatch(agentActions.historyLoading("websocket:read-chat", "read-chat", requestId));
      app.dispatch(agentActions.historyLoaded({
        schemaVersion: 1,
        sessionKey: "websocket:read-chat",
        last_turn_closed: true,
        messages: [
          { role: "user", content: "历史问题", createdAt: 1000 },
          { role: "assistant", content: "已读回答", createdAt: 2000 }
        ]
      }, requestId));
    });
  }

  it("opening a read conversation does not create a pet notification for its historical answer", () => {
    loadReadConversation();

    expect(app.state.agent.tasks.find((task) => task.chatId === "read-chat")?.completedUnseen).toBe(false);
    expect(bus.tasks).toHaveLength(1);
    expect(bus.tasks[0]?.lastAgentMessage).toBe("已读回答");
    expect(countUnreadPetSessions(bus.tasks)).toBe(0);
  });

  it("notifies for a new answer while the main window is hidden and clears it when that window is shown", () => {
    loadReadConversation();
    visibility = "hidden";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => {
      app.dispatch(agentActions.wsEventReceived({ event: "user", chat_id: "read-chat", text: "新问题", turn_id: "turn-new" }));
      app.dispatch(agentActions.wsEventReceived({ event: "run_status", chat_id: "read-chat", status: "running", started_at: Date.now(), turn_id: "turn-new" }));
      app.dispatch(agentActions.wsEventReceived({ event: "delta", chat_id: "read-chat", text: "新回答", turn_id: "turn-new" }));
      app.dispatch(agentActions.wsEventReceived({ event: "turn_end", chat_id: "read-chat", turn_id: "turn-new" }));
    });

    expect(app.state.agent.tasks.find((task) => task.chatId === "read-chat")?.completedUnseen).toBe(true);
    expect(bus.tasks).toHaveLength(2);
    expect(bus.tasks[0]?.lastAgentMessage).toBe("新回答");
    expect(countUnreadPetSessions(bus.tasks)).toBe(1);

    visibility = "visible";
    act(() => document.dispatchEvent(new Event("visibilitychange")));

    expect(app.state.agent.tasks.find((task) => task.chatId === "read-chat")?.completedUnseen).toBe(false);
    expect(countUnreadPetSessions(bus.tasks)).toBe(0);
  });
});

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value)
  };
}
