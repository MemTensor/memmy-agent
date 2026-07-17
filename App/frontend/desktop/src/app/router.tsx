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
import { productTourTabRoute, type ProductTourTab } from "./product-tour.js";
import { GlobalUpdateDialog } from "./update-coordinator.js";
import { readCurrentRoute, readLaunchModeOverride, readTokenExhaustedDismissed, shouldShowTokenExhaustedModal, writeCurrentRoute, writeTokenExhaustedDismissed, type AppRoutePath } from "./routes.js";
import { emitTokenExhaustedApplyMoreRequest, writeTokenExhaustedApplyMoreRequest } from "./token-exhausted-apply-more.js";
import { useAppState } from "../state/app-state.js";
import { useAnalytics } from "../analytics/use-analytics.js";
import { buildRoutePageViewEvent, shouldDeferRoutePageView } from "../analytics/page-view.js";
import { appActions } from "../state/app-actions.js";
import { ApiKeyPage } from "../pages/api-key-page.js";
import { ApiKeyOptionalPage } from "../pages/api-key-optional-page.js";
import { ModelPage } from "../pages/model-page.js";
import { HomePage } from "../pages/home-page.js";
import { LoginPage } from "../pages/login-page.js";
import { MemoryPage } from "../pages/memory-page.js";
import { OnboardingPage } from "../pages/onboarding-page.js";
import { PetPage } from "../pages/pet-page.js";
import { SettingsPage } from "../pages/settings-page.js";
import { StartupScreen } from "../pages/startup-screen.js";
import { TokenDetailPage } from "../pages/token-detail-page.js";
import { TokenExhaustedModal } from "../pages/token-exhausted-modal.js";
import { ToolsPage } from "../pages/tools-page.js";
import { WelcomePage } from "../pages/welcome-page.js";
/** Handles app router. */
export function AppRouter(props: { onRetry: () => void }) {
  const { state, dispatch } = useAppState();
  const { track, ready: analyticsReady } = useAnalytics();
  const prevPathRef = useRef<AppRoutePath | null>(null);
  const [hasDismissedTokenExhaustedModal, setHasDismissedTokenExhaustedModal] = useState(() =>
    readTokenExhaustedDismissed(typeof window === "undefined" ? undefined : window.sessionStorage)
  );
  const dismissTokenExhaustedModal = useCallback(() => {
    writeTokenExhaustedDismissed(typeof window === "undefined" ? undefined : window.sessionStorage);
    setHasDismissedTokenExhaustedModal(true);
  }, []);
  const [petGuideRequest, setPetGuideRequest] = useState<MainWindowActionRequest | null>(null);
  const isPetWindowContext = isPetWindow(state.navigation.currentPath);
  const shouldShowTokenModal =
    shouldShowTokenExhaustedModal(state.bootstrap) && !isPetWindowContext;
  const tokenModalOpen = shouldShowTokenModal && !hasDismissedTokenExhaustedModal;
  const showApplyMoreInTokenModal = state.bootstrap?.promotions?.applyMore ?? true;
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
    if (!analyticsReady) return;
    if (currentPath === prevPathRef.current) return;
    const referrer = prevPathRef.current;
    prevPathRef.current = currentPath;
    if (shouldDeferRoutePageView(currentPath)) {
      return;
    }

    track(buildRoutePageViewEvent(currentPath, referrer));
  }, [currentPath, track, analyticsReady]);

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
      {petGuideRequest && <PetGuideModal onChoice={handlePetGuideChoice} />}
      {tokenModalOpen && (
        <TokenExhaustedModal
          showApplyMore={showApplyMoreInTokenModal}
          onApplyMore={() => {
            const storage = typeof window === "undefined" ? undefined : window.sessionStorage;
            writeTokenExhaustedApplyMoreRequest(storage);
            dismissTokenExhaustedModal();
            dispatch(appActions.navigate("/settings"));
            emitTokenExhaustedApplyMoreRequest(typeof window === "undefined" ? undefined : window);
            setTimeout(() => {
              document.getElementById("token-usage")?.scrollIntoView({ behavior: "smooth", block: "start" });
            }, 120);
          }}
          onLater={dismissTokenExhaustedModal}
          onGoHandle={() => {
            dismissTokenExhaustedModal();
            dispatch(appActions.navigate("/settings"));
            setTimeout(() => {
              document.getElementById("model-config")?.scrollIntoView({ behavior: "smooth", block: "start" });
            }, 120);
          }}
        />
      )}
      <GlobalUpdateDialog
        suspended={isPetWindowContext || Boolean(petGuideRequest) || tokenModalOpen}
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
