import { useModelConnectionTest } from "./use-model-connection-test.js";
import { bindSavedValidation, endpointCredentialSignature, resolveModelCredentials, type SavedEndpointIdentity, chatProtocol } from "./model-credentials.js";
import { useRef, useState } from "react";
import { Brain, ChevronLeft, Search } from "lucide-react";
import { useAnalytics } from "../analytics/use-analytics.js";
import { persistLoginModeSelection } from "../app/login-mode.js";
import { useApiClients } from "../app/providers.js";
import { PAGE_CORNER_ACTION_CONTAINER_STYLE, PageCornerActionButton } from "../components/language-toggle-button.js";
import { ModelProviderLogo } from "../components/model-provider-logo.js";
import { Select } from "../components/Select.js";
import type { MessageKey } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";
import { appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import {
  assignedCatalogEndpointId,
  assignCatalogPreset,
  createModelWorkspace,
  modelConfigInput,
  setModelAssignment,
  upsertByokPreset
} from "../state/model-workspace.js";
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
  createModelConfigValidationKey
} from "./model-config-validation.js";
import {
  createTestModelConnectionMessages,
  fromProtocol,
  hydrateModelConfigForm
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
  { value: "doubao", labelKey: "apiKey.provider.doubao", endpoint: "https://ark.cn-beijing.volces.com/api/v3", defaultModelId: "doubao-pro-256k" },
  { value: "stepfun", labelKey: "apiKey.provider.stepfun", endpoint: "https://api.stepfun.com/v1", defaultModelId: "step-3.5-flash" },
  { value: "xiaomi", labelKey: "apiKey.provider.xiaomi", endpoint: "https://api.xiaomimimo.com/v1", defaultModelId: "mimo-v2.5-pro" }
];

const defaultProvider = providerOptions[0]!;

