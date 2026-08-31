/** Agent runtime bridge module. */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  MemmyAgentRequestError,
  type MemmyAgentClient,
  type MemmyAgentProject,
  type MemmyAgentRunStatusSnapshot,
  type MemmyAgentSidebarState,
  type MemmyAgentUnsubscribe,
  type MemmyAgentWebSocketConnection,
  type MemmyAgentWsEvent
} from "../api/memmy-agent-client.js";
import { agentActions, appActions, createAgentOperationError, type AppAction } from "../state/app-actions.js";
import { updateSidebarStateForTask, type AgentState } from "../state/agent-chat-slice.js";
import { useAppState } from "../state/app-state.js";
import { useApiClients } from "./providers.js";
import type { AppRoutePath } from "./routes.js";

export interface AgentRuntimeBridgeValue {
  connection: MemmyAgentWebSocketConnection | null;
  ensureChatSubscription(chatId: string): void;
  taskStateCoordinator: AgentTaskStateCoordinator;
}

export type SidebarIntent =
  | {
      id: string;
      kind: "task-patch";
      sessionKey: string;
      patch: {
        pinned?: boolean;
        archived?: boolean;
        title?: string | null;
        tags?: string[];
      };
    }
  | { id: string; kind: "batch-archive"; sessionKeys: string[] }
  | { id: string; kind: "set-collapsed"; groupKey: string; collapsed: boolean }
  | {
      id: string;
      kind: "view-patch";
      patch: Partial<MemmyAgentSidebarState["view"]>;
    };

export interface AgentTaskStateCoordinator {
  refreshTaskState(options?: RefreshAgentTaskListOptions): void;
  focusTask(chatId: string): void;
  mutateProject(operation: ProjectMutationOperation): Promise<ProjectMutationOutcome>;
  enqueueSidebarIntent(intent: SidebarIntent): Promise<void>;
  runWithSidebarSettled<T>(operation: () => Promise<T>): Promise<T>;
  retrySidebarIntents(): void;
  dispose(): void;
}

export type ProjectMutationOperation =
  | {
      kind: "create";
      input: { mode: "blank" | "existing"; path: string; name?: string };
    }
  | {
      kind: "update";
      projectId: string;
      update: { name: string } | { pinned: boolean };
    }
  | { kind: "delete"; projectId: string };

export type ProjectMutationOutcome =
  | {
      status: "committed";
      project: MemmyAgentProject | null;
      deletedSessionKeys: string[];
    }
  | { status: "rejected"; code: string }
  | { status: "unknown" };

type QueuedSidebarIntent = {
  intent: SidebarIntent;
  attempts: number;
  resolve(): void;
  reject(error: unknown): void;
};

const SIDEBAR_INTENT_MAX_ATTEMPTS = 3;
const SIDEBAR_SETTLE_TIMEOUT_MS = 10_000;
const unavailableTaskStateCoordinator: AgentTaskStateCoordinator = {
  refreshTaskState: () => undefined,
  focusTask: () => undefined,
  mutateProject: async () => ({ status: "rejected", code: "agent_gateway_unavailable" }),
  enqueueSidebarIntent: async () => {
    throw new Error("agent_gateway_unavailable");
  },
  runWithSidebarSettled: async (operation) => operation(),
  retrySidebarIntents: () => undefined,
  dispose: () => undefined
};

/** Applies one replayable sidebar mutation to any authoritative server state. */
export function applySidebarIntent(
  state: MemmyAgentSidebarState,
  intent: SidebarIntent
): MemmyAgentSidebarState {
  switch (intent.kind) {
    case "task-patch":
      return updateSidebarStateForTask(state, intent.sessionKey, intent.patch);
    case "batch-archive":
      return {
        ...state,
        archived_keys: [...new Set([...state.archived_keys, ...intent.sessionKeys])]
      };
    case "set-collapsed":
      return updateSidebarStateForTask(state, intent.groupKey, {
        collapsed: intent.collapsed
      });
    case "view-patch":
      return {
        ...state,
        view: {
          ...state.view,
          ...intent.patch
        }
      };
  }
}

