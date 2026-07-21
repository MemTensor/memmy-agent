/** App module. */
import { SseEventSchema, type AccountSessionView, type SseEvent } from "@memmy/local-api-contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { gtagEvent } from "./analytics/gtag-init.js";
import { AgentRuntimeBridge } from "./app/agent-runtime-bridge.js";
import { AppProviders, useApiClients } from "./app/providers.js";
import { AppRouter } from "./app/router.js";
import { UpdateCoordinatorProvider } from "./app/update-coordinator.js";
import {
  FOCUSED_AGENT_CHAT_STORAGE_KEY,
  readGuidanceCompleted,
  readLaunchModeOverride,
  readPetIntentOverride,
  readLaunchRouteOverride,
  readCurrentRoute,
  reconcileInitialOnboarding,
  resolveInitialView,
  resolveMainWindowRouteTarget,
  resolvePreferredLaunchMode,
  resolveLaunchInitialView,
  shouldExitPetLaunchForRoute,
  type MainWindowRouteTarget
} from "./app/routes.js";
import { createAppClients } from "./api/client-types.js";
import { createEventsConnection } from "./api/events.js";
import { MemmyAgentRequestError, type MemmyAgentClient } from "./api/memmy-agent-client.js";
import { getRuntimeConfig } from "./api/runtime-config.js";
import { clearMemoryPanelCache } from "./pages/memory/memory-panel-cache.js";
import { readLocalNickname } from "./app/nickname.js";
import {
  formatAgentSourceScanRequestError,
  formatScanCompletedError
} from "./pages/agent-source-scan-error.js";
import { useTranslation } from "./i18n/use-translation.js";
import {
  AGENT_SOURCE_SCAN_COMPLETION_FEEDBACK_MS,
  agentActions,
  appActions,
  type AppAction
} from "./state/app-actions.js";
import { useAppState } from "./state/app-state.js";

/** Handles app. */
export function App() {
  return (
    <AppProviders>
      <RuntimeApp />
    </AppProviders>
  );
}

