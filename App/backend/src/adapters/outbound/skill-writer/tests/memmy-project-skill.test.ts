import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  MEMMY_PROJECT_BOOTSTRAP_END_MARKER,
  MEMMY_PROJECT_BOOTSTRAP_START_MARKER,
  removeMemmyProjectBootstrapBlock,
  renderMemmyProjectBootstrapBlock,
  renderMemmyProjectSkillFile,
  upsertMemmyProjectBootstrapBlock
} from "../templates/memmy-project-skill.js";

/** 技能是否被选中只看描述，外部 Agent 按正文决定怎么做：这几条把检索与加入的触发和做法固定住。 */
describe("memmy-project skill", () => {
  const skill = renderMemmyProjectSkillFile({ source: "claude_code" });
  const description = /^description: (.*)$/mu.exec(skill)?.[1] ?? "";

  it("puts the project skill before local code whenever a member or a project is behind the question", () => {
    // 11-05 改写描述时删掉了这句优先级，模型于是去搜本地代码而不是先查协作项目。
    expect(description).toContain("先用本技能，再查本地代码、网页或聊天记录");
    expect(description).toContain("用户不一定提到 Memmy，项目名与本地目录同名时也先当作协作项目查");
    expect(description).toContain("问到项目里以前的事，即使没提成员和项目也先查");
    expect(description).toContain("唯一入口是 memmy-project 命令");
    // 英文也保留同样的优先级：外部 Agent 按英文描述匹配。
    expect(description).toContain("Use it before searching local code");
  });

  it("keeps the description short and parseable as one YAML scalar", () => {
    expect(description.length).toBeLessThanOrEqual(1024);
    // 冒号后跟空格会被读成另一个键，整段描述就只剩前面几个字。
    expect(description).not.toMatch(/: /u);
    expect(description).not.toContain(" #");

    const frontmatter = /^---\n([\s\S]*?)\n---\n/u.exec(skill)?.[1] ?? "";
    const parsed = YAML.parse(frontmatter) as { name?: string; description?: string };
    expect(parsed.name).toBe("memmy-project");
    expect(parsed.description).toBe(description);
  });

  it("judges a collab project directory by the collab_project block, not the memory instructions block", () => {
    // `<project_instructions source="memmy">` 是本机项目指令，拿它当协作项目的依据会把两者搞反。
    expect(skill).not.toContain("project_instructions");
    expect(skill).toContain("上下文中有 Memmy 注入的 `<collab_project>` 段");
    expect(skill).toContain("上下文中有 `<collab_project>` 时，问到本项目以前的事");
    expect(skill).toContain("问代码现在是什么样，以代码为准");
  });

  it("routes requests before the command card and keeps one fenced command block", () => {
    expect(skill.indexOf("## 先分清是哪一类事")).toBeLessThan(skill.indexOf("## 命令速查"));
    const card = skill.slice(skill.indexOf("```bash"), skill.indexOf("```", skill.indexOf("```bash") + 3));
    expect(card).toContain("memmy-project list");
    expect(card).toContain("memmy-project session search");
  });
});

/** 全局指令文件里的协作项目块：五个目标共用一份文字，只换技能路径。 */
describe("memmy-project bootstrap block", () => {
  const block = renderMemmyProjectBootstrapBlock();

  it("names the skill, its relative path, and the order to check the project before code", () => {
    expect(block.startsWith(MEMMY_PROJECT_BOOTSTRAP_START_MARKER)).toBe(true);
    expect(block.trimEnd().endsWith(MEMMY_PROJECT_BOOTSTRAP_END_MARKER)).toBe(true);
    expect(block).toContain("`memmy-project` 技能安装在 `skills/memmy-project/SKILL.md`");
    expect(block).toContain("先用这个技能查，再看本地代码和文档。用户不一定提到 Memmy。");
    // 与记忆块分开：块里不提 memmy-memory，否则两件事的生命周期会混在一起。
    expect(block).not.toContain("memmy-memory");
  });

  it("appends the block after user content and leaves a missing newline alone", () => {
    expect(upsertMemmyProjectBootstrapBlock("手工写的开头")).toBe(`手工写的开头\n${block}`);
    expect(upsertMemmyProjectBootstrapBlock("手工写的开头\n")).toBe(`手工写的开头\n${block}`);
    expect(upsertMemmyProjectBootstrapBlock("")).toBe(block);
  });

  it("replaces the whole block in place instead of adding a second one", () => {
    const existing = [
      "用户的说明",
      "<!-- memmy-project:start v=1 -->",
      "旧内容",
      "<!-- memmy-project:end v=1 -->",
      "结尾",
      ""
    ].join("\n");

    const next = upsertMemmyProjectBootstrapBlock(existing);
    expect(next).toBe(["用户的说明", block.trimEnd(), "结尾", ""].join("\n"));
    expect(next.match(/memmy-project:start/gu)).toHaveLength(1);
  });

  it("removes only this block, keeping the memory block and user content", () => {
    const existing = [
      "用户的说明",
      "<!-- memmy:start v=1 -->",
      "# Memmy Memory",
      "<!-- memmy:end v=1 -->",
      "",
      block.trimEnd(),
      "结尾",
      ""
    ].join("\n");

    expect(removeMemmyProjectBootstrapBlock(existing)).toBe([
      "用户的说明",
      "<!-- memmy:start v=1 -->",
      "# Memmy Memory",
      "<!-- memmy:end v=1 -->",
      "",
      "结尾",
      ""
    ].join("\n"));
    // 没有这一块时原样返回，不要因此多写一次文件。
    expect(removeMemmyProjectBootstrapBlock("只有用户内容")).toBe("只有用户内容");
  });

  it("takes an absolute skill path for agents whose instructions file lives elsewhere", () => {
    expect(renderMemmyProjectBootstrapBlock({ skillFilePath: "/home/u/.openclaw/skills/memmy-project/SKILL.md" }))
      .toContain("`/home/u/.openclaw/skills/memmy-project/SKILL.md`");
  });
});