function replaySidebarIntents(
  base: MemmyAgentSidebarState,
  queue: readonly QueuedSidebarIntent[]
): MemmyAgentSidebarState {
  return queue.reduce(
    (current, entry) => applySidebarIntent(current, entry.intent),
    base
  );
}

function sidebarIntentAlreadyApplied(
  state: MemmyAgentSidebarState,
  intent: SidebarIntent
): boolean {
  const applied = applySidebarIntent(state, intent);
  return JSON.stringify({ ...applied, updated_at: null })
    === JSON.stringify({ ...state, updated_at: null });
}

function sidebarMutationId(intent: SidebarIntent): string {
  return `sidebar-${intent.id}`;
}

/** Creates the single task/sidebar coordinator for one renderer client lifecycle. */
export function createAgentTaskStateCoordinator(
  client: MemmyAgentClient,
  dispatch: (action: AppAction) => void,
  getAgentState: () => AgentState
): AgentTaskStateCoordinator {
  let disposed = false;
  let acceptingSidebarIntents = true;
  let processingSidebarIntents = false;
  let sidebarQueuePaused = false;
  let confirmedSidebarState = getAgentState().sidebarState;
  const sidebarQueue: QueuedSidebarIntent[] = [];
  const settleWaiters = new Set<(settled: boolean) => void>();
  let focusRequestSequence = 0;
  let projectMutationSequence = 0;
  let projectMutationInFlight = false;
  let refreshInFlight = false;
  let refreshDirtyOptions: RefreshAgentTaskListOptions | null = null;
  let refreshRetryTimer: ReturnType<typeof setTimeout> | null = null;

  function dispatchOptimisticState(): void {
    const head = sidebarQueue[0];
    if (!head || disposed) return;
    dispatch(agentActions.sidebarMutationStarted(
      sidebarMutationId(head.intent),
      replaySidebarIntents(confirmedSidebarState, sidebarQueue)
    ));
  }

  function notifySettled(settled: boolean): void {
    for (const waiter of settleWaiters) waiter(settled);
    settleWaiters.clear();
  }

  function rejectHead(error: unknown): void {
    const head = sidebarQueue.shift();
    if (!head) return;
    head.reject(error);
    dispatch(agentActions.sidebarMutationFailed(
      sidebarMutationId(head.intent),
      replaySidebarIntents(confirmedSidebarState, sidebarQueue),
      createAgentOperationError({
        source: "sidebar",
        message: error instanceof Error ? error.message : String(error)
      })
    ));
    dispatchOptimisticState();
  }

  async function readSidebarForReconciliation(): Promise<MemmyAgentSidebarState | null> {
    try {
      return await client.readSidebarState();
    } catch {
      return null;
    }
  }

  async function processSidebarQueue(): Promise<void> {
    if (
      disposed
      || processingSidebarIntents
      || sidebarQueuePaused
      || sidebarQueue.length === 0
    ) {
      return;
    }
    processingSidebarIntents = true;
    try {
      while (!disposed && !sidebarQueuePaused && sidebarQueue.length > 0) {
        const head = sidebarQueue[0];
        if (!head) break;
        const candidate = applySidebarIntent(confirmedSidebarState, head.intent);
        try {
          const committed = await client.writeSidebarState(
            confirmedSidebarState.updated_at,
            candidate,
            { timeoutMs: SIDEBAR_SETTLE_TIMEOUT_MS }
          );
          confirmedSidebarState = committed;
          sidebarQueue.shift();
          head.resolve();
          dispatch(agentActions.sidebarMutationConfirmed(
            sidebarMutationId(head.intent),
            replaySidebarIntents(confirmedSidebarState, sidebarQueue)
          ));
          dispatchOptimisticState();
        } catch (error) {
          head.attempts += 1;
          if (
            error instanceof MemmyAgentRequestError
            && error.status === 409
            && error.code === "sidebar_state_conflict"
            && error.data?.sidebarState
          ) {
            confirmedSidebarState = error.data.sidebarState;
          } else {
            const reconciled = await readSidebarForReconciliation();
            if (!reconciled) {
              sidebarQueuePaused = true;
              dispatch(agentActions.sidebarMutationFailed(
                sidebarMutationId(head.intent),
                replaySidebarIntents(confirmedSidebarState, sidebarQueue),
                createAgentOperationError({
                  source: "sidebar",
                  message: "sidebar_sync_pending"
                })
              ));
              notifySettled(false);
              break;
            }
            confirmedSidebarState = reconciled;
            if (sidebarIntentAlreadyApplied(reconciled, head.intent)) {
              sidebarQueue.shift();
              head.resolve();
              dispatch(agentActions.sidebarMutationConfirmed(
                sidebarMutationId(head.intent),
                replaySidebarIntents(confirmedSidebarState, sidebarQueue)
              ));
              dispatchOptimisticState();
              continue;
            }
          }

          if (head.attempts >= SIDEBAR_INTENT_MAX_ATTEMPTS) {
            rejectHead(error);
          } else {
            dispatchOptimisticState();
          }
        }
      }
    } finally {
      processingSidebarIntents = false;
      if (!disposed && sidebarQueue.length === 0) notifySettled(true);
    }
  }

  function awaitSidebarSettled(): Promise<boolean> {
    if (sidebarQueue.length === 0) return Promise.resolve(true);
    if (sidebarQueuePaused) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let completed = false;
      const waiter = (settled: boolean): void => {
        if (completed) return;
        completed = true;
        globalThis.clearTimeout(timer);
        resolve(settled);
      };
      const timer = globalThis.setTimeout(() => {
        settleWaiters.delete(waiter);
        waiter(false);
      }, SIDEBAR_SETTLE_TIMEOUT_MS);
      settleWaiters.add(waiter);
    });
  }

  function scheduleCoordinatorRefresh(options: RefreshAgentTaskListOptions): void {
    if (disposed) return;
    if (projectMutationInFlight || refreshInFlight) {
      refreshDirtyOptions = {
        ...(refreshDirtyOptions ?? {}),
        ...options,
        state: options.state ?? refreshDirtyOptions?.state
      };
      return;
    }
    refreshInFlight = true;
    const reason = options.reason ?? "auto";
    const attempt = options.attempt ?? 0;
    const state = options.state ?? getAgentState();
    const requestId = nextAgentSessionsRequestId(reason);
    dispatch(agentActions.taskStateLoading({
      requestId,
      sidebarStateVersionAtStart: state.sidebarStateVersion,
      runStatusVersionAtStartByChatId: { ...state.runStatusVersionByChatId },
      recoveryGeneration: null
    }));
    void Promise.allSettled([
      client.getSessionSnapshot({ timeoutMs: 10_000 }),
      client.readSidebarState()
    ]).then(([sessionsResult, sidebarResult]) => {
      if (disposed) return;
      const failures = [sessionsResult, sidebarResult]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason instanceof Error
          ? result.reason.message
          : String(result.reason));
      if (sidebarResult.status === "fulfilled" && sidebarQueue.length === 0) {
        confirmedSidebarState = sidebarResult.value;
      }
      dispatch(agentActions.taskStateSettled({
        requestId,
        recoveryGeneration: null,
        ...(sessionsResult.status === "fulfilled"
          ? { snapshot: sessionsResult.value }
          : {}),
        ...(sidebarResult.status === "fulfilled"
          ? { sidebarState: sidebarResult.value }
          : {}),
        ...(failures.length > 0
          ? {
              error: createAgentOperationError({
                source: "sessions",
                message: failures.join("; ")
              })
            }
          : {})
      }));
      if (
        options.expectedChatId
        && sessionsResult.status === "fulfilled"
        && !sessionsResult.value.sessions.some(
          (session) => session.key === client.chatIdToSessionKey(options.expectedChatId!)
        )
        && attempt < NEW_CHAT_REFRESH_RETRY_DELAYS_MS.length
      ) {
        if (refreshRetryTimer) globalThis.clearTimeout(refreshRetryTimer);
        refreshRetryTimer = globalThis.setTimeout(() => {
          refreshRetryTimer = null;
          scheduleCoordinatorRefresh({ ...options, attempt: attempt + 1 });
        }, NEW_CHAT_REFRESH_RETRY_DELAYS_MS[attempt]);
      }
    }).finally(() => {
      refreshInFlight = false;
      if (disposed || projectMutationInFlight) return;
      const dirty = refreshDirtyOptions;
      refreshDirtyOptions = null;
      if (dirty) scheduleCoordinatorRefresh(dirty);
    });
  }

  const coordinator: AgentTaskStateCoordinator = {
    refreshTaskState(options = {}) {
      if (disposed) return;
      if (sidebarQueuePaused) {
        sidebarQueuePaused = false;
        void processSidebarQueue();
      }
      scheduleCoordinatorRefresh({
        ...options,
        state: options.state ?? getAgentState()
      });
    },
    focusTask(chatId) {
      if (disposed) return;
      focusRequestSequence += 1;
      const sessionKey = client.chatIdToSessionKey(chatId);
      const requestId = `coordinator-focus-${chatId}-${focusRequestSequence}`;
      dispatch(agentActions.historyLoading(sessionKey, chatId, requestId));
      void client.readWebuiThread(sessionKey)
        .then((thread) => dispatch(agentActions.historyLoaded(thread, requestId)))
        .catch((error: unknown) => {
          if (error instanceof MemmyAgentRequestError && error.status === 404) {
            dispatch(agentActions.historyLoaded({
              schemaVersion: 1,
              sessionKey,
              messages: []
            }, requestId));
            return;
          }
          dispatch(agentActions.historyOpenFailed(chatId, requestId, createAgentOperationError({
            source: "history",
            message: error instanceof Error ? error.message : String(error),
            chatId
          })));
        });
      coordinator.refreshTaskState({ reason: "thread" });
    },
    async mutateProject(operation) {
      if (disposed) return { status: "rejected", code: "coordinator_disposed" };
      if (projectMutationInFlight) {
        return { status: "rejected", code: "project_mutation_conflict" };
      }
      projectMutationInFlight = true;
      projectMutationSequence += 1;
      const requestId = `project-mutation-${projectMutationSequence}`;
      const state = getAgentState();
      dispatch(agentActions.taskStateLoading({
        requestId,
        sidebarStateVersionAtStart: state.sidebarStateVersion,
        runStatusVersionAtStartByChatId: { ...state.runStatusVersionByChatId },
        recoveryGeneration: null
      }));
      try {
        if (operation.kind === "create") {
          const result = await client.createProject(operation.input, { timeoutMs: 15_000 });
          if (disposed) return { status: "unknown" };
          dispatch(agentActions.taskStateSettled({
            requestId,
            recoveryGeneration: null,
            snapshot: result.snapshot
          }));
          return {
            status: "committed",
            project: result.project,
            deletedSessionKeys: []
          };
        }
        if (operation.kind === "update") {
          const result = await client.updateProject(
            operation.projectId,
            operation.update,
            { timeoutMs: 15_000 }
          );
          if (disposed) return { status: "unknown" };
          dispatch(agentActions.taskStateSettled({
            requestId,
            recoveryGeneration: null,
            snapshot: result.snapshot
          }));
          return {
            status: "committed",
            project: result.project,
            deletedSessionKeys: []
          };
        }
        const result = await coordinator.runWithSidebarSettled(
          () => client.deleteProject(operation.projectId, { timeoutMs: 30_000 })
        );
        if (disposed) return { status: "unknown" };
        dispatch(agentActions.taskStateSettled({
          requestId,
          recoveryGeneration: null,
          snapshot: result.snapshot
        }));
        return {
          status: "committed",
          project: null,
          deletedSessionKeys: result.deletedSessionKeys
        };
      } catch (error) {
        if (disposed) return { status: "unknown" };
        coordinator.refreshTaskState({ reason: "manual" });
        if (error instanceof MemmyAgentRequestError) {
          return {
            status: "rejected",
            code: error.code ?? "project_operation_failed"
          };
        }
        if (error instanceof Error && error.message === "sidebar_sync_pending") {
          return { status: "rejected", code: "sidebar_sync_pending" };
        }
        return { status: "unknown" };
      } finally {
        projectMutationInFlight = false;
        const dirty = refreshDirtyOptions;
        refreshDirtyOptions = null;
        if (dirty) scheduleCoordinatorRefresh(dirty);
      }
    },
    enqueueSidebarIntent(intent) {
      if (disposed) return Promise.reject(new Error("coordinator_disposed"));
      if (!acceptingSidebarIntents) {
        return Promise.reject(new Error("sidebar_sync_pending"));
      }
      if (sidebarQueue.length === 0 && !processingSidebarIntents) {
        confirmedSidebarState = getAgentState().sidebarState;
      }
      return new Promise<void>((resolve, reject) => {
        sidebarQueue.push({ intent, attempts: 0, resolve, reject });
        dispatchOptimisticState();
        void processSidebarQueue();
      });
    },
    async runWithSidebarSettled(operation) {
      if (disposed) throw new Error("coordinator_disposed");
      acceptingSidebarIntents = false;
      try {
        const settled = await awaitSidebarSettled();
        if (!settled) throw new Error("sidebar_sync_pending");
        return await operation();
      } finally {
        acceptingSidebarIntents = true;
      }
    },
    retrySidebarIntents() {
      if (disposed || sidebarQueue.length === 0) return;
      sidebarQueuePaused = false;
      dispatchOptimisticState();
      void processSidebarQueue();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (refreshRetryTimer) {
        globalThis.clearTimeout(refreshRetryTimer);
        refreshRetryTimer = null;
      }
      const error = new DOMException("Coordinator disposed", "AbortError");
      for (const entry of sidebarQueue.splice(0)) entry.reject(error);
      notifySettled(false);
    }
  };
  return coordinator;
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

