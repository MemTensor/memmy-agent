import { useState } from "react";
import { ChevronLeft, Image as ImageIcon, Mic } from "lucide-react";
import type { ModelProviderConfig } from "../api/config-client.js";
import { useAnalytics } from "../analytics/use-analytics.js";
import { persistLoginModeSelection } from "../app/login-mode.js";
import { useApiClients } from "../app/providers.js";
import { buildByokOnboardingGuidePatch, resolveByokModelCompletion } from "../app/routes.js";
import { PAGE_CORNER_ACTION_CONTAINER_STYLE, PageCornerActionButton } from "../components/language-toggle-button.js";
import { Select } from "../components/Select.js";
import { useTranslation } from "../i18n/use-translation.js";
import { appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
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
  createModelConfigValidationKey,
  type ModelConfigValidationState
} from "./model-config-validation.js";
import {
  ASR_DEFAULT_ENDPOINT,
  ASR_MODEL_ID,
  IMAGE_DEFAULT_ENDPOINTS,
  IMAGE_DEFAULT_MODEL_IDS,
  IMAGE_PROTOCOL_OPTIONS,
  createAsrModelFormValues,
  createAsrProviderConfig,
  createImageGenModelFormValues,
  createImageGenProviderConfig,
  createTestModelConnectionMessages,
  hydrateModelConfigForm,
  testModelConnection,
  type ImageProtocol
} from "./model-config.js";

