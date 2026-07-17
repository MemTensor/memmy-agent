import { CronSchedule } from "../cron/types.js";
import { PROVIDERS, findByName, normalizeProviderName } from "../providers/registry.js";

type Dict<T = any> = Record<string, T>;
type MemoryProfileName = "account" | "byok";
type ImageGenerationProfileName = "account" | "byok";
export type ContextCompactionSummaryMode = "text" | "dag";
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
const IMAGE_GENERATION_PROVIDERS = new Set([
  "openai",
  "custom",
  "azure_openai",
  "bedrock",
  "openrouter",
  "aihubmix",
  "ollama",
  "gemini",
  "minimax",
  "stepfun",
  "zhipu",
  "openai_codex",
  "volcengine",
  "byteplus",
  "dashscope",
  "qianfan",
  "nvidia",
  "memmy_account",
]);

function isRecord(value: any): value is Dict {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function pick<T>(data: Dict, names: string[], fallback: T): T {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(data, name)) return data[name] as T;
  }
  return fallback;
}

function omitUndefined(data: Dict): Dict {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}

function optionalString(value: any): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function memoryProfileName(value: any): MemoryProfileName | undefined {
  return value === "account" || value === "byok" ? value : undefined;
}

function imageGenerationProfileName(value: any): ImageGenerationProfileName | null {
  return value === "account" || value === "byok" ? value : null;
}

function pickMemoryProfiles(value: any): Dict | undefined {
  if (!isRecord(value)) return undefined;

  const profiles = Object.fromEntries(
    (["account", "byok"] as const)
      .filter((name) => isRecord(value[name]))
      .map((name) => [name, { ...value[name] }]),
  );
  return Object.keys(profiles).length > 0 ? profiles : undefined;
}

function assertIntRange(field: string, value: any, min?: number, max?: number): number {
  if (!Number.isInteger(value)) throw new ValueError(`${field} must be an integer`);
  if (min != null && max != null && (value < min || value > max)) {
    throw new ValueError(`${field} must be between ${min} and ${max}`);
  }
  if (min != null && value < min) throw new ValueError(`${field} must be >= ${min}`);
  if (max != null && value > max) throw new ValueError(`${field} must be <= ${max}`);
  return value;
}

function assertNumberRange(field: string, value: any, min?: number, max?: number): number {
  if (typeof value !== "number" || Number.isNaN(value))
    throw new ValueError(`${field} must be a number`);
  if (min != null && max != null && (value < min || value > max)) {
    throw new ValueError(`${field} must be between ${min} and ${max}`);
  }
  if (min != null && value < min) throw new ValueError(`${field} must be >= ${min}`);
  if (max != null && value > max) throw new ValueError(`${field} must be <= ${max}`);
  return value;
}

function assertOneOf<T extends readonly string[]>(
  field: string,
  value: any,
  choices: T,
): T[number] {
  if (!choices.includes(value))
    throw new ValueError(`${field} must be one of ${choices.join(", ")}`);
  return value as T[number];
}

function assertRequiredString(field: string, value: any): string {
  if (typeof value !== "string" || !value.trim())
    throw new ValueError(`${field} must be a non-empty string`);
  return value;
}

function assertStringArray(field: string, value: any): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ValueError(`${field} must be an array of strings`);
  }
  return value;
}

function assertPlainObject(field: string, value: any): Dict {
  if (!isRecord(value)) throw new ValueError(`${field} must be an object`);
  return value;
}

function assertStringRecord(field: string, value: any): Dict<string> {
  const record = assertPlainObject(field, value);
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== "string") throw new ValueError(`${field}.${key} must be a string`);
  }
  return record as Dict<string>;
}

function assertBoolean(field: string, value: any): boolean {
  if (typeof value !== "boolean") throw new ValueError(`${field} must be a boolean`);
  return value;
}

function assertIntArrayRange(field: string, value: any, min?: number, max?: number): number[] {
  if (!Array.isArray(value) || !value.length) throw new ValueError(`${field} must be a non-empty array of integers`);
  return value.map((item, idx) => assertIntRange(`${field}[${idx}]`, item, min, max));
}

function normalizedKeyMap(data: Dict): Map<string, any> {
  return new Map(Object.entries(data).map(([key, value]) => [normalizeProviderName(key), value]));
}

type ProviderApiType = "auto" | "chatCompletions" | "responses";

function normalizeProviderApiType(value: any): ProviderApiType {
  const apiType = value ?? "auto";
  if (apiType === "chat_completions" || apiType === "chat-completions") return "chatCompletions";
  if (apiType === "auto" || apiType === "chatCompletions" || apiType === "responses")
    return apiType;
  throw new ValueError("apiType must be one of auto, chatCompletions, responses");
}

export class Base {
  constructor(init: Dict = {}) {
    Object.assign(this, init);
  }

  static fromObject<T extends typeof Base>(this: T, data: Dict = {}): InstanceType<T> {
    return new this(data) as InstanceType<T>;
  }

  toObject(): Dict {
    return omitUndefined({ ...this });
  }
}

export class ChannelsConfig extends Base {
  modelExtra: Dict;
  sendProgress = true;
  sendToolHints = false;
  showReasoning = true;
  sendMaxRetries = 3;
  transcriptionProvider = "groq";
  transcriptionLanguage: string | null = null;

  constructor(init: Dict = {}) {
    super();
    const known = new Set([
      "sendProgress",
      "sendToolHints",
      "showReasoning",
      "sendMaxRetries",
      "transcriptionProvider",
      "transcriptionLanguage",
    ]);
    this.modelExtra = Object.fromEntries(Object.entries(init).filter(([key]) => !known.has(key)));
    this.sendProgress = pick(init, ["sendProgress"], true);
    this.sendToolHints = pick(init, ["sendToolHints"], false);
    this.showReasoning = pick(init, ["showReasoning"], true);
    this.sendMaxRetries = pick(init, ["sendMaxRetries"], 3);
    this.transcriptionProvider = pick(init, ["transcriptionProvider"], "groq");
    this.transcriptionLanguage = pick(init, ["transcriptionLanguage"], null);
    if (this.sendMaxRetries < 0 || this.sendMaxRetries > 10)
      throw new ValueError("sendMaxRetries must be between 0 and 10");
    if (this.transcriptionLanguage != null && !/^[a-z]{2,3}$/.test(this.transcriptionLanguage)) {
      throw new ValueError("transcriptionLanguage must be 2-3 lowercase ISO-639 letters");
    }
    Object.assign(this, this.modelExtra);
  }
}

