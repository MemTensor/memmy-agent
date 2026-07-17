/** App reducer module. */
import { ASR_DEFAULT_BASE_URL, QWEN_ASR_MODEL_ID, type AgentSourceView, type AppBootstrapResponse, type ScanPreferences } from "@memmy/local-api-contracts";
import type { AppRoutePath, PreferredMode } from "../app/routes.js";
import type { ModelProviderConfig } from "../api/config-client.js";
import type { AgentSourceScanProgress, AppAction, EventConnectionStatus } from "./app-actions.js";
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
}

/** Contract for agent sources state. */
export interface AgentSourcesState {
  items: AgentSourceView[];
  isLoading: boolean;
  isScanning: boolean;
  error: string | null;
  scanProgress: AgentSourceScanProgress | null;
  scanPreferences: ScanPreferences;
}

/** Contract for account state. */
export interface AccountState {
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
export function createInitialAppState(): AppState {
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
      preferredMode: null
    },
    agentSources: {
      items: [],
      isLoading: false,
      isScanning: false,
      error: null,
      scanProgress: null,
      scanPreferences: defaultScanPreferences
    },
    account: {
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
        agent: agentReducer(state.agent, { type: "agent/chatViewVisibilityChanged", visible: isAgentChatViewPath(action.initialPath) })
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
        agent: agentReducer(state.agent, { type: "agent/chatViewVisibilityChanged", visible: isAgentChatViewPath(action.path) })
      };
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
    case "agentSources/loading":
      return {
        ...state,
        agentSources: { ...state.agentSources, isLoading: true, error: null }
      };
    case "agentSources/loaded":
      return {
        ...state,
        agentSources: { ...state.agentSources, items: action.sources, isLoading: false, isScanning: false, error: null, scanProgress: null }
      };
    case "agentSources/refreshed":
      return {
        ...state,
        agentSources: { ...state.agentSources, items: action.sources, isLoading: false, error: null }
      };
    case "agentSources/error":
      return {
        ...state,
        agentSources: { ...state.agentSources, isLoading: false, isScanning: false, error: action.message, scanProgress: null }
      };
    case "agentSources/scanStarted":
      return {
        ...state,
        agentSources: { ...state.agentSources, isScanning: true, error: null, scanProgress: null }
      };
    case "agentSources/scanProgress":
      if (
        state.agentSources.scanProgress?.phase === "stopped" &&
        state.agentSources.scanProgress.jobId === action.progress.jobId &&
        action.progress.phase !== "stopped"
      ) {
        return state;
      }

      return {
        ...state,
        agentSources: { ...state.agentSources, isScanning: action.progress.phase !== "stopped", error: null, scanProgress: action.progress }
      };
    case "agentSources/scanCompleted":
      return {
        ...state,
        agentSources: { ...state.agentSources, isScanning: false, error: null, scanProgress: null }
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
