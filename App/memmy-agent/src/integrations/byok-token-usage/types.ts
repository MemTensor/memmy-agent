import type { AgentHook } from "../../core/agent-runtime/hook.js";

export type JsonRecord = Record<string, unknown>;

export type NormalizedByokTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  rawUsage: JsonRecord;
};

export type ByokTokenUsageEvent = NormalizedByokTokenUsage & {
  id: string;
  kind: "agent_chat";
  source: "agent";
  operationId: string;
  metadata: JsonRecord;
  createdAt: string;
};

export interface ByokTokenUsageClient {
  recordEvent(event: ByokTokenUsageEvent): Promise<void>;
}

export type ByokTokenUsageHookOptions = {
  client: ByokTokenUsageClient;
  resolveProviderName?: (modelId: string | null) => string | null;
};

export type FetchLike = typeof fetch;

export type ByokTokenUsageRuntimeConfig = {
  baseUrl: string;
  localToken: string;
};

export type ByokTokenUsageClientOptions = {
  baseUrl?: string;
  runtimeToken?: string;
  runtimeConfigProvider?: () => ByokTokenUsageRuntimeConfig | null;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
};

export type ByokTokenUsageInstallOptions = {
  hooks?: AgentHook[];
  runtimeConfigPath?: string;
  homeDir?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
};
