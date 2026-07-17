/** Model config module. */
import { ASR_DEFAULT_BASE_URL, ASR_PROVIDER, QWEN_ASR_MODEL_ID, type ModelConfigTestSecretTarget } from "@memmy/local-api-contracts";
import type {
  AsrProviderConfig,
  ConfigClient,
  EmbeddingProviderConfig,
  ImageGenProviderConfig,
  MemmyMemoryProviderConfig,
  ModelProviderConfig,
  RoleModelProviderConfig
} from "../api/config-client.js";
import type { MessageKey } from "../i18n/messages.js";
import {
  canSaveOptionalModelConfig,
  createModelConfigValidationKey,
  hasRequiredModelConfigValues,
  type ModelConfigFormValues,
  type ModelConfigValidationState
} from "./model-config-validation.js";

/** Type definition for protocol. */
export type Protocol = "openai" | "anthropic" | "gemini" | "deepseek" | "zhipu" | "qwen" | "moonshot" | "minimax" | "baidu" | "doubao";

/** Contract for model config. */
export interface ModelConfig {
  reuse: boolean;
  protocol: Protocol;
  modelId: string;
  endpoint: string;
  apiKey: string;
  apiKeyMasked: string;
  configured: boolean;
  showKey: boolean;
  validation: ModelConfigValidationState;
}

/** Contract for protocol option. */
export interface ProtocolOption {
  value: Protocol;
  labelKey: MessageKey;
}

/** Contract for primary model values. */
export interface PrimaryModelValues {
  protocol: Protocol;
  modelId: string;
  endpoint: string;
  apiKey: string;
  apiKeyMasked?: string;
  configured?: boolean;
}

export type ModelConfigEmbeddingMode = "cloud" | "local" | "custom";

export interface HydratedModelConfigForm {
  protocol: Protocol;
  modelId: string;
  endpoint: string;
  apiKey: string;
  apiKeyMasked: string;
  llmValidation: ModelConfigValidationState;
  embeddingMode: ModelConfigEmbeddingMode;
  embModelId: string;
  embEndpoint: string;
  embApiKey: string;
  embApiKeyMasked: string;
  embValidation: ModelConfigValidationState;
  asrModelId: string;
  asrEndpoint: string;
  asrApiKey: string;
  asrApiKeyMasked: string;
  asrValidation: ModelConfigValidationState;
  imageGenProtocol: ImageProtocol;
  imageGenModelId: string;
  imageGenEndpoint: string;
  imageGenApiKey: string;
  imageGenApiKeyMasked: string;
  imageGenValidation: ModelConfigValidationState;
  memoryModel: ModelConfig;
  skillModel: ModelConfig;
}

/** Contract for test model connection input. */
export interface TestModelConnectionInput {
  configClient?: Pick<ConfigClient, "testModelConfig">;
  values: ModelConfigFormValues;
  setValidation: (validation: ModelConfigValidationState) => void;
  capability?: "chat" | "embedding" | "asr" | "image";
  secretTarget?: ModelConfigTestSecretTarget;
  onSuccess?: (config: ModelProviderConfig) => void;
  messages: TestModelConnectionMessages;
}

/** Contract for test model connection messages. */
export interface TestModelConnectionMessages {
  missingFields: string;
  localApiUnavailable: string;
  testing: string;
  success: string;
  invalidConfig: string;
  requestFailed: string;
}

export const PROTOCOL_OPTIONS: ProtocolOption[] = [
  { value: "openai", labelKey: "apiKey.provider.openai" },
  { value: "anthropic", labelKey: "apiKey.provider.anthropic" },
  { value: "gemini", labelKey: "apiKey.provider.gemini" },
  { value: "deepseek", labelKey: "apiKey.provider.deepseek" },
  { value: "zhipu", labelKey: "apiKey.provider.zhipu" },
  { value: "qwen", labelKey: "apiKey.provider.qwen" },
  { value: "moonshot", labelKey: "apiKey.provider.kimi" },
  { value: "minimax", labelKey: "apiKey.provider.minimax" },
  { value: "baidu", labelKey: "apiKey.provider.baidu" },
  { value: "doubao", labelKey: "apiKey.provider.doubao" }
];

