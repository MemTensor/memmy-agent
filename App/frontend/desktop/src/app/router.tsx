/** Router module. */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  PetGuideModal,
  readCloseMainWindowAction,
  readPetGuideCompleted,
  resolveCompletedMainWindowAction,
  resolvePetGuideChoice,
  shouldShowPetGuideForMainWindowAction,
  type MainWindowActionRoute,
  type MainWindowActionRequest,
  type MainWindowActionResolution,
  type PetGuideChoice
} from "./pet-guide.js";
import {
  ProductTourGuide,
  productTourIncludesLogs,
  productTourMemorySubPage,
  productTourTabRoute,
  type ProductTourDismissResult,
  type ProductTourStepInfo,
  type ProductTourTab
} from "./product-tour.js";
import { GlobalUpdateDialog } from "./update-coordinator.js";
import {
  clearDeferredGuidanceStep,
  clearProductTourStep,
  readCurrentRoute,
  readDeferredGuidanceStep,
  readLaunchModeOverride,
  writeCurrentRoute,
  writeDeferredGuidanceStep,
  writeGuidanceCompleted,
  type AppRoutePath,
  type DeferredGuidanceStep
} from "./routes.js";
import { persistNickname } from "./nickname.js";
import { useOptionalApiClients } from "./providers.js";
import { useAppState } from "../state/app-state.js";
import { useAnalytics } from "../analytics/use-analytics.js";
import {
  buildOnboardingCompletedEvent,
  buildOnboardingStepCompletedEvent,
  buildProductTourStepEvent
} from "../analytics/onboarding-analytics.js";
import { buildRoutePageViewEvent, shouldDeferRoutePageView } from "../analytics/page-view.js";
import { appActions } from "../state/app-actions.js";
import { NicknameModal } from "../components/nickname-modal.js";
import { randomNickname } from "../lib/nickname.js";
import { useTranslation } from "../i18n/use-translation.js";
import { ApiKeyPage } from "../pages/api-key-page.js";
import { ApiKeyOptionalPage } from "../pages/api-key-optional-page.js";
import { ModelPage } from "../pages/model-page.js";
import { HomePage } from "../pages/home-page.js";
import { LoginPage } from "../pages/login-page.js";
import { MemoryPage, writeMemorySubPage } from "../pages/memory-page.js";
import { OnboardingPage } from "../pages/onboarding-page.js";
import { PetPage } from "../pages/pet-page.js";
import { SettingsPage } from "../pages/settings-page.js";
import { StartupScreen } from "../pages/startup-screen.js";
import { TokenDetailPage } from "../pages/token-detail-page.js";
import { ToolsPage } from "../pages/tools-page.js";
import { WelcomePage } from "../pages/welcome-page.js";

function readWorkspaceGuidanceOverlay(storage: Storage | undefined): Extract<DeferredGuidanceStep, "product_tour" | "nickname"> | null {
  const step = readDeferredGuidanceStep(storage);
  return step === "product_tour" || step === "nickname" ? step : null;
}

