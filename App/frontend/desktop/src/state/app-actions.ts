/** App actions module. */
import type {
  AgentSourceView,
  AppBootstrapResponse,
  AppSettingsDto,
  OnboardingStateDto,
  PrivacySettingsDto,
  ScanPhase,
  ScanPreferences,
  TokenUsageDto
} from "@memmy/local-api-contracts";
import type { AppRoutePath, PreferredMode } from "../app/routes.js";
import type { ChannelsClient } from "../api/channels-client.js";
import type { ModelProviderConfig } from "../api/config-client.js";
import { isIntegrationSetupDiagnosticError, logHiddenIntegrationSetupDiagnosticError } from "../api/integration-errors.js";
import type { IntegrationsClient } from "../api/integrations-client.js";
import type { IntegrationConnection } from "../integrations/connection-state.js";
import type { IntegrationMeta } from "../integrations/integration-meta.js";
import type { MemmyAgentSessionSummary, MemmyAgentSidebarState, MemmyAgentWebuiThread, MemmyAgentWsEvent } from "../api/memmy-agent-client.js";
import type { PendingAttachment } from "./agent-composer-state.js";
import type { AgentAction, AgentChatMediaAttachment } from "./agent-chat-slice.js";
import type { ToolsAction } from "./tools-slice.js";

/** Type definition for event connection status. */
export type EventConnectionStatus = "pending" | "connecting" | "connected" | "heartbeat" | "reconnecting";

/** Contract for agent source scan progress. */
export interface AgentSourceScanProgress {
  jobId: string;
  sourceId: string;
  phase: ScanPhase;
  current: number;
  total: number;
  message?: string;
}

/** Type definition for app action. */
export type AppAction =
  | ToolsAction
  | AgentAction
  | { type: "startup/loading" }
  | { type: "startup/error"; message: string }
  | { type: "bootstrap/loaded"; bootstrap: AppBootstrapResponse; initialPath: AppRoutePath }
  | { type: "events/statusChanged"; status: EventConnectionStatus }
  | { type: "navigation/changed"; path: AppRoutePath }
  | { type: "settings/updated"; settings: Partial<AppSettingsDto> }
  | { type: "privacy/updated"; privacy: Partial<PrivacySettingsDto> }
  | { type: "tokenUsage/updated"; tokenUsage: TokenUsageDto }
  | { type: "onboarding/updated"; onboarding: Partial<OnboardingStateDto> }
  | { type: "agentSources/loading" }
  | { type: "agentSources/loaded"; sources: AgentSourceView[] }
  | { type: "agentSources/refreshed"; sources: AgentSourceView[] }
  | { type: "agentSources/error"; message: string }
  | { type: "agentSources/scanStarted" }
  | { type: "agentSources/scanProgress"; progress: AgentSourceScanProgress }
  | { type: "agentSources/scanCompleted" }
  | { type: "scanPreferences/updated"; preferences: Partial<ScanPreferences> }
  | { type: "preferredMode/updated"; preferredMode: PreferredMode }
  | { type: "account/updated"; email?: string; phoneNumber?: string | null; nickname?: string; registeredAt?: string | null }
  | { type: "account/cleared" }
  | { type: "modelConfig/updated"; config: Partial<ModelProviderConfig> }
  | { type: "modal/changed"; modal: "nickname" | "scanPermission" | "improvement" | "modelConfig" | "manualSource"; open: boolean };

