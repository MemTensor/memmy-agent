// @vitest-environment happy-dom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { createInitialAppState, type AppState } from "../../state/app-reducer.js";
import { AppRouter } from "../router.js";

const context = vi.hoisted(() => ({
  state: null as unknown as AppState,
  dispatch: vi.fn(),
  track: vi.fn()
}));

vi.mock("../../state/app-state.js", () => ({ useAppState: () => context }));
vi.mock("../../analytics/use-analytics.js", () => ({
  useAnalytics: () => ({ track: context.track, ready: false })
}));
vi.mock("../providers.js", () => ({ useOptionalApiClients: () => ({ clients: null }) }));
vi.mock("../../pages/browser-panel.js", () => ({
  MEMMY_BROWSER_MOUNTED_EVENT: "memmy:browser-mounted",
  hasMountedBrowserPanel: () => false,
  requestBrowserNewTab: vi.fn()
}));
vi.mock("../../pages/api-key-page.js", () => ({ ApiKeyPage: () => null }));
vi.mock("../../pages/api-key-optional-page.js", () => ({ ApiKeyOptionalPage: () => null }));
vi.mock("../../pages/model-page.js", () => ({ ModelPage: () => null }));
vi.mock("../../pages/home-page.js", () => ({ HomePage: () => null }));
vi.mock("../../pages/login-page.js", () => ({ LoginPage: () => null }));
vi.mock("../../pages/memory-page.js", () => ({ MemoryPage: () => null, writeMemorySubPage: vi.fn() }));
vi.mock("../../pages/knowledge-page.js", () => ({ KnowledgePage: () => null }));
vi.mock("../../pages/onboarding-page.js", () => ({ OnboardingPage: () => null }));
vi.mock("../../pages/settings-page.js", () => ({ SettingsPage: () => null }));
vi.mock("../../pages/token-detail-page.js", () => ({ TokenDetailPage: () => null }));
vi.mock("../../pages/tools-page.js", () => ({ ToolsPage: () => null }));
vi.mock("../../pages/welcome-page.js", () => ({ WelcomePage: () => null }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AppRouter pet startup", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalUrl: string;
  let syncPetWindowLayout: ReturnType<typeof vi.fn>;
  let onRetry: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    context.state = createInitialAppState();
    // The launch query identifies the native pet renderer before bootstrap chooses its route.
    context.state.navigation.currentPath = "/welcome";
    originalUrl = window.location.href;
    window.history.replaceState(null, "", "/?memmyMode=pet");
    window.sessionStorage.clear();
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    syncPetWindowLayout = vi.fn();
    onRetry = vi.fn();
    Object.defineProperty(window, "memmy", {
      configurable: true,
      value: { syncPetWindowLayout }
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const isError = context.state.startup.status === "error";
      if (this.hasAttribute("data-pet-startup")) {
        return new DOMRect(0, 0, 288, isError ? 260 : 228);
      }
      if (this.hasAttribute("data-pet-startup-mascot")) {
        return new DOMRect(84, isError ? 116 : 84, 120, 120);
      }
      if (this.tagName === "BUTTON" && this.closest("[data-pet-startup]")) {
        return new DOMRect(64, 48, 160, 32);
      }
      return new DOMRect();
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    expect(document.body.classList.contains("memmy-pet-transparent")).toBe(false);
    expect(document.documentElement.classList.contains("memmy-pet-transparent")).toBe(false);
    document.body.replaceChildren();
    window.history.replaceState(null, "", originalUrl);
    window.sessionStorage.clear();
    delete window.memmy;
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function renderRouter(status: "idle" | "loading" | "error", errorMessage: string | null = "backend unavailable") {
    context.state.startup = {
      ...context.state.startup,
      status,
      message: status === "error" ? errorMessage : null
    };
    act(() => {
      root.render(
        <StrictMode>
          <I18nProvider language="zh-CN">
            <AppRouter onRetry={onRetry} />
          </I18nProvider>
        </StrictMode>
      );
    });
  }

  it.each(["idle", "loading"] as const)("reports a usable native pet layout during %s without animation frames", (status) => {
    renderRouter(status);

    expect(syncPetWindowLayout).toHaveBeenCalledWith({
      width: 288,
      height: 228,
      mascotOffsetX: 84,
      mascotOffsetY: 84
    });
    expect(container.querySelector("[data-pet-startup]")?.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector("[role=status]")).not.toBeNull();
    expect(document.body.classList.contains("memmy-pet-transparent")).toBe(true);
    expect(document.documentElement.classList.contains("memmy-pet-transparent")).toBe(true);
  });

  it.each(["backend unavailable", "", null])("shows startup failure and a clickable retry for message %s inside the reported pet bounds", (message) => {
    renderRouter("error", message);

    expect(syncPetWindowLayout).toHaveBeenCalledWith({
      width: 288,
      height: 260,
      mascotOffsetX: 84,
      mascotOffsetY: 116
    });
    const petStartup = container.querySelector<HTMLElement>("[data-pet-startup]");
    expect(petStartup).not.toBeNull();
    expect(petStartup?.getAttribute("aria-busy")).toBe("false");
    expect(petStartup!.querySelector("[role=alert]")).not.toBeNull();
    const retry = petStartup?.querySelector<HTMLButtonElement>("button");
    expect(retry?.textContent).toBe("重试");
    expect(retry?.disabled).toBe(false);
    expect(retry?.getBoundingClientRect().right).toBeLessThanOrEqual(288);
    expect(retry?.getBoundingClientRect().bottom).toBeLessThanOrEqual(260);
    act(() => retry!.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
