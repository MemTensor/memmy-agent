import { loadConfig, saveConfig, getConfigPath } from "../../config/loader.js";
import { randomUUID } from "node:crypto";
import {
  Config,
  ModelEndpointConfig,
  ModelPresetConfig,
  ProviderConfig,
  isValidImageGenerationMaxImagesPerTurn,
} from "../../config/schema.js";
import { findByName, PROVIDERS } from "../../providers/registry.js";
import { readModelCatalog } from "../../providers/model-catalog.js";
import { normalizeTimeZoneOffset } from "../../utils/time-zone.js";

type QueryParams = Record<string, string[]>;

const WEB_SEARCH_PROVIDER_OPTIONS = [
  { name: "duckduckgo", label: "DuckDuckGo", credential: "none" },
  { name: "brave", label: "Brave Search", credential: "api_key" },
  { name: "tavily", label: "Tavily", credential: "api_key" },
  { name: "searxng", label: "SearXNG", credential: "base_url" },
  { name: "jina", label: "Jina", credential: "api_key" },
  { name: "kagi", label: "Kagi", credential: "api_key" },
  { name: "olostep", label: "Olostep", credential: "api_key" },
] as const;

const WEB_SEARCH_PROVIDER_BY_NAME: Map<string, (typeof WEB_SEARCH_PROVIDER_OPTIONS)[number]> = new Map(
  WEB_SEARCH_PROVIDER_OPTIONS.map((provider) => [provider.name, provider]),
);
const IMAGE_GENERATION_ASPECT_RATIOS = new Set(["1:1", "3:4", "9:16", "4:3", "16:9", "3:2", "2:3", "21:9"]);
const IMAGE_GENERATION_UPDATE_FIELDS = new Set([
  "enabled",
  "provider",
  "model",
  "api_key",
  "apiKey",
  "api_base",
  "apiBase",
  "default_aspect_ratio",
  "defaultAspectRatio",
  "default_image_size",
  "defaultImageSize",
  "max_images_per_turn",
  "maxImagesPerTurn",
  "save_dir",
  "saveDir",
  "extra_headers",
  "extraHeaders",
  "extra_body",
  "extraBody",
  "token",
]);

export class WebUISettingsError extends Error {
  status: number;
  message: string;

  constructor(message: string, { status = 400 }: { status?: number } = {}) {
    super(message);
    this.message = message;
    this.status = status;
  }
}

function queryFirst(query: QueryParams, key: string): string | null {
  return query[key]?.[0] ?? null;
}

function queryFirstAlias(query: QueryParams, snake: string, camel: string): string | null {
  return queryFirst(query, snake) ?? queryFirst(query, camel);
}

function hasQuery(query: QueryParams, snake: string, camel?: string): boolean {
  return Object.prototype.hasOwnProperty.call(query, snake) || Boolean(camel && Object.prototype.hasOwnProperty.call(query, camel));
}

function maskSecretHint(secret: string | null | undefined): string | null {
  if (!secret) return null;
  return secret.length <= 8 ? "...." : `${secret.slice(0, 4)}....${secret.slice(-4)}`;
}

function providerRequiresApiKey(spec: any): boolean {
  if (spec.backend === "azure_openai") return true;
  if (spec.isOauth || spec.isLocal || spec.isDirect) return false;
  return true;
}

function providerConfiguredForSettings(spec: any, providerConfig: any): boolean {
  if (spec.isOauth) return true;
  if (providerRequiresApiKey(spec)) {
    return Boolean(providerConfig?.apiKey || Object.values(providerConfig?.endpoints ?? {}).some((endpoint: any) => endpoint?.apiKey));
  }
  return Boolean(
    providerConfig?.apiKey
    ?? providerConfig?.apiBase
    ?? providerConfig?.region
    ?? providerConfig?.profile
  );
}

function validateConfiguredProvider(config: Config, provider: string): void {
  if (provider === "auto") return;
  const spec = findByName(provider);
  if (!spec) throw new WebUISettingsError("unknown provider");
  const providerConfig = (config.providers as any)[spec.name];
  if (!providerConfig || !providerConfiguredForSettings(spec, providerConfig)) {
    throw new WebUISettingsError("provider is not configured");
  }
}