export const DEFAULT_ENDPOINTS: Record<Protocol, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
  deepseek: "https://api.deepseek.com/v1",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  moonshot: "https://api.moonshot.ai/v1",
  minimax: "https://api.minimax.chat/v1",
  baidu: "https://qianfan.baidubce.com/v2",
  doubao: "https://ark.cn-beijing.volces.com/api/v3"
};

export const DEFAULT_MODEL_IDS: Record<Protocol, string> = {
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4",
  gemini: "gemini-2.5-pro",
  deepseek: "deepseek-chat",
  zhipu: "glm-4",
  qwen: "qwen-max",
  moonshot: "moonshot-v1-128k",
  minimax: "MiniMax-Text-01",
  baidu: "ernie-x1.1",
  doubao: "doubao-pro-256k"
};

export const ASR_MODEL_ID = QWEN_ASR_MODEL_ID;

export const ASR_DEFAULT_ENDPOINT = ASR_DEFAULT_BASE_URL;

/** Type definition for image protocol. */
export type ImageProtocol = "openai" | "gemini" | "zhipu" | "qwen" | "minimax" | "baidu" | "doubao";

export const IMAGE_PROTOCOL_OPTIONS: ProtocolOption[] = [
  { value: "openai", labelKey: "apiKey.provider.openai" },
  { value: "gemini", labelKey: "apiKey.provider.gemini" },
  { value: "zhipu", labelKey: "apiKey.provider.zhipu" },
  { value: "qwen", labelKey: "apiKey.provider.qwen" },
  { value: "minimax", labelKey: "apiKey.provider.minimax" },
  { value: "baidu", labelKey: "apiKey.provider.baidu" },
  { value: "doubao", labelKey: "apiKey.provider.doubao" }
];

export const IMAGE_DEFAULT_ENDPOINTS: Record<ImageProtocol, string> = {
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  qwen: "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1",
  minimax: "https://api.minimaxi.com/v1",
  baidu: "https://qianfan.baidubce.com/v2",
  doubao: "https://ark.cn-beijing.volces.com/api/v3"
};

export const IMAGE_DEFAULT_MODEL_IDS: Record<ImageProtocol, string> = {
  openai: "gpt-image-1",
  gemini: "imagen-4.0-generate-001",
  zhipu: "cogview-4",
  qwen: "qwen-image-2.0-pro",
  minimax: "image-01",
  baidu: "irag-1.0",
  doubao: "doubao-seedream-4-0-250828"
};

/** Creates create test model connection messages. */
export function createTestModelConnectionMessages(t: (key: MessageKey) => string): TestModelConnectionMessages {
  return {
    missingFields: t("apiKey.testMissingFields"),
    localApiUnavailable: t("apiKey.testLocalApiUnavailable"),
    testing: t("apiKey.testConnecting"),
    success: t("apiKey.testSuccess"),
    invalidConfig: t("apiKey.testInvalidConfig"),
    requestFailed: t("apiKey.testRequestFailed")
  };
}

/** Creates create model config. */
export function createModelConfig(protocol: Protocol): ModelConfig {
  return {
    reuse: true,
    protocol,
    modelId: "",
    endpoint: DEFAULT_ENDPOINTS[protocol],
    apiKey: "",
    apiKeyMasked: "",
    configured: false,
    showKey: false,
    validation: {
      status: "idle",
      message: null,
      testedKey: null
    }
  };
}

/** Creates create model protocol patch. */
export function createModelProtocolPatch(protocol: Protocol): Pick<ModelConfig, "protocol" | "endpoint" | "modelId" | "apiKey" | "apiKeyMasked" | "configured"> {
  return {
    protocol,
    endpoint: DEFAULT_ENDPOINTS[protocol],
    modelId: "",
    apiKey: "",
    apiKeyMasked: "",
    configured: false
  };
}

/** Creates create model form values. */
export function createModelFormValues(config: ModelConfig, primary: PrimaryModelValues): ModelConfigFormValues {
  if (config.reuse) {
    return {
      provider: fromProtocol(primary.protocol),
      endpoint: primary.endpoint,
      model: primary.modelId,
      apiKey: primary.apiKey,
      apiKeyMasked: primary.apiKeyMasked,
      hasExistingApiKey: Boolean(primary.configured || primary.apiKeyMasked)
    };
  }

  return {
    provider: fromProtocol(config.protocol),
    endpoint: config.endpoint,
    model: config.modelId,
    apiKey: config.apiKey,
    apiKeyMasked: config.apiKeyMasked,
    hasExistingApiKey: Boolean(config.configured || config.apiKeyMasked)
  };
}

