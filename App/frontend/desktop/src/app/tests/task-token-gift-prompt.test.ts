import { describe, expect, it } from "vitest";
import { formatGiftAmount, resolveLaunchGiftPrompt } from "../task-token-gift-prompt.js";

describe("task Token gift prompt plan", () => {
  const existing = { hasGift: true as const, grantId: "launch-gift-20m", audience: "existing" as const,
    tokenAmount: 20_000_000, totalTokens: 22_000_000 };
  const fresh = { hasGift: true as const, grantId: "launch-gift-20m", audience: "new" as const,
    tokenAmount: 20_000_000, totalTokens: 20_000_000 };
  const otherAmount = { hasGift: true as const, grantId: "some-other-grant", audience: "existing" as const,
    tokenAmount: 5_000_000, totalTokens: 5_000_000 };

  it("shows existing users the gift page alone, whatever the date", () => {
    expect(resolveLaunchGiftPrompt(existing)).toEqual({ showGift: true, ackWithoutPrompt: false });
    expect(resolveLaunchGiftPrompt({ hasGift: false, audience: "existing" })).toEqual({
      showGift: false, ackWithoutPrompt: false
    });
  });

  it("acknowledges a new user's grant without a dialog, whatever the date", () => {
    expect(resolveLaunchGiftPrompt(fresh)).toEqual({ showGift: false, ackWithoutPrompt: true });
    expect(resolveLaunchGiftPrompt({ hasGift: false, audience: "new" })).toEqual({
      showGift: false, ackWithoutPrompt: false
    });
  });

  it("ignores notices that are not the 20M launch grant", () => {
    expect(resolveLaunchGiftPrompt(otherAmount)).toEqual({ showGift: false, ackWithoutPrompt: false });
    expect(resolveLaunchGiftPrompt({ ...otherAmount, audience: "new" })).toEqual({
      showGift: false, ackWithoutPrompt: false
    });
  });

  it("formats the granted amount per language", () => {
    expect(formatGiftAmount(20_000_000, "zh-CN")).toBe("2000 万");
    expect(formatGiftAmount(20_000_000, "en-US")).toBe("20M");
  });
});
