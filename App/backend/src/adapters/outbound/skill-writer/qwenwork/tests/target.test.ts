import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderMemmyDefaultSkillManifest } from "../../templates/memmy-default.js";
import { createQwenworkSkillTarget } from "../index.js";

let tempDir: string | undefined;
afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("qwenwork skill target", () => {
  it("installs and removes the Memmy skill in qwenwork's global skill directory", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-qwenwork-skill-"));
    const rootDirectory = join(tempDir, ".qwenworkcn");
    mkdirSync(rootDirectory, { recursive: true });
    const target = createQwenworkSkillTarget({ rootDirectory });

    await target.install(renderMemmyDefaultSkillManifest("qwenwork"));
    const skillPath = join(rootDirectory, "skills", "memmy-memory", "SKILL.md");
    expect(readFileSync(skillPath, "utf8")).toContain("--source qwenwork");
    await expect(target.isInstalled("qwenwork")).resolves.toBe(true);

    await target.uninstall("qwenwork");
    expect(existsSync(skillPath)).toBe(false);
  });
});
