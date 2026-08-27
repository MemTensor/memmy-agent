import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCursorSourceAdapter } from "../../adapters/outbound/agent-source/cursor/index.js";
import { createOpencodeSourceAdapter } from "../../adapters/outbound/agent-source/opencode/index.js";
import { createCursorSkillTarget } from "../../adapters/outbound/skill-writer/cursor/index.js";
import { createOpencodeSkillTarget } from "../../adapters/outbound/skill-writer/opencode/index.js";
import { renderMemmyDefaultSkillManifest } from "../../adapters/outbound/skill-writer/templates/memmy-default.js";

let tempDirectory: string | undefined;

afterEach(() => {
  if (tempDirectory) {
    rmSync(tempDirectory, { recursive: true, force: true });
    tempDirectory = undefined;
  }
});

describe("agent source and config path separation", () => {
  it("installs OpenCode Skill when the database exists but the config directory does not", async () => {
    tempDirectory = mkdtempSync(join(tmpdir(), "memmy-opencode-paths-"));
    const databasePath = join(tempDirectory, "data", "opencode.db");
    const configDirectory = join(tempDirectory, "config", "opencode");
    mkdirSync(join(tempDirectory, "data"), { recursive: true });
    writeFileSync(databasePath, "", "utf8");
    const source = createOpencodeSourceAdapter({ databasePath });
    const target = createOpencodeSkillTarget({ rootDirectory: configDirectory });

    await expect(source.detect()).resolves.toBe(true);
    await target.install(renderMemmyDefaultSkillManifest("opencode"));

    expect(await target.isInstalled("opencode")).toBe(true);
  });

  it("installs Cursor Hook config when history exists but the config directory does not", async () => {
    tempDirectory = mkdtempSync(join(tmpdir(), "memmy-cursor-paths-"));
    const storageRoot = join(tempDirectory, "Cursor", "User", "workspaceStorage");
    const configDirectory = join(tempDirectory, ".cursor");
    mkdirSync(storageRoot, { recursive: true });
    const source = createCursorSourceAdapter({ storageRoot });
    const target = createCursorSkillTarget({
      rootDirectory: configDirectory,
      memmyConfigPath: join(tempDirectory, "missing-memmy.yaml")
    });

    await expect(source.detect()).resolves.toBe(true);
    await target.installPlugin?.("cursor");

    expect(await target.isInstalled("cursor")).toBe(true);
  });
});
