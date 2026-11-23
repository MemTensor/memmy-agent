/** Skill distribution service tests. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSkillTargetRegistry } from "../../adapters/outbound/skill-writer/target-registry.js";
import { replaceMemmySkillDirectory } from "../../adapters/outbound/skill-writer/skill-directory.js";
import { renderMemmyDefaultSkillManifest } from "../../adapters/outbound/skill-writer/templates/memmy-default.js";
import {
  MEMMY_PROJECT_BOOTSTRAP_START_MARKER,
  removeMemmyProjectBootstrapBlock,
  renderMemmyProjectBootstrapBlock,
  upsertMemmyProjectBootstrapBlock
} from "../../adapters/outbound/skill-writer/templates/memmy-project-skill.js";
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

// 项目钩子的安装条件：已接入记忆钩子，或已授权协作且没被关掉；旧版记忆钩子先跳过。
describe("project hook synchronization", () => {
  it("installs the project hook for an agent whose memory hook is connected", async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "memmy-project-hook-memory-"));
    try {
      const target = createFakeProjectTarget({ rootDirectory, memoryInstalled: true, memoryCurrent: true });
      const service = createSkillDistributionService({
        targetRegistry: createSkillTargetRegistry([target.target]),
        projectSkillPermission: async () => ({ granted: false, disabledAgents: [] })
      });

      await expect(service.syncProjectHooks?.()).resolves.toEqual(["cursor"]);
      expect(target.installed).toBe(true);

      // 已经是当前版本：不必重复写入。
      await expect(service.syncProjectHooks?.()).resolves.toEqual([]);
    } finally {
      rmSync(rootDirectory, { recursive: true, force: true });
    }
  });

  it("installs the project hook for an authorized agent without a memory hook", async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "memmy-project-hook-collab-"));
    try {
      const target = createFakeProjectTarget({ rootDirectory, memoryInstalled: false });
      const service = createSkillDistributionService({
        targetRegistry: createSkillTargetRegistry([target.target]),
        projectSkillPermission: async () => ({ granted: true, disabledAgents: [] })
      });

      await expect(service.syncProjectHooks?.()).resolves.toEqual(["cursor"]);
      expect(target.installed).toBe(true);
    } finally {
      rmSync(rootDirectory, { recursive: true, force: true });
    }
  });

  it("removes the project hook when neither condition holds", async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "memmy-project-hook-none-"));
    try {
      const target = createFakeProjectTarget({ rootDirectory, memoryInstalled: false, installed: true });
      const service = createSkillDistributionService({
        targetRegistry: createSkillTargetRegistry([target.target]),
        projectSkillPermission: async () => ({ granted: false, disabledAgents: [] })
      });

      await expect(service.syncProjectHooks?.()).resolves.toEqual(["cursor"]);
      expect(target.installed).toBe(false);
    } finally {
      rmSync(rootDirectory, { recursive: true, force: true });
    }
  });

  it("keeps the project hook on revoke for an agent whose memory hook is connected", async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "memmy-project-hook-revoke-"));
    try {
      const target = createFakeProjectTarget({ rootDirectory, memoryInstalled: true, memoryCurrent: true, installed: true });
      const service = createSkillDistributionService({
        targetRegistry: createSkillTargetRegistry([target.target]),
        projectSkillPermission: async () => ({ granted: false, disabledAgents: [] })
      });

      await expect(service.syncProjectHooks?.()).resolves.toEqual([]);
      expect(target.installed).toBe(true);
    } finally {
      rmSync(rootDirectory, { recursive: true, force: true });
    }
  });

  it("skips the old memory hook so project instructions are not injected twice", async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "memmy-project-hook-stale-memory-"));
    try {
      const target = createFakeProjectTarget({ rootDirectory, memoryInstalled: true, memoryCurrent: false });
      const service = createSkillDistributionService({
        targetRegistry: createSkillTargetRegistry([target.target]),
        projectSkillPermission: async () => ({ granted: true, disabledAgents: [] })
      });

      await expect(service.syncProjectHooks?.()).resolves.toEqual([]);
      expect(target.installed).toBe(false);

      // 旧版记忆钩子留在磁盘上而项目钩子已经装过：移除，避免两处同时注入。
      target.installed = true;
      await expect(service.syncProjectHooks?.()).resolves.toEqual(["cursor"]);
      expect(target.installed).toBe(false);
    } finally {
      rmSync(rootDirectory, { recursive: true, force: true });
    }
  });

  it("refreshes a stale project hook and updates for a given agent only", async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "memmy-project-hook-stale-"));
    try {
      const target = createFakeProjectTarget({
        rootDirectory,
        memoryInstalled: true,
        memoryCurrent: true,
        installed: true,
        current: false
      });
      const service = createSkillDistributionService({
        targetRegistry: createSkillTargetRegistry([target.target])
      });

      await expect(service.syncProjectHooks?.(["other"])).resolves.toEqual([]);
      await expect(service.syncProjectHooks?.(["cursor"])).resolves.toEqual(["cursor"]);
      expect(target.installs).toBe(1);
    } finally {
      rmSync(rootDirectory, { recursive: true, force: true });
    }
  });

  it("keeps going when one agent fails", async () => {
    const first = mkdtempSync(join(tmpdir(), "memmy-project-hook-fail-a-"));
    const second = mkdtempSync(join(tmpdir(), "memmy-project-hook-fail-b-"));
    try {
      const failing = createFakeProjectTarget({
        rootDirectory: first,
        targetId: "codex",
        memoryInstalled: true,
        memoryCurrent: true,
        failInstall: true
      });
      const working = createFakeProjectTarget({ rootDirectory: second, memoryInstalled: true, memoryCurrent: true });
      const service = createSkillDistributionService({
        targetRegistry: createSkillTargetRegistry([failing.target, working.target])
      });

      await expect(service.syncProjectHooks?.()).resolves.toEqual(["cursor"]);
      expect(working.installed).toBe(true);
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });
});

/** 项目钩子用到的四个方法与记忆钩子状态的假目标：不碰真实用户目录。 */
function createFakeProjectTarget(options: {
  rootDirectory: string;
  targetId?: string;
  memoryInstalled: boolean;
  memoryCurrent?: boolean;
  installed?: boolean;
  current?: boolean;
  failInstall?: boolean;
}): {
  target: SkillTarget;
  installed: boolean;
  installs: number;
} {
  const state = {
    installed: options.installed ?? false,
    installs: 0
  };
  const target: SkillTarget = {
    targetId: options.targetId ?? "cursor",
    displayName: options.targetId === "codex" ? "Codex" : "Cursor",
    async resolveRootDirectory() {
      return options.rootDirectory;
    },
    async install() {},
    async uninstall() {},
    async isInstalled() {
      return false;
    },
    async isMemoryHookInstalled() {
      return options.memoryInstalled;
    },
    async isInstalledHookCurrent() {
      return options.memoryCurrent ?? false;
    },
    async installProjectHook() {
      if (options.failInstall) throw new Error("project hook install failed");
      state.installs += 1;
      state.installed = true;
    },
    async uninstallProjectHook() {
      state.installed = false;
    },
    async isProjectHookInstalled() {
      return state.installed;
    },
    async isProjectHookCurrent() {
      return options.current ?? true;
    }
  };
  return {
    target,
    get installed() {
      return state.installed;
    },
    set installed(value: boolean) {
      state.installed = value;
    },
    get installs() {
      return state.installs;
    }
  };
}

