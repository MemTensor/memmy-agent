/** Onboarding page module. */
import { useCallback, useEffect, useRef, useState } from "react";
import { PenLine, Search, type LucideIcon } from "lucide-react";
import type { AgentSourceMemoryPluginConflict, ScanPermission } from "@memmy/local-api-contracts";
import { useApiClients } from "../app/providers.js";
import {
  productTourIncludesLogs,
  productTourStartMemorySubPage,
  productTourStartRoute
} from "../app/product-tour.js";
import {
  buildOnboardingCompletionPatch,
  clearProductTourStep,
  readGuidanceCompleted,
  resolvePostOnboardingRoute,
  writeDeferredGuidanceStep,
  writePreferredMode,
  type AppRoutePath,
  type PreferredMode
} from "../app/routes.js";
import { useAnalytics } from "../analytics/use-analytics.js";
import {
  buildOnboardingActivationEvent,
  buildOnboardingStepCompletedEvent
} from "../analytics/onboarding-analytics.js";
import { resolveAnalyticsPageLocation } from "../analytics/page-location.js";
import { Memmy } from "../components/mascot/memmy.js";
import { useTranslation } from "../i18n/use-translation.js";
import { agentActions, appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import { startAgentSourceScan } from "./memory-source-scan.js";
import { formatAgentSourceScanRequestError } from "./agent-source-scan-error.js";
import { FirstEncounterReport } from "./first-encounter-report.js";
import {
  firstEncounterFollowUpMode,
  hasDetectedRelayAgents,
  type RelayAgentOption
} from "./first-encounter-relay-challenge.js";
import {
  streamFirstEncounterReport,
  type DiscoveredAgent,
  type FirstEncounterReportPayload
} from "./first-encounter-protocol.js";
import {
  armFirstEncounterRelayChat,
  writeFirstEncounterRelayChat,
  writeFirstEncounterRelayPrompt,
  writeFirstEncounterRelayReadyChat,
  writePendingFirstEncounterTaskLaunch
} from "./first-encounter-task-launch.js";
import { HomePage } from "./home-page.js";
import { MemoryPluginConflictModal } from "./memory-plugin-conflict-modal.js";
import { scheduleMemoryPanelCachePrefetch } from "./memory/memory-panel-prefetch.js";
import { writeMemorySubPage } from "./memory-page.js";
import { OnboardingScanAnimation } from "./onboarding-scan-animation.js";

type FirstScanStep = "checking_plugins" | "plugin_conflict" | "scanning" | "preparing_report" | "report";

const FIRST_SCAN_ANIMATION_MIN_MS = 2_000;
const FIRST_ENCOUNTER_MEMORY_VERIFY_TIMEOUT_MS = 60_000;
const FIRST_ENCOUNTER_MEMORY_VERIFY_INTERVAL_MS = 2_000;

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
  const hasTrackedFirstReportView = useRef(false);
  const firstScanStepRef = useRef<FirstScanStep | null>(null);
  const firstScanVisualComplete = useRef(false);
  const firstReportSeedPromiseRef = useRef<Promise<{ chatId: string; sessionKey: string } | null> | null>(null);
  const firstReportSeededChatRef = useRef<{ chatId: string; sessionKey: string } | null>(null);
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
    if (activeFirstScanStep !== "report" || !firstReportPayload || hasTrackedFirstReportView.current) {
      return;
    }
    hasTrackedFirstReportView.current = true;
    track(buildOnboardingStepCompletedEvent({
      step: "first_report",
      choice: "viewed",
      scanPermission: onboarding?.scanPermission,
      emptyHistory: firstReportPayload.emptyHistory
    }));
  }, [activeFirstScanStep, firstReportPayload, onboarding?.scanPermission, track]);

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
    track(buildOnboardingStepCompletedEvent({
      step: "scan_permission",
      choice: permission,
      scanPermission: permission
    }));
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
    hasTrackedFirstReportView.current = false;
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
          replace
            ? clients.agentSources.installPlugin(conflict.sourceId, { installType: "conflict_replace" })
            : clients.agentSources.installSkill(conflict.sourceId)
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
        mode: "initial_subset",
        queuedMessage: t("memory.scanQueued"),
        formatError: (error) => formatAgentSourceScanRequestError(error, undefined, t),
        scheduleFallback: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
        analyticsContext: {
          pagePath: "/onboarding",
          subPage: "onboarding"
        }
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
    firstReportSeedPromiseRef.current = null;
    firstReportSeededChatRef.current = null;
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
        onChunk: (_delta, payload) => {
          setFirstReportIsStreaming(true);
          setFirstReportShouldSimulate(false);
          setFirstReportPayload(payload);
        },
        onDone: (payload, meta) => {
          setFirstReportIsStreaming(false);
          setFirstReportShouldSimulate(!meta.streamed);
          setFirstReportPayload(payload);
          writeFirstEncounterRelayPrompt(
            typeof window === "undefined" ? undefined : window.sessionStorage,
            payload.relayPrompt
          );
          setFirstScanAgents(payload.agents.length > 0 ? payload.agents : seedAgents);
          firstScanVisualComplete.current = true;
          // Persist into a real chat as soon as the report exists, so later
          // navigation / WS timing cannot drop the generated content.
          void seedFirstEncounterReportChat(payload);
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

  const openFirstEncounterRelayAgent = useCallback(async (sourceId: string, prompt: string): Promise<boolean> => {
    try {
      const result = await window.memmy?.openAgentTool?.(sourceId, prompt);
      return result?.opened === true;
    } catch {
      return false;
    }
  }, []);

  const verifyFirstEncounterRelayMemory = useCallback(async (sourceId: string, startedAt: string): Promise<boolean> => {
    const client = clients?.memoryRuntime;
    if (!client) {
      return false;
    }
    const startedAtMs = Date.parse(startedAt);
    const deadline = Date.now() + FIRST_ENCOUNTER_MEMORY_VERIFY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const output = await client.listMemoryLogs({
          tools: ["memory_search"],
          sourceAgent: sourceId,
          limit: 20,
          offset: 0
        });
        if (output.logs.some((log) => log.success && Date.parse(log.calledAt) >= startedAtMs)) {
          return true;
        }
      } catch {
        // Memory service may still be starting during onboarding.
      }
      await new Promise((resolve) => window.setTimeout(resolve, FIRST_ENCOUNTER_MEMORY_VERIFY_INTERVAL_MS));
    }
    return false;
  }, [clients?.memoryRuntime]);

  const trackFirstEncounterRelayLifecycle = useCallback((
    event: "relay_clicked" | "memory_verified",
    sourceId: string,
    action: string
  ) => {
    track(buildOnboardingActivationEvent({
      name: event === "memory_verified"
        ? "onboarding_external_memory_verified"
        : "onboarding_relay_clicked",
      pagePath: "/onboarding",
      scanPermission: onboarding?.scanPermission,
      action,
      sourceId: sourceId || undefined
    }));
  }, [onboarding?.scanPermission, track]);

  function continueFromReport() {
    void completeReportFlow(true);
  }

  function seedFirstEncounterReportChat(payload: FirstEncounterReportPayload): Promise<{ chatId: string; sessionKey: string } | null> {
    const assistantContent = payload.body.trim();
    const prompt = payload.reportPrompt;
    const storage = typeof window === "undefined" ? undefined : window.sessionStorage;
    if (!assistantContent) {
      return Promise.resolve(null);
    }

    // Keep the report body queued even before seed finishes, so Home can retry.
    writePendingFirstEncounterTaskLaunch(storage, prompt, { assistantContent });

    const memmyAgent = clients?.memmyAgent;
    if (!memmyAgent) {
      return Promise.resolve(null);
    }

    const seedPromise = memmyAgent.seedWebuiChat({
      userText: prompt,
      assistantText: assistantContent,
      title: t("onboarding.report.title")
    }).then((seeded) => {
      const next = { chatId: seeded.chat_id, sessionKey: seeded.session_key };
      firstReportSeededChatRef.current = next;
      writePendingFirstEncounterTaskLaunch(storage, prompt, {
        assistantContent,
        chatId: next.chatId,
        sessionKey: next.sessionKey
      });
      return next;
    }).catch((error) => {
      console.warn("seed first encounter report chat on generate failed", error);
      return null;
    });
    firstReportSeedPromiseRef.current = seedPromise;
    return seedPromise;
  }

  async function completeReportFlow(createConversation: boolean) {
    const completionPatch = buildOnboardingCompletionPatch(new Date().toISOString());
    const storage = typeof window === "undefined" ? undefined : window.sessionStorage;
    const localStorageRef = typeof window === "undefined" ? undefined : window.localStorage;
    const guidanceStep = isAccountMode && state.bootstrap?.onboarding.improvementProgram === "unset"
      ? "improvement"
      : "product_tour";
    const nextRoute: AppRoutePath = guidanceStep === "product_tour"
      ? "/memory"
      : resolvePostOnboardingRoute("full");

    writePreferredMode(localStorageRef, "full");
    if (createConversation) {
      const prompt = firstReportPayload?.reportPrompt ?? t("onboarding.report.userPrompt");
      const assistantContent = firstReportPayload?.body?.trim() || undefined;
      // Prefer the chat seeded at report-done; wait if still in flight, then retry once.
      const seeded = firstReportSeededChatRef.current
        ?? (await firstReportSeedPromiseRef.current)
        ?? (firstReportPayload ? await seedFirstEncounterReportChat(firstReportPayload) : null);
      writePendingFirstEncounterTaskLaunch(storage, prompt, {
        ...(assistantContent ? { assistantContent } : {}),
        ...(seeded ? { chatId: seeded.chatId, sessionKey: seeded.sessionKey } : {})
      });
      if (seeded) {
        writeFirstEncounterRelayChat(storage, seeded.chatId);
        writeFirstEncounterRelayReadyChat(storage, seeded.chatId);
      } else {
        armFirstEncounterRelayChat(storage);
      }
      dispatch(agentActions.newChatRequested());
    }
    dispatch(appActions.preferredModeUpdated("full"));
    dispatch(appActions.onboardingUpdated(completionPatch));
    clearProductTourStep(storage);
    if (guidanceStep === "product_tour") {
      writeMemorySubPage(storage, "logs");
    }
    writeDeferredGuidanceStep(storage, guidanceStep);
    dispatch(appActions.navigate(nextRoute));
    // first_entry = first workspace entry; onboarding_completed fires later after nickname.
    track({ name: "first_entry", params: { page_location: resolveAnalyticsPageLocation(nextRoute) }, consentTier: "basic" });
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
      const storage = typeof window === "undefined" ? undefined : window.sessionStorage;
      const guidanceStep = isAccountMode && state.bootstrap?.onboarding.improvementProgram === "unset"
        ? "improvement"
        : "product_tour";
      // Deny-scan skips the logs tour step and opens on cross-agent sources (4/4).
      const includeLogs = productTourIncludesLogs(
        persistedPatch?.scanPermission ?? state.bootstrap?.onboarding.scanPermission
      );
      const nextRoute: AppRoutePath = guidanceStep === "product_tour"
        ? productTourStartRoute(includeLogs)
        : targetRoute;
      if (guidanceStep === "product_tour") {
        clearProductTourStep(storage);
        writeMemorySubPage(storage, productTourStartMemorySubPage(includeLogs));
      }
      writeDeferredGuidanceStep(storage, guidanceStep);
      dispatch(appActions.navigate(nextRoute));
      // first_entry = first workspace entry; onboarding_completed fires later after nickname.
      track({ name: "first_entry", params: { page_location: resolveAnalyticsPageLocation(nextRoute) }, consentTier: "basic" });
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

    const relayAgents = resolveReportRelayAgents(state.agentSources.items, firstReportPayload.agents);

    return (
      <main className="min-h-screen bg-canvas-oat">
        <FirstEncounterReport
          payload={firstReportPayload}
          isStreaming={firstReportIsStreaming}
          simulateStreaming={firstReportShouldSimulate}
          followUpMode={firstEncounterFollowUpMode(state.bootstrap?.onboarding.scanPermission ?? "unset")}
          agents={relayAgents}
          onOpenAgent={openFirstEncounterRelayAgent}
          onVerifyMemory={verifyFirstEncounterRelayMemory}
          onRelayLifecycle={trackFirstEncounterRelayLifecycle}
          onContinue={continueFromReport}
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

/** Prefer live scan sources; fall back to report agents so the relay card still renders in mock. */
function resolveReportRelayAgents(
  sources: Array<{
    sourceId: string;
    displayName?: string;
    available: boolean;
    builtin: boolean;
    messageCount: number;
    status: RelayAgentOption["status"];
  }>,
  reportAgents: DiscoveredAgent[]
): RelayAgentOption[] {
  const fromSources: RelayAgentOption[] = sources.map((source) => ({
    sourceId: source.sourceId,
    displayName: source.displayName,
    available: source.available,
    builtin: source.builtin,
    messageCount: source.messageCount,
    status: source.status
  }));
  if (hasDetectedRelayAgents(fromSources)) {
    return fromSources;
  }

  return reportAgents.map((agent) => ({
    sourceId: agent.sourceId,
    displayName: agent.name,
    available: true,
    builtin: true,
    messageCount: Math.max(1, agent.conversations ?? 1),
    status: "not_connected" as const
  }));
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
