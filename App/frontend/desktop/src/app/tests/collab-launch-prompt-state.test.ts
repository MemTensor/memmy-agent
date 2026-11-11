/**
 * Eligibility for the 1.2.7 project-collaboration announcement: account mode with a signed-in user, guidance done,
 * not seen on this computer, and no other large prompt on screen.
 */
import { describe, expect, it } from "vitest";
import {
  COLLAB_LAUNCH_PROMPT_STORAGE_KEY,
  claimCollabLaunchPrompt,
  hasCollabLaunchPromptClaimedThisRun,
  isCollabLaunchPromptOpen,
  isCollabLaunchSurfaceReady,
  markCollabLaunchPromptSeen,
  readCollabLaunchPromptSeen,
  resetCollabLaunchPromptRuntime,
  setCollabLaunchPromptOpen,
  shouldOfferCollabLaunchPrompt
} from "../collab-launch-prompt-state.js";

class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();

  get length() {
    return this.data.size;
  }

  clear() {
    this.data.clear();
  }

  getItem(key: string) {
    return this.data.get(key) ?? null;
  }

  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.data.delete(key);
  }

  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

const ELIGIBLE = {
  userMode: "account" as const,
  accountUserId: "user-1",
  guidanceDone: true,
  seen: false,
  otherPromptOpen: false
};

describe("collab launch prompt state", () => {
  it("offers the announcement to a signed-in account that never saw it", () => {
    expect(shouldOfferCollabLaunchPrompt(ELIGIBLE)).toBe(true);
  });

  it("waits for API Key mode, which has no cloud projects", () => {
    expect(shouldOfferCollabLaunchPrompt({ ...ELIGIBLE, userMode: "byok" })).toBe(false);
    expect(shouldOfferCollabLaunchPrompt({ ...ELIGIBLE, userMode: "unset" })).toBe(false);
  });

  it("waits until an account is signed in", () => {
    expect(shouldOfferCollabLaunchPrompt({ ...ELIGIBLE, accountUserId: null })).toBe(false);
    expect(shouldOfferCollabLaunchPrompt({ ...ELIGIBLE, accountUserId: "" })).toBe(false);
  });

  it("waits until the new-user guidance is done", () => {
    expect(shouldOfferCollabLaunchPrompt({ ...ELIGIBLE, guidanceDone: false })).toBe(false);
  });

  it("never shows it twice on the same computer", () => {
    expect(shouldOfferCollabLaunchPrompt({ ...ELIGIBLE, seen: true })).toBe(false);
  });

  it("steps aside while another large prompt is on screen", () => {
    expect(shouldOfferCollabLaunchPrompt({ ...ELIGIBLE, otherPromptOpen: true })).toBe(false);
  });

  it("records the announcement on this computer", () => {
    const storage = new MemoryStorage();
    expect(readCollabLaunchPromptSeen(storage)).toBe(false);
    markCollabLaunchPromptSeen(storage);
    expect(readCollabLaunchPromptSeen(storage)).toBe(true);
    expect(storage.getItem(COLLAB_LAUNCH_PROMPT_STORAGE_KEY)).toBe("1");
  });

  it("treats a missing storage as not seen instead of throwing", () => {
    expect(readCollabLaunchPromptSeen(undefined)).toBe(false);
    expect(() => markCollabLaunchPromptSeen(undefined)).not.toThrow();
    expect(readCollabLaunchPromptSeen(undefined)).toBe(false);
  });

  it("keeps one announcement per run: open state and the claimed slot are separate", () => {
    resetCollabLaunchPromptRuntime();
    expect(isCollabLaunchPromptOpen()).toBe(false);
    expect(hasCollabLaunchPromptClaimedThisRun()).toBe(false);

    claimCollabLaunchPrompt();
    setCollabLaunchPromptOpen(true);
    expect(isCollabLaunchPromptOpen()).toBe(true);
    expect(hasCollabLaunchPromptClaimedThisRun()).toBe(true);

    // Closing the carousel frees the screen but not the run's slot.
    setCollabLaunchPromptOpen(false);
    expect(isCollabLaunchPromptOpen()).toBe(false);
    expect(hasCollabLaunchPromptClaimedThisRun()).toBe(true);

    resetCollabLaunchPromptRuntime();
    expect(hasCollabLaunchPromptClaimedThisRun()).toBe(false);
  });

  it("waits for a ready startup on a workspace route, and includes the board", () => {
    expect(isCollabLaunchSurfaceReady({ startupStatus: "ready", currentPath: "/main" })).toBe(true);
    expect(isCollabLaunchSurfaceReady({ startupStatus: "ready", currentPath: "/collab" })).toBe(true);
    expect(isCollabLaunchSurfaceReady({ startupStatus: "ready", currentPath: "/settings" })).toBe(true);
    expect(isCollabLaunchSurfaceReady({ startupStatus: "loading", currentPath: "/main" })).toBe(false);
    expect(isCollabLaunchSurfaceReady({ startupStatus: "ready", currentPath: "/welcome" })).toBe(false);
    expect(isCollabLaunchSurfaceReady({ startupStatus: "ready", currentPath: "/login" })).toBe(false);
  });
});
