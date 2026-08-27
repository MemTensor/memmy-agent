/**
 * memmy-agent chat and sidebar state slice.
 *
 * The reducer in this file keeps protocol-shaped data out of page components:
 * pages dispatch typed actions, and this slice derives task rows and chat
 * messages from REST snapshots plus WebSocket events.
 */
import type {
  MemmyAgentMediaAttachment,
  MemmyAgentModelSelection,
  MemmyAgentModelError,
  MemmyAgentProject,
  MemmyAgentRunStatusSnapshot,
  MemmyAgentSessionSnapshot,
  MemmyAgentSessionSummary,
  MemmyAgentSidebarState,
  MemmyAgentWebuiThread,
  MemmyAgentWsEvent,
  AgentGoalState,
  AgentGoalControlAction,
  WebuiSessionTarget,
  WebuiQueuedMessage,
  ChatModelPreset,
  AgentTurnSource
} from "../api/memmy-agent-client.js";
import {
  chatIdToSessionKey,
  isAgentGoalState,
  isAgentGoalStatus,
  parseAgentTurnSource,
  parseMemmyAgentModelSelection
} from "../api/memmy-agent-client.js";
import type { PendingAttachment } from "./agent-composer-state.js";
import {
  mergeFileEdits,
  mergeToolProgressEvents,
  mergeUniqueToolTraceLines,
  normalizeFileEdits,
  normalizeToolProgressEvents,
  toolTraceLinesFromEvents,
  type AgentFileEdit,
  type AgentToolProgressEvent
} from "./agent-tool-traces.js";

export type AgentConnectionStatus = "idle" | "bootstrapping" | "connecting" | "connected" | "reconnecting" | "error";
export type AgentOperationSurface = "chat" | "sidebar";
export type AgentOperationErrorSource = "sessions" | "sidebar" | "history" | "new-chat" | "send" | "gateway-command" | "recovery" | "queue";
export interface AgentOperationError {
  id: string;
  source: AgentOperationErrorSource;
  message: string;
  chatId?: string;
  scopeKey?: string;
  createdAt: number;
}

export interface AgentTaskStateRequest {
  requestId: string;
  sidebarStateVersionAtStart: number;
  runStatusVersionAtStartByChatId: Record<string, number>;
  recoveryGeneration: number | null;
}

export interface AgentRecoveryChatRequest {
  requestId: string;
  generation: number;
  chatId: string;
  chatSelectionEpoch: number;
  runStatusVersionAtStart: number;
}
/**
 * "narration" is a mid-turn assistant draft: visible text the model streamed
 * before continuing the loop (stream_end with resuming=true). It is part of
 * the turn's activity timeline — kept verbatim, rendered inside the activity
 * cluster — while the final answer stays the only standalone answer bubble.
 */
export type AgentMessageKind = "message" | "trace" | "narration" | "context_compaction";
export type AgentCompactionStatus = "running" | "done" | "error";
export type AgentChatMediaKind = "image" | "video" | "file";
export type AgentChatMediaAttachment = {
  kind: AgentChatMediaKind;
  url?: string;
  name?: string;
  path?: string;
};
export type { AgentGoalState } from "../api/memmy-agent-client.js";

export interface AgentTaskView {
  sessionKey: string;
  chatId: string;
  title: string;
  preview: string;
  updatedAt: string | null;
  runStartedAt: number | null;
  completedUnseen: boolean;
  pinned: boolean;
  archived: boolean;
  tags: string[];
  projectId: string | null;
  groupProjectId: string | null;
  cwd: string;
  missingProject: boolean;
}

interface OptimisticAgentTask {
  content: string;
  createdAt: string;
  target: WebuiSessionTarget;
}

export interface AgentChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  turnId?: string;
  kind?: AgentMessageKind;
  reasoning?: string;
  reasoningStreaming?: boolean;
  media?: AgentChatMediaAttachment[];
  traces?: string[];
  toolEvents?: AgentToolProgressEvent[];
  fileEdits?: AgentFileEdit[];
  activitySegmentId?: string;
  compactionId?: string;
  compactionStatus?: AgentCompactionStatus;
  createdAt?: number;
  latencyMs?: number;
  isStreaming?: boolean;
  stoppedByUser?: boolean;
  modelError?: MemmyAgentModelError;
  clientRequestId?: string;
  queueSteerPending?: boolean;
}

export type AgentQueuedMessage = {
  clientRequestId: string;
  content: string;
  media: AgentChatMediaAttachment[];
  queuedAt: number;
  source: AgentTurnSource;
  queueSurface: "chat_composer" | null;
  turnAdmission?: "steer";
  turnId?: string;
  status: "queued" | "removing" | "steering";
};

export type AgentQueueDesync = {
  generation: number;
  observedRevision: number;
};

export interface AgentRetryWaitStatus {
  id: string;
  chatId: string;
  turnId?: string;
  anchorMessageId?: string;
  text: string;
  isRunning: boolean;
  createdAt: number;
  updatedAt: number;
  stoppedByUser?: boolean;
}

export type AgentGoalRunClock = {
  goalId: string;
  turnId: string | null;
  startedAt: number;
  baseSeconds: number;
};

export interface AgentState {
  connectionStatus: AgentConnectionStatus;
  connectionError: string | null;
  operationErrorNotice: AgentOperationError | null;
  operationErrorsBySurface: Record<AgentOperationSurface, AgentOperationError | null>;
  connectionGeneration: number;
  hasConnectedSinceStartup: boolean;
  recoveringGeneration: number | null;
  recoveringChatId: string | null;
  recoveringChatSelectionEpoch: number | null;
  recoveryKind: "initial" | "reconnect" | null;
  lastRecoveredGeneration: number;
  chatSelectionEpoch: number;
  modelName: string | null;
  modelPresets: ChatModelPreset[];
  defaultModelPreset: string | null;
  committedModelSelectionByScope: Record<string, MemmyAgentModelSelection | null>;
  pendingPresetByScope: Partial<Record<string, string | null>>;
  pendingModelCommitByRequestId: Record<string, {
    scopeKey: string;
    chatId: string | null;
    presetId: string | null;
  }>;
  chatViewVisible: boolean;
  currentChatId: string | null;
  currentSessionKey: string | null;
  projectRegistryState: "ready" | "corrupt";
  projects: MemmyAgentProject[];
  sessions: MemmyAgentSessionSummary[];
  sidebarState: MemmyAgentSidebarState;
  sidebarStateVersion: number;
  currentSidebarMutationId: string | null;
  currentTaskStateRequest: AgentTaskStateRequest | null;
  currentRecoveryChatRequest: AgentRecoveryChatRequest | null;
  tasks: AgentTaskView[];
  messages: AgentChatMessage[];
  messagesByChatId: Record<string, AgentChatMessage[]>;
  queuedMessagesByChatId: Record<string, AgentQueuedMessage[]>;
  queueRevisionByChatId: Record<string, number>;
  queueDesyncedByChatId: Record<string, AgentQueueDesync>;
  retryWaitStatusByChatId: Record<string, AgentRetryWaitStatus | undefined>;
  historyVersionByChatId: Record<string, number>;
  pendingCanonicalHydrateByChatId: Record<string, boolean>;
  currentHistoryRequestIdByChatId: Record<string, string>;
  currentHistoryHydrateRequestIdByChatId: Record<string, string>;
  currentSessionsRequestId: string | null;
  runStartedAtByChatId: Record<string, number | null>;
  runStatusVersionByChatId: Record<string, number>;
  currentSessionsRequestRunStatusVersionByChatId: Record<string, number> | null;
  activeTurnIdByChatId: Record<string, string | null>;
  activeTurnSourceByChatId: Record<string, AgentTurnSource | null>;
  closedTurnIdsByChatId: Record<string, Record<string, "stopped" | "ended">>;
  optimisticSendingByChatId: Record<string, boolean>;
  deliveryUncertainByChatId: Record<string, boolean>;
  stopInFlightByChatId: Record<string, boolean>;
  suppressAssistantStreamUntilTurnEndByChatId: Record<string, boolean>;
  optimisticTasksByChatId: Record<string, OptimisticAgentTask>;
  completedUnseenByChatId: Record<string, number>;
  // Agent chat slice module.
  // Last task completion.
  lastTaskCompletion: { chatId: string; at: number } | null;
  goalStatesByChatId: Record<string, AgentGoalState>;
  goalState: AgentGoalState | null;
  goalRunClockByChatId: Record<string, AgentGoalRunClock | null>;
  goalMutationPendingByChatId: Record<string, {
    requestId: string;
    goalId: string;
    action: AgentGoalControlAction;
  }>;
  composerDraftsByScope: Record<string, string>;
  composerPendingAttachmentsByScope: Record<string, PendingAttachment[]>;
  draftTargetsByScope: Record<string, WebuiSessionTarget>;
  draftTargetRevisionByScope: Record<string, number>;
  messageSendInFlightByScope: Record<string, string>;
  isLoadingSessions: boolean;
  isLoadingHistory: boolean;
  isSending: boolean;
  isRestarting: boolean;
  restartStartedAt: number | null;
  restartSawDisconnect: boolean;
  restartCompletedAt: number | null;
  restartError: string | null;
  refreshRequested: boolean;
  newChatRequestId: number;
  blankDraftActive: boolean;
}

export type AgentAction =
  | { type: "agent/bootstrapStarted" }
  | { type: "agent/bootstrapSucceeded"; modelName: string | null }
  | { type: "agent/modelCatalogLoaded"; presets: ChatModelPreset[]; defaultPreset: string | null }
  | { type: "agent/pendingModelPresetUpdated"; scopeKey: string; preset: string | null }
  | { type: "agent/pendingModelPresetCleared"; scopeKey: string }
  | { type: "agent/modelSelectionRequestStarted"; scopeKey: string; chatId: string | null; clientRequestId: string; presetId: string | null }
  | { type: "agent/modelSelectionRequestCancelled"; clientRequestId: string }
  | { type: "agent/connectionConnecting" }
  | { type: "agent/connectionFailed"; message: string }
  | { type: "agent/connectionDisposed" }
  | { type: "agent/chatViewVisibilityChanged"; visible: boolean }
  | { type: "agent/operationFailed"; surface: AgentOperationSurface; error: AgentOperationError }
  | { type: "agent/operationErrorDismissed"; surface: AgentOperationSurface; id: string }
  | { type: "agent/sessionsLoading"; requestId?: string }
  | { type: "agent/sessionsLoaded"; sessions: MemmyAgentSessionSummary[]; requestId?: string }
  | { type: "agent/sessionSnapshotApplied"; snapshot: MemmyAgentSessionSnapshot }
  | { type: "agent/sessionsLoadFailed"; requestId?: string }
  | { type: "agent/sidebarStateLoaded"; sidebarState: MemmyAgentSidebarState }
  | { type: "agent/sidebarStateSaved"; sidebarState: MemmyAgentSidebarState }
  | { type: "agent/sidebarMutationStarted"; mutationId: string; sidebarState: MemmyAgentSidebarState }
  | { type: "agent/sidebarMutationConfirmed"; mutationId: string; sidebarState: MemmyAgentSidebarState }
  | { type: "agent/sidebarMutationFailed"; mutationId: string; sidebarState: MemmyAgentSidebarState; error: AgentOperationError }
  | { type: "agent/taskStateLoading"; request: AgentTaskStateRequest }
  | { type: "agent/taskStateSettled"; requestId: string; recoveryGeneration: number | null; snapshot?: MemmyAgentSessionSnapshot; sessions?: MemmyAgentSessionSummary[]; sidebarState?: MemmyAgentSidebarState; error?: AgentOperationError }
  | { type: "agent/historyLoading"; sessionKey: string; chatId: string; requestId: string }
  | { type: "agent/historyLoaded"; thread: MemmyAgentWebuiThread; requestId: string }
  | { type: "agent/historyOpenMissing"; sessionKey: string; chatId: string; requestId: string }
  | { type: "agent/historyOpenFailed"; chatId: string; requestId: string; error: AgentOperationError }
  | { type: "agent/historyHydrateLoading"; sessionKey: string; chatId: string; requestId: string }
  | { type: "agent/historyHydrateLoaded"; thread: MemmyAgentWebuiThread; requestId: string }
  | { type: "agent/historyHydrateFailed"; chatId: string; requestId: string; error?: AgentOperationError }
  | { type: "agent/newChatRequested" }
  | { type: "agent/blankDraftReopened" }
  | { type: "agent/newChatCreated"; chatId: string }
  | { type: "agent/transientSendFailed"; chatId: string }
  | { type: "agent/userMessageQueued"; chatId: string; content: string; media?: AgentChatMediaAttachment[]; focus?: boolean; deliveryUncertain?: boolean; target?: WebuiSessionTarget; clientRequestId?: string }
  | { type: "agent/queueItemRemoveStarted"; chatId: string; clientRequestId: string }
  | { type: "agent/queueItemRemoveFailed"; chatId: string; clientRequestId: string; error: AgentOperationError }
  | { type: "agent/queueItemSteerStarted"; chatId: string; clientRequestId: string }
  | { type: "agent/queueItemSteerReset"; chatId: string; clientRequestId: string }
  | { type: "agent/queueItemSteerFailed"; chatId: string; clientRequestId: string; error: AgentOperationError }
  | { type: "agent/composerDraftUpdated"; scopeKey: string; value: string }
  | { type: "agent/composerPendingAttachmentsUpdated"; scopeKey: string; attachments: PendingAttachment[] }
  | { type: "agent/draftTargetUpdated"; scopeKey: string; target: WebuiSessionTarget }
  | { type: "agent/messageSendLockUpdated"; scopeKey: string; clientRequestId: string | null }
  | { type: "agent/tasksMarkedRead"; chatIds: string[] }
  | { type: "agent/composerScopeCleared"; scopeKey: string }
  | { type: "agent/stopRequested"; chatId: string }
  | { type: "agent/stopUnconfirmed"; chatId: string }
  | { type: "agent/goalMutationStarted"; chatId: string; requestId: string; goalId: string; action: AgentGoalControlAction }
  | { type: "agent/goalMutationSettled"; chatId: string; requestId: string }
  | { type: "agent/restartRequested"; startedAt: number }
  | { type: "agent/restartRestored"; chatId: string; startedAt: number; sawDisconnect: boolean }
  | { type: "agent/restartFailed"; message: string }
  | { type: "agent/recoveryChatLoading"; request: AgentRecoveryChatRequest }
  | { type: "agent/recoveryChatSnapshotLoaded"; requestId: string; generation: number; chatId: string; chatSelectionEpoch: number; thread: MemmyAgentWebuiThread | null; runSnapshot: MemmyAgentRunStatusSnapshot | null; noticeId: string; completedAt: number; failureMessage?: string }
  | { type: "agent/recoveryFinished"; generation: number }
  | { type: "agent/wsEvent"; event: MemmyAgentWsEvent };

export const defaultAgentSidebarState: MemmyAgentSidebarState = {
  schema_version: 1,
  pinned_keys: [],
  archived_keys: [],
  title_overrides: {},
  tags_by_key: {},
  collapsed_groups: {},
  view: {
    density: "comfortable",
    show_previews: false,
    show_timestamps: false,
    show_archived: false,
    show_project_archived: false,
    sort: "updated_desc"
  },
  updated_at: null
};

export const initialAgentState: AgentState = {
  connectionStatus: "idle",
  connectionError: null,
  operationErrorNotice: null,
  operationErrorsBySurface: { chat: null, sidebar: null },
  connectionGeneration: 0,
  hasConnectedSinceStartup: false,
  recoveringGeneration: null,
  recoveringChatId: null,
  recoveringChatSelectionEpoch: null,
  recoveryKind: null,
  lastRecoveredGeneration: 0,
  chatSelectionEpoch: 0,
  modelName: null,
  modelPresets: [],
  defaultModelPreset: null,
  committedModelSelectionByScope: {},
  pendingPresetByScope: {},
  pendingModelCommitByRequestId: {},
  chatViewVisible: false,
  currentChatId: null,
  currentSessionKey: null,
  projectRegistryState: "ready",
  projects: [],
  sessions: [],
  sidebarState: defaultAgentSidebarState,
  sidebarStateVersion: 0,
  currentSidebarMutationId: null,
  currentTaskStateRequest: null,
  currentRecoveryChatRequest: null,
  tasks: [],
  messages: [],
  messagesByChatId: {},
  queuedMessagesByChatId: {},
  queueRevisionByChatId: {},
  queueDesyncedByChatId: {},
  retryWaitStatusByChatId: {},
  historyVersionByChatId: {},
  pendingCanonicalHydrateByChatId: {},
  currentHistoryRequestIdByChatId: {},
  currentHistoryHydrateRequestIdByChatId: {},
  currentSessionsRequestId: null,
  runStartedAtByChatId: {},
  runStatusVersionByChatId: {},
  currentSessionsRequestRunStatusVersionByChatId: null,
  activeTurnIdByChatId: {},
  activeTurnSourceByChatId: {},
  closedTurnIdsByChatId: {},
  optimisticSendingByChatId: {},
  deliveryUncertainByChatId: {},
  stopInFlightByChatId: {},
  suppressAssistantStreamUntilTurnEndByChatId: {},
  optimisticTasksByChatId: {},
  completedUnseenByChatId: {},
  lastTaskCompletion: null,
  goalStatesByChatId: {},
  goalState: null,
  goalRunClockByChatId: {},
  goalMutationPendingByChatId: {},
  composerDraftsByScope: {},
  composerPendingAttachmentsByScope: {},
  draftTargetsByScope: {},
  draftTargetRevisionByScope: {},
  messageSendInFlightByScope: {},
  isLoadingSessions: false,
  isLoadingHistory: false,
  isSending: false,
  isRestarting: false,
  restartStartedAt: null,
  restartSawDisconnect: false,
  restartCompletedAt: null,
  restartError: null,
  refreshRequested: false,
  newChatRequestId: 0,
  blankDraftActive: false
};

let agentWsOperationErrorCounter = 0;

