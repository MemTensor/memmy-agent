import { describe, expect, it } from "vitest";
import { formatInviteCredits, inviteTokensToCredits } from "../credits-preview-quota.js";

describe("invite token to credit conversion", () => {
  it("turns each million tokens into one credit", () => {
    expect(inviteTokensToCredits(2_000_000)).toBe(2);
    expect(inviteTokensToCredits(500_000)).toBe(0.5);
    expect(inviteTokensToCredits(765_432)).toBe(0.77);
    expect(inviteTokensToCredits(0)).toBe(0);
  });

  it("formats whole credits without trailing zeros", () => {
    expect(formatInviteCredits(2_000_000, "zh-CN")).toBe("2");
    expect(formatInviteCredits(500_000, "zh-CN")).toBe("0.5");
    expect(formatInviteCredits(765_432, "en-US")).toBe("0.77");
  });
});
