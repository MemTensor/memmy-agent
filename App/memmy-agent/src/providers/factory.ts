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
  provider: LLMProvider;
  model: string;
  contextWindowTokens: number;
  signature: any[];

  constructor(init: {
    provider: LLMProvider;
    model: string;
    contextWindowTokens?: number;
    signature?: any[];
  }) {
    this.provider = init.provider;
    this.model = init.model;
    this.contextWindowTokens = init.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    this.signature = init.signature ?? [];
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
  return {
    apiKey: providerConfig?.apiKey ?? null,
    apiBase: config.getApiBase(model, { preset }),
    defaultModel: model,
    extraHeaders: providerConfig?.extraHeaders ?? null,
    extraBody: providerConfig?.extraBody ?? null,
    apiType: providerConfig?.apiType ?? "auto",
    spec,
  };
}

function makeProviderCore(
  config: Config,
  opts: {
    presetName?: string | null;
    preset?: ModelPresetConfig | null;
    model?: string | null;
  } = {},
): LLMProvider {
  const resolved = resolveModelPreset(config, opts);
  const model = opts.model ?? resolved.model;
  const providerName = config.getProviderName(model, { preset: resolved });
  const providerConfig = config.getProvider(model, { preset: resolved });
  const spec = providerName ? findByName(providerName) : null;
  const backend = spec?.backend ?? "openai_compat";

  if (backend === "azure_openai") {
    if (!providerConfig?.apiKey || !providerConfig.apiBase) {
      throw new ValueError("Azure OpenAI requires apiKey and apiBase in config.");
    }
  } else if (backend === "openai_compat" && !model.startsWith("bedrock/")) {
    const exempt = Boolean(spec?.isOauth || spec?.isLocal || spec?.isDirect);
    if (!providerConfig?.apiKey && !exempt) {
      throw new ValueError(`No API key configured for provider '${providerName}'.`);
    }
  }

  let provider: LLMProvider;
  const init = providerInit(config, providerConfig, spec, model, resolved);
  if (backend === "openai_codex") provider = new OpenAICodexProvider(init);
  else if (backend === "azure_openai") provider = new AzureOpenAIProvider(init);
  else if (backend === "github_copilot") provider = new GitHubCopilotProvider(init);
  else if (backend === "anthropic") provider = new AnthropicProvider(init);
  else if (backend === "bedrock") provider = new BedrockProvider({ ...init, region: (providerConfig as any)?.region ?? null, profile: (providerConfig as any)?.profile ?? null });
  else provider = new OpenAICompatProvider(init);

  provider.generation = resolved.toGenerationSettings();
  return provider;
}

function inlineFallbackPreset(primary: ModelPresetConfig, fallback: InlineFallbackConfig): ModelPresetConfig {
  return new ModelPresetConfig({
    model: fallback.model,
    provider: fallback.provider,
    maxTokens: fallback.maxTokens ?? primary.maxTokens,
    contextWindowTokens: fallback.contextWindowTokens ?? primary.contextWindowTokens,
    temperature: fallback.temperature ?? primary.temperature,
    reasoningEffort: fallback.reasoningEffort,
  });
}

function resolveFallbackPresets(config: Config, primary: ModelPresetConfig): ModelPresetConfig[] {
  return config.agents.defaults.fallbackModels.map((fallback) =>
    typeof fallback === "string"
      ? config.modelPresets[fallback]
      : inlineFallbackPreset(primary, fallback),
  );
}

export function makeProvider(
  configOrName: Config | string,
  optsOrModel:
    | string
    | {
        presetName?: string | null;
        preset?: ModelPresetConfig | null;
        model?: string | null;
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
  const fallbackPresets = resolveFallbackPresets(configOrName, resolved);
  if (fallbackPresets.length) {
    provider = new FallbackProvider({
      primary: provider,
      fallbackPresets,
      providerFactory: (fallback) => makeProviderCore(configOrName, { preset: fallback as ModelPresetConfig }),
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
  const fallbackPresets = resolveFallbackPresets(config, resolved);
  const fallbackSignature = (fallback: ModelPresetConfig): any[] => {
    const fallbackProvider = config.getProvider(fallback.model, { preset: fallback });
    return [
      fallback.model,
      fallback.provider,
      config.getProviderName(fallback.model, { preset: fallback }),
      config.getApiKey(fallback.model, { preset: fallback }),
      config.getApiBase(fallback.model, { preset: fallback }),
      fallbackProvider?.extraHeaders ?? null,
      fallbackProvider?.extraBody ?? null,
      fallbackProvider?.apiType ?? "auto",
      (fallbackProvider as any)?.region ?? null,
      (fallbackProvider as any)?.profile ?? null,
      fallback.maxTokens,
      fallback.temperature,
      fallback.reasoningEffort,
      fallback.contextWindowTokens,
    ];
  };

  return [
    resolved.model,
    resolved.provider,
    config.getProviderName(resolved.model, { preset: resolved }),
    config.getApiKey(resolved.model, { preset: resolved }),
    config.getApiBase(resolved.model, { preset: resolved }),
    providerConfig?.extraHeaders ?? null,
    providerConfig?.extraBody ?? null,
    providerConfig?.apiType ?? "auto",
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
  opts: { presetName?: string | null; preset?: ModelPresetConfig | null } = {},
): ProviderSnapshot {
  const resolved = resolveModelPreset(config, opts);
  const fallbackWindows = resolveFallbackPresets(config, resolved).map((fallback) => fallback.contextWindowTokens);
  return new ProviderSnapshot({
    provider: makeProvider(config, { preset: resolved }),
    model: resolved.model,
    contextWindowTokens: Math.min(resolved.contextWindowTokens, ...fallbackWindows),
    signature: providerSignature(config, { preset: resolved }),
  });
}
