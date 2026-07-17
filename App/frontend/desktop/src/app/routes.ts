/** Routes module. */
import type { AccountSessionView, AppBootstrapResponse, DefaultLaunchMode, LastLaunchMode, OnboardingStateDto, OnboardingStep } from "@memmy/local-api-contracts";

/** Type definition for preferred mode. */
export type PreferredMode = "full" | "pet" | "last";

/** Type definition for app route path. */
export type AppRoutePath =
  | "/welcome"
  | "/token-detail"
  | "/login"
  | "/api-key"
  | "/api-key-models"
  | "/api-key-optional"
  | "/onboarding"
  | "/main"
  | "/pet"
  | "/tools"
  | "/memory"
  | "/memory-sources"
  | "/settings";

const CURRENT_ROUTE_STORAGE_KEY = "memmy.currentRoute";
export const FOCUSED_AGENT_CHAT_STORAGE_KEY = "memmy.focusSessionId";
/** Definition for token exhausted dismissed storage key. */
const TOKEN_EXHAUSTED_DISMISSED_STORAGE_KEY = "memmy.tokenExhaustedDismissed";
const DEFERRED_IMPROVEMENT_PENDING_STORAGE_KEY = "memmy.deferredImprovementPending";
const AGENT_CHAT_ID_PATTERN = /^[A-Za-z0-9_:-]{1,128}$/;
const ROUTE_HASH_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

interface FocusStorageLike {
  removeItem?: (key: string) => void;
  setItem: (key: string, value: string) => void;
}

/** Contract for app route definition. */
export interface AppRouteDefinition {
  path: AppRoutePath;
  navKey: string;
  requiresBootstrap: boolean;
}

/** Routes module. */
export const routeTable: Record<AppRoutePath, AppRouteDefinition> = {
  "/welcome": { path: "/welcome", navKey: "nav.welcome", requiresBootstrap: false },
  "/token-detail": { path: "/token-detail", navKey: "welcome.gift.detail.title", requiresBootstrap: true },
  "/login": { path: "/login", navKey: "nav.login", requiresBootstrap: true },
  "/api-key": { path: "/api-key", navKey: "nav.apiKey", requiresBootstrap: true },
  "/api-key-models": { path: "/api-key-models", navKey: "nav.apiKeyModels", requiresBootstrap: true },
  "/api-key-optional": { path: "/api-key-optional", navKey: "nav.apiKeyOptional", requiresBootstrap: true },
  "/onboarding": { path: "/onboarding", navKey: "nav.onboarding", requiresBootstrap: true },
  "/main": { path: "/main", navKey: "nav.chat", requiresBootstrap: true },
  "/pet": { path: "/pet", navKey: "nav.pet", requiresBootstrap: true },
  "/tools": { path: "/tools", navKey: "nav.tools", requiresBootstrap: true },
  "/memory": { path: "/memory", navKey: "nav.memory", requiresBootstrap: true },
  "/memory-sources": { path: "/memory-sources", navKey: "nav.memory", requiresBootstrap: true },
  "/settings": { path: "/settings", navKey: "nav.settings", requiresBootstrap: true }
};

/** Contract for resolve initial view input. */
export interface ResolveInitialViewInput {
  bootstrap: AppBootstrapResponse;
  preferredMode: PreferredMode | null;
  accountSession?: AccountSessionView;
  guidanceCompleted?: boolean;
}

/** Contract for pet launch guard input. */
export interface PetLaunchGuardInput {
  launchModeOverride: PreferredMode | null;
  petIntent?: "user" | null;
  initialPath: AppRoutePath;
}

/** Contract for resolve post login route input. */
export interface ResolvePostLoginRouteInput {
  onboarding: OnboardingStateDto;
  preferredMode: PreferredMode | null;
}

/** Contract for resolve byok model completion input. */
export interface ResolveByokModelCompletionInput {
  onboarding: OnboardingStateDto;
}

/** Contract for resolve byok model completion result. */
export interface ResolveByokModelCompletionResult {
  onboardingPatch?: OnboardingStateDto;
  nextRoute: AppRoutePath;
}

/** Contract for reconcile initial onboarding input. */
export interface ReconcileInitialOnboardingInput {
  bootstrap: AppBootstrapResponse;
  accountSession?: AccountSessionView;
}

