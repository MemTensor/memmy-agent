/** Settings page module. */
import { useEffect, useRef, useState, type CSSProperties, type Dispatch, type ReactNode } from "react";
import { Brain, Palette, Rocket, Settings2, Shield, User, Zap, ArrowRight, ArrowLeft, Bell, ExternalLink, FolderOpen, Info, LogOut, Wrench, Search, Eye, EyeOff, ChevronDown, ChevronUp, ChevronRight, Database, Loader2, CheckCircle2, XCircle, Check, AlertTriangle, ArrowDownToLine, ArrowUpFromLine, MessageSquare, FileText, Sparkles, Mic, Image as ImageIcon } from "lucide-react";
import type { AppSettingsDto, ByokTokenUsageByKind, ByokTokenUsageKind, ByokTokenUsageSummary, Language, PrivacySettingsDto, TokenUsageDto } from "@memmy/local-api-contracts";
import { useApiClients } from "../app/providers.js";
import { resolveGiftTokenUsage } from "../app/routes.js";
import { useUpdateCoordinator, type UpdateCoordinatorValue, type UpdatePhase } from "../app/update-coordinator.js";
import type { AnalyticsEvent } from "../analytics/analytics-events.js";
import { useAnalytics } from "../analytics/use-analytics.js";
import type { AccountClient } from "../api/account-client.js";
import type { ByokTokenUsageClient } from "../api/byok-token-usage-client.js";
import type { TokenQuotaClient } from "../api/token-quota-client.js";
import type { ConfigClient } from "../api/config-client.js";
import {
  readCloseMainWindowAction,
  writeCloseMainWindowAction,
  type CloseMainWindowAction
} from "../app/pet-guide.js";
import { consumeTokenExhaustedApplyMoreRequest, TOKEN_EXHAUSTED_APPLY_MORE_EVENT } from "../app/token-exhausted-apply-more.js";
import { getLegalLinkUrl } from "../legal/legal-links.js";
import { maskAccountIdentifier } from "../utils/mask-account-identifier.js";
import { openExternalUrl } from "../utils/open-url.js";
import { useTranslation } from "../i18n/use-translation.js";
import { appActions, type AppAction } from "../state/app-actions.js";
import type { AppState } from "../state/app-reducer.js";
import { useAppState } from "../state/app-state.js";
import { AppFrame } from "./app-frame.js";
import usageStyles from "./settings-token-usage.module.css";
import {
  OptionalModelMissingWarningModal,
  resolveOptionalModelMissingWarning,
  type OptionalModelMissingWarningKind
} from "./optional-model-missing-warning-modal.js";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { Memmy } from "../components/mascot/memmy.js";
import { Select, type SelectOption } from "../components/Select.js";
import { canSubmitFeedback, feedbackLength, FEEDBACK_MIN_LENGTH } from "../feedback/quota-feedback.js";
import {
  canSaveModelConfig,
  createModelConfigValidationKey,
  type ModelConfigValidationState
} from "./model-config-validation.js";
import {
  DEFAULT_ENDPOINTS,
  DEFAULT_MODEL_IDS,
  PROTOCOL_OPTIONS,
  ASR_DEFAULT_ENDPOINT,
  ASR_MODEL_ID,
  IMAGE_DEFAULT_ENDPOINTS,
  IMAGE_DEFAULT_MODEL_IDS,
  IMAGE_PROTOCOL_OPTIONS,
  canSaveEmbeddingModelConfig,
  canUseModelConfig,
  createAsrModelFormValues,
  createAsrProviderConfig,
  createImageGenModelFormValues,
  createImageGenProviderConfig,
  createTestModelConnectionMessages,
  createMemmyMemoryProviderConfig,
  createModelFormValues,
  createModelProtocolPatch,
  hydrateModelConfigForm,
  fromProtocol,
  testModelConnection,
  type ImageProtocol,
  type PrimaryModelValues,
  type Protocol,
  type ModelConfig
} from "./model-config.js";
import { ValidationMessage } from "./api-key-form-fields.js";
import { OverflowTooltipText } from "../components/overflow-tooltip-text.js";
import type { MessageKey, MessageValues } from "../i18n/messages.js";

type LogLevel = "error" | "warn" | "info" | "debug";
type ModelMode = "platform" | "custom";
type EmbeddingMode = "cloud" | "local" | "custom";
type TestStatus = "idle" | "testing" | "success" | "error";
type ConfirmKind = "logout" | "exitLocal" | null;
type UsageLoadStatus = "idle" | "loading" | "ready" | "error";
type DeveloperAction = "openLogs" | "exportDiagnostics";
type DeveloperFeedbackTone = "success" | "error";
type DiagnosticsReportHost = "electron" | "browser";

/** Contract for developer feedback. */
interface DeveloperFeedback {
  tone: DeveloperFeedbackTone;
  message: string;
}

/** Contract for diagnostics report export success. */
interface DiagnosticsReportExportSuccess {
  canceled: false;
  exportPath: string;
  bytes: number;
  host?: DiagnosticsReportHost;
}

/** Type definition for diagnostics report export result. */
type DiagnosticsReportExportResult = { canceled: true } | DiagnosticsReportExportSuccess;

/** Contract for renderer diagnostics report input. */
interface RendererDiagnosticsReportInput {
  state: AppState;
  language: Language;
  bridgeAvailable: boolean;
  exportBridgeAvailable: boolean;
}

type SettingsTranslate = (key: MessageKey, values?: MessageValues) => string;
type TrackAnalyticsEvent = (event: AnalyticsEvent) => void;

/** Definition for log level storage key. */
export const LOG_LEVEL_STORAGE_KEY = "memmy.developer.logLevel";

const LOG_LEVELS: readonly LogLevel[] = ["error", "warn", "info", "debug"];

/** Reads read log level. */
export function readLogLevel(storage: Storage | undefined): LogLevel {
  const value = storage?.getItem(LOG_LEVEL_STORAGE_KEY);
  return LOG_LEVELS.includes(value as LogLevel) ? (value as LogLevel) : "info";
}

/** Writes write log level. */
export function writeLogLevel(storage: Storage | undefined, level: LogLevel): void {
  storage?.setItem(LOG_LEVEL_STORAGE_KEY, level);
}

const FALLBACK_TOKEN_USAGE: TokenUsageDto = {
  planName: "Trial Token",
  totalTokens: 30_000_000,
  usedTokens: 0,
  remainingTokens: 30_000_000,
  expiresAt: null,
  lastSyncedAt: null
};

const EMPTY_BYOK_TOKEN_USAGE: ByokTokenUsageSummary = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 0,
  updatedAt: null,
  byKind: []
};

const TOKEN_USAGE_KIND_ORDER: ByokTokenUsageKind[] = ["agent_chat", "memory_summary", "memory_evolution", "embedding"];

/**
 * The default analytics-tracking function for the pure view.
 *
 * @param _event The event to report; ignored in pure-render scenarios.
 */
function noopTrackAnalyticsEvent(_event: AnalyticsEvent): void {
  return;
}

/**
 * Renders the settings page.
 *
 * @returns The settings page node.
 */
export function SettingsPage() {
  const { state, dispatch } = useAppState();
  const { clients } = useApiClients();
  const { track } = useAnalytics();
  const { t } = useTranslation();
  const update = useUpdateCoordinator();
  const [showUsageDetail, setShowUsageDetail] = useState(false);

  return (
    <AppFrame title={t("settings.title")} reserveTopBar={!showUsageDetail}>
      <SettingsPageView
        state={state}
        dispatch={dispatch}
        accountClient={clients?.account}
        configClient={clients?.config}
        byokTokenUsageClient={clients?.byokTokenUsage}
        tokenQuotaClient={clients?.tokenQuota}
        update={update}
        track={track}
        onUsageDetailVisibleChange={setShowUsageDetail}
      />
    </AppFrame>
  );
}

/**
 * Props for the pure settings-page view.
 *
 * Field meanings:
 * - state: The current global UI state, providing bootstrap, navigation, and legacy-test-compatible data.
 * - dispatch: The settings-change event dispatch function.
 * - accountClient: The account session client, used for nickname updates and logout.
 * - configClient: The live config write client; may be omitted in SSR tests.
 * - byokTokenUsageClient: The BYOK API Key Token usage client; may be omitted in SSR tests.
 * - update: The app-level desktop update state and primary action.
 * - track: The analytics-tracking function; may be omitted in pure-view tests and default to a no-op.
 * - onUsageDetailVisibleChange: Notifies the outer layout to collapse the draggable top bar when the Token usage detail sub-page's visibility changes.
 */
export interface SettingsPageViewProps {
  state: AppState;
  dispatch: Dispatch<AppAction>;
  accountClient?: AccountClient;
  configClient?: ConfigClient;
  byokTokenUsageClient?: ByokTokenUsageClient;
  tokenQuotaClient?: TokenQuotaClient;
  update: UpdateCoordinatorValue;
  track?: TrackAnalyticsEvent;
  onUsageDetailVisibleChange?: (visible: boolean) => void;
}

/**
 * Renders the pure settings-page view.
 *
 * @param props The pure view props.
 * @returns The settings page content node matching the prototype structure.
 */
