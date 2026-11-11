import { describe, expect, it } from "vitest";
import { renderMemmyProjectSkillFile } from "../templates/memmy-project-skill.js";

/**
 * 技能是否被选中只看描述，外部 Agent 按正文决定怎么做：这几条把成员协助的触发与等待方式固定住。
 */
describe("memmy-project skill", () => {
  const skill = renderMemmyProjectSkillFile({ source: "claude_code" });
  const description = /^description: (.*)$/mu.exec(skill)?.[1] ?? "";

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
