import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collabSourceId,
  connectCollabAgent,
  loadCollabAgents,
  refreshCollabAgentSkills,
  removeCollabAgent
} from "../collab-added-agents.js";
import { renderMemmyProjectSkillFile } from "../../adapters/outbound/skill-writer/templates/memmy-project-skill.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "collab-agent-"));
  roots.push(root);
  return root;
}

describe("adding an agent", () => {
  it("installs the skill variant that submits tasks, and saves only the name and folder", async () => {
    const root = await tempDir();
    const home = join(root, "home");
    const skills = join(root, "skills");
    await mkdir(skills);

    const result = await connectCollabAgent({ name: "Kimi Code", skillDirectory: skills, homeDirectory: home });

    expect(result.text).toContain("已添加 Kimi Code。");
    expect(result.text).toContain("直接说「把这个任务加入 <项目名称>」");
    expect(result.text).not.toContain("试读到");
    const skill = await readFile(result.skillPath, "utf8");
    // 用户添加的 Agent 靠自己提交：技能里给出 --agent/--file，并说明 Memmy 读不到它的记录。
    expect(skill).toContain('memmy-project session add --agent "Kimi Code"');
    expect(skill).toContain("Memmy 读不到「Kimi Code」的任务记录");
    expect(skill).not.toContain("--submit");
    // 技能里提到 memmy-memory 只是为了划清边界，不会让 Agent 去装它。
    expect(skill).not.toContain("安装 memmy-memory");

    const saved = await loadCollabAgents(home);
    expect(saved).toEqual([{
      sourceId: collabSourceId("Kimi Code"),
      displayName: "Kimi Code",
      skillDirectory: skills,
      updatedAt: expect.any(String)
    }]);
    // 不再保存读取规则：这一版没有解读别人记录的能力。
    expect(saved[0]).not.toHaveProperty("rule");
  });

  it("refuses an agent Memmy already reads, instead of listing it twice", async () => {
    const root = await tempDir();
    const skills = join(root, "skills");
    await mkdir(skills);
    await expect(connectCollabAgent({
      name: "deepseek harness",
      skillDirectory: skills,
      homeDirectory: join(root, "home")
    })).rejects.toThrow(/已经能读取 DeepSeek Harness/u);
    expect(await loadCollabAgents(join(root, "home"))).toEqual([]);
    // 大小写与空格不同也认得出，不需要用户写成产品名。
    await expect(connectCollabAgent({
      name: "claude code",
      skillDirectory: skills,
      homeDirectory: join(root, "home")
    })).rejects.toThrow(/已经能读取 Claude Code/u);
  });

  it("refuses a skills folder that does not exist, and does not create one", async () => {
    const root = await tempDir();
    const missing = join(root, "nope", "skills");
    await expect(connectCollabAgent({
      name: "Kimi Code",
      skillDirectory: missing,
      homeDirectory: join(root, "home")
    })).rejects.toThrow(/技能目录不存在/u);
    expect(existsSync(missing)).toBe(false);
  });

  it("removes the installed skill and forgets the agent", async () => {
    const root = await tempDir();
    const home = join(root, "home");
    const skills = join(root, "skills");
    await mkdir(skills);
    const { skillPath } = await connectCollabAgent({ name: "Kimi Code", skillDirectory: skills, homeDirectory: home });

    expect(await removeCollabAgent("Kimi Code", home)).toContain("已移除 Kimi Code");
    expect(existsSync(skillPath)).toBe(false);
    expect(await loadCollabAgents(home)).toEqual([]);
  });

  it("keeps source ids inside the collaboration id limit", () => {
    expect(collabSourceId("一个很长的中文名称用来测试边界")).toMatch(/^added-agent-[a-f0-9]{8}$/u);
  });
});

describe("refreshing added agents' skills", () => {
  it("rewrites an outdated skill and leaves a current one alone", async () => {
    const root = await tempDir();
    const home = join(root, "home");
    const skills = join(root, "skills");
    await mkdir(skills);
    const { skillPath } = await connectCollabAgent({ name: "Kimi Code", skillDirectory: skills, homeDirectory: home });
    expect(await refreshCollabAgentSkills({ homeDirectory: home })).toBe(0);

    // 旧版本装的是另一份内容：启动时要换成当前版本。
    await writeFile(skillPath, "# 旧版本\n", "utf8");
    expect(await refreshCollabAgentSkills({ homeDirectory: home })).toBe(1);
    expect(await readFile(skillPath, "utf8")).toBe(renderMemmyProjectSkillFile({ agentName: "Kimi Code" }));
  });

  it("skips an agent whose skills folder is gone, without recreating it", async () => {
    const root = await tempDir();
    const home = join(root, "home");
    const skills = join(root, "skills");
    await mkdir(skills);
    await connectCollabAgent({ name: "Kimi Code", skillDirectory: skills, homeDirectory: home });
    await rm(skills, { recursive: true, force: true });

    expect(await refreshCollabAgentSkills({ homeDirectory: home })).toBe(0);
    expect(existsSync(skills)).toBe(false);
    // 记录保留：用户可能只是临时换了目录，不该因为一次启动就丢掉配置。
    expect(await loadCollabAgents(home)).toHaveLength(1);
  });
});
