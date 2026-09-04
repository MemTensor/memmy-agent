/** Memmy config module. */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_LOCAL_EMBEDDING_ASSIGNMENT_ID,
  resolveAssignedModel as resolveCatalogAssignment,
  resolveCloudServiceBaseUrl,
  type ActualModelContext,
  type ModelConfigInput,
  type ModelConfigView,
  type ModelProvider,
  type ModelSelectionResolution,
  type ResolvedProviderSnapshot,
  type ResolveAssignedModelInput,
  type RuntimeModelCatalog,
  type UserMode
} from "@memmy/local-api-contracts";
import YAML from "yaml";
import {
  generateDesktopPresetName,
  readModelConfigCatalog,
  writeModelConfigCatalog
} from "./model-config-catalog.js";
import { mutateRuntimeConfig } from "@memmy/migrations";

export {
  InvalidModelConfigError,
  ModelConfigChangedError,
  generateDesktopPresetName,
  readModelConfigCatalog,
  writeModelConfigCatalog
} from "./model-config-catalog.js";
import { normalizeTimeZoneOffset } from "../../utils/time-zone.js";

const MEMMY_ACCOUNT_PROVIDER = "memmy_account";
const MEMMY_ACCOUNT_MODEL = "agent_chat";
const MEMMY_ACCOUNT_IMAGE_MODEL = "image_gen";
const LEGACY_ACCOUNT_BYOK_LOCAL_SELECTION_BASELINE = "accountByokLocalSelectionBaseline";
const ACCOUNT_MODELS = {
  agent: MEMMY_ACCOUNT_MODEL,
  memory_summary: "memory_summary",
  memory_evolution: "memory_evolution",
  embedding: "embedding",
  asr: "asr",
  image_generation: MEMMY_ACCOUNT_IMAGE_MODEL
} as const;
type AccountCapability = keyof typeof ACCOUNT_MODELS;
type AccountPresetIds = Record<AccountCapability, string>;

/** Handles resolve memmy account api base. */
export function resolveMemmyAccountApiBase(): string {
  return `${resolveCloudServiceBaseUrl(process.env.MEMMY_CLOUD_SERVICE)}/api/agentExternal/v1`;
}
type AgentApiType = "auto" | "chatCompletions" | "responses";

type RuntimeConfigStateStatus =
  | "missing"
  | "empty"
  | "invalid_yaml"
  | "no_model_config"
  | "conflict"
  | "valid_account"
  | "valid_byok";

export interface ModelProtocolProjection {
  agentProvider: string;
  agentApiType: AgentApiType;
  memoryProvider: string;
}

export type RuntimeMemmyConfigState =
  | {
      status: "missing" | "empty";
      configPath: string;
    }
  | {
      status: "invalid_yaml" | "no_model_config" | "conflict";
      configPath: string;
      reason: string;
      accountProjection?: {
        cloudUuid: string;
        userId?: string;
      };
    }
  | {
      status: "valid_account";
      configPath: string;
      cloudUuid: string;
      userId?: string;
    }
  | {
      status: "valid_byok";
      configPath: string;
      context: Readonly<ActualModelContext>;
      provider: Readonly<ResolvedProviderSnapshot>;
      accountProjection?: {
        cloudUuid: string;
        userId?: string;
      };
    };

export interface RuntimeProjectionResult {
  changed: boolean;
  memoryConfigAffected: boolean;
}

export interface MemmyConfigWriter {
  readModelConfig?(): Promise<ModelConfigView>;

  readRuntimeState?(mode?: UserMode): Promise<RuntimeMemmyConfigState>;

  resolveAssignedModel?(
    input: Omit<ResolveAssignedModelInput, "catalog">
  ): Promise<ModelSelectionResolution>;

  readEndpointApiKey?(provider: string, endpointId: string): Promise<string | null>;

  /** Atomically persist the active account/BYOK namespace without rewriting the model catalog. */
  writeUserMode?(mode: UserMode): Promise<void>;

  writeModelConfig?(input: ModelConfigInput): Promise<ModelConfigView>;

  /**
   * Write the account-mode Agent standard model config projection.
   *
   * @param input the login credentials and user id returned by cloud agentUser/login.
   */
  writeAccountModelProjection(input: { cloudUuid?: string; userId?: string }): Promise<RuntimeProjectionResult>;

