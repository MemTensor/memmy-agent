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

/** 技能是否被选中只看描述，外部 Agent 按正文决定怎么做：这几条把成员协助的触发与等待方式固定住。 */
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

  it("describes the three kinds of work, including the indirect ways people ask for a member's computer", () => {
    expect(description).toContain("处理三类事");
    expect(description).toContain("我这复现不了，请体验者那边查一下日志和版本");
    expect(description).toContain("需要的信息只在别人的电脑上时，用第三类");
    // 描述是一行 YAML 标量：冒号后跟空格会被读成另一个键。
    expect(description).not.toMatch(/: /u);
  });

  it("routes requests before the command card and keeps one fenced command block", () => {
    expect(skill.indexOf("## 先分清是哪一类事")).toBeLessThan(skill.indexOf("## 命令速查"));
    const card = skill.slice(skill.indexOf("```bash"), skill.indexOf("```", skill.indexOf("```bash") + 3));
    expect(card).toContain("memmy-project assist ask");
    expect(card).toContain("每次最多 90 秒");
  });

  it("tells an external agent to wait in 90-second rounds without resending", () => {
    expect(skill).toContain("用 `memmy-project assist wait <请求 ID>` 等待结果。每次最多等 90 秒");
    expect(skill).toContain("不要重新发请求");
    // 由哪一位执行由对方选；要指定跑什么则改成脚本附件，不贴进正文。
    expect(skill).toContain("不指定由哪个 Agent 执行");
    expect(skill).not.toContain("--timeout 600");
  });

  it("points an agent at attachments for anything that must run as-is", () => {
    // 发起方 Agent 否则会继续把脚本压进正文，附件永远用不上。
    expect(skill).toContain("\"attachments\": [");
    // 每个附件都要写清是什么、怎么用：对方的 Agent 只拿到一个目录里的几个文件，没有说明只能按文件名猜。
    expect(skill).toContain("每项写 `path` 与 `note`");
    expect(skill).toContain("对方的 Agent 只能从 `note` 知道文件的用途");
    expect(skill).toContain("\"note\": \"排查脚本，");
    expect(skill).toContain("由你自己写文件生成，不要让用户手工准备");
    expect(skill).toContain("要指定对方跑什么，就写成脚本文件放进 `attachments`，不要贴进正文");
    expect(skill).toContain("正文只写要拿到什么结果和必要的判断依据");
    expect(skill).toContain("不放密钥、令牌与内部地址");
    // 旧说法「对方的 Agent 自己决定怎么查」会把脚本赶回正文。
    expect(skill).not.toContain("不写具体命令：对方的 Agent 自己决定怎么查");
  });

  it("tells the agent about the safety check on both sides", () => {
    // 请求会被退回：不写明对象与原因时发起方 Agent 得知道要改什么、不要绕过。
    expect(skill).toContain("### 安全检查");
    // 只有对方的 Memmy 会做模型审查：发起方这边只按规则查密钥。
    expect(skill).toContain("对方的 Memmy 收到请求后会检查四类敏感操作");
    expect(skill).not.toContain("请求发出前，你的 Memmy 会先检查一次");
    expect(skill).toContain("删除或覆盖文件、读取密钥和登录凭据、对外发送");
    expect(skill).toContain("写不清楚时，对方需要看过之后才会执行，也可能拒绝");
    expect(skill).not.toContain("没写明时请求会被退回");
    expect(skill).toContain("不要把这类操作藏进脚本，也不要换一种说法绕开");
    expect(skill).toContain("不要把你或用户的密钥、令牌写进请求和附件");
    // 带了密钥就直接报错，按提示改完重发。
    expect(skill).toContain("按提示删掉后重新发送");
    // 需要对方确认是正常流程，照常等待，不要重发。
    expect(skill).toContain("需要她确认时，`assist wait` 会说明原因");
    // 跳过的操作要告诉用户，确实需要时先征得同意再发一次。
    expect(skill).toContain("以下操作按协助规则没有执行");
    expect(skill).toContain("先征得用户同意，再用 `memmy-project assist ask --continue <请求 ID>` 发一次");
  });

  it("states the attachment limits and the widened body limits", () => {
    expect(skill).toContain("附件最多 8 个、合计 2MB");
    expect(skill).toContain("只收文本与脚本");
    expect(skill).toContain(".sh .bash .zsh .py .js .mjs .cjs .rb");
    expect(skill).toContain(".txt .md .json .csv .log .yaml .yml .xml .toml .ini .cfg");
    expect(skill).toContain("脚本单个 256KB、文本单个 1MB");
    expect(skill).toContain("PDF、PPT、图片、压缩包不收");
    // 正文上限与后端一致：reason 2000 字，items 最多 20 条、每条 4000 字。
    expect(skill).toContain("最多 2000 字");
    expect(skill).toContain("最多 20 条、每条 4000 字");
    expect(skill).not.toContain("最多 10 条");
  });

  it("keeps stopping the wait apart from withdrawing the request", () => {
    // 「不用等了」只是停止等待：请求保留，不撤回。
    expect(skill).toContain("意思是停止等待，不是撤回请求：不运行 `assist cancel`");
    expect(skill).toContain("「要保留请求、结果回来再看，还是现在撤回？」");
    // 撤回只认明确的说法，不再把「不用等这个了」「别查了，太慢」当作撤回。
    expect(skill).toContain("「撤回给李四的请求」「让李四那边停下来」「这个不用查了」");
    expect(skill).not.toMatch(/不用等这个了|别查了，太慢/u);
    // 取回结果给出用户可以直接说的话，并与查成员工作进展分开。
    expect(skill).toContain("说「看看李四的协助结果」即可取回");
    expect(skill).toContain("而不是你发给李四的协助请求时，用 `session search`");
    expect(skill).not.toContain("说一声");
  });

  it("asks only in a project where the member receives assist requests, and never in another one", () => {
    expect(skill).toContain("「接收协助：」后面谁开启了接收协助请求");
    expect(skill).toContain("她一个项目都没有开启时，不要发请求");
    expect(skill).toContain("不要换项目硬发，也不要重试");
    expect(skill).toContain("一段时间内（30 分钟到 4 小时）直接执行你的后续请求");
    // 永久授权已经取消；示例人名不用测试账号名。
    expect(skill).not.toMatch(/长期授权|以后都直接执行/u);
    expect(skill).not.toMatch(/孙起|孙落|王雨/u);
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
