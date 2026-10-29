/** Hook revision tests. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { currentMemmyHookRevision, hookRevision, isInstalledMemmyHookCurrent } from "./hook-revision.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("hook revision", () => {
  it("changes when the hook script or workspace bridge changes", () => {
    const current = hookRevision("hook script", "workspace bridge");

    expect(hookRevision("hook script", "workspace bridge")).toBe(current);
    expect(hookRevision("updated hook script", "workspace bridge")).not.toBe(current);
    expect(hookRevision("hook script", "updated workspace bridge")).not.toBe(current);
  });

  it("treats a current fingerprint with leftover hook files as outdated", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-hook-revision-"));
    const revision = await currentMemmyHookRevision("cursor", "cursor");
    const hookScriptPath = join(tempDir, "memmy-resume-hook.mjs");
    const bridgePath = join(tempDir, "memmy-workspace-bridge.mjs");
    const configPath = join(tempDir, "memmy-memory-config.json");
    writeFileSync(hookScriptPath, "old hook\n", "utf8");
    writeFileSync(bridgePath, "old bridge\n", "utf8");
    writeFileSync(configPath, `${JSON.stringify({ hook_revision: revision }, null, 2)}\n`, "utf8");

    await expect(isInstalledMemmyHookCurrent({
      source: "cursor",
      mode: "cursor",
      hookScriptPath,
      bridgePath,
      configPath
    })).resolves.toBe(false);
  });
});
