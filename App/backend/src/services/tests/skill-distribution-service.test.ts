/** Skill distribution service tests. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSkillTargetRegistry } from "../../adapters/outbound/skill-writer/target-registry.js";
import { replaceMemmySkillDirectory } from "../../adapters/outbound/skill-writer/skill-directory.js";
import { renderMemmyDefaultSkillManifest } from "../../adapters/outbound/skill-writer/templates/memmy-default.js";
import type { MemoryPluginConflict, SkillManifest, SkillTarget } from "../../adapters/outbound/skill-writer/types.js";
import { createSkillDistributionService } from "../skill-distribution-service.js";

describe("skill distribution service", () => {
  it("scans other Agent skills as source-attributed immutable versions", async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "memmy-agent-skills-"));
    try {
      mkdirSync(join(rootDirectory, "skills", "review-code"), { recursive: true });
      mkdirSync(join(rootDirectory, "skills", "memmy-memory"), { recursive: true });
      writeFileSync(
        join(rootDirectory, "skills", "review-code", "SKILL.md"),
        "---\nname: review-code\nversion: 2\n---\nReview changed code.\n",
        "utf8"
      );
      writeFileSync(join(rootDirectory, "skills", "memmy-memory", "SKILL.md"), "internal", "utf8");
      const service = createSkillDistributionService({
        targetRegistry: createSkillTargetRegistry([
          createFakeTarget({ resolveRootDirectory: () => rootDirectory })
        ])
      });

      await expect(service.listSkills?.("cursor")).resolves.toEqual([
        expect.objectContaining({
          sourceAgentId: "cursor",
          sourceSkillId: "review-code",
          sourceSkillVersion: "2",
          title: "review-code",
          content: expect.stringContaining("Review changed code."),
          sourceContentHash: expect.stringMatching(/^[a-f0-9]{64}$/)
        })
      ]);
    } finally {
      rmSync(rootDirectory, { recursive: true, force: true });
    }
  });

  it("skips broken directory links while scanning valid sibling skills", async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "memmy-agent-broken-skill-link-"));
    try {
      mkdirSync(join(rootDirectory, "skills", "valid-skill"), { recursive: true });
      writeFileSync(
        join(rootDirectory, "skills", "valid-skill", "SKILL.md"),
        "---\nname: valid-skill\n---\nStill discoverable.\n",
        "utf8"
      );
      symlinkSync(
        join(rootDirectory, "missing-skill-target"),
        join(rootDirectory, "skills", "broken-skill"),
        "junction"
      );
      const service = createSkillDistributionService({
        targetRegistry: createSkillTargetRegistry([
          createFakeTarget({ resolveRootDirectory: () => rootDirectory })
        ])
      });

      await expect(service.listSkills?.("cursor")).resolves.toEqual([
        expect.objectContaining({ sourceSkillId: "valid-skill" })
      ]);
    } finally {
      rmSync(rootDirectory, { recursive: true, force: true });
    }
  });

  it("renders and installs the fixed Memmy skill manifest", async () => {
    let installed: SkillManifest | undefined;
    const service = createSkillDistributionService({
      targetRegistry: createSkillTargetRegistry([createFakeTarget({ install: (manifest) => (installed = manifest) })])
    });

    await service.install("cursor");

    expect(installed).toMatchObject({
      targetId: "cursor",
      marker: "<!-- memmy:start v=1 -->"
    });
    expect(installed?.content).toContain("# Memmy Memory CLI Skill");
    expect(installed?.content).toContain("memmy-memory turn start");
    expect(installed?.content).toContain("memmy-memory turn complete");
    expect(installed?.content).toContain('memmy-memory search "query text"');
    expect(installed?.content).toContain("memmy-memory session open --source cursor");
    expect(installed?.content).toContain("memmy-memory turn start --source cursor");
    expect(installed?.content).toContain('memmy-memory turn complete "$TURN_ID" --source cursor');
    expect(installed?.content).toContain('memmy-memory search "query text" --source cursor');
    expect(installed?.content).toContain('memmy-memory add "The user prefers concise Chinese status updates." --title "User preference: status style" --tags user-preference --source cursor');
    expect(installed?.content).not.toContain("--layer");
    expect(installed?.content).not.toContain("/panel/");
    expect(installed?.content).not.toContain("Panel Debugging");
  });

  it("rejects skill install when the target root directory is unavailable", async () => {
    let installCalled = false;
    const service = createSkillDistributionService({
      targetRegistry: createSkillTargetRegistry([
        createFakeTarget({
          resolveRootDirectory: () => null,
          install: () => {
            installCalled = true;
          }
        })
      ])
    });

    await expect(service.install("cursor")).rejects.toMatchObject({
      code: "agent_source_unavailable",
      message: "Cursor is not installed or its directory is unavailable"
    });
    expect(installCalled).toBe(false);
  });

  it("delegates uninstall to the target registry", async () => {
    const calls: string[] = [];
    const service = createSkillDistributionService({
      targetRegistry: createSkillTargetRegistry([createFakeTarget({ uninstall: (targetId) => calls.push(targetId) })])
    });

    await service.uninstall("cursor");

    expect(calls).toEqual(["cursor"]);
  });

  it("reads hook currency from targets that publish it", async () => {
    const current = createSkillDistributionService({
      targetRegistry: createSkillTargetRegistry([
        createFakeTarget({ isInstalledHookCurrent: async () => true })
      ])
    });
    const outdated = createSkillDistributionService({
      targetRegistry: createSkillTargetRegistry([
        createFakeTarget({ isInstalledHookCurrent: async () => false })
      ])
    });
    const untouched = createSkillDistributionService({
      targetRegistry: createSkillTargetRegistry([createFakeTarget({})])
    });

    await expect(current.isInstalledHookCurrent?.("cursor")).resolves.toBe(true);
    await expect(outdated.isInstalledHookCurrent?.("cursor")).resolves.toBe(false);
    await expect(untouched.isInstalledHookCurrent?.("cursor")).resolves.toBe(true);
    await expect(untouched.isInstalledHookCurrent?.("missing")).resolves.toBe(true);
  });

  it("delegates native plugin installation to plugin-capable targets", async () => {
    const calls: string[] = [];
    const service = createSkillDistributionService({
      targetRegistry: createSkillTargetRegistry([
        createFakeTarget({
          installPlugin: (targetId) => calls.push(`plugin:${targetId}`),
          install: (manifest) => calls.push(`skill:${manifest.targetId}`)
        })
      ])
    });

    await service.installPlugin("cursor");

    expect(calls).toEqual(["plugin:cursor"]);
  });

  it("rejects native plugin install when the target root directory is unavailable", async () => {
    let installPluginCalled = false;
    const service = createSkillDistributionService({
      targetRegistry: createSkillTargetRegistry([
        createFakeTarget({
          resolveRootDirectory: () => null,
          installPlugin: () => {
            installPluginCalled = true;
          }
        })
      ])
    });

    await expect(service.installPlugin("cursor")).rejects.toMatchObject({
      code: "agent_source_unavailable",
      message: "Cursor is not installed or its directory is unavailable"
    });
    expect(installPluginCalled).toBe(false);
  });

  it("uninstalls native plugin and Skill when the target supports plugins", async () => {
    const calls: string[] = [];
    const service = createSkillDistributionService({
      targetRegistry: createSkillTargetRegistry([
        createFakeTarget({
          uninstallPlugin: (targetId) => calls.push(`plugin:${targetId}`),
          uninstall: (targetId) => calls.push(`skill:${targetId}`)
        })
      ])
    });

    await service.uninstallPlugin("cursor");

    expect(calls).toEqual(["plugin:cursor", "skill:cursor"]);
  });

  it("rejects native plugin install for targets without plugin support", async () => {
    const service = createSkillDistributionService({
      targetRegistry: createSkillTargetRegistry([createFakeTarget({})])
    });

    await expect(service.installPlugin("cursor")).rejects.toThrow("Native plugin installation is not supported");
  });

  it("rejects native plugin uninstall for targets without plugin support", async () => {
    const service = createSkillDistributionService({
      targetRegistry: createSkillTargetRegistry([createFakeTarget({})])
    });

    await expect(service.uninstallPlugin("cursor")).rejects.toThrow("Native plugin uninstallation is not supported");
  });

  it("collects memory plugin conflicts from plugin-aware targets", async () => {
    const service = createSkillDistributionService({
      targetRegistry: createSkillTargetRegistry([
        createFakeTarget({
          detectMemoryPluginConflict: () => ({
            sourceId: "cursor",
            displayName: "Cursor",
            configPath: "/tmp/cursor/config.json",
            installedPluginId: "other-memory"
          })
        })
      ])
    });

    await expect(service.detectMemoryPluginConflicts?.()).resolves.toEqual([
      {
        sourceId: "cursor",
        displayName: "Cursor",
        configPath: "/tmp/cursor/config.json",
        installedPluginId: "other-memory"
      }
    ]);
  });

  it("rewrites a stale skill-only agent's skill in place, leaving its instructions file alone", async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "memmy-agent-skill-refresh-"));
    try {
      await replaceMemmySkillDirectory(rootDirectory, { targetId: "cursor", content: "## Agent Loop\nold", marker: "m" });
      let installed = 0;
      const service = createSkillDistributionService({
        targetRegistry: createSkillTargetRegistry([
          createFakeTarget({ resolveRootDirectory: () => rootDirectory, install: () => { installed += 1; } })
        ])
      });

      await expect(service.refreshInstalledSkill("cursor")).resolves.toBe(true);
      // The skill directory is rewritten directly; install() would also add memory guidance to AGENTS.md.
      expect(installed).toBe(0);
      const content = readFileSync(join(rootDirectory, "skills", "memmy-memory", "SKILL.md"), "utf8");
      expect(content).toContain("## Agent Loop");
      // Project sessions are a skill of their own, next to the memory skill.
      expect(content).not.toContain("memmy-project");
      expect(readFileSync(join(rootDirectory, "skills", "memmy-project", "SKILL.md"), "utf8")).toContain("name: memmy-project");
    } finally {
      rmSync(rootDirectory, { recursive: true, force: true });
    }
  });

  it("installs the session skill into an existing agent home that never had Memmy", async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "memmy-agent-session-only-"));
    const missing = join(rootDirectory, "missing-agent");
    try {
      const present = join(rootDirectory, "cursor-home");
      mkdirSync(present);
      const service = createSkillDistributionService({
        targetRegistry: createSkillTargetRegistry([
          createFakeTarget({ resolveRootDirectory: () => present }),
          { ...createFakeTarget({ resolveRootDirectory: () => missing }), targetId: "codex", displayName: "Codex" }
        ])
      });

      await expect(service.ensureProjectSkills()).resolves.toEqual(["cursor"]);
      expect(readFileSync(join(present, "skills", "memmy-project", "SKILL.md"), "utf8")).toContain("name: memmy-project");
      await expect(service.ensureProjectSkills()).resolves.toEqual([]);
    } finally {
      rmSync(rootDirectory, { recursive: true, force: true });
    }
  });

  it("leaves an agent with no Memmy skill alone", async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "memmy-agent-no-skill-"));
    try {
      let installed = 0;
      const service = createSkillDistributionService({
        targetRegistry: createSkillTargetRegistry([
          createFakeTarget({ resolveRootDirectory: () => rootDirectory, install: () => { installed += 1; } })
        ])
      });

      await expect(service.refreshInstalledSkill("cursor")).resolves.toBe(false);
      expect(installed).toBe(0);
    } finally {
      rmSync(rootDirectory, { recursive: true, force: true });
    }
  });

  it("leaves a connected agent alone when its skill already matches this build", async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "memmy-agent-skill-current-"));
    try {
      await replaceMemmySkillDirectory(rootDirectory, renderMemmyDefaultSkillManifest("cursor"));
      let installed = 0;
      const service = createSkillDistributionService({
        targetRegistry: createSkillTargetRegistry([
          createFakeTarget({ resolveRootDirectory: () => rootDirectory, install: () => { installed += 1; } })
        ])
      });

      // Connected before the session skill existed: only the session skill is added.
      await expect(service.refreshInstalledSkill("cursor", "skill")).resolves.toBe(true);
      expect(readFileSync(join(rootDirectory, "skills", "memmy-project", "SKILL.md"), "utf8")).toContain("name: memmy-project");
      await expect(service.refreshInstalledSkill("cursor", "skill")).resolves.toBe(false);
      expect(installed).toBe(0);
    } finally {
      rmSync(rootDirectory, { recursive: true, force: true });
    }
  });

  it("reinstalls the plugin for a hook agent so its skill carries the new section", async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "memmy-agent-plugin-refresh-"));
    try {
      await replaceMemmySkillDirectory(rootDirectory, { targetId: "cursor", content: "## Automatic Memory\nold", marker: "m" });
      let reinstalled = 0;
      const service = createSkillDistributionService({
        targetRegistry: createSkillTargetRegistry([
          createFakeTarget({ resolveRootDirectory: () => rootDirectory, installPlugin: () => { reinstalled += 1; } })
        ])
      });

      await expect(service.refreshInstalledSkill("cursor", "plugin")).resolves.toBe(true);
      expect(reinstalled).toBe(1);
    } finally {
      rmSync(rootDirectory, { recursive: true, force: true });
    }
  });

  it("skips providers that are not installed on this computer", async () => {
    const service = createSkillDistributionService({
      targetRegistry: createSkillTargetRegistry([createFakeTarget({ resolveRootDirectory: () => null })])
    });

    await expect(service.refreshInstalledSkill("cursor", "skill")).resolves.toBe(false);
  });
});

function createFakeTarget(overrides: {
  resolveRootDirectory?: () => string | null;
  install?: (manifest: SkillManifest) => void;
  uninstall?: (targetId: string) => void;
  installPlugin?: (targetId: string) => void;
  uninstallPlugin?: (targetId: string) => void;
  isInstalledHookCurrent?: () => Promise<boolean>;
  detectMemoryPluginConflict?: () => MemoryPluginConflict | null;
}): SkillTarget {
  return {
    targetId: "cursor",
    displayName: "Cursor",
    async resolveRootDirectory() {
      return "resolveRootDirectory" in overrides ? overrides.resolveRootDirectory?.() ?? null : "/tmp/cursor/rules";
    },
    async install(manifest) {
      overrides.install?.(manifest);
    },
    async uninstall(targetId) {
      overrides.uninstall?.(targetId);
    },
    async isInstalled() {
      return false;
    },
    installPlugin: overrides.installPlugin
      ? async (targetId) => {
          overrides.installPlugin?.(targetId);
        }
      : undefined,
    uninstallPlugin: overrides.uninstallPlugin
      ? async (targetId) => {
          overrides.uninstallPlugin?.(targetId);
        }
      : undefined,
    detectMemoryPluginConflict: overrides.detectMemoryPluginConflict
      ? async () => overrides.detectMemoryPluginConflict?.() ?? null
      : undefined,
    isInstalledHookCurrent: overrides.isInstalledHookCurrent
  };
}