export function agentReducer(state: AgentState, action: AgentAction): AgentState {
  switch (action.type) {
    case "agent/bootstrapStarted":
      return { ...state, connectionStatus: "bootstrapping", connectionError: null };
    case "agent/bootstrapSucceeded":
      return { ...state, modelName: action.modelName, connectionError: null };
    case "agent/modelCatalogLoaded":
      return reconcileModelCatalog(state, action.presets, action.defaultPreset);
    case "agent/pendingModelPresetUpdated":
      return {
        ...state,
        pendingPresetByScope: {
          ...state.pendingPresetByScope,
          [action.scopeKey]: action.preset
        }
      };
    case "agent/pendingModelPresetCleared":
      return {
        ...state,
        pendingPresetByScope: clearChatMapValue(
          state.pendingPresetByScope,
          action.scopeKey
        )
      };
    case "agent/modelSelectionRequestStarted":
      return {
        ...state,
        pendingModelCommitByRequestId: {
          ...state.pendingModelCommitByRequestId,
          [action.clientRequestId]: {
            scopeKey: action.scopeKey,
            chatId: action.chatId,
            presetId: action.presetId
          }
        }
      };
    case "agent/modelSelectionRequestCancelled":
      return {
        ...state,
        pendingModelCommitByRequestId: clearChatMapValue(
          state.pendingModelCommitByRequestId,
          action.clientRequestId
        )
      };
    case "agent/connectionConnecting":
      return { ...state, connectionStatus: "connecting", connectionError: null };
    case "agent/connectionFailed":
      return {
        ...state,
        connectionStatus: state.lastRecoveredGeneration > 0 ? "reconnecting" : "error",
        connectionError: action.message
      };
    case "agent/connectionDisposed":
      return {
        ...state,
        connectionStatus: "idle",
        connectionError: null,
        connectionGeneration: 0,
        recoveringGeneration: null,
        recoveringChatId: null,
        recoveringChatSelectionEpoch: null,
        recoveryKind: null,
        lastRecoveredGeneration: 0,
        currentTaskStateRequest: null,
        currentRecoveryChatRequest: null,
        currentSessionsRequestId: null,
        currentSessionsRequestRunStatusVersionByChatId: null,
        currentHistoryRequestIdByChatId: {},
        currentHistoryHydrateRequestIdByChatId: {},
        queuedMessagesByChatId: {},
        queueRevisionByChatId: {},
        queueDesyncedByChatId: {},
        isLoadingSessions: false,
        isLoadingHistory: false
      };
    case "agent/chatViewVisibilityChanged":
      return updateChatViewVisibility(state, action.visible);
    case "agent/operationFailed":
      return setOperationError(state, action.surface, action.error);
    case "agent/operationErrorDismissed":
      if (state.operationErrorNotice?.id !== action.id) return state;
      return {
        ...state,
        operationErrorNotice: null,
        operationErrorsBySurface: {
          chat: state.operationErrorsBySurface.chat?.id === action.id
            ? null
            : state.operationErrorsBySurface.chat,
          sidebar: state.operationErrorsBySurface.sidebar?.id === action.id
            ? null
            : state.operationErrorsBySurface.sidebar
        }
      };
    case "agent/sessionsLoading":
      return {
        ...state,
        isLoadingSessions: true,
        currentSessionsRequestRunStatusVersionByChatId: { ...state.runStatusVersionByChatId },
        ...(action.requestId ? { currentSessionsRequestId: action.requestId } : {})
      };
    case "agent/sessionsLoaded":
      return completeSessionsLoad(state, action.sessions, action.requestId);
    case "agent/sessionSnapshotApplied":
      return completeSessionSnapshotLoad(state, action.snapshot);
    case "agent/sessionsLoadFailed":
      return failSessionsLoad(state, action.requestId);
    case "agent/sidebarStateLoaded":
    case "agent/sidebarStateSaved":
      return deriveTasks({ ...state, sidebarState: action.sidebarState });
    case "agent/sidebarMutationStarted":
      return deriveTasks({
        ...state,
        sidebarState: action.sidebarState,
        sidebarStateVersion: state.sidebarStateVersion + 1,
        currentSidebarMutationId: action.mutationId
      });
    case "agent/sidebarMutationConfirmed":
      return state.currentSidebarMutationId === action.mutationId
        ? deriveTasks({
            ...state,
            sidebarState: action.sidebarState,
            sidebarStateVersion: state.sidebarStateVersion + 1,
            currentSidebarMutationId: null
          })
        : state;
    case "agent/sidebarMutationFailed":
      return state.currentSidebarMutationId === action.mutationId
        ? setOperationError(deriveTasks({
            ...state,
            sidebarState: action.sidebarState,
            sidebarStateVersion: state.sidebarStateVersion + 1,
            currentSidebarMutationId: null
          }), "sidebar", action.error)
        : state;
    case "agent/taskStateLoading":
      return {
        ...state,
        isLoadingSessions: true,
        currentTaskStateRequest: action.request
      };
    case "agent/taskStateSettled":
      return settleTaskState(state, action);
    case "agent/historyLoading":
      return beginHistoryLoad(state, action.sessionKey, action.chatId, action.requestId);
    case "agent/historyLoaded":
      return completeHistoryLoad(state, action.thread, action.requestId);
    case "agent/historyOpenMissing":
      return completeHistoryOpenMissing(state, action.sessionKey, action.chatId, action.requestId);
    case "agent/historyOpenFailed":
      return failHistoryOpen(state, action.chatId, action.requestId, action.error);
    case "agent/historyHydrateLoading":
      return beginHistoryHydrateLoad(state, action.chatId, action.requestId);
    case "agent/historyHydrateLoaded":
      return completeHistoryHydrateLoad(state, action.thread, action.requestId);
    case "agent/historyHydrateFailed":
      return failHistoryHydrateLoad(state, action.chatId, action.requestId, action.error);
    case "agent/newChatRequested":
      return enterBlankDraft(state, state.newChatRequestId + 1);
    case "agent/blankDraftReopened":
      return enterBlankDraft(state, state.newChatRequestId);
    case "agent/newChatCreated":
      return switchCurrentChat({ ...state, blankDraftActive: false }, action.chatId, chatIdToSessionKey(action.chatId));
    case "agent/transientSendFailed":
      return clearTransientSend(state, action.chatId);
    case "agent/userMessageQueued":
      return queueOptimisticUserMessage(state, action);
    case "agent/queueItemRemoveStarted":
      return updateQueuedMessageStatus(state, action.chatId, action.clientRequestId, "removing");
    case "agent/queueItemRemoveFailed":
      return setOperationError(
        updateQueuedMessageStatus(state, action.chatId, action.clientRequestId, "queued"),
        "chat",
        action.error
      );
    case "agent/queueItemSteerStarted":
      return updateQueuedMessageStatus(state, action.chatId, action.clientRequestId, "steering");
    case "agent/queueItemSteerReset":
      return updateQueuedMessageStatus(state, action.chatId, action.clientRequestId, "queued");
    case "agent/queueItemSteerFailed":
      return setOperationError(
        updateQueuedMessageStatus(state, action.chatId, action.clientRequestId, "queued"),
        "chat",
        action.error
      );
    case "agent/composerDraftUpdated":
      return updateComposerDraft(state, action.scopeKey, action.value);
    case "agent/composerPendingAttachmentsUpdated":
      return updateComposerPendingAttachments(state, action.scopeKey, action.attachments);
    case "agent/draftTargetUpdated":
      return {
        ...state,
        draftTargetsByScope: { ...state.draftTargetsByScope, [action.scopeKey]: action.target },
        draftTargetRevisionByScope: {
          ...state.draftTargetRevisionByScope,
          [action.scopeKey]: (state.draftTargetRevisionByScope[action.scopeKey] ?? 0) + 1
        }
      };
    case "agent/messageSendLockUpdated":
      return {
        ...state,
        messageSendInFlightByScope: action.clientRequestId
          ? { ...state.messageSendInFlightByScope, [action.scopeKey]: action.clientRequestId }
          : clearChatMapValue(state.messageSendInFlightByScope, action.scopeKey)
      };
    case "agent/tasksMarkedRead": {
      const completedUnseenByChatId = { ...state.completedUnseenByChatId };
      for (const chatId of action.chatIds) delete completedUnseenByChatId[chatId];
      return deriveTasks({ ...state, completedUnseenByChatId });
    }
    case "agent/composerScopeCleared":
      return clearComposerScope(state, action.scopeKey);
    case "agent/stopRequested":
      return stopCurrentTurn(state, action.chatId);
    case "agent/stopUnconfirmed":
      return releaseUnconfirmedStop(state, action.chatId);
    case "agent/goalMutationStarted":
      return {
        ...state,
        goalMutationPendingByChatId: {
          ...state.goalMutationPendingByChatId,
          [action.chatId]: {
            requestId: action.requestId,
            goalId: action.goalId,
            action: action.action
          }
        }
      };
    case "agent/goalMutationSettled": {
      const pending = state.goalMutationPendingByChatId[action.chatId];
      if (!pending || pending.requestId !== action.requestId) return state;
      return {
        ...state,
        goalMutationPendingByChatId: clearChatMapValue(state.goalMutationPendingByChatId, action.chatId)
      };
    }
    case "agent/restartRequested":
      return {
        ...state,
        isRestarting: true,
        restartStartedAt: action.startedAt,
        restartSawDisconnect: false,
        restartCompletedAt: null,
        restartError: null
      };
    case "agent/restartRestored":
      return {
        ...switchCurrentChat(state, action.chatId, chatIdToSessionKey(action.chatId)),
        isRestarting: true,
        restartStartedAt: action.startedAt,
        restartSawDisconnect: action.sawDisconnect,
        restartCompletedAt: null,
        restartError: null
      };
    case "agent/restartFailed":
      return {
        ...state,
        isRestarting: false,
        restartSawDisconnect: false,
        restartError: action.message
      };
    case "agent/recoveryChatLoading":
      return beginRecoveryChatLoad(state, action.request);
    case "agent/recoveryChatSnapshotLoaded":
      return completeRecoveryChatLoad(state, action);
    case "agent/recoveryFinished":
      return finishRecovery(state, action.generation);
    case "agent/wsEvent":
      return reduceWsEvent(state, action.event);
    default:
      return state;
  }
}

function setOperationError(
  state: AgentState,
  surface: AgentOperationSurface,
  error: AgentOperationError | null
): AgentState {
  if (
    error
    && state.operationErrorNotice
    && isBackgroundOperationError(error)
    && !isBackgroundOperationError(state.operationErrorNotice)
  ) {
    return state;
  }
  return {
    ...state,
    operationErrorNotice: error,
    operationErrorsBySurface: {
      ...state.operationErrorsBySurface,
      [surface]: error
    }
  };
}

function isBackgroundOperationError(error: AgentOperationError): boolean {
  return error.source === "sessions" || error.source === "recovery";
}

function operationErrorFromEvent(event: MemmyAgentWsEvent, source: AgentOperationErrorSource): AgentOperationError {
  const generation = event.connection_generation ?? 0;
  const message = event.reason ?? event.detail ?? "memmy-agent error";
  const createdAt = Date.now();
  agentWsOperationErrorCounter += 1;
  return {
    id: `${source}-${generation}-${createdAt}-${agentWsOperationErrorCounter}`,
    source,
    message,
    ...(event.chat_id ? { chatId: event.chat_id } : {}),
    createdAt
  };
}

function turnSourceFromWire(value: unknown): AgentTurnSource {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const source = value as Record<string, unknown>;
    if (
      (source.kind === "gui" || source.kind === "tui" || source.kind === "im")
      && typeof source.channel === "string"
      && source.channel.trim()
    ) {
      return { kind: source.kind, channel: source.channel.trim() };
    }
  }
  return { kind: "gui", channel: "websocket" };
}

function queuedMessageFromWire(item: WebuiQueuedMessage): AgentQueuedMessage | null {
  if (
    typeof item.client_request_id !== "string"
    || !item.client_request_id
    || typeof item.text !== "string"
  ) return null;
  const queuedAt = Date.parse(item.queued_at);
  if (!Number.isFinite(queuedAt)) return null;
  return {
    clientRequestId: item.client_request_id,
    content: item.text,
    media: normalizeMedia(Array.isArray(item.media_urls) ? item.media_urls : []),
    queuedAt,
    source: turnSourceFromWire(item.source),
    queueSurface: item.queue_surface === "chat_composer" ? "chat_composer" : null,
    ...(item.turn_admission === "steer" ? { turnAdmission: "steer" as const } : {}),
    ...(typeof item.turn_id === "string" && item.turn_id ? { turnId: item.turn_id } : {}),
    status: "queued"
  };
}

function queueRevisionFromEvent(event: MemmyAgentWsEvent): number | null {
  return typeof event.revision === "number"
    && Number.isSafeInteger(event.revision)
    && event.revision >= 0
    ? event.revision
    : null;
}

function clearQueueDesync(state: AgentState, chatId: string): Record<string, AgentQueueDesync> {
  return clearChatMapValue(state.queueDesyncedByChatId, chatId);
}

function markQueueDesynced(
  state: AgentState,
  chatId: string,
  observedRevision: number
): AgentState {
  const current = state.queueDesyncedByChatId[chatId];
  const generation = state.connectionGeneration;
  if (
    current
    && current.generation === generation
    && current.observedRevision >= observedRevision
  ) return state;
  return {
    ...state,
    queueDesyncedByChatId: {
      ...state.queueDesyncedByChatId,
      [chatId]: { generation, observedRevision }
    }
  };
}

function applyQueueIncrement(
  state: AgentState,
  event: MemmyAgentWsEvent,
  apply: (current: AgentState) => AgentState
): AgentState {
  const chatId = event.chat_id;
  if (!chatId) return state;
  const revision = queueRevisionFromEvent(event);
  if (revision === null) return apply(state);
  const currentRevision = state.queueRevisionByChatId[chatId];
  if (currentRevision === undefined || revision > currentRevision + 1) {
    return markQueueDesynced(state, chatId, revision);
  }
  if (revision <= currentRevision || state.queueDesyncedByChatId[chatId]) return state;
  const applied = apply(state);
  return {
    ...applied,
    queueRevisionByChatId: {
      ...applied.queueRevisionByChatId,
      [chatId]: revision
    }
  };
}

function sortedQueuedMessages(items: AgentQueuedMessage[]): AgentQueuedMessage[] {
  return [...items].sort((left, right) => (
    left.queuedAt - right.queuedAt
    || left.clientRequestId.localeCompare(right.clientRequestId)
  ));
}

function setQueuedMessagesForChat(
  state: AgentState,
  chatId: string,
  items: AgentQueuedMessage[]
): AgentState {
  return {
    ...state,
    queuedMessagesByChatId: items.length
      ? { ...state.queuedMessagesByChatId, [chatId]: items }
      : clearChatMapValue(state.queuedMessagesByChatId, chatId)
  };
}

function removeQueuedMessageFromChat(
  state: AgentState,
  chatId: string,
  clientRequestId: string
): { state: AgentState; item: AgentQueuedMessage | null } {
  const items = state.queuedMessagesByChatId[chatId] ?? [];
  const item = items.find((candidate) => candidate.clientRequestId === clientRequestId) ?? null;
  if (!item) return { state, item: null };
  return {
    state: setQueuedMessagesForChat(
      state,
      chatId,
      items.filter((candidate) => candidate.clientRequestId !== clientRequestId)
    ),
    item
  };
}

function updateQueuedMessageStatus(
  state: AgentState,
  chatId: string,
  clientRequestId: string,
  status: AgentQueuedMessage["status"]
): AgentState {
  const items = state.queuedMessagesByChatId[chatId] ?? [];
  let changed = false;
  const next = items.map((item) => {
    if (item.clientRequestId !== clientRequestId || item.status === status) return item;
    changed = true;
    return { ...item, status };
  });
  return changed ? setQueuedMessagesForChat(state, chatId, next) : state;
}

function promoteQueuedMessage(
  state: AgentState,
  chatId: string,
  item: AgentQueuedMessage,
  turnId: string | null = null,
  queueSteerPending = false
): AgentState {
  const removed = removeQueuedMessageFromChat(state, chatId, item.clientRequestId).state;
  if (chatMessagesForId(removed, chatId).some(
    (message) => message.clientRequestId === item.clientRequestId
  )) return removed;
  const promoted = queueOptimisticUserMessage(removed, {
    type: "agent/userMessageQueued",
    chatId,
    content: item.content,
    media: item.media,
    focus: false,
    clientRequestId: item.clientRequestId
  });
  if (!queueSteerPending || !turnId) return promoted;
  const messages = chatMessagesForId(promoted, chatId).map((message) => (
    message.clientRequestId === item.clientRequestId
      ? { ...message, turnId, queueSteerPending: true }
      : message
  ));
  return syncCurrentMessages({
    ...promoted,
    messagesByChatId: { ...promoted.messagesByChatId, [chatId]: messages }
  });
}

function applyQueueSnapshot(state: AgentState, event: MemmyAgentWsEvent): AgentState {
  if (!event.chat_id || !Array.isArray(event.items) || !Array.isArray(event.started_items)) {
    return state;
  }
  const revision = queueRevisionFromEvent(event);
  const currentRevision = state.queueRevisionByChatId[event.chat_id];
  const desync = state.queueDesyncedByChatId[event.chat_id];
  if (revision !== null && currentRevision !== undefined && revision < currentRevision) {
    return state;
  }
  if (
    revision !== null
    && desync?.generation === state.connectionGeneration
    && revision < desync.observedRevision
  ) {
    return state;
  }
  const started = event.started_items
    .map(queuedMessageFromWire)
    .filter((item): item is AgentQueuedMessage => item !== null);
  const startedIds = new Set(started.map((item) => item.clientRequestId));
  const waiting = event.items
    .map(queuedMessageFromWire)
    .filter((item): item is AgentQueuedMessage => item !== null && !startedIds.has(item.clientRequestId));
  let nextState = setQueuedMessagesForChat(state, event.chat_id, sortedQueuedMessages(waiting));
  for (const item of sortedQueuedMessages(started)) {
    nextState = promoteQueuedMessage(
      nextState,
      event.chat_id,
      item,
      item.turnId ?? null,
      item.queueSurface === "chat_composer" && item.turnAdmission === "steer"
    );
  }
  return {
    ...nextState,
    queueRevisionByChatId: revision === null
      ? nextState.queueRevisionByChatId
      : { ...nextState.queueRevisionByChatId, [event.chat_id]: revision },
    queueDesyncedByChatId: clearQueueDesync(nextState, event.chat_id)
  };
}

function rejectQueuedMessage(state: AgentState, event: MemmyAgentWsEvent): AgentState | null {
  const chatId = event.chat_id;
  const clientRequestId = event.client_request_id;
  if (!chatId || !clientRequestId) return null;
  const queued = state.queuedMessagesByChatId[chatId]?.some(
    (item) => item.clientRequestId === clientRequestId
  ) === true;
  const messages = chatMessagesForId(state, chatId);
  const optimistic = messages.some((message) => message.clientRequestId === clientRequestId);
  if (!queued && !optimistic) return null;
  const withoutQueue = removeQueuedMessageFromChat(state, chatId, clientRequestId).state;
  const nextMessages = optimistic
    ? chatMessagesForId(withoutQueue, chatId).filter(
        (message) => message.clientRequestId !== clientRequestId
      )
    : chatMessagesForId(withoutQueue, chatId);
  const messagesByChatId = { ...withoutQueue.messagesByChatId, [chatId]: nextMessages };
  const optimisticSendingByChatId = optimistic
    ? clearChatMapValue(withoutQueue.optimisticSendingByChatId, chatId)
    : withoutQueue.optimisticSendingByChatId;
  const nextState = deriveTasks({
    ...withoutQueue,
    messagesByChatId,
    optimisticSendingByChatId,
    ...(withoutQueue.currentChatId === chatId && !withoutQueue.blankDraftActive
      ? {
          messages: nextMessages,
          isSending: effectiveRunStartedAtForChat(withoutQueue, chatId) !== null
        }
      : {})
  });
  if (event.reason === "turn_queue_cancelled") return nextState;
  return setOperationError(nextState, "chat", operationErrorFromEvent(event, "gateway-command"));
}

function queueOptimisticUserMessage(
  state: AgentState,
  action: Extract<AgentAction, { type: "agent/userMessageQueued" }>
): AgentState {
  const shouldFocus = action.focus !== false;
  const selectedState = shouldFocus
    ? switchCurrentChat(state, action.chatId, chatIdToSessionKey(action.chatId))
    : state;
  const nextState = clearSuppressAssistantStreamUntilTurnEnd(selectedState, action.chatId);
  const now = Date.now();
  const existingMessages = chatMessagesForId(nextState, action.chatId);
  if (
    action.clientRequestId
    && existingMessages.some((message) => message.clientRequestId === action.clientRequestId)
  ) return nextState;
  const message: AgentChatMessage = {
    id: nextMessageId(existingMessages, "user"),
    role: "user",
    content: action.content,
    createdAt: now,
    ...(action.clientRequestId ? { clientRequestId: action.clientRequestId } : {}),
    ...(action.media?.length ? { media: action.media } : {})
  };
  const messages = [...existingMessages, message];
  const messagesByChatId = { ...nextState.messagesByChatId, [action.chatId]: messages };
  const completedUnseenByChatId = clearChatMapValue(nextState.completedUnseenByChatId, action.chatId);
  const retryWaitStatusByChatId = clearChatMapValue(nextState.retryWaitStatusByChatId, action.chatId);
  const deliveryUncertainByChatId = action.deliveryUncertain
    ? { ...nextState.deliveryUncertainByChatId, [action.chatId]: true }
    : clearChatMapValue(nextState.deliveryUncertainByChatId, action.chatId);
  return deriveTasks({
    ...nextState,
    messagesByChatId,
    optimisticSendingByChatId: { ...nextState.optimisticSendingByChatId, [action.chatId]: true },
    optimisticTasksByChatId: maybeAddOptimisticTask(
      nextState,
      action.chatId,
      action.content,
      action.media,
      action.target,
      now
    ),
    completedUnseenByChatId,
    retryWaitStatusByChatId,
    deliveryUncertainByChatId,
    ...(action.chatId === nextState.currentChatId && !nextState.blankDraftActive
      ? { messages, isSending: true }
      : {})
  });
}

function settleTaskState(
  state: AgentState,
  action: Extract<AgentAction, { type: "agent/taskStateSettled" }>
): AgentState {
  const request = state.currentTaskStateRequest;
  if (!request
    || request.requestId !== action.requestId
    || request.recoveryGeneration !== action.recoveryGeneration) {
    return state;
  }

  let nextState: AgentState = {
    ...state,
    currentTaskStateRequest: null,
    isLoadingSessions: false
  };
  if (action.sessions) {
    nextState = completeSessionsLoad({
      ...nextState,
      currentSessionsRequestId: action.requestId,
      currentSessionsRequestRunStatusVersionByChatId: request.runStatusVersionAtStartByChatId
    }, action.sessions, action.requestId);
  }
  if (action.snapshot) {
    nextState = completeSessionSnapshotLoad({
      ...nextState,
      currentSessionsRequestId: action.requestId,
      currentSessionsRequestRunStatusVersionByChatId: request.runStatusVersionAtStartByChatId
    }, action.snapshot, action.requestId);
  }
  if (action.sidebarState && request.sidebarStateVersionAtStart === nextState.sidebarStateVersion) {
    nextState = deriveTasks({ ...nextState, sidebarState: action.sidebarState });
  }
  return action.error ? setOperationError(nextState, "sidebar", action.error) : nextState;
}

function failHistoryOpen(
  state: AgentState,
  chatId: string,
  requestId: string,
  error: AgentOperationError
): AgentState {
  if (state.currentChatId !== chatId || state.currentHistoryRequestIdByChatId[chatId] !== requestId) {
    return state;
  }
  const currentHistoryRequestIdByChatId = { ...state.currentHistoryRequestIdByChatId };
  delete currentHistoryRequestIdByChatId[chatId];
  return setOperationError({
    ...state,
    currentHistoryRequestIdByChatId,
    isLoadingHistory: false
  }, "chat", error);
}

function beginRecoveryChatLoad(state: AgentState, request: AgentRecoveryChatRequest): AgentState {
  if (request.generation !== state.recoveringGeneration
    || request.chatId !== state.currentChatId
    || request.chatSelectionEpoch !== state.chatSelectionEpoch) {
    return state;
  }
  return { ...state, currentRecoveryChatRequest: request, isLoadingHistory: true };
}

