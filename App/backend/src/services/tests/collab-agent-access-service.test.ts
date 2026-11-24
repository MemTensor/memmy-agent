import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SourceRegistry } from "@memmy/agent-source-readers/adapters/source-registry";
import type { SkillTarget } from "../../adapters/outbound/skill-writer/types.js";
import { createSkillTargetRegistry } from "../../adapters/outbound/skill-writer/target-registry.js";
import {
  MEMMY_PROJECT_BOOTSTRAP_START_MARKER,
  removeMemmyProjectBootstrapBlock,
  renderMemmyProjectBootstrapBlock,
  upsertMemmyProjectBootstrapBlock
} from "../../adapters/outbound/skill-writer/templates/memmy-project-skill.js";
import { readCollabAgentAccess, writeCollabAgentAccess } from "../collab-agent-access.js";
import { createCollabAgentAccessService } from "../collab-agent-access-service.js";
import { createSkillDistributionService, type SkillDistributionService } from "../skill-distribution-service.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-collab-access-"));
  roots.push(root);
  return root;
}

/** 只有 descriptor 与 detect 会被授权服务用到，其余字段照适配器的形状补齐。 */
function registry(agents: Array<{ sourceId: string; displayName: string; detected: boolean }>): SourceRegistry {
  return {
    list: () => agents.map((agent) => ({
      descriptor: { sourceId: agent.sourceId, displayName: agent.displayName },
      detect: async () => agent.detected
    }))
  } as unknown as SourceRegistry;
}

/** 记下装与卸的调用，不碰真实技能目录。 */
function skillDistribution(options: { installed?: string[]; failFor?: string[] } = {}) {
  const installed = new Set(options.installed ?? []);
  const calls: string[] = [];
  const service = {
    async hasProjectSkill(sourceId: string) {
      return installed.has(sourceId);
    },
    async installProjectSkill(sourceId: string) {
      calls.push(`install:${sourceId}`);
      if (options.failFor?.includes(sourceId)) throw new Error("技能目录不存在");
      installed.add(sourceId);
    },
    async removeProjectSkill(sourceId: string) {
      calls.push(`remove:${sourceId}`);
      installed.delete(sourceId);
    },
    async removeProjectSkills() {
      const removed = [...installed];
      removed.forEach((sourceId) => calls.push(`remove:${sourceId}`));
      installed.clear();
      return removed;
    },
    async syncProjectHooks(sourceIds?: readonly string[]) {
      calls.push(`sync:${sourceIds ? sourceIds.join(",") : "all"}`);
      return [];
    }
  } as unknown as SkillDistributionService;
  return { service, calls, installed };
}

function access(
  homeDirectory: string,
  agents: Array<{ sourceId: string; displayName: string; detected: boolean }>,
  distribution: SkillDistributionService
) {
  return createCollabAgentAccessService({
    homeDirectory,
    skillDistributionService: distribution,
    sourceRegistry: registry(agents)
  });
}

const AGENTS = [
  { sourceId: "cursor", displayName: "Cursor", detected: true },
  { sourceId: "codex", displayName: "Codex", detected: true },
  { sourceId: "workbuddy", displayName: "WorkBuddy", detected: false }
];

