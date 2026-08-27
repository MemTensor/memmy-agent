import {
  Config,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  InlineFallbackConfig,
  ModelPresetConfig,
  ProviderConfig,
  ValueError,
} from "../config/schema.js";
import { LLMProvider } from "./base.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { OpenAICompatProvider } from "./openai-compat-provider.js";
import { AzureOpenAIProvider } from "./azure-openai-provider.js";
import { BedrockProvider } from "./bedrock-provider.js";
import { OpenAICodexProvider } from "./openai-codex-provider.js";
import { GitHubCopilotProvider } from "./github-copilot-provider.js";
import { FallbackProvider } from "./fallback-provider.js";
import { ProviderSpec, findByName } from "./registry.js";

export class ProviderSnapshot {
  readonly provider: LLMProvider;
  readonly model: string;
  readonly contextWindowTokens: number;
  readonly signature: any[];

  constructor(init: {
    provider: LLMProvider;
    model: string;
    contextWindowTokens?: number;
    signature?: any[];
  }) {
    this.provider = init.provider;
    this.model = init.model;
    this.contextWindowTokens = init.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    this.signature = Object.freeze([...(init.signature ?? [])]) as any[];
    Object.freeze(this);
  }
}

function resolveModelPreset(
  config: Config,
  opts: { presetName?: string | null; preset?: ModelPresetConfig | null } = {},
): ModelPresetConfig {
  return opts.preset ?? config.resolvePreset(opts.presetName ?? null);
}

function providerInit(
  config: Config,
  providerConfig: ProviderConfig | null,
  spec: ProviderSpec | null,
  model: string,
  preset: ModelPresetConfig,
): any {
  const endpoint = exactEndpoint(config, providerConfig, preset);
  const protocol = endpoint?.protocol;
  return {
    apiKey: endpoint?.apiKey ?? providerConfig?.apiKey ?? null,
    apiBase: endpoint?.apiBase ?? config.getApiBase(model, { preset }),
    defaultModel: model,
    extraHeaders: mergedRecord(providerConfig?.extraHeaders, endpoint?.extraHeaders),
    extraBody: mergedRecord(providerConfig?.extraBody, endpoint?.extraBody),
    apiType: protocol === "openai-responses"
      ? "responses"
      : protocol === "openai-chat-completions" ? "chatCompletions" : "auto",
    spec,
  };
}

function mergedRecord(
  defaults: Record<string, any> | null | undefined,
  overrides: Record<string, any> | null | undefined,
): Record<string, any> {
  return { ...(defaults ?? {}), ...(overrides ?? {}) };
}

function exactEndpoint(
  config: Config,
  providerConfig: ProviderConfig | null,
  preset: ModelPresetConfig,
): ProviderConfig["endpoints"][string] | null {
  const endpoint = providerConfig?.endpoints[preset.endpoint];
  if (endpoint) return endpoint;
  if (Object.values(config.modelPresets).includes(preset) || preset.endpoint !== "default") {
    throw new ValueError(`Model preset endpoint '${preset.provider}.${preset.endpoint}' is not configured.`);
  }
  return null;
}

function makeProviderCore(
  config: Config,
  opts: {
    presetName?: string | null;
    preset?: ModelPresetConfig | null;
    model?: string | null;
    validateCredentials?: boolean;
  } = {},
): LLMProvider {
  const resolved = resolveModelPreset(config, opts);
  const model = opts.model ?? resolved.model;
  const providerName = config.getProviderName(model, { preset: resolved });
  const providerConfig = config.getProvider(model, { preset: resolved });
  const spec = providerName ? findByName(providerName) : null;
  const backend = spec?.backend ?? "openai_compat";
  const init = providerInit(config, providerConfig, spec, model, resolved);

  if (opts.validateCredentials !== false && backend === "azure_openai") {
    if (!init.apiKey || !init.apiBase) {
      throw new ValueError("Azure OpenAI requires apiKey and apiBase in config.");
    }
  } else if (opts.validateCredentials !== false && backend === "openai_compat" && !model.startsWith("bedrock/")) {
    const exempt = Boolean(spec?.isOauth || spec?.isLocal || spec?.isDirect);
    if (!init.apiKey && !exempt) {
      throw new ValueError(`No API key configured for provider '${providerName}'.`);
    }
  }

  let provider: LLMProvider;
  if (backend === "openai_codex") provider = new OpenAICodexProvider(init);
  else if (backend === "azure_openai") provider = new AzureOpenAIProvider(init);
  else if (backend === "github_copilot") provider = new GitHubCopilotProvider(init);
  else if (backend === "anthropic") provider = new AnthropicProvider(init);
  else if (backend === "bedrock") provider = new BedrockProvider({ ...init, region: (providerConfig as any)?.region ?? null, profile: (providerConfig as any)?.profile ?? null });
  else provider = new OpenAICompatProvider(init);

  provider.generation = resolved.toGenerationSettings();
  return provider;
}