/** Contract for resolve launch initial view input. */
export interface ResolveLaunchInitialViewInput {
  defaultPath: AppRoutePath;
  currentRoute: AppRoutePath | null;
  launchRouteOverride: AppRoutePath | null;
  launchModeOverride: PreferredMode | null;
  petIntent?: "user" | null;
}

/** Contract for main window route target. */
export interface MainWindowRouteTarget {
  route?: string | null;
  hash?: string | null;
  agentChatId?: string | null;
}

/** Contract for resolved main window route target. */
export interface ResolvedMainWindowRouteTarget {
  route: AppRoutePath | null;
  hash: string | null;
  agentChatId: string | null;
}

/** Handles resolve initial view. */
export function resolveInitialView(input: ResolveInitialViewInput): AppRoutePath {
  if (input.bootstrap.app.userMode === "account") {
    if (!input.accountSession?.authenticated) {
      return "/welcome";
    }

    if (hasCompletedAccountGuide(input.accountSession) || input.guidanceCompleted) {
      return input.preferredMode === "pet" ? "/pet" : "/main";
    }

    return resolveOnboardingStep(input.bootstrap.onboarding.currentStep);
  }

  if (input.bootstrap.app.userMode === "byok") {
    if (input.bootstrap.onboarding.completed) {
      return input.preferredMode === "pet" ? "/pet" : "/main";
    }

    return resolveOnboardingStep(input.bootstrap.onboarding.currentStep);
  }

  return "/welcome";
}

/** Checks has completed account guide. */
function hasCompletedAccountGuide(session: AccountSessionView | undefined): boolean {
  return Boolean(session?.authenticated && session.profile.hasFinishedGuide);
}

/** Handles reconcile initial onboarding. */
export function reconcileInitialOnboarding(input: ReconcileInitialOnboardingInput): AppBootstrapResponse {
  if (
    input.bootstrap.app.userMode !== "account" ||
    !input.accountSession?.authenticated ||
    hasCompletedAccountGuide(input.accountSession) ||
    !input.bootstrap.onboarding.completed
  ) {
    return input.bootstrap;
  }

  return {
    ...input.bootstrap,
    onboarding: {
      ...input.bootstrap.onboarding,
      ...buildAccountOnboardingStartPatch()
    }
  };
}

/** Checks should exit pet launch for route. */
export function shouldExitPetLaunchForRoute(input: PetLaunchGuardInput): boolean {
  return input.launchModeOverride === "pet" && input.initialPath !== "/pet";
}

/** Checks should show token exhausted modal. */
export function shouldShowTokenExhaustedModal(bootstrap: AppBootstrapResponse | null | undefined): boolean {
  return Boolean(bootstrap && bootstrap.app.userMode === "account" && bootstrap.tokenUsage.remainingTokens === 0);
}

/** Handles resolve post login route. */
export function resolvePostLoginRoute(input: ResolvePostLoginRouteInput): AppRoutePath {
  if (!input.onboarding.completed) {
    return resolveOnboardingStep(input.onboarding.currentStep);
  }

  return resolvePostOnboardingRoute(input.preferredMode ?? "full");
}

/** Handles resolve byok model completion. */
export function resolveByokModelCompletion(input: ResolveByokModelCompletionInput): ResolveByokModelCompletionResult {
  if (input.onboarding.completed) {
    return {
      onboardingPatch: undefined,
      nextRoute: "/main"
    };
  }

  return {
    onboardingPatch: buildByokOnboardingGuidePatch(),
    nextRoute: "/onboarding"
  };
}

/** Contract for resolve byok entry input. */
export interface ResolveByokEntryInput {
  onboarding: OnboardingStateDto | undefined;
}

/** Contract for resolve byok entry result. */
export interface ResolveByokEntryResult {
  onboardingPatch?: OnboardingStateDto;
  nextRoute: AppRoutePath;
}

/** Handles resolve byok entry. */
export function resolveByokEntry(input: ResolveByokEntryInput): ResolveByokEntryResult {
  if (input.onboarding?.completed) {
    return {
      onboardingPatch: undefined,
      nextRoute: "/api-key"
    };
  }

  return {
    onboardingPatch: buildByokOnboardingSetupPatch(),
    nextRoute: "/api-key"
  };
}