/** Runs runtime app. */
function RuntimeApp() {
  const { dispatch } = useAppState();
  const { clients, setClients } = useApiClients();
  const { t } = useTranslation();
  const translationRef = useRef(t);
  const [bootKey, setBootKey] = useState(0);
  translationRef.current = t;

  const retry = useCallback(() => setBootKey((value) => value + 1), []);

  useEffect(() => {
    if (typeof window === "undefined" || !window.memmy?.onRouteTargetRequest) {
      return undefined;
    }

    return window.memmy.onRouteTargetRequest((target) => {
      applyMainWindowRouteTarget(target, dispatch, clients?.memmyAgent ?? null);
    });
  }, [clients?.memmyAgent, dispatch]);

  useEffect(() => {
    let events: EventSource | undefined;
    let isActive = true;
    const scanCompletionTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

    function scheduleScanCompletionExpiry(jobId: string) {
      const existingTimeout = scanCompletionTimeouts.get(jobId);
      if (existingTimeout) clearTimeout(existingTimeout);
      scanCompletionTimeouts.set(jobId, setTimeout(() => {
        scanCompletionTimeouts.delete(jobId);
        dispatch(appActions.agentSourceScanCompletionExpired(jobId));
      }, AGENT_SOURCE_SCAN_COMPLETION_FEEDBACK_MS));
    }

    async function reconcileAgentSourceScanStatus(agentSourceClient: ReturnType<typeof createAppClients>["agentSources"]) {
      try {
        const status = await agentSourceClient.getScanStatus();
        if (!isActive) return;
        if (status.progress) {
          dispatch(appActions.agentSourceScanProgressReceived(status.progress));
          return;
        }
        if (status.completion) {
          dispatch(appActions.agentSourceScanCompleted(status.completion));
          scheduleScanCompletionExpiry(status.completion.jobId);
          return;
        }
        dispatch(appActions.agentSourceScanCompleted());
      } catch {
        // The next heartbeat or reconnect will reconcile again.
      }
    }

    /** Handles boot. */
    async function boot() {
      dispatch(appActions.startupLoading());

      try {
        const runtimeConfig = await getRuntimeConfig();
        const clients = createAppClients({ runtimeConfig });
        const bootstrap = await clients.bootstrap.getBootstrap();
        const currentRoute = readCurrentRoute(typeof window === "undefined" ? undefined : window.sessionStorage);
        const guidanceCompleted = readGuidanceCompleted(typeof window === "undefined" ? undefined : window.localStorage);
        const launchModeOverride = readLaunchModeOverride(typeof window === "undefined" ? undefined : window.location.search);
        const petIntent = readPetIntentOverride(typeof window === "undefined" ? undefined : window.location.search);
        const launchRouteOverride = readLaunchRouteOverride(typeof window === "undefined" ? undefined : window.location.search);
        const [sources, accountSession, modelConfig, scanStatus] = await Promise.all([
          clients.agentSources.listSources(),
          readAccountSession(clients.account),
          clients.config.getModelConfig(),
          clients.agentSources.getScanStatus()
        ]);
        const effectiveBootstrap = reconcileInitialOnboarding({ bootstrap, accountSession });
        const persistedPreferredMode = resolvePreferredLaunchMode({
          defaultLaunchMode: effectiveBootstrap.app.defaultLaunchMode,
          lastLaunchMode: effectiveBootstrap.app.lastLaunchMode
        });
        const defaultInitialPath = resolveInitialView({
          bootstrap: effectiveBootstrap,
          preferredMode: launchModeOverride ?? persistedPreferredMode,
          accountSession,
          guidanceCompleted
        });
        const initialPath = resolveLaunchInitialView({
          defaultPath: defaultInitialPath,
          currentRoute,
          launchRouteOverride,
          launchModeOverride,
          petIntent
        });

        if (!isActive) {
          return;
        }

        if (shouldExitPetLaunchForRoute({ launchModeOverride, petIntent, initialPath })) {
          const switched = await exitPetWindowForFullFlow();
          if (switched) {
            return;
          }
        }

        setClients(clients);
        dispatch(appActions.bootstrapLoaded(effectiveBootstrap, initialPath));
        if (bootstrap.tokenUsage.totalTokens > 0) {
          const u = bootstrap.tokenUsage;
          gtagEvent("token_usage_snapshot", {
            plan_name: u.planName,
            total_tokens: u.totalTokens,
            used_tokens: u.usedTokens,
            remaining_tokens: u.remainingTokens,
            usage_pct: Math.round((u.usedTokens / u.totalTokens) * 100)
          });
        }
        dispatch(appActions.agentSourcesLoaded(sources));
        if (scanStatus.progress) {
          dispatch(appActions.agentSourceScanProgressReceived(scanStatus.progress));
        } else if (scanStatus.completion) {
          dispatch(appActions.agentSourceScanCompleted(scanStatus.completion));
          scheduleScanCompletionExpiry(scanStatus.completion.jobId);
        }
        if (accountSession.authenticated) {
          dispatch(appActions.accountUpdated({
            email: accountSession.profile.email ?? "",
            phoneNumber: accountSession.profile.phoneNumber,
            nickname: accountSession.profile.nickname,
            registeredAt: accountSession.profile.registeredAt
          }));
        } else if (effectiveBootstrap.app.userMode === "byok") {
          const localNickname = readLocalNickname(typeof window === "undefined" ? undefined : window.localStorage);
          if (localNickname) {
            dispatch(appActions.accountUpdated({ nickname: localNickname }));
          }
        }
        dispatch(appActions.modelConfigUpdated(modelConfig));
        dispatch(appActions.preferredModeUpdated(persistedPreferredMode));
        dispatch(appActions.eventStatusChanged("connecting"));

        events = createEventsConnection(runtimeConfig);
        events.addEventListener("app.connected", () => {
          dispatch(appActions.eventStatusChanged("connected"));
          void reconcileAgentSourceScanStatus(clients.agentSources);
        });
        events.addEventListener("app.heartbeat", () => dispatch(appActions.eventStatusChanged("heartbeat")));
        events.addEventListener("agent_source.scan_progress", (event) => {
          const parsed = parseSseEvent(event);
          if (parsed?.type === "agent_source.scan_progress") {
            dispatch(appActions.agentSourceScanProgressReceived(parsed.payload));
          }
        });
        events.addEventListener("agent_source.scan_completed", (event) => {
          const parsed = parseSseEvent(event);
          if (parsed?.type !== "agent_source.scan_completed") {
            return;
          }
          const { jobId, sourceId, results: scanResults } = parsed.payload;
          const scanSucceeded = scanResults.every((result) => result.errors.length === 0);
          clearMemoryPanelCache();
          dispatch(appActions.agentSourceScanCompleted({ jobId, sourceId, succeeded: scanSucceeded }));
          scheduleScanCompletionExpiry(jobId);
          void clients.agentSources
            .listSources()
            .then((nextSources) => {
              dispatch(appActions.agentSourcesLoaded(nextSources));
              const scanError = scanResults
                ? formatScanCompletedError(scanResults, nextSources, translationRef.current)
                : null;
              if (scanError) {
                dispatch(appActions.agentSourcesFailed(scanError));
              }
            })
            .catch((error) =>
              dispatch(appActions.agentSourcesFailed(
                formatAgentSourceScanRequestError(error, undefined, translationRef.current)
              ))
            );
        });
        events.onerror = () => dispatch(appActions.eventStatusChanged("reconnecting"));
      } catch (error) {
        if (!isActive) {
          return;
        }

        dispatch(appActions.startupFailed(error instanceof Error ? error.message : String(error)));
      }
    }

    void boot();

    return () => {
      isActive = false;
      events?.close();
      for (const timeout of scanCompletionTimeouts.values()) {
        clearTimeout(timeout);
      }
    };
  }, [bootKey, dispatch, setClients]);

  return (
    <UpdateCoordinatorProvider>
      <AgentRuntimeBridge>
        <AppRouter onRetry={retry} />
      </AgentRuntimeBridge>
    </UpdateCoordinatorProvider>
  );
}

