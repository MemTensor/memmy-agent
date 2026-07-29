export type JsonRecord = Record<string, any>;

export type MemmyMemoryRuntimeNamespace = {
  source: string;
  profileId: string;
  profileLabel?: string;
  projectId?: string;
  workspaceId?: string;
  workspacePath?: string;
  sessionKey?: string;
  userId?: string;
  tenantId?: string;
};

export type MemmyMemoryRequestEnvelope = {
  requestId?: string;
  adapterId?: string;
  source?: string;
  namespace?: MemmyMemoryRuntimeNamespace;
};

export type MemmyMemoryConnection = {
  baseUrl: string;
  token?: string | null;
  source?: string | null;
  timeoutMs?: number;
};

export type MemmyMemoryResolvedConfig = {
  enabled: boolean;
  userId?: string;
};

export type MemmyMemoryInstallOptions = {
  workspace?: string | null;
  hooks?: any[];
};

export type MemmyMemoryHookOptions = {
  workspace?: string | null;
  adapterId?: string;
  source?: string;
  profileId?: string;
  profileLabel?: string;
  userId?: string;
  /** Optional override for GA4 client_id; defaults to reading desktop-written ~/.memmy/analytics-client-id. */
  getAnalyticsClientId?: () => string | null | undefined;
  /** Optional logged-in account id for GA4 user_id; omitted when anonymous. */
  getAnalyticsUserId?: () => string | null | undefined;
  /** Optional account | byok for GA4 user_mode; omitted when unset. */
  getAnalyticsUserMode?: () => string | null | undefined;
};

export type MemmyMemoryTurnState = {
  sessionKey: string;
  sessionId: string;
  turnId: string;
  userText: string;
  messageStartIndex: number;
  episodeId?: string;
  sourceMemoryIds?: string[];
  rawTurnId?: string;
  l1MemoryId?: string;
  hasInjectedContext?: boolean;
  sourceMemoryCount?: number;
};

export type MemmyMemoryToolRuntime = {
  requestEnvelope(sessionKey?: string | null): MemmyMemoryRequestEnvelope;
  currentSessionId(sessionKey?: string | null): string | null;
  currentEpisodeId(sessionKey?: string | null): string | null;
  currentTurnId(sessionKey?: string | null): string | null;
  currentUserText(sessionKey?: string | null): string | null;
  /** Fire-and-forget GA4 memory-op event (search/get/add). */
  trackMemoryAnalytics?(eventName: string, params?: Record<string, string | number | boolean>): void;
  /** Session/turn correlation + adapter_id for tool-path memory-op events. */
  memoryAnalyticsContext?(sessionKey?: string | null): Record<string, string | number | boolean>;
};
