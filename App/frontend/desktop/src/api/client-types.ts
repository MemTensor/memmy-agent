import type { RuntimeConfig } from "@memmy/local-api-contracts";
import { createHttpAccountClient, type AccountClient } from "./account-client.js";
import { createHttpAgentSourceClient, type AgentSourceClient } from "./agent-source-client.js";
import { createHttpAsrClient, type AsrClient } from "./asr-client.js";
import { createHttpBootstrapClient, type BootstrapClient } from "./bootstrap-client.js";
import {
  createHttpByokTokenUsageClient,
  type ByokTokenUsageClient
} from "./byok-token-usage-client.js";
import { createHttpChannelsClient, type ChannelsClient } from "./channels-client.js";
import { createHttpConfigClient, type ConfigClient } from "./config-client.js";
import {
  createHttpIntegrationsClient,
  type IntegrationsClient
} from "./integrations-client.js";
import { createHttpLocalDataClient, type LocalDataClient } from "./local-data-client.js";
import { createHttpMemoryRuntimeClient, type MemoryRuntimeClient } from "./memory-runtime-client.js";
import { createMemmyAgentClient, type MemmyAgentClient } from "./memmy-agent-client.js";
import { createHttpTokenQuotaClient, type TokenQuotaClient } from "./token-quota-client.js";

export interface AppClients {
  runtimeConfig: RuntimeConfig;
  bootstrap: BootstrapClient;
  account: AccountClient;
  config: ConfigClient;
  agentSources: AgentSourceClient;
  localData: LocalDataClient;
  memoryRuntime: MemoryRuntimeClient;
  integrations: IntegrationsClient;
  channels: ChannelsClient;
  byokTokenUsage: ByokTokenUsageClient;
  asr: AsrClient;
  memmyAgent: MemmyAgentClient;
  tokenQuota: TokenQuotaClient;
}

export interface CreateAppClientsInput {
  runtimeConfig: RuntimeConfig | null;
}

export function createAppClients(input: CreateAppClientsInput): AppClients {
  if (!input.runtimeConfig) {
    throw new Error("Runtime config is required.");
  }

  return {
    runtimeConfig: input.runtimeConfig,
    bootstrap: createHttpBootstrapClient(input.runtimeConfig),
    account: createHttpAccountClient(input.runtimeConfig),
    config: createHttpConfigClient(input.runtimeConfig),
    agentSources: createHttpAgentSourceClient(input.runtimeConfig),
    localData: createHttpLocalDataClient(input.runtimeConfig),
    memoryRuntime: createHttpMemoryRuntimeClient(input.runtimeConfig),
    integrations: createHttpIntegrationsClient(input.runtimeConfig),
    channels: createHttpChannelsClient(input.runtimeConfig),
    byokTokenUsage: createHttpByokTokenUsageClient(input.runtimeConfig),
    asr: createHttpAsrClient(input.runtimeConfig),
    memmyAgent: createMemmyAgentClient(input.runtimeConfig.agentGateway),
    tokenQuota: createHttpTokenQuotaClient(input.runtimeConfig)
  };
}
