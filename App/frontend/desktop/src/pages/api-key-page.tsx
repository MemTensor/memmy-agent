import { useState } from "react";
import { Brain, ChevronLeft, Search } from "lucide-react";
import type { ModelProviderConfig } from "../api/config-client.js";
import { useAnalytics } from "../analytics/use-analytics.js";
import { persistLoginModeSelection } from "../app/login-mode.js";
import { useApiClients } from "../app/providers.js";
import { PAGE_CORNER_ACTION_CONTAINER_STYLE, PageCornerActionButton } from "../components/language-toggle-button.js";
import { Select } from "../components/Select.js";
import type { MessageKey } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";
import { appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import {
  API_KEY_CARD_CLASS,
  API_KEY_PRIMARY_BTN_CLASS,
  ConfigField,
  PasswordConfigField,
  TestButton,
  ValidationMessage
} from "./api-key-form-fields.js";
import {
  canSaveOptionalModelConfig,
  canSaveModelConfig,
  createModelConfigValidationKey,
  type ModelConfigValidationState
} from "./model-config-validation.js";
import {
  createTestModelConnectionMessages,
  fromProtocol,
  hydrateModelConfigForm,
  testModelConnection
} from "./model-config.js";

type EmbeddingMode = "local" | "custom";

interface EmbeddingCustomConfig {
  model: string;
  endpoint: string;
  apiKey: string;
  apiKeyMasked: string;
}

interface ProviderOption {
  value: string;
  labelKey: MessageKey;
  endpoint: string;
  defaultModelId: string;
}

const providerOptions: ProviderOption[] = [
  { value: "openai", labelKey: "apiKey.provider.openai", endpoint: "https://api.openai.com/v1", defaultModelId: "gpt-4o" },
  { value: "anthropic", labelKey: "apiKey.provider.anthropic", endpoint: "https://api.anthropic.com", defaultModelId: "claude-sonnet-4" },
  { value: "gemini", labelKey: "apiKey.provider.gemini", endpoint: "https://generativelanguage.googleapis.com", defaultModelId: "gemini-2.5-pro" },
  { value: "deepseek", labelKey: "apiKey.provider.deepseek", endpoint: "https://api.deepseek.com/v1", defaultModelId: "deepseek-chat" },
  { value: "zhipu", labelKey: "apiKey.provider.zhipu", endpoint: "https://open.bigmodel.cn/api/paas/v4", defaultModelId: "glm-4" },
  { value: "qwen", labelKey: "apiKey.provider.qwen", endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1", defaultModelId: "qwen-max" },
  { value: "kimi", labelKey: "apiKey.provider.kimi", endpoint: "https://api.moonshot.ai/v1", defaultModelId: "moonshot-v1-128k" },
  { value: "minimax", labelKey: "apiKey.provider.minimax", endpoint: "https://api.minimax.chat/v1", defaultModelId: "MiniMax-Text-01" },
  { value: "baidu", labelKey: "apiKey.provider.baidu", endpoint: "https://qianfan.baidubce.com/v2", defaultModelId: "ernie-x1.1" },
  { value: "doubao", labelKey: "apiKey.provider.doubao", endpoint: "https://ark.cn-beijing.volces.com/api/v3", defaultModelId: "doubao-pro-256k" }
];

const defaultProvider = providerOptions[0]!;

export function ApiKeyPage() {
  const { state, dispatch } = useAppState();
  const { clients } = useApiClients();
  const { t } = useTranslation();
  const { track } = useAnalytics();
  const initialModelForm = hydrateModelConfigForm(state.modelConfig, "local");
  const initialProvider = fromProtocol(initialModelForm.protocol);
  const [provider, setProvider] = useState(initialProvider);
  const selectedProvider = providerOptions.find((option) => option.value === provider) ?? defaultProvider;
  const [endpoint, setEndpoint] = useState(initialModelForm.endpoint || selectedProvider.endpoint);
  const [model, setModel] = useState(initialModelForm.modelId);
  const [apiKey, setApiKey] = useState(initialModelForm.apiKey);
  const [apiKeyMasked, setApiKeyMasked] = useState(initialModelForm.apiKeyMasked);
  const [showApiKey, setShowApiKey] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [maxTokens, setMaxTokens] = useState("");
  const [dailyLimit, setDailyLimit] = useState("");
  const modelFormValues = {
    provider,
    endpoint,
    model,
    apiKey,
    apiKeyMasked,
    hasExistingApiKey: Boolean(apiKeyMasked)
  };
  const [llmValidation, setLlmValidation] = useState<ModelConfigValidationState>(initialModelForm.llmValidation);
  const initialEmbeddingMode: EmbeddingMode = initialModelForm.embeddingMode === "custom" ? "custom" : "local";
  const [embeddingMode, setEmbeddingMode] = useState<EmbeddingMode>(initialEmbeddingMode);
  const [embeddingConfig, setEmbeddingConfig] = useState<EmbeddingCustomConfig>({
    model: initialModelForm.embModelId,
    endpoint: initialModelForm.embEndpoint,
    apiKey: initialModelForm.embApiKey,
    apiKeyMasked: initialModelForm.embApiKeyMasked
  });
  const [showEmbeddingApiKey, setShowEmbeddingApiKey] = useState(false);
  const embeddingFormValues = {
    provider: "openai",
    endpoint: embeddingConfig.endpoint,
    model: embeddingConfig.model,
    apiKey: embeddingConfig.apiKey,
    apiKeyMasked: embeddingConfig.apiKeyMasked,
    hasExistingApiKey: Boolean(embeddingConfig.apiKeyMasked)
  };
  const [embeddingValidation, setEmbeddingValidation] = useState<ModelConfigValidationState>(initialModelForm.embValidation);
  const canSave = canSaveModelConfig(modelFormValues, llmValidation)
    && canSaveOptionalModelConfig(embeddingMode === "custom", embeddingFormValues, embeddingValidation);
  const testedKey = createModelConfigValidationKey(modelFormValues);
  const isTestStale = Boolean(llmValidation.testedKey && llmValidation.testedKey !== testedKey);
  const embeddingTestKey = createModelConfigValidationKey(embeddingFormValues);
  const isEmbeddingTestStale = Boolean(embeddingValidation.testedKey && embeddingValidation.testedKey !== embeddingTestKey);

  function changeProvider(nextProvider: string) {
    const next = providerOptions.find((option) => option.value === nextProvider) ?? defaultProvider;
    setProvider(next.value);
    setEndpoint(next.endpoint);
    setModel("");
    setApiKey("");
    setApiKeyMasked("");
  }

  function testLlmConnection() {
    testModelConnection({
      configClient: clients?.config,
      values: modelFormValues,
      setValidation: setLlmValidation,
      secretTarget: "primary",
      messages: createTestModelConnectionMessages(t)
    });
  }

  function testEmbeddingConnection() {
    testModelConnection({
      configClient: clients?.config,
      values: embeddingFormValues,
      setValidation: setEmbeddingValidation,
      capability: "embedding",
      secretTarget: "embedding",
      messages: createTestModelConnectionMessages(t)
    });
  }

  function updateEmbeddingConfig(field: keyof EmbeddingCustomConfig, value: string) {
    setEmbeddingConfig((current) => ({ ...current, [field]: value }));
  }

  function createModelConfigDraft(): ModelProviderConfig {
    return {
      provider,
      endpoint,
      model,
      apiKey,
      apiKeyMasked: apiKey.trim() ? "" : apiKeyMasked,
      configured: Boolean(endpoint.trim() && model.trim() && (apiKey.trim() || apiKeyMasked)),
      embedding: embeddingMode === "custom"
        ? {
            mode: "custom",
            endpoint: embeddingConfig.endpoint,
            model: embeddingConfig.model,
            apiKey: embeddingConfig.apiKey,
            apiKeyMasked: embeddingConfig.apiKey.trim() ? "" : embeddingConfig.apiKeyMasked,
            configured: Boolean(embeddingConfig.endpoint.trim() && embeddingConfig.model.trim() && (embeddingConfig.apiKey.trim() || embeddingConfig.apiKeyMasked))
          }
        : {
            mode: "local",
            endpoint: "",
            model: "",
            apiKey: "",
            apiKeyMasked: "",
            configured: true
          },
      asr: state.modelConfig.asr ?? null,
      imageGen: state.modelConfig.imageGen ?? null
    };
  }

  function saveConfig() {
    if (!canSave) {
      return;
    }

    const configDraft = createModelConfigDraft();
    dispatch(appActions.modelConfigUpdated(configDraft));
    dispatch(appActions.navigate("/api-key-models"));

    void (clients?.config.saveModelConfig(configDraft) ?? Promise.resolve(configDraft))
      .then((config) => {
        track({ name: "model_config_saved", params: { page_path: "/api-key" }, consentTier: "basic" });
        dispatch(appActions.modelConfigUpdated(config));
        return persistLoginModeSelection({
          configClient: clients?.config,
          dispatch,
          userMode: "byok"
        });
      })
      .catch((error) => console.warn("save byok model config failed", error));
  }

  return (
    <div className="min-h-screen bg-canvas-oat px-4 pt-4 pb-8 relative overflow-hidden">
      <div className="absolute top-[-50px] right-[-30px] w-44 h-44 bg-action-sky/15 rounded-full blur-3xl" />
      <div className="absolute bottom-[-70px] left-[-50px] w-56 h-56 bg-action-sky/10 rounded-full blur-3xl" />

      <div className="flex items-center" style={PAGE_CORNER_ACTION_CONTAINER_STYLE}>
        <PageCornerActionButton
          label={t("common.cancel")}
          ariaLabel={t("common.cancel")}
          onClick={() => dispatch(appActions.navigate("/welcome"))}
          className="-mr-1"
          icon={<ChevronLeft aria-hidden="true" size={16} strokeWidth={2.2} className="shrink-0 -mr-0.5" />}
        />
      </div>

      <div className="max-w-lg mx-auto relative z-10 pt-8">
        <div className="text-center mb-5">
          <div className="flex justify-center mb-2" hidden />
          <h1 className="text-xl font-bold text-text-ink">{t("apiKey.title")}</h1>
          <p className="text-sm text-text-ink/50 mt-1.5">{t("apiKey.subtitle")}</p>
        </div>

        <div className={`${API_KEY_CARD_CLASS} mb-4`}>
          <div className="flex items-center gap-2 mb-1">
            <Brain size={18} className="text-action-sky" />
            <span className="font-semibold text-text-ink">{t("apiKey.llm")}</span>
            <span className="text-xs text-status-error font-normal">{t("apiKey.llmRequired")}</span>
          </div>
          <p className="text-xs text-text-ink/55 mb-5">{t("apiKey.llmHint")}</p>

          <div className="space-y-3.5">
            <Select
              label={t("apiKey.provider")}
              value={provider}
              onValueChange={changeProvider}
              className="select-control--subtle"
              options={providerOptions.map((option) => ({
                value: option.value,
                label: t(option.labelKey)
              }))}
            />

            <ConfigField label={t("apiKey.model")} placeholder={`${t("apiKey.examplePrefix")} ${selectedProvider.defaultModelId}`} value={model} onChange={setModel} />
            <ConfigField label={t("apiKey.endpoint")} placeholder={`${t("apiKey.examplePrefix")} ${selectedProvider.endpoint}`} value={endpoint} onChange={setEndpoint} />
            <PasswordConfigField
              label={t("apiKey.key")}
              placeholder="sk-..."
              value={apiKey}
              onChange={setApiKey}
              maskedValue={apiKeyMasked}
              showPassword={showApiKey}
              onTogglePassword={() => setShowApiKey((value) => !value)}
            />

            <button
              type="button"
              onClick={() => setShowAdvanced((value) => !value)}
              className="flex items-center gap-1.5 text-xs text-text-ink/55 hover:text-text-ink/75 cursor-pointer transition-colors"
            >
              {showAdvanced ? "-" : "+"} {t("apiKey.advanced")}
            </button>
            {showAdvanced && (
              <div className="space-y-3.5">
                <ConfigField label={t("apiKey.maxTokens")} placeholder={t("apiKey.noLimit")} value={maxTokens} onChange={setMaxTokens} suffix="tokens" />
                <ConfigField label={t("apiKey.dailyLimit")} placeholder={t("apiKey.noLimit")} value={dailyLimit} onChange={setDailyLimit} />
              </div>
            )}

            <div className="flex min-h-9 items-center justify-end gap-3">
              <ValidationMessage validation={llmValidation} stale={isTestStale} />
              <TestButton status={llmValidation.status} onClick={testLlmConnection} label={t("apiKey.test")} />
            </div>
          </div>
        </div>

        <div className={`${API_KEY_CARD_CLASS} mb-6`}>
          <div className="flex items-center gap-2 mb-1">
            <Search size={18} className="text-action-sky" />
            <span className="font-semibold text-text-ink">{t("apiKey.embedding")}</span>
          </div>
          <p className="text-xs text-text-ink/55 mb-5">{t("apiKey.embeddingHint")}</p>

          <div className="space-y-3.5">
            <Select
              label={t("apiKey.embeddingMode")}
              value={embeddingMode}
              onValueChange={(value) => setEmbeddingMode(value as EmbeddingMode)}
              className="select-control--subtle"
              options={[
                { value: "local", label: t("apiKey.localEmbedding") },
                { value: "custom", label: t("apiKey.customEmbedding") }
              ]}
            />
            {embeddingMode === "custom" && (
              <>
                <ConfigField
                  label={t("apiKey.embeddingModel")}
                  placeholder="text-embedding-3-small"
                  value={embeddingConfig.model}
                  onChange={(value) => updateEmbeddingConfig("model", value)}
                />
                <ConfigField
                  label={t("apiKey.embeddingEndpoint")}
                  placeholder="https://..."
                  value={embeddingConfig.endpoint}
                  onChange={(value) => updateEmbeddingConfig("endpoint", value)}
                />
                <PasswordConfigField
                  label={t("apiKey.embeddingKey")}
                  placeholder="sk-..."
                  value={embeddingConfig.apiKey}
                  onChange={(value) => updateEmbeddingConfig("apiKey", value)}
                  maskedValue={embeddingConfig.apiKeyMasked}
                  showPassword={showEmbeddingApiKey}
                  onTogglePassword={() => setShowEmbeddingApiKey((value) => !value)}
                />
                <div className="flex min-h-9 items-center justify-end gap-3">
                  <ValidationMessage validation={embeddingValidation} stale={isEmbeddingTestStale} />
                  <TestButton status={embeddingValidation.status} onClick={testEmbeddingConnection} label={t("apiKey.test")} />
                </div>
              </>
            )}
          </div>
        </div>

        <button
          type="button"
          disabled={!canSave}
          onClick={saveConfig}
          className={`w-full ${API_KEY_PRIMARY_BTN_CLASS}`}
        >
          {t("apiKey.next")}
        </button>
      </div>
    </div>
  );
}
