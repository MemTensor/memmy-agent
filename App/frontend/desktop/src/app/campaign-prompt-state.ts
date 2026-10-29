/** Local persistence and eligibility for the Mid-Autumn campaign prompt. */
import type { LotteryStatus, UserMode } from "@memmy/local-api-contracts";

/** Build-time safety switch layered on top of the remote campaign status. */
export const CAMPAIGN_PROMPT_ENABLED = true;

export const CAMPAIGN_PROMPT_STORAGE_KEY = "memmy.campaignPrompt.v1";
export const CAMPAIGN_PROMPT_MAX_SHOWS = 1;

export interface CampaignPromptPersistedState {
  showCount: number;
  dismissedAt: number | null;
  actioned: boolean;
}

const EMPTY_STATE: CampaignPromptPersistedState = {
  showCount: 0,
  dismissedAt: null,
  actioned: false
};

let campaignPromptOpen = false;

/** Whether the campaign prompt is currently on screen (hides the GitHub star card). */
export function isCampaignPromptOpen(): boolean {
  return campaignPromptOpen;
}

/** Records whether the campaign prompt is currently rendered. */
export function setCampaignPromptOpen(open: boolean): void {
  campaignPromptOpen = open;
}

/** Reads persisted campaign prompt state from storage. */
export function readCampaignPromptState(storage: Storage | undefined): CampaignPromptPersistedState {
  if (!storage) {
    return { ...EMPTY_STATE };
  }
  try {
    const raw = storage.getItem(CAMPAIGN_PROMPT_STORAGE_KEY);
    if (!raw) {
      return { ...EMPTY_STATE };
    }
    const parsed = JSON.parse(raw) as Partial<CampaignPromptPersistedState>;
    return {
      showCount: typeof parsed.showCount === "number" && parsed.showCount >= 0 ? Math.floor(parsed.showCount) : 0,
      dismissedAt: typeof parsed.dismissedAt === "number" ? parsed.dismissedAt : null,
      actioned: parsed.actioned === true
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

/** Writes persisted campaign prompt state to storage. */
export function writeCampaignPromptState(
  storage: Storage | undefined,
  state: CampaignPromptPersistedState
): void {
  if (!storage) {
    return;
  }
  storage.setItem(CAMPAIGN_PROMPT_STORAGE_KEY, JSON.stringify(state));
}

/** Whether the campaign prompt may be offered on this app open. */
export function shouldOfferCampaignPrompt(
  state: CampaignPromptPersistedState,
  remoteStatus: LotteryStatus | null | undefined
): boolean {
  if (!CAMPAIGN_PROMPT_ENABLED) {
    return false;
  }
  if (!remoteStatus?.shouldShow) {
    return false;
  }
  if (remoteStatus.serverNow < remoteStatus.startAt || remoteStatus.serverNow >= remoteStatus.endAt) {
    return false;
  }
  if (state.actioned) {
    return false;
  }
  if (state.showCount >= CAMPAIGN_PROMPT_MAX_SHOWS) {
    return false;
  }
  return true;
}

const CAMPAIGN_PROMPT_WORKSPACE_PATHS = new Set([
  "/main",
  "/memory",
  "/memory-sources",
  "/knowledge",
  "/tools",
  "/settings"
]);

/** Account needs a signed-in user. BYOK needs a saved Agent model. Both wait until guidance has settled. */
export function isCampaignPromptSessionReady(input: {
  userMode: UserMode | null | undefined;
  accountUserId: string | null | undefined;
  byokConfigured?: boolean;
  guidanceDone?: boolean;
}): boolean {
  if (input.guidanceDone !== true) {
    return false;
  }
  if (input.userMode === "byok") {
    return input.byokConfigured === true;
  }
  return input.userMode === "account" && Boolean(input.accountUserId);
}

/** Guidance has settled when no deferred step is showing, and this machine finished the guide or onboarding is already complete. */
export function isGuidanceDone(input: {
  guidanceCompleted: boolean;
  onboardingCompleted: boolean;
  deferredGuidanceStep: string | null;
}): boolean {
  if (input.deferredGuidanceStep != null) {
    return false;
  }
  if (input.guidanceCompleted) {
    return true;
  }
  return input.onboardingCompleted;
}

/** Workspace routes that can show the campaign prompt after boot. Setup, login, onboarding, and the pet window wait. */
export function isCampaignPromptSurfaceReady(input: {
  startupStatus: string;
  currentPath: string;
}): boolean {
  return input.startupStatus === "ready" && CAMPAIGN_PROMPT_WORKSPACE_PATHS.has(input.currentPath);
}

/** Records that the prompt was shown (counts toward the max of 1). */
export function markCampaignPromptShown(storage: Storage | undefined): CampaignPromptPersistedState {
  const current = readCampaignPromptState(storage);
  const next: CampaignPromptPersistedState = {
    ...current,
    showCount: current.showCount + 1,
    dismissedAt: null
  };
  writeCampaignPromptState(storage, next);
  return next;
}

/** Records "maybe later". With a one-show cap, this does not reopen later. */
export function markCampaignPromptDismissed(
  storage: Storage | undefined,
  nowMs: number = Date.now()
): CampaignPromptPersistedState {
  const current = readCampaignPromptState(storage);
  const next: CampaignPromptPersistedState = {
    ...current,
    dismissedAt: nowMs
  };
  writeCampaignPromptState(storage, next);
  return next;
}

/** Records that the user opened the activity site — never show again. */
export function markCampaignPromptActioned(storage: Storage | undefined): CampaignPromptPersistedState {
  const current = readCampaignPromptState(storage);
  const next: CampaignPromptPersistedState = {
    ...current,
    actioned: true,
    dismissedAt: null
  };
  writeCampaignPromptState(storage, next);
  return next;
}