describe("collab agent access", () => {
  it("starts unauthorized and remembers what was written", async () => {
    const dir = home();
    await expect(readCollabAgentAccess(dir)).resolves.toEqual({ granted: false, askedInProject: false, disabledAgents: [] });

    await writeCollabAgentAccess({ granted: true, askedInProject: true, disabledAgents: ["cursor", "cursor"] }, dir);
    // 重复的 Agent 只留一条，文件里也是这个内容。
    await expect(readCollabAgentAccess(dir)).resolves.toEqual({ granted: true, askedInProject: true, disabledAgents: ["cursor"] });
    expect(JSON.parse(readFileSync(join(dir, "collab-agent-access.json"), "utf8")).disabledAgents).toEqual(["cursor"]);
  });

  it("treats a broken file as not authorized rather than open", async () => {
    const dir = home();
    await writeCollabAgentAccess({ granted: true, askedInProject: false, disabledAgents: [] }, dir);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "collab-agent-access.json"), "{ not json", "utf8");
    await expect(readCollabAgentAccess(dir)).resolves.toEqual({ granted: false, askedInProject: false, disabledAgents: [] });
  });

  it("lists the agents found on this computer, plus the ones with the skill already installed", async () => {
    const dir = home();
    const { service } = skillDistribution({ installed: ["workbuddy"] });
    const view = await access(dir, AGENTS, service).view();
    // 没检测到、但技能目录里还装着组件的 Agent 仍然要列出来，否则没法关掉它。
    expect(view.agents.map((agent) => [agent.sourceId, agent.installed])).toEqual([
      ["cursor", false],
      ["codex", false],
      ["workbuddy", true]
    ]);
    expect(view.agents.every((agent) => agent.enabled)).toBe(true);
  });

  it("installs into every enabled agent on grant and reports the ones that failed", async () => {
    const dir = home();
    const { service, calls } = skillDistribution({ failFor: ["codex"] });
    const instance = access(dir, AGENTS, service);

    const result = await instance.setGranted(true);
    expect(result.view.granted).toBe(true);
    expect(calls).toEqual(["install:cursor", "install:codex", "sync:all"]);
    expect(result.results.map((item) => [item.sourceId, item.ok])).toEqual([
      ["cursor", true],
      ["codex", false]
    ]);
    expect(result.results[1]?.message).toContain("技能目录不存在");
    // 状态要在写完之后读：装上的显示已安装，装失败的那个仍是未安装。
    expect(result.view.agents.map((agent) => [agent.sourceId, agent.installed])).toEqual([
      ["cursor", true],
      ["codex", false]
    ]);
  });

  it("skips an agent turned off in settings when installing", async () => {
    const dir = home();
    const { service, calls } = skillDistribution();
    const instance = access(dir, AGENTS, service);
    await instance.setAgentEnabled("cursor", false);
    expect(calls).toEqual(["remove:cursor", "sync:cursor"]);

    await instance.setGranted(true);
    expect(calls).toEqual(["remove:cursor", "sync:cursor", "install:codex", "sync:all"]);
  });

  it("removes every project skill on revoke and keeps the linked tasks alone", async () => {
    const dir = home();
    const { service, calls } = skillDistribution();
    const instance = access(dir, AGENTS, service);
    await instance.setGranted(true);
    calls.length = 0;

    const result = await instance.setGranted(false);
    expect(result.view.granted).toBe(false);
    // 组件一并移除；已关联的任务留在项目里，授权服务不碰它们。
    // 项目钩子不能一律移除：已接入记忆钩子的 Agent 还要继续拿到本机项目指令，交给同步按条件判断。
    expect(calls).toEqual(["remove:cursor", "remove:codex", "sync:all"]);
  });

  it("lets no agent be read until the person authorizes it", async () => {
    const dir = home();
    const { service } = skillDistribution();
    const instance = access(dir, AGENTS, service);
    await expect(instance.readableSourceIds()).resolves.toEqual([]);

    await instance.setGranted(true);
    await expect(instance.readableSourceIds()).resolves.toEqual(["cursor", "codex", "workbuddy"]);

    await instance.setAgentEnabled("codex", false);
    await expect(instance.readableSourceIds()).resolves.toEqual(["cursor", "workbuddy"]);
  });

  it("leaves the agents the person added themselves out of the authorization", async () => {
    const dir = home();
    // 手动添加的 Agent 存在 collab-agents.json：添加它们本身就是那一下授权，不归这一项管。
    const skills = join(dir, "proma-skills");
    mkdirSync(skills, { recursive: true });
    writeFileSync(join(dir, "collab-agents.json"), JSON.stringify({
      agents: [{
        sourceId: "added-proma-60e42686",
        displayName: "Proma",
        skillDirectory: skills,
        updatedAt: "2026-11-01T00:00:00.000Z"
      }]
    }));
    const { service, calls } = skillDistribution();
    const instance = access(dir, AGENTS, service);

    const view = await instance.view();
    // 只列内置且本机有这个 Agent 的；手动添加的 Proma 不出现，没检测到的 WorkBuddy 也不出现。
    expect(view.agents.map((agent) => agent.sourceId)).toEqual(["cursor", "codex"]);
    expect(view.agents.some((agent) => agent.added)).toBe(false);

    await instance.setGranted(true);
    expect(calls).toEqual(["install:cursor", "install:codex", "sync:all"]);
    // 撤销只收回内置 Agent 的组件，不去动已经手动添加的那个。
    await instance.setGranted(false);
    expect(calls).toEqual([
      "install:cursor", "install:codex", "sync:all",
      "remove:cursor", "remove:codex", "sync:all"
    ]);
    expect(existsSync(join(skills, "memmy-project", "SKILL.md"))).toBe(false);
  });

  it("syncs the project hooks for one agent when it is turned off or on", async () => {
    const dir = home();
    const { service, calls } = skillDistribution();
    const instance = access(dir, AGENTS, service);
    await instance.setGranted(true);
    calls.length = 0;

    await instance.setAgentEnabled("codex", false);
    expect(calls).toEqual(["remove:codex", "sync:codex"]);

    calls.length = 0;
    await instance.setAgentEnabled("codex", true);
    expect(calls).toEqual(["install:codex", "sync:codex"]);
  });

  it("does not write anything when asked to reinstall without an authorization", async () => {
    const dir = home();
    const { service, calls } = skillDistribution();
    const instance = access(dir, AGENTS, service);

    const result = await instance.install(["cursor"]);
    expect(result.results).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("records the in-project question so it is asked only once", async () => {
    const dir = home();
    const { service } = skillDistribution();
    const instance = access(dir, AGENTS, service);
    await instance.markAsked();
    await expect(instance.read()).resolves.toEqual({ granted: false, askedInProject: true, disabledAgents: [] });
  });
});