export class DreamConfig extends Base {
  static HOUR_MS = 3_600_000;
  intervalH = 2;
  cron: string | null = null;
  modelOverride: string | null = null;
  maxBatchSize = 20;
  maxIterations = 15;
  annotateLineAges = true;

  constructor(init: Dict = {}) {
    super();
    this.intervalH = pick(init, ["intervalH"], 2);
    this.cron = pick(init, ["cron"], null);
    this.modelOverride = pick(init, ["modelOverride"], null);
    this.maxBatchSize = pick(init, ["maxBatchSize"], 20);
    this.maxIterations = pick(init, ["maxIterations"], 15);
    this.annotateLineAges = pick(init, ["annotateLineAges"], true);
    assertIntRange("intervalH", this.intervalH, 1);
    assertIntRange("maxBatchSize", this.maxBatchSize, 1);
    assertIntRange("maxIterations", this.maxIterations, 1);
  }

  buildSchedule(timezone: string): CronSchedule {
    if (this.cron) return new CronSchedule({ kind: "cron", expr: this.cron, tz: timezone });
    return new CronSchedule({ kind: "every", everyMs: this.intervalH * DreamConfig.HOUR_MS });
  }

  describeSchedule(): string {
    return this.cron ? `cron ${this.cron} (legacy)` : `every ${this.intervalH}h`;
  }

  override toObject(): Dict {
    return {
      intervalH: this.intervalH,
      modelOverride: this.modelOverride,
      maxBatchSize: this.maxBatchSize,
      maxIterations: this.maxIterations,
      annotateLineAges: this.annotateLineAges,
    };
  }
}

export class InlineFallbackConfig extends Base {
  model: string;
  provider: string;
  maxTokens: number | null;
  contextWindowTokens: number | null;
  temperature: number | null;
  reasoningEffort: string | null;

  constructor(init: Dict) {
    super();
    this.model = init.model;
    this.provider = init.provider;
    this.maxTokens = pick(init, ["maxTokens"], null);
    this.contextWindowTokens = pick(init, ["contextWindowTokens"], null);
    this.temperature = pick(init, ["temperature"], null);
    this.reasoningEffort = pick(init, ["reasoningEffort"], null);
    assertRequiredString("fallback model", this.model);
    assertRequiredString("fallback provider", this.provider);
  }
}

export type FallbackCandidate = string | InlineFallbackConfig;

export class ModelPresetConfig extends Base {
  label: string | null;
  model: string;
  provider = "auto";
  maxTokens = 8192;
  contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS;
  temperature = 0.7;
  reasoningEffort: string | null = null;

  constructor(init: Dict) {
    super();
    this.label = pick(init, ["label"], null);
    this.model = init.model;
    this.provider = pick(init, ["provider"], "auto");
    this.maxTokens = pick(init, ["maxTokens"], 8192);
    this.contextWindowTokens = pick(init, ["contextWindowTokens"], DEFAULT_CONTEXT_WINDOW_TOKENS);
    this.temperature = pick(init, ["temperature"], 0.7);
    this.reasoningEffort = pick(init, ["reasoningEffort"], null);
    assertRequiredString("modelPreset model", this.model);
  }

  toGenerationSettings(): any {
    return {
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      reasoningEffort: this.reasoningEffort,
    };
  }
}

export class AgentDefaults extends Base {
  workspace = "~/.memmy/workspace";
  modelPreset: string | null = null;
  model = "anthropic/claude-opus-4-5";
  provider = "auto";
  maxTokens = 8192;
  contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS;
  contextBlockLimit: number | null = null;
  temperature = 0.7;
  fallbackModels: FallbackCandidate[] = [];
  maxToolIterations = 200;
  maxConcurrentSubagents = 1;
  maxToolResultChars = 16_000;
  providerRetryMode = "standard";
  toolHintMaxLength = 40;
  reasoningEffort: string | null = null;
  timezone = "UTC";
  botName = "memmy";
  botIcon = "🍚";
  unifiedSession = false;
  disabledSkills: string[] = [];
  sessionTtlMinutes = 0;
  maxMessages = 120;
  consolidationRatio = 0.5;
  dream: DreamConfig;

