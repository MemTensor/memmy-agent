import type {
  AppSettingsDto,
  EmbeddingMode as ModelEmbeddingMode,
  ModelConfigInput,
  ModelConfigTestCapability,
  ModelConfigTestResult,
  ModelConfigTestSecretTarget,
  ModelConfigView,
  ModelProvider,
  OnboardingStateDto,
  PrivacySettingsDto,
  RuntimeConfig,
  ScanPreferences,
  ScanPermission,
  SetImprovementProgramResponse,
  TokenUsageDto
} from "@memmy/local-api-contracts";
import {
  AppSettingsDtoSchema,
  ModelConfigInputSchema,
  ModelConfigTestInputSchema,
  ModelConfigTestResultSchema,
  ModelConfigViewSchema,
  OnboardingStateDtoSchema,
  PatchAppSettingsInputSchema,
  PatchOnboardingInputSchema,
  PatchPrivacyInputSchema,
  PatchScanPreferencesInputSchema,
  PrivacySettingsDtoSchema,
  ScanPreferencesSchema,
  SetImprovementProgramInputSchema,
  SetImprovementProgramResponseSchema,
  TokenUsageDtoSchema
} from "@memmy/local-api-contracts";
import type { PreferredMode } from "../app/routes.js";
import { requestJson } from "./http.js";

export interface ModelProviderConfig {
  provider: string;
  endpoint: string;
  model: string;
  apiKey: string;
  apiKeyMasked: string;
  configured: boolean;
  embedding?: EmbeddingProviderConfig | null;
  memmyMemory?: MemmyMemoryProviderConfig | null;
  asr?: AsrProviderConfig | null;
  imageGen?: ImageGenProviderConfig | null;
}

export interface RoleModelProviderConfig {
  provider: string;
  endpoint: string;
  model: string;
  apiKey: string;
  apiKeyMasked: string;
  configured: boolean;
}

export interface MemmyMemoryProviderConfig {
  summary: RoleModelProviderConfig;
  evolution: RoleModelProviderConfig;
}

export interface EmbeddingProviderConfig {
  mode: ModelEmbeddingMode;
  endpoint: string;
  model: string;
  apiKey: string;
  apiKeyMasked: string;
  configured: boolean;
}

export interface AsrProviderConfig {
  provider: string;
  endpoint: string;
  model: string;
  apiKey: string;
  apiKeyMasked: string;
  configured: boolean;
}

export interface ImageGenProviderConfig {
  provider: string;
  endpoint: string;
  model: string;
  apiKey: string;
  apiKeyMasked: string;
  configured: boolean;
}

export interface ConfigClient {
  updateSettings(settings: Partial<AppSettingsDto>): Promise<Partial<AppSettingsDto>>;
  updatePrivacy(privacy: Partial<PrivacySettingsDto>): Promise<Partial<PrivacySettingsDto>>;
  updateOnboarding(onboarding: Partial<OnboardingStateDto>): Promise<Partial<OnboardingStateDto>>;
  setImprovementProgram(accepted: boolean): Promise<SetImprovementProgramResponse>;
  getTokenUsage(): Promise<TokenUsageDto>;
  updateScanPermission(permission: ScanPermission): Promise<Partial<OnboardingStateDto>>;
  updateScanPreferences(preferences: Partial<ScanPreferences>): Promise<ScanPreferences>;
  getModelConfig(): Promise<ModelProviderConfig>;
  saveModelConfig(config: ModelProviderConfig): Promise<ModelProviderConfig>;
  testModelConfig(config: ModelProviderConfig, capability?: ModelConfigTestCapability, secretTarget?: ModelConfigTestSecretTarget): Promise<ModelConfigTestResult>;
  updatePreferredMode(mode: PreferredMode): Promise<PreferredMode>;
}

