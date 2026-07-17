import { loadConfig, saveConfig, getConfigPath } from "../../config/loader.js";
import {
  Config,
  ImageGenerationProfileConfig,
  ModelPresetConfig,
  ProviderConfig,
  isValidImageGenerationMaxImagesPerTurn,
} from "../../config/schema.js";
import {
  getImageGenProvider,
  imageGenProviderConfigured,
  imageGenProviderDefaultBase,
  imageGenProviderLabel,
  imageGenProviderNames,
} from "../../providers/image-generation.js";
import { findByName, PROVIDERS } from "../../providers/registry.js";

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
const MODEL_CONFIGURATION_SLUG_RE = /[^a-z0-9_-]+/g;

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
  if (providerRequiresApiKey(spec)) return Boolean(providerConfig?.apiKey);
  return Boolean(
    providerConfig?.apiKey
    ?? providerConfig?.apiBase
    ?? providerConfig?.region
    ?? providerConfig?.profile
  );
}

function modelConfigurationSlug(label: string): string {
  let normalized = label.trim().toLowerCase().replace(MODEL_CONFIGURATION_SLUG_RE, "-").replace(/^[-_]+|[-_]+$/g, "");
  if (!normalized) throw new WebUISettingsError("configuration name is required");
  if (normalized === "default") throw new WebUISettingsError("configuration name is reserved");
  if (normalized.length > 48) normalized = normalized.slice(0, 48).replace(/[-_]+$/g, "");
  return normalized;
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

function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
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

function imageGenerationProviderRows(config: Config): Record<string, any>[] {
  const imageConfig = config.tools.imageGeneration;
  const effectiveConfig = imageConfig.effectiveImageGenerationConfig();
  return imageGenProviderNames().map((name) => {
    return {
      name,
      label: imageGenProviderLabel(name),
      implemented: true,
      configured: name === effectiveConfig.provider ? imageGenProviderConfigured(name, effectiveConfig as any) : false,
      default_api_base: imageGenProviderDefaultBase(name),
    };
  });
}

function assertKnownFields(query: QueryParams, allowed: Set<string>): void {
  const unknown = Object.keys(query).filter((key) => !allowed.has(key));
  if (unknown.length) throw new WebUISettingsError(`unknown image generation setting: ${unknown[0]}`);
}

function parseJsonObject(value: string, field: string): Record<string, any> {
  if (!value.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new WebUISettingsError(`${field} must be a JSON object`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WebUISettingsError(`${field} must be a JSON object`);
  }
  return parsed as Record<string, any>;
}

function parseStringRecord(value: string, field: string): Record<string, string> {
  const parsed = parseJsonObject(value, field);
  for (const [key, item] of Object.entries(parsed)) {
    if (typeof item !== "string") throw new WebUISettingsError(`${field}.${key} must be a string`);
  }
  return parsed as Record<string, string>;
}

export function settingsPayload({ requiresRestart = false }: { requiresRestart?: boolean } = {}): Record<string, any> {
  const config = loadConfig();
  const defaults = config.agents.defaults;
  let activePresetName = defaults.modelPreset ?? "default";
  let effectivePreset: ModelPresetConfig;
  try {
    effectivePreset = config.resolvePreset();
  } catch {
    effectivePreset = config.resolvePreset("default");
    activePresetName = "default";
  }
  const providerName = config.getProviderName(effectivePreset.model, { preset: effectivePreset }) ?? effectivePreset.provider;
  const provider = config.getProvider(effectivePreset.model, { preset: effectivePreset });
  const selectedProvider = effectivePreset.provider === "auto" ? providerName : findByName(effectivePreset.provider)?.name ?? providerName;

  const modelPresets = [
    {
      name: "default",
      label: "Default",
      active: activePresetName === "default",
      is_default: true,
      model: defaults.model,
      provider: defaults.provider,
      max_tokens: defaults.maxTokens,
      context_window_tokens: defaults.contextWindowTokens,
      temperature: defaults.temperature,
      reasoning_effort: defaults.reasoningEffort,
    },
    ...Object.entries(config.modelPresets).map(([name, preset]) => ({
      name,
      label: preset.label ?? name,
      active: activePresetName === name,
      is_default: false,
      model: preset.model,
      provider: preset.provider,
      max_tokens: preset.maxTokens,
      context_window_tokens: preset.contextWindowTokens,
      temperature: preset.temperature,
      reasoning_effort: preset.reasoningEffort,
    })),
  ];

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
        api_base: providerConfig.apiBase,
        default_api_base: spec.defaultApiBase || null,
        ...(spec.name === "openai" ? { api_type: providerConfig.apiType } : {}),
      };
    })
    .filter(Boolean);

  const searchConfig = config.tools.webSearch;
  const fetchConfig = config.tools.webFetch;
  const imageConfig = config.tools.imageGeneration;
  const effectiveImageConfig = imageConfig.effectiveImageGenerationConfig();
  const searchProvider = WEB_SEARCH_PROVIDER_BY_NAME.has(searchConfig.provider) ? searchConfig.provider : "duckduckgo";
  const imageProviders = imageGenerationProviderRows(config);

  return {
    agent: {
      model: effectivePreset.model,
      provider: selectedProvider,
      resolved_provider: providerName,
      has_api_key: Boolean(provider?.apiKey),
      model_preset: activePresetName,
      max_tokens: effectivePreset.maxTokens,
      context_window_tokens: effectivePreset.contextWindowTokens,
      temperature: effectivePreset.temperature,
      reasoning_effort: effectivePreset.reasoningEffort,
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
      active_profile: imageConfig.activeProfile,
      provider: effectiveImageConfig.provider,
      provider_configured: imageGenProviderConfigured(effectiveImageConfig.provider, effectiveImageConfig as any),
      model: effectiveImageConfig.model,
      api_key_hint: maskSecretHint(effectiveImageConfig.apiKey),
      api_base: effectiveImageConfig.apiBase || null,
      default_aspect_ratio: imageConfig.defaultAspectRatio,
      default_image_size: imageConfig.defaultImageSize,
      max_images_per_turn: imageConfig.maxImagesPerTurn,
      save_dir: imageConfig.saveDir,
      extra_headers: effectiveImageConfig.extraHeaders,
      extra_body: effectiveImageConfig.extraBody,
      providers: imageProviders,
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
    validateTimezone(value);
    if (defaults.timezone !== value) {
      defaults.timezone = value;
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
  let label = (queryFirstAlias(query, "label", "displayName") ?? "").trim();
  const rawName = (queryFirst(query, "name") ?? label).trim();
  const model = (queryFirst(query, "model") ?? "").trim();
  const provider = (queryFirst(query, "provider") ?? "").trim();

  if (!label) label = rawName;
  if (!model) throw new WebUISettingsError("model is required");
  if (!provider) throw new WebUISettingsError("provider is required");

  const name = modelConfigurationSlug(rawName || label);
  const config = loadConfig();
  if (name in config.modelPresets) throw new WebUISettingsError("configuration already exists", { status: 409 });
  validateConfiguredProvider(config, provider);

  const base = config.resolvePreset("default");
  const preset = new ModelPresetConfig({
    label,
    model,
    provider,
    maxTokens: base.maxTokens,
    contextWindowTokens: base.contextWindowTokens,
    temperature: base.temperature,
    reasoningEffort: base.reasoningEffort,
  });
  config.modelPresets[name] = preset;
  config.agents.defaults.modelPreset = name;
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
    const apiKey = (queryFirstAlias(query, "api_key", "apiKey") ?? "").trim() || null;
    if (setConfigValue(providerConfig, "apiKey", apiKey)) changed = true;
  }
  if (hasQuery(query, "api_base", "apiBase")) {
    const apiBase = (queryFirstAlias(query, "api_base", "apiBase") ?? "").trim() || null;
    if (setConfigValue(providerConfig, "apiBase", apiBase)) changed = true;
  }
  if (hasQuery(query, "api_type")) {
    if (spec.name === "openai") {
      const apiType = (queryFirst(query, "api_type") ?? "").trim();
      let parsed: ProviderConfig["apiType"];
      try {
        parsed = new ProviderConfig({ apiType }).apiType;
      } catch {
        throw new WebUISettingsError("api_type must be auto, chatCompletions, or responses");
      }
      if (setConfigValue(providerConfig, "apiType", parsed)) changed = true;
    }
  }

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
  const activeProfile = imageConfig.activeProfile;
  const profileFieldsTouched =
    hasQuery(query, "provider") ||
    hasQuery(query, "model") ||
    hasQuery(query, "api_key", "apiKey") ||
    hasQuery(query, "api_base", "apiBase") ||
    hasQuery(query, "extra_headers", "extraHeaders") ||
    hasQuery(query, "extra_body", "extraBody");
  if (activeProfile === "account" && profileFieldsTouched) {
    throw new WebUISettingsError("account image profile is managed by account login");
  }
  const profileTarget =
    activeProfile === "byok"
      ? new ImageGenerationProfileConfig(imageConfig.profiles.byok?.toObject() ?? {})
      : null;

  const setImageConfigValue = (key: string, value: any): void => {
    if (profileTarget) {
      if (setConfigValue(profileTarget, key, value)) changed = true;
      return;
    }
    if (setConfigValue(imageConfig, key, value)) changed = true;
  };

  const providerName = queryFirst(query, "provider");
  if (providerName !== null) {
    const value = providerName.trim().toLowerCase();
    if (!value) throw new WebUISettingsError("image generation provider is required");
    if (getImageGenProvider(value) === null) throw new WebUISettingsError("unknown image generation provider");
    setImageConfigValue("provider", value);
  }

  const enabled = queryFirst(query, "enabled");
  if (enabled !== null) {
    const value = parseBool(enabled, "enabled");
    if (imageConfig.enabled !== value) {
      imageConfig.enabled = value;
      changed = true;
    }
  }

  const model = queryFirst(query, "model");
  if (model !== null) {
    const value = model.trim();
    if (!value) throw new WebUISettingsError("image generation model is required");
    if (value.length > 200) throw new WebUISettingsError("image generation model is too long");
    setImageConfigValue("model", value);
  }

  if (hasQuery(query, "api_key", "apiKey")) {
    const value = (queryFirstAlias(query, "api_key", "apiKey") ?? "").trim();
    setImageConfigValue("apiKey", value);
  }

  if (hasQuery(query, "api_base", "apiBase")) {
    const value = (queryFirstAlias(query, "api_base", "apiBase") ?? "").trim();
    setImageConfigValue("apiBase", value);
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

  const extraHeaders = queryFirstAlias(query, "extra_headers", "extraHeaders");
  if (extraHeaders !== null) {
    setImageConfigValue("extraHeaders", parseStringRecord(extraHeaders, "extra_headers"));
  }

  const extraBody = queryFirstAlias(query, "extra_body", "extraBody");
  if (extraBody !== null) {
    setImageConfigValue("extraBody", parseJsonObject(extraBody, "extra_body"));
  }

  if (profileTarget) {
    imageConfig.profiles.byok = profileTarget;
    imageConfig.profileMode = true;
  }

  if (imageConfig.enabled) {
    const effectiveConfig = imageConfig.effectiveImageGenerationConfig();
    if (!imageConfig.hasCompleteEffectiveProfile() || !imageGenProviderConfigured(effectiveConfig.provider, effectiveConfig as any)) {
      throw new WebUISettingsError("image generation provider is not configured");
    }
  }

  if (changed) saveConfig(config);
  return settingsPayload({ requiresRestart: changed });
}