/** Handles app router. */
export function AppRouter(props: { onRetry: () => void }) {
  const { state, dispatch } = useAppState();
  const { clients } = useOptionalApiClients();
  const { track, ready: analyticsReady } = useAnalytics();
  const { language } = useTranslation();
  const prevPathRef = useRef<AppRoutePath | null>(null);
  const [workspaceGuidanceStep, setWorkspaceGuidanceStep] = useState(() =>
    readWorkspaceGuidanceOverlay(typeof window === "undefined" ? undefined : window.sessionStorage)
  );
  const [deferredNickname, setDeferredNickname] = useState("");
  const [petGuideRequest, setPetGuideRequest] = useState<MainWindowActionRequest | null>(null);
  const isPetWindowContext = isPetWindow(state.navigation.currentPath);
  const windowDragRegion = !isPetWindowContext ? <WindowDragRegion /> : null;

  const completeMainWindowAction = useCallback(
    (request: MainWindowActionRequest, resolution: MainWindowActionResolution) => {
      void window.memmy?.completeMainWindowAction?.({ id: request.id, resolution }).catch((error: unknown) => {
        console.warn("complete main window action failed", error);
      });
    },
    []
  );

  const handlePetGuideChoice = useCallback(
    (choice: PetGuideChoice) => {
      if (!petGuideRequest) {
        return;
      }

      const storage = typeof window === "undefined" ? undefined : window.localStorage;
      const { resolution } = resolvePetGuideChoice(
        storage,
        choice,
        petGuideRequest.action,
        resolveMainWindowActionRoute(state.navigation.currentPath)
      );
      setPetGuideRequest(null);
      completeMainWindowAction(petGuideRequest, resolution);
    },
    [completeMainWindowAction, petGuideRequest, state.navigation.currentPath]
  );

  useEffect(() => {
    const bridge = typeof window === "undefined" ? undefined : window.memmy;
    if (!bridge?.onMainWindowActionRequest || !bridge.completeMainWindowAction) {
      return;
    }

    return bridge.onMainWindowActionRequest((request) => {
      const storage = window.localStorage;
      const route = resolveMainWindowActionRoute(state.navigation.currentPath);
      if (shouldShowPetGuideForMainWindowAction(route, request.action, readPetGuideCompleted(storage))) {
        setPetGuideRequest(request);
        return;
      }

      completeMainWindowAction(
        request,
        resolveCompletedMainWindowAction(
          readCloseMainWindowAction(storage),
          request.action,
          route
        )
      );
    });
  }, [completeMainWindowAction, state.navigation.currentPath]);

  useEffect(() => {
    if (state.startup.status !== "ready") {
      return;
    }

    writeCurrentRoute(typeof window === "undefined" ? undefined : window.sessionStorage, state.navigation.currentPath);
  }, [state.navigation.currentPath, state.startup.status]);

  const currentPath = state.navigation.currentPath;
  useEffect(() => {
    // Memory/Tools pages are not always wrapped by AppFrame; keep the product tour mounted at router level.
    const step = readWorkspaceGuidanceOverlay(typeof window === "undefined" ? undefined : window.sessionStorage);
    setWorkspaceGuidanceStep(step);
    if (step === "nickname") {
      setDeferredNickname((current) => current || randomNickname(language));
    }
  }, [currentPath, language, state.startup.status]);

  useEffect(() => {
    if (!analyticsReady) return;
    if (currentPath === prevPathRef.current) return;
    const referrer = prevPathRef.current;
    prevPathRef.current = currentPath;
    if (shouldDeferRoutePageView(currentPath)) {
      return;
    }

    track(buildRoutePageViewEvent(currentPath, referrer));
  }, [currentPath, track, analyticsReady]);

  function dismissProductTour(result: ProductTourDismissResult, info: ProductTourStepInfo) {
    const storage = typeof window === "undefined" ? undefined : window.sessionStorage;
    const scanPermission = state.bootstrap?.onboarding.scanPermission;
    // Intermediate steps only emit viewed. Skip adds one skipped on the current step;
    // finishing the last CTA does not emit completed (nickname / onboarding_completed mark done).
    if (result === "skipped") {
      const tourEvent = buildProductTourStepEvent({
        tab: info.tourTab,
        choice: "skipped",
        scanPermission
      });
      if (tourEvent) {
        track(tourEvent);
      }
    }
    clearProductTourStep(storage);
    // Persist nickname step before navigating so the path-change effect does not
    // re-read stale `product_tour` and remount the tour on /tools.
    writeDeferredGuidanceStep(storage, "nickname");
    setDeferredNickname(randomNickname(language));
    setWorkspaceGuidanceStep("nickname");
    dispatch(appActions.navigate("/main"));
  }

  function submitDeferredNickname() {
    void persistNickname({
      rawNickname: deferredNickname,
      language,
      isByok: state.bootstrap?.app.userMode === "byok",
      storage: typeof window === "undefined" ? undefined : window.localStorage,
      current: state.account,
      updateProfile: (nickname) => clients?.account.updateProfile({ nickname }) ?? Promise.resolve(null)
    }).then((update) => dispatch(appActions.accountUpdated(update)));
    const scanPermission = state.bootstrap?.onboarding.scanPermission;
    track(buildOnboardingStepCompletedEvent({
      step: "nickname",
      scanPermission
    }));
    // Full product guidance finished (permission → report? → tour → nickname).
    track(buildOnboardingCompletedEvent(scanPermission));
    writeGuidanceCompleted(typeof window === "undefined" ? undefined : window.localStorage);
    clearDeferredGuidanceStep(typeof window === "undefined" ? undefined : window.sessionStorage);
    setWorkspaceGuidanceStep(null);
  }

  if (state.startup.status === "loading" || state.startup.status === "idle") {
    return (
      <>
        <StartupScreen quiet={hasReloadRestoreRoute()} />
        {windowDragRegion}
      </>
    );
  }

  if (state.startup.status === "error") {
    return (
      <>
        <StartupScreen message={state.startup.message} onRetry={props.onRetry} />
        {windowDragRegion}
      </>
    );
  }

  return (
    <>
      {renderRoute(state.navigation.currentPath)}
      {windowDragRegion}
      {workspaceGuidanceStep === "product_tour" && (
        <ProductTourGuide
          includeLogs={productTourIncludesLogs(state.bootstrap?.onboarding.scanPermission)}
          onDismiss={dismissProductTour}
          onStepViewed={(info) => {
            const tourEvent = buildProductTourStepEvent({
              tab: info.tourTab,
              choice: "viewed",
              scanPermission: state.bootstrap?.onboarding.scanPermission
            });
            if (tourEvent) {
              track(tourEvent);
            }
          }}
          onTabChange={(tab: ProductTourTab) => {
            const memorySubPage = productTourMemorySubPage(tab);
            if (memorySubPage) {
              writeMemorySubPage(typeof window === "undefined" ? undefined : window.sessionStorage, memorySubPage);
            }
            dispatch(appActions.navigate(productTourTabRoute(tab)));
          }}
        />
      )}
      {workspaceGuidanceStep === "nickname" && (
        <NicknameModal
          open
          nickname={deferredNickname}
          onNicknameChange={setDeferredNickname}
          onShuffle={() => setDeferredNickname(randomNickname(language))}
          onSubmit={submitDeferredNickname}
        />
      )}
      {petGuideRequest && <PetGuideModal onChoice={handlePetGuideChoice} />}
      <GlobalUpdateDialog
        suspended={
          isPetWindowContext
          || Boolean(petGuideRequest)
          || workspaceGuidanceStep === "product_tour"
          || workspaceGuidanceStep === "nickname"
        }
      />
    </>
  );
}