function parseBool(value: string, field: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!["1", "0", "true", "false", "yes", "no"].includes(normalized)) {
    throw new WebUISettingsError(`${field} must be boolean`);
  }
  return ["1", "true", "yes"].includes(normalized);
}

function normalizedTimezone(timezone: string): string {
  try {
    return normalizeTimeZoneOffset(timezone);
  } catch {
    throw new WebUISettingsError("invalid timezone");
  }
}

function setConfigValue(target: any, key: string, value: any): boolean {
  const previous = target?.[key];
  if (previous === value) return false;
  target[key] = value;
  return true;
}

function assertKnownFields(query: QueryParams, allowed: Set<string>): void {
  const unknown = Object.keys(query).filter((key) => !allowed.has(key));
  if (unknown.length) throw new WebUISettingsError(`unknown image generation setting: ${unknown[0]}`);
}

function assignedImagePreset(config: Config): { presetId: string | null; preset: ModelPresetConfig | null; endpoint: ModelEndpointConfig | null } {
  const account = config.modelAssignments.account;
  const activeOwner = String(config.app.userId ?? config.app.cloudUuid ?? "").trim();
  const useAccount = config.app.userMode === "account"
    && Boolean(activeOwner && account.ownerAccountId === activeOwner);
  const presetId = config.app.userMode === "account" && !useAccount
    ? null
    : (useAccount ? account : config.modelAssignments.byok).imageGeneration;
  const preset = presetId ? config.modelPresets[presetId] ?? null : null;
  const provider = preset ? (config.providers as any)[preset.provider] as ProviderConfig | undefined : undefined;
  return { presetId, preset, endpoint: preset ? provider?.endpoints[preset.endpoint] ?? null : null };
}

