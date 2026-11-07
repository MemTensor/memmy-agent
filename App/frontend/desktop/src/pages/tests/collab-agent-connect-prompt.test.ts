import { describe, expect, it } from "vitest";
import { buildCollabAgentConnectPrompt, resolveCollabConnectProjectId } from "../collab-agent-connect-prompt.js";

describe("collaboration agent connect prompt", () => {
  it("asks the Memmy task to install memmy-project and never to read the agent's records", () => {
    const prompt = buildCollabAgentConnectPrompt("Proma");
    expect(prompt).toContain("把本机的「Proma」添加为能使用协作项目的 Agent。");
    expect(prompt).toContain('memmy-project agent connect --name "Proma" --skill-dir "<技能目录>"');
    // 只在「禁止事项」里提到记忆技能，不会让那条任务去装它。
    expect(prompt).toContain("- 不安装 memmy-memory，不导入记忆。");
    // 新方案不再要求它逆推存储格式，也不再允许复制或改写记录。
    expect(prompt).not.toContain("--rule");
    expect(prompt).toContain("不读取、复制、转换或改写「Proma」的任务记录");
    expect(prompt).toContain("这个目录原本就存在");
  });

  it("uses the skills folder the person filled in, and still asks for evidence", () => {
    const prompt = buildCollabAgentConnectPrompt("Qoder", "~/.qoder/skills");
    expect(prompt).toContain("用户提供的技能目录：~/.qoder/skills");
    expect(prompt).toContain("先按第 2 步核对");
    expect(buildCollabAgentConnectPrompt("Qoder", "   ")).not.toContain("用户提供的技能目录");
  });

  it("resolves the local project the onboarding task belongs to", () => {
    expect(resolveCollabConnectProjectId(
      { name: "MemOS", localProjectId: "11111111-1111-4111-8111-111111111111" },
      []
    )).toBe("11111111-1111-4111-8111-111111111111");
    expect(resolveCollabConnectProjectId(
      { name: "MemOS", localProjectId: null },
      [{ id: "22222222-2222-4222-8222-222222222222", name: "MemOS" }]
    )).toBe("22222222-2222-4222-8222-222222222222");
  });
});
