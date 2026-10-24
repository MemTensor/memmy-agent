import type { AgentHook } from "../../core/agent-runtime/hook.js";
import type { ActualModelContext, MemoryTokenBudgetDto } from "@memmy/local-api-contracts";

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
  kind: "agent_chat" | "memory_summary";
  source: "agent" | "memory";
  operationId: string;
  presetId: string;
  provider: string;
  model: string;
  capability: "agent" | "memory_summary";
  metadata: JsonRecord;
  createdAt: string;
};

export interface ByokTokenUsageClient {
  recordEvent(event: ByokTokenUsageEvent, options?: { requireRuntime?: boolean }): Promise<void>;
}

export interface HistorySummaryUsageClient extends ByokTokenUsageClient {
  getMemoryBudget(): Promise<MemoryTokenBudgetDto>;
}

export type ByokTokenUsageHookOptions = {
  client: ByokTokenUsageClient;
};

export type ByokUsageActualModelContext = Pick<
  ActualModelContext,
  "presetId" | "source" | "provider" | "model" | "capability"
>;

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