export function createHttpConfigClient(config: RuntimeConfig): ConfigClient {
  return {
    async updateSettings(settings) {
      return requestJson({
        config,
        path: "/api/app/settings",
        schema: AppSettingsDtoSchema,
        init: { method: "PATCH" },
        body: PatchAppSettingsInputSchema.parse(settings)
      });
    },

    async updatePrivacy(privacy) {
      return requestJson({
        config,
        path: "/api/app/privacy",
        schema: PrivacySettingsDtoSchema,
        init: { method: "PATCH" },
        body: PatchPrivacyInputSchema.parse(privacy)
      });
    },

    async updateOnboarding(onboarding) {
      return requestJson({
        config,
        path: "/api/app/onboarding",
        schema: OnboardingStateDtoSchema,
        init: { method: "PATCH" },
        body: PatchOnboardingInputSchema.parse(onboarding)
      });
    },

    async setImprovementProgram(accepted) {
      return requestJson({
        config,
        path: "/api/app/improvement-program",
        schema: SetImprovementProgramResponseSchema,
        init: { method: "PATCH" },
        body: SetImprovementProgramInputSchema.parse({
          improvementProgram: accepted ? "accepted" : "declined"
        })
      });
    },

    async getTokenUsage() {
      return requestJson({
        config,
        path: "/api/app/token-usage",
        schema: TokenUsageDtoSchema
      });
    },

    async updateScanPermission(permission) {
      return this.updateOnboarding({
        scanPermission: permission
      });
    },

    async updateScanPreferences(preferences) {
      return requestJson({
        config,
        path: "/api/app/scan-preferences",
        schema: ScanPreferencesSchema,
        init: { method: "PATCH" },
        body: PatchScanPreferencesInputSchema.parse(preferences)
      });
    },

    async getModelConfig() {
      const response = await requestJson({
        config,
        path: "/api/app/model-config",
        schema: ModelConfigViewSchema
      });

      return fromModelConfigView(response);
    },

    async saveModelConfig(modelConfig) {
      const response = await requestJson({
        config,
        path: "/api/app/model-config",
        schema: ModelConfigViewSchema,
        init: { method: "PUT" },
        body: toModelConfigInput(modelConfig)
      });

      return fromModelConfigView(response);
    },

    async testModelConfig(modelConfig, capability = "chat", secretTarget) {
      return requestJson({
        config,
        path: "/api/app/model-config/test",
        schema: ModelConfigTestResultSchema,
        body: ModelConfigTestInputSchema.parse({
          ...toModelConfigInput(modelConfig),
          capability,
          secretTarget
        })
      });
    },

    async updatePreferredMode(mode) {
      await this.updateSettings({ defaultLaunchMode: mode });
      return mode;
    }
  };
}

function toModelConfigInput(config: ModelProviderConfig): ModelConfigInput {
  return ModelConfigInputSchema.parse({
    provider: toModelProvider(config.provider),
    baseUrl: config.endpoint,
    modelId: config.model,
    apiKey: config.apiKey || undefined,
    embedding: toEmbeddingConfigInput(config.embedding),
    memmyMemory: toMemmyMemoryConfigInput(config),
    asr: toAsrConfigInput(config.asr),
    imageGen: toImageGenConfigInput(config.imageGen)
  });
}

function toImageGenConfigInput(config: ModelProviderConfig["imageGen"]): ModelConfigInput["imageGen"] {
  if (!config || !config.endpoint.trim() || !config.model.trim()) {
    return undefined;
  }
  return {
    provider: toModelProvider(config.provider) as NonNullable<ModelConfigInput["imageGen"]>["provider"],
    baseUrl: config.endpoint,
    modelId: config.model,
    apiKey: config.apiKey || undefined
  };
}

function toEmbeddingConfigInput(config: ModelProviderConfig["embedding"]): ModelConfigInput["embedding"] {
  if (!config) return undefined;
  if (config.mode === "local") {
    return { mode: "local" };
  }
  // Exclude incomplete custom embedding placeholders before validating the write schema.
  if (!config.endpoint.trim() || !config.model.trim()) {
    return undefined;
  }
  return {
    mode: "custom",
    baseUrl: config.endpoint,
    modelId: config.model,
    apiKey: config.apiKey || undefined
  };
}