export function ApiKeyOptionalPage() {
  const { state, dispatch } = useAppState();
  const { clients } = useApiClients();
  const { t } = useTranslation();
  const { track } = useAnalytics();
  const initialModelForm = hydrateModelConfigForm(state.modelConfig, "local");
  const initialAsrModel = initialModelForm.asrModelId;
  const initialAsrEndpoint = initialModelForm.asrEndpoint || ASR_DEFAULT_ENDPOINT;
  const [asrModel, setAsrModel] = useState(initialAsrModel);
  const [asrEndpoint, setAsrEndpoint] = useState(initialAsrEndpoint);
  const [asrApiKey, setAsrApiKey] = useState(initialModelForm.asrApiKey);
  const [showAsrApiKey, setShowAsrApiKey] = useState(false);
  const [asrValidation, setAsrValidation] = useState<ModelConfigValidationState>(initialModelForm.asrValidation);
  const [asrWarningAcknowledged, setAsrWarningAcknowledged] = useState(false);
  const [asrApiKeyMasked] = useState(initialModelForm.asrApiKeyMasked);
  const asrFormValues = createAsrModelFormValues(asrModel, asrEndpoint, asrApiKey, asrApiKeyMasked);
  const isAsrUsable = canSaveModelConfig(asrFormValues, asrValidation);
  const asrTestKey = createModelConfigValidationKey(asrFormValues);
  const isAsrTestStale = Boolean(asrValidation.testedKey && asrValidation.testedKey !== asrTestKey);
  const [imageGenProtocol, setImageGenProtocol] = useState<ImageProtocol>(initialModelForm.imageGenProtocol);
  const [imageGenModel, setImageGenModel] = useState(initialModelForm.imageGenModelId);
  const [imageGenEndpoint, setImageGenEndpoint] = useState(initialModelForm.imageGenEndpoint);
  const [imageGenApiKey, setImageGenApiKey] = useState(initialModelForm.imageGenApiKey);
  const [showImageGenApiKey, setShowImageGenApiKey] = useState(false);
  const [imageGenValidation, setImageGenValidation] = useState<ModelConfigValidationState>(initialModelForm.imageGenValidation);
  const [imageGenWarningAcknowledged, setImageGenWarningAcknowledged] = useState(false);
  const [imageGenApiKeyMasked] = useState(initialModelForm.imageGenApiKeyMasked);
  const imageGenFormValues = createImageGenModelFormValues(imageGenProtocol, imageGenModel, imageGenEndpoint, imageGenApiKey, imageGenApiKeyMasked);
  const isImageGenUsable = canSaveModelConfig(imageGenFormValues, imageGenValidation);
  const imageGenTestKey = createModelConfigValidationKey(imageGenFormValues);
  const isImageGenTestStale = Boolean(imageGenValidation.testedKey && imageGenValidation.testedKey !== imageGenTestKey);
  const [optionalModelMissingWarning, setOptionalModelMissingWarning] = useState<OptionalModelMissingWarningKind | null>(null);
  const [modePersistencePending, setModePersistencePending] = useState(false);
  const [nextValidationError, setNextValidationError] = useState<"noInput" | "testRequired" | null>(null);

  function changeImageGenProtocol(nextProtocol: string) {
    const next = (IMAGE_PROTOCOL_OPTIONS.find((option) => option.value === nextProtocol)?.value ?? "openai") as ImageProtocol;
    setImageGenProtocol(next);
    setImageGenEndpoint(IMAGE_DEFAULT_ENDPOINTS[next]);
    setImageGenModel("");
    setImageGenApiKey("");
    setImageGenWarningAcknowledged(false);
  }

  function testAsrConnection() {
    testModelConnection({
      configClient: clients?.config,
      values: asrFormValues,
      setValidation: setAsrValidation,
      capability: "asr",
      secretTarget: "asr",
      messages: createTestModelConnectionMessages(t)
    });
  }

  function testImageGenConnection() {
    testModelConnection({
      configClient: clients?.config,
      values: imageGenFormValues,
      setValidation: setImageGenValidation,
      capability: "image",
      secretTarget: "image",
      messages: createTestModelConnectionMessages(t)
    });
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

  function createModelConfigDraft(): ModelProviderConfig {
    return {
      ...state.modelConfig,
      asr: isAsrUsable ? createAsrProviderConfig(asrModel, asrEndpoint, asrApiKey, asrApiKeyMasked) : null,
      imageGen: isImageGenUsable
        ? createImageGenProviderConfig(imageGenProtocol, imageGenModel, imageGenEndpoint, imageGenApiKey, imageGenApiKeyMasked)
        : null
    };
  }

  async function continueAfterWarning() {
    if (modePersistencePending) {
      return;
    }

    const configDraft = createModelConfigDraft();
    dispatch(appActions.modelConfigUpdated(configDraft));

    try {
      setModePersistencePending(true);
      const savedConfig = await (clients?.config.saveModelConfig(configDraft) ?? Promise.resolve(configDraft));
      dispatch(appActions.modelConfigUpdated(savedConfig));
      const byokCompletion = resolveByokModelCompletion({
        onboarding: state.bootstrap?.onboarding ?? buildByokOnboardingGuidePatch()
      });
      await persistLoginModeSelection({
        configClient: clients?.config,
        dispatch,
        userMode: "byok",
        onboarding: byokCompletion.onboardingPatch
      });
      dispatch(appActions.navigate(byokCompletion.nextRoute));
      track({ name: "byok_completed", params: {}, consentTier: "basic" });
    } catch (error) {
      console.error("save byok optional model config failed", error);
    } finally {
      setModePersistencePending(false);
    }
  }

  function skipOptionalModels() {
    if (modePersistencePending) {
      return;
    }

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

    setNextValidationError(null);

    const asrHasInput = Boolean(asrApiKey.trim());
    const imageGenHasInput = Boolean(imageGenApiKey.trim());

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
              maskedValue={asrApiKeyMasked}
              onTogglePassword={() => setShowAsrApiKey((value) => !value)}
            />
            <div className="flex min-h-9 items-center justify-end gap-3">
              <ValidationMessage validation={asrValidation} stale={isAsrTestStale} />
              <TestButton status={asrValidation.status} onClick={testAsrConnection} label={t("apiKey.test")} />
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
                label: t(option.labelKey)
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
              maskedValue={imageGenApiKeyMasked}
              onTogglePassword={() => setShowImageGenApiKey((value) => !value)}
            />
            <div className="flex min-h-9 items-center justify-end gap-3">
              <ValidationMessage validation={imageGenValidation} stale={isImageGenTestStale} />
              <TestButton status={imageGenValidation.status} onClick={testImageGenConnection} label={t("apiKey.test")} />
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
