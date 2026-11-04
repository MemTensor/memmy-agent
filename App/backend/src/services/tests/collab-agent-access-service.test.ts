import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SourceRegistry } from "@memmy/agent-source-readers/adapters/source-registry";
import { readCollabAgentAccess, writeCollabAgentAccess } from "../collab-agent-access.js";
import { createCollabAgentAccessService } from "../collab-agent-access-service.js";
import type { SkillDistributionService } from "../skill-distribution-service.js";

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
    expect(calls).toEqual(["install:cursor", "install:codex"]);
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
    expect(calls).toEqual(["remove:cursor"]);

    await instance.setGranted(true);
    expect(calls).toEqual(["remove:cursor", "install:codex"]);
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
    expect(calls).toEqual(["remove:cursor", "remove:codex"]);
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
    expect(calls).toEqual(["install:cursor", "install:codex"]);
    // 撤销只收回内置 Agent 的组件，不去动已经手动添加的那个。
    await instance.setGranted(false);
    expect(calls).toEqual(["install:cursor", "install:codex", "remove:cursor", "remove:codex"]);
    expect(existsSync(join(skills, "memmy-project", "SKILL.md"))).toBe(false);
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
