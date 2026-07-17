/** Memmy config module. */
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  resolveCloudServiceBaseUrl,
  ModelConfigInputSchema,
  type ImageGenProvider,
  type MemmyMemoryModelConfigInput,
  type ModelConfigInput,
  type ModelProvider
} from "@memmy/local-api-contracts";
import YAML from "yaml";

const MEMMY_ACCOUNT_PROVIDER = "memmy_account";
const MEMMY_ACCOUNT_MODEL = "agent_chat";
const MEMMY_ACCOUNT_IMAGE_MODEL = "image_gen";

/** Handles resolve memmy account api base. */
export function resolveMemmyAccountApiBase(): string {
  return `${resolveCloudServiceBaseUrl(process.env.MEMMY_CLOUD_SERVICE)}/api/agentExternal/v1`;
}
const MEMORY_ACCOUNT_SUMMARY_MODEL = "memory_summary";
const MEMORY_ACCOUNT_EVOLUTION_MODEL = "memory_evolution";
const MEMORY_ACCOUNT_EMBEDDING_MODEL = "embedding";

type AgentApiType = "auto" | "chatCompletions" | "responses";
type MemoryProfileName = "account" | "byok";
type ImageGenerationProfileName = "account" | "byok";

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
      modelConfig: ModelConfigInput & { memmyMemory: MemmyMemoryModelConfigInput };
    };

export interface RuntimeProjectionResult {
  changed: boolean;
  activeProfile: MemoryProfileName;
  activeProfileChanged: boolean;
  activeProfileAffected: boolean;
}

export interface ByokModelProjectionOptions {
  /**
   * Whether to switch the runtime state over to BYOK.
   *
   * Field semantics:
   * - true: sync agents.defaults and set memmyMemory.activeProfile to byok.
   * - false: only update the BYOK provider/profile, keeping the current runtime state.
   */
  activate?: boolean;
}

export interface MemmyConfigWriter {
  /**
   * Write the account-mode Agent standard model config projection.
   *
   * @param input the login credentials and user id returned by cloud agentUser/login.
   */
  writeAccountModelProjection(input: { cloudUuid?: string; userId?: string }): Promise<RuntimeProjectionResult>;

  /**
   * Clear the account-mode runtime login projection.
   */
  clearAccountModelProjection?(): Promise<RuntimeProjectionResult>;

  /**
   * Write the BYOK primary model and Memory role model projections.
   *
   * @param input the model config with memmyMemory role models already expanded.
   * @param options whether to also activate the BYOK runtime state.
   */
  writeByokModelProjection(
    input: ModelConfigInput & { memmyMemory: MemmyMemoryModelConfigInput },
    options?: ByokModelProjectionOptions
  ): Promise<RuntimeProjectionResult>;

  /**
   * Switch only the Memory active profile, without rewriting either profile's contents.
   *
   * @param profile the target Memory profile.
   */
  writeActiveMemoryProfile(profile: MemoryProfileName): Promise<RuntimeProjectionResult>;

  /**
   * Switch only the image generation active profile, without rewriting the account/byok profile contents.
   *
   * @param profile the target image generation profile.
   */
  writeActiveImageGenerationProfile?(profile: ImageGenerationProfileName): Promise<RuntimeProjectionResult>;

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
    async writeAccountModelProjection(input) {
      return writeAccountModelProjectionToMemmyConfig(input, configPath);
    },

    async clearAccountModelProjection() {
      return clearAccountModelProjectionFromMemmyConfig(configPath);
    },

    async writeByokModelProjection(input, projectionOptions) {
      return writeByokModelProjectionToMemmyConfig(input, configPath, projectionOptions);
    },

    async writeActiveMemoryProfile(profile) {
      return writeActiveMemoryProfileToMemmyConfig(profile, configPath);
    },

    async writeActiveImageGenerationProfile(profile) {
      return writeActiveImageGenerationProfileToMemmyConfig(profile, configPath);
    },

    async patchChannelConfig(channelName, patch) {
      await patchChannelConfigInMemmyConfig(channelName, patch, configPath);
    },

    async patchMcpServerConfig(serverName, serverConfig) {
      await patchMcpServerConfigInMemmyConfig(serverName, serverConfig, configPath);
    }
  };
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
  configPath = resolveDefaultMemmyConfigPath()
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

  return deriveRuntimeMemmyConfigState(parsed, configPath);
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