export function requestDesyncedAgentQueueSnapshots(
  connection: Pick<MemmyAgentWebSocketConnection, "requestQueueSnapshot">,
  generation: number,
  desyncedByChatId: Record<string, { generation: number; observedRevision: number }>,
  requestedKeys: Set<string>
): void {
  const generationPrefix = `${generation}\0`;
  for (const key of requestedKeys) {
    if (!key.startsWith(generationPrefix)) requestedKeys.delete(key);
  }
  for (const [chatId, desync] of Object.entries(desyncedByChatId)) {
    if (desync.generation !== generation) continue;
    const key = `${generationPrefix}${chatId}\0${desync.observedRevision}`;
    if (requestedKeys.has(key)) continue;
    requestedKeys.add(key);
    try {
      connection.requestQueueSnapshot(chatId, generation);
    } catch {
      // A new connection generation receives an authoritative attach snapshot.
    }
  }
}

/** Checks is agent runtime bridge route. */
export function isAgentRuntimeBridgeRoute(path: AppRoutePath): boolean {
  return path === "/main"
    || path === "/tools"
    || path === "/settings"
    || path === "/memory"
    || path === "/memory-sources"
    || path === "/plugin";
}

/** Handles agent runtime bridge. */
export function AgentRuntimeBridge(props: {
  children: ReactNode;
  taskStateCoordinator?: AgentTaskStateCoordinator;
}) {
  const { clients } = useApiClients();
  const { state, dispatch } = useAppState();
  const enabled = isAgentRuntimeBridgeRoute(state.navigation.currentPath);
  const connectionRef = useRef<MemmyAgentWebSocketConnection | null>(null);
  const modelCatalogRefreshInFlightRef = useRef(false);
  const modelCatalogRefreshQueuedRef = useRef(false);
  const modelCatalogRefreshVersionRef = useRef(0);
  const [connection, setConnection] = useState<MemmyAgentWebSocketConnection | null>(null);
  const connectionUnsubscribersRef = useRef<MemmyAgentUnsubscribe[]>([]);
  const chatUnsubscribeRef = useRef<MemmyAgentUnsubscribe | null>(null);
  const subscribedChatRef = useRef<string | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectAttemptRef = useRef(0);
  const connectInFlightRef = useRef(false);
  const operationErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueSnapshotRequestKeysRef = useRef(new Set<string>());
  const agentStateRef = useRef(state.agent);
  agentStateRef.current = state.agent;
  const ownedTaskStateCoordinatorRef = useRef<{
    client: MemmyAgentClient;
    coordinator: AgentTaskStateCoordinator;
  } | null>(null);
  if (
    !props.taskStateCoordinator
    && clients?.memmyAgent
    && ownedTaskStateCoordinatorRef.current?.client !== clients.memmyAgent
  ) {
    ownedTaskStateCoordinatorRef.current?.coordinator.dispose();
    ownedTaskStateCoordinatorRef.current = {
      client: clients.memmyAgent,
      coordinator: createAgentTaskStateCoordinator(
        clients.memmyAgent,
        dispatch,
        () => agentStateRef.current
      )
    };
  }
  const taskStateCoordinator = props.taskStateCoordinator
    ?? ownedTaskStateCoordinatorRef.current?.coordinator
    ?? unavailableTaskStateCoordinator;

  const clearConnectRetryTimer = useCallback((): void => {
    if (retryTimerRef.current) {
      globalThis.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const cleanupConnection = useCallback((): void => {
    const hadActiveConnection = Boolean(connectionRef.current || connectInFlightRef.current);
    modelCatalogRefreshVersionRef.current += 1;
    modelCatalogRefreshQueuedRef.current = false;
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
    queueSnapshotRequestKeysRef.current.clear();
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

  const refreshModelCatalog = useCallback(async (): Promise<void> => {
    const agentClient = clients?.memmyAgent;
    const configClient = clients?.config;
    if (!agentClient || !configClient) return;
    modelCatalogRefreshVersionRef.current += 1;
    if (modelCatalogRefreshInFlightRef.current) {
      modelCatalogRefreshQueuedRef.current = true;
      return;
    }
    modelCatalogRefreshInFlightRef.current = true;
    try {
      do {
        modelCatalogRefreshQueuedRef.current = false;
        const version = modelCatalogRefreshVersionRef.current;
        try {
          const [settings, modelConfig] = await Promise.all([
            agentClient.getSettings(),
            configClient.getModelConfig()
          ]);
          if (version === modelCatalogRefreshVersionRef.current) {
            dispatch(agentActions.modelCatalogLoaded(
              settings.model_presets,
              settings.agent.model_preset
            ));
            dispatch(appActions.modelConfigUpdated(modelConfig));
          }
        } catch (error) {
          console.error("Agent model catalog refresh failed:", error);
        }
      } while (modelCatalogRefreshQueuedRef.current);
    } finally {
      modelCatalogRefreshInFlightRef.current = false;
      if (modelCatalogRefreshQueuedRef.current) {
        void refreshModelCatalog();
      }
    }
  }, [clients?.config, clients?.memmyAgent, dispatch]);

  const registerConnectionHandlers = useCallback((nextConnection: MemmyAgentWebSocketConnection): void => {
    connectionUnsubscribersRef.current = [
      nextConnection.onSessionUpdate((chatId, scope, generation) => dispatch(agentActions.wsEventReceived({ event: "session_updated", chat_id: chatId, connection_generation: generation, ...(scope ? { scope } : {}) }))),
      nextConnection.onRunLifecycle((chatId, event) => {
        if (chatId === subscribedChatRef.current) {
          return;
        }
        dispatch(agentActions.wsEventReceived(event));
      })
    ];
  }, [dispatch]);

  useEffect(() => {
    return () => {
      if (!props.taskStateCoordinator) {
        ownedTaskStateCoordinatorRef.current?.coordinator.dispose();
        ownedTaskStateCoordinatorRef.current = null;
      }
    };
  }, [props.taskStateCoordinator]);

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
        await refreshModelCatalog();
        if (!isActive) {
          return;
        }
        dispatch(agentActions.connectionConnecting());
        const nextConnection = await client.connectWebSocket((event) => {
          if (event.event === "model_catalog_updated") {
            modelCatalogRefreshVersionRef.current += 1;
            if (event.status === "invalid") {
              dispatch(agentActions.modelCatalogLoaded([], null));
            } else {
              void refreshModelCatalog();
            }
          }
          if (isAgentConnectionEvent(event)) {
            dispatch(agentActions.wsEventReceived(event));
          }
          if (
            isAgentQueueProjectionEvent(event)
            && event.chat_id !== subscribedChatRef.current
          ) {
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
  }, [cleanupConnection, clearConnectRetryTimer, clients?.memmyAgent, dispatch, enabled, refreshModelCatalog, registerConnectionHandlers]);

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
    if (!connection) return;
    requestDesyncedAgentQueueSnapshots(
      connection,
      state.agent.connectionGeneration,
      state.agent.queueDesyncedByChatId,
      queueSnapshotRequestKeysRef.current
    );
  }, [connection, state.agent.connectionGeneration, state.agent.queueDesyncedByChatId]);

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
      settleByDeadline(client.getSessionSnapshot({ timeoutMs: AGENT_RECOVERY_DEADLINE_MS }), deadline),
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
        ...(sessionsResult.ok ? { snapshot: sessionsResult.value } : {}),
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
    const error = state.agent.operationErrorNotice;
    if (error) {
      operationErrorTimerRef.current = globalThis.setTimeout(() => {
        dispatch(agentActions.operationErrorDismissed("chat", error.id));
      }, AGENT_OPERATION_ERROR_DISMISS_MS);
    }
    return () => {
      const timer = operationErrorTimerRef.current;
      if (timer) {
        globalThis.clearTimeout(timer);
        operationErrorTimerRef.current = null;
      }
    };
  }, [dispatch, state.agent.operationErrorNotice]);

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
      taskStateCoordinator?.refreshTaskState();
    }
  }, [
    clients?.memmyAgent,
    dispatch,
    enabled,
    state.agent.currentHistoryHydrateRequestIdByChatId,
    state.agent.isLoadingSessions,
    state.agent.pendingCanonicalHydrateByChatId,
    state.agent.recoveringGeneration,
    state.agent.refreshRequested,
    taskStateCoordinator
  ]);

  return (
    <AgentRuntimeBridgeContext.Provider value={{
      connection,
      ensureChatSubscription,
      taskStateCoordinator
    }}>
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

/** Returns the runtime bridge when a standalone render is nested beneath it. */
export function useOptionalAgentRuntimeBridge(): AgentRuntimeBridgeValue | null {
  return useContext(AgentRuntimeBridgeContext);
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

export interface RefreshAgentTaskListOptions {
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
    client.getSessionSnapshot({ timeoutMs: 10_000 }),
    client.readSidebarState()
  ])
    .then(([sessionsResult, sidebarResult]) => {
      const failures = [sessionsResult, sidebarResult]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
      dispatch(agentActions.taskStateSettled({
        requestId,
        recoveryGeneration: null,
        ...(sessionsResult.status === "fulfilled" ? { snapshot: sessionsResult.value } : {}),
        ...(sidebarResult.status === "fulfilled" ? { sidebarState: sidebarResult.value } : {}),
        ...(failures.length > 0 ? {
          error: createAgentOperationError({ source: "sessions", message: failures.join("; ") })
        } : {})
      }));
      if (
        options.expectedChatId
        && sessionsResult.status === "fulfilled"
        && !sessionsResult.value.sessions.some((session) => session.key === client.chatIdToSessionKey(options.expectedChatId!))
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

function isAgentQueueProjectionEvent(event: MemmyAgentWsEvent): boolean {
  return event.event === "message_queued"
    || event.event === "message_dequeued"
    || event.event === "message_queue_removed"
    || event.event === "message_queue_snapshot";
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
