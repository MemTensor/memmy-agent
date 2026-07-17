/** Agent runtime bridge module. */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  type MemmyAgentClient,
  type MemmyAgentUnsubscribe,
  type MemmyAgentWebSocketConnection,
  type MemmyAgentWsEvent
} from "../api/memmy-agent-client.js";
import { agentActions, type AppAction } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import { useApiClients } from "./providers.js";
import type { AppRoutePath } from "./routes.js";

export interface AgentRuntimeBridgeValue {
  connection: MemmyAgentWebSocketConnection | null;
  ensureChatSubscription(chatId: string): void;
}

const AgentRuntimeBridgeContext = createContext<AgentRuntimeBridgeValue | null>(null);
const AGENT_RUNTIME_CONNECT_RETRY_DELAYS_MS = [500, 1000, 2000, 5000] as const;
const AGENT_RUNTIME_CONNECT_STEADY_RETRY_DELAY_MS = 10_000;

/** Handles agent runtime connect retry delay ms. */
export function agentRuntimeConnectRetryDelayMs(attempt: number): number {
  return AGENT_RUNTIME_CONNECT_RETRY_DELAYS_MS[attempt]
    ?? AGENT_RUNTIME_CONNECT_STEADY_RETRY_DELAY_MS;
}

/** Checks is agent runtime bridge route. */
export function isAgentRuntimeBridgeRoute(path: AppRoutePath): boolean {
  return path === "/main"
    || path === "/tools"
    || path === "/settings"
    || path === "/memory"
    || path === "/memory-sources";
}