export function hydrateModelConfigForm(
  saved: ModelProviderConfig,
  defaultEmbeddingMode: ModelConfigEmbeddingMode
): HydratedModelConfigForm {
  const protocol = toProtocol(saved.provider);
  const modelId = saved.model || "";
  const endpoint = saved.endpoint || DEFAULT_ENDPOINTS[protocol];
  const apiKeyMasked = saved.apiKeyMasked || "";
  const apiKey = saved.apiKey || "";
  const primary: PrimaryModelValues = {
    protocol,
    modelId,
    endpoint,
    apiKey,
    apiKeyMasked,
    configured: Boolean(saved.configured || apiKeyMasked)
  };
  const mainValues = {
    provider: fromProtocol(protocol),
    endpoint,
    model: modelId,
    apiKey,
    apiKeyMasked,
    hasExistingApiKey: primary.configured
  };
  const embedding = saved.embedding ?? null;
  const embeddingMode = resolveEmbeddingMode(embedding, defaultEmbeddingMode);
  const embApiKeyMasked = embedding?.apiKeyMasked ?? "";
  const embApiKey = embedding?.apiKey ?? "";
  const embValues = {
    provider: "openai",
    endpoint: embedding?.endpoint ?? "",
    model: embedding?.model ?? "",
    apiKey: embApiKey,
    apiKeyMasked: embApiKeyMasked,
    hasExistingApiKey: Boolean(embedding?.configured || embApiKeyMasked)
  };
  const asrApiKeyMasked = saved.asr?.apiKeyMasked ?? "";
  const asrApiKey = saved.asr?.apiKey ?? "";
  const hasSavedAsrConfig = Boolean(saved.asr?.configured || asrApiKey.trim() || asrApiKeyMasked);
  const asrModelId = hasSavedAsrConfig ? saved.asr?.model ?? "" : "";
  const asrValues = createAsrModelFormValues(
    asrModelId,
    saved.asr?.endpoint || ASR_DEFAULT_ENDPOINT,
    asrApiKey,
    asrApiKeyMasked
  );
  const imageGenProtocol = toImageProtocol(saved.imageGen?.provider);
  const imageGenApiKeyMasked = saved.imageGen?.apiKeyMasked ?? "";
  const imageGenApiKey = saved.imageGen?.apiKey ?? "";
  const imageGenModelId = saved.imageGen?.model || "";
  const imageGenEndpoint = saved.imageGen?.endpoint || IMAGE_DEFAULT_ENDPOINTS[imageGenProtocol];
  const imageGenValues = createImageGenModelFormValues(
    imageGenProtocol,
    imageGenModelId,
    imageGenEndpoint,
    imageGenApiKey,
    imageGenApiKeyMasked
  );

  return {
    protocol,
    modelId,
    endpoint,
    apiKey,
    apiKeyMasked,
    llmValidation: createSavedValidation(mainValues),
    embeddingMode,
    embModelId: embedding?.model ?? "",
    embEndpoint: embedding?.endpoint ?? "",
    embApiKey,
    embApiKeyMasked,
    embValidation: embeddingMode === "custom" ? createSavedValidation(embValues) : createIdleValidation(),
    asrModelId,
    asrEndpoint: saved.asr?.endpoint || ASR_DEFAULT_ENDPOINT,
    asrApiKey,
    asrApiKeyMasked,
    asrValidation: hasAsrApiKey(asrValues) ? createSavedValidation(asrValues) : createIdleValidation(),
    imageGenProtocol,
    imageGenModelId,
    imageGenEndpoint,
    imageGenApiKey,
    imageGenApiKeyMasked,
    imageGenValidation: hasImageGenApiKey(imageGenValues) ? createSavedValidation(imageGenValues) : createIdleValidation(),
    memoryModel: hydrateRoleModelConfig(saved.memmyMemory?.summary, primary),
    skillModel: hydrateRoleModelConfig(saved.memmyMemory?.evolution, primary)
  };
}