/**
 * 协作授权与全局指令块：块由技能分发服务按授权写入，授权服务只是调用方。这里用真的分发服务，
 * 配一个把块写进 AGENTS.md 的目标，验证「授权后写入、撤销后移除、关掉的 Agent 不写」。
 */
describe("collab agent access and the project block", () => {
  function agentHome(): string {
    const root = mkdtempSync(join(tmpdir(), "memmy-collab-access-agent-"));
    roots.push(root);
    return root;
  }

  function distributionOver(homeDirectory: string, agentRoot: string) {
    return createSkillDistributionService({
      targetRegistry: createSkillTargetRegistry([bootstrapTarget(agentRoot)]),
      projectSkillPermission: async () => await readCollabAgentAccess(homeDirectory)
    });
  }

  it("writes the block when authorized and removes it when withdrawn", async () => {
    const dir = home();
    const agentRoot = agentHome();
    const instance = access(dir, AGENTS, distributionOver(dir, agentRoot));

    await instance.setGranted(true);
    expect(readFileSync(join(agentRoot, "AGENTS.md"), "utf8")).toContain(MEMMY_PROJECT_BOOTSTRAP_START_MARKER);
    expect(readFileSync(join(agentRoot, "skills", "memmy-project", "SKILL.md"), "utf8")).toContain("name: memmy-project");

    await instance.setGranted(false);
    expect(existsSync(join(agentRoot, "skills", "memmy-project"))).toBe(false);
    expect(readFileSync(join(agentRoot, "AGENTS.md"), "utf8")).not.toContain("memmy-project:");
  });

  it("keeps the block out for an agent turned off before the authorization", async () => {
    const dir = home();
    const agentRoot = agentHome();
    const instance = access(dir, AGENTS, distributionOver(dir, agentRoot));

    await instance.setAgentEnabled("cursor", false);
    await instance.setGranted(true);

    expect(existsSync(join(agentRoot, "skills", "memmy-project"))).toBe(false);
    expect(existsSync(join(agentRoot, "AGENTS.md"))).toBe(false);

    // 打开后按需安装，块跟着技能一起补上。
    await instance.setAgentEnabled("cursor", true);
    expect(readFileSync(join(agentRoot, "AGENTS.md"), "utf8")).toContain(MEMMY_PROJECT_BOOTSTRAP_START_MARKER);
  });
});

/** 把协作块写进 AGENTS.md 的目标，其余能力与 skill-only 的 Agent 一样。 */
function bootstrapTarget(rootDirectory: string): SkillTarget {
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
