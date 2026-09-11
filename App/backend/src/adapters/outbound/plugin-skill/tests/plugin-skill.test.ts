import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPluginSkillManager } from "../index.js";
import type { PluginRuntimeRecord } from "../../plugin-runtime/types.js";

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

describe("PluginSkillManager", () => {
  it("registers and unregisters a packaged skill with plugin ownership", async () => {
    root = mkdtempSync(join(tmpdir(), "memmy-plugin-skill-"));
    const artifact = join(root, "artifact");
    const skillsRoot = join(root, "workspace", "skills");
    mkdirSync(join(artifact, "skills", "review", "references"), { recursive: true });
    writeFileSync(join(artifact, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: test\n---\nUse it.");
    writeFileSync(join(artifact, "skills", "review", "references", "guide.md"), "guide");
    const manager = createPluginSkillManager({ skillsRoot });
    await manager.activate(plugin(artifact));
    expect(readFileSync(join(skillsRoot, "review", "SKILL.md"), "utf8")).toContain("Use it.");
    expect(readFileSync(join(skillsRoot, "review", "references", "guide.md"), "utf8")).toBe("guide");
    await manager.deactivate("com.example.review");
    expect(() => readFileSync(join(skillsRoot, "review", "SKILL.md"), "utf8")).toThrow();
  });
});

function plugin(rootPath: string): PluginRuntimeRecord {
  const now = new Date().toISOString();
  return {
    id: "com.example.review", version: "1.0.0", state: "active", approvedPermissions: [], config: {},
    artifactHash: "hash", rootPath, lastError: null, createdAt: now, updatedAt: now,
    manifest: {
      apiVersion: "memmy/v1", id: "com.example.review", name: "Review", version: "1.0.0",
      runtime: { adapter: "command", config: { command: "runtime/review" } },
      capabilities: [{ id: "run", name: "Run", description: "Run", inputSchema: {}, outputSchema: {}, execution: "request" }],
      permissions: [],
      skills: [{ id: "review", name: "Review", description: "Review", entry: "skills/review/SKILL.md" }]
    }
  };
}