  constructor(init: Dict = {}) {
    super();
    this.workspace = pick(init, ["workspace"], this.workspace);
    this.modelPreset = pick(init, ["modelPreset"], null);
    this.model = pick(init, ["model"], this.model);
    this.provider = pick(init, ["provider"], this.provider);
    this.maxTokens = pick(init, ["maxTokens"], this.maxTokens);
    this.contextWindowTokens = pick(init, ["contextWindowTokens"], this.contextWindowTokens);
    this.contextBlockLimit = pick(init, ["contextBlockLimit"], null);
    this.temperature = pick(init, ["temperature"], this.temperature);
    this.fallbackModels = pick(init, ["fallbackModels"], []).map((fallback: any) =>
      typeof fallback === "string" || fallback instanceof InlineFallbackConfig
        ? fallback
        : new InlineFallbackConfig(fallback),
    );
    this.maxToolIterations = pick(init, ["maxToolIterations"], this.maxToolIterations);
    this.maxConcurrentSubagents = pick(
      init,
      ["maxConcurrentSubagents"],
      this.maxConcurrentSubagents,
    );
    this.maxToolResultChars = pick(init, ["maxToolResultChars"], this.maxToolResultChars);
    this.providerRetryMode = pick(init, ["providerRetryMode"], this.providerRetryMode);
    this.toolHintMaxLength = pick(init, ["toolHintMaxLength"], this.toolHintMaxLength);
    this.reasoningEffort = pick(init, ["reasoningEffort"], null);
    this.timezone = pick(init, ["timezone"], this.timezone);
    this.botName = pick(init, ["botName"], this.botName);
    this.botIcon = pick(init, ["botIcon"], this.botIcon);
    this.unifiedSession = pick(init, ["unifiedSession"], false);
    this.disabledSkills = assertStringArray("disabledSkills", pick(init, ["disabledSkills"], []));
    this.sessionTtlMinutes = pick(init, ["idleCompactAfterMinutes", "sessionTtlMinutes"], 0);
    this.maxMessages = pick(init, ["maxMessages"], 120);
    assertIntRange("maxMessages", this.maxMessages, 0);
    this.consolidationRatio = pick(init, ["consolidationRatio"], 0.5);
    assertIntRange("maxConcurrentSubagents", this.maxConcurrentSubagents, 1);
    this.providerRetryMode = assertOneOf("providerRetryMode", this.providerRetryMode, [
      "standard",
      "persistent",
    ] as const);
    assertIntRange("toolHintMaxLength", this.toolHintMaxLength, 20, 500);
    assertIntRange("sessionTtlMinutes", this.sessionTtlMinutes, 0);
    assertNumberRange("consolidationRatio", this.consolidationRatio, 0.1, 0.95);
    this.dream = init.dream instanceof DreamConfig ? init.dream : new DreamConfig(init.dream ?? {});
  }

  override toObject(): Dict {
    return {
      workspace: this.workspace,
      modelPreset: this.modelPreset,
      model: this.model,
      provider: this.provider,
      maxTokens: this.maxTokens,
      contextWindowTokens: this.contextWindowTokens,
      contextBlockLimit: this.contextBlockLimit,
      temperature: this.temperature,
      fallbackModels: this.fallbackModels,
      maxToolIterations: this.maxToolIterations,
      maxConcurrentSubagents: this.maxConcurrentSubagents,
      maxToolResultChars: this.maxToolResultChars,
      providerRetryMode: this.providerRetryMode,
      toolHintMaxLength: this.toolHintMaxLength,
      reasoningEffort: this.reasoningEffort,
      timezone: this.timezone,
      botName: this.botName,
      botIcon: this.botIcon,
      unifiedSession: this.unifiedSession,
      disabledSkills: this.disabledSkills,
      idleCompactAfterMinutes: this.sessionTtlMinutes,
      maxMessages: this.maxMessages,
      consolidationRatio: this.consolidationRatio,
      dream: this.dream.toObject(),
    };
  }
}

export class AgentsConfig extends Base {
  defaults: AgentDefaults;
  constructor(init: Dict = {}) {
    super();
    this.defaults =
      init.defaults instanceof AgentDefaults
        ? init.defaults
        : new AgentDefaults(init.defaults ?? {});
  }

  override toObject(): Dict {
    return { defaults: this.defaults.toObject() };
  }
}

export class SessionDagConfig extends Base {
  enabled = true;
  debugLog = true;
  maxBuilderContextNodes = 40;
  maxUpdateAttempts = 5;
  retryBackoffMs = [1000, 5000, 30000, 60000, 90000];
  maxConcurrentSessionQueues = 4;
  compactionCatchupTimeoutMs = 120_000;

  constructor(init: Dict = {}) {
    super();
    this.enabled = assertBoolean("sessionDag.enabled", pick(init, ["enabled"], this.enabled));
    this.debugLog = assertBoolean("sessionDag.debugLog", pick(init, ["debugLog"], this.debugLog));
    this.maxBuilderContextNodes = assertIntRange(
      "sessionDag.maxBuilderContextNodes",
      pick(init, ["maxBuilderContextNodes"], this.maxBuilderContextNodes),
      1,
      200,
    );
    this.maxUpdateAttempts = assertIntRange(
      "sessionDag.maxUpdateAttempts",
      pick(init, ["maxUpdateAttempts"], this.maxUpdateAttempts),
      1,
      20,
    );
    this.retryBackoffMs = assertIntArrayRange(
      "sessionDag.retryBackoffMs",
      pick(init, ["retryBackoffMs"], this.retryBackoffMs),
      1000,
      600_000,
    );
    this.maxConcurrentSessionQueues = assertIntRange(
      "sessionDag.maxConcurrentSessionQueues",
      pick(init, ["maxConcurrentSessionQueues"], this.maxConcurrentSessionQueues),
      1,
      16,
    );
    this.compactionCatchupTimeoutMs = assertIntRange(
      "sessionDag.compactionCatchupTimeoutMs",
      pick(init, ["compactionCatchupTimeoutMs"], this.compactionCatchupTimeoutMs),
      1000,
      600_000,
    );
  }

  override toObject(): Dict {
    return {
      enabled: this.enabled,
      debugLog: this.debugLog,
      maxBuilderContextNodes: this.maxBuilderContextNodes,
      maxUpdateAttempts: this.maxUpdateAttempts,
      retryBackoffMs: this.retryBackoffMs,
      maxConcurrentSessionQueues: this.maxConcurrentSessionQueues,
      compactionCatchupTimeoutMs: this.compactionCatchupTimeoutMs,
    };
  }
}

export class ContextCompactionConfig extends Base {
  summaryMode: ContextCompactionSummaryMode = "dag";

  constructor(init: Dict = {}) {
    super();
    this.summaryMode = assertOneOf(
      "contextCompaction.summaryMode",
      pick(init, ["summaryMode"], this.summaryMode),
      ["text", "dag"] as const,
    );
  }

  override toObject(): Dict {
    return {
      summaryMode: this.summaryMode,
    };
  }
}

export class ProviderConfig extends Base {
  apiKey: string | null;
  apiBase: string | null;
  apiType: ProviderApiType;
  extraHeaders: Dict<string> | null;
  extraBody: Dict | null;

