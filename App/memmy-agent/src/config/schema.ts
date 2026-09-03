import { CronSchedule } from "../cron/types.js";
import { getModelTokenDefaults } from "../providers/model-token-defaults.js";
import { PROVIDERS, findByName } from "../providers/registry.js";
import { DEFAULT_MAX_TOKENS } from "../token-budget.js";
import { normalizeTimeZoneOffset, systemUtcOffset } from "../utils/time-zone.js";

type Dict<T = any> = Record<string, T>;
export type ContextCompactionSummaryMode = "text" | "dag";
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
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

function assertBoolean(field: string, value: any): boolean {
  if (typeof value !== "boolean") throw new ValueError(`${field} must be a boolean`);
  return value;
}

function assertIntArrayRange(field: string, value: any, min?: number, max?: number): number[] {
  if (!Array.isArray(value) || !value.length) throw new ValueError(`${field} must be a non-empty array of integers`);
  return value.map((item, idx) => assertIntRange(`${field}[${idx}]`, item, min, max));
}

type ProviderApiType = "auto" | "chatCompletions" | "responses";
export type ModelCapability = "agent" | "memory_summary" | "memory_evolution" | "embedding" | "asr" | "image_generation";
export type ModelEndpointProtocol =
  | "openai-chat-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "gemini-generate-content"
  | "openai-embeddings"
  | "dashscope-input-audio-chat"
  | "openai-images"
  | "dashscope-multimodal-generation"
  | "memmy-account";

const MODEL_CAPABILITIES = ["agent", "memory_summary", "memory_evolution", "embedding", "asr", "image_generation"] as const;
const TEXT_GENERATION_CAPABILITIES: ReadonlySet<ModelCapability> = new Set([
  "agent", "memory_summary", "memory_evolution",
]);
const ENDPOINT_PROTOCOLS = [
  "openai-chat-completions", "openai-responses", "anthropic-messages", "gemini-generate-content",
  "openai-embeddings", "dashscope-input-audio-chat", "openai-images",
  "dashscope-multimodal-generation", "memmy-account",
] as const;

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
  endpoint: string;
  model: string;
  provider: string;
  source: "account" | "byok";
  ownerAccountId: string | null;
  capabilities: ModelCapability[];
  maxTokens = DEFAULT_MAX_TOKENS;
  contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS;
  temperature = 0.7;
  reasoningEffort: string | null = null;

  constructor(init: Dict) {
    super(init);
    delete (this as Dict).label;
    this.endpoint = init.endpoint;
    this.model = init.model;
    this.provider = init.provider;
    this.source = assertOneOf("modelPreset source", init.source, ["account", "byok"] as const);
    this.ownerAccountId = pick(init, ["ownerAccountId"], null);
    this.capabilities = assertStringArray("modelPreset capabilities", init.capabilities) as ModelCapability[];
    assertRequiredString("modelPreset endpoint", this.endpoint);
    assertRequiredString("modelPreset model", this.model);
    assertRequiredString("modelPreset provider", this.provider);
    if (!this.capabilities.length || this.capabilities.some((capability) => !MODEL_CAPABILITIES.includes(capability))) {
      throw new ValueError(`modelPreset capabilities must contain only ${MODEL_CAPABILITIES.join(", ")}`);
    }
    const mappedDefaults = this.source === "byok"
      && this.capabilities.some((capability) => TEXT_GENERATION_CAPABILITIES.has(capability))
      ? getModelTokenDefaults(this.model)
      : null;
    this.maxTokens = pick(init, ["maxTokens"], mappedDefaults?.maxTokens ?? DEFAULT_MAX_TOKENS);
    this.contextWindowTokens = pick(
      init,
      ["contextWindowTokens"],
      mappedDefaults?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
    );
    this.temperature = pick(init, ["temperature"], 0.7);
    this.reasoningEffort = pick(init, ["reasoningEffort"], null);
    if (this.source === "account" && !optionalString(this.ownerAccountId)) {
      throw new ValueError("account modelPreset ownerAccountId is required");
    }
    if (this.source === "byok" && optionalString(this.ownerAccountId)) {
      throw new ValueError("BYOK modelPreset must not define ownerAccountId");
    }
  }

  toGenerationSettings(): any {
    return {
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      reasoningEffort: this.reasoningEffort,
    };
  }

  override toObject(): Dict {
    return omitUndefined({
      ...this,
      ownerAccountId: this.ownerAccountId ?? undefined,
    });
  }
}

