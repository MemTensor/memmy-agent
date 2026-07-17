import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

let tempDirs: string[] = [];

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-skill-"));
  tempDirs.push(dir);
  return dir;
}

function pythonCommand(): string {
  const candidates = [process.env.PYTHON, "python3", "python"].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (!result.error && result.status === 0) return candidate;
  }
  throw new Error("No Python interpreter found for skill-creator validation tests");
}

function writeSkill(root: string, name: string, frontmatter: string[], body = "# Skill\n\nFollow the workflow.\n"): string {
  const skillDir = path.join(root, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), ["---", ...frontmatter, "---", "", body].join("\n"), "utf8");
  return skillDir;
}

function runValidator(skillDir: string): { status: number | null; stdout: string; stderr: string } {
  const script = path.resolve("src/skills/skill-creator/scripts/quick-validate.py");
  const result = spawnSync(pythonCommand(), [script, skillDir], { encoding: "utf8" });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("skill creator quick validator", () => {
  it("validates the existing skill creator skill through the documented Python entrypoint", () => {
    const result = runValidator(path.resolve("src/skills/skill-creator"));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Skill is valid!");
  });

  it("accepts valid memmy metadata", () => {
    const root = tempRoot();
    const skillDir = writeSkill(root, "memmy-metadata", [
      "name: memmy-metadata",
      "description: Validate canonical memmy metadata.",
      `metadata: ${JSON.stringify({ memmy: { always: true, requires: { bins: ["gh"], env: ["GITHUB_TOKEN"] } } })}`,
    ]);

    const result = runValidator(skillDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Skill is valid!");
  });

  it("rejects placeholder skill descriptions", () => {
    const root = tempRoot();
    const placeholder = writeSkill(root, "placeholder-skill", [
      "name: placeholder-skill",
      'description: "[TODO: fill me in]"',
    ]);

    const result = runValidator(placeholder);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("TODO placeholder");
  });

  it("rejects non-memmy metadata namespaces", () => {
    const root = tempRoot();
    const legacy = writeSkill(root, "legacy-metadata", [
      "name: legacy-metadata",
      "description: Reject legacy metadata namespaces.",
      `metadata: ${JSON.stringify({ openclaw: { always: true }, memmy_agent: { always: true } })}`,
    ]);

    const result = runValidator(legacy);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Unsupported metadata namespace");
  });

  it("rejects root files outside allowed resource directories", () => {
    const root = tempRoot();
    const badRoot = writeSkill(root, "bad-root-skill", [
      "name: bad-root-skill",
      "description: Reject unexpected root files.",
    ]);
    fs.writeFileSync(path.join(badRoot, "README.md"), "extra\n", "utf8");

    const result = runValidator(badRoot);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Unexpected file or directory in skill root");
  });
});
