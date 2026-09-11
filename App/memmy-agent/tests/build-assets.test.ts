import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
const root = path.resolve(import.meta.dirname, "..");
const buildEnv = {
  ...process.env,
  MEMMY_LEGAL_CN_BASE_URL: "https://memmy.cn",
  MEMMY_LEGAL_INTL_BASE_URL: "https://memmy.bot",
};

describe("build runtime assets", () => {
  it("copies templates and builtin skill resources into dist", () => {
    const staleFiles = [
      "dist/skills/memory/SKILL.md",
      "dist/skills/my/SKILL.md",
      "dist/core/agent-runtime/tools/self.js",
      "dist/core/agent-runtime/tools/self.js.map",
      "dist/core/agent-runtime/tools/self.d.ts",
      "dist/core/agent-runtime/tools/runtime-state.js",
      "dist/core/agent-runtime/tools/runtime-state.js.map",
      "dist/core/agent-runtime/tools/runtime-state.d.ts",
    ];
    for (const relativePath of staleFiles) {
      const staleFile = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(staleFile), { recursive: true });
      fs.writeFileSync(staleFile, "stale build output", "utf8");
    }

    execFileSync(
      process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : npmBin,
      process.platform === "win32"
        ? ["/d", "/s", "/c", "npm.cmd run --ignore-scripts build"]
        : ["run", "--ignore-scripts", "build"],
      { cwd: root, env: buildEnv, stdio: "pipe" },
    );

    expect(
      fs.existsSync(path.join(root, "dist/templates/agent/file-memory.md")),
    ).toBe(true);
    expect(fs.existsSync(path.join(root, "dist/skills/memory"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(root, "dist/skills/my"))).toBe(false);
    for (const relativePath of staleFiles.slice(2)) {
      expect(fs.existsSync(path.join(root, relativePath))).toBe(false);
    }
    expect(fs.existsSync(path.join(root, "dist/templates/agent/subagent-announce.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, "dist/templates/agent/verification-contract.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, "dist/templates/memory/MEMORY.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, "dist/skills/goal/SKILL.md"))).toBe(false);
    expect(fs.existsSync(path.join(root, "dist/skills/skill-creator/SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, "dist/skills/skill-creator/scripts/quick-validate.py"))).toBe(true);
    expect(fs.existsSync(path.join(root, "dist/skills/ui-craft/SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, "dist/skills/ui-craft/references"))).toBe(false);

    const renderingRoot = path.join(root, "dist/extra-dependencies/office-rendering");
    for (const platform of ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64", "linux-arm64"]) {
      expect(fs.existsSync(path.join(renderingRoot, platform, "OFFICE-RENDERING-MANIFEST.json"))).toBe(true);
    }
    expect(fs.existsSync(path.join(renderingRoot, "THIRD-PARTY-NOTICES.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, "dist/extra-dependencies/docx-rendering"))).toBe(false);
    expect(fs.existsSync(path.join(root, "dist/skills/pptx/SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, "dist/skills/xlsx/SKILL.md"))).toBe(true);
    const docxScripts = path.join(root, "dist/skills/docx/scripts");
    expect(fs.readdirSync(docxScripts).filter((entry) => entry.endsWith(".py"))).toEqual([]);

    const tmuxScript = path.join(root, "dist/skills/tmux/scripts/find-sessions.sh");
    expect(fs.existsSync(tmuxScript)).toBe(true);
    if (process.platform !== "win32") expect(fs.statSync(tmuxScript).mode & 0o111).not.toBe(0);
  }, 60_000);
});
