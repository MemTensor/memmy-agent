import { useModelConnectionTest } from "./use-model-connection-test.js";
import { bindSavedValidation, endpointCredentialSignature, resolveModelCredentials, type SavedEndpointIdentity } from "./model-credentials.js";
import { useRef, useState } from "react";
import { ChevronLeft, Image as ImageIcon, Mic } from "lucide-react";
import { useAnalytics } from "../analytics/use-analytics.js";
import { persistLoginModeSelection } from "../app/login-mode.js";
import { useApiClients } from "../app/providers.js";
import { buildByokOnboardingGuidePatch, resolveByokModelCompletion } from "../app/routes.js";
import { PAGE_CORNER_ACTION_CONTAINER_STYLE, PageCornerActionButton } from "../components/language-toggle-button.js";
import { ModelProviderLogo } from "../components/model-provider-logo.js";
import { Select } from "../components/Select.js";
import { useTranslation } from "../i18n/use-translation.js";
import { appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import {
  assignedCatalogEndpointId,
  assignCatalogPreset,
  createModelWorkspace,
  modelConfigInput,
  upsertByokPreset
} from "../state/model-workspace.js";
import {
  API_KEY_CARD_CLASS,
  API_KEY_PRIMARY_BTN_CLASS,
  API_KEY_SECONDARY_BTN_CLASS,
  ConfigField,
  PasswordConfigField,
  TestButton,
  ValidationMessage
} from "./api-key-form-fields.js";
import {
  OptionalModelMissingWarningModal,
  resolveOptionalModelMissingWarning,
  type OptionalModelMissingWarningKind
} from "./optional-model-missing-warning-modal.js";
import {
  canSaveModelConfig,
  createModelConfigValidationKey
} from "./model-config-validation.js";
import {
  ASR_DEFAULT_ENDPOINT,
  ASR_MODEL_ID,
  IMAGE_DEFAULT_ENDPOINTS,
  IMAGE_DEFAULT_MODEL_IDS,
  IMAGE_PROTOCOL_OPTIONS,
  createAsrModelFormValues,
  createImageGenModelFormValues,
  createTestModelConnectionMessages,
  hydrateModelConfigForm,
  type ImageProtocol
} from "./model-config.js";


export function ApiKeyOptionalPage() {
  const { state, dispatch } = useAppState();
  const { clients } = useApiClients();
  const { t } = useTranslation();
  const { track } = useAnalytics();
  const [initialModelForm] = useState(() => hydrateModelConfigForm(state.modelConfig, "local"));
  const [initialWorkspace] = useState(() => createModelWorkspace(state.modelConfig));
  const initialAsrEndpointId = assignedCatalogEndpointId(initialWorkspace, "byok", "asr");
  const initialImageEndpointId = assignedCatalogEndpointId(initialWorkspace, "byok", "image_generation");
  const savedEndpointIdentitiesRef = useRef<Partial<Record<"asr" | "imageGeneration", SavedEndpointIdentity>>>({
    ...(initialAsrEndpointId
      ? { asr: { endpointId: initialAsrEndpointId, credentialSignature: endpointCredentialSignature("qwen", "dashscope-input-audio-chat", initialModelForm.asrEndpoint, initialModelForm.asrApiKey, initialModelForm.asrApiKeyMasked) } }
      : {}),
    ...(initialImageEndpointId
      ? { imageGeneration: { endpointId: initialImageEndpointId, credentialSignature: endpointCredentialSignature(initialModelForm.imageGenProtocol, initialModelForm.imageGenProtocol === "qwen" ? "dashscope-multimodal-generation" : "openai-images", initialModelForm.imageGenEndpoint, initialModelForm.imageGenApiKey, initialModelForm.imageGenApiKeyMasked) } }
      : {})
  });
  const initialAsrModel = initialModelForm.asrModelId;
  const initialAsrEndpoint = initialModelForm.asrEndpoint || ASR_DEFAULT_ENDPOINT;
  const [asrModel, setAsrModel] = useState(initialAsrModel);
  const [asrEndpoint, setAsrEndpoint] = useState(initialAsrEndpoint);
  const [asrApiKey, setAsrApiKey] = useState(initialModelForm.asrApiKey);
  const [showAsrApiKey, setShowAsrApiKey] = useState(false);
  const [asrWarningAcknowledged, setAsrWarningAcknowledged] = useState(false);
  const [asrApiKeyMasked] = useState(initialModelForm.asrApiKeyMasked);
  const asrFormValues = resolveModelCredentials({
    ...createAsrModelFormValues(asrModel, asrEndpoint, asrApiKey, asrApiKeyMasked),
    protocol: "dashscope-input-audio-chat"
  }, savedEndpointIdentitiesRef.current.asr);
  const { validation: asrValidation, isStale: isAsrTestStale, testConnection: testAsrConnection } = useModelConnectionTest({
    configClient: clients?.config,
    values: asrFormValues,
    initialValidation: () => bindSavedValidation(initialModelForm.asrValidation, asrFormValues),
    secretTarget: "asr",
    capability: "asr",
    messages: createTestModelConnectionMessages(t)
  });
  const isAsrUsable = canSaveModelConfig(asrFormValues, asrValidation);
  const asrTestKey = createModelConfigValidationKey(asrFormValues);
  const [imageGenProtocol, setImageGenProtocol] = useState<ImageProtocol>(initialModelForm.imageGenProtocol);
  const [imageGenModel, setImageGenModel] = useState(initialModelForm.imageGenModelId);
  const [imageGenEndpoint, setImageGenEndpoint] = useState(initialModelForm.imageGenEndpoint);
  const [imageGenApiKey, setImageGenApiKey] = useState(initialModelForm.imageGenApiKey);
  const [showImageGenApiKey, setShowImageGenApiKey] = useState(false);
  const [imageGenWarningAcknowledged, setImageGenWarningAcknowledged] = useState(false);
  const [imageGenApiKeyMasked] = useState(initialModelForm.imageGenApiKeyMasked);
  const imageGenFormValues = resolveModelCredentials({
    ...createImageGenModelFormValues(imageGenProtocol, imageGenModel, imageGenEndpoint, imageGenApiKey, imageGenApiKeyMasked),
    protocol: imageGenProtocol === "qwen" ? "dashscope-multimodal-generation" : "openai-images"
  }, savedEndpointIdentitiesRef.current.imageGeneration);
  const { validation: imageGenValidation, isStale: isImageGenTestStale, testConnection: testImageGenConnection } = useModelConnectionTest({
    configClient: clients?.config,
    values: imageGenFormValues,
    initialValidation: () => bindSavedValidation(initialModelForm.imageGenValidation, imageGenFormValues),
    secretTarget: "image",
    capability: "image",
    messages: createTestModelConnectionMessages(t)
  });
  const isImageGenUsable = canSaveModelConfig(imageGenFormValues, imageGenValidation);
  const imageGenTestKey = createModelConfigValidationKey(imageGenFormValues);
  const imageGenEndpointProtocol = imageGenProtocol === "qwen"
    ? "dashscope-multimodal-generation"
    : "openai-images";
  const asrCredentialSignature = endpointCredentialSignature(
    "qwen",
    "dashscope-input-audio-chat",
    asrEndpoint,
    asrApiKey,
    asrApiKeyMasked
  );
  const imageGenCredentialSignature = endpointCredentialSignature(
    imageGenProtocol,
    imageGenEndpointProtocol,
    imageGenEndpoint,
    imageGenApiKey,
    imageGenApiKeyMasked
  );
  const saveSignature = JSON.stringify({
    asr: isAsrUsable ? asrTestKey : null,
    imageGeneration: isImageGenUsable ? imageGenTestKey : null
  });
  const savedCatalogSignatureRef = useRef<string | null>(null);

  const [optionalModelMissingWarning, setOptionalModelMissingWarning] = useState<OptionalModelMissingWarningKind | null>(null);
  const [modePersistencePending, setModePersistencePending] = useState(false);
  const [nextValidationError, setNextValidationError] = useState<"noInput" | "testRequired" | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  function changeImageGenProtocol(nextProtocol: string) {
    const next = (IMAGE_PROTOCOL_OPTIONS.find((option) => option.value === nextProtocol)?.value ?? "openai") as ImageProtocol;
    setImageGenProtocol(next);
    setImageGenEndpoint(IMAGE_DEFAULT_ENDPOINTS[next]);
    setImageGenModel("");
    setImageGenApiKey("");
    setImageGenWarningAcknowledged(false);
  }

  function closeOptionalModelMissingWarning() {
    if (optionalModelMissingWarning === "asr" || optionalModelMissingWarning === "both") {
      setAsrWarningAcknowledged(true);
    }

    if (optionalModelMissingWarning === "imageGen" || optionalModelMissingWarning === "both") {
      setImageGenWarningAcknowledged(true);
    }

    setOptionalModelMissingWarning(null);
    void continueAfterWarning();
  }

  async function continueAfterWarning() {
    if (modePersistencePending || !clients?.config) {
      return;
    }

    setSaveError(null);
    try {
      setModePersistencePending(true);
      if (savedCatalogSignatureRef.current !== saveSignature) {
        const latest = await clients.config.getModelConfig();
        let workspace = createModelWorkspace(latest);
        if (isAsrUsable) {
          const asr = upsertByokPreset(workspace, {
            provider: "qwen",
            ...(asrFormValues.endpointId ? { endpointId: asrFormValues.endpointId } : {}),
            endpoint: asrEndpoint,
            protocol: "dashscope-input-audio-chat",
            ...(asrApiKey.trim() ? { apiKey: asrApiKey.trim() } : {}),
            ...(asrFormValues.apiKeyMasked ? { apiKeyMasked: asrFormValues.apiKeyMasked } : {}),
            model: asrModel || ASR_MODEL_ID,
            capabilities: ["asr"]
          });
          workspace = assignCatalogPreset(asr.workspace, "byok", "asr", asr.presetId);
        }
        if (isImageGenUsable) {
          const image = upsertByokPreset(workspace, {
            provider: imageGenProtocol,
            ...(imageGenFormValues.endpointId ? { endpointId: imageGenFormValues.endpointId } : {}),
            endpoint: imageGenEndpoint,
            protocol: imageGenEndpointProtocol,
            ...(imageGenApiKey.trim() ? { apiKey: imageGenApiKey.trim() } : {}),
            ...(imageGenFormValues.apiKeyMasked ? { apiKeyMasked: imageGenFormValues.apiKeyMasked } : {}),
            model: imageGenModel,
            capabilities: ["image_generation"]
          });
          workspace = assignCatalogPreset(image.workspace, "byok", "image_generation", image.presetId);
        }
        const savedConfig = await clients.config.saveModelCatalog(modelConfigInput(workspace));
        if (!savedConfig.catalog?.modelAssignments.byok.agent.candidates.length) {
          throw new Error("persisted BYOK Agent assignment is empty");
        }
        dispatch(appActions.modelConfigUpdated(savedConfig));
        const savedWorkspace = createModelWorkspace(savedConfig);
        const savedAsrEndpointId = assignedCatalogEndpointId(savedWorkspace, "byok", "asr");
        const savedImageEndpointId = assignedCatalogEndpointId(savedWorkspace, "byok", "image_generation");
        savedEndpointIdentitiesRef.current = {
          ...savedEndpointIdentitiesRef.current,
          ...(isAsrUsable && savedAsrEndpointId
            ? { asr: { endpointId: savedAsrEndpointId, credentialSignature: asrCredentialSignature } }
            : {}),
          ...(isImageGenUsable && savedImageEndpointId
            ? { imageGeneration: { endpointId: savedImageEndpointId, credentialSignature: imageGenCredentialSignature } }
            : {})
        };
        savedCatalogSignatureRef.current = saveSignature;
      }
      const byokCompletion = resolveByokModelCompletion({
        onboarding: state.bootstrap?.onboarding ?? buildByokOnboardingGuidePatch()
      });
      await persistLoginModeSelection({
        configClient: clients.config,
        dispatch,
        userMode: "byok",
        onboarding: byokCompletion.onboardingPatch
      });
      dispatch(appActions.navigate(byokCompletion.nextRoute));
      track({ name: "byok_completed", params: { user_mode: "byok" }, consentTier: "basic" });
    } catch (error) {
      console.error("save byok optional model config failed", error);
      setSaveError(optionalStepSaveErrorText(error, t));
    } finally {
      setModePersistencePending(false);
    }
  }

  function skipOptionalModels() {
    if (modePersistencePending) {
      return;
    }

    setSaveError(null);
    setNextValidationError(null);

    const nextWarning = resolveOptionalModelMissingWarning({
      asrMissing: !isAsrUsable && !asrWarningAcknowledged,
      imageGenMissing: !isImageGenUsable && !imageGenWarningAcknowledged
    });
    if (nextWarning) {
      setOptionalModelMissingWarning(nextWarning);
      return;
    }

    void continueAfterWarning();
  }

  function continueToNextStep() {
    if (modePersistencePending) {
      return;
    }

    setSaveError(null);
    setNextValidationError(null);

    const asrHasInput = Boolean(asrApiKey.trim() || asrApiKeyMasked);
    const imageGenHasInput = Boolean(imageGenApiKey.trim() || imageGenApiKeyMasked);

    if (!asrHasInput && !imageGenHasInput) {
      setNextValidationError("noInput");
      return;
    }

    if ((asrHasInput && !isAsrUsable) || (imageGenHasInput && !isImageGenUsable)) {
      setNextValidationError("testRequired");
      return;
    }

    void continueAfterWarning();
  }

  return (
    <div className="min-h-screen bg-canvas-oat px-4 pt-4 pb-8 relative overflow-hidden">
      <div className="absolute top-[-50px] right-[-30px] w-44 h-44 bg-action-sky/15 rounded-full blur-3xl" />
      <div className="absolute bottom-[-70px] left-[-50px] w-56 h-56 bg-action-sky/10 rounded-full blur-3xl" />

      <div className="flex items-center" style={PAGE_CORNER_ACTION_CONTAINER_STYLE}>
        <PageCornerActionButton
          label={t("common.cancel")}
          ariaLabel={t("common.cancel")}
          onClick={() => dispatch(appActions.navigate("/api-key-models"))}
          className="-mr-1"
          icon={<ChevronLeft aria-hidden="true" size={16} strokeWidth={2.2} className="shrink-0 -mr-0.5" />}
        />
      </div>

      <div className="max-w-lg mx-auto relative z-10 pt-8">
        <div className="text-center mb-5">
          <h1 className="text-xl font-bold text-text-ink">{t("apiKey.optionalPage.title")}</h1>
          <p className="text-sm text-text-ink/50 mt-1.5">{t("apiKey.optionalPage.subtitle")}</p>
        </div>

        <div className={`${API_KEY_CARD_CLASS} mb-4`}>
          <div className="flex items-center gap-2 mb-1">
            <Mic size={18} className="text-action-sky" />
            <span className="font-semibold text-text-ink">{t("apiKey.asr")}</span>
            <span className="text-xs text-text-ink/50 font-normal">{t("apiKey.optionalPage.optionalTag")}</span>
          </div>
          <p className="text-xs text-text-ink/55 mb-5">{t("apiKey.asrHint")}</p>

          <div className="space-y-3.5">
            <ConfigField
              label={t("apiKey.asrModel")}
              placeholder={ASR_MODEL_ID}
              value={asrModel}
              onChange={setAsrModel}
              readOnly
            />
            <ConfigField
              label={t("apiKey.asrEndpoint")}
              placeholder="https://..."
              value={asrEndpoint}
              onChange={setAsrEndpoint}
            />
            <PasswordConfigField
              label={t("apiKey.asrKey")}
              placeholder="sk-..."
              value={asrApiKey}
              onChange={(value) => {
                setAsrApiKey(value);
                setAsrWarningAcknowledged(false);
              }}
              showPassword={showAsrApiKey}
              maskedValue={asrFormValues.apiKeyMasked}
              onTogglePassword={() => setShowAsrApiKey((value) => !value)}
            />
            <div className="flex min-h-9 items-center justify-end gap-3">
              <ValidationMessage validation={asrValidation} stale={isAsrTestStale} credentialRequired={asrFormValues.requiresApiKey} />
              <TestButton status={isAsrTestStale || asrFormValues.requiresApiKey ? "idle" : asrValidation.status} onClick={testAsrConnection} label={t("apiKey.test")} />
            </div>
          </div>
        </div>

        <div className={`${API_KEY_CARD_CLASS} mb-6`}>
          <div className="flex items-center gap-2 mb-1">
            <ImageIcon size={18} className="text-action-sky" />
            <span className="font-semibold text-text-ink">{t("apiKey.imageGen")}</span>
            <span className="text-xs text-text-ink/50 font-normal">{t("apiKey.optionalPage.optionalTag")}</span>
          </div>
          <p className="text-xs text-text-ink/55 mb-5">{t("apiKey.imageGenHint")}</p>

          <div className="space-y-3.5">
            <Select
              label={t("apiKey.provider")}
              value={imageGenProtocol}
              onValueChange={changeImageGenProtocol}
              className="select-control--subtle"
              options={IMAGE_PROTOCOL_OPTIONS.map((option) => ({
                value: option.value,
                label: t(option.labelKey),
                icon: <ModelProviderLogo provider={option.value} size={16} />
              }))}
            />
            <ConfigField
              label={t("apiKey.imageGenModel")}
              placeholder={IMAGE_DEFAULT_MODEL_IDS[imageGenProtocol]}
              value={imageGenModel}
              onChange={setImageGenModel}
            />
            <ConfigField
              label={t("apiKey.imageGenEndpoint")}
              placeholder={IMAGE_DEFAULT_ENDPOINTS[imageGenProtocol]}
              value={imageGenEndpoint}
              onChange={setImageGenEndpoint}
            />
            <PasswordConfigField
              label={t("apiKey.imageGenKey")}
              placeholder="sk-..."
              value={imageGenApiKey}
              onChange={(value) => {
                setImageGenApiKey(value);
                setImageGenWarningAcknowledged(false);
              }}
              showPassword={showImageGenApiKey}
              maskedValue={imageGenFormValues.apiKeyMasked}
              onTogglePassword={() => setShowImageGenApiKey((value) => !value)}
            />
            <div className="flex min-h-9 items-center justify-end gap-3">
              <ValidationMessage validation={imageGenValidation} stale={isImageGenTestStale} credentialRequired={imageGenFormValues.requiresApiKey} />
              <TestButton status={isImageGenTestStale || imageGenFormValues.requiresApiKey ? "idle" : imageGenValidation.status} onClick={testImageGenConnection} label={t("apiKey.test")} />
            </div>
          </div>
        </div>

        {nextValidationError && (
          <div className="agent-model-error-notice mb-3" role="alert">
            <div className="agent-model-error-notice__header">
              <p className="agent-model-error-notice__title">
                {nextValidationError === "noInput"
                  ? t("apiKey.optionalPage.validationNoInput")
                  : t("apiKey.optionalPage.validationTestRequired")}
              </p>
            </div>
          </div>
        )}

        {saveError ? (
          <div className="agent-model-error-notice mb-3" role="alert">
            <div className="agent-model-error-notice__header">
              <p className="agent-model-error-notice__title">{saveError}</p>
            </div>
          </div>
        ) : null}

        <div className="flex gap-3">
          <button
            type="button"
            disabled={modePersistencePending}
            onClick={skipOptionalModels}
            className={`flex-1 ${API_KEY_SECONDARY_BTN_CLASS}`}
          >
            {t("apiKey.optionalPage.skip")}
          </button>
          <button
            type="button"
            disabled={modePersistencePending}
            onClick={continueToNextStep}
            className={`flex-1 ${API_KEY_PRIMARY_BTN_CLASS}`}
          >
            {t("apiKey.next")}
          </button>
        </div>
      </div>

      {optionalModelMissingWarning && <OptionalModelMissingWarningModal kind={optionalModelMissingWarning} onClose={closeOptionalModelMissingWarning} />}
    </div>
  );
}


function optionalStepSaveErrorText(
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
