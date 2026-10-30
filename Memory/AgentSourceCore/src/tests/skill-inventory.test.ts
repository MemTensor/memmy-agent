import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseSkillFrontmatter,
  readAgentSkillInventory,
  readClaudeCodePluginSkills,
  readCodexPluginSkills,
  sharedSkillRootsForAgent
} from "../skill-inventory.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "skill-inventory-"));
  roots.push(root);
  return root;
}

function writeSkill(root: string, relativeDir: string, content: string): string {
  const dir = join(root, relativeDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  writeFileSync(path, content, "utf8");
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("parseSkillFrontmatter", () => {
  it("reads folded and literal multi-line strings and booleans", () => {
    const folded = parseSkillFrontmatter("---\nname: memory-systems\ndescription: >\n  Design memory\n  for agents.\n---\nBody\n");
    expect(folded.data.description).toBe("Design memory for agents.\n");
    const literal = parseSkillFrontmatter("---\nname: humanizer\ndescription: |\n  Line one\n  Line two\ndisable-model-invocation: true\n---\n");
    expect(literal.data.description).toBe("Line one\nLine two\n");
    expect(literal.data["disable-model-invocation"]).toBe("true");
  });

  it("keeps scalars as written", () => {
    const parsed = parseSkillFrontmatter("---\nname: \"quoted-name\"\nversion: 1.0\n---\n");
    expect(parsed.data).toMatchObject({ name: "quoted-name", version: "1.0" });
  });

  it("falls back to top-level key lines when the YAML is invalid", () => {
    const parsed = parseSkillFrontmatter("---\nname: context-degradation\ndescription: Use when: the context grows\nversion: 1.0.0\n---\nBody\n");
    expect(parsed.error).toBeTruthy();
    expect(parsed.data).toMatchObject({
      name: "context-degradation",
      description: "Use when: the context grows",
      version: "1.0.0"
    });
  });

  it("treats a file without frontmatter as empty", () => {
    expect(parseSkillFrontmatter("Just text")).toEqual({ data: {} });
  });
});

describe("readAgentSkillInventory", () => {
  it("reads skill metadata, invocation policy and supporting files", async () => {
    const root = tempRoot();
    writeSkill(root, "memory-systems", "---\nname: memory-systems\nversion: 2\ndescription: >\n  Design memory\n  for agents.\n---\nBody\n");
    writeSkill(root, "memmy-resume", "---\nname: memmy-resume\ndisable-model-invocation: true\n---\nResume.\n");
    writeSkill(root, ".system/review-agent", "---\nname: review-agent\n---\nReview.\n");
    mkdirSync(join(root, ".system/review-agent/agents"), { recursive: true });
    writeFileSync(join(root, ".system/review-agent/agents/openai.yaml"), "policy:\n  allow_implicit_invocation: false\n");
    mkdirSync(join(root, "memory-systems/scripts"), { recursive: true });
    writeFileSync(join(root, "memory-systems/scripts/run.sh"), "echo hi\n");

    const inventory = await readAgentSkillInventory(root);

    expect(inventory.complete).toBe(true);
    expect(inventory.errors).toEqual([]);
    expect(inventory.items.map((item) => item.sourceSkillId)).toEqual([".system/review-agent", "memmy-resume", "memory-systems"]);
    const [review, resume, memory] = inventory.items;
    expect(review).toMatchObject({ name: "review-agent", allowImplicitInvocation: false, disableModelInvocation: false, hasSupportingFiles: true });
    expect(resume).toMatchObject({ name: "memmy-resume", disableModelInvocation: true, hasSupportingFiles: false });
    expect(resume).not.toHaveProperty("allowImplicitInvocation");
    expect(memory).toMatchObject({
      name: "memory-systems",
      version: "2",
      description: "Design memory for agents.",
      hasSupportingFiles: true,
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
  });

  it("keeps a skill whose frontmatter or policy cannot be parsed and records why", async () => {
    const root = tempRoot();
    writeSkill(root, "broken", "---\nname: broken\ndescription: Use when: it breaks\n---\nBody\n");
    writeSkill(root, "bad-policy", "---\nname: bad-policy\n---\nBody\n");
    mkdirSync(join(root, "bad-policy/agents"), { recursive: true });
    writeFileSync(join(root, "bad-policy/agents/openai.yaml"), "policy: [unclosed\n");

    const inventory = await readAgentSkillInventory(root);

    expect(inventory.complete).toBe(true);
    expect(inventory.items.map((item) => item.name)).toEqual(["bad-policy", "broken"]);
    expect(inventory.items[0]?.policyError).toBeTruthy();
    expect(inventory.items[0]).not.toHaveProperty("allowImplicitInvocation");
    expect(inventory.items[1]?.frontmatterError).toBeTruthy();
    expect(inventory.items[1]?.description).toBe("Use when: it breaks");
  });

  it("treats a missing root as an empty, complete inventory", async () => {
    await expect(readAgentSkillInventory(join(tempRoot(), "missing"))).resolves.toEqual({ complete: true, items: [], errors: [] });
  });

  it("follows symlinked skill directories once and skips broken links and excluded names", async () => {
    const root = tempRoot();
    const skills = join(root, "skills");
    writeSkill(root, "shared/linked-skill", "---\nname: linked-skill\n---\nLinked.\n");
    writeSkill(skills, "plain", "---\nname: plain\n---\nPlain.\n");
    writeSkill(skills, "memmy-memory", "internal");
    symlinkSync(join(root, "shared/linked-skill"), join(skills, "linked-skill"), "junction");
    symlinkSync(join(root, "missing-target"), join(skills, "broken-skill"), "junction");
    symlinkSync(skills, join(skills, "plain", "loop"), "junction");

    const inventory = await readAgentSkillInventory(skills);

    expect(inventory.complete).toBe(true);
    expect(inventory.items.map((item) => item.sourceSkillId)).toEqual(["linked-skill", "plain"]);
  });

  it("marks the inventory incomplete when a SKILL.md cannot be read", async () => {
    if (process.getuid?.() === 0) return;
    const root = tempRoot();
    writeSkill(root, "readable", "---\nname: readable\n---\n");
    const unreadable = writeSkill(root, "unreadable", "---\nname: unreadable\n---\n");
    chmodSync(unreadable, 0o000);
    try {
      const inventory = await readAgentSkillInventory(root);
      expect(inventory.complete).toBe(false);
      expect(inventory.items.map((item) => item.sourceSkillId)).toEqual(["readable"]);
      expect(inventory.errors).toEqual([expect.objectContaining({ path: unreadable })]);
    } finally {
      chmodSync(unreadable, 0o644);
    }
  });
});

describe("plugin skill inventories", () => {
  it("lists skills of enabled Claude Code plugins only", async () => {
    const home = tempRoot();
    const enabledPath = join(home, "plugins/cache/market/superpowers/6.0.3");
    const disabledPath = join(home, "plugins/cache/market/other/1.0.0");
    writeSkill(enabledPath, "skills/brainstorming", "---\nname: brainstorming\n---\nBody\n");
    writeSkill(disabledPath, "skills/other-skill", "---\nname: other-skill\n---\nBody\n");
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      enabledPlugins: { "superpowers@market": true, "other@market": false }
    }));
    writeFileSync(join(home, "plugins/installed_plugins.json"), JSON.stringify({
      version: 2,
      plugins: {
        "superpowers@market": [{ scope: "user", installPath: enabledPath }],
        "other@market": [{ scope: "user", installPath: disabledPath }]
      }
    }));

    const inventory = await readClaudeCodePluginSkills(home);

    expect(inventory).toEqual({
      complete: true,
      errors: [],
      items: [{ pluginId: "superpowers@market", name: "brainstorming", sourceSkillPath: join(enabledPath, "skills/brainstorming/SKILL.md") }]
    });
  });

  it("lists skills of enabled Codex plugins from the plugin cache", async () => {
    const home = tempRoot();
    writeSkill(home, "plugins/cache/superpowers-marketplace/superpowers/7.0.1/skills/writing-plans", "---\nname: writing-plans\n---\nBody\n");
    writeSkill(home, "plugins/cache/openai-curated/slack/abc/skills/slack-post", "---\nname: slack-post\n---\nBody\n");
    writeFileSync(join(home, "config.toml"), [
      'model = "x"',
      '[plugins."superpowers@superpowers-marketplace"]',
      "enabled = true",
      '[plugins."slack@openai-curated"]',
      "enabled = false",
      '[plugins."missing@nowhere"]',
      "enabled = true"
    ].join("\n"));

    const inventory = await readCodexPluginSkills(home);

    expect(inventory.complete).toBe(true);
    expect(inventory.items.map((item) => [item.pluginId, item.name])).toEqual([
      ["superpowers@superpowers-marketplace", "writing-plans"]
    ]);
  });

  it("reads only the most recently written version of a cached Codex plugin", async () => {
    const home = tempRoot();
    const pluginDir = join(home, "plugins/cache/superpowers-marketplace/superpowers");
    writeSkill(pluginDir, "6.0.0/skills/removed-skill", "---\nname: removed-skill\n---\n");
    writeSkill(pluginDir, "7.0.1/skills/writing-plans", "---\nname: writing-plans\n---\n");
    utimesSync(join(pluginDir, "6.0.0"), new Date("2026-01-01"), new Date("2026-01-01"));
    utimesSync(join(pluginDir, "7.0.1"), new Date("2026-06-01"), new Date("2026-06-01"));
    writeFileSync(join(home, "config.toml"), '[plugins."superpowers@superpowers-marketplace"]\nenabled = true\n');

    const inventory = await readCodexPluginSkills(home);

    expect(inventory.items.map((item) => item.name)).toEqual(["writing-plans"]);
  });

  it("maps the shared ~/.agents/skills root to the Agents that load it", () => {
    expect(sharedSkillRootsForAgent("codex", "/home/me")).toEqual([{ id: "agents", root: "/home/me/.agents/skills" }]);
    expect(sharedSkillRootsForAgent("claude_code", "/home/me")).toEqual([]);
  });

  it("reports an unreadable Codex config as incomplete", async () => {
    const home = tempRoot();
    writeFileSync(join(home, "config.toml"), "[plugins\nbroken");

    const inventory = await readCodexPluginSkills(home);

    expect(inventory.complete).toBe(false);
    expect(inventory.items).toEqual([]);
  });
});