/** Handles resolve onboarding step. */
function resolveOnboardingStep(step: OnboardingStep): AppRoutePath {
  switch (step) {
    case "byok_setup_required":
      return "/api-key";
    case "account_auth_required":
      return "/login";
    case "scan_permission_required":
    case "improvement_program_required":
    case "product_tour_required":
      return "/onboarding";
    case "completed":
      return "/main";
    default:
      return "/welcome";
  }
}

/** Handles resolve preferred launch mode. */
export function resolvePreferredLaunchMode(input: {
  defaultLaunchMode: DefaultLaunchMode;
  lastLaunchMode: LastLaunchMode;
}): LastLaunchMode {
  if (input.defaultLaunchMode === "pet") {
    return "pet";
  }
  if (input.defaultLaunchMode === "full") {
    return "full";
  }
  return input.lastLaunchMode;
}

/** Reads read preferred mode. */
export function readPreferredMode(storage: Storage | undefined): PreferredMode | null {
  const value = storage?.getItem("memmy.preferredMode") ?? null;
  return value === "full" || value === "pet" || value === "last" ? value : null;
}

/** Reads read launch mode override. */
export function readLaunchModeOverride(search: string | undefined): PreferredMode | null {
  if (!search) {
    return null;
  }

  const value = new URLSearchParams(search).get("memmyMode");
  return value === "full" || value === "pet" || value === "last" ? value : null;
}

export function readPetIntentOverride(search: string | undefined): "user" | null {
  if (!search) {
    return null;
  }

  return new URLSearchParams(search).get("memmyPetIntent") === "user" ? "user" : null;
}

export function readLaunchRouteOverride(search: string | undefined): AppRoutePath | null {
  if (!search) {
    return null;
  }

  const value = new URLSearchParams(search).get("memmyRoute");
  return isAppRoutePath(value) ? value : null;
}

export function readLaunchAgentChatId(search: string | undefined): string | null {
  if (!search) {
    return null;
  }

  return normalizeAgentChatId(new URLSearchParams(search).get("memmyAgentChat"));
}

export function resolveMainWindowRouteTarget(target: MainWindowRouteTarget | null | undefined): ResolvedMainWindowRouteTarget {
  const rawRoute = target?.route ?? null;
  const route = rawRoute && rawRoute in routeTable && rawRoute !== "/pet" ? rawRoute as AppRoutePath : null;
  const hash = typeof target?.hash === "string" && ROUTE_HASH_PATTERN.test(target.hash) ? target.hash : null;

  return {
    route,
    hash,
    agentChatId: route === "/main" ? normalizeAgentChatId(target?.agentChatId) : null
  };
}

export function removeLaunchAgentChatIdFromUrl(
  locationLike: Pick<Location, "href">,
  historyLike: Pick<History, "replaceState" | "state">
): void {
  const url = new URL(locationLike.href);
  if (!url.searchParams.has("memmyAgentChat")) {
    return;
  }

  url.searchParams.delete("memmyAgentChat");
  historyLike.replaceState(historyLike.state, "", `${url.pathname}${url.search}${url.hash}`);
}

export function clearFocusedAgentTarget(
  storage: FocusStorageLike | undefined,
  locationLike?: Pick<Location, "href">,
  historyLike?: Pick<History, "replaceState" | "state">
): void {
  try {
    if (storage?.removeItem) {
      storage.removeItem(FOCUSED_AGENT_CHAT_STORAGE_KEY);
    } else {
      storage?.setItem(FOCUSED_AGENT_CHAT_STORAGE_KEY, "");
    }
  } catch {
    // Losing a focus hint is non-fatal; explicit navigation should continue.
  }

  if (!locationLike || !historyLike) {
    return;
  }

  try {
    removeLaunchAgentChatIdFromUrl(locationLike, historyLike);
  } catch {
    // URL cleanup should not block route navigation.
  }
}

export function normalizeAgentChatId(value: string | null | undefined): string | null {
  const cleaned = value?.trim() ?? "";
  return AGENT_CHAT_ID_PATTERN.test(cleaned) ? cleaned : null;
}

export function readCurrentRoute(storage: Storage | undefined): AppRoutePath | null {
  const value = storage?.getItem(CURRENT_ROUTE_STORAGE_KEY) ?? null;
  return isAppRoutePath(value) ? value : null;
}

export function writeCurrentRoute(storage: Storage | undefined, path: AppRoutePath): void {
  storage?.setItem(CURRENT_ROUTE_STORAGE_KEY, path);
}

