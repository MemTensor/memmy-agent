// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRuntimeBridge } from "../agent-runtime-bridge.js";
import { AppProviders, useApiClients, type ApiClientsContextValue } from "../providers.js";
import type { AppClients } from "../../api/client-types.js";
import type { MemmyAgentClient, MemmyAgentWebSocketConnection, MemmyAgentWsEvent } from "../../api/memmy-agent-client.js";
import { defaultAgentSidebarState } from "../../state/agent-chat-slice.js";
import { appActions } from "../../state/app-actions.js";
import { useAppState, type AppStateContextValue } from "../../state/app-state.js";
import { mockBootstrap } from "../../pages/tests/fixtures/bootstrap.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("scheduled native notifications", () => {
  let root: Root;
  let app: AppStateContextValue;
  let api: ApiClientsContextValue;
  let focused: boolean;
  const notifyTaskDone = vi.fn(async (_payload: { title: string; body: string; silent: boolean; deliveryId?: string }) => undefined);
  function ObserveState() { app = useAppState(); api = useApiClients(); return null; }

  beforeEach(() => {
    focused = true;
    notifyTaskDone.mockClear();
    Object.defineProperty(window, "localStorage", { configurable: true, value: createMemoryStorage() });
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: createMemoryStorage() });
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.stubGlobal("memmy", undefined);
    Object.defineProperty(window, "memmy", { configurable: true, value: { notifyTaskDone } });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<AppProviders><AgentRuntimeBridge><ObserveState /></AgentRuntimeBridge></AppProviders>));
    act(() => {
      app.dispatch(appActions.bootstrapLoaded({ ...mockBootstrap, app: { ...mockBootstrap.app, language: "zh-CN" } }, "/memory"));
      app.dispatch({ type: "agent/sessionsLoaded", sessions: ["chat-1", "chat-2"].map((id) => ({
        key: `websocket:${id}`, title: id, preview: "", updatedAt: "2026-10-12T12:00:00.000Z", projectId: null, cwd: null,
      })) });
      app.dispatch({ type: "agent/wsEvent", event: { event: "ready", chat_id: "chat-1" } });
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    delete window.memmy;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  function deliver(deliveryId: string, chatId = "chat-2", replayed = false) {
    app.dispatch({ type: "agent/wsEvent", event: { event: "message", chat_id: chatId,
      text: "暂无微信新消息", metadata: { proactiveDelivery: "cron", deliveryId, ...(replayed ? { replayed: true } : {}) } } });
  }

  it("notifies immediately on the memory page without AppFrame or an opened target conversation", () => {
    act(() => { deliver("one"); deliver("two"); });
    expect(notifyTaskDone.mock.calls).toEqual([
      [{ title: "定时任务提醒", body: "暂无微信新消息", silent: false, deliveryId: "one" }],
      [{ title: "定时任务提醒", body: "暂无微信新消息", silent: false, deliveryId: "two" }],
    ]);
    expect(app.state.agent.proactiveNotifications).toEqual([]);
    expect(app.state.agent.lastTaskCompletion).toBeNull();
    act(() => deliver("one"));
    expect(notifyTaskDone).toHaveBeenCalledTimes(2);
  });

  it("opens a passive consumer in pet mode and notifies/acknowledges a never-opened chat without AppFrame", async () => {
    let receiveGlobal: (event: MemmyAgentWsEvent) => void = () => undefined;
    const acknowledgeCronDelivery = vi.fn();
    const onChat = vi.fn(() => () => undefined);
    const connection = {
      getReadyGeneration: () => 1, acknowledgeCronDelivery, onChat,
      onSessionUpdate: () => () => undefined, onRunLifecycle: () => () => undefined, close: vi.fn(),
      requestRunStatusSnapshot: async () => ({ status: "idle", startedAt: null, turnId: null, source: null }),
    } as unknown as MemmyAgentWebSocketConnection;
    const client = {
      bootstrap: async () => ({ model_name: "test-model" }),
      connectWebSocket: vi.fn(async (handler: (event: MemmyAgentWsEvent) => void) => {
        receiveGlobal = handler;
        handler({ event: "ready", chat_id: "chat-1", connection_generation: 1 });
        return connection;
      }),
      getSessionSnapshot: async () => ({ projectRegistryState: "ready", projects: [], sessions: app.state.agent.sessions }),
      readSidebarState: async () => defaultAgentSidebarState,
      chatIdToSessionKey: (chatId: string) => `websocket:${chatId}`,
      readWebuiThread: async (sessionKey: string) => ({ schemaVersion: 1, sessionKey, last_turn_closed: true, messages: [] }),
    } as unknown as MemmyAgentClient;
    await act(async () => {
      app.dispatch(appActions.navigate("/pet"));
      api.setClients({ memmyAgent: client } as AppClients);
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });
    expect(client.connectWebSocket).toHaveBeenCalledTimes(1);
    act(() => receiveGlobal({ event: "message", chat_id: "chat-2", connection_generation: 1,
      text: "暂无微信新消息", metadata: { proactiveDelivery: "cron", deliveryId: "pet-cold" } }));
    expect(onChat.mock.calls.every((call) => call[0] !== "chat-2")).toBe(true);
    expect(app.state.agent.messagesByChatId["chat-2"]?.[0]?.content).toBe("暂无微信新消息");
    expect(notifyTaskDone).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: "pet-cold", body: "暂无微信新消息" }));
    expect(acknowledgeCronDelivery.mock.calls).toEqual([["pet-cold"]]);
  });

  it("suppresses a focused visible current chat, while another chat and a hidden window notify", () => {
    act(() => app.dispatch({ type: "agent/chatViewVisibilityChanged", visible: true }));
    act(() => deliver("visible", "chat-1"));
    expect(notifyTaskDone).not.toHaveBeenCalled();
    act(() => deliver("other"));
    expect(notifyTaskDone).toHaveBeenCalledTimes(1);
    focused = false;
    act(() => window.dispatchEvent(new Event("blur")));
    act(() => deliver("hidden", "chat-1"));
    expect(notifyTaskDone).toHaveBeenCalledTimes(2);
  });

  it("honors notification and sound settings and does not replay suppressed reminders when settings change", () => {
    act(() => app.dispatch(appActions.bootstrapLoaded({ ...mockBootstrap,
      app: { ...mockBootstrap.app, taskDoneNotificationEnabled: false } }, "/memory")));
    act(() => deliver("disabled"));
    expect(notifyTaskDone).not.toHaveBeenCalled();
    act(() => app.dispatch(appActions.bootstrapLoaded({ ...mockBootstrap,
      app: { ...mockBootstrap.app, notificationSoundEnabled: false } }, "/memory")));
    act(() => deliver("silent"));
    expect(notifyTaskDone).toHaveBeenCalledTimes(1);
    expect(notifyTaskDone.mock.calls[0]?.[0]).toMatchObject({ silent: true, deliveryId: "silent" });
  });

  it("does not notify or mark unread for a replayed record", () => {
    act(() => deliver("old", "chat-2", true));
    expect(notifyTaskDone).not.toHaveBeenCalled();
    expect(app.state.agent.proactiveUnseenByChatId).toEqual({});
  });
});

function createMemoryStorage(): Storage {
  const entries = new Map<string, string>();
  return { get length() { return entries.size; }, clear() { entries.clear(); },
    getItem(key) { return entries.get(key) ?? null; }, key(index) { return [...entries.keys()][index] ?? null; },
    removeItem(key) { entries.delete(key); }, setItem(key, value) { entries.set(key, value); } };
}