function resolveFallbackPresets(config: Config): ModelPresetConfig[] {
  return config.agents.defaults.fallbackModels
    .map((fallback) => {
      if (typeof fallback === "string") return config.modelPresets[fallback];
      const inline = fallback as InlineFallbackConfig;
      throw new ValueError(
        `Inline fallback '${inline.provider}/${inline.model}' has no explicit endpoint; use a model preset reference.`,
      );
    })
    .filter((fallback): fallback is ModelPresetConfig => fallback instanceof ModelPresetConfig);
}

export function makeProvider(
  configOrName: Config | string,
  optsOrModel:
    | string
    | {
        presetName?: string | null;
        preset?: ModelPresetConfig | null;
        model?: string | null;
        validateCredentials?: boolean;
      } = {},
): LLMProvider {
  if (typeof configOrName === "string") {
    const providerName = configOrName;
    const model = typeof optsOrModel === "string" ? optsOrModel : optsOrModel.model;
    const spec = findByName(providerName);
    const init = { defaultModel: model ?? null, spec, apiBase: spec?.defaultApiBase || null };
    if (spec?.backend === "anthropic") return new AnthropicProvider(init);
    if (spec?.backend === "azure_openai") return new AzureOpenAIProvider(init);
    if (spec?.backend === "bedrock") return new BedrockProvider(init);
    if (spec?.backend === "github_copilot") return new GitHubCopilotProvider(init);
    if (spec?.backend === "openai_codex") return new OpenAICodexProvider(init);
    return new OpenAICompatProvider(init);
  }

  const opts = typeof optsOrModel === "string" ? { model: optsOrModel } : optsOrModel;
  const resolved = resolveModelPreset(configOrName, opts);
  let provider = makeProviderCore(configOrName, opts);
  const fallbackPresets = resolveFallbackPresets(configOrName);
  if (fallbackPresets.length) {
    provider = new FallbackProvider({
      primary: provider,
      fallbackPresets,
      providerFactory: (fallback) => makeProviderCore(configOrName, {
        preset: fallback as ModelPresetConfig,
        validateCredentials: opts.validateCredentials,
      }),
    });
  }
  return provider;
}

export function providerSignature(
  config: Config,
  opts: { presetName?: string | null; preset?: ModelPresetConfig | null } = {},
): any[] {
  const resolved = resolveModelPreset(config, opts);
  const providerConfig = config.getProvider(resolved.model, { preset: resolved });
  const fallbackPresets = resolveFallbackPresets(config);
  const fallbackSignature = (fallback: ModelPresetConfig): any[] => {
    const fallbackProvider = config.getProvider(fallback.model, { preset: fallback });
    const fallbackEndpoint = exactEndpoint(config, fallbackProvider, fallback);
    return [
      fallback.model,
      fallback.provider,
      config.getProviderName(fallback.model, { preset: fallback }),
      fallbackEndpoint?.apiKey ?? config.getApiKey(fallback.model, { preset: fallback }),
      fallbackEndpoint?.apiBase ?? config.getApiBase(fallback.model, { preset: fallback }),
      mergedRecord(fallbackProvider?.extraHeaders, fallbackEndpoint?.extraHeaders),
      mergedRecord(fallbackProvider?.extraBody, fallbackEndpoint?.extraBody),
      fallbackEndpoint?.protocol ?? fallbackProvider?.apiType ?? "auto",
      (fallbackProvider as any)?.region ?? null,
      (fallbackProvider as any)?.profile ?? null,
      fallback.maxTokens,
      fallback.temperature,
      fallback.reasoningEffort,
      fallback.contextWindowTokens,
    ];
  };
  const endpoint = exactEndpoint(config, providerConfig, resolved);

  return [
    resolved.model,
    resolved.provider,
    config.getProviderName(resolved.model, { preset: resolved }),
    endpoint?.apiKey ?? config.getApiKey(resolved.model, { preset: resolved }),
    endpoint?.apiBase ?? config.getApiBase(resolved.model, { preset: resolved }),
    mergedRecord(providerConfig?.extraHeaders, endpoint?.extraHeaders),
    mergedRecord(providerConfig?.extraBody, endpoint?.extraBody),
    endpoint?.protocol ?? providerConfig?.apiType ?? "auto",
    (providerConfig as any)?.region ?? null,
    (providerConfig as any)?.profile ?? null,
    resolved.maxTokens,
    resolved.temperature,
    resolved.reasoningEffort,
    resolved.contextWindowTokens,
    fallbackPresets.map(fallbackSignature),
  ];
}

export function buildProviderSnapshot(
  config: Config,
  opts: {
    presetName?: string | null;
    preset?: ModelPresetConfig | null;
    validateCredentials?: boolean;
  } = {},
): ProviderSnapshot {
  const resolved = resolveModelPreset(config, opts);
  const fallbackWindows = resolveFallbackPresets(config).map((fallback) => fallback.contextWindowTokens);
  return new ProviderSnapshot({
    provider: makeProvider(config, {
      preset: resolved,
      validateCredentials: opts.validateCredentials,
    }),
    model: resolved.model,
    contextWindowTokens: Math.min(resolved.contextWindowTokens, ...fallbackWindows),
    signature: providerSignature(config, { preset: resolved }),
  });
}