/** Handles to image protocol. */
export function toImageProtocol(provider: string | undefined): ImageProtocol {
  const protocol = provider ? toProtocol(provider) : "openai";
  return IMAGE_PROTOCOL_OPTIONS.some((option) => option.value === protocol) ? (protocol as ImageProtocol) : "openai";
}

/** Creates create memmy memory provider config. */
export function createMemmyMemoryProviderConfig(
  memoryModel: ModelConfig,
  skillModel: ModelConfig,
  primary: PrimaryModelValues
): MemmyMemoryProviderConfig {
  return {
    summary: toRoleModelProviderConfig(createModelFormValues(memoryModel, primary)),
    evolution: toRoleModelProviderConfig(createModelFormValues(skillModel, primary))
  };
}

/** Creates create asr provider config. */
export function createAsrProviderConfig(
  modelId: string,
  endpoint: string,
  apiKey: string,
  apiKeyMasked: string
): AsrProviderConfig {
  const normalizedModelId = modelId.trim() || ASR_MODEL_ID;
  const normalizedEndpoint = endpoint.trim() || ASR_DEFAULT_ENDPOINT;

  return {
    provider: ASR_PROVIDER,
    endpoint: normalizedEndpoint,
    model: normalizedModelId,
    apiKey,
    apiKeyMasked: apiKey.trim() ? "" : apiKeyMasked,
    configured: Boolean(endpoint.trim() && normalizedModelId.trim() && (apiKey.trim() || apiKeyMasked))
  };
}

/** Creates create asr model form values. */
export function createAsrModelFormValues(
  modelId: string,
  endpoint: string,
  apiKey: string,
  apiKeyMasked: string
): ModelConfigFormValues {
  return {
    provider: "qwen",
    endpoint,
    model: modelId.trim() || ASR_MODEL_ID,
    apiKey,
    apiKeyMasked,
    hasExistingApiKey: Boolean(apiKeyMasked)
  };
}

/** Checks has asr api key. */
export function hasAsrApiKey(values: ModelConfigFormValues): boolean {
  return Boolean(values.apiKey.trim() || values.hasExistingApiKey);
}

/** Creates create image gen provider config. */
export function createImageGenProviderConfig(
  protocol: ImageProtocol,
  modelId: string,
  endpoint: string,
  apiKey: string,
  apiKeyMasked: string
): ImageGenProviderConfig {
  const normalizedModelId = modelId.trim() || IMAGE_DEFAULT_MODEL_IDS[protocol];
  const normalizedEndpoint = endpoint.trim() || IMAGE_DEFAULT_ENDPOINTS[protocol];

  return {
    provider: protocol,
    endpoint: normalizedEndpoint,
    model: normalizedModelId,
    apiKey,
    apiKeyMasked: apiKey.trim() ? "" : apiKeyMasked,
    configured: Boolean(endpoint.trim() && normalizedModelId.trim() && (apiKey.trim() || apiKeyMasked))
  };
}

/** Creates create image gen model form values. */
export function createImageGenModelFormValues(
  protocol: ImageProtocol,
  modelId: string,
  endpoint: string,
  apiKey: string,
  apiKeyMasked: string
): ModelConfigFormValues {
  return {
    provider: protocol,
    endpoint,
    model: modelId,
    apiKey,
    apiKeyMasked,
    hasExistingApiKey: Boolean(apiKeyMasked)
  };
}

/** Checks has image gen api key. */
export function hasImageGenApiKey(values: ModelConfigFormValues): boolean {
  return Boolean(values.apiKey.trim() || values.hasExistingApiKey);
}

/** Handles to role model provider config. */
function toRoleModelProviderConfig(values: ModelConfigFormValues): RoleModelProviderConfig {
  return {
    provider: values.provider,
    endpoint: values.endpoint,
    model: values.model,
    apiKey: values.apiKey,
    apiKeyMasked: values.apiKey.trim() ? "" : values.apiKeyMasked ?? "",
    configured: Boolean(values.endpoint.trim() && values.model.trim() && (values.apiKey.trim() || values.hasExistingApiKey))
  };
}

