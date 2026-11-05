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
    expect(skill).toContain("用 `memmy-project assist wait <请求 ID>` 等待，每次最多 90 秒");
    expect(skill).toContain("不要重新发请求");
    expect(skill).toContain("不指定由哪个 Agent 执行");
    expect(skill).not.toContain("--timeout 600");
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