/**
 * Reads whether the trial-quota dialog was dismissed via "remind me later" within the current run.
 *
 * @param storage sessionStorage (persists across window reloads, cleared on app restart).
 * @returns true if already dismissed.
 */
export function readTokenExhaustedDismissed(storage: Storage | undefined): boolean {
  return storage?.getItem(TOKEN_EXHAUSTED_DISMISSED_STORAGE_KEY) === "1";
}

/**
 * Marks the trial-quota dialog as dismissed via "remind me later"; it won't reappear during this run and only resets on restart.
 *
 * @param storage sessionStorage.
 */
export function writeTokenExhaustedDismissed(storage: Storage | undefined): void {
  storage?.setItem(TOKEN_EXHAUSTED_DISMISSED_STORAGE_KEY, "1");
}

export interface GiftTokenUsage {
  /** Used percentage (integer 0-100). */
  usagePercent: number;
  /** Whether the balance is low (>=80% used, or quota exhausted); drives the "request more" button. */
  isTokenLow: boolean;
}

/**
 * Computes the trial-quota usage percentage and low-balance flag.
 *
 * usagePercent reflects the real progress-bar ratio only: when total<=0 (no quota / uninitialized)
 * the ratio is unknown and stays 0, so the bar never falsely shows as full. The low-balance /
 * "request more" state is triggered by remaining<=0 (covering "zero remaining from the start" and
 * exhaustion), independent of the percentage threshold.
 *
 * @param usedTokens consumed tokens.
 * @param totalTokens total quota tokens.
 * @param remainingTokens remaining quota tokens.
 * @returns usage percentage and low-balance flag.
 */
export function resolveGiftTokenUsage(usedTokens: number, totalTokens: number, remainingTokens: number): GiftTokenUsage {
  const usagePercent = totalTokens > 0 ? Math.min(100, Math.round((usedTokens / totalTokens) * 100)) : 0;
  const isTokenLow = remainingTokens <= 0 || usagePercent >= 80;
  return { usagePercent, isTokenLow };
}

// Current step of the home-page Deferred Guidance Sequence (DGS): switching pages triggers a reload that clears component state, so it's persisted to sessionStorage across reloads.
const DEFERRED_GUIDANCE_STEP_STORAGE_KEY = "memmy.deferredGuidanceStep";

/**
 * Deferred guidance sequence step.
 * - armed: armed and waiting for the first sidebar interaction to trigger it;
 * - improvement/product_tour/nickname: the step currently being shown.
 */
export type DeferredGuidanceStep = "armed" | "improvement" | "product_tour" | "nickname";

/**
 * Reads the current step of the deferred guidance sequence.
 *
 * @param storage sessionStorage (persists across window reloads, cleared on app restart).
 * @returns the current step; null if not armed or already finished.
 */
export function readDeferredGuidanceStep(storage: Storage | undefined): DeferredGuidanceStep | null {
  const value = storage?.getItem(DEFERRED_GUIDANCE_STEP_STORAGE_KEY);
  return value === "armed" || value === "improvement" || value === "product_tour" || value === "nickname" ? value : null;
}

/**
 * Writes the current step of the deferred guidance sequence.
 *
 * @param storage sessionStorage.
 * @param step target step.
 */
export function writeDeferredGuidanceStep(storage: Storage | undefined, step: DeferredGuidanceStep): void {
  storage?.setItem(DEFERRED_GUIDANCE_STEP_STORAGE_KEY, step);
}

/**
 * Clears the deferred guidance sequence step (sequence finished).
 *
 * @param storage sessionStorage.
 */
export function clearDeferredGuidanceStep(storage: Storage | undefined): void {
  storage?.removeItem(DEFERRED_GUIDANCE_STEP_STORAGE_KEY);
}

// Machine-level "guidance completed" marker: the full onboarding (scan permission -> improvement program -> product tour -> nickname)
// runs only once per machine, regardless of user mode (account/BYOK) or which account. Hence localStorage (shared across restarts and modes/accounts)
// records the completed state, rather than the per-account cloud hasFinishedGuide or the per-bootstrap onboarding.currentStep.
// Typical scenario: after finishing onboarding in account mode, the user "signs out -> switches to their own API"; the machine has completed onboarding, so no guidance (scan permission, etc.) should appear again.
const GUIDANCE_COMPLETED_STORAGE_KEY = "memmy.guidanceCompleted";

