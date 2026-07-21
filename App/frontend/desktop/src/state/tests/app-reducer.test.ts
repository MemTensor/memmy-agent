/** App reducer tests. */
import { AppBootstrapResponseSchema } from "@memmy/local-api-contracts";
import { describe, expect, it } from "vitest";
import { agentActions, appActions } from "../app-actions.js";
import { agentChatScopeKey } from "../agent-composer-state.js";
import { appReducer, createInitialAppState } from "../app-reducer.js";

/** Definition for bootstrap. */
const bootstrap = AppBootstrapResponseSchema.parse({
  app: {
    userMode: "unset",
    language: "system",
    theme: "system",
    autoUpdateEnabled: true
  },
  onboarding: {
    completed: false,
    currentStep: "scan_permission_required",
    hasAcceptedTerms: false,
    acceptedTermsVersion: null,
    scanPermission: "unset",
    improvementProgram: "unset",
    completedAt: null
  },
  privacy: {
    telemetryOptIn: false,
    crashReportOptIn: false,
    allowMemoryImprovementUpload: false,
    localOnlyMode: false
  },
  tokenUsage: {
    planName: "体验 Token",
    totalTokens: 30000000,
    usedTokens: 1500000,
    remainingTokens: 28500000,
    expiresAt: null,
    lastSyncedAt: null
  },
  health: {
    localApi: "ok",
    memory: "mock",
    cloud: "mock"
  },
  promotions: {
    loginBanner: true,
    improvementGift: true,
    applyMore: true
  }
});

