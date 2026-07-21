import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";

describe("build runtime assets", () => {
  it("copies templates and builtin skill resources into dist", () => {
    execFileSync(npmBin, ["run", "build"], { cwd: process.cwd(), stdio: "pipe" });

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