/**
 * Reads whether onboarding has been completed on this machine.
 *
 * @param storage localStorage (machine-level, persists across modes/accounts/restarts).
 * @returns true if this machine has completed onboarding, meaning no guidance should appear again in any mode/account.
 */
export function readGuidanceCompleted(storage: Storage | undefined): boolean {
  return storage?.getItem(GUIDANCE_COMPLETED_STORAGE_KEY) === "1";
}

/**
 * Marks onboarding as completed on this machine (called at the final step of the guidance sequence).
 *
 * @param storage localStorage.
 */
export function writeGuidanceCompleted(storage: Storage | undefined): void {
  storage?.setItem(GUIDANCE_COMPLETED_STORAGE_KEY, "1");
}

// Current product-tour step index: the tour overlay is mounted inside AppFrame, and advancing the tour to the tools step navigates to /tools, which remounts AppFrame
// and clears component state. If the step lived only in component useState, the remount would reset it to step 0 (memory), causing it to bounce back and forth between memory and tools
// and never reach the tools step. Hence the step index is persisted to sessionStorage and read back to resume after a remount/reload.
const PRODUCT_TOUR_STEP_STORAGE_KEY = "memmy.productTourStep";

/**
 * Reads the current product-tour step index.
 *
 * @param storage sessionStorage.
 * @returns a non-negative integer step index; null if not started or the value is invalid.
 */