describe("app reducer", () => {
  it("stores bootstrap state and marks startup ready", () => {
    const state = appReducer(createInitialAppState(), appActions.bootstrapLoaded(bootstrap, "/welcome"));

    expect(state.startup.status).toBe("ready");
    expect(state.bootstrap?.tokenUsage.remainingTokens).toBe(28500000);
    expect(state.navigation.currentPath).toBe("/welcome");
    expect(state.agent.chatViewVisible).toBe(false);
  });

  it("sets chat view visibility from the bootstrap route", () => {
    const mainState = appReducer(createInitialAppState(), appActions.bootstrapLoaded(bootstrap, "/main"));
    const toolsState = appReducer(createInitialAppState(), appActions.bootstrapLoaded(bootstrap, "/tools"));

    expect(mainState.agent.chatViewVisible).toBe(true);
    expect(toolsState.agent.chatViewVisible).toBe(false);
  });

  it("updates navigation without dropping loaded bootstrap data", () => {
    const readyState = appReducer(createInitialAppState(), appActions.bootstrapLoaded(bootstrap, "/welcome"));
    const nextState = appReducer(readyState, appActions.navigate("/tools"));

    expect(nextState.bootstrap).toBe(readyState.bootstrap);
    expect(nextState.navigation.currentPath).toBe("/tools");
    expect(nextState.agent.chatViewVisible).toBe(false);
  });

  it("updates chat view visibility on route changes", () => {
    let state = appReducer(createInitialAppState(), appActions.bootstrapLoaded(bootstrap, "/main"));
    expect(state.agent.chatViewVisible).toBe(true);

    for (const path of ["/tools", "/settings", "/memory", "/memory-sources"] as const) {
      state = appReducer(state, appActions.navigate(path));
      expect(state.navigation.currentPath).toBe(path);
      expect(state.agent.chatViewVisible).toBe(false);
    }

    state = appReducer(state, appActions.navigate("/main"));
    expect(state.agent.chatViewVisible).toBe(true);
  });

  it("clears the current chat completion dot when navigation returns to the visible chat view", () => {
    let state = appReducer(createInitialAppState(), appActions.bootstrapLoaded(bootstrap, "/tools"));
    state = appReducer(state, agentActions.newChatCreated("chat-1"));
    state = appReducer(state, agentActions.wsEventReceived({ event: "goal_status", chat_id: "chat-1", status: "running", started_at: 1781240000000 }));
    state = appReducer(state, agentActions.wsEventReceived({ event: "turn_end", chat_id: "chat-1" }));

    expect(state.agent.chatViewVisible).toBe(false);
    expect(state.agent.completedUnseenByChatId["chat-1"]).toBeTypeOf("number");

    const visibleState = appReducer(state, appActions.navigate("/main"));
    expect(visibleState.agent.chatViewVisible).toBe(true);
    expect(visibleState.agent.completedUnseenByChatId["chat-1"]).toBeUndefined();
  });

  it("merges settings and onboarding updates conservatively", () => {
    const readyState = appReducer(createInitialAppState(), appActions.bootstrapLoaded(bootstrap, "/welcome"));
    const withSettings = appReducer(readyState, appActions.settingsUpdated({ language: "zh-CN", theme: "dark" }));
    const withOnboarding = appReducer(
      withSettings,
      appActions.onboardingUpdated({ scanPermission: "scan_only", improvementProgram: "declined" })
    );

    expect(withOnboarding.bootstrap?.app.language).toBe("zh-CN");
    expect(withOnboarding.bootstrap?.app.theme).toBe("dark");
    expect(withOnboarding.bootstrap?.onboarding.scanPermission).toBe("scan_only");
    expect(withOnboarding.bootstrap?.onboarding.improvementProgram).toBe("declined");
  });

  it("merges token usage updates returned by real account APIs", () => {
    const readyState = appReducer(createInitialAppState(), appActions.bootstrapLoaded(bootstrap, "/welcome"));
    const nextState = appReducer(
      readyState,
      appActions.tokenUsageUpdated({
        planName: "体验 Token",
        totalTokens: 35000000,
        usedTokens: 1000000,
        remainingTokens: 34000000,
        expiresAt: null,
        lastSyncedAt: "2026-06-05T10:00:00.000Z"
      })
    );

    expect(nextState.bootstrap?.tokenUsage).toMatchObject({
      totalTokens: 35000000,
      remainingTokens: 34000000,
      lastSyncedAt: "2026-06-05T10:00:00.000Z"
    });
  });

  it("stores real scan progress from SSE events until the completed event arrives", () => {
    const loadingState = appReducer(createInitialAppState(), appActions.agentSourceScanStarted("cursor"));
    expect(loadingState.agentSources.activeScanSourceId).toBe("cursor");
    const progressState = appReducer(
      loadingState,
      appActions.agentSourceScanProgressReceived({
        jobId: "job-1",
        sourceId: "cursor",
        phase: "add",
        current: 2,
        total: 5,
        message: "Adding memories"
      })
    );

    expect(progressState.agentSources.isLoading).toBe(false);
    expect(progressState.agentSources.isScanning).toBe(true);
    expect(progressState.agentSources.scanProgress).toEqual({
      jobId: "job-1",
      sourceId: "cursor",
      phase: "add",
      current: 2,
      total: 5,
      message: "Adding memories"
    });

    const completedState = appReducer(progressState, appActions.agentSourceScanCompleted({
      jobId: "job-1",
      sourceId: "cursor",
      succeeded: true
    }));
    expect(completedState.agentSources.isScanning).toBe(false);
    expect(completedState.agentSources.activeScanSourceId).toBeNull();
    expect(completedState.agentSources.scanProgress).toBeNull();
    expect(completedState.agentSources.recentScanCompletions).toEqual([{ jobId: "job-1", sourceId: "cursor" }]);

    const loadedState = appReducer(completedState, appActions.agentSourcesLoaded([]));
    expect(loadedState.agentSources.items).toEqual([]);
    expect(loadedState.agentSources.recentScanCompletions).toEqual([{ jobId: "job-1", sourceId: "cursor" }]);

    const expiredState = appReducer(loadedState, appActions.agentSourceScanCompletionExpired("job-1"));
    expect(expiredState.agentSources.recentScanCompletions).toEqual([]);

    const failedButFinishedState = appReducer(expiredState, appActions.agentSourceScanCompleted({
      jobId: "job-2",
      sourceId: "hermes",
      succeeded: false
    }));
    expect(failedButFinishedState.agentSources.recentScanCompletions).toEqual([
      { jobId: "job-2", sourceId: "hermes" }
    ]);

    const staleProgressState = appReducer(failedButFinishedState, appActions.agentSourceScanProgressReceived({
      jobId: "job-1",
      sourceId: "cursor",
      phase: "scan",
      current: 0,
      total: 0
    }));
    expect(staleProgressState).toBe(failedButFinishedState);
  });

  it("ignores stale scan progress for a stopped job", () => {
    const progressState = appReducer(
      createInitialAppState(),
      appActions.agentSourceScanProgressReceived({
        jobId: "job-1",
        sourceId: "cursor",
        phase: "stopped",
        current: 2,
        total: 5
      })
    );
    const staleState = appReducer(
      progressState,
      appActions.agentSourceScanProgressReceived({
        jobId: "job-1",
        sourceId: "cursor",
        phase: "add",
        current: 4,
        total: 5
      })
    );

    expect(staleState.agentSources.isScanning).toBe(false);
    expect(staleState.agentSources.scanProgress).toEqual({
      jobId: "job-1",
      sourceId: "cursor",
      phase: "stopped",
      current: 2,
      total: 5
    });
  });

  it("routes memmy-agent actions through the global reducer", () => {
    const sessionsState = appReducer(
      createInitialAppState(),
      agentActions.sessionsLoaded([
        {
          key: "websocket:chat-1",
          title: "创建 AI 电商助手",
          preview: "整理 PRD"
        }
      ])
    );
    const newChatState = appReducer(sessionsState, agentActions.newChatRequested());

    expect(sessionsState.agent.tasks).toHaveLength(1);
    expect(sessionsState.agent.tasks[0]?.chatId).toBe("chat-1");
    expect(newChatState.agent.currentChatId).toBeNull();
    expect(newChatState.agent.newChatRequestId).toBe(1);
  });

  it("keeps the first report task draft visible after local onboarding completion", () => {
    const readyState = appReducer(createInitialAppState(), appActions.bootstrapLoaded(bootstrap, "/onboarding"));
    const nextRequestId = readyState.agent.newChatRequestId + 1;
    const draftScope = agentChatScopeKey(null, nextRequestId);
    const withDraft = appReducer(
      appReducer(readyState, agentActions.newChatRequested()),
      agentActions.composerDraftUpdated(draftScope, "帮我整理最近的项目上下文")
    );
    const completed = appReducer(
      appReducer(
        withDraft,
        appActions.onboardingUpdated({
          completed: true,
          currentStep: "completed",
          completedAt: "2026-06-25T00:00:00.000Z"
        })
      ),
      appActions.navigate("/main")
    );

    expect(completed.navigation.currentPath).toBe("/main");
    expect(completed.bootstrap?.onboarding.completed).toBe(true);
    expect(completed.agent.blankDraftActive).toBe(true);
    expect(completed.agent.composerDraftsByScope[draftScope]).toBe("帮我整理最近的项目上下文");
  });
});
