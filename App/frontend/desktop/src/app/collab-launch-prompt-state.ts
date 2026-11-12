/**
 * The one-time 1.2.7 project-collaboration announcement.
 *
 * The record lives on this computer instead of comparing versions: the code ships with 1.2.7, so both an update and a
 * fresh install see it for the first time and show the carousel once. A single run shows at most one large prompt,
 * and this announcement goes first.
 */
import type { UserMode } from "@memmy/local-api-contracts";

export const COLLAB_LAUNCH_PROMPT_STORAGE_KEY = "memmy.featureAnnouncement.v127-collab-projects";

let promptOpen = false;
let claimedThisRun = false;

/** Whether the announcement carousel is on screen right now. */
export function isCollabLaunchPromptOpen(): boolean {
  return promptOpen;
}

/** Whether this run already spent its one announcement slot (this prompt or a forced preview). */
export function hasCollabLaunchPromptClaimedThisRun(): boolean {
  return claimedThisRun;
}

/** Takes the run's one announcement slot, so the other large prompts wait for the next launch. */
export function claimCollabLaunchPrompt(): void {
  claimedThisRun = true;
}

/** Records whether the carousel is currently rendered. */
export function setCollabLaunchPromptOpen(open: boolean): void {
  promptOpen = open;
}

/** Test-only: forgets what this run did so one test does not leak into the next. */
export function resetCollabLaunchPromptRuntime(): void {
  promptOpen = false;
  claimedThisRun = false;
}

/** Whether this computer already saw the announcement. */
export function readCollabLaunchPromptSeen(storage: Storage | undefined): boolean {
  try {
    return storage?.getItem(COLLAB_LAUNCH_PROMPT_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Records the announcement as seen. Written while it opens (not when it closes), so a crash or a force quit does not
 * bring it back on the next launch.
 */
export function markCollabLaunchPromptSeen(storage: Storage | undefined): void {
  try {
    storage?.setItem(COLLAB_LAUNCH_PROMPT_STORAGE_KEY, "1");
  } catch {
    // A storage that refuses writes (private mode, quota) only costs one extra showing.
  }
}

/**
 * Whether the announcement may be offered now. Account mode with a signed-in user only: API Key mode has no cloud
 * projects, and an unset mode has not reached a workspace yet. Nothing is written when this returns false, so those
 * people still see it after switching to an account and signing in.
 */
export function shouldOfferCollabLaunchPrompt(input: {
  userMode: UserMode | null | undefined;
  accountUserId: string | null | undefined;
  guidanceDone: boolean;
  seen: boolean;
  otherPromptOpen: boolean;
}): boolean {
  if (input.userMode !== "account") return false;
  if (!input.accountUserId) return false;
  if (input.guidanceDone !== true) return false;
  if (input.seen) return false;
  if (input.otherPromptOpen) return false;
  return true;
}

const COLLAB_LAUNCH_SURFACE_PATHS = new Set([
  "/main",
  "/memory",
  "/memory-sources",
  "/knowledge",
  "/tools",
  "/settings",
  "/collab"
]);

/**
 * Workspace routes that can show the announcement once boot settles. Same set as the campaign prompt plus /collab,
 * which is the board the announcement itself leads into. Setup, login, onboarding and the pet window wait.
 */
export function isCollabLaunchSurfaceReady(input: {
  startupStatus: string;
  currentPath: string;
}): boolean {
  return input.startupStatus === "ready" && COLLAB_LAUNCH_SURFACE_PATHS.has(input.currentPath);
}