function WindowDragRegion() {
  return (
    <>
      <div aria-hidden="true" className="window-drag-region" />
      <div aria-hidden="true" className="window-drag-exclusion window-drag-exclusion--sidebar-toggle" />
      <div aria-hidden="true" className="window-drag-exclusion window-drag-exclusion--lang-toggle" />
    </>
  );
}

/** Checks is pet window. */
function isPetWindow(path: AppRoutePath): boolean {
  const launchModeOverride = readLaunchModeOverride(typeof window === "undefined" ? undefined : window.location.search);
  return launchModeOverride === "pet" || path === "/pet";
}

export function resolveMainWindowActionRoute(path: AppRoutePath): MainWindowActionRoute {
  switch (path) {
    case "/welcome":
    case "/login":
      return "login";
    case "/token-detail":
    case "/api-key":
    case "/api-key-models":
    case "/api-key-optional":
    case "/onboarding":
      return "auth";
    default:
      return "workspace";
  }
}

function hasReloadRestoreRoute(): boolean {
  return Boolean(readCurrentRoute(typeof window === "undefined" ? undefined : window.sessionStorage));
}

/** Renders render route. */
function renderRoute(path: AppRoutePath) {
  switch (path) {
    case "/token-detail":
      return <TokenDetailPage />;
    case "/login":
      return <LoginPage />;
    case "/api-key":
      return <ApiKeyPage />;
    case "/api-key-models":
      return <ModelPage />;
    case "/api-key-optional":
      return <ApiKeyOptionalPage />;
    case "/onboarding":
      return <OnboardingPage />;
    case "/tools":
      return <ToolsPage />;
    case "/memory":
      return <MemoryPage />;
    case "/memory-sources":
      return <MemoryPage initialSubPage="sources" />;
    case "/settings":
      return <SettingsPage />;
    case "/pet":
      return <PetPage />;
    case "/main":
      return <HomePage />;
    case "/welcome":
    default:
      return <WelcomePage />;
  }
}

/** Handles resolve product tour path. */
export function resolveProductTourPath(tab: ProductTourTab): AppRoutePath {
  return productTourTabRoute(tab);
}
