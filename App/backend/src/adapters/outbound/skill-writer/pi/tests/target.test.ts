import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderMemmyDefaultSkillManifest } from "../../templates/memmy-default.js";
import { createPiSkillTarget } from "../index.js";

let tempDir: string | undefined;
afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("Pi skill target", () => {
  it("installs and removes the Memmy skill in Pi's global skill directory", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-pi-skill-"));
    const rootDirectory = join(tempDir, ".pi", "agent");
    mkdirSync(rootDirectory, { recursive: true });
    const target = createPiSkillTarget({ rootDirectory });

    await target.install(renderMemmyDefaultSkillManifest("pi"));
    const skillPath = join(rootDirectory, "skills", "memmy-memory", "SKILL.md");
    expect(readFileSync(skillPath, "utf8")).toContain("--source pi");
    await expect(target.isInstalled("pi")).resolves.toBe(true);

    await target.uninstall("pi");
    expect(existsSync(skillPath)).toBe(false);
  });
});
