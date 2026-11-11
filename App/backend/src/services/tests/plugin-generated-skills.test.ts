import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createGeneratedPluginSkills } from "../plugin-generated-skills.js";
import { listPluginSkills } from "../../../../memmy-agent/src/core/agent-runtime/plugin-skills.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "plugin-skills-")); roots.push(root);
  const data = join(root, "data"), skills = join(root, "skills"), directory = join(data, "fixture.capture", "session", "exports");
  mkdirSync(directory, { recursive: true });
  const text = "---\nname: captured-example\ndescription: Run a demonstrated task\n---\nRun the plugin capability.";
  writeFileSync(join(directory, "SKILL.md"), text); writeFileSync(join(data, "fixture.capture", "plan.json"), "{}");
  const entry = { name: "captured-example", directory, files: { "SKILL.md": hash(text) }, checks: { "plan.json": hash("{}") } };
  const store = createGeneratedPluginSkills(data, join(skills, "active.json"));
  return { root, data, skills, directory, entry, store };
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
describe("generated plugin skill lifecycle", () => {
  it("keeps generated names separate from user/workspace and packaged static contributions", async () => {
    const f = fixture(), workspace = join(f.root, "workspace-skills");
    mkdirSync(join(workspace, f.entry.name), { recursive: true }); writeFileSync(join(workspace, f.entry.name, "SKILL.md"), "user content");
    const guarded = createGeneratedPluginSkills(f.data, join(f.skills, "guarded.json"), workspace);
    await expect(guarded.publish("fixture.capture", f.entry)).rejects.toThrow("static or workspace");
    await f.store.publish("fixture.capture", f.entry); await f.store.activate("fixture.capture");
    await expect(f.store.assertStaticNames("other", [f.entry.name])).rejects.toThrow("generated skill");
    expect(readFileSync(join(workspace, f.entry.name, "SKILL.md"), "utf8")).toBe("user content");
  });

  it("registers only active owners, deactivates without deleting data, and restores after reinstall", async () => {
    const f = fixture(); await f.store.reset(); await f.store.publish("fixture.capture", f.entry);
    expect(listPluginSkills(f.skills, f.data)).toEqual([]);
    await f.store.activate("fixture.capture"); expect(listPluginSkills(f.skills, f.data)).toHaveLength(1);
    await f.store.deactivate("fixture.capture"); expect(listPluginSkills(f.skills, f.data)).toEqual([]);
    expect(readFileSync(join(f.directory, "SKILL.md"), "utf8")).toContain("demonstrated");
    const reinstalled = createGeneratedPluginSkills(f.data, join(f.skills, "active.json"));
    await reinstalled.reset(); await reinstalled.activate("fixture.capture"); expect(listPluginSkills(f.skills, f.data)).toHaveLength(1);
  });
  it("withdraws a changed bundle or changed source plan immediately", async () => {
    const f = fixture(); await f.store.publish("fixture.capture", f.entry); await f.store.activate("fixture.capture");
    writeFileSync(join(f.data, "fixture.capture", "plan.json"), "tampered"); expect(listPluginSkills(f.skills, f.data)).toEqual([]);
    writeFileSync(join(f.data, "fixture.capture", "plan.json"), "{}");
    writeFileSync(join(f.directory, "SKILL.md"), "tampered"); expect(listPluginSkills(f.skills, f.data)).toEqual([]);
  });
  it("rejects traversal, symlinks, hash mismatches and another plugin's data", async () => {
    const f = fixture();
    await expect(f.store.publish("fixture.capture", { ...f.entry, name: "../escape" })).rejects.toThrow();
    await expect(f.store.publish("fixture.capture", { ...f.entry, files: { "../SKILL.md": hash("wrong") } })).rejects.toThrow();
    await expect(f.store.publish("fixture.capture", { ...f.entry, files: { "SKILL.md": "a".repeat(64) } })).rejects.toThrow("hash");
    mkdirSync(join(f.data, "other")); await expect(f.store.publish("other", f.entry)).rejects.toThrow("escapes");
    symlinkSync(join(f.directory, "SKILL.md"), join(f.directory, "link.md"));
    await expect(f.store.publish("fixture.capture", { ...f.entry, files: { ...f.entry.files, "link.md": f.entry.files["SKILL.md"] } })).rejects.toThrow("Unsafe");
  });
  it("removes a deleted skill from persisted contributions", async () => {
    const f = fixture(); await f.store.publish("fixture.capture", f.entry); await f.store.activate("fixture.capture");
    await f.store.remove("fixture.capture", f.entry.name); expect(listPluginSkills(f.skills, f.data)).toEqual([]);
    await f.store.activate("fixture.capture"); expect(listPluginSkills(f.skills, f.data)).toEqual([]);
  });

  it("refuses conflicting contributions from another active owner without overwriting retained skills", async () => {
    const f = fixture(); await f.store.publish("fixture.capture", f.entry); await f.store.activate("fixture.capture");
    const directory = join(f.data, "other", "exports"); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "SKILL.md"), readFileSync(join(f.directory, "SKILL.md")));
    writeFileSync(join(f.data, "other", "plan.json"), "{}");
    await expect(f.store.publish("other", { ...f.entry, directory })).rejects.toThrow("another active plugin");
    await f.store.deactivate("fixture.capture"); await f.store.publish("other", { ...f.entry, directory }); await f.store.activate("other");
    await expect(f.store.activate("fixture.capture")).rejects.toThrow("conflicts");
    expect(readFileSync(join(f.directory, "SKILL.md"), "utf8")).toContain("demonstrated");
  });
});
