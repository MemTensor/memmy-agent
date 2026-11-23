/** Skill distribution service tests. */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSkillTargetRegistry } from "../../adapters/outbound/skill-writer/target-registry.js";
import type { MemoryPluginConflict, SkillManifest, SkillTarget } from "../../adapters/outbound/skill-writer/types.js";
import { createSkillDistributionService } from "../skill-distribution-service.js";

import { createCodexSkillTarget } from "../../adapters/outbound/skill-writer/codex/index.js";
import { createClaudeCodeSkillTarget } from "../../adapters/outbound/skill-writer/claude-code/index.js";
import { createCursorSkillTarget } from "../../adapters/outbound/skill-writer/cursor/index.js";
import { createOpencodeSkillTarget } from "../../adapters/outbound/skill-writer/opencode/index.js";
import { createOpenclawSkillTarget } from "../../adapters/outbound/skill-writer/openclaw/index.js";
import { createHermesSkillTarget } from "../../adapters/outbound/skill-writer/hermes/index.js";
import { createDeepseekHarnessSkillTarget } from "../../adapters/outbound/skill-writer/deepseek-harness/index.js";

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

it.each(["skill", "plugin"])("checks revocation after asynchronous root resolution before writing %s", async kind => {
  let release!: (root: string) => void;
  const held = new Promise<string>(resolve => { release = resolve; });
  let allowed = true;
  let installed = false;
  const target = {
    ...createFakeTarget({ installPlugin() { installed = true; }, install() { installed = true; } }),
    resolveRootDirectory: () => held
  };
  const service = createSkillDistributionService({ targetRegistry: createSkillTargetRegistry([target]) });
  const guard = () => { if (!allowed) throw new Error("revoked"); };
  const pending = kind === "skill" ? service.install("cursor", guard) : service.installPlugin("cursor", guard);
  allowed = false;
  release("/synthetic");
  await expect(pending).rejects.toThrow("revoked");
  expect(installed).toBe(false);
});

const pluginPresenceCases = [
  ["codex", createCodexSkillTarget, "hooks/memmy-memory-resume-hook.mjs", "hooks.json"],
  ["claude_code", createClaudeCodeSkillTarget, "hooks/memmy-memory-resume-hook.mjs", "settings.json"],
  ["cursor", createCursorSkillTarget, "hooks/memmy-memory-resume-hook.mjs", "hooks.json"],
  ["opencode", createOpencodeSkillTarget, "plugins/memmy-memory.js", "opencode.json"],
  ["openclaw", createOpenclawSkillTarget, "extensions/memmy-memory/index.mjs", "openclaw.json"],
  ["hermes", createHermesSkillTarget, "plugins/memmy-memory/plugin.yaml", "config.yaml"],
  ["deepseek_harness", createDeepseekHarnessSkillTarget, "profiles/node_modules/@memmy/memmy-memory/index.mjs", "cordis.patch.yml"]
] as const;

describe("official plugin installation presence", () => {
  it.each(pluginPresenceCases)("%s distinguishes old plugin files from unrelated configuration", async (_id, createTarget, pluginPath, configFile) => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "memmy-plugin-presence-"));
    try {
      const target = createTarget({ rootDirectory, memmyConfigPath: join(rootDirectory, "memmy.json") });
      writeFileSync(join(rootDirectory, configFile), "{}");
      expect(await target.isPluginInstalled?.()).toBe(false);
      const filePath = join(rootDirectory, pluginPath);
      mkdirSync(join(filePath, ".."), { recursive: true });
      writeFileSync(filePath, "old Memmy plugin version");
      expect(await target.isPluginInstalled?.()).toBe(true);
    } finally { rmSync(rootDirectory, { recursive: true, force: true }); }
  });

  it.each(pluginPresenceCases)("%s propagates unreadable installation paths before mutation", async (_id, createTarget, pluginPath) => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "memmy-plugin-permission-"));
    const directory = join(rootDirectory, pluginPath, "..");
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(rootDirectory, pluginPath), "old plugin");
      chmodSync(directory, 0);
      const target = createTarget({ rootDirectory, memmyConfigPath: join(rootDirectory, "memmy.json") });
      await expect(target.isPluginInstalled?.()).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      chmodSync(directory, 0o700);
      rmSync(rootDirectory, { recursive: true, force: true });
    }
  });
});


it.each(["skill", "plugin"] as const)("preserves custom target integrations when plugin presence is unknown during %s rollback", async (kind) => {
  const rootDirectory = mkdtempSync(join(tmpdir(), "memmy-custom-plugin-presence-"));
  const removed: string[] = [];
  try {
    const service = createSkillDistributionService({ targetRegistry: createSkillTargetRegistry([
      createFakeTarget({ resolveRootDirectory: () => rootDirectory,
        installPlugin() {}, uninstall() { removed.push("skill"); }, uninstallPlugin() { removed.push("plugin"); } })
    ]) });
    const before = await service.readInstallationState!("cursor");
    expect(before).toEqual({ skillInstalled: false, pluginInstalled: undefined });
    await service.rollbackInstallation!("cursor", kind, before);
    expect(removed).toEqual([]);
  } finally { rmSync(rootDirectory, { recursive: true, force: true }); }
});
