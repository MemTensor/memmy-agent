import { acceptsScanUpdate, compareScanVersions, type ScanStamp, type ScanVersion, agentSourceScanExecutionKey } from "@memmy/local-api-contracts";
/** App reducer module. */
import { ASR_DEFAULT_BASE_URL, QWEN_ASR_MODEL_ID, type AgentSourceView, type AgentSourceScanUnavailable, type AppBootstrapResponse, type ScanPreferences } from "@memmy/local-api-contracts";
import type { AppRoutePath, PreferredMode } from "../app/routes.js";
import type { InvitationToastKind } from "../app/invitation-result.js";
import type { ModelProviderConfig } from "../api/config-client.js";
import type { AgentSourceScanCompletion, AgentSourceScanProgress, AppAction, EventConnectionStatus } from "./app-actions.js";
import { agentReducer, initialAgentState, type AgentAction, type AgentState } from "./agent-chat-slice.js";
import { initialToolsState, toolsReducer, type ToolsAction, type ToolsState } from "./tools-slice.js";

/** Contract for startup state. */
export interface StartupState {
  status: "idle" | "loading" | "ready" | "error";
  message: string | null;
  eventStatus: EventConnectionStatus;
}

/** Contract for navigation state. */
export interface NavigationState {
  currentPath: AppRoutePath;
  history: AppRoutePath[];
  preferredMode: PreferredMode | null;
  windowVisible: boolean;
}

/** Contract for agent sources state. */
export interface AgentSourcesState {
  scanStamp?: ScanStamp;
  scanRequestGeneration?: number;
  memoryServiceRestarting: boolean;
  memoryDataClearing: boolean;
  scanStateSyncRequired: boolean;
  scanStateSyncGeneration: number;
  scanStateSyncBaseGeneration: number | null;
  scanStateSyncBaseVersion: ScanVersion | null;
  scanStateSyncReason: "restart" | "clear" | null;
  scanStateSyncRequireVersionAdvance: boolean;
  scanControl?: { control: "start" | "pause" | "resume" | "cancel"; token: string } | null;
  scanUnavailable: AgentSourceScanUnavailable | null;
  items: AgentSourceView[];
  isLoading: boolean;
  isScanning: boolean;
  activeScanSourceId: string | null;
  error: string | null;
  scanProgress: AgentSourceScanProgress | null;
  cancellingScanJobId: string | null;
  latestScanAttemptStartedAt?: string;
  lastFinishedScanJobId: string | null;
  finishedScanJobIds: string[];
  recentScanCompletions: AgentSourceScanCompletion[];
  scanPreferences: ScanPreferences;
}

/** Contract for account state. */
export interface AccountState {
  /** Cloud account id; null in BYOK / signed-out mode. */
  userId: string | null;
  email: string;
  phoneNumber: string | null;
  nickname: string;
  registeredAt: string | null;
}

/** Contract for modal state. */
export interface ModalState {
  nickname: boolean;
  scanPermission: boolean;
  improvement: boolean;
  modelConfig: boolean;
  manualSource: boolean;
}

export interface InvitationToastState {
  id: number;
  kind: InvitationToastKind;
}

/** Contract for app state. */
export interface AppState {
  startup: StartupState;
  bootstrap: AppBootstrapResponse | null;
  navigation: NavigationState;
  agentSources: AgentSourcesState;
  account: AccountState;
  modelConfig: ModelProviderConfig;
  agent: AgentState;
  modals: ModalState;
  invitationToast: InvitationToastState | null;
  tools: ToolsState;
}

const defaultScanPreferences: ScanPreferences = {
  autoScanKnownAgents: true,
  watchFileChanges: true,
  autoInjectSkill: false
};