export function ApiKeyPage() {
  const { state, dispatch } = useAppState();
  const { clients } = useApiClients();
  const { t } = useTranslation();
  const { track } = useAnalytics();
  const [initialModelForm] = useState(() => hydrateModelConfigForm(state.modelConfig, "local"));
  const [initialWorkspace] = useState(() => createModelWorkspace(state.modelConfig));
  const initialAgentEndpointId = assignedCatalogEndpointId(initialWorkspace, "byok", "agent");
  const initialEmbeddingEndpointId = assignedCatalogEndpointId(initialWorkspace, "byok", "embedding");
  const initialProvider = fromProtocol(initialModelForm.protocol);
  const savedEndpointIdentitiesRef = useRef<Partial<Record<"agent" | "embedding", SavedEndpointIdentity>>>({
    ...(initialAgentEndpointId
      ? { agent: { endpointId: initialAgentEndpointId, credentialSignature: endpointCredentialSignature(initialProvider, chatProtocol(initialProvider), initialModelForm.endpoint, initialModelForm.apiKey, initialModelForm.apiKeyMasked) } }
      : {}),
    ...(initialEmbeddingEndpointId
      ? { embedding: { endpointId: initialEmbeddingEndpointId, credentialSignature: endpointCredentialSignature("openai", "openai-embeddings", initialModelForm.embEndpoint, initialModelForm.embApiKey, initialModelForm.embApiKeyMasked) } }
      : {})
  });
  const [provider, setProvider] = useState(initialProvider);
  const selectedProvider = providerOptions.find((option) => option.value === provider) ?? defaultProvider;
  const [endpoint, setEndpoint] = useState(initialModelForm.endpoint || selectedProvider.endpoint);
  const [model, setModel] = useState(initialModelForm.modelId);
  const [apiKey, setApiKey] = useState(initialModelForm.apiKey);
  const [apiKeyMasked] = useState(initialModelForm.apiKeyMasked);
  const [showApiKey, setShowApiKey] = useState(false);
  const modelFormValues = resolveModelCredentials({
    protocol: chatProtocol(provider),
    provider,
    endpoint,
    model,
    apiKey,
    apiKeyMasked,
    hasExistingApiKey: Boolean(apiKeyMasked)
  }, savedEndpointIdentitiesRef.current.agent);
  const { validation: llmValidation, isStale: isTestStale, testConnection: testLlmConnection } = useModelConnectionTest({
    configClient: clients?.config,
    values: modelFormValues,
    initialValidation: () => bindSavedValidation(initialModelForm.llmValidation, modelFormValues),
    secretTarget: "primary",
    messages: createTestModelConnectionMessages(t)
  });
  const initialEmbeddingMode: EmbeddingMode = initialWorkspace.catalog.modelAssignments.byok.embedding
    ? "custom"
    : "local";
  const [embeddingMode, setEmbeddingMode] = useState<EmbeddingMode>(initialEmbeddingMode);
  const [embeddingConfig, setEmbeddingConfig] = useState<EmbeddingCustomConfig>({
    model: initialModelForm.embModelId,
    endpoint: initialModelForm.embEndpoint,
    apiKey: initialModelForm.embApiKey,
    apiKeyMasked: initialModelForm.embApiKeyMasked
  });
  const [showEmbeddingApiKey, setShowEmbeddingApiKey] = useState(false);
  const embeddingFormValues = resolveModelCredentials({
    protocol: "openai-embeddings",
    provider: "openai",
    endpoint: embeddingConfig.endpoint,
    model: embeddingConfig.model,
    apiKey: embeddingConfig.apiKey,
    apiKeyMasked: embeddingConfig.apiKeyMasked,
    hasExistingApiKey: Boolean(embeddingConfig.apiKeyMasked)
  }, savedEndpointIdentitiesRef.current.embedding);
  const { validation: embeddingValidation, isStale: isEmbeddingTestStale, testConnection: testEmbeddingConnection } = useModelConnectionTest({
    configClient: clients?.config,
    values: embeddingFormValues,
    initialValidation: () => bindSavedValidation(initialModelForm.embValidation, embeddingFormValues),
    secretTarget: "embedding",
    capability: "embedding",
    enabled: embeddingMode === "custom",
    messages: createTestModelConnectionMessages(t)
  });
  const canSave = canSaveModelConfig(modelFormValues, llmValidation)
    && canSaveOptionalModelConfig(embeddingMode === "custom", embeddingFormValues, embeddingValidation);
  const [savePending, setSavePending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const testedKey = createModelConfigValidationKey(modelFormValues);
  const embeddingTestKey = createModelConfigValidationKey(embeddingFormValues);
  const agentCredentialSignature = endpointCredentialSignature(
    provider,
    chatProtocol(provider),
    endpoint,
    apiKey,
    apiKeyMasked
  );
  const embeddingCredentialSignature = endpointCredentialSignature(
    "openai",
    "openai-embeddings",
    embeddingConfig.endpoint,
    embeddingConfig.apiKey,
    embeddingConfig.apiKeyMasked
  );
  const saveSignature = `${embeddingMode}\n${testedKey}\n${embeddingTestKey}`;
  const savedCatalogSignatureRef = useRef<string | null>(null);


  function changeProvider(nextProvider: string) {
    const next = providerOptions.find((option) => option.value === nextProvider) ?? defaultProvider;
    setProvider(next.value);
    setEndpoint(next.endpoint);
    setModel("");
    setApiKey("");
  }

  function updateEmbeddingConfig(field: keyof EmbeddingCustomConfig, value: string) {
    setEmbeddingConfig((current) => ({ ...current, [field]: value }));
  }

  async function saveConfig() {
    if (!canSave || !clients?.config || savePending) {
      return;
    }
    setSaveError(null);
    setSavePending(true);
    try {
      if (savedCatalogSignatureRef.current !== saveSignature) {
        const latest = await clients.config.getModelConfig();
        let workspace = createModelWorkspace(latest);
        // Preserve explicit follow routing when rotating the primary credential.
        // Independent role assignments must keep their existing endpoint and key.
        const evolutionFollows = latest.memmyMemory?.evolution?.mode === "follow";
        const summaryFollowsPrimary = evolutionFollows && latest.memmyMemory?.summary?.mode === "follow";
        const agent = upsertByokPreset(workspace, {
          provider,
          ...(modelFormValues.endpointId ? { endpointId: modelFormValues.endpointId } : {}),
          endpoint,
          protocol: chatProtocol(provider),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...(modelFormValues.apiKeyMasked ? { apiKeyMasked: modelFormValues.apiKeyMasked } : {}),
          model,
          capabilities: ["agent", ...(evolutionFollows ? ["memory_evolution" as const] : []),
            ...(summaryFollowsPrimary ? ["memory_summary" as const] : [])]
        });
        workspace = assignCatalogPreset(agent.workspace, "byok", "agent", agent.presetId);
        if (evolutionFollows) workspace = assignCatalogPreset(workspace, "byok", "memory_evolution", agent.presetId);
        if (summaryFollowsPrimary) workspace = assignCatalogPreset(workspace, "byok", "memory_summary", agent.presetId);
        const savedEmbeddingIdentity = savedEndpointIdentitiesRef.current.embedding;
        if (embeddingMode === "custom") {
          const embedding = upsertByokPreset(workspace, {
            provider: "openai",
            ...(embeddingFormValues.endpointId ? { endpointId: embeddingFormValues.endpointId } : {}),
            endpoint: embeddingConfig.endpoint,
            protocol: "openai-embeddings",
            ...(embeddingConfig.apiKey.trim() ? { apiKey: embeddingConfig.apiKey.trim() } : {}),
            ...(embeddingFormValues.apiKeyMasked ? { apiKeyMasked: embeddingFormValues.apiKeyMasked } : {}),
            model: embeddingConfig.model,
            capabilities: ["embedding"]
          });
          workspace = assignCatalogPreset(embedding.workspace, "byok", "embedding", embedding.presetId);
        } else {
          workspace = setModelAssignment(workspace, "byok", "embedding", null);
        }
        const saved = await clients.config.saveModelCatalog(modelConfigInput(workspace));
        if (!saved.catalog?.modelAssignments.byok.agent.candidates.length) {
          throw new Error("persisted BYOK Agent assignment is empty");
        }
        track({ name: "model_config_saved", params: { page_path: "/api-key" }, consentTier: "basic" });
        dispatch(appActions.modelConfigUpdated(saved));
        const savedWorkspace = createModelWorkspace(saved);
        const savedAgentEndpointId = assignedCatalogEndpointId(savedWorkspace, "byok", "agent");
        const savedEmbeddingEndpointId = assignedCatalogEndpointId(savedWorkspace, "byok", "embedding");
        savedEndpointIdentitiesRef.current = {
          ...(savedAgentEndpointId
            ? { agent: { endpointId: savedAgentEndpointId, credentialSignature: agentCredentialSignature } }
            : {}),
          ...(savedEmbeddingEndpointId
            ? { embedding: { endpointId: savedEmbeddingEndpointId, credentialSignature: embeddingCredentialSignature } }
            : embeddingMode === "local" && savedEmbeddingIdentity
              ? { embedding: savedEmbeddingIdentity }
            : {})
        };
        savedCatalogSignatureRef.current = saveSignature;
      }
      await persistLoginModeSelection({ configClient: clients.config, dispatch, userMode: "byok" });
      dispatch(appActions.navigate("/api-key-models"));
    } catch (error) {
      console.error("save byok model config failed", error);
      setSaveError(firstStepSaveErrorText(error, t));
    } finally {
      setSavePending(false);
    }
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
                label: t(option.labelKey),
                icon: <ModelProviderLogo provider={option.value} size={16} />
              }))}
            />

            <ConfigField label={t("apiKey.model")} placeholder={`${t("apiKey.examplePrefix")} ${selectedProvider.defaultModelId}`} value={model} onChange={setModel} />
            <ConfigField label={t("apiKey.endpoint")} placeholder={`${t("apiKey.examplePrefix")} ${selectedProvider.endpoint}`} value={endpoint} onChange={setEndpoint} />
            <PasswordConfigField
              label={t("apiKey.key")}
              placeholder="sk-..."
              value={apiKey}
              onChange={setApiKey}
              maskedValue={modelFormValues.apiKeyMasked}
              showPassword={showApiKey}
              onTogglePassword={() => setShowApiKey((value) => !value)}
            />

            <div className="flex min-h-9 items-center justify-end gap-3">
              <ValidationMessage validation={llmValidation} stale={isTestStale} credentialRequired={modelFormValues.requiresApiKey} />
              <TestButton status={isTestStale || modelFormValues.requiresApiKey ? "idle" : llmValidation.status} onClick={testLlmConnection} label={t("apiKey.test")} />
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
            {embeddingMode === "custom" ? (
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
                  maskedValue={embeddingFormValues.apiKeyMasked}
                  showPassword={showEmbeddingApiKey}
                  onTogglePassword={() => setShowEmbeddingApiKey((value) => !value)}
                />
                <div className="flex min-h-9 items-center justify-end gap-3">
                  <ValidationMessage validation={embeddingValidation} stale={isEmbeddingTestStale} credentialRequired={embeddingFormValues.requiresApiKey} />
                  <TestButton status={isEmbeddingTestStale || embeddingFormValues.requiresApiKey ? "idle" : embeddingValidation.status} onClick={testEmbeddingConnection} label={t("apiKey.test")} />
                </div>
              </>
            ) : null}
          </div>
        </div>

        <button
          type="button"
          disabled={!canSave || !clients?.config || savePending}
          onClick={() => void saveConfig()}
          className={`w-full ${API_KEY_PRIMARY_BTN_CLASS}`}
        >
          {t("apiKey.next")}
        </button>
        {saveError ? <p className="mt-3 text-[12px] text-left leading-relaxed text-red-500" role="alert">{saveError}</p> : null}
      </div>
    </div>
  );
}


function firstStepSaveErrorText(
  error: unknown,
  t: ReturnType<typeof useTranslation>["t"]
): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (code === "model_config_changed") return t("settings.model.configChanged");
  if (code === "config_write_busy") return t("settings.modelWorkspace.saveBusy");
  return error instanceof Error && error.message
    ? error.message
    : t("settings.modelWorkspace.saveFailed");
}
