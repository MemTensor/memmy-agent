import { describe, expect, it } from "vitest";
import { canonicalCodexPath } from "../codex-installation.js";

describe("Codex hook file identity", () => {
  it.each([
    ["C:\\Users\\Test\\hooks.json", "\\\\?\\C:\\users\\test\\hooks.json"],
    ["//server/share/Codex/hooks.json", "\\\\?\\UNC\\server\\share\\codex\\hooks.json"],
    ["D:/Codex/../Codex/hooks.json", "d:\\codex\\hooks.json"]
  ])("matches Windows path aliases %s", (left, right) => {
    expect(canonicalCodexPath(left, "win32")).toBe(canonicalCodexPath(right, "win32"));
  });
  it("does not match a different configuration file", () => {
    expect(canonicalCodexPath("C:\\one\\hooks.json", "win32"))
      .not.toBe(canonicalCodexPath("C:\\two\\hooks.json", "win32"));
    expect(canonicalCodexPath("/one/hooks.json", "darwin"))
      .not.toBe(canonicalCodexPath("/two/hooks.json", "darwin"));
  });
});