// Match normalizeMemmyMemoryInput defaults: missing memory roles fall back to the primary model.
// Omit the section when both roles are absent so empty endpoint or model values never reach RoleModelConfigInputSchema.
function toMemmyMemoryConfigInput(config: ModelProviderConfig): ModelConfigInput["memmyMemory"] {
  const memmyMemory = config.memmyMemory;
  if (!memmyMemory) return undefined;

  const summaryConfigured = hasRoleModelValues(memmyMemory.summary);
  const evolutionConfigured = hasRoleModelValues(memmyMemory.evolution);
  if (!summaryConfigured && !evolutionConfigured) {
    return undefined;
  }

  return {
    summary: toRoleModelConfigInput(summaryConfigured ? memmyMemory.summary : config),
    evolution: toRoleModelConfigInput(evolutionConfigured ? memmyMemory.evolution : config)
  };
}

function hasRoleModelValues(config: RoleModelProviderConfig): boolean {
  return Boolean(config.endpoint.trim() && config.model.trim());
}

function toRoleModelConfigInput(config: Pick<ModelProviderConfig, "provider" | "endpoint" | "model" | "apiKey">) {
  return {
    provider: toModelProvider(config.provider),
    baseUrl: config.endpoint,
    modelId: config.model,
    apiKey: config.apiKey || undefined
  };
}

function toAsrConfigInput(config: ModelProviderConfig["asr"]): ModelConfigInput["asr"] {
  if (!config || !config.endpoint.trim()) return undefined;
  return {
    provider: "aliyun",
    baseUrl: config.endpoint,
    modelId: "qwen3-asr-flash",
    apiKey: config.apiKey || undefined
  };
}

function fromModelConfigView(view: ModelConfigView): ModelProviderConfig {
  return {
    provider: fromModelProvider(view.provider),
    endpoint: view.baseUrl,
    model: view.modelId,
    apiKey: view.apiKey,
    apiKeyMasked: view.apiKeyMasked,
    configured: view.hasApiKey,
    embedding: view.embedding ? {
      mode: view.embedding.mode,
      endpoint: view.embedding.baseUrl ?? "",
      model: view.embedding.modelId ?? "",
      apiKey: view.embedding.apiKey,
      apiKeyMasked: view.embedding.apiKeyMasked,
      configured: view.embedding.hasApiKey
    } : null,
    memmyMemory: {
      summary: fromRoleModelConfigView(view.memmyMemory.summary),
      evolution: fromRoleModelConfigView(view.memmyMemory.evolution)
    },
    asr: view.asr ? {
      provider: view.asr.provider,
      endpoint: view.asr.baseUrl,
      model: view.asr.modelId,
      apiKey: view.asr.apiKey,
      apiKeyMasked: view.asr.apiKeyMasked,
      configured: view.asr.hasApiKey
    } : null,
    imageGen: view.imageGen ? {
      provider: fromModelProvider(view.imageGen.provider),
      endpoint: view.imageGen.baseUrl,
      model: view.imageGen.modelId,
      apiKey: view.imageGen.apiKey,
      apiKeyMasked: view.imageGen.apiKeyMasked,
      configured: view.imageGen.hasApiKey
    } : null
  };
}

function fromRoleModelConfigView(view: ModelConfigView["memmyMemory"]["summary"]): RoleModelProviderConfig {
  return {
    provider: fromModelProvider(view.provider),
    endpoint: view.baseUrl,
    model: view.modelId,
    apiKey: view.apiKey,
    apiKeyMasked: view.apiKeyMasked,
    configured: view.hasApiKey
  };
}

function toModelProvider(provider: string): ModelProvider {
  if (provider === "openai") {
    return "openai_compatible";
  }

  return provider === "gemini" ? "google" : (provider as ModelProvider);
}

function fromModelProvider(provider: ModelProvider): string {
  if (provider === "openai_compatible") {
    return "openai";
  }

  return provider === "google" ? "gemini" : provider;
}