function completeRecoveryChatLoad(
  state: AgentState,
  action: Extract<AgentAction, { type: "agent/recoveryChatSnapshotLoaded" }>
): AgentState {
  const request = state.currentRecoveryChatRequest;
  if (!request
    || action.generation !== state.recoveringGeneration
    || request.requestId !== action.requestId
    || request.generation !== action.generation
    || request.chatId !== action.chatId
    || request.chatSelectionEpoch !== action.chatSelectionEpoch
    || state.currentChatId !== action.chatId
    || state.chatSelectionEpoch !== action.chatSelectionEpoch) {
    return state;
  }

  const runVersionChanged = (state.runStatusVersionByChatId[action.chatId] ?? 0) !== request.runStatusVersionAtStart;
  const localMessages = chatMessagesForId(state, action.chatId);
  const snapshotMessages = action.thread ? normalizeThreadMessages(action.thread.messages) : null;
  const localUser = latestUserMessage(localMessages);
  const canonicalUser = snapshotMessages ? latestUserMessage(snapshotMessages) : null;
  const canonicalContainsPendingUser = localUser !== null
    && canonicalUser !== null
    && userPayloadEquivalent(canonicalUser, localUser);
  const recoveryActiveTurnId = state.activeTurnIdByChatId[action.chatId]
    ?? (action.runSnapshot?.status === "running" ? action.runSnapshot.turnId : null);
  const recoveryTurnClosed = action.thread
    ? threadClosesCurrentTurn(action.thread, recoveryActiveTurnId)
    : false;
  const runningSnapshotCompletedBeforeHistory = action.runSnapshot?.status === "running"
    && recoveryTurnClosed
    && canonicalContainsPendingUser
    && !runVersionChanged;
  const idleSnapshotHasClosedHistory = action.runSnapshot?.status === "idle"
    && (!recoveryActiveTurnId || recoveryTurnClosed);
  let nextState: AgentState = { ...state, currentRecoveryChatRequest: null, isLoadingHistory: false };

  if (snapshotMessages
    && !runVersionChanged
    && (idleSnapshotHasClosedHistory || runningSnapshotCompletedBeforeHistory)) {
    nextState = replaceChatMessages(nextState, action.chatId, snapshotMessages);
    nextState = markChatIdle(nextState, action.chatId, {
      source: "session_hydrate",
      turnId: action.thread?.last_turn_id ?? recoveryActiveTurnId,
    });
    nextState = {
      ...nextState,
      deliveryUncertainByChatId: clearChatMapValue(nextState.deliveryUncertainByChatId, action.chatId)
    };
    if (state.deliveryUncertainByChatId[action.chatId] && !canonicalContainsPendingUser) {
      nextState = setOperationError(nextState, "chat", recoveryNotice(
        action.chatId,
        "home.agent.messageNotRecorded",
        action.noticeId,
        action.completedAt
      ));
    } else if (
      canonicalContainsPendingUser
      && isChatBusy(state, action.chatId)
      && !recoveryTurnClosed
    ) {
      nextState = setOperationError(nextState, "chat", recoveryNotice(
        action.chatId,
        "home.agent.executionInterrupted",
        action.noticeId,
        action.completedAt
      ));
    }
  } else if (snapshotMessages) {
    const guardedThread = {
      ...action.thread!,
      last_turn_closed: !runVersionChanged && recoveryTurnClosed,
    };
    nextState = completeHistoryHydrateLoad({
      ...nextState,
      currentHistoryHydrateRequestIdByChatId: {
        ...nextState.currentHistoryHydrateRequestIdByChatId,
        [action.chatId]: action.requestId
      }
    }, guardedThread, action.requestId);
    if (canonicalContainsPendingUser && action.runSnapshot) {
      nextState = {
        ...nextState,
        deliveryUncertainByChatId: clearChatMapValue(nextState.deliveryUncertainByChatId, action.chatId)
      };
    }
  }

  if (action.runSnapshot?.status === "running" && !runVersionChanged && !runningSnapshotCompletedBeforeHistory) {
    nextState = applyRecoveryRunningSnapshot(nextState, action.chatId, action.runSnapshot);
  } else if (action.runSnapshot?.status === "idle" && !runVersionChanged) {
    nextState = markChatIdle(nextState, action.chatId, {
      source: "run_status_snapshot",
      turnId: action.runSnapshot.turnId ?? state.activeTurnIdByChatId[action.chatId] ?? null,
    });
  }

  if (action.failureMessage) {
    nextState = setOperationError(nextState, "chat", recoveryNotice(
      action.chatId,
      action.failureMessage,
      action.noticeId,
      action.completedAt
    ));
  }
  return nextState;
}

function finishRecovery(state: AgentState, generation: number): AgentState {
  if (state.recoveringGeneration !== generation) {
    return state;
  }
  const clearTaskRequest = state.currentTaskStateRequest?.recoveryGeneration === generation;
  const clearChatRequest = state.currentRecoveryChatRequest?.generation === generation;
  const currentChatId = state.currentChatId;
  const hasCurrentNormalHistoryRequest = Boolean(currentChatId && (
    state.currentHistoryRequestIdByChatId[currentChatId]
    || state.currentHistoryHydrateRequestIdByChatId[currentChatId]
  ));
  return {
    ...state,
    recoveringGeneration: null,
    recoveringChatId: null,
    recoveringChatSelectionEpoch: null,
    recoveryKind: null,
    lastRecoveredGeneration: generation,
    ...(clearChatRequest ? { currentRecoveryChatRequest: null } : {}),
    ...(clearTaskRequest ? { currentTaskStateRequest: null, isLoadingSessions: false } : {}),
    ...(clearChatRequest && !hasCurrentNormalHistoryRequest ? { isLoadingHistory: false } : {})
  };
}

function replaceChatMessages(state: AgentState, chatId: string, messages: AgentChatMessage[]): AgentState {
  return {
    ...state,
    messagesByChatId: { ...state.messagesByChatId, [chatId]: messages },
    ...(state.currentChatId === chatId && !state.blankDraftActive ? { messages } : {})
  };
}

function applyRecoveryRunningSnapshot(
  state: AgentState,
  chatId: string,
  snapshot: MemmyAgentRunStatusSnapshot
): AgentState {
  const runStartedAt = snapshot.startedAt ?? Date.now();
  const runningState = markChatRunning(
    state,
    chatId,
    runStartedAt,
    snapshot.turnId,
    snapshot.source
  );
  return deriveTasks({
    ...runningState,
    activeTurnIdByChatId: { ...runningState.activeTurnIdByChatId, [chatId]: snapshot.turnId },
    ...(runningState.currentChatId === chatId ? { isSending: true } : {})
  });
}

function recoveryNotice(chatId: string, message: string, id: string, createdAt: number): AgentOperationError {
  return {
    id,
    source: "recovery",
    message,
    chatId,
    createdAt
  };
}

function userPayloadEquivalent(left: AgentChatMessage, right: AgentChatMessage): boolean {
  if (left.role !== "user" || right.role !== "user" || left.content.trim() !== right.content.trim()) {
    return false;
  }
  const normalizeMedia = (media: AgentChatMediaAttachment[] | undefined) => (media ?? []).map((item) => ({
    path: item.path ?? "",
    url: item.url ?? ""
  }));
  return JSON.stringify(normalizeMedia(left.media)) === JSON.stringify(normalizeMedia(right.media));
}

function updateComposerDraft(state: AgentState, scopeKey: string, value: string): AgentState {
  const currentValue = state.composerDraftsByScope[scopeKey] ?? "";
  if (!value) {
    if (!(scopeKey in state.composerDraftsByScope)) {
      return state;
    }
    const composerDraftsByScope = { ...state.composerDraftsByScope };
    delete composerDraftsByScope[scopeKey];
    return { ...state, composerDraftsByScope };
  }
  if (currentValue === value) {
    return state;
  }
  return {
    ...state,
    composerDraftsByScope: { ...state.composerDraftsByScope, [scopeKey]: value }
  };
}

function updateComposerPendingAttachments(state: AgentState, scopeKey: string, attachments: PendingAttachment[]): AgentState {
  if (!attachments.length) {
    if (!(scopeKey in state.composerPendingAttachmentsByScope)) {
      return state;
    }
    const composerPendingAttachmentsByScope = { ...state.composerPendingAttachmentsByScope };
    delete composerPendingAttachmentsByScope[scopeKey];
    return { ...state, composerPendingAttachmentsByScope };
  }
  if (state.composerPendingAttachmentsByScope[scopeKey] === attachments) {
    return state;
  }
  return {
    ...state,
    composerPendingAttachmentsByScope: {
      ...state.composerPendingAttachmentsByScope,
      [scopeKey]: attachments
    }
  };
}

function clearComposerScope(state: AgentState, scopeKey: string): AgentState {
  const hasDraft = scopeKey in state.composerDraftsByScope;
  const hasPendingAttachments = scopeKey in state.composerPendingAttachmentsByScope;
  const hasTarget = scopeKey in state.draftTargetsByScope;
  const hasTargetRevision = scopeKey in state.draftTargetRevisionByScope;
  const hasSendLock = scopeKey in state.messageSendInFlightByScope;
  if (!hasDraft && !hasPendingAttachments && !hasTarget && !hasTargetRevision && !hasSendLock) {
    return state;
  }

  const composerDraftsByScope = { ...state.composerDraftsByScope };
  const composerPendingAttachmentsByScope = { ...state.composerPendingAttachmentsByScope };
  const draftTargetsByScope = { ...state.draftTargetsByScope };
  const draftTargetRevisionByScope = { ...state.draftTargetRevisionByScope };
  const messageSendInFlightByScope = { ...state.messageSendInFlightByScope };
  delete composerDraftsByScope[scopeKey];
  delete composerPendingAttachmentsByScope[scopeKey];
  delete draftTargetsByScope[scopeKey];
  delete draftTargetRevisionByScope[scopeKey];
  delete messageSendInFlightByScope[scopeKey];
  return {
    ...state,
    composerDraftsByScope,
    composerPendingAttachmentsByScope,
    draftTargetsByScope,
    draftTargetRevisionByScope,
    messageSendInFlightByScope
  };
}

function enterBlankDraft(state: AgentState, newChatRequestId: number): AgentState {
  return {
    ...cacheCurrentMessages(state),
    messages: [],
    currentChatId: null,
    currentSessionKey: null,
    isSending: false,
    isLoadingHistory: false,
    goalState: null,
    blankDraftActive: true,
    chatSelectionEpoch: state.chatSelectionEpoch + 1,
    newChatRequestId
  };
}

export function buildAgentTasks(
  sessions: MemmyAgentSessionSummary[],
  sidebarState: MemmyAgentSidebarState,
  projects: MemmyAgentProject[] = [],
  projectRegistryState: AgentState["projectRegistryState"] = "ready"
): AgentTaskView[] {
  const projectIds = new Set(projects.map((project) => project.id));
  const rows = sessions.map((session) => {
    const chatId = sessionKeyToChatId(session.key);
    const missingProject = projectRegistryState === "ready"
      && session.projectId !== null
      && !projectIds.has(session.projectId);
    return buildTaskView(
      sidebarState,
      session.key,
      chatId,
      session.title?.trim() || session.preview?.trim() || "Untitled task",
      session.preview ?? "",
      session.updatedAt ?? null,
      session.run_started_at ?? null,
      false,
      session.projectId,
      session.cwd,
      missingProject,
      projectRegistryState === "ready" && !missingProject ? session.projectId : null
    );
  });
  rows.sort((left, right) => compareTasks(left, right, sidebarState.view.sort));
  return rows;
}

function buildAgentTasksForState(state: AgentState): AgentTaskView[] {
  const projectIds = new Set(state.projects.map((project) => project.id));
  const canonicalChatIds = new Set(state.sessions.map((session) => sessionKeyToChatId(session.key)));
  const rows = state.sessions.map((session) => {
    const chatId = sessionKeyToChatId(session.key);
    const missingProject = state.projectRegistryState === "ready"
      && session.projectId !== null
      && !projectIds.has(session.projectId);
    return buildTaskView(
      state.sidebarState,
      session.key,
      chatId,
      session.title?.trim() || session.preview?.trim() || "Untitled task",
      session.preview ?? "",
      session.updatedAt ?? null,
      effectiveRunStartedAtForChat(state, chatId),
      isTaskCompletedUnseen(state, chatId),
      session.projectId,
      session.cwd,
      missingProject,
      state.projectRegistryState === "ready" && !missingProject ? session.projectId : null
    );
  });

  for (const [chatId, task] of Object.entries(state.optimisticTasksByChatId)) {
    if (canonicalChatIds.has(chatId)) {
      continue;
    }
    const sessionKey = chatIdToSessionKey(chatId);
    const projectId = task.target.kind === "project" ? task.target.projectId : null;
    const project = projectId
      ? state.projects.find((candidate) => candidate.id === projectId) ?? null
      : null;
    const missingProject = state.projectRegistryState === "ready"
      && projectId !== null
      && project === null;
    rows.push(buildTaskView(
      state.sidebarState,
      sessionKey,
      chatId,
      task.content,
      task.content,
      task.createdAt,
      effectiveRunStartedAtForChat(state, chatId),
      isTaskCompletedUnseen(state, chatId),
      projectId,
      project?.rootPath ?? "",
      missingProject,
      state.projectRegistryState === "ready" && !missingProject ? projectId : null
    ));
  }

  rows.sort((left, right) => compareTasks(left, right, state.sidebarState.view.sort));
  return rows;
}

function buildTaskView(
  sidebarState: MemmyAgentSidebarState,
  sessionKey: string,
  chatId: string,
  fallbackTitle: string,
  preview: string,
  updatedAt: string | null,
  runStartedAt: number | null,
  completedUnseen: boolean,
  projectId: string | null,
  cwd: string,
  missingProject: boolean,
  groupProjectId: string | null
): AgentTaskView {
  const titleOverride = sidebarState.title_overrides[sessionKey];
  return {
    sessionKey,
    chatId,
    title: titleOverride?.trim() || fallbackTitle,
    preview,
    updatedAt,
    runStartedAt,
    completedUnseen,
    pinned: sidebarState.pinned_keys.includes(sessionKey),
    archived: sidebarState.archived_keys.includes(sessionKey),
    tags: sidebarState.tags_by_key[sessionKey] ?? [],
    projectId,
    groupProjectId,
    cwd,
    missingProject
  };
}

export function updateSidebarStateForTask(
  state: MemmyAgentSidebarState,
  sessionKey: string,
  patch: {
    title?: string | null;
    pinned?: boolean;
    archived?: boolean;
    tags?: string[];
    collapsed?: boolean;
    sort?: MemmyAgentSidebarState["view"]["sort"];
    showArchived?: boolean;
    showProjectArchived?: boolean;
  }
): MemmyAgentSidebarState {
  return {
    ...state,
    pinned_keys: updateList(state.pinned_keys, sessionKey, patch.pinned),
    archived_keys: updateList(state.archived_keys, sessionKey, patch.archived),
    title_overrides: updateMapValue(state.title_overrides, sessionKey, patch.title),
    tags_by_key: updateTags(state.tags_by_key, sessionKey, patch.tags),
    collapsed_groups: updateBoolMap(state.collapsed_groups, sessionKey, patch.collapsed),
    view: {
      ...state.view,
      ...(patch.sort ? { sort: patch.sort } : {}),
      ...(patch.showArchived == null ? {} : { show_archived: patch.showArchived }),
      ...(patch.showProjectArchived == null ? {} : { show_project_archived: patch.showProjectArchived })
    }
  };
}

function deriveTasks(state: AgentState): AgentState {
  return { ...state, tasks: buildAgentTasksForState(state) };
}

function completeSessionSnapshotLoad(
  state: AgentState,
  snapshot: MemmyAgentSessionSnapshot,
  requestId?: string
): AgentState {
  const activeProjectIds = new Set(snapshot.projects.map((project) => project.id));
  const draftTargetsByScope = { ...state.draftTargetsByScope };
  const draftTargetRevisionByScope = { ...state.draftTargetRevisionByScope };
  if (snapshot.projectRegistryState === "ready") {
    for (const [scopeKey, target] of Object.entries(draftTargetsByScope)) {
      if (target.kind !== "project" || activeProjectIds.has(target.projectId)) continue;
      draftTargetsByScope[scopeKey] = { kind: "standalone" };
      draftTargetRevisionByScope[scopeKey] = (draftTargetRevisionByScope[scopeKey] ?? 0) + 1;
    }
  }
  const loaded = completeSessionsLoad({
    ...state,
    projectRegistryState: snapshot.projectRegistryState,
    projects: snapshot.projects,
    draftTargetsByScope,
    draftTargetRevisionByScope
  }, snapshot.sessions, requestId);
  if (
    loaded.currentSessionKey
    && !snapshot.sessions.some((session) => session.key === loaded.currentSessionKey)
    && !(loaded.currentChatId && loaded.optimisticTasksByChatId[loaded.currentChatId])
  ) {
    const removedChatId = loaded.currentChatId;
    return enterBlankDraft({
      ...loaded,
      ...(removedChatId
        ? { goalRunClockByChatId: { ...loaded.goalRunClockByChatId, [removedChatId]: null } }
        : {})
    }, loaded.newChatRequestId + 1);
  }
  return loaded;
}

function completeSessionsLoad(state: AgentState, sessions: MemmyAgentSessionSummary[], requestId: string | undefined): AgentState {
  if (requestId && state.currentSessionsRequestId !== requestId) {
    return state;
  }

  const canonicalChatIds = new Set(sessions.map((session) => sessionKeyToChatId(session.key)));
  const committedModelSelectionByScope = { ...state.committedModelSelectionByScope };
  for (const session of sessions) {
    const chatId = sessionKeyToChatId(session.key);
    committedModelSelectionByScope[chatId] = session.model_selection ?? null;
  }
  const optimisticTasksByChatId = pruneOptimisticTasks(state.optimisticTasksByChatId, canonicalChatIds);
  const queuedMessagesByChatId = pruneChatMap(
    state.queuedMessagesByChatId,
    new Set([...canonicalChatIds, ...Object.keys(optimisticTasksByChatId)])
  );
  const queueRevisionByChatId = pruneNumberMap(
    state.queueRevisionByChatId,
    new Set([...canonicalChatIds, ...Object.keys(optimisticTasksByChatId)])
  );
  const queueDesyncedByChatId = pruneChatMap(
    state.queueDesyncedByChatId,
    new Set([...canonicalChatIds, ...Object.keys(optimisticTasksByChatId)])
  );
  const knownChatIds = new Set([
    ...canonicalChatIds,
    ...Object.keys(optimisticTasksByChatId),
    ...(state.currentChatId ? [state.currentChatId] : []),
    ...Object.keys(state.optimisticSendingByChatId),
    ...Object.keys(state.stopInFlightByChatId)
  ]);
  const preserveRunChatIds = new Set<string>();
  const requestRunStatusVersions = state.currentSessionsRequestRunStatusVersionByChatId;
  if (requestRunStatusVersions) {
    for (const chatId of knownChatIds) {
      if ((state.runStatusVersionByChatId[chatId] ?? 0) !== (requestRunStatusVersions[chatId] ?? 0)) {
        preserveRunChatIds.add(chatId);
      }
    }
  }
  const nextState = {
    ...state,
    sessions,
    committedModelSelectionByScope,
    optimisticTasksByChatId,
    queuedMessagesByChatId,
    queueRevisionByChatId,
    queueDesyncedByChatId,
    retryWaitStatusByChatId: pruneOptionalMap(state.retryWaitStatusByChatId, knownChatIds),
    completedUnseenByChatId: pruneNumberMap(state.completedUnseenByChatId, knownChatIds),
    runStartedAtByChatId: reconcileSessionRunStartedOverrides(state.runStartedAtByChatId, sessions, knownChatIds, preserveRunChatIds),
    goalRunClockByChatId: pruneNullableMap(state.goalRunClockByChatId, knownChatIds),
    runStatusVersionByChatId: pruneNumberMap(state.runStatusVersionByChatId, knownChatIds),
    currentSessionsRequestRunStatusVersionByChatId: null,
    stopInFlightByChatId: pruneBooleanMap(state.stopInFlightByChatId, knownChatIds),
    suppressAssistantStreamUntilTurnEndByChatId: pruneBooleanMap(state.suppressAssistantStreamUntilTurnEndByChatId, knownChatIds),
    currentSessionsRequestId: null,
    isLoadingSessions: false,
    refreshRequested: false
  };

  return deriveTasks({
    ...nextState,
    isSending: nextState.currentChatId
      ? isChatBusy(nextState, nextState.currentChatId) || chatHasLiveStream(nextState, nextState.currentChatId)
      : nextState.isSending
  });
}

function reconcileModelCatalog(
  state: AgentState,
  presets: ChatModelPreset[],
  defaultPreset: string | null
): AgentState {
  const availableNames = new Set(
    presets.filter((preset) => preset.available).map((preset) => preset.name)
  );
  const pendingPresetByScope = { ...state.pendingPresetByScope };
  for (const [scopeKey, preset] of Object.entries(pendingPresetByScope)) {
    if (preset === undefined || (preset !== null && !availableNames.has(preset))) {
      delete pendingPresetByScope[scopeKey];
    }
  }
  return {
    ...state,
    modelPresets: presets,
    defaultModelPreset: defaultPreset && availableNames.has(defaultPreset)
      ? defaultPreset
      : null,
    pendingPresetByScope
  };
}

export function selectedModelPresetForScope(
  state: Pick<
    AgentState,
    "modelPresets" | "defaultModelPreset" | "pendingPresetByScope" | "committedModelSelectionByScope"
  >,
  scopeKey: string
): string | null {
  const availableNames = new Set(
    state.modelPresets
      .filter((preset) => preset.available)
      .map((preset) => preset.name)
  );
  if (Object.prototype.hasOwnProperty.call(state.pendingPresetByScope, scopeKey)) {
    const pending = state.pendingPresetByScope[scopeKey];
    if (pending && availableNames.has(pending)) return pending;
    if (pending === null) return state.defaultModelPreset;
  }
  const committed = state.committedModelSelectionByScope[scopeKey];
  if (committed) return committed.presetId;
  return state.defaultModelPreset;
}

function failSessionsLoad(state: AgentState, requestId: string | undefined): AgentState {
  if (requestId && state.currentSessionsRequestId !== requestId) {
    return state;
  }

  return {
    ...state,
    currentSessionsRequestId: null,
    currentSessionsRequestRunStatusVersionByChatId: null,
    isLoadingSessions: false
  };
}

