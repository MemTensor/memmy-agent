import { describe, expect, it } from "vitest";
import { featureAnnouncementSeenKey, formatGiftAmount, isLaunchFeatureAnnouncementActive, resolveLaunchGiftPrompt } from "../task-token-gift-prompt.js";

describe("task Token gift announcement", () => {
  const existing = { hasGift: true as const, grantId: "launch-gift-20m", audience: "existing" as const,
    tokenAmount: 20_000_000, totalTokens: 22_000_000 };
  const fresh = { hasGift: true as const, grantId: "launch-gift-20m", audience: "new" as const,
    tokenAmount: 20_000_000, totalTokens: 20_000_000 };
  const during = Date.parse("2026-11-20T23:59:59+08:00");
  const after = Date.parse("2026-11-21T00:00:00+08:00");

  it("shows existing users the gift with features through November 20, then the gift alone", () => {
    expect(resolveLaunchGiftPrompt(existing, false, during)).toEqual({ showGift: true, showFeatures: true, ackWithoutPrompt: false });
    expect(resolveLaunchGiftPrompt(existing, false, after)).toEqual({ showGift: true, showFeatures: false, ackWithoutPrompt: false });
    expect(isLaunchFeatureAnnouncementActive(after)).toBe(false);
    expect(resolveLaunchGiftPrompt({ hasGift: false, audience: "existing" }, false, during)).toEqual({
      showGift: false, showFeatures: false, ackWithoutPrompt: false
    });
  });

  it("grants new users without a gift page, and shows features only before the deadline", () => {
    expect(resolveLaunchGiftPrompt(fresh, false, during)).toEqual({ showGift: false, showFeatures: true, ackWithoutPrompt: false });
    expect(resolveLaunchGiftPrompt(fresh, false, after)).toEqual({ showGift: false, showFeatures: false, ackWithoutPrompt: true });
    expect(resolveLaunchGiftPrompt(fresh, true, during)).toEqual({ showGift: false, showFeatures: false, ackWithoutPrompt: true });
  });

  it("keeps each account's feature announcement separate", () => {
    expect(featureAnnouncementSeenKey("user-a")).not.toBe(featureAnnouncementSeenKey("user-b"));
    expect(formatGiftAmount(20_000_000, "zh-CN")).toBe("2000 万");
    expect(formatGiftAmount(20_000_000, "en-US")).toBe("20M");
  });
});