export function settingsPayload({ requiresRestart = false }: { requiresRestart?: boolean } = {}): Record<string, any> {
  const config = loadConfig();
  const defaults = config.agents.defaults;
  const catalog = readModelCatalog();
  const configuredActivePreset = defaults.modelPreset ?? "default";
  const activeItem = catalog.items.find((item) => item.preset === configuredActivePreset) ?? null;
  const activePresetName = activeItem ? configuredActivePreset : null;
  const effectivePreset = activePresetName
    ? activePresetName === "default"
      ? config.resolvePreset("default")
      : config.modelPresets[activePresetName] ?? null
    : null;
  const provider = effectivePreset
    ? config.getProvider(effectivePreset.model, { preset: effectivePreset })
    : null;

  const modelPresets = catalog.items.map((item) => {
    const preset = item.preset === "default"
      ? config.resolvePreset("default")
      : config.modelPresets[item.preset];
    return {
      name: item.preset,
      active: item.preset === activePresetName,
      is_default: item.isDefault,
      available: item.available,
      model: item.model,
      provider: item.provider,
      max_tokens: preset?.maxTokens ?? null,
      context_window_tokens: preset?.contextWindowTokens ?? null,
      temperature: preset?.temperature ?? null,
      reasoning_effort: preset?.reasoningEffort ?? null,
    };
  });

  const providers = PROVIDERS
    .map((spec) => {
      const providerConfig = (config.providers as any)[spec.name];
      if (!providerConfig || spec.isOauth) return null;
      return {
        name: spec.name,
        label: spec.label,
        configured: providerConfiguredForSettings(spec, providerConfig),
        api_key_required: providerRequiresApiKey(spec),
        api_key_hint: maskSecretHint(providerConfig.apiKey),
        endpoints: Object.entries(providerConfig.endpoints).map(([endpointId, endpoint]: [string, any]) => ({
          endpoint_id: endpointId,
          api_base: endpoint.apiBase,
          protocol: endpoint.protocol,
          has_api_key: Boolean(endpoint.apiKey),
        })),
      };
    })
    .filter(Boolean);

  const searchConfig = config.tools.webSearch;
  const fetchConfig = config.tools.webFetch;
  const imageConfig = config.tools.imageGeneration;
  const assignedImage = assignedImagePreset(config);
  const searchProvider = WEB_SEARCH_PROVIDER_BY_NAME.has(searchConfig.provider) ? searchConfig.provider : "duckduckgo";

  return {
    agent: {
      model: activeItem?.model ?? "",
      provider: activeItem?.provider ?? "",
      resolved_provider: activeItem?.provider ?? "",
      has_api_key: Boolean(provider?.apiKey),
      model_preset: activePresetName,
      max_tokens: effectivePreset?.maxTokens ?? null,
      context_window_tokens: effectivePreset?.contextWindowTokens ?? null,
      temperature: effectivePreset?.temperature ?? null,
      reasoning_effort: effectivePreset?.reasoningEffort ?? null,
      timezone: defaults.timezone,
      bot_name: defaults.botName,
      bot_icon: defaults.botIcon,
      tool_hint_max_length: defaults.toolHintMaxLength,
    },
    model_presets: modelPresets,
    providers,
    web_search: {
      provider: searchProvider,
      api_key_hint: maskSecretHint(searchConfig.apiKey),
      base_url: searchConfig.baseUrl || null,
      max_results: searchConfig.maxResults,
      timeout: searchConfig.timeout,
      providers: [...WEB_SEARCH_PROVIDER_OPTIONS],
    },
    web: {
      enable: (config.tools as any).web?.enable ?? true,
      proxy: (config.tools as any).web?.proxy ?? "",
      user_agent: (config.tools as any).web?.userAgent ?? "",
      search: {
        max_results: searchConfig.maxResults,
        timeout: searchConfig.timeout,
      },
      fetch: {
        use_jina_reader: fetchConfig.useJinaReader,
      },
    },
    image_generation: {
      enabled: imageConfig.enabled,
      preset_id: assignedImage.presetId,
      provider: assignedImage.preset?.provider ?? null,
      endpoint_id: assignedImage.preset?.endpoint ?? null,
      protocol: assignedImage.endpoint?.protocol ?? null,
      provider_configured: Boolean(assignedImage.preset && assignedImage.endpoint),
      model: assignedImage.preset?.model ?? null,
      default_aspect_ratio: imageConfig.defaultAspectRatio,
      default_image_size: imageConfig.defaultImageSize,
      max_images_per_turn: imageConfig.maxImagesPerTurn,
      save_dir: imageConfig.saveDir,
    },
    runtime: {
      config_path: getConfigPath(),
      workspace_path: defaults.workspace,
      gateway_host: config.gateway.host,
      gateway_port: config.gateway.port,
      heartbeat: {
        enabled: config.gateway.heartbeat.enabled,
        interval_s: config.gateway.heartbeat.intervalS,
        keep_recent_messages: config.gateway.heartbeat.keepRecentMessages,
      },
      dream: {
        schedule: defaults.dream.describeSchedule(),
        max_batch_size: defaults.dream.maxBatchSize,
        max_iterations: defaults.dream.maxIterations,
        annotate_line_ages: defaults.dream.annotateLineAges,
      },
      unified_session: defaults.unifiedSession,
    },
    advanced: {
      mcp_server_count: Object.keys(config.tools.mcpServers).length,
      exec_enabled: (config.tools as any).exec?.enable ?? false,
      exec_sandbox: (config.tools as any).exec?.sandbox ?? null,
      exec_path_append_set: Boolean((config.tools as any).exec?.pathAppend),
      restrict_to_workspace: config.tools.restrictToWorkspace,
      ssrf_whitelist_count: config.tools.ssrfWhitelist.length,
    },
    requires_restart: requiresRestart,
  };
}
export function updateAgentSettings(query: QueryParams): Record<string, any> {
  const config = loadConfig();
  const defaults = config.agents.defaults;
  let changed = false;
  let restartRequired = false;

  if (hasQuery(query, "model_preset", "modelPreset")) {
    const preset = (queryFirstAlias(query, "model_preset", "modelPreset") ?? "").trim();
    const value = !preset || preset === "default" ? null : preset;
    if (value && !(value in config.modelPresets)) throw new WebUISettingsError("unknown model preset");
    if (defaults.modelPreset !== value) {
      defaults.modelPreset = value;
      changed = true;
    }
  }

  const model = queryFirst(query, "model");
  if (model !== null) {
    const value = model.trim();
    if (!value) throw new WebUISettingsError("model is required");
    if (defaults.model !== value) {
      defaults.model = value;
      changed = true;
    }
  }

  const provider = queryFirst(query, "provider");
  if (provider !== null) {
    const value = provider.trim();
    if (!value) throw new WebUISettingsError("provider is required");
    validateConfiguredProvider(config, value);
    if (defaults.provider !== value) {
      defaults.provider = value;
      changed = true;
    }
  }

  const timezone = queryFirst(query, "timezone");
  if (timezone !== null) {
    const value = timezone.trim();
    if (!value) throw new WebUISettingsError("timezone is required");
    const normalized = normalizedTimezone(value);
    if (defaults.timezone !== normalized) {
      defaults.timezone = normalized;
      changed = true;
      restartRequired = true;
    }
  }

  const botName = queryFirstAlias(query, "bot_name", "botName");
  if (botName !== null) {
    const value = botName.trim();
    if (!value) throw new WebUISettingsError("bot_name is required");
    if (defaults.botName !== value) {
      defaults.botName = value;
      changed = true;
      restartRequired = true;
    }
  }

  const botIcon = queryFirstAlias(query, "bot_icon", "botIcon");
  if (botIcon !== null) {
    const value = botIcon.trim();
    if (defaults.botIcon !== value) {
      defaults.botIcon = value;
      changed = true;
      restartRequired = true;
    }
  }

  const toolHintMaxLength = queryFirstAlias(query, "tool_hint_max_length", "toolHintMaxLength");
  if (toolHintMaxLength !== null) {
    const parsed = Number.parseInt(toolHintMaxLength, 10);
    if (!Number.isInteger(parsed)) throw new WebUISettingsError("tool_hint_max_length must be an integer");
    if (parsed < 20 || parsed > 500) throw new WebUISettingsError("tool_hint_max_length must be between 20 and 500");
    if (defaults.toolHintMaxLength !== parsed) {
      defaults.toolHintMaxLength = parsed;
      changed = true;
      restartRequired = true;
    }
  }

  if (changed) saveConfig(config);
  return settingsPayload({ requiresRestart: restartRequired });
}