export function readProductTourStep(storage: Storage | undefined): number | null {
  const raw = storage?.getItem(PRODUCT_TOUR_STEP_STORAGE_KEY);
  if (raw == null) {
    return null;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value >= 0 && String(value) === raw ? value : null;
}

/**
 * Writes the current product-tour step index.
 *
 * @param storage sessionStorage.
 * @param step target step index.
 */
export function writeProductTourStep(storage: Storage | undefined, step: number): void {
  storage?.setItem(PRODUCT_TOUR_STEP_STORAGE_KEY, String(step));
}

/**
 * Clears the product-tour step index (tour finished or not started).
 *
 * @param storage sessionStorage.
 */
export function clearProductTourStep(storage: Storage | undefined): void {
  storage?.removeItem(PRODUCT_TOUR_STEP_STORAGE_KEY);
}

/**
 * Reads the "improvement program deferred dialog pending" marker.
 *
 * The user sets this marker the first time they switch left-side features on the home page; because switching pages triggers a full-window reload that clears component state,
 * the marker must be persisted to sessionStorage across reloads, then read back and shown when AppFrame mounts after the reload.
 *
 * @param storage sessionStorage (persists across window reloads, cleared on app restart).
 * @returns true if pending.
 */
export function readDeferredImprovementPending(storage: Storage | undefined): boolean {
  return storage?.getItem(DEFERRED_IMPROVEMENT_PENDING_STORAGE_KEY) === "1";
}

/**
 * Writes the "improvement program deferred dialog pending" marker, so it still shows after a reload.
 *
 * @param storage sessionStorage.
 */
export function writeDeferredImprovementPending(storage: Storage | undefined): void {
  storage?.setItem(DEFERRED_IMPROVEMENT_PENDING_STORAGE_KEY, "1");
}

/**
 * Clears the "improvement program deferred dialog pending" marker (after the user has made a choice).
 *
 * @param storage sessionStorage.
 */
export function clearDeferredImprovementPending(storage: Storage | undefined): void {
  storage?.removeItem(DEFERRED_IMPROVEMENT_PENDING_STORAGE_KEY);
}

const NICKNAME_DEFERRED_STORAGE_KEY = "memmy.nicknameDeferred";

/**
 * Marks that a new user's nickname setup is deferred until after onboarding completes.
 *
 * @param storage sessionStorage.
 */
export function writeNicknameDeferred(storage: Storage | undefined): void {
  storage?.setItem(NICKNAME_DEFERRED_STORAGE_KEY, "1");
}

/**
 * Reads whether nickname setup has been deferred.
 *
 * @param storage sessionStorage.
 * @returns true if deferred.
 */
export function readNicknameDeferred(storage: Storage | undefined): boolean {
  return storage?.getItem(NICKNAME_DEFERRED_STORAGE_KEY) === "1";
}

/**
 * Clears the nickname-deferred marker.
 *
 * @param storage sessionStorage.
 */
export function clearNicknameDeferred(storage: Storage | undefined): void {
  storage?.removeItem(NICKNAME_DEFERRED_STORAGE_KEY);
}

export function resolveReloadedInitialView(defaultPath: AppRoutePath, currentPath: AppRoutePath | null): AppRoutePath {
  if (!currentPath || !isRestorableRoute(currentPath) || !isPostOnboardingRoute(defaultPath)) {
    return defaultPath;
  }

  if (currentPath === "/pet" && defaultPath !== "/pet") {
    return defaultPath;
  }

  return currentPath;
}

/**
 * Resolves the final initial view after Electron launch, local restore, and the onboarding guard.
 *
 * @param input default initial view, URL override, and session-restore route.
 * @returns the final route, which never bypasses incomplete onboarding.
 */
export function resolveLaunchInitialView(input: ResolveLaunchInitialViewInput): AppRoutePath {
  if (input.launchModeOverride === "pet") {
    if (input.petIntent === "user" && isLoginEntryRoute(input.defaultPath)) {
      return "/pet";
    }

    if (!isPostOnboardingRoute(input.defaultPath)) {
      return input.defaultPath;
    }

    return input.petIntent === "user" ? "/pet" : input.defaultPath;
  }

  if (!isPostOnboardingRoute(input.defaultPath)) {
    return input.defaultPath;
  }

  return input.launchRouteOverride ?? resolveReloadedInitialView(input.defaultPath, input.currentRoute);
}

function isLoginEntryRoute(path: AppRoutePath): boolean {
  return path === "/welcome" || path === "/login";
}

function isAppRoutePath(value: string | null): value is AppRoutePath {
  return Boolean(value && value in routeTable);
}

function isRestorableRoute(path: AppRoutePath): boolean {
  return path === "/main" || path === "/pet" || path === "/tools" || path === "/memory" || path === "/memory-sources" || path === "/settings";
}

function isPostOnboardingRoute(path: AppRoutePath): boolean {
  return path === "/main" || path === "/pet";
}

/**
 * Builds the first-time onboarding completion patch.
 *
 * @param completedAt the time onboarding was first completed.
 * @returns the onboarding patch to persist to the local API.
 */
export function buildOnboardingCompletionPatch(completedAt: string): Partial<OnboardingStateDto> {
  return {
    completed: true,
    currentStep: "completed",
    completedAt
  };
}

/**
 * Builds the account-mode new-user onboarding start patch.
 *
 * @returns the local onboarding patch for the first-time flow after account registration.
 */
export function buildAccountOnboardingStartPatch(): OnboardingStateDto {
  return {
    completed: false,
    currentStep: "scan_permission_required",
    hasAcceptedTerms: true,
    acceptedTermsVersion: null,
    scanPermission: "unset",
    improvementProgram: "unset",
    completedAt: null
  };
}

/**
 * Builds the BYOK API Key configuration start patch.
 *
 * @returns the onboarding patch for the BYOK first-time flow before entering the API Key configuration page.
 */
export function buildByokOnboardingSetupPatch(): OnboardingStateDto {
  return {
    completed: false,
    currentStep: "byok_setup_required",
    hasAcceptedTerms: true,
    acceptedTermsVersion: null,
    scanPermission: "unset",
    improvementProgram: "not_applicable",
    completedAt: null
  };
}

/**
 * Builds the BYOK authorization and product-tour start patch.
 *
 * @returns the patch for entering `/onboarding` after BYOK model configuration completes.
 */
export function buildByokOnboardingGuidePatch(): OnboardingStateDto {
  return {
    ...buildByokOnboardingSetupPatch(),
    currentStep: "scan_permission_required"
  };
}

/**
 * Resolves the target route for the given launch-form preference.
 *
 * @param mode the default launch mode chosen by the user.
 * @returns the page to enter on launch or after onboarding completes.
 */
export function resolvePostOnboardingRoute(mode: PreferredMode): AppRoutePath {
  return mode === "pet" ? "/pet" : "/main";
}

/**
 * Writes the default launch mode.
 *
 * @param storage the browser storage object; may be empty when unavailable in a plain browser.
 * @param mode the launch mode chosen by the user.
 */
export function writePreferredMode(storage: Storage | undefined, mode: PreferredMode): void {
  storage?.setItem("memmy.preferredMode", mode);
}
