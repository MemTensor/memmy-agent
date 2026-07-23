import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillsLoader } from "../../../src/core/agent-runtime/skills.js";

const roots: string[] = [];
const oldPath = process.env.PATH;
const oldEnv = process.env.MEMMY_AGENT_SKILLS_TEST_ENV_VAR;

function tmpDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-skills-"));
  roots.push(root);
  return root;
}

function makeWorkspace(): { root: string; workspace: string; builtin: string } {
  const root = tmpDir();
  const workspace = path.join(root, "ws");
  const builtin = path.join(root, "builtin");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(builtin, { recursive: true });
  return { root, workspace, builtin };
}

function writeSkill(
  base: string,
  name: string,
  {
    metadataJson = undefined,
    body = "# Skill\n",
  }: {
    metadataJson?: Record<string, any>;
    body?: string;
  } = {},
): string {
  const skillDir = path.join(base, name);
  fs.mkdirSync(skillDir, { recursive: true });
  const lines = ["---"];
  if (metadataJson !== undefined) lines.push(`metadata: ${JSON.stringify({ memmy: metadataJson })}`);
  lines.push("---", "", body);
  const skillPath = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(skillPath, lines.join("\n"), "utf8");
  return skillPath;
}

function addFakeBin(name: string): void {
  const binDir = path.join(tmpDir(), "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, name);
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", "utf8");
  fs.chmodSync(file, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
}

afterEach(() => {
  process.env.PATH = oldPath;
  if (oldEnv == null) delete process.env.MEMMY_AGENT_SKILLS_TEST_ENV_VAR;
  else process.env.MEMMY_AGENT_SKILLS_TEST_ENV_VAR = oldEnv;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("SkillsLoader listSkills", () => {
  it("keeps the product memory skill removed while preserving user skills named memory", () => {
    const workspace = tmpDir();
    const loader = new SkillsLoader(workspace);

    expect(loader.listSkills(false).map((entry) => entry.name)).not.toContain(
      "memory",
    );

    const userSkill = writeSkill(path.join(workspace, "skills"), "memory", {
      body: "# User Memory Helper",
    });
    const userLoader = new SkillsLoader(workspace);

    expect(userLoader.listSkills(false)).toEqual(
      expect.arrayContaining([
        { name: "memory", path: userSkill, source: "workspace" },
      ]),
    );
    expect(userLoader.loadSkill("memory")).toContain("# User Memory Helper");
  });

  it("removes the builtin my skill while preserving a workspace skill with the same name", () => {
    const workspace = tmpDir();
    const builtinOnly = new SkillsLoader(workspace);

    expect(builtinOnly.listSkills(false).map((entry) => entry.name)).not.toContain(
      "my",
    );
    expect(builtinOnly.getAlwaysSkills()).not.toContain("my");
    expect(builtinOnly.loadSkill("my")).toBeNull();

    const userSkill = writeSkill(path.join(workspace, "skills"), "my", {
      body: "# User My Helper",
    });
    const workspaceLoader = new SkillsLoader(workspace);

    expect(workspaceLoader.listSkills(false)).toEqual(
      expect.arrayContaining([
        { name: "my", path: userSkill, source: "workspace" },
      ]),
    );
    expect(workspaceLoader.loadSkill("my")).toContain("# User My Helper");
  });

  it("returns empty when the workspace skills directory is missing", () => {
    const { workspace, builtin } = makeWorkspace();

    expect(new SkillsLoader(workspace, builtin).listSkills(false)).toEqual([]);
  });

  it("returns empty when the workspace skills directory exists but is empty", () => {
    const { workspace, builtin } = makeWorkspace();
    fs.mkdirSync(path.join(workspace, "skills"), { recursive: true });

    expect(new SkillsLoader(workspace, builtin).listSkills(false)).toEqual([]);
  });

  it("returns workspace entries with shape and source", () => {
    const { workspace, builtin } = makeWorkspace();
    const skillsRoot = path.join(workspace, "skills");
    const skillPath = writeSkill(skillsRoot, "alpha", { body: "# Alpha" });

    expect(new SkillsLoader(workspace, builtin).listSkills(false)).toEqual([
      { name: "alpha", path: skillPath, source: "workspace" },
    ]);
  });

  it("skips non-directories and directories without SKILL.md", () => {
    const { workspace, builtin } = makeWorkspace();
    const skillsRoot = path.join(workspace, "skills");
    fs.mkdirSync(skillsRoot, { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, "not_a_dir.txt"), "x", "utf8");
    fs.mkdirSync(path.join(skillsRoot, "no_skill_md"));
    const skillPath = writeSkill(skillsRoot, "ok", { body: "# Ok" });

    const entries = new SkillsLoader(workspace, builtin).listSkills(false);

    expect(entries.map((entry) => entry.name)).toEqual(["ok"]);
    expect(entries[0].path).toBe(skillPath);
  });

  it("lets workspace skills shadow builtin skills with the same name", () => {
    const { workspace, builtin } = makeWorkspace();
    const wsPath = writeSkill(path.join(workspace, "skills"), "dup", { body: "# Workspace wins" });
    writeSkill(builtin, "dup", { body: "# Builtin" });

    const entries = new SkillsLoader(workspace, builtin).listSkills(false);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source: "workspace", path: wsPath });
  });

  it("merges workspace and builtin skills", () => {
    const { workspace, builtin } = makeWorkspace();
    const wsPath = writeSkill(path.join(workspace, "skills"), "ws_only", { body: "# W" });
    const biPath = writeSkill(builtin, "bi_only", { body: "# B" });

    expect(new SkillsLoader(workspace, builtin).listSkills(false)).toEqual([
      { name: "bi_only", path: biPath, source: "builtin" },
      { name: "ws_only", path: wsPath, source: "workspace" },
    ]);
  });

  it("omits builtin skills when the builtin directory is missing", () => {
    const { workspace, root } = makeWorkspace();
    const wsPath = writeSkill(path.join(workspace, "skills"), "solo", { body: "# S" });
    const missingBuiltin = path.join(root, "no_such_builtin");

    expect(new SkillsLoader(workspace, missingBuiltin).listSkills(false)).toEqual([
      { name: "solo", path: wsPath, source: "workspace" },
    ]);
  });

  it("excludes skills with unmet binary requirements when filtering", () => {
    const { workspace, builtin } = makeWorkspace();
    writeSkill(path.join(workspace, "skills"), "needs_bin", {
      metadataJson: { requires: { bins: ["memmy_test_fake_binary"] } },
    });

    expect(new SkillsLoader(workspace, builtin).listSkills(true)).toEqual([]);
  });

  it("includes skills whose binary requirements are met", () => {
    const { workspace, builtin } = makeWorkspace();
    addFakeBin("memmy_test_fake_binary");
    const skillPath = writeSkill(path.join(workspace, "skills"), "has_bin", {
      metadataJson: { requires: { bins: ["memmy_test_fake_binary"] } },
    });

    expect(new SkillsLoader(workspace, builtin).listSkills(true)).toEqual([
      { name: "has_bin", path: skillPath, source: "workspace" },
    ]);
  });

  it("keeps unmet requirements when filtering is disabled", () => {
    const { workspace, builtin } = makeWorkspace();
    const skillPath = writeSkill(path.join(workspace, "skills"), "blocked", {
      metadataJson: { requires: { bins: ["memmy_test_fake_binary"] } },
    });

    expect(new SkillsLoader(workspace, builtin).listSkills(false)).toEqual([
      { name: "blocked", path: skillPath, source: "workspace" },
    ]);
  });

  it("excludes skills with unmet env requirements", () => {
    const { workspace, builtin } = makeWorkspace();
    delete process.env.MEMMY_AGENT_SKILLS_TEST_ENV_VAR;
    writeSkill(path.join(workspace, "skills"), "needs_env", {
      metadataJson: { requires: { env: ["MEMMY_AGENT_SKILLS_TEST_ENV_VAR"] } },
    });

    expect(new SkillsLoader(workspace, builtin).listSkills(true)).toEqual([]);
  });

  it("ignores non-memmy metadata namespaces for requirements", () => {
    const { workspace, builtin } = makeWorkspace();
    const skillsRoot = path.join(workspace, "skills");
    const skillDir = path.join(skillsRoot, "legacy_namespace");
    fs.mkdirSync(skillDir, { recursive: true });
    const skillPath = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(
      skillPath,
      `---\nmetadata: ${JSON.stringify({
        openclaw: { requires: { bins: ["missing_openclaw_bin"] } },
        memmy_agent: { requires: { bins: ["missing_memmy_agent_bin"] } },
        memmyAgent: { requires: { bins: ["missing_memmy_agent_camel_bin"] } },
      })}\n---\n\n# Legacy namespace`,
      "utf8",
    );
    const loader = new SkillsLoader(workspace, builtin);

    expect(loader.listSkills(true)).toEqual([
      { name: "legacy_namespace", path: skillPath, source: "workspace" },
    ]);
  });
});

describe("SkillsLoader disabled skills", () => {
  it("excludes disabled skills from listSkills", () => {
    const { workspace, builtin } = makeWorkspace();
    writeSkill(path.join(workspace, "skills"), "alpha", { body: "# Alpha" });
    const betaPath = writeSkill(path.join(workspace, "skills"), "beta", { body: "# Beta" });

    const entries = new SkillsLoader(workspace, builtin, new Set(["alpha"])).listSkills(false);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: "beta", path: betaPath });
  });

  it("does not change results when disabled skills is empty", () => {
    const { workspace, builtin } = makeWorkspace();
    writeSkill(path.join(workspace, "skills"), "alpha", { body: "# Alpha" });
    writeSkill(path.join(workspace, "skills"), "beta", { body: "# Beta" });

    expect(new SkillsLoader(workspace, builtin, new Set()).listSkills(false)).toHaveLength(2);
  });

  it("excludes disabled skills from buildSkillsSummary", () => {
    const { workspace, builtin } = makeWorkspace();
    writeSkill(path.join(workspace, "skills"), "alpha", { body: "# Alpha" });
    writeSkill(path.join(workspace, "skills"), "beta", { body: "# Beta" });

    const summary = new SkillsLoader(workspace, builtin, new Set(["alpha"])).buildSkillsSummary();

    expect(summary).not.toContain("alpha");
    expect(summary).toContain("beta");
  });

  it("excludes disabled skills from getAlwaysSkills", () => {
    const { workspace, builtin } = makeWorkspace();
    writeSkill(path.join(workspace, "skills"), "alpha", { metadataJson: { always: true }, body: "# Alpha" });
    writeSkill(path.join(workspace, "skills"), "beta", { metadataJson: { always: true }, body: "# Beta" });

    const always = new SkillsLoader(workspace, builtin, new Set(["alpha"])).getAlwaysSkills();

    expect(always).not.toContain("alpha");
    expect(always).toContain("beta");
  });

  it("does not read always from non-memmy metadata namespaces", () => {
    const { workspace, builtin } = makeWorkspace();
    const skillDir = path.join(workspace, "skills", "legacy_always");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      `---\nmetadata: ${JSON.stringify({ openclaw: { always: true }, memmy_agent: { always: true }, memmyAgent: { always: true } })}\n---\n\n# Legacy always`,
      "utf8",
    );

    expect(new SkillsLoader(workspace, builtin).getAlwaysSkills()).toEqual([]);
  });
});

