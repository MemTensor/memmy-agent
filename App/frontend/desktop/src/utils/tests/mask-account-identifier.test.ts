import { describe, expect, it } from "vitest";

import { maskAccountIdentifier, maskEmail, maskPhoneNumber } from "../mask-account-identifier.js";

describe("maskPhoneNumber", () => {
  it("masks 11-digit mainland mobile numbers", () => {
    expect(maskPhoneNumber("13800138000")).toBe("138****8000");
    expect(maskPhoneNumber("15157102876")).toBe("151****2876");
  });

  it("trims whitespace before masking", () => {
    expect(maskPhoneNumber(" 13800138000 ")).toBe("138****8000");
  });
});

describe("maskEmail", () => {
  it("masks the local part and keeps the domain", () => {
    expect(maskEmail("grace@example.com")).toBe("g***@example.com");
  });
});

describe("maskAccountIdentifier", () => {
  it("detects email and phone automatically", () => {
    expect(maskAccountIdentifier("grace@example.com")).toBe("g***@example.com");
    expect(maskAccountIdentifier("13800138000")).toBe("138****8000");
  });
});