export function SettingsPageView(props: SettingsPageViewProps) {
  const { state, dispatch, accountClient, configClient, byokTokenUsageClient, tokenQuotaClient, update, track = noopTrackAnalyticsEvent, onUsageDetailVisibleChange } = props;
  const { t } = useTranslation();
  const bootstrap = state.bootstrap;
  const [launchAtLogin, setLaunchAtLogin] = useState(false);
  const [closeAction, setCloseAction] = useState<CloseMainWindowAction>(() => {
    return readCloseMainWindowAction(typeof window === "undefined" ? undefined : window.localStorage);
  });
  const [menuBarIcon, setMenuBarIcon] = useState(true);
  const [logLevel, setLogLevel] = useState<LogLevel>(() => {
    return readLogLevel(typeof window === "undefined" ? undefined : window.localStorage);
  });
  const [developerBusy, setDeveloperBusy] = useState<DeveloperAction | null>(null);
  const [developerFeedback, setDeveloperFeedback] = useState<DeveloperFeedback | null>(null);
  const [confirm, setConfirm] = useState<ConfirmKind>(null);
  const [isEditingNickname, setIsEditingNickname] = useState(false);
  const [nicknameDraft, setNicknameDraft] = useState("");
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [showUsageDetail, setShowUsageDetail] = useState(false);

  /** Syncs the Token usage detail sub-page's visibility so the AppFrame draggable top bar does not cover the back button. */
  function updateShowUsageDetail(next: boolean) {
    setShowUsageDetail(next);
    onUsageDetailVisibleChange?.(next);
  }

  const [showApplyMore, setShowApplyMore] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [quotaRequestPending, setQuotaRequestPending] = useState(false);
  const [byokUsage, setByokUsage] = useState<ByokTokenUsageSummary>(EMPTY_BYOK_TOKEN_USAGE);
  const [byokUsageStatus, setByokUsageStatus] = useState<UsageLoadStatus>("idle");
  const preserveSuccessfulTestHydrateRef = useRef(false);
  const appSettings = bootstrap?.app;
  const privacySettings = bootstrap?.privacy;
  const isByokMode = appSettings?.userMode === "byok";
  const persistedMenuBarIconEnabled = appSettings?.menuBarIconEnabled;
  const isAccountMode = appSettings?.userMode === "account";
  const initialModelForm = hydrateModelConfigForm(state.modelConfig, isByokMode ? "local" : "cloud");
  const [showApiConfig, setShowApiConfig] = useState(false);
  const [protocol, setProtocol] = useState<Protocol>(initialModelForm.protocol);
  const [modelId, setModelId] = useState(initialModelForm.modelId);
  const [endpoint, setEndpoint] = useState(initialModelForm.endpoint);
  const [apiKey, setApiKey] = useState(initialModelForm.apiKey);
  const [apiKeyMasked, setApiKeyMasked] = useState(initialModelForm.apiKeyMasked);
  const [showKey, setShowKey] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [maxTokens, setMaxTokens] = useState("");
  const [dailyLimit, setDailyLimit] = useState("");
  const mainModelFormValues = {
    provider: fromProtocol(protocol),
    endpoint,
    model: modelId,
    apiKey,
    apiKeyMasked,
    hasExistingApiKey: Boolean(apiKeyMasked)
  };
  const [llmValidation, setLlmValidation] = useState<ModelConfigValidationState>(initialModelForm.llmValidation);
  const [embeddingMode, setEmbeddingMode] = useState<EmbeddingMode>(initialModelForm.embeddingMode);
  const [embModelId, setEmbModelId] = useState(initialModelForm.embModelId);
  const [embEndpoint, setEmbEndpoint] = useState(initialModelForm.embEndpoint);
  const [embApiKey, setEmbApiKey] = useState(initialModelForm.embApiKey);
  const [embApiKeyMasked, setEmbApiKeyMasked] = useState(initialModelForm.embApiKeyMasked);
  const [showEmbKey, setShowEmbKey] = useState(false);
  const embFormValues = {
    provider: "openai",
    endpoint: embEndpoint,
    model: embModelId,
    apiKey: embApiKey,
    apiKeyMasked: embApiKeyMasked,
    hasExistingApiKey: Boolean(embApiKeyMasked)
  };
  const [embValidation, setEmbValidation] = useState<ModelConfigValidationState>(initialModelForm.embValidation);
  const [asrModelId, setAsrModelId] = useState(initialModelForm.asrModelId);
  const [asrEndpoint, setAsrEndpoint] = useState(initialModelForm.asrEndpoint);
  const [asrApiKey, setAsrApiKey] = useState(initialModelForm.asrApiKey);
  const [asrApiKeyMasked, setAsrApiKeyMasked] = useState(initialModelForm.asrApiKeyMasked);
  const [showAsrKey, setShowAsrKey] = useState(false);
  const [asrValidation, setAsrValidation] = useState<ModelConfigValidationState>(initialModelForm.asrValidation);
  const [optionalModelMissingWarning, setOptionalModelMissingWarning] = useState<OptionalModelMissingWarningKind | null>(null);
  const [asrWarningAcknowledged, setAsrWarningAcknowledged] = useState(false);
  const [imageGenProtocol, setImageGenProtocol] = useState<ImageProtocol>(initialModelForm.imageGenProtocol);
  const [imageGenModel, setImageGenModel] = useState(initialModelForm.imageGenModelId);
  const [imageGenEndpoint, setImageGenEndpoint] = useState(initialModelForm.imageGenEndpoint);
  const [imageGenApiKey, setImageGenApiKey] = useState(initialModelForm.imageGenApiKey);
  const [imageGenApiKeyMasked, setImageGenApiKeyMasked] = useState(initialModelForm.imageGenApiKeyMasked);
  const [showImageGenKey, setShowImageGenKey] = useState(false);
  const [imageGenValidation, setImageGenValidation] = useState<ModelConfigValidationState>(initialModelForm.imageGenValidation);
  const [imageGenWarningAcknowledged, setImageGenWarningAcknowledged] = useState(false);
  const [memoryModel, setMemoryModel] = useState<ModelConfig>(() => initialModelForm.memoryModel);
  const [skillModel, setSkillModel] = useState<ModelConfig>(() => initialModelForm.skillModel);
  const accountIdentifier = resolveAccountIdentifier(state);
  const maskedAccountIdentifier = maskAccountIdentifier(accountIdentifier);
  const accountName = isByokMode
    ? resolveAccountFallback(appSettings?.userMode, t)
    : state.account.nickname || maskedAccountIdentifier || resolveAccountFallback(appSettings?.userMode, t);
  const accountMeta = isByokMode ? resolveAccountMeta(appSettings?.userMode, t) : maskedAccountIdentifier || resolveAccountMeta(appSettings?.userMode, t);
  const accountInitial = isByokMode ? "·" : resolveAccountInitials(accountName);
  const registeredAtText = formatRegisteredAt(state.account.registeredAt, t);
  const language = appSettings?.language === "en-US" ? "en-US" : "zh-CN";
  const defaultLaunchMode = appSettings?.defaultLaunchMode ?? state.navigation.preferredMode ?? "last";
  const autoUpdateEnabled = appSettings?.autoUpdateEnabled ?? true;
  const taskDoneNotificationEnabled = appSettings?.taskDoneNotificationEnabled ?? true;
  const notificationSoundEnabled = appSettings?.notificationSoundEnabled ?? true;
  const improvementPlan = privacySettings?.allowMemoryImprovementUpload ?? false;
  const hasAccountSession = Boolean(state.account.email || state.account.phoneNumber || state.account.registeredAt);
  const hasByokConfig = state.modelConfig.configured === true;
  const modelMode = resolveInitialModelMode(appSettings?.userMode);
  const modelModeLabel = t(modelMode === "platform" ? "settings.model.platformMode" : "settings.model.customMode");
  const modelModeClass = modelMode === "platform" ? "bg-action-sky/10 text-action-sky" : "bg-status-success-soft text-status-success";
  const modelDotClass = modelMode === "platform" ? "bg-action-sky" : "bg-status-success";
  const modelHeaderSpacing = modelMode === "platform" && !showApiConfig ? "" : " mb-4";
  const tokenUsage = bootstrap?.tokenUsage ?? FALLBACK_TOKEN_USAGE;
  const giftUsedTokens = tokenUsage.usedTokens;
  const giftTotalTokens = tokenUsage.totalTokens;
  const giftRemainingTokens = tokenUsage.remainingTokens;
  const { usagePercent, isTokenLow } = resolveGiftTokenUsage(giftUsedTokens, giftTotalTokens, giftRemainingTokens);
  const showGiftQuota = !isByokMode;
  const canApplyMoreByPromotion = bootstrap?.promotions?.applyMore ?? true;
  const applyMoreButtonLabel = quotaRequestPending ? t("settings.token.applyMore.pending") : t("settings.token.applyMore");
  const customUsedTokens = byokUsage.totalTokens;
  const tokenExpiryText = formatTokenExpiry(tokenUsage.expiresAt, t);
  const primaryModelId = state.modelConfig.configured ? modelId || state.modelConfig.model : "";
  const mainModelTestKey = createModelConfigValidationKey(mainModelFormValues);
  const isMainModelTestStale = Boolean(llmValidation.testedKey && llmValidation.testedKey !== mainModelTestKey);
  const primaryModelValues: PrimaryModelValues = {
    protocol,
    modelId,
    endpoint,
    apiKey,
    apiKeyMasked,
    configured: Boolean(apiKey.trim() || apiKeyMasked)
  };
  const memoryModelFormValues = createModelFormValues(memoryModel, primaryModelValues);
  const skillModelFormValues = createModelFormValues(skillModel, primaryModelValues);
  const embTestKey = createModelConfigValidationKey(embFormValues);
  const isEmbeddingTestStale = Boolean(embValidation.testedKey && embValidation.testedKey !== embTestKey);
  const asrFormValues = createAsrModelFormValues(asrModelId, asrEndpoint, asrApiKey, asrApiKeyMasked);
  const isAsrUsable = canSaveModelConfig(asrFormValues, asrValidation);
  const asrTestKey = createModelConfigValidationKey(asrFormValues);
  const isAsrTestStale = Boolean(asrValidation.testedKey && asrValidation.testedKey !== asrTestKey);
  const imageGenFormValues = createImageGenModelFormValues(imageGenProtocol, imageGenModel, imageGenEndpoint, imageGenApiKey, imageGenApiKeyMasked);
  const isImageGenUsable = canSaveModelConfig(imageGenFormValues, imageGenValidation);
  const imageGenTestKey = createModelConfigValidationKey(imageGenFormValues);
  const isImageGenTestStale = Boolean(imageGenValidation.testedKey && imageGenValidation.testedKey !== imageGenTestKey);
  const canSaveApiConfig = canSaveModelConfig(mainModelFormValues, llmValidation)
    && canUseModelConfig(memoryModel, memoryModelFormValues)
    && canUseModelConfig(skillModel, skillModelFormValues)
    && canSaveEmbeddingModelConfig(embeddingMode, embFormValues, embValidation);
  const patchMemoryModel = (patch: Partial<ModelConfig>) => setMemoryModel((current) => ({ ...current, ...patch }));
  const patchSkillModel = (patch: Partial<ModelConfig>) => setSkillModel((current) => ({ ...current, ...patch }));

  useEffect(() => {
    if (preserveSuccessfulTestHydrateRef.current) {
      // The auto-save after a successful test only updates the global config; it must not clear the plaintext key currently being edited or the success state.
      preserveSuccessfulTestHydrateRef.current = false;
      return;
    }

    const hydrated = hydrateModelConfigForm(state.modelConfig, isByokMode ? "local" : "cloud");
    setProtocol(hydrated.protocol);
    setModelId(hydrated.modelId);
    setEndpoint(hydrated.endpoint);
    setApiKey(hydrated.apiKey);
    setApiKeyMasked(hydrated.apiKeyMasked);
    setLlmValidation(hydrated.llmValidation);
    setEmbeddingMode(hydrated.embeddingMode);
    setEmbModelId(hydrated.embModelId);
    setEmbEndpoint(hydrated.embEndpoint);
    setEmbApiKey(hydrated.embApiKey);
    setEmbApiKeyMasked(hydrated.embApiKeyMasked);
    setEmbValidation(hydrated.embValidation);
    setAsrModelId(hydrated.asrModelId);
    setAsrEndpoint(hydrated.asrEndpoint);
    setAsrApiKey(hydrated.asrApiKey);
    setAsrApiKeyMasked(hydrated.asrApiKeyMasked);
    setAsrValidation(hydrated.asrValidation);
    setAsrWarningAcknowledged(false);
    setImageGenProtocol(hydrated.imageGenProtocol);
    setImageGenModel(hydrated.imageGenModelId);
    setImageGenEndpoint(hydrated.imageGenEndpoint);
    setImageGenApiKey(hydrated.imageGenApiKey);
    setImageGenApiKeyMasked(hydrated.imageGenApiKeyMasked);
    setImageGenValidation(hydrated.imageGenValidation);
    setImageGenWarningAcknowledged(false);
    setMemoryModel(hydrated.memoryModel);
    setSkillModel(hydrated.skillModel);
  }, [isByokMode, state.modelConfig]);

  useEffect(() => {
    let cancelled = false;
    if (!configClient || !isAccountMode) {
      return () => {
        cancelled = true;
      };
    }

    void configClient.getTokenUsage().then((tokenUsage) => {
      if (!cancelled) {
        dispatch(appActions.tokenUsageUpdated(tokenUsage));
      }
    }).catch((error) => {
      console.warn("load account token usage failed", error);
    });

    return () => {
      cancelled = true;
    };
  }, [configClient, dispatch, isAccountMode]);

  useEffect(() => {
    if (!quotaRequestPending || !configClient || !isAccountMode) {
      return undefined;
    }

    let cancelled = false;
    const refreshPendingQuota = async () => {
      try {
        const nextTokenUsage = await configClient.getTokenUsage();
        if (cancelled) {
          return;
        }

        dispatch(appActions.tokenUsageUpdated(nextTokenUsage));
        if (nextTokenUsage.totalTokens > giftTotalTokens || nextTokenUsage.remainingTokens > giftRemainingTokens) {
          setQuotaRequestPending(false);
        }
      } catch (error) {
        console.warn("refresh pending token quota failed", error);
      }
    };

    void refreshPendingQuota();
    const timer = window.setInterval(() => {
      void refreshPendingQuota();
    }, 15_000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [configClient, dispatch, giftRemainingTokens, giftTotalTokens, isAccountMode, quotaRequestPending]);

  useEffect(() => {
    let cancelled = false;
    if (!byokTokenUsageClient) {
      setByokUsage(EMPTY_BYOK_TOKEN_USAGE);
      setByokUsageStatus("idle");
      return () => {
        cancelled = true;
      };
    }

    setByokUsageStatus("loading");
    void byokTokenUsageClient.getSummary().then((summary) => {
      if (cancelled) {
        return;
      }
      setByokUsage(summary);
      setByokUsageStatus("ready");
    }).catch((error) => {
      console.warn("load byok token usage failed", error);
      if (cancelled) {
        return;
      }
      setByokUsage(EMPTY_BYOK_TOKEN_USAGE);
      setByokUsageStatus("error");
    });

    return () => {
      cancelled = true;
    };
  }, [byokTokenUsageClient]);

  useEffect(() => {
    if (typeof window === "undefined" || window.location.hash !== "#pet-avatar") {
      return;
    }

    window.setTimeout(() => {
      document.getElementById("pet-avatar")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !canApplyMoreByPromotion) {
      return;
    }

    const openRequestedApplyMore = () => {
      if (consumeTokenExhaustedApplyMoreRequest(window.sessionStorage)) {
        openApplyMore();
      }
    };

    openRequestedApplyMore();
    window.addEventListener(TOKEN_EXHAUSTED_APPLY_MORE_EVENT, openRequestedApplyMore);

    return () => {
      window.removeEventListener(TOKEN_EXHAUSTED_APPLY_MORE_EVENT, openRequestedApplyMore);
    };
  }, [canApplyMoreByPromotion]);

  useEffect(() => {
    if (typeof persistedMenuBarIconEnabled === "boolean") {
      setMenuBarIcon(persistedMenuBarIconEnabled);
    }
  }, [persistedMenuBarIconEnabled]);

  // On mount, treat the log level persisted by the main process as authoritative, to avoid the local localStorage diverging from the main process.
  useEffect(() => {
    let cancelled = false;
    void window.memmy?.getLogLevel().then((level) => {
      if (!cancelled) {
        setLogLevel(level);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Saves the app settings and syncs the reducer.
   *
   * @param patch The app settings patch.
   */
  function persistSettings(patch: Partial<AppSettingsDto>) {
    void (configClient?.updateSettings(patch) ?? Promise.resolve(patch)).then((savedSettings) => {
      dispatch(appActions.settingsUpdated(savedSettings));
    });
  }

  /**
   * Saves the privacy settings and syncs the reducer.
   *
   * @param patch The privacy settings patch.
   */
  function persistPrivacy(patch: Partial<PrivacySettingsDto>) {
    // Optimistic update: on click, immediately flip the badge/button label and keep the user's choice without waiting for the backend response.
    dispatch(appActions.privacyUpdated(patch));
    void (configClient?.updatePrivacy(patch) ?? Promise.resolve(patch))
      .then((savedPrivacy) => {
        dispatch(appActions.privacyUpdated(savedPrivacy));
      })
      .catch(() => {
        // In local/logged-out state the backend does not persist privacy and throws; swallow the error and keep the optimistic result to avoid the UI bouncing back.
      });
  }

  /**
   * Switches the interface language.
   *
   * @param nextLanguage The interface language.
   */
  function handleLanguageChange(nextLanguage: string) {
    persistSettings({ language: nextLanguage as Language });
  }

  /**
   * Switches the default startup mode.
   *
   * @param nextMode The default startup mode.
   */
  function handleStartupModeChange(nextMode: string) {
    const normalizedMode = nextMode as AppSettingsDto["defaultLaunchMode"];
    void (configClient?.updateSettings({ defaultLaunchMode: normalizedMode }) ?? Promise.resolve({ defaultLaunchMode: normalizedMode })).then((savedSettings) => {
      dispatch(appActions.settingsUpdated(savedSettings));
      dispatch(appActions.preferredModeUpdated(normalizedMode));
    });
  }

  /**
   * Switches the default behavior when closing the main window and writes it to local storage.
   *
   * @param nextAction The close behavior the user selected.
   */
  function handleCloseActionChange(nextAction: string) {
    const normalizedAction = nextAction as CloseMainWindowAction;
    setCloseAction(normalizedAction);
    writeCloseMainWindowAction(
      typeof window === "undefined" ? undefined : window.localStorage,
      normalizedAction
    );
  }

  /**
   * Toggles the macOS status bar icon.
   *
   * @param enabled Whether to show the status bar icon.
   */
  function handleMenuBarIconChange(enabled: boolean) {
    setMenuBarIcon(enabled);
    void (configClient?.updateSettings({ menuBarIconEnabled: enabled }) ?? Promise.resolve({ menuBarIconEnabled: enabled })).then((savedSettings) => {
      const savedEnabled = savedSettings.menuBarIconEnabled ?? enabled;
      dispatch(appActions.settingsUpdated(savedSettings));
      setMenuBarIcon(savedEnabled);
      void window.memmy?.setMenuBarIcon(savedEnabled);
    });
  }

  /**
   * Switches the log level and writes it to local storage, ensuring the selection is preserved across page switches.
   *
   * @param nextLevel The log level the user selected.
   */
  function handleLogLevelChange(nextLevel: string) {
    const normalizedLevel = nextLevel as LogLevel;
    setLogLevel(normalizedLevel);
    writeLogLevel(typeof window === "undefined" ? undefined : window.localStorage, normalizedLevel);
    // Sync to the main process: the GUI takes effect immediately, and the daemon reads the new level on its next restart.
    void window.memmy?.setLogLevel(normalizedLevel);
  }

  /**
   * Switches the primary model protocol, syncs the default API endpoint and default model ID, and clears the old protocol's API Key.
   *
   * @param nextProtocol The new protocol type.
   */
  function handleProtocolChange(nextProtocol: Protocol) {
    setProtocol(nextProtocol);
    setEndpoint(DEFAULT_ENDPOINTS[nextProtocol]);
    setModelId("");
    setApiKey("");
    setApiKeyMasked("");
  }

  /**
   * Expands the BYOK API Key configuration form for a registered user.
   */
  function handleSwitchToCustom() {
    track({ name: "model_mode_switched", params: { page_path: "/settings", to_mode: "byok" }, consentTier: "basic" });
    if (hasByokConfig) {
      persistSettings({ userMode: "byok" });
      setShowApiConfig(false);
      return;
    }

    setShowApiConfig(true);
  }

  /**
   * Switches back to the platform Token mode.
   */
  function handleSwitchToPlatform() {
    if (!hasAccountSession) {
      return;
    }

    track({ name: "model_mode_switched", params: { page_path: "/settings", to_mode: "platform" }, consentTier: "basic" });
    persistSettings({ userMode: "account" });
    setShowApiConfig(false);
  }

  /**
   * Runs a real connection test for the primary model.
   */
  function testMainModelConnection() {
    track({ name: "model_connection_tested", params: { page_path: "/settings" }, consentTier: "basic" });
    testModelConnection({
      configClient,
      values: mainModelFormValues,
      setValidation: setLlmValidation,
      secretTarget: "primary",
      onSuccess: persistSuccessfulMainModelConnection,
      messages: createTestModelConnectionMessages(t)
    });
  }

  /**
   * Saves the primary model config immediately after a successful connection test.
   *
   * @param testedConfig The primary model config that passed the real connection test.
   */
  function persistSuccessfulMainModelConnection(testedConfig: {
    provider: string;
    endpoint: string;
    model: string;
    apiKey: string;
    apiKeyMasked: string;
    configured: boolean;
  }) {
    const successConfig = {
      ...state.modelConfig,
      provider: testedConfig.provider,
      endpoint: testedConfig.endpoint,
      model: testedConfig.model,
      apiKey: testedConfig.apiKey,
      apiKeyMasked: testedConfig.apiKey.trim() ? "" : apiKeyMasked,
      configured: Boolean(testedConfig.endpoint.trim() && testedConfig.model.trim() && (testedConfig.apiKey.trim() || apiKeyMasked))
    };

    preserveSuccessfulTestHydrateRef.current = true;
    void (configClient?.saveModelConfig(successConfig) ?? Promise.resolve(successConfig)).then((savedConfig) => {
      dispatch(appActions.modelConfigUpdated(savedConfig));
    }).catch((error) => {
      preserveSuccessfulTestHydrateRef.current = false;
      console.warn("save tested model config failed", error);
      // Surface autosave failures so a successful connection test cannot mask an unpersisted configuration.
      setLlmValidation({
        status: "error",
        message: t("apiKey.testSaveFailed"),
        testedKey: null
      });
    });
  }

  /**
   * Runs a real model connection test.
   *
   * @param config The current model config.
   * @param patch The model-state patch function.
   */
  function testModelConfigConnection(config: ModelConfig, patch: (patch: Partial<ModelConfig>) => void, secretTarget: "memory" | "skill") {
    const values = createModelFormValues(config, primaryModelValues);
    testModelConnection({
      configClient,
      values,
      setValidation: (validation) => patch({ validation }),
      secretTarget,
      messages: createTestModelConnectionMessages(t)
    });
  }

  /**
   * Runs a real connection test for the Embedding model.
   */
  function testEmbeddingConnection() {
    testModelConnection({
      configClient,
      values: embFormValues,
      setValidation: setEmbValidation,
      capability: "embedding",
      secretTarget: "embedding",
      messages: createTestModelConnectionMessages(t)
    });
  }

  /**
   * Runs a real connection test for the ASR model.
   */
  function testAsrConnection() {
    testModelConnection({
      configClient,
      values: asrFormValues,
      setValidation: setAsrValidation,
      capability: "asr",
      secretTarget: "asr",
      messages: createTestModelConnectionMessages(t)
    });
  }

  /**
   * When switching the image-generation provider, syncs the default API endpoint and default model ID, and clears the old provider's API Key.
   *
   * @param nextProtocol The new image-generation protocol id.
   */
  function changeImageGenProtocol(nextProtocol: string) {
    const next = (IMAGE_PROTOCOL_OPTIONS.find((option) => option.value === nextProtocol)?.value ?? "openai") as ImageProtocol;
    setImageGenProtocol(next);
    setImageGenEndpoint(IMAGE_DEFAULT_ENDPOINTS[next]);
    setImageGenModel("");
    setImageGenApiKey("");
    setImageGenWarningAcknowledged(false);
  }

  /**
   * Runs a lightweight connection test for the image-generation model.
   */
  function testImageGenConnection() {
    testModelConnection({
      configClient,
      values: imageGenFormValues,
      setValidation: setImageGenValidation,
      capability: "image",
      secretTarget: "image",
      messages: createTestModelConnectionMessages(t)
    });
  }

  /**
   * Records that the user has acknowledged the impact of leaving optional models unconfigured,
   * then continues saving the API config the user already filled in so the acknowledgment does not drop it.
   */
  function closeOptionalModelMissingWarning() {
    if (optionalModelMissingWarning === "asr" || optionalModelMissingWarning === "both") {
      setAsrWarningAcknowledged(true);
    }

    if (optionalModelMissingWarning === "imageGen" || optionalModelMissingWarning === "both") {
      setImageGenWarningAcknowledged(true);
    }

    setOptionalModelMissingWarning(null);
    persistApiConfig();
  }

  /**
   * Opens the "Request more quota" feedback modal, resetting the previous input and state.
   */
  function openApplyMore() {
    setFeedbackText("");
    setFeedbackSubmitting(false);
    setFeedbackSubmitted(false);
    setFeedbackError(null);
    setShowApplyMore(true);
  }

  /**
   * Closes the "Request more quota" feedback modal.
   */
  function closeApplyMore() {
    setShowApplyMore(false);
  }

  /**
   * Submits the "Request more quota" feedback.
   *
   * Returns early when the text is too short; disables the button during submission; on success shows the success state and clears the input.
   */
  async function handleSubmitFeedback() {
    if (quotaRequestPending || !canSubmitFeedback(feedbackText) || feedbackSubmitting) {
      return;
    }
    setFeedbackSubmitting(true);
    setFeedbackError(null);
    try {
      const result = await tokenQuotaClient?.requestQuota(feedbackText);
      if (result?.status === "pending") {
        setQuotaRequestPending(true);
      } else if (result?.status === "approved") {
        setQuotaRequestPending(false);
        try {
          const nextTokenUsage = await configClient?.getTokenUsage();
          if (nextTokenUsage) {
            dispatch(appActions.tokenUsageUpdated(nextTokenUsage));
          }
        } catch (error) {
          console.warn("refresh approved token quota failed", error);
        }
      }
      setFeedbackSubmitted(true);
      setFeedbackText("");
    } catch (error) {
      if (isPendingQuotaRequestError(error)) {
        setQuotaRequestPending(true);
        setFeedbackSubmitted(false);
        setFeedbackText("");
        return;
      }
      // Show an error on submission failure (e.g. an approval is already pending, creating the approval failed, or not logged in) to avoid a "nothing happens when clicked" experience.
      setFeedbackError(error instanceof Error ? error.message : t("settings.token.applyMore.error"));
    } finally {
      setFeedbackSubmitting(false);
    }
  }

  /**
   * Saves the inline API Key configuration on the settings page.
   *
   * When optional models are missing and not yet acknowledged, shows the warning modal instead;
   * the modal's confirm action resumes the save via {@link persistApiConfig}.
   */
  function handleSaveApiConfig() {
    if (!canSaveApiConfig) {
      return;
    }

    const nextWarning = resolveOptionalModelMissingWarning({
      asrMissing: !isAsrUsable && !asrWarningAcknowledged,
      imageGenMissing: !isImageGenUsable && !imageGenWarningAcknowledged
    });
    if (nextWarning) {
      setOptionalModelMissingWarning(nextWarning);
      return;
    }

    persistApiConfig();
  }

  /**
   * Persists the filled API Key configuration and switches the app into BYOK mode.
   */
  function persistApiConfig() {
    if (!canSaveApiConfig) {
      return;
    }

    const nextConfig = {
      provider: fromProtocol(protocol),
      endpoint,
      model: modelId,
      apiKey,
      apiKeyMasked: apiKey.trim() ? "" : apiKeyMasked,
      configured: Boolean(endpoint.trim() && modelId.trim() && (apiKey.trim() || apiKeyMasked)),
      memmyMemory: createMemmyMemoryProviderConfig(memoryModel, skillModel, primaryModelValues),
      embedding: embeddingMode === "custom"
        ? {
            mode: "custom" as const,
            endpoint: embEndpoint,
            model: embModelId,
            apiKey: embApiKey,
            apiKeyMasked: embApiKey.trim() ? "" : embApiKeyMasked,
            configured: Boolean(embEndpoint.trim() && embModelId.trim() && (embApiKey.trim() || embApiKeyMasked))
          }
        : embeddingMode === "local"
          ? {
              mode: "local" as const,
              endpoint: "",
              model: "",
              apiKey: "",
              apiKeyMasked: "",
              configured: true
            }
          : undefined,
      asr: isAsrUsable ? createAsrProviderConfig(asrModelId, asrEndpoint, asrApiKey, asrApiKeyMasked) : null,
      imageGen: isImageGenUsable
        ? createImageGenProviderConfig(imageGenProtocol, imageGenModel, imageGenEndpoint, imageGenApiKey, imageGenApiKeyMasked)
        : null
    };

    void (configClient?.saveModelConfig(nextConfig) ?? Promise.resolve(nextConfig)).then((savedConfig) => {
      dispatch(appActions.modelConfigUpdated(savedConfig));
      setShowApiConfig(false);
      track({ name: "model_config_saved", params: { page_path: "/settings" }, consentTier: "basic" });
      if (!isByokMode) {
        persistSettings({ userMode: "byok" });
      }
    });
  }

  /**
   * Opens the desktop log directory in the system file manager.
   */
  function openDeveloperLogs() {
    if (developerBusy) {
      return;
    }

    const openLogsDirectory = typeof window === "undefined" ? undefined : window.memmy?.openLogsDirectory;
    if (typeof openLogsDirectory !== "function") {
      setDeveloperFeedback({ tone: "error", message: t("settings.developer.openLogsUnavailable") });
      return;
    }

    setDeveloperBusy("openLogs");
    setDeveloperFeedback(null);
    void openLogsDirectory()
      .then(() => setDeveloperFeedback({ tone: "success", message: t("settings.developer.openLogsDone") }))
      .catch((error) => setDeveloperFeedback({ tone: "error", message: error instanceof Error ? error.message : String(error) }))
      .finally(() => setDeveloperBusy(null));
  }

  /**
   * Exports a redacted diagnostics report through the desktop bridge.
   */
  function exportDiagnosticsReport() {
    if (developerBusy) {
      return;
    }

    const exportDiagnosticsReportBridge = typeof window === "undefined" ? undefined : window.memmy?.exportDiagnosticsReport;
    setDeveloperBusy("exportDiagnostics");
    setDeveloperFeedback(null);
    const exportTask = typeof exportDiagnosticsReportBridge === "function"
      ? exportDiagnosticsReportBridge()
      : downloadDiagnosticsReportInBrowser(buildRendererDiagnosticsReport({
          state,
          language,
          bridgeAvailable: typeof window !== "undefined" && Boolean(window.memmy),
          exportBridgeAvailable: false
        }));

    void exportTask
      .then((result) => {
        const parsed = parseDiagnosticsReportExportResult(result);
        if (parsed.canceled) {
          return;
        }
        setDeveloperFeedback({
          tone: "success",
          message: t("settings.developer.exportDiagnosticsDone", {
            path: formatDeveloperPath(parsed.exportPath),
            size: formatFileSize(parsed.bytes)
          })
        });
      })
      .catch((error) => setDeveloperFeedback({ tone: "error", message: error instanceof Error ? error.message : String(error) }))
      .finally(() => setDeveloperBusy(null));
  }

  /**
   * Starts editing the registered account's nickname.
   */
  function startNicknameEdit() {
    setNicknameDraft(state.account.nickname);
    setAccountError(null);
    setIsEditingNickname(true);
  }

  /**
   * Saves the registered account's nickname, falling back to the primary identifier when left blank.
   */
  async function saveNickname() {
    const nextNickname = nicknameDraft.trim() || resolveDefaultNickname(accountIdentifier) || accountName;
    if (!nextNickname) {
      return;
    }

    setAccountBusy(true);
    setAccountError(null);
    try {
      const profile = await (accountClient?.updateProfile({ nickname: nextNickname }) ?? Promise.resolve(null));
      dispatch(appActions.accountUpdated({
        email: profile?.email ?? state.account.email,
        phoneNumber: profile?.phoneNumber ?? state.account.phoneNumber,
        nickname: profile?.nickname ?? nextNickname,
        registeredAt: profile?.registeredAt ?? state.account.registeredAt
      }));
      setIsEditingNickname(false);
    } catch (error) {
      console.warn("update account nickname failed", error);
      setAccountError(t("settings.account.saveNicknameFailed"));
    } finally {
      setAccountBusy(false);
    }
  }

  /**
   * Handles the confirmation for logging out of the account or exiting local mode.
   */
  async function handleConfirmAccountExit() {
    if (accountBusy) return;
    const currentConfirm = confirm;
    if (currentConfirm === "logout") {
      setAccountBusy(true);
      setAccountError(null);
      try {
        await (accountClient?.logout() ?? Promise.resolve({ ok: true as const }));
        track({ name: "account_logout", params: { page_path: "/settings" }, consentTier: "basic" });
        dispatch(appActions.accountCleared());
        persistSettings({ userMode: "unset" });
        dispatch(appActions.navigate("/welcome"));
        setConfirm(null);
      } catch (error) {
        console.warn("logout account failed", error);
        setAccountError(t("settings.account.logoutFailed"));
        setConfirm(null);
      } finally {
        setAccountBusy(false);
      }
      return;
    }

    track({ name: "byok_exit_to_register", params: { page_path: "/settings" }, consentTier: "basic" });
    persistSettings({ userMode: "unset" });
    dispatch(appActions.accountCleared());
    dispatch(appActions.navigate("/welcome"));
    setConfirm(null);
  }

  if (showUsageDetail) {
    return (
      <UsageDetailView
        showPlatform={showGiftQuota}
        platformChatTokens={giftUsedTokens}
        byokUsage={byokUsage}
        byokUsageStatus={byokUsageStatus}
        onBack={() => updateShowUsageDetail(false)}
      />
    );
  }

  const confirmDialog = confirm ? resolveAccountConfirmDialog(confirm, t) : null;
  return (
    <div
      className="settings-page h-full overflow-y-auto"
    >
      <div className="app-frame-page-content max-w-2xl mx-auto py-8">
        <Section icon={<User size={16} className="text-text-ink/60" />} title={t("settings.account")}>
          <div className="settings-account-summary">
            <div className="w-12 h-12 rounded-full bg-action-sky/15 flex items-center justify-center shrink-0">
              <span className="text-base font-bold text-action-sky">{accountInitial}</span>
            </div>
            <div className="settings-account-copy">
              <div className="flex items-center gap-2 mb-1 min-w-0">
                {isEditingNickname ? (
                  <div className="flex flex-1 min-w-0 items-center gap-2">
                    <input
                      type="text"
                      aria-label={t("settings.account.nickname")}
                      value={nicknameDraft}
                      onChange={(event) => setNicknameDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          void saveNickname();
                        }
                        if (event.key === "Escape") {
                          setIsEditingNickname(false);
                        }
                      }}
                      disabled={accountBusy}
                      maxLength={32}
                      className="min-w-0 flex-1 px-2.5 py-1.5 border border-border-stone/50 rounded-input bg-background-paper text-sm text-text-ink focus:outline-none disabled:opacity-60"
                    />
                    <button type="button" onClick={() => void saveNickname()} disabled={accountBusy} className="px-2.5 py-1.5 text-xs text-white bg-action-sky rounded-btn hover:bg-action-sky-hover disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed">
                      {t("common.save")}
                    </button>
                    <button type="button" onClick={() => setIsEditingNickname(false)} disabled={accountBusy} className="px-2.5 py-1.5 text-xs text-text-ink/60 border border-border-stone/40 rounded-btn hover:bg-canvas-oat/60 disabled:opacity-60 cursor-pointer disabled:cursor-not-allowed">
                      {t("common.cancel")}
                    </button>
                  </div>
                ) : (
                  <>
                    <OverflowTooltipText
                      className="settings-account-heading-name text-sm font-semibold text-text-ink truncate"
                      text={accountName}
                    />
                    {isAccountMode && (
                      <button type="button" aria-label={t("settings.account.editNickname")} onClick={startNicknameEdit} className="shrink-0 text-xs text-action-sky hover:underline cursor-pointer">
                        {t("settings.account.editNickname")}
                      </button>
                    )}
                  </>
                )}
              </div>
              <div className="min-w-0 text-xs text-text-ink/55 leading-relaxed">
                {isAccountMode ? (
                  <div className="min-w-0 space-y-0.5">
                    <OverflowTooltipText className="settings-account-meta-line block truncate" text={accountMeta} />
                    <div className="text-text-ink/45">{t("settings.account.registeredAt", { value: registeredAtText })}</div>
                    {accountError && <div className="text-status-error">{accountError}</div>}
                  </div>
                ) : (
                  <OverflowTooltipText className="settings-account-meta-line block truncate" text={accountMeta} />
                )}
              </div>
            </div>
            {isAccountMode && (
              <button
                type="button"
                onClick={() => setConfirm("logout")}
                disabled={accountBusy}
                className="settings-account-action shrink-0 flex items-center gap-1.5 px-3.5 py-1.5 text-xs text-text-ink/70 border border-border-stone/40 rounded-btn hover:bg-canvas-oat/60 transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
              >
                <LogOut size={12} /> {t("settings.logout")}
              </button>
            )}
            {isByokMode && (
              <button
                type="button"
                onClick={() => setConfirm("exitLocal")}
                className="settings-account-action shrink-0 flex items-center gap-1.5 px-3.5 py-1.5 text-xs text-action-sky border border-action-sky/30 rounded-btn hover:bg-action-sky/8 transition-colors cursor-pointer"
              >
                <Zap size={12} /> {t("settings.account.exitLocalShort")}
              </button>
            )}
          </div>
        </Section>

        <Section icon={<Brain size={16} className="text-text-ink/60" />} title={t("settings.model")} sectionId="model-config">
          <div className={`flex items-center justify-between gap-3${modelHeaderSpacing}`}>
            <div className="flex items-center gap-3 min-w-0">
              <span className="text-sm text-text-ink/75 shrink-0">{t("settings.model.currentMode")}</span>
              <span className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-normal rounded-tag ${modelModeClass}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${modelDotClass}`} />
                {modelModeLabel}
              </span>
              {modelMode === "custom" && !showApiConfig && (
                <button type="button" onClick={() => setShowApiConfig(true)} className="text-xs text-action-sky hover:underline cursor-pointer">
                  {t("settings.model.editConfig")}
                </button>
              )}
            </div>

            {modelMode === "platform" && hasAccountSession ? (
              <button
                type="button"
                onClick={handleSwitchToCustom}
                className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs text-action-sky border border-action-sky/30 rounded-btn hover:bg-action-sky/8 transition-colors cursor-pointer"
              >
                {t("settings.model.switchToCustom")}
                <ArrowRight size={13} />
              </button>
            ) : (
              modelMode === "custom" && hasAccountSession && hasByokConfig && (
                <button
                  type="button"
                  onClick={handleSwitchToPlatform}
                  className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs text-action-sky border border-action-sky/30 rounded-btn hover:bg-action-sky/8 transition-colors cursor-pointer"
                >
                  {t("settings.model.switchToPlatform")}
                  <ArrowRight size={13} />
                </button>
              )
            )}
          </div>

          {modelMode === "custom" && !showApiConfig && (
            <div className="space-y-2 p-3 bg-canvas-oat/40 rounded-card">
              <ModuleRow label={t("settings.model.agentTask")} desc={t("settings.model.primary")} model={primaryModelId || t("settings.model.notSet")} />
              <ModuleRow
                label={t("settings.model.memorySummary")}
                desc={t("settings.model.memoryDesc")}
                model={memoryModel.reuse ? (primaryModelId ? t("settings.model.reusePrimary", { model: primaryModelId }) : t("settings.model.notSet")) : memoryModel.modelId || t("settings.model.notSet")}
              />
              <ModuleRow
                label={t("settings.model.skillEvolution")}
                desc={t("settings.model.skillDesc")}
                model={skillModel.reuse ? (primaryModelId ? t("settings.model.reusePrimary", { model: primaryModelId }) : t("settings.model.notSet")) : skillModel.modelId || t("settings.model.notSet")}
              />
              <ModuleRow
                label={t("settings.model.embeddingSearch")}
                desc={t("settings.model.embeddingDesc")}
                model={embeddingMode === "cloud" ? t("settings.model.cloudEmbedding") : embeddingMode === "local" ? t("settings.model.localEmbedding") : embModelId || t("settings.model.notSet")}
              />
              <ModuleRow
                label={t("settings.model.asr")}
                desc={t("settings.model.asrDesc")}
                model={asrModelId || ASR_MODEL_ID}
              />
              <ModuleRow
                label={t("apiKey.imageGen")}
                desc={t("apiKey.imageGenHint")}
                model={imageGenModel || t("settings.model.notSet")}
              />
            </div>
          )}

          {showApiConfig && (
            <div className="space-y-5">
              <div className="bg-canvas-oat/40 rounded-card p-5 space-y-3.5">
                <div className="flex items-center gap-2 mb-1">
                  <Brain size={16} className="text-action-sky" />
                  <span className="text-sm font-normal text-text-ink/70">{t("apiKey.llm")}</span>
                  <span className="text-xs text-status-error font-normal">{t("settings.model.required")}</span>
                </div>
                <p className="text-xs text-text-ink/50 -mt-1">{t("apiKey.llmHint")}</p>

                <ProtocolSelect value={protocol} onChange={handleProtocolChange} />
                <Field label={t("apiKey.model")} placeholder={`${t("apiKey.examplePrefix")} ${DEFAULT_MODEL_IDS[protocol]}`} value={modelId} onChange={setModelId} />
                <Field label={t("apiKey.endpoint")} placeholder={`${t("apiKey.examplePrefix")} ${DEFAULT_ENDPOINTS[protocol]}`} value={endpoint} onChange={setEndpoint} />
                <PasswordField label={t("apiKey.key")} placeholder="sk-..." maskedValue={apiKeyMasked} value={apiKey} onChange={setApiKey} show={showKey} onToggle={() => setShowKey(!showKey)} />

                <button type="button" onClick={() => setShowAdvanced(!showAdvanced)} className="flex items-center gap-1.5 text-xs text-text-ink/55 hover:text-text-ink/75 cursor-pointer transition-colors">
                  {showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  {t("apiKey.advanced")}
                </button>
                {showAdvanced && (
                  <div className="space-y-3.5">
                    <Field label={t("apiKey.maxTokens")} placeholder={t("apiKey.noLimit")} value={maxTokens} onChange={setMaxTokens} suffix="tokens" />
                    <Field label={t("apiKey.dailyLimit")} placeholder={t("apiKey.noLimit")} value={dailyLimit} onChange={setDailyLimit} />
                  </div>
                )}

                <div className="flex min-h-9 items-center justify-end gap-3">
                  <ValidationMessage validation={llmValidation} stale={isMainModelTestStale} />
                  <TestButton status={llmValidation.status} onClick={testMainModelConnection} disabled={false} />
                </div>
              </div>

              <ModelConfigCard
                icon={<Brain size={16} className="text-action-sky" />}
                title={t("apiKey.modelPage.memoryTitle")}
                subtitle={t("apiKey.modelPage.memorySubtitle")}
                hint={t("apiKey.modelPage.memoryHint")}
                cfg={memoryModel}
                onPatch={patchMemoryModel}
                onTest={() => testModelConfigConnection(memoryModel, patchMemoryModel, "memory")}
                primary={primaryModelValues}
              />

              <ModelConfigCard
                icon={<Wrench size={16} className="text-action-sky" />}
                title={t("apiKey.modelPage.skillTitle")}
                subtitle={t("apiKey.modelPage.skillSubtitle")}
                cfg={skillModel}
                onPatch={patchSkillModel}
                onTest={() => testModelConfigConnection(skillModel, patchSkillModel, "skill")}
                primary={primaryModelValues}
              />

              <div className="bg-canvas-oat/40 rounded-card p-5 space-y-3.5">
                <div className="flex items-center gap-2 mb-1">
                  <Search size={16} className="text-action-sky" />
                  <span className="text-sm font-normal text-text-ink/70">{t("apiKey.embedding")}</span>
                </div>
                <p className="text-xs text-text-ink/50 -mt-1">{t("apiKey.embeddingHint")}</p>

                <Select
                  label={t("apiKey.embeddingMode")}
                  value={embeddingMode}
                  onValueChange={(value) => setEmbeddingMode(value as EmbeddingMode)}
                  className="select-control--paper"
                  options={[
                    ...(!isByokMode ? [{ value: "cloud", label: t("settings.model.cloudEmbeddingOption") }] : []),
                    { value: "local", label: t("settings.model.localEmbeddingOffline") },
                    { value: "custom", label: t("settings.model.customEmbeddingOption") }
                  ]}
                />

                {embeddingMode === "local" && (
                  <p className="text-[11px] text-text-ink/45 -mt-2">
                    {t("settings.model.localEmbeddingModelHint")}
                  </p>
                )}

                {embeddingMode === "cloud" && (
                  <div className="flex items-start gap-2.5 p-3.5 bg-action-sky/5 rounded-card border border-action-sky/15">
                    <Info size={14} className="text-action-sky mt-0.5 shrink-0" />
                    <p className="text-xs text-text-ink/65 leading-relaxed">
                      {t("settings.model.cloudEmbeddingHintPrefix")}<span className="font-semibold text-text-ink/80">{t("settings.model.cloudEmbeddingHintStrong")}</span>{t("settings.model.cloudEmbeddingHintSuffix")}
                    </p>
                  </div>
                )}

                {embeddingMode === "custom" && (
                  <>
                    <Field label={t("apiKey.model")} placeholder="text-embedding-3-small" value={embModelId} onChange={setEmbModelId} />
                    <Field label={t("apiKey.endpoint")} placeholder="https://..." value={embEndpoint} onChange={setEmbEndpoint} />
                    <PasswordField label={t("apiKey.key")} placeholder="sk-..." maskedValue={embApiKeyMasked} value={embApiKey} onChange={setEmbApiKey} show={showEmbKey} onToggle={() => setShowEmbKey(!showEmbKey)} />
                    <div className="flex min-h-9 items-center justify-end gap-3">
                      <ValidationMessage validation={embValidation} stale={isEmbeddingTestStale} />
                      <TestButton status={embValidation.status} onClick={testEmbeddingConnection} disabled={false} />
                    </div>
                  </>
                )}
              </div>

              <div className="bg-canvas-oat/40 rounded-card p-5 space-y-3.5">
                <div className="flex items-center gap-2 mb-1">
                  <Mic size={16} className="text-action-sky" />
                  <span className="text-sm font-normal text-text-ink/70">{t("apiKey.asr")}</span>
                </div>
                <p className="text-xs text-text-ink/50 -mt-1">{t("apiKey.asrHint")}</p>

                <Field
                  label={t("apiKey.asrModel")}
                  placeholder={ASR_MODEL_ID}
                  value={asrModelId || ASR_MODEL_ID}
                  onChange={setAsrModelId}
                  readOnly
                />
                <Field
                  label={t("apiKey.asrEndpoint")}
                  placeholder={ASR_DEFAULT_ENDPOINT}
                  value={asrEndpoint}
                  onChange={setAsrEndpoint}
                />
                <PasswordField
                  label={t("apiKey.asrKey")}
                  placeholder="sk-..."
                  maskedValue={asrApiKeyMasked}
                  value={asrApiKey}
                  onChange={(value) => {
                    setAsrApiKey(value);
                    setAsrWarningAcknowledged(false);
                  }}
                  show={showAsrKey}
                  onToggle={() => setShowAsrKey(!showAsrKey)}
                />
                <div className="flex min-h-9 items-center justify-end gap-3">
                  <ValidationMessage validation={asrValidation} stale={isAsrTestStale} />
                  <TestButton status={asrValidation.status} onClick={testAsrConnection} disabled={false} />
                </div>
              </div>

              <div className="bg-canvas-oat/40 rounded-card p-5 space-y-3.5">
                <div className="flex items-center gap-2 mb-1">
                  <ImageIcon size={16} className="text-action-sky" />
                  <span className="text-sm font-normal text-text-ink/70">{t("apiKey.imageGen")}</span>
                </div>
                <p className="text-xs text-text-ink/50 -mt-1">{t("apiKey.imageGenHint")}</p>

                <Select
                  label={t("apiKey.provider")}
                  value={imageGenProtocol}
                  onValueChange={changeImageGenProtocol}
                  className="select-control--paper"
                  options={IMAGE_PROTOCOL_OPTIONS.map((option) => ({
                    value: option.value,
                    label: t(option.labelKey)
                  }))}
                />
                <Field
                  label={t("apiKey.imageGenModel")}
                  placeholder={IMAGE_DEFAULT_MODEL_IDS[imageGenProtocol]}
                  value={imageGenModel}
                  onChange={setImageGenModel}
                />
                <Field
                  label={t("apiKey.imageGenEndpoint")}
                  placeholder={IMAGE_DEFAULT_ENDPOINTS[imageGenProtocol]}
                  value={imageGenEndpoint}
                  onChange={setImageGenEndpoint}
                />
                <PasswordField
                  label={t("apiKey.imageGenKey")}
                  placeholder="sk-..."
                  maskedValue={imageGenApiKeyMasked}
                  value={imageGenApiKey}
                  onChange={(value) => {
                    setImageGenApiKey(value);
                    setImageGenWarningAcknowledged(false);
                  }}
                  show={showImageGenKey}
                  onToggle={() => setShowImageGenKey(!showImageGenKey)}
                />
                <div className="flex min-h-9 items-center justify-end gap-3">
                  <ValidationMessage validation={imageGenValidation} stale={isImageGenTestStale} />
                  <TestButton status={imageGenValidation.status} onClick={testImageGenConnection} disabled={false} />
                </div>
              </div>

              <div className="flex gap-3 justify-end">
                <button
                  type="button"
                  onClick={() => setShowApiConfig(false)}
                  className="px-5 py-2.5 text-sm text-text-ink/70 bg-canvas-oat border border-border-stone/40 rounded-btn hover:bg-canvas-oat/80 transition-colors cursor-pointer"
                >
                  {t("settings.model.cancelConfig")}
                </button>
                <button
                  type="button"
                  onClick={handleSaveApiConfig}
                  disabled={!canSaveApiConfig}
                  className="px-5 py-2.5 text-sm text-white bg-action-sky rounded-btn hover:bg-action-sky-hover transition-all cursor-pointer shadow-md disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {t("settings.model.saveConfig")}
                </button>
              </div>
            </div>
          )}
        </Section>

        <Section icon={<Zap size={16} className="text-text-ink/60" />} title={t("settings.tokens")} sectionId="token-usage">
          <div className="space-y-4">
            {showGiftQuota && (
              <div>
                <div className="flex justify-between text-xs text-text-ink/65 mb-2">
                  <span>{t("settings.token.giftUsed", { count: formatNumber(giftUsedTokens) })}</span>
                  <span>{t("settings.token.total", { count: formatNumber(giftTotalTokens) })}</span>
                </div>
                <div className="h-3 bg-canvas-oat rounded-pill overflow-hidden">
                  <div
                    className={`h-full rounded-pill transition-all ${isTokenLow ? "bg-status-error" : "bg-action-sky"}`}
                    style={{ width: `${usagePercent}%` }}
                  />
                </div>
                <div className="mt-2">
                  <span className="text-xs text-text-ink/50">{t("settings.token.remaining", { count: formatNumber(giftRemainingTokens), expiry: tokenExpiryText })}</span>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              {showGiftQuota && (
                <ChannelStat
                  label={t("settings.token.platformModel")}
                  value={giftUsedTokens}
                  hint={t("settings.token.used")}
                  tone="sky"
                />
              )}
              <ChannelStat
                label={t("settings.token.customModel")}
                value={customUsedTokens}
                hint={t("settings.token.used")}
                tone="success"
              />
            </div>

            {isTokenLow && showGiftQuota && (
              <div className="flex items-center gap-2.5 p-4 bg-status-error-soft rounded-card border border-status-error/20">
                <Info size={14} className="text-status-error mt-0.5 shrink-0" />
                <p className="flex-1 text-xs text-status-error/85 leading-relaxed">
                  {t("settings.token.lowHint")}
                </p>
                {/* Only the "Request more" button is gated by the Nacos promotions.applyMore flag; the low-balance hint text keeps its original always-shown logic. When the flag can't be read, show it by default (preserving current behavior). */}
                {canApplyMoreByPromotion && (
                  <button
                    type="button"
                    onClick={openApplyMore}
                    disabled={quotaRequestPending}
                    className="shrink-0 px-3 py-1.5 text-xs font-normal text-white bg-status-error rounded-btn hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-55 disabled:cursor-not-allowed"
                  >
                    {applyMoreButtonLabel}
                  </button>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={() => updateShowUsageDetail(true)}
              className="flex items-center justify-between w-full px-4 py-3 text-sm text-text-ink/75 bg-canvas-oat/40 border-content-panel rounded-card hover:bg-canvas-oat/70 transition-colors cursor-pointer"
            >
              <span className="flex items-center gap-2">
                <Search size={15} className="text-text-ink/55" />
                {t("settings.token.viewDetail")}
                <span className="text-xs text-text-ink/45">{t("settings.token.breakdown")}</span>
              </span>
              <ChevronRight size={16} className="text-text-ink/45" />
            </button>
          </div>
        </Section>

        <Section icon={<Palette size={16} className="text-text-ink/60" />} title={t("settings.general")}>
          <SelectRow
            label={t("settings.language")}
            description={t("settings.general.languageDescription")}
            value={language}
            onChange={handleLanguageChange}
            options={[
              { value: "zh-CN", label: t("settings.general.language.zh") },
              { value: "en-US", label: "English" }
            ]}
          />
        </Section>

        <Section icon={<Rocket size={16} className="text-text-ink/60" />} title={t("settings.window")} sectionId="pet-avatar">
          <div className="space-y-1">
            <ToggleRow label={t("settings.window.launchAtLogin")} description={t("settings.window.launchAtLoginDesc")} checked={launchAtLogin} onChange={setLaunchAtLogin} />
            <Divider />
            <SelectRow
              label={t("settings.preferredMode")}
              description={t("settings.window.defaultModeDesc")}
              value={defaultLaunchMode}
              onChange={handleStartupModeChange}
              options={[
                { value: "pet", label: t("settings.window.mode.pet") },
                { value: "full", label: t("settings.window.mode.full") },
                { value: "last", label: t("settings.window.mode.last") }
              ]}
            />
            <Divider />
            <SelectRow
              label={t("settings.window.closeAction")}
              description={t("settings.window.closeActionDesc")}
              value={closeAction}
              onChange={handleCloseActionChange}
              options={[
                { value: "quit", label: t("settings.window.close.quit") },
                { value: "tray", label: t("settings.window.close.tray") },
                { value: "pet", label: t("settings.window.close.pet") }
              ]}
            />
            <Divider />
            <ToggleRow label={t("settings.window.menuBarIcon")} description={t("settings.window.menuBarIconDesc")} checked={menuBarIcon} onChange={handleMenuBarIconChange} />
          </div>
        </Section>

        <Section icon={<Bell size={16} className="text-text-ink/60" />} title={t("settings.notifications")}>
          <div className="space-y-1">
            <ToggleRow label={t("settings.notifications.update")} description={t("settings.notifications.updateDesc")} checked={autoUpdateEnabled} onChange={(checked) => persistSettings({ autoUpdateEnabled: checked })} />
            <Divider />
            <ToggleRow label={t("settings.notifications.taskDone")} description={t("settings.notifications.taskDoneDesc")} checked={taskDoneNotificationEnabled} onChange={(checked) => persistSettings({ taskDoneNotificationEnabled: checked })} />
            <Divider />
            <ToggleRow label={t("settings.notifications.sound")} description={t("settings.notifications.soundDesc")} checked={notificationSoundEnabled} onChange={(checked) => persistSettings({ notificationSoundEnabled: checked })} />
          </div>
        </Section>

        <Section icon={<Shield size={16} className="text-text-ink/60" />} title={t("settings.privacy")}>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-text-ink/70">{t("settings.privacy.shareData")}</span>
                  <span className={`px-2 py-0.5 text-[10px] font-normal rounded-tag ${improvementPlan ? "bg-action-sky/10 text-action-sky" : "bg-canvas-oat text-text-ink/55"}`}>
                    {improvementPlan ? t("settings.privacy.active") : t("settings.privacy.off")}
                  </span>
                </div>
                <p className="text-xs text-text-ink/55 mt-1 leading-relaxed">
                  {improvementPlan
                    ? t("settings.privacy.enabledDesc")
                    : t("settings.privacy.disabledDesc")}
                </p>
              </div>
              <div className="shrink-0 ml-4">
                <Toggle
                  checked={improvementPlan}
                  onChange={(checked) => persistPrivacy({ allowMemoryImprovementUpload: checked })}
                  ariaLabel={t("settings.privacy.shareData")}
                />
              </div>
            </div>
            <button
              type="button"
              onClick={() => void openExternalUrl(getLegalLinkUrl("data", language, bootstrap?.legal))}
              className="inline-flex items-center gap-1 text-xs text-action-sky/70 hover:text-action-sky transition-colors cursor-pointer"
            >
              {t("settings.privacy.learnMore")}
              <ExternalLink size={10} />
            </button>
          </div>
        </Section>

        <Section icon={<Settings2 size={16} className="text-text-ink/60" />} title={t("settings.developer")}>
          <div className="space-y-1">
            <SelectRow
              label={t("settings.developer.logLevel")}
              description={t("settings.developer.logLevelDesc")}
              value={logLevel}
              onChange={handleLogLevelChange}
              options={[
                { value: "error", label: "Error" },
                { value: "warn", label: "Warn" },
                { value: "info", label: t("settings.developer.logInfo") },
                { value: "debug", label: t("settings.developer.logDebug") }
              ]}
            />
            <div className="flex flex-wrap gap-2 pt-2 justify-start">
              <button
                type="button"
                onClick={openDeveloperLogs}
                disabled={developerBusy !== null}
                className="flex items-center gap-1.5 px-4 py-2 text-xs text-text-ink/70 border border-border-stone/40 rounded-btn hover:bg-canvas-oat/60 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {developerBusy === "openLogs" ? <Loader2 size={12} className="animate-spin" /> : <FolderOpen size={12} />}
                {t("settings.developer.openLogs")}
              </button>
              <button
                type="button"
                onClick={exportDiagnosticsReport}
                disabled={developerBusy !== null}
                className="flex items-center gap-1.5 px-4 py-2 text-xs text-text-ink/70 border border-border-stone/40 rounded-btn hover:bg-canvas-oat/60 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {developerBusy === "exportDiagnostics" ? <Loader2 size={12} className="animate-spin" /> : <ExternalLink size={12} />}
                {t("settings.developer.exportDiagnostics")}
              </button>
            </div>
            {developerFeedback && (
              <div className={`flex items-center gap-2 pt-2 text-xs ${developerFeedback.tone === "success" ? "text-status-success" : "text-status-error"}`}>
                {developerFeedback.tone === "success" ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
                <span className="min-w-0 break-all">{developerFeedback.message}</span>
              </div>
            )}
          </div>
        </Section>

        <Section icon={<Info size={16} className="text-text-ink/60" />} title={t("settings.about")}>
          <div className="space-y-3">
            <div className="flex items-center flex-wrap gap-3">
              <span className="text-text-ink/70 font-mono text-xs">Memmy v{update.appVersion}</span>
              <button
                type="button"
                onClick={() => void update.requestPrimaryAction()}
                disabled={isUpdateBusy(update.phase)}
                className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs text-action-sky border border-action-sky/30 rounded-btn hover:bg-action-sky/8 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {isUpdateBusy(update.phase) && <Loader2 size={12} className="animate-spin" />}
                {resolveUpdateButtonLabel(update.phase, t)}
              </button>
              <LinkButton label={t("settings.about.terms")} onClick={() => void openExternalUrl(getLegalLinkUrl("terms", language, bootstrap?.legal))} />
            </div>
            {update.feedback && (
              <div className={`text-xs ${update.phase === "error" ? "text-status-error" : "text-text-ink/45"}`}>
                {t(update.feedback.key, update.feedback.values)}
              </div>
            )}
          </div>
        </Section>

        <div className="h-8" />
      </div>

      {confirm && (
        <ConfirmDialog
          open
          title={confirmDialog?.title ?? ""}
          message={confirmDialog?.desc ?? ""}
          cancelLabel={t("dialog.cancel")}
          closeLabel={t("common.close")}
          confirmLabel={confirmDialog?.ok ?? t("dialog.ok")}
          confirmDisabled={accountBusy}
          confirmVariant={confirm === "logout" ? "danger" : "primary"}
          ariaLabel={confirmDialog?.ariaLabel}
          width={360}
          onCancel={() => setConfirm(null)}
          onConfirm={handleConfirmAccountExit}
        />
      )}
      {showApplyMore && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-text-ink/30 backdrop-blur-sm"
          role="presentation"
          onClick={(event) => event.target === event.currentTarget && closeApplyMore()}
        >
          <div
            className="bg-background-paper rounded-card-lg shadow-2xl w-full max-w-md mx-4 overflow-hidden border border-border-stone/30"
            role="dialog"
            aria-modal="true"
            aria-label={t("settings.token.applyMore.title")}
          >
            <div className="px-7 pt-7 pb-4 text-center">
              <div className="flex justify-center mb-1">
                <Memmy pose="hum" size={120} className="memmy-bob" />
              </div>
              <h2 className="text-lg font-bold text-text-ink">{t("settings.token.applyMore.title")}</h2>
            </div>

            <div className="px-7">
              {quotaRequestPending && !feedbackSubmitted ? (
                <p className="py-6 text-center text-sm text-status-error">
                  {t("settings.token.applyMore.pendingDesc")}
                </p>
              ) : feedbackSubmitted ? (
                <p className="py-6 text-center text-sm text-status-success">
                  {t("settings.token.applyMore.success")}
                </p>
              ) : (
                <div className="space-y-2">
                  <textarea
                    value={feedbackText}
                    onChange={(event) => {
                      setFeedbackText(event.target.value);
                      if (feedbackError) {
                        setFeedbackError(null);
                      }
                    }}
                    placeholder={t("settings.token.applyMore.placeholder")}
                    rows={5}
                    className="w-full px-3 py-2.5 text-sm text-text-ink bg-canvas-oat/40 border border-border-stone/30 rounded-card resize-none focus:outline-none"
                  />
                  {!canSubmitFeedback(feedbackText) && (
                    <p className="text-xs text-text-ink/45">
                      {t("settings.token.applyMore.minHint", { count: Math.max(0, FEEDBACK_MIN_LENGTH - feedbackLength(feedbackText)) })}
                    </p>
                  )}
                  {feedbackError && (
                    <p className="text-xs text-status-error">{feedbackError}</p>
                  )}
                </div>
              )}
            </div>

            <div className="flex gap-3 px-7 py-6 mt-1">
              {feedbackSubmitted || quotaRequestPending ? (
                <button
                  type="button"
                  onClick={closeApplyMore}
                  className="flex-1 py-3 text-sm text-white bg-action-sky rounded-btn hover:bg-action-sky-hover transition-colors font-semibold cursor-pointer shadow-md"
                >
                  {t("dialog.ok")}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={closeApplyMore}
                    className="flex-1 py-3 text-sm text-text-ink/65 bg-canvas-oat border border-border-stone/40 rounded-btn hover:bg-canvas-oat/80 transition-colors cursor-pointer"
                  >
                    {t("settings.token.applyMore.skip")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSubmitFeedback()}
                    disabled={quotaRequestPending || !canSubmitFeedback(feedbackText) || feedbackSubmitting}
                    className="flex-1 py-3 text-sm text-white bg-action-sky rounded-btn hover:bg-action-sky-hover transition-colors font-semibold cursor-pointer shadow-md disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {t("settings.token.applyMore.submit")}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
      {optionalModelMissingWarning && <OptionalModelMissingWarningModal kind={optionalModelMissingWarning} onClose={closeOptionalModelMissingWarning} />}
    </div>
  );
}

/**
 * Channel stat card props.
 *
 * Field meanings:
 * - label: The channel name.
 * - value: The cumulative Token count.
 * - hint: The value description.
 * - tone: The channel color; sky for platform, success for BYOK.
 */
interface ChannelStatProps {
  label: string;
  value: number;
  hint: string;
  tone: "sky" | "success";
}

/**
 * Renders the channel summary card within the Token usage section.
 *
 * @param props The channel stat card props.
 * @returns A single channel's cumulative usage card.
 */
function ChannelStat(props: ChannelStatProps) {
  return (
    <div className="p-3.5 bg-canvas-oat/40 rounded-card border-content-panel">
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className={`w-1.5 h-1.5 rounded-full ${props.tone === "sky" ? "bg-action-sky" : "bg-status-success"}`} />
        <span className="text-xs text-text-ink/60">{props.label}</span>
      </div>
      <div className="text-lg font-bold text-text-ink/85">
        {props.tone === "success" ? formatTokenSummary(props.value) : formatNumber(props.value)}
        <span className="text-xs font-normal text-text-ink/45 ml-1">Token</span>
      </div>
      <div className="text-[11px] text-text-ink/45 mt-0.5">{props.hint}</div>
    </div>
  );
}

/**
 * Token usage detail page props.
 *
 * Field meanings:
 * - showPlatform: Whether to show the platform-gifted channel.
 * - platformChatTokens: The platform-gifted LLM Token usage.
 * - byokUsage: The local BYOK API Key Token usage summary.
 * - byokUsageStatus: The local usage loading status.
 * - onBack: The callback to return to the settings page.
 */
interface UsageDetailViewProps {
  showPlatform: boolean;
  platformChatTokens: number;
  byokUsage: ByokTokenUsageSummary;
  byokUsageStatus: UsageLoadStatus;
  onBack: () => void;
}

/**
 * Renders the Token usage detail sub-page.
 *
 * @param props The Token usage detail page props.
 * @returns A detail page split by the platform-gifted and BYOK API Key channels.
 */
function UsageDetailView(props: UsageDetailViewProps) {
  const { t } = useTranslation();
  const hasByokRows = props.byokUsage.totalTokens > 0 || props.byokUsage.byKind.length > 0;
  const byKind = TOKEN_USAGE_KIND_ORDER.map((kind) => {
    return props.byokUsage.byKind.find((item) => item.kind === kind) ?? emptyUsageKind(kind);
  });

  return (
    <div className={`${usageStyles.detailPage} settings-page`}>
      <div className="app-frame-page-content">
        <div className={usageStyles.page}>
        <button
          type="button"
          onClick={props.onBack}
          className={usageStyles.backButton}
        >
          <ArrowLeft size={16} />
          {t("settings.back")}
        </button>

        <div className={usageStyles.titlebar}>
          <h1 className={usageStyles.title}>
            <Zap className={usageStyles.bolt} /> {t("settings.token.detail")}
          </h1>
          <UsageStatusLabel status={props.byokUsageStatus} updatedAt={props.byokUsage.updatedAt} />
        </div>

        <div className={props.showPlatform ? usageStyles.overviewGrid : usageStyles.singleOverview}>
          {props.showPlatform && (
            <UsageTotalCard
              label={t("settings.token.platformModel")}
              value={props.platformChatTokens}
              hint={t("settings.token.used")}
              tone="sky"
            />
          )}
          <UsageTotalCard
            label={t("settings.token.customModel")}
            value={props.byokUsage.totalTokens}
            hint={t("settings.token.byokLocalHint")}
            tone="success"
          />
        </div>

        <section>
          <div className={usageStyles.sectionHead}>
            <h2>{t("settings.token.categoryStats")}</h2>
            <p>{t("settings.token.breakdownHint")}</p>
          </div>

          {props.byokUsageStatus === "loading" ? (
            <div className={usageStyles.statePanel}>
              <div className={usageStyles.stateContent}>
                <Loader2 size={16} className="animate-spin" />
                {t("settings.token.loading")}
              </div>
            </div>
          ) : props.byokUsageStatus === "error" ? (
            <div className={usageStyles.statePanel}>
              <div className={usageStyles.stateContent}>
                <div className="text-sm text-status-error">{t("settings.token.loadFailedTitle")}</div>
                <div className="text-xs text-text-ink/45 mt-1">{t("settings.token.loadFailedHint")}</div>
              </div>
            </div>
          ) : hasByokRows ? (
            <div className={usageStyles.grid}>
              {byKind.map((usage) => (
                <UsageKindRow
                  key={usage.kind}
                  usage={usage}
                  grandTotal={props.byokUsage.totalTokens}
                />
              ))}
            </div>
          ) : (
            <div className={usageStyles.statePanel}>
              <div className={usageStyles.stateContent}>
                <div className="text-sm text-text-ink/65">{t("settings.token.noByokUsage")}</div>
                <div className="text-xs text-text-ink/45 mt-1">{t("settings.token.noByokUsageHint")}</div>
              </div>
            </div>
          )}
        </section>
        </div>
      </div>
    </div>
  );
}

/**
 * Token detail summary card props.
 *
 * Field meanings:
 * - label: The summary item name.
 * - value: The summarized Token count.
 * - hint: Auxiliary description.
 * - tone: The summary color.
 */
interface UsageTotalCardProps {
  label: string;
  value: number;
  hint: string;
  tone: "sky" | "success";
}

/**
 * Renders the summary card at the top of the detail page.
 *
 * @param props The summary card props.
 * @returns A single channel's detail summary card.
 */
function UsageTotalCard(props: UsageTotalCardProps) {
  return (
    <div className={`${usageStyles.panel} ${usageStyles.overview}`}>
      <div className={usageStyles.eyebrow}>
        <span className={props.tone === "sky" ? usageStyles.skyDot : usageStyles.dot} />
        {props.label}
      </div>
      <div className={usageStyles.total}>
        {props.tone === "success" ? formatTokenSummary(props.value) : formatNumber(props.value)}
        <span>Token</span>
      </div>
      <div className={usageStyles.hint}>{props.hint}</div>
    </div>
  );
}

function emptyUsageKind(kind: ByokTokenUsageKind): ByokTokenUsageByKind {
  return {
    kind,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    eventCount: 0,
    updatedAt: null
  };
}

function usageKindMeta(kind: ByokTokenUsageKind, t: SettingsTranslate): {
  label: string;
  description: string;
  icon: ReactNode;
  iconClassName: string;
  dialColor: string;
} {
  switch (kind) {
    case "agent_chat":
      return {
        label: t("settings.token.kind.agentChat"),
        description: t("settings.token.kind.agentChatDesc"),
        icon: <MessageSquare />,
        iconClassName: usageStyles.agentIcon ?? "",
        dialColor: "var(--usage-mint)"
      };
    case "memory_summary":
      return {
        label: t("settings.token.kind.memorySummary"),
        description: t("settings.token.kind.memorySummaryDesc"),
        icon: <FileText />,
        iconClassName: usageStyles.coralIcon ?? "",
        dialColor: "var(--usage-coral)"
      };
    case "memory_evolution":
      return {
        label: t("settings.token.kind.memoryEvolution"),
        description: t("settings.token.kind.memoryEvolutionDesc"),
        icon: <Sparkles />,
        iconClassName: usageStyles.lavIcon ?? "",
        dialColor: "var(--usage-lav)"
      };
    case "embedding":
      return {
        label: t("settings.token.kind.embedding"),
        description: t("settings.token.kind.embeddingDesc"),
        icon: <Database />,
        iconClassName: usageStyles.dimIcon ?? "",
        dialColor: "#74807e"
      };
  }
}

interface UsageKindRowProps {
  usage: ByokTokenUsageByKind;
  grandTotal: number;
}

function UsageKindRow(props: UsageKindRowProps) {
  const { t } = useTranslation();
  const meta = usageKindMeta(props.usage.kind, t);
  const share = props.grandTotal > 0 ? Math.round((props.usage.totalTokens / props.grandTotal) * 100) : 0;
  const inactive = props.usage.totalTokens <= 0;
  const dialStyle = {
    "--share": Math.min(100, Math.max(0, share)),
    "--tone": meta.dialColor
  } as CSSProperties;
  const cardClassName = inactive ? `${usageStyles.usageCard} ${usageStyles.inactive}` : usageStyles.usageCard;

  return (
    <article className={cardClassName}>
      <div className={usageStyles.cardTop}>
        <div className={usageStyles.kind}>
          <div className={`${usageStyles.icon} ${meta.iconClassName}`}>
            {meta.icon}
          </div>
          <div>
            <h3>{meta.label}</h3>
            <div className={usageStyles.desc}>{meta.description}</div>
          </div>
        </div>
        <div className={usageStyles.shareDial} style={dialStyle} data-share={`${share}%`} aria-label={`${share}%`} />
      </div>

      <div className={usageStyles.amountRow}>
        <div>
          <div className={usageStyles.amountLabel}>{t("settings.token.amount")}</div>
          <div className={usageStyles.amountValue}>{formatTokens(props.usage.totalTokens)}</div>
        </div>
      </div>

      <div className={usageStyles.metrics}>
        <TokenMetric
          icon={<ArrowDownToLine />}
          label={t("settings.token.input")}
          value={props.usage.inputTokens}
          accent={usageStyles.metricInput ?? ""}
        />
        <TokenMetric
          icon={<ArrowUpFromLine />}
          label={t("settings.token.output")}
          value={props.usage.outputTokens}
          accent={usageStyles.metricOutput ?? ""}
        />
        <TokenMetric
          icon={<Database />}
          label={t("settings.token.cacheHit")}
          value={props.usage.cachedInputTokens}
          accent={usageStyles.metricCache ?? ""}
        />
      </div>
    </article>
  );
}

/**
 * Token category metric props.
 *
 * Field meanings:
 * - icon: The category icon.
 * - label: The category name.
 * - value: The category's Token count.
 * - accent: The icon accent color.
 */
interface TokenMetricProps {
  icon: ReactNode;
  label: string;
  value: number;
  accent: string;
}

/**
 * Renders the input / output / cache-hit mini-metrics within a model row.
 *
 * @param props The metric props.
 * @returns A single category metric.
 */
function TokenMetric(props: TokenMetricProps) {
  return (
    <div className={usageStyles.metric}>
      <div className={`${usageStyles.metricLabel} ${props.accent}`}>
        {props.icon}
        <span>{props.label}</span>
      </div>
      <div className={usageStyles.metricValue} title={formatTokens(props.value)}>
        {formatTokens(props.value)}
      </div>
    </div>
  );
}

/**
 * Renders the BYOK summary loading state.
 *
 * @param props.status The loading status.
 * @param props.updatedAt The latest event time.
 * @returns The status text in the top-right corner.
 */
function UsageStatusLabel(props: { status: UsageLoadStatus; updatedAt: string | null }) {
  const { t } = useTranslation();
  if (props.status === "loading") {
    return (
      <span className={usageStyles.updated}>
        <Loader2 size={12} className="animate-spin" />
        {t("settings.token.loading")}
      </span>
    );
  }
  if (props.status === "error") {
    return <span className={usageStyles.statusError}>{t("settings.token.loadFailed")}</span>;
  }
  if (props.updatedAt) {
    return <span className={usageStyles.updated}>{t("settings.token.updatedAt", { value: formatUsageUpdatedAt(props.updatedAt) })}</span>;
  }
  return null;
}

/** Resolves the label for the app-level update state. */
function resolveUpdateButtonLabel(phase: UpdatePhase, t: SettingsTranslate): string {
  if (phase === "checking") {
    return t("settings.about.checkingUpdate");
  }
  if (phase === "downloading") {
    return t("settings.about.downloadingButton");
  }
  if (phase === "installing") {
    return t("settings.about.installingButton");
  }
  if (phase === "prepared") {
    return t("settings.about.installPreparedUpdate");
  }
  if (phase === "available") {
    return t("settings.about.installUpdate");
  }
  return t("settings.about.checkUpdate");
}

function isUpdateBusy(phase: UpdatePhase): boolean {
  return phase === "checking" || phase === "downloading" || phase === "installing";
}

/**
 * Settings section props.
 *
 * Field meanings:
 * - icon: The icon to the left of the prototype section title.
 * - title: The section title.
 * - sectionId: An optional DOM id, used by external buttons to scroll to a specific settings section.
 * - children: The card body content.
 */
interface SectionProps {
  icon: ReactNode;
  title: string;
  sectionId?: string;
  children: ReactNode;
}

/**
 * Renders a prototype settings section.
 *
 * @param props The section props.
 * @returns A prototype section with the title outside and the content inside a white card.
 */
function Section(props: SectionProps) {
  return (
    <div id={props.sectionId} className="mb-6">
      <div className="flex items-center gap-2 mb-3">
        {props.icon}
        <h2 className="text-sm font-semibold text-text-ink">{props.title}</h2>
      </div>
      <div className="bg-background-paper rounded-card-lg border-content-panel p-6">{props.children}</div>
    </div>
  );
}

/**
 * Settings divider.
 *
 * @returns A prototype light-colored divider.
 */
function Divider() {
  return <div className="h-px bg-border-stone/30" />;
}

/**
 * Protocol dropdown props.
 *
 * Field meanings:
 * - value: The current protocol type.
 * - onChange: The protocol change callback.
 */
interface ProtocolSelectProps {
  value: Protocol;
  onChange: (value: Protocol) => void;
}

/**
 * Renders the prototype protocol-type dropdown.
 *
 * @param props The protocol dropdown props.
 * @returns The protocol selection control.
 */
function ProtocolSelect(props: ProtocolSelectProps) {
  const { t } = useTranslation();

  return (
    <Select
      label={t("apiKey.provider")}
      value={props.value}
      onValueChange={(value) => props.onChange(value as Protocol)}
      className="select-control--paper"
      options={PROTOCOL_OPTIONS.map((option) => ({
        value: option.value,
        label: t(option.labelKey)
      }))}
    />
  );
}

/**
 * Model purpose summary props.
 *
 * Field meanings:
 * - label: The purpose name.
 * - desc: The purpose description.
 * - model: The current model display value.
 */
interface ModuleRowProps {
  label: string;
  desc: string;
  model: string;
}

/**
 * Renders a model purpose summary row in BYOK API Key mode.
 *
 * @param props The model purpose summary props.
 * @returns A single purpose and its model value.
 */
function ModuleRow(props: ModuleRowProps) {
  return (
    <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 bg-background-paper rounded-input border-content-panel">
      <div className="min-w-0">
        <div className="text-sm text-text-ink/80">{props.label}</div>
        <div className="text-[11px] text-text-ink/45">{props.desc}</div>
      </div>
      <span className="text-xs text-text-ink/60 font-mono truncate max-w-[300px] shrink-0" title={props.model}>{props.model}</span>
    </div>
  );
}

/**
 * Form field props.
 *
 * Field meanings:
 * - label: The field name.
 * - placeholder: The placeholder hint.
 * - value: The current input value.
 * - onChange: The input change callback.
 * - suffix: The unit suffix on the right.
 * - readOnly: Whether to display as read-only.
 */
interface FieldProps {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  suffix?: string;
  readOnly?: boolean;
}

/**
 * Renders the prototype text input field.
 *
 * @param props The form field props.
 * @returns An input row with a label and an optional suffix.
 */
function Field(props: FieldProps) {
  return (
    <div>
      <label className="block text-xs text-text-ink/65 mb-1.5 font-normal">{props.label}</label>
      <div className="relative">
        <input
          type="text"
          value={props.value}
          readOnly={props.readOnly}
          onChange={(event) => props.onChange(event.target.value)}
          placeholder={props.placeholder}
          className="w-full px-4 py-2.5 border border-border-stone rounded-input text-sm bg-background-paper focus:outline-none placeholder:text-text-ink/35 read-only:cursor-default"
        />
        {props.suffix && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-text-ink/40">{props.suffix}</span>}
      </div>
    </div>
  );
}

/**
 * Password field props.
 *
 * Field meanings:
 * - label: The field name.
 * - placeholder: The placeholder hint.
 * - maskedValue: The masked value of the saved secret, shown as the input placeholder (with priority) when no new value has been entered.
 * - value: The current input value.
 * - onChange: The input change callback.
 * - show: Whether to display in plaintext.
 * - onToggle: The callback to toggle between plaintext and masked.
 */
interface PasswordFieldProps {
  label: string;
  placeholder: string;
  maskedValue?: string;
  value: string;
  onChange: (value: string) => void;
  show: boolean;
  onToggle: () => void;
}

/**
 * Renders the API Key input field with a show/hide button.
 *
 * @param props The password field props.
 * @returns The API Key input control.
 */
function PasswordField(props: PasswordFieldProps) {
  const placeholder = !props.value.trim() && props.maskedValue ? props.maskedValue : props.placeholder;

  return (
    <div>
      <label className="block text-xs text-text-ink/65 mb-1.5 font-normal">{props.label}</label>
      <div className="relative">
        <input
          type={props.show ? "text" : "password"}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          placeholder={placeholder}
          className="w-full px-4 py-2.5 pr-10 border border-border-stone rounded-input text-sm bg-background-paper focus:outline-none placeholder:text-text-ink/35"
        />
        <button type="button" onClick={props.onToggle} className="absolute right-3 top-1/2 -translate-y-1/2 text-text-ink/40 hover:text-text-ink/65 cursor-pointer">
          {props.show ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </div>
    </div>
  );
}

/**
 * Connection test button props.
 *
 * Field meanings:
 * - status: The connection test status.
 * - onClick: The click-to-test callback.
 * - disabled: Whether it is disabled.
 */
interface TestButtonProps {
  status: TestStatus;
  onClick: () => void;
  disabled: boolean;
}

/**
 * Renders the prototype connection test button.
 *
 * @param props The connection test button props.
 * @returns A test button that changes with status.
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
      className={`inline-flex w-[112px] h-10 shrink-0 items-center justify-center px-4 text-xs rounded-btn border transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${
        isSuccess
          ? "text-status-success border-status-success/30 bg-status-success-soft"
          : isError
            ? "text-status-error border-status-error/30 bg-status-error-soft"
            : "text-text-ink/65 border-border-stone/40 bg-background-paper hover:bg-canvas-oat/50"
      }`}
    >
      <span className="inline-flex items-center justify-center gap-1.5">
        {isTesting && <Loader2 size={13} className="shrink-0 animate-spin" aria-hidden="true" />}
        {isSuccess && <CheckCircle2 size={13} className="shrink-0" aria-hidden="true" />}
        {isError && <XCircle size={13} className="shrink-0" aria-hidden="true" />}
        <span className="leading-none">
          {isTesting ? t("apiKey.testing") : isSuccess ? t("apiKey.testSuccess") : isError ? t("apiKey.testFailed") : t("apiKey.test")}
        </span>
      </span>
    </button>
  );
}

/**
 * Renders the primary model connection test result.
 *
 * @param props.validation The current test status.
 * @param props.stale Whether the current form already differs from the most recent successful test.
 * @returns The hint text shown by success/failure.
 */
/**
 * Model config card props.
 *
 * Field meanings:
 * - icon: The title icon.
 * - title: The model purpose name.
 * - subtitle: The model purpose description.
 * - hint: Optional hint text.
 * - cfg: The current model config.
 * - onPatch: The model config patch callback.
 * - onTest: The callback that runs a real connection test.
 * - primary: The primary LLM config, used to prefill when opting out of reuse.
 */
interface ModelConfigCardProps {
  icon: ReactNode;
  title: string;
  subtitle: string;
  hint?: string;
  cfg: ModelConfig;
  onPatch: (patch: Partial<ModelConfig>) => void;
  onTest: () => void;
  primary: PrimaryModelValues;
}

/**
 * Renders the memory-summary / skill-evolution model config card.
 *
 * @param props The model config card props.
 * @returns A prototype card that can reuse the primary model or be configured independently.
 */
function ModelConfigCard(props: ModelConfigCardProps) {
  const { t } = useTranslation();

  /**
   * Toggles whether to reuse the primary model; when opting out, prefills the blank config with the primary model.
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
  const modelFormValues = createModelFormValues(props.cfg, props.primary);
  const isTestStale = Boolean(props.cfg.validation.testedKey && props.cfg.validation.testedKey !== createModelConfigValidationKey(modelFormValues));

  return (
    <div className="bg-canvas-oat/40 rounded-card p-5 space-y-3.5">
      <div className="flex items-center gap-2 mb-1">
        {props.icon}
        <span className="text-sm font-medium text-text-ink/70">{props.title}</span>
      </div>
      <p className="text-xs text-text-ink/50 -mt-1">{props.subtitle}</p>

      <button type="button" role="checkbox" aria-checked={props.cfg.reuse} onClick={toggleReuse} className="flex items-center gap-2.5 cursor-pointer select-none">
        <span className={`w-4 h-4 rounded flex items-center justify-center border transition-colors ${props.cfg.reuse ? "bg-action-sky border-action-sky" : "bg-background-paper border-border-stone"}`}>
          {props.cfg.reuse && <Check size={12} strokeWidth={3} className="text-white" />}
        </span>
        <span className="text-xs text-text-ink/70">{t("apiKey.modelPage.reuseAgent")}</span>
      </button>

      {props.hint && (
        <div className="flex items-start gap-2 p-3 bg-action-sky/5 rounded-card border border-action-sky/15">
          <Info size={13} className="text-action-sky mt-0.5 shrink-0" />
          <p className="text-xs text-text-ink/65 leading-relaxed">{props.hint}</p>
        </div>
      )}

      {!props.cfg.reuse && (
        <div className="space-y-3.5 pt-1">
          <ProtocolSelect
            value={props.cfg.protocol}
            onChange={(value) => props.onPatch(createModelProtocolPatch(value))}
          />
          <Field
            label={t("apiKey.model")}
            placeholder={`${t("apiKey.examplePrefix")} ${DEFAULT_MODEL_IDS[props.cfg.protocol]}`}
            value={props.cfg.modelId}
            onChange={(value) => props.onPatch({ modelId: value })}
          />
          <Field label={t("apiKey.endpoint")} placeholder={`${t("apiKey.examplePrefix")} ${DEFAULT_ENDPOINTS[props.cfg.protocol]}`} value={props.cfg.endpoint} onChange={(value) => props.onPatch({ endpoint: value })} />
          <PasswordField label={t("apiKey.key")} placeholder="sk-..." maskedValue={props.cfg.apiKeyMasked} value={props.cfg.apiKey} onChange={(value) => props.onPatch({ apiKey: value })} show={props.cfg.showKey} onToggle={() => props.onPatch({ showKey: !props.cfg.showKey })} />
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
 * Toggle row props.
 *
 * Field meanings:
 * - label: The setting item name.
 * - description: The setting item description.
 * - checked: Whether it is currently on.
 * - onChange: The toggle change callback.
 */
interface ToggleRowProps {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}

/**
 * Renders a prototype toggle setting row.
 *
 * @param props The toggle row props.
 * @returns A setting row with a description and a switch on the right.
 */
function ToggleRow(props: ToggleRowProps) {
  return (
    <div className="flex items-center justify-between py-3">
      <div className="flex-1 pr-4">
        <div className="text-sm text-text-ink/70">{props.label}</div>
        <div className="text-xs text-text-ink/50 leading-relaxed">{props.description}</div>
      </div>
      <Toggle checked={props.checked} onChange={props.onChange} />
    </div>
  );
}

/**
 * Select row props.
 *
 * Field meanings:
 * - label: The setting item name.
 * - description: The setting item description.
 * - value: The currently selected value.
 * - onChange: The option change callback.
 * - options: The list of available options.
 */
interface SelectRowProps {
  label: string;
  description: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
}

/**
 * Renders a prototype select setting row.
 *
 * @param props The select row props.
 * @returns A setting row with a description and a select on the right.
 */
function SelectRow(props: SelectRowProps) {
  return (
    <div className="flex items-center justify-between py-3">
      <div className="flex-1 pr-4">
        <div className="text-sm text-text-ink/70">{props.label}</div>
        <div className="text-xs text-text-ink/50 leading-relaxed">{props.description}</div>
      </div>
      <Select
        value={props.value}
        onValueChange={props.onChange}
        options={props.options}
        className="select-control--compact select-control--subtle"
      />
    </div>
  );
}

/**
 * Switch props.
 *
 * Field meanings:
 * - checked: Whether it is currently on.
 * - onChange: The toggle callback.
 */
interface ToggleProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  ariaLabel?: string;
}

/**
 * Renders the prototype switch control.
 *
 * @param props The switch props.
 * @returns A rounded slider switch.
 */
function Toggle(props: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.ariaLabel}
      onClick={() => props.onChange(!props.checked)}
      className={`relative inline-flex shrink-0 h-5 w-9 items-center rounded-full border-0 p-0 cursor-pointer transition-colors ${
        props.checked ? "bg-action-sky" : "bg-border-stone"
      }`}
    >
      <span className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${props.checked ? "translate-x-[18px]" : "translate-x-0.5"}`} />
    </button>
  );
}

/**
 * Link button props.
 *
 * Field meanings:
 * - label: The button label.
 * - onClick: The internal navigation behavior run on click.
 */
interface LinkButtonProps {
  label: string;
  onClick: () => void;
}

/**
 * Renders the About-section link button.
 *
 * @param props The link button props.
 * @returns A prototype light-colored link button.
 */
function LinkButton(props: LinkButtonProps) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs text-text-ink/70 bg-canvas-oat/40 border border-border-stone/30 rounded-btn hover:bg-canvas-oat hover:border-border-stone transition-all"
    >
      {props.label}
      <ExternalLink size={11} />
    </button>
  );
}

/**
 * Parses the diagnostics report export result.
 *
 * @param result The raw value returned by the Electron preload bridge.
 * @returns The normalized canceled or success result.
 */
function parseDiagnosticsReportExportResult(result: unknown): DiagnosticsReportExportResult {
  if (result && typeof result === "object" && (result as { canceled?: unknown }).canceled === true) {
    return { canceled: true };
  }

  if (
    result &&
    typeof result === "object" &&
    (result as { canceled?: unknown }).canceled === false &&
    typeof (result as { exportPath?: unknown }).exportPath === "string" &&
    typeof (result as { bytes?: unknown }).bytes === "number"
  ) {
    const host = (result as { host?: unknown }).host;
    return {
      canceled: false,
      exportPath: (result as { exportPath: string }).exportPath,
      bytes: (result as { bytes: number }).bytes,
      host: host === "electron" || host === "browser" ? host : undefined
    };
  }

  throw new Error("Invalid diagnostics report export result");
}

/**
 * Exports the renderer-side diagnostics report using the browser download capability.
 *
 * @param report The redacted diagnostics report text.
 * @returns The download result; exportPath is the file name in the browser fallback.
 */
async function downloadDiagnosticsReportInBrowser(report: string): Promise<DiagnosticsReportExportResult> {
  if (typeof document === "undefined" || typeof window === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new Error("Diagnostics report download is unavailable in this runtime");
  }

  const fileName = `memmy-renderer-diagnostics-${formatDiagnosticsTimestamp(new Date())}.txt`;
  const blob = new Blob([report], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noreferrer";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);

  return {
    canceled: false,
    exportPath: fileName,
    bytes: blob.size,
    host: "browser"
  };
}

/**
 * Builds the renderer fallback diagnostics report.
 *
 * @param input The non-sensitive state visible to the renderer.
 * @returns A downloadable plain-text diagnostics report.
 */
function buildRendererDiagnosticsReport(input: RendererDiagnosticsReportInput): string {
  const locationText = typeof window === "undefined" ? "<server-render>" : window.location.href;
  const userAgent = typeof navigator === "undefined" ? "<unknown>" : navigator.userAgent;
  const hasAccountIdentifier = Boolean(input.state.account.email || input.state.account.phoneNumber);
  const hasBootstrap = Boolean(input.state.bootstrap);
  const hasModelConfig = Boolean(input.state.modelConfig.configured);

  const lines = [
    "Memmy Renderer Diagnostics Report",
    "=================================",
    "",
    "Generated At",
    `- ISO Time: ${new Date().toISOString()}`,
    "",
    "Renderer",
    `- Location: ${locationText}`,
    `- Language: ${input.language}`,
    `- User Agent: ${userAgent}`,
    "",
    "Desktop Bridge",
    `- window.memmy: ${input.bridgeAvailable ? "available" : "missing"}`,
    `- exportDiagnosticsReport: ${input.exportBridgeAvailable ? "available" : "missing"}`,
    "",
    "Application State",
    `- Bootstrap Loaded: ${hasBootstrap ? "yes" : "no"}`,
    `- User Mode: ${input.state.bootstrap?.app.userMode ?? "<unknown>"}`,
    `- Account Identifier Present: ${hasAccountIdentifier ? "yes" : "no"}`,
    `- Model Configured: ${hasModelConfig ? "yes" : "no"}`,
    "",
    "Notes",
    "- This fallback report is generated by the renderer because the Electron diagnostics bridge is unavailable.",
    "- Secrets, tokens, account identifiers, localStorage contents, prompts, and task messages are intentionally omitted."
  ];

  return `${lines.join("\n")}\n`;
}

/**
 * Formats the timestamp for the diagnostics report file name.
 *
 * @param date The current time.
 * @returns The YYYYMMDD-HHMMSS format.
 */
function formatDiagnosticsTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

/**
 * Formats the local path in developer feedback.
 *
 * @param filePath The local absolute path.
 * @returns A readable path with the username hidden.
 */
function formatDeveloperPath(filePath: string): string {
  return filePath.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
}

/**
 * Formats a file size.
 *
 * @param bytes The raw byte count.
 * @returns Short text with a unit.
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

interface AccountConfirmDialogContent {
  ariaLabel: string;
  desc: string;
  ok: string;
  title: string;
}

function resolveAccountConfirmDialog(
  kind: Exclude<ConfirmKind, null>,
  t: (key: MessageKey, values?: MessageValues) => string
): AccountConfirmDialogContent {
  if (kind === "logout") {
    return {
      ariaLabel: t("settings.account.logoutTitle"),
      title: t("settings.account.logoutTitle"),
      desc: t("settings.account.logoutDesc"),
      ok: t("settings.account.logoutOk")
    };
  }

  return {
    ariaLabel: t("settings.account.exitLocalTitle"),
    title: t("settings.account.exitLocalTitle"),
    desc: t("settings.account.exitLocalDesc"),
    ok: t("settings.account.exitLocalOk")
  };
}

/**
 * Resolves the registered account's primary identifier.
 *
 * @param state The current global UI state.
 * @returns Email first, then phone number.
 */
function resolveAccountIdentifier(state: AppState): string {
  return state.account.email || state.account.phoneNumber || "";
}

/**
 * Resolves the default nickname.
 *
 * @param identifier The email or phone number.
 * @returns The default nickname shown and submitted when no nickname is filled in.
 */
function resolveDefaultNickname(identifier: string): string {
  return identifier.trim();
}

/**
 * Resolves the account avatar initials.
 *
 * @param value The nickname, email, or phone number.
 * @returns One to two characters of avatar initials.
 */
function resolveAccountInitials(value: string): string {
  const base = value.includes("@") ? (value.split("@")[0] ?? value) : value;
  const normalized = base.trim();
  if (!normalized) {
    return "·";
  }

  const parts = normalized.split(/[\s._-]+/).filter(Boolean);
  const initials = (parts.length > 1 ? parts.slice(0, 2) : [normalized])
    .map((part) => Array.from(part)[0] ?? "")
    .join("");

  return initials.toUpperCase() || "·";
}

/**
 * Formats the account registration time.
 *
 * @param value An ISO 8601 time string.
 * @returns A settings-page-readable registration time.
 */
function formatRegisteredAt(value: string | null, t: SettingsTranslate): string {
  if (!value) {
    return t("settings.registeredUnknown");
  }

  const [normalized] = value.trim().split(/[T\s]/);
  if (!normalized) {
    return t("settings.registeredUnknown");
  }

  return normalized;
}

/**
 * Resolves the fallback text for the account name.
 *
 * @param userMode The current user mode.
 * @returns The display name for the account area.
 */
function resolveAccountFallback(userMode: AppSettingsDto["userMode"] | undefined, t: SettingsTranslate): string {
  return userMode === "byok" ? t("settings.account.localMode") : t("settings.account.noAccount");
}

/**
 * Resolves the fallback text for the account description.
 *
 * @param userMode The current user mode.
 * @returns The account-area description; in account mode it favors neither email nor phone number.
 */
function resolveAccountMeta(userMode: AppSettingsDto["userMode"] | undefined, t: SettingsTranslate): string {
  return userMode === "byok" ? t("settings.account.localModeMeta") : t("settings.account.noIdentifier");
}

/**
 * Resolves the initial model display mode for the settings page.
 *
 * @param userMode The current user mode.
 * @returns A registered account defaults to platform Token; local BYOK mode defaults to the BYOK API Key.
 */
function resolveInitialModelMode(userMode: AppSettingsDto["userMode"] | undefined): ModelMode {
  return userMode === "byok" ? "custom" : "platform";
}

/**
 * Determines whether a quota request error means an approval is already pending.
 *
 * @param error The original error.
 * @returns True when the UI should switch to the "request pending" state.
 */
export function isPendingQuotaRequestError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : null;
  if (code === "conflict") {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return /\u5f85\u5ba1\u6279|\u91cd\u590d\u63d0\u4ea4|\u5df2\u6709.*\u7533\u8bf7|pending|duplicate/i.test(error.message);
}

/**
 * Formats the Token expiry time.
 *
 * @param value The ISO 8601 expiry time; null means no expiry limit.
 * @returns A readable validity description for the settings-page Token area.
 */
function formatTokenExpiry(value: string | null, t: SettingsTranslate): string {
  if (!value) {
    return t("settings.token.neverExpires");
  }

  const [date] = value.split("T");
  return t("settings.token.expiresAt", { date: date || value });
}

/**
 * Formats the BYOK usage update time.
 *
 * @param value An ISO 8601 time string.
 * @returns A local detail-page time trimmed to the minute.
 */
export function formatUsageUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  // Display in the local time zone (the original implementation just truncated the ISO string, showing UTC directly, off by 8 hours).
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Formats a Token count.
 *
 * @param value The raw number.
 * @returns Displayed in M units with one decimal place; the balance is not rounded up, to avoid inflating the available quota.
 */
function formatNumber(value: number): string {
  const millions = Math.floor((value / 1_000_000) * 10) / 10;
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1
  }).format(millions)}M`;
}

/**
 * Formats a summarized Token count.
 *
 * @param value The raw number.
 * @returns Uses the one-decimal M abbreviation when it can be shown, otherwise the full number with thousands separators.
 */
function formatTokenSummary(value: number): string {
  const abbreviated = formatNumber(value);
  return abbreviated === "0.0M" ? formatTokens(value) : abbreviated;
}

/**
 * Formats a Token count for the detail page.
 *
 * @param value The raw number.
 * @returns The full number with thousands separators, for easy detail verification.
 */
function formatTokens(value: number): string {
  return value.toLocaleString("en-US");
}
