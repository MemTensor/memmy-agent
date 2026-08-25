/** Agent runtime bridge tests. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { MemmyAgentRequestError } from "../../api/memmy-agent-client.js";
import {
  agentReducer,
  defaultAgentSidebarState,
  initialAgentState,
  type AgentAction,
  type AgentState
} from "../../state/agent-chat-slice.js";
import type { AppAction } from "../../state/app-actions.js";
import {
  agentRuntimeConnectRetryDelayMs,
  createAgentTaskStateCoordinator,
  hydrateAgentThreadInBackground,
  isAgentRuntimeBridgeRoute,
  requestDesyncedAgentQueueSnapshots,
  refreshAgentTaskList
} from "../agent-runtime-bridge.js";

const bridgeSourcePath = fileURLToPath(new URL("../agent-runtime-bridge.tsx", import.meta.url));

function readBridgeSource(): string {
  return readFileSync(bridgeSourcePath, "utf8").replace(/\r\n/g, "\n");
}

describe("AgentRuntimeBridge", () => {
  it("uses bounded retry delays for initial runtime connection failures", () => {
    expect(agentRuntimeConnectRetryDelayMs(0)).toBe(500);
    expect(agentRuntimeConnectRetryDelayMs(1)).toBe(1000);
    expect(agentRuntimeConnectRetryDelayMs(2)).toBe(2000);
    expect(agentRuntimeConnectRetryDelayMs(3)).toBe(5000);
    expect(agentRuntimeConnectRetryDelayMs(4)).toBe(10000);
    expect(agentRuntimeConnectRetryDelayMs(99)).toBe(10000);
  });

  it("requests each queue revision gap once and drops old-generation bookkeeping", () => {
    const connection = { requestQueueSnapshot: vi.fn() };
    const requestedKeys = new Set(["6\u0000old-chat\u00003"]);
    const desynced = {
      "chat-1": { generation: 7, observedRevision: 5 },
      "chat-2": { generation: 6, observedRevision: 8 }
    };

    requestDesyncedAgentQueueSnapshots(connection, 7, desynced, requestedKeys);
    requestDesyncedAgentQueueSnapshots(connection, 7, desynced, requestedKeys);

    expect(connection.requestQueueSnapshot).toHaveBeenCalledOnce();
    expect(connection.requestQueueSnapshot).toHaveBeenCalledWith("chat-1", 7);
    expect([...requestedKeys]).toEqual(["7\u0000chat-1\u00005"]);

    requestDesyncedAgentQueueSnapshots(connection, 8, {
      "chat-1": { generation: 8, observedRevision: 9 }
    }, requestedKeys);
    expect(connection.requestQueueSnapshot).toHaveBeenLastCalledWith("chat-1", 8);
    expect([...requestedKeys]).toEqual(["8\u0000chat-1\u00009"]);
  });

  it("enables websocket runtime only for the main workspace route family", () => {
    expect(isAgentRuntimeBridgeRoute("/main")).toBe(true);
    expect(isAgentRuntimeBridgeRoute("/tools")).toBe(true);
    expect(isAgentRuntimeBridgeRoute("/settings")).toBe(true);
    expect(isAgentRuntimeBridgeRoute("/memory")).toBe(true);
    expect(isAgentRuntimeBridgeRoute("/memory-sources")).toBe(true);
    expect(isAgentRuntimeBridgeRoute("/literature-review")).toBe(true);

    expect(isAgentRuntimeBridgeRoute("/pet")).toBe(false);
    expect(isAgentRuntimeBridgeRoute("/welcome")).toBe(false);
    expect(isAgentRuntimeBridgeRoute("/login")).toBe(false);
    expect(isAgentRuntimeBridgeRoute("/api-key")).toBe(false);
    expect(isAgentRuntimeBridgeRoute("/api-key-models")).toBe(false);
    expect(isAgentRuntimeBridgeRoute("/onboarding")).toBe(false);
    expect(isAgentRuntimeBridgeRoute("/token-detail")).toBe(false);
  });

  it("keeps route changes inside the workspace family from closing the connection", () => {
    const source = readBridgeSource();

    expect(source).toContain("const enabled = isAgentRuntimeBridgeRoute(state.navigation.currentPath);");
    expect(source).toContain("if (!enabled || !clients?.memmyAgent) {");
    expect(source).toContain("cleanupConnection();");
    expect(source).toContain("connectionRef.current?.close();");
    expect(source).toContain('path === "/memory-sources"');
    expect(source).not.toContain('path === "/pet"');
  });

  it("retries initial connection failures without taking over established websocket reconnects", () => {
    const source = readBridgeSource();
    const connectionEffect = source.slice(
      source.indexOf("useEffect(() => {\n    if (!enabled || !clients?.memmyAgent)"),
      source.indexOf("useEffect(() => {\n    const chatId = state.agent.currentChatId;")
    );

    expect(source).toContain("const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);");
    expect(source).toContain("const connectAttemptRef = useRef(0);");
    expect(source).toContain("const connectInFlightRef = useRef(false);");
    expect(source).toContain("const clearConnectRetryTimer = useCallback((): void => {");
    expect(source).toContain("clearConnectRetryTimer();");
    expect(connectionEffect).toContain("const delayMs = agentRuntimeConnectRetryDelayMs(connectAttemptRef.current);");
    expect(connectionEffect).toContain("connectAttemptRef.current += 1;");
    expect(connectionEffect).toContain("dispatch(agentActions.connectionFailed(error instanceof Error ? error.message : String(error)));");
    expect(connectionEffect).toContain("scheduleRetry();");
    expect(connectionEffect).toContain("registerConnectionHandlers(nextConnection);");
    expect(connectionEffect).toContain("connectAttemptRef.current = 0;");
    expect(connectionEffect).toContain("[cleanupConnection, clearConnectRetryTimer, clients?.memmyAgent, dispatch, enabled, refreshModelCatalog, registerConnectionHandlers]");
  });

  it("subscribes the current chat and routes non-current lifecycle events without duplicate dispatch", () => {
    const source = readBridgeSource();
    const subscribeBlock = source.slice(source.indexOf("const subscribeAgentChat"), source.indexOf("const ensureChatSubscription"));
    const lifecycleBlock = source.slice(source.indexOf("nextConnection.onRunLifecycle"), source.indexOf("useEffect(() => {\n    const chatId = state.agent.currentChatId;"));

    expect(subscribeBlock).toContain("nextConnection.onChat(chatId, (event) => {");
    expect(subscribeBlock).toContain("dispatch(agentActions.wsEventReceived(event));");
    expect(lifecycleBlock).toContain("if (chatId === subscribedChatRef.current)");
    expect(lifecycleBlock).toContain("return;");
    expect(lifecycleBlock).toContain("dispatch(agentActions.wsEventReceived(event));");
    expect(source).toContain("event.chat_id !== subscribedChatRef.current");
    expect(source).not.toContain("nextConnection.onRuntimeModelUpdate");
  });

  it("refreshes the chat catalog and settings model config from the same config change event", () => {
    const source = readBridgeSource();
    const refreshBlock = source.slice(
      source.indexOf("const refreshModelCatalog"),
      source.indexOf("const registerConnectionHandlers")
    );

    expect(refreshBlock).toContain("agentClient.getSettings()");
    expect(refreshBlock).toContain("configClient.getModelConfig()");
    expect(refreshBlock).toContain("dispatch(agentActions.modelCatalogLoaded(");
    expect(refreshBlock).toContain("dispatch(appActions.modelConfigUpdated(modelConfig));");
    expect(refreshBlock).toContain("version === modelCatalogRefreshVersionRef.current");
  });

  it("keeps current chat subscribed after connection becomes available outside HomePage", () => {
    const source = readBridgeSource();
    const subscriptionEffect = source.slice(source.indexOf("useEffect(() => {\n    const chatId = state.agent.currentChatId;"), source.indexOf("useEffect(() => {\n    if (!clients?.memmyAgent"));

    expect(subscriptionEffect).toContain("if (!connection || !chatId)");
    expect(subscriptionEffect).toContain("subscribeAgentChat(connection, chatId);");
    expect(subscriptionEffect).toContain("state.agent.currentChatId");
  });

  it("uses background hydrate and metadata-only task refresh for refreshRequested", () => {
    const source = readBridgeSource();
    const refreshEffect = source.slice(source.indexOf("state.agent.refreshRequested || !enabled || state.agent.recoveringGeneration !== null"), source.indexOf("return (\n    <AgentRuntimeBridgeContext.Provider"));
    const refreshTaskListBlock = source.slice(source.indexOf("export function refreshAgentTaskList"), source.indexOf("function isAgentConnectionEvent"));

    expect(refreshEffect).toContain("Object.entries(state.agent.pendingCanonicalHydrateByChatId)");
    expect(refreshEffect).toContain("hydrateAgentThreadInBackground(clients.memmyAgent, dispatch, chatId);");
    expect(refreshEffect).toContain("taskStateCoordinator?.refreshTaskState();");
    expect(refreshTaskListBlock).toContain("client.getSessionSnapshot({ timeoutMs: 10_000 })");
    expect(refreshTaskListBlock).toContain("client.readSidebarState()");
    expect(refreshTaskListBlock).not.toContain("readWebuiThread");
  });

  it("hydrates agent threads in the background without foreground history actions", async () => {
    const dispatch = vi.fn();
    const client = {
      chatIdToSessionKey: (chatId: string) => `websocket:${chatId}`,
      readWebuiThread: vi.fn(async () => ({
        schemaVersion: 1,
        sessionKey: "websocket:chat-1",
        messages: [{ role: "assistant", content: "后台完成" }]
      }))
    };

    hydrateAgentThreadInBackground(client as any, dispatch, "chat-1");
    await Promise.resolve();
    await Promise.resolve();

    expect(client.readWebuiThread).toHaveBeenCalledWith("websocket:chat-1");
    expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual([
      "agent/historyHydrateLoading",
      "agent/historyHydrateLoaded"
    ]);
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "agent/historyLoading" }));
  });

  it("refreshes task metadata without hydrating messages", async () => {
    const dispatch = vi.fn();
    const client = {
      chatIdToSessionKey: (chatId: string) => `websocket:${chatId}`,
      getSessionSnapshot: vi.fn(async () => ({
        projectRegistryState: "ready" as const,
        projects: [],
        sessions: [
          { key: "websocket:chat-1", title: "完成任务", preview: "done", updatedAt: "2026-06-30T00:00:00.000Z", projectId: null, cwd: "/workspace" }
        ]
      })),
      readSidebarState: vi.fn(async () => defaultAgentSidebarState),
      readWebuiThread: vi.fn()
    };

    refreshAgentTaskList(client as any, dispatch);
    await Promise.resolve();
    await Promise.resolve();

    expect(client.getSessionSnapshot).toHaveBeenCalledTimes(1);
    expect(client.readSidebarState).toHaveBeenCalledTimes(1);
    expect(client.readWebuiThread).not.toHaveBeenCalled();
    expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual([
      "agent/taskStateLoading",
      "agent/taskStateSettled"
    ]);
  });

  it("serializes replayable sidebar intents in FIFO order", async () => {
    let agentState: AgentState = initialAgentState;
    const dispatch = vi.fn((action: AppAction) => {
      if (action.type.startsWith("agent/")) {
        agentState = agentReducer(agentState, action as AgentAction);
      }
    });
    let resolveFirst!: (value: typeof defaultAgentSidebarState) => void;
    const firstWrite = new Promise<typeof defaultAgentSidebarState>((resolve) => {
      resolveFirst = resolve;
    });
    const writeSidebarState = vi.fn()
      .mockImplementationOnce(() => firstWrite)
      .mockImplementationOnce(async (_base, state) => ({
        ...state,
        updated_at: "2026-07-26T00:00:00.002Z"
      }));
    const client = {
      writeSidebarState,
      readSidebarState: vi.fn(async () => defaultAgentSidebarState)
    };
    const coordinator = createAgentTaskStateCoordinator(
      client as any,
      dispatch,
      () => agentState
    );

    const pin = coordinator.enqueueSidebarIntent({
      id: "pin",
      kind: "task-patch",
      sessionKey: "websocket:chat",
      patch: { pinned: true }
    });
    const archive = coordinator.enqueueSidebarIntent({
      id: "archive",
      kind: "task-patch",
      sessionKey: "websocket:chat",
      patch: { archived: true }
    });

    expect(writeSidebarState).toHaveBeenCalledTimes(1);
    expect(writeSidebarState.mock.calls[0]?.[1]).toMatchObject({
      pinned_keys: ["websocket:chat"],
      archived_keys: []
    });
    resolveFirst({
      ...defaultAgentSidebarState,
      pinned_keys: ["websocket:chat"],
      updated_at: "2026-07-26T00:00:00.001Z"
    });
    await pin;
    await archive;

    expect(writeSidebarState).toHaveBeenCalledTimes(2);
    expect(writeSidebarState.mock.calls[1]?.[0]).toBe("2026-07-26T00:00:00.001Z");
    expect(writeSidebarState.mock.calls[1]?.[1]).toMatchObject({
      pinned_keys: ["websocket:chat"],
      archived_keys: ["websocket:chat"]
    });
    coordinator.dispose();
  });

  it("rebases a sidebar intent on the authoritative state returned by CAS conflict", async () => {
    let agentState: AgentState = initialAgentState;
    const dispatch = (action: AppAction): void => {
      if (action.type.startsWith("agent/")) {
        agentState = agentReducer(agentState, action as AgentAction);
      }
    };
    const serverState = {
      ...defaultAgentSidebarState,
      archived_keys: ["websocket:other"],
      updated_at: "2026-07-26T00:00:00.010Z"
    };
    const writeSidebarState = vi.fn()
      .mockRejectedValueOnce(new MemmyAgentRequestError(
        "conflict",
        409,
        "sidebar_state_conflict",
        { sidebarState: serverState }
      ))
      .mockImplementationOnce(async (_base, state) => ({
        ...state,
        updated_at: "2026-07-26T00:00:00.011Z"
      }));
    const coordinator = createAgentTaskStateCoordinator(
      {
        writeSidebarState,
        readSidebarState: vi.fn(async () => serverState)
      } as any,
      dispatch,
      () => agentState
    );

    await coordinator.enqueueSidebarIntent({
      id: "pin",
      kind: "task-patch",
      sessionKey: "websocket:chat",
      patch: { pinned: true }
    });

    expect(writeSidebarState).toHaveBeenCalledTimes(2);
    expect(writeSidebarState.mock.calls[1]?.[0]).toBe(serverState.updated_at);
    expect(writeSidebarState.mock.calls[1]?.[1]).toMatchObject({
      pinned_keys: ["websocket:chat"],
      archived_keys: ["websocket:other"]
    });
    coordinator.dispose();
  });

  it("drops a failed sidebar intent after three attempts and continues from the confirmed state", async () => {
    let agentState: AgentState = initialAgentState;
    const dispatch = (action: AppAction): void => {
      if (action.type.startsWith("agent/")) {
        agentState = agentReducer(agentState, action as AgentAction);
      }
    };
    const writeSidebarState = vi.fn()
      .mockRejectedValueOnce(new Error("write failed"))
      .mockRejectedValueOnce(new Error("write failed"))
      .mockRejectedValueOnce(new Error("write failed"))
      .mockImplementationOnce(async (_base, state) => ({
        ...state,
        updated_at: "2026-07-26T00:00:00.001Z"
      }));
    const coordinator = createAgentTaskStateCoordinator(
      {
        writeSidebarState,
        readSidebarState: vi.fn(async () => defaultAgentSidebarState)
      } as any,
      dispatch,
      () => agentState
    );

    const failed = coordinator.enqueueSidebarIntent({
      id: "pin",
      kind: "task-patch",
      sessionKey: "websocket:chat",
      patch: { pinned: true }
    }).catch((error: unknown) => error);
    const archive = coordinator.enqueueSidebarIntent({
      id: "archive",
      kind: "task-patch",
      sessionKey: "websocket:chat",
      patch: { archived: true }
    });

    expect(await failed).toBeInstanceOf(Error);
    await archive;

    expect(writeSidebarState).toHaveBeenCalledTimes(4);
    expect(agentState.sidebarState.pinned_keys).toEqual([]);
    expect(agentState.sidebarState.archived_keys).toEqual(["websocket:chat"]);
    expect(agentState.currentSidebarMutationId).toBeNull();
    coordinator.dispose();
  });

  it("waits for sidebar persistence before entering a project removal barrier", async () => {
    let agentState: AgentState = initialAgentState;
    const dispatch = (action: AppAction): void => {
      if (action.type.startsWith("agent/")) {
        agentState = agentReducer(agentState, action as AgentAction);
      }
    };
    let resolveWrite!: (value: typeof defaultAgentSidebarState) => void;
    const write = new Promise<typeof defaultAgentSidebarState>((resolve) => {
      resolveWrite = resolve;
    });
    const operation = vi.fn(async () => "deleted");
    const coordinator = createAgentTaskStateCoordinator(
      {
        writeSidebarState: vi.fn(() => write),
        readSidebarState: vi.fn(async () => defaultAgentSidebarState)
      } as any,
      dispatch,
      () => agentState
    );

    const queued = coordinator.enqueueSidebarIntent({
      id: "pin",
      kind: "task-patch",
      sessionKey: "websocket:chat",
      patch: { pinned: true }
    });
    const deletion = coordinator.runWithSidebarSettled(operation);
    await Promise.resolve();
    expect(operation).not.toHaveBeenCalled();

    resolveWrite({
      ...defaultAgentSidebarState,
      pinned_keys: ["websocket:chat"],
      updated_at: "2026-07-26T00:00:00.001Z"
    });
    await queued;
    await expect(deletion).resolves.toBe("deleted");
    expect(operation).toHaveBeenCalledTimes(1);
    coordinator.dispose();
  });
});
