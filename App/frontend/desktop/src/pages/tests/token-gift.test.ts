import { describe, expect, it } from "vitest";
import { formatTokenGiftAmount } from "../token-gift.js";

describe("formatTokenGiftAmount", () => {
  it("formats the Nacos Agent quota and does not invent a fallback amount", () => {
    expect(formatTokenGiftAmount(2_000_000)).toBe("2,000,000");
    expect(formatTokenGiftAmount(0)).toBe("—");
    expect(formatTokenGiftAmount(undefined)).toBe("—");
  });
});
