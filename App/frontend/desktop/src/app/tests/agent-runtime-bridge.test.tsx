/** Agent runtime bridge tests. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { defaultAgentSidebarState } from "../../state/agent-chat-slice.js";
import { agentRuntimeConnectRetryDelayMs, hydrateAgentThreadInBackground, isAgentRuntimeBridgeRoute, refreshAgentTaskList } from "../agent-runtime-bridge.js";

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

  it("enables websocket runtime only for the main workspace route family", () => {
    expect(isAgentRuntimeBridgeRoute("/main")).toBe(true);
    expect(isAgentRuntimeBridgeRoute("/tools")).toBe(true);
    expect(isAgentRuntimeBridgeRoute("/settings")).toBe(true);
    expect(isAgentRuntimeBridgeRoute("/memory")).toBe(true);
    expect(isAgentRuntimeBridgeRoute("/memory-sources")).toBe(true);

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
    expect(connectionEffect).toContain("dispatch(agentActions.failed(error instanceof Error ? error.message : String(error)));");
    expect(connectionEffect).toContain("scheduleRetry();");
    expect(connectionEffect).toContain("const recoveredFromFailure = connectAttemptRef.current > 0;");
    expect(connectionEffect).toContain("registerConnectionHandlers(nextConnection);");
    expect(connectionEffect).toContain("connectAttemptRef.current = 0;");
    expect(connectionEffect).toContain('void refreshAgentTaskList(client, dispatch, { reason: "auto" });');
    expect(connectionEffect).toContain("[cleanupConnection, clearConnectRetryTimer, clients?.memmyAgent, dispatch, enabled, registerConnectionHandlers]");
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
    const refreshEffect = source.slice(source.indexOf("useEffect(() => {\n    if (!clients?.memmyAgent || !state.agent.refreshRequested || !enabled)"), source.indexOf("return (\n    <AgentRuntimeBridgeContext.Provider"));
    const refreshTaskListBlock = source.slice(source.indexOf("export function refreshAgentTaskList"), source.indexOf("function isAgentConnectionEvent"));

    expect(refreshEffect).toContain("Object.entries(state.agent.pendingCanonicalHydrateByChatId)");
    expect(refreshEffect).toContain("hydrateAgentThreadInBackground(clients.memmyAgent, dispatch, chatId);");
    expect(refreshEffect).toContain("void refreshAgentTaskList(clients.memmyAgent, dispatch);");
    expect(refreshTaskListBlock).toContain("client.listSessions()");
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
      listSessions: vi.fn(async () => [
        { key: "websocket:chat-1", title: "完成任务", preview: "done", updatedAt: "2026-06-30T00:00:00.000Z" }
      ]),
      readSidebarState: vi.fn(async () => defaultAgentSidebarState),
      readWebuiThread: vi.fn()
    };

    refreshAgentTaskList(client as any, dispatch);
    await Promise.resolve();
    await Promise.resolve();

    expect(client.listSessions).toHaveBeenCalledTimes(1);
    expect(client.readSidebarState).toHaveBeenCalledTimes(1);
    expect(client.readWebuiThread).not.toHaveBeenCalled();
    expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual([
      "agent/sessionsLoading",
      "agent/sidebarStateLoaded",
      "agent/sessionsLoaded"
    ]);
  });
});