/** Handles agent runtime bridge. */
export function AgentRuntimeBridge(props: { children: ReactNode }) {
  const { clients } = useApiClients();
  const { state, dispatch } = useAppState();
  const enabled = isAgentRuntimeBridgeRoute(state.navigation.currentPath);
  const connectionRef = useRef<MemmyAgentWebSocketConnection | null>(null);
  const [connection, setConnection] = useState<MemmyAgentWebSocketConnection | null>(null);
  const connectionUnsubscribersRef = useRef<MemmyAgentUnsubscribe[]>([]);
  const chatUnsubscribeRef = useRef<MemmyAgentUnsubscribe | null>(null);
  const subscribedChatRef = useRef<string | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectAttemptRef = useRef(0);
  const connectInFlightRef = useRef(false);

  const clearConnectRetryTimer = useCallback((): void => {
    if (retryTimerRef.current) {
      globalThis.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const cleanupConnection = useCallback((): void => {
    clearConnectRetryTimer();
    connectAttemptRef.current = 0;
    connectInFlightRef.current = false;
    chatUnsubscribeRef.current?.();
    chatUnsubscribeRef.current = null;
    subscribedChatRef.current = null;
    for (const unsubscribe of connectionUnsubscribersRef.current) {
      unsubscribe();
    }
    connectionUnsubscribersRef.current = [];
    connectionRef.current?.close();
    connectionRef.current = null;
    setConnection(null);
  }, [clearConnectRetryTimer]);

  const subscribeAgentChat = useCallback((nextConnection: MemmyAgentWebSocketConnection, chatId: string): void => {
    if (chatId === subscribedChatRef.current) {
      return;
    }

    chatUnsubscribeRef.current?.();
    subscribedChatRef.current = chatId;
    chatUnsubscribeRef.current = nextConnection.onChat(chatId, (event) => {
      dispatch(agentActions.wsEventReceived(event));
    });
  }, [dispatch]);

  const ensureChatSubscription = useCallback((chatId: string): void => {
    const currentConnection = connectionRef.current;
    if (!currentConnection) {
      return;
    }
    subscribeAgentChat(currentConnection, chatId);
  }, [subscribeAgentChat]);

  const registerConnectionHandlers = useCallback((nextConnection: MemmyAgentWebSocketConnection): void => {
    connectionUnsubscribersRef.current = [
      nextConnection.onSessionUpdate((chatId, scope) => dispatch(agentActions.wsEventReceived({ event: "session_updated", chat_id: chatId, ...(scope ? { scope } : {}) }))),
      nextConnection.onRuntimeModelUpdate((modelName, modelPreset) => dispatch(agentActions.wsEventReceived({
        event: "runtime_model_updated",
        ...(modelName ? { model_name: modelName } : {}),
        ...(modelPreset ? { model_preset: modelPreset } : {})
      }))),
      nextConnection.onRunLifecycle((chatId, event) => {
        if (chatId === subscribedChatRef.current) {
          return;
        }
        dispatch(agentActions.wsEventReceived(event));
      })
    ];
  }, [dispatch]);

  useEffect(() => {
    if (!enabled || !clients?.memmyAgent) {
      cleanupConnection();
      return;
    }

    if (connectionRef.current || connectInFlightRef.current) {
      return;
    }

    let isActive = true;
    const client = clients.memmyAgent;

    function scheduleRetry(): void {
      if (!isActive || connectionRef.current) {
        return;
      }
      const delayMs = agentRuntimeConnectRetryDelayMs(connectAttemptRef.current);
      connectAttemptRef.current += 1;
      clearConnectRetryTimer();
      retryTimerRef.current = globalThis.setTimeout(() => {
        retryTimerRef.current = null;
        void attemptConnect();
      }, delayMs);
    }

    async function attemptConnect(): Promise<void> {
      if (!isActive || connectionRef.current || connectInFlightRef.current) {
        return;
      }

      connectInFlightRef.current = true;
      dispatch(agentActions.bootstrapStarted());

      try {
        const boot = await client.bootstrap();
        if (!isActive) {
          return;
        }

        dispatch(agentActions.bootstrapSucceeded(boot.model_name));
        dispatch(agentActions.connectionConnecting());
        const nextConnection = await client.connectWebSocket((event) => {
          if (isAgentConnectionEvent(event)) {
            dispatch(agentActions.wsEventReceived(event));
          }
        });

        if (!isActive) {
          nextConnection.close();
          return;
        }

        const recoveredFromFailure = connectAttemptRef.current > 0;
        connectionRef.current = nextConnection;
        setConnection(nextConnection);
        registerConnectionHandlers(nextConnection);
        connectAttemptRef.current = 0;
        clearConnectRetryTimer();
        if (recoveredFromFailure) {
          void refreshAgentTaskList(client, dispatch, { reason: "auto" });
        }
      } catch (error) {
        if (!isActive) {
          return;
        }
        dispatch(agentActions.failed(error instanceof Error ? error.message : String(error)));
        scheduleRetry();
      } finally {
        connectInFlightRef.current = false;
      }
    }

    void attemptConnect();

    return () => {
      isActive = false;
      cleanupConnection();
    };
  }, [cleanupConnection, clearConnectRetryTimer, clients?.memmyAgent, dispatch, enabled, registerConnectionHandlers]);

  useEffect(() => {
    const chatId = state.agent.currentChatId;
    if (!connection || !chatId) {
      chatUnsubscribeRef.current?.();
      chatUnsubscribeRef.current = null;
      subscribedChatRef.current = null;
      return;
    }

    subscribeAgentChat(connection, chatId);
  }, [connection, state.agent.currentChatId, subscribeAgentChat]);

  useEffect(() => {
    if (!clients?.memmyAgent || !state.agent.refreshRequested || !enabled) {
      return;
    }

    for (const [chatId, pending] of Object.entries(state.agent.pendingCanonicalHydrateByChatId)) {
      if (pending && !state.agent.currentHistoryHydrateRequestIdByChatId[chatId]) {
        hydrateAgentThreadInBackground(clients.memmyAgent, dispatch, chatId);
      }
    }

    if (!state.agent.isLoadingSessions) {
      void refreshAgentTaskList(clients.memmyAgent, dispatch);
    }
  }, [
    clients?.memmyAgent,
    dispatch,
    enabled,
    state.agent.currentHistoryHydrateRequestIdByChatId,
    state.agent.isLoadingSessions,
    state.agent.pendingCanonicalHydrateByChatId,
    state.agent.refreshRequested
  ]);

  return (
    <AgentRuntimeBridgeContext.Provider value={{ connection, ensureChatSubscription }}>
      {props.children}
    </AgentRuntimeBridgeContext.Provider>
  );
}

/** Handles use agent runtime bridge. */
export function useAgentRuntimeBridge(): AgentRuntimeBridgeValue {
  const value = useContext(AgentRuntimeBridgeContext);
  if (!value) {
    throw new Error("useAgentRuntimeBridge must be used within AgentRuntimeBridge");
  }
  return value;
}

/** Handles hydrate agent thread in background. */
export function hydrateAgentThreadInBackground(
  client: MemmyAgentClient,
  dispatch: (action: AppAction) => void,
  chatId: string,
  sessionKey = client.chatIdToSessionKey(chatId)
): void {
  const requestId = nextAgentHistoryRequestId(chatId);
  dispatch(agentActions.historyHydrateLoading(sessionKey, chatId, requestId));
  void client.readWebuiThread(sessionKey)
    .then((thread) => dispatch(agentActions.historyHydrateLoaded(thread, requestId)))
    .catch(() => dispatch(agentActions.historyHydrateFailed(chatId, requestId)));
}

interface RefreshAgentTaskListOptions {
  expectedChatId?: string;
  reason?: "auto" | "new-chat" | "manual" | "thread";
  attempt?: number;
}

const NEW_CHAT_REFRESH_RETRY_DELAYS_MS = [150, 400, 900] as const;

/** Handles refresh agent task list. */
export function refreshAgentTaskList(
  client: MemmyAgentClient,
  dispatch: (action: AppAction) => void,
  options: RefreshAgentTaskListOptions = {}
): void {
  const reason = options.reason ?? "auto";
  const attempt = options.attempt ?? 0;
  const requestId = nextAgentSessionsRequestId(reason);
  dispatch(agentActions.sessionsLoading(requestId));
  void Promise.all([
    client.listSessions(),
    client.readSidebarState()
  ])
    .then(([sessions, sidebarState]) => {
      dispatch(agentActions.sidebarStateLoaded(sidebarState));
      dispatch(agentActions.sessionsLoaded(sessions, requestId));
      if (
        options.expectedChatId
        && !sessions.some((session) => session.key === client.chatIdToSessionKey(options.expectedChatId!))
        && attempt < NEW_CHAT_REFRESH_RETRY_DELAYS_MS.length
      ) {
        globalThis.setTimeout(() => refreshAgentTaskList(client, dispatch, {
          ...options,
          attempt: attempt + 1
        }), NEW_CHAT_REFRESH_RETRY_DELAYS_MS[attempt]);
      }
    })
    .catch((error) => dispatch(agentActions.failed(error instanceof Error ? error.message : String(error))));
}

function isAgentConnectionEvent(event: MemmyAgentWsEvent): boolean {
  return event.event === "ready" || event.event === "attached" || event.event === "error" || event.event === "transport_error" || event.event === "connection_closed";
}

let agentHistoryRequestCounter = 0;
let agentSessionsRequestCounter = 0;

function nextAgentHistoryRequestId(chatId: string): string {
  agentHistoryRequestCounter += 1;
  return `${chatId}-${agentHistoryRequestCounter}`;
}

function nextAgentSessionsRequestId(reason: NonNullable<RefreshAgentTaskListOptions["reason"]>): string {
  agentSessionsRequestCounter += 1;
  return `${reason}-${agentSessionsRequestCounter}`;
}