  constructor(init: Dict = {}) {
    super();
    this.apiKey = pick(init, ["apiKey", "api_key"], null);
    this.apiBase = pick(init, ["apiBase", "api_base"], null);
    this.apiType = normalizeProviderApiType(pick(init, ["apiType", "api_type"], "auto"));
    this.extraHeaders = pick(init, ["extraHeaders", "extra_headers"], null);
    this.extraBody = pick(init, ["extraBody", "extra_body"], null);
  }
}

export class ValueError extends Error {}

export class BedrockProviderConfig extends ProviderConfig {
  region: string | null;
  profile: string | null;
  constructor(init: Dict = {}) {
    super(init);
    this.region = pick(init, ["region"], null);
    this.profile = pick(init, ["profile"], null);
  }
}

export class ProvidersConfig extends Base {
  [key: string]: any;
  constructor(init: Dict = {}) {
    super();
    const byNormalizedKey = normalizedKeyMap(init);
    for (const { name } of PROVIDERS) {
      const cls = name === "bedrock" ? BedrockProviderConfig : ProviderConfig;
      const raw = byNormalizedKey.get(name) ?? {};
      this[name] = raw instanceof cls ? raw : new cls(raw);
    }
  }

  override toObject(): Dict {
    const dump: Dict = {};
    for (const spec of PROVIDERS) {
      if (spec.isOauth) continue;
      const value = this[spec.name];
      if (value && typeof value.toObject === "function") dump[spec.name] = value.toObject();
      else dump[spec.name] = value;
    }
    return dump;
  }
}

export class WebSearchConfig extends Base {
  provider = "duckduckgo";
  apiKey = "";
  baseUrl = "";
  maxResults = 5;
  timeout = 30;
  constructor(init: Dict = {}) {
    super();
    this.provider = pick(init, ["provider"], this.provider);
    this.apiKey = pick(init, ["apiKey"], "");
    this.baseUrl = pick(init, ["baseUrl"], "");
    this.maxResults = pick(init, ["maxResults"], 5);
    this.timeout = pick(init, ["timeout"], 30);
  }
}

export class WebFetchConfig extends Base {
  timeoutS = 30;
  maxChars = 60_000;
  useJinaReader = true;
  constructor(init: Dict = {}) {
    super();
    this.timeoutS = pick(init, ["timeoutS"], 30);
    this.maxChars = pick(init, ["maxChars"], 60_000);
    this.useJinaReader = pick(init, ["useJinaReader"], true);
  }
}

export class WebToolsConfig extends Base {
  enable = true;
  enabled = true;
  proxy: string | null = null;
  userAgent: string | null = null;
  search: WebSearchConfig;
  fetch: WebFetchConfig;

  constructor(init: Dict = {}) {
    super();
    this.enable = this.enabled = pick(init, ["enable", "enabled"], true);
    this.proxy = pick(init, ["proxy"], null);
    this.userAgent = pick(init, ["userAgent"], null);
    const rawSearch = pick(init, ["search"], {});
    const rawFetch = pick(init, ["fetch"], {});
    this.search = rawSearch instanceof WebSearchConfig ? rawSearch : new WebSearchConfig(rawSearch);
    this.fetch = rawFetch instanceof WebFetchConfig ? rawFetch : new WebFetchConfig(rawFetch);
  }

  override toObject(): Dict {
    return {
      enable: this.enable,
      proxy: this.proxy,
      userAgent: this.userAgent,
      search: this.search.toObject(),
      fetch: this.fetch.toObject(),
    };
  }
}

export class ExecToolConfig extends Base {
  enable = true;
  enabled = true;
  timeout = 60;
  pathAppend = "";
  sandbox = "";
  allowedEnvKeys: string[] = [];
  allowPatterns: string[] = [];
  denyPatterns: string[] = [];

  constructor(init: Dict = {}) {
    super();
    this.enable = this.enabled = pick(init, ["enable", "enabled"], true);
    this.timeout = pick(init, ["timeout"], 60);
    this.pathAppend = pick(init, ["pathAppend"], "");
    this.sandbox = pick(init, ["sandbox"], "");
    this.allowedEnvKeys = pick(init, ["allowedEnvKeys"], []);
    this.allowPatterns = pick(init, ["allowPatterns"], []);
    this.denyPatterns = pick(init, ["denyPatterns"], []);
  }

  override toObject(): Dict {
    return {
      enable: this.enable,
      timeout: this.timeout,
      pathAppend: this.pathAppend,
      sandbox: this.sandbox,
      allowedEnvKeys: this.allowedEnvKeys,
      allowPatterns: this.allowPatterns,
      denyPatterns: this.denyPatterns,
    };
  }
}

export class ImageGenerationProfileConfig extends Base {
  provider = "";
  model = "";
  apiKey = "";
  apiBase = "";
  extraHeaders: Dict<string> | null = null;
  extraBody: Dict | null = null;

  constructor(init: Dict = {}) {
    super();
    const provider = optionalString(pick(init, ["provider"], ""));
    this.provider = provider ? normalizeImageGenerationProvider(provider) : "";
    this.model = optionalString(pick(init, ["model"], "")) ?? "";
    this.apiKey = pick(init, ["apiKey", "api_key"], "") ?? "";
    this.apiBase = pick(init, ["apiBase", "api_base"], "") ?? "";
    if (typeof this.apiKey !== "string")
      throw new ValueError("tools.imageGeneration.profiles.apiKey must be a string");
    if (typeof this.apiBase !== "string")
      throw new ValueError("tools.imageGeneration.profiles.apiBase must be a string");
    if (hasAnyKey(init, ["extraHeaders", "extra_headers"])) {
      const value = pick(init, ["extraHeaders", "extra_headers"], null);
      this.extraHeaders =
        value === null
          ? null
          : assertStringRecord("tools.imageGeneration.profiles.extraHeaders", value);
    }
    if (hasAnyKey(init, ["extraBody", "extra_body"])) {
      const value = pick(init, ["extraBody", "extra_body"], null);
      this.extraBody =
        value === null
          ? null
          : assertPlainObject("tools.imageGeneration.profiles.extraBody", value);
    }
  }

