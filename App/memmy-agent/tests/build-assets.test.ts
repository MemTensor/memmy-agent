import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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
  it("excludes Office skills and removes stale renderer payload without deleting source", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-slim-assets-"));
    const write = (relativePath: string, content: string) => {
      const file = path.join(fixture, relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    };
    try {
      for (const skill of ["docx", "pptx", "xlsx"]) {
        write(`src/skills/${skill}/SKILL.md`, `preserved ${skill} source`);
        write(`src/skills/${skill}/scripts/render.mjs`, "preserved script");
        write(`dist/skills/${skill}/old-asset.bin`, "stale asset");
      }
      write("src/skills/pptx/schemas/SCHEMA-MANIFEST.json", "{}");
      write("src/skills/computer-history/SKILL.md", "retained history");
      write("src/skills/skill-creator/SKILL.md", "retained skill creator");
      write("src/templates/agent/example.md", "retained template");
      write("src/tools/computer-history/mac/human-recorder.swift", "retained helper");
      write("dist/extra-dependencies/office-rendering/linux-x64/bin/soffice", "stale renderer");
      write("dist/extra-dependencies/docx-rendering/bin/soffice", "stale legacy renderer");

      execFileSync(process.execPath, [path.join(root, "scripts/copy-build-assets.mjs")], {
        cwd: fixture, stdio: "pipe",
      });

      for (const skill of ["docx", "pptx", "xlsx"]) {
        expect(fs.existsSync(path.join(fixture, "dist/skills", skill))).toBe(false);
        expect(fs.readFileSync(path.join(fixture, "src/skills", skill, "SKILL.md"), "utf8"))
          .toBe(`preserved ${skill} source`);
        expect(fs.readFileSync(path.join(fixture, "src/skills", skill, "scripts/render.mjs"), "utf8"))
          .toBe("preserved script");
      }
      for (const renderer of ["office-rendering", "docx-rendering"]) {
        expect(fs.existsSync(path.join(fixture, "dist/extra-dependencies", renderer))).toBe(false);
      }
      for (const retained of [
        "skills/computer-history/SKILL.md", "skills/skill-creator/SKILL.md",
        "templates/agent/example.md", "tools/computer-history/mac/human-recorder.swift",
      ]) expect(fs.existsSync(path.join(fixture, "dist", retained))).toBe(true);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

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
    expect(fs.existsSync(renderingRoot)).toBe(false);
    expect(fs.existsSync(path.join(root, "dist/extra-dependencies/docx-rendering"))).toBe(false);
    for (const skill of ["docx", "pptx", "xlsx"]) {
      expect(fs.existsSync(path.join(root, "dist/skills", skill))).toBe(false);
      expect(fs.existsSync(path.join(root, "src/skills", skill, "SKILL.md"))).toBe(true);
    }

    const tmuxScript = path.join(root, "dist/skills/tmux/scripts/find-sessions.sh");
    expect(fs.existsSync(tmuxScript)).toBe(true);
    if (process.platform !== "win32") expect(fs.statSync(tmuxScript).mode & 0o111).not.toBe(0);
  }, 60_000);
});
