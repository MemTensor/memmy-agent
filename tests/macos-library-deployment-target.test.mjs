import { describe, expect, it } from "vitest";
import { minimumMacOS, targetIsSupported } from "../scripts/internal/mac/verify-library-deployment-target.mjs";

const modern = (minimum, sdk = "26.5") => `Load command 3\n      cmd LC_BUILD_VERSION\n  cmdsize 32\n platform 1\n    minos ${minimum}\n      sdk ${sdk}\n   ntools 1\n`;

describe("macOS native library deployment compatibility", () => {
  it("rejects the observed Tahoe bottle while accepting a new-SDK build for older systems", () => {
    expect(targetIsSupported(minimumMacOS(modern("26.0")), "12.0")).toBe(false);
    expect(targetIsSupported(minimumMacOS(modern("12.0")), "12.0")).toBe(true);
    expect(minimumMacOS(modern("12.3.1", "26.5"))).toBe("12.3.1");
  });
  it("reads an older macOS load command without treating its SDK as the minimum", () => {
    expect(minimumMacOS("Load command 4\n cmd LC_VERSION_MIN_MACOSX\n version 11.0\n sdk 26.0\n")).toBe("11.0");
    expect(targetIsSupported("11.0", "12.0")).toBe(true);
  });
  it("fails closed on missing or ambiguous macOS requirements and another Apple platform", () => {
    for (const value of ["sdk 12.0", modern("12.0").replace("platform 1", "platform 2"), modern("12.0") + modern("26.0")]) {
      expect(() => minimumMacOS(value)).toThrow();
    }
    expect(() => targetIsSupported("12.0junk", "12.0")).toThrow();
    expect(targetIsSupported("12.0.1", "12.0")).toBe(false);
  });
});