function beginHistoryLoad(state: AgentState, sessionKey: string, chatId: string, requestId: string): AgentState {
  const nextState = switchCurrentChat(state, chatId, sessionKey);
  const currentHistoryHydrateRequestIdByChatId = { ...nextState.currentHistoryHydrateRequestIdByChatId };
  delete currentHistoryHydrateRequestIdByChatId[chatId];
  return deriveTasks({
    ...nextState,
    blankDraftActive: false,
    isLoadingHistory: true,
    pendingCanonicalHydrateByChatId: { ...nextState.pendingCanonicalHydrateByChatId, [chatId]: true },
    currentHistoryRequestIdByChatId: { ...nextState.currentHistoryRequestIdByChatId, [chatId]: requestId },
    currentHistoryHydrateRequestIdByChatId
  });
}

function threadClosesCurrentTurn(
  thread: MemmyAgentWebuiThread,
  activeTurnId: string | null,
): boolean {
  if (thread.last_turn_closed !== true) return false;
  if (!activeTurnId) return true;
  return typeof thread.last_turn_id === "string" && thread.last_turn_id === activeTurnId;
}

function messagesContainTurn(messages: AgentChatMessage[], turnId: string | null): boolean {
  return Boolean(turnId && messages.some((message) => message.turnId === turnId));
}

function reconcileQueueSteerPendingMessages(
  current: AgentChatMessage[],
  canonical: AgentChatMessage[],
  activeTurnId: string | null,
  turnClosed: boolean
): AgentChatMessage[] {
  return current.flatMap((message) => {
    if (!message.queueSteerPending || !message.clientRequestId || !message.turnId) {
      return [message];
    }
    const persisted = canonical.find((candidate) => (
      candidate.clientRequestId === message.clientRequestId
      && candidate.turnId === message.turnId
    ));
    if (persisted) return [{ ...persisted, queueSteerPending: false }];
    if (!turnClosed && activeTurnId === message.turnId) return [message];
    return [];
  });
}

function completeHistoryLoad(state: AgentState, thread: MemmyAgentWebuiThread, requestId: string): AgentState {
  const chatId = sessionKeyToChatId(thread.sessionKey);
  if (state.currentChatId !== chatId || state.currentHistoryRequestIdByChatId[chatId] !== requestId) {
    return state;
  }

  const snapshot = normalizeThreadMessages(thread.messages);
  const currentMessages = state.messages;
  const activeTurnId = state.activeTurnIdByChatId[chatId] ?? null;
  const historyTurnClosed = threadClosesCurrentTurn(thread, activeTurnId);
  const chatBusy = isChatBusy(state, chatId);
  const hasLiveStream = hasLiveStreamingMessage(currentMessages);
  const shouldKeepLiveStream = !historyTurnClosed && hasLiveStream && currentMessages.length > 0;
  const shouldKeepCurrent = (!historyTurnClosed && messagesContainTurn(currentMessages, activeTurnId))
    || shouldKeepLiveStream
    || isStaleThreadSnapshot(currentMessages, snapshot)
    || (snapshot.length === 0 && chatBusy && currentMessages.length > 0)
    || (chatBusy && isSnapshotMissingLatestUserMessage(currentMessages, snapshot));
  const messages = shouldKeepCurrent
    ? reconcileQueueSteerPendingMessages(
        currentMessages,
        snapshot,
        activeTurnId,
        historyTurnClosed
      )
    : snapshot;
  const pendingCanonicalHydrateByChatId = { ...state.pendingCanonicalHydrateByChatId };
  const currentHistoryRequestIdByChatId = { ...state.currentHistoryRequestIdByChatId };
  const currentHistoryHydrateRequestIdByChatId = { ...state.currentHistoryHydrateRequestIdByChatId };
  const historyVersionByChatId = { ...state.historyVersionByChatId };
  delete pendingCanonicalHydrateByChatId[chatId];
  delete currentHistoryRequestIdByChatId[chatId];
  delete currentHistoryHydrateRequestIdByChatId[chatId];
  historyVersionByChatId[chatId] = (historyVersionByChatId[chatId] ?? 0) + 1;

  const nextState = reconcileAssistantStreamSuppressionForOpenTurn(syncCurrentMessages({
    ...state,
    currentChatId: chatId,
    currentSessionKey: thread.sessionKey,
    messages,
    historyVersionByChatId,
    pendingCanonicalHydrateByChatId,
    currentHistoryRequestIdByChatId,
    currentHistoryHydrateRequestIdByChatId,
    blankDraftActive: false,
    isSending: isChatBusy(state, chatId) || hasLiveStreamingMessage(messages),
    isLoadingHistory: false,
    refreshRequested: false
  }), chatId, messages, historyTurnClosed);
  return historyTurnClosed
    ? markChatIdle(nextState, chatId, { source: "session_hydrate", turnId: thread.last_turn_id ?? null })
    : nextState;
}

function completeHistoryOpenMissing(state: AgentState, sessionKey: string, chatId: string, requestId: string): AgentState {
  if (state.currentChatId !== chatId || state.currentSessionKey !== sessionKey || state.currentHistoryRequestIdByChatId[chatId] !== requestId) {
    return state;
  }

  const pendingCanonicalHydrateByChatId = { ...state.pendingCanonicalHydrateByChatId };
  const currentHistoryRequestIdByChatId = { ...state.currentHistoryRequestIdByChatId };
  delete pendingCanonicalHydrateByChatId[chatId];
  delete currentHistoryRequestIdByChatId[chatId];

  const nextState = clearSuppressAssistantStreamUntilTurnEnd({
    ...state,
    pendingCanonicalHydrateByChatId,
    currentHistoryRequestIdByChatId,
    isLoadingHistory: false,
    isSending: isChatBusy(state, chatId),
    refreshRequested: true
  }, chatId);
  return deriveTasks(nextState);
}

function beginHistoryHydrateLoad(state: AgentState, chatId: string, requestId: string): AgentState {
  return deriveTasks({
    ...state,
    pendingCanonicalHydrateByChatId: { ...state.pendingCanonicalHydrateByChatId, [chatId]: true },
    currentHistoryHydrateRequestIdByChatId: { ...state.currentHistoryHydrateRequestIdByChatId, [chatId]: requestId }
  });
}

function completeHistoryHydrateLoad(state: AgentState, thread: MemmyAgentWebuiThread, requestId: string): AgentState {
  const chatId = sessionKeyToChatId(thread.sessionKey);
  if (state.currentHistoryHydrateRequestIdByChatId[chatId] !== requestId) {
    return state;
  }

  const snapshot = normalizeThreadMessages(thread.messages);
  const currentMessages = chatId === state.currentChatId ? state.messages : state.messagesByChatId[chatId] ?? [];
  const activeTurnId = state.activeTurnIdByChatId[chatId] ?? null;
  const hydrateTurnClosed = threadClosesCurrentTurn(thread, activeTurnId);
  const chatBusy = isChatBusy(state, chatId);
  const hasLiveStream = hasLiveStreamingMessage(currentMessages);
  const shouldKeepLiveStream = !hydrateTurnClosed && hasLiveStream && currentMessages.length > 0;
  const shouldKeepCurrent = (!hydrateTurnClosed && messagesContainTurn(currentMessages, activeTurnId))
    || shouldKeepLiveStream
    || isStaleThreadSnapshot(currentMessages, snapshot)
    || (snapshot.length === 0 && chatBusy && currentMessages.length > 0)
    || (chatBusy && isSnapshotMissingLatestUserMessage(currentMessages, snapshot));
  const messages = shouldKeepCurrent
    ? reconcileQueueSteerPendingMessages(
        currentMessages,
        snapshot,
        activeTurnId,
        hydrateTurnClosed
      )
    : snapshot;
  const pendingCanonicalHydrateByChatId = { ...state.pendingCanonicalHydrateByChatId };
  const currentHistoryHydrateRequestIdByChatId = { ...state.currentHistoryHydrateRequestIdByChatId };
  const historyVersionByChatId = { ...state.historyVersionByChatId };
  const messagesByChatId = { ...state.messagesByChatId, [chatId]: messages };
  delete pendingCanonicalHydrateByChatId[chatId];
  delete currentHistoryHydrateRequestIdByChatId[chatId];
  historyVersionByChatId[chatId] = (historyVersionByChatId[chatId] ?? 0) + 1;

  const nextState = reconcileAssistantStreamSuppressionForOpenTurn({
    ...state,
    messagesByChatId,
    historyVersionByChatId,
    pendingCanonicalHydrateByChatId,
    currentHistoryHydrateRequestIdByChatId,
    ...(chatId === state.currentChatId && !state.blankDraftActive
      ? { messages, isSending: isChatBusy(state, chatId) || hasLiveStreamingMessage(messages) }
      : {})
  }, chatId, messages, hydrateTurnClosed);

  const hydrated = deriveTasks(nextState);
  return hydrateTurnClosed
    ? markChatIdle(hydrated, chatId, { source: "session_hydrate", turnId: thread.last_turn_id ?? null })
    : hydrated;
}

function failHistoryHydrateLoad(
  state: AgentState,
  chatId: string,
  requestId: string,
  error?: AgentOperationError
): AgentState {
  if (state.currentHistoryHydrateRequestIdByChatId[chatId] !== requestId) {
    return state;
  }
  const pendingCanonicalHydrateByChatId = { ...state.pendingCanonicalHydrateByChatId };
  const currentHistoryHydrateRequestIdByChatId = { ...state.currentHistoryHydrateRequestIdByChatId };
  delete pendingCanonicalHydrateByChatId[chatId];
  delete currentHistoryHydrateRequestIdByChatId[chatId];
  const nextState = deriveTasks({
    ...state,
    pendingCanonicalHydrateByChatId,
    currentHistoryHydrateRequestIdByChatId
  });
  return error ? setOperationError(nextState, "chat", error) : nextState;
}

function cacheCurrentMessages(state: AgentState): AgentState {
  return state.currentChatId
    ? {
        ...state,
        messagesByChatId: { ...state.messagesByChatId, [state.currentChatId]: state.messages }
      }
    : state;
}

function syncCurrentMessages(state: AgentState): AgentState {
  return state.currentChatId
    ? {
        ...state,
        messagesByChatId: { ...state.messagesByChatId, [state.currentChatId]: state.messages }
      }
    : state;
}

function switchCurrentChat(state: AgentState, chatId: string, sessionKey = chatIdToSessionKey(chatId)): AgentState {
  const cachedState = cacheCurrentMessages(state);
  const completedUnseenByChatId = clearChatMapValue(cachedState.completedUnseenByChatId, chatId);
  if (cachedState.currentChatId === chatId && cachedState.currentSessionKey === sessionKey) {
    return deriveTasks({
      ...cachedState,
      completedUnseenByChatId,
      chatSelectionEpoch: cachedState.blankDraftActive ? cachedState.chatSelectionEpoch + 1 : cachedState.chatSelectionEpoch,
      blankDraftActive: false,
      goalState: cachedState.goalStatesByChatId[chatId] ?? cachedState.goalState,
      isSending: isChatBusy(cachedState, chatId)
    });
  }
  return deriveTasks({
    ...cachedState,
    completedUnseenByChatId,
    chatSelectionEpoch: cachedState.chatSelectionEpoch + 1,
    currentChatId: chatId,
    currentSessionKey: sessionKey,
    messages: cachedState.messagesByChatId[chatId] ?? [],
    goalState: cachedState.goalStatesByChatId[chatId] ?? null,
    isSending: isChatBusy(cachedState, chatId),
    blankDraftActive: false
  });
}

function isChatBusy(state: AgentState, chatId: string): boolean {
  return Boolean(effectiveRunStartedAtForChat(state, chatId) != null || state.optimisticSendingByChatId[chatId]);
}

function chatMessagesForId(state: AgentState, chatId: string): AgentChatMessage[] {
  return chatId === state.currentChatId ? state.messages : state.messagesByChatId[chatId] ?? [];
}

/**
 * An open inbound stream is hard evidence the turn is still running. Status
 * signals (run_status, session list refreshes) can race behind the content
 * stream mid-turn; they must never flip the stop button back to send while
 * text is still flowing. Real turn closure (turn_end / hydrate of a closed
 * thread / user stop) clears the streaming flags first, so this guard never
 * keeps a finished chat busy.
 */
function chatHasLiveStream(state: AgentState, chatId: string): boolean {
  return hasLiveStreamingMessage(chatMessagesForId(state, chatId));
}

function shouldLiveEventKeepChatBusy(state: AgentState): boolean {
  const chatId = state.currentChatId;
  if (!chatId || state.stopInFlightByChatId[chatId]) {
    return false;
  }
  if (isChatBusy(state, chatId)) {
    return true;
  }
  // An open inbound stream is itself proof the turn is running: status
  // signals (run_status / session refresh) can race behind the content
  // stream, and they must never flip the stop button back to send while
  // text is still flowing. Only an explicit user stop or a real turn close
  // (which clears the streaming flags first) ends the busy state.
  if (hasLiveStreamingMessage(state.messages)) {
    return true;
  }
  const hasExplicitIdleOverride =
    Object.prototype.hasOwnProperty.call(state.runStartedAtByChatId, chatId)
    && state.runStartedAtByChatId[chatId] == null;
  return !hasExplicitIdleOverride;
}

function sessionRunStartedAtForChat(state: AgentState, chatId: string): number | null {
  const sessionKey = chatIdToSessionKey(chatId);
  const session = state.sessions.find((item) => item.key === sessionKey);
  return session?.run_started_at ?? null;
}

function effectiveRunStartedAtForChat(state: AgentState, chatId: string): number | null {
  if (Object.prototype.hasOwnProperty.call(state.runStartedAtByChatId, chatId)) {
    return state.runStartedAtByChatId[chatId] ?? null;
  }
  return sessionRunStartedAtForChat(state, chatId);
}

function isChatVisible(state: AgentState, chatId: string): boolean {
  return state.chatViewVisible && state.currentChatId === chatId && !state.blankDraftActive;
}

function isTaskCompletedUnseen(state: AgentState, chatId: string): boolean {
  return state.completedUnseenByChatId[chatId] != null
    && effectiveRunStartedAtForChat(state, chatId) == null
    && !isChatVisible(state, chatId);
}

function updateChatViewVisibility(state: AgentState, visible: boolean): AgentState {
  const nextState = { ...state, chatViewVisible: visible };
  if (!nextState.currentChatId || !isChatVisible(nextState, nextState.currentChatId)) {
    return deriveTasks(nextState);
  }
  return deriveTasks({
    ...nextState,
    completedUnseenByChatId: clearChatMapValue(nextState.completedUnseenByChatId, nextState.currentChatId)
  });
}

function hasCanonicalSession(state: AgentState, chatId: string): boolean {
  const sessionKey = chatIdToSessionKey(chatId);
  return state.sessions.some((session) => session.key === sessionKey);
}

function maybeAddOptimisticTask(
  state: AgentState,
  chatId: string,
  content: string,
  media: AgentChatMediaAttachment[] | undefined,
  target: WebuiSessionTarget | undefined,
  now: number
): Record<string, OptimisticAgentTask> {
  if (hasCanonicalSession(state, chatId)) {
    return state.optimisticTasksByChatId;
  }
  return {
    ...state.optimisticTasksByChatId,
    [chatId]: {
      content: optimisticTaskText(content, media),
      createdAt: new Date(now).toISOString(),
      target: target ?? { kind: "standalone" }
    }
  };
}

function optimisticTaskText(content: string, media: AgentChatMediaAttachment[] | undefined): string {
  const trimmed = content.trim();
  if (trimmed) {
    return trimmed;
  }
  const mediaName = media?.find((item) => item.name?.trim())?.name?.trim();
  return mediaName || "Attachment";
}

function pruneOptimisticTasks(
  values: Record<string, OptimisticAgentTask>,
  canonicalChatIds: Set<string>
): Record<string, OptimisticAgentTask> {
  const next: Record<string, OptimisticAgentTask> = {};
  for (const [chatId, task] of Object.entries(values)) {
    if (!canonicalChatIds.has(chatId)) {
      next[chatId] = task;
    }
  }
  return next;
}

function pruneNumberMap(values: Record<string, number>, keepChatIds: Set<string>): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [chatId, value] of Object.entries(values)) {
    if (keepChatIds.has(chatId)) {
      next[chatId] = value;
    }
  }
  return next;
}

function pruneBooleanMap(values: Record<string, boolean>, keepChatIds: Set<string>): Record<string, boolean> {
  const next: Record<string, boolean> = {};
  for (const [chatId, value] of Object.entries(values)) {
    if (keepChatIds.has(chatId)) {
      next[chatId] = value;
    }
  }
  return next;
}

function pruneChatMap<T>(values: Record<string, T>, keepChatIds: Set<string>): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [chatId, value] of Object.entries(values)) {
    if (keepChatIds.has(chatId)) next[chatId] = value;
  }
  return next;
}

function pruneOptionalMap<T>(values: Record<string, T | undefined>, keepChatIds: Set<string>): Record<string, T | undefined> {
  const next: Record<string, T | undefined> = {};
  for (const [chatId, value] of Object.entries(values)) {
    if (keepChatIds.has(chatId) && value !== undefined) {
      next[chatId] = value;
    }
  }
  return next;
}

function pruneNullableMap<T>(values: Record<string, T | null>, keepChatIds: Set<string>): Record<string, T | null> {
  const next: Record<string, T | null> = {};
  for (const [chatId, value] of Object.entries(values)) {
    if (keepChatIds.has(chatId)) {
      next[chatId] = value;
    }
  }
  return next;
}

function pruneRunStartedOverrides(values: Record<string, number | null>, keepChatIds: Set<string>): Record<string, number | null> {
  const next: Record<string, number | null> = {};
  for (const [chatId, value] of Object.entries(values)) {
    if (keepChatIds.has(chatId)) {
      next[chatId] = value;
    }
  }
  return next;
}

function reconcileSessionRunStartedOverrides(
  values: Record<string, number | null>,
  sessions: MemmyAgentSessionSummary[],
  keepChatIds: Set<string>,
  preserveRunChatIds: ReadonlySet<string>
): Record<string, number | null> {
  const next = pruneRunStartedOverrides(values, keepChatIds);
  for (const session of sessions) {
    const chatId = sessionKeyToChatId(session.key);
    if (preserveRunChatIds.has(chatId)) {
      continue;
    }
    if (typeof session.run_started_at === "number") {
      next[chatId] = session.run_started_at;
    } else if (next[chatId] != null) {
      next[chatId] = null;
    }
  }
  return next;
}

function clearChatMapValue<T>(values: Record<string, T>, chatId: string): Record<string, T> {
  if (!Object.prototype.hasOwnProperty.call(values, chatId)) {
    return values;
  }
  const next = { ...values };
  delete next[chatId];
  return next;
}

function clearPendingModelCommit(state: AgentState, clientRequestId: string): AgentState {
  const pendingModelCommitByRequestId = clearChatMapValue(
    state.pendingModelCommitByRequestId,
    clientRequestId
  );
  return pendingModelCommitByRequestId === state.pendingModelCommitByRequestId
    ? state
    : { ...state, pendingModelCommitByRequestId };
}

function setSuppressAssistantStreamUntilTurnEnd(state: AgentState, chatId: string, enabled: boolean): AgentState {
  if (!enabled) {
    return clearSuppressAssistantStreamUntilTurnEnd(state, chatId);
  }
  if (state.suppressAssistantStreamUntilTurnEndByChatId[chatId] === true) {
    return state;
  }
  return {
    ...state,
    suppressAssistantStreamUntilTurnEndByChatId: {
      ...state.suppressAssistantStreamUntilTurnEndByChatId,
      [chatId]: true
    }
  };
}

function clearSuppressAssistantStreamUntilTurnEnd(state: AgentState, chatId: string): AgentState {
  const suppressAssistantStreamUntilTurnEndByChatId = clearChatMapValue(state.suppressAssistantStreamUntilTurnEndByChatId, chatId);
  return suppressAssistantStreamUntilTurnEndByChatId === state.suppressAssistantStreamUntilTurnEndByChatId
    ? state
    : { ...state, suppressAssistantStreamUntilTurnEndByChatId };
}

function isAssistantMediaDeliveryMessage(message: AgentChatMessage): boolean {
  return message.role === "assistant"
    && message.kind !== "trace"
    && message.kind !== "narration"
    && message.kind !== "context_compaction"
    && Boolean(message.media?.length);
}

function lastOpenTurnHasAssistantMedia(messages: AgentChatMessage[]): boolean {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex < 0) {
    return false;
  }
  return messages.slice(lastUserIndex + 1).some(isAssistantMediaDeliveryMessage);
}

function reconcileAssistantStreamSuppressionForOpenTurn(
  state: AgentState,
  chatId: string,
  messages: AgentChatMessage[],
  turnClosed: boolean
): AgentState {
  if (turnClosed) {
    return clearSuppressAssistantStreamUntilTurnEnd(state, chatId);
  }
  return setSuppressAssistantStreamUntilTurnEnd(state, chatId, lastOpenTurnHasAssistantMedia(messages));
}

function finishToolEventsForTurnEnd(events: AgentToolProgressEvent[] | undefined): AgentToolProgressEvent[] | undefined {
  if (!events?.length) {
    return events;
  }

  let changed = false;
  const finishedEvents = events.map((event) => {
    if (isTerminalToolPhase(event.phase)) {
      return event;
    }
    changed = true;
    return { ...event, phase: "end" as const };
  });
  return changed ? finishedEvents : events;
}

function finishFileEditsForTurnEnd(edits: AgentFileEdit[] | undefined): AgentFileEdit[] | undefined {
  if (!edits?.length) {
    return edits;
  }

  let changed = false;
  const finishedEdits = edits.map((edit) => {
    if (edit.status === "done" || edit.status === "error") {
      return edit;
    }
    changed = true;
    return { ...edit, phase: "end" as const, status: "done" as const };
  });
  return changed ? finishedEdits : edits;
}