export function createModelConfiguration(query: QueryParams): Record<string, any> {
  if (hasQuery(query, "label", "displayName") || hasQuery(query, "name")) {
    throw new WebUISettingsError("model labels and client-generated names are not supported");
  }
  const model = (queryFirst(query, "model") ?? "").trim();
  const provider = (queryFirst(query, "provider") ?? "").trim();
  const endpointId = (queryFirstAlias(query, "endpoint_id", "endpointId") ?? "").trim();
  const requestedPresetId = (queryFirstAlias(query, "preset_id", "presetId") ?? "").trim();
  const capabilities = (query.capability ?? query.capabilities ?? ["agent"])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);

  if (!model) throw new WebUISettingsError("model is required");
  if (!provider) throw new WebUISettingsError("provider is required");
  if (!endpointId) throw new WebUISettingsError("endpoint_id is required");

  const config = loadConfig();
  validateConfiguredProvider(config, provider);
  const providerConfig = (config.providers as any)[provider] as ProviderConfig;
  if (!providerConfig.endpoints[endpointId]) throw new WebUISettingsError("provider endpoint is not configured");
  const existing = requestedPresetId ? config.modelPresets[requestedPresetId] : null;
  if (requestedPresetId && !existing) throw new WebUISettingsError("unknown preset ID", { status: 404 });
  if (existing?.source === "account") throw new WebUISettingsError("account presets are managed by account login", { status: 409 });
  const presetId = requestedPresetId || randomUUID();

  const base = config.resolvePreset("default");
  const preset = new ModelPresetConfig({
    ...(existing?.toObject() ?? {}),
    endpoint: endpointId,
    model,
    provider,
    source: "byok",
    capabilities,
    maxTokens: base.maxTokens,
    contextWindowTokens: base.contextWindowTokens,
    temperature: base.temperature,
    reasoningEffort: base.reasoningEffort,
  });
  config.modelPresets[presetId] = preset;
  if (capabilities.includes("agent")) {
    const candidates = config.modelAssignments.byok.agent.candidates;
    if (!candidates.includes(presetId)) candidates.push(presetId);
    config.modelAssignments.byok.agent.default = presetId;
    config.agents.defaults.modelPreset = presetId;
  }
  saveConfig(config);
  return settingsPayload();
}
export function updateProviderSettings(config: Config, provider: string, settings: Partial<ProviderConfig>): Config;
export function updateProviderSettings(query: QueryParams): Record<string, any>;
export function updateProviderSettings(
  queryOrConfig: QueryParams | Config,
  provider?: string,
  settings: Partial<ProviderConfig> = {},
): Record<string, any> | Config {
  if (queryOrConfig instanceof Config) {
    if (!provider || !(provider in queryOrConfig.providers)) throw new WebUISettingsError(`Unknown provider: ${provider}`);
    Object.assign((queryOrConfig.providers as any)[provider], settings);
    return queryOrConfig;
  }

  const query = queryOrConfig;
  const providerName = (queryFirst(query, "provider") ?? "").trim();
  if (!providerName) throw new WebUISettingsError("provider is required");
  const spec = findByName(providerName);
  if (!spec || spec.isOauth) throw new WebUISettingsError("unknown provider");

  const config = loadConfig();
  const providerConfig = (config.providers as any)[spec.name];
  if (!providerConfig) throw new WebUISettingsError("unknown provider");

  let changed = false;
  if (hasQuery(query, "api_key", "apiKey")) {
    const apiKey = (queryFirstAlias(query, "api_key", "apiKey") ?? "").trim();
    if (apiKey && setConfigValue(providerConfig, "apiKey", apiKey)) changed = true;
  }
  if (hasQuery(query, "api_base", "apiBase")) {
    const apiBase = (queryFirstAlias(query, "api_base", "apiBase") ?? "").trim() || null;
    const endpointId = (queryFirstAlias(query, "endpoint_id", "endpointId") ?? "").trim();
    if (!endpointId) throw new WebUISettingsError("endpoint_id is required");
    const existing = providerConfig.endpoints[endpointId];
    const protocol = (queryFirst(query, "protocol") ?? existing?.protocol ?? "").trim();
    if (!apiBase || !protocol) throw new WebUISettingsError("endpoint api_base and protocol are required");
    const endpoint = new ModelEndpointConfig({ ...(existing?.toObject() ?? {}), apiBase, protocol });
    providerConfig.endpoints[endpointId] = endpoint;
    changed = true;
  }
  if (hasQuery(query, "api_type")) throw new WebUISettingsError("api_type moved to endpoint protocol");

  if (changed) saveConfig(config);
  return settingsPayload({ requiresRestart: false });
}
export function updateWebSearchSettings(query: QueryParams): Record<string, any> {
  const providerName = (queryFirst(query, "provider") ?? "").trim().toLowerCase();
  const providerOption = WEB_SEARCH_PROVIDER_BY_NAME.get(providerName);
  if (!providerOption) throw new WebUISettingsError("unknown web search provider");

  const config = loadConfig();
  const searchConfig = config.tools.webSearch;
  const fetchConfig = config.tools.webFetch;
  const previousProvider = searchConfig.provider;
  let changed = false;
  let restartRequired = false;

  const setSearchValue = (key: string, value: any): void => {
    if (setConfigValue(searchConfig, key, value)) changed = true;
  };
  const setFetchValue = (key: string, value: any): void => {
    if (setConfigValue(fetchConfig, key, value)) changed = true;
  };

  if (searchConfig.provider !== providerName) {
    searchConfig.provider = providerName;
    changed = true;
  }

  if (providerOption.credential === "none") {
    setSearchValue("apiKey", "");
    setSearchValue("baseUrl", "");
  } else if (providerOption.credential === "base_url") {
    let baseUrl = queryFirstAlias(query, "base_url", "baseUrl")?.trim() ?? null;
    if (!baseUrl && previousProvider === providerName && searchConfig.baseUrl) {
      baseUrl = searchConfig.baseUrl;
    }
    if (!baseUrl) throw new WebUISettingsError("base_url is required");
    setSearchValue("baseUrl", baseUrl);
    setSearchValue("apiKey", "");
  } else {
    let apiKey = queryFirstAlias(query, "api_key", "apiKey")?.trim() ?? null;
    if (!apiKey && previousProvider === providerName && searchConfig.apiKey) {
      apiKey = searchConfig.apiKey;
    }
    if (!apiKey) throw new WebUISettingsError("api_key is required");
    setSearchValue("apiKey", apiKey);
    setSearchValue("baseUrl", "");
  }

  const maxResults = queryFirstAlias(query, "max_results", "maxResults");
  if (maxResults !== null) {
    const parsed = Number.parseInt(maxResults, 10);
    if (!Number.isInteger(parsed)) throw new WebUISettingsError("max_results must be an integer");
    if (parsed < 1 || parsed > 10) throw new WebUISettingsError("max_results must be between 1 and 10");
    setSearchValue("maxResults", parsed);
  }

  const timeout = queryFirst(query, "timeout");
  if (timeout !== null) {
    const parsed = Number.parseInt(timeout, 10);
    if (!Number.isInteger(parsed)) throw new WebUISettingsError("timeout must be an integer");
    if (parsed < 1 || parsed > 120) throw new WebUISettingsError("timeout must be between 1 and 120");
    if (searchConfig.timeout !== parsed) {
      searchConfig.timeout = parsed;
      changed = true;
    }
  }

  const useJinaReader = queryFirstAlias(query, "use_jina_reader", "useJinaReader");
  if (useJinaReader !== null) {
    const previous = fetchConfig.useJinaReader;
    const parsed = parseBool(useJinaReader, "use_jina_reader");
    setFetchValue("useJinaReader", parsed);
    if (previous !== parsed) restartRequired = true;
  }

  if (changed) saveConfig(config);
  return settingsPayload({ requiresRestart: restartRequired });
}