const defaultModelConfig: ModelProviderConfig = {
  provider: "openai",
  endpoint: "https://api.openai.com/v1",
  model: "",
  apiKey: "",
  apiKeyMasked: "",
  configured: false,
  asr: {
    // Provider.
    provider: "aliyun",
    // Endpoint.
    endpoint: ASR_DEFAULT_BASE_URL,
    // Model.
    model: QWEN_ASR_MODEL_ID,
    // Api key.
    apiKey: "",
    // Api key masked.
    apiKeyMasked: "",
    // Configured.
    configured: false
  },
  // Image gen.
  imageGen: null
};

/** Creates create initial app state. */
export function createInitialAppState(windowVisible = true): AppState {
  return {
    startup: {
      status: "idle",
      message: null,
      eventStatus: "pending"
    },
    bootstrap: null,
    navigation: {
      currentPath: "/welcome",
      history: ["/welcome"],
      preferredMode: null,
      windowVisible
    },
    agentSources: {
      memoryServiceRestarting: false,
      memoryDataClearing: false,
      scanStateSyncRequired: false,
      scanStateSyncGeneration: 0,
      scanStateSyncBaseGeneration: null,
      scanStateSyncBaseVersion: null,
      scanStateSyncReason: null,
      scanStateSyncRequireVersionAdvance: false,
      scanUnavailable: null,
      items: [],
      isLoading: false,
      isScanning: false,
      activeScanSourceId: null,
      error: null,
      scanProgress: null,
      cancellingScanJobId: null,
      lastFinishedScanJobId: null,
      finishedScanJobIds: [],
      recentScanCompletions: [],
      scanPreferences: defaultScanPreferences
    },
    account: {
      userId: null,
      email: "",
      phoneNumber: null,
      nickname: "",
      registeredAt: null
    },
    modelConfig: defaultModelConfig,
    agent: initialAgentState,
    modals: {
      nickname: false,
      scanPermission: false,
      improvement: false,
      modelConfig: false,
      manualSource: false
    },
    invitationToast: null,
    tools: initialToolsState
  };
}