  complete(): boolean {
    return Boolean(this.provider && this.model);
  }

  override toObject(): Dict {
    return omitUndefined({
      provider: this.provider || undefined,
      model: this.model || undefined,
      apiKey: this.apiKey || undefined,
      apiBase: this.apiBase || undefined,
      extraHeaders: this.extraHeaders ?? undefined,
      extraBody: this.extraBody ?? undefined,
    });
  }
}

function hasAnyKey(data: Dict, names: string[]): boolean {
  return names.some((name) => Object.prototype.hasOwnProperty.call(data, name));
}

function pickImageGenerationProfiles(value: any): Partial<Record<ImageGenerationProfileName, ImageGenerationProfileConfig>> {
  if (!isRecord(value)) return {};
  const profiles: Partial<Record<ImageGenerationProfileName, ImageGenerationProfileConfig>> = {};
  for (const name of ["account", "byok"] as const) {
    if (isRecord(value[name])) profiles[name] = new ImageGenerationProfileConfig(value[name]);
  }
  return profiles;
}

export function isValidImageGenerationMaxImagesPerTurn(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 1);
}

export class ImageGenerationToolConfig extends Base {
  enabled = false;
  provider = "openai";
  model = "gpt-image-2";
  apiKey = "";
  apiBase = "";
  defaultAspectRatio = "1:1";
  defaultImageSize = "1K";
  maxImagesPerTurn: number | null = null;
  saveDir = "generated";
  extraHeaders: Dict<string> = {};
  extraBody: Dict = {};
  activeProfile: ImageGenerationProfileName | null = null;
  profiles: Partial<Record<ImageGenerationProfileName, ImageGenerationProfileConfig>> = {};
  profileMode = false;

  constructor(init: Dict = {}) {
    super();
    this.enabled = pick(init, ["enabled"], false);
    this.activeProfile = imageGenerationProfileName(pick(init, ["activeProfile", "active_profile"], null));
    this.profiles = pickImageGenerationProfiles(pick(init, ["profiles"], {}));
    this.profileMode = this.activeProfile !== null || Object.keys(this.profiles).length > 0;
    this.provider = normalizeImageGenerationProvider(pick(init, ["provider"], this.provider));
    this.model = assertRequiredString("tools.imageGeneration.model", pick(init, ["model"], this.model));
    this.apiKey = pick(init, ["apiKey", "api_key"], this.apiKey) ?? "";
    this.apiBase = pick(init, ["apiBase", "api_base"], this.apiBase) ?? "";
    this.defaultAspectRatio = pick(
      init,
      ["defaultAspectRatio", "default_aspect_ratio"],
      this.defaultAspectRatio,
    );
    this.defaultImageSize = pick(
      init,
      ["defaultImageSize", "default_image_size"],
      this.defaultImageSize,
    );
    this.maxImagesPerTurn = pick(
      init,
      ["maxImagesPerTurn", "max_images_per_turn"],
      this.maxImagesPerTurn,
    );
    this.saveDir = pick(init, ["saveDir", "save_dir"], this.saveDir);
    this.extraHeaders = assertStringRecord(
      "tools.imageGeneration.extraHeaders",
      pick(init, ["extraHeaders", "extra_headers"], {}),
    );
    this.extraBody = assertPlainObject(
      "tools.imageGeneration.extraBody",
      pick(init, ["extraBody", "extra_body"], {}),
    );
    if (typeof this.apiKey !== "string")
      throw new ValueError("tools.imageGeneration.apiKey must be a string");
    if (typeof this.apiBase !== "string")
      throw new ValueError("tools.imageGeneration.apiBase must be a string");
    if (typeof this.defaultAspectRatio !== "string" || !this.defaultAspectRatio.trim())
      throw new ValueError("tools.imageGeneration.defaultAspectRatio must be a non-empty string");
    if (typeof this.defaultImageSize !== "string" || !this.defaultImageSize.trim())
      throw new ValueError("tools.imageGeneration.defaultImageSize must be a non-empty string");
    if (typeof this.saveDir !== "string" || !this.saveDir.trim())
      throw new ValueError("tools.imageGeneration.saveDir must be a non-empty string");
    if (!isValidImageGenerationMaxImagesPerTurn(this.maxImagesPerTurn)) {
      throw new ValueError(
        "tools.imageGeneration.maxImagesPerTurn must be null or a safe integer >= 1",
      );
    }
  }

  effectiveImageGenerationProfile(): ImageGenerationProfileConfig | null {
    if (this.profileMode) {
      if (!this.activeProfile) return null;
      return this.profiles[this.activeProfile] ?? null;
    }
    return new ImageGenerationProfileConfig({
      provider: this.provider,
      model: this.model,
      apiKey: this.apiKey,
      apiBase: this.apiBase,
      extraHeaders: this.extraHeaders,
      extraBody: this.extraBody,
    });
  }

  hasCompleteEffectiveProfile(): boolean {
    return Boolean(this.effectiveImageGenerationProfile()?.complete());
  }

  effectiveImageGenerationConfig(): ImageGenerationToolConfig {
    const profile = this.effectiveImageGenerationProfile();
    return new ImageGenerationToolConfig({
      enabled: this.enabled && Boolean(profile?.complete()),
      provider: profile?.provider || this.provider,
      model: profile?.model || this.model,
      apiKey: profile?.apiKey ?? "",
      apiBase: profile?.apiBase ?? "",
      defaultAspectRatio: this.defaultAspectRatio,
      defaultImageSize: this.defaultImageSize,
      maxImagesPerTurn: this.maxImagesPerTurn,
      saveDir: this.saveDir,
      extraHeaders: profile?.extraHeaders ?? this.extraHeaders,
      extraBody: profile?.extraBody ?? this.extraBody,
    });
  }