function hydrateRoleModelConfig(role: RoleModelProviderConfig | undefined, primary: PrimaryModelValues): ModelConfig {
  if (!role?.configured && !role?.apiKeyMasked) {
    return createModelConfig(primary.protocol);
  }

  if (isReusingPrimaryModel(role, primary)) {
    return {
      ...createModelConfig(primary.protocol),
      configured: true,
      apiKeyMasked: primary.apiKeyMasked ?? "",
      validation: createSavedValidation(createModelFormValues(createModelConfig(primary.protocol), primary))
    };
  }

  const protocol = toProtocol(role.provider);
  const config: ModelConfig = {
    reuse: false,
    protocol,
    modelId: role.model,
    endpoint: role.endpoint,
    apiKey: role.apiKey,
    apiKeyMasked: role.apiKeyMasked,
    configured: Boolean(role.configured || role.apiKeyMasked),
    showKey: false,
    validation: createIdleValidation()
  };
  config.validation = createSavedValidation(createModelFormValues(config, primary));
  return config;
}

function isReusingPrimaryModel(role: RoleModelProviderConfig, primary: PrimaryModelValues): boolean {
  return role.provider === fromProtocol(primary.protocol)
    && role.endpoint === primary.endpoint
    && role.model === primary.modelId;
}

function resolveEmbeddingMode(
  embedding: EmbeddingProviderConfig | null,
  defaultEmbeddingMode: ModelConfigEmbeddingMode
): ModelConfigEmbeddingMode {
  if (!embedding) {
    return defaultEmbeddingMode;
  }

  return embedding.mode === "custom" ? "custom" : "local";
}

function createSavedValidation(values: ModelConfigFormValues): ModelConfigValidationState {
  if (!hasRequiredModelConfigValues(values)) {
    return createIdleValidation();
  }

  return {
    status: "idle",
    message: null,
    testedKey: createModelConfigValidationKey(values)
  };
}

function createIdleValidation(): ModelConfigValidationState {
  return {
    status: "idle",
    message: null,
    testedKey: null
  };
}

/** Checks can use model config. */
export function canUseModelConfig(config: ModelConfig, values: ModelConfigFormValues): boolean {
  return canSaveOptionalModelConfig(!config.reuse, values, config.validation);
}

/** Checks can save embedding model config. */
export function canSaveEmbeddingModelConfig(mode: "cloud" | "local" | "custom", values: ModelConfigFormValues, validation: ModelConfigValidationState): boolean {
  return canSaveOptionalModelConfig(mode === "custom", values, validation);
}

/** Handles test model connection. */
export function testModelConnection(input: TestModelConnectionInput): void {
  const capability = input.capability ?? "chat";
  if (!hasRequiredModelConfigValues(input.values)) {
    input.setValidation({
      status: "error",
      message: input.messages.missingFields,
      testedKey: null
    });
    return;
  }

  if (!input.configClient) {
    input.setValidation({
      status: "error",
      message: input.messages.localApiUnavailable,
      testedKey: null
    });
    return;
  }

  const key = createModelConfigValidationKey(input.values);
  const requestConfig = {
    provider: input.values.provider,
    endpoint: input.values.endpoint,
    model: input.values.model,
    apiKey: input.values.apiKey,
    apiKeyMasked: input.values.apiKey.trim() ? "" : input.values.apiKeyMasked ?? "",
    configured: Boolean(input.values.hasExistingApiKey)
  };
  input.setValidation({ status: "testing", message: input.messages.testing, testedKey: null });
  const testPromise = input.secretTarget
    ? input.configClient.testModelConfig(requestConfig, capability, input.secretTarget)
    : input.configClient.testModelConfig(requestConfig, capability);
  void testPromise
    .then((result) => {
      input.setValidation({
        status: result.ok ? "success" : "error",
        message: result.ok ? input.messages.success : result.message || input.messages.invalidConfig,
        testedKey: result.ok ? key : null
      });
      if (result.ok) {
        input.onSuccess?.(requestConfig);
      }
    })
    .catch(() => {
      input.setValidation({
        status: "error",
        message: input.messages.requestFailed,
        testedKey: null
      });
    });
}

/** Handles to protocol. */
export function toProtocol(provider: string): Protocol {
  if (provider === "gemini" || provider === "google") {
    return "gemini";
  }

  if (provider === "kimi") {
    return "moonshot";
  }

  return PROTOCOL_OPTIONS.some((option) => option.value === provider) ? (provider as Protocol) : "openai";
}

/** Handles from protocol. */
export function fromProtocol(protocol: Protocol): string {
  return protocol === "moonshot" ? "kimi" : protocol;
}