  /**
   * Clear the account-mode runtime login projection.
   */
  clearAccountModelProjection?(input?: {
    ownerAccountId?: string;
    force?: boolean;
    syncSelectedByokToLocal?: boolean;
    expectedCloudUuid?: string;
  }): Promise<RuntimeProjectionResult>;

  /**
   * Patch a single memmy-agent channel config.
   *
   * @param channelName the memmy-agent runtime channel name, e.g. feishu or weixin.
   * @param patch the fields to merge into channels[channelName].
   */
  patchChannelConfig(channelName: string, patch: Record<string, unknown>): Promise<void>;

  /**
   * Write a single memmy-agent MCP server config (tools.mcpServers[serverName]).
   *
   * @param serverName the MCP server name, e.g. composio.
   * @param serverConfig the full config for this MCP server (fully replaced), e.g. { type, url, headers }.
   */
  patchMcpServerConfig(serverName: string, serverConfig: Record<string, unknown>): Promise<void>;
}

export interface CreateMemmyConfigWriterOptions {
  /**
   * Path to the Memmy main config file.
   *
   * Field semantics:
   * - configPath: defaults to ~/.memmy/config.yaml; tests can inject a temporary path.
   */
  configPath?: string;
}

/**
 * Create the Memmy main config writer.
 *
 * @param options config file path options.
 * @returns a MemmyConfigWriter instance.
 */
export function createMemmyConfigWriter(options: CreateMemmyConfigWriterOptions = {}): MemmyConfigWriter {
  const configPath = options.configPath ?? resolveDefaultMemmyConfigPath();

  return {
    async readModelConfig() {
      return readModelConfigCatalog(configPath);
    },

    async readRuntimeState(mode) {
      return readRuntimeMemmyConfigState(configPath, mode);
    },

    async resolveAssignedModel(input) {
      return resolveAssignedModelFromMemmyConfig(configPath, input);
    },

    async readEndpointApiKey(provider, endpointId) {
      return readCatalogEndpointApiKey(configPath, provider, endpointId);
    },

    async writeUserMode(mode) {
      await mutateRuntimeConfig(configPath, (config) => {
        const app = asRecord(config.app);
        if (app) app.userMode = mode;
        else config.app = { userMode: mode };
      });
    },

    async writeModelConfig(input) {
      return writeModelConfigCatalog(configPath, input);
    },

    async writeAccountModelProjection(input) {
      return writeAccountModelProjectionToMemmyConfig(input, configPath);
    },

    async clearAccountModelProjection(input) {
      return clearAccountModelProjectionFromMemmyConfig(configPath, input);
    },

    async patchChannelConfig(channelName, patch) {
      await patchChannelConfigInMemmyConfig(channelName, patch, configPath);
    },

    async patchMcpServerConfig(serverName, serverConfig) {
      await patchMcpServerConfigInMemmyConfig(serverName, serverConfig, configPath);
    }
  };
}

export async function resolveAssignedModelFromMemmyConfig(
  configPath: string,
  input: Omit<ResolveAssignedModelInput, "catalog">
): Promise<ModelSelectionResolution> {
  const config = await readCurrentRuntimeConfig(configPath);
  return resolveCatalogAssignment({
    ...input,
    catalog: config as RuntimeModelCatalog
  });
}

export async function readCatalogEndpointApiKey(
  configPath: string,
  providerId: string,
  endpointId: string
): Promise<string | null> {
  const config = await readCurrentRuntimeConfig(configPath);
  const provider = asRecord(asRecord(config.providers)?.[providerId]);
  const endpoint = asRecord(asRecord(provider?.endpoints)?.[endpointId]);
  if (!provider || !endpoint) return null;
  return existingString(endpoint.apiKey) ?? existingString(provider.apiKey) ?? null;
}

async function readCurrentRuntimeConfig(configPath: string): Promise<Record<string, unknown>> {
  const content = await readMemmyConfigContent(configPath);
  if (!content?.trim()) return {};
  const parsed = YAML.parse(content) as unknown;
  if (!isRecord(parsed)) throw new Error("Memmy config must be a YAML object");
  return parsed;
}

/**
 * Resolve the default Memmy main config path.
 *
 * @param homeDirectory the user's home directory; tests can pass a temporary directory.
 * @returns the absolute path to ~/.memmy/config.yaml.
 */
export function resolveDefaultMemmyConfigPath(homeDirectory = homedir()): string {
  return join(homeDirectory, ".memmy", "config.yaml");
}

