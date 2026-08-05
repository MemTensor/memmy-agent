import { describe, expect, it } from "vitest";
import { buildFirstEncounterRelayPrompt } from "../first-encounter-relay-prompt.js";

describe("first encounter relay prompt", () => {
  it("uses the preferred Chinese language and includes the exact project path", () => {
    const prompt = buildFirstEncounterRelayPrompt("zh-CN", "/Users/jiang/MyProject/memmy-agent-jiang");

    expect(prompt).toContain("请接着我刚才在 Memmy 里的初见报告继续聊天");
    expect(prompt).toContain("最近任务的项目路径是：/Users/jiang/MyProject/memmy-agent-jiang");
    expect(prompt).toContain("请先在这个路径下查看项目");
  });

  it("uses the preferred English language and includes the exact project path", () => {
    const prompt = buildFirstEncounterRelayPrompt("en-US", "/Users/jiang/My Project/app");

    expect(prompt).toContain("Please continue from the first report I just had in Memmy");
    expect(prompt).toContain("The project path for the latest task is: /Users/jiang/My Project/app");
    expect(prompt).toContain("First inspect the project at that path");
  });
});