  override toObject(): Dict {
    const base = {
      enabled: this.enabled,
      defaultAspectRatio: this.defaultAspectRatio,
      defaultImageSize: this.defaultImageSize,
      maxImagesPerTurn: this.maxImagesPerTurn,
      saveDir: this.saveDir,
      extraHeaders: this.extraHeaders,
      extraBody: this.extraBody,
    };
    if (this.profileMode) {
      const profiles = Object.fromEntries(
        (["account", "byok"] as const)
          .filter((name) => this.profiles[name])
          .map((name) => [name, this.profiles[name]!.toObject()]),
      );
      return omitUndefined({
        ...base,
        activeProfile: this.activeProfile ?? undefined,
        profiles: Object.keys(profiles).length ? profiles : undefined,
      });
    }
    return {
      ...base,
      provider: this.provider,
      model: this.model,
      apiKey: this.apiKey,
      apiBase: this.apiBase,
    };
  }
}

function normalizeImageGenerationProvider(value: any): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  const legacy: Record<string, string> = {
    baidu: "qianfan",
    doubao: "volcengine",
    qwen: "dashscope",
  };
  const provider = legacy[raw] ?? raw;
  if (!provider) throw new ValueError("tools.imageGeneration.provider must be a non-empty string");
  if (!IMAGE_GENERATION_PROVIDERS.has(provider)) {
    throw new ValueError(`tools.imageGeneration.provider '${provider}' is not supported`);
  }
  return provider;
}

export class MyToolConfig extends Base {
  enable = true;
  allowSet = false;

  constructor(init: Dict = {}) {
    super();
    this.enable = pick(init, ["enable"], true);
    this.allowSet = pick(init, ["allowSet"], false);
  }

  override toObject(): Dict {
    return {
      enable: this.enable,
      allowSet: this.allowSet,
    };
  }
}

export class MCPServerConfig extends Base {
  type?: "stdio" | "sse" | "streamableHttp";
  transport?: "stdio" | "sse" | "streamableHttp";
  command = "";
  args: string[] = [];
  env: Dict<string> = {};
  cwd = "";
  url = "";
  headers: Dict<string> = {};
  toolTimeout = 30;
  enabledTools: string[] = ["*"];

  constructor(init: Dict = {}) {
    super();
    Object.assign(this, init);
    this.command = pick(init, ["command"], "");
    this.args = assertStringArray("args", pick(init, ["args"], []));
    this.env = pick(init, ["env"], {});
    this.cwd = pick(init, ["cwd"], "");
    this.url = pick(init, ["url"], "");
    this.headers = pick(init, ["headers"], {});
    this.toolTimeout = pick(init, ["toolTimeout"], 30);
    this.enabledTools = assertStringArray("enabledTools", pick(init, ["enabledTools"], ["*"]));
  }
}

export class ToolsConfig extends Base {
  web: WebToolsConfig;
  exec: ExecToolConfig;
  webSearch: WebSearchConfig;
  webFetch: WebFetchConfig;
  imageGeneration: ImageGenerationToolConfig;
  my: MyToolConfig;
  restrictToWorkspace = false;
  ssrfWhitelist: string[] = [];
  mcpServers: Dict<MCPServerConfig>;
  constructor(init: Dict = {}) {
    super();
    const webInit: any = pick<any>(init, ["web"], null);
    const searchInit = pick(init, ["webSearch"], webInit?.search ?? {});
    const fetchInit = pick(init, ["webFetch"], webInit?.fetch ?? {});
    this.web =
      webInit instanceof WebToolsConfig
        ? webInit
        : new WebToolsConfig({
            ...(webInit ?? {}),
            search: searchInit,
            fetch: fetchInit,
          });
    this.exec =
      init.exec instanceof ExecToolConfig ? init.exec : new ExecToolConfig(init.exec ?? {});
    this.webSearch = init.webSearch instanceof WebSearchConfig ? init.webSearch : this.web.search;
    this.webFetch = init.webFetch instanceof WebFetchConfig ? init.webFetch : this.web.fetch;
    this.imageGeneration =
      init.imageGeneration instanceof ImageGenerationToolConfig
        ? init.imageGeneration
        : new ImageGenerationToolConfig(pick(init, ["imageGeneration"], {}));
    this.my = init.my instanceof MyToolConfig ? init.my : new MyToolConfig(init.my ?? {});
    this.restrictToWorkspace = pick(init, ["restrictToWorkspace"], false);
    this.ssrfWhitelist = assertStringArray("ssrfWhitelist", pick(init, ["ssrfWhitelist"], []));
    const mcp = pick(init, ["mcpServers"], {});
    this.mcpServers = Object.fromEntries(
      Object.entries(mcp).map(([name, cfg]) => [
        name,
        cfg instanceof MCPServerConfig ? cfg : new MCPServerConfig(cfg as Dict),
      ]),
    );
  }

  override toObject(): Dict {
    const dumpServers = Object.fromEntries(
      Object.entries(this.mcpServers).map(([name, cfg]) => [
        name,
        cfg instanceof MCPServerConfig ? cfg.toObject() : cfg,
      ]),
    );
    return {
      web: this.web.toObject(),
      exec: this.exec.toObject(),
      webSearch: this.webSearch.toObject(),
      webFetch: this.webFetch.toObject(),
      imageGeneration: this.imageGeneration.toObject(),
      my: this.my.toObject(),
      restrictToWorkspace: this.restrictToWorkspace,
      ssrfWhitelist: this.ssrfWhitelist,
      mcpServers: dumpServers,
    };
  }
}

export class HeartbeatConfig extends Base {
  enabled = true;
  intervalS = 30 * 60;
  keepRecentMessages = 8;

  constructor(init: Dict = {}) {
    super();
    this.enabled = pick(init, ["enabled"], this.enabled);
    this.intervalS = pick(init, ["intervalS"], this.intervalS);
    this.keepRecentMessages = pick(init, ["keepRecentMessages"], this.keepRecentMessages);
  }

  override toObject(): Dict {
    return {
      enabled: this.enabled,
      intervalS: this.intervalS,
      keepRecentMessages: this.keepRecentMessages,
    };
  }
}

