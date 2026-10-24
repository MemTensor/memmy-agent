// @vitest-environment happy-dom

import { AppBootstrapResponseSchema } from "@memmy/local-api-contracts";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HistoryLaunchPromptHost } from "../../components/history-launch-prompt-host.js";
import type { NicknameModalProps } from "../../components/nickname-modal.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { appActions } from "../../state/app-actions.js";
import { createInitialAppState, type AppState } from "../../state/app-reducer.js";
import { readHistoryLaunchPromptState, setHistoryLaunchPromptOpen } from "../history-launch-prompt-state.js";
import type { ProductTourGuideProps } from "../product-tour.js";
import { AppRouter } from "../router.js";
import {
  GUIDANCE_PROGRESS_STORAGE_KEY,
  readDeferredGuidanceStep,
  readGuidanceCompleted,
  writeDeferredGuidanceStep,
  type AppRoutePath,
  type DeferredGuidanceStep,
} from "../routes.js";

const context = vi.hoisted(() => ({
  state: null as unknown as AppState,
  dispatch: vi.fn(),
  track: vi.fn(),
  updateProfile: vi.fn(),
}));

vi.mock("../../state/app-state.js", () => ({ useAppState: () => context }));
vi.mock("../../analytics/use-analytics.js", () => ({
  useAnalytics: () => ({ track: context.track, ready: false }),
}));
vi.mock("../providers.js", () => ({
  useOptionalApiClients: () => ({ clients: { account: { updateProfile: context.updateProfile } } }),
}));
vi.mock("../../pages/browser-panel.js", () => ({
  MEMMY_BROWSER_MOUNTED_EVENT: "memmy:browser-mounted",
  hasMountedBrowserPanel: () => false,
  requestBrowserNewTab: vi.fn(),
}));
vi.mock("../../pages/api-key-page.js", () => ({ ApiKeyPage: () => null }));
vi.mock("../../pages/api-key-optional-page.js", () => ({ ApiKeyOptionalPage: () => null }));
vi.mock("../../pages/model-page.js", () => ({ ModelPage: () => null }));
vi.mock("../../pages/home-page.js", () => ({ HomePage: () => null }));
vi.mock("../../pages/login-page.js", () => ({ LoginPage: () => null }));
vi.mock("../../pages/memory-page.js", () => ({ MemoryPage: () => null, writeMemorySubPage: vi.fn() }));
vi.mock("../../pages/knowledge-page.js", () => ({ KnowledgePage: () => null }));
vi.mock("../../pages/onboarding-page.js", () => ({ OnboardingPage: () => null }));
vi.mock("../../pages/pet-page.js", () => ({ PetPage: () => null }));
vi.mock("../../pages/pet-startup-screen.js", () => ({ PetStartupScreen: () => null }));
vi.mock("../../pages/settings-page.js", () => ({ SettingsPage: () => null }));
vi.mock("../../pages/startup-screen.js", () => ({ StartupScreen: () => null }));
vi.mock("../../pages/token-detail-page.js", () => ({ TokenDetailPage: () => null }));
vi.mock("../../pages/tools-page.js", () => ({ ToolsPage: () => null }));
vi.mock("../../pages/welcome-page.js", () => ({ WelcomePage: () => null }));
vi.mock("../update-coordinator.js", () => ({ GlobalUpdateDialog: () => null }));
vi.mock("../window-drag-region.js", () => ({
  WindowDragRegion: () => null,
  resolveWindowDragExclusionSelector: () => undefined,
}));
vi.mock("../product-tour.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../product-tour.js")>();
  return {
    ...actual,
    ProductTourGuide: ({ onDismiss }: ProductTourGuideProps) => <div data-test-tour>
      <button data-test-tour-finish onClick={() => onDismiss("completed", {
        tourStep: 3, tourStepCount: 4, tourTab: "tools",
      })}>完成导览</button>
      <button data-test-tour-skip onClick={() => onDismiss("skipped", {
        tourStep: 0, tourStepCount: 4, tourTab: "agents",
      })}>跳过导览</button>
    </div>,
  };
});
vi.mock("../../components/nickname-modal.js", () => ({
  NicknameModal: ({ open, onSubmit }: NicknameModalProps) => open
    ? <button data-test-nickname-submit onClick={onSubmit}>开始使用</button>
    : null,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  removeItem(key: string) { this.data.delete(key); }
  setItem(key: string, value: string) { this.data.set(key, value); }
}

function resetStorage(name: "localStorage" | "sessionStorage"): void {
  if (typeof window[name]?.clear === "function") {
    window[name].clear();
  } else {
    Object.defineProperty(window, name, { configurable: true, value: new MemoryStorage() });
  }
}

function completedBootstrap() {
  return AppBootstrapResponseSchema.parse({
    app: { userMode: "account", language: "system", theme: "system", autoUpdateEnabled: true },
    onboarding: {
      completed: true, currentStep: "completed", hasAcceptedTerms: true,
      acceptedTermsVersion: null, scanPermission: "none", improvementProgram: "declined", completedAt: null,
    },
    privacy: {
      telemetryOptIn: false, crashReportOptIn: false,
      allowMemoryImprovementUpload: false, localOnlyMode: false,
    },
    tokenUsage: {
      planName: "体验 Token", totalTokens: 30_000_000, usedTokens: 0,
      remainingTokens: 30_000_000, expiresAt: null, lastSyncedAt: null,
    },
    health: { localApi: "ok", memory: "mock", cloud: "mock" },
    promotions: {
      loginBanner: true, improvementGift: true, improvementGiftRewardTokens: 1_000_000,
      applyMore: true, agentChatTokenTotal: 2_000_000,
    },
  });
}

describe.each([
  { name: "macOS", platform: "darwin", osRelease: "25.0.0" },
  { name: "Windows 11", platform: "win32", osRelease: "10.0.26100" },
])("Router guidance and History notice on $name", ({ platform, osRelease }) => {
  let container: HTMLDivElement;
  let root: Root;
  let originalUrl: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-10T21:00:00+08:00"));
    resetStorage("localStorage");
    resetStorage("sessionStorage");
    originalUrl = window.location.href;
    window.history.replaceState(null, "", "/");
    context.state = createInitialAppState();
    context.state.startup.status = "ready";
    context.state.navigation.currentPath = "/main";
    context.state.bootstrap = completedBootstrap();
    context.state.account = {
      userId: "user-1", email: "test@example.com", phoneNumber: null,
      nickname: "", registeredAt: null,
    };
    // An outstanding profile response must not be needed to finish local guidance.
    context.updateProfile.mockImplementation(() => new Promise(() => {}));
    Object.defineProperty(window, "memmy", { configurable: true, value: { platform, osRelease } });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    setHistoryLaunchPromptOpen(false);
    document.body.replaceChildren();
    window.history.replaceState(null, "", originalUrl);
    Reflect.deleteProperty(window, "memmy");
    vi.restoreAllMocks();
  });

  async function renderRouter() {
    await act(async () => {
      root.render(<StrictMode><I18nProvider language="zh-CN">
        <AppRouter onRetry={vi.fn()} />
        <HistoryLaunchPromptHost />
      </I18nProvider></StrictMode>);
    });
  }

  async function click(selector: string) {
    const button = container.querySelector<HTMLButtonElement>(selector);
    expect(button).not.toBeNull();
    await act(async () => button!.click());
  }

  it.each(["finish", "skip"])("offers History immediately after tour %s and nickname submission", async (choice) => {
    writeDeferredGuidanceStep(window.sessionStorage, "product_tour");
    await renderRouter();
    expect(container.querySelector("[data-test-tour]")).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await click(`[data-test-tour-${choice}]`);
    expect(container.querySelector("[data-test-tour]")).toBeNull();
    expect(container.querySelector("[data-test-nickname-submit]")).not.toBeNull();
    expect(readDeferredGuidanceStep(window.sessionStorage)).toBe("nickname");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    context.dispatch.mockClear();

    // Submit invokes real Router completion; do not rerender or resolve updateProfile.
    await click("[data-test-nickname-submit]");

    expect(context.updateProfile).toHaveBeenCalledOnce();
    expect(context.dispatch).not.toHaveBeenCalled();
    expect(readGuidanceCompleted(window.localStorage)).toBe(true);
    expect(readDeferredGuidanceStep(window.sessionStorage)).toBeNull();
    expect(container.querySelector("[data-test-nickname-submit]")).toBeNull();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("电脑历史记录");
  });

  it("restores the product tour after restarting with empty session storage", async () => {
    writeDeferredGuidanceStep(window.sessionStorage, "product_tour");
    await renderRouter();
    expect(container.querySelector("[data-test-tour]")).not.toBeNull();

    await act(async () => root.unmount());
    window.sessionStorage.clear();
    root = createRoot(container);
    await renderRouter();

    expect(container.querySelector("[data-test-tour]")).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(readHistoryLaunchPromptState(window.localStorage).shown).toBe(false);
    await click("[data-test-tour-skip]");
    await click("[data-test-nickname-submit]");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  describe.each([
    { label: "welcome", path: "/welcome", userMode: "account", userId: "user-1" },
    { label: "login", path: "/login", userMode: "account", userId: "user-1" },
    { label: "API key setup", path: "/api-key", userMode: "account", userId: "user-1" },
    { label: "pet", path: "/pet", userMode: "account", userId: "user-1" },
    { label: "signed-out account", path: "/main", userMode: "account", userId: null },
    { label: "BYOK without an Agent model", path: "/main", userMode: "byok", userId: null },
  ] as const)("pending guidance at $label", ({ path, userMode, userId }) => {
    it.each(["armed", "improvement", "product_tour", "nickname"] as const)(
      "does not show or navigate from stored %s progress",
      async (step: DeferredGuidanceStep) => {
        context.state.navigation.currentPath = path as AppRoutePath;
        context.state.bootstrap!.app.userMode = userMode;
        context.state.account.userId = userId;
        writeDeferredGuidanceStep(window.sessionStorage, step);
        await renderRouter();

        expect(container.querySelector("[data-test-tour]")).toBeNull();
        expect(container.querySelector("[data-test-nickname-submit]")).toBeNull();
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(context.dispatch).not.toHaveBeenCalled();
        expect(readDeferredGuidanceStep(window.sessionStorage)).toBe(step);
        expect(readHistoryLaunchPromptState(window.localStorage).shown).toBe(false);
      },
    );
  });

  it("removes the old tour and offers History when another window completes guidance", async () => {
    writeDeferredGuidanceStep(window.sessionStorage, "product_tour");
    await renderRouter();
    expect(container.querySelector("[data-test-tour]")).not.toBeNull();

    await act(async () => {
      window.localStorage.setItem(GUIDANCE_PROGRESS_STORAGE_KEY, "completed");
      window.dispatchEvent(new StorageEvent("storage", {
        key: GUIDANCE_PROGRESS_STORAGE_KEY, oldValue: "product_tour", newValue: "completed",
        storageArea: window.localStorage,
      }));
    });

    expect(window.sessionStorage.getItem("memmy.deferredGuidanceStep")).toBe("product_tour");
    expect(container.querySelector("[data-test-tour]")).toBeNull();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(context.dispatch).not.toHaveBeenCalled();
  });

  it("resumes beyond an already-decided improvement step without changing upload consent", async () => {
    writeDeferredGuidanceStep(window.sessionStorage, "improvement");
    await renderRouter();

    expect(readDeferredGuidanceStep(window.sessionStorage)).toBe("product_tour");
    expect(context.dispatch).toHaveBeenCalledWith(appActions.navigate("/memory-sources"));
    expect(container.querySelector("[data-test-tour]")).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(context.state.bootstrap!.onboarding.improvementProgram).toBe("declined");
    expect(context.state.bootstrap!.privacy.allowMemoryImprovementUpload).toBe(false);
    expect(context.updateProfile).not.toHaveBeenCalled();
  });

  it("returns unfinished improvement consent from Memory to the main workspace", async () => {
    context.state.navigation.currentPath = "/memory";
    context.state.bootstrap!.onboarding.improvementProgram = "unset";
    writeDeferredGuidanceStep(window.sessionStorage, "improvement");
    await renderRouter();

    expect(context.dispatch).toHaveBeenCalledWith(appActions.navigate("/main"));
    expect(readDeferredGuidanceStep(window.sessionStorage)).toBe("improvement");
    expect(container.querySelector("[data-test-tour]")).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(readHistoryLaunchPromptState(window.localStorage).shown).toBe(false);

    // Follow the requested route as the real app reducer would. The Home mock
    // omits its consent dialog, so the unfinished choice must stay pending here.
    context.state.navigation.currentPath = "/main";
    context.dispatch.mockClear();
    await renderRouter();
    expect(context.dispatch).not.toHaveBeenCalled();
    expect(readDeferredGuidanceStep(window.sessionStorage)).toBe("improvement");
    expect(context.state.bootstrap!.privacy.allowMemoryImprovementUpload).toBe(false);
  });

  it("skips inapplicable improvement consent for configured BYOK without opting into upload", async () => {
    context.state.bootstrap!.app.userMode = "byok";
    context.state.bootstrap!.onboarding.improvementProgram = "unset";
    context.state.account.userId = null;
    context.state.modelConfig = {
      ...context.state.modelConfig,
      catalog: {
        modelAssignments: { byok: { agent: { candidates: ["saved-agent-model"] } } },
      } as NonNullable<AppState["modelConfig"]["catalog"]>,
    };
    writeDeferredGuidanceStep(window.sessionStorage, "improvement");
    await renderRouter();

    expect(readDeferredGuidanceStep(window.sessionStorage)).toBe("product_tour");
    expect(context.dispatch).toHaveBeenCalledWith(appActions.navigate("/memory-sources"));
    expect(container.querySelector("[data-test-tour]")).not.toBeNull();
    expect(context.state.bootstrap!.onboarding.improvementProgram).toBe("unset");
    expect(context.state.bootstrap!.privacy.allowMemoryImprovementUpload).toBe(false);

    await click("[data-test-tour-skip]");
    await click("[data-test-nickname-submit]");
    expect(context.updateProfile).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(context.state.bootstrap!.privacy.allowMemoryImprovementUpload).toBe(false);
  });

  it.each(["armed", "improvement", "product_tour", "nickname"] as const)(
    "keeps pending %s guidance inactive while the workspace window is hidden",
    async (step) => {
      context.state.navigation.windowVisible = false;
      writeDeferredGuidanceStep(window.sessionStorage, step);
      await renderRouter();

      expect(container.querySelector("[data-test-tour]")).toBeNull();
      expect(container.querySelector("[data-test-nickname-submit]")).toBeNull();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(context.dispatch).not.toHaveBeenCalled();
      expect(readDeferredGuidanceStep(window.sessionStorage)).toBe(step);
      expect(readHistoryLaunchPromptState(window.localStorage).shown).toBe(false);
    },
  );

  it("does not consume the ready History notice while hidden and offers it when shown", async () => {
    context.state.navigation.windowVisible = false;
    await renderRouter();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(readHistoryLaunchPromptState(window.localStorage).shown).toBe(false);

    context.state.navigation.windowVisible = true;
    await renderRouter();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("电脑历史记录");
    expect(readHistoryLaunchPromptState(window.localStorage).shown).toBe(true);
  });
});
