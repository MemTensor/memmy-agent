/** Routes tests. */
import { AppBootstrapResponseSchema } from "@memmy/local-api-contracts";
import { describe, expect, it } from "vitest";
import {
  buildAccountOnboardingStartPatch,
  buildByokOnboardingGuidePatch,
  buildByokOnboardingSetupPatch,
  buildOnboardingCompletionPatch,
  clearFocusedAgentTarget,
  FOCUSED_AGENT_CHAT_STORAGE_KEY,
  removeLaunchAgentChatIdFromUrl,
  readCurrentRoute,
  readTokenExhaustedDismissed,
  writeTokenExhaustedDismissed,
  resolveGiftTokenUsage,
  readLaunchAgentChatId,
  readLaunchModeOverride,
  readPetIntentOverride,
  readLaunchRouteOverride,
  reconcileInitialOnboarding,
  resolveMainWindowRouteTarget,
  resolveByokEntry,
  resolveByokModelCompletion,
  resolveInitialView,
  resolveLaunchInitialView,
  resolvePostLoginRoute,
  resolvePostOnboardingRoute,
  resolvePreferredLaunchMode,
  resolveReloadedInitialView,
  shouldExitPetLaunchForRoute,
  shouldShowTokenExhaustedModal,
  routeTable,
  writeCurrentRoute,
  readProductTourStep,
  writeProductTourStep,
  clearProductTourStep,
  readGuidanceCompleted,
  writeGuidanceCompleted
} from "../routes.js";