describe("SkillsLoader YAML metadata", () => {
  it("parses folded descriptions in buildSkillsSummary", () => {
    const { workspace, builtin } = makeWorkspace();
    const skillDir = path.join(workspace, "skills", "pdf");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: pdf",
        "description: >",
        "  Use this skill when visual quality and design identity matter for a PDF.",
        "  CREATE (generate from scratch): \"make a PDF\".",
        "---",
        "",
        "# PDF Skill",
      ].join("\n"),
      "utf8",
    );

    const summary = new SkillsLoader(workspace, builtin).buildSkillsSummary();

    expect(summary).toContain("pdf");
    expect(summary).toContain("visual quality");
  });

  it("parses literal descriptions in getSkillMetadata", () => {
    const { workspace, builtin } = makeWorkspace();
    const skillDir = path.join(workspace, "skills", "multi");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: multi\ndescription: |\n  Line one of description.\n  Line two of description.\n---\n\n# Multi\n",
      "utf8",
    );

    const meta = new SkillsLoader(workspace, builtin).getSkillMetadata("multi");

    expect(meta?.description).toContain("Line one");
    expect(meta?.description).toContain("Line two");
  });

  it("keeps YAML-native types in skill metadata", () => {
    const { workspace, builtin } = makeWorkspace();
    const skillDir = path.join(workspace, "skills", "typed");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: typed",
        `metadata: ${JSON.stringify({ memmy: { requires: { bins: ["gh"] }, always: true } })}`,
        "always: true",
        "---",
        "",
        "# Typed",
      ].join("\n"),
      "utf8",
    );

    const meta = new SkillsLoader(workspace, builtin).getSkillMetadata("typed");

    expect(meta?.always).toBe(true);
    expect(typeof meta?.metadata).toBe("object");
  });
});