function finishActivityProgressForTurnEnd(message: AgentChatMessage): AgentChatMessage {
  const toolEvents = finishToolEventsForTurnEnd(message.toolEvents);
  const fileEdits = finishFileEditsForTurnEnd(message.fileEdits);
  if (toolEvents === message.toolEvents && fileEdits === message.fileEdits) {
    return message;
  }

  return {
    ...message,
    ...(toolEvents !== message.toolEvents ? { toolEvents } : {}),
    ...(fileEdits !== message.fileEdits ? { fileEdits } : {})
  };
}

function finishStreamingMessages(messages: AgentChatMessage[], latencyMs?: number): AgentChatMessage[] {
  let lastAssistantIndex = -1;
  if (latencyMs != null) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "assistant") {
        lastAssistantIndex = index;
        break;
      }
    }
  }

  let changed = false;
  const nextMessages = messages.map((message, index) => {
    const finishedMessage = finishActivityProgressForTurnEnd(message);
    const shouldFinishStreaming = Boolean(message.isStreaming || message.reasoningStreaming);
    const shouldSetLatency = index === lastAssistantIndex;
    if (finishedMessage === message && !shouldFinishStreaming && !shouldSetLatency) {
      return message;
    }

    changed = true;
    return {
      ...finishedMessage,
      ...(shouldFinishStreaming ? { isStreaming: false, reasoningStreaming: false } : {}),
      ...(shouldSetLatency ? { latencyMs } : {})
    };
  });

  return changed ? nextMessages : messages;
}

function finishChatStreaming(state: AgentState, chatId: string, latencyMs?: number): AgentState {
  const messages = state.currentChatId === chatId ? state.messages : state.messagesByChatId[chatId];
  if (!messages) {
    return state;
  }

  const finishedMessages = finishStreamingMessages(messages, latencyMs);
  if (finishedMessages === messages) {
    return state;
  }

  return {
    ...state,
    ...(state.currentChatId === chatId ? { messages: finishedMessages } : {}),
    messagesByChatId: {
      ...state.messagesByChatId,
      [chatId]: finishedMessages
    }
  };
}

function isStaleThreadSnapshot(currentMessages: AgentChatMessage[], snapshot: AgentChatMessage[]): boolean {
  if (snapshot.length >= currentMessages.length) {
    return snapshot.length === currentMessages.length
      && hasUserStoppedMessage(currentMessages)
      && snapshot.every((message, index) => stoppedMessagePayloadEquivalent(message, currentMessages[index]));
  }
  return snapshot.every((message, index) => messagesEquivalent(message, currentMessages[index]));
}

function stoppedMessagePayloadEquivalent(left: AgentChatMessage, right: AgentChatMessage | undefined): boolean {
  if (!right) return false;
  return left.role === right.role
    && left.turnId === right.turnId
    && left.content === right.content
    && left.reasoning === right.reasoning
    && left.kind === right.kind
    && JSON.stringify(left.media ?? []) === JSON.stringify(right.media ?? [])
    && JSON.stringify(left.traces ?? []) === JSON.stringify(right.traces ?? [])
    && JSON.stringify(left.toolEvents ?? []) === JSON.stringify(right.toolEvents ?? [])
    && JSON.stringify(left.fileEdits ?? []) === JSON.stringify(right.fileEdits ?? []);
}

function isSnapshotMissingLatestUserMessage(currentMessages: AgentChatMessage[], snapshot: AgentChatMessage[]): boolean {
  const latestUser = latestUserMessage(currentMessages);
  return Boolean(latestUser && !snapshot.some((message) => messagesEquivalent(message, latestUser)));
}

function latestUserMessage(messages: AgentChatMessage[]): AgentChatMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      return message;
    }
  }
  return null;
}

function hasLiveStreamingMessage(messages: AgentChatMessage[]): boolean {
  return messages.some((message) => Boolean(message.isStreaming || message.reasoningStreaming));
}

function hasUserStoppedMessage(messages: AgentChatMessage[]): boolean {
  return messages.some((message) => message.stoppedByUser);
}

function messagesEquivalent(left: AgentChatMessage, right: AgentChatMessage | undefined): boolean {
  if (!right) {
    return false;
  }
  return left.role === right.role
    && left.turnId === right.turnId
    && left.content === right.content
    && left.reasoning === right.reasoning
    && left.kind === right.kind
    && JSON.stringify(left.media ?? []) === JSON.stringify(right.media ?? [])
    && JSON.stringify(left.traces ?? []) === JSON.stringify(right.traces ?? [])
    && JSON.stringify(left.toolEvents ?? []) === JSON.stringify(right.toolEvents ?? [])
    && JSON.stringify(left.fileEdits ?? []) === JSON.stringify(right.fileEdits ?? [])
    && left.activitySegmentId === right.activitySegmentId;
}

function handleAttached(state: AgentState, chatId: string | null): AgentState {
  if (!chatId || state.currentChatId || state.blankDraftActive) {
    return state;
  }
  return switchCurrentChat(state, chatId);
}

function markSessionUpdated(state: AgentState, chatId: string | null | undefined, scope: unknown): AgentState {
  if (!chatId) {
    return { ...state, refreshRequested: true };
  }
  if (scope === "metadata") {
    return { ...state, refreshRequested: true };
  }
  return {
    ...state,
    refreshRequested: true,
    pendingCanonicalHydrateByChatId: { ...state.pendingCanonicalHydrateByChatId, [chatId]: true }
  };
}

function compareTasks(left: AgentTaskView, right: AgentTaskView, sort: MemmyAgentSidebarState["view"]["sort"]): number {
  if (left.pinned !== right.pinned) {
    return left.pinned ? -1 : 1;
  }

  if (sort === "title_asc") {
    return left.title.localeCompare(right.title);
  }

  return compareNullableTime(right.updatedAt, left.updatedAt);
}

function compareNullableTime(left: string | null, right: string | null): number {
  return String(left ?? "").localeCompare(String(right ?? ""));
}

function updateList(values: string[], key: string, enabled: boolean | undefined): string[] {
  if (enabled === undefined) {
    return values;
  }

  const without = values.filter((item) => item !== key);
  return enabled ? [key, ...without] : without;
}

function updateMapValue(values: Record<string, string>, key: string, value: string | null | undefined): Record<string, string> {
  if (value === undefined) {
    return values;
  }

  const next = { ...values };
  const cleaned = value?.trim() ?? "";
  if (cleaned) {
    next[key] = cleaned;
  } else {
    delete next[key];
  }
  return next;
}

function updateTags(values: Record<string, string[]>, key: string, tags: string[] | undefined): Record<string, string[]> {
  if (tags === undefined) {
    return values;
  }

  const next = { ...values };
  const cleaned = tags.map((tag) => tag.trim()).filter(Boolean);
  if (cleaned.length) {
    next[key] = [...new Set(cleaned)];
  } else {
    delete next[key];
  }
  return next;
}

function updateBoolMap(values: Record<string, boolean>, key: string, value: boolean | undefined): Record<string, boolean> {
  if (value === undefined) {
    return values;
  }

  return { ...values, [key]: value };
}

const CLOSED_TURN_LIMIT = 20;

function eventTurnId(event: MemmyAgentWsEvent): string | null {
  if (typeof event.turn_id === "string" && event.turn_id.trim()) return event.turn_id.trim();
  if (typeof event.turnId === "string" && event.turnId.trim()) return event.turnId.trim();
  return null;
}

function isCancellationTerminalFileEditEvent(event: MemmyAgentWsEvent): boolean {
  if (event.event !== "file_edit") return false;
  if (event.cancellation_terminal === true) return true;
  const edits = Array.isArray(event.edits) ? event.edits : [];
  return edits.length > 0 && edits.every((edit) => isRecord(edit) && edit.cancellation_terminal === true);
}

function isClosedTurn(state: AgentState, chatId: string, turnId: string | null): boolean {
  return Boolean(turnId && state.closedTurnIdsByChatId[chatId]?.[turnId]);
}

function markClosedTurn(
  state: AgentState,
  chatId: string,
  turnId: string | null,
  reason: "stopped" | "ended"
): AgentState {
  if (!turnId) return state;
  const current = state.closedTurnIdsByChatId[chatId] ?? {};
  const entries = Object.entries({ ...current, [turnId]: reason }).slice(-CLOSED_TURN_LIMIT);
  return {
    ...state,
    activeTurnIdByChatId: { ...state.activeTurnIdByChatId, [chatId]: null },
    closedTurnIdsByChatId: {
      ...state.closedTurnIdsByChatId,
      [chatId]: Object.fromEntries(entries)
    }
  };
}

function reduceWsEvent(state: AgentState, event: MemmyAgentWsEvent): AgentState {
  const generation = event.connection_generation;
  const lifecycleEvent = event.event === "ready"
    || event.event === "connection_closed"
    || event.event === "connection_attempt_failed";
  if (generation !== undefined) {
    if (lifecycleEvent ? generation < state.connectionGeneration : generation !== state.connectionGeneration) {
      return state;
    }
  }

  if (isChatContentEvent(event.event)) {
    return reduceChatContentEvent(state, event);
  }

  switch (event.event) {
    case "ready": {
      const readyGeneration = generation ?? Math.max(1, state.connectionGeneration);
      const generationState = readyGeneration === state.connectionGeneration
        ? state
        : {
            ...state,
            queuedMessagesByChatId: {},
            queueRevisionByChatId: {},
            queueDesyncedByChatId: {}
          };
      const base = generationState.currentChatId || generationState.blankDraftActive
        ? generationState
        : withCurrentChat(generationState, event.chat_id ?? null);
      if (readyGeneration <= state.lastRecoveredGeneration || state.recoveringGeneration === readyGeneration) {
        return completeRestartAfterReconnect({
          ...base,
          connectionStatus: "connected",
          connectionError: null,
          connectionGeneration: readyGeneration,
          hasConnectedSinceStartup: true
        });
      }
      const pendingCanonicalHydrateByChatId = { ...base.pendingCanonicalHydrateByChatId };
      for (const chatId of Object.keys(base.currentHistoryRequestIdByChatId)) {
        pendingCanonicalHydrateByChatId[chatId] = true;
      }
      for (const chatId of Object.keys(base.currentHistoryHydrateRequestIdByChatId)) {
        pendingCanonicalHydrateByChatId[chatId] = true;
      }
      return completeRestartAfterReconnect({
        ...base,
        connectionStatus: "connected",
        connectionError: null,
        connectionGeneration: readyGeneration,
        hasConnectedSinceStartup: true,
        recoveringGeneration: readyGeneration,
        recoveringChatId: base.currentChatId,
        recoveringChatSelectionEpoch: base.currentChatId ? base.chatSelectionEpoch : null,
        recoveryKind: state.connectionStatus === "reconnecting" ? "reconnect" : "initial",
        pendingCanonicalHydrateByChatId,
        currentHistoryRequestIdByChatId: {},
        currentHistoryHydrateRequestIdByChatId: {},
        isLoadingHistory: false,
        currentRecoveryChatRequest: null
      });
    }
    case "attached":
      return handleAttached(state, event.chat_id ?? null);
    case "message_queued": {
      if (!event.chat_id || !event.item) return state;
      const item = queuedMessageFromWire(event.item);
      if (!item) return state;
      return applyQueueIncrement(state, event, (currentState) => {
        const currentMessages = chatMessagesForId(currentState, event.chat_id!);
        const withoutSteerPending = currentMessages.filter((message) => !(
          message.clientRequestId === item.clientRequestId
          && message.queueSteerPending === true
        ));
        if (withoutSteerPending.length !== currentMessages.length) {
          currentState = syncCurrentMessages({
            ...currentState,
            messagesByChatId: {
              ...currentState.messagesByChatId,
              [event.chat_id!]: withoutSteerPending
            }
          });
        }
        const current = currentState.queuedMessagesByChatId[event.chat_id!] ?? [];
        const index = current.findIndex(
          (candidate) => candidate.clientRequestId === item.clientRequestId
        );
        if (index < 0) {
          return setQueuedMessagesForChat(currentState, event.chat_id!, [...current, item]);
        }
        const next = [...current];
        next[index] = { ...item, status: current[index]!.status };
        return setQueuedMessagesForChat(currentState, event.chat_id!, next);
      });
    }
    case "message_dequeued": {
      if (!event.chat_id || !event.client_request_id) return state;
      return applyQueueIncrement(state, event, (currentState) => {
        const eventItem = event.item ? queuedMessageFromWire(event.item) : null;
        const localItem = currentState.queuedMessagesByChatId[event.chat_id!]?.find(
          (item) => item.clientRequestId === event.client_request_id
        ) ?? null;
        const item = eventItem ?? localItem;
        const turnId = eventTurnId(event);
        const queueSteerPending = event.turn_admission === "steer" && Boolean(turnId);
        return item
          ? promoteQueuedMessage(
              currentState,
              event.chat_id!,
              item,
              turnId,
              queueSteerPending
            )
          : currentState;
      });
    }
    case "message_steered": {
      if (!event.chat_id || !event.client_request_id) return state;
      const item = state.queuedMessagesByChatId[event.chat_id]?.find(
        (candidate) => candidate.clientRequestId === event.client_request_id
      );
      return item
        ? promoteQueuedMessage(state, event.chat_id, item, eventTurnId(event), true)
        : state;
    }
    case "message_queue_removed":
      if (!event.chat_id || !event.client_request_id) return state;
      return clearPendingModelCommit(
        applyQueueIncrement(
            state,
            event,
            (currentState) => removeQueuedMessageFromChat(
              currentState,
              event.chat_id!,
              event.client_request_id!
            ).state
          ),
        event.client_request_id
      );
    case "message_queue_snapshot":
      return applyQueueSnapshot(state, event);
    case "queue_remove_result": {
      if (
        (event.outcome !== "removed" && event.outcome !== "already_dequeued")
        || !event.chat_id
        || !event.client_request_id
      ) return state;
      const item = state.queuedMessagesByChatId[event.chat_id]?.find(
        (candidate) => candidate.clientRequestId === event.client_request_id
      );
      let nextState = event.outcome === "already_dequeued" && item
        ? promoteQueuedMessage(state, event.chat_id, item)
        : removeQueuedMessageFromChat(state, event.chat_id, event.client_request_id).state;
      const revision = queueRevisionFromEvent(event);
      const currentRevision = state.queueRevisionByChatId[event.chat_id];
      if (revision !== null && (currentRevision === undefined || revision > currentRevision)) {
        nextState = markQueueDesynced(nextState, event.chat_id, revision);
      }
      return event.outcome === "removed"
        ? clearPendingModelCommit(nextState, event.client_request_id)
        : nextState;
    }
    case "error": {
      const rejectedQueue = rejectQueuedMessage(state, event);
      if (rejectedQueue) {
        return event.client_request_id
          ? clearPendingModelCommit(rejectedQueue, event.client_request_id)
          : rejectedQueue;
      }
      if (event.detail === "image_rejected" || event.detail === "attachment_rejected") {
        return handleMediaRejected(state, event);
      }
      if (event.detail === "missing content") {
        return handleMissingContent(state, event);
      }
      if (event.detail === "stop_failed") {
        return handleStopFailed(state, event);
      }
      const errored = setOperationError(state, "chat", operationErrorFromEvent(event, "gateway-command"));
      return event.client_request_id
        ? clearPendingModelCommit(errored, event.client_request_id)
        : errored;
    }
    case "transport_error":
      if (event.detail === "message_too_big") {
        return handleTransportMessageTooBig(state, event);
      }
      return { ...state, connectionError: event.detail ?? "websocket_error" };
    case "connection_attempt_failed":
      return {
        ...state,
        connectionGeneration: generation ?? state.connectionGeneration,
        connectionStatus: "reconnecting",
        connectionError: event.detail ?? "Agent gateway reconnect failed"
      };
    case "connection_closed": {
      const deliveryUncertainByChatId = { ...state.deliveryUncertainByChatId };
      for (const chatId of Object.keys(state.optimisticSendingByChatId)) {
        if (state.optimisticSendingByChatId[chatId]) {
          deliveryUncertainByChatId[chatId] = true;
        }
      }
      const clearRecoveryTaskRequest = state.currentTaskStateRequest?.recoveryGeneration === generation;
      const currentChatId = state.currentChatId;
      const hasCurrentNormalHistoryRequest = Boolean(currentChatId && (
        state.currentHistoryRequestIdByChatId[currentChatId]
        || state.currentHistoryHydrateRequestIdByChatId[currentChatId]
      ));
      return markRestartSawDisconnect({
        ...state,
        connectionGeneration: generation ?? state.connectionGeneration,
        connectionStatus: "reconnecting",
        connectionError: null,
        recoveringGeneration: null,
        recoveringChatId: null,
        recoveringChatSelectionEpoch: null,
        recoveryKind: null,
        currentRecoveryChatRequest: null,
        ...(clearRecoveryTaskRequest ? { currentTaskStateRequest: null, isLoadingSessions: false } : {}),
        ...(!hasCurrentNormalHistoryRequest ? { isLoadingHistory: false } : {}),
        deliveryUncertainByChatId,
        stopInFlightByChatId: {}
      });
    }
    case "run_status_snapshot":
      if (generation !== undefined && state.recoveringGeneration === generation && state.recoveringChatId === event.chat_id) {
        return state;
      }
      return reconcileRunStatusSnapshot(state, event);
    case "run_status":
      return updateRunStatus(state, event);
    case "goal_state":
      return updateGoalState(state, event.chat_id, event.goal_state);
    case "turn_end":
      return event.chat_id
        ? endTurn(state, event.chat_id, event.latency_ms, eventTurnId(event), event)
        : state;
    case "stop_result":
      return event.chat_id ? markChatIdle(state, event.chat_id, { source: "stop_result", turnId: eventTurnId(event) }) : state;
    case "session_updated":
      return event.chat_id ? markSessionUpdated(state, event.chat_id, event.scope) : state;
    case "message_accepted":
      if (!event.chat_id || !event.client_request_id) return state;
      {
        const pending = state.pendingModelCommitByRequestId[event.client_request_id];
        const selection = parseMemmyAgentModelSelection(event.model_selection);
        if (
          !pending
          || !selection
          || (pending.chatId !== null && pending.chatId !== event.chat_id)
          || (pending.presetId !== null && pending.presetId !== selection.presetId)
        ) return state;
        const pendingModelCommitByRequestId = { ...state.pendingModelCommitByRequestId };
        delete pendingModelCommitByRequestId[event.client_request_id];
        return {
          ...state,
          committedModelSelectionByScope: {
            ...state.committedModelSelectionByScope,
            [event.chat_id]: selection
          },
          pendingPresetByScope: clearChatMapValue(
            state.pendingPresetByScope,
            pending.scopeKey
          ),
          pendingModelCommitByRequestId
        };
      }
    case "runtime_model_updated":
      return state;
    default:
      return state;
  }
}

function reduceChatContentEvent(state: AgentState, event: MemmyAgentWsEvent): AgentState {
  const chatId = event.chat_id ?? state.currentChatId;
  if (!chatId) {
    return state;
  }
  const suppressing = state.suppressAssistantStreamUntilTurnEndByChatId[chatId] === true;
  const turnId = eventTurnId(event);
  if (turnId && isClosedTurn(state, chatId, turnId) && !isCancellationTerminalFileEditEvent(event)) {
    return state;
  }
  if (event.event === "retry_wait" && shouldDropRetryWaitForStoppingChat(state, chatId)) {
    return clearRetryWaitStatusForChat(state, chatId);
  }
  return withScopedChatMessages(state, chatId, (scopedState) => {
    const activeState = event.event === "retry_wait"
      ? scopedState
      : finishRetryWaitStatusForTurn(scopedState, chatId, turnId);
    switch (event.event) {
      case "user":
        return appendExternalUserMessage(scopedState, chatId, event);
      case "retry_wait":
        return upsertRetryWaitStatus(scopedState, event);
      case "delta":
        if (suppressing) return activeState;
        return appendAssistantDelta(activeState, event.text ?? "", turnId);
      case "stream_end":
        if (suppressing) return activeState;
        return endAssistantStream(activeState, event.text, event.resuming === true, turnId);
      case "reasoning_delta":
        if (suppressing) return activeState;
        return appendReasoningDelta(activeState, event.text ?? "", turnId);
      case "reasoning_end":
        if (suppressing) return activeState;
        return closeReasoningStream(activeState, turnId);
      case "message":
        if (event.kind === "progress" || event.kind === "tool_hint") {
          if (suppressing) return activeState;
          return appendToolProgress(activeState, event);
        }
        if (event.kind === "reasoning") {
          if (suppressing) return activeState;
          return appendCompleteReasoningMessage(activeState, event.text ?? event.content ?? "", turnId);
        }
        {
          const nextState = appendAssistantMessage(activeState, event);
          return assistantMessageHasMedia(event)
            ? setSuppressAssistantStreamUntilTurnEnd(nextState, chatId, true)
            : nextState;
        }
      case "file_edit":
        return appendFileEditTrace(activeState, event);
      case "context_compaction":
        return upsertContextCompactionDivider(activeState, event);
      default:
        return activeState;
    }
  });
}

function isChatContentEvent(event: string): boolean {
  return [
    "user",
    "delta",
    "stream_end",
    "reasoning_delta",
    "reasoning_end",
    "message",
    "file_edit",
    "context_compaction",
    "retry_wait"
  ].includes(event);
}

