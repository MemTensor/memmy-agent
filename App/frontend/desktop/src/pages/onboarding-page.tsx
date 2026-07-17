/** Onboarding page module. */
import { useEffect, useRef, useState } from "react";
import { PenLine, Search, type LucideIcon } from "lucide-react";
import type { AgentSourceMemoryPluginConflict, ScanPermission } from "@memmy/local-api-contracts";
import { useApiClients } from "../app/providers.js";
import { buildOnboardingCompletionPatch, readGuidanceCompleted, resolvePostOnboardingRoute, writeDeferredGuidanceStep, writePreferredMode, type PreferredMode } from "../app/routes.js";
import { useAnalytics } from "../analytics/use-analytics.js";
import { resolveAnalyticsPageLocation } from "../analytics/page-location.js";
import { Memmy } from "../components/mascot/memmy.js";
import { useTranslation } from "../i18n/use-translation.js";
import { agentActions, appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import { startAgentSourceScan } from "./memory-source-scan.js";
import { formatAgentSourceScanRequestError } from "./agent-source-scan-error.js";
import { FirstEncounterReport } from "./first-encounter-report.js";
import { clearPendingFirstEncounterTaskLaunch, writePendingFirstEncounterTaskLaunch } from "./first-encounter-task-launch.js";
import {
  streamFirstEncounterReport,
  type DiscoveredAgent,
  type FirstEncounterReportPayload,
  type FirstEncounterTaskAction
} from "./first-encounter-protocol.js";
import { HomePage } from "./home-page.js";
import { MemoryPluginConflictModal } from "./memory-plugin-conflict-modal.js";
import { scheduleMemoryPanelCachePrefetch } from "./memory/memory-panel-prefetch.js";
import { OnboardingScanAnimation } from "./onboarding-scan-animation.js";

type FirstScanStep = "checking_plugins" | "plugin_conflict" | "scanning" | "preparing_report" | "report";

const FIRST_SCAN_ANIMATION_MIN_MS = 2_000;

/** Handles onboarding page. */
export function OnboardingPage() {
  const { state, dispatch } = useAppState();
  const { clients } = useApiClients();
  const { track } = useAnalytics();
  const { t, language } = useTranslation();
  const [firstScanStep, setFirstScanStep] = useState<FirstScanStep | null>(null);
  const [firstScanAgents, setFirstScanAgents] = useState<DiscoveredAgent[] | null>(null);
  const [firstReportPayload, setFirstReportPayload] = useState<FirstEncounterReportPayload | null>(null);
  const [firstReportIsStreaming, setFirstReportIsStreaming] = useState(false);
  const [firstReportShouldSimulate, setFirstReportShouldSimulate] = useState(false);
  const [firstReportError, setFirstReportError] = useState<string | null>(null);
  const [firstScanAnimationStartedAt, setFirstScanAnimationStartedAt] = useState<number | null>(null);
  const [, setCompletionFeedback] = useState<string | null>(null);
  const [pluginConflictOpen, setPluginConflictOpen] = useState(false);
  const [pluginConflicts, setPluginConflicts] = useState<AgentSourceMemoryPluginConflict[]>([]);
  const [pluginConflictResolving, setPluginConflictResolving] = useState(false);
  const isCompletingOnboarding = useRef(false);
  const hasStartedAgentSourceScan = useRef(false);
  const hasResumedFirstScan = useRef(false);
  const hasStartedFirstReport = useRef(false);
  const firstScanStepRef = useRef<FirstScanStep | null>(null);
  const firstScanVisualComplete = useRef(false);
  const onboarding = state.bootstrap?.onboarding;
  const isAccountMode = state.bootstrap?.app.userMode === "account";
  const guidanceCompleted = readGuidanceCompleted(typeof window === "undefined" ? undefined : window.localStorage);
  const shouldResumeFirstScan = Boolean(
    onboarding &&
    !onboarding.completed &&
    onboarding.currentStep === "scan_permission_required" &&
    (onboarding.scanPermission === "scan_only" || onboarding.scanPermission === "scan_and_write_skill")
  );
  const resumedFirstScanStep: FirstScanStep | null = shouldResumeFirstScan
    ? onboarding?.scanPermission === "scan_and_write_skill"
      ? "checking_plugins"
      : "scanning"
    : null;
  const activeFirstScanStep = guidanceCompleted ? null : (firstScanStep ?? resumedFirstScanStep);
  const scanOpen =
    !guidanceCompleted &&
    !activeFirstScanStep &&
    (!onboarding || (!onboarding.completed && onboarding.currentStep === "scan_permission_required"));
  const productTourOpen = Boolean(
    !guidanceCompleted &&
    !activeFirstScanStep &&
    onboarding &&
    !onboarding.completed &&
    (onboarding.currentStep === "product_tour_required" || onboarding.currentStep === "improvement_program_required")
  );
  const hasRenderableOnboardingStep = Boolean(activeFirstScanStep || scanOpen || productTourOpen);

  useEffect(() => {
    firstScanStepRef.current = firstScanStep;
  }, [firstScanStep]);

  useEffect(() => {
    if (!shouldResumeFirstScan || firstScanStep || !clients || hasResumedFirstScan.current) {
      return;
    }

    hasResumedFirstScan.current = true;
    void resumeFirstScan().catch((error) => {
      console.warn("resume first agent source scan failed", error);
    });
  }, [clients, firstScanStep, shouldResumeFirstScan]);

  useEffect(() => {
    if (state.startup.status === "ready" && !hasRenderableOnboardingStep) {
      dispatch(appActions.navigate("/main"));
    }
  }, [dispatch, hasRenderableOnboardingStep, state.startup.status]);

  useEffect(() => {
    if (!firstReportPayload || !firstScanAnimationStartedAt || pluginConflictOpen || activeFirstScanStep === "report") {
      return;
    }

    if (activeFirstScanStep !== "scanning" && activeFirstScanStep !== "preparing_report") {
      return;
    }

    const elapsedMs = Date.now() - firstScanAnimationStartedAt;
    const timeout = window.setTimeout(() => {
      firstScanVisualComplete.current = true;
      setFirstScanStep("report");
    }, Math.max(0, FIRST_SCAN_ANIMATION_MIN_MS - elapsedMs));

    return () => window.clearTimeout(timeout);
  }, [activeFirstScanStep, firstReportPayload, firstScanAnimationStartedAt, pluginConflictOpen]);

  useEffect(() => {
    if (!onboarding || onboarding.completed || onboarding.currentStep !== "improvement_program_required") {
      return;
    }

    const patch = { currentStep: "product_tour_required" } as const;
    dispatch(appActions.onboardingUpdated(patch));
    void clients?.config
      .updateOnboarding(patch)
      .then((persistedPatch) => dispatch(appActions.onboardingUpdated(persistedPatch)))
      .catch((error) => {
        console.warn("migrate legacy improvement onboarding step failed", error);
      });
  }, [onboarding, dispatch, clients]);

  useEffect(() => {
    if (!onboarding || onboarding.completed || onboarding.currentStep !== "product_tour_required") {
      return;
    }
    void completeOnboarding("full");
  }, [onboarding]);

  /** Handles choose permission. */
  async function choosePermission(permission: ScanPermission) {
    const preferences =
      permission === "scan_and_write_skill"
        ? { autoScanKnownAgents: true, watchFileChanges: true, autoInjectSkill: true }
        : permission === "scan_only"
          ? { autoScanKnownAgents: true, watchFileChanges: true, autoInjectSkill: false }
          : { autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false };
    const patch = permission === "none"
      ? { scanPermission: permission, currentStep: "product_tour_required" } as const
      : { completed: false, currentStep: "scan_permission_required", scanPermission: permission } as const;

    dispatch(appActions.onboardingUpdated(patch));
    dispatch(appActions.scanPreferencesUpdated(preferences));
    track({ name: "onboarding_step_completed", params: { step: "scan_permission", step_index: 1, choice: permission }, consentTier: "basic" });
    if (permission !== "none") {
      prepareFirstScanUi(permission === "scan_and_write_skill" ? "checking_plugins" : "scanning");
      if (clients) {
        try {
          const persistedPatch = await clients.config.updateOnboarding(patch);
          dispatch(appActions.onboardingUpdated(persistedPatch));
          dispatch(appActions.scanPreferencesUpdated(await clients.config.updateScanPreferences(preferences)));
          if (permission === "scan_and_write_skill") {
            void startFirstScanInBackground().catch((error) => {
              console.warn("start first agent source scan failed", error);
            });
            const conflicts = await detectExistingMemoryPluginConflicts();
            if (conflicts.length > 0) {
              setPluginConflicts(conflicts);
              setPluginConflictOpen(true);
              setFirstScanStep("plugin_conflict");
              return;
            }
          }
          await startFirstScanWithAnimation();
        } catch (error) {
          console.warn("start first agent source scan failed", error);
        }
      }
    } else {
      void clients?.config
        .updateOnboarding(patch)
        .then((persistedPatch) => {
          dispatch(appActions.onboardingUpdated(persistedPatch));
          return clients.config.updateScanPreferences(preferences);
        })
        .then((persistedPreferences) => {
          dispatch(appActions.scanPreferencesUpdated(persistedPreferences));
        })
        .catch((error) => {
          console.warn("save scan permission failed", error);
        });
    }
  }

  async function resumeFirstScan() {
    if (!clients) {
      return;
    }

    prepareFirstScanUi(onboarding?.scanPermission === "scan_and_write_skill" ? "checking_plugins" : "scanning");
    if (onboarding?.scanPermission === "scan_and_write_skill") {
      void startFirstScanInBackground().catch((error) => {
        console.warn("resume first agent source scan failed", error);
      });
      const conflicts = await detectExistingMemoryPluginConflicts();
      if (conflicts.length > 0) {
        setPluginConflicts(conflicts);
        setPluginConflictOpen(true);
        setFirstScanStep("plugin_conflict");
        return;
      }
    }

    await startFirstScanWithAnimation();
  }

  function prepareFirstScanUi(step: FirstScanStep = "scanning") {
    setPluginConflictOpen(false);
    setPluginConflicts([]);
    setPluginConflictResolving(false);
    setFirstScanAgents(null);
    setFirstReportPayload(null);
    setFirstReportIsStreaming(false);
    setFirstReportShouldSimulate(false);
    setFirstReportError(null);
    setFirstScanAnimationStartedAt(null);
    hasStartedAgentSourceScan.current = false;
    hasStartedFirstReport.current = false;
    firstScanVisualComplete.current = false;
    setFirstScanStep(step);
  }

  async function detectExistingMemoryPluginConflicts(): Promise<AgentSourceMemoryPluginConflict[]> {
    if (!clients) {
      return [];
    }

    try {
      return await clients.agentSources.getMemoryPluginConflicts();
    } catch (error) {
      console.warn("detect memory plugin conflicts failed", error);
      return [];
    }
  }

  /** Handles resolve memory plugin conflict. */
  async function resolveMemoryPluginConflict(replace: boolean) {
    if (!clients || pluginConflictResolving) {
      return;
    }

    const conflicts = pluginConflicts;
    setPluginConflictResolving(true);
    setPluginConflictOpen(false);
    setPluginConflicts([]);
    void finishMemoryPluginConflictInstall(replace, conflicts);
    await startFirstScanWithAnimation();
  }

  function returnToScanPermission() {
    const onboardingPatch = { completed: false, currentStep: "scan_permission_required", scanPermission: "unset" } as const;
    const preferences = { autoScanKnownAgents: true, watchFileChanges: true, autoInjectSkill: false };

    setPluginConflictOpen(false);
    setPluginConflicts([]);
    setPluginConflictResolving(false);
    setFirstScanAgents(null);
    setFirstReportPayload(null);
    setFirstReportIsStreaming(false);
    setFirstReportShouldSimulate(false);
    setFirstReportError(null);
    setFirstScanAnimationStartedAt(null);
    hasStartedAgentSourceScan.current = false;
    hasStartedFirstReport.current = false;
    firstScanVisualComplete.current = false;
    setFirstScanStep(null);
    dispatch(appActions.onboardingUpdated(onboardingPatch));
    dispatch(appActions.scanPreferencesUpdated(preferences));
    void clients?.config
      .updateOnboarding(onboardingPatch)
      .then((persistedPatch) => dispatch(appActions.onboardingUpdated(persistedPatch)))
      .catch((error) => {
        console.warn("return to scan permission failed", error);
      });
    void clients?.config
      .updateScanPreferences(preferences)
      .then((persistedPreferences) => dispatch(appActions.scanPreferencesUpdated(persistedPreferences)))
      .catch((error) => {
        console.warn("reset scan preferences failed", error);
      });
  }

  async function finishMemoryPluginConflictInstall(replace: boolean, conflicts: AgentSourceMemoryPluginConflict[]) {
    if (!clients) {
      setPluginConflictResolving(false);
      return;
    }

    try {
      await Promise.all(
        conflicts.map((conflict) =>
          replace ? clients.agentSources.installPlugin(conflict.sourceId) : clients.agentSources.installSkill(conflict.sourceId)
        )
      );
      dispatch(appActions.agentSourcesRefreshed(await clients.agentSources.listSources()));
    } catch (error) {
      console.warn("resolve memory plugin conflict failed", error);
      dispatch(appActions.agentSourcesFailed(error instanceof Error ? error.message : String(error)));
    } finally {
      setPluginConflictResolving(false);
    }
  }

  async function startFirstScanWithAnimation() {
    if (!clients) {
      return;
    }

    setFirstScanStep("scanning");
    setFirstScanAnimationStartedAt(Date.now());
    await startFirstScanInBackground();
  }

  async function startFirstScanInBackground() {
    if (!clients) {
      return;
    }

    startFirstReport([]);
    if (hasStartedAgentSourceScan.current) {
      return;
    }
    hasStartedAgentSourceScan.current = true;
    try {
      await startAgentSourceScan({
        clients,
        dispatch,
        queuedMessage: t("memory.scanQueued"),
        formatError: (error) => formatAgentSourceScanRequestError(error, undefined, t),
        scheduleFallback: (callback, delayMs) => globalThis.setTimeout(callback, delayMs)
      });
    } catch (error) {
      hasStartedAgentSourceScan.current = false;
      throw error;
    }
  }

  function completeFirstScan(agents: DiscoveredAgent[]) {
    if (pluginConflictOpen || firstScanStep === "plugin_conflict" || firstScanStep === "checking_plugins") {
      return;
    }

    firstScanVisualComplete.current = true;
    if (!firstScanAgents && agents.length > 0) {
      setFirstScanAgents(agents);
    }
    startFirstReport(agents);
    if (!firstReportPayload) {
      setFirstScanStep("preparing_report");
    }
  }

  function startFirstReport(seedAgents: DiscoveredAgent[]) {
    if (hasStartedFirstReport.current) {
      return;
    }
    hasStartedFirstReport.current = true;
    setFirstReportPayload(null);
    setFirstReportIsStreaming(false);
    setFirstReportShouldSimulate(false);
    setFirstReportError(null);
    if (clients) {
      scheduleMemoryPanelCachePrefetch({
        client: clients.memoryRuntime,
        language,
        t
      });
    }
    void streamFirstEncounterReport(
      { agents: seedAgents, nickname: state.account.nickname, language },
      {
        onAgents: (sampledAgents) => {
          setFirstScanAgents(sampledAgents);
        },
        onChunk: (_delta) => {
          setFirstReportIsStreaming(true);
          setFirstReportShouldSimulate(true);
        },
        onDone: (payload, _meta) => {
          setFirstReportIsStreaming(false);
          setFirstReportShouldSimulate(true);
          setFirstReportPayload(payload);
          setFirstScanAgents(payload.agents.length > 0 ? payload.agents : seedAgents);
          firstScanVisualComplete.current = true;
        }
      }
    ).catch((error) => {
      console.error("prepare first encounter report failed", error);
      hasStartedFirstReport.current = false;
      setFirstReportIsStreaming(false);
      setFirstReportShouldSimulate(false);
      setFirstReportError(toReadableFirstReportError(error, t("onboarding.report.errorFallback")));
      firstScanVisualComplete.current = true;
      if (firstScanStepRef.current === "scanning" || firstScanStepRef.current === "preparing_report") {
        setFirstScanStep("preparing_report");
      }
    });
  }

  function continueAfterReport() {
    const patch = { currentStep: "product_tour_required" } as const;

    setFirstScanStep(null);
    setFirstScanAgents(null);
    setFirstReportPayload(null);
    setFirstReportIsStreaming(false);
    setFirstReportShouldSimulate(false);
    setFirstReportError(null);
    setFirstScanAnimationStartedAt(null);
    hasStartedAgentSourceScan.current = false;
    hasStartedFirstReport.current = false;
    firstScanVisualComplete.current = false;
    dispatch(appActions.onboardingUpdated(patch));
    void clients?.config
      .updateOnboarding(patch)
      .then((persistedPatch) => dispatch(appActions.onboardingUpdated(persistedPatch)))
      .catch((error) => {
        console.warn("save post scan onboarding step failed", error);
      });
  }

  function startReportTask(action: FirstEncounterTaskAction) {
    writePendingFirstEncounterTaskLaunch(typeof window === "undefined" ? undefined : window.sessionStorage, action.suggestedPrompt);
    enterConversationAfterReport();
  }

  function startFirstConversation() {
    clearPendingFirstEncounterTaskLaunch(typeof window === "undefined" ? undefined : window.sessionStorage);
    enterConversationAfterReport();
  }

  function enterConversationAfterReport() {
    const completionPatch = buildOnboardingCompletionPatch(new Date().toISOString());
    const targetRoute = resolvePostOnboardingRoute("full");

    writePreferredMode(typeof window === "undefined" ? undefined : window.localStorage, "full");
    dispatch(agentActions.newChatRequested());
    dispatch(appActions.preferredModeUpdated("full"));
    dispatch(appActions.onboardingUpdated(completionPatch));
    writeDeferredGuidanceStep(typeof window === "undefined" ? undefined : window.sessionStorage, "armed");
    dispatch(appActions.navigate(targetRoute));
    track({ name: "onboarding_step_completed", params: { step: "mode_selection", step_index: 3, choice: "full" }, consentTier: "basic" });
    track({ name: "onboarding_completed", params: {}, consentTier: "basic" });
    track({ name: "first_entry", params: { page_location: resolveAnalyticsPageLocation(targetRoute) }, consentTier: "basic" });
    void persistReportConversationCompletion(completionPatch).catch((error) => {
      console.warn("persist report conversation onboarding completion failed", error);
    });
  }

  async function persistReportConversationCompletion(completionPatch: ReturnType<typeof buildOnboardingCompletionPatch>) {
    if (!clients) {
      throw new Error("Memmy API client is not ready");
    }

    await clients.config.updatePreferredMode("full");
    const persistedPatch = await clients.config.updateOnboarding(completionPatch);
    if (isAccountMode) {
      await clients.account.markGuideFinished();
    }
    dispatch(appActions.onboardingUpdated(persistedPatch ?? completionPatch));
  }

  /**
   * Completes the onboarding flow and writes the default startup mode.
   *
   * @param mode The default startup form the user selected.
   */
  async function completeOnboarding(mode: PreferredMode) {
    if (isCompletingOnboarding.current) {
      return;
    }

    const completionPatch = buildOnboardingCompletionPatch(new Date().toISOString());
    const targetRoute = resolvePostOnboardingRoute(mode);
    isCompletingOnboarding.current = true;
    setCompletionFeedback(null);

    try {
      if (!clients) {
        throw new Error("Memmy API client is not ready");
      }

      await clients.config.updatePreferredMode(mode);
      const persistedPatch = await clients.config.updateOnboarding(completionPatch);
      // In account mode, whether onboarding is finished is determined by the cloud hasFinishedGuide, which must be set on completion;
      // otherwise the next login's reconcile finds it unfinished in the cloud and pulls the local completed state back to the onboarding start, causing onboarding to pop up again.
      // BYOK has no cloud account and only needs the local onboarding completion state.
      if (isAccountMode) {
        await clients.account.markGuideFinished();
      }
      writePreferredMode(typeof window === "undefined" ? undefined : window.localStorage, mode);
      dispatch(appActions.preferredModeUpdated(mode));
      dispatch(appActions.onboardingUpdated(persistedPatch ?? completionPatch));
      track({ name: "onboarding_step_completed", params: { step: "mode_selection", step_index: 3, choice: mode }, consentTier: "basic" });
      track({ name: "onboarding_completed", params: {}, consentTier: "basic" });
      track({ name: "first_entry", params: { page_location: resolveAnalyticsPageLocation(targetRoute) }, consentTier: "basic" });
      writeDeferredGuidanceStep(typeof window === "undefined" ? undefined : window.sessionStorage, "armed");
      dispatch(appActions.navigate(targetRoute));
    } catch (error) {
      console.error("complete onboarding failed", error);
      setCompletionFeedback(t("onboarding.complete.error"));
    } finally {
      isCompletingOnboarding.current = false;
    }

  }

  if (productTourOpen) {
    return <HomePage />;
  }

  if (
    activeFirstScanStep === "scanning" ||
    activeFirstScanStep === "preparing_report"
  ) {
    return (
      <main className="min-h-screen bg-canvas-oat">
        <OnboardingScanAnimation
          sources={state.agentSources.items}
          agents={firstScanAgents}
          progress={state.agentSources.scanProgress}
          isScanning={state.agentSources.isScanning}
          isPreparingReport={activeFirstScanStep === "preparing_report"}
          errorMessage={firstReportError}
          onComplete={completeFirstScan}
          onSkip={() => void completeOnboarding("full")}
        />
      </main>
    );
  }

  if (activeFirstScanStep === "checking_plugins" || activeFirstScanStep === "plugin_conflict") {
    return (
      <main className="min-h-screen bg-canvas-oat">
        {pluginConflictOpen && (
          <MemoryPluginConflictModal
            onBack={returnToScanPermission}
            onChoice={(replace) => void resolveMemoryPluginConflict(replace)}
            resolving={pluginConflictResolving}
          />
        )}
      </main>
    );
  }

  if (activeFirstScanStep === "report") {
    if (!firstReportPayload) {
      return (
        <main className="min-h-screen bg-canvas-oat">
          <OnboardingScanAnimation
            sources={state.agentSources.items}
            agents={firstScanAgents}
            progress={state.agentSources.scanProgress}
            isScanning={state.agentSources.isScanning}
            isPreparingReport={true}
            errorMessage={firstReportError}
            onComplete={completeFirstScan}
            onSkip={() => void completeOnboarding("full")}
          />
        </main>
      );
    }

    return (
      <main className="min-h-screen bg-canvas-oat">
        <FirstEncounterReport
          payload={firstReportPayload}
          isStreaming={firstReportIsStreaming}
          simulateStreaming={firstReportShouldSimulate}
          onTaskClick={startReportTask}
          onStartConversation={startFirstConversation}
          onSkip={continueAfterReport}
        />
      </main>
    );
  }

  if (!hasRenderableOnboardingStep) {
    return <HomePage />;
  }

  return (
    <main className="min-h-screen bg-canvas-oat">
      {scanOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-text-ink/30 backdrop-blur-sm">
          <div className="bg-background-paper rounded-card-lg shadow-2xl w-full max-w-md mx-4 overflow-hidden border border-border-stone/30">
            <div className="px-7 pt-7 pb-5 text-center">
              <div className="flex justify-center mb-2">
                <Memmy pose="shield" size={96} className="memmy-bob" />
              </div>
              <h2 className="text-lg font-bold text-text-ink">{t("onboarding.permission.title")}</h2>
              <p className="text-sm text-text-ink/50 mt-1.5">{t("onboarding.permission.subtitle")}</p>
            </div>

            <div className="px-7 space-y-3">
              <PermissionCard
                icon={Search}
                title={t("onboarding.permission.scanTitle")}
                description={t("onboarding.permission.scanBody")}
              />
              <PermissionCard
                icon={PenLine}
                title={t("onboarding.permission.writeTitle")}
                description={t("onboarding.permission.writeBody")}
              />
            </div>

            <p className="text-xs text-text-ink/50 text-center mt-5 px-7">{t("onboarding.permission.notice")}</p>

            <div className="flex gap-3 px-7 py-6 mt-2">
              <button
                type="button"
                onClick={() => void choosePermission("none")}
                className="flex-1 py-3 text-sm text-text-ink/65 bg-canvas-oat border border-border-stone/40 rounded-btn hover:bg-canvas-oat/80 transition-colors cursor-pointer"
              >
                {t("onboarding.permission.none")}
              </button>
              <button
                type="button"
                onClick={() => void choosePermission("scan_only")}
                className="flex-1 py-3 text-sm text-text-ink/70 bg-background-paper border border-border-stone rounded-btn hover:bg-canvas-oat/40 transition-colors cursor-pointer"
              >
                {t("onboarding.permission.scan")}
              </button>
              <button
                type="button"
                onClick={() => void choosePermission("scan_and_write_skill")}
                className="flex-1 py-3 text-sm text-white bg-action-sky rounded-btn hover:bg-action-sky-hover transition-colors font-semibold cursor-pointer shadow-md"
              >
                {t("onboarding.permission.all")}
              </button>
            </div>
          </div>
        </div>
      )}

    </main>
  );
}

/** Handles to readable first report error. */
function toReadableFirstReportError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

/** Handles permission card. */
function PermissionCard(props: { icon: LucideIcon; title: string; description: string }) {
  const Icon = props.icon;
  return (
    <div className="flex gap-3.5 p-4 bg-canvas-oat/50 rounded-card border border-border-stone/30">
      <Icon size={18} strokeWidth={2} className="shrink-0 mt-0.5 text-action-sky" aria-hidden="true" />
      <div className="min-w-0 flex flex-col gap-1.5">
        <div className="text-sm text-text-ink">{props.title}</div>
        <div className="text-xs text-text-ink/50 leading-relaxed">{props.description}</div>
      </div>
    </div>
  );
}