export class AgentModelAssignmentConfig extends Base {
  candidates: string[];
  default: string | null;

  constructor(init: Dict = {}) {
    super(init);
    this.candidates = assertStringArray("modelAssignments agent candidates", pick(init, ["candidates"], []));
    this.default = pick(init, ["default"], null);
    if (new Set(this.candidates).size !== this.candidates.length) {
      throw new ValueError("modelAssignments agent candidates must be unique");
    }
    if (this.default && !this.candidates.includes(this.default)) {
      throw new ValueError("modelAssignments agent default must be one of candidates");
    }
    if (!this.default && this.candidates.length) {
      throw new ValueError("modelAssignments agent default is required when candidates exist");
    }
  }
}

export class ModelAssignmentConfig extends Base {
  ownerAccountId: string | null;
  agent: AgentModelAssignmentConfig;
  memorySummary: string | null;
  memoryEvolution: string | null;
  embedding: string | null;
  asr: string | null;
  imageGeneration: string | null;

  constructor(init: Dict = {}) {
    super(init);
    this.ownerAccountId = pick(init, ["ownerAccountId"], null);
    this.agent = init.agent instanceof AgentModelAssignmentConfig
      ? init.agent
      : new AgentModelAssignmentConfig(init.agent ?? {});
    this.memorySummary = pick(init, ["memorySummary"], null);
    this.memoryEvolution = pick(init, ["memoryEvolution"], null);
    this.embedding = pick(init, ["embedding"], null);
    this.asr = pick(init, ["asr"], null);
    this.imageGeneration = pick(init, ["imageGeneration"], null);
  }

  override toObject(): Dict {
    return omitUndefined({
      ...this,
      ownerAccountId: this.ownerAccountId ?? undefined,
      agent: this.agent instanceof AgentModelAssignmentConfig
        ? this.agent.toObject()
        : new AgentModelAssignmentConfig(this.agent).toObject(),
    });
  }
}

export class ModelAssignmentsConfig extends Base {
  byok: ModelAssignmentConfig;
  account: ModelAssignmentConfig;

  constructor(init: Dict = {}) {
    super(init);
    this.byok = init.byok instanceof ModelAssignmentConfig ? init.byok : new ModelAssignmentConfig(init.byok ?? {});
    this.account = init.account instanceof ModelAssignmentConfig ? init.account : new ModelAssignmentConfig(init.account ?? {});
    if (this.byok.ownerAccountId) throw new ValueError("modelAssignments.byok must not define ownerAccountId");
  }

  override toObject(): Dict {
    return {
      ...this,
      byok: this.byok.toObject(),
      account: this.account.toObject(),
    };
  }
}

export class AgentDefaults extends Base {
  workspace = "~/.memmy/workspace";
  modelPreset: string | null = null;
  model = "anthropic/claude-opus-4-5";
  provider = "auto";
  maxTokens = DEFAULT_MAX_TOKENS;
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
  timezone = systemUtcOffset();
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
    this.timezone = normalizeTimeZoneOffset(pick(init, ["timezone"], this.timezone));
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
  retryBackoffMs = [0, 3000, 5000, 10000];
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
      0,
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
  extraHeaders: Dict<string> | null;
  extraBody: Dict | null;
  ownerAccountId: string | null;
  endpoints: Dict<ModelEndpointConfig>;

  constructor(init: Dict = {}) {
    for (const legacy of ["api_key", "api_base", "api_type", "extra_headers", "extra_body", "apiBase", "apiType"]) {
      if (Object.prototype.hasOwnProperty.call(init, legacy)) {
        throw new ValueError(`providers current contract does not accept legacy field '${legacy}'`);
      }
    }
    super(init);
    this.apiKey = pick(init, ["apiKey"], null);
    this.extraHeaders = pick(init, ["extraHeaders"], null);
    this.extraBody = pick(init, ["extraBody"], null);
    this.ownerAccountId = pick(init, ["ownerAccountId"], null);
    this.endpoints = Object.fromEntries(Object.entries(pick(init, ["endpoints"], {})).map(([id, value]) => [
      id,
      value instanceof ModelEndpointConfig ? value : new ModelEndpointConfig(value as Dict),
    ]));
  }