function appendExternalUserMessage(
  state: AgentState,
  chatId: string,
  event: MemmyAgentWsEvent
): AgentState {
  const turnId = eventTurnId(event);
  if (turnId && state.messages.some((message) => message.role === "user" && message.turnId === turnId)) {
    return state;
  }
  const content = typeof event.text === "string"
    ? event.text
    : typeof event.content === "string"
      ? event.content
      : "";
  const normalizedMedia = Array.isArray(event.media_urls) ? normalizeMedia(event.media_urls) : [];
  const message: AgentChatMessage = {
    id: nextMessageId(state.messages, "user"),
    role: "user",
    content,
    ...(turnId ? { turnId } : {}),
    ...(normalizedMedia.length ? { media: normalizedMedia } : {})
  };
  const messages = [...state.messages, message];
  return {
    ...state,
    messages,
    messagesByChatId: {
      ...state.messagesByChatId,
      [chatId]: messages
    }
  };
}

function withScopedChatMessages(
  state: AgentState,
  chatId: string,
  reducer: (scopedState: AgentState) => AgentState
): AgentState {
  if (chatId === state.currentChatId) {
    return reducer(state);
  }

  const scopedState = {
    ...state,
    currentChatId: chatId,
    currentSessionKey: chatIdToSessionKey(chatId),
    messages: state.messagesByChatId[chatId] ?? [],
    isSending: isChatBusy(state, chatId),
    blankDraftActive: false,
    goalState: state.goalStatesByChatId[chatId] ?? null
  };
  const reduced = reducer(scopedState);
  const messagesByChatId = {
    ...reduced.messagesByChatId,
    [chatId]: reduced.messages
  };
  const currentChatId = state.currentChatId;
  const nextState = {
    ...reduced,
    currentChatId,
    currentSessionKey: state.currentSessionKey,
    messages: state.messages,
    messagesByChatId,
    isSending: currentChatId
      ? isChatBusy({ ...reduced, messagesByChatId }, currentChatId)
        || chatHasLiveStream({ ...reduced, currentChatId: state.currentChatId, messages: state.messages, messagesByChatId }, currentChatId)
      : false,
    blankDraftActive: state.blankDraftActive,
    goalState: currentChatId ? reduced.goalStatesByChatId[currentChatId] ?? null : null
  };
  return deriveTasks(nextState);
}

function withCurrentChat(state: AgentState, chatId: string | null): AgentState {
  return chatId ? switchCurrentChat(state, chatId) : state;
}

function mediaRejectedMessageKey(reason: string | undefined): string {
  switch (reason) {
    case "mime":
    case "deprecated_payload":
      return "home.media.error.sendUnsupported";
    case "size":
      return "home.media.error.sendFileSize";
    case "too_many_images":
    case "too_many_attachments":
      return "home.media.error.sendTooManyAttachments";
    case "decode":
    case "malformed":
      return "home.media.error.sendReadFailed";
    default:
      return "home.media.error.sendFailed";
  }
}

function clearTransientSend(state: AgentState, chatId: string): AgentState {
  const canonical = hasCanonicalSession(state, chatId);
  const shouldRestoreBlankDraft = !canonical && (!state.currentChatId || state.currentChatId === chatId);
  const optimisticSendingByChatId = clearChatMapValue(state.optimisticSendingByChatId, chatId);
  const optimisticTasksByChatId = canonical
    ? state.optimisticTasksByChatId
    : clearChatMapValue(state.optimisticTasksByChatId, chatId);
  return deriveTasks({
    ...state,
    optimisticSendingByChatId,
    optimisticTasksByChatId,
    ...(shouldRestoreBlankDraft
      ? {
          currentChatId: null,
          currentSessionKey: null,
          messages: [],
          blankDraftActive: true,
          isSending: false
        }
      : { isSending: state.currentChatId === chatId ? false : state.isSending })
  });
}

function handleTransportMessageTooBig(state: AgentState, event: MemmyAgentWsEvent): AgentState {
  const chatId = event.chat_id ?? state.currentChatId;
  if (!chatId) {
    return setOperationError(state, "chat", operationErrorForChat("home.media.error.messageTooBig", undefined, "send"));
  }
  const nextState = clearRejectedOptimisticSend(state, chatId);
  return setOperationError(nextState, "chat", operationErrorForChat("home.media.error.messageTooBig", chatId, "send"));
}

function handleMediaRejected(state: AgentState, event: MemmyAgentWsEvent): AgentState {
  const chatId = event.chat_id ?? state.currentChatId;
  if (!chatId) {
    return setOperationError(state, "chat", operationErrorForChat(mediaRejectedMessageKey(event.reason), undefined, "send"));
  }

  return setOperationError(
    clearRejectedOptimisticSend(state, chatId),
    "chat",
    operationErrorForChat(mediaRejectedMessageKey(event.reason), chatId, "send")
  );
}

function handleMissingContent(state: AgentState, event: MemmyAgentWsEvent): AgentState {
  const chatId = event.chat_id;
  const nextState = chatId ? clearRejectedOptimisticSend(state, chatId) : state;
  return setOperationError(nextState, "chat", operationErrorFromEvent(event, "send"));
}

function handleStopFailed(state: AgentState, event: MemmyAgentWsEvent): AgentState {
  const chatId = event.chat_id;
  const nextState = chatId
    ? { ...state, stopInFlightByChatId: clearChatMapValue(state.stopInFlightByChatId, chatId) }
    : state;
  return setOperationError(nextState, "chat", operationErrorFromEvent(event, "gateway-command"));
}

function clearRejectedOptimisticSend(state: AgentState, chatId: string): AgentState {
  if (!state.optimisticSendingByChatId[chatId]) {
    return state;
  }
  const optimisticSendingByChatId = clearChatMapValue(state.optimisticSendingByChatId, chatId);
  const optimisticTasksByChatId = hasCanonicalSession(state, chatId)
    ? state.optimisticTasksByChatId
    : clearChatMapValue(state.optimisticTasksByChatId, chatId);
  const messages = removeLatestOptimisticUser(chatMessagesForId(state, chatId));
  return deriveTasks({
    ...state,
    optimisticSendingByChatId,
    optimisticTasksByChatId,
    messagesByChatId: { ...state.messagesByChatId, [chatId]: messages },
    ...(chatId === state.currentChatId
      ? { messages, isSending: isChatBusy({ ...state, optimisticSendingByChatId }, chatId) }
      : {})
  });
}

function operationErrorForChat(
  message: string,
  chatId: string | undefined,
  source: AgentOperationErrorSource
): AgentOperationError {
  const createdAt = Date.now();
  agentWsOperationErrorCounter += 1;
  return {
    id: `${source}-${chatId ?? "global"}-${createdAt}-${agentWsOperationErrorCounter}`,
    source,
    message,
    ...(chatId ? { chatId } : {}),
    createdAt
  };
}

function removeLatestOptimisticUser(messages: AgentChatMessage[]): AgentChatMessage[] {
  const next = [...messages];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    if (next[index]?.role === "user") {
      next.splice(index, 1);
      break;
    }
  }
  return next;
}

function markRestartSawDisconnect(state: AgentState): AgentState {
  return state.isRestarting ? { ...state, restartSawDisconnect: true } : state;
}

function completeRestartAfterReconnect(state: AgentState): AgentState {
  if (!state.isRestarting || !state.restartSawDisconnect) {
    return state;
  }
  return {
    ...state,
    isRestarting: false,
    restartCompletedAt: Date.now(),
    restartError: null
  };
}

/**
 * Streaming text always renders as a normal answer block: the reader follows
 * it in full answer typography, exactly like Cursor. Whether it was actually
 * a mid-loop draft is only known when the runtime closes the segment — a
 * `resuming` close folds it into the activity timeline as narration (a
 * deliberate "the agent moved on" gesture), while a final close leaves it
 * untouched, so the real answer never restyles at the end of the turn.
 */
function latestMessageIndexForTurn(messages: AgentChatMessage[], turnId: string | null): number {
  if (!turnId) {
    return messages.length - 1;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.turnId === turnId) {
      return index;
    }
  }
  return -1;
}

function previousMessageIndexForTurn(messages: AgentChatMessage[], beforeIndex: number, turnId: string | null): number {
  if (!turnId) {
    return beforeIndex - 1;
  }
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    if (messages[index]?.turnId === turnId) {
      return index;
    }
  }
  return -1;
}

function newStreamingAssistantMessage(
  messages: AgentChatMessage[],
  text: string,
  keepBusy: boolean,
  turnId: string | null
): AgentChatMessage {
  return {
    id: nextMessageId(messages, "assistant"),
    role: "assistant",
    content: text,
    ...(turnId ? { turnId } : {}),
    createdAt: Date.now(),
    isStreaming: keepBusy,
    ...(!keepBusy ? { stoppedByUser: true } : {})
  };
}

function appendAssistantDelta(state: AgentState, text: string, turnId: string | null): AgentState {
  if (!text) {
    return state;
  }

  const keepBusy = shouldLiveEventKeepChatBusy(state);
  const messages = [...state.messages];
  const lastIndex = latestMessageIndexForTurn(messages, turnId);
  const last = lastIndex >= 0 ? messages[lastIndex] : undefined;
  if (last && isReasoningOnlyActivityMessage(last) && last.isStreaming) {
    const closedReasoning = {
      ...last,
      reasoningStreaming: false,
      isStreaming: false,
      activitySegmentId: last.activitySegmentId ?? currentOrTurnActivitySegmentId(messages, turnId)
    };
    messages[lastIndex] = {
      ...closedReasoning,
      ...(!keepBusy && hasLoadedMessagePayload(closedReasoning) ? { stoppedByUser: true } : {})
    };
    messages.push(newStreamingAssistantMessage(messages, text, keepBusy, turnId));
  } else if (last?.role === "assistant" && last.isStreaming) {
    const next = {
      ...last,
      content: `${last.content}${text}`,
      ...(turnId ? { turnId } : {}),
      isStreaming: keepBusy
    };
    messages[lastIndex] = {
      ...next,
      ...(!keepBusy && hasLoadedMessagePayload(next) ? { stoppedByUser: true } : {})
    };
  } else {
    messages.push(newStreamingAssistantMessage(messages, text, keepBusy, turnId));
  }
  return syncCurrentMessages({ ...state, messages, isSending: keepBusy });
}

function endAssistantStream(
  state: AgentState,
  text: string | undefined,
  resuming: boolean,
  turnId: string | null
): AgentState {
  const messages = [...state.messages];
  const lastIndex = latestMessageIndexForTurn(messages, turnId);
  const last = lastIndex >= 0 ? messages[lastIndex] : undefined;
  let closedIndex = -1;
  if (last?.role === "assistant" && last.isStreaming) {
    messages[lastIndex] = {
      ...last,
      content: text ?? last.content,
      ...(turnId ? { turnId } : {})
    };
    closedIndex = lastIndex;
  }
  if (resuming) {
    // The runtime says this text segment is a mid-turn draft: the loop will
    // continue with more tools/text. Reclassify it as activity narration so
    // the turn's answer channel only ever holds the final answer. This is the
    // semantic signal (no content heuristics) that keeps live rendering and
    // history hydration consistent, and prevents cumulative drafts stacking
    // up as repeated answer bubbles.
    const targetIndex = closedIndex >= 0 ? closedIndex : findLatestFoldableAssistantAnswerIndex(messages, turnId);
    if (targetIndex >= 0) {
      const target = messages[targetIndex]!;
      const hasContent = target.content.trim().length > 0;
      messages[targetIndex] = {
        ...target,
        ...(hasContent && target.kind !== "trace" && !target.media?.length ? { kind: "narration" as const } : {}),
        isStreaming: false,
        reasoningStreaming: false,
        activitySegmentId: target.activitySegmentId ?? currentOrTurnActivitySegmentId(messages, turnId)
      };
    }
  } else if (closedIndex >= 0) {
    const target = messages[closedIndex]!;
    if (target.kind === "narration" && target.content.trim()) {
      // The segment streamed as loop narration, but the runtime closed it as
      // final: promote it to the turn's answer.
      const { kind, activitySegmentId, ...promoted } = target;
      void kind;
      void activitySegmentId;
      messages[closedIndex] = promoted;
    }
  }
  return syncCurrentMessages({ ...state, messages });
}

function appendReasoningDelta(state: AgentState, text: string, turnId: string | null): AgentState {
  if (!text) {
    return state;
  }

  const keepBusy = shouldLiveEventKeepChatBusy(state);

  // Some providers interleave reasoning and content chunks within one
  // segment ("…with all" → body → "the details." → body). A reasoning chunk
  // arriving while an answer is mid-stream is a continuation of the thought
  // block that precedes that answer — never a brand-new thought below it.
  // Splitting here used to fracture the answer into two bubbles and spawn an
  // orphan "Thinking" cluster holding half a sentence.
  const streamingAnswerIndex = findLatestStreamingAssistantAnswerIndex(state.messages, turnId);
  const streamingAnswer = streamingAnswerIndex >= 0 ? state.messages[streamingAnswerIndex] : undefined;
  if (
    streamingAnswer?.role === "assistant"
    && streamingAnswer.kind !== "trace"
    && streamingAnswer.isStreaming
    && streamingAnswer.content.trim()
  ) {
    const messages = [...state.messages];
    const previousIndex = previousMessageIndexForTurn(messages, streamingAnswerIndex, turnId);
    const previous = messages[previousIndex];
    if (previous?.role === "assistant" && previous.kind !== "trace" && previous.reasoning) {
      messages[previousIndex] = { ...previous, reasoning: `${previous.reasoning}${text}` };
    } else {
      messages.splice(streamingAnswerIndex, 0, {
        id: nextMessageId(messages, "assistant"),
        role: "assistant",
        content: "",
        reasoning: text,
        reasoningStreaming: false,
        ...(turnId ? { turnId } : {}),
        activitySegmentId: currentOrTurnActivitySegmentId(messages, turnId),
        createdAt: Date.now(),
        isStreaming: false
      });
    }
    return syncCurrentMessages({ ...state, messages, isSending: keepBusy });
  }

  const messages = closeLatestAssistantAnswerBeforeNewActivity([...state.messages], turnId);
  const lastIndex = latestMessageIndexForTurn(messages, turnId);
  const last = lastIndex >= 0 ? messages[lastIndex] : undefined;
  if (last?.role === "assistant" && last.kind !== "trace" && last.isStreaming && !last.content.trim() && !last.media?.length) {
    const next = {
      ...last,
      reasoning: `${last.reasoning ?? ""}${text}`,
      reasoningStreaming: keepBusy,
      ...(turnId ? { turnId } : {}),
      activitySegmentId: last.activitySegmentId ?? currentOrTurnActivitySegmentId(messages, turnId)
    };
    messages[lastIndex] = {
      ...next,
      isStreaming: keepBusy,
      ...(!keepBusy && hasLoadedMessagePayload(next) ? { stoppedByUser: true } : {})
    };
  } else {
    messages.push({
      id: nextMessageId(messages, "assistant"),
      role: "assistant",
      content: "",
      reasoning: text,
      reasoningStreaming: keepBusy,
      ...(turnId ? { turnId } : {}),
      activitySegmentId: currentOrTurnActivitySegmentId(messages, turnId),
      createdAt: Date.now(),
      isStreaming: keepBusy,
      ...(!keepBusy ? { stoppedByUser: true } : {})
    });
  }
  return syncCurrentMessages({ ...state, messages, isSending: keepBusy });
}

function currentTurnStartIndex(messages: AgentChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      return index + 1;
    }
  }
  return 0;
}

function firstActivitySegmentIdInCurrentTurn(messages: AgentChatMessage[]): string | null {
  for (let index = currentTurnStartIndex(messages); index < messages.length; index += 1) {
    const segmentId = messages[index]?.activitySegmentId;
    if (segmentId) {
      return segmentId;
    }
  }
  return null;
}

function currentTurnActivitySegmentId(messages: AgentChatMessage[]): string {
  return firstActivitySegmentIdInCurrentTurn(messages) ?? nextActivitySegmentId(messages);
}

function findActivitySegmentIdByTurn(messages: AgentChatMessage[], turnId: string | null): string | null {
  if (!turnId) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const segmentId = messages[index]?.turnId === turnId ? messages[index]?.activitySegmentId : null;
    if (segmentId) return segmentId;
  }
  return null;
}

function currentOrTurnActivitySegmentId(messages: AgentChatMessage[], turnId: string | null): string {
  return findActivitySegmentIdByTurn(messages, turnId) ?? currentTurnActivitySegmentId(messages);
}

function nextActivitySegmentId(messages: AgentChatMessage[]): string {
  const used = new Set(messages.flatMap((message) => message.activitySegmentId ? [message.activitySegmentId] : []));
  let index = messages.length + 1;
  let candidate = `activity-${index}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `activity-${index}`;
  }
  return candidate;
}

function nextMessageId(messages: AgentChatMessage[], prefix: "assistant" | "tool" | "user"): string {
  const used = new Set(messages.map((message) => message.id));
  let index = messages.length + 1;
  let candidate = `${prefix}-${index}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `${prefix}-${index}`;
  }
  return candidate;
}

function lastUserMessageId(messages: AgentChatMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      return message.id;
    }
  }
  return undefined;
}

