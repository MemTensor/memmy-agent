/** GitHub star prompt state tests. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GITHUB_STAR_PROMPT_COOLDOWN_MS,
  GITHUB_STAR_PROMPT_MAX_SHOWS,
  GITHUB_STAR_PROMPT_STORAGE_KEY,
  markGithubStarPromptActioned,
  markGithubStarPromptDismissed,
  markGithubStarPromptShown,
  readGithubStarPromptState,
  shouldOfferGithubStarPrompt,
  writeGithubStarPromptState
} from "../github-star-prompt-state.js";

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    }
  };
}

describe("github-star-prompt-state", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allows the first show with empty storage", () => {
    expect(shouldOfferGithubStarPrompt(readGithubStarPromptState(createMemoryStorage()), 1_000)).toBe(true);
  });

  it("blocks after the user opens GitHub", () => {
    const storage = createMemoryStorage();
    markGithubStarPromptActioned(storage);
    expect(shouldOfferGithubStarPrompt(readGithubStarPromptState(storage), 1_000)).toBe(false);
  });

  it("blocks during the 7-day cooldown after dismiss", () => {
    const storage = createMemoryStorage();
    const now = 10_000_000;
    markGithubStarPromptShown(storage);
    markGithubStarPromptDismissed(storage, now);
    expect(shouldOfferGithubStarPrompt(readGithubStarPromptState(storage), now + 1)).toBe(false);
    expect(
      shouldOfferGithubStarPrompt(readGithubStarPromptState(storage), now + GITHUB_STAR_PROMPT_COOLDOWN_MS)
    ).toBe(true);
  });

  it("blocks after the max show count", () => {
    const storage = createMemoryStorage();
    writeGithubStarPromptState(storage, {
      showCount: GITHUB_STAR_PROMPT_MAX_SHOWS,
      dismissedAt: null,
      actioned: false
    });
    expect(shouldOfferGithubStarPrompt(readGithubStarPromptState(storage), Date.now())).toBe(false);
  });

  it("increments showCount when marked shown", () => {
    const storage = createMemoryStorage();
    markGithubStarPromptShown(storage);
    markGithubStarPromptShown(storage);
    expect(readGithubStarPromptState(storage).showCount).toBe(2);
    expect(storage.getItem(GITHUB_STAR_PROMPT_STORAGE_KEY)).toContain('"showCount":2');
  });
});