/**
 * Strictly read the Memmy runtime config and derive the startup state.
 *
 * Field semantics:
 * - missing/empty: startup sync may fall back to app-state handling.
 * - invalid_yaml/conflict/no_model_config: the user's existing config has a problem and must not be silently overwritten by app-state.
 * - valid_account/valid_byok: the YAML is the source of truth and should hydrate app-state.
 *
 * @param configPath the Memmy main config file path.
 * @returns the runtime config state usable for startup sync.
 */
export async function readRuntimeMemmyConfigState(
  configPath = resolveDefaultMemmyConfigPath(),
  mode?: UserMode
): Promise<RuntimeMemmyConfigState> {
  const content = await readMemmyConfigContent(configPath);
  if (content === null) {
    return { status: "missing", configPath };
  }
  if (!content.trim()) {
    return { status: "empty", configPath };
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch (error) {
    return runtimeConfigProblem("invalid_yaml", configPath, error instanceof Error ? error.message : "Invalid YAML");
  }
  if (!isRecord(parsed)) {
    return runtimeConfigProblem("invalid_yaml", configPath, "Memmy config must be a YAML object");
  }

  return deriveRuntimeMemmyConfigState(parsed, configPath, mode);
}

/** Reads agents.defaults.timezone without inventing a configured value. */
export async function readConfiguredAgentTimeZone(
  configPath = resolveDefaultMemmyConfigPath()
): Promise<string | undefined> {
  const content = await readMemmyConfigContent(configPath);
  if (!content?.trim()) return undefined;
  const parsed = YAML.parse(content) as unknown;
  const agents = asRecord(asRecord(parsed)?.agents);
  const defaults = asRecord(agents?.defaults);
  const timeZone = existingString(defaults?.timezone);
  if (!timeZone) return undefined;
  try {
    return normalizeTimeZoneOffset(timeZone);
  } catch {
    throw new Error(`invalid agents.defaults.timezone: ${timeZone}`);
  }
}

/**
 * Read the memmy-agent gateway's bootstrap secret.
 *
 * Once the memmy-agent gateway has a secret configured at channels.websocket.tokenIssueSecret/token,
 * `/webui/bootstrap` enforces the `x-memmy-agent-auth` header, returning 401 otherwise. The backend channel
 * admin client must send this secret to exchange for a token, so it is read from the same config.yaml.
 *
 * @param configPath the Memmy main config file path.
 * @returns the configured secret; null when unset or the file is missing.
 */
export async function readAgentGatewayBootstrapSecret(
  configPath = resolveDefaultMemmyConfigPath()
): Promise<string | null> {
  const content = await readMemmyConfigContent(configPath);
  if (!content || !content.trim()) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch {
    return null;
  }

  const websocket = asRecord(asRecord(asRecord(parsed)?.channels)?.websocket);
  return existingString(websocket?.tokenIssueSecret) ?? existingString(websocket?.token) ?? null;
}

/**
 * Write the cloud login credential into the account standard model config projection.
 *
 * @param cloudUuid the uuid returned by cloud agentUser/login.
 * @param configPath the Memmy main config file path.
 */
export async function writeAppCloudUuidToMemmyConfig(cloudUuid: string, configPath = resolveDefaultMemmyConfigPath()): Promise<void> {
  await writeAccountModelProjectionToMemmyConfig({ cloudUuid }, configPath);
}

/**
 * Map a local API provider to its memmy-agent provider and Memory provider.
 *
 * @param provider the local API provider.
 * @returns the agent provider/apiType and Memory provider projection.
 */
export function mapModelProtocol(provider: ModelProvider): ModelProtocolProjection {
  switch (provider) {
    case "openai_compatible":
      return { agentProvider: "openai", agentApiType: "chatCompletions", memoryProvider: "openai_compatible" };
    case "anthropic":
      return { agentProvider: "anthropic", agentApiType: "auto", memoryProvider: "anthropic" };
    case "google":
      return { agentProvider: "gemini", agentApiType: "auto", memoryProvider: "gemini" };
    case "deepseek":
      return { agentProvider: "deepseek", agentApiType: "auto", memoryProvider: "openai_compatible" };
    case "zhipu":
      return { agentProvider: "zhipu", agentApiType: "auto", memoryProvider: "openai_compatible" };
    case "qwen":
      return { agentProvider: "dashscope", agentApiType: "auto", memoryProvider: "openai_compatible" };
    case "kimi":
      return { agentProvider: "moonshot", agentApiType: "auto", memoryProvider: "openai_compatible" };
    case "minimax":
      return { agentProvider: "minimax", agentApiType: "auto", memoryProvider: "openai_compatible" };
    case "baidu":
      return { agentProvider: "qianfan", agentApiType: "auto", memoryProvider: "openai_compatible" };
    case "doubao":
      return { agentProvider: "volcengine", agentApiType: "auto", memoryProvider: "openai_compatible" };
  }
}

function deriveRuntimeMemmyConfigState(
  config: Record<string, unknown>,
  configPath: string,
  mode?: UserMode
): RuntimeMemmyConfigState {
  const appCloudUuid = existingString(asRecord(config.app)?.cloudUuid);
  const providerCloudUuid = existingString(
    asRecord(asRecord(config.providers)?.[MEMMY_ACCOUNT_PROVIDER])?.apiKey
  );
  if (appCloudUuid && providerCloudUuid && appCloudUuid !== providerCloudUuid) {
    return runtimeConfigProblem(
      "conflict",
      configPath,
      "account_runtime_credentials_conflict",
      { cloudUuid: appCloudUuid }
    );
  }
  const userMode = mode ?? existingString(asRecord(config.app)?.userMode);
  const byok = resolveRuntimeAgentSelection(config, "byok");
  if (userMode === "byok") {
    return byok.ok
      ? deriveByokRuntimeConfigState(config, configPath, byok)
      : runtimeConfigProblem(
          "no_model_config",
          configPath,
          "Active BYOK assignment is not locally usable",
          readAccountProjection(config)
        );
  }
  if (userMode === "account") {
    return hasAccountProjection(config)
      ? deriveAccountRuntimeConfigState(config, configPath)
      : runtimeConfigProblem(
          "no_model_config",
          configPath,
          "Active account assignment is not locally usable",
          readAccountProjection(config)
        );
  }
  if (hasAccountProjection(config)) return deriveAccountRuntimeConfigState(config, configPath);
  if (byok.ok) {
    return deriveByokRuntimeConfigState(config, configPath, byok);
  }

  return runtimeConfigProblem(
    "no_model_config",
    configPath,
    "Missing a locally usable default text model",
    readAccountProjection(config)
  );
}

function hasAccountProjection(config: Record<string, unknown>): boolean {
  const app = asRecord(config.app);
  const credential = existingString(app?.cloudUuid)
    ?? existingString(asRecord(asRecord(config.providers)?.[MEMMY_ACCOUNT_PROVIDER])?.apiKey);
  return Boolean(credential && resolveRuntimeAgentSelection(config, "account").ok);
}

function resolveRuntimeAgentSelection(
  config: Record<string, unknown>,
  mode: "account" | "byok"
): ModelSelectionResolution {
  const app = asRecord(config.app);
  const accountAssignment = asRecord(asRecord(config.modelAssignments)?.account);
  return resolveCatalogAssignment({
    catalog: config as RuntimeModelCatalog,
    mode,
    activeAccountId: existingString(app?.userId)
      ?? (mode === "account" ? existingString(accountAssignment?.ownerAccountId) : undefined),
    capability: "agent"
  });
}

function deriveAccountRuntimeConfigState(
  config: Record<string, unknown>,
  configPath: string
): RuntimeMemmyConfigState {
  const cloudUuid =
    existingString(asRecord(config.app)?.cloudUuid) ??
    existingString(asRecord(asRecord(config.providers)?.[MEMMY_ACCOUNT_PROVIDER])?.apiKey);
  if (!cloudUuid) {
    return runtimeConfigProblem("no_model_config", configPath, "Account runtime config is missing cloud uuid");
  }

  const userId =
    existingString(asRecord(config.app)?.userId);
  return omitUndefined({
    status: "valid_account",
    configPath,
    cloudUuid,
    userId
  }) as RuntimeMemmyConfigState;
}

function deriveByokRuntimeConfigState(
  config: Record<string, unknown>,
  configPath: string,
  resolved: Extract<ModelSelectionResolution, { ok: true }>
): RuntimeMemmyConfigState {
  return omitUndefined({
    status: "valid_byok",
    configPath,
    context: resolved.context,
    provider: resolved.provider,
    accountProjection: readAccountProjection(config)
  }) as RuntimeMemmyConfigState;
}

function readAccountProjection(
  config: Record<string, unknown>
): { cloudUuid: string; userId?: string } | undefined {
  const cloudUuid = existingString(asRecord(config.app)?.cloudUuid)
    ?? existingString(asRecord(asRecord(config.providers)?.[MEMMY_ACCOUNT_PROVIDER])?.apiKey);
  if (!cloudUuid) return undefined;
  const userId = existingString(asRecord(config.app)?.userId)
    ?? existingString(asRecord(asRecord(config.providers)?.[MEMMY_ACCOUNT_PROVIDER])?.ownerAccountId);
  return userId ? { cloudUuid, userId } : { cloudUuid };
}

/**
 * Write the account-mode Agent standard model config projection.
 *
 * @param input the account credentials to persist after login.
 * @param configPath the Memmy main config file path.
 */
export async function writeAccountModelProjectionToMemmyConfig(
  input: { cloudUuid?: string; userId?: string },
  configPath = resolveDefaultMemmyConfigPath()
): Promise<RuntimeProjectionResult> {
  const normalizedCloudUuid = input.cloudUuid?.trim();
  const normalizedUserId = input.userId?.trim();
  if (!normalizedCloudUuid && !normalizedUserId) {
    return { changed: false, memoryConfigAffected: false };
  }
  const result = await mutateRuntimeConfig(configPath, (config) => {
    const appConfig = isRecord(config.app) ? { ...config.app } : {};
    if (normalizedCloudUuid) appConfig.cloudUuid = normalizedCloudUuid;
    if (normalizedUserId) appConfig.userId = normalizedUserId;
    delete appConfig[LEGACY_ACCOUNT_BYOK_LOCAL_SELECTION_BASELINE];
    setAppConfig(config, appConfig);
    delete config.uuid;
    delete config.identity;

    const effectiveCloudUuid = normalizedCloudUuid ?? existingString(appConfig.cloudUuid);
    const ownerAccountId = normalizedUserId ?? existingString(appConfig.userId) ?? effectiveCloudUuid;
    if (!effectiveCloudUuid || !ownerAccountId) {
      return { memoryConfigAffected: false };
    }

    const providers = isRecord(config.providers) ? { ...config.providers } : {};
    const existingAccountProvider = isRecord(providers[MEMMY_ACCOUNT_PROVIDER])
      ? { ...providers[MEMMY_ACCOUNT_PROVIDER] }
      : {};
    const existingEndpoints = isRecord(existingAccountProvider.endpoints)
      ? { ...existingAccountProvider.endpoints }
      : {};
    const existingPlatform = isRecord(existingEndpoints.platform) ? existingEndpoints.platform : {};
    providers[MEMMY_ACCOUNT_PROVIDER] = {
      ...existingAccountProvider,
      ownerAccountId,
      apiKey: effectiveCloudUuid,
      endpoints: {
        ...existingEndpoints,
        platform: {
          ...existingPlatform,
          apiBase: resolveMemmyAccountApiBase(),
          protocol: "memmy-account"
        }
      }
    };
    delete (providers[MEMMY_ACCOUNT_PROVIDER] as Record<string, unknown>).apiBase;
    delete (providers[MEMMY_ACCOUNT_PROVIDER] as Record<string, unknown>).apiType;
    config.providers = providers;

    const presets = isRecord(config.modelPresets) ? { ...config.modelPresets } : {};
    for (const [presetId, value] of Object.entries(presets)) {
      if (isRecord(value) && value.source === "account" && value.ownerAccountId !== ownerAccountId) {
        delete presets[presetId];
      }
    }
    const presetIds = accountPresetIds(ownerAccountId);
    for (const [capability, presetId] of Object.entries(presetIds)) {
      presets[presetId] = {
        ...(isRecord(presets[presetId]) ? presets[presetId] : {}),
        provider: MEMMY_ACCOUNT_PROVIDER,
        endpoint: "platform",
        model: ACCOUNT_MODELS[capability as keyof typeof ACCOUNT_MODELS],
        source: "account",
        ownerAccountId,
        capabilities: [capability]
      };
      delete (presets[presetId] as Record<string, unknown>).label;
    }
    config.modelPresets = presets;
    updateAccountAssignment(config, ownerAccountId, presetIds);

    const agents = isRecord(config.agents) ? { ...config.agents } : {};
    const defaults = isRecord(agents.defaults) ? { ...agents.defaults } : {};
    const currentDefault = existingString(defaults.modelPreset);
    if (!currentDefault || !isRecord(presets[currentDefault])) defaults.modelPreset = presetIds.agent;
    agents.defaults = defaults;
    config.agents = agents;
    return { memoryConfigAffected: false };
  });
  return { changed: result.changed, memoryConfigAffected: result.value.memoryConfigAffected };
}

/**
 * Clear the account-mode runtime login projection.
 *
 * @param configPath the Memmy main config file path.
 */
export async function clearAccountModelProjectionFromMemmyConfig(
  configPath = resolveDefaultMemmyConfigPath(),
  input: {
    ownerAccountId?: string;
    force?: boolean;
    syncSelectedByokToLocal?: boolean;
    expectedCloudUuid?: string;
  } = {}
): Promise<RuntimeProjectionResult> {
  const requestedOwnerAccountId = input.ownerAccountId?.trim();
  const expectedCloudUuid = input.expectedCloudUuid?.trim();
  const result = await mutateRuntimeConfig(configPath, (config) => {
    const appConfig = isRecord(config.app) ? { ...config.app } : {};
    const providers = isRecord(config.providers) ? { ...config.providers } : {};
    const accountProvider = asRecord(providers[MEMMY_ACCOUNT_PROVIDER]);
    if (input.force) {
      delete appConfig.cloudUuid;
      delete appConfig.userId;
      delete appConfig[LEGACY_ACCOUNT_BYOK_LOCAL_SELECTION_BASELINE];
      setAppConfig(config, appConfig);
      delete config.uuid;
      delete config.identity;
      delete providers[MEMMY_ACCOUNT_PROVIDER];
      config.providers = providers;
      const presets = isRecord(config.modelPresets) ? { ...config.modelPresets } : {};
      for (const [presetId, value] of Object.entries(presets)) {
        if (isRecord(value) && value.source === "account") delete presets[presetId];
      }
      config.modelPresets = presets;
      replaceRemovedAccountDefault(config, presets);
      const assignments = isRecord(config.modelAssignments) ? { ...config.modelAssignments } : {};
      delete assignments.account;
      config.modelAssignments = assignments;
      return { memoryConfigAffected: false };
    }
    const currentCloudUuid = existingString(appConfig.cloudUuid) ?? existingString(accountProvider?.apiKey);
    if (expectedCloudUuid && currentCloudUuid !== expectedCloudUuid) {
      return { memoryConfigAffected: false };
    }
    const ownerAccountId = requestedOwnerAccountId
      ?? existingString(appConfig.userId)
      ?? existingString(accountProvider?.ownerAccountId);
    if (!ownerAccountId) return { memoryConfigAffected: false };
    delete appConfig[LEGACY_ACCOUNT_BYOK_LOCAL_SELECTION_BASELINE];

    if (input.syncSelectedByokToLocal) {
      syncSelectedAccountByokCandidatesToLocal(config, ownerAccountId);
    }

    if (!existingString(appConfig.userId) || appConfig.userId === ownerAccountId) {
      delete appConfig.cloudUuid;
      delete appConfig.userId;
      setAppConfig(config, appConfig);
      delete config.uuid;
      delete config.identity;
    }

    if (accountProvider?.ownerAccountId === ownerAccountId) {
      delete providers[MEMMY_ACCOUNT_PROVIDER];
      config.providers = providers;
    }
    const presets = isRecord(config.modelPresets) ? { ...config.modelPresets } : {};
    let removedPreset = false;
    for (const [presetId, value] of Object.entries(presets)) {
      if (isRecord(value) && value.source === "account" && value.ownerAccountId === ownerAccountId) {
        delete presets[presetId];
        removedPreset = true;
      }
    }
    if (removedPreset) {
      config.modelPresets = presets;
      replaceRemovedAccountDefault(config, presets);
    }
    return { memoryConfigAffected: false };
  });
  return { changed: result.changed, memoryConfigAffected: result.value.memoryConfigAffected };
}

/**
 * Backwards-compatible alias; semantically equivalent to writing the account standard model config projection.
 *
 * @param input the account credentials to persist after login.
 * @param configPath the Memmy main config file path.
 */
export async function writeAppLoginFieldsToMemmyConfig(
  input: { cloudUuid?: string; userId?: string },
  configPath = resolveDefaultMemmyConfigPath()
): Promise<RuntimeProjectionResult> {
  return writeAccountModelProjectionToMemmyConfig(input, configPath);
}

/**
 * Patch a single memmy-agent channel config.
 *
 * @param channelName the memmy-agent runtime channel name.
 * @param patch the channel fields to merge in.
 * @param configPath the Memmy main config file path.
 */
export async function patchChannelConfigInMemmyConfig(
  channelName: string,
  patch: Record<string, unknown>,
  configPath = resolveDefaultMemmyConfigPath()
): Promise<void> {
  const normalizedName = normalizeChannelNameForConfig(channelName);
  await mutateRuntimeConfig(configPath, (config) => {
    const channels = isRecord(config.channels) ? { ...config.channels } : {};
    const existingChannel = isRecord(channels[normalizedName]) ? { ...channels[normalizedName] } : {};
    channels[normalizedName] = { ...existingChannel, ...omitUndefined(patch) };
    config.channels = channels;
  });
}

/**
 * Write a single memmy-agent MCP server config (tools.mcpServers[serverName]).
 *
 * Fully replaces this server's config, so each startup can idempotently refresh it with the latest port/credentials.
 *
 * @param serverName the MCP server name, e.g. composio.
 * @param serverConfig the full config for this MCP server, e.g. { type, url, headers }.
 * @param configPath the Memmy main config file path.
 */
export async function patchMcpServerConfigInMemmyConfig(
  serverName: string,
  serverConfig: Record<string, unknown>,
  configPath = resolveDefaultMemmyConfigPath()
): Promise<void> {
  const normalizedName = normalizeChannelNameForConfig(serverName);
  await mutateRuntimeConfig(configPath, (config) => {
    const tools = isRecord(config.tools) ? { ...config.tools } : {};
    const mcpServers = isRecord(tools.mcpServers) ? { ...tools.mcpServers } : {};
    mcpServers[normalizedName] = { ...omitUndefined(serverConfig) };
    tools.mcpServers = mcpServers;
    config.tools = tools;
  });
}

function accountPresetIds(ownerAccountId: string): AccountPresetIds {
  const ownerHash = createHash("sha256").update(ownerAccountId).digest("hex").slice(0, 12);
  return Object.fromEntries(Object.keys(ACCOUNT_MODELS).map((capability) => [
    capability,
    `memmy-account-${ownerHash}-${capability.replaceAll("_", "-")}`
  ])) as AccountPresetIds;
}

function updateAccountAssignment(
  config: Record<string, unknown>,
  ownerAccountId: string,
  presetIds: AccountPresetIds
): void {
  const assignments = isRecord(config.modelAssignments) ? { ...config.modelAssignments } : {};
  const existing = isRecord(assignments.account) ? { ...assignments.account } : {};
  const sameOwner = existingString(existing.ownerAccountId) === ownerAccountId;
  const presets = isRecord(config.modelPresets) ? config.modelPresets : {};
  const agent = isRecord(existing.agent) ? { ...existing.agent } : {};
  const currentCandidates = Array.isArray(agent.candidates)
    ? agent.candidates.filter((value): value is string => typeof value === "string")
    : [];
  const platformCandidates = [...new Set(currentCandidates.filter((presetId) => {
    const preset = asRecord(presets[presetId]);
    return preset?.source === "account"
      && assignmentPresetIsUsable(presets, presetId, "agent", ownerAccountId);
  }))];
  if (!platformCandidates.includes(presetIds.agent)) platformCandidates.push(presetIds.agent);

  const byok = isRecord(assignments.byok) ? assignments.byok : {};
  const byokAgent = isRecord(byok.agent) ? byok.agent : {};
  const localCandidates = selectedUsableByokAgentCandidates(byokAgent, presets, ownerAccountId);
  const candidates = [...platformCandidates, ...localCandidates];
  const currentDefault = existingString(agent.default);
  agent.candidates = candidates;
  agent.default = currentDefault && candidates.includes(currentDefault) ? currentDefault : presetIds.agent;

  const singles = {
    memorySummary: "memory_summary",
    memoryEvolution: "memory_evolution",
    embedding: "embedding",
    asr: "asr",
    imageGeneration: "image_generation"
  } as const;
  const next: Record<string, unknown> = { ...existing, ownerAccountId, agent };
  for (const [field, capability] of Object.entries(singles) as Array<[keyof typeof singles, AccountCapability]>) {
    const current = existingString(existing[field]);
    const keepBuiltInLocalEmbedding = field === "embedding"
      && sameOwner
      && current === BUILTIN_LOCAL_EMBEDDING_ASSIGNMENT_ID;
    next[field] = keepBuiltInLocalEmbedding
      ? current
      : current && assignmentPresetIsUsable(presets, current, capability, ownerAccountId)
        ? current
        : presetIds[capability];
  }
  assignments.account = next;
  config.modelAssignments = assignments;
}

function syncSelectedAccountByokCandidatesToLocal(
  config: Record<string, unknown>,
  ownerAccountId: string
): void {
  const assignments = isRecord(config.modelAssignments) ? { ...config.modelAssignments } : {};
  const account = isRecord(assignments.account) ? assignments.account : {};
  if (existingString(account.ownerAccountId) !== ownerAccountId) return;

  const presets = isRecord(config.modelPresets) ? config.modelPresets : {};
  const accountAgent = isRecord(account.agent) ? account.agent : {};
  const selectedByokCandidates = selectedUsableByokAgentCandidates(accountAgent, presets, ownerAccountId);

  const byok = isRecord(assignments.byok) ? { ...assignments.byok } : {};
  const byokAgent = isRecord(byok.agent) ? { ...byok.agent } : {};
  if (selectedByokCandidates.length === 0) return;

  const localDefault = existingString(byokAgent.default);
  byokAgent.candidates = selectedByokCandidates;
  byokAgent.default = localDefault && selectedByokCandidates.includes(localDefault)
    ? localDefault
    : selectedByokCandidates[0];
  byok.agent = byokAgent;
  assignments.byok = byok;
  config.modelAssignments = assignments;
}

function selectedUsableByokAgentCandidates(
  agent: Record<string, unknown>,
  presets: Record<string, unknown>,
  ownerAccountId: string
): string[] {
  return [...new Set((Array.isArray(agent.candidates) ? agent.candidates : [])
    .filter((value): value is string => typeof value === "string")
    .filter((presetId) => asRecord(presets[presetId])?.source === "byok"
      && assignmentPresetIsUsable(presets, presetId, "agent", ownerAccountId)))];
}

function assignmentPresetIsUsable(
  presets: Record<string, unknown>,
  presetId: string,
  capability: AccountCapability,
  ownerAccountId: string
): boolean {
  const preset = asRecord(presets[presetId]);
  if (!preset || !Array.isArray(preset.capabilities) || !preset.capabilities.includes(capability)) return false;
  if (preset.source === "byok") return true;
  return preset.source === "account" && preset.ownerAccountId === ownerAccountId;
}

function replaceRemovedAccountDefault(
  config: Record<string, unknown>,
  remainingPresets: Record<string, unknown>
): void {
  const agents = isRecord(config.agents) ? { ...config.agents } : {};
  const defaults = isRecord(agents.defaults) ? { ...agents.defaults } : {};
  const currentDefault = existingString(defaults.modelPreset);
  if (!currentDefault || (!currentDefault.startsWith("memmy-account-") && currentDefault !== "memmy-account")) return;
  const replacement = Object.entries(remainingPresets).find(([, value]) => {
    const preset = asRecord(value);
    return preset?.source === "byok"
      && Array.isArray(preset.capabilities)
      && preset.capabilities.includes("agent");
  });
  defaults.modelPreset = replacement?.[0] ?? null;
  agents.defaults = defaults;
  config.agents = agents;
}

function runtimeConfigProblem(
  status: Extract<RuntimeConfigStateStatus, "invalid_yaml" | "no_model_config" | "conflict">,
  configPath: string,
  reason: string,
  accountProjection?: { cloudUuid: string; userId?: string }
): RuntimeMemmyConfigState {
  return omitUndefined({
    status,
    configPath,
    reason,
    accountProjection
  }) as RuntimeMemmyConfigState;
}

async function readMemmyConfigContent(configPath: string): Promise<string | null> {
  try {
    return await readFile(configPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

/**
 * Determine whether an unknown value is a plain object.
 *
 * @param value the YAML parse result.
 * @returns true when it is a plain object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function setAppConfig(config: Record<string, unknown>, appConfig: Record<string, unknown>): void {
  if (Object.keys(appConfig).length) {
    config.app = appConfig;
  } else {
    delete config.app;
  }
}

function normalizeChannelNameForConfig(value: string): string {
  const normalized = value.trim().toLowerCase().replaceAll("-", "_");
  if (!normalized) {
    throw new Error("channel name is required");
  }
  if (!/^[a-z][a-z0-9_]*$/.test(normalized)) {
    throw new Error(`invalid channel name: ${value}`);
  }
  return normalized;
}

function existingString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Drop fields whose value is undefined.
 *
 * @param value the object to clean.
 * @returns a new object without undefined fields.
 */
function omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

/**
 * Determine whether an error is a Node.js filesystem error.
 *
 * @param error an unknown exception.
 * @returns true when it is an Error with a code field.
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