  /** Compatibility projection used only until all Provider consumers resolve an explicit endpoint. */
  get apiBase(): string | null {
    return this.chatEndpoint()?.apiBase ?? Object.values(this.endpoints)[0]?.apiBase ?? null;
  }

  get apiType(): ProviderApiType {
    const protocol = this.chatEndpoint()?.protocol;
    if (protocol === "openai-responses") return "responses";
    if (protocol === "openai-chat-completions") return "chatCompletions";
    return "auto";
  }

  private chatEndpoint(): ModelEndpointConfig | null {
    return Object.values(this.endpoints).find((endpoint) => [
      "openai-chat-completions", "openai-responses", "anthropic-messages", "gemini-generate-content", "memmy-account",
    ].includes(endpoint.protocol)) ?? null;
  }

  override toObject(): Dict {
    return omitUndefined({
      ...this,
      apiKey: this.apiKey ?? undefined,
      extraHeaders: this.extraHeaders ?? undefined,
      extraBody: this.extraBody ?? undefined,
      ownerAccountId: this.ownerAccountId ?? undefined,
      endpoints: Object.fromEntries(Object.entries(this.endpoints).map(([id, endpoint]) => [id, endpoint.toObject()])),
    });
  }
}

export class ModelEndpointConfig extends Base {
  apiBase: string;
  protocol: ModelEndpointProtocol;
  apiKey: string | null;
  extraHeaders: Dict<string> | null;
  extraBody: Dict | null;

  constructor(init: Dict = {}) {
    for (const legacy of ["api_key", "api_base", "api_type", "extra_headers", "extra_body"]) {
      if (Object.prototype.hasOwnProperty.call(init, legacy)) {
        throw new ValueError(`provider endpoint current contract does not accept legacy field '${legacy}'`);
      }
    }
    super(init);
    this.apiBase = assertRequiredString("provider endpoint apiBase", init.apiBase);
    this.protocol = assertOneOf("provider endpoint protocol", init.protocol, ENDPOINT_PROTOCOLS);
    this.apiKey = pick(init, ["apiKey"], null);
    this.extraHeaders = pick(init, ["extraHeaders"], null);
    this.extraBody = pick(init, ["extraBody"], null);
  }

