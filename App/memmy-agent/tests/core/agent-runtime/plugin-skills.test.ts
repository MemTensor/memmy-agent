import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SkillsLoader } from "../../../src/core/agent-runtime/skills.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-discovery-")); roots.push(root);
  const pluginSkillsRoot = path.join(root, "skills"), pluginDataRoot = path.join(root, "data");
  const directory = path.join(pluginDataRoot, "fixture.capture", "exports");
  fs.mkdirSync(directory, { recursive: true }); fs.mkdirSync(pluginSkillsRoot);
  const content = "---\nname: captured-example\ndescription: Run the demonstrated workflow\n---\nCall the owning plugin with the validated plan.";
  fs.writeFileSync(path.join(directory, "SKILL.md"), content);
  const index = path.join(pluginSkillsRoot, "active.json");
  const entry = { pluginId: "fixture.capture", name: "captured-example", directory,
    files: { "SKILL.md": createHash("sha256").update(content).digest("hex") } };
  fs.writeFileSync(index, JSON.stringify([entry]));
  const workspace = path.join(root, "workspace"), builtin = path.join(root, "builtin");
  const options = { pluginSkillsRoot, pluginDataRoot };
  return { root, directory, index, entry, workspace, builtin, options };
}
describe("plugin skills in conversation discovery", () => {
  it("marks generated skills unavailable when a required tool disappears", () => {
    const f = fixture(), content = "---\nname: captured-example\ndescription: A recorded task\nmetadata:\n  memmy:\n    requires:\n      tools: [write_file]\n---\nWrite the requested output.";
    fs.writeFileSync(path.join(f.directory, "SKILL.md"), content);
    f.entry.files["SKILL.md"] = createHash("sha256").update(content).digest("hex"); fs.writeFileSync(f.index, JSON.stringify([f.entry]));
    const loader = new SkillsLoader(f.workspace, f.builtin, null, f.options);
    loader.availableTools = () => [];
    expect(loader.listSkills(true)).toEqual([]); expect(loader.buildSkillsSummary()).toContain("Tool: write_file");
    loader.availableTools = () => ["write_file"]; expect(loader.listSkills(true)).toHaveLength(1);
  });
  it("discovers next-turn contributions and withdraws them immediately on disable or tampering", () => {
    const f = fixture(), loader = new SkillsLoader(f.workspace, f.builtin, null, f.options);
    expect(loader.findExplicitSkillNames("Please run $captured-example")).toEqual(["captured-example"]);
    expect(loader.buildSkillsSummary()).toContain("Run the demonstrated workflow");
    expect(loader.loadSkillsForContext(["captured-example"])).toContain("owning plugin");
    fs.writeFileSync(f.index, "[]");
    expect(loader.listSkills()).toEqual([]); expect(loader.loadSkill("captured-example")).toBeNull();
    fs.writeFileSync(f.index, JSON.stringify([f.entry]));
    expect(loader.listSkills()).toHaveLength(1);
    fs.appendFileSync(path.join(f.directory, "SKILL.md"), "modified");
    expect(loader.listSkills()).toEqual([]); expect(loader.loadSkill("captured-example")).toBeNull();
  });
  it("preserves workspace precedence, disabled skills and explicit-root isolation", () => {
    const f = fixture();
    const disabled = new SkillsLoader(f.workspace, f.builtin, ["captured-example"], f.options);
    expect(disabled.listSkills()).toEqual([]); expect(disabled.loadSkill("captured-example")).toBeNull();
    const isolated = new SkillsLoader([f.workspace, f.builtin], null, null, f.options);
    expect(isolated.listSkills()).toEqual([]); expect(isolated.loadSkill("captured-example")).toBeNull();
    const override = path.join(f.workspace, "skills", "captured-example"); fs.mkdirSync(override, { recursive: true });
    fs.writeFileSync(path.join(override, "SKILL.md"), "# Workspace override");
    const loader = new SkillsLoader(f.workspace, f.builtin, null, f.options);
    expect(loader.listSkills()).toMatchObject([{ name: "captured-example", source: "workspace" }]);
    expect(loader.loadSkill("captured-example")).toBe("# Workspace override");
  });
});