export class ApiConfig extends Base {
  host = "127.0.0.1";
  port = 18990;
  timeout = 120;
  apiKey: string | null = null;

  constructor(init: Dict = {}) {
    super();
    this.host = pick(init, ["host"], this.host);
    this.port = pick(init, ["port"], this.port);
    this.timeout = pick(init, ["timeout"], this.timeout);
    this.apiKey = pick(init, ["apiKey"], null);
  }

  override toObject(): Dict {
    return {
      host: this.host,
      port: this.port,
      timeout: this.timeout,
      apiKey: this.apiKey,
    };
  }
}

export class GatewayConfig extends Base {
  enabled = false;
  host = "127.0.0.1";
  port = 18970;
  heartbeat: HeartbeatConfig;

  constructor(init: Dict = {}) {
    super();
    this.enabled = pick(init, ["enabled"], this.enabled);
    this.host = pick(init, ["host"], this.host);
    this.port = pick(init, ["port"], this.port);
    this.heartbeat =
      init.heartbeat instanceof HeartbeatConfig
        ? init.heartbeat
        : new HeartbeatConfig(init.heartbeat ?? {});
  }

  override toObject(): Dict {
    return {
      enabled: this.enabled,
      host: this.host,
      port: this.port,
      heartbeat: this.heartbeat.toObject(),
    };
  }
}

export class MemmyMemoryConfig extends Base {
  enabled = true;
  userId = "local-user";
  activeProfile?: MemoryProfileName;
  profiles?: Dict;
  version?: number;
  storage?: Dict;
  summary?: Dict;
  evolution?: Dict;
  embedding?: Dict;
  algorithm?: Dict;

  constructor(init: Dict = {}, options: { userId?: string } = {}) {
    super();
    this.enabled = pick(init, ["enabled", "enable"], true);
    this.userId = options.userId ?? pick(init, ["userId"], this.userId);
    this.activeProfile = memoryProfileName(init.activeProfile);
    this.profiles = pickMemoryProfiles(init.profiles);
    this.version = pick<number | undefined>(init, ["version"], undefined);
    this.storage = pick<Dict | undefined>(init, ["storage"], undefined);
    this.summary = pick<Dict | undefined>(init, ["summary"], undefined);
    this.evolution = pick<Dict | undefined>(init, ["evolution"], undefined);
    this.embedding = pick<Dict | undefined>(init, ["embedding"], undefined);
    this.algorithm = pick<Dict | undefined>(init, ["algorithm"], undefined);
  }

  override toObject(): Dict {
    return omitUndefined({
      enabled: this.enabled,
      userId: this.profiles ? undefined : this.userId,
      activeProfile: this.activeProfile,
      profiles: this.profiles,
      version: this.version,
      storage: this.storage,
      summary: this.summary,
      evolution: this.evolution,
      embedding: this.embedding,
      algorithm: this.algorithm,
    });
  }
}

export class Config extends Base {
  app: Dict;
  agents: AgentsConfig;
  providers: ProvidersConfig;
  channels: ChannelsConfig;
  tools: ToolsConfig;
  heartbeat: HeartbeatConfig;
  api: ApiConfig;
  gateway: GatewayConfig;
  memmyMemory: MemmyMemoryConfig;
  modelPresets: Dict<ModelPresetConfig>;
  sessionDag: SessionDagConfig;
  contextCompaction: ContextCompactionConfig;

  constructor(init: Dict = {}) {
    super();
    const rawApp = pick<unknown>(init, ["app"], {});
    this.app =
      rawApp && typeof rawApp === "object" && !Array.isArray(rawApp) ? { ...(rawApp as Dict) } : {};
    const appCloudUuid = optionalString(this.app.cloudUuid);
    const appUserId = optionalString(this.app.userId);
    delete this.app.cloud_uuid;
    delete this.app.user_id;
    if (appCloudUuid) {
      this.app.cloudUuid = appCloudUuid;
    }
    if (appUserId) {
      this.app.userId = appUserId;
    }
    this.agents =
      init.agents instanceof AgentsConfig ? init.agents : new AgentsConfig(init.agents ?? {});
    this.providers =
      init.providers instanceof ProvidersConfig
        ? init.providers
        : new ProvidersConfig(init.providers ?? {});
    this.channels =
      init.channels instanceof ChannelsConfig
        ? init.channels
        : new ChannelsConfig(init.channels ?? {});
    this.tools = init.tools instanceof ToolsConfig ? init.tools : new ToolsConfig(init.tools ?? {});
    this.api = init.api instanceof ApiConfig ? init.api : new ApiConfig(init.api ?? {});
    this.gateway =
      init.gateway instanceof GatewayConfig ? init.gateway : new GatewayConfig(init.gateway ?? {});
    if (!("heartbeat" in (init.gateway ?? {})) && init.heartbeat) {
      this.gateway.heartbeat =
        init.heartbeat instanceof HeartbeatConfig
          ? init.heartbeat
          : new HeartbeatConfig(init.heartbeat);
    }
    this.heartbeat = this.gateway.heartbeat;
    this.memmyMemory =
      init.memmyMemory instanceof MemmyMemoryConfig
        ? init.memmyMemory
        : new MemmyMemoryConfig(init.memmyMemory ?? {}, { userId: appUserId });
    if (!this.memmyMemory.profiles) {
      this.memmyMemory.userId = appUserId ?? this.memmyMemory.userId ?? "local-user";
    }
    this.sessionDag =
      init.sessionDag instanceof SessionDagConfig
        ? init.sessionDag
        : new SessionDagConfig(init.sessionDag ?? {});
    this.contextCompaction =
      init.contextCompaction instanceof ContextCompactionConfig
        ? init.contextCompaction
        : new ContextCompactionConfig(init.contextCompaction ?? {});
    const rawPresets = pick(init, ["modelPresets"], {});
    this.modelPresets = Object.fromEntries(
      Object.entries(rawPresets).map(([name, cfg]) => {
        if (name === "default") throw new ValueError("modelPreset name 'default' is reserved");
        return [name, cfg instanceof ModelPresetConfig ? cfg : new ModelPresetConfig(cfg as Dict)];
      }),
    );
    const active = this.agents.defaults.modelPreset;
    if (active && active !== "default" && !(active in this.modelPresets)) {
      throw new ValueError(`modelPreset '${active}' not found in modelPresets`);
    }
    for (const fallback of this.agents.defaults.fallbackModels) {
      if (typeof fallback === "string" && !(fallback in this.modelPresets)) {
        throw new ValueError(`fallbackModels entry '${fallback}' not found in modelPresets`);
      }
    }
    for (const [name, provider] of Object.entries(this.providers)) {
      if (name !== "openai" && provider instanceof ProviderConfig && provider.apiType !== "auto") {
        throw new ValueError(`providers.${name}.apiType is only supported for providers.openai`);
      }
    }
    if (this.contextCompaction.summaryMode === "dag" && !this.sessionDag.enabled) {
      throw new ValueError("contextCompaction.summaryMode=dag requires sessionDag.enabled=true");
    }
  }

