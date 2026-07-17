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
};

export type MemmyMemoryTurnState = {
  sessionKey: string;
  sessionId: string;
  turnId: string;
  userText: string;
  messageStartIndex: number;
  episodeId?: string;
  rawTurnId?: string;
  l1MemoryId?: string;
};

export type MemmyMemoryToolRuntime = {
  requestEnvelope(sessionKey?: string | null): MemmyMemoryRequestEnvelope;
  currentSessionId(sessionKey?: string | null): string | null;
  currentEpisodeId(sessionKey?: string | null): string | null;
  currentTurnId(sessionKey?: string | null): string | null;
  currentUserText(sessionKey?: string | null): string | null;
};