function deriveRuntimeMemmyConfigState(config: Record<string, unknown>, configPath: string): RuntimeMemmyConfigState {
  const memmyMemory = asRecord(config.memmyMemory);
  const activeProfile = memoryProfileName(memmyMemory?.activeProfile);
  const agents = asRecord(config.agents);
  const defaults = asRecord(agents?.defaults);
  const providerName = existingString(defaults?.provider);
  const modelName = existingString(defaults?.model);
  const isAccountDefaults = providerName === MEMMY_ACCOUNT_PROVIDER && modelName === MEMMY_ACCOUNT_MODEL;
  const isByokDefaults = Boolean(providerName && modelName && providerName !== MEMMY_ACCOUNT_PROVIDER);

  if ((activeProfile === "account" && isByokDefaults) || (activeProfile === "byok" && isAccountDefaults)) {
    return runtimeConfigProblem("conflict", configPath, "agents.defaults and memmyMemory.activeProfile point to different modes");
  }

  if (activeProfile === "account" || isAccountDefaults) {
    return deriveAccountRuntimeConfigState(config, configPath);
  }

  if (activeProfile === "byok" || isByokDefaults) {
    return deriveByokRuntimeConfigState(config, configPath, providerName, modelName);
  }

  return runtimeConfigProblem("no_model_config", configPath, "Missing agents.defaults provider/model and memory active profile");
}

function deriveAccountRuntimeConfigState(
  config: Record<string, unknown>,
  configPath: string
): RuntimeMemmyConfigState {
  const cloudUuid =
    existingString(asRecord(config.app)?.cloudUuid) ??
    existingString(asRecord(asRecord(config.providers)?.[MEMMY_ACCOUNT_PROVIDER])?.apiKey) ??
    existingString(asRecord(readMemoryProfile(config, "account"))?.apiKey) ??
    existingString(asRecord(asRecord(readMemoryProfile(config, "account"))?.summary)?.apiKey);
  if (!cloudUuid) {
    return runtimeConfigProblem("no_model_config", configPath, "Account runtime config is missing cloud uuid");
  }

  const userId =
    existingString(asRecord(config.app)?.userId) ??
    existingString(asRecord(readMemoryProfile(config, "account"))?.userId);
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
  providerName: string | undefined,
  modelName: string | undefined
): RuntimeMemmyConfigState {
  if (!providerName || !modelName) {
    return runtimeConfigProblem("no_model_config", configPath, "BYOK runtime config is missing agents.defaults provider/model");
  }

  const provider = modelProviderFromAgentProvider(providerName);
  const providerConfig = asRecord(asRecord(config.providers)?.[providerName]);
  const baseUrl = existingString(providerConfig?.apiBase);
  const apiKey = existingString(providerConfig?.apiKey);
  if (!provider || !baseUrl || !apiKey) {
    return runtimeConfigProblem("no_model_config", configPath, "BYOK runtime config is missing provider apiBase/apiKey");
  }

  const byokProfile = asRecord(readMemoryProfile(config, "byok"));
  const input = {
    provider,
    baseUrl,
    modelId: modelName,
    apiKey,
    imageGen: readRuntimeImageGenerationConfig(config),
    embedding: readRuntimeEmbeddingConfig(byokProfile),
    memmyMemory: {
      summary: readRuntimeRoleModelConfig(asRecord(byokProfile?.summary), {
        provider,
        baseUrl,
        modelId: modelName,
        apiKey
      }),
      evolution: readRuntimeRoleModelConfig(asRecord(byokProfile?.evolution), {
        provider,
        baseUrl,
        modelId: modelName,
        apiKey
      })
    }
  };
  const parsed = ModelConfigInputSchema.safeParse(input);
  if (!parsed.success || !parsed.data.memmyMemory) {
    return runtimeConfigProblem("no_model_config", configPath, "BYOK runtime config has invalid provider/model URLs");
  }

  return {
    status: "valid_byok",
    configPath,
    modelConfig: {
      ...parsed.data,
      memmyMemory: parsed.data.memmyMemory
    }
  };
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
    return unchangedProjectionResult(await readMemmyConfig(configPath), "account");
  }

  const before = await readMemmyConfig(configPath);
  const config = cloneConfig(before);
  const beforeActiveProfile = memoryProfileName(asRecord(config.memmyMemory)?.activeProfile);
  const appConfig = isRecord(config.app) ? { ...config.app } : {};
  if (normalizedCloudUuid) {
    appConfig.cloudUuid = normalizedCloudUuid;
    patchAgentDefaults(config, {
      provider: MEMMY_ACCOUNT_PROVIDER,
      model: MEMMY_ACCOUNT_MODEL
    });
    patchProviderConfig(config, MEMMY_ACCOUNT_PROVIDER, {
      apiBase: resolveMemmyAccountApiBase(),
      apiKey: normalizedCloudUuid
    });
  }
  if (normalizedUserId) {
    appConfig.userId = normalizedUserId;
  }
  setAppConfig(config, appConfig);
  delete config.uuid;
  delete config.identity;

  const effectiveCloudUuid = normalizedCloudUuid ?? existingString(appConfig.cloudUuid);
  const memmyMemory = prepareMemmyMemoryConfig(config, "account");
  const profiles = getMemoryProfiles(memmyMemory);
  profiles.account = buildAccountMemoryProfile({
    existing: isRecord(profiles.account) ? profiles.account : null,
    cloudUuid: effectiveCloudUuid,
    userId: normalizedUserId
  });
  memmyMemory.profiles = profiles;
  config.memmyMemory = memmyMemory;

  migrateLegacyImageGenerationToByokProfile(config);
  const accountProvider = asRecord(asRecord(config.providers)?.[MEMMY_ACCOUNT_PROVIDER]);
  const accountApiBase = existingString(accountProvider?.apiBase) ?? resolveMemmyAccountApiBase();
  const accountApiKey = existingString(accountProvider?.apiKey) ?? effectiveCloudUuid;
  if (accountApiKey) {
    upsertImageGenerationProfile(config, "account", {
      provider: MEMMY_ACCOUNT_PROVIDER,
      model: MEMMY_ACCOUNT_IMAGE_MODEL,
      apiBase: accountApiBase,
      apiKey: accountApiKey
    });
  }
  writeActiveImageGenerationProfile(config, "account");

  return writeProjectionResult({
    before,
    after: config,
    configPath,
    beforeActiveProfile,
    targetProfile: "account"
  });
}

