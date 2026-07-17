import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderMemmyDefaultSkillManifest } from "../../templates/memmy-default.js";
import { createWorkbuddySkillTarget } from "../index.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("workbuddy skill target", () => {
  it("replaces a simplified Skill with the complete Memmy CLI Skill", async () => {
    const rootDirectory = createRoot();
    const skillDirectory = join(rootDirectory, "skills", "memmy-memory");
    mkdirSync(skillDirectory, { recursive: true });
    writeFileSync(join(skillDirectory, "SKILL.md"), "---\nname: memmy-memory\n---\n\nUse memory.\n", "utf8");
    const target = createWorkbuddySkillTarget({ rootDirectory });

    await expect(target.isInstalled("workbuddy")).resolves.toBe(false);
    await target.install(renderMemmyDefaultSkillManifest("workbuddy"));

    const content = readFileSync(join(skillDirectory, "SKILL.md"), "utf8");
    expect(content).toContain("## Agent Loop");
    expect(content).toContain("## Search And Read");
    expect(content).toContain("## Add Memory");
    expect(content).toContain("## Delete Memory");
    expect(content).toContain("--source workbuddy");
    expect(content).not.toContain("--layer");
    await expect(target.isInstalled("workbuddy")).resolves.toBe(true);
  });

  it("uninstalls only WorkBuddy's Memmy Skill directory", async () => {
    const rootDirectory = createRoot();
    writeFileSync(join(rootDirectory, "USER.md"), "keep", "utf8");
    const target = createWorkbuddySkillTarget({ rootDirectory });
    await target.install(renderMemmyDefaultSkillManifest("workbuddy"));

    await target.uninstall("workbuddy");

    expect(existsSync(join(rootDirectory, "skills", "memmy-memory"))).toBe(false);
    expect(readFileSync(join(rootDirectory, "USER.md"), "utf8")).toBe("keep");
  });
});

function createRoot(): string {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-workbuddy-skill-"));
  const rootDirectory = join(tempDir, ".workbuddy");
  mkdirSync(rootDirectory, { recursive: true });
  return rootDirectory;
}
