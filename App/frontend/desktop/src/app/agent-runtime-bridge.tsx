/** Agent runtime bridge module. */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  MemmyAgentRequestError,
  type MemmyAgentClient,
  type MemmyAgentRunStatusSnapshot,
  type MemmyAgentUnsubscribe,
  type MemmyAgentWebSocketConnection,
  type MemmyAgentWsEvent
} from "../api/memmy-agent-client.js";
import { agentActions, createAgentOperationError, type AppAction } from "../state/app-actions.js";
import type { AgentState } from "../state/agent-chat-slice.js";
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
const AGENT_RECOVERY_DEADLINE_MS = 8_000;
const AGENT_OPERATION_ERROR_DISMISS_MS = 5_000;

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
  const operationErrorTimersRef = useRef<Record<"chat" | "sidebar", ReturnType<typeof setTimeout> | null>>({
    chat: null,
    sidebar: null
  });
  const agentStateRef = useRef(state.agent);
  agentStateRef.current = state.agent;

  const clearConnectRetryTimer = useCallback((): void => {
    if (retryTimerRef.current) {
      globalThis.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const cleanupConnection = useCallback((): void => {
    const hadActiveConnection = Boolean(connectionRef.current || connectInFlightRef.current);
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
    if (hadActiveConnection) {
      dispatch(agentActions.connectionDisposed());
    }
  }, [clearConnectRetryTimer, dispatch]);

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
      nextConnection.onSessionUpdate((chatId, scope, generation) => dispatch(agentActions.wsEventReceived({ event: "session_updated", chat_id: chatId, connection_generation: generation, ...(scope ? { scope } : {}) }))),
      nextConnection.onRuntimeModelUpdate((modelName, modelPreset, generation) => dispatch(agentActions.wsEventReceived({
        event: "runtime_model_updated",
        connection_generation: generation,
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

        connectionRef.current = nextConnection;
        setConnection(nextConnection);
        registerConnectionHandlers(nextConnection);
        connectAttemptRef.current = 0;
        clearConnectRetryTimer();
      } catch (error) {
        if (!isActive) {
          return;
        }
        dispatch(agentActions.connectionFailed(error instanceof Error ? error.message : String(error)));
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
    const client = clients?.memmyAgent;
    const generation = state.agent.recoveringGeneration;
    if (!client || !connection || generation === null) {
      return;
    }

    let cancelled = false;
    const snapshot = agentStateRef.current;
    const chatId = snapshot.recoveringChatId;
    const chatSelectionEpoch = snapshot.recoveringChatSelectionEpoch;
    const deadline = Date.now() + AGENT_RECOVERY_DEADLINE_MS;
    const taskRequestId = nextAgentSessionsRequestId("auto");
    dispatch(agentActions.taskStateLoading({
      requestId: taskRequestId,
      sidebarStateVersionAtStart: snapshot.sidebarStateVersion,
      runStatusVersionAtStartByChatId: { ...snapshot.runStatusVersionByChatId },
      recoveryGeneration: generation
    }));

    const taskRecovery = Promise.all([
      settleByDeadline(client.listSessions(), deadline),
      settleByDeadline(client.readSidebarState(), deadline)
    ]).then(([sessionsResult, sidebarResult]) => {
      if (cancelled) {
        return;
      }
      const failures = [sessionsResult, sidebarResult]
        .filter((result): result is SettledFailure => !result.ok)
        .map((result) => result.message);
      dispatch(agentActions.taskStateSettled({
        requestId: taskRequestId,
        recoveryGeneration: generation,
        ...(sessionsResult.ok ? { sessions: sessionsResult.value } : {}),
        ...(sidebarResult.ok ? { sidebarState: sidebarResult.value } : {}),
        ...(failures.length > 0 ? {
          error: createAgentOperationError({
            source: "recovery",
            message: failures.join("; ")
          })
        } : {})
      }));
    });

    let chatRecovery: Promise<void> = Promise.resolve();
    if (chatId && chatSelectionEpoch !== null
      && snapshot.currentChatId === chatId
      && snapshot.chatSelectionEpoch === chatSelectionEpoch) {
      subscribeAgentChat(connection, chatId);
      const chatRequestId = nextAgentHistoryRequestId(chatId);
      dispatch(agentActions.recoveryChatLoading({
        requestId: chatRequestId,
        generation,
        chatId,
        chatSelectionEpoch,
        runStatusVersionAtStart: snapshot.runStatusVersionByChatId[chatId] ?? 0
      }));
      chatRecovery = recoverAgentChat({
        client,
        connection,
        chatId,
        generation,
        deadline
      }).then((result) => {
        if (cancelled) {
          return;
        }
        const notice = createAgentOperationError({
          source: "recovery",
          message: result.failureMessage ?? "recovery reconciliation",
          chatId
        });
        dispatch(agentActions.recoveryChatSnapshotLoaded({
          requestId: chatRequestId,
          generation,
          chatId,
          chatSelectionEpoch,
          thread: result.thread,
          runSnapshot: result.runSnapshot,
          noticeId: notice.id,
          completedAt: notice.createdAt,
          ...(result.failureMessage ? { failureMessage: result.failureMessage } : {})
        }));
      });
    }

    void Promise.all([taskRecovery, chatRecovery]).finally(() => {
      if (!cancelled) {
        dispatch(agentActions.recoveryFinished(generation));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    clients?.memmyAgent,
    connection,
    dispatch,
    state.agent.recoveringGeneration,
    subscribeAgentChat
  ]);

  useEffect(() => {
    const error = state.agent.operationErrorsBySurface.chat;
    if (error) {
      operationErrorTimersRef.current.chat = globalThis.setTimeout(() => {
        dispatch(agentActions.operationErrorDismissed("chat", error.id));
      }, AGENT_OPERATION_ERROR_DISMISS_MS);
    }
    return () => {
      const timer = operationErrorTimersRef.current.chat;
      if (timer) {
        globalThis.clearTimeout(timer);
        operationErrorTimersRef.current.chat = null;
      }
    };
  }, [dispatch, state.agent.operationErrorsBySurface.chat]);

  useEffect(() => {
    const error = state.agent.operationErrorsBySurface.sidebar;
    if (error) {
      operationErrorTimersRef.current.sidebar = globalThis.setTimeout(() => {
        dispatch(agentActions.operationErrorDismissed("sidebar", error.id));
      }, AGENT_OPERATION_ERROR_DISMISS_MS);
    }
    return () => {
      const timer = operationErrorTimersRef.current.sidebar;
      if (timer) {
        globalThis.clearTimeout(timer);
        operationErrorTimersRef.current.sidebar = null;
      }
    };
  }, [dispatch, state.agent.operationErrorsBySurface.sidebar]);

  useEffect(() => {
    if (!clients?.memmyAgent || !state.agent.refreshRequested || !enabled || state.agent.recoveringGeneration !== null) {
      return;
    }

    for (const [chatId, pending] of Object.entries(state.agent.pendingCanonicalHydrateByChatId)) {
      if (pending && !state.agent.currentHistoryHydrateRequestIdByChatId[chatId]) {
        hydrateAgentThreadInBackground(clients.memmyAgent, dispatch, chatId);
      }
    }

    if (!state.agent.isLoadingSessions) {
      void refreshAgentTaskList(clients.memmyAgent, dispatch, { state: state.agent });
    }
  }, [
    clients?.memmyAgent,
    dispatch,
    enabled,
    state.agent.currentHistoryHydrateRequestIdByChatId,
    state.agent.isLoadingSessions,
    state.agent.pendingCanonicalHydrateByChatId,
    state.agent.recoveringGeneration,
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
    .catch((error) => dispatch(agentActions.historyHydrateFailed(chatId, requestId, createAgentOperationError({
      source: "history",
      message: error instanceof Error ? error.message : String(error),
      chatId
    }))));
}

interface RefreshAgentTaskListOptions {
  expectedChatId?: string;
  reason?: "auto" | "new-chat" | "manual" | "thread";
  attempt?: number;
  state?: Pick<AgentState, "sidebarStateVersion" | "runStatusVersionByChatId">;
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
  dispatch(agentActions.taskStateLoading({
    requestId,
    sidebarStateVersionAtStart: options.state?.sidebarStateVersion ?? 0,
    runStatusVersionAtStartByChatId: { ...(options.state?.runStatusVersionByChatId ?? {}) },
    recoveryGeneration: null
  }));
  void Promise.allSettled([
    client.listSessions(),
    client.readSidebarState()
  ])
    .then(([sessionsResult, sidebarResult]) => {
      const failures = [sessionsResult, sidebarResult]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
      dispatch(agentActions.taskStateSettled({
        requestId,
        recoveryGeneration: null,
        ...(sessionsResult.status === "fulfilled" ? { sessions: sessionsResult.value } : {}),
        ...(sidebarResult.status === "fulfilled" ? { sidebarState: sidebarResult.value } : {}),
        ...(failures.length > 0 ? {
          error: createAgentOperationError({ source: "sessions", message: failures.join("; ") })
        } : {})
      }));
      if (
        options.expectedChatId
        && sessionsResult.status === "fulfilled"
        && !sessionsResult.value.some((session) => session.key === client.chatIdToSessionKey(options.expectedChatId!))
        && attempt < NEW_CHAT_REFRESH_RETRY_DELAYS_MS.length
      ) {
        globalThis.setTimeout(() => refreshAgentTaskList(client, dispatch, {
          ...options,
          attempt: attempt + 1
        }), NEW_CHAT_REFRESH_RETRY_DELAYS_MS[attempt]);
      }
    });
}

function isAgentConnectionEvent(event: MemmyAgentWsEvent): boolean {
  return event.event === "ready"
    || event.event === "attached"
    || (event.event === "error" && !event.chat_id)
    || event.event === "transport_error"
    || event.event === "connection_closed"
    || event.event === "connection_attempt_failed";
}

type SettledSuccess<T> = { ok: true; value: T };
type SettledFailure = { ok: false; message: string; error?: unknown };
type DeadlineResult<T> = SettledSuccess<T> | SettledFailure;

async function settleByDeadline<T>(promise: Promise<T>, deadline: number): Promise<DeadlineResult<T>> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return { ok: false, message: "Agent recovery timed out" };
  }
  return new Promise<DeadlineResult<T>>((resolve) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, message: "Agent recovery timed out" });
      }
    }, remaining);
    void promise.then(
      (value) => {
        if (!settled) {
          settled = true;
          globalThis.clearTimeout(timer);
          resolve({ ok: true, value });
        }
      },
      (error) => {
        if (!settled) {
          settled = true;
          globalThis.clearTimeout(timer);
          resolve({ ok: false, message: error instanceof Error ? error.message : String(error), error });
        }
      }
    );
  });
}

async function recoverAgentChat(input: {
  client: MemmyAgentClient;
  connection: MemmyAgentWebSocketConnection;
  chatId: string;
  generation: number;
  deadline: number;
}): Promise<{
  thread: Awaited<ReturnType<MemmyAgentClient["readWebuiThread"]>> | null;
  runSnapshot: MemmyAgentRunStatusSnapshot | null;
  failureMessage?: string;
}> {
  const runResult = await settleByDeadline(
    input.connection.requestRunStatusSnapshot(input.chatId, input.generation),
    input.deadline
  );
  const threadResult = await settleByDeadline(
    input.client.readWebuiThread(input.client.chatIdToSessionKey(input.chatId)),
    input.deadline
  );
  const thread = threadResult.ok
    ? threadResult.value
    : isMissingThreadFailure(threadResult)
      ? {
          schemaVersion: 1,
          sessionKey: input.client.chatIdToSessionKey(input.chatId),
          last_turn_closed: false,
          messages: []
        }
      : null;
  const failures = [
    ...(runResult.ok ? [] : [`run snapshot: ${runResult.message}`]),
    ...(threadResult.ok || thread ? [] : [`history: ${threadResult.message}`])
  ];
  return {
    thread,
    runSnapshot: runResult.ok ? runResult.value : null,
    ...(failures.length > 0 ? { failureMessage: failures.join("; ") } : {})
  };
}

function isMissingThreadFailure(failure: SettledFailure): boolean {
  return failure.error instanceof MemmyAgentRequestError
    ? failure.error.status === 404
    : /\b404\b/.test(failure.message) || failure.message.toLowerCase().includes("not found");
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