function nextRetryWaitStatusId(statuses: Record<string, AgentRetryWaitStatus | undefined>): string {
  const used = new Set(Object.values(statuses).flatMap((status) => status ? [status.id] : []));
  let index = used.size + 1;
  let candidate = `retry-wait-${index}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `retry-wait-${index}`;
  }
  return candidate;
}

function upsertRetryWaitStatus(state: AgentState, event: MemmyAgentWsEvent): AgentState {
  const chatId = state.currentChatId;
  const text = typeof event.text === "string" ? event.text.trim() : "";
  if (!chatId || !text) {
    return state;
  }

  const turnId = eventTurnId(event);
  const now = Date.now();
  const existing = state.retryWaitStatusByChatId[chatId];
  const shouldUpdateExisting = existing && (!turnId || !existing.turnId || existing.turnId === turnId);
  const nextStatus: AgentRetryWaitStatus = shouldUpdateExisting
    ? {
        ...existing,
        text,
        isRunning: shouldLiveEventKeepChatBusy(state),
        updatedAt: now,
        ...(turnId ? { turnId } : {})
      }
    : {
        id: nextRetryWaitStatusId(state.retryWaitStatusByChatId),
        chatId,
        text,
        anchorMessageId: lastUserMessageId(state.messages),
        isRunning: shouldLiveEventKeepChatBusy(state),
        createdAt: now,
        updatedAt: now,
        ...(turnId ? { turnId } : {})
      };

  return syncCurrentMessages({
    ...state,
    retryWaitStatusByChatId: {
      ...state.retryWaitStatusByChatId,
      [chatId]: nextStatus
    },
    isSending: shouldLiveEventKeepChatBusy(state)
  });
}

function shouldDropRetryWaitForStoppingChat(state: AgentState, chatId: string): boolean {
  return Boolean(state.stopInFlightByChatId[chatId]);
}

function clearRetryWaitStatusForChat(state: AgentState, chatId: string): AgentState {
  const retryWaitStatusByChatId = clearChatMapValue(state.retryWaitStatusByChatId, chatId);
  if (retryWaitStatusByChatId === state.retryWaitStatusByChatId) {
    return state;
  }
  const nextState = {
    ...state,
    retryWaitStatusByChatId
  };
  return chatId === state.currentChatId ? syncCurrentMessages(nextState) : nextState;
}

function finishRetryWaitStatusForTurn(state: AgentState, chatId: string, turnId: string | null): AgentState {
  const status = state.retryWaitStatusByChatId[chatId];
  if (!status?.isRunning) {
    return state;
  }
  if (turnId && status.turnId && status.turnId !== turnId) {
    return state;
  }

  const nextState = {
    ...state,
    retryWaitStatusByChatId: {
      ...state.retryWaitStatusByChatId,
      [chatId]: {
        ...status,
        isRunning: false,
        updatedAt: Date.now()
      }
    }
  };
  return chatId === state.currentChatId ? syncCurrentMessages(nextState) : nextState;
}

function toolProgressFallbackLine(event: MemmyAgentWsEvent): string {
  const text = typeof event.text === "string" && event.text.trim()
    ? event.text.trim()
    : typeof event.content === "string" && event.content.trim()
      ? event.content.trim()
      : "";
  if (text) {
    return text;
  }
  return event.agent_ui == null ? "" : safeStringify(event.agent_ui);
}

function normalizeContextCompactionStatus(value: unknown): AgentCompactionStatus {
  return value === "running" || value === "done" || value === "error" ? value : "done";
}

function contextCompactionFallbackText(status: AgentCompactionStatus): string {
  if (status === "running") return "Summarizing chat context";
  if (status === "error") return "Context summary failed";
  return "Context summary complete";
}

function contextCompactionEventText(event: MemmyAgentWsEvent, status: AgentCompactionStatus): string {
  const text = typeof event.text === "string" && event.text.trim()
    ? event.text.trim()
    : typeof event.content === "string" && event.content.trim()
      ? event.content.trim()
      : "";
  return text || contextCompactionFallbackText(status);
}

function findFileEditTraceIndex(messages: AgentChatMessage[], incoming: AgentFileEdit[], turnId: string | null = null): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || (!turnId && message.role === "user")) {
      break;
    }
    if (turnId && message.turnId !== turnId) continue;
    if (message.kind !== "trace" || !message.fileEdits?.length) {
      continue;
    }
    if (message.fileEdits.some((edit) => incoming.some((candidate) => fileEditsShareActivity(edit, candidate)))) {
      return index;
    }
  }
  return -1;
}

function toolEventName(event: AgentToolProgressEvent): string {
  if (typeof event.name === "string" && event.name) {
    return event.name;
  }
  return typeof event.function?.name === "string" && event.function.name ? event.function.name : "";
}

function toolEventCallId(event: AgentToolProgressEvent): string {
  return typeof event.call_id === "string" && event.call_id ? event.call_id : "";
}

function toolEventUiCallId(event: AgentToolProgressEvent): string {
  return typeof event.ui_tool_call_id === "string" && event.ui_tool_call_id ? event.ui_tool_call_id : "";
}

function fileEditCallId(edit: AgentFileEdit): string {
  return edit.call_id || "";
}

function fileEditUiCallId(edit: AgentFileEdit): string {
  return edit.ui_tool_call_id || "";
}

function fileEditMatchesToolEvent(edit: AgentFileEdit, event: AgentToolProgressEvent): boolean {
  const editUiCallId = fileEditUiCallId(edit);
  const eventUiCallId = toolEventUiCallId(event);
  if (editUiCallId && eventUiCallId) {
    if (editUiCallId !== eventUiCallId) return false;
    const name = toolEventName(event);
    return !name || edit.tool === name;
  }
  const editCallId = fileEditCallId(edit);
  const eventCallId = toolEventCallId(event);
  if (!editCallId || !eventCallId || editCallId !== eventCallId) {
    return false;
  }
  const name = toolEventName(event);
  return !name || edit.tool === name;
}

function toolEventsMatch(left: AgentToolProgressEvent, right: AgentToolProgressEvent): boolean {
  const leftUiCallId = toolEventUiCallId(left);
  const rightUiCallId = toolEventUiCallId(right);
  if (leftUiCallId && rightUiCallId) {
    if (leftUiCallId !== rightUiCallId) return false;
    const leftName = toolEventName(left);
    const rightName = toolEventName(right);
    return !leftName || !rightName || leftName === rightName;
  }
  const leftCallId = toolEventCallId(left);
  const rightCallId = toolEventCallId(right);
  if (!leftCallId || !rightCallId || leftCallId !== rightCallId) {
    return false;
  }
  const leftName = toolEventName(left);
  const rightName = toolEventName(right);
  return !leftName || !rightName || leftName === rightName;
}

function findFileEditTraceIndexForToolEvents(messages: AgentChatMessage[], events: AgentToolProgressEvent[], turnId: string | null = null): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || (!turnId && message.role === "user")) {
      break;
    }
    if (turnId && message.turnId !== turnId) continue;
    if (message.kind !== "trace" || !message.fileEdits?.length) {
      continue;
    }
    if (message.fileEdits.some((edit) => events.some((event) => fileEditMatchesToolEvent(edit, event)))) {
      return index;
    }
  }
  return -1;
}

function findToolTraceIndexForToolEvents(messages: AgentChatMessage[], events: AgentToolProgressEvent[], segmentId: string | null, turnId: string | null = null): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || (!turnId && message.role === "user")) {
      break;
    }
    if (turnId && message.turnId !== turnId) continue;
    if (message.kind !== "trace" || !message.toolEvents?.length || (segmentId && message.activitySegmentId !== segmentId)) {
      continue;
    }
    if (message.toolEvents.some((event) => events.some((incoming) => toolEventsMatch(event, incoming)))) {
      return index;
    }
  }
  return -1;
}

function findToolTraceSegmentIdForFileEdits(messages: AgentChatMessage[], edits: AgentFileEdit[], turnId: string | null = null): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || (!turnId && message.role === "user")) {
      break;
    }
    if (turnId && message.turnId !== turnId) continue;
    if (message.kind !== "trace" || !message.toolEvents?.length) {
      continue;
    }
    if (message.toolEvents.some((event) => edits.some((edit) => fileEditMatchesToolEvent(edit, event)))) {
      return message.activitySegmentId ?? null;
    }
  }
  return null;
}

function isFileEditActivityMessage(message: AgentChatMessage | undefined): boolean {
  return Boolean(message?.kind === "trace" && message.fileEdits?.length);
}

function isActivityMessageRunning(message: AgentChatMessage | undefined): boolean {
  return Boolean(message && (message.isStreaming || message.reasoningStreaming));
}

function isTerminalToolPhase(phase: unknown): boolean {
  return phase === "end" || phase === "error";
}

function areToolEventsComplete(events: AgentToolProgressEvent[] | undefined): boolean {
  if (!events?.length) {
    return false;
  }
  return events.every((event) => isTerminalToolPhase(event.phase));
}

function areFileEditsComplete(edits: AgentFileEdit[] | undefined): boolean {
  if (!edits?.length) {
    return false;
  }
  return edits.every((edit) => edit.status === "done" || edit.status === "error");
}

function isReasoningOnlyActivityMessage(message: AgentChatMessage): boolean {
  return message.role === "assistant"
    && message.kind !== "trace"
    && !message.content.trim()
    && Boolean(message.reasoning)
    && !message.media?.length;
}

function findLatestFoldableAssistantAnswerIndex(
  messages: AgentChatMessage[],
  turnId: string | null = null
): number {
  const startIndex = turnId ? 0 : currentTurnStartIndex(messages);
  for (let index = messages.length - 1; index >= startIndex; index -= 1) {
    const message = messages[index];
    if (turnId && message?.turnId !== turnId) {
      continue;
    }
    if (
      message?.role === "assistant"
      && message.kind !== "trace"
      && message.kind !== "narration"
      && message.content.trim().length > 0
      && !message.media?.length
    ) {
      return index;
    }
  }
  return -1;
}

/**
 * Close out the turn's latest visible assistant answer before new activity
 * (reasoning / tool progress / file edits) starts.
 *
 * This intentionally does NOT reclassify the message into a `kind: "trace"`
 * activity row anymore (the previous "fold into activity" behavior). Cursor-
 * style rendering treats every intermediate assistant answer as a permanent,
 * visible body block that alternates with surrounding thought/tool activity —
 * turning it gray and folding it into the activity trace made multi-round
 * turns look like everything was "just thinking" once a second round began,
 * which is exactly the bug this replaces. Marking it non-streaming is still
 * required so a later round doesn't keep appending text onto an old,
 * already-finished answer bubble.
 */
function closeLatestAssistantAnswerBeforeNewActivity(
  messages: AgentChatMessage[],
  turnId: string | null = null
): AgentChatMessage[] {
  const targetIndex = findLatestFoldableAssistantAnswerIndex(messages, turnId);
  if (targetIndex < 0) {
    return messages;
  }
  const target = messages[targetIndex]!;
  if (!target.isStreaming && !target.reasoningStreaming) {
    return messages;
  }
  const next = [...messages];
  next[targetIndex] = { ...target, isStreaming: false, reasoningStreaming: false };
  return next;
}

function fileEditKey(edit: AgentFileEdit): string {
  const identity = edit.ui_tool_call_id
    ? `ui:${edit.ui_tool_call_id}`
    : edit.call_id
      ? `call:${edit.call_id}`
      : `legacy:${edit.tool}`;
  const editPath = (edit.absolute_path || edit.path || "pending").replace(/\\/gu, "/");
  return `${identity}:${edit.tool}:${editPath}`;
}

function fileEditsShareActivity(left: AgentFileEdit, right: AgentFileEdit): boolean {
  if (left.ui_tool_call_id && right.ui_tool_call_id) {
    return left.ui_tool_call_id === right.ui_tool_call_id && left.tool === right.tool;
  }
  if (left.call_id && right.call_id) {
    return left.call_id === right.call_id && left.tool === right.tool;
  }
  return !left.ui_tool_call_id
    && !right.ui_tool_call_id
    && !left.call_id
    && !right.call_id
    && left.tool === right.tool
    && fileEditKey(left) === fileEditKey(right);
}

const IMAGE_ATTACHMENT_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tif", ".tiff"]);
const VIDEO_ATTACHMENT_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v"]);

function isAgentChatMediaKind(value: unknown): value is AgentChatMediaKind {
  return value === "image" || value === "video" || value === "file";
}

function extensionOf(value: string | undefined): string {
  if (!value) return "";
  const clean = value.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
  const dot = clean.lastIndexOf(".");
  return dot >= 0 ? clean.slice(dot) : "";
}

function inferMediaKind(media: { url?: string; name?: string; kind?: AgentChatMediaKind; path?: string }): AgentChatMediaKind {
  if (isAgentChatMediaKind(media.kind)) return media.kind;
  if (media.url?.startsWith("data:image/")) return "image";
  if (media.url?.startsWith("data:video/")) return "video";
  const ext = extensionOf(media.name) || extensionOf(media.path) || extensionOf(media.url);
  if (IMAGE_ATTACHMENT_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_ATTACHMENT_EXTENSIONS.has(ext)) return "video";
  return "file";
}

function closeReasoningStream(state: AgentState, turnId: string | null): AgentState {
  return syncCurrentMessages({
    ...state,
    messages: state.messages.map((message) => {
      if (!message.reasoningStreaming || (turnId && message.turnId !== turnId)) {
        return message;
      }
      return {
        ...message,
        reasoningStreaming: false,
        ...(isReasoningOnlyActivityMessage(message) ? { isStreaming: false } : {})
      };
    })
  });
}

function appendCompleteReasoningMessage(state: AgentState, text: string, turnId: string | null): AgentState {
  if (!text) {
    return state;
  }
  return closeReasoningStream(appendReasoningDelta(state, text, turnId), turnId);
}

function findLatestStreamingAssistantAnswerIndex(
  messages: AgentChatMessage[],
  turnId: string | null = null
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || (!turnId && message.role === "user")) {
      break;
    }
    if (turnId && message.turnId !== turnId) {
      continue;
    }
    if (
      message.role === "assistant"
      && message.kind !== "trace"
      && message.isStreaming
      && message.content.trim().length > 0
    ) {
      return index;
    }
  }
  return -1;
}

function isCronProactiveEvent(event: MemmyAgentWsEvent): boolean {
  const metadata = event.metadata;
  return Boolean(
    metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).proactiveDelivery === "cron"
  );
}

function assistantMessageHasMedia(event: MemmyAgentWsEvent): boolean {
  return event.event === "message"
    && event.kind !== "tool_hint"
    && event.kind !== "progress"
    && event.kind !== "reasoning"
    && !isCronProactiveEvent(event)
    && Array.isArray(event.media_urls)
    && event.media_urls.length > 0;
}

function normalizeModelError(value: unknown): MemmyAgentModelError | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.category !== "quota_exhausted"
    && record.category !== "image_input_unsupported"
    && record.category !== "image_analysis_failed"
    && record.category !== "model_failed"
  ) return undefined;
  return {
    category: record.category,
    ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
    ...(typeof record.presetId === "string" ? { presetId: record.presetId } : {}),
    ...(record.source === "account" || record.source === "byok" ? { source: record.source } : {}),
    ...(typeof record.provider === "string" ? { provider: record.provider } : {}),
    ...(typeof record.model === "string" ? { model: record.model } : {}),
    ...(record.capability === "agent"
      || record.capability === "memory_summary"
      || record.capability === "memory_evolution"
      || record.capability === "embedding"
      || record.capability === "asr"
      || record.capability === "image_generation"
      ? { capability: record.capability }
      : {}),
    ...(typeof record.failedProvider === "string" ? { failedProvider: record.failedProvider } : {}),
    ...(typeof record.failedModel === "string" ? { failedModel: record.failedModel } : {})
  };
}

function appendAssistantMessage(state: AgentState, event: MemmyAgentWsEvent): AgentState {
  const turnId = eventTurnId(event);
  const text = typeof event.text === "string" ? event.text : typeof event.content === "string" ? event.content : "";
  const media = Array.isArray(event.media_urls) ? normalizeMedia(event.media_urls) : undefined;
  const modelError = normalizeModelError(event.model_error);
  const messages = [...state.messages];
  const forceNewAssistant = isCronProactiveEvent(event);
  const lastIndex = latestMessageIndexForTurn(messages, turnId);
  const last = lastIndex >= 0 ? messages[lastIndex] : undefined;
  let closedActivity = false;
  if (last && isReasoningOnlyActivityMessage(last) && last.isStreaming) {
    messages[lastIndex] = {
      ...last,
      reasoningStreaming: false,
      isStreaming: false,
      activitySegmentId: last.activitySegmentId ?? currentOrTurnActivitySegmentId(messages, turnId)
    };
    closedActivity = true;
  }
  const updatedLastIndex = latestMessageIndexForTurn(messages, turnId);
  const updatedLast = updatedLastIndex >= 0 ? messages[updatedLastIndex] : undefined;
  const targetIndex = forceNewAssistant
    ? -1
    : updatedLast?.role === "assistant" && updatedLast.isStreaming && updatedLast.kind !== "trace" && updatedLast.kind !== "narration"
      ? updatedLastIndex
      : findLatestStreamingAssistantAnswerIndex(messages, turnId);
  const preservePartialImageAnswer = targetIndex >= 0
    && Boolean(messages[targetIndex]?.content.trim())
    && (modelError?.category === "image_input_unsupported" || modelError?.category === "image_analysis_failed");

  if (preservePartialImageAnswer) {
    messages[targetIndex] = {
      ...messages[targetIndex]!,
      isStreaming: false,
      reasoningStreaming: false
    };
  }

  if (targetIndex >= 0 && !preservePartialImageAnswer) {
    const target = messages[targetIndex]!;
    messages[targetIndex] = {
      ...target,
      content: modelError ? text : text || target.content,
      ...(media?.length ? { media } : {}),
      ...(modelError ? { modelError } : {}),
      ...(typeof event.latency_ms === "number" ? { latencyMs: event.latency_ms } : {}),
      ...(turnId ? { turnId } : {}),
      isStreaming: true
    };
  } else {
    if (!text.trim() && !media?.length && !modelError) {
      return closedActivity ? syncCurrentMessages({ ...state, messages }) : state;
    }
    const next: AgentChatMessage = {
      id: nextMessageId(messages, "assistant"),
      role: "assistant",
      content: text,
      ...(turnId ? { turnId } : {}),
      createdAt: Date.now(),
      ...(media?.length ? { media } : {}),
      ...(modelError ? { modelError } : {}),
      ...(typeof event.latency_ms === "number" ? { latencyMs: event.latency_ms } : {})
    };
    messages.push(next);
  }

  return syncCurrentMessages({ ...state, messages });
}

function appendToolProgress(state: AgentState, event: MemmyAgentWsEvent): AgentState {
  const turnId = eventTurnId(event);
  const structuredEvents = normalizeToolProgressEvents(event.tool_events);
  const structuredLines = toolTraceLinesFromEvents(event.tool_events);
  const fallbackLine = toolProgressFallbackLine(event);
  const lines = structuredLines.length ? structuredLines : fallbackLine ? [fallbackLine] : [];
  if (!lines.length) {
    return state;
  }

  const keepBusy = shouldLiveEventKeepChatBusy(state);
  const messages = closeLatestAssistantAnswerBeforeNewActivity([...state.messages], turnId);
  const relatedFileEditIndex = structuredEvents.length ? findFileEditTraceIndexForToolEvents(messages, structuredEvents, turnId) : -1;
  const relatedFileEdit = relatedFileEditIndex >= 0 ? messages[relatedFileEditIndex] : undefined;
  const currentSegmentId = relatedFileEdit?.activitySegmentId ?? currentOrTurnActivitySegmentId(messages, turnId);
  const existingToolTraceIndex = structuredEvents.length
    ? findToolTraceIndexForToolEvents(messages, structuredEvents, currentSegmentId, turnId)
    : -1;
  const existingToolTrace = existingToolTraceIndex >= 0 ? messages[existingToolTraceIndex] : undefined;
  const segmentId = relatedFileEdit?.activitySegmentId ?? existingToolTrace?.activitySegmentId ?? currentSegmentId;
  if (existingToolTraceIndex >= 0) {
    const target = messages[existingToolTraceIndex];
    if (!target) {
      return state;
    }
    const previousTraces = target.traces?.length ? target.traces : target.content ? [target.content] : [];
    const mergedLines = structuredLines.length
      ? mergeUniqueToolTraceLines(previousTraces, structuredLines)
      : { traces: [...previousTraces, ...lines], added: true };
    if (!mergedLines.added && !structuredEvents.length) {
      return state;
    }
    const toolEvents = structuredEvents.length ? mergeToolProgressEvents(target.toolEvents, structuredEvents) : target.toolEvents;
    const next: AgentChatMessage = {
      ...target,
      kind: "trace",
      traces: mergedLines.traces,
      content: mergedLines.traces.at(-1) ?? "",
      toolEvents,
      ...(turnId ? { turnId } : {}),
      activitySegmentId: target.activitySegmentId ?? segmentId,
      isStreaming: keepBusy && (structuredEvents.length ? !areToolEventsComplete(toolEvents) : true)
    };
    messages[existingToolTraceIndex] = {
      ...next,
      ...(!keepBusy && hasLoadedMessagePayload(next) ? { stoppedByUser: true } : {})
    };
    return syncCurrentMessages({ ...state, messages, isSending: keepBusy });
  }

  const last = messages.at(-1);
  if (
    last?.kind === "trace"
    && !isFileEditActivityMessage(last)
    && isActivityMessageRunning(last)
    && (!last.activitySegmentId || last.activitySegmentId === segmentId)
    && (!turnId || last.turnId === turnId)
  ) {
    const previousTraces = last.traces?.length ? last.traces : last.content ? [last.content] : [];
    const mergedLines = structuredLines.length
      ? mergeUniqueToolTraceLines(previousTraces, structuredLines)
      : { traces: [...previousTraces, ...lines], added: true };
    if (!mergedLines.added && !structuredEvents.length) {
      return state;
    }
    const toolEvents = structuredEvents.length ? mergeToolProgressEvents(last.toolEvents, structuredEvents) : last.toolEvents;
    const next: AgentChatMessage = {
      ...last,
      kind: "trace",
      traces: mergedLines.traces,
      content: mergedLines.traces.at(-1) ?? "",
      toolEvents,
      ...(turnId ? { turnId } : {}),
      activitySegmentId: last.activitySegmentId ?? segmentId,
      isStreaming: keepBusy && (structuredEvents.length ? !areToolEventsComplete(toolEvents) : true)
    };
    messages[messages.length - 1] = {
      ...next,
      ...(!keepBusy && hasLoadedMessagePayload(next) ? { stoppedByUser: true } : {})
    };
    return syncCurrentMessages({ ...state, messages, isSending: keepBusy });
  }

  const toolEvents = structuredEvents.length ? structuredEvents : undefined;
  messages.push({
    id: nextMessageId(messages, "tool"),
    role: "tool",
    kind: "trace",
    content: lines.at(-1) ?? "",
    traces: lines,
    ...(toolEvents ? { toolEvents } : {}),
    ...(turnId ? { turnId } : {}),
    activitySegmentId: segmentId,
    createdAt: Date.now(),
    isStreaming: keepBusy && (toolEvents ? !areToolEventsComplete(toolEvents) : true),
    ...(!keepBusy ? { stoppedByUser: true } : {})
  });
  return syncCurrentMessages({ ...state, messages, isSending: keepBusy });
}

function upsertContextCompactionDivider(state: AgentState, event: MemmyAgentWsEvent): AgentState {
  const turnId = eventTurnId(event);
  const compactionId = typeof event.compaction_id === "string" && event.compaction_id.trim()
    ? event.compaction_id.trim()
    : "context-compaction";
  const compactionStatus = normalizeContextCompactionStatus(event.status);
  const content = contextCompactionEventText(event, compactionStatus);
  const messages = [...state.messages];
  let existingIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || (!turnId && message.role === "user")) break;
    if (turnId && message.turnId !== turnId) continue;
    if (message.kind === "context_compaction" && message.compactionId === compactionId) {
      existingIndex = index;
      break;
    }
  }
  const next = {
    role: "tool" as const,
    kind: "context_compaction" as const,
    content,
    ...(turnId ? { turnId } : {}),
    compactionId,
    compactionStatus,
    isStreaming: compactionStatus === "running"
  };
  if (existingIndex >= 0) {
    const { traces, toolEvents, fileEdits, activitySegmentId, ...previous } = messages[existingIndex]!;
    void traces;
    void toolEvents;
    void fileEdits;
    void activitySegmentId;
    messages[existingIndex] = {
      ...previous,
      ...next
    };
  } else {
    messages.push({
      id: nextMessageId(messages, "tool"),
      createdAt: Date.now(),
      ...next
    });
  }
  return syncCurrentMessages({ ...state, messages });
}

function appendFileEditTrace(state: AgentState, event: MemmyAgentWsEvent): AgentState {
  const normalized = normalizeFileEdits(event.edits);
  if (!normalized.length) {
    return state;
  }

  const turnId = eventTurnId(event);
  const cancellationTerminal = isCancellationTerminalFileEditEvent(event);
  if (turnId && isClosedTurn(state, state.currentChatId ?? "", turnId) && !cancellationTerminal) {
    return state;
  }
  const keepBusy = cancellationTerminal ? false : shouldLiveEventKeepChatBusy(state);
  const messages = closeLatestAssistantAnswerBeforeNewActivity([...state.messages], turnId);
  const relatedToolSegmentId = findToolTraceSegmentIdForFileEdits(messages, normalized, turnId);
  const segmentId = relatedToolSegmentId ?? currentOrTurnActivitySegmentId(messages, turnId);
  const targetIndex = findFileEditTraceIndex(messages, normalized, turnId);
  if (targetIndex >= 0) {
    const target = messages[targetIndex];
    if (!target) {
      return state;
    }
    const fileEdits = mergeFileEdits(target.fileEdits, normalized);
    const next: AgentChatMessage = {
      ...target,
      kind: "trace",
      content: "",
      traces: [],
      fileEdits,
      ...(turnId ? { turnId } : {}),
      activitySegmentId: target.activitySegmentId ?? relatedToolSegmentId ?? segmentId,
      isStreaming: keepBusy && !areFileEditsComplete(fileEdits)
    };
    messages[targetIndex] = {
      ...next,
      ...(!keepBusy && hasLoadedMessagePayload(next) ? { stoppedByUser: true } : {})
    };
    return syncCurrentMessages({ ...state, messages, isSending: keepBusy });
  }

  if (cancellationTerminal || (turnId && isClosedTurn(state, state.currentChatId ?? "", turnId))) {
    return state;
  }

  messages.push({
    id: nextMessageId(messages, "tool"),
    role: "tool",
    kind: "trace",
    content: "",
    traces: [],
    fileEdits: normalized,
    ...(turnId ? { turnId } : {}),
    activitySegmentId: segmentId,
    createdAt: Date.now(),
    isStreaming: keepBusy && !areFileEditsComplete(normalized),
    ...(!keepBusy ? { stoppedByUser: true } : {})
  });
  return syncCurrentMessages({ ...state, messages, isSending: keepBusy });
}

function bumpRunStatusVersion(state: AgentState, chatId: string): Record<string, number> {
  return {
    ...state.runStatusVersionByChatId,
    [chatId]: (state.runStatusVersionByChatId[chatId] ?? 0) + 1
  };
}

function goalStateForChat(state: AgentState, chatId: string): AgentGoalState | null {
  return state.goalStatesByChatId[chatId]
    ?? (state.currentChatId === chatId ? state.goalState : null);
}

function sameGoalRun(
  clock: AgentGoalRunClock,
  goalId: string,
  startedAt: number,
  turnId: string | null
): boolean {
  if (clock.goalId !== goalId) return false;
  if (clock.turnId && turnId) return clock.turnId === turnId;
  return clock.startedAt === startedAt;
}

function updateGoalRunClockForRunning(
  state: AgentState,
  chatId: string,
  startedAt: number,
  turnId: string | null
): Record<string, AgentGoalRunClock | null> {
  const current = state.goalRunClockByChatId[chatId] ?? null;
  const goal = goalStateForChat(state, chatId);
  const goalId = goal?.goal_id ?? null;
  if (current && goalId && sameGoalRun(current, goalId, startedAt, turnId)) {
    const resolved = turnId && current.turnId !== turnId ? { ...current, turnId } : current;
    return resolved === current
      ? state.goalRunClockByChatId
      : { ...state.goalRunClockByChatId, [chatId]: resolved };
  }
  if (!goalId || goal?.status !== "active") {
    return current
      ? { ...state.goalRunClockByChatId, [chatId]: null }
      : state.goalRunClockByChatId;
  }
  return {
    ...state.goalRunClockByChatId,
    [chatId]: {
      goalId,
      turnId,
      startedAt,
      baseSeconds: goal.time_used_seconds
    }
  };
}

function updateGoalRunClockForGoalState(
  state: AgentState,
  chatId: string,
  goal: AgentGoalState
): Record<string, AgentGoalRunClock | null> {
  const current = state.goalRunClockByChatId[chatId] ?? null;
  const goalId = goal.goal_id;
  if (!goalId || goal.status === "completed") {
    return current
      ? { ...state.goalRunClockByChatId, [chatId]: null }
      : state.goalRunClockByChatId;
  }
  const startedAt = effectiveRunStartedAtForChat(state, chatId);
  const turnId = state.activeTurnIdByChatId[chatId] ?? null;
  if (current && startedAt !== null && sameGoalRun(current, goalId, startedAt, turnId)) {
    return state.goalRunClockByChatId;
  }
  if (goal.status !== "active" || startedAt === null) {
    return current
      ? { ...state.goalRunClockByChatId, [chatId]: null }
      : state.goalRunClockByChatId;
  }
  return {
    ...state.goalRunClockByChatId,
    [chatId]: {
      goalId,
      turnId,
      startedAt,
      baseSeconds: goal.time_used_seconds
    }
  };
}

function markChatRunning(
  state: AgentState,
  chatId: string,
  startedAt: number,
  turnId: string | null = null,
  source: AgentTurnSource | null = null
): AgentState {
  const optimisticSendingByChatId = { ...state.optimisticSendingByChatId };
  delete optimisticSendingByChatId[chatId];
  return {
    ...state,
    runStartedAtByChatId: { ...state.runStartedAtByChatId, [chatId]: startedAt },
    goalRunClockByChatId: updateGoalRunClockForRunning(state, chatId, startedAt, turnId),
    runStatusVersionByChatId: bumpRunStatusVersion(state, chatId),
    activeTurnIdByChatId: turnId ? { ...state.activeTurnIdByChatId, [chatId]: turnId } : state.activeTurnIdByChatId,
    activeTurnSourceByChatId: {
      ...state.activeTurnSourceByChatId,
      [chatId]: source
    },
    optimisticSendingByChatId,
    completedUnseenByChatId: clearChatMapValue(state.completedUnseenByChatId, chatId)
  };
}

type MarkChatIdleSource = "turn_end" | "run_status_idle" | "stop_result" | "session_hydrate" | "run_status_snapshot";

function shouldClearStreamingFlags(source: MarkChatIdleSource): boolean {
  return source === "turn_end" || source === "session_hydrate" || source === "run_status_snapshot";
}

function latencyForSource(source: MarkChatIdleSource, latencyMs: number | undefined): number | undefined {
  return source === "turn_end" ? latencyMs : undefined;
}

function shouldMarkCompletedUnseen(
  source: MarkChatIdleSource,
  wasBusy: boolean,
  countsAsCompletion: boolean,
): boolean {
  return wasBusy && countsAsCompletion && (source === "turn_end" || source === "session_hydrate");
}

function markChatIdle(state: AgentState, chatId: string, options: {
  source: MarkChatIdleSource;
  latencyMs?: number;
  turnId?: string | null;
  countsAsCompletion?: boolean;
}): AgentState {
  const activeTurnId = state.activeTurnIdByChatId[chatId] ?? null;
  if (
    activeTurnId
    && (!options.turnId || options.turnId !== activeTurnId)
  ) return state;
  const wasBusy = isChatBusy(state, chatId) || Boolean(state.stopInFlightByChatId[chatId]);
  const countsAsCompletion = options.countsAsCompletion ?? true;
  const finishedState = shouldClearStreamingFlags(options.source)
    ? finishChatStreaming(state, chatId, latencyForSource(options.source, options.latencyMs))
    : state;
  const retryFinishedState = finishRetryWaitStatusForTurn(finishedState, chatId, options.turnId ?? null);
  const optimisticSendingByChatId = { ...state.optimisticSendingByChatId };
  const stopInFlightByChatId = { ...state.stopInFlightByChatId };
  if (options.source !== "run_status_snapshot") {
    delete optimisticSendingByChatId[chatId];
  }
  delete stopInFlightByChatId[chatId];

  let completedUnseenByChatId = retryFinishedState.completedUnseenByChatId;
  if (isChatVisible(state, chatId)) {
    completedUnseenByChatId = clearChatMapValue(completedUnseenByChatId, chatId);
  } else if (shouldMarkCompletedUnseen(options.source, wasBusy, countsAsCompletion)) {
    completedUnseenByChatId = { ...completedUnseenByChatId, [chatId]: Date.now() };
  }

  // Only record a completion signal (consumed by the system-notification side effect) on a genuine task end (turn_end) that was preceded by a busy state;
  // session_hydrate / stop_result do not count as "task completed", to avoid firing a spurious notification on reconnect or manual stop.
  const lastTaskCompletion = options.source === "turn_end" && wasBusy && countsAsCompletion
    ? { chatId, at: Date.now() }
    : retryFinishedState.lastTaskCompletion;

  const closedReason = options.source === "stop_result"
    ? "stopped"
    : options.source === "turn_end" || options.source === "run_status_idle" || options.source === "run_status_snapshot"
      ? "ended"
      : null;
  const closedState = closedReason ? markClosedTurn(retryFinishedState, chatId, options.turnId ?? null, closedReason) : retryFinishedState;
  const suppressionClearedState = clearSuppressAssistantStreamUntilTurnEnd(closedState, chatId);
  const activeTurnIdByChatId = {
    ...suppressionClearedState.activeTurnIdByChatId,
    [chatId]: null,
  };
  const activeTurnSourceByChatId = {
    ...suppressionClearedState.activeTurnSourceByChatId,
    [chatId]: null,
  };
  const nextState = deriveTasks({
    ...suppressionClearedState,
    runStartedAtByChatId: { ...suppressionClearedState.runStartedAtByChatId, [chatId]: null },
    goalRunClockByChatId: { ...suppressionClearedState.goalRunClockByChatId, [chatId]: null },
    runStatusVersionByChatId: bumpRunStatusVersion(suppressionClearedState, chatId),
    activeTurnIdByChatId,
    activeTurnSourceByChatId,
    optimisticSendingByChatId,
    stopInFlightByChatId,
    completedUnseenByChatId,
    lastTaskCompletion,
    ...(chatId === state.currentChatId ? { isSending: false } : {})
  });
  return chatId === state.currentChatId ? syncCurrentMessages(nextState) : nextState;
}

function reconcileRunStatusSnapshot(state: AgentState, event: MemmyAgentWsEvent): AgentState {
  const chatId = event.chat_id;
  if (!chatId || (event.status !== "running" && event.status !== "idle")) {
    return state;
  }

  if (event.status === "running") {
    if (typeof event.started_at !== "number") {
      return state;
    }
    const turnId = eventTurnId(event);
    if (isClosedTurn(state, chatId, turnId)) {
      return state;
    }
    const nextState = markChatRunning(
      state,
      chatId,
      event.started_at,
      turnId,
      parseAgentTurnSource(event.source)
    );
    return deriveTasks({
      ...nextState,
      isSending: chatId === state.currentChatId ? isChatBusy(nextState, chatId) : state.isSending
    });
  }

  const turnId = eventTurnId(event) ?? state.activeTurnIdByChatId[chatId] ?? null;
  const nextState = markChatIdle(state, chatId, { source: "run_status_snapshot", turnId });
  return deriveTasks({
    ...nextState,
    isSending: chatId === state.currentChatId ? isChatBusy(nextState, chatId) : state.isSending
  });
}

function updateRunStatus(state: AgentState, event: MemmyAgentWsEvent): AgentState {
  const chatId = event.chat_id;
  if (!chatId) {
    return state;
  }

  if (event.status === "running" && typeof event.started_at === "number") {
    const nextState = markChatRunning(
      state,
      chatId,
      event.started_at,
      eventTurnId(event),
      parseAgentTurnSource(event.source)
    );
    return deriveTasks({
      ...nextState,
      isSending: chatId === state.currentChatId ? isChatBusy(nextState, chatId) : state.isSending
    });
  }

  if (chatHasLiveStream(state, chatId)) {
    // Idle status raced ahead of the still-open content stream (this happens
    // between loop rounds). Ignore it: the send/stop button must not flicker
    // mid-turn. The authoritative close arrives via turn_end / stop_result,
    // which clear the streaming flags before marking idle.
    return state;
  }

  const nextState = markChatIdle(state, chatId, { source: "run_status_idle", turnId: eventTurnId(event) });
  return deriveTasks({
    ...nextState,
    isSending: chatId === state.currentChatId ? isChatBusy(nextState, chatId) : state.isSending
  });
}

function stopCurrentTurn(state: AgentState, chatId: string): AgentState {
  if (chatId !== state.currentChatId) {
    return state;
  }

  const optimisticSendingByChatId = { ...state.optimisticSendingByChatId };
  const completedUnseenByChatId = clearChatMapValue(state.completedUnseenByChatId, chatId);
  const retryWaitStatusByChatId = clearChatMapValue(state.retryWaitStatusByChatId, chatId);
  delete optimisticSendingByChatId[chatId];
  return syncCurrentMessages(deriveTasks({
    ...state,
    optimisticSendingByChatId,
    stopInFlightByChatId: { ...state.stopInFlightByChatId, [chatId]: true },
    completedUnseenByChatId,
    retryWaitStatusByChatId,
    isSending: false,
    messages: state.messages.map((message) => {
      if (!message.isStreaming && !message.reasoningStreaming) {
        return message;
      }
      return {
        ...message,
        isStreaming: false,
        reasoningStreaming: false,
        ...(hasLoadedMessagePayload(message) ? { stoppedByUser: true } : {})
      };
    })
  }));
}

/**
 * Self-healing for a stop that never got confirmed: if the runtime's
 * stop_result / turn_end were lost (websocket died mid-interrupt, gateway
 * crashed, ...), `stopInFlightByChatId` would otherwise stay true forever and
 * permanently disable the composer's send path. A UI-side timeout dispatches
 * this action to release the lock and return the chat to an idle, sendable
 * state — the turn was already visually closed by stopRequested.
 */
function releaseUnconfirmedStop(state: AgentState, chatId: string): AgentState {
  if (!state.stopInFlightByChatId[chatId]) {
    return state;
  }
  const stopInFlightByChatId = { ...state.stopInFlightByChatId };
  delete stopInFlightByChatId[chatId];
  const suppressionClearedState = clearSuppressAssistantStreamUntilTurnEnd(state, chatId);
  return deriveTasks({
    ...suppressionClearedState,
    stopInFlightByChatId,
    runStartedAtByChatId: { ...suppressionClearedState.runStartedAtByChatId, [chatId]: null },
    goalRunClockByChatId: { ...suppressionClearedState.goalRunClockByChatId, [chatId]: null },
    runStatusVersionByChatId: bumpRunStatusVersion(suppressionClearedState, chatId),
    ...(chatId === state.currentChatId ? { isSending: false } : {})
  });
}

function hasLoadedMessagePayload(message: AgentChatMessage): boolean {
  return Boolean(
    message.content.trim()
    || message.reasoning?.trim()
    || message.media?.length
    || message.traces?.length
    || message.fileEdits?.length
  );
}

function updateGoalState(state: AgentState, chatId: string | null | undefined, rawGoalState: unknown): AgentState {
  if (!chatId || !isAgentGoalState(rawGoalState)) {
    return state;
  }

  const goalState: AgentGoalState = rawGoalState;
  const goalRunClockByChatId = updateGoalRunClockForGoalState(state, chatId, goalState);
  return {
    ...state,
    goalStatesByChatId: { ...state.goalStatesByChatId, [chatId]: goalState },
    goalState: chatId === state.currentChatId ? goalState : state.goalState,
    goalRunClockByChatId
  };
}

function endTurn(
  state: AgentState,
  chatId: string | null | undefined,
  latencyMs: number | undefined,
  turnId: string | null = null,
  event: MemmyAgentWsEvent | null = null,
): AgentState {
  const effectiveChatId = chatId ?? state.currentChatId;
  if (!effectiveChatId) {
    return state;
  }
  const hasGoalId = typeof event?.goal_id === "string";
  const hasGoalOutcome = isAgentGoalStatus(event?.goal_outcome);
  const validPair = hasGoalId && hasGoalOutcome;
  const malformedPair = hasGoalId !== hasGoalOutcome;
  const countsAsCompletion = malformedPair
    ? false
    : !validPair || event?.goal_outcome === "completed";
  return markChatIdle(state, effectiveChatId, {
    source: "turn_end",
    latencyMs,
    turnId,
    countsAsCompletion,
  });
}

function normalizeThreadMessages(messages: Array<Record<string, unknown>>): AgentChatMessage[] {
  return messages.flatMap((message, index) => normalizeThreadMessage(message, index));
}

function normalizeThreadMessage(message: Record<string, unknown>, index: number): AgentChatMessage[] {
    const role = message.role === "user" || message.role === "tool" ? message.role : "assistant";
    const kind = message.kind === "trace" || message.kind === "message" || message.kind === "narration" || message.kind === "context_compaction" ? message.kind : undefined;
    const compactionStatus = normalizeContextCompactionStatus(message.compactionStatus ?? message.compaction_status ?? message.status);
    const compactionId = typeof message.compactionId === "string" && message.compactionId.trim()
      ? message.compactionId.trim()
      : typeof message.compaction_id === "string" && message.compaction_id.trim()
        ? message.compaction_id.trim()
        : String(message.id ?? `context-compaction-${index}`);
    const createdAt = typeof message.createdAt === "number" ? message.createdAt : undefined;
    const latencyMs = typeof message.latencyMs === "number"
      ? message.latencyMs
      : typeof message.latency_ms === "number"
        ? message.latency_ms
        : undefined;
    const turnId = typeof message.turnId === "string" && message.turnId.trim()
      ? message.turnId.trim()
      : typeof message.turn_id === "string" && message.turn_id.trim()
        ? message.turn_id.trim()
        : undefined;
    const clientRequestId = typeof message.clientRequestId === "string" && message.clientRequestId.trim()
      ? message.clientRequestId.trim()
      : typeof message.client_request_id === "string" && message.client_request_id.trim()
        ? message.client_request_id.trim()
        : undefined;
    const rawToolEvents = Array.isArray(message.toolEvents)
      ? message.toolEvents
      : Array.isArray(message.tool_events)
        ? message.tool_events
        : undefined;
    const fileEdits = Array.isArray(message.fileEdits) ? normalizeFileEdits(message.fileEdits) : undefined;
    const modelError = normalizeModelError(message.modelError ?? message.model_error);
    const content = kind === "context_compaction"
      ? String(message.content ?? "") || contextCompactionFallbackText(compactionStatus)
      : String(message.content ?? "");
    const normalized = {
      id: String(message.id ?? `${role}-${index}`),
      role,
      content,
      ...(turnId ? { turnId } : {}),
      ...(clientRequestId ? { clientRequestId } : {}),
      ...(kind ? { kind } : {}),
      ...(typeof message.reasoning === "string" ? { reasoning: message.reasoning } : {}),
      ...(typeof message.reasoningStreaming === "boolean" ? { reasoningStreaming: message.reasoningStreaming } : {}),
      ...(typeof message.isStreaming === "boolean" ? { isStreaming: message.isStreaming } : {}),
      ...(Array.isArray(message.media) ? { media: normalizeMedia(message.media) } : {}),
      ...(kind !== "context_compaction" && Array.isArray(message.traces) ? { traces: message.traces.map(String) } : {}),
      ...(kind !== "context_compaction" && rawToolEvents ? { toolEvents: normalizeToolProgressEvents(rawToolEvents) } : {}),
      ...(kind !== "context_compaction" && fileEdits?.length ? { fileEdits } : {}),
      ...(kind !== "context_compaction" && typeof message.activitySegmentId === "string" ? { activitySegmentId: message.activitySegmentId } : {}),
      ...(kind === "context_compaction" ? { compactionId, compactionStatus } : {}),
      ...(createdAt == null ? {} : { createdAt }),
      ...(latencyMs == null ? {} : { latencyMs }),
      ...(role === "assistant" && modelError ? { modelError } : {})
    } satisfies AgentChatMessage;
    return splitNarrativeTraceMessage(normalized);
}

/**
 * Legacy-data guard: older gateways persisted mid-turn assistant drafts inside
 * tool trace `traces[]`. Split those narrative lines back out as `narration`
 * messages (activity prose) so they render in the activity timeline instead of
 * masquerading as tool calls. New gateways emit `kind: "narration"` directly
 * and never hit this path.
 */
function splitNarrativeTraceMessage(message: AgentChatMessage): AgentChatMessage[] {
  if (message.kind !== "trace" || !message.traces?.length) {
    return [message];
  }
  const narrativeTraces = message.traces.filter(isLikelyNarrativeTraceLine);
  if (!narrativeTraces.length) {
    return [message];
  }
  const toolTraces = message.traces.filter((line) => !isLikelyNarrativeTraceLine(line));
  const narrationMessages = narrativeTraces.map((trace, index): AgentChatMessage => ({
    id: `${message.id}::narrative:${index}`,
    role: "assistant",
    kind: "narration",
    content: trace,
    ...(message.turnId ? { turnId: message.turnId } : {}),
    ...(message.activitySegmentId ? { activitySegmentId: message.activitySegmentId } : {}),
    ...(message.createdAt == null ? {} : { createdAt: message.createdAt })
  }));
  const keepTrace = toolTraces.length > 0 || Boolean(message.toolEvents?.length) || Boolean(message.fileEdits?.length);
  if (!keepTrace) {
    return narrationMessages;
  }
  return [
    ...narrationMessages,
    {
      ...message,
      traces: toolTraces,
      content: toolTraces.at(-1) ?? ""
    }
  ];
}

function isLikelyNarrativeTraceLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  if (isLikelyToolTraceLine(trimmed)) {
    return false;
  }
  return trimmed.includes("\n")
    || /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|\|.+\|)/u.test(trimmed)
    || trimmed.length > 140;
}

function isLikelyToolTraceLine(line: string): boolean {
  return /^[A-Za-z_][\w.-]*\s*\(/u.test(line)
    || /^(Ran|Read|Listed|Grepped|Globbed|Generated image|Called|Fetched|Searched web for|Edited|Wrote|Deleted|Updated notebook)\b/u.test(line);
}

function normalizeMedia(raw: unknown[]): AgentChatMediaAttachment[] {
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const record = item as MemmyAgentMediaAttachment;
    const url = typeof record.url === "string" && record.url.trim() ? record.url.trim() : undefined;
    const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : undefined;
    const mediaPath = typeof record.path === "string" && record.path.trim() ? record.path.trim() : undefined;
    if (!url && !name && !mediaPath) {
      return [];
    }
    const normalized = {
      url,
      name,
      path: mediaPath,
      kind: isAgentChatMediaKind(record.kind) ? record.kind : undefined
    };
    return [{
      kind: inferMediaKind(normalized),
      ...(url ? { url } : {}),
      ...(name ? { name } : {}),
      ...(mediaPath ? { path: mediaPath } : {})
    }];
  });
}

function sessionKeyToChatId(sessionKey: string): string {
  return sessionKey.startsWith("websocket:") ? sessionKey.slice("websocket:".length) : sessionKey;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