/**
 * Clear the account-mode runtime login projection.
 *
 * @param configPath the Memmy main config file path.
 */
export async function clearAccountModelProjectionFromMemmyConfig(
  configPath = resolveDefaultMemmyConfigPath()
): Promise<RuntimeProjectionResult> {
  const before = await readMemmyConfig(configPath);
  const config = cloneConfig(before);
  const beforeActiveProfile = memoryProfileName(asRecord(config.memmyMemory)?.activeProfile);

  const appConfig = isRecord(config.app) ? { ...config.app } : {};
  delete appConfig.cloudUuid;
  delete appConfig.userId;
  setAppConfig(config, appConfig);
  delete config.uuid;
  delete config.identity;

  clearAccountAgentProjection(config);
  clearAccountMemoryProjection(config);
  clearImageGenerationProfile(config, "account");

  return writeProjectionResult({
    before,
    after: config,
    configPath,
    beforeActiveProfile,
    targetProfile: beforeActiveProfile ?? "account"
  });
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
 * Write the BYOK model config projection.
 *
 * @param input the model config with memmyMemory role models already expanded.
 * @param configPath the Memmy main config file path.
 * @param options whether to also activate the BYOK runtime state.
 */
export async function writeByokModelProjectionToMemmyConfig(
  input: ModelConfigInput & { memmyMemory: MemmyMemoryModelConfigInput },
  configPath = resolveDefaultMemmyConfigPath(),
  options: ByokModelProjectionOptions = {}
): Promise<RuntimeProjectionResult> {
  const before = await readMemmyConfig(configPath);
  const config = cloneConfig(before);
  const beforeActiveProfile = memoryProfileName(asRecord(config.memmyMemory)?.activeProfile);
  const activate = options.activate ?? true;

  const agentProjection = mapModelProtocol(input.provider);
  if (activate) {
    patchAgentDefaults(config, {
      provider: agentProjection.agentProvider,
      model: input.modelId
    });
  }
  patchProviderConfig(config, agentProjection.agentProvider, {
    apiBase: input.baseUrl,
    apiKey: input.apiKey,
    apiType: agentProjection.agentApiType
  });

  migrateLegacyImageGenerationToByokProfile(config);
  if (input.imageGen) {
    upsertImageGenerationProfile(config, "byok", {
      provider: mapImageGenProvider(input.imageGen.provider),
      model: input.imageGen.modelId,
      apiBase: input.imageGen.baseUrl,
      apiKey: input.imageGen.apiKey
    });
  }
  if (activate) {
    writeActiveImageGenerationProfile(config, "byok");
  }

  const memmyMemory = prepareMemmyMemoryConfig(config, activate ? "byok" : undefined);
  const profiles = getMemoryProfiles(memmyMemory);
  const existingByok = isRecord(profiles.byok) ? profiles.byok : {};
  profiles.byok = {
    ...existingByok,
    summary: buildMemoryModelProjection(input.memmyMemory.summary, isRecord(existingByok.summary) ? existingByok.summary : null, {
      defaultEnableThinking: false
    }),
    evolution: buildMemoryModelProjection(
      input.memmyMemory.evolution,
      isRecord(existingByok.evolution) ? existingByok.evolution : null,
      { defaultEnableThinking: true }
    ),
    embedding: buildMemoryEmbeddingProjection(input.embedding, isRecord(existingByok.embedding) ? existingByok.embedding : null)
  };
  memmyMemory.profiles = profiles;
  config.memmyMemory = memmyMemory;

  return writeProjectionResult({
    before,
    after: config,
    configPath,
    beforeActiveProfile,
    targetProfile: "byok"
  });
}

export async function writeActiveMemoryProfileToMemmyConfig(
  profile: MemoryProfileName,
  configPath = resolveDefaultMemmyConfigPath()
): Promise<RuntimeProjectionResult> {
  const before = await readMemmyConfig(configPath);
  const config = cloneConfig(before);
  const beforeActiveProfile = memoryProfileName(asRecord(config.memmyMemory)?.activeProfile);
  const memmyMemory = prepareMemmyMemoryConfig(config, profile);
  memmyMemory.activeProfile = profile;
  config.memmyMemory = memmyMemory;

  return writeProjectionResult({
    before,
    after: config,
    configPath,
    beforeActiveProfile,
    targetProfile: profile
  });
}

export async function writeActiveImageGenerationProfileToMemmyConfig(
  profile: ImageGenerationProfileName,
  configPath = resolveDefaultMemmyConfigPath()
): Promise<RuntimeProjectionResult> {
  const before = await readMemmyConfig(configPath);
  const config = cloneConfig(before);
  const beforeActiveProfile = imageGenerationProfileName(asRecord(asRecord(config.tools)?.imageGeneration)?.activeProfile);
  writeActiveImageGenerationProfile(config, profile);
  const changed = !sameConfig(before, config);
  if (changed) {
    await writeMemmyConfig(config, configPath);
  }
  const activeProfile = imageGenerationProfileName(asRecord(asRecord(config.tools)?.imageGeneration)?.activeProfile) ?? profile;
  return {
    changed,
    activeProfile,
    activeProfileChanged: beforeActiveProfile !== activeProfile,
    activeProfileAffected: false
  };
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
  const config = await readMemmyConfig(configPath);
  const channels = isRecord(config.channels) ? { ...config.channels } : {};
  const existingChannel = isRecord(channels[normalizedName]) ? { ...channels[normalizedName] } : {};

  channels[normalizedName] = {
    ...existingChannel,
    ...omitUndefined(patch)
  };
  config.channels = channels;

  await writeMemmyConfig(config, configPath);
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
  const config = await readMemmyConfig(configPath);
  const tools = isRecord(config.tools) ? { ...config.tools } : {};
  const mcpServers = isRecord(tools.mcpServers) ? { ...tools.mcpServers } : {};
  mcpServers[normalizedName] = { ...omitUndefined(serverConfig) };
  tools.mcpServers = mcpServers;
  config.tools = tools;

  await writeMemmyConfig(config, configPath);
}

/**
 * Patch the agent default primary model config.
 *
 * @param config the Memmy main config object.
 * @param input the agent default provider/model.
 */
function patchAgentDefaults(config: Record<string, unknown>, input: { provider: string; model: string }): void {
  const agents = isRecord(config.agents) ? { ...config.agents } : {};
  const defaults = isRecord(agents.defaults) ? { ...agents.defaults } : {};
  defaults.provider = input.provider;
  defaults.model = input.model;
  agents.defaults = defaults;
  config.agents = agents;
}

/**
 * Patch a provider config.
 *
 * @param config the Memmy main config object.
 * @param providerName the provider name.
 * @param input the provider connection fields.
 */
function patchProviderConfig(
  config: Record<string, unknown>,
  providerName: string,
  input: {
    apiBase: string;
    apiKey?: string;
    apiType?: AgentApiType;
  }
): void {
  const providers = isRecord(config.providers) ? { ...config.providers } : {};
  const provider = isRecord(providers[providerName]) ? { ...providers[providerName] } : {};
  provider.apiBase = input.apiBase;
  if (input.apiKey?.trim()) {
    provider.apiKey = input.apiKey.trim();
  }
  if (providerName === "openai" && input.apiType === "chatCompletions") {
    provider.apiType = input.apiType;
  } else {
    delete provider.apiType;
  }
  providers[providerName] = provider;
  config.providers = providers;
}

/**
 * Map an image-gen contract provider to its runtime image-gen provider name.
 *
 * @param provider the image-gen contract provider.
 * @returns the runtime image-gen provider name.
 */
function mapImageGenProvider(provider: ImageGenProvider): string {
  switch (provider) {
    case "openai_compatible":
      return "openai";
    case "google":
      return "gemini";
    case "zhipu":
      return "zhipu";
    case "qwen":
      return "dashscope";
    case "minimax":
      return "minimax";
    case "baidu":
      return "qianfan";
    case "doubao":
      return "volcengine";
  }
}

function upsertImageGenerationProfile(
  config: Record<string, unknown>,
  profile: ImageGenerationProfileName,
  input: { provider: string; model: string; apiBase: string; apiKey?: string }
): void {
  const tools = isRecord(config.tools) ? { ...config.tools } : {};
  const imageGeneration = isRecord(tools.imageGeneration) ? { ...tools.imageGeneration } : {};
  const profiles = getImageGenerationProfiles(imageGeneration);
  const existing = isRecord(profiles[profile]) ? { ...profiles[profile] } : {};
  imageGeneration.enabled = true;
  profiles[profile] = omitUndefined({
    ...existing,
    provider: input.provider,
    model: input.model,
    apiBase: input.apiBase,
    apiKey: input.apiKey?.trim() || existingString(existing.apiKey),
    extraHeaders: isRecord(existing.extraHeaders) ? existing.extraHeaders : undefined,
    extraBody: isRecord(existing.extraBody) ? existing.extraBody : undefined
  });
  imageGeneration.profiles = profiles;
  delete imageGeneration.provider;
  delete imageGeneration.model;
  delete imageGeneration.apiKey;
  delete imageGeneration.apiBase;
  tools.imageGeneration = imageGeneration;
  config.tools = tools;
}

function writeActiveImageGenerationProfile(
  config: Record<string, unknown>,
  profile: ImageGenerationProfileName
): void {
  const tools = isRecord(config.tools) ? { ...config.tools } : {};
  const imageGeneration = isRecord(tools.imageGeneration) ? { ...tools.imageGeneration } : {};
  imageGeneration.activeProfile = profile;
  tools.imageGeneration = imageGeneration;
  config.tools = tools;
}

function migrateLegacyImageGenerationToByokProfile(config: Record<string, unknown>): void {
  const tools = isRecord(config.tools) ? { ...config.tools } : {};
  const imageGeneration = isRecord(tools.imageGeneration) ? { ...tools.imageGeneration } : {};
  const profiles = getImageGenerationProfiles(imageGeneration);
  if (!profiles.byok) {
    const provider = existingString(imageGeneration.provider);
    const model = existingString(imageGeneration.model);
    if (provider && model) {
      profiles.byok = omitUndefined({
        provider,
        model,
        apiBase: existingString(imageGeneration.apiBase),
        apiKey: existingString(imageGeneration.apiKey)
      });
    }
  }
  if (Object.keys(profiles).length) {
    imageGeneration.profiles = profiles;
    delete imageGeneration.provider;
    delete imageGeneration.model;
    delete imageGeneration.apiKey;
    delete imageGeneration.apiBase;
    tools.imageGeneration = imageGeneration;
    config.tools = tools;
  }
}

function clearImageGenerationProfile(
  config: Record<string, unknown>,
  profile: ImageGenerationProfileName
): void {
  const tools = isRecord(config.tools) ? { ...config.tools } : {};
  const imageGeneration = isRecord(tools.imageGeneration) ? { ...tools.imageGeneration } : {};
  const profiles = getImageGenerationProfiles(imageGeneration);
  delete profiles[profile];
  if (imageGeneration.activeProfile === profile) {
    delete imageGeneration.activeProfile;
  }
  if (Object.keys(profiles).length) {
    imageGeneration.profiles = profiles;
  } else {
    delete imageGeneration.profiles;
  }
  tools.imageGeneration = imageGeneration;
  config.tools = tools;
}

function getImageGenerationProfiles(
  imageGeneration: Record<string, unknown>
): Partial<Record<ImageGenerationProfileName, Record<string, unknown>>> {
  const profiles = isRecord(imageGeneration.profiles) ? { ...imageGeneration.profiles } : {};
  return {
    ...(isRecord(profiles.byok) ? { byok: { ...profiles.byok } } : {}),
    ...(isRecord(profiles.account) ? { account: { ...profiles.account } } : {})
  };
}

function clearAccountAgentProjection(config: Record<string, unknown>): void {
  const agents = isRecord(config.agents) ? { ...config.agents } : {};
  const defaults = isRecord(agents.defaults) ? { ...agents.defaults } : {};
  if (defaults.provider === MEMMY_ACCOUNT_PROVIDER && defaults.model === MEMMY_ACCOUNT_MODEL) {
    delete defaults.provider;
    delete defaults.model;
  }
  if (Object.keys(defaults).length) {
    agents.defaults = defaults;
  } else {
    delete agents.defaults;
  }
  if (Object.keys(agents).length) {
    config.agents = agents;
  } else {
    delete config.agents;
  }

  const providers = isRecord(config.providers) ? { ...config.providers } : {};
  delete providers[MEMMY_ACCOUNT_PROVIDER];
  if (Object.keys(providers).length) {
    config.providers = providers;
  } else {
    delete config.providers;
  }
}

function clearAccountMemoryProjection(config: Record<string, unknown>): void {
  const memmyMemory = isRecord(config.memmyMemory) ? { ...config.memmyMemory } : {};
  if (memmyMemory.activeProfile === "account") {
    delete memmyMemory.activeProfile;
  }

  const profiles = getMemoryProfiles(memmyMemory);
  delete profiles.account;
  if (profiles.byok) {
    const activeProfile = memoryProfileName(memmyMemory.activeProfile);
    if (activeProfile !== "byok") {
      memmyMemory.activeProfile = "byok";
    }
    memmyMemory.profiles = profiles;
  } else {
    delete memmyMemory.activeProfile;
    delete memmyMemory.profiles;
  }

  if (Object.keys(memmyMemory).length) {
    config.memmyMemory = memmyMemory;
  } else {
    delete config.memmyMemory;
  }
}

/**
 * Build the Memory service Summary config fragment.
 *
 * @param input the role model config.
 * @returns the Memory service Summary config fragment.
 */
function buildMemoryModelProjection(
  input: MemmyMemoryModelConfigInput["summary"],
  existing: Record<string, unknown> | null = null,
  options: { defaultEnableThinking: boolean }
): Record<string, unknown> {
  const projection = mapModelProtocol(input.provider);
  return omitUndefined({
    provider: projection.memoryProvider,
    vendor: input.provider,
    endpoint: input.baseUrl,
    model: input.modelId,
    apiKey: input.apiKey ?? existingString(existing?.apiKey),
    enableThinking: existingBoolean(existing?.enableThinking) ?? options.defaultEnableThinking
  });
}

function buildMemoryEmbeddingProjection(
  input: ModelConfigInput["embedding"],
  existing: Record<string, unknown> | null = null
): Record<string, unknown> {
  if (!input || input.mode === "local") {
    return { provider: "local" };
  }

  return omitUndefined({
    provider: "openai_compatible",
    endpoint: input.baseUrl,
    model: input.modelId,
    apiKey: input.apiKey ?? existingString(existing?.apiKey)
  });
}

function buildAccountMemoryProfile(input: {
  existing: Record<string, unknown> | null;
  cloudUuid?: string;
  userId?: string;
}): Record<string, unknown> {
  const apiKey = input.cloudUuid ?? existingString(asRecord(input.existing?.summary)?.apiKey);
  return omitUndefined({
    ...input.existing,
    userId: input.userId ?? existingString(input.existing?.userId),
    summary: omitUndefined({
      vendor: "qwen",
      endpoint: resolveMemmyAccountApiBase(),
      model: MEMORY_ACCOUNT_SUMMARY_MODEL,
      apiKey,
      enableThinking: existingBoolean(asRecord(input.existing?.summary)?.enableThinking) ?? false
    }),
    evolution: omitUndefined({
      vendor: "qwen",
      endpoint: resolveMemmyAccountApiBase(),
      model: MEMORY_ACCOUNT_EVOLUTION_MODEL,
      apiKey,
      enableThinking: existingBoolean(asRecord(input.existing?.evolution)?.enableThinking) ?? true
    }),
    embedding: omitUndefined({
      endpoint: resolveMemmyAccountApiBase(),
      model: MEMORY_ACCOUNT_EMBEDDING_MODEL,
      apiKey
    })
  });
}

function prepareMemmyMemoryConfig(config: Record<string, unknown>, activeProfile: MemoryProfileName | undefined): Record<string, unknown> {
  const memmyMemory = isRecord(config.memmyMemory) ? { ...config.memmyMemory } : {};
  const existingActiveProfile = memoryProfileName(memmyMemory.activeProfile);
  const profiles = getMemoryProfiles(memmyMemory);

  const legacyUserId = existingString(memmyMemory.userId);
  if (
    !profiles.byok &&
    (legacyUserId || isRecord(memmyMemory.summary) || isRecord(memmyMemory.evolution) || isRecord(memmyMemory.embedding))
  ) {
    profiles.byok = omitUndefined({
      userId: legacyUserId,
      summary: isRecord(memmyMemory.summary) ? { ...memmyMemory.summary } : undefined,
      evolution: isRecord(memmyMemory.evolution) ? { ...memmyMemory.evolution } : undefined,
      embedding: isRecord(memmyMemory.embedding) ? { ...memmyMemory.embedding } : undefined
    });
  }

  if (!profiles.account && legacyUserId) {
    profiles.account = { userId: legacyUserId };
  }

  if (activeProfile) {
    memmyMemory.activeProfile = activeProfile;
  } else if (existingActiveProfile) {
    memmyMemory.activeProfile = existingActiveProfile;
  } else {
    delete memmyMemory.activeProfile;
  }
  memmyMemory.profiles = profiles;
  delete memmyMemory.summary;
  delete memmyMemory.evolution;
  delete memmyMemory.embedding;
  delete memmyMemory.userId;
  return memmyMemory;
}

function getMemoryProfiles(memmyMemory: Record<string, unknown>): Partial<Record<MemoryProfileName, unknown>> {
  const profiles = isRecord(memmyMemory.profiles) ? { ...memmyMemory.profiles } : {};
  return {
    ...(isRecord(profiles.byok) ? { byok: { ...profiles.byok } } : {}),
    ...(isRecord(profiles.account) ? { account: { ...profiles.account } } : {})
  };
}

async function writeProjectionResult(input: {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  configPath: string;
  beforeActiveProfile?: MemoryProfileName;
  targetProfile: MemoryProfileName;
}): Promise<RuntimeProjectionResult> {
  const changed = !sameConfig(input.before, input.after);
  if (changed) {
    await writeMemmyConfig(input.after, input.configPath);
  }

  const activeProfile = memoryProfileName(asRecord(input.after.memmyMemory)?.activeProfile) ?? input.targetProfile;
  const activeProfileChanged = input.beforeActiveProfile !== activeProfile;
  const activeProfileAffected = activeProfileChanged || (
    activeProfile === input.targetProfile &&
    !sameConfig(readMemoryProfile(input.before, input.targetProfile), readMemoryProfile(input.after, input.targetProfile))
  );

  return {
    changed,
    activeProfile,
    activeProfileChanged,
    activeProfileAffected
  };
}

function unchangedProjectionResult(config: Record<string, unknown>, targetProfile: MemoryProfileName): RuntimeProjectionResult {
  const activeProfile = memoryProfileName(asRecord(config.memmyMemory)?.activeProfile) ?? targetProfile;
  return {
    changed: false,
    activeProfile,
    activeProfileChanged: false,
    activeProfileAffected: false
  };
}

function readMemoryProfile(config: Record<string, unknown>, profile: MemoryProfileName): unknown {
  const memmyMemory = asRecord(config.memmyMemory);
  const profiles = asRecord(memmyMemory?.profiles);
  return profiles?.[profile];
}

function readRuntimeRoleModelConfig(
  role: Record<string, unknown> | undefined,
  fallback: {
    provider: ModelProvider;
    baseUrl: string;
    modelId: string;
    apiKey: string;
  }
): MemmyMemoryModelConfigInput["summary"] {
  const provider =
    modelProviderFromMemoryProvider(existingString(role?.provider)) ??
    fallback.provider;
  return omitUndefined({
    provider,
    baseUrl: existingString(role?.endpoint) ?? fallback.baseUrl,
    modelId: existingString(role?.model) ?? fallback.modelId,
    apiKey: existingString(role?.apiKey) ?? fallback.apiKey
  }) as MemmyMemoryModelConfigInput["summary"];
}

function readRuntimeEmbeddingConfig(profile: Record<string, unknown> | undefined): ModelConfigInput["embedding"] {
  const embedding = asRecord(profile?.embedding);
  const provider = existingString(embedding?.provider);
  if (!embedding || !provider || provider === "local") {
    return { mode: "local" };
  }

  return omitUndefined({
    mode: "custom",
    baseUrl: existingString(embedding.endpoint) ?? "",
    modelId: existingString(embedding.model) ?? "",
    apiKey: existingString(embedding.apiKey)
  }) as ModelConfigInput["embedding"];
}

function readRuntimeImageGenerationConfig(config: Record<string, unknown>): ModelConfigInput["imageGen"] {
  const imageGeneration = asRecord(asRecord(config.tools)?.imageGeneration);
  if (!imageGeneration) return undefined;
  const activeProfile = imageGenerationProfileName(imageGeneration.activeProfile);
  if (activeProfile === "byok") {
    return readRuntimeImageGenerationProfile(asRecord(asRecord(imageGeneration.profiles)?.byok));
  }
  if (activeProfile) return undefined;
  if (imageGeneration.enabled !== true) return undefined;
  const provider = existingString(imageGeneration.provider);
  if (provider === MEMMY_ACCOUNT_PROVIDER) return undefined;
  return readRuntimeImageGenerationProfile(imageGeneration);
}

function readRuntimeImageGenerationProfile(
  profile: Record<string, unknown> | undefined
): ModelConfigInput["imageGen"] {
  if (!profile) return undefined;
  const provider = imageGenProviderFromRuntimeProvider(existingString(profile.provider));
  const baseUrl = existingString(profile.apiBase);
  const modelId = existingString(profile.model);
  if (!provider || !baseUrl || !modelId) return undefined;
  return omitUndefined({
    provider,
    baseUrl,
    modelId,
    apiKey: existingString(profile.apiKey)
  }) as ModelConfigInput["imageGen"];
}

function modelProviderFromAgentProvider(value: string): ModelProvider | undefined {
  switch (value) {
    case "openai":
      return "openai_compatible";
    case "anthropic":
      return "anthropic";
    case "gemini":
      return "google";
    case "deepseek":
      return "deepseek";
    case "zhipu":
      return "zhipu";
    case "dashscope":
      return "qwen";
    case "moonshot":
      return "kimi";
    case "minimax":
      return "minimax";
    case "qianfan":
      return "baidu";
    case "volcengine":
      return "doubao";
    default:
      return undefined;
  }
}

function modelProviderFromMemoryProvider(value: string | undefined): ModelProvider | undefined {
  switch (value) {
    case "openai_compatible":
      return "openai_compatible";
    case "anthropic":
      return "anthropic";
    case "gemini":
      return "google";
    default:
      return undefined;
  }
}

function imageGenProviderFromRuntimeProvider(value: string | undefined): ImageGenProvider | undefined {
  switch (value) {
    case "openai":
      return "openai_compatible";
    case "gemini":
      return "google";
    case "zhipu":
      return "zhipu";
    case "dashscope":
      return "qwen";
    case "minimax":
      return "minimax";
    case "qianfan":
      return "baidu";
    case "volcengine":
      return "doubao";
    default:
      return undefined;
  }
}

function runtimeConfigProblem(
  status: Extract<RuntimeConfigStateStatus, "invalid_yaml" | "no_model_config" | "conflict">,
  configPath: string,
  reason: string
): RuntimeMemmyConfigState {
  return {
    status,
    configPath,
    reason
  };
}

function memoryProfileName(value: unknown): MemoryProfileName | undefined {
  return value === "account" || value === "byok" ? value : undefined;
}

function imageGenerationProfileName(value: unknown): ImageGenerationProfileName | undefined {
  return value === "account" || value === "byok" ? value : undefined;
}

function cloneConfig(config: Record<string, unknown>): Record<string, unknown> {
  return YAML.parse(YAML.stringify(config)) as Record<string, unknown>;
}

function sameConfig(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Read the existing Memmy main config.
 *
 * @param configPath the Memmy main config file path.
 * @returns an updatable object config; empty files, missing files, or non-object YAML are treated as an empty object.
 */
async function readMemmyConfig(configPath: string): Promise<Record<string, unknown>> {
  const content = await readMemmyConfigContent(configPath);
  if (content === null) {
    return {};
  }

  const parsed = content.trim() ? YAML.parse(content) : {};
  return isRecord(parsed) ? { ...parsed } : {};
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
 * Atomically write the Memmy main config.
 *
 * @param config the updated config object.
 * @param configPath the Memmy main config file path.
 */
async function writeMemmyConfig(config: Record<string, unknown>, configPath: string): Promise<void> {
  const configDirectory = dirname(configPath);
  const tempPath = join(configDirectory, `.${basename(configPath)}.${process.pid}.${Date.now()}.tmp`);
  const body = YAML.stringify(config);

  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await chmod(configDirectory, 0o700);

  try {
    await writeFile(tempPath, body.endsWith("\n") ? body : `${body}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(tempPath, configPath);
    await chmod(configPath, 0o600);
  } catch (error) {
    await rm(tempPath, { force: true });
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

function existingBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
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
