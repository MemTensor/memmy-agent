/** Skill distribution service tests. */
import { describe, expect, it } from "vitest";
import { createSkillTargetRegistry } from "../../adapters/outbound/skill-writer/target-registry.js";
import type { MemoryPluginConflict, SkillManifest, SkillTarget } from "../../adapters/outbound/skill-writer/types.js";
import { createSkillDistributionService } from "../skill-distribution-service.js";

describe("skill distribution service", () => {
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
});

function createFakeTarget(overrides: {
  resolveRootDirectory?: () => string | null;
  install?: (manifest: SkillManifest) => void;
  uninstall?: (targetId: string) => void;
  installPlugin?: (targetId: string) => void;
  uninstallPlugin?: (targetId: string) => void;
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
      : undefined
  };
}