/** Definition for app actions. */
export const appActions = {
  /** Starts startup loading. */
  startupLoading(): AppAction {
    return { type: "startup/loading" };
  },

  /** Starts startup failed. */
  startupFailed(message: string): AppAction {
    return { type: "startup/error", message };
  },

  /** Handles bootstrap loaded. */
  bootstrapLoaded(bootstrap: AppBootstrapResponse, initialPath: AppRoutePath): AppAction {
    return { type: "bootstrap/loaded", bootstrap, initialPath };
  },

  /** Handles event status changed. */
  eventStatusChanged(status: EventConnectionStatus): AppAction {
    return { type: "events/statusChanged", status };
  },

  /** Handles navigate. */
  navigate(path: AppRoutePath): AppAction {
    return { type: "navigation/changed", path };
  },

  /** Writes settings updated. */
  settingsUpdated(settings: Partial<AppSettingsDto>): AppAction {
    return { type: "settings/updated", settings };
  },

  /** Handles privacy updated. */
  privacyUpdated(privacy: Partial<PrivacySettingsDto>): AppAction {
    return { type: "privacy/updated", privacy };
  },

  /** Handles token usage updated. */
  tokenUsageUpdated(tokenUsage: TokenUsageDto): AppAction {
    return { type: "tokenUsage/updated", tokenUsage };
  },

  /** Handles onboarding updated. */
  onboardingUpdated(onboarding: Partial<OnboardingStateDto>): AppAction {
    return { type: "onboarding/updated", onboarding };
  },

  /** Handles agent sources loading. */
  agentSourcesLoading(): AppAction {
    return { type: "agentSources/loading" };
  },

  /** Handles agent sources loaded. */
  agentSourcesLoaded(sources: AgentSourceView[]): AppAction {
    return { type: "agentSources/loaded", sources };
  },

  agentSourcesRefreshed(sources: AgentSourceView[]): AppAction {
    return { type: "agentSources/refreshed", sources };
  },

  /** Handles agent sources failed. */
  agentSourcesFailed(message: string): AppAction {
    return { type: "agentSources/error", message };
  },

  /** Handles agent source scan started. */
  agentSourceScanStarted(): AppAction {
    return { type: "agentSources/scanStarted" };
  },

  /** Handles agent source scan progress received. */
  agentSourceScanProgressReceived(progress: AgentSourceScanProgress): AppAction {
    return { type: "agentSources/scanProgress", progress };
  },

  /** Handles agent source scan completed. */
  agentSourceScanCompleted(): AppAction {
    return { type: "agentSources/scanCompleted" };
  },

  /** Handles scan preferences updated. */
  scanPreferencesUpdated(preferences: Partial<ScanPreferences>): AppAction {
    return { type: "scanPreferences/updated", preferences };
  },

  /** Handles preferred mode updated. */
  preferredModeUpdated(preferredMode: PreferredMode): AppAction {
    return { type: "preferredMode/updated", preferredMode };
  },

  /** Handles account updated. */
  accountUpdated(input: { email?: string; phoneNumber?: string | null; nickname?: string; registeredAt?: string | null }): AppAction {
    return { type: "account/updated", ...input };
  },

  /** Handles account cleared. */
  accountCleared(): AppAction {
    return { type: "account/cleared" };
  },

  /** Handles model config updated. */
  modelConfigUpdated(config: Partial<ModelProviderConfig>): AppAction {
    return { type: "modelConfig/updated", config };
  },

  /** Handles modal changed. */
  modalChanged(modal: "nickname" | "scanPermission" | "improvement" | "modelConfig" | "manualSource", open: boolean): AppAction {
    return { type: "modal/changed", modal, open };
  },

  /** Handles open tool connect modal. */
  openToolConnectModal(integration: Pick<IntegrationMeta, "slug" | "surface">): AppAction {
    return { type: "tools/openToolModal", surface: integration.surface, slug: integration.slug };
  },

  /** Closes close tool modal. */
  closeToolModal(): AppAction {
    return { type: "tools/closeModal" };
  }
};

/** Definition for agent actions. */
export const agentActions = {
  bootstrapStarted(): AppAction {
    return { type: "agent/bootstrapStarted" };
  },

  bootstrapSucceeded(modelName: string | null): AppAction {
    return { type: "agent/bootstrapSucceeded", modelName };
  },

  connectionConnecting(): AppAction {
    return { type: "agent/connectionConnecting" };
  },

  connectionClosed(): AppAction {
    return { type: "agent/connectionClosed" };
  },

  failed(message: string): AppAction {
    return { type: "agent/error", message };
  },

  errorDismissed(message: string): AppAction {
    return { type: "agent/errorDismissed", message };
  },

  sessionsLoading(requestId?: string): AppAction {
    return { type: "agent/sessionsLoading", ...(requestId ? { requestId } : {}) };
  },

  sessionsLoaded(sessions: MemmyAgentSessionSummary[], requestId?: string): AppAction {
    return { type: "agent/sessionsLoaded", sessions, ...(requestId ? { requestId } : {}) };
  },

  sessionsLoadFailed(requestId?: string): AppAction {
    return { type: "agent/sessionsLoadFailed", ...(requestId ? { requestId } : {}) };
  },

  sidebarStateLoaded(sidebarState: MemmyAgentSidebarState): AppAction {
    return { type: "agent/sidebarStateLoaded", sidebarState };
  },

  sidebarStateSaved(sidebarState: MemmyAgentSidebarState): AppAction {
    return { type: "agent/sidebarStateSaved", sidebarState };
  },

  historyLoading(sessionKey: string, chatId: string, requestId: string): AppAction {
    return { type: "agent/historyLoading", sessionKey, chatId, requestId };
  },

  historyLoaded(thread: MemmyAgentWebuiThread, requestId: string): AppAction {
    return { type: "agent/historyLoaded", thread, requestId };
  },

  historyOpenMissing(sessionKey: string, chatId: string, requestId: string): AppAction {
    return { type: "agent/historyOpenMissing", sessionKey, chatId, requestId };
  },

  historyHydrateLoading(sessionKey: string, chatId: string, requestId: string): AppAction {
    return { type: "agent/historyHydrateLoading", sessionKey, chatId, requestId };
  },

  historyHydrateLoaded(thread: MemmyAgentWebuiThread, requestId: string): AppAction {
    return { type: "agent/historyHydrateLoaded", thread, requestId };
  },

  historyHydrateFailed(chatId: string, requestId: string): AppAction {
    return { type: "agent/historyHydrateFailed", chatId, requestId };
  },

  newChatRequested(): AppAction {
    return { type: "agent/newChatRequested" };
  },

  blankDraftReopened(): AppAction {
    return { type: "agent/blankDraftReopened" };
  },

  newChatCreated(chatId: string): AppAction {
    return { type: "agent/newChatCreated", chatId };
  },

  transientSendFailed(chatId: string): AppAction {
    return { type: "agent/transientSendFailed", chatId };
  },

  userMessageQueued(input: { chatId: string; content: string; media?: AgentChatMediaAttachment[] }): AppAction {
    return { type: "agent/userMessageQueued", ...input };
  },

  composerDraftUpdated(scopeKey: string, value: string): AppAction {
    return { type: "agent/composerDraftUpdated", scopeKey, value };
  },

  composerPendingAttachmentsUpdated(scopeKey: string, attachments: PendingAttachment[]): AppAction {
    return { type: "agent/composerPendingAttachmentsUpdated", scopeKey, attachments };
  },

  composerMediaErrorUpdated(scopeKey: string, message: string | null): AppAction {
    return { type: "agent/composerMediaErrorUpdated", scopeKey, message };
  },

  composerScopeCleared(scopeKey: string): AppAction {
    return { type: "agent/composerScopeCleared", scopeKey };
  },

  stopRequested(chatId: string): AppAction {
    return { type: "agent/stopRequested", chatId };
  },

  stopUnconfirmed(chatId: string): AppAction {
    return { type: "agent/stopUnconfirmed", chatId };
  },

  restartRequested(startedAt: number): AppAction {
    return { type: "agent/restartRequested", startedAt };
  },

  restartRestored(input: { chatId: string; startedAt: number; sawDisconnect: boolean }): AppAction {
    return { type: "agent/restartRestored", ...input };
  },

  restartFailed(message: string): AppAction {
    return { type: "agent/restartFailed", message };
  },

  chatViewVisibilityChanged(visible: boolean): AppAction {
    return { type: "agent/chatViewVisibilityChanged", visible };
  },

  wsEventReceived(event: MemmyAgentWsEvent): AppAction {
    return { type: "agent/wsEvent", event };
  }
};