describe("project skill authorization", () => {
  const denied = async () => ({ granted: false, disabledAgents: [] as string[] });

  it("writes nothing on startup while collaboration is not authorized", async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "memmy-agent-project-denied-"));
    try {
      const service = createSkillDistributionService({
        targetRegistry: createSkillTargetRegistry([createFakeTarget({ resolveRootDirectory: () => rootDirectory })]),
        projectSkillPermission: denied
      });
      await expect(service.ensureProjectSkills()).resolves.toEqual([]);
      expect(existsSync(join(rootDirectory, "skills", "memmy-project"))).toBe(false);
    } finally {
      rmSync(rootDirectory, { recursive: true, force: true });
    }
  });

  it("still refreshes the memory skill but leaves the project skill out", async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "memmy-agent-project-memory-only-"));
    try {
      await replaceMemmySkillDirectory(rootDirectory, { targetId: "cursor", content: "## Agent Loop\nold", marker: "m" });
      const service = createSkillDistributionService({
        targetRegistry: createSkillTargetRegistry([createFakeTarget({ resolveRootDirectory: () => rootDirectory })]),
        projectSkillPermission: denied
      });

      await expect(service.refreshInstalledSkill("cursor")).resolves.toBe(true);
      expect(readFileSync(join(rootDirectory, "skills", "memmy-memory", "SKILL.md"), "utf8")).toContain("## Agent Loop");
      expect(existsSync(join(rootDirectory, "skills", "memmy-project"))).toBe(false);
    } finally {
      rmSync(rootDirectory, { recursive: true, force: true });
    }
  });

  it("skips the agents turned off and can install or remove one on demand", async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "memmy-agent-project-per-agent-"));
    try {
      const present = join(rootDirectory, "cursor-home");
      mkdirSync(present);
      const service = createSkillDistributionService({
        targetRegistry: createSkillTargetRegistry([createFakeTarget({ resolveRootDirectory: () => present })]),
        projectSkillPermission: async () => ({ granted: true, disabledAgents: ["cursor"] })
      });

      await expect(service.ensureProjectSkills()).resolves.toEqual([]);
      await expect(service.installProjectSkill("cursor")).resolves.toBeUndefined();
      await expect(service.hasProjectSkill("cursor")).resolves.toBe(true);
      await service.removeProjectSkill("cursor");
      await expect(service.hasProjectSkill("cursor")).resolves.toBe(false);
    } finally {
      rmSync(rootDirectory, { recursive: true, force: true });
    }
  });
});

