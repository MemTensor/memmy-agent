/** Model page module. */
import { useState, type ReactNode } from "react";
import { Brain, Check, CheckCircle2, ChevronLeft, Cog, Eye, EyeOff, Lightbulb, Loader2, XCircle } from "lucide-react";
import { useApiClients } from "../app/providers.js";
import { useAnalytics } from "../analytics/use-analytics.js";
import { PAGE_CORNER_ACTION_CONTAINER_STYLE, PageCornerActionButton } from "../components/language-toggle-button.js";
import { Select } from "../components/Select.js";
import { useTranslation } from "../i18n/use-translation.js";
import { appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import { createModelConfigValidationKey, type ModelConfigValidationState } from "./model-config-validation.js";
import { API_KEY_PRIMARY_BTN_CLASS } from "./api-key-form-fields.js";
import {
  DEFAULT_MODEL_IDS,
  PROTOCOL_OPTIONS,
  canUseModelConfig,
  createMemmyMemoryProviderConfig,
  createModelFormValues,
  createModelProtocolPatch,
  createTestModelConnectionMessages,
  hydrateModelConfigForm,
  testModelConnection,
  type PrimaryModelValues,
  type Protocol,
  type ModelConfig
} from "./model-config.js";

/** Type definition for test status. */
type TestStatus = ModelConfigValidationState["status"];

/** Contract for model card props. */
interface ModelCardProps {
  icon: ReactNode;
  title: string;
  subtitle: string;
  hint?: string;
  cfg: ModelConfig;
  primary: PrimaryModelValues;
  onPatch: (patch: Partial<ModelConfig>) => void;
  onTest: () => void;
}

/** Contract for field props. */
interface FieldProps {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}

/** Contract for password field props. */
interface PasswordFieldProps extends FieldProps {
  show: boolean;
  maskedValue?: string;
  onToggle: () => void;
}

/** Contract for test button props. */
interface TestButtonProps {
  status: TestStatus;
  onClick: () => void;
  disabled: boolean;
}

/** Contract for validation message props. */
interface ValidationMessageProps {
  validation: ModelConfigValidationState;
  stale: boolean;
}

/** Handles model page. */
export function ModelPage() {
  const { state, dispatch } = useAppState();
  const { clients } = useApiClients();
  const { t } = useTranslation();
  const { track } = useAnalytics();
  const initialModelForm = hydrateModelConfigForm(state.modelConfig, "local");
  const [primaryModel] = useState<PrimaryModelValues>(() => ({
    protocol: initialModelForm.protocol,
    modelId: initialModelForm.modelId,
    endpoint: initialModelForm.endpoint,
    apiKey: initialModelForm.apiKey,
    apiKeyMasked: state.modelConfig.apiKeyMasked,
    configured: state.modelConfig.configured
  }));
  const [mem, setMem] = useState<ModelConfig>(() => initialModelForm.memoryModel);
  const [skill, setSkill] = useState<ModelConfig>(() => initialModelForm.skillModel);
  const [savePending, setSavePending] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<{ text: string; tone: "error" | "success" } | null>(null);
  const memoryValues = createModelFormValues(mem, primaryModel);
  const skillValues = createModelFormValues(skill, primaryModel);
  const canContinue = canUseModelConfig(mem, memoryValues) && canUseModelConfig(skill, skillValues);

  /** Handles patch mem. */
  function patchMem(patch: Partial<ModelConfig>) {
    setMem((current) => ({ ...current, ...patch }));
  }

  /** Handles patch skill. */
  function patchSkill(patch: Partial<ModelConfig>) {
    setSkill((current) => ({ ...current, ...patch }));
  }

  /** Handles test model config connection. */
  function testModelConfigConnection(config: ModelConfig, patch: (patch: Partial<ModelConfig>) => void, secretTarget: "memory" | "skill") {
    const values = createModelFormValues(config, primaryModel);
    testModelConnection({
      configClient: clients?.config,
      values,
      setValidation: (validation) => patch({ validation }),
      secretTarget,
      messages: createTestModelConnectionMessages(t)
    });
  }

  /** Handles continue to next step. */
  async function continueToNextStep() {
    if (!canContinue || savePending) {
      return;
    }
    setSaveFeedback(null);

    const nextConfig = {
      ...state.modelConfig,
      memmyMemory: createMemmyMemoryProviderConfig(mem, skill, primaryModel)
    };

    try {
      setSavePending(true);
      const savedConfig = await (clients?.config.saveModelConfig(nextConfig) ?? Promise.resolve(nextConfig));
      dispatch(appActions.modelConfigUpdated(savedConfig));
      dispatch(appActions.navigate("/api-key-optional"));
      track({ name: "model_config_saved", params: { page_path: "/api-key-models" }, consentTier: "basic" });
    } catch (error) {
      console.error("save byok role model config failed", error);
      setSaveFeedback({ text: t("login.error.modePersistenceFailed"), tone: "error" });
    } finally {
      setSavePending(false);
    }
  }

  return (
    <div className="min-h-screen bg-canvas-oat px-4 pt-4 pb-8 relative">
      <div className="flex items-center" style={PAGE_CORNER_ACTION_CONTAINER_STYLE}>
        <PageCornerActionButton
          label={t("common.cancel")}
          ariaLabel={t("common.cancel")}
          onClick={() => dispatch(appActions.navigate("/api-key"))}
          className="-mr-1"
          icon={<ChevronLeft aria-hidden="true" size={16} strokeWidth={2.2} className="shrink-0 -mr-0.5" />}
        />
      </div>

      <div className="max-w-lg mx-auto pt-8">
        <div className="text-center mb-5">
          <h1 className="text-xl font-bold text-text-ink">
            {t("apiKey.modelPage.title")}
          </h1>
          <p className="text-sm text-text-ink/50 mt-1.5">
            {t("apiKey.modelPage.subtitle")}
          </p>
        </div>

        <ModelCard
          icon={<Brain size={18} className="text-action-sky" />}
          title={t("apiKey.modelPage.memoryTitle")}
          subtitle={t("apiKey.modelPage.memorySubtitle")}
          hint={t("apiKey.modelPage.memoryHint")}
          cfg={mem}
          primary={primaryModel}
          onPatch={patchMem}
          onTest={() => testModelConfigConnection(mem, patchMem, "memory")}
        />

        <ModelCard
          icon={<Cog size={18} className="text-action-sky" />}
          title={t("apiKey.modelPage.skillTitle")}
          subtitle={t("apiKey.modelPage.skillSubtitle")}
          cfg={skill}
          primary={primaryModel}
          onPatch={patchSkill}
          onTest={() => testModelConfigConnection(skill, patchSkill, "skill")}
        />

        <button
          type="button"
          disabled={!canContinue || savePending}
          onClick={() => void continueToNextStep()}
          className={`w-full ${API_KEY_PRIMARY_BTN_CLASS}`}
        >
          {t("apiKey.next")}
        </button>
        {saveFeedback ? (
          <p className="mt-3 text-[12px] text-left leading-relaxed text-red-500">{saveFeedback.text}</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Renders a single model configuration card.
 *
 * @param props The model card props.
 * @returns The model card node.
 */
function ModelCard(props: ModelCardProps) {
  const { t } = useTranslation();

  /**
   * Toggles whether to reuse the primary model; when disabling reuse, prefills the blank config from the primary model.
   */
  function toggleReuse() {
    const nextReuse = !props.cfg.reuse;
    if (!nextReuse && props.primary.modelId && !props.cfg.modelId) {
      props.onPatch({
        reuse: false,
        protocol: props.primary.protocol,
        modelId: props.primary.modelId,
        endpoint: props.primary.endpoint,
        apiKey: props.primary.apiKey,
        apiKeyMasked: props.primary.apiKeyMasked ?? "",
        configured: Boolean(props.primary.configured || props.primary.apiKeyMasked)
      });
      return;
    }

    props.onPatch({ reuse: nextReuse });
  }

  const formValues = createModelFormValues(props.cfg, props.primary);
  const isTestStale = Boolean(props.cfg.validation.testedKey && props.cfg.validation.testedKey !== createModelConfigValidationKey(formValues));

  return (
    <div className="bg-background-paper rounded-card-lg shadow-lg border border-border-stone/60 p-6 mb-4">
      <div className="flex items-center gap-2 mb-1">
        {props.icon}
        <span className="font-semibold text-text-ink">{props.title}</span>
      </div>
      <p className="text-xs text-text-ink/55 mb-4">{props.subtitle}</p>

      <button
        type="button"
        role="checkbox"
        aria-checked={props.cfg.reuse}
        onClick={toggleReuse}
        className="flex items-center gap-2.5 cursor-pointer select-none"
      >
        <span
          className={`w-4 h-4 rounded flex items-center justify-center border transition-colors ${
            props.cfg.reuse
              ? "bg-action-sky border-action-sky"
              : "bg-background-paper border-border-stone"
          }`}
        >
          {props.cfg.reuse && <Check size={12} strokeWidth={3} className="text-white" />}
        </span>
        <span className="text-sm text-text-ink/75">{t("apiKey.modelPage.reusePrevious")}</span>
      </button>

      {props.hint && (
        <div className="flex items-start gap-2 mt-3 p-3 bg-action-sky/5 rounded-card border border-action-sky/15">
          <Lightbulb size={14} className="text-action-sky mt-0.5 shrink-0" />
          <p className="text-xs text-text-ink/65 leading-relaxed">{props.hint}</p>
        </div>
      )}

      {!props.cfg.reuse && (
        <div className="space-y-3.5 mt-4 pt-4 border-t border-border-stone/30">
          <Select
            label={t("apiKey.provider")}
            value={props.cfg.protocol}
            onValueChange={(value) => {
              const protocol = value as Protocol;
              props.onPatch(createModelProtocolPatch(protocol));
            }}
            className="select-control--subtle"
            options={PROTOCOL_OPTIONS.map((option) => ({
              value: option.value,
              label: t(option.labelKey)
            }))}
          />

          <Field
            label={t("apiKey.model")}
            placeholder={`${t("apiKey.examplePrefix")} ${DEFAULT_MODEL_IDS[props.cfg.protocol]}`}
            value={props.cfg.modelId}
            onChange={(value) => props.onPatch({ modelId: value })}
          />
          <Field
            label={t("apiKey.endpoint")}
            placeholder="https://..."
            value={props.cfg.endpoint}
            onChange={(value) => props.onPatch({ endpoint: value })}
          />
          <PasswordField
            label="API Key"
            placeholder="sk-..."
            value={props.cfg.apiKey}
            onChange={(value) => props.onPatch({ apiKey: value })}
            show={props.cfg.showKey}
            maskedValue={props.cfg.apiKeyMasked}
            onToggle={() => props.onPatch({ showKey: !props.cfg.showKey })}
          />
          <div className="flex min-h-9 items-center justify-end gap-3">
            <ValidationMessage validation={props.cfg.validation} stale={isTestStale} />
            <TestButton status={props.cfg.validation.status} onClick={props.onTest} disabled={false} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Renders a plain text field.
 *
 * @param props The field props.
 * @returns The text input node.
 */
function Field(props: FieldProps) {
  return (
    <div>
      <label className="block text-xs text-text-ink/65 mb-1.5 font-normal">{props.label}</label>
      <input
        type="text"
        placeholder={props.placeholder}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        className="w-full px-4 py-2.5 border border-border-stone rounded-input text-sm bg-canvas-oat/30 focus:outline-none placeholder:text-text-ink/45"
      />
    </div>
  );
}

/**
 * Renders the API Key password field.
 *
 * @param props The password field props.
 * @returns An input node with a show/hide button.
 */
function PasswordField(props: PasswordFieldProps) {
  const { t } = useTranslation();
  const placeholder = !props.value.trim() && props.maskedValue ? props.maskedValue : props.placeholder;

  return (
    <div>
      <label className="block text-xs text-text-ink/65 mb-1.5 font-normal">{props.label}</label>
      <div className="relative">
        <input
          type={props.show ? "text" : "password"}
          placeholder={placeholder}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          className="w-full px-4 py-2.5 pr-10 border border-border-stone rounded-input text-sm bg-canvas-oat/30 focus:outline-none placeholder:text-text-ink/45"
        />
        <button
          type="button"
          onClick={props.onToggle}
          aria-label={props.show ? t("apiKey.hideKey") : t("apiKey.showKey")}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-text-ink/45 hover:text-text-ink/75 cursor-pointer transition-colors"
        >
          {props.show ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </div>
    </div>
  );
}

/**
 * Renders the live connection test button.
 *
 * @param props The test button props.
 * @returns The test button node.
 */
function TestButton(props: TestButtonProps) {
  const { t } = useTranslation();
  const isTesting = props.status === "testing";
  const isSuccess = props.status === "success";
  const isError = props.status === "error";

  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled || isTesting}
      className={`inline-flex w-[112px] h-10 shrink-0 items-center justify-center px-4 text-xs border rounded-btn transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer ${
        isSuccess
          ? "text-status-success border-status-success/30 bg-status-success-soft"
          : isError
            ? "text-status-error border-status-error/30 bg-status-error-soft"
            : "text-text-ink/65 border-border-stone hover:bg-canvas-oat/50"
      }`}
    >
      <span className="inline-flex items-center justify-center gap-1.5">
        {isTesting && <Loader2 size={13} className="shrink-0 animate-spin" aria-hidden="true" />}
        {isSuccess && <CheckCircle2 size={13} className="shrink-0" aria-hidden="true" />}
        {isError && <XCircle size={13} className="shrink-0" aria-hidden="true" />}
        <span className="leading-none">
          {isTesting ? t("apiKey.testing") : isSuccess ? t("apiKey.testSuccess") : isError ? t("apiKey.testRetry") : t("apiKey.test")}
        </span>
      </span>
    </button>
  );
}

/**
 * Renders the model connection test result.
 *
 * @param props The test result props.
 * @returns Test result text colored by status.
 */
function ValidationMessage(props: ValidationMessageProps) {
  const { t } = useTranslation();

  if (props.validation.status === "idle" && !props.stale) {
    return null;
  }

  const isSuccess = props.validation.status === "success" && !props.stale;
  const message = props.stale ? t("apiKey.testStale") : props.validation.message;

  return (
    <span className={`min-w-0 flex-1 truncate text-right text-xs ${isSuccess ? "text-status-success" : "text-status-error"}`}>
      {message}
    </span>
  );
}