/** Definition for tools actions. */
export const toolsActions = {
  /** App actions module. */
  async loadConnections(client: IntegrationsClient, channelsClient: ChannelsClient, dispatch: (action: ToolsAction) => void): Promise<void> {
    dispatch({ type: "tools/loadStart" });

    try {
      const connections = await loadToolConnectionRecords(client, channelsClient);
      dispatch({
        type: "tools/loadSuccess",
        connections
      });
    } catch (error) {
      if (isIntegrationSetupDiagnosticError(error)) {
        logHiddenIntegrationSetupDiagnosticError(error);
        dispatch({ type: "tools/loadSuccess", connections: [] });
        return;
      }

      dispatch({ type: "tools/loadFailure", message: toErrorMessage(error) });
    }
  },

  /** App actions module. */
  async refreshConnections(client: IntegrationsClient, channelsClient: ChannelsClient, dispatch: (action: ToolsAction) => void): Promise<void> {
    try {
      const connections = await loadToolConnectionRecords(client, channelsClient);
      dispatch({ type: "tools/connectionsUpdated", connections });
    } catch (error) {
      if (isIntegrationSetupDiagnosticError(error)) {
        logHiddenIntegrationSetupDiagnosticError(error);
        return;
      }

      dispatch({ type: "tools/connectionFailure", message: toErrorMessage(error) });
    }
  }
};

/** Reads load tool connection records. */
export async function loadToolConnectionRecords(client: IntegrationsClient, channelsClient: ChannelsClient): Promise<IntegrationConnection[]> {
  const [integrationConnections, channelConnections] = await Promise.all([
    listIntegrationConnections(client),
    listChannelConnections(channelsClient)
  ]);

  return [...integrationConnections, ...channelConnections];
}

/** Handles list integration connections. */
async function listIntegrationConnections(client: IntegrationsClient): Promise<IntegrationConnection[]> {
  try {
    const connectionsResponse = await client.listConnections();
    return connectionsResponse.connections.map((connection) => ({ ...connection, surface: "integration" }));
  } catch (error) {
    if (isIntegrationSetupDiagnosticError(error)) {
      logHiddenIntegrationSetupDiagnosticError(error);
      return [];
    }

    throw error;
  }
}

/** Handles list channel connections. */
async function listChannelConnections(client: ChannelsClient): Promise<IntegrationConnection[]> {
  try {
    const response = await client.listConnections();
    return response.connections.flatMap((connection) => {
      const status = mapChannelStatus(connection.status);

      return status
        ? [
            {
              id: connection.id,
              toolkit: connection.provider,
              status,
              surface: "channel",
              lastError: connection.lastError ?? null
            }
          ]
        : [];
    });
  } catch (error) {
    console.warn("[tools] channel connection state unavailable:", error);
    return [];
  }
}

/** Maps map channel status. */
function mapChannelStatus(status: string): string | null {
  switch (status) {
    case "connected":
      return "connected";
    case "pendingQr":
    case "starting":
    case "restarting":
      return "pending";
    case "expired":
      return "expired";
    case "error":
      return "error";
    default:
      return null;
  }
}

/** Handles to error message. */
function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