/**
 * 全局指令块跟着协作授权走，不跟记忆接入走：授权时装上、撤销时删掉、关掉的 Agent 不写。
 * 这里用一个把块真的写进 AGENTS.md 的目标，保证读写与真实 target 的行为一致。
 */
describe("project skill bootstrap block lifecycle", () => {
  const granted = async () => ({ granted: true, disabledAgents: [] as string[] });

  it("writes the block when the project skill is installed and keeps it current", async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "memmy-agent-project-block-install-"));
    try {
      const service = createSkillDistributionService({
        targetRegistry: createSkillTargetRegistry([createBootstrapTarget(rootDirectory)]),
        projectSkillPermission: granted
      });

      await service.installProjectSkill("cursor");
      expect(existsSync(join(rootDirectory, "skills", "memmy-project", "SKILL.md"))).toBe(true);
      expect(readInstructions(rootDirectory)).toContain(MEMMY_PROJECT_BOOTSTRAP_START_MARKER);

      // 都已经是这一版：再次启动时什么都不写。
      await expect(service.ensureProjectSkills()).resolves.toEqual([]);
    } finally {
      rmSync(rootDirectory, { recursive: true, force: true });
    }
  });

  it("brings an out-of-date block back when the skill itself is already current", async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "memmy-agent-project-block-stale-"));
    try {
      const service = createSkillDistributionService({
        targetRegistry: createSkillTargetRegistry([createBootstrapTarget(rootDirectory)]),
        projectSkillPermission: granted
      });
      await service.installProjectSkill("cursor");
      writeFileSync(
        join(rootDirectory, "AGENTS.md"),
        ["用户的说明", "<!-- memmy-project:start v=1 -->", "旧内容", "<!-- memmy-project:end v=1 -->", ""].join("\n"),
        "utf8"
      );

      // 技能目录没变，只差这一块：ensure 不能因为技能最新就整段跳过。
      await expect(service.ensureProjectSkills()).resolves.toEqual(["cursor"]);
      const instructions = readInstructions(rootDirectory);
      expect(instructions).not.toContain("旧内容");
      expect(instructions).toContain("先用这个技能查，再看本地代码和文档");
      expect(instructions).toContain("用户的说明");
    } finally {
      rmSync(rootDirectory, { recursive: true, force: true });
    }
  });

  it("removes the block together with the skill when authorization is withdrawn", async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "memmy-agent-project-block-remove-"));
    try {
      const service = createSkillDistributionService({
        targetRegistry: createSkillTargetRegistry([createBootstrapTarget(rootDirectory)]),
        projectSkillPermission: granted
      });
      await service.installProjectSkill("cursor");

      await expect(service.removeProjectSkills()).resolves.toEqual(["cursor"]);
      expect(existsSync(join(rootDirectory, "skills", "memmy-project"))).toBe(false);
      expect(readInstructions(rootDirectory)).not.toContain("memmy-project:");

      // 单个移除也一样，只删这一个 Agent 的块。
      await service.installProjectSkill("cursor");
      await service.removeProjectSkill("cursor");
      expect(readInstructions(rootDirectory)).not.toContain("memmy-project:");
    } finally {
      rmSync(rootDirectory, { recursive: true, force: true });
    }
  });

  it("leaves the block out for an agent that is turned off, even when installing it on demand", async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), "memmy-agent-project-block-disabled-"));
    try {
      const service = createSkillDistributionService({
        targetRegistry: createSkillTargetRegistry([createBootstrapTarget(rootDirectory)]),
        projectSkillPermission: async () => ({ granted: true, disabledAgents: ["cursor"] })
      });

      await expect(service.ensureProjectSkills()).resolves.toEqual([]);
      expect(existsSync(join(rootDirectory, "AGENTS.md"))).toBe(false);

      await service.installProjectSkill("cursor");
      expect(existsSync(join(rootDirectory, "skills", "memmy-project", "SKILL.md"))).toBe(true);
      expect(existsSync(join(rootDirectory, "AGENTS.md"))).toBe(false);
    } finally {
      rmSync(rootDirectory, { recursive: true, force: true });
    }
  });

  it("keeps installing the other agents when one agent cannot write its block", async () => {
    const brokenDirectory = mkdtempSync(join(tmpdir(), "memmy-agent-project-block-broken-"));
    const workingDirectory = mkdtempSync(join(tmpdir(), "memmy-agent-project-block-working-"));
    try {
      const service = createSkillDistributionService({
        targetRegistry: createSkillTargetRegistry([
          {
            ...createBootstrapTarget(brokenDirectory),
            writeProjectSkillBootstrap: async () => {
              throw new Error("disk is read-only");
            }
          },
          { ...createBootstrapTarget(workingDirectory), targetId: "codex", displayName: "Codex" }
        ]),
        projectSkillPermission: granted
      });

      // 一个 Agent 写不下块，不影响它自己的技能，也不影响另一个 Agent。
      await expect(service.ensureProjectSkills()).resolves.toEqual(["cursor", "codex"]);
      expect(readInstructions(brokenDirectory)).not.toContain(MEMMY_PROJECT_BOOTSTRAP_START_MARKER);
      expect(existsSync(join(brokenDirectory, "skills", "memmy-project", "SKILL.md"))).toBe(true);
      expect(readInstructions(workingDirectory)).toContain(MEMMY_PROJECT_BOOTSTRAP_START_MARKER);
    } finally {
      rmSync(brokenDirectory, { recursive: true, force: true });
      rmSync(workingDirectory, { recursive: true, force: true });
    }
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

/** 把协作块写进 AGENTS.md 的目标，其余能力与 skill-only 的 Agent 一样。 */
function createBootstrapTarget(rootDirectory: string): SkillTarget {
  return {
    targetId: "cursor",
    displayName: "Cursor",
    async resolveRootDirectory() {
      return rootDirectory;
    },
    async install() {},
    async uninstall() {},
    async isInstalled() {
      return false;
    },
    async writeProjectSkillBootstrap() {
      const filePath = join(rootDirectory, "AGENTS.md");
      const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
      writeFileSync(filePath, upsertMemmyProjectBootstrapBlock(existing), "utf8");
    },
    async removeProjectSkillBootstrap() {
      const filePath = join(rootDirectory, "AGENTS.md");
      if (!existsSync(filePath)) return;
      writeFileSync(filePath, removeMemmyProjectBootstrapBlock(readFileSync(filePath, "utf8")), "utf8");
    },
    async isProjectSkillBootstrapCurrent() {
      const filePath = join(rootDirectory, "AGENTS.md");
      if (!existsSync(filePath)) return false;
      return readFileSync(filePath, "utf8").includes(renderMemmyProjectBootstrapBlock());
    }
  };
}

function readInstructions(rootDirectory: string): string {
  const filePath = join(rootDirectory, "AGENTS.md");
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
}
