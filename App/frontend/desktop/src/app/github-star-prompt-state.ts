/** Local persistence and eligibility for the GitHub star prompt. */

/** MVP kill switch — set false to disable the prompt for everyone. */
export const GITHUB_STAR_PROMPT_ENABLED = true;

export const GITHUB_STAR_PROMPT_STORAGE_KEY = "memmy.githubStarPrompt.v1";
export const GITHUB_STAR_PROMPT_MAX_SHOWS = 3;
export const GITHUB_STAR_PROMPT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export interface GithubStarPromptPersistedState {
  showCount: number;
  dismissedAt: number | null;
  actioned: boolean;
}

const EMPTY_STATE: GithubStarPromptPersistedState = {
  showCount: 0,
  dismissedAt: null,
  actioned: false
};

/** Reads persisted GitHub star prompt state from storage. */
export function readGithubStarPromptState(storage: Storage | undefined): GithubStarPromptPersistedState {
  if (!storage) {
    return { ...EMPTY_STATE };
  }
  try {
    const raw = storage.getItem(GITHUB_STAR_PROMPT_STORAGE_KEY);
    if (!raw) {
      return { ...EMPTY_STATE };
    }
    const parsed = JSON.parse(raw) as Partial<GithubStarPromptPersistedState>;
    return {
      showCount: typeof parsed.showCount === "number" && parsed.showCount >= 0 ? Math.floor(parsed.showCount) : 0,
      dismissedAt: typeof parsed.dismissedAt === "number" ? parsed.dismissedAt : null,
      actioned: parsed.actioned === true
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

/** Writes persisted GitHub star prompt state to storage. */
export function writeGithubStarPromptState(
  storage: Storage | undefined,
  state: GithubStarPromptPersistedState
): void {
  if (!storage) {
    return;
  }
  storage.setItem(GITHUB_STAR_PROMPT_STORAGE_KEY, JSON.stringify(state));
}

/** Whether the prompt may be offered after a completed agent turn. */
export function shouldOfferGithubStarPrompt(
  state: GithubStarPromptPersistedState,
  nowMs: number = Date.now()
): boolean {
  if (!GITHUB_STAR_PROMPT_ENABLED) {
    return false;
  }
  if (state.actioned) {
    return false;
  }
  if (state.showCount >= GITHUB_STAR_PROMPT_MAX_SHOWS) {
    return false;
  }
  if (state.dismissedAt != null && nowMs - state.dismissedAt < GITHUB_STAR_PROMPT_COOLDOWN_MS) {
    return false;
  }
  return true;
}

/** Records that the prompt was shown (counts toward the max of 3). */
export function markGithubStarPromptShown(storage: Storage | undefined): GithubStarPromptPersistedState {
  const current = readGithubStarPromptState(storage);
  const next: GithubStarPromptPersistedState = {
    ...current,
    showCount: current.showCount + 1,
    dismissedAt: null
  };
  writeGithubStarPromptState(storage, next);
  return next;
}

/** Records "maybe later" and starts the 7-day cooldown. */
export function markGithubStarPromptDismissed(
  storage: Storage | undefined,
  nowMs: number = Date.now()
): GithubStarPromptPersistedState {
  const current = readGithubStarPromptState(storage);
  const next: GithubStarPromptPersistedState = {
    ...current,
    dismissedAt: nowMs
  };
  writeGithubStarPromptState(storage, next);
  return next;
}

/** Records that the user opened GitHub — never show again. */
export function markGithubStarPromptActioned(storage: Storage | undefined): GithubStarPromptPersistedState {
  const current = readGithubStarPromptState(storage);
  const next: GithubStarPromptPersistedState = {
    ...current,
    actioned: true,
    dismissedAt: null
  };
  writeGithubStarPromptState(storage, next);
  return next;
}
