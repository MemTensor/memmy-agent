import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";

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
      const staleFile = path.join(process.cwd(), relativePath);
      fs.mkdirSync(path.dirname(staleFile), { recursive: true });
      fs.writeFileSync(staleFile, "stale build output", "utf8");
    }

    execFileSync(npmBin, ["run", "build"], { cwd: process.cwd(), stdio: "pipe" });

    expect(
      fs.existsSync(path.join(process.cwd(), "dist/templates/agent/file-memory.md")),
    ).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), "dist/skills/memory"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(process.cwd(), "dist/skills/my"))).toBe(false);
    for (const relativePath of staleFiles.slice(2)) {
      expect(fs.existsSync(path.join(process.cwd(), relativePath))).toBe(false);
    }
    expect(fs.existsSync(path.join(process.cwd(), "dist/templates/agent/subagent-announce.md"))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), "dist/templates/agent/verification-contract.md"))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), "dist/templates/memory/MEMORY.md"))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), "dist/skills/goal/SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), "dist/skills/skill-creator/SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(process.cwd(), "dist/skills/skill-creator/scripts/quick-validate.py"))).toBe(true);

    const tmuxScript = path.join(process.cwd(), "dist/skills/tmux/scripts/find-sessions.sh");
    expect(fs.existsSync(tmuxScript)).toBe(true);
    expect(fs.statSync(tmuxScript).mode & 0o111).not.toBe(0);
  }, 60_000);
});