export function applyMainWindowRouteTarget(
  rawTarget: MainWindowRouteTarget,
  dispatch: (action: AppAction) => void,
  agentClient: Pick<MemmyAgentClient, "chatIdToSessionKey" | "readWebuiThread" | "listSessions" | "readSidebarState"> | null = null
): void {
  const target = resolveMainWindowRouteTarget(rawTarget);
  if (target.route === "/main") {
    if (target.agentChatId && agentClient) {
      rememberFocusedAgentChat(null);
      focusMainWindowAgentChat(target.agentChatId, agentClient, dispatch);
    } else {
      rememberFocusedAgentChat(target.agentChatId);
    }
  }
  replaceRouteTargetHash(target.hash);

  if (target.route) {
    dispatch(appActions.navigate(target.route));
  }
}

let mainWindowRouteAgentRequestCounter = 0;

function focusMainWindowAgentChat(
  chatId: string,
  client: Pick<MemmyAgentClient, "chatIdToSessionKey" | "readWebuiThread" | "listSessions" | "readSidebarState">,
  dispatch: (action: AppAction) => void
): void {
  mainWindowRouteAgentRequestCounter += 1;
  const sessionKey = client.chatIdToSessionKey(chatId);
  const historyRequestId = `main-route-${chatId}-${mainWindowRouteAgentRequestCounter}`;
  const sessionsRequestId = `main-route-sessions-${mainWindowRouteAgentRequestCounter}`;
  dispatch(agentActions.historyLoading(sessionKey, chatId, historyRequestId));
  dispatch(agentActions.sessionsLoading(sessionsRequestId));

  void client
    .readWebuiThread(sessionKey)
    .then((thread) => {
      dispatch(agentActions.historyLoaded(thread, historyRequestId));
    })
    .catch((error: unknown) => {
      if (error instanceof MemmyAgentRequestError && error.status === 404) {
        dispatch(agentActions.historyLoaded({ schemaVersion: 1, sessionKey, messages: [] }, historyRequestId));
        return;
      }

      console.warn("focus main window agent chat history failed", error);
      dispatch(agentActions.historyOpenMissing(sessionKey, chatId, historyRequestId));
    });

  void Promise.all([
    client.listSessions(),
    client.readSidebarState()
  ])
    .then(([sessions, sidebarState]) => {
      dispatch(agentActions.sidebarStateLoaded(sidebarState));
      dispatch(agentActions.sessionsLoaded(sessions, sessionsRequestId));
    })
    .catch((error) => {
      console.warn("focus main window agent chat sessions failed", error);
      dispatch(agentActions.sessionsLoadFailed(sessionsRequestId));
    });
}

function rememberFocusedAgentChat(agentChatId: string | null): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (agentChatId) {
      window.sessionStorage.setItem(FOCUSED_AGENT_CHAT_STORAGE_KEY, agentChatId);
    } else {
      window.sessionStorage.removeItem(FOCUSED_AGENT_CHAT_STORAGE_KEY);
    }
  } catch {
    // Losing a focus hint is non-fatal; route navigation should continue.
  }
}

function replaceRouteTargetHash(hash: string | null): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const url = new URL(window.location.href);
    url.hash = hash ?? "";
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // URL cleanup should not block state-route navigation.
  }
}

/**
 * Exits the desktop-pet transparent window when login or first-run onboarding is required.
 *
 * @returns true means the main process has been handed off to restore the full window, and the current pet renderer stops rendering the target page.
 */
async function exitPetWindowForFullFlow(): Promise<boolean> {
  if (typeof window === "undefined" || !window.memmy?.setPetWindow) {
    return false;
  }

  try {
    await window.memmy.setPetWindow(false);
    return true;
  } catch (error) {
    console.warn("exit pet window for full flow failed", error);
    return false;
  }
}

/**
 * Reads the persisted account session, treating failures as not-logged-in.
 *
 * @param account The account API client.
 * @returns The current account session; returns an unauthenticated view when the local API is temporarily unavailable.
 */
async function readAccountSession(account: { getSession(): Promise<AccountSessionView> }): Promise<AccountSessionView> {
  try {
    return await account.getSession();
  } catch {
    return { authenticated: false };
  }
}

/**
 * Parses the backend SSE event payload.
 *
 * @param event The EventSource callback event.
 * @returns An event that passes shared-contract validation; returns null for non-JSON or structural mismatches.
 */
function parseSseEvent(event: Event): SseEvent | null {
  if (!("data" in event) || typeof event.data !== "string") {
    return null;
  }

  try {
    return SseEventSchema.parse(JSON.parse(event.data));
  } catch {
    return null;
  }
}
