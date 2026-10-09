import { afterEach, describe, expect, it, vi } from "vitest";
import type { LotteryStatus } from "@memmy/local-api-contracts";
import {
  CAMPAIGN_PROMPT_MAX_SHOWS,
  CAMPAIGN_PROMPT_STORAGE_KEY,
  isGuidanceDone,
  isCampaignPromptSessionReady,
  isCampaignPromptSurfaceReady,
  markCampaignPromptActioned,
  markCampaignPromptDismissed,
  markCampaignPromptShown,
  readCampaignPromptState,
  shouldOfferCampaignPrompt,
  type CampaignPromptPersistedState
} from "../campaign-prompt-state.js";

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

const duringCampaign = 1790456789000;

function remoteStatus(overrides: Partial<LotteryStatus> = {}): LotteryStatus {
  return {
    shouldShow: true,
    startAt: 1790121600000,
    endAt: 1790812800000,
    serverNow: duringCampaign,
    landingUrl: "https://memmy.cn/activity/mid-autumn",
    ...overrides
  };
}

function emptyState(): CampaignPromptPersistedState {
  return { showCount: 0, dismissedAt: null, actioned: false };
}

describe("campaign prompt eligibility", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("offers the prompt during the campaign window", () => {
    expect(shouldOfferCampaignPrompt(emptyState(), remoteStatus())).toBe(true);
  });

  it("fails closed when the remote switch is off or unavailable", () => {
    expect(shouldOfferCampaignPrompt(emptyState(), remoteStatus({ shouldShow: false }))).toBe(false);
    expect(shouldOfferCampaignPrompt(emptyState(), undefined)).toBe(false);
  });

  it("uses server time to enforce the remote campaign window", () => {
    expect(shouldOfferCampaignPrompt(emptyState(), remoteStatus({ serverNow: 1790121599999 }))).toBe(false);
    expect(shouldOfferCampaignPrompt(emptyState(), remoteStatus({ serverNow: 1790812800000 }))).toBe(false);
  });

  it("is ready only on workspace routes after boot", () => {
    for (const currentPath of ["/main", "/memory", "/memory-sources", "/knowledge", "/tools", "/settings"]) {
      expect(isCampaignPromptSurfaceReady({ startupStatus: "ready", currentPath })).toBe(true);
    }
  });

  it("treats an authenticated account and a configured BYOK session as logged in", () => {
    expect(isCampaignPromptSessionReady({
      userMode: "account",
      accountUserId: "user-1",
      guidanceDone: true
    })).toBe(true);
    expect(isCampaignPromptSessionReady({
      userMode: "account",
      accountUserId: "user-1",
      guidanceDone: false
    })).toBe(false);
    expect(isCampaignPromptSessionReady({ userMode: "account", accountUserId: "user-1" })).toBe(false);
    expect(isCampaignPromptSessionReady({
      userMode: "byok",
      accountUserId: null,
      byokConfigured: true,
      guidanceDone: true
    })).toBe(true);
    expect(isCampaignPromptSessionReady({
      userMode: "byok",
      accountUserId: null,
      byokConfigured: false,
      guidanceDone: true
    })).toBe(false);
    expect(isCampaignPromptSessionReady({ userMode: "byok", accountUserId: null, guidanceDone: true })).toBe(false);
    expect(isCampaignPromptSessionReady({ userMode: "byok", accountUserId: null })).toBe(false);
    expect(isCampaignPromptSessionReady({
      userMode: "byok",
      accountUserId: null,
      byokConfigured: true,
      guidanceDone: false
    })).toBe(false);
    expect(isCampaignPromptSessionReady({ userMode: "account", accountUserId: null })).toBe(false);
    expect(isCampaignPromptSessionReady({ userMode: "account", accountUserId: "" })).toBe(false);
    expect(isCampaignPromptSessionReady({ userMode: "unset", accountUserId: null })).toBe(false);
    expect(isCampaignPromptSessionReady({ userMode: undefined, accountUserId: "user-1" })).toBe(false);
  });

  it("treats finished guidance as done, and an in-progress tour as not done", () => {
    expect(isGuidanceDone({
      guidanceCompleted: true,
      onboardingCompleted: false,
      deferredGuidanceStep: null
    })).toBe(true);
    expect(isGuidanceDone({
      guidanceCompleted: true,
      onboardingCompleted: false,
      deferredGuidanceStep: "product_tour"
    })).toBe(false);
    expect(isGuidanceDone({
      guidanceCompleted: true,
      onboardingCompleted: true,
      deferredGuidanceStep: "improvement"
    })).toBe(false);
    expect(isGuidanceDone({
      guidanceCompleted: false,
      onboardingCompleted: true,
      deferredGuidanceStep: null
    })).toBe(true);
    expect(isGuidanceDone({
      guidanceCompleted: false,
      onboardingCompleted: true,
      deferredGuidanceStep: "product_tour"
    })).toBe(false);
    expect(isGuidanceDone({
      guidanceCompleted: false,
      onboardingCompleted: false,
      deferredGuidanceStep: null
    })).toBe(false);
  });

  it("waits for boot and skips setup, login, onboarding, and the pet window", () => {
    expect(isCampaignPromptSurfaceReady({ startupStatus: "loading", currentPath: "/main" })).toBe(false);
    for (const currentPath of [
      "/welcome",
      "/login",
      "/token-detail",
      "/onboarding",
      "/api-key",
      "/api-key-models",
      "/api-key-optional",
      "/pet"
    ]) {
      expect(isCampaignPromptSurfaceReady({ startupStatus: "ready", currentPath })).toBe(false);
    }
  });

  it("stops after one show or a site visit", () => {
    expect(CAMPAIGN_PROMPT_MAX_SHOWS).toBe(1);
    expect(shouldOfferCampaignPrompt({
      showCount: CAMPAIGN_PROMPT_MAX_SHOWS,
      dismissedAt: null,
      actioned: false
    }, remoteStatus())).toBe(false);
    expect(shouldOfferCampaignPrompt({
      showCount: 0,
      dismissedAt: null,
      actioned: true
    }, remoteStatus())).toBe(false);
  });

  it("persists shown, dismissed, and actioned states", () => {
    const storage = new MemoryStorage();
    expect(readCampaignPromptState(storage)).toEqual(emptyState());

    expect(markCampaignPromptShown(storage)).toMatchObject({ showCount: 1, dismissedAt: null });
    expect(JSON.parse(storage.getItem(CAMPAIGN_PROMPT_STORAGE_KEY) ?? "{}")).toMatchObject({ showCount: 1 });
    expect(shouldOfferCampaignPrompt(readCampaignPromptState(storage), remoteStatus())).toBe(false);

    expect(markCampaignPromptDismissed(storage, duringCampaign).dismissedAt).toBe(duringCampaign);
    expect(markCampaignPromptActioned(storage)).toMatchObject({ actioned: true, dismissedAt: null });
    expect(shouldOfferCampaignPrompt(readCampaignPromptState(storage), remoteStatus())).toBe(false);
  });
});