/** Definition for base bootstrap. */
const baseBootstrap = AppBootstrapResponseSchema.parse({
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
    usedTokens: 0,
    remainingTokens: 30000000,
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

describe("desktop route table", () => {
  it("keeps every product route addressable", () => {
    expect(Object.keys(routeTable)).toEqual([
      "/welcome",
      "/token-detail",
      "/login",
      "/api-key",
      "/api-key-models",
      "/api-key-optional",
      "/onboarding",
      "/main",
      "/pet",
      "/tools",
      "/memory",
      "/memory-sources",
      "/settings"
    ]);
  });

  it("routes unset login mode to welcome before onboarding", () => {
    expect(resolveInitialView({ bootstrap: baseBootstrap, preferredMode: null })).toBe("/welcome");
  });

  it("routes missing login mode back to welcome even if onboarding was completed before", () => {
    expect(
      resolveInitialView({
        bootstrap: {
          ...baseBootstrap,
          onboarding: {
            ...baseBootstrap.onboarding,
            completed: true,
            currentStep: "completed",
            completedAt: "2026-06-04T00:00:00.000Z"
          }
        },
        preferredMode: "full"
      })
    ).toBe("/welcome");
  });

  it("routes account mode without an authenticated session back to welcome", () => {
    expect(
      resolveInitialView({
        bootstrap: {
          ...baseBootstrap,
          app: { ...baseBootstrap.app, userMode: "account" },
          onboarding: {
            ...baseBootstrap.onboarding,
            completed: true,
            currentStep: "completed",
            completedAt: "2026-06-04T00:00:00.000Z"
          }
        },
        preferredMode: "full",
        accountSession: { authenticated: false }
      })
    ).toBe("/welcome");
  });

  it("routes unfinished API key setup to the API key page", () => {
    expect(
      resolveInitialView({
        bootstrap: {
          ...baseBootstrap,
          app: { ...baseBootstrap.app, userMode: "byok" },
          onboarding: { ...baseBootstrap.onboarding, currentStep: "byok_setup_required" }
        },
        preferredMode: null
      })
    ).toBe("/api-key");
  });

  it("respects the preferred full or pet mode after onboarding is complete", () => {
    const completedBootstrap = {
      ...baseBootstrap,
      app: { ...baseBootstrap.app, userMode: "account" as const },
      onboarding: {
        ...baseBootstrap.onboarding,
        completed: true,
        currentStep: "completed" as const,
        completedAt: "2026-06-01T00:00:00.000Z"
      }
    };

    const accountSession = {
      authenticated: true as const,
      isNewUser: false,
      profile: {
        userId: "user-1",
        email: "hello@example.com",
        phoneNumber: null,
        nickname: "Memmy User",
        avatarUrl: null,
        planType: null,
        hasFinishedGuide: true,
        region: null,
        registeredAt: "2026-06-01T00:00:00.000Z"
      }
    };

    expect(resolveInitialView({ bootstrap: completedBootstrap, preferredMode: "pet", accountSession })).toBe("/pet");
    expect(resolveInitialView({ bootstrap: completedBootstrap, preferredMode: "full", accountSession })).toBe("/main");
  });

  it("uses the machine-level guidance marker when the authenticated account guide state is stale", () => {
    const unfinishedBootstrap = {
      ...baseBootstrap,
      app: { ...baseBootstrap.app, userMode: "account" as const },
      onboarding: {
        ...baseBootstrap.onboarding,
        completed: false,
        currentStep: "scan_permission_required" as const,
        completedAt: null
      }
    };
    const staleAccountSession = {
      authenticated: true as const,
      isNewUser: false,
      profile: {
        userId: "user-1",
        email: "hello@example.com",
        phoneNumber: null,
        nickname: "Memmy User",
        avatarUrl: null,
        planType: null,
        hasFinishedGuide: false,
        region: null,
        registeredAt: "2026-06-01T00:00:00.000Z"
      }
    };

    expect(resolveInitialView({
      bootstrap: unfinishedBootstrap,
      preferredMode: "pet",
      accountSession: staleAccountSession,
      guidanceCompleted: true
    })).toBe("/pet");
    expect(resolveInitialView({
      bootstrap: unfinishedBootstrap,
      preferredMode: "full",
      accountSession: staleAccountSession,
      guidanceCompleted: true
    })).toBe("/main");
    expect(resolveInitialView({
      bootstrap: unfinishedBootstrap,
      preferredMode: "pet",
      accountSession: { authenticated: false },
      guidanceCompleted: true
    })).toBe("/welcome");
  });

  it("routes logged-out account mode back to welcome even when local onboarding is complete", () => {
    expect(
      resolveInitialView({
        bootstrap: {
          ...baseBootstrap,
          app: { ...baseBootstrap.app, userMode: "account" },
          onboarding: {
            ...baseBootstrap.onboarding,
            completed: true,
            currentStep: "completed",
            completedAt: "2026-06-01T00:00:00.000Z"
          }
        },
        preferredMode: "full",
        accountSession: { authenticated: false }
      })
    ).toBe("/welcome");
  });

  it("routes unset mode back to welcome even if stale onboarding says complete", () => {
    expect(
      resolveInitialView({
        bootstrap: {
          ...baseBootstrap,
          app: { ...baseBootstrap.app, userMode: "unset" },
          onboarding: {
            ...baseBootstrap.onboarding,
            completed: true,
            currentStep: "completed",
            completedAt: "2026-06-01T00:00:00.000Z"
          }
        },
        preferredMode: "full"
      })
    ).toBe("/welcome");
  });

  it("allows completed BYOK users to enter the workspace without an account session", () => {
    const completedByokBootstrap = {
      ...baseBootstrap,
      app: { ...baseBootstrap.app, userMode: "byok" as const },
      onboarding: {
        ...baseBootstrap.onboarding,
        completed: true,
        currentStep: "completed" as const,
        completedAt: "2026-06-01T00:00:00.000Z"
      }
    };

    expect(
      resolveInitialView({
        bootstrap: completedByokBootstrap,
        preferredMode: "full",
        accountSession: { authenticated: false }
      })
    ).toBe("/main");
    expect(
      resolveInitialView({
        bootstrap: completedByokBootstrap,
        preferredMode: "pet",
        accountSession: { authenticated: false }
      })
    ).toBe("/pet");
  });

  it("only shows the token exhausted modal for account users with zero remaining tokens", () => {
    const zeroTokenAccount = {
      ...baseBootstrap,
      app: { ...baseBootstrap.app, userMode: "account" as const },
      tokenUsage: { ...baseBootstrap.tokenUsage, usedTokens: 30000000, remainingTokens: 0 }
    };

    expect(shouldShowTokenExhaustedModal(zeroTokenAccount)).toBe(true);
    expect(shouldShowTokenExhaustedModal({ ...zeroTokenAccount, app: { ...zeroTokenAccount.app, userMode: "byok" } })).toBe(false);
    expect(shouldShowTokenExhaustedModal({ ...zeroTokenAccount, tokenUsage: { ...zeroTokenAccount.tokenUsage, remainingTokens: 1 } })).toBe(false);
  });

  it("restores completed account users from the persisted session on refresh", () => {
    expect(
      resolveInitialView({
        bootstrap: {
          ...baseBootstrap,
          app: { ...baseBootstrap.app, userMode: "account" }
        },
        preferredMode: "full",
        accountSession: {
          authenticated: true,
          isNewUser: false,
          profile: {
            userId: "user-1",
            email: "hello@example.com",
            phoneNumber: null,
            nickname: "Memmy User",
            avatarUrl: null,
            planType: null,
            hasFinishedGuide: true,
            region: null,
            registeredAt: "2026-06-01T00:00:00.000Z"
          }
        }
      })
    ).toBe("/main");
  });

  it("continues onboarding for authenticated account users whose guide is unfinished", () => {
    expect(
      resolveInitialView({
        bootstrap: {
          ...baseBootstrap,
          app: { ...baseBootstrap.app, userMode: "account" }
        },
        preferredMode: null,
        accountSession: {
          authenticated: true,
          isNewUser: true,
          profile: {
            userId: "user-2",
            email: null,
            phoneNumber: "13800138000",
            nickname: "Memmy User",
            avatarUrl: null,
            planType: null,
            hasFinishedGuide: false,
            region: null,
            registeredAt: "2026-06-01T00:00:00.000Z"
          }
        }
      })
    ).toBe("/onboarding");
  });

  it("账号云端引导未完成时，不让本地 completed 脏状态跳过新人引导", () => {
    const staleCompletedBootstrap = {
      ...baseBootstrap,
      app: { ...baseBootstrap.app, userMode: "account" as const },
      onboarding: {
        ...baseBootstrap.onboarding,
        completed: true,
        currentStep: "completed" as const,
        scanPermission: "scan_only" as const,
        improvementProgram: "accepted" as const,
        completedAt: "2026-06-04T00:00:00.000Z"
      }
    };
    const unfinishedAccountSession = {
      authenticated: true as const,
      isNewUser: false,
      profile: {
        userId: "user-2",
        email: null,
        phoneNumber: "13800138000",
        nickname: "Memmy User",
        avatarUrl: null,
        planType: null,
        hasFinishedGuide: false,
        region: null,
        registeredAt: "2026-06-01T00:00:00.000Z"
      }
    };
    const reconciled = reconcileInitialOnboarding({
      bootstrap: staleCompletedBootstrap,
      accountSession: unfinishedAccountSession
    });

    expect(reconciled.onboarding).toMatchObject(buildAccountOnboardingStartPatch());
    expect(resolveInitialView({ bootstrap: reconciled, preferredMode: "full", accountSession: unfinishedAccountSession })).toBe("/onboarding");
  });

  it("reads Electron launch mode from query string", () => {
    expect(readLaunchModeOverride("?memmyMode=pet")).toBe("pet");
    expect(readLaunchModeOverride("?foo=bar&memmyMode=full")).toBe("full");
    expect(readLaunchModeOverride("?memmyMode=last")).toBe("last");
    expect(readLaunchModeOverride("?memmyMode=unknown")).toBeNull();
    expect(readLaunchModeOverride(undefined)).toBeNull();
    expect(readPetIntentOverride("?memmyPetIntent=user")).toBe("user");
    expect(readPetIntentOverride("?memmyPetIntent=boot")).toBeNull();
    expect(readLaunchRouteOverride("?memmyRoute=%2Fsettings")).toBe("/settings");
    expect(readLaunchRouteOverride("?memmyRoute=/pet")).toBe("/pet");
    expect(readLaunchRouteOverride("?memmyRoute=/unknown")).toBeNull();
    expect(readLaunchRouteOverride(undefined)).toBeNull();
    expect(readLaunchAgentChatId("?memmyAgentChat=chat-1")).toBe("chat-1");
    expect(readLaunchAgentChatId("?memmyAgentChat=pet:session_1")).toBe("pet:session_1");
    expect(readLaunchAgentChatId("?memmyAgentChat=../bad")).toBeNull();
    expect(readLaunchAgentChatId(undefined)).toBeNull();
  });

  it("sanitizes route targets sent from the main process to an existing main window", () => {
    expect(resolveMainWindowRouteTarget({ route: "/main", hash: "pet-avatar", agentChatId: "chat-1" })).toEqual({
      route: "/main",
      hash: "pet-avatar",
      agentChatId: "chat-1"
    });
    expect(resolveMainWindowRouteTarget({ route: "/settings", hash: "avatar_2", agentChatId: "pet:session_1" })).toEqual({
      route: "/settings",
      hash: "avatar_2",
      agentChatId: null
    });
    expect(resolveMainWindowRouteTarget({ route: "/welcome", agentChatId: "chat-1" })).toEqual({
      route: "/welcome",
      hash: null,
      agentChatId: null
    });
    expect(resolveMainWindowRouteTarget({ route: "/unknown", hash: "../bad", agentChatId: "../bad" })).toEqual({
      route: null,
      hash: null,
      agentChatId: null
    });
    expect(resolveMainWindowRouteTarget(null)).toEqual({
      route: null,
      hash: null,
      agentChatId: null
    });
  });

  it("removes only the launch agent chat query from the current URL", () => {
    const calls: Array<[unknown, string, string]> = [];
    removeLaunchAgentChatIdFromUrl(
      { href: "https://memmy.local/main?memmyMode=full&memmyAgentChat=chat-1&memmyRoute=%2Fmain#reply" },
      { state: { keep: true }, replaceState: (state, title, url) => calls.push([state, title, String(url)]) }
    );

    expect(calls).toEqual([[{ keep: true }, "", "/main?memmyMode=full&memmyRoute=%2Fmain#reply"]]);
  });

  it("does not rewrite the URL when no launch agent chat query exists", () => {
    const calls: Array<[unknown, string, string]> = [];
    removeLaunchAgentChatIdFromUrl(
      { href: "https://memmy.local/main?memmyMode=full#reply" },
      { state: null, replaceState: (state, title, url) => calls.push([state, title, String(url)]) }
    );

    expect(calls).toEqual([]);
  });

  it("clears focused agent targets from storage and URL", () => {
    const storage = new MapStorage();
    const calls: Array<[unknown, string, string]> = [];
    storage.setItem(FOCUSED_AGENT_CHAT_STORAGE_KEY, "chat-1");

    clearFocusedAgentTarget(
      storage,
      { href: "https://memmy.local/main?memmyAgentChat=chat-1&foo=1" },
      { state: "state", replaceState: (state, title, url) => calls.push([state, title, String(url)]) }
    );

    expect(storage.getItem(FOCUSED_AGENT_CHAT_STORAGE_KEY)).toBeNull();
    expect(calls).toEqual([["state", "", "/main?foo=1"]]);
  });

  it("pet 启动需要登录或补引导时先退出桌宠窗口", () => {
    expect(shouldExitPetLaunchForRoute({ launchModeOverride: "pet", initialPath: "/welcome" })).toBe(true);
    expect(shouldExitPetLaunchForRoute({ launchModeOverride: "pet", initialPath: "/login" })).toBe(true);
    expect(shouldExitPetLaunchForRoute({ launchModeOverride: "pet", petIntent: "user", initialPath: "/welcome" })).toBe(true);
    expect(shouldExitPetLaunchForRoute({ launchModeOverride: "pet", petIntent: "user", initialPath: "/login" })).toBe(true);
    expect(shouldExitPetLaunchForRoute({ launchModeOverride: "pet", initialPath: "/api-key" })).toBe(true);
    expect(shouldExitPetLaunchForRoute({ launchModeOverride: "pet", initialPath: "/api-key-models" })).toBe(true);
    expect(shouldExitPetLaunchForRoute({ launchModeOverride: "pet", initialPath: "/onboarding" })).toBe(true);
    expect(shouldExitPetLaunchForRoute({ launchModeOverride: "pet", initialPath: "/main" })).toBe(true);
    expect(shouldExitPetLaunchForRoute({ launchModeOverride: "pet", initialPath: "/pet" })).toBe(false);
    expect(shouldExitPetLaunchForRoute({ launchModeOverride: "full", initialPath: "/welcome" })).toBe(false);
    expect(shouldExitPetLaunchForRoute({ launchModeOverride: null, initialPath: "/welcome" })).toBe(false);
  });

  it("builds the persisted completion patch before a pet window can re-bootstrap", () => {
    expect(buildOnboardingCompletionPatch("2026-06-04T00:00:00.000Z")).toEqual({
      completed: true,
      currentStep: "completed",
      completedAt: "2026-06-04T00:00:00.000Z"
    });
  });

  it("构造账号和 BYOK 新人引导的初始补丁", () => {
    expect(buildAccountOnboardingStartPatch()).toEqual({
      completed: false,
      currentStep: "scan_permission_required",
      hasAcceptedTerms: true,
      acceptedTermsVersion: null,
      scanPermission: "unset",
      improvementProgram: "unset",
      completedAt: null
    });
    expect(buildByokOnboardingSetupPatch()).toEqual({
      completed: false,
      currentStep: "byok_setup_required",
      hasAcceptedTerms: true,
      acceptedTermsVersion: null,
      scanPermission: "unset",
      improvementProgram: "not_applicable",
      completedAt: null
    });
    expect(buildByokOnboardingGuidePatch()).toEqual({
      completed: false,
      currentStep: "scan_permission_required",
      hasAcceptedTerms: true,
      acceptedTermsVersion: null,
      scanPermission: "unset",
      improvementProgram: "not_applicable",
      completedAt: null
    });
  });

  it("resolves the first route from the saved launch mode preference", () => {
    expect(resolvePostOnboardingRoute("pet")).toBe("/pet");
    expect(resolvePostOnboardingRoute("full")).toBe("/main");
    expect(resolvePostOnboardingRoute("last")).toBe("/main");
  });

  it("restores the current window route across renderer reloads after onboarding", () => {
    expect(resolveReloadedInitialView("/main", "/memory-sources")).toBe("/memory-sources");
    expect(resolveReloadedInitialView("/pet", "/settings")).toBe("/settings");
    expect(resolveReloadedInitialView("/main", "/pet")).toBe("/main");
    expect(resolveReloadedInitialView("/pet", "/pet")).toBe("/pet");
    expect(resolveReloadedInitialView("/onboarding", "/memory-sources")).toBe("/onboarding");
    expect(resolveReloadedInitialView("/welcome", "/settings")).toBe("/welcome");
  });

  it("ignores explicit launch route overrides until onboarding is complete", () => {
    expect(
      resolveLaunchInitialView({
        defaultPath: "/onboarding",
        currentRoute: "/main",
        launchRouteOverride: "/main",
        launchModeOverride: null
      })
    ).toBe("/onboarding");
    expect(
      resolveLaunchInitialView({
        defaultPath: "/api-key",
        currentRoute: "/settings",
        launchRouteOverride: "/settings",
        launchModeOverride: null
      })
    ).toBe("/api-key");
  });

  it("用户主动从登录入口切桌宠时保留桌宠窗口，但不能绕过配置或首次引导", () => {
    expect(
      resolveLaunchInitialView({
        defaultPath: "/welcome",
        currentRoute: null,
        launchRouteOverride: null,
        launchModeOverride: "pet",
        petIntent: "user"
      })
    ).toBe("/pet");
    expect(
      resolveLaunchInitialView({
        defaultPath: "/login",
        currentRoute: null,
        launchRouteOverride: null,
        launchModeOverride: "pet",
        petIntent: "user"
      })
    ).toBe("/pet");
    expect(
      resolveLaunchInitialView({
        defaultPath: "/api-key",
        currentRoute: null,
        launchRouteOverride: null,
        launchModeOverride: "pet",
        petIntent: "user"
      })
    ).toBe("/api-key");
    expect(
      resolveLaunchInitialView({
        defaultPath: "/onboarding",
        currentRoute: null,
        launchRouteOverride: null,
        launchModeOverride: "pet",
        petIntent: "user"
      })
    ).toBe("/onboarding");
  });

  it("keeps explicit launch route overrides after onboarding is complete", () => {
    expect(
      resolveLaunchInitialView({
        defaultPath: "/main",
        currentRoute: "/memory",
        launchRouteOverride: "/settings",
        launchModeOverride: null
      })
    ).toBe("/settings");
  });

  it("persists only valid current routes in session storage", () => {
    const storage = new MapStorage();
    writeCurrentRoute(storage, "/memory-sources");
    expect(readCurrentRoute(storage)).toBe("/memory-sources");
    storage.setItem("memmy.currentRoute", "/unknown");
    expect(readCurrentRoute(storage)).toBeNull();
  });

  it("体验额度弹窗 dismiss 标记写入 sessionStorage 并可读回，跨窗口 reload 保留", () => {
    const storage = new MapStorage();
    expect(readTokenExhaustedDismissed(storage)).toBe(false);
    writeTokenExhaustedDismissed(storage);
    expect(readTokenExhaustedDismissed(storage)).toBe(true);
    expect(readTokenExhaustedDismissed(storage)).toBe(true);
  });

  it("体验额度使用率与低余额判定：满额不提示、80% 起提示、剩余<=0 一律提示", () => {
    // Fresh start with full quota: 0% used, no hint.
    expect(resolveGiftTokenUsage(0, 30_000_000, 30_000_000)).toEqual({ usagePercent: 0, isTokenLow: false });
    // 79% no hint, 80% and above shows the hint.
    expect(resolveGiftTokenUsage(23_000_000, 30_000_000, 7_000_000).isTokenLow).toBe(false);
    expect(resolveGiftTokenUsage(24_000_000, 30_000_000, 6_000_000).isTokenLow).toBe(true);
    // Fully used: 100% and hint.
    expect(resolveGiftTokenUsage(30_000_000, 30_000_000, 0)).toEqual({ usagePercent: 100, isTokenLow: true });
    // Consumption overflow (the earlier consume>total case): percentage capped at 100% and hint.
    expect(resolveGiftTokenUsage(30_001_366, 30_000_000, 0)).toEqual({ usagePercent: 100, isTokenLow: true });
    // Key regression: remaining is 0 from the start (including total=0 / no quota) -> must hint,
    // while the progress-bar ratio stays a real 0% instead of falsely showing as full.
    expect(resolveGiftTokenUsage(0, 0, 0)).toEqual({ usagePercent: 0, isTokenLow: true });
  });

  it("产品导览步骤写入 sessionStorage 并可读回，跨 AppFrame 重挂载/reload 保留", () => {
    const storage = new MapStorage();
    expect(readProductTourStep(storage)).toBeNull();
    writeProductTourStep(storage, 1);
    expect(readProductTourStep(storage)).toBe(1);
    clearProductTourStep(storage);
    expect(readProductTourStep(storage)).toBeNull();
  });

  it("新手引导机器级完成标记写入 localStorage 并可读回，跨模式/账号/重启保留", () => {
    const storage = new MapStorage();
    expect(readGuidanceCompleted(storage)).toBe(false);
    writeGuidanceCompleted(storage);
    expect(readGuidanceCompleted(storage)).toBe(true);
    expect(readGuidanceCompleted(storage)).toBe(true);
  });

  it("产品导览步骤读取时拒绝非法值，避免脏数据把导览定位到不存在的步骤", () => {
    const storage = new MapStorage();
    storage.setItem("memmy.productTourStep", "-1");
    expect(readProductTourStep(storage)).toBeNull();
    storage.setItem("memmy.productTourStep", "abc");
    expect(readProductTourStep(storage)).toBeNull();
    storage.setItem("memmy.productTourStep", "2");
    expect(readProductTourStep(storage)).toBe(2);
  });

  it("登录完成后已完成引导按默认启动模式进入目标形态", () => {
    expect(
      resolvePostLoginRoute({
        onboarding: {
          ...baseBootstrap.onboarding,
          completed: true,
          currentStep: "completed",
          completedAt: "2026-06-04T00:00:00.000Z"
        },
        preferredMode: "pet"
      })
    ).toBe("/pet");
    expect(
      resolvePostLoginRoute({
        onboarding: {
          ...baseBootstrap.onboarding,
          completed: true,
          currentStep: "completed",
          completedAt: "2026-06-04T00:00:00.000Z"
        },
        preferredMode: "full"
      })
    ).toBe("/main");
    expect(
      resolvePostLoginRoute({
        onboarding: { ...baseBootstrap.onboarding, completed: false, currentStep: "scan_permission_required" },
        preferredMode: "pet"
      })
    ).toBe("/onboarding");
    expect(
      resolvePostLoginRoute({
        onboarding: { ...baseBootstrap.onboarding, completed: false, currentStep: "product_tour_required" },
        preferredMode: "pet"
      })
    ).toBe("/onboarding");
  });

  it("BYOK 第二步在 has_finished_guide=0 时进入首次启动引导", () => {
    const decision = resolveByokModelCompletion({
      onboarding: {
        ...baseBootstrap.onboarding,
        completed: false,
        currentStep: "byok_setup_required"
      }
    });

    expect(decision).toEqual({
      onboardingPatch: buildByokOnboardingGuidePatch(),
      nextRoute: "/onboarding"
    });
  });

  it("BYOK 第二步在 has_finished_guide=1 时直接进入主界面", () => {
    const decision = resolveByokModelCompletion({
      onboarding: {
        ...baseBootstrap.onboarding,
        completed: true,
        currentStep: "completed",
        completedAt: "2026-06-04T00:00:00.000Z"
      }
    });

    expect(decision).toEqual({
      onboardingPatch: undefined,
      nextRoute: "/main"
    });
  });

  it("欢迎页进 BYOK：已完成引导时不重置引导状态，只去配置 API Key", () => {
    const decision = resolveByokEntry({
      onboarding: {
        ...baseBootstrap.onboarding,
        completed: true,
        currentStep: "completed",
        completedAt: "2026-06-04T00:00:00.000Z"
      }
    });

    expect(decision).toEqual({
      onboardingPatch: undefined,
      nextRoute: "/api-key"
    });
  });

  it("欢迎页进 BYOK：从未完成引导时写配置起点补丁并走完整引导", () => {
    const decision = resolveByokEntry({ onboarding: undefined });

    expect(decision).toEqual({
      onboardingPatch: buildByokOnboardingSetupPatch(),
      nextRoute: "/api-key"
    });
  });

  it("resolves the preferred launch mode from persisted settings, expanding 'last'", () => {
    expect(resolvePreferredLaunchMode({ defaultLaunchMode: "pet", lastLaunchMode: "full" })).toBe("pet");
    expect(resolvePreferredLaunchMode({ defaultLaunchMode: "full", lastLaunchMode: "pet" })).toBe("full");
    expect(resolvePreferredLaunchMode({ defaultLaunchMode: "last", lastLaunchMode: "pet" })).toBe("pet");
    expect(resolvePreferredLaunchMode({ defaultLaunchMode: "last", lastLaunchMode: "full" })).toBe("full");
  });
});

class MapStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}