  resolvePreset(name?: string | null): ModelPresetConfig {
    const target = name ?? this.agents.defaults.modelPreset;
    if (!target || target === "default") {
      const d = this.agents.defaults;
      return new ModelPresetConfig({
        model: d.model,
        provider: d.provider,
        maxTokens: d.maxTokens,
        contextWindowTokens: d.contextWindowTokens,
        temperature: d.temperature,
        reasoningEffort: d.reasoningEffort,
      });
    }
    const preset = this.modelPresets[target];
    if (!preset) throw new KeyError(`modelPreset '${target}' not found`);
    return preset;
  }

  resolveDefaultPreset(): ModelPresetConfig {
    return this.resolvePreset("default");
  }

  matchProvider(
    model: string | null = null,
    opts: { preset?: ModelPresetConfig | null } = {},
  ): [ProviderConfig | null, string | null] {
    const resolved = opts.preset ?? this.resolvePreset();
    const forced = resolved.provider;
    if (forced !== "auto") {
      const spec = findByName(forced);
      if (!spec) return [null, null];
      return [(this.providers as any)[spec.name] ?? null, spec.name];
    }

    const modelLower = String(model ?? resolved.model ?? "").toLowerCase();
    const modelNormalized = modelLower.replaceAll("-", "_");
    const modelPrefix = modelLower.includes("/") ? modelLower.split("/", 1)[0] : "";
    const normalizedPrefix = modelPrefix.replaceAll("-", "_");
    const kwMatches = (keyword: string): boolean => {
      const kw = keyword.toLowerCase();
      return modelLower.includes(kw) || modelNormalized.includes(kw.replaceAll("-", "_"));
    };

    for (const spec of PROVIDERS) {
      const provider = (this.providers as any)[spec.name] as ProviderConfig | undefined;
      if (!provider || !modelPrefix || normalizedPrefix !== spec.name) continue;
      if (spec.isOauth || spec.isLocal || spec.isDirect || provider.apiKey)
        return [provider, spec.name];
    }

    for (const spec of PROVIDERS) {
      const provider = (this.providers as any)[spec.name] as ProviderConfig | undefined;
      if (!provider || !spec.keywords.some(kwMatches)) continue;
      if (spec.isOauth || spec.isLocal || spec.isDirect || provider.apiKey)
        return [provider, spec.name];
    }

    let localFallback: [ProviderConfig, string] | null = null;
    for (const spec of PROVIDERS) {
      if (!spec.isLocal) continue;
      const provider = (this.providers as any)[spec.name] as ProviderConfig | undefined;
      if (!provider?.apiBase) continue;
      if (spec.detectByBaseKeyword && provider.apiBase.includes(spec.detectByBaseKeyword)) {
        return [provider, spec.name];
      }
      localFallback ??= [provider, spec.name];
    }
    if (localFallback) return localFallback;

    for (const spec of PROVIDERS) {
      if (spec.isOauth) continue;
      const provider = (this.providers as any)[spec.name] as ProviderConfig | undefined;
      if (provider?.apiKey) return [provider, spec.name];
    }
    return [null, null];
  }

  getProvider(
    model: string | null = null,
    opts: { preset?: ModelPresetConfig | null } = {},
  ): ProviderConfig | null {
    return this.matchProvider(model, opts)[0];
  }

  getProviderName(
    model: string | null = null,
    opts: { preset?: ModelPresetConfig | null } = {},
  ): string | null {
    return this.matchProvider(model, opts)[1];
  }

  getApiKey(
    model: string | null = null,
    opts: { preset?: ModelPresetConfig | null } = {},
  ): string | null {
    return this.getProvider(model, opts)?.apiKey ?? null;
  }

  getApiBase(
    model: string | null = null,
    opts: { preset?: ModelPresetConfig | null } = {},
  ): string | null {
    const [provider, name] = this.matchProvider(model, opts);
    if (provider?.apiBase) return provider.apiBase;
    if (!name) return null;
    return findByName(name)?.defaultApiBase || null;
  }

  override toObject(): Dict {
    const plain = (value: any): any => {
      if (value && typeof value.toObject === "function") return value.toObject();
      if (Array.isArray(value)) return value.map(plain);
      if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
      return value;
    };
    const appUserId = optionalString(this.app.userId);
    delete this.app.cloud_uuid;
    delete this.app.user_id;
    if (!this.memmyMemory.profiles) {
      this.memmyMemory.userId = appUserId ?? this.memmyMemory.userId ?? "local-user";
    }
    const data: Dict = {
      agents: this.agents,
      providers: this.providers,
      channels: this.channels,
      tools: this.tools,
      api: this.api,
      gateway: this.gateway,
      memmyMemory: this.memmyMemory,
      sessionDag: this.sessionDag,
      contextCompaction: this.contextCompaction,
      modelPresets: this.modelPresets,
    };
    if (Object.keys(this.app).length > 0) data.app = this.app;
    return plain(data);
  }
}

export class KeyError extends Error {}