/** Handles app reducer. */
export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "startup/loading":
      return {
        ...state,
        startup: { ...state.startup, status: "loading", message: null }
      };
    case "startup/error":
      return {
        ...state,
        startup: { ...state.startup, status: "error", message: action.message }
      };
    case "bootstrap/loaded":
      return {
        ...state,
        startup: { ...state.startup, status: "ready", message: null },
        bootstrap: action.bootstrap,
        navigation: {
          ...state.navigation,
          currentPath: action.initialPath,
          history: [action.initialPath]
        },
        agentSources: {
          ...state.agentSources,
          scanPreferences: action.bootstrap.scanPreferences
        },
        agent: agentReducer(state.agent, { type: "agent/chatViewVisibilityChanged", visible: state.navigation.windowVisible && isAgentChatViewPath(action.initialPath) })
      };
    case "events/statusChanged":
      return {
        ...state,
        startup: { ...state.startup, eventStatus: action.status }
      };
    case "navigation/changed":
      return {
        ...state,
        navigation: {
          ...state.navigation,
          currentPath: action.path,
          history: state.navigation.currentPath === action.path ? state.navigation.history : [...state.navigation.history, action.path]
        },
        agent: agentReducer(state.agent, { type: "agent/chatViewVisibilityChanged", visible: state.navigation.windowVisible && isAgentChatViewPath(action.path) })
      };
    case "window/visibilityChanged":
      if (state.navigation.windowVisible === action.visible) return state;
      return {
        ...state,
        navigation: { ...state.navigation, windowVisible: action.visible },
        agent: agentReducer(state.agent, {
          type: "agent/chatViewVisibilityChanged",
          visible: action.visible && isAgentChatViewPath(state.navigation.currentPath)
        })
      };
    case "invitationToast/shown":
      return {
        ...state,
        invitationToast: { id: action.id, kind: action.kind }
      };
    case "invitationToast/cleared":
      return state.invitationToast?.id === action.id
        ? { ...state, invitationToast: null }
        : state;
    case "settings/updated":
      return state.bootstrap
        ? {
            ...state,
            bootstrap: {
              ...state.bootstrap,
              app: { ...state.bootstrap.app, ...action.settings }
            }
          }
        : state;
    case "privacy/updated":
      return state.bootstrap
        ? {
            ...state,
            bootstrap: {
              ...state.bootstrap,
              privacy: { ...state.bootstrap.privacy, ...action.privacy }
            }
          }
        : state;
    case "tokenUsage/updated":
      return state.bootstrap
        ? {
            ...state,
            bootstrap: {
              ...state.bootstrap,
              tokenUsage: action.tokenUsage
            }
          }
        : state;
    case "onboarding/updated":
      return state.bootstrap
        ? {
            ...state,
            bootstrap: {
              ...state.bootstrap,
              onboarding: { ...state.bootstrap.onboarding, ...action.onboarding }
            }
          }
        : state;
    // List refreshes must not erase terminal scan failures; retry clears them.
    case "agentSources/loading":
      return {
        ...state,
        agentSources: { ...state.agentSources, isLoading: true, error: state.agentSources.scanStamp?.status === "failed" ? state.agentSources.error : null }
      };
    case "agentSources/loaded":
      return {
        ...state,
        agentSources: { ...state.agentSources, items: action.sources, isLoading: false, error: state.agentSources.scanStamp?.status === "failed" ? state.agentSources.error : null }
      };
    case "agentSources/refreshed":
      return {
        ...state,
        agentSources: { ...state.agentSources, items: action.sources, isLoading: false, error: state.agentSources.scanStamp?.status === "failed" ? state.agentSources.error : null }
      };
    case "agentSources/scanAvailability":
      return { ...state, agentSources: { ...state.agentSources, scanUnavailable: action.unavailable } };
    case "agentSources/restartStarted":
      return { ...state, agentSources: { ...state.agentSources, memoryServiceRestarting: true,
        scanStateSyncRequired: true, scanStateSyncGeneration: state.agentSources.scanStateSyncGeneration + 1,
        scanStateSyncBaseGeneration: action.baseGeneration, scanStateSyncBaseVersion: null, scanStateSyncReason: "restart",
        scanStateSyncRequireVersionAdvance: false } };
    case "agentSources/restartFinished":
      return { ...state, agentSources: { ...state.agentSources, memoryServiceRestarting: false } };
    case "agentSources/clearStarted":
      return { ...state, agentSources: { ...state.agentSources, memoryDataClearing: true,
        scanStateSyncRequired: true, scanStateSyncGeneration: state.agentSources.scanStateSyncGeneration + 1,
        scanStateSyncBaseGeneration: action.baseVersion?.generation ?? null,
        scanStateSyncBaseVersion: action.baseVersion, scanStateSyncReason: "clear", scanStateSyncRequireVersionAdvance: false } };
    case "agentSources/clearFinished":
      return { ...state, agentSources: { ...state.agentSources, memoryDataClearing: false,
        scanStateSyncRequireVersionAdvance: action.succeeded } };
    case "agentSources/scanStateSynchronized": {
      if (!state.agentSources.scanStateSyncRequired || !state.agentSources.scanStateSyncReason ||
        action.generation !== state.agentSources.scanStateSyncGeneration || state.agentSources.memoryServiceRestarting || action.status.unavailable) return state;
      const currentVersion = state.agentSources.scanStamp?.version;
      const incomingVersion = action.status.version;
      const baseGeneration = state.agentSources.scanStateSyncBaseGeneration;
      const baseVersion = state.agentSources.scanStateSyncBaseVersion;
      if (state.agentSources.scanStateSyncReason === "restart" && baseGeneration !== null && (!incomingVersion || incomingVersion.generation <= baseGeneration)) return state;
      const minimumVersionComparison = state.agentSources.scanStateSyncRequireVersionAdvance ? 1 : 0;
      if (state.agentSources.scanStateSyncReason === "clear" && baseVersion && (!incomingVersion || compareScanVersions(incomingVersion, baseVersion) < minimumVersionComparison)) return state;
      if (state.agentSources.scanStateSyncReason === "clear" && (!incomingVersion || !action.sources)) return state;
      const incomingIsStale = Boolean(currentVersion && (!incomingVersion || compareScanVersions(incomingVersion, currentVersion) < 0));
      if (state.agentSources.scanStateSyncReason === "restart" && currentVersion && incomingIsStale) return state;
      const reconciled = incomingIsStale ? state : appReducer(state, { type: "agentSources/scanStatus", status: action.status });
      return { ...reconciled, agentSources: { ...reconciled.agentSources,
        ...(action.sources ? { items: action.sources, isLoading: false } : {}),
        // A successful clear invalidates earlier completion feedback. Keep feedback
        // from scans completed at/after this snapshot (including newer SSE updates).
        ...(state.agentSources.scanStateSyncReason === "clear" && state.agentSources.scanStateSyncRequireVersionAdvance && incomingVersion
          ? { recentScanCompletions: reconciled.agentSources.recentScanCompletions.filter((completion) =>
              completion.version && compareScanVersions(completion.version, incomingVersion) >= 0) }
          : {}),
        scanStateSyncRequired: false, scanStateSyncBaseGeneration: null, scanStateSyncBaseVersion: null, scanStateSyncReason: null,
        scanStateSyncRequireVersionAdvance: false } };
    }
    case "agentSources/error":
      return {
        ...state,
        agentSources: { ...state.agentSources, isLoading: false, error: action.message }
      };
    case "agentSources/scanControl":
      if (!action.control && state.agentSources.scanControl?.token !== action.token) return state;
      return { ...state, agentSources: { ...state.agentSources,
        scanRequestGeneration: (state.agentSources.scanRequestGeneration ?? 0) + (action.control ? 1 : 0),
        scanControl: action.control ? { control: action.control, token: action.token } : null } };
    case "agentSources/scanStatus": {
      if (action.status.unavailable) return state;
      if ((!action.status.version || !state.agentSources.scanStamp?.version) && action.requestGeneration !== undefined && action.requestGeneration !== (state.agentSources.scanRequestGeneration ?? 0)) return state;
      if (action.status.progress) return appReducer(state, { type: "agentSources/scanProgress", progress: action.status.progress });
      if (action.status.completion) return appReducer(state, { type: "agentSources/scanCompleted", scan: action.status.completion });
      const confirmedCancellation = action.cancelledExecution &&
        state.agentSources.scanControl?.control === "cancel" &&
        state.agentSources.scanControl.token === action.cancelledExecution.token &&
        state.agentSources.scanProgress && agentSourceScanExecutionKey(state.agentSources.scanProgress) === agentSourceScanExecutionKey(action.cancelledExecution);
      const reconciledExecution = confirmedCancellation ? action.cancelledExecution
        : !action.status.version && action.requestGeneration !== undefined && !state.agentSources.scanControl
          ? state.agentSources.scanProgress : undefined;
      const stamp = { ...(reconciledExecution ? { jobId: reconciledExecution.jobId, attemptId: reconciledExecution.attemptId, status: "cancelled" as const } : {}),
        ...action.status.execution, version: action.status.version, status: action.status.status ?? (reconciledExecution ? "cancelled" as const : undefined) };
      if (!acceptsScanUpdate(state.agentSources.scanStamp, stamp)) return state;
      // An unversioned idle reply needs a current query generation to reconcile an
      // externally cancelled scan; it cannot acknowledge an in-flight control.
      if (!stamp.version && !confirmedCancellation && (state.agentSources.scanControl ||
        (state.agentSources.isScanning && action.requestGeneration === undefined))) return state;
      const cancelled = stamp.status === "cancelled" && stamp.jobId ? agentSourceScanExecutionKey({ ...stamp, jobId: stamp.jobId }) : null;
      return { ...state, agentSources: { ...state.agentSources, scanStamp: stamp,
        scanRequestGeneration: (state.agentSources.scanRequestGeneration ?? 0) + (reconciledExecution && !stamp.version ? 1 : 0),
        isScanning: false, activeScanSourceId: null, scanProgress: null, cancellingScanJobId: null, scanControl: null,
        finishedScanJobIds: cancelled ? [...state.agentSources.finishedScanJobIds.filter((id) => id !== cancelled), cancelled].slice(-20) : state.agentSources.finishedScanJobIds } };
    }
    case "agentSources/scanResumeAcknowledged": {
      const progress = state.agentSources.scanProgress;
      if (state.agentSources.scanControl?.control !== "resume" || state.agentSources.scanControl.token !== action.token ||
        !progress || progress.version || progress.attemptId || progress.phase !== "stopped" ||
        agentSourceScanExecutionKey(progress) !== agentSourceScanExecutionKey(action)) return state;
      // Only the matching successful resume can release a legacy paused-state guard.
      return { ...state, agentSources: { ...state.agentSources, isScanning: true,
        scanProgress: { ...progress, phase: "scan" } } };
    }
    case "agentSources/scanStarted":
      return {
        ...state,
        agentSources: { ...state.agentSources, error: null, scanRequestGeneration: (state.agentSources.scanRequestGeneration ?? 0) + 1 }
      };
    case "agentSources/scanProgress":
      if (!acceptsScanUpdate(state.agentSources.scanStamp, action.progress)) return state;
      if (!action.progress.version && action.progress.attemptStartedAt && state.agentSources.latestScanAttemptStartedAt &&
        action.progress.attemptStartedAt < state.agentSources.latestScanAttemptStartedAt) return state;
      if (state.agentSources.finishedScanJobIds.includes(agentSourceScanExecutionKey(action.progress)) ||
        state.agentSources.cancellingScanJobId === action.progress.jobId) {
        return state;
      }
      if (
        !action.progress.version && !action.progress.attemptId && state.agentSources.scanProgress?.phase === "stopped" &&
        agentSourceScanExecutionKey(state.agentSources.scanProgress) === agentSourceScanExecutionKey(action.progress) &&
        action.progress.phase !== "stopped"
      ) {
        return state;
      }

      return {
        ...state,
        agentSources: {
          ...state.agentSources,
          scanStamp: action.progress,
          scanRequestGeneration: (state.agentSources.scanRequestGeneration ?? 0) + (!action.progress.version &&
            (!state.agentSources.scanProgress || agentSourceScanExecutionKey(state.agentSources.scanProgress) !== agentSourceScanExecutionKey(action.progress)) ? 1 : 0),
          isScanning: action.progress.phase !== "stopped",
          activeScanSourceId: action.progress.sourceId,
          error: null,
          latestScanAttemptStartedAt: action.progress.attemptStartedAt ?? state.agentSources.latestScanAttemptStartedAt,
          scanProgress: action.progress
        }
      };
    case "agentSources/scanCancelRequested":
      return {
        ...state,
        agentSources: {
          ...state.agentSources,
          cancellingScanJobId: action.jobId,
          error: null
        }
      };
    case "agentSources/scanCancelFailed":
      return {
        ...state,
        agentSources: {
          ...state.agentSources,
          cancellingScanJobId: null,
          error: action.message
        }
      };
    case "agentSources/scanCompleted": {
      if (action.scan && !acceptsScanUpdate(state.agentSources.scanStamp, action.scan)) return state;
      if (!action.scan && state.agentSources.scanStamp?.version) return state;
      if (!action.scan?.version && action.scan?.attemptStartedAt && state.agentSources.latestScanAttemptStartedAt &&
        action.scan.attemptStartedAt < state.agentSources.latestScanAttemptStartedAt) return state;
      if (action.scan && !action.scan.version && state.agentSources.scanProgress &&
        agentSourceScanExecutionKey(action.scan) !== agentSourceScanExecutionKey(state.agentSources.scanProgress) &&
        (!action.scan.attemptStartedAt || !state.agentSources.scanProgress.attemptStartedAt ||
          action.scan.attemptStartedAt <= state.agentSources.scanProgress.attemptStartedAt)) return state;
      const alreadyFinished = action.scan && state.agentSources.finishedScanJobIds.includes(agentSourceScanExecutionKey(action.scan));
      if (alreadyFinished && !action.scan?.version) return state;
      const finishedJobId = action.scan?.jobId ?? state.agentSources.cancellingScanJobId;
      const finishedExecution = action.scan ?? (state.agentSources.scanProgress?.jobId === finishedJobId
        ? state.agentSources.scanProgress : finishedJobId ? { jobId: finishedJobId } : undefined);
      return {
        ...state,
        agentSources: {
          ...state.agentSources,
          isScanning: false,
          activeScanSourceId: null,
          error: alreadyFinished ? state.agentSources.error : null,
          scanProgress: null,
          cancellingScanJobId: null,
          scanStamp: action.scan ? { ...action.scan, status: action.scan.succeeded === false ? "failed" : "completed" } : state.agentSources.scanStamp,
          scanControl: null,
          latestScanAttemptStartedAt: action.scan?.attemptStartedAt ?? state.agentSources.latestScanAttemptStartedAt,
          lastFinishedScanJobId: finishedJobId ?? state.agentSources.lastFinishedScanJobId,
          finishedScanJobIds: finishedExecution
            ? [...state.agentSources.finishedScanJobIds.filter((jobId) => jobId !== agentSourceScanExecutionKey(finishedExecution)), agentSourceScanExecutionKey(finishedExecution)].slice(-20)
            : state.agentSources.finishedScanJobIds,
          recentScanCompletions: action.scan && !alreadyFinished
            ? [
                ...state.agentSources.recentScanCompletions.filter((item) => item.sourceId !== action.scan?.sourceId),
                { ...action.scan }
              ]
            : state.agentSources.recentScanCompletions
        }
      };
    }
    case "agentSources/scanCompletionExpired":
      return {
        ...state,
        agentSources: {
          ...state.agentSources,
          recentScanCompletions: state.agentSources.recentScanCompletions.filter((item) => agentSourceScanExecutionKey(item) !== agentSourceScanExecutionKey(action))
        }
      };
    case "scanPreferences/updated":
      return {
        ...state,
        agentSources: {
          ...state.agentSources,
          scanPreferences: { ...state.agentSources.scanPreferences, ...action.preferences }
        }
      };
    case "preferredMode/updated":
      return {
        ...state,
        navigation: { ...state.navigation, preferredMode: action.preferredMode }
      };
    case "account/updated":
      return {
        ...state,
        account: {
          userId: action.userId ?? state.account.userId,
          email: action.email ?? state.account.email,
          phoneNumber: Object.prototype.hasOwnProperty.call(action, "phoneNumber") ? (action.phoneNumber ?? null) : state.account.phoneNumber,
          nickname: action.nickname ?? state.account.nickname,
          registeredAt: Object.prototype.hasOwnProperty.call(action, "registeredAt") ? (action.registeredAt ?? null) : state.account.registeredAt
        }
      };
    case "account/cleared":
      return {
        ...state,
        account: {
          userId: null,
          email: "",
          phoneNumber: null,
          nickname: "",
          registeredAt: null
        }
      };
    case "modelConfig/updated":
      return {
        ...state,
        modelConfig: { ...state.modelConfig, ...action.config }
      };
    case "modal/changed":
      return {
        ...state,
        modals: { ...state.modals, [action.modal]: action.open }
      };
    default:
      if (typeof action.type === "string" && action.type.startsWith("agent/")) {
        return {
          ...state,
          agent: agentReducer(state.agent, action as AgentAction)
        };
      }
      return {
        ...state,
        tools: toolsReducer(state.tools, action as ToolsAction)
      };
  }
}

function isAgentChatViewPath(path: AppRoutePath): boolean {
  return path === "/main";
}