export function updateImageGenerationSettings(query: QueryParams): Record<string, any> {
  assertKnownFields(query, IMAGE_GENERATION_UPDATE_FIELDS);
  const config = loadConfig();
  const imageConfig = config.tools.imageGeneration;
  let changed = false;
  const catalogFieldsTouched =
    hasQuery(query, "provider") ||
    hasQuery(query, "model") ||
    hasQuery(query, "api_key", "apiKey") ||
    hasQuery(query, "api_base", "apiBase") ||
    hasQuery(query, "extra_headers", "extraHeaders") ||
    hasQuery(query, "extra_body", "extraBody");
  if (catalogFieldsTouched) {
    throw new WebUISettingsError("image generation model settings moved to the model catalog");
  }

  const enabled = queryFirst(query, "enabled");
  if (enabled !== null) {
    const value = parseBool(enabled, "enabled");
    if (imageConfig.enabled !== value) {
      imageConfig.enabled = value;
      changed = true;
    }
  }

  const aspectRatio = queryFirstAlias(query, "default_aspect_ratio", "defaultAspectRatio");
  if (aspectRatio !== null) {
    const value = aspectRatio.trim();
    if (!IMAGE_GENERATION_ASPECT_RATIOS.has(value)) throw new WebUISettingsError("unsupported image generation aspect ratio");
    if (setConfigValue(imageConfig, "defaultAspectRatio", value)) changed = true;
  }

  const imageSize = queryFirstAlias(query, "default_image_size", "defaultImageSize");
  if (imageSize !== null) {
    const value = imageSize.trim();
    if (!value) throw new WebUISettingsError("default image size is required");
    if (value.length > 32 || !/^[A-Za-z0-9xX:_-]+$/.test(value)) {
      throw new WebUISettingsError("unsupported image generation size");
    }
    if (setConfigValue(imageConfig, "defaultImageSize", value)) changed = true;
  }

  const maxImages = queryFirstAlias(query, "max_images_per_turn", "maxImagesPerTurn");
  if (maxImages !== null) {
    const value = maxImages.trim();
    const parsed = value === "null" ? null : /^\d+$/.test(value) ? Number(value) : Number.NaN;
    if (!isValidImageGenerationMaxImagesPerTurn(parsed)) {
      throw new WebUISettingsError(
        "max_images_per_turn must be null or a safe integer >= 1",
      );
    }
    if (setConfigValue(imageConfig, "maxImagesPerTurn", parsed)) changed = true;
  }

  const saveDir = queryFirstAlias(query, "save_dir", "saveDir");
  if (saveDir !== null) {
    const value = saveDir.trim();
    if (!value) throw new WebUISettingsError("save_dir is required");
    if (value.split(/[\\/]+/).some((part) => !part || part === "." || part === "..")) {
      throw new WebUISettingsError("save_dir must be a safe relative path");
    }
    if (setConfigValue(imageConfig, "saveDir", value)) changed = true;
  }

  if (imageConfig.enabled && !assignedImagePreset(config).preset) {
    throw new WebUISettingsError("image generation model is not assigned");
  }

  if (changed) saveConfig(config);
  return settingsPayload({ requiresRestart: changed });
}
