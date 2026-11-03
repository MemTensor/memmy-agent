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

describe("Codex installation critical section", () => {
  it("rejects nested acquisition instead of waiting on itself", async () => {
    const { withCodexInstallationLock } = await import("../codex-installation.js");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "codex-lock-"));
    try {
      await expect(withCodexInstallationLock(root, () => withCodexInstallationLock(root, async () => {})))
        .rejects.toThrow("Nested Codex installation operation");
      const failure = Object.assign(new Error("operation failed"), { code: "EEXIST" });
      await expect(withCodexInstallationLock(root, async () => { throw failure; })).rejects.toBe(failure);
      await expect(withCodexInstallationLock(root, async () => "released")).resolves.toBe("released");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