  override toObject(): Dict {
    return omitUndefined({
      ...this,
      apiKey: this.apiKey ?? undefined,
      extraHeaders: this.extraHeaders ?? undefined,
      extraBody: this.extraBody ?? undefined,
    });
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
  #presentProviderIds: Set<string>;
  constructor(init: Dict = {}) {
    super();
    this.#presentProviderIds = new Set(Object.keys(init));
    for (const legacy of ["openai_compatible", "google", "qwen", "kimi", "baidu", "doubao"]) {
      if (Object.prototype.hasOwnProperty.call(init, legacy)) {
        throw new ValueError(`providers current contract requires canonical Provider ID instead of '${legacy}'`);
      }
    }
    const byNormalizedKey = new Map(Object.entries(init));
    for (const { name } of PROVIDERS) {
      const cls = name === "bedrock" ? BedrockProviderConfig : ProviderConfig;
      const raw = byNormalizedKey.get(name) ?? {};
      this[name] = raw instanceof cls ? raw : new cls(raw);
    }
    for (const [name, raw] of Object.entries(init)) {
      if (name in this) continue;
      this[name] = raw instanceof ProviderConfig ? raw : new ProviderConfig(isRecord(raw) ? raw : {});
    }
  }

  override toObject(): Dict {
    const dump: Dict = {};
    for (const [name, value] of Object.entries(this)) {
      if (findByName(name)?.isOauth) continue;
      if (!this.#presentProviderIds.has(name) && !providerConfigHasValues(value)) continue;
      dump[name] = value && typeof value.toObject === "function"
        ? value.toObject()
        : value;
    }
    return dump;
  }
}

function providerConfigHasValues(value: any): boolean {
  if (!value || typeof value !== "object") return false;
  if (optionalString(value.apiKey) || optionalString(value.ownerAccountId) || Object.keys(value.endpoints ?? {}).length > 0) return true;
  if (isRecord(value.extraHeaders) && Object.keys(value.extraHeaders).length > 0) return true;
  if (isRecord(value.extraBody) && Object.keys(value.extraBody).length > 0) return true;
  if (optionalString(value.region) !== undefined || optionalString(value.profile) !== undefined) return true;
  const known = new Set(["apiKey", "ownerAccountId", "endpoints", "extraHeaders", "extraBody", "region", "profile"]);
  return Object.keys(value).some((key) => !known.has(key));
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

export class BrowserToolsConfig extends Base {
  enabled = true;
  maxSessions = 4;
  idleTimeoutS = 900;

  constructor(init: Dict = {}) {
    super();
    init = assertPlainObject("tools.browser", init);
    this.enabled = assertBoolean(
      "tools.browser.enabled",
      pick(init, ["enabled"], this.enabled),
    );
    this.maxSessions = assertIntRange(
      "tools.browser.maxSessions",
      pick(init, ["maxSessions"], this.maxSessions),
      1,
      8,
    );
    this.idleTimeoutS = assertIntRange(
      "tools.browser.idleTimeoutS",
      pick(init, ["idleTimeoutS"], this.idleTimeoutS),
      60,
      3600,
    );
  }

  override toObject(): Dict {
    return {
      enabled: this.enabled,
      maxSessions: this.maxSessions,
      idleTimeoutS: this.idleTimeoutS,
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
  profileMode = false;

  constructor(init: Dict = {}) {
    super();
    for (const legacy of [
      "activeProfile", "active_profile", "profiles", "provider", "model", "apiKey", "api_key", "apiBase", "api_base",
      "extraHeaders", "extra_headers", "extraBody", "extra_body", "default_aspect_ratio", "default_image_size",
      "max_images_per_turn", "save_dir",
    ]) {
      if (Object.prototype.hasOwnProperty.call(init, legacy)) {
        throw new ValueError(`tools.imageGeneration current contract does not accept legacy model field '${legacy}'`);
      }
    }
    this.enabled = pick(init, ["enabled"], false);
    this.profileMode = false;
    this.defaultAspectRatio = pick(
      init,
      ["defaultAspectRatio"],
      this.defaultAspectRatio,
    );
    this.defaultImageSize = pick(
      init,
      ["defaultImageSize"],
      this.defaultImageSize,
    );
    this.maxImagesPerTurn = pick(
      init,
      ["maxImagesPerTurn"],
      this.maxImagesPerTurn,
    );
    this.saveDir = pick(init, ["saveDir"], this.saveDir);
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

  effectiveImageGenerationProfile(): null {
    return null;
  }

  hasCompleteEffectiveProfile(): boolean {
    return false;
  }

  effectiveImageGenerationConfig(): ImageGenerationToolConfig {
    return this;
  }

  override toObject(): Dict {
    return {
      enabled: this.enabled,
      defaultAspectRatio: this.defaultAspectRatio,
      defaultImageSize: this.defaultImageSize,
      maxImagesPerTurn: this.maxImagesPerTurn,
      saveDir: this.saveDir,
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
  browser: BrowserToolsConfig;
  exec: ExecToolConfig;
  webSearch: WebSearchConfig;
  webFetch: WebFetchConfig;
  imageGeneration: ImageGenerationToolConfig;
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
    this.browser =
      init.browser instanceof BrowserToolsConfig
        ? init.browser
        : new BrowserToolsConfig(pick(init, ["browser"], {}));
    this.exec =
      init.exec instanceof ExecToolConfig ? init.exec : new ExecToolConfig(init.exec ?? {});
    this.webSearch = init.webSearch instanceof WebSearchConfig ? init.webSearch : this.web.search;
    this.webFetch = init.webFetch instanceof WebFetchConfig ? init.webFetch : this.web.fetch;
    this.imageGeneration =
      init.imageGeneration instanceof ImageGenerationToolConfig
        ? init.imageGeneration
        : new ImageGenerationToolConfig(pick(init, ["imageGeneration"], {}));
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
      browser: this.browser.toObject(),
      exec: this.exec.toObject(),
      webSearch: this.webSearch.toObject(),
      webFetch: this.webFetch.toObject(),
      imageGeneration: this.imageGeneration.toObject(),
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
  version?: number;
  storage?: Dict;
  retrievalLayers?: Array<"L1" | "L2" | "L3" | "Skill">;
  summary?: Dict;
  evolution?: Dict;
  embedding?: Dict;
  algorithm?: Dict;

  constructor(init: Dict = {}, options: { userId?: string } = {}) {
    super();
    for (const legacy of ["enable", "activeProfile", "profiles", "summary", "evolution", "embedding"]) {
      if (Object.prototype.hasOwnProperty.call(init, legacy)) {
        throw new ValueError(`memmyMemory current contract does not accept legacy field '${legacy}'`);
      }
    }
    this.enabled = pick(init, ["enabled"], true);
    this.userId = options.userId ?? pick(init, ["userId"], this.userId);
    this.version = pick<number | undefined>(init, ["version"], undefined);
    this.storage = pick<Dict | undefined>(init, ["storage"], undefined);
    const retrievalLayers = pick<unknown>(init, ["retrievalLayers"], undefined);
    this.retrievalLayers = retrievalLayers === undefined
      ? undefined
      : [...new Set(assertStringArray("memmyMemory.retrievalLayers", retrievalLayers).map((layer, index) =>
          assertOneOf(`memmyMemory.retrievalLayers[${index}]`, layer, ["L1", "L2", "L3", "Skill"] as const)
        ))];
    this.summary = undefined;
    this.evolution = undefined;
    this.embedding = undefined;
    this.algorithm = pick<Dict | undefined>(init, ["algorithm"], undefined);
  }

  override toObject(): Dict {
    return omitUndefined({
      enabled: this.enabled,
      userId: this.userId,
      version: this.version,
      storage: this.storage,
      retrievalLayers: this.retrievalLayers,
      algorithm: this.algorithm,
    });
  }
}

export class FileMemoryConfig extends Base {
  enabled = false;

  constructor(init: unknown = {}) {
    super();
    const data = assertPlainObject("fileMemory", init);
    this.enabled = assertBoolean(
      "fileMemory.enabled",
      pick(data, ["enabled"], false),
    );
  }

  override toObject(): Dict {
    return { enabled: this.enabled };
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
  fileMemory: FileMemoryConfig;
  memmyMemory: MemmyMemoryConfig;
  modelPresets: Dict<ModelPresetConfig>;
  modelAssignments: ModelAssignmentsConfig;
  sessionDag: SessionDagConfig;
  contextCompaction: ContextCompactionConfig;

  constructor(init: Dict = {}) {
    super();
    for (const legacy of ["agent", "model", "uuid", "identity"]) {
      if (Object.prototype.hasOwnProperty.call(init, legacy)) {
        throw new ValueError(`config current contract does not accept legacy root '${legacy}'`);
      }
    }
    const rawTools = isRecord(init.tools) ? init.tools : {};
    for (const legacy of ["my", "myEnabled", "mySet"]) {
      if (Object.prototype.hasOwnProperty.call(rawTools, legacy)) {
        throw new ValueError(`config current contract does not accept legacy tools.${legacy}`);
      }
    }
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
    const fileMemory = Object.prototype.hasOwnProperty.call(init, "fileMemory")
      ? init.fileMemory
      : {};
    this.fileMemory =
      fileMemory instanceof FileMemoryConfig
        ? fileMemory
        : new FileMemoryConfig(fileMemory);
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
    this.memmyMemory.userId = appUserId ?? this.memmyMemory.userId ?? "local-user";
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
    this.modelAssignments = init.modelAssignments instanceof ModelAssignmentsConfig
      ? init.modelAssignments
      : new ModelAssignmentsConfig(init.modelAssignments ?? {});
    const active = this.agents.defaults.modelPreset;
    if (active && active !== "default" && !(active in this.modelPresets)) {
      throw new ValueError(`modelPreset '${active}' not found in modelPresets`);
    }
    for (const fallback of this.agents.defaults.fallbackModels) {
      if (typeof fallback === "string" && !(fallback in this.modelPresets)) {
        throw new ValueError(`fallbackModels entry '${fallback}' not found in modelPresets`);
      }
    }
    this.validateModelCatalog();
    if (this.contextCompaction.summaryMode === "dag" && !this.sessionDag.enabled) {
      throw new ValueError("contextCompaction.summaryMode=dag requires sessionDag.enabled=true");
    }
  }

  resolvePreset(name?: string | null): ModelPresetConfig {
    const target = name ?? this.agents.defaults.modelPreset;
    if (!target || target === "default") {
      const d = this.agents.defaults;
      return new ModelPresetConfig({
        endpoint: "default",
        model: d.model,
        provider: d.provider,
        source: "byok",
        capabilities: ["agent"],
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

  private validateModelCatalog(): void {
    const textProtocols = new Set<ModelEndpointProtocol>([
      "openai-chat-completions", "openai-responses", "anthropic-messages", "gemini-generate-content", "memmy-account",
    ]);
    const protocolsByCapability: Readonly<Record<ModelCapability, ReadonlySet<ModelEndpointProtocol>>> = {
      agent: textProtocols,
      memory_summary: textProtocols,
      memory_evolution: textProtocols,
      embedding: new Set(["openai-embeddings", "memmy-account"]),
      asr: new Set(["dashscope-input-audio-chat", "memmy-account"]),
      image_generation: new Set(["openai-images", "dashscope-multimodal-generation", "memmy-account"]),
    };
    for (const [presetId, preset] of Object.entries(this.modelPresets)) {
      const provider = (this.providers as Dict<ProviderConfig>)[preset.provider];
      const endpoint = provider?.endpoints[preset.endpoint];
      if (!endpoint) throw new ValueError(`modelPresets.${presetId} references missing provider endpoint`);
      for (const capability of preset.capabilities) {
        if (!protocolsByCapability[capability].has(endpoint.protocol)) {
          throw new ValueError(`modelPresets.${presetId} capability ${capability} is incompatible with ${endpoint.protocol}`);
        }
      }
      if (preset.source === "account" && preset.ownerAccountId !== provider.ownerAccountId) {
        throw new ValueError(`modelPresets.${presetId} ownerAccountId does not match its Provider`);
      }
    }
    this.validateAssignment("byok", this.modelAssignments.byok);
    this.validateAssignment("account", this.modelAssignments.account);
  }

  private validateAssignment(
    namespace: "byok" | "account",
    assignment: ModelAssignmentConfig,
  ): void {
    const validate = (presetId: string | null, capability: ModelCapability): void => {
      if (!presetId) return;
      const preset = this.modelPresets[presetId];
      if (!preset) {
        if (namespace === "account" && assignment.ownerAccountId) return;
        throw new ValueError(`modelAssignments.${namespace} references missing preset '${presetId}'`);
      }
      if (namespace === "byok" && preset.source !== "byok") {
        throw new ValueError("modelAssignments.byok may only reference BYOK presets");
      }
      if (preset.source === "account" && assignment.ownerAccountId !== preset.ownerAccountId) {
        throw new ValueError("modelAssignments.account owner does not match platform preset");
      }
      if (!preset.capabilities.includes(capability)) {
        throw new ValueError(`modelAssignments.${namespace} preset '${presetId}' lacks capability ${capability}`);
      }
    };
    for (const presetId of assignment.agent.candidates) validate(presetId, "agent");
    validate(assignment.memorySummary, "memory_summary");
    validate(assignment.memoryEvolution, "memory_evolution");
    validate(assignment.embedding, "embedding");
    validate(assignment.asr, "asr");
    validate(assignment.imageGeneration, "image_generation");
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
    this.memmyMemory.userId = appUserId ?? this.memmyMemory.userId ?? "local-user";
    const data: Dict = {
      agents: this.agents,
      providers: this.providers,
      channels: this.channels,
      tools: this.tools,
      api: this.api,
      gateway: this.gateway,
      fileMemory: this.fileMemory,
      memmyMemory: this.memmyMemory,
      sessionDag: this.sessionDag,
      contextCompaction: this.contextCompaction,
      modelPresets: this.modelPresets,
      modelAssignments: this.modelAssignments,
    };
    if (Object.keys(this.app).length > 0) data.app = this.app;
    return plain(data);
  }
}

export class KeyError extends Error {}
